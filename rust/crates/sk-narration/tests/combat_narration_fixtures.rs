//! Сверка `combat_narration` с эталоном JS (`fixtures/combat-narration.json.gz`,
//! генератор `fixtures/gen-combat-narration.mjs`): настоящие вызовы при прогоне
//! тестов JS, корпус паритета и случайные события боя с мусором.

mod common;

use std::cell::RefCell;

use common::{events_of, outcome, verify, Fixture};
use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_narration::combat_narration::*;

fn fallback_text(value: Option<&Value>) -> String {
    js::s(value)
}

fn run(fixture: &Fixture, name: &str, case: &Value) -> Option<Value> {
    let arg = |index| fixture.arg(case, index);
    let null = Value::Null;
    Some(match name {
        "bundle" | "tacticalNarration" | "tacticalNarrationParts" | "combatJournalVoice" | "hasCombatNarrationEvent" => {
            let (events_arg, state_arg, options_arg) = if name == "hasCombatNarrationEvent" { (arg(0), None, None) } else { (arg(0), arg(1), arg(2)) };
            let events = events_of(&events_arg);
            let state = state_arg.unwrap_or(Value::Null);
            let options = options_arg.as_ref();
            let text = || outcome(combat_narration(&events, &state, options), Value::String);
            let parts = || outcome(tactical_narration_parts(&events, &state, options), |parts| parts.to_json());
            match name {
                "bundle" => json!({ "result": {
                    "text": text(),
                    "parts": parts(),
                    "voice": combat_journal_voice(&events, &state).to_json(),
                    "has": has_combat_narration_event(&events),
                }}),
                "tacticalNarration" => text(),
                "tacticalNarrationParts" => parts(),
                "combatJournalVoice" => json!({ "result": combat_journal_voice(&events, &state).to_json() }),
                _ => json!({ "result": has_combat_narration_event(&events) }),
            }
        }
        "tacticalNarrationOr" => {
            let events = events_of(&arg(0));
            let state = arg(1).unwrap_or(Value::Null);
            let fallback = arg(2);
            let options = arg(3);
            let seen = RefCell::new(Value::Null);
            let result = match fallback.as_ref().and_then(|value| value.get("$fallback")) {
                Some(text) => {
                    let text = js::s(Some(text));
                    tactical_narration_or(
                        &events,
                        &state,
                        |filtered| {
                            *seen.borrow_mut() = Value::String(hash::sha256_hex(js::stringify(&Value::Array(filtered.to_vec()))));
                            text
                        },
                        options.as_ref(),
                    )
                }
                None => tactical_narration_or_text(&events, &state, &fallback_text(fallback.as_ref()), options.as_ref()),
            };
            outcome(result, |text| json!({ "text": text, "seen": seen.borrow().clone() }))
        }
        "encounterSetting" => {
            let state = arg(0).unwrap_or(Value::Null);
            let encounter = arg(1);
            // Значение по умолчанию `encounter = {}` — только для `undefined`.
            let empty = json!({});
            json!({ "result": encounter_setting(&state, Some(encounter.as_ref().unwrap_or(&empty))) })
        }
        "encounterIntro" => {
            let event = arg(0).unwrap_or(Value::Null);
            json!({ "result": encounter_intro(&event, &arg(1).unwrap_or(null)) })
        }
        "encounterEndText" => json!({ "result": encounter_end_text(arg(0).as_ref()) }),
        "damageTypeLabel" => json!({ "result": damage_type_label(arg(0).as_ref()) }),
        _ => return None,
    })
}

#[test]
fn combat_narration_matches_js_fixture() {
    let fixture = Fixture::new(include_bytes!("../fixtures/combat-narration.json.gz"));
    let checked = verify(&fixture, |name, case| run(&fixture, name, case));
    assert!(checked > 4_000, "сверено {checked} случаев");
}
