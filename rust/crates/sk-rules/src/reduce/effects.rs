//! Эффекты боя и жизнь кампании без внешних модулей: области заклинаний,
//! окна реакций, подготовленные действия, отражённый урон, контрзаклинание,
//! возврат облика, отзыв призыва, публичная кость, жизненный цикл кампании,
//! набор правил, цель сцены, решения ведущего — ветки `applyGameEventCurrent`.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_hp, actor_max_hp, combat, combat_actor_kind, combat_mut, condition_ids, mechanics, mechanics_mut, replace_actor};
use sk_core::js::{is_true, present, s, safe_int, truthy, unique_strings};
use sk_core::Event;

use super::conditions::{remove_summoned_actor, restore_shape, summon_cleanup};
use super::{scene_turn_and_round, target_of};
use crate::journal::{append_battle_log, Entry};

/// Сколько раз ответ на реакцию продлевает срок одного хода.
pub const TURN_REACTION_EXTENSION_LIMIT: i64 = 2;

fn extra(event: &Event, key: &str) -> Value {
    event.extra.get(key).cloned().unwrap_or(Value::Null)
}

fn combat_object(state: &mut Value) -> &mut Map<String, Value> {
    let combat = combat_mut(state);
    if !combat.is_object() {
        *combat = sk_core::js::obj();
    }
    combat.as_object_mut().expect("бой")
}

fn effect_key(effect: &Value) -> String {
    s(effect.get("effect_id").filter(|v| !v.is_null()).or_else(|| effect.get("id")))
}

fn active_effects(state: &Value) -> Vec<Value> {
    mechanics(state).get("active_effects").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn coalesce<'a>(values: &[Option<&'a Value>]) -> Value {
    values.iter().copied().flatten().find(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

pub fn spell_area_created(state: &mut Value, event: &Event) {
    let Some(effect) = event.payload.get("effect").filter(|value| value.is_object()).cloned() else { return };
    if !truthy(effect.get("id")) {
        return;
    }
    let id = s(effect.get("id"));
    let mut effects: Vec<Value> = active_effects(state).into_iter().filter(|candidate| s(candidate.get("id")) != id).collect();
    effects.push(effect);
    mechanics_mut(state).insert("active_effects".into(), Value::Array(effects));
}

pub fn spell_area_triggered(state: &mut Value, event: &Event) {
    let triggered = s(event.payload.get("effect_id"));
    let actor = target_of(event);
    if triggered.is_empty() || actor.is_empty() {
        return;
    }
    let turn_key = s(event.payload.get("turn_key"));
    let effects: Vec<Value> = active_effects(state)
        .into_iter()
        .map(|effect| {
            if effect_key(&effect) != triggered {
                return effect;
            }
            let mut turns = effect.get("triggered_turns").filter(|v| v.is_object()).cloned().unwrap_or_else(sk_core::js::obj);
            turns[actor.as_str()] = Value::String(turn_key.clone());
            sk_core::js::spread(&effect, json!({ "triggered_turns": turns }))
        })
        .collect();
    mechanics_mut(state).insert("active_effects".into(), Value::Array(effects));
}

pub fn spell_area_removed(state: &mut Value, event: &Event) {
    let removed = s(event.payload.get("effect_id"));
    let effects: Vec<Value> = active_effects(state).into_iter().filter(|effect| effect_key(effect) != removed).collect();
    mechanics_mut(state).insert("active_effects".into(), Value::Array(effects));
}

pub fn reaction_window_opened(state: &mut Value, event: &Event) {
    let window = sk_core::js::spread(&event.payload, json!({ "opened_at": extra(event, "created_at"), "opened_event_id": extra(event, "event_id") }));
    combat_object(state).insert("reaction_window".into(), window);
}

pub fn action_readied(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let combat = combat_object(state);
    let mut readied = combat.get("readied").filter(|v| v.is_object()).cloned().unwrap_or_else(sk_core::js::obj);
    readied[target.as_str()] = event.payload.clone();
    combat.insert("readied".into(), readied);
}

pub fn readied_action_expired(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let combat = combat_object(state);
    let mut readied = combat.get("readied").and_then(Value::as_object).cloned().unwrap_or_default();
    readied.shift_remove(&target);
    combat.insert("readied".into(), Value::Object(readied));
}

pub fn reaction_window_closed(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let window = combat(state).get("reaction_window").cloned().unwrap_or(Value::Null);
    if truthy(payload.get("id")) && s(window.get("id")) != s(payload.get("id")) {
        return;
    }
    let fleeing = if window.get("trigger").and_then(Value::as_str) == Some("enemy-left-reach") { s(window.get("source_actor_id")) } else { String::new() };
    if !fleeing.is_empty() && !is_true(payload.get("defer_flee")) && condition_ids(state, &fleeing).contains("fled") {
        replace_actor(state, &fleeing, |actor| {
            actor["alive"] = Value::Bool(false);
        });
    }
    let combat = combat_object(state);
    combat.insert("reaction_window".into(), Value::Null);
    let used = safe_int(combat.get("turn_reaction_extensions"), 0);
    if !is_true(payload.get("free_choice")) && !present(payload.get("reaction_preference")) && used < TURN_REACTION_EXTENSION_LIMIT {
        combat.insert("turn_reaction_extensions".into(), Value::from(used + 1));
        combat.insert("turn_started_at".into(), extra(event, "created_at"));
        combat.insert("turn_started_event_id".into(), extra(event, "event_id"));
    }
}

pub fn reaction_damage_reduced(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let target = target_of(event);
    replace_actor(state, &target, |actor| {
        let hp = safe_int(payload.get("hp_after"), actor_hp(actor)).max(0).min(actor_max_hp(actor));
        actor["hp"] = Value::from(hp);
    });
    if present(payload.get("temporary_hp_after")) {
        let temporary = safe_int(payload.get("temporary_hp_after"), 0).max(0);
        let map = mechanics_mut(state).entry("temporary_hp").or_insert_with(sk_core::js::obj);
        if let Some(map) = map.as_object_mut() {
            map.insert(target.clone(), Value::from(temporary));
        }
    }
    if let Some(log) = state.get_mut("battleLog").and_then(Value::as_array_mut) {
        if let Some(item) = log.iter_mut().rev().find(|item| item.get("type").and_then(Value::as_str) == Some("attack") && s(item.get("targetId")) == target && present(item.get("damage"))) {
            let damage = (safe_int(item.get("damage"), 0) - safe_int(payload.get("prevented_amount"), 0)).max(0);
            let mut patch = json!({ "damage": damage });
            if sk_core::js::is_safe_integer_number(payload.get("hp_after")) {
                patch["hpAfter"] = Value::from(safe_int(payload.get("hp_after"), 0));
            } else if let Some(previous) = item.get("hpAfter") {
                patch["hpAfter"] = previous.clone();
            }
            *item = sk_core::js::spread(item, patch);
        }
    }
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor = event.actor_id.clone().unwrap_or_default();
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "reaction")
        .set("actorId", event.actor_id.clone().map_or(Value::Null, Value::from))
        .set("actorKind", combat_actor_kind(state, &actor))
        .set("targetId", target)
        .opt("actionId", payload.get("action_id").cloned())
        .text_if("actionName", payload.get("name"))
        .set("preventedDamage", safe_int(payload.get("prevented_amount"), 0))
        .build();
    append_battle_log(state, event, entry);
}

pub fn spell_countered(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor = event.actor_id.clone().unwrap_or_default();
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "reaction")
        .set("actorId", event.actor_id.clone().map_or(Value::Null, Value::from))
        .set("actorKind", combat_actor_kind(state, &actor))
        .set("targetId", target_of(event))
        .set("actionId", "counterspell")
        .opt("spellId", payload.get("spell_id").cloned())
        .opt("spellName", payload.get("spell_name").cloned())
        .set("countered", true)
        .build();
    append_battle_log(state, event, entry);
}

pub fn shape_reverted(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let Some(shape) = mechanics(state).get("shapes").and_then(|shapes| shapes.get(target.as_str())).filter(|shape| truthy(Some(shape))).cloned() else { return };
    let excess = safe_int(event.payload.get("excess_damage"), 0).max(0);
    restore_shape(state, &target, &shape, excess);
}

pub fn summoned_creature_dismissed(state: &mut Value, event: &Event) {
    let target = target_of(event);
    remove_summoned_actor(state, &target, summon_cleanup(&event.payload));
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor = event.actor_id.clone().unwrap_or_default();
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "summon-end")
        .set("actorId", event.actor_id.clone().map_or(Value::Null, Value::from))
        .set("actorKind", combat_actor_kind(state, &actor))
        .set("targetId", target)
        .opt("reason", event.payload.get("reason").cloned())
        .build();
    append_battle_log(state, event, entry);
}

pub fn public_die_rolled(state: &mut Value, event: &Event) {
    if let Some(roll) = event.payload.get("roll").filter(|roll| roll.is_object()) {
        state["lastDiceRoll"] = roll.clone();
    }
}

pub fn opening_strike_economy_restored(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let combat = combat_object(state);
    let slot = combat.entry("action_economy").or_insert_with(sk_core::js::obj);
    if !slot.is_object() {
        *slot = sk_core::js::obj();
    }
    let economy = slot.as_object_mut().expect("экономика хода");
    if let Some(restored) = event.payload.get("action_economy").filter(|value| value.is_object()) {
        economy.insert(target, restored.clone());
    } else if !target.is_empty() {
        economy.shift_remove(&target);
    }
}

fn lifecycle_with(state: &mut Value, patch: Value) {
    let lifecycle = mechanics(state).get("campaign_lifecycle").cloned().unwrap_or(Value::Null);
    mechanics_mut(state).insert("campaign_lifecycle".into(), sk_core::js::spread(&lifecycle, patch));
}

/// `payload.changed_by ?? event.actor_id ?? null`.
fn changed_by(event: &Event) -> Value {
    match event.payload.get("changed_by").filter(|value| !value.is_null()) {
        Some(value) => value.clone(),
        None => event.actor_id.clone().map_or(Value::Null, Value::from),
    }
}

fn reason_or(payload: &Value, fallback: &str) -> String {
    let reason = if truthy(payload.get("reason")) { s(payload.get("reason")) } else { fallback.to_string() };
    sk_core::text::head(&reason, 240)
}

pub fn campaign_resumed(state: &mut Value, event: &Event) {
    let by = changed_by(event);
    lifecycle_with(state, json!({ "status": "active", "reason": null, "paused_at": null, "changed_by": by }));
}

pub fn campaign_paused(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let at = coalesce(&[payload.get("occurred_at"), event.extra.get("occurred_at")]);
    let by = changed_by(event);
    lifecycle_with(state, json!({ "status": "paused", "reason": reason_or(payload, "manual"), "paused_at": at, "changed_by": by }));
}

pub fn campaign_archived(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let at = coalesce(&[payload.get("occurred_at"), event.extra.get("occurred_at")]);
    let by = changed_by(event);
    lifecycle_with(state, json!({ "status": "archived", "reason": reason_or(payload, "archived"), "archived_at": at, "changed_by": by }));
}

pub fn campaign_concluded(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let completed = event.event_type == "CampaignCompleted";
    let lifecycle = mechanics(state).get("campaign_lifecycle").cloned().unwrap_or(Value::Null);
    let epilogue = if present(payload.get("epilogue")) { Value::from(sk_core::text::head(&s(payload.get("epilogue")), 8_000)) } else { lifecycle.get("epilogue").cloned().unwrap_or(Value::Null) };
    let keys = match payload.get("epilogue_fact_keys") {
        Some(Value::Array(list)) => Value::Array(list.iter().map(|key| sk_core::text::head(&s(Some(key)), 240)).filter(|key| !key.is_empty()).take(64).map(Value::from).collect()),
        _ => lifecycle.get("epilogue_fact_keys").cloned().unwrap_or(Value::Null),
    };
    let at = coalesce(&[payload.get("occurred_at"), event.extra.get("occurred_at"), event.extra.get("created_at")]);
    let by = changed_by(event);
    let mut patch = json!({
        "status": if completed { "completed" } else { "failed" },
        "reason": reason_or(payload, if completed { "completed" } else { "failed" }),
        "concluded_at": at,
        "epilogue": epilogue,
        "epilogue_fact_keys": keys,
        "changed_by": by,
    });
    if let Some(ending) = payload.get("ending").filter(|value| value.is_object()) {
        patch["ending"] = json!({
            "id": sk_core::text::head(&s(ending.get("id")), 80),
            "title": sk_core::text::head(&s(ending.get("title")), 160),
            "outcome": sk_core::text::head(&s(ending.get("outcome")), 60),
        });
    }
    // Поля без значения в JS — `undefined` и в JSON не попадают.
    if let Some(map) = patch.as_object_mut() {
        for key in ["epilogue", "epilogue_fact_keys"] {
            if map.get(key) == Some(&Value::Null) && lifecycle.get(key).is_none() && !present(payload.get(key)) {
                map.shift_remove(key);
            }
        }
    }
    lifecycle_with(state, patch);
}

pub fn campaign_house_rule_changed(state: &mut Value, event: &Event) {
    state["enabled_house_rules"] = sk_core::js::strings_value(unique_strings(event.payload.get("enabled_house_rules_after")));
}

pub fn campaign_ruleset_changed(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let pick = |key: &str, current: &Value| -> Value {
        if truthy(payload.get(key)) { Value::from(s(payload.get(key))) } else { Value::from(s(Some(current))) }
    };
    let ruleset_id = pick("ruleset_id_after", &state.get("ruleset_id").cloned().unwrap_or(Value::Null));
    let ruleset_version = pick("ruleset_version_after", &state.get("ruleset_version").cloned().unwrap_or(Value::Null));
    state["ruleset_id"] = ruleset_id.clone();
    state["ruleset_version"] = ruleset_version;
    let mut packs = unique_strings(payload.get("enabled_rule_packs_after"));
    if packs.is_empty() {
        packs.push(s(Some(&ruleset_id)));
    }
    state["enabled_rule_packs"] = sk_core::js::strings_value(packs);
    state["enabled_house_rules"] = sk_core::js::strings_value(unique_strings(payload.get("enabled_house_rules_after")));
    if let Some(changed_at) = payload.get("changed_at").filter(|v| !v.is_null()) {
        state["ruleset_locked_at"] = changed_at.clone();
    }
    state["ruleset_selection_locked"] = Value::Bool(false);
}

pub fn objective_updated(state: &mut Value, event: &Event) {
    if !truthy(state.get("scene")) {
        return;
    }
    let objective = if truthy(event.payload.get("objective")) { s(event.payload.get("objective")) } else { String::new() };
    state["scene"]["objective"] = Value::from(objective);
}

pub fn ruling_recorded(state: &mut Value, event: &Event) {
    let mut rulings = state.get("rulings").and_then(Value::as_array).cloned().unwrap_or_default();
    rulings.push(event.payload.get("ruling").cloned().unwrap_or(Value::Null));
    state["rulings"] = Value::Array(rulings);
}

pub fn spell_bonus_preference_changed(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let enabled = payload.get("enabled").and_then(Value::as_bool);
    if payload.get("schema_version").and_then(Value::as_f64) != Some(1.0) || payload.get("spell_id").and_then(Value::as_str) != Some("bless") {
        return;
    }
    let Some(enabled) = enabled else { return };
    let target = target_of(event);
    let list = sk_core::game::conditions_mut(state, &target);
    for condition in list.iter_mut() {
        if condition.get("id").and_then(Value::as_str) == Some("bless-d4") {
            *condition = sk_core::js::spread(condition, json!({ "bonus_enabled": enabled }));
        }
    }
}

/// `ReactionPreferenceChanged`: режим реакции героя; «спрашивать» — значение по
/// умолчанию и не хранится, пустые записи исчезают.
pub fn reaction_preference_changed(state: &mut Value, event: &Event) {
    use sk_combat_base::reaction_preferences::{is_configurable_reaction, is_reaction_mode, REACTION_MODE_SCHEMA_VERSION};
    let payload = &event.payload;
    let reaction = s(payload.get("reaction_id"));
    let target = target_of(event);
    let valid = payload.get("schema_version").and_then(Value::as_f64) == Some(REACTION_MODE_SCHEMA_VERSION as f64)
        && !target.is_empty()
        && is_configurable_reaction(Some(&Value::String(reaction.clone())))
        && is_reaction_mode(payload.get("mode"));
    if !valid {
        return;
    }
    let current = mechanics(state).get("reaction_preferences").cloned().unwrap_or(Value::Null);
    let mut hero = current.get(target.as_str()).and_then(Value::as_object).cloned().unwrap_or_default();
    if payload.get("mode").and_then(Value::as_str) == Some("ask") {
        hero.shift_remove(&reaction);
    } else {
        hero.insert(reaction, payload["mode"].clone());
    }
    let mut preferences = current.as_object().cloned().unwrap_or_default();
    if hero.is_empty() {
        preferences.shift_remove(&target);
    } else {
        preferences.insert(target, Value::Object(hero));
    }
    let mechanics = mechanics_mut(state);
    if preferences.is_empty() {
        mechanics.shift_remove("reaction_preferences");
    } else {
        mechanics.insert("reaction_preferences".into(), Value::Object(preferences));
    }
}

/// События социальных профилей NPC: `state.social = applyNpcSocialEvent(...)`.
pub fn npc_social_event(state: &mut Value, event: &Event) {
    let event_json = serde_json::to_value(event).unwrap_or(Value::Null);
    let current = state.get("social").cloned().unwrap_or(Value::Null);
    let next = sk_social::npc_social::apply_npc_social_event(&current, &event_json, state, &json!({}));
    state["social"] = next;
}
