//! Сверка `thin_walls` с эталоном JS на случайных планировках
//! (`fixtures/thin-walls.json`, генератор `fixtures/gen-thin-walls.mjs`) и
//! поведение прохода на ручных картах.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, assert_same_or_hash, attempt, parse, restore, serialize};
use serde_json::{json, Value};
use sk_map_core::thin_walls::{thin_walls, ThinWallsOptions, THIN_WALLS_VERSION};
use sk_tactical::tactical_map::{self as t, CellPatch, EdgeKind, TacticalMap, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/thin-walls.json")));

#[test]
fn random_layouts_match_js() {
    assert_eq!(FIXTURE["version"], THIN_WALLS_VERSION);
    let cases = array(&FIXTURE["cases"]);
    assert_eq!(cases.len(), 400);
    for (index, case) in cases.iter().enumerate() {
        let mut map = restore(&case["before"]);
        let options = match case["options"].get("keepBorder") {
            Some(flag) => ThinWallsOptions { keep_border: flag == &Value::Bool(true) },
            None => ThinWallsOptions::default(),
        };
        let outcome = attempt(thin_walls(&mut map, &options).map(|report| report.to_json()));
        let context = format!("случай {index}");
        assert_same(&outcome, &case["outcome"], &context);
        assert_same_or_hash(&serialize(&map), &case["after"], &context);
    }
}

/// Дом 6×5 стенами-клетками на лугу 10×8, дверь в южной стене.
fn house() -> TacticalMap {
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 10, height: 8, seed: "house", ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "yard", "kind": "exterior", "material": "grass", "label": "Двор" })).expect("двор");
    t::add_zone(&mut map, &json!({ "id": "room", "kind": "interior", "material": "wood", "label": "Комната" })).expect("комната");
    for y in 0..8 {
        for x in 0..10 {
            t::set_cell(&mut map, x, y, &CellPatch { passable: Some(true), zone: Some("yard"), material: Some("grass"), ..CellPatch::default() }).expect("клетка");
        }
    }
    for y in 1..=5 {
        for x in 2..=7 {
            let wall = x == 2 || x == 7 || y == 1 || y == 5;
            let patch = CellPatch { passable: Some(!wall), zone: Some(if wall { "" } else { "room" }), material: Some("wood"), ..CellPatch::default() };
            t::set_cell(&mut map, x, y, &patch).expect("дом");
        }
    }
    t::set_cell(&mut map, 4, 5, &CellPatch { passable: Some(true), ..CellPatch::default() }).expect("проём");
    t::set_door(&mut map, &json!({ "id": "door", "x": 4, "y": 5, "dir": "s", "state": "closed", "blocksMove": true, "blocksSight": true })).expect("дверь");
    map
}

#[test]
fn wall_cells_become_room_floor_with_edge_walls() {
    let mut map = house();
    let report = thin_walls(&mut map, &ThinWallsOptions::default()).expect("проход");
    // Кольцо 6×5 без проёма — 17 клеток кладки; все отходят комнате.
    assert_eq!(report.converted, 17);
    assert_eq!(report.to_json(), json!({ "converted": 17 }));
    for y in 1..=5 {
        for x in 2..=7 {
            let cell = t::cell_at(&map, x, y).expect("клетка");
            assert!(cell.passable, "{x},{y} осталась кладкой");
            assert_eq!(cell.zone, "room", "{x},{y}");
            assert_eq!(cell.material, "wood");
        }
    }
    // Между комнатой и двором — стена на ребре, внутри комнаты рёбер нет.
    let west = t::edge_between(&map, 1, 3, 2, 3).expect("ребро").expect("стена");
    assert_eq!(west.kind, EdgeKind::Wall);
    assert!(west.blocks_move && west.blocks_sight);
    assert!(t::edge_between(&map, 2, 3, 3, 3).expect("ребро").is_none());
    // Проём двери ушёл комнате, полотно осталось на своём ребре.
    let door = t::edge_between(&map, 4, 5, 4, 6).expect("ребро").expect("дверь");
    assert_eq!(door.kind, EdgeKind::Door);
    assert_eq!(t::cell_at(&map, 4, 5).expect("проём").zone, "room");
    assert_eq!(t::validate_tactical_map(&map).errors, Vec::new());
}

#[test]
fn border_stays_masonry_unless_asked() {
    let build = || {
        let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
        let mut map = t::create_tactical_map(&TacticalMapOptions { width: 5, height: 5, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта");
        t::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior" })).expect("зал");
        for y in 0..5 {
            for x in 0..5 {
                let border = x == 0 || y == 0 || x == 4 || y == 4;
                t::set_cell(&mut map, x, y, &CellPatch { passable: Some(!border), zone: Some(if border { "" } else { "hall" }), ..CellPatch::default() }).expect("клетка");
            }
        }
        map
    };
    let mut kept = build();
    assert_eq!(thin_walls(&mut kept, &ThinWallsOptions::default()).expect("проход").converted, 0);
    let mut opened = build();
    // Без `keepBorder` край отходит залу: четыре стороны по три клетки и четыре угла.
    assert_eq!(thin_walls(&mut opened, &ThinWallsOptions { keep_border: false }).expect("проход").converted, 16);
    assert_eq!(t::cell_at(&opened, 0, 0).expect("угол").zone, "hall");
    let _ = serialize(&opened);
}
