//! Старые сохранения (`test/old-save-registries.test.mjs`): `null` в шагах мира.

use serde_json::{json, Value};
use sk_world_story::offscreen_world::*;

fn step_ids(state: &Value) -> Vec<&str> {
    state["steps"].as_array().expect("шаги").iter().map(|step| step["id"].as_str().expect("id")).collect()
}

#[test]
fn null_steps_and_entries_are_dropped() {
    let entry = json!({ "kind": "quest_clock", "summary": "Время идёт", "quest_id": "quest-1" });
    let state = normalize_offscreen_world_state(Some(&json!({ "steps": [null, { "id": "step-1", "entries": [null, entry] }], "watch": [null] })));
    assert_eq!(step_ids(&state), ["step-1"]);
    assert_eq!(state["steps"][0]["entries"].as_array().map(Vec::len), Some(1));
    let raw = json!({ "schema_version": state["schema_version"], "steps": [null], "watch": [] });
    let event = json!({ "event_type": "OffscreenWorldStepResolved", "payload": { "step": { "id": "step-2", "entries": [entry] } } });
    assert_eq!(step_ids(&apply_offscreen_world_event(Some(&raw), Some(&event))), ["step-2"]);
}
