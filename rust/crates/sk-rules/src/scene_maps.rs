//! Память карт локаций (`state.locationMaps`) для движка — тонкий слой над
//! переносом `server/adventure-director.mjs` в `sk-director`. Задача Р4б.
//!
//! После каждого события текущая карта сцены записывается в
//! `state.locationMaps` под ключом места и этажа (`rememberCurrentSceneMap`).
//! Прежняя частная копия расходилась с JS (обрезка по символам, а не по
//! единицам UTF-16; `split_whitespace` вместо `\s` JS; порядок проверок
//! клетки) — теперь все функции идут из `sk-director`, сверенного с JS.

use serde_json::{Map, Value};

use sk_director::adventure_director as director;

/// `normalizeLocationMaps(value)`.
pub fn normalize_location_maps(value: Option<&Value>) -> Map<String, Value> {
    director::normalize_location_maps(value)
}

/// `sceneLocationId(state)`.
pub fn scene_location_id(state: &Value) -> String {
    director::scene_location_id(state)
}

/// `sceneLevelIndex(state)`.
pub fn scene_level_index(state: &Value) -> i64 {
    director::scene_level_index(state)
}

/// `levelKey(locationId, level)`.
pub fn level_key(location_id: &str, level: i64) -> String {
    director::level_key(location_id, level)
}

/// `rememberSceneMap(state, locationId, cells, map)`: `map` `None` — аргумент
/// не передан (карта берётся из записи клеток, у массива её нет).
pub fn remember_scene_map(state: &mut Value, location_id: &str, cells: &Value, map: Option<&Value>) {
    director::remember_scene_map(state, Some(&Value::String(location_id.to_string())), Some(cells), map);
}

/// `rememberCurrentSceneMap(state)`.
pub fn remember_current_scene_map(state: &mut Value) {
    director::remember_current_scene_map(state);
}

/// `sceneMapForLocation(locationMaps, key)`: нормализованные клетки места.
pub fn scene_map_for_location(location_maps: Option<&Value>, key: &str) -> Option<Vec<Value>> {
    director::scene_map_for_location(location_maps, Some(&Value::String(key.to_string())))
}

/// `sceneTacticalMapForLocation(locationMaps, key)`: законсервированная карта
/// этажа без нормализации клеток.
pub fn scene_tactical_map_for_location(location_maps: Option<&Value>, key: &str) -> Option<Value> {
    director::scene_tactical_map_for_location(location_maps, Some(&Value::String(key.to_string())))
}
