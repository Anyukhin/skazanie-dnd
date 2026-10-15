//! Перенос `server/map-library.mjs` — библиотека готовых карт: импортированные
//! из TaleSpire постройки, из которых генератор сцены сам выбирает карту под
//! новую локацию.
//!
//! Где живёт. `<storage>/map-library/`: `index.json` — паспорта и метаданные,
//! `maps/<id>.json` — этажи. Это данные владельца, а не исходники проекта.
//! Формат файлов — байт в байт как у JS (`JSON.stringify(value) + "\n"`):
//! Rust читает библиотеку, записанную JS, и наоборот.
//!
//! Как выбирает. [`library_request_for`] переводит заявку сцены в требования,
//! [`choose_library_map`] отбирает подходящие записи: вид места обязан
//! совпасть, климат не спорит, уже использованная карта не повторяется,
//! уличной сцене нужна площадь, обещанное сценой сверяется с якорями карты,
//! карта ниже [`MIN_LIBRARY_SCORE`] не берётся; из лучших — по сиду места.
//! [`MapLibrary::pick`] берёт запись, только если исправны все её этажи
//! ([`library_level_problems`]) и этаж входа держит программу сцены
//! (проверка `check` вызывающего).
//!
//! Записи и этажи — рыхлый JSON той же формы, что у JS (`serde_json::Value`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js, re, text};
use sk_map_core::map_quality::audit_tactical_map;
use sk_scene_base::scene_requirements::{anchor_counts_for, anchor_coverage, normalize_scene_requirements, required_program_kinds, Requirement};
use sk_tactical::tactical_map::{deserialize_tactical_map, TacticalMap, TacticalSpawnPoint};

use sk_core::v8math::{log10, log2};

pub const MAP_LIBRARY_DIR: &str = "map-library";
pub const MAP_LIBRARY_SCHEMA_VERSION: i64 = 1;
pub const LIBRARY_SEED_PREFIX: &str = "library:";

/// Нижний порог очков. Совпавший основной вид места даёт 10; карта ниже
/// порога хуже процедурной, и сцену строит генератор.
pub const MIN_LIBRARY_SCORE: f64 = 7.0;

/// Нижняя оценка качества импорта (`passport.quality.score`): карта ниже —
/// только для ручного `ImportLocationMap` ведущего, не для автоподбора.
pub const MIN_LIBRARY_QUALITY: f64 = 0.6;

/// Сколько очков снимает каждый обещанный сценой объект, которого на карте нет.
const MISSING_REQUIREMENT_PENALTY: f64 = 3.0;
/// Сколько очков даёт каждый обязательный якорь программы, который на карте есть.
const REQUIRED_ANCHOR_BONUS: f64 = 3.0;
/// Доля обязательных якорей программы, без которой карта не выбирается вовсе.
const REQUIRED_ANCHOR_SHARE: f64 = 0.6;
/// Сколько кандидатов перебирает подбор, прежде чем уступить генератору.
const LIBRARY_PICK_ATTEMPTS: usize = 6;

/// Изъяны карты этажа входа, с которыми сцену не начать.
const LIBRARY_BLOCKING_PROBLEMS: [&str; 7] =
    ["NO_PARTY_SPAWN", "PARTY_SPAWN_BLOCKED", "UNREACHABLE_FLOOR", "PROP_OUT_OF_BOUNDS", "PROP_ON_SOLID_CELL", "DOOR_TO_NOWHERE", "BUILDING_WITHOUT_EXIT"];

/// Те же изъяны для этажа выше или ниже входа: проверка идёт от обратной
/// лестницы. `BUILDING_WITHOUT_EXIT` и `UNREACHABLE_FLOOR` здесь нет намеренно.
const LIBRARY_UPPER_BLOCKING_PROBLEMS: [&str; 4] = ["PARTY_SPAWN_BLOCKED", "PROP_OUT_OF_BOUNDS", "PROP_ON_SOLID_CELL", "DOOR_TO_NOWHERE"];

/// Типы мест TalesTavern → наш вид места (слаги `slab-type` / `slab-terrain`).
fn talestavern_kind(slug: &str) -> Option<&'static str> {
    Some(match slug {
        "inn" => "tavern",
        "merchant" | "market" | "trade" | "blacksmith" | "warehouse" => "shop",
        "church" => "temple",
        "catacombs" => "crypt",
        "caves" | "mine" => "cave",
        "maze" | "prison" | "lab" | "dungeon" | "underground" => "dungeon",
        "fortress" | "gatehouse" | "tower" | "castle" => "fortress",
        "palace" => "manor",
        "home" | "single-structure" => "house",
        // `farm` деревней не делает: деревней ферму сделает `multiple-structures`.
        "village" | "multiple-structures" | "city" => "village",
        "camp" => "camp",
        "ruins" => "ruins",
        "nature" | "area" | "wilderness" | "woodland" | "jungle" | "swamp" | "mountain" => "wilds",
        "docks" => "docks",
        "arena" => "arena",
        "bridge" => "bridge",
        _ => return None,
    })
}

/// Ключи `Object.prototype`: `TALESTAVERN_KINDS[key]` в JS находит их у
/// любого объекта.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
    "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
];

/// Климат по местности TalesTavern; остальные местности климата не задают.
fn talestavern_climate(slug: &str) -> Option<&'static str> {
    match slug {
        "desert" | "volcanic" => Some("arid"),
        "tundra" => Some("cold"),
        "swamp" | "jungle" => Some("wetland"),
        _ => None,
    }
}

/// Признаки паспорта, которые подтверждают вид места.
fn kind_evidence(kind: &str) -> &'static [&'static str] {
    match kind {
        "tavern" => &["common_room", "bedrooms", "kitchen", "storage"],
        "shop" => &["shop", "storage"],
        "temple" => &["shrine"],
        "crypt" => &["crypt"],
        "cave" => &["cave"],
        "dungeon" => &["doors", "storage"],
        "fortress" => &["barracks", "doors"],
        "manor" => &["throne", "bedrooms", "library"],
        "house" => &["bedrooms", "kitchen"],
        "village" => &["street", "yard"],
        "wilds" => &["grove", "camp"],
        _ => &[],
    }
}

/// Наименьшая площадь этажа входа для уличной сцены, в клетках по 5 футов.
fn min_exterior_cells(kind: &str) -> f64 {
    match kind {
        "village" => 400.0,
        "docks" | "fortress" => 300.0,
        "wilds" => 200.0,
        "bridge" => 120.0,
        _ => 0.0,
    }
}

// --- рыхлый JSON -------------------------------------------------------------------

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|object| object.get(key))
}

/// Строки массива (`new Set(array)` для проверки `has` строкой).
fn string_set(value: Option<&Value>) -> HashSet<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => HashSet::new(),
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// `Number(value) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

/// `Math.max(a, b)` / `Math.min(a, b)` с NaN, как в JS.
fn js_max(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

fn js_min(a: f64, b: f64) -> f64 {
    js::min_of([a, b])
}

fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

// --- виды места и климат --------------------------------------------------------------

/// `placeKindsFor(types, terrains, passport, title)`: виды места по таксономии
/// TalesTavern, а если автор её не дал — по паспорту карты. Корабль — всегда
/// только «корабль». `passport` — `{ features, interior_share }`.
pub fn place_kinds_for(types: &[String], terrains: &[String], passport: Option<&Value>, title: &str) -> Vec<String> {
    let ship = re!(
        r"\b(ship|boat|galleon|sloop|vessel|ketch|cog|frigate|caravel|brig|longship|airship|spelljammer|barque|bark|lugger|cutter|xebec|warship|schooner|corvette|uss|hms)\b",
        "iu"
    );
    if text::test(ship, title) {
        return vec!["ship".into()];
    }
    let mut kinds: Vec<&'static str> = Vec::new();
    let add = |kinds: &mut Vec<&'static str>, kind: &'static str| {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    };
    // Слаг — ключ прототипа (`toString`, `constructor`, …): в JS
    // `TALESTAVERN_KINDS[slug]` находит функцию, и она встаёт в набор видом,
    // который ни с чем не совпадает, но запасные виды по паспорту уже не
    // ставятся. Здесь такой вид не выдаётся, а запас так же отключается.
    let mut phantom = false;
    for slug in types {
        if let Some(kind) = talestavern_kind(slug) {
            add(&mut kinds, kind);
        } else if OBJECT_PROTOTYPE_KEYS.contains(&slug.as_str()) {
            phantom = true;
        }
    }
    // Местность добавляет вид только там, где он однозначен.
    for slug in terrains {
        if ["dungeon", "underground", "docks", "castle"].contains(&slug.as_str()) {
            if let Some(kind) = talestavern_kind(slug) {
                add(&mut kinds, kind);
            }
        }
    }
    let features = string_set(field(passport, "features"));
    let interior_share = js::number(field(passport, "interior_share"));
    if kinds.is_empty() && !phantom {
        if features.contains("common_room") && features.contains("bedrooms") {
            add(&mut kinds, "tavern");
        }
        if features.contains("shrine") && interior_share >= 0.5 {
            add(&mut kinds, "temple");
        }
        if features.contains("crypt") {
            add(&mut kinds, "crypt");
        }
    }
    if kinds.is_empty() && !phantom && terrains.iter().any(|slug| talestavern_kind(slug) == Some("wilds")) && interior_share < 0.3 {
        add(&mut kinds, "wilds");
    }
    let mut result: Vec<String> = kinds.into_iter().map(str::to_string).collect();
    result.sort();
    result
}

/// `climateFor(terrains, passport)`: климат по местности или материалу паспорта.
pub fn climate_for(terrains: &[String], passport: Option<&Value>) -> &'static str {
    if let Some(climate) = terrains.iter().find_map(|slug| talestavern_climate(slug)) {
        return climate;
    }
    match field(passport, "material").and_then(Value::as_str) {
        Some("sand") => "arid",
        Some("ice") => "cold",
        _ => "",
    }
}

// --- заявка сцены ----------------------------------------------------------------------

/// Вход `libraryRequestFor`; значения по умолчанию — как в JS.
#[derive(Clone, Debug)]
pub struct LibraryRequestInput<'a> {
    pub theme_id: &'a str,
    pub building_use: &'a str,
    pub topology: &'a str,
    pub climate: &'a str,
    pub world_kind: &'a str,
    /// Объявленные этажи `{ offset }`.
    pub levels: &'a [Value],
    pub width: f64,
    pub height: f64,
    /// Название и тема места.
    pub place: &'a str,
    /// Описание мира.
    pub world: &'a str,
    /// Обязательные объекты сцены (`scene-requirements`).
    pub requirements: &'a Value,
    /// Программа сцены; `null` — нет.
    pub program: &'a Value,
}

impl Default for LibraryRequestInput<'_> {
    fn default() -> Self {
        Self {
            theme_id: "",
            building_use: "",
            topology: "",
            climate: "",
            world_kind: "",
            levels: &[],
            width: 26.0,
            height: 22.0,
            place: "",
            world: "",
            requirements: &Value::Null,
            program: &Value::Null,
        }
    }
}

/// Что сцена просит от карты (`libraryRequestFor`).
#[derive(Clone, Debug, PartialEq)]
pub struct LibraryRequest {
    pub place_kinds: Vec<String>,
    pub exterior: bool,
    pub climate: String,
    /// `scifi` или `fantasy`.
    pub genre: String,
    pub wants_cellar: bool,
    pub wants_upstairs: bool,
    pub area: f64,
    pub requirements: Vec<Requirement>,
    pub required: Vec<String>,
}

impl LibraryRequest {
    /// Форма JS: `{ placeKinds, exterior, climate, genre, wantsCellar, wantsUpstairs, area, requirements, required }`.
    pub fn to_json(&self) -> Value {
        json!({
            "placeKinds": self.place_kinds,
            "exterior": self.exterior,
            "climate": self.climate,
            "genre": self.genre,
            "wantsCellar": self.wants_cellar,
            "wantsUpstairs": self.wants_upstairs,
            "area": js::num(self.area),
            "requirements": serde_json::to_value(&self.requirements).unwrap_or(Value::Null),
            "required": self.required,
        })
    }

    /// Заявка из объекта JS (в том числе исправленного вызывающим, как
    /// `{ ...request, climate: 'arid' }`).
    pub fn from_json(value: &Value) -> Self {
        let get = |key: &str| value.get(key);
        Self {
            place_kinds: strings(get("placeKinds")),
            exterior: js::truthy(get("exterior")),
            climate: js::s(get("climate")),
            genre: js::s(get("genre")),
            wants_cellar: js::truthy(get("wantsCellar")),
            wants_upstairs: js::truthy(get("wantsUpstairs")),
            area: js::number(get("area")),
            requirements: get("requirements").map(normalize_scene_requirements).unwrap_or_default(),
            required: strings(get("required")),
        }
    }
}

/// `libraryRequestFor(input)`: заявка сцены в требования к карте. Тема и
/// назначение здания — из той же эвристики, что у процедурного генератора.
pub fn library_request_for(input: &LibraryRequestInput<'_>) -> LibraryRequest {
    let mut place_kinds: Vec<&str> = Vec::new();
    let mut exterior = false;
    match input.theme_id {
        "building" => {
            place_kinds = match input.building_use {
                "tavern" => vec!["tavern"],
                "shop" => vec!["shop"],
                "manor" => vec!["manor", "fortress"],
                _ => vec!["house"],
            }
        }
        "temple" => place_kinds = vec!["temple"],
        "crypt" => place_kinds = vec!["crypt"],
        "cave" => place_kinds = if input.world_kind == "dungeon" { vec!["dungeon", "cave"] } else { vec!["cave"] },
        "forest" => {
            place_kinds = vec!["wilds"];
            exterior = true;
        }
        "road" => {
            place_kinds = vec!["wilds", "bridge"];
            exterior = true;
        }
        "settlement" => {
            place_kinds = match input.topology {
                "harbor" => vec!["docks"],
                "market" => vec!["village", "shop"],
                "gate" => vec!["fortress", "village"],
                _ => vec!["village"],
            };
            exterior = true;
        }
        _ => {}
    }
    if text::test(re!(r"корабл|судн|палуб|галеон|драккар|ладь[яиеюё]|шхун|фрегат|каравелл", "iu"), input.place) {
        place_kinds = vec!["ship"];
        exterior = false;
    }
    if input.world_kind == "ruin" && !exterior {
        place_kinds.push("ruins");
    }
    if input.world_kind == "fortress" && !place_kinds.contains(&"fortress") {
        place_kinds.push("fortress");
    }
    let scifi = re!(r"кибер|космос|космич|звездолёт|звездолет|орбит|станци[яи] «|футур|будущ|sci-?fi|киберпанк|робот", "iu");
    let offset = |level: &Value| js::number(field(Some(level), "offset"));
    LibraryRequest {
        place_kinds: place_kinds.into_iter().map(str::to_string).collect(),
        exterior,
        climate: if input.climate == "temperate" { String::new() } else { input.climate.to_string() },
        genre: if text::test(scifi, &format!("{} {}", input.place, input.world)) { "scifi" } else { "fantasy" }.into(),
        wants_cellar: input.levels.iter().any(|level| offset(level) < 0.0),
        wants_upstairs: input.levels.iter().any(|level| offset(level) > 0.0),
        area: js_max(256.0, input.width * input.height),
        requirements: normalize_scene_requirements(input.requirements),
        required: required_program_kinds(input.program),
    }
}

// --- записи ----------------------------------------------------------------------------

/// `libraryAnchors(entry)`: паспорт якорей записи — сохранённый при импорте
/// или выведенный из счётчика предметов старого паспорта.
pub fn library_anchors(entry: &Value) -> Value {
    let passport = field(Some(entry), "passport");
    match field(passport, "anchors") {
        Some(anchors @ (Value::Object(_) | Value::Array(_))) => anchors.clone(),
        _ => anchor_counts_for(Some(field(passport, "props").unwrap_or(&Value::Object(Map::new()))), None),
    }
}

/// `libraryPlaceKinds(entry)`: виды места записи по нынешнему словарю.
/// Сохранённый `place_kinds` — только у записи без слагов автора.
pub fn library_place_kinds(entry: &Value) -> Vec<String> {
    let Some(Value::Array(types)) = entry.get("types") else {
        return strings(entry.get("place_kinds"));
    };
    let types: Vec<String> = types.iter().filter_map(Value::as_str).map(str::to_string).collect();
    let terrains = strings(entry.get("terrains"));
    let title = match entry.get("title") {
        None => String::new(),
        value => js::string(value),
    };
    place_kinds_for(&types, &terrains, entry.get("passport"), &title)
}

/// Площадь этажа входа (`groundCells`): у паспорта `floor_cells` — сумма всех этажей.
fn ground_cells(entry: &Value) -> f64 {
    let passport = field(Some(entry), "passport");
    let levels: &[Value] = match field(passport, "levels") {
        Some(Value::Array(levels)) => levels,
        _ => &[],
    };
    let ground = levels.iter().find(|level| js::number(field(Some(level), "index")) == 0.0).or_else(|| levels.first());
    let cells = js::number(field(ground, "cells"));
    if cells.is_finite() && cells > 0.0 {
        return cells;
    }
    let area = number_or(field(passport, "width"), 0.0) * number_or(field(passport, "height"), 0.0);
    if area > 0.0 {
        js_min(area, number_or(field(passport, "floor_cells"), area))
    } else {
        js_max(1.0, number_or(field(passport, "floor_cells"), 1.0))
    }
}

/// Идентификатор записи строкой (`String(entry.id)`).
fn entry_id(entry: &Value) -> String {
    js::string(entry.get("id"))
}

fn hash_number(text: &str) -> u32 {
    let digest = hash::sha256(text);
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// Отказ модуля. `name` — класс исключения JS (`Error`, `TypeError`,
/// `SyntaxError`); тексты ошибок ввода-вывода и разбора — Rust, а не V8.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MapLibraryError {
    pub name: &'static str,
    pub message: String,
}

impl MapLibraryError {
    fn new(name: &'static str, message: impl Into<String>) -> Self {
        Self { name, message: message.into() }
    }
}

impl std::fmt::Display for MapLibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MapLibraryError {}

impl From<io::Error> for MapLibraryError {
    fn from(error: io::Error) -> Self {
        Self::new("Error", error.to_string())
    }
}

pub type LibraryResult<T> = Result<T, MapLibraryError>;

/// Устойчивая сортировка слиянием со сравнителем JS: правый идёт раньше,
/// только если сравнитель строго больше нуля. Для согласованного сравнителя
/// порядок тот же, что у `Array.prototype.sort`; несогласованный (NaN в
/// очках) не роняет процесс.
fn js_sort<T: Clone>(items: &[T], compare: &dyn Fn(&T, &T) -> f64) -> Vec<T> {
    if items.len() <= 1 {
        return items.to_vec();
    }
    let middle = items.len() / 2;
    let left = js_sort(&items[..middle], compare);
    let right = js_sort(&items[middle..], compare);
    let mut result = Vec::with_capacity(items.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        if compare(&left[i], &right[j]) > 0.0 {
            result.push(right[j].clone());
            j += 1;
        } else {
            result.push(left[i].clone());
            i += 1;
        }
    }
    result.extend_from_slice(&left[i..]);
    result.extend_from_slice(&right[j..]);
    result
}

/// `chooseLibraryMap(entries, request, { seed, usedIds })`: лучшая запись под
/// заявку или `None`. Из близких по качеству — по сиду места.
pub fn choose_library_map<'a>(entries: &'a [Value], request: &LibraryRequest, seed: &str, used_ids: &[String]) -> LibraryResult<Option<&'a Value>> {
    if request.place_kinds.is_empty() {
        return Ok(None);
    }
    let used: HashSet<&str> = used_ids.iter().map(String::as_str).collect();
    let mut scored: Vec<(usize, f64)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if used.contains(entry_id(entry).as_str()) {
            continue;
        }
        let kinds = library_place_kinds(entry);
        let Some(primary) = request.place_kinds.iter().position(|kind| kinds.contains(kind)) else { continue };
        let passport = field(Some(entry), "passport");
        let climate = entry.get("climate");
        let climate_is = |value: &str| climate.and_then(Value::as_str) == Some(value);
        // Климат не должен спорить.
        if !request.climate.is_empty() && js::truthy(climate) && !climate_is(&request.climate) {
            continue;
        }
        if request.climate == "arid" && !js::truthy(climate) && field(passport, "material").and_then(Value::as_str) == Some("grass") {
            continue;
        }
        if request.climate.is_empty() && climate_is("arid") {
            continue;
        }
        // Жанр не смешивается.
        let genre_matches = match field(passport, "genre") {
            None | Some(Value::Null) => request.genre == "fantasy",
            Some(Value::String(genre)) => *genre == request.genre,
            Some(_) => false,
        };
        if !genre_matches {
            continue;
        }
        let share = number_or(field(passport, "interior_share"), 0.0);
        // Улица, поле и деревня — сцены под открытым небом.
        if request.exterior && share > 0.45 {
            continue;
        }
        let kind = request.place_kinds[primary].as_str();
        if request.exterior {
            let minimum = js_max(min_exterior_cells(kind), (request.area / 2.0).floor());
            if ground_cells(entry) < minimum {
                continue;
            }
        }
        let features = string_set(field(passport, "features"));
        // Уличная сцена требует, чтобы паспорт подтвердил вид места признаком.
        let evidence = kind_evidence(kind);
        if request.exterior && !evidence.is_empty() && !evidence.iter().any(|feature| features.contains(*feature)) {
            continue;
        }
        let mut score = 10.0 - primary as f64 * 2.0;
        if !request.climate.is_empty() && climate_is(&request.climate) {
            score += 3.0;
        }
        for kind in &request.place_kinds {
            for feature in kind_evidence(kind) {
                if features.contains(*feature) {
                    score += 1.0;
                }
            }
        }
        if request.wants_cellar {
            score += if features.contains("cellar") { 3.0 } else { -3.0 };
        }
        if request.wants_upstairs {
            score += if features.contains("upstairs") { 2.0 } else { -2.0 };
        }
        let area = js_max(1.0, number_or(field(passport, "floor_cells"), 1.0));
        score -= js_min(3.0, log2(area / request.area).abs());
        let downloads = number_or(field(entry.get("source"), "downloads"), 0.0);
        score += js_min(2.0, log10(1.0 + downloads) / 2.0);
        let quality = js::number(field(field(passport, "quality"), "score"));
        if quality.is_finite() && quality < MIN_LIBRARY_QUALITY {
            continue;
        }
        let anchors = library_anchors(entry);
        if !request.requirements.is_empty() {
            let coverage = anchor_coverage(&request.requirements, Some(&anchors));
            score += coverage.met.len() as f64 - coverage.missing.len() as f64 * MISSING_REQUIREMENT_PENALTY;
        }
        // Обязательное программы — центр, посты, улики — весит больше.
        if !request.required.is_empty() {
            let covered = request.required.iter().filter(|id| number_or(field(Some(&anchors), id), 0.0) > 0.0).count();
            if (covered as f64) / (request.required.len() as f64) < REQUIRED_ANCHOR_SHARE {
                continue;
            }
            score += covered as f64 * REQUIRED_ANCHOR_BONUS;
        }
        if score < MIN_LIBRARY_SCORE {
            continue;
        }
        scored.push((index, score));
    }
    if scored.is_empty() {
        return Ok(None);
    }
    let compare = |left: &(usize, f64), right: &(usize, f64)| {
        let difference = right.1 - left.1;
        if difference != 0.0 && !difference.is_nan() {
            return difference;
        }
        match text::locale_compare(&entry_id(&entries[left.0]), &entry_id(&entries[right.0])) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        }
    };
    let scored = js_sort(&scored, &compare);
    let best = scored[0].1;
    let top: Vec<usize> = scored.iter().filter(|candidate| candidate.1 >= best - 2.0).take(4).map(|candidate| candidate.0).collect();
    if top.is_empty() {
        // Очки NaN: JS падает, читая `entry` у `undefined`.
        return Err(MapLibraryError::new("TypeError", "Cannot read properties of undefined (reading 'entry')"));
    }
    let chosen = top[(hash_number(&format!("{seed}:map-library/v2")) as usize) % top.len()];
    Ok(Some(&entries[chosen]))
}

/// `libraryIdsInUse(locationMaps)`: идентификаторы библиотечных карт, уже
/// лежащих в памяти локаций (сид `library:<id>:<этаж>`).
pub fn library_ids_in_use(location_maps: &Value) -> IndexSet<String> {
    let records: Vec<&Value> = match location_maps {
        Value::Object(object) => js::entries(object).into_iter().map(|(_, record)| record).collect(),
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    };
    let mut ids = IndexSet::new();
    for record in records {
        let seed = js::s(field(field(Some(record), "map"), "seed"));
        if let Some(rest) = seed.strip_prefix(LIBRARY_SEED_PREFIX) {
            ids.insert(rest.split(':').next().unwrap_or("").to_string());
        }
    }
    ids
}

// --- этажи --------------------------------------------------------------------------------

/// Изъян этажа записи: `{ level, code, detail? }`. `level` — число JS
/// (`NaN` у негодного номера, в JSON — `null`).
#[derive(Clone, Debug, PartialEq)]
pub struct LevelProblem {
    pub level: f64,
    pub code: String,
    pub detail: Option<String>,
}

impl LevelProblem {
    fn new(level: f64, code: &str, detail: Option<String>) -> Self {
        Self { level, code: code.into(), detail }
    }

    /// Форма JS.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("level".into(), js::num(self.level));
        object.insert("code".into(), Value::String(self.code.clone()));
        if let Some(detail) = &self.detail {
            object.insert("detail".into(), Value::String(detail.clone()));
        }
        Value::Object(object)
    }
}

/// Переход на целевом этаже, у которого встаёт пришедший с этажа `from`.
fn arrival_from(map: &TacticalMap, from: i64) -> Option<usize> {
    map.props.iter().position(|prop| prop.transition.as_ref().is_some_and(|transition| transition.to_level == from))
}

/// `libraryLevelProblems(levels)`: изъяны записи по всем её этажам; пустой
/// список — карту можно брать. Этаж входа — точка появления, досягаемость
/// пола, выход наружу; остальные — структура и место у обратной лестницы;
/// лестницы связывают этажи самой записи.
pub fn library_level_problems(levels: &Value) -> Vec<LevelProblem> {
    let mut problems = Vec::new();
    let mut maps: Vec<(i64, TacticalMap)> = Vec::new();
    let list: &[Value] = match levels {
        Value::Array(items) => items,
        _ => &[],
    };
    for level in list {
        let index = js::number(field(Some(level), "index"));
        if !is_safe_integer(index) || maps.iter().any(|(known, _)| *known as f64 == index) {
            problems.push(LevelProblem::new(index, "LEVEL_INDEX_INVALID", None));
            continue;
        }
        let index_int = index as i64;
        match field(Some(level), "map").map(deserialize_tactical_map) {
            Some(Ok(map)) => {
                // Этаж записи и этаж карты — одно число.
                if map.level_index != index_int {
                    problems.push(LevelProblem::new(index, "LEVEL_INDEX_MISMATCH", Some(map.level_index.to_string())));
                } else {
                    maps.push((index_int, map));
                }
            }
            _ => problems.push(LevelProblem::new(index, "LEVEL_MAP_INVALID", None)),
        }
    }
    let get = |maps: &[(i64, TacticalMap)], index: i64| maps.iter().position(|(known, _)| *known == index);
    if get(&maps, 0).is_none() {
        problems.push(LevelProblem::new(0.0, "NO_ENTRY_LEVEL", None));
        return problems;
    }
    // Куда с этажа ведут исправные лестницы (в порядке появления).
    let mut links: Vec<(i64, IndexSet<i64>)> = Vec::new();
    for (index, map) in &maps {
        for prop in &map.props {
            let Some(transition) = &prop.transition else { continue };
            let to = transition.to_level;
            match get(&maps, to) {
                None => problems.push(LevelProblem::new(*index as f64, "TRANSITION_BROKEN", Some(format!("{}→{to}", prop.id)))),
                Some(target) if arrival_from(&maps[target].1, *index).is_none() => {
                    problems.push(LevelProblem::new(*index as f64, "TRANSITION_WITHOUT_RETURN", Some(format!("{}→{to}", prop.id))));
                }
                Some(_) => match links.iter_mut().find(|(from, _)| from == index) {
                    Some((_, targets)) => {
                        targets.insert(to);
                    }
                    None => links.push((*index, IndexSet::from([to]))),
                },
            }
        }
    }
    let mut reached: HashSet<i64> = HashSet::from([0]);
    let mut queue = vec![0i64];
    while !queue.is_empty() {
        let current = queue.remove(0);
        if let Some((_, targets)) = links.iter().find(|(from, _)| *from == current) {
            for to in targets {
                if reached.insert(*to) {
                    queue.push(*to);
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..maps.len()).collect();
    order.sort_by_key(|position| maps[*position].0);
    for position in order {
        let (index, map) = &maps[position];
        if *index == 0 {
            for problem in audit_tactical_map(map).problems {
                if LIBRARY_BLOCKING_PROBLEMS.contains(&problem.code) {
                    problems.push(LevelProblem::new(0.0, problem.code, problem.detail));
                }
            }
            continue;
        }
        if !reached.contains(index) {
            problems.push(LevelProblem::new(*index as f64, "LEVEL_UNREACHABLE", None));
            continue;
        }
        // Отряд приходит сюда с каждого этажа, откуда ведёт исправная
        // лестница, и встаёт у своей обратной.
        let arrivals: Vec<Option<usize>> = links.iter().filter(|(_, targets)| targets.contains(index)).map(|(from, _)| arrival_from(map, *from)).collect();
        for (order, arrival) in arrivals.into_iter().enumerate() {
            let prop = arrival.map(|position| &map.props[position]);
            let Some(spot) = prop.and_then(|prop| prop.footprint.first()) else {
                problems.push(LevelProblem::new(*index as f64, "LEVEL_ARRIVAL_MISSING", Some(prop.map_or_else(String::new, |prop| prop.id.clone()))));
                continue;
            };
            let mut probe = map.clone();
            probe.spawn_points = vec![TacticalSpawnPoint { id: "library-arrival".into(), x: spot.x, y: spot.y, role: "party".into() }];
            for problem in audit_tactical_map(&probe).problems {
                if order > 0 && problem.code != "PARTY_SPAWN_BLOCKED" {
                    continue;
                }
                if LIBRARY_UPPER_BLOCKING_PROBLEMS.contains(&problem.code) {
                    problems.push(LevelProblem::new(*index as f64, problem.code, problem.detail));
                }
            }
        }
    }
    problems
}

// --- хранилище --------------------------------------------------------------------------

/// Идентификатор записи: строчные латиница и цифры с дефисом, до ста символов.
fn entry_id_valid(id: &str) -> bool {
    text::test(re!(r"^[a-z0-9][a-z0-9-]{0,99}$", "u"), id)
}

/// Запись через временный файл (`writeJsonAtomic`). На Windows переименование
/// поверх файла, который держит антивирус или читатель, отказывает — тогда
/// несколько коротких повторов, а в крайнем случае прямая запись.
fn write_json_atomic(file: &Path, value: &Value) -> io::Result<()> {
    let content = format!("{}\n", js::stringify(value));
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    fs::write(&temporary, &content)?;
    for attempt in 0..10u64 {
        match fs::rename(&temporary, file) {
            Ok(()) => return Ok(()),
            Err(error) if retryable(&error) => std::thread::sleep(Duration::from_millis(50 * (attempt + 1))),
            Err(error) => return Err(error),
        }
    }
    fs::write(file, &content)?;
    let _ = fs::remove_file(&temporary);
    Ok(())
}

/// `EPERM`, `EBUSY`, `EACCES` (на Windows — отказ доступа и нарушение совместного доступа).
fn retryable(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy) || matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

fn parse_json(text: &str) -> LibraryResult<Value> {
    serde_json::from_str(text).map_err(|error| MapLibraryError::new("SyntaxError", error.to_string()))
}

/// Выбранная запись вместе с этажами.
#[derive(Clone, Debug, PartialEq)]
pub struct PickedMap {
    pub entry: Value,
    /// Этажи как в файле: `[{ index, label, map }, …]`.
    pub levels: Vec<Value>,
}

/// Параметры `pick`: сид места, уже использованные карты и проверка этажа
/// входа сверх играбельности (программа сцены).
pub struct PickOptions<'a> {
    pub seed: &'a str,
    pub used_ids: &'a [String],
    pub check: Option<&'a dyn Fn(&Value) -> bool>,
}

struct IndexCache {
    mtime: SystemTime,
    entries: Vec<Value>,
}

struct AuditCache {
    mtime: Option<SystemTime>,
    results: HashMap<String, bool>,
}

/// Библиотека в `<storage>/map-library` (`MapLibrary`). Кэш индекса — до
/// смены его времени изменения; итог проверки этажей — до смены индекса.
pub struct MapLibrary {
    dir: PathBuf,
    index_file: PathBuf,
    cache: Mutex<Option<IndexCache>>,
    audits: Mutex<Option<AuditCache>>,
}

impl MapLibrary {
    /// `storage_dir` — корень хранилища (`DND_STORAGE_DIR`).
    pub fn new(storage_dir: impl AsRef<Path>) -> Self {
        let dir = storage_dir.as_ref().join(MAP_LIBRARY_DIR);
        let index_file = dir.join("index.json");
        Self { dir, index_file, cache: Mutex::new(None), audits: Mutex::new(None) }
    }

    /// Каталог библиотеки.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn cached_mtime(&self) -> Option<SystemTime> {
        self.cache.lock().ok().and_then(|cache| cache.as_ref().map(|cache| cache.mtime))
    }

    /// `entries()`: записи индекса с допустимым идентификатором.
    pub fn entries(&self) -> LibraryResult<Vec<Value>> {
        if !self.index_file.exists() {
            return Ok(Vec::new());
        }
        let mtime = fs::metadata(&self.index_file)?.modified()?;
        if let Ok(cache) = self.cache.lock() {
            if let Some(cache) = cache.as_ref().filter(|cache| cache.mtime == mtime) {
                return Ok(cache.entries.clone());
            }
        }
        let parsed = parse_json(&fs::read_to_string(&self.index_file)?)?;
        let entries: Vec<Value> = match field(Some(&parsed), "entries") {
            Some(Value::Array(entries)) => {
                entries.iter().filter(|entry| entry_id_valid(&js::s(field(Some(entry), "id")))).cloned().collect()
            }
            _ => Vec::new(),
        };
        if let Ok(mut cache) = self.cache.lock() {
            *cache = Some(IndexCache { mtime, entries: entries.clone() });
        }
        Ok(entries)
    }

    /// `levels(id)`: этажи записи; `None` — нет файла или идентификатор негоден.
    pub fn levels(&self, id: &str) -> LibraryResult<Option<Vec<Value>>> {
        if !entry_id_valid(id) {
            return Ok(None);
        }
        let file = self.dir.join("maps").join(format!("{id}.json"));
        if !file.exists() {
            return Ok(None);
        }
        let parsed = parse_json(&fs::read_to_string(&file)?)?;
        Ok(match field(Some(&parsed), "levels") {
            Some(Value::Array(levels)) => Some(levels.clone()),
            _ => None,
        })
    }

    /// `put(entry, levels)`: добавляет или заменяет запись вместе с этажами.
    pub fn put(&self, entry: &Value, levels: &Value) -> LibraryResult<()> {
        let id = js::string(entry.get("id"));
        if !entry_id_valid(&id) {
            return Err(MapLibraryError::new("Error", format!("Неверный идентификатор записи библиотеки: {id}")));
        }
        let maps = self.dir.join("maps");
        fs::create_dir_all(&maps)?;
        let mut file = Map::new();
        file.insert("schema_version".into(), Value::from(MAP_LIBRARY_SCHEMA_VERSION));
        // `id: entry.id`: у записи без поля его нет и в файле.
        if let Some(raw) = entry.get("id") {
            file.insert("id".into(), raw.clone());
        }
        file.insert("levels".into(), levels.clone());
        write_json_atomic(&maps.join(format!("{id}.json")), &Value::Object(file))?;
        let mut entries: Vec<Value> = self.entries()?.into_iter().filter(|candidate| candidate.get("id") != entry.get("id")).collect();
        entries.push(entry.clone());
        let sorted = js_sort(&entries, &|left: &Value, right: &Value| match text::locale_compare(&entry_id(left), &entry_id(right)) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        });
        write_json_atomic(&self.index_file, &json!({ "schema_version": MAP_LIBRARY_SCHEMA_VERSION, "entries": sorted }))?;
        if let Ok(mut cache) = self.cache.lock() {
            *cache = None;
        }
        Ok(())
    }

    /// `pick(request, options)`: карта под заявку сцены вместе с этажами или
    /// `None`. Неиграбельная или не прошедшая `check` запись отбрасывается, и
    /// выбор идёт к следующей; запись при этом не трогается.
    pub fn pick(&self, request: &LibraryRequest, options: &PickOptions<'_>) -> LibraryResult<Option<PickedMap>> {
        let mut rejected: Vec<String> = options.used_ids.to_vec();
        for _ in 0..LIBRARY_PICK_ATTEMPTS {
            let entries = self.entries()?;
            let Some(entry) = choose_library_map(&entries, request, options.seed, &rejected)?.cloned() else {
                return Ok(None);
            };
            let id = entry_id(&entry);
            let levels = self.levels(&id)?;
            let mut ground: Option<&Value> = None;
            for level in levels.iter().flatten() {
                if level.is_null() {
                    // `Number(level.index)` у `null` — TypeError в JS.
                    return Err(MapLibraryError::new("TypeError", "Cannot read properties of null (reading 'index')"));
                }
                if js::number(field(Some(level), "index")) == 0.0 {
                    ground = Some(level);
                    break;
                }
            }
            if let (Some(ground), Some(levels)) = (ground, levels.as_ref()) {
                let map = field(Some(ground), "map").unwrap_or(&Value::Null);
                if self.playable(&id, levels) && options.check.is_none_or(|check| check(map)) {
                    return Ok(Some(PickedMap { entry, levels: levels.clone() }));
                }
            }
            if !rejected.contains(&id) {
                rejected.push(id);
            }
        }
        Ok(None)
    }

    /// `playable(id, levels)`: проходят ли все этажи записи проверку.
    /// Результат запоминается до смены индекса библиотеки.
    pub fn playable(&self, id: &str, levels: &[Value]) -> bool {
        let mtime = self.cached_mtime();
        let Ok(mut audits) = self.audits.lock() else {
            return library_level_problems(&Value::Array(levels.to_vec())).is_empty();
        };
        if audits.as_ref().is_none_or(|audits| audits.mtime != mtime) {
            *audits = Some(AuditCache { mtime, results: HashMap::new() });
        }
        if let Some(known) = audits.as_ref().and_then(|audits| audits.results.get(id)) {
            return *known;
        }
        let ok = library_level_problems(&Value::Array(levels.to_vec())).is_empty();
        if let Some(audits) = audits.as_mut() {
            audits.results.insert(id.to_string(), ok);
        }
        ok
    }
}

static ACTIVE: RwLock<Option<Arc<MapLibrary>>> = RwLock::new(None);

/// `setActiveMapLibrary(library)`: сервер подключает библиотеку при старте.
/// Тесты движка её не подключают, и генератор сцены ведёт себя как раньше.
pub fn set_active_map_library(library: Option<Arc<MapLibrary>>) {
    if let Ok(mut active) = ACTIVE.write() {
        *active = library;
    }
}

/// `activeMapLibrary()`.
pub fn active_map_library() -> Option<Arc<MapLibrary>> {
    ACTIVE.read().ok().and_then(|active| active.clone())
}
