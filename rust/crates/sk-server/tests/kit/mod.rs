//! Минимальный тестовый набор С0 (полный делает С2, по образцу
//! `test/kit/http.mjs`):
//!
//! - [`TestServer`] — настоящий сервер на случайном порту `127.0.0.1` и во
//!   временном каталоге; окружение процесса не читается (`Config::for_tests`),
//!   ключа модели нет, клиент модели — [`ForbiddenLlm`] через учёт расхода,
//!   кости детерминированы (`FixedRng`). Соединения обслуживает тот же цикл,
//!   что и боевой сервер (`sk_server::serve`), на своём потоке и рантайме;
//!   уничтожение останавливает его, ядро и только затем удаляет каталог;
//! - [`Client`] — сырой HTTP/1.1 с cookie: адрес уходит как есть (`..`,
//!   `//`, `%E0`), без нормализации клиентской библиотекой; ответ ждётся не
//!   дольше [`CLIENT_TIMEOUT`];
//! - [`RecordingStreams`] — заглушка реестра потоков, которая запоминает
//!   вызовы отзыва и обновления.

#![allow(dead_code)] // набор общий для нескольких файлов тестов

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sk_core::indexmap::IndexSet;
use sk_infra::usage_ledger::{LlmClient, LlmError, LlmFuture};
use sk_server::dispatch::Route;
use sk_server::state::{LlmClients, Metered};
use sk_server::streams::{Presence, StreamRegistry};
use sk_server::{AppState, Config, Injected};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Клиент модели, который не отвечает никогда: тесты С0 модель не зовут.
pub struct ForbiddenLlm;

impl LlmClient for ForbiddenLlm {
    fn model(&self) -> Option<String> {
        Some("test/forbidden".into())
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError::new("LLM_FORBIDDEN", "Тест не должен звать модель")) })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError::new("LLM_FORBIDDEN", "Тест не должен звать модель")) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

/// Реестр потоков, который запоминает вызовы.
#[derive(Default)]
pub struct RecordingStreams {
    pub revoked: Mutex<Vec<String>>,
    pub refreshed: Mutex<Vec<String>>,
}

impl Presence for RecordingStreams {
    fn connected_hero_ids(&self, _campaign_id: &str) -> IndexSet<String> {
        IndexSet::new()
    }
}

impl StreamRegistry for RecordingStreams {
    fn revoke_for_session(&self, session_key: &str) {
        self.revoked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session_key.to_string());
    }

    fn refresh_for_user(&self, user_id: &str) {
        self.refreshed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(user_id.to_string());
    }
}

/// Настройки запуска.
pub struct Options {
    /// Создать `dist/` с `index.html` и чанком.
    pub dist: bool,
    pub admin_setup_token: String,
    pub extra_routes: Vec<Route>,
}

impl Default for Options {
    fn default() -> Self {
        Self { dist: true, admin_setup_token: "setup-code".into(), extra_routes: Vec::new() }
    }
}

/// Предел ожидания ответа клиентом: зависание сервера — падение теста.
pub const CLIENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Содержимое `secret.txt` рядом с `dist/`: его не должна отдать раздача клиента.
pub const SECRET: &str = "секрет-вне-dist";

/// Тестовый сервер. Порядок полей важен: каталог уничтожается последним,
/// после ядра и состояния (на Windows открытая база не даёт его удалить).
pub struct TestServer {
    pub state: Arc<AppState>,
    pub streams: Arc<RecordingStreams>,
    pub addr: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub dir: tempfile::TempDir,
}

pub fn write_dist(dir: &Path) {
    std::fs::create_dir_all(dir.join("dist").join("assets")).expect("dist");
    std::fs::write(dir.join("dist").join("index.html"), "<!doctype html><title>Сказание</title>").expect("index");
    std::fs::write(dir.join("dist").join("assets").join("main-abcdef12.js"), "console.log(1)").expect("чанк");
    std::fs::write(dir.join("secret.txt"), SECRET).expect("секрет");
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with(Options::default()).await
    }

    pub async fn start_with(options: Options) -> Self {
        let dir = tempfile::tempdir().expect("временный каталог");
        if options.dist {
            write_dist(dir.path());
        }
        let mut config = Config::for_tests(dir.path());
        config.admin_setup_token = options.admin_setup_token;
        let streams = Arc::new(RecordingStreams::default());
        let recorder = streams.clone();
        let injected = Injected {
            dice: Some(Box::new(sk_dice::DiceService::deterministic(sk_dice::FixedRng(10), "roll"))),
            llm: Some(Box::new(|ledger| Ok(LlmClients { llm: Some(Metered::wrap(ForbiddenLlm, ledger)), lore: Some(Metered::wrap(ForbiddenLlm, ledger)) }))),
            clock: None,
            streams: Some(Box::new(move || Box::new(recorder) as Box<dyn StreamRegistry>)),
            extra_routes: options.extra_routes,
        };
        let state = Arc::new(AppState::open(config, injected).expect("состояние сервера"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("порт");
        listener.set_nonblocking(true).expect("неблокирующий порт");
        let addr = listener.local_addr().expect("адрес");
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = state.clone();
        let thread = std::thread::Builder::new()
            .name("test-http".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("рантайм HTTP");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).expect("порт в рантайме");
                    sk_server::serve::serve(listener, served, async move { stopped.await.ok() }, |_| std::time::Duration::from_secs(1)).await;
                });
                runtime.shutdown_timeout(std::time::Duration::from_secs(1));
            })
            .expect("поток HTTP");
        Self { state, streams, addr, stop: Some(stop), thread: Some(thread), dir }
    }

    pub fn client(&self) -> Client {
        Client { addr: self.addr, cookies: BTreeMap::new() }
    }

    pub fn storage(&self) -> PathBuf {
        self.dir.path().join("storage")
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        // Порядок остановки как в `main.rs`: приём и соединения, затем ядро;
        // поля (`state`, затем `dir`) уничтожаются уже после.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.state.core.shutdown();
    }
}

/// Ответ сервера.
#[derive(Debug, Clone)]
pub struct TestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl TestResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| Value::String(self.text()))
    }
}

/// Запрос для [`Client::send`].
pub struct Req<'a> {
    pub method: &'a str,
    pub target: &'a str,
    pub body: Option<Vec<u8>>,
    pub headers: Vec<(&'a str, String)>,
}

impl<'a> Req<'a> {
    pub fn new(method: &'a str, target: &'a str) -> Self {
        Self { method, target, body: None, headers: Vec::new() }
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn json(self, value: &Value) -> Self {
        self.body(value.to_string()).header("content-type", "application/json")
    }

    pub fn header(mut self, name: &'a str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

/// Сырой клиент HTTP/1.1 с cookie.
pub struct Client {
    pub addr: SocketAddr,
    pub cookies: BTreeMap<String, String>,
}

fn decode_chunked(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = raw.windows(2).position(|pair| pair == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..line_end]).trim(), 16).unwrap_or(0);
        raw = &raw[line_end + 2..];
        if size == 0 || raw.len() < size {
            break;
        }
        out.extend_from_slice(&raw[..size]);
        raw = raw.get(size + 2..).unwrap_or(&[]);
    }
    out
}

impl Client {
    pub async fn send(&mut self, request: Req<'_>) -> TestResponse {
        let target = request.target.to_string();
        let method = request.method.to_string();
        let mut stream = tokio::net::TcpStream::connect(self.addr).await.expect("соединение");
        let mut head = format!("{} {} HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n", request.method, request.target, self.addr);
        if !self.cookies.is_empty() {
            let cookie = self.cookies.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("; ");
            head.push_str(&format!("cookie: {cookie}\r\n"));
        }
        for (name, value) in &request.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        let body = request.body.unwrap_or_default();
        if !body.is_empty() || matches!(request.method, "POST" | "PUT" | "PATCH" | "DELETE") {
            head.push_str(&format!("content-length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.expect("запись");
        stream.write_all(&body).await.expect("тело");
        let mut raw = Vec::new();
        let read = tokio::time::timeout(CLIENT_TIMEOUT, stream.read_to_end(&mut raw)).await;
        assert!(read.is_ok(), "сервер не ответил за {CLIENT_TIMEOUT:?}: {method} {target}");
        let split = raw.windows(4).position(|window| window == b"\r\n\r\n").unwrap_or(raw.len());
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.split("\r\n");
        let status = lines.next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse().ok()).unwrap_or(0);
        let headers: Vec<(String, String)> = lines.filter_map(|line| line.split_once(':').map(|(key, value)| (key.trim().to_lowercase(), value.trim().to_string()))).collect();
        let mut body = raw.get(split + 4..).unwrap_or(&[]).to_vec();
        if headers.iter().any(|(key, value)| key == "transfer-encoding" && value.contains("chunked")) {
            body = decode_chunked(&body);
        }
        for (key, value) in &headers {
            if key == "set-cookie" {
                let pair = value.split(';').next().unwrap_or("");
                if let Some((name, cookie)) = pair.split_once('=') {
                    if value.contains("Max-Age=0") {
                        self.cookies.remove(name);
                    } else {
                        self.cookies.insert(name.to_string(), cookie.to_string());
                    }
                }
            }
        }
        TestResponse { status, headers, body }
    }

    pub async fn get(&mut self, target: &str) -> TestResponse {
        self.send(Req::new("GET", target)).await
    }

    pub async fn post(&mut self, target: &str, body: &Value) -> TestResponse {
        self.send(Req::new("POST", target).json(body)).await
    }

    pub async fn post_raw(&mut self, target: &str, body: impl Into<Vec<u8>>) -> TestResponse {
        self.send(Req::new("POST", target).body(body).header("content-type", "application/json")).await
    }

    /// Администратор через `setup-admin` (код `setup-code`).
    pub async fn setup_admin(&mut self) -> Value {
        let response = self.post("/api/auth/setup-admin", &json!({ "email": "gm@mail.ru", "password": "длинный-пароль", "name": "Ведущий", "setupToken": "setup-code" })).await;
        assert_eq!(response.status, 201, "{}", response.text());
        response.json()["user"].clone()
    }

    /// Игрок через `register`.
    pub async fn register(&mut self, email: &str) -> Value {
        let response = self.post("/api/auth/register", &json!({ "email": email, "password": "длинный-пароль", "name": "Аня" })).await;
        assert_eq!(response.status, 201, "{}", response.text());
        response.json()["user"].clone()
    }
}
