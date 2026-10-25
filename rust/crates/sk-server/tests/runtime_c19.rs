//! Готовность бинаря к работе вне дерева сборки (С19.1):
//!
//! - бинарь, скопированный в пустой каталог, берёт данные из `DND_DATA_DIR`
//!   (или из каталога рядом с собой), отвечает `/api/health`, отдаёт каталог
//!   миров (картинки из `public/` корня данных) и создаёт кампанию; без
//!   данных — понятный отказ запуска с кодом 1, а не паника;
//! - `--help`, `-h`, мусорный аргумент и незавершённая подкоманда порт не
//!   открывают и завершаются сами;
//! - недочитанное тело (большое тело к несуществующему маршруту) не рвёт
//!   соединение: клиент получает 404, а соединение живёт для следующего
//!   запроса, как в Node.
//!
//! Бинарь запускается только с явным `AGENT_HOST=127.0.0.1`, случайным
//! `AGENT_PORT` и временным `DND_STORAGE_DIR`: порт 8787 занят игрой
//! владельца. Копия бинаря получает дописанные байты в конце: Smart App
//! Control на машине разработки не запускает неизвестный ему файл, а лишние
//! байты после образа PE загрузчик не читает.

mod kit;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Сколько ждать выхода процесса, который не должен запускать сервер.
const EXIT_LIMIT: Duration = Duration::from_secs(5);
/// Сколько ждать готовности сервера (сверка проекций при старте).
const READY_LIMIT: Duration = Duration::from_secs(60);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.local_addr()).map(|addr| addr.port()).expect("свободный порт")
}

/// Копия бинаря `skazanie-server` в `dir` (с дописанными байтами, см. шапку).
fn copy_binary(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).expect("каталог бинаря");
    let source = PathBuf::from(env!("CARGO_BIN_EXE_skazanie-server"));
    let target = dir.join(source.file_name().expect("имя бинаря"));
    std::fs::copy(&source, &target).expect("копия бинаря");
    let mut file = std::fs::OpenOptions::new().append(true).open(&target).expect("копия бинаря на запись");
    let stamp = format!("sacpad{}{}", std::process::id(), sk_core::clock::now_ms());
    file.write_all(stamp.as_bytes()).expect("дописанные байты");
    target
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("каталог копии");
    for entry in std::fs::read_dir(from).unwrap_or_else(|error| panic!("{}: {error}", from.display())) {
        let entry = entry.expect("запись каталога");
        let path = entry.path();
        if path.is_dir() {
            copy_tree(&path, &to.join(entry.file_name()));
        } else {
            std::fs::copy(&path, to.join(entry.file_name())).expect("копия файла");
        }
    }
}

/// Корень данных во временном каталоге: копии `data/` и `prompts/`, из
/// `public/` — только картинки каталога миров.
fn payload(dir: &Path) -> PathBuf {
    let repo = sk_core::data_root::build_root();
    copy_tree(&repo.join("data"), &dir.join("data"));
    copy_tree(&repo.join("prompts"), &dir.join("prompts"));
    let catalog = std::fs::read_to_string(repo.join("data").join("campaign-worlds-v1.json")).expect("каталог миров");
    let images = regex::Regex::new(r#""(/assets/[^"]+\.webp)""#).expect("образец");
    let mut copied = 0;
    for found in images.captures_iter(&catalog) {
        let relative = found[1].trim_start_matches('/');
        let target = dir.join("public").join(relative);
        if target.exists() {
            continue;
        }
        std::fs::create_dir_all(target.parent().expect("каталог картинки")).expect("каталог картинки");
        std::fs::copy(repo.join("public").join(relative), &target).expect("картинка мира");
        copied += 1;
    }
    assert!(copied > 0, "каталог миров ссылается на картинки public/");
    dir.to_path_buf()
}

/// Процесс сервера; уничтожается вместе с тестом.
struct Running {
    child: Child,
    addr: SocketAddr,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Команда бинаря с изолированным окружением: свой порт, временное storage,
/// без ключа модели и с локальным адресом модели.
fn command(binary: &Path, cwd: &Path, port: u16, storage: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(cwd)
        .env_remove("DND_DATA_DIR")
        .env("AGENT_HOST", "127.0.0.1")
        .env("AGENT_PORT", port.to_string())
        .env("DND_STORAGE_DIR", storage)
        .env("ROUTERAI_API_KEY", "")
        .env("ROUTERAI_BASE_URL", "http://127.0.0.1:9/never")
        .env("ADMIN_SETUP_TOKEN", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Дождаться выхода не дольше `limit`: код, stdout, stderr.
fn wait_exit(mut child: Child, limit: Duration) -> (i32, String, String) {
    let started = Instant::now();
    loop {
        match child.try_wait().expect("состояние процесса") {
            Some(status) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                return (status.code().unwrap_or(-1), stdout, stderr);
            }
            None if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("процесс не завершился сам за {limit:?}");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn port_closed(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_err()
}

/// Запустить сервер и дождаться ответа `/api/health`. Вывод сервера — в
/// файл `log`: непрочитанный канал заполнился бы и остановил процесс.
async fn start(mut command: Command, port: u16, log: &Path) -> Running {
    let stderr = std::fs::File::create(log).expect("журнал сервера");
    let child = command.stdout(Stdio::null()).stderr(stderr).spawn().expect("запуск бинаря");
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut running = Running { child, addr };
    let started = Instant::now();
    loop {
        if let Some(status) = running.child.try_wait().expect("состояние процесса") {
            let stderr = std::fs::read_to_string(log).unwrap_or_default();
            panic!("сервер завершился при запуске ({status}): {stderr}");
        }
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            let health = kit::Client::new(addr).get("/api/health").await;
            if health.status == 200 {
                return running;
            }
        }
        assert!(started.elapsed() < READY_LIMIT, "сервер не ответил на /api/health за {READY_LIMIT:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn plays_a_campaign(running: &Running, code: &str) {
    let mut player = kit::Client::new(running.addr);
    let health = player.get("/api/health").await.expect(200);
    assert!(health["ruleCount"].as_u64().unwrap_or(0) > 0, "пакеты правил прочитаны из корня данных: {health}");
    player.register(&format!("{}@mail.ru", code.to_lowercase())).await;
    let worlds = player.get("/api/world-templates").await.expect(200);
    assert!(worlds.to_string().contains(".webp"), "каталог миров собран с картинками из public/ корня данных: {worlds}");
    let bootstrap = json!({ "code": code, "name": code, "bootstrap": { "partyName": "Отряд", "slotCount": 1, "rulesetId": "srd_5_2_1", "world": { "premise": "Мост", "startingLocation": "Переправа" } } });
    let created: Value = player.post("/api/campaigns", &bootstrap).await.expect(201);
    assert!(created.to_string().contains(code), "{created}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_outside_build_tree_runs_from_data_root() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let root = temp.path();
    let payload = payload(&root.join("payload"));
    let binary = copy_binary(&root.join("bin"));
    let work = root.join("work");
    std::fs::create_dir_all(&work).expect("рабочий каталог");

    // Без данных: каталог бинаря пуст, `DND_DATA_DIR` ведёт в пустоту —
    // отказ запуска с понятным текстом, порт не открыт, storage не тронут.
    let port = free_port();
    let storage = root.join("storage-empty");
    let mut empty = command(&binary, &work, port, &storage);
    empty.env("DND_DATA_DIR", root.join("nothing"));
    let (code, _, stderr) = wait_exit(empty.spawn().expect("запуск"), EXIT_LIMIT);
    assert_eq!(code, 1, "{stderr}");
    assert!(stderr.contains("DND_DATA_DIR") && stderr.contains("data/rule_packs"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert!(port_closed(port));
    assert!(!storage.exists(), "отказ — до первой записи в storage");

    // `DND_DATA_DIR` на копию данных: относительный путь — от текущего каталога.
    let port = free_port();
    let mut configured = command(&binary, &work, port, &root.join("storage-env"));
    configured.env("DND_DATA_DIR", "../payload");
    let running = start(configured, port, &root.join("env.log")).await;
    plays_a_campaign(&running, "C19-ENV").await;
    drop(running);

    // Бинарь рядом с `data/` без переменной — корень данных его каталог.
    let beside = copy_binary(&payload);
    let port = free_port();
    let running = start(command(&beside, &work, port, &root.join("storage-beside")), port, &root.join("beside.log")).await;
    plays_a_campaign(&running, "C19-BESIDE").await;
}

#[test]
fn help_and_unknown_arguments_never_open_the_port() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let binary = copy_binary(&temp.path().join("bin"));
    let cases: [(&[&str], i32); 6] = [(&["--help"], 0), (&["-h"], 0), (&["--port"], 2), (&["serve"], 2), (&["."], 2), (&["import-legacy"], 2)];
    for (index, (args, expected)) in cases.iter().enumerate() {
        let port = free_port();
        let storage = temp.path().join(format!("storage-{index}"));
        let child = command(&binary, temp.path(), port, &storage).args(*args).spawn().expect("запуск");
        let (code, stdout, stderr) = wait_exit(child, EXIT_LIMIT);
        assert_eq!(code, *expected, "{args:?}: {stdout}{stderr}");
        assert!(port_closed(port), "{args:?}: порт не должен открываться");
        assert!(!storage.exists(), "{args:?}: storage не трогается");
        if *expected == 0 {
            assert!(stdout.contains("Использование") && stdout.contains("DND_DATA_DIR"), "{args:?}: справка в stdout: {stdout}");
        } else {
            assert!(!stderr.trim().is_empty(), "{args:?}: причина в stderr");
        }
    }
}

/// Большое тело к несуществующему маршруту: ответ 404 без обрыва, а следом
/// по тому же соединению отвечает `/api/health` — тело дочитано.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unread_body_is_drained_not_reset() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let server = kit::TestServer::start().await;
    let body = vec![b'x'; 3 * 1024 * 1024];
    let mut stream = tokio::net::TcpStream::connect(server.addr).await.expect("соединение");
    let head = format!("POST /api/no-such-route HTTP/1.1\r\nhost: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n", server.addr, body.len());
    let write = async {
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&body).await?;
        stream.write_all(format!("GET /api/health HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n\r\n", server.addr).as_bytes()).await?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;
        Ok::<_, std::io::Error>(raw)
    };
    let raw = tokio::time::timeout(kit::CLIENT_TIMEOUT, write).await.expect("сервер ответил").expect("без ECONNRESET");
    let text = String::from_utf8_lossy(&raw);
    let statuses: Vec<&str> = text.match_indices("HTTP/1.1 ").map(|(at, _)| &text[at + 9..at + 12]).collect();
    assert_eq!(statuses, vec!["404", "200"], "{text}");
    assert!(text.contains("API endpoint не найден"), "{text}");
}
