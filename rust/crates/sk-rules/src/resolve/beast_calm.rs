//! Ветки `resolveCommandInternal`: Уговор зверя `CalmBeast` (проверка характеристики с укусом на провале). Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 21267–21382. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::{game, js};
use sk_npc_world::beast_taming::{beast_draft_for, beast_for, beast_taming_policy, BEAST_APPROACH_MINUTES, BEAST_TAMING_ABILITY, BEAST_TAMING_POLICY_ID, BEAST_TAMING_SKILL};

use super::doors::roll_check;
use super::kernel::undef;
use super::world_time::TimeAdvanceOptions;
use super::Resolve;
use crate::checks::saves::check_roll_from_verified;
use crate::command::rules::rule_ids;
use crate::core::{command_with, command_with_rules, event_from, slice_utf16, spread_value};
use crate::death::zero_hit_point_damage_consequences;
use crate::pause::Step;
use crate::preview_checks::preview_d20_check;

/// Поле, которое JS кладёт как есть (`undefined` в JSON не попадает).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `CalmBeast` (21267–21382).
pub fn calm_beast(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    // `actorId(candidate) === command.beast_actor_id`: строгое сравнение со строкой команды.
    let wanted = command.get("beast_actor_id").and_then(Value::as_str);
    let enemy = state.get("enemies").and_then(Value::as_array).and_then(|enemies| enemies.iter().find(|candidate| Some(game::actor_id(candidate).as_str()) == wanted)).cloned();
    let registered = beast_for(&state, command.get("beast_id"));
    let policy = beast_taming_policy(&state, enemy.as_ref(), registered.as_ref()).to_json();
    let minutes = js::num(sk_social::npc_social::campaign_elapsed_minutes(&state));
    let combat_active = game::combat_active(&state);
    let actor_targets = json!([command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    let beast_targets = json!([command.get("beast_actor_id").cloned().unwrap_or(Value::Null)]);
    let both_targets = json!([command.get("beast_actor_id").cloned().unwrap_or(Value::Null), command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    let party = command_with(&command, "visibility", json!("party"));
    if combat_active {
        let payload = json!({ "action_id": "calm-beast", "name": "Успокоить зверя", "action_type": "action" });
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "CombatActionUsed", Some(payload), Some(&actor_targets)));
    }
    if registered.is_none() {
        let beast = beast_draft_for(&state, enemy.as_ref()).unwrap_or(Value::Null);
        r.events.push(event_from(&party, "BeastEncountered", Some(json!({ "beast": beast })), Some(&beast_targets)));
    }
    let difficulty = policy.get("difficulty").cloned().unwrap_or(Value::Null);
    let mut preview_options = Map::new();
    insert_present(&mut preview_options, "actorId", command.get("actor_id"));
    preview_options.insert("kind".into(), json!("check"));
    preview_options.insert("ability".into(), json!(BEAST_TAMING_ABILITY));
    preview_options.insert("skill".into(), json!(BEAST_TAMING_SKILL));
    preview_options.insert("difficulty".into(), difficulty.clone());
    let preview = preview_d20_check(&state, &Value::Object(preview_options))?;
    let mut options = Map::new();
    options.insert("modifier".into(), undef(preview.get("modifier")));
    options.insert("difficulty".into(), difficulty);
    options.insert("purpose".into(), Value::String(format!("beast_taming:{}", js::string(policy.get("stage")))));
    options.insert("actorId".into(), undef(command.get("actor_id")));
    options.insert("advantage".into(), undef(preview.get("advantage")));
    options.insert("disadvantage".into(), undef(preview.get("disadvantage")));
    options.insert("visibility".into(), undef(command.get("visibility")));
    let options = Value::Object(options);
    let roll = match check_roll_from_verified(command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => roll_check(r, &options)?,
    };
    r.rolls.push(roll.clone());
    let soothing_event_id = format!("beast-soothed:{}", slice_utf16(&js::string(command.get("command_id")), 100));
    let beast_name = slice_utf16(&js::s(enemy.as_ref().and_then(|enemy| enemy.get("name"))), 160);
    let success = roll.get("success").cloned();
    let mut payload = Map::new();
    insert_present(&mut payload, "beast_id", command.get("beast_id"));
    insert_present(&mut payload, "actor_id", command.get("beast_actor_id"));
    payload.insert("beast_name".into(), json!(beast_name));
    insert_present(&mut payload, "hero_id", command.get("actor_id"));
    insert_present(&mut payload, "skill", policy.get("skill"));
    insert_present(&mut payload, "ability", policy.get("ability"));
    insert_present(&mut payload, "diet", policy.get("diet"));
    insert_present(&mut payload, "wounded", policy.get("wounded"));
    insert_present(&mut payload, "broken_morale", policy.get("broken_morale"));
    insert_present(&mut payload, "stage_before", policy.get("stage"));
    insert_present(&mut payload, "stage_after", policy.get("stage_after"));
    insert_present(&mut payload, "difficulty_parts", policy.get("parts"));
    // `...roll` после полей события: `actor_id` броска (герой) встаёт на
    // место `actor_id` зверя — так в JS.
    payload.extend(spread_value(Some(&roll)));
    insert_present(&mut payload, "success", success.as_ref());
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), json!(BEAST_TAMING_POLICY_ID));
    let event = event_from(&command_with_rules(&command, &[rule_ids::ABILITY_CHECK]), "BeastSoothingResolved", Some(Value::Object(payload)), Some(&both_targets));
    let mut event = spread_value(Some(&event));
    event.insert("event_id".into(), json!(soothing_event_id));
    r.events.push(Value::Object(event));
    let succeeded = js::truthy(success.as_ref());
    if succeeded && policy.get("stage_after").and_then(Value::as_str) == Some("tamed") {
        let mut payload = Map::new();
        insert_present(&mut payload, "beast_id", command.get("beast_id"));
        insert_present(&mut payload, "actor_id", command.get("beast_actor_id"));
        payload.insert("beast_name".into(), json!(beast_name));
        insert_present(&mut payload, "hero_id", command.get("actor_id"));
        insert_present(&mut payload, "diet", policy.get("diet"));
        payload.insert("source_event_id".into(), json!(soothing_event_id));
        payload.insert("at_minutes".into(), minutes.clone());
        payload.insert("combat_companion".into(), json!(false));
        payload.insert("policy_id".into(), json!(BEAST_TAMING_POLICY_ID));
        r.events.push(event_from(&party, "BeastTamed", Some(Value::Object(payload)), Some(&both_targets)));
    }
    if !succeeded && js::truthy(policy.get("bites_on_failure")) {
        let bite_damage = policy.get("bite_damage").cloned().unwrap_or(Value::Null);
        let visibility = command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("public"));
        let bite = r.roll_dice(bite_damage.clone(), "beast_taming:bite", command.get("beast_actor_id").cloned().unwrap_or(Value::Null), visibility)?;
        r.rolls.push(bite.clone());
        let actor_id = js::s(command.get("actor_id"));
        let bite_payload = r.resolve_damage_payload(&state, &actor_id, bite.get("total").cloned().unwrap_or(Value::Null), &json!("piercing"), None, None)?;
        let mut payload = Map::new();
        insert_present(&mut payload, "beast_id", command.get("beast_id"));
        insert_present(&mut payload, "actor_id", command.get("beast_actor_id"));
        payload.insert("beast_name".into(), json!(beast_name));
        insert_present(&mut payload, "hero_id", command.get("actor_id"));
        payload.insert("expression".into(), bite_damage);
        insert_present(&mut payload, "amount", bite.get("total"));
        payload.insert("source_event_id".into(), json!(soothing_event_id));
        payload.insert("at_minutes".into(), minutes);
        payload.insert("policy_id".into(), json!(BEAST_TAMING_POLICY_ID));
        r.events.push(event_from(&party, "BeastBit", Some(Value::Object(payload)), Some(&actor_targets)));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(bite_payload.clone()), Some(&actor_targets)));
        r.events.extend(zero_hit_point_damage_consequences(&state, &command, &actor_id, &bite_payload, false));
    }
    if !combat_active {
        let source = command_with_rules(&command, &[rule_ids::RESOURCE]);
        r.append_world_time_consequences(&source, Some(&json!(BEAST_APPROACH_MINUTES)), Some(&json!("minute")), TimeAdvanceOptions::default())?;
    }
    Ok(())
}
