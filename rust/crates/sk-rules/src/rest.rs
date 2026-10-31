//! Отдых: минимум минут, кости хитов, прошедшее время отдыха. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 958 (`restMinimumMinutesFor`), 7993–8009
//! (`hitPointDicePoolForActor`, `elapsedRestMinutes`). Константы отдыха —
//! `crate::constants` (Р0).

use serde_json::{json, Value};
use sk_core::js;

use crate::conditions::at_path;
use crate::constants::{class_hit_point_die_size, REST_MINIMUM_MINUTES_LONG, REST_MINIMUM_MINUTES_SHORT};

/// `REST_MINIMUM_MINUTES[kind]`: `short`/`long`, прочее — `undefined`.
pub fn rest_minimum_minutes(kind: &str) -> Option<i64> {
    match kind {
        "short" => Some(REST_MINIMUM_MINUTES_SHORT),
        "long" => Some(REST_MINIMUM_MINUTES_LONG),
        _ => None,
    }
}

/// `restMinimumMinutesFor(state, actorId, kind)`: долгий отдых вида с
/// `long_rest_hours` 4–8 короче восьми часов.
pub fn rest_minimum_minutes_for(state: &Value, actor_id: &str, kind: &str) -> i64 {
    if kind != "long" {
        return REST_MINIMUM_MINUTES_SHORT;
    }
    let actor = sk_core::game::find_actor(state, actor_id);
    let hours = js::number(at_path(actor, &["speciesBenefits", "mechanics", "long_rest_hours"]));
    if hours.is_finite() && (4.0..8.0).contains(&hours) {
        (hours * 60.0).trunc() as i64
    } else {
        REST_MINIMUM_MINUTES_LONG
    }
}

/// Запас костей хитов героя.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HitPointDicePool {
    pub maximum: i64,
    pub spent: i64,
    pub die_size: i64,
}

impl HitPointDicePool {
    /// `{ schema_version: 1, maximum, spent, die_size }`.
    pub fn to_value(self) -> Value {
        json!({ "schema_version": 1, "maximum": self.maximum, "spent": self.spent, "die_size": self.die_size })
    }
}

/// `hitPointDicePoolForActor(state, actorId)`: только для героя отряда.
pub fn hit_point_dice_pool_for_actor(state: &Value, actor_id: &str) -> Option<HitPointDicePool> {
    let actor = state.get("players").and_then(Value::as_array)?.iter().find(|candidate| sk_core::game::actor_id(candidate) == actor_id)?;
    let maximum = js::safe_int(actor.get("level"), 1).clamp(1, 12);
    let stored = at_path(Some(state), &["mechanics", "hit_point_dice", actor_id]);
    let spent = js::safe_int(stored.and_then(|stored| stored.get("spent")), 0).clamp(0, maximum);
    let die_size = crate::tables::character_class_key(actor).and_then(|key| class_hit_point_die_size(&key)).unwrap_or(8);
    Some(HitPointDicePool { maximum, spent, die_size })
}

/// `elapsedRestMinutes(state, rest)`: минуты с начала отдыха.
pub fn elapsed_rest_minutes(state: &Value, rest: Option<&Value>) -> i64 {
    let now = js::safe_int(at_path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]), 0);
    let started = js::safe_int(rest.and_then(|rest| rest.get("started_at_minutes")), 0);
    (now - started).max(0)
}
