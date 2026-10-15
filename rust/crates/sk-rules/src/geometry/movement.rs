//! Перемещение: добровольный путь испуганного и под «Приказом», прыжок в
//! длину, проекция движения существа, время пути вне боя, разбег по прямой,
//! ранг размера по имени. Цена шага и пути — [`super::terrain`], скорость —
//! [`crate::speed`]. Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `assertVoluntaryMovementPath` (3883),
//! `longJumpMovementFor` (10230), `sizeRankByName` (10995),
//! `completedStraightCharge` (10999), `movementForActor` (11102),
//! `explorationMovementDurationSeconds` (11128). `ignoresDifficultTerrain`
//! (10940) — в [`crate::core`].

use serde_json::{json, Map, Value};
use sk_core::{game, js, RuleError};
use sk_geometry::Point;

use crate::geometry::footprint::{actor_footprint_fits, distance_between_actor_positions, FitOptions};
use crate::speed::{active_longstrider_conditions, effective_speed_feet, movement_bonus_feet, speed_zero_condition, world_time_seconds};
use crate::tactical_geometry::{
    actor_footprint_cells_at, actor_point, creature_size_rank, footprint_step_blocked, key_of, occupied_positions, point_json, points_json, prop_movement_positions, sign, Scene,
};

fn rule(code: &str, message: impl Into<String>) -> RuleError {
    RuleError::new(code, message)
}

/// `null` в сравнениях `<`, `>=` JS — это `0`.
fn relational(value: Option<f64>) -> f64 {
    value.unwrap_or(0.0)
}

/// `assertVoluntaryMovementPath(state, actorId, from, to, path)`: испуганный
/// не приближается к источнику страха ни на одном шаге; «Подойди» требует
/// приблизиться к заклинателю, «Убегай» — отдалиться.
pub fn assert_voluntary_movement_path(state: &Value, actor_id: &str, from: Point, to: Point, path: &[Point]) -> Result<(), RuleError> {
    let conditions = game::conditions(state, actor_id);
    let uses_2014 = game::uses_2014(state);
    let all_fears: Vec<&Value> = conditions
        .iter()
        .filter(|condition| {
            game::condition_id(condition) == "frightened" && js::truthy(condition.get("source_actor")) && (!uses_2014 || condition.get("spell_id").and_then(Value::as_str) != Some("phantasmal-killer"))
        })
        .collect();
    let fears: &[&Value] = if uses_2014 { &all_fears } else { &all_fears[..all_fears.len().min(1)] };
    let command_approach = conditions.iter().find(|condition| game::condition_id(condition) == "command:approach");
    let command_flee = conditions.iter().find(|condition| game::condition_id(condition) == "command:flee");
    let distance_to = |position: Point, source_actor: Option<&Value>| -> Option<f64> {
        let source_id = js::s(source_actor);
        let source = actor_point(state, &source_id)?;
        Some(distance_between_actor_positions(state, actor_id, Some(position), &source_id, Some(source)).unwrap_or(0.0) / 5.0)
    };
    for frightened in fears {
        let source = frightened.get("source_actor");
        let mut previous = distance_to(from, source);
        for step in path {
            let next = distance_to(*step, source);
            if let (Some(before), Some(after)) = (previous, next) {
                if after < before {
                    return Err(rule("FRIGHTENED_CLOSER", "Испуганное существо не может добровольно приблизиться к источнику страха"));
                }
            }
            previous = next;
        }
    }
    if let Some(approach) = command_approach {
        let source = approach.get("source_actor");
        if relational(distance_to(to, source)) >= relational(distance_to(from, source)) {
            return Err(rule("COMMAND_MOVEMENT_DIRECTION", "Приказ «Подойди» требует приблизиться к заклинателю"));
        }
    }
    if let Some(flee) = command_flee {
        let source = flee.get("source_actor");
        if relational(distance_to(to, source)) <= relational(distance_to(from, source)) {
            return Err(rule("COMMAND_MOVEMENT_DIRECTION", "Приказ «Убегай» требует отдалиться от заклинателя"));
        }
    }
    Ok(())
}

/// Прыжок в длину (`longJumpMovementFor`).
#[derive(Clone, Debug, PartialEq)]
pub struct LongJump {
    pub from: Point,
    pub to: Point,
    pub path: Vec<Point>,
    pub distance_feet: f64,
    pub maximum_jump_feet: f64,
    pub movement_spent: f64,
}

impl LongJump {
    /// Форма JS: `{ from, to, path, distanceFeet, maximumJumpFeet, movementSpent }`.
    pub fn to_value(&self) -> Value {
        json!({
            "from": point_json(self.from),
            "to": point_json(self.to),
            "path": points_json(&self.path),
            "distanceFeet": js::num(self.distance_feet),
            "maximumJumpFeet": js::num(self.maximum_jump_feet),
            "movementSpent": js::num(self.movement_spent),
        })
    }
}

/// `runLast.x === from.x`: строго число.
fn strict_number(value: Option<&Value>, expected: f64) -> bool {
    value.and_then(Value::as_f64) == Some(expected)
}

/// `longJumpMovementFor(state, actorId, destination, { runningStart, minimumDistanceFeet })`:
/// серверная проверка одной горизонтальной траектории прыжка в длину.
pub fn long_jump_movement_for(state: &Value, actor_id: &str, destination: Option<&Value>, running_start: bool, minimum_distance_feet: f64) -> Result<LongJump, RuleError> {
    let actor = game::find_actor(state, actor_id);
    let from = actor_point(state, actor_id);
    let to = Point::from_value(destination);
    let (Some(actor), Some(from)) = (actor, from) else {
        return Err(rule("MAP_POSITION_REQUIRED", "Для прыжка нужны герой и целевая клетка на карте"));
    };
    if !crate::tactical_geometry::is_safe(to.x) || !crate::tactical_geometry::is_safe(to.y) {
        return Err(rule("MAP_POSITION_REQUIRED", "Для прыжка нужны герой и целевая клетка на карте"));
    }
    let scene = Scene::new(state);
    let cells = scene.cells();
    let map = scene.map();
    let from_cell = scene.cell(from);
    let to_cell = scene.cell(to);
    let hidden = |cell: Option<&Value>| cell.is_none_or(|cell| js::is_false(cell.get("revealed")));
    if hidden(from_cell) {
        return Err(rule("JUMP_START_NOT_VISIBLE", "Герой находится в нераскрытой части карты"));
    }
    let occupied = occupied_positions(state, Some(actor_id), true);
    if !actor_footprint_fits(state, actor_id, from, FitOptions { map: Some(map), cells: Some(cells), occupied: Some(&occupied), ..FitOptions::default() }) {
        return Err(rule("JUMP_START_BLOCKED", "Тело прыгающего занимает недоступную площадь"));
    }
    if hidden(to_cell) {
        return Err(rule("JUMP_LANDING_NOT_VISIBLE", "Клетка приземления не раскрыта"));
    }
    if !actor_footprint_fits(state, actor_id, to, FitOptions { map: Some(map), cells: Some(cells), ..FitOptions::default() }) {
        return Err(rule("INVALID_DESTINATION", "В клетку приземления нельзя войти"));
    }
    let elevation = |cell: Option<&Value>| js::safe_int(cell.and_then(|cell| cell.get("elevation")), 0);
    let start_elevation = elevation(from_cell);
    if start_elevation != elevation(to_cell) {
        return Err(rule("JUMP_ELEVATION_UNSUPPORTED", "Горизонтальный прыжок между разными высотами пока не поддерживается"));
    }
    let economy = game::combat(state).get("action_economy").and_then(|all| all.get(actor_id));
    let movement_spent = js::safe_int(economy.and_then(|economy| economy.get("movement_spent")), 0).max(0) as f64;
    let movement_path = economy.and_then(|economy| economy.get("movement_path")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let tail: Vec<&Value> = movement_path.iter().rev().take(3).collect();
    let straight_run_up = match tail.as_slice() {
        [last, previous, before] if js::truthy(Some(last)) && js::truthy(Some(previous)) && js::truthy(Some(before)) => {
            let x = |point: &Value| js::number(point.get("x"));
            let y = |point: &Value| js::number(point.get("y"));
            strict_number(last.get("x"), from.x)
                && strict_number(last.get("y"), from.y)
                && x(last) - x(previous) == x(previous) - x(before)
                && y(last) - y(previous) == y(previous) - y(before)
                && (x(last) - x(previous)).abs() + (y(last) - y(previous)).abs() == 1.0
        }
        _ => false,
    };
    if running_start && (movement_spent < 10.0 || !straight_run_up) {
        return Err(rule("JUMP_RUNNING_START_REQUIRED", "Для прыжка с разбега сначала нужно потратить 10 фт на разбег"));
    }
    let strength = js::safe_int(js::path(actor, &["abilities", "str"]), 10).max(1) as f64;
    let maximum_jump_feet = if running_start { strength } else { (strength / 2.0).floor() };
    let speed = effective_speed_feet(state, actor, actor_id);
    let budget = (speed + movement_bonus_feet(state, actor_id, speed)) as f64 - movement_spent;
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if (dx != 0.0 && dy != 0.0) || (dx == 0.0 && dy == 0.0) {
        return Err(rule("JUMP_DIRECTION_UNSUPPORTED", "Прыжок должен идти по горизонтальной или вертикальной линии карты"));
    }
    let steps = dx.abs() + dy.abs();
    let distance_feet = steps * 5.0;
    if distance_feet < minimum_distance_feet || distance_feet > maximum_jump_feet {
        return Err(rule("JUMP_DISTANCE_EXCEEDED", format!("Длина прыжка ограничена {} фт", js::f64_string(maximum_jump_feet))));
    }
    if distance_feet > budget {
        return Err(rule("SPEED_EXCEEDED", "Недостаточно свободной скорости для прыжка"));
    }
    let prop_occupied = prop_movement_positions(map);
    let mut path = Vec::new();
    let mut previous = from;
    let mut index = 1.0;
    while index <= steps {
        let point = Point::new(from.x + sign(dx) * if dx == 0.0 { 0.0 } else { index }, from.y + sign(dy) * if dy == 0.0 { 0.0 } else { index });
        let footprint = actor_footprint_cells_at(state, actor_id, Some(point));
        let cell = scene.cell(point);
        let at = |entry: &Point| cells.get(&key_of(*entry)).copied();
        if hidden(cell) || footprint.iter().any(|entry| at(entry).is_some_and(|cell| js::is_false(cell.get("revealed")))) {
            return Err(rule("JUMP_PATH_NOT_VISIBLE", "Траектория прыжка проходит по нераскрытой клетке"));
        }
        if footprint.iter().any(|entry| elevation(at(entry)) != start_elevation) {
            return Err(rule("JUMP_ELEVATION_UNSUPPORTED", "Горизонтальный прыжок между разными высотами пока не поддерживается"));
        }
        if footprint.iter().any(|entry| js::string(at(entry).and_then(|cell| cell.get("type"))) == "wall") || footprint_step_blocked(map, Some(actor), previous, point) {
            return Err(rule("JUMP_PATH_BLOCKED", "Траекторию прыжка перекрывает стена или закрытая дверь"));
        }
        let options = FitOptions { map: Some(map), cells: Some(cells), occupied: Some(&occupied), prop_occupied: Some(&prop_occupied), ..FitOptions::default() };
        if !actor_footprint_fits(state, actor_id, point, options) {
            return Err(rule("JUMP_OCCUPIED", "Траектория или место приземления заняты"));
        }
        path.push(point);
        previous = point;
        index += 1.0;
    }
    Ok(LongJump { from, to, path, distance_feet, maximum_jump_feet, movement_spent: movement_spent + distance_feet })
}

/// `sizeRankByName(size)`: `creatureSizeRank({ size })`.
pub fn size_rank_by_name(size: Option<&Value>) -> i64 {
    let mut actor = Map::new();
    if let Some(size) = size {
        actor.insert("size".into(), size.clone());
    }
    creature_size_rank(Some(&Value::Object(actor)))
}

/// `completedStraightCharge(state, actorId, targetId, minimumDistanceFeet)`:
/// последние шаги хода — прямой разбег не короче минимума, и цель впереди по
/// тому же направлению.
pub fn completed_straight_charge(state: &Value, actor_id: &str, target_id: &str, minimum_distance_feet: Option<&Value>) -> bool {
    let economy = game::combat(state).get("action_economy").and_then(|all| all.get(actor_id));
    let points = economy.and_then(|economy| economy.get("movement_path")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let required_steps = ((js::safe_int(minimum_distance_feet, 20).max(5) as f64 / 5.0).ceil()).max(1.0) as usize;
    if points.len() < required_steps + 1 {
        return false;
    }
    let segment = &points[points.len() - (required_steps + 1)..];
    let coordinate = |index: usize, key: &str| js::number(segment.get(index).and_then(|point| point.get(key)));
    let dx = sign(coordinate(1, "x") - coordinate(0, "x"));
    let dy = sign(coordinate(1, "y") - coordinate(0, "y"));
    if dx == 0.0 && dy == 0.0 {
        return false;
    }
    for index in 1..segment.len() {
        if sign(coordinate(index, "x") - coordinate(index - 1, "x")) != dx || sign(coordinate(index, "y") - coordinate(index - 1, "y")) != dy {
            return false;
        }
    }
    let (Some(actor_at), Some(target_at)) = (actor_point(state, actor_id), actor_point(state, target_id)) else { return false };
    sign(target_at.x - actor_at.x) == dx && sign(target_at.y - actor_at.y) == dy
}

/// Подпись состояния нулевой скорости для `blocked_reason`.
fn blocked_label(condition: &str) -> &'static str {
    match condition {
        "grappled" => "захват",
        "restrained" => "опутывание",
        "paralyzed" => "паралич",
        "petrified" => "окаменение",
        "stunned" => "ошеломление",
        "surprised" => "внезапность",
        "unconscious" => "без сознания",
        "caltrops-speed-zero" => "калтропы",
        "rime-encased" => "лёд",
        "exhaustion:5" | "exhaustion:6" => "истощение",
        _ => "обездвиживание",
    }
}

/// `movementForActor(state, id)`: одна серверная проекция для движения,
/// планировщика и карты игрока.
pub fn movement_for_actor(state: &Value, id: &str) -> Value {
    let actor = game::find_actor(state, id).unwrap_or(&Value::Null);
    let current_speed = effective_speed_feet(state, actor, id);
    let combat = js::is_true(game::combat(state).get("active"));
    let spent = if combat { js::safe_int(js::path(game::combat(state), &["action_economy", id, "movement_spent"]), 0).max(0) } else { 0 };
    let bonus = if combat { movement_bonus_feet(state, id, current_speed) } else { 0 };
    let blocked = speed_zero_condition(state, id);
    let now = world_time_seconds(state);
    let effects: Vec<Value> = active_longstrider_conditions(state, id)
        .into_iter()
        .enumerate()
        .map(|(index, effect)| {
            let mut entry = Map::new();
            if let Some(effect_id) = effect.get("effect_id") {
                entry.insert("effect_id".into(), effect_id.clone());
            }
            entry.insert("spell_id".into(), Value::from("longstrider"));
            entry.insert("name".into(), Value::from("Скороход"));
            entry.insert("bonus_feet".into(), Value::from(10));
            entry.insert("applied".into(), Value::Bool(index == 0 && blocked.is_none()));
            if let Some(started) = effect.get("started_at_seconds") {
                entry.insert("started_at_seconds".into(), started.clone());
            }
            let expires = effect.get("expires_at_seconds").and_then(Value::as_f64).unwrap_or(f64::NAN);
            entry.insert("expires_at_seconds".into(), effect.get("expires_at_seconds").cloned().unwrap_or(Value::Null));
            entry.insert("remaining_seconds".into(), js::num(crate::tactical_geometry::js_max(0.0, expires - now)));
            Value::Object(entry)
        })
        .collect();
    let blocked_reason = match blocked {
        Some(condition) => Value::from(format!("Движение недоступно: {}", blocked_label(condition))),
        None if current_speed == 0 => Value::from("Скорость равна нулю"),
        None => Value::Null,
    };
    json!({
        "base_speed": js::safe_int(actor.get("speed"), 30).max(0),
        "current_speed": current_speed,
        "movement_spent": spent,
        "movement_bonus": bonus,
        "movement_remaining": if blocked.is_some() { 0 } else { (current_speed + bonus - spent).max(0) },
        "blocked_reason": blocked_reason,
        "effects": effects,
    })
}

/// Срок окончания условия в секундах для `explorationMovementDurationSeconds`:
/// `expires_at_seconds ?? (expires_at_minutes == null ? null : minutes * 60)`.
fn condition_deadline(condition: &Value) -> Option<f64> {
    match condition.get("expires_at_seconds").filter(|value| !value.is_null()) {
        Some(seconds) => seconds.as_f64(),
        None => condition.get("expires_at_minutes").filter(|value| !value.is_null()).map(|minutes| js::number(Some(minutes)) * 60.0),
    }
}

/// `explorationMovementDurationSeconds(state, id, costFeet)`: время пути вне
/// боя; истёкший посреди пути бонус не ускоряет остаток.
pub fn exploration_movement_duration_seconds(state: &Value, id: &str, cost_feet: f64) -> Result<f64, RuleError> {
    let mut remaining = crate::tactical_geometry::js_max(0.0, if crate::tactical_geometry::falsy(cost_feet) { 0.0 } else { cost_feet });
    let mut elapsed = 0.0f64;
    let start = world_time_seconds(state);
    let actor = game::find_actor(state, id).cloned().unwrap_or(Value::Null);
    let conditions = js::path(state, &["mechanics", "conditions", id]).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut deadlines: Vec<f64> = Vec::new();
    for condition in &conditions {
        if let Some(end) = condition_deadline(condition) {
            if end.is_finite() && end > start && !deadlines.contains(&end) {
                deadlines.push(end);
            }
        }
    }
    deadlines.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    deadlines.push(f64::INFINITY);
    let mut current = state.clone();
    for deadline in deadlines {
        let speed = effective_speed_feet(&current, &actor, id) as f64;
        if speed <= 0.0 {
            return Err(rule("SPEED_EXCEEDED", "Скорость не позволяет завершить путь"));
        }
        let seconds = remaining * 6.0 / speed;
        let span = deadline - start - elapsed;
        if seconds <= span {
            return Ok(js::round((elapsed + seconds) * 1000.0) / 1000.0);
        }
        remaining -= span * speed / 6.0;
        elapsed += span;
        current = state.clone();
        let minutes = (deadline / 60.0).floor();
        let kept: Vec<Value> = conditions
            .iter()
            .filter(|condition| {
                let seconds = condition.get("expires_at_seconds").filter(|value| !value.is_null());
                let minutes = condition.get("expires_at_minutes").filter(|value| !value.is_null());
                seconds.is_none_or(|value| js::number(Some(value)) > deadline) && minutes.is_none_or(|value| js::number(Some(value)) * 60.0 > deadline)
            })
            .cloned()
            .collect();
        let mechanics = sk_core::game::mechanics_mut(&mut current);
        mechanics.insert(
            "world_time".into(),
            json!({ "amount": js::num(minutes), "unit": "minute", "elapsed_minutes": js::num(minutes), "second_remainder": js::num(js::round((deadline % 60.0) * 1000.0) / 1000.0) }),
        );
        let all = mechanics.entry("conditions").or_insert_with(js::obj);
        if !all.is_object() {
            *all = js::obj();
        }
        if let Some(all) = all.as_object_mut() {
            all.insert(id.to_string(), Value::Array(kept));
        }
    }
    Ok(elapsed)
}
