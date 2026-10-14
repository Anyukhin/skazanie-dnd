//! Сверка `legendary_actions` с эталоном JS (`fixtures/legendary-actions.json`,
//! генератор `fixtures/gen-legendary-actions.mjs`).

use std::sync::LazyLock;

use serde_json::Value;
use sk_combat_base::legendary_actions::{
    choose_legendary_action, legendary_action_for, legendary_profile_for, legendary_resistance_decision, legendary_resistance_spent, legendary_uses_spent, legendary_window_key,
    legendary_window_spent, LegendaryTarget,
};
use sk_core::js;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/legendary-actions.json")).expect("эталон легендарных действий"));

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn actor(index: &Value) -> &'static Value {
    &FIXTURE["actors"][index.as_u64().expect("индекс") as usize]
}

fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        other => js::s(Some(other)),
    }
}

#[test]
fn profiles_match_js() {
    let cases = array(&FIXTURE["profiles"]);
    assert!(cases.len() > 500);
    for case in cases {
        let profile = legendary_profile_for(Some(actor(&case["actor"])));
        assert_eq!(profile.map_or(Value::Null, |profile| profile.to_json()), case["profile"], "{}", actor(&case["actor"]));
    }
}

#[test]
fn action_lookups_match_js() {
    for case in array(&FIXTURE["lookups"]) {
        let id = if case["missing"] == true { None } else { Some(&case["id"]) };
        let action = legendary_action_for(Some(actor(&case["actor"])), id);
        assert_eq!(action.map_or(Value::Null, |action| action.to_json()), case["action"], "{case}");
    }
}

#[test]
fn window_keys_and_marker_counts_match_js() {
    for case in array(&FIXTURE["windows"]) {
        let combat = if case["missing"] == true { None } else { Some(&case["combat"]) };
        assert_eq!(legendary_window_key(combat), case["key"].as_str().expect("ключ"), "{case}");
    }
    for case in array(&FIXTURE["counts"]) {
        let conditions: Vec<&str> = array(&case["conditions"]).iter().filter_map(Value::as_str).collect();
        let window_key = case["windowKey"].as_str().expect("окно");
        assert_eq!(legendary_uses_spent(&conditions) as u64, case["uses"].as_u64().expect("число"), "{case}");
        assert_eq!(legendary_window_spent(&conditions, window_key), case["window"] == true, "{case}");
        assert_eq!(legendary_resistance_spent(&conditions) as u64, case["resistance"].as_u64().expect("число"), "{case}");
    }
}

#[test]
fn resistance_decisions_match_js() {
    for case in array(&FIXTURE["decisions"]) {
        let input = &case["input"];
        let decision = legendary_resistance_decision(
            Some(actor(&input["actor"])),
            js::number(Some(&input["spentUses"])),
            array(&input["conditions"]),
            js::number(Some(&input["damage"])),
            js::number(Some(&input["hpBefore"])),
        );
        assert_eq!(decision.map_or(Value::Null, |decision| decision.to_json()), case["decision"], "{input}");
    }
}

#[test]
fn action_choices_match_js() {
    for case in array(&FIXTURE["choices"]) {
        let targets: Vec<LegendaryTarget> = array(&case["targets"]).iter().map(|target| LegendaryTarget { id: string_of(&target["id"]), distance_feet: js::number(Some(&target["distanceFeet"])) }).collect();
        let cooling: Vec<&str> = array(&case["cooling"]).iter().filter_map(Value::as_str).collect();
        let choice = choose_legendary_action(Some(actor(&case["actor"])), js::number(Some(&case["remainingUses"])), &targets, |marker| cooling.contains(&marker));
        assert_eq!(choice.map_or(Value::Null, |choice| choice.to_json()), case["choice"], "{case}");
    }
}
