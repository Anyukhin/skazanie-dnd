//! Сверка `reaction_preferences` с эталоном JS
//! (`fixtures/reaction-preferences.json`, генератор
//! `fixtures/gen-reaction-preferences.mjs`) и перенос проверки политики из
//! `test/reaction-preferences.test.mjs` (остальные проверки там — движок
//! правил и HTTP).

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_combat_base::reaction_preferences::{is_configurable_reaction, is_reaction_mode, normalize_reaction_preferences, plan_reaction_by_preference, reaction_mode_for};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/reaction-preferences.json")).expect("эталон режимов реакций"));

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

#[test]
fn normalization_matches_js() {
    for case in array(&FIXTURE["normalized"]) {
        assert_eq!(normalize_reaction_preferences(Some(&case["raw"])), case["result"], "{}", case["raw"]);
    }
}

#[test]
fn plans_match_js() {
    let cases = array(&FIXTURE["plans"]);
    let mut decided = 0;
    for case in cases {
        let plan = plan_reaction_by_preference(Some(&case["preferences"]), Some(&case["window"]));
        decided += usize::from(plan.is_some());
        assert_eq!(plan.map_or(Value::Null, |plan| plan.to_json()), case["plan"], "{case}");
    }
    assert!(decided > 40, "решений: {decided}");
}

#[test]
fn modes_and_predicates_match_js() {
    for case in array(&FIXTURE["modes"]) {
        let mode = reaction_mode_for(Some(&case["preferences"]), case["actor"].as_str().expect("герой"), case["reaction"].as_str().expect("реакция"));
        assert_eq!(mode, case["mode"].as_str().expect("режим"), "{case}");
    }
    for case in array(&FIXTURE["predicates"]) {
        assert_eq!(is_reaction_mode(Some(&case["value"])), case["mode"] == true, "{case}");
        assert_eq!(is_configurable_reaction(Some(&case["value"])), case["configurable"] == true, "{case}");
    }
}

#[test]
fn policy_auto_chooses_never_declines_mixed_window_asks() {
    let window = json!({ "actor_id": "hero", "action_ids": ["cast:shield", "uncanny-dodge"] });
    let plan = |preferences: Value, window: &Value| plan_reaction_by_preference(Some(&preferences), Some(window)).map(|plan| plan.to_json());
    assert_eq!(plan(json!({}), &window), None, "по умолчанию — спрашивать");
    assert_eq!(plan(json!({ "hero": { "uncanny-dodge": "auto" } }), &window), Some(json!({ "mode": "auto", "action_id": "uncanny-dodge" })));
    assert_eq!(plan(json!({ "hero": { "cast:shield": "auto", "uncanny-dodge": "auto" } }), &window), Some(json!({ "mode": "auto", "action_id": "cast:shield" })));
    assert_eq!(plan(json!({ "hero": { "cast:shield": "never" } }), &window), None);
    assert_eq!(plan(json!({ "hero": { "cast:shield": "never", "uncanny-dodge": "never" } }), &window), Some(json!({ "mode": "never", "action_id": "decline-reaction" })));
    assert_eq!(plan(json!({ "hero": { "opportunity-attack": "never" } }), &json!({ "actor_id": "hero", "action_ids": ["opportunity-attack", "readied-attack"] })), None);
    assert_eq!(plan(json!({ "hero": { "opportunity-attack": "auto" } }), &json!({ "actor_id": "hero", "trigger": "failed-saving-throw", "action_ids": ["opportunity-attack"] })), None);
    assert_eq!(plan(json!({ "hero": { "opportunity-attack": "auto" } }), &json!({ "actor_id": "hero", "free_choice": true, "action_ids": ["opportunity-attack"] })), None);
    assert_eq!(
        normalize_reaction_preferences(Some(&json!({ "hero": { "cast:shield": "ask", "parry": "auto", "cast:fireball": "auto", "riposte": "sometimes" }, "ghost": {} }))),
        json!({ "hero": { "parry": "auto" } })
    );
}
