//! Совместимость формата копии с JS (`fixtures/gen-backup-service.mjs`):
//! копию, снятую Node, Rust проверяет и восстанавливает; копию, снятую Rust,
//! проверяет и восстанавливает Node (если он есть: `SK_NODE` или установка
//! Codex). Секрет эталона выдуман и в манифесте лежит открыто.

mod common;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use sk_infra::backup_service::{compare_storage_to_backup, create_storage_backup, hostname, restore_storage_backup, verify_storage_backup, CreateBackupOptions, STORAGE_WRITER_MARKER};

use common::{fixture_path, node_binary};

fn manifest() -> Value {
    serde_json::from_str(&fs::read_to_string(fixture_path("backup-js.json")).expect("манифест")).expect("json")
}

fn decode(data: &Value) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(data.as_str().expect("base64")).expect("base64")
}

fn build_source(manifest: &Value, source: &Path) {
    for entry in manifest["files"].as_array().expect("файлы").iter().chain(manifest["skipped"].as_array().expect("пропуски")) {
        let path = source.join(entry["path"].as_str().expect("путь"));
        fs::create_dir_all(path.parent().expect("каталог")).expect("каталог");
        fs::write(path, decode(&entry["data"])).expect("файл");
    }
    fs::write(source.join(STORAGE_WRITER_MARKER), manifest["marker"].to_string()).expect("отметка");
}

fn assert_restored(manifest: &Value, target: &Path) {
    for entry in manifest["files"].as_array().expect("файлы") {
        let path = entry["path"].as_str().expect("путь");
        assert_eq!(fs::read(target.join(path)).expect(path), decode(&entry["data"]), "{path}");
    }
    for entry in manifest["skipped"].as_array().expect("пропуски") {
        assert!(!target.join(entry["path"].as_str().expect("путь")).exists(), "{}", entry["path"]);
    }
    assert!(!target.join(STORAGE_WRITER_MARKER).exists(), "отметка сервера в архив не попадает");
}

#[test]
fn js_backup_is_verified_and_restored_by_rust() {
    let manifest = manifest();
    let secret = manifest["secret"].as_str().expect("секрет");
    let backup = fixture_path("backup-js.skzbackup");
    let verified = verify_storage_backup(&backup, secret).expect("проверка копии JS");
    assert_eq!(verified["created_at"], manifest["created"]["created_at"]);
    assert_eq!(verified["file_count"], manifest["created"]["file_count"]);
    assert_eq!(verified["total_bytes"], manifest["created"]["total_bytes"]);
    let root = tempfile::tempdir().expect("каталог");
    let target = root.path().join("restored");
    let restored = restore_storage_backup(&backup, &target, secret).expect("восстановление копии JS");
    assert_eq!(restored["reconciliation"]["identical"], true);
    assert_restored(&manifest, &target);
    assert_eq!(compare_storage_to_backup(&target, &backup, secret).expect("сверка")["identical"], true);
    assert_eq!(verify_storage_backup(&backup, &format!("{secret}-wrong")).expect_err("чужой секрет").code(), Some("BACKUP_AUTHENTICATION_FAILED"));
}

#[test]
fn rust_backup_has_js_layout_and_is_restored_by_js() {
    let manifest = manifest();
    let secret = manifest["secret"].as_str().expect("секрет");
    let root = tempfile::tempdir().expect("каталог");
    let source = root.path().join("storage");
    build_source(&manifest, &source);
    let backup = root.path().join("backup-rust.skzbackup");
    let mut created = create_storage_backup(&CreateBackupOptions {
        now: Arc::new(|| sk_core::clock::parse_iso("2026-10-14T00:00:00.000Z").expect("время")),
        ..CreateBackupOptions::new(&source, &backup, secret)
    })
    .expect("копия Rust");
    created.as_object_mut().expect("итог").remove("backup_file");
    assert_eq!(created, manifest["created"], "итог создания тот же, что у JS (в том числе устаревшая отметка)");
    // Конверт той же формы.
    let envelope: Value = serde_json::from_str(&fs::read_to_string(&backup).expect("копия")).expect("json");
    assert_eq!(envelope["schema_version"], 1);
    assert_eq!(envelope["format"], "skazanie:encrypted-storage-backup-v1");
    assert_eq!(envelope["kdf"]["name"], "scrypt");
    assert_eq!(envelope["cipher"]["name"], "aes-256-gcm");
    let restored = root.path().join("restored");
    restore_storage_backup(&backup, &restored, secret).expect("восстановление Rust");
    assert_restored(&manifest, &restored);

    let Some(node) = node_binary() else {
        eprintln!("Node не найден (SK_NODE): проверка копии Rust средствами JS пропущена");
        return;
    };
    let output = std::process::Command::new(node)
        .arg(fixture_path("gen-backup-service.mjs"))
        .arg("verify")
        .arg(&backup)
        .arg(fixture_path("backup-js.json"))
        .output()
        .expect("node");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let report: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|_| panic!("ответ JS: {stdout}\n{}", String::from_utf8_lossy(&output.stderr)));
    assert_eq!(report["ok"], true, "JS не принял копию Rust: {report}");
    assert_eq!(report["payload_paths"], manifest["payload_paths"], "порядок файлов в архиве тот же, что у JS");
    assert_eq!(report["verify"]["file_count"], manifest["created"]["file_count"]);
    assert!(output.status.success());
}

#[test]
fn hostname_matches_node() {
    let Some(node) = node_binary() else {
        eprintln!("Node не найден (SK_NODE): сверка os.hostname() пропущена");
        return;
    };
    let output = std::process::Command::new(node).args(["-e", "process.stdout.write(require('os').hostname())"]).output().expect("node");
    assert_eq!(String::from_utf8_lossy(&output.stdout), hostname(), "та же машина должна узнаваться по отметке JS-сервера");
}
