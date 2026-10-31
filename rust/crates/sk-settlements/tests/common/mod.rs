//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Карты сравниваются SHA-256 строки `JSON.stringify(serializeTacticalMap)`,
//! остальное — строкой `JSON.stringify`, то есть вместе с порядком ключей и
//! записью чисел.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::{json, Value};
use sk_tactical::tactical_map::{serialize_tactical_map, TacticalMap, TacticalMapError};

/// Разобрать эталон.
pub fn parse(source: &str) -> Value {
    serde_json::from_str(source).expect("эталон JSON")
}

/// Массив эталона.
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).expect("массив в эталоне")
}

/// `JSON.stringify(value)` байт в байт.
pub fn stringify(value: &Value) -> String {
    sk_core::js::stringify(value)
}

/// SHA-256 `JSON.stringify(value)`.
pub fn hash(value: &Value) -> String {
    sk_core::hash::sha256_hex(stringify(value))
}

/// Сериализованная карта.
pub fn serialized(map: &TacticalMap) -> Value {
    serialize_tactical_map(map).expect("карта сериализуется")
}

/// Хеш сериализованной карты, как `hash(serializeTacticalMap(map))` генератора.
pub fn map_hash(map: &TacticalMap) -> String {
    hash(&serialized(map))
}

/// Исключение в форме эталона (`errorOf`): у `TypeError` в JS кода нет.
pub fn error_json(error: &TacticalMapError) -> Value {
    json!({ "name": error.name, "code": if error.name == TacticalMapError::NAME { Value::String(error.code.clone()) } else { Value::Null }, "message": error.message })
}

/// ГПСЧ mulberry32 — тот же, что `fixtures/common.mjs`.
pub fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_add(0x6d2b_79f5);
        let mut t = state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// Записать карту Rust для сравнения с `--dump` генератора.
pub fn dump(name: &str, value: &Value) -> String {
    let dir = std::env::temp_dir().join("sk-settlements-dumps");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", name.replace(['/', ':', '#', ' ', '\\'], "_")));
    let _ = std::fs::write(&path, stringify(value));
    path.display().to_string()
}
