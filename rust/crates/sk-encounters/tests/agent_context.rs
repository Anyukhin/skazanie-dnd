//! Сверка `agent_context` с эталоном JS (`fixtures/agent-context.json`,
//! генератор `fixtures/gen-agent-context.mjs`): состояния тестов модуля,
//! выборка корпуса паритета, сцены генератора и их правки заплатками;
//! побитная сверка `Math.atan2`/`Math.hypot` с `sk_core::v8math`; перенос
//! проверок из `test/agent-context.test.mjs` и `test/agent-context-contract.test.mjs`.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js, v8math};
use sk_encounters::agent_context::{self as ac, AgentContextOptions, SelectionOptions};
use sk_tactical::tactical_map::{self as tm, CellPatch, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/agent-context.json")).expect("эталон JSON"));

const UNDEFINED: &str = "\u{0}undefined";
const BLOB_KEYS: [&str; 10] = ["worldMemory", "campaignConcept", "campaign_concept", "worldMap", "social", "npc_world", "messages", "players", "enemies", "mechanics"];

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).expect("массив в эталоне")
}

fn arg(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.as_str() != Some(UNDEFINED))
}

/// Ссылка `{"$map": индекс}` → поддерево из `maps`.
fn restore(slot: &mut Value) {
    if let Some(index) = slot.get("$map").and_then(Value::as_u64) {
        *slot = array(&FIXTURE["maps"])[index as usize].clone();
    }
}

fn state_at(index: usize) -> Value {
    let mut state = array(&FIXTURE["states"])[index].clone();
    if let Some(map) = state.pointer_mut("/scene/map") {
        restore(map);
    }
    for key in BLOB_KEYS {
        if let Some(slot) = state.get_mut(key) {
            restore(slot);
        }
    }
    state
}

/// `setPath` генератора: недостающие и не-контейнеры по пути — новые `{}`
/// (дальше строка) или `[]` (дальше индекс); `undefined` удаляет.
fn set_path(target: &mut Value, path: &[Value], value: Option<Value>) {
    let mut current = target;
    for (index, key) in path[..path.len() - 1].iter().enumerate() {
        let next_is_index = path[index + 1].is_number();
        let fresh = || if next_is_index { json!([]) } else { json!({}) };
        let suitable = |child: Option<&Value>| child.is_some_and(|child| (child.is_object() || child.is_array()) && child.is_array() == next_is_index);
        current = match (current, key) {
            (Value::Array(items), Value::Number(position)) => {
                let position = position.as_u64().expect("индекс") as usize;
                if !suitable(items.get(position)) {
                    if position == items.len() {
                        items.push(fresh());
                    } else {
                        items[position] = fresh();
                    }
                }
                &mut items[position]
            }
            (Value::Object(map), Value::String(name)) => {
                if !suitable(map.get(name)) {
                    map.insert(name.clone(), fresh());
                }
                map.get_mut(name).expect("ключ вставлен")
            }
            (other, key) => panic!("путь заплатки не сходится: {other} [{key}]"),
        };
    }
    match (current, path.last().expect("путь")) {
        (Value::Array(items), Value::Number(position)) => {
            let position = position.as_u64().expect("индекс") as usize;
            match value {
                None => {
                    items.remove(position);
                }
                Some(value) if position == items.len() => items.push(value),
                Some(value) => items[position] = value,
            }
        }
        (Value::Object(map), Value::String(name)) => match value {
            None => {
                map.shift_remove(name);
            }
            Some(value) => {
                map.insert(name.clone(), value);
            }
        },
        (other, key) => panic!("путь заплатки не сходится: {other} [{key}]"),
    }
}

/// `outcome` генератора: малый ответ целиком, крупный — SHA-256.
fn outcome(value: Value) -> Value {
    let text = js::stringify(&value);
    if text.encode_utf16().count() > 600 {
        json!({ "hash": hash::sha256_hex(&text) })
    } else {
        json!({ "result": value })
    }
}

fn options_from(value: Option<&Value>) -> AgentContextOptions<'_> {
    let field = |key: &str| value.and_then(|value| value.get(key));
    AgentContextOptions { role: field("role"), actor_id: field("actorId"), target_id: field("targetId"), contract_version: field("contractVersion") }
}

fn run_case(case: &Value) -> Value {
    let mut state = state_at(case["state"].as_u64().expect("индекс состояния") as usize);
    for step in case.get("patch").map(array).unwrap_or(&[]) {
        set_path(&mut state, array(&step[0]), arg(Some(&step[1])).cloned());
    }
    let actor = arg(case.get("actor"));
    let value = match case["fn"].as_str().expect("функция") {
        "sceneContextForAgent" => ac::scene_context_for_agent(&state, actor),
        "fieldSummaryFor" => ac::field_summary_for(&state, None).unwrap_or(Value::Null),
        "heroCardForAgent" => ac::hero_card_for_agent(&state, actor).unwrap_or(Value::Null),
        "campaignConceptForAgent" => ac::campaign_concept_for_agent(&state, arg(case.get("viewer"))),
        "sceneCanonFor" => json!(ac::scene_canon_for(&state)),
        "npcKnownByName" => Value::Bool(ac::npc_known_by_name(&state, &case["npc"])),
        "agentContextMetadata" => ac::agent_context_metadata(&state, &options_from(arg(case.get("options")))),
        other => panic!("неизвестная функция {other}"),
    };
    outcome(value)
}

#[test]
fn constants_match_js() {
    assert_eq!(FIXTURE["constants"]["AGENT_CONTEXT_SCHEMA_VERSION"], ac::AGENT_CONTEXT_SCHEMA_VERSION);
    assert_eq!(FIXTURE["constants"]["SPATIAL_CONTEXT_SCHEMA_VERSION"], ac::SPATIAL_CONTEXT_SCHEMA_VERSION);
}

#[test]
fn corpus_generated_and_patched_states_match_js() {
    let cases = array(&FIXTURE["cases"]);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let actual = run_case(case);
        if actual != case["out"] {
            failures.push(format!("#{index} {} {} actor={:?}\n  Rust: {}\n  JS:   {}", case["fn"], case["label"], case.get("actor"), sk_core::text::head(&actual.to_string(), 1_500), case["out"]));
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() >= 5_000, "случаев меньше, чем снято: {}", cases.len());
    let labels: std::collections::HashSet<&str> = cases.iter().filter_map(|case| case["label"].as_str()).map(|label| label.split(':').next().unwrap_or(label)).collect();
    for source in ["test", "corpus", "generated", "patch"] {
        assert!(labels.contains(source), "в эталоне нет состояний из {source}");
    }
}

#[test]
fn bounded_selection_matches_js() {
    for case in array(&FIXTURE["selection"]) {
        let options = arg(Some(&case["options"]));
        let field = |key: &str| options.and_then(|value| value.get(key));
        let actual = ac::bounded_selection_metadata(&SelectionOptions {
            scope: field("scope"),
            candidate_count: field("candidateCount"),
            limit: field("limit"),
            source_available: field("sourceAvailable"),
        });
        assert_eq!(js::stringify(&actual), js::stringify(&case["out"]), "{}", case["options"]);
    }
}

/// `sk_core::v8math::{atan2, hypot}` побитно как `Math.atan2`/`Math.hypot` Node.
#[test]
fn v8_atan2_and_hypot_match_node_bit_for_bit() {
    let float = |value: &Value| f64::from_bits(u64::from_str_radix(value.as_str().expect("биты"), 16).expect("шестнадцатеричные биты"));
    let cases = array(&FIXTURE["math"]);
    assert!(cases.len() >= 1_500);
    for case in cases {
        let (y, x) = (float(&case[0]), float(&case[1]));
        assert_eq!(v8math::atan2(y, x).to_bits(), float(&case[2]).to_bits(), "atan2({y:?}, {x:?})");
        assert_eq!(v8math::hypot(y, x).to_bits(), float(&case[3]).to_bits(), "hypot({y:?}, {x:?})");
    }
}

// --- перенос проверок из test/*.test.mjs ---------------------------------------

fn hall_state(props: bool) -> Value {
    let fill = CellPatch { passable: Some(true), revealed: Some(true), material: Some("stone"), ..CellPatch::default() };
    let mut map = tm::create_tactical_map(&TacticalMapOptions { width: 20, height: 2, location_id: "hall", seed: "agent-context", fill: Some(fill), ..TacticalMapOptions::default() })
        .expect("карта");
    tm::add_zone(&mut map, &json!({ "id": "hall", "label": "Зал", "kind": "interior" })).expect("зона");
    if props {
        for index in 0..17 {
            let mut prop = json!({ "id": format!("table-{index}"), "assetId": "table_long", "x": index as f64 + 0.5, "y": 0.5, "footprint": [{ "x": index, "y": 0 }] });
            if index == 16 {
                prop["visibility"] = json!("gm_only");
            }
            tm::add_prop(&mut map, &prop).expect("предмет");
        }
    }
    json!({
        "sessionCode": "CONTEXT-1", "state_version": 7,
        "scene": { "title": "Зал", "location": "Зал", "location_id": "hall", "map": tm::serialize_tactical_map(&map).expect("сериализация") },
        "players": [{ "id": "hero", "character": "Ада", "x": 0, "y": 0 }],
        "mechanics": { "positions": { "hero": { "x": 0, "y": 0 } } },
    })
}

#[test]
fn map_context_keeps_visible_prop_ids_and_marks_truncation() {
    let context = ac::scene_context_for_agent(&hall_state(true), Some(&json!("hero")));
    let ids: Vec<&str> = array(&context["spatial_context"]["objects"]).iter().map(|entry| entry["id"].as_str().unwrap_or("")).collect();
    let expected: Vec<String> = (0..16).map(|index| format!("table-{index}")).collect();
    assert_eq!(ids, expected);
    assert_eq!(context["spatial_context"]["objects_status"], "truncated");
    assert_eq!(context["spatial_context"]["objects_complete_within_scope"], false);
    assert_eq!(context["spatial_context"]["objects_truncation_reason"], "item_limit");
    let serialized = js::stringify(&context);
    assert!(!serialized.contains("table-16") && !serialized.contains("gm_only"));
    assert_eq!(
        context["context_metadata"],
        json!({ "role": "scene_context", "actor_id": "hero", "target_id": null, "campaign_id": "CONTEXT-1", "state_version": 7, "contract_version": "scene-context/v2", "schema_version": 1 })
    );
}

#[test]
fn empty_and_unavailable_maps_do_not_mix() {
    let empty = &ac::scene_context_for_agent(&hall_state(false), Some(&json!("hero")))["spatial_context"];
    assert_eq!(empty["objects_status"], "empty");
    assert_eq!(empty["objects_complete_within_scope"], true);
    let broken = ac::scene_context_for_agent(&json!({ "scene": { "title": "Зал", "map": { "width": 3, "height": 3, "layers": { "present": "broken" } } } }), Some(&json!("hero")));
    let broken = &broken["spatial_context"];
    assert_eq!(broken["objects_status"], "unavailable");
    assert_eq!(broken["objects_complete_within_scope"], Value::Null);
    assert_eq!(broken["objects_truncation_reason"], "source_unavailable");
}

#[test]
fn scene_context_carries_world_map_promise() {
    let scene = json!({ "title": "Свет над скалой", "location": "Заброшенный маяк" });
    let state = json!({ "scene": scene, "worldMap": { "currentLocationId": "lh", "locations": [{ "id": "lh", "name": "Заброшенный маяк", "summary": "Маяк на скале, чей свет вновь замечают по ночам.", "known": true }] } });
    assert_eq!(ac::scene_context_for_agent(&state, None)["place_summary"], "Маяк на скале, чей свет вновь замечают по ночам.");
    assert!(ac::scene_context_for_agent(&json!({ "scene": scene }), None).get("place_summary").is_none());
}

#[test]
fn field_summary_names_positions_conditions_and_neighbours_without_numbers() {
    let mut map = tm::create_tactical_map(&TacticalMapOptions { width: 6, height: 3, location_id: "pier", seed: "field", size_class: "arena", ..TacticalMapOptions::default() })
        .expect("карта");
    tm::add_zone(&mut map, &json!({ "id": "pier", "kind": "exterior", "material": "wood", "lightLevel": "dim", "floorDirection": "horizontal", "label": "Причал" })).expect("зона");
    tm::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior", "material": "wood", "lightLevel": "bright", "floorDirection": "horizontal", "label": "Общий зал" })).expect("зона");
    for y in 0..3 {
        for x in 0..6 {
            tm::set_cell_json(&mut map, x, y, &json!({ "passable": true, "revealed": x < 5, "zone": if x < 3 { "pier" } else { "hall" } })).expect("клетка");
        }
    }
    let state = json!({
        "scene": { "title": "Причал", "location": "Серый Причал", "location_id": "pier", "map": tm::serialize_tactical_map(&map).expect("сериализация") },
        "players": [{ "id": "mirel", "character": "Мирель", "hp": 20, "maxHp": 20, "x": 0, "y": 1 }, { "id": "borin", "character": "Борин", "hp": 9, "maxHp": 31, "x": 1, "y": 1 }],
        "enemies": [{ "id": "cult", "name": "Культист 1", "hp": 3, "maxHp": 9, "alive": true, "x": 2, "y": 1 }, { "id": "hidden", "name": "Культист 2", "hp": 9, "maxHp": 9, "alive": true, "x": 5, "y": 1 }],
        "mechanics": { "combat": { "active": true }, "positions": { "mirel": { "x": 0, "y": 1 }, "borin": { "x": 1, "y": 1 }, "cult": { "x": 2, "y": 1 }, "hidden": { "x": 5, "y": 1 } } },
    });
    let field = ac::field_summary_for(&state, None).expect("сводка");
    let heroes: Vec<Value> = array(&field["heroes"]).iter().map(|hero| json!([hero["name"], hero["area"], hero["indoors"], hero["condition"]])).collect();
    assert_eq!(heroes, [json!(["Мирель", "Причал", false, "цел"]), json!(["Борин", "Причал", false, "тяжело ранен"])]);
    assert_eq!(field["heroes"][1]["next_to"], json!(["Мирель", "Культист 1"]));
    let enemies: Vec<Value> = array(&field["enemies"]).iter().map(|enemy| json!([enemy["name"], enemy["condition"]])).collect();
    assert_eq!(enemies, [json!(["Культист 1", "тяжело ранен"])], "враг на нераскрытой клетке не называется");
    assert!(!js::stringify(&field).contains("\"hp\""));
    assert!(ac::scene_context_for_agent(&state, Some(&json!("borin"))).get("field").is_some());
}

#[test]
fn campaign_premise_is_bounded_and_excludes_private_state() {
    let state = json!({
        "campaignConcept": { "preset": "Frontier", "tone": "Hopeful mystery", "premise": "A vanished road returns each new moon.", "boundaries": "No sexual violence; fade to black.", "themes": "memory, duty", "private_solution": "The road is a dragon." },
        "secretGmNotes": "Never expose this.",
    });
    let premise = ac::campaign_concept_for_agent(&state, None);
    assert_eq!(premise["premise"], "A vanished road returns each new moon.");
    assert_eq!(premise["tone"], "Hopeful mystery");
    assert_eq!(premise["boundaries"], "No sexual violence; fade to black.");
    assert!(premise.get("private_solution").is_none());
    assert!(!js::stringify(&premise).contains("Never expose this"));
}

#[test]
fn campaign_premise_keeps_three_last_arc_epilogues() {
    let history: Vec<Value> = (1..=4).map(|index| json!({ "arc_number": index, "title": format!("Арка {index}"), "epilogue": format!("{}{index}", "Итог ".repeat(300)), "private_solution": "не передавать" })).collect();
    let premise = ac::campaign_concept_for_agent(&json!({ "adventure": { "chapter": 1 }, "campaignConcept": { "arc": { "arc_number": 5 }, "arc_history": history } }), None);
    assert_eq!(premise["current_arc_number"], 5);
    assert_eq!(premise["current_chapter"], 1);
    let numbers: Vec<&Value> = array(&premise["arc_history"]).iter().map(|entry| &entry["arc_number"]).collect();
    assert_eq!(numbers, [&json!(2), &json!(3), &json!(4)]);
    assert!(array(&premise["arc_history"]).iter().all(|entry| entry["epilogue"].as_str().is_some_and(|text| text.encode_utf16().count() <= 1_200)));
    assert!(!js::stringify(&premise).contains("private_solution"));
}

#[test]
fn campaign_premise_carries_bounded_world_history() {
    let state = json!({ "campaignConcept": {
        "world_template_id": "league-nine-tides", "world_template_version": "1.0.0",
        "worldSummary": "Лига островов живёт по картам прилива.",
        "worldHistory": format!("{}конец", "Старая дамба помнит бурю. ".repeat(200)),
        "factions": [{ "id": "dam-keepers", "name": "Смотрители дамб", "summary": "Чинят берег и хранят правду.", "goal": "Не дать морю забрать города.", "private_solution": "не передавать" }],
        "story_arcs": [{ "title": "Город под водой", "levels": "1–4", "summary": "Экспедиция в затонувшие кварталы.", "stakes": "Будущее побережья.", "private_solution": "не передавать" }],
        "private_solution": "не передавать",
    } });
    let premise = ac::campaign_concept_for_agent(&state, None);
    assert_eq!(premise["world_template_id"], "league-nine-tides");
    assert_eq!(premise["world_template_version"], "1.0.0");
    assert_eq!(premise["world_summary"], "Лига островов живёт по картам прилива.");
    assert_eq!(premise["world_history"].as_str().map(|text| text.encode_utf16().count()), Some(3_000));
    assert_eq!(premise["factions"][0]["name"], "Смотрители дамб");
    assert_eq!(premise["story_arcs"][0]["title"], "Город под водой");
    assert!(!js::stringify(&premise).contains("private_solution"));
}

/// Замечено в JS: фильтр `gm_only`/`npc_private` в `sceneContextForAgent`
/// читает `prop.visibility`, а у предмета разобранной карты такого поля нет —
/// фильтр не срабатывает никогда. Стол `table-16` с `visibility: 'gm_only'`
/// в контракте не виден только из-за предела в шестнадцать предметов.
#[test]
fn gm_only_prop_filter_never_fires_as_in_js() {
    let mut state = hall_state(true);
    // Герой у дальнего края: ближним становится «скрытый» стол.
    state["mechanics"]["positions"]["hero"] = json!({ "x": 19, "y": 1 });
    let context = ac::scene_context_for_agent(&state, Some(&json!("hero")));
    assert_eq!(context["spatial_context"]["objects"][0]["id"], "table-16");
}
