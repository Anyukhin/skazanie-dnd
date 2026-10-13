//! Сверка `clarification_registry` с эталоном JS
//! (`fixtures/gen-clarification-registry.mjs`): итог каждой операции, коды и
//! тексты отказов и содержимое файла хранилища — байт в байт.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::Value;
use sk_core::RuleError;
use sk_narration_base::clarification_registry::{ClarificationRegistry, ClarificationRegistryOptions};
use sk_narration_base::jsx;

struct Harness {
    file: PathBuf,
    clock: Arc<AtomicU64>,
    counter: Arc<AtomicUsize>,
    ttl: Option<Value>,
}

impl Harness {
    fn options(&self) -> ClarificationRegistryOptions {
        let clock = Arc::clone(&self.clock);
        let counter = Arc::clone(&self.counter);
        ClarificationRegistryOptions {
            storage_file: Some(self.file.clone()),
            ttl_ms: self.ttl.clone(),
            now: Some(Box::new(move || f64::from_bits(clock.load(Ordering::SeqCst)))),
            id_factory: Some(Box::new(move || format!("id-{}", counter.fetch_add(1, Ordering::SeqCst) + 1))),
        }
    }

    fn file(&self) -> Option<String> {
        std::fs::read_to_string(&self.file).ok()
    }
}

fn run(registry: &mut ClarificationRegistry, op: &str, args: &[Value]) -> Result<Value, RuleError> {
    let first = args.first();
    let second = args.get(1).cloned().unwrap_or(Value::Null);
    let options = first.cloned().unwrap_or(Value::Null);
    let id = first.filter(|value| !value.is_null());
    match op {
        "create" => registry.create(&options),
        "rememberDialogue" => registry.remember_dialogue(&options),
        "recentDialogue" => registry.recent_dialogue(&options).map(Value::Array),
        "resetDialogue" => registry.reset_dialogue(&options).map(Value::from),
        "current" => registry.current(&options).map(|card| card.unwrap_or(Value::Null)),
        "resolve" => registry.resolve(id, &second),
        "complete" => registry.complete(id, &second).map(|()| Value::Null),
        "revokeProposal" => registry.revoke_proposal(id, &second).map(|()| Value::Null),
        "isProposalRevoked" => registry.is_proposal_revoked(id, &second).map(Value::Bool),
        "issueProposal" => registry.issue_proposal(&options),
        "resolveProposal" => registry.resolve_proposal(id, &second),
        "getProposal" => registry.get_proposal(id, &second),
        other => panic!("неизвестная операция {other}"),
    }
}

#[test]
fn registry_scenarios_match_js() {
    let scenarios: Vec<Value> = serde_json::from_str(include_str!("../fixtures/clarification-registry.json")).expect("эталон");
    let mut total = 0;
    for scenario in &scenarios {
        let name = scenario["name"].as_str().unwrap_or("?");
        let directory = std::env::temp_dir().join(format!("sk-clarification-fixture-{name}-{}", sk_core::hash::uuid_v4()));
        std::fs::create_dir_all(&directory).expect("каталог");
        let harness = Harness {
            file: directory.join("registry.json"),
            clock: Arc::new(AtomicU64::new(1_000f64.to_bits())),
            counter: Arc::new(AtomicUsize::new(0)),
            ttl: scenario.get("ttlMs").filter(|value| !value.is_null()).cloned(),
        };
        if let Some(seed) = scenario["seedFile"].as_str() {
            std::fs::write(&harness.file, seed).expect("исходный файл");
        }
        let steps = scenario["steps"].as_array().expect("шаги");
        let mut registry = ClarificationRegistry::new(harness.options()).expect("реестр");
        let mut expected_file = steps[0]["file"].as_str().map(str::to_string);
        assert_eq!(harness.file(), expected_file, "{name}: файл после создания");
        for (index, step) in steps.iter().enumerate().skip(1) {
            total += 1;
            let op = step["op"].as_str().expect("операция");
            let outcome = match op {
                "advance" => {
                    let now = f64::from_bits(harness.clock.load(Ordering::SeqCst)) + step["ms"].as_f64().expect("мс");
                    harness.clock.store(now.to_bits(), Ordering::SeqCst);
                    Ok(Value::Null)
                }
                "restart" => ClarificationRegistry::new(harness.options()).map(|restarted| {
                    registry = restarted;
                    Value::Null
                }),
                _ => run(&mut registry, op, step["args"].as_array().expect("аргументы")),
            };
            let context = format!("{name}, шаг {index}: {step}");
            match (&outcome, step.get("error")) {
                (Ok(result), None) => assert_eq!(jsx::stringify(result), step["result"].as_str().expect("итог"), "{context}"),
                (Err(error), Some(expected)) => {
                    assert_eq!(error.code, expected["code"].as_str().expect("код"), "{context}");
                    assert_eq!(error.message, expected["message"].as_str().expect("текст"), "{context}");
                }
                (outcome, expected) => panic!("{context}: итог {outcome:?}, ожидалось {expected:?}"),
            }
            if let Some(file) = step.get("file") {
                expected_file = file.as_str().map(str::to_string);
            }
            assert_eq!(harness.file(), expected_file, "{context}: файл хранилища");
        }
        std::fs::remove_dir_all(&directory).ok();
    }
    assert!(scenarios.len() >= 9 && total > 550, "сценариев {}, шагов {total}", scenarios.len());
}

#[test]
fn complete_with_padded_id_is_a_coded_refusal() {
    // В JS `complete(' id ')` находит уточнение после обрезки, а отметку ставит
    // по необрезанному ключу и падает на `undefined.completed` (TypeError).
    // Rust отвечает кодом `CLARIFICATION_NOT_FOUND` — отклонение задокументировано.
    let mut registry = ClarificationRegistry::new(ClarificationRegistryOptions {
        now: Some(Box::new(|| 1_000.0)),
        id_factory: Some(Box::new(|| "x".to_string())),
        ..Default::default()
    })
    .expect("реестр");
    let card = registry.create(&serde_json::json!({ "campaignId": "c", "actorId": "a", "question": "q" })).expect("уточнение");
    assert_eq!(card["id"], "clarification:x");
    let options = serde_json::json!({ "campaignId": "c", "actorId": "a" });
    let error = registry.complete(Some(&Value::String(" clarification:x ".into())), &options).expect_err("ключ в пробелах");
    assert_eq!(error.code, "CLARIFICATION_NOT_FOUND");
    registry.complete(Some(&Value::String("clarification:x".into())), &options).expect("завершение");
    assert_eq!(registry.current(&serde_json::json!({ "campaignId": "c", "actorId": "a", "stateVersion": 0 })).expect("текущее"), None);
}
