//! Сверка `scene_themes` с эталоном JS (`fixtures/scene-themes.json`,
//! `fixtures/scene-themes-relief.json.gz`; генератор
//! `fixtures/gen-scene-themes.mjs`): каталог тем, опознание темы, граф зон,
//! пещера, открытая местность, петли, берег, поселение, сборка сцены — карта
//! байт в байт, тема, предупреждения, этажи и аудит играбельности
//! `sk_map_core::map_quality` на каждой карте; рельеф над синтетическими
//! клетками.

mod common;

use common::{array, assert_clean, dump, hash, layout_options, map_hash, par_check, section, seed_of, serialized, shortcut_options, stringify, strings, FIXTURE, RELIEF};
use serde_json::{json, Value};
use sk_core::{indexmap::IndexMap, js};
use sk_map_core::map_quality::audit_tactical_map;
use sk_settlements::graph_layout::{build_scene_from_graph, GraphLayoutOptions};
use sk_tactical::tactical_map::TacticalMap;
use sk_themes::scene_themes::{
    add_shortcut_loops, all_scene_themes, apply_open_terrain_relief, build_themed_scene, dress_water_edges, fallback_theme, fallback_theme_for, is_live_theme_value,
    layout_open_terrain, layout_organic_cave, layout_settlement, match_theme, resolve_scene_theme, scene_graph_for_theme, theme_by_id, theme_for, theme_from_map_request,
    ReliefLayout, TerrainCell, TerrainCells, TerrainPatch, OPEN_TERRAIN_GENERATOR_VERSION, OPEN_TERRAIN_LEVEL_FEET, OPEN_TERRAIN_MAX_STEP_FEET, OPEN_TERRAIN_MIN_PLATEAU,
    SCENE_THEME_IDS, THEME_MIN_SIZE,
};

fn audit_codes(map: &TacticalMap) -> Vec<String> {
    audit_tactical_map(map).problems.iter().map(|problem| problem.code.to_string()).collect()
}

fn label(case: &Value) -> &str {
    case["label"].as_str().unwrap_or("?")
}

#[test]
fn catalog_matches_js() {
    let meta = &FIXTURE["meta"][0];
    let themes = array(&meta["themes"]);
    let ours: Vec<_> = all_scene_themes().collect();
    assert_eq!(ours.len(), themes.len());
    for (theme, expected) in ours.iter().zip(themes) {
        assert_eq!(theme.id, expected["id"], "порядок тем");
        assert_eq!(stringify(theme.json()), stringify(&expected["json"]), "{}: объект темы", theme.id);
        match &expected["match"] {
            Value::Null => assert!(theme.match_source.is_none(), "{}: лишнее опознание", theme.id),
            found => {
                assert_eq!(theme.match_source, found["source"].as_str(), "{}: исходник match", theme.id);
                assert_eq!(found["flags"], "iu", "{}: флаги match", theme.id);
            }
        }
    }
    let ids: Vec<&str> = SCENE_THEME_IDS.iter().copied().collect();
    assert_eq!(json!(ids), meta["ids"]);
    assert_eq!(fallback_theme().id, meta["fallback"]);
    let min_size: serde_json::Map<String, Value> = THEME_MIN_SIZE.iter().map(|(id, size)| (id.to_string(), json!({ "width": size.width, "height": size.height }))).collect();
    assert_eq!(stringify(&Value::Object(min_size)), stringify(&meta["minSize"]));
    let constants = &meta["constants"];
    assert_eq!(constants["OPEN_TERRAIN_LEVEL_FEET"], OPEN_TERRAIN_LEVEL_FEET);
    assert_eq!(constants["OPEN_TERRAIN_MAX_STEP_FEET"], OPEN_TERRAIN_MAX_STEP_FEET);
    assert_eq!(constants["OPEN_TERRAIN_MIN_PLATEAU"], OPEN_TERRAIN_MIN_PLATEAU);
    assert_eq!(constants["OPEN_TERRAIN_GENERATOR_VERSION"], OPEN_TERRAIN_GENERATOR_VERSION);
}

#[test]
fn selection_matches_js() {
    let cases = section("select");
    assert!(cases.len() > 4_000, "случаев {}", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let input = &case["input"];
        let out = match case["fn"].as_str().expect("функция") {
            "match" => json!(match_theme(input).map(|theme| theme.id)),
            "themeFor" => json!(theme_for(input).id),
            "resolve" => json!(resolve_scene_theme(input).id),
            "fallback" => json!(fallback_theme_for(input).id),
            "request" => json!(theme_from_map_request(input).map(|theme| theme.id)),
            "live" => match input {
                Value::Null => json!(is_live_theme_value(None)),
                Value::String(id) => json!(is_live_theme_value(Some(theme_by_id(id).json()))),
                other => json!(is_live_theme_value(Some(other))),
            },
            other => panic!("функция {other}"),
        };
        if case.get("error").is_some() || out != case["out"] {
            failures.push(format!("{}({}): Rust {out}, JS {}", case["fn"], stringify(input), stringify(case.get("out").unwrap_or(&case["error"]))));
        }
    }
    assert_clean(&failures, cases.len());
}

#[test]
fn scene_graphs_match_js() {
    let cases = section("graphs");
    let mut failures = Vec::new();
    for case in cases {
        let seed = case["seed"].as_str().expect("сид");
        let graph = scene_graph_for_theme(&case["theme"], seed).expect("граф");
        let value = serde_json::to_value(&graph).expect("граф в JSON");
        if hash(&value) != case["graph"] {
            failures.push(format!("{}: граф {}", label(case), stringify(&value)));
        }
    }
    assert_clean(&failures, cases.len());
}

#[test]
fn organic_caves_match_js() {
    let cases = section("caves");
    let failures = par_check(cases, |case| {
        let seed = seed_of(&case["options"], "cave");
        let map = layout_organic_cave(&case["theme"], &layout_options(&case["options"], &seed)).expect("пещера");
        let mut failures = Vec::new();
        if case["mapHash"].as_str() != Some(map_hash(&map).as_str()) {
            failures.push(format!("{}: карта {}", label(case), dump(label(case), &serialized(&map))));
        } else if audit_codes(&map) != strings(&case["audit"]) {
            failures.push(format!("{}: аудит {:?}, JS {}", label(case), audit_codes(&map), case["audit"]));
        }
        failures
    });
    assert_clean(&failures, cases.len());
}

#[test]
fn open_terrain_matches_js() {
    let cases = section("open");
    assert!(cases.len() > 500);
    let failures = par_check(cases, |case| {
        let seed = seed_of(&case["options"], "open");
        let map = layout_open_terrain(&case["theme"], &layout_options(&case["options"], &seed)).expect("местность");
        let mut failures = Vec::new();
        if case["mapHash"].as_str() != Some(map_hash(&map).as_str()) {
            failures.push(format!("{}: карта {}", label(case), dump(label(case), &serialized(&map))));
        } else if audit_codes(&map) != strings(&case["audit"]) {
            failures.push(format!("{}: аудит {:?}, JS {}", label(case), audit_codes(&map), case["audit"]));
        }
        failures
    });
    assert_clean(&failures, cases.len());
}

/// Карта `buildSceneFromGraph(sceneGraphForTheme(theme, seed))` случая.
fn graph_map(case: &Value) -> TacticalMap {
    let theme = theme_by_id(case["theme"].as_str().expect("тема"));
    let seed = case["seed"].as_str().expect("сид");
    let graph = scene_graph_for_theme(theme.json(), seed).expect("граф");
    let options = GraphLayoutOptions {
        seed,
        width: js::number(case.get("width")),
        height: js::number(case.get("height")),
        location_id: "",
        theme: theme.id,
        material: theme.material().unwrap_or("stone"),
    };
    build_scene_from_graph(&graph, &options).expect("карта графа").map
}

#[test]
fn shortcut_loops_match_js() {
    let cases = section("shortcuts");
    let failures = par_check(cases, |case| {
        let mut map = graph_map(case);
        let opened = add_shortcut_loops(&mut map, &shortcut_options(&case["options"])).expect("петли");
        let mut failures = Vec::new();
        if case["opened"] != opened {
            failures.push(format!("{}: прорублено {opened}, JS {}", label(case), case["opened"]));
        }
        if case["mapHash"].as_str() != Some(map_hash(&map).as_str()) {
            failures.push(format!("{}: карта {}", label(case), dump(label(case), &serialized(&map))));
        }
        failures
    });
    assert_clean(&failures, cases.len());
}

#[test]
fn water_edges_match_js() {
    let cases = section("water");
    let failures = par_check(cases, |case| {
        let mut map = if case["base"] == "settlement" {
            layout_settlement(&case["theme"], &case["options"]).expect("поселение")
        } else {
            let seed = seed_of(&case["options"], "open");
            layout_open_terrain(&case["theme"], &layout_options(&case["options"], &seed)).expect("местность")
        };
        let placed = dress_water_edges(&mut map, &js::string(case.get("seed"))).expect("берег");
        let mut failures = Vec::new();
        if case["placed"] != placed {
            failures.push(format!("{}: поставлено {placed}, JS {}", label(case), case["placed"]));
        }
        if case["mapHash"].as_str() != Some(map_hash(&map).as_str()) {
            failures.push(format!("{}: карта {}", label(case), dump(label(case), &serialized(&map))));
        }
        failures
    });
    assert_clean(&failures, cases.len());
}

#[test]
fn layout_settlement_matches_js() {
    let cases = section("settlements");
    let failures = par_check(cases, |case| {
        let map = layout_settlement(&case["theme"], &case["options"]).expect("поселение");
        if case["mapHash"].as_str() != Some(map_hash(&map).as_str()) {
            return vec![format!("{}: карта {}", label(case), dump(label(case), &serialized(&map)))];
        }
        Vec::new()
    });
    assert_clean(&failures, cases.len());
}

#[test]
fn themed_scenes_match_js() {
    let cases = section("scenes");
    assert!(cases.len() > 1_500, "случаев {}", cases.len());
    assert!(cases.iter().filter(|case| label(case).starts_with("pipeline:")).count() > 150, "мало вызовов конвейера");
    let failures = par_check(cases, |case| {
        let name = label(case);
        let mut failures = Vec::new();
        match build_themed_scene(&case["options"]) {
            Err(error) => {
                if case.get("error") != Some(&error.to_json()) {
                    failures.push(format!("{name}: отказ Rust {}, JS {}", stringify(&error.to_json()), stringify(case.get("error").unwrap_or(&Value::Null))));
                }
            }
            Ok(built) => {
                if let Some(error) = case.get("error") {
                    failures.push(format!("{name}: Rust собрал карту, JS отказал {}", stringify(error)));
                    return failures;
                }
                if case["mapHash"].as_str() != Some(map_hash(&built.map).as_str()) {
                    failures.push(format!("{name}: карта Rust {}", dump(name, &serialized(&built.map))));
                    return failures;
                }
                if case["theme"] != built.theme.as_str() {
                    failures.push(format!("{name}: тема {}, JS {}", built.theme, case["theme"]));
                }
                if strings(&case["warnings"]) != built.warnings {
                    failures.push(format!("{name}: предупреждения {:?}, JS {}", built.warnings, case["warnings"]));
                }
                if case.get("levels") != built.levels_json().as_ref() {
                    failures.push(format!("{name}: этажи {:?}, JS {:?}", built.levels_json(), case.get("levels")));
                }
                let audit = audit_codes(&built.map);
                if audit != strings(&case["audit"]) {
                    failures.push(format!("{name}: аудит {audit:?}, JS {}", case["audit"]));
                }
            }
        }
        failures
    });
    assert_clean(&failures, cases.len());
}

#[test]
fn open_terrain_relief_matches_js() {
    let cases = array(&RELIEF["relief"]);
    let mut failures = Vec::new();
    for case in cases {
        let mut cells: TerrainCells = IndexMap::new();
        for entry in array(&case["cells"]) {
            let (x, y, patch) = (entry[0].as_i64().expect("x"), entry[1].as_i64().expect("y"), &entry[2]);
            let text = |key: &str| patch.get(key).and_then(Value::as_str).map(str::to_string);
            let patch = TerrainPatch {
                passable: patch["passable"] == true,
                material: text("material"),
                surface: text("surface"),
                move_cost: patch["moveCost"].as_f64().unwrap_or(1.0),
                zone: text("zone").unwrap_or_default(),
                variant: None,
                revealed: patch["revealed"] == true,
                elevation: None,
            };
            cells.insert((x, y), TerrainCell { x, y, patch });
        }
        let road_y = case["roadY"].as_i64();
        let on_road = |_: i64, y: i64| road_y.is_some_and(|road| (y - road).abs() <= 1);
        let layout = ReliefLayout {
            width: case["width"].as_i64().expect("ширина"),
            height: case["height"].as_i64().expect("высота"),
            entrance_y: case["entranceY"].as_i64().expect("вход"),
            on_road_at: &on_road,
        };
        apply_open_terrain_relief(&case["theme"], case["seed"].as_str().expect("сид"), &mut cells, &layout);
        let elevation: Vec<Value> = cells.values().map(|cell| json!(cell.patch.elevation)).collect();
        if Value::Array(elevation.clone()) != case["elevation"] {
            failures.push(format!("{}: высоты расходятся", label(case)));
        }
    }
    assert_clean(&failures, cases.len());
}
