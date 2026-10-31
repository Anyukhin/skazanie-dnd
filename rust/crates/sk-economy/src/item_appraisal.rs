//! Перенос `server/item-appraisal.mjs`: серверная оценка вещи — аттестация
//! цены только из авторитета сервера. Каталожная вещь оценивается ценой
//! каталога SRD; самодельная — версионированной формулой «категория ×
//! редкость × состояние» и только по явной политике из белого списка.
//!
//! Любое поле вне контракта (цена клиента, отметки снимка, секреты) —
//! отказ, а не молчаливое игнорирование: метка политики внутри вещи не может
//! сама себя сделать авторитетной.
//!
//! **Ключ прототипа.** `SRD_EQUIPMENT_CATALOG['constructor']` в JS находит
//! функцию, и каталожная оценка такого кода возвращает запись без цены.
//! Здесь он — неизвестный код (`UNKNOWN_APPRAISAL_CATALOG_ITEM`); сервер
//! каталожную ветку не вызывает, оценка героя идёт формулой.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{re, text};

use crate::merchant_economy::{ECONOMY_CATALOG_VERSION, SRD_EQUIPMENT_CATALOG};
use crate::support::{copy_field, plain, sha256_hex, stable_value, stringify, utf16_cmp, utf16_len};

pub const ITEM_APPRAISAL_CONTRACT_VERSION: &str = "skazanie:item-appraisal:v1";
/// `skazanie:item-appraisal:catalog:${ECONOMY_CATALOG_VERSION}:v1`.
pub const CATALOG_APPRAISAL_POLICY_ID: &str = "skazanie:item-appraisal:catalog:srd_5_2_1:v1";
pub const CATEGORY_APPRAISAL_POLICY_ID: &str = "skazanie:item-appraisal:category-rarity-condition:v1";
pub const MAX_APPRAISED_UNIT_PRICE_CP: i64 = 10_000_000;

const MAX_NAME_LENGTH: usize = 120;
const INPUT_FIELDS: [&str; 7] = ["catalog_id", "homebrew_id", "item_id", "name", "category", "rarity", "condition"];
const OPTION_FIELDS: [&str; 1] = ["policyId"];

const CATEGORY_BASE_CP: [(&str, i64); 6] = [("miscellaneous", 25), ("consumable", 50), ("tool", 100), ("treasure", 250), ("weapon", 500), ("armor", 1_000)];
const RARITY_MULTIPLIER_BPS: [(&str, i64); 5] = [("common", 10_000), ("uncommon", 50_000), ("rare", 250_000), ("very_rare", 1_000_000), ("legendary", 5_000_000)];
const CONDITION_MULTIPLIER_BPS: [(&str, i64); 6] = [("broken", 1_000), ("damaged", 5_000), ("worn", 7_500), ("serviceable", 10_000), ("fine", 12_500), ("pristine", 15_000)];

fn lookup(table: &[(&str, i64)], key: &str) -> Option<i64> {
    table.iter().find(|(name, _)| *name == key).map(|(_, value)| *value)
}

/// `ITEM_APPRAISAL_POLICIES`: белый список политик оценки.
pub static ITEM_APPRAISAL_POLICIES: LazyLock<Value> = LazyLock::new(|| {
    let names = |table: &[(&str, i64)]| Value::Array(table.iter().map(|(key, _)| json!(key)).collect());
    let mut policies = Map::new();
    policies.insert(
        CATALOG_APPRAISAL_POLICY_ID.into(),
        json!({ "policy_id": CATALOG_APPRAISAL_POLICY_ID, "kind": "catalog", "source_version": ECONOMY_CATALOG_VERSION }),
    );
    policies.insert(
        CATEGORY_APPRAISAL_POLICY_ID.into(),
        json!({
            "policy_id": CATEGORY_APPRAISAL_POLICY_ID,
            "kind": "category-rarity-condition",
            "formula_version": "category-rarity-condition-v1",
            "categories": names(&CATEGORY_BASE_CP),
            "rarities": names(&RARITY_MULTIPLIER_BPS),
            "conditions": names(&CONDITION_MULTIPLIER_BPS),
            "maximum_unit_price_cp": MAX_APPRAISED_UNIT_PRICE_CP,
        }),
    );
    Value::Object(policies)
});

/// Отказ оценки (`ItemAppraisalError`): код и текст — как в JS.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ItemAppraisalError {
    pub code: String,
    pub message: String,
}

fn reject<T>(message: impl Into<String>, code: &str) -> Result<T, ItemAppraisalError> {
    Err(ItemAppraisalError { code: code.into(), message: message.into() })
}

fn input_object<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a Map<String, Value>, ItemAppraisalError> {
    match plain(value) {
        Some(map) => Ok(map),
        None => reject(format!("{label} must be an object"), "INVALID_APPRAISAL_INPUT"),
    }
}

fn assert_known_fields(source: &Map<String, Value>, allowed: &[&str], label: &str) -> Result<(), ItemAppraisalError> {
    let mut unknown: Vec<&String> = source.keys().filter(|key| !allowed.contains(&key.as_str())).collect();
    unknown.sort_by(|left, right| utf16_cmp(left, right));
    if unknown.is_empty() {
        return Ok(());
    }
    let list = unknown.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(", ");
    reject(format!("{label} contains fields outside the server appraisal contract: {list}"), "UNEXPECTED_APPRAISAL_FIELD")
}

fn is_missing(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null)) || value.and_then(Value::as_str) == Some("")
}

fn normalized_id(value: Option<&Value>, label: &str, required: bool) -> Result<Option<String>, ItemAppraisalError> {
    if is_missing(value) {
        if !required {
            return Ok(None);
        }
        return reject(format!("{label} is required"), "INVALID_APPRAISAL_DESCRIPTOR");
    }
    let Some(Value::String(raw)) = value else {
        return reject(format!("{label} must be a string"), "INVALID_APPRAISAL_DESCRIPTOR");
    };
    let id = text::trim(&text::nfkc(raw)).to_string();
    if !text::test(re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$", "u"), &id) {
        return reject(format!("{label} is not a safe identifier"), "INVALID_APPRAISAL_DESCRIPTOR");
    }
    Ok(Some(id))
}

fn normalized_name(value: Option<&Value>, required: bool) -> Result<Option<String>, ItemAppraisalError> {
    if is_missing(value) {
        if !required {
            return Ok(None);
        }
        return reject("name is required", "INVALID_APPRAISAL_DESCRIPTOR");
    }
    let Some(Value::String(raw)) = value else {
        return reject("name must be a string", "INVALID_APPRAISAL_DESCRIPTOR");
    };
    let collapsed = text::replace_all(re!(r"\s+", "gu"), &text::nfkc(raw), " ");
    let name = text::trim(&collapsed).to_string();
    if name.is_empty() || utf16_len(&name) > MAX_NAME_LENGTH {
        return reject(format!("name must contain 1-{MAX_NAME_LENGTH} characters"), "INVALID_APPRAISAL_DESCRIPTOR");
    }
    Ok(Some(name))
}

fn enum_value(value: Option<&Value>, allowed: &[(&str, i64)], label: &str) -> Result<String, ItemAppraisalError> {
    match value {
        Some(Value::String(key)) if lookup(allowed, key).is_some() => Ok(key.clone()),
        _ => {
            let names = allowed.iter().map(|(key, _)| *key).collect::<Vec<_>>().join(", ");
            reject(format!("{label} must be one of: {names}"), "INVALID_APPRAISAL_DESCRIPTOR")
        }
    }
}

fn with_fingerprint(payload: Map<String, Value>) -> Value {
    let fingerprint = sha256_hex(&stringify(&stable_value(&Value::Object(payload.clone()))));
    let mut result = payload;
    result.insert("appraisal_fingerprint".into(), json!(fingerprint));
    Value::Object(result)
}

fn present(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null))
}

fn catalog_appraisal(source: &Map<String, Value>, policy_id: Option<&str>) -> Result<Value, ItemAppraisalError> {
    if policy_id.is_some_and(|policy| policy != CATALOG_APPRAISAL_POLICY_ID) {
        return reject("The selected policy cannot appraise catalog items", "APPRAISAL_POLICY_MISMATCH");
    }
    if ["homebrew_id", "category", "rarity", "condition"].iter().any(|key| present(source.get(*key))) {
        return reject("Catalog appraisal accepts catalog identity only; custom descriptors are not price authority", "APPRAISAL_DESCRIPTOR_MISMATCH");
    }
    let catalog_id = normalized_id(source.get("catalog_id"), "catalog_id", true)?.unwrap_or_default();
    let Some(catalog) = SRD_EQUIPMENT_CATALOG.get(&catalog_id) else {
        return reject("catalog_id is absent from the server catalog", "UNKNOWN_APPRAISAL_CATALOG_ITEM");
    };
    let mut descriptor = Map::new();
    copy_field(&mut descriptor, "catalog_id", catalog.get("catalog_id"));
    if let Some(item_id) = normalized_id(source.get("item_id"), "item_id", false)? {
        descriptor.insert("item_id".into(), json!(item_id));
    }
    if let Some(name) = normalized_name(source.get("name"), false)? {
        descriptor.insert("name".into(), json!(name));
    }
    let mut provenance = Map::new();
    provenance.insert("catalog_version".into(), json!(ECONOMY_CATALOG_VERSION));
    for key in ["source_version", "source_sha256", "source_page", "license"] {
        copy_field(&mut provenance, key, catalog.get(key));
    }
    let mut payload = Map::new();
    payload.insert("contract_version".into(), json!(ITEM_APPRAISAL_CONTRACT_VERSION));
    payload.insert("authoritative".into(), json!(true));
    payload.insert("currency".into(), json!("cp"));
    payload.insert("descriptor".into(), Value::Object(descriptor));
    copy_field(&mut payload, "base_price_cp", catalog.get("base_price_cp"));
    payload.insert("provenance".into(), json!("catalog"));
    payload.insert("policy_id".into(), json!(CATALOG_APPRAISAL_POLICY_ID));
    payload.insert("source".into(), Value::Object(provenance));
    Ok(with_fingerprint(payload))
}

/// `formulaPrice(category, rarity, condition)`: точное целое (`BigInt` в JS)
/// с округлением половины вверх, в пределах 1…10 000 000 мм.
fn formula_price(category: i64, rarity: i64, condition: i64) -> i64 {
    let numerator = i128::from(category) * i128::from(rarity) * i128::from(condition);
    let divisor: i128 = 100_000_000;
    let rounded = (numerator + divisor / 2) / divisor;
    (rounded as i64).clamp(1, MAX_APPRAISED_UNIT_PRICE_CP)
}

fn homebrew_appraisal(source: &Map<String, Value>, policy_id: Option<&str>) -> Result<Value, ItemAppraisalError> {
    if present(source.get("catalog_id")) {
        return reject("A custom appraisal cannot claim a catalog identity", "APPRAISAL_DESCRIPTOR_MISMATCH");
    }
    let Some(policy_id) = policy_id else {
        return reject("Custom items require an explicit server appraisal policy", "APPRAISAL_POLICY_REQUIRED");
    };
    if ITEM_APPRAISAL_POLICIES.get(policy_id).is_none() {
        return reject("The appraisal policy is not server-allowlisted", "APPRAISAL_POLICY_NOT_ALLOWED");
    }
    if policy_id != CATEGORY_APPRAISAL_POLICY_ID {
        return reject("The selected policy cannot appraise custom items", "APPRAISAL_POLICY_MISMATCH");
    }
    let homebrew_id = normalized_id(source.get("homebrew_id"), "homebrew_id", true)?.unwrap_or_default();
    let item_id = normalized_id(source.get("item_id"), "item_id", false)?;
    let name = normalized_name(source.get("name"), true)?.unwrap_or_default();
    let category = enum_value(source.get("category"), &CATEGORY_BASE_CP, "category")?;
    let rarity = enum_value(source.get("rarity"), &RARITY_MULTIPLIER_BPS, "rarity")?;
    let condition = enum_value(source.get("condition"), &CONDITION_MULTIPLIER_BPS, "condition")?;
    let category_base = lookup(&CATEGORY_BASE_CP, &category).unwrap_or(0);
    let rarity_bps = lookup(&RARITY_MULTIPLIER_BPS, &rarity).unwrap_or(0);
    let condition_bps = lookup(&CONDITION_MULTIPLIER_BPS, &condition).unwrap_or(0);
    let mut descriptor = Map::new();
    descriptor.insert("homebrew_id".into(), json!(homebrew_id));
    if let Some(item_id) = item_id {
        descriptor.insert("item_id".into(), json!(item_id));
    }
    descriptor.insert("name".into(), json!(name));
    descriptor.insert("category".into(), json!(category));
    descriptor.insert("rarity".into(), json!(rarity));
    descriptor.insert("condition".into(), json!(condition));
    let mut payload = Map::new();
    payload.insert("contract_version".into(), json!(ITEM_APPRAISAL_CONTRACT_VERSION));
    payload.insert("authoritative".into(), json!(true));
    payload.insert("currency".into(), json!("cp"));
    payload.insert("descriptor".into(), Value::Object(descriptor));
    payload.insert("base_price_cp".into(), json!(formula_price(category_base, rarity_bps, condition_bps)));
    payload.insert("provenance".into(), json!("server_appraisal_policy"));
    payload.insert("policy_id".into(), json!(CATEGORY_APPRAISAL_POLICY_ID));
    payload.insert(
        "formula".into(),
        json!({
            "formula_version": "category-rarity-condition-v1",
            "category_base_cp": category_base,
            "rarity_multiplier_bps": rarity_bps,
            "condition_multiplier_bps": condition_bps,
            "maximum_unit_price_cp": MAX_APPRAISED_UNIT_PRICE_CP,
        }),
    );
    Ok(with_fingerprint(payload))
}

/// `appraiseItem(input, options)`: аттестация цены. Политика передаётся
/// вторым, серверным аргументом (`{ policyId }`); `options: None` — `{}`.
pub fn appraise_item(input: Option<&Value>, options: Option<&Value>) -> Result<Value, ItemAppraisalError> {
    let source = input_object(input, "item")?;
    let empty_options = Value::Object(Map::new());
    let appraisal_options = input_object(Some(options.unwrap_or(&empty_options)), "options")?;
    assert_known_fields(source, &INPUT_FIELDS, "item")?;
    assert_known_fields(appraisal_options, &OPTION_FIELDS, "options")?;
    let policy_id = match appraisal_options.get("policyId") {
        None | Some(Value::Null) => None,
        Some(value) => normalized_id(Some(value), "policyId", true)?,
    };
    if present(source.get("catalog_id")) {
        catalog_appraisal(source, policy_id.as_deref())
    } else {
        homebrew_appraisal(source, policy_id.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_tables_keep_js_order() {
        let categories = &ITEM_APPRAISAL_POLICIES[CATEGORY_APPRAISAL_POLICY_ID]["categories"];
        assert_eq!(categories, &json!(["miscellaneous", "consumable", "tool", "treasure", "weapon", "armor"]));
        assert_eq!(formula_price(500, 250_000, 7_500), 9_375);
        assert_eq!(formula_price(25, 10_000, 1_000), 3);
        assert_eq!(formula_price(1_000, 5_000_000, 15_000), 750_000);
    }
}
