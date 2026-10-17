//! Эталоны JS `fixtures/loot-containers.json.gz` (генератор
//! `fixtures/gen-loot-containers.mjs`) и перенос модульных проверок
//! `test/loot-containers.test.mjs`, `test/npc-loot-containers.test.mjs`.
//!
//! У `TypeError` сверяется только имя: текст V8 не переносится.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_director::loot_containers::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/loot-containers.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    serde_json::from_str(&text).expect("эталон JSON")
});

fn resolve(value: &Value) -> Value {
    match value.as_object().and_then(|map| map.get("$ref")).and_then(Value::as_u64) {
        Some(index) if value.as_object().is_some_and(|map| map.len() == 1) => FIXTURE["values"][index as usize].clone(),
        _ => value.clone(),
    }
}

fn args(entry: &Value) -> Vec<Option<Value>> {
    let undef: Vec<u64> = entry["undef"].as_array().map(|items| items.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    entry["args"].as_array().expect("аргументы").iter().enumerate().map(|(index, value)| (!undef.contains(&(index as u64))).then(|| resolve(value))).collect()
}

fn type_error() -> LootContainerError {
    LootContainerError { name: "TypeError", code: None, message: String::new() }
}

/// Вызов по имени экспорта JS: исход и (для редьюсера) состояние после.
fn call(fn_name: &str, args: &mut [Option<Value>]) -> (Result<Value, LootContainerError>, Option<Value>) {
    let empty = json!({});
    let empty_list = json!([]);
    let null = Value::Null;
    let a = |index: usize| args.get(index).and_then(Option::as_ref);
    let state_or_empty = |index: usize| a(index).unwrap_or(&empty);
    let result: Result<Value, LootContainerError> = (|| {
        Ok(match fn_name {
            "normalizeLootContainer" => normalize_loot_container(a(0)).unwrap_or(Value::Null),
            "normalizeLootContainersState" => normalize_loot_containers_state(a(0)),
            "lootContainerList" => Value::Array(loot_container_list(state_or_empty(0))),
            "lootContainerFor" => loot_container_for(state_or_empty(0), a(1)).unwrap_or(Value::Null),
            "sceneLootLocationKey" => Value::String(scene_loot_location_key(state_or_empty(0))?),
            "lootContainersInScene" => {
                let include = match a(1) {
                    None => false,
                    Some(Value::Null) => return Err(type_error()),
                    Some(options) => js::truthy(options.get("includeEmptied")),
                };
                Value::Array(loot_containers_in_scene(state_or_empty(0), include)?)
            }
            "lootContainerIdFor" => {
                if matches!(a(2), Some(Value::Null)) {
                    return Err(type_error());
                }
                let sources = match a(1) {
                    None => Vec::new(),
                    Some(Value::Array(items)) => items.clone(),
                    Some(other) => panic!("источники контейнера не массивом: {other}"),
                };
                Value::String(loot_container_id_for(a(0), &sources, a(2).unwrap_or(&empty)))
            }
            "lootCommitTouchesContainers" => Value::Bool(loot_commit_touches_containers(state_or_empty(0), a(1).unwrap_or(&empty_list))),
            "planLootContainerDrafts" => Value::Array(plan_loot_container_drafts(state_or_empty(0), state_or_empty(1), a(2).unwrap_or(&empty_list))?),
            "normalizeLootLines" => Value::Array(normalize_loot_lines(a(0))),
            "thrownWeaponDropDraft" => {
                let info = match a(1) {
                    None => ThrownWeaponInfo::default(),
                    Some(Value::Null) => return Err(type_error()),
                    Some(info) => ThrownWeaponInfo { command_id: info.get("commandId"), owner_id: info.get("ownerId"), item: info.get("item"), position: info.get("position") },
                };
                thrown_weapon_drop_draft(state_or_empty(0), info)?.unwrap_or(Value::Null)
            }
            "lootCombatActionFor" => js::opt_str(loot_combat_action_for(state_or_empty(0), a(1), a(2))),
            "inventoryItemFromInstance" => {
                let options = a(1).unwrap_or(&empty);
                let id = options["id"].as_str().expect("id строкой");
                let quantity = options["quantity"].as_i64().expect("quantity целым");
                inventory_item_from_instance(a(0).unwrap_or(&null), id, quantity, options.get("containerKind").and_then(Value::as_str).unwrap_or(""))
            }
            "validateLootContainerCommand" => validate_loot_container_command(a(0).unwrap_or(&null), state_or_empty(1), a(2).unwrap_or(&empty))?,
            "lootContainerCommandEvents" => Value::Array(loot_container_command_events(a(0).unwrap_or(&null))?),
            "lootItemForViewer" => loot_item_for_viewer(state_or_empty(0))?,
            "lootContainerReachFor" => loot_container_reach_for(state_or_empty(0), a(1), a(2).unwrap_or(&empty))?,
            "lootContainerForViewer" => {
                let options = match a(1) {
                    None => ContainerViewOptions::default(),
                    Some(Value::Null) => return Err(type_error()),
                    Some(options) => ContainerViewOptions { with_contents: options.get("withContents"), distance_feet: options.get("distanceFeet"), cell_revealed: options.get("cellRevealed") },
                };
                loot_container_for_viewer(state_or_empty(0), options).unwrap_or(Value::Null)
            }
            "lootContainersForViewer" => match a(1) {
                None => loot_containers_for_viewer(state_or_empty(0), None, None)?,
                Some(Value::Null) => return Err(type_error()),
                Some(options) => loot_containers_for_viewer(state_or_empty(0), options.get("actorId"), options.get("isAdmin"))?,
            },
            "applyLootContainerEvent" => return Err(type_error()),
            other => panic!("неизвестная функция эталона: {other}"),
        })
    })();
    if fn_name == "applyLootContainerEvent" {
        let event = args.get(1).cloned().flatten().unwrap_or(Value::Null);
        let mut state = args[0].take().unwrap_or(Value::Null);
        let result = apply_loot_container_event(&mut state, &event).map(|ids| json!(ids));
        return (result, Some(state));
    }
    (result, None)
}

fn error_json(error: &LootContainerError) -> Value {
    if error.name == "TypeError" {
        json!({ "name": "TypeError" })
    } else {
        error.to_json()
    }
}

#[test]
fn loot_container_calls_match_js() {
    let cases = FIXTURE["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in cases {
        let fn_name = case["fn"].as_str().expect("fn");
        let label = format!("{fn_name} {} {}", case["label"].as_str().unwrap_or(""), js::stringify(&case["args"]).chars().take(200).collect::<String>());
        let mut call_args = args(case);
        let (result, state) = call(fn_name, &mut call_args);
        let actual = match &result {
            Ok(value) => match &state {
                Some(state) => json!({ "out": value, "state": state }),
                None => json!({ "out": value }),
            },
            Err(error) => json!({ "error": error_json(error) }),
        };
        let expected = match case.get("error") {
            Some(error) if error["name"] == "TypeError" => json!({ "error": { "name": "TypeError" } }),
            Some(error) => json!({ "error": error }),
            None => match case.get("state") {
                Some(state) => json!({ "out": case["out"], "state": state }),
                None => json!({ "out": case["out"] }),
            },
        };
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!(
                "{label}\n  JS:   {}\n  Rust: {}",
                js::stringify(&expected).chars().take(900).collect::<String>(),
                js::stringify(&actual).chars().take(900).collect::<String>()
            ));
        }
    }
    let mut by_fn = std::collections::BTreeMap::new();
    for failure in &failures {
        *by_fn.entry(failure.split(' ').next().unwrap_or("").to_string()).or_insert(0) += 1;
    }
    assert!(failures.is_empty(), "{} расхождений из {} ({by_fn:?}):\n{}", failures.len(), cases.len(), failures.iter().take(6).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() > 5_000, "вызовов: {}", cases.len());
}
