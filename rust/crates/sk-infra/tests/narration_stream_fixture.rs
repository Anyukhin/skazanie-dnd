//! Сверка `narration_stream` с эталоном JS (`fixtures/gen-narration-stream.mjs`):
//! поток рассказа с ручными таймерами и очередь кадров соединения.

mod common;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sk_infra::narration_stream::{
    campaign_stream_frame_key, CampaignNarrationStream, CampaignStreamOutbox, NarrationConnection, NarrationStreamError, NarrationStreamOptions, StreamTimers, TimerCallback, TimerId,
};

use common::{fixture_path, same_json};

/// Ручные таймеры, как в `harness()` теста JS: срабатывают только по `flush`.
#[derive(Default)]
pub struct ManualTimers {
    next: AtomicU64,
    queue: Mutex<VecDeque<(u64, TimerCallback)>>,
}

impl ManualTimers {
    fn fire_one(&self) -> bool {
        let next = self.queue.lock().expect("таймеры").pop_front();
        match next {
            Some((_, callback)) => {
                callback();
                true
            }
            None => false,
        }
    }

    fn flush(&self) {
        while self.fire_one() {}
    }

    fn len(&self) -> usize {
        self.queue.lock().expect("таймеры").len()
    }
}

impl StreamTimers for ManualTimers {
    fn set_timer(&self, _delay: Duration, callback: TimerCallback) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.queue.lock().expect("таймеры").push_back((id, callback));
        TimerId(id)
    }

    fn clear_timer(&self, timer: TimerId) {
        self.queue.lock().expect("таймеры").retain(|(id, _)| *id != timer.0);
    }
}

struct ConnectionState {
    id: String,
    closed: AtomicBool,
}

#[derive(Clone)]
struct Connection(Arc<ConnectionState>);

impl Connection {
    fn new(id: &str) -> Self {
        Self(Arc::new(ConnectionState { id: id.into(), closed: AtomicBool::new(false) }))
    }
}

impl NarrationConnection for Connection {
    fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::SeqCst)
    }
}

/// Развернуть строки, свёрнутые генератором: `"\u0000repeat:<символ>:<число>"`.
fn unfold(value: &mut Value) {
    match value {
        Value::String(text) => {
            if let Some(rest) = text.strip_prefix("\u{0}repeat:") {
                let (symbol, count) = rest.rsplit_once(':').expect("свёртка");
                *text = symbol.repeat(count.parse().expect("число"));
            }
        }
        Value::Array(items) => items.iter_mut().for_each(unfold),
        Value::Object(map) => map.values_mut().for_each(unfold),
        _ => {}
    }
}

fn fixture() -> Value {
    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(fixture_path("narration-stream.json")).expect("эталон")).expect("json");
    unfold(&mut value);
    value
}

fn text_of<'a>(step: &'a Value, key: &str) -> &'a str {
    step.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn check_error(place: &str, error: &NarrationStreamError, expected: &Value) {
    assert_eq!(error.code, expected["code"].as_str().unwrap_or_default(), "{place}: код");
    assert_eq!(error.message, expected["message"].as_str().unwrap_or_default(), "{place}: текст");
}

#[test]
fn hub_matches_js_scenarios() {
    let fixture = fixture();
    let mut operations = 0;
    for case in fixture["hub"].as_array().expect("сценарии") {
        let seed = &case["seed"];
        let campaigns: Arc<Mutex<HashMap<String, Vec<Connection>>>> = Arc::default();
        let emitted: Arc<Mutex<Vec<Value>>> = Arc::default();
        let timers = Arc::new(ManualTimers::default());
        let clock = Arc::new(AtomicI64::new(1_000));
        let hub = {
            let campaigns = Arc::clone(&campaigns);
            let emitted = Arc::clone(&emitted);
            let clock = Arc::clone(&clock);
            CampaignNarrationStream::new(NarrationStreamOptions {
                // Ключ — `String(campaignId).toUpperCase()`, без trim, как в тесте JS.
                connections_for: Box::new(move |campaign| campaigns.lock().expect("кампании").get(&campaign.to_uppercase()).cloned().unwrap_or_default()),
                write: Box::new(move |connection: &Connection, event, payload| {
                    emitted.lock().expect("кадры").push(json!({ "connection": connection.0.id, "event": event, "payload": payload }));
                }),
                coalesce_ms: case["config"]["coalesce_ms"].as_f64(),
                max_active: case["config"].get("max_active").and_then(Value::as_f64),
                timers: Arc::clone(&timers) as Arc<dyn StreamTimers>,
                now: Arc::new(move || clock.load(Ordering::SeqCst)),
            })
        };
        let mut connections: HashMap<String, Connection> = HashMap::new();
        for (index, step) in case["steps"].as_array().expect("шаги").iter().enumerate() {
            operations += 1;
            emitted.lock().expect("кадры").clear();
            let op = step["op"].as_str().expect("операция");
            let campaign = text_of(step, "campaign");
            let message = text_of(step, "message_id");
            let result: Result<Option<Value>, NarrationStreamError> = match op {
                "connect" => {
                    let connection = Connection::new(text_of(step, "id"));
                    connections.insert(text_of(step, "id").into(), connection.clone());
                    campaigns.lock().expect("кампании").entry(campaign.to_uppercase()).or_default().push(connection);
                    Ok(None)
                }
                "close" => {
                    if let Some(connection) = connections.get(text_of(step, "id")) {
                        connection.0.closed.store(true, Ordering::SeqCst);
                    }
                    Ok(None)
                }
                "start" => hub.start(campaign, message).map(Some),
                "progress" => hub.progress(campaign, message, text_of(step, "text")).map(|_| None),
                "tick" => {
                    clock.fetch_add(step["ms"].as_i64().expect("мс"), Ordering::SeqCst);
                    Ok(None)
                }
                "flush" => {
                    timers.flush();
                    Ok(None)
                }
                "fire_one" => {
                    timers.fire_one();
                    Ok(None)
                }
                "complete" => hub
                    .complete(campaign, message, text_of(step, "text"), step.get("phase").and_then(Value::as_str), sk_core::js::truthy(step.get("replayed")))
                    .map(Some),
                "abort" => hub.abort(campaign, message).map(Some),
                "replay" => {
                    let connection = connections.get(text_of(step, "id")).cloned().unwrap_or_else(|| Connection::new(text_of(step, "id")));
                    hub.replay(campaign, &connection).map(|_| None)
                }
                "active_count" => hub.active_count(campaign).map(|count| Some(Value::from(count))),
                other => panic!("неизвестная операция {other}"),
            };
            let place = format!("поток, seed {seed}, шаг {index} ({op})");
            match (&result, step.get("error")) {
                (Err(error), Some(expected)) => check_error(&place, error, expected),
                (Err(error), None) => panic!("{place}: Rust отказал {error:?}, JS — нет"),
                (Ok(_), Some(expected)) => panic!("{place}: JS отказал {expected}, Rust — нет"),
                (Ok(value), None) => {
                    if let Some(expected) = step.get("result") {
                        assert!(same_json(value.as_ref().unwrap_or(&Value::Null), expected), "{place}: результат {value:?} вместо {expected}");
                    }
                }
            }
            let events = Value::Array(emitted.lock().expect("кадры").clone());
            assert!(same_json(&events, &step["events"]), "{place}: кадры {events} вместо {}", step["events"]);
            assert_eq!(timers.len() as u64, step["timers"].as_u64().expect("таймеры"), "{place}: таймеры");
        }
    }
    assert!(operations > 2000, "эталон слишком мал: {operations}");
}

#[derive(Default)]
struct SocketState {
    ready: Option<bool>,
    closed: bool,
    chunks: Vec<String>,
    closes: Vec<String>,
}

#[test]
fn outbox_matches_js_scenarios() {
    let fixture = fixture();
    let mut operations = 0;
    for case in fixture["outbox"].as_array().expect("сценарии") {
        let seed = &case["seed"];
        let steps = case["steps"].as_array().expect("шаги");
        let state = Arc::new(Mutex::new(SocketState { ready: case["config"]["ready"].as_bool(), ..SocketState::default() }));
        let mut outbox = {
            let writer = Arc::clone(&state);
            let closer = Arc::clone(&state);
            CampaignStreamOutbox::new(
                Box::new(move |chunk| {
                    let mut socket = writer.lock().expect("сокет");
                    if socket.closed {
                        return None;
                    }
                    socket.chunks.push(chunk.to_string());
                    socket.ready
                }),
                case["config"].get("max_pending").and_then(Value::as_f64),
                Some(Box::new(move |reason, _| {
                    let mut socket = closer.lock().expect("сокет");
                    socket.closed = true;
                    socket.closes.push(reason.as_str().into());
                })),
            )
        };
        for (index, step) in steps.iter().enumerate() {
            operations += 1;
            let (chunks_before, closes_before) = {
                let socket = state.lock().expect("сокет");
                (socket.chunks.len(), socket.closes.len())
            };
            let op = step["op"].as_str().expect("операция");
            let place = format!("очередь, seed {seed}, шаг {index} ({op})");
            match op {
                "send" => {
                    let event = step["event"].as_str().expect("событие").to_string();
                    let payload = step["payload"].clone();
                    let mode = step["render"].as_str().expect("сборка").to_string();
                    let result = outbox.send(
                        step["key"].as_str(),
                        Box::new(move || match mode.as_str() {
                            "throw" => Err("проекция не собралась".into()),
                            "null" => Ok(None),
                            _ => Ok(Some(format!("event: {event}\ndata: {}\n\n", serde_json::to_string(&payload).expect("json")))),
                        }),
                    );
                    match (result, step.get("error")) {
                        (Err(error), Some(expected)) => {
                            assert_eq!(expected["code"], "Error", "{place}: имя");
                            assert_eq!(error.to_string(), expected["message"].as_str().unwrap_or_default(), "{place}: текст");
                        }
                        (Ok(written), None) => assert_eq!(written.map_or(Value::Null, Value::Bool), step["result"], "{place}: результат"),
                        (actual, expected) => panic!("{place}: {actual:?} против {expected:?}"),
                    }
                }
                "ready" => state.lock().expect("сокет").ready = step["value"].as_bool(),
                "drain" => outbox.drain(),
                "discard" => outbox.discard(),
                other => panic!("неизвестная операция {other}"),
            }
            let socket = state.lock().expect("сокет");
            assert_eq!(Value::from(socket.chunks[chunks_before..].to_vec()), step["chunks"], "{place}: кадры");
            assert_eq!(Value::from(socket.closes[closes_before..].to_vec()), step["closes"], "{place}: закрытия");
            assert_eq!(outbox.pending_count() as u64, step["pending"].as_u64().expect("очередь"), "{place}: очередь");
        }
    }
    assert!(operations > 2000, "эталон слишком мал: {operations}");
}

#[test]
fn frame_keys_match_js() {
    let fixture = fixture();
    let cases = fixture["frame_keys"].as_array().expect("ключи");
    for case in cases {
        let key = campaign_stream_frame_key(case["event"].as_str().expect("событие"), &case["payload"]);
        assert_eq!(key.map_or(Value::Null, Value::String), case["key"], "{case}");
    }
    assert!(cases.len() >= 150);
}
