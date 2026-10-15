//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Значения сравниваются строкой `JSON.stringify`, то есть вместе с порядком
//! ключей и записью чисел; крупный выход — SHA-256 той же строки
//! (`fixtures/common.mjs`).

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::{json, Value};
use sk_tactical::tactical_map::{self as t, MapResult, TacticalMap, TacticalMapError};

/// Аргумент `undefined` в эталоне.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Разобрать эталон.
pub fn parse(source: &str) -> Value {
    serde_json::from_str(source).expect("эталон JSON")
}

/// Аргумент случая: `None` — `undefined`.
pub fn arg(value: &Value) -> Option<&Value> {
    (value.as_str() != Some(UNDEFINED)).then_some(value)
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

/// Значение или UNDEFINED.
pub fn encode(value: Option<Value>) -> Value {
    value.unwrap_or_else(|| Value::String(UNDEFINED.into()))
}

/// Ключи всех объектов — в порядке объекта JS.
pub fn assert_js_order(value: &Value, context: &str) {
    match value {
        Value::Object(map) => {
            let keys: Vec<&String> = map.keys().collect();
            let expected = sk_core::js::keys(map);
            assert_eq!(keys, expected, "порядок ключей не как в JS: {context}");
            for item in map.values() {
                assert_js_order(item, context);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_js_order(item, context);
            }
        }
        _ => {}
    }
}

/// Совпадение строкой JSON и порядок ключей.
#[track_caller]
pub fn assert_same(actual: &Value, expected: &Value, context: &str) {
    assert_js_order(actual, context);
    let (actual, expected) = (stringify(actual), stringify(expected));
    if actual != expected {
        panic!("расхождение с JS: {context}\n  Rust: {}\n  JS:   {}", head(&actual), head(&expected));
    }
}

/// Совпадение с эталоном, который хранится целиком или хешем.
#[track_caller]
pub fn assert_same_or_hash(actual: &Value, expected: &Value, context: &str) {
    match expected {
        Value::String(digest) if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            assert_eq!(hash(actual), *digest, "расхождение с JS по хешу: {context}\n  Rust: {}", head(&stringify(actual)));
        }
        _ => assert_same(actual, expected, context),
    }
}

pub fn head(text: &str) -> String {
    text.chars().take(4_000).collect()
}

/// Ошибка карты в форме эталона (`errorOf`).
pub fn error_json(error: &TacticalMapError) -> Value {
    json!({ "name": error.name, "code": if error.name == TacticalMapError::NAME { Value::String(error.code.clone()) } else { Value::Null }, "message": error.message })
}

/// `attempt` генератора: `{ ok }` или `{ error }`.
pub fn attempt(result: MapResult<Value>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error_json(&error) }),
    }
}

/// Карта из сериализованного вида эталона.
pub fn restore(value: &Value) -> TacticalMap {
    t::deserialize_tactical_map(value).expect("карта эталона читается")
}

/// Сериализация карты для сверки.
pub fn serialize(map: &TacticalMap) -> Value {
    t::serialize_tactical_map(map).expect("сериализация карты")
}

/// Как `deserialize(JSON.parse(JSON.stringify(serialize(map))))` в JS.
pub fn round_trip(map: &TacticalMap) -> TacticalMap {
    let text = stringify(&serialize(map));
    restore(&serde_json::from_str(&text).expect("JSON карты"))
}

/// Строковый параметр JS с умолчанием для `undefined`; `null` и не-строка
/// ведут себя в модулях карты как пустая строка.
pub fn option_text<'a>(options: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    match options.get(key) {
        None => fallback,
        Some(Value::String(text)) => text,
        Some(_) => "",
    }
}

/// Параметры `programReport` эталона: `{ minSize, openScene }` или `null`.
pub fn program_options(value: &Value) -> sk_map_core::map_quality::ProgramOptions {
    use sk_map_core::map_quality::{MinSize, ProgramOptions};
    let min_size = value.get("minSize").filter(|size| size.is_object()).map(|size| MinSize {
        width: size["width"].as_i64().expect("ширина мерки"),
        height: size["height"].as_i64().expect("высота мерки"),
    });
    ProgramOptions { min_size, open_scene: sk_core::js::truthy(value.get("openScene")) }
}

/// `programReport(map, program, options)` в форме эталона.
pub fn program_report_call(map: &TacticalMap, input: &Value) -> Value {
    let report = sk_map_core::map_quality::program_report(map, &input["program"], &program_options(&input["options"]));
    json!({ "ok": report.to_json() })
}

/// `auditTacticalMap(map)` в форме эталона.
pub fn audit_call(map: &TacticalMap) -> Value {
    json!({ "ok": sk_map_core::map_quality::audit_tactical_map(map).to_json() })
}

/// Параметры помоста эталона (`null` — по умолчанию).
pub fn dais_options(value: &Value) -> sk_map_core::scene_features::DaisOptions {
    let defaults = sk_map_core::scene_features::DaisOptions::default();
    let int = |key: &str, fallback: i64| value.get(key).map_or(fallback, |number| number.as_i64().expect("целое в параметрах помоста"));
    sk_map_core::scene_features::DaisOptions { height: int("height", defaults.height), depth: int("depth", defaults.depth) }
}

/// `raiseDais(map, zoneId, options)` по записи эталона.
pub fn raise_dais_call(map: &mut TacticalMap, input: &Value) -> Value {
    let zone_id = input["zoneId"].as_str().expect("id зоны");
    attempt(sk_map_core::scene_features::raise_dais(map, zone_id, &dais_options(&input["options"])).map(Value::from))
}

/// `deepestRoom(map)` в форме эталона.
pub fn deepest_room_call(map: &TacticalMap) -> Value {
    json!({ "ok": sk_map_core::scene_features::deepest_room(map).map_or(Value::Null, |room| room.to_json()) })
}

/// `applyRoomFloors(map, options)` по записи эталона: `input.options` —
/// параметры без предиката, `input.zones` — ответ предиката по каждой зоне.
pub fn room_floors_call(map: &mut TacticalMap, input: &Value) -> Value {
    use sk_map_core::room_floors::{apply_room_floors, RoomContext, RoomFloor, RoomFloorsOptions};
    let options = &input["options"];
    let context = RoomContext { use_: option_text(options, "use", ""), architecture: option_text(options, "architecture", "wood") };
    let default_floor = options.get("defaultFloor").filter(|value| value.is_object()).map(|value| RoomFloor {
        material: sk_core::js::s(value.get("material")),
        floor: value.get("floor").and_then(Value::as_str).map(str::to_string),
    });
    let accepted: Option<std::collections::HashMap<String, bool>> = input.get("zones").and_then(Value::as_array).map(|mask| {
        map.zones.iter().zip(mask).map(|(zone, accept)| (zone.id.clone(), accept == &Value::Bool(true))).collect()
    });
    let predicate = |zone: &sk_tactical::tactical_map::TacticalZone| accepted.as_ref().is_some_and(|accepted| accepted.get(&zone.id).copied().unwrap_or(false));
    let options = RoomFloorsOptions {
        context,
        wall: options.get("wall").and_then(Value::as_str),
        default_floor: default_floor.as_ref(),
        zones: if accepted.is_some() { Some(&predicate) } else { None },
    };
    attempt(apply_room_floors(map, &options).map(Value::from))
}
