//! Ветки `resolveCommandInternal`: Незнакомец сценария `StageScenarioStranger` (приход и выдох). Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 20952–21007. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use std::sync::Arc;
use serde_json::{json, Map, Value};
use sk_attention::scenario_attention::{scenario_stranger_breath, SCENARIO_STRANGER_EVENT, SCENARIO_STRANGER_EVENT_SCHEMA_VERSION};
use sk_core::{game, js};

use super::Resolve;
use crate::checks::saves::{saved_damage_amount, saving_throw_succeeded};
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with, command_with_rules, event_from, npc_world_events_from, spread_value, unique_strings};
use crate::death::zero_hit_point_damage_consequences;
use crate::pause::{Fault, Flow};
use crate::replay::apply_game_event;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// Поле, которое JS кладёт как есть (`undefined` в JSON не попадает).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `{ ...command, visibility }`, где `undefined` — поле без значения
/// (`eventFrom` поставит `public`).
fn with_visibility(command: &Value, visibility: Option<&Value>) -> Value {
    match visibility {
        Some(visibility) => command_with(command, "visibility", visibility.clone()),
        None => {
            let mut map = spread_value(Some(command));
            map.shift_remove("visibility");
            Value::Object(map)
        }
    }
}

/// `StageScenarioStranger` (20952–21007).
pub fn stage_scenario_stranger(r: &mut Resolve<'_>) -> Flow {
    let state = r.state.clone();
    let command = r.command.clone();
    let npc = command.get("npc");
    let npc_id = at(npc, "id").cloned();
    let location_id = at(npc, "location_id").cloned();
    let profile_command = command_with(&command, "command_type", json!("UpsertNpcSocialProfile"));
    let profile_events: Vec<Value> = sk_social::npc_social::npc_social_events(&profile_command, &state)
        .iter()
        .map(|social| {
            let source = with_visibility(&command, social.get("visibility"));
            event_from(&source, &js::s(social.get("event_type")), social.get("payload").cloned(), social.get("target_ids"))
        })
        .collect();
    let npc_targets = json!([npc_id.clone().unwrap_or(Value::Null)]);
    let staged = |stage: &str, breath: Option<&Value>| {
        let mut payload = Map::new();
        payload.insert("schema_version".into(), json!(SCENARIO_STRANGER_EVENT_SCHEMA_VERSION));
        payload.insert("stage".into(), json!(stage));
        insert_present(&mut payload, "npc_id", npc_id.as_ref());
        insert_present(&mut payload, "location_id", location_id.as_ref());
        insert_present(&mut payload, "breath", breath);
        event_from(&command, SCENARIO_STRANGER_EVENT, Some(Value::Object(payload)), Some(&npc_targets))
    };
    if command.get("stage").and_then(Value::as_str) == Some("arrive") {
        r.events.extend(profile_events.iter().cloned());
        let projected = r.projector.project(&profile_events)?;
        let placements = sk_npc_world::npc_positioning::plan_scene_npc_placement_events(&projected);
        r.events.extend(npc_world_events_from(&command, &Value::Array(placements)));
        r.events.push(staged("arrived", None));
        return Ok(());
    }
    let Some(breath) = scenario_stranger_breath(&state) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'expression')").into());
    };
    r.events.push(staged("revealed", Some(&breath)));
    let damage_roll = r.roll_dice(breath.get("expression").cloned().unwrap_or(Value::Null), "scenario_stranger_breath", Value::Null, json!("public"))?;
    r.rolls.push(damage_roll.clone());
    r.events.push(event_from(&command, "DieRolled", Some(damage_roll.clone()), Some(&json!([]))));
    let ability = breath.get("ability");
    let ability_key = js::string(ability);
    let difficulty = js::number(breath.get("dc"));
    let mut sweep_state = state.clone();
    let empty = json!([]);
    let members = state.get("partyMemberIds").filter(|value| !value.is_null()).unwrap_or(&empty);
    let heroes: Vec<Value> = unique_strings(Some(members)).iter().filter_map(|hero_id| game::find_actor(&state, hero_id)).filter(|hero| game::is_living_actor(hero)).cloned().collect();
    for hero in heroes {
        let hero_id = game::actor_id(&hero);
        let mut options = Map::new();
        options.insert("ability".into(), super::kernel::undef(ability));
        options.insert("modifier".into(), json!(ability_modifier(at(hero.get("abilities"), &ability_key))));
        options.insert("purpose".into(), Value::String(format!("scenario_stranger_save:{ability_key}")));
        options.insert("visibility".into(), json!("public"));
        let hero_value = Value::String(hero_id.clone());
        let save = r.roll_saving_throw(&sweep_state, Some(&hero_value), &Value::Object(options))?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), difficulty);
        let mut payload = spread_value(Some(&save));
        insert_present(&mut payload, "ability", ability);
        insert_present(&mut payload, "difficulty", breath.get("dc"));
        payload.insert("saved".into(), json!(saved));
        payload.insert("source".into(), json!("scenario-stranger"));
        let hero_targets = json!([hero_id]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&hero_targets)));
        let amount = saved_damage_amount(&sweep_state, &hero_id, ability, saved, true, damage_roll.get("total"));
        if amount <= 0 {
            continue;
        }
        let damage_state = sweep_state.clone();
        let damage_type = breath.get("damage_type").cloned().unwrap_or(Value::Null);
        let resolved = r.resolve_damage_payload(&damage_state, &hero_id, json!(amount), &damage_type, None, None)?;
        let mut applied_payload = spread_value(Some(&resolved));
        applied_payload.insert("saved".into(), json!(saved));
        applied_payload.insert("source".into(), json!("scenario-stranger"));
        let applied = event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(applied_payload)), Some(&hero_targets));
        r.events.push(applied.clone());
        sweep_state = Arc::new(apply_game_event(&sweep_state, &applied)?);
        let consequences = zero_hit_point_damage_consequences(&damage_state, &command, &hero_id, &resolved, false);
        r.events.extend(consequences.iter().cloned());
        for event in &consequences {
            sweep_state = Arc::new(apply_game_event(&sweep_state, event)?);
        }
    }
    r.events.extend(profile_events);
    Ok(())
}
