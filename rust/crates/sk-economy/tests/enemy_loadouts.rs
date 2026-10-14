//! `enemy_loadouts`: эталон JS (`fixtures/enemy-loadouts.json`, весь
//! бестиарий SRD 5.2.1 и 2014) и проверки модуля из
//! `test/enemy-loadouts.test.mjs`. Стат-блоки для проверок берутся из того же
//! эталона: бестиарий в Rust ещё не перенесён.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{check, ok, ok_or_null, Args, JsError, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_economy::enemy_loadouts::*;
use sk_items::item_catalog::{catalog_item, item_catalog};

const FIXTURE: &str = include_str!("../fixtures/enemy-loadouts.json");

fn failure(error: EnemyLoadoutFailure) -> JsError {
    match error {
        EnemyLoadoutFailure::Loadout(error) => JsError { name: "EnemyLoadoutError".into(), code: Some(error.code), message: error.message },
        EnemyLoadoutFailure::Instance(error) => JsError { name: "ItemInstanceError".into(), code: Some(error.code), message: error.message },
    }
}

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:ENEMY_LOADOUT_SCHEMA_VERSION" => ok(json!(ENEMY_LOADOUT_SCHEMA_VERSION)),
        "const:ENEMY_LOADOUT_POLICY_ID" => ok(json!(ENEMY_LOADOUT_POLICY_ID)),
        "const:MAX_ENEMY_LOADOUT_ITEMS" => ok(json!(MAX_ENEMY_LOADOUT_ITEMS)),
        "const:MAX_ENEMY_PURSE_CP" => ok(json!(MAX_ENEMY_PURSE_CP)),
        "const:WEAPON_CATALOG_BY_ACTION" => ok(weapon_catalog_by_action_json()),
        "const:AMMUNITION_BY_WEAPON" => ok(ammunition_by_weapon_json()),
        "const:ENEMY_LOADOUT_TEMPLATE_IDS" => ok(json!(ENEMY_LOADOUT_TEMPLATE_IDS)),
        "assertEnemyLoadoutItem" => assert_enemy_loadout_item(&args.s(0), js::truthy(args.option(1, "verifiedOnly")), js::truthy(args.option(1, "allowSpellcastingComponent")))
            .map(|entry| Some(entry["catalog_id"].clone()))
            .map_err(|error| JsError { name: "EnemyLoadoutError".into(), code: Some(error.code), message: error.message }),
        "optionalEnemyLoadoutItem" => ok_or_null(optional_enemy_loadout_item(&args.s(0)).map(|entry| entry["catalog_id"].clone())),
        "enemyLoadoutFor" => enemy_loadout_for(args.get(0)).map(Some).map_err(failure),
        "normalizeEnemyLoadout" => ok(normalize_enemy_loadout(args.get(0))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn loadouts_match_js_across_bestiary() {
    let summary = check(FIXTURE, run);
    assert!(summary.calls > 2_500, "{summary:?}");
}

/// Стат-блоки бестиария из эталона: `statBlockId → block`.
fn bestiary() -> BTreeMap<String, Value> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("эталон");
    let mut blocks = BTreeMap::new();
    for case in fixture["cases"].as_array().expect("случаи") {
        if case["fn"] != "enemyLoadoutFor" {
            continue;
        }
        let input = &case["args"][0];
        if let (Some(id), Some(block)) = (input["statBlockId"].as_str(), input.get("block")) {
            if input["seed"] == "sweep-0" || input["seed"] == "classic-0" {
                blocks.entry(id.to_string()).or_insert_with(|| block.clone());
            }
        }
    }
    blocks
}

fn loadout(id: &str, block: &Value, owner: &str, seed: &str) -> Value {
    enemy_loadout_for(Some(&json!({ "statBlockId": id, "block": block, "ownerId": owner, "seed": seed }))).expect("инвентарь")
}

fn items(loadout: &Value) -> &[Value] {
    loadout["items"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

#[test]
fn catalog_declares_loot_metadata_and_armor_is_rejected() {
    for entry in item_catalog().values() {
        let id = entry["catalog_id"].as_str().unwrap_or_default();
        assert!(entry["enemy_loadout_eligible"].is_boolean(), "{id}");
        assert!(entry["corpse_loot_eligible"].is_boolean(), "{id}");
        if entry["mechanics_status"] == "ruling-only" {
            assert_eq!(entry["enemy_loadout_eligible"], false, "{id}");
        }
        if js::truthy(entry.get("magic_item")) {
            assert_eq!(entry["enemy_loadout_eligible"], false, "{id}");
        }
        if entry["category"] == "armor" {
            assert_eq!(entry["enemy_loadout_eligible"], false, "{id}");
            assert_eq!(entry["corpse_loot_eligible"], true, "{id}");
        }
    }
    for id in ["srd_5_2_1:chain-mail", "srd_5_2_1:ring-mail", "srd_5_2_1:shield", "srd_5_2_1:leather-armor"] {
        assert_eq!(assert_enemy_loadout_item(id, false, false).expect_err("доспех").code, "ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE", "{id}");
    }
}

#[test]
fn humanoid_equipment_is_the_stat_block_weapon() {
    let blocks = bestiary();
    let humanoids: Vec<&String> = blocks.iter().filter(|(id, block)| id.starts_with("srd_5_2_1:") && block["creature_type"] == "humanoid").map(|(id, _)| id).collect();
    assert_eq!(humanoids.len(), 16);
    let mut templates: Vec<&str> = ENEMY_LOADOUT_TEMPLATE_IDS.to_vec();
    templates.sort_unstable();
    assert_eq!(humanoids.iter().map(|id| id.as_str()).collect::<Vec<_>>(), templates);
    for id in humanoids {
        let block = &blocks[id];
        let loadout = loadout(id, block, &format!("{id}-1"), "loadout-sweep");
        assert_eq!(loadout["template_id"], json!(id));
        let weapons: Vec<&Value> = items(&loadout).iter().filter(|item| item["snapshot"]["type"] == "weapon").collect();
        assert!(!weapons.is_empty(), "{id}");
        assert_eq!(weapons.iter().filter(|item| item["equipped"] == true).count(), 1, "{id}: надето ровно одно оружие");
        let equipped = weapons.iter().find(|item| item["equipped"] == true).expect("надетое");
        let primary = &block["action_profiles"][0];
        let slug = equipped["catalog_id"].as_str().and_then(|catalog| catalog.rsplit(':').next()).unwrap_or_default();
        let primary_slug = primary["id"].as_str().unwrap_or_default().trim_end_matches("-melee").trim_end_matches("-ranged");
        assert_eq!(primary_slug, slug, "{id}");
        assert_eq!(equipped["snapshot"]["combat"]["damageType"], primary["damage_type"], "{id}");
        for item in items(&loadout) {
            let entry = catalog_item(item["catalog_id"].as_str().unwrap_or_default()).expect("запись");
            assert_eq!(entry["enemy_loadout_eligible"], true);
            assert_ne!(entry["mechanics_status"], "ruling-only");
            assert_eq!(item["owner"]["actor_id"], json!(format!("{id}-1")));
            assert_eq!(item["origin"]["template_id"], json!(id));
            assert_eq!(item["lootable"], entry["corpse_loot_eligible"]);
        }
    }
}

#[test]
fn archer_ammunition_and_purse_stay_in_range() {
    let blocks = bestiary();
    let block = &blocks["srd_5_2_1:scout"];
    let mut seen = BTreeSet::new();
    for index in 0..40 {
        let loadout = loadout("srd_5_2_1:scout", block, &format!("scout-{index}"), "ammunition-range");
        let arrows = items(&loadout).iter().find(|item| item["catalog_id"] == "srd_5_2_1:arrows-20").expect("стрелы");
        let quantity = arrows["quantity"].as_i64().unwrap_or(0);
        assert!((1..=2).contains(&quantity), "{quantity}");
        seen.insert(quantity);
        let purse = loadout["purse_cp"].as_i64().unwrap_or(-1);
        assert!((5..=30).contains(&purse), "{purse}");
    }
    assert_eq!(seen.len(), 2, "диапазон обязан давать оба значения");
}

#[test]
fn beasts_and_mindless_undead_carry_nothing() {
    let empty_types = ["beast", "ooze", "plant", "construct", "undead", "elemental", "monstrosity", "dragon", "celestial", "giant", "fiend"];
    for (id, block) in bestiary().iter().filter(|(id, _)| id.starts_with("srd_5_2_1:")) {
        if !empty_types.contains(&block["creature_type"].as_str().unwrap_or_default()) {
            continue;
        }
        let loadout = loadout(id, block, &format!("{id}-1"), "empty-sweep");
        assert!(items(&loadout).is_empty(), "{id}");
        assert_eq!(loadout["purse_cp"], 0, "{id}");
        assert_eq!(loadout["template_id"], Value::Null, "{id}");
    }
}

#[test]
fn optional_consumables_are_verified_and_no_armor_ever() {
    let blocks = bestiary();
    let mut optional = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for id in ENEMY_LOADOUT_TEMPLATE_IDS {
        for index in 0..60 {
            for item in items(&loadout(id, &blocks[id], &format!("{id}-{index}"), "consumable-sweep")) {
                let catalog_id = item["catalog_id"].as_str().unwrap_or_default().to_string();
                let entry = catalog_item(&catalog_id).expect("запись");
                assert_ne!(entry["category"], "armor", "{id}: {catalog_id}");
                if ["consumable", "gear", "tool"].contains(&entry["category"].as_str().unwrap_or_default()) {
                    optional.insert(catalog_id.clone());
                }
                seen.insert(catalog_id);
            }
        }
    }
    assert!(!optional.is_empty() && seen.len() > 5);
    for catalog_id in optional {
        assert_eq!(catalog_item(&catalog_id).expect("запись")["mechanics_status"], "verified", "{catalog_id}");
    }
}

#[test]
fn boundary_rejects_ruling_only_magic_and_unverified() {
    assert_eq!(assert_enemy_loadout_item("srd_5_2_1:crowbar", false, false).expect_err("лом").code, "ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE");
    assert_eq!(assert_enemy_loadout_item("srd_5_2_1:ring-of-protection", false, false).expect_err("кольцо").code, "ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE");
    assert_eq!(assert_enemy_loadout_item("srd_5_2_1:not-a-thing", false, false).expect_err("нет").code, "ENEMY_LOADOUT_CATALOG_UNKNOWN");
    assert_eq!(assert_enemy_loadout_item("srd_5_2_1:scimitar", false, false).expect("скимитар")["mechanics_status"], "partial");
    assert_eq!(assert_enemy_loadout_item("srd_5_2_1:scimitar", true, false).expect_err("не verified").code, "ENEMY_LOADOUT_CONSUMABLE_NOT_VERIFIED");
    // Необязательная вещь пропускается, гарантированная — падает громко.
    for id in ["srd_5_2_1:crowbar", "srd_5_2_1:chain-mail", "srd_5_2_1:scimitar", "srd_5_2_1:not-a-thing"] {
        assert!(optional_enemy_loadout_item(id).is_none(), "{id}");
    }
    assert_eq!(optional_enemy_loadout_item("srd_5_2_1:potion-of-healing").expect("зелье")["catalog_id"], "srd_5_2_1:potion-of-healing");
}

#[test]
fn legacy_loadouts_normalize_to_empty_and_drop_garbage() {
    let empty = json!({ "schema_version": 1, "policy_id": ENEMY_LOADOUT_POLICY_ID, "template_id": null, "items": [], "purse_cp": 0 });
    assert_eq!(normalize_enemy_loadout(None), empty);
    assert_eq!(normalize_enemy_loadout(Some(&json!("нет"))), empty);
    let partial = normalize_enemy_loadout(Some(&json!({
        "template_id": "srd_5_2_1:bandit",
        "purse_cp": -50,
        "items": [
            { "catalog_id": "srd_5_2_1:scimitar" },
            {
                "schema_version": 1, "item_instance_id": "partial-item-1", "catalog_id": "srd_5_2_1:dagger",
                "snapshot": { "name": "Кинжал", "type": "weapon", "secret": "не должно проехать" },
                "quantity": 3, "owner": { "kind": "enemy", "actor_id": "partial" },
                "origin": { "kind": "enemy_loadout", "template_id": "srd_5_2_1:bandit" }, "lootable": true,
            },
        ],
    })));
    assert_eq!(partial["purse_cp"], 0);
    assert_eq!(items(&partial).len(), 1, "запись без владельца и происхождения экземпляром не является");
    assert_eq!(partial["items"][0]["item_instance_id"], "partial-item-1");
    assert_eq!(partial["items"][0]["quantity"], 3);
    assert!(partial["items"][0]["snapshot"].get("secret").is_none());
}

#[test]
fn prototype_action_id_fails_like_js() {
    let block = json!({ "action_profiles": [{ "id": "scimitar" }, { "id": "constructor" }] });
    let error = enemy_loadout_for(Some(&json!({ "statBlockId": "srd_5_2_1:bandit", "block": block, "ownerId": "foe", "seed": "x" }))).expect_err("прототип");
    let EnemyLoadoutFailure::Loadout(error) = error else { panic!("ожидался отказ границы") };
    assert_eq!(error.code, "ENEMY_LOADOUT_CATALOG_UNKNOWN");
    assert_eq!(error.message, "Предмета function Object() { [native code] } нет в каталоге");
}
