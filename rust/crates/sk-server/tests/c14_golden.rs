//! Эталон «Г» С14 (торговцы — управление и сборка), оба файла сняты
//! генератором `fixtures/gen-c14.mjs`:
//!
//! - `fixtures/c14-guard.json` — санитайзер lifecycle-команды и сверки
//!   отпечатков (`merchant_guard`) на тех же входах, что и вырезанные функции
//!   `server/index.mjs`; сравнение — по строке `JSON.stringify` исхода
//!   (порядок ключей и запись чисел как в JS), включая отказы (код и текст);
//! - `fixtures/c14.json` — сценарий маршрутов против Rust-сервера. Прогон
//!   свой, а не `kit::golden::replay`, ради правил генератора (как в С13):
//!   тела подготовительных обменов — `<skip>`, токен приглашения — ссылка
//!   `<invite:N>`, у `authoritative_state` снята летопись, большие ветви — по
//!   частям или хешем канонического текста.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sk_core::js;
use sk_server::error::Failure;
use sk_server::merchant_guard as guard;

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Req};

// --- санитайзер и отпечатки -------------------------------------------------------

fn outcome(result: Result<Value, Failure>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "err": { "code": error.code, "message": error.message } }),
    }
}

fn unit(result: Result<(), Failure>) -> Result<Value, Failure> {
    result.map(|()| Value::Null)
}

#[test]
fn merchant_guard_matches_js_golden() {
    let path = fixtures_dir().join("c14-guard.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let cases = raw["cases"].as_array().cloned().unwrap_or_default();
    assert!(cases.len() > 1_000, "эталон c14-guard: {} случаев", cases.len());
    let mut mismatches = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let function = case["fn"].as_str().unwrap_or_default();
        let args = case["args"].as_array().cloned().unwrap_or_default();
        let arg = |n: usize| args.get(n).cloned().unwrap_or(Value::Null);
        let duplicate = case.get("duplicate").cloned();
        let journal = move |_: &str, _: &str| -> Result<Option<Value>, Failure> {
            match &duplicate {
                Some(Value::String(text)) if text == "throw" => Err(Failure::new("Журнал недоступен", Some("STORE_UNAVAILABLE"))),
                Some(value) if !value.is_null() => Ok(Some(value.clone())),
                _ => Ok(None),
            }
        };
        let key = |n: usize| js::s(args.get(n));
        let actual = match function {
            "sanitizeMerchantLifecycleCommand" => outcome(guard::sanitize_merchant_lifecycle_command(&arg(0))),
            "merchantLifecycleFingerprint" => outcome(Ok(Value::String(guard::merchant_lifecycle_fingerprint(&arg(0))))),
            "assertMerchantLifecycleIdempotency" => outcome(unit(guard::assert_merchant_lifecycle_idempotency(&journal, &key(0), &key(1), &arg(2)))),
            "assertMerchantLifecycleResultFingerprint" => outcome(unit(guard::assert_merchant_lifecycle_result_fingerprint(&arg(0), &arg(1)))),
            "assertMerchantIdempotency" => outcome(unit(guard::assert_merchant_idempotency(&journal, &key(0), &key(1), &arg(2)))),
            "assertMerchantResultFingerprint" => outcome(unit(guard::assert_merchant_result_fingerprint(&arg(0), &arg(1)))),
            other => panic!("неизвестная функция эталона {other}"),
        };
        let (left, right) = (js::stringify(&actual), js::stringify(&case["out"]));
        if left != right {
            mismatches.push(format!("#{index} {function} {}\n  Rust: {}\n  JS:   {}", sk_core::text::head(&js::stringify(&Value::Array(args.clone())), 400), sk_core::text::head(&left, 600), sk_core::text::head(&right, 600)));
        }
    }
    assert!(mismatches.is_empty(), "эталон c14-guard: {} расхождений из {}\n{}", mismatches.len(), cases.len(), mismatches.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}

// --- сценарий маршрутов ------------------------------------------------------------

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
async fn merchant_routes_match_js_golden() {
    let path = fixtures_dir().join("c14.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c14 пуст");
    let server = kit::TestServer::start_with(kit::Options::default()).await;
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
        let actual = reduce(normalize(&body));
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }
    assert!(mismatches.is_empty(), "эталон c14: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
