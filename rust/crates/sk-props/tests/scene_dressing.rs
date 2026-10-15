//! `server/scene-dressing.mjs` против эталона JS (`fixtures/scene-dressing.json`,
//! `fixtures/gen-scene-dressing.mjs`) и проверки `test/scene-dressing.test.mjs`
//! (сцены `buildThemedScene` и аудит карты `map-quality` проверяются корпусом
//! генераторов `corpus_scene_dressing.rs` через эталон JS).

mod common;

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use common::{array, map_hash, parse, restore, run_dressing};
use serde_json::{json, Value};
use sk_props::scene_dressing::{
    mark_low_furniture, place_ruins, place_ruins_field, place_vignettes, roughen_ground, vignettes, vignettes_named_by, RoughKind, RoughOptions,
    RuinsFieldOptions, RuinsOptions, VignetteOptions, VIGNETTES,
};
use sk_scene_base::asset_registry::asset_by_id;
use sk_tactical::tactical_map::{add_prop, cell_at, edge_list, reachable_cells, EdgeKind, TacticalMap};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/scene-dressing.json")));
static AUTHORED: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../../../../data/authored-location-maps-v1.json")));

#[test]
fn vignette_sets_follow_js_order() {
    let sets: Vec<&str> = array(&FIXTURE["sets"]).iter().filter_map(Value::as_str).collect();
    assert_eq!(sets, VIGNETTES.iter().map(|(name, _)| *name).collect::<Vec<_>>());
}

#[test]
fn named_vignettes_match_js() {
    let rows = array(&FIXTURE["named"]);
    for row in rows {
        let (set, text) = (row[0].as_str().unwrap_or_default(), row[1].as_str().unwrap_or_default());
        assert_eq!(json!(vignettes_named_by(set, text)), row[2], "vignettesNamedBy({set:?}, {text:?})");
    }
    assert!(rows.len() > 500);
}

fn input_map(input: &Value, outputs: &[TacticalMap]) -> TacticalMap {
    if let Some(index) = input.get("map").and_then(Value::as_u64) {
        return restore(&FIXTURE["maps"][index as usize]);
    }
    if let Some(index) = input.get("authored").and_then(Value::as_u64) {
        return restore(&AUTHORED["maps"][index as usize]);
    }
    outputs[input["from"].as_u64().expect("вход случая") as usize].clone()
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
        let result = run_dressing(&mut map, op, &case["args"]);
        let context = format!("случай {index} ({op}, {})", case["args"]);
        if result != case["result"] {
            mismatches.push(format!("{context}: ответ {result} вместо {}", case["result"]));
        }
        if map_hash(&map) != case["hash"].as_str().unwrap_or_default() {
            mismatches.push(format!("{context}: карта расходится (предметов {} против {})", map.props.len(), case["props"]));
        }
        outputs.push(map);
    }
    assert!(mismatches.is_empty(), "расхождений {} из {}:\n{}", mismatches.len(), cases.len(), mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    for op in ["placeVignettes", "roughenGround", "markLowFurniture", "placeRuins", "placeRuinsField"] {
        assert!(ops.get(op).copied().unwrap_or(0) > 300, "операция {op} покрыта слабо: {:?}", ops.get(op));
    }
}

// --- сценарии переносимых тестов JS ------------------------------------------------------

fn scenario(name: &str) -> TacticalMap {
    restore(&FIXTURE["maps"][FIXTURE["scenarios"][name].as_u64().expect("сценарий") as usize])
}

fn reachable_count(map: &TacticalMap) -> usize {
    reachable_cells(map, 1, 9, true, None).len()
}

fn passable_count(map: &TacticalMap) -> usize {
    (0..map.height).flat_map(|y| (0..map.width).map(move |x| (x, y))).filter(|(x, y)| cell_at(map, *x, *y).is_some_and(|cell| cell.passable)).count()
}

#[test]
fn recipes_use_registry_and_events_have_words() {
    for (set, recipes) in VIGNETTES.iter() {
        for recipe in *recipes {
            assert!(recipe.ambient || recipe.cue.is_some(), "{set}/{}: ни слов, ни тихой приметы", recipe.id);
            for part in recipe.parts {
                let Some(asset) = asset_by_id(part.asset) else { panic!("{set}/{}: {} нет в реестре", recipe.id, part.asset) };
                if part.state.is_some() {
                    assert!(!asset.interactive, "{set}/{}: {} интерактивен, а стоит «{:?}»", recipe.id, part.asset, part.state);
                }
            }
        }
        let ids: HashSet<&str> = recipes.iter().map(|recipe| recipe.id).collect();
        assert_eq!(ids.len(), recipes.len(), "{set}: повтор виньетки");
    }
    let mut both = vignettes_named_by("wild", "Остывшее кострище, а вокруг волчьи следы");
    both.sort_unstable();
    assert_eq!(both, ["abandoned-camp", "beast-lair"]);
    assert_eq!(vignettes_named_by("wild", "Обломки стен и следы чужого привала"), ["abandoned-camp"]);
    assert_eq!(vignettes_named_by("tavern", "После вчерашней драки"), ["after-brawl"]);
    assert!(vignettes_named_by("wild", "Тихая поляна").is_empty());
    assert!(vignettes("constructor").is_empty());
}

#[test]
fn events_need_words_and_ambient_does_not() {
    let zones = vec!["field".to_string()];
    let mut silent = scenario("field");
    let placed = place_vignettes(&mut silent, &VignetteOptions { seed: "v1", set: "wild", zones: Some(&zones), limit: 2, ..VignetteOptions::default() });
    for id in &placed {
        assert!(vignettes("wild").iter().any(|recipe| recipe.id == *id && recipe.ambient), "без слов встало событие {id}");
    }
    let told_options = VignetteOptions { seed: "v1", set: "wild", zones: Some(&zones), limit: 0, text: "У обочины опрокинута телега, рядом кострище", hug_walls: false };
    let mut told = scenario("field");
    let mut placed = place_vignettes(&mut told, &told_options);
    placed.sort_unstable();
    assert_eq!(placed, ["abandoned-camp", "cart-wreck"], "названное встаёт сверх предела");
    for prop in told.props.iter().filter(|prop| prop.id.starts_with("vignette-")) {
        let cells: Vec<(i64, i64)> =
            if prop.footprint.is_empty() { vec![(prop.x.floor() as i64, prop.y.floor() as i64)] } else { prop.footprint.iter().map(|cell| (cell.x, cell.y)).collect() };
        for (x, y) in cells {
            let Some(cell) = cell_at(&told, x, y) else { panic!("{}: вне карты", prop.id) };
            assert!(cell.passable && cell.surface != "water", "{}: на воде или скале", prop.id);
            assert_ne!(cell.material, "earth", "{}: на дороге", prop.id);
            assert!((x - 1).abs() > 3 || (y - 9).abs() > 3, "{}: у входа", prop.id);
        }
    }
    let mut again = scenario("field");
    place_vignettes(&mut again, &told_options);
    assert_eq!(again.props, told.props, "тот же сид и текст — та же обстановка");
}

#[test]
fn undergrowth_is_patchy_and_keeps_roads_and_entrance() {
    let zones = vec!["field".to_string()];
    let mut map = scenario("field");
    let changed = roughen_ground(&mut map, &RoughOptions { seed: "r1", kind: RoughKind::Undergrowth, zones: Some(&zones), patches: 3 });
    assert!(changed >= 9, "трудных клеток {changed}");
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = cell_at(&map, x, y) else { continue };
            if cell.move_cost <= 1 {
                continue;
            }
            assert!(cell.passable, "трудная клетка остаётся проходимой");
            assert_ne!(cell.material, "earth", "дорога не дорожает");
            assert!((x - 1).abs() > 4 || (y - 9).abs() > 4, "у входа шаг не дорожает");
        }
    }
    assert!(map.props.iter().any(|prop| prop.id.starts_with("rough-undergrowth-")), "подлесок отмечен папоротником и листвой");
    assert_eq!(reachable_count(&map), passable_count(&map), "досягаемость не меняется");
}

#[test]
fn rubble_and_mud_change_surface_and_low_furniture_costs_more() {
    let zones = vec!["field".to_string()];
    for (kind, seed, surface) in [(RoughKind::Rubble, "r2", "rubble"), (RoughKind::Mud, "r3", "mud")] {
        let mut map = scenario("field");
        roughen_ground(&mut map, &RoughOptions { seed, kind, zones: Some(&zones), patches: 2 });
        let cells: Vec<u8> = (0..map.height)
            .flat_map(|y| (0..map.width).map(move |x| (x, y)))
            .filter_map(|(x, y)| cell_at(&map, x, y))
            .filter(|cell| cell.surface == surface)
            .map(|cell| cell.move_cost)
            .collect();
        assert!(cells.len() >= 6, "{surface}: клеток {}", cells.len());
        assert!(cells.iter().all(|cost| *cost == 2));
    }
    let mut hall = scenario("field");
    let bench = json!({ "id": "bench", "assetId": "prayer_bench", "x": 12, "y": 13.5, "footprint": [{ "x": 11, "y": 13 }, { "x": 12, "y": 13 }] });
    let crate_prop = json!({ "id": "crate", "assetId": "crate", "x": 15.5, "y": 13.5, "footprint": [{ "x": 15, "y": 13 }], "blocksMove": true });
    assert!(add_prop(&mut hall, &bench).is_ok() && add_prop(&mut hall, &crate_prop).is_ok());
    assert_eq!(mark_low_furniture(&mut hall, &["prayer_bench", "crate"]), 2, "дорожают две клетки скамьи, а не ящик");
    assert_eq!(cell_at(&hall, 11, 13).map(|cell| cell.move_cost), Some(2));
    assert_eq!(cell_at(&hall, 15, 13).map(|cell| cell.move_cost), Some(1));
}

#[test]
fn ruins_of_three_shapes_are_enterable() {
    for shape in ["house", "tower", "wall"] {
        let mut map = scenario("wide");
        let seed = format!("ruins-{shape}");
        let Some(ruins) = place_ruins(&mut map, &RuinsOptions { seed: &seed, shape: Some(shape), ..RuinsOptions::default() }) else {
            panic!("{shape}: на просторном поле встаёт")
        };
        assert_eq!(ruins.shape, shape);
        let walls = edge_list(&map).into_iter().filter(|edge| edge.kind == EdgeKind::Wall).count() as i64;
        let length = if shape == "wall" { ruins.width.max(ruins.height) } else { 2 * (ruins.width + ruins.height) };
        assert!(walls >= 4 && walls <= length - 2, "{shape}: стен {walls} из {length}");
        assert_eq!(reachable_count(&map), passable_count(&map), "{shape}: каждая клетка досягаема");
        assert_eq!(cell_at(&map, ruins.x, ruins.y).map(|cell| cell.zone), Some("field"), "{shape}: зона наружная");
    }
    let mut wide = scenario("large");
    assert!(place_ruins_field(&mut wide, &RuinsFieldOptions { seed: "field-1", asked: true, ..RuinsFieldOptions::default() }) >= 1);
    assert_eq!(reachable_count(&wide), passable_count(&wide));
    let mut quiet = scenario("field");
    assert_eq!(place_ruins_field(&mut quiet, &RuinsFieldOptions { seed: "field-2", asked: false, chance: 0.0, ..RuinsFieldOptions::default() }), 0);
}
