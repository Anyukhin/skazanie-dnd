//! `normalizeCampaignState` против JS — задача Р4б.
//!
//! - `fixtures/normalize-synthetic.json` (`gen-normalize-synthetic.mjs`):
//!   400 состояний с мусором — sha256 `JSON.stringify` итога или текст броска;
//! - `fixtures/normalize-corpus.json` (`gen-normalize-corpus.mjs`): все
//!   состояния корпуса паритета; состояния читаются из каталога `SK_CORPUS`
//!   (тест `#[ignore]`; то же делает `sk-corpus normalize`).

use std::sync::LazyLock;

use serde_json::Value;
use sk_core::{hash, js};
use sk_rules::normalize::normalize_campaign_state;

static SYNTHETIC: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/normalize-synthetic.json")).expect("эталон читается")).expect("эталон"));

/// Хеш нормализованного состояния в форме JS: производные поля героев в
/// состоянии — пустые слоты (урок 2), JS их хранит — сверяется герой с
/// вычисленными полями (`sk_rules::derived`).
fn digest(value: &Value) -> String {
    hash::sha256_hex(js::stringify(&sk_rules::derived::materialized_state(value)))
}

#[test]
fn synthetic_states_match_js() {
    let states = SYNTHETIC["states"].as_array().expect("состояния");
    let cases = SYNTHETIC["cases"].as_array().expect("случаи");
    let mut failures = Vec::new();
    for (index, (state, case)) in states.iter().zip(cases).enumerate() {
        match (normalize_campaign_state(state), case.get("throws").and_then(Value::as_str)) {
            (Ok(normalized), None) => {
                if digest(&normalized) != case["sha"].as_str().unwrap_or_default() {
                    failures.push(format!("#{index}: итог расходится"));
                }
            }
            (Err(error), Some(message)) => {
                if !error.to_string().contains(message) {
                    failures.push(format!("#{index}: отказ JS «{message}», Rust «{error}»"));
                }
            }
            (Ok(_), Some(message)) => failures.push(format!("#{index}: JS бросает «{message}», Rust нет")),
            (Err(error), None) => failures.push(format!("#{index}: Rust бросает «{error}»")),
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

#[test]
fn input_is_not_mutated_and_derived_fields_keep_their_place() {
    let raw = serde_json::json!({
        "players": [{ "id": "hero", "combatSpells": [{ "id": "old" }], "name": "Герой", "inventoryLoad": 5 }],
        "worldMemory": { "entities": [] },
        "zzz": 1,
    });
    let before = raw.clone();
    let normalized = normalize_campaign_state(&raw).expect("нормализация");
    assert_eq!(raw, before, "вход не меняется");
    let keys: Vec<&String> = normalized["players"][0].as_object().expect("герой").keys().collect();
    assert_eq!(&keys[..4], ["id", "combatSpells", "name", "inventoryLoad"], "производные поля на прежних местах");
    assert!(normalized["players"][0]["combatSpells"].is_null() && normalized["players"][0]["inventoryLoad"].is_null(), "в состоянии — пустые слоты, значения не хранятся");
    let root: Vec<&String> = normalized.as_object().expect("состояние").keys().collect();
    assert_eq!(&root[..3], ["players", "worldMemory", "zzz"], "worldMemory на своём месте");
}

#[test]
#[ignore = "читает состояния корпуса из SK_CORPUS"]
fn corpus_states_match_js() {
    let Ok(root) = std::env::var("SK_CORPUS") else { return };
    let oracle: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/normalize-corpus.json")).expect("эталон читается")).expect("эталон");
    let mut checked = 0;
    let mut failures = Vec::new();
    for case in oracle["cases"].as_array().expect("случаи") {
        let hash = case[0].as_str().unwrap_or_default();
        let Ok(text) = std::fs::read_to_string(format!("{root}/states/{hash}.json")) else { continue };
        let Ok(state) = serde_json::from_str::<Value>(&text) else { continue };
        checked += 1;
        match normalize_campaign_state(&state) {
            Ok(normalized) if digest(&normalized) == case[1].as_str().unwrap_or_default() => {}
            Ok(_) => failures.push(hash.to_string()),
            Err(error) if case[1] == "throws" && error.to_string().contains(case[2].as_str().unwrap_or_default()) => {}
            Err(error) => failures.push(format!("{hash}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{} из {checked}:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}
