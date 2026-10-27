//! `item_instances`: эталон JS (`fixtures/item-instances.json`) и проверки
//! экземпляров из `test/enemy-loadouts.test.mjs`.

mod common;

use common::{check, ok, ok_or_null, Args, JsError, Outcome};
use serde_json::{json, Value};
use sk_economy::item_instances::*;
use sk_items::item_catalog::materialize_catalog_item;

fn instance_error(error: ItemInstanceError) -> JsError {
    JsError { name: "ItemInstanceError".into(), code: Some(error.code), message: error.message }
}

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:ITEM_INSTANCE_SCHEMA_VERSION" => ok(json!(ITEM_INSTANCE_SCHEMA_VERSION)),
        "const:ITEM_INSTANCE_ORIGIN_KINDS" => ok(json!(ITEM_INSTANCE_ORIGIN_KINDS)),
        "const:ITEM_INSTANCE_OWNER_KINDS" => ok(json!(ITEM_INSTANCE_OWNER_KINDS)),
        "const:MAX_ITEM_INSTANCE_QUANTITY" => ok(json!(MAX_ITEM_INSTANCE_QUANTITY)),
        "const:MAX_ITEM_SNAPSHOT_NUMBER" => ok(json!(MAX_ITEM_SNAPSHOT_NUMBER)),
        "const:MAX_ITEM_SNAPSHOT_WEIGHT" => ok(json!(MAX_ITEM_SNAPSHOT_WEIGHT)),
        "const:MAX_ITEM_INSTANCE_CHARGES" => ok(json!(MAX_ITEM_INSTANCE_CHARGES)),
        "itemInstanceSnapshot" => item_instance_snapshot(args.get(0)).map(Some).map_err(instance_error),
        "createItemInstance" => create_item_instance(args.get(0)).map(Some).map_err(instance_error),
        "normalizeItemInstance" => ok_or_null(normalize_item_instance(args.get(0))),
        "seededInteger" => ok(json!(seeded_integer(&args.s(0), &args.s(1), sk_core::js::safe_int(args.get(2), 0), sk_core::js::safe_int(args.get(3), 0)))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn item_instances_match_js() {
    let summary = check(include_str!("../fixtures/item-instances.json"), run);
    assert!(summary.calls > 1_500, "{summary:?}");
}

fn create(catalog_id: &str, patch: Value) -> Result<Value, ItemInstanceError> {
    let mut input = json!({
        "catalogId": catalog_id,
        "instanceId": "enemy-1-item-1",
        "owner": { "kind": "enemy", "actor_id": "enemy-1" },
        "origin": { "kind": "enemy_loadout", "template_id": "srd_5_2_1:bandit", "source_id": "encounter-proposal-1" },
    });
    for (key, value) in patch.as_object().cloned().unwrap_or_default() {
        input[key] = value;
    }
    create_item_instance(Some(&input))
}

#[test]
fn instance_carries_snapshot_owner_origin_and_loot_flag() {
    let instance = create("srd_5_2_1:scimitar", json!({ "equipped": true })).expect("экземпляр");
    assert_eq!(instance["schema_version"], ITEM_INSTANCE_SCHEMA_VERSION);
    assert_eq!(instance["item_instance_id"], "enemy-1-item-1");
    assert_eq!(instance["catalog_id"], "srd_5_2_1:scimitar");
    assert_eq!(instance["quantity"], 1);
    assert_eq!(instance["equipped"], true);
    assert_eq!(instance["owner"], json!({ "kind": "enemy", "actor_id": "enemy-1" }));
    assert_eq!(instance["origin"], json!({ "kind": "enemy_loadout", "template_id": "srd_5_2_1:bandit", "source_id": "encounter-proposal-1" }));
    assert_eq!(instance["lootable"], true);
    assert_eq!(instance["snapshot"]["name"], "Скимитар");
    assert_eq!(instance["snapshot"]["mechanics_status"], "partial");
    assert_eq!(instance["snapshot"]["combat"]["damage"], "1d6");

    assert_eq!(create("srd_5_2_1:not-a-thing", json!({})).expect_err("нет в каталоге").code, "ITEM_INSTANCE_CATALOG_UNKNOWN");
    assert_eq!(create("srd_5_2_1:scimitar", json!({ "owner": { "kind": "hero", "actor_id": "hero-1" } })).expect_err("герой").code, "ITEM_INSTANCE_OWNER_REQUIRED");
    assert_eq!(create("srd_5_2_1:scimitar", json!({ "origin": { "kind": "made-up" } })).expect_err("происхождение").code, "ITEM_INSTANCE_ORIGIN_REQUIRED");
    // Неисполнимая вещь добычей не становится, даже созданная вручную.
    assert_eq!(create("srd_5_2_1:crowbar", json!({})).expect("лом")["lootable"], false);
}

#[test]
fn snapshot_matches_catalog_and_survives_rebalance() {
    let weapon = create("srd_5_2_1:shortsword", json!({})).expect("меч");
    let materialized = materialize_catalog_item("srd_5_2_1:shortsword", Some(&json!({})));
    for (key, value) in weapon["snapshot"].as_object().expect("снимок") {
        assert_eq!(value, &materialized[key], "{key}");
    }
    let mut rebalanced = weapon.clone();
    rebalanced["snapshot"]["name"] = json!("Старое имя");
    rebalanced["snapshot"]["combat"]["damage"] = json!("1d99");
    let normalized = normalize_item_instance(Some(&rebalanced)).expect("экземпляр");
    assert_eq!(normalized["snapshot"]["name"], "Старое имя");
    assert_eq!(normalized["snapshot"]["combat"]["damage"], "1d99");
}

#[test]
fn untrusted_snapshot_is_bounded() {
    let instance = normalize_item_instance(Some(&json!({
        "schema_version": 1,
        "item_instance_id": "hostile-1",
        "catalog_id": "srd_5_2_1:dagger",
        "quantity": 1,
        "owner": { "kind": "enemy", "actor_id": "enemy-1" },
        "origin": { "kind": "enemy_loadout", "template_id": "srd_5_2_1:bandit" },
        "lootable": true,
        "snapshot": {
            "name": "Кинжал", "type": "armor-of-my-choosing", "weight": -1e9, "base_price_cp": 1e15,
            "image": "https://evil.example/steal.png", "mechanics_status": "totally-verified", "rarity": "божественный",
            "catalog_schema_version": 999, "combat": { "kind": "melee", "armor": { "base": 1e15 } },
            "passive_effects": [{ "armor_class_bonus": 50 }, { "schema_version": 1, "effect_id": "forged", "group": "forged", "armor_class_bonus": 5_000 }],
            "charges": { "current": 1e9, "max": 1e9 },
            "recharge": { "schema_version": 1, "trigger": "always", "formula": "99d99" },
            "secret": "не должно проехать",
        },
    })))
    .expect("экземпляр");
    let snapshot = &instance["snapshot"];
    assert!(snapshot.get("secret").is_none());
    assert_eq!(snapshot["type"], "other");
    assert_eq!(snapshot["weight"], 0);
    assert_eq!(snapshot["base_price_cp"], MAX_ITEM_SNAPSHOT_NUMBER);
    assert!(snapshot.get("image").is_none());
    assert!(snapshot.get("mechanics_status").is_none());
    assert_eq!(snapshot["rarity"], "обычный");
    assert_eq!(snapshot["catalog_schema_version"], "999");
    assert!(snapshot.get("recharge").is_none());
    assert_eq!(snapshot["charges"], json!({ "current": MAX_ITEM_INSTANCE_CHARGES, "max": MAX_ITEM_INSTANCE_CHARGES }));
    assert_eq!(snapshot["combat"]["armor"]["base"], MAX_ITEM_SNAPSHOT_NUMBER);
    assert_eq!(snapshot["passive_effects"].as_array().map(Vec::len), Some(1));
    assert_eq!(snapshot["passive_effects"][0]["armor_class_bonus"], 100);

    let local = |image: &str| {
        normalize_item_instance(Some(&json!({
            "item_instance_id": "local-1", "catalog_id": "srd_5_2_1:dagger",
            "owner": { "kind": "enemy", "actor_id": "enemy-1" }, "origin": { "kind": "enemy_loadout" },
            "snapshot": { "image": image },
        })))
        .expect("экземпляр")["snapshot"]
            .get("image")
            .cloned()
    };
    assert_eq!(local("/assets/items/item-srd-5-2-1-dagger.png"), Some(json!("/assets/items/item-srd-5-2-1-dagger.png")));
    for image in ["/assets/items/../../etc/passwd.png", "/generated/items/x.svg", "javascript:alert(1)", "//evil.example/x.png"] {
        assert_eq!(local(image), None, "{image}");
    }
}

#[test]
fn normalization_is_a_fixed_point() {
    for catalog_id in ["srd_5_2_1:scimitar", "srd_5_2_1:arrows-20", "srd_5_2_1:healers-kit", "srd_5_2_1:potion-of-healing", "srd_5_2_1:ring-of-protection"] {
        let created = create(catalog_id, json!({ "instanceId": format!("fixed-point-{catalog_id}"), "quantity": 2 })).expect("экземпляр");
        let once = normalize_item_instance(Some(&created)).expect("экземпляр");
        assert_eq!(serde_json::to_string(&once).ok(), serde_json::to_string(&created).ok(), "{catalog_id}");
        assert_eq!(normalize_item_instance(Some(&once)), Some(created.clone()), "{catalog_id}");
        assert!(created["snapshot"].get("properties").is_none(), "дубль описания в снимке не хранится");
        assert!(created["snapshot"]["description"].as_str().is_some_and(|text| !text.is_empty()), "{catalog_id}");
    }
}

#[test]
fn prototype_keys_are_unknown_catalog_ids() {
    // Ключ прототипа — неизвестный код каталога, как в JS после `Object.hasOwn`.
    let error = item_instance_snapshot(Some(&json!("constructor"))).expect_err("прототип");
    assert_eq!((error.code.as_str(), error.message.as_str()), ("ITEM_INSTANCE_CATALOG_UNKNOWN", "Предмета constructor нет в каталоге"));
    let error = create("toString", json!({ "instanceId": "" })).expect_err("прототип");
    assert_eq!((error.code.as_str(), error.message.as_str()), ("ITEM_INSTANCE_CATALOG_UNKNOWN", "Предмета toString нет в каталоге"));
}
