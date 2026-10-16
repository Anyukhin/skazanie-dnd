//! Перенос `server/encounter-narration.mjs`: эталон JS
//! (`fixtures/encounter-narration.json.gz`, генератор
//! `fixtures/gen-encounter-narration.mjs`). Своего файла тестов у модуля в JS
//! нет; ниже — контракт рассказчика и формулировки, на которых держится
//! `test/encounter-deadly-tier.test.mjs`.

mod common;

use common::{events_of, verify, Fixture};
use serde_json::{json, Value};
use sk_narration::encounter_narration::*;
use sk_narration_base::deterministic_narration::assert_narrator_contract;

#[test]
fn encounter_narration_matches_js_fixture() {
    let fixture = Fixture::new(include_bytes!("../fixtures/encounter-narration.json.gz"));
    let checked = verify(&fixture, |name, case| {
        let events = events_of(&fixture.arg(case, 0));
        Some(match name {
            "encounterNarration" => json!({ "result": encounter_narration(&events, &fixture.arg(case, 1).unwrap_or(Value::Null)) }),
            "hasEncounterEvent" => json!({ "result": has_encounter_event(&events) }),
            _ => return None,
        })
    });
    assert!(checked > 1_000, "сверено {checked} случаев");
}

#[test]
fn deadly_encounter_is_named_plainly() {
    let events = [
        json!({ "event_id": "enc-1", "event_type": "EncounterCreated", "payload": { "encounter": { "difficulty": "deadly", "enemies": [{ "name": "Огр" }] } } }),
        json!({ "event_type": "CombatStarted", "payload": {} }),
    ];
    let text = encounter_narration(&events, &json!({})).expect("встреча есть");
    assert!(text.ends_with(" Огр. Силы неравны: это заведомо превосходящий противник. Инициатива определена, бой начинается."), "{text}");
    assert!(has_encounter_event(&events));
    assert_eq!(encounter_narration(&[json!({ "event_type": "CombatStarted" })], &json!({})), None);
}

#[test]
fn encounter_narrator_contract() {
    assert_narrator_contract(&EncounterNarrator).expect("контракт");
    let narrator = register_encounter_narrator().expect("регистрация");
    assert_eq!(narrator.id(), "encounter");
    assert_eq!(narrator.priority(), 30.0);
    assert_eq!(narrator.prompt_version(), "encounter-narrator/v2");
    assert_eq!(narrator.provider(), "deterministic-encounter");
}
