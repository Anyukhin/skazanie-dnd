//! Перенос `test/world-ontology-write.test.mjs` (#189): онтология мира
//! проверяет запись памяти. Команда факта, убеждения или слуха проходит, только
//! если её предикат есть в словаре (`sk_society::world_ontology`) для этого
//! вида записи и подлежащего; уже записанные события редьюсер читает как есть.
//! Путь — тот же, которым команды ведёт Rules Engine: проверка → событие →
//! редьюсер; replay — свёртка событий редьюсером.

use serde_json::{json, Value};
use sk_memory::world_memory::*;
use sk_society::world_ontology::{ontology_violation, predicate, predicate_entry_for, PREDICATES};

fn initial() -> Value {
    json!({ "partyMemberIds": ["hero"], "worldMemory": normalize_world_memory(&json!({})) })
}

fn entities() -> Vec<Value> {
    vec![
        json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "npc:vela", "kind": "npc", "name": "Вела", "visibility": "party" } }),
        json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "location:mill", "kind": "location", "name": "Мельница", "visibility": "party" } }),
    ]
}

struct Run {
    state: Value,
    events: Vec<Value>,
}

fn run_with(commands: &[Value], context: &Value) -> Result<Run, WorldMemoryValidationError> {
    let mut state = initial();
    let mut events = Vec::new();
    for (index, raw) in entities().iter().chain(commands).enumerate() {
        let mut raw = raw.clone();
        raw["command_id"] = json!(format!("command:{}", index + 1));
        let command = validate_world_memory_command(&raw, &state, context)?;
        let mut event = world_memory_event(&command).expect("команда памяти даёт событие");
        event["event_id"] = json!(format!("event:{}", index + 1));
        state["worldMemory"] = apply_world_memory_event(state["worldMemory"].clone(), &event, false);
        events.push(event);
    }
    Ok(Run { state, events })
}

fn run(commands: &[Value]) -> Result<Run, WorldMemoryValidationError> {
    run_with(commands, &json!({ "isDirector": true }))
}

fn replay(events: &[Value]) -> Value {
    events.iter().fold(normalize_world_memory(&initial()["worldMemory"]), |memory, event| apply_world_memory_event(memory, event, false))
}

fn code(result: Result<Run, WorldMemoryValidationError>) -> String {
    result.err().map(|error| error.code).unwrap_or_else(|| "ok".into())
}

fn fact(predicate: &str, subject_id: &str) -> Value {
    json!({ "command_type": "RecordWorldFact", "fact": {
        "id": format!("fact:{predicate}:{subject_id}"), "subject_id": subject_id, "predicate": predicate, "object": "location:mill", "summary": "Запись", "visibility": "party",
    } })
}

fn rumor(predicate: &str) -> Value {
    let id = if predicate.is_empty() { "none" } else { predicate };
    json!({ "command_type": "RecordRumor", "claim": {
        "id": format!("rumor:{id}"), "holder_entity_id": "npc:vela", "predicate": predicate, "claim": "Говорят, отряд обокрал мельницу.", "visibility": "gm_only",
    } })
}

#[test]
fn entry_is_exact_name_or_family_with_suffix_but_not_bare_family() {
    let same = |left: Option<&'static _>, right: Option<&'static _>| match (left, right) {
        (Some(left), Some(right)) => std::ptr::eq(left, right),
        (None, None) => true,
        _ => false,
    };
    assert!(same(predicate_entry_for("died"), predicate("died")));
    assert!(same(predicate_entry_for("party_deed"), predicate("party_deed")));
    assert!(same(predicate_entry_for("party_deed:theft"), predicate("party_deed:")));
    assert!(same(predicate_entry_for("faction_offscreen_move:raid"), predicate("faction_offscreen_move:")));
    assert!(predicate_entry_for("party_deed:").is_none());
    assert!(predicate_entry_for("died:twice").is_none());
    assert!(predicate_entry_for("knows").is_none());
    assert!(ontology_violation("fact", "died", "npc").is_none());
}

#[test]
fn registered_fact_is_recorded_and_replays() {
    let result = run(&[fact("died", "npc:vela")]).expect("факт из словаря");
    assert_eq!(result.events.last().map(|event| event["event_type"].clone()), Some(json!("WorldFactRecorded")));
    assert_eq!(result.state["worldMemory"]["facts"].as_array().and_then(|facts| facts.last()).map(|fact| fact["predicate"].clone()), Some(json!("died")));
    assert_eq!(replay(&result.events), result.state["worldMemory"]);
}

#[test]
fn unknown_fact_predicate_is_rejected_before_the_event() {
    let error = run(&[fact("knows", "npc:vela")]).err().expect("отказ");
    assert_eq!((error.code.as_str(), error.message.as_str()), ("WORLD_PREDICATE_UNKNOWN", "Предиката «knows» нет в онтологии мира"));
}

#[test]
fn wrong_subject_kind_is_rejected_only_npc_can_die() {
    let error = run(&[fact("died", "location:mill")]).err().expect("отказ");
    assert_eq!((error.code.as_str(), error.message.as_str()), ("WORLD_PREDICATE_SUBJECT_KIND_INVALID", "«died» записывается о сущности вида npc, а не location"));
}

#[test]
fn record_kind_is_checked_rumor_is_not_a_fact_and_fact_is_not_a_rumor() {
    let as_fact = run(&[fact("party_deed:theft", "npc:vela")]).err().expect("отказ");
    assert_eq!((as_fact.code.as_str(), as_fact.message.as_str()), ("WORLD_PREDICATE_RECORD_MISMATCH", "«party_deed:theft» — утверждение NPC, а не факт"));
    let as_rumor = run(&[rumor("discovery")]).err().expect("отказ");
    assert_eq!((as_rumor.code.as_str(), as_rumor.message.as_str()), ("WORLD_PREDICATE_RECORD_MISMATCH", "«discovery» — факт мира, а не утверждение NPC"));
}

#[test]
fn family_rumor_is_recorded_and_claim_without_predicate_is_unrestricted() {
    let result = run(&[rumor("party_deed:theft"), rumor("")]).expect("слухи");
    let predicates: Vec<Value> = result.state["worldMemory"]["epistemic_claims"].as_array().into_iter().flatten().map(|claim| claim["predicate"].clone()).collect();
    assert_eq!(predicates, vec![json!("party_deed:theft"), json!("")]);
    assert_eq!(replay(&result.events), result.state["worldMemory"]);
}

#[test]
fn every_registered_subject_kind_is_accepted() {
    for (name, entry) in PREDICATES {
        if entry.record != "fact" {
            continue;
        }
        let predicate = if entry.family { format!("{name}probe") } else { name.to_string() };
        for kind in entry.subject_kinds {
            let subject = json!({ "command_type": "UpsertWorldEntity", "entity": { "id": format!("{kind}:probe"), "kind": kind, "name": "Проба", "visibility": "party" } });
            assert_eq!(code(run(&[subject, fact(&predicate, &format!("{kind}:probe"))])), "ok", "{predicate} о сущности вида {kind}");
        }
    }
}

#[test]
fn check_does_not_bypass_rights() {
    assert_eq!(code(run_with(&[fact("died", "npc:vela")], &json!({ "isAdmin": false, "actorId": "hero" }))), "WORLD_MEMORY_FORBIDDEN");
}

#[test]
fn replay_accepts_recorded_fact_with_predicate_outside_the_registry() {
    let recorded = run(&[]).expect("сущности");
    let legacy = json!({ "event_type": "WorldFactRecorded", "event_id": "event:legacy", "command_id": "command:legacy", "visibility": "party", "payload": { "fact": {
        "id": "fact:legacy", "subject_id": "npc:vela", "predicate": "knows", "object": "тайну мельницы", "summary": "Вела знает тайну мельницы.",
        "visibility": "party", "source_event_ids": [], "status": "active",
    } } });
    let mut events = recorded.events;
    events.push(legacy);
    let memory = replay(&events);
    assert_eq!(memory["facts"].as_array().and_then(|facts| facts.last()).map(|fact| fact["predicate"].clone()), Some(json!("knows")));
}

#[test]
fn empty_subject_kind_is_named_without_kind() {
    let violation = ontology_violation("fact", "died", "").expect("нарушение");
    assert_eq!(violation.message, "«died» записывается о сущности вида npc, а не без вида");
}
