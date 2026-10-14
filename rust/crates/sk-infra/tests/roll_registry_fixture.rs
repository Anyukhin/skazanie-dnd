//! Сверка `roll_registry` с эталоном JS (`fixtures/gen-roll-registry.mjs`):
//! результат каждой операции и durable-файл после неё — байт в байт.

mod common;

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use sk_core::RuleError;
use sk_infra::roll_registry::{RollRegistry, RollRegistryError, RollRegistryOptions};

use common::{fixture_path, SharedDice};

fn error_of(error: &RollRegistryError) -> (String, String) {
    (error.code().map(String::from).unwrap_or_else(|| error.name().to_string()), error.to_string())
}

#[test]
fn registry_matches_js_scenarios() {
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(fixture_path("roll-registry.json")).expect("эталон")).expect("json");
    let mut operations = 0;
    for case in &cases {
        let seed = &case["seed"];
        let directory = tempfile::tempdir().expect("каталог");
        let storage_file = directory.path().join("rolls.json");
        let values: Vec<i64> = case["dice"].as_array().expect("кости").iter().map(|value| value.as_i64().expect("число")).collect();
        let dice = {
            // Тот же генератор id, что в эталоне: `roll-${++n}` на весь сценарий.
            SharedDice::new(values, "roll")
        };
        let now = Arc::new(AtomicI64::new(1_000_000));
        let checks = Arc::new(AtomicU64::new(0));
        let ttl_ms = case["ttl_ms"].as_i64().expect("ttl");
        let build = || {
            let now = Arc::clone(&now);
            let checks = Arc::clone(&checks);
            RollRegistry::new(
                dice.boxed(),
                RollRegistryOptions {
                    ttl_ms,
                    now: Arc::new(move || now.load(Ordering::SeqCst)),
                    check_id_factory: Box::new(move || format!("check-{}", checks.fetch_add(1, Ordering::SeqCst) + 1)),
                    storage_file: Some(storage_file.clone()),
                },
            )
            .expect("реестр")
        };
        let mut registry = build();
        for (index, step) in case["steps"].as_array().expect("шаги").iter().enumerate() {
            operations += 1;
            let options = step.get("options").cloned().unwrap_or(Value::Null);
            let op = step["op"].as_str().expect("операция");
            let result: Result<Option<Value>, RollRegistryError> = match op {
                "register" => registry.register_check(&options).map(Some),
                "issue" => registry.issue(&options).map(Some),
                "consume" => {
                    let reject = step["reject_context"].as_bool().unwrap_or(false);
                    let mut validate = |_: &Value| -> Result<(), RuleError> { Err(RuleError::new("ROLL_CONTEXT_MISMATCH", "Проверка относится к другой заявке")) };
                    let validate: Option<&mut dyn FnMut(&Value) -> Result<(), RuleError>> = if reject { Some(&mut validate) } else { None };
                    registry.consume(&step["roll_id"], &options, validate).map(Some)
                }
                "finish" => registry.finish_reservation(&step["roll_id"], &options).map(|value| Some(Value::Bool(value))),
                "get" => registry.get_check(&step["check_id"], &options).map(Some),
                "has_open" => registry.has_open_check(&options).map(|value| Some(Value::Bool(value))),
                "pending" => registry.pending_narration_check(&options).map(|value| Some(value.unwrap_or(Value::Null))),
                "invalidate" => registry.invalidate_check(&step["check_id"], &options).map(|value| Some(Value::Bool(value))),
                "invalidate_proposal" => registry.invalidate_proposal(&step["proposal_id"], &options).map(|value| Some(Value::Bool(value))),
                "advance" => {
                    now.fetch_add(step["ms"].as_i64().expect("мс"), Ordering::SeqCst);
                    Ok(None)
                }
                "restart" => {
                    registry = build();
                    Ok(None)
                }
                "release" => {
                    let commits = step["commits"].clone();
                    registry
                        .release_orphan_reservations(|_campaign, key| match commits.get(key) {
                            Some(Value::Bool(committed)) => Ok(*committed),
                            _ => Err(()),
                        })
                        .map(|released| Some(Value::from(released)))
                }
                other => panic!("неизвестная операция {other}"),
            };
            let place = format!("seed {seed}, шаг {index} ({op})");
            match (&result, step.get("error")) {
                (Err(error), Some(expected)) => {
                    let (code, message) = error_of(error);
                    assert_eq!(code, expected["code"].as_str().unwrap_or_default(), "{place}: код");
                    assert_eq!(message, expected["message"].as_str().unwrap_or_default(), "{place}: текст");
                }
                (Err(error), None) => panic!("{place}: Rust отказал {error:?}, JS — нет"),
                (Ok(_), Some(expected)) => panic!("{place}: JS отказал {expected}, Rust — нет"),
                (Ok(value), None) => {
                    if let Some(expected) = step.get("result") {
                        assert_eq!(value.as_ref().unwrap_or(&Value::Null), expected, "{place}: результат");
                    }
                }
            }
            let file = std::fs::read_to_string(&storage_file).ok();
            if let Some(text) = step.get("file").and_then(Value::as_str) {
                assert_eq!(file.as_deref(), Some(text), "{place}: файл");
            }
            let hash = file.as_ref().map(sk_core::hash::sha256_hex);
            assert_eq!(hash.as_deref(), step["file_sha256"].as_str(), "{place}: хеш файла");
        }
    }
    assert!(operations > 2000, "эталон слишком мал: {operations}");
}
