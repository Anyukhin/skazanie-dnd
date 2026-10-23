//! Эталон «Г» системного такта, мировых часов и автопропуска хода (С17):
//! `fixtures/c17.json` снят с JS-сервера генератором `fixtures/gen-c17.mjs`;
//! здесь те же запросы идут в Rust.
//!
//! Прогон свой ради правил генератора: поле обмена `wait` — опрашивать тот же
//! путь до условия (`rumor`, `turn_clock`, `auto_turn`; опросы не сверяются),
//! токен приглашения в теле входа — ссылкой `<invite:N>`, тело `<skip>` —
//! сверяется только статус. Сервер — с настоящим реестром живых потоков (часы
//! хода приходят в комнату через присутствие), маска строк летописи ответов с
//! `wait` — как у генератора (`mask_journal`), костями «каждая грань 10» и
//! сроком хода 1500 мс, как `DICE` и `TURN_TIMEOUT_MS` генератора; id бросков
//! набора (`roll-N`) — `<uuid>`, как uuid костей JS.

mod kit;

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use kit::golden::normalize;
use kit::{Client, Options, Req};

fn resolve(body: &Value, answers: &BTreeMap<usize, Value>) -> Value {
    match body {
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), resolve(item, answers))).collect()),
        Value::String(text) => match text.strip_prefix("<invite:").and_then(|rest| rest.strip_suffix('>')).and_then(|index| index.parse::<usize>().ok()) {
            Some(index) => answers.get(&index).and_then(|answer| answer.get("token")).cloned().unwrap_or_else(|| panic!("нет токена в ответе обмена {index}")),
            None => body.clone(),
        },
        other => other.clone(),
    }
}

/// Маска строк летописи ответа с `wait` — как `maskJournal` генератора.
fn mask_journal(body_norm: &mut Value, previous: Option<&Value>) {
    let known = match previous {
        Some(previous) => previous["state"]["messages"].as_array().map_or(0, Vec::len),
        None => usize::MAX,
    };
    let Some(messages) = body_norm["state"]["messages"].as_array_mut() else { return };
    for (index, message) in messages.iter_mut().enumerate() {
        let Some(map) = message.as_object_mut() else { continue };
        if map.contains_key("timestamp") {
            map.insert("timestamp".into(), Value::from("<clock>"));
        }
        if index < known {
            continue;
        }
        map.insert("id".into(), Value::from("<auto-turn>"));
        if !map.get("text").and_then(Value::as_str).unwrap_or_default().contains("время хода вышло") {
            map.insert("text".into(), Value::from("<npc-turn>"));
        }
    }
}

/// Кости набора дают броскам id `roll-N`, кости JS-генератора — uuid: оба —
/// `<uuid>` (как в `c10_golden.rs`).
fn roll_ids(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(roll_ids).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), roll_ids(item))).collect()),
        Value::String(text) if text.strip_prefix("roll-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) => Value::from("<uuid>"),
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
        _ if actual != expected => out.push(format!("{path}: Rust {} / JS {}", sk_core::text::head(&actual.to_string(), 300), sk_core::text::head(&expected.to_string(), 300))),
        _ => {}
    }
}

fn system_lines(body: Option<&Value>) -> usize {
    body.and_then(|body| body["state"]["messages"].as_array()).map_or(0, |messages| messages.iter().filter(|message| message["author"] == "Система боя").count())
}

/// Условия опроса — как `satisfied` генератора.
fn satisfied(wait: &str, body: &Value, previous: Option<&Value>) -> bool {
    let state = &body["state"];
    match wait {
        "rumor" => {
            let rumors = state["worldMemory"]["epistemic_claims"].as_array().map_or(0, |claims| claims.iter().filter(|claim| claim["kind"] == "rumor").count());
            rumors > 0 && state["autonomy"]["reputations"]["brod-guild"].as_f64().unwrap_or(0.0) != 0.0
        }
        "turn_clock" => state["turn_clock"].is_object(),
        "auto_turn" => {
            let clock = &state["turn_clock"];
            let previous_turn = previous.map(|previous| previous["state"]["turn_clock"]["turn_id"].clone()).unwrap_or(Value::Null);
            system_lines(Some(body)) >= system_lines(previous) + 2 && clock["actor_ids"] == serde_json::json!(["hero"]) && clock["turn_id"] != previous_turn
        }
        other => panic!("неизвестное условие {other}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn system_tick_clocks_and_turn_timeout_match_js_golden() {
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(kit::golden::fixtures_dir().join("c17.json")).expect("эталон c17")).expect("JSON эталона");
    let raw = golden["exchanges"].as_array().cloned().expect("exchanges");
    let exchanges = kit::golden::parse(&golden);
    assert!(!exchanges.is_empty(), "эталон c17 пуст");
    let options = Options { configure: Some(Box::new(|config| config.combat_turn_timeout_ms = 1_500.0)), live_streams: Some(Default::default()), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut answers: BTreeMap<usize, Value> = BTreeMap::new();
    let mut previous: BTreeMap<String, Value> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let request = || {
            let mut request = Req::new(&exchange.method, &exchange.path);
            if let Some(body) = &exchange.body {
                request = request.json(&resolve(body, &answers));
            }
            request
        };
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        let wait = raw[index]["wait"].as_str();
        let mut response = client.send(request()).await;
        if let Some(wait) = wait {
            for _ in 0..200 {
                let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
                if satisfied(wait, &body, previous.get(&exchange.path)) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                response = client.send(request()).await;
            }
        }
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}: {}", response.status, exchange.status, sk_core::text::head(&response.text(), 300)));
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let mut actual = roll_ids(&normalize(&body));
        if let Some(wait) = wait {
            if !satisfied(wait, &body, previous.get(&exchange.path)) {
                mismatches.push(format!("{label}: условие {wait} не выполнилось"));
            }
            mask_journal(&mut actual, previous.get(&exchange.path));
            previous.insert(exchange.path.clone(), body.clone());
        }
        if exchange.body_norm != Value::from("<skip>") {
            if actual != exchange.body_norm {
                let mut found = Vec::new();
                differences(&actual, &exchange.body_norm, "", &mut found);
                mismatches.push(format!("{label}: тело\n  {}", found.join("\n  ")));
            }
        }
        answers.insert(index, body);
    }
    assert!(mismatches.is_empty(), "эталон c17: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
