//! Проверки команд памяти мира из `test/world-memory.test.mjs` и
//! `test/world-memory-engine.test.mjs` на том же пути, которым их ведёт Rules
//! Engine: проверка → событие с `event_id` → редьюсер.

use serde_json::{json, Value};
use sk_memory::world_memory::*;

fn campaign() -> Value {
    json!({ "partyMemberIds": ["hero", "rogue"], "scene": { "title": "Archive", "location": "North Gate" }, "worldMemory": normalize_world_memory(&json!({})) })
}

struct Run {
    state: Value,
    events: Vec<Value>,
}

/// `runWorldMemoryCommands` теста: команды по очереди, без отката.
fn run(initial: &Value, commands: &[Value]) -> Result<Run, WorldMemoryValidationError> {
    let mut state = initial.clone();
    state["worldMemory"] = normalize_world_memory(&initial["worldMemory"]);
    let mut events = Vec::new();
    for (index, raw) in commands.iter().enumerate() {
        let mut raw = raw.clone();
        if raw.get("command_id").is_none() {
            raw["command_id"] = json!(format!("memory-command:{}", index + 1));
        }
        let command = validate_world_memory_command(&raw, &state, &json!({ "isDirector": true }))?;
        let mut event = world_memory_event(&command).expect("команда памяти даёт событие");
        event["event_id"] = json!(format!("memory-event:{}", index + 1));
        event["command_id"] = command["command_id"].clone();
        state["worldMemory"] = apply_world_memory_event(state["worldMemory"].clone(), &event, false);
        events.push(event);
    }
    Ok(Run { state, events })
}

fn replay(initial: &Value, events: &[Value]) -> Value {
    events.iter().fold(normalize_world_memory(&initial["worldMemory"]), |memory, event| apply_world_memory_event(memory, event, false))
}

fn build_memory() -> Run {
    run(
        &campaign(),
        &[
            json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "npc:ashen-fox", "kind": "npc", "name": "Ashen Fox", "summary": "A masked courier.", "visibility": "gm_only" } }),
            json!({ "command_type": "RecordWorldFact", "fact": { "id": "fact:fox-route", "subject_id": "npc:ashen-fox", "predicate": "lore", "object": "The courier uses the old aqueduct.", "summary": "Ashen Fox uses the old aqueduct.", "visibility": "gm_only" } }),
            json!({ "command_type": "RevealWorldFact", "fact_id": "fact:fox-route", "target_ids": ["hero"] }),
            json!({ "command_type": "UpsertQuest", "quest": { "id": "quest:find-seal", "title": "Find the Seal", "summary": "Recover the archive seal.", "objectives": ["Go to the archive vault"], "visibility": "party", "clock": { "current": 1, "max": 3, "label": "Rivals arrive" } } }),
            json!({ "command_type": "AdvanceQuestClock", "quest_id": "quest:find-seal", "amount": 2 }),
        ],
    )
    .expect("команды проходят")
}

fn event_types(events: &[Value]) -> Vec<&str> {
    events.iter().filter_map(|event| event["event_type"].as_str()).collect()
}

fn code(result: Result<Run, WorldMemoryValidationError>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(error) => error.code,
    }
}

#[test]
fn entities_facts_knowledge_quests_and_clocks_are_event_sourced_and_replayable() {
    let result = build_memory();
    assert_eq!(event_types(&result.events), ["WorldEntityUpserted", "WorldFactRecorded", "WorldFactRevealed", "QuestUpserted", "QuestClockAdvanced"]);
    let memory = &result.state["worldMemory"];
    assert_eq!(memory["knowledge"]["hero"], json!(["fact:fox-route"]));
    assert_eq!(memory["quests"][0]["clock"]["current"], 3);
    assert_eq!(memory["quests"][0]["clock"]["triggered"], true);
    assert_eq!(replay(&campaign(), &result.events), *memory);
}

#[test]
fn progress_proofs_are_versioned_kept_by_quest_updates_and_hidden_from_players() {
    let prepared = run(
        &campaign(),
        &[
            json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "parcel", "kind": "item", "name": "Припасы", "visibility": "party" } }),
            json!({ "command_type": "UpsertQuest", "quest": { "id": "supplies", "title": "Найти припасы", "entity_ids": ["parcel"], "clock": { "current": 0, "max": 3 } } }),
            json!({ "command_type": "RecordWorldFact", "fact": { "id": "clue", "subject_id": "parcel", "predicate": "discovery", "object": "Найдена улика", "visibility": "party", "source_event_ids": ["source-check"] } }),
        ],
    )
    .expect("подготовка")
    .state;
    let progressed = run(&prepared, &[json!({ "command_type": "AdvanceQuestClock", "quest_id": "supplies", "amount": 1, "proof_fact_ids": ["clue"] })]).expect("прогресс");
    assert_eq!(progressed.events[0]["payload"]["schema_version"], 2);
    assert_eq!(progressed.events[0]["payload"]["proof_source_event_ids"], json!(["source-check"]));
    let updated = run(&progressed.state, &[json!({ "command_type": "UpsertQuest", "quest": { "id": "supplies", "title": "Вернуть найденные припасы", "entity_ids": ["parcel"], "clock": { "current": 1, "max": 3 } } })])
        .expect("обновление")
        .state;
    let quest = updated["worldMemory"]["quests"].as_array().and_then(|quests| quests.iter().find(|quest| quest["id"] == "supplies")).cloned().expect("поручение");
    assert_eq!(quest["progress_fact_ids"], json!(["clue"]));
    assert_eq!(quest["progress_source_event_ids"], json!(["source-check"]));
    let copied = run(&updated, &[json!({ "command_type": "RecordWorldFact", "fact": { "id": "clue-copy", "subject_id": "parcel", "predicate": "discovery", "object": "Та же улика другим текстом", "visibility": "party", "source_event_ids": ["source-check"] } })])
        .expect("копия")
        .state;
    assert_eq!(code(run(&copied, &[json!({ "command_type": "AdvanceQuestClock", "quest_id": "supplies", "amount": 1, "proof_fact_ids": ["clue-copy"] })])), "WORLD_QUEST_PROGRESS_PROOF_INVALID");
    let forged = run(&updated, &[json!({ "command_type": "UpsertQuest", "quest": { "id": "supplies", "title": "Сброс", "progress_fact_ids": [] } })]);
    let error = forged.err().expect("поле запрещено");
    assert!(error.message.contains("progress_fact_ids"), "{error:?}");
    let visible = world_memory_for_viewer(&updated["worldMemory"], &json!({ "playerId": "hero", "isPartyMember": true }));
    let public = visible["quests"].as_array().and_then(|quests| quests.iter().find(|quest| quest["id"] == "supplies")).cloned().expect("поручение видно");
    assert!(public.get("progress_fact_ids").is_none() && public.get("progress_source_event_ids").is_none());
}

#[test]
fn legacy_quest_clock_event_gets_no_proof_meaning_on_replay() {
    let memory = build_memory().state["worldMemory"].clone();
    let legacy = apply_world_memory_event(memory, &json!({ "event_type": "QuestClockAdvanced", "payload": { "quest_id": "quest:find-seal", "amount": 1, "proof_fact_ids": ["clue"], "proof_source_event_ids": ["source-check"] } }), false);
    let quest = &legacy["quests"][0];
    assert!(quest.get("progress_fact_ids").is_none() && quest.get("progress_source_event_ids").is_none());
}

#[test]
fn triggered_clock_resolves_and_premature_resolution_is_rejected() {
    let early = run(
        &campaign(),
        &[
            json!({ "command_type": "UpsertQuest", "quest": { "id": "quest:early", "title": "Too early", "status": "active", "visibility": "party", "clock": { "current": 0, "max": 2, "label": "Progress" } } }),
            json!({ "command_type": "ResolveQuest", "quest_id": "quest:early", "outcome": "success", "summary": "Not yet.", "next_objective": "Wait." }),
        ],
    );
    assert_eq!(code(early), "WORLD_QUEST_CLOCK_NOT_TRIGGERED");
    let prepared = build_memory();
    let source = prepared.events.last().map(|event| event["event_id"].clone()).unwrap_or_default();
    let resolved = run(&prepared.state, &[json!({ "command_type": "ResolveQuest", "quest_id": "quest:find-seal", "outcome": "failure", "summary": "The rivals reached the seal first.", "next_objective": "Recover the seal from the rivals.", "source_event_ids": [source] })]).expect("развязка");
    assert_eq!(resolved.events[0]["event_type"], "QuestResolved");
    assert_eq!(resolved.state["worldMemory"]["quests"][0]["status"], "failed");
    assert!(resolved.state["worldMemory"]["quests"][0]["summary"].as_str().unwrap_or_default().contains("rivals reached"));
}

#[test]
fn abandonment_closes_before_the_clock_fills_but_success_and_failure_do_not() {
    let prepared = run(&campaign(), &[json!({ "command_type": "UpsertQuest", "quest": { "id": "quest:find-seal", "title": "Find the Seal", "summary": "Recover the archive seal.", "objectives": ["Go to the archive vault"], "visibility": "party", "clock": { "current": 1, "max": 3, "label": "Rivals arrive" } } })])
        .expect("подготовка")
        .state;
    assert_eq!(code(run(&prepared, &[json!({ "command_type": "ResolveQuest", "quest_id": "quest:find-seal", "outcome": "success", "summary": "Not yet.", "next_objective": "Wait." })])), "WORLD_QUEST_CLOCK_NOT_TRIGGERED");
    assert_eq!(code(run(&prepared, &[json!({ "command_type": "ResolveQuest", "quest_id": "quest:find-seal", "outcome": "walked-away", "summary": "Nope.", "next_objective": "Nope." })])), "WORLD_QUEST_OUTCOME_INVALID");
    let abandoned = run(
        &prepared,
        &[json!({ "command_type": "ResolveQuest", "quest_id": "quest:find-seal", "outcome": "abandoned", "summary": "Отряд отказался от задания и ушёл из архива.", "next_objective": "Осмотреться в новом месте и найти новую цель", "request_fingerprint": "director-transition-fingerprint" })],
    )
    .expect("отказ");
    assert_eq!(abandoned.events[0]["payload"]["status"], "abandoned");
    assert_eq!(abandoned.events[0]["payload"]["request_fingerprint"], "director-transition-fingerprint");
    assert_eq!(abandoned.state["worldMemory"]["quests"][0]["status"], "abandoned");
    assert_eq!(replay(&prepared, &abandoned.events), abandoned.state["worldMemory"]);
    assert_eq!(code(run(&abandoned.state, &[json!({ "command_type": "AdvanceQuestClock", "quest_id": "quest:find-seal", "amount": 1 })])), "WORLD_QUEST_CLOSED");
}

#[test]
fn resolution_without_fingerprint_keeps_the_old_payload() {
    let event = world_memory_event(&json!({ "command_type": "ResolveQuest", "quest_id": "quest:find-seal", "outcome": "success", "summary": "Done.", "next_objective": "Next.", "source_event_ids": [] })).expect("событие");
    assert!(event["payload"].get("request_fingerprint").is_none());
    assert_eq!(event["payload"]["status"], "completed");
}

#[test]
fn private_fact_is_visible_only_to_the_hero_who_learned_it() {
    let memory = build_memory().state["worldMemory"].clone();
    let hero = world_memory_for_viewer(&memory, &json!({ "playerId": "hero", "isPartyMember": true }));
    let rogue = world_memory_for_viewer(&memory, &json!({ "playerId": "rogue", "isPartyMember": true }));
    assert_eq!(hero["facts"].as_array().map(|facts| facts.iter().map(|fact| fact["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("fact:fox-route")]));
    assert!(hero["entities"].as_array().is_some_and(|entities| entities.iter().any(|entity| entity["id"] == "npc:ashen-fox")));
    assert_eq!(rogue["facts"], json!([]));
    assert!(!rogue["entities"].as_array().is_some_and(|entities| entities.iter().any(|entity| entity["id"] == "npc:ashen-fox")));
    assert_eq!(hero["knowledge_ledger"][0]["hero_id"], "hero");
    assert_eq!(rogue["knowledge_ledger"], json!([]));
}

#[test]
fn legacy_knowledge_migrates_and_retrieval_filters_before_ranking() {
    let memory = build_memory().state["worldMemory"].clone();
    let mut legacy = memory.clone();
    legacy.as_object_mut().map(|map| map.shift_remove("knowledge_ledger"));
    legacy.as_object_mut().map(|map| map.shift_remove("knowledge_revealed"));
    legacy["knowledge"] = json!({ "hero": ["fact:fox-route"] });
    let migrated = normalize_world_memory(&legacy);
    assert_eq!(migrated["schema_version"], 2);
    assert_eq!(migrated["knowledge_ledger"][0]["source_kind"], "legacy");
    let hero = retrieve_known_world_memory(&memory, &json!({ "viewer": { "playerId": "hero", "isPartyMember": true }, "query": "aqueduct" }));
    let rogue = retrieve_known_world_memory(&memory, &json!({ "viewer": { "playerId": "rogue", "isPartyMember": true }, "query": "aqueduct" }));
    assert_eq!(hero.len(), 1);
    assert_eq!(hero[0]["id"], "fact:fox-route");
    assert_eq!(hero[0]["citation"]["knowledge_entry_ids"].as_array().map(Vec::len), Some(1));
    assert!(rogue.is_empty());
    let mut later = memory.clone();
    later["knowledge_ledger"][0]["recorded_at_minutes"] = json!(60);
    later["knowledge_revealed"][0]["recorded_at_minutes"] = json!(60);
    assert!(retrieve_known_world_memory(&later, &json!({ "viewer": { "playerId": "hero", "isPartyMember": true }, "query": "aqueduct", "atMinutes": 0 })).is_empty());
}

fn ford_commands() -> Vec<Value> {
    vec![
        json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "npc:vela", "kind": "npc", "name": "Vela", "visibility": "party" } }),
        json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "faction:wardens", "kind": "faction", "name": "Road Wardens", "visibility": "party" } }),
        json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "location:ford", "kind": "location", "name": "Ash Ford", "aliases": ["old trail"], "visibility": "party" } }),
        json!({ "command_type": "RecordWorldFact", "fact": { "id": "fact:ford-closed", "subject_id": "location:ford", "predicate": "lore", "object": "The old trail is flooded.", "summary": "Ash Ford is closed after the flood.", "visibility": "party", "source_event_ids": ["event:flood"] } }),
        json!({ "command_type": "RecordWorldRelationship", "relationship": { "id": "relationship:vela-wardens", "from_entity_id": "npc:vela", "relation": "serves", "to_entity_id": "faction:wardens", "summary": "Vela serves the Road Wardens.", "visibility": "party", "source_event_ids": ["event:oath"] } }),
        json!({ "command_type": "UpsertQuest", "quest": { "id": "quest:ford", "title": "Cross Ash Ford", "visibility": "party", "entity_ids": ["location:ford"], "clock": { "current": 0, "max": 3, "label": "Flood rises" } } }),
        json!({ "command_type": "UpsertNarrativeThread", "thread": { "id": "thread:warden-oath", "title": "The warden oath", "summary": "Vela needs proof before guiding the party.", "status": "active", "visibility": "party", "entity_ids": ["npc:vela", "faction:wardens"], "quest_ids": ["quest:ford"], "clock": { "current": 1, "max": 3, "label": "Trust" }, "source_event_ids": ["event:oath"] } }),
        json!({ "command_type": "AdvanceNarrativeThreadClock", "thread_id": "thread:warden-oath", "amount": 1 }),
        json!({ "command_type": "RecordNpcBelief", "claim": { "id": "belief:vela-river", "holder_entity_id": "npc:vela", "subject_entity_id": "location:ford", "claim": "Vela believes the Wardens opened the sluice gate.", "summary": "Vela suspects the Wardens.", "visibility": "gm_only", "source_event_ids": ["event:vela-told"] } }),
        json!({ "command_type": "RecordRumor", "claim": { "id": "rumor:vela-smugglers", "holder_entity_id": "npc:vela", "subject_entity_id": "location:ford", "claim": "Travellers say smugglers use the old trail.", "summary": "A rumour ties smugglers to Ash Ford.", "visibility": "party", "source_event_ids": ["event:travellers"] } }),
        json!({ "command_type": "ResolveEpistemicClaim", "claim_id": "rumor:vela-smugglers", "truth_status": "refuted", "source_event_ids": ["event:search"] }),
        json!({ "command_type": "RecordNarrativeSummary", "summary": { "id": "summary:scene-ford", "kind": "scene", "title": "At Ash Ford", "summary": "The party learned that Vela serves the Wardens and the ford is closed.", "visibility": "party", "entity_ids": ["npc:vela", "location:ford"], "thread_ids": ["thread:warden-oath"], "source_event_ids": ["event:oath", "event:flood"] } }),
    ]
}

#[test]
fn relationships_threads_claims_and_summaries_replay_without_becoming_facts() {
    let result = run(&campaign(), &ford_commands()).expect("команды проходят");
    assert_eq!(
        event_types(&result.events),
        [
            "WorldEntityUpserted", "WorldEntityUpserted", "WorldEntityUpserted", "WorldFactRecorded", "WorldRelationshipRecorded", "QuestUpserted", "NarrativeThreadUpserted",
            "NarrativeThreadClockAdvanced", "NpcBeliefRecorded", "RumorRecorded", "EpistemicClaimTruthResolved", "NarrativeSummaryRecorded",
        ]
    );
    let memory = &result.state["worldMemory"];
    assert_eq!(memory["relationships"][0]["status"], "active");
    assert_eq!(memory["threads"][0]["clock"]["current"], 2);
    let claim = |id: &str| memory["epistemic_claims"].as_array().and_then(|claims| claims.iter().find(|claim| claim["id"] == id)).cloned().unwrap_or(Value::Null);
    assert_eq!(claim("belief:vela-river")["truth_status"], "unknown");
    assert_eq!(claim("rumor:vela-smugglers")["truth_status"], "refuted");
    assert_eq!(memory["summaries"][0]["source_event_ids"].as_array().map(Vec::len), Some(2));
    assert!(!memory["facts"].as_array().is_some_and(|facts| facts.iter().any(|fact| fact["id"] == "rumor:vela-smugglers")));
    assert_eq!(replay(&campaign(), &result.events), *memory);
}

#[test]
fn claims_and_summaries_require_provenance_and_viewer_retrieval_filters_first() {
    let seeded = run(
        &campaign(),
        &[
            json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "npc:vela", "kind": "npc", "name": "Vela", "visibility": "party" } }),
            json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "location:ford", "kind": "location", "name": "Ash Ford", "aliases": ["old trail"], "visibility": "party" } }),
            json!({ "command_type": "RecordWorldFact", "fact": { "id": "fact:ford-route", "subject_id": "location:ford", "predicate": "lore", "object": "The old trail is flooded.", "summary": "The old trail cannot be used.", "visibility": "party", "source_event_ids": ["event:flood"] } }),
            json!({ "command_type": "RecordRumor", "claim": { "id": "rumor:party", "holder_entity_id": "npc:vela", "claim": "Smugglers crossed the ford.", "summary": "A visible rumour.", "visibility": "party", "source_event_ids": ["event:talk"] } }),
            json!({ "command_type": "RecordNpcBelief", "claim": { "id": "belief:hidden", "holder_entity_id": "npc:vela", "claim": "Vela thinks the party is being watched.", "summary": "A hidden belief.", "visibility": "gm_only", "source_event_ids": ["event:thought"] } }),
        ],
    )
    .expect("подготовка");
    let mut later = seeded.state.clone();
    later["mechanics"] = json!({ "world_time": { "elapsed_minutes": 120 } });
    let with_summary = run(&later, &[json!({ "command_type": "RecordNarrativeSummary", "summary": { "id": "summary:later", "kind": "session", "title": "Later session", "summary": "The party considers a route through the ford.", "visibility": "party", "source_event_ids": ["event:later"] } })])
        .expect("сводка")
        .state;
    let viewer = json!({ "playerId": "hero", "isPartyMember": true });
    let player = world_memory_for_viewer(&with_summary["worldMemory"], &viewer);
    let claims: Vec<&str> = player["epistemic_claims"].as_array().into_iter().flatten().filter_map(|claim| claim["id"].as_str()).collect();
    assert_eq!(claims, ["rumor:party"]);
    assert!(retrieve_world_memory(&with_summary["worldMemory"], &viewer, &json!({ "query": "маршрут", "limit": 5 })).iter().any(|entry| entry["id"] == "fact:ford-route"));
    assert!(!retrieve_world_memory(&with_summary["worldMemory"], &viewer, &json!({ "query": "later", "asOfMinutes": 0 })).iter().any(|entry| entry["id"] == "summary:later"));
    let holder = validate_world_memory_command(&json!({ "command_type": "RecordNpcBelief", "command_id": "invalid-holder", "claim": { "id": "belief:invalid", "holder_entity_id": "location:ford", "claim": "Not an NPC." } }), &with_summary, &json!({ "isDirector": true }));
    assert_eq!(holder.err().map(|error| error.code), Some("WORLD_NPC_BELIEF_HOLDER_INVALID".into()));
    let provenance = validate_world_memory_command(&json!({ "command_type": "RecordNarrativeSummary", "command_id": "missing-provenance", "summary": { "id": "summary:invalid", "kind": "scene", "title": "Invalid", "summary": "No evidence." } }), &with_summary, &json!({ "isDirector": true }));
    assert_eq!(provenance.err().map(|error| error.code), Some("WORLD_SUMMARY_PROVENANCE_REQUIRED".into()));
}

#[test]
fn players_cannot_forge_memory_and_unknown_nested_fields_are_rejected() {
    let state = campaign();
    let entity = json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "npc:x", "kind": "npc", "name": "X" } });
    assert_eq!(validate_world_memory_command(&entity, &state, &json!({})).err().map(|error| error.code), Some("WORLD_MEMORY_FORBIDDEN".into()));
    let leak = json!({ "command_type": "UpsertWorldEntity", "entity": { "id": "npc:x", "kind": "npc", "name": "X", "secret_prompt": "leak" } });
    assert_eq!(validate_world_memory_command(&leak, &state, &json!({ "isAdmin": true })).err().map(|error| error.code), Some("WORLD_MEMORY_UNKNOWN_FIELD".into()));
    let other = json!({ "command_type": "MoveActor", "actor_id": "hero" });
    assert_eq!(validate_world_memory_command(&other, &state, &json!({})).ok(), Some(other));
}

#[test]
fn superseding_a_fact_keeps_history_but_retires_the_old_assertion() {
    let first = build_memory();
    let result = run(&first.state, &[json!({ "command_type": "RecordWorldFact", "fact": { "id": "fact:fox-route-new", "subject_id": "npc:ashen-fox", "predicate": "lore", "object": "The aqueduct is compromised.", "supersedes_fact_id": "fact:fox-route", "visibility": "gm_only" } })]).expect("замена");
    let status = |id: &str| result.state["worldMemory"]["facts"].as_array().and_then(|facts| facts.iter().find(|fact| fact["id"] == id)).map(|fact| fact["status"].clone());
    assert_eq!(status("fact:fox-route"), Some(json!("superseded")));
    assert_eq!(status("fact:fox-route-new"), Some(json!("active")));
}

/// Там, где JS падает `TypeError` (не `WorldMemoryValidationError`), перенос
/// не паникует: `clock: null` у входа команды — отказ с текстом V8, `null` в
/// коллекции — пустая запись, подготовленный путь на не-объекте — обычный.
#[test]
fn js_type_errors_become_refusals_or_empty_records_without_panics() {
    let state = campaign();
    let quest = json!({ "command_type": "UpsertQuest", "command_id": "c", "quest": { "id": "q", "title": "Часы null", "clock": null } });
    let error = validate_world_memory_command(&quest, &state, &json!({ "isDirector": true })).expect_err("clock: null");
    assert_eq!((error.code.as_str(), error.message.as_str()), ("WORLD_MEMORY_TYPE_ERROR", "Cannot read properties of null (reading 'max')"));
    let memory = normalize_world_memory(&json!({ "entities": [null, 5], "facts": [null], "quests": [{ "id": "q", "title": "t", "clock": null }], "knowledge_ledger": [null] }));
    assert_eq!(memory["entities"][0]["kind"], "concept");
    assert_eq!(memory["quests"][0]["clock"], json!({ "current": 0, "max": 4, "label": "", "triggered": false }));
    let applied = apply_world_memory_event(json!("не память"), &json!({ "event_type": "WorldEntityUpserted", "payload": { "entity": { "id": "e", "name": "E" } } }), true);
    assert_eq!(applied["entities"][0]["id"], "e");
    assert_eq!(applied["schema_version"], 2);
}
