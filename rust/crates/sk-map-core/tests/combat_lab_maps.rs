//! Сверка `combat_lab_maps` с эталоном JS (`fixtures/combat-lab-maps.json`,
//! генератор `fixtures/gen-combat-lab-maps.mjs`) и проверки
//! `test/combat-lab-maps.test.mjs`.

mod common;

use std::collections::HashSet;
use std::sync::LazyLock;

use common::{array, assert_same, parse, restore, UNDEFINED};
use serde_json::{json, Value};
use sk_map_core::combat_lab_maps::{combat_lab_map_by_id, combat_lab_map_catalog, COMBAT_LAB_MAPS, COMBAT_LAB_MAPS_VERSION};
use sk_tactical::tactical_map::{self as t, validate_tactical_map};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/combat-lab-maps.json")));

#[test]
fn catalog_matches_js() {
    assert_eq!(FIXTURE["version"], COMBAT_LAB_MAPS_VERSION);
    assert_eq!(COMBAT_LAB_MAPS_VERSION, "skazanie:combat-lab-maps-v1");
    let expected = array(&FIXTURE["maps"]);
    assert_eq!(COMBAT_LAB_MAPS.len(), expected.len());
    for (actual, expected) in COMBAT_LAB_MAPS.iter().zip(expected) {
        assert_same(actual, expected, expected["id"].as_str().unwrap_or(""));
    }
    assert_eq!(FIXTURE["catalogEqual"], true);
    assert_eq!(combat_lab_map_catalog(), *COMBAT_LAB_MAPS);
}

#[test]
fn lookup_by_loose_id_matches_js() {
    for probe in array(&FIXTURE["probes"]) {
        let value = (probe["value"].as_str() != Some(UNDEFINED)).then_some(&probe["value"]);
        let actual = combat_lab_map_by_id(value).map_or(Value::Null, |map| map["id"].clone());
        assert_eq!(actual, probe["result"], "{}", probe["value"]);
    }
}

#[test]
fn library_lists_the_arenas_in_order() {
    let ids: Vec<&str> = COMBAT_LAB_MAPS.iter().filter_map(|map| map["id"].as_str()).collect();
    assert_eq!(ids, ["open-courtyard", "ruined-hall", "marsh-crossing", "pillar-chamber", "forest-clearing", "cavern-bridge", "watchtower-terrace"]);
    assert_eq!(combat_lab_map_catalog(), combat_lab_map_catalog(), "одинаковый seed должен давать одинаковый каталог");
}

#[test]
fn every_arena_has_terrain_obstacles_and_legal_spawns() {
    for definition in COMBAT_LAB_MAPS.iter() {
        let id = definition["id"].as_str().unwrap_or("");
        let map = restore(&definition["map"]);
        let report = validate_tactical_map(&map);
        assert!(report.ok, "{id}: {:?}", report.errors);
        assert_eq!(map.width, definition["width"].as_i64().unwrap_or(0));
        assert_eq!(map.height, definition["height"].as_i64().unwrap_or(0));
        let cells = array(&definition["cells"]);
        assert_eq!(cells.len() as i64, map.width * map.height);
        for cell in cells {
            let (x, y) = (cell["x"].as_i64().unwrap_or(-1), cell["y"].as_i64().unwrap_or(-1));
            assert_eq!(cell["passable"], t::cell_passable(&map, x, y), "{id}: интерфейс и сервер расходятся по проходимости {x},{y}");
        }
        assert!(definition["obstacle_count"].as_i64().unwrap_or(0) > 0, "{id}: нужны препятствия");
        let terrain = &definition["terrain_features"];
        assert!(terrain["difficult_cells"].as_i64().unwrap_or(0) > 0 || terrain["wall_edges"].as_i64().unwrap_or(0) > 0, "{id}: нужен рельеф");
        let points = array(&definition["spawnPoints"]);
        assert!(points.iter().filter(|point| point["role"] == "party").count() >= 6, "{id}: мало мест для отряда");
        assert!(points.iter().filter(|point| point["role"] == "enemy").count() >= 12, "{id}: мало мест для врагов");
        let unique: HashSet<String> = points.iter().map(|point| format!("{}:{},{}", point["role"], point["x"], point["y"])).collect();
        assert_eq!(unique.len(), points.len());
        assert_eq!(Value::Array(points.to_vec()), Value::Array(map.spawn_points.iter().map(|point| point.to_json()).collect()));
        let party = points.iter().find(|point| point["role"] == "party").expect("отряд");
        let reachable = t::reachable_cells(&map, party["x"].as_i64().unwrap_or(0), party["y"].as_i64().unwrap_or(0), true, None);
        for point in points {
            let (x, y) = (point["x"].as_i64().unwrap_or(-1), point["y"].as_i64().unwrap_or(-1));
            assert!(t::cell_passable(&map, x, y), "{id}: {} стоит на препятствии", point["id"]);
            assert!(reachable.contains(&(x, y)), "{id}: {} недостижима", point["id"]);
        }
    }
}

#[test]
fn lookup_returns_a_copy() {
    let mut first = combat_lab_map_by_id(Some(&json!("forest-clearing"))).expect("поляна");
    let second = combat_lab_map_by_id(Some(&json!("forest-clearing"))).expect("поляна");
    assert_eq!(first, second);
    first["cells"][0]["type"] = json!("wall");
    first["map"]["layers"]["present"] = json!("mutated");
    assert_eq!(combat_lab_map_by_id(Some(&json!("forest-clearing"))).expect("поляна")["cells"][0]["type"], "floor");
    assert_eq!(combat_lab_map_by_id(Some(&json!("missing-map"))), None);
}

#[test]
fn cavern_bridge_ledges_are_overwritten_by_obstacle_walls() {
    // Замечено в JS: уступы по краям моста (`ledge`) ставятся до прохода
    // стен вокруг препятствий, и тот заменяет их стенами — мост идёт между
    // двумя стенами, а не уступами. Перенесено как есть.
    let bridge = combat_lab_map_by_id(Some(&json!("cavern-bridge"))).expect("мост");
    let map = restore(&bridge["map"]);
    for y in 3..=5 {
        let west = t::edge_between(&map, 6, y, 7, y).expect("ребро").expect("стена");
        assert_eq!(west.kind, t::EdgeKind::Wall);
        let east = t::edge_between(&map, 7, y, 8, y).expect("ребро").expect("стена");
        assert_eq!(east.kind, t::EdgeKind::Wall);
    }
}
