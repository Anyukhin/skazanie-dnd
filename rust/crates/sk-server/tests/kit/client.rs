//! Сырой HTTP/1.1-клиент с cookie — по образцу `createClient` из
//! `test/kit/http.mjs`. Адрес уходит как есть (`..`, `//`, `%E0`), без
//! нормализации клиентской библиотекой; ответ ждётся не дольше
//! [`CLIENT_TIMEOUT`]. Типовые шаги набора JS — [`Client::setup_admin`],
//! [`Client::register`], [`Client::login`].

use std::collections::BTreeMap;
use std::net::SocketAddr;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Предел ожидания ответа клиентом: зависание сервера — падение теста.
pub const CLIENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Пароль аккаунтов набора.
pub const PASSWORD: &str = "длинный-пароль";

/// Ответ сервера.
#[derive(Debug, Clone)]
pub struct TestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl TestResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// Все значения заголовка (`set-cookie` бывает несколько).
    pub fn header_all(&self, name: &str) -> Vec<&str> {
        self.headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str()).collect()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| Value::String(self.text()))
    }

    /// `expectStatus(response, status)` JS: статус или падение с телом ответа.
    pub fn expect(&self, status: u16) -> Value {
        assert_eq!(self.status, status, "ожидался HTTP {status}, получен {}: {}", self.status, self.text().chars().take(400).collect::<String>());
        self.json()
    }
}

/// Запрос для [`Client::send`].
pub struct Req<'a> {
    pub method: &'a str,
    pub target: &'a str,
    pub body: Option<Vec<u8>>,
    pub headers: Vec<(&'a str, String)>,
}

impl<'a> Req<'a> {
    pub fn new(method: &'a str, target: &'a str) -> Self {
        Self { method, target, body: None, headers: Vec::new() }
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn json(self, value: &Value) -> Self {
        self.body(value.to_string()).header("content-type", "application/json")
    }

    pub fn header(mut self, name: &'a str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    /// Заголовок `X-Idempotency-Key` (опция `idempotencyKey` клиента JS).
    pub fn idempotency_key(self, key: impl Into<String>) -> Self {
        self.header("x-idempotency-key", key)
    }
}

/// Клиент с собственной cookie-сессией.
pub struct Client {
    pub addr: SocketAddr,
    pub cookies: BTreeMap<String, String>,
}

fn decode_chunked(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = raw.windows(2).position(|pair| pair == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..line_end]).trim(), 16).unwrap_or(0);
        raw = &raw[line_end + 2..];
        if size == 0 || raw.len() < size {
            break;
        }
        out.extend_from_slice(&raw[..size]);
        raw = raw.get(size + 2..).unwrap_or(&[]);
    }
    out
}

impl Client {
    pub fn new(addr: SocketAddr) -> Self {
        Self { addr, cookies: BTreeMap::new() }
    }

    /// Значение cookie сессии (`skazanie_session`) или `None`.
    pub fn session(&self) -> Option<&str> {
        self.cookies.get("skazanie_session").map(String::as_str)
    }

    pub async fn send(&mut self, request: Req<'_>) -> TestResponse {
        let target = request.target.to_string();
        let method = request.method.to_string();
        let mut stream = tokio::net::TcpStream::connect(self.addr).await.expect("соединение");
        let mut head = format!("{} {} HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n", request.method, request.target, self.addr);
        if !self.cookies.is_empty() {
            let cookie = self.cookies.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("; ");
            head.push_str(&format!("cookie: {cookie}\r\n"));
        }
        for (name, value) in &request.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        let body = request.body.unwrap_or_default();
        if !body.is_empty() || matches!(request.method, "POST" | "PUT" | "PATCH" | "DELETE") {
            head.push_str(&format!("content-length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.expect("запись");
        stream.write_all(&body).await.expect("тело");
        let mut raw = Vec::new();
        let read = tokio::time::timeout(CLIENT_TIMEOUT, stream.read_to_end(&mut raw)).await;
        assert!(read.is_ok(), "сервер не ответил за {CLIENT_TIMEOUT:?}: {method} {target}");
        let split = raw.windows(4).position(|window| window == b"\r\n\r\n").unwrap_or(raw.len());
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.split("\r\n");
        let status = lines.next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse().ok()).unwrap_or(0);
        let headers: Vec<(String, String)> = lines.filter_map(|line| line.split_once(':').map(|(key, value)| (key.trim().to_lowercase(), value.trim().to_string()))).collect();
        let mut body = raw.get(split + 4..).unwrap_or(&[]).to_vec();
        if headers.iter().any(|(key, value)| key == "transfer-encoding" && value.contains("chunked")) {
            body = decode_chunked(&body);
        }
        for (key, value) in &headers {
            if key == "set-cookie" {
                let pair = value.split(';').next().unwrap_or("");
                if let Some((name, cookie)) = pair.split_once('=') {
                    // Сервер снимает сессию пустым значением или Max-Age=0.
                    if value.contains("Max-Age=0") || cookie.is_empty() {
                        self.cookies.remove(name);
                    } else {
                        self.cookies.insert(name.to_string(), cookie.to_string());
                    }
                }
            }
        }
        TestResponse { status, headers, body }
    }

    pub async fn get(&mut self, target: &str) -> TestResponse {
        self.send(Req::new("GET", target)).await
    }

    pub async fn post(&mut self, target: &str, body: &Value) -> TestResponse {
        self.send(Req::new("POST", target).json(body)).await
    }

    pub async fn patch(&mut self, target: &str, body: &Value) -> TestResponse {
        self.send(Req::new("PATCH", target).json(body)).await
    }

    pub async fn put(&mut self, target: &str, body: &Value) -> TestResponse {
        self.send(Req::new("PUT", target).json(body)).await
    }

    pub async fn delete(&mut self, target: &str) -> TestResponse {
        self.send(Req::new("DELETE", target)).await
    }

    pub async fn post_raw(&mut self, target: &str, body: impl Into<Vec<u8>>) -> TestResponse {
        self.send(Req::new("POST", target).body(body).header("content-type", "application/json")).await
    }

    /// Администратор через `setup-admin` (код `setup-code` набора).
    pub async fn setup_admin(&mut self) -> Value {
        let response = self.post("/api/auth/setup-admin", &json!({ "email": "gm@mail.ru", "password": PASSWORD, "name": "Ведущий", "setupToken": "setup-code" })).await;
        assert_eq!(response.status, 201, "{}", response.text());
        response.json()["user"].clone()
    }

    /// Игрок через `register`.
    pub async fn register(&mut self, email: &str) -> Value {
        let response = self.post("/api/auth/register", &json!({ "email": email, "password": PASSWORD, "name": "Аня" })).await;
        assert_eq!(response.status, 201, "{}", response.text());
        response.json()["user"].clone()
    }

    /// Вход существующим аккаунтом (новая сессия в этом клиенте).
    pub async fn login(&mut self, email: &str, password: &str) -> Value {
        let response = self.post("/api/auth/login", &json!({ "email": email, "password": password })).await;
        assert_eq!(response.status, 200, "{}", response.text());
        assert!(self.session().is_some(), "login должен выдать сессию");
        response.json()["user"].clone()
    }
}
