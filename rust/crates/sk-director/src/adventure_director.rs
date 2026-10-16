//! Перенос `server/adventure-director.mjs` — слой локаций сцены. Это не
//! Режиссёр (AGENTS.md §4): здесь живут память карт мест (`locationMaps`),
//! генерация геометрии сцены (`generateSceneGeometry`), выбор постройки из
//! библиотеки готовых карт, сторона входа отряда и переход между сценами
//! (`createSceneTransition`).
//!
//! Подмодули:
//!
//! - [`memory`] — запомненные карты мест, ключи и сиды этажей, публичная
//!   память приключения, поля библиотечной сцены;
//! - [`entry`] — сторона входа по карте мира и точка входа на карте;
//! - [`geometry`] — сборка карты сцены: тема, библиотека, программа сцены,
//!   повторные попытки, поворот к дороге, пол храма;
//! - [`transition`] — `createSceneTransition`.
//!
//! Вход — рыхлый JSON той же формы, что у JS: где JS подставляет значение по
//! умолчанию только вместо `undefined`, Rust отличает отсутствующее поле от
//! `null`. Строки режутся по единицам UTF-16, как `slice` в JS.

use std::fmt;

use serde_json::{json, Value};
use sk_core::{js, text as jstext};
use sk_map_core::dynamic_map::DynamicMapError;
use sk_story::map_library::MapLibraryError;
use sk_tactical::tactical_map::TacticalMapError;
use sk_themes::scene_themes::ThemeError;

pub mod entry;
pub mod geometry;
pub mod memory;
pub mod transition;

pub use entry::{entrance_on_side, entry_side_toward, opening_entry_side, outside_entrance_for};
pub use geometry::{
    generate_scene_cells, generate_scene_cells_with, generate_scene_geometry, generate_scene_geometry_with, generate_scene_map, refresh_scene_floors, LibraryGeometry,
    LibraryLevel, SceneGeometry,
};
pub use memory::{
    known_world_kind, level_key, level_key_js, level_seed, level_seed_js, library_scene_fields, normalize_location_maps, public_adventure_memory, remember_current_scene_map,
    remember_scene_map, scene_level_index, scene_location_id, scene_map_for_location, scene_tactical_map_for_location, stable_location_map_seed, OBJECTIVE_STATUSES,
};
pub use transition::{create_scene_transition, create_scene_transition_with};

// --- ошибка -----------------------------------------------------------------------

/// Исключение JS, которым кончился вызов: `name` — класс (`TypeError`,
/// `TacticalMapError`, `Error`), `code` — код отказа, если он есть у
/// исключения. В живом конвейере переход не отказывает; отказ — на негодном
/// входе или сбое библиотеки карт, на котором JS бросил бы исключение.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectorError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl DirectorError {
    /// `TypeError` с текстом V8.
    pub(crate) fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError".into(), code: None, message: message.into() }
    }

    /// `TypeError` чтения поля у `null`.
    pub(crate) fn null_read(key: &str) -> Self {
        Self::type_error(format!("Cannot read properties of null (reading '{key}')"))
    }

    /// Форма эталона: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl fmt::Display for DirectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DirectorError {}

impl From<TacticalMapError> for DirectorError {
    fn from(error: TacticalMapError) -> Self {
        let code = (error.name == TacticalMapError::NAME).then_some(error.code);
        Self { name: error.name.into(), code, message: error.message }
    }
}

impl From<ThemeError> for DirectorError {
    fn from(error: ThemeError) -> Self {
        Self { name: error.name.into(), code: error.code, message: error.message }
    }
}

impl From<MapLibraryError> for DirectorError {
    fn from(error: MapLibraryError) -> Self {
        Self { name: error.name.into(), code: None, message: error.message }
    }
}

impl From<DynamicMapError> for DirectorError {
    fn from(error: DynamicMapError) -> Self {
        Self { name: error.name.into(), code: None, message: error.message }
    }
}

/// Итог вызова, который в JS мог бросить исключение.
pub type DirectorResult<T> = Result<T, DirectorError>;

// --- приведения JS ------------------------------------------------------------------

/// Чтение свойства `value[key]` у рыхлого значения: у объекта — поле, у
/// массива — элемент по индексу и `length`. Ключи прототипа (`constructor`,
/// `toString`) у объекта дают «нет поля»: во всех местах модуля такое чтение
/// кончается тем же, что и отсутствующее поле.
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(map) => map.get(key),
        Value::Array(items) => {
            if js::is_array_index_key(key) {
                key.parse::<usize>().ok().and_then(|index| items.get(index))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// `a ?? b`: `null` и отсутствие — ко второму.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// `a || b`: ложное — ко второму (второе возвращается как есть).
pub(crate) fn or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

/// Шаблонная строка `${value}`: `undefined` и `null` — словами.
pub(crate) fn tpl(value: Option<&Value>) -> String {
    js::string(value)
}

/// `text.slice(0, limit)` по единицам UTF-16. Граница внутри суррогатной
/// пары: JS оставляет одинокий старший суррогат, строка Rust его не держит —
/// символ отбрасывается целиком.
pub(crate) fn head16(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        result.push(ch);
    }
    result
}

/// `text(value, maxLength, fallback)` модуля: пробелы схлопнуты, края
/// обрезаны; пустое — запасное (не нормализуется); затем `slice(0, max)`.
pub(crate) fn text(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    let normalized = jstext::squash_spaces(&js::s(value));
    head16(if normalized.is_empty() { fallback } else { &normalized }, maximum)
}

/// `text(value, maximum, fallback)` с запасным значением любого вида: строка
/// режется, массив — тоже (`Array.prototype.slice`), `undefined` — пустая
/// строка по умолчанию; иное — `TypeError`, как в JS.
pub(crate) fn text_or_value(value: Option<&Value>, maximum: usize, fallback: Option<&Value>) -> DirectorResult<Value> {
    let normalized = jstext::squash_spaces(&js::s(value));
    if !normalized.is_empty() {
        return Ok(Value::String(head16(&normalized, maximum)));
    }
    match fallback {
        None => Ok(Value::String(String::new())),
        Some(Value::String(fallback)) => Ok(Value::String(head16(fallback, maximum))),
        Some(Value::Array(items)) => Ok(Value::Array(items.iter().take(maximum).cloned().collect())),
        Some(Value::Null) => Err(DirectorError::null_read("slice")),
        Some(_) => Err(DirectorError::type_error("(normalized || fallback).slice is not a function")),
    }
}

/// `publicText(value, maximum, fallback)`: только строка, иначе запасное.
pub(crate) fn public_text(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    match value {
        Some(Value::String(_)) => text(value, maximum, fallback),
        _ => fallback.to_string(),
    }
}

/// `integer(value, fallback, minimum, maximum)`: безопасное целое, зажатое в
/// пределы, иначе запасное.
pub(crate) fn integer(value: Option<&Value>, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    if js::is_safe_integer_number(value) {
        (js::number(value) as i64).clamp(minimum, maximum)
    } else {
        fallback
    }
}

/// Строгое равенство JS (`a === b`) для значений JSON: объекты и массивы
/// равны только самим себе, здесь — никогда.
pub(crate) fn strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}

/// `[...new Set(items)]` для строк, порядок первого вхождения.
pub(crate) fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// `list.slice(-limit)`.
pub(crate) fn tail<T>(mut items: Vec<T>, limit: usize) -> Vec<T> {
    if items.len() > limit {
        items.drain(..items.len() - limit);
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_squashes_and_cuts_by_utf16() {
        assert_eq!(text(Some(&json!("  a \n\t b  ")), 10, "x"), "a b");
        assert_eq!(text(Some(&json!("   ")), 10, "запас"), "запас");
        assert_eq!(text(None, 3, "запасное"), "зап");
        assert_eq!(text(Some(&json!(5)), 10, ""), "5");
        // Эмодзи — две единицы UTF-16.
        assert_eq!(text(Some(&json!("a😀b")), 3, ""), "a😀");
        assert_eq!(text(Some(&json!("a😀b")), 2, ""), "a");
    }

    #[test]
    fn text_with_value_fallback_throws_like_js() {
        assert_eq!(text_or_value(None, 5, Some(&json!("цель"))), Ok(json!("цель")));
        assert_eq!(text_or_value(None, 2, Some(&json!([1, 2, 3]))), Ok(json!([1, 2])));
        assert_eq!(text_or_value(None, 5, None), Ok(json!("")));
        assert_eq!(text_or_value(None, 5, Some(&Value::Null)).map_err(|error| error.message), Err("Cannot read properties of null (reading 'slice')".into()));
        assert!(text_or_value(None, 5, Some(&json!(7))).is_err());
        assert_eq!(text_or_value(Some(&json!("x")), 5, Some(&json!(7))), Ok(json!("x")));
    }

    #[test]
    fn integer_and_strict_equal() {
        assert_eq!(integer(Some(&json!("12")), 1, 1, 10), 10);
        assert_eq!(integer(Some(&json!(2.5)), 1, 1, 10), 1);
        assert_eq!(integer(Some(&Value::Null), 3, -5, 10), 0);
        assert_eq!(integer(None, 3, 1, 10), 3);
        assert!(strict_equal(None, None));
        assert!(!strict_equal(Some(&json!("1")), Some(&json!(1))));
        assert!(!strict_equal(Some(&json!({})), Some(&json!({}))));
    }
}
