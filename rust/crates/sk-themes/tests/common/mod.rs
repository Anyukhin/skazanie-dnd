//! Сверка с эталонами JS (`fixtures/scene-themes.json`, генератор
//! `fixtures/gen-scene-themes.mjs`).
//!
//! Карты сравниваются SHA-256 строки `JSON.stringify(serializeTacticalMap)`,
//! остальное — строкой `JSON.stringify`, то есть вместе с порядком ключей и
//! записью чисел.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use std::io::Read;
use std::sync::LazyLock;

use serde_json::Value;
use sk_core::js;
use sk_tactical::tactical_map::{serialize_tactical_map, TacticalMap};
use sk_themes::scene_themes::{LayoutOptions, ShortcutLock, ShortcutOptions};

/// Эталон `fixtures/scene-themes.json`.
pub static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../../fixtures/scene-themes.json")));

/// Эталон `fixtures/scene-themes-relief.json.gz`.
pub static RELIEF: LazyLock<Value> = LazyLock::new(|| parse_gz(include_bytes!("../../fixtures/scene-themes-relief.json.gz")));

pub fn parse(source: &str) -> Value {
    serde_json::from_str(source).expect("эталон JSON")
}

pub fn parse_gz(bytes: &[u8]) -> Value {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон gzip");
    parse(&text)
}

/// Массив эталона.
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).expect("массив в эталоне")
}

/// Секция эталона.
pub fn section(name: &str) -> &'static [Value] {
    array(&FIXTURE[name])
}

pub fn stringify(value: &Value) -> String {
    js::stringify(value)
}

pub fn hash(value: &Value) -> String {
    sk_core::hash::sha256_hex(stringify(value))
}

pub fn serialized(map: &TacticalMap) -> Value {
    serialize_tactical_map(map).expect("карта сериализуется")
}

pub fn map_hash(map: &TacticalMap) -> String {
    hash(&serialized(map))
}

pub fn strings(value: &Value) -> Vec<String> {
    array(value).iter().map(|item| item.as_str().expect("строка").to_string()).collect()
}

/// Записать карту Rust для сравнения с `--dump` генератора.
pub fn dump(name: &str, value: &Value) -> String {
    let dir = std::env::temp_dir().join("sk-themes-dumps");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", name.replace(['/', ':', '#', ' ', '\\', '«', '»', '<', '>', '?', '*', '|', '"'], "_")));
    let _ = std::fs::write(&path, stringify(value));
    path.display().to_string()
}

/// Параллельный прогон: `check` по каждому элементу, ошибки — списком.
pub fn par_check<T: Sync>(items: &[T], check: impl Fn(&T) -> Vec<String> + Sync) -> Vec<String> {
    let threads = std::thread::available_parallelism().map_or(4, |count| count.get()).min(16);
    let chunk = items.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = items.chunks(chunk).map(|part| scope.spawn(|| part.iter().flat_map(&check).collect::<Vec<_>>())).collect();
        handles.into_iter().flat_map(|handle| handle.join().expect("поток сверки")).collect()
    })
}

/// Отказ, если список расхождений не пуст (первые десять — в сообщении).
pub fn assert_clean(failures: &[String], total: usize) {
    assert!(failures.is_empty(), "{} расхождений из {total}:\n{}", failures.len(), failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
}

/// Сид параметра раскладки: отсутствие — умолчание, иначе `String(seed)`.
pub fn seed_of(options: &Value, default: &str) -> String {
    match options.get("seed") {
        None => default.to_string(),
        value => js::string(value),
    }
}

/// `{ seed, width, height, locationId }` раскладки из объекта JS.
pub fn layout_options<'a>(options: &'a Value, seed: &'a str) -> LayoutOptions<'a> {
    let number = |key: &str| match options.get(key) {
        None => 26.0,
        value => js::number(value),
    };
    LayoutOptions { seed, width: number("width"), height: number("height"), location_id: options.get("locationId").and_then(Value::as_str).unwrap_or("") }
}

/// Параметры `addShortcutLoops` из объекта JS.
pub fn shortcut_options(options: &Value) -> ShortcutOptions {
    let mut result = ShortcutOptions::default();
    if let Some(limit) = options.get("limit").and_then(Value::as_u64) {
        result.limit = limit as usize;
    }
    if let Some(detour) = options.get("minDetour").and_then(Value::as_i64) {
        result.min_detour = detour;
    }
    if let Some(exclude) = options.get("exclude") {
        result.exclude = strings(exclude);
    }
    if let Some(only) = options.get("only").and_then(Value::as_str) {
        result.only = only.to_string();
    }
    if let Some(prefix) = options.get("idPrefix").and_then(Value::as_str) {
        result.id_prefix = prefix.to_string();
    }
    if let Some(Value::Object(locks)) = options.get("locks") {
        result.locks = locks
            .iter()
            .map(|(zone, lock)| {
                let lock_dc = lock.get("lockDc").and_then(Value::as_i64).unwrap_or(0);
                let key_item_id = lock.get("keyItemId").and_then(Value::as_str).map(str::to_string);
                (zone.clone(), ShortcutLock { lock_dc, key_item_id })
            })
            .collect();
    }
    result
}
