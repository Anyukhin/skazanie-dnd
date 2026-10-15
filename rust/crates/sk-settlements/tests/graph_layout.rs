//! Сверка `graph_layout` с эталоном JS (`fixtures/graph-layout.json`,
//! генератор `fixtures/gen-graph-layout.mjs`) и перенос
//! `test/graph-layout.test.mjs` и `test/graph-layout-crypt.test.mjs` (части,
//! где предмет проверки — сама раскладка).

mod common;

use std::collections::HashSet;
use std::sync::LazyLock;

use common::{array, dump, error_json, hash, map_hash, mulberry32, parse, serialized, stringify};
use serde_json::{json, Value};
use sk_geometry::scene_graph::{create_scene_graph, reachable_zones, SceneGraph};
use sk_settlements::graph_layout::{
    assign_zones_to_leaves, build_scene_from_graph, layout_scene_graph, plan_chambers, rooms_json, shared_wall, split_area, GraphLayoutOptions, LeafRect,
    WallAxis, GRAPH_LAYOUT,
};
use sk_tactical::tactical_map::{self as tm, EdgeKind};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/graph-layout.json")));

fn rect(value: &Value) -> LeafRect {
    let side = |key: &str| value[key].as_i64().unwrap_or_else(|| panic!("{key} в {value}"));
    LeafRect::new(side("minX"), side("minY"), side("maxX"), side("maxY"))
}

fn graph(value: &Value) -> SceneGraph {
    serde_json::from_value(value.clone()).expect("граф из эталона")
}

/// Параметры случая: отсутствующий ключ — значение по умолчанию JS.
struct OwnedOptions {
    seed: String,
    width: f64,
    height: f64,
    location_id: String,
    theme: String,
    material: String,
}

impl OwnedOptions {
    fn from_json(value: &Value) -> Self {
        let defaults = GraphLayoutOptions::default();
        let text = |key: &str, fallback: &str| value.get(key).map_or(fallback.to_string(), |item| item.as_str().unwrap_or_else(|| panic!("{key}: строка")).to_string());
        let number = |key: &str, fallback: f64| value.get(key).map_or(fallback, |item| item.as_f64().unwrap_or_else(|| panic!("{key}: число")));
        Self {
            seed: text("seed", defaults.seed),
            width: number("width", defaults.width),
            height: number("height", defaults.height),
            location_id: text("locationId", defaults.location_id),
            theme: text("theme", defaults.theme),
            material: text("material", defaults.material),
        }
    }

    fn options(&self) -> GraphLayoutOptions<'_> {
        GraphLayoutOptions {
            seed: &self.seed,
            width: self.width,
            height: self.height,
            location_id: &self.location_id,
            theme: &self.theme,
            material: &self.material,
        }
    }
}

fn layout_json(graph: &SceneGraph, options: &GraphLayoutOptions<'_>) -> (Value, Option<Value>) {
    match layout_scene_graph(graph, options) {
        Ok(built) => (
            json!({ "mapHash": map_hash(&built.map), "rooms": rooms_json(&built.rooms), "warnings": built.warnings }),
            Some(serialized(&built.map)),
        ),
        Err(error) => (json!({ "error": error_json(&error) }), None),
    }
}

fn build_json(graph: &SceneGraph, options: &GraphLayoutOptions<'_>) -> Value {
    match build_scene_from_graph(graph, options) {
        Ok(built) => json!({
            "mapHash": map_hash(&built.map),
            "warnings": built.warnings,
            "errors": built.errors.iter().map(|issue| issue.to_json()).collect::<Vec<_>>(),
        }),
        Err(error) => json!({ "error": error_json(&error) }),
    }
}

#[test]
fn layout_cases_match_js() {
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 1_000, "случаев {}", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let label = case["label"].as_str().expect("метка");
        let graph = graph(&case["graph"]);
        let owned = OwnedOptions::from_json(&case["options"]);
        let options = owned.options();
        let (layout, map) = layout_json(&graph, &options);
        if stringify(&layout) != stringify(&case["layout"]) {
            let path = map.map(|map| dump(label, &map)).unwrap_or_default();
            failures.push(format!("{label}: раскладка\n  Rust: {}\n  JS:   {}\n  карта Rust: {path}", stringify(&layout), stringify(&case["layout"])));
            continue;
        }
        let build = build_json(&graph, &options);
        if stringify(&build) != stringify(&case["build"]) {
            failures.push(format!("{label}: сборка\n  Rust: {}\n  JS:   {}", stringify(&build), stringify(&case["build"])));
        }
        // Склеп теста `graph-layout-crypt`: JS проверил готовую сцену
        // аудитом карты; раскладка совпала байт в байт — совпадает и вход
        // остального конвейера.
        if let Some(audit) = case.get("audit") {
            assert_eq!(audit, &json!([]), "{label}: аудит JS");
        }
        if let Some(pipeline) = case.get("pipelineHash") {
            assert_eq!(pipeline, &case["build"]["mapHash"], "{label}: карта конвейера");
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn split_area_matches_js() {
    for case in array(&FIXTURE["split"]) {
        let count = case["count"].as_u64().expect("count") as usize;
        let minimum = case.get("minimum").and_then(Value::as_i64).unwrap_or(5);
        let mut random = mulberry32(case["randomSeed"].as_u64().expect("seed") as u32);
        let leaves = split_area(rect(&case["area"]), count, &mut random, minimum);
        let actual: Vec<Value> = leaves.iter().map(LeafRect::to_json).collect();
        assert_eq!(stringify(&Value::Array(actual)), stringify(&case["leaves"]), "splitArea {}", stringify(case));
    }
}

#[test]
fn shared_wall_matches_js() {
    for case in array(&FIXTURE["walls"]) {
        let wall = shared_wall(&rect(&case["a"]), &rect(&case["b"]));
        assert_eq!(stringify(&wall.map_or(Value::Null, |wall| wall.to_json())), stringify(&case["wall"]), "sharedWall {}", stringify(case));
    }
}

#[test]
fn assign_zones_to_leaves_matches_js() {
    for case in array(&FIXTURE["assign"]) {
        let leaves: Vec<LeafRect> = array(&case["leaves"]).iter().map(rect).collect();
        let rooms = assign_zones_to_leaves(&graph(&case["graph"]), &leaves);
        assert_eq!(stringify(&rooms_json(&rooms)), stringify(&case["rooms"]), "assignZonesToLeaves {}", stringify(&case["graph"]));
    }
}

#[test]
fn plan_chambers_matches_js() {
    let mut planned = 0;
    for case in array(&FIXTURE["chambers"]) {
        let width = case["width"].as_i64().expect("width");
        let height = case["height"].as_i64().expect("height");
        let mut random = mulberry32(case["randomSeed"].as_u64().expect("seed") as u32);
        let result = plan_chambers(&graph(&case["graph"]), width, height, &mut random);
        let context = format!("planChambers {width}×{height} {}", stringify(&case["graph"]));
        match result {
            Err(error) => assert_eq!(error_json(&error), case["error"], "{context}"),
            Ok(None) => assert_eq!(case["plan"], Value::Null, "{context}"),
            Ok(Some(plan)) => {
                planned += 1;
                let passages: Vec<Value> = plan
                    .passages
                    .iter()
                    .map(|passage| {
                        json!({
                            "link": passage.link.id,
                            "kind": passage.link.kind,
                            "keyId": passage.link.key_id,
                            "cells": passage.cells.iter().map(|cell| json!([cell.x, cell.y])).collect::<Vec<_>>(),
                            "mouths": passage.mouths.iter().map(|mouth| json!([mouth.x, mouth.y, mouth.door])).collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                if let Some(full) = case.get("full") {
                    assert_eq!(stringify(&Value::Array(passages.clone())), stringify(&full["passages"]), "{context}: ходы");
                }
                assert_eq!(stringify(&rooms_json(&plan.rooms)), stringify(&case["rooms"]), "{context}: камеры");
                assert_eq!(passages.len() as u64, case["passages"].as_u64().unwrap_or(u64::MAX), "{context}: число ходов");
                assert_eq!(hash(&Value::Array(passages)), case["passagesHash"].as_str().unwrap_or(""), "{context}: ходы");
            }
        }
    }
    assert!(planned > 100, "склепов с камерами {planned}");
}

// --- перенос test/graph-layout.test.mjs -------------------------------------------

fn dungeon_graph() -> SceneGraph {
    create_scene_graph(&json!({
        "entranceZoneId": "entry",
        "goalZoneId": "vault",
        "zones": [
            { "id": "entry", "kind": "interior", "label": "Вход" },
            { "id": "hall", "kind": "interior", "required": true, "label": "Зал" },
            { "id": "guard", "kind": "interior", "keys": ["vault-key"], "label": "Караулка" },
            { "id": "vault", "kind": "interior", "label": "Сокровищница" },
        ],
        "links": [
            { "id": "l1", "from": "entry", "to": "hall", "kind": "door" },
            { "id": "l2", "from": "hall", "to": "guard", "kind": "open" },
            { "id": "l3", "from": "hall", "to": "vault", "kind": "locked", "keyId": "vault-key" },
        ],
    }))
    .expect("граф")
}

fn seeded(seed: &str) -> GraphLayoutOptions<'_> {
    GraphLayoutOptions { seed, ..GraphLayoutOptions::default() }
}

#[test]
fn split_gives_requested_number_of_comparable_rooms() {
    let mut seed: u32 = 1;
    let mut random = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(seed) / 4_294_967_296.0
    };
    let leaves = split_area(LeafRect::new(0, 0, 25, 25), 4, &mut random, 5);
    assert_eq!(leaves.len(), 4);
    let areas: Vec<i64> = leaves.iter().map(|leaf| (leaf.max_x - leaf.min_x) * (leaf.max_y - leaf.min_y)).collect();
    let (max, min) = (*areas.iter().max().expect("max"), *areas.iter().min().expect("min"));
    assert!((max as f64) / (min as f64) < 8.0, "помещения слишком разные: {areas:?}");
    for leaf in &leaves {
        assert!(leaf.max_x - leaf.min_x >= 4 && leaf.max_y - leaf.min_y >= 4, "помещение меньше минимального");
    }
}

#[test]
fn shared_wall_only_for_adjacent_rectangles() {
    let a = LeafRect::new(0, 0, 10, 10);
    let b = LeafRect::new(10, 0, 20, 10);
    let far = LeafRect::new(14, 14, 20, 20);
    let wall = shared_wall(&a, &b).expect("общая стена");
    assert_eq!(wall.axis, WallAxis::X);
    assert_eq!(wall.at, 10);
    assert_eq!(shared_wall(&a, &far), None);
}

#[test]
fn graph_map_is_deterministic_by_seed() {
    let first = stringify(&serialized(&layout_scene_graph(&dungeon_graph(), &seeded("same")).expect("карта").map));
    let second = stringify(&serialized(&layout_scene_graph(&dungeon_graph(), &seeded("same")).expect("карта").map));
    assert_eq!(first, second);
    assert_ne!(first, stringify(&serialized(&layout_scene_graph(&dungeon_graph(), &seeded("other")).expect("карта").map)));
}

#[test]
fn geometry_keeps_topology_every_graph_zone_reachable_by_cells() {
    let built = build_scene_from_graph(&dungeon_graph(), &seeded("topology")).expect("сцена");
    assert!(built.errors.is_empty(), "замечания: {:?}", built.errors);
    assert!(built.warnings.is_empty(), "предупреждения: {:?}", built.warnings);
    let spawn = built.map.spawn_points.iter().find(|point| point.role == "party").expect("точка отряда");
    // `reachableCells(map, x, y)` по умолчанию проходит сквозь двери.
    let reached = tm::reachable_cells(&built.map, spawn.x, spawn.y, true, None);
    let zones: HashSet<String> =
        reached.iter().filter_map(|(x, y)| tm::cell_at(&built.map, *x, *y)).map(|cell| cell.zone.to_string()).filter(|zone| !zone.is_empty()).collect();
    let graph_zones = reachable_zones(&dungeon_graph(), None).zones;
    assert_eq!(graph_zones.len(), 4);
    for zone in &graph_zones {
        assert!(zones.contains(zone), "зона {zone} достижима на графе, но не по клеткам");
    }
}

#[test]
fn locked_link_becomes_locked_door_with_key() {
    let built = build_scene_from_graph(&dungeon_graph(), &seeded("locks")).expect("сцена");
    let locked = built.map.door("door-l3").expect("дверь запертой связи обязана существовать");
    assert_eq!(locked.state, "locked");
    assert_eq!(locked.key_item_id.as_deref(), Some("vault-key"));
    assert!(locked.lock_dc > 0, "у запертой двери обязана быть сложность вскрытия");
    let plain = built.map.door("door-l1").expect("дверь");
    assert_eq!(plain.state, "closed");
    assert_eq!(plain.key_item_id, None);
    // Открытая связь двери не порождает — это просто проход.
    assert!(built.map.door("door-l2").is_none());
}

#[test]
fn graph_map_passes_structural_validation() {
    let built = layout_scene_graph(&dungeon_graph(), &seeded("valid")).expect("карта");
    assert!(tm::validate_tactical_map(&built.map).errors.is_empty());
    assert!(tm::edge_list(&built.map).iter().filter(|edge| edge.kind == EdgeKind::Wall).count() > 20, "стены обязаны быть на рёбрах");
}

#[test]
fn rock_around_rooms_is_impassable() {
    let built = layout_scene_graph(&dungeon_graph(), &seeded("rock")).expect("карта");
    let (mut rock, mut rooms) = (0, 0);
    for cell in tm::cells(&built.map) {
        if cell.passable {
            rooms += 1;
        } else {
            rock += 1;
        }
    }
    assert!(rock > 0, "между помещениями обязана быть порода");
    assert!(rooms > 0 && rooms < built.map.width * built.map.height, "карта не может быть сплошным полом");
}

#[test]
fn broken_graph_returns_stage_one_issues() {
    let broken = create_scene_graph(&json!({
        "entranceZoneId": "a",
        "goalZoneId": "b",
        "zones": [{ "id": "a" }, { "id": "b", "keys": ["k"] }],
        "links": [{ "id": "ab", "from": "a", "to": "b", "kind": "locked", "keyId": "k" }],
    }))
    .expect("граф");
    let built = build_scene_from_graph(&broken, &seeded("broken")).expect("сцена");
    assert!(built.errors.iter().any(|issue| issue.code == "KEY_BEHIND_ITS_OWN_DOOR"), "коды: {:?}", built.errors);
}

#[test]
fn linked_zones_become_adjacent_rooms() {
    let built = layout_scene_graph(&dungeon_graph(), &seeded("adjacency")).expect("карта");
    for link in &dungeon_graph().links {
        let a = built.rooms.get(&link.from).expect("зона размещена");
        let b = built.rooms.get(&link.to).expect("зона размещена");
        assert!(shared_wall(a, b).is_some(), "зоны {} и {} связаны на графе, но не смежны на карте", link.from, link.to);
    }
}

#[test]
fn exterior_zone_gets_grass_interior_gets_theme_material() {
    let graph = create_scene_graph(&json!({
        "entranceZoneId": "yard",
        "goalZoneId": "room",
        "zones": [{ "id": "yard", "kind": "exterior", "label": "Двор" }, { "id": "room", "kind": "interior", "label": "Комната" }],
        "links": [{ "id": "in", "from": "yard", "to": "room", "kind": "door" }],
    }))
    .expect("граф");
    let built = layout_scene_graph(&graph, &GraphLayoutOptions { seed: "zones", material: "marble", ..GraphLayoutOptions::default() }).expect("карта");
    let mut materials = std::collections::HashMap::new();
    for cell in tm::cells(&built.map) {
        if cell.passable && !cell.zone.is_empty() {
            materials.insert(cell.zone.to_string(), cell.material);
        }
    }
    assert_eq!(materials.get("yard"), Some(&"grass"));
    assert_eq!(materials.get("room"), Some(&"marble"));
}

#[test]
fn six_zone_graph_on_large_scene_keeps_connectivity() {
    let graph = create_scene_graph(&json!({
        "entranceZoneId": "z1",
        "goalZoneId": "z6",
        "zones": [{ "id": "z1" }, { "id": "z2", "required": true }, { "id": "z3", "keys": ["k"] }, { "id": "z4" }, { "id": "z5" }, { "id": "z6" }],
        "links": [
            { "id": "a", "from": "z1", "to": "z2", "kind": "open" },
            { "id": "b", "from": "z2", "to": "z3", "kind": "door" },
            { "id": "c", "from": "z3", "to": "z4", "kind": "open" },
            { "id": "d", "from": "z4", "to": "z5", "kind": "door" },
            { "id": "e", "from": "z5", "to": "z6", "kind": "locked", "keyId": "k" },
        ],
    }))
    .expect("граф");
    let built = build_scene_from_graph(&graph, &GraphLayoutOptions { seed: "six", width: 34.0, height: 34.0, ..GraphLayoutOptions::default() }).expect("сцена");
    assert!(built.errors.is_empty(), "замечания: {:?}", built.errors);
    assert!(built.warnings.is_empty(), "предупреждения: {:?}", built.warnings);
}

// --- перенос test/graph-layout-crypt.test.mjs (раскладка) -------------------------

fn named_case(label: &str) -> &'static Value {
    array(&FIXTURE["cases"]).iter().find(|case| case["label"] == label).unwrap_or_else(|| panic!("нет случая {label}"))
}

#[test]
fn crypt_chambers_keep_graph_topology_and_stay_apart() {
    for seed in ["t1", "t2", "t3", "t4", "t5", "t6"] {
        let case = named_case(&format!("crypt-topology/{seed}"));
        let graph = graph(&case["graph"]);
        let built = build_scene_from_graph(&graph, &GraphLayoutOptions { seed, width: 26.0, height: 26.0, theme: "crypt", material: "stone", ..GraphLayoutOptions::default() })
            .expect("сцена");
        assert!(built.errors.is_empty(), "{seed}: {:?}", built.errors);
        assert!(built.warnings.is_empty(), "{seed}: {:?}", built.warnings);
        assert_eq!(built.map.generator.id, GRAPH_LAYOUT.id);
        assert_eq!(built.map.generator.version, "2", "{seed}: склеп собран прежней версией");
        // Ходы, а не общие стены: камеры склепа не соприкасаются.
        let rooms: Vec<LeafRect> = layout_scene_graph(&graph, &GraphLayoutOptions { seed, width: 26.0, height: 26.0, theme: "crypt", ..GraphLayoutOptions::default() })
            .expect("карта")
            .rooms
            .values()
            .copied()
            .collect();
        for (index, a) in rooms.iter().enumerate() {
            for b in &rooms[index + 1..] {
                let apart = a.max_x < b.min_x - 1 || b.max_x < a.min_x - 1 || a.max_y < b.min_y - 1 || b.max_y < a.min_y - 1;
                assert!(apart, "{seed}: камеры {a:?} и {b:?} без породы между ними");
            }
        }
    }
}

#[test]
fn tight_crypt_map_builds_chambers_and_tiny_one_falls_back_to_split() {
    let graph = graph(&named_case("crypt-small")["graph"]);
    let small = build_scene_from_graph(&graph, &GraphLayoutOptions { seed: "small", width: 16.0, height: 16.0, theme: "crypt", ..GraphLayoutOptions::default() }).expect("сцена");
    assert!(small.errors.is_empty(), "{:?}", small.errors);
    let floor = tm::cells(&small.map).filter(|cell| cell.passable).count();
    assert!(floor as f64 <= 16.0 * 16.0 * 0.4, "16×16: проходимо {floor} клеток — склеп собран залами, а не камерами");
    // Карта 12×12 камер с ходами не вмещает — склеп всё равно собирается.
    let tiny = build_scene_from_graph(&graph, &GraphLayoutOptions { seed: "tiny", width: 12.0, height: 12.0, theme: "crypt", ..GraphLayoutOptions::default() }).expect("сцена");
    assert!(tiny.errors.is_empty(), "{:?}", tiny.errors);
}

#[test]
fn crypt_corridors_are_one_cell_wide() {
    // Ход — клетки без зоны; квадрата 2×2 из них нет — ни в одном склепе
    // конвейера, где сработали камеры.
    let mut checked = 0;
    for case in array(&FIXTURE["cases"]) {
        if case["options"]["theme"] != "crypt" || case["layout"].get("error").is_some() {
            continue;
        }
        let owned = OwnedOptions::from_json(&case["options"]);
        let built = layout_scene_graph(&graph(&case["graph"]), &owned.options()).expect("карта");
        if built.map.generator.version != "2" || built.map.width < 16 {
            continue;
        }
        let passage: HashSet<(i64, i64)> = tm::cells(&built.map).filter(|cell| cell.passable && cell.zone.is_empty()).map(|cell| (cell.x, cell.y)).collect();
        // Только склепы камерами: у разбиения залами ходов нет вовсе.
        if passage.is_empty() || !case["label"].as_str().is_some_and(|label| label.starts_with("pipeline:")) {
            continue;
        }
        checked += 1;
        for (x, y) in &passage {
            let square = [(1, 0), (0, 1), (1, 1)].iter().all(|(dx, dy)| passage.contains(&(x + dx, y + dy)));
            assert!(!square, "{}: ход шире клетки у {x},{y}", case["label"]);
        }
    }
    assert!(checked > 20, "склепов проверено {checked}");
}
