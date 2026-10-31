//! Эталон «Г» С18.3 (сборка встречи `POST encounters/assemble`):
//! `fixtures/c18-3.json` снят с JS-сервера генератором
//! `fixtures/gen-c18-3.mjs`; здесь те же запросы идут в Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради правил генератора (как в
//! С14): тела подготовительных обменов — `<skip>`, токен приглашения —
//! ссылка `<invite:N>`, у `authoritative_state` снята летопись, большие
//! ветви — по частям или хешем канонического текста; строки `narration` на любой глубине — `<combat-line>`
//! (формулировка выбирается по случайному `event_id`); у `GET /api/rooms` —
//! только летопись (id, голос, автор, текст). Кости сервера — те же
//! правила, что `DICE` генератора.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sk_core::js;

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
            let parts: Vec<String> = keys.iter().map(|key| format!("{}:{}", js::stringify(&Value::String((*key).clone())), canonical(&map[*key]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        other => js::stringify(other),
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

/// `reduce` генератора: `authoritative_state` без летописи, большие ветви — хешем.
fn reduce(body: Value) -> Value {
    let Value::Object(map) = body else { return body };
    let reduced: Map<String, Value> = map
        .into_iter()
        .map(|(key, item)| match (key.as_str(), &item) {
            ("authoritative_state", Value::Object(state)) => {
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

/// `maskNarration` генератора: строки `narration` на любой глубине —
/// `<combat-line>`, `verification` (объект) — `<verification>`.
fn mask_narration(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(mask_narration).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| match item {
                    Value::String(text) if key == "narration" && !text.is_empty() => (key.clone(), Value::from("<combat-line>")),
                    Value::Object(_) if key == "verification" => (key.clone(), Value::from("<verification>")),
                    _ => (key.clone(), mask_narration(item)),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Путь первого расхождения и обе стороны (тела велики для целого вывода).
fn first_difference(actual: &Value, expected: &Value, path: &str) -> String {
    match (actual, expected) {
        (Value::Object(left), Value::Object(right)) => {
            for key in left.keys().chain(right.keys()) {
                let (a, b) = (left.get(key).unwrap_or(&Value::Null), right.get(key).unwrap_or(&Value::Null));
                if a != b || left.contains_key(key) != right.contains_key(key) {
                    return first_difference(a, b, &format!("{path}.{key}"));
                }
            }
            format!("{path}: нет")
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (a, b)) in left.iter().zip(right).enumerate() {
                if a != b {
                    return first_difference(a, b, &format!("{path}[{index}]"));
                }
            }
            format!("{path}: нет")
        }
        _ => format!("{path}
  Rust: {}
  JS:   {}", sk_core::text::head(&actual.to_string(), 1_500), sk_core::text::head(&expected.to_string(), 1_500)),
    }
}

/// `journal` генератора: летопись комнаты — id, голос, автор, текст.
fn journal(body: &Value) -> Value {
    let messages = body.get("state").and_then(|state| state.get("messages")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let field = |message: &Value, key: &str| message.get(key).cloned().unwrap_or(Value::Null);
    let entries: Vec<Value> = messages.iter().map(|message| json!({ "id": field(message, "id"), "speaker": field(message, "speaker"), "author": field(message, "author"), "text": if js::string(message.get("id")).starts_with("combat-") { json!("<combat-line>") } else { field(message, "text") } })).collect();
    json!({ "messages": entries })
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
async fn encounter_assembly_matches_js_golden() {
    let path = fixtures_dir().join("c18-3.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c18-3 пуст");
    let dice = json!({ "rules": [{ "purpose": "^initiative$", "actor": "^hero", "value": "min" }, { "purpose": "^initiative$", "value": "max" }, { "value": "min" }] });
    let server = kit::TestServer::start_with(Options { dice: Some(kit::dice::rules(dice)), ..Options::default() }).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut tokens: BTreeMap<usize, String> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
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
        let normalized = roll_ids(&normalize(&body));
        let actual = if exchange.method == "POST" { reduce(mask_narration(&normalized)) } else { journal(&normalized) };
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело, первое расхождение {}", first_difference(&actual, &exchange.body_norm, "")));
        }
    }
    assert!(mismatches.is_empty(), "эталон c18-3: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}

/// Кости набора дают броскам id `roll-N`, кости JS — uuid: оба — `<uuid>`
/// (как в `c18_1_golden`).
fn roll_ids(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(roll_ids).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), roll_ids(item))).collect()),
        Value::String(text) if text.strip_prefix("roll-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) => Value::from("<uuid>"),
        other => other.clone(),
    }
}
