//! AGENTS.md §5: перестройка и импорт карты — только ведущему, вне боя,
//! голосования и открытой проверки; перестройка пишет ту же схему события,
//! что импорт (`LocationMapImported`), и replay сходится. Перенос сторожей
//! `archive/js-server/test/map-import-command.test.mjs` на Rules Engine Rust.

use serde_json::{json, Value};
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::pause::Halt;
use sk_rules::replay::{apply_game_event, replay_events};
use sk_rules::resolve::api;
use sk_tactical::tactical_map::{self as tm, TacticalMap};

const PARTY: [&str; 2] = ["hero-a", "hero-b"];

/// Кости не нужны: импорт и перестройка без бросков; лишний бросок — сбой.
struct NoRolls;

impl Rng for NoRolls {
    fn randint(&mut self, _minimum: i64, _maximum: i64) -> Result<i64, DiceError> {
        panic!("импорт карты не бросает кости")
    }
}

fn code(error: &Halt) -> String {
    match error {
        Halt::Rule(rule) => rule.code.clone(),
        Halt::Fault(fault) => fault.code.clone().unwrap_or_else(|| fault.name.clone()),
    }
}

fn house() -> TacticalMap {
    sk_buildings::building_generator::generate_building_scene(&json!({ "seed": "прежний дом", "locationId": "loc-house" })).expect("здание")
}

fn free_cells(map: &TacticalMap, count: usize) -> Vec<(i64, i64)> {
    let mut cells = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if cells.len() == count {
                return cells;
            }
            let passable = tm::cell_at(map, x, y).is_some_and(|cell| cell.passable);
            let occupied = map.props.iter().any(|prop| prop.footprint.iter().any(|spot| spot.x == x && spot.y == y));
            if passable && !occupied {
                cells.push((x, y));
            }
        }
    }
    cells
}

/// Дом текущей сцены, отряд из двух героев и волк вне боя (как `sceneState` JS).
fn scene_state(extra: Value) -> Value {
    let map = house();
    let free = free_cells(&map, 3);
    let players: Vec<Value> = PARTY.iter().zip(&free).enumerate().map(|(index, (id, (x, y)))| json!({ "id": id, "character": format!("Герой {}", index + 1), "hp": 10, "maxHp": 10, "level": 1, "inventory": [], "x": x, "y": y })).collect();
    let (wolf_x, wolf_y) = free[2];
    let mut state = json!({
        "sessionCode": "IMPORT", "state_version": 0, "engine_mode": "enforce", "activePlayerId": PARTY[0], "partyMemberIds": PARTY,
        "players": players,
        "enemies": [{ "id": "wolf", "name": "Волк", "hp": 7, "maxHp": 7, "alive": true, "x": wolf_x, "y": wolf_y }],
        "worldMap": { "seed": "import-seed", "currentLocationId": "loc-house", "locations": [
            { "id": "loc-house", "name": "Дом на холме", "kind": "landmark" },
            { "id": "loc-far", "name": "Дальний форт", "kind": "fortress" }
        ] },
        "scene": {
            "title": "Дом на холме", "location": "Дом на холме", "location_id": "loc-house", "turn": 1,
            "map": tm::serialize_tactical_map(&map).expect("карта"), "cells": tm::legacy_cells_from_tactical_map(&map)
        }
    });
    if let (Some(target), Some(extra)) = (state.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    sk_rules::normalize::normalize_campaign_state(&state).expect("нормализация")
}

fn in_combat(mut state: Value) -> Value {
    state["mechanics"]["combat"]["active"] = json!(true);
    state
}

fn resolve(command: &Value, state: &Value, context: &Value) -> Result<Outcome, Halt> {
    let mut dice = ServiceDice::new(DiceService::deterministic(NoRolls, "map-import"));
    let mut uuid = sequence_uuids("map-import");
    api::resolve_command(command, state, &mut dice, &Context::from_json(context), &mut uuid)
}

fn refused(command: &Value, state: &Value, context: &Value) -> String {
    match resolve(command, state, context) {
        Ok(_) => panic!("команда {} должна получить отказ", command["command_type"]),
        Err(error) => code(&error),
    }
}

fn authorized() -> Value {
    json!({ "mapImportAuthorized": true })
}

#[test]
fn import_is_for_the_game_master_only_and_not_during_combat() {
    let state = scene_state(json!({}));
    let import = |extra: Value| {
        let mut command = json!({ "command_type": "ImportLocationMap", "command_id": "import-1", "slab": "```H4sI```" });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            command[key] = value;
        }
        command
    };
    assert_eq!(refused(&import(json!({})), &state, &json!({})), "MAP_IMPORT_FORBIDDEN");
    // Флаги администратора и Режиссёра полномочием на подмену карты не являются.
    assert_eq!(refused(&import(json!({})), &state, &json!({ "isAdmin": true, "isDirector": true })), "MAP_IMPORT_FORBIDDEN");
    assert_eq!(refused(&import(json!({})), &in_combat(scene_state(json!({}))), &authorized()), "MAP_IMPORT_DURING_COMBAT");
    assert_eq!(refused(&import(json!({ "location_id": "loc-nowhere" })), &state, &authorized()), "MAP_IMPORT_LOCATION_UNKNOWN");
    assert_eq!(refused(&import(json!({ "slab": "" })), &state, &authorized()), "SLAB_EMPTY");
}

#[test]
fn rebuild_is_refused_to_players_in_combat_and_while_the_party_decides() {
    let command = json!({ "command_type": "RebuildLocationMap", "command_id": "rebuild-2", "actor_id": PARTY[0] });
    assert_eq!(refused(&command, &scene_state(json!({})), &json!({})), "MAP_IMPORT_FORBIDDEN");
    assert_eq!(refused(&command, &in_combat(scene_state(json!({}))), &authorized()), "MAP_REBUILD_DURING_COMBAT");
    // Голосование и открытая проверка — решение отряда по этой карте.
    for status in ["open", "pending", "voting"] {
        let deciding = scene_state(json!({ "agentInteraction": { "id": "vote-1", "type": "vote", "status": status, "options": [] } }));
        assert_eq!(refused(&command, &deciding, &authorized()), "MAP_REBUILD_DECISION_OPEN", "статус {status}");
    }
    let without_map = scene_state(json!({ "scene": { "title": "Пустошь", "location_id": "loc-house", "turn": 1 } }));
    assert_eq!(refused(&command, &without_map, &authorized()), "MAP_REBUILD_NO_SCENE");
}

#[test]
fn rebuild_writes_the_import_event_and_replays_to_the_same_scene() {
    let state = scene_state(json!({}));
    let before = state["scene"]["map"].clone();
    let command = json!({ "command_type": "RebuildLocationMap", "command_id": "rebuild-1", "actor_id": PARTY[0], "text": "В центре — общий навес, у ближайших домов на порогах лежат камни." });
    let Outcome::Committed(resolved) = resolve(&command, &state, &authorized()).expect("перестройка") else { panic!("перестройка не ждёт решения") };
    let event = resolved.events.iter().find(|event| event["event_type"] == "LocationMapImported").expect("перестройка пишет то же событие, что импорт: один reducer");
    assert_eq!(event["payload"]["source"]["format"], "scene-program-rebuild");
    assert_eq!(event["payload"]["schema_version"], 2);

    let after = apply_game_event(&state, event).expect("применение");
    assert_ne!(after["scene"]["map"], before, "карта новая");
    let map = tm::deserialize_tactical_map(&after["scene"]["map"]).expect("новая карта");
    for id in PARTY {
        let position = &after["mechanics"]["positions"][id];
        let (x, y) = (position["x"].as_i64().expect("x"), position["y"].as_i64().expect("y"));
        assert!(tm::cell_at(&map, x, y).is_some_and(|cell| cell.passable), "{id} стоит на проходимой клетке новой карты");
    }
    let replayed = replay_events(&state, &resolved.events).expect("replay");
    assert_eq!(replayed["scene"]["map"], after["scene"]["map"], "replay того же журнала даёт ту же карту");
    assert_eq!(replayed["mechanics"]["positions"], after["mechanics"]["positions"]);
    assert_eq!(state["scene"]["map"], before, "прежняя карта осталась в состоянии до события");
}
