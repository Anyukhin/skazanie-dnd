//! Сверка `usage_ledger` с эталоном JS (`fixtures/gen-usage-ledger.mjs`):
//! результаты операций, файл учёта байт в байт, `normalizeProviderUsage` и
//! оценка входа `MeteredLLMClient`.

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use sk_infra::usage_ledger::{estimated_input_tokens, normalize_provider_usage, DurableUsageLedger, ReserveRequest, UsageLedgerError, UsageLedgerOptions};

use common::{fixture_path, same_json};

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture_path("usage-ledger.json")).expect("эталон")).expect("json")
}

fn error_of(error: &UsageLedgerError) -> (String, String) {
    (error.code().map(String::from).unwrap_or_else(|| error.name().to_string()), error.to_string())
}

#[test]
fn ledger_matches_js_scenarios() {
    let fixture = fixture();
    let mut operations = 0;
    for case in fixture["scenarios"].as_array().expect("сценарии") {
        let seed = &case["seed"];
        let config = &case["config"];
        let directory = tempfile::tempdir().expect("каталог");
        let storage_file = directory.path().join("usage.json");
        let now = Arc::new(AtomicI64::new(sk_core::clock::parse_iso("2026-07-24T12:00:00.000Z").expect("время")));
        let build = || {
            let clock = Arc::clone(&now);
            DurableUsageLedger::new(UsageLedgerOptions {
                storage_file: storage_file.clone(),
                daily_token_limit: config["daily_token_limit"].as_f64(),
                retention_days: config.get("retention_days").and_then(Value::as_f64),
                reservation_ttl_ms: config["reservation_ttl_ms"].as_f64(),
                now: Arc::new(move || clock.load(Ordering::SeqCst)),
            })
            .expect("учёт")
        };
        let mut ledger = build();
        for (index, step) in case["steps"].as_array().expect("шаги").iter().enumerate() {
            operations += 1;
            let op = step["op"].as_str().expect("операция");
            let result: Result<Option<Value>, UsageLedgerError> = match op {
                "reserve" => {
                    let request = &step["request"];
                    ledger
                        .reserve(&ReserveRequest {
                            request_id: request["request_id"].as_str().map(String::from),
                            estimated_tokens: request["estimated_tokens"].as_f64().expect("оценка"),
                            scope: request.get("scope").and_then(Value::as_str).map(String::from),
                            model: request.get("model").and_then(Value::as_str).map(String::from),
                        })
                        .map(Some)
                }
                "settle" => ledger.settle(step["id"].as_str().expect("id"), step.get("usage")).map(Some),
                "fail" => ledger.fail(step["id"].as_str().expect("id"), step.get("code").and_then(Value::as_str), step.get("usage")).map(Some),
                "report" => ledger.report().map(Some),
                "advance" => {
                    now.fetch_add(step["ms"].as_i64().expect("мс"), Ordering::SeqCst);
                    Ok(None)
                }
                "restart" => {
                    ledger = build();
                    Ok(None)
                }
                other => panic!("неизвестная операция {other}"),
            };
            let place = format!("seed {seed}, шаг {index} ({op})");
            match (&result, step.get("error")) {
                (Err(error), Some(expected)) => {
                    let (code, message) = error_of(error);
                    assert_eq!(code, expected["code"].as_str().unwrap_or_default(), "{place}: код");
                    // Текст отказа на испорченном файле содержит путь — каталоги разные.
                    if code != "USAGE_LEDGER_CORRUPT" {
                        assert_eq!(message, expected["message"].as_str().unwrap_or_default(), "{place}: текст");
                    }
                }
                (Err(error), None) => panic!("{place}: Rust отказал {error:?}, JS — нет"),
                (Ok(_), Some(expected)) => panic!("{place}: JS отказал {expected}, Rust — нет"),
                (Ok(value), None) => {
                    if let Some(expected) = step.get("result") {
                        let actual = value.as_ref().unwrap_or(&Value::Null);
                        assert!(same_json(actual, expected), "{place}: результат {actual} вместо {expected}");
                    }
                }
            }
            let file = std::fs::read_to_string(&storage_file).ok();
            if let Some(text) = step.get("file").and_then(Value::as_str) {
                assert_eq!(file.as_deref(), Some(text), "{place}: файл");
            }
            assert_eq!(file.as_ref().map(sk_core::hash::sha256_hex).as_deref(), step["file_sha256"].as_str(), "{place}: хеш файла");
        }
    }
    assert!(operations > 2000, "эталон слишком мал: {operations}");
}

#[test]
fn provider_usage_normalization_matches_js() {
    let fixture = fixture();
    let cases = fixture["usages"].as_array().expect("usage");
    for (index, case) in cases.iter().enumerate() {
        let actual = normalize_provider_usage(case.get("usage"), case.get("fallback"));
        assert!(same_json(&actual, &case["result"]), "случай {index}: {} → {actual} вместо {}", case["usage"], case["result"]);
    }
    assert!(cases.len() >= 200);
}

#[test]
fn input_estimate_matches_js() {
    let fixture = fixture();
    let cases = fixture["estimates"].as_array().expect("оценки");
    for (index, case) in cases.iter().enumerate() {
        let expected = case["estimated_tokens"].as_i64().expect("оценка");
        let max_output = case["max_output"].as_i64().expect("выход");
        assert_eq!(estimated_input_tokens(&case["input"]) + max_output, expected, "случай {index}: {}", case["input"]);
    }
    assert!(cases.len() >= 150);
}
