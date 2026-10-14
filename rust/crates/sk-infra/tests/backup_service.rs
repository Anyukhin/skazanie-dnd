//! Перенос `test/backup-service.test.mjs` и сервисной части
//! `test/storage-backup-cli.test.mjs`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_infra::backup_service::{
    claim_storage_writer, compare_storage_to_backup, create_storage_backup, hostname, inspect_storage_writer, restore_storage_backup, verify_storage_backup, BackupError, ClaimWriterOptions,
    CreateBackupOptions, InspectWriterOptions, STORAGE_WRITER_MARKER,
};

const SECRET: &str = "test-only-backup-secret-with-more-than-32-bytes";

fn code(result: Result<Value, BackupError>) -> String {
    match result {
        Ok(value) => panic!("ожидался отказ, получено {value}"),
        Err(error) => error.code().unwrap_or("io").to_string(),
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().expect("каталог")).expect("каталог");
    fs::write(path, text).expect("файл");
}

fn create(source: &Path, backup: &Path) -> Result<Value, BackupError> {
    create_storage_backup(&CreateBackupOptions::new(source, backup, SECRET))
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory).expect("каталог").map(|entry| entry.expect("запись").file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn encrypted_backup_verifies_restores_and_reconciles_byte_for_byte() {
    let root = tempfile::tempdir().expect("каталог");
    let source = root.path().join("storage");
    write(&source.join("auth.json"), "{\"users\":[{\"id\":\"u1\"}]}\\n");
    write(&source.join("engine/campaign-a/events/event.json"), "{\"event_type\":\"SceneAdvanced\"}\\n");
    let backup = root.path().join("backups/storage.skzbackup");
    let created = create_storage_backup(&CreateBackupOptions {
        now: Arc::new(|| sk_core::clock::parse_iso("2026-07-24T20:00:00.000Z").expect("время")),
        ..CreateBackupOptions::new(&source, &backup, SECRET)
    })
    .expect("копия");
    assert_eq!(created["file_count"], 2);
    assert_eq!(created["encrypted"], true);
    assert_eq!(created["created_at"], "2026-07-24T20:00:00.000Z");
    let text = fs::read_to_string(&backup).expect("копия");
    assert!(!text.contains("SceneAdvanced") && !text.contains("users"));

    let verified = verify_storage_backup(&backup, SECRET).expect("проверка");
    assert_eq!(verified["verified"], true);
    let target = root.path().join("restored");
    let restored = restore_storage_backup(&backup, &target, SECRET).expect("восстановление");
    assert_eq!(restored["reconciliation"]["identical"], true);
    assert_eq!(fs::read(target.join("auth.json")).expect("файл"), fs::read(source.join("auth.json")).expect("файл"));
    assert_eq!(compare_storage_to_backup(&target, &backup, SECRET).expect("сверка"), json!({ "identical": true, "missing": [], "unexpected": [], "changed": [] }));
}

#[test]
fn authentication_immutable_output_and_non_empty_target_fail_closed() {
    let root = tempfile::tempdir().expect("каталог");
    let source = root.path().join("storage");
    write(&source.join("room.json"), "{\"version\":1}\\n");
    let backup = root.path().join("backup.skzbackup");
    create(&source, &backup).expect("копия");
    assert_eq!(code(verify_storage_backup(&backup, &format!("{SECRET}-wrong"))), "BACKUP_AUTHENTICATION_FAILED");
    assert_eq!(code(create(&source, &backup)), "BACKUP_ALREADY_EXISTS");
    let occupied = root.path().join("occupied");
    write(&occupied.join("keep.txt"), "keep");
    assert_eq!(code(restore_storage_backup(&backup, &occupied, SECRET)), "RESTORE_TARGET_NOT_EMPTY");
}

#[test]
fn reconciliation_reports_changed_missing_and_unexpected_files() {
    let root = tempfile::tempdir().expect("каталог");
    let source = root.path().join("storage");
    write(&source.join("a.json"), "a");
    write(&source.join("b.json"), "b");
    let backup = root.path().join("backup.skzbackup");
    create(&source, &backup).expect("копия");
    write(&source.join("a.json"), "changed");
    fs::remove_file(source.join("b.json")).expect("удаление");
    write(&source.join("c.json"), "unexpected");
    assert_eq!(
        compare_storage_to_backup(&source, &backup, SECRET).expect("сверка"),
        json!({ "identical": false, "missing": ["b.json"], "unexpected": ["c.json"], "changed": ["a.json"] })
    );
}

// Аудит PR #131, RCV-05 / SEC-07: копия с работающего сервера может собрать
// журнал и metadata из разных моментов. По умолчанию она не снимается.
fn writer_sandbox() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().expect("каталог");
    let source = root.path().join("storage");
    write(&source.join("room.json"), "{\"version\":1}\n");
    (root, source)
}

fn write_marker(source: &Path, marker: Value) {
    fs::write(source.join(STORAGE_WRITER_MARKER), marker.to_string()).expect("отметка");
}

fn now_iso(offset_ms: i64) -> String {
    sk_core::clock::iso(sk_core::clock::now_ms() + offset_ms)
}

/// pid процесса, который уже завершился.
fn dead_pid() -> u32 {
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "exit"]);
        command
    } else {
        std::process::Command::new("true")
    };
    let mut child = command.spawn().expect("процесс");
    let pid = child.id();
    child.wait().expect("завершение");
    pid
}

#[test]
fn live_server_refuses_backup_and_explicit_override_marks_it() {
    let (root, source) = writer_sandbox();
    write_marker(&source, json!({ "writer_id": "live", "pid": std::process::id(), "host": hostname(), "heartbeat_at": now_iso(0) }));
    let backup = root.path().join("live.skzbackup");
    let error = create(&source, &backup).expect_err("отказ");
    assert_eq!(error.code(), Some("BACKUP_WRITER_ACTIVE"));
    assert_eq!(error.details().expect("поля")["writer"]["pid"], std::process::id());
    assert!(error.to_string().starts_with("Storage is in use by a running server (pid "));
    assert!(!backup.exists(), "отказ не оставляет файла копии");

    let forced = create_storage_backup(&CreateBackupOptions { allow_live_writer: true, ..CreateBackupOptions::new(&source, &backup, SECRET) }).expect("обход");
    assert_eq!(forced["writer"]["state"], "live");
    assert_eq!(forced["consistency"], "not_guaranteed");
    // Отметка — состояние процесса, а не данные: в архив она не попадает.
    assert_eq!(forced["file_count"], 1);
    let restored = root.path().join("restored");
    restore_storage_backup(&backup, &restored, SECRET).expect("восстановление");
    assert_eq!(names(&restored), ["room.json"]);
    assert_eq!(compare_storage_to_backup(&source, &backup, SECRET).expect("сверка")["identical"], true);
}

#[test]
fn stale_marker_of_stopped_server_does_not_block_backup() {
    let (root, source) = writer_sandbox();
    // Та же машина, процесса уже нет (сервер убит без очистки).
    write_marker(&source, json!({ "writer_id": "dead", "pid": dead_pid(), "host": hostname(), "heartbeat_at": now_iso(0) }));
    let after_crash = create(&source, &root.path().join("crash.skzbackup")).expect("копия");
    assert_eq!(after_crash["writer"]["state"], "stale");
    assert_eq!(after_crash["writer"]["reason"], "process_not_running");
    assert_eq!(after_crash.get("consistency"), None);

    // Другая машина (контейнер): pid не проверить, решает давность сигнала.
    write_marker(&source, json!({ "writer_id": "remote-old", "pid": 1, "host": "container-elsewhere", "heartbeat_at": now_iso(-10 * 60_000) }));
    let after_stop = create(&source, &root.path().join("stopped.skzbackup")).expect("копия");
    assert_eq!(after_stop["writer"]["state"], "stale");
    assert_eq!(after_stop["writer"]["reason"], "heartbeat_expired");

    // Свежий сигнал с другой машины — сервер жив, копия отказывает.
    write_marker(&source, json!({ "writer_id": "remote-live", "pid": 1, "host": "container-elsewhere", "heartbeat_at": now_iso(0) }));
    assert_eq!(code(create(&source, &root.path().join("remote.skzbackup"))), "BACKUP_WRITER_ACTIVE");

    // Без отметки сервера нет вовсе.
    fs::remove_file(source.join(STORAGE_WRITER_MARKER)).expect("удаление");
    let idle = create(&source, &root.path().join("idle.skzbackup")).expect("копия");
    assert_eq!(idle["writer"], json!({ "state": "absent" }));
}

#[test]
fn server_claims_writer_and_removes_only_its_own_marker() {
    let (_root, source) = writer_sandbox();
    let mut claim = claim_storage_writer(&source, ClaimWriterOptions::default()).expect("отметка");
    let live = inspect_storage_writer(&source, &InspectWriterOptions::default()).expect("состояние");
    assert_eq!(live["state"], "live");
    assert_eq!(live["pid"], std::process::id());
    assert_eq!(live["host"], hostname());
    claim.release();
    assert_eq!(inspect_storage_writer(&source, &InspectWriterOptions::default()).expect("состояние")["state"], "absent");

    // Отметку уже переписал новый сервер на том же каталоге — старый её не трогает.
    let stale = claim_storage_writer(&source, ClaimWriterOptions::default()).expect("отметка");
    write_marker(&source, json!({ "writer_id": "newer-server", "pid": std::process::id(), "host": hostname(), "heartbeat_at": now_iso(0) }));
    drop(stale);
    let marker: Value = serde_json::from_str(&fs::read_to_string(source.join(STORAGE_WRITER_MARKER)).expect("отметка")).expect("json");
    assert_eq!(marker["writer_id"], "newer-server");
}

#[test]
fn claim_heartbeat_refreshes_marker() {
    let (_root, source) = writer_sandbox();
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
    let ticks = Arc::clone(&clock);
    let claim = claim_storage_writer(&source, ClaimWriterOptions { heartbeat_ms: 20, now: Arc::new(move || ticks.fetch_add(1_000, std::sync::atomic::Ordering::SeqCst)) }).expect("отметка");
    let read = || -> Value { serde_json::from_str(&fs::read_to_string(source.join(STORAGE_WRITER_MARKER)).expect("отметка")).expect("json") };
    let first = read();
    assert_eq!(first["schema_version"], 1);
    assert_eq!(first["writer_id"], claim.writer_id.as_str());
    std::thread::sleep(std::time::Duration::from_millis(150));
    let later = read();
    assert_ne!(later["heartbeat_at"], first["heartbeat_at"], "пульс обновляет время");
    assert_eq!(later["started_at"], first["started_at"]);
    drop(claim);
    assert!(!source.join(STORAGE_WRITER_MARKER).exists());
}

#[test]
fn unreadable_marker_is_judged_by_file_time() {
    let (_root, source) = writer_sandbox();
    fs::write(source.join(STORAGE_WRITER_MARKER), "not json").expect("отметка");
    let state = inspect_storage_writer(&source, &InspectWriterOptions::default()).expect("состояние");
    assert_eq!(state["state"], "live", "свежий файл без разборчивого времени — живой сервер");
    assert_eq!(state["pid"], Value::Null);
    let old = inspect_storage_writer(&source, &InspectWriterOptions { now: Arc::new(|| sk_core::clock::now_ms() + 10 * 60_000), ..InspectWriterOptions::default() }).expect("состояние");
    assert_eq!(old["reason"], "heartbeat_expired");
}

// test/storage-backup-cli.test.mjs: короткий ключ отвергается, и неудачная
// попытка не оставляет файла копии.
#[test]
fn short_secret_fails_and_leaves_no_backup_file() {
    let (root, source) = writer_sandbox();
    let backup = root.path().join("backups/short.skzbackup");
    let error = create_storage_backup(&CreateBackupOptions::new(&source, &backup, "too-short-key")).expect_err("короткий ключ");
    assert_eq!(error.code(), Some("BACKUP_SECRET_TOO_SHORT"));
    assert_eq!(error.to_string(), "Backup secret must contain at least 32 UTF-8 bytes");
    assert!(!backup.exists());
    assert!(!root.path().join("backups").exists());
}

#[test]
fn source_and_target_paths_are_validated() {
    let (root, source) = writer_sandbox();
    assert_eq!(code(create(&root.path().join("missing"), &root.path().join("x.skzbackup"))), "BACKUP_SOURCE_INVALID");
    assert_eq!(code(create(&source, &source.join("inside.skzbackup"))), "BACKUP_TARGET_INSIDE_SOURCE");
    // Имя, начинающееся с «..», path.relative принимает за выход наружу — как в JS.
    let dotted = create(&source, &source.join("..inside.skzbackup")).expect("копия внутри с «..»");
    assert_eq!(dotted["file_count"], 1);
    assert_eq!(code(verify_storage_backup(&root.path().join("absent.skzbackup"), SECRET)), "BACKUP_NOT_FOUND");
}

#[test]
fn tampered_envelope_is_refused() {
    let (root, source) = writer_sandbox();
    let backup = root.path().join("backup.skzbackup");
    create(&source, &backup).expect("копия");
    let envelope: Value = serde_json::from_str(&fs::read_to_string(&backup).expect("копия")).expect("json");
    let rewrite = |name: &str, change: &dyn Fn(&mut Value)| {
        let mut copy = envelope.clone();
        change(&mut copy);
        let file = root.path().join(name);
        fs::write(&file, copy.to_string()).expect("копия");
        file
    };
    let flipped = rewrite("flipped.skzbackup", &|value| {
        let text = value["ciphertext"].as_str().expect("шифр").to_string();
        let swapped = if text.starts_with('A') { format!("B{}", &text[1..]) } else { format!("A{}", &text[1..]) };
        value["ciphertext"] = json!(swapped);
    });
    assert_eq!(code(verify_storage_backup(&flipped, SECRET)), "BACKUP_AUTHENTICATION_FAILED");
    let short_iv = rewrite("iv.skzbackup", &|value| value["cipher"]["iv"] = json!("AAAA"));
    assert_eq!(code(verify_storage_backup(&short_iv, SECRET)), "BACKUP_AUTHENTICATION_FAILED");
    let format = rewrite("format.skzbackup", &|value| value["format"] = json!("other"));
    assert_eq!(code(verify_storage_backup(&format, SECRET)), "BACKUP_ENVELOPE_INVALID");
    let garbage = root.path().join("garbage.skzbackup");
    fs::write(&garbage, "not json").expect("копия");
    let error = verify_storage_backup(&garbage, SECRET).expect_err("не JSON");
    assert_eq!(error.to_string(), "Backup envelope is not valid JSON");
    assert_eq!(code(verify_storage_backup(&backup, "short")), "BACKUP_SECRET_TOO_SHORT");
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_not_allowed() {
    let (root, source) = writer_sandbox();
    std::os::unix::fs::symlink(source.join("room.json"), source.join("link.json")).expect("ссылка");
    assert_eq!(code(create(&source, &root.path().join("x.skzbackup"))), "BACKUP_SYMLINK_FORBIDDEN");
}
