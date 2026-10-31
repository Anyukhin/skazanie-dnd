//! Эталон «Г» боевого стенда администратора (С5): `fixtures/c5.json` снят с
//! JS-сервера генератором `fixtures/gen-c5.mjs`; здесь те же запросы идут в
//! Rust.
//!
//! Прогон свой, а не `kit::golden::replay`, ради правил генератора: `<run:N>`
//! в пути — id N-го принятого прогона; `wait_run: N` — перед обменом
//! дождаться конца прогона N; у отчёта `trace.final_state` — хеш
//! канонического текста; большие ветви — `<sha256:хеш:длина>` текста
//! `JSON.stringify` (`shrink`). Совпадение хешей кадров и отчётов — сверка
//! самого боя: броски, события, тексты кадров и проекции байт в байт.

mod kit;

use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Req};

/// `BIG_BODY` генератора: длина `JSON.stringify` в единицах UTF-16.
const BIG_BODY: usize = 4_000;
const LAB: &str = "/api/admin/combat-lab";

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn text_length(value: &Value) -> usize {
    sk_core::js::stringify(value).encode_utf16().count()
}

/// `shrink` генератора.
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
    Value::String(format!("<sha256:{}:{}>", sha(&text), text.encode_utf16().count()))
}

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

/// Тело ответа так, как его записал генератор.
fn prepare(body: &Value) -> Value {
    let mut body = normalize(body);
    let is_report = body.get("schema").and_then(Value::as_str) == Some("combat-lab-observer/v1");
    if let Some(trace) = body.get_mut("trace").filter(|_| is_report) {
        if let Some(final_state) = trace.get_mut("final_state").filter(|state| sk_core::js::truthy(Some(state))) {
            *final_state = Value::String(format!("<canonical:{}>", sha(&canonical(final_state))));
        }
    }
    shrink(&body)
}

async fn wait_run(client: &mut Client, id: &str) {
    for _ in 0..2_400 {
        let run = client.get(&format!("{LAB}/runs/{id}")).await.json();
        if run.get("status").and_then(Value::as_str) != Some("running") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("прогон {id} не завершился");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn combat_lab_routes_match_js_golden() {
    let path = fixtures_dir().join("c5.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let waits: Vec<Option<usize>> = raw["exchanges"].as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|entry| entry.get("wait_run").and_then(Value::as_u64).map(|index| index as usize)).collect();
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c5 пуст");
    let server = kit::TestServer::start().await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut poller = server.client();
    let mut runs: Vec<String> = Vec::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        if let Some(run) = waits.get(index).copied().flatten() {
            wait_run(&mut poller, &runs[run]).await;
        }
        let mut target = exchange.path.clone();
        for (number, id) in runs.iter().enumerate() {
            target = target.replace(&format!("<run:{number}>"), id);
        }
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let mut request = Req::new(&exchange.method, &target);
        if let Some(body) = &exchange.body {
            request = request.json(body);
        }
        let response = client.send(request).await;
        if exchange.path == "/api/auth/setup-admin" {
            poller.login("gm@mail.ru", "длинный-пароль").await;
        }
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}: {}", response.status, exchange.status, sk_core::text::head(&response.text(), 300)));
        }
        let body = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if exchange.method == "POST" && exchange.path == format!("{LAB}/runs") && response.status == 202 {
            runs.push(body["id"].as_str().unwrap_or_default().to_string());
        }
        let actual = prepare(&body);
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 1_500), sk_core::text::head(&exchange.body_norm.to_string(), 1_500)));
        }
        if let Some(expected) = &exchange.headers_norm {
            for (name, value) in expected {
                let actual = response.header(name).map(|text| Value::String(text.to_string())).unwrap_or(Value::Null);
                if &actual != value {
                    mismatches.push(format!("{label}: заголовок {name}: {actual} вместо {value}"));
                }
            }
        }
    }
    assert!(mismatches.is_empty(), "эталон c5: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
