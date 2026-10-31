//! Эталон «Г» комнаты, общего кубика и выдачи кости (С10): `fixtures/c10.json`
//! снят с JS-сервера генератором `fixtures/gen-c10.mjs`; здесь те же запросы
//! идут в Rust.
//!
//! Прогон свой (как `c6_golden.rs`) ради правил генератора: токен
//! приглашения — ссылкой `<invite:N>`, хеш карты в адресе — `<map_hash:N>`
//! (хеш из ответа обмена N; сам хеш сверяется в теле того ответа), большие
//! ветви тела — `<sha256:хеш:длина>` от JSON с ключами по алфавиту, время
//! строк летописи — `<clock>`. Кости — правила `DICE` генератора.
//!
//! `C10_DUMP=<файл>` — записать нормализованные тела Rust целиком (без
//! `shrink`) для разбора расхождения хешей; у генератора — та же переменная.

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use kit::golden::{fixtures_dir, normalize, parse};
use kit::{Client, Options, Req};

/// `BIG_BODY` генератора: длина `JSON.stringify` в единицах UTF-16.
const BIG_BODY: usize = 4_000;

fn text_length(value: &Value) -> usize {
    sk_core::js::stringify(value).encode_utf16().count()
}

/// `sorted` генератора: ключи по алфавиту, целые ключи — первыми по
/// возрастанию (так их ставит объект JS).
fn sorted(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(sorted).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| {
                let (left_index, right_index) = (sk_core::js::is_array_index_key(left), sk_core::js::is_array_index_key(right));
                match (left_index, right_index) {
                    (true, true) => left.parse::<u64>().unwrap_or(0).cmp(&right.parse::<u64>().unwrap_or(0)),
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    (false, false) => left.encode_utf16().cmp(right.encode_utf16()),
                }
            });
            Value::Object(keys.into_iter().map(|key| (key.clone(), sorted(&map[key]))).collect::<Map<String, Value>>())
        }
        other => other.clone(),
    }
}

/// `shrink` генератора (`fixtures/gen-c10.mjs`).
fn shrink(value: &Value) -> Value {
    let canonical = sorted(value);
    if !(value.is_object() || value.is_array()) || text_length(&canonical) <= BIG_BODY {
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
    let text = sk_core::js::stringify(&canonical);
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

/// Кости набора дают броскам id `roll-N`, кости JS-генератора — uuid:
/// оба — `<uuid>` (id броска случаен и в игре).
fn roll_ids(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(roll_ids).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), roll_ids(item))).collect()),
        Value::String(text) if text.strip_prefix("roll-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) => Value::from("<uuid>"),
        Value::String(text) if text.starts_with("public-die:roll-") => Value::String(format!("public-die:{}", "<uuid>")),
        other => other.clone(),
    }
}

/// Подставить ссылку `<prefix:N>` значением из `values`.
fn reference(text: &str, prefix: &str, values: &BTreeMap<usize, String>) -> Option<String> {
    let index = text.strip_prefix(prefix)?.strip_suffix('>')?.parse::<usize>().ok()?;
    Some(values.get(&index).cloned().unwrap_or_else(|| panic!("нет значения {prefix}{index}>")))
}

fn with_tokens(body: &Value, tokens: &BTreeMap<usize, String>) -> Value {
    match body {
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), with_tokens(item, tokens))).collect()),
        Value::String(text) => reference(text, "<invite:", tokens).map_or_else(|| body.clone(), Value::String),
        other => other.clone(),
    }
}

/// Адрес с `?map_hash=<map_hash:N>` — хеш из ответа N.
fn with_map_hash(path: &str, hashes: &BTreeMap<usize, String>) -> String {
    match path.split_once("map_hash=") {
        Some((head, tail)) => match reference(tail, "<map_hash:", hashes) {
            Some(hash) => format!("{head}map_hash={}", hash.replace('%', "%25").replace('&', "%26").replace('#', "%23").replace('+', "%2B")),
            None => path.to_string(),
        },
        None => path.to_string(),
    }
}

#[tokio::test]
async fn room_routes_match_js_golden() {
    let path = fixtures_dir().join("c10.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = parse(&raw);
    assert!(!exchanges.is_empty(), "эталон c10 пуст");
    let options = Options { dice: Some(kit::dice::rules(json!({ "rules": [{ "value": 2 }] }))), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut tokens: BTreeMap<usize, String> = BTreeMap::new();
    let mut hashes: BTreeMap<usize, String> = BTreeMap::new();
    let mut dump = Vec::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let target = with_map_hash(&exchange.path, &hashes);
        let mut request = Req::new(&exchange.method, &target);
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
        if let Some(hash) = body.pointer("/state/scene/map_hash").and_then(Value::as_str) {
            hashes.insert(index, hash.to_string());
        }
        let normalized = roll_ids(&clock(&normalize(&body)));
        dump.push(sorted(&normalized));
        let actual = shrink(&normalized);
        if actual != exchange.body_norm {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange.body_norm.to_string(), 3_000)));
        }
    }
    if let Ok(file) = std::env::var("C10_DUMP") {
        std::fs::write(&file, serde_json::to_string_pretty(&Value::Array(dump)).unwrap_or_default()).unwrap_or_else(|error| panic!("{file}: {error}"));
    }
    assert!(mismatches.is_empty(), "эталон c10: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
