//! Сверка нормализации, диагностики и проекции для зрителя `world_memory` с
//! эталоном `server/world-memory.mjs` (`fixtures/gen-world-memory-normalize.mjs`)
//! и проверки модуля из `test/world-memory*.test.mjs`.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_memory::world_memory::*;
use sk_society::retention_context::with_retention_mode;

fn legacy<T>(operation: impl FnOnce() -> T) -> T {
    with_retention_mode("legacy", operation).expect("режим legacy")
}

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "normalizeWorldMemory" => Outcome::of(normalize_world_memory(args.val(0))),
        "normalizeWorldMemoryLegacy" => Outcome::of(normalize_world_memory_legacy(args.val(0))),
        "normalizeWorldMemory@legacy" => Outcome::of(legacy(|| normalize_world_memory(args.val(0)))),
        "diagnoseWorldMemory" => Outcome::of(diagnose_world_memory(args.val(0))),
        "worldMemoryForViewer" => Outcome::of(world_memory_for_viewer(args.val(0), &args.obj(1))),
        "worldMemoryForViewer@legacy" => Outcome::of(legacy(|| world_memory_for_viewer(args.val(0), &args.obj(1)))),
        _ => Outcome::Unknown,
    }
}

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/world-memory-normalize.json"))
}

#[test]
fn normalization_and_projection_match_js() {
    let total = fixture().check(dispatch);
    assert!(total > 2_000, "эталон подозрительно мал: {total}");
}

/// Большая память за прежними пределами коллекций — тот же цикл, что в
/// генераторе и `test/world-memory.test.mjs`.
fn big_memory() -> Value {
    let entities: Vec<Value> = (0..501).map(|index| json!({ "id": format!("npc:long-{index}"), "kind": "npc", "name": format!("Long NPC {index}"), "visibility": "gm_only" })).collect();
    let facts: Vec<Value> = (0..2_001)
        .map(|index| json!({ "id": format!("fact:long-{index}"), "subject_id": format!("npc:long-{}", index % 501), "predicate": "remembered", "object": format!("Fact {index}"), "visibility": "gm_only" }))
        .collect();
    let relationships: Vec<Value> = (0..2_001)
        .map(|index| {
            json!({ "id": format!("relationship:long-{index}"), "from_entity_id": format!("npc:long-{}", index % 501), "relation": "knows",
                "to_entity_id": format!("npc:long-{}", (index + 1) % 501), "summary": format!("Relationship {index}"), "visibility": "gm_only" })
        })
        .collect();
    let quests: Vec<Value> = (0..301).map(|index| json!({ "id": format!("quest:long-{index}"), "title": format!("Quest {index}"), "summary": format!("Quest summary {index}"), "status": "active", "visibility": "gm_only" })).collect();
    let threads: Vec<Value> = (0..501).map(|index| json!({ "id": format!("thread:long-{index}"), "title": format!("Thread {index}"), "summary": format!("Thread summary {index}"), "status": "active", "visibility": "gm_only" })).collect();
    let claims: Vec<Value> = (0..2_001).map(|index| json!({ "id": format!("belief:long-{index}"), "holder_entity_id": format!("npc:long-{}", index % 501), "claim": format!("Belief {index}"), "visibility": "gm_only" })).collect();
    let summaries: Vec<Value> = (0..1_001).map(|index| json!({ "id": format!("summary:long-{index}"), "kind": "scene", "title": format!("Summary {index}"), "summary": format!("Summary text {index}"), "visibility": "gm_only" })).collect();
    let ledger: Vec<Value> = (0..5_001).map(|index| json!({ "id": format!("knowledge:long-{index}"), "hero_id": "hero", "fact_id": format!("fact:long-{}", index % 2_001), "source_kind": "knowledge_revealed" })).collect();
    json!({ "entities": entities, "facts": facts, "relationships": relationships, "quests": quests, "threads": threads, "epistemic_claims": claims, "summaries": summaries, "knowledge_ledger": ledger })
}

fn hash(value: &impl serde::Serialize) -> String {
    sk_core::hash::sha256_hex(serde_json::to_string(value).expect("JSON"))
}

#[test]
fn big_memory_keeps_records_beyond_legacy_limits() {
    let fixture = fixture();
    let expected = &fixture.root["bigHashes"];
    let big = big_memory();
    let normalized = normalize_world_memory(&big);
    for (key, length) in [("entities", 501), ("facts", 2_001), ("relationships", 2_001), ("quests", 301), ("threads", 501), ("epistemic_claims", 2_001), ("summaries", 1_001), ("knowledge_ledger", 5_001)] {
        assert_eq!(normalized[key].as_array().map(Vec::len), Some(length), "{key}");
    }
    assert!(normalized["knowledge"]["hero"].as_array().is_some_and(|facts| facts.contains(&json!(format!("fact:long-{}", 5_000 % 2_001)))));
    assert_eq!(hash(&normalized), expected["current"]);
    assert_eq!(hash(&normalize_world_memory_legacy(&big)), expected["legacy"]);
    let index = json!({ "entities": big["entities"], "facts": big["facts"], "knowledge": { "hero": big["facts"].as_array().map(|facts| facts.iter().map(|fact| fact["id"].clone()).collect::<Vec<_>>()) } });
    let from_index = normalize_world_memory(&index);
    assert_eq!(from_index["knowledge_ledger"].as_array().map(Vec::len), Some(2_001));
    assert_eq!(from_index["knowledge_ledger"][2_000]["fact_id"], "fact:long-2000");
    assert_eq!(hash(&from_index), expected["legacyIndex"]);
    assert_eq!(hash(&diagnose_world_memory(&big)), expected["diagnose"]);
    assert_eq!(hash(&world_memory_for_viewer(&big, &json!({ "playerId": "hero", "isPartyMember": true }))), expected["viewer"]);
}

/// `test/world-memory-index-equivalence.test.mjs`.
fn index_fixture() -> Value {
    let pairs = [("hero-b", "fact-2"), ("hero-a", "fact-1"), ("hero-b", "fact-1"), ("hero-a", "fact-1"), ("hero-a", "fact-3")];
    json!({
        "entities": [{ "id": "entity", "kind": "npc", "name": "Свидетель", "visibility": "party" }],
        "facts": (1..=3).map(|index| json!({ "id": format!("fact-{index}"), "subject_id": "entity", "predicate": "knows", "object": format!("Сведение {index}"), "source_event_ids": [format!("event-{index}")] })).collect::<Vec<_>>(),
        "knowledge_ledger": pairs.iter().enumerate().map(|(index, (hero, fact))| json!({ "id": format!("knowledge-{index}"), "hero_id": hero, "fact_id": fact })).collect::<Vec<_>>(),
        "knowledge": { "hero-a": ["fact-1", "fact-2"], "hero-c": ["fact-3"] },
    })
}

#[test]
fn knowledge_index_keeps_order_repeats_and_mixed_legacy_format() {
    for normalize in [normalize_world_memory as fn(&Value) -> Value, normalize_world_memory_legacy] {
        let memory = normalize(&index_fixture());
        assert_eq!(memory["knowledge"], json!({ "hero-b": ["fact-2", "fact-1"], "hero-a": ["fact-1", "fact-3", "fact-2"], "hero-c": ["fact-3"] }));
        assert_eq!(memory["knowledge_ledger"].as_array().map(Vec::len), Some(7));
        assert_eq!(normalize(&memory), memory);
    }
}

#[test]
fn prepared_memory_applies_events_like_the_common_path_and_stays_canonical() {
    let events = [
        json!({ "event_type": "WorldEntityUpserted", "payload": { "entity": { "id": "other", "kind": "npc", "name": "Другой свидетель" } } }),
        json!({ "event_type": "WorldFactRecorded", "payload": { "fact": { "id": "fact-new", "subject_id": "entity", "predicate": "knows", "object": "Новое сведение", "supersedes_fact_id": "fact-1" } } }),
        json!({ "event_type": "WorldRelationshipRecorded", "payload": { "relationship": { "id": "relation", "from_entity_id": "entity", "to_entity_id": "other", "relation": "knows", "summary": "Знакомы" } } }),
        json!({ "event_type": "QuestUpserted", "payload": { "schema_version": 2, "quest": { "id": "quest", "title": "Узнать правду", "status": "offered", "entity_ids": ["entity"] } } }),
        json!({ "event_type": "QuestAccepted", "payload": { "schema_version": 1, "quest_id": "quest" } }),
        json!({ "event_type": "QuestClockAdvanced", "payload": { "quest_id": "quest", "amount": 1 } }),
        json!({ "event_type": "QuestResolved", "payload": { "quest_id": "quest", "outcome": "success", "summary": "Правда установлена" } }),
        json!({ "event_type": "NarrativeThreadUpserted", "payload": { "thread": { "id": "thread", "title": "Новая нить", "quest_ids": ["quest"], "entity_ids": ["entity"] } } }),
        json!({ "event_type": "NarrativeThreadClockAdvanced", "payload": { "thread_id": "thread", "amount": 1 } }),
        json!({ "event_type": "NpcBeliefRecorded", "payload": { "claim": { "id": "claim", "holder_entity_id": "entity", "claim": "Свидетель уверен в своих словах" } } }),
        json!({ "event_type": "EpistemicClaimTruthResolved", "payload": { "claim_id": "claim", "truth_status": "confirmed", "source_event_ids": ["proof"] } }),
        json!({ "event_type": "NarrativeSummaryRecorded", "payload": { "summary": { "id": "summary", "title": "Встреча", "summary": "Свидетели встретились", "entity_ids": ["entity", "other"] } } }),
        json!({ "event_type": "KnowledgeRevealed", "event_id": "reveal-new", "target_ids": ["hero-a"], "payload": { "fact_id": "fact-new" } }),
    ];
    let mut memory = normalize_world_memory(&index_fixture());
    for event in &events {
        let expected = apply_world_memory_event(memory.clone(), event, false);
        let actual = apply_world_memory_event(memory.clone(), event, true);
        assert_eq!(serde_json::to_string(&actual).ok(), serde_json::to_string(&expected).ok(), "{}", event["event_type"]);
        assert_eq!(normalize_world_memory(&actual), actual, "{}: результат уже канонический", event["event_type"]);
        memory = actual;
    }
}

#[test]
fn normalization_keeps_superseded_and_broken_records_and_diagnoses_them() {
    let input = json!({
        "entities": [{ "id": "npc:keeper", "kind": "npc", "name": "Keeper", "visibility": "gm_only" }],
        "facts": [
            { "id": "fact:old", "subject_id": "npc:keeper", "predicate": "holds", "object": "old", "status": "superseded", "visibility": "gm_only" },
            { "id": "fact:new", "subject_id": "npc:keeper", "predicate": "holds", "object": "new", "supersedes_fact_id": "fact:old", "visibility": "gm_only" },
            { "id": "fact:broken", "subject_id": "npc:missing", "predicate": "holds", "object": "unknown", "visibility": "gm_only" },
        ],
        "relationships": [{ "id": "relationship:broken", "from_entity_id": "npc:keeper", "relation": "knows", "to_entity_id": "npc:missing", "summary": "Unknown target", "visibility": "gm_only" }],
        "quests": [{ "id": "quest:broken", "title": "Broken quest", "summary": "Unknown entity", "entity_ids": ["npc:missing"], "visibility": "gm_only" }],
        "threads": [{ "id": "thread:broken", "title": "Broken thread", "summary": "Unknown quest", "entity_ids": ["npc:keeper"], "quest_ids": ["quest:missing"], "visibility": "gm_only" }],
        "epistemic_claims": [{ "id": "belief:broken", "holder_entity_id": "npc:keeper", "subject_entity_id": "npc:missing", "claim": "Unknown target", "visibility": "gm_only" }],
        "summaries": [{ "id": "summary:broken", "kind": "scene", "title": "Broken summary", "summary": "Unknown references", "entity_ids": ["npc:missing"], "thread_ids": ["thread:missing"], "visibility": "gm_only" }],
        "knowledge_ledger": [{ "id": "knowledge:broken", "hero_id": "hero", "fact_id": "fact:missing" }],
    });
    let normalized = normalize_world_memory(&input);
    let ids: Vec<&str> = normalized["facts"].as_array().into_iter().flatten().filter_map(|fact| fact["id"].as_str()).collect();
    assert_eq!(ids, ["fact:old", "fact:new", "fact:broken"]);
    assert_eq!(normalized["facts"][0]["status"], "superseded");
    let issues = diagnose_world_memory(&normalized);
    let has = |collection: &str, id: &str, field: &str| issues.iter().any(|issue| issue["collection"] == collection && issue["id"] == id && issue["field"] == field);
    assert!(has("facts", "fact:broken", "subject_id"));
    assert!(has("relationships", "relationship:broken", "to_entity_id"));
    assert!(has("quests", "quest:broken", "entity_ids"));
    assert!(has("threads", "thread:broken", "quest_ids"));
    assert!(has("epistemic_claims", "belief:broken", "subject_entity_id"));
    assert!(has("summaries", "summary:broken", "entity_ids"));
    assert!(has("knowledge_ledger", "knowledge:broken", "fact_id"));
    assert_eq!(diagnose_world_memory(&normalize_world_memory(&normalized)), issues);
}

#[test]
fn historical_projection_hides_consequence_until_knowledge_arrives() {
    let memory = normalize_world_memory(&json!({
        "entities": [{ "id": "npc:keeper", "kind": "npc", "name": "Keeper", "visibility": "party" }],
        "facts": [{ "id": "fact:keeper-dead", "subject_id": "npc:keeper", "predicate": "died", "object": "North Gate", "summary": "Keeper died at the North Gate.", "visibility": "gm_only", "recorded_at_minutes": 100, "source_event_ids": ["event:death"] }],
        "quests": [{ "id": "quest:keeper", "title": "Meet the keeper", "summary": "Find the keeper.", "status": "failed", "visibility": "party",
            "knowledge_history": [{ "schema_version": 1, "event_id": "event:quest-invalidated", "previous": { "status": "active", "summary": "Find the keeper." },
                "knowledge_gate": { "visibility": "gm_only", "recorded_at_minutes": 100, "source_event_ids": ["event:death"], "fact_ids": ["fact:keeper-dead"] } }] }],
        "knowledge_ledger": [{ "id": "knowledge:death", "hero_id": "hero", "fact_id": "fact:keeper-dead", "recorded_at_minutes": 200, "source_kind": "knowledge_revealed" }],
    }));
    let before = world_memory_for_viewer(&memory, &json!({ "playerId": "hero", "isPartyMember": true, "asOfMinutes": 150 }));
    let after = world_memory_for_viewer(&memory, &json!({ "playerId": "hero", "isPartyMember": true, "asOfMinutes": 250 }));
    let admin = world_memory_for_viewer(&memory, &json!({ "isAdmin": true }));
    assert_eq!(before["quests"][0]["status"], "active");
    assert_eq!(after["quests"][0]["status"], "failed");
    assert_eq!(admin["quests"][0]["knowledge_history"].as_array().map(Vec::len), Some(1));
    assert!(before["quests"][0].get("knowledge_history").is_none());
}

#[test]
fn reducers_append_knowledge_and_summaries_without_evicting_old_records() {
    let memory = normalize_world_memory(&json!({
        "entities": [{ "id": "npc:keeper", "kind": "npc", "name": "Keeper", "visibility": "gm_only" }],
        "facts": [{ "id": "fact:keeper", "subject_id": "npc:keeper", "predicate": "waits", "object": "Here", "visibility": "gm_only" }],
        "summaries": (0..1_000).map(|index| json!({ "id": format!("summary:old-{index}"), "kind": "scene", "title": format!("Old {index}"), "summary": format!("Old summary {index}"), "visibility": "gm_only" })).collect::<Vec<_>>(),
        "knowledge_ledger": (0..5_000).map(|index| json!({ "id": format!("knowledge:old-{index}"), "hero_id": "hero", "fact_id": "fact:keeper", "source_kind": "knowledge_revealed" })).collect::<Vec<_>>(),
    }));
    let after_knowledge = apply_world_memory_event(memory, &json!({ "event_type": "KnowledgeRevealed", "event_id": "knowledge:new", "target_ids": ["hero"], "payload": { "fact_id": "fact:keeper" } }), false);
    let after_summary = apply_world_memory_event(
        after_knowledge.clone(),
        &json!({ "event_type": "NarrativeSummaryRecorded", "event_id": "summary:new", "payload": { "summary": { "id": "summary:new", "kind": "scene", "title": "New", "summary": "New summary", "visibility": "gm_only" } } }),
        false,
    );
    assert_eq!(after_knowledge["knowledge_ledger"].as_array().map(Vec::len), Some(5_001));
    assert_eq!(after_knowledge["knowledge_ledger"][0]["id"], "knowledge:old-0");
    assert_eq!(after_summary["summaries"].as_array().map(Vec::len), Some(1_001));
    assert_eq!(after_summary["summaries"][0]["id"], "summary:old-0");
}
