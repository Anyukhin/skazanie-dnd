//! Сверка задачи Р10 с эталоном JS (`fixtures/r10.json.gz`, генератор —
//! `fixtures/gen-r10.mjs`): блоки проверки 71–73, полный `resolveCommand`
//! на ветках `UseCombatAction`, `MoveActor`, `EndTurn` (мягкая проверка) и
//! цепочки «пауза → ответ на окно реакции».
//!
//! Разбор, дошедший до заглушки другой задачи волны 3 (`MakeAttack` — Р8,
//! `CastSpell` — Р9, `StartCombat` — Р11…), не сверяется: тест печатает их
//! число по заглушкам.

use std::collections::BTreeMap;
use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::pause::Halt;
use sk_rules::resolve::{api, Resolved};

const FIXTURE: &[u8] = include_bytes!("../fixtures/r10.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});
static NORMALIZED: LazyLock<Vec<Value>> = LazyLock::new(|| {
    DATA["states"].as_array().expect("состояния").iter().map(|state| sk_rules::normalize::normalize_campaign_state(state).expect("нормализация")).collect()
});

const U: &str = "__undefined__";

fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

fn out(value: &Value) -> Value {
    let text = js::stringify(value);
    if text.encode_utf16().count() > 160 && std::env::var_os("SK_R10_FULL").is_none() {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn outcome(result: Result<Value, Halt>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(&value) }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Halt::Fault(fault)) => json!({ "fault": fault.name }),
        Err(Halt::Pause(pause)) => json!({ "pause": pause.kind.class_name(), "window": out(&pause.window_event), "command": out(&pause.command), "prefix": out(&Value::Array(pause.prefix_events.clone())) }),
    }
}

fn expected_outcome(expected: &Value) -> Value {
    match expected.get("fault") {
        Some(name) => json!({ "fault": name }),
        None => expected.clone(),
    }
}

fn resolved_json(resolved: &Resolved) -> Value {
    json!({ "command": resolved.command, "events": resolved.events, "rolls": resolved.rolls })
}

/// Кости генератора эталона (`WrapRng`): значения по кругу, приведённые к грани.
struct WrapRng {
    values: Vec<i64>,
    index: usize,
}

impl Rng for WrapRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        let value = self.values[self.index % self.values.len()];
        self.index += 1;
        Ok(minimum + (value - 1) % (maximum - minimum + 1))
    }
}

fn sequence(values: &Value) -> ServiceDice<DiceService<WrapRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(WrapRng { values, index: 0 }, "roll"))
}

fn report(label: &str, failures: &[String], total: usize, stubs: &BTreeMap<String, usize>) {
    if !stubs.is_empty() {
        eprintln!("{label}: дошло до заглушек других задач: {stubs:?}");
    }
    assert!(failures.is_empty(), "{label}: расхождений {} из {total}:\n{}", failures.len(), failures.iter().take(if std::env::var_os("SK_R10_FULL").is_some() { 400 } else { 8 }).cloned().collect::<Vec<_>>().join("\n"));
}

/// Разбор с мягкой проверкой; `None` — дошёл до заглушки (её имя — в `stubs`).
fn run(input: &Value, state: &Value, context: &Context, values: &Value, stubs: &mut BTreeMap<String, usize>) -> Option<Value> {
    let mut dice = sequence(values);
    let mut uuid = sequence_uuids("uuid");
    let result = api::with_lenient_validation(|| api::resolve_command(input, state, &mut dice, context, &mut uuid));
    if let Err(halt @ Halt::Rule(_)) = &result {
        if halt.is_unported() {
            if let Halt::Rule(error) = halt {
                *stubs.entry(error.message.clone()).or_default() += 1;
            }
            return None;
        }
    }
    Some(outcome(result.map(|resolved| resolved_json(&resolved))))
}

#[test]
fn validate_blocks_match_js() {
    let names = ["check_combat_action", "check_move_actor", "check_move_speed"];
    let blocks: Vec<_> = sk_rules::validate::BLOCKS.iter().filter(|block| names.contains(&block.name)).collect();
    assert_eq!(blocks.len(), 3);
    let cases = DATA["blocks"].as_array().expect("блоки");
    let mut failures = Vec::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let context = Context::from_json(&case["context"]);
        let mut validation = sk_rules::validate::Validation { state: &NORMALIZED[s], command: deep(&case["command"]), context: &context, actor_fate: None };
        let result = blocks.iter().try_for_each(|block| (block.check)(&mut validation)).map(|()| validation.command.clone());
        let actual = outcome(result);
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("блок s={s} {}: Rust {} ожидалось {}", case["command"]["action_id"], actual, expected));
        }
    }
    report("блоки 71–73", &failures, cases.len(), &BTreeMap::new());
}

#[test]
fn resolve_command_matches_js() {
    let cases = DATA["resolves"].as_array().expect("разборы");
    let mut failures = Vec::new();
    let mut stubs = BTreeMap::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let input = deep(&case["input"]);
        let context = Context::from_json(&case["context"]);
        let Some(actual) = run(&input, raw, &context, &case["v"], &mut stubs) else { continue };
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{} {} s={s}: Rust {} ожидалось {}", input["command_type"], input["action_id"], actual, expected));
        }
    }
    report("разбор", &failures, cases.len(), &stubs);
}

#[test]
fn reaction_window_chains_match_js() {
    let cases = DATA["chains"].as_array().expect("цепочки");
    let mut failures = Vec::new();
    let mut stubs = BTreeMap::new();
    let mut before: Vec<Value> = Vec::with_capacity(cases.len());
    for case in cases {
        let from = case.get("from").or_else(|| case.get("chain")).and_then(Value::as_u64).expect("исток") as usize;
        // Состояние до ответа: исток (разбор или прежний ответ цепочки) и его события.
        let (mut state, source) = match case.get("from") {
            Some(_) => {
                let source = &DATA["resolves"][from];
                (NORMALIZED[source["s"].as_u64().expect("состояние") as usize].clone(), source)
            }
            None => (before[from].clone(), &cases[from]),
        };
        for event in source["events_full"].as_array().expect("события истока") {
            state = sk_rules::replay::apply_game_event(&state, event).expect("событие истока");
        }
        before.push(state.clone());
        let input = deep(&case["input"]);
        let context = Context::from_json(&case["context"]);
        let Some(actual) = run(&input, &state, &context, &case["v"], &mut stubs) else { continue };
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("цепочка {from} {}: Rust {} ожидалось {}", input["action_id"], actual, expected));
        }
    }
    report("цепочки", &failures, cases.len(), &stubs);
}
