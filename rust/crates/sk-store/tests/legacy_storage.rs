//! Строгий перенос JS-хранилища для `import-legacy` (С19.2): журнал
//! проверяется, как его читает JS, непригодная кампания убирается целиком,
//! опись остального хранилища, накладка комнаты с версией файла.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use sk_store::{EventStore, LoadOptions, Reducer, RetentionMode, StoreOptions};

struct HpReducer;

impl Reducer for HpReducer {
    fn reducer_version(&self) -> i64 {
        15
    }

    fn normalize(&self, state: Value, _mode: RetentionMode) -> Value {
        state
    }

    fn apply(&self, mut state: Value, event: &Value, _mode: RetentionMode) -> Result<Value, String> {
        let hp = state.get("hp").and_then(Value::as_i64).unwrap_or(0);
        let amount = event["payload"].get("amount").and_then(Value::as_i64).unwrap_or(0);
        match event["event_type"].as_str() {
            Some("DamageApplied") => state["hp"] = json!((hp - amount).max(0)),
            Some("HealingApplied") => state["hp"] = json!(hp + amount),
            _ => {}
        }
        Ok(state)
    }
}

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join("legacy-store")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("каталог");
    for entry in std::fs::read_dir(from).expect("чтение").flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("копия");
        }
    }
}

fn memory_store() -> EventStore {
    EventStore::in_memory(Arc::new(HpReducer), StoreOptions::default()).expect("хранилище")
}

/// Проверка подкоманды: загрузка головы тем же редьюсером.
fn load_head(store: &EventStore, campaign_id: &str) -> Result<Vec<String>, sk_store::StoreError> {
    store.load(campaign_id, &LoadOptions::default()).map(|_| Vec::new())
}

fn copied_fixtures() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("каталог");
    let root = dir.path().join("engine");
    copy_dir(&fixtures(), &root);
    (dir, root)
}

#[test]
fn campaign_directory_is_the_js_layout() {
    // Каталоги эталона записаны `FileEventStore._layout` JS.
    assert_eq!(sk_store::legacy::legacy_campaign_directory("LEGACY-ONE"), "LEGACY-ONE-813bf182ce8a54f5");
    assert_eq!(sk_store::legacy::legacy_campaign_directory("LEGACY-TWO"), "LEGACY-TWO-a27c557e9dc0c064");
    let odd = sk_store::legacy::legacy_campaign_directory("-a b!!c-");
    assert!(odd.starts_with("a-b-c-"), "{odd}");
    assert!(sk_store::legacy::legacy_campaign_directory("!!!").starts_with("campaign-"));
}

#[test]
fn lost_tail_skips_the_campaign_and_keeps_the_rest() {
    let (_dir, root) = copied_fixtures();
    // Последний файл журнала и снимок исчезли, metadata помнит версию 3.
    let one = root.join("campaigns").join("LEGACY-ONE-813bf182ce8a54f5");
    std::fs::remove_file(one.join("events").join("0000000000000003-0000000000000003-fixture-9.json")).expect("порча");
    std::fs::remove_file(one.join("snapshots").join("0000000000000002.json")).expect("порча");
    let store = memory_store();
    let report = sk_store::import_file_store_verified(&store, &root, &load_head).expect("перенос");
    let one_report = report.campaigns.iter().find(|campaign| campaign.campaign_id == "LEGACY-ONE").expect("отчёт");
    assert_eq!(one_report.skipped_code.as_deref(), Some("CAMPAIGN_RECOVERY_REQUIRED"));
    assert!(one_report.skipped.as_deref().is_some_and(|reason| reason.contains("EVENT_LOG_TAIL_MISSING")), "{one_report:?}");
    assert_eq!(store.list_campaigns().expect("список"), vec![("LEGACY-TWO".to_string(), 2)], "битая кампания убрана из базы целиком");
    assert_eq!(store.load("LEGACY-TWO", &LoadOptions::default()).expect("вторая кампания").state["hp"], 19);
}

#[test]
fn foreign_directory_and_foreign_commit_are_corrupt() {
    // Чужой каталог: JS такую кампанию не открывал.
    let (_dir, root) = copied_fixtures();
    std::fs::rename(root.join("campaigns").join("LEGACY-TWO-a27c557e9dc0c064"), root.join("campaigns").join("LEGACY-TWO-copy")).expect("переименование");
    let store = memory_store();
    let report = sk_store::import_file_store_verified(&store, &root, &load_head).expect("перенос");
    let two = report.campaigns.iter().find(|campaign| campaign.directory == "LEGACY-TWO-copy").expect("отчёт");
    assert_eq!(two.skipped_code.as_deref(), Some("CORRUPT_EVENT_LOG"));
    assert_eq!(store.list_campaigns().expect("список").len(), 1);

    // Коммит чужой кампании в журнале — порча, как в `_readCommitFiles` JS.
    let (_dir, root) = copied_fixtures();
    let file = root.join("campaigns").join("LEGACY-TWO-a27c557e9dc0c064").join("events").join("0000000000000002-0000000000000002-fixture-15.json");
    let mut commit: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("коммит")).expect("JSON");
    commit["campaign_id"] = json!("LEGACY-ONE");
    std::fs::write(&file, commit.to_string()).expect("порча");
    let store = memory_store();
    let report = sk_store::import_file_store_verified(&store, &root, &load_head).expect("перенос");
    let two = report.campaigns.iter().find(|campaign| campaign.campaign_id == "LEGACY-TWO").expect("отчёт");
    assert!(two.skipped.as_deref().is_some_and(|reason| reason.contains("belongs to another campaign")), "{two:?}");
}

#[test]
fn verification_failure_removes_the_campaign() {
    let store = memory_store();
    let refuse = |_store: &EventStore, campaign_id: &str| -> Result<Vec<String>, sk_store::StoreError> {
        if campaign_id == "LEGACY-ONE" {
            Err(sk_store::StoreError::new("REPLAY_FAILED", "проверка не прошла"))
        } else {
            Ok(vec!["замечание".into()])
        }
    };
    let report = sk_store::import_file_store_verified(&store, fixtures(), &refuse).expect("перенос");
    assert_eq!(report.map_blobs, 1);
    let one = report.campaigns.iter().find(|campaign| campaign.campaign_id == "LEGACY-ONE").expect("отчёт");
    assert_eq!(one.skipped_code.as_deref(), Some("REPLAY_FAILED"));
    let two = report.campaigns.iter().find(|campaign| campaign.campaign_id == "LEGACY-TWO").expect("отчёт");
    assert_eq!(two.warnings, vec!["замечание".to_string()]);
    assert_eq!(store.list_campaigns().expect("список").len(), 1);
    assert!(store.load("LEGACY-ONE", &LoadOptions::default()).is_err());
}

#[test]
fn inventory_markers_and_empty_database() {
    let dir = tempfile::tempdir().expect("каталог");
    let root = dir.path();
    assert!(sk_store::legacy::legacy_markers(root).is_empty());
    for (path, body) in [
        ("auth.json", "{}"),
        ("auth.json.lock", "{}"),
        (".server-writer.json", "{}"),
        ("rooms/ROOM-1.json", "{}"),
        ("campaign-settings/ROOM-1.json", "{}"),
        ("engine/campaigns/ROOM-1-0000000000000000/metadata.json", "{}"),
        ("engine/maps/ab/x.json", "{}"),
        ("engine/llm-usage.json", "{}"),
        ("engine/roll-registry.json", "{}"),
        ("engine/.roll-registry.json.1.tmp", "{}"),
        ("engine/mystery.json", "{}"),
        ("turn-traces/ROOM-1/turn-1.json", "{}"),
        ("generated/npcs/a.png", "png"),
        ("map-library/index.json", "{}"),
        ("notes.txt", "?"),
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().expect("каталог")).expect("каталог");
        std::fs::write(file, body).expect("запись");
    }
    assert_eq!(sk_store::legacy::legacy_markers(root), vec!["auth.json", "rooms/", "campaign-settings/", "engine/campaigns/"]);
    let inventory = sk_store::legacy::legacy_inventory(root);
    assert_eq!(inventory.copy, vec!["engine/llm-usage.json", "engine/roll-registry.json", "generated/npcs/a.png", "map-library/index.json", "turn-traces/ROOM-1/turn-1.json"]);
    assert_eq!(inventory.unknown, vec!["engine/mystery.json", "notes.txt"]);
    let ignored: Vec<&str> = inventory.ignored.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(ignored, vec![".server-writer.json", "auth.json.lock", "engine/.roll-registry.json.1.tmp"]);

    let target = tempfile::tempdir().expect("каталог");
    assert_eq!(sk_store::legacy::copy_inventory(&inventory, root, target.path(), false).expect("копия"), 5);
    assert_eq!(std::fs::read_to_string(target.path().join("generated/npcs/a.png")).expect("файл"), "png");
    assert!(sk_store::legacy::copy_inventory(&inventory, root, target.path(), false).is_err(), "без overwrite не перезаписывает");

    let database = target.path().join("skazanie.sqlite");
    assert!(!sk_store::legacy::database_has_data(&database).expect("нет файла"));
    let store = EventStore::open(&database, Arc::new(HpReducer), StoreOptions::default()).expect("база");
    assert!(!sk_store::legacy::database_has_data(&database).expect("пустая база"));
    let overlay = sk_store::RoomOverlay { room_id: "ROOM-1".into(), version: 7, body: json!({ "fields": { "messages": [] } }), updated_at: "2026-10-01T00:00:00.000Z".into() };
    assert!(store.import_room_overlay(&overlay).expect("накладка"));
    assert!(!store.import_room_overlay(&sk_store::RoomOverlay { version: 9, ..overlay.clone() }).expect("повтор"), "существующая строка не трогается");
    assert_eq!(store.room_overlay("ROOM-1").expect("чтение"), Some(overlay));
    assert!(sk_store::legacy::database_has_data(&database).expect("база с данными"));
}

#[test]
fn accounts_report_counts_without_secrets_and_drops_expired_sessions() {
    use sk_store::accounts::{Accounts, LegacyAccountsReport};
    let dir = tempfile::tempdir().expect("каталог");
    let auth = json!({
        "users": [
            { "id": "u-1", "email": "gm@example.com", "name": "GM", "role": "admin", "passwordSalt": "aa", "passwordHash": "bb" },
            { "id": "u-2", "email": "pc@example.com", "name": "PC", "passwordSalt": "cc", "passwordHash": "dd" }
        ],
        "sessions": [
            { "tokenHash": "live", "userId": "u-1", "expiresAt": 2_000 },
            { "tokenHash": "old", "userId": "u-2", "expiresAt": 500 },
            { "tokenHash": "", "userId": "u-2", "expiresAt": 9_000 }
        ],
        "memberships": [{ "campaignId": "ROOM-1", "userId": "u-2", "role": "player", "heroIds": ["a"], "status": "active", "joinedAt": 1 }],
        "invites": [{ "id": "i-1", "campaignId": "ROOM-1", "tokenHash": "t", "heroIds": ["b"], "createdAt": 1 }]
    });
    std::fs::write(dir.path().join("auth.json"), auth.to_string()).expect("запись");
    let settings = dir.path().join("campaign-settings");
    std::fs::create_dir_all(&settings).expect("каталог");
    std::fs::write(settings.join("ROOM-1.json"), r#"{"improvMode":"chaos"}"#).expect("запись");
    std::fs::write(settings.join("BROKEN.json"), "{").expect("запись");
    std::fs::write(settings.join("lower.json"), "{}").expect("запись");

    let accounts = Accounts::in_memory().expect("аккаунты").with_clock(Arc::new(|| 1_000));
    let report = accounts.import_legacy_report(dir.path()).expect("перенос");
    assert_eq!(report, LegacyAccountsReport { users: 2, admins: 1, sessions: 1, sessions_expired: 2, memberships: 1, invites: 1, settings: 1, settings_rejected: 2 });
    assert_eq!(accounts.users_for_session_keys(&["live".to_string(), "old".to_string()]).expect("сессии").len(), 1);
    assert_eq!(accounts.get_campaign_ai_settings("ROOM-1").expect("настройки").improv_mode, "chaos");

    std::fs::write(dir.path().join("auth.json"), "{ испорчен").expect("порча");
    let error = Accounts::in_memory().expect("аккаунты").import_legacy_report(dir.path()).expect_err("порча — отказ");
    assert!(error.message.starts_with("Хранилище повреждено и не будет перезаписано автоматически"), "{}", error.message);
}
