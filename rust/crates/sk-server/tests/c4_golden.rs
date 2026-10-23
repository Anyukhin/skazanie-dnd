//! Эталон «Г» служебных маршрутов и справочников (С4): `fixtures/c4.json`
//! снят с JS-сервера генератором `fixtures/gen-c4.mjs`; здесь те же запросы
//! идут в Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради трёх правил генератора:
//! `models` (состояние клиентов модели процесса) вынимается из тела, сутки
//! учёта (`day`) — `<day>`, большие ветви — `<sha256:хеш:длина>` (`shrink`).
//! Остальное — общий нормализатор набора.

mod kit;

use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Req};

/// `BIG_BODY` генератора: длина `JSON.stringify` в единицах UTF-16.
const BIG_BODY: usize = 32_000;

fn text_length(value: &Value) -> usize {
    sk_core::js::stringify(value).encode_utf16().count()
}

/// `shrink` генератора (`fixtures/gen-c4.mjs`).
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

/// Тело ответа так, как его записал генератор.
fn prepare(body: &Value, omit_models: bool) -> Value {
    let mut body = normalize(body);
    if let Value::Object(map) = &mut body {
        if omit_models {
            map.shift_remove("models");
        }
        for section in ["usage", "architect"] {
            if let Some(Value::Object(part)) = map.get_mut(section) {
                let is_day = part.get("day").and_then(Value::as_str).is_some_and(|day| day.len() == 10 && day.as_bytes()[4] == b'-' && day.as_bytes()[7] == b'-');
                if is_day {
                    part.insert("day".into(), Value::from("<day>"));
                }
            }
        }
    }
    shrink(&body)
}

#[tokio::test]
async fn service_and_catalog_routes_match_js_golden() {
    let path = fixtures_dir().join("c4.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let flags: Vec<bool> = raw["exchanges"].as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|entry| entry.get("omit_models").and_then(Value::as_bool) == Some(true)).collect();
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c4 пуст");
    let server = kit::TestServer::start().await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &exchange.path);
        if let Some(body) = &exchange.body {
            request = request.json(body);
        }
        let response = client.send(request).await;
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}", response.status, exchange.status));
        }
        let body = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let omit_models = flags.get(index).copied().unwrap_or(false);
        if omit_models {
            assert!(body.get("models").is_some_and(Value::is_array), "{label}: models — список");
        }
        let actual = prepare(&body, omit_models);
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 2_000), sk_core::text::head(&exchange.body_norm.to_string(), 2_000)));
        }
    }
    assert!(mismatches.is_empty(), "эталон c4: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
