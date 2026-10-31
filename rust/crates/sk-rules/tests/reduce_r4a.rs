//! Ветки редьюсера Р4а против JS на синтетических состояниях
//! (`fixtures/reduce-r4a.json`, генератор — `fixtures/gen-reduce-r4a.mjs`).
//!
//! Эталон — sha256 `JSON.stringify` состояния после события без производных
//! полей героя и без ещё не перенесённых реестров: совпадает и содержимое, и
//! порядок ключей. Случай, на котором JS бросает, сверяется только с тем, что
//! Rust сообщает отказ ветки.

use std::sync::LazyLock;

use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/reduce-r4a.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

/// Реестры, которых нет в эталоне Р4а (тогда не перенесённые; сверка всех
/// реестров — `reduce_r4d.rs` и `reduce_r4a_corpus.rs`).
const UNPORTED_REGISTRIES: [&str; 8] = ["law", "world_deeds", "offscreen_world", "courier_letters", "captives", "scenario_knight", "dialogues", "autonomy"];

fn comparable(mut state: Value) -> Value {
    sk_rules::reduce::strip_derived(&mut state);
    if let Some(map) = state.as_object_mut() {
        for key in UNPORTED_REGISTRIES {
            map.shift_remove(key);
        }
    }
    state
}

#[test]
fn ported_branches_match_js_on_synthetic_states() {
    let bases = DATA["bases"].as_array().expect("состояния");
    let mut failures = Vec::new();
    let mut checked = 0;
    let mut thrown = 0;
    for (index, case) in DATA["cases"].as_array().expect("случаи").iter().enumerate() {
        let kind = case["event"]["event_type"].as_str().unwrap_or("?");
        if !sk_rules::reduce::is_ported(kind) {
            continue;
        }
        let event: sk_core::Event = serde_json::from_value(case["event"].clone()).expect("событие");
        let mut state = bases[case["base"].as_u64().unwrap_or(0) as usize].clone();
        let mode = case["mode"].as_str().unwrap_or("current");
        let result = sk_society::retention_context::with_retention_mode(mode, || sk_rules::reduce::apply_event_checked(&mut state, &event)).expect("режим");
        if case.get("throws").is_some() {
            thrown += 1;
            if result.is_ok() {
                failures.push(format!("#{index} {kind}: JS бросает, Rust применил"));
            }
            continue;
        }
        checked += 1;
        if let Err(error) = &result {
            failures.push(format!("#{index} {kind}: Rust отказал ({error})"));
            continue;
        }
        let state = comparable(state);
        let actual = sk_core::hash::sha256_hex(sk_core::js::stringify(&state));
        if case["sha256"].as_str() != Some(actual.as_str()) {
            failures.push(format!("#{index} {kind}: состояние расходится с JS"));
            // Отладка: `SK_R4A_DUMP_DIR=<каталог>` — состояние Rust в файл,
            // эталон JS — `gen-reduce-r4a.mjs --dump <номер>`.
            if let Ok(directory) = std::env::var("SK_R4A_DUMP_DIR") {
                let _ = std::fs::write(format!("{directory}/{index}.rust.json"), sk_core::js::stringify(&state));
            }
        }
    }
    assert!(checked > 1_000, "сверено случаев: {checked}");
    assert!(failures.is_empty(), "сверено {checked}, бросает JS {thrown}; расхождения ({}):\n{}", failures.len(), failures.join("\n"));
}
