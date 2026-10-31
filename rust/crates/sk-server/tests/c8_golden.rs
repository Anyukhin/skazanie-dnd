//! Эталон «Г» отката и жизненного цикла кампании (С8): `fixtures/c8.json`
//! снят с JS-сервера генератором `fixtures/gen-c8.mjs`; здесь те же запросы
//! идут в Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради правил генератора: тело
//! создания кампании — `<c6>` (сверяет эталон С6, здесь только статус); у
//! `state` ответа снята летопись `messages`, а поле верхнего уровня длиннее
//! `BIG_BODY` — по частям или хешем канонического текста (`shrink`); в конце
//! журнал кампании (`journal`): `event_id`, тип, актор и `payload` без снимка
//! состояния — его Rust-набор читает из ядра.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Options, Req};

/// `BIG_BODY` генератора: длина канонического текста в единицах UTF-16.
const BIG_BODY: usize = 4_000;

/// `canonical` генератора: `JSON.stringify` с ключами по алфавиту.
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(list) => format!("[{}]", list.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            let parts: Vec<String> = keys.iter().map(|key| format!("{}:{}", sk_core::js::stringify(&Value::String((*key).clone())), canonical(&map[*key]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        other => sk_core::js::stringify(other),
    }
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `shrink` генератора.
fn shrink(value: &Value) -> Value {
    if !(value.is_object() || value.is_array()) {
        return value.clone();
    }
    let text = canonical(value);
    if units(&text) <= BIG_BODY {
        return value.clone();
    }
    let parts = match value {
        Value::Array(list) => Value::Array(list.iter().map(shrink).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), shrink(item))).collect()),
        other => other.clone(),
    };
    if units(&canonical(&parts)) <= BIG_BODY {
        return parts;
    }
    let hex: String = Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    Value::String(format!("<sha256:{hex}:{}>", units(&text)))
}

/// `withoutMessages` генератора.
fn without_messages(body: Value) -> Value {
    let Value::Object(mut map) = body else { return body };
    if let Some(Value::Object(state)) = map.get("state") {
        let reduced: Map<String, Value> = state.iter().filter(|(key, _)| key.as_str() != "messages").map(|(key, item)| (key.clone(), shrink(item))).collect();
        map.insert("state".into(), Value::Object(reduced));
    }
    Value::Object(map)
}

/// `journalEvent` генератора.
fn journal_event(event: &Value) -> Value {
    let mut payload = event.get("payload").and_then(Value::as_object).cloned().unwrap_or_default();
    payload.shift_remove("state");
    normalize(&json!({
        "event_id": event.get("event_id").cloned().unwrap_or(Value::Null),
        "event_type": event.get("event_type").cloned().unwrap_or(Value::Null),
        "actor_id": event.get("actor_id").cloned().unwrap_or(Value::Null),
        "payload": Value::Object(payload),
    }))
}

#[tokio::test]
async fn controls_and_lifecycle_match_js_golden() {
    let path = fixtures_dir().join("c8.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c8 пуст");
    let options = Options { dice: Some(kit::dice::rules(json!({ "rules": [{ "value": 2 }] }))), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &exchange.path);
        for (name, value) in &exchange.headers {
            request = request.header(name, value.clone());
        }
        if let Some(body) = &exchange.body {
            request = request.json(body);
        }
        let response = client.send(request).await;
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}: {}", response.status, exchange.status, sk_core::text::head(&response.text(), 300)));
        }
        if exchange.body_norm == json!("<c6>") {
            continue;
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let actual = without_messages(normalize(&body));
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }

    // Журнал: детерминированные `event_id` отката, жизненного цикла и сводки финала.
    let campaign = raw["journal"]["campaign"].as_str().expect("journal.campaign").to_string();
    let expected = raw["journal"]["events"].as_array().cloned().expect("journal.events");
    let events = server
        .state
        .core
        .call(move |core| Box::pin(async move { core.events.get_events(&campaign, 0, None) }))
        .await
        .expect("ядро")
        .expect("журнал");
    let actual: Vec<Value> = events.iter().map(journal_event).collect();
    if actual.len() != expected.len() {
        mismatches.push(format!("журнал: {} событий вместо {}", actual.len(), expected.len()));
    }
    for (index, (left, right)) in actual.iter().zip(&expected).enumerate() {
        if left != right {
            mismatches.push(format!("журнал #{index}\n  Rust: {left}\n  JS:   {right}"));
        }
    }
    assert!(mismatches.is_empty(), "эталон c8: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
