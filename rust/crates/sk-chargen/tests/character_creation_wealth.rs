//! Сверка `character_creation_wealth` с эталоном JS
//! (`fixtures/character-creation-wealth.json`, генератор —
//! `fixtures/gen-character-creation-wealth.mjs`) и перенесённые проверки из
//! `test/character-creation-wealth.test.mjs` и `test/spell-component-items.test.mjs`.
//!
//! Бросок богатства в эталоне делает DiceService JS на последовательности
//! костей; здесь тот же бросок — через внедрённый `sk_dice::Dice`.

mod common;

use common::{check, ok, Args, Outcome};
use serde_json::{json, Value};
use sk_chargen::character_creation_wealth as m;
use sk_dice::{Dice, DiceService, SequenceRng, Visibility};

/// Полезная нагрузка `CharacterWealthRolled`, как её собирает Rules Engine.
fn roll_character_wealth(class_id: &str, values: Vec<i64>) -> Value {
    let formula = m::phb_starting_wealth(class_id).expect("класс PHB 2014");
    let mut dice = DiceService::deterministic(SequenceRng::new(values), "wealth");
    let roll = dice.roll(formula.expression, "character-starting-wealth", Some("hero"), Visibility::Party).expect("бросок");
    json!({ "schema_version": 1, "id": roll.roll_id, "class_id": class_id, "roll": roll, "total_gp": roll.total * formula.multiplier })
}

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:PHB_STARTING_WEALTH" => ok(m::phb_starting_wealth_json()),
        "const:PHB_STARTING_WEALTH_PROVENANCE" => ok(m::PHB_STARTING_WEALTH_PROVENANCE.clone()),
        "startingPurchaseCatalog" => ok(m::starting_purchase_catalog()),
        "rollCharacterWealth" => {
            let values = args.get(1).and_then(Value::as_array).expect("кости").iter().filter_map(Value::as_i64).collect();
            ok(roll_character_wealth(&args.s(0), values))
        }
        "resolveStartingPurchases" => ok(m::resolve_starting_purchases(args.get(0), args.get(1), args.get(2))),
        other => panic!("неизвестный случай {other}"),
    }
}

#[test]
fn matches_js_fixture() {
    let cases = check(include_str!("../fixtures/character-creation-wealth.json"), run);
    assert!(cases > 1_000, "{cases}");
}

fn catalog() -> Vec<Value> {
    m::starting_purchase_catalog().as_array().cloned().expect("каталог")
}

fn has(catalog: &[Value], id: &str, price: i64, weight: f64) -> bool {
    catalog.iter().any(|entry| entry["id"] == id && entry["price_cp"] == price && entry["weight"].as_f64() == Some(weight))
}

#[test]
fn mule_and_cart_are_owned_assets_not_backpack_cargo() {
    let result = m::resolve_starting_purchases(
        Some(&json!("fighter")),
        Some(&json!({ "id": "owned-assets-roll", "class_id": "fighter", "total_gp": 100 })),
        Some(&json!([{ "id": "mount:mule", "quantity": 1 }, { "id": "vehicle:cart", "quantity": 1 }])),
    );
    assert_eq!(result["ok"], true);
    assert_eq!(result["remaining_currency"]["gold"], 77);
    assert_eq!(result["inventory"], json!([]));
    assert_eq!(result["owned_assets"].as_array().map(Vec::len), Some(2));
    assert_eq!(result["owned_assets"][0]["carrying_capacity_lb"], 420);
}

#[test]
fn wealth_table_has_exact_phb_2014_formulas() {
    assert_eq!(
        m::phb_starting_wealth_json(),
        json!({
            "barbarian": { "expression": "2d4", "multiplier": 10 }, "bard": { "expression": "5d4", "multiplier": 10 },
            "cleric": { "expression": "5d4", "multiplier": 10 }, "druid": { "expression": "2d4", "multiplier": 10 },
            "fighter": { "expression": "5d4", "multiplier": 10 }, "monk": { "expression": "5d4", "multiplier": 1 },
            "paladin": { "expression": "5d4", "multiplier": 10 }, "ranger": { "expression": "5d4", "multiplier": 10 },
            "rogue": { "expression": "4d4", "multiplier": 10 }, "sorcerer": { "expression": "3d4", "multiplier": 10 },
            "warlock": { "expression": "4d4", "multiplier": 10 }, "wizard": { "expression": "4d4", "multiplier": 10 },
        })
    );
}

#[test]
fn purchase_catalog_has_ordinary_priced_items_and_no_magic() {
    let catalog = catalog();
    assert!(catalog.len() > 150);
    for (id, price, weight) in [
        ("srd_5_2_1:longsword", 1_500, 3.0),
        ("srd_5_2_1:chain-mail", 7_500, 55.0),
        ("srd_5_2_1:lute", 3_500, 2.0),
        ("dragonchess", 100, 0.5),
        ("srd_5_2_1:cobblers-tools", 500, 5.0),
        ("abacus", 200, 2.0),
        ("rope-silk-50-feet", 1_000, 5.0),
        ("srd_5_2_1:rope-hempen-50-feet", 100, 10.0),
        ("net", 100, 3.0),
        ("dungeoneers-pack", 1_200, 56.5),
    ] {
        assert!(has(&catalog, id, price, weight), "{id}");
    }
    assert!(catalog.iter().any(|entry| entry["id"] == "srd_5_2_1:potion-of-healing" && entry["price_cp"] == 5_000 && entry["weight"] == 0.5 && entry["mechanics_status"] == "verified"));
    assert!(!catalog.iter().any(|entry| entry["id"] == "srd_5_2_1:longsword-plus-1"));
    assert!(!catalog.iter().any(|entry| entry["id"] == "srd_5_2_1:ring-of-protection"));
    // В JS это проверка при загрузке модуля (`TypeError` на некорректной записи).
    assert!(catalog.iter().all(|entry| {
        entry["name"].as_str().is_some_and(|name| !name.is_empty())
            && entry["price_cp"].as_i64().is_some_and(|price| price > 0)
            && (entry["owned_asset"] == true || entry["weight"].as_f64().is_some_and(f64::is_finite))
    }));
    let mut changed = m::starting_purchase_catalog();
    changed[0]["name"] = json!("подделка");
    assert_ne!(m::starting_purchase_catalog()[0]["name"], "подделка");
}

#[test]
fn purchases_count_copper_and_return_change() {
    let roll = |id: &str, total: i64| json!({ "class_id": "fighter", "total_gp": total, "id": id });
    let result = m::resolve_starting_purchases(Some(&json!("fighter")), Some(&roll("wealth-roll-1", 100)), Some(&json!([{ "id": "srd_5_2_1:longsword", "quantity": 1 }, { "id": "lute", "quantity": 1 }])));
    assert_eq!(result["ok"], true);
    assert_eq!(result["spent_cp"], 5_000);
    assert_eq!(result["remaining_currency"], json!({ "total_cp": 5_000, "total_gp": 50, "gold": 50, "silver": 0, "copper": 0 }));
    let inventory = &result["inventory"];
    assert_eq!((inventory[0]["catalog_id"].clone(), inventory[0]["quantity"].clone(), inventory[0]["weight"].clone(), inventory[0]["price_cp"].clone()), (json!("srd_5_2_1:longsword"), json!(1), json!(3), json!(1_500)));
    assert_eq!((inventory[1]["catalog_id"].clone(), inventory[1]["type"].clone(), inventory[1]["weight"].clone()), (json!("srd_5_2_1:lute"), json!("tool"), json!(2)));
    assert_eq!(inventory[1]["spellcasting_focus"], json!(["bard"]));
    assert_eq!(inventory[1]["focus_mode"], "held");
    let rope = m::resolve_starting_purchases(Some(&json!("fighter")), Some(&roll("wealth-roll-rope", 10)), Some(&json!([{ "id": "srd_5_2_1:rope-hempen-50-feet", "quantity": 1 }])));
    assert_eq!(rope["ok"], true);
    assert_eq!(rope["inventory"][0]["weight"], 10);
    let alias = m::resolve_starting_purchases(Some(&json!("fighter")), Some(&roll("wealth-roll-2", 100)), Some(&json!([{ "id": "cobblers_tools", "quantity": 1 }])));
    assert_eq!(alias["ok"], true);
    assert_eq!(alias["inventory"][0]["catalog_id"], "srd_5_2_1:cobblers-tools");
}

#[test]
fn purchases_may_be_cheaper_than_wealth_but_not_dearer() {
    let roll = |id: &str| json!({ "class_id": "monk", "total_gp": 12, "id": id });
    let monk = json!("monk");
    let empty = m::resolve_starting_purchases(Some(&monk), Some(&roll("r2")), Some(&json!([])));
    assert_eq!(empty["ok"], true);
    assert_eq!(empty["remaining_currency"]["total_gp"], 12);
    let under = m::resolve_starting_purchases(Some(&monk), Some(&roll("r3")), Some(&json!([{ "id": "dice_set", "quantity": 1 }])));
    assert_eq!(under["ok"], true);
    assert_eq!(under["remaining_currency"]["total_cp"], 1_190);
    let over = m::resolve_starting_purchases(Some(&monk), Some(&roll("r4")), Some(&json!([{ "id": "srd_5_2_1:plate-armor", "quantity": 1 }])));
    assert_eq!(over["ok"], false);
    assert_eq!(over["code"], "PURCHASES_OVER_BUDGET");
}

#[test]
fn forged_magic_and_invalid_purchases_are_refused_before_inventory() {
    let wizard = json!("wizard");
    let roll = json!({ "class_id": "wizard", "total_gp": 100, "id": "r5" });
    let code = |roll: &Value, purchases: Value| m::resolve_starting_purchases(Some(&wizard), Some(roll), Some(&purchases))["code"].clone();
    assert_eq!(code(&json!({ "class_id": "fighter", "total_gp": 100, "id": "r5" }), json!([])), "WEALTH_CLASS_MISMATCH");
    assert_eq!(code(&json!({ "class_id": "wizard", "total_gp": 100, "id": "" }), json!([])), "WEALTH_ROLL_ID_REQUIRED");
    assert_eq!(code(&roll, json!([{ "id": "srd_5_2_1:ring-of-protection", "quantity": 1 }])), "PURCHASE_UNKNOWN_ITEM");
    assert_eq!(code(&roll, json!([{ "id": "unknown", "quantity": 1 }])), "PURCHASE_UNKNOWN_ITEM");
    assert_eq!(code(&roll, json!([{ "id": "lute", "quantity": 0 }])), "PURCHASE_QUANTITY_INVALID");
    assert_eq!(code(&roll, json!([{ "id": "lute", "quantity": 1.5 }])), "PURCHASE_QUANTITY_INVALID");
    assert_eq!(m::resolve_starting_purchases(Some(&wizard), Some(&roll), Some(&json!([{ "id": "lute", "quantity": 1 }])))["ok"], true);
    assert_eq!(m::resolve_starting_purchases(Some(&wizard), Some(&roll), Some(&json!([{ "id": "srd_5_2_1:plate-armor", "quantity": 1 }])))["ok"], false);
}

// --- test/spell-component-items.test.mjs ---

#[test]
fn bard_instruments_and_components_are_real_catalog_instances() {
    let catalog = catalog();
    assert!(!catalog.iter().any(|entry| entry["catalog_id"] == "phb_2014:equipment:component-pouch"));
    let bard = m::resolve_starting_purchases(
        Some(&json!("bard")),
        Some(&json!({ "id": "bard-instruments", "class_id": "bard", "total_gp": 200 })),
        Some(&json!([{ "id": "lute", "quantity": 1 }, { "id": "flute", "quantity": 1 }, { "id": "drum", "quantity": 1 }])),
    );
    assert_eq!(bard["ok"], true);
    assert!(bard["inventory"].as_array().expect("инвентарь").iter().all(|item| item["spellcasting_focus"].as_array().is_some_and(|classes| classes.contains(&json!("bard"))) && item["focus_mode"] == "held"));
    let wealth = m::resolve_starting_purchases(
        Some(&json!("wizard")),
        Some(&json!({ "id": "component-roll", "class_id": "wizard", "total_gp": 100 })),
        Some(&json!([{ "id": "component-pouch", "quantity": 1 }, { "id": "diamond", "quantity": 1 }])),
    );
    assert_eq!(wealth["ok"], true);
    let ids: Vec<Value> = wealth["inventory"].as_array().expect("инвентарь").iter().map(|item| item["catalog_id"].clone()).collect();
    assert_eq!(ids, [json!("srd_5_2_1:component-pouch"), json!("srd_5_2_1:diamond-50gp")]);
    assert_eq!(wealth["inventory"][0]["component_pouch"], true);
    assert_eq!(wealth["inventory"][1]["material_component"], json!({ "kind": "diamond", "value_cp": 5_000 }));
    let dust = m::resolve_starting_purchases(
        Some(&json!("wizard")),
        Some(&json!({ "id": "material-roll", "class_id": "wizard", "total_gp": 1000 })),
        Some(&json!([{ "id": "srd_5_2_1:material-diamond-dust-100gp", "quantity": 2 }])),
    );
    assert_eq!(dust["inventory"][0]["quantity"], 2);
    assert_eq!(dust["inventory"][0]["material_component"], json!({ "kind": "diamond-dust", "value_cp": 10_000, "spell_ids": ["greater-restoration", "stoneskin"] }));
}

#[test]
fn rolled_wealth_from_injected_dice_is_spent_like_the_rules_engine_would() {
    let event = roll_character_wealth("monk", vec![1, 2, 3, 4, 4]);
    assert_eq!(event["total_gp"], 14, "монах: 5к4 × 1");
    let event = roll_character_wealth("barbarian", vec![4, 4]);
    assert_eq!(event["total_gp"], 80, "варвар: 2к4 × 10");
    let roll = json!({ "id": event["id"], "class_id": "barbarian", "total_gp": event["total_gp"] });
    let result = m::resolve_starting_purchases(Some(&json!("barbarian")), Some(&roll), Some(&json!([{ "id": "srd_5_2_1:greataxe", "quantity": 1 }])));
    assert_eq!(result["remaining_currency"]["gold"], 50);
    assert_eq!(result["inventory"][0]["id"], "starting-wealth-wealth-1-1");
}
