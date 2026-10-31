//! Сверка задачи Р9 с эталоном JS (`fixtures/r9.json.gz`, генератор —
//! `fixtures/gen-r9.mjs`): `CastSpell` (авторитетный и прежний путь),
//! `StartConcentration`, `EndConcentration` и блоки проверки 30 и 69 — полным
//! путём `resolveCommand` с мягкой проверкой (блоки-заглушки других задач
//! волны 3 пропускаются).
//!
//! Записи, которые дошли до ветки-заглушки другой задачи (`MoveActor` — Р10,
//! `StartCombat` — Р11, …) или отказ JS в пропущенном блоке, не считаются
//! расхождением: их число печатается.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::pause::Halt;
use sk_rules::resolve::api;

const FIXTURE: &[u8] = include_bytes!("../fixtures/r9.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});

const U: &str = "__undefined__";

/// Последовательность, сворачиваемая в диапазон кости (`WrappingRng` генератора).
struct WrappingRng {
    values: Vec<i64>,
    index: usize,
}

impl Rng for WrappingRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        let Some(&value) = self.values.get(self.index) else {
            return Err(DiceError::Range("Тестовая последовательность бросков закончилась".into()));
        };
        self.index += 1;
        Ok(minimum + (value - 1).rem_euclid(maximum - minimum + 1))
    }
}

fn dice(values: &Value) -> ServiceDice<DiceService<WrappingRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(WrappingRng { values, index: 0 }, "roll"))
}

fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

/// Заплатка генератора: `[путь, значение]`, `U` — удалить ключ.
fn patched(base: &Value, patch: Option<&Value>) -> Value {
    let mut state = base.clone();
    for op in patch.and_then(Value::as_array).into_iter().flatten() {
        let path: Vec<String> = op[0].as_array().map(|keys| keys.iter().map(|key| js::s(Some(key))).collect()).unwrap_or_default();
        let Some((last, parents)) = path.split_last() else { continue };
        let mut parent = &mut state;
        for key in parents {
            parent = match parent {
                Value::Array(items) => &mut items[key.parse::<usize>().expect("индекс")],
                other => other.get_mut(key.as_str()).expect("путь заплатки"),
            };
        }
        let value = &op[1];
        match parent {
            Value::Array(items) => items[last.parse::<usize>().expect("индекс")] = deep(value),
            Value::Object(map) if value.as_str() == Some(U) => {
                map.shift_remove(last);
            }
            Value::Object(map) => {
                map.insert(last.clone(), deep(value));
            }
            _ => panic!("заплатка не к объекту"),
        }
    }
    state
}

fn out(value: &Value) -> Value {
    let text = js::stringify(value);
    if text.encode_utf16().count() > 160 {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn outcome(result: &Result<Value, Halt>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(value) }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Halt::Fault(fault)) => json!({ "fault": fault.name }),
    }
}

fn expected_outcome(expected: &Value) -> Value {
    match expected.get("fault") {
        Some(name) => json!({ "fault": name }),
        None => expected.clone(),
    }
}

#[test]
fn cast_spell_matches_js() {
    let cases = DATA["resolves"].as_array().expect("разборы");
    let mut failures = Vec::new();
    let mut equal = 0;
    let mut unported: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut refused_in_stub = 0;
    for (index, case) in cases.iter().enumerate() {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = patched(&DATA["states"][s], case.get("p"));
        let input = deep(&case["input"]);
        let context = Context::from_json(&case["context"]);
        let mut dice = dice(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        api::take_skipped_blocks();
        let result = api::with_lenient_validation(|| api::resolve_command(&input, &raw, &mut dice, &context, &mut uuid)).map(Outcome::into_resolved).map(|resolved| json!({ "command": resolved.command, "events": resolved.events, "rolls": resolved.rolls }));
        let skipped = api::take_skipped_blocks();
        if let Err(halt) = &result {
            if halt.is_unported() {
                let name = match halt {
                    Halt::Rule(error) => error.message.clone(),
                    _ => String::new(),
                };
                *unported.entry(name).or_default() += 1;
                continue;
            }
        }
        let actual = outcome(&result);
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) == js::stringify(&expected) {
            equal += 1;
        } else if !skipped.is_empty() && expected.get("err").is_some() {
            refused_in_stub += 1;
        } else {
            failures.push(format!("#{index} {} {} s={s}: Rust {} ожидалось {}", input["command_type"], input["spell_id"], js::stringify(&actual).chars().take(400).collect::<String>(), js::stringify(&expected).chars().take(400).collect::<String>()));
        }
    }
    eprintln!("r9: совпало {equal} из {}, заглушки других задач {unported:?}, отказ JS в пропущенном блоке {refused_in_stub}", cases.len());
    if !failures.is_empty() {
        let shown: Vec<&String> = failures.iter().take(25).collect();
        panic!("расхождений {} из {}:\n{}", failures.len(), cases.len(), shown.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n"));
    }
}
