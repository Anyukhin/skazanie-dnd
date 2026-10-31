//! Сверка `combat_bounds` с эталоном JS (`fixtures/combat-bounds.json`,
//! генератор `fixtures/gen-combat-bounds.mjs`) и перенос проверок модуля из
//! `test/combat-bounds.test.mjs`.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, hash, parse, stringify};
use serde_json::{json, Value};
use sk_tactical::combat_bounds as cb;
use sk_tactical::tactical_map::{self as t, Bounds, CellPatch, TacticalMap, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/combat-bounds.json")));

fn int(value: &Value) -> i64 {
    value.as_i64().expect("целое в эталоне")
}

fn margin(value: &Value) -> Option<i64> {
    arg(value).map(int)
}

fn bounds_json(bounds: Option<Bounds>) -> Value {
    bounds.map_or(Value::Null, |bounds| bounds.to_json())
}

fn bounds_from(value: &Value) -> Option<Bounds> {
    (!value.is_null()).then(|| Bounds { min_x: int(&value["minX"]), min_y: int(&value["minY"]), max_x: int(&value["maxX"]), max_y: int(&value["maxY"]) })
}

#[test]
fn pure_functions_match_js() {
    assert_eq!(FIXTURE["margin"], cb::COMBAT_BOUNDS_MARGIN_CELLS);
    for case in array(&FIXTURE["compute"]) {
        let participants = case["participants"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let points = cb::participant_points(participants);
        let result = cb::compute_combat_bounds_in(int(&case["width"]), int(&case["height"]), &points, margin(&case["margin"]));
        assert_same(&bounds_json(result), &case["result"], &stringify(case));
    }
    for case in array(&FIXTURE["expand"]) {
        let bounds = bounds_from(&case["bounds"]);
        let (x, y) = (int(&case["x"]), int(&case["y"]));
        assert_eq!(cb::combat_bounds_contain(bounds.as_ref(), x, y), case["contain"] == true, "{}", stringify(case));
        let result = cb::expand_combat_bounds_in(int(&case["width"]), int(&case["height"]), bounds.as_ref(), x, y, margin(&case["margin"]));
        assert_same(&result.to_json(), &case["result"], &stringify(case));
    }
    for case in array(&FIXTURE["useful"]) {
        assert_eq!(cb::combat_bounds_useful_in(int(&case[0]), int(&case[1])), case[2] == true, "{}", stringify(case));
    }
    let maps: Vec<TacticalMap> = array(&FIXTURE["maps"]).iter().map(|raw| t::deserialize_tactical_map(raw).expect("карта")).collect();
    for case in array(&FIXTURE["coverage"]) {
        let map = &maps[int(&case["map"]) as usize];
        let result = cb::combat_bounds_coverage(map, bounds_from(&case["bounds"]).as_ref());
        assert_same(&result.to_json(), &case["result"], &stringify(case));
    }
}

fn outcome(state: &mut Value, run: impl FnOnce(&mut Value) -> t::MapResult<()>) -> Value {
    match run(state) {
        Ok(()) => {
            let bounds = cb::scene_tactical_map(state).map_or(Value::String("нет карты".into()), |map| bounds_json(map.combat_bounds));
            json!({ "state": hash(state), "combatBounds": bounds })
        }
        Err(error) => json!({ "error": { "name": error.name, "code": error.code, "message": error.message } }),
    }
}

#[test]
fn engine_helpers_match_js() {
    let bases = array(&FIXTURE["baseStates"]);
    let mut grown = 0;
    for case in array(&FIXTURE["sync"]) {
        let mut state = bases[int(&case["base"]) as usize].clone();
        let ids: Vec<String> = array(&case["ids"]).iter().map(|id| id.as_str().unwrap().to_string()).collect();
        let actual = outcome(&mut state, |state| cb::sync_combat_bounds(state, &ids));
        let mut expected = case.clone();
        for key in ["base", "ids"] {
            expected.as_object_mut().unwrap().shift_remove(key);
        }
        assert_same(&actual, &expected, &format!("syncCombatBounds {}", stringify(case)));
    }
    for case in array(&FIXTURE["grow"]) {
        let base = &bases[int(&case["base"]) as usize];
        let mut state = base.clone();
        let actor = arg(&case["actorId"]).and_then(Value::as_str);
        let actual = outcome(&mut state, |state| cb::grow_combat_bounds(state, arg(&case["position"]), actor));
        let mut expected = case.clone();
        for key in ["base", "position", "actorId"] {
            expected.as_object_mut().unwrap().shift_remove(key);
        }
        assert_same(&actual, &expected, &format!("growCombatBounds {}", stringify(case)));
        grown += usize::from(cb::scene_tactical_map(&state).and_then(|map| map.combat_bounds) != cb::scene_tactical_map(base).and_then(|map| map.combat_bounds));
    }
    assert!(grown > 20, "подрайон раздвинулся {grown} раз");
}

fn region() -> TacticalMap {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    t::create_tactical_map(&TacticalMapOptions { width: 100, height: 100, size_class: "region", fill: Some(fill), ..TacticalMapOptions::default() }).unwrap()
}

#[test]
fn bounds_surround_participants_with_margin() {
    let map = region();
    let bounds = cb::compute_combat_bounds(&map, &[json!({ "x": 50, "y": 50 }), json!({ "x": 56, "y": 54 })], None).unwrap();
    let margin = cb::COMBAT_BOUNDS_MARGIN_CELLS;
    assert_eq!(bounds, Bounds { min_x: 50 - margin, min_y: 50 - margin, max_x: 56 + margin, max_y: 54 + margin });
    assert!(bounds.max_x - bounds.min_x >= 24);
    assert_eq!(cb::compute_combat_bounds(&map, &[json!({ "x": 1, "y": 1 })], None).unwrap(), Bounds { min_x: 0, min_y: 0, max_x: 13, max_y: 13 });
    let far = cb::compute_combat_bounds(&map, &[json!({ "x": 99, "y": 99 })], None).unwrap();
    assert_eq!((far.max_x, far.max_y), (99, 99));
    assert_eq!(cb::compute_combat_bounds(&map, &[], None), None);
    assert!(cb::combat_bounds_contain(None, 5, 5), "без подрайона ограничений нет");
}

#[test]
fn leaving_bounds_expands_them() {
    let map = region();
    let bounds = cb::compute_combat_bounds(&map, &[json!({ "x": 50, "y": 50 })], None).unwrap();
    assert!(!cb::combat_bounds_contain(Some(&bounds), 70, 50));
    let wider = cb::expand_combat_bounds(&map, Some(&bounds), 70, 50, None);
    assert!(cb::combat_bounds_contain(Some(&wider), 70, 50));
    assert!(wider.max_x > bounds.max_x);
    assert_eq!(wider.min_x, bounds.min_x);
    assert!(cb::combat_bounds_contain(Some(&cb::expand_combat_bounds(&map, Some(&wider), 99, 99, None)), 99, 99));
    assert_eq!(cb::expand_combat_bounds(&map, Some(&bounds), 52, 51, None), bounds, "точка внутри подрайона его не меняет");
}

#[test]
fn bounds_survive_serialization_and_coverage_sees_walls() {
    let mut map = region();
    cb::apply_combat_bounds(&mut map, &[json!({ "x": 40, "y": 40 }), json!({ "x": 44, "y": 42 })], None);
    assert!(map.combat_bounds.is_some());
    let restored = t::deserialize_tactical_map(&t::serialize_tactical_map(&map).unwrap()).unwrap();
    assert_eq!(restored.combat_bounds, map.combat_bounds);
    let mut walled = region();
    for y in 30..=60 {
        t::set_cell(&mut walled, 45, y, &CellPatch { passable: Some(false), ..CellPatch::default() }).unwrap();
    }
    let bounds = cb::compute_combat_bounds(&walled, &[json!({ "x": 44, "y": 45 }), json!({ "x": 46, "y": 45 })], None);
    let coverage = cb::combat_bounds_coverage(&walled, bounds.as_ref());
    assert!(coverage.cells > 0 && coverage.passable < coverage.cells, "стена внутри подрайона обязана быть видна в охвате");
}

#[test]
fn bounds_are_pointless_on_small_maps() {
    let small = t::create_tactical_map(&TacticalMapOptions { width: 20, height: 20, ..TacticalMapOptions::default() }).unwrap();
    let large = t::create_tactical_map(&TacticalMapOptions { width: 60, height: 60, ..TacticalMapOptions::default() }).unwrap();
    assert!(!cb::combat_bounds_useful(&small));
    assert!(cb::combat_bounds_useful(&large));
    assert!(!cb::combat_bounds_useful_in(28, 1));
    assert!(cb::combat_bounds_useful_in(29, 1));
}

/// «Подрайон ставится при начале боя и раздвигается ходом за границу» — на
/// уровне помощников редьюсера.
#[test]
fn combat_start_sets_bounds_and_move_expands_them() {
    let fill = CellPatch { passable: Some(true), ..CellPatch::default() };
    let map = t::create_tactical_map(&TacticalMapOptions { width: 60, height: 60, fill: Some(fill), ..TacticalMapOptions::default() }).unwrap();
    let mut state = json!({
        "scene": { "title": "Сцена", "map": t::serialize_tactical_map(&map).unwrap() },
        "players": [{ "id": "hero", "x": 20, "y": 20, "hp": 10 }],
        "enemies": [{ "id": "wolf", "x": 24, "y": 22, "hp": 5, "alive": true }],
        "mechanics": { "positions": { "hero": { "x": 20, "y": 20 }, "wolf": { "x": 24, "y": 22 } }, "combat": { "active": true } },
    });
    assert_eq!(cb::scene_tactical_map(&state).unwrap().combat_bounds, None, "до боя подрайона нет");
    cb::sync_combat_bounds(&mut state, &["hero".into(), "wolf".into()]).unwrap();
    let bounds = cb::scene_tactical_map(&state).unwrap().combat_bounds.expect("начало боя обязано поставить подрайон");
    assert!(cb::combat_bounds_contain(Some(&bounds), 20, 20) && cb::combat_bounds_contain(Some(&bounds), 24, 22));
    assert_eq!(state["scene"]["cells"].as_array().map(Vec::len), Some(3_600), "производные клетки обязаны пересобраться");
    let outside = json!({ "x": (bounds.max_x + 5).min(59), "y": 20 });
    state["mechanics"]["positions"]["hero"] = outside.clone();
    cb::grow_combat_bounds(&mut state, Some(&outside), Some("hero")).unwrap();
    let wider = cb::scene_tactical_map(&state).unwrap().combat_bounds.unwrap();
    assert!(cb::combat_bounds_contain(Some(&wider), outside["x"].as_i64().unwrap(), 20));
    assert!(wider.max_x >= bounds.max_x);
}
