//! Общие части HTTP: JSON-ответы с заголовками прежнего сервера, разбор
//! тела (только JSON-объект, до 1 МБ), cookie сессии, заголовки
//! безопасности и проверка источника изменяющих запросов.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use axum::middleware::Next;
use serde_json::{json, Value};

pub const DEV_CLIENT_ORIGIN: &str = "http://127.0.0.1:4173";
pub const SESSION_COOKIE: &str = "skazanie_session";
const MAX_BODY_BYTES: usize = 1_000_000;

/// `json(res, status, body)`.
pub fn json(status: StatusCode, body: Value) -> Response<Body> {
    let data = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    let mut response = Response::new(Body::from(data));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static(DEV_CLIENT_ORIGIN));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Ответ-отказ `{ error, code? }`.
pub fn error(status: StatusCode, message: impl Into<String>, code: Option<&str>) -> Response<Body> {
    let mut body = json!({ "error": message.into() });
    if let Some(code) = code {
        body["code"] = Value::from(code);
    }
    json(status, body)
}

/// Отказ разбора тела: 400 с кодом, как `commandPolicyError` в JS.
#[derive(Debug, Clone)]
pub struct BodyError {
    pub message: &'static str,
    pub code: &'static str,
}

impl BodyError {
    pub fn into_response(self) -> Response<Body> {
        error(StatusCode::BAD_REQUEST, self.message, Some(self.code))
    }
}

/// `readBody(req)`: тело — только JSON-объект, не больше 1 МБ; пустое — `{}`.
pub async fn read_body(body: Body) -> Result<Value, BodyError> {
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES).await.map_err(|_| BodyError { message: "Слишком большой запрос", code: "REQUEST_TOO_LARGE" })?;
    let text = String::from_utf8_lossy(&bytes);
    let source = if text.is_empty() { "{}" } else { text.as_ref() };
    let parsed: Value = serde_json::from_str(source).map_err(|_| BodyError { message: "Некорректный JSON в запросе", code: "INVALID_JSON" })?;
    if !parsed.is_object() {
        return Err(BodyError { message: "Тело запроса должно быть JSON-объектом", code: "INVALID_JSON_BODY" });
    }
    Ok(parsed)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// `cookies(req)[name]`: повреждённая cookie пропускается.
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get_all(header::COOKIE).iter().filter_map(|value| value.to_str().ok()).collect::<Vec<_>>().join(";");
    let mut found = None;
    for part in raw.split(';') {
        let Some(index) = part.find('=') else { continue };
        if index < 1 {
            continue;
        }
        let (Some(key), Some(value)) = (percent_decode(part[..index].trim()), percent_decode(part[index + 1..].trim())) else { continue };
        if key == name {
            found = Some(value);
        }
    }
    found
}

/// Токен сессии из cookie.
pub fn session_token(headers: &HeaderMap) -> String {
    cookie(headers, SESSION_COOKIE).unwrap_or_default()
}

/// `sessionCookie(req, token, expired)`.
pub fn session_cookie(headers: &HeaderMap, token: &str, expired: bool, cookie_secure: bool) -> HeaderValue {
    let forwarded_https = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .is_some_and(|value| value.trim() == "https");
    let secure = if cookie_secure || forwarded_https { "; Secure" } else { "" };
    let max_age = if expired { 0 } else { 2_592_000 };
    let text = format!("{SESSION_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", percent_encode(token));
    HeaderValue::from_str(&text).unwrap_or_else(|_| HeaderValue::from_static("skazanie_session=; Path=/; Max-Age=0"))
}

/// `originAllowed(req)`: изменяющий запрос — только со своего хоста или с
/// клиента разработки.
pub fn origin_allowed(headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()).unwrap_or("");
    if origin.is_empty() {
        return true;
    }
    if sk_core::text::test(sk_core::re!(r"^https?:\/\/(?:127\.0\.0\.1|localhost):4173$", "i"), origin) {
        return true;
    }
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or("");
    let Some(rest) = origin.split_once("://").map(|(_, rest)| rest) else { return false };
    let origin_host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !origin_host.is_empty() && origin_host.eq_ignore_ascii_case(host)
}

/// Заголовки безопасности (`applySecurityHeaders`), CORS для клиента
/// разработки и отказ изменяющим запросам с чужого источника.
pub async fn security_layer(request: Request<Body>, next: Next) -> Response<Body> {
    if request.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static(DEV_CLIENT_ORIGIN));
        headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type, X-Idempotency-Key"));
        headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
        headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
        apply_security_headers(response.headers_mut());
        return response;
    }
    let mutating = matches!(*request.method(), Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    if mutating && !origin_allowed(request.headers()) {
        let mut response = error(StatusCode::FORBIDDEN, "Запрос с другого источника отклонён", None);
        apply_security_headers(response.headers_mut());
        return response;
    }
    let mut response = next.run(request).await;
    apply_security_headers(response.headers_mut());
    response
}

fn apply_security_headers(headers: &mut HeaderMap) {
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("permissions-policy", HeaderValue::from_static("camera=(), microphone=(), geolocation=()"));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"),
    );
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
}
