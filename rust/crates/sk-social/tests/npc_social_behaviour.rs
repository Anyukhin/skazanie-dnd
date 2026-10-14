//! Проверки модуля из `test/npc-social.test.mjs`, `test/npc-retention.test.mjs`,
//! `test/npc-social-voice.test.mjs`, `test/npc-knowledge-leads.test.mjs`,
//! `test/hero-hooks.test.mjs` и `test/narrator-experience.test.mjs`, перенесённые
//! на уровень модуля: вместо Rules Engine — проверка команды, её события и
//! редьюсер `apply_npc_social_event` шаг за шагом (так их связывает движок).

use serde_json::{json, Value};
use sk_social::npc_social::*;
use sk_society::retention_context::with_retention_mode;

static NULL: Value = Value::Null;

fn campaign() -> Value {
    let mut state = json!({
        "sessionCode": "NPC-SOCIAL",
        "activePlayerId": "hero",
        "partyMemberIds": ["hero", "rogue"],
        "scene": { "title": "Market", "location": "Market Square" },
        "mechanics": { "world_time": { "elapsed_minutes": 0 }, "combat": { "active": false } },
        "merchants": [{ "id": "marta", "name": "Marta", "location": "Market Square", "available": true, "stock": [] }],
        "worldMemory": { "entities": [], "facts": [], "epistemic_claims": [] },
        "social": {
            "npcs": [{
                "id": "marta", "name": "Marta", "role": "merchant", "location": "Market Square",
                "public_summary": "A careful trader.", "voice": "Brief and direct.",
                "goals": ["Find the hidden crown"], "beliefs": ["The duke is a traitor"],
                "known_fact_ids": [], "visibility": "party", "available": true,
            }],
            "relationships": { "marta": { "hero": 3, "rogue": -4 } },
            "conversations": [],
            "promises": [],
        },
    });
    normalize(&mut state);
    state
}

/// Как `normalizeCampaignState` для социальной части.
fn normalize(state: &mut Value) {
    let social = ensure_npc_social_state(&state["social"], state, &NULL);
    state["social"] = social;
}

fn social_command(overrides: Value) -> Value {
    let mut conversation = json!({
        "id": "conversation:one",
        "npc_id": "marta",
        "hero_id": "hero",
        "player_message": "Can you help us?",
        "npc_reply": "Bring me the ledger and I will help.",
        "stance": "friendly",
        "disclosed_fact_ids": [],
        "relationship_delta": 1,
        "visibility": "party",
        "promise": {
            "id": "promise:one", "direction": "npc_to_party",
            "text": "Marta will provide help after receiving the ledger.",
            "due_hint": "After the ledger is delivered.", "visibility": "party",
        },
    });
    if let (Some(target), Some(patch)) = (conversation.as_object_mut(), overrides.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    json!({ "command_type": "RecordNpcSocialTurn", "command_id": "cmd-1", "actor_id": "hero", "conversation": conversation })
}

/// Проверка команды и её события; `event_id` проставляется, как это делает движок.
fn resolve(command: &Value, state: &Value, context: Value) -> Result<Vec<Value>, NpcSocialValidationError> {
    let validated = validate_npc_social_command(command, state, &context)?;
    let mut events = npc_social_events(&validated, state);
    for (index, event) in events.iter_mut().enumerate() {
        if event.get("event_id").is_none() {
            event["event_id"] = json!(format!("event:{index}"));
        }
    }
    Ok(events)
}

fn code(result: Result<Vec<Value>, NpcSocialValidationError>) -> String {
    result.err().map(|error| error.code).unwrap_or_default()
}

/// Replay социальных событий, как `applyGameEvent` для них.
fn replay(state: &Value, events: &[Value]) -> Value {
    let mut state = state.clone();
    for event in events {
        let social_event = event["event_type"].as_str().is_some_and(|kind| kind.starts_with("Npc"));
        if social_event {
            state["social"] = apply_npc_social_event(&state["social"], event, &state, &NULL);
        }
        normalize(&mut state);
    }
    state
}

fn event_types(events: &[Value]) -> Vec<&str> {
    events.iter().map(|event| event["event_type"].as_str().unwrap_or("")).collect()
}

#[test]
fn social_projection_hides_motives_beliefs_and_other_relationships() {
    let visible = npc_social_for_viewer(&campaign()["social"], &json!({ "playerId": "hero", "isPartyMember": true }));
    assert_eq!(visible["npcs"][0]["name"], "Marta");
    assert_eq!(visible["relationships"]["marta"]["hero"], 3);
    assert!(visible["relationships"]["marta"].get("rogue").is_none());
    let text = visible.to_string();
    assert!(!text.contains("hidden crown") && !text.contains("duke is a traitor") && !text.contains("known_fact_ids"));
}

#[test]
fn schedules_and_inventories_are_normalized_replayed_and_projected_without_leaks() {
    let initial = campaign();
    let mut npc = initial["social"]["npcs"][0].clone();
    npc.as_object_mut().expect("профиль").remove("dossier");
    npc["speech_profile"] = json!({ "pace": "быстро, короткими фразами", "lexicon": "торговые термины и названия товара", "mannerism": "перед ценой говорит «счёт любит точность»" });
    npc["schedule"] = json!([
        { "id": "market-hours", "days": [0, 1, 2, 3, 4], "start_minute": 540, "end_minute": 1_020, "location": "Market Square", "available": true, "summary": "Open market hours.", "visibility": "party" },
        { "id": "private-errand", "days": [0], "start_minute": 1_020, "end_minute": 1_140, "location": "Duke Archive", "available": false, "summary": "PRIVATE_ARCHIVE_ROUTE", "visibility": "gm_only" },
    ]);
    npc["inventory"] = json!([
        { "id": "map", "name": "Town map", "quantity": 2, "description": "A public route map.", "visibility": "party" },
        { "id": "ledger", "name": "SECRET_LEDGER", "quantity": 1, "description": "PRIVATE_DEBT_LIST", "visibility": "gm_only" },
    ]);
    let events = resolve(&json!({ "command_type": "UpsertNpcSocialProfile", "npc": npc }), &initial, json!({ "isAdmin": true })).expect("профиль принят");
    assert_eq!(event_types(&events), ["NpcSocialProfileUpserted"]);
    let replayed = replay(&initial, &events);
    let stored = replayed["social"]["npcs"].as_array().and_then(|npcs| npcs.iter().find(|entry| entry["id"] == "marta")).cloned().expect("Марта");
    assert_eq!(stored["schedule"].as_array().map(Vec::len), Some(2));
    assert_eq!(stored["inventory"].as_array().map(Vec::len), Some(2));
    assert_eq!(stored["speech_profile"], npc["speech_profile"]);

    let market = json!({ "mechanics": { "world_time": { "elapsed_minutes": 600 } } });
    let errand = json!({ "mechanics": { "world_time": { "elapsed_minutes": 1_050 } } });
    assert_eq!(npc_profile_at_world_time(&stored, &market)["location"], "Market Square");
    assert_eq!(npc_profile_at_world_time(&stored, &market)["available"], true);
    assert_eq!(npc_profile_at_world_time(&stored, &errand)["location"], "Duke Archive");
    assert_eq!(npc_profile_at_world_time(&stored, &errand)["available"], false);

    let visible_market = npc_social_for_viewer(&replayed["social"], &json!({ "playerId": "hero", "isPartyMember": true, "state": market }));
    assert_eq!(visible_market["npcs"][0]["inventory"], json!([{ "id": "map", "name": "Town map", "quantity": 2, "description": "A public route map." }]));
    assert!(visible_market["npcs"][0].get("schedule").is_none());
    let visible_errand = npc_social_for_viewer(&replayed["social"], &json!({ "playerId": "hero", "isPartyMember": true, "state": errand }));
    assert_eq!(visible_errand["npcs"][0]["available"], false);
    assert_eq!(visible_errand["npcs"][0]["location"], "");
    let text = visible_errand.to_string();
    for secret in ["SECRET_LEDGER", "PRIVATE_DEBT_LIST", "PRIVATE_ARCHIVE_ROUTE", "Duke Archive"] {
        assert!(!text.contains(secret), "{secret} утёк игроку");
    }
}

#[test]
fn profile_management_rejects_overlaps_invalid_inventory_and_incomplete_voice() {
    let initial = campaign();
    let base = initial["social"]["npcs"][0].clone();
    let with = |key: &str, value: Value| {
        let mut npc = base.clone();
        npc[key] = value;
        json!({ "command_type": "UpsertNpcSocialProfile", "npc": npc })
    };
    let overlapping = with("schedule", json!([
        { "id": "morning", "days": [], "start_minute": 480, "end_minute": 720, "location": "Market Square", "available": true },
        { "id": "overlap", "days": [0], "start_minute": 700, "end_minute": 800, "location": "Market Square", "available": true },
    ]));
    assert_eq!(code(resolve(&overlapping, &initial, json!({ "isAdmin": true }))), "NPC_SOCIAL_SCHEDULE_CONFLICT");
    let inventory = with("inventory", json!([{ "id": "coin", "name": "Coin", "quantity": -1, "visibility": "party" }]));
    assert_eq!(code(resolve(&inventory, &initial, json!({ "isAdmin": true }))), "NPC_SOCIAL_INVENTORY_INVALID");
    let voice = with("speech_profile", json!({ "pace": "быстро", "lexicon": "торговые слова" }));
    assert_eq!(code(resolve(&voice, &initial, json!({ "isAdmin": true }))), "NPC_SOCIAL_SPEECH_PROFILE_INVALID");
    let error = validate_npc_social_command(&voice, &initial, &json!({ "isAdmin": true })).expect_err("отказ");
    assert_eq!(error.message, "Речевой профиль NPC требует темп, словарь и привычку");
    assert_eq!(sk_core::RuleError::from(error).code, "NPC_SOCIAL_SPEECH_PROFILE_INVALID");
    assert_eq!(code(resolve(&with("name", json!("Marta")), &initial, json!({}))), "NPC_SOCIAL_FORBIDDEN");
}

#[test]
fn scheduled_unavailable_npc_cannot_be_addressed_even_when_destination_is_hidden() {
    let mut initial = campaign();
    initial["mechanics"]["world_time"] = json!({ "elapsed_minutes": 1_050 });
    initial["social"]["npcs"][0]["schedule"] = json!([
        { "id": "private-errand", "days": [0], "start_minute": 1_020, "end_minute": 1_140, "location": "Duke Archive", "available": false, "visibility": "gm_only" },
    ]);
    assert_eq!(code(resolve(&social_command(json!({})), &initial, json!({ "isSocialController": true }))), "NPC_SOCIAL_NPC_UNAVAILABLE");
}

#[test]
fn persisted_death_overrides_an_available_schedule() {
    let mut state = campaign();
    state["social"]["npcs"][0]["schedule"] = json!([{ "id": "market-shift", "days": [], "start_minute": 0, "end_minute": 1_440, "location": "Market Square", "available": true }]);
    state["npc_world"] = json!({ "vitals": { "marta": { "hp": 0, "max_hp": 4, "alive": false } } });
    state["mechanics"]["world_time"] = json!({ "elapsed_minutes": 600 });
    normalize(&mut state);
    let current = npc_profile_at_world_time(&state["social"]["npcs"][0], &state);
    assert_eq!(current["location"], "Market Square", "расписание всё ещё определяет последний адрес");
    assert_eq!(current["available"], false, "смерть сильнее доступной смены");
    let viewer = npc_social_for_viewer(&state["social"], &json!({ "playerId": "hero", "isPartyMember": true, "state": state }));
    assert_eq!(viewer["npcs"][0]["available"], false);
    assert_eq!(code(resolve(&social_command(json!({})), &state, json!({ "isSocialController": true }))), "NPC_SOCIAL_NPC_UNAVAILABLE");
}

#[test]
fn npc_in_active_combat_is_unavailable_until_combat_ends() {
    let mut state = campaign();
    state["enemies"] = json!([{ "id": "marta", "hp": 4, "maxHp": 4, "alive": true, "origin": { "kind": "authored-npc", "npc_id": "marta" } }]);
    state["mechanics"]["combat"]["active"] = json!(true);
    assert_eq!(npc_profile_at_world_time(&state["social"]["npcs"][0], &state)["available"], false);
    state["mechanics"]["combat"]["active"] = json!(false);
    assert_eq!(npc_profile_at_world_time(&state["social"]["npcs"][0], &state)["available"], true);
}

#[test]
fn server_confirmed_social_turn_is_event_sourced_and_replayable() {
    let initial = campaign();
    let events = resolve(&social_command(json!({})), &initial, json!({ "isSocialController": true })).expect("разговор принят");
    assert_eq!(event_types(&events), ["NpcConversationRecorded", "NpcRelationshipAdjusted", "NpcPromiseRecorded"]);
    let replayed = replay(&initial, &events);
    assert_eq!(replayed["social"]["relationships"]["marta"]["hero"], 4);
    assert_eq!(replayed["social"]["conversations"][0]["npc_reply"], "Bring me the ledger and I will help.");
    assert_eq!(replayed["social"]["promises"][0]["status"], "open");
    assert_eq!(replayed["social"]["npcs"][0]["dossier"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        replayed["social"]["npcs"][0]["dossier"][0]["provenance"],
        json!({ "source_kind": "NpcConversationRecorded", "source_conversation_id": "conversation:one", "source_event_ids": [events[0]["event_id"]] }),
    );
    assert_eq!(events[0]["event_id"], "cmd-1:conversation");
}

#[test]
fn dossier_retains_history_bounds_projection_and_is_idempotent() {
    let initial = campaign();
    let private_conversation = json!({
        "event_id": "event:private-conversation",
        "event_type": "NpcConversationRecorded",
        "payload": { "conversation": {
            "id": "conversation:private", "npc_id": "marta", "hero_id": "hero",
            "player_message": "Что говорят о герцоге?", "npc_reply": "Я слышала обвинение, но не знаю, правда ли это.",
            "stance": "guarded", "disclosed_fact_ids": [], "disclosed_claim_ids": ["claim:duke-rumor"], "visibility": "specific_player",
        } },
        "target_ids": ["marta", "hero"],
        "visibility": "specific_player",
    });
    let once = replay(&initial, std::slice::from_ref(&private_conversation));
    let twice = replay(&once, std::slice::from_ref(&private_conversation));
    assert_eq!(twice["social"]["npcs"][0]["dossier"], once["social"]["npcs"][0]["dossier"]);
    assert_eq!(once["social"]["npcs"][0]["dossier"][0]["disclosed_claims"], json!([{ "id": "claim:duke-rumor", "truth_status": "unknown" }]));
    assert_eq!(once["social"]["npcs"][0]["dossier"][0]["epistemic_status"], "contains_unverified_claims");

    let mut accumulated = twice;
    for index in 0..(NPC_DOSSIER_PROFILE_LIMIT + 4) {
        let event = json!({
            "event_id": format!("event:dossier:{index}"),
            "event_type": "NpcConversationRecorded",
            "payload": { "conversation": {
                "id": format!("conversation:dossier:{index}"), "npc_id": "marta", "hero_id": "hero",
                "player_message": format!("Вопрос {index}"), "npc_reply": format!("Ответ {index}"),
                "stance": if index % 2 == 1 { "friendly" } else { "neutral" }, "disclosed_fact_ids": [], "disclosed_claim_ids": [], "visibility": "party",
            } },
        });
        accumulated = replay(&accumulated, &[event]);
    }
    let dossier = accumulated["social"]["npcs"][0]["dossier"].as_array().cloned().unwrap_or_default();
    assert_eq!(dossier.len(), 1 + NPC_DOSSIER_PROFILE_LIMIT + 4);
    let ids: std::collections::HashSet<String> = dossier.iter().map(|entry| entry["id"].to_string()).collect();
    assert_eq!(ids.len(), dossier.len());
    let hero_view = npc_social_for_viewer(&accumulated["social"], &json!({ "playerId": "hero", "isPartyMember": true }));
    assert_eq!(hero_view["npcs"][0]["dossier"].as_array().map(Vec::len), Some(NPC_DOSSIER_PROFILE_LIMIT));

    let hero = npc_social_for_viewer(&once["social"], &json!({ "playerId": "hero", "isPartyMember": true }));
    let rogue = npc_social_for_viewer(&once["social"], &json!({ "playerId": "rogue", "isPartyMember": true }));
    assert_eq!(hero["npcs"][0]["dossier"].as_array().map(Vec::len), Some(1));
    assert_eq!(rogue["npcs"][0]["dossier"].as_array().map(Vec::len), Some(0));
    assert!(!hero["npcs"][0]["dossier"].to_string().contains("hidden crown"));
    // Нормализация не трогает накопленное досье.
    let mut renormalized = accumulated.clone();
    normalize(&mut renormalized);
    assert_eq!(renormalized["social"]["npcs"][0]["dossier"], accumulated["social"]["npcs"][0]["dossier"]);
}

#[test]
fn players_cannot_forge_npc_turns_and_unknown_facts_are_refused() {
    let initial = campaign();
    assert_eq!(code(resolve(&social_command(json!({})), &initial, json!({}))), "NPC_SOCIAL_FORBIDDEN");
    let forged = social_command(json!({ "disclosed_fact_ids": ["fact:unknown"] }));
    assert_eq!(code(resolve(&forged, &initial, json!({ "isSocialController": true }))), "NPC_SOCIAL_FACT_FORBIDDEN");
}

#[test]
fn disclosed_npc_fact_becomes_personal_knowledge_event() {
    let mut initial = campaign();
    initial["worldMemory"] = json!({
        "schema_version": 2,
        "entities": [{ "id": "npc:marta", "kind": "npc", "name": "Marta", "summary": "", "aliases": [], "visibility": "party", "tags": [] }],
        "facts": [{
            "id": "fact:route", "subject_id": "npc:marta", "predicate": "knows_route",
            "object": "The old aqueduct is safe.", "summary": "The old aqueduct is safe.",
            "visibility": "gm_only", "source_event_ids": [], "source_command_id": "", "supersedes_fact_id": "", "status": "active",
        }],
        "quests": [], "knowledge": {}, "knowledge_ledger": [],
    });
    initial["social"]["npcs"][0]["known_fact_ids"] = json!(["fact:route"]);
    let events = resolve(&social_command(json!({ "disclosed_fact_ids": ["fact:route"] })), &initial, json!({ "isSocialController": true })).expect("раскрытие принято");
    assert_eq!(event_types(&events), ["NpcConversationRecorded", "KnowledgeRevealed", "NpcRelationshipAdjusted", "NpcPromiseRecorded"]);
    let knowledge = &events[1];
    assert_eq!(knowledge["event_id"], "cmd-1:knowledge:1");
    assert_eq!(knowledge["target_ids"], json!(["hero"]));
    assert_eq!(knowledge["visibility"], "specific_player");
    assert_eq!(
        knowledge["payload"],
        json!({ "knowledge_id": "conversation:one:knowledge:1", "hero_id": "hero", "fact_id": "fact:route", "source_event_ids": ["cmd-1:conversation"], "source_kind": "npc", "revealed_at_minutes": 0 }),
    );
}

#[test]
fn social_turns_are_rejected_elsewhere_unavailable_or_in_combat() {
    let mut elsewhere = campaign();
    elsewhere["social"]["npcs"][0]["location"] = json!("Docks");
    elsewhere["merchants"][0]["location"] = json!("Docks");
    normalize(&mut elsewhere);
    assert_eq!(code(resolve(&social_command(json!({})), &elsewhere, json!({ "isSocialController": true }))), "NPC_SOCIAL_WRONG_LOCATION");

    let mut unavailable = campaign();
    unavailable["social"]["npcs"][0]["available"] = json!(false);
    unavailable["merchants"][0]["available"] = json!(false);
    normalize(&mut unavailable);
    assert_eq!(code(resolve(&social_command(json!({})), &unavailable, json!({ "isSocialController": true }))), "NPC_SOCIAL_NPC_UNAVAILABLE");

    let mut combat = campaign();
    combat["mechanics"]["combat"]["active"] = json!(true);
    assert_eq!(code(resolve(&social_command(json!({})), &combat, json!({ "isSocialController": true }))), "NPC_SOCIAL_DURING_COMBAT");
}

#[test]
fn failed_or_insight_check_cannot_become_promise_or_warmer_relationship() {
    let initial = campaign();
    let outcome = json!({ "check_id": "social-check:failure", "npc_id": "marta", "skill": "persuasion", "ability": "cha", "roll_id": "roll-failure", "total": 7, "modifier": 4, "success": false, "degree": "failure" });
    let command = social_command(json!({ "relationship_delta": 2, "check": outcome }));
    let validated = validate_npc_social_command(&command, &initial, &json!({ "isSocialController": true, "socialCheckOutcome": outcome })).expect("провал записан");
    assert_eq!(validated["relationship_delta"], 0);
    assert_eq!(validated["promise"], Value::Null);
    assert_eq!(validated["conversation"]["check"], outcome);
    let mut insight = outcome.clone();
    insight["skill"] = json!("insight");
    insight["success"] = json!(true);
    let validated = validate_npc_social_command(&social_command(json!({ "relationship_delta": 2, "check": insight })), &initial, &json!({ "isSocialController": true, "socialCheckOutcome": insight })).expect("взгляд записан");
    assert_eq!(validated["relationship_delta"], 0);
    let mut forged = outcome.clone();
    forged["success"] = json!(true);
    let mismatch = validate_npc_social_command(&social_command(json!({ "check": forged })), &initial, &json!({ "isSocialController": true, "socialCheckOutcome": outcome }));
    assert_eq!(mismatch.err().map(|error| error.code).as_deref(), Some("NPC_SOCIAL_CHECK_MISMATCH"));
}

#[test]
fn relationship_tiers_are_deterministic_projected_per_hero_and_emit_crossing_event() {
    for (score, tier) in [(-50, "hostile"), (-20, "unfriendly"), (0, "neutral"), (20, "friendly"), (50, "trusted")] {
        assert_eq!(relationship_tier(&json!(score)), tier);
    }
    let mut initial = campaign();
    initial["social"]["relationships"]["marta"]["hero"] = json!(19);
    normalize(&mut initial);
    let events = resolve(&social_command(json!({ "relationship_delta": 1, "promise": null })), &initial, json!({ "isSocialController": true })).expect("разговор");
    assert_eq!(event_types(&events), ["NpcConversationRecorded", "NpcRelationshipAdjusted", "NpcRelationshipTierChanged"]);
    let tier_event = &events[2]["payload"];
    assert_eq!((tier_event["score_before"].clone(), tier_event["score_after"].clone()), (json!(19), json!(20)));
    assert_eq!((tier_event["tier_before"].clone(), tier_event["tier_after"].clone()), (json!("neutral"), json!("friendly")));
    let replayed = replay(&initial, &events);
    let viewer = npc_social_for_viewer(&replayed["social"], &json!({ "playerId": "hero", "isPartyMember": true }));
    assert_eq!(replayed["social"]["relationship_tiers"]["marta"]["hero"], "friendly");
    assert_eq!(viewer["relationship_tiers"]["marta"]["hero"], "friendly");
    assert!(viewer["relationship_tiers"]["marta"].get("rogue").is_none());
}

#[test]
fn promise_hints_become_deadlines_and_overdue_promise_breaks_once() {
    assert_eq!(promise_due_offset_minutes(&json!("через 2 часа")), Some(120));
    assert_eq!(promise_due_offset_minutes(&json!("in 3 days")), Some(4_320));
    assert_eq!(promise_due_offset_minutes(&json!("завтра")), Some(1_440));
    assert_eq!(promise_due_offset_minutes(&json!("after the ledger arrives")), None);

    let mut initial = campaign();
    initial["social"]["relationships"]["marta"]["hero"] = json!(-10);
    normalize(&mut initial);
    let command = social_command(json!({
        "relationship_delta": 0,
        "promise": { "id": "promise:deadline", "direction": "party_to_npc", "text": "The hero will deliver the ledger.", "due_hint": "через 2 часа", "visibility": "specific_player" },
    }));
    let events = resolve(&command, &initial, json!({ "isSocialController": true })).expect("обещание");
    let mut state = replay(&initial, &events);
    assert_eq!(state["social"]["promises"][0]["created_at_minutes"], 0);
    assert_eq!(state["social"]["promises"][0]["deadline_minutes"], 120);
    assert_eq!(state["social"]["promises"][0]["status"], "open");

    assert!(npc_promise_deadline_events(&state, &json!(119)).is_empty());
    state["mechanics"]["world_time"] = json!({ "elapsed_minutes": 119 });
    let deadline = npc_promise_deadline_events(&state, &json!(1));
    assert_eq!(event_types(&deadline), ["NpcPromiseResolved", "NpcRelationshipAdjusted", "NpcRelationshipTierChanged"]);
    state["mechanics"]["world_time"] = json!({ "elapsed_minutes": 120 });
    let state = replay(&state, &deadline);
    let promise = &state["social"]["promises"][0];
    assert_eq!((promise["status"].clone(), promise["resolved_at_minutes"].clone()), (json!("broken"), json!(120)));
    assert_eq!((promise["resolution_reason"].clone(), promise["consequence_delta"].clone()), (json!("deadline"), json!(-15)));
    assert_eq!(state["social"]["relationships"]["marta"]["hero"], -25);
    assert_eq!(state["social"]["relationship_tiers"]["marta"]["hero"], "unfriendly");
    assert!(npc_promise_deadline_events(&state, &json!(60)).is_empty(), "сломанное обещание не ломается второй раз");
}

#[test]
fn only_the_system_resolves_a_promise_and_fulfilment_has_fixed_consequence() {
    let mut initial = campaign();
    initial["social"]["relationships"]["marta"]["hero"] = json!(19);
    normalize(&mut initial);
    let command = social_command(json!({
        "relationship_delta": 0,
        "promise": { "id": "promise:manual", "direction": "party_to_npc", "text": "The hero will return the ledger.", "due_hint": "after finding it", "visibility": "specific_player" },
    }));
    let promised = replay(&initial, &resolve(&command, &initial, json!({ "isSocialController": true })).expect("обещание"));
    let resolve_command = json!({ "command_type": "ResolveNpcPromise", "promise_id": "promise:manual", "status": "fulfilled" });
    assert_eq!(code(resolve(&resolve_command, &promised, json!({}))), "NPC_SOCIAL_FORBIDDEN");
    let events = resolve(&resolve_command, &promised, json!({ "isDirector": true })).expect("итог");
    assert_eq!(event_types(&events), ["NpcPromiseResolved", "NpcRelationshipAdjusted", "NpcRelationshipTierChanged"]);
    let replayed = replay(&promised, &events);
    let promise = &replayed["social"]["promises"][0];
    assert_eq!((promise["status"].clone(), promise["resolution_reason"].clone(), promise["consequence_delta"].clone()), (json!("fulfilled"), json!("manual"), json!(8)));
    assert_eq!(replayed["social"]["relationships"]["marta"]["hero"], 27);
    assert_eq!(replayed["social"]["relationship_tiers"]["marta"]["hero"], "friendly");
    let again = resolve(&resolve_command, &replayed, json!({ "isDirector": true }));
    assert_eq!(code(again), "NPC_PROMISE_NOT_FOUND");
}

#[test]
fn letters_move_relationship_through_the_same_arithmetic() {
    let state = campaign();
    let drafts = npc_relationship_event_drafts(&state, &json!({ "npcId": "marta", "heroId": "hero", "delta": 40, "reason": "letter" }));
    assert_eq!(event_types(&drafts), ["NpcRelationshipAdjusted", "NpcRelationshipTierChanged"]);
    assert_eq!(drafts[0]["payload"]["delta"], 25, "дельта ограничена так же, как у разговора");
    assert_eq!(drafts[0]["payload"]["score_after"], 28);
    assert!(drafts[0].get("event_id").is_none(), "черновик: id проставляет движок");
    assert!(npc_relationship_event_drafts(&state, &json!({ "npcId": "", "heroId": "hero", "delta": 5 })).is_empty());
}

// ── test/npc-retention.test.mjs ─────────────────────────────────────────────

fn retention_conversation(index: impl std::fmt::Display) -> Value {
    json!({ "id": format!("conversation:{index}"), "npc_id": "npc:0", "hero_id": "hero:1", "player_message": format!("Вопрос {index}"), "npc_reply": format!("Ответ {index}"), "stance": "neutral", "disclosed_fact_ids": [], "disclosed_claim_ids": [], "visibility": "party" })
}

fn retention_promise(id: &str, source: &str) -> Value {
    json!({ "id": id, "npc_id": "npc:0", "hero_id": "hero:1", "direction": "npc_to_party", "text": format!("Обещание {id}"), "due_hint": "", "status": "open", "visibility": "party", "source_conversation_id": source })
}

fn retention_dossier(index: usize) -> Value {
    json!({ "id": format!("dossier:{index}"), "hero_id": "hero:1", "summary": format!("Запись {index}"), "stance": "neutral", "visibility": "party", "disclosed_fact_ids": [], "disclosed_claims": [], "provenance": { "source_kind": "NpcConversationRecorded", "source_conversation_id": format!("conversation:dossier:{index}"), "source_event_ids": [format!("event:dossier:{index}")] } })
}

fn len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

#[test]
fn current_normalization_retains_accepted_npcs_history_promises_and_facts() {
    let npcs: Vec<Value> = (0..501)
        .map(|index| {
            json!({
                "id": format!("npc:{index}"), "name": format!("NPC {index}"), "role": "witness", "location": "Market",
                "known_fact_ids": if index == 500 { (0..101).map(|fact| format!("fact:{fact}")).collect::<Vec<_>>() } else { Vec::new() },
                "dossier": if index == 500 { (0..13).map(retention_dossier).collect::<Vec<_>>() } else { Vec::new() },
                "visibility": "party",
            })
        })
        .collect();
    let relationships: serde_json::Map<String, Value> = npcs.iter().map(|npc| (npc["id"].as_str().unwrap_or("").to_string(), json!({ "hero:1": 1 }))).collect();
    let input = json!({
        "npcs": npcs,
        "relationships": relationships,
        "conversations": (0..501).map(retention_conversation).collect::<Vec<_>>(),
        "promises": [retention_promise("promise:first", "conversation:0"), retention_promise("promise:last", "conversation:500")],
    });
    let normalized = normalize_npc_social_state(&input, &NULL);
    assert_eq!(len(&normalized["npcs"]), 501);
    assert_eq!(normalized["npcs"][500]["id"], "npc:500");
    assert_eq!(len(&normalized["npcs"][500]["known_fact_ids"]), 101);
    assert_eq!(len(&normalized["npcs"][500]["dossier"]), 13);
    assert_eq!(len(&normalized["conversations"]), 501);
    assert_eq!(normalized["promises"].as_array().map(|items| items.iter().map(|item| item["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("promise:first"), json!("promise:last")]));
    let viewer = npc_social_for_viewer(&normalized, &json!({ "playerId": "hero:1", "isPartyMember": true }));
    assert_eq!(len(&viewer["npcs"][500]["dossier"]), 12);
    assert_eq!(normalize_npc_social_state(&normalized, &NULL), normalized);
}

#[test]
fn adding_social_events_does_not_evict_accepted_history() {
    let mut social = normalize_npc_social_state(&json!({ "npcs": [{ "id": "npc:0", "name": "NPC", "location": "Market" }] }), &NULL);
    for index in 0..13 {
        let event = json!({ "event_type": "NpcConversationRecorded", "event_id": format!("event:conversation:{index}"), "payload": { "conversation": retention_conversation(format!("added:{index}")) } });
        social = apply_npc_social_event(&social, &event, &NULL, &NULL);
    }
    let upsert = json!({ "event_type": "NpcSocialProfileUpserted", "payload": { "npc": { "id": "npc:0", "name": "NPC", "location": "Market", "known_fact_ids": (0..101).map(|index| format!("fact:{index}")).collect::<Vec<_>>() } } });
    social = apply_npc_social_event(&social, &upsert, &NULL, &NULL);
    assert_eq!(len(&social["conversations"]), 13);
    assert_eq!(len(&social["npcs"][0]["dossier"]), 13);
    assert_eq!(len(&social["npcs"][0]["known_fact_ids"]), 101);
}

#[test]
fn legacy_retention_preserves_the_previous_bounded_reducer() {
    let npcs: Vec<Value> = (0..501)
        .map(|index| {
            json!({
                "id": format!("npc:{index}"), "name": format!("NPC {index}"),
                "known_fact_ids": if index == 0 { (0..101).map(|fact| format!("fact:{fact}")).collect::<Vec<_>>() } else { Vec::new() },
                "dossier": if index == 0 { (0..13).map(retention_dossier).collect::<Vec<_>>() } else { Vec::new() },
            })
        })
        .collect();
    let source = json!({
        "npcs": npcs,
        "conversations": (0..501).map(retention_conversation).collect::<Vec<_>>(),
        "promises": [retention_promise("promise:first", "conversation:0"), retention_promise("promise:last", "conversation:500")],
    });
    let legacy = normalize_npc_social_state_legacy(&source);
    let in_context = with_retention_mode("legacy", || normalize_npc_social_state(&source, &NULL)).expect("режим");
    assert_eq!(in_context, legacy);
    assert_eq!(normalize_npc_social_state(&source, &json!({ "retention": "legacy" })), legacy);
    assert_eq!(len(&legacy["npcs"]), 500);
    assert_eq!(len(&legacy["npcs"][0]["known_fact_ids"]), 100);
    assert_eq!(len(&legacy["npcs"][0]["dossier"]), 12);
    assert_eq!(len(&legacy["conversations"]), 500);
    assert_eq!(legacy["promises"].as_array().map(|items| items.iter().map(|item| item["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("promise:last")]));
    assert_eq!(normalize_npc_social_state_legacy(&legacy), legacy);
    // Явный `isLegacy: false` сильнее контекста.
    let current = with_retention_mode("legacy", || normalize_npc_social_state(&source, &json!({ "isLegacy": false }))).expect("режим");
    assert_eq!(len(&current["npcs"]), 501);
}

// ── test/npc-social-voice.test.mjs ──────────────────────────────────────────

#[test]
fn two_npcs_of_one_scene_get_different_server_owned_voices_and_policies() {
    let mira = json!({
        "id": "npc:mira", "name": "Мира", "role": "хозяйка трактира", "voice": "Говорит быстро, с прибаутками.",
        "speech_profile": { "pace": "быстро, короткими фразами", "lexicon": "трактирные поговорки и бытовые слова", "mannerism": "один раз заканчивает мысль словами «так-то оно вернее»" },
        "goals": ["Сохранить трактир", "Узнать, кто пугает поставщиков"],
    });
    let orin = json!({
        "id": "npc:orin", "name": "Орин", "role": "архивариус", "voice": "Говорит медленно и точно.",
        "speech_profile": { "pace": "медленно, с паузой перед выводом", "lexicon": "книжные слова и названия документов", "mannerism": "перед выводом говорит «согласно записи»" },
        "goals": ["Продать сведения с максимальной выгодой"], "beliefs": ["Каждый договор должен быть взаимным"],
    });
    let mira_voice = npc_speech_profile(&mira);
    let orin_voice = npc_speech_profile(&orin);
    assert_ne!(mira_voice, orin_voice);
    assert!(mira_voice["mannerism"].as_str().unwrap_or("").contains("так-то оно вернее"));
    assert!(orin_voice["mannerism"].as_str().unwrap_or("").contains("согласно записи"));
    // Старый профиль с одним полем `voice` раскладывается в три признака.
    let legacy = npc_speech_profile(&json!({ "voice": "Говорит быстро, с прибаутками.", "role": "хозяйка трактира" }));
    assert_eq!(legacy, json!({ "pace": "быстро, короткими фразами", "lexicon": "простые слова, поговорки и профессиональные присказки", "mannerism": "вставляет одну короткую прибаутку, не повторяя её дословно" }));

    let mira_policy = npc_behavior_policy(&mira, Some(&json!(10)));
    let orin_policy = npc_behavior_policy(&orin, None);
    assert_ne!(mira_policy, orin_policy);
    assert_eq!(mira_policy["concession_style"], "conditional");
    assert_eq!(mira_policy["initiative"], "asks_for_details");
    assert_eq!(orin_policy["concession_style"], "reciprocal");
    assert_eq!(orin_policy["initiative"], "names_a_trade");
    assert!(!orin_policy.to_string().contains("Продать сведения"), "цели не уходят текстом");
}

// ── test/npc-knowledge-leads.test.mjs, test/hero-hooks.test.mjs ─────────────

fn grey_pier() -> Value {
    json!({
        "sessionCode": "GREY-PIER",
        "partyMemberIds": ["wizard", "fighter"],
        "scene": { "title": "Таверна «Сеть»", "location": "Таверна «Сеть»" },
        "mechanics": { "world_time": { "elapsed_minutes": 60 }, "combat": { "active": false } },
        "worldMemory": {
            "entities": [
                { "id": "loc:tavern", "kind": "location", "name": "Таверна «Сеть»" },
                { "id": "loc:pier", "kind": "location", "name": "Пирс Серого Причала" },
                { "id": "loc:lighthouse", "kind": "location", "name": "Старый маяк" },
            ],
            "facts": [
                { "id": "fact:opening", "subject_id": "loc:tavern", "predicate": "opening_narration", "object": "Пролог", "summary": "В таверне «Сеть» пахнет рыбой и дымом.", "visibility": "party", "status": "active", "recorded_at_minutes": 0 },
                { "id": "fact:arrive-pier", "subject_id": "loc:pier", "predicate": "party_arrived", "summary": "Отряд на пирсе.", "visibility": "party", "status": "active", "recorded_at_minutes": 20 },
                { "id": "fact:found-mark", "subject_id": "loc:pier", "predicate": "discovery", "object": "clue", "summary": "На борту баркаса выжжен знак — рыба с тремя глазами.", "visibility": "party", "status": "active", "recorded_at_minutes": 30 },
                { "id": "fact:arrive-tavern", "subject_id": "loc:tavern", "predicate": "party_arrived", "summary": "Отряд вернулся в таверну.", "visibility": "party", "status": "active", "recorded_at_minutes": 50 },
                {
                    "id": "fact:secret:owner", "subject_id": "loc:tavern", "predicate": "gm_secret",
                    "object": json!({ "topic": "чей баркас «Чайка»", "skills": ["investigation", "insight"], "holder": "Борс" }).to_string(),
                    "summary": "Баркас «Чайка» ушёл к маяку той ночью без огней, и правил им чужак.", "visibility": "gm_only", "status": "active", "recorded_at_minutes": 0,
                },
            ],
            "epistemic_claims": [],
        },
        "social": {
            "npcs": [
                { "id": "npc:bors", "name": "Борс", "role": "трактирщик", "location": "Таверна «Сеть»", "public_summary": "Держит таверну у воды.", "visibility": "party", "available": true, "known_fact_ids": ["fact:opening"] },
                { "id": "npc:helga", "name": "Хельга", "role": "рыбачка", "location": "Пирс Серого Причала", "public_summary": "Чинит сети на пирсе.", "visibility": "party", "available": true, "known_fact_ids": [] },
                { "id": "npc:maren", "name": "Марен", "role": "смотритель маяка", "location": "Старый маяк", "public_summary": "Живёт на маяке один.", "visibility": "party", "available": true, "known_fact_ids": [] },
            ],
            "relationships": {}, "conversations": [], "promises": [],
        },
    })
}

#[test]
fn npc_knows_only_what_it_witnessed_or_holds() {
    let state = grey_pier();
    let bors = &state["social"]["npcs"][0];
    let helga = &state["social"]["npcs"][1];
    assert!(!npc_known_fact_ids(&state, bors).contains("fact:found-mark"), "трактирщик был в таверне, а знак нашли на пирсе");
    assert!(npc_known_fact_ids(&state, helga).contains("fact:found-mark"), "рыбачка стояла на пирсе, когда нашли знак");
    assert!(npc_known_fact_ids(&state, bors).contains("fact:secret:owner"), "хранитель назван в самой заготовке");
    assert!(!npc_known_fact_ids(&state, helga).contains("fact:secret:owner"));
    assert_eq!(npc_witnessed_fact_ids(&state, helga), ["fact:arrive-pier", "fact:found-mark"].map(String::from), "пролог был в таверне, без рыбачки");
}

#[test]
fn a_place_secret_without_holder_goes_to_one_resident() {
    let mut state = grey_pier();
    state["scene"] = json!({ "title": "Пирс", "location": "Пирс Серого Причала" });
    state["worldMemory"]["facts"].as_array_mut().expect("факты").push(json!({
        "id": "fact:secret:pier", "subject_id": "loc:pier", "predicate": "gm_secret",
        "object": json!({ "topic": "тайник под пирсом", "skills": ["investigation"], "holder": "" }).to_string(),
        "summary": "Под настилом пирса спрятан ящик с сетями чужаков.", "visibility": "gm_only", "status": "active", "recorded_at_minutes": 0,
    }));
    assert!(npc_known_fact_ids(&state, &state["social"]["npcs"][1]).contains("fact:secret:pier"), "рыбачка — единственная на пирсе");
    assert!(!npc_known_fact_ids(&state, &state["social"]["npcs"][0]).contains("fact:secret:pier"));
    assert_eq!(implicit_secret_holder_ids(&state, None).get("fact:secret:pier").map(String::as_str), Some("npc:helga"));
    let command = json!({
        "command_type": "RecordNpcSocialTurn", "command_id": "cmd-pier", "actor_id": "fighter",
        "conversation": { "id": "conversation:pier", "npc_id": "npc:helga", "hero_id": "fighter", "player_message": "Что спрятано под пирсом?", "npc_reply": "Под настилом ящик чужаков лежит.", "disclosed_fact_ids": ["fact:secret:pier"] },
    });
    let events = resolve(&command, &state, json!({ "isSocialController": true })).expect("хранитель может сказать свою тайну");
    assert!(events.iter().any(|event| event["event_type"] == "KnowledgeRevealed" && event["payload"]["fact_id"] == "fact:secret:pier"));
}

#[test]
fn a_discovery_that_replaces_a_known_secret_stays_the_holders_truth() {
    let mut solved = grey_pier();
    for fact in solved["worldMemory"]["facts"].as_array_mut().expect("факты") {
        if fact["id"] == "fact:secret:owner" {
            fact["status"] = json!("superseded");
        }
    }
    solved["worldMemory"]["facts"].as_array_mut().expect("факты").push(json!({
        "id": "fact:found-owner", "subject_id": "loc:tavern", "predicate": "discovery", "object": "clue",
        "summary": "Баркас «Чайка» ушёл к маяку той ночью без огней, и правил им чужак.", "visibility": "party", "status": "active",
        "supersedes_fact_id": "fact:secret:owner", "recorded_at_minutes": 55,
    }));
    assert!(npc_known_fact_ids(&solved, &solved["social"]["npcs"][0]).contains("fact:found-owner"));
}

#[test]
fn hero_hook_secret_meta_names_topic_holder_and_hero() {
    let fact = json!({ "object": json!({ "topic": "пропавшая сестра Ила", "holder": "Марен", "hero_id": "wizard" }).to_string() });
    assert_eq!(npc_secret_meta(&fact), NpcSecretMeta { topic: "пропавшая сестра Ила".into(), holder: "Марен".into(), hero_id: "wizard".into() });
    let mut state = grey_pier();
    state["worldMemory"]["facts"].as_array_mut().expect("факты").push(json!({ "id": "fact:hook:sister", "subject_id": "loc:lighthouse", "predicate": "gm_secret", "object": fact["object"], "summary": "Ила жива.", "visibility": "gm_only", "status": "active" }));
    assert!(npc_known_fact_ids(&state, &state["social"]["npcs"][2]).contains("fact:hook:sister"));
    assert_eq!(npc_secret_meta(&json!({ "object": "{не json" })), NpcSecretMeta::default());
}

// ── test/narrator-experience.test.mjs ───────────────────────────────────────

fn narrator_brief(dossiers: Value) -> Value {
    json!({ "known_environment": { "story_context": {
        "heroes": [{ "id": "hero:ada", "name": "Ада", "is_viewer": true }],
        "present_npcs": [
            { "id": "npc:marta", "name": "Марта", "beliefs": ["PRIVATE_BELIEF"], "rumors": ["PRIVATE_RUMOR"] },
            { "id": "npc:other", "name": "Орвин", "relationship": "trusted" },
        ],
        "npc_dossiers": dossiers,
    } } })
}

#[test]
fn narrator_dossier_distinguishes_first_meeting_from_return_with_provenance() {
    assert!(npc_dossiers_for_narrator(&narrator_brief(json!([]))).is_empty());
    let returning = narrator_brief(json!([{
        "npc_id": "npc:marta", "name": "Марта",
        "relationship": { "tier": "friendly", "provenance": { "source_event_ids": ["event:relationship:1"] } },
        "interactions": [{
            "id": "interaction:conversation:ledger", "hero_id": "hero:ada",
            "summary": "Герой попросил спрятать реестр. Марта согласилась убрать его под третью половицу.",
            "stance": "guarded", "epistemic_status": "contains_unverified_claims",
            "disclosed_claims": [{ "id": "claim:ledger-owner", "truth_status": "verified" }],
            "provenance": { "source_conversation_id": "conversation:ledger", "source_event_ids": ["event:conversation:ledger"] },
        }, {
            "id": "interaction:conversation:private", "hero_id": "hero:other", "summary": "PRIVATE_OTHER_HERO_DOSSIER", "visibility": "specific_player",
            "provenance": { "source_conversation_id": "conversation:private", "source_event_ids": ["event:conversation:private"] },
        }],
        "promises": [{ "id": "promise:ledger", "direction": "npc_to_party", "text": "Марта сохранит реестр до рассвета.", "due_hint": "до рассвета", "source_conversation_id": "conversation:ledger" }],
        "beliefs": ["PRIVATE_DOSSIER_BELIEF"], "rumors": ["PRIVATE_DOSSIER_RUMOR"],
    }]));
    let dossiers = npc_dossiers_for_narrator(&returning);
    assert_eq!(dossiers.len(), 1);
    let dossier = &dossiers[0];
    assert_eq!(dossier["name"], "Марта");
    assert_eq!(dossier["relationship"]["tier"], "friendly");
    assert_eq!(dossier["interactions"][0]["epistemic_status"], "contains_unverified_claims");
    assert_eq!(dossier["interactions"][0]["disclosed_claims"], json!([{ "id": "claim:ledger-owner", "truth_status": "unknown" }]));
    assert_eq!(dossier["promises"][0]["provenance"]["source_id"], "promise:ledger");
    assert_eq!(dossier["interactions"][0]["provenance"]["source_kind"], "NpcConversationRecorded");
    assert_eq!(dossier["interactions"][0]["provenance"]["source_event_ids"], json!(["event:conversation:ledger"]));
    let text = Value::Array(dossiers.clone()).to_string();
    for secret in ["PRIVATE_BELIEF", "PRIVATE_RUMOR", "PRIVATE_DOSSIER", "PRIVATE_OTHER_HERO"] {
        assert!(!text.contains(secret), "{secret} дошло до Рассказчика");
    }
}

#[test]
fn narrator_dossier_is_bounded_and_deduplicated() {
    let interactions: Vec<Value> = (0..12)
        .map(|index| {
            json!({
                "id": format!("interaction:{}", index % 5), "hero_id": "hero:ada", "summary": format!("Разговор {}", index % 5), "stance": "friendly",
                "visibility": if index == 10 { "gm_only" } else { "party" }, "beliefs": ["PRIVATE_BELIEF"],
                "provenance": { "source_conversation_id": format!("conversation:{}", index % 5), "source_event_ids": [format!("event:conversation:{}", index % 5)] },
            })
        })
        .collect();
    let promises: Vec<Value> = (0..5).map(|index| json!({ "id": format!("promise:{}", index % 3), "direction": "npc_to_party", "text": format!("Обещание {}", index % 3), "source_conversation_id": format!("conversation:{}", index % 3) })).collect();
    let brief = narrator_brief(json!([
        { "npc_id": "npc:other", "name": "Орвин", "relationship": { "tier": "trusted", "provenance": { "source_event_ids": ["event:relationship:orvin"] } }, "interactions": interactions, "promises": promises },
        { "npc_id": "npc:marta", "name": "Марта", "relationship": { "tier": "friendly" }, "interactions": [{ "id": "interaction:marta", "summary": "Эта запись не должна попасть из-за лимита NPC.", "provenance": { "source_conversation_id": "conversation:marta" } }] },
    ]));
    let first = npc_dossiers_for_narrator(&brief);
    assert_eq!(npc_dossiers_for_narrator(&brief.clone()), first);
    assert_eq!(first.len(), NPC_NARRATOR_DOSSIER_LIMITS.npcs);
    assert_eq!(first[0]["name"], "Орвин", "берётся NPC самой свежей повторной встречи");
    assert!(len(&first[0]["interactions"]) <= NPC_NARRATOR_DOSSIER_LIMITS.interactions);
    assert!(len(&first[0]["promises"]) <= NPC_NARRATOR_DOSSIER_LIMITS.promises);
    let text = Value::Array(first).to_string();
    assert!(text.len() < 4_000);
    assert!(!text.contains("PRIVATE_BELIEF"));
}

#[test]
fn npc_reply_is_signed_by_the_npc_and_check_reads_in_russian() {
    let state = campaign();
    let events = [json!({ "event_type": "NpcConversationRecorded", "payload": { "conversation": { "npc_id": "marta", "npc_reply": "Ладно, помогу.", "check": { "skill": "persuasion", "success": true, "total": 18 } } } })];
    let narration = npc_conversation_narration(&events, &state).expect("реплика");
    assert_eq!(narration["narration"], "Проверка «Убеждение»: успех (18).\nЛадно, помогу.");
    assert_eq!(narration["journal_author"], "Marta");
    assert_eq!(narration["provider"], "NpcSocialController");
    assert!(npc_conversation_narration(&[json!({ "event_type": "NpcConversationRecorded", "payload": { "conversation": { "npc_reply": "" } } })], &state).is_none());
}
