//! Замкнутые типы событий горячего пути (Ск5): после события из
//! `NORMALIZATION_CLOSED_EVENT_TYPES` итог редьюсера над нормализованным
//! состоянием — уже неподвижная точка нормализации, поэтому
//! `NormalizedState::applied` и `EventChain` её пропускают.
//!
//! Проверка по эталонам JS в git: `fixtures/r10.json.gz` (разборы с полными
//! событиями и события разбора `EndTurn` — Rust-разбор сверен с JS тестом
//! `r10.rs`), `fixtures/r5.json.gz` (вызовы с событиями),
//! `fixtures/reduce-r4a.json` и синтетика `fixtures/replay.json` (одно событие
//! над состоянием). Исходное состояние нормализуется, события применяются по
//! порядку, и после каждого события замкнутого типа
//!
//! - `normalize(итог) == settle_closed(итог)` (порядок ключей и запись
//!   чисел — как `JSON.stringify`; `settle_closed` — шаг метки начала хода
//!   для `TurnStarted`, `TurnEnded`, `ReactionWindowClosed`, у прочих итог
//!   как есть);
//! - путь с пропуском (`applied`) даёт то же, что полный путь (редьюсер и
//!   нормализация итога).
//!
//! Типы, которых в эталонах нет, проверяет корпус:
//! `sk-corpus closure <корпус>` (код выхода 3 — тип из списка не замкнут).

use std::collections::BTreeMap;
use std::io::Read;
use std::sync::LazyLock;

use serde_json::Value;
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalized::{NormalizedState, NORMALIZATION_CLOSED_EVENT_TYPES};
use sk_rules::resolve::api;

fn gz(bytes: &[u8]) -> Value {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
}

static R10: LazyLock<Value> = LazyLock::new(|| gz(include_bytes!("../fixtures/r10.json.gz")));
static R5: LazyLock<Value> = LazyLock::new(|| gz(include_bytes!("../fixtures/r5.json.gz")));
static R4A: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/reduce-r4a.json")).expect("эталон Р4а"));
static REPLAY: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/replay.json")).expect("эталон Р4б"));

const U: &str = "__undefined__";

/// Вход эталона без полей-«undefined» (как в `r10.rs`).
fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

/// Кости генератора эталона Р10: значения по кругу, приведённые к грани.
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

/// События Rust-разбора `EndTurn` эталона Р10 (`None` — отказ или заглушка).
fn end_turn_events(case: &Value, state: &Value) -> Option<Vec<Value>> {
    let values: Vec<i64> = case["v"].as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    let mut dice = ServiceDice::new(DiceService::deterministic(WrapRng { values, index: 0 }, "roll"));
    let mut uuid = sequence_uuids("uuid");
    let context = Context::from_json(&case["context"]);
    let resolved = api::with_lenient_validation(|| api::resolve_command(&deep(&case["input"]), state, &mut dice, &context, &mut uuid)).ok()?;
    Some(resolved.resolved().events.clone())
}

/// Типы списка, которых в эталонах нет: их замкнутость держит корпус.
const CORPUS_ONLY: &[&str] = &["AbilityCheckResolved", "ActionDeclared", "ConcentrationStarted", "HealingApplied", "PublicDieRolled", "ResourceSpent", "SavingThrowResolved", "SpellAreaCreated"];

#[derive(Default)]
struct Tally {
    checked: BTreeMap<String, usize>,
    failures: Vec<String>,
}

/// Начальное состояние и события одной записи эталона.
fn cases() -> Vec<(String, &'static Value, Vec<Value>)> {
    let mut out = Vec::new();
    let r10_states = R10["states"].as_array().expect("состояния Р10");
    for (index, case) in R10["resolves"].as_array().expect("разборы Р10").iter().enumerate() {
        let Some(state) = case["s"].as_u64().and_then(|s| r10_states.get(s as usize)) else { continue };
        let events = match case["events_full"].as_array() {
            Some(events) => events.clone(),
            None if case["input"]["command_type"] == "EndTurn" && case["o"].get("ok").is_some() => match end_turn_events(case, state) {
                Some(events) => events,
                None => continue,
            },
            None => continue,
        };
        out.push((format!("r10 resolves[{index}]"), state, events));
    }
    let r5_states = R5["states"].as_array().expect("состояния Р5");
    for (index, call) in R5["calls"].as_array().expect("вызовы Р5").iter().enumerate() {
        let (Some(state), Some(events)) = (call["s"].as_u64().and_then(|s| r5_states.get(s as usize)), call["a"][0]["events"].as_array()) else { continue };
        out.push((format!("r5 calls[{index}] {}", js::s(call.get("f"))), state, events.clone()));
    }
    let bases = R4A["bases"].as_array().expect("состояния Р4а");
    for (index, case) in R4A["cases"].as_array().expect("случаи Р4а").iter().enumerate() {
        let Some(state) = case["base"].as_u64().and_then(|base| bases.get(base as usize)) else { continue };
        if case["mode"] == "current" {
            out.push((format!("r4a cases[{index}]"), state, vec![case["event"].clone()]));
        }
    }
    let states = REPLAY["states"].as_array().expect("состояния Р4б");
    for (index, case) in REPLAY["synthetic"].as_array().expect("синтетика Р4б").iter().enumerate() {
        let Some(state) = case["state"].as_u64().and_then(|s| states.get(s as usize)) else { continue };
        if case["kind"] == "apply" {
            out.push((format!("replay synthetic[{index}]"), state, vec![case["event"].clone()]));
        }
    }
    out
}

fn check(place: &str, state: &Value, events: &[Value], tally: &mut Tally) {
    let Ok(mut current) = NormalizedState::normalize(state) else { return };
    for event in events {
        let kind = js::s(event.get("event_type"));
        let closed = NORMALIZATION_CLOSED_EVENT_TYPES.contains(&kind.as_str()) && sk_rules::normalized::keeps_normalized(current.mode(), event);
        let Ok(reduced) = current.clone().reduced(event) else { return };
        let Ok(full) = NormalizedState::normalize(&reduced) else { return };
        if closed {
            *tally.checked.entry(kind.clone()).or_default() += 1;
            let mut settled = reduced.clone();
            sk_rules::normalized::settle_closed(&mut settled, event);
            if js::stringify(full.value()) != js::stringify(&settled) {
                tally.failures.push(format!("{place} [{kind}]: нормализация меняет итог редьюсера"));
            }
            let skipped = current.clone().applied(event).expect("путь с пропуском");
            if js::stringify(skipped.value()) != js::stringify(full.value()) {
                tally.failures.push(format!("{place} [{kind}]: путь с пропуском расходится с полным"));
            }
        }
        current = full;
    }
}

#[test]
fn closed_event_types_keep_the_state_normalized() {
    let mut tally = Tally::default();
    sk_rules::replay::with_retention_mode("current", || {
        for (place, state, events) in cases() {
            check(&place, state, &events, &mut tally);
        }
    })
    .expect("режим удержания");
    for (kind, count) in &tally.checked {
        eprintln!("[closure] {kind}: {count}");
    }
    assert!(tally.failures.is_empty(), "{} расхождений:\n{}", tally.failures.len(), tally.failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    let missing: Vec<&str> = NORMALIZATION_CLOSED_EVENT_TYPES.iter().copied().filter(|kind| !tally.checked.contains_key(*kind) && !CORPUS_ONLY.contains(kind)).collect();
    assert!(missing.is_empty(), "типов списка нет в эталонах (внести в CORPUS_ONLY): {missing:?}");
    let stale: Vec<&str> = CORPUS_ONLY.iter().copied().filter(|kind| tally.checked.contains_key(*kind)).collect();
    assert!(stale.is_empty(), "тип из CORPUS_ONLY уже проверяется эталонами: {stale:?}");
}
