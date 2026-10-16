//! `courier_letters`: эталон JS (`fixtures/courier-letters.json`) — тесты
//! модуля, исполненные в процессе генератора, перехват вызовов в конвейере на
//! корпусе паритета и случайные письма с мусором старых сохранений.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_world_life::courier_letters::*;

fn leagues(value: Option<f64>) -> Value {
    value.map_or(Value::Null, js::num)
}

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    let empty = json!({});
    // Параметр по умолчанию `= {}` в JS: `undefined` — пустой объект.
    let d = |index: usize| args.get(index).unwrap_or(&empty);
    match name {
        "normalizeCourierLetterState" => ok(normalize_courier_letter_state(a(0))),
        "applyCourierLetterEvent" => ok(apply_courier_letter_event(a(0), v(1))),
        "worldLeaguesBetween" => ok(leagues(world_leagues_between(a(0), a(1), a(2)))),
        "courierToneFor" => ok(json!(courier_tone_for(a(0)))),
        "courierAddresseeFor" => ok_opt(courier_addressee_for(d(0), a(1), a(2), None)),
        "courierLetterAddressees" => ok(Value::Array(courier_letter_addressees(d(0)))),
        "courierLettersFor" => ok(Value::Array(courier_letters_for(d(0), a(1)))),
        "openCourierLettersFor" => ok(Value::Array(open_courier_letters_for(d(0), a(1)))),
        "courierLetterPromiseFrom" => ok_opt(courier_letter_promise_from(a(0))),
        "courierLetterReplyBase" => ok(json!(courier_letter_reply_base(d(0), a(1)))),
        "courierLetterReplyFor" => ok_opt(courier_letter_reply_for(d(0), a(1))),
        "planCourierLetter" => ok_opt(plan_courier_letter(d(0), d(1))),
        "planCourierLetterTicks" => ok(Value::Array(plan_courier_letter_ticks(d(0), args.option(1, "elapsedMinutes")))),
        "courierLetterForViewer" => ok_opt(courier_letter_for_viewer(Some(d(0)), js::truthy(args.option(1, "isAdmin")))),
        "courierLettersForViewer" => ok(courier_letters_for_viewer(d(0), d(1))),
        "courierLetterChronicleEntry" => ok_opt(courier_letter_chronicle_entry(d(0))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn courier_letters_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/courier-letters.json"));
    let summary = check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 8_000, "{summary:?}");
    assert!(summary.legacy > 500, "{summary:?}");
}
