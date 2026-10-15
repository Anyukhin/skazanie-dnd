//! Перенос проверок самого модуля из `test/captives.test.mjs` (без HTTP и без
//! Rules Engine): захват, характер, допрос, голод, редьюсер и проекция.

use serde_json::{json, Value};
use sk_world_life::captives::*;

const VILLAGE: &str = "Тихий Брод";

fn bandit(id: &str, x: i64, y: i64) -> Value {
    json!({
        "id": id, "name": format!("Бандит {}", &id[id.len() - 1..]), "hp": 0, "maxHp": 11, "armor": 12,
        "creature_type": "humanoid", "stat_block_id": "srd_5_2_1:bandit", "provenance": { "xp": 25 }, "x": x, "y": y, "alive": false,
    })
}

/// Сцена сразу после победы: один разбойник сдался, второй нокаутнут, волк сдался.
fn campaign(kind: &str) -> Value {
    json!({
        "sessionCode": "CAPTIVE",
        "scene": { "title": "Околица", "location": VILLAGE, "location_id": "village" },
        "worldMap": { "locations": [{ "id": "village", "name": VILLAGE, "kind": kind }] },
        "enemies": [
            bandit("enemy-surrendered", 4, 1),
            bandit("enemy-knocked", 4, 3),
            { "id": "enemy-wolf", "name": "Волк 1", "hp": 0, "maxHp": 11, "creature_type": "beast", "stat_block_id": "srd_5_2_1:wolf", "x": 2, "y": 4, "alive": false },
        ],
        "social": { "npcs": [] },
        "mechanics": {
            "world_time": { "elapsed_minutes": 0 },
            "conditions": {
                "enemy-surrendered": [{ "id": "surrendered" }],
                "enemy-knocked": [{ "id": "unconscious" }],
                "enemy-wolf": [{ "id": "surrendered" }],
            },
            "resting": { "enemy-knocked": { "kind": "short", "reason": "knockout" } },
        },
    })
}

fn taken(state: &Value) -> Value {
    let mut registry = state.get("captives").cloned();
    for draft in plan_capture_drafts(state) {
        registry = Some(apply_captive_event(registry.as_ref(), &draft, state));
    }
    let mut next = state.clone();
    next["captives"] = registry.unwrap_or(Value::Null);
    next
}

#[test]
fn surrender_and_knockout_become_captives_beast_does_not() {
    let state = campaign("village");
    let enemies = capturable_enemies(&state);
    let ids: Vec<&str> = enemies.iter().filter_map(|entry| entry.enemy["id"].as_str()).collect();
    assert_eq!(ids, ["enemy-knocked", "enemy-surrendered"]);
    let origins: Vec<&str> = enemies.iter().map(|entry| entry.origin).collect();
    assert_eq!(origins, ["knocked_out", "surrendered"]);

    let drafts = plan_capture_drafts(&state);
    let taken: Vec<&Value> = drafts.iter().filter(|draft| draft["event_type"] == "CaptiveTaken").collect();
    assert_eq!(taken.len(), 2);
    assert!(taken.iter().all(|draft| draft["visibility"] == "party"));
    // В журнале запись полная — режет только проекция.
    assert!(taken.iter().all(|draft| draft["payload"]["captive"]["stat_block_id"] == "srd_5_2_1:bandit" && draft["payload"]["captive"]["xp"] == 25));
    assert!(taken.iter().all(|draft| draft["payload"]["captive"]["known_fact_ids"].as_array().map(Vec::len) == Some(1)));
    let profile = drafts.iter().find(|draft| draft["event_type"] == "NpcSocialProfileUpserted").expect("профиль пленного");
    assert_eq!(profile["payload"]["npc"]["goals"], json!(["выбраться живым"]));
    assert_eq!(profile["payload"]["npc"]["location"], VILLAGE);
    assert!(profile["payload"]["npc"]["tags"].as_array().is_some_and(|tags| tags.iter().any(|tag| tag.as_str().is_some_and(|tag| tag.starts_with("faction:band:")))));
}

#[test]
fn persona_is_deterministic_and_nickname_only_for_humans() {
    let state = campaign("village");
    let human = captive_persona(&state, &json!({ "id": "enemy-surrendered", "name": "Бандит 1", "creature_type": "humanoid" }));
    assert_ne!(human["name"], "Бандит 1");
    assert_eq!(human, captive_persona(&state, &json!({ "id": "enemy-surrendered", "name": "Бандит 1", "creature_type": "humanoid" })));
    let devil = captive_persona(&state, &json!({ "id": "enemy-surrendered", "name": "Барбед дьявол 2", "creature_type": "fiend" }));
    assert_eq!(devil["name"], "Барбед дьявол 2");
    assert_eq!(devil["role"], "Барбед дьявол");
    assert_eq!(devil["temper"], human["temper"]);
    assert_eq!(devil["voice"], human["voice"]);
}

#[test]
fn band_id_strips_role_suffix() {
    assert_eq!(captive_band_id(Some(&json!("srd:goblin-warrior")), None), "goblin");
    assert_eq!(captive_band_id(Some(&json!("srd:goblin-minion")), None), "goblin");
    assert_eq!(captive_band_id(None, Some(&json!("Орк 3"))), "орк");
    assert_eq!(captive_band_id(None, None), "unknown");
}

#[test]
fn fear_lowers_interrogation_dc_and_each_fact_raises_it() {
    let state = taken(&campaign("village"));
    let captive = held_captives(&state).into_iter().find(|captive| captive["actor_id"] == "enemy-surrendered").expect("пленный");
    let policy = captive_interrogation_policy(&state, &captive, &json!({ "skill": "intimidation" }));
    let difficulty = policy["difficulty"].as_i64().expect("СЛ");
    assert!((5..=25).contains(&difficulty));
    assert_eq!(policy["fear_shift"], -3);
    assert!(policy["fact_id"].as_str().is_some_and(|id| !id.is_empty()));
    let mut told = captive.clone();
    told["revealed_fact_ids"] = json!([policy["fact_id"]]);
    let after = captive_interrogation_policy(&state, &told, &json!({ "skill": "intimidation" }));
    assert!(after["difficulty"].as_i64() > Some(difficulty));
    assert_eq!(after["exhausted"], true);
}

#[test]
fn released_and_resolved_are_not_taken_again() {
    let state = taken(&campaign("village"));
    let captive = held_captives(&state).into_iter().find(|captive| captive["actor_id"] == "enemy-surrendered").expect("пленный");
    let registry = apply_captive_event(state.get("captives"), &json!({ "event_type": "CaptiveReleased", "payload": { "captive_id": captive["id"], "disposition": "ally", "at_minutes": 30 } }), &state);
    let mut released = state.clone();
    released["captives"] = registry;
    let stored = captive_for(&released, captive.get("id")).expect("запись");
    assert_eq!(stored["status"], "released");
    assert_eq!(stored["disposition"], "ally");
    assert_eq!(stored["resolved_at_minutes"], 30);
    assert!(capturable_enemies(&released).is_empty(), "решённая судьба закрывает плен навсегда");
    assert!(!plan_capture_drafts(&released).iter().any(|draft| draft["event_type"] == "CaptiveTaken"));
}

#[test]
fn death_of_held_captive_is_learned_from_npc_died() {
    let state = taken(&campaign("village"));
    let mut later = state.clone();
    later["mechanics"]["world_time"]["elapsed_minutes"] = json!(90);
    let registry = apply_captive_event(state.get("captives"), &json!({ "event_type": "NpcDied", "payload": { "npc_id": "enemy-surrendered" } }), &later);
    let mut dead = state.clone();
    dead["captives"] = registry;
    let stored = held_captive_for_npc(&dead, Some(&json!("enemy-surrendered")));
    assert!(stored.is_none());
    let record = captive_list(&dead).into_iter().find(|captive| captive["npc_id"] == "enemy-surrendered").expect("запись");
    assert_eq!(record["status"], "dead");
    assert_eq!(record["resolution"], "killed");
    assert_eq!(record["resolved_at_minutes"], 90);
    assert!(!plan_captive_neglect_commands(&dead, Some(&json!(CAPTIVE_FEED_INTERVAL_MINUTES))).iter().any(|command| command["captive_id"] == record["id"]));
}

#[test]
fn a_day_without_food_is_neglect_and_feeding_resets_the_clock() {
    let state = taken(&campaign("village"));
    assert!(plan_captive_neglect_commands(&state, Some(&json!(CAPTIVE_FEED_INTERVAL_MINUTES - 1))).is_empty());
    let due = plan_captive_neglect_commands(&state, Some(&json!(CAPTIVE_FEED_INTERVAL_MINUTES)));
    assert_eq!(due.len(), 2);
    assert_eq!(due[0]["command_type"], "NeglectCaptive");
    let drafts = plan_captive_neglect_drafts(&state, Some(&json!(CAPTIVE_FEED_INTERVAL_MINUTES)));
    assert_eq!(drafts.len(), 2);
    assert!(drafts.iter().all(|draft| draft["payload"]["hours_without_food"] == 24 && draft["visibility"] == "party"));

    let id = due[0]["captive_id"].clone();
    let fed = apply_captive_event(state.get("captives"), &json!({ "event_type": "CaptiveFed", "payload": { "captive_id": id, "at_minutes": CAPTIVE_FEED_INTERVAL_MINUTES } }), &state);
    let mut after = state.clone();
    after["captives"] = fed;
    assert!(!plan_captive_neglect_commands(&after, Some(&json!(CAPTIVE_FEED_INTERVAL_MINUTES))).iter().any(|command| command["captive_id"] == id));
    let neglected = apply_captive_event(after.get("captives"), &json!({ "event_type": "CaptiveNeglected", "payload": { "captive_id": due[1]["captive_id"], "at_minutes": CAPTIVE_FEED_INTERVAL_MINUTES } }), &after);
    after["captives"] = neglected;
    assert!(plan_captive_neglect_commands(&after, Some(&json!(CAPTIVE_FEED_INTERVAL_MINUTES + 60))).is_empty(), "раз в сутки, а не каждый такт");
}

#[test]
fn bounty_and_settlement() {
    let state = taken(&campaign("village"));
    let captive = held_captives(&state).remove(0);
    assert_eq!(captive_bounty_cp(&captive), 50);
    assert_eq!(captive_bounty_cp(&json!({ "xp": 0 })), 20);
    assert_eq!(captive_bounty_cp(&json!({ "xp": 1_000_000 })), 2_000);
    assert_eq!(captive_settlement_for(&state), Some(json!({ "id": "village", "name": VILLAGE, "kind": "village" })));
    assert_eq!(captive_settlement_for(&campaign("wilds")), None);
    assert_eq!(captive_settlement_for(&campaign("capital")).map(|node| node["kind"].clone()), Some(json!("capital")));
}

#[test]
fn viewer_sees_counter_not_hidden_knowledge() {
    let state = taken(&campaign("village"));
    let player = captives_for_viewer(&state, &json!({ "isAdmin": false }));
    let visible = player["captives"].as_array().expect("список");
    assert_eq!(visible.len(), 2);
    for entry in visible {
        for key in ["known_fact_ids", "stat_block_id", "xp"] {
            assert!(entry.get(key).is_none(), "{key} игроку не принадлежит");
        }
        assert_eq!(entry["pending_knowledge"], 1);
    }
    assert!(!sk_core::js::stringify(&player).contains("srd_5_2_1:bandit"));
    let gm = captives_for_viewer(&state, &json!({ "isAdmin": true }));
    assert_eq!(gm["captives"][0]["stat_block_id"], "srd_5_2_1:bandit");
    assert_eq!(gm["captives"][0]["xp"], 25);
    assert_eq!(captive_for_viewer(Some(&json!({ "id": ":bad", "npc_id": "x" }))), None);
}

#[test]
fn registry_survives_garbage_of_old_saves() {
    let registry = normalize_captives_state(Some(&json!({ "captives": [
        null, 5, "captive", { "id": "captive:a", "npc_id": "n", "xp": "40", "interrogations": "2" },
        { "id": "captive:a", "npc_id": "dup" }, { "id": "constructor", "npc_id": "proto" }, { "id": " bad id", "npc_id": "x" },
    ] })));
    let captives = registry["captives"].as_array().expect("список");
    assert_eq!(captives.len(), 2);
    assert_eq!(captives[0]["xp"], 40);
    assert_eq!(captives[0]["interrogations"], 2);
    assert_eq!(captives[1]["id"], "constructor");
    // `"2" + 1` в JS — склейка «21».
    let next = apply_captive_event(Some(&json!({ "schema_version": 1, "captives": [{ "id": "captive:a", "npc_id": "n", "interrogations": "2" }] })), &json!({ "event_type": "CaptiveInterrogated", "payload": { "captive_id": "captive:a" } }), &json!({}));
    assert_eq!(next["captives"][0]["interrogations"], 21);
}

#[test]
fn settlement_kinds_match_law_and_command_sets_are_closed() {
    // Сторож `test/law-and-order.test.mjs`: две копии множества не расходятся.
    assert_eq!(SETTLEMENT_LOCATION_KINDS, sk_society::law_and_order::SETTLEMENT_LOCATION_KINDS);
    // `NeglectCaptive` — только у часов, не у игрока (`captives-ui-contract`).
    assert!(!CAPTIVE_PLAYER_COMMAND_TYPES.contains(&"NeglectCaptive"));
    assert!(CAPTIVE_COMMAND_TYPES.contains(&"NeglectCaptive"));
    assert!(CAPTIVE_PLAYER_COMMAND_TYPES.iter().all(|kind| CAPTIVE_COMMAND_TYPES.contains(kind)));
}
