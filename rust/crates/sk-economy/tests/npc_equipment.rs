//! `npc_equipment`: эталон JS (`fixtures/npc-equipment.json`) и проверки
//! модуля из `test/npc-equipment.test.mjs` (то, что там идёт через Rules
//! Engine и планировщик, сверяется эталоном). Стат-блоки — из эталона
//! `enemy-loadouts.json`: бестиарий в Rust ещё не перенесён.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{check, ok, ok_or_null, Args, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_economy::enemy_loadouts::{enemy_loadout_for, ENEMY_LOADOUT_TEMPLATE_IDS};
use sk_economy::npc_equipment::*;
use sk_items::item_catalog::catalog_item;

fn ruleset(args: &Args, index: usize) -> String {
    js::s(args.option(index, "rulesetId"))
}

fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    match name {
        "const:NPC_EQUIPMENT_POLICY_ID" => ok(json!(NPC_EQUIPMENT_POLICY_ID)),
        "const:NPC_EQUIPMENT_EVENT_SCHEMA_VERSION" => ok(json!(NPC_EQUIPMENT_EVENT_SCHEMA_VERSION)),
        "const:NPC_HEALING_POTION_HP_PERCENT" => ok(json!(NPC_HEALING_POTION_HP_PERCENT)),
        "const:NPC_TACTIC_CONDITION_PREFIX" => ok(json!(NPC_TACTIC_CONDITION_PREFIX)),
        "const:NPC_ATTACK_FORMULA_DEVIATIONS" => ok(npc_attack_formula_deviations_json()),
        "const:NPC_ITEM_TACTICS" => ok(npc_item_tactics_json()),
        "const:NPC_ITEM_TACTIC_IDS" => ok(json!(NPC_ITEM_TACTIC_IDS)),
        "const:NPC_ACTION_UNAVAILABLE_MESSAGES" => ok(npc_action_unavailable_messages_json()),
        "npcItemTacticFor" => ok_or_null(npc_item_tactic_for(a(0)).map(NpcItemTactic::to_json)),
        "npcAttackFormulaDeviationKey" => ok(json!(npc_attack_formula_deviation_key(a(0), a(1)))),
        "npcTacticCondition" => ok(json!(npc_tactic_condition(a(0)))),
        "npcWeaponBindings" => ok(Value::Array(npc_weapon_bindings(a(0)))),
        "npcWeaponBindingFor" => ok_or_null(npc_weapon_binding_for(a(0), a(1))),
        "npcMeleeWeaponBindingForItem" => ok_or_null(npc_melee_weapon_binding_for_item(a(0), a(1))),
        "npcActionUnavailableReason" => ok_or_null(npc_action_unavailable_reason(a(0), a(1)).map(|reason| json!(reason))),
        "npcAttackExpenditureFor" => ok_or_null(npc_attack_expenditure_for(a(0), a(1))),
        "npcUsableItems" => ok(Value::Array(npc_usable_items(a(0), &ruleset(args, 1)))),
        "npcUsableItemFor" => ok_or_null(npc_usable_item_for(a(0), a(1), &ruleset(args, 2))),
        "npcLoadoutItem" => ok_or_null(npc_loadout_item(a(0), a(1)).cloned()),
        "npcNeedsHealingPotion" => ok(json!(npc_needs_healing_potion(a(0)))),
        "npcWeaponBindingCheck" => ok(npc_weapon_binding_check(a(0), a(1), a(2)).to_json()),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn npc_equipment_matches_js() {
    let summary = check(include_str!("../fixtures/npc-equipment.json"), run);
    assert!(summary.calls > 15_000, "{summary:?}");
}

/// Полные стат-блоки шаблонов из эталона снаряжения (с формулами урона).
fn blocks() -> BTreeMap<String, Value> {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/npc-equipment.json")).expect("эталон");
    let mut blocks = BTreeMap::new();
    for case in fixture["cases"].as_array().expect("случаи") {
        if case["fn"] != "bundle:enemy" {
            continue;
        }
        let enemy = &case["args"][0];
        if let Some(id) = enemy["stat_block_id"].as_str() {
            blocks.entry(id.to_string()).or_insert_with(|| enemy.clone());
        }
    }
    blocks
}

/// Противник шаблона с инвентарём на этом сиде.
fn foe(blocks: &BTreeMap<String, Value>, id: &str, seed: &str, hp: Option<i64>) -> Value {
    let mut enemy = blocks[id].clone();
    let block = json!({ "action_profiles": enemy["action_profiles"] });
    enemy["loadout"] = enemy_loadout_for(Some(&json!({ "statBlockId": id, "block": block, "ownerId": "foe", "seed": seed }))).expect("инвентарь");
    if let Some(hp) = hp {
        enemy["hp"] = json!(hp);
    }
    enemy
}

fn seed_with(blocks: &BTreeMap<String, Value>, id: &str, catalog_id: &str) -> String {
    (0..400).map(|index| format!("seed-{index}")).find(|seed| foe(blocks, id, seed, None)["loadout"]["items"].as_array().is_some_and(|items| items.iter().any(|item| item["catalog_id"] == catalog_id))).unwrap_or_else(|| panic!("{id} ни разу не выдал {catalog_id}"))
}

fn item_of<'a>(enemy: &'a Value, catalog_id: &str) -> &'a Value {
    enemy["loadout"]["items"].as_array().and_then(|items| items.iter().find(|item| item["catalog_id"] == catalog_id)).unwrap_or_else(|| panic!("нет {catalog_id}"))
}

#[test]
fn every_binding_matches_catalog_or_is_declared() {
    let blocks = blocks();
    let mut seen = BTreeSet::new();
    for id in ENEMY_LOADOUT_TEMPLATE_IDS {
        let enemy = foe(&blocks, id, "binding-sweep", None);
        let bindings = npc_weapon_bindings(Some(&enemy));
        let profiles = enemy["action_profiles"].as_array().cloned().unwrap_or_default();
        for binding in &bindings {
            let profile = profiles.iter().find(|profile| profile["id"] == binding["action_id"]).expect("действие привязки");
            assert!(catalog_item(binding["catalog_id"].as_str().unwrap_or_default()).and_then(|entry| entry.get("combat")).is_some(), "{id}");
            let Some(key) = binding["deviation"].as_str() else { continue };
            let declared = npc_attack_formula_deviation(key).expect("объявлено");
            assert_eq!(json!(declared.profile_damage), profile["damage_expression"], "{key}");
            assert_eq!(json!(declared.catalog_id), binding["catalog_id"], "{key}");
            assert!(declared.reason.chars().count() > 20, "{key}");
            seen.insert(key.to_string());
        }
        for profile in &profiles {
            let bound_name = profile["id"].as_str().unwrap_or_default().trim_end_matches("-melee").trim_end_matches("-ranged").to_string();
            let has_item = enemy["loadout"]["items"].as_array().is_some_and(|items| items.iter().any(|item| item["catalog_id"].as_str().is_some_and(|catalog| catalog.ends_with(&format!(":{bound_name}")))));
            if has_item {
                assert!(bindings.iter().any(|binding| binding["action_id"] == profile["id"]), "{id}: действие {} без привязки", profile["id"]);
            }
        }
    }
    let declared: BTreeSet<String> = NPC_ATTACK_FORMULA_DEVIATIONS.iter().map(|entry| entry.key.to_string()).collect();
    assert_eq!(seen, declared, "объявлено расхождение, которого нет ни у одного шаблона");
}

#[test]
fn undeclared_or_stale_formula_drops_the_binding() {
    let blocks = blocks();
    let enemy = foe(&blocks, "srd_5_2_1:goblin-warrior", "binding-sweep", None);
    assert!(npc_weapon_bindings(Some(&enemy)).iter().any(|binding| binding["action_id"] == "scimitar"));
    let mut drifted = enemy.clone();
    for profile in drifted["action_profiles"].as_array_mut().expect("действия") {
        if profile["id"] == "scimitar" {
            profile["damage_expression"] = json!("1d12+2");
        }
    }
    assert!(!npc_weapon_bindings(Some(&drifted)).iter().any(|binding| binding["action_id"] == "scimitar"));

    let bugbear = foe(&blocks, "srd_5_2_1:bugbear", "binding-sweep", None);
    assert!(npc_weapon_bindings(Some(&bugbear)).iter().any(|binding| binding["action_id"] == "morningstar"));
    let mut stale = bugbear.clone();
    for profile in stale["action_profiles"].as_array_mut().expect("действия") {
        if profile["id"] == "morningstar" {
            profile["damage_expression"] = json!("4d8+2");
        }
    }
    assert!(!npc_weapon_bindings(Some(&stale)).iter().any(|binding| binding["action_id"] == "morningstar"));
}

#[test]
fn closed_tactic_list_matches_the_catalog() {
    let tactics: BTreeSet<&str> = NPC_ITEM_TACTICS.iter().map(|entry| entry.tactic).collect();
    assert_eq!(tactics, NPC_ITEM_TACTIC_IDS.into_iter().collect());
    for tactic in NPC_ITEM_TACTICS {
        let entry = catalog_item(tactic.catalog_id).expect("запись");
        assert_eq!(entry["mechanics_status"], "verified", "{}", tactic.catalog_id);
        assert_eq!(entry["use"]["kind"], tactic.use_kind);
        assert_eq!(entry["use"]["combat_action"], tactic.combat_action);
        assert_eq!(entry["enemy_loadout_eligible"], true);
        assert!(tactic.label.chars().count() > 5);
    }
    let blocks = blocks();
    let seed = seed_with(&blocks, "srd_5_2_1:berserker", "srd_5_2_1:potion-of-healing");
    assert_eq!(npc_usable_items(Some(&foe(&blocks, "srd_5_2_1:berserker", &seed, None)), "").len(), 1);
    assert!(npc_item_tactic_for(Some(&json!("constructor"))).is_none(), "ключ прототипа — не тактика");
}

#[test]
fn healing_potion_threshold_is_integer() {
    let blocks = blocks();
    let maximum = blocks["srd_5_2_1:berserker"]["maxHp"].as_i64().expect("хиты");
    let threshold = maximum * NPC_HEALING_POTION_HP_PERCENT / 100;
    assert!(!npc_needs_healing_potion(Some(&json!({ "hp": maximum, "maxHp": maximum }))));
    assert!(npc_needs_healing_potion(Some(&json!({ "hp": threshold, "maxHp": maximum }))));
    assert!(!npc_needs_healing_potion(Some(&json!({ "hp": 0, "maxHp": maximum }))), "побеждённое существо не пьёт");
    // 2014: зелье тратит действие — профиль использования тот же, цена хода из каталога.
    let seed = seed_with(&blocks, "srd_5_2_1:berserker", "srd_5_2_1:potion-of-healing");
    let usable = npc_usable_items(Some(&foe(&blocks, "srd_5_2_1:berserker", &seed, None)), "dnd_5e_2014");
    assert_eq!(usable[0]["use"]["combat_action"], "action");
}

#[test]
fn empty_quiver_and_lost_weapon_close_the_action() {
    let blocks = blocks();
    let scout = foe(&blocks, "srd_5_2_1:scout", "npc-equipment", None);
    let arrows_id = item_of(&scout, "srd_5_2_1:arrows-20")["item_instance_id"].clone();
    let mut last_arrow = scout.clone();
    for item in last_arrow["loadout"]["items"].as_array_mut().expect("инвентарь") {
        if item["item_instance_id"] == arrows_id {
            item["quantity"] = json!(1);
            item["charges"] = json!({ "current": 1, "max": 20 });
        }
    }
    let spent = npc_attack_expenditure_for(Some(&last_arrow), Some(&json!("longbow"))).expect("расход");
    assert_eq!((spent["shots_after"].as_i64(), spent["quantity_after"].as_i64()), (Some(0), Some(0)));
    let mut empty = last_arrow.clone();
    let items = empty["loadout"]["items"].as_array_mut().expect("инвентарь");
    items.retain(|item| item["item_instance_id"] != arrows_id);
    assert_eq!(npc_action_unavailable_reason(Some(&empty), Some(&json!("longbow"))), Some("ammunition-spent"));
    let mut disarmed = empty.clone();
    disarmed["loadout"]["items"].as_array_mut().expect("инвентарь").retain(|item| item["catalog_id"] != "srd_5_2_1:shortsword");
    assert_eq!(npc_action_unavailable_reason(Some(&disarmed), Some(&json!("shortsword"))), Some("weapon-lost"));
    // У волка инвентаря нет — его укус этой веткой не закрывается.
    let wolf = json!({ "stat_block_id": "srd_5_2_1:wolf", "action_profiles": blocks["srd_5_2_1:wolf"]["action_profiles"] });
    assert!(npc_weapon_bindings(Some(&wolf)).is_empty());
    assert_eq!(npc_action_unavailable_reason(Some(&wolf), Some(&json!("bite"))), None);
}

#[test]
fn equipped_thrown_weapon_stays_and_bundle_is_spent() {
    let blocks = blocks();
    let gladiator = foe(&blocks, "srd_5_2_1:gladiator", "npc-equipment", None);
    let spear = item_of(&gladiator, "srd_5_2_1:spear");
    assert_eq!((spear["equipped"].as_bool(), spear["quantity"].as_i64()), (Some(true), Some(1)));
    let binding = npc_weapon_binding_for(Some(&gladiator), Some(&json!("spear-ranged"))).expect("привязка");
    assert_eq!(binding["expends"], Value::Null);
    assert!(npc_attack_expenditure_for(Some(&gladiator), Some(&json!("spear-ranged"))).is_none());

    let mut captain = foe(&blocks, "srd_5_2_1:guard-captain", "npc-equipment", None);
    let javelins = item_of(&captain, "srd_5_2_1:javelin").clone();
    assert_eq!(javelins["equipped"], false);
    assert!(javelins["quantity"].as_i64().unwrap_or(0) >= 2);
    assert_eq!(npc_weapon_binding_for(Some(&captain), Some(&json!("javelin-ranged"))).expect("привязка")["expends"], "thrown");
    let mut left = javelins["quantity"].as_i64().unwrap_or(0);
    while left > 0 {
        let spent = npc_attack_expenditure_for(Some(&captain), Some(&json!("javelin-ranged"))).expect("бросок");
        assert_eq!((spent["reason"].as_str(), spent["quantity_before"].as_i64(), spent["quantity_after"].as_i64()), (Some("thrown"), Some(left), Some(left - 1)));
        let items = captain["loadout"]["items"].as_array_mut().expect("инвентарь");
        for item in items.iter_mut() {
            if item["item_instance_id"] == javelins["item_instance_id"] {
                item["quantity"] = json!(left - 1);
            }
        }
        items.retain(|item| item["quantity"].as_i64().unwrap_or(1) > 0);
        left -= 1;
    }
    assert_eq!(npc_action_unavailable_reason(Some(&captain), Some(&json!("javelin-ranged"))), Some("weapon-lost"));
    assert_eq!(npc_action_unavailable_reason(Some(&captain), Some(&json!("javelin-melee"))), Some("weapon-lost"));
    assert_eq!(npc_action_unavailable_reason(Some(&captain), Some(&json!("longsword"))), None);
}

#[test]
fn poison_goes_on_the_bound_melee_blade() {
    let blocks = blocks();
    let seed = seed_with(&blocks, "srd_5_2_1:spy", "srd_5_2_1:poison-basic");
    let spy = foe(&blocks, "srd_5_2_1:spy", &seed, None);
    let sword = item_of(&spy, "srd_5_2_1:shortsword")["item_instance_id"].clone();
    let binding = npc_melee_weapon_binding_for_item(Some(&spy), Some(&sword)).expect("клинок");
    assert_eq!(binding["kind"], "melee");
    let poison = item_of(&spy, "srd_5_2_1:poison-basic")["item_instance_id"].clone();
    let usable = npc_usable_item_for(Some(&spy), Some(&poison), "").expect("яд");
    assert_eq!((usable["tactic"].as_str(), usable["once_per_combat"].as_bool()), (Some("coat"), Some(true)));
    assert_eq!(npc_tactic_condition(Some(&json!("coat"))), "npc-tactic-used:coat");
}
