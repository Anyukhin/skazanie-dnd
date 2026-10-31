//! Перенос `server/rules/tactical-geometry.mjs` целиком: проходимость и
//! прозрачность клеток, занятые клетки, кратчайший путь с учётом площади
//! существа и рёбер, линия обзора и траектория, укрытие и высота. Задача Р1.
//!
//! Чистые функции состояния — без костей и событий. Точки — числа JS
//! ([`Point`], `f64`): координаты приходят из `Number(…)` и сравниваются как
//! числа. Ключ клетки JS — строка `` `${x},${y}` ``; здесь — [`Key`], биты
//! чисел, где `-0` и `0` (а также все `NaN`) совпадают, как совпадают их
//! строки в JS. Так множества и словари клеток ведут себя как `Set`/`Map`
//! движка и на нецелых координатах.
//!
//! Кэш разобранных карт JS (`WeakMap` по объекту `scene.map`) не повторён:
//! карта разбирается заново, а горячие пути (поиск пути, области, укрытие)
//! разбирают её один раз на вызов через [`Scene`] — на неизменном состоянии
//! это то же, что попадание в кэш.
//!
//! Мир NPC (`server/npc-positioning.mjs`, крейт `sk-npc-world`) геометрия
//! читает через переходник [`npc_positioning`].

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use sk_core::{game, js, RuleError};
use sk_geometry::actor_footprint::footprint_size_for;
use sk_geometry::{GridCell, Point};
use sk_tactical::tactical_map::{self as tmap, Cover, EdgeDir, EdgeKind, TacticalCell, TacticalEdge, TacticalMap};

pub mod npc_positioning;

// --- точки и ключи ----------------------------------------------------------

/// Ключ клетки: строка JS `` `${x},${y}` `` над числами.
pub type Key = (u64, u64);
/// `Set` ключей клеток.
pub type KeySet = HashSet<Key>;

const CANONICAL_NAN: u64 = 0x7ff8_0000_0000_0000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn coordinate_bits(value: f64) -> u64 {
    if value == 0.0 {
        0
    } else if value.is_nan() {
        CANONICAL_NAN
    } else {
        value.to_bits()
    }
}

/// Ключ точки (`positionKey` без строки).
pub fn key(x: f64, y: f64) -> Key {
    (coordinate_bits(x), coordinate_bits(y))
}

/// Ключ точки.
pub fn key_of(point: Point) -> Key {
    key(point.x, point.y)
}

/// `positionKey(position)`: `` `${x},${y}` ``.
pub fn position_key(point: Point) -> String {
    format!("{},{}", js::f64_string(point.x), js::f64_string(point.y))
}

/// `Number.isSafeInteger(value)`.
pub fn is_safe(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

/// `Number.isInteger(value)` как целое `i64` (за пределами `i64` клеток нет).
fn integer(value: f64) -> Option<i64> {
    (value.is_finite() && value.fract() == 0.0 && value.abs() < 9.2e18).then_some(value as i64)
}

/// `Math.sign(value)`: ноль, `-0` и `NaN` остаются собой.
pub fn sign(value: f64) -> f64 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else {
        value
    }
}

/// Ложность числа JS (`0`, `-0`, `NaN`).
pub fn falsy(value: f64) -> bool {
    value == 0.0 || value.is_nan()
}

/// `Math.max(a, b)`: `NaN` заражает результат.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: `NaN` заражает результат.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// Точка из `{ x, y }` целой клетки.
pub fn grid_point(cell: GridCell) -> Point {
    Point::new(cell.x as f64, cell.y as f64)
}

/// Точка `{ x, y }` в JSON (числа — как их печатает `JSON.stringify`).
pub fn point_json(point: Point) -> Value {
    json!({ "x": js::num(point.x), "y": js::num(point.y) })
}

/// Список точек в JSON.
pub fn points_json(points: &[Point]) -> Value {
    Value::Array(points.iter().copied().map(point_json).collect())
}

/// `actorPosition(state, id)` числами JS.
pub fn actor_point(state: &Value, id: &str) -> Option<Point> {
    game::actor_position(state, id).map(|position| Point::new(position.x as f64, position.y as f64))
}

/// Ненулевая точка из значения JSON: `undefined`, `null` и прочие ложные
/// значения — `None` (так их отсекают `!position`/`!center`), иначе
/// `{ x: Number(value.x), y: Number(value.y) }` (у не-объекта — `NaN`).
pub fn truthy_point(value: Option<&Value>) -> Option<Point> {
    js::truthy(value).then(|| Point::from_value(value))
}

/// `footprintCellsFor(actor, anchor)`: `anchor` `None` — координаты самой
/// карточки (`anchor ?? actor`). Клетки — безопасные целые.
pub fn footprint_cells(actor: Option<&Value>, anchor: Option<Point>) -> Vec<Point> {
    let (x, y) = match anchor {
        Some(point) => (point.x, point.y),
        None => match actor {
            Some(actor @ Value::Object(_)) => (js::number(actor.get("x")), js::number(actor.get("y"))),
            _ => (f64::NAN, f64::NAN),
        },
    };
    if !is_safe(x) || !is_safe(y) {
        return Vec::new();
    }
    footprint_square(footprint_size_for(actor), x, y)
}

/// Квадрат `side × side` от верхнего левого угла, построчно.
pub fn footprint_square(side: i64, x: f64, y: f64) -> Vec<Point> {
    let mut cells = Vec::with_capacity((side.max(0) * side.max(0)) as usize);
    for dy in 0..side {
        for dx in 0..side {
            cells.push(Point::new(x + dx as f64, y + dy as f64));
        }
    }
    cells
}

/// `actorFootprintCellsAt(state, id, position = actorPosition(state, id))`.
///
/// Служебный адаптер между состоянием и чистой геометрией footprint. Размер
/// читается только из `actor.footprint.version === 1`; старые актёры остаются
/// одной клеткой даже при сохранённом текстовом `size`.
pub fn actor_footprint_cells_at(state: &Value, id: &str, position: Option<Point>) -> Vec<Point> {
    let anchor = position.or_else(|| actor_point(state, id));
    footprint_cells(game::find_actor(state, id), anchor)
}

// --- клетки сцены и карта ---------------------------------------------------

/// `tacticalCellMap(state)`: клетки `scene.cells` по ключу, последняя побеждает.
pub type CellMap<'a> = HashMap<Key, &'a Value>;

/// `tacticalCellMap(state)`.
pub fn tactical_cell_map(state: &Value) -> CellMap<'_> {
    let mut cells = HashMap::new();
    let Some(list) = state.get("scene").and_then(|scene| scene.get("cells")).and_then(Value::as_array) else { return cells };
    for cell in list {
        let x = js::number(cell.get("x"));
        let y = js::number(cell.get("y"));
        if is_safe(x) && is_safe(y) {
            cells.insert(key(x, y), cell);
        }
    }
    cells
}

/// `sceneTacticalMap(state)`: разобранная `scene.map`; повреждённая — `None`.
pub fn scene_tactical_map(state: &Value) -> Option<TacticalMap> {
    sk_tactical::combat_bounds::scene_tactical_map(state)
}

/// Клетки и карта сцены, разобранные один раз на вызов (лениво).
pub struct Scene<'a> {
    pub state: &'a Value,
    cells: OnceCell<CellMap<'a>>,
    map: OnceCell<Option<TacticalMap>>,
}

impl<'a> Scene<'a> {
    pub fn new(state: &'a Value) -> Self {
        Self { state, cells: OnceCell::new(), map: OnceCell::new() }
    }

    /// `tacticalCellMap(state)`.
    pub fn cells(&self) -> &CellMap<'a> {
        self.cells.get_or_init(|| tactical_cell_map(self.state))
    }

    /// `sceneTacticalMap(state)`.
    pub fn map(&self) -> Option<&TacticalMap> {
        self.map.get_or_init(|| scene_tactical_map(self.state)).as_ref()
    }

    /// Клетка `scene.cells` по точке.
    pub fn cell(&self, point: Point) -> Option<&'a Value> {
        self.cells().get(&key_of(point)).copied()
    }
}

/// `isWalkableCell(cell)`.
///
/// Нераскрытая клетка проходима: иначе исследование невозможно в принципе.
/// Стены и вода остаются непроходимыми независимо от тумана.
pub fn is_walkable_cell(cell: Option<&Value>) -> bool {
    let Some(cell) = cell else { return false };
    let kind = cell.get("type");
    let kind = if js::truthy(kind) { js::string(kind).to_lowercase() } else { "floor".into() };
    kind == "floor" || kind == "door"
}

/// `isTransparentCell(cell)`: непрозрачны только стена и клетка вне карты.
pub fn is_transparent_cell(cell: Option<&Value>) -> bool {
    let Some(cell) = cell else { return false };
    let kind = cell.get("type").filter(|kind| !kind.is_null());
    let kind = kind.map_or_else(|| "floor".to_string(), |kind| js::string(Some(kind)).to_lowercase());
    kind != "wall"
}

/// `isTransparentMapCell(cell)`: то же правило для клетки слоя карты.
pub fn is_transparent_map_cell(cell: Option<&TacticalCell<'_>>) -> bool {
    cell.is_some_and(|cell| cell.passable || cell.surface == "water")
}

/// `cellAt(map, x, y)` над числами JS: нецелые координаты — клетки нет.
pub fn map_cell_at(map: &TacticalMap, x: f64, y: f64) -> Option<TacticalCell<'_>> {
    tmap::cell_at(map, integer(x)?, integer(y)?)
}

/// `edgeBetween(map, a, b)` над числами JS. Несоседние клетки (в JS —
/// исключение `EDGE_CELLS_NOT_ADJACENT`) здесь дают `None`: все вызовы
/// движка передают соседей.
pub fn map_edge_between(map: &TacticalMap, a: Point, b: Point) -> Option<&TacticalEdge> {
    let (x, y, dir) = if a.y == b.y && b.x == a.x + 1.0 {
        (a.x, a.y, EdgeDir::E)
    } else if a.y == b.y && b.x == a.x - 1.0 {
        (b.x, b.y, EdgeDir::E)
    } else if a.x == b.x && b.y == a.y + 1.0 {
        (a.x, a.y, EdgeDir::S)
    } else if a.x == b.x && b.y == a.y - 1.0 {
        (b.x, b.y, EdgeDir::S)
    } else {
        return None;
    };
    map.edge(integer(x)?, integer(y)?, dir)
}

/// `movementStepBlocked(map, a.x, a.y, b.x, b.y)` над числами JS.
pub fn map_step_blocked(map: &TacticalMap, a: Point, b: Point) -> bool {
    if map_edge_between(map, a, b).is_none() {
        return false;
    }
    match (integer(a.x), integer(a.y), integer(b.x), integer(b.y)) {
        (Some(ax), Some(ay), Some(bx), Some(by)) => tmap::movement_step_blocked(map, ax, ay, bx, by).unwrap_or(false),
        _ => false,
    }
}

/// Дальность обзора, на которую распахнутая дверь открывает соседнее помещение.
pub const DOORWAY_SIGHT_CELLS: f64 = 9.0;

/// Дальность разведки при перемещении: шаг открывает только то, что вокруг героя.
pub const MOVEMENT_SIGHT_CELLS: f64 = 6.0;

/// `cellsVisibleFrom(map, origin, { radius, openedDoorId })`: обход в ширину
/// по клеткам карты, не пересекающий глухие рёбра и закрытые двери (кроме
/// той, что открывается сейчас). Стену видно, но сквозь неё не смотрят.
pub fn cells_visible_from(map: &TacticalMap, origin: Point, radius: f64, opened_door_id: Option<&str>) -> Vec<GridCell> {
    let opened = opened_door_id.unwrap_or("");
    let (start_x, start_y) = (origin.x.floor(), origin.y.floor());
    if !is_safe(start_x) || !is_safe(start_y) {
        return Vec::new();
    }
    let start = GridCell::new(start_x as i64, start_y as i64);
    if tmap::cell_at(map, start.x, start.y).is_none() {
        return Vec::new();
    }
    let mut seen: HashMap<(i64, i64), f64> = HashMap::from([((start.x, start.y), 0.0)]);
    let mut queue = vec![start];
    let mut found = vec![start];
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor];
        cursor += 1;
        let distance = seen.get(&(current.x, current.y)).copied().unwrap_or(0.0);
        if distance >= radius {
            continue;
        }
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let next = GridCell::new(current.x + dx, current.y + dy);
            if seen.contains_key(&(next.x, next.y)) {
                continue;
            }
            let Some(cell) = tmap::cell_at(map, next.x, next.y) else { continue };
            let edge = tmap::edge_between(map, current.x, current.y, next.x, next.y).ok().flatten();
            // Дверь, которую открывают прямо сейчас, ещё числится закрытой.
            let just_opened = !opened.is_empty() && edge.and_then(|edge| edge.door_id.as_deref()).unwrap_or("") == opened;
            if edge.is_some_and(|edge| edge.blocks_sight) && !just_opened {
                continue;
            }
            seen.insert((next.x, next.y), distance + 1.0);
            found.push(next);
            if is_transparent_map_cell(Some(&cell)) {
                queue.push(next);
            }
        }
    }
    found
}

/// `sightEdgeBlocked(map, from, to)`: перекрыт ли шаг линии обзора ребром —
/// стеной или иной кромкой с `blocksSight`, либо закрытой дверью. Диагональ
/// перекрыта, если перекрыта хотя бы одна из двух ортогональных кромок угла.
pub fn sight_edge_blocked(map: Option<&TacticalMap>, from: Point, to: Point) -> bool {
    let Some(map) = map else { return false };
    let dx = sign(to.x - from.x);
    let dy = sign(to.y - from.y);
    let candidates: Vec<(Point, Point)> = if dx.abs() + dy.abs() == 1.0 {
        vec![(from, to)]
    } else if !falsy(dx) && !falsy(dy) {
        vec![(from, Point::new(from.x + dx, from.y)), (from, Point::new(from.x, from.y + dy))]
    } else {
        Vec::new()
    };
    candidates.into_iter().any(|(start, end)| {
        let edge = map_edge_between(map, start, end);
        edge.is_some_and(|edge| edge.blocks_sight) || edge.is_some_and(|edge| edge.kind == EdgeKind::Door) && map_step_blocked(map, start, end)
    })
}

// --- занятость ---------------------------------------------------------------

fn players(state: &Value) -> &[Value] {
    state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn enemies(state: &Value) -> &[Value] {
    state.get("enemies").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `occupiesSpace(state, actor, includeDowned)`: герой на нуле хитов, пока
/// он не погиб, — всё ещё существо на своей клетке.
fn occupies_space(state: &Value, actor: &Value, include_downed: bool) -> bool {
    if game::is_living_actor(actor) {
        return true;
    }
    if !include_downed {
        return false;
    }
    let id = game::actor_id(actor);
    let status = js::path(state, &["mechanics", "death", "heroes"]).and_then(|heroes| heroes.get(&id)).and_then(|hero| hero.get("status"));
    !js::is_false(actor.get("alive")) && players(state).iter().any(|player| game::actor_id(player) == id) && status.and_then(Value::as_str) != Some("dead")
}

/// `downedHeroPositions(state, exceptActorId)`: клетки умирающих героев —
/// остановиться на них нельзя, пройти сквозь — можно.
pub fn downed_hero_positions(state: &Value, except_actor_id: Option<&str>) -> KeySet {
    let except = except_actor_id.unwrap_or("");
    let mut cells = HashSet::new();
    for actor in players(state) {
        if game::actor_id(actor) == except || game::is_living_actor(actor) || !occupies_space(state, actor, true) {
            continue;
        }
        for cell in actor_footprint_cells_at(state, &game::actor_id(actor), None) {
            cells.insert(key_of(cell));
        }
    }
    cells
}

/// `movementSide(state, actor)`: отряд, противники или неизвестная сторона.
fn movement_side(state: &Value, actor: &Value) -> Option<&'static str> {
    let id = game::actor_id(actor);
    if players(state).iter().any(|player| game::actor_id(player) == id) {
        return Some("party");
    }
    if actor.get("kind").and_then(Value::as_str) == Some("summon") && (js::truthy(actor.get("ownerId")) || js::truthy(actor.get("owner_id"))) {
        match actor.get("faction").and_then(Value::as_str) {
            Some("party") => return Some("party"),
            Some("hostile") => return None,
            _ => {}
        }
    }
    if enemies(state).iter().any(|enemy| game::actor_id(enemy) == id) {
        return Some("enemies");
    }
    None
}

/// `allyPassablePositions(state, moverId)`: клетки живых союзников — сквозь
/// них проходят, остановиться на них нельзя.
pub fn ally_passable_positions(state: &Value, mover_id: &str) -> KeySet {
    let mut cells = HashSet::new();
    let side = game::find_actor(state, mover_id).and_then(|mover| movement_side(state, mover));
    let Some(side) = side else { return cells };
    for actor in game::list_actors(state) {
        if game::actor_id(actor) == mover_id || !game::is_living_actor(actor) || movement_side(state, actor) != Some(side) {
            continue;
        }
        for cell in actor_footprint_cells_at(state, &game::actor_id(actor), None) {
            cells.insert(key_of(cell));
        }
    }
    cells
}

/// Истинность `value?.length` у поля JSON.
pub(crate) fn has_length(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(object)) => js::truthy(object.get("length")),
        _ => false,
    }
}

/// `state?.npc_world?.placements?.length || state?.scene_npcs?.length`.
pub(crate) fn has_scene_npcs(state: &Value) -> bool {
    has_length(js::path(state, &["npc_world", "placements"])) || has_length(state.get("scene_npcs"))
}

/// `occupiedPositions(state, exceptActorId, { includeDowned })`: клетки
/// участников и постов социальных NPC сцены.
pub fn occupied_positions(state: &Value, except_actor_id: Option<&str>, include_downed: bool) -> KeySet {
    let except = except_actor_id.unwrap_or("");
    let mut occupied = HashSet::new();
    for actor in game::list_actors(state) {
        if game::actor_id(actor) == except || !occupies_space(state, actor, include_downed) {
            continue;
        }
        for cell in actor_footprint_cells_at(state, &game::actor_id(actor), None) {
            occupied.insert(key_of(cell));
        }
    }
    if has_scene_npcs(state) {
        occupied.extend(npc_positioning::scene_npc_occupied_cells(state));
    }
    occupied
}

/// `footprintPlacementEdgesBlocked(map, actor, anchor)`: внутренние рёбра
/// площади тоже должны быть проходимыми для тела.
pub fn footprint_placement_edges_blocked(map: Option<&TacticalMap>, actor: Option<&Value>, anchor: Option<Point>) -> bool {
    let Some(map) = map else { return false };
    if footprint_size_for(actor) <= 1 {
        return false;
    }
    let cells = footprint_cells(actor, anchor);
    let keys: KeySet = cells.iter().copied().map(key_of).collect();
    for cell in &cells {
        for (dx, dy) in [(1.0, 0.0), (0.0, 1.0)] {
            let next = Point::new(cell.x + dx, cell.y + dy);
            if keys.contains(&key_of(next)) && map_step_blocked(map, *cell, next) {
                return true;
            }
        }
    }
    false
}

/// `footprintStepBlocked(map, actor, from, to)`: каждый пересечённый край при
/// сдвиге anchor на одну клетку.
pub fn footprint_step_blocked(map: Option<&TacticalMap>, actor: Option<&Value>, from: Point, to: Point) -> bool {
    let Some(map) = map else { return false };
    if footprint_size_for(actor) <= 1 {
        return map_step_blocked(map, from, to);
    }
    if footprint_placement_edges_blocked(Some(map), actor, Some(from)) || footprint_placement_edges_blocked(Some(map), actor, Some(to)) {
        return true;
    }
    footprint_cells(actor, Some(from)).into_iter().any(|cell| {
        let next = Point::new(cell.x + (to.x - from.x), cell.y + (to.y - from.y));
        map_step_blocked(map, cell, next)
    })
}

/// `movementBlockedProp(prop)`: `prop.blocksMove === true`.
pub fn movement_blocked_prop(prop: &tmap::TacticalProp) -> bool {
    prop.blocks_move
}

/// `propMovementPositions(map)`: клетки server-owned реквизита с `blocksMove`.
pub fn prop_movement_positions(map: Option<&TacticalMap>) -> KeySet {
    let mut blocked = HashSet::new();
    for prop in map.map(|map| map.props.as_slice()).unwrap_or(&[]) {
        if !movement_blocked_prop(prop) {
            continue;
        }
        if prop.footprint.is_empty() {
            let (x, y) = (prop.x.floor(), prop.y.floor());
            if is_safe(x) && is_safe(y) {
                blocked.insert(key(x, y));
            }
        } else {
            for cell in &prop.footprint {
                blocked.insert(key(cell.x as f64, cell.y as f64));
            }
        }
    }
    blocked
}

// --- кратчайший путь ---------------------------------------------------------

/// Цена шага для взвешенного поиска: `stepCost({ x, y }, map)`.
pub type StepCost<'a> = &'a dyn Fn(Point, Option<&TacticalMap>) -> f64;

/// Параметры [`shortest_tactical_path`].
#[derive(Clone, Copy, Default)]
pub struct PathOptions<'a> {
    /// `allowOccupiedDestination`.
    pub allow_occupied_destination: bool,
    /// `stepCost`: `None` — поиск в ширину по числу шагов.
    pub step_cost: Option<StepCost<'a>>,
    /// `tacticalMap`: `None` — не передана (берётся карта сцены), `Some(None)`
    /// — явно без карты.
    pub tactical_map: Option<Option<&'a TacticalMap>>,
}

struct Frontier {
    key: Key,
    point: Point,
    cost: f64,
}

/// `shortestTacticalPath(state, actorId, destination, options)`: кратчайший
/// ортогональный путь без стартовой клетки; `None` — пути нет.
pub fn shortest_tactical_path(state: &Value, actor_id: &str, destination: Point, options: PathOptions<'_>) -> Option<Vec<Point>> {
    let from = actor_point(state, actor_id)?;
    let to = destination;
    if !is_safe(to.x) || !is_safe(to.y) {
        return None;
    }
    if from.x == to.x && from.y == to.y {
        return Some(Vec::new());
    }
    let cells = tactical_cell_map(state);
    let from_cell = cells.get(&key_of(from)).copied();
    if cells.is_empty() || from_cell.is_none() || from_cell.is_some_and(|cell| js::is_false(cell.get("revealed"))) {
        return None;
    }
    let owned_map;
    let map: Option<&TacticalMap> = match options.tactical_map {
        Some(map) => map,
        None => {
            owned_map = scene_tactical_map(state);
            owned_map.as_ref()
        }
    };
    let prop_occupied = if map.is_some() { prop_movement_positions(map) } else { HashSet::new() };
    let occupied = occupied_positions(state, Some(actor_id), true);
    let mut passable = downed_hero_positions(state, Some(actor_id));
    passable.extend(ally_passable_positions(state, actor_id));
    let pass_occupied: KeySet = if passable.is_empty() { occupied.clone() } else { occupied.iter().copied().filter(|key| !passable.contains(key)).collect() };
    let scene_npcs = has_scene_npcs(state);
    let npc_transit = if scene_npcs { npc_positioning::scene_npc_transit_cells(state) } else { HashSet::new() };
    let npc_occupied = if scene_npcs { npc_positioning::scene_npc_occupied_cells(state) } else { HashSet::new() };
    let start = key_of(from);
    let target = key_of(to);
    let mover = game::find_actor(state, actor_id);
    let can_move_through_larger = mover.and_then(|mover| js::path(mover, &["speciesBenefits", "mechanics", "move_through_larger"])) == Some(&Value::Bool(true));
    let mut occupied_actors: HashMap<Key, Vec<&Value>> = HashMap::new();
    if can_move_through_larger {
        for candidate in game::list_actors(state) {
            if game::actor_id(candidate) == actor_id || !game::is_living_actor(candidate) {
                continue;
            }
            for cell in actor_footprint_cells_at(state, &game::actor_id(candidate), None) {
                occupied_actors.entry(key_of(cell)).or_default().push(candidate);
            }
        }
    }
    let mover_side = footprint_size_for(mover);
    let mover_rank = creature_size_rank(mover);
    let can_pass_occupied = |position: Point| -> bool {
        if key_of(position) == target || !can_move_through_larger {
            return false;
        }
        if mover_side == 1 {
            let occupants = occupied_actors.get(&key_of(position)).map(Vec::as_slice).unwrap_or(&[]);
            return !occupants.is_empty() && occupants.iter().all(|occupant| creature_size_rank(Some(occupant)) > mover_rank);
        }
        let mut occupants: Vec<(String, &Value)> = Vec::new();
        for cell in footprint_cells(mover, Some(position)) {
            for occupant in occupied_actors.get(&key_of(cell)).map(Vec::as_slice).unwrap_or(&[]) {
                let id = game::actor_id(occupant);
                match occupants.iter_mut().find(|(existing, _)| *existing == id) {
                    Some(slot) => slot.1 = occupant,
                    None => occupants.push((id, occupant)),
                }
            }
        }
        !occupants.is_empty() && occupants.iter().all(|(_, occupant)| creature_size_rank(Some(occupant)) > mover_rank)
    };
    let can_occupy_anchor = |position: Point, allow_target: bool| -> bool {
        if mover_side == 1 {
            let key = key_of(position);
            if !is_walkable_cell(cells.get(&key).copied()) || prop_occupied.contains(&key) {
                return false;
            }
            if npc_occupied.contains(&key) && (key == target || !npc_transit.contains(&key)) {
                return false;
            }
            if allow_target {
                return true;
            }
            if key == target && occupied.contains(&key) {
                return false;
            }
            return !pass_occupied.contains(&key) || npc_transit.contains(&key) || can_pass_occupied(position);
        }
        let footprint = footprint_cells(mover, Some(position));
        if footprint.is_empty() {
            return false;
        }
        if map.is_some() && footprint_placement_edges_blocked(map, mover, Some(position)) {
            return false;
        }
        let pass_through_larger = can_pass_occupied(position);
        let blocking = if key_of(position) == target { &occupied } else { &pass_occupied };
        for cell in footprint {
            let key = key_of(cell);
            if !is_walkable_cell(cells.get(&key).copied()) || prop_occupied.contains(&key) {
                return false;
            }
            if npc_occupied.contains(&key) && (key == target || !npc_transit.contains(&key)) {
                return false;
            }
            if !blocking.contains(&key) || npc_transit.contains(&key) || allow_target {
                continue;
            }
            if !pass_through_larger {
                return false;
            }
        }
        true
    };
    let step_blocked = |from: Point, next: Point| -> bool {
        match map {
            Some(map) if mover_side > 1 => footprint_step_blocked(Some(map), mover, from, next),
            Some(map) => map_step_blocked(map, from, next),
            None => false,
        }
    };
    if !can_occupy_anchor(to, options.allow_occupied_destination) {
        return None;
    }
    let mut previous: HashMap<Key, Option<Point>> = HashMap::from([(start, None)]);
    match options.step_cost {
        None => {
            let mut queue = vec![from];
            let mut cursor = 0;
            while cursor < queue.len() {
                let current = queue[cursor];
                cursor += 1;
                if key_of(current) == target {
                    break;
                }
                for next in neighbours(current) {
                    let next_key = key_of(next);
                    if previous.contains_key(&next_key) || !can_occupy_anchor(next, options.allow_occupied_destination && next_key == target) {
                        continue;
                    }
                    if step_blocked(current, next) {
                        continue;
                    }
                    previous.insert(next_key, Some(current));
                    queue.push(next);
                }
            }
        }
        Some(step_cost) => {
            let mut costs: HashMap<Key, f64> = HashMap::from([(start, 0.0)]);
            let mut frontier: Vec<Frontier> = vec![Frontier { key: start, point: from, cost: 0.0 }];
            while !frontier.is_empty() {
                let Some(current) = pop_frontier(&mut frontier) else { break };
                if costs.get(&current.key).copied() != Some(current.cost) {
                    continue;
                }
                if current.key == target {
                    break;
                }
                for next in neighbours(current.point) {
                    let next_key = key_of(next);
                    if !can_occupy_anchor(next, options.allow_occupied_destination && next_key == target) {
                        continue;
                    }
                    if step_blocked(current.point, next) {
                        continue;
                    }
                    let raw = step_cost(next, map);
                    let weight = js_max(1.0, if falsy(raw) { 1.0 } else { raw });
                    let next_cost = current.cost + weight;
                    if next_cost >= costs.get(&next_key).copied().unwrap_or(f64::INFINITY) {
                        continue;
                    }
                    costs.insert(next_key, next_cost);
                    previous.insert(next_key, Some(current.point));
                    push_frontier(&mut frontier, Frontier { key: next_key, point: next, cost: next_cost });
                }
            }
        }
    }
    if !previous.contains_key(&target) {
        return None;
    }
    let mut path = Vec::new();
    let mut cursor = Some(to);
    while let Some(point) = cursor {
        if key_of(point) == start {
            break;
        }
        path.push(point);
        cursor = previous.get(&key_of(point)).copied().flatten();
    }
    path.reverse();
    Some(path)
}

/// Соседи в порядке JS: `[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]`.
fn neighbours(point: Point) -> [Point; 4] {
    [Point::new(point.x + 1.0, point.y), Point::new(point.x - 1.0, point.y), Point::new(point.x, point.y + 1.0), Point::new(point.x, point.y - 1.0)]
}

/// `pushFrontier`: двоичная куча по цене, как в JS (порядок равных важен).
fn push_frontier(frontier: &mut Vec<Frontier>, entry: Frontier) {
    frontier.push(entry);
    let mut child = frontier.len() - 1;
    while child > 0 {
        let parent = (child - 1) / 2;
        if frontier[parent].cost <= frontier[child].cost {
            break;
        }
        frontier.swap(parent, child);
        child = parent;
    }
}

/// `popFrontier`: вершина кучи; последняя запись встаёт на её место и тонет.
fn pop_frontier(frontier: &mut Vec<Frontier>) -> Option<Frontier> {
    if frontier.is_empty() {
        return None;
    }
    let last = frontier.pop()?;
    if frontier.is_empty() {
        return Some(last);
    }
    let first = std::mem::replace(&mut frontier[0], last);
    let mut parent = 0;
    loop {
        let left = parent * 2 + 1;
        let right = left + 1;
        let mut smallest = parent;
        if left < frontier.len() && frontier[left].cost < frontier[smallest].cost {
            smallest = left;
        }
        if right < frontier.len() && frontier[right].cost < frontier[smallest].cost {
            smallest = right;
        }
        if smallest == parent {
            break;
        }
        frontier.swap(parent, smallest);
        parent = smallest;
    }
    Some(first)
}

// --- линия и траектория ------------------------------------------------------

/// `lineCells(from, to)`: клетки отрезка по Брезенхэму без начальной.
///
/// В JS цикл не кончается, если разность концов не целая (дробная или `NaN`
/// координата): `x` никогда не совпадёт с `to.x`. Все вызовы движка передают
/// целые клетки; здесь такой вход даёт пустой список.
pub fn line_cells(from: Point, to: Point) -> Vec<Point> {
    let (span_x, span_y) = (to.x - from.x, to.y - from.y);
    if !(span_x.is_finite() && span_x.fract() == 0.0 && span_y.is_finite() && span_y.fract() == 0.0) {
        return Vec::new();
    }
    let mut result = Vec::new();
    let (mut x, mut y) = (from.x, from.y);
    let dx = (to.x - x).abs();
    let sx = if x < to.x { 1.0 } else { -1.0 };
    let dy = -(to.y - y).abs();
    let sy = if y < to.y { 1.0 } else { -1.0 };
    let mut error = dx + dy;
    while x != to.x || y != to.y {
        let twice = 2.0 * error;
        if twice >= dy {
            error += dy;
            x += sx;
        }
        if twice <= dx {
            error += dx;
            y += sy;
        }
        result.push(Point::new(x, y));
    }
    result
}

/// `finalStepBlocked(map, from, trajectory)`: кромка перед клеткой цели.
fn final_step_blocked(map: Option<&TacticalMap>, from: Point, trajectory: &[Point]) -> bool {
    let (Some(_), Some(last)) = (map, trajectory.last()) else { return false };
    let previous = if trajectory.len() > 1 { trajectory[trajectory.len() - 2] } else { from };
    sight_edge_blocked(map, previous, *last)
}

/// Перекрыта ли линия: внутренние клетки непрозрачны или кромка закрыта.
fn line_interior_blocked(scene: &Scene<'_>, from: Point, trajectory: &[Point]) -> bool {
    let map = scene.map();
    let interior = &trajectory[..trajectory.len().saturating_sub(1)];
    interior.iter().enumerate().any(|(index, point)| {
        let previous = if index == 0 { from } else { trajectory[index - 1] };
        !is_transparent_cell(scene.cell(*point)) || sight_edge_blocked(map, previous, *point)
    }) || final_step_blocked(map, from, trajectory)
}

const TRAJECTORY_BLOCKED: &str = "TRAJECTORY_BLOCKED";

/// `assertClearTrajectory(state, from, to)`.
pub fn assert_clear_trajectory(state: &Value, from: Point, to: Point) -> Result<Vec<Point>, RuleError> {
    assert_clear_trajectory_in(&Scene::new(state), from, to)
}

/// [`assert_clear_trajectory`] над уже разобранной сценой.
pub fn assert_clear_trajectory_in(scene: &Scene<'_>, from: Point, to: Point) -> Result<Vec<Point>, RuleError> {
    let trajectory = line_cells(from, to);
    if !is_transparent_cell(scene.cell(to)) {
        return Err(RuleError::new(TRAJECTORY_BLOCKED, "Траектория заканчивается за стеной или краем карты"));
    }
    if line_interior_blocked(scene, from, &trajectory) {
        return Err(RuleError::new(TRAJECTORY_BLOCKED, "Траекторию перекрывает стена или граница карты"));
    }
    Ok(trajectory)
}

/// Подробности одной линии: `{ trajectory, blocked }`.
#[derive(Clone, Debug, PartialEq)]
pub struct TrajectoryDetails {
    pub trajectory: Vec<Point>,
    pub blocked: bool,
}

impl TrajectoryDetails {
    pub fn to_value(&self) -> Value {
        json!({ "trajectory": points_json(&self.trajectory), "blocked": self.blocked })
    }
}

/// `trajectoryDetails(state, from, to)`.
pub fn trajectory_details(state: &Value, from: Point, to: Point) -> TrajectoryDetails {
    trajectory_details_in(&Scene::new(state), from, to)
}

/// [`trajectory_details`] над уже разобранной сценой.
pub fn trajectory_details_in(scene: &Scene<'_>, from: Point, to: Point) -> TrajectoryDetails {
    let trajectory = line_cells(from, to);
    let blocked = !is_transparent_cell(scene.cell(to)) || line_interior_blocked(scene, from, &trajectory);
    TrajectoryDetails { trajectory, blocked }
}

/// Линия между клетками площадей двух существ.
#[derive(Clone, Debug, PartialEq)]
pub struct ActorTrajectory {
    pub start: Point,
    pub end: Point,
    pub trajectory: Vec<Point>,
    pub blocked: bool,
}

impl ActorTrajectory {
    pub fn to_value(&self) -> Value {
        json!({ "start": point_json(self.start), "end": point_json(self.end), "trajectory": points_json(&self.trajectory), "blocked": self.blocked })
    }
}

/// `actorTrajectoryDetails(state, attackerId, targetId, from, to, { allowHiddenTarget })`:
/// все пары клеток, которыми можно соединить площади двух существ.
pub fn actor_trajectory_details(state: &Value, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>, allow_hidden_target: bool) -> Vec<ActorTrajectory> {
    actor_trajectory_details_in(&Scene::new(state), attacker_id, target_id, from, to, allow_hidden_target)
}

/// [`actor_trajectory_details`] над уже разобранной сценой.
pub fn actor_trajectory_details_in(scene: &Scene<'_>, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>, allow_hidden_target: bool) -> Vec<ActorTrajectory> {
    let state = scene.state;
    let starts = footprint_cells(game::find_actor(state, attacker_id), from);
    let ends = footprint_cells(game::find_actor(state, target_id), to);
    let revealed = |cells: &[Point]| -> Vec<Point> {
        if scene.cells().is_empty() {
            return cells.to_vec();
        }
        cells.iter().copied().filter(|cell| scene.cell(*cell).is_some_and(|cell| js::is_true(cell.get("revealed")))).collect()
    };
    let visible_starts = revealed(&starts);
    let visible_ends = revealed(&ends);
    let source_cells = if !visible_starts.is_empty() { visible_starts } else if allow_hidden_target { starts } else { Vec::new() };
    let target_cells = if !visible_ends.is_empty() { visible_ends } else if allow_hidden_target { ends } else { Vec::new() };
    let mut result = Vec::with_capacity(source_cells.len() * target_cells.len());
    for start in &source_cells {
        for end in &target_cells {
            let details = trajectory_details_in(scene, *start, *end);
            result.push(ActorTrajectory { start: *start, end: *end, trajectory: details.trajectory, blocked: details.blocked });
        }
    }
    result
}

// --- укрытие и высота --------------------------------------------------------

/// `TERRAIN_COVER`: какие старые «фичи» клетки прикрывают и насколько.
pub const TERRAIN_COVER: [(&str, &str); 16] = [
    ("pillar", "three-quarters"),
    ("statue", "three-quarters"),
    ("tree", "three-quarters"),
    ("altar", "half"),
    ("barrel", "half"),
    ("bed", "half"),
    ("bookshelf", "half"),
    ("bush", "half"),
    ("chest", "half"),
    ("console", "half"),
    ("crate", "half"),
    ("fireplace", "half"),
    ("grave", "half"),
    ("rock", "half"),
    ("table", "half"),
    ("well", "half"),
];

/// Уровень `TERRAIN_COVER[feature]` по собственному ключу.
fn terrain_cover(feature: &str) -> Option<&'static str> {
    if let Some((_, level)) = TERRAIN_COVER.iter().find(|(name, _)| *name == feature) {
        return Some(level);
    }
    None
}

/// `COVER_BONUS[level]`.
pub fn cover_bonus(level: &str) -> i64 {
    match level {
        "half" => 2,
        "three-quarters" => 5,
        _ => 0,
    }
}

/// `propCoverByCell(state)`: укрытие предметов карты по их клеткам (лучшее
/// на клетку).
fn prop_cover_by_cell(map: Option<&TacticalMap>) -> HashMap<Key, (&'static str, String)> {
    let mut by_cell: HashMap<Key, (&'static str, String)> = HashMap::new();
    for prop in map.map(|map| map.props.as_slice()).unwrap_or(&[]) {
        let level = match prop.cover {
            Cover::ThreeQuarters => "three-quarters",
            Cover::Half => "half",
            Cover::None => continue,
        };
        for cell in &prop.footprint {
            let key = key(cell.x as f64, cell.y as f64);
            if by_cell.get(&key).is_some_and(|(existing, _)| *existing == "three-quarters") {
                continue;
            }
            by_cell.insert(key, (level, prop.asset_id.clone()));
        }
    }
    by_cell
}

/// `elevationAt(state, position)`: высота площадки под клеткой в футах.
pub fn elevation_at(state: &Value, position: Option<Point>) -> i64 {
    let Some(position) = position else { return 0 };
    js::safe_int(tactical_cell_map(state).get(&key_of(position)).and_then(|cell| cell.get("elevation")), 0)
}

/// `highGroundBetween(state, from, to, distanceFeet)`: тактическое правило
/// высоты в духе BG3, не SRD; в профиле 2014 не применяется, в ближнем бою не
/// считается. `distance_feet` `None` — `null`.
pub fn high_ground_between(state: &Value, from: Option<Point>, to: Option<Point>, distance_feet: Option<f64>) -> &'static str {
    if game::uses_2014(state) {
        return "level";
    }
    match distance_feet {
        None => return "level",
        Some(distance) if distance <= 5.0 => return "level",
        _ => {}
    }
    let difference = elevation_at(state, from) - elevation_at(state, to);
    if difference >= 5 {
        "higher"
    } else if difference <= -5 {
        "lower"
    } else {
        "level"
    }
}

/// `coverBetween(state, attackerId, targetId, from, to)`: лучшее укрытие
/// между стрелком и целью — тела и обстановка на линии огня.
pub fn cover_between(state: &Value, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>) -> Value {
    let none = || json!({ "level": "none", "armorClassBonus": 0, "blockers": [] });
    let (Some(from_point), Some(to_point)) = (from, to) else { return none() };
    let attacker = game::find_actor(state, attacker_id);
    let target = game::find_actor(state, target_id);
    let distance = sk_geometry::actor_footprint::cells_distance_feet(&to_grid(&footprint_cells(attacker, Some(from_point))), &to_grid(&footprint_cells(target, Some(to_point))));
    match distance {
        None => return none(),
        Some(distance) if distance <= 5.0 => return none(),
        _ => {}
    }
    let scene = Scene::new(state);
    let props = prop_cover_by_cell(scene.map());
    let actors = game::list_actors(state);
    let mut best: Option<(&'static str, i64, Vec<String>, Vec<String>)> = None;
    for entry in actor_trajectory_details_in(&scene, attacker_id, target_id, from, to, false) {
        if entry.blocked {
            continue;
        }
        let line = &entry.trajectory[..entry.trajectory.len().saturating_sub(1)];
        let candidate = if line.is_empty() {
            ("none", 0, Vec::new(), Vec::new())
        } else {
            let in_line: KeySet = line.iter().copied().map(key_of).collect();
            let blockers: Vec<String> = actors
                .iter()
                .filter(|candidate| {
                    let id = game::actor_id(candidate);
                    if id == attacker_id || id == target_id || !game::is_living_actor(candidate) {
                        return false;
                    }
                    actor_footprint_cells_at(state, &id, None).into_iter().any(|cell| in_line.contains(&key_of(cell)))
                })
                .map(|actor| game::actor_id(actor))
                .collect();
            let scenery: Vec<(&'static str, String)> = line
                .iter()
                .filter_map(|point| {
                    let cell = scene.cell(*point);
                    let feature = js::s(cell.and_then(|cell| cell.get("feature")));
                    let from_feature = terrain_cover(&feature).map(|level| (level, feature.clone()));
                    let from_prop = props.get(&key_of(*point)).map(|(level, asset)| (*level, if asset.is_empty() { feature.clone() } else { asset.clone() }));
                    if from_feature.as_ref().is_some_and(|(level, _)| *level == "three-quarters") {
                        from_feature
                    } else {
                        from_prop.or(from_feature)
                    }
                })
                .collect();
            let best_scenery = if scenery.iter().any(|(level, _)| *level == "three-quarters") {
                "three-quarters"
            } else if !scenery.is_empty() {
                "half"
            } else {
                "none"
            };
            let level = if best_scenery == "three-quarters" {
                "three-quarters"
            } else if !blockers.is_empty() || best_scenery == "half" {
                "half"
            } else {
                "none"
            };
            let mut names: Vec<String> = Vec::new();
            for (_, name) in scenery {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            (level, cover_bonus(level), blockers, names)
        };
        // `sort` по возрастанию бонуса устойчив: первый из равных остаётся первым.
        if best.as_ref().is_none_or(|current| candidate.1 < current.1) {
            best = Some(candidate);
        }
    }
    let Some((level, bonus, blockers, scenery)) = best else { return none() };
    if level == "none" {
        return none();
    }
    let mut result = Map::new();
    result.insert("level".into(), Value::from(level));
    result.insert("armorClassBonus".into(), Value::from(bonus));
    result.insert("blockers".into(), js::strings_value(blockers));
    if !scenery.is_empty() {
        result.insert("scenery".into(), js::strings_value(scenery));
    }
    Value::Object(result)
}

fn to_grid(points: &[Point]) -> Vec<GridCell> {
    points.iter().map(|point| GridCell::new(point.x as i64, point.y as i64)).collect()
}

/// `hasClearTrajectory(state, from, to)`.
pub fn has_clear_trajectory(state: &Value, from: Point, to: Point) -> bool {
    assert_clear_trajectory(state, from, to).is_ok()
}

/// `creatureSizeRank(actor)`: крошечный 0 … громадный 5. Без объявленного
/// размера ранг выводится из площади больше одной клетки.
pub fn creature_size_rank(actor: Option<&Value>) -> i64 {
    let declared = actor.and_then(|actor| sk_rules_coalesce(&[actor.get("size"), actor.get("creature_size"), actor.get("creatureSize")]));
    if declared.is_none() && footprint_size_for(actor) > 1 {
        return footprint_size_for(actor) + 1;
    }
    let raw = sk_core::text::lower(&declared.map_or_else(|| "medium".to_string(), |value| js::string(Some(value))));
    if raw.contains("gargantuan") || raw.contains("громад") {
        5
    } else if raw.contains("huge") || raw.contains("огром") {
        4
    } else if raw.contains("large") || raw.contains("больш") {
        3
    } else if raw.contains("small") || raw.contains("мал") {
        1
    } else if raw.contains("tiny") || raw.contains("крош") {
        0
    } else {
        2
    }
}

/// `a ?? b ?? c`.
fn sk_rules_coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    crate::core::coalesce(values)
}
