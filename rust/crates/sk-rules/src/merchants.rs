//! Торговля: жизненный цикл торговцев, оценка, запас, сделки, журнал экономики. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 1012–1022, 1381–1661, 5431–5475, 5484–5495, 24011, 24096–24117.
//!
//! Нормализаторы жизненного цикла (`normalizeLifecycle*`, `lifecycle*FromCanonical`)
//! общие у проверки команд торговцев и редьюсера: событие хранит уже
//! канонический вид, и replay прогоняет его через тот же нормализатор. Базовые
//! проверки полей (`lifecycleObject`, `lifecycleId`, `lifecycleText`, …) —
//! `normalize/scene.rs` (Р4).

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_core::RuleError;
use sk_economy::merchant_economy::{
    inventory_stack_key, normalize_inventory_item, normalize_merchant, normalize_merchant_pricing, normalize_merchant_restock_policy, normalize_merchant_services, resolve_catalog_price, InventoryItemOptions,
    ECONOMY_CATALOG_VERSION, MAX_CURRENCY_CP, MAX_STOCK_QUANTITY, MAX_TRANSACTION_QUANTITY,
};

use crate::core::slice_utf16;
use crate::pause::{Fault, Halt};
use crate::normalize::scene::{assert_lifecycle_keys, lifecycle_id, lifecycle_integer, lifecycle_object, lifecycle_purse_cp, lifecycle_text};

/// `MERCHANT_CONFIGURATION_FIELDS` (1012).
pub const MERCHANT_CONFIGURATION_FIELDS: &[&str] = &["name", "title", "description", "greeting", "voice", "pricing", "purse_cp"];
/// `MERCHANT_CREATE_FIELDS` (1013–1015).
pub const MERCHANT_CREATE_FIELDS: &[&str] = &[
    "name", "title", "description", "greeting", "voice", "pricing", "purse_cp", "id", "merchant_id", "location", "location_id", "available", "stock", "services", "restock_policy",
];
/// `MERCHANT_PRICING_FIELDS` (1016–1019).
pub const MERCHANT_PRICING_FIELDS: &[&str] = &[
    "mode", "buy_markup_bps", "sell_rate_bps", "bargain_dc", "success_discount_bps", "failure_markup_bps", "agent_adjustment_bps", "agent_adjustment_limit_percent", "description",
];
/// `MERCHANT_STOCK_FIELDS` (1020–1022).
pub const MERCHANT_STOCK_FIELDS: &[&str] = &["stock_id", "catalog_id", "quantity", "name", "type", "weight", "rarity", "description", "properties"];

fn reject(message: impl Into<String>, code: &str) -> RuleError {
    RuleError::new(code, message)
}

/// Поле объекта, если оно есть (`undefined` — нет).
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// Объект из выбранных полей источника (`{ a: input?.a, … }`): отсутствующее
/// поле — `undefined`, в JSON его нет.
fn pick(source: Option<&Value>, fields: &[&str]) -> Value {
    let mut map = Map::new();
    for field in fields {
        put(&mut map, field, source.and_then(|source| source.get(*field)));
    }
    Value::Object(map)
}

/// `normalizeLifecyclePricing(input = {}, current = {})` (1381–1430).
pub fn normalize_lifecycle_pricing(input: Option<&Value>, current: Option<&Value>) -> Result<Value, RuleError> {
    let empty = Map::new();
    let source = match input {
        None | Some(Value::Null) => &empty,
        some => lifecycle_object(some, "INVALID_MERCHANT_PRICING", "Политика цен")?,
    };
    assert_lifecycle_keys(source, MERCHANT_PRICING_FIELDS, "INVALID_MERCHANT_PRICING", "Политика цен")?;
    let baseline = normalize_merchant_pricing(current);
    let mode = match source.get("mode").filter(|mode| !mode.is_null()) {
        None => baseline.get("mode").cloned().unwrap_or(Value::Null),
        Some(mode) => mode.clone(),
    };
    if !matches!(mode.as_str(), Some("catalog" | "catalog_with_agent_adjustment")) {
        return Err(reject("Неизвестный режим политики цен", "INVALID_MERCHANT_PRICING"));
    }
    let code = "INVALID_MERCHANT_PRICING";
    let limit_fallback = js::safe_int(baseline.get("agent_adjustment_limit_percent"), 20).min(20);
    let adjustment_limit_percent = lifecycle_integer(source.get("agent_adjustment_limit_percent"), 0, 20, Value::from(limit_fallback), code, "Лимит агентской корректировки")?;
    let base = |key: &str| baseline.get(key).cloned().unwrap_or(Value::Null);
    let buy_markup_bps = lifecycle_integer(source.get("buy_markup_bps"), 1_000, 30_000, base("buy_markup_bps"), code, "Наценка")?;
    let sell_rate_bps = lifecycle_integer(source.get("sell_rate_bps"), 1_000, 30_000, base("sell_rate_bps"), code, "Ставка выкупа")?;
    let bargain_dc = lifecycle_integer(source.get("bargain_dc"), 5, 30, base("bargain_dc"), code, "Сложность торга")?;
    let success_discount_bps = lifecycle_integer(source.get("success_discount_bps"), 0, 5_000, base("success_discount_bps"), code, "Скидка за успешный торг")?;
    let failure_markup_bps = lifecycle_integer(source.get("failure_markup_bps"), 0, 5_000, base("failure_markup_bps"), code, "Наценка за неудачный торг")?;
    let agent_adjustment_bps = lifecycle_integer(source.get("agent_adjustment_bps"), -2_000, 2_000, base("agent_adjustment_bps"), code, "Агентская корректировка")?;
    let description_fallback = match baseline.get("description") {
        Some(Value::String(text)) => slice_utf16(text, 500),
        _ => String::new(),
    };
    let description = lifecycle_text(source.get("description"), 500, false, &description_fallback, code, "Описание политики цен")?;
    let mut request = Map::new();
    request.insert("mode".into(), mode);
    request.insert("catalog_id".into(), json!(ECONOMY_CATALOG_VERSION));
    request.insert("buy_markup_bps".into(), buy_markup_bps);
    request.insert("sell_rate_bps".into(), sell_rate_bps);
    request.insert("bargain_dc".into(), bargain_dc);
    request.insert("success_discount_bps".into(), success_discount_bps);
    request.insert("failure_markup_bps".into(), failure_markup_bps);
    request.insert("min_multiplier_bps".into(), json!(1_000));
    request.insert("max_multiplier_bps".into(), json!(30_000));
    request.insert("agent_adjustment_bps".into(), agent_adjustment_bps);
    request.insert("agent_adjustment_limit_percent".into(), adjustment_limit_percent);
    request.insert("description".into(), Value::String(description));
    let normalized = normalize_merchant_pricing(Some(&Value::Object(request)));
    let field = |key: &str| normalized.get(key).cloned().unwrap_or(Value::Null);
    let mut pricing = Map::new();
    pricing.insert("mode".into(), field("mode"));
    pricing.insert("catalog_id".into(), json!(ECONOMY_CATALOG_VERSION));
    for key in ["buy_markup_bps", "sell_rate_bps", "bargain_dc", "success_discount_bps", "failure_markup_bps"] {
        pricing.insert(key.into(), field(key));
    }
    pricing.insert("min_multiplier_bps".into(), json!(1_000));
    pricing.insert("max_multiplier_bps".into(), json!(30_000));
    for key in ["agent_adjustment_bps", "agent_adjustment_limit_percent", "buy_markup_percent", "sell_rate_percent", "description"] {
        put(&mut pricing, key, normalized.get(key));
    }
    Ok(Value::Object(pricing))
}

/// `lifecycleText(…, { fallback: undefined })`: `None` — `undefined`.
fn lifecycle_text_or_undefined(value: Option<&Value>, maximum: usize, code: &str, label: &str) -> Result<Option<String>, RuleError> {
    if !js::present(value) {
        return Ok(None);
    }
    lifecycle_text(value, maximum, false, "", code, label).map(Some)
}

/// `normalizeLifecycleStockEntry(input, merchantId, index = 0)` (1432–1474).
pub fn normalize_lifecycle_stock_entry(input: Option<&Value>, merchant_id: &str, index: usize) -> Result<Value, RuleError> {
    let source = lifecycle_object(input, "INVALID_MERCHANT_STOCK", "Позиция склада")?;
    assert_lifecycle_keys(source, MERCHANT_STOCK_FIELDS, "INVALID_MERCHANT_STOCK", "Позиция склада")?;
    let stock_id = lifecycle_id(source.get("stock_id"), "INVALID_STOCK_ID", "stock_id")?;
    let catalog_id = lifecycle_id(source.get("catalog_id"), "INVALID_CATALOG_ITEM", "catalog_id")?;
    let Some(catalog) = resolve_catalog_price(Some(&json!({ "catalog_id": catalog_id }))) else {
        return Err(reject(format!("Товар {catalog_id} отсутствует в серверном каталоге"), "CATALOG_ITEM_REQUIRED"));
    };
    let quantity = lifecycle_integer(source.get("quantity"), 1, MAX_STOCK_QUANTITY, Value::from(1), "INVALID_QUANTITY", "Количество товара")?;
    let code = "INVALID_MERCHANT_STOCK";
    let mut instance = Map::new();
    instance.insert("id".into(), Value::String(slice_utf16(&format!("{merchant_id}:{stock_id}"), 120)));
    instance.insert("name".into(), Value::String(lifecycle_text(source.get("name"), 120, false, "", code, "Название товара")?));
    instance.insert("type".into(), Value::String(lifecycle_text(source.get("type"), 40, false, "other", code, "Тип товара")?));
    instance.insert("quantity".into(), quantity.clone());
    put(&mut instance, "weight", source.get("weight"));
    if let Some(rarity) = lifecycle_text_or_undefined(source.get("rarity"), 60, code, "Редкость товара")? {
        instance.insert("rarity".into(), Value::String(rarity));
    }
    instance.insert("description".into(), Value::String(lifecycle_text(source.get("description"), 1_000, false, "", code, "Описание товара")?));
    instance.insert("properties".into(), Value::String(lifecycle_text(source.get("properties"), 500, false, "", code, "Свойства товара")?));
    instance.insert("equipped".into(), Value::Bool(false));
    let materialized = sk_items::item_catalog::materialize_catalog_item(&catalog_id, Some(&Value::Object(instance)));
    let id_fallback = format!("{merchant_id}-stock-{}", index + 1);
    let item = normalize_inventory_item(Some(&materialized), InventoryItemOptions { id_fallback: &id_fallback, preserve_unknown: false, hydrate_catalog: false });
    let mut entry = Map::new();
    entry.insert("stock_id".into(), Value::String(stock_id));
    entry.insert("catalog_id".into(), Value::String(catalog_id));
    put(&mut entry, "catalog_schema_version", item.get("catalog_schema_version"));
    put(&mut entry, "name", item.get("name"));
    put(&mut entry, "type", item.get("type"));
    entry.insert("quantity".into(), quantity);
    put(&mut entry, "base_price_cp", catalog.get("base_price_cp"));
    for key in ["weight", "rarity", "description", "properties", "mechanics_status"] {
        put(&mut entry, key, item.get(key));
    }
    if let Some(combat) = item.get("combat").filter(|combat| js::truthy(Some(combat))) {
        entry.insert("combat".into(), combat.clone());
    }
    entry.insert("equipped".into(), Value::Bool(false));
    Ok(Value::Object(entry))
}

const STOCK_CANONICAL_FIELDS: &[&str] = &["stock_id", "catalog_id", "quantity", "name", "type", "weight", "rarity", "description", "properties"];

/// `lifecycleStockFromCanonical(input, merchantId, index = 0)` (1476–1488).
pub fn lifecycle_stock_from_canonical(input: Option<&Value>, merchant_id: &str, index: usize) -> Result<Value, RuleError> {
    normalize_lifecycle_stock_entry(Some(&pick(input, STOCK_CANONICAL_FIELDS)), merchant_id, index)
}

/// `normalizeLifecycleMerchant(input)` (1490–1549).
pub fn normalize_lifecycle_merchant(input: Option<&Value>) -> Result<Value, RuleError> {
    let source = lifecycle_object(input, "INVALID_MERCHANT_DATA", "Торговец")?;
    assert_lifecycle_keys(source, MERCHANT_CREATE_FIELDS, "INVALID_MERCHANT_DATA", "Торговец")?;
    let raw_id = source.get("id").filter(|id| !id.is_null()).or_else(|| source.get("merchant_id"));
    let id = lifecycle_id(raw_id, "INVALID_MERCHANT_ID", "id торговца")?;
    let stock_input: &[Value] = match source.get("stock") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(items)) if items.len() <= 500 => items,
        _ => return Err(reject("Склад торговца должен содержать не более 500 позиций", "INVALID_MERCHANT_STOCK")),
    };
    let mut seen = std::collections::HashSet::new();
    let mut stock = Vec::new();
    for (index, entry) in stock_input.iter().enumerate() {
        let normalized = normalize_lifecycle_stock_entry(Some(entry), &id, index)?;
        let stock_id = js::s(normalized.get("stock_id"));
        if !seen.insert(stock_id) {
            return Err(reject("stock_id должен быть уникальным", "DUPLICATE_STOCK_ID"));
        }
        stock.push(normalized);
    }
    if js::present(source.get("available")) && !source.get("available").is_some_and(Value::is_boolean) {
        return Err(reject("Доступность торговца должна быть логическим значением", "INVALID_MERCHANT_AVAILABILITY"));
    }
    let location = lifecycle_text(source.get("location"), 180, true, "", "INVALID_MERCHANT_LOCATION", "Локация торговца")?;
    let location_id = if js::truthy(source.get("location_id")) {
        lifecycle_text(source.get("location_id"), 120, true, "", "INVALID_MERCHANT_LOCATION_ID", "location_id торговца")?
    } else {
        String::new()
    };
    let purse_cp = lifecycle_purse_cp(source.get("purse_cp"), None)?;
    let pricing = normalize_lifecycle_pricing(source.get("pricing"), None)?;
    let data = "INVALID_MERCHANT_DATA";
    let mut request = Map::new();
    request.insert("id".into(), Value::String(id.clone()));
    request.insert("name".into(), Value::String(lifecycle_text(source.get("name"), 120, true, "", data, "Имя торговца")?));
    request.insert("title".into(), Value::String(lifecycle_text(source.get("title"), 180, false, "", data, "Титул торговца")?));
    request.insert("description".into(), Value::String(lifecycle_text(source.get("description"), 1_000, false, "", data, "Описание торговца")?));
    request.insert("greeting".into(), Value::String(lifecycle_text(source.get("greeting"), 500, false, "", data, "Приветствие торговца")?));
    request.insert("voice".into(), Value::String(lifecycle_text(source.get("voice"), 500, false, "", data, "Манера речи торговца")?));
    request.insert("location".into(), Value::String(location));
    request.insert("location_id".into(), Value::String(location_id));
    request.insert("available".into(), Value::Bool(!js::is_false(source.get("available"))));
    request.insert("purse_cp".into(), purse_cp);
    request.insert("pricing".into(), pricing.clone());
    request.insert("stock".into(), Value::Array(stock));
    put(&mut request, "services", source.get("services"));
    put(&mut request, "restock_policy", source.get("restock_policy"));
    request.insert("bargains".into(), json!({}));
    let normalized = normalize_merchant(Some(&Value::Object(request)), 0);
    let field = |key: &str| normalized.get(key).cloned().unwrap_or(Value::Null);
    let mut canonical_stock = Vec::new();
    for (index, entry) in normalized.get("stock").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
        canonical_stock.push(lifecycle_stock_from_canonical(Some(entry), &id, index)?);
    }
    let mut merchant = Map::new();
    for key in ["id", "name", "title", "description", "greeting", "voice", "location", "location_id", "available", "purse_cp"] {
        merchant.insert(key.into(), field(key));
    }
    merchant.insert("pricing".into(), pricing);
    merchant.insert("stock".into(), Value::Array(canonical_stock));
    merchant.insert("services".into(), Value::Array(normalize_merchant_services(normalized.get("services"))));
    merchant.insert("restock_policy".into(), normalize_merchant_restock_policy(normalized.get("restock_policy"), normalized.get("stock")));
    merchant.insert("bargains".into(), json!({}));
    Ok(Value::Object(merchant))
}

const PRICING_CANONICAL_FIELDS: &[&str] = &[
    "mode", "buy_markup_bps", "sell_rate_bps", "bargain_dc", "success_discount_bps", "failure_markup_bps", "agent_adjustment_bps", "agent_adjustment_limit_percent", "description",
];

/// `lifecyclePricingFromCanonical(input, current = {})` (1551–1563).
pub fn lifecycle_pricing_from_canonical(input: Option<&Value>, current: Option<&Value>) -> Result<Value, RuleError> {
    normalize_lifecycle_pricing(Some(&pick(input, PRICING_CANONICAL_FIELDS)), current)
}

/// `lifecycleMerchantFromCanonical(input)` (1565–1601).
pub fn lifecycle_merchant_from_canonical(input: Option<&Value>) -> Result<Value, RuleError> {
    let get = |key: &str| input.and_then(|input| input.get(key));
    let mut source = Map::new();
    put(&mut source, "id", get("id").filter(|id| !id.is_null()).or_else(|| get("merchant_id")));
    for key in ["name", "title", "description", "greeting", "voice", "location", "location_id", "available", "purse_cp", "services", "restock_policy"] {
        put(&mut source, key, get(key));
    }
    source.insert("pricing".into(), pick(get("pricing"), PRICING_CANONICAL_FIELDS));
    let stock: Vec<Value> = match get("stock") {
        Some(Value::Array(items)) => items.iter().map(|entry| pick(Some(entry), STOCK_CANONICAL_FIELDS)).collect(),
        _ => Vec::new(),
    };
    source.insert("stock".into(), Value::Array(stock));
    normalize_lifecycle_merchant(Some(&Value::Object(source)))
}

/// `lifecycleConfigurationFromCanonical(input, merchant)` (1603–1621).
pub fn lifecycle_configuration_from_canonical(input: Option<&Value>, merchant: Option<&Value>) -> Result<Value, RuleError> {
    let fields = input.and_then(Value::as_object);
    let mut source = Map::new();
    for field in ["name", "title", "description", "greeting", "voice", "purse_cp"] {
        if let Some(value) = fields.and_then(|fields| fields.get(field)) {
            source.insert(field.into(), value.clone());
        }
    }
    if let Some(pricing) = input.and_then(|input| input.get("pricing")).filter(|pricing| js::truthy(Some(pricing))) {
        source.insert("pricing".into(), pick(Some(pricing), PRICING_CANONICAL_FIELDS));
    }
    normalize_lifecycle_configuration(Some(&Value::Object(source)), merchant)
}

/// `normalizeLifecycleConfiguration(input, merchant)` (1623–1636).
pub fn normalize_lifecycle_configuration(input: Option<&Value>, merchant: Option<&Value>) -> Result<Value, RuleError> {
    let code = "INVALID_MERCHANT_CONFIGURATION";
    let source = lifecycle_object(input, code, "Настройки торговца")?;
    assert_lifecycle_keys(source, MERCHANT_CONFIGURATION_FIELDS, code, "Настройки торговца")?;
    let mut configuration = Map::new();
    let texts: [(&str, usize, bool, &str); 5] = [
        ("name", 120, true, "Имя торговца"),
        ("title", 180, false, "Титул торговца"),
        ("description", 1_000, false, "Описание торговца"),
        ("greeting", 500, false, "Приветствие торговца"),
        ("voice", 500, false, "Манера речи торговца"),
    ];
    for (field, maximum, required, label) in texts {
        if source.contains_key(field) {
            configuration.insert(field.into(), Value::String(lifecycle_text(source.get(field), maximum, required, "", code, label)?));
        }
    }
    if source.contains_key("purse_cp") {
        configuration.insert("purse_cp".into(), lifecycle_purse_cp(source.get("purse_cp"), None)?);
    }
    if source.contains_key("pricing") {
        let current = merchant.and_then(|merchant| merchant.get("pricing"));
        configuration.insert("pricing".into(), normalize_lifecycle_pricing(source.get("pricing"), current)?);
    }
    if configuration.is_empty() {
        return Err(reject("Не указаны изменения торговца", "EMPTY_MERCHANT_CONFIGURATION"));
    }
    Ok(Value::Object(configuration))
}

/// `normalizeLifecycleRestock(input, merchant)` (1638–1661): записи
/// `{ stock_id, catalog_id, quantity_before, quantity_added, quantity_after, stock }`.
pub fn normalize_lifecycle_restock(input: Option<&Value>, merchant: &Value) -> Result<Vec<Value>, RuleError> {
    let entries_input = match input {
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= 500 => items,
        _ => return Err(reject("Пополнение должно содержать от 1 до 500 позиций", "INVALID_MERCHANT_STOCK")),
    };
    let merchant_id = js::string(merchant.get("id"));
    let stock: &[Value] = merchant.get("stock").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let mut seen = std::collections::HashSet::new();
    let mut new_positions = 0usize;
    let mut entries = Vec::new();
    for (index, raw) in entries_input.iter().enumerate() {
        let source = lifecycle_object(Some(raw), "INVALID_MERCHANT_STOCK", "Позиция пополнения")?;
        assert_lifecycle_keys(source, MERCHANT_STOCK_FIELDS, "INVALID_MERCHANT_STOCK", "Позиция пополнения")?;
        let stock_id = lifecycle_id(source.get("stock_id"), "INVALID_STOCK_ID", "stock_id")?;
        if !seen.insert(stock_id.clone()) {
            return Err(reject("stock_id должен быть уникальным в одной команде", "DUPLICATE_STOCK_ID"));
        }
        let added = js::safe_int(Some(&lifecycle_integer(source.get("quantity"), 1, MAX_STOCK_QUANTITY, Value::from(1), "INVALID_QUANTITY", "Количество пополнения")?), 1);
        if let Some(existing) = stock.iter().find(|entry| js::string(entry.get("stock_id")) == stock_id) {
            if js::present(source.get("catalog_id")) && lifecycle_id(source.get("catalog_id"), "INVALID_CATALOG_ITEM", "catalog_id")? != js::string(existing.get("catalog_id")) {
                return Err(reject("Нельзя изменить catalog_id существующей позиции пополнением", "STOCK_CATALOG_MISMATCH"));
            }
            let before = js::safe_int(existing.get("quantity"), 0).max(0);
            if before + added > MAX_STOCK_QUANTITY {
                return Err(reject("Превышен предел количества товара", "STOCK_LIMIT_EXCEEDED"));
            }
            let mut patched = crate::core::spread_value(Some(existing));
            patched.insert("quantity".into(), Value::from(before + added));
            let entry = lifecycle_stock_from_canonical(Some(&Value::Object(patched)), &merchant_id, index)?;
            entries.push(json!({ "stock_id": stock_id, "catalog_id": entry.get("catalog_id").cloned().unwrap_or(Value::Null), "quantity_before": before, "quantity_added": added, "quantity_after": before + added, "stock": entry }));
            continue;
        }
        new_positions += 1;
        let entry = normalize_lifecycle_stock_entry(Some(raw), &merchant_id, stock.len() + index)?;
        entries.push(json!({ "stock_id": stock_id, "catalog_id": entry.get("catalog_id").cloned().unwrap_or(Value::Null), "quantity_before": 0, "quantity_added": added, "quantity_after": added, "stock": entry }));
    }
    if stock.len() + new_positions > 500 {
        return Err(reject("Склад торговца заполнен", "MERCHANT_STOCK_FULL"));
    }
    Ok(entries)
}

/// `APPRAISAL_RARITY[key]` (5431–5442).
pub fn appraisal_rarity(key: &str) -> Option<&'static str> {
    Some(match key {
        "обычный" | "common" => "common",
        "необычный" | "uncommon" => "uncommon",
        "редкий" | "rare" => "rare",
        "очень редкий" | "very_rare" => "very_rare",
        "легендарный" | "legendary" => "legendary",
        _ => return None,
    })
}

/// `appraisalCategory(item)` (5444–5448).
pub fn appraisal_category(item: Option<&Value>) -> String {
    let kind = js::s(item.and_then(|item| item.get("type"))).to_lowercase();
    if ["weapon", "armor", "consumable", "tool", "treasure"].contains(&kind.as_str()) {
        kind
    } else {
        "miscellaneous".into()
    }
}

/// `String(x ?? fallback)` для поля предмета.
fn field_or(item: Option<&Value>, key: &str, fallback: &str) -> String {
    match item.and_then(|item| item.get(key)).filter(|value| !value.is_null()) {
        Some(value) => js::s(Some(value)),
        None => fallback.to_string(),
    }
}

/// `appraisalForInventoryItem(actor, merchant, item)` (5450–5468). Отказ
/// оценщика — ошибка JS `ItemAppraisalError` с его кодом (не отказ правила).
pub fn appraisal_for_inventory_item(actor: &Value, merchant: &Value, item: &Value) -> Result<Value, Halt> {
    let stack_key = inventory_stack_key(Some(item));
    let last = stack_key.rsplit(':').next().unwrap_or("");
    let digest = if last.is_empty() { "custom" } else { last };
    let rarity_key = sk_core::text::lower(&field_or(Some(item), "rarity", ""));
    let request = json!({
        "homebrew_id": format!("homebrew:{digest}"),
        "name": field_or(Some(item), "name", "Предмет"),
        "category": appraisal_category(Some(item)),
        "rarity": appraisal_rarity(&rarity_key).unwrap_or("common"),
        "condition": "serviceable",
    });
    let options = json!({ "policyId": sk_economy::item_appraisal::CATEGORY_APPRAISAL_POLICY_ID });
    let appraisal = sk_economy::item_appraisal::appraise_item(Some(&request), Some(&options)).map_err(|error| Halt::Fault(Fault { name: "ItemAppraisalError".into(), message: error.message, code: Some(error.code) }))?;
    let mut record = crate::core::spread_value(Some(&appraisal));
    let fingerprint = js::s(appraisal.get("appraisal_fingerprint"));
    record.insert("appraisal_id".into(), Value::String(format!("appraisal:{}", slice_utf16(&fingerprint, 24))));
    record.insert("actor_id".into(), Value::String(js::string(actor.get("id"))));
    record.insert("merchant_id".into(), Value::String(js::string(merchant.get("id"))));
    record.insert("item_id".into(), Value::String(js::string(item.get("id"))));
    record.insert("item_stack_key".into(), Value::String(stack_key));
    Ok(Value::Object(record))
}

/// `appraisalBlocked(item)` (5470–5475): сюжетную вещь не оценивают и не продают.
pub fn appraisal_blocked(item: Option<&Value>) -> bool {
    let field = |key: &str| item.and_then(|item| item.get(key));
    let text = |key: &str| if js::truthy(field(key)) { js::s(field(key)) } else { String::new() };
    js::is_true(field("quest_item")) || js::is_false(field("sellable")) || text("type").to_lowercase() == "quest" || sk_core::text::lower(&text("rarity")) == "сюжетный"
}

/// `merchantStock(merchant, stockId)` (5484–5486).
pub fn merchant_stock<'a>(merchant: Option<&'a Value>, stock_id: Option<&Value>) -> Option<&'a Value> {
    let wanted = js::s(stock_id);
    merchant.and_then(|merchant| merchant.get("stock")).and_then(Value::as_array)?.iter().find(|stock| js::string(stock.get("stock_id")) == wanted)
}

/// `checkedTransactionTotal(unitPrice, quantity)` (5488–5495).
pub fn checked_transaction_total(unit_price: Option<&Value>, quantity: Option<&Value>) -> Result<i64, RuleError> {
    let unit = js::safe_int(unit_price, 0);
    let count = js::safe_int(quantity, 0);
    if unit <= 0 || count <= 0 || count > MAX_TRANSACTION_QUANTITY || unit > MAX_CURRENCY_CP / count {
        return Err(reject("Некорректная сумма торговой операции", "INVALID_TRANSACTION_TOTAL"));
    }
    Ok(unit * count)
}

/// `replaceMerchant(state, id, updater)` (24011–24013): торговец с этим id
/// заменяется итогом `updater`; ошибка `updater` прерывает замену целиком.
pub fn replace_merchant(state: &mut Value, id: &str, mut updater: impl FnMut(&Value) -> Result<Value, RuleError>) -> Result<(), RuleError> {
    let Some(merchants) = state.get("merchants").and_then(Value::as_array) else { return Ok(()) };
    let mut next = Vec::with_capacity(merchants.len());
    for merchant in merchants {
        next.push(if js::string(merchant.get("id")) == id { updater(merchant)? } else { merchant.clone() });
    }
    state["merchants"] = Value::Array(next);
    Ok(())
}

/// `setItemAppraisal(state, actorId, itemId, appraisal)` (24096–24107).
pub fn set_item_appraisal(state: &mut Value, actor_id: Option<&Value>, item_id: Option<&Value>, appraisal: Option<&Value>) {
    let owner = js::s(actor_id);
    let item = js::s(item_id);
    let Some(appraisal) = appraisal.filter(|value| value.is_object()) else { return };
    if owner.is_empty() || item.is_empty() {
        return;
    }
    let mechanics = sk_core::game::mechanics_mut(state);
    let registry = mechanics.get("item_appraisals").filter(|value| js::present(Some(value)));
    let mut next = crate::core::spread_value(registry);
    let mut owned = crate::core::spread_value(registry.and_then(|registry| registry.get(&owner)));
    owned.insert(item, appraisal.clone());
    next.insert(owner, Value::Object(owned));
    mechanics.insert("item_appraisals".into(), Value::Object(next));
}

/// `removeItemAppraisal(state, actorId, itemId)` (24109–24117).
pub fn remove_item_appraisal(state: &mut Value, actor_id: Option<&Value>, item_id: Option<&Value>) {
    let owner = js::s(actor_id);
    let item = js::s(item_id);
    let mechanics = sk_core::game::mechanics_mut(state);
    let registry = mechanics.get("item_appraisals").filter(|value| js::present(Some(value)));
    let current = registry.and_then(|registry| registry.get(&owner));
    if !current.is_some_and(|current| js::truthy(Some(current)) && (current.is_object() || current.is_array())) {
        return;
    }
    let mut next = crate::core::spread_value(current);
    next.shift_remove(&item);
    let mut registry = crate::core::spread_value(registry);
    registry.insert(owner, Value::Object(next));
    mechanics.insert("item_appraisals".into(), Value::Object(registry));
}

// ---------------------------------------------------------------------------
// Импорт слэба TaleSpire (`ImportLocationMap`, 22310)
// ---------------------------------------------------------------------------
//
// `talespire-import` перенесён в `sk-talespire`, а тот зависит от `sk-rules`
// (тактическая геометрия): прямой вызов замкнул бы граф крейтов. Поэтому
// импортёр внедряется: сервер (и сверка корпуса) регистрирует
// `sk_talespire::talespire_import::import_talespire_slab` один раз при старте.
// Модуль `merchants` — единственный публичный модуль задачи Р6, поэтому точка
// регистрации лежит здесь, хотя к торговле не относится.

/// Отказ импортёра: имя класса JS, код и текст.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaleSpireFailure {
    pub name: String,
    pub code: String,
    pub message: String,
}

/// `importTaleSpireSlab(slab, { locationId, theme })`: слэб (`None` — не
/// строка), id локации, тема. Итог — JSON импорта (`{ source, stats,
/// warnings, levels, … }`).
pub type TaleSpireImporter = fn(Option<&str>, &str, &str) -> Result<Value, TaleSpireFailure>;

static TALESPIRE_IMPORTER: std::sync::OnceLock<TaleSpireImporter> = std::sync::OnceLock::new();

/// Зарегистрировать импортёр TaleSpire (повторная регистрация не меняет первую).
pub fn install_talespire_importer(importer: TaleSpireImporter) {
    let _ = TALESPIRE_IMPORTER.set(importer);
}

/// Зарегистрированный импортёр.
pub fn talespire_importer() -> Option<TaleSpireImporter> {
    TALESPIRE_IMPORTER.get().copied()
}
