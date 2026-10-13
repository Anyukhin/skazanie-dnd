//! Запуск сервера «Сказания»: `skazanie-server [корень-проекта]`.
//!
//! Корень — каталог с `dist/` и `storage/` (по умолчанию текущий). Порт и
//! хост — `AGENT_PORT` / `AGENT_HOST` (`8787` / `0.0.0.0`), хранилище —
//! `DND_STORAGE_DIR`. Значения секретов в лог не пишутся.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use sk_server::{app, AppState, Config};

#[tokio::main]
async fn main() {
    let root = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let config = Config::from_env(root);
    let address = format!("{}:{}", config.host, config.port);
    let state = match AppState::open(config) {
        Ok(state) => Arc::new(state),
        Err(error) => {
            eprintln!("[Сказание] Не удалось открыть хранилище: {error}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[Сказание] Не удалось занять {address}: {error}");
            std::process::exit(1);
        }
    };
    println!("[Сказание] Сервер: http://{address}");
    if let Err(error) = axum::serve(listener, app(state).into_make_service_with_connect_info::<SocketAddr>()).await {
        eprintln!("[Сказание] Сервер остановлен: {error}");
    }
}
