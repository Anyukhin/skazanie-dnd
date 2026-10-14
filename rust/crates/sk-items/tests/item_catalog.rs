//! Сверка `item_catalog` с эталонами JS (`fixtures/item-catalog.json`,
//! `fixtures/item-catalog-inventories.json`, генератор —
//! `fixtures/gen-item-catalog.mjs`) и перенесённые проверки самого каталога из
//! `test/item-catalog.test.mjs`, `test/item-origin.test.mjs`,
//! `test/hero-ammunition.test.mjs`, `test/encounter-magic-loot.test.mjs`,
//! `test/consumable-zones.test.mjs`, `test/magic-items-wave2.test.mjs`,
//! `test/scenario-items.test.mjs`.

mod common;

use common::{check, ok, ok_or_null, Args, Outcome, FUNCTION};
use serde_json::{json, Value};
use sk_core::js;
use sk_items::item_catalog as m;

fn ruleset(args: &Args) -> String {
    args.option(1, "rulesetId").map_or_else(String::new, |value| js::string(Some(value)))
}

/// Общий разбор вызовов обоих эталонов.
fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:ITEM_CATALOG_SCHEMA_VERSION" => ok(json!(m::ITEM_CATALOG_SCHEMA_VERSION)),
        "const:ITEM_CATALOG_SOURCE" => ok(m::ITEM_CATALOG_SOURCE.clone()),
        "const:ITEM_MECHANICS_STATUSES" => ok(json!(m::ITEM_MECHANICS_STATUSES)),
        "const:ITEM_ORIGIN_KINDS" => ok(json!(m::ITEM_ORIGIN_KINDS)),
        "const:DEFAULT_ITEM_ORIGIN_KIND" => ok(json!(m::DEFAULT_ITEM_ORIGIN_KIND)),
        "const:PRIVATE_ITEM_ORIGIN_KINDS" => ok(json!(m::PRIVATE_ITEM_ORIGIN_KINDS)),
        "const:ITEM_ORIGIN_LABELS" => ok(m::item_origin_labels_json()),
        "const:ITEM_AVAILABILITY_CHANNELS" => ok(json!(m::ITEM_AVAILABILITY_CHANNELS)),
        "const:ITEM_RECHARGE_SCHEMA_VERSION" => ok(json!(m::ITEM_RECHARGE_SCHEMA_VERSION)),
        "const:AMMUNITION_CATALOG_BY_WEAPON" => ok(m::ammunition_catalog_by_weapon_json()),
        "const:ITEM_CATALOG" => ok(m::ITEM_CATALOG.clone()),
        "const:SCENARIO_ITEM_CATALOG" => ok(m::SCENARIO_ITEM_CATALOG.clone()),
        "const:ITEM_SHOP_CATALOG_IDS" => ok(json!(*m::ITEM_SHOP_CATALOG_IDS)),
        "const:ITEM_MAGIC_LOOT_CATALOG_IDS" => ok(json!(*m::ITEM_MAGIC_LOOT_CATALOG_IDS)),
        "const:ITEM_LOOT_CATALOG_IDS" => ok(json!(*m::ITEM_LOOT_CATALOG_IDS)),
        "const:ITEM_CRAFTING_CATALOG_IDS" => ok(json!(*m::ITEM_CRAFTING_CATALOG_IDS)),
        "const:SRD_EQUIPMENT_CATALOG" => ok(m::SRD_EQUIPMENT_CATALOG.clone()),
        "const:ITEM_ARMOR_PROFILES" => ok(m::ITEM_ARMOR_PROFILES.clone()),
        "catalogItem" => {
            let id = args.s(0);
            match m::catalog_item(&id) {
                Some(entry) => ok(entry.clone()),
                // `ITEM_CATALOG['__proto__']` — сам `Object.prototype`, в JSON это `{}`.
                None if id == "__proto__" => ok(json!({})),
                None if m::catalog_item_truthy(&id) => ok(json!(FUNCTION)),
                None => ok(Value::Null),
            }
        }
        "catalogItemTruthy" => ok(json!(m::catalog_item_truthy(&args.s(0)))),
        "catalogIdsFor" => ok(json!(m::catalog_ids_for(&args.s(0)))),
        "itemLifecycleProfile" => ok_or_null(m::item_lifecycle_profile(&args.s(0), &ruleset(args))),
        "itemRechargeProfile" => ok_or_null(m::item_recharge_profile(&args.s(0))),
        "ammunitionBundleAmount" => ok(json!(m::ammunition_bundle_amount(&args.s(0)))),
        "ammunitionCatalogIdForWeapon" => ok_or_null(m::ammunition_catalog_id_for_weapon(&args.s(0)).map(|id| json!(id))),
        "ammunitionCapacity" => ok(json!(m::ammunition_capacity(args.get(0)))),
        "ammunitionShotsLeft" => ok(json!(m::ammunition_shots_left(args.get(0)))),
        "offHandWeaponAllowed" => ok(json!(m::off_hand_weapon_allowed(args.get(0)))),
        "normalizeItemRechargeProfile" => ok_or_null(m::normalize_item_recharge_profile(args.get(0))),
        "normalizeItemOriginKind" => {
            let fallback = args.get(1).map_or_else(|| m::DEFAULT_ITEM_ORIGIN_KIND.to_string(), |value| js::s(Some(value)));
            ok(json!(m::normalize_item_origin_kind(args.get(0), &fallback)))
        }
        "materializeCatalogItem" => ok(m::materialize_catalog_item(&args.s(0), args.get(1))),
        "hydrateCatalogItem" => ok(m::hydrate_catalog_item(args.get(0))),
        "itemViewerCapabilities" => ok_or_null(m::item_viewer_capabilities(args.get(0), &ruleset(args))),
        // JS падает `TypeError`: неитерируемый список свойств оружия. Rust
        // считает такой список пустым — вещь не годится во вторую руку.
        "offHandWeaponAllowed~TypeError" => {
            assert!(!m::off_hand_weapon_allowed(args.get(0)), "{:?}", args.get(0));
            ok(Value::Null)
        }
        // JS падает `TypeError`: свойство прототипа вместо записи каталога.
        // Rust считает вещь некаталожной и возвращает её копию.
        "hydrateCatalogItem~TypeError" => {
            assert_eq!(m::hydrate_catalog_item(args.get(0)), args.get(0).cloned().unwrap_or(Value::Null));
            ok(Value::Null)
        }
        "materializeCatalogItem~TypeError" => {
            assert_eq!(m::materialize_catalog_item(&args.s(0), args.get(1)), args.get(1).cloned().unwrap_or(Value::Null));
            ok(Value::Null)
        }
        other => panic!("нет сверки для {other}"),
    }
}

#[test]
fn catalog_matches_js() {
    let count = check(include_str!("../fixtures/item-catalog.json"), run);
    assert!(count > 2_500, "{count}");
}

#[test]
fn inventories_match_js() {
    let count = check(include_str!("../fixtures/item-catalog-inventories.json"), run);
    assert!(count > 5_000, "{count}");
}

const EXPECTED_ATTRIBUTION: &str = "This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.";

const SHOP_PRICES: [(&str, i64); 50] = [
    ("srd_5_2_1:dagger", 200),
    ("srd_5_2_1:longsword", 1_500),
    ("srd_5_2_1:longbow", 5_000),
    ("srd_5_2_1:shortbow", 2_500),
    ("srd_5_2_1:leather-armor", 1_000),
    ("srd_5_2_1:shield", 1_000),
    ("srd_5_2_1:explorers-pack", 1_000),
    ("srd_5_2_1:potion-of-healing", 5_000),
    ("srd_5_2_1:rations-one-day", 50),
    ("srd_5_2_1:rope-hempen-50-feet", 100),
    ("srd_5_2_1:torch", 1),
    ("srd_5_2_1:arrows-20", 100),
    ("srd_5_2_1:component-pouch", 2_500),
    ("srd_5_2_1:arcane-focus-crystal", 1_000),
    ("srd_5_2_1:arcane-focus-orb", 2_000),
    ("srd_5_2_1:arcane-focus-rod", 1_000),
    ("srd_5_2_1:arcane-focus-staff", 500),
    ("srd_5_2_1:arcane-focus-wand", 1_000),
    ("srd_5_2_1:druidic-focus-mistletoe", 100),
    ("srd_5_2_1:druidic-focus-totem", 100),
    ("srd_5_2_1:druidic-focus-wooden-staff", 500),
    ("srd_5_2_1:druidic-focus-yew-wand", 1_000),
    ("srd_5_2_1:holy-symbol-amulet", 500),
    ("srd_5_2_1:holy-symbol-emblem", 500),
    ("srd_5_2_1:holy-symbol-reliquary", 500),
    ("srd_5_2_1:diamond-50gp", 5_000),
    ("srd_5_2_1:material-summon-beast-200gp", 20_000),
    ("srd_5_2_1:material-summon-undead-300gp", 30_000),
    ("srd_5_2_1:material-summon-shadowspawn-300gp", 30_000),
    ("srd_5_2_1:material-summon-fey-300gp", 30_000),
    ("srd_5_2_1:material-shadow-of-moil-150gp", 15_000),
    ("srd_5_2_1:material-summon-aberration-400gp", 40_000),
    ("srd_5_2_1:material-summon-construct-400gp", 40_000),
    ("srd_5_2_1:material-summon-elemental-400gp", 40_000),
    ("srd_5_2_1:material-summon-draconic-spirit-500gp", 50_000),
    ("srd_5_2_1:material-summon-celestial-500gp", 50_000),
    ("srd_5_2_1:material-dawn-100gp", 10_000),
    ("srd_5_2_1:material-circle-of-death-500gp", 50_000),
    ("srd_5_2_1:material-summon-fiend-600gp", 60_000),
    ("srd_5_2_1:material-diamond-dust-100gp", 10_000),
    ("srd_5_2_1:bagpipes", 3_000),
    ("srd_5_2_1:drum", 600),
    ("srd_5_2_1:dulcimer", 2_500),
    ("srd_5_2_1:flute", 200),
    ("srd_5_2_1:lute", 3_500),
    ("srd_5_2_1:lyre", 3_000),
    ("srd_5_2_1:horn", 300),
    ("srd_5_2_1:pan-flute", 1_200),
    ("srd_5_2_1:shawm", 200),
    ("srd_5_2_1:viol", 3_000),
];

fn entry(id: &str) -> &'static Value {
    m::catalog_item(id).unwrap_or_else(|| panic!("нет записи {id}"))
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values
}

/// Проверки манифеста, которые JS делает при импорте модуля: ровно 145
/// записей, уникальные id, список снаряжения противника ссылается только на
/// известные записи.
#[test]
fn manifest_has_agreed_entries_and_full_provenance() {
    let catalog = m::item_catalog();
    assert_eq!(catalog.len(), 145);
    let mut sections = std::collections::BTreeMap::new();
    for entry in catalog.values() {
        *sections.entry(entry["manifest_section"].as_str().unwrap_or_default().to_string()).or_insert(0) += 1;
    }
    let expected: std::collections::BTreeMap<String, i32> = [
        ("weapon", 38),
        ("armor", 13),
        ("ammunition", 5),
        ("artisan-tool", 17),
        ("other-tool", 1),
        ("practical-gear", 23),
        ("spellcasting-component", 24),
        ("spell-material", 14),
        ("magic-item", 10),
    ]
    .into_iter()
    .map(|(section, count)| (section.to_string(), count))
    .collect();
    assert_eq!(sections, expected);
    assert_eq!(m::ITEM_MECHANICS_STATUSES, ["verified", "partial", "ruling-only"]);
    assert_eq!(m::ITEM_AVAILABILITY_CHANNELS, ["shop", "loot", "magic_loot", "crafting"]);
    assert_eq!(m::ITEM_CATALOG_SCHEMA_VERSION, "skazanie:item-catalog:v1");
    assert_eq!(m::ITEM_CATALOG_SOURCE["attribution"], json!(EXPECTED_ATTRIBUTION));
    let id_pattern = sk_core::re!(r"^srd_5_2_1:[a-z0-9]+(?:-[a-z0-9]+)*$", "u");
    for (catalog_id, entry) in catalog {
        assert_eq!(entry["catalog_id"], json!(catalog_id));
        assert!(sk_core::text::test(id_pattern, catalog_id), "{catalog_id}");
        assert!(m::ITEM_MECHANICS_STATUSES.contains(&entry["mechanics_status"].as_str().unwrap_or_default()));
        assert!(!entry["limitation"].as_str().unwrap_or_default().is_empty());
        let price = entry["price_cp"].as_i64().expect("цена — целое");
        assert!(price >= 0);
        assert_eq!(entry["base_price_cp"], entry["price_cp"]);
        assert!(entry["weight"].as_f64().is_some_and(|weight| weight >= 0.0));
        assert!(entry["source_page"].as_i64().is_some_and(|page| page > 0));
        let mut channels: Vec<&str> = entry["availability"].as_object().expect("каналы").keys().map(String::as_str).collect();
        channels.sort_unstable();
        assert_eq!(channels, ["crafting", "loot", "magic_loot", "shop"]);
        assert!(entry["availability"].as_object().expect("каналы").values().all(Value::is_boolean));
        let section = entry["manifest_section"].as_str().unwrap_or_default();
        let provenance = &entry["provenance"];
        if section == "spellcasting-component" || section == "spell-material" {
            let url = provenance["source_url"].as_str().unwrap_or_default();
            assert!(url.contains("5e14.dnd.su") || url.contains("www.dnd.su/spells"), "{catalog_id}");
            assert!(provenance["source_version"].as_str().unwrap_or_default().contains("D&D 5e 2014"));
            let secondary = provenance["secondary_source_url"].as_str().unwrap_or_default();
            assert!(secondary.contains("basic-rules-2014/spellcasting") || secondary.contains("basic-rules-2014/equipment"));
            assert!(provenance["attribution"].as_str().unwrap_or_default().contains("парафраз"));
        } else {
            assert_eq!(provenance["source_url"], m::ITEM_CATALOG_SOURCE["source_url"]);
            assert_eq!(provenance["source_sha256"], m::ITEM_CATALOG_SOURCE["source_sha256"]);
            assert_eq!(provenance["attribution"], json!(EXPECTED_ATTRIBUTION));
        }
        assert_eq!(provenance["source_page"], entry["source_page"]);
        for hook in entry["crafting"]["hooks"].as_array().expect("hooks") {
            assert!(catalog.contains_key(hook.as_str().unwrap_or_default()), "{catalog_id}: неизвестный crafting hook {hook}");
        }
    }
    let herbalism = entry("srd_5_2_1:herbalism-kit");
    assert_eq!(herbalism["crafting"]["hooks"], json!(["srd_5_2_1:antitoxin", "srd_5_2_1:healers-kit", "srd_5_2_1:potion-of-healing"]));
    assert_eq!(herbalism["price_cp"], json!(500));
    assert_eq!(herbalism["weight"], json!(3));
    assert_eq!(herbalism["tool"]["ability"], json!("Интеллект"));
    assert_eq!(herbalism["source_page"], json!(94));
    assert_eq!(entry("srd_5_2_1:smiths-tools")["source_pages"], json!([93, 94]));
    assert_eq!(entry("srd_5_2_1:tinkers-tools")["source_page"], json!(94));
    assert_eq!(entry("srd_5_2_1:potion-of-healing")["source_pages"], json!([95, 99]));
    assert_eq!(entry("srd_5_2_1:potion-of-healing")["mechanics_source_page"], json!(99));
    let verified = sorted(catalog.values().filter(|entry| entry["mechanics_status"] == "verified").map(|entry| js::s(entry.get("catalog_id"))).collect());
    assert_eq!(
        verified,
        [
            "srd_5_2_1:acid",
            "srd_5_2_1:alchemists-fire",
            "srd_5_2_1:caltrops",
            "srd_5_2_1:healers-kit",
            "srd_5_2_1:holy-water",
            "srd_5_2_1:oil-flask",
            "srd_5_2_1:poison-basic",
            "srd_5_2_1:potion-of-healing",
        ]
    );
    let sword = entry("srd_5_2_1:longsword-plus-1");
    assert_eq!(sword["source_pages"], json!([91, 206, 253]));
    assert_eq!(sword["price_cp"], json!(41_500));
    assert_eq!(sword["magic_item"]["bonus"], json!(1));
    assert_eq!(sword["attunement"]["required"], json!(false));
    let ring = entry("srd_5_2_1:ring-of-protection");
    assert_eq!(ring["price_cp"], json!(400_000));
    assert_eq!(ring["type"], json!("other"));
    assert_eq!(ring["rarity"], json!("редкий"));
    assert_eq!(ring["magic_item"]["rarity"], json!("rare"));
    assert_eq!(ring["attunement"]["required"], json!(true));
    assert_eq!(ring["lifecycle"]["equip_slot"], json!("ring-protection"));
    assert_eq!(ring["availability"], json!({ "shop": false, "loot": false, "magic_loot": true, "crafting": false }));
    let fire = entry("srd_5_2_1:ring-of-fire-resistance");
    assert_eq!(fire["magic_item"]["variant"], json!("fire"));
    assert_eq!(fire["attunement"]["required"], json!(false));
    assert_eq!(fire["availability"], json!({ "shop": false, "loot": false, "magic_loot": true, "crafting": false }));
    let wand = entry("srd_5_2_1:wand-of-magic-missiles");
    assert_eq!(wand["charges"], json!({ "current": 7, "max": 7 }));
    assert_eq!(wand["recharge"], json!({ "schema_version": 1, "trigger": "dawn", "formula": "1d6+1" }));
    assert_eq!(
        wand["use"],
        json!({
            "kind": "cast_spell",
            "spell_id": "magic-missile",
            "min_charges_to_spend": 1,
            "max_charges_to_spend": 3,
            "default_charges_to_spend": 1,
            "combat_action": "action",
            "combat_only": true,
            "requires_equipped": true,
            "requires_line_of_sight": true,
            "range_feet": 120,
            "target": "enemy",
        })
    );
    assert_eq!(wand["source_pages"], json!([145, 205, 250]));
    assert_eq!(wand["availability"], json!({ "shop": false, "loot": false, "magic_loot": false, "crafting": false }));
}

#[test]
fn enemy_loadout_gear_references_known_entries_and_skips_armor() {
    let catalog = m::item_catalog();
    for entry in catalog.values() {
        if entry["enemy_loadout_eligible"] == json!(true) {
            assert_ne!(entry["category"], json!("armor"), "{}", entry["catalog_id"]);
            assert!(entry.get("magic_item").is_none(), "{}", entry["catalog_id"]);
            assert_ne!(entry["mechanics_status"], json!("ruling-only"));
        }
        if entry["mechanics_status"] == json!("ruling-only") {
            assert_eq!(entry["corpse_loot_eligible"], json!(false));
        }
    }
    for id in ["srd_5_2_1:acid", "srd_5_2_1:torch", "srd_5_2_1:healers-kit"] {
        assert_eq!(entry(id)["enemy_loadout_eligible"], json!(true), "{id}");
    }
    assert_eq!(entry("srd_5_2_1:chain-mail")["enemy_loadout_eligible"], json!(false));
    assert_eq!(entry("srd_5_2_1:chain-mail")["corpse_loot_eligible"], json!(true));
    assert_eq!(entry("srd_5_2_1:longsword-plus-1")["enemy_loadout_eligible"], json!(false));
}

#[test]
fn shop_loot_and_crafting_use_separate_fail_closed_allowlists() {
    let shop: Vec<String> = m::ITEM_SHOP_CATALOG_IDS.iter().map(|id| id.to_string()).collect();
    assert_eq!(sorted(shop), sorted(SHOP_PRICES.iter().map(|(id, _)| id.to_string()).collect()));
    assert_eq!(m::ITEM_LOOT_CATALOG_IDS.len(), 30);
    assert!(m::ITEM_CRAFTING_CATALOG_IDS.is_empty());
    assert_eq!(m::catalog_ids_for("shop"), *m::ITEM_SHOP_CATALOG_IDS);
    assert_eq!(m::catalog_ids_for("loot"), *m::ITEM_LOOT_CATALOG_IDS);
    assert!(m::catalog_ids_for("crafting").is_empty());
    assert!(m::catalog_ids_for("unknown").is_empty());
    for (id, price) in SHOP_PRICES {
        assert_eq!(entry(id)["base_price_cp"], json!(price), "{id}");
        assert_ne!(entry(id)["mechanics_status"], json!("ruling-only"));
    }
    for id in ["srd_5_2_1:pistol", "srd_5_2_1:longsword-plus-1", "srd_5_2_1:ring-of-protection", "srd_5_2_1:wand-of-magic-missiles"] {
        assert!(!m::ITEM_SHOP_CATALOG_IDS.contains(&id), "{id}");
        assert!(!m::ITEM_LOOT_CATALOG_IDS.contains(&id), "{id}");
        assert!(!m::ITEM_CRAFTING_CATALOG_IDS.contains(&id), "{id}");
    }
    for id in m::ITEM_MAGIC_LOOT_CATALOG_IDS.iter() {
        assert_eq!(entry(id)["availability"]["shop"], json!(false));
        assert_eq!(entry(id)["availability"]["crafting"], json!(false));
    }
    for id in ["srd_5_2_1:wand-of-magic-missiles", "srd_5_2_1:flame-tongue-longsword"] {
        assert!(!m::ITEM_MAGIC_LOOT_CATALOG_IDS.contains(&id), "{id} — награда за сюжет");
        assert_eq!(entry(id)["availability"]["magic_loot"], json!(false));
    }
}

#[test]
fn materialization_makes_known_mechanics_authoritative() {
    let item = m::materialize_catalog_item(
        "srd_5_2_1:longbow",
        Some(&json!({
            "id": "hero-bow",
            "quantity": 3,
            "equipped": true,
            "attuned_to": "hero",
            "name": "Лук следопыта",
            "weight": 999,
            "type": "consumable",
            "base_price_cp": 1,
            "combat": { "kind": "melee", "damage": "99d99", "damageType": "force", "normalRange": 5 },
            "secret": "не переносить",
        })),
    );
    assert_eq!(item["id"], json!("hero-bow"));
    assert_eq!(item["quantity"], json!(3));
    assert_eq!(item["equipped"], json!(true));
    assert_eq!(item["attuned_to"], json!("hero"));
    assert_eq!(item["name"], json!("Лук следопыта"));
    assert_eq!(item["catalog_schema_version"], json!(m::ITEM_CATALOG_SCHEMA_VERSION));
    assert_eq!(item["weight"], json!(2));
    assert_eq!(item["type"], json!("weapon"));
    assert_eq!(item["base_price_cp"], json!(5_000));
    assert_eq!(
        item["combat"],
        json!({
            "abilities": ["dex"],
            "properties": ["ammunition", "heavy", "two-handed"],
            "kind": "ranged",
            "ability": "dex",
            "damage": "1d8",
            "damageType": "piercing",
            "normalRange": 150,
            "longRange": 600,
            "twoHanded": true,
            "ammunition": true,
            "modes": [{
                "id": "ranged",
                "kind": "ranged",
                "ability": "dex",
                "damage": "1d8",
                "damageType": "piercing",
                "normalRange": 150,
                "longRange": 600,
                "twoHanded": true,
                "ammunition": true,
            }],
        })
    );
    assert!(item.get("secret").is_none());

    let custom = json!({ "id": "custom-compass", "catalog_id": "custom:compass", "name": "Личный компас", "type": "tool", "quantity": 1, "weight": 0.25, "combat": { "kind": "ruling" } });
    assert_eq!(m::hydrate_catalog_item(Some(&custom)), custom);

    let used = m::materialize_catalog_item("srd_5_2_1:healers-kit", Some(&json!({ "id": "used-kit", "charges": { "current": 3, "max": 999 } })));
    assert_eq!(used["charges"], json!({ "current": 3, "max": 10 }));
    assert_eq!(m::item_lifecycle_profile("srd_5_2_1:healers-kit", "").expect("профиль")["stackable"], json!(false));
    assert_eq!(
        m::materialize_catalog_item("srd_5_2_1:healers-kit", Some(&json!({ "charges": { "current": 99 } })))["charges"],
        json!({ "current": 10, "max": 10 })
    );

    let ring = m::materialize_catalog_item(
        "srd_5_2_1:ring-of-protection",
        Some(&json!({
            "id": "forged-ring",
            "type": "weapon",
            "rarity": "сюжетный",
            "passive_effects": [{ "schema_version": 1, "effect_id": "forged", "group": "forged", "armor_class_bonus": 99, "saving_throw_bonus": 99 }],
        })),
    );
    assert_eq!(ring["type"], json!("other"));
    assert_eq!(ring["rarity"], json!("редкий"));
    assert_eq!(ring["requires_attunement"], json!(true));
    assert_eq!(ring["passive_effects"], entry("srd_5_2_1:ring-of-protection")["passive_effects"]);
}

#[test]
fn lifecycle_profiles_follow_catalog_and_ruleset() {
    let leather = m::item_lifecycle_profile("srd_5_2_1:leather-armor", "").expect("кожаный");
    assert_eq!(leather["equip_slot"], json!("body"));
    assert_eq!(leather["armor"], json!({ "base": 11, "dexterity": true, "dexterity_cap": null }));
    assert_eq!(m::item_lifecycle_profile("srd_5_2_1:shield", "").expect("щит")["equip_slot"], json!("off_hand"));
    assert_eq!(m::item_lifecycle_profile("srd_5_2_1:shield", "").expect("щит")["armor_bonus"], json!(2));
    assert_eq!(
        m::item_lifecycle_profile("srd_5_2_1:potion-of-healing", "").expect("зелье")["use"],
        json!({ "kind": "healing", "expression": "2d4+2", "consumes": 1, "combat_action": "bonus_action", "range_feet": 5, "target": "party" })
    );
    assert_eq!(
        m::item_lifecycle_profile("srd_5_2_1:rations-one-day", "").expect("паёк")["use"],
        json!({ "kind": "ration", "consumes": 1, "combat_action": null, "range_feet": 0, "target": "self" })
    );
    // В редакции 2014 зелье пьётся основным действием.
    assert_eq!(m::item_lifecycle_profile("srd_5_2_1:potion-of-healing", "dnd_5e_2014").expect("зелье")["use"]["combat_action"], json!("action"));
    assert!(m::item_lifecycle_profile("custom:compass", "").is_none());
    // Свойство прототипа: JS находит функцию и отдаёт пустой профиль.
    assert_eq!(m::item_lifecycle_profile("constructor", "").expect("прототип"), json!({ "equippable": false, "stackable": true, "requires_attunement": false }));
    assert!(m::catalog_item("constructor").is_none());
    assert!(m::catalog_item_truthy("__proto__"));
}

#[test]
fn item_origin_vocabulary_is_closed() {
    for kind in m::ITEM_ORIGIN_KINDS {
        assert!(m::item_origin_label(kind).is_some_and(|label| !label.is_empty()), "у вида {kind} нет подписи");
    }
    let mut labels: Vec<&str> = m::ITEM_ORIGIN_LABELS.iter().map(|(kind, _)| *kind).collect();
    let mut kinds = m::ITEM_ORIGIN_KINDS.to_vec();
    labels.sort_unstable();
    kinds.sort_unstable();
    assert_eq!(labels, kinds);
    for kind in m::PRIVATE_ITEM_ORIGIN_KINDS {
        assert!(m::ITEM_ORIGIN_KINDS.contains(&kind));
    }
    let default = m::DEFAULT_ITEM_ORIGIN_KIND;
    assert_eq!(m::normalize_item_origin_kind(Some(&json!("stolen")), default), "stolen");
    assert_eq!(m::normalize_item_origin_kind(Some(&json!("украдено")), default), default, "подпись — не ключ");
    assert_eq!(m::normalize_item_origin_kind(None, default), "unknown");
    assert_eq!(m::normalize_item_origin_kind(Some(&json!({ "kind": "stolen" })), default), "unknown", "объект вместо ключа не проходит");
    assert_eq!(m::normalize_item_origin_kind(Some(&json!("")), "gifted"), "gifted");
}

fn quiver(extra: Value) -> Value {
    m::materialize_catalog_item("srd_5_2_1:arrows-20", Some(&js::spread(&json!({ "id": "quiver", "quantity": 1 }), extra)))
}

#[test]
fn ammunition_is_counted_from_catalog_bundles() {
    assert_eq!(m::ammunition_catalog_id_for_weapon("srd_5_2_1:longbow"), Some("srd_5_2_1:arrows-20"));
    assert_eq!(m::ammunition_catalog_id_for_weapon("srd_5_2_1:longsword"), None);
    assert_eq!(m::ammunition_bundle_amount("srd_5_2_1:needles-50"), 50);
    assert_eq!(m::ammunition_bundle_amount("custom:stone"), 1);
    assert_eq!(m::ammunition_shots_left(Some(&quiver(json!({})))), 20);
    // 19 своих плюс 20 купленных: прирост ёмкости ещё не стрелян.
    let restocked = quiver(json!({ "quantity": 2, "charges": { "current": 19, "max": 20 } }));
    assert_eq!(m::ammunition_shots_left(Some(&restocked)), 39);
    assert_eq!(m::ammunition_capacity(Some(&restocked)), 40);
    assert_eq!(m::ammunition_shots_left(None), 0);

    let caps = m::item_viewer_capabilities(Some(&quiver(json!({ "charges": { "current": 7, "max": 20 } }))), "").expect("колчан");
    assert_eq!(caps["ammunition"], json!({ "role": "ammunition", "shots": 7, "per_bundle": 20, "unit": "стрела" }));
    assert_eq!(m::item_viewer_capabilities(Some(&quiver(json!({}))), "").expect("колчан")["ammunition"]["shots"], json!(20));
    let bow = js::spread(&m::materialize_catalog_item("srd_5_2_1:shortbow", Some(&json!({ "id": "bow" }))), json!({ "equipped": true }));
    assert_eq!(m::item_viewer_capabilities(Some(&bow), "").expect("лук")["ammunition"], json!({ "role": "weapon", "catalog_id": "srd_5_2_1:arrows-20", "unit": "стрела" }));
    let sword = m::materialize_catalog_item("srd_5_2_1:longsword", Some(&json!({ "id": "sword" })));
    assert!(m::item_viewer_capabilities(Some(&sword), "").expect("меч").get("ammunition").is_none(), "ближнее оружие о боеприпасах не рассказывает");
}

#[test]
fn viewer_capabilities_describe_use_modes_and_activation() {
    let item = |id: &str| m::materialize_catalog_item(id, Some(&json!({ "id": "x", "quantity": 1 })));
    let caps = |id: &str| m::item_viewer_capabilities(Some(&item(id)), "").expect("каталог");
    assert_eq!(caps("srd_5_2_1:caltrops")["use"]["point_target"], json!(true));
    assert_eq!(caps("srd_5_2_1:oil-flask")["use"]["use_modes"], json!(["target", "spill"]));
    assert_eq!(caps("srd_5_2_1:oil-flask")["use"]["point_target"], json!(true));
    assert_eq!(caps("srd_5_2_1:poison-basic")["use"]["requires_weapon"], json!(true));
    assert_eq!(caps("srd_5_2_1:acid")["usable"], json!(true));
    assert_eq!(
        caps("srd_5_2_1:flame-tongue-longsword")["activation"],
        json!({ "schema_version": 1, "action_type": "bonus_action", "requires_equipped": true, "requires_attunement": true })
    );
    let potion = m::item_viewer_capabilities(Some(&item("srd_5_2_1:potion-of-healing")), "dnd_5e_2014").expect("зелье");
    assert_eq!(potion["use"]["action_type"], json!("action"));
    assert!(potion["limitation"].as_str().unwrap_or_default().ends_with("В профиле D&D 5e 2014 предмет требует основное действие."));
    assert_eq!(m::item_viewer_capabilities(Some(&json!({ "description": "Самодельный амулет" })), ""), None);
    assert_eq!(caps("srd_5_2_1:dagger")["off_hand"], json!(true));
    assert!(caps("srd_5_2_1:longsword").get("off_hand").is_none());
}

#[test]
fn scenario_items_are_found_but_never_sold_or_dropped() {
    let catalog = m::SCENARIO_ITEM_CATALOG.as_object().expect("каталог сценария");
    assert_eq!(catalog.len(), 2);
    for (id, entry) in catalog {
        assert!(m::item_catalog().get(id).is_none(), "{id} не входит в SRD");
        assert_eq!(m::catalog_item(id), Some(entry));
        assert_eq!(entry["availability"], json!({ "shop": false, "loot": false, "magic_loot": false, "crafting": false }));
        assert_eq!(entry["provenance"]["source_page"], json!(1));
    }
    let tear = m::materialize_catalog_item("scenario_astohan:kaelan-tear", Some(&json!({ "id": "tear" })));
    assert_eq!(tear["charges"], json!({ "current": 1, "max": 1 }));
    assert_eq!(tear["recharge"], json!({ "schema_version": 1, "trigger": "dawn", "formula": "1d6+1" }));
    assert_eq!(m::item_recharge_profile("scenario_astohan:kaelan-tear"), Some(json!({ "schema_version": 1, "trigger": "dawn", "formula": "1d6+1" })));
}
