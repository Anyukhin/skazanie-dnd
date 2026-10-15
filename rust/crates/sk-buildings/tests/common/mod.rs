//! Сверка с эталонами JS (`fixtures/*.json`, генератор
//! `fixtures/gen-building-generator.mjs`).
//!
//! Карты сравниваются SHA-256 строки `JSON.stringify(serializeTacticalMap)`,
//! остальное — строкой `JSON.stringify`, то есть вместе с порядком ключей и
//! записью чисел.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use std::io::Read;
use std::sync::LazyLock;

use serde_json::Value;
use sk_buildings::building_generator::{
    build_ares_fortress_scene, build_building_scene, generate_ares_fortress_scene, generate_building_scene, safe_room, BuildingError,
};
use sk_tactical::tactical_map::{serialize_tactical_map, TacticalMap};

/// Эталон `fixtures/building-generator.json`.
pub static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../../fixtures/building-generator.json")));

/// Разобрать эталон.
pub fn parse(source: &str) -> Value {
    serde_json::from_str(source).expect("эталон JSON")
}

/// Разобрать сжатый эталон.
pub fn parse_gz(bytes: &[u8]) -> Value {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон gzip");
    parse(&text)
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

/// Хеш сериализованной карты, как `hash(serializeTacticalMap(map))` эталона.
pub fn map_hash(map: &TacticalMap) -> String {
    hash(&serialized(map))
}

/// Итог вызова случая: карта, ступень отката и предупреждения сборки.
pub struct Built {
    pub map: TacticalMap,
    pub fallback: Option<&'static str>,
    pub warnings: Option<Vec<String>>,
}

/// Вызов функции эталона (`fn` случая) с его входом.
pub fn run(function: &str, options: &Value) -> Result<Built, BuildingError> {
    let scene = |scene: sk_buildings::building_generator::BuildingScene| Built { map: scene.map, fallback: Some(scene.fallback), warnings: Some(scene.warnings) };
    let map = |map: TacticalMap| Built { map, fallback: None, warnings: None };
    match function {
        "build" => build_building_scene(options).map(scene),
        "generate" => generate_building_scene(options).map(map),
        "ares" => generate_ares_fortress_scene(options).map(map),
        "aresBuild" => build_ares_fortress_scene(options).map(scene),
        "safeRoom" => safe_room(options).map(map),
        other => panic!("неизвестная функция {other}"),
    }
}

/// Случай эталона по метке.
pub fn case(label: &str) -> &'static Value {
    array(&FIXTURE["cases"]).iter().find(|case| case["label"] == label).unwrap_or_else(|| panic!("нет случая {label}"))
}

/// Карта случая эталона.
pub fn build_case(label: &str) -> Built {
    let case = case(label);
    run(case["fn"].as_str().expect("функция"), &case["options"]).unwrap_or_else(|error| panic!("{label}: {error}"))
}

/// Записать карту Rust для сравнения с `--dump` генератора.
pub fn dump(name: &str, value: &Value) -> String {
    let dir = std::env::temp_dir().join("sk-buildings-dumps");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", name.replace(['/', ':', '#', ' ', '\\', '«', '»'], "_")));
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
