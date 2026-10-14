//! Сверка `improvised_effects` с эталоном JS (`fixtures/improvised-effects.json`,
//! генератор — `fixtures/gen-improvised-effects.mjs`) и перенесённые проверки
//! модуля из `test/improvised-effects.test.mjs` и
//! `test/scene-prop-improvisation.test.mjs` (исполнение команд Rules Engine и
//! HTTP-путь импровизации здесь не переносятся).

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{json, Value};
use sk_attention::improvised_effects::*;

const FIXTURE: &str = include_str!("../fixtures/improvised-effects.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

fn text<T: Serialize>(value: T) -> String {
    serde_json::to_string(&value).expect("сериализация")
}

#[test]
fn catalogs_match_js_with_key_order() {
    let constants = &DATA["constants"];
    assert_eq!(text(&*IMPROVISED_EFFECTS), text(&constants["IMPROVISED_EFFECTS"]));
    assert_eq!(text(&*ENVIRONMENT_HAZARDS), text(&constants["ENVIRONMENT_HAZARDS"]));
    assert_eq!(json!(ACTION_COSTS), constants["ACTION_COSTS"]);
    assert_eq!(json!(IMPROVISED_EFFECT_IDS), constants["IMPROVISED_EFFECT_IDS"]);
    assert_eq!(json!(ENVIRONMENT_HAZARD_IDS), constants["ENVIRONMENT_HAZARD_IDS"]);
}

#[test]
fn scene_prop_intents_match_js() {
    for case in DATA["intents"].as_array().expect("глаголы") {
        let effect_id = case["effect_id"].as_str().expect("ключ");
        assert_eq!(json!(scene_prop_intent_for(effect_id)), case["expected"], "глагол для «{effect_id}»");
    }
}

#[test]
fn plans_match_js() {
    let plans = DATA["plans"].as_array().expect("планы");
    let empty = json!({});
    for (index, case) in plans.iter().enumerate() {
        let options = case.get("options").unwrap_or(&empty);
        let actual = plan_improvised_effect(&case["state"], ImprovisedEffectRequest::from_value(options)).to_value();
        assert_eq!(text(&actual), text(&case["expected"]), "план #{index}: {case}");
    }
    assert!(plans.len() > 2000);
}

#[test]
fn action_costs_match_js() {
    for (index, case) in DATA["costs"].as_array().expect("цены").iter().enumerate() {
        let actual = resolve_action_cost(&case["state"], case.get("actor_id"), case.get("requested"));
        assert_eq!(text(&actual), text(&case["expected"]), "цена #{index}: {case}");
    }
}

// ---------------------------------------------------------------------------
// `test/improvised-effects.test.mjs`

/// Поле боя теста: союзник и огр вплотную к герою; позиции — как их
/// записывает нормализация движка.
fn battlefield(economy: Value) -> Value {
    json!({
        "players": [
            { "id": "hero", "hp": 12, "maxHp": 12, "x": 0, "y": 0 },
            { "id": "ally", "hp": 10, "maxHp": 10, "x": 0, "y": 1 },
        ],
        "enemies": [{ "id": "ogre", "hp": 20, "maxHp": 20, "alive": true, "x": 1, "y": 0 }],
        "mechanics": {
            "positions": { "hero": { "x": 0, "y": 0 }, "ally": { "x": 0, "y": 1 }, "ogre": { "x": 1, "y": 0 } },
            "combat": { "active": true, "round": 1, "active_index": 0, "action_economy": { "hero": economy } },
        },
    })
}

fn fresh() -> Value {
    battlefield(json!({ "action": true, "bonus_action": true, "movement": true, "movement_spent": 0 }))
}

fn plan(state: &Value, options: Value) -> ImprovisedPlan {
    plan_improvised_effect(state, ImprovisedEffectRequest::from_value(&options))
}

fn move_ogre(state: &mut Value, x: i64) {
    state["enemies"][0]["x"] = json!(x);
    state["mechanics"]["positions"]["ogre"] = json!({ "x": x, "y": 0 });
}

#[test]
fn unknown_effect_does_nothing() {
    let plan = plan(&fresh(), json!({ "actorId": "hero", "effectId": "instant_kill", "targetId": "ogre" }));
    assert_eq!(plan.effect["id"], json!("none"));
    assert!(plan.commands.is_empty(), "выдуманный агентом эффект не должен породить ни одной команды");
}

#[test]
fn effect_needs_the_right_side_and_a_present_target() {
    let state = fresh();
    let on_ally = plan(&state, json!({ "actorId": "hero", "effectId": "prone", "targetId": "ally" }));
    assert_eq!(on_ally.effect["id"], json!("none"));
    assert!(on_ally.rejected.as_deref().is_some_and(|reason| reason.contains("противник")));
    let help_enemy = plan(&state, json!({ "actorId": "hero", "effectId": "help_ally", "targetId": "ogre" }));
    assert!(help_enemy.rejected.as_deref().is_some_and(|reason| reason.contains("союзник")));
    let ghost = plan(&state, json!({ "actorId": "hero", "effectId": "prone", "targetId": "дракон" }));
    assert!(ghost.rejected.as_deref().is_some_and(|reason| reason.contains("нет на поле")));
}

#[test]
fn allowed_effect_becomes_an_engine_command() {
    let plan = plan(&fresh(), json!({ "actorId": "hero", "effectId": "prone", "targetId": "ogre" }));
    assert_eq!(plan.commands, vec![json!({ "command_type": "AddCondition", "actor_id": "hero", "target_id": "ogre", "condition": "prone", "source": "improvised-action" })]);
    let distract = plan_improvised_effect(&fresh(), ImprovisedEffectRequest::from_value(&json!({ "actorId": "hero", "effectId": "distract", "targetId": "ogre" })));
    assert_eq!(distract.commands[0]["duration"], json!("until-next-turn"));
}

#[test]
fn hazard_damage_dice_come_from_the_server_table() {
    let state = fresh();
    let serious = plan(&state, json!({ "actorId": "hero", "effectId": "hazard_damage", "targetId": "ogre", "hazardId": "fire", "risk": "serious" }));
    assert_eq!(serious.commands[0]["expression"], ENVIRONMENT_HAZARDS["fire"]["expressions"]["serious"]);
    assert_eq!(serious.commands[0]["damage_type"], json!("fire"));
    assert_eq!(serious.summary, "открытый огонь: цель получает урон (2d6).");
    let capped = plan(&state, json!({ "actorId": "hero", "effectId": "hazard_damage", "targetId": "ogre", "hazardId": "fire", "risk": "99d99" }));
    assert_eq!(capped.commands[0]["expression"], ENVIRONMENT_HAZARDS["fire"]["expressions"]["minor"]);
    let unknown = plan(&state, json!({ "actorId": "hero", "effectId": "hazard_damage", "targetId": "ogre", "hazardId": "meteor", "risk": "deadly" }));
    assert_eq!(unknown.effect["id"], json!("none"));
    assert!(unknown.rejected.as_deref().is_some_and(|reason| reason.contains("опасности нет")));
}

#[test]
fn action_cost_follows_the_turn_economy() {
    let peaceful = json!({ "players": [{ "id": "hero" }], "mechanics": { "combat": { "active": false } } });
    assert_eq!(resolve_action_cost(&peaceful, Some(&json!("hero")), Some(&json!("action"))), ActionCost { cost: "free", available: true, slot: None }, "вне боя импровизация ничего не стоит");
    assert!(resolve_action_cost(&fresh(), Some(&json!("hero")), Some(&json!("action"))).available);
    let spent = battlefield(json!({ "action": false, "bonus_action": true, "movement": true, "movement_spent": 0 }));
    assert!(!resolve_action_cost(&spent, Some(&json!("hero")), Some(&json!("action"))).available, "потраченное действие нельзя потратить второй раз");
    assert!(resolve_action_cost(&spent, Some(&json!("hero")), Some(&json!("bonus_action"))).available);
    assert_eq!(resolve_action_cost(&fresh(), Some(&json!("hero")), Some(&json!("movement"))).cost, "action", "перемещение отдельным слотом не списывается");
    let invented = resolve_action_cost(&fresh(), Some(&json!("hero")), Some(&json!("сделать бесплатно")));
    assert_eq!(invented.cost, "action", "неизвестный слот трактуется как самый дорогой");
    assert!(ACTION_COSTS.contains(&invented.cost));
}

#[test]
fn effect_out_of_reach_is_rejected() {
    let mut state = fresh();
    move_ogre(&mut state, 12);
    let prone = plan(&state, json!({ "actorId": "hero", "effectId": "prone", "targetId": "ogre" }));
    assert_eq!(prone.effect["id"], json!("none"));
    assert!(prone.rejected.as_deref().is_some_and(|reason| reason.contains("далеко")));
    assert!(prone.commands.is_empty());
    let hazard = plan(&state, json!({ "actorId": "hero", "effectId": "hazard_damage", "targetId": "ogre", "hazardId": "fire", "risk": "deadly" }));
    assert!(hazard.rejected.as_deref().is_some_and(|reason| reason.contains("далеко")));
    assert!(hazard.commands.is_empty(), "урон через весь коридор не должен породить ни одной команды");
    let adjacent = plan(&fresh(), json!({ "actorId": "hero", "effectId": "prone", "targetId": "ogre" }));
    assert_eq!(adjacent.effect["id"], json!("prone"));
    assert_eq!(adjacent.commands.len(), 1);
}

#[test]
fn shouting_and_blinding_reach_further_than_touch() {
    let mut state = fresh();
    move_ogre(&mut state, 4);
    for effect_id in ["distract", "blind"] {
        let plan = plan(&state, json!({ "actorId": "hero", "effectId": effect_id, "targetId": "ogre" }));
        assert_eq!(plan.effect["id"], json!(effect_id), "{effect_id}: должен доставать на 20 футов");
        assert_eq!(plan.commands.len(), 1);
    }
    for effect_id in ["prone", "restrain", "hazard_damage"] {
        let plan = plan(&state, json!({ "actorId": "hero", "effectId": effect_id, "targetId": "ogre", "hazardId": "fire" }));
        assert_eq!(plan.effect["id"], json!("none"), "{effect_id}: касание не должно доставать на 20 футов");
        assert_eq!(plan.rejected.as_deref(), Some("цель слишком далеко: досягаемость 5 фт"));
    }
    let mut far = fresh();
    move_ogre(&mut far, 8);
    let shout = plan(&far, json!({ "actorId": "hero", "effectId": "distract", "targetId": "ogre" }));
    assert_eq!(shout.rejected.as_deref(), Some("цель слишком далеко: досягаемость 30 фт"), "на 40 футах окрик тоже обязан получить отказ");
}

#[test]
fn scene_prop_effects_never_reach_the_planner() {
    let state = fresh();
    for effect_id in ["topple_prop", "ignite_prop"] {
        let plan = plan(&state, json!({ "actorId": "hero", "effectId": effect_id, "targetId": "ogre" }));
        assert_eq!(plan.effect["id"], json!("none"), "{effect_id}: предмет обстановки целью быть не может");
        assert!(plan.rejected.as_deref().is_some_and(|reason| reason.contains("не подтверждён картой")));
        assert!(plan.commands.is_empty());
    }
    let bare = plan(&state, json!({ "actorId": "hero", "effectId": "ignite_prop" }));
    assert!(bare.rejected.as_deref().is_some_and(|reason| reason.contains("не подтверждён картой")), "сторона проверяется до цели");
}

#[test]
fn catalog_is_closed_and_every_effect_declares_side_and_reach() {
    for (id, effect) in IMPROVISED_EFFECTS.as_object().expect("каталог") {
        assert_eq!(effect["id"], json!(id));
        assert!(["none", "ally", "enemy", "scene_prop"].contains(&effect["target"].as_str().unwrap_or_default()), "{id}: сторона обязана быть объявлена");
        assert!(effect["summary"].as_str().is_some_and(|summary| !summary.is_empty()), "{id}: нужен текст для игрока");
        if effect["target"] != json!("none") {
            assert!(effect["range_feet"].as_i64().is_some_and(|range| range > 0), "{id}: досягаемость обязана быть объявлена");
        }
    }
    let keys: Vec<&String> = IMPROVISED_EFFECTS.as_object().expect("каталог").keys().collect();
    assert_eq!(keys, IMPROVISED_EFFECT_IDS);
    let hazards: Vec<&String> = ENVIRONMENT_HAZARDS.as_object().expect("каталог").keys().collect();
    assert_eq!(hazards, ENVIRONMENT_HAZARD_IDS);
}

/// `test/scene-prop-improvisation.test.mjs`: «каталог знает ровно два глагола
/// обстановки и ничего сверх».
#[test]
fn catalog_knows_exactly_two_scene_verbs() {
    assert_eq!(scene_prop_intent_for("topple_prop").as_deref(), Some("topple"));
    assert_eq!(scene_prop_intent_for("ignite_prop").as_deref(), Some("ignite"));
    for effect_id in ["none", "prone", "hazard_damage", "burn_everything", ""] {
        assert_eq!(scene_prop_intent_for(effect_id), None, "{effect_id}: маршрута в OperateSceneObject быть не должно");
    }
}
