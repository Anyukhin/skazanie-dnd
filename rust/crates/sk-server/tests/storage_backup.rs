//! Подкоманда `skazanie-server backup` на настоящей базе SQLite: копия
//! остановленного хранилища восстанавливается в пустой каталог и даёт тот же
//! журнал; живой сервер (отметка писателя) — отказ `BACKUP_WRITER_ACTIVE`,
//! осознанный обход — копия с предупреждением; чужой ключ — отказ.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_infra::backup_service::{claim_storage_writer, ClaimWriterOptions};
use sk_server::storage_backup::{execute, BackupEnv, Outcome};
use sk_store::{CommitRequest, InitializeRequest, LoadOptions};

const CODE: &str = "BACKUP-SQLITE";
const SECRET: &str = "проверочный-ключ-копии-не-короче-32-байт";

fn open(storage: &Path) -> sk_store::EventStore {
    sk_tactics::cutover_audit::open_game_store(&storage.join("skazanie.sqlite"), Arc::new(sk_tactics::cutover_audit::GameReducer::new())).expect("журнал")
}

/// Кампания в три коммита в `<root>/storage`; база закрыта, сервер «остановлен».
fn storage(root: &Path) -> PathBuf {
    let storage = root.join("storage");
    let store = open(&storage);
    let state = json!({ "campaign_id": CODE, "engine_mode": "enforce", "mechanics": { "world_time": { "elapsed_minutes": 0 } } });
    store.initialize_campaign(InitializeRequest::new(CODE, state)).expect("кампания");
    for (index, key) in ["first", "second", "third"].iter().enumerate() {
        let event = json!({ "event_type": "TimeAdvanced", "actor_id": null, "target_ids": [], "payload": { "elapsed_minutes": 10 } });
        let request = CommitRequest { campaign_id: CODE.into(), expected_state_version: index as i64, idempotency_key: (*key).into(), events: vec![event], metadata: json!({}), ..CommitRequest::default() };
        store.commit(request).expect("коммит");
    }
    drop(store);
    storage
}

fn env(root: &Path, secret: &str) -> BackupEnv {
    BackupEnv { secret: Some(secret.to_string()), storage_dir: None, cwd: root.to_path_buf(), now: Arc::new(|| 1_796_000_000_000) }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| item.to_string()).collect()
}

fn done(outcome: Outcome) -> (Value, Option<Value>) {
    match outcome {
        Outcome::Done { result, warning } => (result, warning),
        other => panic!("ждали успех, получили {other:?}"),
    }
}

fn failed(outcome: Outcome) -> (String, String) {
    match outcome {
        Outcome::Failed { code, message } => (code, message),
        other => panic!("ждали отказ, получили {other:?}"),
    }
}

fn head(storage: &Path) -> (i64, Value) {
    let loaded = open(storage).load(CODE, &LoadOptions::default()).expect("загрузка");
    (loaded.state_version, (*loaded.state).clone())
}

#[test]
fn copy_of_stopped_storage_restores_the_same_journal() {
    let root = tempfile::tempdir().expect("каталог");
    let storage = storage(root.path());
    let expected = head(&storage);
    assert_eq!(expected.0, 3);

    // Без аргументов: DND_STORAGE_DIR не задан — ./storage, файл — ./backups/skazanie-<дата>.
    let (created, warning) = done(execute(&[], &env(root.path(), SECRET)));
    assert!(warning.is_none());
    assert_eq!(created["encrypted"], json!(true));
    assert_eq!(created["writer"]["state"], json!("absent"));
    let backup = root.path().join("backups").join("skazanie-2026-11-30T00-53-20Z.skzbackup");
    assert!(backup.is_file(), "{created}");
    assert!(created["file_count"].as_u64().unwrap() >= 1);

    let backup_arg = backup.to_string_lossy().into_owned();
    let (verified, _) = done(execute(&args(&["verify", &backup_arg]), &env(root.path(), SECRET)));
    assert_eq!(verified["verified"], json!(true));
    let (compared, _) = done(execute(&args(&["compare", "storage", &backup_arg]), &env(root.path(), SECRET)));
    assert_eq!(compared["identical"], json!(true), "{compared}");

    let (restored, _) = done(execute(&args(&["restore", &backup_arg, "restored"]), &env(root.path(), SECRET)));
    assert_eq!(restored["restored"], json!(true));
    assert_eq!(head(&root.path().join("restored")), expected, "восстановленная база даёт тот же журнал");

    // Повторное восстановление в непустой каталог — отказ, а не перезапись.
    let (code, _) = failed(execute(&args(&["restore", &backup_arg, "restored"]), &env(root.path(), SECRET)));
    assert_eq!(code, "RESTORE_TARGET_NOT_EMPTY");
    // Чужой ключ архив не открывает.
    let (code, _) = failed(execute(&args(&["verify", &backup_arg]), &env(root.path(), "другой-ключ-копии-тоже-длиннее-32-байт")));
    assert!(code.starts_with("BACKUP_"), "{code}");
}

#[test]
fn live_writer_is_refused_unless_allowed() {
    let root = tempfile::tempdir().expect("каталог");
    let storage = storage(root.path());
    let claim = claim_storage_writer(&storage, ClaimWriterOptions::default()).expect("отметка писателя");

    let (code, message) = failed(execute(&args(&["create", "storage", "live.skzbackup"]), &env(root.path(), SECRET)));
    assert_eq!(code, "BACKUP_WRITER_ACTIVE");
    assert!(message.contains("Остановите сервер") && message.contains("--allow-live"), "{message}");
    assert!(!root.path().join("live.skzbackup").exists(), "отказ не оставляет файла");

    let (created, warning) = done(execute(&args(&["create", "--allow-live", "storage", "live.skzbackup"]), &env(root.path(), SECRET)));
    assert_eq!(created["consistency"], json!("not_guaranteed"));
    assert_eq!(warning.expect("предупреждение")["warning"], json!("BACKUP_LIVE_WRITER"));
    drop(claim);
}
