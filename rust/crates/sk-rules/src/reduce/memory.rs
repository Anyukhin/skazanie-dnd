//! Память мира и поручения — ветки `applyGameEventCurrent`, которые отдают
//! событие `applyWorldMemoryEvent` (`sk-memory`) и правят цель сцены и
//! основную историю кампании.

use serde_json::Value;
use sk_core::js::{present, s, truthy};
use sk_core::Event;

fn event_value(event: &Event) -> Value {
    serde_json::to_value(event).unwrap_or(Value::Null)
}

fn apply_memory(state: &mut Value, event: &Event) {
    let current = state.get("worldMemory").cloned().unwrap_or(Value::Null);
    state["worldMemory"] = sk_memory::world_memory::apply_world_memory_event(current, &event_value(event), true);
}

/// `campaignModeFor(state)`.
fn persistent(state: &Value) -> bool {
    state.get("campaignConcept").and_then(|concept| concept.get("campaign_mode")).and_then(Value::as_str) == Some("persistent")
}

fn quests(state: &Value) -> &[Value] {
    state.get("worldMemory").and_then(|memory| memory.get("quests")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Цель сцены — и текущая зацепка приключения, подсказки сбрасываются.
fn set_scene_objective(state: &mut Value, objective: String) {
    if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
        scene.insert("objective".into(), Value::from(objective.clone()));
    }
    if let Some(adventure) = state.get_mut("adventure").and_then(Value::as_object_mut) {
        adventure.insert("currentHook".into(), Value::from(objective));
    }
    state["suggestions"] = Value::Array(Vec::new());
}

/// Факты, сущности, отношения, нити, слухи, сводки — только память мира.
pub fn world_memory_event(state: &mut Value, event: &Event) {
    apply_memory(state, event);
}

pub fn quest_upserted(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let quest_id = payload.get("quest").and_then(|quest| quest.get("id")).cloned();
    let is_new = !quests(state).iter().any(|quest| quest.get("id").is_some() && quest.get("id") == quest_id.as_ref());
    apply_memory(state, event);
    let accepted = quests(state).iter().find(|quest| quest.get("id").is_some() && quest.get("id") == quest_id.as_ref()).cloned();
    let schema = payload.get("schema_version");
    let schema_ok = !present(schema) || schema.and_then(Value::as_f64) == Some(1.0);
    let story_unset = !present(state.get("campaignConcept").and_then(|concept| concept.get("story_quest_id")));
    let Some(accepted) = accepted else { return };
    let visible = matches!(accepted.get("visibility").and_then(Value::as_str), Some("public" | "party"));
    let id = s(accepted.get("id"));
    if schema_ok && persistent(state) && story_unset && is_new && accepted.get("status").and_then(Value::as_str) == Some("active") && visible && !id.starts_with("quest:chapter:") {
        if let Some(concept) = state.get_mut("campaignConcept").and_then(Value::as_object_mut) {
            concept.insert("story_quest_id".into(), Value::from(id));
        }
    }
}

pub fn quest_accepted(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    if payload.get("schema_version").and_then(Value::as_f64) != Some(1.0) {
        return;
    }
    apply_memory(state, event);
    if payload.get("selected_as_story") == Some(&Value::Bool(true)) && persistent(state) {
        if let Some(concept) = state.get_mut("campaignConcept").and_then(Value::as_object_mut) {
            concept.insert("story_quest_id".into(), payload.get("quest_id").cloned().unwrap_or(Value::Null));
        }
        let objective = if truthy(payload.get("objective")) { s(payload.get("objective")) } else { String::new() };
        set_scene_objective(state, objective);
    }
}

pub fn quest_concluded(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    apply_memory(state, event);
    let schema = payload.get("schema_version").and_then(Value::as_f64);
    let stays = payload.get("stay_in_location") == Some(&Value::Bool(true)) && payload.get("event_schema_version").and_then(Value::as_f64) == Some(2.0);
    let invalidated = event.event_type == "QuestInvalidated" && matches!(schema, Some(value) if value == 1.0 || value == 2.0);
    if (stays || invalidated) && payload.get("updates_scene_objective") == Some(&Value::Bool(true)) {
        let objective = if truthy(payload.get("next_objective")) { s(payload.get("next_objective")) } else { String::new() };
        set_scene_objective(state, objective);
    }
}
