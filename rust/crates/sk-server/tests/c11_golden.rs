//! Эталон «Г» решений отряда и заданий (С11): `fixtures/c11.json` снят с
//! JS-сервера генератором `fixtures/gen-c11.mjs`; здесь те же запросы идут в
//! Rust с настоящим реестром живых потоков (кворум по присутствию).
//!
//! Правила генератора: токен приглашения — ссылкой `<invite:N>`;
//! голосующий-аккаунт `account:<24 hex>` — `<voter:роль>` (в строках и
//! ключах); большие ветви тела — `<sha256:хеш:длина>` от JSON с ключами по
//! алфавиту; время строк летописи — `<clock>`; id бросков — `<uuid>`.
//! Псевдообмены: `STREAM` (открыть живой поток роли), `CLOSE` (закрыть все),
//! `SLEEP` (пауза), `JOURNAL` (коммит открытия общего броска мимо HTTP и
//! сверка запуска — у JS это перезапуск), `PARALLEL` (запросы одновременно,
//! ответы сверяются без учёта порядка).
//!
//! `C11_DUMP=<файл>` — нормализованные тела Rust целиком (без `shrink`).

mod kit;

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sk_server::streams::LiveOptions;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use kit::golden::{fixtures_dir, normalize};
use kit::{Client, Options, Req};

/// `BIG_BODY` генератора: длина `JSON.stringify` в единицах UTF-16.
const BIG_BODY: usize = 4_000;
const CODES: [&str; 4] = ["PARTY-1", "PARTY-2", "PARTY-3", "PARTY-4"];

fn text_length(value: &Value) -> usize {
    sk_core::js::stringify(value).encode_utf16().count()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `sorted` генератора: ключи по алфавиту, целые ключи — первыми.
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

/// `shrink` генератора.
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
    Value::String(format!("<sha256:{}:{}>", hex(&Sha256::digest(text.as_bytes())), text.encode_utf16().count()))
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

/// Кости набора дают броскам id `roll-N`, кости JS — uuid: оба — `<uuid>`.
fn roll_ids(value: &Value) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.iter().map(roll_ids).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), roll_ids(item))).collect()),
        Value::String(text) if text.strip_prefix("roll-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) => Value::from("<uuid>"),
        other => other.clone(),
    }
}

/// `voterRefs` генератора: `account:<24 hex>` → `<voter:роль>`.
fn voter_refs(value: &Value, voters: &BTreeMap<String, String>) -> Value {
    let swap = |text: &str| -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = rest.find("account:") {
            out.push_str(&rest[..at]);
            let tail = &rest[at + "account:".len()..];
            let digest: String = tail.chars().take(24).collect();
            if digest.len() == 24 && digest.chars().all(|ch| matches!(ch, '0'..='9' | 'a'..='f')) {
                let key = format!("account:{digest}");
                out.push_str(voters.get(&key).map_or("<voter:?>", String::as_str));
                rest = &tail[24..];
            } else {
                out.push_str("account:");
                rest = tail;
            }
        }
        out.push_str(rest);
        out
    };
    match value {
        Value::Array(list) => Value::Array(list.iter().map(|item| voter_refs(item, voters)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (swap(key), voter_refs(item, voters))).collect()),
        Value::String(text) => Value::String(swap(text)),
        other => other.clone(),
    }
}

fn reference(text: &str, values: &BTreeMap<usize, String>) -> Option<String> {
    let index = text.strip_prefix("<invite:")?.strip_suffix('>')?.parse::<usize>().ok()?;
    Some(values.get(&index).cloned().unwrap_or_else(|| panic!("нет приглашения {index}")))
}

fn with_tokens(body: &Value, tokens: &BTreeMap<usize, String>) -> Value {
    match body {
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), with_tokens(item, tokens))).collect()),
        Value::String(text) => reference(text, tokens).map_or_else(|| body.clone(), Value::String),
        other => other.clone(),
    }
}

fn tidy(body: &Value, voters: &BTreeMap<String, String>) -> Value {
    roll_ids(&clock(&voter_refs(&normalize(body), voters)))
}

/// Живой поток: рукопожатие и удержание сокета. Ответ — статус.
async fn open_stream(addr: std::net::SocketAddr, path: &str, client: &Client) -> (u16, TcpStream) {
    let mut stream = TcpStream::connect(addr).await.expect("соединение");
    let cookie = client.session().map(|session| format!("cookie: skazanie_session={session}\r\n")).unwrap_or_default();
    let head = format!("GET {path} HTTP/1.1\r\nhost: {addr}\r\naccept: text/event-stream\r\n{cookie}\r\n");
    stream.write_all(head.as_bytes()).await.expect("запрос");
    let mut raw = Vec::new();
    while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
        let mut chunk = [0u8; 1024];
        let read = tokio::time::timeout(Duration::from_secs(15), stream.read(&mut chunk)).await.expect("заголовки за срок").expect("чтение");
        assert!(read > 0, "сервер закрыл поток до заголовков");
        raw.extend_from_slice(&chunk[..read]);
    }
    let status = String::from_utf8_lossy(&raw).split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    (status, stream)
}

/// `JOURNAL`: открыть общий бросок коммитом мимо HTTP, затем сверка и
/// фоновые задачи запуска — как перезапуск JS-генератора.
async fn journal(server: &kit::TestServer, code: &str, spec: &Value) {
    let (code, spec) = (code.to_string(), spec.clone());
    server
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                let loaded = core.events.load(&code, &sk_store::LoadOptions::default()).expect("журнал");
                let mut interaction = spec["interaction"].clone();
                interaction["createdAt"] = json!(sk_core::clock::now_ms());
                let options = json!({ "eligibleHeroIds": spec["eligibleHeroIds"], "policy": loaded.state.get("partyDecisionPolicy").cloned().unwrap_or(Value::Null) });
                let opened = sk_memory::party_decision::party_decision_opened_event(&interaction, spec.get("actor_id"), &options).expect("событие");
                core.events
                    .commit(sk_store::CommitRequest {
                        campaign_id: code.clone(),
                        expected_state_version: loaded.state_version,
                        idempotency_key: spec["idempotency_key"].as_str().unwrap_or_default().to_string(),
                        command_id: None,
                        events: vec![opened],
                        force_snapshot: false,
                        metadata: json!({}),
                    })
                    .expect("коммит");
                sk_server::startup::prepare(&core).expect("сверка запуска");
                sk_server::startup::startup_jobs(&core);
            })
        })
        .await
        .expect("ядро");
    tokio::time::sleep(Duration::from_millis(400)).await;
}

#[tokio::test]
async fn party_routes_match_js_golden() {
    let path = fixtures_dir().join("c11.json");
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap_or_else(|error| panic!("{error}"));
    let exchanges = raw["exchanges"].as_array().cloned().unwrap_or_default();
    assert!(!exchanges.is_empty(), "эталон c11 пуст");
    let dice = json!({ "rules": [{ "purpose": "^party_decision$", "sides": 20, "value": 14 }, { "value": 3 }] });
    let options = Options { dice: Some(kit::dice::rules(dice)), live_streams: Some(LiveOptions { heartbeat: Duration::from_secs(60) }), ..Options::default() };
    let server = kit::TestServer::start_with(options).await;
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut tokens: BTreeMap<usize, String> = BTreeMap::new();
    let mut voters: BTreeMap<String, String> = BTreeMap::new();
    let mut streams: Vec<TcpStream> = Vec::new();
    let mut dump = Vec::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let role = exchange["as"].as_str().unwrap_or("default").to_string();
        let method = exchange["method"].as_str().unwrap_or_default().to_string();
        let target = exchange["path"].as_str().unwrap_or_default().to_string();
        let label = format!("#{index} {role} {method} {target}");
        let client = clients.entry(role.clone()).or_insert_with(|| server.client());
        match method.as_str() {
            "STREAM" => {
                let (status, stream) = open_stream(server.addr, &target, client).await;
                if status != exchange["status"].as_u64().unwrap_or(0) as u16 {
                    mismatches.push(format!("{label}: статус потока {status} вместо {}", exchange["status"]));
                }
                streams.push(stream);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            "CLOSE" => {
                streams.clear();
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
            "SLEEP" => {
                tokio::time::sleep(Duration::from_millis(exchange["body"]["ms"].as_u64().unwrap_or(0))).await;
                continue;
            }
            "JOURNAL" => {
                journal(&server, &target, &exchange["body"]).await;
                continue;
            }
            "PARALLEL" => {
                let bodies = exchange["body"].as_array().cloned().unwrap_or_default();
                let tasks: Vec<_> = bodies
                    .into_iter()
                    .map(|body| {
                        let mut copy = Client { addr: client.addr, cookies: client.cookies.clone() };
                        let target = target.clone();
                        tokio::spawn(async move { copy.send(Req::new("POST", &target).json(&body)).await })
                    })
                    .collect();
                let mut actual = Vec::new();
                for task in tasks {
                    let response = task.await.expect("запрос");
                    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
                    actual.push(json!({ "status": response.status, "body_norm": shrink(&tidy(&body, &voters)) }));
                }
                let mut expected = exchange["body_norm"].as_array().cloned().unwrap_or_default();
                let key = |value: &Value| value.to_string();
                actual.sort_by_key(key);
                expected.sort_by_key(key);
                if actual != expected {
                    mismatches.push(format!("{label}: ответы\n  Rust: {}\n  JS:   {}", sk_core::text::head(&Value::Array(actual).to_string(), 3_000), sk_core::text::head(&Value::Array(expected).to_string(), 3_000)));
                }
                continue;
            }
            _ => {}
        }
        let mut request = Req::new(&method, &target);
        let body = exchange.get("body").filter(|body| !body.is_null()).map(|body| with_tokens(body, &tokens));
        if let Some(body) = &body {
            request = request.json(body);
        }
        for (name, value) in exchange["headers"].as_object().cloned().unwrap_or_default() {
            request = request.header(Box::leak(name.into_boxed_str()), value.as_str().unwrap_or_default().to_string());
        }
        let response = client.send(request).await;
        let expected_status = exchange["status"].as_u64().unwrap_or(0) as u16;
        if response.status != expected_status {
            mismatches.push(format!("{label}: статус {} вместо {expected_status}: {}", response.status, sk_core::text::head(&response.text(), 300)));
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if let Some(token) = body.get("token").and_then(Value::as_str) {
            tokens.insert(index, token.to_string());
        }
        if let Some(user_id) = body.pointer("/user/id").and_then(Value::as_str).filter(|_| target.starts_with("/api/auth/")) {
            for code in CODES {
                let digest = hex(&Sha256::digest(format!("{code}\0{user_id}").as_bytes()));
                voters.insert(format!("account:{}", &digest[..24]), format!("<voter:{role}>"));
            }
        }
        let normalized = tidy(&body, &voters);
        dump.push(sorted(&normalized));
        let actual = shrink(&normalized);
        if actual != exchange["body_norm"] {
            mismatches.push(format!("{label}: тело\n  Rust: {}\n  JS:   {}", sk_core::text::head(&actual.to_string(), 3_000), sk_core::text::head(&exchange["body_norm"].to_string(), 3_000)));
        }
    }
    drop(streams);
    if let Ok(file) = std::env::var("C11_DUMP") {
        std::fs::write(&file, serde_json::to_string_pretty(&Value::Array(dump)).unwrap_or_default()).unwrap_or_else(|error| panic!("{file}: {error}"));
    }
    assert!(mismatches.is_empty(), "эталон c11: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}
