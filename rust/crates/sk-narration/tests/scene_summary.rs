//! Перенос `server/scene-summary.mjs`: эталон JS (`fixtures/scene-summary.json.gz`,
//! генератор `fixtures/gen-scene-summary.mjs`) и проверки самого модуля из
//! `test/scene-summary.test.mjs` (без Rules Engine, replay и брифа — их
//! переносят крейты движка и агентов).

mod common;

use common::{events_of, outcome, verify, Fixture};
use serde_json::{json, Value};
use sk_narration::scene_summary::*;

#[test]
fn scene_summary_matches_js_fixture() {
    let fixture = Fixture::new(include_bytes!("../fixtures/scene-summary.json.gz"));
    let checked = verify(&fixture, |name, case| {
        let first = fixture.arg(case, 0);
        Some(match name {
            "eventsSinceSceneStart" => json!({ "result": events_since_scene_start(&events_of(&first)) }),
            "notableSceneMoments" => json!({ "result": notable_scene_moments(&events_of(&first)) }),
            "buildSceneSummaryText" => outcome(build_scene_summary_text(first.as_ref()), |summary| summary.to_json()),
            "sceneSummaryFor" => outcome(scene_summary_for(first.as_ref()), Value::String),
            _ => return None,
        })
    });
    assert!(checked > 1_500, "сверено {checked} случаев");
}

fn event(kind: &str, payload: Value) -> Value {
    json!({ "event_type": kind, "payload": payload })
}

#[test]
fn scene_events_start_after_the_last_transition() {
    let events = [event("RulingRecorded", json!({})), event("SceneAdvanced", json!({})), event("QuestResolved", json!({ "summary": "Старосту спасли" }))];
    assert_eq!(events_since_scene_start(&events), &events[2..]);
    assert_eq!(events_since_scene_start(&events[..1]).len(), 1);
}

#[test]
fn notable_moments_are_consequences_not_every_roll() {
    let moments = notable_scene_moments(&[
        event("DieRolled", json!({ "total": 17 })),
        event("WorldFactRecorded", json!({ "fact": { "predicate": "scene_change", "summary": "Таверна сгорела дотла." } })),
        event("WorldFactRecorded", json!({ "fact": { "predicate": "scene_change", "summary": "Таверна сгорела дотла" } })),
        event("RulingRecorded", json!({ "ruling": { "question": "Пересечь мост?", "outcome": "success" } })),
        event("RulingRecorded", json!({ "ruling": { "stakes": "Падение", "question": "Перепрыгнуть пропасть?", "outcome": "failure" } })),
        event("EncounterEnded", json!({ "reason": "", "outcome": "enemies_defeated" })),
        event("MerchantPurchaseCompleted", json!({ "item": { "name": "Верёвка" }, "quantity": 2 })),
    ]);
    assert_eq!(moments, ["Таверна сгорела дотла", "Перепрыгнуть пропасть? — не вышло", "бой окончен (противники повержены)", "куплено: Верёвка ×2"]);
}

#[test]
fn summary_answers_where_what_and_why() {
    let summary = build_scene_summary_text(Some(&json!({
        "state": { "scene": { "location": "Норвин", "title": "Рыночная площадь" } },
        "events": [event("NpcPromiseRecorded", json!({ "promise": { "text": "Староста заплатит за голову волка." } }))],
        "decision": "отряд идёт за наградой",
        "destination": "Логово волков",
    })))
    .expect("без исключения");
    assert_eq!(summary.title, "Рыночная площадь");
    assert_eq!(
        summary.summary,
        "Отряд был в локации «Норвин» (Рыночная площадь). Заметное: дано обещание: Староста заплатит за голову волка. Отряд ушёл в «Логово волков»: отряд идёт за наградой."
    );
}

#[test]
fn quiet_scene_is_described_honestly_and_empty_scene_gives_nothing() {
    let quiet = scene_summary_for(Some(&json!({ "state": { "scene": { "title": "Тракт" } }, "events": [event("DieRolled", json!({}))] }))).expect("без исключения");
    assert_eq!(quiet, "Сцена «Тракт». Ничего, что изменило бы мир, здесь не произошло. Отряд двинулся дальше.");
    assert_eq!(scene_summary_for(Some(&json!({ "events": [event("SceneAdvanced", json!({}))] }))).as_deref(), Ok(""));
    assert_eq!(scene_summary_for(None).as_deref(), Ok(""));
}

/// Замечено в JS: `QuestResolved` без `summary` и `outcome` печатает «undefined»;
/// `null` вместо объекта параметров или состояния — `TypeError`.
#[test]
fn js_quirks_are_kept() {
    assert!(build_scene_summary_text(Some(&Value::Null)).is_err());
    assert!(scene_summary_for(Some(&json!({ "state": null, "events": [event("DieRolled", json!({}))] }))).is_err());
    assert!(scene_summary_for(Some(&json!({ "state": null, "events": [] }))).is_ok());
}

/// Квест без итога и исхода заметен без `undefined`.
#[test]
fn quest_without_summary_or_outcome_has_no_undefined() {
    let event = |payload: Value| json!({ "event_type": "QuestResolved", "payload": payload });
    assert_eq!(notable_scene_moments(&[event(json!({ "quest_id": "q1" }))]), ["квест завершён"]);
    assert_eq!(notable_scene_moments(&[event(json!({ "outcome": "success" }))]), ["квест завершён: success"]);
}
