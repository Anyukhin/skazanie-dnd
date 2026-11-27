//! Интеграционный Rust-путь для распределения залпа «Волшебной стрелы».

use serde_json::{json, Value};
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::outcome::Outcome;
use sk_rules::replay::replay_events;
use sk_rules::resolve::api;

struct SequenceD4 { values: Vec<i64>, next: usize }

impl Rng for SequenceD4 {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        let value = *self.values.get(self.next).unwrap_or(&maximum);
        self.next += 1;
        Ok(value.clamp(minimum, maximum))
    }
}

fn state() -> Value {
    let cells: Vec<Value> = (0..48).map(|index| json!({
        "x": index % 8, "y": index / 8, "type": "floor", "revealed": true,
    })).collect();
    normalize_campaign_state(&json!({
        "sessionCode": "RUST-MAGIC-MISSILE-DISTRIBUTION",
        "ruleset_id": "dnd_5e_2014",
        "enabled_house_rules": ["skazanie:2014-preview-legacy-catalogs-v1"],
        "partyMemberIds": ["caster", "ally"],
        "players": [
            { "id": "caster", "character": "Заклинатель", "characterClass": "wizard", "level": 7,
              "hp": 30, "maxHp": 30, "armor": 12, "speed": 30, "proficiency": 3,
              "abilities": { "int": 18, "dex": 14, "con": 14, "wis": 10, "str": 8, "cha": 10 },
              "knownSpellIds": ["magic-missile"], "preparedSpellIds": ["magic-missile"], "inventory": [], "x": 1, "y": 1 },
            { "id": "ally", "character": "Союзник", "characterClass": "fighter", "level": 7,
              "hp": 30, "maxHp": 30, "armor": 12, "speed": 30, "proficiency": 3,
              "abilities": { "int": 10, "dex": 14, "con": 14, "wis": 10, "str": 16, "cha": 10 },
              "inventory": [], "x": 1, "y": 2 }
        ],
        "enemies": [
            { "id": "weak", "name": "Первый враг", "hp": 30, "maxHp": 30, "armor": 12, "speed": 30, "alive": true,
              "abilities": { "str": 10, "dex": 10, "con": 10, "wis": 10, "int": 10, "cha": 8 }, "x": 3, "y": 1 },
            { "id": "strong", "name": "Второй враг", "hp": 30, "maxHp": 30, "armor": 12, "speed": 30, "alive": true,
              "abilities": { "str": 10, "dex": 10, "con": 10, "wis": 10, "int": 10, "cha": 8 }, "x": 4, "y": 1 }
        ],
        "scene": { "turn": 1, "cells": cells },
        "mechanics": {
            "resources": { "caster": { "spell_slots_1": { "current": 1, "max": 2 }, "spell_slots_2": { "current": 1, "max": 1 } } },
            "combat": { "active": true, "round": 1, "initiative": [
                { "actor_id": "caster", "total": 20 }, { "actor_id": "weak", "total": 10 },
                { "actor_id": "strong", "total": 9 }, { "actor_id": "ally", "total": 5 }
            ], "active_index": 0,
            "action_economy": {
                "caster": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                "weak": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                "strong": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                "ally": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 }
            }
        }
    }})).expect("state normalizes")
}

#[test]
fn missile_distribution_uses_one_roll_for_the_exact_number_of_darts_and_replays() {
    for (label, slot, missile_targets, expected) in [
        ("without-allocation", 1, None, [2, 1]),
        ("null-allocation", 1, Some(Value::Null), [2, 1]),
        ("3-plus-1", 2, Some(json!(["weak", "weak", "weak", "strong"])), [3, 1]),
        ("1-plus-3", 2, Some(json!(["weak", "strong", "strong", "strong"])), [1, 3]),
        ("0-plus-3", 1, Some(json!(["strong", "strong", "strong"])), [0, 3]),
        ("3-plus-0", 1, Some(json!(["weak", "weak", "weak"])), [3, 0]),
    ] {
        let initial = state();
        let mut command = json!({
            "command_type": "CastSpell", "command_id": format!("rust-mm-{label}"), "actor_id": "caster",
            "spell_id": "magic-missile", "target_id": "weak", "target_ids": ["weak", "strong"],
            "slot_level": slot, "server_authoritative": true
        });
        if let Some(targets) = missile_targets { command["missile_target_ids"] = targets; }
        let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": ["caster"] }));
        let mut dice = ServiceDice::new(DiceService::deterministic(SequenceD4 { values: vec![4, 1], next: 0 }, "rust-mm"));
        let mut uuids = sequence_uuids("rust-mm");
        let resolved = api::resolve_command(&command, &initial, &mut dice, &context, &mut uuids).expect("cast resolves");
        let resolved = match resolved { Outcome::Committed(value) | Outcome::Pending { resolved: value, .. } => value };
        let rolls: Vec<_> = resolved.events.iter().filter(|event| event["payload"]["purpose"] == "spell_damage:magic-missile").collect();
        assert_eq!(rolls.len(), 1, "{label}");
        assert_eq!(rolls[0]["payload"]["projectile_count"], slot + 2, "{label}");
        let after = replay_events(&initial, &resolved.events).expect("replay resolves");
        for (target, count) in ["weak", "strong"].into_iter().zip(expected) {
            let hit = resolved.events.iter().find(|event| event["event_type"] == "DamageApplied" && event["target_ids"][0] == target);
            if count == 0 {
                assert!(hit.is_none(), "{label}: {target}");
            } else {
                let hit = hit.unwrap_or_else(|| panic!("{label}: {target}"));
                assert_eq!(hit["payload"]["projectile_count"], count, "{label}: {target}");
                assert_eq!(hit["payload"]["applied_amount"], count * 5, "{label}: {target}");
                assert_eq!(hit["payload"]["damage_per_projectile"], 5, "одна кость используется всем залпом");
            }
            assert_eq!(after["enemies"].as_array().unwrap().iter().find(|enemy| enemy["id"] == target).unwrap()["hp"], 30 - count * 5, "{label}: {target}");
        }
    }
}
