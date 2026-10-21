//! Смысловые проверки `test/trace-store.test.mjs`, касающиеся модуля
//! (без оркестратора): запись и чтение трасс, окно последних, фильтр,
//! `saveIfAbsent`, вычистка секретов и проекция разбора хода.

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_projection::trace_store::*;

struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        Self(std::env::temp_dir().join(format!("sk-p1-{name}-{}", hash::uuid_v4())))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn id(value: &str) -> Value {
    json!(value)
}

#[test]
fn trace_is_saved_restored_and_explained() {
    let dir = TempDir::new("trace");
    let store = FileTraceStore::new(&dir.0).expect("хранилище");
    store
        .save(&json!({ "turn_id": "turn-1", "campaign_id": "ROOM-1", "idempotency_key": "damage-once", "engine_mode": "enforce", "retrieved_rule_ids": ["rule-1"],
            "validated_commands": [{ "command_type": "ApplyDamage" }], "rolls": [{ "total": 14 }], "events": [{ "event_type": "DamageApplied" }],
            "state_version_before": 1, "state_version_after": 2, "narration_result": { "narration": "Урон применён.", "suggestions": [], "provider": "deterministic", "verification": { "valid": true } } }))
        .expect("запись");
    let stored = store.get(Some(&id("ROOM-1")), Some(&id("turn-1"))).expect("чтение").expect("трасса");
    let explanation = build_turn_explanation(Some(&stored), None);
    assert_eq!(explanation["engine_mode"], "enforce");
    assert_eq!(explanation["rules_used"], json!(["rule-1"]));
    let latest = store.latest(Some(&id("ROOM-1")), None).expect("чтение").expect("трасса");
    assert_eq!((latest["turn_id"].clone(), latest["idempotency_key"].clone()), (id("turn-1"), id("damage-once")));
    assert_eq!(latest["narration_result"]["narration"], "Урон применён.");
}

#[test]
fn secrets_are_redacted_before_write() {
    let redacted = redact_trace(Some(&json!({ "apiKey": "sk-secret-value-123456", "nested": { "authorization": "Bearer abc.def", "text": "ok" } }))).expect("трасса");
    assert_eq!(redacted["apiKey"], "[REDACTED]");
    assert_eq!(redacted["nested"]["authorization"], "[REDACTED]");
    assert_eq!(redacted["nested"]["text"], "ok");
}

#[test]
fn recent_window_and_predicate() {
    let dir = TempDir::new("recent");
    let store = FileTraceStore::new(&dir.0).expect("хранилище");
    for index in 1..=4 {
        store
            .save(&json!({ "turn_id": format!("turn-{index}"), "campaign_id": "ROOM-RECENT", "created_at": format!("2026-07-29T20:00:0{index}.000Z"), "narration_result": { "narration": format!("Текст {index}.") } }))
            .expect("запись");
    }
    let recent: Vec<Value> = store.recent(Some(&id("ROOM-RECENT")), Some(&json!(3)), None).expect("окно").into_iter().map(|trace| trace["turn_id"].clone()).collect();
    assert_eq!(recent, [id("turn-4"), id("turn-3"), id("turn-2")]);
    assert_eq!(store.latest(Some(&id("ROOM-RECENT")), None).expect("чтение").expect("трасса")["turn_id"], "turn-4");

    store
        .save(&json!({ "turn_id": "turn-mechanics", "campaign_id": "ROOM-FILTER", "created_at": "2026-07-29T20:00:01.000Z", "events": [{ "event_type": "DamageApplied" }], "narration_result": { "narration": "Урон." } }))
        .expect("запись");
    store
        .save(&json!({ "turn_id": "turn-question", "campaign_id": "ROOM-FILTER", "created_at": "2026-07-29T20:00:02.000Z", "events": [], "narration_result": { "narration": "Ответ." } }))
        .expect("запись");
    assert_eq!(store.latest(Some(&id("ROOM-FILTER")), None).expect("чтение").expect("трасса")["turn_id"], "turn-question");
    let mechanical = |trace: &Value| is_mechanical_trace(Some(trace));
    assert_eq!(store.latest(Some(&id("ROOM-FILTER")), Some(&mechanical)).expect("чтение").expect("трасса")["turn_id"], "turn-mechanics");
}

#[test]
fn explanation_projects_private_knowledge_per_hero() {
    let trace = json!({ "turn_id": "private-turn", "engine_mode": "enforce", "retrieved_rule_ids": [], "validated_commands": [], "rolls": [], "events": [
        { "event_type": "KnowledgeRevealed", "visibility": "specific_player", "target_ids": ["hero"], "payload": { "fact_id": "fact:secret", "summary": "hidden route" } },
        { "event_type": "QuestClockAdvanced", "visibility": "party", "payload": { "quest_id": "quest:open" } },
    ] });
    let hero = js::stringify(&build_turn_explanation(Some(&trace), Some(&json!({ "playerId": "hero", "isPartyMember": true, "role": "player" }))));
    let rogue = js::stringify(&build_turn_explanation(Some(&trace), Some(&json!({ "playerId": "rogue", "isPartyMember": true, "role": "player" }))));
    assert!(hero.contains("hidden route"));
    assert!(!rogue.contains("hidden route") && !rogue.contains("fact:secret"));
    assert!(rogue.contains("quest:open"));
    let migrated = build_turn_explanation(Some(&trace), None);
    assert_eq!(migrated["schema_version"], TURN_TRACE_SCHEMA_VERSION);
    assert_eq!(migrated["proposal_id"], Value::Null);
}

#[test]
fn save_if_absent_keeps_existing_trace() {
    let dir = TempDir::new("absent");
    let store = FileTraceStore::new(&dir.0).expect("хранилище");
    let (_, created) = store
        .save_if_absent(&json!({ "turn_id": "turn-1", "campaign_id": "ROOM-ABSENT", "events": [{ "event_type": "DamageApplied" }], "recovery": { "reason": "trace_missing_after_commit" } }))
        .expect("запись");
    assert!(created);
    let get = || store.get(Some(&id("ROOM-ABSENT")), Some(&id("turn-1"))).expect("чтение").expect("трасса");
    assert_eq!(get()["recovery"]["reason"], "trace_missing_after_commit");
    let (_, created) = store.save_if_absent(&json!({ "turn_id": "turn-1", "campaign_id": "ROOM-ABSENT", "events": [] })).expect("запись");
    assert!(!created);
    assert_eq!(get()["events"].as_array().map(Vec::len), Some(1));
    store.save(&json!({ "turn_id": "turn-1", "campaign_id": "ROOM-ABSENT", "events": [{ "event_type": "DamageApplied" }], "narration_result": { "narration": "Полная трасса." } })).expect("запись");
    assert!(get().get("recovery").is_none());
}

#[test]
fn unsafe_ids_are_refused() {
    let dir = TempDir::new("ids");
    let store = FileTraceStore::new(&dir.0).expect("хранилище");
    for (campaign, turn) in [("../x", "t"), ("ROOM", "bad id"), ("", "t")] {
        assert!(store.get(Some(&id(campaign)), Some(&id(turn))).is_err(), "{campaign}/{turn}");
    }
    assert!(FileTraceStore::new("").is_err());
}
