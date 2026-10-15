//! Сверка `scene_interactions` с эталоном JS (`fixtures/scene-interactions.json`,
//! генератор `fixtures/gen-scene-interactions.mjs`) и перенос проверок модуля
//! из `test/scene-interactions.test.mjs`.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, parse, stringify};
use serde_json::{json, Value};
use sk_tactical::scene_interactions as m;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/scene-interactions.json")));

#[test]
fn catalog_lists_match_js() {
    assert_eq!(FIXTURE["policyId"], m::SCENE_INTERACTION_POLICY_ID);
    assert_eq!(json!(m::scene_interaction_asset_ids()), FIXTURE["assetIds"]);
    assert_eq!(json!(m::scene_interaction_fallback_assets()), FIXTURE["fallbackAssets"]);
    assert_eq!(json!(m::scene_interaction_reward_kinds()), FIXTURE["rewardKinds"]);
}

#[test]
fn asset_catalog_matches_js() {
    for case in array(&FIXTURE["assets"]) {
        let asset_id = arg(&case["assetId"]);
        let context = format!("assetId {}", stringify(&case["assetId"]));
        assert_eq!(m::is_scene_shrine_asset(asset_id), case["shrine"].as_bool().unwrap(), "{context}");
        assert_eq!(json!(m::scene_shrine_verbs_for(asset_id)), case["shrineVerbs"], "{context}");
        assert_eq!(m::scene_object_label_for(asset_id), case["label"].as_str().unwrap(), "{context}");
        let entry = m::scene_interaction_catalog_entry(asset_id).map_or(Value::Null, |entry| entry.to_json());
        assert_same(&entry, &case["catalog"], &context);
    }
}

#[test]
fn metadata_for_prop_matches_js() {
    for case in array(&FIXTURE["metadataForProp"]) {
        let result = m::interaction_metadata_for_prop(case["mapSeed"].as_str().unwrap(), arg(&case["prop"]), case["pointOfInterest"].as_bool().unwrap());
        assert_same(&result.map_or(Value::Null, |value| value.to_json()), &case["result"], &stringify(case));
    }
}

#[test]
fn metadata_lists_and_definitions_match_js() {
    let mut points = 0;
    for case in array(&FIXTURE["lists"]) {
        let seed = case["mapSeed"].as_str().unwrap();
        let props = array(&case["props"]);
        let metadata: Vec<Value> = m::scene_interaction_metadata(seed, props).into_iter().map(|(id, value)| json!([id, value.to_json()])).collect();
        points += metadata.iter().filter(|entry| entry[1]["pointOfInterest"] == true).count();
        assert_same(&Value::Array(metadata), &case["metadata"], &format!("metadata {}", stringify(&case["props"])));
        for definition in array(&case["definitions"]) {
            let result = m::scene_interaction_definition(seed, props, arg(&definition["propId"])).unwrap_or(Value::Null);
            assert_same(&result, &definition["result"], &format!("definition {} в {}", stringify(&definition["propId"]), stringify(&case["props"])));
        }
    }
    assert!(points > 300, "точек интереса: {points}");
}

#[test]
fn loot_matches_js() {
    for case in array(&FIXTURE["loot"]) {
        match m::scene_object_loot(case["mapSeed"].as_str().unwrap(), Some(&case["prop"])) {
            Ok(items) => assert_same(&Value::Array(items), &case["result"], &stringify(case)),
            Err(error) => panic!("Rust отказал ({error}), JS: {}", stringify(case)),
        }
    }
}

#[test]
fn text_operations_match_js() {
    let mut recognized = 0;
    for case in array(&FIXTURE["operations"]) {
        let result = m::scene_object_operation_from_text(arg(&case["text"])).map_or(Value::Null, |operation| operation.to_json());
        recognized += usize::from(!result.is_null());
        assert_same(&result, &case["result"], &format!("текст {}", stringify(&case["text"])));
    }
    assert!(recognized > 600, "распознано: {recognized}");
}

#[test]
fn nearest_commands_match_js() {
    let mut commands = 0;
    for case in array(&FIXTURE["nearest"]) {
        let result = m::nearest_scene_object_command(Some(&case["props"]), arg(&case["actorPosition"]), arg(&case["text"])).unwrap_or(Value::Null);
        commands += usize::from(!result.is_null());
        assert_same(&result, &case["result"], &stringify(case));
    }
    assert!(commands > 100, "команд: {commands}");
}

#[test]
fn distances_match_js() {
    for case in array(&FIXTURE["distances"]) {
        let distance = m::scene_object_distance(arg(&case["prop"]), arg(&case["actorPosition"]));
        let expected = if case["distance"] == "Infinity" { f64::INFINITY } else { case["distance"].as_f64().unwrap() };
        assert_eq!(distance, expected, "{}", stringify(case));
    }
}

#[test]
fn narration_matches_js() {
    for case in array(&FIXTURE["narration"]) {
        assert_eq!(m::scene_interaction_narration(arg(&case["events"])), case["text"].as_str().unwrap(), "{}", stringify(&case["events"]));
    }
}

/// `test/scene-interactions.test.mjs`: metadata детерминирована, выбирает
/// 2–4 точки интереса и не доверяет входному `interaction`.
#[test]
fn metadata_is_deterministic_and_ignores_forged_interaction() {
    let props: Vec<Value> = ["chest", "barrel", "crate", "altar", "rune", "statue", "campfire", "bookshelf", "table", "bones"]
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            json!({ "id": format!("prop-{index}"), "assetId": asset, "interaction": { "kind": "forged", "verbs": ["steal"], "pointOfInterest": true, "detailKey": "secret", "rewardKey": "wish" } })
        })
        .collect();
    let first = m::scene_interaction_metadata("metadata-seed", &props);
    let second = m::scene_interaction_metadata("metadata-seed", &props);
    assert_eq!(first, second);
    let points: Vec<_> = first.values().filter(|metadata| metadata.point_of_interest).collect();
    assert!((2..=4).contains(&points.len()));
    assert!(points.iter().all(|metadata| !metadata.detail_key.is_empty() && !metadata.reward_key.is_empty()));
    assert!(first.values().all(|metadata| metadata.kind != "forged" && !metadata.verbs.contains(&"steal")));
    assert_eq!(m::interaction_metadata_for_prop("metadata-seed", Some(&props[0]), true).unwrap().kind, "container");
}

/// Свободный текст распознаёт силовое открытие и выбирает ближайшую бочку;
/// составные варианты канонического предмета тоже узнаются.
#[test]
fn text_picks_nearest_barrel() {
    assert_eq!(
        m::scene_object_operation_from_text(Some(&json!("Разбить бочку топором"))).unwrap().to_json(),
        json!({ "intent": "open", "approach": "force", "aliases": ["barrel"] })
    );
    let props = json!([
        { "id": "far", "assetId": "barrel", "x": 4.5, "y": 0.5, "footprint": [{ "x": 4, "y": 0 }] },
        { "id": "near", "assetId": "barrel", "x": 1.5, "y": 0.5, "footprint": [{ "x": 1, "y": 0 }] },
    ]);
    let command = m::nearest_scene_object_command(Some(&props), Some(&json!({ "x": 0, "y": 0 })), Some(&json!("Разбить бочку топором")));
    assert_eq!(command, Some(json!({ "command_type": "OperateSceneObject", "prop_id": "near", "intent": "open", "approach": "force" })));
    for (asset, text, intent) in [("table_small", "Осмотреть стол", "inspect"), ("barrel_stack", "Разбить бочку топором", "open"), ("crate_stack", "Открыть ящик", "open")] {
        assert!(m::scene_interaction_catalog_entry(Some(&json!(asset))).is_some(), "{asset}");
        let props = json!([{ "id": format!("prop-{asset}"), "assetId": asset, "x": 1.5, "y": 0.5, "footprint": [{ "x": 1, "y": 0 }] }]);
        let command = m::nearest_scene_object_command(Some(&props), Some(&json!({ "x": 0, "y": 0 })), Some(&json!(text))).unwrap();
        assert_eq!(command["intent"], intent);
    }
}

#[test]
fn scene_interaction_memory_normalizes_like_engine() {
    for case in array(&FIXTURE["normalize"]) {
        assert_same(&m::normalize_scene_interactions(arg(&case["input"])), &case["result"], &stringify(&case["input"]));
    }
}
