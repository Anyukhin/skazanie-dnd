//! Перенос `server/item-instances.mjs`: экземпляр предмета — вещь с историей
//! (владелец, происхождение, признак добычи) и замороженным снимком записи
//! каталога на момент создания.
//!
//! Снимок — требование replay: пересобранный баланс каталога не переписывает
//! прошлый бой, поэтому [`normalize_item_instance`] каталог не читает вовсе;
//! за записью ходит только [`create_item_instance`]. Снимок недоверенный (он
//! приходит из сохранения и payload события), и его приведение — граница:
//! числа, глубина, длина списков и число ключей ограничены, картинка — только
//! локальный путь сервера.
//!
//! **Ключи прототипа.** `catalogItem('constructor')` в JS находит функцию:
//! снимок такого кода — пустой объект, а создание экземпляра падает с
//! `Предмета undefined нет в каталоге`. Оба исхода видны снаружи и повторены.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};
use sk_items::item_catalog::{catalog_item, item_mechanics_support, materialize_catalog_item, normalize_item_recharge_profile, ITEM_ORIGIN_KINDS};

use crate::merchant_economy::{normalize_inventory_item_rarity, normalize_inventory_item_type, normalize_inventory_passive_effects};
use crate::support::{coalesce, get, js_order, nfkc_text, num, plain, safe_int, sha256_hex, hex8};

pub const ITEM_INSTANCE_SCHEMA_VERSION: i64 = 1;
/// Словарь происхождения один на оба мира — `ITEM_ORIGIN_KINDS` каталога.
pub const ITEM_INSTANCE_ORIGIN_KINDS: [&str; 8] = ITEM_ORIGIN_KINDS;
/// Кому вещь принадлежит: противнику или контейнеру (тело, пленный, схрон).
pub const ITEM_INSTANCE_OWNER_KINDS: [&str; 2] = ["enemy", "container"];
pub const MAX_ITEM_INSTANCE_QUANTITY: i64 = 999;
pub const MAX_ITEM_SNAPSHOT_NUMBER: i64 = 10_000_000;
pub const MAX_ITEM_SNAPSHOT_WEIGHT: i64 = 1_000;
pub const MAX_ITEM_INSTANCE_CHARGES: i64 = 1_000;
const MAX_SNAPSHOT_DEPTH: usize = 6;
const MAX_SNAPSHOT_KEYS: usize = 64;
const MAX_SNAPSHOT_ENTRIES: usize = 64;

/// Поля снимка — ровно то, что отдаёт `materializeCatalogItem`, без дубля
/// описания `properties`.
const SNAPSHOT_FIELDS: [&str; 19] = [
    "catalog_id",
    "catalog_schema_version",
    "name",
    "type",
    "weight",
    "description",
    "base_price_cp",
    "mechanics_status",
    "rarity",
    "combat",
    "passive_effects",
    "spellcasting_focus",
    "component_pouch",
    "material_component",
    "focus_mode",
    "charges",
    "recharge",
    "requires_attunement",
    "image",
];

/// Отказ экземпляра (`ItemInstanceError`): код и текст — как в JS.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ItemInstanceError {
    pub code: String,
    pub message: String,
}

fn reject<T>(message: impl Into<String>, code: &str) -> Result<T, ItemInstanceError> {
    Err(ItemInstanceError { code: code.into(), message: message.into() })
}

/// `${value}` шаблонной строки JS.
fn template(value: Option<&Value>) -> String {
    js::string(value)
}

enum Entry {
    Found(&'static Value),
}

fn lookup(catalog_id: Option<&Value>) -> Option<Entry> {
    catalog_item(&js::s(catalog_id)).map(Entry::Found)
}

fn unknown_catalog(catalog_id: Option<&Value>) -> ItemInstanceError {
    ItemInstanceError { code: "ITEM_INSTANCE_CATALOG_UNKNOWN".into(), message: format!("Предмета {} нет в каталоге", template(catalog_id)) }
}

/// `itemInstanceSnapshot(catalogId)`: снимок записи каталога тем же
/// приведением, что и чтение сохранённого.
pub fn item_instance_snapshot(catalog_id: Option<&Value>) -> Result<Value, ItemInstanceError> {
    match lookup(catalog_id) {
        None => Err(unknown_catalog(catalog_id)),
        Some(Entry::Found(entry)) => Ok(normalize_snapshot(Some(&materialize_catalog_item(&js::s(entry.get("catalog_id")), Some(&Value::Object(Map::new())))))),
    }
}

fn bounded_number(value: f64, minimum: f64, maximum: f64) -> Option<f64> {
    value.is_finite().then(|| maximum.min(minimum.max(value)))
}

/// `boundedValue(value, depth)`: снимок — данные, а не произвольный объект.
fn bounded_value(value: &Value, depth: usize) -> Option<Value> {
    let limit = MAX_ITEM_SNAPSHOT_NUMBER as f64;
    match value {
        Value::Null => Some(Value::Null),
        Value::Bool(_) => Some(value.clone()),
        Value::Number(_) => Some(bounded_number(js::number(Some(value)), -limit, limit).map_or(Value::Null, num)),
        Value::String(_) => Some(json!(nfkc_text(Some(value), 1_000))),
        _ if depth >= MAX_SNAPSHOT_DEPTH => None,
        Value::Array(items) => Some(Value::Array(items.iter().take(MAX_SNAPSHOT_ENTRIES).filter_map(|entry| bounded_value(entry, depth + 1)).collect())),
        Value::Object(map) => {
            let mut bounded = Map::new();
            for (key, nested) in js::entries(map).into_iter().take(MAX_SNAPSHOT_KEYS) {
                let key = nfkc_text(Some(&Value::String(key.clone())), 80);
                if key.is_empty() {
                    continue;
                }
                if let Some(nested) = bounded_value(nested, depth + 1) {
                    bounded.insert(key, nested);
                }
            }
            Some(Value::Object(js_order(bounded)))
        }
    }
}

/// Строки списка в нижнем регистре без пустых и повторов, не больше `limit`.
fn lowered_unique(value: Option<&Value>, maximum: usize, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    match value {
        Some(Value::Array(items)) => items.iter().map(|entry| text::lower(&nfkc_text(Some(entry), maximum))).filter(|entry| !entry.is_empty() && seen.insert(entry.clone())).take(limit).collect(),
        _ => Vec::new(),
    }
}

fn is_local_image(value: &str) -> bool {
    text::test(re!(r"^\/(?:assets|generated)\/items\/[a-z0-9][a-z0-9-]*\.(?:png|webp|jpe?g)$", "u"), value)
}

/// `normalizeSnapshot(input)`: граница replay и загрузки сохранения.
fn normalize_snapshot(input: Option<&Value>) -> Value {
    let mut snapshot = Map::new();
    if let Some(source) = plain(input) {
        for field in SNAPSHOT_FIELDS {
            if let Some(value) = source.get(field).and_then(|value| bounded_value(value, 0)) {
                snapshot.insert(field.into(), value);
            }
        }
    }
    let present = |snapshot: &Map<String, Value>, key: &str| js::present(snapshot.get(key));
    for (key, maximum) in [("catalog_id", 120), ("catalog_schema_version", 120), ("name", 120), ("description", 1_000)] {
        if present(&snapshot, key) {
            let value = nfkc_text(snapshot.get(key), maximum);
            snapshot.insert(key.into(), json!(value));
        }
    }
    if present(&snapshot, "type") {
        let value = normalize_inventory_item_type(snapshot.get("type"));
        snapshot.insert("type".into(), json!(value));
    }
    if present(&snapshot, "rarity") {
        let value = normalize_inventory_item_rarity(snapshot.get("rarity"));
        snapshot.insert("rarity".into(), json!(value));
    }
    if present(&snapshot, "mechanics_status") {
        let status = nfkc_text(snapshot.get("mechanics_status"), 40);
        if item_mechanics_support(&status).is_some() {
            snapshot.insert("mechanics_status".into(), json!(status));
        } else {
            snapshot.shift_remove("mechanics_status");
        }
    }
    if present(&snapshot, "weight") {
        let weight = bounded_number(js::number(snapshot.get("weight")), 0.0, MAX_ITEM_SNAPSHOT_WEIGHT as f64).unwrap_or(0.0);
        snapshot.insert("weight".into(), num(weight));
    }
    if present(&snapshot, "base_price_cp") {
        let price = safe_int(snapshot.get("base_price_cp"), 0).min(MAX_ITEM_SNAPSHOT_NUMBER).max(0);
        snapshot.insert("base_price_cp".into(), json!(price));
    }
    if present(&snapshot, "passive_effects") {
        let effects = normalize_inventory_passive_effects(snapshot.get("passive_effects"));
        if effects.is_empty() {
            snapshot.shift_remove("passive_effects");
        } else {
            snapshot.insert("passive_effects".into(), Value::Array(effects));
        }
    }
    if present(&snapshot, "spellcasting_focus") {
        let classes = lowered_unique(snapshot.get("spellcasting_focus"), 40, 16);
        if classes.is_empty() {
            snapshot.shift_remove("spellcasting_focus");
        } else {
            snapshot.insert("spellcasting_focus".into(), json!(classes));
        }
    }
    if present(&snapshot, "component_pouch") {
        let pouch = js::is_true(snapshot.get("component_pouch"));
        snapshot.insert("component_pouch".into(), json!(pouch));
    }
    if present(&snapshot, "material_component") {
        let material = plain(snapshot.get("material_component")).map(|map| Value::Object(map.clone()));
        let material = material.as_ref();
        let kind = text::lower(&nfkc_text(get(material, "kind"), 40));
        let value_cp = safe_int(get(material, "value_cp"), 0);
        let spell_ids = lowered_unique(get(material, "spell_ids"), 80, 32);
        if !kind.is_empty() && value_cp > 0 {
            let mut component = Map::new();
            component.insert("kind".into(), json!(kind));
            component.insert("value_cp".into(), json!(value_cp));
            if !spell_ids.is_empty() {
                component.insert("spell_ids".into(), json!(spell_ids));
            }
            snapshot.insert("material_component".into(), Value::Object(component));
        } else {
            snapshot.shift_remove("material_component");
        }
    }
    if present(&snapshot, "focus_mode") {
        let mode = text::lower(&nfkc_text(snapshot.get("focus_mode"), 40));
        if mode == "held" || mode == "worn" {
            snapshot.insert("focus_mode".into(), json!(mode));
        } else {
            snapshot.shift_remove("focus_mode");
        }
    }
    if present(&snapshot, "charges") {
        match normalize_charges(snapshot.get("charges")) {
            Some(charges) => {
                snapshot.insert("charges".into(), charges);
            }
            None => {
                snapshot.shift_remove("charges");
            }
        }
    }
    if present(&snapshot, "recharge") {
        match normalize_item_recharge_profile(snapshot.get("recharge")) {
            Some(recharge) => {
                snapshot.insert("recharge".into(), recharge);
            }
            None => {
                snapshot.shift_remove("recharge");
            }
        }
    }
    if present(&snapshot, "requires_attunement") {
        let required = js::is_true(snapshot.get("requires_attunement"));
        snapshot.insert("requires_attunement".into(), json!(required));
    }
    if present(&snapshot, "image") && !is_local_image(&js::string(snapshot.get("image"))) {
        snapshot.shift_remove("image");
    }
    Value::Object(snapshot)
}

fn normalize_charges(input: Option<&Value>) -> Option<Value> {
    let source = plain(input)?;
    let maximum = MAX_ITEM_INSTANCE_CHARGES.min(safe_int(source.get("max"), 0)).max(0);
    if maximum <= 0 {
        return None;
    }
    let current = maximum.min(safe_int(source.get("current"), maximum)).max(0);
    Some(json!({ "current": current, "max": maximum }))
}

fn normalize_owner(input: Option<&Value>) -> Option<Value> {
    let source = plain(input);
    let field = |key: &str| source.and_then(|map| map.get(key));
    let kind = nfkc_text(field("kind"), 40);
    let actor_id = nfkc_text(coalesce(field("actor_id"), field("actorId")), 120);
    (ITEM_INSTANCE_OWNER_KINDS.contains(&kind.as_str()) && !actor_id.is_empty()).then(|| json!({ "kind": kind, "actor_id": actor_id }))
}

fn normalize_origin(input: Option<&Value>) -> Option<Value> {
    let source = plain(input);
    let field = |key: &str| source.and_then(|map| map.get(key));
    let kind = nfkc_text(field("kind"), 40);
    if !ITEM_INSTANCE_ORIGIN_KINDS.contains(&kind.as_str()) {
        return None;
    }
    Some(json!({
        "kind": kind,
        "template_id": nfkc_text(coalesce(field("template_id"), field("templateId")), 120),
        "source_id": nfkc_text(coalesce(field("source_id"), field("sourceId")), 160),
    }))
}

/// `createItemInstance({ catalogId, instanceId, quantity, equipped, charges,
/// owner, origin, lootable })`: единственное место, где читается живой каталог.
pub fn create_item_instance(input: Option<&Value>) -> Result<Value, ItemInstanceError> {
    let field = |key: &str| get(input, key);
    let catalog_id = field("catalogId");
    let Some(entry) = lookup(catalog_id) else {
        return Err(unknown_catalog(catalog_id));
    };
    let id = nfkc_text(field("instanceId"), 160);
    if id.is_empty() {
        return reject("У экземпляра предмета должен быть item_instance_id", "ITEM_INSTANCE_ID_REQUIRED");
    }
    let Some(owner) = normalize_owner(field("owner")) else {
        return reject("У экземпляра предмета должен быть владелец", "ITEM_INSTANCE_OWNER_REQUIRED");
    };
    let Some(origin) = normalize_origin(field("origin")) else {
        return reject("У экземпляра предмета должно быть происхождение", "ITEM_INSTANCE_ORIGIN_REQUIRED");
    };
    // `quantity = 1`: запас подставляется только вместо `undefined`.
    let one = json!(1);
    let count = safe_int(Some(field("quantity").unwrap_or(&one)), 1);
    if !(1..=MAX_ITEM_INSTANCE_QUANTITY).contains(&count) {
        return reject("Количество экземпляра вне допустимых границ", "ITEM_INSTANCE_QUANTITY_OUT_OF_RANGE");
    }
    let Entry::Found(entry) = entry;
    let snapshot = item_instance_snapshot(entry.get("catalog_id"))?;
    let instance_charges = normalize_charges(coalesce(field("charges"), snapshot.get("charges")));
    let lootable = match field("lootable") {
        None | Some(Value::Null) => js::is_true(entry.get("corpse_loot_eligible")),
        Some(value) => js::is_true(Some(value)),
    };
    let mut instance = Map::new();
    instance.insert("schema_version".into(), json!(ITEM_INSTANCE_SCHEMA_VERSION));
    instance.insert("item_instance_id".into(), json!(id));
    instance.insert("catalog_id".into(), entry.get("catalog_id").cloned().unwrap_or(Value::Null));
    instance.insert("snapshot".into(), snapshot);
    instance.insert("quantity".into(), json!(count));
    if let Some(charges) = instance_charges {
        instance.insert("charges".into(), charges);
    }
    instance.insert("equipped".into(), json!(js::is_true(field("equipped"))));
    instance.insert("owner".into(), owner);
    instance.insert("origin".into(), origin);
    instance.insert("lootable".into(), json!(lootable));
    Ok(Value::Object(instance))
}

/// `normalizeItemInstance(input)`: экземпляр из сохранения или payload
/// события; каталог не читается. `None` — запись экземпляром не является.
pub fn normalize_item_instance(input: Option<&Value>) -> Option<Value> {
    let source = plain(input)?;
    let id = nfkc_text(coalesce(source.get("item_instance_id"), source.get("itemInstanceId")), 160);
    let catalog_id = nfkc_text(coalesce(source.get("catalog_id"), source.get("catalogId")), 120);
    let owner = normalize_owner(source.get("owner"));
    let origin = normalize_origin(source.get("origin"));
    if id.is_empty() || catalog_id.is_empty() {
        return None;
    }
    let (owner, origin) = (owner?, origin?);
    let charges = normalize_charges(source.get("charges"));
    let mut instance = Map::new();
    instance.insert("schema_version".into(), json!(ITEM_INSTANCE_SCHEMA_VERSION));
    instance.insert("item_instance_id".into(), json!(id));
    instance.insert("catalog_id".into(), json!(catalog_id));
    instance.insert("snapshot".into(), normalize_snapshot(source.get("snapshot")));
    instance.insert("quantity".into(), json!(MAX_ITEM_INSTANCE_QUANTITY.min(safe_int(source.get("quantity"), 1)).max(1)));
    if let Some(charges) = charges {
        instance.insert("charges".into(), charges);
    }
    instance.insert("equipped".into(), json!(js::is_true(source.get("equipped"))));
    instance.insert("owner".into(), owner);
    instance.insert("origin".into(), origin);
    instance.insert("lootable".into(), json!(js::is_true(source.get("lootable"))));
    Some(Value::Object(instance))
}

/// `seededInteger(seed, label, minimum, maximum)`: детерминированное целое из
/// сида — один сид, один инвентарь после replay и рестарта.
pub fn seeded_integer(seed: &str, label: &str, minimum: i64, maximum: i64) -> i64 {
    let low = minimum.min(maximum);
    let high = minimum.max(maximum);
    if high == low {
        return low;
    }
    let digest = sha256_hex(&format!("{seed}\u{0}{label}"));
    low + (hex8(&digest) % (high - low + 1) as u64) as i64
}
