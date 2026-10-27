//! Старые сохранения (`test/old-save-registries.test.mjs`): `null` в реестре
//! пленных и в почте отряда.

use serde_json::{json, Value};
use sk_world_life::captives::*;
use sk_world_life::courier_letters::*;

fn ids<'a>(state: &'a Value, key: &str) -> Vec<&'a str> {
    state[key].as_array().expect("список").iter().map(|entry| entry["id"].as_str().expect("id")).collect()
}

#[test]
fn null_captives_and_letters_are_dropped() {
    let captives = normalize_captives_state(Some(&json!({ "captives": [null, { "id": "captive-1", "npc_id": "npc-1" }] })));
    assert_eq!(ids(&captives, "captives"), ["captive-1"]);
    let applied = apply_captive_event(Some(&json!({ "captives": [null] })), &json!({ "event_type": "CaptiveFed", "payload": { "captive_id": "captive-1" } }), &json!({}));
    assert_eq!(applied["captives"], json!([]));
    let letters = normalize_courier_letter_state(Some(&json!({ "letters": [null, { "id": "letter-1", "hero_id": "hero-1", "addressee_id": "npc-1" }] })));
    assert_eq!(ids(&letters, "letters"), ["letter-1"]);
    assert_eq!(courier_letter_chronicle_entry(&json!({ "event_type": "CourierLetterSent", "payload": { "letter": null, "letter_id": "letter-1" } })), None);
}
