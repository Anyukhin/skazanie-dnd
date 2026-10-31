//! Скорость существа. Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `effectiveSpeedFeet` (11090),
//! `activeLongstriderConditions` (11109), `movementBonusFeet` (11117),
//! `classSpeedBonusFeet` (12185). Штраф доспеха не по силе
//! (`armorStrengthSpeedPenalty`, 3760) и состояние нулевой скорости
//! (`speedZeroConditionFor`, 10930) — в [`crate::core`].

use serde_json::Value;
use sk_core::game::{condition_ids, is_enemy_actor};
use sk_core::js::{s, safe_int};

use crate::core::{armor_strength_speed_penalty, coalesce, speed_zero_condition_for};
use crate::tables::{character_class_key, condition_effect};

pub use crate::world_clock::world_time_seconds;

/// `speedZeroConditionFor(state, id)`.
pub fn speed_zero_condition(state: &Value, id: &str) -> Option<&'static str> {
    speed_zero_condition_for(state, id)
}

/// Категории надетой брони: `catalogItem(id)?.armor?.category ?? item.armor_profile?.category`.
fn equipped_armor_categories(actor: &Value) -> Vec<String> {
    actor
        .get("inventory")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("equipped") == Some(&Value::Bool(true)))
        .map(|item| {
            let catalog_id = coalesce(&[item.get("catalog_id"), item.get("catalogId")]);
            let from_catalog = sk_items::item_catalog::catalog_item(&s(catalog_id)).and_then(|entry| entry.get("armor")).and_then(|armor| armor.get("category"));
            let profile = item.get("armor_profile").and_then(|profile| profile.get("category"));
            s(coalesce(&[from_catalog, profile]))
        })
        .collect()
}

/// `classSpeedBonusFeet(actor)`: Быстрое передвижение варвара без тяжёлого
/// доспеха и Движение без доспехов монаха (без доспеха и щита).
pub fn class_speed_bonus_feet(actor: &Value) -> i64 {
    let level = safe_int(actor.get("level"), 1);
    let worn = equipped_armor_categories(actor);
    match character_class_key(actor).as_deref() {
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

/// `activeLongstriderConditions(state, id)`: действующие «Скороходы», новые
/// первыми (при равном начале — позже наложенный раньше).
pub fn active_longstrider_conditions<'a>(state: &'a Value, id: &str) -> Vec<&'a Value> {
    let now = world_time_seconds(state);
    let mut active: Vec<&Value> = sk_core::game::conditions(state, id)
        .iter()
        .filter(|condition| {
            condition.get("id").and_then(Value::as_str) == Some("longstrider") && condition.get("expires_at_seconds").and_then(Value::as_f64).is_some_and(|expires| expires > now)
        })
        .collect();
    active.reverse();
    let started = |condition: &Value| sk_core::js::number(condition.get("started_at_seconds"));
    active.sort_by(|left, right| {
        let difference = started(right) - started(left);
        difference.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    active
}

/// `effectiveSpeedFeet(state, actor, id)`: текущая скорость; база и уже
/// оплаченное движение никогда не переписываются. `actor` `null` — `Value::Null`.
pub fn effective_speed_feet(state: &Value, actor: &Value, id: &str) -> i64 {
    let conditions = condition_ids(state, id);
    if speed_zero_condition_for(state, id).is_some() {
        return 0;
    }
    let mut multiplier = 1.0f64;
    let mut flat = 0i64;
    for condition in &conditions {
        let Some(effect) = condition_effect(condition) else { continue };
        if let Some(factor) = effect.get("speedMultiplier").and_then(Value::as_f64) {
            multiplier *= factor;
        }
        flat += safe_int(effect.get("speedBonusFeet"), 0);
    }
    let base = safe_int(actor.get("speed"), 30).max(0) + if is_enemy_actor(state, id) { 0 } else { class_speed_bonus_feet(actor) };
    let ignores_penalty = sk_core::js::path(actor, &["speciesBenefits", "mechanics", "ignore_armor_speed_penalty"]) == Some(&Value::Bool(true));
    let penalty = if ignores_penalty { 0 } else { armor_strength_speed_penalty(Some(actor)) };
    // Повторные наложения одного заклинания не складываются.
    let longstrider = if active_longstrider_conditions(state, id).is_empty() { 0 } else { 10 };
    let speed = (((base + longstrider) as f64) * multiplier).floor() + flat as f64 - penalty as f64;
    speed.max(0.0) as i64
}

/// `movementBonusFeet(state, id, speed)`: старые события Рывка сохраняют
/// плоскую прибавку, новые — её источник (число Рывков).
pub fn movement_bonus_feet(state: &Value, id: &str, speed: i64) -> i64 {
    let economy = sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(id));
    let field = |key: &str| economy.and_then(|economy| economy.get(key));
    (safe_int(field("movement_bonus"), 0) - safe_int(field("dash_movement_credit"), 0)).max(0) + safe_int(field("dash_count"), 0).max(0) * speed
}
