//! Эталон «Г» автономии кампании (С18.4): `fixtures/c18-4.json` снят с
//! JS-сервера генератором `fixtures/gen-c18-4.mjs`; здесь те же запросы идут
//! в Rust с теми же костями.
//!
//! Правила генератора (как у `c18_5_golden.rs`): `pick` обмена — пути тела
//! (`a.b`, `list[].field`), которые сверяются; `<ref:N:путь>` в пути и
//! строках тела — значение из ответа обмена N; `<invite:N>` — токен
//! приглашения из ответа N; тело `<skip>` — сверяется только статус; начало
//! строки конца боя — `<encounter-end>: ` (вариант фразы — от случайного
//! `event_id`).
//!
//! `C18_4_DUMP=<файл>` — нормализованные ответы Rust для разбора расхождений.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use kit::golden::{fixtures_dir, normalize};
use kit::{Client, Options, Req};

/// Кости генератора (`DICE` в `gen-c18-4.mjs`).
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

/// Начало строки конца боя — `<encounter-end>: ` (как `encounterEnd`
/// генератора: вариант фразы выбирается по случайному `event_id`).
fn encounter_end(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let rest = ["Столкновение завершено: ", "Бой стихает: ", "Всё кончено: "].iter().find_map(|prefix| text.strip_prefix(prefix));
            Value::String(rest.map_or_else(|| text.clone(), |rest| format!("<encounter-end>: {rest}")))
        }
        Value::Array(list) => Value::Array(list.iter().map(encounter_end).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), encounter_end(item))).collect()),
        other => other.clone(),
    }
}

/// Пути, где тела расходятся (для сообщения теста).
fn differences(actual: &Value, expected: &Value, path: &str, out: &mut Vec<String>) {
    if out.len() >= 12 {
        return;
    }
    match (actual, expected) {
        (Value::Object(left), Value::Object(right)) => {
            for key in left.keys().chain(right.keys().filter(|key| !left.contains_key(*key))) {
                differences(left.get(key).unwrap_or(&Value::Null), right.get(key).unwrap_or(&Value::Null), &format!("{path}.{key}"), out);
            }
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                differences(left, right, &format!("{path}[{index}]"), out);
            }
        }
        _ if actual != expected => out.push(format!("{path}: Rust {} / JS {}", sk_core::text::head(&actual.to_string(), 400), sk_core::text::head(&expected.to_string(), 400))),
        _ => {}
    }
}

#[tokio::test]
async fn autonomy_matches_js_golden() {
    let path = fixtures_dir().join("c18-4.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = golden["exchanges"].as_array().cloned().unwrap_or_default();
    assert!(!exchanges.is_empty(), "эталон c18-4 пуст");
    let options = Options { dice: Some(kit::dice::rules(dice())), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut raw: Vec<Value> = Vec::new();
    let mut dump = Vec::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let role = exchange["as"].as_str().unwrap_or("default").to_string();
        let method = exchange["method"].as_str().unwrap_or_default().to_string();
        let target = resolve(exchange["path"].as_str().unwrap_or_default(), &raw);
        let label = format!("#{index} {role} {method} {}", exchange["path"].as_str().unwrap_or_default());
        let client = clients.entry(role).or_insert_with(|| server.client());
        let mut request = Req::new(&method, &target);
        if let Some(body) = exchange.get("body").filter(|body| !body.is_null()).map(|body| resolve_body(body, &raw)) {
            request = request.json(&body);
        }
        let response = client.send(request).await;
        let parsed: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let expected_status = exchange["status"].as_u64().unwrap_or(0) as u16;
        if response.status != expected_status {
            mismatches.push(format!("{label}: статус {} вместо {expected_status}: {}", response.status, sk_core::text::head(&response.text(), 400)));
        }
        if exchange["body_norm"] != Value::from("<skip>") {
            let actual = match exchange.get("pick").and_then(Value::as_array) {
                Some(paths) => encounter_end(&roll_ids(&normalize(&pick(&parsed, paths)))),
                None => encounter_end(&roll_ids(&normalize(&parsed))),
            };
            if actual != exchange["body_norm"] {
                let mut found = Vec::new();
                differences(&actual, &exchange["body_norm"], "", &mut found);
                mismatches.push(format!("{label}: тело\n  {}", found.join("\n  ")));
            }
            dump.push(json!({ "index": index, "body": actual }));
        }
        raw.push(parsed);
    }
    if let Ok(file) = std::env::var("C18_4_DUMP") {
        let _ = std::fs::write(file, serde_json::to_string_pretty(&dump).unwrap_or_default());
    }
    assert!(mismatches.is_empty(), "эталон c18-4: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
