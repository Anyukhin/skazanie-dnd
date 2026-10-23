//! Эталоны «Г» (`rust/SERVER-PLAN.md` §2): сценарий снят с JS-сервера
//! генератором `fixtures/gen-<имя>.mjs` (помощники — `fixtures/golden.mjs`) в
//! `fixtures/<имя>.json`; Rust-тест прогоняет те же запросы через набор и
//! сравнивает статус и нормализованное тело.
//!
//! Формат файла — `skazanie.golden/1`:
//!
//! ```json
//! { "format": "skazanie.golden/1", "scenario": "…", "exchanges": [
//!   { "as": "admin", "method": "POST", "path": "/api/auth/login",
//!     "headers": { "x-idempotency-key": "k" }, "body": { … },
//!     "status": 200, "body_norm": { … }, "headers_norm": { "set-cookie": "…" } } ] }
//! ```
//!
//! `as` — роль клиента со своей cookie-сессией (по умолчанию `default`);
//! `headers` — заголовки запроса; `headers_norm` — необязательные
//! нормализованные заголовки ответа, которые сверяются.
//!
//! Нормализатор ([`normalize`]) — общий с JS (`fixtures/golden.mjs`, правила
//! обязаны совпадать): маскирует токены, cookie, приглашения, uuid, ISO-даты,
//! значения полей `*At`/`*_at`/`updatedAt`; целые дроби (`5.0`) печатаются
//! целыми. Детерминированные `event_id` (sha256 от кампании и ключа) не
//! маскируются — их совпадение и есть проверка.

use std::collections::BTreeMap;
use std::path::PathBuf;

use regex::Regex;
use serde_json::{Map, Value};

use super::client::{Client, Req};
use super::TestServer;

/// Формат файла эталона.
pub const GOLDEN_FORMAT: &str = "skazanie.golden/1";

/// Один обмен эталона.
#[derive(Debug, Clone)]
pub struct Exchange {
    pub role: String,
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Value>,
    pub status: u16,
    pub body_norm: Value,
    pub headers_norm: Option<Map<String, Value>>,
}

/// Расхождение с эталоном.
#[derive(Debug, Clone)]
pub struct Mismatch {
    pub index: usize,
    pub request: String,
    pub what: String,
}

impl std::fmt::Display for Mismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "#{} {}: {}", self.index, self.request, self.what)
    }
}

/// Каталог эталонов крейта.
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// Прочитать `fixtures/<имя>.json`.
pub fn load(name: &str) -> Vec<Exchange> {
    let path = fixtures_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error} — сначала node {}", path.display(), fixtures_dir().join(format!("gen-{name}.mjs")).display()));
    parse(&serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
}

/// Разобрать эталон (объект с `exchanges` или массив обменов).
pub fn parse(golden: &Value) -> Vec<Exchange> {
    let list = match golden {
        Value::Array(list) => list.clone(),
        Value::Object(map) => {
            assert_eq!(map.get("format").and_then(Value::as_str), Some(GOLDEN_FORMAT), "формат эталона");
            map.get("exchanges").and_then(Value::as_array).cloned().expect("exchanges")
        }
        _ => panic!("эталон — объект или массив"),
    };
    list.iter()
        .map(|entry| Exchange {
            role: entry.get("as").and_then(Value::as_str).unwrap_or("default").to_string(),
            method: entry["method"].as_str().expect("method").to_string(),
            path: entry["path"].as_str().expect("path").to_string(),
            headers: entry.get("headers").and_then(Value::as_object).map(|map| map.iter().map(|(key, value)| (key.clone(), value.as_str().unwrap_or_default().to_string())).collect()).unwrap_or_default(),
            body: entry.get("body").filter(|body| !body.is_null()).cloned(),
            status: entry["status"].as_u64().expect("status") as u16,
            body_norm: entry.get("body_norm").cloned().unwrap_or(Value::Null),
            headers_norm: entry.get("headers_norm").and_then(Value::as_object).cloned(),
        })
        .collect()
}

struct Masks {
    uuid: Regex,
    date: Regex,
    invite: Regex,
    cookie: Regex,
}

fn masks() -> &'static Masks {
    static MASKS: std::sync::OnceLock<Masks> = std::sync::OnceLock::new();
    MASKS.get_or_init(|| Masks {
        uuid: Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").expect("uuid"),
        date: Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z").expect("дата"),
        invite: Regex::new(r"([?&/]invite[=/])[^&#/\s]+").expect("приглашение"),
        cookie: Regex::new(r"(skazanie_session=)[^;\s]+").expect("cookie"),
    })
}

/// Ключ, значение которого — время.
fn is_time_key(key: &str) -> bool {
    key == "updatedAt" || key.ends_with("_at") || (key.len() > 2 && key.ends_with("At"))
}

/// Ключ, значение которого — секрет сессии или приглашения.
fn is_secret_key(key: &str) -> Option<&'static str> {
    let lower = key.to_lowercase();
    if lower.contains("token") {
        Some("<token>")
    } else if lower.contains("cookie") {
        Some("<cookie>")
    } else {
        None
    }
}

fn normalize_string(text: &str) -> String {
    let masks = masks();
    let text = masks.cookie.replace_all(text, "${1}<cookie>");
    let text = masks.invite.replace_all(&text, "${1}<invite>");
    let text = masks.uuid.replace_all(&text, "<uuid>");
    masks.date.replace_all(&text, "<date>").into_owned()
}

/// Нормализовать тело ответа или значение заголовка (правила — в шапке модуля).
pub fn normalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let masked = if item.is_null() {
                        Value::Null
                    } else if let Some(mask) = is_secret_key(key).filter(|_| item.is_string()) {
                        Value::from(mask)
                    } else if is_time_key(key) && (item.is_string() || item.is_number()) {
                        Value::from("<time>")
                    } else {
                        normalize(item)
                    };
                    (key.clone(), masked)
                })
                .collect(),
        ),
        Value::Array(list) => Value::Array(list.iter().map(normalize).collect()),
        Value::String(text) => Value::String(normalize_string(text)),
        Value::Number(number) => match number.as_f64() {
            Some(float) if number.is_f64() && float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0 => Value::from(float as i64),
            _ => value.clone(),
        },
        other => other.clone(),
    }
}

/// Прогнать эталон против тестового сервера; клиенты — по ролям.
pub async fn replay(server: &TestServer, exchanges: &[Exchange]) -> Vec<Mismatch> {
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &exchange.path);
        if let Some(body) = &exchange.body {
            request = request.json(body);
        }
        for (name, value) in &exchange.headers {
            request = request.header(name.as_str(), value.clone());
        }
        let response = client.send(request).await;
        let label = format!("{} {} {}", exchange.role, exchange.method, exchange.path);
        if response.status != exchange.status {
            mismatches.push(Mismatch { index, request: label.clone(), what: format!("статус {} вместо {}: {}", response.status, exchange.status, response.text().chars().take(300).collect::<String>()) });
        }
        // Как `createClient` JS: не-JSON и пустое тело — `null`.
        let body = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let actual = normalize(&body);
        if actual != exchange.body_norm {
            mismatches.push(Mismatch { index, request: label.clone(), what: format!("тело\n  Rust: {actual}\n  JS:   {}", exchange.body_norm) });
        }
        if let Some(expected) = &exchange.headers_norm {
            for (name, value) in expected {
                let actual = response.header(name).map(|text| Value::String(normalize_string(text))).unwrap_or(Value::Null);
                if &actual != value {
                    mismatches.push(Mismatch { index, request: label.clone(), what: format!("заголовок {name}: {actual} вместо {value}") });
                }
            }
        }
    }
    mismatches
}

/// Прогнать `fixtures/<имя>.json` и упасть со всеми расхождениями сразу.
pub async fn assert_golden(server: &TestServer, name: &str) {
    let exchanges = load(name);
    assert!(!exchanges.is_empty(), "эталон {name} пуст");
    let mismatches = replay(server, &exchanges).await;
    assert!(mismatches.is_empty(), "эталон {name}: {} расхождений\n{}", mismatches.len(), mismatches.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"));
}
