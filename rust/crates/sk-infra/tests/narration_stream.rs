//! Перенос `test/narration-stream.test.mjs` и проверки таймеров `tokio` и
//! сокета SSE.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sk_infra::narration_stream::{
    campaign_stream_frame_key, sse_socket, CampaignNarrationStream, CampaignStreamOutbox, FrameRender, NarrationConnection, NarrationStreamOptions, OutboxCloseReason, StreamTimers, TimerCallback,
    TimerId, TokioTimers, CAMPAIGN_STREAM_MAX_PENDING_FRAMES, NARRATION_STREAM_EVENT_MAX_BYTES, NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN, NARRATION_STREAM_TEXT_MAX_BYTES,
};

#[derive(Default)]
struct ManualTimers {
    next: AtomicU64,
    queue: Mutex<VecDeque<(u64, TimerCallback)>>,
}

impl ManualTimers {
    fn flush(&self) {
        loop {
            let next = self.queue.lock().expect("таймеры").pop_front();
            match next {
                Some((_, callback)) => callback(),
                None => break,
            }
        }
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

#[derive(Clone)]
struct Connection {
    id: String,
    closed: Arc<AtomicBool>,
}

impl NarrationConnection for Connection {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

type Write = Box<dyn Fn(&Connection, &str, &Value) + Send + Sync>;

struct Harness {
    hub: CampaignNarrationStream<Connection>,
    events: Arc<Mutex<Vec<Value>>>,
    campaigns: Arc<Mutex<HashMap<String, Vec<Connection>>>>,
    manual: Option<Arc<ManualTimers>>,
}

impl Harness {
    fn connect(&self, campaign: &str, id: &str) -> Connection {
        let connection = Connection { id: id.into(), closed: Arc::new(AtomicBool::new(false)) };
        self.campaigns.lock().expect("кампании").entry(campaign.to_uppercase()).or_default().push(connection.clone());
        connection
    }

    fn flush(&self) {
        self.manual.as_ref().expect("ручные таймеры").flush();
    }

    fn events(&self) -> Vec<Value> {
        self.events.lock().expect("кадры").clone()
    }
}

fn harness_with(write: Option<Write>, max_active: Option<f64>, timers: Option<Arc<dyn StreamTimers>>) -> Harness {
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let campaigns: Arc<Mutex<HashMap<String, Vec<Connection>>>> = Arc::default();
    let manual = Arc::new(ManualTimers::default());
    let (timers, manual) = match timers {
        Some(timers) => (timers, None),
        None => (Arc::clone(&manual) as Arc<dyn StreamTimers>, Some(manual)),
    };
    let recorder = Arc::clone(&events);
    let write = write.unwrap_or_else(|| {
        Box::new(move |connection: &Connection, event: &str, payload: &Value| {
            recorder.lock().expect("кадры").push(json!({ "connection": connection.id, "event": event, "payload": payload }));
        })
    });
    let lookup = Arc::clone(&campaigns);
    let hub = CampaignNarrationStream::new(NarrationStreamOptions {
        connections_for: Box::new(move |campaign| lookup.lock().expect("кампании").get(&campaign.to_uppercase()).cloned().unwrap_or_default()),
        write,
        coalesce_ms: Some(50.0),
        max_active,
        timers,
        now: Arc::new(sk_core::clock::now_ms),
    });
    Harness { hub, events, campaigns, manual }
}

fn harness() -> Harness {
    harness_with(None, None, None)
}

#[test]
fn stream_coalesces_deltas_into_full_public_snapshot() {
    let harness = harness();
    harness.connect("alpha", "viewer");
    harness.hub.start("alpha", "narration-safe").expect("начало");
    harness.hub.progress("alpha", "narration-safe", "Первое.").expect("дельта");
    harness.hub.progress("alpha", "narration-safe", "Первое. Второе.").expect("дельта");
    harness.flush();
    harness.hub.complete("alpha", "narration-safe", "Первое. Второе.", Some("complete"), false).expect("финал");
    let events = harness.events();
    let names: Vec<&str> = events.iter().map(|entry| entry["event"].as_str().expect("событие")).collect();
    assert_eq!(names, ["narration.start", "narration.chunk", "narration.complete"]);
    assert_eq!(events[1]["payload"]["text"], "Первое. Второе.");
    let mut keys: Vec<&String> = events[1]["payload"].as_object().expect("кадр").keys().collect();
    keys.sort();
    assert_eq!(keys, ["message_id", "phase", "replace", "replayed", "text"]);
    assert!(events[1]["payload"].to_string().len() <= NARRATION_STREAM_EVENT_MAX_BYTES);
}

#[test]
fn reconnect_gets_latest_snapshot_of_its_own_campaign_only() {
    let harness = harness();
    harness.connect("alpha", "first");
    harness.connect("beta", "other-campaign");
    harness.hub.start("alpha", "narration-reconnect").expect("начало");
    harness.hub.progress("alpha", "narration-reconnect", "Уже проверено.").expect("дельта");
    let reconnect = harness.connect("alpha", "reconnect");
    harness.hub.replay("alpha", &reconnect).expect("повтор");
    let events = harness.events();
    let replay = events.iter().find(|entry| entry["connection"] == "reconnect").expect("снимок");
    assert_eq!(replay["event"], "narration.chunk");
    assert_eq!(replay["payload"]["text"], "Уже проверено.");
    assert!(!events.iter().any(|entry| entry["connection"] == "other-campaign"));
}

#[test]
fn backpressure_keeps_only_latest_snapshot_of_each_message() {
    // Аудит PR #131, SEC-06: снимки повествования схлопывает общая очередь
    // соединения (`CampaignStreamOutbox`), та же, что держит `room` и `presence`.
    let written: Arc<Mutex<Vec<Value>>> = Arc::default();
    let ready = Arc::new(AtomicBool::new(false));
    let socket_ready = Arc::clone(&ready);
    let outbox = Arc::new(Mutex::new(CampaignStreamOutbox::new(Box::new(move |_| Some(socket_ready.load(Ordering::SeqCst))), None, None)));
    let target = Arc::clone(&outbox);
    let record = Arc::clone(&written);
    let harness = harness_with(
        Some(Box::new(move |connection: &Connection, event: &str, payload: &Value| {
            let (connection, event, payload) = (connection.id.clone(), event.to_string(), payload.clone());
            let record = Arc::clone(&record);
            let key = campaign_stream_frame_key(&event, &payload);
            let render: FrameRender = Box::new(move || {
                let chunk = format!("event: {event}\n\n");
                record.lock().expect("запись").push(json!({ "connection": connection, "event": event, "payload": payload }));
                Ok(Some(chunk))
            });
            target.lock().expect("очередь").send(key.as_deref(), render).expect("кадр");
        })),
        None,
        None,
    );
    harness.connect("alpha", "slow");
    harness.hub.start("alpha", "narration-slow").expect("начало");
    harness.hub.progress("alpha", "narration-slow", "Первое.").expect("дельта");
    harness.flush();
    harness.hub.progress("alpha", "narration-slow", "Первое. Второе.").expect("дельта");
    harness.flush();
    assert_eq!(written.lock().expect("запись").len(), 1, "start уже принят сокетом, следующие снимки объединены");
    assert_eq!(outbox.lock().expect("очередь").pending_count(), 1);
    ready.store(true, Ordering::SeqCst);
    outbox.lock().expect("очередь").drain();
    let written = written.lock().expect("запись");
    assert_eq!(written.len(), 2);
    assert_eq!(written[1]["payload"]["text"], "Первое. Второе.");
    assert_eq!(outbox.lock().expect("очередь").pending_count(), 0);
}

// ---------------------------------------------------------------------------
// Очередь соединения (аудит PR #131, SEC-06)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct SocketState {
    ready: bool,
    closed: bool,
    chunks: Vec<String>,
    close_reasons: Vec<&'static str>,
}

struct Socket {
    outbox: CampaignStreamOutbox,
    state: Arc<Mutex<SocketState>>,
    renders: Arc<AtomicU64>,
}

impl Socket {
    fn new(ready: bool) -> Self {
        let state = Arc::new(Mutex::new(SocketState { ready, ..SocketState::default() }));
        let writer = Arc::clone(&state);
        let closer = Arc::clone(&state);
        let outbox = CampaignStreamOutbox::new(
            Box::new(move |chunk| {
                let mut state = writer.lock().expect("сокет");
                if state.closed {
                    return None;
                }
                state.chunks.push(chunk.to_string());
                Some(state.ready)
            }),
            None,
            Some(Box::new(move |reason, _| {
                let mut state = closer.lock().expect("сокет");
                state.closed = true;
                state.close_reasons.push(reason.as_str());
            })),
        );
        Self { outbox, state, renders: Arc::default() }
    }

    fn send(&mut self, event: &str, payload: Value) -> Option<bool> {
        let key = campaign_stream_frame_key(event, &payload);
        let renders = Arc::clone(&self.renders);
        let event = event.to_string();
        self.outbox
            .send(
                key.as_deref(),
                Box::new(move || {
                    renders.fetch_add(1, Ordering::SeqCst);
                    Ok(Some(format!("event: {event}\ndata: {payload}\n\n")))
                }),
            )
            .expect("кадр")
    }

    fn frames(&self) -> Vec<(Option<String>, Value)> {
        self.state
            .lock()
            .expect("сокет")
            .chunks
            .iter()
            .map(|chunk| {
                let event = chunk.lines().find_map(|line| line.strip_prefix("event: ")).map(String::from);
                let payload = chunk.lines().find_map(|line| line.strip_prefix("data: ")).map(|data| serde_json::from_str(data).expect("json")).unwrap_or(Value::Null);
                (event, payload)
            })
            .collect()
    }

    fn set_ready(&self, ready: bool) {
        self.state.lock().expect("сокет").ready = ready;
    }

    fn close_reasons(&self) -> Vec<&'static str> {
        self.state.lock().expect("сокет").close_reasons.clone()
    }
}

#[test]
fn fast_stream_is_unchanged_every_frame_goes_out_in_order() {
    let mut socket = Socket::new(true);
    assert_eq!(socket.send("room", json!({ "version": 1 })), Some(true));
    assert_eq!(socket.send("presence", json!({ "typing_actor_ids": ["hero"] })), Some(true));
    assert_eq!(socket.send("room", json!({ "version": 2 })), Some(true));
    assert_eq!(socket.send("narration.chunk", json!({ "message_id": "narration-a", "text": "Текст" })), Some(true));
    assert_eq!(socket.send("room", json!({ "version": 3 })), Some(true));
    let frames: Vec<(String, Value)> = socket
        .frames()
        .into_iter()
        .map(|(event, payload)| (event.expect("событие"), payload.get("version").or(payload.get("text")).or(payload.get("typing_actor_ids")).cloned().expect("поле")))
        .collect();
    assert_eq!(
        frames,
        vec![
            ("room".into(), json!(1)),
            ("presence".into(), json!(["hero"])),
            ("room".into(), json!(2)),
            ("narration.chunk".into(), json!("Текст")),
            ("room".into(), json!(3)),
        ]
    );
    assert_eq!(socket.renders.load(Ordering::SeqCst), 5, "ничего не отложено и не выброшено");
    assert_eq!(socket.outbox.pending_count(), 0);
}

#[test]
fn slow_reader_room_and_presence_collapse_queue_is_bounded() {
    let mut socket = Socket::new(false);
    // Первый кадр сокет принял в свой буфер и сообщил о переполнении.
    assert_eq!(socket.send("room", json!({ "version": 1 })), Some(false));
    for version in 2..=200 {
        socket.send("room", json!({ "version": version }));
        socket.send("presence", json!({ "typing_actor_ids": [format!("hero-{version}")] }));
        socket.outbox.send(Some("heartbeat"), Box::new(|| Ok(Some(": heartbeat\n\n".into())))).expect("пульс");
    }
    assert_eq!(socket.frames().len(), 1, "пока сокет занят, в него ничего не пишется");
    assert_eq!(socket.outbox.pending_count(), 3, "одна комната, одно присутствие, один пульс — сколько бы ни набежало");
    assert_eq!(socket.renders.load(Ordering::SeqCst), 1, "промежуточные кадры даже не собирались");
    // Сокет освободился: уходит последнее состояние, промежуточные схлопнуты.
    socket.set_ready(true);
    socket.outbox.drain();
    let frames = socket.frames();
    let events: Vec<Option<&str>> = frames.iter().map(|(event, _)| event.as_deref()).collect();
    assert_eq!(events, [Some("room"), Some("room"), Some("presence"), None]);
    assert_eq!(frames[1].1["version"], 200);
    assert_eq!(frames[2].1["typing_actor_ids"], json!(["hero-200"]));
    assert_eq!(socket.outbox.pending_count(), 0);
    assert!(socket.close_reasons().is_empty());
}

#[test]
fn drain_on_busy_socket_sends_one_and_waits_for_next() {
    let mut socket = Socket::new(false);
    socket.send("room", json!({ "version": 1 }));
    socket.send("room", json!({ "version": 2 }));
    socket.send("narration.complete", json!({ "message_id": "narration-a", "text": "Готово." }));
    socket.outbox.drain();
    assert_eq!(socket.frames().len(), 2, "после записи, вернувшей false, очередь снова ждёт");
    assert_eq!(socket.frames()[1].1["version"], 2);
    assert_eq!(socket.outbox.pending_count(), 1);
    socket.set_ready(true);
    socket.outbox.drain();
    assert_eq!(socket.frames()[2].1["text"], "Готово.");
}

#[test]
fn frame_is_rendered_at_write_time_against_sent_map_hash() {
    // Схлопывание не должно оставить клиенту хеш карты, которую тот не получил:
    // поэтому кадр комнаты строится при записи, относительно `mapHash`,
    // который соединение действительно отправило.
    let mut socket = Socket::new(false);
    let sent_hash = Arc::new(Mutex::new(String::new()));
    let room = |socket: &mut Socket, version: i64, map_hash: &'static str| {
        let sent_hash = Arc::clone(&sent_hash);
        socket
            .outbox
            .send(
                Some("room"),
                Box::new(move || {
                    let mut current = sent_hash.lock().expect("хеш");
                    let map = if *current == map_hash { "unchanged" } else { "full" };
                    *current = map_hash.to_string();
                    Ok(Some(format!("event: room\ndata: {}\n\n", json!({ "version": version, "map": map, "map_hash": map_hash }))))
                }),
            )
            .expect("кадр");
    };
    room(&mut socket, 1, "map-a");
    room(&mut socket, 2, "map-b");
    room(&mut socket, 3, "map-b");
    assert_eq!(*sent_hash.lock().expect("хеш"), "map-a", "хеш не продвинут кадром, который ещё не ушёл");
    socket.set_ready(true);
    socket.outbox.drain();
    let sent: Vec<Value> = socket.frames().into_iter().map(|(_, payload)| payload).collect();
    assert_eq!(sent.iter().map(|payload| payload["version"].clone()).collect::<Vec<_>>(), [json!(1), json!(3)]);
    assert_eq!(sent[1]["map"], "full", "вторая карта ушла целиком: промежуточный кадр с ней выброшен");
    assert_eq!(*sent_hash.lock().expect("хеш"), "map-b");
}

#[test]
fn client_that_never_reads_is_closed_instead_of_piling_frames() {
    let mut socket = Socket::new(false);
    socket.send("room", json!({ "version": 1 }));
    for index in 0..CAMPAIGN_STREAM_MAX_PENDING_FRAMES {
        socket.send("narration.complete", json!({ "message_id": format!("narration-{index}"), "text": "Канонический текст." }));
    }
    assert!(socket.outbox.pending_count() <= CAMPAIGN_STREAM_MAX_PENDING_FRAMES);
    assert!(socket.close_reasons().is_empty());
    socket.send("narration.complete", json!({ "message_id": "narration-overflow", "text": "Ещё один." }));
    assert_eq!(socket.close_reasons(), ["overflow"], "переподключение получит полное состояние рукопожатием");
    assert_eq!(socket.outbox.pending_count(), 0, "память очереди освобождена");
    assert_eq!(socket.send("room", json!({ "version": 2 })), None, "закрытое соединение больше ничего не принимает");
    assert_eq!(socket.outbox.pending_count(), 0);
}

#[test]
fn access_revocation_discards_unread_and_render_error_on_drain_does_not_crash() {
    let mut revoked = Socket::new(false);
    revoked.send("room", json!({ "version": 1 }));
    revoked.send("room", json!({ "version": 2, "secret": "собрано под прежними правами" }));
    revoked.outbox.discard();
    revoked.set_ready(true);
    revoked.outbox.drain();
    assert_eq!(revoked.frames().len(), 1);
    assert!(!format!("{:?}", revoked.frames()).contains("прежними правами"));

    let mut broken = Socket::new(false);
    broken.send("room", json!({ "version": 1 }));
    broken.outbox.send(Some("room"), Box::new(|| Err("проекция не собралась".into()))).expect("в очереди");
    broken.set_ready(true);
    broken.outbox.drain();
    assert_eq!(broken.close_reasons(), ["render_failed"]);
    assert_eq!(OutboxCloseReason::RenderFailed.as_str(), "render_failed");
}

#[test]
fn frame_key_room_presence_heartbeat_and_own_message_snapshot() {
    assert_eq!(campaign_stream_frame_key("room", &json!({})).as_deref(), Some("room"));
    assert_eq!(campaign_stream_frame_key("presence", &json!({})).as_deref(), Some("presence"));
    assert_eq!(campaign_stream_frame_key("narration.chunk", &json!({ "message_id": "a" })).as_deref(), Some("narration:a"));
    assert_eq!(campaign_stream_frame_key("narration.complete", &json!({ "message_id": "a" })).as_deref(), Some("narration:a"));
    assert_eq!(campaign_stream_frame_key("narration.chunk", &json!({ "message_id": "b" })).as_deref(), Some("narration:b"));
    assert_eq!(campaign_stream_frame_key("access", &json!({ "status": "revoked" })), None);
}

#[test]
fn active_buffers_and_utf8_text_have_hard_limits() {
    let harness = harness_with(None, Some(2.0), None);
    harness.connect("alpha", "viewer");
    harness.hub.start("alpha", "narration-1").expect("1");
    harness.hub.start("alpha", "narration-2").expect("2");
    harness.hub.start("alpha", "narration-3").expect("3");
    assert_eq!(harness.hub.active_count("alpha").expect("счёт"), 2);
    assert!(!harness.events().iter().any(|entry| entry["payload"]["phase"] == "aborted"), "вытеснение process-local preview не отменяет саму генерацию");
    let error = harness.hub.progress("alpha", "narration-2", &"я".repeat(NARRATION_STREAM_TEXT_MAX_BYTES.div_ceil(2) + 1)).expect_err("предел");
    assert_eq!(error.code, "NARRATION_STREAM_TOO_LARGE");
    assert_eq!(NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN, 16);
}

#[test]
fn final_supports_complete_replaced_and_replayed_without_start() {
    let harness = harness();
    harness.connect("alpha", "viewer");
    harness.hub.complete("alpha", "narration-replay", "Канонический текст.", Some("complete"), true).expect("повтор");
    harness.hub.start("alpha", "narration-replaced").expect("начало");
    harness.hub.complete("alpha", "narration-replaced", "Безопасная замена.", Some("replaced"), false).expect("замена");
    let events = harness.events();
    let names: Vec<&str> = events.iter().map(|entry| entry["event"].as_str().expect("событие")).collect();
    assert_eq!(names, ["narration.complete", "narration.start", "narration.complete"]);
    assert_eq!(events[0]["payload"]["replayed"], true);
    assert_eq!(events[2]["payload"]["phase"], "replaced");
}

// Снимок, который в кадре SSE выходит за 16 КБ (кавычки и управляющие
// символы удваиваются при экранировании), отклоняется самим `progress`, как
// в JS после исправления: у клиента остаётся прежний текст до финала, а
// финал по-прежнему отказывает явно.
#[test]
fn oversized_escaped_snapshot_is_refused_to_caller() {
    let harness = harness();
    harness.connect("alpha", "viewer");
    harness.hub.start("alpha", "narration-quotes").expect("начало");
    harness.hub.progress("alpha", "narration-quotes", "Первое.").expect("дельта");
    let quotes = "\"".repeat(NARRATION_STREAM_TEXT_MAX_BYTES - 100);
    assert_eq!(harness.hub.progress("alpha", "narration-quotes", &quotes).expect_err("кадр велик").code, "NARRATION_STREAM_EVENT_TOO_LARGE");
    harness.flush();
    let texts: Vec<Value> = harness.events().iter().map(|entry| json!([entry["event"], entry["payload"]["text"]])).collect();
    assert_eq!(texts, vec![json!(["narration.start", ""]), json!(["narration.chunk", "Первое."])]);
    assert_eq!(harness.hub.complete("alpha", "narration-quotes", &quotes, None, false).expect_err("финал").code, "NARRATION_STREAM_EVENT_TOO_LARGE");
}

#[test]
fn repeated_start_cancels_pending_snapshot_of_old_text() {
    let harness = harness();
    harness.connect("alpha", "viewer");
    harness.hub.start("alpha", "narration-again").expect("начало");
    harness.hub.progress("alpha", "narration-again", "Старый текст.").expect("дельта");
    harness.hub.start("alpha", "narration-again").expect("повторное начало");
    harness.flush();
    harness.hub.progress("alpha", "narration-again", "Новый текст.").expect("дельта");
    harness.flush();
    let texts: Vec<Value> = harness.events().iter().map(|entry| json!([entry["event"], entry["payload"]["text"]])).collect();
    assert_eq!(texts, vec![json!(["narration.start", ""]), json!(["narration.start", ""]), json!(["narration.chunk", "Новый текст."])]);
}

// ---------------------------------------------------------------------------
// tokio
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tokio_timers_coalesce_and_complete_cancels_pending_snapshot() {
    let timers: Arc<dyn StreamTimers> = Arc::new(TokioTimers::current().expect("среда tokio"));
    let harness = harness_with(None, None, Some(timers));
    harness.connect("alpha", "viewer");
    harness.hub.start("alpha", "narration-live").expect("начало");
    harness.hub.progress("alpha", "narration-live", "Раз.").expect("дельта");
    harness.hub.progress("alpha", "narration-live", "Раз. Два.").expect("дельта");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let events = harness.events();
    assert_eq!(events.len(), 2, "один схлопнутый снимок за окно: {events:?}");
    assert_eq!(events[1]["payload"]["text"], "Раз. Два.");
    // Финал отменяет ещё не ушедший снимок.
    harness.hub.progress("alpha", "narration-live", "Раз. Два. Три.").expect("дельта");
    harness.hub.complete("alpha", "narration-live", "Раз. Два. Три.", None, false).expect("финал");
    tokio::time::sleep(Duration::from_millis(150)).await;
    let names: Vec<String> = harness.events().iter().map(|entry| entry["event"].as_str().expect("событие").to_string()).collect();
    assert_eq!(names, ["narration.start", "narration.chunk", "narration.complete"]);
}

#[tokio::test]
async fn sse_socket_slow_reader_does_not_pile_frames() {
    let (socket, mut reader) = sse_socket(2);
    let outbox = Arc::new(Mutex::new(CampaignStreamOutbox::new(Box::new(move |chunk| socket.write(chunk)), None, None)));
    let drained = Arc::clone(&outbox);
    reader.set_on_drain(Box::new(move || drained.lock().expect("очередь").drain()));
    let send = |version: i64| {
        outbox.lock().expect("очередь").send(Some("room"), Box::new(move || Ok(Some(format!("event: room\ndata: {}\n\n", json!({ "version": version })))))).expect("кадр")
    };
    assert_eq!(send(1), Some(true));
    assert_eq!(send(2), Some(false), "второй кадр заполнил буфер сокета");
    for version in 3..=500 {
        assert_eq!(send(version), Some(false));
    }
    assert_eq!(outbox.lock().expect("очередь").pending_count(), 1, "медленный читатель держит одну комнату, а не 498");
    let mut received = Vec::new();
    for _ in 0..3 {
        received.push(reader.recv().await.expect("кадр"));
    }
    assert!(received[0].contains("\"version\":1"));
    assert!(received[1].contains("\"version\":2"));
    assert!(received[2].contains("\"version\":500"), "после drain уходит последнее состояние");
    assert_eq!(outbox.lock().expect("очередь").pending_count(), 0);
    reader.close();
    assert_eq!(send(501), None, "закрытый сокет записи не принимает");
}
