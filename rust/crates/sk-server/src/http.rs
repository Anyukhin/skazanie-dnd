//! Общие части HTTP — перенос помощников `server/index.mjs`:
//!
//! - [`json`] — `json(res, status, body)` (469–480): тело печатается как
//!   `JSON.stringify` (`sk_core::js::stringify`: `5`, а не `5.0`; `1e+21`);
//! - [`RequestBody`] — `readBody(req)` (2905–2922): предел — миллион единиц
//!   UTF-16 (`raw.length` JS), а не байтов; жёсткий потолок чтения — 4 МБ;
//! - [`cookie`], [`session_cookie`] — 482–496;
//! - [`origin_allowed`], [`apply_security_headers`] — 2254–2268;
//! - [`header_text`] — `req.headers[name]`: Node читает байты заголовка как
//!   latin1, а повторы обрабатывает по `matchKnownFields`
//!   (`lib/_http_incoming.js`): у одиночных полей (`host`, `content-type`,
//!   `user-agent`, `if-modified-since`…) остаётся первое значение, `cookie`
//!   склеивается через `; `, прочие — через `, `.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use futures_util::StreamExt;
use serde_json::Value;

pub const DEV_CLIENT_ORIGIN: &str = "http://127.0.0.1:4173";
pub const SESSION_COOKIE: &str = "skazanie_session";
/// `raw.length > 1_000_000` (`index.mjs:2909`) — в единицах UTF-16.
pub const MAX_BODY_UTF16_UNITS: usize = 1_000_000;
/// Жёсткий потолок чтения тела в байтах. Любое тело больше — заведомо больше
/// миллиона единиц UTF-16 и в JS (худший случай — три байта UTF-8 на единицу),
/// так что предел JS не меняется, а память сервера ограничена.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// `json(res, status, body)`.
pub fn json(status: StatusCode, body: &Value) -> Response<Body> {
    let data = sk_core::js::stringify(body);
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

/// `json(res, status, { error })` без кода.
pub fn error(status: StatusCode, message: &str) -> Response<Body> {
    json(status, &serde_json::json!({ "error": message }))
}

/// Отказ разбора тела (`commandPolicyError(message, code)`, 638–642).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyError {
    pub message: &'static str,
    pub code: &'static str,
}

/// Коды ошибок тела, которым граница отвечает 400 (`REQUEST_BODY_ERROR_CODES`, 3887).
pub const REQUEST_BODY_ERROR_CODES: [&str; 3] = ["INVALID_JSON", "INVALID_JSON_BODY", "REQUEST_TOO_LARGE"];

pub const TOO_LARGE: BodyError = BodyError { message: "Слишком большой запрос", code: "REQUEST_TOO_LARGE" };
pub const INVALID_JSON: BodyError = BodyError { message: "Некорректный JSON в запросе", code: "INVALID_JSON" };
pub const INVALID_JSON_BODY: BodyError = BodyError { message: "Тело запроса должно быть JSON-объектом", code: "INVALID_JSON_BODY" };
/// Обрыв соединения при чтении (в Node — ошибка потока `aborted`). Кода из
/// `REQUEST_BODY_ERROR_CODES` у неё нет, поэтому граница отвечает 500.
pub const BODY_ABORTED: BodyError = BodyError { message: "aborted", code: "ECONNRESET" };

/// Сколько недочитанного тела дочитывается после ответа ([`LeftoverBody`]).
/// Node дочитывает без предела (`req._dump()`); здесь — с потолком, больше —
/// соединение закрывается, как раньше.
pub const DRAIN_LIMIT_BYTES: usize = 16 * MAX_BODY_BYTES;
/// Сколько ждать недочитанное тело: `server.requestTimeout` Node (300 с).
pub const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

type BodySlot = std::sync::Arc<std::sync::Mutex<Option<Body>>>;

fn take_slot(slot: &BodySlot) -> Option<Body> {
    slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
}

/// Тело запроса: читается лениво, один раз, как поток `req` в Node.
/// Повторное чтение даёт пустое тело (`'{}'` для JSON).
///
/// Тело лежит под замком только ради `Sync` контекста запроса (обработчики
/// держат `&RouteCtx` через `await`); замок берётся на миг, чтобы забрать тело.
pub struct RequestBody {
    body: BodySlot,
}

/// Тело, которое обработчик не прочитал (404, отказ до разбора тела).
///
/// Node после ответа дочитывает и выбрасывает такое тело (`req._dump()`), и
/// соединение живёт дальше. hyper же, когда тело брошено недочитанным,
/// закрывает соединение сразу после ответа, а непрочитанные байты в сокете
/// превращают закрытие в RST — клиент вместо ответа получает ECONNRESET
/// (С9, долг к С19). Поэтому после ответа тело дочитывается в фоне
/// ([`Self::drain`]): ответ уходит сразу, как в Node, а hyper читает остаток
/// и сохраняет соединение.
pub struct LeftoverBody {
    body: BodySlot,
}

impl LeftoverBody {
    /// Дочитать и выбросить остаток тела в фоне — не больше
    /// [`DRAIN_LIMIT_BYTES`] и [`DRAIN_TIMEOUT`]; за пределом тело бросается и
    /// соединение закрывается.
    pub fn drain(self) {
        use axum::body::HttpBody;
        let Some(body) = take_slot(&self.body) else { return };
        if body.is_end_stream() {
            return;
        }
        tokio::spawn(async move {
            let discard = async move {
                let mut stream = body.into_data_stream();
                let mut total = 0usize;
                while let Some(Ok(chunk)) = stream.next().await {
                    total += chunk.len();
                    if total > DRAIN_LIMIT_BYTES {
                        break;
                    }
                }
            };
            let _ = tokio::time::timeout(DRAIN_TIMEOUT, discard).await;
        });
    }
}

impl RequestBody {
    pub fn new(body: Body) -> Self {
        Self { body: std::sync::Arc::new(std::sync::Mutex::new(Some(body))) }
    }

    pub fn empty() -> Self {
        Self { body: std::sync::Arc::new(std::sync::Mutex::new(None)) }
    }

    /// Доступ к телу после обработчика: что он не забрал, дочитывается
    /// ([`LeftoverBody::drain`]).
    pub fn leftover(&self) -> LeftoverBody {
        LeftoverBody { body: self.body.clone() }
    }

    fn take(&self) -> Option<Body> {
        take_slot(&self.body)
    }

    /// Сырые байты до `limit` (не больше [`MAX_BODY_BYTES`]); больше —
    /// [`TOO_LARGE`]. Для WAV голосового ввода и для [`Self::json`].
    pub async fn bytes(&mut self, limit: usize) -> Result<Bytes, BodyError> {
        let Some(body) = self.take() else { return Ok(Bytes::new()) };
        let limit = limit.min(MAX_BODY_BYTES);
        let mut stream = body.into_data_stream();
        let mut collected: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| BODY_ABORTED)?;
            if collected.len() + chunk.len() > limit {
                return Err(TOO_LARGE);
            }
            collected.extend_from_slice(&chunk);
        }
        Ok(Bytes::from(collected))
    }

    /// `readBody(req)`: только JSON-объект; пустое тело — `{}`.
    pub async fn json(&mut self) -> Result<Value, BodyError> {
        let bytes = self.bytes(MAX_BODY_BYTES).await?;
        parse_body(&bytes)
    }
}

/// Разбор уже прочитанного тела по правилам `readBody` (2905–2922).
///
/// Отклонения от JS (см. отчёт С0): Node склеивает тело по кускам
/// (`raw += chunk`), и символ на стыке кусков у него становится двумя U+FFFD;
/// здесь тело декодируется целиком. Одиночный суррогат `\ud800` JS принимает
/// в строку, Rust хранить не может — он становится U+FFFD. Число вне `f64`
/// (`1e400`) JS читает как `Infinity`, здесь это `INVALID_JSON`. Вложенность:
/// у `JSON.parse` предела нет, у `serde_json` — 128 уровней; глубже —
/// `INVALID_JSON`. Предел не снимается: `unbounded_depth` без роста стека
/// роняет процесс переполнением стека, которое не ловится, а клиент игры
/// таких тел не шлёт.
pub fn parse_body(bytes: &[u8]) -> Result<Value, BodyError> {
    let text = String::from_utf8_lossy(bytes);
    if text.encode_utf16().count() > MAX_BODY_UTF16_UNITS {
        return Err(TOO_LARGE);
    }
    let source = if text.is_empty() { "{}" } else { text.as_ref() };
    let parsed = parse_json_like_js(source).ok_or(INVALID_JSON)?;
    if !parsed.is_object() {
        return Err(INVALID_JSON_BODY);
    }
    Ok(parsed)
}

/// `JSON.parse(text)` поверх `serde_json` с заменой одиночных суррогатов.
pub fn parse_json_like_js(text: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => Some(value),
        Err(_) if text.contains("\\u") => serde_json::from_str::<Value>(&replace_lone_surrogates(text)).ok(),
        Err(_) => None,
    }
}

fn hex4(chars: &[char]) -> Option<u32> {
    if chars.len() < 4 {
        return None;
    }
    chars[..4].iter().try_fold(0u32, |acc, ch| ch.to_digit(16).map(|digit| acc * 16 + digit))
}

/// Экранированные одиночные суррогаты внутри строк JSON — в `�`.
fn replace_lone_surrogates(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if !in_string {
            in_string = ch == '"';
            out.push(ch);
            index += 1;
            continue;
        }
        match ch {
            '"' => {
                in_string = false;
                out.push(ch);
                index += 1;
            }
            '\\' if chars.get(index + 1) == Some(&'u') => {
                let code = hex4(&chars[(index + 2).min(chars.len())..]);
                match code {
                    Some(0xD800..=0xDBFF) => {
                        let low = (chars.get(index + 6) == Some(&'\\') && chars.get(index + 7) == Some(&'u')).then(|| hex4(&chars[(index + 8).min(chars.len())..])).flatten();
                        if matches!(low, Some(0xDC00..=0xDFFF)) {
                            out.extend(&chars[index..index + 12]);
                            index += 12;
                        } else {
                            out.push_str("\\uFFFD");
                            index += 6;
                        }
                    }
                    Some(0xDC00..=0xDFFF) => {
                        out.push_str("\\uFFFD");
                        index += 6;
                    }
                    _ => {
                        out.push(ch);
                        index += 1;
                    }
                }
            }
            '\\' => {
                out.push(ch);
                if let Some(next) = chars.get(index + 1) {
                    out.push(*next);
                }
                index += 2;
            }
            _ => {
                out.push(ch);
                index += 1;
            }
        }
    }
    out
}

/// Поля, у которых Node при повторе оставляет первое значение
/// (`matchKnownFields`, ветка «drop duplicates»).
const SINGLE_FIELDS: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

fn latin1(value: &HeaderValue) -> String {
    value.as_bytes().iter().map(|&byte| byte as char).collect()
}

/// `req.headers[name]` (`name` — в нижнем регистре): байты как latin1,
/// повторы — по правилам Node; нет — `""`.
pub fn header_text(headers: &HeaderMap, name: &str) -> String {
    let mut values = headers.get_all(name).iter();
    if SINGLE_FIELDS.contains(&name) {
        return values.next().map(latin1).unwrap_or_default();
    }
    let separator = match name {
        "cookie" => "; ",
        // Массив `set-cookie` через `String(array)`.
        "set-cookie" => ",",
        _ => ", ",
    };
    values.map(latin1).collect::<Vec<_>>().join(separator)
}

/// Есть ли заголовок (`req.headers[name] !== undefined`).
pub fn has_header(headers: &HeaderMap, name: &str) -> bool {
    headers.contains_key(name)
}

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// `cookies(req)[name]` (482–490): повреждённая пара пропускается, поздняя
/// пара с тем же именем перекрывает раннюю. Node склеивает несколько
/// заголовков `Cookie` через `; `.
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = header_text(headers, "cookie");
    let mut found = None;
    for part in raw.split(';') {
        let Some(index) = part.find('=') else { continue };
        if index < 1 {
            continue;
        }
        let key = crate::url::decode_uri_component(sk_core::text::trim(&part[..index]));
        let value = crate::url::decode_uri_component(sk_core::text::trim(&part[index + 1..]));
        let (Some(key), Some(value)) = (key, value) else { continue };
        if key == name {
            found = Some(value);
        }
    }
    found
}

/// Токен сессии из cookie (`cookies(req).skazanie_session`); нет — `None`.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    cookie(headers, SESSION_COOKIE)
}

/// `sessionCookie(req, token, expired)` (492–496).
pub fn session_cookie(headers: &HeaderMap, token: &str, expired: bool, cookie_secure: bool) -> HeaderValue {
    let forwarded = header_text(headers, "x-forwarded-proto");
    let forwarded_https = sk_core::text::trim(forwarded.split(',').next().unwrap_or("")) == "https";
    let secure = if cookie_secure || forwarded_https { "; Secure" } else { "" };
    let max_age = if expired { 0 } else { 2_592_000 };
    let text = format!("{SESSION_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", percent_encode(token));
    HeaderValue::from_str(&text).unwrap_or_else(|_| HeaderValue::from_static("skazanie_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"))
}

/// `originAllowed(req)` (2262–2268): `new URL(origin).host === req.headers.host`
/// — точное сравнение, как в JS (хост URL уже в нижнем регистре и без порта
/// по умолчанию).
pub fn origin_allowed(headers: &HeaderMap) -> bool {
    let origin = header_text(headers, "origin");
    if origin.is_empty() {
        return true;
    }
    if sk_core::text::test(sk_core::re!(r"^https?:\/\/(?:127\.0\.0\.1|localhost):4173$", "i"), &origin) {
        return true;
    }
    crate::url::origin_host(&origin).is_some_and(|host| host == header_text(headers, "host"))
}

/// Ответ на `OPTIONS` (3930).
pub fn preflight() -> Response<Body> {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static(DEV_CLIENT_ORIGIN));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type, X-Idempotency-Key"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    response
}

/// `applySecurityHeaders(res)` (2254–2260).
pub fn apply_security_headers(headers: &mut HeaderMap) {
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("permissions-policy", HeaderValue::from_static("camera=(), microphone=(), geolocation=()"));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"),
    );
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn body_shapes_like_read_body() {
        assert_eq!(parse_body(b""), Ok(json!({})));
        for raw in ["null", "[]", "42", "\"x\"", "true"] {
            assert_eq!(parse_body(raw.as_bytes()), Err(INVALID_JSON_BODY), "{raw}");
        }
        assert_eq!(parse_body(b"{"), Err(INVALID_JSON));
        assert_eq!(parse_body(br#"{"a":1,"a":2,"b":3}"#), Ok(json!({ "a": 2, "b": 3 })), "повтор ключа — последнее значение");
        let surrogates = r#"{"a":"\ud800","b":"\ud83d\ude00","c":"\\ud800","d":"\udc00x"}"#;
        assert_eq!(parse_body(surrogates.as_bytes()), Ok(json!({ "a": "\u{FFFD}", "b": "\u{1F600}", "c": "\\ud800", "d": "\u{FFFD}x" })));
        assert_eq!(parse_body(br#"{"a":1e400}"#), Err(INVALID_JSON), "отклонение: JS читает Infinity");
    }

    #[test]
    fn nesting_deeper_than_serde_limit_is_invalid_json() {
        let nested = |depth: usize| format!("{{\"a\":{}{}}}", "[".repeat(depth), "]".repeat(depth));
        assert!(parse_body(nested(100).as_bytes()).is_ok());
        assert_eq!(parse_body(nested(200).as_bytes()), Err(INVALID_JSON), "отклонение: JSON.parse принимает");
    }

    #[test]
    fn repeated_headers_follow_node() {
        let mut headers = HeaderMap::new();
        headers.append("host", HeaderValue::from_static("a:1"));
        headers.append("host", HeaderValue::from_static("b:2"));
        headers.append("if-none-match", HeaderValue::from_static("W/\"1\""));
        headers.append("if-none-match", HeaderValue::from_static("W/\"2\""));
        headers.append("x-forwarded-proto", HeaderValue::from_static("http"));
        headers.append("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.append("cookie", HeaderValue::from_static("a=1"));
        headers.append("cookie", HeaderValue::from_static("b=2"));
        headers.append("user-agent", HeaderValue::from_bytes(b"\xe9t\xe9").unwrap_or(HeaderValue::from_static("x")));
        headers.append("user-agent", HeaderValue::from_static("second"));
        assert_eq!(header_text(&headers, "host"), "a:1", "одиночное поле — первое значение");
        assert_eq!(header_text(&headers, "if-none-match"), "W/\"1\", W/\"2\"");
        assert_eq!(header_text(&headers, "x-forwarded-proto"), "http, https");
        assert_eq!(header_text(&headers, "cookie"), "a=1; b=2");
        assert_eq!(header_text(&headers, "user-agent"), "\u{e9}t\u{e9}", "latin1");
        assert_eq!(header_text(&headers, "referer"), "");
        let mut origin = HeaderMap::new();
        origin.append("host", HeaderValue::from_static("localhost:8787"));
        origin.append("host", HeaderValue::from_static("localhost:8787"));
        origin.insert("origin", HeaderValue::from_static("http://localhost:8787"));
        assert!(origin_allowed(&origin), "два Host — сравнивается первый, как в Node");
    }

    #[test]
    fn body_limit_counts_utf16_units() {
        let wrap = |units: usize| format!("{{\"t\":\"{}\"}}", "й".repeat(units - 8));
        assert!(parse_body(wrap(MAX_BODY_UTF16_UNITS).as_bytes()).is_ok(), "ровно миллион единиц — можно");
        assert_eq!(parse_body(wrap(MAX_BODY_UTF16_UNITS + 1).as_bytes()), Err(TOO_LARGE));
        let astral = format!("{{\"t\":\"{}\"}}", "😀".repeat(500_000));
        assert_eq!(parse_body(astral.as_bytes()), Err(TOO_LARGE), "астральный символ — две единицы");
    }

    #[test]
    fn json_prints_numbers_like_js() {
        let value: Value = serde_json::from_str(r#"{"n":5.0,"b":1e21,"c":-0.0}"#).unwrap_or_default();
        let response = json(StatusCode::OK, &value);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(sk_core::js::stringify(&value), r#"{"n":5,"b":1e+21,"c":0}"#);
    }

    #[test]
    fn origin_compares_host_exactly() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:8787"));
        headers.insert("origin", HeaderValue::from_static("http://LOCALHOST:8787"));
        assert!(origin_allowed(&headers), "хост URL — в нижнем регистре");
        headers.insert("host", HeaderValue::from_static("LocalHost:8787"));
        assert!(!origin_allowed(&headers), "заголовок Host сравнивается как есть");
        headers.insert("origin", HeaderValue::from_static("http://localhost:4173"));
        assert!(origin_allowed(&headers));
        headers.insert("origin", HeaderValue::from_static("null"));
        assert!(!origin_allowed(&headers));
    }

    #[test]
    fn cookies_skip_broken_pairs() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("a=1; skazanie_session=%E0; =x"));
        headers.append(header::COOKIE, HeaderValue::from_static("skazanie_session=t%20k"));
        assert_eq!(session_token(&headers).as_deref(), Some("t k"));
        assert_eq!(cookie(&headers, "a").as_deref(), Some("1"));
    }
}
