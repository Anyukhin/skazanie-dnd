//! Перенос журнала прежнего `FileEventStore` в SQLite: эталон снят прогоном
//! JS (`fixtures/gen-legacy-store.mjs`) — файлы коммитов, снимки с картой по
//! хешу и импорт старого состояния. После переноса тот же редьюсер даёт то же
//! состояние, что JS.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use sk_store::{import_file_store, CommitRequest, EventStore, LoadOptions, Reducer, RetentionMode, StoreOptions};

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

#[test]
fn file_store_moves_into_sqlite_and_replays_to_the_same_state() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(fixtures.join("legacy-store-expected.json")).expect("эталон")).expect("JSON");
    let store = EventStore::in_memory(Arc::new(HpReducer), StoreOptions::default()).expect("хранилище");
    let report = import_file_store(&store, fixtures.join("legacy-store")).expect("перенос");
    assert_eq!(report.map_blobs, 1);
    let summary: Vec<(String, usize, i64, Option<String>)> =
        report.campaigns.iter().map(|campaign| (campaign.campaign_id.clone(), campaign.commits, campaign.state_version, campaign.skipped.clone())).collect();
    assert_eq!(summary, vec![("LEGACY-ONE".into(), 3, 3, None), ("LEGACY-TWO".into(), 2, 2, None)]);

    let one = store.load("LEGACY-ONE", &LoadOptions::default()).expect("первая кампания");
    assert_eq!(one.state, expected["one"]);
    let one_full = store.load("LEGACY-ONE", &LoadOptions { use_snapshots: Some(false), ..Default::default() }).expect("replay");
    assert_eq!(one_full.state["hp"], expected["one"]["hp"]);
    let two = store.load("LEGACY-TWO", &LoadOptions::default()).expect("вторая кампания");
    assert_eq!(two.state, expected["two"]);

    // Ключ идемпотентности прежнего журнала работает и после переноса.
    let retry = store
        .commit(CommitRequest {
            campaign_id: "LEGACY-ONE".into(),
            expected_state_version: 2,
            idempotency_key: "hit-2".into(),
            events: vec![json!({ "event_type": "DamageApplied", "payload": { "amount": 5 } })],
            ..Default::default()
        })
        .expect("повтор прежнего коммита");
    assert!(retry.duplicate);
    assert_eq!(retry.state_version, 3);

    // Повторный перенос не дублирует кампании.
    let again = import_file_store(&store, fixtures.join("legacy-store")).expect("повторный перенос");
    assert!(again.campaigns.iter().all(|campaign| campaign.skipped.is_some()));
}
