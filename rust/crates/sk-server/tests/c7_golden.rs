//! Эталон «Г» настроек ИИ, редакции и домашних правил (С7):
//! `fixtures/c7.json` снят с JS-сервера генератором `fixtures/gen-c7.mjs`;
//! здесь те же запросы идут в Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради правил генератора: токен
//! приглашения в теле входа — ссылка `<invite:N>` (подставляется свой),
//! тело создания кампании — `<c6>` (сверяет эталон С6, здесь только статус),
//! а строки летописи «Настройки кампании» в конце сценария (`journals`)
//! сравниваются с комнатой, прочитанной из ядра (`GET /api/rooms` — С10),
//! с `id` без хвоста `-<время>`.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Value};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Options, Req};

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

/// `String(id).replace(/-\d+$/u, '')`.
fn without_time(id: &str) -> String {
    match id.rfind('-') {
        Some(at) if at + 1 < id.len() && id[at + 1..].bytes().all(|byte| byte.is_ascii_digit()) => id[..at].to_string(),
        _ => id.to_string(),
    }
}

/// Строки «Настройки кампании» летописи комнаты кампании.
async fn settings_journal(server: &kit::TestServer, code: &str) -> Value {
    let code = code.to_string();
    let messages = server
        .state
        .core
        .call(move |core| Box::pin(async move { sk_server::room::get_room(&core, &code).map(|room| room.state.and_then(|state| state.get("messages").cloned())) }))
        .await
        .expect("ядро")
        .expect("комната");
    let list = messages.and_then(|messages| messages.as_array().cloned()).unwrap_or_default();
    Value::Array(
        list.iter()
            .filter(|message| message.get("author").and_then(Value::as_str) == Some("Настройки кампании"))
            .map(|message| json!({ "id": without_time(&sk_core::js::string(message.get("id"))), "text": message.get("text").cloned().unwrap_or(Value::Null) }))
            .collect(),
    )
}

#[tokio::test]
async fn settings_routes_match_js_golden() {
    let path = fixtures_dir().join("c7.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c7 пуст");
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
        for (name, value) in &exchange.headers {
            request = request.header(name.as_str(), value.clone());
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
        if exchange.body_norm == json!("<c6>") {
            continue;
        }
        let actual = normalize(&body);
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }
    let journals = raw.get("journals").and_then(Value::as_object).cloned().unwrap_or_default();
    assert!(!journals.is_empty(), "в эталоне нет летописи");
    for (code, expected) in &journals {
        let actual = settings_journal(&server, code).await;
        if &actual != expected {
            mismatches.push(format!("летопись {code}\n  Rust: {actual}\n  JS:   {expected}"));
        }
    }
    assert!(mismatches.is_empty(), "эталон c7: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}

#[test]
fn journal_id_time_is_cut() {
    assert_eq!(without_time("house-rule-TALE-7-1729700000000"), "house-rule-TALE-7");
    assert_eq!(without_time("ai-model-TALE-7"), "ai-model-TALE");
    assert_eq!(without_time("x"), "x");
}
