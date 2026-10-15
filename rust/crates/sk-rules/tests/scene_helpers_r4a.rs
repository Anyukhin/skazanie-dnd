//! Помощники сцены для разбора команд против JS (задача Р4а):
//! `sceneObjectState`, `sceneAdvancePartyPositions`, `levelArrivalPositions`,
//! `planImportRelocations`. Эталон — `fixtures/scene-helpers-r4a.json`
//! (генератор `fixtures/gen-scene-helpers-r4a.mjs`); состояния и карты —
//! заплатки над состояниями `fixtures/reduce-r4a.json`.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_rules::scene::{levels, objects, placement};
use sk_tactical::tactical_map::{deserialize_tactical_map, legacy_cells_from_tactical_map, serialize_tactical_map, set_door, TacticalMap};

static BASES: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/reduce-r4a.json")).expect("состояния — JSON"));
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/scene-helpers-r4a.json")).expect("эталон — JSON"));

fn bases() -> &'static [Value] {
    BASES["bases"].as_array().expect("состояния")
}

fn ground() -> TacticalMap {
    deserialize_tactical_map(&bases()[0]["scene"]["map"]).expect("карта зала")
}

/// `applyMapPatch(patch)` генератора.
fn map_from(patch: &Value) -> TacticalMap {
    let mut map = ground();
    if let Some(level) = patch.get("level_index").and_then(Value::as_i64) {
        map.level_index = level;
    }
    if let Some(Value::Array(flags)) = patch.get("blocks_move") {
        for (prop, flag) in map.props.iter_mut().zip(flags) {
            if let Some(flag) = flag.as_bool() {
                prop.blocks_move = flag;
            }
        }
    }
    if let Some(door) = patch.get("door").filter(|door| door.is_object()) {
        let next = sk_core::js::spread(&map.doors[0].to_json(), door.clone());
        set_door(&mut map, &next).expect("дверь");
    }
    map
}

/// `applyStatePatch(patch)` генератора.
fn state_from(patch: &Value) -> Value {
    let mut state = bases()[patch["base"].as_u64().unwrap_or(0) as usize].clone();
    if let Some(players) = patch.get("players") {
        state["players"] = players.clone();
    }
    if let Some(positions) = patch.get("positions") {
        state["mechanics"]["positions"] = positions.clone();
    }
    if let Some(entities) = patch.get("entities") {
        state["entities"] = entities.clone();
    }
    if let Some(stashes) = patch.get("levelEntities") {
        state["levelEntities"] = stashes.clone();
    }
    state
}

fn outcome(result: Result<Vec<Value>, sk_core::RuleError>) -> Value {
    match result {
        Ok(list) => json!({ "result": list }),
        Err(error) => json!({ "error": error.code }),
    }
}

fn expected(case: &Value) -> Value {
    match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    }
}

fn cases(name: &str) -> &'static [Value] {
    DATA["cases"][name].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("нет раздела {name}"))
}

#[test]
fn scene_object_state_matches_js() {
    for case in cases("scene_object_state") {
        let mut state = bases()[case["base"].as_u64().unwrap_or(0) as usize].clone();
        state["mechanics"]["scene_interactions"] = case["scene_interactions"].clone();
        let mut map = ground();
        let prop = map.props.iter_mut().find(|prop| prop.id == case["prop_id"].as_str().unwrap_or_default()).expect("предмет");
        prop.state = case["prop_state"].as_str().unwrap_or_default().to_string();
        let actual = objects::scene_object_state(&state, prop, &case["definition"]);
        assert_eq!(sk_core::js::stringify(&actual), sk_core::js::stringify(&case["result"]), "{case}");
    }
}

#[test]
fn scene_advance_party_positions_match_js() {
    for case in cases("scene_advance_party_positions") {
        let state = state_from(&case["patch"]);
        let map = case.get("map_patch").filter(|patch| !patch.is_null()).map(map_from);
        let mut cells = match &map {
            Some(map) => legacy_cells_from_tactical_map(map),
            None => bases()[0]["scene"]["cells"].as_array().cloned().unwrap_or_default(),
        };
        if case["reverse"].as_bool() == Some(true) {
            cells.reverse();
        }
        if case["tiny"].as_bool() == Some(true) {
            cells = vec![json!({ "x": 1, "y": 1, "type": "floor" })];
        } else if case["extra"].as_bool() == Some(true) {
            cells.extend([json!({ "x": 2, "y": 2, "type": "floor" }), json!({ "x": "q", "y": 1 }), Value::Null]);
        }
        let mut scene = json!({ "cells": cells });
        if let Some(map) = &map {
            scene["map"] = if case["broken"].as_bool() == Some(true) { json!({ "broken": true }) } else { serialize_tactical_map(map).expect("карта") };
        }
        let mut transition = json!({ "scene": scene });
        if !case["entrance"].is_null() {
            transition["entrance"] = case["entrance"].clone();
        }
        let actual = outcome(placement::scene_advance_party_positions(&state, &transition));
        assert_eq!(sk_core::js::stringify(&actual), sk_core::js::stringify(&expected(case)), "{case}");
    }
}

#[test]
fn level_arrival_positions_match_js() {
    for case in cases("level_arrival_positions") {
        let state = state_from(&case["patch"]);
        let map = map_from(&case["map_patch"]);
        let empty = sk_tactical::tactical_map::TacticalProp { footprint: Vec::new(), ..map.props[0].clone() };
        let arrival = match case["arrival"].as_str() {
            Some("empty") => Some(&empty),
            Some(id) => map.props.iter().find(|prop| prop.id == id),
            None => None,
        };
        let actual = outcome(levels::level_arrival_positions(&state, &map, arrival));
        assert_eq!(sk_core::js::stringify(&actual), sk_core::js::stringify(&expected(case)), "{case}");
    }
}

#[test]
fn plan_import_relocations_match_js() {
    for case in cases("plan_import_relocations") {
        let state = state_from(&case["patch"]);
        let map = map_from(&case["map_patch"]);
        let party = case["party_positions"].as_array().cloned().unwrap_or_default();
        let actual = json!({ "result": levels::plan_import_relocations(&state, &map, &party) });
        assert_eq!(sk_core::js::stringify(&actual), sk_core::js::stringify(&expected(case)), "{case}");
    }
}
