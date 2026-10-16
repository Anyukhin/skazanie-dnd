//! Перенос `server/level-generator.mjs` — генератор этажей локации.
//!
//! Этаж — отдельная `TacticalMap` той же локации. Строится он от этажа, откуда
//! идёт переход: второй этаж стоит ровно на контуре первого (interior-зоны или,
//! после круга через старые клетки, помещение вокруг лестницы), подвал — на
//! сжатом контуре, пещерный ярус — та же органическая пещера с прибытием в
//! основной полости (соседние сиды вместо правки геометрии). Всё
//! детерминировано от сида: тот же вход даёт байт в байт ту же сериализованную
//! карту.
//!
//! Вход — уже прочитанная карта исходного этажа ([`TacticalMap`]) и предмет-
//! переход рыхлым JSON (как `sourceProp` в JS). Исключение JS (отказ
//! `setCell`, `TypeError` на `footprint: [null]`) — `Err` с именем и текстом V8.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sk_buildings::building_generator::{edges_around, open_doorway, open_window, plan_rooms, EdgesAroundOptions, Rect};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js, text};
use sk_map_core::room_floors::{apply_room_floors, RoomFloorsOptions};
use sk_map_core::thin_walls::{thin_walls, ThinWallsOptions};
use sk_props::prop_placement::{place_props, ZonePlacementPlan};
use sk_tactical::tactical_map::{
    self as tm, CellPatch, EdgeKind, EdgePatch, Overlays, RoomLabel, TacticalMap, TacticalMapOptions, ValidationIssue, FLOOR_VARIANTS,
    MAX_LEVEL_OFFSET,
};
use sk_themes::scene_themes::{layout_organic_cave, LayoutOptions, ThemeError, SCENE_THEMES};

use crate::weather::{object_prototype_text, slice_utf16, JsNum};

/// `LEVEL_GENERATOR`: генератор этажей в записи карты.
pub const LEVEL_GENERATOR_ID: &str = "level-generator";
pub const LEVEL_GENERATOR_VERSION: &str = "1";

/// Сколько дополнительных этажей может объявить архитектор.
pub const MAX_DECLARED_LEVELS: usize = 3;

/// Сколько соседних сидов пробуем, прежде чем признать пещеру непригодной.
const CAVE_SEED_ATTEMPTS: usize = 6;

/// Доля пола, достижимая от точки прибытия, чтобы полость считалась основной.
const CAVE_MAIN_CHAMBER_SHARE: f64 = 0.6;

const ORTHOGONAL: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

type Cell = (i64, i64);
type Outline = IndexSet<Cell>;
type Result<T> = std::result::Result<T, ThemeError>;

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/// Объявленный этаж (`DeclaredLevel`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclaredLevel {
    /// Смещение от этажа входа; ноль запрещён.
    pub offset: i64,
    /// Назначение этажа словами архитектора.
    pub hint: String,
    /// Подпись этажа для игрока.
    pub label: String,
}

impl DeclaredLevel {
    /// Форма JS: `{ offset, hint, label }`.
    pub fn to_json(&self) -> Value {
        json!({ "offset": self.offset, "hint": self.hint, "label": self.label })
    }
}

/// Итог `generateLevelMap` (`LevelGenerationResult`).
#[derive(Clone, Debug)]
pub struct LevelGenerationResult {
    /// `None` при отказе.
    pub map: Option<TacticalMap>,
    pub level_index: i64,
    pub level_label: String,
    /// Точка прибытия на новом этаже.
    pub arrival: Option<Cell>,
    /// Предмет обратного перехода.
    pub transition_prop_id: String,
    pub warnings: Vec<String>,
    pub errors: Vec<ValidationIssue>,
}

impl LevelGenerationResult {
    /// Форма JS без карты: `{ levelIndex, levelLabel, arrival, transitionPropId, warnings, errors }`.
    pub fn to_json_without_map(&self) -> Value {
        json!({
            "levelIndex": self.level_index,
            "levelLabel": self.level_label,
            "arrival": self.arrival.map_or(Value::Null, |(x, y)| json!({ "x": x, "y": y })),
            "transitionPropId": self.transition_prop_id,
            "warnings": self.warnings,
            "errors": issues_json(&self.errors),
        })
    }
}

/// Замечания в форме JS: `[{ code, message, at? }]`.
pub fn issues_json(issues: &[ValidationIssue]) -> Value {
    Value::Array(
        issues
            .iter()
            .map(|issue| {
                let mut entry = Map::new();
                entry.insert("code".into(), Value::String(issue.code.clone()));
                entry.insert("message".into(), Value::String(issue.message.clone()));
                if let Some(at) = &issue.at {
                    entry.insert("at".into(), Value::String(at.clone()));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

/// Параметры `generateLevelMap({ locationId, level, seed, baseMap, sourceProp, hint, theme })`.
/// `None` — поля нет (`undefined`): тогда действует умолчание JS.
#[derive(Clone, Copy, Debug, Default)]
pub struct LevelOptions<'a> {
    pub location_id: &'a str,
    /// Этаж, который строим (`Number(level)`).
    pub level: Option<&'a Value>,
    /// Сид этажа (`levelSeed`); `None` — `'level'`, иначе `String(seed)`.
    pub seed: Option<&'a Value>,
    /// Карта этажа, откуда идёт переход.
    pub base_map: Option<&'a TacticalMap>,
    /// Предмет-переход на исходном этаже (`{ assetId, x, y, footprint }`).
    pub source_prop: Option<&'a Value>,
    /// Назначение этажа из заявки архитектора.
    pub hint: Option<&'a Value>,
    /// Тема локации (`String(theme ?? '')`).
    pub theme: Option<&'a Value>,
}

// ---------------------------------------------------------------------------
// Помощники
// ---------------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|object| object.get(key))
}

fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `Math.max(min, Math.min(max, value))`: при `min > max` — `min`.
fn clamp(value: i64, min: i64, max: i64) -> i64 {
    min.max(max.min(value))
}

fn round_half(value: f64) -> i64 {
    js::round(value) as i64
}

/// `randomFor(seed)`: линейный конгруэнтный генератор от первых четырёх байт
/// SHA-256 строки сида (ноль заменяется единицей).
fn random_for(seed: &str) -> impl FnMut() -> f64 {
    let digest = hash::sha256(seed);
    let base = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let mut state = if base == 0 { 1 } else { base };
    move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(state) / 4_294_967_296.0
    }
}

/// `cleanText(value, maximum)`: только строка; пробелы схлопнуты, обрезка по UTF-16.
fn clean_text(value: Option<&Value>, maximum: usize) -> String {
    match value {
        Some(Value::String(raw)) => slice_utf16(&text::squash_spaces(raw), maximum),
        _ => String::new(),
    }
}

/// `text.charAt(0).toLocaleUpperCase('ru') + text.slice(1)`: символ вне BMP
/// `charAt` режет пополам, и половина суррогатной пары заглавной не становится.
fn capitalize_first(source: &str) -> String {
    let mut chars = source.chars();
    let Some(first) = chars.next() else { return String::new() };
    if first.len_utf16() > 1 {
        return source.to_string();
    }
    format!("{}{}", text::upper(&first.to_string()), chars.as_str())
}

fn key_of(cell: Cell) -> String {
    format!("{},{}", cell.0, cell.1)
}

/// `[...outline].sort()`: по строкам `"x,y"`.
fn sorted_cells(outline: &Outline) -> Vec<Cell> {
    let mut keyed: Vec<(String, Cell)> = outline.iter().map(|cell| (key_of(*cell), *cell)).collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    keyed.into_iter().map(|(_, cell)| cell).collect()
}

fn passable_at(map: &TacticalMap, x: i64, y: i64) -> Option<bool> {
    tm::cell_at(map, x, y).map(|cell| cell.passable)
}

fn type_error(key: &str, of: &str) -> ThemeError {
    ThemeError { name: "TypeError", code: None, message: format!("Cannot read properties of {of} (reading '{key}')") }
}

/// `SIZE_CLASSES[map.sizeClass].maxProps`. Ключ прототипа находит функцию без
/// `maxProps` — `placeProps` берёт своё умолчание 250; неизвестный ключ — `TypeError`.
fn max_props_of(map: &TacticalMap) -> Result<i64> {
    if let Some(limits) = tm::size_class(&map.size_class) {
        return Ok(limits.max_props);
    }
    if object_prototype_text(&map.size_class).is_some() {
        return Ok(250);
    }
    Err(type_error("maxProps", "undefined"))
}

fn zone_plans(plans: &[Value]) -> Vec<ZonePlacementPlan> {
    plans.iter().filter_map(ZonePlacementPlan::from_json).collect()
}

// ---------------------------------------------------------------------------
// Подписи и заявка
// ---------------------------------------------------------------------------

const DEFAULT_LEVEL_LABELS: [(i64, &str); 7] = [
    (0, "Первый этаж"),
    (1, "Второй этаж"),
    (2, "Третий этаж"),
    (3, "Четвёртый этаж"),
    (-1, "Подвал"),
    (-2, "Нижний подвал"),
    (-3, "Глубокий подвал"),
];

/// `levelLabelFor(offset, hint)`: подпись этажа. Наверху — порядковая,
/// внизу — слова архитектора с заглавной буквы.
pub fn level_label_for(offset: impl JsNum, hint: Option<&Value>) -> String {
    let number = offset.js_number();
    let index = if is_safe_integer(number) { number as i64 } else { 0 };
    let fallback = DEFAULT_LEVEL_LABELS
        .iter()
        .find(|(level, _)| *level == index)
        .map_or_else(|| if index > 0 { format!("Этаж {}", index + 1) } else { format!("Ярус {index}") }, |(_, label)| (*label).to_string());
    let hint = clean_text(hint, 60);
    if index >= 0 || hint.is_empty() {
        return fallback;
    }
    capitalize_first(&hint)
}

/// `normalizeDeclaredLevels(value)`: заявка архитектора на этажи. Мусор
/// отбрасывается, диапазон зажимается до ±`MAX_LEVEL_OFFSET`, повторы
/// схлопываются, этажей не больше [`MAX_DECLARED_LEVELS`].
pub fn normalize_declared_levels(value: Option<&Value>) -> Vec<DeclaredLevel> {
    let mut result = Vec::new();
    let mut seen = Vec::new();
    let Some(Value::Array(items)) = value else { return result };
    for raw in items {
        if !raw.is_object() {
            continue;
        }
        let declared = js::number(raw.get("offset"));
        if !is_safe_integer(declared) || declared == 0.0 {
            continue;
        }
        let offset = clamp(declared as i64, -MAX_LEVEL_OFFSET, MAX_LEVEL_OFFSET);
        if seen.contains(&offset) {
            continue;
        }
        seen.push(offset);
        let hint = clean_text(raw.get("hint"), 120);
        let label = level_label_for(offset, Some(&Value::String(hint.clone())));
        result.push(DeclaredLevel { offset, hint, label });
        if result.len() >= MAX_DECLARED_LEVELS {
            break;
        }
    }
    result
}

fn refusal(code: &str, message: String, level_index: i64, level_label: &str) -> LevelGenerationResult {
    LevelGenerationResult {
        map: None,
        level_index,
        level_label: level_label.to_string(),
        arrival: None,
        transition_prop_id: String::new(),
        warnings: Vec::new(),
        errors: vec![ValidationIssue { code: code.into(), message, at: None }],
    }
}

// ---------------------------------------------------------------------------
// Точка прибытия и контур
// ---------------------------------------------------------------------------

/// `arrivalPointOf(baseMap, sourceProp)`: клетка предмета-перехода — якорь,
/// если он в следе предмета (или следа нет), иначе первая клетка следа.
fn arrival_point_of(base: &TacticalMap, source: Option<&Value>) -> Result<Option<Cell>> {
    let Some(source) = source.filter(|value| value.is_object() || value.is_array()) else {
        return Ok(None);
    };
    let footprint: &[Value] = get(Some(source), "footprint").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let anchor = (js::number(get(Some(source), "x")).floor(), js::number(get(Some(source), "y")).floor());
    let anchor_in_footprint = footprint
        .iter()
        .any(|cell| js::number(get(Some(cell), "x")) == anchor.0 && js::number(get(Some(cell), "y")) == anchor.1);
    let cell = if anchor_in_footprint || footprint.is_empty() {
        anchor
    } else {
        let first = &footprint[0];
        if first.is_null() {
            return Err(type_error("x", "null"));
        }
        (js::number(get(Some(first), "x")), js::number(get(Some(first), "y")))
    };
    if !is_safe_integer(cell.0) || !is_safe_integer(cell.1) {
        return Ok(None);
    }
    let (x, y) = (cell.0 as i64, cell.1 as i64);
    if x < 0 || y < 0 || x >= base.width || y >= base.height {
        return Ok(None);
    }
    Ok(Some((x, y)))
}

/// `interiorOutline(map, arrival)`: контур здания — клетки interior-зон (со
/// стенами); с точкой перехода — связный дом вокруг неё. Без зон вовсе (карта
/// прошла круг через старые клетки) контур восстанавливается по геометрии
/// вокруг лестницы. Порядок — порядок вставки, как у `Set` JS.
pub fn interior_outline(map: &TacticalMap, arrival: Option<Cell>) -> Outline {
    let interior_zones: Vec<&str> = map.zones.iter().filter(|zone| zone.kind == "interior").map(|zone| zone.id.as_str()).collect();
    let mut outline = Outline::new();
    if interior_zones.is_empty() {
        return match arrival {
            Some(arrival) if map.zones.is_empty() => enclosure_around(map, arrival),
            _ => outline,
        };
    }
    for y in 0..map.height {
        for x in 0..map.width {
            if tm::cell_at(map, x, y).is_some_and(|cell| interior_zones.contains(&cell.zone)) {
                outline.insert((x, y));
            }
        }
    }
    match arrival {
        Some(arrival) => building_around(map, outline, arrival),
        None => outline,
    }
}

/// Тема этажа над или под домом: дом поселения — помещение.
fn indoor_theme(theme: &str) -> &str {
    if theme == "settlement" {
        "building"
    } else {
        theme
    }
}

/// `buildingAround`: связный кусок помещений с точкой перехода плюс его кладка.
fn building_around(map: &TacticalMap, outline: Outline, arrival: Cell) -> Outline {
    if !outline.contains(&arrival) {
        return outline;
    }
    let mut component = Outline::new();
    component.insert(arrival);
    let mut queue = vec![arrival];
    let mut index = 0;
    while index < queue.len() {
        let (x, y) = queue[index];
        index += 1;
        for (dx, dy) in ORTHOGONAL {
            let next = (x + dx, y + dy);
            if !outline.contains(&next) || component.contains(&next) {
                continue;
            }
            component.insert(next);
            queue.push(next);
        }
    }
    if component.len() == outline.len() {
        return outline;
    }
    let snapshot: Vec<Cell> = component.iter().copied().collect();
    for (x, y) in snapshot {
        for dy in -1..=1 {
            for dx in -1..=1 {
                if passable_at(map, x + dx, y + dy) == Some(false) {
                    component.insert((x + dx, y + dy));
                }
            }
        }
    }
    component
}

struct Region {
    cells: Vec<Cell>,
    on_border: bool,
}

/// `enclosureAround`: здание вокруг точки по одной геометрии — помещения,
/// не касающиеся края карты, соединённые дверями, плюс кладка.
fn enclosure_around(map: &TacticalMap, arrival: Cell) -> Outline {
    let door_cells: IndexSet<Cell> = map.doors.iter().map(|door| (door.x, door.y)).collect();
    let mut region_of: HashMap<Cell, usize> = HashMap::new();
    let mut regions: Vec<Region> = Vec::new();
    let walkable = |x: i64, y: i64| passable_at(map, x, y) == Some(true) && !door_cells.contains(&(x, y));
    for y in 0..map.height {
        for x in 0..map.width {
            if region_of.contains_key(&(x, y)) || !walkable(x, y) {
                continue;
            }
            let id = regions.len();
            let mut region = Region { cells: vec![(x, y)], on_border: false };
            region_of.insert((x, y), id);
            let mut queue = vec![(x, y)];
            let mut index = 0;
            while index < queue.len() {
                let current = queue[index];
                index += 1;
                if current.0 == 0 || current.1 == 0 || current.0 == map.width - 1 || current.1 == map.height - 1 {
                    region.on_border = true;
                }
                for (dx, dy) in ORTHOGONAL {
                    let next = (current.0 + dx, current.1 + dy);
                    if region_of.contains_key(&next) || !walkable(next.0, next.1) {
                        continue;
                    }
                    // Тонкая стена на ребре делит помещения так же, как клетка-стена.
                    let between = tm::edge_between(map, current.0, current.1, next.0, next.1).ok().flatten();
                    if between.is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move) {
                        continue;
                    }
                    region_of.insert(next, id);
                    region.cells.push(next);
                    queue.push(next);
                }
            }
            regions.push(region);
        }
    }

    let Some(&start_region) = region_of.get(&arrival) else { return Outline::new() };
    if regions[start_region].on_border {
        return Outline::new();
    }
    let sides_of = |x: i64, y: i64| -> Vec<usize> { ORTHOGONAL.iter().filter_map(|(dx, dy)| region_of.get(&(x + dx, y + dy)).copied()).collect() };
    let mut taken: IndexSet<usize> = IndexSet::new();
    taken.insert(start_region);
    let mut changed = true;
    while changed {
        changed = false;
        for door in &map.doors {
            let sides = sides_of(door.x, door.y);
            if !sides.iter().any(|id| taken.contains(id)) {
                continue;
            }
            for id in sides {
                if taken.contains(&id) || regions[id].on_border {
                    continue;
                }
                taken.insert(id);
                changed = true;
            }
        }
    }

    let mut outline = Outline::new();
    for id in &taken {
        for cell in &regions[*id].cells {
            outline.insert(*cell);
        }
    }
    for door in &map.doors {
        if sides_of(door.x, door.y).iter().any(|id| taken.contains(id)) {
            outline.insert((door.x, door.y));
        }
    }
    let snapshot: Vec<Cell> = outline.iter().copied().collect();
    for (x, y) in snapshot {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            if passable_at(map, x + dx, y + dy) == Some(false) {
                outline.insert((x + dx, y + dy));
            }
        }
    }
    outline
}

fn outline_bounds(outline: &Outline) -> Option<Rect> {
    let mut iter = outline.iter();
    let &(x, y) = iter.next()?;
    let mut bounds = Rect { min_x: x, min_y: y, max_x: x, max_y: y };
    for &(x, y) in iter {
        bounds.min_x = bounds.min_x.min(x);
        bounds.min_y = bounds.min_y.min(y);
        bounds.max_x = bounds.max_x.max(x);
        bounds.max_y = bounds.max_y.max(y);
    }
    Some(bounds)
}

/// Клетка контура с соседом вне контура — внешняя стена этажа.
fn on_outline_edge(outline: &Outline, x: i64, y: i64) -> bool {
    ORTHOGONAL.iter().any(|(dx, dy)| !outline.contains(&(x + dx, y + dy)))
}

fn erode_outline(outline: &Outline) -> Outline {
    outline.iter().copied().filter(|&(x, y)| !on_outline_edge(outline, x, y)).collect()
}

// ---------------------------------------------------------------------------
// Сборка этажа
// ---------------------------------------------------------------------------

struct RoomBox {
    zone_id: &'static str,
    rect: Rect,
}

struct LevelPlan {
    partition_x: i64,
    partition_y: i64,
    rooms: Vec<RoomBox>,
}

/// `planLevelRooms`: «зал плюс два помещения» `building-generator`, перегородки
/// сдвинуты от сида.
fn plan_level_rooms(interior: Rect, random: &mut impl FnMut() -> f64, zone_ids: [&'static str; 3]) -> LevelPlan {
    let base = plan_rooms(interior);
    let partition_x = clamp(base.partition_x + (random() * 3.0).floor() as i64 - 1, interior.min_x + 2, interior.max_x - 2);
    let partition_y = clamp(base.partition_y + (random() * 3.0).floor() as i64 - 1, interior.min_y + 2, interior.max_y - 2);
    LevelPlan {
        partition_x,
        partition_y,
        rooms: vec![
            RoomBox { zone_id: zone_ids[0], rect: Rect { min_x: interior.min_x, min_y: interior.min_y, max_x: partition_x - 1, max_y: interior.max_y } },
            RoomBox { zone_id: zone_ids[1], rect: Rect { min_x: partition_x + 1, min_y: interior.min_y, max_x: interior.max_x, max_y: partition_y - 1 } },
            RoomBox { zone_id: zone_ids[2], rect: Rect { min_x: partition_x + 1, min_y: partition_y + 1, max_x: interior.max_x, max_y: interior.max_y } },
        ],
    }
}

/// `carveStairwell`: лестничный проём без полотна двери.
fn carve_stairwell(map: &mut TacticalMap, x: i64, y: i64, zone_id: &str, material: &str) -> Result<()> {
    if tm::cell_at(map, x, y).is_none() {
        return Ok(());
    }
    tm::set_cell(map, x, y, &CellPatch { passable: Some(true), material: Some(material), zone: Some(zone_id), ..CellPatch::default() })?;
    for (dx, dy) in ORTHOGONAL {
        if passable_at(map, x + dx, y + dy) != Some(true) {
            continue;
        }
        tm::set_edge(map, x, y, x + dx, y + dy, &EdgePatch { kind: Some("none"), ..EdgePatch::default() })?;
    }
    Ok(())
}

/// `transitionReachableFrom(map, arrival)`: достижим ли хоть один переход от
/// точки прибытия.
pub fn transition_reachable_from(map: &TacticalMap, arrival: Cell) -> bool {
    let reached = tm::reachable_cells(map, arrival.0, arrival.1, true, None);
    if reached.is_empty() {
        return false;
    }
    map.props.iter().any(|prop| prop.transition.is_some() && prop.footprint.iter().any(|cell| reached.contains(&(cell.x, cell.y))))
}

/// `placePairedTransition`: парный переход обратно — одна клетка в точке прибытия.
fn place_paired_transition(map: &mut TacticalMap, arrival: Cell, asset_id: &str, to_level: i64, label: &str) -> Result<String> {
    let id = format!("level-transition-{to_level}");
    tm::add_prop(
        map,
        &json!({
            "id": id,
            "assetId": asset_id,
            "x": js::num(arrival.0 as f64 + 0.5),
            "y": js::num(arrival.1 as f64 + 0.5),
            "rotation": 0,
            "scale": 1,
            "footprint": [{ "x": arrival.0, "y": arrival.1 }],
            "zOrder": 0,
            "blocksMove": false,
            "blocksSight": false,
            "cover": "none",
            "interactive": true,
            "transition": { "toLevel": to_level, "label": label },
        }),
    )?;
    Ok(id)
}

fn level_invariant_errors(map: &TacticalMap, arrival: Cell) -> Vec<ValidationIssue> {
    let mut errors = tm::validate_tactical_map(map).errors;
    if !map.props.iter().any(|prop| prop.transition.is_some()) {
        errors.push(ValidationIssue { code: "LEVEL_TRANSITION_MISSING".into(), message: "На этаже нет ни одного перехода".into(), at: None });
    } else if !transition_reachable_from(map, arrival) {
        errors.push(ValidationIssue { code: "LEVEL_TRANSITION_UNREACHABLE".into(), message: "Переход недостижим от точки прибытия".into(), at: None });
    }
    errors
}

struct Shared<'a> {
    base: &'a TacticalMap,
    location_id: &'a str,
    index: i64,
    from_level: i64,
    seed: String,
    label: String,
    arrival: Cell,
    source_prop: Option<&'a Value>,
}

impl Shared<'_> {
    fn refuse(&self, code: &str, message: String) -> LevelGenerationResult {
        refusal(code, message, self.index, &self.label)
    }

    fn success(&self, map: TacticalMap, transition_prop_id: String, warnings: Vec<String>) -> LevelGenerationResult {
        LevelGenerationResult {
            map: Some(map),
            level_index: self.index,
            level_label: self.label.clone(),
            arrival: Some(self.arrival),
            transition_prop_id,
            warnings,
            errors: Vec::new(),
        }
    }

    fn variant_at(&self, x: i64, y: i64) -> i64 {
        i64::from(tm::floor_variant_at(&format!("{}:L{}", self.seed, self.index), x, y, FLOOR_VARIANTS))
    }

    fn new_level_map(&self) -> Result<TacticalMap> {
        let base = self.base;
        Ok(tm::create_tactical_map(&TacticalMapOptions {
            width: base.width,
            height: base.height,
            location_id: self.location_id,
            level_index: self.index,
            level_label: &self.label,
            seed: &self.seed,
            generator: Some((LEVEL_GENERATOR_ID, LEVEL_GENERATOR_VERSION)),
            theme: indoor_theme(&base.theme),
            tileset_id: if base.theme == "settlement" { "building" } else { &base.tileset_id },
            size_class: &base.size_class,
            ..TacticalMapOptions::default()
        })?)
    }

    /// `String(sourceProp?.assetId ?? '') === 'trapdoor'`.
    fn came_by_trapdoor(&self) -> bool {
        js::s(get(self.source_prop, "assetId")) == "trapdoor"
    }
}

fn zone_json(id: &str, material: &str, light: &str, direction: &str, label: &str) -> Value {
    json!({ "id": id, "kind": "interior", "material": material, "lightLevel": light, "floorDirection": direction, "label": label })
}

fn upper_zone_plan(zone_id: &str, partitioned: bool) -> Value {
    let mut plan = json!({ "zoneId": zone_id, "theme": "interior", "density": 18 });
    let extra = if zone_id == "study" {
        json!({ "purpose": "study", "require": ["chair"], "prefer": ["bookshelf", "chest", "candle", "rug"] })
    } else if zone_id == "landing" && partitioned {
        json!({
            "density": 10,
            "require": ["chest"],
            "prefer": ["chest", "rug", "candle", "table_small", "chair", "coat_rack"],
            "extraThemes": ["bedroom"],
            "caps": { "bed": 0, "wardrobe": 1, "coat_rack": 1 },
        })
    } else {
        json!({
            "purpose": "bedroom",
            "require": ["bed", "wardrobe", "night_table", "chest"],
            "prefer": ["bed", "night_table", "washbasin", "wardrobe", "cupboard", "chest", "table_small", "chair", "candle", "rug"],
        })
    };
    js::assign(&mut plan, extra);
    plan
}

/// Верхний этаж: контур наследуется, комнаты нарезаются заново; без
/// перегородок — запасная ступень.
fn build_upper_level(shared: &Shared<'_>) -> Result<LevelGenerationResult> {
    let arrival = shared.arrival;
    let outline = interior_outline(shared.base, Some(arrival));
    if outline.is_empty() {
        return Ok(shared.refuse("LEVEL_OUTLINE_MISSING", "На этаже ниже нет interior-зон: наследовать контур здания не от чего".into()));
    }
    if !outline.contains(&arrival) {
        return Ok(shared.refuse("LEVEL_ARRIVAL_OUTSIDE_OUTLINE", format!("Точка прибытия {},{} лежит вне контура здания", arrival.0, arrival.1)));
    }
    let bounds = outline_bounds(&outline).unwrap_or(Rect { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    let interior = Rect { min_x: bounds.min_x + 1, min_y: bounds.min_y + 1, max_x: bounds.max_x - 1, max_y: bounds.max_y - 1 };
    if interior.max_x - interior.min_x < 4 || interior.max_y - interior.min_y < 4 {
        return Ok(shared.refuse("LEVEL_OUTLINE_TOO_SMALL", "Контур здания слишком мал для второго этажа".into()));
    }

    for partitioned in [true, false] {
        let mut map = paint_upper_level(shared, &outline, interior, partitioned)?;
        thin_walls(&mut map, &ThinWallsOptions::default())?;
        apply_room_floors(&mut map, &RoomFloorsOptions::default())?;
        let transition_prop_id = place_paired_transition(&mut map, arrival, "stairs_down", shared.from_level, &level_label_for(shared.from_level, None))?;
        let plans: Vec<Value> = map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| upper_zone_plan(&zone.id, partitioned)).collect();
        let max_props = max_props_of(&map)?;
        place_props(&mut map, &format!("{}:props", shared.seed), &zone_plans(&plans), max_props)?;
        if level_invariant_errors(&map, arrival).is_empty() {
            let warnings = if partitioned { Vec::new() } else { vec!["LEVEL_PARTITIONS_DROPPED: перегородки отрезали лестницу".to_string()] };
            return Ok(shared.success(map, transition_prop_id, warnings));
        }
    }
    Ok(shared.refuse("LEVEL_GEOMETRY_LOST_TOPOLOGY", "Верхний этаж не собрался связным ни с перегородками, ни без них".into()))
}

fn paint_upper_level(shared: &Shared<'_>, outline: &Outline, interior: Rect, partitioned: bool) -> Result<TacticalMap> {
    let mut random = random_for(&format!("{LEVEL_GENERATOR_ID}:{LEVEL_GENERATOR_VERSION}:{}:up", shared.seed));
    let arrival = shared.arrival;
    let mut map = shared.new_level_map()?;
    tm::add_zone(&mut map, &zone_json("walls", "stone", "dark", "horizontal", ""))?;
    tm::add_zone(&mut map, &zone_json("landing", "wood", "dim", "horizontal", "Площадка"))?;
    if partitioned {
        tm::add_zone(&mut map, &zone_json("bedroom", "wood", "dim", "vertical", "Спальня"))?;
        tm::add_zone(&mut map, &zone_json("study", "wood", "dark", "vertical", "Кабинет"))?;
    }
    let plan = if partitioned {
        plan_level_rooms(interior, &mut random, ["landing", "bedroom", "study"])
    } else {
        LevelPlan { partition_x: -1, partition_y: -1, rooms: vec![RoomBox { zone_id: "landing", rect: interior }] }
    };
    let room_at = |x: i64, y: i64| plan.rooms.iter().find(|room| x >= room.rect.min_x && x <= room.rect.max_x && y >= room.rect.min_y && y <= room.rect.max_y);
    let cells = sorted_cells(outline);
    for &(x, y) in &cells {
        let perimeter = on_outline_edge(outline, x, y);
        let partition = partitioned && (x == plan.partition_x || (x > plan.partition_x && y == plan.partition_y));
        let room = room_at(x, y);
        let variant = shared.variant_at(x, y);
        match room {
            Some(room) if !perimeter && !partition => {
                let material = map.zones.iter().find(|zone| zone.id == room.zone_id).map_or_else(|| "wood".to_string(), |zone| zone.material.clone());
                tm::set_cell(&mut map, x, y, &CellPatch { passable: Some(true), material: Some(&material), zone: Some(room.zone_id), variant: Some(variant), ..CellPatch::default() })?;
            }
            _ => {
                tm::set_cell(&mut map, x, y, &CellPatch { passable: Some(false), material: Some("stone"), zone: Some("walls"), variant: Some(variant), ..CellPatch::default() })?;
            }
        }
    }
    for &(x, y) in &cells {
        if passable_at(&map, x, y) == Some(false) {
            edges_around(&mut map, x, y, "wall", &EdgesAroundOptions::default())?;
        }
    }
    if partitioned {
        open_doorway(&mut map, plan.partition_x, round_half((interior.min_y + plan.partition_y) as f64 / 2.0), "upper-north-door")?;
        open_doorway(&mut map, plan.partition_x, round_half((plan.partition_y + interior.max_y) as f64 / 2.0), "upper-south-door")?;
    }
    if passable_at(&map, arrival.0, arrival.1) == Some(false) {
        carve_stairwell(&mut map, arrival.0, arrival.1, "landing", "wood")?;
    }

    // Окна по внешним стенам: середина каждой стороны плюс четверти длинных сторон.
    let bounds = outline_bounds(outline).unwrap_or(Rect { min_x: 0, min_y: 0, max_x: 0, max_y: 0 });
    let mid_x = round_half((bounds.min_x + bounds.max_x) as f64 / 2.0);
    let mid_y = round_half((bounds.min_y + bounds.max_y) as f64 / 2.0);
    let span_x = (bounds.max_x - bounds.min_x) as f64;
    for (x, y) in [
        (round_half(bounds.min_x as f64 + span_x * 0.3), bounds.min_y),
        (round_half(bounds.min_x as f64 + span_x * 0.7), bounds.min_y),
        (mid_x, bounds.max_y),
        (bounds.min_x, mid_y),
        (bounds.max_x, mid_y),
    ] {
        if outline.contains(&(x, y)) {
            open_window(&mut map, x, y)?;
        }
    }

    tm::add_spawn_point(&mut map, &json!({ "id": "level-arrival", "x": arrival.0, "y": arrival.1, "role": "party" }))?;
    let room_labels = map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| RoomLabel { zone_id: zone.id.clone(), label: zone.label.clone() }).collect();
    map.overlays = Overlays { compass: true, scale_bar: true, room_labels };
    Ok(map)
}

/// Подвал: контур не больше контура этажа выше, кладка и земля, от одного до
/// трёх помещений.
fn build_cellar_level(shared: &Shared<'_>) -> Result<LevelGenerationResult> {
    let mut random = random_for(&format!("{LEVEL_GENERATOR_ID}:{LEVEL_GENERATOR_VERSION}:{}:down", shared.seed));
    let arrival = shared.arrival;
    let interior_cells = interior_outline(shared.base, Some(arrival));
    let outline = if interior_cells.is_empty() { rectangle_around(shared.base, arrival) } else { cellar_outline(&interior_cells, arrival) };
    if !outline.contains(&arrival) {
        return Ok(shared.refuse("LEVEL_ARRIVAL_OUTSIDE_OUTLINE", format!("Точка спуска {},{} лежит вне контура подвала", arrival.0, arrival.1)));
    }
    let bounds = match outline_bounds(&outline) {
        Some(bounds) if bounds.max_x - bounds.min_x >= 4 && bounds.max_y - bounds.min_y >= 4 => bounds,
        _ => return Ok(shared.refuse("LEVEL_OUTLINE_TOO_SMALL", "Контур этажа выше слишком мал для подвала".into())),
    };

    let mut map = shared.new_level_map()?;
    tm::add_zone(&mut map, &zone_json("walls", "stone", "dark", "horizontal", ""))?;
    tm::add_zone(&mut map, &zone_json("cellar", "stone", "dark", "horizontal", &shared.label))?;

    let room_count = 1 + (random() * 3.0).floor() as i64;
    let inner = Rect { min_x: bounds.min_x + 1, min_y: bounds.min_y + 1, max_x: bounds.max_x - 1, max_y: bounds.max_y - 1 };
    let partitions: Vec<i64> = (1..room_count)
        .map(|room| {
            let share = room as f64 / room_count as f64;
            clamp(round_half(inner.min_x as f64 + (inner.max_x - inner.min_x) as f64 * share), inner.min_x + 2, inner.max_x - 2)
        })
        .collect();

    let cells = sorted_cells(&outline);
    for &(x, y) in &cells {
        let variant = shared.variant_at(x, y);
        if on_outline_edge(&outline, x, y) || partitions.contains(&x) {
            tm::set_cell(&mut map, x, y, &CellPatch { passable: Some(false), material: Some("stone"), zone: Some("walls"), variant: Some(variant), ..CellPatch::default() })?;
            continue;
        }
        // Пол погреба — утоптанная земля между каменной кладкой.
        let material = if (x + y) % 3 == 0 { "stone" } else { "earth" };
        tm::set_cell(&mut map, x, y, &CellPatch { passable: Some(true), material: Some(material), zone: Some("cellar"), variant: Some(variant), ..CellPatch::default() })?;
    }
    for &(x, y) in &cells {
        if passable_at(&map, x, y) == Some(false) {
            edges_around(&mut map, x, y, "wall", &EdgesAroundOptions::default())?;
        }
    }
    for (position, partition) in partitions.iter().enumerate() {
        open_doorway(&mut map, *partition, round_half((inner.min_y + inner.max_y) as f64 / 2.0), &format!("cellar-door-{}", position + 1))?;
    }
    if passable_at(&map, arrival.0, arrival.1) == Some(false) {
        carve_stairwell(&mut map, arrival.0, arrival.1, "cellar", "earth")?;
    }

    tm::add_spawn_point(&mut map, &json!({ "id": "level-arrival", "x": arrival.0, "y": arrival.1, "role": "party" }))?;
    map.overlays = Overlays { compass: true, scale_bar: true, room_labels: vec![RoomLabel { zone_id: "cellar".into(), label: shared.label.clone() }] };

    // Спустились по люку — по нему же и поднимаемся.
    let asset = if shared.came_by_trapdoor() { "trapdoor" } else { "stairs_up" };
    let transition_prop_id = place_paired_transition(&mut map, arrival, asset, shared.from_level, &level_label_for(shared.from_level, None))?;
    let plans = [json!({
        "zoneId": "cellar",
        "theme": "interior",
        "density": 20,
        "require": ["barrel_stack", "crate_stack", "shelf_wall", "sack"],
        "prefer": ["barrel", "barrel_stack", "crate", "crate_stack", "sack", "shelf_wall", "chest", "bottle", "pot"],
    })];
    let max_props = max_props_of(&map)?;
    place_props(&mut map, &format!("{}:props", shared.seed), &zone_plans(&plans), max_props)?;

    let errors = level_invariant_errors(&map, arrival);
    if !errors.is_empty() {
        return Ok(LevelGenerationResult {
            map: None,
            level_index: shared.index,
            level_label: shared.label.clone(),
            arrival: None,
            transition_prop_id: String::new(),
            warnings: Vec::new(),
            errors,
        });
    }
    Ok(shared.success(map, transition_prop_id, Vec::new()))
}

/// Контур подвала: сжатый контур здания; клетка спуска возвращается в контур.
fn cellar_outline(interior_cells: &Outline, arrival: Cell) -> Outline {
    let mut eroded = erode_outline(interior_cells);
    if eroded.contains(&arrival) {
        return eroded;
    }
    for (dx, dy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
        let cell = (arrival.0 + dx, arrival.1 + dy);
        if interior_cells.contains(&cell) {
            eroded.insert(cell);
        }
    }
    eroded
}

/// Подвал под локацией без interior-зон: прямоугольник вокруг точки спуска.
fn rectangle_around(base: &TacticalMap, arrival: Cell) -> Outline {
    let half_width = 3.max(7.min(base.width.div_euclid(3)));
    let half_height = 3.max(6.min(base.height.div_euclid(3)));
    let max_x_limit = 0.max(base.width - 1);
    let max_y_limit = 0.max(base.height - 1);
    let min_x = clamp(arrival.0 - half_width, 0, max_x_limit);
    let max_x = clamp(arrival.0 + half_width, 0, max_x_limit);
    let min_y = clamp(arrival.1 - half_height, 0, max_y_limit);
    let max_y = clamp(arrival.1 + half_height, 0, max_y_limit);
    let mut outline = Outline::new();
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            outline.insert((x, y));
        }
    }
    outline
}

/// Пещерный ярус: прибытие обязано лечь в основную полость; нарушение
/// чинится соседним сидом, а не правкой геометрии.
fn build_cave_level(shared: &Shared<'_>) -> Result<LevelGenerationResult> {
    let Some(definition) = SCENE_THEMES.iter().find(|candidate| candidate.id == "cave") else {
        return Ok(shared.refuse("LEVEL_THEME_MISSING", "Тема пещеры не объявлена в каталоге".into()));
    };
    let arrival = shared.arrival;
    let going_up = shared.index > shared.from_level;
    for attempt in 0..CAVE_SEED_ATTEMPTS {
        let attempt_seed = if attempt == 0 { shared.seed.clone() } else { format!("{}#{attempt}", shared.seed) };
        let mut map = layout_organic_cave(
            definition.json(),
            &LayoutOptions { seed: &attempt_seed, width: shared.base.width as f64, height: shared.base.height as f64, location_id: shared.location_id },
        )?;
        // Этаж проставляется до расстановки перехода: `addProp` сверяет `toLevel` с ним.
        map.level_index = shared.index;
        map.level_label = shared.label.clone();
        if passable_at(&map, arrival.0, arrival.1) != Some(true) {
            continue;
        }
        let reached = tm::reachable_cells(&map, arrival.0, arrival.1, true, None);
        let walkable = tm::cells(&map).filter(|cell| cell.passable).count();
        if walkable == 0 || (reached.len() as f64) < walkable as f64 * CAVE_MAIN_CHAMBER_SHARE {
            continue;
        }

        tm::add_spawn_point(&mut map, &json!({ "id": "level-arrival", "x": arrival.0, "y": arrival.1, "role": "party" }))?;
        let asset = if going_up {
            "stairs_down"
        } else if shared.came_by_trapdoor() {
            "trapdoor"
        } else {
            "stairs_up"
        };
        let transition_prop_id = place_paired_transition(&mut map, arrival, asset, shared.from_level, &level_label_for(shared.from_level, None))?;
        let density = match definition.get("density") {
            None | Some(Value::Null) => json!(12),
            Some(value) => value.clone(),
        };
        let plans: Vec<Value> = map
            .zones
            .iter()
            .map(|zone| {
                let mut plan = Map::new();
                plan.insert("zoneId".into(), Value::String(zone.id.clone()));
                plan.insert("theme".into(), Value::String(definition.id.to_string()));
                plan.insert("density".into(), density.clone());
                for key in ["require", "prefer"] {
                    if let Some(value) = definition.get(key) {
                        plan.insert(key.into(), value.clone());
                    }
                }
                Value::Object(plan)
            })
            .collect();
        let max_props = max_props_of(&map)?;
        place_props(&mut map, &format!("{attempt_seed}:props"), &zone_plans(&plans), max_props)?;
        if level_invariant_errors(&map, arrival).is_empty() {
            let warnings = if attempt > 0 { vec![format!("LEVEL_SEED_RETRIED: {attempt}")] } else { Vec::new() };
            return Ok(shared.success(map, transition_prop_id, warnings));
        }
    }
    Ok(shared.refuse(
        "LEVEL_ARRIVAL_UNREACHABLE",
        format!("Точка прибытия {},{} не попала в основную полость за {CAVE_SEED_ATTEMPTS} сидов", arrival.0, arrival.1),
    ))
}

fn is_cave_theme(theme: &str) -> bool {
    text::test(sk_core::re!(r"^cave$|пещер|грот|каверн|штольн", "iu"), theme)
}

/// `generateLevelMap(options)`: карта этажа локации либо отказ с кодом.
pub fn generate_level_map(options: &LevelOptions<'_>) -> Result<LevelGenerationResult> {
    let number = js::number(options.level);
    let safe = is_safe_integer(number);
    let label = level_label_for(if safe { number } else { 0.0 }, options.hint);
    let index = if safe { number as i64 } else { 0 };
    if !safe || index == 0 || index.abs() > MAX_LEVEL_OFFSET {
        return Ok(refusal(
            "LEVEL_INDEX_NOT_ALLOWED",
            format!("Этаж {} не строится: нужен ненулевой целый номер в пределах ±{MAX_LEVEL_OFFSET}", js::string(options.level)),
            index,
            &label,
        ));
    }
    let Some(base) = options.base_map else {
        return Ok(refusal("LEVEL_BASE_MAP_MISSING", "Не передана карта этажа, откуда идёт переход".into(), index, &label));
    };
    let from_level = base.level_index;
    if from_level == index {
        return Ok(refusal("LEVEL_INDEX_SAME_AS_BASE", format!("Этаж {index} совпадает с этажом исходной карты"), index, &label));
    }
    let Some(arrival) = arrival_point_of(base, options.source_prop)? else {
        return Ok(refusal("LEVEL_SOURCE_PROP_MISSING", "У перехода на исходном этаже нет координат внутри карты".into(), index, &label));
    };
    let seed = match options.seed {
        None => "level".to_string(),
        Some(seed) => js::string(Some(seed)),
    };
    let shared = Shared { base, location_id: options.location_id, index, from_level, seed, label, arrival, source_prop: options.source_prop };
    if is_cave_theme(&js::s(options.theme)) || is_cave_theme(&base.theme) {
        return build_cave_level(&shared);
    }
    if index > from_level {
        build_upper_level(&shared)
    } else {
        build_cellar_level(&shared)
    }
}
