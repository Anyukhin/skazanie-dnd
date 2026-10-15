//! Цели и расстояния: рост существа, расстояние между существами, счётчик
//! спасбросков от смерти и умирающий герой, расстояние до проклятого рыцаря,
//! существо-цель заклинания (в том числе социальный NPC). Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `spellCreatureFor` (1695),
//! `creatureHeightFeet` (3997), `distanceBetweenActors` (4292),
//! `deathSaveTracker`, `isDeadHero`, `isDyingHero`, `isUnstableDyingHero`
//! (5110–5143; `objectiveWithinLimit` из того же диапазона — в
//! [`crate::core`]), `knightDistanceFeet` (8185).

use serde_json::{json, Value};
use sk_core::{game, js};
use sk_geometry::actor_footprint::footprint_size_for;

use crate::geometry::footprint::distance_between_actor_positions;
use crate::tactical_geometry::npc_positioning::{npc_combat_actor_for, npc_interaction_target_for_viewer, npc_placement_for};
use crate::tactical_geometry::actor_point;

/// Ключи `Object.prototype`, которые JS находит у таблицы-объекта.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `creatureHeightFeet(actor)`: рост в футах — явный (1–30) или по размеру.
///
/// Как в JS, размер с именем свойства `Object.prototype` (`constructor`…)
/// находит в таблице функцию; числом она — `NaN`.
pub fn creature_height_feet(actor: Option<&Value>) -> f64 {
    let field = |key: &str| actor.and_then(|actor| actor.get(key));
    let explicit = js::number(crate::core::coalesce(&[field("height_feet"), field("heightFeet")]));
    if explicit.is_finite() && explicit > 0.0 {
        return explicit.min(30.0).max(1.0);
    }
    let declared = crate::core::coalesce(&[field("size"), field("creature_size"), field("creatureSize")]).map_or_else(
        || match footprint_size_for(actor) {
            2 => "large".to_string(),
            3 => "huge".to_string(),
            4 => "gargantuan".to_string(),
            _ => "medium".to_string(),
        },
        |value| js::string(Some(value)),
    );
    match declared.to_lowercase().as_str() {
        "tiny" => 2.0,
        "small" => 4.0,
        "medium" => 6.0,
        "large" => 8.0,
        "huge" => 15.0,
        "gargantuan" => 25.0,
        other if OBJECT_PROTOTYPE_KEYS.contains(&other) => f64::NAN,
        _ => 6.0,
    }
}

/// `distanceBetweenActors(state, firstId, secondId)`: футы между площадями;
/// `None`, если кого-то нет на поле.
pub fn distance_between_actors(state: &Value, first_id: &str, second_id: &str) -> Option<f64> {
    let first = actor_point(state, first_id)?;
    let second = actor_point(state, second_id)?;
    distance_between_actor_positions(state, first_id, Some(first), second_id, Some(second))
}

/// Счётчик спасбросков от смерти (`deathSaveTracker`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeathSaveTracker {
    pub successes: i64,
    pub failures: i64,
    pub stable: bool,
}

impl DeathSaveTracker {
    pub fn to_value(self) -> Value {
        json!({ "successes": self.successes, "failures": self.failures, "stable": self.stable })
    }
}

/// `deathSaveTracker(state, id)`: успехи и провалы 0–2, стабилен ли.
pub fn death_save_tracker(state: &Value, id: &str) -> DeathSaveTracker {
    let tracker = js::path(state, &["mechanics", "death", "saving_throws"]).and_then(|all| all.get(id));
    let field = |key: &str| tracker.and_then(|tracker| tracker.get(key));
    DeathSaveTracker {
        successes: js::safe_int(field("successes"), 0).clamp(0, 2),
        failures: js::safe_int(field("failures"), 0).clamp(0, 2),
        stable: js::is_true(field("stable")),
    }
}

/// `isDeadHero(state, id)`.
pub fn is_dead_hero(state: &Value, id: &str) -> bool {
    js::path(state, &["mechanics", "death", "heroes"]).and_then(|heroes| heroes.get(id)).and_then(|hero| hero.get("status")).and_then(Value::as_str) == Some("dead")
}

/// `isDyingHero(state, id)`: герой на нуле хитов, ещё не погибший.
pub fn is_dying_hero(state: &Value, id: &str) -> bool {
    game::player_actor(state, id).is_some_and(|actor| game::actor_hp(actor) == 0) && !is_dead_hero(state, id)
}

/// `isUnstableDyingHero(state, id)`.
pub fn is_unstable_dying_hero(state: &Value, id: &str) -> bool {
    is_dying_hero(state, id) && !death_save_tracker(state, id).stable
}

/// `knightDistanceFeet(state, heroId, knightId)`: в бою — между фишками, вне
/// боя — до поста рыцаря на карте; `None` — кого-то нет на поле.
pub fn knight_distance_feet(state: &Value, hero_id: &str, knight_id: &str) -> Option<f64> {
    if game::find_actor(state, knight_id).is_some() {
        return distance_between_actors(state, hero_id, knight_id);
    }
    let post = npc_placement_for(state, knight_id, None)?;
    let at = actor_point(state, hero_id)?;
    let dx = (js::number(post.get("x")) - at.x).abs();
    let dy = (js::number(post.get("y")) - at.y).abs();
    Some(crate::tactical_geometry::js_max(dx, dy) * 5.0)
}

/// `spellCreatureFor(state, id, spell)`: существо-цель заклинания. Социальный
/// NPC остаётся в своём реестре: мирное касание не начинает бой — его
/// эффект адресуется прежнему устойчивому id (боевой снимок NPC).
pub fn spell_creature_for(state: &Value, id: &str, spell: &Value) -> Option<Value> {
    let actor = game::find_actor(state, id);
    let spell_id = spell.get("id");
    let verified_2014 = game::uses_2014(state)
        && sk_combat_content::combat_spells::canonical_combat_spell_for(spell_id, Some(&json!({ "rulesetId": "dnd_5e_2014" })))
            .is_some_and(|card| card.get("mechanicsSupport").and_then(Value::as_str) == Some("verified"));
    let id_text = js::s(spell_id);
    if actor.is_some() || !verified_2014 && !["longstrider", "mass-cure-wounds"].contains(&id_text.as_str()) {
        return actor.cloned();
    }
    npc_interaction_target_for_viewer(state, id).and_then(|_| npc_combat_actor_for(state, id))
}
