//! Перенос `server/scene-narration.mjs`: эталон JS (`fixtures/scene-narration.json.gz`,
//! генератор `fixtures/gen-scene-narration.mjs`) и проверки из
//! `test/scene-narration.test.mjs`.

mod common;

use common::{events_of, verify, Fixture};
use serde_json::{json, Value};
use sk_narration::scene_narration::*;
use sk_narration_base::deterministic_narration::{assert_narrator_contract, deterministic_narrator_for};

#[test]
fn scene_narration_matches_js_fixture() {
    let fixture = Fixture::new(include_bytes!("../fixtures/scene-narration.json.gz"));
    let checked = verify(&fixture, |name, case| {
        let events = events_of(&fixture.arg(case, 0));
        Some(match name {
            "sceneNarration" => json!({ "result": scene_narration(&events, &fixture.arg(case, 1).unwrap_or(Value::Null)) }),
            "hasSceneEvent" => json!({ "result": has_scene_event(&events) }),
            _ => return None,
        })
    });
    assert!(checked > 1_000, "сверено {checked} случаев");
}

#[test]
fn combined_narrator_keeps_committed_arrival_and_auto_created_merchant() {
    let events = [
        json!({ "event_type": "SceneAdvanced", "payload": { "transition": "Отряд покидает старый тракт.", "arrival": "Впереди открываются ворота Норвина." } }),
        json!({ "event_type": "MerchantCreated", "payload": { "merchant_id": "shop-norvin", "merchant": { "id": "shop-norvin", "name": "Илара", "location": "Город Норвин" } } }),
    ];
    let state = json!({ "merchants": [{ "id": "shop-norvin", "name": "Илара", "location": "Город Норвин" }] });
    let narration = scene_narration(&events, &state).expect("переход есть");
    for part in ["Отряд покидает старый тракт", "ворота Норвина", "Илара", "Город Норвин"] {
        assert!(narration.contains(part), "{narration}");
    }
    assert!(has_scene_event(&events));
}

#[test]
fn architect_phrases_without_full_stop_do_not_merge() {
    let narration = scene_narration(
        &[json!({ "event_type": "SceneAdvanced", "payload": {
            "transition": "Тордин покидает причал и добирается до таверны «Морской Змей»",
            "arrival": "В таверне пахнет солью и дешёвым элем!",
        } })],
        &json!({}),
    );
    assert_eq!(narration.as_deref(), Some("Тордин покидает причал и добирается до таверны «Морской Змей».\n\nВ таверне пахнет солью и дешёвым элем!"));
}

#[test]
fn travel_time_is_named_with_the_hour_of_arrival() {
    let narration = scene_narration(
        &[
            json!({ "event_type": "TimeAdvanced", "payload": { "elapsed_minutes": 150 } }),
            json!({ "event_type": "SceneAdvanced", "payload": { "transition": "Путь", "arrival": "Застава" } }),
        ],
        &json!({ "mechanics": { "world_time": { "elapsed_minutes": 600 } } }),
    );
    assert_eq!(narration.as_deref(), Some("Путь.\n\nЗастава. Дорога заняла около двух с половиной часов; вечереет."));
}

#[test]
fn non_scene_batch_is_ignored() {
    let events = [json!({ "event_type": "MerchantCreated" })];
    assert!(!has_scene_event(&events));
    assert_eq!(scene_narration(&events, &json!({})), None);
}

#[test]
fn scene_narrator_is_registered_first() {
    assert_narrator_contract(&SceneNarrator).expect("контракт");
    register_scene_narrator().expect("регистрация");
    // Повторная регистрация отдаёт итог первой, а не ошибку дубля.
    register_scene_narrator().expect("повтор");
    let events = [json!({ "event_type": "SceneAdvanced", "payload": {} }), json!({ "event_type": "MerchantCreated", "payload": {} })];
    let chosen = deterministic_narrator_for(&events).expect("рассказчик найден");
    assert_eq!(chosen.id(), "scene");
    assert_eq!(chosen.prompt_version(), "scene-narrator/v1");
    assert_eq!(chosen.provider(), "deterministic-scene");
}
