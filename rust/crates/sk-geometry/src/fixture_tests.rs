//! Сверка с эталонами JS из `fixtures/` (скрипты `fixtures/gen-*.mjs`
//! прогоняют исходные модули `server/*.mjs` на случайных входах с
//! фиксированным сидом).
//!
//! Входы эталонов — JSON-значения, которые JS получал как есть; `{"$u":1}` —
//! `undefined`. Дробные результаты записаны строкой `String(x)` и читаются
//! [`js::parse_number`], чтобы не зависеть от точности разбора чисел serde.

use std::cell::RefCell;
use std::collections::HashSet;

use serde_json::{json, Value};
use sk_core::js;

use crate::actor_footprint::*;
use crate::circular_area_geometry::*;
use crate::{GridCell, Point};

pub(crate) fn load(text: &str) -> Value {
    serde_json::from_str(text).expect("эталон — корректный JSON")
}

/// Значение аргумента: `{"$u":1}` — `undefined` (`None`).
pub(crate) fn arg(value: &Value) -> Option<&Value> {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$u") => None,
        other => Some(other),
    }
}

/// Поле случая, отсутствующее поле — `undefined`.
pub(crate) fn field<'a>(case: &'a Value, name: &str) -> Option<&'a Value> {
    case.get(name).and_then(arg)
}

/// Числа JSON равны как числа JS: `45035996273704910` из JS и f64 Rust —
/// одно и то же значение, хотя serde хранит их по-разному.
pub(crate) fn same_number(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => left == right,
    }
}

fn number_string(value: &Value) -> f64 {
    js::parse_number(value.as_str().expect("число строкой"))
}

fn cells_value(cells: &[GridCell]) -> Value {
    Value::Array(cells.iter().map(|cell| cell.to_value()).collect())
}

fn sha(text: &str) -> String {
    sk_core::hash::sha256_hex(text)
}

fn raster_key(cells: &[GridCell]) -> String {
    cells.iter().map(|cell| cell.key()).collect::<Vec<_>>().join(";")
}

mod actor_footprint_fixture {
    use super::*;

    static FIXTURE: &str = include_str!("../fixtures/actor-footprint.json");

    #[test]
    fn constants_match_js() {
        let fixture = load(FIXTURE);
        assert_eq!(fixture["version"], json!(ACTOR_FOOTPRINT_VERSION));
        let sides: Vec<Value> = ACTOR_SIZE_SIDES.iter().map(|(name, side)| json!([name, side])).collect();
        assert_eq!(fixture["sizeSides"], Value::Array(sides));
    }

    #[test]
    fn metadata_and_normalization_match_js() {
        let fixture = load(FIXTURE);
        let mut checked = 0;
        for case in fixture["metadataForSize"].as_array().expect("случаи") {
            let actual = footprint_metadata_for_size(field(case, "size")).to_value();
            assert_eq!(actual, case["expected"], "footprintMetadataForSize({})", case["size"]);
            checked += 1;
        }
        for case in fixture["normalize"].as_array().expect("случаи") {
            let actual = normalize_footprint_metadata(field(case, "value")).map_or(Value::Null, FootprintMetadata::to_value);
            assert_eq!(actual, case["expected"], "normalizeFootprintMetadata({})", case["value"]);
            checked += 1;
        }
        for case in fixture["sizeFor"].as_array().expect("случаи") {
            assert_eq!(json!(footprint_size_for(field(case, "actor"))), case["expected"], "footprintSizeFor({})", case["actor"]);
            checked += 1;
        }
        assert!(checked > 600);
    }

    #[test]
    fn cells_match_js() {
        let fixture = load(FIXTURE);
        let cases = fixture["cells"].as_array().expect("случаи");
        for case in cases {
            let actual = footprint_cells_for(field(case, "actor"), field(case, "anchor"));
            assert_eq!(cells_value(&actual), case["expected"], "footprintCellsFor({}, {})", case["actor"], case["anchor"]);
        }
        assert!(cases.len() >= 600);
    }

    #[test]
    fn distance_and_overlap_match_js() {
        let fixture = load(FIXTURE);
        let cases = fixture["pairs"].as_array().expect("случаи");
        for case in cases {
            let (left, right) = (field(case, "left"), field(case, "right"));
            let (left_anchor, right_anchor) = (field(case, "leftAnchor"), field(case, "rightAnchor"));
            let distance = footprint_distance_feet(left, right, left_anchor, right_anchor).map_or(Value::Null, js::num);
            assert!(same_number(&distance, &case["distance"]), "footprintDistanceFeet: {case} → {distance}");
            assert_eq!(json!(footprint_overlap(left, right, left_anchor, right_anchor)), case["overlap"], "footprintOverlap: {case}");
        }
        assert!(cases.len() >= 900);
    }
}

mod circular_area_geometry_fixture {
    use super::*;

    static FIXTURE: &str = include_str!("../fixtures/circular-area-geometry.json");

    fn point(value: Option<&Value>) -> Point {
        Point::from_value(value)
    }

    #[test]
    fn coverage_matches_js_bit_for_bit() {
        let fixture = load(FIXTURE);
        assert_eq!(fixture["version"], json!(CIRCULAR_AREA_GEOMETRY_VERSION));
        let cases = fixture["coverage"].as_array().expect("случаи");
        for case in cases {
            let cell = point(field(case, "cell"));
            let radius = js::number(field(case, "radius"));
            let expected = number_string(&case["coverage"]);
            let actual = circular_cell_coverage(cell, radius);
            assert!(
                actual == expected || (actual.is_nan() && expected.is_nan()),
                "circularCellCoverage({}, {}) = {actual:e}, в JS {expected:e}",
                case["cell"],
                case["radius"]
            );
            assert_eq!(json!(circular_cell_covered(cell, radius)), case["covered"], "circularCellCovered: {case}");
        }
        assert!(cases.len() >= 1500);
    }

    #[test]
    fn grid_origin_matches_js() {
        let fixture = load(FIXTURE);
        for case in fixture["origins"].as_array().expect("случаи") {
            let origin = grid_origin_for_target_cell(point(field(case, "target")));
            assert_eq!(origin.to_value(), case["origin"], "gridOriginForTargetCell({})", case["target"]);
        }
    }

    #[test]
    fn raster_matches_js() {
        let fixture = load(FIXTURE);
        let cases = fixture["areas"].as_array().expect("случаи");
        for case in cases {
            let options = CircularAreaOptions::from_value(&case["options"]);
            let cells = circular_area_cells(&options);
            assert_eq!(json!(cells.len()), case["count"], "circularAreaCells({}): число клеток", case["options"]);
            if let Some(Value::Array(expected)) = case.get("cells") {
                let flat: Vec<Value> = cells.iter().flat_map(|cell| [json!(cell.x), json!(cell.y)]).collect();
                assert_eq!(&flat, expected, "circularAreaCells({})", case["options"]);
            }
            assert_eq!(json!(sha(&raster_key(&cells))), case["hash"], "circularAreaCells({}): порядок клеток", case["options"]);
        }
        assert!(cases.len() >= 400);
    }

    fn edge_key(from: GridCell, to: GridCell) -> String {
        let mut pair = [from.key(), to.key()];
        pair.sort();
        pair.join("|")
    }

    #[test]
    fn line_of_effect_matches_js_with_callback_order() {
        let fixture = load(FIXTURE);
        let cases = fixture["lines"].as_array().expect("случаи");
        let mut positives = 0;
        for case in cases {
            let ints = |name: &str| -> Vec<i64> {
                case[name].as_array().expect("список").iter().map(|value| value.as_i64().expect("целое")).collect()
            };
            let closed: HashSet<GridCell> = ints("closedCells").chunks(2).map(|pair| GridCell::new(pair[0], pair[1])).collect();
            let blocked: HashSet<String> = ints("blockedEdges")
                .chunks(4)
                .map(|edge| edge_key(GridCell::new(edge[0], edge[1]), GridCell::new(edge[2], edge[3])))
                .collect();
            let log = RefCell::new(Vec::<String>::new());
            let open = |cell: GridCell| {
                log.borrow_mut().push(format!("o:{},{}", cell.x, cell.y));
                !closed.contains(&cell)
            };
            let edge = |from: GridCell, to: GridCell| {
                log.borrow_mut().push(format!("e:{},{}>{},{}", from.x, from.y, to.x, to.y));
                blocked.contains(&edge_key(from, to))
            };
            let callbacks = case["callbacks"].as_str().expect("вид коллбэков");
            let options = LineOfEffectOptions {
                radius_feet: js::number(field(case, "radiusFeet")),
                spreads_around_corners: js::is_true(field(case, "spreadsAroundCorners")),
                is_open_cell: matches!(callbacks, "both" | "open").then_some(&open as &dyn Fn(GridCell) -> bool),
                is_blocked_edge: matches!(callbacks, "both" | "edge").then_some(&edge as &dyn Fn(GridCell, GridCell) -> bool),
            };
            let result = circular_area_line_of_effect(point(field(case, "origin")), point(field(case, "target")), &options);
            assert_eq!(json!(result), case["result"], "circularAreaLineOfEffect: {} → {}", case["origin"], case["target"]);
            let log = log.into_inner();
            assert_eq!(json!(log.len()), case["calls"], "число обращений к карте: {} → {}", case["origin"], case["target"]);
            assert_eq!(json!(sha(&log.join("|"))), case["log"], "порядок обращений к карте: {} → {}", case["origin"], case["target"]);
            positives += usize::from(result);
        }
        assert!(cases.len() >= 900 && positives > 300);
    }
}

mod scene_graph_fixture {
    use super::*;
    use crate::scene_graph::*;

    static FIXTURE: &str = include_str!("../fixtures/scene-graph.json");

    fn reach_value(reach: &Reachability) -> Value {
        json!({ "zones": reach.zones.iter().collect::<Vec<_>>(), "keys": reach.keys.iter().collect::<Vec<_>>(), "rounds": reach.rounds })
    }

    /// Сравнение по тексту JSON: совпадают и значения, и порядок полей.
    fn assert_same_json(actual: &Value, expected: &Value, what: &str) {
        assert_eq!(
            serde_json::to_string(actual).expect("JSON"),
            serde_json::to_string(expected).expect("JSON"),
            "{what}"
        );
    }

    #[test]
    fn constants_match_js() {
        let fixture = load(FIXTURE);
        assert_eq!(fixture["version"], json!(SCENE_GRAPH_VERSION));
        assert_eq!(fixture["linkKinds"], json!(LINK_KINDS));
    }

    #[test]
    fn graphs_match_js() {
        let fixture = load(FIXTURE);
        let cases = fixture["cases"].as_array().expect("случаи");
        let empty = json!({});
        for case in cases {
            let input = field(case, "input").unwrap_or(&empty);
            let what = format!("рецепт {}", case["input"]);
            match create_scene_graph(input) {
                Err(error) => {
                    assert_eq!(json!({ "code": error.code, "message": error.message }), case["error"], "{what}");
                }
                Ok(graph) => {
                    assert!(case.get("error").is_none(), "{what}: JS отказал, Rust собрал граф");
                    assert_same_json(&serde_json::to_value(&graph).expect("граф"), &case["graph"], &format!("{what}: граф"));
                    assert_same_json(&serde_json::to_value(validate_scene_graph(&graph)).expect("отчёт"), &case["report"], &format!("{what}: проверка"));
                    assert_same_json(&reach_value(&reachable_zones(&graph, None)), &case["reached"], &format!("{what}: достижимость"));
                    let from = field(case, "from").and_then(Value::as_str);
                    assert_same_json(&reach_value(&reachable_zones(&graph, from)), &case["fromReached"], &format!("{what}: от {from:?}"));
                    assert_same_json(&serde_json::to_value(progression_waves(&graph)).expect("волны"), &case["waves"], &format!("{what}: волны"));
                }
            }
        }
        assert!(cases.len() >= 500);
    }
}

mod world_map_fixture {
    use super::*;
    use crate::js_extra::js_hypot;
    use crate::world_map::*;

    static FIXTURE: &str = include_str!("../fixtures/world-map.json");

    /// Карты, уже собранные Rust в предыдущих случаях: на них ссылаются входы
    /// `{"$map": i}` и `{"$rec": i}`.
    #[derive(Default)]
    struct Built {
        created: Vec<Option<Value>>,
        reconciled: Vec<Option<Value>>,
    }

    impl Built {
        /// Подставить ссылки и `undefined`: в объекте поле исчезает, в массиве
        /// становится `null` (для имён мест JS их не различает).
        fn resolve(&self, value: &Value) -> Option<Value> {
            match value {
                Value::Object(map) if map.len() == 1 && map.contains_key("$u") => None,
                Value::Object(map) if map.len() == 1 && map.contains_key("$map") => {
                    Some(self.created[map["$map"].as_u64().expect("индекс") as usize].clone().expect("карта собрана"))
                }
                Value::Object(map) if map.len() == 1 && map.contains_key("$rec") => {
                    Some(self.reconciled[map["$rec"].as_u64().expect("индекс") as usize].clone().expect("карта сверена"))
                }
                Value::Object(map) => Some(Value::Object(
                    map.iter().filter_map(|(key, entry)| self.resolve(entry).map(|entry| (key.clone(), entry))).collect(),
                )),
                Value::Array(items) => Some(Value::Array(items.iter().map(|item| self.resolve(item).unwrap_or(Value::Null)).collect())),
                other => Some(other.clone()),
            }
        }
    }

    fn stringify(value: &Value) -> String {
        let mut out = String::new();
        crate::world_map::json_stringify(value, &mut out);
        out
    }

    /// Сверка исхода сборки карты с записью эталона.
    fn check_map(outcome: Result<Value, String>, case: &Value, what: &str) -> Option<Value> {
        match (outcome, case.get("error")) {
            (Err(message), Some(expected)) => {
                assert_eq!(json!(message), *expected, "{what}: текст отказа");
                None
            }
            (Err(message), None) => panic!("{what}: Rust отказал «{message}», JS собрал карту"),
            (Ok(_), Some(expected)) => panic!("{what}: JS отказал «{expected}», Rust собрал карту"),
            (Ok(map), None) => {
                if let Some(full) = case.get("full") {
                    assert_eq!(stringify(&map), stringify(full), "{what}: карта целиком");
                }
                assert_eq!(map["currentLocationId"], case["currentLocationId"], "{what}: текущая точка");
                let counts = ["regions", "locations", "routes"].map(|name| map[name].as_array().map_or(0, Vec::len));
                assert_eq!(json!(counts), case["counts"], "{what}: регионы, места, дороги");
                assert_eq!(json!(sha(&stringify(&map))), case["hash"], "{what}: sha256 JSON.stringify(карта)");
                Some(map)
            }
        }
    }

    fn build_all(fixture: &Value) -> Built {
        let mut built = Built::default();
        let empty = json!({});
        for (index, case) in fixture["create"].as_array().expect("сборки").iter().enumerate() {
            let input = built.resolve(&case["input"]);
            let outcome = create_campaign_world_map(input.as_ref().unwrap_or(&empty));
            let map = check_map(outcome, case, &format!("createCampaignWorldMap #{index}"));
            built.created.push(map);
        }
        for (index, case) in fixture["reconcile"].as_array().expect("сверки").iter().enumerate() {
            let raw_map = built.resolve(&case["map"]);
            let options = built.resolve(&case["options"]);
            let outcome = reconcile_world_map(raw_map.as_ref(), options.as_ref().unwrap_or(&empty));
            let map = check_map(outcome, case, &format!("reconcileWorldMap #{index}"));
            built.reconciled.push(map);
        }
        built
    }

    #[test]
    fn create_reconcile_and_ensure_match_js() {
        let fixture = load(FIXTURE);
        let built = build_all(&fixture);
        assert!(built.created.len() >= 150 && built.reconciled.len() >= 200);
        assert!(built.created.iter().filter(|map| map.is_some()).count() > 140);
        let empty = json!({});
        let cases = fixture["ensure"].as_array().expect("состояния");
        for (index, case) in cases.iter().enumerate() {
            let state = built.resolve(&case["state"]);
            let outcome = ensure_campaign_world_map(state.as_ref().unwrap_or(&empty));
            check_map(outcome, case, &format!("ensureCampaignWorldMap #{index}"));
        }
        assert!(cases.len() >= 90);
    }

    #[test]
    fn lookups_match_js() {
        let fixture = load(FIXTURE);
        let built = build_all(&fixture);
        for case in fixture["lookups"].as_array().expect("поиски") {
            let map = built.resolve(&case["map"]);
            let id = case["id"].as_str().expect("строка");
            let found = world_location_by_id(map.as_ref(), id).cloned().unwrap_or(Value::Null);
            assert_eq!(stringify(&found), stringify(&case["expected"]), "worldLocationById({id:?})");
        }
    }

    #[test]
    fn small_normalizers_match_js() {
        let fixture = load(FIXTURE);
        assert_eq!(fixture["patterns"]["world"], json!(WORLD_MAP_BACKGROUND_URL_PATTERN));
        assert_eq!(fixture["patterns"]["city"], json!(CITY_OVERVIEW_IMAGE_URL_PATTERN));
        for case in fixture["backgroundUrls"].as_array().expect("адреса") {
            assert_eq!(json!(safe_world_map_background_url(Some(&case["value"]))), case["world"], "фон {}", case["value"]);
            assert_eq!(json!(safe_city_overview_image_url(Some(&case["value"]))), case["city"], "план {}", case["value"]);
        }
        for case in fixture["backgrounds"].as_array().expect("фоны") {
            let actual = normalize_world_map_background(field(case, "value"));
            assert_eq!(stringify(&actual), stringify(&case["expected"]), "normalizeWorldMapBackground({})", case["value"]);
        }
        let mut lore_cases = 0;
        for case in fixture["lore"].as_array().expect("лор") {
            let actual = normalize_world_map_location_lore(field(case, "value"));
            assert_eq!(stringify(&actual), stringify(&case["expected"]), "normalizeWorldMapLocationLore({})", case["value"]);
            lore_cases += 1;
        }
        let mut overviews = 0;
        for case in fixture["cityOverviews"].as_array().expect("обзоры") {
            let actual = normalize_city_overview(field(case, "value")).unwrap_or(Value::Null);
            assert_eq!(stringify(&actual), stringify(&case["expected"]), "normalizeCityOverview({})", case["value"]);
            overviews += usize::from(!actual.is_null());
        }
        assert!(lore_cases >= 140 && overviews >= 30);
    }

    #[test]
    fn hypot_matches_v8_bit_for_bit() {
        let fixture = load(FIXTURE);
        let cases = fixture["hypot"].as_array().expect("hypot");
        for case in cases {
            let (a, b) = (case[0].as_f64().expect("число"), case[1].as_f64().expect("число"));
            let expected = js::parse_number(case[2].as_str().expect("строка"));
            assert_eq!(js_hypot(a, b).to_bits(), expected.to_bits(), "Math.hypot({a}, {b})");
        }
        assert!(cases.len() >= 3000);
    }
}
