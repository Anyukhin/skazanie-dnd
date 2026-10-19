//! `applyGameEvent`, `replayEvents` и проектор команды против JS — задача Р4б.
//!
//! Эталон снимает `fixtures/gen-replay.mjs`: синтетика (версии редьюсера,
//! режим retention, замена состояния) и потоки событий корпуса паритета —
//! `replayEvents` и проектор с растущим списком событий и правкой первого.
//! Сравнение — sha256 `JSON.stringify` без производных полей героя и без
//! реестров-выводов, которых ещё нет в Rust (`registries_excluded`). Записи с
//! неперенесёнными типами событий пропускаются. Состояния корпуса читаются
//! из `SK_CORPUS` (тест `#[ignore]`).

use std::sync::LazyLock;

use serde_json::Value;
use sk_core::{hash, js};
use sk_rules::pause::Halt;
use sk_rules::replay::{apply_game_event, replay_events, CommandProjector};

static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay.json")).expect("эталон читается")).expect("эталон"));

fn digest(state: &Value) -> String {
    let mut copy = state.clone();
    if let Some(players) = copy.get_mut("players").and_then(Value::as_array_mut) {
        for player in players {
            if let Some(map) = player.as_object_mut() {
                for field in ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"] {
                    map.shift_remove(field);
                }
            }
        }
    }
    if let Some(map) = copy.as_object_mut() {
        for key in DATA["registries_excluded"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            map.shift_remove(key);
        }
    }
    hash::sha256_hex(js::stringify(&copy))
}

/// `None` — совпало с эталоном случая.
fn compare(result: Result<Value, Halt>, expected: &Value) -> Option<String> {
    match (result, expected.get("throws")) {
        (Ok(state), None) => (digest(&state) != expected["sha"].as_str().unwrap_or_default()).then(|| "состояние расходится".to_string()),
        (Err(error), Some(message)) => {
            let code = expected.get("code").and_then(Value::as_str);
            let same = error.to_string().contains(message.as_str().unwrap_or_default()) && (code.is_none() || error.code() == code);
            (!same).then(|| format!("отказ: JS {message} {code:?} / Rust {error} {:?}", error.code()))
        }
        (Ok(_), Some(message)) => Some(format!("JS бросает {message}, Rust нет")),
        (Err(error), None) => Some(format!("Rust бросает {error}")),
    }
}

#[test]
fn reducer_version_retention_and_replacement_match_js() {
    let states = DATA["states"].as_array().expect("состояния");
    let mut failures = Vec::new();
    for (index, case) in DATA["synthetic"].as_array().expect("синтетика").iter().enumerate() {
        let state = &states[case["state"].as_u64().unwrap_or(0) as usize];
        let result = match case["kind"].as_str() {
            Some("apply") => apply_game_event(state, &case["event"]),
            _ => replay_events(state, case["events"].as_array().map(Vec::as_slice).unwrap_or(&[])),
        };
        if let Some(failure) = compare(result, case) {
            failures.push(format!("#{index} {}: {failure}", js::stringify(case.get("event").unwrap_or(&Value::Null)).chars().take(120).collect::<String>()));
        }
    }
    assert!(failures.is_empty(), "{}:\n{}", failures.len(), failures.join("\n"));
}

#[test]
#[ignore = "читает состояния корпуса из SK_CORPUS"]
fn corpus_streams_replay_and_project_like_js() {
    let Ok(root) = std::env::var("SK_CORPUS") else { return };
    let mut checked = 0;
    let mut skipped = 0;
    let mut failures = Vec::new();
    for case in DATA["corpus"].as_array().expect("корпус") {
        let events: Vec<Value> = case["events"].as_array().cloned().unwrap_or_default();
        if !events.iter().all(|event| sk_rules::reduce::is_ported(event["event_type"].as_str().unwrap_or_default())) {
            skipped += 1;
            continue;
        }
        let hash = case["state_hash"].as_str().unwrap_or_default();
        let Ok(text) = std::fs::read_to_string(format!("{root}/states/{hash}.json")) else { continue };
        let Ok(before) = serde_json::from_str::<Value>(&text) else { continue };
        checked += 1;
        let label = format!("{}:{}", case["file"].as_str().unwrap_or_default(), case["row"]);
        if let Some(failure) = compare(replay_events(&before, &events), &case["replay"]) {
            failures.push(format!("{label} replay: {failure}"));
        }
        let initial = match sk_rules::normalize::normalize_campaign_state(&before) {
            Ok(state) => state,
            Err(error) => {
                failures.push(format!("{label}: нормализация {error}"));
                continue;
            }
        };
        let mut projector = CommandProjector::new(&initial);
        let steps = case["steps"].as_array().cloned().unwrap_or_default();
        for (length, expected) in steps.iter().enumerate().take(events.len()) {
            if let Some(failure) = compare(projector.project(&events[..=length]), expected) {
                failures.push(format!("{label} проектор [{}]: {failure}", length + 1));
            }
        }
        let mut edited = events.clone();
        if let Some(first) = edited.first_mut() {
            if !first["payload"].is_object() {
                first["payload"] = serde_json::json!({});
            }
            first["payload"]["__edited"] = Value::Bool(true);
        }
        if let Some(expected) = steps.get(events.len()) {
            if let Some(failure) = compare(projector.project(&edited), expected) {
                failures.push(format!("{label} проектор после правки: {failure}"));
            }
        }
    }
    eprintln!("потоков корпуса: сверено {checked}, пропущено (неперенесённые события) {skipped}");
    assert!(failures.is_empty(), "{}:\n{}", failures.len(), failures.join("\n"));
}
