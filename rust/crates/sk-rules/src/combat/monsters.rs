//! Монстры и NPC в бою: магия стат-блока, легендарные действия, перезарядка, мультиатака, синхронизация хитов NPC мира. Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 5315–5420 (`monsterSpellUsesSpent`,
//! `validateMonsterSpellCommand`, `validateLegendaryActionCommand`),
//! 8601–8658 (перезарядка и сброс легендарных действий в начале хода), 10728
//! (`npcDamageContext`), 10971–10993 (последовательность мультиатаки),
//! 23572–23601 (хиты NPC мира).

use std::borrow::Cow;

use serde_json::{json, Map, Value};
use sk_combat_base::legendary_actions::{legendary_action_for, legendary_cooldown_marker, legendary_profile_for, legendary_uses_spent, legendary_window_key, legendary_window_spent, LEGENDARY_ACTION_CONDITION_PREFIX};
use sk_combat_base::monster_actions::{monster_action_usage_key, monster_multiattack_sequence_for};
use sk_core::indexmap::IndexMap;
use sk_core::{game, js, text};

use crate::combat::weapons::{array_of, recharge_minimum_of};
use crate::command::rules::rule_ids;
use crate::conditions::at;
use crate::context::Context;
use crate::core::{command_with, command_with_rules, condition_ids_for, event_from, incapacitating_condition_for, monster_trait_for, slice_utf16, spread_value, string_of};
use crate::dice_record::RulesDice;
use crate::pause::{rule, Fault, Halt};

/// `monsterSpellUsesSpent(state, actorId, spellId)`: сколько раз существо уже
/// произносило заклинание с лимитом «X в день».
pub fn monster_spell_uses_spent(state: &Value, actor_id: &str, spell_id: &str) -> usize {
    sk_combat_content::combat_spells::monster_spell_uses_spent_in(condition_ids_for(state, actor_id), spell_id)
}

/// `validateMonsterSpellCommand(command, state, context)` (5328–5348): магия
/// стат-блока — только руками планировщика; итог — `{ monster_spell_use }`.
pub fn validate_monster_spell_command(command: &Value, state: &Value, context: &Context) -> Result<Value, Halt> {
    if !context.is_true("isNpcScheduler") {
        return Err(rule("Заклинаниями существа распоряжается только серверный планировщик ходов", "NPC_SPELL_CAST_FORBIDDEN"));
    }
    let actor = game::find_actor(state, &js::s(command.get("actor_id")));
    if let Some((message, code)) = sk_combat_content::combat_spells::monster_spell_refusal_for(actor, command.get("spell_id")) {
        return Err(rule(message, code));
    }
    let options = json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) });
    let spell = sk_combat_content::combat_spells::monster_combat_spell_for(actor, command.get("spell_id"), Some(&options));
    let per_day = spell.as_ref().and_then(|spell| spell.get("monsterSpell")).and_then(|block| block.get("perDay")).filter(|value| !value.is_null());
    if let Some(per_day) = per_day {
        let spell_id = js::string(spell.as_ref().and_then(|spell| spell.get("id")));
        let spent = monster_spell_uses_spent(state, &js::string(command.get("actor_id")), &spell_id) as f64;
        let limit = js::number(Some(per_day));
        if spent >= limit {
            return Err(rule("Это заклинание существо на сегодня исчерпало", "MONSTER_SPELL_USES_SPENT"));
        }
        let id = spell.as_ref().and_then(|spell| spell.get("id")).cloned().unwrap_or(Value::Null);
        return Ok(json!({ "monster_spell_use": { "spell_id": id, "ordinal": js::num(spent + 1.0), "per_day": per_day, "remaining_after": js::num(limit - spent - 1.0) } }));
    }
    Ok(json!({ "monster_spell_use": null }))
}

/// `validateLegendaryActionCommand(command, state, context)` (5362–5419):
/// легендарное действие вне своего хода и только руками планировщика.
pub fn validate_legendary_action_command(command: &Value, state: &Value, context: &Context) -> Result<Value, Halt> {
    if !context.is_true("isNpcScheduler") {
        return Err(rule("Легендарными действиями распоряжается только серверный планировщик ходов", "LEGENDARY_ACTION_FORBIDDEN"));
    }
    let actor_id = js::s(command.get("actor_id"));
    let Some(actor) = game::find_actor(state, &actor_id) else {
        return Err(rule("Существо не найдено", "ACTOR_NOT_FOUND"));
    };
    if !game::is_living_actor(actor) {
        return Err(rule("Побеждённое существо не совершает легендарных действий", "ACTOR_DEFEATED"));
    }
    let Some(profile) = legendary_profile_for(Some(actor)) else {
        return Err(rule("У существа нет легендарных действий", "LEGENDARY_ACTIONS_ABSENT"));
    };
    let combat = game::combat(state);
    if !js::truthy(combat.get("active")) {
        return Err(rule("Легендарные действия совершаются только в бою", "COMBAT_NOT_ACTIVE"));
    }
    let key = js::string(command.get("actor_id"));
    if incapacitating_condition_for(state, &key).is_some() {
        return Err(rule("Существо не в состоянии совершить легендарное действие", "ACTOR_INCAPACITATED"));
    }
    let index = js::safe_int(combat.get("active_index"), -1);
    let current = if index >= 0 { combat.get("initiative").and_then(Value::as_array).and_then(|order| order.get(index as usize)) } else { None };
    if js::s(at(current, "actor_id")) == key {
        return Err(rule("Легендарное действие совершается вне своего хода", "LEGENDARY_ACTION_OWN_TURN"));
    }
    let Some(action) = legendary_action_for(Some(actor), command.get("legendary_action_id")) else {
        return Err(rule("Такого легендарного действия нет в стат-блоке", "LEGENDARY_ACTION_UNKNOWN"));
    };
    let conditions = condition_ids_for(state, &key);
    let window_key = legendary_window_key(Some(combat));
    if legendary_window_spent(conditions.iter(), &window_key) {
        return Err(rule("Легендарное действие в этом ходу уже совершено", "LEGENDARY_ACTION_WINDOW_SPENT"));
    }
    if action.cooldown_turns > 0 && conditions.contains(&legendary_cooldown_marker(&action.id)) {
        return Err(rule("Это легендарное действие ещё не восстановилось", "LEGENDARY_ACTION_COOLDOWN"));
    }
    let spent = legendary_uses_spent(conditions.iter()) as i64;
    if spent + action.cost > profile.uses {
        return Err(rule("Запас легендарных действий исчерпан до начала следующего хода существа", "LEGENDARY_ACTIONS_SPENT"));
    }
    let target_id = js::s(command.get("target_id"));
    let target = game::find_actor(state, &target_id);
    if !target.is_some_and(game::is_living_actor) {
        return Err(rule("Нужна живая цель легендарного действия", "INVALID_TARGET"));
    }
    if game::is_enemy_actor(state, &target_id) == game::is_enemy_actor(state, &actor_id) {
        return Err(rule("Легендарное действие направлено против противника", "INVALID_TARGET"));
    }
    let distance = crate::targets::distance_between_actors(state, &actor_id, &target_id);
    let reach = if action.radius_feet > 0 { action.radius_feet } else { action.range_feet } as f64;
    if distance.is_none_or(|distance| distance > reach) {
        return Err(rule("Цель находится вне досягаемости легендарного действия", "TARGET_OUT_OF_RANGE"));
    }
    Ok(json!({
        "target_ids": [target_id],
        "legendary_action": {
            "id": action.id,
            "name": action.name,
            "cost": action.cost,
            "kind": action.kind,
            "uses_before": spent,
            "uses_after": spent + action.cost,
            "uses_max": profile.uses,
            "window_key": window_key,
        },
    }))
}

/// События и броски хода существа.
#[derive(Debug, Clone, Default)]
pub struct TurnStartRolls {
    pub events: Vec<Value>,
    pub rolls: Vec<Value>,
}

/// `monsterRechargeAtTurnStart(state, command, actorId, diceService)`
/// (8623–8651): приёмы «Перезарядка X–6» в начале хода существа.
pub fn monster_recharge_at_turn_start(state: &Value, command: &Value, actor_id: Option<&Value>, dice: &mut dyn RulesDice) -> Result<TurnStartRolls, Halt> {
    let id = js::s(actor_id);
    let mut result = TurnStartRolls::default();
    let Some(actor) = game::find_actor(state, &id) else { return Ok(result) };
    if !game::is_enemy_actor(state, &id) || !game::is_living_actor(actor) {
        return Ok(result);
    }
    let spent = condition_ids_for(state, &id);
    let mut recharge_command = command_with(command, "actor_id", Value::String(id.clone()));
    recharge_command["visibility"] = Value::String("gm_only".into());
    let mut checked: Vec<String> = Vec::new();
    let actions: Vec<&Value> = array_of(actor.get("action_profiles")).iter().chain(array_of(actor.get("special_actions"))).collect();
    let targets = json!([id]);
    for action in actions {
        let minimum = recharge_minimum_of(Some(action));
        let action_id = js::s(at(Some(action), "id"));
        let usage_key = monster_action_usage_key(Some(action));
        let condition = format!("monster-action-used:{usage_key}");
        if action_id.is_empty() || minimum <= 0 || !spent.contains(&condition) || checked.contains(&usage_key) {
            continue;
        }
        checked.push(usage_key);
        let roll = dice.roll(&[json!("1d6"), Value::String(format!("monster_recharge:{action_id}")), Value::String(id.clone()), json!("gm_only")])?;
        result.rolls.push(roll.clone());
        let mut payload = spread_value(Some(&roll));
        payload.insert("recharge_action_id".into(), Value::String(action_id.clone()));
        result.events.push(event_from(&recharge_command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        if js::number(roll.get("total")) < minimum as f64 {
            continue;
        }
        result.events.push(event_from(&command_with_rules(&recharge_command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": condition, "trigger": "recharge" })), Some(&targets)));
        let name_source = at(Some(action), "name").filter(|value| !value.is_null()).or_else(|| at(Some(action), "name_ru").filter(|value| !value.is_null()));
        let name = slice_utf16(&name_source.map(string_of).unwrap_or_else(|| action_id.clone()), 120);
        result.events.push(event_from(
            &command_with_rules(&recharge_command, &[rule_ids::TURNS]),
            "MonsterAbilityRecharged",
            Some(json!({ "action_id": action_id, "name": name, "recharge_minimum": minimum })),
            Some(&targets),
        ));
    }
    Ok(result)
}

/// `legendaryActionsResetAtTurnStart(state, command, actorId)` (8665–8680):
/// запас легендарных действий возвращается в начале хода существа.
pub fn legendary_actions_reset_at_turn_start(state: &Value, command: &Value, actor_id: Option<&Value>) -> Vec<Value> {
    let id = js::s(actor_id);
    let actor = game::find_actor(state, &id);
    let Some(profile) = legendary_profile_for(actor) else { return Vec::new() };
    if !game::is_enemy_actor(state, &id) {
        return Vec::new();
    }
    let spent: Vec<String> = condition_ids_for(state, &id).into_iter().filter(|condition| condition.starts_with(LEGENDARY_ACTION_CONDITION_PREFIX)).collect();
    if spent.is_empty() {
        return Vec::new();
    }
    let with_actor = command_with(command, "actor_id", Value::String(id.clone()));
    let mut reset_command = with_actor.clone();
    reset_command["visibility"] = Value::String("gm_only".into());
    let targets = json!([id]);
    let condition_command = command_with_rules(&reset_command, &[rule_ids::CONDITIONS]);
    let mut events: Vec<Value> = spent
        .iter()
        .map(|condition| event_from(&condition_command, "ConditionRemoved", Some(json!({ "condition": condition, "trigger": "legendary-reset" })), Some(&targets)))
        .collect();
    events.push(event_from(&command_with_rules(&with_actor, &[rule_ids::TURNS]), "LegendaryActionsReset", Some(json!({ "uses": profile.uses, "restored": spent.len() })), Some(&targets)));
    events
}

/// `npcDamageContext(state, npcId)` (10750–10759): социальный NPC получает
/// урон своей боевой формой; без неё — то же состояние.
pub fn npc_damage_context<'a>(state: &'a Value, npc_id: &str) -> Cow<'a, Value> {
    if game::find_actor(state, npc_id).is_some() {
        return Cow::Borrowed(state);
    }
    let Some(actor) = crate::tactical_geometry::npc_positioning::npc_combat_actor_for(state, npc_id) else { return Cow::Borrowed(state) };
    let position = crate::tactical_geometry::npc_positioning::npc_placement_for(state, npc_id, None);
    let mut next = spread_value(Some(state));
    let mut actors: Vec<Value> = array_of(state.get("actors")).to_vec();
    actors.push(actor);
    next.insert("actors".into(), Value::Array(actors));
    let mechanics = state.get("mechanics");
    let mut mechanics_next = spread_value(mechanics);
    let mut positions = spread_value(mechanics.and_then(|mechanics| mechanics.get("positions")));
    if let Some(position) = position.filter(|value| js::truthy(Some(value))) {
        positions.insert(npc_id.to_string(), position);
    }
    mechanics_next.insert("positions".into(), Value::Object(positions));
    next.insert("mechanics".into(), Value::Object(mechanics_next));
    Cow::Owned(Value::Object(next))
}

/// `monsterMultiattackActionCounts(multiattack)` (10993–10999): счётчики
/// действий мультиатаки, по id в порядке `localeCompare`.
pub fn monster_multiattack_action_counts(multiattack: Option<&Value>) -> IndexMap<String, i64> {
    let Some(Value::Object(counts)) = at(multiattack, "action_counts").filter(|value| js::truthy(Some(value))) else { return IndexMap::new() };
    let mut entries: Vec<(String, i64)> = js::entries(counts)
        .into_iter()
        .map(|(id, count)| (id.clone(), js::safe_int(Some(count), 0).clamp(0, 8)))
        .filter(|(id, count)| !id.is_empty() && *count > 0)
        .collect();
    entries.sort_by(|(left, _), (right, _)| text::locale_compare(left, right));
    entries.into_iter().collect()
}

/// `monsterMultiattackActionIds(actor, fallbackActionId, usedActionIds)`
/// (11001–11015): какие действия и в каком порядке объявляет мультиатака.
pub fn monster_multiattack_action_ids(actor: Option<&Value>, fallback_action_id: Option<&Value>, used_action_ids: Option<&Value>) -> Result<Vec<String>, Halt> {
    let Some(multiattack) = monster_trait_for(actor, "multiattack") else { return Ok(Vec::new()) };
    let action_counts = monster_multiattack_action_counts(Some(multiattack));
    if !action_counts.is_empty() {
        let mut ids = Vec::new();
        for (id, count) in &action_counts {
            for _ in 0..*count {
                ids.push(id.clone());
            }
        }
        ids.truncate(8);
        return Ok(ids);
    }
    let used: Vec<String> = match used_action_ids {
        None => Vec::new(),
        Some(Value::Array(ids)) => ids.iter().map(|id| js::string(Some(id))).collect(),
        Some(_) => return Err(Fault::type_error("usedActionIds.every is not a function").into()),
    };
    if let Some(chosen) = monster_multiattack_sequence_for(actor, &js::string(fallback_action_id.or(Some(&Value::Null))), &used) {
        return Ok(chosen);
    }
    let sequence: Vec<String> = match multiattack.get("sequence") {
        Some(Value::Array(ids)) => ids.iter().map(string_of).filter(|id| !id.is_empty()).collect(),
        _ => Vec::new(),
    };
    if !sequence.is_empty() {
        return Ok(sequence.into_iter().take(8).collect());
    }
    let count = js::safe_int(multiattack.get("attacks"), 1).clamp(1, 8);
    let action_id = js::s(crate::core::coalesce(&[multiattack.get("action_id"), fallback_action_id]));
    if action_id.is_empty() {
        return Ok(Vec::new());
    }
    Ok((0..count).map(|_| action_id.clone()).collect())
}

/// Запасная живучесть `syncNpcWorldVital`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VitalFallback {
    pub hp: i64,
    pub max_hp: i64,
    pub alive: bool,
}

/// `syncNpcWorldVital(state, npcId, { hp, maxHp, fallback })` (23594–23603):
/// живучесть именного NPC в `state.npc_world.vitals`.
pub fn sync_npc_world_vital(state: &mut Value, npc_id: &str, hp: Option<&Value>, max_hp: Option<&Value>, fallback: Option<Value>) {
    if npc_id.is_empty() {
        return;
    }
    let options = Value::Object(Map::new());
    let mut world = sk_npc_world::npc_positioning::normalize_npc_world_state(state.get("npc_world"), &options);
    let before = world.get("vitals").and_then(|vitals| vitals.get(npc_id)).filter(|value| !value.is_null()).cloned().or(fallback).unwrap_or_else(|| json!({ "hp": 0, "max_hp": 1, "alive": false }));
    let pick = |value: Option<&Value>, fallback: Option<&Value>| if js::is_safe_integer_number(value) { js::number(value) } else { js::number(fallback) };
    let maximum = js_max(1.0, pick(max_hp, before.get("max_hp")));
    let current = js_min(maximum, js_max(0.0, pick(hp, before.get("hp"))));
    if let Some(vitals) = world.get_mut("vitals").and_then(Value::as_object_mut) {
        vitals.insert(npc_id.to_string(), json!({ "hp": js::num(current), "max_hp": js::num(maximum), "alive": current > 0.0 }));
    }
    let normalized = sk_npc_world::npc_positioning::normalize_npc_world_state(Some(&world), &options);
    if let Some(map) = state.as_object_mut() {
        map.insert("npc_world".into(), normalized);
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `syncAuthoredNpcVital(state, targetId, { hp, maxHp })` (23605–23613):
/// противник, порождённый именным NPC.
pub fn sync_authored_npc_vital(state: &mut Value, target_id: &str, hp: Option<&Value>, max_hp: Option<&Value>) {
    let Some(enemy) = array_of(state.get("enemies")).iter().find(|candidate| game::actor_id(candidate) == target_id).cloned() else { return };
    let npc_id = js::s(at(at(Some(&enemy), "origin"), "npc_id"));
    if npc_id.is_empty() {
        return;
    }
    let fallback = json!({ "hp": game::actor_hp(&enemy), "max_hp": game::actor_max_hp(&enemy), "alive": game::is_living_actor(&enemy) });
    sync_npc_world_vital(state, &npc_id, hp, max_hp, Some(fallback));
}

/// `syncSocialNpcVital(state, targetId, { hp, maxHp, npcId })` (23616–23623):
/// старый `HealingApplied` не трогает живучесть обычного социального NPC.
pub fn sync_social_npc_vital(state: &mut Value, target_id: &str, hp: Option<&Value>, max_hp: Option<&Value>, npc_id: Option<&Value>) {
    if js::s(npc_id) != target_id {
        return;
    }
    let known = array_of(at(state.get("social"), "npcs")).iter().any(|npc| js::s(at(Some(npc), "id")) == target_id);
    if target_id.is_empty() || !known {
        return;
    }
    let before = sk_npc_world::npc_positioning::npc_vital_for(state, &Value::String(target_id.to_string()));
    if js::is_false(before.get("alive")) || js::number(before.get("hp")) <= 0.0 {
        return;
    }
    sync_npc_world_vital(state, target_id, hp, max_hp, Some(before));
}
