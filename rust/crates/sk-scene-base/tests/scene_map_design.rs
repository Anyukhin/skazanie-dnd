//! Сверка `scene_map_design` с JS: эталон `fixtures/scene-map-design.json`
//! (`fixtures/gen-scene-map-design.mjs`) и перенесённые проверки
//! `test/scene-map-design.test.mjs`.

mod common;

use std::sync::LazyLock;

use common::Mismatches;
use serde_json::{json, Value};
use sk_scene_base::scene_map_design::*;

static FIXTURE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/scene-map-design.json")).expect("эталон scene-map-design"));

#[test]
fn design_matches_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["cases"].as_array().expect("cases") {
        check.check(&scene_map_design_for(&case["input"]), &case["output"], || format!("{}", case["input"]));
    }
    check.finish("замысел места");
}

#[test]
fn normalize_matches_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["normalize"].as_array().expect("normalize") {
        check.check(&normalize_scene_map_design(&case["input"]), &case["output"], || format!("{}", case["input"]));
    }
    check.finish("нормализация замысла");
}

#[test]
fn world_location_context_matches_js() {
    let worlds = FIXTURE["worlds"].as_array().expect("worlds");
    let mut check = Mismatches::new();
    for case in FIXTURE["contexts"].as_array().expect("contexts") {
        let world = &worlds[case["worldIndex"].as_u64().expect("номер") as usize];
        let location = Some(&case["location"]).filter(|value| !value.is_null());
        let actual = world_location_design_context(world, Some(&case["locationId"]), location);
        check.check(&serde_json::to_value(actual).expect("json"), &case["output"], || format!("{} / {}", case["locationId"], case["location"]));
    }
    for case in FIXTURE["syntheticCases"].as_array().expect("synthetic") {
        let location_id = Some(&case["locationId"]).filter(|value| value.as_str() != Some("__undefined__"));
        let location = Some(&case["location"]).filter(|value| !value.is_null());
        let actual = world_location_design_context(&FIXTURE["synthetic"], location_id, location);
        check.check(&serde_json::to_value(actual).expect("json"), &case["output"], || format!("{} / {}", case["locationId"], case["location"]));
    }
    check.finish("точка карты мира");
}

// --- Перенесённые проверки test/scene-map-design.test.mjs --------------------

#[test]
fn design_accepts_only_bounded_traits() {
    let design = normalize_scene_map_design(&json!({
        "topology": "harbor", "density": "dense", "architecture": "stone",
        "climate": "lava", "building_use": "teleport", "seed": "forged", "houses": [{ "x": 1, "y": 1 }], "hp": 900,
    }));
    assert_eq!(design, json!({ "topology": "harbor", "architecture": "stone", "density": "dense" }));
    assert_eq!(normalize_scene_map_design(&Value::Null), json!({}));
}

#[test]
fn port_and_river_canon_beat_model_request() {
    let request = json!({ "design": { "topology": "crossroads", "climate": "cold" } });
    assert_eq!(scene_map_design_for(&json!({ "worldKind": "port", "location": "Мормар", "request": request }))["topology"], "harbor");
    let river = scene_map_design_for(&json!({ "worldKind": "city", "location": "Два Берега", "description": "Город на слиянии двух рек.", "request": request }));
    assert_eq!(river["topology"], "river");
    assert_eq!(river["density"], "dense");
}

#[test]
fn local_climate_beats_model_and_mixed_world() {
    let world = "На юге пустыня, на севере снежная тундра.";
    assert_eq!(scene_map_design_for(&json!({ "biome": "plains", "worldDescription": world, "seed": "plain" }))["climate"], "temperate");
    let desert = scene_map_design_for(&json!({ "biome": "desert", "worldKind": "village", "worldDescription": world, "request": { "design": { "climate": "cold" } } }));
    assert_eq!(desert["climate"], "arid");
    assert_eq!(desert["architecture"], "sand");
    assert_eq!(desert["density"], "sparse");
    assert_eq!(scene_map_design_for(&json!({ "biome": "marsh" }))["climate"], "wetland");
}

#[test]
fn portal_is_not_port_and_fun_is_not_village() {
    let design = scene_map_design_for(&json!({ "location": "Город порталов", "description": "Здесь весело, реконструкция рынка уже закончилась.", "worldKind": "city" }));
    assert_ne!(design["topology"], "harbor");
    assert_ne!(design["topology"], "river");
    assert_eq!(design["density"], "dense");
    let dry = scene_map_design_for(&json!({ "location": "Высохшее русло", "description": "Река пересохла, район без реки.", "worldKind": "city" }));
    assert_ne!(dry["topology"], "river");
}

#[test]
fn public_context_belongs_to_chosen_place_and_hides_secrets() {
    let map = json!({ "regions": [{ "id": "south", "biome": "desert" }], "locations": [
        { "id": "port", "name": "Мормар", "known": true, "summary": "Гавань", "history": "Старые верфи", "regionId": "south" },
        { "id": "hidden", "name": "Тайник", "known": false, "summary": "SECRET" },
    ] });
    assert_eq!(
        world_location_design_context(&map, Some(&json!("port")), None),
        LocationDesignContext { description: "Гавань Старые верфи".into(), biome: "desert".into() }
    );
    assert_eq!(world_location_design_context(&map, Some(&json!("hidden")), None), LocationDesignContext::default());
    let input = json!({ "location": "Трактир у дороги", "seed": "repeat" });
    assert_eq!(scene_map_design_for(&input), scene_map_design_for(&input));
}

#[test]
fn dam_and_sluices_are_water_edge() {
    let dam = json!({ "location": "Смотровая дамба", "description": "Кирпичная дамба над соляными полями, у шлюзов толпа." });
    assert_eq!(scene_map_design_for(&dam)["topology"], "harbor");
    assert_eq!(scene_map_design_for(&json!({ "location": "Старая плотина" }))["topology"], "harbor");
    assert_ne!(scene_map_design_for(&json!({ "location": "Амбары у мельницы" }))["topology"], "harbor", "«амбар» не «дамба»");
}
