//! Перенос `test/event-store.test.mjs`: журнал, снимки, идемпотентность,
//! гонки версий, отказ восстановления (RCV-01/02), карты по хешу.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_store::{
    CommitRequest, EventStore, InitializeRequest, LegacyImportRequest, LoadOptions, Reducer, RetentionMode, StoreError, StoreOptions,
};

/// Редьюсер тестов JS: урон, лечение, цель, отказ.
struct HpReducer {
    calls: AtomicUsize,
}

impl HpReducer {
    fn new() -> Arc<Self> {
        Arc::new(Self { calls: AtomicUsize::new(0) })
    }
}

impl Reducer for HpReducer {
    fn reducer_version(&self) -> i64 {
        15
    }

    fn normalize(&self, state: Value, _mode: RetentionMode) -> Value {
        state
    }

    fn apply(&self, mut state: Value, event: &Value, _mode: RetentionMode) -> Result<Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let hp = state.get("hp").and_then(Value::as_i64).unwrap_or(0);
        let amount = event["payload"].get("amount").and_then(Value::as_i64).unwrap_or(0);
        match event["event_type"].as_str() {
            Some("DamageApplied") => state["hp"] = json!((hp - amount).max(0)),
            Some("HealingApplied") => state["hp"] = json!(hp + amount),
            Some("ObjectiveUpdated") => state["objective"] = event["payload"]["objective"].clone(),
            Some("ReducerFailure") => return Err("reducer rejected event".into()),
            _ => {}
        }
        Ok(state)
    }
}

fn options(snapshot_every: i64) -> StoreOptions {
    let counter = Arc::new(AtomicUsize::new(0));
    StoreOptions {
        snapshot_every,
        clock: Arc::new(|| 1_789_560_000_000),
        id_factory: Arc::new(move || format!("id-{}", counter.fetch_add(1, Ordering::SeqCst) + 1)),
        ..StoreOptions::default()
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    reducer: Arc<HpReducer>,
    store: EventStore,
    snapshot_every: i64,
}

impl Fixture {
    fn new(snapshot_every: i64) -> Self {
        let dir = tempfile::tempdir().expect("временный каталог");
        let path = dir.path().join("engine.sqlite");
        let reducer = HpReducer::new();
        let store = EventStore::open(&path, reducer.clone(), options(snapshot_every)).expect("хранилище");
        Self { _dir: dir, path, reducer, store, snapshot_every }
    }

    /// Тот же файл базы, другой процесс.
    fn reopen(&self) -> EventStore {
        EventStore::open(&self.path, self.reducer.clone(), options(self.snapshot_every)).expect("хранилище")
    }

    fn sql(&self, statement: &str) {
        self.store.with_connection_mut(|conn| Ok(conn.execute_batch(statement)?)).expect("SQL");
    }
}

fn init(store: &EventStore, campaign: &str, state: Value) {
    store.initialize_campaign(InitializeRequest::new(campaign, state)).expect("кампания");
}

fn request(campaign: &str, expected: i64, key: &str, events: Vec<Value>) -> CommitRequest {
    CommitRequest { campaign_id: campaign.into(), expected_state_version: expected, idempotency_key: key.into(), events, ..Default::default() }
}

fn heal(campaign: &str, expected: i64, key: &str) -> CommitRequest {
    request(campaign, expected, key, vec![json!({ "event_type": "HealingApplied", "payload": { "amount": 1 } })])
}

fn snapshot_versions(fixture: &Fixture, campaign: &str) -> Vec<i64> {
    fixture
        .store
        .with_connection_mut(|conn| {
            let mut statement = conn.prepare("SELECT state_version FROM snapshots WHERE campaign_id = ?1 ORDER BY state_version")?;
            let rows = statement.query_map([campaign], |row| row.get(0))?;
            Ok(rows.collect::<Result<Vec<i64>, _>>()?)
        })
        .expect("снимки")
}

fn recovery(error: StoreError, reason: &str) {
    assert_eq!(error.code, "CAMPAIGN_RECOVERY_REQUIRED", "{error}");
    assert_eq!(error.details["reason"], reason, "{error}");
}

#[test]
fn imports_a_legacy_snapshot_once_and_replays_it_without_snapshots() {
    let fixture = Fixture::new(25);
    let legacy = json!({ "campaign": "Ashes", "hp": 17, "messages": [{ "id": "m1", "text": "start" }] });
    let mut import = LegacyImportRequest::new("campaign-one", legacy.clone());
    import.idempotency_key = Some("legacy-import-1".into());
    import.ruleset_id = "legacy_5e".into();
    import.ruleset_version = "2014".into();
    let imported = fixture.store.import_legacy_snapshot(import).expect("импорт");
    assert!(!imported.duplicate);
    assert_eq!(imported.state_version, 1);
    assert_eq!(imported.state["hp"], 17);
    assert_eq!(imported.state["state_version"], 1);
    assert_eq!(imported.events[0]["event_type"], "LegacyStateImported");
    assert_eq!(imported.metadata["ruleset_id"], "legacy_5e");

    let replayed = fixture.store.load("campaign-one", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect("replay");
    assert_eq!(replayed.state, imported.state);

    let mut again = LegacyImportRequest::new("campaign-one", legacy);
    again.idempotency_key = Some("legacy-import-1".into());
    let duplicate = fixture.store.import_legacy_snapshot(again).expect("повтор");
    assert!(duplicate.duplicate);
    assert_eq!(fixture.store.get_events("campaign-one", 0, None).expect("события").len(), 1);
}

#[test]
fn appends_batches_snapshots_and_replays_historical_versions() {
    let fixture = Fixture::new(2);
    init(&fixture.store, "combat", json!({ "hp": 10 }));
    let mut first = request("combat", 0, "turn-1", vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 3 } })]);
    first.command_id = Some("damage-command".into());
    let first = fixture.store.commit(first).expect("урон");
    assert_eq!(first.state["hp"], 7);
    assert_eq!(first.state_version, 1);
    let second = fixture.store.commit(request("combat", 1, "turn-2", vec![json!({ "event_type": "HealingApplied", "payload": { "amount": 2 } })])).expect("лечение");
    assert_eq!(second.state["hp"], 9);
    assert_eq!(second.state_version, 2);
    assert!(snapshot_versions(&fixture, "combat").contains(&2));

    let at_one = fixture.store.load("combat", &LoadOptions { at_version: Some(1), ..Default::default() }).expect("версия 1");
    assert_eq!(at_one.state["hp"], 7);
    assert_eq!(at_one.state["state_version"], 1);
    let kinds: Vec<Value> = fixture.store.get_events("combat", 0, None).expect("события").iter().map(|event| event["event_type"].clone()).collect();
    assert_eq!(kinds, vec![json!("DamageApplied"), json!("HealingApplied")]);

    let restored = fixture.reopen().load("combat", &LoadOptions::default()).expect("после перезапуска");
    assert_eq!(restored.state["hp"], 9);
    assert_eq!(restored.state_version, 2);
}

#[test]
fn enforces_idempotency_before_optimistic_locking_and_rejects_key_reuse() {
    let fixture = Fixture::new(25);
    init(&fixture.store, "locking", json!({ "hp": 12 }));
    let base = request("locking", 0, "same-request", vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 2 } })]);
    fixture.store.commit(base.clone()).expect("первый");
    let retry = fixture.store.commit(base.clone()).expect("повтор");
    assert!(retry.duplicate);
    assert_eq!(retry.state_version, 1);
    assert_eq!(retry.state["hp"], 10);

    let mut other_events = base.clone();
    other_events.events = vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 8 } })];
    assert_eq!(fixture.store.commit(other_events).expect_err("другой запрос под тем же ключом").code, "IDEMPOTENCY_CONFLICT");
    let mut new_key = base;
    new_key.idempotency_key = "new-request".into();
    let conflict = fixture.store.commit(new_key).expect_err("устаревшая версия");
    assert_eq!(conflict.code, "VERSION_CONFLICT");
    assert_eq!(conflict.details["actual_state_version"], 1);
    assert_eq!(fixture.store.get_events("locking", 0, None).expect("события").len(), 1);
}

#[test]
fn batch_writes_snapshot_past_the_interval_even_on_odd_version() {
    let fixture = Fixture::new(3);
    init(&fixture.store, "batched", json!({ "hp": 10 }));
    let commit = |version: i64, count: usize, force: bool| {
        let mut commit = request("batched", version, &format!("batch-{version}"), vec![json!({ "event_type": "HealingApplied", "payload": { "amount": 1 } }); count]);
        commit.force_snapshot = force;
        fixture.store.commit(commit).expect("пакет")
    };
    let events_applied = || fixture.store.load("batched", &LoadOptions::default()).expect("загрузка").events_applied;
    commit(0, 2, false);
    assert_eq!(events_applied(), 2);
    let at_four = commit(2, 2, false);
    assert_eq!(events_applied(), 0);
    assert_eq!(snapshot_versions(&fixture, "batched"), vec![0, 4]);
    let full = fixture.store.load("batched", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect("replay");
    assert_eq!(full.state, at_four.state);
    assert_eq!(fixture.store.load("batched", &LoadOptions { at_version: Some(3), ..Default::default() }).expect("v3").state["hp"], 13);

    commit(4, 1, true);
    assert_eq!(events_applied(), 0);
    commit(5, 2, false);
    assert_eq!(events_applied(), 2, "принудительный снимок начинает новый интервал");
    let last = commit(7, 1, false);
    assert_eq!(snapshot_versions(&fixture, "batched"), vec![0, 4, 5, 8]);
    let reopened = fixture.reopen();
    assert_eq!(reopened.load("batched", &LoadOptions::default()).expect("загрузка").events_applied, 0);
    assert_eq!(reopened.load("batched", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect("replay").state, last.state);
}

#[test]
fn snapshot_every_zero_disables_automatic_snapshots_but_keeps_forced() {
    let fixture = Fixture::new(0);
    init(&fixture.store, "manual", json!({ "hp": 10 }));
    let mut forced = heal("manual", 0, "manual");
    forced.force_snapshot = true;
    fixture.store.commit(forced).expect("принудительный");
    fixture
        .store
        .commit(request("manual", 1, "automatic-disabled", vec![json!({ "event_type": "HealingApplied", "payload": { "amount": 1 } }); 5]))
        .expect("пакет");
    assert_eq!(snapshot_versions(&fixture, "manual"), vec![0, 1]);
    let loaded = fixture.store.load("manual", &LoadOptions::default()).expect("загрузка");
    assert_eq!(loaded.events_applied, 5);
    assert_eq!(loaded.state["hp"], 16);
}

#[test]
fn reducer_failure_appends_nothing() {
    let fixture = Fixture::new(25);
    init(&fixture.store, "failure", json!({ "hp": 10 }));
    let error = fixture
        .store
        .commit(request("failure", 0, "bad", vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 1 } }), json!({ "event_type": "ReducerFailure" })]))
        .expect_err("редьюсер отказал");
    assert_eq!(error.code, "INVALID_REDUCER_RESULT");
    assert!(fixture.store.get_events("failure", 0, None).expect("события").is_empty());
    assert_eq!(fixture.store.load("failure", &LoadOptions::default()).expect("загрузка").state["hp"], 10);
}

#[test]
fn projection_outbox_survives_restart_until_acknowledged() {
    let fixture = Fixture::new(25);
    init(&fixture.store, "projection", json!({ "hp": 12 }));
    fixture.store.commit(request("projection", 0, "turn-1", vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 3 } })])).expect("коммит");
    let reopened = fixture.reopen();
    let pending = reopened.pending_projection("projection", true).expect("проекция").expect("есть хвост");
    assert_eq!(pending.checkpoint_version, 0);
    assert_eq!(pending.state_version, 1);
    assert_eq!(pending.state.expect("состояние")["hp"], 9);
    assert_eq!(pending.events.iter().map(|event| event["event_type"].clone()).collect::<Vec<_>>(), vec![json!("DamageApplied")]);
    reopened.acknowledge_projection("projection", 1, None).expect("отметка");
    assert!(reopened.pending_projection("projection", true).expect("проекция").is_none());
    assert_eq!(reopened.get_metadata("projection").expect("метаданные")["projection_checkpoint_version"], 1);
}

#[test]
fn head_loads_without_replay_but_stays_exact() {
    let fixture = Fixture::new(0);
    init(&fixture.store, "head", json!({ "hp": 20 }));
    for (index, amount) in [3, 4, 5].into_iter().enumerate() {
        fixture
            .store
            .commit(request("head", index as i64, &format!("hit-{index}"), vec![json!({ "event_type": "DamageApplied", "payload": { "amount": amount } })]))
            .expect("удар");
    }
    fixture.reducer.calls.store(0, Ordering::SeqCst);
    let first = fixture.store.load("head", &LoadOptions::default()).expect("голова");
    let second = fixture.store.load("head", &LoadOptions::default()).expect("голова");
    assert_eq!(fixture.reducer.calls.load(Ordering::SeqCst), 0, "голова после commit уже известна — replay не нужен");
    assert_eq!(first.state["hp"], 8);
    assert_eq!(first, second);

    let replayed = fixture.store.load("head", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect("replay");
    assert!(fixture.reducer.calls.load(Ordering::SeqCst) >= 3, "replay без снимков обязан переиграть поток");
    assert_eq!(replayed.state, second.state);
    fixture.reducer.calls.store(0, Ordering::SeqCst);
    assert_eq!(fixture.store.load("head", &LoadOptions { at_version: Some(2), ..Default::default() }).expect("v2").state["hp"], 13);
    assert_eq!(fixture.reducer.calls.load(Ordering::SeqCst), 2);

    // Коммит другого процесса меняет голову: кэш промахивается и видит его.
    let other = fixture.reopen();
    other.commit(request("head", 3, "other-process-hit", vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 2 } })])).expect("чужой коммит");
    let fresh = fixture.store.load("head", &LoadOptions::default()).expect("свежая голова");
    assert_eq!(fresh.state_version, 4);
    assert_eq!(fresh.state["hp"], 6);
}

#[test]
fn rcv01_lost_tail_requires_recovery_instead_of_rolling_back() {
    let fixture = Fixture::new(1);
    init(&fixture.store, "lost-tail", json!({ "hp": 10 }));
    fixture.store.commit(heal("lost-tail", 0, "heal-1")).expect("лечение");
    assert_eq!(fixture.store.load("lost-tail", &LoadOptions::default()).expect("голова").state["hp"], 11);
    fixture.sql("DELETE FROM commits WHERE campaign_id = 'lost-tail'");
    for store in [&fixture.store, &fixture.reopen()] {
        let errors = vec![
            store.load("lost-tail", &LoadOptions::default()).expect_err("load"),
            store.load("lost-tail", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect_err("replay"),
            store.get_metadata("lost-tail").expect_err("metadata"),
            store.pending_projection("lost-tail", true).expect_err("projection"),
            store.get_events("lost-tail", 0, None).expect_err("events"),
            store.get_by_idempotency_key("lost-tail", "heal-1").expect_err("by key"),
            store.acknowledge_projection("lost-tail", 0, None).expect_err("ack"),
            store.create_snapshot("lost-tail").expect_err("snapshot"),
            store.commit(heal("lost-tail", 0, "heal-again")).expect_err("commit"),
        ];
        for error in errors {
            recovery(error.clone(), "EVENT_LOG_TAIL_MISSING");
            assert_eq!(error.details["log_state_version"], 0);
            assert_eq!(error.details["evidence_state_version"], 1);
        }
    }
    assert!(fixture.store.get_events("lost-tail", 0, None).is_err());
    let commits: i64 = fixture.store.with_connection_mut(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))?)).expect("счёт");
    assert_eq!(commits, 0, "обрезанный журнал не дополняется новым коммитом");
}

#[test]
fn rcv01_metadata_and_newer_snapshot_both_count_as_evidence() {
    let by_metadata = Fixture::new(0);
    init(&by_metadata.store, "lost-last", json!({ "hp": 10 }));
    for version in 0..3 {
        by_metadata.store.commit(heal("lost-last", version, &format!("heal-{version}"))).expect("лечение");
    }
    by_metadata.sql("DELETE FROM commits WHERE campaign_id = 'lost-last' AND version_after = 3");
    let error = by_metadata.reopen().load("lost-last", &LoadOptions::default()).expect_err("потеря");
    recovery(error.clone(), "EVENT_LOG_TAIL_MISSING");
    assert_eq!(error.details["log_state_version"], 2);
    assert_eq!(error.details["evidence_state_version"], 3);
    assert_eq!(
        error.details["evidence"],
        json!([{ "source": "metadata.state_version", "state_version": 3 }, { "source": "metadata.current_version", "state_version": 3 }])
    );

    let by_snapshot = Fixture::new(0);
    init(&by_snapshot.store, "lost-metadata", json!({ "hp": 10 }));
    let mut forced = heal("lost-metadata", 0, "heal-0");
    forced.force_snapshot = true;
    by_snapshot.store.commit(forced).expect("лечение");
    by_snapshot.sql("DELETE FROM commits WHERE campaign_id = 'lost-metadata'; DELETE FROM campaigns WHERE campaign_id = 'lost-metadata';");
    let error = by_snapshot.reopen().load("lost-metadata", &LoadOptions::default()).expect_err("потеря");
    recovery(error.clone(), "EVENT_LOG_TAIL_MISSING");
    assert_eq!(error.details["evidence"], json!([{ "source": "snapshots/0000000000000001.json", "state_version": 1 }]));
}

#[test]
fn rcv02_lost_seed_requires_recovery_instead_of_empty_campaign() {
    let fresh = Fixture::new(0);
    let seed = json!({ "campaign": "Seed only in snapshot", "hp": 7 });
    init(&fresh.store, "lost-seed", seed.clone());
    fresh.sql("DELETE FROM snapshots WHERE campaign_id = 'lost-seed' AND state_version = 0");
    let reopened = fresh.reopen();
    recovery(reopened.load("lost-seed", &LoadOptions::default()).expect_err("load"), "SEED_SNAPSHOT_MISSING");
    recovery(reopened.load("lost-seed", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect_err("replay"), "SEED_SNAPSHOT_MISSING");
    recovery(reopened.initialize_campaign(InitializeRequest::new("lost-seed", seed.clone())).expect_err("init"), "SEED_SNAPSHOT_MISSING");
    recovery(reopened.commit(heal("lost-seed", 0, "heal-0")).expect_err("commit"), "SEED_SNAPSHOT_MISSING");
    assert!(reopened.get_events("lost-seed", 0, None).expect("события").is_empty(), "поверх пустого состояния ничего не записано");

    let played = Fixture::new(0);
    init(&played.store, "lost-seed-played", seed);
    played.store.commit(heal("lost-seed-played", 0, "heal-0")).expect("лечение");
    played.sql("DELETE FROM snapshots WHERE campaign_id = 'lost-seed-played' AND state_version = 0");
    let reopened = played.reopen();
    recovery(reopened.load("lost-seed-played", &LoadOptions::default()).expect_err("load"), "SEED_SNAPSHOT_MISSING");
    let explicit = reopened.load("lost-seed-played", &LoadOptions { from_initial: true, ..Default::default() }).expect("явный replay от фабрики");
    assert_eq!(explicit.state["hp"], 1);
    assert!(explicit.state.get("campaign").is_none());
}

#[test]
fn rcv02_head_lives_on_usable_snapshot_without_seed() {
    let fixture = Fixture::new(2);
    init(&fixture.store, "seed-and-snapshot", json!({ "hp": 10 }));
    for version in 0..3 {
        fixture.store.commit(heal("seed-and-snapshot", version, &format!("heal-{version}"))).expect("лечение");
    }
    assert_eq!(snapshot_versions(&fixture, "seed-and-snapshot"), vec![0, 2]);
    fixture.sql("DELETE FROM snapshots WHERE campaign_id = 'seed-and-snapshot' AND state_version = 0");
    let reopened = fixture.reopen();
    let head = reopened.load("seed-and-snapshot", &LoadOptions::default()).expect("голова");
    assert_eq!(head.state_version, 3);
    assert_eq!(head.state["hp"], 13, "голова собрана из снимка v2 и события v3");
    recovery(reopened.load("seed-and-snapshot", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect_err("replay"), "SEED_SNAPSHOT_MISSING");
    recovery(reopened.load("seed-and-snapshot", &LoadOptions { at_version: Some(1), ..Default::default() }).expect_err("v1"), "SEED_SNAPSHOT_MISSING");
}

#[test]
fn rcv02_legacy_import_stream_carries_its_own_state() {
    let fixture = Fixture::new(25);
    let mut import = LegacyImportRequest::new("legacy-seed", json!({ "hp": 17 }));
    import.idempotency_key = Some("legacy".into());
    fixture.store.import_legacy_snapshot(import).expect("импорт");
    fixture.store.commit(heal("legacy-seed", 1, "heal-1")).expect("лечение");
    fixture.sql("DELETE FROM snapshots WHERE campaign_id = 'legacy-seed' AND state_version = 0");
    let reopened = fixture.reopen();
    let replayed = reopened.load("legacy-seed", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect("replay");
    assert_eq!(replayed.state_version, 2);
    assert_eq!(replayed.state["hp"], 18);
    assert_eq!(reopened.load("legacy-seed", &LoadOptions::default()).expect("голова").state, replayed.state);
}

#[test]
fn rcv02_seed_with_lost_map_is_unusable() {
    let fixture = Fixture::new(0);
    init(&fixture.store, "seed-without-map", json!({ "hp": 9, "scene": { "map": { "width": 1, "height": 1, "cells": [{ "x": 0, "y": 0, "terrain": "floor" }] } } }));
    let stored: String = fixture
        .store
        .with_connection_mut(|conn| Ok(conn.query_row("SELECT body FROM snapshots WHERE campaign_id = 'seed-without-map'", [], |row| row.get(0))?))
        .expect("снимок");
    let snapshot: Value = serde_json::from_str(&stored).expect("JSON");
    assert_eq!(snapshot["state"]["scene"]["map"]["marker"], "skazanie:map-ref-v1", "карта в снимке — ссылкой");
    assert!(snapshot["state"]["scene"].get("cells").is_none());
    fixture.sql("DELETE FROM map_blobs");
    recovery(fixture.reopen().load("seed-without-map", &LoadOptions::default()).expect_err("карта потеряна"), "SEED_SNAPSHOT_UNUSABLE");
}

#[test]
fn maps_round_trip_through_snapshots() {
    let fixture = Fixture::new(1);
    let map = json!({ "width": 2, "height": 1, "cells": [{ "x": 0, "y": 0, "terrain": "floor" }, { "x": 1, "y": 0, "terrain": "wall" }] });
    init(&fixture.store, "maps", json!({ "hp": 1, "scene": { "map": map.clone(), "cells": [] }, "locationMaps": { "inn:0": { "version": 1, "cells": [{ "x": 3, "y": 4 }] } } }));
    fixture.store.commit(heal("maps", 0, "heal")).expect("лечение");
    let loaded = fixture.reopen().load("maps", &LoadOptions::default()).expect("загрузка");
    assert_eq!(loaded.state["scene"]["map"], map);
    assert_eq!(loaded.state["scene"]["cells"], json!([]), "без тактической карты клетки — пустые, как при ошибке разбора в JS");
    assert_eq!(loaded.state["locationMaps"]["inn:0"]["cells"], json!([{ "x": 3, "y": 4 }]));
}
