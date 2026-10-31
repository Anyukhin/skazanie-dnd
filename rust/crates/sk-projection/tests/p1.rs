//! Эталоны JS задачи П1 (`fixtures/p1.json.gz`, генератор `fixtures/gen-p1.mjs`):
//! вызовы из тестов JS, корпус паритета × зрители, синтетика с закрытыми полями
//! и мусор. Сверка — хеш `JSON.stringify` целиком (`js::stringify`), имя
//! исключения и отдельно — список закрытых маркеров, попавших в выход.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::Value;
use sk_core::{hash, js};
use sk_projection::trace_store::{build_turn_explanation, is_mechanical_trace, migrate_trace_to_v2, redact_trace, FileTraceStore};
use sk_projection::viewer_projection::*;
use sk_tactics::combat_forecast_view::with_combat_forecast;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/p1.json.gz")[..]).read_to_string(&mut text).expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Аргументы вызова: `None` — `undefined`.
fn args(entry: &Value) -> Vec<Option<Value>> {
    let mut list: Vec<Option<Value>> = entry["args"].as_array().cloned().unwrap_or_default().into_iter().map(Some).collect();
    for index in entry.get("undef").and_then(Value::as_array).into_iter().flatten() {
        if let Some(slot) = index.as_u64().and_then(|index| list.get_mut(index as usize)) {
            *slot = None;
        }
    }
    list
}

fn arg(list: &[Option<Value>], index: usize) -> Option<&Value> {
    list.get(index).and_then(Option::as_ref)
}

type Got = Result<Option<Value>, String>;

fn err(error: ProjectionError) -> String {
    error.name
}

/// `publicActorFootprintFor(actor, { hideMasked = true } = {})`.
fn hide_masked(options: Option<&Value>) -> Result<bool, String> {
    match options {
        None => Ok(true),
        Some(Value::Null) => Err("TypeError".into()),
        Some(value) => Ok(match value.get("hideMasked") {
            None => true,
            other => js::truthy(other),
        }),
    }
}

fn run(name: &str, list: &[Option<Value>]) -> Got {
    let a = |index| arg(list, index);
    match name {
        "campaignStateForViewer" => campaign_state_for_viewer(a(0), a(1), a(2)).map_err(err),
        "mechanicsForViewer" => mechanics_for_viewer(a(0), a(1), a(2), a(3)).map_err(err),
        "turnExplanationForViewer" => turn_explanation_for_viewer(a(0), a(1), a(2), a(3)).map_err(err),
        "turnResultForViewer" => turn_result_for_viewer(a(0), a(1), a(2)).map_err(err),
        "sceneTransitionForViewer" => scene_transition_for_viewer(a(0)).map_err(err),
        "publicSceneFor" => public_scene_for(a(0), a(1)).map(Some).map_err(err),
        "publicWorldMapFor" => public_world_map_for(a(0)).map(Some).map_err(err),
        "publicAdventureFor" => public_adventure_for(a(0)).map(Some).map_err(err),
        "publicEnemyFor" => public_enemy_for(a(0), a(1), a(2)).map(Some).map_err(err),
        "publicEncounterFor" => Ok(Some(public_encounter_for(a(0)).unwrap_or(Value::Null))),
        "publicTacticalMapFor" => public_tactical_map_for(a(0)).map(|value| Some(value.unwrap_or(Value::Null))).map_err(err),
        "publicTacticalMapWithHashFor" => public_tactical_map_with_hash_for(a(0)).map(|value| Some(value.unwrap_or(Value::Null))).map_err(err),
        "publicActorFootprintFor" => Ok(public_actor_footprint_for(a(0), hide_masked(a(1))?)),
        "actorAppearancesForViewer" => {
            if matches!(a(0), Some(Value::Null)) {
                return Err("TypeError".into());
            }
            Ok(Some(actor_appearances_for_viewer(a(0))))
        }
        "redactTrace" => Ok(redact_trace(a(0))),
        "migrateTraceToV2" => Ok(migrate_trace_to_v2(a(0))),
        "buildTurnExplanation" => Ok(Some(build_turn_explanation(a(0), a(1)))),
        "isMechanicalTrace" => Ok(Some(Value::Bool(is_mechanical_trace(a(0))))),
        "viewerState" => {
            let projected = campaign_state_for_viewer(a(0), a(1), a(2)).map_err(err)?;
            with_combat_forecast(projected.as_ref(), a(0), a(2)).map_err(|error| format!("{error:?}"))
        }
        other => Err(format!("неизвестная функция {other}")),
    }
}

/// Расхождение с эталоном или `None`.
fn compare(entry: &Value, got: &Got) -> Option<String> {
    match got {
        Err(name) => match entry.get("error") {
            Some(expected) if expected.as_str() == Some(name.as_str()) => None,
            Some(expected) => Some(format!("исключение {name}, в JS {expected}")),
            None => Some(format!("исключение {name}, в JS — значение")),
        },
        Ok(None) => (!entry.get("out_undefined").is_some_and(|flag| flag == true)).then(|| format!("undefined, в JS {}", head(&entry.to_string()))),
        Ok(Some(value)) => {
            if let Some(expected) = entry.get("error") {
                return Some(format!("значение, в JS исключение {expected}"));
            }
            let text = js::stringify(value);
            if let Some(out) = entry.get("out") {
                return (js::stringify(out) != text).then(|| format!("выход {}\n   JS {}", head(&text), head(&js::stringify(out))));
            }
            if let Some(expected) = entry.get("out_hash").and_then(Value::as_str) {
                return (hash::sha256_hex(&text) != expected).then(|| format!("хеш, выход {}", head(&text)));
            }
            Some("в JS undefined".into())
        }
    }
}

fn head(text: &str) -> String {
    text.chars().take(600).collect()
}

fn report(name: &str, failures: &[String], total: usize) {
    if !failures.is_empty() {
        let shown: Vec<&String> = failures.iter().take(12).collect();
        panic!("{name}: {} из {total} расходятся с JS:\n{}", failures.len(), shown.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n"));
    }
}

/// Закрытые маркеры в значении — тот же обход, что `leaksOf` генератора.
fn leaks_of(value: &Value) -> Vec<String> {
    fn markers(text: &str, found: &mut std::collections::BTreeSet<String>) {
        let mut rest = text;
        while let Some(position) = rest.find("SECRET-") {
            let tail = &rest[position..];
            let end = tail[7..].find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')).map_or(tail.len(), |index| index + 7);
            if end > 7 {
                found.insert(tail[..end].to_string());
            }
            rest = &tail[7..];
        }
    }
    fn walk(node: &Value, found: &mut std::collections::BTreeSet<String>) {
        match node {
            Value::String(text) => markers(text, found),
            Value::Number(number) => {
                if let Some(value) = number.as_f64().filter(|value| (9871.0..=9879.0).contains(value)) {
                    found.insert(js::f64_string(value));
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, found)),
            Value::Object(map) => {
                for (key, child) in map {
                    markers(key, found);
                    walk(child, found);
                }
            }
            _ => {}
        }
    }
    let mut found = std::collections::BTreeSet::new();
    walk(value, &mut found);
    found.into_iter().collect()
}

#[test]
fn calls_match_js() {
    let cases = section("calls");
    assert!(cases.len() > 1000, "эталон полон: {}", cases.len());
    let mut failures = Vec::new();
    let mut leak_cases = 0;
    let mut neighbor = Vec::new();
    for (index, entry) in cases.iter().enumerate() {
        let name = entry["fn"].as_str().unwrap_or("");
        let got = run(name, &args(entry));
        if let (Some(module), Ok(_)) = (entry.get("error_in").and_then(Value::as_str), &got) {
            // Исключение JS брошено соседним модулем на мусоре (`TypeError` в
            // `npc-social`, `merchant-economy`, `quest-consequences`): их Rust не
            // бросает — расхождение соседнего крейта, а не этого модуля.
            neighbor.push(format!("#{index} {name}: {module}"));
            continue;
        }
        if let Some(mismatch) = compare(entry, &got) {
            failures.push(format!("#{index} {name} [{}]: {mismatch}", entry.get("test").and_then(Value::as_str).unwrap_or("")));
            continue;
        }
        if let (Some(expected), Ok(Some(value))) = (entry.get("leaks"), &got) {
            leak_cases += 1;
            let leaks = leaks_of(value);
            let expected: Vec<String> = expected.as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
            if leaks != expected {
                failures.push(format!("#{index} {name}: утечки {leaks:?}, в JS {expected:?}"));
            }
        }
    }
    assert!(leak_cases >= 40, "случаев с проверкой утечек: {leak_cases}");
    assert!(neighbor.len() <= 7, "исключений соседних модулей больше известных: {neighbor:?}");
    report("calls", &failures, cases.len());
}

/// Синтетика с закрытыми полями: игроку, зрителю и гостю без доступа не
/// уходит ни один закрытый маркер. Исключение — собственные режимы реакций
/// героя-зрителя `ally`.
#[test]
fn closed_fields_do_not_leak() {
    let mut strict = 0;
    for entry in section("calls").iter().filter(|entry| entry.get("strict").is_some()) {
        let list = args(entry);
        let name = entry["fn"].as_str().unwrap_or("");
        let Ok(Some(value)) = run(name, &list) else { panic!("{name}: проекция не собралась") };
        let own_ally = arg(&list, 2).and_then(Value::as_str) == Some("ally");
        let leaks: Vec<String> = leaks_of(&value).into_iter().filter(|marker| !(own_ally && marker == "SECRET-pref")).collect();
        assert!(leaks.is_empty(), "{name} для {:?}: утекло {leaks:?}", arg(&list, 1));
        strict += 1;
    }
    assert!(strict >= 25, "строгих случаев: {strict}");
}

/// Подставить состояние корпуса в аргументы по пути `slot`.
fn with_state(entry: &Value, states: &[Value]) -> Vec<Option<Value>> {
    let mut list = args(entry);
    let state = states.get(entry["state"].as_u64().unwrap_or(0) as usize).cloned().unwrap_or(Value::Null);
    let path: Vec<&Value> = entry["slot"].as_array().map(|items| items.iter().collect()).unwrap_or_default();
    let Some(first) = path.first().and_then(|value| value.as_u64()) else { return list };
    if path.len() == 1 {
        if let Some(slot) = list.get_mut(first as usize) {
            *slot = Some(state);
        }
        return list;
    }
    let mut target = list.get_mut(first as usize).and_then(Option::as_mut);
    for key in &path[1..path.len() - 1] {
        target = target.and_then(|value| value.get_mut(key.as_str().unwrap_or("")));
    }
    if let (Some(Value::Object(map)), Some(key)) = (target, path.last().and_then(|value| value.as_str())) {
        map.insert(key.to_string(), state);
    }
    list
}

#[test]
fn corpus_matches_js() {
    let states = section("states");
    let cases = section("corpus");
    assert!(cases.len() > 1000, "корпус полон: {}", cases.len());
    let mut failures = Vec::new();
    for (index, entry) in cases.iter().enumerate() {
        let name = entry["fn"].as_str().unwrap_or("");
        let got = run(name, &with_state(entry, states));
        if let Some(mismatch) = compare(entry, &got) {
            failures.push(format!("#{index} {name} state {} viewer {}: {mismatch}", entry["state"], js::stringify(&entry["args"][1])));
        }
    }
    report("corpus", &failures, cases.len());
}

#[test]
fn trace_saves_match_js() {
    let root = std::env::temp_dir().join(format!("sk-p1-traces-{}", hash::uuid_v4()));
    let store = FileTraceStore::new(&root).expect("хранилище");
    for entry in section("saves") {
        let input = &entry["input"];
        let result = store.save(input);
        match (entry.get("out"), entry.get("error"), result) {
            (Some(out), _, Ok(trace)) => assert_eq!(js::stringify(&trace), js::stringify(out), "трасса {input}"),
            (None, Some(_), Err(error)) => {
                let message = entry["message"].as_str().unwrap_or("");
                assert_eq!(error.to_string(), format!("TypeError: {message}"), "отказ {input}");
            }
            (None, None, Ok(_)) => {}
            (_, _, other) => panic!("трасса {input}: {other:?}"),
        }
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn fixture_states_are_objects() {
    assert!(section("states").len() > 100);
    assert!(section("states").iter().all(|state| matches!(state, Value::Object(map) if !map.is_empty())));
}
