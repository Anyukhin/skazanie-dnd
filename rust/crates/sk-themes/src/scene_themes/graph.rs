//! Граф зон темы и правки собранной по нему карты: `sceneGraphForTheme`,
//! `pierceWalls`, `addShortcutLoops`, `partitionPrisonCells`.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_geometry::scene_graph::{add_scene_link, add_scene_zone, create_scene_graph, SceneGraph};
use sk_tactical::tactical_map::{self as tm, CellPatch, EdgeDir, EdgeKind, EdgePatch, MapResult, TacticalMap};

use super::{random_for, utf16_cmp, Result, DIRS};

/// `sceneGraphForTheme(theme, seed)`: цепочка помещений, последнее — цель. У
/// запертой темы последняя дверь заперта, а ключ лежит в предыдущей зоне.
/// `theme` — объект темы JS, `seed` — `String(seed)`.
pub fn scene_graph_for_theme(theme: &Value, seed: &str) -> Result<SceneGraph> {
    let mut random = random_for(&format!("{}:{seed}", js::string(theme.get("id"))));
    let default_labels = [json!("Вход"), json!("Зал"), json!("Дальняя")];
    let labels: &[Value] = match theme.get("zones") {
        Some(Value::Array(zones)) => zones,
        _ => &default_labels,
    };
    let length = labels.len() as f64;
    let count = 3f64.max(length.min(3.0 + (random() * (length - 2.0)).floor())) as usize;
    let locked = js::truthy(theme.get("locked"));
    let mut graph = create_scene_graph(&json!({ "entranceZoneId": "zone-0", "goalZoneId": format!("zone-{}", count - 1) }))?;
    for index in 0..count {
        let label = labels.get(index).filter(|label| !label.is_null()).cloned().unwrap_or_else(|| json!(format!("Помещение {}", index + 1)));
        let keys: Vec<&str> = if locked && index + 2 == count { vec!["goal-key"] } else { Vec::new() };
        add_scene_zone(
            &mut graph,
            &json!({ "id": format!("zone-{index}"), "kind": "interior", "required": index + 1 < count, "label": label, "keys": keys }),
        )?;
    }
    for index in 1..count {
        let lock_last = locked && index == count - 1;
        let kind = if lock_last {
            "locked"
        } else if random() < 0.5 {
            "door"
        } else {
            "open"
        };
        add_scene_link(
            &mut graph,
            &json!({
                "id": format!("link-{index}"),
                "from": format!("zone-{}", index - 1),
                "to": format!("zone-{index}"),
                "kind": kind,
                "keyId": if lock_last { json!("goal-key") } else { Value::Null },
            }),
        )?;
    }
    Ok(graph)
}

/// `pierceWalls(map, { kind, stride, limit })`: часть глухих стен становится
/// бойницей или решёткой — меняется только вид ребра, проходимость прежняя.
/// Возвращает, сколько стен заменено.
pub(crate) fn pierce_walls(map: &mut TacticalMap, kind: &str, stride: usize, limit: usize) -> MapResult<usize> {
    let walls: Vec<(i64, i64, EdgeDir)> = tm::edge_list(map).into_iter().filter(|edge| edge.kind == EdgeKind::Wall).map(|edge| (edge.x, edge.y, edge.dir)).collect();
    let mut pierced = 0;
    let mut index = stride / 2;
    while index < walls.len() && pierced < limit {
        let (x, y, dir) = walls[index];
        let (nx, ny) = tm::edge_neighbor(x, y, dir);
        tm::set_edge(map, x, y, nx, ny, &EdgePatch { kind: Some(kind), ..EdgePatch::default() })?;
        pierced += 1;
        index += stride;
    }
    Ok(pierced)
}

/// Замок второго входа: `{ lockDc, keyItemId }` запертой цели.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShortcutLock {
    /// 0 — без сложности (в JS поле не пишется).
    pub lock_dc: i64,
    pub key_item_id: Option<String>,
}

/// Параметры `addShortcutLoops(map, options)`; умолчания — как в JS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShortcutOptions {
    /// Помещения, стены которых не прорубаются.
    pub exclude: Vec<String>,
    pub limit: usize,
    pub min_detour: i64,
    /// Замки по id помещения: проход в запертое помещение — под тот же ключ.
    pub locks: Vec<(String, ShortcutLock)>,
    /// Прорубать только стены этого помещения; пусто — любые.
    pub only: String,
    pub id_prefix: String,
}

impl Default for ShortcutOptions {
    fn default() -> Self {
        Self { exclude: Vec::new(), limit: 2, min_detour: 10, locks: Vec::new(), only: String::new(), id_prefix: "loop-door".into() }
    }
}

type Cell = (i64, i64);

struct Candidate {
    a: Cell,
    b: Cell,
    pair: String,
    wall: Vec<Cell>,
}

fn passable(map: &TacticalMap, x: i64, y: i64) -> bool {
    tm::cell_passable(map, x, y)
}

fn zone_of(map: &TacticalMap, x: i64, y: i64) -> &str {
    tm::cell_at(map, x, y).map_or("", |cell| cell.zone)
}

fn edge_at(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> Option<&tm::TacticalEdge> {
    tm::edge_between(map, ax, ay, bx, by).ok().flatten()
}

/// Шагов от `from` до `to` не дальше `limit` (дверь проходима, стена — нет);
/// дальше — бесконечность.
fn detour_distance(map: &TacticalMap, from: Cell, to: Cell, limit: i64) -> f64 {
    let mut seen: HashSet<Cell> = HashSet::from([from]);
    let mut frontier = vec![from];
    let mut steps = 0;
    while steps <= limit && !frontier.is_empty() {
        let mut next = Vec::new();
        for point in &frontier {
            if *point == to {
                return steps as f64;
            }
            for (dx, dy) in DIRS {
                let (nx, ny) = (point.0 + dx, point.1 + dy);
                if seen.contains(&(nx, ny)) || !passable(map, nx, ny) {
                    continue;
                }
                if let Some(edge) = edge_at(map, point.0, point.1, nx, ny) {
                    if edge.kind != EdgeKind::Door && edge.blocks_move {
                        continue;
                    }
                }
                seen.insert((nx, ny));
                next.push((nx, ny));
            }
        }
        frontier = next;
        steps += 1;
    }
    f64::INFINITY
}

/// `addShortcutLoops(map, options)`: петли по длине пути (приём Brogue) —
/// стена между двумя помещениями получает дверь, если обойти её сейчас можно
/// только в `min_detour` клеток и больше. Толстая стена прорубается лазом,
/// дверь — на выходе из него. Возвращает, сколько проходов прорублено.
pub fn add_shortcut_loops(map: &mut TacticalMap, options: &ShortcutOptions) -> MapResult<usize> {
    let blocked: HashSet<&str> = options.exclude.iter().map(String::as_str).collect();
    let mut candidates: Vec<Candidate> = Vec::new();
    for thickness in 1..=3i64 {
        for y in 1..map.height - 1 {
            for x in 1..map.width - 1 {
                for (dx, dy) in [(1i64, 0i64), (0, 1)] {
                    let wall: Vec<Cell> = (0..thickness).map(|step| (x + dx * step, y + dy * step)).collect();
                    if wall.iter().any(|cell| tm::cell_at(map, cell.0, cell.1).is_none_or(|own| own.passable)) {
                        continue;
                    }
                    if thickness > 1 && wall.iter().any(|cell| [(dy, dx), (-dy, -dx)].iter().any(|(sx, sy)| passable(map, cell.0 + sx, cell.1 + sy))) {
                        continue;
                    }
                    let a = (x - dx, y - dy);
                    let b = (x + dx * thickness, y + dy * thickness);
                    if b.0 >= map.width - 1 || b.1 >= map.height - 1 {
                        continue;
                    }
                    let zone_a = zone_of(map, a.0, a.1);
                    let zone_b = zone_of(map, b.0, b.1);
                    if !passable(map, a.0, a.1) || !passable(map, b.0, b.1) {
                        continue;
                    }
                    if zone_a.is_empty() || zone_b.is_empty() || zone_a == zone_b || blocked.contains(zone_a) || blocked.contains(zone_b) {
                        continue;
                    }
                    if !options.only.is_empty() && zone_a != options.only && zone_b != options.only {
                        continue;
                    }
                    let mut pair = [zone_a, zone_b];
                    pair.sort_by(|left, right| utf16_cmp(left, right));
                    candidates.push(Candidate { a, b, pair: format!("{}#{thickness}", pair.join("|")), wall });
                }
            }
        }
    }
    let mut opened = 0;
    let mut used_pairs: HashSet<String> = HashSet::new();
    for candidate in &candidates {
        if opened >= options.limit {
            break;
        }
        let rooms = candidate.pair.split('#').next().unwrap_or("").to_string();
        if used_pairs.contains(&rooms) {
            continue;
        }
        let detour = (options.min_detour + candidate.wall.len() as i64 - 1) as f64;
        if detour_distance(map, candidate.a, candidate.b, options.min_detour) <= detour {
            continue;
        }
        let same_wall: Vec<&Candidate> = candidates.iter().filter(|other| other.pair == candidate.pair).collect();
        let middle = same_wall[same_wall.len() / 2];
        if detour_distance(map, middle.a, middle.b, options.min_detour) <= detour {
            continue;
        }
        for cell in &middle.wall {
            tm::set_cell(map, cell.0, cell.1, &CellPatch { passable: Some(true), zone: Some(""), ..CellPatch::default() })?;
        }
        let mut path = vec![middle.a];
        path.extend(middle.wall.iter().copied());
        path.push(middle.b);
        for step in 1..path.len() {
            tm::set_edge(map, path[step - 1].0, path[step - 1].1, path[step].0, path[step].1, &EdgePatch { kind: Some("none"), ..EdgePatch::default() })?;
        }
        let last = middle.wall[middle.wall.len() - 1];
        let dir = if middle.b.0 != last.0 { "e" } else { "s" };
        let lock = rooms.split('|').find_map(|zone_id| options.locks.iter().find(|(id, _)| id == zone_id).map(|(_, lock)| lock));
        let mut door = Map::new();
        door.insert("id".into(), json!(format!("{}-{}", options.id_prefix, opened + 1)));
        door.insert("x".into(), json!(last.0));
        door.insert("y".into(), json!(last.1));
        door.insert("dir".into(), json!(dir));
        match lock {
            Some(lock) => {
                door.insert("state".into(), json!("locked"));
                if lock.lock_dc != 0 {
                    door.insert("lockDc".into(), json!(lock.lock_dc));
                }
                if let Some(key) = lock.key_item_id.as_ref().filter(|key| !key.is_empty()) {
                    door.insert("keyItemId".into(), json!(key));
                }
            }
            None => {
                door.insert("state".into(), json!("closed"));
                door.insert("blocksMove".into(), json!(false));
                door.insert("blocksSight".into(), json!(false));
            }
        }
        tm::set_door(map, &Value::Object(door))?;
        used_pairs.insert(rooms);
        opened += 1;
    }
    Ok(opened)
}

/// `partitionPrisonCells(map, zoneId)`: вдоль длинной оси зала — коридор в
/// клетку, по сторонам — камеры по три клетки с тонкими стенами и дверью в
/// коридор. Зал уже пяти клеток или короче восьми не делится.
pub(crate) fn partition_prison_cells(map: &mut TacticalMap, zone_id: &str) -> MapResult<()> {
    let mut cells: Vec<Cell> = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if tm::cell_at(map, x, y).is_some_and(|cell| cell.zone == zone_id && cell.passable) {
                cells.push((x, y));
            }
        }
    }
    if cells.is_empty() {
        return Ok(());
    }
    let min_x = cells.iter().map(|cell| cell.0).min().unwrap_or(0);
    let max_x = cells.iter().map(|cell| cell.0).max().unwrap_or(0);
    let min_y = cells.iter().map(|cell| cell.1).min().unwrap_or(0);
    let max_y = cells.iter().map(|cell| cell.1).max().unwrap_or(0);
    let horizontal = max_x - min_x >= max_y - min_y;
    let length = if horizontal { max_x - min_x } else { max_y - min_y } + 1;
    let breadth = if horizontal { max_y - min_y } else { max_x - min_x } + 1;
    if breadth < 5 || length < 8 {
        return Ok(());
    }
    let two_sided = breadth >= 7;
    let at = |along: i64, across: i64| -> Cell {
        if horizontal {
            (along, across)
        } else {
            (across, along)
        }
    };
    let (along_min, along_max) = if horizontal { (min_x, max_x) } else { (min_y, max_y) };
    let (across_min, across_max) = if horizontal { (min_y, max_y) } else { (min_x, max_x) };
    let corridor = if two_sided { (across_min + across_max).div_euclid(2) } else { across_min };
    let sides: &[i64] = if two_sided { &[-1, 1] } else { &[1] };
    let in_zone = |map: &TacticalMap, point: Cell| tm::cell_at(map, point.0, point.1).is_some_and(|cell| cell.passable && cell.zone == zone_id);
    let doorway = |map: &TacticalMap, point: Cell| {
        DIRS.iter().any(|(dx, dy)| {
            let Some(near) = tm::cell_at(map, point.0 + dx, point.1 + dy) else { return false };
            if !near.passable || near.zone == zone_id {
                return false;
            }
            match edge_at(map, point.0, point.1, point.0 + dx, point.1 + dy) {
                None => true,
                Some(edge) => edge.kind == EdgeKind::Door || !edge.blocks_move,
            }
        })
    };
    let wall = |map: &mut TacticalMap, a: Cell, b: Cell| -> MapResult<()> {
        if !in_zone(map, a) || !in_zone(map, b) || edge_at(map, a.0, a.1, b.0, b.1).is_some_and(|edge| edge.kind == EdgeKind::Door) {
            return Ok(());
        }
        tm::set_edge(map, a.0, a.1, b.0, b.1, &EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None })?;
        Ok(())
    };
    for along in along_min..=along_max {
        for side in sides {
            let cell_row = at(along, corridor + side);
            if !doorway(map, cell_row) {
                wall(map, at(along, corridor), cell_row)?;
            }
        }
    }
    let mut segments: Vec<i64> = (along_min..=along_max).step_by(3).collect();
    if segments.len() > 1 && along_max - segments[segments.len() - 1] < 1 {
        segments.pop();
    }
    for start in segments.iter().skip(1) {
        for across in across_min..=across_max {
            let cell_side = (across - corridor).signum();
            if cell_side != 0 && sides.contains(&cell_side) {
                wall(map, at(start - 1, across), at(*start, across))?;
            }
        }
    }
    let mut index = 0;
    for start in &segments {
        let middle = along_max.min(start + 1);
        for side in sides {
            let inside = at(middle, corridor + side);
            let hall = at(middle, corridor);
            if !in_zone(map, inside) || !in_zone(map, hall) {
                continue;
            }
            let (x, y, dir) = if horizontal { (inside.0, inside.1.min(hall.1), "s") } else { (inside.0.min(hall.0), inside.1, "e") };
            index += 1;
            tm::set_door(map, &json!({ "id": format!("cell-door-{index}"), "x": x, "y": y, "dir": dir, "state": "closed", "blocksMove": false, "blocksSight": false }))?;
        }
    }
    Ok(())
}
