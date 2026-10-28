//! Ветки `resolveCommandInternal`: Звери: кормление и отпугивание. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21383–21422, 21423–21440. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_npc_world::beast_taming::{beast_food_item_for, beast_for, beast_scare_line, BEAST_APPROACH_MINUTES, BEAST_TAMING_POLICY_ID};

use super::super::world_time::TimeAdvanceOptions;
use super::super::Resolve;
use super::{elapsed_minutes, insert_present, string_or, with_visibility};
use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, player_actor, slice_utf16};
use crate::pause::{Fault, Flow};
use crate::preview_checks::catalog_item_owned;

/// `FeedBeast` (21383–21422).
pub fn feed_beast(r: &mut Resolve<'_>) -> Flow {
    let actor = player_actor(&r.state, r.command.get("actor_id")).cloned();
    let Some(food) = beast_food_item_for(actor.as_ref(), Some(&catalog_item_owned)) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'id')").into());
    };
    let registered = beast_for(&r.state, r.command.get("beast_id"));
    let combat_active = sk_core::game::combat_active(&r.state);
    let actor_targets = json!([r.command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    if combat_active {
        let source = command_with_rules(&r.command, &[rule_ids::TURNS]);
        r.events.push(event_from(&source, "CombatActionUsed", Some(json!({ "action_id": "feed-beast", "name": "Накормить зверя", "action_type": "action" })), Some(&actor_targets)));
    }
    let item_id = js::string(food.get("id"));
    let item_name = slice_utf16(&string_or(food.get("name"), None), 120);
    let mut payload = Map::new();
    insert_present(&mut payload, "beast_id", r.command.get("beast_id"));
    insert_present(&mut payload, "actor_id", r.command.get("beast_actor_id"));
    payload.insert("beast_name".into(), registered.as_ref().and_then(|beast| beast.get("name")).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
    payload.insert("diet".into(), registered.as_ref().and_then(|beast| beast.get("diet")).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("item_id".into(), Value::String(item_id.clone()));
    payload.insert("item_name".into(), Value::String(item_name.clone()));
    payload.insert("at_minutes".into(), elapsed_minutes(&r.state));
    payload.insert("policy_id".into(), json!(BEAST_TAMING_POLICY_ID));
    let targets = json!([r.command.get("beast_actor_id").cloned().unwrap_or(Value::Null), r.command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    r.events.push(event_from(&with_visibility(&r.command, "party"), "BeastFed", Some(Value::Object(payload)), Some(&targets)));
    r.events.push(event_from(&r.command, "ItemConsumed", Some(json!({ "item_id": item_id, "item_name": item_name, "quantity": 1 })), Some(&actor_targets)));
    if !combat_active {
        let source = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
        r.append_world_time_consequences(&source, Some(&json!(BEAST_APPROACH_MINUTES)), Some(&json!("minute")), TimeAdvanceOptions::default())?;
    }
    Ok(())
}

/// `ScareWithBeast` (21423–21440).
pub fn scare_with_beast(r: &mut Resolve<'_>) -> Flow {
    let Some(registered) = beast_for(&r.state, r.command.get("beast_id")) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'id')").into());
    };
    let minutes = elapsed_minutes(&r.state);
    let mut payload = Map::new();
    insert_present(&mut payload, "beast_id", registered.get("id"));
    insert_present(&mut payload, "actor_id", registered.get("actor_id"));
    insert_present(&mut payload, "beast_name", registered.get("name"));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("line".into(), Value::String(beast_scare_line(Some(&registered), Some(&minutes))));
    payload.insert("mechanical_effect".into(), Value::Bool(false));
    payload.insert("at_minutes".into(), minutes);
    payload.insert("policy_id".into(), json!(BEAST_TAMING_POLICY_ID));
    let targets = json!([registered.get("actor_id").cloned().unwrap_or(Value::Null), r.command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    r.events.push(event_from(&with_visibility(&r.command, "party"), "BeastScaredThreat", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}
