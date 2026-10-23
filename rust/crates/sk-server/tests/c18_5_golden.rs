//! Эталон «Г» рассказа хода (С18.5): `fixtures/c18-5.json` снят с JS-сервера
//! генератором `fixtures/gen-c18-5.mjs`; здесь те же запросы идут в Rust с
//! настоящим реестром живых потоков и теми же костями.
//!
//! Правила генератора: `pick` обмена — пути тела (`a.b`, `list[].field`,
//! числовой сегмент — элемент массива), которые сверяются; `<ref:N:путь>` в
//! пути и строках тела — значение из ответа обмена N; `<invite:N>` — токен
//! приглашения из ответа N; id бросков Rust (`roll-N`) — `<uuid>`, как uuid
//! JS; имя торговца в тексте (`<имя> раскладывает товар`) — `<merchant>`
//! (лавку двух игроков сеет id решения — случайный uuid карточки).
//! Псевдообмены: `STREAM` (открыть живой поток роли), `EVENTS` (кадры
//! `narration.*`, пришедшие роли с прошлого `EVENTS`).
//!
//! `C18_5_DUMP=<файл>` — нормализованные ответы Rust для разбора расхождений.

mod kit;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use sk_server::streams::LiveOptions;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use kit::golden::{fixtures_dir, normalize};
use kit::{Client, Options, Req};

/// Кости генератора (`DICE` в `gen-c18-5.mjs`).
fn dice() -> Value {
    json!({ "rules": [{ "sides": 6, "value": 4 }, { "value": 12 }] })
}

/// Путь `a.b` / `list[].field` / `list.0.field`; `None` — нет значения.
fn at(value: &Value, parts: &[&str]) -> Option<Value> {
    let Some((head, rest)) = parts.split_first() else { return Some(value.clone()) };
    if let Some(name) = head.strip_suffix("[]") {
        let list = value.get(name)?.as_array()?;
        return Some(Value::Array(list.iter().map(|item| at(item, rest).unwrap_or(Value::Null)).collect()));
    }
    match value {
        Value::Array(list) => head.parse::<usize>().ok().and_then(|index| list.get(index)).and_then(|item| at(item, rest)),
        Value::Object(map) => map.get(*head).and_then(|item| at(item, rest)),
        _ => None,
    }
}

fn pick(body: &Value, paths: &[Value]) -> Value {
    let mut view = Map::new();
    for path in paths.iter().filter_map(Value::as_str) {
        let parts: Vec<&str> = path.split('.').collect();
        if let Some(value) = at(body, &parts) {
            view.insert(path.to_string(), value);
        }
    }
    Value::Object(view)
}

/// `<ref:N:путь>` и `<invite:N>` — из ответов Rust.
fn resolve(text: &str, raw: &[Value]) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find('>') else {
            out.push_str(tail);
            return out;
        };
        let inner = &tail[1..end];
        let replaced = if let Some(reference) = inner.strip_prefix("ref:") {
            reference.split_once(':').and_then(|(index, path)| {
                let index: usize = index.parse().ok()?;
                let parts: Vec<&str> = path.split('.').collect();
                at(raw.get(index)?, &parts).map(|value| sk_core::js::s(Some(&value)))
            })
        } else if let Some(index) = inner.strip_prefix("invite:") {
            index.parse::<usize>().ok().and_then(|index| raw.get(index)).and_then(|body| body.get("token")).and_then(Value::as_str).map(str::to_string)
        } else {
            None
        };
        match replaced {
            Some(value) => out.push_str(&value),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

fn resolve_body(value: &Value, raw: &[Value]) -> Value {
    match value {
        Value::String(text) => Value::String(resolve(text, raw)),
        Value::Array(list) => Value::Array(list.iter().map(|item| resolve_body(item, raw)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), resolve_body(item, raw))).collect()),
        other => other.clone(),
    }
}

/// Кости набора дают броскам id `roll-N`, кости JS — uuid: оба — `<uuid>`.
fn roll_ids(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(roll_ids).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), roll_ids(item))).collect()),
        Value::String(text) if text.strip_prefix("roll-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) => Value::from("<uuid>"),
        other => other.clone(),
    }
}

/// Имя торговца в тексте — `<merchant>` (как `merchants` генератора).
fn merchants(value: &Value) -> Value {
    static MERCHANT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let merchant = MERCHANT.get_or_init(|| regex::Regex::new(r"(^|\n\n)[^\n.]*? раскладывает товар").expect("торговец"));
    match value {
        Value::String(text) => Value::String(merchant.replace_all(text, "${1}<merchant> раскладывает товар").into_owned()),
        Value::Array(list) => Value::Array(list.iter().map(merchants).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), merchants(item))).collect()),
        other => other.clone(),
    }
}

type Feed = Arc<Mutex<Vec<Value>>>;

/// Живой поток роли: рукопожатие, затем фоновое чтение кадров `narration.*`.
async fn open_stream(addr: std::net::SocketAddr, path: &str, client: &Client) -> (u16, Feed) {
    let mut stream = TcpStream::connect(addr).await.expect("соединение");
    let cookie = client.session().map(|session| format!("cookie: skazanie_session={session}\r\n")).unwrap_or_default();
    let head = format!("GET {path} HTTP/1.1\r\nhost: {addr}\r\naccept: text/event-stream\r\n{cookie}\r\n");
    stream.write_all(head.as_bytes()).await.expect("запрос");
    let mut raw = Vec::new();
    while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
        let mut chunk = [0u8; 4096];
        let read = tokio::time::timeout(Duration::from_secs(15), stream.read(&mut chunk)).await.expect("заголовки за срок").expect("чтение");
        assert!(read > 0, "сервер закрыл поток до заголовков");
        raw.extend_from_slice(&chunk[..read]);
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    let feed: Feed = Arc::default();
    let sink = feed.clone();
    let start = text.find("\r\n\r\n").map_or(0, |index| index + 4);
    tokio::spawn(async move {
        // Тело — chunked: размеры кусков не мешают, кадры ищутся по `event:`.
        let mut buffer = text[start..].to_string();
        loop {
            while let Some(end) = buffer.find("\n\n") {
                let block: String = buffer.drain(..end + 2).collect();
                let event = block.lines().find_map(|line| line.strip_prefix("event: ")).unwrap_or_default().to_string();
                let data = block.lines().filter_map(|line| line.strip_prefix("data: ")).collect::<Vec<_>>().join("\n");
                if event.starts_with("narration.") && !data.is_empty() {
                    let payload: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                    sink.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(json!({ "event": event, "payload": payload }));
                }
            }
            let mut chunk = [0u8; 4096];
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => buffer.push_str(&String::from_utf8_lossy(&chunk[..read])),
            }
        }
    });
    (status, feed)
}

#[tokio::test]
async fn narrate_matches_js_golden() {
    let path = fixtures_dir().join("c18-5.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = golden["exchanges"].as_array().cloned().unwrap_or_default();
    assert!(!exchanges.is_empty(), "эталон c18-5 пуст");
    let options = Options { dice: Some(kit::dice::rules(dice())), live_streams: Some(LiveOptions { heartbeat: Duration::from_secs(60) }), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut feeds: BTreeMap<String, Feed> = BTreeMap::new();
    let mut raw: Vec<Value> = Vec::new();
    let mut dump = Vec::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let role = exchange["as"].as_str().unwrap_or("default").to_string();
        let method = exchange["method"].as_str().unwrap_or_default().to_string();
        let target = resolve(exchange["path"].as_str().unwrap_or_default(), &raw);
        let label = format!("#{index} {role} {method} {}", exchange["path"].as_str().unwrap_or_default());
        let client = clients.entry(role.clone()).or_insert_with(|| server.client());
        match method.as_str() {
            "STREAM" => {
                let (status, feed) = open_stream(server.addr, &target, client).await;
                if status != exchange["status"].as_u64().unwrap_or(0) as u16 {
                    mismatches.push(format!("{label}: статус потока {status} вместо {}", exchange["status"]));
                }
                feeds.insert(role, feed);
                raw.push(Value::Null);
                tokio::time::sleep(Duration::from_millis(150)).await;
                continue;
            }
            "EVENTS" => {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let seen: Vec<Value> = feeds.get(&role).map(|feed| feed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).drain(..).collect()).unwrap_or_default();
                let actual = merchants(&normalize(&Value::Array(seen)));
                if actual != exchange["body_norm"] {
                    mismatches.push(format!("{label}: кадры\n  Rust: {actual}\n  JS:   {}", exchange["body_norm"]));
                }
                dump.push(json!({ "index": index, "body": actual }));
                raw.push(Value::Null);
                continue;
            }
            _ => {}
        }
        let mut request = Req::new(&method, &target);
        let body = exchange.get("body").filter(|body| !body.is_null()).map(|body| resolve_body(body, &raw));
        if let Some(body) = &body {
            request = request.json(body);
        }
        let response = client.send(request).await;
        let parsed: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let expected_status = exchange["status"].as_u64().unwrap_or(0) as u16;
        if response.status != expected_status {
            mismatches.push(format!("{label}: статус {} вместо {expected_status}: {}", response.status, sk_core::text::head(&response.text(), 400)));
        }
        let actual = match exchange.get("pick").and_then(Value::as_array) {
            Some(paths) => merchants(&roll_ids(&normalize(&pick(&parsed, paths)))),
            None => merchants(&roll_ids(&normalize(&parsed))),
        };
        if actual != exchange["body_norm"] {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange["body_norm"].to_string(), 3_000)));
        }
        dump.push(json!({ "index": index, "body": actual }));
        raw.push(parsed);
    }
    if let Ok(file) = std::env::var("C18_5_DUMP") {
        let _ = std::fs::write(file, serde_json::to_string_pretty(&dump).unwrap_or_default());
    }
    assert!(mismatches.is_empty(), "эталон c18-5: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
