//! Ветки редьюсера Р4а против JS по одному событию корпуса (задача Р4а).
//!
//! Случаи снимает `fixtures/gen-reduce-r4a-corpus.mjs` из корпуса паритета:
//! нормализованное JS-состояние перед событием и состояние после
//! `applyGameEvent`. Файл большой и в git не лежит, поэтому тест помечен
//! `#[ignore]` и читает путь из `SK_R4A_CASES`:
//!
//! ```text
//! SK_R4A_CASES=…/r4a-cases.jsonl cargo test -p sk-rules --test reduce_r4a_corpus -- --ignored --nocapture
//! ```
//!
//! Реестры-выводы, которые ещё не перенесены (`registries.rs`), из сравнения
//! исключены: их расхождение — не ошибка ветки.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};

use serde_json::Value;

/// Реестры после `switch`, которых ещё нет в Rust.
const UNPORTED_REGISTRIES: [&str; 7] = ["world_deeds", "offscreen_world", "courier_letters", "captives", "scenario_knight", "dialogues", "autonomy"];

fn without_registries(state: &mut Value) {
    if let Some(map) = state.as_object_mut() {
        for key in UNPORTED_REGISTRIES {
            map.shift_remove(key);
        }
    }
}

/// Закон (`law`) перенесён, но читает готовую летопись поступков
/// (`world_deeds`), которой в Rust ещё нет: если событие записало поступок,
/// закон сравнивать не с чем, и он исключается вместе с летописью.
fn law_reads_new_deed(pre: &Value, post: &Value) -> bool {
    pre.get("world_deeds") != post.get("world_deeds")
}

/// Первое расхождение (порядок ключей не важен, `null` ≡ отсутствие).
fn first_difference(expected: &Value, actual: &Value, path: &mut Vec<String>) -> Option<(String, String, String)> {
    let show = |value: &Value| {
        let text = value.to_string();
        if text.chars().count() > 240 {
            format!("{}…", text.chars().take(240).collect::<String>())
        } else {
            text
        }
    };
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                path.push(key.clone());
                let found = first_difference(left.get(key).unwrap_or(&Value::Null), right.get(key).unwrap_or(&Value::Null), path);
                if found.is_some() {
                    return found;
                }
                path.pop();
            }
            None
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (l, r)) in left.iter().zip(right).enumerate() {
                path.push(format!("[{index}]"));
                let found = first_difference(l, r, path);
                if found.is_some() {
                    return found;
                }
                path.pop();
            }
            None
        }
        (Value::Number(left), Value::Number(right)) if left.as_f64() == right.as_f64() => None,
        _ if expected == actual => None,
        _ => Some((path.join("."), show(expected), show(actual))),
    }
}

#[test]
#[ignore = "нужен файл случаев SK_R4A_CASES (снимается из корпуса)"]
fn reducer_branches_match_js_event_by_event() {
    let Ok(path) = std::env::var("SK_R4A_CASES") else {
        eprintln!("SK_R4A_CASES не задан — пропуск");
        return;
    };
    let only = std::env::var("SK_R4A_ONLY").ok();
    let file = std::fs::File::open(&path).expect("файл случаев");
    let mut equal: BTreeMap<String, usize> = BTreeMap::new();
    let mut different: BTreeMap<String, usize> = BTreeMap::new();
    let mut order_only: BTreeMap<String, usize> = BTreeMap::new();
    let mut law_skipped: BTreeMap<String, usize> = BTreeMap::new();
    let mut examples: Vec<String> = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.expect("строка");
        if line.trim().is_empty() {
            continue;
        }
        let case: Value = serde_json::from_str(&line).expect("случай — JSON");
        let kind = case["event_type"].as_str().unwrap_or("?").to_string();
        if only.as_deref().is_some_and(|only| !only.split(',').any(|wanted| wanted == kind)) || !sk_rules::reduce::is_ported(&kind) {
            continue;
        }
        let event: sk_core::Event = match serde_json::from_value(case["event"].clone()) {
            Ok(event) => event,
            Err(_) => continue,
        };
        let mut state = case["pre"].clone();
        let mode = case["mode"].as_str().unwrap_or("current").to_string();
        sk_society::retention_context::with_retention_mode(&mode, || sk_rules::reduce::apply_event(&mut state, &event)).expect("режим");
        sk_rules::reduce::strip_derived(&mut state);
        without_registries(&mut state);
        let mut expected = case["post"].clone();
        if law_reads_new_deed(&case["pre"], &expected) {
            *law_skipped.entry(kind.clone()).or_default() += 1;
            for side in [&mut state, &mut expected] {
                if let Some(map) = side.as_object_mut() {
                    map.shift_remove("law");
                }
            }
        }
        without_registries(&mut expected);
        match first_difference(&expected, &state, &mut Vec::new()) {
            None => {
                *equal.entry(kind.clone()).or_default() += 1;
                if sk_core::js::stringify(&expected) != sk_core::js::stringify(&state) {
                    *order_only.entry(kind).or_default() += 1;
                }
            }
            Some((at, left, right)) => {
                *different.entry(kind.clone()).or_default() += 1;
                if examples.len() < 60 {
                    examples.push(format!("{}:{}#{} {kind} {at}: JS={left} Rust={right}", case["file"].as_str().unwrap_or(""), case["row"], case["index"]));
                }
            }
        }
    }
    eprintln!("совпало: {equal:?}");
    eprintln!("порядок ключей другой (при равном содержимом): {order_only:?}");
    eprintln!("закон не сравнивался (событие записало поступок): {law_skipped:?}");
    eprintln!("расходится: {different:?}");
    for example in &examples {
        eprintln!("  {example}");
    }
    assert!(different.is_empty(), "ветки расходятся с JS: {different:?}");
}
