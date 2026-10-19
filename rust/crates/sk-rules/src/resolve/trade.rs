//! Ветки `resolveCommandInternal`: Торговля: торг, оценка, покупка, услуги, продажа, жизненный цикл торговцев, карманная кража. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 20348–20378, 20379–20395, 20396–20444, 20445–20475, 20476–20541, 20542–20549, 20550–20559, 20560–20568, 20569–20581, 20582–20592, 20609–20679. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Допустимость сделки (наличие героя, торговца, товара, денег) проверил блок
//! 63 `validateCommand`; ветка только считает. Где JS после проверки всё же
//! обращается к отсутствующему полю, здесь — `TypeError`, как в JS.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_economy::merchant_economy::{
    copper_to_currency, currency_to_copper, find_merchant, find_merchant_service, inventory_item_from_stock, inventory_stack_key, normalize_currency, normalize_inventory_item, normalize_merchant_purse_cp,
    quote_merchant_buy_unit, quote_merchant_sell_unit, quote_merchant_service, resolve_catalog_price, trusted_item_appraisal_for, trusted_stock_appraisal_for, InventoryItemOptions, ECONOMY_POLICY_ID,
    MERCHANT_SERVICES_POLICY_ID,
};

use super::Resolve;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with, command_with_rules, event_from, inventory_item, player_actor, slice_utf16};
use crate::merchants::{appraisal_for_inventory_item, checked_transaction_total, merchant_stock};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Halt, Step};
use crate::society_helpers::{fence_stance_for, inventory_stack_index, pickpocket_spent_condition};

/// `TypeError` чтения поля у `undefined`.
fn missing(key: &str) -> Halt {
    Fault::type_error(format!("Cannot read properties of undefined (reading '{key}')")).into()
}

/// `[command.actor_id]`.
fn actor_targets(command: &Value) -> Value {
    json!([command.get("actor_id").cloned().unwrap_or(Value::Null)])
}

/// `command.request_fingerprint ?? null`.
fn fingerprint_or_null(command: &Value) -> Value {
    command.get("request_fingerprint").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

/// Поле, если оно есть (`undefined` в JSON не попадает).
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `x ?? null`.
fn or_null(value: Option<&Value>) -> Value {
    value.filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

/// Герой и торговец сделки.
fn parties(r: &Resolve<'_>) -> (Option<Value>, Option<Value>) {
    let actor = player_actor(&r.state, r.command.get("actor_id")).cloned();
    let merchant = find_merchant(&r.state, r.command.get("merchant_id")).cloned();
    (actor, merchant)
}

/// `BargainWithMerchant` (20348–20378).
pub fn bargain_with_merchant(r: &mut Resolve<'_>) -> Step {
    let (actor, merchant) = parties(r);
    let modifier = crate::checks::skills::persuasion_check_modifier(actor.as_ref());
    let Some(merchant) = merchant else { return Err(missing("pricing")) };
    let pricing = merchant.get("pricing");
    let difficulty = js::safe_int(pricing.and_then(|pricing| pricing.get("bargain_dc")), 15);
    let options = json!({
        "modifier": modifier,
        "difficulty": difficulty,
        "purpose": "merchant_bargain",
        "actorId": field(&r.command, "actor_id"),
        "visibility": "public",
    });
    let roll = r.dice.roll_check(&options)?;
    let success = js::truthy(roll.get("success"));
    let adjustment = if success {
        -js::safe_int(pricing.and_then(|pricing| pricing.get("success_discount_bps")), 1_000).max(0)
    } else {
        js::safe_int(pricing.and_then(|pricing| pricing.get("failure_markup_bps")), 500).max(0)
    };
    r.rolls.push(roll.clone());
    r.events.push(event_from(&r.command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", merchant.get("id"));
    put(&mut payload, "success", roll.get("success"));
    payload.insert("status".into(), json!(if success { "success" } else { "failure" }));
    put(&mut payload, "natural_roll", roll.get("kept"));
    put(&mut payload, "roll_total", roll.get("total"));
    payload.insert("modifier".into(), json!(modifier));
    payload.insert("difficulty".into(), json!(difficulty));
    payload.insert("pricing_adjustment_bps".into(), json!(adjustment));
    payload.insert("policy_id".into(), json!(ECONOMY_POLICY_ID));
    payload.insert("request_fingerprint".into(), fingerprint_or_null(&r.command));
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&r.command, "MerchantBargainResolved", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `AppraiseItem` (20379–20395).
pub fn appraise_item(r: &mut Resolve<'_>) -> Step {
    let (actor, merchant) = parties(r);
    let item = inventory_item(actor.as_ref(), r.command.get("item_id")).cloned();
    let (Some(actor), Some(merchant)) = (actor, merchant) else { return Err(missing("id")) };
    let Some(item) = item else { return Err(missing("id")) };
    let appraisal = appraisal_for_inventory_item(&actor, &merchant, &item)?;
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", merchant.get("id"));
    put(&mut payload, "item_id", item.get("id"));
    put(&mut payload, "item_name", item.get("name"));
    payload.insert("appraisal".into(), appraisal.clone());
    put(&mut payload, "base_unit_price_cp", appraisal.get("base_price_cp"));
    put(&mut payload, "price_provenance", appraisal.get("provenance"));
    put(&mut payload, "policy_id", appraisal.get("policy_id"));
    payload.insert("request_fingerprint".into(), fingerprint_or_null(&r.command));
    let source = command_with(&r.command, "visibility", json!("specific_player"));
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&source, "MerchantItemAppraised", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `BuyItem` (20396–20444).
pub fn buy_item(r: &mut Resolve<'_>) -> Step {
    let (actor, merchant) = parties(r);
    let (Some(actor), Some(merchant)) = (actor, merchant) else { return Err(missing("id")) };
    let Some(stock) = merchant_stock(Some(&merchant), r.command.get("stock_id")).cloned() else { return Err(missing("stock_id")) };
    let reputation = json!(sk_society::reputation_policy::reputation_price_bps(&r.state, &field(&merchant, "id")));
    let Some(quote) = quote_merchant_buy_unit(Some(&merchant), actor.get("id"), Some(&stock), Some(&reputation)) else { return Err(missing("unit_price_cp")) };
    let total = checked_transaction_total(quote.get("unit_price_cp"), r.command.get("quantity")).map_err(Halt::Rule)?;
    let balance_before = currency_to_copper(actor.get("currency"));
    let purse_before = normalize_merchant_purse_cp(merchant.get("purse_cp"), None);
    let mut item = crate::core::spread_value(Some(&inventory_item_from_stock(Some(&stock))));
    item.insert("origin".into(), json!("purchased"));
    item.insert("quantity".into(), field(&r.command, "quantity"));
    let mut item = Value::Object(item);
    let inventory: Vec<Value> = actor.get("inventory").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(index) = inventory_stack_index(&inventory, &item) {
        item["id"] = field(&inventory[index], "id");
    }
    let item_appraisal = trusted_stock_appraisal_for(Some(&stock)).map(|appraisal| {
        let mut record = crate::core::spread_value(Some(&appraisal));
        record.insert("actor_id".into(), json!(js::string(actor.get("id"))));
        record.insert("merchant_id".into(), json!(js::string(merchant.get("id"))));
        record.insert("item_id".into(), json!(js::string(item.get("id"))));
        record.insert("item_stack_key".into(), json!(inventory_stack_key(Some(&item))));
        Value::Object(record)
    });
    let catalog = resolve_catalog_price(Some(&stock));
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", merchant.get("id"));
    put(&mut payload, "stock_id", stock.get("stock_id"));
    payload.insert("catalog_id".into(), stock.get("catalog_id").filter(|id| js::truthy(Some(id))).cloned().unwrap_or(Value::Null));
    payload.insert("item".into(), item);
    if let Some(appraisal) = item_appraisal {
        payload.insert("item_appraisal".into(), appraisal);
    }
    put(&mut payload, "quantity", r.command.get("quantity"));
    put(&mut payload, "base_unit_price_cp", quote.get("base_unit_price_cp"));
    put(&mut payload, "unit_price_cp", quote.get("unit_price_cp"));
    payload.insert("total_price_cp".into(), json!(total));
    put(&mut payload, "price_multiplier_bps", quote.get("multiplier_bps"));
    payload.insert("price_provenance".into(), catalog.as_ref().and_then(|catalog| catalog.get("provenance")).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("custom")));
    payload.insert("price_source_version".into(), or_null(catalog.as_ref().and_then(|catalog| catalog.get("source_version"))));
    payload.insert("currency_before".into(), normalize_currency(actor.get("currency")));
    payload.insert("currency_after".into(), copper_to_currency(Some(&json!(balance_before - total))));
    payload.insert("balance_before_cp".into(), json!(balance_before));
    payload.insert("balance_after_cp".into(), json!(balance_before - total));
    payload.insert("merchant_purse_before_cp".into(), json!(purse_before));
    payload.insert("merchant_purse_after_cp".into(), json!(purse_before + total));
    payload.insert("policy_id".into(), json!(ECONOMY_POLICY_ID));
    payload.insert("request_fingerprint".into(), fingerprint_or_null(&r.command));
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&r.command, "MerchantPurchaseCompleted", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `PurchaseMerchantService` (20445–20475).
pub fn purchase_merchant_service(r: &mut Resolve<'_>) -> Step {
    let (actor, merchant) = parties(r);
    let (Some(actor), Some(merchant)) = (actor, merchant) else { return Err(missing("id")) };
    let Some(service) = find_merchant_service(Some(&merchant), r.command.get("service_id")).cloned() else { return Err(missing("service_id")) };
    let reputation = json!(sk_society::reputation_policy::reputation_price_bps(&r.state, &field(&merchant, "id")));
    let Some(quote) = quote_merchant_service(Some(&merchant), actor.get("id"), Some(&service), Some(&reputation)) else { return Err(missing("price_cp")) };
    let total = checked_transaction_total(quote.get("price_cp"), Some(&json!(1))).map_err(Halt::Rule)?;
    let balance_before = currency_to_copper(actor.get("currency"));
    let purse_before = normalize_merchant_purse_cp(merchant.get("purse_cp"), None);
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", merchant.get("id"));
    put(&mut payload, "service_id", service.get("service_id"));
    put(&mut payload, "service_name", service.get("name"));
    put(&mut payload, "service_kind", service.get("kind"));
    put(&mut payload, "duration_minutes", service.get("duration_minutes"));
    put(&mut payload, "requires_presence", service.get("requires_presence"));
    put(&mut payload, "base_price_cp", quote.get("base_price_cp"));
    payload.insert("total_price_cp".into(), json!(total));
    put(&mut payload, "price_multiplier_bps", quote.get("multiplier_bps"));
    put(&mut payload, "price_provenance", quote.get("price_provenance"));
    payload.insert("currency_before".into(), normalize_currency(actor.get("currency")));
    payload.insert("currency_after".into(), copper_to_currency(Some(&json!(balance_before - total))));
    payload.insert("balance_before_cp".into(), json!(balance_before));
    payload.insert("balance_after_cp".into(), json!(balance_before - total));
    payload.insert("merchant_purse_before_cp".into(), json!(purse_before));
    payload.insert("merchant_purse_after_cp".into(), json!(purse_before + total));
    payload.insert("policy_id".into(), json!(MERCHANT_SERVICES_POLICY_ID));
    payload.insert("economy_policy_id".into(), json!(ECONOMY_POLICY_ID));
    payload.insert("request_fingerprint".into(), fingerprint_or_null(&r.command));
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&r.command, "MerchantServicePurchased", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `String(x ?? fallback).slice(0, max)`.
fn name_or(value: Option<&Value>, fallback: &Value, max: usize) -> String {
    let text = match value.filter(|value| !value.is_null()) {
        Some(value) => js::s(Some(value)),
        None => js::string(Some(fallback)),
    };
    slice_utf16(&text, max)
}

/// `SellItem` (20476–20541).
pub fn sell_item(r: &mut Resolve<'_>) -> Step {
    let (actor, merchant) = parties(r);
    let item = inventory_item(actor.as_ref(), r.command.get("item_id")).cloned();
    if js::is_true(r.command.get("merchant_refuses_stolen")) {
        let merchant_id = field(&r.command, "merchant_id");
        let stance = fence_stance_for(&r.state, Some(&merchant_id), item.as_ref());
        let source = command_with_rules(&r.command, &[rule_ids::SELLING_EQUIPMENT]);
        let merchant_name = name_or(merchant.as_ref().and_then(|merchant| merchant.get("name")), &merchant_id, 160);
        let item_name = slice_utf16(&js::s(item.as_ref().and_then(|item| item.get("name"))), 120);
        let targets = actor_targets(&r.command);
        r.events.push(event_from(
            &source,
            "MerchantRefusedStolenGoods",
            Some(json!({
                "merchant_id": js::string(Some(&merchant_id)),
                "merchant_name": merchant_name,
                "item_id": js::string(r.command.get("item_id")),
                "item_name": item_name,
            })),
            Some(&targets),
        ));
        let options = json!({ "wantedLevel": sk_society::law_and_order::wanted_level_here(&r.state), "itemId": js::string(r.command.get("item_id")) });
        if sk_society::underworld::fence_denunciation_for(&r.state, &field(&stance, "npc"), &options).is_some() {
            let targets = json!([js::string(Some(&merchant_id))]);
            r.events.push(event_from(
                &source,
                "MerchantDenouncedThief",
                Some(json!({
                    "merchant_id": js::string(Some(&merchant_id)),
                    "merchant_name": merchant_name,
                    "hero_id": js::string(r.command.get("actor_id")),
                    "item_name": item_name,
                })),
                Some(&targets),
            ));
        }
        return Ok(());
    }
    let (Some(actor), Some(merchant)) = (actor, merchant) else { return Err(missing("id")) };
    let appraisal = trusted_item_appraisal_for(&r.state, actor.get("id"), item.as_ref());
    let merchant_id = field(&merchant, "id");
    let reputation = json!(sk_society::reputation_policy::reputation_price_bps(&r.state, &merchant_id));
    let stance = fence_stance_for(&r.state, Some(&merchant_id), item.as_ref());
    let Some(quote) = quote_merchant_sell_unit(Some(&merchant), actor.get("id"), item.as_ref(), appraisal.as_ref(), Some(&reputation), stance.get("discountBps")) else { return Err(missing("unit_price_cp")) };
    let total = checked_transaction_total(quote.get("unit_price_cp"), r.command.get("quantity")).map_err(Halt::Rule)?;
    let Some(item) = item else { return Err(missing("id")) };
    let balance_before = currency_to_copper(actor.get("currency"));
    let purse_before = normalize_merchant_purse_cp(merchant.get("purse_cp"), None);
    let catalog = resolve_catalog_price(Some(&item));
    let key = inventory_stack_key(Some(&item));
    let stock: &[Value] = merchant.get("stock").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let matching = stock.iter().find(|entry| inventory_stack_key(Some(entry)) == key);
    let resale_stock_id = match matching.and_then(|entry| entry.get("stock_id")).filter(|id| !id.is_null()) {
        Some(id) => id.clone(),
        None => Value::String(format!("resale:{}", (r.uuid)())),
    };
    let mut source = crate::core::spread_value(Some(&item));
    source.insert("item_id".into(), field(&item, "id"));
    let mut resale = inventory_item_from_stock(Some(&Value::Object(source)));
    resale["quantity"] = field(&r.command, "quantity");
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", merchant.get("id"));
    payload.insert("stock_id".into(), resale_stock_id);
    payload.insert("catalog_id".into(), or_null(item.get("catalog_id")));
    payload.insert("item".into(), resale);
    if let Some(appraisal) = appraisal.as_ref().filter(|appraisal| js::truthy(Some(appraisal))) {
        payload.insert("appraisal".into(), appraisal.clone());
    }
    put(&mut payload, "quantity", r.command.get("quantity"));
    put(&mut payload, "base_unit_price_cp", quote.get("base_unit_price_cp"));
    put(&mut payload, "unit_price_cp", quote.get("unit_price_cp"));
    payload.insert("total_price_cp".into(), json!(total));
    put(&mut payload, "price_multiplier_bps", quote.get("multiplier_bps"));
    let provenance = catalog
        .as_ref()
        .and_then(|catalog| catalog.get("provenance"))
        .filter(|value| !value.is_null())
        .or_else(|| appraisal.as_ref().and_then(|appraisal| appraisal.get("provenance")).filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!("custom"));
    payload.insert("price_provenance".into(), provenance);
    payload.insert("price_source_version".into(), or_null(catalog.as_ref().and_then(|catalog| catalog.get("source_version"))));
    payload.insert("currency_before".into(), normalize_currency(actor.get("currency")));
    payload.insert("currency_after".into(), copper_to_currency(Some(&json!(balance_before + total))));
    payload.insert("balance_before_cp".into(), json!(balance_before));
    payload.insert("balance_after_cp".into(), json!(balance_before + total));
    payload.insert("merchant_purse_before_cp".into(), json!(purse_before));
    payload.insert("merchant_purse_after_cp".into(), json!(purse_before - total));
    payload.insert("policy_id".into(), json!(ECONOMY_POLICY_ID));
    payload.insert("request_fingerprint".into(), fingerprint_or_null(&r.command));
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&r.command, "MerchantSaleCompleted", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// Событие жизненного цикла торговца: `request_fingerprint` — как в команде
/// (`undefined` не попадает в JSON), цели — пустые.
fn lifecycle_event(r: &mut Resolve<'_>, event_type: &str, mut payload: Map<String, Value>) {
    payload.insert("policy_id".into(), json!(ECONOMY_POLICY_ID));
    put(&mut payload, "request_fingerprint", r.command.get("request_fingerprint"));
    r.events.push(event_from(&r.command, event_type, Some(Value::Object(payload)), Some(&json!([]))));
}

/// `CreateMerchant` (20542–20549).
pub fn create_merchant(r: &mut Resolve<'_>) -> Step {
    let merchant = r.command.get("merchant").cloned();
    let Some(merchant) = merchant.filter(|merchant| !merchant.is_null()) else { return Err(missing("id")) };
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", merchant.get("id"));
    payload.insert("merchant".into(), merchant);
    lifecycle_event(r, "MerchantCreated", payload);
    Ok(())
}

/// `ConfigureMerchant` (20550–20559).
pub fn configure_merchant(r: &mut Resolve<'_>) -> Step {
    let configuration = r.command.get("configuration").cloned().unwrap_or(Value::Null);
    let Some(fields) = configuration.as_object() else { return Err(Fault::type_error("Cannot convert undefined or null to object").into()) };
    let changed: Vec<String> = js::keys(fields).into_iter().cloned().collect();
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", r.command.get("merchant_id"));
    payload.insert("configuration".into(), configuration.clone());
    payload.insert("changed_fields".into(), js::strings_value(changed));
    payload.insert("reset_bargains".into(), json!(js::is_true(r.command.get("reset_bargains"))));
    lifecycle_event(r, "MerchantConfigured", payload);
    Ok(())
}

/// `RestockMerchant` (20560–20568).
pub fn restock_merchant(r: &mut Resolve<'_>) -> Step {
    let items = r.command.get("items").cloned().unwrap_or(Value::Null);
    let Some(entries) = items.as_array() else { return Err(missing("reduce")) };
    let total: f64 = entries.iter().map(|entry| js::number(entry.get("quantity_added"))).sum();
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", r.command.get("merchant_id"));
    payload.insert("entries".into(), items.clone());
    payload.insert("total_quantity_added".into(), js::num(total));
    lifecycle_event(r, "MerchantRestocked", payload);
    Ok(())
}

/// `MoveMerchant` (20569–20581).
pub fn move_merchant(r: &mut Resolve<'_>) -> Step {
    let Some(merchant) = find_merchant(&r.state, r.command.get("merchant_id")).cloned() else { return Err(missing("location")) };
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", r.command.get("merchant_id"));
    put(&mut payload, "location_before", merchant.get("location"));
    put(&mut payload, "location_after", r.command.get("location"));
    payload.insert("location_id_before".into(), merchant.get("location_id").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
    payload.insert("location_id_after".into(), r.command.get("location_id").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
    lifecycle_event(r, "MerchantMoved", payload);
    Ok(())
}

/// `SetMerchantAvailability` (20582–20592).
pub fn set_merchant_availability(r: &mut Resolve<'_>) -> Step {
    let Some(merchant) = find_merchant(&r.state, r.command.get("merchant_id")).cloned() else { return Err(missing("available")) };
    let mut payload = Map::new();
    put(&mut payload, "merchant_id", r.command.get("merchant_id"));
    payload.insert("available_before".into(), json!(!js::is_false(merchant.get("available"))));
    put(&mut payload, "available_after", r.command.get("available"));
    lifecycle_event(r, "MerchantAvailabilityChanged", payload);
    Ok(())
}

/// `PickpocketNpc` (20609–20679).
pub fn pickpocket_npc(r: &mut Resolve<'_>) -> Step {
    use sk_items::pickpocket::{PICKPOCKET_ABILITY, PICKPOCKET_POLICY_ID, PICKPOCKET_SKILL};
    let Some(declared) = r.command.get("pickpocket").filter(|value| !value.is_null()).cloned() else { return Err(missing("npc_id")) };
    let actor = player_actor(&r.state, r.command.get("actor_id")).cloned();
    let npc_id = declared.get("npc_id").cloned().unwrap_or(Value::Null);
    let npc_key = js::string(Some(&npc_id));
    let modifier = ability_modifier(actor.as_ref().and_then(|actor| actor.get("abilities")).and_then(|abilities| abilities.get(PICKPOCKET_ABILITY)))
        + crate::checks::skills::skill_proficiency_bonus(actor.as_ref(), PICKPOCKET_SKILL, Some(&r.state));
    let mut options = Map::new();
    options.insert("modifier".into(), json!(modifier));
    put(&mut options, "difficulty", declared.get("difficulty"));
    options.insert("purpose".into(), json!(format!("pickpocket:{npc_key}")));
    put(&mut options, "actorId", r.command.get("actor_id"));
    options.insert("visibility".into(), r.command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("party")));
    let options = Value::Object(options);
    let roll = match crate::checks::saves::check_roll_from_verified(r.command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => r.dice.roll_check(&options)?,
    };
    r.rolls.push(roll.clone());
    let actor_targets = actor_targets(&r.command);
    let mut check = crate::core::spread_value(Some(&roll));
    check.insert("ability".into(), json!(PICKPOCKET_ABILITY));
    check.insert("skill".into(), json!(PICKPOCKET_SKILL));
    check.insert("pickpocket".into(), json!({ "npc_id": npc_id }));
    let check_source = command_with_rules(&r.command, &[rule_ids::ABILITY_CHECK]);
    r.events.push(event_from(&check_source, "AbilityCheckResolved", Some(Value::Object(check)), Some(&actor_targets)));
    let hidden = command_with_rules(&command_with(&r.command, "visibility", json!("gm_only")), &[rule_ids::CONDITIONS]);
    let npc_targets = json!([npc_id]);
    r.events.push(event_from(
        &hidden,
        "ConditionAdded",
        Some(json!({ "condition": pickpocket_spent_condition(Some(&npc_id)), "duration": "until-long-rest", "source_actor": field(&r.command, "actor_id") })),
        Some(&npc_targets),
    ));
    if js::truthy(roll.get("success")) {
        let mut npc = Map::new();
        npc.insert("id".into(), npc_id.clone());
        put(&mut npc, "name", declared.get("npc_name"));
        npc.insert("role".into(), declared.get("npc_role").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")));
        let pocket = sk_items::pickpocket::npc_pocket_for(&r.state, &Value::Object(npc));
        let balance_before = currency_to_copper(actor.as_ref().and_then(|actor| actor.get("currency")));
        let purse = js::safe_int(pocket.as_ref().and_then(|pocket| pocket.get("purse_cp")), 0).max(0);
        let command_id = js::string(r.command.get("command_id"));
        let stolen = pocket.as_ref().and_then(|pocket| pocket.get("catalog_id")).filter(|id| js::truthy(Some(id))).map(|catalog_id| {
            let instance = json!({ "id": format!("stolen:{}", slice_utf16(&command_id, 90)), "quantity": 1, "equipped": false, "origin": "stolen" });
            let item = sk_items::item_catalog::materialize_catalog_item(&js::s(Some(catalog_id)), Some(&instance));
            let fallback = format!("stolen:{command_id}");
            normalize_inventory_item(Some(&item), InventoryItemOptions { id_fallback: &fallback, preserve_unknown: true, hydrate_catalog: false })
        });
        let mut payload = Map::new();
        payload.insert("npc_id".into(), npc_id.clone());
        put(&mut payload, "npc_name", declared.get("npc_name"));
        payload.insert("purse_cp".into(), json!(purse));
        payload.insert("balance_before_cp".into(), json!(balance_before));
        payload.insert("balance_after_cp".into(), json!(balance_before + purse));
        payload.insert("currency_after".into(), copper_to_currency(Some(&json!(balance_before + purse))));
        if let Some(item) = stolen {
            payload.insert("item".into(), item);
        }
        payload.insert("policy_id".into(), json!(PICKPOCKET_POLICY_ID));
        let source = command_with_rules(&r.command, &[rule_ids::ECONOMY_COINS]);
        r.events.push(event_from(&source, "NpcPocketPicked", Some(Value::Object(payload)), Some(&actor_targets)));
        return Ok(());
    }
    let mut payload = Map::new();
    payload.insert("npc_id".into(), npc_id.clone());
    put(&mut payload, "npc_name", declared.get("npc_name"));
    put(&mut payload, "hero_id", r.command.get("actor_id"));
    put(&mut payload, "crowd_label", declared.get("crowd_label"));
    payload.insert("policy_id".into(), json!(PICKPOCKET_POLICY_ID));
    r.events.push(event_from(&check_source, "NpcPickpocketNoticed", Some(Value::Object(payload)), Some(&npc_targets)));
    let options = json!({
        "npcId": npc_id,
        "heroId": field(&r.command, "actor_id"),
        "delta": crate::constants::PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA,
        "reason": "pickpocket-caught",
    });
    for draft in sk_social::npc_social::npc_relationship_event_drafts(&r.state, &options) {
        let source = command_with(&r.command, "visibility", field(&draft, "visibility"));
        r.events.push(event_from(&source, &js::s(draft.get("event_type")), draft.get("payload").cloned(), draft.get("target_ids")));
    }
    Ok(())
}
