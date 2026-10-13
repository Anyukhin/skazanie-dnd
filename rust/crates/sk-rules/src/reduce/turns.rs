//! Ход и раунд боя: начало и конец хода, время раунда, конец боя и встречи,
//! отдых, кости хитов, течение времени мира — ветки `applyGameEventCurrent`.

use serde_json::{json, Map, Value};
use sk_core::game::{combat, combat_mut, combat_round, condition_ids, find_actor, is_enemy_actor, mechanics, mechanics_mut};
use sk_core::js::{is_true, number, present, s, safe_int, truthy};
use sk_core::Event;

use super::conditions::clear_concentration_effect;
use super::{scene_turn_and_round, target_of};
use crate::economy::{action_economy, economy_of, event_version, set_economy, weapon_attack_limit_for_action, with, with_frame, Frame, ACTION_ECONOMY_EVENT_VERSION};
use crate::journal::{append_battle_log, Entry};
use crate::tables::condition_effect;
use crate::world_clock::{duration_in_minutes, normalized_clock_seconds, normalized_clock_seconds_of, world_time_seconds};

pub const COMBAT_ROUND_TIME_POLICY: &str = "round6-completed-and-final-started";
pub const REST_POLICY_ID: &str = "srd-5.2.1-rest-v2";
pub const REST_EVENT_SCHEMA_VERSION: i64 = 2;
pub const HIT_POINT_DIE_EVENT_SCHEMA_VERSION: i64 = 1;
pub const DND_2014_TIMED_BUFF_EXPIRY_POLICY: &str = "dnd2014-timed-buff/v1";
pub const PROTECTION_FROM_ENERGY_EXPIRY_POLICY: &str = "protection-from-energy/v1";
const REST_MINIMUM_SHORT: i64 = 60;
const REST_MINIMUM_LONG: i64 = 480;

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

/// `initiativeGroupIds(state)`: участники групповой фазы, на которой стоит
/// указатель инициативы.
pub(crate) fn initiative_group_ids(state: &Value) -> Vec<String> {
    let combat = combat(state);
    let order = combat.get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
    if !truthy(combat.get("group_initiative")) || order.is_empty() {
        return Vec::new();
    }
    let index = safe_int(combat.get("active_index"), -1);
    if index < 0 || index as usize >= order.len() {
        return Vec::new();
    }
    let index = index as usize;
    let side_of = |entry: &Value| is_enemy_actor(state, &s(entry.get("actor_id")));
    let side = side_of(&order[index]);
    let mut group = vec![s(order[index].get("actor_id"))];
    let mut step = index;
    while step > 0 && side_of(&order[step - 1]) == side {
        step -= 1;
        group.insert(0, s(order[step].get("actor_id")));
    }
    let mut step = index + 1;
    while step < order.len() && side_of(&order[step]) == side {
        group.push(s(order[step].get("actor_id")));
        step += 1;
    }
    group
}

/// Каждому списку состояний — своё преобразование (`flatMap` по всем существам).
fn map_conditions(state: &mut Value, mut transform: impl FnMut(&str, &Value) -> Vec<Value>) {
    let Some(all) = mechanics_mut(state).get_mut("conditions").and_then(Value::as_object_mut) else { return };
    for (owner, list) in all.iter_mut() {
        let items = list.as_array().cloned().unwrap_or_default();
        let next: Vec<Value> = items.iter().flat_map(|condition| transform(owner, condition)).collect();
        *list = Value::Array(next);
    }
}

fn duration(condition: &Value) -> Option<&str> {
    condition.get("duration").and_then(Value::as_str)
}

fn counted(duration: &str, prefix: &str) -> Option<i64> {
    let digits = duration.strip_prefix(prefix)?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse::<f64>().ok().map(|n| n as i64)).flatten()
}

pub fn combat_round_time_marked(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    if number(payload.get("clock_version")) == 2.0
        && payload.get("policy_id").and_then(Value::as_str) == Some(COMBAT_ROUND_TIME_POLICY)
        && truthy(combat(state).get("active"))
        && safe_int(payload.get("round"), -1) == combat_round(state)
    {
        combat_object(state).insert("round_time_pending".into(), Value::Bool(true));
    }
}

pub fn turn_started(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    let target = target_of(event);
    let versioned = event_version(&payload) >= ACTION_ECONOMY_EVENT_VERSION;
    let current_round = safe_int(combat(state).get("round"), 0);
    let current_index = safe_int(combat(state).get("active_index"), 0);
    let round = safe_int(payload.get("round"), current_round);
    {
        let combat = combat_object(state);
        if round > current_round {
            combat.remove("round_time_pending");
        }
        combat.insert("round".into(), Value::from(round));
        combat.insert("active_index".into(), Value::from(safe_int(payload.get("active_index"), current_index)));
        combat.insert("turn_started_at".into(), extra(event, "created_at"));
        combat.insert("turn_started_event_id".into(), extra(event, "event_id"));
        combat.remove("turn_reaction_extensions");
    }
    map_conditions(state, |_, condition| {
        let lapses = duration(condition) == Some("until-source-next-turn") && s(condition.get("source_actor")) == target;
        if lapses { Vec::new() } else { vec![condition.clone()] }
    });
    combat_object(state).insert("turn_completed".into(), json!([]));
    if truthy(combat(state).get("group_initiative")) {
        for member in initiative_group_ids(state) {
            if member != target {
                set_economy(state, &member, action_economy());
            }
        }
    }
    let round_now = combat_round(state);
    {
        let mechanics = mechanics_mut(state);
        let effects = mechanics.get("active_effects").and_then(Value::as_array).cloned().unwrap_or_default();
        let kept: Vec<Value> = effects.into_iter().filter(|effect| safe_int(effect.get("expires_round"), 9_007_199_254_740_991) > round_now).collect();
        mechanics.insert("active_effects".into(), Value::Array(kept));
    }
    if target.is_empty() {
        return;
    }
    set_economy(state, &target, action_economy());
    {
        let conditions = sk_core::game::conditions_mut(state, &target);
        let items = std::mem::take(conditions);
        *conditions = items
            .into_iter()
            .flat_map(|condition| -> Vec<Value> {
                if condition.get("true_strike_version").and_then(Value::as_f64) == Some(1.0) {
                    return vec![sk_core::js::spread(&condition, json!({ "true_strike_armed": true }))];
                }
                let duration_text = duration(&condition).unwrap_or("").to_string();
                if duration_text == "until-next-turn" {
                    return Vec::new();
                }
                if duration_text == "until-next-own-turn-end" && s(condition.get("source_actor")) == target && !is_true(condition.get("absorb_elements_rider_armed")) {
                    return vec![sk_core::js::spread(&condition, json!({ "absorb_elements_rider_armed": true }))];
                }
                let Some(rounds) = counted(&s(condition.get("duration")), "rounds:") else { return vec![condition] };
                let remaining = rounds - 1;
                if remaining > 0 {
                    vec![sk_core::js::spread(&condition, json!({ "duration": format!("rounds:{remaining}") }))]
                } else {
                    Vec::new()
                }
            })
            .collect();
    }
    let (extra_actions, forbids_reactions) = economy_flags(state, &target);
    if extra_actions > 0 || forbids_reactions {
        let economy = economy_of(state, &target);
        let mut patch = json!({ "extra_actions": extra_actions });
        if forbids_reactions {
            patch["reaction"] = Value::Bool(false);
        }
        set_economy(state, &target, with(&economy, patch));
    }
    if versioned {
        let members = if truthy(combat(state).get("group_initiative")) { initiative_group_ids(state) } else { vec![target.clone()] };
        let reference = {
            let id = extra(event, "event_id");
            if present(Some(&id)) {
                s(Some(&id))
            } else if let Some(command) = event.command_id.as_ref() {
                command.clone()
            } else {
                s(combat(state).get("round"))
            }
        };
        for member in members {
            initialize_versioned_turn_economy(state, &member, &reference);
        }
    }
}

/// Лишние действия и запрет реакций по состояниям существа.
fn economy_flags(state: &Value, id: &str) -> (i64, bool) {
    let mut extra_actions = 0;
    let mut forbids = false;
    for condition in condition_ids(state, id) {
        if let Some(effect) = condition_effect(&condition) {
            extra_actions += safe_int(effect.get("extraActions"), 0);
            forbids |= is_true(effect.get("forbidsReactions"));
        }
    }
    (extra_actions, forbids)
}

fn initialize_versioned_turn_economy(state: &mut Value, id: &str, reference: &str) {
    let economy = economy_of(state, id);
    let actor = find_actor(state, id).cloned();
    let normal_limit = weapon_attack_limit_for_action(state, actor.as_ref(), id, false);
    let loading = json!({ "action": [], "bonus_action": [], "reaction": [] });
    let normal = Frame { id: format!("turn-action:{reference}:{id}:normal"), kind: "normal".into(), limit: normal_limit, attacks_used: 0, loading: loading.clone() };
    let haste = condition_ids(state, id).contains("hasted");
    let current = if haste { Frame { id: format!("turn-action:{reference}:{id}:haste"), kind: "haste".into(), limit: 1, ..normal.clone() } } else { normal.clone() };
    let (extra_actions, forbids) = economy_flags(state, id);
    let mut result = economy.as_object().cloned().unwrap_or_default();
    result.insert("action_economy_version".into(), Value::from(ACTION_ECONOMY_EVENT_VERSION));
    result.insert("action".into(), Value::Bool(true));
    result.insert("extra_actions".into(), Value::from(extra_actions));
    if forbids {
        result.insert("reaction".into(), Value::Bool(false));
    }
    let base = with(&economy, json!({ "action": true, "extra_actions": extra_actions }));
    if let Value::Object(framed) = with_frame(&base, &current) {
        for (key, value) in framed {
            result.insert(key, value);
        }
    }
    result.insert("attack_action_stack".into(), if haste { Value::Array(vec![normal.to_value()]) } else { json!([]) });
    set_economy(state, id, Value::Object(result));
}

pub fn turn_ended(state: &mut Value, event: &Event) {
    let actor = event.actor_id.clone().unwrap_or_default();
    map_conditions(state, |owner, condition| {
        let duration_text = duration(condition);
        if duration_text == Some("until-next-own-turn-end") && is_true(condition.get("absorb_elements_rider_armed")) && s(condition.get("source_actor")) == actor {
            return Vec::new();
        }
        if duration_text == Some("until-own-turn-end") {
            return if owner == actor { Vec::new() } else { vec![condition.clone()] };
        }
        if s(condition.get("source_actor")) != actor {
            return vec![condition.clone()];
        }
        let Some(turns) = counted(&s(condition.get("duration")), "source-turns:") else { return vec![condition.clone()] };
        let remaining = turns - 1;
        if remaining > 0 {
            vec![sk_core::js::spread(condition, json!({ "duration": format!("source-turns:{remaining}") }))]
        } else {
            Vec::new()
        }
    });
    if is_true(event.payload.get("group_phase")) && !actor.is_empty() {
        let previous: Vec<String> = combat(state).get("turn_completed").and_then(Value::as_array).map(|list| list.iter().map(|id| s(Some(id))).collect()).unwrap_or_default();
        let deadline_owner = initiative_group_ids(state).into_iter().find(|id| !previous.contains(id));
        let mut completed: Vec<String> = Vec::new();
        for id in previous.into_iter().chain(std::iter::once(actor.clone())) {
            if !completed.contains(&id) {
                completed.push(id);
            }
        }
        let combat = combat_object(state);
        combat.insert("turn_completed".into(), sk_core::js::strings_value(completed));
        if actor == deadline_owner.unwrap_or_default() {
            combat.insert("turn_started_at".into(), extra(event, "created_at"));
            combat.insert("turn_started_event_id".into(), extra(event, "event_id"));
            combat.remove("turn_reaction_extensions");
        }
    }
    let (scene_turn, _) = scene_turn_and_round(state);
    let round = safe_int(event.payload.get("round"), combat_round(state));
    let kind = sk_core::game::combat_actor_kind(state, &actor);
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "turn-end")
        .set("actorId", event.actor_id.clone().map_or(Value::Null, Value::from))
        .set("actorKind", kind)
        .build();
    append_battle_log(state, event, entry);
}

pub fn combat_ended(state: &mut Value, event: &Event) {
    let round = safe_int(event.payload.get("round"), combat_round(state));
    let reason = if truthy(event.payload.get("reason")) { s(event.payload.get("reason")) } else { "resolved".into() };
    append_battle_log(state, event, Entry::new().set("type", "combat-end").set("round", round).set("reason", reason).build());
    mechanics_mut(state).insert(
        "combat".into(),
        json!({ "active": false, "round": round, "initiative": [], "active_index": -1, "action_economy": {}, "reaction_window": null, "readied": {}, "truce": null, "parley_attempts": 0 }),
    );
}

fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().flatten().find(|value| !value.is_null())
}

pub fn encounter_ended(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    if truthy(mechanics(state).get("encounter")) {
        let outcome = coalesce(&[payload.get("outcome"), payload.get("reason")]).map_or_else(|| "resolved".to_string(), |value| s(Some(value)));
        let ended_at = coalesce(&[event.extra.get("occurred_at"), event.extra.get("created_at")]).cloned().unwrap_or(Value::Null);
        let encounter = mechanics(state).get("encounter").cloned().unwrap_or(Value::Null);
        let next = sk_core::js::spread(&encounter, json!({ "status": "ended", "outcome": sk_core::text::head(&outcome, 120), "ended_at": ended_at }));
        mechanics_mut(state).insert("encounter".into(), next);
    }
    let reason = coalesce(&[payload.get("reason"), payload.get("outcome")]).map_or_else(|| "resolved".to_string(), |value| s(Some(value)));
    let participants = payload.get("enemy_ids").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
    let entry = Entry::new().set("type", "encounter-ended").opt("encounterId", payload.get("encounter_id").cloned()).set("participantIds", participants).set("reason", reason).build();
    append_battle_log(state, event, entry);
}

pub fn rest_started(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = &event.payload;
    let long = payload.get("kind").and_then(Value::as_str) == Some("long");
    let kind = if long { "long" } else { "short" };
    let record = if event.event_schema_version.is_some_and(|version| version >= REST_EVENT_SCHEMA_VERSION) {
        json!({
            "schema_version": REST_EVENT_SCHEMA_VERSION,
            "policy_id": REST_POLICY_ID,
            "rest_id": s(payload.get("rest_id")),
            "kind": kind,
            "started_at_minutes": safe_int(payload.get("started_at_minutes"), 0).max(0),
            "minimum_duration_minutes": safe_int(payload.get("minimum_duration_minutes"), if long { REST_MINIMUM_LONG } else { REST_MINIMUM_SHORT }).max(REST_MINIMUM_SHORT),
        })
    } else if payload.get("reason").and_then(Value::as_str) == Some("knockout") {
        json!({ "kind": kind, "reason": "knockout", "recovery_minutes_remaining": 60 })
    } else {
        json!({ "kind": kind })
    };
    let mechanics = mechanics_mut(state);
    let resting = mechanics.entry("resting").or_insert_with(sk_core::js::obj);
    if let Some(map) = resting.as_object_mut() {
        map.insert(target, record);
    }
}

/// `HitPointDieSpent` и `HitPointDiceRestored`: запас костей хитов после траты
/// или отдыха.
pub fn hit_point_dice_changed(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    if event.event_schema_version != Some(HIT_POINT_DIE_EVENT_SCHEMA_VERSION) || number(payload.get("schema_version")) != HIT_POINT_DIE_EVENT_SCHEMA_VERSION as f64 {
        return;
    }
    let target = target_of(event);
    let pool = payload.get("pool_after").cloned().unwrap_or(Value::Null);
    let die_size = number(pool.get("die_size"));
    let die_size = if [6.0, 8.0, 10.0, 12.0].contains(&die_size) { die_size as i64 } else { 8 };
    let record = json!({
        "schema_version": HIT_POINT_DIE_EVENT_SCHEMA_VERSION,
        "maximum": safe_int(pool.get("maximum"), 1).clamp(1, 12),
        "spent": safe_int(pool.get("spent"), 0).max(0),
        "die_size": die_size,
    });
    let mechanics = mechanics_mut(state);
    let dice = mechanics.entry("hit_point_dice").or_insert_with(sk_core::js::obj);
    if let Some(map) = dice.as_object_mut() {
        map.insert(target, record);
    }
}

fn effect_ids_with<F: Fn(&Value) -> bool>(state: &Value, predicate: F) -> bool {
    mechanics(state).get("conditions").and_then(Value::as_object).is_some_and(|all| all.values().any(|list| list.as_array().is_some_and(|items| items.iter().any(&predicate))))
}

pub fn time_advanced(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let seconds_clock = number(payload.get("clock_version")) == 2.0;
    let elapsed = if seconds_clock {
        normalized_clock_seconds_of(payload.get("elapsed_seconds"))
    } else {
        (safe_int(payload.get("elapsed_minutes"), duration_in_minutes(payload.get("amount"), payload.get("unit"))).max(0) * 60) as f64
    };
    let total_seconds = normalized_clock_seconds(world_time_seconds(state) + elapsed);
    let total_minutes = (total_seconds / 60.0).floor() as i64;
    let keeps_remainder = seconds_clock || mechanics(state).get("world_time").and_then(|time| time.get("second_remainder")).is_some_and(|value| !value.is_null());
    let mut world_time = json!({ "amount": total_minutes, "unit": "minute", "elapsed_minutes": total_minutes });
    if keeps_remainder {
        world_time["second_remainder"] = sk_core::js::num(normalized_clock_seconds(total_seconds % 60.0));
    }
    mechanics_mut(state).insert("world_time".into(), world_time);

    let concentration: Vec<(String, Value)> = mechanics(state).get("concentration").and_then(Value::as_object).map(|map| sk_core::js::entries(map).into_iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    for (owner, record) in &concentration {
        let effect = s(record.get("effect_id"));
        let expired_buff = effect_ids_with(state, |condition| {
            condition.get("expiry_policy").and_then(Value::as_str) == Some(DND_2014_TIMED_BUFF_EXPIRY_POLICY)
                && s(condition.get("effect_id")) == effect
                && present(condition.get("expires_at_seconds"))
                && normalized_clock_seconds_of(condition.get("expires_at_seconds")) <= total_seconds
        });
        if !effect.is_empty() && expired_buff {
            clear_concentration_effect(state, owner, Some(&Value::String(effect)), false);
        }
    }
    let mut expired_effects: Vec<String> = Vec::new();
    map_conditions(state, |_, condition| {
        let active = if present(condition.get("expires_at_seconds")) {
            normalized_clock_seconds_of(condition.get("expires_at_seconds")) > total_seconds
        } else {
            !present(condition.get("expires_at_minutes")) || safe_int(condition.get("expires_at_minutes"), total_minutes) > total_minutes
        };
        let expires_concentration = condition.get("expiry_policy").and_then(Value::as_str) == Some(PROTECTION_FROM_ENERGY_EXPIRY_POLICY)
            || (number(condition.get("skill_buff_version")) == 1.0 && condition.get("spell_id").and_then(Value::as_str) == Some("skill-empowerment"));
        if !active && expires_concentration && present(condition.get("effect_id")) {
            let id = s(condition.get("effect_id"));
            if !expired_effects.contains(&id) {
                expired_effects.push(id);
            }
        }
        if active { vec![condition.clone()] } else { Vec::new() }
    });
    let concentration: Vec<(String, Value)> = mechanics(state).get("concentration").and_then(Value::as_object).map(|map| sk_core::js::entries(map).into_iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    for (owner, record) in concentration {
        let effect = s(record.get("effect_id"));
        if effect.is_empty() || !expired_effects.contains(&effect) {
            continue;
        }
        let still_linked = effect_ids_with(state, |condition| s(condition.get("effect_id")) == effect);
        if !still_linked {
            clear_concentration_effect(state, &owner, Some(&Value::String(effect)), false);
        }
    }
}
