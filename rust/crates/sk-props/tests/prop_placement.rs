//! `server/prop-placement.mjs` против эталона JS (`fixtures/prop-placement.json`,
//! `fixtures/gen-prop-placement.mjs`) и проверки `test/prop-placement.test.mjs`,
//! `test/new-detail-props-placement.test.mjs`, `test/prop-supports.test.mjs`.

mod common;

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use common::{array, assert_error, map_hash, parse, restore, run_placement as run};
use serde_json::{json, Value};
use sk_core::js;
use sk_props::prop_placement::{
    attach_prop_supports, ensure_prop_access, is_indoor_theme, place_props, ZonePlacementPlan, DEFAULT_MAX_PROPS,
    INDOOR_THEMES, PROP_PLACEMENT_VERSION,
};
use sk_scene_base::asset_registry::asset_by_id;
use sk_tactical::tactical_map::{
    add_prop, cell_at, deserialize_tactical_map, edge_between, edge_neighbor, reachable_cells, serialize_tactical_map, validate_tactical_map, EdgeKind, PropMount,
    TacticalMap,
};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/prop-placement.json")));
static AUTHORED: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../../../../data/authored-location-maps-v1.json")));

/// Входная карта случая: синтетическая, нарисованная или выход прежнего случая.
fn input_map(input: &Value, outputs: &[TacticalMap]) -> TacticalMap {
    if let Some(index) = input.get("map").and_then(Value::as_u64) {
        return restore(&FIXTURE["maps"][index as usize]);
    }
    if let Some(index) = input.get("authored").and_then(Value::as_u64) {
        return restore(&AUTHORED["maps"][index as usize]);
    }
    let from = input["from"].as_u64().expect("вход случая") as usize;
    outputs[from].clone()
}

#[test]
fn constants_match_js() {
    assert_eq!(FIXTURE["version"].as_str(), Some(PROP_PLACEMENT_VERSION));
    let themes: Vec<&str> = array(&FIXTURE["indoorThemes"]).iter().filter_map(Value::as_str).collect();
    assert_eq!(themes, INDOOR_THEMES);
    assert!(is_indoor_theme("crypt") && !is_indoor_theme("yard"));
    assert_eq!(DEFAULT_MAX_PROPS, 250);
}

#[test]
fn every_case_matches_js() {
    let cases = array(&FIXTURE["cases"]);
    let mut outputs: Vec<TacticalMap> = Vec::with_capacity(cases.len());
    let mut mismatches = Vec::new();
    let mut ops: HashMap<&str, usize> = HashMap::new();
    for (index, case) in cases.iter().enumerate() {
        let op = case["op"].as_str().expect("операция");
        *ops.entry(op).or_insert(0) += 1;
        let mut map = input_map(&case["input"], &outputs);
        let outcome = run(&mut map, op, &case["args"]);
        let context = format!("случай {index} ({op}, вход {})", case["input"]);
        match (&outcome, case.get("error")) {
            (Ok(result), None) => {
                if result != &case["result"] {
                    mismatches.push(format!("{context}: ответ {result} вместо {}", case["result"]));
                }
            }
            (Err(error), Some(expected)) => assert_error(expected, error, &context),
            (Ok(_), Some(expected)) => mismatches.push(format!("{context}: ожидался отказ {expected}")),
            (Err(error), None) => mismatches.push(format!("{context}: отказ {error:?}")),
        }
        let hash = map_hash(&map);
        if hash != case["hash"].as_str().unwrap_or_default() {
            mismatches.push(format!("{context}: карта расходится (предметов {} против {})", map.props.len(), case["props"]));
        }
        outputs.push(map);
    }
    assert!(mismatches.is_empty(), "расхождений {} из {}:\n{}", mismatches.len(), cases.len(), mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() > 4000, "случаев {}", cases.len());
    // Каждый вид каталога (кроме проёмов на рёбрах) хоть раз встал на карту.
    let placed: HashSet<&str> = outputs.iter().flat_map(|map| map.props.iter().map(|prop| prop.asset_id.as_str())).collect();
    let missing: Vec<&str> = sk_scene_base::asset_registry::list_assets()
        .iter()
        .filter(|asset| !asset.themes.iter().any(|theme| theme == "openings"))
        .map(|asset| asset.id.as_str())
        .filter(|id| !placed.contains(id))
        .collect();
    assert!(missing.is_empty(), "не встали: {missing:?}");
    for op in ["placeProps", "ensurePropAccess", "attachPropSupports", "placeColonnade", "placeRequiredProps"] {
        assert!(ops.get(op).copied().unwrap_or(0) > 50, "операция {op} покрыта слабо: {:?}", ops.get(op));
    }
}

// --- сценарии переносимых тестов JS ------------------------------------------------------

fn scenario(name: &str) -> TacticalMap {
    let index = FIXTURE["scenarios"][name].as_u64().expect("сценарий") as usize;
    restore(&FIXTURE["maps"][index])
}

fn plan(zone_id: &str, theme: &str, density: f64) -> ZonePlacementPlan {
    ZonePlacementPlan { zone_id: zone_id.into(), theme: theme.into(), density, ..ZonePlacementPlan::default() }
}

fn tavern_plan() -> Vec<ZonePlacementPlan> {
    vec![
        ZonePlacementPlan { require: ["table_round", "chair", "bar_counter", "fireplace"].map(String::from).to_vec(), ..plan("hall", "interior", 18.0) },
        ZonePlacementPlan { require: ["tree_oak", "bush"].map(String::from).to_vec(), ..plan("yard", "yard", 10.0) },
    ]
}

fn place(seed: &str) -> TacticalMap {
    let mut map = scenario("tavernWithYard");
    place_props(&mut map, seed, &tavern_plan(), 250).expect("расстановка");
    map
}

fn zone_of(map: &TacticalMap, x: f64, y: f64) -> Option<String> {
    cell_at(map, x.floor() as i64, y.floor() as i64).map(|cell| cell.zone.to_string())
}

fn serialized(map: &TacticalMap) -> String {
    js::stringify(&serialize_tactical_map(map).expect("сериализация"))
}

#[test]
fn placement_is_deterministic_by_seed() {
    assert_eq!(serialized(&place("same")), serialized(&place("same")));
    assert_ne!(serialized(&place("same")), serialized(&place("other")));
}

#[test]
fn placed_map_passes_structural_validation() {
    let report = validate_tactical_map(&place("seed-1"));
    assert!(report.errors.is_empty(), "{:?}", report.errors);
}

#[test]
fn footprints_do_not_overlap_or_enter_walls() {
    let map = place("seed-1");
    let mut seen = HashSet::new();
    for prop in &map.props {
        for cell in &prop.footprint {
            assert!(seen.insert((cell.x, cell.y)), "клетка {},{} занята дважды", cell.x, cell.y);
            assert!(cell_at(&map, cell.x, cell.y).is_some_and(|cell| cell.passable), "предмет {} стоит в стене", prop.id);
        }
    }
}

#[test]
fn trees_stay_outside_and_furniture_inside() {
    let map = place("seed-1");
    for prop in &map.props {
        let zone = zone_of(&map, prop.x, prop.y);
        if prop.asset_id.starts_with("tree_") || prop.asset_id == "bush" || prop.asset_id == "shrub" {
            assert_eq!(zone.as_deref(), Some("yard"), "{} в зоне {zone:?}", prop.asset_id);
            assert_eq!(cell_at(&map, prop.x.floor() as i64, prop.y.floor() as i64).map(|cell| cell.material), Some("grass"));
        }
        if ["bar_counter", "fireplace", "table_round", "chair"].contains(&prop.asset_id.as_str()) {
            assert_eq!(zone.as_deref(), Some("hall"), "{} вне зала", prop.asset_id);
        }
    }
}

#[test]
fn chairs_stand_by_tables_and_face_them() {
    let map = place("seed-1");
    let tables: Vec<_> = map.props.iter().filter(|prop| prop.asset_id.starts_with("table_") || prop.asset_id == "bar_counter").collect();
    let chairs: Vec<_> = map.props.iter().filter(|prop| prop.asset_id == "chair" || prop.asset_id == "stool").collect();
    assert!(!tables.is_empty() && !chairs.is_empty());
    for chair in chairs {
        let distance = tables
            .iter()
            .map(|table| ((table.x.floor() - chair.x.floor()).abs()).max((table.y.floor() - chair.y.floor()).abs()))
            .fold(f64::INFINITY, f64::min);
        assert!(distance <= 2.0, "стул {} в {distance} клетках от стола", chair.id);
        let measure = |prop: &&sk_tactical::tactical_map::TacticalProp| (prop.x - chair.x).abs().max((prop.y - chair.y).abs());
        let mut table = tables[0];
        for candidate in &tables {
            if measure(candidate) < measure(&table) {
                table = candidate;
            }
        }
        let dx = table.x.floor() - chair.x.floor();
        let dy = table.y.floor() - chair.y.floor();
        let expected = if dx.abs() >= dy.abs() {
            if dx >= 0.0 {
                270.0
            } else {
                90.0
            }
        } else if dy >= 0.0 {
            0.0
        } else {
            180.0
        };
        assert_eq!(chair.rotation, expected, "стул {} повёрнут не к столу", chair.id);
    }
}

#[test]
fn wall_anchored_props_face_into_the_room() {
    let map = place("seed-1");
    let anchored: Vec<_> = map.props.iter().filter(|prop| ["barrel", "crate", "bar_counter", "fireplace", "bookshelf"].contains(&prop.asset_id.as_str())).collect();
    assert!(!anchored.is_empty());
    for prop in anchored {
        let (x, y) = (prop.x.floor() as i64, prop.y.floor() as i64);
        let walls: Vec<f64> = [(0, -1, 180.0), (1, 0, 270.0), (0, 1, 0.0), (-1, 0, 90.0)]
            .into_iter()
            .filter(|(dx, dy, _)| !cell_at(&map, x + dx, y + dy).is_some_and(|cell| cell.passable))
            .map(|(_, _, facing)| facing)
            .collect();
        assert!(!walls.is_empty(), "{} стоит не у стены", prop.id);
        assert!(walls.contains(&prop.rotation), "{} повёрнут на {}°", prop.id, prop.rotation);
    }
}

#[test]
fn small_tableware_occupies_nothing_and_lies_on_top() {
    let map = place("seed-1");
    for prop in &map.props {
        if ["mug", "plate", "bottle", "candle", "jug", "bowl_stew"].contains(&prop.asset_id.as_str()) {
            assert!(prop.footprint.is_empty());
            assert_eq!(prop.z_order, 1, "утварь обязана рисоваться поверх мебели");
        }
    }
}

#[test]
fn density_is_set_per_zone_and_budget_holds() {
    let mut dense = scenario("tavernWithYard");
    place_props(&mut dense, "density", &[plan("hall", "interior", 30.0), plan("yard", "yard", 2.0)], DEFAULT_MAX_PROPS).expect("расстановка");
    let in_zone = |zone: &str| dense.props.iter().filter(|prop| zone_of(&dense, prop.x, prop.y).as_deref() == Some(zone)).count();
    assert!(in_zone("hall") > in_zone("yard") * 2);
    let mut budget = scenario("tavernWithYard");
    place_props(&mut budget, "budget", &tavern_plan(), 5).expect("расстановка");
    assert!(budget.props.len() <= 5);
}

#[test]
fn wide_identical_props_do_not_touch() {
    let mut map = scenario("stalls");
    let stalls = ZonePlacementPlan {
        require: vec!["market_stall".into(); 6],
        caps: vec![("market_stall".into(), Some(6.0))],
        ..plan("square", "settlement", 40.0)
    };
    place_props(&mut map, "stalls", &[stalls], DEFAULT_MAX_PROPS).expect("расстановка");
    let stalls: Vec<_> = map.props.iter().filter(|prop| prop.asset_id == "market_stall").collect();
    assert!(stalls.len() >= 2);
    for (index, left) in stalls.iter().enumerate() {
        for right in &stalls[index + 1..] {
            let touching = left.footprint.iter().any(|a| right.footprint.iter().any(|b| (a.x - b.x).abs().max((a.y - b.y).abs()) <= 1));
            assert!(!touching, "{} вплотную к {}", left.id, right.id);
        }
    }
}

#[test]
fn purposes_pick_their_room_groups() {
    let mut gallery = scenario("tavernWithYard");
    place_props(&mut gallery, "gallery-purpose", &[ZonePlacementPlan { purpose: "gallery".into(), ..plan("hall", "interior", 55.0) }], DEFAULT_MAX_PROPS).expect("галерея");
    let hall: Vec<&str> = gallery.props.iter().filter(|prop| zone_of(&gallery, prop.x, prop.y).as_deref() == Some("hall")).map(|prop| prop.asset_id.as_str()).collect();
    assert!(hall.contains(&"table_long") || hall.contains(&"table_small"));
    assert_eq!(hall.iter().filter(|id| **id == "chandelier").count(), 1);
    assert!(hall.iter().filter(|id| **id == "table_long").count() <= 2);
    assert!(hall.iter().any(|id| ["chair", "bench"].contains(id)));
    assert!(!hall.iter().any(|id| ["crate_stack", "barrel_stack", "haystack"].contains(id)));

    for (purpose, expected) in [("kitchen", &["kitchen_stove", "prep_table", "pantry_shelf"][..]), ("store", &["crate_stack", "barrel_stack"][..])] {
        let mut map = scenario("tavernWithYardWide");
        place_props(&mut map, &format!("{purpose}-purpose"), &[ZonePlacementPlan { purpose: purpose.into(), ..plan("hall", "interior", 45.0) }], DEFAULT_MAX_PROPS).expect("назначение");
        let assets: HashSet<&str> = map.props.iter().map(|prop| prop.asset_id.as_str()).collect();
        for id in expected {
            assert!(assets.contains(id), "{purpose}: нет {id}");
        }
    }

    let mut barracks = scenario("tavernWithYardWide");
    place_props(&mut barracks, "barracks-purpose", &[ZonePlacementPlan { purpose: "barracks".into(), ..plan("hall", "interior", 45.0) }], DEFAULT_MAX_PROPS).expect("казарма");
    let beds: Vec<_> = barracks.props.iter().filter(|prop| ["bed", "bunk_bed"].contains(&prop.asset_id.as_str())).collect();
    assert!(beds.len() >= 4);
    let mut rows: HashMap<i64, usize> = HashMap::new();
    for bed in &beds {
        *rows.entry(bed.y.floor() as i64).or_insert(0) += 1;
    }
    assert!(rows.values().copied().max().unwrap_or(0) >= 2, "койки не образуют ряда");
    assert!(barracks.props.iter().any(|prop| prop.asset_id == "night_table"));
    assert!(barracks.props.iter().any(|prop| prop.asset_id == "chest"));
    assert!(!barracks.props.iter().any(|prop| ["table_long", "bench", "chair"].contains(&prop.asset_id.as_str())));

    let mut stable = scenario("tavernWithYardWide");
    place_props(&mut stable, "stable-purpose", &[ZonePlacementPlan { purpose: "stable".into(), ..plan("yard", "yard", 32.0) }], DEFAULT_MAX_PROPS).expect("конюшня");
    let count = |id: &str| stable.props.iter().filter(|prop| prop.asset_id == id).count();
    assert_eq!(count("haystack"), 1);
    assert_eq!(count("water_trough"), 1);
    assert!(count("hitching_post") >= 1);
    assert!(count("cart") <= 2);

    let mut exterior = scenario("tavernWithYardWide");
    place_props(&mut exterior, "exterior-purpose", &[ZonePlacementPlan { purpose: "exterior".into(), ..plan("yard", "yard", 32.0) }], DEFAULT_MAX_PROPS).expect("улица");
    assert!(!exterior.props.iter().any(|prop| ["cart", "woodpile"].contains(&prop.asset_id.as_str())));
}

#[test]
fn passage_to_the_door_stays_free() {
    let mut map = scenario("tavernWithDoor");
    let zones = [
        ZonePlacementPlan { purpose: "gallery".into(), ..plan("hall", "interior", 70.0) },
        ZonePlacementPlan { purpose: "courtyard".into(), ..plan("yard", "yard", 35.0) },
    ];
    place_props(&mut map, "door-clearance", &zones, DEFAULT_MAX_PROPS).expect("расстановка");
    let occupied: HashSet<(i64, i64)> =
        map.props.iter().filter(|prop| prop.blocks_move).flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    for door in &map.doors {
        for cell in [(door.x, door.y), edge_neighbor(door.x, door.y, door.dir)] {
            assert!(!occupied.contains(&cell), "мебель на пороге {}", door.id);
        }
    }
    let spawn = (1, map.height / 2);
    let mut reached = HashSet::from([spawn]);
    let mut queue = vec![spawn];
    let mut index = 0;
    while index < queue.len() {
        let (x, y) = queue[index];
        index += 1;
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let next = (x + dx, y + dy);
            if reached.contains(&next) || occupied.contains(&next) || !cell_at(&map, next.0, next.1).is_some_and(|cell| cell.passable) {
                continue;
            }
            if edge_between(&map, x, y, next.0, next.1).ok().flatten().is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move) {
                continue;
            }
            reached.insert(next);
            queue.push(next);
        }
    }
    let door = &map.doors[0];
    assert!(reached.contains(&(door.x, door.y)), "до порога нельзя пройти");
}

#[test]
fn access_repair_opens_the_gate_and_drops_supported_tableware() {
    let mut map = scenario("gate1");
    let before = map.props.len();
    ensure_prop_access(&mut map);
    assert!(!map.props.iter().any(|prop| prop.id == "hall-table-0"), "перегородивший проход стол не снят");
    assert!(!map.props.iter().any(|prop| prop.id == "hall-mug-0"), "утварь пережила свою поверхность");
    assert!(map.props.iter().any(|prop| prop.id == "outside-decoration"), "ремонт снял посторонний предмет");
    assert_eq!(map.props.len(), before - 2);
    let spawn = map.spawn_points.iter().find(|point| point.role == "party").expect("точка появления");
    let blocked: HashSet<(i64, i64)> =
        map.props.iter().filter(|prop| prop.blocks_move).flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    let reached = reachable_cells(&map, spawn.x, spawn.y, true, Some(&blocked));
    assert!(reached.contains(&(6, 3)) && reached.contains(&(4, 3)));

    let mut first = scenario("gate2");
    let mut second = scenario("gate2");
    ensure_prop_access(&mut first);
    ensure_prop_access(&mut second);
    assert_eq!(first.props, second.props);
    assert!(!first.props.iter().any(|prop| prop.id == "hall-table-0" || prop.id == "hall-table-1"));
    assert!(first.props.iter().any(|prop| prop.id == "outside-decoration"));
}

// --- опоры утвари (`new-detail-props-placement`, `prop-supports`) ------------------------

fn add(map: &mut TacticalMap, prop: Value) {
    add_prop(map, &prop).expect("предмет");
}

const SURFACE_ITEMS: [&str; 8] = ["cutlery_set", "book_piles", "arcane_coil", "alchemy_bottles", "desk_candlestick", "ceremonial_chalice", "book_row", "scroll_pile"];

#[test]
fn new_tableware_mounts_on_a_table() {
    let mut map = scenario("detailRoom");
    add(&mut map, json!({ "id": "surface-table", "assetId": "table_round", "x": 3.5, "y": 3.5, "footprint": [{ "x": 2, "y": 2 }, { "x": 3, "y": 2 }, { "x": 2, "y": 3 }, { "x": 3, "y": 3 }], "blocksMove": true }));
    for (index, id) in SURFACE_ITEMS.iter().enumerate() {
        add(&mut map, json!({ "id": format!("surface-item-{index}"), "assetId": id, "x": 3.5, "y": 3.5, "footprint": [] }));
    }
    attach_prop_supports(&mut map).expect("опоры");
    let mounted: Vec<_> = map.props.iter().filter(|prop| SURFACE_ITEMS.contains(&prop.asset_id.as_str())).collect();
    assert_eq!(mounted.len(), SURFACE_ITEMS.len());
    for prop in mounted {
        assert!(prop.footprint.is_empty());
        assert_eq!(prop.mount, Some(PropMount::Surface { prop_id: "surface-table".into() }));
        assert_eq!(prop.z_order, 1);
    }
}

#[test]
fn new_tableware_without_surface_is_dropped_and_ivy_mounts_on_wall() {
    let mut map = scenario("detailRoom");
    add(&mut map, json!({ "id": "orphan-bottles", "assetId": "alchemy_bottles", "x": 3.5, "y": 3.5, "footprint": [] }));
    add(&mut map, json!({ "id": "orphan-keys", "assetId": "key_bundle", "x": 4.5, "y": 3.5, "footprint": [] }));
    add(&mut map, json!({ "id": "ivy", "assetId": "wall_ivy", "x": 0.5, "y": 3.5, "footprint": [] }));
    attach_prop_supports(&mut map).expect("опоры");
    assert!(!map.props.iter().any(|prop| prop.id == "orphan-bottles" || prop.id == "orphan-keys"));
    let ivy = map.props.iter().find(|prop| prop.id == "ivy").expect("плющ");
    assert!(matches!(ivy.mount, Some(PropMount::Wall { .. })));
    let rails = asset_by_id("mine_rail").expect("рельсы");
    assert_eq!(rails.kind, "decal");
    assert_eq!((rails.base_footprint.w, rails.base_footprint.h), (0.0, 0.0));
    assert!(!rails.blocks_move && !rails.blocks_sight);
}

#[test]
fn alchemy_table_is_not_a_support_but_writing_desk_is() {
    let mut map = scenario("detailRoom");
    add(&mut map, json!({ "id": "busy-table", "assetId": "alchemy_table", "x": 3.5, "y": 3.5, "footprint": [{ "x": 3, "y": 3 }, { "x": 4, "y": 3 }], "blocksMove": true }));
    add(&mut map, json!({ "id": "loose-book", "assetId": "single_book", "x": 3.5, "y": 3.5, "footprint": [] }));
    attach_prop_supports(&mut map).expect("опоры");
    assert!(map.props.iter().any(|prop| prop.id == "busy-table"));
    assert!(!map.props.iter().any(|prop| prop.id == "loose-book"));

    let mut desk = scenario("detailRoom");
    add(&mut desk, json!({ "id": "desk", "assetId": "writing_desk", "x": 3, "y": 3.5, "footprint": [{ "x": 2, "y": 3 }, { "x": 3, "y": 3 }], "blocksMove": true }));
    add(&mut desk, json!({ "id": "books", "assetId": "book_piles", "x": 3.5, "y": 4.5, "footprint": [] }));
    attach_prop_supports(&mut desk).expect("опоры");
    let books = desk.props.iter().find(|prop| prop.id == "books").expect("книги");
    assert_eq!(books.mount, Some(PropMount::Surface { prop_id: "desk".into() }));
}

#[test]
fn without_surface_new_tableware_is_not_drawn_into_fill() {
    let mut map = scenario("detailRoom");
    let prefer = ["book_piles", "scroll_pile", "single_book", "desk_candlestick", "globe"].map(String::from).to_vec();
    place_props(&mut map, "no-surface", &[ZonePlacementPlan { prefer, ..plan("hall", "study", 40.0) }], DEFAULT_MAX_PROPS).expect("расстановка");
    assert!(!map.props.iter().any(|prop| ["book_piles", "scroll_pile", "single_book", "desk_candlestick"].contains(&prop.asset_id.as_str())));
    assert!(map.props.iter().any(|prop| prop.asset_id == "globe"), "бюджет достался предметам, которые встают");
}

#[test]
fn supports_survive_roundtrip_and_repeat() {
    let mut map = scenario("supports");
    let table = map.prop("table").expect("стол").clone();
    let passable = map.layers.passable.clone();
    attach_prop_supports(&mut map).expect("опоры");
    let mounted: Vec<_> = map.props.iter().filter(|prop| matches!(prop.mount, Some(PropMount::Surface { .. }))).collect();
    assert_eq!(mounted.len(), 3);
    assert_eq!(mounted.iter().map(|prop| format!("{},{}", prop.x, prop.y)).collect::<HashSet<_>>().len(), 3);
    for prop in &mounted {
        assert_eq!(prop.mount, Some(PropMount::Surface { prop_id: "table".into() }));
        assert!(prop.footprint.is_empty() && !prop.blocks_move);
        assert!(prop.z_order > table.z_order);
        assert!(table.footprint.iter().any(|cell| cell.x == prop.x.floor() as i64 && cell.y == prop.y.floor() as i64));
    }
    assert_eq!(map.layers.passable, passable);
    assert_eq!(map.prop("table").expect("стол").footprint, table.footprint);
    let stored = serialize_tactical_map(&map).expect("сериализация");
    assert_eq!(serialize_tactical_map(&deserialize_tactical_map(&stored).expect("чтение")).expect("сериализация"), stored);
    let lantern = map.prop("lantern").expect("фонарь");
    assert_eq!(lantern.mount, Some(PropMount::Wall { side: "n" }));
    attach_prop_supports(&mut map).expect("повтор");
    assert_eq!(serialize_tactical_map(&map).expect("сериализация"), stored, "повтор не сдвигает закреплённую утварь");

    let mut small = scenario("supports");
    small.prop_mut("table").expect("стол").scale = 0.5;
    attach_prop_supports(&mut small).expect("опоры");
    let loaded = deserialize_tactical_map(&serialize_tactical_map(&small).expect("сериализация")).expect("чтение");
    for prop in loaded.props.iter().filter(|prop| matches!(prop.mount, Some(PropMount::Surface { .. }))) {
        assert!((prop.x - 3.0).abs() <= 0.25 && (prop.y - 3.0).abs() <= 0.25);
    }
    assert_eq!(loaded.prop("table").expect("стол").scale, 0.5);
}

#[test]
fn wall_mount_with_nan_coordinate_fails_like_js() {
    let mut map = scenario("supports");
    let mut raw = serialize_tactical_map(&map).expect("сериализация");
    raw["props"].as_array_mut().expect("предметы").push(json!({ "id": "nan-torch", "assetId": "torch_wall", "footprint": [] }));
    map = deserialize_tactical_map(&raw).expect("чтение");
    let error = attach_prop_supports(&mut map).expect_err("NaN роняет опоры");
    assert_eq!(error.code, "EDGE_CELLS_NOT_ADJACENT");
    assert_eq!(error.message, "Клетки NaN,NaN и NaN,NaN не соседние — ребра между ними не существует");
}
