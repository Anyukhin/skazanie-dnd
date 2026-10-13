//! Чтение и правка состояния кампании в JSON-форме JS-движка.
//!
//! Перенос `server/rules/actors.mjs` и общих помощников `rules-engine.mjs`:
//! кто есть в сцене, где стоит, жив ли, враг ли, какие на нём состояния.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

use crate::js::{is_true, obj, s, safe_int};
use crate::Point;

/// Идентификатор существа: `id`, иначе `actor_id`.
pub fn actor_id(actor: &Value) -> String {
    let id = s(actor.get("id"));
    if !id.is_empty() {
        return id;
    }
    s(actor.get("actor_id"))
}

fn list<'a>(state: &'a Value, key: &str) -> &'a [Value] {
    state.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Все участники: герои, прочие, противники; при повторе id побеждает последний.
pub fn list_actors(state: &Value) -> Vec<&Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_id: std::collections::HashMap<String, &Value> = std::collections::HashMap::new();
    for actor in list(state, "players").iter().chain(list(state, "actors")).chain(list(state, "enemies")) {
        let id = actor_id(actor);
        if id.is_empty() {
            continue;
        }
        if !by_id.contains_key(&id) {
            order.push(id.clone());
        }
        by_id.insert(id, actor);
    }
    order.into_iter().filter_map(|id| by_id.get(&id).copied()).collect()
}

/// `findActor(state, id)`.
pub fn find_actor<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    list_actors(state).into_iter().find(|actor| actor_id(actor) == id)
}

/// Изменяемая карточка: сначала противники (как в `byId` побеждает последний), потом прочие, потом герои.
pub fn find_actor_mut<'a>(state: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    for key in ["enemies", "actors", "players"] {
        let found = state.get(key).and_then(Value::as_array).and_then(|items| items.iter().position(|actor| actor_id(actor) == id));
        if let Some(index) = found {
            return state.get_mut(key).and_then(Value::as_array_mut).and_then(|items| items.get_mut(index));
        }
    }
    None
}

/// `replaceActor(state, id, updater)`: правит карточку с этим id во всех трёх списках.
pub fn replace_actor(state: &mut Value, id: &str, mut update: impl FnMut(&mut Value)) {
    for key in ["players", "actors", "enemies"] {
        if let Some(items) = state.get_mut(key).and_then(Value::as_array_mut) {
            for actor in items.iter_mut() {
                if actor_id(actor) == id {
                    update(actor);
                }
            }
        }
    }
}

/// `isEnemyActor(state, id)`.
pub fn is_enemy_actor(state: &Value, id: &str) -> bool {
    list(state, "enemies").iter().any(|enemy| actor_id(enemy) == id)
}

/// `playerActor(state, id)`.
pub fn player_actor<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    list(state, "players").iter().find(|player| s(player.get("id")) == id)
}

/// `actorHp(actor)`.
pub fn actor_hp(actor: &Value) -> i64 {
    safe_int(actor.get("hp"), 0).max(0)
}

/// `actorMaxHp(actor)`: `maxHp ?? max_hp`, не меньше 1.
pub fn actor_max_hp(actor: &Value) -> i64 {
    let raw = actor.get("maxHp").filter(|value| !value.is_null()).or_else(|| actor.get("max_hp"));
    safe_int(raw, 1).max(1)
}

/// `isLivingActor(actor)`.
pub fn is_living_actor(actor: &Value) -> bool {
    actor_hp(actor) > 0 && actor.get("alive") != Some(&Value::Bool(false))
}

/// `actorPosition(state, id)`.
pub fn actor_position(state: &Value, id: &str) -> Option<Point> {
    let actor = find_actor(state, id);
    let stored = state.get("mechanics").and_then(|m| m.get("positions")).and_then(|p| p.get(id));
    let pick = |key: &str| -> Option<i64> {
        let value = stored.and_then(|p| p.get(key)).filter(|v| !v.is_null()).or_else(|| actor.and_then(|a| a.get(key)).filter(|v| !v.is_null()))?;
        let number = match value {
            Value::Number(number) => number.as_f64()?,
            Value::String(text) => text.trim().parse::<f64>().ok()?,
            Value::Bool(flag) => f64::from(u8::from(*flag)),
            _ => return None,
        };
        (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
    };
    Some(Point::new(pick("x")?, pick("y")?))
}

/// Призванное существо отряда (`isPartySummon`).
pub fn is_party_summon(actor: &Value) -> bool {
    s(actor.get("kind")) == "summon" && s(actor.get("faction")) == "party" && (crate::js::truthy(actor.get("ownerId")) || crate::js::truthy(actor.get("owner_id")))
}

/// Враждебный призыв (`isHostileSummon`).
pub fn is_hostile_summon(actor: &Value) -> bool {
    s(actor.get("kind")) == "summon" && s(actor.get("faction")) == "hostile" && (crate::js::truthy(actor.get("ownerId")) || crate::js::truthy(actor.get("owner_id")))
}

/// `combatActorKind(state, id)`.
pub fn combat_actor_kind(state: &Value, id: &str) -> &'static str {
    if is_enemy_actor(state, id) {
        "enemy"
    } else if find_actor(state, id).is_some_and(is_party_summon) {
        "summon"
    } else {
        "player"
    }
}

/// Механика состояния (создаётся при отсутствии).
pub fn mechanics_mut(state: &mut Value) -> &mut Map<String, Value> {
    crate::js::object_mut(state, "mechanics")
}

pub fn mechanics(state: &Value) -> &Value {
    static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    state.get("mechanics").unwrap_or_else(|| EMPTY.get_or_init(obj))
}

/// Состояния существа: `mechanics.conditions[id]`.
pub fn conditions<'a>(state: &'a Value, id: &str) -> &'a [Value] {
    mechanics(state).get("conditions").and_then(|c| c.get(id)).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Изменяемый список состояний существа (создаётся пустым).
pub fn conditions_mut<'a>(state: &'a mut Value, id: &str) -> &'a mut Vec<Value> {
    let mechanics = state.as_object_mut().expect("состояние — объект").entry("mechanics").or_insert_with(obj);
    let all = crate::js::object_mut(mechanics, "conditions");
    let slot = all.entry(id.to_string()).or_insert_with(|| Value::Array(Vec::new()));
    if !slot.is_array() {
        *slot = Value::Array(Vec::new());
    }
    slot.as_array_mut().expect("массив")
}

/// Id условия: `condition?.id ?? condition`.
pub fn condition_id(condition: &Value) -> String {
    match condition {
        Value::Object(map) => s(map.get("id")),
        other => s(Some(other)),
    }
}

/// `conditionIdsFor(state, id)`.
pub fn condition_ids(state: &Value, id: &str) -> BTreeSet<String> {
    conditions(state, id).iter().map(condition_id).collect()
}

pub fn has_condition(state: &Value, id: &str, condition: &str) -> bool {
    conditions(state, id).iter().any(|entry| condition_id(entry) == condition)
}

/// Бой: `mechanics.combat`.
pub fn combat(state: &Value) -> &Value {
    static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    mechanics(state).get("combat").unwrap_or_else(|| EMPTY.get_or_init(obj))
}

pub fn combat_mut(state: &mut Value) -> &mut Value {
    let mechanics = state.as_object_mut().expect("состояние — объект").entry("mechanics").or_insert_with(obj);
    crate::js::object_mut(mechanics, "combat");
    mechanics.get_mut("combat").expect("бой")
}

pub fn combat_active(state: &Value) -> bool {
    is_true(combat(state).get("active"))
}

pub fn combat_round(state: &Value) -> i64 {
    safe_int(combat(state).get("round"), 0)
}

/// `state.state_version`.
pub fn state_version(state: &Value) -> i64 {
    safe_int(state.get("state_version"), 0)
}

/// Чей ход: `initiative[active_index].actor_id`.
pub fn active_actor(state: &Value) -> Option<String> {
    let combat = combat(state);
    let index = safe_int(combat.get("active_index"), -1);
    if index < 0 {
        return None;
    }
    combat.get("initiative").and_then(Value::as_array).and_then(|list| list.get(index as usize)).map(|entry| s(entry.get("actor_id")))
}

/// Ресурс существа `{ current, max }`.
pub fn resource_pool(state: &Value, id: &str, resource: &str) -> (i64, i64) {
    let pool = mechanics(state).get("resources").and_then(|r| r.get(id)).and_then(|p| p.get(resource));
    (safe_int(pool.and_then(|p| p.get("current")), 0), safe_int(pool.and_then(|p| p.get("max")), 0))
}

/// Модификатор характеристики существа.
pub fn ability_modifier(actor: &Value, ability: &str) -> i64 {
    let score = safe_int(actor.get("abilities").and_then(|a| a.get(ability)), 10);
    crate::json::ability_modifier(score)
}

/// Используется ли редакция 2014.
pub fn uses_2014(state: &Value) -> bool {
    let ruleset = s(state.get("ruleset_id"));
    ruleset.is_empty() || ruleset == "dnd_5e_2014"
}

/// Включено ли домашнее правило.
pub fn has_house_rule(state: &Value, rule: &str) -> bool {
    state.get("enabled_house_rules").and_then(Value::as_array).is_some_and(|rules| rules.iter().any(|entry| entry.as_str() == Some(rule)))
}
