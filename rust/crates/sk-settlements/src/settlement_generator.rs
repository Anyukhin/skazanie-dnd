//! Перенос `server/settlement-generator.mjs` — генератор поселения: улицы и
//! площадь по топологии (органическая, линейная, перекрёсток, рынок, двор,
//! гавань, река, террасы, ворота), дома дверью к улице, тропы к дверям в
//! глубине, перегородки и окна домов, торговые ряды рынка, тонкие стены и пол
//! комнат по назначению.
//!
//! Результат — обычная [`TacticalMap`]: проекция, движение, реквизит и
//! сохранение не получают второго формата. Случайность — собственный
//! детерминированный поток генератора (LCG от SHA-256 сида), синус изгибов —
//! как в V8 ([`crate::v8_math`]): тот же сид даёт ту же карту.
//!
//! Вход — объект JS (`options`), как у `buildSettlementScene`: тема и замысел
//! места приходят рыхлым JSON.

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
use std::fmt;

use serde_json::{json, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text};
use sk_map_core::room_floors::{apply_room_floors, building_wall_style_for, RoomContext, RoomFloorsOptions};
use sk_map_core::thin_walls::{thin_walls, ThinWallsOptions};
use sk_scene_base::asset_registry::asset_by_id;
use sk_tactical::tactical_map::{
    self as tm, CellPatch, EdgeKind, EdgePatch, Overlays, RoomLabel, TacticalMap, TacticalMapError, TacticalMapOptions, TacticalZone,
};

use crate::v8_math::sin;
use crate::{random_for, shuffle, GeneratorStamp};

/// `SETTLEMENT_GENERATOR`. v5 (2026-10-03): дверь дома в глубине — по тропе
/// до улицы, и тропа проложена. v6 (2026-10-08): рыночная площадь шире, на
/// ней ряды лотков с проходами.
pub const SETTLEMENT_GENERATOR: GeneratorStamp = GeneratorStamp { id: "settlement-layout", version: "6" };

/// С какой площади пола (клеток внутри стен) дом считается крупным: такой дом
/// делится на три комнаты, а не на две.
pub const LARGE_HOUSE_FLOOR: i64 = 35;

/// Лотков на площади не больше: ещё два-три добавит обстановка площади.
pub const MARKET_STALLS_MAX: usize = 9;

const TOPOLOGIES: [&str; 9] = ["organic", "linear", "crossroads", "market", "courtyard", "harbor", "river", "terraced", "gate"];
/// Порядок случайного выбора топологии (`designFor`).
const TOPOLOGY_DRAW: [&str; 9] = ["organic", "linear", "crossroads", "market", "courtyard", "terraced", "gate", "harbor", "river"];
const CLIMATES: [&str; 4] = ["temperate", "arid", "cold", "wetland"];
const ARCHITECTURES: [&str; 6] = ["wood", "stone", "sand", "metal", "marble", "ice"];
const DENSITIES: [&str; 3] = ["sparse", "mixed", "dense"];
const BUILDING_USES: [&str; 4] = ["dwelling", "tavern", "shop", "manor"];
const SCALES: [&str; 3] = ["village", "town", "city"];

const DIRS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

const BUILDING_SIZES: [(i64, i64); 7] = [(5, 8), (6, 6), (8, 5), (7, 7), (9, 5), (5, 9), (8, 7)];
const DENSE_BUILDING_SIZES: [(i64, i64); 6] = [(5, 6), (6, 5), (6, 6), (7, 5), (5, 7), (7, 6)];
const SPARSE_BUILDING_SIZES: [(i64, i64); 6] = [(6, 6), (8, 5), (7, 7), (9, 5), (5, 9), (8, 7)];

/// Длиннее этой тропы дом в глубине не ставится: к нему пришлось бы идти через полдеревни.
const MAX_DOOR_PATH: usize = 14;
/// Цена двери, что смотрит на край карты, — в клетках тропы.
const EDGE_DOOR_PENALTY: usize = 6;
/// Наименьшая рыночная площадь деревни: ширина вдоль улицы и глубина.
const MARKET_SQUARE: (i64, i64) = (16, 11);

// --- ошибка -----------------------------------------------------------------------

/// Отказ генератора. `name` — класс исключения JS (`TacticalMapError`,
/// `TypeError`, `Error`), `code` — код `TacticalMapError` (у прочих в JS кода нет).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementError {
    pub name: &'static str,
    pub code: Option<String>,
    pub message: String,
}

impl SettlementError {
    /// `throw new Error(message)`.
    fn plan(message: impl Into<String>) -> Self {
        Self { name: "Error", code: None, message: message.into() }
    }

    /// Форма JS: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl From<TacticalMapError> for SettlementError {
    fn from(error: TacticalMapError) -> Self {
        let code = (error.name == TacticalMapError::NAME).then_some(error.code);
        Self { name: error.name, code, message: error.message }
    }
}

impl fmt::Display for SettlementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SettlementError {}

type Result<T> = std::result::Result<T, SettlementError>;

// --- рыхлый вход -------------------------------------------------------------------

/// `value?.[key]`: поле есть только у объекта.
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// `${value?.[key] ?? ''}`.
fn field_text(value: &Value, key: &str) -> String {
    js::s(field(value, key))
}

/// `SET.has(value)`: только строка из набора.
fn one_of(value: Option<&Value>, set: &[&str]) -> Option<String> {
    value.and_then(Value::as_str).filter(|item| set.contains(item)).map(str::to_string)
}

// --- замысел и материалы ------------------------------------------------------------

/// Пространственный замысел поселения (`designFor`).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Design {
    topology: String,
    climate: String,
    architecture: String,
    density: String,
    building_use: String,
    scale: String,
    square: bool,
}

fn pick_architecture(theme: &Value, design: &Value) -> String {
    if let Some(architecture) = one_of(field(design, "architecture"), &ARCHITECTURES) {
        return architecture;
    }
    let value = text::lower(&format!("{} {} {}", field_text(theme, "id"), field_text(theme, "label"), field_text(theme, "houseMaterial")));
    if text::test(re!(r"пустын|оазис|пес", "u"), &value) {
        return "sand".into();
    }
    if text::test(re!(r"порт|гаван|мрамор|дворец", "u"), &value) {
        return "stone".into();
    }
    if text::test(re!(r"(?<![а-яё])(?:лед|лёд|льд)|снег|(?<![а-яё])север|тундр", "u"), &value) {
        return "ice".into();
    }
    if text::test(re!(r"металл|станци|тех", "u"), &value) {
        return "metal".into();
    }
    one_of(field(theme, "houseMaterial"), &ARCHITECTURES).unwrap_or_else(|| "wood".into())
}

fn design_for(theme: &Value, seed: &str, input: &Value) -> Result<Design> {
    if input.is_null() {
        return Err(SettlementError { name: "TypeError", code: None, message: "Cannot read properties of null (reading 'topology')".into() });
    }
    let value = text::lower(&format!("{} {}", field_text(theme, "id"), field_text(theme, "label")));
    let mut random = random_for(&format!("settlement-design:{seed}:{value}"));
    let topology = match one_of(field(input, "topology"), &TOPOLOGIES) {
        Some(topology) => topology,
        None if text::test(re!(r"порт|гаван", "u"), &value) => "harbor".into(),
        None if text::test(re!(r"рек|берег|канал", "u"), &value) => "river".into(),
        None if text::test(re!(r"рынок|торгов", "u"), &value) => "market".into(),
        None if text::test(re!(r"ворот|застав|крепост", "u"), &value) => "gate".into(),
        None => TOPOLOGY_DRAW[(random() * 9.0).floor() as usize].into(),
    };
    let climate = match one_of(field(input, "climate"), &CLIMATES) {
        Some(climate) => climate,
        None if text::test(re!(r"пустын|оазис|пес", "u"), &value) => "arid".into(),
        None if text::test(re!(r"(?<![а-яё])(?:лед|лёд|льд)|снег|(?<![а-яё])север|тундр", "u"), &value) => "cold".into(),
        None if text::test(re!(r"болот|топ|плавн|берег", "u"), &value) => "wetland".into(),
        None => "temperate".into(),
    };
    let density = match one_of(field(input, "density"), &DENSITIES) {
        Some(density) => density,
        None if random() < 0.25 => "sparse".into(),
        None if random() < 0.75 => "mixed".into(),
        None => "dense".into(),
    };
    let building_use = match one_of(field(input, "building_use"), &BUILDING_USES) {
        Some(building_use) => building_use,
        None if text::test(re!(r"таверн|трактир", "u"), &value) => "tavern".into(),
        None if text::test(re!(r"рынок|торгов|лавк", "u"), &value) => "shop".into(),
        None => "dwelling".into(),
    };
    let scale = one_of(field(input, "scale"), &SCALES).unwrap_or_default();
    Ok(Design {
        topology,
        climate,
        architecture: pick_architecture(theme, input),
        density,
        building_use,
        scale,
        // Площадь посреди деревни: её просит центр программы сцены.
        square: js::is_true(field(input, "square")),
    })
}

/// Материалы карты (`materials`): земля, улица, постройки.
struct Materials {
    surface: &'static str,
    street: String,
    building: String,
}

fn materials(design: &Design, theme: &Value) -> Materials {
    let surface = match design.climate.as_str() {
        "arid" => "sand",
        "cold" => "ice",
        _ => "grass",
    };
    let street = if design.climate == "arid" {
        "sand".to_string()
    } else if design.architecture == "metal" {
        "metal".to_string()
    } else {
        one_of(field(theme, "streetMaterial"), &ARCHITECTURES).unwrap_or_else(|| "earth".into())
    };
    Materials { surface, street, building: design.architecture.clone() }
}

// --- корпуса --------------------------------------------------------------------------

type Cell = (i64, i64);

/// Прямоугольник `{ x, y, w, h }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

impl Rect {
    const fn new(x: i64, y: i64, w: i64, h: i64) -> Self {
        Self { x, y, w, h }
    }

    fn cells(&self) -> Vec<Cell> {
        let mut cells = Vec::new();
        for y in self.y..self.y + self.h {
            for x in self.x..self.x + self.w {
                cells.push((x, y));
            }
        }
        cells
    }
}

/// Корпус дома (`makeSpec`): прямоугольник, пристройка и клетка у двери.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Spec {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    extension: Option<Rect>,
    door_x: i64,
    door_y: i64,
}

fn make_spec(x: i64, y: i64, w: i64, h: i64, extension: Option<Rect>) -> Spec {
    Spec { x, y, w, h, extension, door_x: x + w.div_euclid(2), door_y: y + h - 1 }
}

/// Клетки корпуса с пристройкой (`shapeCells`), без повторов.
fn shape_cells(spec: &Spec) -> Vec<Cell> {
    let mut cells = Rect::new(spec.x, spec.y, spec.w, spec.h).cells();
    if let Some(extension) = spec.extension {
        let own: HashSet<Cell> = cells.iter().copied().collect();
        cells.extend(extension.cells().into_iter().filter(|cell| !own.contains(cell)));
    }
    cells
}

/// `edgeFor(from, to)`: ребро между соседними клетками.
fn edge_for(from: Cell, to: Cell) -> (i64, i64, &'static str) {
    if to.0 == from.0 + 1 && to.1 == from.1 {
        return (from.0, from.1, "e");
    }
    if to.0 == from.0 - 1 && to.1 == from.1 {
        return (to.0, to.1, "e");
    }
    if to.1 == from.1 + 1 && to.0 == from.0 {
        return (from.0, from.1, "s");
    }
    (to.0, to.1, "s")
}

fn label_for(building_use: &str, index: usize) -> String {
    let list: [&str; 4] = match building_use {
        "tavern" => ["Таверна", "Постоялый двор", "Питейный дом", "Гостевой двор"],
        "shop" => ["Лавка", "Склад", "Торговый дом", "Мастерская"],
        "manor" => ["Усадьба", "Дом старосты", "Резиденция", "Контора"],
        // «Сеновал» — задняя комната крупного амбара, а не имя постройки.
        "barn" => ["Амбар", "Конюшня", "Скотный двор", "Сарай"],
        "workshop" => ["Мастерская", "Столярня", "Красильня", "Гончарня"],
        _ => ["Дом", "Жильё", "Подворье", "Семейный двор"],
    };
    // Таверна, лавка и амбар в поселении одни — номер им не нужен.
    if building_use != "dwelling" {
        return list[index % list.len()].to_string();
    }
    format!("{} {}", list[index % list.len()], index + 1)
}

/// Состав поселения (`settlementUses`): самая крупная постройка — таверна,
/// следующие — лавка и амбар (в плотном — мастерская), остальное — жильё;
/// особым назначением — не больше половины построек.
fn settlement_uses(specs: &[Spec], design: &Design) -> Vec<String> {
    let mut order: Vec<(usize, i64)> = specs.iter().enumerate().map(|(index, spec)| (index, spec.w * spec.h)).collect();
    order.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let mut uses: Vec<String> = vec!["dwelling".to_string(); specs.len()];
    let mut plan: Vec<String> = if design.building_use != "dwelling" { vec![design.building_use.clone()] } else { Vec::new() };
    let urban = design.scale == "town" || design.scale == "city";
    let wanted: Vec<&str> = if urban {
        let mut wanted = vec!["tavern", "manor", "shop", "shop", "workshop", "tavern", "shop", "workshop"];
        if design.scale == "city" {
            wanted.extend(["manor", "shop", "workshop"]);
        }
        wanted
    } else {
        vec!["tavern", "shop", if design.density == "dense" { "workshop" } else { "barn" }]
    };
    for use_ in wanted {
        if urban || !plan.iter().any(|entry| entry == use_) {
            plan.push(use_.to_string());
        }
    }
    let special = plan.len().min((specs.len() as f64 * if urban { 0.45 } else { 0.5 }).floor() as usize);
    for rank in 0..special {
        uses[order[rank].0] = plan[rank].clone();
    }
    // Амбару нужен пол хотя бы на 28 клеток: тесный амбар меняется местами
    // с самым просторным жильём, а если такого нет — остаётся жильём.
    let floor = |index: usize| (specs[index].w - 2).max(0) * (specs[index].h - 2).max(0);
    if let Some(barn) = uses.iter().position(|use_| use_ == "barn") {
        if floor(barn) < 28 {
            match order.iter().map(|entry| entry.0).find(|index| uses[*index] == "dwelling" && floor(*index) >= 28) {
                Some(roomy) => {
                    uses[roomy] = "barn".into();
                    uses[barn] = "dwelling".into();
                }
                None => uses[barn] = "dwelling".into(),
            }
        }
    }
    uses
}

// --- клетки карты --------------------------------------------------------------------

fn zone_at(map: &TacticalMap, x: i64, y: i64) -> Option<String> {
    tm::cell_at(map, x, y).map(|cell| cell.zone.to_string())
}

fn zone_is(map: &TacticalMap, x: i64, y: i64, zones: &[&str]) -> bool {
    tm::cell_at(map, x, y).is_some_and(|cell| zones.contains(&cell.zone))
}

fn is_water(map: &TacticalMap, x: i64, y: i64) -> bool {
    tm::cell_at(map, x, y).is_some_and(|cell| cell.surface == "water")
}

/// Проходимая клетка не под водой.
fn dry_passable(map: &TacticalMap, x: i64, y: i64) -> bool {
    tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.surface != "water")
}

fn street_at(map: &TacticalMap, x: i64, y: i64) -> bool {
    zone_is(map, x, y, &["street", "square"])
}

/// Улица, площадь или уже проложенная тропа (`roadAt`).
fn road_at(map: &TacticalMap, x: i64, y: i64) -> bool {
    zone_is(map, x, y, &["street", "square", "path"])
}

fn has_zone(map: &TacticalMap, id: &str) -> bool {
    map.zones.iter().any(|zone| zone.id == id)
}

const WALL: EdgePatch<'static> = EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None };
const NO_EDGE: EdgePatch<'static> = EdgePatch { kind: Some("none"), blocks_move: None, blocks_sight: None, cover: None, door_id: None };

fn paint_street(map: &mut TacticalMap, x: i64, y: i64, material: &str, allow_water: bool) -> Result<()> {
    let Some(cell) = tm::cell_at(map, x, y) else { return Ok(()) };
    if allow_water || cell.surface != "water" {
        tm::set_cell(map, x, y, &CellPatch { passable: Some(true), surface: Some("none"), material: Some(material), zone: Some("street"), revealed: Some(true), ..CellPatch::default() })?;
    }
    Ok(())
}

fn paint_square(map: &mut TacticalMap, x: i64, y: i64, material: &str) -> Result<()> {
    let Some(cell) = tm::cell_at(map, x, y) else { return Ok(()) };
    if cell.surface != "water" {
        tm::set_cell(map, x, y, &CellPatch { passable: Some(true), surface: Some("none"), material: Some(material), zone: Some("square"), revealed: Some(true), ..CellPatch::default() })?;
    }
    Ok(())
}

fn set_water(map: &mut TacticalMap, x: i64, y: i64, material: &str) -> Result<()> {
    tm::set_cell(map, x, y, &CellPatch { passable: Some(false), surface: Some("water"), material: Some(material), zone: Some("water"), revealed: Some(true), ..CellPatch::default() })?;
    Ok(())
}

fn set_door(map: &mut TacticalMap, id: &str, edge: (i64, i64, &str), state: &str) -> Result<()> {
    tm::set_door(map, &json!({ "id": id, "x": edge.0, "y": edge.1, "dir": edge.2, "state": state, "blocksMove": false, "blocksSight": false }))?;
    Ok(())
}

// --- размещение корпусов --------------------------------------------------------------

fn can_place(spec: &Spec, occupied: &HashSet<Cell>, map: &TacticalMap) -> bool {
    shape_cells(spec).into_iter().all(|(x, y)| {
        x >= 2 && y >= 2 && x < map.width - 2 && y < map.height - 2 && !occupied.contains(&(x, y)) && !is_water(map, x, y) && !street_at(map, x, y)
    })
}

fn density_count(density: &str, random: &mut dyn FnMut() -> f64) -> usize {
    let (minimum, maximum) = match density {
        "sparse" => (4, 6),
        "dense" => (8, 11),
        _ => (6, 9),
    };
    minimum + (random() * (maximum - minimum + 1) as f64).floor() as usize
}

fn reserve_spec(occupied: &mut HashSet<Cell>, spec: &Spec) {
    for (x, y) in shape_cells(spec) {
        occupied.insert((x, y));
        for (dx, dy) in DIRS {
            occupied.insert((x + dx, y + dy));
        }
    }
}

/// Двор вокруг дома — две клетки: соседний дом не встаёт вплотную.
fn reserve_yard(occupied: &mut HashSet<Cell>, spec: &Spec) {
    for (x, y) in shape_cells(spec) {
        for ry in -2..=2 {
            for rx in -2..=2 {
                occupied.insert((x + rx, y + ry));
            }
        }
    }
}

fn plan_spec(specs: &mut Vec<Spec>, occupied: &mut HashSet<Cell>, spec: Spec, map: &TacticalMap) -> bool {
    if !can_place(&spec, occupied, map) {
        return false;
    }
    reserve_spec(occupied, &spec);
    specs.push(spec);
    true
}

fn size_for(index: usize, random: &mut dyn FnMut() -> f64, density: &str) -> (i64, i64) {
    let offset = (random() * BUILDING_SIZES.len() as f64).floor() as usize;
    let sizes: &[(i64, i64)] = match density {
        "dense" => &DENSE_BUILDING_SIZES,
        "sparse" => &SPARSE_BUILDING_SIZES,
        _ => &BUILDING_SIZES,
    };
    sizes[(index + offset) % sizes.len()]
}

fn fits_region(spec: &Spec, region: &Rect) -> bool {
    shape_cells(spec).into_iter().all(|(x, y)| x >= region.x && y >= region.y && x < region.x + region.w && y < region.y + region.h)
}

fn organic_extension(x: i64, y: i64, (w, h): (i64, i64), region: &Rect) -> Option<Rect> {
    [Rect::new(x + w - 1, y + h - 3, 3, 3), Rect::new(x + w - 3, y + h - 1, 3, 3), Rect::new(x - 2, y + h - 3, 3, 3), Rect::new(x + w - 3, y - 2, 3, 3)]
        .into_iter()
        .find(|extension| fits_region(&make_spec(x, y, w, h, Some(*extension)), region))
}

/// Заполняет области кандидатами (`planInRegions`): сначала случайные места,
/// затем детерминированная сетка добирает цель.
fn plan_in_regions(map: &TacticalMap, random: &mut dyn FnMut() -> f64, target: usize, regions: &[Rect], organic: bool, density: &str) -> Vec<Spec> {
    let mut specs = Vec::new();
    let mut occupied = HashSet::new();
    let shuffled = shuffle(regions, random);
    let mut attempt = 0usize;
    while specs.len() < target && attempt < target * 160 {
        // Областей нет — JS падает на `region.x`; вызывающие всегда их дают.
        let Some(region) = shuffled.get(attempt % shuffled.len().max(1)).copied() else { break };
        let size = size_for(specs.len() + attempt, random, density);
        let max_x = region.x + region.w - size.0;
        let max_y = region.y + region.h - size.1;
        attempt += 1;
        if max_x < region.x || max_y < region.y {
            continue;
        }
        let x = region.x + (random() * (max_x - region.x + 1) as f64).floor() as i64;
        let y = region.y + (random() * (max_y - region.y + 1) as f64).floor() as i64;
        let extension = if organic && random() < 0.6 { organic_extension(x, y, size, &region) } else { None };
        let spec = make_spec(x, y, size.0, size.1, extension);
        if !fits_region(&spec, &region) {
            continue;
        }
        plan_spec(&mut specs, &mut occupied, spec, map);
    }
    // Сетка — детерминированная страховка: добирает цель, если область ещё
    // вмещает корпус с проходом вокруг.
    for region in &shuffled {
        let mut y = region.y;
        while y <= region.y + region.h - 5 && specs.len() < target {
            let mut x = region.x;
            while x <= region.x + region.w - 5 && specs.len() < target {
                let size = size_for(specs.len(), random, density);
                if x + size.0 <= region.x + region.w && y + size.1 <= region.y + region.h {
                    let extension = if organic { organic_extension(x, y, size, region) } else { None };
                    let spec = make_spec(x, y, size.0, size.1, extension);
                    if fits_region(&spec, region) {
                        plan_spec(&mut specs, &mut occupied, spec, map);
                    }
                }
                x += 6;
            }
            y += 7;
        }
    }
    specs
}

fn plan_gate_buildings(map: &TacticalMap, random: &mut dyn FnMut() -> f64, target: usize, regions: &[Rect], density: &str) -> Vec<Spec> {
    if density != "dense" {
        return plan_in_regions(map, random, target, regions, false, density);
    }
    let mut specs = Vec::new();
    let mut occupied = HashSet::new();
    for region in shuffle(regions, random) {
        let height_range = 1.max(2.min(region.h - 6));
        let first_height = 6 + (random() * height_range as f64).floor() as i64;
        let second_height = 6 + (random() * height_range as f64).floor() as i64;
        let first_extension = if first_height + 2 <= region.h && random() < 0.5 { Some(Rect::new(region.x + 1, region.y + first_height - 1, 3, 3)) } else { None };
        let slots: Vec<Spec> = [make_spec(region.x, region.y, 5, first_height, first_extension), make_spec(region.x + 6, region.y, 5, second_height, None)]
            .into_iter()
            .filter(|spec| fits_region(spec, &region))
            .collect();
        for spec in slots {
            if specs.len() >= target {
                return specs;
            }
            plan_spec(&mut specs, &mut occupied, spec, map);
        }
    }
    specs
}

// --- дома --------------------------------------------------------------------------------

/// Назначение и материал постройки (`{ ...chosen, building_use, architecture }`).
struct BuildingDesign<'a> {
    building_use: &'a str,
    architecture: &'a str,
}

fn add_zone(map: &mut TacticalMap, id: &str, kind: &str, material: &str, light: &str, direction: &str, label: Option<&str>) -> Result<()> {
    let mut zone = json!({ "id": id, "kind": kind, "material": material, "lightLevel": light, "floorDirection": direction });
    if let (Some(label), Some(object)) = (label, zone.as_object_mut()) {
        object.insert("label".into(), Value::String(label.to_string()));
    }
    tm::add_zone(map, &zone)?;
    Ok(())
}

/// `addBuilding`: корпус, стены, дверь к улице, перегородки и окна. `false` —
/// корпус не встал (как в JS, уже сделанные правки остаются).
fn add_building(map: &mut TacticalMap, spec: &Spec, index: usize, design: &BuildingDesign<'_>, occupied: &mut HashSet<Cell>) -> Result<bool> {
    if !can_place(spec, occupied, map) {
        return Ok(false);
    }
    let zone_id = format!("building-{}", index + 1);
    let footprint = shape_cells(spec);
    let keys: HashSet<Cell> = footprint.iter().copied().collect();
    add_zone(map, &zone_id, "interior", design.architecture, "dim", if index % 2 == 1 { "vertical" } else { "horizontal" }, Some(&label_for(design.building_use, index)))?;
    let boundary = |(x, y): Cell| DIRS.iter().any(|(dx, dy)| !keys.contains(&(x + dx, y + dy)));
    for &(x, y) in &footprint {
        let edge = boundary((x, y));
        tm::set_cell(
            map,
            x,
            y,
            &CellPatch { passable: Some(!edge), material: Some(design.architecture), zone: Some(if edge { "" } else { &zone_id }), revealed: Some(true), ..CellPatch::default() },
        )?;
        if edge {
            for (dx, dy) in DIRS {
                let (nx, ny) = (x + dx, y + dy);
                if keys.contains(&(nx, ny)) || !tm::cell_passable(map, nx, ny) {
                    continue;
                }
                tm::set_edge(map, x, y, nx, ny, &WALL)?;
            }
        }
    }
    let distance = |(x, y): Cell| (x - spec.door_x).abs() + (y - spec.door_y).abs();
    let mut candidates: Vec<Cell> = footprint.iter().copied().filter(|cell| boundary(*cell)).collect();
    candidates.sort_by_key(|cell| distance(*cell));
    let around = |(x, y): Cell| [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)];
    let door = candidates
        .iter()
        .copied()
        .find(|cell| {
            let inside = around(*cell).iter().any(|&(x, y)| keys.contains(&(x, y)) && tm::cell_passable(map, x, y));
            let outside = around(*cell).iter().any(|&(x, y)| !keys.contains(&(x, y)) && dry_passable(map, x, y));
            inside && outside
        })
        .or_else(|| candidates.first().copied());
    let Some(door) = door else { return Ok(false) };
    let Some(outside) = around(door).into_iter().find(|&(x, y)| dry_passable(map, x, y) && !keys.contains(&(x, y))) else { return Ok(false) };
    tm::set_cell(map, door.0, door.1, &CellPatch { passable: Some(true), material: Some(design.architecture), zone: Some(&zone_id), revealed: Some(true), ..CellPatch::default() })?;
    set_door(map, &format!("{zone_id}-door"), edge_for(door, outside), "open")?;
    // Небольшой амбар — одно помещение под сено и скот; крупный делится на
    // конюшню и сеновал.
    let large_barn = design.building_use == "barn" && (spec.w - 2) * (spec.h - 2) >= LARGE_HOUSE_FLOOR;
    if spec.extension.is_none() && (design.building_use != "barn" || large_barn) {
        partition_house(map, spec, &zone_id, design, door)?;
    }
    open_house_windows(map, &footprint, &keys, door)?;
    for &(x, y) in &footprint {
        occupied.insert((x, y));
        // Один внешний шаг вокруг корпуса: соседние стены не запирают дверь.
        for (dx, dy) in DIRS {
            occupied.insert((x + dx, y + dy));
        }
    }
    Ok(true)
}

fn back_room_label(building_use: &str) -> &'static str {
    match building_use {
        "dwelling" => "Спальня",
        "tavern" => "Кухня",
        "shop" | "workshop" => "Кладовая",
        "manor" => "Кабинет",
        "barn" => "Сеновал",
        _ => "Комната",
    }
}

fn side_room_label(building_use: &str) -> &'static str {
    match building_use {
        "dwelling" | "tavern" | "barn" => "Кладовая",
        "shop" => "Мастерская",
        "manor" | "workshop" => "Спальня",
        _ => "Комната",
    }
}

/// Перегородка с дверью (`partitionHouse`): жилая комната у входа и задняя;
/// крупный дом делит заднюю часть ещё раз.
fn partition_house(map: &mut TacticalMap, spec: &Spec, zone_id: &str, design: &BuildingDesign<'_>, front_door: Cell) -> Result<()> {
    let (min_x, min_y, max_x, max_y) = (spec.x + 1, spec.y + 1, spec.x + spec.w - 2, spec.y + spec.h - 2);
    let width = max_x - min_x + 1;
    let height = max_y - min_y + 1;
    let vertical = width >= height;
    let length = if vertical { width } else { height };
    if length < 6 || width * height < 15 {
        return Ok(());
    }
    // Внутренняя клетка у входной двери: по ней видно, какая сторона передняя.
    let entry = DIRS
        .iter()
        .map(|(dx, dy)| (front_door.0 + dx, front_door.1 + dy))
        .find(|&(x, y)| x >= min_x && x <= max_x && y >= min_y && y <= max_y)
        .unwrap_or(front_door);
    let front = 3i64.max(((length - 1) as f64 * 0.55).ceil() as i64);
    let back = length - 1 - front;
    if back < 2 {
        return Ok(());
    }
    let start = if vertical { min_x } else { min_y };
    let entry_axis = if vertical { entry.0 } else { entry.1 };
    let entry_near_start = ((entry_axis - start) as f64) < length as f64 / 2.0;
    let mut wall_at = if entry_near_start { start + front } else { start + back };
    // Стена не встаёт напротив входной двери.
    let end = start + length - 1;
    if wall_at == entry_axis {
        wall_at = if entry_near_start {
            if end - (wall_at + 1) >= 2 {
                wall_at + 1
            } else {
                wall_at - 1
            }
        } else if wall_at - 1 - start >= 2 {
            wall_at - 1
        } else {
            wall_at + 1
        };
    }
    if wall_at == entry_axis || wall_at <= start || wall_at >= end {
        return Ok(());
    }
    let back_zone = format!("{zone_id}-back");
    add_zone(map, &back_zone, "interior", design.architecture, "dim", if vertical { "vertical" } else { "horizontal" }, Some(back_room_label(design.building_use)))?;
    let wall: Vec<Cell> = if vertical { (min_y..=max_y).map(|along| (wall_at, along)).collect() } else { (min_x..=max_x).map(|along| (along, wall_at)).collect() };
    let is_back = |x: i64, y: i64| {
        let axis = if vertical { x } else { y };
        if entry_near_start {
            axis > wall_at
        } else {
            axis < wall_at
        }
    };
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            if is_back(x, y) {
                tm::set_cell(map, x, y, &CellPatch { zone: Some(&back_zone), ..CellPatch::default() })?;
            }
        }
    }
    let solid = |map: &mut TacticalMap, x: i64, y: i64| -> Result<()> {
        tm::set_cell(map, x, y, &CellPatch { passable: Some(false), material: Some(design.architecture), zone: Some(""), ..CellPatch::default() })?;
        for (dx, dy) in DIRS {
            if tm::cell_passable(map, x + dx, y + dy) {
                tm::set_edge(map, x, y, x + dx, y + dy, &WALL)?;
            }
        }
        Ok(())
    };
    for &(x, y) in &wall {
        solid(map, x, y)?;
    }
    // Крупный дом: задняя часть делится ещё раз поперёк, у каждой из двух
    // задних комнат своя дверь в переднюю.
    let along_of = |x: i64, y: i64| if vertical { y - min_y } else { x - min_x };
    let back_depth = if entry_near_start { end - wall_at } else { wall_at - start };
    let split = width * height >= LARGE_HOUSE_FLOOR && wall.len() >= 7 && back_depth >= 3;
    let middle = wall.len() / 2;
    let mut doorways: Vec<(Cell, String)> = Vec::new();
    if split {
        let side_zone = format!("{zone_id}-side");
        add_zone(map, &side_zone, "interior", design.architecture, "dim", if vertical { "horizontal" } else { "vertical" }, Some(side_room_label(design.building_use)))?;
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                if is_back(x, y) && along_of(x, y) > middle as i64 {
                    tm::set_cell(map, x, y, &CellPatch { zone: Some(&side_zone), ..CellPatch::default() })?;
                }
            }
        }
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                if !is_back(x, y) || along_of(x, y) != middle as i64 {
                    continue;
                }
                solid(map, x, y)?;
            }
        }
        if let Some(cell) = wall.get(middle / 2) {
            doorways.push((*cell, back_zone.clone()));
        }
        if let Some(cell) = wall.get(middle + 1 + (wall.len() - middle - 1) / 2) {
            doorways.push((*cell, side_zone));
        }
    } else if let Some(cell) = wall.get(middle) {
        doorways.push((*cell, back_zone.clone()));
    }
    // Клетка проёма принадлежит задней комнате, а полотно двери стоит на
    // ребре к передней.
    for ((x, y), zone) in doorways {
        tm::set_cell(map, x, y, &CellPatch { passable: Some(true), material: Some(design.architecture), zone: Some(&zone), ..CellPatch::default() })?;
        let toward = if entry_near_start { -1 } else { 1 };
        let to_front = if vertical { (x + toward, y) } else { (x, y + toward) };
        let to_back = if vertical { (x - toward, y) } else { (x, y - toward) };
        tm::set_edge(map, x, y, to_back.0, to_back.1, &NO_EDGE)?;
        tm::set_edge(map, x, y, to_front.0, to_front.1, &NO_EDGE)?;
        set_door(map, &format!("{zone}-door"), edge_for((x, y), to_front), "closed")?;
    }
    Ok(())
}

/// Окна в наружных стенах дома (`openHouseWindows`): по одному на каждые три
/// клетки фасада, не в углу и не рядом с дверью, до шести.
fn open_house_windows(map: &mut TacticalMap, footprint: &[Cell], keys: &HashSet<Cell>, front_door: Cell) -> Result<()> {
    let door_cells: Vec<Cell> = map.doors.iter().flat_map(|door| [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)]).collect();
    let near_door = |(x, y): Cell| door_cells.iter().any(|door| (door.0 - x).abs() + (door.1 - y).abs() <= 1);
    let window = EdgePatch { kind: Some("window"), blocks_move: Some(true), blocks_sight: Some(false), cover: Some("three_quarters"), door_id: None };
    let mut placed = 0;
    for &(x, y) in footprint {
        if placed >= 6 {
            break;
        }
        let solid = tm::cell_at(map, x, y).is_some_and(|own| !own.passable);
        if !solid || (x, y) == front_door || near_door((x, y)) {
            continue;
        }
        // Ровно одна сторона — улица, противоположная — комната: не угол.
        let outward: Vec<(i64, i64)> = DIRS.iter().copied().filter(|(dx, dy)| !keys.contains(&(x + dx, y + dy))).collect();
        if outward.len() != 1 {
            continue;
        }
        let (dx, dy) = outward[0];
        if !dry_passable(map, x + dx, y + dy) || !tm::cell_passable(map, x - dx, y - dy) {
            continue;
        }
        if (x + y) % 3 != 0 {
            continue;
        }
        tm::set_edge(map, x, y, x + dx, y + dy, &window)?;
        tm::set_edge(map, x, y, x - dx, y - dy, &window)?;
        placed += 1;
    }
    Ok(())
}

// --- пути -----------------------------------------------------------------------------------

/// Путь по проходимым клеткам сквозь рёбра (`routeIgnoringEdges`); клетки
/// чужой зоны — только как цель.
fn route_ignoring_edges(map: &TacticalMap, from: Cell, target: Cell, blocked_zone: &str) -> Option<Vec<Cell>> {
    let mut queue = vec![from];
    let mut previous: HashMap<Cell, Option<Cell>> = HashMap::from([(from, None)]);
    let mut index = 0;
    while index < queue.len() {
        let current = queue[index];
        index += 1;
        if current == target {
            break;
        }
        for (dx, dy) in DIRS {
            let next = (current.0 + dx, current.1 + dy);
            if previous.contains_key(&next) {
                continue;
            }
            let Some(cell) = tm::cell_at(map, next.0, next.1) else { continue };
            if !cell.passable || cell.surface == "water" {
                continue;
            }
            if cell.zone == blocked_zone && next != target {
                continue;
            }
            previous.insert(next, Some(current));
            queue.push(next);
        }
    }
    if !previous.contains_key(&target) {
        return None;
    }
    let mut path = Vec::new();
    let mut cursor = Some(target);
    while let Some(cell) = cursor {
        path.push(cell);
        cursor = previous.get(&cell).copied().flatten();
    }
    path.reverse();
    Some(path)
}

fn open_route_edges(map: &mut TacticalMap, path: &[Cell]) -> Result<()> {
    for pair in path.windows(2) {
        let (previous, current) = (pair[0], pair[1]);
        if tm::edge_between(map, previous.0, previous.1, current.0, current.1)?.is_some_and(|edge| edge.kind == EdgeKind::Door) {
            continue;
        }
        tm::set_edge(map, previous.0, previous.1, current.0, current.1, &NO_EDGE)?;
    }
    Ok(())
}

fn ensure_building_reachability(map: &mut TacticalMap, spawn: Cell) -> Result<()> {
    let mut reached = tm::reachable_cells(map, spawn.0, spawn.1, true, None);
    let building_zones: Vec<String> = map.zones.iter().filter(|zone| zone.id.starts_with("building-")).map(|zone| zone.id.clone()).collect();
    for zone_id in building_zones {
        let Some(door) = map.door(&format!("{zone_id}-door")).cloned() else {
            return Err(SettlementError::plan(format!("У зоны {zone_id} нет двери")));
        };
        let endpoints = [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)];
        let inside = endpoints.iter().position(|&(x, y)| zone_at(map, x, y).as_deref() == Some(zone_id.as_str()));
        let outside = endpoints.iter().enumerate().find(|(index, &(x, y))| Some(*index) != inside && tm::cell_passable(map, x, y)).map(|(_, cell)| *cell);
        let (Some(_), Some(outside)) = (inside, outside) else {
            return Err(SettlementError::plan(format!("У двери {} нет внутренней и внешней стороны", door.id)));
        };
        if !reached.contains(&outside) {
            let Some(path) = route_ignoring_edges(map, spawn, outside, &zone_id) else {
                return Err(SettlementError::plan(format!("Не удалось проложить путь к двери {}", door.id)));
            };
            open_route_edges(map, &path)?;
            reached = tm::reachable_cells(map, spawn.0, spawn.1, true, None);
        }
        let interior: Vec<Cell> = tm::cells(map).filter(|cell| cell.passable && cell.zone == zone_id).map(|cell| (cell.x, cell.y)).collect();
        if interior.is_empty() || interior.iter().any(|cell| !reached.contains(cell)) {
            return Err(SettlementError::plan(format!("Зона {zone_id} осталась недостижимой")));
        }
    }
    for door in &map.doors {
        let endpoints = [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)];
        if !endpoints.iter().any(|cell| reached.contains(cell)) {
            return Err(SettlementError::plan(format!("Дверь {} осталась недостижимой", door.id)));
        }
    }
    Ok(())
}

/// Кратчайшая тропа по открытой земле до улицы (`routeToRoad`): Дейкстра по
/// корзинам; клетка у края карты втрое дороже.
fn route_to_road(map: &TacticalMap, start: Cell, blocked: &HashSet<Cell>) -> Option<Vec<Cell>> {
    let open = |(x, y): Cell| dry_passable(map, x, y) && !blocked.contains(&(x, y)) && x > 0 && y > 0 && x < map.width - 1 && y < map.height - 1;
    let touches_road = |(x, y): Cell| road_at(map, x, y) || DIRS.iter().any(|(dx, dy)| road_at(map, x + dx, y + dy));
    if !open(start) {
        return None;
    }
    let cost_of = |(x, y): Cell| if x <= 1 || y <= 1 || x >= map.width - 2 || y >= map.height - 2 { 3 } else { 1 };
    let mut previous: HashMap<Cell, Option<Cell>> = HashMap::from([(start, None)]);
    let mut best: HashMap<Cell, usize> = HashMap::from([(start, 0)]);
    let mut buckets: Vec<Vec<Cell>> = vec![vec![start]];
    let mut distance = 0;
    while distance < buckets.len() {
        let bucket = std::mem::take(&mut buckets[distance]);
        for current in bucket {
            if best.get(&current) != Some(&distance) {
                continue;
            }
            if touches_road(current) {
                let mut route = Vec::new();
                let mut step = Some(current);
                while let Some(cell) = step {
                    route.push(cell);
                    step = previous.get(&cell).copied().flatten();
                }
                route.reverse();
                return Some(route);
            }
            for (dx, dy) in [(0, 1), (0, -1), (1, 0), (-1, 0)] {
                let next = (current.0 + dx, current.1 + dy);
                if !open(next) {
                    continue;
                }
                let total = distance + cost_of(next);
                if best.get(&next).is_some_and(|known| total >= *known) {
                    continue;
                }
                best.insert(next, total);
                previous.insert(next, Some(current));
                if buckets.len() <= total {
                    buckets.resize(total + 1, Vec::new());
                }
                buckets[total].push(next);
            }
        }
        distance += 1;
    }
    None
}

/// Тропа от каждой двери дома, что не выходит прямо к улице (`layDoorPaths`).
fn lay_door_paths(map: &mut TacticalMap, material: &str) -> Result<usize> {
    let mut building_cells: HashSet<Cell> = HashSet::new();
    for cell in tm::cells(map) {
        if cell.zone.starts_with("building-") || (!cell.passable && cell.zone.is_empty()) {
            building_cells.insert((cell.x, cell.y));
        }
    }
    let doors: Vec<(String, Cell, Cell)> = map.doors.iter().map(|door| (door.id.clone(), (door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir))).collect();
    let mut laid = 0;
    for (id, own, neighbor) in doors {
        if !text::test(re!(r"^building-\d+-door$", "u"), &id) {
            continue;
        }
        let Some(outside) = [own, neighbor]
            .into_iter()
            .find(|&(x, y)| !zone_at(map, x, y).unwrap_or_default().starts_with("building-") && tm::cell_passable(map, x, y))
        else {
            continue;
        };
        let route = match route_to_road(map, outside, &building_cells) {
            Some(route) if route.len() != 1 => route,
            _ => continue,
        };
        if !has_zone(map, "path") {
            add_zone(map, "path", "exterior", material, "bright", "horizontal", None)?;
        }
        for (x, y) in route {
            if !road_at(map, x, y) {
                tm::set_cell(map, x, y, &CellPatch { material: Some(material), zone: Some("path"), revealed: Some(true), ..CellPatch::default() })?;
            }
        }
        laid += 1;
    }
    Ok(laid)
}

// --- улицы деревни ----------------------------------------------------------------------------

/// Клетка до покраски переулком — чтобы переулок можно было снять.
struct Painted {
    x: i64,
    y: i64,
    passable: bool,
    surface: &'static str,
    material: &'static str,
    zone: String,
    revealed: bool,
}

/// Переулки деревни (`paintVillageLanes`): проезды в две клетки от главной
/// улицы вверх и вниз.
fn paint_village_lanes(map: &mut TacticalMap, random: &mut dyn FnMut() -> f64, material: &str) -> Result<Vec<Painted>> {
    let mut painted = Vec::new();
    // Главная улица — самая длинная горизонтальная полоса улицы.
    let rows: Vec<i64> = (0..map.height).filter(|&y| ((0..map.width).filter(|&x| street_at(map, x, y)).count() as f64) >= map.width as f64 * 0.6).collect();
    let (Some(&top), Some(&bottom)) = (rows.iter().min(), rows.iter().max()) else { return Ok(painted) };
    let spacing = 12 + (random() * 3.0).floor() as i64;
    let first = 9 + (random() * 4.0).floor() as i64;
    // Переулок не встаёт рядом с другой поперечной улицей.
    let cross_street_near = |map: &TacticalMap, lane_x: i64| (0..map.height).filter(|&y| y < top || y > bottom).any(|y| (0..22).map(|i| lane_x - 10 + i).any(|x| street_at(map, x, y)));
    let mut lane_x = first;
    while lane_x + 1 < map.width - 8 {
        if cross_street_near(map, lane_x) {
            lane_x += spacing;
            continue;
        }
        // Переулок идёт в одну сторону или в обе.
        let roll = random();
        let directions: &[i64] = if roll < 0.4 {
            &[-1, 1]
        } else if roll < 0.7 {
            &[-1]
        } else {
            &[1]
        };
        for &direction in directions {
            let mut y = if direction < 0 { top - 1 } else { bottom + 1 };
            while y >= 3 && y <= map.height - 4 {
                let cells: Vec<(i64, Option<Painted>)> = [lane_x, lane_x + 1]
                    .into_iter()
                    .map(|x| {
                        let before = tm::cell_at(map, x, y).map(|cell| Painted {
                            x,
                            y,
                            passable: cell.passable,
                            surface: cell.surface,
                            material: cell.material,
                            zone: cell.zone.to_string(),
                            revealed: cell.revealed,
                        });
                        (x, before)
                    })
                    .collect();
                if cells.iter().any(|(_, cell)| cell.as_ref().is_none_or(|cell| cell.surface == "water" || !cell.passable)) {
                    break;
                }
                for (x, before) in cells {
                    if street_at(map, x, y) {
                        continue;
                    }
                    if let Some(before) = before {
                        painted.push(before);
                    }
                    paint_street(map, x, y, material, false)?;
                }
                y += direction;
            }
        }
        lane_x += spacing;
    }
    Ok(painted)
}

/// Площадь посреди деревни (`carveVillageSquare`): 9×7 вокруг клетки улицы,
/// ближайшей к середине карты.
fn carve_village_square(map: &mut TacticalMap, material: &str) -> Result<()> {
    let middle = (map.width.div_euclid(2), map.height.div_euclid(2));
    let mut center: Option<(i64, i64, i64)> = None;
    for cell in tm::cells(map) {
        if cell.zone != "street" {
            continue;
        }
        let distance = (cell.x - middle.0).abs() + (cell.y - middle.1).abs();
        if center.is_none_or(|(_, _, best)| distance < best) {
            center = Some((cell.x, cell.y, distance));
        }
    }
    let Some((cx, cy, _)) = center else { return Ok(()) };
    for y in cy - 3..=cy + 3 {
        for x in cx - 4..=cx + 4 {
            if x < 2 || y < 2 || x > map.width - 3 || y > map.height - 3 {
                continue;
            }
            paint_square(map, x, y, material)?;
        }
    }
    Ok(())
}

/// Деревня по улице (`frontageSpecs`): дома вдоль улицы с обеих сторон,
/// дверью к ней, через палисадник в одну клетку.
fn frontage_specs(map: &TacticalMap, random: &mut dyn FnMut() -> f64, target: usize) -> Vec<Spec> {
    let mut occupied = HashSet::new();
    let mut specs: Vec<Spec> = Vec::new();
    // (x, y, dx, dy)
    let mut fronts: Vec<(i64, i64, i64, i64)> = Vec::new();
    for y in 1..map.height - 1 {
        for x in 1..map.width - 1 {
            if !street_at(map, x, y) {
                continue;
            }
            for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
                if dry_passable(map, x + dx, y + dy) && !street_at(map, x + dx, y + dy) {
                    fronts.push((x, y, dx, dy));
                }
            }
        }
    }
    // Сторона выбирается случайно, чтобы деревни различались.
    let side_order = shuffle(&["-1,0", "1,0", "0,-1", "0,1"], random);
    // Сначала переулки: дом у переулка короче улицы.
    let lane_first = random() < 0.5;
    // Дворы у площади — первыми.
    let on_square = |front: &(i64, i64, i64, i64)| i64::from(zone_is(map, front.0, front.1, &["square"]));
    let side = |front: &(i64, i64, i64, i64)| side_order.iter().position(|entry| *entry == format!("{},{}", front.3, front.2)).map_or(-1, |index| index as i64);
    fronts.sort_by(|left, right| {
        let mut order = on_square(right) - on_square(left);
        if order == 0 && lane_first {
            order = i64::from(right.2 != 0) - i64::from(left.2 != 0);
        }
        if order == 0 {
            order = side(left) - side(right);
        }
        if order == 0 {
            order = if left.3 != 0 {
                if left.0 != right.0 {
                    left.0 - right.0
                } else {
                    left.1 - right.1
                }
            } else if left.1 != right.1 {
                left.1 - right.1
            } else {
                left.0 - right.0
            };
        }
        order.cmp(&0)
    });
    for &(x, y, dx, dy) in &fronts {
        if specs.len() >= target {
            break;
        }
        // Первые три двора и затем каждый пятый — крупные.
        let large = specs.iter().filter(|spec| spec.w * spec.h >= 63).count() < 3 || random() < 0.2;
        let w = if large { 9 + (random() * 2.0).floor() as i64 } else { 7 + (random() * 3.0).floor() as i64 };
        let h = if large { 7 + (random() * 2.0).floor() as i64 } else { 5 + (random() * 2.0).floor() as i64 };
        // Дом стоит в клетке от улицы и смотрит на неё дверью.
        let mut spec;
        if dy == -1 {
            spec = make_spec(x - w.div_euclid(2), y - 1 - h, w, h, None);
            spec.door_x = x;
            spec.door_y = spec.y + h - 1;
        } else if dy == 1 {
            spec = make_spec(x - w.div_euclid(2), y + 2, w, h, None);
            spec.door_x = x;
            spec.door_y = spec.y;
        } else if dx == -1 {
            spec = make_spec(x - 1 - h, y - w.div_euclid(2), h, w, None);
            spec.door_x = spec.x + h - 1;
            spec.door_y = y;
        } else {
            spec = make_spec(x + 2, y - w.div_euclid(2), h, w, None);
            spec.door_x = spec.x;
            spec.door_y = y;
        }
        if !can_place(&spec, &occupied, map) {
            continue;
        }
        reserve_yard(&mut occupied, &spec);
        specs.push(spec);
    }
    specs
}

/// Середины четырёх сторон дома: клетка двери в стене и клетка снаружи.
fn door_sides(spec: &Spec) -> [(Cell, Cell); 4] {
    let mid_x = spec.x + spec.w.div_euclid(2);
    let mid_y = spec.y + spec.h.div_euclid(2);
    [
        ((mid_x, spec.y + spec.h - 1), (mid_x, spec.y + spec.h)),
        ((mid_x, spec.y), (mid_x, spec.y - 1)),
        ((spec.x, mid_y), (spec.x - 1, mid_y)),
        ((spec.x + spec.w - 1, mid_y), (spec.x + spec.w, mid_y)),
    ]
}

/// Второй ряд дворов (`backRowSpecs`): дома в глубине, дверь на ту сторону,
/// откуда настоящая тропа до улицы короче всего.
fn back_row_specs(map: &TacticalMap, specs: &[Spec], random: &mut dyn FnMut() -> f64, target: usize) -> Vec<Spec> {
    let mut occupied = HashSet::new();
    for spec in specs {
        reserve_yard(&mut occupied, spec);
    }
    if !map.zones.iter().any(|zone| zone.id == "street" || zone.id == "square") {
        return Vec::new();
    }
    // Стены домов — препятствие для тропы.
    let mut walls: HashSet<Cell> = specs.iter().flat_map(shape_cells).collect();
    let mut result: Vec<Spec> = Vec::new();
    let sizes = shuffle(&[(7i64, 5i64), (6, 5), (5, 6), (5, 7), (6, 6)], random);
    let mut y = 2;
    while y < map.height - 6 && specs.len() + result.len() < target {
        let mut x = 2;
        while x < map.width - 6 && specs.len() + result.len() < target {
            for &(w, h) in &sizes {
                let mut spec = make_spec(x, y, w, h, None);
                if !can_place(&spec, &occupied, map) {
                    continue;
                }
                let own: Vec<Cell> = shape_cells(&spec);
                let mut blocked = walls.clone();
                blocked.extend(own.iter().copied());
                let mut best: Option<(Cell, Vec<Cell>, usize)> = None;
                for (door, outside) in door_sides(&spec) {
                    let Some(route) = route_to_road(map, outside, &blocked) else { continue };
                    // Дверь к краю карты — в забор околицы: такая сторона дороже.
                    let at_edge = outside.0 <= 1 || outside.1 <= 1 || outside.0 >= map.width - 2 || outside.1 >= map.height - 2;
                    let cost = route.len() + if at_edge { EDGE_DOOR_PENALTY } else { 0 };
                    if best.as_ref().is_none_or(|(_, _, known)| cost < *known) {
                        best = Some((door, route, cost));
                    }
                }
                let Some((door, route, _)) = best else { continue };
                if route.len() > MAX_DOOR_PATH {
                    continue;
                }
                spec.door_x = door.0;
                spec.door_y = door.1;
                result.push(spec);
                reserve_yard(&mut occupied, &spec);
                walls.extend(own);
                break;
            }
            x += 1;
        }
        y += 1;
    }
    result
}

// --- рынок ---------------------------------------------------------------------------------

/// Предмет каталога на карте (`addMarketProp`): свойства из реестра.
fn add_market_prop(map: &mut TacticalMap, asset_id: &str, id: &str, footprint: &[Cell]) -> Result<()> {
    let Some(asset) = asset_by_id(asset_id) else { return Ok(()) };
    let xs = footprint.iter().map(|cell| cell.0 as f64);
    let ys = footprint.iter().map(|cell| cell.1 as f64);
    let (min_x, max_x) = (js::min_of(xs.clone()), js::max_of(xs));
    let (min_y, max_y) = (js::min_of(ys.clone()), js::max_of(ys));
    let span = asset.scale_range.max - asset.scale_range.min;
    let scale = js::parse_number(&js::to_fixed(asset.scale_range.min + span / 2.0, 3));
    let cells: Vec<Value> = footprint.iter().map(|cell| json!({ "x": cell.0, "y": cell.1 })).collect();
    tm::add_prop(
        map,
        &json!({
            "id": id,
            "assetId": asset_id,
            "rotation": 0,
            "x": js::num((min_x + max_x + 1.0) / 2.0),
            "y": js::num((min_y + max_y + 1.0) / 2.0),
            "scale": js::num(scale),
            "footprint": cells,
            "zOrder": 0,
            "blocksMove": asset.blocks_move,
            "blocksSight": asset.blocks_sight,
            "cover": asset.cover,
            "destructible": asset.destructible,
            "hp": js::num(asset.hp),
            "interactive": asset.interactive,
        }),
    )?;
    Ok(())
}

/// Торговые ряды на рыночной площади (`layMarketRows`): лотки 2×2 рядами
/// вдоль улицы, между лотками — проход в клетку, между рядами — в две
/// (зона `path`). Возвращает `(лотков, товаров)`.
fn lay_market_rows(map: &mut TacticalMap, seed: &str, material: &str) -> Result<(usize, usize)> {
    let square: Vec<Cell> = tm::cells(map).filter(|cell| cell.zone == "square").map(|cell| (cell.x, cell.y)).collect();
    if square.is_empty() {
        return Ok((0, 0));
    }
    let min_x = square.iter().map(|cell| cell.0).min().unwrap_or(0);
    let max_x = square.iter().map(|cell| cell.0).max().unwrap_or(0);
    let min_y = square.iter().map(|cell| cell.1).min().unwrap_or(0);
    let max_y = square.iter().map(|cell| cell.1).max().unwrap_or(0);
    let road = |map: &TacticalMap, x: i64, y: i64| zone_is(map, x, y, &["street", "path"]);
    // Улицы, что входят на площадь, идут насквозь.
    let through_rows: HashSet<i64> = (min_y..=max_y).filter(|&y| road(map, min_x - 1, y) || road(map, max_x + 1, y)).collect();
    let through_columns: HashSet<i64> = (min_x..=max_x).filter(|&x| road(map, x, min_y - 1) || road(map, x, max_y + 1)).collect();
    // Подход к двери: клетка за порогом и следующая за ней.
    let mut approaches: HashSet<Cell> = HashSet::new();
    for door in &map.doors {
        let next = tm::edge_neighbor(door.x, door.y, door.dir);
        let step = (next.0 - door.x, next.1 - door.y);
        for point in [(door.x, door.y), next, (door.x - step.0, door.y - step.1), (next.0 + step.0, next.1 + step.1)] {
            approaches.insert(point);
            for (dx, dy) in DIRS {
                approaches.insert((point.0 + dx, point.1 + dy));
            }
        }
    }
    let mut taken: HashSet<Cell> = map.props.iter().flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    let free = |map: &TacticalMap, taken: &HashSet<Cell>, x: i64, y: i64| {
        tm::cell_at(map, x, y).is_some_and(|cell| cell.zone == "square" && cell.passable)
            && x > min_x
            && x < max_x
            && y > min_y
            && y < max_y
            && !through_rows.contains(&y)
            && !through_columns.contains(&x)
            && !approaches.contains(&(x, y))
            && !taken.contains(&(x, y))
    };
    // Кварталы рядов — полосы между сквозными улицами по горизонтали.
    let mut bands: Vec<(i64, i64)> = Vec::new();
    for y in min_y + 1..max_y {
        if through_rows.contains(&y) {
            continue;
        }
        match bands.last_mut() {
            Some(last) if last.1 == y - 1 => last.1 = y,
            _ => bands.push((y, y)),
        }
    }
    let mut random = random_for(&format!("settlement-market:{seed}"));
    let goods_kinds = ["crate", "barrel", "sack"];
    let mut stalls = 0usize;
    let mut goods = 0usize;
    let mut carts = 0usize;
    let mut aisles: Vec<Cell> = Vec::new();
    let put = |map: &mut TacticalMap, taken: &mut HashSet<Cell>, goods: &mut usize, asset_id: &str, footprint: &[Cell]| -> Result<()> {
        let id = format!("market-{}-{}", if asset_id == "cart" { "cart" } else { "goods" }, *goods + 1);
        add_market_prop(map, asset_id, &id, footprint)?;
        taken.extend(footprint.iter().copied());
        *goods += 1;
        Ok(())
    };
    for &(from, to) in &bands {
        // Ряды в полосе: лоток в две клетки, проход в две.
        let mut row_y = from;
        while row_y + 1 <= to && stalls < MARKET_STALLS_MAX {
            let mut x = min_x + 1;
            // Первый ряд площади начинается с подводы: телега и ящик с товаром.
            if carts == 0 && free(map, &taken, x, row_y) && free(map, &taken, x + 1, row_y) && free(map, &taken, x, row_y + 1) {
                put(map, &mut taken, &mut goods, "cart", &[(x, row_y), (x + 1, row_y)])?;
                let kind = goods_kinds[(random() * goods_kinds.len() as f64).floor() as usize];
                put(map, &mut taken, &mut goods, kind, &[(x, row_y + 1)])?;
                carts += 1;
                x += 3;
            }
            let mut after_stall = false;
            while x < max_x {
                let footprint = [(x, row_y), (x + 1, row_y), (x, row_y + 1), (x + 1, row_y + 1)];
                if stalls < MARKET_STALLS_MAX && footprint.iter().all(|&(cx, cy)| free(map, &taken, cx, cy)) {
                    add_market_prop(map, "market_stall", &format!("market-stall-{}", stalls + 1), &footprint)?;
                    taken.extend(footprint);
                    stalls += 1;
                    after_stall = true;
                    x += 3;
                    continue;
                }
                // Ряд упёрся в улицу или край: за последним лотком — товар.
                if after_stall && free(map, &taken, x - 1, row_y) && free(map, &taken, x - 1, row_y + 1) {
                    let kind = goods_kinds[(random() * goods_kinds.len() as f64).floor() as usize];
                    put(map, &mut taken, &mut goods, kind, &[(x - 1, row_y)])?;
                    put(map, &mut taken, &mut goods, "barrel", &[(x - 1, row_y + 1)])?;
                }
                after_stall = false;
                x += 1;
            }
            // Проход за рядом — две клетки, если за ним в полосе есть следующий ряд.
            if row_y + 5 <= to {
                for aisle_x in min_x + 1..max_x {
                    for aisle_y in [row_y + 2, row_y + 3] {
                        if free(map, &taken, aisle_x, aisle_y) {
                            aisles.push((aisle_x, aisle_y));
                        }
                    }
                }
            }
            row_y += 4;
        }
    }
    // Ни телеги, ни ящика не встало: товар — у первого лотка.
    if goods == 0 {
        let aisle_keys: HashSet<Cell> = aisles.iter().copied().collect();
        let stall_cells: HashSet<Cell> =
            map.props.iter().filter(|prop| prop.asset_id == "market_stall").flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
        let spot = square
            .iter()
            .copied()
            .find(|&(x, y)| free(map, &taken, x, y) && !aisle_keys.contains(&(x, y)) && [(1, 0), (-1, 0)].iter().any(|(dx, dy)| stall_cells.contains(&(x + dx, y + dy))));
        if let Some(spot) = spot {
            let kind = goods_kinds[(random() * goods_kinds.len() as f64).floor() as usize];
            add_market_prop(map, kind, "market-goods-1", &[spot])?;
            goods += 1;
        }
    }
    if !aisles.is_empty() {
        if !has_zone(map, "path") {
            add_zone(map, "path", "exterior", material, "bright", "horizontal", None)?;
        }
        for (x, y) in aisles {
            tm::set_cell(map, x, y, &CellPatch { zone: Some("path"), material: Some(material), ..CellPatch::default() })?;
        }
    }
    Ok((stalls, goods))
}

// --- город ---------------------------------------------------------------------------------

/// Отрезок улицы `{ from, to }` поперёк её направления.
type Line = (i64, i64);

/// Город (`townSpecs`): сетка улиц, площадь в центре, кварталы с домами вдоль
/// улиц; гавань и река сохраняют своё.
fn town_specs(map: &mut TacticalMap, design: &Design, random: &mut dyn FnMut() -> f64, materials: &Materials) -> Result<Vec<Spec>> {
    let width = map.width;
    let height = map.height;
    let center_x = width.div_euclid(2);
    let center_y = height.div_euclid(2);
    let harbor = design.topology == "harbor";
    let river = design.topology == "river";
    let land_right = if harbor { width - 6 } else { width - 1 };
    let mut verticals: Vec<Line> = Vec::new();
    let mut horizontals: Vec<Line> = Vec::new();
    // Переулки делят каждую половину на равные кварталы.
    let lanes_between = |start: i64, end: i64, block: i64| -> Vec<Line> {
        let span = end - start + 1;
        let count = 1i64.max((span + 2).div_euclid(block + 2));
        (1..count)
            .map(|index| {
                let at = start + js::round((span * index) as f64 / count as f64) as i64 - 1;
                (at, at + 1)
            })
            .collect()
    };
    // Кольцевая улица вдоль края.
    verticals.extend([(2, 3), (land_right - 4, land_right - 3)]);
    horizontals.extend([(2, 3), (height - 4, height - 3)]);
    verticals.push((center_x - 1, center_x + 1));
    verticals.extend(lanes_between(4, center_x - 2, 11));
    verticals.extend(lanes_between(center_x + 2, land_right - 5, 11));
    horizontals.push((center_y - 1, center_y + 1));
    horizontals.extend(lanes_between(4, center_y - 2, 12));
    horizontals.extend(lanes_between(center_y + 2, height - 5, 12));
    let street = materials.street.as_str();
    for &(from, to) in &verticals {
        for x in from..=to {
            for y in 1..height - 1 {
                paint_street(map, x, y, street, false)?;
            }
        }
    }
    for &(from, to) in &horizontals {
        for y in from..=to {
            for x in 0..land_right {
                paint_street(map, x, y, street, false)?;
            }
        }
    }
    if harbor {
        for y in 0..height {
            for x in land_right..width {
                set_water(map, x, y, materials.surface)?;
            }
        }
        // Причалы — продолжение каждой поперечной улицы в воду.
        for &(from, _) in &horizontals {
            for x in land_right..width - 1 {
                paint_street(map, x, from, "wood", true)?;
            }
        }
    }
    if river {
        // Первая в порядке объявления, а не по высоте (см. отчёт переноса).
        let river_y = horizontals.iter().find(|line| line.0 > center_y + 2).map_or(center_y + 6, |line| line.0);
        for y in river_y..=river_y + 1 {
            for x in 0..width {
                set_water(map, x, y, "stone")?;
            }
        }
        let bridge = if ["stone", "marble", "metal"].contains(&design.architecture.as_str()) { design.architecture.as_str() } else { "wood" };
        for &(from, to) in &verticals {
            for x in from..=to {
                for y in river_y..=river_y + 1 {
                    paint_street(map, x, y, bridge, true)?;
                }
            }
        }
        // Набережная — кромка на ребре между мостовой и водой.
        let ledge = EdgePatch { kind: Some("ledge"), blocks_move: Some(false), blocks_sight: Some(false), cover: Some("none"), door_id: None };
        for x in 0..width {
            for (land_y, water_y) in [(river_y - 1, river_y), (river_y + 2, river_y + 1)] {
                let land = tm::cell_passable(map, x, land_y);
                let water = tm::cell_at(map, x, water_y).is_some_and(|cell| cell.surface == "water" && !cell.passable);
                if !land || !water {
                    continue;
                }
                tm::set_edge(map, x, land_y, x, water_y, &ledge)?;
            }
        }
    }
    // Площадь на перекрёстке главной и поперечной; рыночная — шире.
    let market = design.topology == "market";
    let square_w: i64 = if design.scale == "city" { 12 } else { 10 } + if market { 6 } else { 0 };
    let square_h: i64 = if design.scale == "city" { 10 } else { 8 } + if market { 4 } else { 0 };
    let square_y = center_y - square_h.div_euclid(2);
    let square_x = center_x - square_w.div_euclid(2);
    for y in square_y..square_y + square_h {
        for x in square_x..square_x + square_w {
            paint_square(map, x, y, street)?;
        }
    }
    // Кварталы — промежутки между линиями улиц.
    let cuts = |lines: &[Line], limit: i64| -> Vec<Line> {
        let mut sorted = lines.to_vec();
        sorted.sort_by_key(|line| line.0);
        let mut spans = Vec::new();
        let mut start = 2;
        for (from, to) in sorted {
            if from - 1 >= start {
                spans.push((start, from - 1));
            }
            start = to + 1;
        }
        if limit >= start {
            spans.push((start, limit));
        }
        spans
    };
    let columns = cuts(&verticals, land_right - 3);
    let rows = cuts(&horizontals, height - 3);
    let mut specs: Vec<Spec> = Vec::new();
    let mut occupied = HashSet::new();
    // Крупные дома: часть кварталов целиком отдаётся одному-двум домам.
    let blocks: Vec<(Line, Line)> =
        rows.iter().flat_map(|row| columns.iter().map(move |column| (*row, *column))).filter(|(row, column)| column.1 - column.0 + 1 >= 5 && row.1 - row.0 + 1 >= 8).collect();
    let deep_count = 2usize.max(js::round(blocks.len() as f64 * 0.15) as usize);
    let indices: Vec<usize> = (0..blocks.len()).collect();
    let deep_blocks: HashSet<(i64, i64)> = shuffle(&indices, random).into_iter().take(deep_count).map(|index| (blocks[index].0 .0, blocks[index].1 .0)).collect();
    for &row in &rows {
        for &column in &columns {
            let block_h = row.1 - row.0 + 1;
            let block_w = column.1 - column.0 + 1;
            if block_w < 5 || block_h < 5 {
                continue;
            }
            let street_above = street_at(map, column.0 + 1, row.0 - 1);
            if deep_blocks.contains(&(row.0, column.0)) {
                // Глубина 9–10 клеток: за домом остаётся двор.
                let h = block_h.min(9 + (random() * 2.0).floor() as i64);
                let y = if street_above { row.0 } else { row.1 - h + 1 };
                let mut x = column.0;
                while x <= column.1 - 7 {
                    let remaining = column.1 - x + 1;
                    let mut w = 8 + (random() * 3.0).floor() as i64;
                    if remaining - w - 1 < 7 {
                        w = remaining.min(11);
                    }
                    let mut spec = make_spec(x, y, w, h, None);
                    spec.door_x = x + w.div_euclid(2);
                    spec.door_y = if street_above { y } else { y + h - 1 };
                    if can_place(&spec, &occupied, map) {
                        reserve_spec(&mut occupied, &spec);
                        specs.push(spec);
                    }
                    x += w + 1;
                }
                continue;
            }
            // Два ряда, если квартал глубже одиннадцати клеток, иначе один.
            let street_below = street_at(map, column.0 + 1, row.1 + 1);
            let mut depth = || 5 + (random() * 2.0).floor() as i64;
            // (y, h, дверь сверху)
            let mut lanes: Vec<(i64, i64, bool)> = Vec::new();
            if block_h >= 11 {
                let top = depth();
                let bottom = depth().min(block_h - top - 1);
                lanes.push((row.0, top, true));
                lanes.push((row.1 - bottom + 1, bottom, false));
            } else {
                let h = block_h.min(depth() + if block_h >= 8 { 1 } else { 0 });
                lanes.push(if street_below && !street_above { (row.1 - h + 1, h, false) } else { (row.0, h, true) });
            }
            for (lane_y, lane_h, door_top) in lanes {
                let mut x = column.0;
                while x <= column.1 - 4 {
                    let remaining = column.1 - x + 1;
                    let mut w = 5 + (random() * 3.0).floor() as i64;
                    if remaining - w - 1 < 5 {
                        w = remaining.min(9);
                    }
                    if w < 5 {
                        break;
                    }
                    // Иногда участок пустует: сад, огород или пепелище.
                    let garden_chance = match design.density.as_str() {
                        "dense" => 0.06,
                        "sparse" => 0.22,
                        _ => 0.12,
                    };
                    if random() >= garden_chance {
                        let mut spec = make_spec(x, lane_y, w, lane_h, None);
                        spec.door_x = x + w.div_euclid(2);
                        spec.door_y = if door_top { lane_y } else { lane_y + lane_h - 1 };
                        if can_place(&spec, &occupied, map) {
                            reserve_spec(&mut occupied, &spec);
                            specs.push(spec);
                        }
                    }
                    x += w + 1;
                }
            }
        }
    }
    Ok(specs)
}

// --- деревня по топологии -------------------------------------------------------------------

/// Улицы и области застройки по топологии (`buildingSpecs`).
fn building_specs(map: &mut TacticalMap, design: &Design, random: &mut dyn FnMut() -> f64) -> Result<Vec<Spec>> {
    let width = map.width;
    let height = map.height;
    let center_x = width.div_euclid(2);
    let center_y = height.div_euclid(2);
    let requested = density_count(&design.density, random);
    let mut regions: Vec<Rect> = Vec::new();
    let outer_width = width - 4;
    let outer_height = height - 4;
    let density = design.density.as_str();
    match design.topology.as_str() {
        "crossroads" => {
            for y in 0..height {
                for dx in -1..=1 {
                    paint_street(map, center_x + dx, y, "earth", false)?;
                }
            }
            let left_width = 12.max(center_x - 3);
            let right_width = 12.max(width - center_x - 4);
            let top_height = 10.max(center_y - 3);
            let bottom_height = 10.max(height - center_y - 3);
            regions.extend([
                Rect::new(2, 2, left_width, top_height),
                Rect::new(center_x + 3, 2, right_width, top_height),
                Rect::new(2, center_y + 2, left_width, bottom_height),
                Rect::new(center_x + 3, center_y + 2, right_width, bottom_height),
            ]);
            Ok(plan_in_regions(map, random, requested.min(8), &regions, false, density))
        }
        "linear" => {
            let lane_height = 9.max((height - 8).div_euclid(2));
            regions.extend([Rect::new(2, 2, outer_width, lane_height), Rect::new(2, height - lane_height - 2, outer_width, lane_height)]);
            Ok(plan_in_regions(map, random, requested, &regions, false, density))
        }
        "market" => {
            // Рыночная площадь — под ряды лотков с проходами.
            let square_w = MARKET_SQUARE.0 + (random() * 3.0).floor() as i64;
            let square_h = MARKET_SQUARE.1 + (random() * 2.0).floor() as i64;
            let square_x = center_x - square_w.div_euclid(2);
            let square_y = center_y - square_h.div_euclid(2);
            for y in square_y..square_y + square_h {
                for x in square_x..square_x + square_w {
                    paint_square(map, x, y, "earth")?;
                }
            }
            regions.extend([
                Rect::new(2, 2, outer_width, 6.max(square_y - 3)),
                Rect::new(2, square_y + square_h + 2, outer_width, 6.max(height - (square_y + square_h + 4))),
                Rect::new(2, square_y + 1, 6.max(square_x - 3), 6.max(square_h - 1)),
                Rect::new(square_x + square_w + 2, square_y + 1, 6.max(width - (square_x + square_w + 4)), 6.max(square_h - 1)),
            ]);
            Ok(plan_in_regions(map, random, requested.min(9), &regions, false, density))
        }
        "courtyard" => {
            let court_width = 7 + (random() * 3.0).floor() as i64;
            let court_height = 6 + (random() * 3.0).floor() as i64;
            let court_x = center_x - court_width.div_euclid(2);
            let court_y = center_y - court_height.div_euclid(2);
            for y in court_y..court_y + court_height {
                for x in court_x..court_x + court_width {
                    paint_square(map, x, y, "earth")?;
                }
            }
            regions.extend([
                Rect::new(2, 2, outer_width, 6.max(court_y - 3)),
                Rect::new(2, court_y + 1, 6.max(court_x - 3), 6.max(court_height - 1)),
                Rect::new(court_x + court_width + 2, court_y + 1, 6.max(width - (court_x + court_width + 4)), 6.max(court_height - 1)),
                Rect::new(2, court_y + court_height + 2, outer_width, 6.max(height - (court_y + court_height + 4))),
            ]);
            Ok(plan_in_regions(map, random, requested.min(9), &regions, false, density))
        }
        "harbor" => {
            let shoreline = width - 4;
            for y in [(height as f64 * 0.25).floor() as i64, (height as f64 * 0.5).floor() as i64, (height as f64 * 0.75).floor() as i64] {
                for x in shoreline - 2..width {
                    paint_street(map, x, y, "wood", true)?;
                }
            }
            let land_width = shoreline - 3;
            let half = 8.max((height - 7).div_euclid(2));
            regions.extend([Rect::new(2, 2, land_width, half), Rect::new(2, height.div_euclid(2) + 2, land_width, half)]);
            Ok(plan_in_regions(map, random, requested.min(9), &regions, false, density))
        }
        "river" => {
            // Река петляет: русло уходит по синусоиде на две клетки вверх и
            // вниз и местами разливается шире.
            let river_y = center_y;
            let swing = 2.0;
            let phase = random() * PI * 2.0;
            let course = |x: i64| river_y + js::round(sin((x as f64 / (width - 1).max(1) as f64) * PI * 2.4 + phase) * swing) as i64;
            let spread = |x: i64| if sin(x as f64 * 0.53 + phase * 1.7) > 0.75 { 2 } else { 1 };
            for x in 0..width {
                for y in course(x) - spread(x)..=course(x) + spread(x) {
                    if tm::cell_exists(map, x, y) {
                        set_water(map, x, y, "stone")?;
                    }
                }
            }
            // Пологий берег: полоса песка вдоль воды.
            for x in 0..width {
                for y in [course(x) - spread(x) - 1, course(x) + spread(x) + 1] {
                    if dry_passable(map, x, y) {
                        tm::set_cell(map, x, y, &CellPatch { material: Some("sand"), ..CellPatch::default() })?;
                    }
                }
            }
            let bridge_xs = [1, 3.max(center_x - 1), 5.max(width - 4)];
            let bridge_material = if ["stone", "marble", "metal"].contains(&design.architecture.as_str()) { design.architecture.as_str() } else { "wood" };
            for bridge_x in bridge_xs {
                for x in bridge_x..=(width - 1).min(bridge_x + 2) {
                    for y in 0..height {
                        paint_street(map, x, y, bridge_material, true)?;
                    }
                }
            }
            // Дома стоят выше и ниже самого дальнего изгиба.
            let reach = 2 + 2;
            regions.extend([Rect::new(2, 2, outer_width, 8.max(river_y - reach - 5)), Rect::new(2, river_y + reach + 3, outer_width, 8.max(height - river_y - reach - 5))]);
            Ok(plan_in_regions(map, random, requested, &regions, false, density))
        }
        "gate" => {
            let wall_x = (width as f64 * 0.5).floor() as i64;
            let gate_y = center_y;
            for y in 1..height - 1 {
                if y == gate_y || y == gate_y + 1 {
                    continue;
                }
                tm::set_edge(map, wall_x - 1, y, wall_x, y, &WALL)?;
            }
            set_door(map, "city-gate", (wall_x - 1, gate_y, "e"), "open")?;
            for x in 0..width {
                paint_street(map, x, gate_y, "earth", false)?;
            }
            for x in wall_x - 3..=wall_x + 3 {
                paint_street(map, x, gate_y + 1, "earth", false)?;
            }
            regions.extend([
                Rect::new(2, 2, 11.max(wall_x - 4), 8.max(gate_y - 4)),
                Rect::new(2, gate_y + 3, 11.max(wall_x - 4), 8.max(height - gate_y - 5)),
                Rect::new(wall_x + 2, 2, 11.max(width - wall_x - 4), 8.max(gate_y - 4)),
                Rect::new(wall_x + 2, gate_y + 3, 11.max(width - wall_x - 4), 8.max(height - gate_y - 5)),
            ]);
            let target = if design.density == "dense" { 7 + (random() * 2.0).floor() as usize } else { requested.min(6) };
            Ok(plan_gate_buildings(map, random, target, &regions, density))
        }
        "terraced" => {
            let row_height = 8;
            let row_count = 2.max((height - 4).div_euclid(row_height));
            for row in 0..row_count {
                let y = 2 + row * row_height;
                for x in 0..width {
                    paint_street(map, x, y, "earth", false)?;
                }
                regions.push(Rect::new(2, y + 1, outer_width, 6.max((row_height - 2).min(height - y - 2))));
            }
            Ok(plan_in_regions(map, random, requested, &regions, false, density))
        }
        _ => {
            // Органическая схема: изгиб улицы и L-образные пристройки.
            let phase = random() * PI * 2.0;
            let bend = 2.max((height as f64 * (0.1 + random() * 0.04)).floor() as i64);
            for x in 0..width {
                let road_y = center_y + js::round(sin((x as f64 / (width - 1).max(1) as f64) * PI * 1.5 + phase) * bend as f64) as i64;
                for dy in -1..=1 {
                    paint_street(map, x, road_y + dy, "earth", false)?;
                }
            }
            regions.push(Rect::new(2, 2, outer_width, outer_height));
            Ok(plan_in_regions(map, random, requested, &regions, true, density))
        }
    }
}

// --- сборка ----------------------------------------------------------------------------------

/// Итог `buildSettlementScene`: карта, предупреждения (всегда пусто) и
/// назначение каждой постройки по id её зоны.
#[derive(Clone, Debug, PartialEq)]
pub struct SettlementScene {
    pub map: TacticalMap,
    pub warnings: Vec<String>,
    pub uses: IndexMap<String, String>,
}

impl SettlementScene {
    /// `uses` в форме JS: объект `{ "building-1": "tavern", … }`.
    pub fn uses_json(&self) -> Value {
        Value::Object(self.uses.iter().map(|(zone, use_)| (zone.clone(), Value::String(use_.clone()))).collect())
    }
}

/// `buildSettlementScene(options)`: улица и кварталы — первая попытка; если
/// какой-то дом остался без пути, поселение собирается прежним подбором по
/// областям. `options` — `{ seed, width, height, locationId, theme, design }`.
pub fn build_settlement_scene(options: &Value) -> Result<SettlementScene> {
    match build_settlement_once(options, Planner::Street) {
        Ok(scene) => Ok(scene),
        Err(_) => build_settlement_once(options, Planner::Regions),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Planner {
    Street,
    Regions,
}

/// Наименьший размер карты поселения по масштабу.
fn settlement_min_size(scale: &str) -> (i64, i64) {
    match scale {
        "village" => (44, 38),
        "town" => (48, 44),
        "city" => (56, 52),
        _ => (26, 26),
    }
}

fn build_settlement_once(options: &Value, planner: Planner) -> Result<SettlementScene> {
    let seed = field(options, "seed").map_or_else(|| "settlement".to_string(), |seed| js::string(Some(seed)));
    let empty = json!({});
    let theme = field(options, "theme").unwrap_or(&empty);
    let design_input = field(options, "design").unwrap_or(&empty);
    let location_id = field(options, "locationId").and_then(Value::as_str).unwrap_or("");
    let chosen = design_for(theme, &seed, design_input)?;
    let mut random = random_for(&format!("settlement:{seed}:{}", chosen.topology));
    // Масштаб задаёт наименьший размер: деревня — от 44×38, город — от 48×44,
    // столица — от 56×52.
    let minimum = settlement_min_size(&chosen.scale);
    let safe_width = js::safe_int(field(options, "width"), 30).max(minimum.0).clamp(26, 60);
    let safe_height = js::safe_int(field(options, "height"), 30).max(minimum.1).clamp(26, 60);
    let materials = materials(&chosen, theme);
    let theme_id = match field(theme, "id") {
        Some(id) if !id.is_null() => js::string(Some(id)),
        _ => "settlement".to_string(),
    };
    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: safe_width,
        height: safe_height,
        location_id,
        seed: &seed,
        generator: Some((SETTLEMENT_GENERATOR.id, SETTLEMENT_GENERATOR.version)),
        theme: &theme_id,
        size_class: "area",
        ..TacticalMapOptions::default()
    })?;
    let common_label = match chosen.scale.as_str() {
        "city" | "town" => "Город",
        "village" => "Деревня",
        _ => "Поселение",
    };
    add_zone(&mut map, "common", "exterior", materials.surface, "bright", "horizontal", Some(common_label))?;
    add_zone(&mut map, "street", "exterior", &materials.street, "bright", "horizontal", Some("Улицы"))?;
    let urban = chosen.scale == "town" || chosen.scale == "city";
    let topology = chosen.topology.as_str();
    // Площадь посреди поселения — площадь, а не «внутренний двор».
    let village_square = chosen.square && !urban && topology != "market" && topology != "courtyard";
    if urban || topology == "market" || topology == "courtyard" || village_square {
        let label = if topology == "market" || urban { "Торговая площадь" } else { "Площадь" };
        add_zone(&mut map, "square", "exterior", &materials.street, "bright", "horizontal", Some(label))?;
    }
    // Река течёт: у неё своя фактура струй, у гавани — стоячая вода.
    if topology == "river" || topology == "harbor" {
        let mut water = json!({
            "id": "water", "kind": "exterior", "material": materials.surface, "lightLevel": "bright", "floorDirection": "horizontal",
            "label": if topology == "river" { "Река" } else { "Вода" },
        });
        if topology == "river" {
            if let Some(object) = water.as_object_mut() {
                object.insert("floor".into(), Value::String("river".into()));
            }
        }
        tm::add_zone(&mut map, &water)?;
    }
    for y in 0..safe_height {
        for x in 0..safe_width {
            tm::set_cell(&mut map, x, y, &CellPatch { passable: Some(true), material: Some(materials.surface), zone: Some("common"), revealed: Some(true), ..CellPatch::default() })?;
        }
    }
    let center_y = safe_height.div_euclid(2);
    if topology != "organic" && !urban {
        for x in 0..safe_width {
            for dy in -1..=1 {
                paint_street(&mut map, x, center_y + dy, &materials.street, false)?;
            }
        }
    }
    if topology == "harbor" && !urban {
        for y in 0..safe_height {
            for x in safe_width - 4..safe_width {
                set_water(&mut map, x, y, materials.surface)?;
            }
        }
    }
    let mut occupied: HashSet<Cell> = HashSet::new();
    // Деревня: улицы прокладывает прежний планировщик своей топологии.
    let legacy = if urban && planner == Planner::Street { Vec::new() } else { building_specs(&mut map, &chosen, &mut random)? };
    // Площадь вырезается по уже проложенной улице и до домов.
    if village_square {
        carve_village_square(&mut map, &materials.street)?;
    }
    // Редкая застройка — хутор или выселки.
    let village_target = match chosen.density.as_str() {
        "dense" => 14,
        "sparse" => 5,
        _ => 12,
    };
    let village_street = planner == Planner::Street && !urban && chosen.scale == "village";
    let lanes = if village_street && chosen.density != "sparse" { paint_village_lanes(&mut map, &mut random, &materials.street)? } else { Vec::new() };
    // Крупный двор весит как полтора обычных.
    let weight = |list: &[Spec]| list.iter().map(|spec| if spec.w * spec.h >= 63 { 1.6 } else { 1.0 }).sum::<f64>();
    let mut along_street: Vec<Spec> = Vec::new();
    if village_street {
        for attempt in 0..6 {
            let mut frontage_random = random_for(&format!("settlement-frontage:{seed}:{attempt}"));
            let next = frontage_specs(&map, &mut frontage_random, village_target);
            if weight(&next) > weight(&along_street) {
                along_street = next;
            }
        }
    }
    if !along_street.is_empty() {
        let back = back_row_specs(&map, &along_street, &mut random, village_target);
        along_street.extend(back);
    }
    // Улица выигрывает и при чуть меньшем числе дворов.
    let street_wins = !along_street.is_empty() && (along_street.len() >= legacy.len() || (along_street.len() as i64) >= 8.min(legacy.len() as i64 - 1));
    if !street_wins {
        for before in &lanes {
            tm::set_cell(
                &mut map,
                before.x,
                before.y,
                &CellPatch {
                    passable: Some(before.passable),
                    surface: Some(before.surface),
                    material: Some(before.material),
                    zone: Some(&before.zone),
                    revealed: Some(before.revealed),
                    ..CellPatch::default()
                },
            )?;
        }
    }
    let mut specs = if urban && planner == Planner::Street {
        town_specs(&mut map, &chosen, &mut random, &materials)?
    } else if street_wins {
        along_street
    } else {
        legacy
    };
    // Город не бывает меньше дюжины дворов: добор вторым рядом.
    let urban_target = if chosen.scale == "city" { 18 } else { 14 };
    if urban && planner == Planner::Street && specs.len() < urban_target {
        let back = back_row_specs(&map, &specs, &mut random, urban_target);
        specs.extend(back);
    }
    let uses = settlement_uses(&specs, &chosen);
    let mut building_uses: IndexMap<String, String> = IndexMap::new();
    for (index, spec) in specs.iter().enumerate() {
        let design = BuildingDesign { building_use: &uses[index], architecture: &materials.building };
        if add_building(&mut map, spec, index, &design, &mut occupied)? {
            building_uses.insert(format!("building-{}", index + 1), uses[index].clone());
        }
    }
    for y in 0..safe_height {
        for x in 0..safe_width {
            let border = x == 0 || x == safe_width - 1 || y == 0 || y == safe_height - 1;
            if border && zone_is(&map, x, y, &["common"]) {
                tm::set_cell(&mut map, x, y, &CellPatch { passable: Some(false), material: Some(materials.surface), zone: Some(""), ..CellPatch::default() })?;
            }
        }
    }
    // К каждой двери, что не выходит прямо на улицу, — тропа (версия 5).
    lay_door_paths(&mut map, &materials.street)?;
    let entrance_row = (0..safe_height).filter(|&y| zone_is(&map, 1, y, &["street"])).min_by_key(|&y| ((y - center_y).abs(), y)).unwrap_or(center_y);
    let spawn = (1, entrance_row);
    tm::set_cell(
        &mut map,
        spawn.0,
        spawn.1,
        &CellPatch { passable: Some(true), surface: Some("none"), material: Some(&materials.street), zone: Some("street"), revealed: Some(true), ..CellPatch::default() },
    )?;
    tm::add_spawn_point(&mut map, &json!({ "id": "party-entrance", "x": spawn.0, "y": spawn.1, "role": "party" }))?;
    ensure_building_reachability(&mut map, spawn)?;
    // Стены домов — на рёбрах клеток.
    thin_walls(&mut map, &ThinWallsOptions::default())?;
    // Торговые ряды — после тонких стен: двери уже на своих местах.
    if topology == "market" {
        lay_market_rows(&mut map, &seed, &materials.street)?;
    }
    // Пол каждой комнаты — по её назначению.
    for (zone_id, use_) in &building_uses {
        let context = RoomContext { use_, architecture: &materials.building };
        let prefix = format!("{zone_id}-");
        let accept = |zone: &TacticalZone| zone.id == *zone_id || zone.id.starts_with(&prefix);
        apply_room_floors(&mut map, &RoomFloorsOptions { context, wall: building_wall_style_for(&context, urban), default_floor: None, zones: Some(&accept) })?;
    }
    map.overlays = Overlays {
        compass: true,
        scale_bar: true,
        room_labels: map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| RoomLabel { zone_id: zone.id.clone(), label: zone.label.clone() }).collect(),
    };
    Ok(SettlementScene { map, warnings: Vec::new(), uses: building_uses })
}
