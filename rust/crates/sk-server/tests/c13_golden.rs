//! Эталон «Г» импорта и перестройки карт (С13): `fixtures/c13.json` снят с
//! JS-сервера генератором `fixtures/gen-c13.mjs`; здесь те же запросы идут в
//! Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради правил генератора: тела
//! подготовительных обменов — `<skip>` (только статус); токен приглашения в
//! теле входа — ссылка `<invite:N>`; у `state` ответа снята летопись, поля
//! верхнего уровня тела и `state` длиннее `BIG_BODY` — по частям или хешем
//! канонического текста (`shrink`); перед обменом `open_check.before` у
//! кампании открывается проверка героя (JS — через файл реестра бросков и
//! перезапуск, здесь — регистрацией в реестре ядра); в конце — журнал
//! основной кампании.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Req};

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

/// `reduce` генератора: `state` без летописи, большие ветви — хешем.
fn reduce(body: Value) -> Value {
    let Value::Object(map) = body else { return body };
    let reduced: Map<String, Value> = map
        .into_iter()
        .map(|(key, item)| match (key.as_str(), &item) {
            ("state", Value::Object(state)) => {
                let state: Map<String, Value> = state.iter().filter(|(field, _)| field.as_str() != "messages").map(|(field, value)| (field.clone(), shrink(value))).collect();
                (key, Value::Object(state))
            }
            _ => {
                let shrunk = shrink(&item);
                (key, shrunk)
            }
        })
        .collect();
    Value::Object(reduced)
}

/// `journalEvent` генератора.
fn journal_event(event: &Value) -> Value {
    normalize(&json!({
        "event_id": event.get("event_id").cloned().unwrap_or(Value::Null),
        "event_type": event.get("event_type").cloned().unwrap_or(Value::Null),
        "actor_id": event.get("actor_id").cloned().unwrap_or(Value::Null),
        "payload": shrink(event.get("payload").unwrap_or(&json!({}))),
    }))
}

/// Подставить токены приглашений вместо ссылок `<invite:N>`.
fn with_tokens(body: &Value, tokens: &BTreeMap<usize, String>) -> Value {
    match body {
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), with_tokens(item, tokens))).collect()),
        Value::String(text) => {
            let index = text.strip_prefix("<invite:").and_then(|rest| rest.strip_suffix('>')).and_then(|index| index.parse::<usize>().ok());
            match index {
                Some(index) => Value::String(tokens.get(&index).cloned().unwrap_or_else(|| panic!("нет токена обмена {index}"))),
                None => body.clone(),
            }
        }
        other => other.clone(),
    }
}

#[tokio::test]
async fn map_import_matches_js_golden() {
    let path = fixtures_dir().join("c13.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c13 пуст");
    let open_check = raw["open_check"].clone();
    let open_before = open_check["before"].as_u64().expect("open_check.before") as usize;
    let options = kit::Options { dice: Some(kit::dice::rules(json!({ "rules": [{ "value": 2 }] }))), ..kit::Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut tokens: BTreeMap<usize, String> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        if index == open_before {
            let options = json!({
                "campaignId": open_check["campaign"],
                "actorId": open_check["actor_id"],
                "context": { "state_version": open_check["state_version"] },
            });
            server.state.core.call(move |core| Box::pin(async move { core.rolls.borrow_mut().register_check(&options).map(|_| ()) })).await.expect("ядро").expect("проверка");
        }
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &exchange.path);
        for (name, value) in &exchange.headers {
            request = request.header(name, value.clone());
        }
        if let Some(body) = &exchange.body {
            request = request.json(&with_tokens(body, &tokens));
        }
        let response = client.send(request).await;
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}: {}", response.status, exchange.status, sk_core::text::head(&response.text(), 300)));
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if let Some(token) = body.get("token").and_then(Value::as_str) {
            tokens.insert(index, token.to_string());
        }
        if exchange.body_norm == json!("<skip>") {
            continue;
        }
        let actual = reduce(normalize(&body));
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }

    // Журнал: детерминированные `event_id` и `payload` импорта и перестройки.
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
            mismatches.push(format!("журнал #{index}\n  Rust: {}\n  JS:   {}", sk_core::text::head(&left.to_string(), 3_000), sk_core::text::head(&right.to_string(), 3_000)));
        }
    }
    assert!(mismatches.is_empty(), "эталон c13: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
