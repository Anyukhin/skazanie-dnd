//! Перенос `server/scene-program-layout.mjs`: карта по программе сцены — этап 3
//! `docs/map-generation-plan.md`.
//!
//! Генератор темы строит улицу, дома и обстановку, но о словах сцены не знает.
//! Программа (`sk_scene_base::scene_requirements`) говорит, что обязано стоять
//! на карте и где: центр сцены — посреди открытой площадки, в нескольких шагах
//! от входа отряда; настилы — приподнятым деревянным полом без лазания; камни
//! на пороге — у дверей домов. Модуль ставит их **после** темы и **до**
//! остального обещанного, поэтому центр получает лучшее место, а не остаток.
//!
//! Чего модуль не делает: не двигает дома к площади и не разворачивает их
//! двери — это геометрия поселения. Посты жителей ставит `npc-positioning` по
//! той же программе; здесь им только обеспечивается предмет.
//!
//! Детерминированно: всё от сида карты и программы. Мутирует карту, как JS.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js, Point};
use sk_map_core::map_quality::{focus_room, prop_cells, Spot, FOCUS_MIN_ROOM};
use sk_props::prop_placement::{ensure_prop_access, is_indoor_theme, place_required_props, RequiredProps};
use sk_scene_base::asset_registry::{asset_by_id, AssetEntry};
use sk_scene_base::scene_requirements::{normalize_scene_requirements, requirement_assets, requirement_terrain};
use sk_tactical::tactical_map::{
    add_prop, cell_at, edge_between, edge_neighbor, reachable_cells, set_cell, CellPatch, EdgeKind, MapResult, PropMount, TacticalMap, TacticalProp,
};

/// Версия расстановки по программе; её ставят только новые карты.
pub const SCENE_PROGRAM_LAYOUT_VERSION: &str = "scene-program-layout/v1";

/// Высота настила в футах: шаг на него не требует лазания.
pub const PLATFORM_ELEVATION_FEET: i64 = 2;

/// Наибольший перепад под постом программы сцены: пост ставится на почти
/// ровную землю.
const OPEN_STEP_FEET: i64 = 3;

/// Центр сцены — в этих пределах шагов от входа отряда.
const FOCUS_DISTANCE_MIN: i64 = 6;
const FOCUS_DISTANCE_MAX: i64 = 10;

type Cell = (i64, i64);

/// `hashNumber(value)`: первые четыре байта SHA-256 строки, little-endian.
fn hash_number(value: &str) -> u32 {
    let digest = hash::sha256(value.as_bytes());
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// Клетка следа, если координаты — целые (у `Math.floor(NaN)` клетки нет).
fn spot_key(spot: &Spot) -> Option<Cell> {
    spot.key()
}

/// Клетки, которые заняты предметом, мешающим шагу (`blockedByProps`).
fn blocked_by_props(map: &TacticalMap) -> HashSet<Cell> {
    let mut blocked = HashSet::new();
    for prop in &map.props {
        if !prop.blocks_move || prop.mount.is_some() {
            continue;
        }
        blocked.extend(prop_cells(prop).iter().filter_map(spot_key));
    }
    blocked
}

/// Клетки у дверей (`doorApproaches`): обе стороны полотна и по клетке за ними.
fn door_approaches(map: &TacticalMap) -> HashSet<Cell> {
    let mut cells = HashSet::new();
    for door in &map.doors {
        let next = edge_neighbor(door.x, door.y, door.dir);
        let step = (next.0 - door.x, next.1 - door.y);
        for cell in [(door.x, door.y), next, (door.x - step.0, door.y - step.1), (next.0 + step.0, next.1 + step.1)] {
            cells.insert(cell);
        }
    }
    cells
}

/// `new Map(map.zones.map((zone) => [zone.id, zone.kind]))`: повтор id — побеждает последняя.
fn zone_kinds(map: &TacticalMap) -> HashMap<&str, &str> {
    map.zones.iter().map(|zone| (zone.id.as_str(), zone.kind.as_str())).collect()
}

fn party_spawn(map: &TacticalMap) -> Option<Cell> {
    map.spawn_points.iter().find(|point| point.role == "party").map(|point| (point.x, point.y))
}

/// Открытая земля (`openGround`): наружные проходимые клетки, досягаемые от
/// входа отряда, и вся досягаемая область (`None` без входа отряда).
struct OpenGround {
    cells: Vec<Cell>,
    party: Option<Cell>,
    reached: Option<IndexSet<Cell>>,
}

fn open_ground(map: &TacticalMap) -> OpenGround {
    let party = party_spawn(map);
    let kind = zone_kinds(map);
    let reached = party.map(|(x, y)| reachable_cells(map, x, y, true, Some(&blocked_by_props(map))));
    let mut cells = Vec::new();
    for y in 1..map.height - 1 {
        for x in 1..map.width - 1 {
            let Some(cell) = cell_at(map, x, y) else { continue };
            // Тропа к двери остаётся проходом: ни навеса, ни настила на ней.
            if !cell.passable || cell.surface == "water" || kind.get(cell.zone) == Some(&"interior") || cell.zone == "path" {
                continue;
            }
            if reached.as_ref().is_some_and(|reached| !reached.contains(&(x, y))) {
                continue;
            }
            cells.push((x, y));
        }
    }
    OpenGround { cells, party, reached }
}

/// Простор вокруг клетки (`clearance`): шагов до ближайшей непроходимой,
/// занятой или дверной клетки, не больше `limit`.
fn clearance(map: &TacticalMap, point: Cell, taken: &HashSet<Cell>, limit: i64) -> i64 {
    for radius in 1..=limit {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx.abs().max(dy.abs()) != radius {
                    continue;
                }
                let (x, y) = (point.0 + dx, point.1 + dy);
                let free = cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.surface != "water");
                if !free || taken.contains(&(x, y)) {
                    return radius - 1;
                }
            }
        }
    }
    limit
}

fn indoor_asset(asset: &AssetEntry) -> bool {
    asset.themes.iter().any(|theme| is_indoor_theme(theme)) && !asset.themes.iter().any(|theme| theme == "exterior")
}

/// `programFocusOutdoors(program)`: стоит ли центр программы под открытым
/// небом — навес, колодец, костёр да, очаг и алтарь — под крышей. `program` —
/// любое значение JS: у не-объекта центра нет.
pub fn program_focus_outdoors(program: &Value) -> bool {
    let focus = match program {
        Value::Object(object) => js::s(object.get("focus")),
        _ => String::new(),
    };
    if focus.is_empty() {
        return false;
    }
    requirement_assets(&focus).into_iter().find_map(asset_by_id).is_some_and(|asset| !indoor_asset(asset))
}

/// `/^(required|program)-/u.test(String(prop.id))`.
fn promised_prop(prop: &TacticalProp) -> bool {
    prop.id.starts_with("required-") || prop.id.starts_with("program-")
}

fn surface_mount(prop: &TacticalProp) -> Option<&str> {
    match &prop.mount {
        Some(PropMount::Surface { prop_id }) => Some(prop_id.as_str()),
        _ => None,
    }
}

/// След `width × height` от угла: строки по `dy`, в строке по `dx` (размер — число
/// JS, цикл идёт, пока `d < width`).
fn footprint_at(x: i64, y: i64, width: f64, height: f64) -> Vec<Point> {
    let mut footprint = Vec::new();
    let mut dy = 0;
    while (dy as f64) < height {
        let mut dx = 0;
        while (dx as f64) < width {
            footprint.push(Point::new(x + dx, y + dy));
            dx += 1;
        }
        dy += 1;
    }
    footprint
}

/// Место на площади ценой декора (`roomOnSquare`).
struct SquareRoom {
    x: i64,
    y: i64,
    footprint: Vec<Point>,
    /// Индексы снимаемых предметов в `map.props`.
    remove: HashSet<usize>,
}

/// Место на площади ценой декора: клетки площади под предметом, без порогов
/// дверей; мешающий декор снимается, а колодец и обещанное по программе
/// (`required-*`, `program-*`) остаются — такое место не берётся. Из равных —
/// где снимать меньше, затем ближе к середине площади.
fn room_on_square(map: &TacticalMap, width: f64, height: f64, taken: &HashSet<Cell>) -> Option<SquareRoom> {
    let mut square: Vec<Cell> = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if cell_at(map, x, y).is_some_and(|cell| cell.zone == "square" && cell.passable && cell.surface != "water") {
                square.push((x, y));
            }
        }
    }
    if square.is_empty() {
        return None;
    }
    let in_square: HashSet<Cell> = square.iter().copied().collect();
    let count = square.len() as f64;
    let middle_x = square.iter().fold(0.0, |sum, point| sum + point.0 as f64) / count;
    let middle_y = square.iter().fold(0.0, |sum, point| sum + point.1 as f64) / count;
    let footprints: Vec<Vec<Option<Cell>>> = map.props.iter().map(|prop| prop_cells(prop).iter().map(spot_key).collect()).collect();
    let kept = |prop: &TacticalProp| prop.asset_id == "well" || promised_prop(prop);
    let mut best: Option<(SquareRoom, f64)> = None;
    for &(cx, cy) in &square {
        let footprint = footprint_at(cx, cy, width, height);
        let keys: IndexSet<Cell> = footprint.iter().map(|point| (point.x, point.y)).collect();
        let unusable = keys.iter().any(|key| {
            !in_square.contains(key)
                || (taken.contains(key)
                    && !map.props.iter().enumerate().any(|(index, prop)| prop.blocks_move && footprints[index].iter().any(|cell| cell.as_ref() == Some(key))))
        });
        if unusable {
            continue;
        }
        let mut remove: IndexSet<usize> = map
            .props
            .iter()
            .enumerate()
            .filter(|(index, prop)| prop.mount.is_none() && footprints[*index].iter().any(|cell| cell.is_some_and(|cell| keys.contains(&cell))))
            .map(|(index, _)| index)
            .collect();
        if remove.iter().any(|index| kept(&map.props[*index])) {
            continue;
        }
        for (index, prop) in map.props.iter().enumerate() {
            let Some(under_id) = surface_mount(prop) else { continue };
            if remove.iter().any(|under| map.props[*under].id == under_id) {
                remove.insert(index);
            }
        }
        let cost = remove.len() as f64 * 100.0 + (cx as f64 + width / 2.0 - middle_x).abs() + (cy as f64 + height / 2.0 - middle_y).abs();
        if best.as_ref().is_none_or(|(_, best_cost)| cost < *best_cost) {
            best = Some((SquareRoom { x: cx, y: cy, footprint, remove: remove.into_iter().collect() }, cost));
        }
    }
    best.map(|(room, _)| room)
}

/// Значение предмета для `addProp` из записи реестра.
#[allow(clippy::too_many_arguments)] // поля предмета JS, перечисленные как в исходнике
fn registry_prop(id: String, asset: &AssetEntry, x: f64, y: f64, scale: f64, footprint: &[Point], z_order: i64, blocks: bool) -> Value {
    let cells: Vec<Value> = footprint.iter().map(|cell| json!({ "x": cell.x, "y": cell.y })).collect();
    let mut prop = Map::new();
    prop.insert("id".into(), Value::String(id));
    prop.insert("assetId".into(), Value::String(asset.id.clone()));
    prop.insert("x".into(), js::num(x));
    prop.insert("y".into(), js::num(y));
    prop.insert("rotation".into(), Value::from(0));
    prop.insert("scale".into(), js::num(scale));
    prop.insert("footprint".into(), Value::Array(cells));
    prop.insert("zOrder".into(), Value::from(z_order));
    prop.insert("blocksMove".into(), Value::Bool(blocks && asset.blocks_move));
    prop.insert("blocksSight".into(), Value::Bool(blocks && asset.blocks_sight));
    prop.insert("cover".into(), Value::String(if blocks { asset.cover.clone() } else { "none".into() }));
    prop.insert("destructible".into(), Value::Bool(asset.destructible));
    prop.insert("hp".into(), js::num(asset.hp));
    prop.insert("interactive".into(), Value::Bool(asset.interactive));
    Value::Object(prop)
}

/// `addProp` для предмета из реестра и его id. Отказа здесь не бывает:
/// укрытие из реестра, непустой id, без перехода.
fn add_registry_prop(map: &mut TacticalMap, prop: &Value) -> Option<String> {
    add_prop(map, prop).ok().map(|record| record.id.clone())
}

/// `placeSceneFocus(map, assets, { seed })`: центр сцены — предмет из
/// `assets` посреди самой открытой площадки, в 6–10 шагах от входа отряда.
/// Уже стоящий просторно предмет того же вида засчитывается. Возвращает id
/// предмета центра или `None`, если места нет. Отказ — только от
/// `placeRequiredProps` для центра под крышей (предмет с координатой NaN).
pub fn place_scene_focus(map: &mut TacticalMap, assets: &[&str], seed: &str) -> MapResult<Option<String>> {
    let Some(asset) = assets.iter().find_map(|id| asset_by_id(id)) else { return Ok(None) };
    let ids: HashSet<&str> = assets.iter().copied().collect();
    // Очаг, алтарь, стол — вещи под крышей: такой центр ставит обычная
    // расстановка в комнату, к стене.
    if indoor_asset(asset) {
        if let Some(inside) = map.props.iter().find(|prop| ids.contains(prop.asset_id.as_str())) {
            return Ok(Some(inside.id.clone()));
        }
        let before = map.props.len();
        let wanted = [RequiredProps { assets: assets.iter().map(|id| (*id).to_string()).collect(), count: 1.0 }];
        place_required_props(map, &wanted, seed)?;
        let start = before.min(map.props.len());
        return Ok(map.props[start..].iter().find(|prop| ids.contains(prop.asset_id.as_str())).map(|prop| prop.id.clone()));
    }
    let OpenGround { cells, party, reached } = open_ground(map);
    let open: HashSet<Cell> = cells.iter().copied().collect();
    // Стоящий предмет засчитывается, если к нему можно подойти — его клетка
    // или соседняя открыта.
    let reachable = |prop: &TacticalProp| {
        prop_cells(prop).iter().any(|point| {
            [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| {
                Spot::new(point.x + f64::from(*dx), point.y + f64::from(*dy)).key().is_some_and(|key| open.contains(&key))
            })
        })
    };
    // Засчитывается только стоящий просторно — та же мерка, что у проверки
    // программы (`FOCUS_CRAMPED`).
    let blocked = blocked_by_props(map);
    let roomy = |prop: &TacticalProp| reached.as_ref().is_none_or(|reached| focus_room(&prop_cells(prop), reached, &blocked) >= FOCUS_MIN_ROOM);
    let standing: Vec<usize> =
        map.props.iter().enumerate().filter(|(_, prop)| ids.contains(prop.asset_id.as_str()) && prop.mount.is_none() && reachable(prop)).map(|(index, _)| index).collect();
    if let Some(existing) = standing.iter().find(|index| roomy(&map.props[**index])) {
        return Ok(Some(map.props[*existing].id.clone()));
    }
    // Тесный предмет-декор того же вида уступает место центру.
    let mut cramped: HashSet<usize> = standing.iter().copied().filter(|index| !promised_prop(&map.props[*index])).collect();
    let mut taken: HashSet<Cell> = blocked.clone();
    taken.extend(door_approaches(map));
    let width = footprint_size(asset.base_footprint.w);
    let height = footprint_size(asset.base_footprint.h);
    let tie = u64::from(hash_number(&format!("{seed}:{SCENE_PROGRAM_LAYOUT_VERSION}:focus")));
    struct Best {
        x: i64,
        y: i64,
        score: f64,
        footprint: Vec<Point>,
        on_square: bool,
    }
    let mut best: Option<Best> = None;
    for (index, &(cx, cy)) in cells.iter().enumerate() {
        let footprint = footprint_at(cx, cy, width, height);
        if footprint.iter().any(|point| !open.contains(&(point.x, point.y)) || taken.contains(&(point.x, point.y))) {
            continue;
        }
        // Высокий предмет перед окном заслоняет и свет, и обзор.
        if asset.blocks_sight
            && footprint.iter().any(|point| {
                [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .iter()
                    .any(|(dx, dy)| edge_between(map, point.x, point.y, point.x + dx, point.y + dy).ok().flatten().is_some_and(|edge| edge.kind == EdgeKind::Window))
            })
        {
            continue;
        }
        // Простор считается от каждой клетки предмета.
        let room = footprint.iter().map(|point| clearance(map, (point.x, point.y), &taken, 4)).min().unwrap_or(i64::MAX);
        if room < 1 {
            continue;
        }
        let steps = party.map_or(FOCUS_DISTANCE_MIN, |(px, py)| (cx - px).abs() + (cy - py).abs());
        let away = if steps < FOCUS_DISTANCE_MIN {
            FOCUS_DISTANCE_MIN - steps
        } else if steps > FOCUS_DISTANCE_MAX {
            steps - FOCUS_DISTANCE_MAX
        } else {
            0
        };
        // Простор важнее расстояния, а площадь — лучше любой улицы.
        let on_square = if footprint.iter().all(|point| cell_at(map, point.x, point.y).is_some_and(|cell| cell.zone == "square")) { 30 } else { 0 };
        let score = (room * 10 - away * 2 + on_square) as f64 - ((index as u64 + tie) % 7) as f64 / 10.0;
        if best.as_ref().is_none_or(|best| score > best.score) {
            best = Some(Best { x: cx, y: cy, score, footprint, on_square: on_square > 0 });
        }
    }
    // Площадь есть, а свободного места на ней центру не нашлось: место
    // освобождается от декора, обещанное и колодец не трогаются.
    let mut removed: HashSet<usize> = HashSet::new();
    if !best.as_ref().is_some_and(|best| best.on_square) {
        if let Some(cleared) = room_on_square(map, width, height, &taken) {
            removed = cleared.remove;
            best = Some(Best { x: cleared.x, y: cleared.y, score: 0.0, footprint: cleared.footprint, on_square: true });
        }
    }
    // Без места снимать нечего: площадь, если нашлась, задала `best`.
    let Some(best) = best else { return Ok(None) };
    if !cramped.is_empty() {
        // Утварь на снятом декоре уходит вместе с ним; снятое площадью уже не
        // в списке, но его id по-прежнему держит утварь.
        let mut cramped_ids: HashSet<String> = cramped.iter().map(|index| map.props[*index].id.clone()).collect();
        for (index, prop) in map.props.iter().enumerate() {
            if removed.contains(&index) {
                continue;
            }
            let Some(under) = surface_mount(prop) else { continue };
            if cramped_ids.contains(under) {
                cramped.insert(index);
                cramped_ids.insert(prop.id.clone());
            }
        }
    }
    apply_removal(map, &removed, &cramped);
    let span = asset.scale_range.max - asset.scale_range.min;
    let scale = js::parse_number(&js::to_fixed(asset.scale_range.min + span / 2.0, 3));
    let prop = registry_prop(
        format!("program-focus-{}", asset.id),
        asset,
        best.x as f64 + width / 2.0,
        best.y as f64 + height / 2.0,
        scale,
        &best.footprint,
        0,
        true,
    );
    Ok(add_registry_prop(map, &prop))
}

/// `Math.max(1, value || 1)` для размера следа.
fn footprint_size(value: f64) -> f64 {
    let value = if value == 0.0 || value.is_nan() { 1.0 } else { value };
    sk_core::js::max_of([1.0, value])
}

/// Снять предметы по индексам в `map.props` (две волны JS-фильтров разом).
fn apply_removal(map: &mut TacticalMap, first: &HashSet<usize>, second: &HashSet<usize>) {
    if first.is_empty() && second.is_empty() {
        return;
    }
    let mut position = 0;
    map.props.retain(|_| {
        let keep = !first.contains(&position) && !second.contains(&position);
        position += 1;
        keep
    });
}

/// `buildPlatforms(map, count, { seed })`: настилы — прямоугольники 3×2
/// приподнятого деревянного пола на открытой земле, на два фута выше земли.
/// Один настил от другого и от предметов — через клетку прохода. Возвращает,
/// сколько настилов построено.
pub fn build_platforms(map: &mut TacticalMap, count: f64, seed: &str) -> usize {
    let OpenGround { cells, party, .. } = open_ground(map);
    let open: HashSet<Cell> = cells.iter().copied().collect();
    // Проход вокруг настила не держат только мешающие шагу предметы; под самим
    // настилом не лежит ничего — даже цветы и трава.
    let mut blocked = blocked_by_props(map);
    blocked.extend(door_approaches(map));
    let mut covered = blocked.clone();
    for prop in &map.props {
        covered.extend(prop_cells(prop).iter().filter_map(spot_key));
    }
    // Кандидаты — по порядку сида.
    let mut order: Vec<(Cell, u32)> =
        cells.iter().enumerate().map(|(index, cell)| (*cell, hash_number(&format!("{seed}:{SCENE_PROGRAM_LAYOUT_VERSION}:platform:{index}")))).collect();
    order.sort_by_key(|(_, key)| *key);
    let mut built = 0_usize;
    // Первый проход — с полем вокруг, второй — только сам настил и хотя бы две
    // клетки подхода.
    for strict in [true, false] {
        for &((cx, cy), _) in &order {
            if built as f64 >= count {
                break;
            }
            let level = |map: &TacticalMap, x: i64, y: i64| cell_at(map, x, y).map_or(0, |cell| cell.elevation);
            let mut footprint = Vec::new();
            for dy in 0..2 {
                for dx in 0..3 {
                    footprint.push((cx + dx, cy + dy));
                }
            }
            // На склоне настил ровный и на два фута выше самой высокой земли под
            // собой, шаг с него на соседнюю землю — не больше трёх футов.
            let top = footprint.iter().map(|(x, y)| level(map, *x, *y)).max().unwrap_or(0) + PLATFORM_ELEVATION_FEET;
            let mut fits = true;
            let mut approach = 0;
            let mut dy = -1;
            while dy <= 2 && fits {
                let mut dx = -1;
                while dx <= 3 && fits {
                    let key = (cx + dx, cy + dy);
                    let inside = (0..=2).contains(&dx) && (0..=1).contains(&dy);
                    let ground = level(map, key.0, key.1);
                    if inside {
                        if !open.contains(&key) || covered.contains(&key) || top - ground > PLATFORM_ELEVATION_FEET + OPEN_STEP_FEET {
                            fits = false;
                        }
                    } else if open.contains(&key) && !blocked.contains(&key) && (top - ground).abs() <= OPEN_STEP_FEET {
                        approach += 1;
                    } else if strict {
                        fits = false;
                    }
                    dx += 1;
                }
                dy += 1;
            }
            if !fits || approach < 2 {
                continue;
            }
            // У самого входа настил мешал бы отряду встать: не ближе пяти шагов.
            if let Some((px, py)) = party {
                if footprint.iter().any(|(x, y)| (x - px).abs() + (y - py).abs() < 5) {
                    continue;
                }
            }
            for (x, y) in &footprint {
                // Клетка открытой земли существует, значения допустимы.
                let _ = set_cell(map, *x, *y, &CellPatch { material: Some("wood"), elevation: Some(top), ..CellPatch::default() });
            }
            // Соседний настил — не вплотную.
            for dy in -1..=2 {
                for dx in -1..=3 {
                    blocked.insert((cx + dx, cy + dy));
                    covered.insert((cx + dx, cy + dy));
                }
            }
            built += 1;
        }
    }
    built
}

/// `placeThresholdStones(map, count)`: плоский камень на наружной клетке у
/// двери дома — у стольких ближайших ко входу отряда домов, сколько обещано.
/// Камень шаг не держит и проём не запирает. Возвращает, сколько поставлено.
pub fn place_threshold_stones(map: &mut TacticalMap, count: f64) -> usize {
    let Some(asset) = asset_by_id("path_stone") else { return 0 };
    let kind = zone_kinds(map);
    let party = party_spawn(map);
    let mut busy: HashSet<Option<Cell>> = map.props.iter().map(|prop| Spot::new(prop.x.floor(), prop.y.floor()).key()).collect();
    // JS пишет и ключи `NaN,NaN`, но им не совпасть ни с одной клеткой двери.
    busy.remove(&None);
    let mut outside: Vec<(i64, i64, i64, String)> = Vec::new();
    for door in &map.doors {
        let next = edge_neighbor(door.x, door.y, door.dir);
        for (point, other) in [((door.x, door.y), next), (next, (door.x, door.y))] {
            let Some(cell) = cell_at(map, point.0, point.1) else { continue };
            let other_zone = cell_at(map, other.0, other.1).map_or("", |cell| cell.zone);
            if !cell.passable || kind.get(cell.zone) == Some(&"interior") || kind.get(other_zone) != Some(&"interior") {
                continue;
            }
            let steps = party.map_or(0, |(px, py)| (point.0 - px).abs() + (point.1 - py).abs());
            outside.push((point.0, point.1, steps, door.id.clone()));
        }
    }
    outside.sort_by(|left, right| left.2.cmp(&right.2).then_with(|| sk_core::text::locale_compare(&left.3, &right.3)));
    let mut placed = 0_usize;
    for (x, y, _, door) in outside {
        if placed as f64 >= count {
            break;
        }
        if busy.contains(&Some((x, y))) {
            continue;
        }
        let prop = registry_prop(format!("program-threshold-{door}"), asset, x as f64 + 0.5, y as f64 + 0.5, asset.scale_range.min, &[], 1, false);
        add_registry_prop(map, &prop);
        busy.insert(Some((x, y)));
        placed += 1;
    }
    placed
}

/// `applyScenePlan(map, program, { seed })`: программа сцены на карте — центр,
/// настилы, камни на пороге, затем остальное обещанное прежней расстановкой и
/// ремонт доступа. `program` — `scene.map_requirements` или список `items`.
/// Отказ — только от расстановки обещанного (предмет с координатой NaN).
pub fn apply_scene_plan(map: &mut TacticalMap, program: &Value, seed: &str) -> MapResult<()> {
    let items = normalize_scene_requirements(program);
    if items.is_empty() {
        return Ok(());
    }
    let focus = match program {
        Value::Object(object) => object.get("focus").and_then(Value::as_str).unwrap_or(""),
        _ => "",
    };
    if !focus.is_empty() {
        place_scene_focus(map, &requirement_assets(focus), &format!("{seed}:focus"))?;
    }
    for item in &items {
        if requirement_terrain(&item.id) == Some("platform") {
            build_platforms(map, item.count, &format!("{seed}:platform"));
        }
        if item.id == "threshold_stone" {
            place_threshold_stones(map, sk_core::js::max_of([2.0, item.count]));
        }
    }
    let promised: Vec<RequiredProps> = items
        .iter()
        .filter(|item| item.id != "threshold_stone" && requirement_terrain(&item.id).is_none())
        .map(|item| RequiredProps { assets: requirement_assets(&item.id).into_iter().map(String::from).collect(), count: item.count })
        .filter(|item| !item.assets.is_empty())
        .collect();
    if !promised.is_empty() {
        place_required_props(map, &promised, &format!("{seed}:scene-requirements"))?;
    }
    ensure_prop_access(map);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_number_reads_little_endian_digest() {
        let digest = hash::sha256(b"x");
        assert_eq!(hash_number("x"), u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]));
    }

    #[test]
    fn footprint_size_follows_js() {
        assert_eq!(footprint_size(0.0), 1.0);
        assert_eq!(footprint_size(f64::NAN), 1.0);
        assert_eq!(footprint_size(3.0), 3.0);
        assert_eq!(footprint_size(0.5), 1.0);
        assert_eq!(footprint_at(0, 0, 2.5, 1.0).len(), 3);
    }

    #[test]
    fn focus_outdoors_reads_only_objects() {
        assert!(program_focus_outdoors(&json!({ "focus": "well" })));
        assert!(!program_focus_outdoors(&json!({ "focus": "hearth" })));
        assert!(!program_focus_outdoors(&json!(["well"])));
        assert!(!program_focus_outdoors(&Value::Null));
        assert!(!program_focus_outdoors(&json!({ "focus": "spaceship" })));
    }
}
