//! Сверка `normalize_command` с эталоном JS (`fixtures/normalize-command.json`,
//! генератор — `fixtures/gen-normalize-command.mjs`): команды корпуса паритета,
//! мусорные команды всех типов и вход не объектом. Сравнивается строка
//! `JSON.stringify` (порядок ключей важен: команда целиком уходит в
//! `pending_command` окна реакции), большой ответ — её sha256.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_rules::command::normalize::normalize_command;
use sk_rules::context::sequence_uuids;
use sk_rules::pause::Halt;

const FIXTURE: &str = include_str!("../fixtures/normalize-command.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

#[test]
fn normalize_command_matches_js() {
    let cases = DATA["cases"].as_array().expect("случаи");
    assert!(cases.len() > 3_000, "эталон полон");
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let mut uuid = sequence_uuids("uuid");
        let result = normalize_command(&case["input"], &case["state"], &mut uuid);
        let ok = match (&result, case.get("error")) {
            (Ok(command), None) => {
                let text = js::stringify(command);
                match case.get("expected_sha256") {
                    Some(hash) => sk_core::hash::sha256_hex(text.as_bytes()) == hash.as_str().unwrap_or(""),
                    None => text == js::stringify(&case["expected"]),
                }
            }
            (Err(halt), Some(error)) => {
                let name = match halt {
                    Halt::Rule(_) => "RulesValidationError".to_string(),
                    Halt::Fault(fault) => fault.name.clone(),
                    Halt::Pause(_) => "Pause".into(),
                };
                json!(name) == error["name"] && halt.code().map(Value::from).unwrap_or(Value::Null) == error["code"]
            }
            _ => false,
        };
        if !ok {
            failures.push(format!(
                "#{index} {}: вход {} → Rust {} ожидалось {}",
                case["source"],
                js::stringify(&case["input"]).chars().take(300).collect::<String>(),
                match &result {
                    Ok(command) => js::stringify(command).chars().take(600).collect::<String>(),
                    Err(halt) => format!("{halt}"),
                },
                js::stringify(case.get("expected").or_else(|| case.get("error")).unwrap_or(&Value::Null)).chars().take(600).collect::<String>(),
            ));
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn missing_command_id_takes_a_fresh_uuid() {
    let mut uuid = sequence_uuids("u");
    let first = normalize_command(&json!({ "command_type": "DeclareAction" }), &json!({ "state_version": 0 }), &mut uuid).expect("команда");
    let second = normalize_command(&json!({ "command_type": "DeclareAction", "commandId": 7 }), &json!({ "state_version": 0 }), &mut uuid).expect("команда");
    assert_eq!(first["command_id"], "u-1");
    assert_eq!(second["command_id"], "7");
}

#[test]
fn duplicate_spell_targets_are_refused() {
    let mut uuid = sequence_uuids("u");
    let refused = normalize_command(&json!({ "command_type": "CastSpell", "spell_id": "longstrider", "target_ids": ["a", "a"] }), &json!({}), &mut uuid);
    assert_eq!(refused.unwrap_err().code(), Some("INVALID_SPELL_TARGETS"));
}

#[test]
fn prototype_command_types_fail_like_js() {
    let mut uuid = sequence_uuids("u");
    for kind in ["constructor", "toString", "__proto__"] {
        let result = normalize_command(&json!({ "command_type": kind }), &json!({}), &mut uuid);
        assert!(matches!(result, Err(Halt::Fault(ref fault)) if fault.name == "TypeError"), "{kind}");
    }
}
