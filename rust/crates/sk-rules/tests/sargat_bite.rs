//! Runtime Rust regression for the authored Sargat bite rider.

use serde_json::{json, Value};
use sk_dice::{DiceService, SequenceRng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::resolve::api;

fn state(ruleset: &str, resistance: bool) -> Value {
    let hero = json!({
        "id": "hero", "character": "Испытатель", "role": "Воин · ур. 7",
        "hp": 72, "maxHp": 72, "armor": 18, "speed": 30, "x": 3, "y": 2,
        "abilities": { "str": 18, "dex": 14, "con": 16, "int": 10, "wis": 12, "cha": 10 },
        "damage_resistances": if resistance { json!(["fire"]) } else { json!([]) },
    });
    let worlds: Value = serde_json::from_str(include_str!("../../../../data/campaign-worlds-v1.json")).unwrap();
    let npc = worlds["templates"].as_array().unwrap().iter().find(|template| template["id"] == "astohan-plains").unwrap()["opening"]["npcs"].as_array().unwrap().iter().find(|npc| npc["id"] == "astohan-sargat").unwrap().clone();
    let actor = sk_heroes::authored_npc::authored_npc_combatant(Some(&npc), Some(&npc["mechanics"]), Some(&json!({ "x": 4, "y": 2 }))).unwrap();
    normalize_campaign_state(&json!({
        "state_version": 0, "sessionCode": "SARGAT-BITE", "ruleset_id": ruleset,
        "partyMemberIds": ["hero"], "players": [hero], "enemies": [actor],
        "scene": { "location_id": "astohan-vulkanis-brazier", "cells": (0..96).map(|i| json!({ "x": i % 12, "y": i / 12, "type": "floor", "revealed": true })).collect::<Vec<_>>() },
        "mechanics": { "positions": { "hero": { "x": 3, "y": 2 }, "astohan-sargat": { "x": 4, "y": 2 } }, "combat": {
            "active": true, "round": 1, "initiative": [{ "actor_id": "astohan-sargat", "total": 20 }, { "actor_id": "hero", "total": 10 }], "active_index": 0,
            "action_economy": { "astohan-sargat": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 }, "hero": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 } }
        } }
    })).unwrap()
}

fn attack(state: &Value, rolls: Vec<i64>) -> Value {
    let input = json!({ "command_type": "MakeAttack", "command_id": "sargat-bite-runtime", "actor_id": "astohan-sargat", "target_id": "hero", "action_id": "sargat-bite", "server_authoritative": true });
    let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "isNpcScheduler": true }));
    let mut dice = ServiceDice::new(DiceService::deterministic(SequenceRng::new(rolls), "sargat"));
    let mut uuid = sequence_uuids("sargat-event");
    let outcome = api::with_lenient_validation(|| api::resolve_command(&input, state, &mut dice, &context, &mut uuid)).unwrap().into_resolved();
    json!(outcome.events)
}

fn damages(events: &Value) -> Vec<Value> {
    events.as_array().unwrap().iter().filter(|event| event["event_type"] == "DamageApplied" && event["target_ids"].as_array().unwrap().iter().any(|id| id == "hero")).map(|event| event["payload"].clone()).collect()
}

#[test]
fn sargat_bite_has_fire_rider_on_normal_critical_miss_and_resistance() {
    let normal = damages(&attack(&state("dnd_5e_2014", false), vec![15, 4, 4, 3]));
    assert_eq!(normal.iter().map(|damage| (damage["damage_type"].clone(), damage["raw_amount"].clone())).collect::<Vec<_>>(), vec![(json!("piercing"), json!(14)), (json!("fire"), json!(3))]);

    let critical_events = attack(&state("dnd_5e_2014", false), vec![20, 1, 1, 1, 1, 2, 2]);
    let critical = damages(&critical_events);
    assert_eq!(critical.iter().map(|damage| damage["raw_amount"].clone()).collect::<Vec<_>>(), vec![json!(10), json!(4)]);
    assert!(critical_events.as_array().unwrap().iter().any(|event| event["event_type"] == "DieRolled" && event["payload"]["damage_type"] == "fire" && event["payload"]["expression"] == "2d6"));

    assert!(damages(&attack(&state("dnd_5e_2014", false), vec![1])).is_empty());
    let resistant = damages(&attack(&state("dnd_5e_2014", true), vec![15, 4, 4, 3]));
    assert_eq!(resistant.iter().map(|damage| (damage["damage_type"].clone(), damage["applied_amount"].clone())).collect::<Vec<_>>(), vec![(json!("piercing"), json!(14)), (json!("fire"), json!(1))]);
}
