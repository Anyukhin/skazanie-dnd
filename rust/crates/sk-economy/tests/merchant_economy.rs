//! Сверка `merchant_economy` с эталонами JS: `fixtures/merchant-economy.json`
//! (функции модуля на сотнях вещей и торговцев) и
//! `fixtures/merchant-economy-states.json` (витрина, доступность, услуги и
//! часы лавки на состояниях кампании, в том числе сыгранных JS Rules Engine).

mod common;

use common::{check, ok, ok_or_null, Args, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_economy::merchant_economy::*;

fn constant(name: &str) -> Option<Value> {
    Some(match name {
        "ECONOMY_POLICY_ID" => json!(ECONOMY_POLICY_ID),
        "ECONOMY_CATALOG_VERSION" => json!(ECONOMY_CATALOG_VERSION),
        "ECONOMY_CATALOG_SOURCE" => ECONOMY_CATALOG_SOURCE.clone(),
        "MAX_CURRENCY_CP" => json!(MAX_CURRENCY_CP),
        "DEFAULT_MERCHANT_PURSE_CP" => json!(DEFAULT_MERCHANT_PURSE_CP),
        "MAX_TRANSACTION_QUANTITY" => json!(MAX_TRANSACTION_QUANTITY),
        "MAX_STOCK_QUANTITY" => json!(MAX_STOCK_QUANTITY),
        "MAX_UNIT_PRICE_CP" => json!(MAX_UNIT_PRICE_CP),
        "ITEM_APPRAISAL_CONTRACT_VERSION" => json!(ITEM_APPRAISAL_CONTRACT_VERSION),
        "ITEM_APPRAISAL_POLICY_ID" => json!(ITEM_APPRAISAL_POLICY_ID),
        "MERCHANT_SERVICES_POLICY_ID" => json!(MERCHANT_SERVICES_POLICY_ID),
        "MERCHANT_RESTOCK_POLICY_ID" => json!(MERCHANT_RESTOCK_POLICY_ID),
        "MERCHANT_ECONOMY_CLOCK_EVENT_TYPE" => json!(MERCHANT_ECONOMY_CLOCK_EVENT_TYPE),
        "MIN_RESTOCK_INTERVAL_MINUTES" => json!(MIN_RESTOCK_INTERVAL_MINUTES),
        "MAX_RESTOCK_INTERVAL_MINUTES" => json!(MAX_RESTOCK_INTERVAL_MINUTES),
        "MAX_WORLD_MINUTE" => json!(MAX_WORLD_MINUTE),
        _ => return None,
    })
}

fn item_options(args: &Args, index: usize) -> InventoryItemOptions<'static> {
    let id_fallback = match args.option(index, "idFallback").and_then(Value::as_str) {
        Some("stock") => "stock",
        _ => "item",
    };
    InventoryItemOptions {
        id_fallback,
        preserve_unknown: js::truthy(args.option(index, "preserveUnknown")),
        hydrate_catalog: js::truthy(args.option(index, "hydrateCatalog")),
    }
}

pub fn run(name: &str, args: &Args) -> Outcome {
    if let Some(constant_name) = name.strip_prefix("const:") {
        return ok(constant(constant_name).unwrap_or_else(|| panic!("неизвестная константа {constant_name}")));
    }
    let a = |index: usize| args.get(index);
    match name {
        "canonicalLocationKey" => ok(json!(canonical_location_key(a(0)))),
        "canonicalLocationId" => ok(json!(canonical_location_id(a(0)))),
        "locationsMatch" => ok(json!(locations_match(a(0), a(1)))),
        "merchantIsAtLocation" => ok(json!(merchant_is_at_location(a(0), a(1)))),
        "normalizeInventoryItemType" => ok(json!(normalize_inventory_item_type(a(0)))),
        "normalizeInventoryItemRarity" => ok(json!(normalize_inventory_item_rarity(a(0)))),
        "normalizeInventoryPassiveEffects" => ok(Value::Array(normalize_inventory_passive_effects(a(0)))),
        "inventoryStackKey" => ok(json!(inventory_stack_key(a(0)))),
        "normalizeInventoryItem" => ok(normalize_inventory_item(a(0), item_options(args, 1))),
        "normalizeCurrency" => ok(normalize_currency(a(0))),
        "currencyToCopper" => ok(json!(currency_to_copper(a(0)))),
        "copperToCurrency" => ok(copper_to_currency(a(0))),
        "normalizeMerchantPurseCp" => ok(json!(normalize_merchant_purse_cp(a(0), a(1)))),
        "resolveCatalogPrice" => ok_or_null(resolve_catalog_price(a(0))),
        "resolveCatalogBasePriceCp" => ok(json!(resolve_catalog_base_price_cp(a(0)))),
        "normalizeMerchantPricing" => ok(normalize_merchant_pricing(a(0))),
        "normalizeMerchantServices" => ok(Value::Array(normalize_merchant_services(a(0)))),
        "normalizeMerchantRestockPolicy" => ok(normalize_merchant_restock_policy(a(0), a(1))),
        "normalizeMerchant" => ok(normalize_merchant(a(0), js::safe_int(a(1), 0) as usize)),
        "normalizeMerchants" => ok(Value::Array(normalize_merchants(a(0)))),
        "createStarterMerchant" => ok(create_starter_merchant(a(0))),
        "findMerchant" => ok_or_null(find_merchant(a(0).expect("состояние"), a(1)).cloned()),
        "bargainFor" => ok_or_null(bargain_for(a(0), a(1)).cloned()),
        "quoteMerchantBuyUnit" => ok_or_null(quote_merchant_buy_unit(a(0), a(1), a(2), a(3))),
        "quoteMerchantService" => ok_or_null(quote_merchant_service(a(0), a(1), a(2), a(3))),
        "quoteMerchantSellUnit" => ok_or_null(quote_merchant_sell_unit(a(0), a(1), a(2), a(3), a(4), a(5))),
        "findMerchantService" => ok_or_null(find_merchant_service(a(0), a(1)).cloned()),
        "publicMerchantFor" => ok(public_merchant_for(a(0).expect("торговец"))),
        "planMerchantRestock" => ok_or_null(plan_merchant_restock(a(0), a(1))),
        "merchantRestockCommandFromPlan" => ok_or_null(merchant_restock_command_from_plan(a(0), a(1))),
        "merchantEconomyClockEventFromPlan" => ok_or_null(merchant_economy_clock_event_from_plan(a(0), a(1))),
        "applyMerchantRestockPlan" => ok(apply_merchant_restock_plan(a(0), a(1))),
        "inventoryItemFromStock" => ok(inventory_item_from_stock(a(0))),
        "trustedStockAppraisalFor" => ok_or_null(trusted_stock_appraisal_for(a(0))),
        "trustedItemAppraisalFor" => ok_or_null(trusted_item_appraisal_for(a(0).expect("состояние"), a(1), a(2))),
        "sellability" => ok(sellability(a(0), a(1)).to_json()),
        "merchantViewFor" => ok_or_null(merchant_view_for(a(0).expect("состояние"), a(1), a(2))),
        "merchantTradeAvailabilityFor" => ok(merchant_trade_availability_for(a(0).expect("состояние"), a(1), js::truthy(args.option(2, "allowRemote"))).to_json()),
        "merchantServiceProposal" => ok_or_null(merchant_service_proposal(a(0).expect("состояние"), a(1), a(2), a(3))),
        "planMerchantEconomyClock" => ok(Value::Array(plan_merchant_economy_clock(a(0).expect("состояние"), args.option(1, "worldMinute")))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn merchant_economy_matches_js() {
    let summary = check(include_str!("../fixtures/merchant-economy.json"), run);
    assert!(summary.calls > 9_000, "эталон обязан быть содержательным: {summary:?}");
}

#[test]
fn merchant_states_match_js() {
    let summary = check(include_str!("../fixtures/merchant-economy-states.json"), run);
    assert!(summary.calls > 2_500, "эталон обязан быть содержательным: {summary:?}");
}
