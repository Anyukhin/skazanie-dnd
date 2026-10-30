//! Статус механики предмета — тип (урок 8 плана переноса): запись каталога с
//! опечаткой в статусе не загружается, а каждая встроенная запись
//! разбирается в [`MechanicsSupport`].

use serde_json::json;
use sk_core::MechanicsSupport;
use sk_items::item_catalog as m;

fn entry(catalog_id: &str, status: serde_json::Value) -> serde_json::Value {
    json!({ "catalog_id": catalog_id, "category": "gear", "availability": { "shop": true }, "lifecycle": { "transferable": true }, "mechanics_status": status })
}

#[test]
fn typo_in_item_status_fails_the_load_and_names_the_entry() {
    let ok = m::item_catalog_from_entries(vec![entry("srd_5_2_1:rope", json!("verified")), entry("srd_5_2_1:torch", json!("ruling-only"))]).expect("каталог загружается");
    assert_eq!(ok["srd_5_2_1:torch"]["corpse_loot_eligible"], json!(false));

    let error = m::item_catalog_from_entries(vec![entry("srd_5_2_1:rope", json!("verified")), entry("srd_5_2_1:torch", json!("rulling-only"))]).expect_err("опечатка");
    assert_eq!(error.card, "srd_5_2_1:torch");
    assert!(error.to_string().contains("«srd_5_2_1:torch»"), "{error}");

    let missing = m::item_catalog_from_entries(vec![json!({ "catalog_id": "srd_5_2_1:lamp" })]).expect_err("без статуса");
    assert_eq!(missing.card, "srd_5_2_1:lamp");

    // `heuristic` — статус заклинаний и действий, у вещей его не бывает.
    let heuristic = m::item_catalog_from_entries(vec![entry("srd_5_2_1:lamp", json!("heuristic"))]).expect_err("heuristic у вещи");
    assert_eq!(heuristic.card, "srd_5_2_1:lamp");
}

#[test]
fn every_builtin_item_entry_parses() {
    let census = m::item_catalog_census();
    assert_eq!(census.total(), m::item_catalog().len() + m::SCENARIO_ITEM_CATALOG.as_object().map_or(0, |catalog| catalog.len()));
    assert_eq!(census.count(MechanicsSupport::Heuristic), 0);
    assert_eq!(census.blocked().len(), census.count(MechanicsSupport::RulingOnly));
    for catalog_id in census.blocked() {
        assert!(!m::ITEM_SHOP_CATALOG_IDS.contains(&catalog_id.as_str()), "{catalog_id} в лавке");
    }
    assert_eq!(m::ITEM_MECHANICS_STATUSES, ["verified", "partial", "ruling-only"]);
    assert_eq!(m::item_mechanics_support("heuristic"), None);
    assert_eq!(m::item_mechanics_support("partial"), Some(MechanicsSupport::Partial));
}
