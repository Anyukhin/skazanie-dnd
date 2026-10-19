//! Ветки редьюсера `applyGameEventCurrent`: Торговцы: создание, настройка, пополнение, часы экономики, перемещение, доступность, оценка, торг, покупка, услуги, продажа. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 25492–25505, 25506–25521, 25522–25540, 25541–25550, 25551–25562, 25563–25570, 25571–25581, 25582–25605, 25606–25630, 25631–25652, 25653–25699. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Торговец из события проходит тот же нормализатор жизненного цикла, что и
//! команда (`merchants.rs`): replay не доверяет форме, сохранённой в журнале.

use serde_json::{json, Map, Value};
use sk_core::js::{self, is_true, present, safe_int};
use sk_core::Event;
use sk_economy::merchant_economy::{
    apply_merchant_restock_plan, normalize_currency, normalize_merchant_purse_cp, ECONOMY_POLICY_ID, ITEM_APPRAISAL_POLICY_ID, MAX_STOCK_QUANTITY, MERCHANT_RESTOCK_POLICY_ID, MERCHANT_SERVICES_POLICY_ID,
};

use super::items::{add_inventory_item, refresh_player_derived_state};
use super::social::{target_key, target_value};
use super::{target_of, Reduced};
use crate::core::{inventory_item, player_actor, replace_actor, unique_strings};
use crate::journal::{append_economy_log, Entry};
use crate::merchants::{lifecycle_configuration_from_canonical, lifecycle_merchant_from_canonical, lifecycle_pricing_from_canonical, lifecycle_stock_from_canonical, remove_item_appraisal, replace_merchant, set_item_appraisal};

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[];

/// `payload.x ?? fallback`.
fn or(payload: &Value, key: &str, fallback: &str) -> Value {
    payload.get(key).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String(fallback.into()))
}

/// `payload.x ?? null`.
fn or_null(payload: &Value, key: &str) -> Value {
    payload.get(key).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

/// `payload.item?.x ?? null`.
fn item_field(payload: &Value, key: &str) -> Value {
    payload.get("item").and_then(|item| item.get(key)).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

/// Кошелёк торговца после сделки: `merchant_purse_after_cp`, если поле есть.
fn purse_after(payload: &Value, merchant: &Value) -> i64 {
    match payload.as_object().filter(|map| map.contains_key("merchant_purse_after_cp")) {
        Some(map) => normalize_merchant_purse_cp(map.get("merchant_purse_after_cp"), None),
        None => normalize_merchant_purse_cp(merchant.get("purse_cp"), None),
    }
}

fn merchant_id(payload: &Value) -> String {
    js::string(payload.get("merchant_id"))
}

fn with(merchant: &Value, patch: Map<String, Value>) -> Value {
    let mut next = crate::core::spread_value(Some(merchant));
    for (key, value) in patch {
        next.insert(key, value);
    }
    Value::Object(next)
}

fn stock_of(merchant: &Value) -> Vec<Value> {
    merchant.get("stock").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `MerchantCreated` (25492–25505).
pub(super) fn merchant_created(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let merchant = lifecycle_merchant_from_canonical(payload.get("merchant"))?;
    let id = js::s(merchant.get("id"));
    let merchants = js::array_mut(state, "merchants");
    match merchants.iter().position(|candidate| js::string(candidate.get("id")) == id) {
        Some(index) => merchants[index] = merchant.clone(),
        None => merchants.push(merchant.clone()),
    }
    let rules = js::array_mut(state, "enabled_house_rules");
    if !rules.iter().any(|rule| rule.as_str() == Some(ECONOMY_POLICY_ID)) {
        rules.push(Value::String(ECONOMY_POLICY_ID.into()));
    }
    let entry = Entry::new()
        .set("type", "merchant-created")
        .set("merchantId", merchant.get("id").cloned().unwrap_or(Value::Null))
        .set("location", merchant.get("location").cloned().unwrap_or(Value::Null))
        .set("stockPositions", merchant.get("stock").and_then(Value::as_array).map_or(0, Vec::len))
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantConfigured` (25506–25521).
pub(super) fn merchant_configured(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let configuration = lifecycle_configuration_from_canonical(payload.get("configuration"), Some(merchant))?;
        let mut patch = configuration.as_object().cloned().unwrap_or_default();
        if let Some(pricing) = configuration.get("pricing").filter(|pricing| js::truthy(Some(pricing))) {
            patch.insert("pricing".into(), lifecycle_pricing_from_canonical(Some(pricing), merchant.get("pricing"))?);
        }
        if is_true(payload.get("reset_bargains")) {
            patch.insert("bargains".into(), json!({}));
        }
        Ok(with(merchant, patch))
    })?;
    let entry = Entry::new()
        .set("type", "merchant-configured")
        .opt("merchantId", payload.get("merchant_id").cloned())
        .set("changedFields", js::strings_value(unique_strings(payload.get("changed_fields"))))
        .set("resetBargains", is_true(payload.get("reset_bargains")))
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

fn payload_entries(payload: &Value) -> &[Value] {
    payload.get("entries").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `MerchantRestocked` (25522–25540).
pub(super) fn merchant_restocked(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let mut stock = stock_of(merchant);
        let owner = js::string(merchant.get("id"));
        for (index, entry) in payload_entries(payload).iter().enumerate() {
            let mut source = crate::core::spread_value(entry.get("stock"));
            match entry.get("quantity_after") {
                Some(quantity) => source.insert("quantity".into(), quantity.clone()),
                None => source.shift_remove("quantity"),
            };
            let normalized = lifecycle_stock_from_canonical(Some(&Value::Object(source)), &owner, index)?;
            let stock_id = js::s(normalized.get("stock_id"));
            match stock.iter().position(|candidate| js::string(candidate.get("stock_id")) == stock_id) {
                Some(position) => stock[position] = normalized,
                None => stock.push(normalized),
            }
        }
        stock.truncate(500);
        let mut patch = Map::new();
        patch.insert("stock".into(), Value::Array(stock));
        Ok(with(merchant, patch))
    })?;
    let stock_ids: Vec<String> = payload_entries(payload).iter().map(|entry| js::s(entry.get("stock_id"))).filter(|id| !id.is_empty()).collect();
    let entry = Entry::new()
        .set("type", "merchant-restocked")
        .opt("merchantId", payload.get("merchant_id").cloned())
        .set("stockIds", js::strings_value(stock_ids))
        .set("totalQuantityAdded", safe_int(payload.get("total_quantity_added"), 0).max(0))
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantEconomyClockAdvanced` (25541–25550).
pub(super) fn merchant_economy_clock_advanced(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    replace_merchant(state, &merchant_id(payload), |merchant| Ok(apply_merchant_restock_plan(Some(merchant), Some(payload))))?;
    let entry = Entry::new()
        .set("type", "merchant-economy-clock")
        .opt("merchantId", payload.get("merchant_id").cloned())
        .set("scheduledForWorldMinute", safe_int(payload.get("scheduled_for_world_minute"), 0))
        .set("processedAtWorldMinute", safe_int(payload.get("processed_at_world_minute"), 0))
        .set("overdueIntervals", safe_int(payload.get("overdue_intervals"), 1).max(1))
        .set("policyId", or(payload, "policy_id", MERCHANT_RESTOCK_POLICY_ID))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantMoved` (25551–25562).
pub(super) fn merchant_moved(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let location = crate::normalize::scene::lifecycle_text(payload.get("location_after"), 180, true, "", "INVALID_MERCHANT_LOCATION", "Локация торговца")?;
        let location_id = if present(payload.get("location_id_after")) {
            crate::normalize::scene::lifecycle_text(payload.get("location_id_after"), 120, false, "", "INVALID_MERCHANT_LOCATION_ID", "location_id торговца")?
        } else {
            String::new()
        };
        let mut patch = Map::new();
        patch.insert("location".into(), Value::String(location));
        patch.insert("location_id".into(), Value::String(location_id));
        Ok(with(merchant, patch))
    })?;
    let entry = Entry::new()
        .set("type", "merchant-moved")
        .opt("merchantId", payload.get("merchant_id").cloned())
        .set("locationBefore", or(payload, "location_before", ""))
        .set("locationAfter", or(payload, "location_after", ""))
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantAvailabilityChanged` (25563–25570).
pub(super) fn merchant_availability_changed(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let available = is_true(payload.get("available_after"));
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let mut patch = Map::new();
        patch.insert("available".into(), Value::Bool(available));
        Ok(with(merchant, patch))
    })?;
    let entry = Entry::new()
        .set("type", "merchant-availability")
        .opt("merchantId", payload.get("merchant_id").cloned())
        .set("availableBefore", is_true(payload.get("available_before")))
        .set("availableAfter", available)
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantItemAppraised` (25571–25581).
pub(super) fn merchant_item_appraised(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let target = target_value(event);
    set_item_appraisal(state, Some(&target), payload.get("item_id"), payload.get("appraisal"));
    let entry = Entry::new()
        .set("type", "appraisal")
        .set("actorId", target)
        .opt("merchantId", payload.get("merchant_id").cloned())
        .opt("itemId", payload.get("item_id").cloned())
        .opt("itemName", payload.get("item_name").cloned())
        .set("baseUnitPriceCp", safe_int(payload.get("base_unit_price_cp"), 0))
        .set("priceProvenance", or(payload, "price_provenance", "server_appraisal_policy"))
        .set("policyId", or(payload, "policy_id", ITEM_APPRAISAL_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantBargainResolved` (25582–25605).
pub(super) fn merchant_bargain_resolved(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let success = is_true(payload.get("success"));
    let resolved_at = event.extra.get("occurred_at").filter(|value| !value.is_null()).or_else(|| event.extra.get("created_at").filter(|value| !value.is_null())).cloned().unwrap_or(Value::Null);
    let key = target_key(event);
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let mut bargains = crate::core::spread_value(merchant.get("bargains").filter(|value| !value.is_null()));
        bargains.insert(
            key.clone(),
            json!({
                "attempted": true,
                "success": success,
                "status": if success { "success" } else { "failure" },
                "natural_roll": safe_int(payload.get("natural_roll"), 1),
                "roll_total": safe_int(payload.get("roll_total"), 0),
                "modifier": safe_int(payload.get("modifier"), 0),
                "difficulty": safe_int(payload.get("difficulty"), 15),
                "pricing_adjustment_bps": safe_int(payload.get("pricing_adjustment_bps"), 0).clamp(-5_000, 5_000),
                "resolved_at": resolved_at.clone(),
            }),
        );
        let mut patch = Map::new();
        patch.insert("bargains".into(), Value::Object(bargains));
        Ok(with(merchant, patch))
    })?;
    let entry = Entry::new()
        .set("type", "bargain")
        .set("actorId", target_value(event))
        .opt("merchantId", payload.get("merchant_id").cloned())
        .set("success", success)
        .set("rollTotal", safe_int(payload.get("roll_total"), 0))
        .set("difficulty", safe_int(payload.get("difficulty"), 15))
        .set("pricingAdjustmentBps", safe_int(payload.get("pricing_adjustment_bps"), 0))
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// Запись журнала покупки и продажи (общие поля).
fn trade_entry(event: &Event, kind: &str) -> Map<String, Value> {
    let payload = &event.payload;
    Entry::new()
        .set("type", kind)
        .set("actorId", target_value(event))
        .opt("merchantId", payload.get("merchant_id").cloned())
        .opt("stockId", payload.get("stock_id").cloned())
        .set("catalogId", or_null(payload, "catalog_id"))
        .set("itemId", item_field(payload, "id"))
        .set("itemName", item_field(payload, "name"))
        .set("quantity", safe_int(payload.get("quantity"), 0))
        .set("unitPriceCp", safe_int(payload.get("unit_price_cp"), 0))
        .set("totalPriceCp", safe_int(payload.get("total_price_cp"), 0))
        .set("merchantPurseBeforeCp", safe_int(payload.get("merchant_purse_before_cp"), 0))
        .set("merchantPurseAfterCp", safe_int(payload.get("merchant_purse_after_cp"), 0))
        .set("priceProvenance", or(payload, "price_provenance", "custom"))
        .set("policyId", or(payload, "policy_id", ECONOMY_POLICY_ID))
        .build()
}

/// `MerchantPurchaseCompleted` (25606–25630).
pub(super) fn merchant_purchase_completed(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let target = target_of(event);
    let currency = normalize_currency(payload.get("currency_after"));
    let item = payload.get("item").cloned().unwrap_or(Value::Null);
    replace_actor(state, &target, |actor| {
        let inventory = add_inventory_item(actor.get("inventory"), &item);
        if let Some(map) = actor.as_object_mut() {
            map.insert("currency".into(), currency.clone());
            map.insert("inventory".into(), inventory);
        }
    });
    let stock_id = js::string(payload.get("stock_id"));
    let bought = safe_int(payload.get("quantity"), 0);
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let stock: Vec<Value> = stock_of(merchant)
            .into_iter()
            .map(|stock| {
                if js::string(stock.get("stock_id")) != stock_id {
                    return stock;
                }
                let quantity = (safe_int(stock.get("quantity"), 0) - bought).max(0);
                let mut next = crate::core::spread_value(Some(&stock));
                next.insert("quantity".into(), Value::from(quantity));
                Value::Object(next)
            })
            .collect();
        let mut patch = Map::new();
        patch.insert("purse_cp".into(), Value::from(purse_after(payload, merchant)));
        patch.insert("stock".into(), Value::Array(stock));
        Ok(with(merchant, patch))
    })?;
    if js::truthy(payload.get("item_appraisal")) {
        let item_id = payload.get("item").and_then(|item| item.get("id"));
        set_item_appraisal(state, Some(&target_value(event)), item_id, payload.get("item_appraisal"));
    }
    refresh_player_derived_state(state, std::slice::from_ref(&target))?;
    append_economy_log(state, event, trade_entry(event, "purchase"));
    Ok(())
}

/// `MerchantServicePurchased` (25631–25652).
pub(super) fn merchant_service_purchased(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let target = target_of(event);
    let currency = normalize_currency(payload.get("currency_after"));
    replace_actor(state, &target, |actor| {
        if let Some(map) = actor.as_object_mut() {
            map.insert("currency".into(), currency.clone());
        }
    });
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let mut patch = Map::new();
        patch.insert("purse_cp".into(), Value::from(purse_after(payload, merchant)));
        Ok(with(merchant, patch))
    })?;
    let entry = Entry::new()
        .set("type", "service")
        .set("actorId", target_value(event))
        .opt("merchantId", payload.get("merchant_id").cloned())
        .opt("serviceId", payload.get("service_id").cloned())
        .opt("serviceName", payload.get("service_name").cloned())
        .opt("serviceKind", payload.get("service_kind").cloned())
        .set("durationMinutes", safe_int(payload.get("duration_minutes"), 0))
        .set("totalPriceCp", safe_int(payload.get("total_price_cp"), 0))
        .set("merchantPurseBeforeCp", safe_int(payload.get("merchant_purse_before_cp"), 0))
        .set("merchantPurseAfterCp", safe_int(payload.get("merchant_purse_after_cp"), 0))
        .set("policyId", or(payload, "policy_id", MERCHANT_SERVICES_POLICY_ID))
        .set("requestFingerprint", or_null(payload, "request_fingerprint"))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `MerchantSaleCompleted` (25653–25699).
pub(super) fn merchant_sale_completed(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let target = target_of(event);
    let currency = normalize_currency(payload.get("currency_after"));
    let sold_id = js::string(payload.get("item").and_then(|item| item.get("id")));
    let sold = safe_int(payload.get("quantity"), 0);
    replace_actor(state, &target, |actor| {
        let inventory: Vec<Value> = actor
            .get("inventory")
            .filter(|value| !value.is_null())
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                if js::string(item.get("id")) != sold_id {
                    return item;
                }
                let quantity = (safe_int(item.get("quantity"), 1) - sold).max(0);
                let mut next = crate::core::spread_value(Some(&item));
                next.insert("quantity".into(), Value::from(quantity));
                Value::Object(next)
            })
            .filter(|item| safe_int(item.get("quantity"), 1) > 0)
            .collect();
        if let Some(map) = actor.as_object_mut() {
            map.insert("currency".into(), currency.clone());
            map.insert("inventory".into(), Value::Array(inventory));
        }
    });
    let item_id = payload.get("item").and_then(|item| item.get("id"));
    if inventory_item(player_actor(state, Some(&target_value(event))), item_id).is_none() {
        remove_item_appraisal(state, Some(&target_value(event)), item_id);
    }
    refresh_player_derived_state(state, std::slice::from_ref(&target))?;
    let stock_id = js::string(payload.get("stock_id"));
    replace_merchant(state, &merchant_id(payload), |merchant| {
        let purse = purse_after(payload, merchant);
        let stock = stock_of(merchant);
        let mut patch = Map::new();
        patch.insert("purse_cp".into(), Value::from(purse));
        if stock.iter().any(|entry| js::string(entry.get("stock_id")) == stock_id) {
            let next: Vec<Value> = stock
                .into_iter()
                .map(|entry| {
                    if js::string(entry.get("stock_id")) != stock_id {
                        return entry;
                    }
                    let quantity = (safe_int(entry.get("quantity"), 0) + sold).min(MAX_STOCK_QUANTITY);
                    let mut next = crate::core::spread_value(Some(&entry));
                    next.insert("quantity".into(), Value::from(quantity));
                    Value::Object(next)
                })
                .collect();
            patch.insert("stock".into(), Value::Array(next));
            return Ok(with(merchant, patch));
        }
        let mut item = crate::core::spread_value(payload.get("item").filter(|value| !value.is_null()));
        item.shift_remove("id");
        let catalog_id = match payload.get("catalog_id").filter(|value| !value.is_null()).or_else(|| item.get("catalog_id").filter(|value| !value.is_null())) {
            Some(value) => js::s(Some(value)),
            None => String::new(),
        };
        item.insert("stock_id".into(), Value::String(stock_id.clone()));
        item.insert("item_id".into(), Value::String(js::s(payload.get("item").and_then(|item| item.get("id")))));
        item.insert("catalog_id".into(), Value::String(catalog_id));
        item.insert("quantity".into(), Value::from(sold));
        item.insert("base_price_cp".into(), Value::from(safe_int(payload.get("base_unit_price_cp"), 0)));
        if let Some(appraisal) = payload.get("appraisal").filter(|value| js::truthy(Some(value))) {
            item.insert("appraisal".into(), appraisal.clone());
        }
        item.insert("equipped".into(), Value::Bool(false));
        let mut next = stock;
        next.push(Value::Object(item));
        patch.insert("stock".into(), Value::Array(next));
        Ok(with(merchant, patch))
    })?;
    append_economy_log(state, event, trade_entry(event, "sale"));
    Ok(())
}
