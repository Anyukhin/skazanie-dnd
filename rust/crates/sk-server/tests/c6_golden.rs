//! Эталон «Г» кампаний, членства и рекапа (С6): `fixtures/c6.json` снят с
//! JS-сервера генератором `fixtures/gen-c6.mjs`; здесь те же запросы идут в
//! Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради двух правил генератора:
//! токен приглашения в теле входа записан ссылкой `<invite:N>` (токен из
//! ответа обмена N — подставляется свой), большие ветви тела —
//! `<sha256:хеш:длина>` (`shrink`, как в `c4_golden.rs`), время строк
//! летописи `ЧЧ:ММ` — `<clock>` (`clock`). Кости — те же
//! правила `DICE`, что у генератора. Остальное — общий нормализатор набора.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Options, Req};

/// `BIG_BODY` генератора: длина `JSON.stringify` в единицах UTF-16.
const BIG_BODY: usize = 32_000;

fn text_length(value: &Value) -> usize {
    sk_core::js::stringify(value).encode_utf16().count()
}

/// `shrink` генератора (`fixtures/gen-c6.mjs`).
fn shrink(value: &Value) -> Value {
    if !(value.is_object() || value.is_array()) || text_length(value) <= BIG_BODY {
        return value.clone();
    }
    let parts = match value {
        Value::Array(list) => Value::Array(list.iter().map(shrink).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), shrink(item))).collect()),
        other => other.clone(),
    };
    if text_length(&parts) <= BIG_BODY {
        return parts;
    }
    let text = sk_core::js::stringify(value);
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Value::String(format!("<sha256:{hex}:{}>", text.encode_utf16().count()))
}

/// `clock` генератора: поле `timestamp` вида `ЧЧ:ММ` — `<clock>`.
fn clock(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(clock).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let is_clock = key == "timestamp" && item.as_str().is_some_and(|text| text.len() == 5 && text.as_bytes()[2] == b':' && text.chars().filter(char::is_ascii_digit).count() == 4);
                    (key.clone(), if is_clock { Value::from("<clock>") } else { clock(item) })
                })
                .collect(),
        ),
        other => other.clone(),
    }
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
async fn campaign_routes_match_js_golden() {
    let path = fixtures_dir().join("c6.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c6 пуст");
    let options = Options { dice: Some(kit::dice::rules(json!({ "rules": [{ "value": 2 }] }))), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut tokens: BTreeMap<usize, String> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &exchange.path);
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
        let actual = shrink(&clock(&normalize(&body)));
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }
    assert!(mismatches.is_empty(), "эталон c6: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
