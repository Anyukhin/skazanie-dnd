//! HTTP-сервер «Сказания» — перенос `server/index.mjs` на axum.
//!
//! Контракт для клиента тот же: пути, JSON-ответы, cookie сессии
//! `skazanie_session`, коды отказов. Маршруты переносятся по мере готовности
//! движка; неизвестный `/api/*` — 404 `API endpoint не найден`, остальное —
//! собранный клиент из `dist/`.

pub mod auth;
pub mod http;
pub mod rate_window;
pub mod static_files;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Method, Response, StatusCode};
use axum::routing::{get, patch, post};
use axum::Router;
use serde_json::json;
use sk_store::accounts::Accounts;

use crate::rate_window::SlidingWindowCounter;

/// Настройки сервера из окружения (`AGENT_PORT`, `AGENT_HOST`,
/// `DND_STORAGE_DIR`, `ADMIN_SETUP_TOKEN`, `COOKIE_SECURE`).
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub storage_dir: PathBuf,
    pub dist_dir: PathBuf,
    pub admin_setup_token: String,
    pub cookie_secure: bool,
}

impl Config {
    pub fn from_env(root: PathBuf) -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Self {
            host: var("AGENT_HOST").unwrap_or_else(|| "0.0.0.0".into()),
            port: var("AGENT_PORT").and_then(|value| value.parse().ok()).unwrap_or(8787),
            storage_dir: var("DND_STORAGE_DIR").map(PathBuf::from).unwrap_or_else(|| root.join("storage")),
            dist_dir: root.join("dist"),
            admin_setup_token: var("ADMIN_SETUP_TOKEN").unwrap_or_default(),
            cookie_secure: var("COOKIE_SECURE").as_deref() == Some("true"),
        }
    }
}

/// Общее состояние обработчиков.
pub struct AppState {
    pub config: Config,
    pub accounts: Accounts,
    pub login_attempts: SlidingWindowCounter,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn open(config: Config) -> Result<Self, String> {
        let database = config.storage_dir.join("skazanie.sqlite");
        let accounts = Accounts::open(&database).map_err(|error| error.to_string())?;
        Ok(Self { config, accounts, login_attempts: SlidingWindowCounter::with_defaults() })
    }

    /// `rateLimited(req)`: двадцать попыток входа за десять минут с адреса.
    pub fn rate_limited(&self, address: Option<SocketAddr>) -> bool {
        let key = address.map_or_else(|| "unknown".to_string(), |address| address.ip().to_string());
        self.login_attempts.hit(&key, 20, None)
    }
}

async fn health() -> Response<Body> {
    http::json(StatusCode::OK, json!({ "configured": false, "provider": "RouterAI", "engineMode": "enforce", "tools": [] }))
}

async fn fallback(State(state): State<Shared>, request: Request) -> Response<Body> {
    let path = request.uri().path().to_string();
    if path.starts_with("/api/") {
        return http::error(StatusCode::NOT_FOUND, "API endpoint не найден", None);
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return http::error(StatusCode::NOT_FOUND, "API endpoint не найден", None);
    }
    let raw = request.uri().path_and_query().map_or("/", |value| value.as_str()).to_string();
    static_files::serve(&state.config.dist_dir, &raw, request.headers())
}

/// Адрес клиента, если сервер запущен с `ConnectInfo`.
pub fn peer(info: Option<axum::Extension<ConnectInfo<SocketAddr>>>) -> Option<SocketAddr> {
    info.map(|axum::Extension(ConnectInfo(address))| address)
}

/// Пользователь по cookie сессии или `None`.
pub fn current_user(state: &AppState, headers: &HeaderMap) -> Option<serde_json::Value> {
    state.accounts.user_for_token(&http::session_token(headers)).ok().flatten()
}

/// Маршрутизатор приложения.
pub fn app(state: Shared) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/setup-admin", post(auth::setup_admin))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/admin/users", get(auth::admin_users))
        .route("/api/admin/users/{id}", patch(auth::admin_update_user))
        .fallback(fallback)
        .layer(axum::middleware::from_fn(http::security_layer))
        .with_state(state)
}
