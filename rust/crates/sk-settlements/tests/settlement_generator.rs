//! Сверка `settlement_generator` с эталоном JS
//! (`fixtures/settlement-generator.json`, генератор
//! `fixtures/gen-settlement-generator.mjs`) и перенос
//! `test/settlement-generator.test.mjs` и генераторной части
//! `test/scene-entry-road.test.mjs`.

mod common;

use std::collections::HashSet;
use std::sync::LazyLock;

use common::{array, dump, map_hash, parse, serialized, stringify};
use serde_json::{json, Value};
use sk_settlements::settlement_generator::{build_settlement_scene, SettlementScene, MARKET_STALLS_MAX, SETTLEMENT_GENERATOR};
use sk_tactical::tactical_map::{self as tm, EdgeKind, TacticalMap};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/settlement-generator.json")));

fn case(label: &str) -> &'static Value {
    array(&FIXTURE["cases"]).iter().find(|case| case["label"] == label).unwrap_or_else(|| panic!("нет случая {label}"))
}

fn build(options: &Value) -> SettlementScene {
    build_settlement_scene(options).unwrap_or_else(|error| panic!("поселение не собралось: {error}"))
}

#[test]
fn settlement_cases_match_js() {
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 800, "случаев {}", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let label = case["label"].as_str().expect("метка");
        match build_settlement_scene(&case["options"]) {
            Err(error) => {
                if case.get("error") != Some(&error.to_json()) {
                    failures.push(format!("{label}: отказ Rust {}, JS {}", stringify(&error.to_json()), stringify(&case["error"])));
                }
            }
            Ok(scene) => {
                let hash = map_hash(&scene.map);
                if case["mapHash"].as_str() != Some(hash.as_str()) {
                    let path = dump(label, &serialized(&scene.map));
                    failures.push(format!("{label}: карта Rust {path}, JS {}", stringify(case.get("error").unwrap_or(&Value::Null))));
                    continue;
                }
                assert_eq!(stringify(&scene.uses_json()), stringify(&case["uses"]), "{label}: назначения построек");
                assert!(scene.warnings.is_empty() && case["warnings"] == json!([]), "{label}: предупреждения");
                if let Some(pipeline) = case.get("pipelineHash") {
                    assert_eq!(pipeline, &case["mapHash"], "{label}: карта конвейера");
                    assert_eq!(case["pipelineUses"], case["uses"], "{label}: назначения конвейера");
                }
            }
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

// --- перенос test/settlement-generator.test.mjs -------------------------------------

fn theme() -> Value {
    json!({ "id": "settlement", "label": "Поселение", "surfaceMaterial": "grass", "streetMaterial": "earth", "houseMaterial": "wood" })
}

const TOPOLOGIES: [&str; 9] = ["organic", "linear", "crossroads", "market", "courtyard", "harbor", "river", "terraced", "gate"];

fn building_zone_ids(map: &TacticalMap) -> Vec<String> {
    map.zones.iter().filter(|zone| zone.id.starts_with("building-")).map(|zone| zone.id.clone()).collect()
}

fn interior(map: &TacticalMap, zone: &str) -> Vec<(i64, i64)> {
    tm::cells(map).filter(|cell| cell.passable && cell.zone == zone).map(|cell| (cell.x, cell.y)).collect()
}

fn party(map: &TacticalMap) -> (i64, i64) {
    let spawn = map.spawn_points.iter().find(|point| point.role == "party").expect("точка отряда");
    (spawn.x, spawn.y)
}

fn reachable_building_zones(map: &TacticalMap) -> usize {
    let (x, y) = party(map);
    let reached = tm::reachable_cells(map, x, y, true, None);
    building_zone_ids(map)
        .iter()
        .filter(|zone| {
            let cells = interior(map, zone);
            !cells.is_empty() && cells.iter().all(|cell| reached.contains(cell))
        })
        .count()
}

#[test]
fn settlement_topologies_produce_valid_reachable_maps() {
    for topology in TOPOLOGIES {
        let built = build(&json!({ "seed": format!("topology-{topology}"), "width": 28, "height": 28, "locationId": topology, "theme": theme(), "design": { "topology": topology } }));
        assert!(tm::validate_tactical_map(&built.map).errors.is_empty(), "{topology}");
        assert_eq!(built.map.generator.id, SETTLEMENT_GENERATOR.id);
        assert_eq!(built.map.generator.version, SETTLEMENT_GENERATOR.version);
        assert!(built.map.spawn_points.iter().any(|point| point.role == "party"), "{topology}");
        assert!(built.warnings.is_empty(), "{topology}");
        assert_eq!(reachable_building_zones(&built.map), building_zone_ids(&built.map).len(), "{topology}");
        let (x, y) = (built.map.spawn_points[0].x, built.map.spawn_points[0].y);
        let reached = tm::reachable_cells(&built.map, x, y, true, None);
        for door in &built.map.doors {
            let endpoints = [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)];
            assert!(endpoints.iter().any(|cell| reached.contains(cell)), "{topology}: дверь {} отрезана", door.id);
        }
    }
}

#[test]
fn settlement_generation_is_deterministic_and_default_seeds_vary_composition() {
    let options = json!({ "seed": "same-settlement", "width": 30, "height": 30, "locationId": "same", "theme": theme(), "design": {} });
    assert_eq!(stringify(&serialized(&build(&options).map)), stringify(&serialized(&build(&options).map)));
    let mut signatures = HashSet::new();
    for index in 0..12 {
        let map = build(&json!({ "seed": format!("varied-{index}"), "width": 28, "height": 28, "locationId": format!("varied-{index}"), "theme": theme(), "design": {} })).map;
        let bounds: Vec<Value> = building_zone_ids(&map)
            .iter()
            .map(|zone| {
                let cells: Vec<(i64, i64)> = tm::cells(&map).filter(|cell| cell.zone == zone).map(|cell| (cell.x, cell.y)).collect();
                let xs = cells.iter().map(|cell| cell.0);
                let ys = cells.iter().map(|cell| cell.1);
                json!([xs.clone().min(), ys.clone().min(), xs.max(), ys.max()])
            })
            .collect();
        let doors: Vec<Value> = map.doors.iter().map(|door| json!([door.x, door.y])).collect();
        signatures.insert(stringify(&json!({ "bounds": bounds, "doors": doors })));
    }
    assert!(signatures.len() >= 8, "unique compositions: {}", signatures.len());
}

#[test]
fn river_and_harbor_keep_water_crossing_reachable() {
    for topology in ["river", "harbor"] {
        let map = build(&json!({ "seed": format!("water-{topology}"), "width": 30, "height": 30, "locationId": topology, "theme": theme(), "design": { "topology": topology } })).map;
        let water: Vec<(i64, i64)> = tm::cells(&map).filter(|cell| cell.surface == "water").map(|cell| (cell.x, cell.y)).collect();
        assert!(!water.is_empty(), "{topology}");
        assert!(
            water.iter().any(|(x, y)| [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| tm::cell_passable(&map, x + dx, y + dy))),
            "{topology}: нет моста или причала"
        );
    }
}

#[test]
fn market_courtyard_and_gate_carry_their_own_topology() {
    let square = |map: &TacticalMap| tm::cells(map).filter(|cell| cell.zone == "square").count();
    let market = build(&json!({ "seed": "market-topology", "width": 30, "height": 30, "locationId": "market", "theme": theme(), "design": { "topology": "market" } })).map;
    let courtyard = build(&json!({ "seed": "courtyard-topology", "width": 30, "height": 30, "locationId": "courtyard", "theme": theme(), "design": { "topology": "courtyard" } })).map;
    assert!(square(&market) >= 40, "у рынка нет площади");
    assert!(square(&courtyard) >= 30, "у двора нет внутреннего двора");
    assert_ne!(square(&market), square(&courtyard), "рынок и двор получили одну композицию");
    let gate = build(&json!({ "seed": "gate-topology", "width": 30, "height": 30, "locationId": "gate", "theme": theme(), "design": { "topology": "gate" } })).map;
    assert_eq!(gate.doors.iter().filter(|door| door.id == "city-gate").count(), 1, "у крепостного входа нет ворот");
    assert!(gate.edges().filter(|edge| edge.kind == EdgeKind::Wall).count() as i64 >= gate.height - 6, "у ворот нет стены города");
}

#[test]
fn crossroads_has_two_streets_and_organic_bend_is_connected() {
    for index in 0..12 {
        let cross = build(&json!({ "seed": format!("streets-{index}"), "width": 32, "height": 30, "theme": theme(), "design": { "topology": "crossroads" } })).map;
        let center_x = cross.width / 2;
        assert!((0..cross.height).all(|y| tm::cell_at(&cross, center_x, y).is_some_and(|cell| cell.zone == "street" && cell.passable)));
        let organic = build(&json!({ "seed": format!("streets-{index}"), "width": 32, "height": 30, "theme": theme(), "design": { "topology": "organic" } })).map;
        let full_row = (0..organic.height).any(|y| (0..organic.width).all(|x| tm::cell_at(&organic, x, y).is_some_and(|cell| cell.zone == "street")));
        assert!(!full_row, "лишняя прямая дорога осталась в органической деревне");
        let (x, y) = party(&organic);
        let reached = tm::reachable_cells(&organic, x, y, true, None);
        for cell in tm::cells(&organic).filter(|cell| cell.zone == "street") {
            assert!(reached.contains(&(cell.x, cell.y)), "изгиб улицы отрезан");
        }
    }
}

#[test]
fn organic_buildings_use_real_wings_and_dense_gates_vary() {
    let mut non_rectangular = 0;
    for index in 0..24 {
        let map = build(&json!({ "seed": format!("organic-wing-{index}"), "width": 30, "height": 30, "locationId": "organic", "theme": theme(), "design": { "topology": "organic", "density": "mixed" } })).map;
        for zone in building_zone_ids(&map) {
            let cells = interior(&map, &zone);
            let (min_x, max_x) = (cells.iter().map(|c| c.0).min().unwrap_or(0), cells.iter().map(|c| c.0).max().unwrap_or(0));
            let (min_y, max_y) = (cells.iter().map(|c| c.1).min().unwrap_or(0), cells.iter().map(|c| c.1).max().unwrap_or(0));
            if (cells.len() as i64) < (max_x - min_x + 1) * (max_y - min_y + 1) {
                non_rectangular += 1;
            }
        }
    }
    assert!(non_rectangular > 0, "органический генератор не создал ни одного выступающего крыла");
    let mut shapes = HashSet::new();
    for index in 0..24 {
        let map = build(&json!({ "seed": format!("dense-gate-{index}"), "width": 30, "height": 30, "locationId": "gate", "theme": theme(), "design": { "topology": "gate", "density": "dense" } })).map;
        let shape: Vec<Value> = building_zone_ids(&map)
            .iter()
            .map(|zone| {
                let cells = interior(&map, zone);
                json!([cells.len(), cells.iter().map(|c| c.0).min(), cells.iter().map(|c| c.0).max(), cells.iter().map(|c| c.1).min(), cells.iter().map(|c| c.1).max()])
            })
            .collect();
        shapes.insert(stringify(&Value::Array(shape)));
    }
    assert!(shapes.len() >= 4, "dense gate compositions: {}", shapes.len());
}

#[test]
fn village_river_bends_to_sandy_bank_and_town_canal_has_quay() {
    for seed in ["bend-a", "bend-b"] {
        let map = build(&json!({ "seed": seed, "width": 44, "height": 38, "theme": "деревня у реки", "design": { "topology": "river", "scale": "village" } })).map;
        let water = map.zones.iter().find(|zone| zone.id == "water").expect("река");
        assert_eq!(water.floor(), Some("river"), "{seed}: у реки нет фактуры струй");
        let mut tops = HashSet::new();
        let mut sand = 0;
        for x in 0..map.width {
            if let Some(y) = (0..map.height).find(|&y| tm::cell_at(&map, x, y).is_some_and(|cell| cell.surface == "water" && cell.zone == "water")) {
                tops.insert(y);
            }
            sand += (0..map.height).filter(|&y| tm::cell_at(&map, x, y).is_some_and(|cell| cell.passable && cell.material == "sand")).count();
        }
        assert!(tops.len() >= 3, "{seed}: река прямая, верх русла на {tops:?}");
        assert!(sand as i64 >= map.width, "{seed}: песчаного берега {sand} клеток");
    }
    let town = build(&json!({ "seed": "canal", "width": 48, "height": 44, "theme": "город у реки", "design": { "topology": "river", "scale": "town" } })).map;
    let quay = tm::cells(&town).filter(|cell| tm::edge_between(&town, cell.x, cell.y, cell.x, cell.y + 1).ok().flatten().is_some_and(|edge| edge.kind == EdgeKind::Ledge)).count();
    assert!(quay as i64 >= town.width, "набережной {quay} рёбер");
}

/// `DOOR_OFF_ROAD` и `PATH_BLOCKED` (инвариант AGENTS.md §5): аудит снят в JS
/// с той же карты, что строит Rust (сверка байт в байт — `settlement_cases_match_js`).
#[test]
fn every_settlement_door_has_a_road() {
    let mut paths = 0;
    for topology in TOPOLOGIES {
        for scale in ["village", "town"] {
            for seed in ["a", "b", "c"] {
                let label = format!("test/road/{topology}/{scale}/{seed}");
                let fixture = case(&label);
                let built = build(&json!({ "seed": format!("road-{topology}-{scale}-{seed}"), "width": 48, "height": 44, "locationId": topology, "theme": theme(), "design": { "topology": topology, "scale": scale, "density": "dense" } }));
                assert_eq!(fixture["mapHash"].as_str(), Some(map_hash(&built.map).as_str()), "{label}: карта не как в JS");
                let audit: Vec<&str> = array(&fixture["audit"]).iter().filter_map(Value::as_str).filter(|code| ["DOOR_OFF_ROAD", "PATH_BLOCKED"].contains(code)).collect();
                assert!(audit.is_empty(), "{label}: {audit:?}");
                if built.map.zones.iter().any(|zone| zone.id == "path") {
                    paths += 1;
                }
            }
        }
    }
    assert!(paths > 0, "хоть у одного поселения есть дома в глубине с тропой");
}

#[test]
fn market_has_stall_rows_with_aisles_carts_and_doors_on_roads() {
    assert_eq!(SETTLEMENT_GENERATOR.version, "7", "мебель не сквозь стену и гарнитуры — новая версия генератора");
    for scale in ["village", "town", "city"] {
        for seed in ["a", "b", "c", "d"] {
            let label = format!("{scale}/{seed}");
            let map = build(&json!({ "seed": format!("market-{scale}-{seed}"), "width": 48, "height": 44, "theme": theme(), "design": { "topology": "market", "scale": scale } })).map;
            let stalls: Vec<_> = map.props.iter().filter(|prop| prop.asset_id == "market_stall").collect();
            assert!(stalls.len() >= 6 && stalls.len() <= MARKET_STALLS_MAX, "{label}: лотков {}", stalls.len());
            assert!(stalls.iter().all(|prop| prop.footprint.iter().all(|cell| tm::cell_at(&map, cell.x, cell.y).is_some_and(|c| c.zone == "square"))), "{label}: лоток не на площади");
            let rows: HashSet<i64> = stalls.iter().map(|prop| prop.footprint.iter().map(|cell| cell.y).min().unwrap_or(0)).collect();
            assert!(rows.len() >= 2, "{label}: лотки в один ряд");
            for (index, left) in stalls.iter().enumerate() {
                for right in &stalls[index + 1..] {
                    let touching = left.footprint.iter().any(|a| right.footprint.iter().any(|b| (a.x - b.x).abs().max((a.y - b.y).abs()) <= 1));
                    assert!(!touching, "{label}: лотки {} и {} вплотную", left.id, right.id);
                }
            }
            assert!(map.props.iter().any(|prop| prop.id.starts_with("market-cart-") || prop.id.starts_with("market-goods-")), "{label}: на рынке ни телеги, ни ящика");
            let blocked: HashSet<(i64, i64)> = map.props.iter().filter(|prop| prop.blocks_move && prop.mount.is_none()).flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
            for cell in tm::cells(&map).filter(|cell| cell.zone == "path") {
                assert!(!blocked.contains(&(cell.x, cell.y)), "{label}: проход занят в {},{}", cell.x, cell.y);
            }
            // Аудит карты целиком — снят в JS с той же карты.
            let fixture = case(&format!("test/market/{label}"));
            assert_eq!(fixture["mapHash"].as_str(), Some(map_hash(&map).as_str()), "{label}: карта не как в JS");
            assert_eq!(fixture["audit"], json!([]), "{label}");
        }
    }
}

#[test]
fn market_scene_pipeline_maps_match_js() {
    // `generateSceneGeometry` рыночной сцены: вход генератора поселения пойман
    // в конвейере; дальнейшая обстановка — других модулей.
    let mut checked = 0;
    for case in array(&FIXTURE["cases"]) {
        let Some(label) = case["label"].as_str().filter(|label| label.starts_with("pipeline:market-scene/")) else { continue };
        let built = build(&case["options"]);
        assert_eq!(case["pipelineHash"].as_str(), Some(map_hash(&built.map).as_str()), "{label}");
        checked += 1;
    }
    assert_eq!(checked, 6);
}

// --- перенос test/scene-entry-road.test.mjs (генератор) ---------------------------------

#[test]
fn entry_road_village_spawns_on_street_and_square_faces_doors() {
    for label in ["pipeline:entry-road/brod", "pipeline:entry-road/east"] {
        let built = build(&case(label)["options"]);
        let (x, y) = party(&built.map);
        assert_eq!(tm::cell_at(&built.map, x, y).map(|cell| cell.zone), Some("street"), "{label}: вход — на дороге, а не в поле");
    }
    // Центр сцены под открытым небом даёт деревне площадь, и дома у неё
    // смотрят на неё дверью.
    let map = build(&case("pipeline:entry-road/square")["options"]).map;
    assert!(map.zones.iter().any(|zone| zone.id == "square"), "у деревни есть площадь");
    let facing = map
        .doors
        .iter()
        .filter(|door| sk_core::text::test(sk_core::re!(r"^building-\d+-door$", "u"), &door.id))
        .filter(|door| {
            let outside = [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)]
                .into_iter()
                .find(|&(x, y)| !tm::cell_at(&map, x, y).is_some_and(|cell| cell.zone.starts_with("building-")));
            outside.is_some_and(|(x, y)| [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| tm::cell_at(&map, x + dx, y + dy).is_some_and(|cell| cell.zone == "square")))
        })
        .count();
    assert!(facing >= 2, "дверью к площади — хотя бы два дома, а не ни одного ({facing})");
}

#[test]
fn null_design_fails_like_js() {
    let error = build_settlement_scene(&json!({ "seed": "x", "design": null })).expect_err("JS падает TypeError");
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, "Cannot read properties of null (reading 'topology')");
}
