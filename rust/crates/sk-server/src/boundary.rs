//! Последняя граница HTTP — `failUnhandledRequest` (`server/index.mjs:3885–3917`).
//!
//! Необработанная ошибка маршрута завершает только свой запрос:
//!
//! - отказ [`ApiError`] отдаётся как есть; если это необработанная ошибка
//!   нижнего слоя (`internal`), в лог идут метод, путь без query и
//!   подробность — без тела и заголовков запроса;
//! - паника обработчика (и `JoinError` из `spawn_blocking`, и паника задания
//!   ядра — они приходят сюда как [`crate::core::CoreError::Panicked`])
//!   становится 500 `{ error: 'Внутренняя ошибка сервера', code:
//!   'INTERNAL_ERROR' }`; следующий запрос обслуживается как обычно;
//! - ошибки разбора тела — 400 с их кодом (`From<BodyError> for ApiError`).
//!
//! Начатый ответ (SSE) статус не перепишет: паника внутри тела потока
//! роняет только задачу соединения hyper, и соединение закрывается — как
//! `res.destroy()` в JS.

use std::future::Future;
use std::panic::AssertUnwindSafe;

use axum::body::Body;
use axum::http::{Method, Response};
use futures_util::FutureExt;

use crate::error::{ApiError, ApiResult};

/// Текст паники для лога.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "panic".to_string()
    }
}

/// Выполнить обработчик внутри границы.
pub async fn guard<F>(method: Method, pathname: String, future: F) -> Response<Body>
where
    F: Future<Output = ApiResult>,
{
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            if let Some(detail) = &error.internal {
                eprintln!("[Сказание] Необработанная ошибка {method} {pathname}: {detail}");
            }
            error.into_response()
        }
        Err(payload) => {
            let detail = panic_text(payload.as_ref());
            eprintln!("[Сказание] Необработанная ошибка {method} {pathname}: {detail}");
            ApiError::internal(detail).into_response()
        }
    }
}
