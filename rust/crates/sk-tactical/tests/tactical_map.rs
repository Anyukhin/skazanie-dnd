//! Сверка `tactical_map` с эталоном JS (`fixtures/tactical-map.json`,
//! генератор `fixtures/gen-tactical-map.mjs`): корпус нарисованных карт,
//! карты генераторов, старые клетки, программы операций API, испорченные
//! записи и случайные старые клетки — разбор каждой карты целиком.

mod common;

use std::collections::HashSet;
use std::sync::LazyLock;

use common::{arg, array, assert_same, hash, parse, stringify, UNDEFINED};
use serde_json::{json, Map, Value};
use sk_tactical::tactical_map::{self as t, CatalogRevision, CellPatchJson, EdgeDir, LegacyMapOptions, MapResult, TacticalMap, TacticalMapError, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/tactical-map.json")));
static CATALOG: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../../../../data/authored-location-maps-v1.json")));

fn error_json(error: &TacticalMapError) -> Value {
    json!({ "name": error.name, "code": if error.name == TacticalMapError::NAME { Value::String(error.code.clone()) } else { Value::Null }, "message": error.message })
}

/// `tryOr` генератора: `{ ok }` или `{ error }`.
fn try_or(result: MapResult<Value>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error_json(&error) }),
    }
}

fn int(value: &Value) -> i64 {
    value.as_i64().unwrap_or_else(|| panic!("целое в эталоне: {value}"))
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn key_point(key: &str) -> (i64, i64) {
    let (x, y) = key.split_once(',').expect("ключ клетки");
    (x.parse().expect("x"), y.parse().expect("y"))
}

fn cell_json(map: &TacticalMap, x: i64, y: i64) -> Value {
    t::cell_at(map, x, y).map_or(Value::Null, |cell| cell.to_json())
}

fn serialize(map: &TacticalMap) -> MapResult<Value> {
    t::serialize_tactical_map(map)
}

/// Разбор карты — тот же, что `analyze` генератора.
fn analyze(map: &TacticalMap, probes: &Value, full: bool) -> MapResult<Value> {
    let serialized = serialize(map)?;
    let legacy = Value::Array(t::legacy_cells_from_tactical_map(map));
    let mut grid = Vec::new();
    for y in -1..=map.height {
        for x in -1..=map.width {
            grid.push(cell_json(map, x, y));
        }
    }
    let pairs: Vec<Value> = array(&probes["pairs"])
        .iter()
        .map(|pair| {
            let (ax, ay, bx, by) = (int(&pair[0]), int(&pair[1]), int(&pair[2]), int(&pair[3]));
            match t::edge_between(map, ax, ay, bx, by) {
                Err(error) => json!({ "error": error.code }),
                Ok(edge) => {
                    let blocked = t::movement_step_blocked(map, ax, ay, bx, by).expect("соседние клетки");
                    let door = t::door_blocks_step(map, ax, ay, bx, by).expect("соседние клетки");
                    json!([edge.map_or(Value::Null, |edge| edge.to_json()), blocked, door])
                }
            }
        })
        .collect();
    let reachable: Vec<Value> = array(&probes["starts"])
        .iter()
        .map(|start| {
            let blocked: HashSet<(i64, i64)> = array(&start[3]).iter().map(|key| key_point(text(key))).collect();
            let set = t::reachable_cells(map, int(&start[0]), int(&start[1]), start[2] == true, Some(&blocked));
            let keys: Vec<Value> = set.iter().map(|(x, y)| Value::String(t::position_key(*x, *y))).collect();
            json!([set.len(), hash(&Value::Array(keys))])
        })
        .collect();
    let cells = array(&probes["cells"]);
    let doorways: Vec<Value> = cells
        .iter()
        .map(|cell| t::doorway_edge_at(map, int(&cell[0]), int(&cell[1])).map_or(Value::Null, |(x, y, dir)| json!({ "x": x, "y": y, "dir": dir.as_str() })))
        .collect();
    let doors_from: Vec<Value> =
        cells.iter().map(|cell| json!(t::doors_reachable_from(map, int(&cell[0]), int(&cell[1])).iter().map(|door| door.id.clone()).collect::<Vec<_>>())).collect();
    let masks: Vec<Value> = cells.iter().map(|cell| Value::String(t::legacy_edge_mask(map, int(&cell[0]), int(&cell[1])))).collect();
    let legacy_cells = array(&legacy).to_vec();
    let rebuilt = try_or((|| {
        let back = t::tactical_map_from_legacy_cells(&legacy_cells, &LegacyMapOptions { location_id: &map.location_id, seed: &map.seed, ..LegacyMapOptions::default() })?;
        Ok(json!([hash(&serialize(&back)?), hash(&Value::Array(t::legacy_cells_from_tactical_map(&back)))]))
    })());
    let orient: Vec<Value> = ["east", "north", "south", "west", "up"]
        .iter()
        .map(|side| {
            try_or((|| {
                let turned = t::orient_tactical_map(t::deserialize_tactical_map(&serialized)?, side)?;
                Ok(json!([hash(&serialize(&turned)?), hash(&Value::Array(t::legacy_cells_from_tactical_map(&turned)))]))
            })())
        })
        .collect();
    let attached = try_or((|| {
        let mut copy = t::deserialize_tactical_map(&serialized)?;
        let levels = json!([{ "offset": 1, "label": "Верхний этаж" }, { "offset": -1 }, { "offset": 2, "label": "Чердак" }]);
        let ids: Vec<String> = t::attach_level_transitions(&mut copy, Some(&levels)).into_iter().map(|index| copy.props[index].id.clone()).collect();
        Ok(json!([ids, hash(&serialize(&copy)?)]))
    })());
    let stable = hash(&serialize(&t::deserialize_tactical_map(&serialized)?)?);
    let edges = Value::Array(t::edge_list(map).into_iter().map(|edge| edge.to_json()).collect());
    let mut result = Map::new();
    result.insert("serialized".into(), if full { serialized.clone() } else { Value::String(hash(&serialized)) });
    result.insert("mapHash".into(), Value::String(t::tactical_map_hash(map)?));
    result.insert("legacy".into(), if full { legacy.clone() } else { Value::String(hash(&legacy)) });
    result.insert("validate".into(), t::validate_tactical_map(map).to_json());
    result.insert("cellCount".into(), json!(t::cell_count(map)));
    result.insert("bounds".into(), map.bounds.to_json());
    result.insert("edges".into(), if full { edges } else { Value::String(hash(&edges)) });
    result.insert("cells".into(), Value::String(hash(&Value::Array(grid))));
    result.insert("pairs".into(), Value::String(hash(&Value::Array(pairs))));
    result.insert("reachable".into(), Value::Array(reachable));
    result.insert("doorways".into(), Value::String(hash(&Value::Array(doorways))));
    result.insert("doorsFrom".into(), Value::String(hash(&Value::Array(doors_from))));
    result.insert("masks".into(), Value::String(hash(&Value::Array(masks))));
    result.insert("rebuilt".into(), rebuilt);
    result.insert("orient".into(), Value::Array(orient));
    result.insert("attached".into(), attached);
    result.insert("stable".into(), Value::String(stable));
    Ok(Value::Object(result))
}

#[track_caller]
fn assert_analysis(actual: &Value, expected: &Value, context: &str) {
    for (key, value) in expected.as_object().expect("разбор") {
        assert_same(&actual[key], value, &format!("{context}, поле {key}"));
    }
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["version"], t::TACTICAL_MAP_VERSION);
    assert_eq!(constants["surfaces"], json!(t::SURFACES));
    assert_eq!(constants["materials"], json!(t::MATERIALS));
    assert_eq!(constants["edgeKinds"], json!(t::EDGE_KINDS));
    assert_eq!(constants["coverLevels"], json!(t::COVER_LEVELS));
    assert_eq!(constants["doorStates"], json!(t::DOOR_STATES));
    assert_eq!(constants["zoneKinds"], json!(t::ZONE_KINDS));
    assert_eq!(constants["floorDirections"], json!(t::FLOOR_DIRECTIONS));
    assert_eq!(constants["spawnRoles"], json!(t::SPAWN_ROLES));
    assert_eq!(constants["floorStyles"], json!(t::FLOOR_STYLES));
    assert_eq!(constants["wallStyles"], json!(t::WALL_STYLES));
    assert_eq!(constants["surroundingsBiomes"], json!(t::SURROUNDINGS_BIOMES));
    assert_eq!(constants["maxLevelOffset"], t::MAX_LEVEL_OFFSET);
    assert_eq!(constants["floorVariants"], t::FLOOR_VARIANTS);
    assert_eq!(constants["entrySides"], json!(t::ENTRY_SIDES));
    let classes: Map<String, Value> = t::SIZE_CLASSES
        .iter()
        .map(|(name, limits)| {
            (
                name.to_string(),
                json!({ "maxWidth": limits.max_width, "maxHeight": limits.max_height, "maxCells": limits.max_cells, "maxProps": limits.max_props, "maxWallEdges": limits.max_wall_edges }),
            )
        })
        .collect();
    assert_same(&Value::Object(classes), &constants["sizeClasses"], "SIZE_CLASSES");
}

#[test]
fn authored_corpus_matches_js() {
    let maps = array(&CATALOG["maps"]);
    for case in array(&FIXTURE["corpus"]) {
        let index = int(&case["index"]) as usize;
        let raw = &maps[index];
        let context = format!("карта корпуса #{index} ({})", text(&raw["locationId"]));
        let map = t::deserialize_tactical_map(raw).unwrap_or_else(|error| panic!("{context}: {error}"));
        let same = stringify(&serialize(&map).expect("сериализация")) == stringify(raw);
        assert_eq!(same, case["sameAsSource"] == true, "{context}: круг через карту");
        assert_eq!(t::serialized_tactical_map_hash(raw), text(&case["sourceHash"]), "{context}: хеш записи");
        let actual = analyze(&map, &case["probes"], false).unwrap_or_else(|error| panic!("{context}: {error}"));
        assert_analysis(&actual, &case["analysis"], &context);
    }
}

#[test]
fn generated_maps_match_js() {
    for case in array(&FIXTURE["generated"]) {
        let context = format!("генератор {}", stringify(&case["input"]));
        let map = t::deserialize_tactical_map(&case["serialized"]).unwrap_or_else(|error| panic!("{context}: {error}"));
        let same = stringify(&serialize(&map).expect("сериализация")) == stringify(&case["serialized"]);
        assert_eq!(same, case["memoryStable"] == true, "{context}: круг через карту");
        let actual = analyze(&map, &case["probes"], false).unwrap_or_else(|error| panic!("{context}: {error}"));
        assert_analysis(&actual, &case["analysis"], &context);
    }
}

#[test]
fn dynamic_legacy_cells_match_js() {
    for case in array(&FIXTURE["dynamic"]) {
        let seed = text(&case["seed"]);
        let cells = array(&case["cells"]);
        let map = t::tactical_map_from_legacy_cells(cells, &LegacyMapOptions { location_id: "dyn", seed, ..LegacyMapOptions::default() }).expect("старые клетки");
        let plain = t::tactical_map_from_legacy_cells(cells, &LegacyMapOptions::default()).expect("старые клетки");
        let restored = Value::Array(t::legacy_cells_from_tactical_map(&plain));
        assert_eq!(stringify(&restored) == stringify(&case["cells"]), case["restoredEqual"] == true, "{seed}: круг через старые клетки");
        assert!(case["restoredEqual"] == true, "{seed}: в JS старые клетки обязаны вернуться побайтово");
        let actual = analyze(&map, &case["probes"], false).expect("разбор");
        assert_analysis(&actual, &case["analysis"], &format!("планировка {seed}"));
    }
}

fn options_from(options: &Value) -> (TacticalMapOptions<'_>, Option<CellPatchJson>) {
    let string = |key: &str| options.get(key).and_then(Value::as_str).unwrap_or("");
    let generator = options.get("generator").and_then(Value::as_object).map(|generator| (text(&generator["id"]), text(&generator["version"])));
    let revision = match text(&options["catalogRevision"]) {
        "current" => CatalogRevision::Current,
        "omit" => CatalogRevision::Omit,
        value => CatalogRevision::Value(value),
    };
    let parsed = TacticalMapOptions {
        width: int(&options["width"]),
        height: int(&options["height"]),
        location_id: string("locationId"),
        level_index: options.get("levelIndex").map_or(0, int),
        level_label: string("levelLabel"),
        seed: string("seed"),
        generator,
        theme: string("theme"),
        tileset_id: string("tilesetId"),
        size_class: string("sizeClass"),
        catalog_revision: revision,
        fill: None,
    };
    (parsed, options.get("fill").map(CellPatchJson::from_json))
}

fn bounds_from(value: &Value) -> t::Bounds {
    t::Bounds { min_x: int(&value["minX"]), min_y: int(&value["minY"]), max_x: int(&value["maxX"]), max_y: int(&value["maxY"]) }
}

fn dir(value: &Value) -> EdgeDir {
    EdgeDir::parse(text(value)).expect("направление")
}

fn undefined() -> Value {
    Value::String(UNDEFINED.into())
}

/// Одна операция программы; `Ok` — возвращённое значение в форме JS.
fn run_step(map: &mut Option<TacticalMap>, step: &Value) -> MapResult<Value> {
    let op = text(&step["op"]);
    if op == "create" {
        let (mut options, fill) = options_from(&step["options"]);
        options.fill = fill.as_ref().map(CellPatchJson::patch);
        *map = Some(t::create_tactical_map(&options)?);
        return Ok(undefined());
    }
    let current = map.as_mut().expect("карта создана");
    Ok(match op {
        "setCell" => {
            t::set_cell_json(current, int(&step["x"]), int(&step["y"]), &step["patch"])?;
            undefined()
        }
        "setEdge" => {
            let edge = t::set_edge_json(current, int(&step["ax"]), int(&step["ay"]), int(&step["bx"]), int(&step["by"]), &step["edge"])?;
            edge.map_or(Value::Null, |edge| edge.to_json())
        }
        "setDoor" => t::set_door(current, &step["door"])?.to_json(),
        "addProp" => t::add_prop(current, &step["prop"])?.to_json(),
        "addZone" => t::add_zone(current, &step["zone"])?.to_json(),
        "addSpawnPoint" => t::add_spawn_point(current, &step["point"])?.to_json(),
        "attach" => {
            let indices = t::attach_level_transitions(current, Some(&step["levels"]));
            json!(indices.into_iter().map(|index| current.props[index].id.clone()).collect::<Vec<_>>())
        }
        "setLevelIndex" => {
            current.level_index = int(&step["value"]);
            undefined()
        }
        "setDoorState" => {
            if !current.doors.is_empty() {
                let index = int(&step["index"]) as usize % current.doors.len();
                current.doors[index].state = text(&step["state"]).to_string();
            }
            undefined()
        }
        "removeEdge" => {
            current.remove_edge(int(&step["x"]), int(&step["y"]), dir(&step["dir"]));
            undefined()
        }
        "setEdgeKind" => {
            if let Some(edge) = current.edge_mut(int(&step["x"]), int(&step["y"]), dir(&step["dir"])) {
                edge.kind = t::EdgeKind::parse(text(&step["kind"])).expect("вид ребра");
            }
            undefined()
        }
        "zoneStyle" => {
            if let Some(zone) = current.zones.get_mut(int(&step["index"]) as usize) {
                let value = step["value"].as_str().map(str::to_string);
                if text(&step["key"]) == "floor" {
                    zone.set_floor(value);
                } else {
                    zone.set_wall(value);
                }
            }
            undefined()
        }
        "combatBounds" => {
            current.combat_bounds = (!step["value"].is_null()).then(|| bounds_from(&step["value"]));
            undefined()
        }
        "surroundings" => {
            current.surroundings = t::normalize_map_surroundings(Some(&step["value"]));
            undefined()
        }
        "recompute" => t::recompute_bounds(current).to_json(),
        "setBounds" => {
            current.bounds = bounds_from(&step["value"]);
            undefined()
        }
        "orient" => {
            let turned = t::orient_tactical_map(current.clone(), text(&step["side"]))?;
            *current = turned;
            undefined()
        }
        "roundtrip" => {
            let serialized = serialize(current)?;
            *current = t::deserialize_tactical_map(&parse(&stringify(&serialized)))?;
            undefined()
        }
        "setCatalogRevision" => {
            current.catalog_revision = Some(text(&step["value"]).to_string());
            undefined()
        }
        other => panic!("операция {other}"),
    })
}

#[track_caller]
fn assert_error(actual: &TacticalMapError, expected: &Value, context: &str) {
    assert_same(&error_json(actual), expected, context);
}

#[test]
fn api_programs_match_js() {
    let mut steps = 0;
    let mut failures = 0;
    let mut analysed = 0;
    for (number, program) in array(&FIXTURE["programs"]).iter().enumerate() {
        let mut map: Option<TacticalMap> = None;
        let ops = array(&program["ops"]);
        let results = array(&program["results"]);
        for (index, expected) in results.iter().enumerate() {
            let step = &ops[index];
            let context = format!("программа #{number}, шаг {index}: {}", stringify(step));
            match run_step(&mut map, step) {
                Ok(value) => {
                    let ok = expected.get("ok").unwrap_or_else(|| panic!("JS отказал ({}), Rust принял: {context}", expected["error"]));
                    assert_same(&value, ok, &context);
                }
                Err(error) => {
                    let wanted = expected.get("error").unwrap_or_else(|| panic!("JS принял, Rust отказал ({error:?}): {context}"));
                    assert_error(&error, wanted, &context);
                    failures += 1;
                }
            }
            steps += 1;
        }
        let analysis = &program["analysis"];
        if analysis.is_null() {
            continue;
        }
        let map = map.as_ref().expect("карта программы");
        let context = format!("программа #{number}, разбор");
        match analyze(map, &analysis["probes"], true) {
            Ok(actual) => {
                let expected = analysis.get("ok").unwrap_or_else(|| panic!("JS отказал в разборе ({}), Rust разобрал: {context}", analysis["error"]));
                assert_analysis(&actual, expected, &context);
                analysed += 1;
            }
            Err(error) => {
                assert_error(&error, &analysis["error"], &context);
                assert_same(&t::validate_tactical_map(map).to_json(), &analysis["validate"], &context);
            }
        }
    }
    assert!(steps > 8_000 && failures > 800 && analysed > 150, "шагов {steps}, отказов {failures}, разборов {analysed}");
}

#[test]
fn corrupted_maps_match_js() {
    let mut rejected = 0;
    for (number, case) in array(&FIXTURE["garbage"]).iter().enumerate() {
        let context = format!("запись #{number}: {}", stringify(&case["raw"]).chars().take(600).collect::<String>());
        let outcome = &case["outcome"];
        match t::deserialize_tactical_map(&case["raw"]) {
            Err(error) => {
                let wanted = outcome.get("error").unwrap_or_else(|| panic!("JS прочёл, Rust отказал ({error:?}): {context}"));
                assert_error(&error, wanted, &context);
                rejected += 1;
            }
            Ok(map) => {
                let expected = outcome.get("ok").unwrap_or_else(|| panic!("JS отказал ({}), Rust прочёл: {context}", outcome["error"]));
                let actual = match serialize(&map) {
                    Ok(serialized) => json!({
                        "serialized": hash(&serialized),
                        "legacy": hash(&Value::Array(t::legacy_cells_from_tactical_map(&map))),
                        "validate": t::validate_tactical_map(&map).to_json(),
                        "sizeClass": map.size_class,
                    }),
                    Err(error) => json!({ "serializeError": error_json(&error), "validate": t::validate_tactical_map(&map).to_json() }),
                };
                assert_same(&actual, expected, &context);
            }
        }
    }
    assert!(rejected > 80, "отказов: {rejected}");
}

#[test]
fn random_legacy_cells_match_js() {
    for (number, case) in array(&FIXTURE["legacyRandom"]).iter().enumerate() {
        let options = &case["options"];
        let string = |key: &str| options.get(key).and_then(Value::as_str).unwrap_or("");
        let generator = options.get("generator").map(|generator| (text(&generator["id"]), text(&generator["version"])));
        let parsed = LegacyMapOptions { location_id: string("locationId"), seed: string("seed"), generator, tileset_id: string("tilesetId") };
        let context = format!("старые клетки #{number}");
        let outcome = &case["outcome"];
        match t::tactical_map_from_legacy_cells(array(&case["cells"]), &parsed) {
            Err(error) => assert_error(&error, &outcome["error"], &context),
            Ok(map) => {
                let expected = outcome.get("ok").unwrap_or_else(|| panic!("JS отказал ({}), Rust построил: {context}", outcome["error"]));
                let actual = analyze(&map, &outcome["probes"], true).expect("разбор");
                assert_analysis(&actual, expected, &context);
            }
        }
    }
}

#[test]
fn small_helpers_match_js() {
    for case in array(&FIXTURE["variants"]) {
        let result = t::floor_variant_at(text(&case[0]), int(&case[1]), int(&case[2]), int(&case[3]) as u32);
        assert_eq!(json!(result), case[4], "floorVariantAt {}", stringify(case));
    }
    for case in array(&FIXTURE["surroundings"]) {
        let result = t::normalize_map_surroundings(arg(&case[0])).map_or(Value::Null, |value| value.to_json());
        assert_same(&result, &case[1], &stringify(&case[0]));
    }
    for case in array(&FIXTURE["sizeClasses"]) {
        assert_eq!(t::size_class_for(int(&case[0]), int(&case[1])), text(&case[2]), "{}", stringify(case));
    }
    for case in array(&FIXTURE["canonical"]) {
        let result = try_or(t::canonical_edge(int(&case[0]), int(&case[1]), int(&case[2]), int(&case[3])).map(|(x, y, dir)| json!({ "x": x, "y": y, "dir": dir.as_str() })));
        assert_same(&result, &case[4], &stringify(case));
    }
}
