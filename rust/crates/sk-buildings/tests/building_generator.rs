//! Перенос `test/building-generator.test.mjs` и проверок генератора зданий из
//! `test/map-quality.test.mjs` и `test/scene-themes.test.mjs`. Сцены, которые
//! JS-тесты строят через `generateSceneGeometry`, берутся входами, пойманными
//! в конвейере (`pipeline:*` эталона): конвейер ещё не перенесён, а
//! предмет проверки — карта генератора.

mod common;

use std::collections::{HashMap, HashSet};

use common::{array, build_case, map_hash, serialized, stringify, FIXTURE};
use serde_json::{json, Value};
use sk_buildings::building_generator::{
    build_ares_fortress_scene, build_building_scene, furnished_cells, generate_ares_fortress_scene, generate_building_scene, plan_rooms, reachability_issues, room_quarters,
    safe_room, tactical_fitness_warnings, Rect, ARES_FORTRESS_GENERATOR, ARES_FORTRESS_SIZE, BUILDING_GENERATOR, FURNISHED_QUARTER_CELLS, REFERENCE_SIZE,
};
use sk_map_core::map_quality::audit_tactical_map;
use sk_tactical::tactical_map::{self as tm, EdgeKind, TacticalMap};

fn generate(options: Value) -> TacticalMap {
    generate_building_scene(&options).unwrap_or_else(|error| panic!("здание не собралось: {error}"))
}

fn build(options: Value) -> sk_buildings::building_generator::BuildingScene {
    build_building_scene(&options).unwrap_or_else(|error| panic!("сборка не удалась: {error}"))
}

fn scene() -> TacticalMap {
    generate(json!({ "seed": "reference" }))
}

/// Ассеты предметов, чья опорная клетка — в зоне.
fn assets_in(map: &TacticalMap, zone_id: &str) -> HashSet<String> {
    map.props
        .iter()
        .filter(|prop| tm::cell_at(map, prop.x.floor() as i64, prop.y.floor() as i64).is_some_and(|cell| cell.zone == zone_id))
        .map(|prop| prop.asset_id.clone())
        .collect()
}

fn asset_list_in(map: &TacticalMap, zone_id: &str) -> Vec<String> {
    map.props
        .iter()
        .filter(|prop| tm::cell_at(map, prop.x.floor() as i64, prop.y.floor() as i64).is_some_and(|cell| cell.zone == zone_id))
        .map(|prop| prop.asset_id.clone())
        .collect()
}

fn party(map: &TacticalMap) -> (i64, i64) {
    let spawn = map.spawn_points.iter().find(|point| point.role == "party").expect("точка отряда");
    (spawn.x, spawn.y)
}

fn passable_counts(map: &TacticalMap) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for cell in tm::cells(map).filter(|cell| cell.passable) {
        *counts.entry(cell.zone.to_string()).or_insert(0) += 1;
    }
    counts
}

fn zone_bounds(map: &TacticalMap, zone_id: &str) -> (i64, i64, i64, i64) {
    let cells: Vec<(i64, i64)> = tm::cells(map).filter(|cell| cell.zone == zone_id).map(|cell| (cell.x, cell.y)).collect();
    assert!(!cells.is_empty(), "{zone_id}: зона должна иметь клетки");
    (
        cells.iter().map(|cell| cell.0).min().unwrap_or(0),
        cells.iter().map(|cell| cell.1).min().unwrap_or(0),
        cells.iter().map(|cell| cell.0).max().unwrap_or(0),
        cells.iter().map(|cell| cell.1).max().unwrap_or(0),
    )
}

/// Пойманные в конвейере входы по префиксу метки.
fn pipeline_maps(prefix: &str) -> Vec<(String, TacticalMap)> {
    let labels: Vec<String> = array(&FIXTURE["cases"])
        .iter()
        .filter_map(|case| case["label"].as_str())
        .filter(|label| label.starts_with(&format!("pipeline:{prefix}")))
        .map(str::to_string)
        .collect();
    assert!(!labels.is_empty(), "нет случаев конвейера {prefix}");
    labels.into_iter().map(|label| (label.clone(), build_case(&label).map)).collect()
}

#[test]
fn density_changes_prop_count_with_same_layout() {
    let sparse = generate(json!({ "seed": "density-building", "width": 40, "height": 36, "design": { "building_use": "dwelling", "density": "sparse" } }));
    let dense = generate(json!({ "seed": "density-building", "width": 40, "height": 36, "design": { "building_use": "dwelling", "density": "dense" } }));
    assert_eq!(sparse.zones, dense.zones);
    assert!(dense.props.len() > sparse.props.len(), "{} против {}", sparse.props.len(), dense.props.len());
}

#[test]
fn reference_scene_is_about_26_by_26() {
    let map = scene();
    assert_eq!((map.width, map.height), (REFERENCE_SIZE.width, REFERENCE_SIZE.height));
    assert_eq!(map.width * map.height, 676);
}

#[test]
fn plan_rooms_keeps_three_room_scheme() {
    let plan = plan_rooms(Rect { min_x: 4, min_y: 4, max_x: 20, max_y: 20 });
    assert_eq!(plan.rooms.iter().map(|room| room.zone_id.as_str()).collect::<Vec<_>>(), ["hall", "kitchen", "store"]);
    assert_eq!((plan.partition_x, plan.partition_y), (14, 12));
}

#[test]
fn generation_is_deterministic_from_seed() {
    let first = stringify(&serialized(&generate(json!({ "seed": "same" }))));
    assert_eq!(first, stringify(&serialized(&generate(json!({ "seed": "same" })))));
    assert_ne!(first, stringify(&serialized(&generate(json!({ "seed": "other" })))));
}

#[test]
fn default_is_tavern_and_shop_theme_is_shop() {
    let tavern = generate(json!({ "seed": "theme-default" }));
    let shop = generate(json!({ "seed": "theme-shop", "theme": "market-shop" }));
    assert!(assets_in(&tavern, "hall").contains("bar_counter"));
    assert!(!assets_in(&shop, "hall").contains("bar_counter"));
    assert!(assets_in(&shop, "workshop").contains("table_long"));
}

#[test]
fn entry_controls_spawn_and_hall_reveal_keeping_props() {
    let exterior = generate(json!({ "seed": "entry-contract" }));
    let interior = generate(json!({ "seed": "entry-contract", "entry": "interior" }));
    let revealed_in = |map: &TacticalMap, zone: &str| tm::cells(map).filter(|cell| cell.zone == zone && cell.revealed).count();
    let outside = party(&exterior);
    let inside = party(&interior);
    assert_eq!(tm::cell_at(&exterior, outside.0, outside.1).map(|cell| cell.zone), Some("yard"));
    assert_eq!(tm::cell_at(&interior, inside.0, inside.1).map(|cell| cell.zone), Some("hall"));
    assert!(revealed_in(&interior, "hall") > 0);
    for zone in ["kitchen", "store"] {
        assert_eq!(revealed_in(&interior, zone), 0, "{zone}");
    }
    assert!(!interior.props.is_empty(), "внутренний вход не должен отключать реквизит");
    assert!(!interior.props.iter().any(|prop| prop.footprint.iter().any(|cell| (cell.x, cell.y) == inside)));
}

#[test]
fn reference_map_is_valid_with_three_rooms_and_yard() {
    let map = scene();
    assert!(tm::validate_tactical_map(&map).errors.is_empty());
    let mut labelled: Vec<&str> = map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| zone.id.as_str()).collect();
    labelled.sort_unstable();
    assert_eq!(labelled, ["hall", "kitchen", "store", "yard"]);
    assert_eq!(map.zones.iter().find(|zone| zone.id == "yard").map(|zone| zone.kind.as_str()), Some("exterior"));
    let counts = passable_counts(&map);
    for zone in ["hall", "kitchen", "store", "yard"] {
        assert!(counts.get(zone).copied().unwrap_or(0) > 4, "в зоне {zone} мало клеток");
    }
    assert!(counts["hall"] > counts["kitchen"], "общий зал обязан быть крупнее кухни");
}

#[test]
fn every_room_reachable_from_outside() {
    let map = scene();
    assert!(reachability_issues(&map).is_empty());
    let (x, y) = party(&map);
    let reached = tm::reachable_cells(&map, x, y, true, None);
    for zone in ["hall", "kitchen", "store"] {
        assert!(tm::cells(&map).any(|cell| cell.passable && cell.zone == zone && reached.contains(&(cell.x, cell.y))), "в помещение {zone} нет пути снаружи");
    }
}

#[test]
fn doors_on_edges_and_windows_block_move_not_sight() {
    let map = scene();
    assert_eq!(map.doors.len(), 4, "вход, задняя дверь кухни и две внутренние двери");
    assert!(map.doors.iter().any(|door| door.id == "back-door"));
    for door in &map.doors {
        let edge = map.edge(door.x, door.y, door.dir).unwrap_or_else(|| panic!("у двери {} нет ребра", door.id));
        assert_eq!(edge.kind, EdgeKind::Door);
        assert!(tm::cell_passable(&map, door.x, door.y), "проём обязан быть проходим");
    }
    let windows: Vec<_> = tm::edge_list(&map).into_iter().filter(|edge| edge.kind == EdgeKind::Window).collect();
    assert!(windows.len() >= 4, "окон слишком мало: {}", windows.len());
    assert!(windows.iter().all(|edge| edge.blocks_move && !edge.blocks_sight));
}

#[test]
fn walls_are_thin_edges_that_block_move_and_sight() {
    let map = scene();
    let walls: Vec<_> = tm::edge_list(&map).into_iter().filter(|edge| edge.kind == EdgeKind::Wall).collect();
    assert!(walls.len() > 30, "рёбер-стен всего {}", walls.len());
    let mut thin = 0;
    for edge in walls {
        let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
        let owner = tm::cell_at(&map, edge.x, edge.y).expect("клетка ребра");
        let neighbor = tm::cell_at(&map, nx, ny).expect("соседняя клетка ребра");
        assert!(edge.blocks_move && edge.blocks_sight);
        if !owner.passable || !neighbor.passable {
            continue;
        }
        thin += 1;
        assert!(tm::movement_step_blocked(&map, edge.x, edge.y, nx, ny).expect("соседи"), "сквозь тонкую стену не пройти");
    }
    assert!(thin > 20, "тонких стен всего {thin}");
}

#[test]
fn fence_has_gap_path_leads_in_and_trees_stay_outside() {
    let map = scene();
    assert!(tm::edge_list(&map).iter().filter(|edge| edge.kind == EdgeKind::Rail).count() > 20);
    let (x, y) = party(&map);
    assert!(tm::reachable_cells(&map, x, y, true, None).len() > 50);
    assert!(tm::cells(&map).filter(|cell| cell.material == "earth").count() >= 8, "тропа слишком короткая");
    assert!(map.props.len() > 20, "предметов всего {}", map.props.len());
    for prop in &map.props {
        let cell = tm::cell_at(&map, prop.x.floor() as i64, prop.y.floor() as i64).unwrap_or_else(|| panic!("предмет {} вне карты", prop.id));
        if prop.asset_id.starts_with("tree_") || prop.asset_id == "bush" || prop.asset_id == "well" {
            assert_eq!(cell.zone, "yard", "{} оказался в помещении", prop.asset_id);
        }
        if ["bar_counter", "fireplace", "table_round", "table_long"].contains(&prop.asset_id.as_str()) {
            assert_ne!(cell.zone, "yard", "{} оказался во дворе", prop.asset_id);
        }
    }
}

#[test]
fn overlays_and_legacy_cells() {
    let map = scene();
    assert!(map.overlays.compass && map.overlays.scale_bar);
    let mut labels: Vec<&str> = map.overlays.room_labels.iter().map(|label| label.zone_id.as_str()).collect();
    labels.sort_unstable();
    assert_eq!(labels, ["hall", "kitchen", "store", "yard"]);
    let cells = tm::legacy_cells_from_tactical_map(&map);
    assert_eq!(cells.len() as i64, map.width * map.height);
    assert!(cells.iter().any(|cell| cell["type"] == "wall" || cell.get("walls").is_some()), "стены обязаны читаться старым кодом");
    assert!(cells.iter().any(|cell| cell["type"] == "door"));
    assert!(cells.iter().any(|cell| cell.get("feature").is_some()));
    let _warnings = tactical_fitness_warnings(&map);
    assert!(tm::validate_tactical_map(&map).ok, "предупреждения не превращаются в отказ");
}

#[test]
fn fallback_ladder_always_gives_playable_map() {
    let normal = build(json!({ "seed": "ladder" }));
    assert_eq!(normal.fallback, "none");
    assert!(reachability_issues(&normal.map).is_empty());
    let tiny = build(json!({ "seed": "tiny", "width": 16, "height": 16 }));
    assert!(["none", "rect", "no_props", "safe_room"].contains(&tiny.fallback));
    assert!(tm::validate_tactical_map(&tiny.map).errors.is_empty());
    assert!(reachability_issues(&tiny.map).is_empty());
}

#[test]
fn design_changes_layout_size_and_furniture() {
    let dwelling = generate(json!({ "seed": "design-dwelling", "design": { "building_use": "dwelling", "climate": "cold", "architecture": "stone" } }));
    let tavern = generate(json!({ "seed": "design-tavern", "design": { "building_use": "tavern", "climate": "temperate", "architecture": "wood" } }));
    let shop = generate(json!({ "seed": "design-shop", "design": { "building_use": "shop", "climate": "arid", "architecture": "sand" } }));
    let manor = generate(json!({ "seed": "design-manor", "design": { "building_use": "manor", "climate": "wetland", "architecture": "marble" } }));
    let has_zone = |map: &TacticalMap, id: &str| map.zones.iter().any(|zone| zone.id == id);
    assert!(has_zone(&dwelling, "bedroom"));
    assert!(!assets_in(&dwelling, "hall").iter().any(|asset| asset == "bar_counter" || asset == "bar_shelf"));
    assert!(has_zone(&tavern, "hall") && has_zone(&tavern, "kitchen") && has_zone(&tavern, "store"));
    assert!(assets_in(&tavern, "hall").contains("bar_counter"));
    assert!(has_zone(&shop, "workshop"));
    assert!(assets_in(&shop, "workshop").contains("table_long"));
    assert!(has_zone(&manor, "salon"));
    assert_eq!(tm::cell_at(&dwelling, 0, 0).map(|cell| cell.material), Some("ice"));
    assert_eq!(tm::cell_at(&shop, 0, 0).map(|cell| cell.material), Some("sand"));
    let design = json!({ "building_use": "tavern", "climate": "temperate", "architecture": "wood" });
    assert_ne!(map_hash(&generate(json!({ "seed": "layout-a", "design": design }))), map_hash(&generate(json!({ "seed": "layout-b", "design": design }))));
}

#[test]
fn hundred_designed_seeds_are_valid_connected_and_varied() {
    let uses = ["dwelling", "tavern", "shop", "manor"];
    let climates = ["temperate", "arid", "cold", "wetland"];
    let architectures = ["wood", "stone", "sand", "metal", "marble", "ice"];
    let mut signatures = HashSet::new();
    let mut shaped = 0;
    for index in 0..100 {
        let built = build(json!({ "seed": format!("design-{index}"), "design": { "building_use": uses[index % 4], "climate": climates[index % 4], "architecture": architectures[index % 6] } }));
        assert!(["none", "rect"].contains(&built.fallback), "design-{index}: откат {}", built.fallback);
        if built.fallback == "none" {
            shaped += 1;
        }
        let filled: HashSet<&str> = tm::cells(&built.map).filter(|cell| cell.passable).map(|cell| cell.zone).collect();
        let empty: Vec<&str> = built.map.zones.iter().filter(|zone| zone.kind == "interior" && zone.id != "walls" && !filled.contains(zone.id.as_str())).map(|zone| zone.id.as_str()).collect();
        assert!(empty.is_empty(), "design-{index}: помещения без пола {empty:?}");
        assert!(tm::validate_tactical_map(&built.map).errors.is_empty(), "design-{index}");
        assert!(reachability_issues(&built.map).is_empty(), "design-{index}");
        let zones: Vec<&str> = built.map.zones.iter().map(|zone| zone.id.as_str()).collect();
        let doors: Vec<&str> = built.map.doors.iter().map(|door| door.id.as_str()).collect();
        signatures.insert(stringify(&json!({ "width": built.map.width, "height": built.map.height, "zones": zones, "doors": doors })));
    }
    assert!(signatures.len() >= 8, "разнообразие {}", signatures.len());
    assert!(shaped >= 80, "первая попытка удалась лишь {shaped} раз из 100");
}

#[test]
fn schemes_change_geometry_and_courtyard_is_reachable_exterior() {
    let mut samples: Vec<(&str, TacticalMap)> = Vec::new();
    for index in 0..200 {
        if samples.len() == 3 {
            break;
        }
        let map = generate(json!({ "seed": format!("geometry-{index}"), "design": { "building_use": "dwelling" } }));
        let class = if map.zones.iter().any(|zone| zone.id == "courtyard") {
            "courtyard"
        } else {
            let hall = zone_bounds(&map, "hall");
            if hall.2 - hall.0 > hall.3 - hall.1 {
                "long-hall"
            } else {
                "wing"
            }
        };
        match samples.iter_mut().find(|(name, _)| *name == class) {
            Some(entry) => entry.1 = map,
            None => samples.push((class, map)),
        }
    }
    let mut classes: Vec<&str> = samples.iter().map(|(name, _)| *name).collect();
    classes.sort_unstable();
    assert_eq!(classes, ["courtyard", "long-hall", "wing"]);
    let geometry: HashSet<(i64, i64, i64, i64)> = samples.iter().map(|(_, map)| zone_bounds(map, "hall")).collect();
    assert_eq!(geometry.len(), 3, "три схемы различаются геометрией зала");
    let courtyard = &samples.iter().find(|(name, _)| *name == "courtyard").expect("двор").1;
    assert_eq!(courtyard.zones.iter().find(|zone| zone.id == "courtyard").map(|zone| zone.kind.as_str()), Some("exterior"));
    let cells: Vec<(i64, i64)> = tm::cells(courtyard).filter(|cell| cell.zone == "courtyard").map(|cell| (cell.x, cell.y)).collect();
    assert!(cells.len() >= 9);
    let (x, y) = party(courtyard);
    let reached = tm::reachable_cells(courtyard, x, y, true, None);
    assert!(cells.iter().any(|cell| reached.contains(cell)), "во двор должен вести проход");
}

#[test]
fn designed_building_keeps_doors_and_declared_levels() {
    let map = generate(json!({
        "seed": "design-levels", "design": { "building_use": "tavern", "climate": "temperate", "architecture": "wood" },
        "levels": [{ "offset": 1, "label": "Спальни" }, { "offset": -1, "label": "Погреб" }],
    }));
    for id in ["front-door", "kitchen-door", "store-door"] {
        assert!(map.doors.iter().any(|door| door.id == id), "{id}");
    }
    for level in [1, -1] {
        assert!(map.props.iter().any(|prop| prop.transition.as_ref().is_some_and(|transition| transition.to_level == level)), "этаж {level}");
    }
    assert!(tm::validate_tactical_map(&map).errors.is_empty());
    assert!(reachability_issues(&map).is_empty());
}

#[test]
fn safe_room_is_valid_and_connected() {
    let map = safe_room(&json!({ "seed": "fallback" })).expect("комната");
    assert!(tm::validate_tactical_map(&map).errors.is_empty());
    assert!(reachability_issues(&map).is_empty());
    assert!(map.overlays.compass);
}

#[test]
fn ares_fortress_is_stable_and_large() {
    let first = generate_ares_fortress_scene(&json!({ "seed": "ares-stable", "width": 17, "height": 11 })).expect("крепость");
    let second = generate_ares_fortress_scene(&json!({ "seed": "ares-stable", "width": 17, "height": 11 })).expect("крепость");
    assert_eq!(serialized(&first), serialized(&second));
    assert_eq!((first.generator.id.as_str(), first.generator.version.as_str()), (ARES_FORTRESS_GENERATOR.id, ARES_FORTRESS_GENERATOR.version));
    assert!(first.width >= ARES_FORTRESS_SIZE.width - 4 && first.height >= ARES_FORTRESS_SIZE.height);
    assert!(tm::validate_tactical_map(&first).errors.is_empty());
    assert!(reachability_issues(&first).is_empty());
}

#[test]
fn ares_gallery_reaches_courtyard_and_every_wing_through_doors() {
    let map = generate_ares_fortress_scene(&json!({ "seed": "ares-connectivity" })).expect("крепость");
    let spawn = map.spawn_points.iter().find(|point| point.id == "party-war-gallery").expect("точка галереи");
    assert_eq!(spawn.role, "party");
    let reached = tm::reachable_cells(&map, spawn.x, spawn.y, true, None);
    for zone in ["courtyard", "gallery", "barracks", "stables", "storehouse", "workshop"] {
        assert!(reached.iter().any(|(x, y)| tm::cell_at(&map, *x, *y).is_some_and(|cell| cell.zone == zone)), "из галереи недостижима зона {zone}");
    }
    assert_eq!(map.doors.len(), 10);
    for door in &map.doors {
        assert_eq!(map.edge(door.x, door.y, door.dir).map(|edge| edge.kind), Some(EdgeKind::Door), "{}", door.id);
        let (nx, ny) = tm::edge_neighbor(door.x, door.y, door.dir);
        assert!(tm::cell_passable(&map, door.x, door.y) && tm::cell_passable(&map, nx, ny), "{}", door.id);
    }
}

#[test]
fn ares_zones_are_furnished_and_prologue_starts_at_table() {
    let map = build_ares_fortress_scene(&json!({ "seed": "ares-prologue" })).expect("крепость").map;
    let party = map.spawn_points.iter().find(|point| point.id == "party-war-gallery").expect("отряд");
    let king = map.spawn_points.iter().find(|point| point.id == "king-war-gallery").expect("король");
    assert_eq!(tm::cell_at(&map, party.x, party.y).map(|cell| cell.zone), Some("gallery"));
    assert_eq!(tm::cell_at(&map, king.x, king.y).map(|cell| cell.zone), Some("gallery"));
    assert_ne!((party.x, party.y), (king.x, king.y));
    for (zone, required) in [
        ("gallery", &["table_small", "candelabra", "banner", "chandelier"][..]),
        ("barracks", &["bunk_bed", "chest"]),
        ("stables", &["haystack", "water_trough", "hitching_post"]),
        ("storehouse", &["crate_stack", "barrel_stack", "chest"]),
        ("workshop", &["workbench", "crate", "barrel", "firewood_stack"]),
        ("courtyard", &["well", "water_trough", "woodpile"]),
    ] {
        let assets = assets_in(&map, zone);
        for asset in required {
            assert!(assets.contains(*asset), "{zone}: отсутствует {asset}");
        }
    }
}

#[test]
fn ares_courtyard_has_grass_earth_stone_and_exterior_belt() {
    let map = generate_ares_fortress_scene(&json!({ "seed": "ares-surface" })).expect("крепость");
    assert_eq!(map.zones.iter().find(|zone| zone.id == "exterior").map(|zone| zone.kind.as_str()), Some("exterior"));
    let materials: HashSet<&str> = tm::cells(&map).filter(|cell| cell.zone == "courtyard").map(|cell| cell.material).collect();
    for material in ["grass", "earth", "stone"] {
        assert!(materials.contains(material), "{material}");
    }
    assert!(tm::cells(&map).filter(|cell| cell.zone == "exterior").count() > 3);
    assert!(asset_list_in(&map, "exterior").iter().any(|asset| asset.starts_with("tree_") || ["bush", "shrub", "boulder", "rock_small"].contains(&asset.as_str())));
    let center_x = (2 + map.width - 3).div_euclid(2);
    for y in 14..=25 {
        assert_eq!(tm::cell_at(&map, center_x, y).map(|cell| cell.material), Some("stone"), "главная дорожка прервана в {center_x},{y}");
    }
}

#[test]
fn corridor_layout_rooms_open_into_corridor() {
    for (use_, expected) in [("dwelling", "bedroom"), ("tavern", "guest-"), ("manor", "")] {
        let built = build(json!({ "seed": format!("corridor-{use_}"), "width": 44, "height": 40, "design": { "building_use": use_, "scheme": "corridor", "shape": "rect" } }));
        let map = &built.map;
        assert_eq!(built.fallback, "none", "{use_}");
        assert!(map.zones.iter().any(|zone| zone.id == "corridor" && zone.label == "Коридор"), "{use_}: нет коридора");
        let rooms: Vec<&str> = map.zones.iter().filter(|zone| zone.kind == "interior" && !["hall", "corridor", "walls"].contains(&zone.id.as_str())).map(|zone| zone.id.as_str()).collect();
        assert!(rooms.len() >= 3, "{use_}: за коридором {} комнат", rooms.len());
        let matches = |id: &str| if use_ == "manor" { id == "salon" || id == "study" } else { id.starts_with(expected) };
        assert!(rooms.iter().any(|id| matches(id)), "{use_}: нет {expected}");
        for room in &rooms {
            let door = map.doors.iter().find(|door| door.id == format!("{room}-door")).unwrap_or_else(|| panic!("{use_}/{room}: нет двери"));
            let (nx, ny) = tm::edge_neighbor(door.x, door.y, door.dir);
            let sides = [tm::cell_at(map, door.x, door.y).map(|cell| cell.zone), tm::cell_at(map, nx, ny).map(|cell| cell.zone)];
            assert!(sides.contains(&Some("corridor")) && sides.contains(&Some(room)), "{use_}/{room}: дверь ведёт в {sides:?}");
        }
        assert!(reachability_issues(map).is_empty(), "{use_}");
    }
}

// --- пропорции по назначению здания ---------------------------------------------------

/// Целевые площади комнат по назначению, фт² (`ROOM_AREA_FT2`).
fn room_area_range(use_: &str, zone: &str) -> Option<(usize, usize)> {
    Some(match (use_, zone) {
        ("tavern", "hall") => (800, 1600),
        ("tavern", "kitchen") => (400, 1000),
        ("tavern", "store") => (300, 1000),
        ("tavern", "guest") => (300, 900),
        ("shop", "hall") => (500, 1300),
        ("shop", "store") => (300, 700),
        ("shop", "workshop") => (300, 700),
        ("dwelling", "hall") => (600, 1600),
        ("dwelling", "kitchen" | "bedroom") => (300, 1250),
        ("dwelling", "store") => (200, 700),
        ("manor", "hall") => (900, 1800),
        ("manor", "salon") => (400, 1100),
        ("manor", "kitchen") => (400, 1250),
        ("manor", "store") => (300, 1000),
        ("manor", "study" | "bedroom") => (300, 900),
        _ => return None,
    })
}

/// Площадь помещений карты, фт²: пол интерьерных зон, кроме кладки и коридора.
fn room_areas(map: &TacticalMap) -> Vec<(String, usize)> {
    let interior: HashSet<&str> = map.zones.iter().filter(|zone| zone.kind == "interior" && zone.id != "walls" && zone.id != "corridor").map(|zone| zone.id.as_str()).collect();
    let mut areas: Vec<(String, usize)> = Vec::new();
    for cell in tm::cells(map).filter(|cell| cell.passable && interior.contains(cell.zone)) {
        match areas.iter_mut().find(|(zone, _)| zone == cell.zone) {
            Some(entry) => entry.1 += 25,
            None => areas.push((cell.zone.to_string(), 25)),
        }
    }
    areas
}

fn assert_proportions(map: &TacticalMap, use_: &str, label: &str) {
    assert!(map.width >= 16 && map.height >= 16, "{label}: карта меньше 16×16");
    let areas = room_areas(map);
    let area = |zone: &str| areas.iter().find(|(id, _)| id == zone).map(|entry| entry.1);
    let hall = area("hall").unwrap_or_else(|| panic!("{label}: нет главного помещения"));
    for (zone, size) in &areas {
        let base = sk_core::text::replace_first(sk_core::re!(r"-\d+$", "u"), zone, "");
        let (low, high) = room_area_range(use_, &base).unwrap_or_else(|| panic!("{label}: у комнаты {zone} нет целевой площади"));
        assert!(*size >= low && *size <= high, "{label}: {zone} {size} фт² вне {low}–{high} {areas:?}");
        if zone != "hall" {
            assert!(*size <= hall, "{label}: {zone} больше зала {areas:?}");
        }
    }
    if let (Some(kitchen), Some(store)) = (area("kitchen"), area("store")) {
        assert!(store <= kitchen, "{label}: кладовая больше кухни {areas:?}");
    }
}

const PRESET_USE: [(&str, &str); 4] = [("tavern", "tavern"), ("shop", "shop"), ("house", "dwelling"), ("manor", "manor")];

#[test]
fn preset_buildings_keep_room_areas_of_their_use() {
    assert_eq!(BUILDING_GENERATOR.version, "8");
    for (preset, use_) in PRESET_USE {
        for size in ["16x14", "26x26", "36x30", "40x32"] {
            for (label, map) in pipeline_maps(&format!("preset/{preset}/{size}/")) {
                assert_proportions(&map, use_, &label);
            }
        }
    }
}

#[test]
fn proportions_hold_on_any_seed_and_plot() {
    for use_ in ["tavern", "shop", "dwelling", "manor"] {
        for (width, height) in [(22, 20), (44, 40)] {
            for index in 0..12 {
                let built = build(json!({ "seed": format!("proportions-{use_}-{index}"), "width": width, "height": height, "design": { "building_use": use_ } }));
                assert_eq!(built.fallback, "none", "{use_}/{index}");
                assert_proportions(&built.map, use_, &format!("{use_}/{width}×{height}/{index}"));
            }
        }
        let corridor = build(json!({ "seed": format!("proportions-{use_}-corridor"), "width": 44, "height": 40, "design": { "building_use": use_, "scheme": "corridor", "shape": "rect" } }));
        assert_proportions(&corridor.map, use_, &format!("{use_}/коридор"));
    }
}

#[test]
fn large_plot_grows_yard_not_rooms() {
    for seed in ["plot-a", "plot-b", "plot-c"] {
        let small = build(json!({ "seed": seed, "width": 26, "height": 26, "design": { "building_use": "tavern" } })).map;
        let large = build(json!({ "seed": seed, "width": 44, "height": 40, "design": { "building_use": "tavern" } })).map;
        let mut small_areas = room_areas(&small);
        let mut large_areas = room_areas(&large);
        small_areas.sort();
        large_areas.sort();
        assert_eq!(large_areas, small_areas, "{seed}: комнаты зависят от размера участка");
        let yard = |map: &TacticalMap| tm::cells(map).filter(|cell| cell.zone == "yard").count();
        assert!(yard(&large) > yard(&small) * 2, "{seed}: двор не вырос с участком");
    }
}

#[test]
fn yard_is_farmstead_of_its_use() {
    for seed in ["yard-a", "yard-b", "yard-c"] {
        let tavern = build(json!({ "seed": seed, "width": 36, "height": 30, "design": { "building_use": "tavern", "climate": "temperate" } })).map;
        assert!(assets_in(&tavern, "yard").contains("hitching_post"), "{seed}: у трактира нет коновязи");
        let house = build(json!({ "seed": seed, "width": 36, "height": 30, "design": { "building_use": "dwelling", "climate": "temperate" } })).map;
        assert!(assets_in(&house, "yard").contains("garden_bed"), "{seed}: у дома нет огорода");
    }
}

fn assert_furnished(map: &TacticalMap, label: &str) {
    let furnished = furnished_cells(map);
    for (index, quarter) in room_quarters(map, "hall").iter().enumerate() {
        if quarter.len() < FURNISHED_QUARTER_CELLS {
            continue;
        }
        assert!(quarter.iter().any(|cell| furnished.contains(&(cell.x, cell.y))), "{label}: четверть зала №{index} ({} клеток) пустая", quarter.len());
    }
}

#[test]
fn hall_is_furnished_in_every_quarter() {
    for (preset, _) in PRESET_USE {
        for size in ["16x14", "26x26", "40x32"] {
            for (label, map) in pipeline_maps(&format!("preset/{preset}/{size}/")) {
                assert_furnished(&map, &label);
            }
        }
    }
    for index in 0..20 {
        assert_furnished(&build(json!({ "seed": format!("furnished-{index}"), "width": 36, "height": 30, "design": { "building_use": "tavern" } })).map, &format!("таверна/{index}"));
    }
}

// --- test/map-quality.test.mjs: здания -------------------------------------------------

fn windows_of(map: &TacticalMap, zone: &str) -> usize {
    tm::edge_list(map)
        .into_iter()
        .filter(|edge| {
            if edge.kind != EdgeKind::Window {
                return false;
            }
            let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
            [tm::cell_at(map, edge.x, edge.y), tm::cell_at(map, nx, ny)].iter().any(|cell| cell.is_some_and(|cell| cell.zone == zone))
        })
        .count()
}

#[test]
fn dwelling_has_living_room_bedroom_and_windows_everywhere() {
    for (label, map) in pipeline_maps("quality/Дом мельника/") {
        assert_eq!(map.zones.iter().find(|zone| zone.id == "hall").map(|zone| zone.label.as_str()), Some("Горница"), "{label}");
        for zone in ["hall", "bedroom", "kitchen"] {
            if map.zones.iter().any(|entry| entry.id == zone) {
                assert!(windows_of(&map, zone) > 0, "{label}: в комнате {zone} нет окна");
            }
        }
        let bedroom = asset_list_in(&map, "bedroom");
        assert!(bedroom.iter().any(|asset| asset == "bed"), "{label}: в спальне нет кровати");
        assert!(!bedroom.iter().any(|asset| asset == "bunk_bed"), "{label}: спальня дома — не казарма");
        assert!(!asset_list_in(&map, "hall").iter().any(|asset| asset == "table_long"), "{label}: в горнице трактирные столы");
        assert!(!asset_list_in(&map, "yard").is_empty(), "{label}: двор пустой");
    }
}

#[test]
fn tavern_front_door_faces_spawn_and_kitchen_has_back_door() {
    for (label, map) in pipeline_maps("quality/Таверна «Рыжий рог»/") {
        let front = map.doors.iter().find(|door| door.id == "front-door").unwrap_or_else(|| panic!("{label}: нет парадной двери"));
        let hall_max_y = tm::cells(&map).filter(|cell| cell.zone == "hall").map(|cell| cell.y).max().unwrap_or(0);
        assert!(front.y >= hall_max_y - 1, "{label}: дверь на y={} не на южной стене зала", front.y);
        assert!(map.height - 2 > front.y);
        assert!(map.doors.iter().any(|door| door.id == "back-door"), "{label}: нет задней двери");
    }
}

/// Сколько клеток двора внутри рамки корпуса: форма — не прямоугольник.
fn shaped_outline(map: &TacticalMap) -> usize {
    let interior: HashSet<&str> = map.zones.iter().filter(|zone| zone.kind == "interior").map(|zone| zone.id.as_str()).collect();
    let walls: Vec<(i64, i64)> = tm::cells(map).filter(|cell| cell.zone == "walls" || interior.contains(cell.zone)).map(|cell| (cell.x, cell.y)).collect();
    let (min_x, max_x) = (walls.iter().map(|cell| cell.0).min().unwrap_or(0), walls.iter().map(|cell| cell.0).max().unwrap_or(0));
    let (min_y, max_y) = (walls.iter().map(|cell| cell.1).min().unwrap_or(0), walls.iter().map(|cell| cell.1).max().unwrap_or(0));
    tm::cells(map).filter(|cell| cell.x >= min_x && cell.x <= max_x && cell.y >= min_y && cell.y <= max_y && cell.zone == "yard").count()
}

#[test]
fn shaped_corpus_l_cross_round_keeps_doors_windows_and_largest_hall() {
    for shape in ["L", "cross", "round"] {
        for (label, map) in pipeline_maps(&format!("quality/shape/{shape}/")) {
            assert!(shaped_outline(&map) > 0, "{label}: форма не применилась");
            assert!(audit_tactical_map(&map).problems.is_empty(), "{label}");
            assert!(map.doors.iter().any(|door| door.id == "front-door"), "{label}");
            assert!(tm::edge_list(&map).iter().any(|edge| edge.kind == EdgeKind::Window), "{label}");
            let mut sizes: HashMap<&str, usize> = HashMap::new();
            for cell in tm::cells(&map).filter(|cell| cell.passable && !["yard", "courtyard"].contains(&cell.zone)) {
                *sizes.entry(cell.zone).or_insert(0) += 1;
            }
            let hall = sizes.get("hall").copied().unwrap_or(0);
            assert!(sizes.iter().all(|(zone, size)| *zone == "hall" || *size <= hall), "{label}: зал не самое большое помещение {sizes:?}");
        }
    }
    let (_, tower) = pipeline_maps("quality/tower").remove(0);
    assert!(shaped_outline(&tower) > 0, "круглая башня осталась прямоугольной");
}

#[test]
fn smithy_and_barracks_are_buildings_of_their_use() {
    let (_, smithy) = pipeline_maps("quality/place/Кузница Борга").remove(0);
    assert_eq!(smithy.generator.id, "building-with-yard");
    let assets: HashSet<&str> = smithy.props.iter().map(|prop| prop.asset_id.as_str()).collect();
    assert!(smithy.zones.iter().any(|zone| zone.label == "Кузня") && assets.contains("forge") && assets.contains("anvil"), "в кузне нет горна и наковальни");
    let (_, barracks) = pipeline_maps("quality/place/Казарма городской стражи").remove(0);
    assert_eq!(barracks.generator.id, "building-with-yard");
    assert!(barracks.zones.iter().any(|zone| zone.label == "Спальня стражи") && barracks.props.iter().any(|prop| prop.asset_id == "bunk_bed"));
}

#[test]
fn building_windows_are_not_blocked_by_furniture() {
    for (label, map) in pipeline_maps("quality/window/") {
        assert!(!audit_tactical_map(&map).problems.iter().any(|problem| problem.code == "PROP_BLOCKS_WINDOW"), "{label}");
    }
}

// --- test/scene-themes.test.mjs: здания --------------------------------------------------

#[test]
fn interior_maps_get_hanging_chandelier() {
    let (_, tavern) = pipeline_maps("themes/swing-tavern").remove(0);
    assert!(tavern.props.iter().any(|prop| prop.asset_id == "chandelier"));
    let (_, palace) = pipeline_maps("themes/swing-palace").remove(0);
    assert!(palace.props.iter().any(|prop| prop.asset_id == "chandelier"));
}

#[test]
fn building_and_fortress_themes_build_valid_connected_maps() {
    for (label, map) in pipeline_maps("themes/building").into_iter().chain(pipeline_maps("themes/same/building")) {
        assert!(tm::validate_tactical_map(&map).errors.is_empty(), "{label}");
        let (x, y) = party(&map);
        assert!(tm::reachable_cells(&map, x, y, true, None).len() > 20, "{label}");
        assert!(map.props.len() > 5, "{label}");
    }
}

/// Клетка, на которую смотрит предмет с поворотом `rotation` (0° — юг, 90° —
/// запад, 180° — север, 270° — восток), и шаг взгляда.
fn facing_from(rotation: f64, x: i64, y: i64) -> (i64, i64, i64, i64) {
    let quarter = ((((rotation % 360.0) + 360.0) % 360.0 / 90.0).round() as usize) % 4;
    let (dx, dy) = [(0, 1), (-1, 0), (0, -1), (1, 0)][quarter];
    (x + dx, y + dy, dx, dy)
}

/// Перенос `test/prop-placement.test.mjs` (#184): поворот карты под сторону
/// входа сохраняет стул лицом к столу и настенную вещь спиной к стене.
#[test]
fn orientation_keeps_seats_facing_tables_and_wall_props_facing_away() {
    let map = generate(json!({ "seed": "orient-seats", "width": 30, "height": 26, "design": { "building_use": "tavern" } }));
    for side in ["west", "east", "north", "south"] {
        let oriented = tm::orient_tactical_map(map.clone(), side).expect("поворот");
        let surface_cells: HashSet<(i64, i64)> = oriented
            .props
            .iter()
            .filter(|prop| prop.asset_id.starts_with("table_") || prop.asset_id == "bar_counter")
            .flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y)))
            .collect();
        let seats: Vec<_> = oriented.props.iter().filter(|prop| ["chair", "stool", "bench"].contains(&prop.asset_id.as_str())).collect();
        assert!(!seats.is_empty(), "{side}: в трактире нет сидений");
        for seat in seats {
            let (x, y, _, _) = facing_from(seat.rotation, seat.footprint[0].x, seat.footprint[0].y);
            assert!(surface_cells.contains(&(x, y)), "{side}: {} смотрит не на стол", seat.id);
        }
        let mounted: Vec<_> = oriented.props.iter().filter_map(|prop| match &prop.mount {
            Some(tm::PropMount::Wall { side: wall }) => Some((prop, *wall)),
            _ => None,
        }).collect();
        assert!(!mounted.is_empty(), "{side}: нет настенных вещей");
        for (prop, wall) in mounted {
            let (_, _, dx, dy) = facing_from(prop.rotation, prop.x.floor() as i64, prop.y.floor() as i64);
            let away = match wall {
                "n" => (0, 1),
                "e" => (-1, 0),
                "s" => (0, -1),
                _ => (1, 0),
            };
            assert_eq!((dx, dy), away, "{side}: {} смотрит не от стены {wall}", prop.id);
        }
    }
}

/// Перенос `test/prop-placement.test.mjs` (#184): мебель со спинкой стоит у
/// стены, а не у закрытой на время расстановки точки появления.
#[test]
fn backed_furniture_stands_against_walls_not_the_reserved_spawn() {
    let backed = ["bar_shelf", "bookshelf", "wardrobe", "cupboard", "pantry_shelf", "shelf_wall", "fireplace", "lantern_wall", "torch_wall"];
    for seed in ["spawn-a", "spawn-b", "spawn-c", "spawn-d", "spawn-e", "spawn-f"] {
        let map = generate(json!({ "seed": seed, "width": 30, "height": 26, "design": { "building_use": "tavern" }, "entry": "interior" }));
        for prop in map.props.iter().filter(|prop| backed.contains(&prop.asset_id.as_str())) {
            let cells: Vec<(i64, i64)> =
                if prop.footprint.is_empty() { vec![(prop.x.floor() as i64, prop.y.floor() as i64)] } else { prop.footprint.iter().map(|cell| (cell.x, cell.y)).collect() };
            let against_wall = cells.iter().any(|(x, y)| {
                [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| {
                    if tm::edge_between(&map, *x, *y, x + dx, y + dy)
                        .ok()
                        .flatten()
                        .is_some_and(|edge| matches!(edge.kind, EdgeKind::Wall | EdgeKind::Rail | EdgeKind::Window | EdgeKind::Door))
                    {
                        return true;
                    }
                    tm::cell_at(&map, x + dx, y + dy).is_none_or(|cell| !cell.passable)
                })
            });
            assert!(against_wall, "{seed}: {} на {},{} стоит не у стены", prop.asset_id, cells[0].0, cells[0].1);
        }
    }
}
