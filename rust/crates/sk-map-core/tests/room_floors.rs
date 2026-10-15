//! Сверка `room_floors` с эталоном JS (`fixtures/room-floors.json`, генератор
//! `fixtures/gen-room-floors.mjs`) и проверки `test/room-floors.test.mjs`,
//! касающиеся самого модуля.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, assert_same_or_hash, option_text, parse, restore, round_trip, serialize, UNDEFINED};
use serde_json::{json, Value};
use sk_map_core::room_floors::{apply_room_floors, building_wall_style_for, room_floor_for, RoomContext, RoomFloor, RoomFloorsOptions, ROOM_FLOORS_VERSION};
use sk_tactical::tactical_map::{self as t, CellPatch, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/room-floors.json")));

fn floor_json(floor: Option<RoomFloor>) -> Value {
    floor.map_or(Value::Null, |floor| floor.to_json())
}

#[test]
fn room_floor_for_matches_js() {
    assert_eq!(FIXTURE["version"], ROOM_FLOORS_VERSION);
    let cases = array(&FIXTURE["floorFor"]);
    assert!(cases.len() > 5_000);
    for case in cases {
        let zone = &case["zone"];
        let context = &case["context"];
        let context = RoomContext { use_: option_text(context, "use", ""), architecture: option_text(context, "architecture", "wood") };
        let id = zone["id"].as_str().unwrap_or("");
        let label = zone.get("label").and_then(Value::as_str).unwrap_or("");
        let actual = floor_json(room_floor_for(id, label, &context));
        assert_same(&actual, &case["result"], &format!("{zone} {}", case["context"]));
    }
}

#[test]
fn building_wall_style_matches_js() {
    for case in array(&FIXTURE["wallStyle"]) {
        let context = &case["context"];
        let urban = sk_core::js::truthy(context.get("urban"));
        let style = building_wall_style_for(&RoomContext { use_: option_text(context, "use", ""), architecture: option_text(context, "architecture", "wood") }, urban);
        let actual = style.map_or(Value::Null, |style| Value::String(style.into()));
        assert_ne!(case["result"], UNDEFINED);
        assert_same(&actual, &case["result"], &context.to_string());
    }
}

#[test]
fn apply_room_floors_matches_js() {
    let cases = array(&FIXTURE["apply"]);
    assert_eq!(cases.len(), 300);
    for (index, case) in cases.iter().enumerate() {
        let mut map = restore(&case["before"]);
        let outcome = common::room_floors_call(&mut map, case);
        let context = format!("случай {index}");
        assert_same(&outcome, &case["outcome"], &context);
        assert_same_or_hash(&serialize(&map), &case["after"], &context);
    }
}

#[test]
fn purpose_rules() {
    let floor = |id: &str, label: &str, use_: &str, architecture: &str| floor_json(room_floor_for(id, label, &RoomContext { use_, architecture }));
    assert_eq!(floor("zone-3", "Камеры", "dungeon", "stone"), json!({ "material": "earth", "floor": "straw" }));
    assert_eq!(floor("kitchen", "Кухня", "", "wood"), json!({ "material": "stone", "floor": "flagstone" }));
    assert_eq!(floor("kitchen", "Кухня", "", "ice"), Value::Null, "ледяной дворец не мостят");
    assert_eq!(floor("store", "Кладовая", "", "stone"), json!({ "material": "stone", "floor": "flagstone" }));
    assert_eq!(room_floor_for("cellar", "Погреб", &RoomContext::default()).and_then(|floor| floor.floor).as_deref(), Some("flagstone"), "«cellar» — не тюремная камера");
    let wall = |use_: &str, architecture: &str, urban: bool| building_wall_style_for(&RoomContext { use_, architecture }, urban);
    assert_eq!(wall("tavern", "wood", true), Some("fachwerk"));
    assert_eq!(wall("dwelling", "wood", true), None);
    assert_eq!(wall("workshop", "stone", false), Some("brick"));
}

#[test]
fn floor_and_masonry_are_only_drawing() {
    let fill = CellPatch { passable: Some(true), revealed: Some(true), material: Some("wood"), ..CellPatch::default() };
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 3, height: 1, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior", "material": "wood", "label": "Общий зал" })).expect("зал");
    t::add_zone(&mut map, &json!({ "id": "kitchen", "kind": "interior", "material": "wood", "label": "Кухня" })).expect("кухня");
    t::set_cell(&mut map, 0, 0, &CellPatch { zone: Some("hall"), ..CellPatch::default() }).expect("клетка");
    t::set_cell(&mut map, 1, 0, &CellPatch { zone: Some("kitchen"), ..CellPatch::default() }).expect("клетка");
    t::set_cell(&mut map, 2, 0, &CellPatch { zone: Some("kitchen"), passable: Some(false), ..CellPatch::default() }).expect("клетка");
    let options = RoomFloorsOptions { context: RoomContext { use_: "tavern", ..RoomContext::default() }, wall: Some("fachwerk"), ..RoomFloorsOptions::default() };
    assert_eq!(apply_room_floors(&mut map, &options).expect("пол"), 2);
    assert_eq!(t::cell_at(&map, 1, 0).expect("клетка").material, "stone");
    assert_eq!(t::cell_at(&map, 2, 0).expect("клетка").material, "wood", "непроходимая клетка — кладка, её пол не красится");
    // Проход ставит кладку раньше рисунка пола — как объект JS; чтение карты — наоборот.
    let serialized = serialize(&map);
    assert_eq!(serialized["zones"][0], json!({ "id": "hall", "kind": "interior", "material": "wood", "lightLevel": "bright", "floorDirection": "horizontal", "label": "Общий зал", "wall": "fachwerk", "floor": "planks-dark" }));
    let restored = round_trip(&map);
    let styles: Vec<(String, Option<String>, Option<String>)> =
        restored.zones.iter().map(|zone| (zone.id.clone(), zone.floor().map(str::to_string), zone.wall().map(str::to_string))).collect();
    assert_eq!(
        styles,
        vec![("hall".into(), Some("planks-dark".into()), Some("fachwerk".into())), ("kitchen".into(), Some("flagstone".into()), Some("fachwerk".into()))]
    );
    assert_eq!(serialize(&restored)["zones"][0]["floor"], "planks-dark");
    assert_eq!(serialize(&restored)["zones"][0].as_object().map(|zone| zone.keys().cloned().collect::<Vec<_>>()).unwrap_or_default().last().map(String::as_str), Some("wall"));
    assert!(t::edge_between(&restored, 0, 0, 1, 0).expect("ребро").is_none(), "пол не ставит стен");
    // Незнакомый рисунок карта не принимает.
    let mut strange = t::create_tactical_map(&TacticalMapOptions::default()).expect("карта");
    t::add_zone(&mut strange, &json!({ "id": "x", "kind": "interior", "floor": "lava", "wall": "glass" })).expect("зона");
    assert!(strange.zones[0].floor().is_none() && strange.zones[0].wall().is_none());
}

#[test]
fn unknown_default_material_fails_like_set_cell() {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    let mut map = t::create_tactical_map(&TacticalMapOptions { width: 2, height: 1, fill: Some(fill), ..TacticalMapOptions::default() }).expect("карта");
    t::add_zone(&mut map, &json!({ "id": "room", "kind": "interior", "label": "Пустая" })).expect("зона");
    t::set_cell(&mut map, 0, 0, &CellPatch { zone: Some("room"), ..CellPatch::default() }).expect("клетка");
    let gold = RoomFloor::new("gold", Some("parquet"));
    let options = RoomFloorsOptions { default_floor: Some(&gold), ..RoomFloorsOptions::default() };
    let error = apply_room_floors(&mut map, &options).expect_err("незнакомый материал");
    assert_eq!(error.code, "ENUM_VALUE_NOT_ALLOWED");
    assert_eq!(error.message, "Недопустимое значение material: gold");
    // Рисунок зоны к отказу уже поставлен — как в JS.
    assert_eq!(map.zones[0].floor(), Some("parquet"));
}
