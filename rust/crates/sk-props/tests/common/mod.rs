//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Карта на входе — сериализованная форма JS; на выходе сравнивается SHA-256
//! строки `JSON.stringify(serializeTacticalMap(map))` — вместе с порядком
//! ключей и записью чисел. Значения, которых нет в JSON, в аргументах
//! записаны объектом `{"$js": "Infinity"}`.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use std::io::Read;

use serde_json::{json, Value};
use sk_core::js;
use sk_props::prop_placement::{
    attach_prop_supports, ensure_prop_access, place_colonnade, place_props, place_required_props, seat_around_surface, RequiredProps, SeatOptions, SeatSurface,
    ZonePlacementPlan, DEFAULT_MAX_PROPS,
};
use sk_props::scene_dressing::{
    mark_low_furniture, place_ruins, place_ruins_field, place_vignettes, roughen_ground, RoughKind, RoughOptions, RuinsFieldOptions, RuinsOptions, VignetteOptions,
};
use sk_tactical::tactical_map::{deserialize_tactical_map, serialize_tactical_map, TacticalMap, TacticalMapError};

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

/// SHA-256 `JSON.stringify(serializeTacticalMap(map))`.
pub fn map_hash(map: &TacticalMap) -> String {
    let serialized = serialize_tactical_map(map).expect("карта сериализуется");
    sk_core::hash::sha256_hex(sk_core::js::stringify(&serialized))
}

/// Карта из сериализованной формы JS.
pub fn restore(value: &Value) -> TacticalMap {
    deserialize_tactical_map(value).expect("карта эталона читается")
}

/// Число из аргумента эталона: `{"$js": "Infinity"}` и т. п.
pub fn js_number(value: &Value) -> Option<f64> {
    let marker = value.get("$js")?.as_str()?;
    Some(match marker {
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => f64::NAN,
    })
}

/// Заявка зоны из аргумента эталона: `ZonePlacementPlan::from_json` плюс
/// бесконечные потолки, которых нет в JSON.
pub fn plan(value: &Value) -> Option<ZonePlacementPlan> {
    let mut cleaned = value.clone();
    if let Some(caps) = cleaned.get_mut("caps").and_then(Value::as_object_mut) {
        for cap in caps.values_mut() {
            if js_number(cap).is_some() {
                *cap = Value::from(0);
            }
        }
    }
    let mut plan = ZonePlacementPlan::from_json(&cleaned)?;
    if let Some(caps) = value.get("caps").and_then(Value::as_object) {
        for (key, cap) in caps {
            if let Some(number) = js_number(cap) {
                if let Some(entry) = plan.caps.iter_mut().find(|(id, _)| id == key) {
                    entry.1 = Some(number);
                }
            }
        }
    }
    Some(plan)
}

/// Аргументы `placeProps(map, { seed, zones, maxProps })`.
pub fn place_options(value: &Value) -> (String, Vec<ZonePlacementPlan>, i64) {
    let seed = sk_core::js::s(value.get("seed"));
    let zones = value.get("zones").and_then(Value::as_array).map(|zones| zones.iter().filter_map(plan).collect()).unwrap_or_default();
    let max_props = match value.get("maxProps") {
        Some(Value::Number(number)) => number.as_f64().map_or(DEFAULT_MAX_PROPS, |number| number as i64),
        _ => DEFAULT_MAX_PROPS,
    };
    (seed, zones, max_props)
}

/// Требования `placeRequiredProps`.
pub fn required(value: &Value) -> Vec<RequiredProps> {
    array(value).iter().map(RequiredProps::from_json).collect()
}

/// Отказ JS из эталона против отказа Rust.
pub fn assert_error(expected: &Value, actual: &TacticalMapError, context: &str) {
    assert_eq!(expected["name"].as_str(), Some(actual.name), "имя отказа: {context}");
    assert_eq!(expected["code"].as_str(), Some(actual.code.as_str()), "код отказа: {context}");
    assert_eq!(expected["message"].as_str(), Some(actual.message.as_str()), "текст отказа: {context}");
}

/// Вызов функции модуля по имени случая. Ответ — как в эталоне: `$map` для
/// функций, возвращающих карту, иначе число.
pub fn run_placement(map: &mut TacticalMap, op: &str, args: &Value) -> Result<Value, TacticalMapError> {
    match op {
        "placeProps" => {
            let (seed, zones, max_props) = place_options(&args[0]);
            place_props(map, &seed, &zones, max_props)?;
            Ok(json!("$map"))
        }
        "ensurePropAccess" => {
            ensure_prop_access(map);
            Ok(json!("$map"))
        }
        "attachPropSupports" => {
            attach_prop_supports(map)?;
            Ok(json!("$map"))
        }
        "placeColonnade" => {
            let options = &args[0];
            let zone_id = js::s(options.get("zoneId"));
            let asset_id = options.get("assetId").and_then(Value::as_str).unwrap_or("pillar");
            let prefix = options.get("idPrefix").and_then(Value::as_str).unwrap_or("colonnade");
            Ok(json!(place_colonnade(map, &zone_id, asset_id, prefix)))
        }
        "seatAroundSurface" => {
            let options = &args[1];
            let surface = SeatSurface::from_json(&args[0]);
            let items: Vec<Value> = match options.get("blocked") {
                Some(Value::Array(items)) => items.clone(),
                Some(set) => set.get("items").and_then(Value::as_array).cloned().unwrap_or_default(),
                None => Vec::new(),
            };
            let blocked = items
                .iter()
                .filter_map(|item| {
                    let (x, y) = item.as_str()?.split_once(',')?;
                    Some((x.parse().ok()?, y.parse().ok()?))
                })
                .collect();
            let spec = options.get("spec").and_then(Value::as_array).map(|spec| {
                spec.iter().map(|entry| (js::s(entry.get(0)), entry.get(1).and_then(Value::as_f64).unwrap_or(0.0) as usize)).collect()
            });
            let prefix = js::s(options.get("idPrefix"));
            let fixed = options.get("randomValue").and_then(Value::as_f64);
            let mut constant = move || fixed.unwrap_or(0.5);
            let random: Option<&mut dyn FnMut() -> f64> = if fixed.is_some() { Some(&mut constant) } else { None };
            let added = seat_around_surface(map, &surface, SeatOptions { id_prefix: &prefix, blocked, spec, random });
            Ok(Value::Array(added.iter().map(|prop| prop.to_json()).collect()))
        }
        "placeRequiredProps" => {
            let seed = js::s(args[1].get("seed"));
            Ok(json!(place_required_props(map, &required(&args[0]), &seed)?))
        }
        other => panic!("неизвестная операция эталона: {other}"),
    }
}

/// Строки списка аргумента (`string[]`); `None` — не массив (`null`).
fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| items.iter().map(|item| js::s(Some(item))).collect())
}

/// Вызов функции `scene-dressing` по имени случая; ответ — как в эталоне.
/// Умолчания — как у деструктуризации JS (только для отсутствующего поля).
pub fn run_dressing(map: &mut TacticalMap, op: &str, args: &Value) -> Value {
    let options = &args[0];
    let seed = js::s(options.get("seed"));
    let zones = strings(options.get("zones"));
    match op {
        "placeVignettes" => {
            let set = js::s(options.get("set"));
            let text = js::s(options.get("text"));
            let vignette = VignetteOptions {
                seed: &seed,
                set: &set,
                zones: zones.as_deref(),
                limit: options.get("limit").and_then(Value::as_i64).unwrap_or(1),
                text: &text,
                hug_walls: options.get("hugWalls").and_then(Value::as_bool).unwrap_or(false),
            };
            json!(place_vignettes(map, &vignette))
        }
        "roughenGround" => {
            let kind = RoughKind::parse(options["kind"].as_str().unwrap_or_default()).expect("вид трудной местности");
            let patches = options.get("patches").and_then(Value::as_u64).unwrap_or(2) as usize;
            json!(roughen_ground(map, &RoughOptions { seed: &seed, kind, zones: zones.as_deref(), patches }))
        }
        "markLowFurniture" => {
            let ids = strings(Some(options)).unwrap_or_default();
            let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
            json!(mark_low_furniture(map, &ids))
        }
        "placeRuins" => {
            let zone = options.get("zone").and_then(Value::as_str).unwrap_or("field");
            let shape = options.get("shape").and_then(Value::as_str);
            let index = options.get("index").and_then(Value::as_i64).unwrap_or(1);
            place_ruins(map, &RuinsOptions { seed: &seed, zone, shape, index }).map_or(Value::Null, |ruins| ruins.to_json())
        }
        "placeRuinsField" => {
            let field = RuinsFieldOptions {
                seed: &seed,
                zone: options.get("zone").and_then(Value::as_str).unwrap_or("field"),
                asked: options.get("asked").and_then(Value::as_bool).unwrap_or(false),
                chance: options.get("chance").and_then(Value::as_f64).unwrap_or(0.4),
            };
            json!(place_ruins_field(map, &field))
        }
        other => panic!("неизвестная операция эталона: {other}"),
    }
}

