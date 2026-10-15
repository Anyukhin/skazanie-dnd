//! Перенос `server/scene-features.mjs`: приёмы Жакейс для собранной сцены —
//! второй вход в дальнюю комнату и перепад высот.
//!
//! - [`deepest_room`] — самое дальнее от входа помещение и число дверей в него;
//!   сцена тем прорубает ему второй вход, если дверь одна.
//! - [`raise_dais`] — помост вдоль дальней стены зала: алтарь, саркофаг или
//!   высокий стол стоят выше пола, ступени — проход в середине кромки.
//!
//! Помост поднимает окончательный пол, поэтому идёт после тонких стен и до
//! расстановки предметов. Модуль детерминирован и модели не зовёт.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::text;
use sk_tactical::tactical_map::{self as tm, CellPatch, EdgeDir, EdgeKind, EdgePatch, MapResult, TacticalMap};

pub const SCENE_FEATURES_VERSION: &str = "scene-features/v1";

const DIRECTIONS: [(i64, i64); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];

/// Самое дальнее помещение: id зоны, шагов от входа отряда и дверей в него.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepestRoom {
    pub zone_id: String,
    pub steps: i64,
    pub doors: usize,
}

impl DeepestRoom {
    /// Форма JS: `{ zoneId, steps, doors }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("zoneId".into(), Value::String(self.zone_id.clone()));
        object.insert("steps".into(), Value::from(self.steps));
        object.insert("doors".into(), Value::from(self.doors));
        Value::Object(object)
    }
}

/// Вторая клетка ребра двери: `door.dir === 'e' ? x + 1 : x`, `'s' ? y + 1 : y`.
fn door_far_end(x: i64, y: i64, dir: EdgeDir) -> (i64, i64) {
    tm::edge_neighbor(x, y, dir)
}

fn zone_at(map: &TacticalMap, x: i64, y: i64) -> Option<&str> {
    tm::cell_at(map, x, y).map(|cell| cell.zone)
}

/// `deepestRoom(map)`: самое дальнее от точки появления отряда помещение —
/// по шагам через двери — и сколько дверей в него ведёт.
pub fn deepest_room(map: &TacticalMap) -> Option<DeepestRoom> {
    let spawn = map.spawn_points.iter().find(|point| point.role == "party")?;
    let interior: HashSet<&str> = map.zones.iter().filter(|zone| zone.kind == "interior").map(|zone| zone.id.as_str()).collect();
    let mut depths: IndexMap<String, i64> = IndexMap::new();
    let mut queue: Vec<(i64, i64, i64)> = vec![(spawn.x, spawn.y, 0)];
    let mut seen: HashSet<(i64, i64)> = HashSet::from([(spawn.x, spawn.y)]);
    let mut index = 0;
    while index < queue.len() {
        let (x, y, steps) = queue[index];
        index += 1;
        let zone = zone_at(map, x, y).unwrap_or("");
        if !depths.contains_key(zone) {
            depths.insert(zone.to_string(), steps);
        }
        for (dx, dy) in DIRECTIONS {
            let (nx, ny) = (x + dx, y + dy);
            if seen.contains(&(nx, ny)) || !tm::cell_passable(map, nx, ny) {
                continue;
            }
            let blocked = tm::edge_between(map, x, y, nx, ny).ok().flatten().is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move);
            if blocked {
                continue;
            }
            seen.insert((nx, ny));
            queue.push((nx, ny, steps + 1));
        }
    }
    let entrance = zone_at(map, spawn.x, spawn.y).unwrap_or("");
    let mut ranked: Vec<(&String, &i64)> = depths.iter().filter(|(zone, _)| !zone.is_empty() && zone.as_str() != entrance && interior.contains(zone.as_str())).collect();
    ranked.sort_by(|left, right| right.1.cmp(left.1).then_with(|| text::locale_compare(left.0, right.0)));
    let (zone_id, steps) = ranked.first().map(|(zone, steps)| ((*zone).clone(), **steps))?;
    let doors = map
        .doors
        .iter()
        .filter(|door| {
            let (fx, fy) = door_far_end(door.x, door.y, door.dir);
            zone_at(map, door.x, door.y) == Some(zone_id.as_str()) || zone_at(map, fx, fy) == Some(zone_id.as_str())
        })
        .count();
    Some(DeepestRoom { zone_id, steps, doors })
}

/// Параметры помоста (`{ height = 5, depth = 2 }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DaisOptions {
    /// На сколько футов поднять.
    pub height: i64,
    /// Глубина полосы в клетках.
    pub depth: i64,
}

impl Default for DaisOptions {
    fn default() -> Self {
        Self { height: 5, depth: 2 }
    }
}

/// `raiseDais(map, zoneId, options)`: помост вдоль дальней от входа стены
/// помещения. Полоса глубиной `depth` клеток поднимается на `height` футов,
/// кромка — уступ (`ledge`), в середине кромки — ступени без уступа. Клетки у
/// дверей не поднимаются. Возвращает, сколько клеток поднято.
pub fn raise_dais(map: &mut TacticalMap, zone_id: &str, options: &DaisOptions) -> MapResult<usize> {
    let mut cells: Vec<(i64, i64)> = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.zone == zone_id) {
                cells.push((x, y));
            }
        }
    }
    if cells.len() < 40 {
        return Ok(0);
    }
    let in_zone: HashSet<(i64, i64)> = cells.iter().copied().collect();
    let mut door_cells: HashSet<(i64, i64)> = HashSet::new();
    for door in &map.doors {
        for (ex, ey) in [(door.x, door.y), door_far_end(door.x, door.y, door.dir)] {
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (-1, 0), (0, -1)] {
                door_cells.insert((ex + dx, ey + dy));
            }
        }
    }
    let min_x = cells.iter().map(|cell| cell.0).min().unwrap_or(0);
    let max_x = cells.iter().map(|cell| cell.0).max().unwrap_or(0);
    let min_y = cells.iter().map(|cell| cell.1).min().unwrap_or(0);
    let max_y = cells.iter().map(|cell| cell.1).max().unwrap_or(0);
    // Сторона помоста — дальняя от входа в помещение: от двери, через которую
    // в него попадают, или от точки появления отряда.
    let door_here = map.doors.iter().find(|door| in_zone.contains(&(door.x, door.y)) || in_zone.contains(&door_far_end(door.x, door.y, door.dir)));
    let spawn = map.spawn_points.iter().find(|point| point.role == "party");
    let (ax, ay) = match (door_here, spawn) {
        (Some(door), _) => (door.x as f64, door.y as f64),
        (None, Some(point)) => (point.x as f64, point.y as f64),
        (None, None) => ((min_x + max_x) as f64 / 2.0, max_y as f64),
    };
    let mut sides = [('n', ay - min_y as f64), ('s', max_y as f64 - ay), ('w', ax - min_x as f64), ('e', max_x as f64 - ax)];
    sides.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal));
    let side = sides[0].0;
    let depth = options.depth;
    let on_dais = |(x, y): (i64, i64)| match side {
        'n' => y < min_y + depth,
        's' => y > max_y - depth,
        'w' => x < min_x + depth,
        _ => x > max_x - depth,
    };
    let raised: Vec<(i64, i64)> = cells.iter().copied().filter(|cell| on_dais(*cell) && !door_cells.contains(cell)).collect();
    if raised.len() < 6 {
        return Ok(0);
    }
    let raised_keys: HashSet<(i64, i64)> = raised.iter().copied().collect();
    for (x, y) in &raised {
        tm::set_cell(map, *x, *y, &CellPatch { elevation: Some(options.height), ..CellPatch::default() })?;
    }
    // Кромка — уступ; ступени — две клетки в середине кромки.
    let horizontal = side == 'n' || side == 's';
    let middle = if horizontal { (min_x + max_x).div_euclid(2) } else { (min_y + max_y).div_euclid(2) };
    let ledge = EdgePatch { kind: Some("ledge"), blocks_move: Some(false), blocks_sight: Some(false), cover: Some("half"), door_id: None };
    for (x, y) in &raised {
        for (dx, dy) in DIRECTIONS {
            let near = (x + dx, y + dy);
            if !in_zone.contains(&near) || raised_keys.contains(&near) {
                continue;
            }
            let along = if horizontal { *x } else { *y };
            if along == middle || along == middle + 1 {
                continue;
            }
            tm::set_edge(map, *x, *y, near.0, near.1, &ledge)?;
        }
    }
    Ok(raised.len())
}
