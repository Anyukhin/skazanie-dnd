//! Перенос `server/rules/actors.mjs`: запросы к участникам сцены — кто есть,
//! где стоит, жив ли, враг ли. Только чтение состояния, без костей и событий.

use serde_json::Value;
use sk_core::{js, Point};

use crate::rules_core::safe_integer;
use crate::support::{array, defined, prop};

/// `actorId(actor)`: `String(actor?.id ?? actor?.actor_id ?? '')`. Пустая
/// строка в `id` не уступает `actor_id` — уступают только `null` и отсутствие.
pub fn actor_id(actor: Option<&Value>) -> String {
    let id = defined(prop(actor, "id")).or_else(|| defined(prop(actor, "actor_id")));
    js::s(id)
}

/// `listActors(state)`: герои, прочие, противники; при повторе id остаётся
/// место первого вхождения, а карточка — последнего.
pub fn list_actors(state: Option<&Value>) -> Vec<&Value> {
    let players = array(prop(state, "players"));
    let actors = array(prop(state, "actors"));
    let enemies = array(prop(state, "enemies"));
    let mut order: Vec<(String, &Value)> = Vec::new();
    for actor in players.iter().chain(actors).chain(enemies) {
        let id = actor_id(Some(actor));
        if id.is_empty() {
            continue;
        }
        match order.iter_mut().find(|(known, _)| *known == id) {
            Some(slot) => slot.1 = actor,
            None => order.push((id, actor)),
        }
    }
    order.into_iter().map(|(_, actor)| actor).collect()
}

/// `findActor(state, id)`; `id` — уже приведённое `String(id ?? '')`.
pub fn find_actor<'a>(state: Option<&'a Value>, id: &str) -> Option<&'a Value> {
    list_actors(state).into_iter().find(|actor| actor_id(Some(actor)) == id)
}

/// `isEnemyActor(state, id)`.
pub fn is_enemy_actor(state: Option<&Value>, id: &str) -> bool {
    array(prop(state, "enemies")).iter().any(|enemy| actor_id(Some(enemy)) == id)
}

/// `isLivingActor(actor)`: есть, хиты больше нуля и не помечен `alive: false`.
pub fn is_living_actor(actor: Option<&Value>) -> bool {
    js::truthy(actor) && actor_hp(actor) > 0 && !js::is_false(prop(actor, "alive"))
}

/// `actorPosition(state, id)`: сохранённая позиция `mechanics.positions[id]`,
/// иначе координаты карточки; только безопасные целые.
pub fn actor_position(state: Option<&Value>, id: &str) -> Option<Point> {
    let actor = find_actor(state, id);
    let stored = prop(prop(prop(state, "mechanics"), "positions"), id);
    let coordinate = |key: &str| -> Option<i64> {
        // `Number(stored?.x ?? actor?.x)`: явный `null` в конце цепочки — 0.
        let raw = defined(prop(stored, key)).or_else(|| prop(actor, key));
        js::is_safe_integer_number(raw).then(|| js::number(raw) as i64)
    };
    Some(Point::new(coordinate("x")?, coordinate("y")?))
}

/// `actorHp(actor)`: `Math.max(0, safeInteger(actor?.hp, 0))`.
pub fn actor_hp(actor: Option<&Value>) -> i64 {
    safe_integer(prop(actor, "hp"), 0).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn later_lists_override_earlier_cards_but_keep_first_place() {
        let state = json!({
            "players": [{ "id": "a", "hp": 1 }, { "id": "b" }],
            "enemies": [{ "id": "a", "hp": 5 }, { "actor_id": "c" }],
        });
        let ids: Vec<String> = list_actors(Some(&state)).into_iter().map(|actor| actor_id(Some(actor))).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(find_actor(Some(&state), "a").map(|actor| actor_hp(Some(actor))), Some(5));
        assert!(is_enemy_actor(Some(&state), "c"));
        assert!(!is_enemy_actor(Some(&state), "b"));
        assert_eq!(actor_id(Some(&json!({ "id": "", "actor_id": "x" }))), "");
    }

    #[test]
    fn position_prefers_stored_mechanics() {
        let state = json!({
            "players": [{ "id": "a", "x": 1, "y": 2 }, { "id": "b", "x": null, "y": 4 }],
            "mechanics": { "positions": { "a": { "x": 7, "y": null } } },
        });
        assert_eq!(actor_position(Some(&state), "a"), Some(Point::new(7, 2)));
        assert_eq!(actor_position(Some(&state), "b"), Some(Point::new(0, 4)));
        assert_eq!(actor_position(Some(&state), "z"), None);
        assert!(is_living_actor(Some(&json!({ "hp": 3 }))));
        assert!(!is_living_actor(Some(&json!({ "hp": 3, "alive": false }))));
    }
}
