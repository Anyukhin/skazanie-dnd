//! Память карт локаций — перенос `rememberCurrentSceneMap` и соседей из
//! `server/adventure-director.mjs`. После каждого события текущая карта сцены
//! записывается в `state.locationMaps` под ключом места и этажа.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sk_core::js::{s, safe_int};

const MAP_CELL_TYPES: [&str; 4] = ["wall", "floor", "water", "door"];
const MAP_MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
const MAP_PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];
/// `SIZE_CLASSES.region.maxCells`.
const REGION_MAX_CELLS: usize = 10_000;

/// `text(value, max, fallback)`: пробелы схлопнуты, края обрезаны.
pub fn text(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    let raw = s(value);
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let chosen = if normalized.is_empty() { fallback.to_string() } else { normalized };
    chosen.chars().take(maximum).collect()
}

/// `publicText`: только для строк.
pub fn public_text(value: Option<&Value>, maximum: usize) -> String {
    match value {
        Some(Value::String(_)) => text(value, maximum, ""),
        _ => String::new(),
    }
}

fn as_safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() { 0.0 } else { trimmed.parse::<f64>().ok()? }
        }
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Null => 0.0,
        _ => return None,
    };
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

/// `normalizedSceneCells(value)`.
pub fn normalized_scene_cells(value: &Value) -> Vec<Value> {
    let source: &[Value] = match value {
        Value::Array(items) => items,
        Value::Object(map) => map.get("cells").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]),
        _ => &[],
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for raw in source.iter().take(REGION_MAX_CELLS) {
        let Some(object) = raw.as_object() else { continue };
        let (Some(x), Some(y)) = (as_safe_integer(object.get("x")), as_safe_integer(object.get("y"))) else { continue };
        if !seen.insert((x, y)) {
            continue;
        }
        let mut cell = Map::new();
        cell.insert("x".into(), Value::from(x));
        cell.insert("y".into(), Value::from(y));
        let kind = s(object.get("type"));
        cell.insert("type".into(), Value::String(if MAP_CELL_TYPES.contains(&kind.as_str()) { kind } else { "floor".into() }));
        cell.insert("revealed".into(), Value::Bool(object.get("revealed") == Some(&Value::Bool(true))));
        if let Some(Value::String(feature)) = object.get("feature") {
            let trimmed = feature.trim();
            if !trimmed.is_empty() {
                cell.insert("feature".into(), Value::String(trimmed.chars().take(40).collect()));
            }
        }
        let material = s(object.get("material"));
        if MAP_MATERIALS.contains(&material.as_str()) {
            cell.insert("material".into(), Value::String(material));
        }
        if let Some(variant) = as_safe_integer(object.get("variant")).filter(|_| object.contains_key("variant")) {
            cell.insert("variant".into(), Value::from(variant.clamp(0, 5)));
        }
        let pattern = s(object.get("pattern"));
        if MAP_PATTERNS.contains(&pattern.as_str()) {
            cell.insert("pattern".into(), Value::String(pattern));
        }
        if let Some(Value::String(mask)) = object.get("edge_mask") {
            if mask.len() <= 4 && mask.chars().all(|c| "nesw".contains(c)) {
                cell.insert("edge_mask".into(), Value::String(mask.clone()));
            }
        }
        for field in ["walls", "windows"] {
            if let Some(Value::String(sides)) = object.get(field) {
                if matches!(sides.as_str(), "e" | "s" | "es") {
                    cell.insert(field.into(), Value::String(sides.clone()));
                }
            }
        }
        if let Some(Value::String(door)) = object.get("door_dir") {
            if door == "e" || door == "s" {
                cell.insert("door_dir".into(), Value::String(door.clone()));
            }
        }
        if let Some(elevation) = object.get("elevation").and_then(|value| as_safe_integer(Some(value))) {
            if elevation != 0 && object.get("elevation").is_some_and(|value| !value.is_null()) {
                cell.insert("elevation".into(), Value::from(elevation.clamp(-100, 100)));
            }
        }
        result.push(Value::Object(cell));
    }
    result
}

/// `sceneMapRecord(cells, map)`.
pub fn scene_map_record(value: &Value, map: Option<&Value>) -> Option<Value> {
    let cells = normalized_scene_cells(value);
    if cells.is_empty() {
        return None;
    }
    let source = match map {
        Some(map) => Some(map),
        None => value.as_object().and_then(|object| object.get("map")),
    };
    let mut record = Map::new();
    record.insert("version".into(), Value::from(1));
    record.insert("cells".into(), Value::Array(cells));
    if let Some(source) = source.filter(|value| value.is_object()) {
        record.insert("map".into(), source.clone());
    }
    Some(Value::Object(record))
}

/// `normalizeLocationMaps(value)`.
pub fn normalize_location_maps(value: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(entries)) = value else { return Map::new() };
    let mut result = Map::new();
    for (location, raw) in entries.iter().take(100) {
        let id = text(Some(&Value::String(location.clone())), 120, "");
        if id.is_empty() {
            continue;
        }
        if let Some(record) = scene_map_record(raw, None) {
            result.insert(id, record);
        }
    }
    result
}

/// `sceneLocationId(state)`.
pub fn scene_location_id(state: &Value) -> String {
    let scene = state.get("scene");
    let direct = public_text(scene.and_then(|scene| scene.get("location_id").filter(|v| !v.is_null()).or_else(|| scene.get("locationId"))), 120);
    if !direct.is_empty() {
        return direct;
    }
    let current = public_text(state.get("worldMap").and_then(|map| map.get("currentLocationId")), 120);
    if !current.is_empty() {
        return current;
    }
    let expected = public_text(scene.and_then(|scene| scene.get("location")), 120).to_lowercase();
    if expected.is_empty() {
        return String::new();
    }
    let found = state
        .get("worldMap")
        .and_then(|map| map.get("locations"))
        .and_then(Value::as_array)
        .and_then(|locations| locations.iter().find(|location| public_text(location.get("name"), 120).to_lowercase() == expected));
    public_text(found.and_then(|location| location.get("id")), 120)
}

/// `sceneLevelIndex(state)`.
pub fn scene_level_index(state: &Value) -> i64 {
    let index = state.get("scene").and_then(|scene| scene.get("level")).and_then(|level| level.get("index"));
    as_safe_integer(index).filter(|_| index.is_some_and(|value| !value.is_null())).unwrap_or(0)
}

/// `levelKey(locationId, level)`.
pub fn level_key(location_id: &str, level: i64) -> String {
    let base = text(Some(&Value::String(location_id.to_string())), 120, "");
    if base.is_empty() || level == 0 {
        return base;
    }
    let suffix = format!("@L{level}");
    let keep = 120usize.saturating_sub(suffix.chars().count());
    format!("{}{suffix}", base.chars().take(keep).collect::<String>())
}

/// `rememberSceneMap(state, locationId, cells, map)`.
pub fn remember_scene_map(state: &mut Value, location_id: &str, cells: &Value, map: Option<&Value>) {
    let id = text(Some(&Value::String(location_id.to_string())), 120, "");
    let Some(record) = scene_map_record(cells, map.or(Some(&Value::Null)).filter(|value| !value.is_null())) else { return };
    if id.is_empty() {
        return;
    }
    let mut maps = normalize_location_maps(state.get("locationMaps"));
    maps.insert(id, record);
    state["locationMaps"] = Value::Object(maps);
}

/// `rememberCurrentSceneMap(state)`.
pub fn remember_current_scene_map(state: &mut Value) {
    let cells = state.get("scene").and_then(|scene| scene.get("cells")).cloned();
    let Some(Value::Array(list)) = cells else { return };
    if list.is_empty() {
        return;
    }
    let key = level_key(&scene_location_id(state), scene_level_index(state));
    let map = state.get("scene").and_then(|scene| scene.get("map")).cloned();
    remember_scene_map(state, &key, &Value::Array(list), map.as_ref());
}

#[allow(dead_code)]
fn unused(_: i64) -> i64 {
    safe_int(None, 0)
}
