//! `server/scene-program-layout.mjs` против эталонов JS
//! (`fixtures/scene-program-layout.json`, `fixtures/scene-program-layout-corpus.json.gz`,
//! генератор `fixtures/gen-scene-program-layout.mjs`) и проверки
//! `test/scene-program-layout.test.mjs`, `test/scene-program-corpus.test.mjs`
//! о самом модуле. Итог случая — SHA-256 `JSON.stringify(serializeTacticalMap)`
//! карты и аудит `programReport` (с умолчаниями и с меркой поселения).

mod common;

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::LazyLock;

use common::{array, parse};
use serde_json::{json, Value};
use sk_map_core::map_quality::{count_platforms, platform_cells, program_report, ProgramOptions, SETTLEMENT_MIN_SIZE};
use sk_settlements::scene_program_layout::{
    apply_scene_plan, build_platforms, place_scene_focus, place_threshold_stones, program_focus_outdoors, PLATFORM_ELEVATION_FEET,
    SCENE_PROGRAM_LAYOUT_VERSION,
};
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, edge_neighbor, reachable_cells, serialize_tactical_map, TacticalMap, TacticalMapError};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/scene-program-layout.json")));
static CORPUS: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/scene-program-layout-corpus.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    parse(&text)
});

fn restore(value: &Value) -> TacticalMap {
    deserialize_tactical_map(value).expect("карта эталона читается")
}

fn map_hash(map: &TacticalMap) -> String {
    sk_core::hash::sha256_hex(sk_core::js::stringify(&serialize_tactical_map(map).expect("карта сериализуется")))
}

fn settlement_options() -> ProgramOptions {
    ProgramOptions { min_size: Some(SETTLEMENT_MIN_SIZE), open_scene: true }
}

/// Вызов функции модуля по имени случая; ответ — как в эталоне.
fn run(map: &mut TacticalMap, op: &str, args: &Value) -> Result<Value, TacticalMapError> {
    let seed = sk_core::js::s(args.get(1).and_then(|options| options.get("seed")));
    match op {
        "placeSceneFocus" => {
            let assets: Vec<&str> = array(&args[0]).iter().filter_map(Value::as_str).collect();
            Ok(place_scene_focus(map, &assets, &seed)?.map_or(Value::Null, Value::String))
        }
        "buildPlatforms" => Ok(json!(build_platforms(map, args[0].as_f64().expect("число настилов"), &seed))),
        "placeThresholdStones" => Ok(json!(place_threshold_stones(map, args[0].as_f64().expect("число камней")))),
        "applyScenePlan" => {
            apply_scene_plan(map, &args[0], &seed)?;
            Ok(json!("$map"))
        }
        other => panic!("неизвестная операция эталона: {other}"),
    }
}

/// Сверка итога: ответ, хеш карты, аудит программы.
fn compare(map: &TacticalMap, outcome: Result<Value, TacticalMapError>, expected: &Value, program: Option<&Value>, context: &str, mismatches: &mut Vec<String>) {
    match (outcome, expected.get("error")) {
        (Ok(result), None) => {
            if result != expected["result"] {
                mismatches.push(format!("{context}: ответ {result} вместо {}", expected["result"]));
            }
        }
        (Err(error), Some(wanted)) => {
            if wanted["code"].as_str() != Some(error.code.as_str()) || wanted["message"].as_str() != Some(error.message.as_str()) {
                mismatches.push(format!("{context}: отказ {error:?} вместо {wanted}"));
            }
        }
        (Ok(_), Some(wanted)) => mismatches.push(format!("{context}: ожидался отказ {wanted}")),
        (Err(error), None) => mismatches.push(format!("{context}: отказ {error:?}")),
    }
    if map_hash(map) != expected["hash"].as_str().unwrap_or_default() {
        mismatches.push(format!("{context}: карта расходится (предметов {} против {})", map.props.len(), expected["props"]));
    }
    if let Some(program) = program {
        let report = program_report(map, program, &ProgramOptions::default()).to_json();
        if report != expected["report"] {
            mismatches.push(format!("{context}: аудит {report} вместо {}", expected["report"]));
        }
        let settlement = program_report(map, program, &settlement_options()).to_json();
        if settlement != expected["settlementReport"] {
            mismatches.push(format!("{context}: аудит поселения {settlement} вместо {}", expected["settlementReport"]));
        }
    }
}

fn assert_clean(mismatches: &[String], total: usize) {
    assert!(mismatches.is_empty(), "расхождений {} из {total}:\n{}", mismatches.len(), mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn constants_match_js() {
    assert_eq!(FIXTURE["version"].as_str(), Some(SCENE_PROGRAM_LAYOUT_VERSION));
    assert_eq!(FIXTURE["platformElevationFeet"].as_i64(), Some(PLATFORM_ELEVATION_FEET));
}

#[test]
fn focus_outdoors_matches_js() {
    let rows = array(&FIXTURE["outdoors"]).iter().chain(array(&CORPUS["outdoors"]));
    let mut checked = 0;
    for row in rows {
        assert_eq!(Value::Bool(program_focus_outdoors(&row[0])), row[1], "programFocusOutdoors({})", row[0]);
        checked += 1;
    }
    assert!(checked > 250, "проверено {checked}");
}

#[test]
fn every_case_matches_js() {
    let cases = array(&FIXTURE["cases"]);
    let mut outputs: Vec<TacticalMap> = Vec::with_capacity(cases.len());
    let mut mismatches = Vec::new();
    let mut ops: HashMap<&str, usize> = HashMap::new();
    let mut placed_focus = 0;
    for (index, case) in cases.iter().enumerate() {
        let op = case["op"].as_str().expect("операция");
        *ops.entry(op).or_insert(0) += 1;
        let input = &case["input"];
        let mut map = match input.get("map").and_then(Value::as_u64) {
            Some(map) => restore(&FIXTURE["maps"][map as usize]),
            None => outputs[input["from"].as_u64().expect("вход случая") as usize].clone(),
        };
        let outcome = run(&mut map, op, &case["args"]);
        if op == "placeSceneFocus" && outcome.as_ref().is_ok_and(|result| result.as_str().is_some_and(|id| id.starts_with("program-focus-"))) {
            placed_focus += 1;
        }
        let program = (op == "applyScenePlan").then(|| &case["args"][0]);
        compare(&map, outcome, case, program, &format!("случай {index} ({op}, {})", case["args"]), &mut mismatches);
        outputs.push(map);
    }
    assert_clean(&mismatches, cases.len());
    for op in ["placeSceneFocus", "buildPlatforms", "placeThresholdStones", "applyScenePlan"] {
        assert!(ops.get(op).copied().unwrap_or(0) >= 250, "операция {op} покрыта слабо: {ops:?}");
    }
    assert!(placed_focus >= 50, "центр поставлен лишь в {placed_focus} случаях");
}

/// Вызовы конвейера сцены: те же входы, что дал `generateSceneGeometry`.
#[test]
fn scene_pipeline_corpus_matches_js() {
    let calls = array(&CORPUS["calls"]);
    let mut mismatches = Vec::new();
    for (index, call) in calls.iter().enumerate() {
        assert_eq!(call["stable"], json!(true), "вызов {index}: карта генератора и прочитанная расходятся в JS");
        let mut map = restore(&call["map"]);
        let seed = call["seed"].as_str().unwrap_or_default();
        let outcome = apply_scene_plan(&mut map, &call["program"], seed).map(|()| json!("$map"));
        compare(&map, outcome, call, Some(&call["program"]), &format!("вызов {index} ({seed})"), &mut mismatches);
        // Свойства карты скита (`test/scene-program-layout.test.mjs`, этап 3) —
        // на удачной попытке: центр под открытым небом, три настила шагом,
        // камни у двух ближайших дверей.
        if seed.starts_with("skit-") && !seed.contains(":attempt-") {
            check_skit(&map, seed);
        }
        if seed.starts_with("well-") && !seed.contains(":attempt-") {
            assert_eq!(map.props.iter().filter(|prop| prop.asset_id == "well").count(), 1, "{seed}: колодец один");
        }
    }
    assert_clean(&mismatches, calls.len());
    assert!(calls.len() >= 100, "вызовов {}", calls.len());
}

fn check_skit(map: &TacticalMap, seed: &str) {
    let party = map.spawn_points.iter().find(|point| point.role == "party").expect("вход отряда");
    let kinds: HashMap<&str, &str> = map.zones.iter().map(|zone| (zone.id.as_str(), zone.kind.as_str())).collect();
    let focus = map.props.iter().find(|prop| prop.asset_id == "market_awning").unwrap_or_else(|| panic!("{seed}: навес на карте"));
    for cell in &focus.footprint {
        let zone = cell_at(map, cell.x, cell.y).map_or("", |cell| cell.zone);
        assert_ne!(kinds.get(zone), Some(&"interior"), "{seed}: навес под открытым небом");
    }
    assert_eq!(count_platforms(map), 3, "{seed}: три настила");
    let reached = reachable_cells(map, party.x, party.y, true, None);
    for (x, y) in platform_cells(map) {
        assert_eq!(cell_at(map, x, y).map(|cell| cell.elevation), Some(PLATFORM_ELEVATION_FEET), "{seed}: настил — шаг");
        assert!((x - party.x).abs() + (y - party.y).abs() >= 5, "{seed}: настил не у самого входа");
        assert!(reached.contains(&(x, y)), "{seed}: на настил всходят без лазания");
    }
    let stones: Vec<_> = map.props.iter().filter(|prop| prop.id.starts_with("program-threshold")).collect();
    assert_eq!(stones.len(), 2, "{seed}: камни у двух ближайших домов");
    for stone in stones {
        assert!(!stone.blocks_move, "камень на пороге не запирает проём");
        let at = (stone.x.floor() as i64, stone.y.floor() as i64);
        assert!(map.doors.iter().any(|door| at == (door.x, door.y) || at == edge_neighbor(door.x, door.y, door.dir)), "{seed}: камень у двери");
    }
    assert_eq!(program_report(map, &skit_program_like(map), &settlement_options()).problems.len(), 0, "{seed}: проверка карты чиста");
}

/// Программа скита в той форме, что проверяет аудит (обязательные виды).
fn skit_program_like(_map: &TacticalMap) -> Value {
    json!({
        "items": [{ "id": "shelter", "count": 1 }, { "id": "chest", "count": 1 }, { "id": "platform", "count": 3 }, { "id": "threshold_stone", "count": 1 }, { "id": "crate", "count": 1 }],
        "focus": "shelter",
        "posts": [{ "npc": "Илва", "id": "shelter" }, { "npc": "Терен", "id": "chest" }, { "npc": "Вейра", "id": "platform" }],
    })
}

// --- ручные карты проверки (`test/scene-program-layout.test.mjs`, этапы 3–4) -----------

fn scenario(name: &str) -> TacticalMap {
    restore(&FIXTURE["maps"][FIXTURE["scenarios"][name].as_u64().expect("сценарий") as usize])
}

#[test]
fn cramped_well_in_a_nook_yields_to_the_focus() {
    let mut map = scenario("nook");
    let program = json!({ "items": [{ "id": "well", "count": 1 }], "focus": "well" });
    let before = program_report(&map, &program, &ProgramOptions::default());
    assert_eq!(before.to_json()["problems"], json!([{ "code": "FOCUS_CRAMPED", "detail": "well: 2 кл." }]));
    apply_scene_plan(&mut map, &program, "field-nook").expect("программа");
    let wells: Vec<&str> = map.props.iter().filter(|prop| prop.asset_id == "well").map(|prop| prop.id.as_str()).collect();
    assert_eq!(wells, ["program-focus-well"], "второй колодец рядом с зажатым не встаёт");
    assert!(program_report(&map, &program, &ProgramOptions::default()).problems.is_empty());
}

#[test]
fn platforms_count_by_cells_and_fulfil_the_program() {
    let mut map = scenario("field");
    let program = json!({ "items": [{ "id": "platform", "count": 2 }], "focus": "platform" });
    assert_eq!(program_report(&map, &program, &ProgramOptions::default()).missing, ["platform"]);
    apply_scene_plan(&mut map, &program, "field-plan").expect("программа");
    assert_eq!(count_platforms(&map), 2);
    assert!(program_report(&map, &program, &ProgramOptions::default()).problems.is_empty());
    let cells: HashSet<(i64, i64)> = platform_cells(&map).into_iter().collect();
    assert_eq!(cells.len(), 12, "два настила по 3×2");
}

#[test]
fn layout_is_deterministic_and_empty_program_changes_nothing() {
    let program = json!({ "items": [{ "id": "well", "count": 1 }, { "id": "barrels", "count": 2 }, { "id": "threshold_stone", "count": 1 }], "focus": "well" });
    let mut first = scenario("field");
    let mut second = scenario("field");
    apply_scene_plan(&mut first, &program, "det").expect("программа");
    apply_scene_plan(&mut second, &program, "det").expect("программа");
    assert_eq!(map_hash(&first), map_hash(&second));
    let mut plain = scenario("field");
    let untouched = map_hash(&plain);
    for empty in [Value::Null, json!([]), json!({}), json!({ "items": [{ "id": "spaceship" }] })] {
        apply_scene_plan(&mut plain, &empty, "det").expect("пустая программа");
        assert_eq!(map_hash(&plain), untouched, "программа без видов карту не меняет: {empty}");
    }
}
