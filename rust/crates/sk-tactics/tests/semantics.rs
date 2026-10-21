//! Смысловые проверки тестов JS, перенесённые на Rust-состояния:
//! `test/party-tactics.test.mjs`, `test/party-tactics-stabilize.test.mjs`,
//! `test/free-action.test.mjs` (таблица сложности), `test/rest-mechanics.test.mjs`
//! и правила ожидания (`adjudicator.mjs`). Паритет тех же тестов на их
//! собственных состояниях — в `tests/t2.rs` (записи вызовов).

use serde_json::{json, Value};
use sk_rules::normalize::normalize_campaign_state;
use sk_tactics::adjudicator::{create_plan, difficulty_category_for, difficulty_class_for};
use sk_tactics::party_tactics::{healing_target_for, plan_hero_combat_command, plan_hero_reaction, plan_hero_turn, HEAL_THRESHOLD_RATIO};

fn potion() -> Value {
    json!({ "id": "item-potion", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Зелье лечения", "quantity": 1, "type": "consumable" })
}

fn sword() -> Value {
    json!({ "id": "item-sword", "catalog_id": "srd_5_2_1:longsword", "name": "Длинный меч", "quantity": 1, "type": "weapon", "equipped": true,
        "combat": { "kind": "melee", "ability": "str", "damage": "1d8", "damageType": "slashing", "normalRange": 5 } })
}

fn floor(size: i64) -> Value {
    let mut cells = Vec::new();
    for y in 0..size {
        for x in 0..size {
            cells.push(json!({ "x": x, "y": y, "type": "floor", "revealed": true }));
        }
    }
    Value::Array(cells)
}

fn hero(id: &str, overrides: Value) -> Value {
    let base = json!({ "id": id, "character": id, "hp": 12, "maxHp": 12, "speed": 30,
        "abilities": { "str": 14, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 10 }, "inventory": [sword()] });
    sk_core::js::spread(&base, overrides)
}

fn enemy(id: &str, overrides: Value) -> Value {
    let base = json!({ "id": id, "name": id, "hp": 10, "maxHp": 10, "armor": 12, "speed": 30, "attackBonus": 3, "damageDice": 6, "damageBonus": 1,
        "action_profiles": [{ "id": "claw", "name": "Коготь", "kind": "melee", "attack_modifier": 3, "damage_expression": "1d6+1", "damage_type": "slashing", "range_feet": 5 }] });
    sk_core::js::spread(&base, overrides)
}

/// `battle({ heroes, enemies, positions })` из `test/party-tactics.test.mjs`.
fn battle(heroes: Vec<Value>, enemies: Vec<Value>, positions: Value) -> Value {
    let ids: Vec<Value> = heroes.iter().map(|hero| hero["id"].clone()).collect();
    normalize_campaign_state(&json!({
        "sessionCode": "TACTICS",
        "partyMemberIds": ids,
        "activePlayerId": heroes.first().map(|hero| hero["id"].clone()),
        "scene": { "title": "Схватка", "location": "Ворота", "cells": floor(12) },
        "players": heroes,
        "enemies": enemies,
        "mechanics": { "positions": positions, "combat": { "active": true, "round": 1, "initiative": [], "active_index": 0 } },
    }))
    .expect("состояние боя")
}

fn command_types(commands: &[Value]) -> Vec<String> {
    commands.iter().map(|command| command["command_type"].as_str().unwrap_or("").to_string()).collect()
}

#[test]
fn downed_ally_is_healed_before_another_strike() {
    let state = battle(
        vec![hero("medic", json!({ "inventory": [sword(), potion()] })), hero("fallen", json!({ "hp": 0 }))],
        vec![enemy("wolf", json!({ "hp": 1 }))],
        json!({ "medic": { "x": 1, "y": 1 }, "fallen": { "x": 2, "y": 1 }, "wolf": { "x": 1, "y": 2 } }),
    );
    let plan = plan_hero_turn(&state, "medic").expect("план");
    assert_eq!(plan.rule, "heal-ally");
    let used = plan.commands.iter().find(|command| command["command_type"] == "UseItem").expect("зелье обязано быть применено");
    assert_eq!(used["target_id"], "fallen");
    assert_eq!(used["item_id"], "item-potion");
    assert_eq!(plan.commands.last().expect("конец")["command_type"], "EndTurn");
}

#[test]
fn without_potion_the_hero_fights() {
    let state = battle(
        vec![hero("medic", json!({})), hero("fallen", json!({ "hp": 0 }))],
        vec![enemy("wolf", json!({}))],
        json!({ "medic": { "x": 1, "y": 1 }, "fallen": { "x": 2, "y": 1 }, "wolf": { "x": 1, "y": 2 } }),
    );
    let plan = plan_hero_turn(&state, "medic").expect("план");
    assert!(!plan.commands.iter().any(|command| command["command_type"] == "UseItem"));
    assert_eq!(plan.rule, "attack-adjacent");
}

#[test]
fn adjacent_enemy_is_struck_first_with_the_equipped_weapon() {
    let state = battle(
        vec![hero("fighter", json!({}))],
        vec![enemy("adjacent-orc", json!({ "hp": 9 })), enemy("far-wounded", json!({ "hp": 1 }))],
        json!({ "fighter": { "x": 1, "y": 1 }, "adjacent-orc": { "x": 1, "y": 2 }, "far-wounded": { "x": 9, "y": 9 } }),
    );
    let plan = plan_hero_turn(&state, "fighter").expect("план");
    assert_eq!(plan.rule, "attack-adjacent");
    assert!(!plan.commands.iter().any(|command| command["command_type"] == "MoveActor"));
    let attack = plan.commands.iter().find(|command| command["command_type"] == "MakeAttack").expect("удар");
    assert_eq!(attack["target_id"], "adjacent-orc");
    assert_eq!(attack["item_id"], "item-sword");
}

#[test]
fn prone_hero_stands_up_before_attacking_and_pays_half_speed() {
    let mut state = battle(vec![hero("fighter", json!({}))], vec![enemy("adjacent-wolf", json!({}))], json!({ "fighter": { "x": 1, "y": 1 }, "adjacent-wolf": { "x": 1, "y": 2 } }));
    state["mechanics"]["conditions"]["fighter"] = json!([{ "id": "prone", "source_actor": "adjacent-wolf" }]);
    let plan = plan_hero_turn(&state, "fighter").expect("план");
    assert_eq!(command_types(&plan.commands), ["UseCombatAction", "MakeAttack", "EndTurn"]);
    assert_eq!(plan.commands[0]["action_id"], "stand-up");

    let mut distant = battle(vec![hero("fighter", json!({}))], vec![enemy("distant-wolf", json!({}))], json!({ "fighter": { "x": 1, "y": 1 }, "distant-wolf": { "x": 6, "y": 1 } }));
    distant["mechanics"]["conditions"]["fighter"] = json!([{ "id": "prone", "source_actor": "distant-wolf" }]);
    let advance = plan_hero_turn(&distant, "fighter").expect("план");
    let movement = advance.commands.iter().find(|command| command["command_type"] == "MoveActor").expect("шаг");
    assert_eq!(movement["to"], json!({ "x": 4, "y": 1 }), "после подъёма остаётся только 15 футов движения");
    assert!(!advance.commands.iter().any(|command| command["command_type"] == "MakeAttack"));
}

#[test]
fn focus_fire_on_the_most_wounded_when_nobody_is_adjacent() {
    let state = battle(
        vec![hero("fighter", json!({}))],
        vec![enemy("healthy", json!({ "hp": 10 })), enemy("wounded", json!({ "hp": 2 }))],
        json!({ "fighter": { "x": 1, "y": 1 }, "healthy": { "x": 5, "y": 1 }, "wounded": { "x": 4, "y": 1 } }),
    );
    let plan = plan_hero_turn(&state, "fighter").expect("план");
    assert!(plan.commands.iter().any(|command| command["command_type"] == "MoveActor"), "до цели надо дойти");
    let attack = plan.commands.iter().find(|command| command["command_type"] == "MakeAttack").expect("удар");
    assert_eq!(attack["target_id"], "wounded");
}

#[test]
fn lonely_wounded_hero_heals_self_and_healthy_party_keeps_potion() {
    let state = battle(vec![hero("lonely", json!({ "hp": 3, "inventory": [sword(), potion()] }))], vec![enemy("wolf", json!({}))], json!({ "lonely": { "x": 1, "y": 1 }, "wolf": { "x": 8, "y": 8 } }));
    let plan = plan_hero_turn(&state, "lonely").expect("план");
    assert_eq!(plan.rule, "heal-self");
    assert_eq!(plan.commands.iter().find(|command| command["command_type"] == "UseItem").expect("зелье")["target_id"], "lonely");

    let healthy = battle(
        vec![hero("fighter", json!({ "inventory": [sword(), potion()] })), hero("ally", json!({ "hp": 12 }))],
        vec![enemy("wolf", json!({}))],
        json!({ "fighter": { "x": 1, "y": 1 }, "ally": { "x": 2, "y": 1 }, "wolf": { "x": 1, "y": 2 } }),
    );
    let plan = plan_hero_turn(&healthy, "fighter").expect("план");
    assert!(!plan.commands.iter().any(|command| command["command_type"] == "UseItem"));
    assert_eq!(plan.rule, "attack-adjacent");
}

#[test]
fn healing_threshold_is_a_share_of_maximum_and_the_dead_are_skipped() {
    assert!(HEAL_THRESHOLD_RATIO > 0.0 && HEAL_THRESHOLD_RATIO < 1.0);
    let state = battle(
        vec![hero("tank", json!({ "hp": 30, "maxHp": 100 })), hero("scout", json!({ "hp": 5, "maxHp": 8 }))],
        vec![enemy("wolf", json!({}))],
        json!({ "tank": { "x": 1, "y": 1 }, "scout": { "x": 2, "y": 1 }, "wolf": { "x": 8, "y": 8 } }),
    );
    assert_eq!(healing_target_for(&state, "tank").expect("цель").expect("раненый")["id"], "tank");

    let mut lost = battle(
        vec![hero("medic", json!({ "inventory": [sword(), potion()] })), hero("lost", json!({ "hp": 0 }))],
        vec![enemy("wolf", json!({}))],
        json!({ "medic": { "x": 1, "y": 1 }, "lost": { "x": 2, "y": 1 }, "wolf": { "x": 8, "y": 8 } }),
    );
    lost["mechanics"]["death"] = json!({ "campaign_status": "active", "heroes": { "lost": { "status": "dead" } } });
    assert_eq!(healing_target_for(&lost, "medic").expect("цель"), None);
}

#[test]
fn plans_are_deterministic_and_always_end_the_turn() {
    let make = || {
        battle(
            vec![hero("a", json!({ "inventory": [sword(), potion()] })), hero("b", json!({ "hp": 2 }))],
            vec![enemy("x", json!({ "hp": 4 })), enemy("y", json!({ "hp": 4 }))],
            json!({ "a": { "x": 1, "y": 1 }, "b": { "x": 4, "y": 4 }, "x": { "x": 6, "y": 1 }, "y": { "x": 7, "y": 1 } }),
        )
    };
    assert_eq!(plan_hero_turn(&make(), "a").expect("план"), plan_hero_turn(&make(), "a").expect("план"));
    for state in [
        battle(vec![hero("h", json!({}))], vec![], json!({ "h": { "x": 1, "y": 1 } })),
        battle(vec![hero("h", json!({}))], vec![enemy("e", json!({}))], json!({ "h": { "x": 1, "y": 1 }, "e": { "x": 20, "y": 20 } })),
        battle(vec![hero("h", json!({ "inventory": [] }))], vec![enemy("e", json!({}))], json!({ "h": { "x": 1, "y": 1 }, "e": { "x": 1, "y": 2 } })),
    ] {
        assert_eq!(plan_hero_turn(&state, "h").expect("план").commands.last().expect("конец")["command_type"], "EndTurn");
    }
}

#[test]
fn reaction_policy_declines_without_a_window_and_keeps_the_uncanny_dodge_threshold() {
    let state = battle(vec![hero("rogue", json!({ "hp": 40, "maxHp": 40 }))], vec![enemy("goblin", json!({}))], json!({ "rogue": { "x": 1, "y": 1 }, "goblin": { "x": 2, "y": 1 } }));
    let none = plan_hero_reaction(&state, None);
    assert_eq!(none.rule, "decline-reaction");
    assert_eq!(none.commands, vec![json!({ "command_type": "UseCombatAction", "actor_id": "", "action_id": "decline-reaction", "server_authoritative": true })]);
    let window = |damage: Value, trigger: &str| json!({ "actor_id": "rogue", "source_actor_id": "goblin", "trigger": trigger, "action_ids": ["uncanny-dodge"], "damage": damage });
    assert_eq!(plan_hero_reaction(&state, Some(&window(json!({ "applied_amount": 4, "temporary_hp_absorbed": 0 }), "attack-hit"))).rule, "decline-reaction");
    assert_eq!(plan_hero_reaction(&state, Some(&window(json!({ "applied_amount": 12, "temporary_hp_absorbed": 0 }), "attack-hit"))).rule, "uncanny-dodge");
    // Окно до урона (`attack-protective-choice`): уклонение выбирается сразу.
    let pending = plan_hero_reaction(&state, Some(&window(json!({ "damage_type": "slashing" }), "attack-protective-choice")));
    assert_eq!(pending.rule, "uncanny-dodge");
    assert_eq!(pending.commands[0]["target_id"], "goblin");
    // Пустой список действий — честный отказ от имени героя окна.
    let empty = json!({ "actor_id": "rogue", "source_actor_id": "goblin", "action_ids": [] });
    let declined = plan_hero_reaction(&state, Some(&empty));
    assert_eq!(declined.rule, "decline-reaction");
    assert_eq!(declined.commands[0]["actor_id"], "rogue");
}

/// `test/party-tactics-stabilize.test.mjs`.
fn stabilize_battle(death: Value) -> Value {
    let cells: Vec<Value> = (0..60).map(|i| json!({ "x": i % 10, "y": i / 10, "type": "floor", "revealed": true })).collect();
    let fighter = |id: &str, name: &str, hp: i64, x: i64| {
        json!({ "id": id, "character": name, "characterClass": "fighter", "level": 7, "hp": hp, "maxHp": 40, "armor": 16, "speed": 30, "proficiency": 3,
            "abilities": { "str": 16, "dex": 10, "con": 14, "int": 10, "wis": 12, "cha": 10 }, "inventory": [], "x": x, "y": 1 })
    };
    normalize_campaign_state(&json!({
        "sessionCode": "STABILIZE", "ruleset_id": "dnd_5e_2014", "ruleset_version": "2014.1.0", "partyMemberIds": ["medic", "fallen"],
        "players": [fighter("medic", "Брат", 40, 1), fighter("fallen", "Сестра", 0, 2)],
        "enemies": [{ "id": "wolf", "name": "Волк", "hp": 11, "maxHp": 11, "armor": 13, "speed": 40, "abilities": { "str": 12, "dex": 15, "con": 12 }, "x": 8, "y": 5, "alive": true }],
        "scene": { "title": "Поляна", "location": "Поляна", "turn": 1, "cells": cells },
        "mechanics": {
            "combat": { "active": true, "round": 2, "active_index": 0, "initiative": [{ "actor_id": "medic", "total": 15 }, { "actor_id": "fallen", "total": 12 }, { "actor_id": "wolf", "total": 5 }],
                "action_economy": { "medic": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 } } },
            "death": death,
        },
    }))
    .expect("состояние")
}

#[test]
fn only_a_dying_ally_is_stabilized() {
    let dying = plan_hero_combat_command(&stabilize_battle(json!({ "saving_throws": { "fallen": { "successes": 0, "failures": 1 } } })), "medic").expect("шаг");
    assert_eq!(dying.command["action_id"], "stabilize", "{}", dying.command);
    for death in [json!({ "saving_throws": { "fallen": { "successes": 0, "failures": 0, "stable": true } } }), json!({ "heroes": { "fallen": { "status": "dead" } } })] {
        let step = plan_hero_combat_command(&stabilize_battle(death.clone()), "medic").expect("шаг");
        assert_ne!(step.command["action_id"], "stabilize", "{death}");
    }
}

fn calm_state() -> Value {
    normalize_campaign_state(&json!({
        "sessionCode": "PLAN", "players": [hero("hero", json!({ "x": 1, "y": 1 }))], "enemies": [], "scene": { "title": "Зал", "location": "Зал", "cells": floor(6) },
        "mechanics": { "world_time": { "elapsed_minutes": 0 } },
    }))
    .expect("состояние")
}

#[test]
fn difficulty_table_uses_only_server_values() {
    let state = calm_state();
    let make = |intent: Value| create_plan(Some(&intent), &state, Some(&json!({ "results": [], "confidence": 1 }))).expect("план");
    let difficulty = |intent: Value| make(intent)["proposed_commands"][0]["difficulty"].clone();
    assert_eq!(difficulty(json!({ "actor_id": "hero", "intent": "ability_check", "approach": "strength", "difficulty_category": "easy", "raw_message": "проверяю дверь" })), 10);
    assert_eq!(difficulty(json!({ "actor_id": "hero", "intent": "ability_check", "approach": "strength", "difficulty_category": "hard", "raw_message": "проверяю дверь" })), 20);
    assert_eq!(difficulty(json!({ "actor_id": "hero", "intent": "ability_check", "approach": "strength", "difficulty_category": "999", "raw_message": "проверяю дверь" })), 15);
    assert_eq!(difficulty(json!({ "actor_id": "hero", "intent": "saving_throw", "approach": "constitution", "raw_message": "спасбросок от ловушки" })), 15);
    assert_eq!(difficulty_class_for("unknown"), 15);
    assert_eq!(difficulty_category_for(Some(&json!({ "raw_message": "тону в бурной реке" })), &state), "hard");
}

#[test]
fn rest_and_wait_plans_advance_time_without_combat() {
    let state = calm_state();
    let plan = |message: &str, intent: &str| create_plan(Some(&json!({ "actor_id": "hero", "intent": intent, "raw_message": message })), &state, None).expect("план");
    let long = plan("долгий отдых у костра", "rest");
    assert_eq!(command_types(long["proposed_commands"].as_array().expect("команды")), ["StartRest", "AdvanceTime", "CompleteRest"]);
    assert_eq!(long["proposed_commands"][1]["amount"], 480);
    assert_eq!(plan("короткий привал", "rest")["proposed_commands"][1]["amount"], 60);
    // Кампания начинается вечером: до полуночи ждать, «до вечера» — уже вечер.
    let midnight = plan("ждём до полуночи", "wait");
    assert!(midnight["wait"]["minutes"].as_i64().expect("минуты") > 30);
    assert_eq!(midnight["proposed_commands"][0]["command_type"], "AdvanceTime");
    let unknown = plan("ждём", "wait");
    assert_eq!(unknown["clarification_required"], true);
    let mut fighting = state.clone();
    fighting["mechanics"]["combat"] = json!({ "active": true });
    let refused = create_plan(Some(&json!({ "actor_id": "hero", "intent": "wait", "raw_message": "ждём до полуночи" })), &fighting, None).expect("план");
    assert_eq!(refused["clarification_message"], "Посреди боя ждать некогда. Попытка ничего не расходует.");
}

#[test]
fn unknown_intent_becomes_an_owner_ruling_without_world_change() {
    let state = calm_state();
    let plan = create_plan(Some(&json!({ "actor_id": "hero", "intent": "dance", "raw_message": "танцую", "confidence": 0.9 })), &state, Some(&json!({ "results": [], "confidence": 0.3 }))).expect("план");
    assert_eq!(plan["ruling_required"], true);
    assert_eq!(plan["ruling_draft"]["world_change"], false);
    assert_eq!(plan["ruling_draft"]["rationale"], "Низкая уверенность поиска правил.");
    assert_eq!(plan["confidence"], 0.3);
    assert_eq!(plan["narration_constraints"].as_array().expect("ограничения").last().expect("последнее"), "no-unconfirmed-world-changes");
}

/// Отклонение от JS (отчёт Т2, «Замечено в JS»): в JS подход `toString`
/// находит метод прототипа у словаря способностей, и в команду попадает
/// функция вместо способности. Здесь ключ прототипа — неизвестный подход.
#[test]
fn prototype_keys_are_unknown_approaches() {
    let state = calm_state();
    let plan = create_plan(Some(&json!({ "actor_id": "hero", "intent": "ability_check", "approach": "toString", "raw_message": "осматриваюсь" })), &state, None).expect("план");
    let command = &plan["proposed_commands"][0];
    assert_eq!(command["ability"], "wis");
    assert!(command.get("skill").is_none());
    assert_eq!(plan["roll_requests"][0]["purpose"], "ability_check:wis");
}
