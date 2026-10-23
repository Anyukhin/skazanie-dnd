//! HTTP-транспорт генератора картинок (`fetchImpl = fetch` у
//! `createRouterImageGenerator`, `server/image-generation.mjs`) — тот же
//! `reqwest` на `rustls`, что у [`super::RouterAiClient`]: системный
//! верификатор сертификатов, без прокси из окружения.
//!
//! Добавлено задачей С12 переноса HTTP-сервера: собственного транспорта у
//! `sk_infra::image_generation` нет (сеть там за трейтом), а настоящий
//! `fetch` нужен портретам, иллюстрациям и картинкам предметов.
//!
//! Ошибки — как у `fetch` Node: сбой сети — `TypeError: fetch failed`,
//! истёкший `AbortSignal.timeout` (и на запросе, и на чтении тела) —
//! `TimeoutError: The operation was aborted due to timeout`. Ключ в текст
//! ошибки не попадает: заголовок `Authorization` помечен чувствительным.

use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use sk_infra::image_generation::{ImageFuture, ImageHttpRequest, ImageHttpResponse, ImageHttpTransport, ImageTransportError};

use super::router_ai::build_http_client;
use super::LlmError;

/// `fetch` для `POST {baseUrl}/images`.
#[derive(Clone)]
pub struct RouterImageTransport {
    http: reqwest::Client,
}

impl std::fmt::Debug for RouterImageTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RouterImageTransport").finish_non_exhaustive()
    }
}

fn fetch_failed() -> ImageTransportError {
    ImageTransportError { name: "TypeError".into(), message: "fetch failed".into() }
}

fn timed_out() -> ImageTransportError {
    ImageTransportError { name: "TimeoutError".into(), message: "The operation was aborted due to timeout".into() }
}

impl RouterImageTransport {
    /// Транспорт с TLS процесса.
    pub fn new() -> Result<Self, LlmError> {
        Ok(Self { http: build_http_client()? })
    }

    async fn exchange(&self, request: ImageHttpRequest) -> Result<ImageHttpResponse, ImageTransportError> {
        let url = reqwest::Url::parse(&request.url).map_err(|_| ImageTransportError { name: "TypeError".into(), message: "Failed to parse URL".into() })?;
        let mut builder = self.http.post(url);
        for (name, value) in &request.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| fetch_failed())?;
            let mut value = HeaderValue::from_str(value).map_err(|_| ImageTransportError { name: "TypeError".into(), message: "Invalid header value".into() })?;
            if name == reqwest::header::AUTHORIZATION {
                value.set_sensitive(true);
            }
            builder = builder.header(name, value);
        }
        let mut response = builder.body(request.body).send().await.map_err(|_| fetch_failed())?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => body.extend_from_slice(&bytes),
                Ok(None) => break,
                Err(_) => return Err(ImageTransportError { name: "TypeError".into(), message: "terminated".into() }),
            }
        }
        Ok(ImageHttpResponse { status, body })
    }
}

impl ImageHttpTransport for RouterImageTransport {
    fn post(&self, request: ImageHttpRequest) -> ImageFuture<'_> {
        Box::pin(async move {
            let limit = Duration::from_millis(request.timeout_ms);
            match tokio::time::timeout(limit, self.exchange(request)).await {
                Ok(result) => result,
                Err(_) => Err(timed_out()),
            }
        })
    }
}
