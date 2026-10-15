//! Сверка `scene_features` с эталоном JS (`fixtures/scene-features.json`,
//! генератор `fixtures/gen-scene-features.mjs`) и поведение на ручных картах.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, deepest_room_call, hash, parse, raise_dais_call, restore, serialize};
use serde_json::{json, Value};
use sk_map_core::scene_features::{deepest_room, raise_dais, DaisOptions, SCENE_FEATURES_VERSION};
use sk_tactical::tactical_map::{self as t, CellPatch, EdgeKind, TacticalMap, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/scene-features.json")));

fn fixture_map(index: &Value) -> TacticalMap {
    let index = index.as_u64().expect("номер карты") as usize;
    restore(&FIXTURE["maps"][index]["before"])
}

#[test]
fn deepest_room_matches_js() {
    assert_eq!(FIXTURE["version"], SCENE_FEATURES_VERSION);
    let cases = array(&FIXTURE["deepest"]);
    assert_eq!(cases.len(), 360);
    let mut found = 0;
    for case in cases {
        let map = fixture_map(&case["map"]);
        let actual = deepest_room_call(&map);
        found += usize::from(!actual["ok"].is_null());
        assert_same(&actual, &case["result"], &format!("карта {}", case["map"]));
    }
    assert!(found > 100, "дальняя комната нашлась только {found} раз");
}

#[test]
fn raise_dais_matches_js() {
    let cases = array(&FIXTURE["dais"]);
    assert!(cases.len() > 800);
    let mut raised = 0;
    for (index, case) in cases.iter().enumerate() {
        let mut map = fixture_map(&case["map"]);
        let outcome = raise_dais_call(&mut map, case);
        raised += usize::from(outcome["ok"].as_u64().is_some_and(|count| count > 0));
        let context = format!("случай {index} (карта {}, зона {})", case["map"], case["zoneId"]);
        assert_same(&outcome, &case["outcome"], &context);
        assert_eq!(hash(&serialize(&map)), case["after"].as_str().unwrap_or(""), "карта после помоста: {context}");
    }
    assert!(raised > 200, "помост поднят только {raised} раз");
}

/// Зал 12×8 с дверью в западной стене.
fn hall() -> TacticalMap {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 12, height: 8, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior" })).expect("зал");
    t::add_zone(&mut map, &json!({ "id": "porch", "kind": "exterior" })).expect("крыльцо");
    for y in 0..8 {
        for x in 0..12 {
            t::set_cell(&mut map, x, y, &CellPatch { zone: Some(if x == 0 { "porch" } else { "hall" }), ..CellPatch::default() }).expect("клетка");
        }
    }
    t::set_door(&mut map, &json!({ "id": "door", "x": 0, "y": 4, "dir": "e", "state": "closed" })).expect("дверь");
    t::add_spawn_point(&mut map, &json!({ "id": "party", "x": 0, "y": 4, "role": "party" })).expect("отряд");
    map
}

#[test]
fn dais_rises_at_the_far_wall_with_steps_in_the_middle() {
    let mut map = hall();
    // Зал 11×8 = 88 клеток; дверь на западе — помост у восточной стены, две клетки вглубь.
    assert_eq!(raise_dais(&mut map, "hall", &DaisOptions::default()).expect("помост"), 16);
    assert_eq!(t::cell_at(&map, 11, 0).expect("клетка").elevation, 5);
    assert_eq!(t::cell_at(&map, 10, 7).expect("клетка").elevation, 5);
    assert_eq!(t::cell_at(&map, 9, 3).expect("клетка").elevation, 0);
    // Кромка — уступ, кроме двух ступеней в середине (y = 3 и 4).
    let ledge = t::edge_between(&map, 9, 0, 10, 0).expect("ребро").expect("уступ");
    assert_eq!(ledge.kind, EdgeKind::Ledge);
    assert!(!ledge.blocks_move && !ledge.blocks_sight);
    assert!(t::edge_between(&map, 9, 3, 10, 3).expect("ребро").is_none());
    assert!(t::edge_between(&map, 9, 4, 10, 4).expect("ребро").is_none());
    // Маленькое помещение помоста не получает.
    assert_eq!(raise_dais(&mut map, "porch", &DaisOptions::default()).expect("помост"), 0);
}

#[test]
fn deepest_room_counts_doors() {
    let mut map = hall();
    assert_eq!(deepest_room(&map).map(|room| room.to_json()), Some(json!({ "zoneId": "hall", "steps": 1, "doors": 1 })));
    map.spawn_points.clear();
    assert_eq!(deepest_room(&map), None);
}
