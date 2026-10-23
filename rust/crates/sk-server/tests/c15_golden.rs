//! Эталон «Г» диалога и объяснения хода (С15): `fixtures/c15.json` снят с
//! JS-сервера генератором `fixtures/gen-c15.mjs`; здесь те же запросы идут в
//! Rust.
//!
//! Прогон свой (как `c6_golden.rs`) ради правил генератора: токен
//! приглашения в теле входа — ссылкой `<invite:N>` (токен из ответа обмена
//! N), id уточнения в теле сброса — `<clarification:N>` (`clarification.id`
//! из ответа обмена N), тело `<skip>` — сверяется только статус (ход,
//! команды и создание кампании сверяют эталоны С18.5, С18.1 и С6).
//! Остальное — общий нормализатор набора.

mod kit;

use std::collections::BTreeMap;

use serde_json::Value;

use kit::golden::{load, normalize};
use kit::{Client, Req};

/// Подставить значения из ответов прежних обменов вместо ссылок.
fn resolve(body: &Value, answers: &BTreeMap<usize, Value>) -> Value {
    match body {
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), resolve(item, answers))).collect()),
        Value::String(text) => {
            let reference = |prefix: &str| text.strip_prefix(prefix).and_then(|rest| rest.strip_suffix('>')).and_then(|index| index.parse::<usize>().ok());
            let answer = |index: usize| answers.get(&index).unwrap_or_else(|| panic!("нет ответа обмена {index}"));
            if let Some(index) = reference("<invite:") {
                return answer(index).get("token").cloned().unwrap_or_else(|| panic!("нет токена в ответе обмена {index}"));
            }
            if let Some(index) = reference("<clarification:") {
                return answer(index).get("clarification").and_then(|clarification| clarification.get("id")).cloned().unwrap_or_else(|| panic!("нет уточнения в ответе обмена {index}"));
            }
            body.clone()
        }
        other => other.clone(),
    }
}

#[tokio::test]
async fn dialogue_and_explanation_match_js_golden() {
    let exchanges = load("c15");
    assert!(!exchanges.is_empty(), "эталон c15 пуст");
    let server = kit::TestServer::start().await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut answers: BTreeMap<usize, Value> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &exchange.path);
        if let Some(body) = &exchange.body {
            request = request.json(&resolve(body, &answers));
        }
        let response = client.send(request).await;
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}: {}", response.status, exchange.status, sk_core::text::head(&response.text(), 300)));
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if exchange.body_norm != Value::from("<skip>") {
            let actual = normalize(&body);
            if actual != exchange.body_norm {
                mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
            }
        }
        answers.insert(index, body);
    }
    assert!(mismatches.is_empty(), "эталон c15: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
