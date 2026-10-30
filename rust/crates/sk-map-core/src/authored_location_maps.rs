//! Перенос `server/authored-location-maps.mjs`: реестр заранее собранных
//! тактических карт для известных мест.
//!
//! Карты не зависят от кода стола: сериализованная геометрия лежит в
//! данных `data/authored-location-maps-v1.json` (встроены в сборку), а
//! отсутствие конкретного места оставляет прежний процедурный путь. Картинки
//! в этот контракт не входят — клиент получает их по маркеру `tilesetId`.

use std::fmt;
use std::sync::LazyLock;

use serde_json::{Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::content::{self, ContentError, ContentResult};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text};
use sk_tactical::tactical_map::{deserialize_tactical_map, serialize_tactical_map, validate_tactical_map, TacticalMap, TacticalMapError};

pub const AUTHORED_LOCATION_MAP_CATALOG_VERSION: i64 = 1;

/// Путь каталога от корня репозитория (данные встроены в сборку).
pub const AUTHORED_LOCATION_MAP_CATALOG_FILE: &str = "data/authored-location-maps-v1.json";

static CATALOG_SOURCE: &str = include_str!("../../../../data/authored-location-maps-v1.json");

/// `AUTHORED_LOCATION_MAP_MARKER`: `authored-location:<id>:v<n>` или `authored-tactical:<id>:v<n>`.
pub fn authored_location_map_marker() -> &'static Regex {
    re!(r"^authored-(?:location|tactical):([a-z0-9]+(?:-[a-z0-9]+)*):v([1-9][0-9]*)$", "u")
}

/// `AUTHORED_LOCATION_MAP_ID`: допустимый идентификатор места.
pub fn authored_location_map_id() -> &'static Regex {
    re!(r"^[a-z0-9][a-z0-9_-]{0,119}$", "u")
}

/// Отказ разбора каталога: `Error` JS с текстом или отказ чтения карты
/// (`TacticalMapError`, а для `null` вместо объекта — `TypeError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogError {
    Invalid(String),
    Map(TacticalMapError),
}

impl CatalogError {
    /// Имя ошибки JS: `Error`, `TacticalMapError` или `TypeError`.
    pub fn name(&self) -> &str {
        match self {
            CatalogError::Invalid(_) => "Error",
            CatalogError::Map(error) => error.name,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            CatalogError::Invalid(message) => message,
            CatalogError::Map(error) => &error.message,
        }
    }

    /// Код ошибки карты; у `Error` и `TypeError` JS кода нет.
    pub fn code(&self) -> Option<&str> {
        match self {
            CatalogError::Map(error) if error.name == TacticalMapError::NAME => Some(&error.code),
            _ => None,
        }
    }
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CatalogError {}

impl From<TacticalMapError> for CatalogError {
    fn from(error: TacticalMapError) -> Self {
        CatalogError::Map(error)
    }
}

/// `record(value, path)`: объект-словарь или отказ.
fn record<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, CatalogError> {
    value.as_object().ok_or_else(|| CatalogError::Invalid(format!("{path} должен быть объектом")))
}

/// `locationId(value, path)`.
fn location_id(value: Option<&Value>, path: &str) -> Result<String, CatalogError> {
    let result = text::trim(&js::s(value)).to_string();
    if !text::test(authored_location_map_id(), &result) {
        return Err(CatalogError::Invalid(format!("{path} имеет неверный идентификатор")));
    }
    Ok(result)
}

/// `value ?? fallback`: первое значение, которое не `undefined` и не `null`.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `normalizeAuthoredLocationMapCatalog(value, { requireComplete })`:
/// полный каталог карт по id места. Принимаются и прямые записи карт, и
/// обёртки `{ location_id, map }`. Карта в ответе — сериализованная.
pub fn normalize_authored_location_map_catalog(value: &Value, require_complete: bool) -> Result<IndexMap<String, Value>, CatalogError> {
    let root = record(value, "catalog")?;
    if root.get("schema_version").and_then(Value::as_f64) != Some(AUTHORED_LOCATION_MAP_CATALOG_VERSION as f64) {
        return Err(CatalogError::Invalid(format!("catalog.schema_version должен быть {AUTHORED_LOCATION_MAP_CATALOG_VERSION}")));
    }
    let Some(Value::Array(entries)) = root.get("maps") else {
        return Err(CatalogError::Invalid("catalog.maps должен быть массивом".into()));
    };
    let mut maps: IndexMap<String, Value> = IndexMap::new();
    for (index, raw_entry) in entries.iter().enumerate() {
        let entry = record(raw_entry, &format!("catalog.maps[{index}]"))?;
        let raw_map = match entry.get("map") {
            Some(map @ Value::Object(_)) => map,
            _ => raw_entry,
        };
        let map = deserialize_tactical_map(raw_map)?;
        let map_location = Value::String(map.location_id.clone());
        let candidate = present(entry.get("location_id")).or_else(|| present(entry.get("locationId"))).unwrap_or(&map_location);
        let id = location_id(Some(candidate), &format!("catalog.maps[{index}].location_id"))?;
        if map.location_id != id {
            return Err(CatalogError::Invalid(format!("catalog.maps[{index}] locationId не совпадает с location_id")));
        }
        if maps.contains_key(&id) {
            return Err(CatalogError::Invalid(format!("catalog.maps содержит повторяющийся id «{id}»")));
        }
        let marker = text::capture(authored_location_map_marker(), &map.tileset_id, 1);
        if marker.as_deref() != Some(id.as_str()) {
            return Err(CatalogError::Invalid(format!("catalog.maps[{index}] имеет неверный authored tilesetId")));
        }
        let report = validate_tactical_map(&map);
        if !report.ok {
            let codes: Vec<&str> = report.errors.iter().map(|error| error.code.as_str()).collect();
            return Err(CatalogError::Invalid(format!("catalog.maps[{index}] невалидна: {}", codes.join(", "))));
        }
        maps.insert(id, serialize_tactical_map(&map)?);
    }
    if require_complete && maps.len() != 56 {
        return Err(CatalogError::Invalid(format!("catalog.maps должен содержать 56 карт, получено {}", maps.len())));
    }
    Ok(maps)
}

/// Разбор и проверка каталога карт из текста — та же проверка, что у
/// встроенного каталога (для тестов — сломанные копии).
pub fn parse_authored_location_map_catalog(text: &str) -> ContentResult<IndexMap<String, Value>> {
    let payload = content::parse_json(AUTHORED_LOCATION_MAP_CATALOG_FILE, text)?;
    normalize_authored_location_map_catalog(&payload, false).map_err(|error| ContentError::new(AUTHORED_LOCATION_MAP_CATALOG_FILE, error.to_string()))
}

/// Каталог из данных сборки. Битые встроенные данные в JS — отказ импорта
/// модуля; здесь — отказ проверки при старте сервера
/// ([`check_authored_location_map_catalog`]).
static PARSED: LazyLock<ContentResult<IndexMap<String, Value>>> = LazyLock::new(|| parse_authored_location_map_catalog(CATALOG_SOURCE));

static AUTHORED_LOCATION_MAPS: LazyLock<&'static IndexMap<String, Value>> = LazyLock::new(|| match &*PARSED {
    Ok(maps) => maps,
    Err(error) => panic!("{error}"),
});

/// Проверка встроенного каталога карт (сервер зовёт её до приёма запросов).
pub fn check_authored_location_map_catalog() -> ContentResult<()> {
    PARSED.as_ref().map(|_| ()).map_err(Clone::clone)
}

/// `normalizedId(value)`: идентификатор места или пустая строка.
fn normalized_id(value: Option<&Value>) -> String {
    let id = text::trim(&js::s(value)).to_string();
    if text::test(authored_location_map_id(), &id) {
        id
    } else {
        String::new()
    }
}

/// `authoredLocationMapFor(value)`: новая изменяемая копия карты места.
pub fn authored_location_map_for(value: Option<&Value>) -> Option<TacticalMap> {
    let id = normalized_id(value);
    if id.is_empty() {
        return None;
    }
    // Запись каталога — собственная сериализация карты: чтение не отказывает.
    AUTHORED_LOCATION_MAPS.get(&id).and_then(|raw| deserialize_tactical_map(raw).ok())
}

/// `hasAuthoredLocationMap(value)`.
pub fn has_authored_location_map(value: Option<&Value>) -> bool {
    let id = normalized_id(value);
    !id.is_empty() && AUTHORED_LOCATION_MAPS.contains_key(&id)
}

/// `authoredLocationMapIds()`: id мест по возрастанию (как `sort()` JS).
pub fn authored_location_map_ids() -> Vec<String> {
    let mut ids: Vec<String> = AUTHORED_LOCATION_MAPS.keys().cloned().collect();
    ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    ids
}

/// `authoredLocationMapCount()`.
pub fn authored_location_map_count() -> usize {
    AUTHORED_LOCATION_MAPS.len()
}

/// Короткое описание карты места для Архитектора сцены.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthoredMapMeta {
    pub location_id: String,
    /// Тема собственного генератора — уже серверная, а не строка модели.
    pub theme_id: String,
    pub tileset_id: String,
    pub seed: String,
    pub width: i64,
    pub height: i64,
}

impl AuthoredMapMeta {
    /// Форма JS: `{ locationId, themeId, tilesetId, seed, width, height }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("locationId".into(), Value::String(self.location_id.clone()));
        object.insert("themeId".into(), Value::String(self.theme_id.clone()));
        object.insert("tilesetId".into(), Value::String(self.tileset_id.clone()));
        object.insert("seed".into(), Value::String(self.seed.clone()));
        object.insert("width".into(), Value::from(self.width));
        object.insert("height".into(), Value::from(self.height));
        Value::Object(object)
    }
}

/// `authoredLocationMapMetaFor(value)`.
pub fn authored_location_map_meta_for(value: Option<&Value>) -> Option<AuthoredMapMeta> {
    let map = authored_location_map_for(value)?;
    Some(AuthoredMapMeta { location_id: map.location_id, theme_id: map.theme, tileset_id: map.tileset_id, seed: map.seed, width: map.width, height: map.height })
}

/// `authoredLocationMapCatalogSnapshot()`: копия всего каталога.
pub fn authored_location_map_catalog_snapshot() -> IndexMap<String, Value> {
    (*AUTHORED_LOCATION_MAPS).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Урок 7: опечатка в ключевом поле копии каталога — отказ, который
    /// называет файл и запись.
    #[test]
    fn broken_copy_names_file_and_map() {
        assert_eq!(check_authored_location_map_catalog(), Ok(()));
        let mut raw: Value = serde_json::from_str(CATALOG_SOURCE).expect("каталог");
        let entry = raw["maps"][3].as_object_mut().expect("карта");
        let target = match entry.get_mut("map") {
            Some(Value::Object(map)) => map,
            _ => entry,
        };
        let tileset = target.shift_remove("tilesetId").expect("tilesetId");
        target.insert("tilesetid".into(), tileset);
        let error = parse_authored_location_map_catalog(&raw.to_string()).err().map(|error| error.to_string());
        assert_eq!(error.as_deref(), Some("data/authored-location-maps-v1.json: catalog.maps[3] имеет неверный authored tilesetId"));
    }
}
