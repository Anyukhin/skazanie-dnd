//! Эталон «Г» структурированных команд стола (С18.1): `fixtures/c18-1.json`
//! снят с JS-сервера генератором `fixtures/gen-c18-1.mjs`; здесь те же
//! запросы идут в Rust.
//!
//! Правила генератора: тело создания кампании — `<c6>` (только статус);
//! псевдообмен `ASSIGN` — героев игроку назначает администратор (`GET` +
//! `PATCH /api/admin/users`, id пользователя случаен); `ROLL` —
//! `POST /api/roll` по `check_id` ответа обмена `body.from`, его `roll_id`
//! подставляется вместо `"<roll:N>"`; время летописи — `<clock>`; id
//! бросков набора (`roll-N`) — `<uuid>`, как uuid у JS; большие ветви тела —
//! `<sha256:хеш:длина>` канонического текста (`shrink`).
//!
//! `C18_1_DUMP=<файл>` — нормализованные тела Rust (без `shrink`) по номерам.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Options, Req};

const BIG_BODY: usize = 4_000;

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

/// `clock` генератора: `timestamp` вида `ЧЧ:ММ` — `<clock>`.
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
        // Глагол шага выбирается по случайному `event_id` (`phraseSeed`):
        // сверяется расстояние, а не формулировка (как в генераторе).
        Value::String(text) => {
            static MOVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            let pattern = MOVE.get_or_init(|| regex::Regex::new(r"(?:перемещается на|проходит|смещается на) (\d+) фт\.").expect("шаг"));
            Value::String(pattern.replace_all(text, "<move:$1>").into_owned())
        }
        other => other.clone(),
    }
}

/// Кости набора дают броскам id `roll-N`, кости JS — uuid: оба — `<uuid>`.
fn roll_ids(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(roll_ids).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), roll_ids(item))).collect()),
        Value::String(text) if text.strip_prefix("roll-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) => Value::from("<uuid>"),
        other => other.clone(),
    }
}

/// `combatLines` генератора: текст строк «Системы боя» и `narration` голосом
/// системы — `<combat-line>` (формулировку выбирает `Phrasebook` по
/// случайному `event_id`).
fn combat_lines(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(combat_lines).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let system_text = key == "text" && map.get("speaker") == Some(&json!("system")) && item.is_string();
                    let system_narration = key == "narration" && map.get("narration_speaker") == Some(&json!("system")) && item.is_string();
                    (key.clone(), if system_text || system_narration { Value::from("<combat-line>") } else { combat_lines(item) })
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn body_norm(body: &Value) -> Value {
    combat_lines(&clock(&roll_ids(&normalize(body))))
}

/// `"<roll:N>"` → `roll_id` обмена N.
fn with_rolls(value: &Value, rolls: &BTreeMap<usize, String>) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(|item| with_rolls(item, rolls)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), with_rolls(item, rolls))).collect::<Map<String, Value>>()),
        Value::String(text) => {
            let index = text.strip_prefix("<roll:").and_then(|rest| rest.strip_suffix('>')).and_then(|digits| digits.parse::<usize>().ok());
            match index.and_then(|index| rolls.get(&index)) {
                Some(roll) => Value::String(roll.clone()),
                None => value.clone(),
            }
        }
        other => other.clone(),
    }
}

#[tokio::test]
async fn commands_match_js_golden() {
    let path = fixtures_dir().join("c18-1.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c18-1 пуст");
    let dice = json!({
        "rules": [
            { "actor": "^hero$", "purpose": "^initiative$", "sides": 20, "value": 18 },
            { "actor": "^hero$", "sides": 20, "value": 15 },
            { "actor": "^hero$", "value": "max" },
            { "sides": 20, "value": 6 },
            { "value": "min" },
        ],
    });
    let options = Options { dice: Some(kit::dice::rules(dice)), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut mismatches = Vec::new();
    let mut checks: BTreeMap<usize, Value> = BTreeMap::new();
    let mut rolls: BTreeMap<usize, String> = BTreeMap::new();
    let mut dump = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        let (status, body) = match exchange.method.as_str() {
            "ASSIGN" => {
                let admin = clients.entry("admin".into()).or_insert_with(|| server.client());
                let users = admin.send(Req::new("GET", "/api/admin/users")).await;
                let users: Value = serde_json::from_slice(&users.body).unwrap_or(Value::Null);
                let id = users["users"].as_array().and_then(|list| list.iter().find(|user| user["email"] == json!(exchange.path))).and_then(|user| user["id"].as_str()).unwrap_or_default().to_string();
                let patched = admin.send(Req::new("PATCH", &format!("/api/admin/users/{id}")).json(&json!({ "heroIds": exchange.body.clone().unwrap_or(Value::Null) }))).await;
                if patched.status != exchange.status {
                    mismatches.push(format!("{label}: статус {} вместо {}", patched.status, exchange.status));
                }
                continue;
            }
            "ROLL" => {
                let from = exchange.body.as_ref().and_then(|body| body["from"].as_u64()).unwrap_or_default() as usize;
                let check = checks.get(&from).cloned().unwrap_or(Value::Null);
                let actor = check["actor_id"].as_str().unwrap_or("hero").to_string();
                let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
                let response = client.send(Req::new("POST", "/api/roll").json(&json!({ "campaignId": exchange.path, "playerId": actor, "checkId": check["check_id"] }))).await;
                let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
                rolls.insert(index, body["roll_id"].as_str().unwrap_or_default().to_string());
                (response.status, body)
            }
            _ => {
                let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
                let mut request = Req::new(&exchange.method, &exchange.path);
                for (name, value) in &exchange.headers {
                    request = request.header(name, value.clone());
                }
                if let Some(body) = &exchange.body {
                    request = request.json(&with_rolls(body, &rolls));
                }
                let response = client.send(request).await;
                let mut body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
                // Часы хода ставит координатор автохода (С17): генератор их снимает.
                if exchange.path.starts_with("/api/rooms/") {
                    if let Some(state) = body.get_mut("state").and_then(Value::as_object_mut) {
                        state.shift_remove("turn_clock");
                    }
                }
                if let Some(check) = body.get("check") {
                    checks.insert(index, check.clone());
                }
                (response.status, body)
            }
        };
        if status != exchange.status {
            mismatches.push(format!("{label}: статус {status} вместо {}: {}", exchange.status, sk_core::text::head(&body.to_string(), 400)));
        }
        if exchange.body_norm == json!("<c6>") {
            continue;
        }
        let normalized = body_norm(&body);
        dump.push(json!({ "index": index, "body": normalized }));
        let actual = shrink(&normalized);
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }
    if let Ok(file) = std::env::var("C18_1_DUMP") {
        let _ = std::fs::write(file, serde_json::to_string_pretty(&dump).unwrap_or_default());
    }
    assert!(mismatches.is_empty(), "эталон c18-1: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
