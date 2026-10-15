//! Сверка `reveal_transport` с эталоном JS (`fixtures/reveal-transport.json`,
//! генератор `fixtures/gen-reveal-transport.mjs`): последовательности вызовов
//! над чистым кэшем на проекциях карт для игрока, и перенос проверок модуля
//! из `test/reveal-transport.test.mjs` (без клиентской половины на TS).

mod common;

use std::sync::LazyLock;

use common::{arg, array, hash, parse, stringify};
use serde_json::{json, Value};
use sk_tactical::reveal_transport::{self as r, RevealTransport, SceneMapUpdate};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/reveal-transport.json")));

fn scene_for(step: &Value, map: &Value) -> Value {
    match &step["sceneKind"] {
        Value::String(kind) if kind == "full" => {
            let mut scene = json!({ "title": "Зал", "location": "Крепость", "map": map["map"], "map_hash": map["hash"], "cells": [] });
            if step["mapDelta"] == true {
                scene["map_delta"] = json!("прежнее");
            }
            scene
        }
        Value::String(kind) if kind == "nohash" => json!({ "title": "Без хеша", "map": map["map"] }),
        Value::String(kind) if kind == "nomap" => json!({ "title": "Без карты", "cells": [] }),
        other => arg(other).cloned().unwrap_or(Value::Null),
    }
}

fn state_for(step: &Value, map: &Value) -> Value {
    match &step["stateKind"] {
        Value::String(kind) if kind == "scene" => {
            json!({ "sessionCode": "T", "scene": { "title": "Зал", "map": map["map"], "map_hash": map["hash"] }, "players": [{ "id": "hero" }] })
        }
        Value::String(kind) if kind == "players" => json!({ "players": [] }),
        Value::String(kind) if kind == "null-scene" => json!({ "scene": null }),
        other => arg(other).cloned().unwrap_or(Value::Null),
    }
}

#[test]
fn call_sequences_match_js() {
    assert_eq!(FIXTURE["limit"], r::PROJECTED_MAP_CACHE_LIMIT);
    let maps = array(&FIXTURE["maps"]);
    let mut deltas = 0;
    for (number, sequence) in array(&FIXTURE["sequences"]).iter().enumerate() {
        let mut transport = RevealTransport::new();
        for (index, step) in array(sequence).iter().enumerate() {
            let context = format!("последовательность #{number}, шаг {index}: {}", stringify(step));
            let client = step["clientHash"].as_str().unwrap();
            match step["op"].as_str().unwrap() {
                "update" => {
                    let map = step["map"].as_u64().map(|index| &maps[index as usize]["map"]);
                    let update = transport.scene_map_update_for(map, step["hash"].as_str().unwrap(), client);
                    assert_eq!(update.kind(), step["kind"].as_str().unwrap(), "{context}");
                    assert_eq!(hash(&update.to_json(map)), step["result"].as_str().unwrap(), "{context}");
                    deltas += usize::from(matches!(update, SceneMapUpdate::Delta { .. }));
                }
                "scene" => {
                    let scene = scene_for(step, &maps[step["map"].as_u64().unwrap() as usize]);
                    let result = transport.compact_scene_for(&scene, client);
                    assert_eq!(result.scene.is_none(), step["same"] == true, "{context}");
                    let json = json!({ "scene": result.scene.clone().unwrap_or(scene), "hash": result.hash });
                    assert_eq!(hash(&json), step["result"].as_str().unwrap(), "{context}");
                }
                "state" => {
                    let state = state_for(step, &maps[step["map"].as_u64().unwrap() as usize]);
                    let (next, client_hash) = transport.compact_state_for_transport(&state, client);
                    assert_eq!(next.is_none(), step["same"] == true, "{context}");
                    let json = json!({ "state": next.unwrap_or(state), "hash": client_hash });
                    assert_eq!(hash(&json), step["result"].as_str().unwrap(), "{context}");
                }
                other => panic!("операция {other}"),
            }
        }
    }
    assert!(deltas > 100, "дельт: {deltas}");
}

fn snapshot(series: usize, step: usize) -> (Value, String) {
    // Серии генератора: 4 снимка однородной 30×30, 3 — правдоподобной
    // 100×100, 3 — с материалом и водой, 2 — с колодцем, 2 — со стеной.
    let offsets = [0, 4, 7, 10, 12, 14, 15];
    let map = &array(&FIXTURE["maps"])[offsets[series] + step];
    (map["map"].clone(), map["hash"].as_str().unwrap().to_string())
}

#[test]
fn cold_client_gets_full_map_and_same_hash_is_unchanged() {
    let mut transport = RevealTransport::new();
    let (map, hash) = snapshot(0, 0);
    let cold = transport.scene_map_update_for(Some(&map), &hash, "");
    assert_eq!(cold, SceneMapUpdate::Full { hash: hash.clone() });
    assert_eq!(cold.to_json(Some(&map))["map"], map);
    assert_eq!(transport.scene_map_update_for(Some(&map), &hash, "ниоткуда").kind(), "full", "неизвестный хеш — это отсутствие карты");
    assert_eq!(transport.scene_map_update_for(Some(&map), &hash, &hash), SceneMapUpdate::Unchanged { hash });
}

#[test]
fn turn_reveal_goes_as_small_delta() {
    let mut transport = RevealTransport::new();
    let (before, before_hash) = snapshot(1, 0);
    transport.scene_map_update_for(Some(&before), &before_hash, "");
    let (after, after_hash) = snapshot(1, 1);
    let update = transport.scene_map_update_for(Some(&after), &after_hash, &before_hash);
    let SceneMapUpdate::Delta { hash, delta } = &update else { panic!("ожидалась дельта: {update:?}") };
    assert_eq!(delta["baseHash"], before_hash.as_str(), "дельта обязана назвать карту, к которой применима");
    assert_ne!(*hash, before_hash);
    let delta_size = stringify(delta).len() as f64 / 1024.0;
    let full_size = stringify(&after).len() as f64 / 1024.0;
    assert!(delta_size <= 4.0, "дельта {delta_size:.2} КБ, порог — 4 КБ");
    assert!(delta_size < full_size / 10.0, "дельта обязана быть на порядок дешевле карты");
    // Повторный вопрос той же пары — запомненный ответ.
    assert_eq!(transport.scene_map_update_for(Some(&after), &after_hash, &before_hash), update);
}

#[test]
fn reveal_that_opens_prop_goes_as_full_map() {
    let mut transport = RevealTransport::new();
    let (before, before_hash) = snapshot(3, 0);
    transport.scene_map_update_for(Some(&before), &before_hash, "");
    let (after, after_hash) = snapshot(3, 1);
    assert_eq!(transport.scene_map_update_for(Some(&after), &after_hash, &before_hash).kind(), "full", "дельта, расходящаяся с полной проекцией, отправляться не должна");
}

#[test]
fn other_map_under_player_goes_full_and_eviction_means_full() {
    let mut transport = RevealTransport::new();
    let (first, first_hash) = snapshot(0, 0);
    transport.scene_map_update_for(Some(&first), &first_hash, "");
    let (other, other_hash) = snapshot(4, 0);
    assert_eq!(transport.scene_map_update_for(Some(&other), &other_hash, &first_hash).kind(), "full", "другая карта обязана уйти целиком");
    let fillers = &array(&FIXTURE["maps"])[15..];
    for filler in fillers {
        transport.scene_map_update_for(Some(&filler["map"]), filler["hash"].as_str().unwrap(), "");
    }
    assert!(transport.projected_map_by_hash(Some(&first_hash)).is_none(), "давняя карта вытеснена");
    let (next, next_hash) = snapshot(0, 1);
    assert_eq!(transport.scene_map_update_for(Some(&next), &next_hash, &first_hash).kind(), "full");
}

#[test]
fn scene_and_state_keep_other_fields() {
    let mut transport = RevealTransport::new();
    let (map, hash) = snapshot(0, 0);
    let scene = json!({ "title": "Зал", "location": "Крепость", "map": map, "map_hash": hash });
    let cold = transport.compact_scene_for(&scene, "");
    assert!(cold.scene.is_none(), "без кэша уходит карта целиком");
    assert_eq!(cold.hash, hash);
    let warm = transport.compact_scene_for(&scene, &hash);
    let warm_scene = warm.scene.unwrap();
    assert!(warm_scene.get("map").is_none());
    assert_eq!(warm_scene["map_unchanged"], true);
    assert_eq!(warm_scene["title"], "Зал");
    let plain = json!({ "scene": { "title": "Без карты", "cells": [] } });
    assert_eq!(transport.compact_state_for_transport(&plain, "что-нибудь"), (None, "что-нибудь".into()));
    assert_eq!(transport.compact_state_for_transport(&Value::Null, ""), (None, String::new()));
}

#[test]
fn process_cache_functions_share_one_transport() {
    let (map, hash) = snapshot(5, 0);
    r::remember_projected_map(&hash, Some(&map));
    assert_eq!(r::projected_map_by_hash(Some(&hash)), Some(map.clone()));
    assert_eq!(r::scene_map_update_for(Some(&map), &hash, &hash).kind(), "unchanged");
    assert!(r::compact_scene_for(&json!({ "map": map, "map_hash": hash }), &hash).scene.is_some());
    assert_eq!(r::compact_state_for_transport(&json!({}), "x").1, "x");
    r::forget_projected_maps();
    assert!(r::projected_map_by_hash(Some(&hash)).is_none());
}
