//! Память мест (`state.locationMaps`), ключи и сиды этажей, публичная память
//! приключения и поля библиотечной сцены — части
//! `server/adventure-director.mjs` без генерации карт.

use std::borrow::Cow;
use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

use serde_json::{Map, Value};
use sk_core::{js, text as jstext};
use sk_geometry::world_map::world_location_by_id;
use sk_tactical::tactical_map::SIZE_CLASSES;

use super::geometry::LibraryGeometry;
use super::{head16, integer, nullish, prop, public_text, tail, text, unique};

const MAP_CELL_TYPES: [&str; 4] = ["wall", "floor", "water", "door"];
const MAP_MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
const MAP_PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];

/// Судьба цели при переходе (`OBJECTIVE_STATUSES`). `continued` — цель
/// продолжается в новом месте (отряд пришёл туда, куда она звала); глава при
/// этом не растёт.
pub const OBJECTIVE_STATUSES: [&str; 4] = ["completed", "unresolved", "abandoned", "continued"];

/// `SIZE_CLASSES.region.maxCells`.
fn region_max_cells() -> usize {
    SIZE_CLASSES.iter().find(|(name, _)| *name == "region").map_or(10_000, |(_, class)| class.max_cells as usize)
}

/// `Number(value)` — безопасное целое (`Number.isSafeInteger`).
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer_number(value).then(|| js::number(value) as i64)
}

/// `normalizedSceneCells(value)`: клетки запомненной локации — массив либо
/// запись `{ cells }`. Повторы координат, мусор и поля вне словаря
/// отбрасываются; секреты клеток в запись не попадают.
pub(crate) fn normalized_scene_cells(value: Option<&Value>) -> Vec<Value> {
    kept_scene_cells(value).map(|(x, y, fields)| normalized_cell(&fields, x, y)).collect()
}

/// Исходные клетки, которые нормализация оставляет: объекты с целыми
/// координатами, без повторов, не больше `region.maxCells` исходных.
fn kept_scene_cells(value: Option<&Value>) -> impl Iterator<Item = (i64, i64, RawCellFields<'_>)> {
    let source: &[Value] = match value {
        Some(Value::Array(items)) => items,
        Some(Value::Object(map)) => match map.get("cells") {
            Some(Value::Array(items)) => items,
            _ => &[],
        },
        _ => &[],
    };
    let mut seen = CellSet::default();
    source.iter().take(region_max_cells()).filter_map(move |raw| {
        let Value::Object(raw) = raw else { return None };
        // Поля клетки — одним проходом, а не поиском по ключу на каждое поле.
        let mut fields = RawCellFields::default();
        for (key, value) in raw {
            fields.set(key, value);
        }
        let (Some(x), Some(y)) = (safe_integer(fields.x), safe_integer(fields.y)) else { return None };
        seen.insert((x, y)).then_some((x, y, fields))
    })
}

/// Значение поля нормализованной клетки.
enum CellValue<'a> {
    Int(i64),
    Bool(bool),
    Text(Cow<'a, str>),
}

impl CellValue<'_> {
    fn into_value(self) -> Value {
        match self {
            CellValue::Int(value) => Value::from(value),
            CellValue::Bool(value) => Value::Bool(value),
            CellValue::Text(text) => Value::String(text.into_owned()),
        }
    }

    /// То же значение JSON, что дал бы [`CellValue::into_value`].
    fn matches(&self, value: &Value) -> bool {
        match (self, value) {
            (CellValue::Int(expected), Value::Number(number)) => !number.is_f64() && number.as_i64() == Some(*expected),
            (CellValue::Bool(expected), Value::Bool(actual)) => expected == actual,
            (CellValue::Text(expected), Value::String(actual)) => expected.as_ref() == actual.as_str(),
            _ => false,
        }
    }
}

/// Поля нормализованной клетки в порядке записи; `None` — поля нет.
type NormalizedCellFields<'a> = [(&'static str, Option<CellValue<'a>>); 13];

/// Нормализация одной клетки (`normalizedSceneCells`, тело цикла).
fn normalized_cell_fields<'a>(fields: &RawCellFields<'a>, x: i64, y: i64) -> NormalizedCellFields<'a> {
    let text_of = |value: Option<&'a Value>, allowed: &[&str]| -> Option<CellValue<'a>> {
        let Some(Value::String(text)) = value else { return None };
        allowed.contains(&text.as_str()).then(|| CellValue::Text(Cow::Borrowed(text.as_str())))
    };
    let feature = match fields.feature {
        Some(Value::String(feature)) => {
            let trimmed = jstext::trim(feature);
            if trimmed.is_empty() {
                None
            } else if trimmed.encode_utf16().count() <= 40 {
                Some(CellValue::Text(Cow::Borrowed(trimmed)))
            } else {
                Some(CellValue::Text(Cow::Owned(head16(trimmed, 40))))
            }
        }
        _ => None,
    };
    let mask = match fields.edge_mask {
        // `/^[nesw]{0,4}$/u.test(mask)` без движка регулярных выражений.
        Some(Value::String(mask)) if is_edge_mask(mask) => Some(CellValue::Text(Cow::Borrowed(mask.as_str()))),
        _ => None,
    };
    [
        ("x", Some(CellValue::Int(x))),
        ("y", Some(CellValue::Int(y))),
        ("type", Some(CellValue::Text(listed_text(fields.kind, &MAP_CELL_TYPES).unwrap_or(Cow::Borrowed("floor"))))),
        ("revealed", Some(CellValue::Bool(js::is_true(fields.revealed)))),
        ("feature", feature),
        ("material", listed_text(fields.material, &MAP_MATERIALS).map(CellValue::Text)),
        ("variant", safe_integer(fields.variant).map(|variant| CellValue::Int(variant.clamp(0, 5)))),
        ("pattern", listed_text(fields.pattern, &MAP_PATTERNS).map(CellValue::Text)),
        ("edge_mask", mask),
        // Тонкие стены, окна и сторона двери (`legacyCellsFromTacticalMap`):
        // без них запомненная локация вернулась бы домом без перегородок.
        ("walls", text_of(fields.walls, &["e", "s", "es"])),
        ("windows", text_of(fields.windows, &["e", "s", "es"])),
        ("door_dir", text_of(fields.door_dir, &["e", "s"])),
        // Высота помоста и холмов: без неё вернувшийся отряд стоял бы на ровном полу.
        ("elevation", safe_integer(fields.elevation).filter(|elevation| *elevation != 0).map(|elevation| CellValue::Int(elevation.clamp(-100, 100)))),
    ]
}

fn normalized_cell(fields: &RawCellFields, x: i64, y: i64) -> Value {
    let normalized = normalized_cell_fields(fields, x, y);
    let mut cell = Map::with_capacity(normalized.iter().filter(|(_, value)| value.is_some()).count());
    for (key, value) in normalized {
        if let Some(value) = value {
            cell.insert(key.into(), value.into_value());
        }
    }
    Value::Object(cell)
}

/// Клетка `cell` — ровно та, что дала бы нормализация (поля, порядок, значения).
fn cell_matches(cell: &Value, expected: &NormalizedCellFields) -> bool {
    let Value::Object(cell) = cell else { return false };
    let mut actual = cell.iter();
    for (key, value) in expected {
        let Some(value) = value else { continue };
        match actual.next() {
            Some((name, got)) if name == key && value.matches(got) => {}
            _ => return false,
        }
    }
    actual.next().is_none()
}

/// Равенство JSON с порядком ключей и видом чисел — то, что одинаково
/// печатается (`PartialEq` у `Map` порядок не учитывает).
fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => left.len() == right.len() && left.iter().zip(right).all(|((left_key, left), (right_key, right))| left_key == right_key && same_json(left, right)),
        (Value::Array(left), Value::Array(right)) => left.len() == right.len() && left.iter().zip(right).all(|(left, right)| same_json(left, right)),
        (Value::Number(left), Value::Number(right)) if left.is_f64() && right.is_f64() => left.as_f64().map(f64::to_bits) == right.as_f64().map(f64::to_bits),
        _ => left == right,
    }
}

/// Запись `existing` совпадает с `sceneMapRecord(cells, map)`: та же версия,
/// те же нормализованные клетки и та же карта. Проверка без сборки записи.
fn scene_map_record_matches(existing: &Value, cells: Option<&Value>, map: Option<&Value>) -> bool {
    let Value::Object(record) = existing else { return false };
    let mut fields = record.iter();
    match fields.next() {
        Some((key, Value::Number(version))) if key == "version" && !version.is_f64() && version.as_i64() == Some(1) => {}
        _ => return false,
    }
    let Some((key, Value::Array(stored))) = fields.next() else { return false };
    if key != "cells" || stored.is_empty() {
        return false;
    }
    let mut stored = stored.iter();
    for (x, y, raw) in kept_scene_cells(cells) {
        match stored.next() {
            Some(cell) if cell_matches(cell, &normalized_cell_fields(&raw, x, y)) => {}
            _ => return false,
        }
    }
    if stored.next().is_some() {
        return false;
    }
    let source = match map {
        None => match cells {
            Some(Value::Object(record)) => record.get("map"),
            _ => None,
        },
        some => some,
    };
    match source {
        Some(source @ Value::Object(_)) => matches!(fields.next(), Some((key, stored)) if key == "map" && same_json(stored, source)) && fields.next().is_none(),
        _ => fields.next().is_none(),
    }
}

/// Поля исходной клетки, которые читает [`normalized_scene_cells`]
/// (`raw.get(key)` для каждого).
#[derive(Default)]
struct RawCellFields<'a> {
    x: Option<&'a Value>,
    y: Option<&'a Value>,
    kind: Option<&'a Value>,
    revealed: Option<&'a Value>,
    feature: Option<&'a Value>,
    material: Option<&'a Value>,
    variant: Option<&'a Value>,
    pattern: Option<&'a Value>,
    edge_mask: Option<&'a Value>,
    walls: Option<&'a Value>,
    windows: Option<&'a Value>,
    door_dir: Option<&'a Value>,
    elevation: Option<&'a Value>,
}

impl<'a> RawCellFields<'a> {
    fn set(&mut self, key: &str, value: &'a Value) {
        let slot = match key {
            "x" => &mut self.x,
            "y" => &mut self.y,
            "type" => &mut self.kind,
            "revealed" => &mut self.revealed,
            "feature" => &mut self.feature,
            "material" => &mut self.material,
            "variant" => &mut self.variant,
            "pattern" => &mut self.pattern,
            "edge_mask" => &mut self.edge_mask,
            "walls" => &mut self.walls,
            "windows" => &mut self.windows,
            "door_dir" => &mut self.door_dir,
            "elevation" => &mut self.elevation,
            _ => return,
        };
        *slot = Some(value);
    }
}

/// `String(value)`, если оно из списка `allowed`, иначе `None`. Строка
/// берётся без копии; иные значения приводятся как в JS
/// (`String(['wall'])` — тоже `wall`).
fn listed_text<'a>(value: Option<&'a Value>, allowed: &[&str]) -> Option<Cow<'a, str>> {
    match value {
        Some(Value::String(text)) => allowed.contains(&text.as_str()).then_some(Cow::Borrowed(text.as_str())),
        other => {
            let text = js::string(other);
            allowed.contains(&text.as_str()).then_some(Cow::Owned(text))
        }
    }
}

/// Множество координат клеток с дешёвым хешем: ключи — пары целых, защита от
/// подобранных коллизий здесь не нужна.
type CellSet = HashSet<(i64, i64), BuildHasherDefault<CellHasher>>;

#[derive(Default)]
struct CellHasher(u64);

impl Hasher for CellHasher {
    fn finish(&self) -> u64 {
        // Старшие, хорошо перемешанные биты — и в младшие (по ним выбирается корзина).
        self.0 ^ (self.0 >> 32)
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.write_u64(u64::from(*byte));
        }
    }

    fn write_i64(&mut self, value: i64) {
        self.write_u64(value as u64);
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

/// `sceneMapRecord(value, map)`: запись запомненной локации `{ version: 1,
/// cells, map? }`. `map`: `None` — аргумент не передан (`undefined`), тогда
/// карта берётся из самой записи; `Some(_)` — переданное значение, в том числе
/// `null`. Сериализованная карта необязательна: сохранения до этапа L3 несут
/// только клетки.
pub(crate) fn scene_map_record(value: Option<&Value>, map: Option<&Value>) -> Option<Value> {
    let cells = normalized_scene_cells(value);
    if cells.is_empty() {
        return None;
    }
    let source = match map {
        None => match value {
            Some(Value::Object(record)) => record.get("map"),
            _ => None,
        },
        some => some,
    };
    let mut record = Map::new();
    record.insert("version".into(), Value::from(1));
    record.insert("cells".into(), Value::Array(cells));
    if let Some(source @ Value::Object(_)) = source {
        record.insert("map".into(), source.clone());
    }
    Some(Value::Object(record))
}

/// `normalizeLocationMaps(value)`: индекс тактических карт мест — не больше
/// ста записей, ключ — не длиннее 120 символов, негодные записи выпадают.
pub fn normalize_location_maps(value: Option<&Value>) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(Value::Object(entries)) = value else { return result };
    for (location_id, raw) in js::entries(entries).into_iter().take(100) {
        let id = text(Some(&Value::String(location_id.clone())), 120, "");
        if id.is_empty() {
            continue;
        }
        if let Some(record) = scene_map_record(Some(raw), None) {
            result.insert(id, record);
        }
    }
    result
}

/// Число, которое нормализация клетки (`safe_integer` → `Value::from(i64)`)
/// записала бы тем же значением JSON: целое без дробной записи в пределах
/// безопасных целых JS.
fn exact_integer(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else { return None };
    if number.is_f64() {
        return None;
    }
    number.as_i64().filter(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
}

/// `/^[nesw]{0,4}$/u`: до четырёх букв сторон света и ничего больше.
fn is_edge_mask(mask: &str) -> bool {
    mask.len() <= 4 && mask.bytes().all(|side| matches!(side, b'n' | b'e' | b's' | b'w'))
}

/// Необязательные поля клетки в порядке [`normalized_scene_cells`].
const OPTIONAL_CELL_FIELDS: [&str; 9] = ["feature", "material", "variant", "pattern", "edge_mask", "walls", "windows", "door_dir", "elevation"];

/// Клетка уже в виде [`normalized_scene_cells`]: нормализация вернула бы её
/// без изменений (те же поля в том же порядке и те же значения). Проверка
/// строже нормализации: сомнительное значение — «нет», и тогда клетка
/// нормализуется как обычно.
fn is_normalized_scene_cell(raw: &Value, seen: &mut CellSet) -> bool {
    let Value::Object(cell) = raw else { return false };
    let mut fields = cell.iter();
    let mut next = |key: &str| fields.next().filter(|(name, _)| name.as_str() == key).map(|(_, value)| value);
    let (Some(x), Some(y)) = (next("x").and_then(exact_integer), next("y").and_then(exact_integer)) else { return false };
    if !matches!(next("type"), Some(Value::String(kind)) if MAP_CELL_TYPES.contains(&kind.as_str())) {
        return false;
    }
    if !matches!(next("revealed"), Some(Value::Bool(_))) {
        return false;
    }
    let mut cursor = 0;
    for (name, value) in fields {
        let Some(offset) = OPTIONAL_CELL_FIELDS[cursor..].iter().position(|field| field == name) else { return false };
        let field = OPTIONAL_CELL_FIELDS[cursor + offset];
        cursor += offset + 1;
        let valid = match (field, value) {
            ("feature", Value::String(feature)) => !feature.is_empty() && jstext::trim(feature) == feature.as_str() && feature.encode_utf16().count() <= 40,
            ("material", Value::String(material)) => MAP_MATERIALS.contains(&material.as_str()),
            ("variant", variant) => exact_integer(variant).is_some_and(|variant| (0..=5).contains(&variant)),
            ("pattern", Value::String(pattern)) => MAP_PATTERNS.contains(&pattern.as_str()),
            ("edge_mask", Value::String(mask)) => is_edge_mask(mask),
            ("walls" | "windows", Value::String(sides)) => matches!(sides.as_str(), "e" | "s" | "es"),
            ("door_dir", Value::String(door)) => door == "e" || door == "s",
            ("elevation", elevation) => exact_integer(elevation).is_some_and(|elevation| elevation != 0 && (-100..=100).contains(&elevation)),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    seen.insert((x, y))
}

/// Запись места уже в виде `sceneMapRecord(record)`: `{ version: 1, cells,
/// map? }` с нормализованными клетками без повторов.
fn is_normalized_scene_map_record(raw: &Value) -> bool {
    let Value::Object(record) = raw else { return false };
    let mut fields = record.iter();
    if !matches!(fields.next(), Some((key, version)) if key == "version" && exact_integer(version) == Some(1)) {
        return false;
    }
    let Some((key, Value::Array(cells))) = fields.next() else { return false };
    if key != "cells" || cells.is_empty() || cells.len() > region_max_cells() {
        return false;
    }
    match fields.next() {
        None => {}
        Some((key, Value::Object(_))) if key == "map" => {
            if fields.next().is_some() {
                return false;
            }
        }
        Some(_) => return false,
    }
    let mut seen = CellSet::with_capacity_and_hasher(cells.len(), Default::default());
    cells.iter().all(|cell| is_normalized_scene_cell(cell, &mut seen))
}

/// Ключ места, который `normalizeLocationMaps` оставил бы тем же и на том же
/// месте (не индекс массива — их `Object.entries` выводит первыми).
fn is_normalized_location_key(key: &str) -> bool {
    !key.is_empty() && !js::is_array_index_key(key) && text(Some(&Value::String(key.to_string())), 120, "") == key
}

/// [`normalize_location_maps`] для своего значения. Уже нормализованный
/// индекс (так он лежит в состоянии после нормализации) возвращается как
/// есть, без пересборки клеток; иной — нормализуется обычным путём.
/// Результат совпадает с `normalize_location_maps(Some(&value))`.
pub fn normalize_location_maps_owned(value: Value) -> Map<String, Value> {
    normalize_location_maps_checked(value).0
}

/// [`normalize_location_maps_owned`] и признак «вход уже был нормализован»
/// (результат совпал со входом). Тогда и повторная нормализация результата —
/// он сам: [`remember_current_scene_map_normalized`] её пропускает.
pub fn normalize_location_maps_checked(value: Value) -> (Map<String, Value>, bool) {
    let Value::Object(entries) = value else { return (Map::new(), false) };
    if entries.len() <= 100 && entries.iter().all(|(key, record)| is_normalized_location_key(key) && is_normalized_scene_map_record(record)) {
        return (entries, true);
    }
    (normalize_location_maps(Some(&Value::Object(entries))), false)
}

/// `sceneMapForLocation(locationMaps, locationId)`: клетки запомненного места
/// или `None`.
pub fn scene_map_for_location(location_maps: Option<&Value>, location_id: Option<&Value>) -> Option<Vec<Value>> {
    let id = text(location_id, 120, "");
    if id.is_empty() {
        return None;
    }
    let record = scene_map_record(prop(location_maps, &id), None)?;
    match record {
        Value::Object(mut record) => match record.shift_remove("cells") {
            Some(Value::Array(cells)) => Some(cells),
            _ => None,
        },
        _ => None,
    }
}

/// `sceneTacticalMapForLocation(locationMaps, locationId)`: сериализованная
/// карта запомненного этажа, если она законсервирована; сохранения до L3 —
/// `None`. Клетки записи намеренно не нормализуются: карта самодостаточна.
pub fn scene_tactical_map_for_location(location_maps: Option<&Value>, location_id: Option<&Value>) -> Option<Value> {
    let id = text(location_id, 120, "");
    if id.is_empty() {
        return None;
    }
    let record @ Value::Object(_) = prop(location_maps, &id)? else { return None };
    match record.get("map") {
        Some(map @ Value::Object(_)) => Some(map.clone()),
        _ => None,
    }
}

/// `sceneLocationId(state)`: место сцены — явный идентификатор, текущее место
/// карты мира или место карты мира с тем же именем.
pub fn scene_location_id(state: &Value) -> String {
    let scene = prop(Some(state), "scene");
    let direct = public_text(nullish(prop(scene, "location_id"), prop(scene, "locationId")), 120, "");
    if !direct.is_empty() {
        return direct;
    }
    let world_map = prop(Some(state), "worldMap");
    let current = public_text(prop(world_map, "currentLocationId"), 120, "");
    if !current.is_empty() {
        return current;
    }
    let expected = jstext::lower(&public_text(prop(scene, "location"), 120, ""));
    if expected.is_empty() {
        return String::new();
    }
    let locations: &[Value] = match prop(world_map, "locations") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let found = locations.iter().find(|location| jstext::lower(&public_text(prop(Some(location), "name"), 120, "")) == expected);
    public_text(found.and_then(|location| prop(Some(location), "id")), 120, "")
}

/// `rememberSceneMap(state, locationId, cells, map)`: запись места в
/// `state.locationMaps`. `map`: `None` — аргумент не передан. Состояние —
/// объект; у иного значения JS бросил бы `TypeError` на присваивании, здесь
/// оно не меняется.
pub fn remember_scene_map(state: &mut Value, location_id: Option<&Value>, cells: Option<&Value>, map: Option<&Value>) {
    let id = public_text(location_id, 120, "");
    let record = scene_map_record(cells, map);
    store_scene_map_record(state, id, record, false);
}

/// Хвост `rememberSceneMap`: запись `record` под ключом `id` в заново
/// нормализованный `state.locationMaps`. Индекс вынимается из состояния и
/// нормализуется без копии ([`normalize_location_maps_owned`]): он всё равно
/// заменяется целиком.
fn store_scene_map_record(state: &mut Value, id: String, record: Option<Value>, maps_normalized: bool) {
    let (false, Some(record)) = (id.is_empty(), record) else { return };
    let Value::Object(fields) = state else { return };
    let current = fields.get_mut("locationMaps").map(std::mem::take).unwrap_or(Value::Null);
    let mut maps = match current {
        Value::Object(entries) if maps_normalized => entries,
        other => normalize_location_maps_owned(other),
    };
    maps.insert(id, record);
    fields.insert("locationMaps".into(), Value::Object(maps));
}

/// `sceneLevelIndex(state)`: номер активного этажа; сцена без поля `level` —
/// этаж входа.
pub fn scene_level_index(state: &Value) -> i64 {
    let index = prop(prop(prop(Some(state), "scene"), "level"), "index");
    safe_integer(index).unwrap_or(0)
}

/// `rememberCurrentSceneMap(state)`: текущая карта сцены — в память места под
/// ключом места и этажа.
pub fn remember_current_scene_map(state: &mut Value) {
    remember_current_scene_map_with(state, false);
}

/// [`remember_current_scene_map`] сразу после нормализации памяти мест, когда
/// [`normalize_location_maps_checked`] сказал, что индекс уже был
/// нормализован и с тех пор не менялся: повторная нормализация индекса
/// вернула бы его же, и её можно не проверять.
pub fn remember_current_scene_map_normalized(state: &mut Value) {
    remember_current_scene_map_with(state, true);
}

fn remember_current_scene_map_with(state: &mut Value, maps_normalized: bool) {
    let scene = prop(Some(state), "scene");
    let cells = match prop(scene, "cells") {
        Some(cells @ Value::Array(items)) if !items.is_empty() => cells,
        _ => return,
    };
    let key = level_key(&scene_location_id(state), scene_level_index(state));
    let id = public_text(Some(&Value::String(key)), 120, "");
    // Без клеток запись пуста (`sceneMapRecord` — `null`): индекс не трогается.
    if id.is_empty() || kept_scene_cells(Some(cells)).next().is_none() {
        return;
    }
    let Value::Object(fields) = state else { return };
    let current = fields.get_mut("locationMaps").map(std::mem::take).unwrap_or(Value::Null);
    let mut maps = match current {
        Value::Object(entries) if maps_normalized => entries,
        other => normalize_location_maps_owned(other),
    };
    // Запись собирается из клеток и карты сцены по ссылке — без их копии. Та
    // же самая запись под этим ключом (сцена с прошлого раза не менялась)
    // остаётся на месте: замена её равной ничего бы не изменила.
    let scene = fields.get("scene");
    let (cells, map) = (prop(scene, "cells"), prop(scene, "map"));
    let unchanged = maps.get(&id).is_some_and(|existing| scene_map_record_matches(existing, cells, map));
    if !unchanged {
        if let Some(record) = scene_map_record(cells, map) {
            maps.insert(id, record);
        }
    }
    fields.insert("locationMaps".into(), Value::Object(maps));
}

/// `levelKey(locationId, level)` для рыхлых аргументов: `None` — аргумент не
/// передан.
pub fn level_key_js(location_id: Option<&Value>, level: Option<&Value>) -> String {
    let safe_level = match level {
        None => 0,
        some => safe_integer(some).unwrap_or(0),
    };
    let base = public_text(location_id, 120, "");
    if base.is_empty() || safe_level == 0 {
        return base;
    }
    let suffix = format!("@L{safe_level}");
    format!("{}{suffix}", head16(&base, 120usize.saturating_sub(suffix.len())))
}

/// `levelKey(locationId, level)`: ключ этажа в `state.locationMaps`. Этаж
/// входа — прежний ключ без суффикса; место под суффикс отводится заранее,
/// чтобы обрезка до 120 символов не съела номер этажа.
pub fn level_key(location_id: &str, level: i64) -> String {
    level_key_js(Some(&Value::String(location_id.to_string())), Some(&Value::from(level)))
}

/// `levelSeed(baseSeed, level)` для рыхлых аргументов.
pub fn level_seed_js(base_seed: Option<&Value>, level: Option<&Value>) -> String {
    let safe_level = match level {
        None => 0,
        some => safe_integer(some).unwrap_or(0),
    };
    let base = public_text(base_seed, 180, "location-map");
    if safe_level == 0 {
        base
    } else {
        format!("{base}@L{safe_level}")
    }
}

/// `levelSeed(baseSeed, level)`: сид этажа, выведенный из сида места.
pub fn level_seed(base_seed: &str, level: i64) -> String {
    level_seed_js(Some(&Value::String(base_seed.to_string())), Some(&Value::from(level)))
}

/// `knownWorldKind(worldMap, locationId, location)`: вид точки карты мира,
/// которая там **уже была**; пусто — место новое.
pub fn known_world_kind(world_map: Option<&Value>, location_id: Option<&Value>, location: Option<&Value>) -> String {
    let locations: &[Value] = match prop(world_map, "locations") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let wanted = jstext::lower(&text(location, 180, ""));
    let node = world_location_by_id(world_map, &js::s(location_id))
        .or_else(|| locations.iter().find(|candidate| jstext::lower(&text(prop(Some(candidate), "name"), 180, "")) == wanted));
    text(prop(node, "kind"), 40, "")
}

/// `stableLocationMapSeed(worldMap, locationId, location)`.
pub fn stable_location_map_seed(world_map: Option<&Value>, location_id: Option<&Value>, location: Option<&Value>) -> String {
    let campaign_seed = public_text(prop(world_map, "seed"), 120, "campaign");
    let location_fallback = public_text(location, 120, "location");
    let stable_id = public_text(location_id, 120, &location_fallback);
    format!("location-map:v1:{campaign_seed}:{stable_id}")
}

/// `publicTextList(value, maximum, limit)`.
fn public_text_list(value: Option<&Value>, maximum: usize, limit: usize) -> Vec<String> {
    let items: &[Value] = match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let texts = items.iter().filter(|item| item.is_string()).map(|item| text(Some(item), maximum, "")).filter(|item| !item.is_empty());
    tail(unique(texts), limit)
}

fn objective_status(value: Option<&Value>) -> Option<&'static str> {
    let Some(Value::String(status)) = value else { return None };
    OBJECTIVE_STATUSES.iter().copied().find(|known| known == status)
}

/// `publicHistoryEntry(value)`.
fn public_history_entry(value: &Value) -> Option<Value> {
    let Value::Object(_) = value else { return None };
    let value = Some(value);
    let mut entry = Map::new();
    entry.insert("chapter".into(), Value::from(integer(prop(value, "chapter"), 1, 1, 999)));
    entry.insert("title".into(), Value::String(public_text(prop(value, "title"), 80, "Предыдущая сцена")));
    entry.insert("location".into(), Value::String(public_text(prop(value, "location"), 120, "")));
    let location_id = public_text(nullish(prop(value, "location_id"), prop(value, "locationId")), 120, "");
    if !location_id.is_empty() {
        entry.insert("location_id".into(), Value::String(location_id));
    }
    entry.insert("objective".into(), Value::String(public_text(prop(value, "objective"), 160, "")));
    entry.insert("outcome".into(), Value::String(public_text(prop(value, "outcome"), 240, "")));
    if let Some(status) = objective_status(prop(value, "status")) {
        entry.insert("status".into(), Value::String(status.into()));
    }
    Some(Value::Object(entry))
}

/// `publicAdventureMemory(value)`: единственная форма памяти приключения,
/// которая попадает в публичное `SceneAdvanced`. Частные и мастерские поля
/// остаются на сервере и в перенос не копируются.
pub fn public_adventure_memory(value: Option<&Value>) -> Map<String, Value> {
    let source = match value {
        Some(source @ Value::Object(_)) => Some(source),
        _ => None,
    };
    let mut memory = Map::new();
    memory.insert("chapter".into(), Value::from(integer(prop(source, "chapter"), 1, 1, 999)));
    let current_hook = public_text(prop(source, "currentHook"), 240, "");
    if !current_hook.is_empty() {
        memory.insert("currentHook".into(), Value::String(current_hook));
    }
    let last_transition = public_text(prop(source, "lastTransition"), 500, "");
    if !last_transition.is_empty() {
        memory.insert("lastTransition".into(), Value::String(last_transition));
    }
    memory.insert("unresolvedThreads".into(), js::strings_value(public_text_list(prop(source, "unresolvedThreads"), 240, 20)));
    memory.insert("visitedLocations".into(), js::strings_value(public_text_list(prop(source, "visitedLocations"), 120, 50)));
    memory.insert("visitedLocationIds".into(), js::strings_value(public_text_list(prop(source, "visitedLocationIds"), 120, 50)));
    let history: Vec<Value> = match prop(source, "history") {
        Some(Value::Array(items)) => items.iter().filter_map(public_history_entry).collect(),
        _ => Vec::new(),
    };
    memory.insert("history".into(), Value::Array(tail(history, 20)));
    memory
}

/// `librarySceneFields(library)`: поля сцены от библиотечной карты — этажи,
/// источник с автором и лицензией, паспорт места словами.
pub fn library_scene_fields(library: &LibraryGeometry) -> Map<String, Value> {
    let entry = Some(&library.entry);
    let source = prop(entry, "source");
    let mut fields = Map::new();
    if !library.levels.is_empty() {
        let levels = library
            .levels
            .iter()
            .map(|level| {
                let mut item = Map::new();
                item.insert("offset".into(), js::num(level.index));
                item.insert("hint".into(), Value::String(String::new()));
                item.insert("label".into(), Value::String(level.label.clone()));
                Value::Object(item)
            })
            .collect();
        fields.insert("levels".into(), Value::Array(levels));
    }
    let mut map_source = Map::new();
    map_source.insert("kind".into(), Value::String("map-library".into()));
    // `id: entry.id`: у записи без поля его нет и в JSON.
    if let Some(id) = prop(entry, "id") {
        map_source.insert("id".into(), id.clone());
    }
    map_source.insert("title".into(), Value::String(text(prop(entry, "title"), 160, "")));
    map_source.insert("author".into(), Value::String(text(prop(source, "author"), 120, "")));
    map_source.insert("url".into(), Value::String(text(prop(source, "url"), 300, "")));
    map_source.insert("license".into(), Value::String(text(prop(source, "license"), 120, "")));
    map_source.insert("license_url".into(), Value::String(text(prop(source, "license_url"), 300, "")));
    map_source.insert("site".into(), Value::String(text(prop(source, "site"), 80, "")));
    fields.insert("map_source".into(), Value::Object(map_source));
    fields.insert("layout".into(), Value::String(text(prop(prop(entry, "passport"), "summary"), 400, "")));
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn level_key_keeps_room_for_suffix() {
        let long = "я".repeat(130);
        let key = level_key(&long, -2);
        assert_eq!(key.chars().count(), 120);
        assert!(key.ends_with("@L-2"));
        assert_eq!(level_key("hall", 0), "hall");
        assert_eq!(level_key("  hall  ", 1), "hall@L1");
        assert_eq!(level_key_js(Some(&json!(5)), Some(&json!(1))), "");
        assert_eq!(level_key_js(Some(&json!("a")), Some(&json!("2"))), "a@L2");
        assert_eq!(level_key_js(Some(&json!("a")), Some(&json!(1.5))), "a");
    }

    #[test]
    fn level_seed_defaults() {
        assert_eq!(level_seed("", 0), "location-map");
        assert_eq!(level_seed("base", -1), "base@L-1");
        assert_eq!(level_seed_js(Some(&json!(7)), None), "location-map");
    }

    #[test]
    fn normalized_cells_drop_secrets_and_duplicates() {
        let cells = normalized_scene_cells(Some(&json!([
            { "x": 1, "y": 1, "type": "floor", "secret": "S", "variant": 9, "elevation": 500, "walls": "es", "door_dir": "n" },
            { "x": "1", "y": 1, "type": "wall" },
            { "x": 2.5, "y": 1 },
            null,
            { "x": 0, "y": 0, "type": "lava", "feature": "  altar  ", "edge_mask": "nesw", "variant": null, "elevation": -0.0 },
        ])));
        assert_eq!(
            js::stringify(&Value::Array(cells)),
            r#"[{"x":1,"y":1,"type":"floor","revealed":false,"variant":5,"walls":"es","elevation":100},{"x":0,"y":0,"type":"floor","revealed":false,"feature":"altar","variant":0,"edge_mask":"nesw"}]"#
        );
    }

    /// Не больше ста записей в порядке `Object.entries`: ключи-индексы первыми.
    #[test]
    fn location_maps_keep_first_hundred_entries() {
        let mut maps = Map::new();
        for index in 0..101 {
            maps.insert(format!("place-{index}"), json!({ "cells": [{ "x": 0, "y": 0 }] }));
        }
        maps.insert("7".into(), json!({ "cells": [{ "x": 1, "y": 1 }] }));
        let normalized = normalize_location_maps(Some(&Value::Object(maps)));
        assert_eq!(normalized.len(), 100);
        assert!(normalized.contains_key("7"), "ключ-индекс идёт первым");
        assert!(normalized.contains_key("place-98") && !normalized.contains_key("place-99"));
    }

    #[test]
    fn remember_and_read_location_map() {
        let mut state = json!({ "scene": { "location_id": "hall", "level": { "index": 1 }, "cells": [{ "x": 0, "y": 0 }], "map": { "seed": "s" } } });
        remember_current_scene_map(&mut state);
        assert_eq!(state["locationMaps"]["hall@L1"]["map"], json!({ "seed": "s" }));
        assert_eq!(scene_map_for_location(state.get("locationMaps"), Some(&json!("hall@L1"))).map(|cells| cells.len()), Some(1));
        assert_eq!(scene_tactical_map_for_location(state.get("locationMaps"), Some(&json!(" hall@L1 "))), Some(json!({ "seed": "s" })));
        assert_eq!(scene_tactical_map_for_location(state.get("locationMaps"), Some(&json!("hall"))), None);
    }

    #[test]
    fn adventure_memory_is_public_only() {
        let memory = public_adventure_memory(Some(&json!({
            "chapter": "3", "currentHook": " нить ", "gm_only": "SECRET",
            "visitedLocations": ["А", "А", 5, " Б "],
            "history": [{ "chapter": 0, "title": "", "status": "lost", "gm_only": "SECRET" }, null],
        })));
        assert_eq!(
            js::stringify(&Value::Object(memory)),
            r#"{"chapter":3,"currentHook":"нить","unresolvedThreads":[],"visitedLocations":["А","Б"],"visitedLocationIds":[],"history":[{"chapter":1,"title":"Предыдущая сцена","location":"","objective":"","outcome":""}]}"#
        );
    }
}
