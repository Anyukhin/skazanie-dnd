//! Вход отряда на карту: сторона входа по карте мира (`entrySideToward`,
//! `openingEntrySide`) и точка входа на краю знакомой карты или снаружи у
//! двери постройки (`entranceOnSide`, `outsideEntranceFor`).

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use sk_core::{js, text as jstext, v8sort};
use sk_geometry::world_map::world_location_by_id;
use sk_tactical::tactical_map::{cell_at, reachable_cells, EdgeDir, TacticalCell, TacticalMap};

use super::{prop, strict_equal};

/// `cellAt(map, x, y)` для дробных координат JS: не целое — клетки нет.
pub(crate) fn cell_at_f(map: &TacticalMap, x: f64, y: f64) -> Option<TacticalCell<'_>> {
    if !x.is_finite() || !y.is_finite() || x.fract() != 0.0 || y.fract() != 0.0 {
        return None;
    }
    cell_at(map, x as i64, y as i64)
}

/// Клетки под предметами, которые мешают пройти (`blocksMove`, не на стене).
fn blocked_cells(map: &TacticalMap) -> HashSet<(i64, i64)> {
    let mut blocked = HashSet::new();
    for prop in &map.props {
        if !prop.blocks_move || prop.mount.is_some() {
            continue;
        }
        if prop.footprint.is_empty() {
            blocked.insert((prop.x.floor() as i64, prop.y.floor() as i64));
        } else {
            blocked.extend(prop.footprint.iter().map(|point| (point.x, point.y)));
        }
    }
    blocked
}

/// `new Map(map.zones.map((zone) => [zone.id, zone.kind]))`: при повторе id
/// побеждает последняя зона.
fn zone_kinds(map: &TacticalMap) -> HashMap<&str, &str> {
    map.zones.iter().map(|zone| (zone.id.as_str(), zone.kind.as_str())).collect()
}

/// `entrySideToward(worldMap, toId, fromId)`: сторона карты сцены, с которой
/// отряд входит, — к месту, откуда он пришёл, по координатам карты мира (ось
/// y смотрит вниз). Пусто — прежнего места на карте нет.
pub fn entry_side_toward(world_map: Option<&Value>, to_id: Option<&Value>, from_id: Option<&Value>) -> &'static str {
    let to = world_location_by_id(world_map, &js::s(to_id));
    let from = world_location_by_id(world_map, &js::s(from_id));
    let (Some(to), Some(from)) = (to, from) else { return "" };
    if std::ptr::eq(to, from) {
        return "";
    }
    let dx = js::number(from.get("x")) - js::number(to.get("x"));
    let dy = js::number(from.get("y")) - js::number(to.get("y"));
    if !dx.is_finite() || !dy.is_finite() || (dx == 0.0 && dy == 0.0) {
        return "";
    }
    if dx.abs() >= dy.abs() {
        if dx < 0.0 {
            "west"
        } else {
            "east"
        }
    } else if dy < 0.0 {
        "north"
    } else {
        "south"
    }
}

/// `openingEntrySide(worldMap, locationId)`: сторона входа в первую сцену —
/// к ближайшему месту, связанному со стартовым открытой дорогой (дорога —
/// раньше тропы и реки). Нет дорог — пусто. Пустой элемент списка дорог в JS
/// роняет поиск `TypeError`; здесь он пропускается — в карте, собранной
/// `world-map`, его не бывает.
pub fn opening_entry_side(world_map: Option<&Value>, location_id: Option<&Value>) -> &'static str {
    let routes: &[Value] = match prop(world_map, "routes") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let mut candidates: Vec<(&Value, Option<&Value>)> = routes
        .iter()
        .filter(|route| !route.is_null())
        .filter(|route| {
            let route = Some(*route);
            !js::is_false(prop(route, "discovered")) && (strict_equal(prop(route, "from"), location_id) || strict_equal(prop(route, "to"), location_id))
        })
        .map(|route| {
            let neighbor = if strict_equal(prop(Some(route), "from"), location_id) { prop(Some(route), "to") } else { prop(Some(route), "from") };
            (route, neighbor)
        })
        .collect();
    let not_road = |route: &Value| f64::from(u8::from(!strict_equal(prop(Some(route), "kind"), Some(&Value::String("road".into())))));
    let distance = |route: &Value| {
        let number = js::number(prop(Some(route), "distance"));
        if number.is_nan() || number == 0.0 {
            0.0
        } else {
            number
        }
    };
    v8sort::sort_by(&mut candidates, |left, right| {
        let kind = not_road(left.0) - not_road(right.0);
        if kind != 0.0 {
            return kind;
        }
        let by_distance = distance(left.0) - distance(right.0);
        if by_distance != 0.0 && !by_distance.is_nan() {
            return by_distance;
        }
        match jstext::locale_compare(&js::string(left.1), &js::string(right.1)) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        }
    });
    match candidates.first() {
        Some((_, neighbor)) => entry_side_toward(world_map, location_id, *neighbor),
        None => "",
    }
}

/// `outsideEntranceFor(map, spawn)`: отряд, пришедший к постройке дорогой,
/// стоит снаружи у входной двери, а не в зале. Точка внутри помещения
/// переносится на клетку двора у ближайшей наружной двери (на шаг от проёма,
/// если там свободно); карта без такой двери — `None`.
///
/// Запертая (`state: 'locked'`) или заваленная дверь выходом не служит.
pub fn outside_entrance_for(map: &TacticalMap, spawn_x: f64, spawn_y: f64) -> Option<(i64, i64)> {
    let kind = zone_kinds(map);
    let kind_of = |cell: &TacticalCell<'_>| kind.get(cell.zone).copied();
    let here = cell_at_f(map, spawn_x, spawn_y)?;
    if kind_of(&here) != Some("interior") {
        return None;
    }
    let blocked = blocked_cells(map);
    let mut best: Option<(i64, i64, f64)> = None;
    for door in &map.doors {
        if door.state == "locked" || door.barricade().is_some() {
            continue;
        }
        let first = (door.x, door.y);
        let second = if door.dir == EdgeDir::E { (first.0 + 1, first.1) } else { (first.0, first.1 + 1) };
        let sides = [first, second].map(|position| (position, cell_at(map, position.0, position.1)));
        let inside = sides.iter().find(|(_, cell)| cell.as_ref().is_some_and(|cell| cell.passable && kind_of(cell) == Some("interior")));
        let outside = sides.iter().find(|(_, cell)| cell.as_ref().is_some_and(|cell| cell.passable && kind_of(cell) != Some("interior") && cell.surface != "water"));
        let (Some((inside, _)), Some((outside, _))) = (inside, outside) else { continue };
        if blocked.contains(outside) {
            continue;
        }
        // Шаг от двери наружу, если там свободно: герой не заслоняет проём.
        let step = (outside.0 + (outside.0 - inside.0), outside.1 + (outside.1 - inside.1));
        let step_free = cell_at(map, step.0, step.1)
            .is_some_and(|cell| cell.passable && kind_of(&cell) != Some("interior") && cell.surface != "water" && !blocked.contains(&step));
        let stand = if step_free { step } else { *outside };
        let score = (stand.0 as f64 - spawn_x).abs() + (stand.1 as f64 - spawn_y).abs();
        if best.is_none_or(|(_, _, best)| score < best) {
            best = Some((stand.0, stand.1, score));
        }
    }
    best.map(|(x, y, _)| (x, y))
}

/// `entranceOnSide(map, side)`: точка входа на уже знакомую карту со стороны
/// `side`. Карта не поворачивается — вход ищут на её краю: проходимая клетка
/// без мебели, вне помещений, связанная без дверей с прежним входом. Дорога,
/// улица, площадь и тропа — раньше травы, и ближе к середине края. Нет такой
/// клетки — `None`.
pub fn entrance_on_side(map: &TacticalMap, side: &str) -> Option<(i64, i64)> {
    if !["west", "east", "north", "south"].contains(&side) {
        return None;
    }
    let party = map.spawn_points.iter().find(|point| point.role == "party")?;
    let blocked = blocked_cells(map);
    let reached = reachable_cells(map, party.x, party.y, false, Some(&blocked));
    let kind = zone_kinds(map);
    let roads = ["street", "square", "path", "road"];
    let horizontal = side == "west" || side == "east";
    let mut best: Option<(i64, i64, f64)> = None;
    for depth in 0..=1_i64 {
        let length = if horizontal { map.height } else { map.width };
        for along in 0..length {
            let x = match side {
                "west" => depth,
                "east" => map.width - 1 - depth,
                _ => along,
            };
            let y = match side {
                "north" => depth,
                "south" => map.height - 1 - depth,
                _ => along,
            };
            let Some(cell) = cell_at(map, x, y) else { continue };
            if !cell.passable || cell.surface == "water" || blocked.contains(&(x, y)) || !reached.contains(&(x, y)) {
                continue;
            }
            if kind.get(cell.zone).copied() == Some("interior") {
                continue;
            }
            let middle = (length - 1) as f64 / 2.0;
            let score = (if roads.contains(&cell.zone) { 0.0 } else { 1000.0 }) + depth as f64 * 100.0 + (along as f64 - middle).abs();
            if best.is_none_or(|(_, _, best)| score < best) {
                best = Some((x, y, score));
            }
        }
    }
    best.map(|(x, y, _)| (x, y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn world() -> Value {
        json!({
            "seed": "entry-road", "currentLocationId": "brod",
            "locations": [
                { "id": "brod", "name": "Старый Брод", "kind": "village", "x": 500, "y": 120, "known": true, "visited": true },
                { "id": "olsh", "name": "Ольшанка", "kind": "village", "x": 500, "y": 420, "known": true },
                { "id": "east", "name": "Восточный хутор", "kind": "village", "x": 820, "y": 420, "known": true },
            ],
        })
    }

    /// `test/scene-entry-road.test.mjs`: «сторона входа — к прежнему месту на карте мира».
    #[test]
    fn entry_side_points_to_previous_place() {
        let world = world();
        let side = |to: &str, from: &str| entry_side_toward(Some(&world), Some(&json!(to)), Some(&json!(from)));
        assert_eq!(side("olsh", "brod"), "north", "Брод севернее Ольшанки");
        assert_eq!(side("brod", "olsh"), "south");
        assert_eq!(side("olsh", "east"), "east");
        assert_eq!(side("east", "olsh"), "west");
        assert_eq!(side("olsh", "nowhere"), "", "прежнего места нет — вход по умолчанию");
        assert_eq!(side("olsh", "olsh"), "");
    }

    /// Равные смещения по осям — вход сбоку (запад/восток), как `>=` в JS.
    #[test]
    fn diagonal_tie_prefers_horizontal_side() {
        let world = json!({ "locations": [{ "id": "a", "x": 0, "y": 0 }, { "id": "b", "x": 10, "y": 10 }, { "id": "c", "x": -10, "y": 10 }] });
        assert_eq!(entry_side_toward(Some(&world), Some(&json!("a")), Some(&json!("b"))), "east");
        assert_eq!(entry_side_toward(Some(&world), Some(&json!("a")), Some(&json!("c"))), "west");
    }

    /// Западный край 30 клеток высотой: трава у середины против дороги вдали.
    fn edge_map(road_at: Option<(i64, i64)>) -> TacticalMap {
        use sk_tactical::tactical_map::{add_spawn_point, add_zone, create_tactical_map, set_cell, CellPatch, TacticalMapOptions};
        let mut map = create_tactical_map(&TacticalMapOptions { width: 6, height: 30, location_id: "edge", seed: "edge", ..Default::default() }).expect("карта");
        add_zone(&mut map, &json!({ "id": "field", "kind": "exterior", "material": "grass" })).expect("поле");
        add_zone(&mut map, &json!({ "id": "road", "kind": "exterior", "material": "earth" })).expect("дорога");
        for y in 0..30 {
            for x in 0..6 {
                let zone = if road_at == Some((x, y)) { "road" } else { "field" };
                set_cell(&mut map, x, y, &CellPatch { passable: Some(true), zone: Some(zone), ..Default::default() }).expect("клетка");
            }
        }
        add_spawn_point(&mut map, &json!({ "id": "party", "x": 3, "y": 15, "role": "party" })).expect("вход");
        map
    }

    /// Дорога у края важнее травы у середины, даже далеко от середины.
    #[test]
    fn road_beats_grass_far_from_middle() {
        assert_eq!(entrance_on_side(&edge_map(Some((0, 28))), "west"), Some((0, 28)));
        // Дорога на шаг вглубь всё равно лучше травы у самого края.
        assert_eq!(entrance_on_side(&edge_map(Some((1, 27))), "west"), Some((1, 27)));
        // Без дороги — середина края (14.5: первая из двух равных — 14).
        assert_eq!(entrance_on_side(&edge_map(None), "west"), Some((0, 14)));
    }

    /// Глубина весит 100 очков: клетка у края далеко от середины лучше
    /// клетки на шаг вглубь у середины.
    #[test]
    fn edge_depth_outweighs_distance_from_middle() {
        use sk_tactical::tactical_map::{set_cell, CellPatch};
        let mut map = edge_map(None);
        for y in 0..30 {
            if y != 1 {
                set_cell(&mut map, 0, y, &CellPatch { passable: Some(false), ..Default::default() }).expect("стена");
            }
        }
        assert_eq!(entrance_on_side(&map, "west"), Some((0, 1)));
    }

    /// `test/scene-entry-road.test.mjs`: «первая сцена: вход со стороны ближайшего места, связанного дорогой».
    #[test]
    fn opening_side_prefers_road() {
        let mut world = world();
        world["currentLocationId"] = json!("olsh");
        world["routes"] = json!([
            { "id": "r-east", "from": "olsh", "to": "east", "kind": "path", "distance": 2, "discovered": true },
            { "id": "r-brod", "from": "brod", "to": "olsh", "kind": "road", "distance": 6, "discovered": true },
        ]);
        let olsh = json!("olsh");
        assert_eq!(opening_entry_side(Some(&world), Some(&olsh)), "north", "дорога — раньше тропы, даже если тропа короче");
        let path_only = json!([world["routes"][0].clone()]);
        world["routes"] = path_only;
        assert_eq!(opening_entry_side(Some(&world), Some(&olsh)), "east", "есть только тропа — по тропе");
        world["routes"] = json!([]);
        assert_eq!(opening_entry_side(Some(&world), Some(&olsh)), "", "дорог нет — вход по умолчанию");
    }
}
