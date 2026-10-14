//! Состояния, концентрация, призванные существа и смена облика.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, combat_actor_kind, condition_id, conditions_mut, is_hostile_summon, is_party_summon, mechanics, mechanics_mut, replace_actor};
use sk_core::js::{is_true, present, s, safe_int, truthy};
use sk_core::Event;

use super::{scene_turn_and_round, target_of};
use crate::journal::{append_battle_log, recent_battle_spell_name, Entry};

const SUMMON_LIFECYCLE_VERSION: i64 = 2;
const SOURCE_SCOPED_BOOLEAN_CONDITIONS: [&str; 16] = [
    "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "banished", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "surprised", "unconscious",
];
const ENEMY_KNOWLEDGE_FACTS: [&str; 4] = ["health", "armor_class", "speed", "stat_block"];

/// `hasSummonLifecycleVersion(payload)`.
pub(crate) fn summon_cleanup(value: &Value) -> bool {
    let raw = value.get("summon_lifecycle_version").filter(|v| !v.is_null()).or_else(|| value.get("summonLifecycleVersion"));
    raw.and_then(Value::as_f64) == Some(SUMMON_LIFECYCLE_VERSION as f64) || raw.and_then(Value::as_str).and_then(|text| text.trim().parse::<f64>().ok()) == Some(SUMMON_LIFECYCLE_VERSION as f64)
}

fn condition_uses_effect_identity(condition: &str, payload: &Value) -> bool {
    if !present(payload.get("effect_id")) {
        return false;
    }
    condition == "longstrider"
        || condition.starts_with("protected-from-energy:")
        || SOURCE_SCOPED_BOOLEAN_CONDITIONS.contains(&condition)
        || present(payload.get("repeat_save_timing"))
        || is_true(payload.get("repeat_save_on_damage"))
        || present(payload.get("escape_check_ability"))
        || present(payload.get("start_turn_save"))
        || (s(payload.get("spell_id")) == "vitriolic-sphere" && s(payload.get("recurring_damage_timing")) == "turn-end")
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// Секунды с точностью до тысячной, как `Math.round(x * 1000) / 1000`.
fn seconds(value: Option<&Value>) -> Value {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    let number = if number.is_finite() { number } else { 0.0 };
    let rounded = ((number * 1000.0).round() / 1000.0).max(0.0);
    if rounded.fract() == 0.0 { Value::from(rounded as i64) } else { json!(rounded) }
}

pub fn condition_added(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = event.payload.clone();
    let condition = s(payload.get("condition"));
    let duration = or_null(payload.get("duration"));
    let source_actor = payload.get("source_actor").filter(|v| !v.is_null()).cloned().or_else(|| event.actor_id.clone().map(Value::String)).unwrap_or(Value::Null);
    let duration_text = s(Some(&duration));
    let source_scoped = duration_text == "until-source-next-turn" || (duration_text.starts_with("source-turns:") && duration_text["source-turns:".len()..].chars().all(|c| c.is_ascii_digit()) && duration_text.len() > "source-turns:".len());
    let effect_scoped = condition_uses_effect_identity(&condition, &payload);
    let incoming_effect = present(payload.get("effect_id")).then(|| s(payload.get("effect_id")));

    let mut canonical = Map::new();
    let mut put = |key: &str, value: Value| {
        canonical.insert(key.to_string(), value);
    };
    put("id", Value::String(condition.clone()));
    put("duration", duration.clone());
    put("source_actor", source_actor.clone());
    if present(payload.get("source_item_id")) {
        put("source_item_id", Value::String(s(payload.get("source_item_id"))));
    }
    if present(payload.get("spellcasting_ability")) {
        put("spellcasting_ability", Value::String(s(payload.get("spellcasting_ability"))));
    }
    if is_true(payload.get("magical_weapon")) {
        put("magical_weapon", Value::Bool(true));
    }
    if present(payload.get("save_condition")) {
        put("save_condition", Value::String(s(payload.get("save_condition"))));
    }
    if present(payload.get("started_at_minutes")) {
        put("started_at_minutes", Value::from(safe_int(payload.get("started_at_minutes"), 0).max(0)));
    }
    if present(payload.get("expires_at_minutes")) {
        put("expires_at_minutes", Value::from(safe_int(payload.get("expires_at_minutes"), 0).max(0)));
    }
    if payload.get("timing_version").and_then(Value::as_f64) == Some(2.0) {
        put("timing_version", Value::from(2));
        put("started_at_seconds", seconds(payload.get("started_at_seconds")));
        put("expires_at_seconds", seconds(payload.get("expires_at_seconds")));
    }
    if present(payload.get("expiry_policy")) {
        put("expiry_policy", Value::String(s(payload.get("expiry_policy"))));
    }
    put("effect_id", or_null(payload.get("effect_id")));
    put("repeat_save_timing", or_null(payload.get("repeat_save_timing")));
    if payload.get("repeat_save_ends_concentration") == Some(&Value::Bool(false)) {
        put("repeat_save_ends_concentration", Value::Bool(false));
    }
    put("repeat_save_on_damage", Value::Bool(is_true(payload.get("repeat_save_on_damage"))));
    put("damage_save_advantage", Value::Bool(is_true(payload.get("damage_save_advantage"))));
    put("break_on_damage_from_source_allies", Value::Bool(is_true(payload.get("break_on_damage_from_source_allies"))));
    if is_true(payload.get("break_on_any_damage")) {
        put("break_on_any_damage", Value::Bool(true));
    }
    put("save_ability", or_null(payload.get("save_ability")));
    put("save_dc", or_null(payload.get("save_dc")));
    if present(payload.get("escape_dc")) {
        put("escape_dc", Value::from(safe_int(payload.get("escape_dc"), 10).max(1)));
    }
    if is_true(payload.get("no_escape")) {
        put("no_escape", Value::Bool(true));
    }
    if present(payload.get("action_save_ability")) {
        put("action_save_ability", Value::String(s(payload.get("action_save_ability"))));
    }
    if safe_int(payload.get("repeat_save_tally"), 0) > 0 {
        put("repeat_save_tally", Value::from(safe_int(payload.get("repeat_save_tally"), 0)));
        put("tally_successes", Value::from(safe_int(payload.get("tally_successes"), 0).max(0)));
        put("tally_failures", Value::from(safe_int(payload.get("tally_failures"), 0).max(0)));
        if truthy(payload.get("tally_failure_condition")) {
            put("tally_failure_condition", Value::String(s(payload.get("tally_failure_condition"))));
        }
    }
    put("spell_id", or_null(payload.get("spell_id")));
    if payload.get("true_strike_version").and_then(Value::as_f64) == Some(1.0) {
        put("true_strike_version", Value::from(1));
        put("target_actor_id", Value::String(s(payload.get("target_actor_id"))));
        put("true_strike_armed", Value::Bool(is_true(payload.get("true_strike_armed"))));
    }
    put("spell_option", or_null(payload.get("spell_option")));
    if payload.get("skill_buff_version").and_then(Value::as_f64) == Some(1.0) {
        put("skill_buff_version", Value::from(1));
    }
    put("slot_level", or_null(payload.get("slot_level")));
    if payload.as_object().is_some_and(|map| map.contains_key("continuation_version")) {
        put("continuation_version", Value::from(safe_int(payload.get("continuation_version"), 0).max(0)));
        if present(payload.get("continuation_damage")) {
            put("continuation_damage", Value::String(s(payload.get("continuation_damage"))));
        }
        if present(payload.get("continuation_damage_type")) {
            put("continuation_damage_type", Value::String(s(payload.get("continuation_damage_type"))));
        }
        if present(payload.get("continuation_range")) {
            put("continuation_range", Value::from(safe_int(payload.get("continuation_range"), 0).max(0)));
        }
        if present(payload.get("continuation_upcast_dice_per_level")) {
            put("continuation_upcast_dice_per_level", Value::from(safe_int(payload.get("continuation_upcast_dice_per_level"), 0).max(0)));
        }
        if present(payload.get("continuation_duration_seconds")) {
            put("continuation_duration_seconds", Value::from(safe_int(payload.get("continuation_duration_seconds"), 60).max(1)));
        }
    }
    put("start_turn_save", or_null(payload.get("start_turn_save")));
    put("recurring_damage", or_null(payload.get("recurring_damage")));
    put("recurring_damage_type", or_null(payload.get("recurring_damage_type")));
    if truthy(payload.get("recurring_damage_timing")) {
        put("recurring_damage_timing", payload["recurring_damage_timing"].clone());
    }
    if present(payload.get("recurring_skip_turn_key")) {
        put("recurring_skip_turn_key", Value::String(s(payload.get("recurring_skip_turn_key"))));
    }
    put("rider_damage", or_null(payload.get("rider_damage")));
    put("rider_damage_type", or_null(payload.get("rider_damage_type")));
    put("rider_source_name", or_null(payload.get("rider_source_name")));
    put("absorb_elements_rider_armed", Value::Bool(is_true(payload.get("absorb_elements_rider_armed"))));
    put("fire_damage_bonus", or_null(payload.get("fire_damage_bonus")));
    put("escape_check_ability", or_null(payload.get("escape_check_ability")));
    put("temporary_hp_amount", or_null(payload.get("temporary_hp_amount")));
    put("check_total", or_null(payload.get("check_total")));
    put("recurring_once", Value::Bool(is_true(payload.get("recurring_once"))));
    put("source_rule_ids", Value::Array(event.source_rule_ids.iter().map(|id| Value::String(id.clone())).collect()));

    let source_text = s(Some(&source_actor));
    let list = conditions_mut(state, &target);
    let existing = list.iter().position(|item| {
        s(item.get("id")) == condition
            && match (&incoming_effect, effect_scoped) {
                (Some(effect), true) => s(item.get("effect_id")) == *effect,
                _ => !source_scoped || s(item.get("source_actor")) == source_text,
            }
    });
    match existing {
        None => list.push(Value::Object(canonical)),
        Some(index) => {
            list[index] = Value::Object(canonical);
            if let (true, Some(effect)) = (effect_scoped, &incoming_effect) {
                let mut position = 0usize;
                list.retain(|item| {
                    let keep = position == index || s(item.get("id")) != condition || s(item.get("effect_id")) != *effect;
                    position += 1;
                    keep
                });
            }
        }
    }
    let window = sk_core::game::combat(state).get("reaction_window").cloned().unwrap_or(Value::Null);
    let pending_flee = condition == "fled" && s(window.get("trigger")) == "enemy-left-reach" && s(window.get("source_actor_id")) == target;
    if (condition == "fled" && !pending_flee) || condition == "surrendered" {
        replace_actor(state, &target, |actor| {
            actor["alive"] = Value::Bool(false);
        });
    }
    if condition == "no-reactions" && sk_core::game::combat_active(state) {
        let economy = crate::economy::economy_of(state, &target);
        crate::economy::set_economy(state, &target, crate::economy::with(&economy, json!({ "reaction": false })));
    }
}

pub fn condition_removed(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let condition = s(event.payload.get("condition"));
    let effect = present(event.payload.get("effect_id")).then(|| s(event.payload.get("effect_id")));
    conditions_mut(state, &target).retain(|item| s(item.get("id")) != condition || effect.as_ref().is_some_and(|effect| s(item.get("effect_id")) != *effect));
}

pub fn spell_saving_throw_resolved(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = &event.payload;
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor = event.actor_id.clone().unwrap_or_default();
    let mut entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "spell-save")
        .opt("actorId", event.actor_id.clone())
        .set("actorKind", combat_actor_kind(state, &actor))
        .set("targetId", target)
        .text_if("spellId", payload.get("spell_id"))
        .opt("spellName", recent_battle_spell_name(state, payload.get("spell_id")))
        .text_if("ability", payload.get("ability"))
        .set(
            "roll",
            json!({
                "die": safe_int(payload.get("kept"), 0), "modifier": safe_int(payload.get("modifier"), 0),
                "total": safe_int(payload.get("total"), 0), "difficulty": safe_int(payload.get("difficulty"), 10),
                "hit": is_true(payload.get("saved")),
            }),
        )
        .set("result", if is_true(payload.get("saved")) { "success" } else { "failure" })
        .set("automaticSuccess", is_true(payload.get("automatic_success")))
        .set("immunity", if truthy(payload.get("immunity")) { Value::String(s(payload.get("immunity"))) } else { Value::Null });
    if truthy(payload.get("item_saving_throw_bonus")) {
        entry = entry.set("itemSavingThrowBonus", safe_int(payload.get("item_saving_throw_bonus"), 1).max(1));
    }
    let entry = entry.build();
    append_battle_log(state, event, entry);
}

pub fn concentration_saving_throw_resolved(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = &event.payload;
    let mut entry = Entry::new()
        .set("type", "concentration-save")
        .set("actorId", target)
        .set(
            "roll",
            json!({
                "die": safe_int(payload.get("kept"), 0), "modifier": safe_int(payload.get("modifier"), 0),
                "total": safe_int(payload.get("total"), 0), "difficulty": safe_int(payload.get("difficulty"), 10),
                "hit": is_true(payload.get("saved")),
            }),
        )
        .set("result", if is_true(payload.get("saved")) { "success" } else { "failure" });
    if truthy(payload.get("item_saving_throw_bonus")) {
        entry = entry.set("itemSavingThrowBonus", safe_int(payload.get("item_saving_throw_bonus"), 1).max(1));
    }
    if truthy(payload.get("aura_of_protection_source")) {
        entry = entry.set("auraSourceId", s(payload.get("aura_of_protection_source"))).set("auraBonus", safe_int(payload.get("aura_of_protection_bonus"), 1).max(1));
    }
    if truthy(payload.get("indomitable_bonus")) {
        entry = entry.set("indomitableBonus", safe_int(payload.get("indomitable_bonus"), 1).max(1)).set("indomitableOriginalTotal", safe_int(payload.get("indomitable_original_total"), 0));
    }
    let entry = entry.build();
    append_battle_log(state, event, entry);
}

pub fn concentration_started(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let rules = Value::Array(event.source_rule_ids.iter().map(|id| Value::String(id.clone())).collect());
    let effect = or_null(event.payload.get("effect_id"));
    let mechanics = mechanics_mut(state);
    let concentration = mechanics.entry("concentration").or_insert_with(sk_core::js::obj);
    concentration[target.as_str()] = json!({ "effect_id": effect, "source_rule_ids": rules });
}

pub fn concentration_ended(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let effect = clear_concentration_effect(state, &target, event.payload.get("effect_id"), summon_cleanup(&event.payload));
    let reason = event.payload.get("reason").filter(|v| !v.is_null()).map(|v| s(Some(v))).unwrap_or_else(|| "ended".into());
    let entry = Entry::new().set("type", "concentration-end").set("actorId", target).set("reason", reason).opt("spellId", effect).build();
    append_battle_log(state, event, entry);
}

pub fn enemy_knowledge_revealed(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let enemy_id = present(event.payload.get("enemy_id")).then(|| s(event.payload.get("enemy_id"))).unwrap_or(target);
    if enemy_id.is_empty() {
        return;
    }
    let facts = event.payload.get("facts").cloned().unwrap_or(Value::Null);
    let known: Vec<&str> = ENEMY_KNOWLEDGE_FACTS.iter().copied().filter(|fact| matches!(facts.get(*fact), Some(Value::String(text)) if text == "exact") || facts.get(*fact) == Some(&Value::Bool(true))).collect();
    if known.is_empty() {
        return;
    }
    let mechanics = mechanics_mut(state);
    let knowledge = mechanics.entry("enemy_knowledge").or_insert_with(sk_core::js::obj);
    let party = sk_core::js::object_mut(knowledge, "party");
    let record = party.entry(enemy_id).or_insert_with(sk_core::js::obj);
    if !record.is_object() {
        *record = sk_core::js::obj();
    }
    for fact in known {
        record[fact] = Value::String("exact".into());
    }
}

/// `partySummonsForExpiry(state)`: призывы отряда, враждебные призывы и
/// припрятанные на других этажах.
fn party_summons_for_expiry(state: &Value) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    let active = state.get("actors").and_then(Value::as_array).into_iter().flatten().filter(|actor| is_party_summon(actor)).chain(state.get("enemies").and_then(Value::as_array).into_iter().flatten().filter(|actor| is_hostile_summon(actor)));
    let stashed = state.get("levelEntities").and_then(Value::as_object).into_iter().flat_map(|stashes| stashes.values()).flat_map(|stash| stash.get("summons").and_then(Value::as_array).into_iter().flatten());
    for summon in active.chain(stashed) {
        let id = actor_id(summon);
        if !id.is_empty() && seen.insert(id) {
            result.push(summon.clone());
        }
    }
    result
}

fn source_effect_id(summon: &Value) -> String {
    let primary = summon.get("sourceEffectId").filter(|v| !v.is_null()).or_else(|| summon.get("source_effect_id"));
    s(primary)
}

/// Ссылается ли значение на существо `expected` по одному из «ссылочных» ключей.
fn references(value: &Value, key: &str, expected: &str) -> bool {
    match value {
        Value::Null => false,
        Value::Array(items) => items.iter().any(|item| references(item, key, expected)),
        Value::Object(map) => map.iter().any(|(entry_key, entry_value)| references(entry_value, entry_key, expected)),
        other => matches!(key, "actor_id" | "actorId" | "source_actor" | "source_actor_id" | "target_id" | "targetId" | "target_ids" | "summon_id" | "summonId") && s(Some(other)) == expected,
    }
}

/// `removeSummonedActor(state, id, { cleanupMode })`.
pub(crate) fn remove_summoned_actor(state: &mut Value, id: &str, cleanup: bool) {
    let summons = party_summons_for_expiry(state);
    let summon = summons.iter().find(|candidate| actor_id(candidate) == id).cloned();
    let source_effect = summon.as_ref().map(source_effect_id).unwrap_or_default();
    let shared_alive = !source_effect.is_empty() && summons.iter().any(|candidate| actor_id(candidate) != id && source_effect_id(candidate) == source_effect);
    {
        let combat = sk_core::game::combat_mut(state);
        let removed_index = combat.get("initiative").and_then(Value::as_array).and_then(|list| list.iter().position(|entry| s(entry.get("actor_id")) == id));
        if let Some(index) = removed_index {
            if let Some(list) = combat.get_mut("initiative").and_then(Value::as_array_mut) {
                list.remove(index);
            }
            let length = combat.get("initiative").and_then(Value::as_array).map(Vec::len).unwrap_or(0) as i64;
            let mut active = safe_int(combat.get("active_index"), 0);
            if (index as i64) < active {
                active -= 1;
            }
            if active >= length {
                active = if length > 0 { length - 1 } else { -1 };
            }
            combat["active_index"] = Value::from(active);
        }
    }
    if let Some(actors) = state.get_mut("actors").and_then(Value::as_array_mut) {
        actors.retain(|actor| actor_id(actor) != id);
    }
    let hostile_here = state.get("enemies").and_then(Value::as_array).is_some_and(|enemies| enemies.iter().any(|enemy| actor_id(enemy) == id && is_hostile_summon(enemy)));
    if hostile_here {
        if let Some(enemies) = state.get_mut("enemies").and_then(Value::as_array_mut) {
            enemies.retain(|enemy| actor_id(enemy) != id);
        }
    }
    if let Some(positions) = mechanics_mut(state).get_mut("positions").and_then(Value::as_object_mut) {
        positions.shift_remove(id);
    }
    if let Some(economy) = sk_core::game::combat_mut(state).get_mut("action_economy").and_then(Value::as_object_mut) {
        economy.shift_remove(id);
    }
    if !cleanup {
        return;
    }
    if let Some(stashes) = state.get_mut("levelEntities").and_then(Value::as_object_mut) {
        for stash in stashes.values_mut() {
            if !stash.is_object() {
                continue;
            }
            if let Some(list) = stash.get_mut("summons").and_then(Value::as_array_mut) {
                list.retain(|actor| actor_id(actor) != id);
            }
            if let Some(positions) = stash.get_mut("positions").and_then(Value::as_object_mut) {
                positions.shift_remove(id);
            }
        }
    }
    let mechanics = mechanics_mut(state);
    if let Some(all) = mechanics.get_mut("conditions").and_then(Value::as_object_mut) {
        all.shift_remove(id);
        for list in all.values_mut() {
            if let Some(items) = list.as_array_mut() {
                items.retain(|condition| {
                    let effect = condition.get("effect_id").filter(|v| !v.is_null()).or_else(|| condition.get("effectId"));
                    !references(condition, "", id) && (shared_alive || source_effect.is_empty() || s(effect) != source_effect)
                });
            }
        }
    }
    if let Some(effects) = mechanics.get_mut("active_effects").and_then(Value::as_array_mut) {
        effects.retain(|effect| {
            let effect_key = effect.get("effect_id").filter(|v| !v.is_null()).or_else(|| effect.get("effectId")).filter(|v| !v.is_null()).or_else(|| effect.get("id"));
            !references(effect, "", id) && (shared_alive || source_effect.is_empty() || s(effect_key) != source_effect)
        });
    }
    if !source_effect.is_empty() && !shared_alive {
        if let Some(concentration) = mechanics.get_mut("concentration").and_then(Value::as_object_mut) {
            concentration.retain(|_, entry| s(entry.get("effect_id")) != source_effect);
        }
    }
    let combat = sk_core::game::combat_mut(state);
    if let Some(completed) = combat.get_mut("turn_completed").and_then(Value::as_array_mut) {
        completed.retain(|entry| s(Some(entry)) != id);
    }
    if let Some(readied) = combat.get_mut("readied").and_then(Value::as_object_mut) {
        readied.retain(|owner, entry| owner != id && !references(entry, "", id));
    }
    if combat.get("reaction_window").is_some_and(|window| references(window, "", id)) {
        combat["reaction_window"] = Value::Null;
    }
    if state.get("tacticalTurn").is_some_and(|turn| references(turn, "", id)) {
        sk_core::js::delete(state, "tacticalTurn");
    }
}

/// `restoreShape(state, targetId, shape, excessDamage)`.
pub(crate) fn restore_shape(state: &mut Value, target: &str, shape: &Value, excess_damage: i64) {
    if !shape.is_object() {
        return;
    }
    let original = shape.get("original").filter(|value| value.is_object()).cloned().unwrap_or_else(sk_core::js::obj);
    if let Some(shapes) = mechanics_mut(state).get_mut("shapes").and_then(Value::as_object_mut) {
        shapes.shift_remove(target);
    }
    let contract_two = shape.get("shape_contract_version").and_then(Value::as_f64) == Some(2.0);
    replace_actor(state, target, |current| {
        let attack_profile = current.get("attack_profile").cloned();
        if let Some(map) = current.as_object_mut() {
            map.shift_remove("footprint");
            map.shift_remove("attack_profile");
            if !contract_two && attack_profile.as_ref().is_some_and(|profile| truthy(Some(profile))) {
                map.insert("attack_profile".into(), attack_profile.clone().unwrap_or(Value::Null));
            }
            map.insert("hp".into(), Value::from((safe_int(original.get("hp"), 1) - excess_damage.max(0)).max(0)));
            map.insert("maxHp".into(), Value::from(safe_int(original.get("maxHp"), 1).max(1)));
            map.insert("armor".into(), Value::from(safe_int(original.get("armor"), 10).max(1)));
            map.insert("speed".into(), Value::from(safe_int(original.get("speed"), 30).max(0)));
            if truthy(original.get("attack_profile")) {
                map.insert("attack_profile".into(), original["attack_profile"].clone());
            }
            if original.as_object().is_some_and(|object| object.contains_key("footprint")) {
                map.insert("footprint".into(), original["footprint"].clone());
            }
        }
    });
}

/// `clearConcentrationEffect(state, target, requestedEffectId, { cleanupMode })`.
/// Возвращает id снятого эффекта.
pub(crate) fn clear_concentration_effect(state: &mut Value, target: &str, requested: Option<&Value>, cleanup: bool) -> Option<String> {
    let current = mechanics(state).get("concentration").and_then(|c| c.get(target)).and_then(|entry| entry.get("effect_id")).filter(|v| truthy(Some(v))).map(|v| s(Some(v)));
    let explicit = requested.is_some_and(|value| !value.is_null() && !s(Some(value)).is_empty());
    let effect = if explicit { s(requested) } else { current.clone().unwrap_or_default() };
    let current_matches = !explicit || current.is_none() || current.as_deref() == Some(effect.as_str());
    if current_matches {
        if let Some(concentration) = mechanics_mut(state).get_mut("concentration").and_then(Value::as_object_mut) {
            concentration.shift_remove(target);
        }
    }
    if effect.is_empty() {
        return None;
    }
    let mechanics_map = mechanics_mut(state);
    if let Some(effects) = mechanics_map.get_mut("active_effects").and_then(Value::as_array_mut) {
        effects.retain(|entry| {
            let key = entry.get("effect_id").filter(|v| !v.is_null()).or_else(|| entry.get("id"));
            s(key) != effect
        });
    }
    let all: Vec<(String, Value)> = mechanics_map.get("conditions").and_then(Value::as_object).map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    for (owner, list) in all {
        let items = list.as_array().cloned().unwrap_or_default();
        let ending_heroism = items.iter().find(|condition| s(condition.get("id")) == "heroism" && s(condition.get("effect_id")) == effect).cloned();
        if let Some(heroism) = ending_heroism {
            let temporary = safe_int(mechanics_map.get("temporary_hp").and_then(|t| t.get(owner.as_str())), 0);
            if temporary <= safe_int(heroism.get("temporary_hp_amount"), 0).max(0) {
                if let Some(map) = mechanics_map.get_mut("temporary_hp").and_then(Value::as_object_mut) {
                    map.shift_remove(&owner);
                }
            }
        }
        let kept: Vec<Value> = items.into_iter().filter(|condition| s(condition.get("effect_id")) != effect).collect();
        if let Some(map) = mechanics_map.get_mut("conditions").and_then(Value::as_object_mut) {
            map.insert(owner, Value::Array(kept));
        }
    }
    let summons: Vec<Value> = if cleanup {
        party_summons_for_expiry(state)
    } else {
        state.get("actors").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().chain(state.get("enemies").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(is_hostile_summon)).collect()
    };
    for summon in summons {
        if (is_party_summon(&summon) || is_hostile_summon(&summon)) && source_effect_id(&summon) == effect {
            remove_summoned_actor(state, &actor_id(&summon), cleanup);
        }
    }
    let shapes: Vec<(String, Value)> = mechanics(state).get("shapes").and_then(Value::as_object).map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    for (shape_target, shape) in shapes {
        if s(shape.get("concentration_actor_id")) != target || s(shape.get("effect_id")) != effect {
            continue;
        }
        restore_shape(state, &shape_target, &shape, 0);
    }
    let _ = condition_id;
    Some(effect)
}
