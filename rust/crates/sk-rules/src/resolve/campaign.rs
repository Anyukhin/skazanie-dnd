//! Ветки `resolveCommandInternal`: Кампания и память мира: решение отряда, цель, 15 команд памяти мира, финал, дуга, социальные профили NPC. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 22766–22770, 22771–22773, 22797–22821, 22822–22836, 22837–22859, 22862–22879. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_economy::merchant_economy::{normalize_inventory_item, InventoryItemOptions};

use super::Resolve;
use crate::core::{command_with, event_from, item_granted_event_from, objective_within_limit, slice_utf16, unique_strings};
use crate::pause::{Fault, Interrupt, Flow};

/// Ошибка `campaign-lifecycle` (`TypeError` на испорченном состоянии) — как есть.
fn director_halt(error: sk_director::adventure_director::DirectorError) -> Interrupt {
    let fault = Fault::new(error.name, error.message);
    match error.code {
        Some(code) => fault.with_code(code).into(),
        None => fault.into(),
    }
}

/// Ошибка `questDecisionEvents`: класс модуля, не `RulesValidationError`.
fn quest_decision_halt(error: sk_memory::party_decision::QuestDecisionError) -> Interrupt {
    // `sk-memory` передаёт `TypeError` JS отказом с этим кодом.
    if error.code() == "WORLD_MEMORY_TYPE_ERROR" {
        return Fault::type_error(error.message()).into();
    }
    let name = match &error {
        sk_memory::party_decision::QuestDecisionError::Party(_) => "PartyDecisionError",
        sk_memory::party_decision::QuestDecisionError::WorldMemory(_) => "WorldMemoryValidationError",
    };
    Fault::new(name, error.message()).with_code(error.code()).into()
}

fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// Событие из черновика модуля: `eventFrom({ ...command, visibility: draft.visibility }, …)`.
fn draft_event(command: &Value, draft: &Value) -> Value {
    let source = command_with(command, "visibility", field(draft, "visibility"));
    event_from(&source, &js::s(draft.get("event_type")), draft.get("payload").cloned(), draft.get("target_ids"))
}

/// `ResolveQuestDecision` (22766–22770).
pub fn resolve_quest_decision(r: &mut Resolve<'_>) -> Flow {
    let drafts = sk_memory::party_decision::quest_decision_events(&r.command, &r.state, &r.context.json()).map_err(quest_decision_halt)?;
    for draft in drafts {
        r.events.push(draft_event(&r.command, &draft));
    }
    Ok(())
}

/// `UpdateObjective` (22771–22773).
pub fn update_objective(r: &mut Resolve<'_>) -> Flow {
    let objective = objective_within_limit(r.command.get("objective"), 120);
    r.events.push(event_from(&r.command, "ObjectiveUpdated", Some(json!({ "objective": objective })), Some(&json!([]))));
    Ok(())
}

/// Команды памяти мира (22782–22821): событие памяти и награда за найденную
/// тайну сценария (оберег Ломара).
pub fn world_memory(r: &mut Resolve<'_>) -> Flow {
    let Some(world_event) = sk_memory::world_memory::world_memory_event(&r.command) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'event_type')").into());
    };
    r.events.push(event_from(&r.command, &js::s(world_event.get("event_type")), world_event.get("payload").cloned(), world_event.get("target_ids")));
    let fact = r.command.get("fact");
    let found = if r.command.get("command_type").and_then(Value::as_str) == Some("RecordWorldFact") && fact.and_then(|fact| fact.get("predicate")).and_then(Value::as_str) == Some("discovery") {
        js::s(fact.and_then(|fact| fact.get("supersedes_fact_id")))
    } else {
        String::new()
    };
    let reward_id = if found.is_empty() { None } else { sk_scenario::campaign_scenario::scenario_clue_reward_catalog_id(&r.state, &found) };
    let Some(reward_id) = reward_id.filter(|id| !id.is_empty()) else { return Ok(()) };
    let facts = r.state.get("worldMemory").and_then(|memory| memory.get("facts")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let already_found = facts.iter().any(|fact| fact.get("predicate").and_then(Value::as_str) == Some("discovery") && js::s(fact.get("supersedes_fact_id")) == found)
        || sk_story::campaign_dialogues::dialogue_granted_fact_ids(&r.state).contains(&found);
    if already_found {
        return Ok(());
    }
    let party = unique_strings(Some(r.state.get("partyMemberIds").filter(|ids| !ids.is_null()).unwrap_or(&json!([]))));
    let actor = js::s(r.command.get("actor_id"));
    let recipient = if party.contains(&actor) {
        Some(js::string(r.command.get("actor_id")))
    } else {
        party.iter().find(|hero| sk_core::game::find_actor(&r.state, hero).is_some_and(sk_core::game::is_living_actor)).or_else(|| party.first()).cloned()
    };
    let Some(recipient) = recipient.filter(|recipient| !recipient.is_empty()) else { return Ok(()) };
    let item = sk_items::item_catalog::materialize_catalog_item(&reward_id, Some(&json!({ "quantity": 1, "origin": "found" })));
    let fallback = format!("scenario-reward:{found}");
    let item = normalize_inventory_item(Some(&item), InventoryItemOptions { id_fallback: &fallback, preserve_unknown: true, hydrate_catalog: false });
    let source = command_with(&r.command, "actor_id", json!(recipient));
    let targets = json!([recipient]);
    r.events.push(item_granted_event_from(&source, Some(json!({ "item": item })), Some(&targets)));
    Ok(())
}

/// `x || null`.
fn or_null(value: Option<&Value>) -> Value {
    value.filter(|value| js::truthy(Some(value))).cloned().unwrap_or(Value::Null)
}

/// `CompleteCampaign` (22822–22836).
pub fn complete_campaign(r: &mut Resolve<'_>) -> Flow {
    let ending = sk_scenario::campaign_scenario::scenario_ending(&r.state);
    let mut payload = Map::new();
    payload.insert("status".into(), json!("completed"));
    if let Some(reason) = r.command.get("reason") {
        payload.insert("reason".into(), reason.clone());
    }
    payload.insert("changed_by".into(), Value::Null);
    payload.insert("occurred_at".into(), or_null(r.command.get("occurred_at")));
    if let Some(epilogue) = r.command.get("epilogue") {
        payload.insert("epilogue".into(), epilogue.clone());
    }
    payload.insert("completion_policy".into(), json!("campaign-arc-completion-v1"));
    if let Some(ending) = ending {
        payload.insert("ending".into(), json!({ "id": field(&ending, "id"), "title": field(&ending, "title"), "outcome": field(&ending, "outcome") }));
    }
    r.events.push(event_from(&r.command, "CampaignCompleted", Some(Value::Object(payload)), Some(&json!([]))));
    Ok(())
}

/// `AdvanceCampaignArc` (22837–22859).
pub fn advance_campaign_arc(r: &mut Resolve<'_>) -> Flow {
    let Some(closing) = sk_story::campaign_loop_policy::campaign_arc_plan(&r.state) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'seed')").into());
    };
    let next_number = js::num(js::number(closing.get("arc_number")) + 1.0);
    let next_arc = sk_story::campaign_loop_policy::build_campaign_arc_plan(closing.get("seed"), Some(&next_number));
    let mut payload = Map::new();
    if let Some(reason) = r.command.get("reason") {
        payload.insert("reason".into(), reason.clone());
    }
    payload.insert("occurred_at".into(), or_null(r.command.get("occurred_at")));
    if let Some(epilogue) = r.command.get("epilogue") {
        payload.insert("epilogue".into(), epilogue.clone());
    }
    if let Some(chronicle) = r.command.get("chronicle").filter(|value| js::truthy(Some(value))) {
        payload.insert("chronicle".into(), json!(slice_utf16(&js::s(Some(chronicle)), 12_000)));
    }
    if let Some(hook) = r.command.get("hook") {
        payload.insert("hook".into(), hook.clone());
    }
    let chapter = js::safe_int(r.state.get("adventure").and_then(|adventure| adventure.get("chapter")), 1).max(1);
    let location = slice_utf16(&js::s(r.state.get("scene").and_then(|scene| scene.get("location"))), 180);
    payload.insert(
        "closed_arc".into(),
        json!({ "arc_number": field(&closing, "arc_number"), "target_scenes": field(&closing, "target_scenes"), "final_chapter": chapter, "final_location": location }),
    );
    payload.insert("next_arc".into(), next_arc);
    payload.insert("carried".into(), sk_director::campaign_lifecycle::campaign_arc_carry_over(&r.state).map_err(director_halt)?);
    payload.insert("arc_policy".into(), json!("campaign-arc-chain-v1"));
    r.events.push(event_from(&r.command, "CampaignArcCompleted", Some(Value::Object(payload)), Some(&json!([]))));
    Ok(())
}

/// `UpsertNpcSocialProfile`, `RecordNpcSocialTurn`, `ResolveNpcPromise` (22860–22879).
pub fn npc_social(r: &mut Resolve<'_>) -> Flow {
    let mut added = Vec::new();
    for social in sk_social::npc_social::npc_social_events(&r.command, &r.state) {
        let mut event = draft_event(&r.command, &social);
        if let Some(event_id) = social.get("event_id").filter(|value| js::truthy(Some(value))) {
            event["event_id"] = event_id.clone();
        }
        r.events.push(event.clone());
        added.push(event);
    }
    if r.command.get("command_type").and_then(Value::as_str) == Some("UpsertNpcSocialProfile") && !added.is_empty() {
        let with_profile = r.projector.project(&added)?;
        let drafts = Value::Array(sk_npc_world::npc_positioning::plan_scene_npc_placement_events(&with_profile));
        r.events.extend(crate::core::npc_world_events_from(&r.command, &drafts));
    }
    Ok(())
}
