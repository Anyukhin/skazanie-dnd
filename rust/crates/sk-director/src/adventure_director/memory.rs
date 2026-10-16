//! Память мест (`state.locationMaps`), ключи и сиды этажей, публичная память
//! приключения и поля библиотечной сцены — части
//! `server/adventure-director.mjs` без генерации карт.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sk_core::{js, re, text as jstext};
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
    let source: &[Value] = match value {
        Some(Value::Array(items)) => items,
        Some(Value::Object(map)) => match map.get("cells") {
            Some(Value::Array(items)) => items,
            _ => &[],
        },
        _ => &[],
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for raw in source.iter().take(region_max_cells()) {
        let Value::Object(raw) = raw else { continue };
        let (Some(x), Some(y)) = (safe_integer(raw.get("x")), safe_integer(raw.get("y"))) else { continue };
        if !seen.insert((x, y)) {
            continue;
        }
        let mut cell = Map::new();
        cell.insert("x".into(), Value::from(x));
        cell.insert("y".into(), Value::from(y));
        let kind = js::string(raw.get("type"));
        cell.insert("type".into(), Value::String(if MAP_CELL_TYPES.contains(&kind.as_str()) { kind } else { "floor".into() }));
        cell.insert("revealed".into(), Value::Bool(js::is_true(raw.get("revealed"))));
        if let Some(Value::String(feature)) = raw.get("feature") {
            let trimmed = jstext::trim(feature);
            if !trimmed.is_empty() {
                cell.insert("feature".into(), Value::String(head16(trimmed, 40)));
            }
        }
        let material = js::string(raw.get("material"));
        if MAP_MATERIALS.contains(&material.as_str()) {
            cell.insert("material".into(), Value::String(material));
        }
        if let Some(variant) = safe_integer(raw.get("variant")) {
            cell.insert("variant".into(), Value::from(variant.clamp(0, 5)));
        }
        let pattern = js::string(raw.get("pattern"));
        if MAP_PATTERNS.contains(&pattern.as_str()) {
            cell.insert("pattern".into(), Value::String(pattern));
        }
        if let Some(Value::String(mask)) = raw.get("edge_mask") {
            if jstext::test(re!(r"^[nesw]{0,4}$", "u"), mask) {
                cell.insert("edge_mask".into(), Value::String(mask.clone()));
            }
        }
        // Тонкие стены, окна и сторона двери (`legacyCellsFromTacticalMap`):
        // без них запомненная локация вернулась бы домом без перегородок.
        for field in ["walls", "windows"] {
            if let Some(Value::String(sides)) = raw.get(field) {
                if matches!(sides.as_str(), "e" | "s" | "es") {
                    cell.insert(field.into(), Value::String(sides.clone()));
                }
            }
        }
        if let Some(Value::String(door)) = raw.get("door_dir") {
            if door == "e" || door == "s" {
                cell.insert("door_dir".into(), Value::String(door.clone()));
            }
        }
        // Высота помоста и холмов: без неё вернувшийся отряд стоял бы на ровном полу.
        if let Some(elevation) = safe_integer(raw.get("elevation")) {
            if elevation != 0 {
                cell.insert("elevation".into(), Value::from(elevation.clamp(-100, 100)));
            }
        }
        result.push(Value::Object(cell));
    }
    result
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
    let (false, Some(record)) = (id.is_empty(), record) else { return };
    let mut maps = normalize_location_maps(state.get("locationMaps"));
    maps.insert(id, record);
    if let Value::Object(state) = state {
        state.insert("locationMaps".into(), Value::Object(maps));
    }
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
    let scene = prop(Some(state), "scene");
    let cells = match prop(scene, "cells") {
        Some(cells @ Value::Array(items)) if !items.is_empty() => cells.clone(),
        _ => return,
    };
    let map = prop(scene, "map").cloned();
    let key = level_key(&scene_location_id(state), scene_level_index(state));
    remember_scene_map(state, Some(&Value::String(key)), Some(&cells), map.as_ref());
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
