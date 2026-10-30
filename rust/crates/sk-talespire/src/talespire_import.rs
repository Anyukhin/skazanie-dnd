//! Перенос `server/talespire-import.mjs`: импорт карты из TaleSpire — слэб →
//! этажи тактической карты «Сказания».
//!
//! Смысл тайлов («пол», «стена», «дверь») даёт таблица
//! `data/talespire-assets-v1.json`, остальное — геометрия: экземпляр → коробка
//! в мировых координатах, пол — верхние грани плит, этажи — по высоте пола с
//! шагом 2,5, тонкая стена — ребро между клетками, предмет — вид каталога
//! «Сказания», лестница между соседними этажами — пара `stairs_up` /
//! `stairs_down`. Модуль чистый и детерминированный: одинаковый слэб даёт
//! байт-в-байт одинаковые карты.
//!
//! Порядок обхода повторяет JS: `Map` и `Set` — `IndexMap` / `IndexSet`
//! (порядок вставки), сортировки устойчивы, ключи клеток `"x,y"` сравниваются
//! `localeCompare` (`sk_core::text::locale_compare`).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{hash, js, text, v8math, Point};
use sk_map_core::map_quality::count_platforms;
use sk_rules::tactical_geometry::{cells_visible_from, DOORWAY_SIGHT_CELLS};
use sk_scene_base::asset_registry::asset_by_id;
use sk_scene_base::scene_requirements::anchor_counts_for;
use sk_scene_base::talespire_slab::{decode_slab, DecodedSlab, SlabInstance, TaleSpireSlabError};
use sk_tactical::tactical_map::{
    add_prop, add_spawn_point, add_zone, canonical_edge, cell_at, create_tactical_map, edge_between, movement_step_blocked, reachable_cells,
    serialize_tactical_map, set_cell, set_door, set_edge, size_class, size_class_for, validate_tactical_map, CellPatch, EdgeKind, EdgePatch,
    Overlays, RoomLabel, SizeClass, TacticalMap, TacticalMapError, TacticalMapOptions, MAX_LEVEL_OFFSET, SIZE_CLASSES,
};
use sk_world_time::level_generator::level_label_for;

pub const TALESPIRE_IMPORT_VERSION: &str = "1";
/// Путь таблицы ассетов от корня репозитория. В JS — абсолютный путь файла;
/// здесь таблица встроена в крейт, путь — для сообщений и инструментов.
pub const TALESPIRE_ASSET_TABLE_FILE: &str = "data/talespire-assets-v1.json";

/// Высота этажа в единицах TaleSpire (1 единица = 5 футов = 1 клетка).
const STOREY_HEIGHT: f64 = 2.5;
/// Доля высоты этажа, на которую пол может подняться и остаться на своём этаже.
const STOREY_TOLERANCE: f64 = 1.0;
/// Высота «тела» над полом: всё, что пересекает эту полосу, мешает пройти.
const BODY_LOW: f64 = 0.3;
const BODY_HIGH: f64 = 1.8;
/// Меньше этого этаж считается обрезком и не импортируется.
const MIN_LEVEL_CELLS: usize = 6;
const MIN_MAP_SIDE: i64 = 16;
const EPSILON: f64 = 0.02;

/// Бюджет площади исходных коробок: сумма клеток, которые обойдут
/// `coveredCells` и раскладка поверхностей (аудит PR #131, MAP-BOUNDARY-01/02).
pub const TALESPIRE_MAX_SOURCE_CELLS: f64 = 400_000.0;

/// Отказ импорта: `TaleSpireImportError`, а также пробросы разбора слэба
/// (`TaleSpireSlabError`) и тактической карты (`TacticalMapError`) — с тем же
/// именем, кодом и текстом, что у исключения JS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaleSpireImportError {
    pub name: String,
    pub code: String,
    pub message: String,
}

impl TaleSpireImportError {
    pub const NAME: &'static str = "TaleSpireImportError";

    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { name: Self::NAME.into(), code: code.into(), message: message.into() }
    }
}

impl fmt::Display for TaleSpireImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaleSpireImportError {}

impl From<TacticalMapError> for TaleSpireImportError {
    fn from(error: TacticalMapError) -> Self {
        Self { name: error.name.into(), code: error.code, message: error.message }
    }
}

impl From<TaleSpireSlabError> for TaleSpireImportError {
    fn from(error: TaleSpireSlabError) -> Self {
        Self { name: "TaleSpireSlabError".into(), code: error.code, message: error.message }
    }
}

type Result<T> = std::result::Result<T, TaleSpireImportError>;

// ---------------------------------------------------------------------------
// Таблица ассетов

/// Строка таблицы: `[вид, роль, cx, cy, cz, ex, ey, ez, материал, вид каталога, жанр?]`.
#[derive(Clone, Debug, PartialEq)]
pub struct AssetRow {
    /// `t` — тайл, `p` — предмет.
    pub kind: String,
    pub role: String,
    pub ex: f64,
    pub ey: f64,
    pub ez: f64,
    pub material: String,
    pub prop_asset: String,
    /// `f` (фэнтези) или `s` (фантастика и современность); по умолчанию `f`.
    pub genre: String,
}

impl AssetRow {
    fn from_json(row: &Value) -> Option<Self> {
        let items = row.as_array()?;
        let string = |index: usize| js::s(items.get(index));
        let number = |index: usize| js::number(items.get(index));
        Some(Self {
            kind: string(0),
            role: string(1),
            ex: number(5),
            ey: number(6),
            ez: number(7),
            material: string(8),
            prop_asset: string(9),
            genre: items.get(10).map_or_else(|| "f".to_string(), |genre| js::s(Some(genre))),
        })
    }
}

/// Таблица ассетов: GUID → строка.
pub type AssetTable = HashMap<String, AssetRow>;

static ASSET_TABLE: LazyLock<std::result::Result<AssetTable, TaleSpireImportError>> = LazyLock::new(|| {
    let invalid = || TaleSpireImportError::new("Таблица ассетов TaleSpire повреждена", "TALESPIRE_TABLE_INVALID");
    let parsed: Value = serde_json::from_str(ASSET_TABLE_SOURCE).map_err(|_| invalid())?;
    if parsed.get("schema_version").and_then(Value::as_f64) != Some(1.0) {
        return Err(invalid());
    }
    let assets = parsed.get("assets").and_then(Value::as_object).ok_or_else(invalid)?;
    Ok(assets.iter().filter_map(|(id, row)| AssetRow::from_json(row).map(|row| (id.clone(), row))).collect())
});

/// `taleSpireAssetTable()`: таблица разбирается один раз на процесс.
pub fn talespire_asset_table() -> Result<&'static AssetTable> {
    ASSET_TABLE.as_ref().map_err(Clone::clone)
}

const ASSET_TABLE_SOURCE: &str = include_str!("../../../../data/talespire-assets-v1.json");

/// Строгая проверка таблицы ассетов из текста (урок 7). Разбор таблицы
/// терпим к строке не той формы — она молча выпадает, и импорт слэба теряет
/// тайл или предмет. Здесь такая строка — отказ с GUID: `[вид t|p, роль, cx,
/// cy, cz, ex, ey, ez — числа, материал, вид каталога, жанр f|s?]`.
pub fn check_talespire_asset_text(text: &str) -> std::result::Result<(), sk_core::content::ContentError> {
    use sk_core::content::{self, ContentError};
    let file = TALESPIRE_ASSET_TABLE_FILE;
    let raw = content::parse_json(file, text)?;
    content::schema_version(file, &raw, "schema_version", 1.0)?;
    for (id, row) in content::object_field(file, &raw, "assets")? {
        let fail = |message: &str| Err(ContentError::at(file, id.as_str(), message));
        let Some(items) = row.as_array().filter(|items| items.len() >= 10) else {
            return fail("строка должна быть массивом из 10–11 полей");
        };
        if !matches!(items[0].as_str(), Some("t" | "p")) {
            return fail("вид должен быть «t» или «p»");
        }
        if !items[2..8].iter().all(|value| value.as_f64().is_some_and(f64::is_finite)) {
            return fail("cx, cy, cz, ex, ey, ez должны быть числами");
        }
        if !items[1].is_string() || !items[8].is_string() || !items[9].is_string() {
            return fail("роль, материал и вид каталога должны быть строками");
        }
        if items.get(10).is_some_and(|genre| !matches!(genre.as_str(), Some("f" | "s"))) {
            return fail("жанр должен быть «f» или «s»");
        }
    }
    Ok(())
}

/// Проверка встроенной таблицы (сервер зовёт её до приёма запросов).
pub fn check_talespire_asset_table() -> std::result::Result<(), sk_core::content::ContentError> {
    talespire_asset_table().map_err(|error| sk_core::content::ContentError::new(TALESPIRE_ASSET_TABLE_FILE, error.message))?;
    check_talespire_asset_text(ASSET_TABLE_SOURCE)
}

// ---------------------------------------------------------------------------
// Коробки и поверхности

/// Экземпляр в мировых координатах (`WorldBox`).
#[derive(Clone, Debug, PartialEq)]
pub struct WorldBox {
    pub kind: String,
    pub role: String,
    pub material: String,
    pub prop_asset: String,
    pub genre: String,
    pub rotation: f64,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub min_z: f64,
    pub max_z: f64,
}

impl WorldBox {
    /// Форма JS (тот же порядок ключей).
    pub fn to_json(&self) -> Value {
        json!({
            "kind": self.kind, "role": self.role, "material": self.material, "propAsset": self.prop_asset, "genre": self.genre,
            "rotation": js::num(self.rotation),
            "minX": js::num(self.min_x), "maxX": js::num(self.max_x),
            "minY": js::num(self.min_y), "maxY": js::num(self.max_y),
            "minZ": js::num(self.min_z), "maxZ": js::num(self.max_z),
        })
    }
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    0f64.max(a1.min(b1) - a0.max(b0))
}

fn round2(value: f64) -> f64 {
    js::round(value * 100.0) / 100.0
}

type Cell = (i64, i64);

fn cell_key((x, z): Cell) -> String {
    format!("{x},{z}")
}

/// `worldBoxesForSlab(slab, table)`: коробки в мировых координатах и число
/// незнакомых ассетов.
pub fn world_boxes_for_slab(slab: &DecodedSlab, table: &AssetTable) -> (Vec<WorldBox>, usize) {
    let mut boxes = Vec::new();
    let mut unknown = 0;
    for instance in &slab.instances {
        let Some(row) = table.get(instance.asset_id()) else {
            unknown += 1;
            continue;
        };
        let base = |rotation: f64, min_x, max_x, min_y, max_y, min_z, max_z| WorldBox {
            kind: row.kind.clone(),
            role: row.role.clone(),
            material: row.material.clone(),
            prop_asset: row.prop_asset.clone(),
            genre: row.genre.clone(),
            rotation,
            min_x,
            max_x,
            min_y,
            max_y,
            min_z,
            max_z,
        };
        let world = match instance {
            SlabInstance::V1 { center, extent, rotation, .. } => base(
                *rotation,
                center.x - extent.x,
                center.x + extent.x,
                center.y - extent.y,
                center.y + extent.y,
                center.z - extent.z,
                center.z + extent.z,
            ),
            SlabInstance::V2 { x, y, z, rotation, .. } => {
                let angle = (rotation * std::f64::consts::PI) / 180.0;
                let cos = v8math::cos(angle).abs();
                let sin = v8math::sin(angle).abs();
                let half_x = cos * row.ex + sin * row.ez;
                let half_z = sin * row.ex + cos * row.ez;
                base(*rotation, *x, x + 2.0 * half_x, *y, y + 2.0 * row.ey, *z, z + 2.0 * half_z)
            }
        };
        boxes.push(world);
    }
    (boxes, unknown)
}

/// Клетки, которые коробка закрывает не меньше чем на `share` площади.
fn covered_cells(world: &WorldBox, share: f64) -> Vec<Cell> {
    let mut cells = Vec::new();
    let (x_from, x_to) = ((world.min_x + EPSILON).floor(), (world.max_x - EPSILON).ceil());
    let (z_from, z_to) = ((world.min_z + EPSILON).floor(), (world.max_z - EPSILON).ceil());
    let mut x = x_from;
    while x < x_to {
        let mut z = z_from;
        while z < z_to {
            if overlap(world.min_x, world.max_x, x, x + 1.0) * overlap(world.min_z, world.max_z, z, z + 1.0) >= share {
                cells.push((x as i64, z as i64));
            }
            z += 1.0;
        }
        x += 1.0;
    }
    cells
}

/// Поверхность, по которой можно ходить (`Surface`).
#[derive(Clone, Debug, PartialEq)]
struct Surface {
    x: i64,
    z: i64,
    top: f64,
    bottom: f64,
    role: String,
    material: String,
}

fn includes(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

/// Все поверхности, по которым можно ходить; подложки отбрасываются.
fn walkable_surfaces(boxes: &[WorldBox]) -> IndexMap<Cell, Vec<Surface>> {
    let mut by_cell: IndexMap<Cell, Vec<Surface>> = IndexMap::new();
    for world in boxes {
        if world.kind != "t" || !includes(&["floor", "stairs", "wallfloor"], &world.role) {
            continue;
        }
        let top = if world.role == "wallfloor" { (world.min_y + 0.5).min(world.max_y) } else { world.max_y };
        for cell in covered_cells(world, 0.45) {
            by_cell.entry(cell).or_default().push(Surface {
                x: cell.0,
                z: cell.1,
                top: round2(top),
                bottom: round2(world.min_y),
                role: world.role.clone(),
                material: world.material.clone(),
            });
        }
    }
    for list in by_cell.values_mut() {
        if list.len() < 2 {
            continue;
        }
        let mut order: Vec<usize> = (0..list.len()).collect();
        order.sort_by(|left, right| list[*right].top.partial_cmp(&list[*left].top).unwrap_or(std::cmp::Ordering::Equal));
        let mut under: HashSet<usize> = HashSet::new();
        let mut lowest_above = f64::INFINITY;
        let mut above = 0;
        for &index in &order {
            let surface = &list[index];
            while above < order.len() && list[order[above]].top > surface.top + EPSILON {
                lowest_above = lowest_above.min(list[order[above]].bottom);
                above += 1;
            }
            if lowest_above < surface.top + 1.2 {
                under.insert(index);
            }
        }
        if !under.is_empty() {
            let kept: Vec<Surface> = list.iter().enumerate().filter(|(index, _)| !under.contains(index)).map(|(_, surface)| surface.clone()).collect();
            *list = kept;
        }
    }
    by_cell
}

/// Охват клеток списка: `(minX, maxX, minZ, maxZ)`.
fn cell_bounds<'a>(cells: impl IntoIterator<Item = &'a Surface>) -> (i64, i64, i64, i64) {
    let (mut min_x, mut max_x, mut min_z, mut max_z) = (i64::MAX, i64::MIN, i64::MAX, i64::MIN);
    for cell in cells {
        min_x = min_x.min(cell.x);
        max_x = max_x.max(cell.x);
        min_z = min_z.min(cell.z);
        max_z = max_z.max(cell.z);
    }
    (min_x, max_x, min_z, max_z)
}

/// Сколько клеток обойдут коробки слэба.
fn source_cells(boxes: &[WorldBox]) -> f64 {
    boxes.iter().fold(0.0, |cells, world| {
        let side_x = (world.max_x - EPSILON).ceil() - (world.min_x + EPSILON).floor();
        let side_z = (world.max_z - EPSILON).ceil() - (world.min_z + EPSILON).floor();
        cells + side_x.max(0.0) * side_z.max(0.0)
    })
}

/// Сравнение двух чисел по возрастанию (`left - right`).
fn ascending(left: f64, right: f64) -> std::cmp::Ordering {
    left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
}

/// Счётчик с порядком вставки ключей-чисел (`Map<number, number>`); ключ —
/// биты f64 (у высот нет `-0` и `NaN`, кроме мусора, который JS тоже различает так же).
fn count_by_height(tops: impl IntoIterator<Item = f64>) -> Vec<(f64, usize)> {
    let mut counts: IndexMap<u64, (f64, usize)> = IndexMap::new();
    for top in tops {
        let key = if top == 0.0 { 0 } else { top.to_bits() };
        counts.entry(key).or_insert((top, 0)).1 += 1;
    }
    counts.into_values().collect()
}

/// Самая частая высота пола, при равенстве — нижняя.
fn mode_height(tops: &[f64]) -> f64 {
    let mut entries = count_by_height(tops.iter().copied());
    entries.sort_by(|left, right| ascending(left.0, right.0));
    let mut best = tops.first().copied().unwrap_or(0.0);
    let mut best_count: i64 = -1;
    for (top, count) in entries {
        if count as i64 > best_count {
            best = top;
            best_count = count as i64;
        }
    }
    best
}

/// Нулевая отметка — высота пола этажа входа.
fn entry_floor_height(flat: &[&Surface]) -> f64 {
    let mut weights = count_by_height(flat.iter().map(|surface| surface.top));
    weights.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| ascending(left.0, right.0)));
    let mut bands: Vec<(f64, Vec<f64>)> = Vec::new();
    for (top, _) in weights {
        match bands.iter_mut().find(|(anchor, _)| (anchor - top).abs() <= 0.75) {
            Some(band) => {
                if !band.1.contains(&top) {
                    band.1.push(top);
                }
            }
            None => bands.push((top, vec![top])),
        }
    }
    let (min_x, max_x, min_z, max_z) = cell_bounds(flat.iter().copied());
    let mut scored: Vec<(f64, usize, usize)> = bands
        .iter()
        .map(|(anchor, tops)| {
            let cells: Vec<&&Surface> = flat.iter().filter(|surface| tops.contains(&surface.top)).collect();
            let border = cells.iter().filter(|surface| surface.x == min_x || surface.x == max_x || surface.z == min_z || surface.z == max_z).count();
            (*anchor, border, cells.len())
        })
        .collect();
    scored.sort_by(|left, right| right.1.cmp(&left.1).then(right.2.cmp(&left.2)).then_with(|| ascending(left.0, right.0)));
    scored.first().map_or(0.0, |entry| entry.0)
}

// ---------------------------------------------------------------------------
// Импорт

/// Параметры `importTaleSpireSlab(text, options)`.
#[derive(Clone, Debug)]
pub struct ImportOptions {
    /// По умолчанию `talespire-import`.
    pub location_id: String,
    pub theme: String,
    /// Подписи этажей: `{ "<номер>": "<подпись>" }`.
    pub level_labels: Value,
    /// Пещера или подземелье: всё, что не под крышей, всё равно помещение.
    pub underground: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self { location_id: "talespire-import".into(), theme: String::new(), level_labels: json!({}), underground: false }
    }
}

/// Итог импорта (`TaleSpireImportResult`) — форма JSON JS: `{ levels, passport,
/// stats, warnings, source }`.
pub type ImportResult = Value;

/// Счётчики импорта (`Record<string, number>`), порядок ключей — как в JS.
pub type Stats = Map<String, Value>;

fn stat(stats: &Stats, key: &str) -> f64 {
    let number = js::number(stats.get(key));
    if number.is_nan() {
        0.0
    } else {
        number
    }
}

fn bump(stats: &mut Stats, key: &str, by: f64) {
    let value = stat(stats, key) + by;
    stats.insert(key.into(), js::num(value));
}

/// Перевод мировых координат в клетки карты.
#[derive(Clone, Copy)]
struct Frame {
    min_x: i64,
    max_z: i64,
    offset_x: i64,
    offset_y: i64,
}

impl Frame {
    fn x(&self, x: i64) -> i64 {
        x - self.min_x + self.offset_x
    }

    fn y(&self, z: i64) -> i64 {
        self.max_z - z + self.offset_y
    }

    fn xf(&self, x: f64) -> f64 {
        x - self.min_x as f64 + self.offset_x as f64
    }

    fn yf(&self, z: f64) -> f64 {
        self.max_z as f64 - z + self.offset_y as f64
    }
}

/// `importTaleSpireSlab(text, options)`: слэб — строка из буфера обмена
/// TaleSpire (`None` — значение не строка).
pub fn import_talespire_slab(input: Option<&str>, options: &ImportOptions) -> Result<ImportResult> {
    let slab = decode_slab(input)?;
    let source_text = input.unwrap_or_default();
    let (boxes, unknown) = world_boxes_for_slab(&slab, talespire_asset_table()?);
    let mut warnings: Vec<String> = Vec::new();
    if unknown > 0 {
        warnings.push(format!("Незнакомых ассетов: {unknown} — это пользовательские наборы или ассеты новее таблицы; они пропущены"));
    }
    if boxes.is_empty() {
        return Err(TaleSpireImportError::new("В слэбе нет ни одного известного ассета TaleSpire", "TALESPIRE_NOTHING_KNOWN"));
    }
    let footprint = source_cells(&boxes);
    if !(footprint <= TALESPIRE_MAX_SOURCE_CELLS) {
        return Err(TaleSpireImportError::new(
            format!(
                "Объекты слэба покрывают {} клеток — больше предела {}: скопируйте часть доски",
                js::f64_string(footprint),
                js::f64_string(TALESPIRE_MAX_SOURCE_CELLS)
            ),
            "TALESPIRE_SLAB_TOO_COMPLEX",
        ));
    }

    // --- поверхности и этажи ---
    let surfaces = walkable_surfaces(&boxes);
    let all_surfaces: Vec<&Surface> = surfaces.values().flatten().collect();
    if !all_surfaces.iter().any(|surface| surface.role != "stairs") {
        return Err(TaleSpireImportError::new("В слэбе нет пола: выделите область вместе с полом или землёй", "TALESPIRE_NO_FLOOR"));
    }
    let ground_top = entry_floor_height(&all_surfaces);
    let level_of = |top: f64| ((top - ground_top + STOREY_TOLERANCE) / STOREY_HEIGHT).floor() as i64;

    let mut level_cells: IndexMap<i64, IndexMap<Cell, Surface>> = IndexMap::new();
    for surface in &all_surfaces {
        let level = level_of(surface.top);
        let cells = level_cells.entry(level).or_default();
        let key = (surface.x, surface.z);
        let replace = cells.get(&key).is_none_or(|previous| surface.top > previous.top);
        if replace {
            cells.insert(key, (*surface).clone());
        }
    }
    for level in level_cells.keys().copied().collect::<Vec<_>>() {
        if level == 0 {
            continue;
        }
        if level.abs() > MAX_LEVEL_OFFSET {
            warnings.push(format!("Этаж {}{level} дальше ±{MAX_LEVEL_OFFSET} от входа — пропущен", if level > 0 { "+" } else { "" }));
            level_cells.shift_remove(&level);
        } else if level_cells.get(&level).is_some_and(|cells| cells.len() < MIN_LEVEL_CELLS) {
            level_cells.shift_remove(&level);
        }
    }
    let mut level_base: HashMap<i64, f64> = HashMap::new();
    for (level, cells) in &level_cells {
        let tops: Vec<f64> = cells.values().filter(|surface| surface.role != "stairs").map(|surface| surface.top).collect();
        level_base.insert(*level, if tops.is_empty() { ground_top + *level as f64 * STOREY_HEIGHT } else { mode_height(&tops) });
    }

    // --- общая система координат всех этажей ---
    let (min_x, max_x, min_z, max_z) = cell_bounds(level_cells.values().flat_map(|cells| cells.values()));
    let span_x = max_x - min_x + 1;
    let span_z = max_z - min_z + 1;
    let region = SIZE_CLASSES[2].1;
    if span_x > region.max_width || span_z > region.max_height {
        return Err(TaleSpireImportError::new(
            format!("Область {span_x}×{span_z} клеток больше предела {}×{}: скопируйте часть доски", region.max_width, region.max_height),
            "TALESPIRE_MAP_TOO_LARGE",
        ));
    }
    let width = MIN_MAP_SIDE.max(span_x);
    let height = MIN_MAP_SIDE.max(span_z);
    let frame = Frame { min_x, max_z, offset_x: (width - span_x).div_euclid(2), offset_y: (height - span_z).div_euclid(2) };
    let size_class_name = size_class_for(width, height);
    let limits = size_class(size_class_name).unwrap_or(region);
    let full_hash = hash::sha256_hex(source_text);
    let source_hash = &full_hash[..16];

    let mut stats = Stats::new();
    for (key, value) in [
        ("instances", slab.instances.len()),
        ("unknown", unknown),
        ("floorCells", 0),
        ("blockedCells", 0),
        ("difficultCells", 0),
        ("walls", 0),
        ("doors", 0),
        ("windows", 0),
        ("rails", 0),
        ("props", 0),
        ("propsSkipped", 0),
        ("transitions", 0),
    ] {
        stats.insert(key.into(), Value::from(value));
    }

    let mut maps: IndexMap<i64, TacticalMap> = IndexMap::new();
    let mut levels: Vec<i64> = level_cells.keys().copied().collect();
    levels.sort_unstable();
    for &level in &levels {
        let cells = &level_cells[&level];
        let base = level_base[&level];
        let custom = text::trim(&js::s(options.level_labels.get(level.to_string().as_str()))).to_string();
        let custom = head_utf16(&custom, 60);
        let label = if custom.is_empty() { level_label_for(level, None) } else { custom };
        let seed = format!("talespire:{source_hash}:{level}");
        let mut map = create_tactical_map(&TacticalMapOptions {
            width,
            height,
            location_id: &options.location_id,
            level_index: level,
            level_label: &label,
            theme: &options.theme,
            size_class: size_class_name,
            seed: &seed,
            generator: Some(("talespire-slab", TALESPIRE_IMPORT_VERSION)),
            ..TacticalMapOptions::default()
        })?;
        for surface in cells.values() {
            let delta = surface.top - base;
            let steps = sign(delta) * (delta.abs() + 0.25).floor();
            set_cell(
                &mut map,
                frame.x(surface.x),
                frame.y(surface.z),
                &CellPatch {
                    passable: Some(true),
                    revealed: Some(false),
                    material: Some(&surface.material),
                    elevation: Some((steps.clamp(-4.0, 4.0) * 5.0) as i64),
                    ..CellPatch::default()
                },
            )?;
            bump(&mut stats, "floorCells", 1.0);
        }
        project_obstacles(&mut map, &boxes, cells, base, frame, limits, &mut stats)?;
        maps.insert(level, map);
    }

    // --- переходы между этажами ---
    link_levels(&mut maps, &level_cells, &boxes, frame, &level_of, &mut stats)?;
    for &level in &levels {
        if level == 0 {
            continue;
        }
        let Some(map) = maps.get(&level) else { continue };
        if !map.props.iter().any(|prop| prop.transition.is_some()) {
            warnings.push(format!("{}: нет лестницы, которая бы на него вела, — этаж пропущен", map.level_label));
            maps.shift_remove(&level);
        }
    }
    let present: HashSet<i64> = maps.keys().copied().collect();
    for map in maps.values_mut() {
        map.props.retain(|prop| prop.transition.as_ref().is_none_or(|transition| present.contains(&transition.to_level)));
    }

    // --- комнаты ---
    let mut ceilings: IndexMap<Cell, Vec<f64>> = IndexMap::new();
    for world in &boxes {
        if world.kind != "t" || !includes(&["roof", "floor", "wallfloor"], &world.role) {
            continue;
        }
        for cell in covered_cells(world, 0.4) {
            ceilings.entry(cell).or_default().push(world.min_y);
        }
    }
    for (level, map) in maps.iter_mut() {
        assign_rooms(map, &level_cells[level], &ceilings, frame, *level, options.underground)?;
        repair_imported_level(map, &mut stats)?;
    }

    // --- вход, раскрытие, проверка ---
    let Some(ground) = maps.get_mut(&0) else {
        return Err(TaleSpireImportError::new("На этаже входа нет свободной клетки для отряда", "TALESPIRE_NO_ENTRANCE"));
    };
    let Some(entrance) = choose_entrance(ground) else {
        return Err(TaleSpireImportError::new("На этаже входа нет свободной клетки для отряда", "TALESPIRE_NO_ENTRANCE"));
    };
    add_spawn_point(ground, &json!({ "id": "talespire-entrance", "x": entrance.x, "y": entrance.y, "role": "party" }))?;
    reveal_around(ground, entrance)?;
    let visible = cells_visible_from(ground, sk_geometry::Point { x: entrance.x as f64, y: entrance.y as f64 }, DOORWAY_SIGHT_CELLS, None);
    for cell in visible {
        set_cell(ground, cell.x, cell.y, &CellPatch { revealed: Some(true), ..CellPatch::default() })?;
    }
    for (level, map) in maps.iter_mut() {
        if *level == 0 {
            continue;
        }
        let arrival = map.props.iter().find(|prop| prop.transition.is_some()).and_then(|prop| prop.footprint.first().copied());
        if let Some(arrival) = arrival {
            reveal_around(map, arrival)?;
        }
    }

    let mut ordered: Vec<(&i64, &TacticalMap)> = maps.iter().collect();
    ordered.sort_by_key(|(level, _)| **level);
    let mut imported = Vec::new();
    for (level, map) in &ordered {
        let check = validate_tactical_map(map);
        if !check.ok {
            let first = check.errors.first();
            return Err(TaleSpireImportError::new(
                format!(
                    "Импорт собрал неверную карту ({}): {}",
                    first.map_or("undefined", |issue| issue.code.as_str()),
                    first.map_or("undefined", |issue| issue.message.as_str())
                ),
                "TALESPIRE_MAP_INVALID",
            ));
        }
        let label = if map.level_label.is_empty() { level_label_for(**level, None) } else { map.level_label.clone() };
        imported.push(json!({ "index": level, "label": label, "map": serialize_tactical_map(map)? }));
    }
    let map_list: Vec<&TacticalMap> = maps.values().collect();
    let mut passport = match map_passport(&map_list) {
        Value::Object(passport) => passport,
        _ => Map::new(),
    };
    let scifi = boxes.iter().filter(|world| world.genre == "s").count() as f64;
    passport.insert("genre".into(), json!(if scifi > boxes.len() as f64 * 0.2 { "scifi" } else { "fantasy" }));
    let quality = maps.get(&0).map_or(Value::Null, |ground| import_quality(ground, &stats));
    passport.insert("quality".into(), quality);
    Ok(json!({
        "levels": imported,
        "passport": passport,
        "stats": stats,
        "warnings": warnings,
        "source": { "format": "talespire-slab", "version": slab.version, "sha256": full_hash, "instances": slab.instances.len() },
    }))
}

/// `Math.sign(value)`.
fn sign(value: f64) -> f64 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else {
        value
    }
}

/// `text.slice(0, max)` в единицах UTF-16.
fn head_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in source.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EdgeWish {
    Wall,
    Door,
    Window,
    Rail,
    Grate,
}

/// Стены, двери, глухие клетки, трудная местность и предметы одного этажа.
fn project_obstacles(
    map: &mut TacticalMap,
    boxes: &[WorldBox],
    cells: &IndexMap<Cell, Surface>,
    base: f64,
    frame: Frame,
    limits: SizeClass,
    stats: &mut Stats,
) -> Result<()> {
    let has = |x: i64, z: i64| cells.contains_key(&(x, z));
    let top_at = |x: i64, z: i64| cells.get(&(x, z)).map_or(base, |surface| surface.top);
    let mut blocked: IndexSet<Cell> = IndexSet::new();
    let mut difficult: IndexSet<Cell> = IndexSet::new();
    let mut wall_edges: i64 = 0;

    let mut put_edge = |map: &mut TacticalMap, stats: &mut Stats, a: Cell, b: Cell, kind: EdgeWish| -> Result<()> {
        if !has(a.0, a.1) && !has(b.0, b.1) {
            return Ok(());
        }
        let (x1, y1, x2, y2) = (frame.x(a.0), frame.y(a.1), frame.x(b.0), frame.y(b.1));
        let (ex, ey, dir) = canonical_edge(x1, y1, x2, y2)?;
        if let Some(existing) = map.edge(ex, ey, dir) {
            if existing.kind == EdgeKind::Door || kind != EdgeWish::Door {
                return Ok(());
            }
        }
        if kind == EdgeWish::Door {
            if !has(a.0, a.1) || !has(b.0, b.1) {
                return Ok(()); // дверь в никуда — просто стена
            }
            let id = format!("door-{}", map.doors.len() + 1);
            set_door(map, &json!({ "id": id, "x": ex, "y": ey, "dir": dir.as_str(), "state": "closed" }))?;
            bump(stats, "doors", 1.0);
            return Ok(());
        }
        if kind == EdgeWish::Wall || kind == EdgeWish::Window {
            if wall_edges >= limits.max_wall_edges {
                return Ok(());
            }
            wall_edges += 1;
        }
        match kind {
            EdgeWish::Wall => {
                set_edge(map, x1, y1, x2, y2, &EdgePatch { kind: Some("wall"), ..EdgePatch::default() })?;
                bump(stats, "walls", 1.0);
            }
            EdgeWish::Window => {
                let patch = EdgePatch { kind: Some("window"), blocks_move: Some(true), blocks_sight: Some(false), cover: Some("half"), door_id: None };
                set_edge(map, x1, y1, x2, y2, &patch)?;
                bump(stats, "windows", 1.0);
            }
            EdgeWish::Grate => {
                let patch = EdgePatch { kind: Some("grate"), blocks_move: Some(true), blocks_sight: Some(false), cover: Some("half"), door_id: None };
                set_edge(map, x1, y1, x2, y2, &patch)?;
                bump(stats, "walls", 1.0);
            }
            _ => {
                let patch = EdgePatch { kind: Some("rail"), blocks_move: Some(false), blocks_sight: Some(false), cover: Some("half"), door_id: None };
                set_edge(map, x1, y1, x2, y2, &patch)?;
                bump(stats, "rails", 1.0);
            }
        }
        Ok(())
    };

    let walls_around_patch =
        |map: &mut TacticalMap, stats: &mut Stats, footprint: &[Cell], put_edge: &mut dyn FnMut(&mut TacticalMap, &mut Stats, Cell, Cell, EdgeWish) -> Result<()>| -> Result<()> {
            let inside: HashSet<Cell> = footprint.iter().copied().collect();
            for &(x, z) in footprint {
                for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, nz) = (x + dx, z + dz);
                    if inside.contains(&(nx, nz)) {
                        continue;
                    }
                    if has(nx, nz) && (top_at(nx, nz) - top_at(x, z)).abs() <= 1.0 {
                        continue;
                    }
                    put_edge(map, stats, (x, z), (nx, nz), EdgeWish::Wall)?;
                }
            }
            Ok(())
        };

    for world in boxes {
        if world.kind != "t" {
            continue;
        }
        if world.role == "wallfloor" {
            let footprint: Vec<Cell> = covered_cells(world, 0.45).into_iter().filter(|cell| has(cell.0, cell.1)).collect();
            let Some(first) = footprint.first() else { continue };
            if (top_at(first.0, first.1) - (world.min_y + 0.5).min(world.max_y)).abs() > 0.3 {
                continue;
            }
            walls_around_patch(map, stats, &footprint, &mut put_edge)?;
            continue;
        }
        if !includes(&["wall", "door", "window", "fence"], &world.role) {
            continue;
        }
        if overlap(world.min_y, world.max_y, base + BODY_LOW, base + BODY_HIGH) < 0.25 {
            continue;
        }
        let size_x = world.max_x - world.min_x;
        let size_z = world.max_z - world.min_z;
        let tall = world.max_y - world.min_y;
        if world.role == "wall" && size_x >= 1.5 && size_z >= 1.5 && tall >= 1.5 {
            let footprint: Vec<Cell> =
                covered_cells(world, 0.45).into_iter().filter(|cell| has(cell.0, cell.1) && (top_at(cell.0, cell.1) - world.min_y).abs() <= 0.6).collect();
            if !footprint.is_empty() {
                walls_around_patch(map, stats, &footprint, &mut put_edge)?;
                continue;
            }
        }
        let thin = size_x.min(size_z) <= 0.6 && size_x.max(size_z) >= 0.9;
        if thin {
            let along_z = size_x < size_z;
            let line = js::round(if along_z { (world.min_x + world.max_x) / 2.0 } else { (world.min_z + world.max_z) / 2.0 }) as i64;
            let from = js::round(if along_z { world.min_z } else { world.min_x }) as i64;
            let to = js::round(if along_z { world.max_z } else { world.max_x }) as i64;
            let kind = match world.role.as_str() {
                "door" => EdgeWish::Door,
                "window" => EdgeWish::Window,
                "fence" => {
                    if tall <= 0.7 {
                        EdgeWish::Rail
                    } else {
                        EdgeWish::Grate
                    }
                }
                _ => EdgeWish::Wall,
            };
            for along in from..to {
                if along_z {
                    put_edge(map, stats, (line - 1, along), (line, along), kind)?;
                } else {
                    put_edge(map, stats, (along, line - 1), (along, line), kind)?;
                }
            }
            continue;
        }
        if world.role == "door" || world.role == "window" {
            continue;
        }
        for cell in covered_cells(world, 0.4) {
            if !has(cell.0, cell.1) {
                continue;
            }
            let top = top_at(cell.0, cell.1);
            if world.max_y - top < 0.35 || world.min_y > top + 1.5 {
                continue;
            }
            if world.role == "fence" && tall <= 0.7 {
                continue;
            }
            blocked.insert(cell);
        }
    }

    // Предметы: сперва крупные, чтобы мелочь не заняла их клетки.
    let mut props: Vec<(&WorldBox, f64)> = boxes
        .iter()
        .filter(|world| world.kind == "p" && (world.role == "prop" || world.role == "rock"))
        .map(|world| (world, (world.max_x - world.min_x) * (world.max_z - world.min_z)))
        .collect();
    props.sort_by(|left, right| {
        ascending(right.1, left.1)
            .then_with(|| ascending(left.0.min_x, right.0.min_x))
            .then_with(|| ascending(left.0.min_z, right.0.min_z))
            .then_with(|| ascending(left.0.min_y, right.0.min_y))
    });
    let mut taken: HashSet<Cell> = HashSet::new();
    for (world, area) in props {
        let center_x = ((world.min_x + world.max_x) / 2.0).floor() as i64;
        let center_z = ((world.min_z + world.max_z) / 2.0).floor() as i64;
        if !has(center_x, center_z) {
            continue;
        }
        let top = top_at(center_x, center_z);
        let protrude = world.max_y - top;
        if world.role == "rock" {
            if protrude < 0.35 || world.min_y > top + 1.2 {
                continue;
            }
            let covered: Vec<Cell> = covered_cells(world, 0.4).into_iter().filter(|cell| has(cell.0, cell.1)).collect();
            if protrude < 0.9 {
                difficult.extend(covered.iter().copied());
            } else if covered.len() > 1 {
                blocked.extend(covered.iter().copied());
            } else if covered.len() == 1 && !taken.contains(&covered[0]) && place_prop(map, "boulder", world, &covered, frame, &mut taken, &blocked, limits)? {
                bump(stats, "props", 1.0);
            }
            continue;
        }
        if area < 0.12 || world.min_y > top + 1.0 || world.min_y < top - 0.6 {
            bump(stats, "propsSkipped", 1.0);
            continue;
        }
        let Some(entry) = asset_by_id(&world.prop_asset) else { continue };
        // Плоское — ковры, паутина — только если у вида каталога есть плоский вариант.
        if protrude < 0.25 && entry.kind != "decal" {
            bump(stats, "propsSkipped", 1.0);
            continue;
        }
        let mut covered: Vec<Cell> = covered_cells(world, 0.3).into_iter().filter(|cell| has(cell.0, cell.1)).collect();
        if covered.is_empty() {
            covered.push((center_x, center_z));
        }
        if place_prop(map, &world.prop_asset, world, &covered, frame, &mut taken, &blocked, limits)? {
            bump(stats, "props", 1.0);
        } else {
            bump(stats, "propsSkipped", 1.0);
        }
    }

    for &(x, z) in &blocked {
        let (mx, my) = (frame.x(x), frame.y(z));
        if !cell_at(map, mx, my).is_some_and(|cell| cell.passable) {
            continue;
        }
        if map.props.iter().any(|prop| prop.footprint.iter().any(|spot| spot.x == mx && spot.y == my)) {
            continue;
        }
        set_cell(map, mx, my, &CellPatch { passable: Some(false), ..CellPatch::default() })?;
        bump(stats, "blockedCells", 1.0);
    }
    for &(x, z) in &difficult {
        if blocked.contains(&(x, z)) {
            continue;
        }
        set_cell(map, frame.x(x), frame.y(z), &CellPatch { move_cost: Some(2.0), surface: Some("rubble"), ..CellPatch::default() })?;
        bump(stats, "difficultCells", 1.0);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)] // повторяет `placeProp(map, assetId, box, covered, context)` JS
fn place_prop(
    map: &mut TacticalMap,
    asset_id: &str,
    world: &WorldBox,
    covered: &[Cell],
    frame: Frame,
    taken: &mut HashSet<Cell>,
    blocked: &IndexSet<Cell>,
    limits: SizeClass,
) -> Result<bool> {
    if map.props.len() as i64 >= limits.max_props {
        return Ok(false);
    }
    let free: Vec<Cell> = covered.iter().copied().filter(|cell| !taken.contains(cell) && !blocked.contains(cell)).collect();
    if free.is_empty() {
        return Ok(false);
    }
    let blocks_move = asset_by_id(asset_id).is_some_and(|entry| entry.blocks_move);
    taken.extend(free.iter().copied());
    let footprint: Vec<Value> = free.iter().map(|cell| json!({ "x": frame.x(cell.0), "y": frame.y(cell.1) })).collect();
    add_prop(
        map,
        &json!({
            "id": format!("ts-{asset_id}-{}", map.props.len() + 1),
            "assetId": asset_id,
            "x": js::num(round2(frame.xf((world.min_x + world.max_x) / 2.0))),
            // непрерывная координата: клетка z занимает [z, z+1], её строка — toY(z)
            "y": js::num(round2(frame.yf((world.min_z + world.max_z) / 2.0) + 1.0)),
            "rotation": js::num(js::round(world.rotation) % 360.0),
            "footprint": footprint,
            "blocksMove": blocks_move,
            "blocksSight": false,
            "cover": if blocks_move { "half" } else { "none" },
        }),
    )?;
    Ok(true)
}

/// Конец перехода: этаж и мировая клетка.
#[derive(Clone, Copy)]
struct LinkEnd {
    level: i64,
    x: i64,
    z: i64,
}

/// Пары переходов между соседними этажами: цепочки ступеней и стремянки.
fn link_levels(
    maps: &mut IndexMap<i64, TacticalMap>,
    level_cells: &IndexMap<i64, IndexMap<Cell, Surface>>,
    boxes: &[WorldBox],
    frame: Frame,
    level_of: &dyn Fn(f64) -> i64,
    stats: &mut Stats,
) -> Result<()> {
    let mut links: Vec<(LinkEnd, LinkEnd)> = Vec::new();

    // 1. Цепочки ступеней
    let mut steps: IndexMap<(i64, Cell), &Surface> = IndexMap::new();
    for (level, cells) in level_cells {
        for surface in cells.values() {
            if surface.role == "stairs" {
                steps.insert((*level, (surface.x, surface.z)), surface);
            }
        }
    }
    let mut seen: HashSet<(i64, Cell)> = HashSet::new();
    let step_levels: Vec<i64> = level_cells.keys().copied().collect();
    for (key, start) in &steps {
        if seen.contains(key) {
            continue;
        }
        let mut run: Vec<(&Surface, i64)> = Vec::new();
        let mut queue: Vec<&Surface> = vec![start];
        seen.insert(*key);
        let mut head = 0;
        while head < queue.len() {
            let surface = queue[head];
            head += 1;
            run.push((surface, level_of(surface.top)));
            let mut near: Vec<(usize, (i64, Cell))> = Vec::new();
            for &level in &step_levels {
                for dx in -1..=1 {
                    for dz in -1..=1 {
                        let other_key = (level, (surface.x + dx, surface.z + dz));
                        let Some((position, _, other)) = steps.get_full(&other_key) else { continue };
                        if seen.contains(&other_key) {
                            continue;
                        }
                        if (other.top - surface.top).abs() > 1.01 {
                            continue;
                        }
                        near.push((position, other_key));
                    }
                }
            }
            near.sort_by_key(|(position, _)| *position);
            for (_, other_key) in near {
                seen.insert(other_key);
                queue.push(steps[&other_key]);
            }
        }
        let mut levels_in_run: Vec<i64> = run.iter().map(|(_, level)| *level).collect::<IndexSet<_>>().into_iter().collect();
        levels_in_run.sort_unstable();
        let (Some(&lowest), Some(&highest)) = (levels_in_run.first(), levels_in_run.last()) else { continue };
        let highest_step = run.iter().fold(run[0].0, |best, (step, _)| if step.top > best.top { step } else { best });
        for level in lowest..=highest {
            let upper = level + 1;
            if !level_cells.contains_key(&level) || !level_cells.contains_key(&upper) {
                continue;
            }
            let low_steps: Vec<&Surface> = run.iter().filter(|(_, step_level)| *step_level == level).map(|(step, _)| *step).collect();
            let Some(first_low) = low_steps.first() else { continue };
            let low = low_steps.iter().fold(*first_low, |best, step| if step.top > best.top { step } else { best });
            let high_steps: Vec<&Surface> = run.iter().filter(|(_, step_level)| *step_level == upper).map(|(step, _)| *step).collect();
            let high = match high_steps.first() {
                Some(first_high) => Some(high_steps.iter().fold(*first_high, |best, step| if step.top < best.top { step } else { best })),
                None => nearest_floor(&level_cells[&upper], highest_step.x, highest_step.z),
            };
            if let Some(high) = high {
                links.push((LinkEnd { level, x: low.x, z: low.z }, LinkEnd { level: upper, x: high.x, z: high.z }));
            }
        }
    }

    // 2. Стремянки
    for world in boxes {
        if world.kind != "p" || world.role != "ladder" {
            continue;
        }
        let x = ((world.min_x + world.max_x) / 2.0).floor() as i64;
        let z = ((world.min_z + world.max_z) / 2.0).floor() as i64;
        let low_level = level_of(world.min_y);
        let high_level = level_of(world.max_y + 0.3);
        if high_level != low_level + 1 || !level_cells.contains_key(&low_level) || !level_cells.contains_key(&high_level) {
            continue;
        }
        let low = nearest_floor(&level_cells[&low_level], x, z);
        let high = nearest_floor(&level_cells[&high_level], x, z);
        if let (Some(low), Some(high)) = (low, high) {
            links.push((LinkEnd { level: low_level, x: low.x, z: low.z }, LinkEnd { level: high_level, x: high.x, z: high.z }));
        }
    }

    let mut occupied_on: HashMap<i64, HashSet<Cell>> = HashMap::new();
    fn occupied<'a>(cache: &'a mut HashMap<i64, HashSet<Cell>>, level: i64, map: &TacticalMap) -> &'a mut HashSet<Cell> {
        cache.entry(level).or_insert_with(|| map.props.iter().flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect())
    }
    for (low_end, high_end) in links {
        let (Some(low_map), Some(high_map)) = (maps.get(&low_end.level), maps.get(&high_end.level)) else { continue };
        let low_spot = free_spot(low_map, frame.x(low_end.x), frame.y(low_end.z), occupied(&mut occupied_on, low_end.level, low_map));
        let high_spot = free_spot(high_map, frame.x(high_end.x), frame.y(high_end.z), occupied(&mut occupied_on, high_end.level, high_map));
        let (Some(low_spot), Some(high_spot)) = (low_spot, high_spot) else { continue };
        let high_label = if high_map.level_label.is_empty() { level_label_for(high_end.level, None) } else { high_map.level_label.clone() };
        let low_label = if low_map.level_label.is_empty() { level_label_for(low_end.level, None) } else { low_map.level_label.clone() };
        let up_footprint = {
            let low_map = maps.get_mut(&low_end.level).ok_or_else(|| TaleSpireImportError::new("этаж пропал", "TALESPIRE_INTERNAL"))?;
            let up = add_prop(
                low_map,
                &json!({
                    "id": format!("ts-stairs-up-{}", low_map.props.len() + 1), "assetId": "stairs_up",
                    "x": js::num(low_spot.x as f64 + 0.5), "y": js::num(low_spot.y as f64 + 0.5),
                    "footprint": [{ "x": low_spot.x, "y": low_spot.y }], "blocksMove": false, "blocksSight": false, "cover": "none", "interactive": true,
                    "transition": { "toLevel": high_end.level, "label": high_label },
                }),
            )?;
            up.footprint.clone()
        };
        let down_footprint = {
            let high_map = maps.get_mut(&high_end.level).ok_or_else(|| TaleSpireImportError::new("этаж пропал", "TALESPIRE_INTERNAL"))?;
            let down = add_prop(
                high_map,
                &json!({
                    "id": format!("ts-stairs-down-{}", high_map.props.len() + 1), "assetId": "stairs_down",
                    "x": js::num(high_spot.x as f64 + 0.5), "y": js::num(high_spot.y as f64 + 0.5),
                    "footprint": [{ "x": high_spot.x, "y": high_spot.y }], "blocksMove": false, "blocksSight": false, "cover": "none", "interactive": true,
                    "transition": { "toLevel": low_end.level, "label": low_label },
                }),
            )?;
            down.footprint.clone()
        };
        if let Some(cells) = occupied_on.get_mut(&low_end.level) {
            cells.extend(up_footprint.iter().map(|cell| (cell.x, cell.y)));
        }
        if let Some(cells) = occupied_on.get_mut(&high_end.level) {
            cells.extend(down_footprint.iter().map(|cell| (cell.x, cell.y)));
        }
        bump(stats, "transitions", 1.0);
    }
    Ok(())
}

fn nearest_floor(cells: &IndexMap<Cell, Surface>, x: i64, z: i64) -> Option<&Surface> {
    let mut best = None;
    let mut best_distance = 2.5;
    for surface in cells.values() {
        let distance = v8math::hypot((surface.x - x) as f64, (surface.z - z) as f64);
        if distance < best_distance - EPSILON {
            best = Some(surface);
            best_distance = distance;
        }
    }
    best
}

/// Свободная проходимая клетка для лестницы: сама точка или ближайшая соседняя.
fn free_spot(map: &TacticalMap, x: i64, y: i64, occupied: &HashSet<Cell>) -> Option<Point> {
    for radius in 0..=2i64 {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx.abs().max(dy.abs()) != radius {
                    continue;
                }
                if cell_at(map, x + dx, y + dy).is_some_and(|cell| cell.passable) && !occupied.contains(&(x + dx, y + dy)) {
                    return Some(Point { x: x + dx, y: y + dy });
                }
            }
        }
    }
    None
}

/// Вход на этаж: клетка самой большой связной области, ближайшая к середине
/// нижнего (южного) края.
fn choose_entrance(map: &TacticalMap) -> Option<Point> {
    let occupied: HashSet<Cell> =
        map.props.iter().filter(|prop| prop.blocks_move).flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    let mut open: Vec<Cell> = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if cell_at(map, x, y).is_some_and(|cell| cell.passable) && !occupied.contains(&(x, y)) {
                open.push((x, y));
            }
        }
    }
    if open.is_empty() {
        return None;
    }
    let mut visited: HashSet<Cell> = HashSet::new();
    let mut largest: IndexSet<Cell> = IndexSet::new();
    for cell in &open {
        if visited.contains(cell) {
            continue;
        }
        let region = reachable_cells(map, cell.0, cell.1, true, Some(&occupied));
        visited.extend(region.iter().copied());
        if region.len() > largest.len() {
            largest = region;
        }
    }
    let middle = (map.bounds.min_x + map.bounds.max_x) as f64 / 2.0;
    let mut border: Vec<Cell> = open.into_iter().filter(|cell| largest.contains(cell)).collect();
    border.sort_by(|left, right| {
        right.1.cmp(&left.1).then_with(|| ascending((left.0 as f64 - middle).abs(), (right.0 as f64 - middle).abs())).then(left.0.cmp(&right.0))
    });
    border.first().map(|cell| Point { x: cell.0, y: cell.1 })
}

/// Раскрывает область, видимую с точки без открывания дверей.
fn reveal_around(map: &mut TacticalMap, from: Point) -> Result<()> {
    let reveal = CellPatch { revealed: Some(true), ..CellPatch::default() };
    for (x, y) in reachable_cells(map, from.x, from.y, false, None) {
        set_cell(map, x, y, &reveal)?;
    }
    set_cell(map, from.x, from.y, &reveal)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Комнаты и паспорт карты

/// Сколько комнат на этаже получает подпись; остальное — коридоры и закутки.
const MAX_ROOMS: usize = 60;
const MIN_ROOM_CELLS: usize = 4;

/// Комната для подписи (`roomLabelFor(props, room)`).
#[derive(Clone, Debug, PartialEq)]
pub struct RoomInfo {
    pub cells: f64,
    pub interior: bool,
    pub level: f64,
    pub material: String,
    pub underground: bool,
}

/// Подпись комнаты по её обстановке. `props` — счёт видов каталога в комнате
/// (`{ assetId: штук }`; значения — числа).
pub fn room_label_for(props: &Value, room: &RoomInfo) -> String {
    let count = |ids: &[&str]| ids.iter().fold(0.0, |sum, id| sum + props.get(*id).map_or(0.0, |value| if value.is_null() { 0.0 } else { js::number(Some(value)) }));
    let seats = count(&["chair", "stool", "bench"]);
    let tables = count(&["table_round", "table_long", "table_small"]);
    let burial = count(&["sarcophagus", "crypt_niche"]) >= 1.0 || count(&["grave"]) >= 2.0 || count(&["bone_pile", "grave"]) >= 3.0;
    let label = |text: &str| text.to_string();
    if !room.interior {
        if count(&["market_stall"]) >= 2.0 {
            return label("Торговые ряды");
        }
        if count(&["grave", "sarcophagus"]) >= 3.0 {
            return label("Кладбище");
        }
        if room.level < 0.0 || (room.material == "earth" && count(&["stalagmite", "mushroom_cluster"]) > 0.0) {
            return label("Пещера");
        }
        if count(&["tree_oak", "tree_pine", "tree_birch", "tree_dead", "tree_spruce"]) >= 4.0 {
            return label("Роща");
        }
        if count(&["campfire", "woodpile"]) >= 1.0 && room.cells < 400.0 {
            return label("Стоянка");
        }
        if room.cells < 120.0 {
            return label("Двор");
        }
        return label(match room.material.as_str() {
            "grass" => "Поляна",
            "sand" => "Пески",
            "ice" => "Снега",
            "earth" => "Открытое место",
            _ => "Улица",
        });
    }
    if room.underground {
        if burial {
            return label("Склеп");
        }
        if count(&["altar", "statue", "reliquary"]) >= 1.0 {
            return label("Святилище");
        }
        if count(&["bed", "bunk_bed"]) >= 1.0 {
            return label("Логово");
        }
        return label(if room.material == "earth" || room.material == "grass" { "Пещера" } else { "Подземелье" });
    }
    if count(&["bar_counter"]) > 0.0 || (tables >= 2.0 && seats >= 3.0) {
        return label("Общий зал");
    }
    if count(&["royal_throne"]) > 0.0 {
        return label("Тронный зал");
    }
    if count(&["altar", "prayer_bench", "reliquary", "statue"]) >= 1.0 && count(&["bed", "bunk_bed"]) == 0.0 {
        return label("Святилище");
    }
    if burial {
        return label("Склеп");
    }
    if count(&["bunk_bed"]) >= 2.0 {
        return label("Казарма");
    }
    if count(&["bed", "bunk_bed"]) >= 3.0 {
        return label("Спальни");
    }
    if count(&["bed", "bunk_bed"]) >= 1.0 {
        return label("Спальня");
    }
    if count(&["fireplace", "cauldron", "pot", "cutting_board"]) >= 1.0 && tables + count(&["cupboard"]) >= 1.0 {
        return label("Кухня");
    }
    if count(&["market_stall"]) >= 1.0 {
        return label("Лавка");
    }
    if count(&["bookshelf"]) >= 2.0 {
        return label("Библиотека");
    }
    if count(&["barrel", "barrel_stack", "keg", "crate", "crate_stack", "sack"]) >= 3.0 {
        return label(if room.level < 0.0 { "Погреб" } else { "Кладовая" });
    }
    if room.level < 0.0 {
        return label(if room.material == "earth" { "Пещера" } else { "Подземелье" });
    }
    label(if room.cells >= 40.0 {
        "Зал"
    } else if room.cells <= 8.0 {
        "Коридор"
    } else {
        "Комната"
    })
}

/// Счётчик с порядком вставки ключей-строк (`Record<string, number>`).
fn count_into(counts: &mut Vec<(String, f64)>, key: &str, by: f64) {
    match counts.iter_mut().find(|(id, _)| id == key) {
        Some(entry) => entry.1 += by,
        None => counts.push((key.to_string(), by)),
    }
}

/// Первый ключ с наибольшим счётом (`Object.entries(…).sort(desc)[0]?.[0]`).
fn dominant(counts: &[(String, f64)]) -> Option<String> {
    let mut sorted: Vec<&(String, f64)> = counts.iter().collect();
    sorted.sort_by(|left, right| ascending(right.1, left.1));
    sorted.first().map(|(id, _)| id.clone())
}

struct Component {
    keys: Vec<Cell>,
    first_key: String,
    covered: bool,
    closed: f64,
    open: f64,
    materials: Vec<(String, f64)>,
}

/// Делит этаж на комнаты и записывает их зонами карты.
fn assign_rooms(map: &mut TacticalMap, cells: &IndexMap<Cell, Surface>, ceilings: &IndexMap<Cell, Vec<f64>>, frame: Frame, level: i64, underground: bool) -> Result<()> {
    let mut by_map_cell: IndexMap<Cell, (bool, String)> = IndexMap::new();
    for surface in cells.values() {
        let above = ceilings.get(&(surface.x, surface.z)).map(Vec::as_slice).unwrap_or(&[]);
        let covered = above.iter().any(|bottom| *bottom >= surface.top + 1.4 && *bottom <= surface.top + 7.5);
        by_map_cell.insert((frame.x(surface.x), frame.y(surface.z)), (covered, surface.material.clone()));
    }
    let mut props_at: HashMap<Cell, Vec<(String, f64)>> = HashMap::new();
    for prop in &map.props {
        if prop.transition.is_some() {
            continue;
        }
        if let Some(spot) = prop.footprint.first() {
            count_into(props_at.entry((spot.x, spot.y)).or_default(), &prop.asset_id, 1.0);
        }
    }
    let mut seen: HashSet<Cell> = HashSet::new();
    let mut components: Vec<Component> = Vec::new();
    let mut starts: Vec<(String, Cell, bool)> = by_map_cell.iter().map(|(cell, (covered, _))| (cell_key(*cell), *cell, *covered)).collect();
    starts.sort_by(|left, right| text::locale_compare(&left.0, &right.0));
    for (start_key, start, covered) in starts {
        if seen.contains(&start) {
            continue;
        }
        if !cell_at(map, start.0, start.1).is_some_and(|cell| cell.passable) {
            continue;
        }
        let mut keys = Vec::new();
        let mut materials: Vec<(String, f64)> = Vec::new();
        let mut closed = 0.0;
        let mut open = 0.0;
        let mut queue = vec![start];
        seen.insert(start);
        while let Some(key) = queue.pop() {
            keys.push(key);
            let (x, y) = key;
            if let Some((_, material)) = by_map_cell.get(&key) {
                count_into(&mut materials, material, 1.0);
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let next = (x + dx, y + dy);
                let neighbour_cell = cell_at(map, next.0, next.1);
                let walled = movement_step_blocked(map, x, y, next.0, next.1)? || edge_between(map, x, y, next.0, next.1)?.is_some();
                if walled || neighbour_cell.as_ref().is_some_and(|cell| !cell.passable) {
                    closed += 1.0;
                } else if neighbour_cell.is_none() {
                    open += 1.0;
                }
                if seen.contains(&next) {
                    continue;
                }
                let Some((neighbour_covered, _)) = by_map_cell.get(&next) else { continue };
                if *neighbour_covered != covered || !neighbour_cell.is_some_and(|cell| cell.passable) {
                    continue;
                }
                if movement_step_blocked(map, x, y, next.0, next.1)? {
                    continue;
                }
                seen.insert(next);
                queue.push(next);
            }
        }
        components.push(Component { keys, first_key: start_key, covered, closed, open, materials });
    }
    // Ключ первой клетки компоненты — её начало (первый вынутый из стека).
    components.sort_by(|left, right| right.keys.len().cmp(&left.keys.len()).then_with(|| text::locale_compare(&left.first_key, &right.first_key)));
    let mut used_labels: HashMap<String, usize> = HashMap::new();
    for (index, component) in components.iter().filter(|entry| entry.keys.len() >= MIN_ROOM_CELLS).take(MAX_ROOMS).enumerate() {
        let mut props: Vec<(String, f64)> = Vec::new();
        for key in &component.keys {
            for (id, amount) in props_at.get(key).map(Vec::as_slice).unwrap_or(&[]) {
                count_into(&mut props, id, *amount);
            }
        }
        let material = dominant(&component.materials).unwrap_or_else(|| "stone".into());
        let interior = underground || component.covered || component.closed >= 0.6 * 1f64.max(component.closed + component.open);
        let props_value = Value::Object(props.iter().map(|(id, amount)| (id.clone(), js::num(*amount))).collect());
        let base = room_label_for(
            &props_value,
            &RoomInfo { cells: component.keys.len() as f64, interior, level: level as f64, material: material.clone(), underground },
        );
        let seen_before = used_labels.get(&base).copied().unwrap_or(0);
        used_labels.insert(base.clone(), seen_before + 1);
        let label = if seen_before > 0 { format!("{base} {}", seen_before + 1) } else { base };
        let id = format!("room-{}", index + 1);
        let light = if interior {
            if level < 0 || !component.covered {
                "dark"
            } else {
                "dim"
            }
        } else {
            "bright"
        };
        add_zone(map, &json!({ "id": id, "kind": if interior { "interior" } else { "exterior" }, "material": material, "lightLevel": light, "label": label }))?;
        for &(x, y) in &component.keys {
            set_cell(map, x, y, &CellPatch { zone: Some(&id), ..CellPatch::default() })?;
        }
    }
    map.overlays = Overlays {
        compass: true,
        scale_bar: true,
        room_labels: map
            .zones
            .iter()
            .filter(|zone| zone.kind == "interior" && !zone.label.is_empty())
            .map(|zone| RoomLabel { zone_id: zone.id.clone(), label: zone.label.clone() })
            .collect(),
    };
    Ok(())
}

fn list_ru(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [head @ .., last] => format!("{} и {last}", head.join(", ")),
    }
}

/// Номер подписи комнаты в конце (`/ \d+$/u`) снимается.
fn without_number(room: &str) -> String {
    text::replace_first(sk_core::re!(r" \d+$", "u"), room, "")
}

/// Уникальные с порядком первого появления.
fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    items.into_iter().collect::<IndexSet<_>>().into_iter().collect()
}

/// `mapPassport(maps)`: паспорт карты — что на ней есть, словами и признаками.
pub fn map_passport(maps: &[&TacticalMap]) -> Value {
    let mut features: IndexSet<String> = IndexSet::new();
    let mut props: Vec<(String, f64)> = Vec::new();
    let mut materials: Vec<(String, f64)> = Vec::new();
    let mut interior_cells = 0.0;
    let mut floor_cells = 0.0;
    let mut doors = 0usize;
    let mut windows = 0usize;
    struct LevelInfo {
        index: i64,
        label: String,
        cells: usize,
        rooms: Vec<String>,
    }
    let mut levels: Vec<LevelInfo> = Vec::new();
    let mut sorted: Vec<&&TacticalMap> = maps.iter().collect();
    sorted.sort_by_key(|map| map.level_index);
    for map in sorted {
        for prop in &map.props {
            if prop.transition.is_none() {
                count_into(&mut props, &prop.asset_id, 1.0);
            }
        }
        doors += map.doors.len();
        windows += map.edges().filter(|edge| edge.kind == EdgeKind::Window).count();
        let mut cells = 0;
        for y in 0..map.height {
            for x in 0..map.width {
                let Some(cell) = cell_at(map, x, y) else { continue };
                cells += 1;
                count_into(&mut materials, cell.material, 1.0);
                if !cell.zone.is_empty() && map.zones.iter().find(|zone| zone.id == cell.zone).is_some_and(|zone| zone.kind == "interior") {
                    interior_cells += 1.0;
                }
            }
        }
        floor_cells += cells as f64;
        levels.push(LevelInfo {
            index: map.level_index,
            label: map.level_label.clone(),
            cells,
            rooms: map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| zone.label.clone()).collect(),
        });
        if map.level_index < 0 {
            features.insert("cellar".into());
        }
        if map.level_index > 0 {
            features.insert("upstairs".into());
        }
    }
    let rooms: Vec<String> = levels.iter().flat_map(|level| level.rooms.iter().map(|room| without_number(room))).collect();
    let has = |label: &str| rooms.iter().any(|room| room == label);
    let checks = [
        ("common_room", has("Общий зал")),
        ("bedrooms", has("Спальня") || has("Спальни") || has("Казарма")),
        ("kitchen", has("Кухня")),
        ("storage", has("Кладовая") || has("Погреб")),
        ("shrine", has("Святилище")),
        ("crypt", has("Склеп") || has("Кладбище")),
        ("library", has("Библиотека")),
        ("shop", has("Лавка") || has("Торговые ряды")),
        ("throne", has("Тронный зал")),
        ("barracks", has("Казарма")),
        ("cave", has("Пещера") || has("Логово")),
        ("underground", has("Подземелье")),
        ("yard", has("Двор")),
        ("street", has("Улица")),
        ("grove", has("Роща") || has("Поляна")),
        ("camp", has("Стоянка")),
        ("doors", doors > 0),
        ("windows", windows > 0),
    ];
    for (feature, present) in checks {
        if present {
            features.insert(feature.into());
        }
    }
    let entry_map = maps.iter().find(|map| map.level_index == 0).or(maps.first());
    let anchors = match entry_map {
        Some(entry_map) => {
            let mut entry_props: Vec<(String, f64)> = Vec::new();
            for prop in &entry_map.props {
                if prop.transition.is_none() {
                    count_into(&mut entry_props, &prop.asset_id, 1.0);
                }
            }
            let entry_props = Value::Object(entry_props.into_iter().map(|(id, count)| (id, js::num(count))).collect());
            anchor_counts_for(Some(&entry_props), Some(&json!({ "platform": count_platforms(entry_map) })))
        }
        None => json!({}),
    };
    let interior_share = if floor_cells > 0.0 { interior_cells / floor_cells } else { 0.0 };
    features.insert(if interior_share >= 0.5 { "interior" } else { "exterior" }.into());
    let dominant_material = dominant(&materials).unwrap_or_else(|| "stone".into());

    let lower = |room: &String| text::lower(&without_number(room));
    let ground = levels.iter().find(|level| level.index == 0).or(levels.first());
    let notable: Vec<String> = unique(ground.map(|level| level.rooms.iter().map(lower).collect::<Vec<_>>()).unwrap_or_default()).into_iter().take(5).collect();
    let above: Vec<String> =
        unique(levels.iter().filter(|level| level.index > 0).flat_map(|level| level.rooms.iter()).map(lower).collect::<Vec<_>>()).into_iter().take(4).collect();
    let below: Vec<String> =
        unique(levels.iter().filter(|level| level.index < 0).flat_map(|level| level.rooms.iter()).map(lower).collect::<Vec<_>>()).into_iter().take(4).collect();
    let storeys = levels.iter().filter(|level| level.index >= 0).count();
    let storey_word = match storeys {
        1 => "одноэтажное".to_string(),
        2 => "двухэтажное".to_string(),
        3 => "трёхэтажное".to_string(),
        4 => "четырёхэтажное".to_string(),
        other => format!("{other}-этажное"),
    };
    let parts: Vec<String> = [
        if interior_share >= 0.3 { format!("{storey_word} строение") } else { "открытая местность".into() },
        if notable.is_empty() { String::new() } else { format!("внизу: {}", list_ru(&notable)) },
        if above.is_empty() { String::new() } else { format!("наверху: {}", list_ru(&above)) },
        if below.is_empty() { String::new() } else { format!("под землёй: {}", list_ru(&below)) },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect();
    let summary = format!("{}.", parts.join("; "));
    let mut sorted_features: Vec<String> = features.into_iter().collect();
    sorted_features.sort();
    let mut top_props: Vec<&(String, f64)> = props.iter().collect();
    top_props.sort_by(|left, right| ascending(right.1, left.1));
    let props_value: Map<String, Value> = top_props.into_iter().take(20).map(|(id, count)| (id.clone(), js::num(*count))).collect();
    let levels_value: Vec<Value> =
        levels.iter().map(|level| json!({ "index": level.index, "label": level.label, "cells": level.cells, "rooms": level.rooms })).collect();
    json!({
        "version": 2,
        "summary": text::capitalize(&summary),
        "features": sorted_features,
        "levels": levels_value,
        "width": maps.first().map_or(0, |map| map.width),
        "height": maps.first().map_or(0, |map| map.height),
        "floor_cells": js::num(floor_cells),
        "interior_share": js::num(js::round(interior_share * 100.0) / 100.0),
        "material": dominant_material,
        "doors": doors,
        "windows": windows,
        "props": props_value,
        "anchors": anchors,
    })
}

/// `importQuality(ground, stats)`: досягаема ли суша этажа входа и сколько
/// ассетов пришлось отбросить — `{ score, reachable, dropped, cells }`.
pub fn import_quality(ground: &TacticalMap, stats: &Stats) -> Value {
    let mut blocked: HashSet<Cell> = HashSet::new();
    for prop in &ground.props {
        if !prop.blocks_move || prop.mount.is_some() {
            continue;
        }
        blocked.extend(prop.footprint.iter().map(|point| (point.x, point.y)));
    }
    let party = ground.spawn_points.iter().find(|point| point.role == "party");
    let reached = party.map(|point| reachable_cells(ground, point.x, point.y, true, Some(&blocked))).unwrap_or_default();
    let mut land = 0usize;
    let mut reachable = 0usize;
    for y in 0..ground.height {
        for x in 0..ground.width {
            let Some(cell) = cell_at(ground, x, y) else { continue };
            if !cell.passable || cell.surface == "water" || blocked.contains(&(x, y)) {
                continue;
            }
            land += 1;
            if reached.contains(&(x, y)) {
                reachable += 1;
            }
        }
    }
    let reachable_share = if land > 0 { reachable as f64 / land as f64 } else { 0.0 };
    let instances = stat(stats, "instances");
    let dropped = 1f64.min((stat(stats, "unknown") + stat(stats, "propsSkipped")) / 1f64.max(if instances == 0.0 { 1.0 } else { instances }));
    let round = |value: f64| js::num(js::round(value * 100.0) / 100.0);
    json!({
        "score": round(reachable_share * (1.0 - 0.5f64.min(dropped))),
        "reachable": round(reachable_share),
        "dropped": round(dropped),
        "cells": land,
    })
}

/// Наибольший шаг между соседними клетками без лазания, в футах.
const IMPORT_STEP_FEET: i64 = 3;
/// Островок выше этой площади не замуровывается, даже если к нему нет подхода.
const SEALED_ISLAND_CELLS: usize = 8;

fn free_cell(map: &TacticalMap, x: i64, y: i64) -> bool {
    cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.surface != "water")
}

fn level_at(map: &TacticalMap, x: i64, y: i64) -> i64 {
    cell_at(map, x, y).map_or(0, |cell| cell.elevation)
}

fn edge_blocks_move(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> Result<bool> {
    Ok(edge_between(map, ax, ay, bx, by)?.is_some_and(|edge| edge.blocks_move))
}

/// `repairImportedLevel(map, stats)`: пандусы на перепадах без лестницы,
/// глухие высокие островки, предметы с крайних клеток — внутрь или прочь.
pub fn repair_imported_level(map: &mut TacticalMap, stats: &mut Stats) -> Result<()> {
    for _pass in 0..12 {
        let mut component: HashMap<Cell, usize> = HashMap::new();
        let mut components: Vec<Vec<Cell>> = Vec::new();
        for y in 0..map.height {
            for x in 0..map.width {
                if !free_cell(map, x, y) || component.contains_key(&(x, y)) {
                    continue;
                }
                let id = components.len();
                let mut queue = vec![(x, y)];
                component.insert((x, y), id);
                let mut index = 0;
                while index < queue.len() {
                    let (cx, cy) = queue[index];
                    index += 1;
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        let key = (cx + dx, cy + dy);
                        if component.contains_key(&key) || !free_cell(map, key.0, key.1) || (level_at(map, key.0, key.1) - level_at(map, cx, cy)).abs() > IMPORT_STEP_FEET {
                            continue;
                        }
                        if edge_blocks_move(map, cx, cy, key.0, key.1)? {
                            continue;
                        }
                        component.insert(key, id);
                        queue.push(key);
                    }
                }
                components.push(queue);
            }
        }
        if components.len() < 2 {
            break;
        }
        let largest = (0..components.len()).fold(0, |best, id| if components[id].len() > components[best].len() { id } else { best });
        let occupied: HashSet<Cell> = map.props.iter().flat_map(|prop| prop.footprint.iter().map(|point| (point.x, point.y))).collect();
        let mut changed = false;
        for (id, cells) in components.iter().enumerate() {
            if id == largest {
                continue;
            }
            let mut seam: Option<(Cell, Cell, i64)> = None;
            for &(x, y) in cells {
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let other = (x + dx, y + dy);
                    if !free_cell(map, other.0, other.1) || component.get(&other) == Some(&id) {
                        continue;
                    }
                    if edge_blocks_move(map, x, y, other.0, other.1)? {
                        continue;
                    }
                    let diff = (level_at(map, x, y) - level_at(map, other.0, other.1)).abs();
                    if seam.is_none_or(|(_, _, best)| diff < best) {
                        seam = Some(((x, y), other, diff));
                    }
                }
            }
            let Some((own, other, diff)) = seam else { continue };
            if diff <= IMPORT_STEP_FEET * 2 {
                let middle = js::round((level_at(map, own.0, own.1) + level_at(map, other.0, other.1)) as f64 / 2.0) as i64;
                // Пандус — на той стороне шва, где клетка свободна от предметов.
                if let Some(spot) = [other, own].into_iter().find(|point| !occupied.contains(point)) {
                    set_cell(map, spot.0, spot.1, &CellPatch { elevation: Some(middle), ..CellPatch::default() })?;
                    bump(stats, "ramps", 1.0);
                    changed = true;
                }
            } else if cells.len() <= SEALED_ISLAND_CELLS && !cells.iter().any(|cell| occupied.contains(cell)) {
                for &(x, y) in cells {
                    set_cell(map, x, y, &CellPatch { passable: Some(false), ..CellPatch::default() })?;
                }
                bump(stats, "sealedCells", cells.len() as f64);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // Предметы на крайних клетках: внутрь на клетку или прочь.
    let (width, height) = (map.width, map.height);
    let edge = |point: &Point| point.x <= 0 || point.y <= 0 || point.x >= width - 1 || point.y >= height - 1;
    let original = std::mem::take(&mut map.props);
    let mut alive = vec![true; original.len()];
    let mut items = original;
    for index in 0..items.len() {
        if items[index].transition.is_some() || !items[index].footprint.iter().any(edge) {
            continue;
        }
        let others: HashSet<Cell> = items
            .iter()
            .enumerate()
            .filter(|(other, _)| *other != index && alive[*other])
            .flat_map(|(_, prop)| prop.footprint.iter().map(|point| (point.x, point.y)))
            .collect();
        let footprint = &items[index].footprint;
        let shift_x = if footprint.iter().any(|point| point.x <= 0) {
            1
        } else if footprint.iter().any(|point| point.x >= width - 1) {
            -1
        } else {
            0
        };
        let shift_y = if footprint.iter().any(|point| point.y <= 0) {
            1
        } else if footprint.iter().any(|point| point.y >= height - 1) {
            -1
        } else {
            0
        };
        let moved: Vec<Point> = footprint.iter().map(|point| Point { x: point.x + shift_x, y: point.y + shift_y }).collect();
        // Свободу клетки проверяем по самой карте: предметы на ней не меняют клеток.
        if moved.iter().all(|point| !edge(point) && free_cell(map, point.x, point.y) && !others.contains(&(point.x, point.y))) {
            let prop = &mut items[index];
            prop.footprint = moved;
            prop.x += shift_x as f64;
            prop.y += shift_y as f64;
            bump(stats, "edgePropsMoved", 1.0);
        } else {
            alive[index] = false;
            bump(stats, "edgePropsDropped", 1.0);
        }
    }
    map.props = items.into_iter().zip(alive).filter_map(|(prop, keep)| keep.then_some(prop)).collect();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Урок 7: таблица проходит строгую проверку, а копия с опечаткой в
    /// ключевом поле строки — отказ, который называет файл и GUID.
    #[test]
    fn broken_copy_names_file_and_asset() {
        assert_eq!(check_talespire_asset_table(), Ok(()));
        let mut raw: Value = serde_json::from_str(ASSET_TABLE_SOURCE).expect("таблица");
        let assets = raw["assets"].as_object_mut().expect("ассеты");
        let id = assets.keys().nth(7).cloned().expect("строка");
        assets[&id][0] = json!("tile");
        let error = check_talespire_asset_text(&raw.to_string()).err().map(|error| error.to_string());
        assert_eq!(error, Some(format!("data/talespire-assets-v1.json: {id}: вид должен быть «t» или «p»")));
    }
}
