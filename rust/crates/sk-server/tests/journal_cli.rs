//! Подкоманда `skazanie-server journal` (контракт — шапка
//! `test/kit/journal.mjs`): чтение, запись мимо сервера, порча хвоста и
//! seed-снимка дают тот же JSON и те же отказы, что ждёт набор JS.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_server::test_hooks::journal_cli::{run, Args, Corruption, Mode};
use sk_store::{CommitRequest, InitializeRequest};

const CODE: &str = "KIT-JOURNAL";

fn time_event(minutes: i64) -> Value {
    json!({ "event_type": "TimeAdvanced", "actor_id": null, "target_ids": [], "payload": { "elapsed_minutes": minutes } })
}

/// Хранилище `skazanie-*` во «временном каталоге» `root` с кампанией в два коммита.
fn storage(root: &Path) -> PathBuf {
    let storage = root.join("skazanie-journal-cli");
    let store = sk_tactics::cutover_audit::open_game_store(&storage.join("skazanie.sqlite"), Arc::new(sk_tactics::cutover_audit::GameReducer::new())).expect("журнал");
    let state = json!({ "campaign_id": CODE, "mechanics": { "world_time": { "elapsed_minutes": 0 } } });
    store.initialize_campaign(InitializeRequest::new(CODE, state)).expect("кампания");
    for (index, key) in ["first", "second"].iter().enumerate() {
        let request = CommitRequest { campaign_id: CODE.into(), expected_state_version: index as i64, idempotency_key: (*key).into(), events: vec![time_event(10)], metadata: json!({}), ..CommitRequest::default() };
        store.commit(request).expect("коммит");
    }
    store.acknowledge_projection(CODE, 2, None).expect("проекция догнала журнал");
    storage
}

fn args(storage: &Path, mode: Mode) -> Args {
    Args { storage: storage.to_path_buf(), campaign: CODE.into(), mode }
}

fn read(storage: &Path, temp: &Path) -> Result<Value, String> {
    run(&args(storage, Mode::Read { at_version: None, use_snapshots: true }), None, Some("test"), temp).map(|value| value.expect("JSON")).map_err(|error| error.message)
}

#[test]
fn read_append_and_corrupt_follow_the_kit_contract() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let storage = storage(temp.path());

    let journal = read(&storage, temp.path()).expect("чтение");
    assert_eq!(journal["campaign_id"], CODE);
    assert_eq!(journal["state_version"], 2);
    assert_eq!(journal["current_state_version"], 2);
    assert_eq!(journal["state"]["mechanics"]["world_time"]["elapsed_minutes"], 20);
    let commits = journal["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[1]["idempotency_key"], "second");
    assert_eq!((commits[1]["state_version_before"].clone(), commits[1]["state_version_after"].clone()), (json!(1), json!(2)));
    assert!(commits[0]["command_id"].is_string());
    assert_eq!(journal["events"].as_array().unwrap().len(), 2, "события плоско");
    assert_eq!(journal["pending_projection"], Value::Null);

    let before = run(&args(&storage, Mode::Read { at_version: Some(1), use_snapshots: false }), None, Some("test"), temp.path()).unwrap().unwrap();
    assert_eq!(before["state_version"], 1);
    assert_eq!(before["current_state_version"], 2);
    assert_eq!(before["state"]["mechanics"]["world_time"]["elapsed_minutes"], 10, "atVersion — состояние до второго коммита");

    let appended = run(&args(&storage, Mode::Append), Some(&json!({ "idempotency_key": "kit-append", "events": [time_event(5)] }).to_string()), Some("test"), temp.path()).unwrap().unwrap();
    assert_eq!(appended["state_version"], 3);
    assert_eq!(appended["duplicate"], false);
    assert_eq!(appended["events"][0]["event_type"], "TimeAdvanced");
    assert_eq!(appended["state"]["mechanics"]["world_time"]["elapsed_minutes"], 25);
    let repeated = run(&args(&storage, Mode::Append), Some(&json!({ "idempotency_key": "kit-append", "events": [time_event(5)], "expected_state_version": 2 }).to_string()), Some("test"), temp.path()).unwrap().unwrap();
    assert_eq!(repeated["duplicate"], true, "тот же ключ — прежний коммит");
    let offline = read(&storage, temp.path()).unwrap();
    assert_eq!(offline["pending_projection"], json!({ "checkpoint_version": 2, "state_version": 3 }), "коммит мимо сервера оставляет проекцию позади журнала");

    assert!(run(&args(&storage, Mode::Corrupt(Corruption::Tail)), None, Some("production"), temp.path()).is_err(), "порча — только при NODE_ENV=test");
    assert!(run(&args(&storage, Mode::Corrupt(Corruption::Tail)), None, Some("test"), &temp.path().join("elsewhere")).is_err(), "порча — только хранилища во временном каталоге");
    assert!(run(&args(&storage, Mode::Corrupt(Corruption::Tail)), None, Some("test"), temp.path()).unwrap().is_none());
    let broken = read(&storage, temp.path()).unwrap_err();
    assert!(broken.contains("CAMPAIGN_RECOVERY_REQUIRED") && broken.contains("EVENT_LOG_TAIL_MISSING"), "{broken}");

    let missing = run(&Args { storage: storage.clone(), campaign: "KIT-NONE".into(), mode: Mode::Read { at_version: None, use_snapshots: true } }, None, Some("test"), temp.path()).unwrap_err();
    assert!(missing.message.contains("Нет журнала кампании KIT-NONE"), "{}", missing.message);
    let empty = run(&args(&temp.path().join("skazanie-empty"), Mode::Read { at_version: None, use_snapshots: true }), None, Some("test"), temp.path()).unwrap_err();
    assert!(empty.message.contains("Нет журнала"), "{}", empty.message);
    assert!(!temp.path().join("skazanie-empty").join("skazanie.sqlite").exists(), "чтение не создаёт базу");
}

#[test]
fn seed_corruption_names_seed_snapshot_missing() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let storage = storage(temp.path());
    run(&args(&storage, Mode::Corrupt(Corruption::Seed)), None, Some("test"), temp.path()).unwrap();
    let broken = read(&storage, temp.path()).unwrap_err();
    assert!(broken.contains("CAMPAIGN_RECOVERY_REQUIRED") && broken.contains("SEED_SNAPSHOT_MISSING"), "{broken}");
}
