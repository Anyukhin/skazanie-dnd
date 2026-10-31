//! HTTP-сервер «Сказания» — перенос `server/index.mjs` на axum.
//!
//! Устройство (план — `rust/SERVER-PLAN.md`, каркас С0):
//!
//! - [`dispatch`] — упорядоченная таблица маршрутов в порядке JS поверх
//!   одного обработчика axum; [`routes`] — модули маршрутов по задачам;
//! - [`core`] — игровое ядро в одном потоке (`LocalSet`), задания по каналу;
//! - [`serve`] — цикл соединений (общий для `main.rs` и тестов);
//! - [`state`] — общее состояние HTTP-слоя, [`config`] — настройки процесса;
//! - [`boundary`], [`error`] — последняя граница и форма отказов;
//! - [`http`], [`url`] — тело, cookie, заголовки, разбор адреса как в JS;
//! - [`access`], [`idempotency`], [`limits`] — общие помощники маршрутов;
//! - [`ai_context`] — настройки ИИ кампании на время запроса;
//! - [`cli`] — разбор аргументов бинаря, [`storage_audit`] — подкоманда
//!   `audit-storage` (С19), [`legacy_import`] — подкоманда
//!   `import-legacy` (С19.2), [`content_check`] — проверка каталогов
//!   контента при старте и подкоманда `check-content` (урок 7);
//! - [`room`], [`journal`], [`projection`], [`streams`] — заглушки С1/С9 с
//!   зафиксированными сигнатурами;
//! - [`test_hooks`] — кости и сбои журнала из данных (фича `test-hooks`) и
//!   подкоманда `journal` для набора тестов JS; коммит и подтверждение
//!   проекции — только через него.
//!
//! Контракт для клиента тот же: пути, JSON-ответы, cookie сессии
//! `skazanie_session`, коды отказов; неизвестный `/api/*` — 404 `API endpoint
//! не найден`, остальное — собранный клиент из `dist/`.

// Займ `RefCell` или замок через `await` в ядре — паника `BorrowMutError`
// или взаимная блокировка соседнего задания (см. `core`); компилятор такого
// не ловит, сторожит clippy.
#![deny(clippy::await_holding_refcell_ref, clippy::await_holding_lock)]

pub mod access;
pub mod ai_context;
pub mod boundary;
pub mod cli;
pub mod clocks;
pub mod command_fingerprints;
pub mod command_guard;
pub mod config;
pub mod content_check;
pub mod core;
pub mod director_transition;
pub mod dispatch;
pub mod error;
pub mod files;
pub mod hero_hooks;
pub mod http;
pub mod idempotency;
pub mod journal;
pub mod legacy_import;
pub mod limits;
pub mod merchant_guard;
pub mod orchestration;
pub mod projection;
pub mod rate_window;
pub mod room;
pub mod routes;
pub mod serve;
pub mod startup;
pub mod state;
pub mod static_files;
pub mod storage_audit;
pub mod streams;
pub mod test_hooks;
pub mod url;

pub use config::Config;
pub use state::{AppState, Injected, Shared};

/// Маршрутизатор приложения: один обработчик на всё (решение §0.1 плана).
pub fn app(state: Shared) -> axum::Router {
    axum::Router::new().fallback(dispatch::entry).with_state(state)
}
