//! Ветки `resolveCommandInternal`: Отдых: начало, трата кости хитов, завершение. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 22627–22645, 22646–22686, 22687–22760. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::Resolve;
use crate::command::rules::rule_ids;
use crate::conditions::{at_path, exhaustion_level_of, hit_point_maximum_bonus_of};
use crate::constants::{HIT_POINT_DIE_EVENT_SCHEMA_VERSION, REST_EVENT_SCHEMA_VERSION, REST_POLICY_ID};
use crate::core::{ability_modifier, actor_max_hp, command_with_rules, event_from, player_actor, signed, slice_utf16};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Step};
use crate::rest::{elapsed_rest_minutes, hit_point_dice_pool_for_actor, rest_minimum_minutes_for};

/// `{ ...event, event_schema_version }`.
fn with_schema(mut event: Value, version: i64) -> Value {
    if let Some(map) = event.as_object_mut() {
        map.insert("event_schema_version".into(), Value::from(version));
    }
    event
}

/// `[command.actor_id]`.
fn actor_targets(command: &Value) -> Value {
    json!([command.get("actor_id").cloned().unwrap_or(Value::Null)])
}

/// `...(command.request_fingerprint ? { request_fingerprint } : {})`.
fn with_fingerprint(payload: &mut Map<String, Value>, command: &Value) {
    if let Some(fingerprint) = command.get("request_fingerprint").filter(|value| js::truthy(Some(value))) {
        payload.insert("request_fingerprint".into(), fingerprint.clone());
    }
}

/// `state.mechanics.world_time?.elapsed_minutes` целым не меньше нуля.
fn world_minutes(state: &Value) -> i64 {
    js::safe_int(at_path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]), 0).max(0)
}

/// `StartRest` (22627–22645).
pub fn start_rest(r: &mut Resolve<'_>) -> Step {
    let started_at_minutes = world_minutes(&r.state);
    let rest_id = match r.command.get("rest_id").filter(|value| !value.is_null()) {
        Some(id) => js::s(Some(id)),
        None => format!("rest:{}", js::string(r.command.get("command_id"))),
    };
    let kind = r.command.get("kind").cloned();
    let mut payload = Map::new();
    payload.insert("schema_version".into(), Value::from(REST_EVENT_SCHEMA_VERSION));
    payload.insert("policy_id".into(), Value::String(REST_POLICY_ID.into()));
    payload.insert("rest_id".into(), Value::String(slice_utf16(&rest_id, 180)));
    if let Some(kind) = &kind {
        payload.insert("kind".into(), kind.clone());
    }
    payload.insert("started_at_minutes".into(), Value::from(started_at_minutes));
    payload.insert("ended_at_minutes".into(), Value::Null);
    payload.insert("duration_minutes".into(), Value::from(0));
    let minimum = rest_minimum_minutes_for(&r.state, &js::s(r.command.get("actor_id")), &js::s(kind.as_ref()));
    payload.insert("minimum_duration_minutes".into(), Value::from(minimum));
    with_fingerprint(&mut payload, &r.command);
    let targets = actor_targets(&r.command);
    let event = event_from(&r.command, "RestStarted", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_schema(event, REST_EVENT_SCHEMA_VERSION));
    Ok(())
}

/// `SpendHitPointDie` (22646–22686).
pub fn spend_hit_point_die(r: &mut Resolve<'_>) -> Step {
    let actor_id = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let actor = player_actor(&r.state, Some(&actor_id)).cloned();
    let Some(pool) = hit_point_dice_pool_for_actor(&r.state, &js::s(Some(&actor_id))) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'die_size')").into());
    };
    let constitution = ability_modifier(actor.as_ref().and_then(|actor| actor.get("abilities")).and_then(|abilities| abilities.get("con")));
    let visibility = r.command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String("public".into()));
    let roll = r.dice.roll(&[Value::String(format!("1d{}", pool.die_size)), Value::String("short-rest-hit-point-die".into()), actor_id.clone(), visibility])?;
    let total = js::number(roll.get("total"));
    let healing_total = if sk_core::game::uses_2014(&r.state) {
        crate::tactical_geometry::js_max(0.0, total + constitution as f64)
    } else {
        crate::tactical_geometry::js_max(1.0, total + constitution as f64)
    };
    let hp_before = actor.as_ref().map(sk_core::game::actor_hp).unwrap_or(0) as f64;
    let hp_after = crate::tactical_geometry::js_min(actor_max_hp(actor.as_ref()) as f64, hp_before + healing_total);
    let pool_after = crate::rest::HitPointDicePool { spent: pool.spent + 1, ..pool };
    r.rolls.push(roll.clone());
    let mut payload = Map::new();
    payload.insert("schema_version".into(), Value::from(HIT_POINT_DIE_EVENT_SCHEMA_VERSION));
    payload.insert("policy_id".into(), Value::String(REST_POLICY_ID.into()));
    if let Some(rest_id) = r.command.get("rest_id") {
        payload.insert("rest_id".into(), rest_id.clone());
    }
    payload.insert("kind".into(), Value::String("short".into()));
    payload.insert("roll".into(), roll);
    payload.insert("formula".into(), Value::String(format!("1d{}{}", pool.die_size, signed(constitution))));
    payload.insert("constitution_modifier".into(), Value::from(constitution));
    payload.insert("healing_total".into(), js::num(healing_total));
    payload.insert("applied_healing".into(), js::num(hp_after - hp_before));
    payload.insert("hp_before".into(), js::num(hp_before));
    payload.insert("hp_after".into(), js::num(hp_after));
    payload.insert("pool_before".into(), pool.to_value());
    payload.insert("pool_after".into(), pool_after.to_value());
    with_fingerprint(&mut payload, &r.command);
    let targets = actor_targets(&r.command);
    let spent = event_from(&command_with_rules(&r.command, &[rule_ids::RESOURCE, rule_ids::HEALING]), "HitPointDieSpent", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_schema(spent, HIT_POINT_DIE_EVENT_SCHEMA_VERSION));
    r.events.push(event_from(
        &command_with_rules(&r.command, &[rule_ids::HEALING]),
        "HealingApplied",
        Some(json!({
            "requested_amount": js::num(healing_total),
            "applied_amount": js::num(hp_after - hp_before),
            "hp_before": js::num(hp_before),
            "hp_after": js::num(hp_after),
            "reason": "short-rest-hit-point-die",
        })),
        Some(&targets),
    ));
    Ok(())
}

/// `CompleteRest` (22687–22760).
pub fn complete_rest(r: &mut Resolve<'_>) -> Step {
    let actor_key = js::string(r.command.get("actor_id"));
    let mechanics = sk_core::game::mechanics(&r.state);
    let active_rest = mechanics.get("resting").and_then(|all| all.get(&actor_key)).cloned();
    let long = r.command.get("kind").and_then(Value::as_str) == Some("long");
    let targets = actor_targets(&r.command);
    let concentration = mechanics.get("concentration").and_then(|all| all.get(&actor_key)).filter(|value| js::truthy(Some(value))).cloned();
    if long {
        if let Some(concentration) = concentration {
            let mut payload = Map::new();
            payload.insert("reason".into(), Value::String("long-rest".into()));
            if let Some(effect_id) = concentration.get("effect_id") {
                payload.insert("effect_id".into(), effect_id.clone());
            }
            r.events.push(event_from(&command_with_rules(&r.command, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(Value::Object(payload)), Some(&targets)));
        }
    }
    let rest_id = active_rest.as_ref().and_then(|rest| rest.get("rest_id")).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    if long {
        let actor_id = js::s(r.command.get("actor_id"));
        if let Some(pool) = hit_point_dice_pool_for_actor(&r.state, &actor_id) {
            let restored = if sk_core::game::uses_2014(&r.state) { pool.spent.min((pool.maximum / 2).max(1)) } else { pool.spent };
            let pool_after = crate::rest::HitPointDicePool { spent: (pool.spent - restored).max(0), ..pool };
            let payload = json!({
                "schema_version": HIT_POINT_DIE_EVENT_SCHEMA_VERSION,
                "policy_id": REST_POLICY_ID,
                "rest_id": rest_id,
                "pool_before": pool.to_value(),
                "pool_after": pool_after.to_value(),
                "restored": restored,
            });
            let event = event_from(&command_with_rules(&r.command, &[rule_ids::RESOURCE]), "HitPointDiceRestored", Some(payload), Some(&targets));
            r.events.push(with_schema(event, HIT_POINT_DIE_EVENT_SCHEMA_VERSION));
        }
        let conditions = command_with_rules(&r.command, &[rule_ids::CONDITIONS]);
        let exhaustion = exhaustion_level_of(&r.state, &actor_key);
        if exhaustion > 0 {
            r.events.push(event_from(&conditions, "ConditionRemoved", Some(json!({ "condition": format!("exhaustion:{exhaustion}"), "reason": "long-rest" })), Some(&targets)));
            if exhaustion > 1 {
                r.events.push(event_from(
                    &conditions,
                    "ConditionAdded",
                    Some(json!({ "condition": format!("exhaustion:{}", exhaustion - 1), "exhaustion_level": exhaustion - 1, "duration": "until-removed", "reason": "long-rest" })),
                    Some(&targets),
                ));
            }
        }
        let maximum_bonus = hit_point_maximum_bonus_of(&r.state, &actor_key);
        if maximum_bonus > 0 {
            let resting = sk_core::game::find_actor(&r.state, &actor_id);
            let maximum_before = actor_max_hp(resting);
            let maximum_after = (maximum_before - maximum_bonus).max(1);
            let hp = resting.map(sk_core::game::actor_hp).unwrap_or(0);
            r.events.push(event_from(
                &conditions,
                "HitPointMaximumReduced",
                Some(json!({
                    "reason": "aid-expired",
                    "requested_amount": maximum_bonus,
                    "applied_amount": maximum_before - maximum_after,
                    "maximum_hp_before": maximum_before,
                    "maximum_hp_after": maximum_after,
                    "hp_before": hp,
                    "hp_after": hp.min(maximum_after),
                })),
                Some(&targets),
            ));
        }
    }
    let mut payload = Map::new();
    payload.insert("schema_version".into(), Value::from(REST_EVENT_SCHEMA_VERSION));
    payload.insert("policy_id".into(), Value::String(REST_POLICY_ID.into()));
    payload.insert("rest_id".into(), rest_id);
    if let Some(kind) = r.command.get("kind") {
        payload.insert("kind".into(), kind.clone());
    }
    payload.insert("started_at_minutes".into(), active_rest.as_ref().and_then(|rest| rest.get("started_at_minutes")).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    payload.insert("ended_at_minutes".into(), Value::from(world_minutes(&r.state)));
    let duration = if active_rest.as_ref().is_some_and(|rest| js::truthy(Some(rest))) { Value::from(elapsed_rest_minutes(&r.state, active_rest.as_ref())) } else { Value::Null };
    payload.insert("duration_minutes".into(), duration);
    with_fingerprint(&mut payload, &r.command);
    let event = event_from(&r.command, "RestCompleted", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_schema(event, REST_EVENT_SCHEMA_VERSION));
    Ok(())
}
