//! Опциональная поимённая сверка заклинаний Ильвы и Мирры на 7-м уровне.
//!
//! Перед запуском сгенерировать небольшой fixture:
//! `node eval/astohan-level7-spell-rust-fixture.mjs tmp/astohan-spell-review/level7-named.json`
//! Затем выполнить `cargo test --release -p sk-rules --test level7_named -- --ignored`.
//! Fixture читается во время запуска и не попадает в исполняемый файл.

use serde_json::{json, Value};
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::pause::Halt;
use sk_rules::replay::replay_events;
use sk_rules::resolve::api;

struct EdgeRng { high: bool }

impl Rng for EdgeRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        Ok(if self.high { maximum } else { minimum })
    }
}

fn code(error: &Halt) -> String {
    match error {
        Halt::Rule(rule) => rule.code.clone(),
        Halt::Fault(fault) => fault.name.clone(),
    }
}

fn event_types(events: &[Value]) -> Vec<String> {
    let mut values: Vec<String> = events.iter().filter_map(|event| event.get("event_type").and_then(Value::as_str).map(str::to_owned)).collect();
    values.sort();
    values.dedup();
    values
}

fn awaken_state() -> Value {
    json!({
        "sessionCode": "AWAKEN-RUST-LEVEL7", "ruleset_id": "dnd_5e_2014", "partyMemberIds": ["hero", "ally"],
        "players": [
            { "id": "hero", "characterClass": "fighter", "level": 7, "hp": 30, "maxHp": 30, "armor": 15, "speed": 30, "proficiency": 3, "abilities": { "str": 16, "dex": 14, "con": 14, "int": 10, "wis": 10, "cha": 10 }, "inventory": [], "x": 0, "y": 0 },
            { "id": "ally", "characterClass": "wizard", "level": 7, "hp": 20, "maxHp": 20, "armor": 12, "speed": 30, "proficiency": 3, "abilities": { "str": 8, "dex": 14, "con": 12, "int": 18, "wis": 14, "cha": 10 }, "inventory": [], "x": 1, "y": 0 }
        ],
        "enemies": [], "scene": { "turn": 1, "cells": (0..40).map(|i| json!({ "x": i % 10, "y": i / 10, "type": "floor", "revealed": true })).collect::<Vec<_>>() },
        "mechanics": { "conditions": { "ally": [
            { "id": "magical-sleep", "effect_id": "sleep-1", "spell_id": "sleep", "source_actor": "enemy" },
            { "id": "unconscious", "effect_id": "sleep-1", "spell_id": "sleep", "source_actor": "enemy" },
            { "id": "helped", "source_actor": "other" }
        ] }, "concentration": {}, "resources": {}, "combat": {
            "active": true, "round": 1, "active_index": 0,
            "initiative": [{ "actor_id": "hero", "total": 20 }, { "actor_id": "ally", "total": 10 }],
            "action_economy": { "hero": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 }, "ally": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 } }
        } }
    })
}

#[test]
fn awaken_action_cleanses_sleep_spends_action_and_replays() {
    let initial = awaken_state();
    let command = json!({ "command_type": "UseCombatAction", "command_id": "awaken-rust-1", "actor_id": "hero", "action_id": "awaken", "target_id": "ally", "target_ids": ["ally"], "wake_spell_id": "sleep", "server_authoritative": true });
    let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": ["hero"] }));
    let mut dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high: false }, "awaken"));
    let mut uuid = sequence_uuids("awaken-rust");
    let outcome = api::with_lenient_validation(|| api::resolve_command(&command, &initial, &mut dice, &context, &mut uuid)).expect("awaken");
    let resolved = match outcome { Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved };
    let after = replay_events(&initial, &resolved.events).expect("replay");
    let conditions = after["mechanics"]["conditions"]["ally"].as_array().unwrap();
    assert!(!conditions.iter().any(|condition| ["magical-sleep", "unconscious"].contains(&condition["id"].as_str().unwrap_or_default())));
    assert!(conditions.iter().any(|condition| condition["id"] == "helped"));
    assert_eq!(after["mechanics"]["combat"]["action_economy"]["hero"]["action"], false);
    assert_eq!(resolved.events.iter().find(|event| event["event_type"] == "CombatActionUsed").and_then(|event| event["payload"]["awakened_spell_id"].as_str()), Some("sleep"));
}

#[test]
fn awakening_one_hypnotized_ally_preserves_the_other_and_shared_concentration() {
    let mut initial = awaken_state();
    let mut other = initial["players"][1].clone();
    other["id"] = json!("other");
    other["x"] = json!(0);
    other["y"] = json!(1);
    initial["players"].as_array_mut().unwrap().push(other);
    initial["partyMemberIds"].as_array_mut().unwrap().push(json!("other"));
    let conditions = json!([
        { "id": "charmed", "effect_id": "pattern-1", "spell_id": "hypnotic-pattern", "source_actor": "enemy" },
        { "id": "incapacitated", "effect_id": "pattern-1", "spell_id": "hypnotic-pattern", "source_actor": "enemy" },
        { "id": "speed-zero", "effect_id": "pattern-1", "spell_id": "hypnotic-pattern", "source_actor": "enemy" },
    ]);
    initial["mechanics"]["conditions"]["ally"] = conditions.clone();
    initial["mechanics"]["conditions"]["other"] = conditions;
    initial["mechanics"]["concentration"]["enemy"] = json!({ "effect_id": "pattern-1" });
    let command = json!({ "command_type": "UseCombatAction", "command_id": "awaken-shared-rust", "actor_id": "hero", "action_id": "awaken", "target_id": "ally", "target_ids": ["ally"], "wake_spell_id": "hypnotic-pattern", "server_authoritative": true });
    let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": ["hero"] }));
    let mut dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high: false }, "awaken-shared"));
    let mut uuid = sequence_uuids("awaken-shared-rust");
    let Outcome::Committed(resolved) = api::resolve_command(&command, &initial, &mut dice, &context, &mut uuid).expect("awaken") else { panic!("ожидался результат") };
    assert!(!resolved.events.iter().any(|event| event["event_type"] == "ConcentrationEnded"));
    let after = replay_events(&initial, &resolved.events).expect("replay");
    let conditions = sk_core::game::conditions(&after, "other");
    assert_eq!(conditions.len(), 3);
    assert!(sk_core::game::conditions(&after, "ally").is_empty());
    assert_eq!(after["mechanics"]["concentration"]["enemy"]["effect_id"], "pattern-1");
    assert_eq!(after["mechanics"]["combat"]["action_economy"]["hero"]["action"], false);
}

#[test]
fn guardian_of_faith_caps_final_damage_after_defenses_and_replays_its_own_expiration() {
    for (defense, previous, temporary, applied) in [
        ("resistances", 59, 0, 1),
        ("vulnerabilities", 45, 0, 15),
        ("resistances", 59, 2, 0),
    ] {
        let mut initial = awaken_state();
        initial["enemies"] = json!([{ "id": "enemy", "hp": 100, "maxHp": 100, "armor": 10, "speed": 30, "alive": true, "x": 7, "y": 2 }]);
        initial["mechanics"]["combat"]["initiative"] = json!([{ "actor_id": "enemy", "total": 20 }, { "actor_id": "hero", "total": 10 }]);
        initial["mechanics"]["combat"]["action_economy"]["enemy"] = initial["mechanics"]["combat"]["action_economy"]["hero"].clone();
        initial["mechanics"]["defenses"] = json!({ "enemy": { (defense): ["radiant"] } });
        initial["mechanics"]["temporary_hp"] = json!({ "enemy": temporary });
        let effect = json!({
            "effect_id": "guardian", "spell_id": "guardian-of-faith", "source_actor": "hero",
            "center": { "x": 4, "y": 2 }, "radius_feet": 10, "area_shape": "sphere",
            "trigger_on_enter": true, "once_per_turn": true, "save_ability": "dex", "save_dc": 15,
            "damage_amount": 20, "damage_type": "radiant", "half_on_save": true,
            "damage_limit": 60, "damage_dealt": previous, "expires_round": 4801,
        });
        let mut other = effect.clone();
        other["effect_id"] = json!("other-guardian");
        other["center"] = json!({ "x": 9, "y": 3 });
        other["damage_dealt"] = json!(0);
        initial["mechanics"]["active_effects"] = json!([effect, other]);
        let command = json!({ "command_type": "MoveActor", "command_id": "guardian-limit-rust", "actor_id": "enemy", "to": { "x": 5, "y": 2 }, "server_authoritative": true });
        let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": ["enemy"] }));
        let mut dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high: false }, "guardian-limit"));
        let mut uuid = sequence_uuids("guardian-limit-rust");
        let Outcome::Committed(resolved) = api::resolve_command(&command, &initial, &mut dice, &context, &mut uuid).expect("entry") else { panic!("ожидался результат") };
        let hits: Vec<_> = resolved.events.iter().filter(|event| event["event_type"] == "DamageApplied").collect();
        assert_eq!(hits.len(), 1, "{defense}");
        assert_eq!(hits[0]["payload"]["applied_amount"], applied, "{defense}");
        assert_eq!(hits[0]["payload"]["temporary_hp_absorbed"], if temporary > 0 { 1 } else { 0 });
        assert_eq!(hits[0]["payload"]["area_damage_dealt"], 60 - previous);
        let after = replay_events(&initial, &resolved.events).expect("replay");
        let effects = after["mechanics"]["active_effects"].as_array().unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0]["effect_id"], "other-guardian");
        assert_eq!(after["enemies"][0]["hp"], 100 - applied);
    }
}

#[test]
#[ignore = "требует сгенерированного level7-named fixture"]
fn spirit_guardians_consumes_slot_and_damages_on_next_turn_with_selected_type() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tmp/astohan-spell-review/level7-named.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture")).unwrap();
    let row = fixture["rows"].as_array().unwrap().iter().find(|row| row["name"] == "cleric" && row["spell_id"] == "spirit-guardians" && row["variant"] == "low").unwrap();
    let initial = &row["state"];
    let command = &row["command"];
    assert_eq!(command["spell_option"], "radiant");
    let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": ["caster"] }));
    let mut dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high: false }, "guardians"));
    let mut uuid = sequence_uuids("guardians-rust");
    let cast = api::with_lenient_validation(|| api::resolve_command(command, initial, &mut dice, &context, &mut uuid)).expect("spirit guardians");
    let cast = match cast { Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved };
    assert!(cast.events.iter().any(|event| event["event_type"] == "SpellAreaCreated"));
    assert!(cast.events.iter().any(|event| event["event_type"] == "ResourceSpent" && event["payload"]["resource"] == "spell_slots_3"));
    let after_cast = replay_events(initial, &cast.events).expect("cast replay");
    assert!(!cast.events.iter().any(|event| event["event_type"] == "DamageApplied"));
    let end_turn = json!({ "command_type": "EndTurn", "command_id": "guardians-rust-end", "actor_id": "caster", "server_authoritative": true });
    let mut end_dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high: false }, "guardians-end"));
    let mut end_uuid = sequence_uuids("guardians-end-rust");
    let end = api::with_lenient_validation(|| api::resolve_command(&end_turn, &after_cast, &mut end_dice, &context, &mut end_uuid)).expect("end turn");
    let end = match end { Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved };
    let damage = end.events.iter().find(|event| event["event_type"] == "DamageApplied").expect("aura damage");
    assert_eq!(damage["payload"]["damage_type"], "radiant");
    assert!(end.events.iter().any(|event| event["event_type"] == "SpellAreaTriggered"));
    let mut events = cast.events.clone(); events.extend(end.events);
    replay_events(initial, &events).expect("full guardians replay");
}

#[test]
#[ignore = "требует сгенерированного guardian fixture"]
fn guardian_of_faith_resolves_20_damage_with_sixty_point_cap_and_eight_hour_expiry() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tmp/astohan-spell-review/guardian-rust.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("сначала node tmp/astohan-spell-review/gen-guardian-rust.mjs")).expect("guardian fixture");
    let initial = fixture["state"].clone();
    let mut live = initial.clone();
    let resolve = |command: Value, state: &Value, high: bool| {
        let mut dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high }, "guardian"));
        let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": [command["actor_id"].as_str().unwrap_or_default()] }));
        let mut uuid = sequence_uuids("guardian-rust");
        let outcome = api::with_lenient_validation(|| api::resolve_command(&command, state, &mut dice, &context, &mut uuid)).expect("guardian command");
        match outcome {
            Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved.events,
        }
    };
    let mut events = resolve(fixture["command"].clone(), &live, true);
    live = replay_events(&live, &events).expect("cast replay");
    let effect = live["mechanics"]["active_effects"].as_array().unwrap().iter().find(|effect| effect["spell_id"] == "guardian-of-faith").unwrap();
    assert_eq!(effect["damage_amount"], 20);
    assert_eq!(effect["damage_limit"], 60);
    assert_eq!(effect["expires_round"], 4801);
    let end_caster = json!({ "command_type": "EndTurn", "command_id": "guardian:end-caster", "actor_id": "caster", "server_authoritative": true });
    let added = resolve(end_caster, &live, true);
    live = replay_events(&live, &added).expect("turn replay"); events.extend(added);
    for index in 0..6 {
        if index > 0 {
            let out = json!({ "command_type": "MoveActor", "command_id": format!("guardian:out:{index}"), "actor_id": "enemy", "to": { "x": 7, "y": 2 }, "server_authoritative": true });
            let added = resolve(out, &live, true); live = replay_events(&live, &added).expect("out replay"); events.extend(added);
        }
        let enter = json!({ "command_type": "MoveActor", "command_id": format!("guardian:in:{index}"), "actor_id": "enemy", "to": { "x": 5, "y": 2 }, "server_authoritative": true });
        let added = resolve(enter, &live, true); live = replay_events(&live, &added).expect("entry replay"); events.extend(added);
        if index < 5 {
            for (id, actor) in [("enemy", "enemy"), ("ally", "ally"), ("caster", "caster")] {
                let end = json!({ "command_type": "EndTurn", "command_id": format!("guardian:end:{index}:{id}"), "actor_id": actor, "server_authoritative": true });
                let added = resolve(end, &live, true); live = replay_events(&live, &added).expect("end replay"); events.extend(added);
            }
        }
    }
    assert!(!live["mechanics"]["active_effects"].as_array().unwrap().iter().any(|effect| effect["spell_id"] == "guardian-of-faith"));
    let damage: i64 = events.iter().filter(|event| event["event_type"] == "DamageApplied" && event["payload"]["spell_id"] == "guardian-of-faith").map(|event| event["payload"]["applied_amount"].as_i64().unwrap_or(0)).sum();
    assert_eq!(damage, 60);
    let replayed = replay_events(&initial, &events).expect("full replay");
    assert_eq!(replayed["mechanics"], live["mechanics"]);
}

#[test]
#[ignore = "требует сгенерированного tmp fixture"]
fn ilva_and_mirra_level7_spells_match_js_outcomes_and_replay() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tmp/astohan-spell-review/level7-named.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("нет {path:?}; сначала запустите eval/astohan-level7-spell-rust-fixture.mjs: {error}"))).expect("fixture");
    let rows = fixture["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 72, "Ильва/Мирра: партии activeIds, два края кости и выборы");
    let mut executed = 0usize;
    let mut blocked = 0usize;
    let mut mismatches = Vec::new();
    for row in rows {
        let state = &row["state"];
        let command = &row["command"];
        let high = row["variant"] == json!("high");
        let mut dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high }, "level7"));
        let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": ["caster"] }));
        let mut uuid = sequence_uuids("level7-rust");
        let actual = api::with_lenient_validation(|| api::resolve_command(command, state, &mut dice, &context, &mut uuid));
        let expected = &row["expected"];
        match (&actual, expected["outcome"].as_str()) {
            (Ok(outcome), Some("ok")) => {
                executed += 1;
                let resolved = match outcome { Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved };
                let mut events = resolved.events.clone();
                let mut live = replay_events(state, &events).expect("initial events replay");
                let mut decline_index = 0usize;
                while let Some(reactor) = live["mechanics"]["combat"]["reaction_window"]["actor_id"].as_str() {
                    decline_index += 1;
                    assert!(decline_index < 20, "reaction chain must terminate");
                    let decline = json!({
                        "command_type": "UseCombatAction", "command_id": format!("{}:decline:{}", command["command_id"], decline_index),
                        "actor_id": reactor, "action_id": "decline-reaction", "server_authoritative": true,
                    });
                    let mut decline_dice = ServiceDice::new(DiceService::deterministic(EdgeRng { high }, "level7-decline"));
                    let mut decline_uuid = sequence_uuids("level7-rust-decline");
                    let decline_outcome = api::with_lenient_validation(|| api::resolve_command(&decline, &live, &mut decline_dice, &Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": [reactor] })), &mut decline_uuid)).expect("decline reaction");
                    let decline_resolved = match decline_outcome { Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved };
                    live = replay_events(&live, &decline_resolved.events).expect("decline replay");
                    events.extend(decline_resolved.events);
                }
                let expected_types: Vec<String> = expected["event_types"].as_array().expect("event types").iter().filter_map(Value::as_str).map(str::to_owned).collect();
                if event_types(&events) != expected_types { mismatches.push(format!("{} {} {}: events Rust={:?} JS={:?}", row["name"], row["spell_id"], row["variant"], event_types(&events), expected_types)); }
                let _replayed = replay_events(state, &events).expect("replay");
            }
            (Err(error), Some("error")) => {
                blocked += 1;
                if code(error) != expected["code"] { mismatches.push(format!("{} {} {}: error Rust={} JS={}", row["name"], row["spell_id"], row["variant"], code(error), expected["code"])); }
            }
            (Ok(outcome), Some(expected_outcome)) => mismatches.push(format!("{} {}: Rust исполнен {:?}, JS {expected_outcome}", row["name"], row["spell_id"], outcome)),
            (Err(error), Some(expected_outcome)) => mismatches.push(format!("{} {}: Rust отказ {} вместо JS {expected_outcome}", row["name"], row["spell_id"], code(error))),
            (_, None) => panic!("нет expected outcome {}", row["spell_id"]),
        }
    }
    assert!(executed > 0 && blocked > 0, "должны быть и исполнения, и безопасные отказы");
    assert!(mismatches.is_empty(), "level7 named mismatches {}:\n{}", mismatches.len(), mismatches.join("\n"));
    eprintln!("level7 named CastSpell: executed={executed}, blocked={blocked}, rows={}", rows.len());
}
