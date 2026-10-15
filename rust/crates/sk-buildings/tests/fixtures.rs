//! Сверка `building_generator` с эталоном JS (`fixtures/building-generator.json`,
//! `fixtures/pipeline-transitions.json.gz`; генератор
//! `fixtures/gen-building-generator.mjs`): карта байт в байт, ступень отката,
//! предупреждения, аудит играбельности `sk_map_core::map_quality` на каждой
//! карте, достижимость, пригодность, четверти зала и обставленные клетки;
//! программы проёмов и переходов над построенными картами; `planRooms`;
//! вызовы `ensureDeclaredTransitions` конвейером над картами поселений.

mod common;

use common::{array, build_case, dump, hash, map_hash, par_check, parse_gz, run, serialized, stringify, FIXTURE};
use serde_json::{json, Value};
use sk_buildings::building_generator::{
    edges_around, ensure_declared_transitions, furnished_cells, open_doorway, open_window, plan_rooms, quarters_json, reachability_issues, room_quarters,
    tactical_fitness_warnings, EdgesAroundOptions, Rect,
};
use sk_map_core::map_quality::audit_tactical_map;
use sk_tactical::tactical_map::deserialize_tactical_map;

fn strings(value: &Value) -> Vec<String> {
    array(value).iter().map(|item| item.as_str().expect("строка").to_string()).collect()
}

#[test]
fn building_cases_match_js() {
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 1_200, "случаев {}", cases.len());
    let failures = par_check(cases, |case| {
        let label = case["label"].as_str().expect("метка");
        let function = case["fn"].as_str().expect("функция");
        let mut failures = Vec::new();
        match run(function, &case["options"]) {
            Err(error) => {
                if case.get("error") != Some(&error.to_json()) {
                    failures.push(format!("{label}: отказ Rust {}, JS {}", stringify(&error.to_json()), stringify(case.get("error").unwrap_or(&Value::Null))));
                }
            }
            Ok(built) => {
                if case.get("error").is_some() {
                    failures.push(format!("{label}: Rust собрал карту, JS отказал {}", stringify(&case["error"])));
                    return failures;
                }
                let map = &built.map;
                if case["mapHash"].as_str() != Some(map_hash(map).as_str()) {
                    failures.push(format!("{label}: карта Rust {}", dump(label, &serialized(map))));
                    return failures;
                }
                if let Some(fallback) = built.fallback {
                    if case["fallback"] != fallback {
                        failures.push(format!("{label}: откат {fallback}, JS {}", case["fallback"]));
                    }
                    if Some(strings(&case["warnings"])) != built.warnings {
                        failures.push(format!("{label}: предупреждения {:?}, JS {}", built.warnings, case["warnings"]));
                    }
                }
                let audit: Vec<String> = audit_tactical_map(map).problems.iter().map(|problem| problem.code.to_string()).collect();
                if audit != strings(&case["audit"]) {
                    failures.push(format!("{label}: аудит {audit:?}, JS {}", case["audit"]));
                }
                if reachability_issues(map) != strings(&case["reach"]) {
                    failures.push(format!("{label}: достижимость {:?}", reachability_issues(map)));
                }
                if tactical_fitness_warnings(map) != strings(&case["fitness"]) {
                    failures.push(format!("{label}: пригодность {:?}", tactical_fitness_warnings(map)));
                }
                if hash(&quarters_json(&room_quarters(map, "hall"))) != case["quarters"].as_str().unwrap_or_default() {
                    failures.push(format!("{label}: четверти зала"));
                }
                let furnished = Value::Array(furnished_cells(map).iter().map(|(x, y)| Value::String(format!("{x},{y}"))).collect());
                if hash(&furnished) != case["furnished"].as_str().unwrap_or_default() {
                    failures.push(format!("{label}: обставленные клетки"));
                }
                if let Some(pipeline) = case.get("pipelineHash") {
                    if pipeline != &case["mapHash"] {
                        failures.push(format!("{label}: карта конвейера не совпала с картой входа"));
                    }
                }
                if let Some(fallback) = case.get("pipelineFallback") {
                    if fallback != &case["fallback"] {
                        failures.push(format!("{label}: откат конвейера"));
                    }
                }
            }
        }
        failures
    });
    assert!(failures.is_empty(), "расхождений {}:\n{}", failures.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

/// Инвариант AGENTS.md §5: сгенерированная карта играбельна. Сборка первой
/// ступени (`fallback: none`) проходит аудит `map_quality` начисто — дверь
/// наружу, окна, комнаты, досягаемость, мебель не в проёмах и не за краем.
#[test]
fn first_attempt_maps_pass_playability_audit() {
    let cases: Vec<&Value> = array(&FIXTURE["cases"]).iter().filter(|case| case["fn"] == "build" && case["fallback"] == "none").collect();
    assert!(cases.len() > 800, "случаев {}", cases.len());
    let failures = par_check(&cases, |case| {
        let label = case["label"].as_str().expect("метка");
        let built = run("build", &case["options"]).expect("сборка");
        let problems: Vec<&str> = audit_tactical_map(&built.map).problems.iter().map(|problem| problem.code).collect();
        if problems.is_empty() && reachability_issues(&built.map).is_empty() {
            Vec::new()
        } else {
            vec![format!("{label}: {problems:?}")]
        }
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn opening_programs_match_js() {
    let programs = array(&FIXTURE["ops"]);
    assert!(programs.len() > 150, "программ {}", programs.len());
    let failures = par_check(programs, |program| {
        let label = program["label"].as_str().expect("метка");
        let mut map = build_case(label).map;
        let expected = array(&program["steps"]);
        let mut failures = Vec::new();
        for (index, op) in array(&program["ops"]).iter().enumerate() {
            let Some(step) = expected.get(index) else { break };
            let at = |key: &str| op[key].as_i64().expect("координата");
            let outcome = match op["op"].as_str().expect("операция") {
                "openDoorway" => open_doorway(&mut map, at("x"), at("y"), op["id"].as_str().expect("id")),
                "openWindow" => open_window(&mut map, at("x"), at("y")),
                "edgesAround" => edges_around(&mut map, at("x"), at("y"), op["kind"].as_str().expect("вид"), &EdgesAroundOptions::from_json(&op["options"])),
                _ => ensure_declared_transitions(&mut map, &op["levels"], op["zoneId"].as_str().expect("зона")),
            };
            let actual = match outcome {
                Ok(()) => Value::String(map_hash(&map)),
                Err(error) => json!({ "error": { "name": error.name, "code": error.code, "message": error.message } }),
            };
            if &actual != step {
                failures.push(format!("{label}: шаг {index} {} — Rust {}, JS {}", stringify(op), stringify(&actual), stringify(step)));
                break;
            }
        }
        failures
    });
    assert!(failures.is_empty(), "расхождений {}:\n{}", failures.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn reachability_and_fitness_on_damaged_maps_match_js() {
    let probes = array(&FIXTURE["probes"]);
    assert!(probes.len() > 300, "проб {}", probes.len());
    let mut partial = 0;
    for probe in probes {
        let label = probe["label"].as_str().expect("метка");
        let mut map = build_case(label).map;
        for block in array(&probe["blocks"]) {
            let (x, y) = (block[0].as_i64().expect("x"), block[1].as_i64().expect("y"));
            sk_tactical::tactical_map::set_cell(&mut map, x, y, &sk_tactical::tactical_map::CellPatch { passable: Some(false), ..Default::default() }).expect("клетка");
        }
        if probe["dropSpawn"] == true {
            map.spawn_points.clear();
        }
        assert_eq!(reachability_issues(&map), strings(&probe["reach"]), "{label}: достижимость");
        assert_eq!(tactical_fitness_warnings(&map), strings(&probe["fitness"]), "{label}: пригодность");
        assert_eq!(hash(&quarters_json(&room_quarters(&map, "hall"))), probe["quarters"].as_str().unwrap_or_default(), "{label}: четверти");
        let furnished = Value::Array(furnished_cells(&map).iter().map(|(x, y)| Value::String(format!("{x},{y}"))).collect());
        assert_eq!(hash(&furnished), probe["furnished"].as_str().unwrap_or_default(), "{label}: обставленные клетки");
        // Зона, достижимая наполовину, — не замечание: так и в JS.
        if probe["reach"] == json!([]) && map.spawn_points.first().is_some() {
            partial += 1;
        }
    }
    assert!(partial > 0);
}

#[test]
fn plan_rooms_matches_js() {
    let cases = array(&FIXTURE["planRooms"]);
    assert!(cases.len() > 100);
    for case in cases {
        let interior = &case["interior"];
        let at = |key: &str| interior[key].as_i64().expect("координата");
        let plan = plan_rooms(Rect { min_x: at("minX"), min_y: at("minY"), max_x: at("maxX"), max_y: at("maxY") });
        assert_eq!(stringify(&plan.to_json()), stringify(&case["plan"]), "{}", stringify(interior));
    }
}

#[test]
fn pipeline_transitions_on_settlement_maps_match_js() {
    let fixture = parse_gz(include_bytes!("../fixtures/pipeline-transitions.json.gz"));
    let calls = array(&fixture["transitions"]);
    assert!(calls.len() > 20, "вызовов {}", calls.len());
    let mut placed = 0;
    for (index, call) in calls.iter().enumerate() {
        let mut map = deserialize_tactical_map(&call["before"]).expect("карта читается");
        assert_eq!(map_hash(&map), hash(&call["before"]), "№{index}: карта до вызова");
        let before = map.props.len();
        let outcome = ensure_declared_transitions(&mut map, &call["levels"], call["zoneId"].as_str().expect("зона"));
        match outcome {
            Ok(()) => assert_eq!(Some(map_hash(&map).as_str()), call["mapHash"].as_str(), "№{index}: карта после вызова {}", dump(&format!("transition-{index}"), &serialized(&map))),
            Err(error) => assert_eq!(json!({ "name": error.name, "code": error.code, "message": error.message }), call["error"], "№{index}"),
        }
        placed += map.props.len() - before;
    }
    assert!(placed > 0, "ни одной лестницы не поставлено");
}
