//! Подкоманда `skazanie-server backup` — зашифрованная копия хранилища.
//!
//! Повторяет `tools/storage-backup.mjs`: те же действия, флаг `--allow-live`,
//! секрет `DND_BACKUP_KEY` (не короче 32 байт), JSON итога в stdout и отказа
//! в stderr. Формат архива — `sk_infra::backup_service` (тот же, что пишет
//! JS), так что копию, снятую подкомандой, проверяет и восстанавливает и
//! `pnpm backup`, и наоборот.
//!
//! Зачем подкоманда, если CLI на Node уже есть: том Docker
//! (`skazanie-rust_storage`) с хоста не виден, а в образе нет Node. Бинарь
//! запускается в том же образе на остановленном сервисе (`docs/rust-docker.md`,
//! «Резервная копия тома»). База SQLite копируется файлами вместе с `-wal` и
//! `-shm`: при остановленном сервере это согласованный снимок. Пока сервер
//! жив, отметка писателя `.server-writer.json` даёт отказ
//! `BACKUP_WRITER_ACTIVE`.
//!
//! Подкоманда идёт до чтения `.env`, как остальные (`cli`): секрет и каталог
//! берутся только из окружения процесса.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use sk_core::js;
use sk_infra::backup_service::{self, BackupError, CreateBackupOptions};

/// Флаг осознанной копии с работающего сервера.
pub const ALLOW_LIVE_FLAG: &str = "--allow-live";

/// Справка подкоманды.
pub const USAGE: &str = "\
Использование:
  skazanie-server backup                        копия storage в ./backups/skazanie-<дата>.skzbackup
  skazanie-server backup create [<storage-dir> [<backup-file>]]
  skazanie-server backup verify <backup-file>
  skazanie-server backup compare <storage-dir> <backup-file>
  skazanie-server backup restore <backup-file> <пустой-каталог>

Каталог storage по умолчанию — DND_STORAGE_DIR, иначе ./storage.
Всем командам нужна переменная DND_BACKUP_KEY длиной не меньше 32 байт.

Копия снимается с остановленного сервера: пока он пишет, журнал событий и
metadata в архиве могут оказаться из разных моментов. Если сервер на этом
storage работает, create отказывает (BACKUP_WRITER_ACTIVE).
  --allow-live   снять копию с работающего сервера осознанно; согласованность не гарантируется.

verify проверяет шифрование и SHA-256 каждого файла, а не целостность кампаний:
архив с живого сервера проходит verify и всё равно может быть несогласованным.";

/// Окружение подкоманды: внедряется в тестах, в бинаре — из процесса.
pub struct BackupEnv {
    /// `DND_BACKUP_KEY`.
    pub secret: Option<String>,
    /// `DND_STORAGE_DIR`.
    pub storage_dir: Option<String>,
    /// Каталог, от которого считаются `./storage` и `./backups`.
    pub cwd: PathBuf,
    /// Часы для имени файла по умолчанию и `created_at`.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl BackupEnv {
    /// Окружение процесса.
    pub fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self { secret: var("DND_BACKUP_KEY"), storage_dir: var("DND_STORAGE_DIR"), cwd: std::env::current_dir().unwrap_or_default(), now: Arc::new(sk_core::clock::now_ms) }
    }
}

/// Итог подкоманды.
#[derive(Debug)]
pub enum Outcome {
    /// Справка: напечатать в stdout, код 0.
    Help,
    /// Успех: JSON итога и, если копия снята с живого сервера, предупреждение.
    Done { result: Value, warning: Option<Value> },
    /// Отказ: код (`BACKUP_*`) и текст для человека.
    Failed { code: String, message: String },
}

fn failed(code: &str, message: impl Into<String>) -> Outcome {
    Outcome::Failed { code: code.to_string(), message: message.into() }
}

fn default_backup_file(env: &BackupEnv) -> PathBuf {
    // `2026-11-27T18-30-00Z`: как `toISOString()` без долей и с `-` вместо `:`.
    let iso = sk_core::clock::iso((env.now)());
    let stamp = match iso.rfind('.') {
        Some(dot) if iso.ends_with('Z') => format!("{}Z", &iso[..dot]),
        _ => iso,
    }
    .replace(':', "-");
    env.cwd.join("backups").join(format!("skazanie-{stamp}.skzbackup"))
}

fn default_storage_dir(env: &BackupEnv) -> PathBuf {
    match env.storage_dir.as_deref().filter(|value| !value.is_empty()) {
        Some(dir) => env.cwd.join(dir),
        None => env.cwd.join("storage"),
    }
}

fn path_arg(env: &BackupEnv, value: &str) -> PathBuf {
    env.cwd.join(value)
}

/// Секрет: отказ говорит, чего не хватает и где это задаётся, до того как
/// команда успеет создать файл.
fn backup_secret(env: &BackupEnv) -> Result<String, Outcome> {
    let tail = "Ею шифруется резервная копия: без того же самого значения восстановить её потом нельзя. Задайте переменную в окружении (для Docker — в .env рядом с compose.rust.yaml, шаблон с комментарием — .env.example) и повторите команду.";
    let value = env.secret.clone().unwrap_or_default();
    if value.is_empty() {
        return Err(failed("BACKUP_SECRET_MISSING", format!("Переменная окружения DND_BACKUP_KEY не задана. {tail}")));
    }
    if value.len() < 32 {
        return Err(failed("BACKUP_SECRET_TOO_SHORT", format!("Переменная окружения DND_BACKUP_KEY короче 32 байт (сейчас {}). {tail}", value.len())));
    }
    Ok(value)
}

fn writer_active(error: &BackupError) -> Outcome {
    let writer = error.details().and_then(|details| details.get("writer")).cloned().unwrap_or(Value::Null);
    let field = |key: &str| match writer.get(key) {
        Some(value) if !value.is_null() => js::s(Some(value)),
        _ => "?".to_string(),
    };
    failed(
        "BACKUP_WRITER_ACTIVE",
        format!(
            "Сервер сейчас работает с этим storage (pid {} на {}, последний сигнал {}). Копия с живого сервера может собрать журнал событий и metadata из разных моментов — архив пройдёт verify, но кампания восстановится несогласованной. Остановите сервер и повторите команду. Если копия нужна именно сейчас, добавьте {ALLOW_LIVE_FLAG}: она будет снята, но её согласованность не гарантируется.",
            field("pid"),
            field("host"),
            field("heartbeat_at"),
        ),
    )
}

fn service_failure(error: BackupError) -> Outcome {
    match error.code() {
        Some(code) => failed(code, error.to_string()),
        None => failed("BACKUP_CLI_ERROR", error.to_string()),
    }
}

/// Исполнить подкоманду без печати.
pub fn execute(args: &[String], env: &BackupEnv) -> Outcome {
    // `pnpm backup -- verify …` передаёт разделитель дальше; здесь он тоже
    // допустим первым аргументом.
    let raw: Vec<&str> = args.iter().map(String::as_str).enumerate().filter(|(index, item)| !(*index == 0 && *item == "--")).map(|(_, item)| item).collect();
    let allow_live = raw.contains(&ALLOW_LIVE_FLAG);
    let positional: Vec<&str> = raw.into_iter().filter(|item| *item != ALLOW_LIVE_FLAG).collect();
    let action = positional.first().copied();
    let first = positional.get(1).copied();
    let second = positional.get(2).copied();
    if matches!(action, Some("help" | "--help" | "-h")) {
        return Outcome::Help;
    }
    let usage = || failed("BACKUP_CLI_USAGE", USAGE);
    if positional.len() > 3 {
        return usage();
    }
    let secret = match backup_secret(env) {
        Ok(secret) => secret,
        Err(outcome) => return outcome,
    };
    match (action, first, second) {
        (None | Some("create"), _, _) => {
            let source = first.map_or_else(|| default_storage_dir(env), |dir| path_arg(env, dir));
            let backup_file = second.map_or_else(|| default_backup_file(env), |file| path_arg(env, file));
            if let Some(parent) = backup_file.parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    return failed("BACKUP_CLI_ERROR", format!("Не удалось создать каталог {}: {error}", parent.display()));
                }
            }
            let mut options = CreateBackupOptions::new(source, backup_file, secret);
            options.now = env.now.clone();
            options.allow_live_writer = allow_live;
            match backup_service::create_storage_backup(&options) {
                Ok(result) => {
                    let live = result.pointer("/writer/state").and_then(Value::as_str) == Some("live");
                    let warning = live.then(|| json!({
                        "ok": true,
                        "warning": "BACKUP_LIVE_WRITER",
                        "message": format!("Копия снята с работающего сервера по {ALLOW_LIVE_FLAG}. Её согласованность не гарантируется; verify этого не проверяет."),
                    }));
                    Outcome::Done { result, warning }
                }
                Err(error) if error.code() == Some("BACKUP_WRITER_ACTIVE") => writer_active(&error),
                Err(error) => service_failure(error),
            }
        }
        (Some("verify"), Some(file), None) => done(backup_service::verify_storage_backup(&path_arg(env, file), &secret)),
        (Some("compare"), Some(dir), Some(file)) => done(backup_service::compare_storage_to_backup(&path_arg(env, dir), &path_arg(env, file), &secret)),
        (Some("restore"), Some(file), Some(dir)) => done(backup_service::restore_storage_backup(&path_arg(env, file), &path_arg(env, dir), &secret)),
        _ => usage(),
    }
}

fn done(result: Result<Value, BackupError>) -> Outcome {
    match result {
        Ok(result) => Outcome::Done { result, warning: None },
        Err(error) => service_failure(error),
    }
}

/// Подкоманда бинаря: 0 — успех, 1 — отказ (как `tools/storage-backup.mjs`).
pub fn run(args: &[String]) -> i32 {
    run_in(args, &BackupEnv::from_process())
}

/// [`run`] с внедрённым окружением.
pub fn run_in(args: &[String], env: &BackupEnv) -> i32 {
    match execute(args, env) {
        Outcome::Help => {
            println!("{USAGE}");
            0
        }
        Outcome::Done { result, warning } => {
            if let Some(warning) = warning {
                eprintln!("{}", js::stringify_pretty(&warning, 2));
            }
            println!("{}", js::stringify_pretty(&result, 2));
            0
        }
        Outcome::Failed { code, message } => {
            eprintln!("{}", js::stringify_pretty(&json!({ "ok": false, "code": code, "error": message }), 2));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn env(cwd: &Path, secret: Option<&str>) -> BackupEnv {
        BackupEnv { secret: secret.map(str::to_string), storage_dir: None, cwd: cwd.to_path_buf(), now: Arc::new(|| 1_796_000_000_000) }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn help_needs_no_secret() {
        let dir = std::env::temp_dir();
        for help in ["help", "--help", "-h"] {
            assert!(matches!(execute(&args(&[help]), &env(&dir, None)), Outcome::Help));
        }
    }

    #[test]
    fn secret_is_required_and_long_enough() {
        let dir = std::env::temp_dir();
        let Outcome::Failed { code, message } = execute(&args(&["verify", "x"]), &env(&dir, None)) else { panic!("ждали отказ") };
        assert_eq!(code, "BACKUP_SECRET_MISSING");
        assert!(message.contains("DND_BACKUP_KEY не задана"), "{message}");
        let Outcome::Failed { code, message } = execute(&args(&["verify", "x"]), &env(&dir, Some("short"))) else { panic!("ждали отказ") };
        assert_eq!(code, "BACKUP_SECRET_TOO_SHORT");
        assert!(message.contains("сейчас 5"), "{message}");
    }

    #[test]
    fn wrong_arity_is_usage() {
        let dir = std::env::temp_dir();
        let secret = Some("k".repeat(32));
        for list in [vec!["verify"], vec!["verify", "a", "b"], vec!["compare", "a"], vec!["restore", "a"], vec!["unknown"], vec!["create", "a", "b", "c"]] {
            let Outcome::Failed { code, .. } = execute(&args(&list), &env(&dir, secret.as_deref())) else { panic!("{list:?}: ждали отказ") };
            assert_eq!(code, "BACKUP_CLI_USAGE", "{list:?}");
        }
    }

    #[test]
    fn default_file_name_is_iso_without_fraction() {
        let dir = PathBuf::from("root");
        let name = default_backup_file(&env(&dir, None));
        assert_eq!(name, dir.join("backups").join("skazanie-2026-11-30T00-53-20Z.skzbackup"));
    }
}
