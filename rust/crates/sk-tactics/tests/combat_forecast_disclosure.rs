//! Смысловые проверки `test/combat-forecast-disclosure.test.mjs`: закрытая КД
//! не выдаётся процентом попадания (U01, PR #136).
//!
//! Проекции зрителя (`campaignStateForViewer`) в Rust ещё нет (`sk-projection`),
//! поэтому карточка врага задаётся тем, что она решает для прогноза: поле
//! `armor` есть, только когда КД открыта зрителю. Состояние, нормализация и
//! паралич — настоящие (`sk_rules`).

use serde_json::{json, Value};
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::replay::apply_game_event;
use sk_tactics::combat_forecast_view::with_combat_forecast;

fn fixture(armor: i64) -> Value {
    normalize_campaign_state(&json!({
        "partyMemberIds": ["hero", "ally"],
        "players": [
            { "id": "hero", "character": "Герой", "hp": 12, "maxHp": 12, "armor": 14, "proficiency": 2,
              "abilities": { "str": 16, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 8 }, "x": 0, "y": 0,
              "inventory": [{ "id": "sword", "name": "Длинный меч", "type": "weapon", "quantity": 1, "equipped": true,
                "combat": { "kind": "melee", "ability": "str", "damage": "1d8", "damageType": "slashing", "normalRange": 5 } }] },
            { "id": "ally", "character": "Союзник", "hp": 12, "maxHp": 12, "armor": 14, "proficiency": 2,
              "abilities": { "str": 10, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 8 }, "x": 0, "y": 1, "inventory": [] },
        ],
        "enemies": [{ "id": "goblin", "name": "Гоблин", "hp": 10, "maxHp": 10, "armor": armor, "alive": true, "x": 1, "y": 0 }],
        "scene": { "turn": 1, "cells": [
            { "x": 0, "y": 0, "type": "floor", "revealed": true },
            { "x": 1, "y": 0, "type": "floor", "revealed": true },
            { "x": 0, "y": 1, "type": "floor", "revealed": true },
        ] },
        "mechanics": { "combat": { "active": true, "round": 1, "active_index": 0,
            "initiative": [{ "actor_id": "hero" }, { "actor_id": "goblin" }], "action_economy": { "hero": { "action": true } } } },
    }))
    .expect("нормализация")
}

fn paralyze(state: &Value) -> Value {
    apply_game_event(state, &json!({ "event_id": "condition:goblin:paralyzed", "event_type": "ConditionAdded", "actor_id": "ally",
        "target_ids": ["goblin"], "payload": { "condition": "paralyzed", "source_actor": "ally" } }))
    .expect("паралич")
}

/// Проекция зрителя: отряд и карточка врага, КД — только если открыта.
fn projected(armor: Option<i64>) -> Value {
    let enemy = match armor {
        Some(armor) => json!({ "id": "goblin", "armor": armor }),
        None => json!({ "id": "goblin" }),
    };
    json!({ "players": [{ "id": "hero" }, { "id": "ally" }], "enemies": [enemy] })
}

fn view(state: &Value, armor: Option<i64>, actor: &str) -> Value {
    with_combat_forecast(Some(&projected(armor)), Some(state), Some(&json!(actor))).expect("прогноз").expect("проекция")
}

fn sword(view: &Value) -> Value {
    view["combatForecast"]["targets"]["goblin"].as_array().into_iter().flatten().find(|entry| entry["item_id"] == "sword").cloned().expect("удар мечом")
}

#[test]
fn hidden_armor_makes_the_forecast_independent_of_it() {
    let (low, high) = (fixture(13), fixture(18));
    for actor in ["hero", "ally"] {
        assert_eq!(view(&low, None, actor), view(&high, None, actor), "зритель {actor}");
    }
    let shot = sword(&view(&high, None, "hero"));
    assert_eq!(shot["armor_class"], Value::Null);
    assert_eq!(shot["hit_chance"], Value::Null);
    assert_eq!(shot["armor_known"], false);
    // Натуральная 20 попадает при любой КД — этот шанс ничего не выдаёт.
    assert_eq!(shot["critical_chance"], 5);
    assert_eq!((shot["in_range"].clone(), shot["distance_feet"].clone(), shot["attack_modifier"].clone(), shot["average_damage"].clone()), (json!(true), json!(5), json!(5), json!(8)));
}

#[test]
fn known_armor_opens_class_and_hit_chance_to_hero_and_ally() {
    for actor in ["hero", "ally"] {
        let low = sword(&view(&fixture(13), Some(13), actor));
        assert_eq!((low["armor_class"].clone(), low["hit_chance"].clone(), low["armor_known"].clone()), (json!(13), json!(65), json!(true)));
        let high = sword(&view(&fixture(18), Some(18), actor));
        assert_eq!((high["armor_class"].clone(), high["hit_chance"].clone()), (json!(18), json!(40)));
    }
}

#[test]
fn guaranteed_point_blank_critical_hides_critical_chance_with_hidden_armor() {
    let (low, high) = (paralyze(&fixture(13)), paralyze(&fixture(18)));
    assert_eq!(view(&low, None, "hero"), view(&high, None, "hero"));
    let shot = sword(&view(&high, None, "hero"));
    assert_eq!(shot["critical_on_hit"], true);
    assert_eq!(shot["hit_chance"], Value::Null);
    assert_eq!(shot["critical_chance"], Value::Null);
    assert_eq!(shot["advantage"], true, "преимущество по парализованному — видимый факт");
    let open = sword(&view(&high, Some(18), "hero"));
    assert_eq!(open["critical_on_hit"], true);
    assert_eq!(open["critical_chance"], open["hit_chance"]);
    assert!(open["hit_chance"].as_f64().unwrap_or(0.0) > 40.0, "с преимуществом шанс выше, чем без него");
}

#[test]
fn no_forecast_outside_combat_or_on_someone_elses_turn() {
    let mut idle = fixture(13);
    idle["mechanics"]["combat"]["active"] = json!(false);
    assert!(view(&idle, None, "hero").get("combatForecast").is_none());
    let mut goblin_turn = fixture(13);
    goblin_turn["mechanics"]["combat"]["active_index"] = json!(1);
    assert!(view(&goblin_turn, None, "hero").get("combatForecast").is_none());
    // Чужой игрок, которого нет в отряде проекции, хода не планирует.
    let stranger = with_combat_forecast(Some(&json!({ "players": [], "enemies": [{ "id": "goblin" }] })), Some(&fixture(13)), Some(&json!("stranger"))).expect("прогноз").expect("проекция");
    assert!(stranger.get("combatForecast").is_none());
}

#[test]
fn game_master_sees_full_stat_block_so_armor_and_hit_chance() {
    let state = fixture(18);
    let gm = with_combat_forecast(Some(&json!({ "players": [{ "id": "hero" }], "enemies": [{ "id": "goblin", "armor": 18 }] })), Some(&state), Some(&json!(""))).expect("прогноз").expect("проекция");
    let shot = sword(&gm);
    assert_eq!((shot["armor_class"].clone(), shot["hit_chance"].clone(), shot["armor_known"].clone()), (json!(18), json!(40), json!(true)));
}
