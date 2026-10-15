//! Перенос проверок модуля из `test/tactical-map-contract.test.mjs` и
//! `test/tactical-map-budget.test.mjs` (бюджеты размера и времени — те же
//! пороги, время — медианой из девяти прогонов после прогрева), плюс
//! реализация `sk_store::MapCells`.

mod common;

use std::collections::HashSet;
use std::time::Instant;

use common::stringify;
use serde_json::{json, Value};
use sk_store::MapCells;
use sk_tactical::tactical_map::{self as t, CatalogRevision, CellPatch, EdgePatch, LegacyMapOptions, TacticalMap, TacticalMapOptions};

fn map(width: i64, height: i64) -> TacticalMap {
    t::create_tactical_map(&TacticalMapOptions { width, height, ..TacticalMapOptions::default() }).expect("карта")
}

fn filled(width: i64, height: i64) -> TacticalMap {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    t::create_tactical_map(&TacticalMapOptions { width, height, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта")
}

fn wall() -> EdgePatch<'static> {
    EdgePatch { kind: Some("wall"), ..EdgePatch::default() }
}

fn round_trip(map: &TacticalMap) -> TacticalMap {
    let text = stringify(&t::serialize_tactical_map(map).expect("сериализация"));
    t::deserialize_tactical_map(&serde_json::from_str(&text).expect("JSON")).expect("чтение")
}

fn cells_of(map: &TacticalMap) -> Vec<Value> {
    let mut cells = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            cells.push(t::cell_at(map, x, y).map_or(Value::Null, |cell| cell.to_json()));
        }
    }
    cells
}

fn edges_of(map: &TacticalMap) -> Vec<Value> {
    t::edge_list(map).into_iter().map(|edge| edge.to_json()).collect()
}

#[test]
fn map_survives_build_serialization_and_reading() {
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 4, height: 3, location_id: "loc-1", seed: "seed-1", ..TacticalMapOptions::default() }).unwrap();
    t::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior", "material": "wood", "floorDirection": "vertical", "label": "Общий зал" })).unwrap();
    for y in 0..3 {
        for x in 0..4 {
            let patch = CellPatch {
                passable: Some(!(x == 3 && y == 0)),
                material: Some(if x % 2 == 1 { "wood" } else { "stone" }),
                variant: Some((x + y) % 6),
                revealed: Some(y == 0),
                zone: Some("hall"),
                move_cost: Some(if x == 1 { 2.0 } else { 1.0 }),
                elevation: Some(if y == 2 { -1 } else { 0 }),
                ..CellPatch::default()
            };
            t::set_cell(&mut map, x, y, &patch).unwrap();
        }
    }
    t::set_cell(&mut map, 2, 2, &CellPatch { surface: Some("water"), hazard_id: Some(Some("hz-1")), ..CellPatch::default() }).unwrap();
    t::set_edge(&mut map, 0, 0, 1, 0, &EdgePatch { kind: Some("wall"), cover: Some("three_quarters"), ..EdgePatch::default() }).unwrap();
    t::set_door(&mut map, &json!({ "id": "d1", "x": 1, "y": 1, "dir": "e", "state": "closed", "blocksMove": true, "blocksSight": true })).unwrap();

    let restored = round_trip(&map);
    assert_eq!(cells_of(&restored), cells_of(&map));
    assert_eq!(edges_of(&restored), edges_of(&map));
    assert_eq!(restored.doors, map.doors);
    assert_eq!(restored.zones, map.zones);
    assert_eq!(restored.zones[0].floor_direction, "vertical", "направление настила теряется при сериализации");
    assert_eq!(restored.bounds, map.bounds);
    assert_eq!(t::cell_at(&restored, 2, 2).unwrap().hazard_id, Some("hz-1"));
    assert_eq!(t::cell_at(&restored, 1, 0).unwrap().move_cost, 2);
    assert_eq!(t::cell_at(&restored, 0, 2).unwrap().elevation, -1);
}

/// Карта одной строки из двух клеток, на которой можно поставить лестницу.
fn level_map(level_index: i64, level_label: &str) -> TacticalMap {
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 2, height: 1, location_id: "tavern", level_index, level_label, ..TacticalMapOptions::default() }).unwrap();
    t::set_cell(&mut map, 0, 0, &CellPatch { passable: Some(true), ..CellPatch::default() }).unwrap();
    t::set_cell(&mut map, 1, 0, &CellPatch { passable: Some(true), ..CellPatch::default() }).unwrap();
    map
}

#[test]
fn level_and_transition_survive_serialization() {
    let mut map = level_map(-1, "Винный погреб");
    t::add_prop(&mut map, &json!({ "id": "stairs-1", "assetId": "stairs_up", "x": 0.5, "y": 0.5, "footprint": [{ "x": 0, "y": 0 }], "transition": { "toLevel": 0, "label": "Общий зал" } })).unwrap();
    let restored = round_trip(&map);
    assert_eq!(restored.level_index, -1);
    assert_eq!(restored.level_label, "Винный погреб");
    assert_eq!(restored.props[0].transition.as_ref().unwrap().to_json(), json!({ "toLevel": 0, "label": "Общий зал" }));
    assert!(restored.props[0].interactive, "переход обязан делать предмет интерактивным");
    assert_eq!(t::tactical_map_hash(&restored).unwrap(), t::tactical_map_hash(&map).unwrap(), "новые поля обязаны участвовать в хеше");

    let mut hatch = level_map(0, "");
    t::add_prop(&mut hatch, &json!({ "id": "hatch", "assetId": "trapdoor", "x": 0.5, "y": 0.5, "footprint": [], "transition": { "toLevel": -1 } })).unwrap();
    let raw = t::serialize_tactical_map(&hatch).unwrap();
    assert_eq!(raw["props"][0]["transition"], json!({ "toLevel": -1 }));
    assert_eq!(t::deserialize_tactical_map(&raw).unwrap().props[0].transition.as_ref().unwrap().label, "");
}

#[test]
fn map_without_levels_serializes_as_before() {
    let mut map = level_map(0, "");
    t::add_prop(&mut map, &json!({ "id": "barrel", "assetId": "barrel", "x": 0.5, "y": 0.5, "footprint": [{ "x": 0, "y": 0 }] })).unwrap();
    let mut raw = t::serialize_tactical_map(&map).unwrap();
    assert!(raw.get("levelIndex").is_none(), "этаж входа в записи не появляется");
    assert!(raw.get("levelLabel").is_none());
    assert!(raw["props"][0].get("transition").is_none(), "обычный предмет записи о переходе не несёт");
    assert_eq!(map.level_index, 0);
    assert!(map.props[0].transition.is_none());
    raw.as_object_mut().unwrap().shift_remove("levelIndex");
    let restored = t::deserialize_tactical_map(&raw).unwrap();
    assert_eq!(restored.level_index, 0);
    assert_eq!(restored.level_label, "");
    assert_eq!(stringify(&t::serialize_tactical_map(&restored).unwrap()), stringify(&raw), "круговое преобразование старой карты обязано совпасть байт в байт");
}

#[test]
fn garbage_transition_is_rejected_on_input() {
    let rejected = |transition: Value, code: &str, asset: &str| {
        let mut map = level_map(0, "");
        let error = t::add_prop(&mut map, &json!({ "id": "p", "assetId": asset, "x": 0.5, "y": 0.5, "footprint": [], "transition": transition })).unwrap_err();
        assert_eq!(error.code, code, "{transition} на {asset}");
    };
    rejected(json!("вверх"), "TRANSITION_NOT_OBJECT", "stairs_up");
    rejected(json!([1]), "TRANSITION_NOT_OBJECT", "stairs_up");
    rejected(json!({ "toLevel": 1.5 }), "TRANSITION_LEVEL_NOT_INTEGER", "stairs_up");
    rejected(json!({ "toLevel": "один" }), "TRANSITION_LEVEL_NOT_INTEGER", "stairs_up");
    rejected(json!({ "toLevel": t::MAX_LEVEL_OFFSET + 1 }), "TRANSITION_LEVEL_OUT_OF_RANGE", "stairs_up");
    rejected(json!({ "toLevel": -t::MAX_LEVEL_OFFSET - 1 }), "TRANSITION_LEVEL_OUT_OF_RANGE", "stairs_up");
    rejected(json!({ "toLevel": 0 }), "TRANSITION_LEVEL_SAME", "stairs_up");
    rejected(json!({ "toLevel": 1 }), "TRANSITION_ASSET_NOT_INTERACTIVE", "chair");
    rejected(json!({ "toLevel": 1 }), "TRANSITION_ASSET_NOT_INTERACTIVE", "нет-такого-ассета");
}

#[test]
fn only_transition_assets_carry_transitions() {
    for asset in ["stairs_up", "stairs_down", "trapdoor"] {
        let mut map = level_map(0, "");
        let prop = t::add_prop(&mut map, &json!({ "id": asset, "assetId": asset, "x": 0.5, "y": 0.5, "footprint": [], "transition": { "toLevel": 1 } })).unwrap();
        assert_eq!(prop.transition.as_ref().unwrap().to_level, 1, "{asset}");
    }
    for asset in ["rug", "cobweb", "banner", "bench", "bar_counter", "chest"] {
        let mut map = level_map(0, "");
        let error = t::add_prop(&mut map, &json!({ "id": "p", "assetId": asset, "x": 0.5, "y": 0.5, "footprint": [], "transition": { "toLevel": 1 } })).unwrap_err();
        assert_eq!(error.code, "TRANSITION_ASSET_NOT_INTERACTIVE", "{asset}");
        assert!(t::add_prop(&mut map, &json!({ "id": "p", "assetId": asset, "x": 0.5, "y": 0.5, "footprint": [] })).unwrap().transition.is_none());
    }
    let mut generated = level_map(0, "");
    for (id, asset, x) in [("rug", "rug", 0.5), ("up", "stairs_up", 1.5), ("hatch", "trapdoor", 2.5)] {
        t::add_prop(&mut generated, &json!({ "id": id, "assetId": asset, "x": x, "y": 0.5, "footprint": [] })).unwrap();
    }
    let levels = json!([{ "offset": 1, "label": "Второй этаж" }, { "offset": -1, "label": "Подпол" }]);
    let attached: Vec<String> = t::attach_level_transitions(&mut generated, Some(&levels)).into_iter().map(|index| generated.props[index].id.clone()).collect();
    assert_eq!(attached, ["up", "hatch"]);
    assert!(generated.prop("rug").unwrap().transition.is_none());
}

#[test]
fn level_changed_after_placement_is_caught() {
    let mut map = level_map(1, "");
    t::add_prop(&mut map, &json!({ "id": "stairs", "assetId": "stairs_down", "x": 0.5, "y": 0.5, "footprint": [], "transition": { "toLevel": 0 } })).unwrap();
    assert!(t::validate_tactical_map(&map).ok);
    map.level_index = 0;
    let report = t::validate_tactical_map(&map);
    assert!(!report.ok);
    assert!(report.errors.iter().any(|issue| issue.code == "TRANSITION_LEVEL_SAME"), "{:?}", report.errors);
}

#[test]
fn old_zone_without_floor_direction_is_horizontal() {
    let mut map = filled(1, 1);
    t::add_zone(&mut map, &json!({ "id": "legacy", "kind": "interior", "material": "wood" })).unwrap();
    let mut raw = t::serialize_tactical_map(&map).unwrap();
    raw["zones"][0].as_object_mut().unwrap().shift_remove("floorDirection");
    assert_eq!(t::deserialize_tactical_map(&raw).unwrap().zones[0].floor_direction, "horizontal");
}

#[test]
fn zone_styles_keep_assignment_order() {
    // Генератор ставит кладку раньше пола: объект JS пишет `wall` первым.
    let mut map = filled(1, 1);
    t::add_zone(&mut map, &json!({ "id": "hall" })).unwrap();
    map.zones[0].set_wall(Some("fachwerk".into()));
    map.zones[0].set_floor(Some("parquet".into()));
    let raw = t::serialize_tactical_map(&map).unwrap();
    assert_eq!(stringify(&raw["zones"][0]), r#"{"id":"hall","kind":"interior","material":"stone","lightLevel":"bright","floorDirection":"horizontal","label":"","wall":"fachwerk","floor":"parquet"}"#);
    let restored = t::deserialize_tactical_map(&raw).unwrap();
    assert_eq!(restored.zones[0].styles, [("floor", "parquet".to_string()), ("wall", "fachwerk".to_string())], "чтение пишет пол раньше кладки");
}

#[test]
fn water_stays_impassable_and_gets_surface() {
    let cells = vec![
        json!({ "x": 0, "y": 0, "type": "floor", "revealed": true, "material": "stone", "variant": 0, "pattern": "natural" }),
        json!({ "x": 1, "y": 0, "type": "water", "revealed": true, "material": "stone", "variant": 0, "pattern": "natural" }),
    ];
    let map = t::tactical_map_from_legacy_cells(&cells, &LegacyMapOptions::default()).unwrap();
    let water = t::cell_at(&map, 1, 0).unwrap();
    assert!(!water.passable);
    assert_eq!(water.surface, "water");
    assert_eq!(t::legacy_cells_from_tactical_map(&map)[1]["type"], "water");
}

#[test]
fn entity_feature_is_dropped_and_decor_becomes_prop() {
    let cells = vec![
        json!({ "x": 0, "y": 0, "type": "floor", "revealed": true, "material": "wood", "variant": 1, "pattern": "small-room", "feature": "table" }),
        json!({ "x": 1, "y": 0, "type": "floor", "revealed": true, "material": "wood", "variant": 2, "pattern": "small-room", "feature": "enemy" }),
    ];
    let map = t::tactical_map_from_legacy_cells(&cells, &LegacyMapOptions::default()).unwrap();
    assert_eq!(map.props.len(), 1);
    assert_eq!(map.props[0].asset_id, "table");
    assert_eq!(map.props[0].footprint, [sk_core::Point::new(0, 0)]);
    assert_eq!(map.props[0].x, 0.5);
    assert_eq!(map.props[0].rotation, 0.0);
    let restored = t::legacy_cells_from_tactical_map(&map);
    assert_eq!(restored[0]["feature"], "table");
    assert!(restored[1].get("feature").is_none(), "сущность не должна вернуться в клетку");
}

#[test]
fn non_rectangular_shape_keeps_holes() {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/tactical-map.json")).unwrap();
    let cavern = fixture["dynamic"].as_array().unwrap().iter().find(|case| case["seed"] == "shape-cavern").unwrap();
    let cells = cavern["cells"].as_array().unwrap();
    let map = t::tactical_map_from_legacy_cells(cells, &LegacyMapOptions::default()).unwrap();
    assert_eq!(t::cell_count(&map), cells.len());
    assert!(t::cell_count(&map) < (map.width * map.height) as usize, "у пещеры обязаны быть пропуски");
    let present: HashSet<(i64, i64)> = cells.iter().map(|cell| (cell["x"].as_i64().unwrap(), cell["y"].as_i64().unwrap())).collect();
    for y in 0..map.height {
        for x in 0..map.width {
            assert_eq!(t::cell_at(&map, x, y).is_some(), present.contains(&(x, y)), "клетка {x},{y}");
        }
    }
}

#[test]
fn edge_is_canonical_and_absent_between_non_neighbors() {
    let mut map = filled(4, 4);
    t::set_edge(&mut map, 1, 1, 2, 1, &wall()).unwrap();
    let forward = t::edge_between(&map, 1, 1, 2, 1).unwrap().cloned().unwrap();
    let backward = t::edge_between(&map, 2, 1, 1, 1).unwrap().cloned().unwrap();
    assert_eq!(forward, backward);
    assert_eq!(forward.dir.as_str(), "e");
    assert_eq!(t::edge_list(&map).len(), 1, "одно ребро не должно записаться дважды");
    assert_eq!(t::edge_between(&map, 1, 1, 3, 1).unwrap_err().code, "EDGE_CELLS_NOT_ADJACENT");
    t::set_edge(&mut map, 1, 1, 2, 1, &EdgePatch { kind: Some("none"), ..EdgePatch::default() }).unwrap();
    assert!(t::edge_between(&map, 1, 1, 2, 1).unwrap().is_none());
}

#[test]
fn loophole_and_grate_extend_old_edge_codes() {
    assert_eq!(&t::EDGE_KINDS[..6], ["none", "wall", "door", "window", "rail", "ledge"], "индексы старых рёбер нельзя сдвигать");
    assert_eq!(&t::EDGE_KINDS[6..], ["loophole", "grate"]);
    let mut map = filled(3, 2);
    let loophole = t::set_edge(&mut map, 0, 0, 1, 0, &EdgePatch { kind: Some("loophole"), ..EdgePatch::default() }).unwrap().cloned().unwrap();
    let grate = t::set_edge(&mut map, 1, 1, 2, 1, &EdgePatch { kind: Some("grate"), ..EdgePatch::default() }).unwrap().cloned().unwrap();
    assert_eq!((loophole.blocks_move, loophole.blocks_sight, loophole.cover.as_str()), (true, false, "three_quarters"));
    assert_eq!((grate.blocks_move, grate.blocks_sight, grate.cover.as_str()), (true, false, "half"));
    assert_eq!(edges_of(&round_trip(&map)), edges_of(&map), "новые проёмы теряются в упакованном контракте");
}

#[test]
fn validation_catches_every_structural_failure() {
    let base = || {
        let mut map = filled(4, 4);
        t::add_zone(&mut map, &json!({ "id": "z", "kind": "interior" })).unwrap();
        map
    };
    let door = json!({ "id": "d", "x": 1, "y": 1, "dir": "e" });
    let cases: Vec<(&str, Box<dyn Fn() -> TacticalMap>)> = vec![
        ("LAYER_LENGTH_MISMATCH", Box::new(|| {
            let mut map = base();
            map.layers.material = vec![0; 3];
            map
        })),
        ("ENUM_CODE_OUT_OF_RANGE", Box::new(|| {
            let mut map = base();
            map.layers.surface[0] = t::SURFACES.len() as u8 + 1;
            map
        })),
        ("MOVE_COST_NOT_ALLOWED", Box::new(|| {
            let mut map = base();
            map.layers.move_cost[0] = 7;
            map
        })),
        ("DOOR_EDGE_MISSING", Box::new(|| {
            let mut map = base();
            t::set_door(&mut map, &door).unwrap();
            map.remove_edge(1, 1, t::EdgeDir::E);
            map
        })),
        ("DOOR_EDGE_KIND_MISMATCH", Box::new(|| {
            let mut map = base();
            t::set_door(&mut map, &door).unwrap();
            map.edge_mut(1, 1, t::EdgeDir::E).unwrap().kind = t::EdgeKind::Wall;
            map
        })),
        ("DOOR_ID_NOT_UNIQUE", Box::new(|| {
            let mut map = base();
            t::set_door(&mut map, &door).unwrap();
            let copy = map.doors[0].clone();
            map.doors.push(copy);
            map
        })),
        ("EDGE_DOOR_ID_DANGLING", Box::new(|| {
            let mut map = base();
            t::set_edge(&mut map, 1, 1, 2, 1, &EdgePatch { kind: Some("door"), door_id: Some("ghost"), ..EdgePatch::default() }).unwrap();
            map
        })),
        ("PROP_FOOTPRINT_ON_MISSING_CELL", Box::new(|| {
            let mut map = map(4, 4);
            t::set_cell(&mut map, 0, 0, &CellPatch { passable: Some(true), ..CellPatch::default() }).unwrap();
            t::add_prop(&mut map, &json!({ "id": "p", "assetId": "table", "x": 2.5, "y": 2.5, "footprint": [{ "x": 2, "y": 2 }] })).unwrap();
            map
        })),
        ("PROP_FOOTPRINT_ON_IMPASSABLE", Box::new(|| {
            let mut map = base();
            t::set_cell(&mut map, 2, 2, &CellPatch { passable: Some(false), ..CellPatch::default() }).unwrap();
            t::add_prop(&mut map, &json!({ "id": "p", "assetId": "table", "x": 2.5, "y": 2.5, "footprint": [{ "x": 2, "y": 2 }] })).unwrap();
            map
        })),
        ("PROP_FOOTPRINT_OVERLAP", Box::new(|| {
            let mut map = base();
            t::add_prop(&mut map, &json!({ "id": "p1", "assetId": "table", "x": 1.5, "y": 1.5, "footprint": [{ "x": 1, "y": 1 }] })).unwrap();
            t::add_prop(&mut map, &json!({ "id": "p2", "assetId": "chair", "x": 1.5, "y": 1.5, "footprint": [{ "x": 1, "y": 1 }] })).unwrap();
            map
        })),
        ("PROP_ID_NOT_UNIQUE", Box::new(|| {
            let mut map = base();
            t::add_prop(&mut map, &json!({ "id": "p", "assetId": "table", "x": 1.5, "y": 1.5, "footprint": [] })).unwrap();
            t::add_prop(&mut map, &json!({ "id": "p", "assetId": "chair", "x": 2.5, "y": 2.5, "footprint": [] })).unwrap();
            map
        })),
        ("ZONE_ID_NOT_UNIQUE", Box::new(|| {
            let mut map = base();
            let copy = map.zones[0].clone();
            map.zones.push(copy);
            map
        })),
        ("SPAWN_POINT_IMPASSABLE", Box::new(|| {
            let mut map = base();
            t::set_cell(&mut map, 3, 3, &CellPatch { passable: Some(false), ..CellPatch::default() }).unwrap();
            t::add_spawn_point(&mut map, &json!({ "id": "s", "x": 3, "y": 3, "role": "party" })).unwrap();
            map
        })),
        ("CELL_BUDGET_EXCEEDED", Box::new(|| {
            let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
            t::create_tactical_map(&TacticalMapOptions { width: 40, height: 40, fill: Some(fill), size_class: "arena", ..TacticalMapOptions::default() }).unwrap()
        })),
        ("PROP_BUDGET_EXCEEDED", Box::new(|| {
            let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
            let mut map = t::create_tactical_map(&TacticalMapOptions { width: 30, height: 30, fill: Some(fill), size_class: "arena", ..TacticalMapOptions::default() }).unwrap();
            for index in 0..=t::size_class("arena").unwrap().max_props {
                t::add_prop(&mut map, &json!({ "id": format!("p{index}"), "assetId": "mug", "x": 0.5, "y": 0.5, "footprint": [] })).unwrap();
            }
            map
        })),
        ("BOUNDS_MISMATCH", Box::new(|| {
            let mut map = base();
            map.bounds = t::Bounds { min_x: 1, min_y: 1, max_x: 2, max_y: 2 };
            map
        })),
    ];
    for (code, build) in cases {
        let report = t::validate_tactical_map(&build());
        assert!(!report.ok, "{code}: карта должна быть отклонена");
        assert!(report.errors.iter().any(|issue| issue.code == code), "{code}: не найден среди {:?}", report.errors);
    }
}

#[test]
fn wall_budget_catches_wall_on_every_edge() {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 30, height: 30, fill: Some(fill), size_class: "arena", ..TacticalMapOptions::default() }).unwrap();
    for y in 0..30 {
        for x in 0..30 {
            if x + 1 < 30 {
                t::set_edge(&mut map, x, y, x + 1, y, &wall()).unwrap();
            }
            if y + 1 < 30 {
                t::set_edge(&mut map, x, y, x, y + 1, &wall()).unwrap();
            }
        }
    }
    assert!(t::validate_tactical_map(&map).errors.iter().any(|issue| issue.code == "WALL_EDGE_BUDGET_EXCEEDED"));
}

#[test]
fn hash_is_deterministic_and_sensitive() {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/tactical-map.json")).unwrap();
    let source = fixture["dynamic"].as_array().unwrap().iter().find(|case| case["seed"] == "hash").unwrap()["cells"].as_array().unwrap().clone();
    let build = || t::tactical_map_from_legacy_cells(&source, &LegacyMapOptions::default()).unwrap();
    let first = build();
    assert_eq!(t::tactical_map_hash(&first).unwrap(), t::tactical_map_hash(&build()).unwrap());
    assert_eq!(t::tactical_map_hash(&round_trip(&first)).unwrap(), t::tactical_map_hash(&first).unwrap());
    assert_eq!(t::serialized_tactical_map_hash(&t::serialize_tactical_map(&first).unwrap()), t::tactical_map_hash(&first).unwrap());
    let mut changed_cell = build();
    let target = t::cells(&changed_cell).find(|cell| cell.passable).map(|cell| (cell.x, cell.y)).unwrap();
    t::set_cell(&mut changed_cell, target.0, target.1, &CellPatch { variant: Some(42), ..CellPatch::default() }).unwrap();
    assert_ne!(t::tactical_map_hash(&changed_cell).unwrap(), t::tactical_map_hash(&first).unwrap());
    let mut changed_edge = build();
    t::set_edge(&mut changed_edge, 0, 0, 1, 0, &EdgePatch { kind: Some("rail"), blocks_move: Some(false), blocks_sight: Some(false), ..EdgePatch::default() }).unwrap();
    assert_ne!(t::tactical_map_hash(&changed_edge).unwrap(), t::tactical_map_hash(&first).unwrap());
}

#[test]
fn traversal_respects_edges_and_door_state() {
    let mut map = filled(3, 1);
    assert_eq!(t::reachable_cells(&map, 0, 0, true, None).len(), 3);
    t::set_edge(&mut map, 1, 0, 2, 0, &EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), ..EdgePatch::default() }).unwrap();
    let mut reached: Vec<String> = t::reachable_cells(&map, 0, 0, true, None).iter().map(|(x, y)| t::position_key(*x, *y)).collect();
    reached.sort();
    assert_eq!(reached, ["0,0", "1,0"]);
    t::set_door(&mut map, &json!({ "id": "gate", "x": 1, "y": 0, "dir": "e", "state": "closed", "blocksMove": true, "blocksSight": true })).unwrap();
    assert_eq!(t::reachable_cells(&map, 0, 0, true, None).len(), 2, "закрытая дверь не пропускает");
    map.doors[0].state = "open".into();
    assert_eq!(t::reachable_cells(&map, 0, 0, true, None).len(), 3, "открытая дверь пропускает");
    assert_eq!(t::reachable_cells(&map, 0, 0, false, None).len(), 2, "обход без дверей их не открывает");
    map.doors[0].state = "broken".into();
    assert_eq!(t::reachable_cells(&map, 0, 0, true, None).len(), 3, "выбитая дверь пропускает");
    map.doors[0].state = "locked".into();
    assert_eq!(t::reachable_cells(&map, 0, 0, true, None).len(), 2, "запертая дверь не пропускает");
}

#[test]
fn traversal_with_blocked_cells_does_not_change_map() {
    let map = filled(3, 1);
    let before = t::serialize_tactical_map(&map).unwrap();
    let blocked: HashSet<(i64, i64)> = [(1, 0)].into_iter().collect();
    assert_eq!(t::reachable_cells(&map, 0, 0, true, Some(&blocked)).into_iter().collect::<Vec<_>>(), [(0, 0)]);
    assert!(t::reachable_cells(&map, 1, 0, true, Some(&blocked)).is_empty(), "занятая стартовая клетка не является входом");
    assert_eq!(t::reachable_cells(&map, 0, 0, true, None).len(), 3);
    assert_eq!(t::serialize_tactical_map(&map).unwrap(), before);
}

#[test]
fn missing_cell_differs_from_impassable() {
    let mut map = map(3, 1);
    t::set_cell(&mut map, 0, 0, &CellPatch { passable: Some(true), ..CellPatch::default() }).unwrap();
    t::set_cell(&mut map, 1, 0, &CellPatch { passable: Some(false), ..CellPatch::default() }).unwrap();
    assert!(!t::cell_at(&map, 1, 0).unwrap().passable);
    assert!(t::cell_at(&map, 2, 0).is_none());
    assert_eq!(t::recompute_bounds(&mut map), t::Bounds { min_x: 0, min_y: 0, max_x: 1, max_y: 0 });
}

#[test]
fn corrupted_layer_is_rejected() {
    let fill = CellPatch { passable: Some(true), variant: Some(3), ..CellPatch::default() };
    let map = t::create_tactical_map(&TacticalMapOptions { width: 4, height: 4, fill: Some(fill), ..TacticalMapOptions::default() }).unwrap();
    let mut serialized = t::serialize_tactical_map(&map).unwrap();
    serialized["layers"]["variant"] = json!("AAAA");
    assert_eq!(t::deserialize_tactical_map(&serialized).unwrap_err().code, "LAYER_LENGTH_MISMATCH");
}

#[test]
fn store_rebuilds_scene_cells_from_map() {
    let cells = vec![json!({ "x": 0, "y": 0, "type": "floor", "revealed": true }), json!({ "x": 1, "y": 0, "type": "wall", "revealed": false })];
    let map = t::tactical_map_from_legacy_cells(&cells, &LegacyMapOptions::default()).unwrap();
    let serialized = t::serialize_tactical_map(&map).unwrap();
    assert_eq!(t::TacticalMapCells.cells_from_map(&serialized), Some(Value::Array(cells)));
    assert_eq!(t::TacticalMapCells.cells_from_map(&json!({ "width": 2 })), None, "повреждённая карта — без клеток");
}

// --- бюджеты (`test/tactical-map-budget.test.mjs`) ---------------------------

/// Правдоподобная карта класса `region`: комнаты по сетке, вода у края,
/// разные материалы, предметы.
fn region_map(revealed: bool, props: usize) -> TacticalMap {
    let (width, height) = (100, 100);
    let mut map =
        t::create_tactical_map(&TacticalMapOptions { width, height, size_class: "region", seed: "budget", catalog_revision: CatalogRevision::Omit, ..TacticalMapOptions::default() })
            .unwrap();
    t::add_zone(&mut map, &json!({ "id": "inside", "kind": "interior", "material": "wood" })).unwrap();
    t::add_zone(&mut map, &json!({ "id": "outside", "kind": "exterior", "material": "grass" })).unwrap();
    for y in 0..height {
        for x in 0..width {
            let building = x > 8 && x < width - 8 && y > 8 && y < height - 8;
            let wall = building && (x % 14 == 0 || y % 14 == 0) && !(x % 28 == 0 || y % 28 == 0);
            let patch = CellPatch {
                passable: Some(!wall),
                material: Some(if building { ["stone", "wood", "earth"][((x * 7 + y * 3) % 3) as usize] } else { "grass" }),
                variant: Some((x * 5 + y * 11) % 6),
                revealed: Some(revealed),
                zone: Some(if building { "inside" } else { "outside" }),
                surface: Some(if !building && x < 4 { "water" } else { "none" }),
                ..CellPatch::default()
            };
            t::set_cell(&mut map, x, y, &patch).unwrap();
        }
    }
    for y in 0..height {
        for x in 0..width {
            if t::cell_at(&map, x, y).is_none_or(|cell| cell.passable) {
                continue;
            }
            for (dx, dy) in [(1, 0), (0, 1)] {
                if t::cell_passable(&map, x + dx, y + dy) {
                    t::set_edge(&mut map, x, y, x + dx, y + dy, &EdgePatch { kind: Some("wall"), cover: Some("three_quarters"), ..EdgePatch::default() }).unwrap();
                }
            }
        }
    }
    for index in 0..props {
        let prop = json!({ "id": format!("p{index}"), "assetId": "barrel", "x": (index % 90) as f64 + 5.5, "y": (index / 90) as f64 + 20.5, "rotation": index % 360, "footprint": [] });
        t::add_prop(&mut map, &prop).unwrap();
    }
    map
}

/// Медиана из девяти прогонов после прогрева, мс.
fn measure(label: &str, mut run: impl FnMut()) -> f64 {
    run();
    let mut samples: Vec<f64> = (0..9)
        .map(|_| {
            let started = Instant::now();
            run();
            started.elapsed().as_secs_f64() * 1_000.0
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    println!("  {label}: медиана {:.2} мс (мин {:.2}, макс {:.2})", samples[4], samples[0], samples[8]);
    samples[4]
}

#[test]
fn region_map_serializes_within_100_kb() {
    let map = region_map(true, 200);
    let size = stringify(&t::serialize_tactical_map(&map).unwrap()).len() as f64 / 1024.0;
    assert!(size <= 100.0, "сериализованная карта {size:.1} КБ, порог плана — 100 КБ");
    let mut full = map.clone();
    for index in full.props.len()..t::size_class("region").unwrap().max_props as usize {
        let prop = json!({ "id": format!("q{index}"), "assetId": "barrel", "x": (index % 90) as f64 + 0.5, "y": (index / 90) as f64 + 20.5, "rotation": index % 360, "footprint": [] });
        t::add_prop(&mut full, &prop).unwrap();
    }
    let full_size = stringify(&t::serialize_tactical_map(&full).unwrap()).len() as f64 / 1024.0;
    let per_prop = (full_size - size) * 1024.0 / (t::size_class("region").unwrap().max_props - 200) as f64;
    assert!(per_prop < 80.0, "предмет стоит {per_prop:.0} байт — сериализация раздулась");
    let restored = round_trip(&map);
    assert_eq!(t::cell_count(&restored), t::cell_count(&map));
    assert_eq!(t::cell_at(&restored, 50, 50), t::cell_at(&map, 50, 50));
    assert_eq!(t::edge_list(&restored).len(), t::edge_list(&map).len());
}

#[test]
fn path_through_region_map_within_25_ms() {
    let map = region_map(true, 200);
    let mut reached = 0;
    let median = measure("поиск пути 100×100", || reached = t::reachable_cells(&map, 1, 1, true, None).len());
    assert!(reached > 7_000, "обход прошёл всего {reached} клеток — карта перестала быть связной");
    assert!(median <= 25.0, "поиск пути {median:.2} мс, порог — 25 мс");
}

#[test]
fn region_map_round_trip_and_legacy_cells_are_fast() {
    // У JS отдельного порога нет; запас — на отладочную сборку теста.
    let map = region_map(false, 200);
    let serialized = t::serialize_tactical_map(&map).unwrap();
    let median = measure("сериализация и чтение 100×100", || {
        let restored = t::deserialize_tactical_map(&serialized).unwrap();
        let _ = t::serialize_tactical_map(&restored).unwrap();
    });
    assert!(median <= 40.0, "круг через карту {median:.2} мс");
    let cells = measure("старые клетки 100×100", || {
        let _ = t::legacy_cells_from_tactical_map(&map);
    });
    assert!(cells <= 40.0, "старые клетки {cells:.2} мс");
}

#[test]
fn size_class_budgets_grow_monotonically() {
    for pair in t::SIZE_CLASSES.windows(2) {
        let (smaller, bigger) = (pair[0].1, pair[1].1);
        assert!(bigger.max_cells > smaller.max_cells && bigger.max_props > smaller.max_props && bigger.max_wall_edges > smaller.max_wall_edges, "{}", pair[1].0);
    }
    assert_eq!(t::size_class("region").unwrap().max_cells, 10_000, "целевой предел плана — 10 000 клеток");
}
