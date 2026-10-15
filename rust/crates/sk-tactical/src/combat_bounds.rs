//! Перенос `server/combat-bounds.mjs`: бой в подрайоне большой карты
//! (`docs/tactical-map-plan.md`, 11.4) — прямоугольник вокруг участников с
//! запасом на манёвр. Выход за границу разрешён и расширяет её, а не
//! блокируется: невидимой стены быть не должно.
//!
//! Здесь же — помощники состояния, которые в JS живут в `rules-engine.mjs` и
//! `rules/tactical-geometry.mjs` и которых ждёт редьюсер `CombatStarted` и
//! `ActorMoved`: [`sync_combat_bounds`] (`syncCombatBounds`),
//! [`grow_combat_bounds`] (`growCombatBounds`) и карта сцены в состоянии —
//! [`scene_tactical_map`], [`ensure_scene_tactical_map`],
//! [`write_scene_tactical_map`]. Кэш разобранных карт JS (`WeakMap` по
//! объекту `scene.map`) здесь не повторён: карта разбирается заново, и на
//! выходе то же, потому что разобранная карта — неподвижная точка круга
//! «чтение → запись».

use serde_json::{json, Value};
use sk_core::{game, js};
use sk_geometry::actor_footprint::footprint_cells_for;

use crate::tactical_map::{
    cell_at, deserialize_tactical_map, legacy_cells_from_tactical_map, serialize_tactical_map, tactical_map_from_legacy_cells, Bounds,
    LegacyMapOptions, MapResult, TacticalMap,
};

/// Запас вокруг участников: два хода героя со скоростью 30 футов.
pub const COMBAT_BOUNDS_MARGIN_CELLS: i64 = 12;

fn clamp_to_map(bounds: Bounds, width: i64, height: i64) -> Bounds {
    let clamp = |value: i64, size: i64| value.min(size - 1).max(0);
    Bounds { min_x: clamp(bounds.min_x, width), min_y: clamp(bounds.min_y, height), max_x: clamp(bounds.max_x, width), max_y: clamp(bounds.max_y, height) }
}

/// `Number.isSafeInteger(Number(value))` — координата участника.
fn safe_coordinate(point: &Value, key: &str) -> Option<i64> {
    let number = js::number(point.as_object().and_then(|object| object.get(key)));
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

/// Целые точки участников из рыхлого JSON (`{ x, y }`), нецелые отброшены.
pub fn participant_points(participants: &[Value]) -> Vec<(i64, i64)> {
    participants.iter().filter_map(|point| Some((safe_coordinate(point, "x")?, safe_coordinate(point, "y")?))).collect()
}

/// `computeCombatBounds(map, participants, { margin })` по размеру карты:
/// `None`, если участников нет. `margin` — `None` значит
/// [`COMBAT_BOUNDS_MARGIN_CELLS`].
pub fn compute_combat_bounds_in(width: i64, height: i64, participants: &[(i64, i64)], margin: Option<i64>) -> Option<Bounds> {
    let (first, rest) = participants.split_first()?;
    let mut bounds = Bounds { min_x: first.0, min_y: first.1, max_x: first.0, max_y: first.1 };
    for (x, y) in rest {
        bounds.min_x = bounds.min_x.min(*x);
        bounds.min_y = bounds.min_y.min(*y);
        bounds.max_x = bounds.max_x.max(*x);
        bounds.max_y = bounds.max_y.max(*y);
    }
    let margin = margin.unwrap_or(COMBAT_BOUNDS_MARGIN_CELLS).max(0);
    Some(clamp_to_map(
        Bounds { min_x: bounds.min_x - margin, min_y: bounds.min_y - margin, max_x: bounds.max_x + margin, max_y: bounds.max_y + margin },
        width,
        height,
    ))
}

/// `computeCombatBounds(map, participants, { margin })`: участники — рыхлые
/// точки JSON.
pub fn compute_combat_bounds(map: &TacticalMap, participants: &[Value], margin: Option<i64>) -> Option<Bounds> {
    compute_combat_bounds_in(map.width, map.height, &participant_points(participants), margin)
}

/// `combatBoundsContain(bounds, x, y)`: без подрайона ограничений нет.
pub fn combat_bounds_contain(bounds: Option<&Bounds>, x: i64, y: i64) -> bool {
    bounds.is_none_or(|bounds| x >= bounds.min_x && x <= bounds.max_x && y >= bounds.min_y && y <= bounds.max_y)
}

/// `expandCombatBounds(map, bounds, x, y, { margin })` по размеру карты:
/// подрайон, включающий точку с тем же запасом.
pub fn expand_combat_bounds_in(width: i64, height: i64, bounds: Option<&Bounds>, x: i64, y: i64, margin: Option<i64>) -> Bounds {
    let margin = margin.unwrap_or(COMBAT_BOUNDS_MARGIN_CELLS).max(0);
    let Some(bounds) = bounds else {
        return clamp_to_map(Bounds { min_x: x - margin, min_y: y - margin, max_x: x + margin, max_y: y + margin }, width, height);
    };
    if combat_bounds_contain(Some(bounds), x, y) {
        return *bounds;
    }
    clamp_to_map(
        Bounds { min_x: bounds.min_x.min(x - margin), min_y: bounds.min_y.min(y - margin), max_x: bounds.max_x.max(x + margin), max_y: bounds.max_y.max(y + margin) },
        width,
        height,
    )
}

/// `expandCombatBounds(map, bounds, x, y, { margin })`.
pub fn expand_combat_bounds(map: &TacticalMap, bounds: Option<&Bounds>, x: i64, y: i64, margin: Option<i64>) -> Bounds {
    expand_combat_bounds_in(map.width, map.height, bounds, x, y, margin)
}

/// Охват подрайона (`combatBoundsCoverage`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CombatBoundsCoverage {
    pub cells: usize,
    pub passable: usize,
}

impl CombatBoundsCoverage {
    /// Форма JS: `{ cells, passable }`.
    pub fn to_json(&self) -> Value {
        json!({ "cells": self.cells, "passable": self.passable })
    }
}

/// `combatBoundsCoverage(map, bounds)`: сколько клеток подрайона существует и
/// сколько из них проходимо.
pub fn combat_bounds_coverage(map: &TacticalMap, bounds: Option<&Bounds>) -> CombatBoundsCoverage {
    let mut coverage = CombatBoundsCoverage::default();
    let Some(bounds) = bounds else { return coverage };
    for y in bounds.min_y..=bounds.max_y {
        for x in bounds.min_x..=bounds.max_x {
            let Some(cell) = cell_at(map, x, y) else { continue };
            coverage.cells += 1;
            if cell.passable {
                coverage.passable += 1;
            }
        }
    }
    coverage
}

/// `applyCombatBounds(map, participants, options)`: ставит подрайон на карту.
pub fn apply_combat_bounds<'m>(map: &'m mut TacticalMap, participants: &[Value], margin: Option<i64>) -> &'m mut TacticalMap {
    map.combat_bounds = compute_combat_bounds(map, participants, margin);
    map
}

/// `combatBoundsUseful` по размеру карты.
pub fn combat_bounds_useful_in(width: i64, height: i64) -> bool {
    let threshold = COMBAT_BOUNDS_MARGIN_CELLS * 2 + 4;
    width > threshold || height > threshold
}

/// `combatBoundsUseful(map)`: на маленькой карте подрайон бессмыслен.
pub fn combat_bounds_useful(map: &TacticalMap) -> bool {
    combat_bounds_useful_in(map.width, map.height)
}

// --- карта сцены в состоянии (rules-engine, rules/tactical-geometry) --------

/// `sceneTacticalMap(state)`: разобранная `state.scene.map`; повреждённая
/// карта — `None` (сцена живёт на старых клетках).
pub fn scene_tactical_map(state: &Value) -> Option<TacticalMap> {
    let raw = state.get("scene")?.as_object()?.get("map")?;
    if !raw.is_object() {
        return None;
    }
    deserialize_tactical_map(raw).ok()
}

/// `ensureSceneTacticalMap(state)`: карта сцены, а если её нет — собранная по
/// `scene.cells` (сохранённое до слоёв состояние); собранная записывается в
/// `scene.map`. Отказ сборки по клеткам — как исключение JS.
pub fn ensure_scene_tactical_map(state: &mut Value) -> MapResult<Option<TacticalMap>> {
    if !state.get("scene").is_some_and(Value::is_object) {
        return Ok(None);
    }
    if let Some(existing) = scene_tactical_map(state) {
        return Ok(Some(existing));
    }
    let scene = &state["scene"];
    let cells = match scene.get("cells") {
        Some(Value::Array(cells)) if !cells.is_empty() => cells.clone(),
        _ => return Ok(None),
    };
    let location = [scene.get("location_id"), scene.get("locationId")].into_iter().flatten().find(|value| !value.is_null());
    let location_id = js::s(location);
    let seed = js::s(state.get("worldMap").and_then(|world| world.get("seed")));
    let map = tactical_map_from_legacy_cells(&cells, &LegacyMapOptions { location_id: &location_id, seed: &seed, ..LegacyMapOptions::default() })?;
    let serialized = serialize_tactical_map(&map)?;
    if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
        scene.insert("map".into(), serialized);
    }
    Ok(Some(map))
}

/// `writeSceneTacticalMap(state, map)`: карта обратно в `scene.map` и
/// производная `scene.cells` (`syncSceneCells`).
pub fn write_scene_tactical_map(state: &mut Value, map: &TacticalMap) -> MapResult<()> {
    if !js::truthy(state.get("scene")) {
        return Ok(());
    }
    let serialized = serialize_tactical_map(map)?;
    if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
        scene.insert("map".into(), serialized);
        scene.insert("cells".into(), Value::Array(legacy_cells_from_tactical_map(map)));
    }
    Ok(())
}

/// `actorFootprintCellsAt(state, id, position)`: `position` — `None` значит
/// «не передана» (берётся позиция актёра), `Some(null)` — клетки по полям
/// самой карточки.
fn actor_footprint_cells_at(state: &Value, id: &str, position: Option<&Value>) -> Vec<(i64, i64)> {
    let actor = game::find_actor(state, id);
    let fallback = position.is_none().then(|| game::actor_position(state, id).map(|point| json!({ "x": point.x, "y": point.y }))).flatten();
    let anchor = match position {
        Some(position) => Some(position),
        None => fallback.as_ref(),
    };
    footprint_cells_for(actor, anchor).into_iter().map(|cell| (cell.x, cell.y)).collect()
}

/// `syncCombatBounds(state, actorIds)`: подрайон вокруг участников при начале
/// боя. На маленькой карте не ставится. `actor_ids` — уже `String(id)`.
pub fn sync_combat_bounds(state: &mut Value, actor_ids: &[String]) -> MapResult<()> {
    let Some(mut map) = ensure_scene_tactical_map(state)? else { return Ok(()) };
    if !combat_bounds_useful(&map) {
        return Ok(());
    }
    let points: Vec<(i64, i64)> = actor_ids.iter().flat_map(|id| actor_footprint_cells_at(state, id, None)).collect();
    if points.is_empty() {
        return Ok(());
    }
    map.combat_bounds = compute_combat_bounds_in(map.width, map.height, &points, None);
    write_scene_tactical_map(state, &map)
}

/// `growCombatBounds(state, position, actorId)`: раздвигает подрайон, если
/// участник вышел за границу. `position` — `payload.to` как есть (`None` —
/// поля нет); `actor_id` — пустой или `None` значит «точка без актёра».
pub fn grow_combat_bounds(state: &mut Value, position: Option<&Value>, actor_id: Option<&str>) -> MapResult<()> {
    let points: Vec<(i64, i64)> = match actor_id.filter(|id| !id.is_empty()) {
        Some(id) => actor_footprint_cells_at(state, id, position),
        None => {
            let x = js::number(position.and_then(Value::as_object).and_then(|point| point.get("x")));
            let y = js::number(position.and_then(Value::as_object).and_then(|point| point.get("y")));
            let safe = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
            if !safe(x) || !safe(y) {
                return Ok(());
            }
            vec![(x as i64, y as i64)]
        }
    };
    if points.is_empty() {
        return Ok(());
    }
    if !js::truthy(js::path(state, &["mechanics", "combat", "active"])) {
        return Ok(());
    }
    let Some(mut map) = scene_tactical_map(state) else { return Ok(()) };
    if map.combat_bounds.is_none() {
        return Ok(());
    }
    for (x, y) in points {
        if combat_bounds_contain(map.combat_bounds.as_ref(), x, y) {
            continue;
        }
        map.combat_bounds = Some(expand_combat_bounds(&map, map.combat_bounds.as_ref(), x, y, None));
    }
    write_scene_tactical_map(state, &map)
}
