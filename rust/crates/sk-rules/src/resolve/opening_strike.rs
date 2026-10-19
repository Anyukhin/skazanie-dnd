//! Удар-открытие из исследования: `openingStrikeFor`,
//! `openingStrikeTurnState`, `resolveOpeningStrike` (`rules-engine.mjs`,
//! 12851–12992), `HARMFUL_SPELL_KINDS` (700). Задача Р5.
//!
//! Нападение героя вне боя открывает бой: `StartCombat` (или `AttackNpc` для
//! нейтрального NPC сцены), затем сам удар. С домашним правилом
//! `house:bg3-opening-strike` удар идёт сразу и не съедает ход
//! (`OpeningStrikeEconomyRestored`); без него — только если нападающий ходит
//! первым, иначе законность удара проверяется сухим прогоном с костями
//! «всегда минимум», а сам удар ждёт хода.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::api::resolve_internal;
use super::Resolved;
use crate::context::{Context, Uuid};
use crate::core::{command_with, event_from, spread_value, unique_strings};
use crate::dice_record::RulesDice;
use crate::pause::Halt;
use crate::replay::apply_game_event;

/// `OPENING_STRIKE_COMMAND_TYPES`.
pub const OPENING_STRIKE_COMMAND_TYPES: [&str; 4] = ["MakeAttack", "MakeAreaAttack", "CastSpell", "UseCombatAction"];

/// `HARMFUL_SPELL_KINDS`: виды заклинаний, которые открывают бой.
pub const HARMFUL_SPELL_KINDS: [&str; 6] = ["attack", "damage", "area-damage", "save", "area-save", "debuff"];

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `a ?? b`.
fn either<'a>(input: &'a Value, first: &str, second: &str) -> Option<&'a Value> {
    crate::core::coalesce(&[input.get(first)]).or_else(|| input.get(second))
}

/// Нападение из исследования (`openingStrikeFor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpeningStrike {
    pub actor_id: String,
    pub command_type: String,
    /// Нейтральный NPC сцены — цель (бой через `AttackNpc`).
    pub npc_id: Option<String>,
}

/// `openingStrikeFor(input, rawState, context)`: открывает ли команда бой.
pub fn opening_strike_for(input: &Value, raw_state: &Value, context: &Context) -> Result<Option<OpeningStrike>, Halt> {
    if context.resolve_depth() != 0 || context.is_npc_scheduler() || context.is_director() {
        return Ok(None);
    }
    let command_type = js::s(either(input, "command_type", "type"));
    if !OPENING_STRIKE_COMMAND_TYPES.contains(&command_type.as_str()) {
        return Ok(None);
    }
    if js::is_true(at(at(raw_state.get("mechanics"), "combat"), "active")) {
        return Ok(None);
    }
    let state = crate::normalize::normalize_campaign_state(raw_state)?;
    if sk_core::game::combat_active(&state) {
        return Ok(None);
    }
    let hero_id = js::s(either(input, "actor_id", "actorId"));
    let Some(hero) = crate::core::player_actor(&state, Some(&Value::String(hero_id.clone()))).filter(|hero| sk_core::game::is_living_actor(hero)) else { return Ok(None) };
    let targets_value = match crate::core::coalesce(&[input.get("target_ids")]).or_else(|| crate::core::coalesce(&[input.get("targetIds")])) {
        Some(value) => value.clone(),
        None => {
            let single = crate::core::coalesce(&[input.get("target_id")]).or_else(|| input.get("targetId"));
            Value::Array(single.filter(|value| js::truthy(Some(value))).cloned().into_iter().collect())
        }
    };
    let target_ids = unique_strings(Some(&targets_value));
    let npcs = state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let npc_id = target_ids.iter().find(|id| sk_core::game::find_actor(&state, id).is_none() && npcs.iter().any(|npc| js::s(npc.get("id")) == **id)).cloned();
    let spell = if command_type == "CastSpell" {
        let options = crate::reactions::ruleset_options(&state);
        sk_combat_content::combat_spells::combat_spell_for(Some(hero), either(input, "spell_id", "spellId"), Some(&options))
    } else {
        None
    };
    let harmful = spell.as_ref().is_some_and(|spell| HARMFUL_SPELL_KINDS.contains(&js::string(spell.get("kind")).as_str()));
    let hostile_action = command_type == "UseCombatAction" && {
        let action = sk_combat_content::combat_actions::combat_action_for(Some(hero), either(input, "action_id", "actionId"));
        sk_combat_content::combat_actions::exploration_use_for(action.as_ref()) == "opens-combat"
    };
    if let Some(npc_id) = npc_id {
        let hostile = command_type == "MakeAttack" || harmful || hostile_action;
        return Ok(hostile.then(|| OpeningStrike { actor_id: hero_id, command_type, npc_id: Some(npc_id) }));
    }
    let enemies = state.get("enemies").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if !enemies.iter().any(sk_core::game::is_living_actor) {
        return Ok(None);
    }
    let hostile_target = target_ids.iter().any(|id| sk_core::game::is_enemy_actor(&state, id) && sk_core::game::find_actor(&state, id).is_some_and(sk_core::game::is_living_actor));
    let hostile = match command_type.as_str() {
        "MakeAttack" => hostile_target,
        "MakeAreaAttack" => true,
        "CastSpell" => spell.as_ref().is_some_and(|spell| harmful || (hostile_target && !js::is_false(spell.get("requiresCombatAgainstHostile")))),
        _ => hostile_action,
    };
    Ok(hostile.then(|| OpeningStrike { actor_id: hero_id, command_type, npc_id: None }))
}

/// `openingStrikeTurnState(started, before, heroId, turnStarted)`: ход у
/// нападающего, его состояния — те, что были до боя.
pub fn opening_strike_turn_state(started: &Value, before: &Value, hero_id: &str, turn_started: Option<&Value>) -> Result<Value, Halt> {
    let combat = sk_core::game::combat(started);
    let hero_index = combat.get("initiative").and_then(Value::as_array).and_then(|initiative| initiative.iter().position(|entry| js::string(entry.get("actor_id")) == hero_id));
    let active = combat.get("active_index");
    let mut own_turn = match (hero_index, turn_started) {
        (Some(index), Some(turn_started)) if active.and_then(Value::as_f64) != Some(index as f64) => {
            let mut payload = spread_value(turn_started.get("payload"));
            payload.insert("active_index".into(), Value::from(index as i64));
            let mut event = spread_value(Some(turn_started));
            event.insert("actor_id".into(), Value::String(hero_id.into()));
            event.insert("target_ids".into(), json!([hero_id]));
            event.insert("payload".into(), Value::Object(payload));
            apply_game_event(started, &Value::Object(event))?
        }
        _ => crate::normalize::normalize_campaign_state(started)?,
    };
    let conditions = before.get("mechanics").and_then(|mechanics| mechanics.get("conditions")).and_then(|all| all.get(hero_id)).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
    if let Some(all) = own_turn.get_mut("mechanics").and_then(|mechanics| mechanics.get_mut("conditions")).and_then(Value::as_object_mut) {
        all.insert(hero_id.into(), conditions);
    }
    Ok(own_turn)
}

/// `resolveOpeningStrike(input, rawState, opening, { diceService, context })`.
pub fn resolve_opening_strike(input: &Value, raw_state: &Value, opening: &OpeningStrike, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    let command_id = match crate::core::coalesce(&[input.get("command_id")]).or_else(|| crate::core::coalesce(&[input.get("commandId")])) {
        Some(id) => js::string(Some(id)),
        None => uuid(),
    };
    let strike = command_with(input, "command_id", Value::String(command_id.clone()));
    let state = crate::normalize::normalize_campaign_state(raw_state)?;
    let rule_id = sk_ruleset::ruleset_config::BG3_OPENING_STRIKE_HOUSE_RULE_ID;
    let free_strike = state.get("enabled_house_rules").and_then(Value::as_array).is_some_and(|rules| rules.iter().any(|rule| rule.as_str() == Some(rule_id)));
    let mut opening_action = Map::new();
    opening_action.insert("actor_id".into(), Value::String(opening.actor_id.clone()));
    opening_action.insert("command_type".into(), Value::String(opening.command_type.clone()));
    if let Some(npc_id) = &opening.npc_id {
        opening_action.insert("npc_id".into(), Value::String(npc_id.clone()));
    }
    if free_strike {
        opening_action.insert("free_strike".into(), Value::Bool(true));
        opening_action.insert("house_rule_id".into(), Value::String(rule_id.into()));
    }
    if let Some(fingerprint) = input.get("request_fingerprint").filter(|value| js::truthy(Some(value))) {
        opening_action.insert("request_fingerprint".into(), Value::String(crate::core::slice_utf16(&js::string(Some(fingerprint)), 128)));
    }
    let mut entry = Map::new();
    entry.insert("command_type".into(), Value::String(if opening.npc_id.is_some() { "AttackNpc" } else { "StartCombat" }.into()));
    entry.insert("command_id".into(), Value::String(format!("{command_id}:opening-combat")));
    entry.insert("actor_id".into(), Value::String(opening.actor_id.clone()));
    if let Some(npc_id) = &opening.npc_id {
        entry.insert("npc_id".into(), Value::String(npc_id.clone()));
    }
    entry.insert("server_authoritative".into(), Value::Bool(true));
    if let Some(expected) = input.get("expected_state_version") {
        entry.insert("expected_state_version".into(), expected.clone());
    }
    if let Some(campaign) = input.get("campaign_id").filter(|value| !value.is_null()) {
        entry.insert("campaign_id".into(), campaign.clone());
    }
    if let Some(visibility) = input.get("visibility").filter(|value| !value.is_null()) {
        entry.insert("visibility".into(), visibility.clone());
    }
    let start_context = context.with("serverAuthoritativeCombat", Value::Bool(true)).with("openingAction", Value::Object(opening_action));
    let start = resolve_internal(&Value::Object(entry), &state, dice, &start_context, &mut *uuid)?;
    let mut started = state.clone();
    for event in &start.events {
        started = apply_game_event(&started, event)?;
    }
    let combat = sk_core::game::combat(&started);
    let turn_started = start.events.iter().rev().find(|event| event.get("event_type").and_then(Value::as_str) == Some("TurnStarted"));
    let active_index = js::safe_int(combat.get("active_index"), -1);
    let first = combat.get("initiative").and_then(Value::as_array).and_then(|initiative| usize::try_from(active_index).ok().and_then(|index| initiative.get(index)));
    let hero_acts_first = js::s(first.and_then(|entry| entry.get("actor_id"))) == opening.actor_id;
    let own_turn = opening_strike_turn_state(&started, &state, &opening.actor_id, turn_started)?;
    let mut follow_up = command_with(&strike, "expected_state_version", own_turn.get("state_version").cloned().unwrap_or(Value::Null));
    if own_turn.get("state_version").is_none() {
        js::delete(&mut follow_up, "expected_state_version");
    }
    if free_strike {
        follow_up["house_rule_id"] = Value::String(rule_id.into());
    }
    if free_strike || hero_acts_first {
        let resolved = match resolve_internal(&follow_up, &own_turn, dice, context, &mut *uuid) {
            Ok(resolved) => resolved,
            Err(Halt::Pause(mut pause)) => {
                let mut prefix = start.events.clone();
                prefix.append(&mut pause.prefix_events);
                pause.prefix_events = prefix;
                let mut rolls = start.rolls.clone();
                rolls.append(&mut pause.prefix_rolls);
                pause.prefix_rolls = rolls;
                return Err(Halt::Pause(pause));
            }
            Err(other) => return Err(other),
        };
        let marked = super::round_time::with_combat_round_time_marker(resolved, &started, &Context::default());
        let mut events = start.events;
        events.extend(marked.events);
        if free_strike {
            let economy = sk_core::game::combat(&started).get("action_economy").and_then(|all| all.get(&opening.actor_id)).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
            let payload = json!({ "schema_version": 1, "house_rule_id": rule_id, "action_economy": economy });
            events.push(event_from(&marked.command, "OpeningStrikeEconomyRestored", Some(payload), Some(&json!([opening.actor_id]))));
        }
        let mut rolls = start.rolls;
        rolls.extend(marked.rolls);
        return Ok(Resolved { command: marked.command, events, rolls });
    }
    let mut dry = crate::dice_record::dry_run_dice();
    match resolve_internal(&follow_up, &own_turn, &mut dry, context, &mut *uuid) {
        Ok(_) | Err(Halt::Pause(_)) => {}
        Err(other) => return Err(other),
    }
    let command = crate::command::normalize::normalize_command(&strike, &state, &mut *uuid)?;
    Ok(Resolved { command, events: start.events, rolls: start.rolls })
}
