//! С1: комната, летопись, проекция, сверка, резервы бросков.
//!
//! - эталоны JS (`fixtures/gen-c1.mjs` → `fixtures/c1.json`): те же шаги
//!   «коммит → проекция → летопись» над `sk_store` в ядре; после каждого шага
//!   сверяются версия комнаты, хеш её состояния (по полям) и отметка проекции
//!   журнала;
//! - смысл `test/room-projection-equivalence.test.mjs`: после каждой команды
//!   комната совпадает с полной проекцией авторитетного состояния;
//! - смысл `test/snapshot-projector-version.test.mjs`: снимок другой версии
//!   проектора не принимается, поток переигрывается;
//! - Rust: конфликт версии накладки, предел летописи 400, сбой одной кампании
//!   при сверке всех, подтверждение проекции и счётчик комнаты в одной
//!   транзакции (сбой подтверждения из данных — комната пишется, отметка нет),
//!   хуки «проекция записана», резервы бросков.

use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_server::core::{CoreHandle, GameCore, LocalFuture};
use sk_server::projection::{self, PersistOptions};
use sk_server::room::{self, Room};
use sk_server::state::SharedDice;
use sk_server::streams::{Presence, StreamRegistry};
use sk_server::{journal, startup};
use sk_store::accounts::Accounts;
use sk_store::{CommitRequest, CommitResult, EventStore, InitializeRequest, LoadOptions, Reducer, RetentionMode, StoreOptions};

const FIXTURE: &str = include_str!("../fixtures/c1.json");
const NOW: i64 = 1_760_000_000_000;

// --- ядро для тестов --------------------------------------------------------

/// Присутствие, которым управляет тест.
struct TestPresence(Arc<Mutex<Vec<String>>>);

impl Presence for TestPresence {
    fn connected_hero_ids(&self, _campaign_id: &str) -> IndexSet<String> {
        self.0.lock().map(|ids| ids.iter().cloned().collect()).unwrap_or_default()
    }
}

impl StreamRegistry for TestPresence {
    fn revoke_for_session(&self, _session_key: &str) {}
    fn refresh_for_user(&self, _user_id: &str) {}
}

struct Harness {
    core: CoreHandle,
    connected: Arc<Mutex<Vec<String>>>,
    accounts: Arc<Accounts>,
    dir: tempfile::TempDir,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.core.shutdown();
    }
}

fn store_options() -> StoreOptions {
    let counter = Arc::new(AtomicUsize::new(0));
    StoreOptions { clock: Arc::new(|| NOW), id_factory: Arc::new(move || format!("id-{:06}", counter.fetch_add(1, Ordering::SeqCst) + 1)), ..StoreOptions::default() }
}

fn harness_in(dir: tempfile::TempDir) -> Harness {
    let connected = Arc::new(Mutex::new(Vec::new()));
    let presence = connected.clone();
    let database = dir.path().join("skazanie.sqlite");
    let rolls_file = dir.path().join("engine").join("roll-registry.json");
    let accounts = Arc::new(Accounts::open(dir.path().join("accounts.sqlite")).expect("аккаунты"));
    let core = CoreHandle::start("c1-core", move || {
        let reducer = Arc::new(sk_tactics::cutover_audit::GameReducer::new());
        let events = EventStore::open(&database, reducer, store_options()).map_err(|error| error.message)?.with_map_cells(Arc::new(sk_tactics::cutover_audit::TacticalMapCells));
        let dice = SharedDice::new(Box::new(sk_dice::DiceService::deterministic(sk_dice::FixedRng(10), "roll")));
        let options = sk_infra::roll_registry::RollRegistryOptions { storage_file: Some(rolls_file), now: Arc::new(|| NOW), ..Default::default() };
        let rolls = sk_infra::roll_registry::RollRegistry::new(Box::new(dice.clone()), options).map_err(|error| error.to_string())?;
        Ok(GameCore { events: Arc::new(events), rolls: std::cell::RefCell::new(rolls), dice, streams: Box::new(TestPresence(presence)), room_hooks: std::cell::RefCell::default() })
    })
    .expect("ядро");
    Harness { core, connected, accounts, dir }
}

fn harness() -> Harness {
    harness_in(tempfile::tempdir().expect("каталог"))
}

impl Harness {
    async fn run<R: Send + 'static>(&self, job: impl FnOnce(Rc<GameCore>) -> LocalFuture<R> + Send + 'static) -> R {
        self.core.call(job).await.expect("задание ядра")
    }
}

// --- вид комнаты как в эталоне ----------------------------------------------

fn hash_of(value: &Value) -> String {
    sk_core::hash::sha256_hex(sk_store::stable::stable_json(value))
}

fn view(room: &Room) -> Value {
    let Some(state) = room.state.as_ref() else { return json!({ "version": room.version, "hash": null, "fields": null }) };
    let mut state = state.clone();
    if let Some(Value::Array(messages)) = state.get_mut("messages") {
        for message in messages {
            if let Some(map) = message.as_object_mut() {
                map.shift_remove("timestamp");
            }
        }
    }
    let map = state.as_object().cloned().unwrap_or_default();
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    let fields: Map<String, Value> = keys.into_iter().map(|key| (key.clone(), Value::String(hash_of(&map[key])))).collect();
    let messages = state.get("messages").and_then(Value::as_array).map(Vec::len);
    let mut view = json!({ "version": room.version, "hash": hash_of(&state), "fields": fields });
    if let Some(count) = messages {
        view["messages"] = json!(count);
    }
    view
}

/// Разница видов: версия, хеш и имена разошедшихся полей.
fn view_diff(label: &str, expected: &Value, actual: &Value) -> Option<String> {
    if expected.get("version") == actual.get("version") && expected.get("hash") == actual.get("hash") {
        return None;
    }
    let empty = Map::new();
    let left = expected.get("fields").and_then(Value::as_object).unwrap_or(&empty);
    let right = actual.get("fields").and_then(Value::as_object).unwrap_or(&empty);
    let mut fields: Vec<&String> = left.keys().chain(right.keys()).collect();
    fields.sort();
    fields.dedup();
    let diverged: Vec<&str> = fields.into_iter().filter(|field| left.get(*field) != right.get(*field)).map(String::as_str).collect();
    Some(format!("{label}: версия {} против {}, поля: {diverged:?}", expected["version"], actual["version"]))
}

fn journal_view(core: &GameCore, code: &str) -> Value {
    match core.events.get_metadata(code) {
        Ok(metadata) => json!({ "head": metadata["state_version"], "checkpoint": metadata.get("projection_checkpoint_version").cloned().unwrap_or(json!(0)), "hash": metadata.get("projection_checkpoint_hash").cloned().unwrap_or(Value::Null) }),
        Err(error) => json!({ "error": error.code }),
    }
}

// --- повтор шагов эталона ---------------------------------------------------

fn create(core: &Rc<GameCore>, code: &str, raw: &Value) -> Result<Room, String> {
    let mut state = sk_rules::normalize::normalize_campaign_state(raw).map_err(|error| error.to_string())?;
    state["sessionCode"] = json!(code);
    state["engine_mode"] = json!("enforce");
    let strings = |key: &str| state.get(key).and_then(Value::as_array).map(|items| items.iter().map(|item| sk_core::js::s(Some(item))).collect()).unwrap_or_default();
    let request = InitializeRequest {
        campaign_id: code.into(),
        initial_state: state.clone(),
        ruleset_id: sk_core::js::s(state.get("ruleset_id")),
        ruleset_version: sk_core::js::s(state.get("ruleset_version")),
        enabled_rule_packs: strings("enabled_rule_packs"),
        enabled_house_rules: strings("enabled_house_rules"),
        metadata: json!({}),
    };
    let (initialized, _) = core.events.initialize_campaign(request).map_err(|error| error.to_string())?;
    let mut room_state = initialized.state.clone();
    let messages = room_state.get("messages").filter(|value| value.is_array()).cloned().unwrap_or(json!([]));
    room_state["messages"] = messages;
    room_state["engine_mode"] = json!("enforce");
    room_state["state_projector_version"] = json!(sk_rules::constants::GAME_STATE_PROJECTOR_VERSION);
    room::save_room(core, code, &room_state, 0).map(|saved| saved.room).map_err(|error| error.to_string())
}

fn commit(core: &GameCore, code: &str, key: &str, events: &[Value]) -> Result<CommitResult, String> {
    let head = core.events.load(code, &LoadOptions::default()).map_err(|error| error.to_string())?;
    core.events
        .commit(CommitRequest { campaign_id: code.into(), expected_state_version: head.state_version, idempotency_key: key.into(), command_id: Some(key.into()), events: events.to_vec(), ..Default::default() })
        .map_err(|error| error.to_string())
}

/// Итог шага: комната (или `null`), признак конфликта, ошибка.
enum Outcome {
    Room(Option<Room>, Option<bool>),
    Error(String),
}

async fn replay(core: Rc<GameCore>, scenario: Value, connected: Arc<Mutex<Vec<String>>>, accounts: Arc<Accounts>) -> (Vec<String>, usize) {
    let code = sk_core::js::s(scenario.get("code"));
    let mut problems = Vec::new();
    let mut checks = 0;
    let mut committed: Option<CommitResult> = None;
    let steps = scenario["steps"].as_array().cloned().unwrap_or_default();
    for (index, step) in steps.iter().enumerate() {
        let op = sk_core::js::s(step.get("op"));
        let label = format!("{code} шаг {index} ({op})");
        let set_connected = |list: Option<&Value>| {
            if let Ok(mut ids) = connected.lock() {
                *ids = list.and_then(Value::as_array).map(|items| items.iter().map(|item| sk_core::js::s(Some(item))).collect()).unwrap_or_default();
            }
        };
        let outcome = match op.as_str() {
            "create" => match create(&core, &code, &step["state"]) {
                Ok(room) => Outcome::Room(Some(room), None),
                Err(error) => Outcome::Error(error),
            },
            "init_only" => {
                let state = sk_rules::normalize::normalize_campaign_state(&step["state"]).unwrap_or_default();
                let _ = core.events.initialize_campaign(InitializeRequest::new(code.clone(), state));
                Outcome::Room(None, None)
            }
            "commit" => {
                let events = step["events"].as_array().cloned().unwrap_or_default();
                match commit(&core, &code, &sk_core::js::s(step.get("key")), &events) {
                    Ok(result) => {
                        committed = Some(result);
                        Outcome::Room(None, None)
                    }
                    Err(error) => Outcome::Error(error),
                }
            }
            "persist" => {
                let options = LoadOptions { at_version: step.get("at").and_then(Value::as_i64), ..LoadOptions::default() };
                let engine = core.events.load(&code, &options).map(|loaded| loaded.state).unwrap_or(Value::Null);
                let events = match step.get("events") {
                    Some(Value::String(_)) => committed.as_ref().map(|result| result.events.clone()).unwrap_or_default(),
                    Some(Value::Array(list)) => list.clone(),
                    _ => Vec::new(),
                };
                let message = step.get("message").filter(|value| !value.is_null());
                let options = PersistOptions { force_projector_refresh: step["force"] == json!(true), await_projection: step["await"] == json!(true) };
                match projection::persist_authoritative_projection(&core, &code, &engine, &events, message, options) {
                    Ok(room) => Outcome::Room(room, None),
                    Err(error) => Outcome::Error(error.message),
                }
            }
            "append" => match journal::append_room_journal(&core, &code, step["entries"].as_array().map(Vec::as_slice).unwrap_or(&[])) {
                Ok(room) => Outcome::Room(room, None),
                Err(error) => Outcome::Error(error.message),
            },
            "reconcile" => match projection::reconcile_campaign_projection_at(&core, &code, step["now"].as_i64().unwrap_or(NOW)) {
                Ok(room) => Outcome::Room(room, None),
                Err(error) => Outcome::Error(error.message),
            },
            "save_room" => {
                let current = room::get_room(&core, &code).ok().and_then(|room| room.state).unwrap_or_default();
                let mut state = sk_core::js::spread(&current, step["set"].clone());
                for field in step["remove"].as_array().cloned().unwrap_or_default() {
                    sk_core::js::delete(&mut state, &sk_core::js::s(Some(&field)));
                }
                match room::save_room(&core, &code, &state, step["base"].as_i64().unwrap_or(0)) {
                    Ok(saved) => Outcome::Room(Some(saved.room), Some(saved.conflict)),
                    Err(error) => Outcome::Error(error.message),
                }
            }
            "interaction" => {
                set_connected(step.get("connected"));
                match projection::persist_interaction_projection(core.clone(), accounts.clone(), &code, &step["interaction"]).await {
                    Ok(room) => Outcome::Room(room, None),
                    Err(error) => Outcome::Error(error.message),
                }
            }
            "presence" => {
                set_connected(step.get("connected"));
                match projection::reconcile_party_decision_presence(&core, &code) {
                    Ok(Some(_)) => Outcome::Room(room::get_room(&core, &code).ok(), None),
                    Ok(None) => Outcome::Room(None, None),
                    Err(error) => Outcome::Error(error.message),
                }
            }
            "house_rules" => {
                startup::enable_default_house_rules(&core, &code);
                Outcome::Room(None, None)
            }
            other => {
                problems.push(format!("{label}: неизвестный шаг {other}"));
                continue;
            }
        };
        if let Some(expected) = step.get("outcome").filter(|value| !value.is_null()) {
            match (&outcome, expected.get("error")) {
                (Outcome::Error(message), Some(error)) => {
                    if error["message"].as_str() != Some(message.as_str()) {
                        problems.push(format!("{label}: ошибка «{message}», в JS «{}»", error["message"]));
                    }
                }
                (Outcome::Error(message), None) => problems.push(format!("{label}: ошибка «{message}», в JS — успех")),
                (Outcome::Room(..), Some(error)) => problems.push(format!("{label}: успех, в JS ошибка {error}")),
                (Outcome::Room(room, conflict), None) => {
                    match (expected.get("room").filter(|value| !value.is_null()), room) {
                        (None, None) => {}
                        (Some(want), Some(room)) => {
                            checks += 1;
                            problems.extend(view_diff(&format!("{label}, итог"), want, &view(room)));
                        }
                        (want, got) => problems.push(format!("{label}: итог {:?} против {:?}", want.map(|_| "комната"), got.as_ref().map(|room| room.version))),
                    }
                    if let (Some(want), Some(got)) = (expected.get("conflict").and_then(Value::as_bool), conflict) {
                        if want != *got {
                            problems.push(format!("{label}: conflict {got}, в JS {want}"));
                        }
                    }
                }
            }
        }
        if let Some(expected) = step.get("current").filter(|value| !value.is_null()) {
            match room::get_room(&core, &code) {
                Ok(room) => {
                    checks += 1;
                    problems.extend(view_diff(&format!("{label}, комната"), expected, &view(&room)));
                }
                Err(error) => problems.push(format!("{label}: комната не читается: {error}")),
            }
        }
        if let Some(expected) = step.get("journal") {
            checks += 1;
            let actual = journal_view(&core, &code);
            if &actual != expected {
                problems.push(format!("{label}: журнал {actual}, в JS {expected}"));
            }
        }
        // Смысл `room-projection-equivalence`: после проекции головы комната
        // совпадает с полной проекцией авторитетного состояния.
        if code == "C1-FLOW" && op == "persist" && step.get("at").is_none_or(Value::is_null) {
            let head = core.events.load(&code, &LoadOptions::default()).map(|loaded| loaded.state).unwrap_or_default();
            let room = room::get_room(&core, &code).ok().and_then(|room| room.state).unwrap_or_default();
            if !sk_narration_base::projection_integrity::compare_projection(&head, &room).matched {
                problems.push(format!("{label}: комната разошлась с полной проекцией авторитетного состояния"));
            }
        }
    }
    (problems, checks)
}

#[tokio::test]
async fn js_fixtures_room_sequences() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("c1.json");
    let scenarios = fixture["scenarios"].as_array().cloned().unwrap_or_default();
    assert!(scenarios.len() >= 8);
    let harness = harness();
    let mut problems = Vec::new();
    let mut checks = 0;
    for scenario in scenarios {
        let connected = harness.connected.clone();
        let accounts = harness.accounts.clone();
        let (found, done) = harness.run(move |core| Box::pin(replay(core, scenario, connected, accounts))).await;
        problems.extend(found);
        checks += done;
    }
    assert!(checks >= 120, "сверок с эталоном слишком мало: {checks}");
    assert!(problems.is_empty(), "расхождения с JS ({}):\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn js_fixtures_journal_helpers() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("c1.json");
    let helpers = &fixture["helpers"];
    for case in helpers["ids"].as_array().cloned().unwrap_or_default() {
        let key = case["key"].as_str().unwrap_or_default();
        assert_eq!(json!(journal::combat_message_id(key)), case["combat"], "{key}");
        assert_eq!(json!(journal::player_message_id(key)), case["player"], "{key}");
    }
    for case in helpers["notes"].as_array().cloned().unwrap_or_default() {
        assert_eq!(json!(journal::player_note_from(&case["body"])), case["note"], "{}", case["body"]);
    }
    for case in helpers["authors"].as_array().cloned().unwrap_or_default() {
        assert_eq!(json!(journal::player_note_author(&case["state"], Some(&case["actor"]), Some(&case["actorId"]))), case["author"], "{case}");
    }
    for case in helpers["recent"].as_array().cloned().unwrap_or_default() {
        let limit = case["limit"].as_u64().unwrap_or(6) as usize;
        let state = json!({ "messages": [{ "speaker": "narrator", "text": "a" }, { "speaker": "player", "text": "b" }, { "speaker": "narrator", "text": " " }, { "speaker": "narrator", "text": "c" }] });
        assert_eq!(json!(journal::recent_narrator_texts(Some(&state), limit)), case["texts"], "limit {limit}");
    }
}

// --- Rust-тесты --------------------------------------------------------------

fn initial(code: &str) -> Value {
    json!({ "state_version": 0, "sessionCode": code, "campaign": "Тест", "players": [{ "id": "hero", "character": "Бран", "hp": 10, "maxHp": 10 }], "messages": [] })
}

#[tokio::test]
async fn overlay_version_conflict_returns_current_room() {
    let harness = harness();
    let outcome = harness
        .run(|core| {
            Box::pin(async move {
                let created = create(&core, "C1-CAS", &initial("C1-CAS"))?;
                let state = created.state.clone().unwrap_or_default();
                let first = room::save_room(&core, "C1-CAS", &sk_core::js::spread(&state, json!({ "note": 1 })), created.version).map_err(|error| error.to_string())?;
                let stale = room::save_room(&core, "C1-CAS", &sk_core::js::spread(&state, json!({ "note": 2 })), created.version).map_err(|error| error.to_string())?;
                let current = room::get_room(&core, "c1-cas").map_err(|error| error.to_string())?;
                Ok::<_, String>((created.version, first, stale, current))
            })
        })
        .await;
    let (created, first, stale, current) = outcome.expect("шаги");
    assert_eq!((created, first.conflict, first.room.version), (1, false, 2));
    assert!(stale.conflict, "устаревшая база — конфликт");
    assert_eq!(stale.room.version, 2, "конфликт отдаёт текущую комнату");
    assert_eq!(current.state.as_ref().and_then(|state| state.get("note")), Some(&json!(1)), "конфликт ничего не записал");
    assert_eq!(current.state.as_ref().and_then(|state| state.get("isNarrating")), Some(&json!(false)), "isNarrating всегда false");
}

#[tokio::test]
async fn journal_keeps_last_400_and_dedupes_by_id() {
    let harness = harness();
    let (count, first, last, repeated_version, version) = harness
        .run(|core| {
            Box::pin(async move {
                create(&core, "C1-400", &initial("C1-400")).expect("кампания");
                let entries: Vec<Value> = (0..450).map(|index| json!({ "id": format!("m-{index}"), "text": format!("Строка {index}") })).collect();
                let appended = journal::append_room_journal(&core, "C1-400", &entries).expect("летопись").expect("комната");
                let repeated = journal::append_room_journal(&core, "C1-400", &entries[440..]).expect("повтор").expect("комната");
                let messages = appended.state.as_ref().and_then(|state| state["messages"].as_array().cloned()).unwrap_or_default();
                (messages.len(), messages[0]["id"].clone(), messages[399]["id"].clone(), repeated.version, appended.version)
            })
        })
        .await;
    assert_eq!(count, journal::ROOM_JOURNAL_LIMIT);
    assert_eq!((first, last), (json!("m-50"), json!("m-449")));
    assert_eq!(repeated_version, version, "уже записанные id не двигают версию");
}

/// Удалить последний коммит кампании: метаданные обгоняют журнал —
/// `CAMPAIGN_RECOVERY_REQUIRED`.
fn break_tail(core: &GameCore, code: &str) {
    let code = code.to_string();
    core.events
        .with_connection_mut(|conn| {
            conn.execute("DELETE FROM commits WHERE campaign_id = ?1 AND version_after = (SELECT MAX(version_after) FROM commits WHERE campaign_id = ?1)", [&code])?;
            Ok(())
        })
        .expect("порча журнала");
}

#[tokio::test]
async fn reconcile_all_isolates_a_broken_campaign() {
    let harness = harness();
    let (failures, broken, neighbour, checkpoint) = harness
        .run(|core| {
            Box::pin(async move {
                for code in ["C1-BROKEN", "C1-FINE"] {
                    create(&core, code, &initial(code)).expect("кампания");
                    commit(&core, code, &format!("{code}:1"), &[json!({ "event_id": format!("{code}-e1"), "event_type": "ObjectiveUpdated", "payload": { "objective": "Мост" } })]).expect("коммит");
                    commit(&core, code, &format!("{code}:2"), &[json!({ "event_id": format!("{code}-e2"), "event_type": "ObjectiveUpdated", "payload": { "objective": "Река" } })]).expect("коммит");
                }
                break_tail(&core, "C1-BROKEN");
                let failures = startup::prepare(&core).expect("список комнат");
                let broken = room::get_room(&core, "C1-BROKEN").err().and_then(|failure| failure.code);
                let neighbour = room::get_room(&core, "C1-FINE").ok().and_then(|room| room.state).map(|state| state["state_version"].clone());
                let checkpoint = journal_view(&core, "C1-FINE")["checkpoint"].clone();
                (failures.into_iter().map(|(code, failure)| (code, failure.code)).collect::<Vec<_>>(), broken, neighbour, checkpoint)
            })
        })
        .await;
    assert_eq!(failures, vec![("C1-BROKEN".to_string(), Some("CAMPAIGN_RECOVERY_REQUIRED".to_string()))], "отказ только у испорченной");
    assert_eq!(broken.as_deref(), Some("CAMPAIGN_RECOVERY_REQUIRED"), "запрос к испорченной — явный отказ восстановления");
    assert_eq!(neighbour, Some(json!(2)), "соседняя кампания сверена до головы");
    assert_eq!(checkpoint, json!(2), "и её проекция подтверждена");
}

/// Подтверждение проекции и счётчик комнаты — одна транзакция: сбой
/// подтверждения из данных (`DND_COMMIT_FAULTS`) оставляет запись комнаты, но
/// не отметку; без сбоя обе двигаются вместе. Атомарность самой транзакции
/// (сбой до фиксации откатывает обе) — `sk_store::store::rooms` (юнит-тест).
#[tokio::test]
async fn projection_ack_moves_with_room_counter() {
    let harness = harness();
    let faults = sk_server::test_hooks::CommitFaults::parse(&json!({ "format": "skazanie.test-faults/1", "projection_ack": [{ "campaign": "c1-ack", "version": 1 }] }).to_string()).expect("сбои");
    sk_server::test_hooks::install(&harness.core, Some(faults)).await.expect("сбои в ядре");
    let ((faulted, after_fault), healthy, after) = harness
        .run(|core| {
            Box::pin(async move {
                create(&core, "C1-ACK", &initial("C1-ACK")).expect("кампания");
                commit(&core, "C1-ACK", "ack:1", &[json!({ "event_id": "ack-e1", "event_type": "ObjectiveUpdated", "payload": { "objective": "A" } })]).expect("коммит");
                let head = core.events.load("C1-ACK", &LoadOptions::default()).expect("голова").state;
                let message = json!({ "id": "ack-m1", "text": "Реплика" });
                let await_ack = PersistOptions { await_projection: true, ..PersistOptions::default() };
                let faulted = projection::persist_authoritative_projection(&core, "C1-ACK", &head, &[], Some(&message), await_ack).map(|room| room.map(|room| room.version)).map_err(|error| error.message);
                let after_fault = (room::get_room(&core, "C1-ACK").map(|room| room.version).unwrap_or(-1), journal_view(&core, "C1-ACK")["checkpoint"].clone());
                let message = json!({ "id": "ack-m2", "text": "Ещё" });
                let healthy = projection::persist_authoritative_projection(&core, "C1-ACK", &head, &[], Some(&message), await_ack).map(|room| room.map(|room| room.version)).map_err(|error| error.message);
                let after = (room::get_room(&core, "C1-ACK").map(|room| room.version).unwrap_or(-1), journal_view(&core, "C1-ACK")["checkpoint"].clone());
                ((faulted, after_fault), healthy, after)
            })
        })
        .await;
    assert_eq!(faulted, Err("synthetic projection acknowledgement failure".to_string()), "с awaitProjection отказ подтверждения виден вызывающему");
    assert_eq!(after_fault, (2, json!(0)), "комната записана, отметка проекции — нет");
    assert_eq!(healthy, Ok(Some(3)));
    assert_eq!(after, (3, json!(1)), "без сбоя счётчик и отметка двигаются вместе");
}

static HOOKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record_hook(_core: Rc<GameCore>, campaign_id: String, room: Room) -> LocalFuture<()> {
    Box::pin(async move {
        HOOKED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(format!("{campaign_id}:{}", room.version));
    })
}

#[tokio::test]
async fn projection_saved_hooks_follow_every_room_write() {
    let harness = harness();
    harness
        .run(|core| {
            Box::pin(async move {
                projection::subscribe_projection_saved(&core, record_hook);
                create(&core, "c1-hook", &initial("C1-HOOK")).expect("кампания");
                journal::append_room_journal(&core, "C1-HOOK", &[json!({ "id": "h1", "text": "Строка" })]).expect("летопись");
            })
        })
        .await;
    let mut seen = Vec::new();
    for _ in 0..200 {
        seen = HOOKED.lock().map(|list| list.clone()).unwrap_or_default();
        if seen.len() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(seen, vec!["C1-HOOK:1".to_string(), "C1-HOOK:2".to_string()], "код в верхнем регистре, после каждой записи");
}

#[tokio::test]
async fn room_without_journal_is_kept_whole_and_latest_state_falls_back() {
    let harness = harness();
    let (room, latest, fallback) = harness
        .run(|core| {
            Box::pin(async move {
                let saved = room::save_room(&core, "C1-BARE", &json!({ "campaign": "Без журнала", "messages": [] }), 0).expect("комната");
                let room = room::get_room(&core, "C1-BARE").expect("чтение");
                let latest = projection::latest_campaign_state(&core, "C1-BARE", room.state.as_ref()).map(|state| state["campaign"].clone());
                let fallback = projection::latest_campaign_state(&core, "C1-NONE", None).map(|state| state["partyName"].clone());
                (saved.room == room, latest, fallback)
            })
        })
        .await;
    assert!(room, "состояние без журнала читается тем же, что записано");
    assert_eq!(latest.ok(), Some(json!("Без журнала")), "без журнала — нормализованное запасное");
    assert_eq!(fallback.ok(), Some(json!("Отряд героев")));
}

fn seed_rolls(path: &Path) {
    std::fs::create_dir_all(path.parent().expect("каталог")).expect("каталог");
    let entry = |key: &str| json!({ "consumed_by": key, "commit_pending": true, "campaign_id": "C1-ROLL", "expires_at": NOW + 3_600_000, "result": { "total": 12 } });
    let body = json!({ "schema_version": 1, "rolls": [["roll-orphan", entry("roll:orphan")], ["roll-done", entry("roll:done")], ["roll-failed", entry("roll:failed")], ["roll-mismatch", entry("roll:mismatch")]], "checks": [] });
    std::fs::write(path, body.to_string()).expect("реестр");
}

#[tokio::test]
async fn roll_reservations_follow_the_journal() {
    let dir = tempfile::tempdir().expect("каталог");
    seed_rolls(&dir.path().join("engine").join("roll-registry.json"));
    let harness = harness_in(dir);
    let released = harness
        .run(|core| {
            Box::pin(async move {
                create(&core, "C1-ROLL", &initial("C1-ROLL")).expect("кампания");
                commit(&core, "C1-ROLL", "roll:done", &[json!({ "event_id": "roll-e1", "event_type": "ObjectiveUpdated", "payload": { "objective": "A" } })]).expect("коммит");
                // Резервы упавших запросов держит процесс; на старте держателей нет.
                let failed = startup::RollReservation { roll_id: "roll-failed".into(), campaign_id: "C1-ROLL".into(), idempotency_key: "roll:failed".into() };
                startup::finish_failed_roll_reservation(&core, Some(&failed), None);
                let mismatch = startup::RollReservation { roll_id: "roll-mismatch".into(), campaign_id: "C1-ROLL".into(), idempotency_key: "roll:mismatch".into() };
                startup::finish_failed_roll_reservation(&core, Some(&mismatch), Some("ROLL_CONTEXT_MISMATCH"));
                startup::finish_failed_roll_reservation(&core, None, None);
                let released = startup::release_orphan_roll_reservations(&core);
                released
            })
        })
        .await;
    let registry: Value = serde_json::from_str(&std::fs::read_to_string(harness.dir.path().join("engine").join("roll-registry.json")).expect("реестр")).expect("JSON");
    let consumed = |id: &str| {
        registry["rolls"].as_array().and_then(|rolls| rolls.iter().find(|pair| pair[0] == json!(id))).map(|pair| (pair[1]["consumed_by"].clone(), pair[1].get("commit_pending").cloned()))
    };
    assert_eq!(released, vec!["roll-orphan".to_string()], "осиротевший резерв без commit снят, с commit — закреплён");
    assert_eq!(consumed("roll-orphan"), Some((Value::Null, None)));
    assert_eq!(consumed("roll-done"), Some((json!("roll:done"), None)), "commit есть — бросок потреблён окончательно");
    assert_eq!(consumed("roll-failed"), Some((Value::Null, None)), "commit не появился — кость снова доступна");
    assert_eq!(consumed("roll-mismatch"), Some((json!("roll:mismatch"), None)), "кость к чужой заявке сгорает");
}

/// Смысл `test/snapshot-projector-version.test.mjs`: снимок, снятый прежней
/// версией проектора, не принимается — события переигрываются новым
/// редьюсером.
#[test]
fn projector_version_change_replays_instead_of_trusting_snapshot() {
    struct Xp {
        projector: i64,
        counts: bool,
    }
    impl Reducer for Xp {
        fn reducer_version(&self) -> i64 {
            1
        }
        fn snapshot_projector_version(&self) -> i64 {
            self.projector
        }
        fn normalize(&self, state: Value, _mode: RetentionMode) -> Value {
            state
        }
        fn apply(&self, mut state: Value, event: &Value, _mode: RetentionMode) -> Result<Value, String> {
            if self.counts && event["event_type"] == json!("ExperienceAwarded") {
                let total = state["experience"].as_i64().unwrap_or(0) + event["payload"]["amount"].as_i64().unwrap_or(0);
                state["experience"] = json!(total);
            }
            Ok(state)
        }
    }
    let dir = tempfile::tempdir().expect("каталог");
    let path = dir.path().join("skazanie.sqlite");
    let options = || StoreOptions { snapshot_every: 1, ..StoreOptions::default() };
    {
        let legacy = EventStore::open(&path, Arc::new(Xp { projector: 1, counts: false }), options()).expect("база");
        legacy.initialize_campaign(InitializeRequest::new("migration", json!({ "experience": 0 }))).expect("кампания");
        legacy
            .commit(CommitRequest { campaign_id: "migration".into(), expected_state_version: 0, idempotency_key: "award-xp".into(), events: vec![json!({ "event_type": "ExperienceAwarded", "payload": { "amount": 75 } })], ..Default::default() })
            .expect("коммит");
        assert_eq!(legacy.load("migration", &LoadOptions::default()).expect("загрузка").state["experience"], json!(0));
    }
    let reopened = EventStore::open(&path, Arc::new(Xp { projector: 2, counts: true }), options()).expect("база");
    let restored = reopened.load("migration", &LoadOptions::default()).expect("загрузка");
    assert_eq!(restored.state["experience"], json!(75));
    assert_eq!((restored.state_version, restored.events_applied), (1, 1));
}
