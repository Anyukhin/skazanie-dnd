//! Вынужденное перемещение — толчок от источника, притягивание к нему,
//! случайный шаг, самая далёкая безопасная клетка — и траектория между
//! площадями существ и до точки. Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `forcedPushPath` (2992), `forcedPullPath`
//! (3021), `forcedRandomStepPath` (3046), `forcedMovementSizeAllowed` (3060),
//! `farthestSafeDestinationAwayFrom` (3064), `hasClearActorTrajectory`,
//! `assertClearActorTrajectory`, `hasClearActorToPoint`,
//! `assertClearActorToPoint` (3765–3786).

use serde_json::Value;
use sk_core::{game, js, text, RuleError};
use sk_geometry::actor_footprint::cells_distance_feet;
use sk_geometry::{GridCell, Point};

use crate::areas::shape::active_area_effects_at_in;
use crate::geometry::footprint::{actor_footprint_fits, FitOptions};
use crate::geometry::movement::size_rank_by_name;
use crate::tactical_geometry::{
    actor_point, actor_trajectory_details_in, creature_size_rank, falsy, footprint_cells, footprint_step_blocked, is_safe, js_max, key_of, occupied_positions, position_key,
    prop_movement_positions, sign, trajectory_details_in, KeySet, Scene,
};

/// Число шагов вынужденного перемещения: `Math.floor(max(0, Number(feet) || 0) / 5)`.
fn forced_steps(distance_feet: f64) -> f64 {
    (js_max(0.0, if falsy(distance_feet) { 0.0 } else { distance_feet }) / 5.0).floor()
}

/// Общие данные шага: клетки, карта, занятость.
struct Mover<'a> {
    scene: Scene<'a>,
    occupied: KeySet,
    prop_occupied: KeySet,
    id: &'a str,
}

impl<'a> Mover<'a> {
    fn new(state: &'a Value, id: &'a str) -> Self {
        let scene = Scene::new(state);
        let prop_occupied = if scene.map().is_some() { prop_movement_positions(scene.map()) } else { KeySet::new() };
        Self { occupied: occupied_positions(state, Some(id), true), prop_occupied, scene, id }
    }

    /// Можно ли встать на `next`, придя с `from`.
    fn can_step(&self, from: Point, next: Point) -> bool {
        let state = self.scene.state;
        let options = FitOptions { map: Some(self.scene.map()), cells: Some(self.scene.cells()), occupied: Some(&self.occupied), prop_occupied: Some(&self.prop_occupied), allow_occupied: false };
        if !actor_footprint_fits(state, self.id, next, options) {
            return false;
        }
        !(self.scene.map().is_some() && footprint_step_blocked(self.scene.map(), game::find_actor(state, self.id), from, next))
    }
}

/// `forcedPushPath(state, moverId, origin, distanceFeet)`: толчок от
/// источника по большей оси, пока клетка свободна.
pub fn forced_push_path(state: &Value, mover_id: &str, origin: Option<Point>, distance_feet: f64) -> Vec<Point> {
    let (Some(from), Some(origin)) = (actor_point(state, mover_id), origin) else { return Vec::new() };
    let dx = from.x - origin.x;
    let dy = from.y - origin.y;
    if falsy(dx) && falsy(dy) {
        return Vec::new();
    }
    let step = if dx.abs() >= dy.abs() { Point::new(sign(dx), 0.0) } else { Point::new(0.0, sign(dy)) };
    let mover = Mover::new(state, mover_id);
    let mut path = Vec::new();
    let mut cursor = from;
    let steps = forced_steps(distance_feet);
    let mut index = 0.0;
    while index < steps {
        let next = Point::new(cursor.x + step.x, cursor.y + step.y);
        if !mover.can_step(cursor, next) {
            break;
        }
        path.push(next);
        cursor = next;
        index += 1.0;
    }
    path
}

/// `forcedPullPath(state, moverId, origin, distanceFeet)`: притягивание по
/// прямой к источнику («Терновый кнут», «Лассо молнии»), пока не окажется рядом.
pub fn forced_pull_path(state: &Value, mover_id: &str, origin: Option<Point>, distance_feet: f64) -> Vec<Point> {
    let (Some(from), Some(origin)) = (actor_point(state, mover_id), origin) else { return Vec::new() };
    let mover = Mover::new(state, mover_id);
    let mut path = Vec::new();
    let mut cursor = from;
    let steps = forced_steps(distance_feet);
    let mut index = 0.0;
    while index < steps {
        let dx = origin.x - cursor.x;
        let dy = origin.y - cursor.y;
        if js_max(dx.abs(), dy.abs()) <= 1.0 {
            break;
        }
        let next = if dx.abs() >= dy.abs() { Point::new(cursor.x + sign(dx), cursor.y) } else { Point::new(cursor.x, cursor.y + sign(dy)) };
        if !mover.can_step(cursor, next) {
            break;
        }
        path.push(next);
        cursor = next;
        index += 1.0;
    }
    path
}

/// `forcedRandomStepPath(state, moverId, directionRoll)`: случайный шаг
/// «Нашествия» — к4: север, юг, восток, запад; занятая клетка — без шага.
pub fn forced_random_step_path(state: &Value, mover_id: &str, direction_roll: Option<&Value>) -> Vec<Point> {
    let Some(from) = actor_point(state, mover_id) else { return Vec::new() };
    let steps = [(0.0, -1.0), (0.0, 1.0), (1.0, 0.0), (-1.0, 0.0)];
    let (dx, dy) = steps[(js::safe_int(direction_roll, 1).clamp(1, 4) - 1) as usize];
    let next = Point::new(from.x + dx, from.y + dy);
    if Mover::new(state, mover_id).can_step(from, next) {
        vec![next]
    } else {
        Vec::new()
    }
}

/// `forcedMovementSizeAllowed(spell, target)`: размер цели допускает
/// принудительное перемещение заклинанием.
pub fn forced_movement_size_allowed(spell: &Value, target: Option<&Value>) -> bool {
    let maximum = spell.get("forcedMovementMaxSize");
    !js::truthy(maximum) || creature_size_rank(target) <= size_rank_by_name(maximum)
}

/// Самая далёкая безопасная клетка: `{ position, path }`.
#[derive(Clone, Debug, PartialEq)]
pub struct SafeDestination {
    pub position: Point,
    pub path: Vec<Point>,
}

/// `farthestSafeDestinationAwayFrom(state, moverId, origin, distanceFeet)`:
/// обход в ширину на `distanceFeet`, в обход опасных областей (кроме
/// «Смазки»); побеждает дальняя от источника, затем длинный путь, затем ключ
/// клетки по `localeCompare`.
pub fn farthest_safe_destination_away_from(state: &Value, mover_id: &str, origin: Option<Point>, distance_feet: f64) -> Option<SafeDestination> {
    let from = actor_point(state, mover_id)?;
    let origin = origin?;
    let mover = Mover::new(state, mover_id);
    let maximum_steps = forced_steps(distance_feet);
    let mut queue = vec![SafeDestination { position: from, path: Vec::new() }];
    let mut visited: KeySet = KeySet::from([key_of(from)]);
    let mut cursor = 0;
    let actor = game::find_actor(state, mover_id);
    while cursor < queue.len() {
        let current = queue[cursor].clone();
        cursor += 1;
        if current.path.len() as f64 >= maximum_steps {
            continue;
        }
        let p = current.position;
        for next in [Point::new(p.x + 1.0, p.y), Point::new(p.x - 1.0, p.y), Point::new(p.x, p.y + 1.0), Point::new(p.x, p.y - 1.0)] {
            let key = key_of(next);
            if visited.contains(&key) || !mover.can_step(current.position, next) {
                continue;
            }
            if active_area_effects_at_in(&mover.scene, Some(next), actor).into_iter().any(|effect| js::truthy(effect.get("condition")) && effect.get("spell_id").and_then(Value::as_str) != Some("grease")) {
                continue;
            }
            visited.insert(key);
            let mut path = current.path.clone();
            path.push(next);
            queue.push(SafeDestination { position: next, path });
        }
    }
    let origin_cells: Vec<GridCell> = if is_safe(origin.x) && is_safe(origin.y) { vec![GridCell::new(origin.x as i64, origin.y as i64)] } else { Vec::new() };
    let distance_from_origin = |position: Point| -> f64 {
        let cells: Vec<GridCell> = footprint_cells(actor, Some(position)).into_iter().map(|cell| GridCell::new(cell.x as i64, cell.y as i64)).collect();
        cells_distance_feet(&cells, &origin_cells).unwrap_or(0.0) / 5.0
    };
    let mut candidates: Vec<(f64, SafeDestination)> = queue.into_iter().map(|entry| (distance_from_origin(entry.position), entry)).collect();
    candidates.sort_by(|(left_distance, left), (right_distance, right)| {
        let by_distance = right_distance - left_distance;
        if !falsy(by_distance) {
            return by_distance.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        let by_length = right.path.len() as i64 - left.path.len() as i64;
        if by_length != 0 {
            return by_length.cmp(&0);
        }
        text::locale_compare(&position_key(left.position), &position_key(right.position))
    });
    candidates.into_iter().next().map(|(_, entry)| entry)
}

/// `hasClearActorTrajectory(state, attackerId, targetId, from, to, options)`.
pub fn has_clear_actor_trajectory(state: &Value, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>, allow_hidden_target: bool) -> bool {
    actor_trajectory_details_in(&Scene::new(state), attacker_id, target_id, from, to, allow_hidden_target).iter().any(|entry| !entry.blocked)
}

const TRAJECTORY_BLOCKED_TEXT: &str = "Траекторию перекрывает стена или граница карты";

/// `assertClearActorTrajectory(state, attackerId, targetId, from, to, options)`:
/// первая свободная линия между площадями.
pub fn assert_clear_actor_trajectory(state: &Value, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>, allow_hidden_target: bool) -> Result<Vec<Point>, RuleError> {
    actor_trajectory_details_in(&Scene::new(state), attacker_id, target_id, from, to, allow_hidden_target)
        .into_iter()
        .find(|entry| !entry.blocked)
        .map(|entry| entry.trajectory)
        .ok_or_else(|| RuleError::new("TRAJECTORY_BLOCKED", TRAJECTORY_BLOCKED_TEXT))
}

/// `hasClearActorToPoint(state, actorId, from, to)`: свободна ли линия хотя
/// бы от одной клетки площади до точки.
pub fn has_clear_actor_to_point(state: &Value, actor_id: &str, from: Option<Point>, to: Point) -> bool {
    let scene = Scene::new(state);
    footprint_cells(game::find_actor(state, actor_id), from).into_iter().any(|start| !trajectory_details_in(&scene, start, to).blocked)
}

/// `assertClearActorToPoint(state, actorId, from, to)`.
pub fn assert_clear_actor_to_point(state: &Value, actor_id: &str, from: Option<Point>, to: Point) -> Result<Vec<Point>, RuleError> {
    let scene = Scene::new(state);
    footprint_cells(game::find_actor(state, actor_id), from)
        .into_iter()
        .map(|start| trajectory_details_in(&scene, start, to))
        .find(|entry| !entry.blocked)
        .map(|entry| entry.trajectory)
        .ok_or_else(|| RuleError::new("TRAJECTORY_BLOCKED", TRAJECTORY_BLOCKED_TEXT))
}
