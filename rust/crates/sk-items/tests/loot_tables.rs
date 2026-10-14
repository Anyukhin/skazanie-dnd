//! Сверка `loot_tables` с эталоном JS (`fixtures/loot-tables.json`,
//! генератор — `fixtures/gen-loot-tables.mjs`) и перенесённые проверки из
//! `test/encounter-loot-tables.test.mjs` и `test/encounter-magic-loot.test.mjs`.

mod common;

use std::collections::HashSet;

use common::{check, ok, type_error, Outcome};
use serde_json::{json, Value};
use sk_items::item_catalog::{catalog_item, ITEM_CATALOG_SCHEMA_VERSION, ITEM_LOOT_CATALOG_IDS, ITEM_MAGIC_LOOT_CATALOG_IDS};
use sk_items::loot_tables as m;

fn outcome(result: Result<Vec<Value>, String>) -> Outcome {
    result.map(|items| Some(Value::Array(items))).map_err(type_error)
}

#[test]
fn loot_tables_match_js() {
    let count = check(include_str!("../fixtures/loot-tables.json"), |name, args| -> Outcome {
        match name {
            "const:ENCOUNTER_LOOT_POLICY_ID" => ok(json!(m::ENCOUNTER_LOOT_POLICY_ID)),
            "const:ENCOUNTER_MAGIC_LOOT_POLICY_ID" => ok(json!(m::ENCOUNTER_MAGIC_LOOT_POLICY_ID)),
            "const:LOOT_BY_THEME" => ok(m::loot_by_theme_json()),
            "serverEncounterLoot" => outcome(m::server_encounter_loot(args.get(0))),
            "serverEncounterMagicLoot" => outcome(m::server_encounter_magic_loot(args.get(0))),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 2_500, "{count}");
}

fn ids(loot: &[Value]) -> Vec<String> {
    loot.iter().map(|item| item["catalog_id"].as_str().unwrap_or_default().to_string()).collect()
}

fn price(id: &str) -> i64 {
    catalog_item(id).and_then(|entry| entry["base_price_cp"].as_i64()).unwrap_or(-1)
}

#[test]
fn allowlist_and_theme_pools_match_bounded_contract_v2() {
    assert_eq!(m::ENCOUNTER_LOOT_POLICY_ID, "encounter-loot-v2");
    assert_eq!(ITEM_LOOT_CATALOG_IDS.len(), 30);
    let pooled: HashSet<&str> = m::LOOT_BY_THEME.iter().flat_map(|(_, pool)| pool.iter().copied()).collect();
    let allowed: HashSet<&str> = ITEM_LOOT_CATALOG_IDS.iter().copied().collect();
    assert_eq!(pooled, allowed);
    for id in ITEM_LOOT_CATALOG_IDS.iter() {
        let entry = catalog_item(id).expect("запись");
        assert!(matches!(entry["mechanics_status"].as_str(), Some("verified" | "partial")), "{id}");
        assert_eq!(entry["availability"]["loot"], json!(true));
        assert_eq!(entry["availability"]["crafting"], json!(false));
        assert!(!["potion", "ring-of", "longsword-plus", "wand-of"].iter().any(|part| id.contains(part)), "{id}");
    }
}

#[test]
fn difficulty_gives_one_two_three_unique_stacks_as_prefixes() {
    for (theme, _) in m::LOOT_BY_THEME {
        for index in 0..80 {
            let id = format!("{theme}-{index}");
            let easy = m::encounter_loot(theme, "easy", &id).expect("easy");
            let medium = m::encounter_loot(theme, "medium", &id).expect("medium");
            let hard = m::encounter_loot(theme, "hard", &id).expect("hard");
            assert_eq!((easy.len(), medium.len(), hard.len()), (1, 2, 3), "{theme}");
            assert_eq!(ids(&medium)[..1], ids(&easy)[..], "{theme}/{id}");
            assert_eq!(ids(&hard)[..2], ids(&medium)[..], "{theme}/{id}");
            assert_eq!(ids(&hard).into_iter().collect::<HashSet<_>>().len(), 3);
        }
    }
}

#[test]
fn price_tier_is_exact_and_falls_back_only_down() {
    let tiers = [(0, 500), (501, 2_500), (2_501, 7_500)];
    for (theme, pool) in m::LOOT_BY_THEME {
        for index in 0..80 {
            let loot = m::encounter_loot(theme, "hard", &format!("tier-{index}")).expect("добыча");
            let mut used: HashSet<String> = HashSet::new();
            for (tier, id) in ids(&loot).into_iter().enumerate() {
                let (minimum, maximum) = tiers[tier];
                let exact = pool.iter().any(|candidate| !used.contains(*candidate) && (minimum..=maximum).contains(&price(candidate)));
                if exact {
                    assert!((minimum..=maximum).contains(&price(&id)), "{theme}/{tier}/{id}");
                } else {
                    assert!(price(&id) <= maximum, "{theme}/{tier}/{id}");
                }
                used.insert(id);
            }
        }
    }
}

#[test]
fn quantity_policy_is_bounded_for_supplies_and_ammunition() {
    let supplies = ["srd_5_2_1:torch", "srd_5_2_1:rations-one-day"];
    let ammunition = ["srd_5_2_1:arrows-20", "srd_5_2_1:bolts-20", "srd_5_2_1:sling-bullets-20"];
    for (theme, _) in m::LOOT_BY_THEME {
        for (difficulty, supply, ammo) in [("easy", 1, 1), ("medium", 2, 1), ("hard", 3, 2)] {
            for index in 0..120 {
                let loot = m::encounter_loot(theme, difficulty, &format!("quantity-{index}")).expect("добыча");
                for item in &loot {
                    let id = item["catalog_id"].as_str().unwrap_or_default();
                    let expected = if supplies.contains(&id) {
                        supply
                    } else if ammunition.contains(&id) {
                        ammo
                    } else {
                        1
                    };
                    assert_eq!(item["quantity"], json!(expected), "{theme}/{difficulty}/{id}");
                }
                if difficulty == "hard" {
                    assert!(loot.iter().map(|item| item["quantity"].as_i64().unwrap_or(0)).sum::<i64>() <= 9);
                    let weight: f64 = loot.iter().map(|item| item["quantity"].as_f64().unwrap_or(0.0) * item["weight"].as_f64().unwrap_or(0.0)).sum();
                    assert!(weight <= 54.0);
                }
            }
        }
    }
}

#[test]
fn loot_is_deterministic_and_materialized_from_catalog() {
    let first = m::encounter_loot("raiders", "hard", "same-id").expect("добыча");
    assert_eq!(first, m::encounter_loot("raiders", "hard", "same-id").expect("повтор"));
    for item in &first {
        let entry = catalog_item(item["catalog_id"].as_str().unwrap_or_default()).expect("запись");
        assert_eq!(item["catalog_schema_version"], json!(ITEM_CATALOG_SCHEMA_VERSION));
        for key in ["name", "type", "weight", "base_price_cp", "mechanics_status"] {
            assert_eq!(item[key], entry[key], "{key}");
        }
    }
    for theme in ["goblinoids", "undead", "beasts", "raiders", "warband", "generic"] {
        let loot = m::encounter_loot(theme, "hard", "catalog-coverage").expect("добыча");
        assert!(loot.iter().all(|item| ITEM_LOOT_CATALOG_IDS.contains(&item["catalog_id"].as_str().unwrap_or_default())));
    }
}

fn findings(count: usize, total_xp: f64) -> Vec<Value> {
    (1..=count).flat_map(|index| m::encounter_magic_loot(&format!("enc-{index}"), total_xp).expect("находка")).collect()
}

fn rarity(item: &Value) -> String {
    catalog_item(item["catalog_id"].as_str().unwrap_or_default()).map(|entry| entry["magic_item"]["rarity"].as_str().unwrap_or_default().to_string()).unwrap_or_default()
}

#[test]
fn magic_loot_is_stingy_tiered_and_deterministic() {
    assert_eq!(m::ENCOUNTER_MAGIC_LOOT_POLICY_ID, "encounter-magic-loot-v1");
    for index in 1..=120 {
        assert!(m::encounter_magic_loot(&format!("enc-{index}"), 5_000.0).expect("находка").len() <= 1);
    }
    assert!(findings(120, 199.0).is_empty(), "мелкая стычка не должна приносить магический предмет");
    assert!(findings(120, 0.0).is_empty());
    let modest = findings(120, 300.0);
    assert!(!modest.is_empty(), "на 300 XP необычные находки обязаны иногда встречаться");
    assert!(modest.iter().all(|item| rarity(item) == "uncommon"));
    assert!(findings(120, 900.0).iter().any(|item| rarity(item) == "rare"), "на 900 XP редкие находки обязаны встречаться");
    for id in ["enc-23", "enc-45", "enc-50"] {
        assert_eq!(m::encounter_magic_loot(id, 900.0), m::encounter_magic_loot(id, 900.0));
    }
    let found = findings(300, 5_000.0);
    assert!(!found.is_empty());
    for item in &found {
        let id = item["catalog_id"].as_str().unwrap_or_default();
        assert!(ITEM_MAGIC_LOOT_CATALOG_IDS.contains(&id), "{id} не открыт списком магической добычи");
        assert_eq!(item["quantity"], json!(1));
        assert_eq!(item["equipped"], json!(false));
        assert!(!item["rarity"].as_str().unwrap_or_default().is_empty(), "у находки обязана быть видимая редкость");
    }
}
