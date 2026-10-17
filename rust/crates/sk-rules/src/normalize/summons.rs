//! Срок призывов: кто из призванных истёк к часу мира и какие события его
//! отпускают. Задача Р4б.
//!
//! JS: `server/rules-engine.mjs`, 1127–1207 (`hasSummonLifecycleVersion`,
//! `partySummonsForExpiry`, `summonIdsExpiredAt`, `expiredSummonsBetween`,
//! `summonExpiryEvents`).
//!
//! Удаление призыва, возврат облика и снятие концентрации в редьюсере
//! (23845–23964: `removeSummonedActor`, `restoreShape`,
//! `clearConcentrationEffect`) перенесены ветками редьюсера в
//! `reduce/conditions.rs` — второй копии здесь нет.

use serde_json::{json, Value};
use sk_core::game::{actor_id, is_hostile_summon, is_party_summon};
use sk_core::indexmap::IndexMap;
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::constants::SUMMON_LIFECYCLE_VERSION;
use crate::core::{command_with, command_with_rules, event_from};
use crate::world_clock::normalized_clock_seconds;

/// `value ?? fallback`.
fn nullish<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `hasSummonLifecycleVersion(value)`.
pub fn has_summon_lifecycle_version(value: &Value) -> bool {
    js::number(nullish(value.get("summon_lifecycle_version"), value.get("summonLifecycleVersion"))) == SUMMON_LIFECYCLE_VERSION as f64
}

/// `partySummonsForExpiry(state)`: призывы отряда, враждебные призывы и
/// призывы из стэшей этажей, без повторов id (первый побеждает).
pub fn party_summons_for_expiry(state: &Value) -> Vec<Value> {
    let list = |key: &str| state.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut all: Vec<Value> = list("actors").into_iter().filter(is_party_summon).collect();
    all.extend(list("enemies").into_iter().filter(is_hostile_summon));
    if let Some(Value::Object(stashes)) = state.get("levelEntities") {
        for (_, stash) in js::entries(stashes) {
            if let Some(Value::Array(summons)) = stash.get("summons") {
                all.extend(summons.iter().cloned());
            }
        }
    }
    let mut unique: IndexMap<String, Value> = IndexMap::new();
    for summon in all {
        let id = actor_id(&summon);
        if !id.is_empty() && !unique.contains_key(&id) {
            unique.insert(id, summon);
        }
    }
    unique.into_values().collect()
}

/// Срок призыва (`expires_at_seconds ?? expiresAtSeconds`), если он задан и конечен.
fn expires_at(summon: &Value) -> Option<f64> {
    if !has_summon_lifecycle_version(summon) {
        return None;
    }
    let raw = nullish(summon.get("expires_at_seconds"), summon.get("expiresAtSeconds"))?;
    let value = js::number(Some(raw));
    value.is_finite().then_some(value)
}

/// `summonIdsExpiredAt(state, nowSeconds)`.
pub fn summon_ids_expired_at(state: &Value, now_seconds: f64) -> Vec<String> {
    let now = normalized_clock_seconds(now_seconds);
    party_summons_for_expiry(state).iter().filter(|summon| expires_at(summon).is_some_and(|at| at <= now)).map(actor_id).collect()
}

/// `expiredSummonsBetween(state, beforeSeconds, afterSeconds)`.
pub fn expired_summons_between(state: &Value, before_seconds: f64, after_seconds: f64) -> Vec<Value> {
    let before = normalized_clock_seconds(before_seconds);
    let after = normalized_clock_seconds(after_seconds);
    if after <= before {
        return Vec::new();
    }
    party_summons_for_expiry(state).into_iter().filter(|summon| expires_at(summon).is_some_and(|at| at > before && at <= after)).collect()
}

fn owner_and_effect(summon: &Value) -> (String, String) {
    (js::s(nullish(summon.get("ownerId"), summon.get("owner_id"))), js::s(nullish(summon.get("sourceEffectId"), summon.get("source_effect_id"))))
}

/// `summonExpiryEvents(command, state, summons, withRules)`: отпуск истёкших
/// призывов и конец концентрации, если у владельца не осталось призывов того
/// же эффекта. `with_rules` — `commandWithRules` (иначе команда как есть).
pub fn summon_expiry_events(command: &Value, state: &Value, summons: &[Value], with_rules: bool) -> Vec<Value> {
    let rules = |command: &Value| if with_rules { command_with_rules(command, &[rule_ids::CONCENTRATION]) } else { command.clone() };
    let mut unique: IndexMap<String, &Value> = IndexMap::new();
    for summon in summons {
        let id = actor_id(summon);
        if !id.is_empty() && !unique.contains_key(&id) {
            unique.insert(id, summon);
        }
    }
    let mut drafts = Vec::new();
    for summon in unique.values() {
        drafts.push(event_from(
            &rules(command),
            "SummonedCreatureDismissed",
            Some(json!({ "reason": "duration_expired", "summon_lifecycle_version": SUMMON_LIFECYCLE_VERSION })),
            Some(&json!([actor_id(summon)])),
        ));
    }
    let remaining = party_summons_for_expiry(state);
    let mut effects: IndexMap<String, (String, String)> = IndexMap::new();
    for summon in unique.values() {
        let (owner, effect) = owner_and_effect(summon);
        let current = state.get("mechanics").and_then(|mechanics| mechanics.get("concentration")).and_then(|all| all.get(&owner)).and_then(|entry| entry.get("effect_id"));
        if owner.is_empty() || effect.is_empty() || js::s(current) != effect {
            continue;
        }
        let has_remaining = remaining.iter().any(|candidate| {
            let (candidate_owner, candidate_effect) = owner_and_effect(candidate);
            !unique.contains_key(&actor_id(candidate)) && candidate_owner == owner && candidate_effect == effect
        });
        if has_remaining {
            continue;
        }
        effects.insert(format!("{owner}:{effect}"), (owner, effect));
    }
    for (owner, effect) in effects.into_values() {
        let acting = command_with(command, "actor_id", Value::String(owner.clone()));
        drafts.push(event_from(
            &rules(&acting),
            "ConcentrationEnded",
            Some(json!({ "reason": "duration_expired", "effect_id": effect, "summon_lifecycle_version": SUMMON_LIFECYCLE_VERSION })),
            Some(&json!([owner])),
        ));
    }
    drafts
}
