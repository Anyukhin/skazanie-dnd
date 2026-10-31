//! Сверка задачи Р11 с эталоном JS (`fixtures/r11.json.gz`, генератор —
//! `fixtures/gen-r11.mjs`): начало и конец боя, нападение на NPC, встреча,
//! предметы, двери и объекты сцены, уговор зверя, незнакомец сценария —
//! полным путём `resolveCommand` (мягкая проверка: блоки-заглушки других
//! задач пропускаются); `validateCommand` на тех же входах; `sortedInitiative`.
//!
//! Исход сверяется по sha256 строк `JSON.stringify` (команда, события,
//! броски) и по типам событий. `SK_R11_DUMP=<файл>` пишет полные исходы Rust
//! для разбора расхождений (пара к `SK_R11_FULL` генератора эталона).

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceService, SequenceRng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::pause::Interrupt;
use sk_rules::resolve::api;

const FIXTURE: &[u8] = include_bytes!("../fixtures/r11.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});

fn sha(value: &Value) -> String {
    sk_core::hash::sha256_hex(js::stringify(value).as_bytes())
}

fn sequence(values: &Value) -> ServiceDice<DiceService<SequenceRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), "roll"))
}

fn failure(halt: &Interrupt) -> Value {
    match halt {
        Interrupt::Rule(error) => json!({ "err": [error.code, error.message] }),
        Interrupt::Fault(fault) => json!({ "fault": fault.name }),
        Interrupt::Pause(pause) => json!({ "pause": pause.kind.class_name() }),
    }
}

/// Исход JS без текста прочей ошибки (тексты V8 и Rust различаются).
fn expected_outcome(expected: &Value) -> Value {
    match expected.get("fault") {
        Some(name) => json!({ "fault": name }),
        None => expected.clone(),
    }
}

fn report(failures: &[String], total: usize) {
    if !failures.is_empty() {
        let shown: Vec<&String> = failures.iter().take(25).collect();
        panic!("расхождений {} из {total}:\n{}", failures.len(), shown.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n"));
    }
}

#[test]
fn resolve_command_matches_js() {
    let cases = DATA["cases"].as_array().expect("разборы");
    let mut failures = Vec::new();
    let mut dump = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let input = &case["input"];
        let context = Context::from_json(&case["context"]);
        let mut dice = sequence(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        // `branch`: команда уже проверена JS (незнакомца дописывает блок
        // проверки сценария другой задачи) — сверяется ветка с её подготовкой.
        let result = if js::is_true(case.get("branch")) {
            sk_rules::resolve::vitals::resolve_branch_without_tail(input.clone(), raw, &mut dice, &context, &mut uuid)
        } else {
            api::with_lenient_validation(|| api::resolve_command(input, raw, &mut dice, &context, &mut uuid)).map(Outcome::into_resolved).map_err(Interrupt::from)
        };
        let actual = match &result {
            Ok(resolved) => {
                let types: Vec<Value> = resolved.events.iter().map(|event| event.get("event_type").cloned().unwrap_or(Value::Null)).collect();
                json!({ "ok": { "command": sha(&resolved.command), "events": sha(&Value::Array(resolved.events.clone())), "rolls": sha(&Value::Array(resolved.rolls.clone())), "types": types } })
            }
            Err(halt) => failure(halt),
        };
        if std::env::var_os("SK_R11_DUMP").is_some() {
            let full = match &result {
                Ok(resolved) => json!({ "command": resolved.command, "events": resolved.events, "rolls": resolved.rolls }),
                Err(halt) => failure(halt),
            };
            dump.push(json!({ "index": index, "o": full }));
        }
        let mut expected = expected_outcome(&case["o"]);
        let mut actual = actual;
        if js::is_true(case.get("branch")) {
            // Без проверки команда не нормализуется заново: сверяются события и броски.
            for outcome in [&mut actual, &mut expected] {
                if let Some(ok) = outcome.get_mut("ok").and_then(Value::as_object_mut) {
                    ok.shift_remove("command");
                }
            }
        }
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("#{index} {} s={s}: Rust {} ожидалось {}", input["command_type"], js::stringify(&actual).chars().take(400).collect::<String>(), js::stringify(&expected).chars().take(400).collect::<String>()));
        }
    }
    if let Some(path) = std::env::var_os("SK_R11_DUMP") {
        std::fs::write(path, js::stringify(&Value::Array(dump))).expect("запись дампа");
    }
    report(&failures, cases.len());
}

#[test]
fn validate_command_matches_js() {
    let cases = DATA["validations"].as_array().expect("проверки");
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let input = &case["input"];
        let context = Context::from_json(&case["context"]);
        let mut uuid = sequence_uuids("uuid");
        let result = api::with_lenient_validation(|| api::validate(input, raw, &context, &mut uuid));
        let actual = match &result {
            Ok(command) => json!({ "ok": sha(command) }),
            Err(halt) => failure(&Interrupt::from(halt.clone())),
        };
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("#{index} {} s={s}: Rust {} ожидалось {}", input["command_type"], actual, expected));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn sorted_initiative_matches_js() {
    let cases = DATA["initiatives"].as_array().expect("инициативы");
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let entries = case["entries"].as_array().cloned().unwrap_or_default();
        let sorted: Vec<Value> = sk_rules::npc_item_events::sorted_initiative(&entries).iter().map(|entry| entry["actor_id"].clone()).collect();
        if Value::Array(sorted.clone()) != case["o"] {
            failures.push(format!("#{index}: Rust {} ожидалось {}", Value::Array(sorted), case["o"]));
        }
    }
    report(&failures, cases.len());
}
