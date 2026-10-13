//! Скорость существа — перенос `effectiveSpeedFeet`, `movementBonusFeet`,
//! `classSpeedBonusFeet`, `armorStrengthSpeedPenalty`.

use serde_json::Value;
use sk_core::game::{conditions, is_enemy_actor};
use sk_core::js::{s, safe_int};

use crate::tables::{catalog_item, character_class_key, condition_effect, speed_zero_conditions};

/// `speedZeroConditionFor(state, id)`.
pub fn speed_zero_condition(state: &Value, id: &str) -> Option<&'static str> {
    let ids = sk_core::game::condition_ids(state, id);
    if ids.iter().any(|condition| condition_effect(condition).and_then(|effect| effect.get("immuneToSpeedZero")) == Some(&Value::Bool(true))) {
        return None;
    }
    speed_zero_conditions().into_iter().find(|condition| ids.contains(*condition))
}

fn equipped_armor_categories(actor: &Value) -> Vec<String> {
    actor
        .get("inventory")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("equipped") == Some(&Value::Bool(true)))
        .map(|item| {
            let catalog_id = item.get("catalog_id").filter(|v| !v.is_null()).or_else(|| item.get("catalogId"));
            let from_catalog = catalog_item(&s(catalog_id)).and_then(|entry| entry.get("armor")).and_then(|armor| armor.get("category")).filter(|v| !v.is_null());
            s(from_catalog.or_else(|| item.get("armor_profile").and_then(|profile| profile.get("category"))))
        })
        .collect()
}

/// `classSpeedBonusFeet(actor)`.
pub fn class_speed_bonus_feet(actor: &Value) -> i64 {
    let level = safe_int(actor.get("level"), 1);
    let worn = equipped_armor_categories(actor);
    match character_class_key(actor) {
        Some("barbarian") if level >= 5 && !worn.iter().any(|category| category == "heavy") => 10,
        Some("monk") if level >= 2 && !worn.iter().any(|category| matches!(category.as_str(), "light" | "medium" | "heavy" | "shield")) => {
            if level >= 18 {
                30
            } else if level >= 14 {
                25
            } else if level >= 10 {
                20
            } else if level >= 6 {
                15
            } else {
                10
            }
        }
        _ => 0,
    }
}

/// `armorStrengthSpeedPenalty(actor)`: −10 футов в доспехе не по силе.
pub fn armor_strength_speed_penalty(actor: &Value) -> i64 {
    let strength = safe_int(actor.get("abilities").and_then(|abilities| abilities.get("str")), 10);
    let heavy = actor.get("inventory").and_then(Value::as_array).into_iter().flatten().any(|item| {
        if !sk_core::js::truthy(item.get("equipped")) {
            return false;
        }
        let catalog_id = item.get("catalog_id").filter(|v| !v.is_null()).or_else(|| item.get("catalogId"));
        let armor = catalog_item(&s(catalog_id)).and_then(|entry| entry.get("equip")).and_then(|equip| equip.get("armor"));
        armor.is_some_and(|armor| s(armor.get("kind")) == "armor" && strength < safe_int(armor.get("strengthRequirement"), 0))
    });
    if heavy { 10 } else { 0 }
}

pub use crate::world_clock::world_time_seconds;

fn active_longstrider(state: &Value, id: &str) -> bool {
    let now = world_time_seconds(state);
    conditions(state, id).iter().any(|condition| s(condition.get("id")) == "longstrider" && condition.get("expires_at_seconds").and_then(Value::as_f64).is_some_and(|expires| expires.is_finite() && expires > now))
}

/// `effectiveSpeedFeet(state, actor, id)`.
pub fn effective_speed_feet(state: &Value, actor: &Value, id: &str) -> i64 {
    if speed_zero_condition(state, id).is_some() {
        return 0;
    }
    let mut multiplier = 1.0f64;
    let mut flat = 0i64;
    for condition in sk_core::game::condition_ids(state, id) {
        let Some(effect) = condition_effect(&condition) else { continue };
        if let Some(factor) = effect.get("speedMultiplier").and_then(Value::as_f64) {
            multiplier *= factor;
        }
        flat += safe_int(effect.get("speedBonusFeet"), 0);
    }
    let base = safe_int(actor.get("speed"), 30).max(0) + if is_enemy_actor(state, id) { 0 } else { class_speed_bonus_feet(actor) };
    let ignores_penalty = actor.get("speciesBenefits").and_then(|b| b.get("mechanics")).and_then(|m| m.get("ignore_armor_speed_penalty")) == Some(&Value::Bool(true));
    let penalty = if ignores_penalty { 0 } else { armor_strength_speed_penalty(actor) };
    let longstrider = if active_longstrider(state, id) { 10 } else { 0 };
    (((base + longstrider) as f64 * multiplier).floor() as i64 + flat - penalty).max(0)
}

/// `movementBonusFeet(state, id, speed)`.
pub fn movement_bonus_feet(state: &Value, id: &str, speed: i64) -> i64 {
    let economy = sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(id)).cloned().unwrap_or(Value::Null);
    (safe_int(economy.get("movement_bonus"), 0) - safe_int(economy.get("dash_movement_credit"), 0)).max(0) + safe_int(economy.get("dash_count"), 0).max(0) * speed
}
