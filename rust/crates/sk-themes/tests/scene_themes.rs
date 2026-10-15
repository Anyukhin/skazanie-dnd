//! Перенос проверок `test/scene-themes.test.mjs`, тем из
//! `test/map-quality.test.mjs` и сцен `buildThemedScene` из
//! `test/scene-dressing.test.mjs`. Сцены, которые JS строит через конвейер
//! (`generateSceneGeometry`), берутся из эталона: метки `pipeline:mq/…` —
//! пойманный вход `buildThemedScene`, а тема карты после сборки — как у
//! конвейера (`matched.assetTheme ?? matched.id`). Совпадение самих карт с JS
//! проверяет `tests/fixtures.rs`; здесь — свойства, которые требуют тесты JS.

mod common;

use std::collections::{HashMap, HashSet};

use common::section;
use serde_json::{json, Value};
use sk_core::indexmap::IndexSet;
use sk_geometry::scene_graph::validate_scene_graph;
use sk_map_core::map_quality::audit_tactical_map;
use sk_scene_base::asset_registry::assets_for_theme;
use sk_tactical::tactical_map::{self as tm, EdgeKind, EdgePatch, TacticalMap};
use sk_themes::scene_themes::{
    build_themed_scene, fallback_theme_for, is_live_theme, layout_open_terrain, layout_organic_cave, layout_settlement, match_theme, resolve_scene_theme, scene_graph_for_theme,
    theme_by_id, theme_for, theme_from_map_request, LayoutOptions, SCENE_THEMES,
};

const THEMES: [&str; 9] = ["building", "temple", "crypt", "dungeon", "cave", "forest", "road", "graveyard", "settlement"];

fn scene(options: Value) -> TacticalMap {
    build_themed_scene(&options).unwrap_or_else(|error| panic!("{}: {error}", options)).map
}

fn party(map: &TacticalMap) -> (i64, i64) {
    map.spawn_points.iter().find(|point| point.role == "party").map(|point| (point.x, point.y)).expect("точка появления отряда")
}

fn reach(map: &TacticalMap) -> IndexSet<(i64, i64)> {
    let (x, y) = party(map);
    tm::reachable_cells(map, x, y, true, None)
}

fn passable_cells(map: &TacticalMap) -> Vec<(i64, i64)> {
    tm::cells(map).filter(|cell| cell.passable).map(|cell| (cell.x, cell.y)).collect()
}

fn count(map: &TacticalMap, asset_id: &str) -> usize {
    map.props.iter().filter(|prop| prop.asset_id == asset_id).count()
}

fn assets(map: &TacticalMap) -> HashSet<&str> {
    map.props.iter().map(|prop| prop.asset_id.as_str()).collect()
}

fn labels(map: &TacticalMap) -> Vec<&str> {
    map.zones.iter().map(|zone| zone.label.as_str()).collect()
}

fn problems(map: &TacticalMap) -> Vec<&'static str> {
    audit_tactical_map(map).problems.iter().map(|problem| problem.code).collect()
}

fn zone_at(map: &TacticalMap, x: f64, y: f64) -> String {
    tm::cell_at(map, x.floor() as i64, y.floor() as i64).map_or(String::new(), |cell| cell.zone.to_string())
}

/// Карты конвейера из эталона по началу метки (`pipeline:<prefix>`): вход
/// `buildThemedScene`, затем тема карты, как её ставит `generateSceneGeometryFor`.
fn pipeline_maps(prefix: &str) -> Vec<(String, TacticalMap)> {
    let wanted = format!("pipeline:{prefix}");
    let found: Vec<(String, TacticalMap)> = section("scenes")
        .iter()
        .filter(|case| case["label"].as_str().is_some_and(|label| label.starts_with(&wanted)))
        .map(|case| {
            let label = case["label"].as_str().unwrap_or("").to_string();
            let built = build_themed_scene(&case["options"]).unwrap_or_else(|error| panic!("{label}: {error}"));
            let theme = theme_by_id(&built.theme);
            let mut map = built.map;
            map.theme = theme.asset_theme().unwrap_or(theme.id).to_string();
            (label, map)
        })
        .collect();
    assert!(!found.is_empty(), "нет сцен {wanted}");
    found
}

fn pipeline_map(label: &str) -> TacticalMap {
    pipeline_maps(label).remove(0).1
}

// --- test/scene-themes.test.mjs ----------------------------------------------------------

#[test]
fn plan_declares_eight_themes_beyond_building() {
    let mut ids: Vec<&str> = SCENE_THEMES.iter().map(|theme| theme.id).collect();
    ids.sort_unstable();
    let mut expected = THEMES.to_vec();
    expected.sort_unstable();
    assert_eq!(ids, expected);
    for theme in SCENE_THEMES.iter() {
        assert!(["building", "graph", "open", "settlement"].contains(&theme.kind), "{}: неизвестный способ сборки", theme.id);
        assert!(!theme.label.is_empty(), "{}: нет подписи", theme.id);
    }
}

#[test]
fn theme_is_recognized_by_location_name() {
    for (location, expected) in [
        ("Таверна «Сломанное колесо»", "building"),
        ("Храм Утренней Звезды", "temple"),
        ("Склеп Норвин", "crypt"),
        ("Пещера у водопада", "cave"),
        ("Тёмный лес", "forest"),
        ("Северный тракт", "road"),
        ("Деревня Заречье", "settlement"),
    ] {
        assert_eq!(theme_for(&json!({ "location": location })).id, expected, "«{location}» опознан неверно");
    }
}

#[test]
fn inn_under_any_name_is_a_building() {
    for location in ["Заброшенный караван-сарай", "Вход в древний караван-сарай на торговом пути", "Подворье у переправы", "Ночлежка на окраине", "Особняк наместника", "Терем воеводы"] {
        assert_eq!(theme_for(&json!({ "location": location })).id, "building", "«{location}» опознан неверно");
    }
    assert!(match_theme(&json!({ "location": "Разграбленный караван" })).is_none());
}

#[test]
fn only_themes_with_ready_geometry_are_live() {
    let mut live: Vec<&str> = SCENE_THEMES.iter().filter(|theme| is_live_theme(Some(theme))).map(|theme| theme.id).collect();
    live.sort_unstable();
    let mut expected = THEMES.to_vec();
    expected.sort_unstable();
    assert_eq!(live, expected);
    for theme in SCENE_THEMES.iter() {
        assert!(theme.get("live").is_some_and(Value::is_boolean), "{}: готовность не объявлена", theme.id);
    }
}

#[test]
fn settlement_has_distinct_buildings_doors_and_a_continuous_main_street() {
    let settlement = theme_by_id("settlement").json();
    let building_id = sk_core::re!(r"^building-\d+$", "u");
    for seed in ["village-a", "village-b"] {
        let map = layout_settlement(settlement, &json!({ "seed": seed, "width": 28, "height": 24, "design": { "topology": "crossroads" } })).expect("поселение");
        assert!(tm::validate_tactical_map(&map).errors.is_empty(), "{seed}: поселение невалидно");
        let buildings: Vec<_> = map.zones.iter().filter(|zone| sk_core::text::test(building_id, &zone.id)).collect();
        assert!(buildings.len() >= 3, "{seed}: построек {}", buildings.len());
        let door_id = sk_core::re!(r"^building-\d+-door$", "u");
        assert_eq!(map.doors.iter().filter(|door| sk_core::text::test(door_id, &door.id)).count(), buildings.len(), "{seed}: не у каждой постройки есть дверь");
        for back in map.zones.iter().filter(|zone| zone.id.ends_with("-back")) {
            assert!(map.doors.iter().any(|door| door.id == format!("{}-door", back.id)), "{seed}/{}: в заднюю комнату нет двери", back.id);
        }
        let reached = reach(&map);
        for building in &buildings {
            let mut interior = Vec::new();
            let mut adjacent_walls = 0;
            for cell in tm::cells(&map).filter(|cell| cell.passable && cell.zone == building.id) {
                interior.push((cell.x, cell.y));
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let Some(neighbor) = tm::cell_at(&map, cell.x + dx, cell.y + dy) else { continue };
                    if !neighbor.passable && neighbor.material == building.material {
                        adjacent_walls += 1;
                    }
                    if neighbor.passable {
                        if let Ok(Some(edge)) = tm::edge_between(&map, cell.x, cell.y, cell.x + dx, cell.y + dy) {
                            if edge.kind != EdgeKind::Door && edge.blocks_move {
                                adjacent_walls += 1;
                            }
                        }
                    }
                }
            }
            assert!(interior.len() >= 10, "{seed}/{}: постройка не имеет читаемого интерьера", building.id);
            assert!(adjacent_walls >= 6, "{seed}/{}: постройка не окружена стенами", building.id);
            assert!(interior.iter().any(|cell| reached.contains(cell)), "{seed}/{}: из улицы нельзя войти в постройку", building.id);
        }
        let start: Vec<(i64, i64)> = (0..map.height).filter(|y| tm::cell_at(&map, 0, *y).is_some_and(|cell| cell.zone == "street")).map(|y| (0, y)).collect();
        let mut street: HashSet<(i64, i64)> = start.iter().copied().collect();
        let mut queue = start.clone();
        let mut index = 0;
        while index < queue.len() {
            let (x, y) = queue[index];
            index += 1;
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let next = (x + dx, y + dy);
                if !street.contains(&next) && tm::cell_at(&map, next.0, next.1).is_some_and(|cell| cell.passable && cell.zone == "street") {
                    street.insert(next);
                    queue.push(next);
                }
            }
        }
        assert!(street.iter().any(|(x, _)| *x == map.width - 1), "{seed}: главная улица не пересекает карту");
    }
    let built = scene(json!({ "location": "Деревня Заречье", "seed": "village-props", "width": 28, "height": 24 }));
    for asset in ["well", "cart"] {
        assert!(assets(&built).contains(asset), "в поселении нет {asset}");
    }
    assert!(count(&built, "cart") <= 2 && count(&built, "wagon_wheel") <= 2 && count(&built, "well") == 1 && count(&built, "campfire") <= 1);
    let market = scene(json!({ "location": "Деревня Заречье", "seed": "village-props", "width": 28, "height": 24, "design": { "topology": "market" } }));
    assert!(count(&market, "market_stall") >= 2, "на рыночной площади меньше двух прилавков");
}

#[test]
fn cave_is_one_connected_organic_cavity() {
    let cave = theme_by_id("cave").json();
    for seed in ["organic-a", "organic-b", "organic-c"] {
        let map = layout_organic_cave(cave, &LayoutOptions { seed, width: 28.0, height: 24.0, location_id: "" }).expect("пещера");
        let floor = passable_cells(&map);
        assert_eq!(reach(&map).len(), floor.len(), "{seed}: внутри полости есть отрезанный участок");
        let (min_x, max_x) = (floor.iter().map(|cell| cell.0).min().unwrap_or(0), floor.iter().map(|cell| cell.0).max().unwrap_or(0));
        let (min_y, max_y) = (floor.iter().map(|cell| cell.1).min().unwrap_or(0), floor.iter().map(|cell| cell.1).max().unwrap_or(0));
        let bounding = ((max_x - min_x + 1) * (max_y - min_y + 1)) as f64;
        assert!((floor.len() as f64) / bounding < 0.72, "{seed}: полость заполняет {:.2} своего прямоугольника", floor.len() as f64 / bounding);
        let widths: HashSet<usize> = (min_y..=max_y).map(|y| floor.iter().filter(|cell| cell.1 == y).count()).collect();
        assert!(widths.len() >= 6, "{seed}: контур имеет всего {} разных ширин", widths.len());
        let occupied: HashSet<String> = floor.iter().filter_map(|(x, y)| tm::cell_at(&map, *x, *y).map(|cell| cell.zone.to_string())).filter(|zone| !zone.is_empty()).collect();
        assert_eq!(occupied.len(), map.zones.len(), "{seed}: один из залов графа не получил геометрию");
    }
}

#[test]
fn map_request_pattern_names_theme_when_location_is_silent() {
    let id = |request: Value| theme_from_map_request(&request).map(|theme| theme.id);
    assert_eq!(id(json!({ "pattern": "crypt" })), Some("crypt"));
    assert_eq!(id(json!({ "pattern": "crypt", "layout": "cavern" })), Some("crypt"));
    assert_eq!(id(json!({ "pattern": "cave-cluster" })), Some("cave"));
    assert_eq!(id(json!({ "pattern": "village" })), Some("settlement"));
    assert_eq!(id(json!({ "pattern": "bridge" })), Some("road"));
    assert_eq!(id(json!({ "layout": "cavern" })), Some("cave"));
    assert_eq!(id(json!({ "layout": "streets" })), Some("settlement"));
    for pattern in ["keep", "great-hall", "courtyard", "natural", "small-room"] {
        assert_eq!(id(json!({ "pattern": pattern })), None, "{pattern}: подменён темой");
    }
    assert_eq!(id(json!({})), None);
}

#[test]
fn unknown_location_gets_topology_fallback() {
    for (input, expected) in [
        (json!({ "sceneKind": "dungeon", "request": { "layout": "rooms", "pattern": "natural" } }), "crypt"),
        (json!({ "request": { "layout": "cavern", "pattern": "natural" } }), "cave"),
        (json!({ "request": { "layout": "streets", "pattern": "natural" } }), "settlement"),
        (json!({ "sceneKind": "wilderness", "request": { "layout": "open", "pattern": "natural" } }), "forest"),
        (json!({ "request": { "layout": "rooms", "pattern": "keep", "material": "stone" } }), "crypt"),
        (json!({ "request": { "layout": "rooms", "pattern": "small-room", "material": "wood" } }), "building"),
        (json!({ "request": {} }), "road"),
    ] {
        let fallback = fallback_theme_for(&input);
        assert_eq!(fallback.id, expected);
        assert!(is_live_theme(Some(fallback)), "{expected}: fallback не готов к живой игре");
    }
}

#[test]
fn wilderness_never_becomes_a_building() {
    assert_ne!(theme_for(&json!({ "location": "Дом у дороги", "sceneKind": "wilderness" })).id, "building");
    assert_eq!(theme_for(&json!({ "location": "Дом травницы" })).id, "building");
    assert_eq!(theme_for(&json!({ "location": "Безымянная пустошь", "sceneKind": "wilderness" })).id, "forest");
}

fn resolve(input: Value) -> &'static str {
    resolve_scene_theme(&input).id
}

#[test]
fn village_named_ford_is_a_settlement_when_world_knows_its_kind() {
    assert_eq!(resolve(json!({ "location": "Тихий Брод" })), "road");
    assert_eq!(resolve(json!({ "location": "Тихий Брод", "worldKind": "village" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Тихий Брод", "worldKind": "town" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Мормар", "worldKind": "port" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Тихий Брод", "sceneKind": "settlement" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Тихий Брод", "settlementType": "village" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Тихий Брод", "request": { "layout": "streets", "pattern": "village" } })), "settlement");
}

#[test]
fn structure_and_terrain_in_name_beat_world_kind() {
    assert_eq!(resolve(json!({ "location": "Таверна «Кабан»", "worldKind": "town" })), "building");
    assert_eq!(resolve(json!({ "location": "Склеп под площадью", "worldKind": "city" })), "crypt");
    assert_eq!(resolve(json!({ "location": "Роща у Эствуда", "worldKind": "village" })), "forest");
    assert_eq!(resolve(json!({ "location": "Перевал Трёх Ветров", "worldKind": "town", "sceneKind": "wilderness" })), "road");
    assert_eq!(resolve(json!({ "location": "Безымянная нора", "worldKind": "wilds", "sceneKind": "dungeon", "request": { "layout": "cavern" } })), "cave");
}

#[test]
fn world_kind_fills_in_when_name_is_silent() {
    assert_eq!(resolve(json!({ "location": "Керская пустошь", "worldKind": "wilds" })), "forest");
    assert_eq!(resolve(json!({ "location": "Норский провал", "worldKind": "dungeon" })), "cave");
    assert_eq!(resolve(json!({ "location": "Норская башня", "worldKind": "dungeon" })), "building");
    assert_eq!(resolve(json!({ "location": "Старый маяк", "theme": "берег реки", "worldKind": "landmark", "request": { "layout": "winding", "pattern": "bridge" } })), "building");
    assert_eq!(resolve(json!({ "location": "Маяково", "worldKind": "village" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Кальская твердыня", "worldKind": "fortress" })), "building");
    assert_eq!(resolve(json!({ "location": "Замок барона", "theme": "каменная крепость", "worldKind": "fortress", "sceneKind": "dungeon", "request": { "pattern": "crypt" } })), "dungeon");
    assert_eq!(resolve(json!({ "location": "Кальская твердыня", "worldKind": "fortress", "sceneKind": "dungeon" })), "dungeon");
    assert_eq!(resolve(json!({ "location": "Старое пепелище", "worldKind": "ruin" })), "crypt");
    assert_eq!(resolve(json!({ "location": "Кальмар", "worldKind": "landmark", "request": { "layout": "cavern" } })), "cave");
    assert_eq!(resolve(json!({ "location": "Кальмар", "worldKind": "landmark" })), "road");
}

#[test]
fn every_theme_has_registry_assets_that_belong_to_it() {
    for theme in SCENE_THEMES.iter().filter(|theme| theme.kind != "building") {
        let assets = assets_for_theme(theme.id);
        assert!(assets.len() >= 5, "у темы {} нет набора предметов", theme.id);
        for id in theme.get("require").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            assert!(assets.iter().any(|record| record.id == id), "обязательный предмет {id} темы {} не принадлежит ей в реестре", theme.id);
        }
    }
}

#[test]
fn theme_graph_passes_stage_one_including_key_order() {
    for theme in SCENE_THEMES.iter().filter(|theme| theme.kind == "graph") {
        for seed in ["a", "b", "c"] {
            let graph = scene_graph_for_theme(theme.json(), seed).expect("граф");
            let report = validate_scene_graph(&graph);
            assert!(report.errors.is_empty(), "{}/{seed}: {:?}", theme.id, report.errors.iter().map(|issue| issue.code.clone()).collect::<Vec<_>>());
        }
    }
}

#[test]
fn crypt_locks_last_door_and_places_key_before_it() {
    let graph = scene_graph_for_theme(theme_by_id("crypt").json(), "locked").expect("граф");
    let locked: Vec<_> = graph.links.iter().filter(|link| link.kind == "locked").collect();
    assert_eq!(locked.len(), 1, "у склепа обязана быть ровно одна запертая дверь");
    assert_eq!(locked[0].key_id.as_deref(), Some("goal-key"));
    assert!(validate_scene_graph(&graph).errors.is_empty(), "ключ обязан быть доступен до своей двери");
}

#[test]
fn every_theme_builds_a_valid_connected_map() {
    for theme in SCENE_THEMES.iter() {
        let built = build_themed_scene(&json!({ "location": theme.label, "seed": format!("build-{}", theme.id), "width": 28, "height": 28 })).expect("сцена");
        assert_eq!(built.theme, theme.id);
        assert!(tm::validate_tactical_map(&built.map).errors.is_empty(), "{}: карта не прошла валидацию", theme.id);
        assert!(built.warnings.is_empty(), "{}: предупреждения {:?}", theme.id, built.warnings);
        assert!(reach(&built.map).len() > 20, "{}: от точки появления достижимо мало клеток", theme.id);
        assert!(built.map.props.len() > 5, "{}: предметов всего {}", theme.id, built.map.props.len());
    }
}

#[test]
fn interior_map_gets_a_hanging_chandelier() {
    let tavern = scene(json!({ "location": "Таверна «Пустой кубок»", "seed": "swing-tavern", "width": 28, "height": 28 }));
    assert!(assets(&tavern).contains("chandelier"));
    let palace = scene(json!({ "themeId": "authored-palace", "location": "Военная галерея", "seed": "swing-palace", "width": 28, "height": 28 }));
    assert!(assets(&palace).contains("chandelier"));
}

#[test]
fn crypt_grate_and_temple_loophole_do_not_open_a_passage() {
    for (location, theme_id, kind) in [("Склеп Норвин", "crypt", EdgeKind::Grate), ("Храм Утренней Звезды", "temple", EdgeKind::Loophole)] {
        let options = json!({ "location": location, "seed": format!("pierce-{theme_id}"), "width": 28, "height": 28 });
        let built = build_themed_scene(&options).expect("сцена");
        assert_eq!(built.theme, theme_id);
        let pierced: Vec<_> = tm::edge_list(&built.map).into_iter().filter(|edge| edge.kind == kind).cloned().collect();
        assert!(!pierced.is_empty(), "{theme_id}: проёмов вида {kind:?} на карте нет");
        for edge in &pierced {
            assert!(edge.blocks_move, "{theme_id}: проём открыл проход сквозь стену");
            assert!(!edge.blocks_sight, "{theme_id}: сквозь проём не видно");
            assert_ne!(edge.cover.as_str(), "none", "{theme_id}: проём перестал давать укрытие");
        }
        let reached = reach(&built.map).len();
        let mut solid = scene(options);
        for edge in tm::edge_list(&solid).into_iter().filter(|edge| edge.kind == kind).cloned().collect::<Vec<_>>() {
            let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
            tm::set_edge(&mut solid, edge.x, edge.y, nx, ny, &EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None }).expect("ребро");
        }
        assert_eq!(reached, reach(&solid).len(), "{theme_id}: замена стены изменила проходимость");
    }
}

#[test]
fn theme_build_is_deterministic_from_seed() {
    for theme in SCENE_THEMES.iter() {
        let one = common::map_hash(&scene(json!({ "location": theme.label, "seed": "same" })));
        let two = common::map_hash(&scene(json!({ "location": theme.label, "seed": "same" })));
        assert_eq!(one, two, "{}: сборка недетерминирована", theme.id);
    }
}

#[test]
fn theme_props_do_not_leak_into_another_theme() {
    let cave = scene(json!({ "location": "Пещера у водопада", "seed": "leak" }));
    for prop in &cave.props {
        assert!(!["bar_counter", "table_round", "bed", "sarcophagus"].contains(&prop.asset_id.as_str()), "{} оказался в пещере", prop.asset_id);
    }
    let temple = scene(json!({ "location": "Храм Утренней Звезды", "seed": "leak" }));
    assert!(!temple.props.iter().any(|prop| prop.asset_id == "stalagmite"), "сталагмит оказался в храме");
}

#[test]
fn road_strip_crosses_the_whole_map() {
    let map = layout_open_terrain(theme_by_id("road").json(), &LayoutOptions { seed: "road", width: 30.0, height: 20.0, location_id: "" }).expect("дорога");
    let columns: HashSet<i64> = tm::cells(&map).filter(|cell| cell.material == "earth").map(|cell| cell.x).collect();
    assert_eq!(columns.len() as i64, map.width, "дорога обязана пересекать карту целиком");
}

#[test]
fn forest_edge_has_missing_cells_and_road_leaves_the_plot() {
    let forest = layout_open_terrain(theme_by_id("forest").json(), &LayoutOptions { seed: "f", width: 20.0, height: 20.0, location_id: "" }).expect("лес");
    assert!(tm::cell_at(&forest, 0, 10).is_none(), "граница леса — край участка, а не каменная стена");
    let road = layout_open_terrain(theme_by_id("road").json(), &LayoutOptions { seed: "r", width: 20.0, height: 20.0, location_id: "" }).expect("дорога");
    assert!((0..road.height).any(|y| tm::cell_passable(&road, 0, y)), "дорога обязана вести за пределы карты");
}

#[test]
fn open_outline_depends_on_seed_and_open_area_is_connected() {
    for id in ["forest", "road"] {
        let mut shapes: HashSet<String> = HashSet::new();
        for index in 0..100 {
            let seed = format!("{id}-{index}");
            let map = layout_open_terrain(theme_by_id(id).json(), &LayoutOptions { seed: &seed, width: 30.0, height: 30.0, location_id: "" }).expect("местность");
            let cells: Vec<_> = tm::cells(&map).filter(|cell| cell.passable).collect();
            assert_eq!(reach(&map).len(), cells.len());
            assert!((cells.len() as f64) < (map.width * map.height) as f64 * 0.9);
            shapes.insert(cells.iter().map(|cell| format!("{},{},{}", cell.x, cell.y, id == "road" && cell.material == "earth")).collect::<Vec<_>>().join(";"));
        }
        assert!(shapes.len() >= 6, "{id}: только {} контуров на 100 seed", shapes.len());
    }
}

#[test]
fn open_climate_changes_ground_surface_and_vegetation() {
    for (climate, material, surface, tree) in [("arid", "sand", Some("none"), "tree_dead"), ("cold", "ice", Some("ice"), "tree_pine"), ("wetland", "earth", None, "tree_dead")] {
        let map = scene(json!({ "themeId": "forest", "seed": "climate-check", "width": 30, "height": 24, "design": { "climate": climate } }));
        let cell = tm::cell_at(&map, 15, 12).expect("клетка");
        assert_eq!(cell.material, material);
        if let Some(surface) = surface {
            assert_eq!(cell.surface, surface);
        }
        assert!(assets(&map).contains(tree), "{climate}: нет {tree}");
    }
    let swamp = scene(json!({ "themeId": "forest", "seed": "climate-check", "width": 30, "height": 24, "design": { "climate": "wetland" } }));
    let open: Vec<_> = tm::cells(&swamp).filter(|cell| cell.passable && cell.surface != "water").collect();
    let mud = open.iter().filter(|cell| cell.surface == "mud").count();
    assert!(mud > 0 && (mud as f64) / (open.len() as f64) <= 0.25, "грязи {mud} из {}", open.len());
}

#[test]
fn open_v4_rocky_rim_connected_from_entrance() {
    for (theme_id, seed) in [("forest", "v3-forest"), ("road", "v3-road"), ("forest", "v3-pond-1"), ("forest", "v3-pond-2")] {
        let map = scene(json!({ "themeId": theme_id, "location": if theme_id == "forest" { "Лес" } else { "Тракт" }, "seed": seed, "width": 28, "height": 24 }));
        assert_eq!(map.generator.version, "4");
        let entrance = map.spawn_points.iter().find(|point| point.id == "party-entrance").expect("вход");
        assert!(tm::cell_passable(&map, entrance.x, entrance.y), "вход проходим");
        let mut seen: HashSet<(i64, i64)> = HashSet::from([(entrance.x, entrance.y)]);
        let mut queue = vec![(entrance.x, entrance.y)];
        let mut index = 0;
        while index < queue.len() {
            let (x, y) = queue[index];
            index += 1;
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let next = (x + dx, y + dy);
                if seen.contains(&next) || !tm::cell_passable(&map, next.0, next.1) {
                    continue;
                }
                seen.insert(next);
                queue.push(next);
            }
        }
        let (mut passable, mut rock) = (0, 0);
        for cell in tm::cells(&map) {
            if cell.passable {
                passable += 1;
                assert!(seen.contains(&(cell.x, cell.y)), "клетка {},{} отрезана от входа", cell.x, cell.y);
            } else if cell.surface != "water" {
                rock += 1;
            }
        }
        assert!(rock > 0, "у участка есть каменная кромка");
        assert!(passable > rock, "кромка не съедает участок");
    }
}

#[test]
fn open_v4_relief_terraces_of_five_feet() {
    let mut high_ground = 0;
    for seed in ["relief-1", "relief-2", "relief-3", "relief-4"] {
        let map = scene(json!({ "themeId": "forest", "location": "Лес", "seed": seed, "width": 30, "height": 24 }));
        let entrance = map.spawn_points.iter().find(|point| point.id == "party-entrance").expect("вход");
        assert_eq!(tm::cell_at(&map, entrance.x, entrance.y).map(|cell| cell.elevation), Some(0), "вход ровный");
        let mut peak = 0;
        let mut levels = HashSet::new();
        for cell in tm::cells(&map).filter(|cell| cell.passable) {
            peak = peak.max(cell.elevation);
            levels.insert(cell.elevation);
            assert_eq!(cell.elevation % 5, 0, "высота {} в {},{} — не терраса", cell.elevation, cell.x, cell.y);
            for (dx, dy) in [(1, 0), (0, 1)] {
                if let Some(next) = tm::cell_at(&map, cell.x + dx, cell.y + dy).filter(|next| next.passable) {
                    assert!((cell.elevation - next.elevation).abs() <= 5, "перепад {},{}", cell.x, cell.y);
                }
            }
            if cell.surface == "water" {
                assert!(cell.elevation <= 0);
            }
        }
        assert!(levels.len() <= 4, "уровней {}", levels.len());
        if peak >= 5 {
            high_ground += 1;
        }
    }
    assert!(high_ground >= 3, "холмы обычно дают возвышенность от 5 футов");
}

#[test]
fn prison_cells_are_split_by_thin_walls_with_own_doors() {
    let mut checked = 0;
    for seed in ["prison-a", "prison-b", "prison-c", "prison-d"] {
        let map = scene(json!({ "themeId": "dungeon", "location": "Темница", "seed": seed, "width": 26, "height": 26 }));
        let Some(block) = map.zones.iter().find(|zone| zone.label == "Камеры") else { continue };
        let doors = map.doors.iter().filter(|door| door.id.starts_with("cell-door-")).count();
        if doors == 0 {
            continue;
        }
        checked += 1;
        let inner = tm::edge_list(&map)
            .into_iter()
            .filter(|edge| {
                let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
                edge.kind == EdgeKind::Wall
                    && tm::cell_at(&map, edge.x, edge.y).is_some_and(|cell| cell.zone == block.id)
                    && tm::cell_at(&map, nx, ny).is_some_and(|cell| cell.zone == block.id)
            })
            .count();
        assert!(inner >= doors * 2, "{seed}: перегородок {inner} на {doors} камер");
        let reached = reach(&map);
        for cell in tm::cells(&map).filter(|cell| cell.passable && cell.zone == block.id) {
            assert!(reached.contains(&(cell.x, cell.y)), "{seed}: клетка {},{} камер заперта", cell.x, cell.y);
        }
    }
    assert!(checked >= 2, "тюремный блок собран лишь на {checked} сидах");
}

#[test]
fn map_is_not_smaller_than_theme_minimum_and_bigger_request_is_kept() {
    let crypt = scene(json!({ "themeId": "crypt", "location": "Склеп", "seed": "min-size", "width": 15, "height": 11 }));
    assert!(crypt.width >= 26 && crypt.height >= 26, "склеп {}×{}", crypt.width, crypt.height);
    let house = scene(json!({ "themeId": "building", "location": "Хижина", "seed": "min-size", "width": 16, "height": 14 }));
    assert!(house.width >= 22 && house.height >= 20, "дом с двором {}×{}", house.width, house.height);
    let hall = scene(json!({ "themeId": "temple", "location": "Храм", "seed": "min-size", "width": 34, "height": 30 }));
    assert_eq!((hall.width, hall.height), (34, 30));
}

#[test]
fn altar_room_stands_on_a_five_foot_dais() {
    for seed in ["dais-a", "dais-b", "dais-c"] {
        let map = scene(json!({ "themeId": "temple", "location": "Храм", "seed": seed, "width": 30, "height": 30 }));
        let altar = map.zones.iter().find(|zone| zone.label == "Алтарная").expect("алтарная").id.clone();
        let raised: Vec<(i64, i64)> = tm::cells(&map).filter(|cell| cell.passable && cell.zone == altar && cell.elevation == 5).map(|cell| (cell.x, cell.y)).collect();
        assert!(raised.len() >= 6, "{seed}: помост из {} клеток", raised.len());
        let (mut ledges, mut steps) = (0, 0);
        for (x, y) in &raised {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let Some(near) = tm::cell_at(&map, x + dx, y + dy) else { continue };
                if !near.passable || near.zone != altar || near.elevation == 5 {
                    continue;
                }
                if tm::edge_between(&map, *x, *y, x + dx, y + dy).ok().flatten().is_some_and(|edge| edge.kind == EdgeKind::Ledge) {
                    ledges += 1;
                } else {
                    steps += 1;
                }
            }
        }
        assert!(ledges > 0 && steps > 0, "{seed}: уступов {ledges}, ступеней {steps}");
        let reached = reach(&map);
        assert!(raised.iter().all(|cell| reached.contains(cell)), "{seed}: на помост не подняться");
    }
}

#[test]
fn deepest_dungeon_room_gets_second_entrance_under_the_same_key() {
    let mut second = 0;
    for seed in ["a", "b", "c", "d", "e", "f", "g", "h"] {
        let map = scene(json!({ "themeId": "dungeon", "location": "Темница", "seed": seed, "width": 30, "height": 30 }));
        let zones_of = |door: &tm::TacticalDoor| {
            let (nx, ny) = tm::edge_neighbor(door.x, door.y, door.dir);
            [zone_at(&map, door.x as f64, door.y as f64), zone_at(&map, nx as f64, ny as f64)]
        };
        let doors: Vec<_> = map.doors.iter().filter(|door| door.id.starts_with("second-entrance-")).collect();
        if doors.is_empty() {
            continue;
        }
        second += 1;
        for door in doors {
            let zones = zones_of(door);
            let goal = map
                .doors
                .iter()
                .find(|other| other.id != door.id && other.state == "locked" && other.key_item_id.is_some() && zones_of(other).iter().any(|zone| zones.contains(zone)));
            if let Some(goal) = goal {
                if door.state == "locked" {
                    assert_eq!(door.key_item_id, goal.key_item_id, "{seed}: второй вход в цель под чужой ключ");
                }
            }
        }
    }
    assert!(second >= 2, "второй вход появился лишь на {second} сидах из 8");
}

// --- test/map-quality.test.mjs: темы через конвейер ---------------------------------------

#[test]
fn reference_scenes_pass_quality_check_in_three_sizes() {
    let maps = pipeline_maps("mq/preset/");
    assert!(maps.len() >= 14 * 12, "сцен {}", maps.len());
    for (label, map) in maps {
        let report = audit_tactical_map(&map);
        assert!(report.problems.is_empty(), "{label}: {:?}", report.problems);
        assert!(report.warnings.is_empty(), "{label}: {:?}", report.warnings);
    }
}

#[test]
fn nature_scenes_meet_dnd_standards() {
    // `NATURE_TARGETS`: трудная местность, % клеток; укрытие сбоку, %.
    for (id, (low, high), cover) in [("forest", (10, 20), 25), ("swamp", (10, 20), 20), ("road", (5, 12), 20), ("ruins", (5, 12), 20)] {
        let maps = pipeline_maps(&format!("mq/preset/{id}/"));
        assert_eq!(maps.len(), 12, "{id}: сцен {}", maps.len());
        for (label, map) in maps {
            let stats = audit_tactical_map(&map).stats;
            let stat = |key: &str| stats.get(key).unwrap_or_else(|| panic!("{label}: нет {key}"));
            assert_eq!(map.generator.version, "4", "{label}");
            if stat("cells") >= 150 {
                assert!(stat("difficult_pct") >= low && stat("difficult_pct") <= high, "{label}: трудной местности {}%", stat("difficult_pct"));
                assert!(stat("cover_side_pct") >= cover, "{label}: укрытие сбоку у {}%", stat("cover_side_pct"));
            }
            assert!((1..=4).contains(&stat("elevation_levels")), "{label}: уровней высоты {}", stat("elevation_levels"));
            assert!(stat("smallest_plateau") == 0 || stat("smallest_plateau") >= 6, "{label}: площадка в {} кл.", stat("smallest_plateau"));
            assert_eq!(stat("climb_cells"), 0, "{label}: клетки только лазанием");
            let (ex, ey) = party(&map);
            for dy in -2..=2 {
                for dx in -2..=2 {
                    assert_eq!(tm::cell_at(&map, ex + dx, ey + dy).map_or(1, |cell| cell.move_cost), 1, "{label}: трудная клетка у входа");
                }
            }
            for cell in tm::cells(&map).filter(|cell| cell.zone == "crossing") {
                assert_eq!(cell.move_cost, 1, "{label}: трудный мост {},{}", cell.x, cell.y);
            }
        }
    }
}

#[test]
fn nature_relief_is_terraced() {
    let mut raised = 0;
    for (label, map) in pipeline_maps("mq/terrace/") {
        if audit_tactical_map(&map).stats.get("elevation_levels").unwrap_or(0) >= 2 {
            raised += 1;
        }
        for cell in tm::cells(&map).filter(|cell| cell.passable && cell.surface != "water") {
            assert_eq!(cell.elevation % 5, 0, "{label}: высота {} в {},{}", cell.elevation, cell.x, cell.y);
            for (dx, dy) in [(1, 0), (0, 1), (1, 1), (1, -1)] {
                if let Some(next) = tm::cell_at(&map, cell.x + dx, cell.y + dy).filter(|next| next.passable && next.surface != "water") {
                    assert!((next.elevation - cell.elevation).abs() <= 5, "{label}: обрыв {},{}", cell.x, cell.y);
                }
            }
        }
    }
    assert!(raised >= 6, "возвышенность только на {raised} картах из 8");
}

/// Группы стен развалин: грани, чьи клетки соседствуют (и по диагонали).
fn wall_fragments(map: &TacticalMap) -> Vec<(f64, f64)> {
    let walls: Vec<((i64, i64), (i64, i64))> = tm::edge_list(map).into_iter().filter(|edge| edge.kind == EdgeKind::Wall).map(|edge| ((edge.x, edge.y), tm::edge_neighbor(edge.x, edge.y, edge.dir))).collect();
    let near = |left: &((i64, i64), (i64, i64)), right: &((i64, i64), (i64, i64))| {
        [left.0, left.1].iter().any(|p| [right.0, right.1].iter().any(|q| (p.0 - q.0).abs().max((p.1 - q.1).abs()) <= 1))
    };
    let mut seen = vec![false; walls.len()];
    let mut groups = Vec::new();
    for start in 0..walls.len() {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut group = vec![start];
        let mut cursor = 0;
        while cursor < group.len() {
            for other in 0..walls.len() {
                if !seen[other] && near(&walls[group[cursor]], &walls[other]) {
                    seen[other] = true;
                    group.push(other);
                }
            }
            cursor += 1;
        }
        let cells: Vec<(i64, i64)> = group.iter().flat_map(|index| [walls[*index].0, walls[*index].1]).collect();
        let n = cells.len() as f64;
        groups.push((cells.iter().map(|cell| cell.0 as f64).sum::<f64>() / n, cells.iter().map(|cell| cell.1 as f64).sum::<f64>() / n));
    }
    groups
}

#[test]
fn roadside_ruins_are_wall_fragments_rubble_and_a_gate() {
    let maps = pipeline_maps("mq/ruins/");
    assert_eq!(maps.len(), 8);
    for (label, map) in maps {
        let fragments = wall_fragments(&map);
        assert!(fragments.len() >= 3, "{label}: фрагментов стен {}", fragments.len());
        let spread = |values: Vec<f64>| values.iter().cloned().fold(f64::MIN, f64::max) - values.iter().cloned().fold(f64::MAX, f64::min);
        let spread_x = spread(fragments.iter().map(|entry| entry.0).collect());
        let spread_y = spread(fragments.iter().map(|entry| entry.1).collect());
        assert!(spread_x >= map.width as f64 / 3.0 || spread_y >= map.height as f64 / 3.0, "{label}: фрагменты в одном углу");
        let rubble = tm::cells(&map).filter(|cell| cell.surface == "rubble").count();
        assert!(rubble >= 6, "{label}: обломков {rubble}");
        assert_eq!(map.props.iter().filter(|prop| prop.id.starts_with("ruins-gate-pillar-")).count(), 2, "{label}: нет остатков ворот");
    }
}

#[test]
fn village_houses_have_rooms_windows_and_furniture() {
    let building_id = sk_core::re!(r"^building-\d+$", "u");
    for (label, map) in pipeline_maps("mq/village/") {
        let houses: Vec<_> = map.zones.iter().filter(|zone| sk_core::text::test(building_id, &zone.id)).collect();
        assert!(houses.len() >= 3);
        assert!(map.zones.iter().any(|zone| zone.id.ends_with("-back")), "{label}: ни один дом не поделён на комнаты");
        assert!(tm::edge_list(&map).iter().any(|edge| edge.kind == EdgeKind::Window), "{label}: в деревне нет окон");
        for house in houses {
            let props = map.props.iter().filter(|prop| zone_at(&map, prop.x, prop.y).starts_with(&house.id)).count();
            assert!(props >= 2, "{label}/{}: пустой дом", house.id);
        }
        assert!(map.zones.iter().filter(|zone| sk_core::text::test(building_id, &zone.id)).count() >= 8, "{label}: в деревне мало дворов");
    }
}

#[test]
fn temple_nave_has_colonnade_and_altar_only_in_altar_room() {
    for (label, map) in pipeline_maps("mq/temple/") {
        let zone_label = |prop: &tm::TacticalProp| {
            let zone = zone_at(&map, prop.x, prop.y);
            map.zones.iter().find(|entry| entry.id == zone).map(|entry| entry.label.clone()).unwrap_or_default()
        };
        let altars: Vec<String> = map.props.iter().filter(|prop| prop.asset_id == "altar").map(zone_label).collect();
        assert!(!altars.is_empty() && altars.iter().all(|label| label == "Алтарная"), "{label}: алтари в {altars:?}");
        let suffix = sk_core::re!(r"-\d+$", "u");
        let mut colonnades: HashMap<String, Vec<&tm::TacticalProp>> = HashMap::new();
        for prop in map.props.iter().filter(|prop| prop.id.starts_with("colonnade-")) {
            colonnades.entry(sk_core::text::replace_first(suffix, &prop.id, "")).or_default().push(prop);
        }
        for (hall, colonnade) in colonnades {
            let lines: HashSet<i64> = colonnade.iter().map(|prop| prop.x.floor() as i64).collect();
            let rows: HashSet<i64> = colonnade.iter().map(|prop| prop.y.floor() as i64).collect();
            assert!(lines.len().min(rows.len()) <= 4, "{label}/{hall}: колонны не рядами");
        }
        assert!(count(&map, "statue") <= 5, "{label}: статуй больше пяти");
    }
}

#[test]
fn village_mixes_tavern_shop_and_barn_with_hay() {
    let building_id = sk_core::re!(r"^building-\d+$", "u");
    let mut barns = 0;
    for (label, map) in pipeline_maps("mq/mix/") {
        let names = labels(&map);
        assert!(names.iter().any(|name| ["Таверна", "Постоялый", "Питейный", "Гостевой"].iter().any(|word| name.contains(word))), "{label}: в деревне нет таверны: {names:?}");
        assert!(names.iter().any(|name| ["Лавка", "Склад", "Торговый", "Мастерская"].iter().any(|word| name.contains(word))), "{label}: в деревне нет лавки");
        let suffix = sk_core::re!(r"-(?:back|side)$", "u");
        for zone in map.zones.iter().filter(|zone| sk_core::text::test(building_id, &zone.id) && ["Амбар", "Конюшня", "Скотный", "Сарай"].iter().any(|word| zone.label.contains(word))) {
            barns += 1;
            let inside: Vec<&str> = map.props.iter().filter(|prop| sk_core::text::replace_first(suffix, &zone_at(&map, prop.x, prop.y), "") == zone.id).map(|prop| prop.asset_id.as_str()).collect();
            assert!(inside.contains(&"haystack"), "{label}: в амбаре нет сена");
        }
    }
    assert!(barns > 0, "ни в одной деревне нет амбара");
}

#[test]
fn places_are_recognized_by_main_word_and_built_for_purpose() {
    let place = |location: &str| pipeline_map(&format!("mq/place/{location}"));
    let smithy = place("Кузница Борга");
    assert_eq!(smithy.generator.id, "building-with-yard", "кузница — здание, а не лес");
    assert!(labels(&smithy).contains(&"Кузня") && assets(&smithy).contains("forge") && assets(&smithy).contains("anvil"), "в кузне нет горна и наковальни");
    let barracks = place("Казарма городской стражи");
    assert_eq!(barracks.generator.id, "building-with-yard", "«городской» не делает казарму городом");
    assert!(labels(&barracks).contains(&"Спальня стражи") && assets(&barracks).contains("bunk_bed"));
    assert!(count(&place("Кладбище за часовней"), "grave") >= 6, "на кладбище нет рядов могил");
    assert!(labels(&place("Подземелье под замком")).contains(&"Караульная"), "подземелье — не пещера");
    assert_eq!(place("Хутор у леса").generator.id, "settlement-layout", "хутор у леса — поселение, а не лес");
    assert!(assets(&place("Логово дракона")).contains("coin_pile"), "у дракона нет золота");
    let camp = place("Лагерь бандитов");
    assert!(assets(&camp).contains("campfire") && assets(&camp).contains("crate"), "в лагере нет костра и добычи");
    assert!(count(&camp, "campfire") <= 2, "костров больше двух");
    assert!(count(&place("Лесная поляна"), "campfire") <= 1, "в лесу больше одного костра");
}

#[test]
fn bridge_over_chasm_is_a_gap_and_over_river_is_water() {
    let chasm = pipeline_map("mq/place/Мост через ущелье");
    let missing = (2..chasm.height - 2).flat_map(|y| (2..chasm.width - 2).map(move |x| (x, y))).filter(|(x, y)| tm::cell_at(&chasm, *x, *y).is_none()).count();
    assert!(missing > 20, "пропасти нет");
    assert!(labels(&chasm).contains(&"Мост"));
    let ford = pipeline_map("mq/place/Тракт у старого моста");
    assert!(labels(&ford).contains(&"Река") && labels(&ford).contains(&"Мост"), "у моста нет реки");
    assert!(labels(&pipeline_map("mq/place/Пустынный оазис")).contains(&"Пруд"), "в оазисе нет воды");
}

#[test]
fn town_has_twelve_houses_and_a_square_with_water_and_stalls() {
    let building_id = sk_core::re!(r"^building-\d+$", "u");
    for (label, map) in pipeline_maps("mq/town/") {
        assert!(map.width >= 48 && map.height >= 44, "{label}: город тесный — {}×{}", map.width, map.height);
        assert!(map.zones.iter().filter(|zone| sk_core::text::test(building_id, &zone.id)).count() >= 12, "{label}: мало домов");
        assert!(map.zones.iter().any(|zone| zone.id == "square" && zone.label == "Торговая площадь"));
        let square: Vec<&str> = map.props.iter().filter(|prop| zone_at(&map, prop.x, prop.y) == "square").map(|prop| prop.asset_id.as_str()).collect();
        assert!((square.contains(&"fountain") || square.contains(&"well")) && square.contains(&"market_stall"), "{label}: на площади нет воды и прилавков");
    }
    let farm = pipeline_map("mq/farm");
    assert!(farm.zones.iter().filter(|zone| sk_core::text::test(building_id, &zone.id)).count() <= 6, "хутор застроен как деревня");
}

#[test]
fn dungeon_and_crypt_get_loops_and_locked_second_entrance_shares_the_key() {
    for (location, minimum) in [("Подземелье под замком", 10), ("Фамильный склеп", 5)] {
        let mut looped = 0;
        let maps = pipeline_maps(&format!("mq/loops/{location}/"));
        assert_eq!(maps.len(), 16);
        for (label, map) in maps {
            let report = audit_tactical_map(&map);
            assert!(report.problems.is_empty(), "{label}: {:?}", report.problems);
            if report.stats.get("loops").unwrap_or(0) > 0 {
                looped += 1;
            }
            let keys: HashSet<Option<String>> = map.doors.iter().filter(|door| door.state == "locked").map(|door| door.key_item_id.clone()).collect();
            assert!(keys.len() <= 1, "{label}: замки под разные ключи {keys:?}");
            for door in map.doors.iter().filter(|door| door.id.starts_with("loop-door-") && door.state == "locked") {
                assert!(door.key_item_id.as_deref().is_some_and(|key| !key.is_empty()), "{label}: запертая петля без ключа");
            }
        }
        assert!(looped >= minimum, "{location}: петли только у {looped} карт из 16");
    }
}

#[test]
fn map_without_rooms_and_doors_has_no_loops() {
    for (label, map) in pipeline_maps("mq/empty-graph/") {
        let stats = audit_tactical_map(&map).stats;
        assert_eq!(stats.get("rooms"), Some(0), "{label}");
        assert_eq!(stats.get("loops"), Some(0), "{label}");
    }
}

// --- test/scene-dressing.test.mjs: обстановка в сцене темы --------------------------------

fn vignettes_on(map: &TacticalMap) -> Vec<String> {
    let pattern = sk_core::re!(r"^vignette-(.*)-\d+-\d+$", "u");
    let mut found: Vec<String> = Vec::new();
    for prop in map.props.iter().filter(|prop| prop.id.starts_with("vignette-")) {
        let id = sk_core::text::replace_first(pattern, &prop.id, "$1");
        if !found.contains(&id) {
            found.push(id);
        }
    }
    found
}

fn rough_count(map: &TacticalMap, zone: Option<&str>) -> usize {
    tm::cells(map).filter(|cell| cell.move_cost > 1 && zone.is_none_or(|zone| cell.zone == zone)).count()
}

fn ruins_on(map: &TacticalMap) -> usize {
    map.props.iter().filter(|prop| prop.id.starts_with("ruins-")).filter_map(|prop| prop.id.split('-').nth(1).map(str::to_string)).collect::<HashSet<_>>().len()
}

#[test]
fn tavern_remembers_a_brawl_only_when_told() {
    let tavern = json!({ "width": 36, "height": 30, "location": "Трактир трёх дорог", "theme": "таверна", "design": { "building_use": "tavern", "architecture": "wood" } });
    for seed in ["brawl-a", "brawl-b"] {
        let told = scene(sk_core::js::spread(&tavern, json!({ "seed": seed, "description": "После вчерашней драки трактирщик ещё не прибрался." })));
        let brawl: Vec<_> = told.props.iter().filter(|prop| prop.id.starts_with("vignette-after-brawl")).collect();
        assert!(brawl.len() >= 3, "{seed}: от драки осталось {}", brawl.len());
        assert!(brawl.iter().all(|prop| zone_at(&told, prop.x, prop.y) == "hall"), "драка — в общем зале");
        assert!(brawl.iter().any(|prop| prop.state == "toppled"), "стулья опрокинуты");
        assert!(problems(&told).is_empty(), "{seed}: {:?}", problems(&told));
        let silent = scene(sk_core::js::spread(&tavern, json!({ "seed": seed })));
        assert!(vignettes_on(&silent).is_empty(), "{seed}: драки без слов нет");
    }
}

#[test]
fn temple_benches_are_low_furniture_and_abandoned_temple_has_rubble() {
    let temple = json!({ "width": 36, "height": 30, "location": "Храм Утренней звезды", "theme": "храм", "design": {} });
    for seed in ["temple-a", "temple-b"] {
        let map = scene(sk_core::js::spread(&temple, json!({ "seed": seed })));
        let low: Vec<_> = map.props.iter().filter(|prop| ["prayer_bench", "kneeling_cushions"].contains(&prop.asset_id.as_str())).collect();
        assert!(!low.is_empty(), "{seed}: в храме нет скамей");
        for prop in low {
            for point in &prop.footprint {
                assert_eq!(tm::cell_at(&map, point.x, point.y).map(|cell| cell.move_cost), Some(2), "{seed}: {} не дорожает", prop.id);
            }
        }
        let ruined = scene(sk_core::js::spread(&temple, json!({ "seed": seed, "description": "Заброшенный храм, свод местами обвалился." })));
        assert!(tm::cells(&ruined).filter(|cell| cell.surface == "rubble").count() >= 6, "{seed}: мало обвалов");
        let spawn = &ruined.spawn_points[0];
        assert!(!tm::reachable_cells(&ruined, spawn.x, spawn.y, true, None).is_empty());
    }
}

#[test]
fn village_mud_in_yards_not_on_street_and_ashes_when_named() {
    let village = json!({ "width": 44, "height": 38, "location": "Деревня Кленовка", "theme": "деревня", "design": { "topology": "organic", "architecture": "wood" } });
    for seed in ["village-a", "village-b"] {
        let map = scene(sk_core::js::spread(&village, json!({ "seed": seed })));
        assert!(rough_count(&map, Some("common")) >= 6, "{seed}: грязи во дворах {}", rough_count(&map, Some("common")));
        assert_eq!(rough_count(&map, Some("street")), 0, "улица остаётся лёгкой");
        assert_eq!(rough_count(&map, Some("square")), 0, "площадь остаётся лёгкой");
        let burned = scene(sk_core::js::spread(&village, json!({ "seed": seed, "description": "На краю деревни — пепелище сгоревшего двора." })));
        assert!(ruins_on(&burned) >= 1, "{seed}: пепелище названо, а остова нет");
    }
    let winter = scene(sk_core::js::spread(&village, json!({ "seed": "village-a", "design": { "topology": "organic", "architecture": "wood", "climate": "cold" } })));
    assert!(winter.props.iter().any(|prop| prop.id.starts_with("rough-snow-")), "зимой во дворах — снег, а не грязь");
}

#[test]
fn wild_scenes_get_dressing_and_pass_map_check() {
    let ambient: HashSet<&str> = sk_props::scene_dressing::VIGNETTES.iter().flat_map(|(_, recipes)| recipes.iter()).filter(|recipe| recipe.ambient).map(|recipe| recipe.id).collect();
    // (место, тема, климат, описание, названные сцены, трудная местность, без событий, развалины)
    let scenes: [(&str, &str, Option<&str>, &str, &[&str], bool, bool, bool); 8] = [
        ("Поляна в Чернолесье", "лесная поляна", None, "", &[], true, true, false),
        ("Поляна в Чернолесье", "лесная поляна", None, "Остывшее кострище, вокруг волчьи следы.", &["abandoned-camp", "beast-lair"], true, false, false),
        ("Развалины старой заставы", "руины у дороги", None, "", &[], true, false, true),
        ("Старое кладбище", "кладбище", None, "", &[], true, false, false),
        ("Пещера контрабандистов", "пещера", None, "", &["smuggler-cache"], true, false, false),
        ("Фамильный склеп", "склеп", None, "Сектанты проводили здесь обряд.", &["ritual-site"], false, false, false),
        ("Снежный перевал", "зимний лес", Some("cold"), "Древние руины сторожевой башни.", &[], true, false, true),
        ("Красные барханы", "дорога через пустыню", Some("arid"), "", &[], true, false, false),
    ];
    for (location, theme, climate, description, named, rough, quiet, ruins) in scenes {
        for seed in ["dress-a", "dress-b"] {
            let design = climate.map_or(json!({}), |climate| json!({ "climate": climate }));
            let map = scene(json!({ "seed": seed, "width": 36, "height": 30, "location": location, "theme": theme, "design": design, "description": description }));
            let label = format!("{location}/{seed}");
            let placed = vignettes_on(&map);
            for id in named {
                assert!(placed.iter().any(|entry| entry == id), "{label}: названная сцена {id} не встала ({placed:?})");
            }
            if quiet {
                let events: Vec<_> = placed.iter().filter(|id| !ambient.contains(id.as_str())).collect();
                assert!(events.is_empty(), "{label}: событие без слов {events:?}");
            }
            if rough {
                assert!(rough_count(&map, None) >= 4, "{label}: трудных клеток {}", rough_count(&map, None));
            }
            if ruins {
                assert!(ruins_on(&map) >= 1, "{label}: развалины обещаны текстом");
            }
            assert!(problems(&map).is_empty(), "{label}: {:?}", problems(&map));
        }
    }
}

// --- замечено в JS: перенесено как есть ---------------------------------------------------

#[test]
fn prototype_keys_in_map_request_and_world_kind_behave_as_in_js() {
    // `byPattern['__proto__']` — объект прототипа: истинен, `??` до планировки
    // не доходит, и тема не находится даже при `layout: 'cavern'`. Ключ ищется
    // после `toLocaleLowerCase`, поэтому `toString` прототипом уже не будет.
    assert!(theme_from_map_request(&json!({ "pattern": "__proto__", "layout": "cavern" })).is_none());
    assert_eq!(theme_from_map_request(&json!({ "pattern": "toString", "layout": "cavern" })).map(|theme| theme.id), Some("cave"));
    assert!(theme_from_map_request(&json!({ "layout": "constructor" })).is_none());
    // `WORLD_KIND_THEMES['constructor']` истинно, `themeById` его не находит —
    // тема по умолчанию (здание), а не запасной путь по заявке.
    assert_eq!(resolve(json!({ "location": "Кальмар", "worldKind": "constructor" })), "building");
    assert_eq!(resolve(json!({ "location": "Кальмар", "worldKind": "landmark" })), "road");
    // `worldKind === 'fortress'` во дворе крепости сравнивается без приведения
    // регистра, а подземелье в крепости — с приведением.
    assert_eq!(resolve(json!({ "location": "Двор", "worldKind": "fortress" })), "settlement");
    assert_eq!(resolve(json!({ "location": "Двор", "worldKind": "FORTRESS" })), "building");
    assert_eq!(resolve(json!({ "location": "Кальмар", "worldKind": "FORTRESS", "sceneKind": "dungeon" })), "dungeon");
}

#[test]
fn null_inputs_fail_like_js() {
    let error = build_themed_scene(&Value::Null).expect_err("null");
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, "Cannot read properties of null (reading 'location')");
    let error = build_themed_scene(&json!({ "themeId": "road", "seed": "x", "design": null })).expect_err("design null");
    assert_eq!(error.message, "Cannot read properties of null (reading 'climate')");
    // Подземной теме `design` не нужен — и `null` ей не мешает.
    assert!(build_themed_scene(&json!({ "themeId": "cave", "seed": "x", "design": null })).is_ok());
}
