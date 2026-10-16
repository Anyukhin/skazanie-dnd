//! Эталоны JS `fixtures/scene-memory.json.gz` (генератор
//! `fixtures/gen-scene-memory.mjs`) и перенос модульных проверок
//! `test/scene-memory.test.mjs`.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_director::adventure_director::DirectorError;
use sk_director::scene_memory::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/scene-memory.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    serde_json::from_str(&text).expect("эталон JSON")
});

fn args(entry: &Value) -> Vec<Option<Value>> {
    let undef: Vec<u64> = entry["undef"].as_array().map(|items| items.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    entry["args"].as_array().expect("аргументы").iter().enumerate().map(|(index, value)| (!undef.contains(&(index as u64))).then(|| value.clone())).collect()
}

fn call(fn_name: &str, args: &[Option<Value>]) -> Result<Value, DirectorError> {
    let a = |index: usize| args.get(index).and_then(Option::as_ref);
    let empty = json!({});
    Ok(match fn_name {
        "questTitleFromObjective" => Value::String(quest_title_from_objective(a(0))),
        "ensureSceneWorldMemory" => ensure_scene_world_memory(a(0), a(1).unwrap_or(&empty))?,
        "sceneWorldMemoryEventId" => Value::String(scene_world_memory_event_id(a(0))),
        "sceneWorldMemoryEvents" => Value::Array(scene_world_memory_events(a(0).unwrap_or(&empty), a(1), a(2))?),
        other => panic!("неизвестная функция эталона: {other}"),
    })
}

#[test]
fn scene_memory_calls_match_js() {
    let cases = FIXTURE["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in cases {
        let fn_name = case["fn"].as_str().expect("fn");
        let label = format!("{fn_name} {} {}", case["label"].as_str().unwrap_or(""), js::stringify(&case["args"]).chars().take(160).collect::<String>());
        let actual = match call(fn_name, &args(case)) {
            Ok(value) => json!({ "out": value }),
            Err(error) => json!({ "error": error.to_json() }),
        };
        let expected = match case.get("error") {
            Some(error) => json!({ "error": error }),
            None => json!({ "out": case["out"] }),
        };
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!(
                "{label}\n  JS:   {}\n  Rust: {}",
                js::stringify(&expected).chars().take(700).collect::<String>(),
                js::stringify(&actual).chars().take(700).collect::<String>()
            ));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}:\n{}", failures.len(), cases.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() > 800, "вызовов: {}", cases.len());
}

/// `test/scene-memory.test.mjs`: старая сцена детерминированно получает место и задание главы.
#[test]
fn legacy_scene_seeds_location_and_current_quest() {
    let state = json!({ "scene": { "location": "Старый Брод", "objective": "Найти печать", "mood": "Туман" }, "adventure": { "chapter": 2, "currentHook": "Печать у мельника" } });
    let first = ensure_scene_world_memory(None, &state).expect("память");
    assert_eq!(first, ensure_scene_world_memory(None, &state).expect("память"));
    let location = first["entities"].as_array().and_then(|entities| entities.iter().find(|entity| entity["kind"] == "location")).expect("место");
    assert_eq!(location["name"], "Старый Брод");
    assert_eq!(location["tags"], json!(["visited"]));
    let quest = first["quests"].as_array().and_then(|quests| quests.iter().find(|quest| quest["id"] == "quest:chapter:2")).expect("задание главы");
    assert_eq!(quest["title"], "Найти печать");
    assert_eq!(quest["summary"], "Печать у мельника");
}

/// Подтверждённый переход закрывает задание прошлой главы и открывает следующее.
#[test]
fn transition_closes_old_quest_and_records_next_chapter() {
    let state = json!({ "scene": { "location": "Старый Брод", "objective": "Найти печать" }, "adventure": { "chapter": 1 } });
    let transition = json!({
        "scene": { "location": "Ольшанка", "objective": "Продолжить квест «Найти печать»" },
        "adventure": { "chapter": 2, "history": [{ "status": "completed", "outcome": "Печать найдена." }] },
        "transition": "Отряд идёт по тракту.", "arrival": "Впереди мост.",
    });
    let events = scene_world_memory_events(&state, Some(&transition), Some(&json!({ "commandId": "cmd-1", "sourceEventId": "event-1" }))).expect("события");
    let quests: Vec<&Value> = events.iter().filter(|event| event["event_type"] == "QuestUpserted").map(|event| &event["payload"]["quest"]).collect();
    assert_eq!(quests[0]["id"], "quest:chapter:1");
    assert_eq!(quests[0]["status"], "completed");
    assert_eq!(quests[0]["summary"], "Печать найдена.");
    assert_eq!(quests[1]["id"], "quest:chapter:2");
    assert_eq!(quests[1]["title"], "Найти печать", "обёртка цели снимается");
    let facts: Vec<&Value> = events.iter().filter(|event| event["event_type"] == "WorldFactRecorded").map(|event| &event["payload"]["fact"]).collect();
    assert_eq!(facts.iter().map(|fact| fact["predicate"].clone()).collect::<Vec<_>>(), [json!("party_traveled_to"), json!("party_arrived")]);
    assert_eq!(facts[0]["source_event_ids"], json!(["event-1"]));
}

/// Нерешённая цель остаётся активной рядом с заданием следующей главы.
#[test]
fn unresolved_objective_stays_active() {
    let state = json!({ "scene": { "location": "Склеп", "objective": "Найти печать" }, "adventure": { "chapter": 1 } });
    let transition = json!({ "scene": { "location": "Тракт", "objective": "Найти обоз" }, "adventure": { "chapter": 2, "history": [{ "status": "unresolved" }] } });
    let events = scene_world_memory_events(&state, Some(&transition), None).expect("события");
    let first = events.iter().find(|event| event["event_type"] == "QuestUpserted").expect("задание");
    assert_eq!(first["payload"]["quest"]["status"], "active");
}

/// Заголовок задания не накапливает обёртку «Продолжить квест».
#[test]
fn quest_title_does_not_accumulate_wrappers() {
    let mut wrapped = "Найти печать".to_string();
    for _ in 0..8 {
        wrapped = format!("Продолжить квест «{wrapped}»");
        assert_eq!(quest_title_from_objective(Some(&json!(wrapped))), "Найти печать");
    }
    assert_eq!(quest_title_from_objective(Some(&json!("Развить последствия победы в квесте «Мост» и приблизить развязку"))), "Мост");
}
