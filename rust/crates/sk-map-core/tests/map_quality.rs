//! Сверка `map_quality` с эталоном JS (`fixtures/map-quality.json`,
//! генератор `fixtures/gen-map-quality.mjs`): корпус нарисованных карт,
//! испорченные карты (корпус, сгенерированные сцены, случайные планировки с
//! предметами) — аудит, проверка программы сцены и настилы; плюс проверки
//! `test/map-quality.test.mjs`, где предмет — сам аудит.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, hash, parse, program_options, restore};
use serde_json::{json, Value};
use sk_map_core::map_quality::{
    audit_tactical_map, count_platforms, focus_room, platform_cells, program_report, prop_cells, MapReport, ProgramOptions, Spot, FOCUS_MIN_ROOM,
    MAP_PREVIEW_PRESETS, MULTI_ROOM_MIN_CELLS, SETTLEMENT_MIN_SIZE, STEP_WITHOUT_CLIMB_FEET,
};
use sk_tactical::tactical_map::{self as t, CellPatch, EdgePatch, TacticalMap, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/map-quality.json")));
static CATALOG: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../../../../data/authored-location-maps-v1.json")));

fn int(value: &Value) -> i64 {
    value.as_i64().unwrap_or_else(|| panic!("целое в эталоне: {value}"))
}

/// Правка карты из эталона — тем же API, что и в JS.
fn apply_op(map: &mut TacticalMap, op: &Value) {
    match op["op"].as_str().unwrap_or("") {
        name @ ("removeDoor" | "unhingeDoor") => {
            let door = map.doors.remove(int(&op["index"]) as usize);
            let (nx, ny) = t::edge_neighbor(door.x, door.y, door.dir);
            let kind = if name == "removeDoor" { "wall" } else { "none" };
            t::set_edge(map, door.x, door.y, nx, ny, &EdgePatch { kind: Some(kind), ..EdgePatch::default() }).expect("ребро");
        }
        "prop" => {
            t::add_prop(map, &op["prop"]).expect("предмет");
        }
        "props" => {
            for prop in array(&op["props"]) {
                t::add_prop(map, prop).expect("предмет");
            }
        }
        "cell" => t::set_cell_json(map, int(&op["x"]), int(&op["y"]), &op["patch"]).expect("клетка"),
        "cells" => {
            for cell in array(&op["cells"]) {
                t::set_cell_json(map, int(&cell["x"]), int(&cell["y"]), &op["patch"]).expect("клетка");
            }
        }
        "edge" => {
            t::set_edge_json(map, int(&op["x"]), int(&op["y"]), int(&op["nx"]), int(&op["ny"]), &op["edge"]).expect("ребро");
        }
        "spawn" => {
            if let Some(party) = map.spawn_points.iter_mut().find(|point| point.role == "party") {
                party.x = int(&op["x"]);
                party.y = int(&op["y"]);
            }
        }
        "dropSpawn" => map.spawn_points.retain(|point| point.role != "party"),
        other => panic!("неизвестная правка {other}"),
    }
}

/// Аудит в форме эталона: числа целиком или хешем.
#[track_caller]
fn assert_audit(actual: &MapReport, expected: &Value, context: &str) {
    let mut actual = actual.to_json();
    if expected["stats"].is_string() {
        actual["stats"] = Value::String(hash(&actual["stats"]));
    }
    assert_same(&actual, expected, context);
}

fn platforms_json(map: &TacticalMap) -> Value {
    let cells: Vec<Value> = platform_cells(map).into_iter().map(|(x, y)| json!({ "x": x, "y": y })).collect();
    json!([hash(&Value::Array(cells)), count_platforms(map)])
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["multiRoomMinCells"], MULTI_ROOM_MIN_CELLS);
    assert_eq!(constants["stepWithoutClimbFeet"], STEP_WITHOUT_CLIMB_FEET);
    assert_eq!(constants["settlementMinSize"], json!({ "width": SETTLEMENT_MIN_SIZE.width, "height": SETTLEMENT_MIN_SIZE.height }));
    assert_eq!(constants["focusMinRoom"], FOCUS_MIN_ROOM);
    assert_same(&MAP_PREVIEW_PRESETS, &constants["previewPresets"], "MAP_PREVIEW_PRESETS");
}

#[test]
fn authored_corpus_matches_js() {
    let maps = array(&CATALOG["maps"]);
    let cases = array(&FIXTURE["authored"]);
    assert_eq!(cases.len(), 56);
    for case in cases {
        let map = restore(&maps[int(&case["index"]) as usize]);
        let context = format!("корпус {}", case["locationId"]);
        assert_eq!(map.location_id, case["locationId"].as_str().unwrap_or(""));
        assert_audit(&audit_tactical_map(&map), &case["audit"], &context);
        let report = program_report(&map, &case["program"], &program_options(&case["options"]));
        assert_same(&report.to_json(), &case["programReport"], &context);
        assert_same(&platforms_json(&map), &case["platforms"], &context);
    }
}

fn base_map(label: &str) -> TacticalMap {
    let mut parts = label.split(['/', ':']);
    let kind = parts.next().unwrap_or("");
    let index = parts.next().and_then(|index| index.parse::<usize>().ok()).expect("номер карты в метке");
    match kind {
        "authored" => restore(&CATALOG["maps"][index]),
        "generated" => restore(&FIXTURE["generated"][index]["map"]),
        "layout" => restore(&FIXTURE["layouts"][index]),
        other => panic!("неизвестная основа {other}"),
    }
}

#[test]
fn corrupted_maps_match_js() {
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 1_000);
    let mut codes: Vec<String> = Vec::new();
    for case in cases {
        let label = case["label"].as_str().expect("метка");
        let mut map = base_map(label);
        for op in array(&case["ops"]) {
            apply_op(&mut map, op);
        }
        let audit = audit_tactical_map(&map);
        assert_audit(&audit, &case["audit"], label);
        let report = program_report(&map, &case["program"], &program_options(&case["options"]));
        assert_same(&report.to_json(), &case["programReport"], label);
        assert_same(&platforms_json(&map), &case["platforms"], label);
        for problem in audit.problems.iter().chain(&audit.warnings).chain(&report.problems).chain(&report.warnings) {
            if !codes.iter().any(|code| code == problem.code) {
                codes.push(problem.code.to_string());
            }
        }
    }
    // Порча доходит до каждого кода замечания аудита и проверки программы.
    let mut expected = vec![
        "PROP_OUT_OF_BOUNDS", "PROP_ON_SOLID_CELL", "PROP_BLOCKS_WINDOW", "PROPS_OVERLAP", "DOOR_TO_NOWHERE", "DOORWAY_BLOCKED", "WINDOW_BETWEEN_ROOMS",
        "DOOR_OFF_ROAD", "PATH_BLOCKED", "BUILDING_CUT_BY_EDGE", "PASSAGE_OFF_MAP", "BUILDING_WITHOUT_EXIT", "BUILDING_SINGLE_ROOM", "BUILDING_WITHOUT_WINDOWS",
        "NO_PARTY_SPAWN", "PARTY_SPAWN_BLOCKED", "UNREACHABLE_FLOOR", "REPEATED_CLUSTER", "MONOTONOUS_PROPS", "SPAWN_CRAMPED", "OPEN_GROUND_NO_COVER",
        "HALL_NO_COVER", "PROGRAM_ANCHOR_MISSING", "PROGRAM_ITEM_MISSING", "PROGRAM_ANCHOR_UNREACHABLE", "FOCUS_CRAMPED", "PROP_ON_EDGE", "SCENE_TOO_SMALL",
        "OPEN_SCENE_CLUTTERED", "UNREACHABLE_POCKET",
    ];
    expected.sort_unstable();
    codes.sort_unstable();
    assert_eq!(codes, expected);
}

// --- проверки test/map-quality.test.mjs ------------------------------------

/// Параметры образца дома (`sampleHouse`).
#[derive(Clone, Copy)]
struct House {
    door: bool,
    windows: bool,
    prop: Option<(&'static str, i64, i64)>,
    cut_by_edge: bool,
}

impl Default for House {
    fn default() -> Self {
        Self { door: true, windows: true, prop: None, cut_by_edge: false }
    }
}

/// Дом 6×5 на лугу 12×9: стены клетками, внутри 4×3. Опции ломают его по одному признаку.
fn sample_house(options: House) -> TacticalMap {
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 12, height: 9, seed: "sample", generator: Some(("manual", "1")), ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "yard", "kind": "exterior", "material": "grass", "lightLevel": "bright", "floorDirection": "horizontal", "label": "Двор" })).expect("двор");
    t::add_zone(&mut map, &json!({ "id": "room", "kind": "interior", "material": "wood", "lightLevel": "dim", "floorDirection": "horizontal", "label": "Комната" })).expect("комната");
    let left = if options.cut_by_edge { 0 } else { 3 };
    for y in 0..9 {
        for x in 0..12 {
            t::set_cell(&mut map, x, y, &CellPatch { passable: Some(true), material: Some("grass"), zone: Some("yard"), revealed: Some(true), ..CellPatch::default() }).expect("клетка");
        }
    }
    for y in 2..=6 {
        for x in left..=8 {
            let wall = (x == left && !options.cut_by_edge) || x == 8 || y == 2 || y == 6;
            let patch = CellPatch { passable: Some(!wall), material: Some("wood"), zone: Some(if wall { "" } else { "room" }), revealed: Some(true), ..CellPatch::default() };
            t::set_cell(&mut map, x, y, &patch).expect("дом");
        }
    }
    for y in 2..=6 {
        for x in left..=8 {
            if t::cell_passable(&map, x, y) {
                continue;
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if t::cell_passable(&map, x + dx, y + dy) {
                    t::set_edge(&mut map, x, y, x + dx, y + dy, &EdgePatch { kind: Some("wall"), ..EdgePatch::default() }).expect("стена");
                }
            }
        }
    }
    if options.door {
        t::set_cell(&mut map, 5, 6, &CellPatch { passable: Some(true), zone: Some("room"), ..CellPatch::default() }).expect("проём");
        t::set_edge(&mut map, 5, 6, 5, 5, &EdgePatch { kind: Some("none"), ..EdgePatch::default() }).expect("ребро");
        t::set_door(&mut map, &json!({ "id": "door", "x": 5, "y": 6, "dir": "s", "state": "closed", "blocksMove": false, "blocksSight": false })).expect("дверь");
    }
    if options.windows {
        t::set_edge(&mut map, 7, 2, 7, 1, &EdgePatch { kind: Some("window"), blocks_move: Some(true), blocks_sight: Some(false), ..EdgePatch::default() }).expect("окно");
    }
    if let Some((asset, x, y)) = options.prop {
        let prop = json!({ "id": "p", "assetId": asset, "x": x as f64 + 0.5, "y": y as f64 + 0.5, "rotation": 0, "scale": 1, "footprint": [{ "x": x, "y": y }], "zOrder": 0, "blocksMove": true, "blocksSight": false, "cover": "half", "destructible": false, "hp": 0, "interactive": false });
        t::add_prop(&mut map, &prop).expect("предмет");
    }
    t::add_spawn_point(&mut map, &json!({ "id": "party", "x": 10, "y": 8, "role": "party" })).expect("отряд");
    map
}

fn codes(map: &TacticalMap) -> Vec<&'static str> {
    audit_tactical_map(map).problems.iter().map(|problem| problem.code).collect()
}

#[test]
fn audit_catches_house_without_door_windows_cut_and_blocked_doorway() {
    assert_eq!(codes(&sample_house(House::default())), Vec::<&str>::new(), "исправный дом — чист");
    let closed = codes(&sample_house(House { door: false, ..House::default() }));
    assert!(closed.contains(&"BUILDING_WITHOUT_EXIT"));
    assert!(closed.contains(&"UNREACHABLE_FLOOR"));
    assert!(codes(&sample_house(House { cut_by_edge: true, ..House::default() })).contains(&"BUILDING_CUT_BY_EDGE"));
    assert!(codes(&sample_house(House { prop: Some(("barrel", 5, 5)), ..House::default() })).contains(&"DOORWAY_BLOCKED"));
    // Окно в толстой стене стоит на грани клетки кладки, и проверка видит его сквозь кладку.
    assert!(codes(&sample_house(House { windows: false, ..House::default() })).contains(&"BUILDING_WITHOUT_WINDOWS"));
}

#[test]
fn audit_catches_prop_beyond_the_edge() {
    let mut map = sample_house(House::default());
    let ghost = json!({ "id": "ghost", "assetId": "barrel", "x": 12.5, "y": 4.5, "rotation": 0, "scale": 1, "footprint": [{ "x": 12, "y": 4 }], "zOrder": 0, "blocksMove": true, "blocksSight": false, "cover": "half", "destructible": false, "hp": 0, "interactive": false, "state": "intact" });
    t::add_prop(&mut map, &ghost).expect("предмет");
    let audit = audit_tactical_map(&map);
    assert!(audit.problems.iter().any(|problem| problem.code == "PROP_OUT_OF_BOUNDS" && problem.detail.as_deref() == Some("barrel@12,4")));
    assert_eq!(audit.stats.get("props_outside"), Some(1));
}

#[test]
fn same_props_side_by_side_are_a_cluster() {
    let mut map = sample_house(House::default());
    for (index, x) in [4, 5, 6].into_iter().enumerate() {
        let urn = json!({ "id": format!("urn-{index}"), "assetId": "urn", "x": x as f64 + 0.5, "y": 3.5, "rotation": 0, "scale": 1, "footprint": [{ "x": x, "y": 3 }], "zOrder": 0, "blocksMove": false, "blocksSight": false, "cover": "none", "destructible": false, "hp": 0, "interactive": false });
        t::add_prop(&mut map, &urn).expect("урна");
    }
    let audit = audit_tactical_map(&map);
    assert!(audit.problems.iter().any(|problem| problem.code == "REPEATED_CLUSTER" && problem.detail.as_deref() == Some("urn×3@4,3")));
}

#[test]
fn bare_hall_has_no_cover_until_pillars_stand() {
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 18, height: 16, seed: "hall", generator: Some(("manual", "1")), ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior", "material": "stone", "lightLevel": "dim", "floorDirection": "horizontal", "label": "Зал" })).expect("зал");
    for y in 0..16 {
        for x in 0..18 {
            let wall = x == 0 || y == 0 || x == 17 || y == 15;
            let patch = CellPatch { passable: Some(!wall), material: Some("stone"), zone: Some(if wall { "" } else { "hall" }), revealed: Some(true), ..CellPatch::default() };
            t::set_cell(&mut map, x, y, &patch).expect("клетка");
        }
    }
    t::add_spawn_point(&mut map, &json!({ "id": "party", "x": 2, "y": 2, "role": "party" })).expect("отряд");
    let bare = audit_tactical_map(&map);
    assert!(bare.warnings.iter().any(|warning| warning.code == "HALL_NO_COVER"), "{:?}", bare.warnings);
    for (index, (x, y)) in [(5, 5), (5, 10), (12, 5), (12, 10), (8, 7), (9, 8)].into_iter().enumerate() {
        let pillar = json!({ "id": format!("pillar-{index}"), "assetId": "pillar", "x": x as f64 + 0.5, "y": y as f64 + 0.5, "rotation": 0, "scale": 1, "footprint": [{ "x": x, "y": y }], "zOrder": 0, "blocksMove": true, "blocksSight": true, "cover": "three_quarters", "destructible": false, "hp": 0, "interactive": false });
        t::add_prop(&mut map, &pillar).expect("колонна");
    }
    assert!(!audit_tactical_map(&map).warnings.iter().any(|warning| warning.code == "HALL_NO_COVER"));
}

#[test]
fn wardrobe_before_window_is_an_error() {
    let mut map = sample_house(House::default());
    let window = t::edge_list(&map).into_iter().find(|edge| edge.kind == t::EdgeKind::Window).map(|edge| ((edge.x, edge.y), t::edge_neighbor(edge.x, edge.y, edge.dir))).expect("окно");
    let inside = [window.0, window.1].into_iter().find(|(x, y)| t::cell_passable(&map, *x, *y)).expect("клетка у окна");
    let wardrobe = json!({ "id": "blind", "assetId": "wardrobe", "x": inside.0 as f64 + 0.5, "y": inside.1 as f64 + 0.5, "rotation": 0, "scale": 1, "footprint": [{ "x": inside.0, "y": inside.1 }], "zOrder": 0, "blocksMove": true, "blocksSight": true, "cover": "three_quarters", "destructible": false, "hp": 0, "interactive": false, "state": "intact" });
    t::add_prop(&mut map, &wardrobe).expect("шкаф");
    assert!(codes(&map).contains(&"PROP_BLOCKS_WINDOW"));
}

#[test]
fn empty_graph_has_no_loops() {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 10, height: 10, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "forest", "kind": "exterior" })).expect("лес");
    t::add_spawn_point(&mut map, &json!({ "id": "party", "x": 1, "y": 5, "role": "party" })).expect("отряд");
    let stats = audit_tactical_map(&map).stats;
    assert_eq!(stats.get("rooms"), Some(0));
    assert_eq!(stats.get("loops"), Some(0), "пустой граф не даёт «одну петлю»");
}

#[test]
fn focus_room_counts_free_reachable_cells_around_the_footprint() {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    let map = t::create_tactical_map(&TacticalMapOptions { width: 9, height: 9, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта");
    let reached = t::reachable_cells(&map, 0, 0, true, None);
    let blocked = std::collections::HashSet::from([(4, 6)]);
    // Квадрат 5×5 вокруг клетки — 24 соседа, один из них занят.
    assert_eq!(focus_room(&[Spot::new(4.0, 4.0)], &reached, &blocked), 23);
    // Клетки без координат (`NaN`) просторы не дают.
    assert_eq!(focus_room(&[Spot::new(f64::NAN, 4.0)], &reached, &blocked), 0);
    let report = program_report(&map, &json!({ "items": [{ "id": "well" }], "focus": "well" }), &ProgramOptions::default());
    // Центр сцены обязателен: колодца нет — провал, а не предупреждение.
    assert!(report.problems.iter().any(|problem| problem.code == "PROGRAM_ANCHOR_MISSING" && problem.detail.as_deref() == Some("well")));
    assert_eq!(report.missing, vec!["well".to_string()]);
}

#[test]
fn prop_cells_fall_back_to_the_floor_of_coordinates() {
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 3, height: 3, ..TacticalMapOptions::default() }).expect("карта");
    let prop = t::add_prop(&mut map, &json!({ "id": "a", "assetId": "barrel", "x": 1.75, "y": 0.25 })).expect("бочка").clone();
    assert_eq!(prop_cells(&prop), vec![Spot::new(1.0, 0.0)]);
    let ghost = t::add_prop(&mut map, &json!({ "id": "b", "assetId": "barrel", "y": 1 })).expect("бочка").clone();
    assert_eq!(prop_cells(&ghost)[0].text(), "NaN,1");
    assert_eq!(prop_cells(&ghost)[0].key(), None);
}
