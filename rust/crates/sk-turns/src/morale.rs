//! Детерминированная часть морали NPC из `server/npc-controller.mjs`: момент
//! морали ([`is_morale_moment`]) и перевод решения в команды Rules Engine
//! ([`commands_for_morale_decision`]: `AddCondition`, `MoveActor`).
//!
//! Модели здесь нет — это ядро (урок 7 плана переноса, «агенты — отдельный
//! слой»). Роль модели `NpcMoraleAgent` живёт в `sk_agents::npc_controller`,
//! реэкспортирует эти функции и берёт отсюда общие признаки NPC (имя, хиты,
//! состояния, мораль главного противника).

use serde_json::{json, Value};
use sk_core::js;
use sk_geometry::Point;
use sk_rules::tactical_geometry::{shortest_tactical_path, PathOptions};
use sk_ruleset::rules_actors::{actor_position, find_actor, is_enemy_actor, is_living_actor};

/// Допустимые исходы морали.
pub const DISPOSITIONS: [&str; 3] = ["fight", "flee", "surrender"];
const FINAL_MORALE_CONDITIONS: [&str; 2] = ["fled", "surrendered"];

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

/// `Number(x) || fallback`.
pub fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}

/// `actor?.id ?? actor?.actor_id`, строкой.
pub fn actor_id(actor: Option<&Value>) -> String {
    js::s(coalesce(get(actor, "id"), get(actor, "actor_id")))
}

/// Состояния актора (`mechanics.conditions[id]`).
pub fn conditions_for<'a>(state: &'a Value, id: &str) -> &'a [Value] {
    match path(Some(state), &["mechanics", "conditions", id]) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `entry?.id ?? entry`, строкой.
pub fn condition_label(entry: &Value) -> String {
    js::string(coalesce(get(Some(entry), "id"), Some(entry)))
}

fn has_condition(state: &Value, id: &str, condition: &str) -> bool {
    conditions_for(state, id).iter().any(|entry| condition_label(entry) == condition)
}

/// `Math.max(0, Number(actor?.hp) || 0)`.
pub fn hp_of(actor: Option<&Value>) -> f64 {
    number_or(get(actor, "hp"), 0.0).max(0.0)
}

/// `Math.max(1, Number(maxHp ?? max_hp) || fallback)`.
pub fn max_hp_of(actor: Option<&Value>, fallback: f64) -> f64 {
    let value = js::number(coalesce(get(actor, "maxHp"), get(actor, "max_hp")));
    let value = if value == 0.0 || value.is_nan() { fallback } else { value };
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(1.0)
    }
}

/// Мораль главного противника сценария (`scenarioBossMorale`).
pub fn boss_morale(state: &Value, id: &str) -> Option<Value> {
    sk_scenario::campaign_scenario::scenario_boss_morale(state, id)
}

/// `isMoraleMoment(state, enemyId)`: живой враг на пороге морали, ещё не
/// проверенный и не сбежавший/сдавшийся.
pub fn is_morale_moment(state: &Value, enemy_id: &str) -> bool {
    let enemy = find_actor(Some(state), enemy_id);
    if enemy.is_none() || !is_enemy_actor(Some(state), enemy_id) || !is_living_actor(enemy) {
        return false;
    }
    if has_condition(state, enemy_id, "morale-tested") || FINAL_MORALE_CONDITIONS.iter().any(|condition| has_condition(state, enemy_id, condition)) {
        return false;
    }
    let hp = hp_of(enemy);
    let fallback = if hp == 0.0 { 1.0 } else { hp };
    let max_hp = max_hp_of(enemy, fallback);
    // Главный противник сценария проверяет мораль на своём пороге. Порог, не
    // ставший числом (`null` из `NaN`), сравнивается как `NaN` — ложь.
    let threshold = match boss_morale(state, enemy_id) {
        Some(morale) => match morale.get("threshold") {
            Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        },
        None => 0.3,
    };
    hp / max_hp <= threshold
}

fn farthest_reachable_destination(state: &Value, enemy_id: &str) -> Option<Point> {
    let enemy = find_actor(Some(state), enemy_id)?;
    let from = actor_position(Some(state), enemy_id)?;
    // Бюджет — футы, а не клетки: `MoveActor` берёт взвешенный путь.
    let budget = number_or(sk_rules::geometry::movement::movement_for_actor(state, enemy_id).get("movement_remaining"), 0.0).max(0.0);
    let maximum_steps = (budget / 5.0).floor();
    if maximum_steps == 0.0 {
        return None;
    }
    let cost = sk_rules::geometry::terrain::movement_step_cost_for(state, enemy_id, None);
    let map = cost.map();
    let step = |point: Point, path_map: Option<&_>| cost.step_cost_on(point, path_map);
    let heroes: Vec<(&Value, Value)> = match get(Some(state), "players") {
        Some(Value::Array(players)) => players
            .iter()
            .filter(|hero| is_living_actor(Some(hero)))
            .filter_map(|hero| actor_position(Some(state), &actor_id(Some(hero))).map(|at| (hero, json!({ "x": at.x, "y": at.y }))))
            .collect(),
        _ => Vec::new(),
    };
    let cells: &[Value] = match path(Some(state), &["scene", "cells"]) {
        Some(Value::Array(cells)) => cells,
        _ => &[],
    };
    let width = js::number(Some(coalesce(path(Some(state), &["scene", "grid", "width"]), None).unwrap_or(&Value::from(0))));
    let height = js::number(Some(coalesce(path(Some(state), &["scene", "grid", "height"]), None).unwrap_or(&Value::from(0))));
    let (fx, fy) = (from.x as f64, from.y as f64);
    let mut best: Option<(f64, Point)> = None;
    for cell in cells {
        let kind = get(Some(cell), "type");
        if !js::is_true(get(Some(cell), "revealed")) || !(matches!(kind, Some(Value::String(t)) if t == "floor" || t == "door")) {
            continue;
        }
        let (cx, cy) = (js::number(get(Some(cell), "x")), js::number(get(Some(cell), "y")));
        if !((cx - fx).abs() + (cy - fy).abs() <= maximum_steps) {
            continue;
        }
        let Some(route) = shortest_tactical_path(state, enemy_id, Point::new(cx, cy), PathOptions { tactical_map: Some(map), step_cost: Some(&step), ..PathOptions::default() }) else {
            continue;
        };
        if route.is_empty() || route.len() as f64 > maximum_steps {
            continue;
        }
        if route.iter().map(|point| step(*point, map)).sum::<f64>() > budget {
            continue;
        }
        let Some(destination) = route.last().copied() else { continue };
        let hero_distance = if heroes.is_empty() {
            route.len() as f64
        } else {
            let anchor = json!({ "x": js::num(destination.x), "y": js::num(destination.y) });
            heroes
                .iter()
                .map(|(hero, at)| sk_geometry::actor_footprint::footprint_distance_feet(Some(enemy), Some(hero), Some(&anchor), Some(at)).unwrap_or(9_007_199_254_740_991.0) / 5.0)
                .fold(f64::INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) })
        };
        let edge = [destination.x, destination.y, js_max0(width - 1.0 - destination.x), js_max0(height - 1.0 - destination.y)]
            .into_iter()
            .fold(f64::INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) });
        let score = hero_distance * 100.0 + route.len() as f64 * 4.0 - edge;
        if best.as_ref().is_none_or(|(best_score, _)| score > *best_score) {
            best = Some((score, destination));
        }
    }
    best.map(|(_, destination)| destination)
}

/// `commandsForMoraleDecision(state, enemyId, decision, ordinaryCommands)`:
/// решение морали — команды Rules Engine.
pub fn commands_for_morale_decision(state: &Value, enemy_id: &str, decision: Option<&Value>, ordinary_commands: Vec<Value>) -> Vec<Value> {
    let actor = enemy_id.to_string();
    let disposition = match get(decision, "disposition") {
        Some(Value::String(kind)) if DISPOSITIONS.contains(&kind.as_str()) => kind.as_str(),
        _ => return ordinary_commands,
    };
    let condition = |name: &str| json!({ "command_type": "AddCondition", "actor_id": actor, "target_id": actor, "condition": name });
    if disposition == "fight" {
        let mut commands = vec![condition("morale-tested")];
        commands.extend(ordinary_commands);
        return commands;
    }
    if disposition == "flee" && js::truthy(boss_morale(state, &actor).as_ref().and_then(|morale| morale.get("flies"))) {
        // Дракон улетает за горы: пути по клеткам ему не нужно.
        return vec![condition("fled")];
    }
    if disposition == "flee" {
        if let Some(destination) = farthest_reachable_destination(state, &actor) {
            return vec![
                json!({ "command_type": "MoveActor", "actor_id": actor, "to": { "x": js::num(destination.x), "y": js::num(destination.y) } }),
                condition("fled"),
            ];
        }
    }
    vec![condition("surrendered")]
}

/// `Math.max(0, value)` с `NaN`, как в JS.
fn js_max0(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(0.0)
    }
}
