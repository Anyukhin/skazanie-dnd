//! Сверка `monster_actions` с эталоном JS (`fixtures/monster-actions.json`,
//! генератор `fixtures/gen-monster-actions.mjs`) и перенос проверок
//! `test/bestiary-monster-actions.test.mjs`, касающихся самого модуля.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_combat_base::monster_actions::{
    monster_action_available, monster_action_spent_marker, monster_action_usage_key, monster_action_uses_spent, monster_area_action, monster_attack_target_allowed,
    monster_multiattack_sequence_for, monster_multiattack_sequences, monster_on_hit_target_allowed, monster_recharge_minimum,
};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/monster-actions.json")).expect("эталон приёмов чудовищ"));

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn strings(value: &Value) -> Vec<String> {
    array(value).iter().map(|item| item.as_str().expect("строка").to_string()).collect()
}

#[test]
fn action_summaries_match_js() {
    let actions = array(&FIXTURE["actions"]);
    let cases = array(&FIXTURE["summaries"]);
    assert!(cases.len() > 700);
    let mut areas = 0;
    for case in cases {
        let action = Some(&actions[case["action"].as_u64().expect("индекс") as usize]);
        let conditions = array(&case["conditions"]);
        let area = monster_area_action(action);
        areas += usize::from(area.is_some());
        let actual = json!({
            "action": case["action"],
            "conditions": case["conditions"],
            "area": area,
            "recharge": monster_recharge_minimum(action),
            "key": monster_action_usage_key(action),
            "spent": monster_action_uses_spent(action, conditions),
            "available": monster_action_available(action, conditions),
            "marker": monster_action_spent_marker(action, conditions),
        });
        assert_eq!(actual, *case, "{}", action.expect("приём"));
    }
    assert!(areas > 150, "областей: {areas}");
}

#[test]
fn target_requirements_match_js() {
    for case in array(&FIXTURE["targets"]) {
        let allowed = monster_attack_target_allowed(Some(&case["action"]), array(&case["conditions"]), case["sourceId"].as_str());
        assert_eq!(allowed, case["allowed"] == true, "{case}");
    }
}

#[test]
fn on_hit_target_filters_match_js() {
    for case in array(&FIXTURE["onHitCases"]) {
        let target = if case["target"].is_null() { None } else { Some(&case["target"]) };
        assert_eq!(monster_on_hit_target_allowed(&case["onHit"], target), case["allowed"] == true, "{case}");
    }
}

#[test]
fn multiattack_sequences_match_js() {
    let actors = array(&FIXTURE["actors"]);
    for case in array(&FIXTURE["multiattack"]) {
        let actor = &actors[case["actor"].as_u64().expect("индекс") as usize];
        let actor = if actor.is_null() { None } else { Some(actor) };
        assert_eq!(json!(monster_multiattack_sequences(actor)), case["sequences"], "{}", case["actor"]);
        for lookup in array(&case["lookups"]) {
            let used = strings(&lookup["used"]);
            let sequence = monster_multiattack_sequence_for(actor, lookup["next"].as_str().expect("следующий"), &used);
            assert_eq!(json!(sequence), lookup["sequence"], "{lookup}");
        }
    }
}

// --- перенос test/bestiary-monster-actions.test.mjs --------------------------

#[test]
fn several_uses_count_one_by_one_and_shared_recharge_links_variants() {
    let spike = json!({ "id": "tail-spike", "uses": 3 });
    let mut conditions: Vec<Value> = Vec::new();
    for _ in 0..3 {
        assert!(monster_action_available(Some(&spike), &conditions));
        let marker = monster_action_spent_marker(Some(&spike), &conditions).expect("маркер");
        conditions.push(Value::String(marker));
    }
    assert!(!monster_action_available(Some(&spike), &conditions));
    let fire = json!({ "id": "fire-breath", "recharge": { "success": [5, 6], "group": "breaths" } });
    let sleep = json!({ "id": "sleep-breath", "recharge": { "success": [5, 6], "group": "breaths" } });
    let spent = vec![Value::String(monster_action_spent_marker(Some(&fire), &[]).expect("маркер"))];
    assert!(!monster_action_available(Some(&sleep), &spent));
}

#[test]
fn real_breath_weapons_are_formalized_areas() {
    let breath = json!({
        "id": "fire-breath", "name_ru": "Огненное дыхание", "kind": "save_area", "area": { "shape": "cone", "length_ft": 30 },
        "save": { "ability": "dex", "dc": 17, "success": "half_damage" }, "damage": [{ "expression": "16d6", "average": 56, "type": "fire" }],
        "recharge": { "die": "1d6", "success": [5, 6], "check": "start_of_turn" }, "mechanics_status": "requires_handler",
    });
    let area = monster_area_action(Some(&breath)).expect("область");
    assert_eq!((area["name"].as_str(), area["recharge"].as_i64(), area["shape"].as_str()), (Some("Огненное дыхание"), Some(5), Some("cone")));
    assert_eq!((area["length_feet"].as_i64(), area["width_feet"].as_i64(), &area["recharge_group"]), (Some(30), Some(5), &Value::Null));
}
