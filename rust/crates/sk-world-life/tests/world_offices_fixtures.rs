//! `world_offices`: эталон JS (`fixtures/world-offices.json`) — тесты модуля,
//! исполненные в процессе генератора, перехват вызовов в конвейере на корпусе
//! паритета и случайные должности с мусором старых сохранений.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, JsError, Outcome};
use serde_json::{json, Value};
use sk_world_life::world_offices::*;

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    let empty = json!({});
    // Параметр по умолчанию `= {}` в JS: `undefined` — пустой объект.
    let d = |index: usize| args.get(index).unwrap_or(&empty);
    match name {
        "validateOfficeConfiguration" => match validate_office_configuration(a(0), d(1)) {
            Ok(office) => ok(office),
            Err(error) => Err(JsError::new(WorldOfficeValidationError::NAME, &error.code, &error.message)),
        },
        "normalizeWorldOfficesState" => ok(normalize_world_offices_state(Some(d(0)), d(1))),
        "planOfficeVacancyDrafts" => {
            let events = match a(1) {
                Some(Value::Array(items)) => items.clone(),
                _ => Vec::new(),
            };
            ok(Value::Array(plan_office_vacancy_drafts(d(0), &events, d(2))))
        }
        "planOfficeSuccessionDrafts" => ok(Value::Array(plan_office_succession_drafts(d(0), d(1)))),
        "applyWorldOfficeEvent" => ok(apply_world_office_event(Some(d(0)), d(1), d(2))),
        "officesForViewer" => ok(Value::Array(offices_for_viewer(Some(d(0)), d(1)))),
        "officeChronicleEntry" => ok_opt(office_chronicle_entry(d(0), d(1))),
        other => {
            let _ = v(0);
            panic!("неизвестная функция эталона {other}")
        }
    }
}

#[test]
fn world_offices_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/world-offices.json"));
    let summary = check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 3_000, "{summary:?}");
}
