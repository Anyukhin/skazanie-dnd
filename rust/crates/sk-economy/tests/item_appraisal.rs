//! `item_appraisal`: эталон JS (`fixtures/item-appraisal.json`) и проверки
//! из `test/item-appraisal.test.mjs`.

mod common;

use common::{check, ok, Args, JsError, Outcome};
use serde_json::{json, Value};
use sk_economy::item_appraisal::*;

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:ITEM_APPRAISAL_CONTRACT_VERSION" => ok(json!(ITEM_APPRAISAL_CONTRACT_VERSION)),
        "const:CATALOG_APPRAISAL_POLICY_ID" => ok(json!(CATALOG_APPRAISAL_POLICY_ID)),
        "const:CATEGORY_APPRAISAL_POLICY_ID" => ok(json!(CATEGORY_APPRAISAL_POLICY_ID)),
        "const:MAX_APPRAISED_UNIT_PRICE_CP" => ok(json!(MAX_APPRAISED_UNIT_PRICE_CP)),
        "const:ITEM_APPRAISAL_POLICIES" => ok(ITEM_APPRAISAL_POLICIES.clone()),
        "appraiseItem" => appraise_item(args.get(0), args.get(1)).map(Some).map_err(|error| JsError { name: "ItemAppraisalError".into(), code: Some(error.code), message: error.message }),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn appraisal_matches_js() {
    let summary = check(include_str!("../fixtures/item-appraisal.json"), run);
    assert!(summary.calls > 900, "{summary:?}");
}

fn homebrew(patch: Value) -> Value {
    let mut base = json!({
        "homebrew_id": "homebrew:moon-blade-fragment",
        "item_id": "item-17",
        "name": "Осколок лунного клинка",
        "category": "weapon",
        "rarity": "rare",
        "condition": "worn",
    });
    for (key, value) in patch.as_object().cloned().unwrap_or_default() {
        base[key] = value;
    }
    base
}

fn policy(id: &str) -> Value {
    json!({ "policyId": id })
}

fn code(result: Result<Value, ItemAppraisalError>) -> String {
    result.expect_err("ожидался отказ").code
}

#[test]
fn catalog_appraisal_uses_only_canonical_price_and_source() {
    let result = appraise_item(Some(&json!({ "catalog_id": "srd_5_2_1:potion-of-healing", "item_id": "potion-1", "name": "Зелье лечения" })), None).expect("оценка");
    assert_eq!(result["contract_version"], ITEM_APPRAISAL_CONTRACT_VERSION);
    assert_eq!(result["authoritative"], true);
    assert_eq!(result["currency"], "cp");
    assert_eq!(result["base_price_cp"], 5_000);
    assert_eq!(result["provenance"], "catalog");
    assert_eq!(result["policy_id"], CATALOG_APPRAISAL_POLICY_ID);
    assert_eq!(result["source"]["catalog_version"], "srd_5_2_1");
    assert_eq!(result["source"]["source_page"], 95);
    let fingerprint = result["appraisal_fingerprint"].as_str().expect("отпечаток");
    assert_eq!(fingerprint.len(), 64);
}

#[test]
fn unknown_fields_fail_closed() {
    for field in ["base_price_cp", "estimated_price_cp", "price_cp", "secret", "secret_supplier", "price_provenance", "appraisal_policy_id", "appraisal_fingerprint", "unknown"] {
        let mut input = json!({ "catalog_id": "srd_5_2_1:torch" });
        input[field] = if field == "secret" { json!("GM_ONLY") } else { json!(999_999) };
        assert_eq!(code(appraise_item(Some(&input), None)), "UNEXPECTED_APPRAISAL_FIELD", "{field}");
    }
}

#[test]
fn unknown_catalog_identity_never_falls_through_to_formula() {
    let input = json!({ "catalog_id": "homebrew:moon-blade-fragment" });
    assert_eq!(code(appraise_item(Some(&input), Some(&policy(CATEGORY_APPRAISAL_POLICY_ID)))), "APPRAISAL_POLICY_MISMATCH");
    assert_eq!(code(appraise_item(Some(&input), None)), "UNKNOWN_APPRAISAL_CATALOG_ITEM");
    // Свойство прототипа в JS находит функцию; здесь это неизвестный код каталога.
    for key in ["constructor", "toString", "valueOf", "hasOwnProperty"] {
        assert_eq!(code(appraise_item(Some(&json!({ "catalog_id": key })), None)), "UNKNOWN_APPRAISAL_CATALOG_ITEM", "{key}");
    }
}

#[test]
fn custom_item_requires_explicit_allowlisted_policy() {
    assert_eq!(code(appraise_item(Some(&homebrew(json!({}))), None)), "APPRAISAL_POLICY_REQUIRED");
    assert_eq!(code(appraise_item(Some(&homebrew(json!({}))), Some(&policy("agent:free-price:v1")))), "APPRAISAL_POLICY_NOT_ALLOWED");
    assert_eq!(code(appraise_item(Some(&homebrew(json!({}))), Some(&policy(CATALOG_APPRAISAL_POLICY_ID)))), "APPRAISAL_POLICY_MISMATCH");
}

#[test]
fn formula_is_deterministic_bounded_and_auditable() {
    let input = homebrew(json!({}));
    let first = appraise_item(Some(&input), Some(&policy(CATEGORY_APPRAISAL_POLICY_ID))).expect("оценка");
    let second = appraise_item(Some(&input.clone()), Some(&policy(CATEGORY_APPRAISAL_POLICY_ID))).expect("оценка");
    assert_eq!(first, second);
    assert_eq!(first["base_price_cp"], 9_375);
    assert_eq!(first["provenance"], "server_appraisal_policy");
    assert_eq!(
        first["formula"],
        json!({ "formula_version": "category-rarity-condition-v1", "category_base_cp": 500, "rarity_multiplier_bps": 250_000, "condition_multiplier_bps": 7_500, "maximum_unit_price_cp": MAX_APPRAISED_UNIT_PRICE_CP })
    );
}

#[test]
fn equivalent_descriptors_share_one_fingerprint() {
    let options = policy(CATEGORY_APPRAISAL_POLICY_ID);
    let first = appraise_item(Some(&homebrew(json!({ "name": "  Осколок   лунного клинка  " }))), Some(&options)).expect("оценка");
    let second = appraise_item(Some(&homebrew(json!({ "name": "Осколок лунного клинка" }))), Some(&options)).expect("оценка");
    let changed = appraise_item(Some(&homebrew(json!({ "condition": "fine" }))), Some(&options)).expect("оценка");
    assert_eq!(first["descriptor"]["name"], "Осколок лунного клинка");
    assert_eq!(first["appraisal_fingerprint"], second["appraisal_fingerprint"]);
    assert_ne!(first["appraisal_fingerprint"], changed["appraisal_fingerprint"]);
    assert_ne!(first["base_price_cp"], changed["base_price_cp"]);
}

#[test]
fn only_small_vocabularies_and_strict_options() {
    let options = policy(CATEGORY_APPRAISAL_POLICY_ID);
    for (field, value) in [("category", "artifact"), ("rarity", "unique"), ("condition", "enchanted-by-agent")] {
        assert_eq!(code(appraise_item(Some(&homebrew(json!({ field: value }))), Some(&options))), "INVALID_APPRAISAL_DESCRIPTOR");
    }
    assert_eq!(code(appraise_item(Some(&homebrew(json!({ "name": "x".repeat(121) }))), Some(&options))), "INVALID_APPRAISAL_DESCRIPTOR");
    assert_eq!(code(appraise_item(Some(&json!({ "catalog_id": "srd_5_2_1:dagger", "rarity": "legendary" })), None)), "APPRAISAL_DESCRIPTOR_MISMATCH");
    let loose = json!({ "policyId": CATEGORY_APPRAISAL_POLICY_ID, "estimatedPriceCp": 1 });
    assert_eq!(code(appraise_item(Some(&homebrew(json!({}))), Some(&loose))), "UNEXPECTED_APPRAISAL_FIELD");
}

#[test]
fn published_allowlist_exposes_only_bounded_policies() {
    let keys: Vec<&String> = ITEM_APPRAISAL_POLICIES.as_object().expect("словарь").keys().collect();
    assert_eq!(keys, [CATALOG_APPRAISAL_POLICY_ID, CATEGORY_APPRAISAL_POLICY_ID]);
    assert_eq!(ITEM_APPRAISAL_POLICIES[CATEGORY_APPRAISAL_POLICY_ID]["maximum_unit_price_cp"], MAX_APPRAISED_UNIT_PRICE_CP);
}
