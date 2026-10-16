//! Перенос `server/level-generator.mjs`: эталон JS
//! (`fixtures/level-generator.json.gz`, генератор
//! `fixtures/gen-level-generator.mjs`) и проверки самого модуля из
//! `test/level-generator.test.mjs`. Карта этажа сверяется хешем SHA-256 строки
//! `JSON.stringify(serializeTacticalMap(map))`; расхождение печатает метку —
//! полную карту JS даёт `gen-level-generator.mjs --dump <метка>`.

use std::collections::HashSet;
use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_map_core::map_quality::audit_tactical_map;
use sk_tactical::tactical_map::{self as tm, TacticalMap};
use sk_world_time::level_generator::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let bytes = include_bytes!("../fixtures/level-generator.json.gz");
    let mut text = String::new();
    flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut text).expect("эталон этажей читается");
    serde_json::from_str(&text).expect("эталон этажей — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn base_map(index: u64) -> TacticalMap {
    tm::deserialize_tactical_map(&section("bases")[index as usize]).expect("исходная карта эталона читается")
}

fn sha(value: &Value) -> String {
    hash::sha256_hex(js::stringify(value))
}

fn outline_hash(outline: &sk_core::indexmap::IndexSet<(i64, i64)>) -> String {
    let keys: Vec<Value> = outline.iter().map(|(x, y)| Value::String(format!("{x},{y}"))).collect();
    sha(&Value::Array(keys))
}

fn cell_of(value: &Value) -> Option<(i64, i64)> {
    Some((value.get("x")?.as_i64()?, value.get("y")?.as_i64()?))
}

/// Выход случая в форме эталона (`summarize` генератора).
fn summarize(result: &LevelGenerationResult, fresh: Option<&TacticalMap>, at: Option<(i64, i64)>) -> Value {
    let map = result.map.as_ref();
    let mut summary = json!({
        "map": map.map_or(Value::Null, |map| Value::String(sha(&tm::serialize_tactical_map(map).expect("карта этажа сериализуется")))),
    });
    let rest = result.to_json_without_map();
    js::assign(&mut summary, rest);
    js::assign(
        &mut summary,
        json!({
            "audit": map.map_or(Value::Null, |map| json!(audit_tactical_map(map).problems.iter().map(|problem| problem.code).collect::<Vec<_>>())),
            "reach": match (map, result.arrival) {
                (Some(map), Some(arrival)) => Value::Bool(transition_reachable_from(map, arrival)),
                _ => Value::Null,
            },
            "outline": fresh.map_or(Value::Null, |fresh| Value::String(outline_hash(&interior_outline(fresh, at)))),
            "outlineBare": fresh.map_or(Value::Null, |fresh| json!(interior_outline(fresh, None).len())),
        }),
    );
    summary
}

const SUMMARY_KEYS: [&str; 12] = ["map", "levelIndex", "levelLabel", "arrival", "transitionPropId", "warnings", "errors", "audit", "reach", "outline", "outlineBare", "error"];

#[test]
fn fixture_cases_match_js() {
    let cases = section("cases");
    assert!(cases.len() > 1_000, "эталон этажей неполон: {}", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let label = case["label"].as_str().unwrap_or("?");
        let options = &case["options"];
        let base = case["base"].as_u64().map(base_map);
        let fresh = case["base"].as_u64().map(base_map);
        let at = cell_of(&case["at"]);
        let field = |key: &str| options.get(key);
        let input = LevelOptions {
            location_id: field("locationId").and_then(Value::as_str).unwrap_or(""),
            level: field("level"),
            seed: field("seed"),
            base_map: base.as_ref(),
            source_prop: field("sourceProp"),
            hint: field("hint"),
            theme: field("theme"),
        };
        let actual = match generate_level_map(&input) {
            Ok(result) => summarize(&result, fresh.as_ref(), at),
            Err(error) => json!({ "error": { "name": error.name, "code": error.code, "message": error.message } }),
        };
        let expected: serde_json::Map<String, Value> =
            SUMMARY_KEYS.iter().filter_map(|key| case.get(*key).map(|value| ((*key).to_string(), value.clone()))).collect();
        if actual != Value::Object(expected.clone()) {
            if failures.len() < 3 {
                eprintln!("{label}\n  ожидалось: {}\n  получено:  {}", js::stringify(&Value::Object(expected)), js::stringify(&actual));
            }
            failures.push(label.to_string());
        }
    }
    assert!(failures.is_empty(), "расхождения ({}): {:?}", failures.len(), &failures[..failures.len().min(20)]);
}

#[test]
fn fixture_labels_match_js() {
    for case in section("labels") {
        assert_eq!(level_label_for(&case["offset"], case.get("hint")), case["label"].as_str().unwrap_or_default(), "{case}");
    }
}

#[test]
fn fixture_declared_levels_match_js() {
    for case in section("declared") {
        let levels: Vec<Value> = normalize_declared_levels(Some(&case["value"])).iter().map(DeclaredLevel::to_json).collect();
        assert_eq!(Value::Array(levels), case["levels"], "{case}");
    }
}

// ---------------------------------------------------------------------------
// Проверки модуля из `test/level-generator.test.mjs`
// ---------------------------------------------------------------------------

#[test]
fn declared_levels_drop_junk_clamp_range_and_collapse_repeats() {
    let levels = normalize_declared_levels(Some(&json!([
        null,
        "второй этаж",
        { "offset": "вверх" },
        { "offset": 0, "hint": "сам этаж входа" },
        { "offset": 1.5 },
        { "offset": 1, "hint": "спальни" },
        { "offset": 1, "hint": "повтор того же этажа" },
        { "offset": -9, "hint": "винный погреб" },
        { "offset": 2 },
        { "offset": -2 },
    ])));
    assert_eq!(levels.iter().map(|level| level.offset).collect::<Vec<_>>(), vec![1, -3, 2]);
    assert_eq!(levels[0].label, "Второй этаж", "наверху подпись порядковая");
    assert_eq!(levels[1].label, "Винный погреб", "внизу подписью становятся слова архитектора");
    assert_eq!(level_label_for(0, None), "Первый этаж");
}

/// Случаи эталона с этой меткой: исходная карта и предмет.
fn fixture_case(label: &str) -> &'static Value {
    section("cases").iter().find(|case| case["label"] == label).unwrap_or_else(|| panic!("нет случая {label}"))
}

fn run_case(label: &str) -> (Option<TacticalMap>, LevelGenerationResult) {
    let case = fixture_case(label);
    let base = case["base"].as_u64().map(base_map);
    let options = &case["options"];
    let result = generate_level_map(&LevelOptions {
        location_id: options["locationId"].as_str().unwrap_or(""),
        level: options.get("level"),
        seed: options.get("seed"),
        base_map: base.as_ref(),
        source_prop: options.get("sourceProp"),
        hint: options.get("hint"),
        theme: options.get("theme"),
    })
    .expect("этаж собирается без исключения");
    (base, result)
}

fn present_cells(map: &TacticalMap) -> HashSet<(i64, i64)> {
    tm::cells(map).map(|cell| (cell.x, cell.y)).collect()
}

#[test]
fn upper_level_inherits_building_outline() {
    let (base, built) = run_case("test/upper");
    let base = base.expect("карта");
    assert!(built.errors.is_empty());
    let map = built.map.as_ref().expect("этаж собран");
    assert!(tm::validate_tactical_map(map).ok);
    assert_eq!(map.level_index, 1);
    assert_eq!(map.level_label, "Второй этаж");
    let outline: HashSet<(i64, i64)> = interior_outline(&base, None).into_iter().collect();
    assert_eq!(present_cells(map), outline, "контур второго этажа совпадает с interior-контуром первого");
    assert_eq!((map.width, map.height), (base.width, base.height));
    let paired = map.props.iter().find(|prop| prop.transition.as_ref().is_some_and(|transition| transition.to_level == 0)).expect("парный переход");
    assert_eq!(paired.asset_id, "stairs_down");
    assert_eq!(paired.transition.as_ref().map(|transition| transition.label.as_str()), Some("Первый этаж"));
}

#[test]
fn cellar_stays_under_the_building() {
    let (base, built) = run_case("test/cellar");
    let base = base.expect("карта");
    assert!(built.errors.is_empty());
    let map = built.map.as_ref().expect("подвал собран");
    assert_eq!(map.level_index, -1);
    assert_eq!(map.level_label, "Винный погреб");
    let outline: HashSet<(i64, i64)> = interior_outline(&base, None).into_iter().collect();
    let cellar = present_cells(map);
    assert!(cellar.len() < outline.len(), "контур подвала строго меньше контура этажа выше");
    assert!(cellar.is_subset(&outline), "подвал не вылезает за контур здания");
    let arrival = built.arrival.expect("прибытие");
    assert!(tm::cell_passable(map, arrival.0, arrival.1));
    assert!(transition_reachable_from(map, arrival));
}

#[test]
fn same_inputs_give_byte_identical_maps() {
    for label in ["test/upper", "test/cellar"] {
        let (_, first) = run_case(label);
        let (_, second) = run_case(label);
        let serialize = |result: &LevelGenerationResult| js::stringify(&tm::serialize_tactical_map(result.map.as_ref().expect("карта")).expect("сериализуется"));
        assert_eq!(serialize(&first), serialize(&second));
    }
}

#[test]
fn cave_level_is_connected_and_corner_is_refused() {
    let (_, built) = run_case("test/cave");
    assert!(built.errors.is_empty());
    let map = built.map.as_ref().expect("ярус собран");
    assert_eq!(map.level_index, -1);
    assert!(transition_reachable_from(map, built.arrival.expect("прибытие")));
    let (_, refused) = run_case("test/cave-corner");
    assert!(refused.map.is_none());
    assert_eq!(refused.errors[0].code, "LEVEL_ARRIVAL_UNREACHABLE");
}

#[test]
fn refusals_carry_codes() {
    let (_, forest) = run_case("test/forest");
    assert_eq!(forest.errors[0].code, "LEVEL_OUTLINE_MISSING");
    for level in ["0", "4", "-4", "второй", "1.5"] {
        let (_, refused) = run_case(&format!("test/refuse-level-{level}"));
        assert!(refused.map.is_none());
        assert_eq!(refused.errors[0].code, "LEVEL_INDEX_NOT_ALLOWED");
    }
    assert_eq!(run_case("test/no-source").1.errors[0].code, "LEVEL_SOURCE_PROP_MISSING");
    assert_eq!(run_case("test/no-base").1.errors[0].code, "LEVEL_BASE_MAP_MISSING");
    assert_eq!(run_case("test/outside").1.errors[0].code, "LEVEL_SOURCE_PROP_MISSING");
}

/// Замечено в JS: `footprint: [null]` при якоре вне следа роняет генератор
/// `TypeError`, а не отказом `LEVEL_SOURCE_PROP_MISSING`.
#[test]
fn null_footprint_cell_throws_type_error_like_js() {
    let case = fixture_case("junk-prop/0/12");
    let base = base_map(case["base"].as_u64().expect("карта"));
    let error = generate_level_map(&LevelOptions { location_id: "loc", level: Some(&json!(-1)), seed: Some(&json!("j")), base_map: Some(&base), source_prop: Some(&json!({ "x": 2.5, "y": 2.5, "footprint": [null] })), ..LevelOptions::default() })
        .expect_err("исключение, как в JS");
    assert_eq!(error.name, "TypeError");
    assert_eq!(error.message, "Cannot read properties of null (reading 'x')");
}
