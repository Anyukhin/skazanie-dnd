//! Блоки `validateCommand`: Торговля: жизненный цикл торговцев, сделки, карманная кража. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6922–6954, 7064–7156, 7171–7200. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Продажа краденого честному торговцу в JS выходит из `validateCommand`
//! досрочно (`return command`, 7143). Здесь блок просто заканчивается: все
//! блоки после него отбираются по типу команды, и для `SellItem` ни один не
//! срабатывает — проверка происхождения (7819) видит непустые
//! `source_rule_ids`, которые `normalizeCommand` берёт из `COMMAND_RULES`.

use serde_json::{json, Value};
use sk_core::js;
use sk_economy::merchant_economy::{
    bargain_for, currency_to_copper, find_merchant, find_merchant_service, inventory_item_from_stock, inventory_stack_key, merchant_trade_availability_for, normalize_merchant_purse_cp, quote_merchant_buy_unit,
    quote_merchant_sell_unit, quote_merchant_service, resolve_catalog_price, sellability, trusted_item_appraisal_for, MAX_CURRENCY_CP, MAX_STOCK_QUANTITY, MAX_TRANSACTION_QUANTITY,
};

use super::Validation;
use crate::command::types::MERCHANT_LIFECYCLE_COMMAND_TYPES;
use crate::core::{condition_ids_for, inventory_item, player_actor, same_campaign_party, slice_utf16};
use crate::merchants::{appraisal_blocked, checked_transaction_total, merchant_stock, normalize_lifecycle_configuration, normalize_lifecycle_merchant, normalize_lifecycle_restock};
use crate::normalize::scene::{lifecycle_id, lifecycle_text};
use crate::pause::{rule, Halt, Step};
use crate::society_helpers::{fence_stance_for, inventory_stack_index, living_party_size, pickpocket_spent_condition};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `command.key = value`.
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

fn halt(error: sk_core::RuleError) -> Halt {
    Halt::Rule(error)
}

/// Блок 49 (6922–6954): жизненный цикл торговцев.
pub fn check_merchant_lifecycle(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    if !MERCHANT_LIFECYCLE_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    if !v.context.is_admin() && !v.context.is_director() {
        return Err(rule("Управлять торговцами может только администратор кампании", "MERCHANT_MANAGEMENT_FORBIDDEN"));
    }
    if kind == "CreateMerchant" {
        if v.state.get("merchants").and_then(Value::as_array).map_or(0, Vec::len) >= 100 {
            return Err(rule("Достигнут предел количества торговцев", "MERCHANT_LIMIT_EXCEEDED"));
        }
        let merchant = normalize_lifecycle_merchant(v.command.get("merchant")).map_err(halt)?;
        let id = merchant.get("id").cloned().unwrap_or(Value::Null);
        set_field(&mut v.command, "merchant", merchant);
        set_field(&mut v.command, "merchant_id", id.clone());
        if find_merchant(v.state, Some(&id)).is_some() {
            return Err(rule("Торговец с таким id уже существует", "MERCHANT_ALREADY_EXISTS"));
        }
        return Ok(());
    }
    let id = lifecycle_id(v.command.get("merchant_id"), "INVALID_MERCHANT_ID", "merchant_id").map_err(halt)?;
    set_field(&mut v.command, "merchant_id", Value::String(id.clone()));
    let Some(merchant) = find_merchant(v.state, Some(&Value::String(id))) else {
        return Err(rule("Торговец не найден", "MERCHANT_NOT_FOUND"));
    };
    match kind.as_str() {
        "ConfigureMerchant" => {
            let configuration = normalize_lifecycle_configuration(v.command.get("configuration"), Some(merchant)).map_err(halt)?;
            let reset = configuration.as_object().is_some_and(|map| map.contains_key("pricing"));
            set_field(&mut v.command, "configuration", configuration);
            set_field(&mut v.command, "reset_bargains", Value::Bool(reset));
        }
        "RestockMerchant" => {
            let source = v.command.get("items").filter(|items| !items.is_null()).or_else(|| v.command.get("stock")).cloned();
            let items = normalize_lifecycle_restock(source.as_ref(), merchant).map_err(halt)?;
            set_field(&mut v.command, "items", Value::Array(items));
        }
        "MoveMerchant" => {
            let location = lifecycle_text(v.command.get("location"), 180, true, "", "INVALID_MERCHANT_LOCATION", "Локация торговца").map_err(halt)?;
            set_field(&mut v.command, "location", Value::String(location));
            let location_id = if js::truthy(v.command.get("location_id")) {
                lifecycle_text(v.command.get("location_id"), 120, true, "", "INVALID_MERCHANT_LOCATION_ID", "location_id торговца").map_err(halt)?
            } else {
                String::new()
            };
            set_field(&mut v.command, "location_id", Value::String(location_id));
        }
        "SetMerchantAvailability" => {
            if !v.command.get("available").is_some_and(Value::is_boolean) {
                return Err(rule("Доступность торговца должна быть логическим значением", "INVALID_MERCHANT_AVAILABILITY"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// `inventoryWeight(actor)` числом.
fn inventory_weight(actor: &Value) -> Result<f64, Halt> {
    sk_items_life::item_lifecycle::inventory_weight(Some(actor)).map(|weight| js::number(Some(&weight))).map_err(crate::damage::item_fault)
}

/// Блок 63 (7064–7156): сделки с торговцем.
pub fn check_trade(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    if !["BargainWithMerchant", "AppraiseItem", "BuyItem", "SellItem", "PurchaseMerchantService"].contains(&kind.as_str()) {
        return Ok(());
    }
    let state = v.state;
    let actor = player_actor(state, v.command.get("actor_id"));
    let merchant = find_merchant(state, v.command.get("merchant_id"));
    let Some(actor) = actor else { return Err(rule("Торговать может только герой кампании", "ACTOR_FORBIDDEN")) };
    let Some(merchant) = merchant else { return Err(rule("Торговец не найден", "MERCHANT_NOT_FOUND")) };
    let remote = kind == "PurchaseMerchantService" && find_merchant_service(Some(merchant), v.command.get("service_id")).and_then(|service| service.get("requires_presence")) == Some(&Value::Bool(false));
    let availability = merchant_trade_availability_for(state, Some(merchant), remote);
    if !availability.can_trade {
        let reason = availability.reason.filter(|reason| !reason.is_empty()).unwrap_or_else(|| "Торговец сейчас недоступен".into());
        return Err(rule(reason, availability.code.filter(|code| !code.is_empty()).unwrap_or("MERCHANT_UNAVAILABLE")));
    }
    if sk_core::game::combat_active(state) {
        return Err(rule("Во время боя торговля недоступна", "COMBAT_ACTIVE"));
    }
    let actor_id = actor.get("id");
    let quantity_owned = v.command.get("quantity").cloned();
    let quantity_value = quantity_owned.as_ref();
    let quantity = js::number(quantity_value);
    if kind == "BargainWithMerchant" {
        if bargain_for(Some(merchant), actor_id).is_some() {
            return Err(rule("Условия с этим торговцем уже согласованы", "BARGAIN_ALREADY_RESOLVED"));
        }
    } else if ["BuyItem", "SellItem"].contains(&kind.as_str()) && (!matches!(quantity_value, Some(Value::Number(_))) || !js::is_safe_integer(quantity_value) || quantity < 1.0 || quantity > MAX_TRANSACTION_QUANTITY as f64) {
        return Err(rule("Количество должно быть положительным целым числом в допустимых пределах", "INVALID_QUANTITY"));
    }
    let quantity = quantity as i64;
    let merchant_id = merchant.get("id").cloned().unwrap_or(Value::Null);
    if kind == "AppraiseItem" {
        let Some(item) = inventory_item(Some(actor), v.command.get("item_id")) else {
            return Err(rule("Предмет не найден в инвентаре героя", "ITEM_NOT_FOUND"));
        };
        if resolve_catalog_price(Some(item)).is_some() {
            return Err(rule("Каталожный предмет уже имеет серверную цену", "APPRAISAL_NOT_REQUIRED"));
        }
        if appraisal_blocked(Some(item)) {
            return Err(rule("Этот предмет нельзя оценить для продажи", "ITEM_NOT_APPRAISABLE"));
        }
        if trusted_item_appraisal_for(state, actor_id, Some(item)).is_some() {
            return Err(rule("Предмет уже оценён", "ITEM_ALREADY_APPRAISED"));
        }
    }
    if kind == "BuyItem" {
        let Some(stock) = merchant_stock(Some(merchant), v.command.get("stock_id")) else {
            return Err(rule("Товар не найден на складе торговца", "STOCK_NOT_FOUND"));
        };
        if js::safe_int(stock.get("quantity"), 0) < quantity {
            return Err(rule("У торговца недостаточно товара", "INSUFFICIENT_STOCK"));
        }
        let reputation = json!(sk_society::reputation_policy::reputation_price_bps(state, &merchant_id));
        let Some(quote) = quote_merchant_buy_unit(Some(merchant), actor_id, Some(stock), Some(&reputation)) else {
            return Err(rule("Для товара не задана серверная цена", "PRICE_UNAVAILABLE"));
        };
        let total = checked_transaction_total(quote.get("unit_price_cp"), quantity_value).map_err(halt)?;
        if currency_to_copper(actor.get("currency")) < total {
            return Err(rule("У героя недостаточно монет", "INSUFFICIENT_FUNDS"));
        }
        if normalize_merchant_purse_cp(merchant.get("purse_cp"), None) + total > MAX_CURRENCY_CP {
            return Err(rule("Кошелёк торговца не может вместить столько монет", "MERCHANT_PURSE_LIMIT_EXCEEDED"));
        }
        let purchased = inventory_item_from_stock(Some(stock));
        let weight = js::number(purchased.get("weight"));
        let weight = if weight.is_nan() { 0.0 } else { weight.max(0.0) };
        let capacity = js::number(Some(&sk_items_life::item_lifecycle::carrying_capacity(Some(actor))));
        if inventory_weight(actor)? + weight * quantity as f64 > capacity {
            return Err(rule("Покупка превысит грузоподъёмность героя", "CARRYING_CAPACITY_EXCEEDED"));
        }
        let inventory: &[Value] = actor.get("inventory").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let existing = inventory_stack_index(inventory, &purchased).map(|index| &inventory[index]);
        if existing.is_none() && inventory.len() >= 200 {
            return Err(rule("Инвентарь героя заполнен", "INVENTORY_FULL"));
        }
        if existing.is_some_and(|existing| js::safe_int(existing.get("quantity"), 1) + quantity > MAX_STOCK_QUANTITY) {
            return Err(rule("Превышен предел количества предметов", "INVENTORY_QUANTITY_EXCEEDED"));
        }
    }
    if kind == "PurchaseMerchantService" {
        let Some(service) = find_merchant_service(Some(merchant), v.command.get("service_id")) else {
            return Err(rule("Услуга торговца не найдена", "SERVICE_NOT_FOUND"));
        };
        if js::is_false(service.get("available")) {
            return Err(rule("Услуга торговца сейчас недоступна", "SERVICE_UNAVAILABLE"));
        }
        let standing = sk_society::reputation_policy::reputation_standing_for(state, &merchant_id);
        if !js::truthy(standing.get("services_available")) {
            return Err(rule("Торговец не станет оказывать услуги отряду с такой славой", "SERVICE_REFUSED_BY_REPUTATION"));
        }
        let Some(quote) = quote_merchant_service(Some(merchant), actor_id, Some(service), standing.get("price_adjustment_bps")) else {
            return Err(rule("Для услуги не удалось рассчитать серверную цену", "PRICE_UNAVAILABLE"));
        };
        let total = checked_transaction_total(quote.get("price_cp"), Some(&json!(1))).map_err(halt)?;
        if currency_to_copper(actor.get("currency")) < total {
            return Err(rule("У героя недостаточно монет", "INSUFFICIENT_FUNDS"));
        }
        if normalize_merchant_purse_cp(merchant.get("purse_cp"), None) + total > MAX_CURRENCY_CP {
            return Err(rule("Кошелёк торговца не может вместить столько монет", "MERCHANT_PURSE_LIMIT_EXCEEDED"));
        }
    }
    if kind == "SellItem" {
        let Some(item) = inventory_item(Some(actor), v.command.get("item_id")) else {
            return Err(rule("Предмет не найден в инвентаре героя", "ITEM_NOT_FOUND"));
        };
        if js::safe_int(item.get("quantity"), 1) < quantity {
            return Err(rule("В инвентаре недостаточно предметов", "INSUFFICIENT_ITEMS"));
        }
        let appraisal = trusted_item_appraisal_for(state, actor_id, Some(item));
        let allowed = sellability(Some(item), appraisal.as_ref());
        if !allowed.can_sell {
            let code = if js::truthy(item.get("equipped")) {
                "ITEM_EQUIPPED"
            } else if js::truthy(item.get("attuned_to")) {
                "ITEM_ATTUNED"
            } else {
                "ITEM_NOT_SELLABLE"
            };
            return Err(rule(js::s(allowed.reason.map(Value::from).as_ref()), code));
        }
        let stance = fence_stance_for(state, Some(&merchant_id), Some(item));
        let refuses = js::truthy(stance.get("refuses"));
        set_field(&mut v.command, "merchant_refuses_stolen", Value::Bool(refuses));
        if refuses {
            return Ok(());
        }
        let reputation = json!(sk_society::reputation_policy::reputation_price_bps(state, &merchant_id));
        let Some(quote) = quote_merchant_sell_unit(Some(merchant), actor_id, Some(item), appraisal.as_ref(), Some(&reputation), stance.get("discountBps")) else {
            return Err(rule("Для предмета не задана серверная цена", "PRICE_UNAVAILABLE"));
        };
        let total = checked_transaction_total(quote.get("unit_price_cp"), quantity_value).map_err(halt)?;
        if normalize_merchant_purse_cp(merchant.get("purse_cp"), None) < total {
            return Err(rule("У торговца недостаточно монет для выкупа предмета", "INSUFFICIENT_MERCHANT_FUNDS"));
        }
        if currency_to_copper(actor.get("currency")) + total > MAX_CURRENCY_CP {
            return Err(rule("Кошелёк героя не может вместить столько монет", "CURRENCY_LIMIT_EXCEEDED"));
        }
        let key = inventory_stack_key(Some(item));
        let stock: &[Value] = merchant.get("stock").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let matching = stock.iter().find(|entry| inventory_stack_key(Some(entry)) == key);
        if matching.is_some_and(|entry| js::safe_int(entry.get("quantity"), 0) + quantity > MAX_STOCK_QUANTITY) {
            return Err(rule("Склад торговца заполнен", "STOCK_LIMIT_EXCEEDED"));
        }
        if matching.is_none() && stock.len() >= 500 {
            return Err(rule("Склад торговца заполнен", "MERCHANT_STOCK_FULL"));
        }
    }
    Ok(())
}

/// Блок 64 (7171–7200): карманная кража.
pub fn check_pickpocket(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "PickpocketNpc" {
        return Ok(());
    }
    let state = v.state;
    let actor = player_actor(state, v.command.get("actor_id"));
    let npc_id = js::s(v.command.get("npc_id"));
    let Some(actor) = actor.filter(|actor| sk_core::game::is_living_actor(actor)) else {
        return Err(rule("Обчистить карман может только живой герой", "ACTOR_DEFEATED"));
    };
    if !same_campaign_party(state, &js::string(v.command.get("actor_id"))) {
        return Err(rule("Карманы чистит герой отряда", "ACTOR_FORBIDDEN"));
    }
    if player_actor(state, Some(&Value::String(npc_id.clone()))).is_some() || sk_core::game::find_actor(state, &npc_id).is_some() {
        return Err(rule("У своих не крадут: обчистить можно только чужой карман", "PICKPOCKET_PARTY_TARGET_FORBIDDEN"));
    }
    if sk_core::game::combat_active(state) {
        return Err(rule("Посреди боя карманов не чистят", "COMBAT_ACTIVE"));
    }
    let present_npcs = sk_npc_world::npc_positioning::present_scene_npcs(state);
    let Some(npc) = present_npcs.iter().find(|candidate| js::string(candidate.get("id")) == npc_id) else {
        return Err(rule("Этого человека нет рядом", "NPC_NOT_PRESENT"));
    };
    let actor_at = sk_core::game::actor_position(state, &js::s(v.command.get("actor_id")));
    let placement = crate::tactical_geometry::npc_positioning::npc_placement_for(state, &npc_id, None);
    let distance = match (actor_at, placement) {
        (Some(at), Some(placement)) => {
            let anchor = json!({ "x": at.x, "y": at.y });
            sk_geometry::actor_footprint::footprint_distance_feet(Some(actor), Some(&json!([placement])), Some(&anchor), None).unwrap_or(0.0)
        }
        _ => f64::INFINITY,
    };
    if distance > 5.0 {
        return Err(rule("До кармана надо дойти: встаньте вплотную, в пределах 5 футов", "PICKPOCKET_OUT_OF_REACH"));
    }
    if condition_ids_for(state, &npc_id).contains(&pickpocket_spent_condition(Some(&Value::String(npc_id.clone())))) {
        return Err(rule("У этого человека карман уже пуст", "PICKPOCKET_POCKET_EMPTY"));
    }
    let present = present_npcs.len() + living_party_size(state);
    let name = match npc.get("name").filter(|name| !name.is_null()) {
        Some(name) => js::s(Some(name)),
        None => npc_id.clone(),
    };
    let mut declared = serde_json::Map::new();
    declared.insert("npc_id".into(), Value::String(npc_id.clone()));
    declared.insert("npc_name".into(), Value::String(slice_utf16(&name, 160)));
    let difficulty = sk_items::pickpocket::pickpocket_difficulty_for(state, npc, Some(&json!(present)));
    for (key, value) in crate::core::spread_value(Some(&difficulty)) {
        declared.insert(key, value);
    }
    declared.insert("present_count".into(), json!(present));
    set_field(&mut v.command, "pickpocket", Value::Object(declared));
    Ok(())
}
