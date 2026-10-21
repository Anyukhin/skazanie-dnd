//! HTTP-сервер «Сказания» — перенос `server/index.mjs` на axum.
//!
//! Устройство (план — `rust/SERVER-PLAN.md`, каркас С0):
//!
//! - [`dispatch`] — упорядоченная таблица маршрутов в порядке JS поверх
//!   одного обработчика axum; [`routes`] — модули маршрутов по задачам;
//! - [`core`] — игровое ядро в одном потоке (`LocalSet`), задания по каналу;
//! - [`state`] — общее состояние HTTP-слоя, [`config`] — настройки процесса;
//! - [`boundary`], [`error`] — последняя граница и форма отказов;
//! - [`http`], [`url`] — тело, cookie, заголовки, разбор адреса как в JS;
//! - [`access`], [`idempotency`], [`limits`] — общие помощники маршрутов;
//! - [`ai_context`] — настройки ИИ кампании на время запроса;
//! - [`room`], [`journal`], [`projection`], [`streams`] — заглушки С1/С9 с
//!   зафиксированными сигнатурами.
//!
//! Контракт для клиента тот же: пути, JSON-ответы, cookie сессии
//! `skazanie_session`, коды отказов; неизвестный `/api/*` — 404 `API endpoint
//! не найден`, остальное — собранный клиент из `dist/`.

pub mod access;
pub mod ai_context;
pub mod boundary;
pub mod clocks;
pub mod command_fingerprints;
pub mod command_guard;
pub mod config;
pub mod core;
pub mod director_transition;
pub mod dispatch;
pub mod error;
pub mod files;
pub mod hero_hooks;
pub mod http;
pub mod idempotency;
pub mod journal;
pub mod limits;
pub mod merchant_guard;
pub mod projection;
pub mod rate_window;
pub mod room;
pub mod routes;
pub mod startup;
pub mod state;
pub mod static_files;
pub mod streams;
pub mod url;

pub use config::Config;
pub use state::{AppState, Injected, Shared};

/// Маршрутизатор приложения: один обработчик на всё (решение §0.1 плана).
pub fn app(state: Shared) -> axum::Router {
    axum::Router::new().fallback(dispatch::entry).with_state(state)
}
