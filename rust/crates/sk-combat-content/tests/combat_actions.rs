//! Сверка `combat_actions` с эталоном JS (`fixtures/combat-actions.json`,
//! генератор `fixtures/gen-combat-actions.mjs`) и перенос проверок
//! `test/combat-actions.test.mjs`, `test/class-resources-2024.test.mjs`,
//! `test/wild-shape.test.mjs`, касающихся самого модуля.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, hash, parse, stringify};
use serde_json::{json, Value};
use sk_combat_content::combat_actions::{self as m, ClassResourceOptions};
use sk_core::js;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/combat-actions.json")));

const MODERN: ClassResourceOptions = ClassResourceOptions { class_resources_2024: true };
const CLASSIC: ClassResourceOptions = ClassResourceOptions { class_resources_2024: false };

#[test]
fn constants_and_catalog_info_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["ONE_ON_SHORT_REST"], m::ONE_ON_SHORT_REST);
    assert_eq!(constants["CLASS_RESOURCES_2024_POLICY_ID"], m::CLASS_RESOURCES_2024_POLICY_ID);
    assert_eq!(constants["passive"], json!(m::passive_class_feature_ids()));
    assert_same(&m::combat_class_catalog_info(), &FIXTURE["catalogInfo"], "combatClassCatalogInfo");
}

#[test]
fn hero_actions_and_resources_match_js() {
    let cases = array(&FIXTURE["actors"]);
    assert!(cases.len() > 1_500, "героев: {}", cases.len());
    let probes = [json!("extra-attack"), json!("dash"), json!("wild-shape"), json!("rage"), json!("breath-weapon"), json!("nope"), Value::Null];
    let mut cards_checked = 0;
    for (index, case) in cases.iter().enumerate() {
        let actor = arg(&case["actor"]);
        let context = format!("герой #{index}: {}", stringify(&case["actor"]));
        let cards = m::combat_actions_for(actor);
        let expected = array(&case["cards"]);
        let ids: Vec<&Value> = cards.iter().map(|card| &card["id"]).collect();
        let expected_ids: Vec<&Value> = expected.iter().map(|pair| &pair[0]).collect();
        assert_eq!(ids, expected_ids, "набор действий: {context}");
        for (card, pair) in cards.iter().zip(expected) {
            common::assert_js_order(card, &context);
            assert_eq!(hash(Some(card)), pair[1].as_str().expect("хеш"), "действие {}: {context}\n{}", pair[0], stringify(card));
            cards_checked += 1;
        }
        assert_same(&m::combat_resource_maximums_for(actor, CLASSIC), &case["maximums"], &format!("combatResourceMaximumsFor, {context}"));
        assert_same(&m::combat_resource_maximums_for(actor, MODERN), &case["maximums2024"], &format!("combatResourceMaximumsFor 2024, {context}"));
        assert_same(&m::combat_resource_recovery_for(actor, CLASSIC), &case["recovery"], &format!("combatResourceRecoveryFor, {context}"));
        assert_same(&m::combat_resource_recovery_for(actor, MODERN), &case["recovery2024"], &format!("combatResourceRecoveryFor 2024, {context}"));
        assert_eq!(json!(m::superseded_feature_resource_ids_for(actor)), case["superseded"], "supersededFeatureResourceIdsFor, {context}");
        assert_eq!(json!(m::normalized_combat_subclass_for(actor)), case["subclass"], "normalizedCombatSubclassFor, {context}");
        assert_eq!(hash(Some(&Value::Array(m::combat_subclass_options_for(actor)))), case["options"].as_str().expect("хеш"), "combatSubclassOptionsFor, {context}");
        assert_eq!(js::num(m::weapon_attacks_per_action_for(actor)), case["attacks"], "weaponAttacksPerActionFor, {context}");
        let probed: Vec<String> = probes.iter().map(|id| hash(m::combat_action_for(actor, Some(id)).as_ref().or(Some(&Value::Null)))).collect();
        assert_eq!(json!(probed), case["probes"], "combatActionFor, {context}");
    }
    assert!(cards_checked > 40_000, "карточек: {cards_checked}");
}

#[test]
fn full_cards_match_js() {
    for case in array(&FIXTURE["full"]) {
        assert_same(&Value::Array(m::combat_actions_for(Some(&case["actor"]))), &case["cards"], &format!("combatActionsFor {}", case["actor"]));
    }
}

#[test]
fn exploration_and_resource_options_match_js() {
    for case in array(&FIXTURE["exploration"]) {
        assert_eq!(m::exploration_use_for(arg(&case["entry"])), case["use"], "explorationUseFor {case}");
    }
    for case in array(&FIXTURE["resourceOptions"]) {
        assert_eq!(m::class_resource_options_for(arg(&case["state"])).to_value(), case["options"], "classResourceOptionsFor {case}");
    }
}

/// `test/combat-actions.test.mjs`: каталог воина и ресурсы — в части модуля.
#[test]
fn fighter_battle_master_actions_and_pools() {
    let fighter = json!({ "characterClass": "fighter", "subclass": "Мастер боевых искусств", "role": "Воин · ур. 3", "level": 3, "abilities": { "str": 16 } });
    let actions = m::combat_actions_for(Some(&fighter));
    let ids: Vec<&str> = actions.iter().filter_map(|action| action["id"].as_str()).collect();
    for id in ["dash", "second-wind", "action-surge", "trip-attack"] {
        assert!(ids.contains(&id), "{id}");
    }
    let support = |id: &str| actions.iter().find(|action| action["id"] == id).map(|action| action["mechanicsSupport"].clone());
    assert_eq!(support("dash"), Some(json!("verified")));
    assert_eq!(support("ready"), Some(json!("partial")));
    assert_eq!(support("use-object"), Some(json!("ruling-only")));
    let maxima = m::combat_resource_maximums_for(Some(&fighter), CLASSIC);
    assert_eq!(maxima["second_wind"], 1);
    assert_eq!(maxima["superiority_dice"], 4);
    assert!(maxima.get("feature_fighter-vtoroe-dyhanie").is_none(), "каталожный дубль Второго дыхания не создаёт отдельный запас");
    let countercharm = m::combat_actions_for(Some(&json!({ "characterClass": "bard", "level": 6 }))).into_iter().find(|action| action["id"] == "countercharm").expect("контрочарование");
    assert_eq!(countercharm["mechanicsSupport"], "partial");
}

/// Один запас Божественного канала у жреца: каталожная «шапка» не заводит второй.
#[test]
fn cleric_has_single_channel_divinity_pool() {
    let cleric = json!({ "id": "cleric", "characterClass": "cleric", "subclass": "Домен жизни", "level": 3, "abilities": { "wis": 16 } });
    let maxima = m::combat_resource_maximums_for(Some(&cleric), CLASSIC);
    assert_eq!(maxima["channel_divinity"], 1);
    assert!(maxima.get("feature_cleric-bozhestvennyy-kanal").is_none());
    assert!(m::combat_resource_recovery_for(Some(&cleric), CLASSIC).get("feature_cleric-bozhestvennyy-kanal").is_none());
    assert!(m::superseded_feature_resource_ids_for(Some(&cleric)).contains(&"feature_cleric-bozhestvennyy-kanal".to_string()));
}

/// Варвар первого уровня: ровно два применения Ярости, восстановление — долгий отдых.
#[test]
fn barbarian_level_one_rage() {
    let barbarian = json!({ "character": "Краг", "role": "Варвар · ур. 1", "characterClass": "barbarian", "level": 1 });
    let rage: Vec<Value> = m::combat_actions_for(Some(&barbarian)).into_iter().filter(|action| action["id"] == "rage").collect();
    assert_eq!(rage.len(), 1);
    assert_eq!(rage[0]["resource"], "rage");
    assert_eq!(m::combat_resource_maximums_for(Some(&barbarian), CLASSIC), json!({ "rage": 2 }));
    assert_eq!(m::combat_resource_recovery_for(Some(&barbarian), CLASSIC), json!({ "rage": "long" }));
    assert_eq!(m::combat_resource_recovery_for(Some(&barbarian), MODERN), json!({ "rage": m::ONE_ON_SHORT_REST }));
}

/// `test/class-resources-2024.test.mjs` в части модуля: запасы 2024 только с маркером политики.
#[test]
fn class_resources_2024_follow_policy_marker() {
    let state = |ruleset: &str, rules: Value| json!({ "ruleset_id": ruleset, "enabled_house_rules": rules });
    assert!(m::class_resource_options_for(Some(&state("srd_5_2_1", json!([m::CLASS_RESOURCES_2024_POLICY_ID])))).class_resources_2024);
    assert!(!m::class_resource_options_for(Some(&state("dnd_5e_2014", json!([m::CLASS_RESOURCES_2024_POLICY_ID])))).class_resources_2024);
    assert!(!m::class_resource_options_for(Some(&state("srd_5_2_1", json!([])))).class_resources_2024);
    let cleric = json!({ "characterClass": "cleric", "level": 6 });
    assert_eq!(m::combat_resource_maximums_for(Some(&cleric), MODERN)["channel_divinity"], 3);
    assert_eq!(m::combat_resource_maximums_for(Some(&cleric), CLASSIC)["channel_divinity"], 2);
    let fighter = json!({ "characterClass": "fighter", "level": 4 });
    assert_eq!(m::combat_resource_maximums_for(Some(&fighter), MODERN)["second_wind"], 3);
}

/// Дикий облик Круга луны — бонусным действием, с перечнем зверей.
#[test]
fn moon_druid_wild_shape_is_bonus_action_with_forms() {
    let druid = json!({ "characterClass": "druid", "subclass": "Круг луны", "level": 7 });
    let shape = m::combat_action_for(Some(&druid), Some(&json!("wild-shape"))).expect("дикая форма");
    assert_eq!(shape["actionType"], "bonus_action");
    let forms: Vec<&str> = array(&shape["forms"]).iter().filter_map(|form| form["id"].as_str()).collect();
    assert!(forms.contains(&"giant-boar"));
    let land = json!({ "characterClass": "druid", "level": 7 });
    assert_eq!(m::combat_action_for(Some(&land), Some(&json!("wild-shape"))).expect("дикая форма")["actionType"], "action");
}

/// `test/extra-attack.test.mjs` в части модуля: атак за действие.
#[test]
fn extra_attack_counts() {
    let fighter = |level: i64| json!({ "characterClass": "fighter", "level": level });
    assert_eq!(m::weapon_attacks_per_action_for(Some(&fighter(4))), 1.0);
    assert_eq!(m::weapon_attacks_per_action_for(Some(&fighter(5))), 2.0);
    assert_eq!(m::weapon_attacks_per_action_for(Some(&fighter(11))), 3.0);
    assert_eq!(m::weapon_attacks_per_action_for(Some(&json!({ "characterClass": "wizard", "level": 12 }))), 1.0);
}
