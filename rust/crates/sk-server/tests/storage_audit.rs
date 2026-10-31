//! Рабочая подкоманда `skazanie-server audit-storage` (С19): чистое
//! хранилище — код 0; накладка комнаты, разошедшаяся с журналом, — блокер и
//! код 1; хранилище живого сервера — отказ (код 3), база не открывается.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_server::storage_audit::{audit_for_cutover, exit_code, run as audit_storage_cli, Outcome, BLOCKERS_EXIT, REFUSED_EXIT};
use sk_server::test_hooks::room_cli::{run as room_cli, Command};
use sk_store::{CommitRequest, InitializeRequest, RoomOverlaySave, RoomOverlayWrite};

const CODE: &str = "AUDIT-ROOM";

/// Хранилище `skazanie-*` во «временном каталоге» `root`: кампания в два
/// коммита, проекция подтверждена, комната совпадает с журналом.
fn storage(root: &Path) -> PathBuf {
    let storage = root.join("skazanie-audit-storage");
    let store = sk_tactics::cutover_audit::open_game_store(&storage.join("skazanie.sqlite"), Arc::new(sk_tactics::cutover_audit::GameReducer::new())).expect("журнал");
    let state = json!({ "campaign_id": CODE, "engine_mode": "enforce", "mechanics": { "world_time": { "elapsed_minutes": 0 } } });
    store.initialize_campaign(InitializeRequest::new(CODE, state)).expect("кампания");
    for (index, key) in ["first", "second"].iter().enumerate() {
        let event = json!({ "event_type": "TimeAdvanced", "actor_id": null, "target_ids": [], "payload": { "elapsed_minutes": 10 } });
        let request = CommitRequest { campaign_id: CODE.into(), expected_state_version: index as i64, idempotency_key: (*key).into(), events: vec![event], metadata: json!({}), ..CommitRequest::default() };
        store.commit(request).expect("коммит");
    }
    store.acknowledge_projection(CODE, 2, None).expect("проекция догнала журнал");
    let body = json!({ "schema": 1, "base": { "campaign_id": CODE, "state_version": 2 }, "removed": [], "fields": { "messages": [] } });
    let saved = store.save_room_overlay(RoomOverlayWrite { room_id: CODE, expected_version: 0, body: &body, ack: None }).expect("накладка");
    assert!(matches!(saved, RoomOverlaySave::Saved { .. }));
    storage
}

fn report(storage: &Path) -> Value {
    match audit_for_cutover(storage) {
        Outcome::Report(report) => report,
        Outcome::Refused(error) => panic!("отказ: {error}"),
    }
}

fn blocker_codes(report: &Value) -> Vec<String> {
    report["blockers"].as_array().unwrap().iter().map(|blocker| blocker["code"].as_str().unwrap_or_default().to_string()).collect()
}

fn cli(storage: &Path) -> i32 {
    audit_storage_cli(&["--storage".to_string(), storage.to_string_lossy().into_owned(), "--json".to_string()])
}

#[test]
fn clean_storage_passes_drifted_overlay_blocks_live_server_refuses() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let storage = storage(temp.path());

    let clean = report(&storage);
    assert_eq!(blocker_codes(&clean), Vec::<String>::new(), "{clean}");
    assert_eq!(clean["ready"], true);
    assert_eq!(clean["campaigns"][0]["room"], true);
    assert_eq!(clean["campaigns"][0]["projection_matched"], true);
    assert_eq!(exit_code(&clean), 0);
    assert_eq!(cli(&storage), 0, "чистое хранилище — код 0");

    // Накладка подменена мимо сервера: каноническое поле разошлось с журналом.
    let room = room_cli(&Command::Room { storage: storage.clone(), campaign: CODE.into(), write: false }, "", Some("test"), temp.path()).expect("комната");
    let mut drifted = room["state"].clone();
    drifted["mechanics"]["world_time"]["elapsed_minutes"] = json!(99);
    room_cli(&Command::Room { storage: storage.clone(), campaign: CODE.into(), write: true }, &json!({ "state": drifted }).to_string(), Some("test"), temp.path()).expect("подмена накладки");

    let drifted = report(&storage);
    assert_eq!(blocker_codes(&drifted), vec!["PROJECTION_DIVERGENCE".to_string()], "{drifted}");
    assert_eq!(drifted["ready"], false);
    assert_eq!(exit_code(&drifted), BLOCKERS_EXIT);
    assert_eq!(cli(&storage), BLOCKERS_EXIT, "блокер — код 1");
    let text = sk_server::storage_audit::to_text(&drifted);
    assert!(text.contains("блокер PROJECTION_DIVERGENCE AUDIT-ROOM") && text.contains("запускать нельзя"), "{text}");
    // Тестовая подкоманда `audit` — та же сверка.
    let hooked = room_cli(&Command::Audit { storage: storage.clone() }, "", None, temp.path()).expect("тестовый аудит");
    assert_eq!(blocker_codes(&hooked), blocker_codes(&drifted));

    // На хранилище работает сервер (отметка писателя этого процесса) — отказ.
    let mut writer = sk_infra::backup_service::claim_storage_writer(&storage, Default::default()).expect("отметка писателя");
    let refused = audit_for_cutover(&storage);
    let code = cli(&storage);
    writer.release();
    match refused {
        Outcome::Refused(error) => assert!(error.contains("работает сервер"), "{error}"),
        Outcome::Report(report) => panic!("аудит живого хранилища: {report}"),
    }
    assert_eq!(code, REFUSED_EXIT, "живой сервер — отказ");
    assert_eq!(cli(&storage), BLOCKERS_EXIT, "отметка снята — аудит снова идёт");

    // Не хранилище Rust-сервера — отказ, база не создаётся.
    let empty = temp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(cli(&empty), REFUSED_EXIT);
    assert!(!empty.join("skazanie.sqlite").exists());
}
