//! Подкоманда `skazanie-server session` — сессия глазами теста. Контракт —
//! `test/kit/sessions.mjs` (режим `rust` набора):
//!
//! ```text
//! skazanie-server session --storage <dir> --expire   (JSON { "token": "…" } на stdin)
//! ```
//!
//! Истекает ровно одна сессия — по хешу её токена, как её и хранит сервер
//! (JS-набор правит для этого `auth.json`). Токен идёт через stdin, а не в
//! аргументах процесса. В stdout — `{"expired":true}`; нет такой сессии или
//! базы — код 1 и причина в stderr; неверные аргументы — код 2. Только при
//! `NODE_ENV=test` и хранилище прямо во временном каталоге; без фичи
//! `test-hooks` подкоманды нет.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

/// Разобранные аргументы.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub storage: PathBuf,
}

/// Разбор аргументов после слова `session`.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut storage = None;
    let mut expire = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--storage" => storage = Some(PathBuf::from(iter.next().ok_or("--storage: нужно значение")?)),
            "--expire" => expire = true,
            other => return Err(format!("неизвестный аргумент {other}")),
        }
    }
    if !expire {
        return Err("нужен --expire".to_string());
    }
    Ok(Args { storage: storage.ok_or("нужен --storage <каталог>")? })
}

/// Истечь сессию токена `token` в базе хранилища: срок — `now_ms - 1`.
pub fn expire_session(storage: &Path, token: &str, now_ms: i64) -> Result<(), String> {
    let database = storage.join("skazanie.sqlite");
    if !database.is_file() {
        return Err(format!("Нет базы аккаунтов: в {} нет skazanie.sqlite", storage.display()));
    }
    let store = sk_tactics::cutover_audit::open_game_store(&database, Arc::new(sk_tactics::cutover_audit::GameReducer::new()))?;
    let hash = sk_store::accounts::Accounts::session_key_for_token(token);
    let changed = store.with_connection_mut(|conn| Ok(conn.execute("UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2", (now_ms - 1, &hash))?)).map_err(|error| error.to_string())?;
    if hash.is_empty() || changed == 0 {
        return Err("Сессия для истечения не найдена".to_string());
    }
    Ok(())
}

/// Исполнить подкоманду над разобранными аргументами и телом stdin.
pub fn run(args: &Args, input: &str, node_env: Option<&str>, temp_dir: &Path) -> Result<Value, String> {
    let storage = std::path::absolute(&args.storage).unwrap_or_else(|_| args.storage.clone());
    if node_env != Some("test") || !super::directly_in(&storage, temp_dir) {
        return Err("session --expire: только при NODE_ENV=test и хранилище прямо во временном каталоге".to_string());
    }
    let body: Value = serde_json::from_str(input).map_err(|error| format!("stdin: не JSON: {error}"))?;
    let token = body.get("token").and_then(Value::as_str).unwrap_or_default();
    expire_session(&args.storage, token, sk_core::clock::now_ms())?;
    Ok(json!({ "expired": true }))
}

/// Точка входа из `main.rs`: печатает JSON или ошибку, возвращает код выхода.
pub fn main(args: &[String]) -> i32 {
    if !super::ENABLED {
        eprintln!("skazanie-server session: бинарь собран без фичи test-hooks (cargo build --release -p sk-server --features test-hooks)");
        return 2;
    }
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("skazanie-server session: {message}");
            return 2;
        }
    };
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("skazanie-server session: stdin: {error}");
        return 1;
    }
    let node_env = std::env::var("NODE_ENV").ok();
    match run(&parsed, &input, node_env.as_deref(), &std::env::temp_dir()) {
        Ok(output) => {
            println!("{}", sk_core::js::stringify(&output));
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments() {
        let args = |list: &[&str]| parse_args(&list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>());
        assert_eq!(args(&["--storage", "x", "--expire"]), Ok(Args { storage: PathBuf::from("x") }));
        assert!(args(&["--storage", "x"]).is_err(), "без --expire");
        assert!(args(&["--expire"]).is_err(), "без --storage");
        assert!(args(&["--storage"]).is_err());
    }

    #[test]
    fn refuses_outside_test_storage() {
        let dir = std::env::temp_dir().join("not-skazanie").join("storage");
        let refused = run(&Args { storage: dir }, "{}", Some("test"), &std::env::temp_dir());
        assert!(refused.is_err_and(|message| message.contains("NODE_ENV=test")));
        let refused = run(&Args { storage: std::env::temp_dir().join("skazanie-x") }, "{}", None, &std::env::temp_dir());
        assert!(refused.is_err());
    }
}
