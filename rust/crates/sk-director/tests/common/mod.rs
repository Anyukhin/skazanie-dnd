//! Сверка с эталонами JS (`fixtures/adventure-director.json.gz`, генератор
//! `fixtures/gen-adventure-director.mjs`).
//!
//! Карты, клетки и итог перехода сравниваются SHA-256 строки
//! `JSON.stringify`, остальное — строкой `JSON.stringify`, то есть вместе с
//! порядком ключей и записью чисел.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_director::adventure_director::{entrance_on_side, outside_entrance_for, DirectorError, SceneGeometry};
use sk_map_core::map_quality::audit_tactical_map;
use sk_story::map_library::MapLibrary;
use sk_tactical::tactical_map::{serialize_tactical_map, TacticalMap};

/// Эталон целиком.
pub static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../../fixtures/adventure-director.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    serde_json::from_str(&text).expect("эталон JSON")
});

/// Секция эталона.
pub fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).expect("секция эталона")
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

/// Аргументы случая: `undefined` на позициях `undef` и за концом списка.
pub fn args(entry: &Value) -> Vec<Option<Value>> {
    let undef: Vec<usize> = entry["undef"].as_array().map(|items| items.iter().filter_map(Value::as_u64).map(|index| index as usize).collect()).unwrap_or_default();
    entry["args"].as_array().expect("аргументы").iter().enumerate().map(|(index, value)| (!undef.contains(&index)).then(|| value.clone())).collect()
}

/// Аргумент по номеру (`None` — `undefined`).
pub fn arg(args: &[Option<Value>], index: usize) -> Option<&Value> {
    args.get(index).and_then(Option::as_ref)
}

pub fn error_json(error: &DirectorError) -> Value {
    error.to_json()
}

/// `{ x, y }` или `null`.
pub fn point(point: Option<(i64, i64)>) -> Value {
    point.map_or(Value::Null, |(x, y)| json!({ "x": x, "y": y }))
}

/// Точки входа карты в форме эталона (`entrancesOf`): по сторонам и по пробам.
pub fn entrances(map: &TacticalMap, expected: &Value) -> (Value, Value) {
    let mut sides = Map::new();
    for side in ["west", "east", "north", "south", "up"] {
        sides.insert(side.into(), point(entrance_on_side(map, side)));
    }
    let outside: Vec<Value> = expected["outside"]
        .as_array()
        .map(|probes| {
            probes
                .iter()
                .map(|probe| {
                    let (x, y) = (js::number(probe.get("x")), js::number(probe.get("y")));
                    json!({ "x": probe["x"], "y": probe["y"], "out": point(outside_entrance_for(map, x, y)) })
                })
                .collect()
        })
        .unwrap_or_default();
    (Value::Object(sides), Value::Array(outside))
}

/// `geometryOut` генератора по итогу Rust (пробы `outside` — из эталона).
pub fn geometry_out(geometry: &SceneGeometry, expected: &Value) -> Value {
    let (sides, outside) = entrances(&geometry.map, expected);
    json!({
        "map": hash(&serialized(&geometry.map)),
        "cells": hash(&Value::Array(geometry.cells.clone())),
        "count": geometry.cells.len(),
        "levels": geometry.levels.as_ref().map_or(Value::Null, |levels| Value::Array(levels.iter().map(|level| level.to_json()).collect())),
        "missing": geometry.missing.as_ref().map_or(Value::Null, |missing| js::strings_value(missing.iter().cloned())),
        "library": geometry.library.as_ref().map_or(Value::Null, |library| json!({
            "entry": library.entry["id"],
            "levels": hash(&Value::Array(library.levels.iter().map(|level| level.to_json()).collect())),
        })),
        "audit": audit_tactical_map(&geometry.map).problems.iter().map(|problem| problem.code).collect::<Vec<_>>(),
        "sides": sides,
        "outside": outside,
    })
}

/// `transitionOut` генератора по итогу Rust.
pub fn transition_out(result: &Value) -> Value {
    let mut scene = result["scene"].as_object().cloned().unwrap_or_default();
    let cells = scene.shift_remove("cells").unwrap_or(Value::Null);
    let map = scene.shift_remove("map").unwrap_or(Value::Null);
    let mut rest = result.as_object().cloned().unwrap_or_default();
    rest.shift_remove("scene");
    let world_map = rest.shift_remove("worldMap").unwrap_or(Value::Null);
    if let Some(levels) = rest.get("library_levels").cloned() {
        rest.insert("library_levels".into(), Value::String(hash(&levels)));
    }
    json!({
        "hash": hash(result),
        "scene": Value::Object(scene),
        "cells": hash(&cells),
        "map": hash(&map),
        "worldMap": hash(&world_map),
        "rest": Value::Object(rest),
    })
}

/// Первое расхождение двух объектов эталона — по ключам верхнего уровня.
pub fn diff(label: &str, expected: &Value, actual: &Value) -> Option<String> {
    if stringify(expected) == stringify(actual) {
        return None;
    }
    if let (Value::Object(left), Value::Object(right)) = (expected, actual) {
        for (key, value) in left {
            let other = right.get(key).cloned().unwrap_or(Value::Null);
            if stringify(value) != stringify(&other) {
                let cut = |text: String| text.chars().take(600).collect::<String>();
                return Some(format!("{label}: поле {key}\n  JS:   {}\n  Rust: {}", cut(stringify(value)), cut(stringify(&other))));
            }
        }
    }
    Some(format!("{label}: {} ≠ {}", stringify(expected).chars().take(400).collect::<String>(), stringify(actual).chars().take(400).collect::<String>()))
}

/// Сверка исхода: `{ out }` или `{ error }` эталона против итога Rust.
pub fn check_outcome<T>(label: &str, expected: &Value, actual: Result<T, DirectorError>, shape: impl FnOnce(&T) -> Value) -> Option<String> {
    match (expected.get("error"), actual) {
        (Some(error), Err(actual)) => diff(label, error, &error_json(&actual)),
        (Some(error), Ok(_)) => Some(format!("{label}: JS бросил {}, Rust вернул итог", stringify(error))),
        (None, Err(actual)) => Some(format!("{label}: Rust отказал {}", stringify(&error_json(&actual)))),
        (None, Ok(value)) => diff(label, &expected["out"], &shape(&value)),
    }
}

/// Записать итог Rust для сравнения с `--dump` генератора.
pub fn dump(name: &str, value: &Value) -> String {
    let dir = std::env::temp_dir().join("sk-director-dumps");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", name.replace(['/', ':', '#', ' ', '\\', '«', '»', '<', '>', '?', '*', '|', '"'], "_")));
    let _ = std::fs::write(&path, stringify(value));
    path.display().to_string()
}

/// Параллельный прогон: `check` по каждому элементу, ошибки — списком.
/// Потоков — не больше четырёх: тяжёлые карты, машина владельца занята.
pub fn par_check<T: Sync>(items: &[T], check: impl Fn(&T) -> Vec<String> + Sync) -> Vec<String> {
    let threads = std::thread::available_parallelism().map_or(2, |count| count.get()).clamp(1, 4);
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

// --- библиотеки --------------------------------------------------------------------------

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

/// Библиотека эталона во временном каталоге; каталог удаляется вместе с ней.
pub struct TempLibrary {
    dir: PathBuf,
    pub library: MapLibrary,
}

impl TempLibrary {
    /// Записи и этажи секции `libraries[id]` — через `put`, в порядке эталона.
    pub fn new(id: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sk-director-{}-{}-{id}", std::process::id(), NEXT_DIR.fetch_add(1, Ordering::SeqCst)));
        let library = MapLibrary::new(&dir);
        let source = &FIXTURE["libraries"][id];
        for entry in source["entries"].as_array().expect("записи библиотеки") {
            let levels = &source["levels"][entry["id"].as_str().expect("id записи")];
            library.put(entry, levels).expect("запись библиотеки");
        }
        Self { dir, library }
    }
}

impl Drop for TempLibrary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Библиотеки, которые упоминают случаи секции.
pub struct Libraries {
    items: Vec<(String, TempLibrary)>,
}

impl Libraries {
    pub fn for_cases(cases: &[Value]) -> Self {
        let mut items: Vec<(String, TempLibrary)> = Vec::new();
        for case in cases {
            if let Some(id) = case.get("library").and_then(Value::as_str) {
                if !items.iter().any(|(known, _)| known == id) {
                    items.push((id.to_string(), TempLibrary::new(id)));
                }
            }
        }
        Self { items }
    }

    pub fn get(&self, case: &Value) -> Option<&MapLibrary> {
        let id = case.get("library").and_then(Value::as_str)?;
        self.items.iter().find(|(known, _)| known == id).map(|(_, library)| &library.library)
    }
}
