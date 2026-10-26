//! Перенос `server/building-generator.mjs` — тема «здание с участком»: дом по
//! назначению (таверна, жилой дом, лавка, усадьба, кузня, казарма, мельница)
//! с функциональными помещениями, стенами на рёбрах, дверными и оконными
//! проёмами, участком с тропой, оградой и (у мельницы и «дома у реки») ручьём;
//! обстановка — расстановкой предметов по назначению комнат. Корпус бывает
//! прямоугольным, Г-образным, крестом и круглым; фигурный корпус, срезавший
//! комнату, уступает прямоугольнику. Здесь же — авторская крепость Ареса,
//! безопасная комната последней ступени отката и помощники проёмов, общие с
//! генератором этажей (`planRooms`, `openDoorway`, `openWindow`,
//! `edgesAround`, `ensureDeclaredTransitions`).
//!
//! Всё детерминировано от сида: хеш FNV-1a генератора, шум вариантов пола
//! карты, синус тропы и ручья — как в V8 (`sk_core::v8math`), сортировка с
//! дробным сравнителем — TimSort V8 (`crate::v8_sort`). Вход сборщиков —
//! объект JS рыхлым JSON, приведения — как у JS (`String(seed)`,
//! `Math.round(width)`, умолчания деструктуризации только для `undefined`).

mod ares;
mod furnish;
mod openings;
mod plan;
mod shape;

use std::collections::HashSet;
use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text, v8math};
use sk_map_core::map_quality::audit_tactical_map;
use sk_map_core::room_floors::{apply_room_floors, building_wall_style_for, RoomContext, RoomFloorsOptions};
use sk_map_core::scene_features::{raise_dais, DaisOptions};
use sk_map_core::thin_walls::{thin_walls, ThinWallsOptions};
use sk_props::prop_placement::{ensure_prop_access, place_colonnade, place_props};
use sk_tactical::tactical_map::{
    self as tm, CellPatch, EdgePatch, MapResult, Overlays, RoomLabel, TacticalMap, TacticalMapError, TacticalMapOptions, TacticalSpawnPoint,
};

pub use ares::{build_ares_fortress_scene, generate_ares_fortress_scene};
pub use furnish::{furnished_cells, quarters_json, room_quarters, FURNISHED_QUARTER_CELLS};
pub use plan::{plan_rooms, RoomsPlan, BUILDING_ARCHITECTURES, BUILDING_CLIMATES, BUILDING_SCHEMES, BUILDING_SHAPES, BUILDING_USES};

use plan::{
    building_footprint_for, building_shape_for, corridor_rooms, default_design_for_theme, design_material_for, design_room_label, design_rooms_for, hall_label,
    js_max, js_min, normalize_design, salted, seed_hash, wing_rooms,
};

/// Подпись генератора на карте (`map.generator`): `{ id, version }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeneratorStamp {
    pub id: &'static str,
    pub version: &'static str,
}

/// `BUILDING_GENERATOR`. v7: размер корпуса — по назначению здания.
pub const BUILDING_GENERATOR: GeneratorStamp = GeneratorStamp { id: "building-with-yard", version: "8" };

/// `ARES_FORTRESS_GENERATOR`: геометрия одна на все столы, сид меняет отделку.
pub const ARES_FORTRESS_GENERATOR: GeneratorStamp = GeneratorStamp { id: "ares-fortress", version: "1" };

/// Размер карты в клетках.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MapSize {
    pub width: i64,
    pub height: i64,
}

/// `ARES_FORTRESS_SIZE`: карта класса `area`, чтобы двор не сжимался.
pub const ARES_FORTRESS_SIZE: MapSize = MapSize { width: 40, height: 36 };

/// `REFERENCE_SIZE`: размер сцены-эталона.
pub const REFERENCE_SIZE: MapSize = MapSize { width: 26, height: 26 };

const DIRS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

// --- ошибка -----------------------------------------------------------------------

/// Отказ генератора. `name` — класс исключения JS (`TacticalMapError`,
/// `TypeError`, `Error`), `code` — код `TacticalMapError` (у прочих в JS кода
/// нет).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildingError {
    pub name: &'static str,
    pub code: Option<String>,
    pub message: String,
}

impl BuildingError {
    /// `throw new Error(message)`.
    fn plan(message: impl Into<String>) -> Self {
        Self { name: "Error", code: None, message: message.into() }
    }

    /// `TypeError` чтения поля у `null`.
    fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError", code: None, message: message.into() }
    }

    /// Форма эталона: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl From<TacticalMapError> for BuildingError {
    fn from(error: TacticalMapError) -> Self {
        let code = (error.name == TacticalMapError::NAME).then_some(error.code);
        Self { name: error.name, code, message: error.message }
    }
}

impl fmt::Display for BuildingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BuildingError {}

pub type Result<T> = std::result::Result<T, BuildingError>;

// --- план -------------------------------------------------------------------------

/// Прямоугольник клеток включительно (`{ minX, minY, maxX, maxY }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub min_x: i64,
    pub min_y: i64,
    pub max_x: i64,
    pub max_y: i64,
}

/// Помещение плана (`RoomPlan`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomPlan {
    pub zone_id: String,
    pub min_x: i64,
    pub min_y: i64,
    pub max_x: i64,
    pub max_y: i64,
}

impl RoomPlan {
    pub fn new(zone_id: &str, min_x: i64, min_y: i64, max_x: i64, max_y: i64) -> Self {
        Self { zone_id: zone_id.to_string(), min_x, min_y, max_x, max_y }
    }

    fn contains(&self, x: i64, y: i64) -> bool {
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }

    /// Форма JS: `{ zoneId, minX, minY, maxX, maxY }`.
    pub fn to_json(&self) -> Value {
        json!({ "zoneId": self.zone_id, "minX": self.min_x, "minY": self.min_y, "maxX": self.max_x, "maxY": self.max_y })
    }
}

// --- рыхлый вход -------------------------------------------------------------------

/// `value?.[key]`: поле есть только у объекта.
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// Пределы класса размера карты (`SIZE_CLASSES[name]`); классы постоянны.
fn size_limits(name: &str) -> tm::SizeClass {
    tm::size_class(name).unwrap_or(tm::SIZE_CLASSES[1].1)
}

/// Вход `null`: JS читает первое поле (`options.design`, деструктуризация
/// `seed`) и падает `TypeError`. Прочие не-объекты (число, строка, массив)
/// именованных полей не дают и читаются как пустой объект.
fn require_options(options: &Value, first_key: &str) -> Result<()> {
    if options.is_null() {
        return Err(BuildingError::type_error(format!("Cannot read properties of null (reading '{first_key}')")));
    }
    Ok(())
}

/// Замысел объектом: `{ ...design }` для чтения именованных полей. Строка,
/// массив и прочее именованных полей не дают — пустой объект.
fn design_map(design: &Value) -> Map<String, Value> {
    design.as_object().cloned().unwrap_or_default()
}

/// `{ ...options, key: value }`.
fn with_option(options: &Value, key: &str, value: Value) -> Value {
    let mut object = options.as_object().cloned().unwrap_or_default();
    object.insert(key.into(), value);
    Value::Object(object)
}

/// Строка для `boundedText`: не строка — пусто.
fn text_or_empty(value: Option<&Value>, fallback: &'static str) -> String {
    match value {
        None => fallback.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(_) => String::new(),
    }
}

// --- проёмы и рёбра -------------------------------------------------------------------

/// Параметры `edgesAround(map, x, y, kind, options)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgesAroundOptions {
    /// `options.blocksMove !== false`.
    pub blocks_move: bool,
    /// `options.blocksSight !== false`.
    pub blocks_sight: bool,
    /// `String(options.cover ?? 'three_quarters')`.
    pub cover: String,
}

impl Default for EdgesAroundOptions {
    fn default() -> Self {
        Self { blocks_move: true, blocks_sight: true, cover: "three_quarters".into() }
    }
}

impl EdgesAroundOptions {
    /// Из объекта JS.
    pub fn from_json(options: &Value) -> Self {
        Self {
            blocks_move: !js::is_false(field(options, "blocksMove")),
            blocks_sight: !js::is_false(field(options, "blocksSight")),
            cover: match field(options, "cover") {
                None | Some(Value::Null) => "three_quarters".into(),
                value => js::s(value),
            },
        }
    }
}

/// `edgesAround(map, x, y, kind, options)`: рёбра вида `kind` от клетки ко
/// всем проходимым соседям.
pub fn edges_around(map: &mut TacticalMap, x: i64, y: i64, kind: &str, options: &EdgesAroundOptions) -> MapResult<()> {
    for (dx, dy) in DIRS {
        if !tm::cell_passable(map, x + dx, y + dy) {
            continue;
        }
        let patch = EdgePatch { kind: Some(kind), blocks_move: Some(options.blocks_move), blocks_sight: Some(options.blocks_sight), cover: Some(&options.cover), door_id: None };
        tm::set_edge(map, x, y, x + dx, y + dy, &patch)?;
    }
    Ok(())
}

/// `openDoorway(map, x, y, id)`: клетка стены становится проходом, рёбра к
/// проходимым соседям снимаются, дверь встаёт поперёк прохода.
pub fn open_doorway(map: &mut TacticalMap, x: i64, y: i64, id: &str) -> MapResult<()> {
    if tm::cell_at(map, x, y).is_none() {
        return Ok(());
    }
    tm::set_cell(map, x, y, &CellPatch { passable: Some(true), material: Some("wood"), ..CellPatch::default() })?;
    for (dx, dy) in DIRS {
        if !tm::cell_passable(map, x + dx, y + dy) {
            continue;
        }
        tm::set_edge(map, x, y, x + dx, y + dy, &EdgePatch { kind: Some("none"), ..EdgePatch::default() })?;
    }
    let Some((ex, ey, dir)) = tm::doorway_edge_at(map, x, y) else { return Ok(()) };
    tm::set_door(map, &json!({ "id": id, "x": ex, "y": ey, "dir": dir.as_str(), "state": "closed", "blocksMove": false, "blocksSight": false }))?;
    Ok(())
}

/// `openWindow(map, x, y)`: стена остаётся непроходимой, рёбра к соседям
/// перестают перекрывать обзор.
pub fn open_window(map: &mut TacticalMap, x: i64, y: i64) -> MapResult<()> {
    match tm::cell_at(map, x, y) {
        Some(cell) if !cell.passable => {}
        _ => return Ok(()),
    }
    for (dx, dy) in DIRS {
        if !tm::cell_passable(map, x + dx, y + dy) {
            continue;
        }
        let patch = EdgePatch { kind: Some("window"), blocks_move: Some(true), blocks_sight: Some(false), cover: Some("three_quarters"), door_id: None };
        tm::set_edge(map, x, y, x + dx, y + dy, &patch)?;
    }
    Ok(())
}

/// `railBetween(map, ax, ay, bx, by)`: жердь ограды, если ребра ещё нет и это
/// не вода.
fn rail_between(map: &mut TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> MapResult<()> {
    let (Some(a), Some(b)) = (tm::cell_at(map, ax, ay), tm::cell_at(map, bx, by)) else { return Ok(()) };
    if a.surface == "water" || b.surface == "water" {
        return Ok(());
    }
    if tm::edge_between(map, ax, ay, bx, by)?.is_some() {
        return Ok(());
    }
    let patch = EdgePatch { kind: Some("rail"), blocks_move: Some(true), blocks_sight: Some(false), cover: Some("half"), door_id: None };
    tm::set_edge(map, ax, ay, bx, by, &patch)?;
    Ok(())
}

// --- переходы этажей ----------------------------------------------------------------

/// `ensureDeclaredTransitions(map, levels, zoneId)`: объявленные этажи
/// привязываются к лестницам, недостающая лестница ставится в одну клетку по
/// первой свободной внутренней клетке зоны. `levels` — значение JS (не
/// массив — этажей нет).
pub fn ensure_declared_transitions(map: &mut TacticalMap, levels: &Value, zone_id: &str) -> MapResult<()> {
    let declared: &[Value] = levels.as_array().map_or(&[], Vec::as_slice);
    if declared.is_empty() {
        return Ok(());
    }
    let attached = tm::attach_level_transitions(map, Some(levels));
    let mut covered: HashSet<i64> = attached.iter().filter_map(|index| map.props.get(*index).and_then(|prop| prop.transition.as_ref()).map(|transition| transition.to_level)).collect();
    let mut occupied: HashSet<(i64, i64)> = HashSet::new();
    for prop in &map.props {
        for cell in &prop.footprint {
            occupied.insert((cell.x, cell.y));
        }
    }
    for spawn in &map.spawn_points {
        occupied.insert((spawn.x, spawn.y));
    }
    for level in declared {
        let offset = js::number(field(level, "offset"));
        if !(offset.is_finite() && offset.fract() == 0.0 && offset.abs() <= 9_007_199_254_740_991.0) {
            continue;
        }
        let to_level = offset as i64;
        if to_level == map.level_index || covered.contains(&to_level) {
            continue;
        }
        let Some((x, y)) = free_wall_cell_in(map, zone_id, &occupied) else { continue };
        let prop = json!({
            "id": format!("level-transition-{to_level}"),
            "assetId": if to_level > map.level_index { "stairs_up" } else { "stairs_down" },
            "x": js::num(x as f64 + 0.5), "y": js::num(y as f64 + 0.5), "rotation": 0, "scale": 1,
            "footprint": [{ "x": x, "y": y }], "zOrder": 0, "blocksMove": false, "blocksSight": false, "cover": "none", "interactive": true,
            "transition": { "toLevel": to_level, "label": js::s(field(level, "label")) },
        });
        tm::add_prop(map, &prop)?;
        covered.insert(to_level);
        occupied.insert((x, y));
    }
    Ok(())
}

/// `freeWallCellIn(map, zoneId, occupied)`: в глубине дома (две клетки
/// помещений во все стороны), затем без соседней стены, затем у кладки, затем
/// любая свободная — обход по y, затем x.
fn free_wall_cell_in(map: &TacticalMap, zone_id: &str, occupied: &HashSet<(i64, i64)>) -> Option<(i64, i64)> {
    let mut anywhere = None;
    let mut near_wall = None;
    let mut shallow = None;
    let interior: HashSet<&str> = map.zones.iter().filter(|zone| zone.kind == "interior").map(|zone| zone.id.as_str()).collect();
    let deep = |x: i64, y: i64| {
        for dy in -2..=2 {
            for dx in -2..=2 {
                match tm::cell_at(map, x + dx, y + dy) {
                    Some(near) if near.passable && interior.contains(near.zone) => {}
                    _ => return false,
                }
            }
        }
        true
    };
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if !cell.passable || cell.zone != zone_id || occupied.contains(&(x, y)) {
                continue;
            }
            if anywhere.is_none() {
                anywhere = Some((x, y));
            }
            let touches_wall = DIRS.iter().any(|(dx, dy)| {
                !tm::cell_passable(map, x + dx, y + dy) || tm::edge_between(map, x, y, x + dx, y + dy).ok().flatten().is_some_and(|edge| edge.blocks_move)
            });
            if touches_wall {
                if near_wall.is_none() {
                    near_wall = Some((x, y));
                }
                continue;
            }
            if deep(x, y) {
                return Some((x, y));
            }
            if shallow.is_none() {
                shallow = Some((x, y));
            }
        }
    }
    shallow.or(near_wall).or(anywhere)
}

// --- здание ---------------------------------------------------------------------------

/// `levels.length === 0` по правилам JS: `null` — `TypeError`.
fn levels_length_is_zero(levels: &Value) -> Result<bool> {
    match levels {
        Value::Null => Err(BuildingError::type_error("Cannot read properties of null (reading 'length')")),
        Value::Array(items) => Ok(items.is_empty()),
        Value::String(text) => Ok(text.is_empty()),
        Value::Object(object) => Ok(object.get("length").and_then(Value::as_f64) == Some(0.0)),
        Value::Bool(_) | Value::Number(_) => Ok(false),
    }
}

/// `interiorEntryPoint(map, zoneId)`: клетка зоны ближе всех к её середине.
fn interior_entry_point(map: &TacticalMap, zone_id: &str) -> Option<(i64, i64)> {
    let cells: Vec<(i64, i64)> = tm::cells(map).filter(|cell| cell.passable && cell.zone == zone_id).map(|cell| (cell.x, cell.y)).collect();
    if cells.is_empty() {
        return None;
    }
    let length = cells.len() as f64;
    let center_x = js::round(cells.iter().map(|cell| cell.0).sum::<i64>() as f64 / length) as i64;
    let center_y = js::round(cells.iter().map(|cell| cell.1).sum::<i64>() as f64 / length) as i64;
    cells.into_iter().min_by_key(|(x, y)| ((x - center_x).abs() + (y - center_y).abs(), *y, *x))
}

/// `emptyRooms(map)`: помещения плана без единой клетки пола.
fn empty_rooms(map: &TacticalMap) -> Vec<String> {
    let filled: HashSet<&str> = tm::cells(map).filter(|cell| cell.passable).map(|cell| cell.zone).collect();
    map.zones.iter().filter(|zone| zone.kind == "interior" && zone.id != "walls" && !filled.contains(zone.id.as_str())).map(|zone| format!("EMPTY_ROOM:{}", zone.id)).collect()
}

/// `paintBuildingStream(map, building, entranceX, seed)`: ручей в две клетки
/// вдоль восточного или западного края участка.
fn paint_building_stream(map: &mut TacticalMap, building: Rect, entrance_x: i64, seed: &str) -> MapResult<()> {
    let west = building.min_x - 1;
    let east = map.width - 2 - building.max_x;
    if west.max(east) < 4 {
        return Ok(());
    }
    let east_side = east > west || (east == west && seed_hash(&format!("{seed}:stream")) % 2 != 0);
    let inner = if east_side { map.width - 3 } else { 2 };
    if (inner - entrance_x).abs() <= 3 {
        return Ok(());
    }
    tm::add_zone(map, &json!({ "id": "stream", "kind": "exterior", "material": "stone", "lightLevel": "bright", "floorDirection": "vertical", "label": "Ручей" }))?;
    let phase = f64::from(seed_hash(seed) % 7);
    for y in 0..map.height {
        let drift = js::round(v8math::sin(y as f64 * 0.5 + phase) * 0.6) as i64;
        let edge = if east_side { inner + drift.min(0) } else { inner + drift.max(0) };
        let (from, to) = if east_side { (edge, map.width - 1) } else { (0, edge) };
        for x in from..=to {
            if tm::cell_at(map, x, y).is_none_or(|cell| cell.zone != "yard") {
                continue;
            }
            tm::set_cell(map, x, y, &CellPatch { passable: Some(false), surface: Some("water"), material: Some("stone"), zone: Some("stream"), ..CellPatch::default() })?;
        }
    }
    for y in 0..map.height {
        for x in 0..map.width {
            if tm::cell_at(map, x, y).is_none_or(|cell| cell.zone != "stream") {
                continue;
            }
            for (dx, dy) in [(1, 0), (0, 1)] {
                if tm::cell_at(map, x + dx, y + dy).is_some_and(|other| other.zone != "stream") {
                    tm::set_edge(map, x, y, x + dx, y + dy, &EdgePatch { kind: Some("none"), ..EdgePatch::default() })?;
                }
            }
        }
    }
    Ok(())
}

/// `generateBuildingScene(options)`: карта здания с участком, детерминирована
/// от `seed`. Без `design` — замысел по словам темы. Отказ — исключение JS той
/// же формы; размер не числом (`NaN`) — отказ, где JS отдал бы пустую карту.
pub fn generate_building_scene(options: &Value) -> Result<TacticalMap> {
    require_options(options, "design")?;
    let design = match field(options, "design") {
        Some(design) if !design.is_null() => design_map(design),
        _ => design_map(&default_design_for_theme(field(options, "theme"))),
    };
    generate_designed_building_scene(options, &design)
}

/// `generateDesignedBuildingScene(options)`: фигурный корпус — первым, в трёх
/// раскроях; не лёг или съел комнату — тот же дом прямоугольником.
fn generate_designed_building_scene(options: &Value, design: &Map<String, Value>) -> Result<TacticalMap> {
    let seed = match field(options, "seed") {
        Some(value) if js::present(Some(value)) => js::string(Some(value)),
        _ => "building".to_string(),
    };
    let use_ = normalize_design(design).use_;
    let estimate_side = |key: &str, fallback: i64| {
        let value = js::number(field(options, key));
        if value == 0.0 || value.is_nan() {
            fallback as f64
        } else {
            value
        }
    };
    let (estimate_width, estimate_height) = building_footprint_for(&seed, use_, None, estimate_side("width", REFERENCE_SIZE.width), estimate_side("height", REFERENCE_SIZE.height), 0.0, "");
    // Корпус оценки — `{ minX: 0, maxX: width - 1 }`, ширина — `maxX - minX + 1`
    // в дробях JS: размер оценки бывает дробным и бесконечным.
    let shape = building_shape_for(design, &seed, use_, estimate_width - 1.0 - 0.0 + 1.0, estimate_height - 1.0 - 0.0 + 1.0);
    if shape != "rect" {
        for scheme in [None, Some("long-hall"), Some("wing")] {
            let mut attempt_design = design.clone();
            attempt_design.insert("shape".into(), Value::String(shape.into()));
            if let Some(scheme) = scheme {
                attempt_design.insert("scheme".into(), Value::String(scheme.into()));
            }
            if let Ok(shaped) = designed_building_attempt(options, &attempt_design) {
                // Так же и форма, в чей зал не встала его главная мебель (#184):
                // Г-образный трактир отдавал залу 32 клетки, и стойка
                // помещалась, только протыкая стену.
                let mut lost_design = design.clone();
                lost_design.insert("shape".into(), Value::String(shape.into()));
                if audit_tactical_map(&shaped).problems.is_empty()
                    && empty_rooms(&shaped).is_empty()
                    && furnish::lost_key_furniture(&shaped, &normalize_design(&lost_design)).is_empty()
                {
                    return Ok(shaped);
                }
            }
        }
    }
    let mut rect_design = design.clone();
    rect_design.insert("shape".into(), Value::String("rect".into()));
    designed_building_attempt(options, &rect_design)
}

/// `designedBuildingAttempt(options)`: одна сборка дома заданной формы.
fn designed_building_attempt(options: &Value, design: &Map<String, Value>) -> Result<TacticalMap> {
    let get = |key: &str| field(options, key);
    // Деструктуризация JS: умолчание — только для `undefined`.
    let seed = match get("seed") {
        None => "building".to_string(),
        value => js::string(value),
    };
    let seed_plain = match get("seed") {
        None => "building".to_string(),
        value => js::s(value),
    };
    let width = get("width").map_or(REFERENCE_SIZE.width as f64, |value| js::number(Some(value)));
    let height = get("height").map_or(REFERENCE_SIZE.height as f64, |value| js::number(Some(value)));
    let location_id = text_or_empty(get("locationId"), "");
    let theme = text_or_empty(get("theme"), "tavern");
    let with_props = get("withProps").is_none_or(|value| js::truthy(Some(value)));
    let no_levels = Value::Array(Vec::new());
    let levels = get("levels").unwrap_or(&no_levels);
    let starts_inside = get("entry").and_then(Value::as_str) == Some("interior");

    let normalized = normalize_design(design);
    let use_ = normalized.use_;
    let shape_value = design.get("shape").and_then(Value::as_str);
    let asked_shape = js::s(design.get("shape"));
    let courtyard_requested = design.get("topology").and_then(Value::as_str) == Some("courtyard") && shape_value != Some("round");
    let minimum_size = if courtyard_requested { 20.0 } else { 16.0 };
    let round_or_cross = matches!(shape_value, Some("cross" | "round"));
    let minimum_building = match (courtyard_requested, round_or_cross) {
        (true, true) => 15,
        (true, false) => 11,
        (false, true) => 12,
        (false, false) => 8,
    };
    let area = size_limits("area");
    let safe_width = js_max(minimum_size, js_min(area.max_width as f64, js::round(width)));
    let safe_height = js_max(minimum_size, js_min(area.max_height as f64, js::round(height)));
    if safe_width.is_nan() || safe_height.is_nan() {
        return Err(BuildingError::plan("Размер карты здания не число"));
    }
    let (safe_width, safe_height) = (safe_width as i64, safe_height as i64);
    let courtyard_by_plan = wing_rooms(use_).len() > 2;
    let schemes: Vec<&str> = BUILDING_SCHEMES.iter().copied().filter(|name| *name != "corridor" && (*name != "courtyard" || (courtyard_by_plan && shape_value != Some("round")))).collect();
    let corridor_rolled = corridor_rooms(use_).is_some() && salted(&seed, "corridor") % 4 == 0;
    let asked_scheme = js::s(design.get("scheme"));
    let scheme = if courtyard_requested {
        "courtyard"
    } else if let Some(asked) = BUILDING_SCHEMES.iter().find(|name| **name == asked_scheme) {
        asked
    } else if corridor_rolled {
        "corridor"
    } else {
        schemes[salted(&seed, "scheme") as usize % schemes.len()]
    };
    let (footprint_width, footprint_height) = building_footprint_for(&seed, use_, Some(scheme), safe_width as f64, safe_height as f64, minimum_building as f64, &asked_shape);
    let (building_width, building_height) = (footprint_width as i64, footprint_height as i64);
    let max_min_x = 2.max(safe_width - building_width - 2);
    let max_min_y = 2.max(safe_height - building_height - 3);
    let min_x = 2 + i64::from(salted(&seed, "x")) % 1.max(max_min_x - 1);
    let min_y = 2 + i64::from(salted(&seed, "y")) % 1.max(max_min_y - 1);
    let building = Rect { min_x, min_y, max_x: (safe_width - 3).min(min_x + building_width - 1), max_y: (safe_height - 3).min(min_y + building_height - 1) };
    let interior = Rect { min_x: building.min_x + 1, min_y: building.min_y + 1, max_x: building.max_x - 1, max_y: building.max_y - 1 };
    let planned = design_rooms_for(interior, use_, scheme, asked_shape == "cross" || asked_shape == "round");
    let mirrored = if planned.iter().find(|room| room.zone_id == "hall").is_some_and(|hall| hall.max_y < interior.max_y) {
        planned
            .iter()
            .map(|room| RoomPlan { min_y: interior.min_y + interior.max_y - room.max_y, max_y: interior.min_y + interior.max_y - room.min_y, ..room.clone() })
            .collect()
    } else {
        planned
    };
    let shape = building_shape_for(design, &seed, use_, (building.max_x - building.min_x + 1) as f64, (building.max_y - building.min_y + 1) as f64);
    let mut rooms = mirrored;
    let yard_material = match normalized.climate {
        "arid" => "sand",
        "cold" => "ice",
        _ => "grass",
    };
    let yard_surface = match normalized.climate {
        "wetland" => "mud",
        "cold" => "ice",
        _ => "none",
    };
    let wall_material = if ["stone", "marble", "metal", "ice"].contains(&normalized.architecture) { normalized.architecture } else { "stone" };
    let arena = size_limits("arena");
    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: safe_width,
        height: safe_height,
        location_id: &location_id,
        seed: &seed,
        generator: Some((BUILDING_GENERATOR.id, BUILDING_GENERATOR.version)),
        theme: &theme,
        tileset_id: "building",
        size_class: if safe_width * safe_height <= arena.max_cells { "arena" } else { "area" },
        ..TacticalMapOptions::default()
    })?;
    tm::add_zone(&mut map, &json!({ "id": "yard", "kind": "exterior", "material": yard_material, "lightLevel": if normalized.climate == "cold" { "dim" } else { "bright" }, "floorDirection": "horizontal", "label": "Участок" }))?;
    for room in &rooms {
        let zone = json!({
            "id": room.zone_id,
            "kind": if room.zone_id == "courtyard" { "exterior" } else { "interior" },
            "material": design_material_for(normalized.architecture, &room.zone_id, yard_material),
            "lightLevel": if room.zone_id == "store" { "dark" } else { "dim" },
            "floorDirection": if salted(&seed, &format!("{}:floor", room.zone_id)) % 2 != 0 { "vertical" } else { "horizontal" },
            "label": if room.zone_id == "hall" { hall_label(use_).to_string() } else { design_room_label(&room.zone_id) },
        });
        tm::add_zone(&mut map, &zone)?;
    }
    tm::add_zone(&mut map, &json!({ "id": "walls", "kind": "interior", "material": wall_material, "lightLevel": "dark", "floorDirection": "horizontal", "label": "" }))?;
    let variant_at = |x: i64, y: i64| i64::from(tm::floor_variant_at(&seed, x, y, tm::FLOOR_VARIANTS));
    let yard_cost = if normalized.climate == "wetland" { 2.0 } else { 1.0 };
    for y in 0..safe_height {
        for x in 0..safe_width {
            let patch = CellPatch {
                passable: Some(true),
                material: Some(yard_material),
                surface: Some(yard_surface),
                zone: Some("yard"),
                variant: Some(variant_at(x, y)),
                revealed: Some(false),
                move_cost: Some(yard_cost),
                ..CellPatch::default()
            };
            tm::set_cell(&mut map, x, y, &patch)?;
        }
    }
    for y in building.min_y..=building.max_y {
        for x in building.min_x..=building.max_x {
            let perimeter = x == building.min_x || x == building.max_x || y == building.min_y || y == building.max_y;
            let room = rooms.iter().find(|room| room.contains(x, y));
            match room {
                Some(room) if !perimeter => {
                    let patch = CellPatch {
                        passable: Some(true),
                        material: Some(design_material_for(normalized.architecture, &room.zone_id, yard_material)),
                        zone: Some(&room.zone_id),
                        variant: Some(variant_at(x, y)),
                        surface: Some(if room.zone_id == "courtyard" { yard_surface } else { "none" }),
                        ..CellPatch::default()
                    };
                    tm::set_cell(&mut map, x, y, &patch)?;
                }
                _ => {
                    let patch = CellPatch { passable: Some(false), material: Some(wall_material), zone: Some("walls"), variant: Some(variant_at(x, y)), ..CellPatch::default() };
                    tm::set_cell(&mut map, x, y, &patch)?;
                }
            }
        }
    }
    if shape != "rect" {
        let paint = shape::Paint { yard_material, yard_surface, wall_material, variant_at: &variant_at };
        rooms = shape::apply_building_shape(&mut map, building, shape, &seed, &rooms, &paint)?;
    }
    for y in building.min_y..=building.max_y {
        for x in building.min_x..=building.max_x {
            if !tm::cell_passable(&map, x, y) {
                edges_around(&mut map, x, y, "wall", &EdgesAroundOptions::default())?;
            }
        }
    }
    let shaped_hall = rooms.iter().find(|room| room.zone_id == "hall").cloned();
    let shaped_door = match (&shaped_hall, shape != "rect") {
        (Some(hall), true) => shape::open_shaped_front_door(&mut map, hall)?,
        _ => None,
    };
    if shape != "rect" && shaped_door.is_none() {
        return Err(BuildingError::plan(format!("Корпус формы {shape}: у зала нет стены на двор")));
    }
    if shape != "rect" {
        let mut sizes: Vec<(String, usize)> = Vec::new();
        for y in building.min_y..=building.max_y {
            for x in building.min_x..=building.max_x {
                let Some(own) = tm::cell_at(&map, x, y) else { continue };
                if !own.passable || own.zone == "yard" {
                    continue;
                }
                match sizes.iter_mut().find(|(zone, _)| zone == own.zone) {
                    Some(entry) => entry.1 += 1,
                    None => sizes.push((own.zone.to_string(), 1)),
                }
            }
        }
        let hall_size = sizes.iter().find(|(zone, _)| zone == "hall").map_or(0, |entry| entry.1);
        if sizes.iter().any(|(zone, size)| zone != "hall" && zone != "courtyard" && *size > hall_size) {
            return Err(BuildingError::plan(format!("Корпус формы {shape}: зал меньше служебной комнаты")));
        }
    }
    let entrance_x = match shaped_door {
        Some((x, _)) => x,
        None => openings::open_design_exterior_door(&mut map, &rooms, building, "front-door")?,
    };
    let path_start_y = shaped_door.map_or(building.max_y + 1, |(_, y)| y + 1);
    let mut connected: IndexSet<String> = IndexSet::new();
    connected.insert("hall".into());
    if rooms.iter().any(|room| room.zone_id == "courtyard") && openings::connect_design_rooms(&mut map, &rooms, "hall", "courtyard", "courtyard-door")? {
        connected.insert("courtyard".into());
    }
    let mut link_order: IndexSet<String> = ["corridor", "kitchen", "store", "bedroom", "salon", "workshop", "barracks", "armory"].iter().map(|id| id.to_string()).collect();
    for room in &rooms {
        if text::test(re!(r"-\d+$", "u"), &room.zone_id) || room.zone_id == "study" {
            link_order.insert(room.zone_id.clone());
        }
    }
    let joined = |map: &mut TacticalMap, source: &str, zone_id: &str, door_id: &str| -> Result<bool> {
        if shape == "rect" {
            openings::connect_design_rooms(map, &rooms, source, zone_id, door_id)
        } else {
            shape::connect_shaped_rooms(map, source, zone_id, door_id)
        }
    };
    for zone_id in link_order.iter().chain(link_order.iter()) {
        if connected.contains(zone_id) || !rooms.iter().any(|room| room.zone_id == *zone_id) {
            continue;
        }
        let door_id = format!("{zone_id}-door");
        let mut linked = false;
        let sources: Vec<String> = if connected.contains("corridor") && zone_id != "corridor" {
            std::iter::once("corridor".to_string()).chain(connected.iter().filter(|id| *id != "corridor").cloned()).collect()
        } else {
            connected.iter().cloned().collect()
        };
        for source in &sources {
            if !joined(&mut map, source, zone_id, &door_id)? {
                continue;
            }
            connected.insert(zone_id.clone());
            linked = true;
            break;
        }
        if !linked {
            let fallback: Vec<String> = rooms.iter().map(|room| room.zone_id.clone()).filter(|id| connected.contains(id)).collect();
            for source in &fallback {
                if !joined(&mut map, source, zone_id, &door_id)? {
                    continue;
                }
                connected.insert(zone_id.clone());
                break;
            }
        }
    }
    if shape == "rect" {
        openings::open_design_back_door(&mut map, &rooms, building)?;
        openings::open_design_windows(&mut map, &rooms, building)?;
    } else {
        shape::open_shaped_back_door_and_windows(&mut map, &rooms)?;
    }
    thin_walls(&mut map, &ThinWallsOptions::default())?;
    let context = RoomContext { use_, architecture: normalized.architecture };
    apply_room_floors(&mut map, &RoomFloorsOptions { context, wall: building_wall_style_for(&context, true), default_floor: None, zones: None })?;
    if use_ == "manor" {
        raise_dais(&mut map, "hall", &DaisOptions::default())?;
    }
    let phase = f64::from(seed_hash(&seed_plain) % 5);
    for y in path_start_y..safe_height {
        let drift = if y - path_start_y < 2 { 0 } else { js::round(v8math::sin((y - building.max_y) as f64 * 0.6 + phase) * 1.4) as i64 };
        for x in [entrance_x + drift, entrance_x + drift + 1] {
            if tm::cell_at(&map, x, y).is_some() {
                tm::set_cell(&mut map, x, y, &CellPatch { material: Some("earth"), surface: Some("none"), variant: Some(variant_at(x, y)), ..CellPatch::default() })?;
            }
        }
    }
    let riverside = use_ == "mill" || design.get("topology").and_then(Value::as_str) == Some("river");
    if riverside {
        paint_building_stream(&mut map, building, entrance_x, &seed)?;
    }
    let plot = Rect { min_x: 1, min_y: 1, max_x: safe_width - 2, max_y: safe_height - 2 };
    for x in plot.min_x..plot.max_x {
        if (x - entrance_x).abs() <= 1 {
            continue;
        }
        rail_between(&mut map, x, plot.max_y, x, plot.max_y + 1)?;
        rail_between(&mut map, x, plot.min_y - 1, x, plot.min_y)?;
    }
    for y in plot.min_y..plot.max_y {
        rail_between(&mut map, plot.min_x - 1, y, plot.min_x, y)?;
        rail_between(&mut map, plot.max_x, y, plot.max_x + 1, y)?;
    }
    let exterior_spawn = (1.max((safe_width - 2).min(entrance_x)), safe_height - 2);
    let interior_point = if starts_inside { interior_entry_point(&map, "hall") } else { None };
    let party_spawn = interior_point.unwrap_or(exterior_spawn);
    map.spawn_points.push(TacticalSpawnPoint { id: "party-entrance".into(), x: party_spawn.0, y: party_spawn.1, role: "party".into() });
    map.overlays = overlays_of(&map);
    let interior_zones: HashSet<String> = map.zones.iter().filter(|zone| zone.kind == "interior").map(|zone| zone.id.clone()).collect();
    for y in building.max_y..safe_height {
        for x in 0..safe_width {
            if tm::cell_at(&map, x, y).is_some_and(|cell| !interior_zones.contains(cell.zone)) {
                tm::set_cell(&mut map, x, y, &CellPatch { revealed: Some(true), ..CellPatch::default() })?;
            }
        }
    }
    if starts_inside {
        reveal_zone(&mut map, "hall")?;
    }
    let spawn_reserved = starts_inside && interior_point.is_some() && tm::cell_passable(&map, party_spawn.0, party_spawn.1);
    if spawn_reserved {
        tm::set_cell(&mut map, party_spawn.0, party_spawn.1, &CellPatch { passable: Some(false), ..CellPatch::default() })?;
    }
    if with_props {
        let placed = furnish_building(&mut map, &normalized, &rooms, levels, &seed);
        if spawn_reserved {
            tm::set_cell(&mut map, party_spawn.0, party_spawn.1, &CellPatch { passable: Some(true), ..CellPatch::default() })?;
        }
        placed?;
    } else if spawn_reserved {
        tm::set_cell(&mut map, party_spawn.0, party_spawn.1, &CellPatch { passable: Some(true), ..CellPatch::default() })?;
    }
    ensure_declared_transitions(&mut map, levels, "hall")?;
    ensure_prop_access(&mut map);
    Ok(map)
}

/// Обстановка здания (блок `try` JS): опоры под крышу большого зала,
/// расстановка по назначению комнат, добивка пустых четвертей зала.
fn furnish_building(map: &mut TacticalMap, design: &plan::Design, rooms: &[RoomPlan], levels: &Value, seed: &str) -> Result<()> {
    let zones: Vec<(String, String)> = map.zones.iter().map(|zone| (zone.id.clone(), zone.kind.clone())).collect();
    for (zone_id, kind) in &zones {
        if kind != "interior" {
            continue;
        }
        let cells = tm::cells(map).filter(|cell| cell.passable && cell.zone == zone_id).count();
        if cells >= furnish::ROOF_POST_HALL_CELLS {
            place_colonnade(map, zone_id, "pillar", "roof-post");
        }
    }
    let max_props = tm::size_class(&map.size_class).map_or(0, |limits| limits.max_props);
    let plans = furnish::design_prop_plans(design, rooms, levels_length_is_zero(levels)?);
    place_props(map, &format!("{seed}:props"), &plans, max_props)?;
    furnish::furnish_empty_quarters(map, "hall", design.use_, seed)?;
    Ok(())
}

/// Наложения отрисовки: компас, масштаб и подписи помещений с подписью.
fn overlays_of(map: &TacticalMap) -> Overlays {
    Overlays {
        compass: true,
        scale_bar: true,
        room_labels: map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| RoomLabel { zone_id: zone.id.clone(), label: zone.label.clone() }).collect(),
    }
}

/// `revealDesignZone(map, zoneId)`: все клетки зоны раскрыты.
fn reveal_zone(map: &mut TacticalMap, zone_id: &str) -> MapResult<()> {
    for y in 0..map.height {
        for x in 0..map.width {
            if tm::cell_at(map, x, y).is_some_and(|cell| cell.zone == zone_id) {
                tm::set_cell(map, x, y, &CellPatch { revealed: Some(true), ..CellPatch::default() })?;
            }
        }
    }
    Ok(())
}

// --- сборка с откатом -------------------------------------------------------------------

/// Итог сборки сцены: карта, ступень отката (`none`, `rect`, `no_props`,
/// `safe_room`) и предупреждения.
#[derive(Clone, Debug)]
pub struct BuildingScene {
    pub map: TacticalMap,
    pub fallback: &'static str,
    pub warnings: Vec<String>,
}

/// `buildBuildingScene(options)`: сборка с проверкой и ступенями отката —
/// фигурный корпус, прямоугольник, без обстановки, безопасная комната.
/// Первая попытка проходит и проверку играбельности (`auditTacticalMap`).
pub fn build_building_scene(options: &Value) -> Result<BuildingScene> {
    require_options(options, "design")?;
    let design = match field(options, "design") {
        Some(design) if !design.is_null() => design_map(design),
        _ => design_map(&default_design_for_theme(field(options, "theme"))),
    };
    let mut rect_design = design;
    rect_design.insert("shape".into(), Value::String("rect".into()));
    let rectangular = with_option(options, "design", Value::Object(rect_design));
    let no_props = with_option(&rectangular, "withProps", Value::Bool(false));
    let attempts: [(&'static str, Option<&Value>, bool); 4] = [("none", Some(options), true), ("rect", Some(&rectangular), false), ("no_props", Some(&no_props), false), ("safe_room", None, false)];
    let mut last_errors: Vec<String> = Vec::new();
    for (fallback, input, strict) in attempts {
        let built = match input {
            Some(input) => generate_building_scene(input),
            None => safe_room(options),
        };
        let map = match built {
            Ok(map) => map,
            Err(error) => {
                last_errors = vec![error.message];
                continue;
            }
        };
        let report = tm::validate_tactical_map(&map);
        let reachability = reachability_issues(&map);
        let quality: Vec<String> = if strict {
            audit_tactical_map(&map).problems.iter().map(|problem| problem.code.to_string()).chain(empty_rooms(&map)).collect()
        } else {
            Vec::new()
        };
        if report.ok && reachability.is_empty() && quality.is_empty() {
            let warnings = tactical_fitness_warnings(&map);
            return Ok(BuildingScene { map, fallback, warnings });
        }
        last_errors = report.errors.iter().map(|issue| issue.code.clone()).chain(reachability).chain(quality).collect();
    }
    let map = safe_room(options)?;
    Ok(BuildingScene { map, fallback: "safe_room", warnings: vec![format!("не удалось собрать сцену: {}", last_errors.join(", "))] })
}

/// `reachabilityIssues(map)`: помещения с подписью, недостижимые от точки
/// появления отряда.
pub fn reachability_issues(map: &TacticalMap) -> Vec<String> {
    let Some(spawn) = map.spawn_points.iter().find(|point| point.role == "party").or(map.spawn_points.first()) else {
        return vec!["SPAWN_POINT_MISSING".into()];
    };
    let reached = tm::reachable_cells(map, spawn.x, spawn.y, true, None);
    let mut issues = Vec::new();
    for zone in &map.zones {
        if zone.label.is_empty() {
            continue;
        }
        let mut total = 0;
        let mut seen = 0;
        for cell in tm::cells(map) {
            if !cell.passable || cell.zone != zone.id {
                continue;
            }
            total += 1;
            if reached.contains(&(cell.x, cell.y)) {
                seen += 1;
            }
        }
        if total > 0 && seen == 0 {
            issues.push(format!("ZONE_UNREACHABLE:{}", zone.id));
        }
    }
    issues
}

/// `tacticalFitnessWarnings(map)`: тактическая пригодность — предупреждением.
pub fn tactical_fitness_warnings(map: &TacticalMap) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut passable = 0usize;
    let mut covered = 0usize;
    let mut open = 0usize;
    for cell in tm::cells(map) {
        if !cell.passable {
            continue;
        }
        passable += 1;
        let neighbours = DIRS.iter().filter(|(dx, dy)| tm::cell_passable(map, cell.x + dx, cell.y + dy)).count();
        if neighbours >= 4 {
            open += 1;
        }
        if neighbours <= 2 {
            covered += 1;
        }
    }
    if passable == 0 {
        return vec!["NO_PASSABLE_CELLS".into()];
    }
    if covered as f64 / passable as f64 > 0.6 {
        warnings.push("TOO_MANY_CORRIDORS: карта из коридоров обесценивает дальний бой".into());
    }
    if open as f64 / passable as f64 > 0.9 {
        warnings.push("TOO_OPEN: пустой зал обесценивает укрытия".into());
    }
    if map.props.iter().filter(|prop| prop.cover != tm::Cover::None).count() < 4 {
        warnings.push("LOW_COVER: укрытий почти нет".into());
    }
    warnings
}

/// `safeRoom({ seed, locationId, theme })`: минимальная безопасная комната
/// 11×9 — последняя ступень отката.
pub fn safe_room(options: &Value) -> Result<TacticalMap> {
    require_options(options, "seed")?;
    let seed = match field(options, "seed") {
        None => "safe".to_string(),
        value => js::string(value),
    };
    let location_id = text_or_empty(field(options, "locationId"), "");
    let theme = text_or_empty(field(options, "theme"), "tavern");
    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: 11,
        height: 9,
        location_id: &location_id,
        seed: &seed,
        generator: Some((BUILDING_GENERATOR.id, BUILDING_GENERATOR.version)),
        theme: &theme,
        size_class: "arena",
        ..TacticalMapOptions::default()
    })?;
    tm::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior", "material": "wood", "lightLevel": "dim", "floorDirection": "horizontal", "label": "Комната" }))?;
    for y in 0..9 {
        for x in 0..11 {
            let border = x == 0 || y == 0 || x == 10 || y == 8;
            let patch = CellPatch {
                passable: Some(!border),
                material: Some(if border { "stone" } else { "wood" }),
                zone: Some("hall"),
                revealed: Some(true),
                variant: Some(i64::from(tm::floor_variant_at(&seed, x, y, tm::FLOOR_VARIANTS))),
                ..CellPatch::default()
            };
            tm::set_cell(&mut map, x, y, &patch)?;
        }
    }
    for y in 0..9 {
        for x in 0..11 {
            if tm::cell_at(&map, x, y).is_some_and(|cell| !cell.passable) {
                edges_around(&mut map, x, y, "wall", &EdgesAroundOptions::default())?;
            }
        }
    }
    map.spawn_points.push(TacticalSpawnPoint { id: "party-entrance".into(), x: 1, y: 4, role: "party".into() });
    map.overlays = Overlays { compass: true, scale_bar: true, room_labels: vec![RoomLabel { zone_id: "hall".into(), label: "Комната".into() }] };
    Ok(map)
}
