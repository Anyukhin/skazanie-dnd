//! Локальный провайдер модели в протоколе RouterAI/OpenAI — по образцу
//! `startFakeProvider` из `test/kit/llm.mjs`: `POST {base}/chat/completions`,
//! `POST {base}/images`, только `127.0.0.1`, случайный порт, свой поток.
//!
//! Обработчик получает запрос и возвращает:
//! - `None` — 404 (стартовая проба модели уйдёт в cooldown);
//! - [`ProviderReply`] — ответ как есть.
//!
//! Подключение к тестовому серверу — `Options::provider(...)` набора: сервер
//! получает ключ заглушки и её адрес, клиенты модели — через учёт расхода.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{HeaderMap, Request, Response, StatusCode};
use serde_json::{json, Value};

/// Ключ заглушки (`kit-fake-provider-key` JS).
pub const FAKE_PROVIDER_KEY: &str = "kit-fake-provider-key";

/// Запрос к заглушке.
#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub method: String,
    /// Полный путь запроса.
    pub url: String,
    /// Путь без префикса `/api/v1` (например `/chat/completions`).
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub text: String,
    /// Разобранный JSON или `null`.
    pub body: Value,
}

impl ProviderRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

/// Ответ заглушки.
#[derive(Debug, Clone)]
pub struct ProviderReply {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl ProviderReply {
    /// JSON с кодом 200.
    pub fn json(value: Value) -> Self {
        Self { status: 200, body: value.to_string(), headers: Vec::new() }
    }

    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
}

/// Тело ответа `/chat/completions` (`chatCompletion` JS): объект — JSON-текст,
/// строка — как есть.
pub fn chat_completion(content: &Value) -> Value {
    let text = match content {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    json!({
        "model": "kit/fake-model",
        "choices": [{ "message": { "role": "assistant", "content": text } }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20 },
    })
}

type Handler = Arc<dyn Fn(&ProviderRequest) -> Option<ProviderReply> + Send + Sync>;

/// Запущенная заглушка; уничтожение останавливает её.
pub struct FakeProvider {
    pub addr: SocketAddr,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeProvider {
    pub fn start(handler: impl Fn(&ProviderRequest) -> Option<ProviderReply> + Send + Sync + 'static) -> Self {
        let handler: Handler = Arc::new(handler);
        let requests: Arc<Mutex<Vec<ProviderRequest>>> = Arc::default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("порт заглушки");
        listener.set_nonblocking(true).expect("неблокирующий порт");
        let addr = listener.local_addr().expect("адрес заглушки");
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let recorded = requests.clone();
        let thread = std::thread::Builder::new()
            .name("fake-provider".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("рантайм заглушки");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).expect("порт в рантайме");
                    let app = axum::Router::new().fallback(move |request: Request<Body>| {
                        let handler = handler.clone();
                        let recorded = recorded.clone();
                        async move { respond(request, handler, recorded).await }
                    });
                    let _ = axum::serve(listener, app).with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    }).await;
                });
            })
            .expect("поток заглушки");
        Self { addr, requests, stop: Some(stop), thread: Some(thread) }
    }

    /// `baseUrl` заглушки: `http://127.0.0.1:<порт>/api/v1`.
    pub fn base_url(&self) -> String {
        format!("http://{}/api/v1", self.addr)
    }

    /// Все запросы к заглушке по порядку.
    pub fn requests(&self) -> Vec<ProviderRequest> {
        self.requests.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl Drop for FakeProvider {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn headers_of(headers: &HeaderMap) -> Vec<(String, String)> {
    headers.iter().map(|(name, value)| (name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned())).collect()
}

async fn respond(request: Request<Body>, handler: Handler, recorded: Arc<Mutex<Vec<ProviderRequest>>>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024).await.unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let url = parts.uri.path_and_query().map_or_else(|| parts.uri.path().to_string(), |value| value.as_str().to_string());
    let path = url.strip_prefix("/api/v1").unwrap_or(&url).to_string();
    let request = ProviderRequest { method: parts.method.to_string(), url, path, headers: headers_of(&parts.headers), body: serde_json::from_str(&text).unwrap_or(Value::Null), text };
    recorded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(request.clone());
    let reply = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&request)));
    let reply = match reply {
        Ok(Some(reply)) => reply,
        Ok(None) => ProviderReply { status: 404, body: r#"{"error":"kit fake provider: not handled"}"#.into(), headers: Vec::new() },
        Err(_) => ProviderReply { status: 500, body: r#"{"error":"kit fake provider: handler panicked"}"#.into(), headers: Vec::new() },
    };
    let mut response = Response::builder().status(StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)).header("content-type", "application/json");
    for (name, value) in &reply.headers {
        response = response.header(name.as_str(), value.as_str());
    }
    response.body(Body::from(reply.body)).unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Адрес указывает на эту машину (`isLocalProviderUrl` JS).
pub fn is_local_provider_url(address: &str) -> bool {
    ["http://", "https://"].iter().any(|scheme| {
        address.strip_prefix(scheme).is_some_and(|rest| {
            ["127.0.0.1", "localhost", "[::1]"].iter().any(|host| rest.strip_prefix(host).is_some_and(|tail| tail.is_empty() || tail.starts_with(':') || tail.starts_with('/')))
        })
    })
}
