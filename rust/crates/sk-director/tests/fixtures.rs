//! Эталоны JS `fixtures/adventure-director.json.gz`: каждая секция —
//! отдельный тест, случаи сверяются параллельно.

mod common;

use common::*;
use serde_json::{json, Value};
use sk_director::adventure_director::*;
use sk_tactical::tactical_map::deserialize_tactical_map;

fn library_geometry(value: &Value) -> LibraryGeometry {
    let levels = value["levels"]
        .as_array()
        .map(|levels| {
            levels
                .iter()
                .map(|level| LibraryLevel { index: sk_core::js::number(level.get("index")), label: level["label"].as_str().unwrap_or("").to_string(), map: level["map"].clone() })
                .collect()
        })
        .unwrap_or_default();
    LibraryGeometry { entry: value["entry"].clone(), levels }
}

/// Вызов помощника памяти мест по имени JS.
fn memory_call(fn_name: &str, args: &[Option<Value>]) -> Result<Value, DirectorError> {
    let a = |index: usize| arg(args, index);
    Ok(match fn_name {
        "normalizeLocationMaps" => Value::Object(normalize_location_maps(a(0))),
        "sceneMapForLocation" => scene_map_for_location(a(0), a(1)).map_or(Value::Null, Value::Array),
        "sceneTacticalMapForLocation" => scene_tactical_map_for_location(a(0), a(1)).unwrap_or(Value::Null),
        "sceneLocationId" => Value::String(scene_location_id(a(0).unwrap_or(&json!({})))),
        "rememberSceneMap" => {
            let mut state = a(0).cloned().unwrap_or(Value::Null);
            remember_scene_map(&mut state, a(1), a(2), if args.len() > 3 && args[3].is_some() { a(3) } else { None });
            state
        }
        "rememberCurrentSceneMap" => {
            let mut state = a(0).cloned().unwrap_or(Value::Null);
            remember_current_scene_map(&mut state);
            state
        }
        "sceneLevelIndex" => Value::from(scene_level_index(a(0).unwrap_or(&Value::Null))),
        "levelKey" => Value::String(level_key_js(a(0), a(1))),
        "levelSeed" => Value::String(level_seed_js(a(0), a(1))),
        "knownWorldKind" => Value::String(known_world_kind(a(0), a(1), a(2))),
        "stableLocationMapSeed" => Value::String(stable_location_map_seed(a(0), a(1), a(2))),
        "publicAdventureMemory" => Value::Object(public_adventure_memory(a(0))),
        "entrySideToward" => Value::String(entry_side_toward(a(0), a(1), a(2)).into()),
        "openingEntrySide" => Value::String(opening_entry_side(a(0), a(1)).into()),
        "librarySceneFields" => Value::Object(library_scene_fields(&library_geometry(a(0).unwrap_or(&Value::Null)))),
        other => panic!("неизвестная функция эталона: {other}"),
    })
}

#[test]
fn memory_helpers_match_js() {
    let cases = section("memory");
    let failures = par_check(cases, |case| {
        let fn_name = case["fn"].as_str().expect("fn");
        let label = format!("{fn_name} {}", stringify(&case["args"]).chars().take(200).collect::<String>());
        let args = args(case);
        // `rememberSceneMap(state, id, cells)` без четвёртого аргумента — `undefined`.
        check_outcome(&label, case, memory_call(fn_name, &args), |value| value.clone()).into_iter().collect()
    });
    assert_clean(&failures, cases.len());
    assert!(cases.len() > 1500, "случаев памяти мест: {}", cases.len());
}

fn geometry_case(case: &Value, libraries: &Libraries) -> Option<String> {
    let label = case["label"].as_str().unwrap_or("?");
    let library = libraries.get(case);
    let input = &case["input"];
    let failure = if case["fn"] == "cells" {
        check_outcome(label, case, generate_scene_cells_with(input, library), |cells| json!({ "cells": hash(&Value::Array(cells.clone())), "count": cells.len() }))
    } else {
        let expected = case.get("out").cloned().unwrap_or(Value::Null);
        check_outcome(label, case, generate_scene_geometry_with(input, library), |geometry| geometry_out(geometry, &expected))
    };
    if failure.is_some() {
        if let Ok(geometry) = generate_scene_geometry_with(input, library) {
            if let Ok(json) = geometry.to_json() {
                let path = dump(label, &json);
                return failure.map(|failure| format!("{failure}\n  итог Rust: {path}"));
            }
        }
    }
    failure
}

fn geometry_section(prefix: &str) {
    let cases: Vec<Value> = section("geometry").iter().filter(|case| case["label"].as_str().unwrap_or("").starts_with(prefix)).cloned().collect();
    assert!(!cases.is_empty(), "нет случаев {prefix}");
    let libraries = Libraries::for_cases(&cases);
    let failures = par_check(&cases, |case| geometry_case(case, &libraries).into_iter().collect());
    assert_clean(&failures, cases.len());
}

#[test]
fn geometry_from_js_tests_matches() {
    geometry_section("test/");
}

#[test]
fn geometry_corpus_matches() {
    geometry_section("corpus/");
}

#[test]
fn geometry_presets_match() {
    geometry_section("preset/");
}

#[test]
fn geometry_random_matches() {
    geometry_section("random/");
}

#[test]
fn geometry_junk_matches() {
    geometry_section("junk/");
}

#[test]
fn geometry_library_matches() {
    geometry_section("library/");
}

#[test]
fn geometry_unkept_programs_match() {
    geometry_section("missing/");
}

/// Ни одного случая вне известных групп: новая группа генератора не должна
/// молча выпасть из сверки.
#[test]
fn geometry_groups_are_all_checked() {
    let groups = ["test/", "corpus/", "preset/", "random/", "junk/", "library/", "missing/"];
    let orphan: Vec<&str> = section("geometry").iter().filter_map(|case| case["label"].as_str()).filter(|label| !groups.iter().any(|group| label.starts_with(group))).collect();
    assert!(orphan.is_empty(), "случаи вне групп: {orphan:?}");
}

#[test]
fn floors_match_js() {
    let cases = section("floors");
    let mut failures = Vec::new();
    for case in cases {
        let label = case["label"].as_str().unwrap_or("?");
        let mut map = deserialize_tactical_map(&case["map"]).expect("карта храма");
        let theme = case["theme"].as_str().unwrap_or("");
        let result = refresh_scene_floors(&mut map, theme).map(|count| json!({ "count": count, "map": hash(&serialized(&map)) }));
        failures.extend(check_outcome(label, case, result, |value| value.clone()));
    }
    assert_clean(&failures, cases.len());
}

fn transition_case(case: &Value, libraries: &Libraries) -> Option<String> {
    let label = case["label"].as_str().unwrap_or("?");
    let result = create_scene_transition_with(&case["input"], &case["state"], libraries.get(case));
    let failure = check_outcome(label, case, result.clone(), transition_out);
    match (failure, result) {
        (Some(failure), Ok(result)) => Some(format!("{failure}\n  итог Rust: {}", dump(label, &result))),
        (failure, _) => failure,
    }
}

fn transition_section(filter: impl Fn(&str) -> bool) -> usize {
    let cases: Vec<Value> = section("transitions").iter().filter(|case| filter(case["label"].as_str().unwrap_or(""))).cloned().collect();
    let libraries = Libraries::for_cases(&cases);
    let failures = par_check(&cases, |case| transition_case(case, &libraries).into_iter().collect());
    assert_clean(&failures, cases.len());
    cases.len()
}

#[test]
fn transitions_from_js_tests_match() {
    assert!(transition_section(|label| label.starts_with("test/")) > 10);
}

#[test]
fn transitions_from_corpus_match() {
    assert!(transition_section(|label| label.starts_with("corpus/")) > 150);
}

#[test]
fn transitions_other_match() {
    transition_section(|label| !label.starts_with("test/") && !label.starts_with("corpus/"));
}

/// Цепочка переходов: состояние ведёт Rust — сцена, карта мира и память
/// приключения из итога, затем `rememberCurrentSceneMap`, как редьюсер.
fn chain_case(case: &Value, libraries: &Libraries) -> Vec<String> {
    let label = case["label"].as_str().unwrap_or("?");
    let library = libraries.get(case);
    let mut state = case["initial"].clone();
    for (index, step) in case["steps"].as_array().expect("шаги").iter().enumerate() {
        let step_label = format!("{label}#{index}");
        let result = match create_scene_transition_with(&step["input"], &state, library) {
            Ok(result) => result,
            Err(error) => {
                return match case.get("error") {
                    Some(expected) => diff(&step_label, expected, &error.to_json()).into_iter().collect(),
                    None => vec![format!("{step_label}: Rust отказал {}", stringify(&error.to_json()))],
                };
            }
        };
        if let Some(expected) = step.get("out") {
            if let Some(failure) = diff(&step_label, expected, &transition_out(&result)) {
                return vec![format!("{failure}\n  итог Rust: {}", dump(&step_label, &result))];
            }
        }
        for key in ["scene", "worldMap", "adventure"] {
            state[key] = result[key].clone();
        }
        remember_current_scene_map(&mut state);
    }
    match case.get("error") {
        Some(expected) => vec![format!("{label}: JS бросил {}, Rust прошёл цепочку", stringify(expected))],
        None => Vec::new(),
    }
}

#[test]
fn transition_chains_match() {
    let cases = section("chains");
    let libraries = Libraries::for_cases(cases);
    let failures = par_check(cases, |case| chain_case(case, &libraries));
    assert_clean(&failures, cases.len());
    let steps: usize = cases.iter().map(|case| case["steps"].as_array().map_or(0, Vec::len)).sum();
    assert!(steps > 200, "шагов цепочек: {steps}");
}
