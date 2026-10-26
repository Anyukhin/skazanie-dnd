//! Подкоманды `skazanie-server room` и `audit` (контракт — шапка
//! `test/kit/rooms.mjs`): комната собирается из журнала и накладки, запись
//! мимо сервера кладёт дрейф в накладку, аудит находит его так же, как
//! `auditLegacyCutover` JS находил расхождение файла комнаты.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_server::test_hooks::room_cli::{run, Command};
use sk_store::{CommitRequest, InitializeRequest, RoomOverlaySave, RoomOverlayWrite};

const CODE: &str = "KIT-ROOM";

/// Хранилище `skazanie-*` во «временном каталоге» `root`: кампания в два
/// коммита, проекция подтверждена, комната совпадает с журналом.
fn storage(root: &Path) -> PathBuf {
    let storage = root.join("skazanie-room-cli");
    let store = sk_tactics::cutover_audit::open_game_store(&storage.join("skazanie.sqlite"), Arc::new(sk_tactics::cutover_audit::GameReducer::new())).expect("журнал");
    let state = json!({ "campaign_id": CODE, "engine_mode": "enforce", "mechanics": { "world_time": { "elapsed_minutes": 0 } } });
    store.initialize_campaign(InitializeRequest::new(CODE, state)).expect("кампания");
    for (index, key) in ["first", "second"].iter().enumerate() {
        let event = json!({ "event_type": "TimeAdvanced", "actor_id": null, "target_ids": [], "payload": { "elapsed_minutes": 10 } });
        let request = CommitRequest { campaign_id: CODE.into(), expected_state_version: index as i64, idempotency_key: (*key).into(), events: vec![event], metadata: json!({}), ..CommitRequest::default() };
        store.commit(request).expect("коммит");
    }
    store.acknowledge_projection(CODE, 2, None).expect("проекция догнала журнал");
    // Накладка без отличий: комната — ровно голова журнала.
    let body = json!({ "schema": 1, "base": { "campaign_id": CODE, "state_version": 2 }, "removed": [], "fields": { "messages": [] } });
    let saved = store.save_room_overlay(RoomOverlayWrite { room_id: CODE, expected_version: 0, body: &body, ack: None }).expect("накладка");
    assert!(matches!(saved, RoomOverlaySave::Saved { .. }));
    storage
}

fn room(storage: &Path, write: bool) -> Command {
    Command::Room { storage: storage.to_path_buf(), campaign: CODE.into(), write }
}

fn blocker_codes(report: &Value) -> Vec<String> {
    report["blockers"].as_array().unwrap().iter().map(|blocker| blocker["code"].as_str().unwrap_or_default().to_string()).collect()
}

#[test]
fn room_reads_writes_drift_and_audit_finds_it() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let storage = storage(temp.path());

    let stored = run(&room(&storage, false), "", Some("test"), temp.path()).expect("чтение");
    assert_eq!(stored["version"], 1);
    assert_eq!(stored["state"]["state_version"], 2);
    assert_eq!(stored["state"]["mechanics"]["world_time"]["elapsed_minutes"], 20, "комната — голова журнала");
    assert_eq!(stored["state"]["messages"], json!([]), "поле только комнаты — из накладки");
    let missing = run(&Command::Room { storage: storage.clone(), campaign: "NO-ROOM".into(), write: false }, "", Some("test"), temp.path()).expect("чтение");
    assert_eq!(missing, Value::Null, "комнаты нет — null");

    let clean = run(&Command::Audit { storage: storage.clone() }, "", None, temp.path()).expect("аудит");
    assert_eq!(blocker_codes(&clean), Vec::<String>::new(), "{clean}");
    assert_eq!(clean["ready"], true);
    assert_eq!(clean["campaigns"][0]["projection_matched"], true);
    assert_eq!(clean["campaigns"][0]["room"], true);

    // Дрейф при той же версии: каноническое поле испорчено мимо журнала.
    let mut drifted = stored["state"].clone();
    drifted["mechanics"]["world_time"]["elapsed_minutes"] = json!(99);
    let input = json!({ "state": drifted }).to_string();
    for (node_env, temp_dir) in [(None, temp.path()), (Some("test"), storage.as_path())] {
        assert!(run(&room(&storage, true), &input, node_env, temp_dir).is_err(), "запись — только при NODE_ENV=test и хранилище во временном каталоге");
    }
    let written = run(&room(&storage, true), &input, Some("test"), temp.path()).expect("запись");
    assert_eq!(written["version"], 2, "версия комнаты — счётчик накладки");
    assert_eq!(written["state"]["mechanics"]["world_time"]["elapsed_minutes"], 99);
    assert_eq!(run(&room(&storage, false), "", Some("test"), temp.path()).expect("чтение"), written, "чтение видит записанный дрейф");

    let audited = run(&Command::Audit { storage: storage.clone() }, "", None, temp.path()).expect("аудит");
    assert_eq!(blocker_codes(&audited), vec!["PROJECTION_DIVERGENCE".to_string()], "{audited}");
    assert_eq!(audited["ready"], false);
    assert_eq!(audited["campaigns"][0]["projection_matched"], false);

    // Сдвинутая версия комнаты — отдельный блокер.
    let mut behind = stored["state"].clone();
    behind["state_version"] = json!(1);
    run(&room(&storage, true), &json!({ "state": behind }).to_string(), Some("test"), temp.path()).expect("запись");
    let audited = run(&Command::Audit { storage }, "", None, temp.path()).expect("аудит");
    assert!(blocker_codes(&audited).contains(&"PROJECTION_VERSION_DIVERGENCE".to_string()), "{audited}");
}
