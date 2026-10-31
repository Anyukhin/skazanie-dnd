//! Сверка цепочек памяти мира с эталоном `server/world-memory.mjs`
//! (`fixtures/gen-world-memory-chains.mjs`): сотни шагов «команда → проверка →
//! событие → редьюсер», готовые и мусорные события, подготовленный путь,
//! режим `legacy` и мусорные старые состояния. На каждом шаге сверяются отказ
//! или хеши проверенной команды и события и хеш памяти; у первых цепочек —
//! полные значения, у всех — итоговая память.

mod common;

use common::clip;
use serde_json::{json, Map, Value};
use sk_memory::world_memory::*;
use sk_society::retention_context::with_retention_mode;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/world-memory-chains.json")).expect("эталон — JSON")
}

fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn hash(value: &Value) -> String {
    sk_core::hash::sha256_hex(text(value))
}

/// `{ ...state, worldMemory: memory }`; `undefined` и `null` модуль читает одинаково.
fn with_memory(state: &Value, memory: &Value) -> Value {
    let mut result = state.as_object().cloned().unwrap_or_default();
    result.insert("worldMemory".into(), memory.clone());
    Value::Object(result)
}

fn fail(failures: &mut Vec<String>, message: String) {
    if failures.len() < 12 {
        failures.push(message);
    }
}

fn run_chain(number: usize, chain: &Value, failures: &mut Vec<String>) -> usize {
    let mut state = chain["initial"].clone();
    let mut memory = state.get("worldMemory").cloned().unwrap_or(Value::Null);
    let mut steps = 0;
    for (index, step) in chain["steps"].as_array().into_iter().flatten().enumerate() {
        steps += 1;
        let at = format!("цепочка {number}, шаг {index} ({})", step["kind"]);
        match step["kind"].as_str() {
            Some("state") => {
                let mut map: Map<String, Value> = state.as_object().cloned().unwrap_or_default();
                for (key, value) in step["patch"].as_object().into_iter().flatten() {
                    map.insert(key.clone(), value.clone());
                }
                state = Value::Object(map);
            }
            Some("event") => {
                let prepared = step["prepared"] == json!(true);
                memory = apply_world_memory_event(memory, &step["event"], prepared);
                if hash(&memory) != step["memory_hash"] {
                    let expected = step.get("memory").map(text).unwrap_or_default();
                    fail(failures, format!("{at}: память после события {}\n  JS:   {}\n  Rust: {}", clip(&text(&step["event"]), 300), clip(&expected, 1500), clip(&text(&memory), 1500)));
                    return steps;
                }
            }
            Some("command") => {
                let current = with_memory(&state, &memory);
                let validated = match validate_world_memory_command(&step["command"], &current, &step["context"]) {
                    Err(error) => {
                        let expected = &step["throws"];
                        if expected["code"] != json!(error.code) || expected["message"] != json!(error.message) {
                            fail(failures, format!("{at}: отказ {}\n  JS:   {}\n  Rust: {:?}", clip(&text(&step["command"]), 400), text(expected), error));
                            return steps;
                        }
                        continue;
                    }
                    Ok(validated) => validated,
                };
                if step.get("throws").is_some() || hash(&validated) != step["validated_hash"] {
                    let expected = step.get("validated").or(step.get("throws")).map(text).unwrap_or_default();
                    fail(failures, format!("{at}: проверенная команда {}\n  JS:   {}\n  Rust: {}", clip(&text(&step["command"]), 400), clip(&expected, 1200), clip(&text(&validated), 1200)));
                    return steps;
                }
                let Some(emitted) = world_memory_event(&validated) else {
                    if !step["event_hash"].is_null() {
                        fail(failures, format!("{at}: событие не построено"));
                        return steps;
                    }
                    continue;
                };
                let mut event = emitted.as_object().cloned().unwrap_or_default();
                event.insert("event_id".into(), step["event_id"].clone());
                if let Some(command_id) = validated.get("command_id") {
                    event.insert("command_id".into(), command_id.clone());
                }
                let event = Value::Object(event);
                if hash(&event) != step["event_hash"] {
                    let expected = step.get("event").map(text).unwrap_or_default();
                    fail(failures, format!("{at}: событие\n  JS:   {}\n  Rust: {}", clip(&expected, 1200), clip(&text(&event), 1200)));
                    return steps;
                }
                memory = apply_world_memory_event(memory, &event, step["prepared"] == json!(true));
                if hash(&memory) != step["memory_hash"] {
                    let expected = step.get("memory").map(text).unwrap_or_default();
                    fail(failures, format!("{at}: память после {}\n  JS:   {}\n  Rust: {}", clip(&text(&event), 300), clip(&expected, 1500), clip(&text(&memory), 1500)));
                    return steps;
                }
            }
            other => fail(failures, format!("{at}: неизвестный шаг {other:?}")),
        }
    }
    if hash(&memory) != chain["final_hash"] {
        fail(failures, format!("цепочка {number}: итоговая память"));
    }
    if let Some(final_memory) = chain.get("final") {
        if text(final_memory) != text(&memory) {
            fail(failures, format!("цепочка {number}: итоговая память текстом"));
        }
    }
    steps
}

#[test]
fn chains_match_js() {
    let fixture = fixture();
    let mut failures = Vec::new();
    let mut total = 0;
    for (number, chain) in fixture["chains"].as_array().into_iter().flatten().enumerate() {
        total += if chain["mode"] == "legacy" {
            with_retention_mode("legacy", || run_chain(number, chain, &mut failures)).expect("режим legacy")
        } else {
            run_chain(number, chain, &mut failures)
        };
    }
    assert!(failures.is_empty(), "расхождений с JS: {}\n{}", failures.len(), failures.join("\n"));
    assert!(total > 5_000, "шагов подозрительно мало: {total}");
}

#[test]
fn direct_events_match_js() {
    for case in fixture()["direct"].as_array().into_iter().flatten() {
        let rust = world_memory_event(&case["command"]).unwrap_or(Value::Null);
        assert_eq!(text(&rust), text(&case["event"]), "{}", case["command"]);
    }
}
