//! Перенос `server/thin-walls.mjs`: тонкие стены — стена живёт на ребре
//! клетки, а не занимает клетку.
//!
//! Генераторы строят стены клетками: дом 9×6 давал внутри 7×4, перегородка
//! съедала целый ряд, а на рисованных боевых картах стена — линия на границе
//! клеток. Проход берёт готовую планировку и отдаёт каждую клетку стены
//! соседнему помещению, а на границе ставит ребро-стену:
//!
//! - стена между помещением и улицей уходит помещению — дом растёт наружу на
//!   толщину кладки;
//! - перегородка между двумя комнатами уходит меньшей;
//! - угол и стык, у которых комната только по диагонали, уходят той комнате,
//!   которой отошло больше соседних клеток стены;
//! - толстая кладка и скала, не граничащие с помещением, остаются клетками,
//!   как и край карты (`keep_border`).
//!
//! Двери и окна сохраняются: проём, оказавшийся внутри своей стены, переезжает
//! на новую границу вместе с полотном. Модуль — лист поверх
//! [`sk_tactical::tactical_map`], состояния не хранит.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::text;
use sk_tactical::tactical_map::{self as tm, CellPatch, EdgeDir, EdgeKind, EdgePatch, MapResult, TacticalCell, TacticalMap};

pub const THIN_WALLS_VERSION: &str = "thin-walls/v1";

/// Рёбра-проёмы, которые проход не заменяет глухой стеной.
const OPENINGS: [EdgeKind; 5] = [EdgeKind::Door, EdgeKind::Window, EdgeKind::Loophole, EdgeKind::Grate, EdgeKind::Rail];

const DIRECTIONS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Параметры `thinWalls(map, { keepBorder })`. `wallMaterial` JS объявляет, но
/// не читает — его здесь нет.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThinWallsOptions {
    /// Клетки края карты остаются кладкой (по умолчанию да).
    pub keep_border: bool,
}

impl Default for ThinWallsOptions {
    fn default() -> Self {
        Self { keep_border: true }
    }
}

/// Итог прохода: сколько клеток стены отдано помещениям.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThinWallsReport {
    pub converted: usize,
}

impl ThinWallsReport {
    /// Форма JS: `{ converted }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("converted".into(), Value::from(self.converted));
        Value::Object(object)
    }
}

/// Вид и материал зоны; при повторе id побеждает последняя (как `new Map`).
struct ZoneInfo {
    kind: String,
    material: String,
}

fn zone_table(map: &TacticalMap) -> HashMap<String, ZoneInfo> {
    map.zones.iter().map(|zone| (zone.id.clone(), ZoneInfo { kind: zone.kind.clone(), material: zone.material.clone() })).collect()
}

fn zone_kind<'a>(zones: &'a HashMap<String, ZoneInfo>, zone: &str) -> Option<&'a str> {
    zones.get(zone).map(|info| info.kind.as_str())
}

/// Клетка, отданная помещению: где она, чья и с какой клетки пола берёт
/// материал и высоту.
#[derive(Clone, Debug)]
struct Owner {
    x: i64,
    y: i64,
    zone: String,
    source: (i64, i64),
}

/// `thinWalls(map, options)`: клетки стены становятся полом соседних
/// помещений, на границах помещений — рёбра-стены.
pub fn thin_walls(map: &mut TacticalMap, options: &ThinWallsOptions) -> MapResult<ThinWallsReport> {
    let zones = zone_table(map);
    let keep_border = options.keep_border;
    let (width, height) = (map.width, map.height);
    let on_border = |x: i64, y: i64| x == 0 || y == 0 || x == width - 1 || y == height - 1;
    // Комната — проходимая клетка помещения; служебная зона `walls` комнатой не считается.
    let room_zone = |map: &TacticalMap, x: i64, y: i64| -> String {
        match tm::cell_at(map, x, y) {
            Some(cell) if cell.passable && cell.zone != "walls" && zone_kind(&zones, cell.zone) == Some("interior") => cell.zone.to_string(),
            _ => String::new(),
        }
    };
    let is_wall = |map: &TacticalMap, x: i64, y: i64| -> bool {
        tm::cell_at(map, x, y).is_some_and(|cell| !cell.passable && cell.surface != "water" && !(keep_border && on_border(x, y)))
    };
    let mut room_size: HashMap<String, i64> = HashMap::new();
    for y in 0..height {
        for x in 0..width {
            let zone = room_zone(map, x, y);
            if !zone.is_empty() {
                *room_size.entry(zone).or_insert(0) += 1;
            }
        }
    }
    let size_of = |zone: &str| room_size.get(zone).copied().unwrap_or(0);
    let preferred = |candidates: Vec<String>| -> String {
        let mut unique: Vec<String> = Vec::new();
        for zone in candidates {
            if !unique.contains(&zone) {
                unique.push(zone);
            }
        }
        unique.sort_by(|left, right| size_of(left).cmp(&size_of(right)).then_with(|| text::locale_compare(left, right)));
        unique.into_iter().next().unwrap_or_default()
    };

    let mut owner: IndexMap<(i64, i64), Owner> = IndexMap::new();
    // Проход 1: клетка стены рядом с комнатой.
    for y in 0..height {
        for x in 0..width {
            if !is_wall(map, x, y) {
                continue;
            }
            let rooms: Vec<(i64, i64, String)> =
                DIRECTIONS.iter().map(|(dx, dy)| (x + dx, y + dy, room_zone(map, x + dx, y + dy))).filter(|(_, _, zone)| !zone.is_empty()).collect();
            if rooms.is_empty() {
                continue;
            }
            let zone = preferred(rooms.iter().map(|(_, _, zone)| zone.clone()).collect());
            let source = rooms.iter().find(|(_, _, candidate)| *candidate == zone).map_or((x, y), |(sx, sy, _)| (*sx, *sy));
            owner.insert((x, y), Owner { x, y, zone, source });
        }
    }
    // Проход 1б: второй слой толстой стены между комнатой и улицей. Слой,
    // отделяющий комнату от скалы или другой толщи, не трогается.
    let outside = |map: &TacticalMap, x: i64, y: i64| -> bool {
        tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && zone_kind(&zones, cell.zone) != Some("interior"))
    };
    let first_pass = owner.clone();
    for y in 0..height {
        for x in 0..width {
            if !is_wall(map, x, y) || owner.contains_key(&(x, y)) {
                continue;
            }
            // Сквозь стену: отданная клетка первого прохода и улица — строго по
            // разные стороны, а не вдоль стены.
            let inner = DIRECTIONS.iter().find_map(|(dx, dy)| {
                let entry = first_pass.get(&(x + dx, y + dy))?;
                outside(map, x - dx, y - dy).then_some(entry)
            });
            if let Some(entry) = inner {
                owner.insert((x, y), Owner { x, y, zone: entry.zone.clone(), source: entry.source });
            }
        }
    }
    // Проход 2: углы и стыки. Клетка уходит комнате, которой отошло больше
    // соседних клеток стены, если эта комната видна по диагонали между ними.
    for _round in 0..2 {
        let mut found: Vec<Owner> = Vec::new();
        for y in 0..height {
            for x in 0..width {
                if !is_wall(map, x, y) || owner.contains_key(&(x, y)) {
                    continue;
                }
                let mut by_zone: IndexMap<String, Vec<(i64, i64)>> = IndexMap::new();
                for (dx, dy) in DIRECTIONS {
                    if let Some(entry) = owner.get(&(x + dx, y + dy)) {
                        by_zone.entry(entry.zone.clone()).or_default().push((dx, dy));
                    }
                }
                let mut ranked: Vec<(String, Vec<(i64, i64)>)> = by_zone.into_iter().collect();
                ranked.sort_by(|left, right| {
                    right.1.len().cmp(&left.1.len()).then_with(|| size_of(&left.0).cmp(&size_of(&right.0))).then_with(|| text::locale_compare(&left.0, &right.0))
                });
                for (zone, sides) in &ranked {
                    if sides.len() < 2 {
                        continue;
                    }
                    // Диагональ между двумя перпендикулярными соседями — комната той же зоны.
                    let mut diagonal = None;
                    'search: for (ax, ay) in sides {
                        for (bx, by) in sides {
                            if ax * bx + ay * by != 0 {
                                continue;
                            }
                            let cell = (x + ax + bx, y + ay + by);
                            if room_zone(map, cell.0, cell.1) == *zone {
                                diagonal = Some(cell);
                                break 'search;
                            }
                        }
                    }
                    let Some(source) = diagonal else { continue };
                    found.push(Owner { x, y, zone: zone.clone(), source });
                    break;
                }
            }
        }
        let done = found.is_empty();
        for entry in found {
            owner.insert((entry.x, entry.y), entry);
        }
        if done {
            break;
        }
    }

    // Клетки стены становятся полом своей комнаты.
    for entry in owner.values() {
        let floor = tm::cell_at(map, entry.source.0, entry.source.1).map(|cell| (cell.material, cell.elevation));
        let material = match floor {
            Some((material, _)) => material.to_string(),
            None => zones.get(&entry.zone).map_or_else(|| "stone".to_string(), |info| info.material.clone()),
        };
        let patch = CellPatch {
            passable: Some(true),
            zone: Some(&entry.zone),
            material: Some(&material),
            surface: Some("none"),
            elevation: floor.map(|(_, elevation)| elevation),
            ..CellPatch::default()
        };
        tm::set_cell(map, entry.x, entry.y, &patch)?;
    }
    // Границы: внутри комнаты рёбер нет, на границе — стена, если там не проём.
    for entry in owner.values() {
        let (x, y) = (entry.x, entry.y);
        for (dx, dy) in DIRECTIONS {
            let (nx, ny) = (x + dx, y + dy);
            let Some(neighbor_zone) = passable_zone(map, nx, ny) else { continue };
            let existing = tm::edge_between(map, x, y, nx, ny)?.map(|edge| edge.kind);
            if neighbor_zone == entry.zone {
                if existing.is_some_and(|kind| kind != EdgeKind::Door) {
                    tm::set_edge(map, x, y, nx, ny, &none_edge())?;
                }
                continue;
            }
            if existing.is_some_and(|kind| OPENINGS.contains(&kind)) {
                continue;
            }
            tm::set_edge(map, x, y, nx, ny, &wall_edge())?;
        }
    }
    absorb_door_cells(map, &zones)?;
    realign_doorways(map, &owner)?;
    Ok(ThinWallsReport { converted: owner.len() })
}

/// Зона проходимой клетки (`''` — без зоны); `None` — клетки нет или она глухая.
fn passable_zone(map: &TacticalMap, x: i64, y: i64) -> Option<String> {
    tm::cell_at(map, x, y).filter(|cell| cell.passable).map(|cell| cell.zone.to_string())
}

fn none_edge() -> EdgePatch<'static> {
    EdgePatch { kind: Some("none"), ..EdgePatch::default() }
}

fn wall_edge() -> EdgePatch<'static> {
    EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None }
}

/// Клетка помещения: проходима, не служебная зона `walls`, зона — `interior`.
fn is_room(zones: &HashMap<String, ZoneInfo>, cell: &TacticalCell<'_>) -> bool {
    cell.passable && cell.zone != "walls" && zone_kind(zones, cell.zone) == Some("interior")
}

/// Скопированная клетка: зона, материал и признаки, нужные проходу проёмов.
struct CellCopy {
    passable: bool,
    zone: String,
    material: &'static str,
    room: bool,
    exterior: bool,
}

fn copy_cell(map: &TacticalMap, zones: &HashMap<String, ZoneInfo>, x: i64, y: i64) -> Option<CellCopy> {
    tm::cell_at(map, x, y).map(|cell| CellCopy {
        passable: cell.passable,
        zone: cell.zone.to_string(),
        material: cell.material,
        room: is_room(zones, &cell),
        exterior: zone_kind(zones, cell.zone) == Some("exterior"),
    })
}

/// `absorbDoorCells`: клетка проёма, оставшаяся за служебной зоной (`walls`)
/// или без зоны, — ниша в одну клетку посреди новой тонкой стены. Она отходит
/// комнате по ту сторону, где полотна нет, а полотно остаётся на своём ребре.
fn absorb_door_cells(map: &mut TacticalMap, zones: &HashMap<String, ZoneInfo>) -> MapResult<()> {
    let door_ends: Vec<[(i64, i64); 2]> = map.doors.iter().map(|door| [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)]).collect();
    // Проход без двери, прорубленный в стене (петля, связка графа), — та же
    // ниша: отходит соседней комнате, рёбра пересчитываются.
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = copy_cell(map, zones, x, y) else { continue };
            if !cell.passable || cell.room || cell.exterior {
                continue;
            }
            if door_ends.iter().any(|ends| ends.contains(&(x, y))) {
                continue;
            }
            let room = DIRECTIONS.iter().find_map(|(dx, dy)| copy_cell(map, zones, x + dx, y + dy).filter(|neighbor| neighbor.room));
            let Some(room) = room else { continue };
            tm::set_cell(map, x, y, &CellPatch { zone: Some(&room.zone), material: Some(room.material), ..CellPatch::default() })?;
            for (dx, dy) in DIRECTIONS {
                let Some(neighbor) = copy_cell(map, zones, x + dx, y + dy) else { continue };
                if !neighbor.passable {
                    continue;
                }
                let existing = tm::edge_between(map, x, y, x + dx, y + dy)?.map(|edge| edge.kind);
                if (neighbor.zone == room.zone || !neighbor.room) && existing == Some(EdgeKind::Wall) {
                    tm::set_edge(map, x, y, x + dx, y + dy, &none_edge())?;
                }
            }
        }
    }
    for ends in &door_ends {
        for (index, doorway) in ends.iter().copied().enumerate() {
            let Some(cell) = copy_cell(map, zones, doorway.0, doorway.1) else { continue };
            if !cell.passable || cell.room || cell.exterior {
                continue;
            }
            let across = ends[1 - index];
            let beyond = (doorway.0 * 2 - across.0, doorway.1 * 2 - across.1);
            let Some(room) = copy_cell(map, zones, beyond.0, beyond.1) else { continue };
            // За проёмом может быть и двор: дверь кладовой во внутренний двор.
            // Тогда проём отходит двору, иначе он остаётся клеткой кладки.
            let outdoors = room.passable && room.exterior;
            if !room.room && !outdoors {
                continue;
            }
            tm::set_cell(map, doorway.0, doorway.1, &CellPatch { zone: Some(&room.zone), material: Some(room.material), ..CellPatch::default() })?;
            for (dx, dy) in DIRECTIONS {
                let (nx, ny) = (doorway.0 + dx, doorway.1 + dy);
                if (nx, ny) == across {
                    continue;
                }
                let Some(neighbor_zone) = passable_zone(map, nx, ny) else { continue };
                let existing = tm::edge_between(map, doorway.0, doorway.1, nx, ny)?.map(|edge| edge.kind);
                if neighbor_zone == room.zone {
                    if existing.is_some_and(|kind| kind != EdgeKind::Door) {
                        tm::set_edge(map, doorway.0, doorway.1, nx, ny, &none_edge())?;
                    }
                } else if !existing.is_some_and(|kind| OPENINGS.contains(&kind)) {
                    tm::set_edge(map, doorway.0, doorway.1, nx, ny, &wall_edge())?;
                }
            }
            break;
        }
    }
    Ok(())
}

/// `realignDoorways`: проём двери в перегородке был клеткой одной комнаты, а
/// соседние клетки той же стены могли отойти другой — у комнаты появлялся
/// зубец с дверью на конце. Проём переходит к той же комнате, что и стена
/// вокруг него, а полотно двери — на его дальнее ребро.
fn realign_doorways(map: &mut TacticalMap, owner: &IndexMap<(i64, i64), Owner>) -> MapResult<()> {
    // Как `[...map.doors]` JS: записи до правок прохода.
    let doors = map.doors.clone();
    for door in &doors {
        let ends = [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)];
        for index in 0..2 {
            let doorway = ends[index];
            let across = ends[1 - index];
            let doorway_cell = tm::cell_at(map, doorway.0, doorway.1).map(|cell| (cell.passable, cell.zone.to_string()));
            let across_cell = tm::cell_at(map, across.0, across.1).map(|cell| (cell.passable, cell.zone.to_string(), cell.material));
            let (Some((true, doorway_zone)), Some((true, across_zone, across_material))) = (doorway_cell, across_cell) else { continue };
            if owner.contains_key(&doorway) {
                continue;
            }
            let step = (doorway.0 - across.0, doorway.1 - across.1);
            // Соседи проёма вдоль стены — перпендикулярно направлению двери.
            let along = [(doorway.0 + step.1, doorway.1 + step.0), (doorway.0 - step.1, doorway.1 - step.0)];
            let wall_zones: Vec<&str> = along.iter().filter_map(|cell| owner.get(cell).map(|entry| entry.zone.as_str())).filter(|zone| !zone.is_empty()).collect();
            if wall_zones.is_empty() || wall_zones.iter().any(|zone| *zone != across_zone) || doorway_zone == across_zone {
                continue;
            }
            let beyond = (doorway.0 + step.0, doorway.1 + step.1);
            if passable_zone(map, beyond.0, beyond.1).is_none_or(|zone| zone != doorway_zone) {
                continue;
            }
            // Проём — пол комнаты за ним, полотно — на ребре к его прежней
            // комнате. Закрыта ли дверь, хранит ребро: флаги переносятся.
            let leaf = tm::edge_between(map, doorway.0, doorway.1, across.0, across.1)?.map(|edge| (edge.blocks_move, edge.blocks_sight));
            tm::set_cell(map, doorway.0, doorway.1, &CellPatch { zone: Some(&across_zone), material: Some(across_material), ..CellPatch::default() })?;
            tm::set_edge(map, doorway.0, doorway.1, across.0, across.1, &none_edge())?;
            for cell in along {
                if tm::cell_at(map, cell.0, cell.1).is_some_and(|neighbor| neighbor.zone == across_zone) {
                    tm::set_edge(map, doorway.0, doorway.1, cell.0, cell.1, &none_edge())?;
                }
            }
            let (ex, ey, dir) = if beyond.0 > doorway.0 || beyond.1 > doorway.1 {
                (doorway.0, doorway.1, if beyond.0 > doorway.0 { EdgeDir::E } else { EdgeDir::S })
            } else {
                (beyond.0, beyond.1, if beyond.0 < doorway.0 { EdgeDir::E } else { EdgeDir::S })
            };
            let mut spread = match door.to_json() {
                Value::Object(object) => object,
                _ => Map::new(),
            };
            spread.insert("x".into(), Value::from(ex));
            spread.insert("y".into(), Value::from(ey));
            spread.insert("dir".into(), Value::String(dir.as_str().into()));
            spread.insert("blocksMove".into(), Value::Bool(leaf.is_some_and(|(blocks, _)| blocks)));
            spread.insert("blocksSight".into(), Value::Bool(leaf.is_some_and(|(_, blocks)| blocks)));
            tm::set_door(map, &Value::Object(spread))?;
            break;
        }
    }
    Ok(())
}
