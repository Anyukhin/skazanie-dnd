//! Ветки `resolveCommandInternal`: NPC мира: пост, перемещение, вред. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 20986–21001, 21002–21018, 21019–21029. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_npc_world::npc_positioning::{initial_npc_vital, npc_harm_event_drafts, npc_placement_for, NpcHarmOptions, NPC_WORLD_POLICY_ID};

use super::super::Resolve;
use super::{insert_present, social_npc, string_or};
use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, npc_world_events_from, slice_utf16};
use crate::pause::Step;

/// `npc_name`, `npc_role` поста: `String(npc?.name ?? command.npc_id)`, `String(npc?.role ?? '')`.
fn npc_labels(npc: Option<&Value>, npc_id: Option<&Value>) -> (String, String) {
    let name = string_or(npc.and_then(|npc| npc.get("name")), npc_id);
    let role = string_or(npc.and_then(|npc| npc.get("role")), None);
    (slice_utf16(&name, 160), slice_utf16(&role, 160))
}

/// `command.to.x`, `command.to.y`.
fn insert_destination(payload: &mut Map<String, Value>, command: &Value) {
    let to = command.get("to");
    insert_present(payload, "x", to.and_then(|to| to.get("x")));
    insert_present(payload, "y", to.and_then(|to| to.get("y")));
}

/// `PlaceNpc` (20986–21001).
pub fn place_npc(r: &mut Resolve<'_>) -> Step {
    let npc_id = r.command.get("npc_id").cloned();
    let npc = social_npc(&r.state, npc_id.as_ref());
    let (name, role) = npc_labels(npc.as_ref(), npc_id.as_ref());
    let mut payload = Map::new();
    insert_present(&mut payload, "npc_id", npc_id.as_ref());
    payload.insert("npc_name".into(), Value::String(name));
    payload.insert("npc_role".into(), Value::String(role));
    insert_present(&mut payload, "location_id", r.command.get("location_id"));
    insert_destination(&mut payload, &r.command);
    payload.insert("anchor_prop_id".into(), r.command.get("anchor_prop_id").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
    payload.insert("placement_reason".into(), json!("system-command"));
    payload.insert("vitality".into(), initial_npc_vital(npc.as_ref()));
    payload.insert("policy_id".into(), json!(NPC_WORLD_POLICY_ID));
    let targets = json!([npc_id.unwrap_or(Value::Null)]);
    r.events.push(event_from(&r.command, "NpcPlaced", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `MoveNpc` (21002–21018).
pub fn move_npc(r: &mut Resolve<'_>) -> Step {
    let npc_id = r.command.get("npc_id").cloned();
    let npc = social_npc(&r.state, npc_id.as_ref());
    let before = npc_placement_for(&r.state, npc_id.as_ref().unwrap_or(&Value::Null), r.command.get("location_id"));
    let (name, role) = npc_labels(npc.as_ref(), npc_id.as_ref());
    let mut payload = Map::new();
    insert_present(&mut payload, "npc_id", npc_id.as_ref());
    payload.insert("npc_name".into(), Value::String(name));
    payload.insert("npc_role".into(), Value::String(role));
    insert_present(&mut payload, "location_id", r.command.get("location_id"));
    let from = match before.filter(|before| js::truthy(Some(before))) {
        Some(before) => {
            let mut from = Map::new();
            insert_present(&mut from, "x", before.get("x"));
            insert_present(&mut from, "y", before.get("y"));
            Value::Object(from)
        }
        None => Value::Null,
    };
    payload.insert("from".into(), from);
    insert_destination(&mut payload, &r.command);
    payload.insert("anchor_prop_id".into(), r.command.get("anchor_prop_id").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
    payload.insert("placement_reason".into(), json!("system-command"));
    payload.insert("policy_id".into(), json!(NPC_WORLD_POLICY_ID));
    let targets = json!([npc_id.unwrap_or(Value::Null)]);
    r.events.push(event_from(&r.command, "NpcMoved", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `HarmNpc` (21019–21029).
pub fn harm_npc(r: &mut Resolve<'_>) -> Step {
    let field = |key: &str| r.command.get(key).cloned();
    let options = NpcHarmOptions {
        npc_id: field("npc_id"),
        amount: field("amount"),
        damage_type: field("damage_type"),
        source_event_id: field("source_event_id"),
        source_actor_id: field("source_actor_id"),
        trigger: field("trigger"),
        command_id: field("command_id"),
        ..NpcHarmOptions::default()
    };
    let drafts = npc_harm_event_drafts(&r.state, &options);
    let source = command_with_rules(&r.command, &[rule_ids::DAMAGE]);
    r.events.extend(npc_world_events_from(&source, &Value::Array(drafts)));
    Ok(())
}
