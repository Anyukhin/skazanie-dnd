//! Смысловые проверки `test/cutover-audit.test.mjs` поверх `sk-store`: аудит
//! принимает сходящийся журнал, возвращает карту из хранилища, считает
//! устаревшую отметку проекции замечанием и не пропускает неподтверждённый
//! коммит. Дополнительно — то, что в JS ловили комнатой: подмена снимка
//! (`REPLAY_DIVERGENCE`) и потерянный хвост журнала (`CAMPAIGN_AUDIT_FAILED`).

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use sk_narration_base::projection_integrity::projection_hash;
use sk_rules::normalize::normalize_campaign_state;
use sk_store::{CommitRequest, EventStore, InitializeRequest, LoadOptions, StoreOptions};
use sk_tactics::cutover_audit::{audit_event_store, audit_legacy_cutover, open_game_store, GameReducer, TacticalMapCells, STORE_FILE};

const ID: &str = "CUTOVER-1";

fn store() -> (EventStore, Arc<GameReducer>) {
    let reducer = Arc::new(GameReducer::new());
    let store = EventStore::in_memory(reducer.clone(), StoreOptions::default()).expect("база").with_map_cells(Arc::new(TacticalMapCells));
    (store, reducer)
}

fn room(cells: Value) -> Value {
    normalize_campaign_state(&json!({ "sessionCode": ID, "campaign": "Cutover", "players": [], "messages": [], "scene": { "title": "Начало", "location": "", "turn": 0, "cells": cells } })).expect("нормализация")
}

fn floor_cells(size: i64) -> Value {
    Value::Array((0..size).flat_map(|y| (0..size).map(move |x| json!({ "x": x, "y": y, "type": "floor", "revealed": true }))).collect())
}

fn commit_roll(store: &EventStore) {
    store
        .commit(CommitRequest {
            campaign_id: ID.into(),
            expected_state_version: 0,
            idempotency_key: "roll-1".into(),
            command_id: Some("roll-1".into()),
            events: vec![json!({ "event_type": "PublicDieRolled", "actor_id": "hero", "target_ids": [], "payload": { "roll": { "id": "roll-1", "value": 17 } }, "source_rule_ids": [], "visibility": "public" })],
            ..CommitRequest::default()
        })
        .expect("коммит");
}

fn audit(store: &EventStore, reducer: &GameReducer) -> Value {
    audit_event_store(store, reducer, Path::new("storage")).expect("аудит")
}

fn has(list: &Value, code: &str) -> bool {
    list.as_array().into_iter().flatten().any(|item| item["code"] == code)
}

#[test]
fn audit_accepts_a_stream_that_matches_replay() {
    let (store, reducer) = store();
    store.initialize_campaign(InitializeRequest::new(ID, room(json!([])))).expect("кампания");
    let report = audit(&store, &reducer);
    assert_eq!(report["ready"], true, "{}", report["blockers"]);
    assert_eq!(report["schema_version"], 2);
    assert_eq!(report["campaign_count"], 1);
    assert_eq!(report["campaigns"][0]["replay_matched"], true);
    assert_eq!(report["campaigns"][0]["pending_projection"], false);
}

/// Снимок хранит карту ссылкой по хешу; аудит обязан вернуть её на место, иначе
/// голова со снимком никогда не сойдётся с replay (дефект JS от 2026-07-28).
#[test]
fn audit_restores_the_map_from_the_store_and_does_not_report_the_reference() {
    let (store, reducer) = store();
    store.initialize_campaign(InitializeRequest::new(ID, room(floor_cells(9)))).expect("кампания");
    store.create_snapshot(ID).expect("снимок");
    let report = audit(&store, &reducer);
    assert_eq!(report["campaigns"][0]["replay_matched"], true, "{}", report["blockers"]);
    assert!(!has(&report["blockers"], "REPLAY_DIVERGENCE"));
}

#[test]
fn stale_checkpoint_is_a_warning_while_the_projection_matches() {
    let (store, reducer) = store();
    store.initialize_campaign(InitializeRequest::new(ID, room(json!([])))).expect("кампания");
    commit_roll(&store);
    let loaded = store.load(ID, &LoadOptions::default()).expect("загрузка");
    store.acknowledge_projection(ID, loaded.state_version, Some(&"x".repeat(64))).expect("отметка");
    let report = audit(&store, &reducer);
    assert_eq!(report["ready"], true, "устаревшая отметка не блокирует выпуск: {}", report["blockers"]);
    assert!(has(&report["warnings"], "PROJECTION_CHECKPOINT_HASH_MISMATCH"));
    assert_eq!(report["warnings"][0]["reason"], "STALE_CHECKPOINT_AFTER_SCHEMA_CHANGE");

    // Отметка с сегодняшним хешем — без замечаний.
    store.acknowledge_projection(ID, loaded.state_version, Some(&projection_hash(&loaded.state))).expect("отметка");
    let report = audit(&store, &reducer);
    assert_eq!(report["warnings"], json!([]));
    assert_eq!(report["campaigns"][0]["projection_checkpoint_version"], 1);
}

#[test]
fn audit_fails_closed_on_an_unprojected_authoritative_commit() {
    let (store, reducer) = store();
    store.initialize_campaign(InitializeRequest::new(ID, room(json!([])))).expect("кампания");
    commit_roll(&store);
    let report = audit(&store, &reducer);
    assert_eq!(report["ready"], false);
    assert!(has(&report["blockers"], "PROJECTION_NOT_ACKNOWLEDGED"));
    assert_eq!(report["campaigns"][0]["pending_projection"], true);
}

#[test]
fn tampered_snapshot_is_a_replay_divergence() {
    let (store, reducer) = store();
    store.initialize_campaign(InitializeRequest::new(ID, room(json!([])))).expect("кампания");
    commit_roll(&store);
    store.create_snapshot(ID).expect("снимок");
    store
        .with_connection_mut(|conn| {
            let body: String = conn.query_row("SELECT body FROM snapshots WHERE campaign_id = ?1 AND state_version = 1", [ID], |row| row.get(0))?;
            let mut snapshot: Value = serde_json::from_str(&body)?;
            snapshot["state"]["campaign"] = json!("Подменено");
            snapshot["checksum"] = json!(sk_core::hash::sha256_hex(sk_core::js::stringify(&sk_store::stable::sort_object(&snapshot["state"]))));
            conn.execute("UPDATE snapshots SET body = ?1 WHERE campaign_id = ?2 AND state_version = 1", [serde_json::to_string(&snapshot)?, ID.to_string()])?;
            Ok(())
        })
        .expect("подмена снимка");
    let report = audit(&store, &reducer);
    assert_eq!(report["campaigns"][0]["replay_matched"], false);
    assert!(has(&report["blockers"], "REPLAY_DIVERGENCE"));
}

#[test]
fn lost_journal_tail_fails_the_campaign_audit_without_stopping_others() {
    let (store, reducer) = store();
    store.initialize_campaign(InitializeRequest::new(ID, room(json!([])))).expect("кампания");
    commit_roll(&store);
    store.initialize_campaign(InitializeRequest::new("CUTOVER-2", room(json!([])))).expect("вторая кампания");
    store
        .with_connection_mut(|conn| {
            conn.execute("DELETE FROM commits WHERE campaign_id = ?1 AND version_after = 1", [ID])?;
            Ok(())
        })
        .expect("потеря хвоста");
    let report = audit(&store, &reducer);
    assert_eq!(report["ready"], false);
    let failed = report["blockers"].as_array().into_iter().flatten().find(|item| item["code"] == "CAMPAIGN_AUDIT_FAILED").expect("отказ аудита");
    assert_eq!(failed["campaign_id"], ID);
    assert!(failed["error"].as_str().is_some_and(|error| !error.is_empty()));
    assert_eq!(report["campaigns"][0]["error"], failed["error"]);
    assert_eq!(report["campaigns"][1]["campaign_id"], "CUTOVER-2");
    assert_eq!(report["campaigns"][1]["replay_matched"], true);
}

#[test]
fn storage_without_a_database_is_an_empty_ready_report_and_stays_untouched() {
    let root = std::env::temp_dir().join(format!("sk-tactics-cutover-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let report = audit_legacy_cutover(Some(&root)).expect("аудит");
    assert_eq!(report["ready"], true);
    assert_eq!(report["campaign_count"], 0);
    assert!(!root.join(STORE_FILE).exists(), "аудит не создаёт базу");

    std::fs::create_dir_all(&root).expect("каталог");
    {
        let store = open_game_store(&root.join(STORE_FILE), Arc::new(GameReducer::new())).expect("база");
        store.initialize_campaign(InitializeRequest::new(ID, room(json!([])))).expect("кампания");
    }
    let report = audit_legacy_cutover(Some(&root)).expect("аудит");
    assert_eq!(report["campaign_count"], 1);
    assert_eq!(report["ready"], true, "{}", report["blockers"]);
    assert!(report["storage_root"].as_str().is_some_and(|path| Path::new(path).is_absolute()));
    let _ = std::fs::remove_dir_all(&root);
}
