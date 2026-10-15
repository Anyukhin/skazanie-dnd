//! Сверка `dynamic_map` с эталоном JS (`fixtures/dynamic-map.json`,
//! генератор `fixtures/gen-dynamic-map.mjs`) и проверки
//! `test/map-elevation.test.mjs`, `test/scene-points-of-interest.test.mjs`,
//! `test/tactical-map-contract.test.mjs`, где предмет — сам генератор.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same_or_hash, parse, UNDEFINED};
use serde_json::{json, Value};
use sk_map_core::dynamic_map::{generate_dynamic_scene_map, math_sin, scene_cells_json, SceneCell, SceneCellType};
use sk_tactical::scene_interactions::scene_interaction_catalog_entry;
use sk_tactical::tactical_map::{self as t, LegacyMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/dynamic-map.json")));

fn generate(spec: Value) -> Vec<SceneCell> {
    generate_dynamic_scene_map(Some(&spec)).expect("клетки")
}

#[test]
fn generator_matches_js() {
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 500);
    for (index, case) in cases.iter().enumerate() {
        let spec = (case["spec"].as_str() != Some(UNDEFINED)).then_some(&case["spec"]);
        let context = format!("случай {index}: {}", case["spec"]);
        match generate_dynamic_scene_map(spec) {
            Ok(cells) => {
                assert!(case.get("error").is_none(), "{context}: в JS отказ");
                assert_eq!(cells.len() as u64, case["count"].as_u64().unwrap_or(0), "{context}");
                assert_same_or_hash(&scene_cells_json(&cells), &case["cells"], &context);
                if let Some(features) = case.get("features") {
                    let actual: Vec<String> = cells.iter().filter_map(|cell| cell.feature.as_ref().map(|feature| format!("{},{}:{feature}", cell.x, cell.y))).collect();
                    assert_eq!(json!(actual), *features, "{context}");
                }
            }
            Err(error) => {
                assert_eq!(json!({ "name": error.name, "code": null, "message": error.message }), case["error"], "{context}");
            }
        }
    }
}

#[test]
fn sine_matches_v8_on_every_generator_input() {
    // Дорога моста и тропа луга округляют синус до клетки; на всех входах
    // генератора перенос fdlibm совпадает с `Math.sin` V8 побитно (системный
    // `f64::sin` на Windows — нет: `sin(π)` расходится в последних битах).
    let sines = array(&FIXTURE["sines"]);
    assert_eq!(sines.len(), 444);
    for entry in sines {
        let angle = f64::from_bits(u64::from_str_radix(entry[2].as_str().unwrap_or(""), 16).expect("биты угла"));
        let (width, x) = (entry[0].as_i64().unwrap_or(0), entry[1].as_i64().unwrap_or(0));
        assert_eq!(angle, (x as f64 / (width - 1) as f64) * std::f64::consts::PI * 2.0, "угол {width}/{x}");
        assert_eq!(format!("{:016x}", math_sin(angle).to_bits()), entry[3].as_str().unwrap_or(""), "sin {width}/{x}");
    }
    let parse_bits = |value: &Value| f64::from_bits(u64::from_str_radix(value.as_str().unwrap_or(""), 16).expect("биты"));
    for entry in array(&FIXTURE["randomSines"]) {
        let angle = parse_bits(&entry[0]);
        assert_eq!(math_sin(angle).to_bits(), parse_bits(&entry[1]).to_bits(), "sin({angle:e})");
    }
}

fn raised(cells: &[SceneCell]) -> Vec<String> {
    cells.iter().filter(|cell| cell.elevation.unwrap_or(0) != 0).map(|cell| format!("{}:{}:{}", cell.x, cell.y, cell.elevation.unwrap_or(0))).collect()
}

fn ruins(extra: Value) -> Vec<SceneCell> {
    let mut spec = json!({ "seed": "elev-1", "theme": "руины", "layout": "open", "width": 15, "height": 11 });
    if let (Some(target), Value::Object(extra)) = (spec.as_object_mut(), extra) {
        target.extend(extra);
    }
    generate(spec)
}

#[test]
fn ledges_rise_on_floor_by_five_and_ten_feet() {
    let cells = ruins(json!({}));
    let ledges: Vec<&SceneCell> = cells.iter().filter(|cell| cell.elevation.unwrap_or(0) != 0).collect();
    assert!(ledges.len() >= 2, "возвышенностей {}", ledges.len());
    assert!(ledges.iter().all(|cell| matches!(cell.elevation, Some(5 | 10))));
    assert!(ledges.iter().all(|cell| cell.kind == SceneCellType::Floor));
}

#[test]
fn ledges_are_deterministic_and_spare_the_entrance_road() {
    let first = raised(&ruins(json!({})));
    assert_eq!(raised(&ruins(json!({}))), first);
    assert_ne!(raised(&ruins(json!({ "seed": "elev-2" }))), first);
    let center_y = 11 / 2;
    assert!(!ruins(json!({})).iter().any(|cell| cell.elevation.unwrap_or(0) != 0 && cell.x <= 2 && cell.y == center_y));
    for danger in ["низкая", "средняя", "высокая"] {
        let cells = ruins(json!({ "danger": danger }));
        assert!(cells.iter().all(|cell| cell.elevation.unwrap_or(0) == 0 || cell.kind == SceneCellType::Floor), "{danger}");
        assert!(!raised(&cells).is_empty(), "{danger}: нет площадок");
    }
}

#[test]
fn small_budget_keeps_feature_count_and_two_dictionary_objects() {
    let cells = generate(json!({ "seed": "poi:small-budget", "theme": "дорога", "layout": "winding", "pattern": "bridge", "material": "earth", "featureCount": 3 }));
    let features: Vec<&str> = cells.iter().filter_map(|cell| cell.feature.as_deref()).collect();
    assert_eq!(features.len(), 3);
    assert!(features.iter().filter(|feature| scene_interaction_catalog_entry(Some(&json!(feature))).is_some()).count() >= 2);
    assert!(features.contains(&"stairs"), "обязательный выход нельзя вытеснять точками интереса");
}

#[test]
fn generated_crypt_scene_gets_two_to_four_points_of_interest() {
    for seed in ["poi:crypt:one", "poi:crypt:two", "poi:crypt:three"] {
        let spec = json!({ "seed": seed, "theme": "древний склеп", "danger": "средняя", "layout": "cavern", "pattern": "crypt", "material": "earth", "featureCount": 8 });
        let cells = scene_cells_json(&generate(spec.clone()));
        let map = t::tactical_map_from_legacy_cells(cells.as_array().expect("клетки"), &LegacyMapOptions { seed, ..LegacyMapOptions::default() }).expect("карта");
        let points = map.props.iter().filter(|prop| prop.interaction.as_ref().is_some_and(|interaction| interaction.point_of_interest)).count();
        assert!((2..=4).contains(&points), "{seed}: {points} точек интереса");
        assert_eq!(scene_cells_json(&generate(spec)), cells, "{seed}: тот же сид — та же сцена");
    }
}

#[test]
fn legacy_round_trip_keeps_generator_cells() {
    // Круг через тактическую карту байт в байт — поэтому высота стоит в
    // клетке раньше декора (`tactical-map-contract`).
    for (seed, layout, pattern, theme) in [
        ("shape-cavern", "cavern", "cave-cluster", "пещера"),
        ("shape-radial", "radial", "courtyard", "храм"),
        ("shape-ruins", "ruins", "keep", "руины"),
        ("shape-bridge", "open", "bridge", "мост через ущелье"),
        ("shape-village", "streets", "village", "деревня"),
        ("shape-room", "rooms", "small-room", "таверна"),
        ("shape-hall", "rooms", "great-hall", "дворец"),
        ("shape-crypt", "winding", "crypt", "склеп"),
    ] {
        let spec = json!({ "seed": seed, "layout": layout, "pattern": pattern, "theme": theme, "danger": "средняя", "water": 0.08, "featureCount": 8 });
        let cells = scene_cells_json(&generate(spec));
        let map = t::tactical_map_from_legacy_cells(cells.as_array().expect("клетки"), &LegacyMapOptions::default()).expect("карта");
        assert_eq!(Value::Array(t::legacy_cells_from_tactical_map(&map)), cells, "{seed}");
    }
}

#[test]
fn null_spec_fails_like_destructuring() {
    let error = generate_dynamic_scene_map(Some(&Value::Null)).expect_err("null");
    assert_eq!(error.name, "TypeError");
    assert!(generate_dynamic_scene_map(None).is_ok());
}
