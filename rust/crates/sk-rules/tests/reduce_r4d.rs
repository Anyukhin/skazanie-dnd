//! Ветки жизни вещи, героя, наград, контейнеров добычи, должностей и
//! реестры-выводы (задача Р4в-2) против JS на событиях корпуса и их порче
//! (`fixtures/reduce-r4d.json`, генератор — `fixtures/gen-reduce-r4d.mjs`).
//!
//! Эталон — sha256 `JSON.stringify` состояния после события без производных
//! полей героя: совпадает и содержимое, и порядок ключей, реестры
//! сравниваются все. Случай, на котором JS бросает, сверяется только с тем,
//! что Rust сообщает отказ.

use std::sync::LazyLock;

use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/reduce-r4d.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

#[test]
fn item_hero_loot_office_branches_and_registries_match_js() {
    let bases = DATA["bases"].as_array().expect("состояния");
    let mut failures = Vec::new();
    let mut checked = 0;
    let mut thrown = 0;
    for (index, case) in DATA["cases"].as_array().expect("случаи").iter().enumerate() {
        let kind = case["event"]["event_type"].as_str().unwrap_or("?");
        assert!(sk_rules::reduce::is_ported(kind), "{kind} перенесён");
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
            failures.push(format!("#{index} {kind}: Rust отказал ({error:?})"));
            continue;
        }
        sk_rules::reduce::strip_derived(&mut state);
        let actual = sk_core::hash::sha256_hex(sk_core::js::stringify(&state));
        if case["sha256"].as_str() != Some(actual.as_str()) {
            failures.push(format!("#{index} {kind}: состояние расходится с JS"));
            // Отладка: `SK_R4D_DUMP_DIR=<каталог>` — состояние Rust в файл,
            // эталон JS — `gen-reduce-r4d.mjs <корпус> --dump <номер>`.
            if let Ok(directory) = std::env::var("SK_R4D_DUMP_DIR") {
                let _ = std::fs::write(format!("{directory}/{index}.rust.json"), sk_core::js::stringify(&state));
            }
        }
    }
    assert!(checked > 850, "сверено случаев: {checked}");
    assert!(thrown > 0, "есть случаи, где JS бросает");
    assert!(failures.is_empty(), "сверено {checked}, бросает JS {thrown}; расхождения ({}):\n{}", failures.len(), failures.join("\n"));
}
