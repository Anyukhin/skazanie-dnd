//! Границы боя и раскрытие клеток, размещение на входе сцены. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 2911–2957, 12206–12283.
//!
//! Подрайон боя (`syncCombatBounds`, `growCombatBounds`) перенесён в
//! `sk-tactical`; здесь — раскрытие клеток карты (`revealSceneCells`) и
//! расстановка отряда по заявленным клеткам (`acceptedPartyPlacementEntries`).
//! `syncSceneCells` (2293) и `footprintPlacementEdgesBlocked` — из Р1
//! (`scene_map_sync`, `tactical_geometry`).

use serde_json::Value;
use sk_core::game::{actor_id, find_actor};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;
use sk_core::RuleError;
use sk_geometry::actor_footprint::footprint_cells_for;
use sk_tactical::tactical_map::{cell_at, set_cell, CellPatch, TacticalMap, TacticalMapError};

use crate::core::unique_strings;

/// Отказ карты внутри ветки редьюсера — как исключение JS: событие дальше
/// этой точки не применяется.
pub fn map_error(error: TacticalMapError) -> RuleError {
    RuleError::new(&error.code, &error.message)
}

/// `positionKey(position)`: `${x},${y}`.
pub fn position_key(x: i64, y: i64) -> String {
    format!("{x},{y}")
}

/// Ключ клетки обратно в координаты: `key.split(',').map(Number)`.
pub fn key_point(key: &str) -> Value {
    let mut parts = key.split(',');
    let x = js::parse_number(parts.next().unwrap_or_default());
    let y = parts.next().map_or(f64::NAN, js::parse_number);
    let mut point = serde_json::Map::new();
    point.insert("x".into(), js::num(x));
    point.insert("y".into(), js::num(y));
    Value::Object(point)
}

/// `syncSceneCells(state)` (2293): `scene.cells` пересобирается из карты
/// сцены (`scene_map_sync`, Р1).
pub fn sync_scene_cells(state: &mut Value) {
    crate::scene_map_sync::sync_scene_cells(state, None);
}

/// `revealSceneCells(state, positions)` (2941): клетки помечаются раскрытыми
/// в карте; координата вне карты пропускается.
pub fn reveal_scene_cells(state: &mut Value, positions: &[Value]) -> Result<(), RuleError> {
    let Some(mut map) = sk_tactical::combat_bounds::ensure_scene_tactical_map(state).map_err(map_error)? else { return Ok(()) };
    let mut touched = false;
    for position in positions {
        let x = js::number(position.as_object().and_then(|point| point.get("x")));
        let y = js::number(position.as_object().and_then(|point| point.get("y")));
        if !crate::core::is_safe_integer_f64(x) || !crate::core::is_safe_integer_f64(y) {
            continue;
        }
        if set_cell(&mut map, x as i64, y as i64, &CellPatch { revealed: Some(true), ..CellPatch::default() }).is_ok() {
            touched = true;
        }
    }
    if touched {
        sk_tactical::combat_bounds::write_scene_tactical_map(state, &map).map_err(map_error)?;
    }
    Ok(())
}

/// `footprintPlacementEdgesBlocked(map, actor, anchor)` (`tactical_geometry`,
/// Р1) для якоря-JSON: стена или дверь внутри площади крупного существа.
pub fn footprint_placement_edges_blocked(map: Option<&TacticalMap>, actor: Option<&Value>, anchor: &Value) -> bool {
    let point = sk_geometry::Point::new(js::number(anchor.get("x")), js::number(anchor.get("y")));
    crate::tactical_geometry::footprint_placement_edges_blocked(map, actor, Some(point))
}

/// `sceneAdvancePartyIds(state)` (12206): отряд по `partyMemberIds`, только
/// живые карточки героев.
pub fn scene_advance_party_ids(state: &Value) -> Vec<String> {
    let players = state.get("players").and_then(Value::as_array).cloned().unwrap_or_default();
    let player_ids: IndexSet<String> = players.iter().map(actor_id).collect();
    let requested = match state.get("partyMemberIds") {
        Some(Value::Array(list)) if !list.is_empty() => unique_strings(Some(&Value::Array(list.clone()))),
        _ => player_ids.iter().cloned().collect(),
    };
    requested.into_iter().filter(|id| player_ids.contains(id)).collect()
}

/// Клетки сцены по ключу `x,y` (`new Map(cells.map((cell) => [positionKey(cell), cell]))`).
fn cells_by_key(cells: &[Value]) -> IndexMap<String, Value> {
    cells.iter().map(|cell| (format!("{},{}", js::string(cell.get("x")), js::string(cell.get("y"))), cell.clone())).collect()
}

/// `partyFootprintFits(actor, anchor, cellsByKey, map, occupied)` (12212).
fn party_footprint_fits(actor: Option<&Value>, anchor: &Value, cells: &IndexMap<String, Value>, map: Option<&TacticalMap>, occupied: &IndexSet<String>) -> bool {
    let footprint = footprint_cells_for(actor, Some(anchor));
    if footprint.is_empty() || footprint_placement_edges_blocked(map, actor, anchor) {
        return false;
    }
    footprint.iter().all(|cell| {
        let key = position_key(cell.x, cell.y);
        let Some(scene_cell) = cells.get(&key) else { return false };
        let kind = scene_cell.get("type").filter(|value| js::truthy(Some(value))).map_or_else(|| "floor".to_string(), |value| js::string(Some(value)));
        let walkable = matches!(sk_core::text::lower(&kind).as_str(), "floor" | "door");
        walkable && map.is_none_or(|map| cell_at(map, cell.x, cell.y).is_some_and(|cell| cell.passable)) && !occupied.contains(&key)
    })
}

/// Принятая расстановка: позиции по героям (порядок записи) и занятые
/// клетки (`usedCells`, начиная с уже занятых).
pub struct Placement {
    pub positions: IndexMap<String, (i64, i64)>,
    pub used_cells: IndexSet<String>,
}

/// `acceptedPartyPlacementEntries(state, rawEntries, cells, map, { occupiedCells })`
/// (12203): заявленные клетки героев отряда, которые помещают площадь героя.
pub fn accepted_party_placement_entries(state: &Value, raw_entries: Option<&Value>, cells: Option<&Value>, map: Option<&TacticalMap>, occupied: &IndexSet<String>) -> Placement {
    let party: IndexSet<String> = scene_advance_party_ids(state).into_iter().collect();
    let cells = cells_by_key(cells.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]));
    let mut used_actors: IndexSet<String> = IndexSet::new();
    let mut used_cells = occupied.clone();
    let mut positions = IndexMap::new();
    for entry in raw_entries.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let id = js::s(entry.get("actor_id"));
        let x = js::number(entry.get("x"));
        let y = js::number(entry.get("y"));
        if !party.contains(&id) || used_actors.contains(&id) || !crate::core::is_safe_integer_f64(x) || !crate::core::is_safe_integer_f64(y) {
            continue;
        }
        let (x, y) = (x as i64, y as i64);
        let anchor = serde_json::json!({ "x": x, "y": y });
        let actor = find_actor(state, &id);
        if !party_footprint_fits(actor, &anchor, &cells, map, &used_cells) {
            continue;
        }
        used_actors.insert(id.clone());
        for cell in footprint_cells_for(actor, Some(&anchor)) {
            used_cells.insert(position_key(cell.x, cell.y));
        }
        positions.insert(id, (x, y));
    }
    Placement { positions, used_cells }
}

/// Занятые клетки как точки для `revealSceneCells`.
pub fn used_cell_points(used: &IndexSet<String>) -> Vec<Value> {
    used.iter().map(|key| key_point(key)).collect()
}

/// `propMovementPositions(map)` (`rules/tactical-geometry.mjs`, 313): клетки
/// реквизита с `blocksMove` строковыми ключами в порядке реквизита (у
/// `tactical_geometry::prop_movement_positions` Р1 — неупорядоченное множество
/// числовых ключей).
pub fn prop_movement_positions(map: &TacticalMap) -> IndexSet<String> {
    let mut blocked = IndexSet::new();
    for prop in map.props.iter().filter(|prop| prop.blocks_move) {
        if prop.footprint.is_empty() {
            let (x, y) = (prop.x.floor(), prop.y.floor());
            if crate::core::is_safe_integer_f64(x) && crate::core::is_safe_integer_f64(y) {
                blocked.insert(position_key(x as i64, y as i64));
            }
        } else {
            for cell in &prop.footprint {
                blocked.insert(position_key(cell.x, cell.y));
            }
        }
    }
    blocked
}

/// `sceneAdvancePartyPositions(state, transition)` (12245): отряд встаёт
/// у входа новой сцены — ближние к входу клетки пола достаются первым в
/// списке отряда; реквизит карты уже занимает свои клетки.
pub fn scene_advance_party_positions(state: &Value, transition: &Value) -> Result<Vec<Value>, RuleError> {
    let party = scene_advance_party_ids(state);
    let entrance = transition.get("entrance");
    let entrance_x = js::safe_int(entrance.and_then(|entrance| entrance.get("x")), 0);
    let entrance_y = js::safe_int(entrance.and_then(|entrance| entrance.get("y")), 0);
    let scene = transition.get("scene");
    let raw_cells = scene.and_then(|scene| scene.get("cells")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut seen: IndexSet<(i64, i64)> = IndexSet::new();
    let mut cells: Vec<Value> = Vec::new();
    for cell in raw_cells {
        let x = js::number(cell.as_object().and_then(|cell| cell.get("x")));
        let y = js::number(cell.as_object().and_then(|cell| cell.get("y")));
        if !crate::core::is_safe_integer_f64(x) || !crate::core::is_safe_integer_f64(y) {
            continue;
        }
        let (x, y) = (x as i64, y as i64);
        if !seen.insert((x, y)) {
            continue;
        }
        let kind = cell.get("type").filter(|value| js::truthy(Some(value))).map_or_else(|| "floor".to_string(), |value| js::string(Some(value)));
        if !matches!(sk_core::text::lower(&kind).as_str(), "floor" | "door") {
            continue;
        }
        cells.push(js::spread(&cell, serde_json::json!({ "x": x, "y": y })));
    }
    let coordinate = |cell: &Value, key: &str| cell.get(key).and_then(Value::as_i64).unwrap_or(0);
    cells.sort_by(|left, right| {
        let distance = |cell: &Value| (coordinate(cell, "x") - entrance_x).abs() + (coordinate(cell, "y") - entrance_y).abs();
        let feature = |cell: &Value| i64::from(js::truthy(cell.get("feature")));
        distance(left)
            .cmp(&distance(right))
            .then(feature(left).cmp(&feature(right)))
            .then(coordinate(left, "y").cmp(&coordinate(right, "y")))
            .then(coordinate(left, "x").cmp(&coordinate(right, "x")))
    });
    let map = scene.and_then(|scene| scene.get("map")).filter(|map| js::truthy(Some(map))).and_then(|map| sk_tactical::tactical_map::deserialize_tactical_map(map).ok());
    let by_key = cells_by_key(&cells);
    let mut occupied = map.as_ref().map(prop_movement_positions).unwrap_or_default();
    let mut positions = Vec::new();
    for id in party {
        let actor = find_actor(state, &id);
        let Some(selected) = cells.iter().find(|candidate| party_footprint_fits(actor, candidate, &by_key, map.as_ref(), &occupied)) else {
            return Err(RuleError::new("SCENE_ENTRANCE_CAPACITY_EXCEEDED", "На входе новой сцены недостаточно площади для отряда"));
        };
        for cell in footprint_cells_for(actor, Some(selected)) {
            occupied.insert(position_key(cell.x, cell.y));
        }
        positions.push(serde_json::json!({ "actor_id": id, "x": coordinate(selected, "x"), "y": coordinate(selected, "y") }));
    }
    Ok(positions)
}
