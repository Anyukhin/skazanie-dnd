//! Сверка общих блоков `validateCommand` (задача Р0) и разрыва перемирия с
//! эталоном JS (`fixtures/validate-common.json`, генератор —
//! `fixtures/gen-validate-common.mjs`: строки движка исполняются в области
//! имён открытой копии). Группы блоков идут в порядке JS: первый отказ —
//! итог группы.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_rules::context::Context;
use sk_rules::pause::{Halt, Step};
use sk_rules::validate::common::*;
use sk_rules::validate::Validation;

const FIXTURE: &str = include_str!("../fixtures/validate-common.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

type Check = fn(&mut Validation<'_>) -> Step;

fn group(name: &str) -> &'static [Check] {
    match name {
        "g1" => &[check_command_allowed, check_state_version, check_pending_reaction],
        "g2" => &[check_character_setup, check_campaign_paused, check_campaign_read_only],
        "g3" => &[check_dead_hero],
        "g4" => &[check_provenance, check_amount, check_resource, check_condition_required],
        other => panic!("группа {other}"),
    }
}

fn halt_json(halt: &Halt) -> Value {
    match halt {
        Halt::Rule(error) => json!({ "name": "RulesValidationError", "code": error.code, "message": error.message }),
        Halt::Fault(fault) => json!({ "name": fault.name, "code": fault.code }),
    }
}

#[test]
fn common_blocks_match_js() {
    let inputs = DATA["inputs"].as_array().expect("входы");
    let mut failures = Vec::new();
    for case in DATA["cases"].as_array().expect("случаи") {
        let input = &inputs[case["input"].as_u64().expect("индекс") as usize];
        let context = Context::from_json(&input["context"]);
        let mut validation = Validation { state: &input["state"], command: input["command"].clone(), context: &context, actor_fate: None };
        let result = group(case["group"].as_str().expect("группа")).iter().try_for_each(|check| check(&mut validation));
        let ok = match (&result, case.get("error")) {
            (Ok(()), None) => case["group"] != "g3" || validation.actor_fate.clone().unwrap_or(Value::Null) == case["actor_fate"],
            (Err(halt), Some(expected)) => {
                let actual = halt_json(halt);
                actual["name"] == expected["name"] && actual["code"] == expected["code"] && (expected["name"] != "RulesValidationError" || actual["message"] == expected["message"])
            }
            _ => false,
        };
        if !ok {
            failures.push(format!("{} {}: Rust {:?} ожидалось {}", case["group"], js::stringify(&input["command"]).chars().take(400).collect::<String>(), result.as_ref().err().map(halt_json), js::stringify(case)));
        }
    }
    assert!(failures.is_empty(), "расхождений {}:\n{}", failures.len(), failures.iter().take(6).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn truce_broken_matches_js() {
    for case in DATA["truce"].as_array().expect("перемирия") {
        let truce = &case["truce"];
        let events: Vec<Value> = if truce.is_null() {
            Vec::new()
        } else {
            sk_rules::resolve::truce_broken_event(&case["state"], &case["command"], &case["target_id"], truce).into_iter().collect()
        };
        assert_eq!(js::stringify(&Value::Array(events)), js::stringify(&case["events"]), "TruceBroken {case}");
    }
}
