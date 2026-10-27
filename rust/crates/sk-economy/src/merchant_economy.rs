//! Перенос `server/merchant-economy.mjs`: экономика торговца — склад, цены по
//! серверному каталогу, наценка и выкуп, торг, услуги, часы лавки (плановое
//! пополнение склада по минутам кампании), кошелёк торговца, нормализация
//! записей торговцев и инвентаря героя, витрина для игрока.
//!
//! Цена известна только серверу: каталог SRD (`SRD_EQUIPMENT_CATALOG`) или
//! подтверждённая событием оценка (`trusted*Appraisal*`). Цены и метки из
//! снимка состояния ценой не считаются.
//!
//! **Ключи прототипа.** `SRD_EQUIPMENT_CATALOG['constructor']` в JS находит
//! функцию, и `resolveCatalogPrice` отдаёт для такого кода
//! `{ provenance: 'catalog' }` без цены — это видно в витрине
//! (`price_provenance`), поэтому повторено. Остальные динамические ключи
//! (`bargains[actorId]`, `vitals[npcId]`, реестр оценок) на ключах прототипа
//! ведут себя как отсутствующие, как и в JS.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};
use sk_items::item_catalog::{catalog_item, catalog_item_truthy, hydrate_catalog_item, materialize_catalog_item, normalize_item_origin_kind, normalize_item_recharge_profile, DEFAULT_ITEM_ORIGIN_KIND, ITEM_CATALOG_SCHEMA_VERSION};
pub use sk_items::item_catalog::{ITEM_CATALOG_SOURCE as ECONOMY_CATALOG_SOURCE, SRD_EQUIPMENT_CATALOG};
use sk_social::npc_social::npc_profile_at_world_time;
use sk_society::reputation_policy::reputation_standing_for;
use sk_society::underworld::{npc_is_fence, STOLEN_DISCOUNT_BPS};

use crate::support::{array, ceil_div, clamp_int, clamp_num, clean_id, clean_text, coalesce, copy_field, empty, floor_div, get, is_object_like, js_order, num, plain, safe_int, sha256_hex, spread_of, stable_value, string_or_empty, stringify, utf16_cmp};

pub const ECONOMY_POLICY_ID: &str = "skazanie:economy:merchant-policy-v1";
pub const ECONOMY_CATALOG_VERSION: &str = "srd_5_2_1";

/// Общий денежный предел: платина — крупнейший номинал, 9 000 000 ПМ.
pub const MAX_CURRENCY_CP: i64 = 9_000_000_000;
/// Детерминированный запас кошелька для торговцев из старых сохранений.
pub const DEFAULT_MERCHANT_PURSE_CP: i64 = 100_000;
pub const MAX_TRANSACTION_QUANTITY: i64 = 999;
pub const MAX_STOCK_QUANTITY: i64 = 999_999;
pub const MAX_UNIT_PRICE_CP: i64 = 100_000_000;
pub const ITEM_APPRAISAL_CONTRACT_VERSION: &str = "skazanie:item-appraisal:v1";
pub const ITEM_APPRAISAL_POLICY_ID: &str = "skazanie:item-appraisal:category-rarity-condition:v1";
pub const MERCHANT_SERVICES_POLICY_ID: &str = "skazanie:economy:merchant-services-v1";
pub const MERCHANT_RESTOCK_POLICY_ID: &str = "skazanie:economy:merchant-restock-v1";
pub const MERCHANT_ECONOMY_CLOCK_EVENT_TYPE: &str = "MerchantEconomyClockAdvanced";
pub const MIN_RESTOCK_INTERVAL_MINUTES: i64 = 60;
pub const MAX_RESTOCK_INTERVAL_MINUTES: i64 = 525_600;
pub const MAX_WORLD_MINUTE: i64 = 1_000_000_000;

const INVENTORY_ITEM_TYPES: [&str; 8] = ["weapon", "armor", "consumable", "tool", "quest", "treasure", "document", "other"];
const MERCHANT_SERVICE_KINDS: [&str; 6] = ["appraisal", "lodging", "repair", "transport", "training", "other"];
const INVENTORY_ITEM_RARITIES: [&str; 6] = ["обычный", "необычный", "редкий", "очень редкий", "легендарный", "сюжетный"];

// ---------------------------------------------------------------------------
// Место торговца
// ---------------------------------------------------------------------------

/// `canonicalLocationKey(value)`: ключ места для сравнения (NFKC, пробелы
/// схлопнуты, до 180 символов, нижний регистр).
pub fn canonical_location_key(value: Option<&Value>) -> String {
    let normalized = text::nfkc(&js::s(value));
    let collapsed = text::replace_all(re!(r"\s+", "gu"), &normalized, " ");
    text::lower(&text::head(text::trim(&collapsed), 180))
}

/// `canonicalLocationId(value)`.
pub fn canonical_location_id(value: Option<&Value>) -> String {
    text::head(text::trim(&js::s(value)), 120)
}

fn location_reference(value: Option<&Value>) -> (String, String) {
    let source = plain(value);
    let id = canonical_location_id(source.and_then(|map| coalesce(map.get("location_id"), map.get("locationId"))));
    let key = match source {
        Some(map) => canonical_location_key(coalesce(map.get("location"), map.get("name"))),
        None => canonical_location_key(value),
    };
    (id, key)
}

/// `locationsMatch(left, right)`: по `location_id`, если он есть у обоих, иначе по ключу места.
pub fn locations_match(left: Option<&Value>, right: Option<&Value>) -> bool {
    let (left_id, left_key) = location_reference(left);
    let (right_id, right_key) = location_reference(right);
    if !left_id.is_empty() && !right_id.is_empty() {
        return left_id == right_id;
    }
    left_key == right_key
}

/// `merchantIsAtLocation`: торговец без места доступен везде (прежнее правило).
pub fn merchant_is_at_location(merchant_location: Option<&Value>, scene_location: Option<&Value>) -> bool {
    let (id, key) = location_reference(merchant_location);
    (id.is_empty() && key.is_empty()) || locations_match(merchant_location, scene_location)
}

/// Итог `merchantTradeAvailabilityFor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TradeAvailability {
    pub can_trade: bool,
    pub code: Option<&'static str>,
    pub reason: Option<String>,
}

impl TradeAvailability {
    fn open() -> Self {
        Self { can_trade: true, code: None, reason: None }
    }

    fn closed(code: &'static str, reason: impl Into<String>) -> Self {
        Self { can_trade: false, code: Some(code), reason: Some(reason.into()) }
    }

    /// Форма JS: `{ can_trade, code, reason }`.
    pub fn to_json(&self) -> Value {
        json!({ "can_trade": self.can_trade, "code": self.code, "reason": self.reason })
    }
}

const MERCHANT_UNAVAILABLE: &str = "Торговец сейчас недоступен";
const MERCHANT_NOT_PRESENT: &str = "Торговец находится в другой локации";

/// `merchantTradeAvailabilityFor(state, merchantOrId, { allowRemote })`:
/// единственная проверка, может ли торговец сейчас принимать сделки — лавка,
/// человек на карте (расписание, жизнь, плен) и розыск отряда.
pub fn merchant_trade_availability_for(state: &Value, merchant_or_id: Option<&Value>, allow_remote: bool) -> TradeAvailability {
    let merchant = if is_object_like(merchant_or_id) { merchant_or_id } else { find_merchant(state, merchant_or_id) };
    let Some(merchant) = merchant else {
        return TradeAvailability::closed("MERCHANT_NOT_FOUND", "Торговец не найден");
    };
    if js::is_false(merchant.get("available")) {
        return TradeAvailability::closed("MERCHANT_UNAVAILABLE", MERCHANT_UNAVAILABLE);
    }
    let scene = get(Some(state), "scene");
    if !allow_remote && !merchant_is_at_location(Some(merchant), scene) {
        return TradeAvailability::closed("MERCHANT_NOT_PRESENT", MERCHANT_NOT_PRESENT);
    }

    let merchant_id = js::s(merchant.get("id"));
    let social_npc = array(get(get(Some(state), "social"), "npcs")).iter().find(|npc| js::s(get(Some(npc), "id")) == merchant_id).filter(|npc| js::truthy(Some(npc)));
    let current_social_npc = social_npc.map(|npc| npc_profile_at_world_time(npc, state));
    if current_social_npc.as_ref().is_some_and(|npc| js::is_false(npc.get("available"))) {
        return TradeAvailability::closed("MERCHANT_UNAVAILABLE", MERCHANT_UNAVAILABLE);
    }
    if let Some(npc) = current_social_npc.as_ref() {
        if !allow_remote && !merchant_is_at_location(Some(npc), scene) {
            return TradeAvailability::closed("MERCHANT_NOT_PRESENT", MERCHANT_NOT_PRESENT);
        }
    }

    let vital = get(get(get(Some(state), "npc_world"), "vitals"), &merchant_id);
    if js::truthy(vital) && (js::is_false(get(vital, "alive")) || js::number(get(vital, "hp")) <= 0.0) {
        return TradeAvailability::closed("MERCHANT_UNAVAILABLE", MERCHANT_UNAVAILABLE);
    }

    let captives_root = get(Some(state), "captives");
    let captives = match get(captives_root, "captives") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => array(captives_root),
    };
    if captives.iter().any(|captive| js::s(get(Some(captive), "npc_id")) == merchant_id && get(Some(captive), "status").and_then(Value::as_str) == Some("held")) {
        return TradeAvailability::closed("MERCHANT_UNAVAILABLE", MERCHANT_UNAVAILABLE);
    }

    let standing = reputation_standing_for(state, &Value::String(merchant_id));
    if js::is_false(standing.get("trade_available")) {
        let reason = if js::truthy(standing.get("trade_refusal_reason")) { js::s(standing.get("trade_refusal_reason")) } else { "Торговец отказывается иметь дело с отрядом".to_string() };
        return TradeAvailability::closed("TRADE_REFUSED_BY_WANTED_LEVEL", reason);
    }
    TradeAvailability::open()
}

// ---------------------------------------------------------------------------
// Поля вещи: тип, редкость, пассивные эффекты
// ---------------------------------------------------------------------------

/// `normalizeInventoryItemType` (`normalizeItemType`): известный тип вещи или `other`.
pub fn normalize_inventory_item_type(value: Option<&Value>) -> String {
    let kind = text::lower(&clean_text(value, 40, "other"));
    if ["trade_good", "trade-good", "valuable"].contains(&kind.as_str()) {
        return "treasure".into();
    }
    if INVENTORY_ITEM_TYPES.contains(&kind.as_str()) {
        kind
    } else {
        "other".into()
    }
}

/// `normalizeInventoryItemRarity` (`normalizeItemRarity`).
pub fn normalize_inventory_item_rarity(value: Option<&Value>) -> String {
    let rarity = text::lower(&clean_text(value, 60, "обычный"));
    if INVENTORY_ITEM_RARITIES.contains(&rarity.as_str()) {
        rarity
    } else {
        "обычный".into()
    }
}

/// `[...new Set(list.slice(0, 32).map(cleanText(x, max).toLowerCase()).filter(Boolean))].sort()`.
fn lowered_set(value: Option<&Value>, maximum: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut items: Vec<String> = array(value).iter().take(32).map(|entry| text::lower(&clean_text(Some(entry), maximum, ""))).filter(|entry| !entry.is_empty() && seen.insert(entry.clone())).collect();
    items.sort_by(|left, right| utf16_cmp(left, right));
    items
}

/// `normalizeInventoryPassiveEffects` (`normalizePassiveEffects`): только
/// оформленные эффекты схемы 1 с ограниченными надбавками.
pub fn normalize_inventory_passive_effects(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(candidates)) = value else {
        return Vec::new();
    };
    candidates
        .iter()
        .take(32)
        .filter_map(|candidate| {
            let source = plain(Some(candidate))?;
            if clamp_int(source.get("schema_version"), 0, 1_000, 0) != 1 {
                return None;
            }
            let effect_id = clean_id(source.get("effect_id"), "");
            let group = clean_id(source.get("group"), "");
            if effect_id.is_empty() || group.is_empty() {
                return None;
            }
            let armor_class_bonus = clamp_int(source.get("armor_class_bonus"), 0, 100, 0);
            let saving_throw_bonus = clamp_int(source.get("saving_throw_bonus"), 0, 100, 0);
            let damage_resistances = lowered_set(source.get("damage_resistances"), 40);
            let spell_immunities = lowered_set(source.get("spell_immunities"), 80);
            let rider_source = plain(source.get("weapon_damage_rider"));
            let rider_expression = text::replace_all(re!(r"\s+", "gu"), &text::lower(&clean_text(rider_source.and_then(|rider| rider.get("expression")), 40, "")), "");
            let rider_damage_type = text::lower(&clean_text(rider_source.and_then(|rider| rider.get("damage_type")), 40, ""));
            let weapon_damage_rider = (text::test(re!(r"^([1-9]|1\d|20)d(4|6|8|10|12)$", "u"), &rider_expression) && !rider_damage_type.is_empty()).then(|| {
                json!({
                    "expression": rider_expression,
                    "damage_type": rider_damage_type,
                    "critical_doubles": js::is_true(rider_source.and_then(|rider| rider.get("critical_doubles"))),
                })
            });
            let prevents_critical_hits = js::is_true(source.get("prevents_critical_hits"));
            let initiative_advantage = js::is_true(source.get("initiative_advantage"));
            if armor_class_bonus == 0 && saving_throw_bonus == 0 && damage_resistances.is_empty() && spell_immunities.is_empty() && !prevents_critical_hits && !initiative_advantage && weapon_damage_rider.is_none() {
                return None;
            }
            let mut effect = Map::new();
            effect.insert("schema_version".into(), json!(1));
            effect.insert("effect_id".into(), json!(effect_id));
            effect.insert("group".into(), json!(group));
            effect.insert("requires_equipped".into(), json!(js::is_true(source.get("requires_equipped"))));
            effect.insert("requires_attunement".into(), json!(js::is_true(source.get("requires_attunement"))));
            if js::is_true(source.get("requires_activated")) {
                effect.insert("requires_activated".into(), json!(true));
            }
            effect.insert("armor_class_bonus".into(), json!(armor_class_bonus));
            effect.insert("saving_throw_bonus".into(), json!(saving_throw_bonus));
            if !damage_resistances.is_empty() {
                effect.insert("damage_resistances".into(), json!(damage_resistances));
            }
            if !spell_immunities.is_empty() {
                effect.insert("spell_immunities".into(), json!(spell_immunities));
            }
            if prevents_critical_hits {
                effect.insert("prevents_critical_hits".into(), json!(true));
            }
            if initiative_advantage {
                effect.insert("initiative_advantage".into(), json!(true));
            }
            if let Some(rider) = weapon_damage_rider {
                effect.insert("weapon_damage_rider".into(), rider);
            }
            Some(Value::Object(effect))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Стопка и вещь инвентаря
// ---------------------------------------------------------------------------

/// `Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : 0`.
fn weight_of(value: Option<&Value>) -> f64 {
    let weight = js::number(value);
    if weight.is_finite() {
        weight.max(0.0)
    } else {
        0.0
    }
}

/// `inventoryStackKey(input)`: опознание стопки выводит сервер — по каталогу,
/// цене, тексту, механике и происхождению; `stack_key` снимка не читается.
pub fn inventory_stack_key(input: Option<&Value>) -> String {
    let empty_map = Map::new();
    let source = plain(input).unwrap_or(&empty_map);
    let source_value = Value::Object(source.clone());
    let catalog_id = clean_id(coalesce(source.get("catalog_id"), source.get("catalogId")), "");
    let base_price_cp = resolve_catalog_base_price_cp(Some(&source_value));
    let passive_effects = normalize_inventory_passive_effects(source.get("passive_effects"));
    let recharge = normalize_item_recharge_profile(source.get("recharge"));
    let object_or_null = |key: &str| source.get(key).filter(|value| js::truthy(Some(value)) && is_object_like(Some(value))).cloned().unwrap_or(Value::Null);
    let mut descriptor = Map::new();
    descriptor.insert("catalog_id".into(), if catalog_id.is_empty() { Value::Null } else { json!(catalog_id) });
    descriptor.insert("base_price_cp".into(), json!(base_price_cp));
    descriptor.insert("name".into(), json!(clean_text(source.get("name"), 120, "Предмет")));
    descriptor.insert("type".into(), json!(normalize_inventory_item_type(source.get("type"))));
    descriptor.insert("weight".into(), num(weight_of(source.get("weight"))));
    descriptor.insert("rarity".into(), json!(normalize_inventory_item_rarity(source.get("rarity"))));
    descriptor.insert("description".into(), json!(clean_text(source.get("description"), 1_000, "")));
    descriptor.insert("properties".into(), json!(clean_text(source.get("properties"), 500, "")));
    descriptor.insert("combat".into(), object_or_null("combat"));
    if !passive_effects.is_empty() {
        descriptor.insert("passive_effects".into(), Value::Array(passive_effects));
    }
    if let Some(recharge) = recharge {
        descriptor.insert("recharge".into(), recharge);
    }
    descriptor.insert("charges".into(), object_or_null("charges"));
    descriptor.insert("requires_attunement".into(), if js::is_true(source.get("requires_attunement")) { json!(true) } else { Value::Null });
    descriptor.insert("attuned_to".into(), if js::present(source.get("attuned_to")) { json!(clean_id(source.get("attuned_to"), "")) } else { Value::Null });
    descriptor.insert("sellable".into(), if js::is_false(source.get("sellable")) { json!(false) } else { Value::Null });
    descriptor.insert("quest_item".into(), if js::is_true(source.get("quest_item")) { json!(true) } else { Value::Null });
    descriptor.insert("price_provenance".into(), if js::present(source.get("price_provenance")) { json!(clean_text(source.get("price_provenance"), 60, "")) } else { Value::Null });
    descriptor.insert("appraisal_policy_id".into(), if js::present(source.get("appraisal_policy_id")) { json!(clean_text(source.get("appraisal_policy_id"), 120, "")) } else { Value::Null });
    descriptor.insert("origin".into(), json!(normalize_item_origin_kind(source.get("origin"), DEFAULT_ITEM_ORIGIN_KIND)));
    let digest = sha256_hex(&stringify(&stable_value(&Value::Object(descriptor))));
    let prefix = if catalog_id.is_empty() { "custom".to_string() } else { text::head(&catalog_id, 80) };
    format!("{prefix}:{}", &digest[..32])
}

/// Параметры `normalizeInventoryItem(input, { idFallback, preserveUnknown, hydrateCatalog })`.
#[derive(Debug, Clone, Copy)]
pub struct InventoryItemOptions<'a> {
    pub id_fallback: &'a str,
    pub preserve_unknown: bool,
    pub hydrate_catalog: bool,
}

impl Default for InventoryItemOptions<'_> {
    fn default() -> Self {
        Self { id_fallback: "item", preserve_unknown: false, hydrate_catalog: false }
    }
}

/// `normalizeInventoryItem(input, options)`: серверная форма вещи инвентаря,
/// общая для импорта состояния и replay. Каталог подтягивается только по
/// явной просьбе (`hydrate_catalog`): старые payload не должны получать новых
/// полей оттого, что каталог вырос.
pub fn normalize_inventory_item(input: Option<&Value>, options: InventoryItemOptions<'_>) -> Value {
    let original = Value::Object(plain(input).cloned().unwrap_or_default());
    let source_value = if options.hydrate_catalog { hydrate_catalog_item(Some(&original)) } else { original };
    let empty_map = Map::new();
    let source = source_value.as_object().unwrap_or(&empty_map);
    let catalog_id = clean_id(coalesce(source.get("catalog_id"), source.get("catalogId")), "");
    let catalog = if catalog_id.is_empty() { None } else { catalog_item(&catalog_id) };
    let resolved_price = catalog_base_price_by_id(&clean_id(Some(&json!(catalog_id)), ""));
    let charges_source = source.get("charges");
    let max_charges = clamp_int(get(charges_source, "max"), 0, 1_000_000, 0);
    let passive_effects = normalize_inventory_passive_effects(source.get("passive_effects"));
    let recharge = if !catalog_id.is_empty() && catalog_item_truthy(&catalog_id) {
        normalize_item_recharge_profile(catalog.and_then(|entry| entry.get("recharge")))
    } else {
        normalize_item_recharge_profile(source.get("recharge"))
    };
    let field = |key: &str| catalog.and_then(|entry| entry.get(key));

    let mut item = if options.preserve_unknown { source.clone() } else { Map::new() };
    item.insert("id".into(), json!(clean_id(coalesce(source.get("item_id"), source.get("id")), options.id_fallback)));
    if !catalog_id.is_empty() {
        item.insert("catalog_id".into(), json!(catalog_id));
    }
    if js::present(source.get("catalog_schema_version")) {
        item.insert("catalog_schema_version".into(), json!(clean_text(source.get("catalog_schema_version"), 120, ITEM_CATALOG_SCHEMA_VERSION)));
    }
    if js::present(source.get("mechanics_status")) {
        item.insert("mechanics_status".into(), json!(clean_text(source.get("mechanics_status"), 40, "")));
    }
    item.insert("name".into(), json!(clean_text(source.get("name"), 120, "Предмет")));
    item.insert("type".into(), json!(normalize_inventory_item_type(source.get("type"))));
    item.insert("quantity".into(), json!(clamp_int(source.get("quantity"), 1, MAX_STOCK_QUANTITY, 1)));
    item.insert("weight".into(), num(weight_of(source.get("weight"))));
    item.insert("equipped".into(), json!(js::is_true(source.get("equipped"))));
    if js::is_true(source.get("activated")) {
        item.insert("activated".into(), json!(true));
    }
    item.insert("rarity".into(), json!(normalize_inventory_item_rarity(source.get("rarity"))));
    item.insert("description".into(), json!(clean_text(source.get("description"), 1_000, "")));
    item.insert("properties".into(), json!(clean_text(source.get("properties"), 500, "")));
    item.insert("image".into(), json!(clean_text(source.get("image"), 500, "")));
    for (key, maximum) in [("imagePosition", 80), ("imagePrompt", 1_000), ("imageStatus", 40)] {
        if js::present(source.get(key)) {
            item.insert(key.into(), json!(clean_text(source.get(key), maximum, "")));
        }
    }
    if let Some(combat) = source.get("combat").filter(|combat| is_object_like(Some(combat))) {
        item.insert("combat".into(), combat.clone());
    }
    if let Some(focus) = field("spellcasting_focus").filter(|focus| focus.is_array()) {
        item.insert("spellcasting_focus".into(), focus.clone());
    }
    if js::is_true(field("component_pouch")) {
        item.insert("component_pouch".into(), json!(true));
    }
    if let Some(material) = field("material_component").filter(|material| js::truthy(Some(material))) {
        item.insert("material_component".into(), material.clone());
    }
    if let Some(mode) = field("focus_mode").filter(|mode| js::truthy(Some(mode))) {
        item.insert("focus_mode".into(), mode.clone());
    }
    if !passive_effects.is_empty() {
        item.insert("passive_effects".into(), Value::Array(passive_effects.clone()));
    }
    if is_object_like(charges_source) {
        item.insert("charges".into(), json!({ "current": clamp_int(get(charges_source, "current"), 0, max_charges, 0), "max": max_charges }));
    }
    if let Some(recharge) = recharge.clone() {
        item.insert("recharge".into(), recharge);
    }
    if js::is_true(source.get("requires_attunement")) {
        item.insert("requires_attunement".into(), json!(true));
    }
    if js::present(source.get("attuned_to")) {
        item.insert("attuned_to".into(), json!(clean_id(source.get("attuned_to"), "")));
    }
    if js::is_false(source.get("sellable")) {
        item.insert("sellable".into(), json!(false));
    }
    if js::is_true(source.get("quest_item")) {
        item.insert("quest_item".into(), json!(true));
    }
    if js::present(source.get("price_provenance")) {
        item.insert("price_provenance".into(), json!(clean_text(source.get("price_provenance"), 60, "")));
    }
    if js::present(source.get("appraisal_policy_id")) {
        item.insert("appraisal_policy_id".into(), json!(clean_text(source.get("appraisal_policy_id"), 120, "")));
    }
    if resolved_price > 0 {
        item.insert("base_price_cp".into(), json!(resolved_price));
    }
    item.insert("origin".into(), json!(normalize_item_origin_kind(source.get("origin"), DEFAULT_ITEM_ORIGIN_KIND)));

    // Метаданные компонентов принадлежат каталогу, а не полю импорта.
    if !field("spellcasting_focus").is_some_and(Value::is_array) {
        item.shift_remove("spellcasting_focus");
    }
    if !js::is_true(field("component_pouch")) {
        item.shift_remove("component_pouch");
    }
    if !js::truthy(field("material_component")) {
        item.shift_remove("material_component");
    }
    if !js::truthy(field("focus_mode")) {
        item.shift_remove("focus_mode");
    }
    if passive_effects.is_empty() {
        item.shift_remove("passive_effects");
    }
    if recharge.is_none() {
        item.shift_remove("recharge");
    }
    let stack_key = inventory_stack_key(Some(&Value::Object(item.clone())));
    item.insert("stack_key".into(), json!(stack_key));
    Value::Object(item)
}

// ---------------------------------------------------------------------------
// Деньги
// ---------------------------------------------------------------------------

/// `normalizeCurrency(input)`: номиналы в пределах; сумма сверх общего
/// предела сводится к каноническому разложению предела.
pub fn normalize_currency(input: Option<&Value>) -> Value {
    let source = plain(input);
    let field = |key: &str| source.and_then(|map| map.get(key));
    let copper = clamp_int(field("copper"), 0, 9_000_000_000, 0);
    let silver = clamp_int(field("silver"), 0, 900_000_000, 0);
    let gold = clamp_int(field("gold"), 0, 90_000_000, 0);
    let platinum = clamp_int(field("platinum"), 0, 9_000_000, 0);
    let total = copper + silver * 10 + gold * 100 + platinum * 1_000;
    if total <= MAX_CURRENCY_CP {
        json!({ "copper": copper, "silver": silver, "gold": gold, "platinum": platinum })
    } else {
        canonical_currency(MAX_CURRENCY_CP)
    }
}

/// `currencyToCopper(input)`.
pub fn currency_to_copper(input: Option<&Value>) -> i64 {
    let currency = normalize_currency(input);
    let part = |key: &str| currency.get(key).and_then(Value::as_i64).unwrap_or(0);
    part("copper") + part("silver") * 10 + part("gold") * 100 + part("platinum") * 1_000
}

fn canonical_currency(amount: i64) -> Value {
    let mut remaining = amount.clamp(0, MAX_CURRENCY_CP);
    let platinum = remaining / 1_000;
    remaining -= platinum * 1_000;
    let gold = remaining / 100;
    remaining -= gold * 100;
    let silver = remaining / 10;
    let copper = remaining - silver * 10;
    json!({ "copper": copper, "silver": silver, "gold": gold, "platinum": platinum })
}

/// `copperToCurrency(input)`: медяки в каноническом разложении (`input` — любое значение JS).
pub fn copper_to_currency(input: Option<&Value>) -> Value {
    canonical_currency(clamp_int(input, 0, MAX_CURRENCY_CP, 0))
}

/// `normalizeMerchantPurseCp(value, fallback)`; `fallback: None` — запас по умолчанию.
pub fn normalize_merchant_purse_cp(value: Option<&Value>, fallback: Option<&Value>) -> i64 {
    let safe_fallback = match fallback {
        None => DEFAULT_MERCHANT_PURSE_CP,
        Some(fallback) => clamp_int(Some(fallback), 0, MAX_CURRENCY_CP, DEFAULT_MERCHANT_PURSE_CP),
    };
    clamp_int(value, 0, MAX_CURRENCY_CP, safe_fallback)
}

// ---------------------------------------------------------------------------
// Цена: каталог и подтверждённая оценка
// ---------------------------------------------------------------------------

fn catalog_price_by_id(catalog_id: &str) -> Option<Value> {
    if let Some(entry) = SRD_EQUIPMENT_CATALOG.get(catalog_id) {
        let mut price = entry.as_object().cloned().unwrap_or_default();
        price.insert("provenance".into(), json!("catalog"));
        return Some(Value::Object(price));
    }
    None
}

fn catalog_base_price_by_id(catalog_id: &str) -> i64 {
    catalog_price_by_id(catalog_id).and_then(|price| price.get("base_price_cp").and_then(Value::as_i64)).unwrap_or(0)
}

/// `resolveCatalogPrice(input)`: запись каталога с `provenance: 'catalog'`
/// или `None`. Метки снимка (`price_provenance`) цены не дают.
pub fn resolve_catalog_price(input: Option<&Value>) -> Option<Value> {
    catalog_price_by_id(&clean_id(coalesce(get(input, "catalog_id"), get(input, "catalogId")), ""))
}

/// `resolveCatalogBasePriceCp(input)`: каталожная цена или 0.
pub fn resolve_catalog_base_price_cp(input: Option<&Value>) -> i64 {
    resolve_catalog_price(input).and_then(|price| price.get("base_price_cp").and_then(Value::as_i64)).unwrap_or(0)
}

fn is_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn trusted_appraisal_record(input: Option<&Value>, item: Option<&Value>, actor_id: Option<&Value>) -> Option<Value> {
    let appraisal = plain(input)?;
    if !is_object_like(item) {
        return None;
    }
    let base_price_cp = safe_int(coalesce(appraisal.get("base_price_cp"), appraisal.get("base_unit_price_cp")), 0);
    let string_is = |key: &str, expected: &str| appraisal.get(key).and_then(Value::as_str) == Some(expected);
    let item_id = js::s(coalesce(get(item, "id"), get(item, "item_id")));
    if !js::is_true(appraisal.get("authoritative"))
        || !string_is("contract_version", ITEM_APPRAISAL_CONTRACT_VERSION)
        || !string_is("policy_id", ITEM_APPRAISAL_POLICY_ID)
        || !string_is("provenance", "server_appraisal_policy")
        || !string_is("currency", "cp")
        || !is_fingerprint(&js::s(appraisal.get("appraisal_fingerprint")))
        || base_price_cp < 1
        || base_price_cp > MAX_UNIT_PRICE_CP
        || js::s(appraisal.get("item_id")) != item_id
        || js::s(appraisal.get("item_stack_key")) != inventory_stack_key(item)
        || (js::present(actor_id) && js::s(appraisal.get("actor_id")) != js::s(actor_id))
    {
        return None;
    }
    let mut record = appraisal.clone();
    record.insert("base_price_cp".into(), json!(base_price_cp));
    Some(Value::Object(record))
}

/// `trustedItemAppraisalFor(state, actorId, item)`: только оценка из реестра
/// событий, которая всё ещё описывает именно эту вещь.
pub fn trusted_item_appraisal_for(state: &Value, actor_id: Option<&Value>, item: Option<&Value>) -> Option<Value> {
    let registry = get(get(get(Some(state), "mechanics"), "item_appraisals"), &js::s(actor_id));
    let record = if plain(registry).is_some() { get(registry, &js::s(get(item, "id"))) } else { None };
    trusted_appraisal_record(record, item, actor_id)
}

/// `trustedStockAppraisalFor(stock)`: оценка перепроданного товара на складе.
pub fn trusted_stock_appraisal_for(stock: Option<&Value>) -> Option<Value> {
    trusted_appraisal_record(get(stock, "appraisal"), stock, None)
}

fn trusted_base_price_cp(item: Option<&Value>, appraisal: Option<&Value>) -> i64 {
    let catalog = resolve_catalog_base_price_cp(item);
    if catalog != 0 {
        return catalog;
    }
    trusted_appraisal_record(appraisal, item, None).and_then(|record| record.get("base_price_cp").and_then(Value::as_i64)).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Политика цены, торг, услуги, пополнение
// ---------------------------------------------------------------------------

/// `normalizeMerchantPricing(input)`: каталожная цена с ограниченной
/// политикой торговца (наценка, выкуп, торг, поправка агента).
pub fn normalize_merchant_pricing(input: Option<&Value>) -> Value {
    let empty_map = Map::new();
    let source = plain(input).unwrap_or(&empty_map);
    let percent_markup = js::number(source.get("buy_markup_percent"));
    let percent_sell = js::number(source.get("sell_rate_percent"));
    let limit_percent = clamp_int(source.get("agent_adjustment_limit_percent"), 0, 50, 20);
    let adjustment_limit_bps = (limit_percent * 100) as f64;
    let agent_percent = js::number(source.get("agent_adjustment_percent"));
    let agent_fallback = if agent_percent.is_finite() { js::round(agent_percent * 100.0) } else { 0.0 };
    let agent_raw = js::number(source.get("agent_adjustment_bps"));
    let requested_agent_adjustment = if crate::support::is_safe(agent_raw) { agent_raw } else { agent_fallback };
    let buy_raw = js::number(source.get("buy_markup_bps"));
    let buy_markup_bps = if crate::support::is_safe(buy_raw) {
        buy_raw
    } else if percent_markup.is_finite() {
        10_000.0 + js::round(percent_markup * 100.0)
    } else {
        10_000.0
    };
    let sell_raw = js::number(source.get("sell_rate_bps"));
    let sell_rate_bps = if crate::support::is_safe(sell_raw) {
        sell_raw
    } else if percent_sell.is_finite() {
        js::round(percent_sell * 100.0)
    } else {
        5_000.0
    };
    let minimum = clamp_int(source.get("min_multiplier_bps"), 100, 30_000, 1_000);
    let maximum = clamp_int(source.get("max_multiplier_bps"), minimum, 50_000, 30_000);
    let mode = if source.get("mode").and_then(Value::as_str) == Some("catalog") { "catalog" } else { "catalog_with_agent_adjustment" };
    let buy = clamp_num(buy_markup_bps, minimum, maximum, 10_000);
    let sell = clamp_num(sell_rate_bps, minimum, maximum, 5_000);
    let agent_adjustment = if mode == "catalog" { 0.0 } else { (-adjustment_limit_bps).max(adjustment_limit_bps.min(requested_agent_adjustment)) };
    let mut pricing = source.clone();
    pricing.insert("mode".into(), json!(mode));
    pricing.insert("catalog_id".into(), json!(clean_id(source.get("catalog_id"), ECONOMY_CATALOG_VERSION)));
    pricing.insert("buy_markup_bps".into(), json!(buy));
    pricing.insert("sell_rate_bps".into(), json!(sell));
    pricing.insert("bargain_dc".into(), json!(clamp_int(source.get("bargain_dc"), 5, 30, 15)));
    pricing.insert("success_discount_bps".into(), json!(clamp_int(source.get("success_discount_bps"), 0, 5_000, 1_000)));
    pricing.insert("failure_markup_bps".into(), json!(clamp_int(source.get("failure_markup_bps"), 0, 5_000, 500)));
    pricing.insert("min_multiplier_bps".into(), json!(minimum));
    pricing.insert("max_multiplier_bps".into(), json!(maximum));
    pricing.insert("agent_adjustment_bps".into(), num(agent_adjustment));
    pricing.insert("agent_adjustment_limit_percent".into(), json!(limit_percent));
    pricing.insert("buy_markup_percent".into(), num(js::round((buy - 10_000) as f64 / 100.0)));
    pricing.insert("sell_rate_percent".into(), num(js::round(sell as f64 / 100.0)));
    Value::Object(pricing)
}

fn int_of(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn normalize_bargains(input: Option<&Value>) -> Value {
    let Some(source) = plain(input) else {
        return empty();
    };
    let mut bargains = Map::new();
    for (actor_id, bargain) in js::entries(source).into_iter().take(100) {
        if !js::truthy(Some(bargain)) || !is_object_like(Some(bargain)) {
            continue;
        }
        let id = clean_id(Some(&json!(actor_id)), "");
        if id.is_empty() {
            continue;
        }
        let field = |key: &str| get(Some(bargain), key);
        let success = js::is_true(field("success")) || field("status").and_then(Value::as_str) == Some("success");
        bargains.insert(
            id,
            json!({
                "attempted": true,
                "success": success,
                "status": if success { "success" } else { "failure" },
                "roll_total": clamp_int(coalesce(field("roll_total"), field("total")), -100, 200, 0),
                "natural_roll": clamp_int(coalesce(field("natural_roll"), field("kept")), 1, 20, 1),
                "modifier": clamp_int(field("modifier"), -30, 50, 0),
                "difficulty": clamp_int(field("difficulty"), 5, 30, 15),
                "pricing_adjustment_bps": clamp_int(field("pricing_adjustment_bps"), -5_000, 5_000, 0),
                "resolved_at": if js::present(field("resolved_at")) { json!(text::head(&js::s(field("resolved_at")), 80)) } else { Value::Null },
            }),
        );
    }
    Value::Object(js_order(bargains))
}

fn normalize_merchant_service(input: Option<&Value>, index: usize) -> Value {
    let empty_map = Map::new();
    let source = plain(input).unwrap_or(&empty_map);
    let service_id = clean_id(coalesce(coalesce(source.get("service_id"), source.get("serviceId")), source.get("id")), &format!("service-{}", index + 1));
    let kind = text::lower(&clean_text(source.get("kind"), 40, "other"));
    let mut seen = HashSet::new();
    let tags: Vec<String> = array(source.get("tags")).iter().map(|tag| clean_text(Some(tag), 40, "")).filter(|tag| !tag.is_empty() && seen.insert(tag.clone())).take(12).collect();
    json!({
        "service_id": service_id,
        "name": clean_text(source.get("name"), 120, "Услуга торговца"),
        "description": clean_text(source.get("description"), 1_000, ""),
        "kind": if MERCHANT_SERVICE_KINDS.contains(&kind.as_str()) { kind.as_str() } else { "other" },
        "base_price_cp": clamp_int(coalesce(source.get("base_price_cp"), source.get("basePriceCp")), 0, MAX_UNIT_PRICE_CP, 0),
        "duration_minutes": clamp_int(coalesce(source.get("duration_minutes"), source.get("durationMinutes")), 0, 10_080, 0),
        "available": !js::is_false(source.get("available")),
        "requires_presence": !js::is_false(source.get("requires_presence")) && !js::is_false(source.get("requiresPresence")),
        "tags": tags,
        "price_provenance": "merchant_service_policy",
        "policy_id": MERCHANT_SERVICES_POLICY_ID,
    })
}

/// `normalizeMerchantServices(input)`: до 100 услуг без повторов `service_id`.
pub fn normalize_merchant_services(input: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    array(input)
        .iter()
        .take(100)
        .enumerate()
        .filter_map(|(index, service)| {
            let normalized = normalize_merchant_service(Some(service), index);
            seen.insert(js::s(normalized.get("service_id"))).then_some(normalized)
        })
        .collect()
}

/// `normalizeMerchantRestockPolicy(input, stock)`: цели пополнения — только
/// существующие позиции склада; новый товар политика не заводит.
pub fn normalize_merchant_restock_policy(input: Option<&Value>, stock: Option<&Value>) -> Value {
    let empty_map = Map::new();
    let source = plain(input).unwrap_or(&empty_map);
    let stock_ids: HashSet<String> = array(stock).iter().map(|entry| js::s(get(Some(entry), "stock_id"))).collect();
    let mut seen = HashSet::new();
    let targets: Vec<Value> = array(source.get("targets"))
        .iter()
        .take(500)
        .filter_map(|target| {
            let target = plain(Some(target))?;
            let stock_id = clean_id(coalesce(target.get("stock_id"), target.get("stockId")), "");
            if stock_id.is_empty() || seen.contains(&stock_id) || !stock_ids.contains(&stock_id) {
                return None;
            }
            seen.insert(stock_id.clone());
            let target_quantity = clamp_int(coalesce(coalesce(target.get("target_quantity"), target.get("targetQuantity")), target.get("quantity")), 0, MAX_STOCK_QUANTITY, 0);
            (target_quantity >= 1).then(|| json!({ "stock_id": stock_id, "target_quantity": target_quantity }))
        })
        .collect();
    let raw_last_restock = coalesce(source.get("last_restock_world_minute"), source.get("lastRestockWorldMinute"));
    let last_restock = if js::present(raw_last_restock) { json!(clamp_int(raw_last_restock, 0, MAX_WORLD_MINUTE, 0)) } else { Value::Null };
    let enabled = js::is_true(source.get("enabled")) && !targets.is_empty();
    json!({
        "schema_version": 1,
        "policy_id": MERCHANT_RESTOCK_POLICY_ID,
        "enabled": enabled,
        "interval_minutes": clamp_int(coalesce(source.get("interval_minutes"), source.get("intervalMinutes")), MIN_RESTOCK_INTERVAL_MINUTES, MAX_RESTOCK_INTERVAL_MINUTES, 1_440),
        "last_restock_world_minute": last_restock,
        "targets": targets,
    })
}

// ---------------------------------------------------------------------------
// Торговец
// ---------------------------------------------------------------------------

/// `normalizeMerchant(input, index)`: склад — только товар с каталожной или
/// подтверждённой ценой, кошелёк, политика цены, торг, услуги, пополнение.
pub fn normalize_merchant(input: Option<&Value>, index: usize) -> Value {
    let empty_map = Map::new();
    let source = plain(input).unwrap_or(&empty_map);
    let merchant_id = clean_id(coalesce(source.get("id"), source.get("merchant_id")), &format!("merchant-{}", index + 1));
    let mut seen_stock_ids: HashSet<String> = HashSet::new();
    let mut stock: Vec<Value> = Vec::new();
    for (stock_index, entry) in array(source.get("stock")).iter().take(500).enumerate() {
        if !js::truthy(Some(entry)) || !is_object_like(Some(entry)) {
            continue;
        }
        let inner = get(Some(entry), "item").filter(|inner| is_object_like(Some(inner)));
        let item = match inner {
            Some(inner) => {
                let mut merged = spread_of(Some(inner));
                for (key, value) in spread_of(Some(entry)) {
                    merged.insert(key, value);
                }
                Value::Object(js_order(merged))
            }
            None => entry.clone(),
        };
        let base_stock_id = clean_id(coalesce(get(Some(entry), "stock_id"), get(Some(entry), "stockId")), &format!("{merchant_id}-stock-{}", stock_index + 1));
        let mut stock_id = base_stock_id.clone();
        let mut suffix = stock_index + 1;
        while seen_stock_ids.contains(&stock_id) {
            stock_id = format!("{}-{suffix}", text::head(&base_stock_id, 108));
            suffix += 1;
        }
        seen_stock_ids.insert(stock_id.clone());
        let catalog_ref = coalesce(coalesce(coalesce(get(Some(entry), "catalog_id"), get(Some(entry), "catalogId")), get(Some(&item), "catalog_id")), get(Some(&item), "catalogId"));
        let catalog_id = clean_id(catalog_ref, "");
        let mut candidate = spread_of(Some(&item));
        candidate.insert("catalog_id".into(), json!(catalog_id));
        let candidate = Value::Object(candidate);
        let stock_appraisal = trusted_stock_appraisal_for(Some(&candidate));
        let mut base_price = resolve_catalog_base_price_cp(Some(&candidate));
        if base_price == 0 {
            base_price = stock_appraisal.as_ref().map_or(0, |appraisal| int_of(appraisal, "base_price_cp"));
        }
        if stock_id.is_empty() || base_price == 0 {
            continue;
        }
        let mut normalized = spread_of(Some(&item));
        normalized.insert("stock_id".into(), json!(stock_id));
        normalized.insert("catalog_id".into(), json!(catalog_id));
        normalized.insert("name".into(), json!(clean_text(get(Some(&item), "name"), 120, "Предмет")));
        normalized.insert("type".into(), json!(clean_text(get(Some(&item), "type"), 40, "other")));
        normalized.insert("quantity".into(), json!(clamp_int(get(Some(entry), "quantity"), 0, MAX_STOCK_QUANTITY, 0)));
        normalized.insert("base_price_cp".into(), json!(base_price));
        if let Some(appraisal) = stock_appraisal {
            normalized.insert("appraisal".into(), appraisal);
        }
        if js::present(get(Some(&item), "id")) {
            normalized.insert("item_id".into(), json!(clean_id(get(Some(&item), "id"), "")));
        }
        normalized.insert("equipped".into(), json!(false));
        stock.push(Value::Object(normalized));
    }
    let stock_value = Value::Array(stock);
    let restock_source = coalesce(coalesce(source.get("restock_policy"), source.get("restockPolicy")), source.get("restock"));
    let mut merchant = source.clone();
    merchant.insert("id".into(), json!(merchant_id));
    merchant.insert("name".into(), json!(clean_text(source.get("name"), 120, "Торговец")));
    merchant.insert("title".into(), json!(clean_text(source.get("title"), 180, "")));
    merchant.insert("description".into(), json!(clean_text(source.get("description"), 1_000, "")));
    merchant.insert("greeting".into(), json!(clean_text(source.get("greeting"), 500, "")));
    merchant.insert("voice".into(), json!(clean_text(source.get("voice"), 500, "")));
    merchant.insert("location".into(), json!(clean_text(source.get("location"), 180, "")));
    merchant.insert("location_id".into(), json!(canonical_location_id(coalesce(source.get("location_id"), source.get("locationId")))));
    merchant.insert("available".into(), json!(!js::is_false(source.get("available"))));
    merchant.insert("purse_cp".into(), json!(normalize_merchant_purse_cp(coalesce(source.get("purse_cp"), source.get("purseCp")), None)));
    merchant.insert("pricing".into(), normalize_merchant_pricing(source.get("pricing")));
    merchant.insert("stock".into(), stock_value.clone());
    merchant.insert("bargains".into(), normalize_bargains(source.get("bargains")));
    merchant.insert("services".into(), Value::Array(normalize_merchant_services(source.get("services"))));
    merchant.insert("restock_policy".into(), normalize_merchant_restock_policy(restock_source, Some(&stock_value)));
    Value::Object(merchant)
}

/// `normalizeMerchants(input)`: до 100 торговцев без повторов `id`.
pub fn normalize_merchants(input: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    array(input)
        .iter()
        .take(100)
        .enumerate()
        .filter_map(|(index, merchant)| {
            let normalized = normalize_merchant(Some(merchant), index);
            seen.insert(js::s(normalized.get("id"))).then_some(normalized)
        })
        .collect()
}

/// `createStarterMerchant({ location, location_id, locationId })`: стартовый
/// поставщик припасов. Услуг у него нет намеренно: письма ведёт `SendLetter`.
pub fn create_starter_merchant(options: Option<&Value>) -> Value {
    let option = |key: &str| get(options, key).cloned().unwrap_or_else(|| json!(""));
    let location = option("location");
    let location_id = option("location_id");
    let location_id = if js::truthy(Some(&location_id)) { location_id } else { option("locationId") };
    let stock_entry = |catalog_id: &str, instance: Value| materialize_catalog_item(catalog_id, Some(&instance));
    let source = json!({
        "id": "starter-provisioner",
        "name": "Мартен Рыжий",
        "title": "Странствующий торговец припасами",
        "description": "Проверенный поставщик обычного снаряжения и дорожных припасов.",
        "greeting": "Подходите ближе. Базовая цена известна заранее, а об условиях ещё можно поговорить.",
        "voice": "Говорит живо и дружелюбно, но внимательно считает каждую монету.",
        "location": location,
        "location_id": location_id,
        "available": true,
        "pricing": {
            "mode": "catalog_with_agent_adjustment",
            "catalog_id": ECONOMY_CATALOG_VERSION,
            "buy_markup_bps": 11_000,
            "sell_rate_bps": 5_000,
            "bargain_dc": 15,
            "success_discount_bps": 1_000,
            "failure_markup_bps": 500,
            "min_multiplier_bps": 1_000,
            "max_multiplier_bps": 30_000,
            "agent_adjustment_limit_percent": 20,
            "description": "Каталожная SRD-цена с ограниченной политикой конкретного торговца.",
        },
        "stock": [
            stock_entry("srd_5_2_1:potion-of-healing", json!({ "stock_id": "starter-healing-potion", "quantity": 3, "description": "Восстанавливает 2к4 + 2 хита." })),
            stock_entry("srd_5_2_1:rope-hempen-50-feet", json!({ "stock_id": "starter-hempen-rope", "quantity": 4 })),
            stock_entry("srd_5_2_1:rations-one-day", json!({ "stock_id": "starter-rations", "quantity": 12 })),
            stock_entry("srd_5_2_1:torch", json!({ "stock_id": "starter-torch", "quantity": 10 })),
            stock_entry("srd_5_2_1:arrows-20", json!({ "stock_id": "starter-arrows", "quantity": 5, "properties": "Боеприпасы для лука; не являются самостоятельным оружием." })),
        ],
        "services": [],
        "restock_policy": {
            "enabled": true,
            "interval_minutes": 1_440,
            "targets": [
                { "stock_id": "starter-healing-potion", "target_quantity": 3 },
                { "stock_id": "starter-hempen-rope", "target_quantity": 4 },
                { "stock_id": "starter-rations", "target_quantity": 12 },
                { "stock_id": "starter-torch", "target_quantity": 10 },
                { "stock_id": "starter-arrows", "target_quantity": 5 },
            ],
        },
    });
    normalize_merchant(Some(&source), 0)
}

/// `findMerchant(state, merchantId)`.
pub fn find_merchant<'a>(state: &'a Value, merchant_id: Option<&Value>) -> Option<&'a Value> {
    let expected = clean_id(merchant_id, "");
    array(get(Some(state), "merchants")).iter().find(|merchant| js::string(get(Some(merchant), "id")) == expected)
}

/// `bargainFor(merchant, actorId)`: итог торга этого героя или `None`.
pub fn bargain_for<'a>(merchant: Option<&'a Value>, actor_id: Option<&Value>) -> Option<&'a Value> {
    get(get(merchant, "bargains"), &js::s(actor_id)).filter(|bargain| !bargain.is_null())
}

struct Multipliers {
    pricing: Value,
    bargain_adjustment: i64,
    reputation_bps: i64,
    buy: i64,
    buy_before_bargain: i64,
}

/// `pricingMultipliers(merchant, actorId, reputationBps)`: репутация приходит
/// извне и зажата ±1000, итог — пределами политики торговца.
fn pricing_multipliers(merchant: Option<&Value>, actor_id: Option<&Value>, reputation_bps: Option<&Value>) -> Multipliers {
    let pricing = normalize_merchant_pricing(get(merchant, "pricing"));
    let bargain = bargain_for(merchant, actor_id);
    let bargain_adjustment = clamp_int(get(bargain, "pricing_adjustment_bps"), -5_000, 5_000, 0);
    let reputation = match reputation_bps {
        None => 0,
        Some(value) => clamp_int(Some(value), -1_000, 1_000, 0),
    };
    let buy_before_bargain = int_of(&pricing, "buy_markup_bps") + int_of(&pricing, "agent_adjustment_bps") + reputation;
    let minimum = int_of(&pricing, "min_multiplier_bps");
    let maximum = int_of(&pricing, "max_multiplier_bps");
    Multipliers {
        buy: minimum.max(maximum.min(buy_before_bargain + bargain_adjustment)),
        pricing,
        bargain_adjustment,
        reputation_bps: reputation,
        buy_before_bargain,
    }
}

/// `findMerchantService(merchant, serviceId)`.
pub fn find_merchant_service<'a>(merchant: Option<&'a Value>, service_id: Option<&Value>) -> Option<&'a Value> {
    let expected = clean_id(service_id, "");
    array(get(merchant, "services")).iter().find(|service| js::s(get(Some(service), "service_id")) == expected).filter(|service| !service.is_null())
}

/// `quoteMerchantService(merchant, actorId, service, reputationBps)`: цена
/// услуги той же ограниченной политикой, что и товар.
pub fn quote_merchant_service(merchant: Option<&Value>, actor_id: Option<&Value>, service: Option<&Value>, reputation_bps: Option<&Value>) -> Option<Value> {
    plain(service)?;
    let normalized = normalize_merchant_services(Some(&Value::Array(vec![service?.clone()]))).into_iter().next()?;
    if !js::truthy(normalized.get("available")) {
        return None;
    }
    let multipliers = pricing_multipliers(merchant, actor_id, reputation_bps);
    let base = int_of(&normalized, "base_price_cp");
    Some(json!({
        "service_id": normalized["service_id"],
        "base_price_cp": base,
        "price_cp": num(ceil_div(base as f64 * multipliers.buy as f64, 10_000.0)),
        "merchant_adjustment_bps": multipliers.buy_before_bargain - 10_000,
        "bargain_adjustment_bps": multipliers.bargain_adjustment,
        "reputation_adjustment_bps": multipliers.reputation_bps,
        "multiplier_bps": multipliers.buy,
        "price_provenance": normalized["price_provenance"],
        "policy_id": MERCHANT_SERVICES_POLICY_ID,
    }))
}

fn state_version(state: &Value) -> i64 {
    safe_int(get(Some(state), "state_version"), 0).max(0)
}

fn find_player<'a>(state: &'a Value, actor_id: Option<&Value>) -> Option<&'a Value> {
    let expected = js::s(actor_id);
    array(get(Some(state), "players")).iter().find(|player| js::s(get(Some(player), "id")) == expected).filter(|player| js::truthy(Some(player)))
}

/// `merchantServiceProposal(state, merchantId, actorId, serviceId)`:
/// детерминированное, не авторитетное предложение команды `PurchaseMerchantService`.
pub fn merchant_service_proposal(state: &Value, merchant_id: Option<&Value>, actor_id: Option<&Value>, service_id: Option<&Value>) -> Option<Value> {
    let merchant = find_merchant(state, merchant_id);
    let actor = find_player(state, actor_id);
    let service = find_merchant_service(merchant, service_id);
    let (merchant, actor, service) = (merchant?, actor?, service?);
    if !js::truthy(service.get("available")) {
        return None;
    }
    if !merchant_trade_availability_for(state, Some(merchant), js::is_false(service.get("requires_presence"))).can_trade {
        return None;
    }
    let quote = quote_merchant_service(Some(merchant), actor.get("id"), Some(service), None)?;
    let balance_cp = currency_to_copper(actor.get("currency"));
    let price_cp = quote["price_cp"].as_f64().unwrap_or(0.0);
    let mut proposal = Map::new();
    proposal.insert("proposal_version".into(), json!(1));
    proposal.insert("command_type".into(), json!("PurchaseMerchantService"));
    copy_field(&mut proposal, "merchant_id", merchant.get("id"));
    proposal.insert("actor_id".into(), json!(js::string(actor.get("id"))));
    copy_field(&mut proposal, "service_id", service.get("service_id"));
    proposal.insert("expected_state_version".into(), json!(state_version(state)));
    proposal.insert("price_cp".into(), quote["price_cp"].clone());
    proposal.insert("can_afford".into(), json!(balance_cp as f64 >= price_cp));
    copy_field(&mut proposal, "requires_presence", service.get("requires_presence"));
    copy_field(&mut proposal, "duration_minutes", service.get("duration_minutes"));
    proposal.insert("policy_id".into(), json!(MERCHANT_SERVICES_POLICY_ID));
    Some(Value::Object(proposal))
}

fn normalized_world_minute(value: Option<&Value>) -> i64 {
    clamp_int(value, 0, MAX_WORLD_MINUTE, 0)
}

/// `planMerchantRestock(merchant, worldMinute)`: один срок пополнения.
/// Большой скачок времени возвращает склад к цели один раз — перезапуск
/// сервера не умножает товар на число пропущенных интервалов.
pub fn plan_merchant_restock(merchant: Option<&Value>, world_minute: Option<&Value>) -> Option<Value> {
    let normalized = normalize_merchant(merchant, 0);
    let policy = &normalized["restock_policy"];
    let processed_at = normalized_world_minute(world_minute);
    if !js::is_true(policy.get("enabled")) {
        return None;
    }
    let baseline = policy.get("last_restock_world_minute").and_then(Value::as_i64).unwrap_or(0);
    let interval = int_of(policy, "interval_minutes");
    let scheduled_for = baseline + interval;
    if processed_at < scheduled_for {
        return None;
    }
    let stock_by_id: HashMap<String, &Value> = array(normalized.get("stock")).iter().map(|entry| (js::s(entry.get("stock_id")), entry)).collect();
    let entries: Vec<Value> = array(policy.get("targets"))
        .iter()
        .filter_map(|target| {
            let stock = stock_by_id.get(&js::s(target.get("stock_id")))?;
            let before = clamp_int(stock.get("quantity"), 0, MAX_STOCK_QUANTITY, 0);
            let after = before.max(int_of(target, "target_quantity"));
            (after != before).then(|| {
                json!({
                    "stock_id": stock["stock_id"],
                    "catalog_id": stock["catalog_id"],
                    "quantity_before": before,
                    "quantity_added": after - before,
                    "quantity_after": after,
                    "stock": (*stock).clone(),
                })
            })
        })
        .collect();
    let total: i64 = entries.iter().map(|entry| int_of(entry, "quantity_added")).sum();
    Some(json!({
        "schema_version": 1,
        "policy_id": MERCHANT_RESTOCK_POLICY_ID,
        "merchant_id": normalized["id"],
        "scheduled_for_world_minute": scheduled_for,
        "processed_at_world_minute": processed_at,
        "overdue_intervals": 1.max((processed_at - baseline) / interval),
        "entries": entries,
        "total_quantity_added": total,
    }))
}

/// `planMerchantEconomyClock(state, { worldMinute })`: все сроки торговцев на
/// один такт времени кампании; `world_minute: None` — `mechanics.world_time`.
pub fn plan_merchant_economy_clock(state: &Value, world_minute: Option<&Value>) -> Vec<Value> {
    let fallback = get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes");
    let minute = json!(normalized_world_minute(coalesce(world_minute, fallback)));
    array(get(Some(state), "merchants")).iter().filter_map(|merchant| plan_merchant_restock(Some(merchant), Some(&minute))).collect()
}

fn expected_plan(merchant: Option<&Value>, plan: Option<&Value>) -> Option<Value> {
    let expected = plan_merchant_restock(merchant, get(plan, "processed_at_world_minute"))?;
    (js::s(expected.get("merchant_id")) == js::s(get(plan, "merchant_id"))).then_some(expected)
}

/// `merchantRestockCommandFromPlan(merchant, plan)`: команда `RestockMerchant`,
/// если склад действительно меняется; план пересчитывается, а не берётся на веру.
pub fn merchant_restock_command_from_plan(merchant: Option<&Value>, plan: Option<&Value>) -> Option<Value> {
    let expected = expected_plan(merchant, plan)?;
    let entries = array(expected.get("entries"));
    if entries.is_empty() {
        return None;
    }
    let items: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let stock = &entry["stock"];
            let mut item = Map::new();
            copy_field(&mut item, "stock_id", entry.get("stock_id"));
            copy_field(&mut item, "catalog_id", entry.get("catalog_id"));
            copy_field(&mut item, "quantity", entry.get("quantity_added"));
            for key in ["name", "type", "weight", "rarity", "description", "properties"] {
                copy_field(&mut item, key, stock.get(key));
            }
            Value::Object(item)
        })
        .collect();
    Some(json!({ "command_type": "RestockMerchant", "merchant_id": expected["merchant_id"], "items": items }))
}

/// `merchantEconomyClockEventFromPlan(merchant, plan)`: событие часов лавки,
/// которое сохраняет и пустой срок.
pub fn merchant_economy_clock_event_from_plan(merchant: Option<&Value>, plan: Option<&Value>) -> Option<Value> {
    let expected = expected_plan(merchant, plan)?;
    Some(json!({
        "event_type": MERCHANT_ECONOMY_CLOCK_EVENT_TYPE,
        "visibility": "admin",
        "payload": {
            "policy_id": MERCHANT_RESTOCK_POLICY_ID,
            "merchant_id": expected["merchant_id"],
            "scheduled_for_world_minute": expected["scheduled_for_world_minute"],
            "processed_at_world_minute": expected["processed_at_world_minute"],
            "overdue_intervals": expected["overdue_intervals"],
        },
    }))
}

/// `applyMerchantRestockPlan(merchant, plan)`: чистое применение срока для
/// replay; количества пересчитываются, а не берутся из плана.
pub fn apply_merchant_restock_plan(merchant: Option<&Value>, plan: Option<&Value>) -> Value {
    let normalized = normalize_merchant(merchant, 0);
    let Some(expected) = expected_plan(Some(&normalized), plan) else {
        return normalized;
    };
    let by_id: HashMap<String, i64> = array(expected.get("entries")).iter().map(|entry| (js::s(entry.get("stock_id")), int_of(entry, "quantity_after"))).collect();
    let stock: Vec<Value> = array(normalized.get("stock"))
        .iter()
        .map(|entry| match by_id.get(&js::s(entry.get("stock_id"))) {
            Some(after) => {
                let mut updated = entry.as_object().cloned().unwrap_or_default();
                updated.insert("quantity".into(), json!(after));
                Value::Object(updated)
            }
            None => entry.clone(),
        })
        .collect();
    let mut next = normalized.as_object().cloned().unwrap_or_default();
    next.insert("stock".into(), Value::Array(stock));
    let mut policy = normalized["restock_policy"].as_object().cloned().unwrap_or_default();
    policy.insert("last_restock_world_minute".into(), expected["processed_at_world_minute"].clone());
    next.insert("restock_policy".into(), Value::Object(policy));
    normalize_merchant(Some(&Value::Object(next)), 0)
}

// ---------------------------------------------------------------------------
// Котировки
// ---------------------------------------------------------------------------

fn stock_base_price(stock_entry: Option<&Value>) -> i64 {
    let catalog = resolve_catalog_base_price_cp(stock_entry);
    if catalog != 0 {
        return catalog;
    }
    trusted_stock_appraisal_for(stock_entry).map_or(0, |appraisal| int_of(&appraisal, "base_price_cp"))
}

/// `quoteMerchantBuyUnit(merchant, actorId, stockEntry, reputationBps)`:
/// цена покупки одной единицы (вверх, не меньше 1 мм).
pub fn quote_merchant_buy_unit(merchant: Option<&Value>, actor_id: Option<&Value>, stock_entry: Option<&Value>, reputation_bps: Option<&Value>) -> Option<Value> {
    let base = stock_base_price(stock_entry);
    if base == 0 {
        return None;
    }
    let multipliers = pricing_multipliers(merchant, actor_id, reputation_bps);
    Some(json!({
        "base_unit_price_cp": base,
        "unit_price_cp": num(1f64.max(ceil_div(base as f64 * multipliers.buy as f64, 10_000.0))),
        "merchant_adjustment_bps": multipliers.buy_before_bargain - 10_000,
        "bargain_adjustment_bps": multipliers.bargain_adjustment,
        "reputation_adjustment_bps": multipliers.reputation_bps,
        "multiplier_bps": multipliers.buy,
    }))
}

/// `quoteMerchantSellUnit(merchant, actorId, item, appraisal, reputationBps,
/// stolenDiscountBps)`: выкуп одной единицы (вниз, не меньше 1 мм). Скидка
/// скупщика за краденое — отдельное слагаемое, а не добавка к репутации.
pub fn quote_merchant_sell_unit(merchant: Option<&Value>, actor_id: Option<&Value>, item: Option<&Value>, appraisal: Option<&Value>, reputation_bps: Option<&Value>, stolen_discount_bps: Option<&Value>) -> Option<Value> {
    let base = trusted_base_price_cp(item, appraisal);
    if base == 0 {
        return None;
    }
    let multipliers = pricing_multipliers(merchant, actor_id, reputation_bps);
    let stolen_discount = 0.max(9_000.min(clamp_int(stolen_discount_bps, 0, 9_000, 0)));
    let kind = text::lower(&string_or_empty(get(item, "type")));
    let valuable = ["treasure", "trade_good", "trade-good", "valuable"].contains(&kind.as_str());
    let pricing = &multipliers.pricing;
    let sell_before_bargain = (if valuable { 10_000 } else { int_of(pricing, "sell_rate_bps") }) - int_of(pricing, "agent_adjustment_bps") - multipliers.reputation_bps - stolen_discount;
    let sell_multiplier = int_of(pricing, "min_multiplier_bps").max(int_of(pricing, "max_multiplier_bps").min(sell_before_bargain - multipliers.bargain_adjustment));
    let mut quote = Map::new();
    quote.insert("base_unit_price_cp".into(), json!(base));
    quote.insert("unit_price_cp".into(), num(1f64.max(floor_div(base as f64 * sell_multiplier as f64, 10_000.0))));
    quote.insert("merchant_adjustment_bps".into(), json!(sell_before_bargain - 10_000));
    quote.insert("bargain_adjustment_bps".into(), json!(-multipliers.bargain_adjustment));
    quote.insert("reputation_adjustment_bps".into(), json!(multipliers.reputation_bps));
    if stolen_discount > 0 {
        quote.insert("stolen_adjustment_bps".into(), json!(-stolen_discount));
    }
    quote.insert("multiplier_bps".into(), json!(sell_multiplier));
    quote.insert("value_class".into(), json!(if valuable { "valuable" } else { "equipment" }));
    Some(Value::Object(quote))
}

/// `inventoryItemFromStock(stockEntry)`: вещь инвентаря из позиции склада
/// (каталог авторитетен, одна единица, не надета).
pub fn inventory_item_from_stock(stock_entry: Option<&Value>) -> Value {
    let empty_map = Map::new();
    let source = plain(stock_entry).unwrap_or(&empty_map);
    let catalog_ref = js::s(coalesce(source.get("catalog_id"), source.get("catalogId")));
    let mut instance = source.clone();
    let id = coalesce(coalesce(coalesce(source.get("item_id"), source.get("id")), source.get("catalog_id")), source.get("stock_id"));
    match id {
        Some(id) => {
            instance.insert("id".into(), id.clone());
        }
        // `id: undefined` в JS: поле есть, но в JSON его нет.
        None => {
            instance.shift_remove("id");
        }
    }
    instance.insert("quantity".into(), json!(1));
    instance.insert("equipped".into(), json!(false));
    let materialized = materialize_catalog_item(&catalog_ref, Some(&Value::Object(instance)));
    normalize_inventory_item(Some(&materialized), InventoryItemOptions::default())
}

/// Итог `sellability(item, appraisal)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sellability {
    pub can_sell: bool,
    pub reason: Option<&'static str>,
}

impl Sellability {
    /// Форма JS: `{ can_sell, reason }`.
    pub fn to_json(&self) -> Value {
        json!({ "can_sell": self.can_sell, "reason": self.reason })
    }
}

fn story_locked(item: Option<&Value>) -> bool {
    js::is_true(get(item, "quest_item")) || js::is_false(get(item, "sellable")) || text::lower(&string_or_empty(get(item, "type"))) == "quest" || text::lower(&string_or_empty(get(item, "rarity"))) == "сюжетный"
}

/// `sellability(item, appraisal)`: можно ли продать вещь и почему нет.
pub fn sellability(item: Option<&Value>, appraisal: Option<&Value>) -> Sellability {
    let refuse = |reason| Sellability { can_sell: false, reason: Some(reason) };
    if !js::truthy(item) || !is_object_like(item) {
        return refuse("Предмет не найден");
    }
    if js::truthy(get(item, "equipped")) {
        return refuse("Сначала снимите предмет");
    }
    if js::truthy(get(item, "attuned_to")) {
        return refuse("Сначала разорвите настройку с предметом");
    }
    if story_locked(item) {
        return refuse("Сюжетный предмет нельзя продать");
    }
    if trusted_base_price_cp(item, appraisal) == 0 {
        return refuse("Предмет нужно сначала оценить у торговца");
    }
    Sellability { can_sell: true, reason: None }
}

fn stock_price_provenance(stock: &Value) -> Value {
    match resolve_catalog_price(Some(stock)).and_then(|price| price.get("provenance").filter(|value| !value.is_null()).cloned()) {
        Some(provenance) => provenance,
        None if trusted_stock_appraisal_for(Some(stock)).is_some() => json!("server_appraisal_policy"),
        None => Value::Null,
    }
}

/// `publicMerchantFor(merchant)`: торговец для игрока — без скрытых полей
/// склада и записи.
pub fn public_merchant_for(merchant: &Value) -> Value {
    let pricing = normalize_merchant_pricing(merchant.get("pricing"));
    let services = normalize_merchant_services(merchant.get("services"));
    let restock_policy = normalize_merchant_restock_policy(merchant.get("restock_policy"), merchant.get("stock"));
    let mut public = Map::new();
    for key in ["id", "name", "title", "description", "greeting", "voice", "initials", "portrait", "location", "location_id", "available"] {
        copy_field(&mut public, key, merchant.get(key));
    }
    public.insert("purse_cp".into(), json!(normalize_merchant_purse_cp(merchant.get("purse_cp"), None)));
    let stock: Vec<Value> = array(merchant.get("stock"))
        .iter()
        .map(|stock| {
            let mut entry = Map::new();
            for key in ["stock_id", "catalog_id", "name", "type", "quantity"] {
                copy_field(&mut entry, key, stock.get(key));
            }
            entry.insert("base_price_cp".into(), json!(stock_base_price(Some(stock))));
            entry.insert("price_provenance".into(), stock_price_provenance(stock));
            for key in ["weight", "rarity", "description", "properties", "image", "imagePosition"] {
                copy_field(&mut entry, key, stock.get(key));
            }
            Value::Object(entry)
        })
        .collect();
    public.insert("stock".into(), Value::Array(stock));
    let services: Vec<Value> = services
        .iter()
        .map(|service| {
            let mut entry = Map::new();
            for key in ["service_id", "name", "description", "kind", "base_price_cp", "duration_minutes", "available", "requires_presence", "tags", "price_provenance", "policy_id"] {
                copy_field(&mut entry, key, service.get(key));
            }
            Value::Object(entry)
        })
        .collect();
    public.insert("services".into(), Value::Array(services));
    public.insert(
        "restock".into(),
        json!({
            "enabled": restock_policy["enabled"],
            "interval_minutes": restock_policy["interval_minutes"],
            "last_restock_world_minute": restock_policy["last_restock_world_minute"],
        }),
    );
    let mut public_pricing = Map::new();
    copy_field(&mut public_pricing, "mode", pricing.get("mode"));
    copy_field(&mut public_pricing, "catalog_id", pricing.get("catalog_id"));
    public_pricing.insert("buy_markup_percent".into(), num(js::round((int_of(&pricing, "buy_markup_bps") - 10_000 + int_of(&pricing, "agent_adjustment_bps")) as f64 / 100.0)));
    public_pricing.insert("sell_rate_percent".into(), num(js::round((int_of(&pricing, "sell_rate_bps") - int_of(&pricing, "agent_adjustment_bps")) as f64 / 100.0)));
    copy_field(&mut public_pricing, "agent_adjustment_limit_percent", pricing.get("agent_adjustment_limit_percent"));
    copy_field(&mut public_pricing, "description", pricing.get("description"));
    public.insert("pricing".into(), Value::Object(public_pricing));
    Value::Object(public)
}

fn percent(bps: f64) -> Value {
    num(bps / 100.0)
}

/// `merchantViewFor(state, merchantId, actorId)`: витрина для героя — цены
/// покупки, выкупа и услуг той же формулой, что и сделка, с поправкой
/// репутации, розыском и скидкой скупщика.
pub fn merchant_view_for(state: &Value, merchant_id: Option<&Value>, actor_id: Option<&Value>) -> Option<Value> {
    let merchant = find_merchant(state, merchant_id)?;
    let expected_actor = js::s(actor_id);
    let actor = array(get(Some(state), "players")).iter().find(|player| js::string(get(Some(player), "id")) == expected_actor)?;
    let actor_id_value = actor.get("id");
    let balance = normalize_currency(actor.get("currency"));
    let balance_cp = currency_to_copper(actor.get("currency"));
    let merchant_purse_cp = normalize_merchant_purse_cp(merchant.get("purse_cp"), None);
    let bargain = bargain_for(Some(merchant), actor_id_value);
    let standing = reputation_standing_for(state, &json!(js::s(merchant.get("id"))));
    let reputation = standing.get("price_adjustment_bps");
    let trade_refused = js::is_false(standing.get("trade_available"));
    let version = state_version(state);
    let merchant_label = js::string(merchant.get("id"));
    let actor_label = js::string(actor_id_value);

    let buy_quotes: Vec<Value> = array(merchant.get("stock"))
        .iter()
        .filter(|stock| js::number(stock.get("quantity")) > 0.0)
        .filter_map(|stock| {
            let quote = quote_merchant_buy_unit(Some(merchant), actor_id_value, Some(stock), reputation)?;
            let unit = quote["unit_price_cp"].as_f64().unwrap_or(1.0);
            let max_quantity = js::min_of([js::number(stock.get("quantity")), floor_div(balance_cp as f64, unit), MAX_TRANSACTION_QUANTITY as f64]);
            let mut entry = Map::new();
            entry.insert("quote_id".into(), json!(format!("buy:{merchant_label}:{actor_label}:{}", js::string(stock.get("stock_id")))));
            entry.insert("state_version".into(), json!(version));
            entry.insert("expected_state_version".into(), json!(version));
            entry.insert("direction".into(), json!("buy"));
            copy_field(&mut entry, "actor_id", actor_id_value);
            copy_field(&mut entry, "stock_id", stock.get("stock_id"));
            copy_field(&mut entry, "catalog_id", stock.get("catalog_id"));
            entry.insert("item".into(), inventory_item_from_stock(Some(stock)));
            copy_field(&mut entry, "available_quantity", stock.get("quantity"));
            entry.insert("quantity".into(), json!(1));
            entry.insert("unit_price_cp".into(), quote["unit_price_cp"].clone());
            entry.insert("total_price_cp".into(), quote["unit_price_cp"].clone());
            entry.insert("can_afford".into(), json!(balance_cp as f64 >= unit));
            if trade_refused {
                entry.insert("can_buy".into(), json!(false));
                copy_field(&mut entry, "unavailable_reason", standing.get("trade_refusal_reason"));
            }
            entry.insert("max_quantity".into(), if trade_refused { json!(0) } else { num(max_quantity) });
            entry.insert("price_provenance".into(), stock_price_provenance(stock));
            entry.insert(
                "breakdown".into(),
                json!({
                    "catalog_base_unit_cp": quote["base_unit_price_cp"],
                    "merchant_adjustment_percent": percent(quote["merchant_adjustment_bps"].as_f64().unwrap_or(0.0)),
                    "bargain_adjustment_percent": percent(quote["bargain_adjustment_bps"].as_f64().unwrap_or(0.0)),
                    "reputation_adjustment_percent": percent(quote["reputation_adjustment_bps"].as_f64().unwrap_or(0.0)),
                    "final_unit_price_cp": quote["unit_price_cp"],
                }),
            );
            Some(Value::Object(entry))
        })
        .collect();

    // Скупщик — свойство человека, а не вещи: считается один раз на витрину.
    let merchant_npc_id = js::string(merchant.get("id"));
    let fallback_npc = json!({ "id": merchant_npc_id });
    let merchant_npc = array(get(get(Some(state), "social"), "npcs")).iter().find(|npc| js::s(get(Some(npc), "id")) == merchant_npc_id).unwrap_or(&fallback_npc);
    let merchant_is_fence = npc_is_fence(state, merchant_npc);
    let stolen_discount = json!(STOLEN_DISCOUNT_BPS);
    let zero = json!(0);

    let sell_quotes: Vec<Value> = array(actor.get("inventory"))
        .iter()
        .filter_map(|item| {
            let appraisal = trusted_item_appraisal_for(state, actor_id_value, Some(item));
            let stolen = js::s(get(Some(item), "origin")) == "stolen";
            let refuses_stolen = stolen && !merchant_is_fence;
            let discount = if stolen && merchant_is_fence { &stolen_discount } else { &zero };
            let quote = quote_merchant_sell_unit(Some(merchant), actor_id_value, Some(item), appraisal.as_ref(), reputation, Some(discount));
            let allowed = if refuses_stolen { Sellability { can_sell: false, reason: Some("Этот торговец не берёт чужие вещи") } } else { sellability(Some(item), appraisal.as_ref()) };
            let catalog_price = resolve_catalog_price(Some(item));
            let appraisal_required = catalog_price.is_none() && appraisal.is_none() && !story_locked(Some(item));
            if quote.is_none() && !js::truthy(get(Some(item), "id")) {
                return None;
            }
            let quantity = clamp_int(get(Some(item), "quantity"), 1, MAX_STOCK_QUANTITY, 1);
            let unit = quote.as_ref().and_then(|quote| quote["unit_price_cp"].as_f64());
            let affordable_quantity = unit.map_or(0.0, |unit| floor_div(merchant_purse_cp as f64, unit));
            let can_afford = quote.is_some() && affordable_quantity >= 1.0;
            let mut entry = Map::new();
            entry.insert("quote_id".into(), json!(format!("sell:{merchant_label}:{actor_label}:{}", js::string(get(Some(item), "id")))));
            entry.insert("state_version".into(), json!(version));
            entry.insert("expected_state_version".into(), json!(version));
            entry.insert("direction".into(), json!("sell"));
            copy_field(&mut entry, "actor_id", actor_id_value);
            entry.insert("item_id".into(), json!(js::string(get(Some(item), "id"))));
            entry.insert("catalog_id".into(), json!(clean_id(get(Some(item), "catalog_id"), "")));
            entry.insert("item".into(), item.clone());
            entry.insert("available_quantity".into(), json!(quantity));
            entry.insert("quantity".into(), json!(1));
            let unit_price = quote.as_ref().map_or(json!(0), |quote| quote["unit_price_cp"].clone());
            entry.insert("unit_price_cp".into(), unit_price.clone());
            entry.insert("total_price_cp".into(), unit_price);
            entry.insert("can_sell".into(), json!(allowed.can_sell && can_afford && !trade_refused));
            entry.insert("can_afford".into(), json!(can_afford));
            if trade_refused {
                copy_field(&mut entry, "unavailable_reason", standing.get("trade_refusal_reason"));
            }
            entry.insert("appraisal_required".into(), json!(appraisal_required));
            entry.insert("can_appraise".into(), json!(appraisal_required));
            let provenance = catalog_price
                .as_ref()
                .and_then(|price| price.get("provenance").filter(|value| !value.is_null()).cloned())
                .or_else(|| appraisal.as_ref().and_then(|appraisal| appraisal.get("provenance").filter(|value| !value.is_null()).cloned()))
                .unwrap_or(Value::Null);
            entry.insert("price_provenance".into(), provenance);
            if let Some(appraisal) = appraisal.as_ref() {
                let id = coalesce(appraisal.get("appraisal_id"), appraisal.get("appraisal_fingerprint"));
                copy_field(&mut entry, "appraisal_id", id);
            }
            let reason = match allowed.reason {
                Some(reason) => json!(reason),
                None if can_afford => Value::Null,
                None => json!("У торговца недостаточно монет для выкупа предмета"),
            };
            entry.insert("reason".into(), reason);
            entry.insert("max_quantity".into(), if allowed.can_sell { num(js::min_of([quantity as f64, affordable_quantity, MAX_TRANSACTION_QUANTITY as f64])) } else { json!(0) });
            if let Some(quote) = quote.as_ref() {
                let mut breakdown = Map::new();
                breakdown.insert("catalog_base_unit_cp".into(), quote["base_unit_price_cp"].clone());
                breakdown.insert("merchant_adjustment_percent".into(), percent(quote["merchant_adjustment_bps"].as_f64().unwrap_or(0.0)));
                breakdown.insert("bargain_adjustment_percent".into(), percent(quote["bargain_adjustment_bps"].as_f64().unwrap_or(0.0)));
                breakdown.insert("reputation_adjustment_percent".into(), percent(quote["reputation_adjustment_bps"].as_f64().unwrap_or(0.0)));
                if let Some(stolen) = quote.get("stolen_adjustment_bps").and_then(Value::as_f64).filter(|stolen| *stolen != 0.0) {
                    breakdown.insert("stolen_adjustment_percent".into(), percent(stolen));
                }
                breakdown.insert("final_unit_price_cp".into(), quote["unit_price_cp"].clone());
                entry.insert("breakdown".into(), Value::Object(breakdown));
            }
            Some(Value::Object(entry))
        })
        .collect();

    let services_available = js::truthy(standing.get("services_available"));
    let service_quotes: Vec<Value> = array(merchant.get("services"))
        .iter()
        .filter_map(|service| {
            let quote = quote_merchant_service(Some(merchant), actor_id_value, Some(service), reputation)?;
            let price = quote["price_cp"].as_f64().unwrap_or(0.0);
            let mut entry = Map::new();
            entry.insert("quote_id".into(), json!(format!("service:{merchant_label}:{actor_label}:{}", js::string(quote.get("service_id")))));
            entry.insert("state_version".into(), json!(version));
            entry.insert("expected_state_version".into(), json!(version));
            entry.insert("direction".into(), json!("service"));
            entry.insert("actor_id".into(), json!(actor_label));
            copy_field(&mut entry, "merchant_id", merchant.get("id"));
            entry.insert("service_id".into(), quote["service_id"].clone());
            let normalized = normalize_merchant_services(Some(&Value::Array(vec![service.clone()]))).into_iter().next();
            copy_field(&mut entry, "service", normalized.as_ref());
            entry.insert("price_cp".into(), quote["price_cp"].clone());
            entry.insert("can_afford".into(), json!(balance_cp as f64 >= price));
            // `merchant.available && service.available !== false && standing.services_available`
            let available = if !js::truthy(merchant.get("available")) {
                merchant.get("available").cloned()
            } else if js::is_false(service.get("available")) {
                Some(json!(false))
            } else {
                standing.get("services_available").cloned()
            };
            copy_field(&mut entry, "available", available.as_ref());
            if !services_available {
                if trade_refused {
                    copy_field(&mut entry, "unavailable_reason", standing.get("trade_refusal_reason"));
                } else {
                    entry.insert("unavailable_reason".into(), json!("Торговец не станет оказывать услуги отряду с такой славой"));
                }
            }
            entry.insert("price_provenance".into(), quote["price_provenance"].clone());
            entry.insert(
                "breakdown".into(),
                json!({
                    "base_price_cp": quote["base_price_cp"],
                    "merchant_adjustment_percent": percent(quote["merchant_adjustment_bps"].as_f64().unwrap_or(0.0)),
                    "bargain_adjustment_percent": percent(quote["bargain_adjustment_bps"].as_f64().unwrap_or(0.0)),
                    "reputation_adjustment_percent": percent(quote["reputation_adjustment_bps"].as_f64().unwrap_or(0.0)),
                    "final_price_cp": quote["price_cp"],
                }),
            );
            entry.insert("policy_id".into(), json!(MERCHANT_SERVICES_POLICY_ID));
            Some(Value::Object(entry))
        })
        .collect();

    let pricing = normalize_merchant_pricing(merchant.get("pricing"));
    let bargain_view = match bargain.filter(|bargain| js::truthy(Some(bargain))) {
        None => Value::Null,
        Some(bargain) => {
            let success = js::truthy(bargain.get("success"));
            let adjustment = js::number(bargain.get("pricing_adjustment_bps"));
            let mut view = Map::new();
            view.insert("attempted".into(), json!(true));
            copy_field(&mut view, "success", bargain.get("success"));
            view.insert("discount_percent".into(), if success { num(js::min_of([0.0, adjustment]).abs() / 100.0) } else { json!(0) });
            view.insert("modifier_percent".into(), num(-adjustment / 100.0));
            view.insert("message".into(), json!(if success { "Торговец согласился на более выгодные условия." } else { "Торговец не уступил и немного ужесточил цену." }));
            copy_field(&mut view, "roll_total", bargain.get("roll_total"));
            copy_field(&mut view, "difficulty", bargain.get("difficulty"));
            copy_field(&mut view, "pricing_adjustment_bps", bargain.get("pricing_adjustment_bps"));
            Value::Object(view)
        }
    };
    let mut view = Map::new();
    view.insert("state_version".into(), json!(version));
    view.insert("expected_state_version".into(), json!(version));
    view.insert("merchant".into(), public_merchant_for(merchant));
    view.insert("actor_id".into(), json!(actor_label));
    view.insert("balance".into(), balance);
    view.insert("balance_cp".into(), json!(balance_cp));
    view.insert("merchant_purse_cp".into(), json!(merchant_purse_cp));
    view.insert("buy_quotes".into(), Value::Array(buy_quotes));
    view.insert("sell_quotes".into(), Value::Array(sell_quotes));
    view.insert("service_quotes".into(), Value::Array(service_quotes));
    view.insert("bargain".into(), bargain_view);
    view.insert(
        "pricing_explanation".into(),
        json!(format!(
            "Базовые цены: {}. Покупка и продажа рассчитаны сервером; продажа округляется вниз, а минимальная выплата 1 мм. является политикой {ECONOMY_POLICY_ID}.",
            js::s(pricing.get("catalog_id"))
        )),
    );
    Some(Value::Object(view))
}
