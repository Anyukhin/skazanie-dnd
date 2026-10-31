//! Фигурный корпус (Г, крест, круг): срез уже нарисованного прямоугольника,
//! обрывки комнат в кладку, двери и окна по кладке между областями.

use std::collections::HashSet;

use sk_tactical::tactical_map::{self as tm, CellPatch, TacticalMap};

use super::plan::seed_hash;
use super::{open_doorway, open_window, Rect, Result, RoomPlan, DIRS};

/// Краски среза: двор, кладка и вариант пола клетки.
pub(crate) struct Paint<'a> {
    pub yard_material: &'a str,
    pub yard_surface: &'a str,
    pub wall_material: &'a str,
    pub variant_at: &'a dyn Fn(i64, i64) -> i64,
}

/// `applyBuildingShape(map, building, shape, seed, rooms, paint)`: клетки вне
/// формы — двор, кромка формы — стена, обрывки комнат меньше шести клеток —
/// кладка. Возвращает уцелевшие комнаты.
pub(crate) fn apply_building_shape(map: &mut TacticalMap, building: Rect, shape: &str, seed: &str, rooms: &[RoomPlan], paint: &Paint<'_>) -> Result<Vec<RoomPlan>> {
    let width = building.max_x - building.min_x + 1;
    let height = building.max_y - building.min_y + 1;
    let share = if shape == "cross" { 0.28 } else { 0.42 };
    let cut_w = 4.max((width as f64 * share).floor() as i64);
    let cut_h = 4.max((height as f64 * share).floor() as i64);
    let center = |room: &RoomPlan| (room.min_x + room.max_x) as f64 / 2.0;
    let hall = rooms.iter().find(|room| room.zone_id == "hall");
    let hall_center_x = hall.map_or((building.min_x + building.max_x) as f64 / 2.0, center);
    let store = rooms.iter().find(|room| room.zone_id == "store");
    let middle_x = (building.min_x + building.max_x) as f64 / 2.0;
    let preferred_west = if (hall_center_x - middle_x).abs() < 1.0 {
        match store {
            Some(store) if (center(store) - middle_x).abs() >= 1.0 => center(store) < middle_x,
            _ => seed_hash(&format!("{seed}:shape-corner")) % 2 == 0,
        }
    } else {
        hall_center_x > middle_x
    };
    let lost_to = |west: bool| {
        rooms
            .iter()
            .filter(|room| {
                if room.zone_id == "hall" {
                    return false;
                }
                let mut left = 0;
                for y in room.min_y..=room.max_y {
                    for x in room.min_x..=room.max_x {
                        let in_cut_x = if west { x <= building.min_x + cut_w } else { x >= building.max_x - cut_w };
                        if !(in_cut_x && y <= building.min_y + cut_h) {
                            left += 1;
                        }
                    }
                }
                left < 6
            })
            .count()
    };
    let west_cut = if shape != "L" || lost_to(preferred_west) <= lost_to(!preferred_west) { preferred_west } else { !preferred_west };
    let center_x = (building.min_x + building.max_x + 1) as f64 / 2.0;
    let center_y = (building.min_y + building.max_y + 1) as f64 / 2.0;
    let in_shape = |x: i64, y: i64| -> bool {
        if x < building.min_x || x > building.max_x || y < building.min_y || y > building.max_y {
            return false;
        }
        let left = x < building.min_x + cut_w;
        let right = x > building.max_x - cut_w;
        let top = y < building.min_y + cut_h;
        let bottom = y > building.max_y - cut_h;
        match shape {
            "L" => !(top && if west_cut { left } else { right }),
            "cross" => !((left || right) && (top || bottom)),
            "round" => {
                let dx = (x as f64 + 0.5 - center_x) / (width as f64 / 2.0);
                let dy = (y as f64 + 0.5 - center_y) / (height as f64 / 2.0);
                dx * dx + dy * dy <= 1.0
            }
            _ => true,
        }
    };
    for y in building.min_y..=building.max_y {
        for x in building.min_x..=building.max_x {
            if !in_shape(x, y) {
                let patch = CellPatch {
                    passable: Some(true),
                    material: Some(paint.yard_material),
                    surface: Some(paint.yard_surface),
                    zone: Some("yard"),
                    variant: Some((paint.variant_at)(x, y)),
                    ..CellPatch::default()
                };
                tm::set_cell(map, x, y, &patch)?;
                continue;
            }
            let rim = DIRS.iter().any(|(dx, dy)| !in_shape(x + dx, y + dy));
            if rim {
                let patch = CellPatch {
                    passable: Some(false),
                    material: Some(paint.wall_material),
                    zone: Some("walls"),
                    surface: Some("none"),
                    variant: Some((paint.variant_at)(x, y)),
                    ..CellPatch::default()
                };
                tm::set_cell(map, x, y, &patch)?;
            }
        }
    }
    // Обрывки: у комнаты остаётся самый крупный связный кусок.
    let mut kept = Vec::new();
    for room in rooms {
        let mut parts: Vec<Vec<(i64, i64)>> = Vec::new();
        let mut seen: HashSet<(i64, i64)> = HashSet::new();
        let in_room = |map: &TacticalMap, x: i64, y: i64| tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.zone == room.zone_id);
        for y in room.min_y..=room.max_y {
            for x in room.min_x..=room.max_x {
                if !in_room(map, x, y) || seen.contains(&(x, y)) {
                    continue;
                }
                let mut part = vec![(x, y)];
                seen.insert((x, y));
                let mut index = 0;
                while index < part.len() {
                    let (px, py) = part[index];
                    for (dx, dy) in DIRS {
                        let (nx, ny) = (px + dx, py + dy);
                        if !in_room(map, nx, ny) || seen.contains(&(nx, ny)) {
                            continue;
                        }
                        seen.insert((nx, ny));
                        part.push((nx, ny));
                    }
                    index += 1;
                }
                parts.push(part);
            }
        }
        parts.sort_by(|left, right| right.len().cmp(&left.len()));
        let main_len = parts.first().map_or(0, Vec::len);
        let dropped: &[Vec<(i64, i64)>] = if main_len < 6 && room.zone_id != "hall" { &parts } else { parts.get(1..).unwrap_or(&[]) };
        for part in dropped {
            for (x, y) in part {
                let patch = CellPatch { passable: Some(false), material: Some(paint.wall_material), zone: Some("walls"), surface: Some("none"), ..CellPatch::default() };
                tm::set_cell(map, *x, *y, &patch)?;
            }
        }
        if main_len >= 6 || room.zone_id == "hall" {
            kept.push(room.clone());
        }
    }
    Ok(kept)
}

/// Клетка кладки между двумя областями и сторона, куда она выходит.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WallCell {
    pub x: i64,
    pub y: i64,
    pub outward: (i64, i64),
}

/// `wallCellsBetween(map, first, second)`: клетки кладки, по одну сторону
/// которых пол зоны `first`, по другую — строго напротив — пол зоны `second`.
pub(crate) fn wall_cells_between(map: &TacticalMap, first: &str, second: &str) -> Vec<WallCell> {
    let mut found = Vec::new();
    for y in 1..map.height - 1 {
        for x in 1..map.width - 1 {
            let Some(own) = tm::cell_at(map, x, y) else { continue };
            if own.passable || own.zone != "walls" {
                continue;
            }
            for (dx, dy) in [(0, 1), (0, -1), (1, 0), (-1, 0)] {
                let inner = tm::cell_at(map, x - dx, y - dy);
                let outer = tm::cell_at(map, x + dx, y + dy);
                if let (Some(inner), Some(outer)) = (inner, outer) {
                    if inner.passable && outer.passable && inner.zone == first && outer.zone == second {
                        found.push(WallCell { x, y, outward: (dx, dy) });
                        break;
                    }
                }
            }
        }
    }
    found
}

/// `openShapedFrontDoor(map, hall)`: дверь из зала на двор — южная стена
/// первой, ближе к середине зала.
pub(crate) fn open_shaped_front_door(map: &mut TacticalMap, hall: &RoomPlan) -> Result<Option<(i64, i64)>> {
    let middle = (hall.min_x + hall.max_x) as f64 / 2.0;
    let mut candidates = wall_cells_between(map, "hall", "yard");
    candidates.sort_by(|left, right| {
        let south = |cell: &WallCell| i64::from(cell.outward.1 == 1);
        south(right)
            .cmp(&south(left))
            .then(right.y.cmp(&left.y))
            .then(((left.x as f64 - middle).abs()).total_cmp(&(right.x as f64 - middle).abs()))
            .then(left.x.cmp(&right.x))
    });
    let Some(chosen) = candidates.first().copied() else { return Ok(None) };
    open_doorway(map, chosen.x, chosen.y, "front-door")?;
    Ok(Some((chosen.x, chosen.y)))
}

/// `connectShapedRooms(map, firstId, secondId, doorId)`: дверь в середине
/// общей стены.
pub(crate) fn connect_shaped_rooms(map: &mut TacticalMap, first: &str, second: &str, door_id: &str) -> Result<bool> {
    let candidates = wall_cells_between(map, first, second);
    if candidates.is_empty() {
        return Ok(false);
    }
    let chosen = candidates[candidates.len() / 2];
    open_doorway(map, chosen.x, chosen.y, door_id)?;
    Ok(true)
}

/// Клетки дверей: клетка записи и соседняя по ребру.
fn door_cells(map: &TacticalMap) -> Vec<(i64, i64)> {
    map.doors.iter().flat_map(|door| [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)]).collect()
}

fn near_door(map: &TacticalMap, cell: &WallCell) -> bool {
    door_cells(map).iter().any(|(x, y)| (x - cell.x).abs() + (y - cell.y).abs() <= 1)
}

/// `openShapedBackDoorAndWindows(map, rooms)`: задняя дверь из кухни,
/// мастерской или кладовой на двор; окна жилых комнат через шаг, не у двери.
pub(crate) fn open_shaped_back_door_and_windows(map: &mut TacticalMap, rooms: &[RoomPlan]) -> Result<()> {
    for id in ["kitchen", "workshop", "store"] {
        if !rooms.iter().any(|room| room.zone_id == id) {
            continue;
        }
        let candidates: Vec<WallCell> = wall_cells_between(map, id, "yard").into_iter().filter(|cell| !near_door(map, cell)).collect();
        if candidates.is_empty() {
            continue;
        }
        let chosen = candidates[candidates.len() / 2];
        open_doorway(map, chosen.x, chosen.y, "back-door")?;
        break;
    }
    for room in rooms {
        if room.zone_id == "courtyard" {
            continue;
        }
        let initial = match room.zone_id.as_str() {
            "hall" => 6,
            "store" | "corridor" => 1,
            _ => 3,
        };
        let mut budget = initial;
        let candidates = wall_cells_between(map, &room.zone_id, "yard");
        for cell in &candidates {
            if budget <= 0 {
                break;
            }
            if (cell.x + cell.y) % 3 != 0 || near_door(map, cell) {
                continue;
            }
            open_window(map, cell.x, cell.y)?;
            budget -= 1;
        }
        // Стена без окна по шагу всё равно получает одно окно. Коридор в
        // сравнении не назван (запас 1 против 3) и запасного окна не получает.
        let compared = match room.zone_id.as_str() {
            "hall" => 6,
            "store" => 1,
            _ => 3,
        };
        if budget == compared {
            if let Some(fallback) = candidates.iter().find(|cell| !near_door(map, cell)).copied() {
                open_window(map, fallback.x, fallback.y)?;
            }
        }
    }
    Ok(())
}
