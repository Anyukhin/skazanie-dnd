//! Время мира в разборе (`appendTimeAdvance`, `appendScenarioKnightPresence`,
//! `appendWorldTimeConsequences`) против JS — задача Р4б.
//!
//! Эталон снимает `fixtures/gen-world-time.mjs`: блок замыканий 13119–13313
//! исполняется в области имён открытой копии движка. Синтетические состояния
//! лежат в эталоне целиком и сверяются всегда; состояния корпуса — по sha из
//! каталога `SK_CORPUS` (тест `#[ignore]`):
//!
//! ```text
//! SK_CORPUS=…/tmp/corpus-v1 cargo test -p sk-rules --test world_time -- --ignored
//! ```

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_dice::{DiceService, SequenceRng};
use sk_rules::dice_record::ServiceDice;
use sk_rules::resolve::world_time::{world_time_consequences, TimeAdvanceOptions};

static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/world-time.json")).expect("эталон читается")).expect("эталон"));

fn options(raw: &Value) -> TimeAdvanceOptions {
    TimeAdvanceOptions {
        source_state: None,
        elapsed_seconds: raw.get("elapsedSeconds").and_then(Value::as_f64),
        policy_id: raw.get("policyId").and_then(Value::as_str).map(str::to_string),
    }
}

/// Итог случая: `None` — совпало, иначе текст расхождения.
fn check(case: &Value, state: &Value) -> Option<String> {
    let mut dice = ServiceDice::new(DiceService::deterministic(SequenceRng::new(case["dice"].as_array().expect("кости").iter().filter_map(Value::as_i64).collect::<Vec<i64>>()), "roll"));
    let result = world_time_consequences(state, &case["command"], case.get("amount"), case.get("unit"), options(&case["options"]), &mut dice);
    match (result, case.get("throws")) {
        (Ok((events, rolls)), None) => {
            let actual = hash::sha256_hex(js::stringify(&json!({ "events": events, "rolls": rolls })));
            if actual == case["sha"].as_str().unwrap_or_default() {
                return None;
            }
            let types: Vec<&str> = events.iter().filter_map(|event| event["event_type"].as_str()).collect();
            Some(format!("JS {} / Rust {:?}", case["types"], types))
        }
        (Err(error), Some(message)) => (!error.to_string().contains(message.as_str().unwrap_or_default())).then(|| format!("отказ: JS {message} / Rust {error}")),
        (Ok(_), Some(message)) => Some(format!("JS бросает {message}, Rust нет")),
        (Err(error), None) => Some(format!("Rust бросает {error}")),
    }
}

fn run(filter: impl Fn(&Value) -> Option<Value>) -> (usize, Vec<String>) {
    let mut total = 0;
    let mut failures = Vec::new();
    for (index, case) in DATA["cases"].as_array().expect("случаи").iter().enumerate() {
        let Some(state) = filter(case) else { continue };
        total += 1;
        if let Some(failure) = check(case, &state) {
            failures.push(format!("#{index} {} {} {}: {failure}", case["feature"], case["amount"], case["unit"]));
        }
    }
    (total, failures)
}

#[test]
fn synthetic_states_match_js() {
    let (total, failures) = run(|case| case.get("synthetic").and_then(Value::as_u64).map(|index| DATA["synthetic"][index as usize].clone()));
    assert!(total >= 10, "синтетических случаев: {total}");
    assert!(failures.is_empty(), "{} из {total}:\n{}", failures.len(), failures.join("\n"));
}

#[test]
#[ignore = "читает состояния корпуса из SK_CORPUS"]
fn corpus_states_match_js() {
    let Ok(root) = std::env::var("SK_CORPUS") else { return };
    let (total, failures) = run(|case| {
        let hash = case.get("state_hash")?.as_str()?;
        let text = std::fs::read_to_string(format!("{root}/states/{hash}.json")).ok()?;
        serde_json::from_str(&text).ok()
    });
    assert!(failures.is_empty(), "{} из {total}:\n{}", failures.len(), failures.join("\n"));
    eprintln!("совпало {total} случаев корпуса");
}
