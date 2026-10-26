//! Обслуживание соединений — `server.listen` и `http.createServer`
//! (`server/index.mjs:6478–6506`): один цикл для `main.rs` и тестового набора,
//! чтобы тесты шли тем же путём, что и боевой сервер (рецензия С0, F5).
//!
//! - каждое соединение — HTTP/1.1 hyper с адресом сокета в расширениях
//!   запроса (`ConnectInfo`): по нему считаются окна входа
//!   (`req.socket.remoteAddress`, 2894–2899);
//! - `headersTimeout` 66 с (6488) — предел чтения заголовков; у hyper он же
//!   ограничивает простой соединения keep-alive, поэтому отдельного
//!   `keepAliveTimeout` 65 с нет — простаивающее соединение закрывается через
//!   66 с. HTTP/2 не поддерживается, как и в JS;
//! - ошибка `accept` не крутит цикл вхолостую: сброс соединения клиентом
//!   пропускается сразу, прочие (исчерпаны дескрипторы и т. п.) — с паузой
//!   [`ACCEPT_BACKOFF`], как `axum::serve`;
//! - остановка: приём прекращается, текущие соединения дожидаются до
//!   предела, который выбирает вызывающий по причине остановки. Долгие тела
//!   (живой поток С9) сами не кончаются: их тела заканчиваются
//!   ([`crate::streams::close_all`]) до этого ожидания — и у `main.rs`, и у
//!   тестового набора.

use std::future::Future;
use std::time::Duration;

use hyper_util::rt::{TokioIo, TokioTimer};
use tower::ServiceExt;

use crate::state::Shared;

/// Предел чтения заголовков (`server.headersTimeout = 66_000`, 6487).
pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(66);
/// Пауза после ошибки `accept`, которая может повторяться.
pub const ACCEPT_BACKOFF: Duration = Duration::from_millis(250);

/// Сброс соединения клиентом до `accept`: повторять сразу.
fn transient(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock)
}

/// Принимать соединения, пока не завершится `shutdown`; затем дождаться
/// текущих соединений не дольше `grace(&причина)` и вернуть причину.
pub async fn serve<T>(listener: tokio::net::TcpListener, state: Shared, shutdown: impl Future<Output = T>, grace: impl FnOnce(&T) -> Duration) -> T {
    let streams = state.clone();
    // С17 (правка общего файла): фоновым задачам ядра (координатор боя,
    // зацепки героев) нужен `AppState` — до первого соединения.
    if let Err(error) = crate::clocks::bind_app(&state).await {
        eprintln!("[Сказание] Ядро не получило состояние сервера: {error}");
    }
    let router = crate::app(state);
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    tokio::pin!(shutdown);
    let outcome = loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let router = router.clone();
                    let service = hyper::service::service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
                        request.extensions_mut().insert(axum::extract::ConnectInfo(peer));
                        router.clone().oneshot(request.map(axum::body::Body::new))
                    });
                    let connection = hyper::server::conn::http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADERS_TIMEOUT)
                        .keep_alive(true)
                        .serve_connection(TokioIo::new(stream), service);
                    let watched = graceful.watch(connection);
                    tokio::spawn(async move {
                        let _ = watched.await;
                    });
                }
                Err(error) if transient(&error) => {}
                Err(error) => {
                    eprintln!("[Сказание] Ошибка приёма соединения: {error}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
            },
            outcome = &mut shutdown => break outcome,
        }
    };
    drop(listener);
    crate::streams::close_all(&streams).await;
    let _ = tokio::time::timeout(grace(&outcome), graceful.shutdown()).await;
    outcome
}
