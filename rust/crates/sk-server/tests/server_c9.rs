//! С9: живой поток и присутствие по настоящему HTTP — смысл контрактных
//! `stream-live-access-api`, `stream-backpressure-api`,
//! `stream-viewer-isolation-api` (их маршруты создания кампании и коммитов
//! ещё не перенесены, поэтому кампания и «коммиты» здесь — запись комнаты в
//! ядре: хук «проекция записана» рассылает её так же, как после хода):
//!
//! - рукопожатие: 401/403/404, заголовки SSE, `retry: 2000`, кадр `id/event/data`;
//! - logout закрывает поток только этой сессии, истечение — на ближайшей
//!   рассылке, и присутствие его уже не считает;
//! - смена героев администратором перестраивает проекцию сразу, потеря
//!   доступа закрывает поток кадром `access`;
//! - каждый зритель видит только своё;
//! - клиент, который не читает: комнаты схлопываются, очередь ограничена,
//!   переполнение закрывает поток;
//! - пульс и сверка тихого потока на пульсе;
//! - индикатор ввода и уход соединения из присутствия.

mod kit;

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sk_server::room;
use sk_server::streams::LiveOptions;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use kit::{Client, Options, Req, TestServer};

const WAIT: Duration = Duration::from_secs(15);

async fn live_server(heartbeat: Duration) -> TestServer {
    TestServer::start_with(Options { live_streams: Some(LiveOptions { heartbeat }), ..Options::default() }).await
}

async fn server() -> TestServer {
    live_server(Duration::from_secs(60)).await
}

// --- кампания и «коммиты» -----------------------------------------------------

fn hero(id: &str, name: &str, origin: &str) -> Value {
    json!({
        "id": id, "character": name, "name": name, "hp": 12, "maxHp": 12, "armor": 10, "speed": 30, "proficiency": 2,
        "abilities": { "str": 14, "dex": 12, "con": 14, "int": 10, "wis": 10, "cha": 10 },
        "inventory": [{ "id": format!("{id}-blade"), "catalog_id": "srd_5_2_1:longsword", "name": format!("{name}: клинок"),
            "type": "weapon", "quantity": 1, "weight": 3, "origin": origin, "equipped": false }],
    })
}

/// Кампания без записей о членстве: доступ даёт `user.heroIds`. Происхождение
/// вещи — приватное поле: своё видно, чужое проекция вырезает.
fn legacy_state(code: &str) -> Value {
    json!({
        "sessionCode": code, "campaign": format!("Живой доступ {code}"), "partyName": "Двое",
        "activePlayerId": "hero-1", "partyMemberIds": ["hero-1", "hero-2"], "messages": [],
        "players": [hero("hero-1", "Первый", "stolen"), hero("hero-2", "Второй", "found")],
        "scene": { "title": "Зал", "location": "Зал", "mood": "", "objective": "", "turn": 1, "cells": [] },
        "adventure": { "chapter": 1, "visitedLocations": ["Зал"], "history": [] },
        "ruleset_id": "srd_5_2_1", "ruleset_version": "5.2.1", "enabled_rule_packs": ["srd_5_2_1"],
        "state_version": 0,
    })
}

/// Записать комнату (первая запись — создание): хук рассылает её потокам.
async fn save(server: &TestServer, code: &str, change: impl FnOnce(Option<Value>) -> Value + Send + 'static) -> i64 {
    let code = code.to_string();
    server
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                let current = room::get_room(&core, &code).expect("комната");
                let next = change(current.state.clone());
                let saved = room::save_room(&core, &code, &next, current.version).expect("запись комнаты");
                assert!(!saved.conflict, "конфликт версии комнаты");
                saved.room.version
            })
        })
        .await
        .expect("ядро")
}

async fn create(server: &TestServer, state: Value) -> i64 {
    let code = state["sessionCode"].as_str().unwrap_or_default().to_string();
    save(server, &code, move |_| state).await
}

/// «Коммит»: следующий ход сцены.
async fn bump(server: &TestServer, code: &str) -> i64 {
    save(server, code, |state| {
        let mut state = state.unwrap_or_default();
        let turn = state["scene"]["turn"].as_i64().unwrap_or(0);
        state["scene"]["turn"] = json!(turn + 1);
        state
    })
    .await
}

async fn connections(server: &TestServer, code: &str) -> Vec<Value> {
    let code = code.to_string();
    server.state.core.call(move |core| Box::pin(async move { core.streams.live().map(|live| live.connection_infos(&code)).unwrap_or_default() })).await.expect("ядро")
}

async fn assign(admin: &mut Client, user: &Value, heroes: Value) {
    let path = format!("/api/admin/users/{}", user["id"].as_str().unwrap_or_default());
    let updated = admin.patch(&path, &json!({ "heroIds": heroes })).await;
    assert_eq!(updated.status, 200, "{}", updated.text());
}

fn cookie(client: &Client) -> String {
    format!("skazanie_session={}", client.session().unwrap_or_default())
}

// --- клиент SSE ---------------------------------------------------------------

#[derive(Debug, Clone)]
struct Event {
    id: Option<u64>,
    event: String,
    data: Value,
}

/// Поток SSE поверх сырого сокета: разбор `chunked` и блоков по мере чтения.
struct Sse {
    stream: TcpStream,
    raw: Vec<u8>,
    body: Vec<u8>,
    events: VecDeque<Event>,
    comments: Vec<String>,
    retry: Option<String>,
    headers: Vec<(String, String)>,
    /// Тело кончилось завершающим куском (`res.end()`).
    ended: bool,
    /// Соединение закрыто (конец тела, сброс).
    done: bool,
    room_bytes: usize,
    rooms: Vec<i64>,
}

/// Отказ рукопожатия: статус и тело JSON.
#[derive(Debug)]
struct Refused {
    status: u16,
    body: Value,
}

async fn connect(addr: SocketAddr, small_buffer: bool) -> TcpStream {
    let socket = tokio::net::TcpSocket::new_v4().expect("сокет");
    if small_buffer {
        // Медленный читатель: маленький буфер приёма, чтобы сокет сервера
        // упёрся быстрее.
        socket.set_recv_buffer_size(16 * 1024).expect("буфер");
    }
    socket.connect(addr).await.expect("соединение")
}

impl Sse {
    async fn open(addr: SocketAddr, code: &str, cookie: &str) -> Result<Self, Refused> {
        Self::open_with(addr, code, cookie, false).await
    }

    async fn open_with(addr: SocketAddr, code: &str, cookie: &str, small_buffer: bool) -> Result<Self, Refused> {
        let mut stream = connect(addr, small_buffer).await;
        let mut head = format!("GET /api/campaigns/{code}/stream HTTP/1.1\r\nhost: {addr}\r\naccept: text/event-stream\r\n");
        if !cookie.is_empty() {
            head.push_str(&format!("cookie: {cookie}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.expect("запрос");
        let mut raw = Vec::new();
        let split = loop {
            if let Some(split) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
                break split;
            }
            let mut chunk = [0u8; 1024];
            let read = tokio::time::timeout(WAIT, stream.read(&mut chunk)).await.expect("заголовки за срок").expect("чтение");
            assert!(read > 0, "сервер закрыл соединение до заголовков");
            raw.extend_from_slice(&chunk[..read]);
        };
        let text = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = text.split("\r\n");
        let status: u16 = lines.next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse().ok()).unwrap_or(0);
        let headers: Vec<(String, String)> = lines.filter_map(|line| line.split_once(':').map(|(key, value)| (key.trim().to_lowercase(), value.trim().to_string()))).collect();
        let rest = raw[split + 4..].to_vec();
        if status != 200 {
            let length: usize = headers.iter().find(|(key, _)| key == "content-length").and_then(|(_, value)| value.parse().ok()).unwrap_or(0);
            let mut body = rest;
            while body.len() < length {
                let mut chunk = [0u8; 1024];
                let read = tokio::time::timeout(WAIT, stream.read(&mut chunk)).await.expect("тело отказа").expect("чтение");
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..read]);
            }
            return Err(Refused { status, body: serde_json::from_slice(&body).unwrap_or(Value::Null) });
        }
        let mut sse = Self { stream, raw: rest, body: Vec::new(), events: VecDeque::new(), comments: Vec::new(), retry: None, headers, ended: false, done: false, room_bytes: 0, rooms: Vec::new() };
        sse.parse();
        Ok(sse)
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// Разобрать накопленное: куски `chunked`, затем блоки SSE.
    fn parse(&mut self) {
        loop {
            let Some(line_end) = self.raw.windows(2).position(|pair| pair == b"\r\n") else { break };
            let size = usize::from_str_radix(String::from_utf8_lossy(&self.raw[..line_end]).trim(), 16).unwrap_or(0);
            if size == 0 {
                self.ended = true;
                self.raw.clear();
                break;
            }
            if self.raw.len() < line_end + 2 + size + 2 {
                break;
            }
            let data = self.raw[line_end + 2..line_end + 2 + size].to_vec();
            self.raw.drain(..line_end + 2 + size + 2);
            self.body.extend_from_slice(&data);
        }
        while let Some(end) = self.body.windows(2).position(|pair| pair == b"\n\n") {
            let block: Vec<u8> = self.body.drain(..end + 2).collect();
            let text = String::from_utf8_lossy(&block[..end]).into_owned();
            let (mut id, mut event, mut data) = (None, String::new(), String::new());
            for line in text.split('\n') {
                if let Some(comment) = line.strip_prefix(':') {
                    self.comments.push(comment.trim().to_string());
                } else if let Some(value) = line.strip_prefix("retry: ") {
                    self.retry = Some(value.to_string());
                } else if let Some(value) = line.strip_prefix("id: ") {
                    id = value.parse().ok();
                } else if let Some(value) = line.strip_prefix("event: ") {
                    event = value.to_string();
                } else if let Some(value) = line.strip_prefix("data: ") {
                    data = value.to_string();
                }
            }
            if !event.is_empty() {
                let payload: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                if event == "room" {
                    self.room_bytes += block.len();
                    self.rooms.push(payload["version"].as_i64().unwrap_or(-1));
                }
                self.events.push_back(Event { id, event, data: payload });
            }
        }
    }

    /// Прочитать ещё из сокета (не дольше `deadline`).
    async fn read_more(&mut self, deadline: Instant) {
        let mut chunk = vec![0u8; 256 * 1024];
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, self.stream.read(&mut chunk)).await {
            Err(_) => panic!("SSE: ничего не пришло за срок"),
            Ok(Ok(0)) | Ok(Err(_)) => self.done = true,
            Ok(Ok(read)) => {
                self.raw.extend_from_slice(&chunk[..read]);
                self.parse();
                if self.ended {
                    self.done = true;
                }
            }
        }
    }

    /// Следующее подходящее событие; `None` — поток закрыт сервером.
    async fn next(&mut self, mut predicate: impl FnMut(&Event) -> bool) -> Option<Event> {
        let deadline = Instant::now() + WAIT;
        loop {
            while let Some(event) = self.events.pop_front() {
                if predicate(&event) {
                    return Some(event);
                }
            }
            if self.done {
                return None;
            }
            self.read_more(deadline).await;
        }
    }

    async fn room(&mut self, mut predicate: impl FnMut(&Value) -> bool) -> Value {
        self.next(|event| event.event == "room" && predicate(&event.data)).await.unwrap_or_else(|| panic!("поток закрылся раньше ожидаемой комнаты")).data
    }

    /// Поток обязан закрыться сервером последним кадром `access` с причиной,
    /// без комнаты новее `max_version` и без кадров после отзыва.
    async fn expect_revoked(&mut self, reason: &str, max_version: i64) {
        let mut access = None;
        let mut after = Vec::new();
        let mut rooms = Vec::new();
        let end = self
            .next(|event| {
                if access.is_some() {
                    after.push(event.event.clone());
                } else if event.event == "access" {
                    access = Some(event.data.clone());
                }
                if event.event == "room" {
                    rooms.push(event.data["version"].as_i64().unwrap_or(-1));
                }
                false
            })
            .await;
        assert!(end.is_none());
        assert_eq!(access, Some(json!({ "status": "revoked", "reason": reason })));
        assert!(after.is_empty(), "после отзыва пришло ещё: {after:?}");
        assert!(rooms.iter().all(|version| *version <= max_version), "отозванный поток получил комнату новее {max_version}: {rooms:?}");
        assert!(self.ended, "отзыв заканчивает тело ответа, а не обрывает его");
    }
}

fn online(room: &Value) -> Value {
    room["state"]["presence"]["online_hero_ids"].clone()
}

fn hero_in<'a>(room: &'a Value, id: &str) -> &'a Value {
    room["state"]["players"].as_array().and_then(|players| players.iter().find(|player| player["id"] == id)).unwrap_or(&Value::Null)
}

// --- тесты ----------------------------------------------------------------------

/// Рукопожатие: отказы JSON до заголовков, затем заголовки SSE, `retry`,
/// первая комната с присутствием (ведущий ведёт весь отряд).
#[tokio::test]
async fn handshake_refusals_headers_and_first_room() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let mut outsider = server.client();
    outsider.register("outsider@mail.ru").await;
    let version = create(&server, legacy_state("LIVHS")).await;

    let anonymous = Sse::open(server.addr, "LIVHS", "").await.err().expect("без входа — отказ");
    assert_eq!((anonymous.status, anonymous.body), (401, json!({ "error": "Нужно войти в аккаунт" })));
    let missing = Sse::open(server.addr, "NOPE", &cookie(&admin)).await.err().expect("нет кампании");
    assert_eq!((missing.status, missing.body), (404, json!({ "error": "Кампания не найдена" })));
    let denied = Sse::open(server.addr, "livhs", &cookie(&outsider)).await.err().expect("чужая кампания");
    assert_eq!((denied.status, denied.body), (403, json!({ "error": "Нет доступа к этой кампании" })));
    let wrong = admin.send(Req::new("POST", "/api/campaigns/LIVHS/stream")).await;
    assert_eq!(wrong.status, 404, "не GET — 404 API");

    let mut stream = Sse::open(server.addr, "livhs", &cookie(&admin)).await.expect("поток ведущего");
    assert_eq!(stream.header("content-type"), Some("text/event-stream; charset=utf-8"));
    assert_eq!(stream.header("cache-control"), Some("no-cache, no-transform"));
    assert_eq!(stream.header("x-accel-buffering"), Some("no"));
    assert_eq!(stream.header("transfer-encoding"), Some("chunked"));
    let first = stream.next(|event| event.event == "room").await.expect("первая комната");
    assert_eq!(stream.retry.as_deref(), Some("2000"));
    assert_eq!(first.data["version"], json!(version));
    assert!(first.data["updatedAt"].is_string());
    assert_eq!(first.data["state"]["presence"], json!({ "transport": "sse", "connected_users": 1, "connected_heroes": 2, "online_hero_ids": ["hero-1", "hero-2"], "typing_actor_ids": [] }));
    assert_eq!(first.data["state"]["turn_clock"], Value::Null);
    let next = bump(&server, "LIVHS").await;
    let second = stream.next(|event| event.event == "room").await.expect("рассылка коммита");
    assert_eq!(second.data["version"], json!(next));
    assert!(second.id > first.id, "номера кадров растут: {:?} → {:?}", first.id, second.id);
    let infos = connections(&server, "LIVHS").await;
    assert_eq!(infos.len(), 1);
    assert!(infos[0]["id"].as_str().is_some_and(|id| id.starts_with(&format!("stream-{}-", std::process::id()))), "{infos:?}");
}

/// Logout закрывает поток только этой сессии; истечение сессии — на
/// ближайшей рассылке, и присутствие уже не считает героя.
#[tokio::test]
async fn logout_and_expiry_close_only_that_session() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, legacy_state("LIVSES")).await;
    let mut first = server.client();
    let first_user = first.register("first@mail.ru").await;
    let mut first_again = server.client();
    first_again.login("first@mail.ru", kit::client::PASSWORD).await;
    let mut second = server.client();
    let second_user = second.register("second@mail.ru").await;
    assign(&mut admin, &first_user, json!(["hero-1"])).await;
    assign(&mut admin, &second_user, json!(["hero-2"])).await;

    let mut first_a = Sse::open(server.addr, "LIVSES", &cookie(&first)).await.expect("первый вход");
    let mut first_b = Sse::open(server.addr, "LIVSES", &cookie(&first_again)).await.expect("второй вход");
    let mut observer = Sse::open(server.addr, "LIVSES", &cookie(&second)).await.expect("наблюдатель");
    for stream in [&mut first_a, &mut first_b, &mut observer] {
        stream.room(|room| online(room) == json!(["hero-1", "hero-2"])).await;
    }

    let before_logout = bump(&server, "LIVSES").await;
    for stream in [&mut first_a, &mut first_b, &mut observer] {
        stream.room(|room| room["version"] == json!(before_logout)).await;
    }
    let logout = first.post("/api/auth/logout", &json!({})).await;
    assert_eq!(logout.status, 200);
    first_a.expect_revoked("session_ended", before_logout).await;
    assert_eq!(first_again.get("/api/auth/me").await.json()["user"]["id"], first_user["id"], "второй вход жив");

    let after_logout = bump(&server, "LIVSES").await;
    let seen = first_b.room(|room| room["version"] == json!(after_logout)).await;
    assert!(online(&seen).as_array().is_some_and(|ids| ids.contains(&json!("hero-1"))), "второй вход того же игрока выпал из присутствия");
    observer.room(|room| room["version"] == json!(after_logout)).await;

    // Истечение: события об этом нет, поток закрывает ближайшая рассылка.
    let token = first_again.session().unwrap_or_default().to_string();
    sk_server::test_hooks::session_cli::expire_session(&server.storage(), &token, sk_core::clock::now_ms()).expect("истечение сессии");
    assert_eq!(first_again.get("/api/auth/me").await.json()["user"], Value::Null);
    let after_expiry = bump(&server, "LIVSES").await;
    first_b.expect_revoked("session_ended", after_logout).await;
    let seen = observer.room(|room| room["version"] == json!(after_expiry)).await;
    assert_eq!(online(&seen), json!(["hero-2"]));
    assert_eq!(hero_in(&seen, "hero-1")["online"], json!(false));
    let reconnect = Sse::open(server.addr, "LIVSES", &cookie(&first_again)).await.err().expect("истёкшая сессия");
    assert_eq!(reconnect.status, 401);
    assert_eq!(connections(&server, "LIVSES").await.len(), 1, "в реестре остался только наблюдатель");
}

/// Смена героев администратором перестраивает поток сразу; потеря доступа —
/// кадр `access_lost` и конец потока.
#[tokio::test]
async fn admin_patch_refreshes_projection_and_revokes_on_access_loss() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, legacy_state("LIVHER")).await;
    let mut player = server.client();
    let user = player.register("player@mail.ru").await;
    assign(&mut admin, &user, json!(["hero-1"])).await;

    let mut stream = Sse::open(server.addr, "LIVHER", &cookie(&player)).await.expect("поток игрока");
    let initial = stream.room(|_| true).await;
    assert_eq!(hero_in(&initial, "hero-1")["inventory"][0]["origin"], json!("stolen"), "своё происхождение видно владельцу");
    assert_eq!(hero_in(&initial, "hero-2")["inventory"][0]["origin"], json!("found"), "находка — не тайна");

    assign(&mut admin, &user, json!(["hero-2"])).await;
    let reassigned = stream.room(|room| hero_in(room, "hero-1")["inventory"][0]["origin"].is_null()).await;
    assert_eq!(online(&reassigned), json!(["hero-2"]));
    assert_eq!(hero_in(&reassigned, "hero-2")["inventory"][0]["origin"], json!("found"));
    let infos = connections(&server, "LIVHER").await;
    assert_eq!(infos[0]["actor_id"], json!("hero-2"), "актёр проекции сменился");

    let before = bump(&server, "LIVHER").await;
    stream.room(|room| room["version"] == json!(before)).await;
    assign(&mut admin, &user, json!([])).await;
    stream.expect_revoked("access_lost", before).await;
    assert!(connections(&server, "LIVHER").await.is_empty());
}

/// Каждый зритель получает свою проекцию в одном и том же кадре рассылки.
#[tokio::test]
async fn each_viewer_sees_only_own_private_fields() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    // Краденое у обоих героев: своё происхождение видно, чужое — нет.
    let mut state = legacy_state("ISOLAT");
    state["players"] = json!([hero("hero-1", "Первый", "stolen"), hero("hero-2", "Второй", "stolen")]);
    create(&server, state).await;
    let mut first = server.client();
    let first_user = first.register("first@mail.ru").await;
    let mut second = server.client();
    let second_user = second.register("second@mail.ru").await;
    assign(&mut admin, &first_user, json!(["hero-1"])).await;
    assign(&mut admin, &second_user, json!(["hero-2"])).await;
    let mut owner = Sse::open(server.addr, "ISOLAT", &cookie(&first)).await.expect("первый");
    let mut guest = Sse::open(server.addr, "ISOLAT", &cookie(&second)).await.expect("второй");
    let version = bump(&server, "ISOLAT").await;
    let owner_view = owner.room(|room| room["version"] == json!(version)).await;
    let guest_view = guest.room(|room| room["version"] == json!(version)).await;
    let origin = |room: &Value, id: &str| hero_in(room, id)["inventory"][0]["origin"].clone();
    assert_eq!((origin(&owner_view, "hero-1"), origin(&owner_view, "hero-2")), (json!("stolen"), Value::Null), "первый видит только своё");
    assert_eq!((origin(&guest_view, "hero-1"), origin(&guest_view, "hero-2")), (Value::Null, json!("stolen")), "второй видит только своё");
    assert_eq!(owner_view["state"]["scene"]["location"], guest_view["state"]["scene"]["location"], "сцена общая");
    assert_eq!(online(&owner_view), online(&guest_view));
    assert_eq!(online(&owner_view), json!(["hero-1", "hero-2"]));
}

/// Тяжёлая, но законная кампания: около полутора мегабайт памяти мира.
fn heavy_state(code: &str) -> Value {
    let filler = "Летопись хранит подробности этой встречи. ".repeat(9);
    let facts: Vec<Value> = (0..1_600)
        .map(|index| {
            json!({ "id": format!("fact:chronicle-{index}"), "subject_id": "npc:chronicler", "predicate": "remembers", "object": format!("запись {index}"),
                "summary": format!("{index}. {filler}"), "visibility": "party", "status": "active", "source_event_ids": [], "recorded_at_minutes": 0 })
        })
        .collect();
    let mut state = legacy_state(code);
    state["partyMemberIds"] = json!(["hero-1"]);
    state["players"] = json!([hero("hero-1", "Первый", "found")]);
    state["worldMemory"] = json!({ "entities": [{ "id": "npc:chronicler", "kind": "npc", "name": "Летописец", "summary": "Помнит всё.", "visibility": "party" }], "facts": facts });
    state
}

/// Медленный читатель (сокет не читается вовсе) не копит кадры: комнаты
/// схлопываются до последней, очередь соединения не растёт, поток не
/// закрыт; когда клиент начинает читать — приходит последнее состояние.
/// Быстрый поток того же ведущего получает каждую рассылку.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_reader_collapses_rooms_and_gets_the_last_one() {
    const COMMITS: usize = 12;
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, heavy_state("SLOWSSE")).await;
    let fast = Sse::open(server.addr, "SLOWSSE", &cookie(&admin)).await.expect("быстрый поток");
    let (versions_tx, mut versions_rx) = tokio::sync::mpsc::unbounded_channel::<(i64, usize)>();
    let reader = tokio::spawn(async move {
        let mut fast = fast;
        while !fast.done {
            let deadline = Instant::now() + Duration::from_secs(120);
            fast.read_more(deadline).await;
            for version in fast.rooms.drain(..) {
                let _ = versions_tx.send((version, fast.room_bytes));
            }
        }
    });
    let mut stalled = Sse::open_with(server.addr, "SLOWSSE", &cookie(&admin), true).await.expect("медленный поток");
    let mut fast_rooms: Vec<i64> = Vec::new();
    let mut fast_bytes = 0;
    let mut final_version = 0;
    for _ in 0..COMMITS {
        final_version = bump(&server, "SLOWSSE").await;
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    while fast_rooms.last().copied().unwrap_or(0) < final_version {
        assert!(Instant::now() < deadline, "быстрый поток не дошёл до {final_version}: {fast_rooms:?}");
        if let Ok(Some((version, bytes))) = tokio::time::timeout(Duration::from_secs(5), versions_rx.recv()).await {
            fast_rooms.push(version);
            fast_bytes = bytes;
        }
    }
    assert!(fast_rooms.len() > COMMITS, "быстрый поток потерял рассылки: {fast_rooms:?}");
    let infos = connections(&server, "SLOWSSE").await;
    assert_eq!(infos.len(), 2, "медленный поток не закрыт: очередь схлопывается, а не переполняется");
    assert!(infos.iter().all(|info| info["pending"].as_u64().unwrap_or(99) <= 3), "очередь соединения ограничена: {infos:?}");

    let deadline = Instant::now() + Duration::from_secs(60);
    while stalled.rooms.last().copied().unwrap_or(0) < final_version {
        assert!(Instant::now() < deadline && !stalled.done, "медленный поток не получил последнюю комнату: {:?}", stalled.rooms);
        stalled.read_more(deadline).await;
    }
    let slow = stalled.rooms.clone();
    let mut sorted = slow.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, slow, "комнаты пришли не по порядку");
    assert!(slow.len() < fast_rooms.len() - COMMITS / 2, "промежуточные комнаты не схлопнуты: медленный {slow:?}, быстрый {fast_rooms:?}");
    assert!(stalled.room_bytes < fast_bytes / 2, "медленный поток получил почти всё: {} из {fast_bytes}", stalled.room_bytes);
    reader.abort();
}

/// Клиент, который не читает, а кадры не схлопываются (разные сообщения
/// рассказа): очередь упирается в предел, поток закрывается и снимается с
/// реестра; ответ обрывается без завершающего куска.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn never_reading_client_overflows_and_is_dropped() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, legacy_state("OVERFL")).await;
    let mut stalled = Sse::open_with(server.addr, "OVERFL", &cookie(&admin), true).await.expect("поток");
    let filler = "x".repeat(64 * 1024);
    let mut dropped = false;
    for index in 0..400 {
        let payload = json!({ "index": index, "text": filler });
        let left = server
            .state
            .core
            .call(move |core| {
                Box::pin(async move {
                    let live = core.streams.live().expect("настоящий реестр");
                    for handle in live.narration_connections("OVERFL") {
                        let _ = live.write_event(&handle, "custom", &payload);
                    }
                    live.connection_infos("OVERFL").len()
                })
            })
            .await
            .expect("ядро");
        if left == 0 {
            dropped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(dropped, "переполнение очереди не закрыло поток");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !stalled.done {
        assert!(Instant::now() < deadline, "оборванный поток не закрылся у клиента");
        stalled.read_more(deadline).await;
    }
    assert!(!stalled.ended, "переполнение обрывает ответ (`res.destroy()`), а не заканчивает его");
}

/// Пульс уходит тихому потоку и сверяет его сессию: истёкшая сессия
/// закрывается на пульсе без всякой рассылки.
#[tokio::test]
async fn heartbeat_keeps_quiet_stream_and_revokes_expired_session() {
    let server = live_server(Duration::from_millis(200)).await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, legacy_state("BEAT")).await;
    let mut player = server.client();
    let user = player.register("beat@mail.ru").await;
    assign(&mut admin, &user, json!(["hero-1"])).await;
    let mut stream = Sse::open(server.addr, "BEAT", &cookie(&player)).await.expect("поток");
    let version = stream.room(|_| true).await["version"].as_i64().unwrap_or(0);
    let deadline = Instant::now() + WAIT;
    while !stream.comments.iter().any(|comment| comment.starts_with("heartbeat ")) {
        stream.read_more(deadline).await;
    }
    let token = player.session().unwrap_or_default().to_string();
    sk_server::test_hooks::session_cli::expire_session(&server.storage(), &token, sk_core::clock::now_ms()).expect("истечение");
    stream.expect_revoked("session_ended", version).await;
}

/// Индикатор ввода: отказы, кадр `presence` всем потокам, снятие индикатора
/// и присутствие в следующей комнате.
#[tokio::test]
async fn typing_indicator_checks_and_presence_frames() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, legacy_state("TYPE")).await;
    let mut player = server.client();
    let user = player.register("typer@mail.ru").await;
    assign(&mut admin, &user, json!(["hero-1"])).await;
    let mut outsider = server.client();
    outsider.register("outsider@mail.ru").await;
    let mut watcher = Sse::open(server.addr, "TYPE", &cookie(&admin)).await.expect("поток ведущего");
    watcher.room(|_| true).await;

    let path = "/api/campaigns/type/presence/typing";
    let anonymous = server.client().put(path, &json!({ "actor_id": "hero-1", "typing": true })).await;
    assert_eq!(anonymous.status, 401);
    let missing = player.put("/api/campaigns/NOPE/presence/typing", &json!({ "actor_id": "hero-1", "typing": true })).await;
    assert_eq!((missing.status, missing.json()), (404, json!({ "error": "Кампания не найдена" })));
    let denied = outsider.put(path, &json!({ "actor_id": "hero-1", "typing": true })).await;
    assert_eq!((denied.status, denied.json()), (403, json!({ "error": "Нет доступа к этой кампании" })));
    let missing_with_bad_body = player.send(Req::new("PUT", "/api/campaigns/NOPE/presence/typing").body("{").header("content-type", "application/json")).await;
    assert_eq!(missing_with_bad_body.status, 404, "тело читается после проверки комнаты");
    let bad_body = player.send(Req::new("PUT", path).body("{").header("content-type", "application/json")).await;
    assert_eq!(bad_body.status, 400);
    let foreign = player.put(path, &json!({ "actor_id": "hero-2", "typing": true })).await;
    assert_eq!((foreign.status, foreign.json()), (403, json!({ "error": "Индикатор ввода доступен только владельцу героя", "code": "ACTOR_FORBIDDEN" })));
    let get = player.get(path).await;
    assert_eq!(get.status, 404, "только PUT");

    let typed = player.put(path, &json!({ "actor_id": "hero-1", "typing": true })).await;
    assert_eq!((typed.status, typed.json()), (200, json!({ "ok": true, "typing": true, "ttl_ms": 4000 })));
    let frame = watcher.next(|event| event.event == "presence").await.expect("кадр присутствия");
    assert_eq!(frame.data, json!({ "typing_actor_ids": ["hero-1"] }));
    let version = bump(&server, "TYPE").await;
    let room = watcher.room(|room| room["version"] == json!(version)).await;
    assert_eq!(room["state"]["presence"]["typing_actor_ids"], json!(["hero-1"]));

    let stopped = player.put(path, &json!({ "actor_id": "hero-1", "typing": "yes" })).await;
    assert_eq!(stopped.json(), json!({ "ok": true, "typing": false, "ttl_ms": 4000 }), "`typing === true` строго");
    let frame = watcher.next(|event| event.event == "presence").await.expect("кадр присутствия");
    assert_eq!(frame.data, json!({ "typing_actor_ids": [] }));
}

/// Ушедший клиент снимается с реестра, а остальные получают комнату, где его
/// герой уже не в сети.
#[tokio::test]
async fn closed_connection_leaves_presence() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    create(&server, legacy_state("LEAVE")).await;
    let mut first = server.client();
    let first_user = first.register("first@mail.ru").await;
    let mut second = server.client();
    let second_user = second.register("second@mail.ru").await;
    assign(&mut admin, &first_user, json!(["hero-1"])).await;
    assign(&mut admin, &second_user, json!(["hero-2"])).await;
    let mut stay = Sse::open(server.addr, "LEAVE", &cookie(&first)).await.expect("остаётся");
    let leave = Sse::open(server.addr, "LEAVE", &cookie(&second)).await.expect("уходит");
    stay.room(|room| online(room) == json!(["hero-1", "hero-2"])).await;
    drop(leave);
    let after = stay.room(|room| online(room) == json!(["hero-1"])).await;
    assert_eq!(hero_in(&after, "hero-2")["online"], json!(false));
    assert_eq!(after["state"]["presence"]["connected_users"], json!(1));
    drop(stay);
    let deadline = Instant::now() + WAIT;
    while !connections(&server, "LEAVE").await.is_empty() {
        assert!(Instant::now() < deadline, "закрытые соединения остались в реестре");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
