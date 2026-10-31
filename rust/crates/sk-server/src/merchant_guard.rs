//! С14: жизненный цикл торговца — санитайзеры и отпечатки
//! (`server/index.mjs:1024–1247`).
//!
//! - `assertMerchantIdempotency`/`assertMerchantResultFingerprint` (1023,
//!   1241) — сверка торговой операции игрока; отпечаток команды —
//!   [`merchant_command_fingerprint`] из `command_fingerprints` (С16), второго
//!   нет. Зовёт `/commands` (С18.1) и `merchants/:id/commands` (С18.2).
//! - `lifecycle*`, `sanitizeMerchantLifecycleCommand`,
//!   `merchantLifecycleFingerprint`, `assertMerchantLifecycle*` (1033–1216) —
//!   административные команды торговца (`merchants/commands`,
//!   `merchants/assemble`).
//!
//! Приведения — строго как в JS: `String(x)` и `Number(x)` объекта со своим
//! полем `toString` бросают `TypeError` (кода нет — `catch` маршрута отвечает
//! 400 с его текстом); строки режутся по единицам UTF-16 (`slice`). Строка с
//! одиночной суррогатной половиной в Rust невозможна: срез посреди пары даёт
//! `U+FFFD` вместо половины (отпечаток такой команды расходится с JS).

use serde_json::{Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;

use crate::command_fingerprints::{merchant_command_fingerprint, DuplicateLookup};
use crate::command_guard::{policy_error, GuardResult, ADMIN_MERCHANT_LIFECYCLE_COMMANDS};
use crate::error::Failure;

/// Код отказа санитайзера.
const INVALID: &str = "INVALID_MERCHANT_LIFECYCLE_COMMAND";

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

// --- приведения JS -------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(value) if !value.is_null() => Some(value),
        _ => b,
    }
}

/// `x != null`.
fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null())
}

/// Обычный объект (не массив, не `null`).
fn is_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// `TypeError` приведения объекта к примитиву: кода нет.
fn primitive_error() -> Failure {
    Failure::new("Cannot convert object to primitive value", None)
}

/// `String(value)` для значения из JSON: объект со своим полем `toString`
/// (в JSON оно не функция) — `TypeError`; массив — `join(',')` с тем же
/// правилом для элементов (`null` в нём — пустая строка). Отсутствующее —
/// `"undefined"`.
pub fn js_string(value: Option<&Value>) -> Result<String, Failure> {
    match value {
        Some(Value::Object(map)) if map.contains_key("toString") => Err(primitive_error()),
        Some(Value::Array(items)) => {
            let parts: Result<Vec<String>, Failure> = items.iter().map(|item| if item.is_null() { Ok(String::new()) } else { js_string(Some(item)) }).collect();
            Ok(parts?.join(","))
        }
        other => Ok(js::string(other)),
    }
}

/// `String(value ?? '')`.
pub fn js_string_or_empty(value: Option<&Value>) -> Result<String, Failure> {
    if present(value) {
        js_string(value)
    } else {
        Ok(String::new())
    }
}

/// `Number(value)`: объект и массив — через строку (`TypeError` — как у
/// [`js_string`]).
pub fn js_number(value: Option<&Value>) -> Result<f64, Failure> {
    match value {
        Some(Value::Object(_)) => js_string(value).map(|_| f64::NAN),
        Some(Value::Array(_)) => js_string(value).map(|text| js::parse_number(&text)),
        other => Ok(js::number(other)),
    }
}

/// `text.slice(0, limit)` по единицам UTF-16.
pub fn slice_utf16(text: &str, limit: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(limit + 1).collect();
    if units.len() <= limit {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[..limit])
}

/// `text.length` в единицах UTF-16.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `commandType(command)` (645–648) со строгим `String`.
fn command_type(command: &Value) -> Result<String, Failure> {
    let source = Some(command);
    js_string_or_empty(nullish(nullish(get(source, "command_type"), get(source, "commandType")), get(source, "type")))
}

fn invalid(message: impl Into<String>) -> Failure {
    policy_error(message, INVALID)
}

// --- торговля игрока (1024–1031, 1242–1247) ------------------------------------

/// Выражение списка в тексте `TypeError` V8: `(duplicate.events ?? [])`.
const DUPLICATE_EVENTS: &str = "(duplicate.events ?? [])";
/// `(result?.mechanics ?? [])` — V8 пишет его как `(intermediate value)`.
const RESULT_MECHANICS: &str = "((intermediate value) ?? [])";

/// `new Set((list ?? []).map((event) => event.payload?.request_fingerprint).filter(Boolean).map(String))`.
/// Как в JS: не массив — `TypeError` «… .map is not a function», событие
/// `null` — `TypeError` чтения `payload` (кода нет; журнал таких не пишет).
fn request_fingerprints(events: Option<&Value>, expression: &str) -> GuardResult<IndexSet<String>> {
    let events = match events {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return Err(Failure::new(format!("{expression}.map is not a function"), None)),
    };
    let mut fingerprints = IndexSet::new();
    for event in events {
        if event.is_null() {
            return Err(Failure::new("Cannot read properties of null (reading 'payload')", None));
        }
        let value = get(get(Some(event), "payload"), "request_fingerprint");
        if js::truthy(value) {
            fingerprints.insert(js::string(value));
        }
    }
    Ok(fingerprints)
}

/// `assertMerchantIdempotency(campaignId, idempotencyKey, command)` (1024–1031).
pub fn assert_merchant_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &Value) -> GuardResult<()> {
    let Some(duplicate) = journal.get_by_idempotency_key(campaign_id, idempotency_key)? else { return Ok(()) };
    let fingerprints = request_fingerprints(get(Some(&duplicate), "events"), DUPLICATE_EVENTS)?;
    if fingerprints.len() != 1 || !fingerprints.contains(&merchant_command_fingerprint(command)) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другой торговой операции", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertMerchantResultFingerprint(result, command)` (1242–1247).
pub fn assert_merchant_result_fingerprint(result: &Value, command: &Value) -> GuardResult<()> {
    let fingerprints = request_fingerprints(get(Some(result), "mechanics"), RESULT_MECHANICS)?;
    if fingerprints.len() != 1 || !fingerprints.contains(&merchant_command_fingerprint(command)) {
        return Err(policy_error("Конкурирующая операция использовала тот же ключ идемпотентности", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

// --- жизненный цикл (1033–1216) -----------------------------------------------

/// `lifecycleText(value, maximum)` (1033–1035): `String(value ?? '').trim().slice(0, maximum)`.
pub fn lifecycle_text(value: Option<&Value>, maximum: usize) -> GuardResult<String> {
    Ok(slice_utf16(sk_core::text::trim(&js_string_or_empty(value)?), maximum))
}

/// `lifecycleId(value, field)` (1037–1041).
pub fn lifecycle_id(value: Option<&Value>, field: &str) -> GuardResult<String> {
    let id = lifecycle_text(value, 120)?;
    if id.is_empty() {
        return Err(invalid(format!("Не указано поле {field}")));
    }
    Ok(id)
}

/// `lifecycleInteger(value, field, { minimum, maximum })` (1043–1049).
pub fn lifecycle_integer(value: Option<&Value>, field: &str, minimum: i64, maximum: i64) -> GuardResult<i64> {
    let result = js_number(value)?;
    let safe = result.is_finite() && result.fract() == 0.0 && result.abs() <= MAX_SAFE_INTEGER as f64;
    if !safe || result < minimum as f64 || result > maximum as f64 {
        return Err(invalid(format!("Поле {field} должно быть целым числом от {minimum} до {maximum}")));
    }
    // `-0` записывается как `0` (`JSON.stringify(-0)`).
    Ok(result as i64)
}

/// `lifecycleInteger` с границами по умолчанию (`0…MAX_SAFE_INTEGER`).
pub fn lifecycle_integer_default(value: Option<&Value>, field: &str) -> GuardResult<i64> {
    lifecycle_integer(value, field, 0, MAX_SAFE_INTEGER)
}

/// Границы политики цен (`lifecyclePricing`, 1053–1057), в порядке `Object.entries`.
const PRICING_BOUNDS: [(&str, i64, i64); 7] = [
    ("buy_markup_bps", 1_000, 30_000),
    ("sell_rate_bps", 1_000, 30_000),
    ("bargain_dc", 5, 30),
    ("success_discount_bps", 0, 5_000),
    ("failure_markup_bps", 0, 5_000),
    ("agent_adjustment_bps", -2_000, 2_000),
    ("agent_adjustment_limit_percent", 0, 20),
];

/// `lifecyclePricing(input)` (1051–1070); `None` — `undefined`.
fn lifecycle_pricing(input: Option<&Value>) -> GuardResult<Option<Value>> {
    if !present(input) {
        return Ok(None);
    }
    if !is_object(input) {
        return Err(invalid("Политика цен должна быть объектом"));
    }
    let mut result = Map::new();
    for (key, minimum, maximum) in PRICING_BOUNDS {
        if present(get(input, key)) {
            result.insert(key.into(), Value::from(lifecycle_integer(get(input, key), &format!("pricing.{key}"), minimum, maximum)?));
        }
    }
    if present(get(input, "mode")) {
        let mode = lifecycle_text(get(input, "mode"), 60)?;
        if !["catalog", "catalog_with_agent_adjustment"].contains(&mode.as_str()) {
            return Err(invalid("Неизвестный режим политики цен"));
        }
        result.insert("mode".into(), Value::String(mode));
    }
    if present(get(input, "description")) {
        result.insert("description".into(), Value::String(lifecycle_text(get(input, "description"), 500)?));
    }
    Ok(Some(Value::Object(result)))
}

/// `lifecycleStockItem(input, index)` (1072–1091).
fn lifecycle_stock_item(input: &Value, index: usize) -> GuardResult<Value> {
    let source = Some(input);
    if !is_object(source) {
        return Err(invalid(format!("Позиция склада {} должна быть объектом", index + 1)));
    }
    let mut item = Map::new();
    item.insert("stock_id".into(), Value::String(lifecycle_id(nullish(get(source, "stock_id"), get(source, "stockId")), &format!("items[{index}].stock_id"))?));
    item.insert("quantity".into(), Value::from(lifecycle_integer(get(source, "quantity"), &format!("items[{index}].quantity"), 1, 999_999)?));
    if present(get(source, "catalog_id")) || present(get(source, "catalogId")) {
        item.insert("catalog_id".into(), Value::String(lifecycle_id(nullish(get(source, "catalog_id"), get(source, "catalogId")), &format!("items[{index}].catalog_id"))?));
    }
    if present(get(source, "name")) {
        item.insert("name".into(), Value::String(lifecycle_text(get(source, "name"), 120)?));
    }
    if present(get(source, "type")) {
        item.insert("type".into(), Value::String(lifecycle_text(get(source, "type"), 40)?));
    }
    if present(get(source, "weight")) {
        let weight = js_number(get(source, "weight"))?;
        if !weight.is_finite() || weight < 0.0 || weight > 1_000_000.0 {
            return Err(invalid(format!("Некорректный вес items[{index}].weight")));
        }
        item.insert("weight".into(), js::num(weight));
    }
    for (key, maximum) in [("rarity", 60), ("description", 1_000), ("properties", 500)] {
        if present(get(source, key)) {
            item.insert(key.into(), Value::String(lifecycle_text(get(source, key), maximum)?));
        }
    }
    Ok(Value::Object(item))
}

/// `merchant.services[i]` (1115–1132).
fn lifecycle_service(service: &Value, index: usize) -> GuardResult<Value> {
    let source = Some(service);
    if !is_object(source) {
        return Err(invalid(format!("Некорректная услуга {index}")));
    }
    let label = |field: &str| format!("merchant.services[{index}].{field}");
    let mut result = Map::new();
    result.insert("service_id".into(), Value::String(lifecycle_id(nullish(get(source, "service_id"), get(source, "id")), &label("service_id"))?));
    result.insert("name".into(), Value::String(lifecycle_text(get(source, "name"), 120)?));
    result.insert("description".into(), Value::String(lifecycle_text(get(source, "description"), 1_000)?));
    result.insert("kind".into(), Value::String(lifecycle_text(get(source, "kind"), 40)?));
    result.insert("base_price_cp".into(), Value::from(lifecycle_integer(get(source, "base_price_cp"), &label("base_price_cp"), 0, 100_000_000)?));
    let zero = Value::from(0);
    let duration = nullish(get(source, "duration_minutes"), Some(&zero));
    result.insert("duration_minutes".into(), Value::from(lifecycle_integer(duration, &label("duration_minutes"), 0, 10_080)?));
    result.insert("available".into(), Value::Bool(get(source, "available") != Some(&Value::Bool(false))));
    result.insert("requires_presence".into(), Value::Bool(get(source, "requires_presence") != Some(&Value::Bool(false))));
    let tags = match get(source, "tags") {
        Some(Value::Array(tags)) => tags.as_slice(),
        _ => &[],
    };
    let mut kept = Vec::new();
    for tag in tags.iter().take(12) {
        let text = lifecycle_text(Some(tag), 40)?;
        if !text.is_empty() {
            kept.push(Value::String(text));
        }
    }
    result.insert("tags".into(), Value::Array(kept));
    Ok(Value::Object(result))
}

/// `merchant.restock_policy` (1134–1149).
fn lifecycle_restock_policy(policy: Option<&Value>) -> GuardResult<Value> {
    if !is_object(policy) {
        return Err(invalid("merchant.restock_policy должен быть объектом"));
    }
    let mut result = Map::new();
    result.insert("enabled".into(), Value::Bool(get(policy, "enabled") == Some(&Value::Bool(true))));
    let day = Value::from(1_440);
    let interval = nullish(get(policy, "interval_minutes"), Some(&day));
    result.insert("interval_minutes".into(), Value::from(lifecycle_integer(interval, "merchant.restock_policy.interval_minutes", 60, 525_600)?));
    if present(get(policy, "last_restock_world_minute")) {
        let minute = lifecycle_integer(get(policy, "last_restock_world_minute"), "merchant.restock_policy.last_restock_world_minute", 0, 1_000_000_000)?;
        result.insert("last_restock_world_minute".into(), Value::from(minute));
    }
    let targets = match get(policy, "targets") {
        Some(Value::Array(targets)) => targets.as_slice(),
        _ => &[],
    };
    let mut kept = Vec::new();
    for (index, target) in targets.iter().take(500).enumerate() {
        let mut entry = Map::new();
        entry.insert("stock_id".into(), Value::String(lifecycle_id(get(Some(target), "stock_id"), &format!("merchant.restock_policy.targets[{index}].stock_id"))?));
        let quantity = lifecycle_integer(get(Some(target), "target_quantity"), &format!("merchant.restock_policy.targets[{index}].target_quantity"), 1, 999_999)?;
        entry.insert("target_quantity".into(), Value::from(quantity));
        kept.push(Value::Object(entry));
    }
    result.insert("targets".into(), Value::Array(kept));
    Ok(Value::Object(result))
}

/// `lifecycleMerchant(input)` (1093–1152).
fn lifecycle_merchant(input: Option<&Value>) -> GuardResult<Value> {
    if !is_object(input) {
        return Err(invalid("Поле merchant должно быть объектом"));
    }
    let mut merchant = Map::new();
    merchant.insert("id".into(), Value::String(lifecycle_id(nullish(get(input, "id"), get(input, "merchant_id")), "merchant.id")?));
    let name = lifecycle_text(get(input, "name"), 120)?;
    if name.is_empty() {
        return Err(invalid("У торговца должно быть имя"));
    }
    merchant.insert("name".into(), Value::String(name));
    for (key, maximum) in [("title", 180), ("description", 1_000), ("greeting", 500), ("voice", 500), ("location", 180)] {
        if present(get(input, key)) {
            merchant.insert(key.into(), Value::String(lifecycle_text(get(input, key), maximum)?));
        }
    }
    if present(get(input, "location_id")) || present(get(input, "locationId")) {
        merchant.insert("location_id".into(), Value::String(lifecycle_text(nullish(get(input, "location_id"), get(input, "locationId")), 120)?));
    }
    if !merchant.get("location").is_some_and(|location| js::truthy(Some(location))) {
        return Err(invalid("У торговца должна быть локация"));
    }
    if present(get(input, "available")) {
        let Some(Value::Bool(available)) = get(input, "available") else {
            return Err(invalid("merchant.available должен быть boolean"));
        };
        merchant.insert("available".into(), Value::Bool(*available));
    }
    if let Some(pricing) = lifecycle_pricing(get(input, "pricing"))? {
        merchant.insert("pricing".into(), pricing);
    }
    if present(get(input, "purse_cp")) {
        let purse = lifecycle_integer(get(input, "purse_cp"), "merchant.purse_cp", 0, sk_economy::merchant_economy::MAX_CURRENCY_CP)?;
        merchant.insert("purse_cp".into(), Value::from(purse));
    }
    if present(get(input, "stock")) {
        let Some(Value::Array(stock)) = get(input, "stock").filter(|stock| stock.as_array().is_some_and(|items| items.len() <= 500)) else {
            return Err(invalid("merchant.stock должен содержать не более 500 позиций"));
        };
        let items: GuardResult<Vec<Value>> = stock.iter().enumerate().map(|(index, item)| lifecycle_stock_item(item, index)).collect();
        merchant.insert("stock".into(), Value::Array(items?));
    }
    if present(get(input, "services")) {
        let Some(Value::Array(services)) = get(input, "services").filter(|services| services.as_array().is_some_and(|items| items.len() <= 100)) else {
            return Err(invalid("merchant.services должен содержать не более 100 услуг"));
        };
        let items: GuardResult<Vec<Value>> = services.iter().enumerate().map(|(index, service)| lifecycle_service(service, index)).collect();
        merchant.insert("services".into(), Value::Array(items?));
    }
    if present(get(input, "restock_policy")) {
        merchant.insert("restock_policy".into(), lifecycle_restock_policy(get(input, "restock_policy"))?);
    }
    Ok(Value::Object(merchant))
}

/// `lifecycleConfiguration(input)` (1154–1164).
fn lifecycle_configuration(input: Option<&Value>) -> GuardResult<Value> {
    if !is_object(input) {
        return Err(invalid("Поле configuration должно быть объектом"));
    }
    let mut configuration = Map::new();
    for (key, maximum) in [("name", 120), ("title", 180), ("description", 1_000), ("greeting", 500), ("voice", 500)] {
        if present(get(input, key)) {
            configuration.insert(key.into(), Value::String(lifecycle_text(get(input, key), maximum)?));
        }
    }
    if let Some(pricing) = lifecycle_pricing(get(input, "pricing"))? {
        configuration.insert("pricing".into(), pricing);
    }
    if present(get(input, "purse_cp")) {
        let purse = lifecycle_integer(get(input, "purse_cp"), "configuration.purse_cp", 0, sk_economy::merchant_economy::MAX_CURRENCY_CP)?;
        configuration.insert("purse_cp".into(), Value::from(purse));
    }
    if configuration.is_empty() {
        return Err(invalid("configuration не содержит разрешённых изменений"));
    }
    Ok(Value::Object(configuration))
}

/// `merchantLifecycleFingerprint(command)` (1166–1170): SHA-256 строки
/// `JSON.stringify` команды без `request_fingerprint`.
pub fn merchant_lifecycle_fingerprint(command: &Value) -> String {
    let mut semantic = command.clone();
    if let Some(map) = semantic.as_object_mut() {
        map.shift_remove("request_fingerprint");
    }
    sk_core::hash::sha256_hex(js::stringify(&semantic).as_bytes())
}

/// `sanitizeMerchantLifecycleCommand(input)` (1172–1203).
pub fn sanitize_merchant_lifecycle_command(input: &Value) -> GuardResult<Value> {
    if !input.is_object() {
        return Err(invalid("Нужна одна lifecycle-команда торговца"));
    }
    let source = Some(input);
    let kind = command_type(input)?;
    if !ADMIN_MERCHANT_LIFECYCLE_COMMANDS.contains(&kind.as_str()) {
        return Err(policy_error("Эта команда не относится к жизненному циклу торговца", "MERCHANT_LIFECYCLE_COMMAND_FORBIDDEN"));
    }
    let mut command = Map::new();
    command.insert("command_type".into(), Value::String(kind.clone()));
    let version = lifecycle_integer_default(nullish(get(source, "expected_state_version"), get(source, "expectedStateVersion")), "expected_state_version")?;
    command.insert("expected_state_version".into(), Value::from(version));
    let merchant_id = || lifecycle_id(nullish(get(source, "merchant_id"), get(source, "merchantId")), "merchant_id");
    match kind.as_str() {
        "CreateMerchant" => {
            command.insert("merchant".into(), lifecycle_merchant(get(source, "merchant"))?);
        }
        "ConfigureMerchant" => {
            command.insert("merchant_id".into(), Value::String(merchant_id()?));
            command.insert("configuration".into(), lifecycle_configuration(get(source, "configuration"))?);
        }
        "RestockMerchant" => {
            command.insert("merchant_id".into(), Value::String(merchant_id()?));
            let Some(Value::Array(items)) = get(source, "items").filter(|items| items.as_array().is_some_and(|list| !list.is_empty() && list.len() <= 500)) else {
                return Err(invalid("items должен содержать от 1 до 500 позиций"));
            };
            let items: GuardResult<Vec<Value>> = items.iter().enumerate().map(|(index, item)| lifecycle_stock_item(item, index)).collect();
            command.insert("items".into(), Value::Array(items?));
        }
        "MoveMerchant" => {
            command.insert("merchant_id".into(), Value::String(merchant_id()?));
            let location = lifecycle_text(get(source, "location"), 180)?;
            command.insert("location".into(), Value::String(location.clone()));
            command.insert("location_id".into(), Value::String(lifecycle_text(nullish(get(source, "location_id"), get(source, "locationId")), 120)?));
            if location.is_empty() {
                return Err(invalid("Не указана новая локация торговца"));
            }
        }
        "SetMerchantAvailability" => {
            command.insert("merchant_id".into(), Value::String(merchant_id()?));
            let Some(Value::Bool(available)) = get(source, "available") else {
                return Err(invalid("available должен быть boolean"));
            };
            command.insert("available".into(), Value::Bool(*available));
        }
        _ => {}
    }
    let mut command = Value::Object(command);
    let fingerprint = merchant_lifecycle_fingerprint(&command);
    if let Some(map) = command.as_object_mut() {
        map.insert("request_fingerprint".into(), Value::String(fingerprint));
    }
    Ok(command)
}

/// `command.request_fingerprint` санитизированной команды.
fn own_fingerprint(command: &Value) -> String {
    js::s(get(Some(command), "request_fingerprint"))
}

/// `assertMerchantLifecycleIdempotency(campaignId, idempotencyKey, command)` (1205–1212).
pub fn assert_merchant_lifecycle_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &Value) -> GuardResult<()> {
    let Some(duplicate) = journal.get_by_idempotency_key(campaign_id, idempotency_key)? else { return Ok(()) };
    let fingerprints = request_fingerprints(get(Some(&duplicate), "events"), DUPLICATE_EVENTS)?;
    if fingerprints.len() != 1 || !fingerprints.contains(&own_fingerprint(command)) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другой lifecycle-команды торговца", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertMerchantLifecycleResultFingerprint(result, command)` (1214–1219).
pub fn assert_merchant_lifecycle_result_fingerprint(result: &Value, command: &Value) -> GuardResult<()> {
    let fingerprints = request_fingerprints(get(Some(result), "mechanics"), RESULT_MECHANICS)?;
    if fingerprints.len() != 1 || !fingerprints.contains(&own_fingerprint(command)) {
        return Err(policy_error("Конкурирующая lifecycle-команда использовала тот же ключ идемпотентности", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_string_and_slices() {
        assert!(js_string(Some(&json!({ "toString": 1 }))).is_err());
        assert_eq!(js_string(Some(&json!([1, null, [2, 3]]))).ok().as_deref(), Some("1,,2,3"));
        assert_eq!(slice_utf16("ab😀c", 3), "ab\u{FFFD}");
        assert!(js_number(Some(&json!({}))).is_ok_and(f64::is_nan));
        assert_eq!(js_number(Some(&json!(["7"]))).ok(), Some(7.0));
    }

    #[test]
    fn missing_name_message() {
        let error = sanitize_merchant_lifecycle_command(&json!({ "command_type": "CreateMerchant", "expected_state_version": 0, "merchant": { "id": "m" } })).err();
        assert_eq!(error.map(|error| error.message), Some("У торговца должно быть имя".to_string()));
    }
}
