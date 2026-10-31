//! Перенос `server/item-lifecycle.mjs`: жизнь вещи героя на сервере.
//!
//! Проверка команд `EquipItem`, `UseItem`, `TransferItem`, `AttuneItem`,
//! `ActivateItem` (слот и вторая рука, взаимодействие с предметом в бою,
//! цель и заряды применения, передача герою или видимому NPC с пределами
//! стопки, инвентаря и грузоподъёмности, настройка не больше трёх вещей,
//! включение магической вещи), события этих команд и их применение к героям
//! (в том числе `ItemChargesSpent` и `ItemDestroyed`), а также производные
//! числа снаряжения: вес и нагрузка, КД от доспеха и щита, пассивные эффекты
//! вещей и надбавки урона оружия.
//!
//! Мусор старых сохранений JS переживает по-своему: где он обращается к полю
//! `null`, перебирает объект или зовёт `.map` у строки — это `TypeError`
//! ([`ItemLifecycleError::Type`]); где строку перебирают по символам, а
//! `{ ...строка }` раскладывает её по индексам — Rust повторяет то же.

use std::borrow::Cow;

use serde_json::{json, Map, Value};
use sk_core::{hash, js, text};
use sk_economy::merchant_economy::{inventory_stack_key, normalize_inventory_item, InventoryItemOptions, MAX_STOCK_QUANTITY};
use sk_items::item_catalog::{catalog_item, catalog_item_truthy, item_lifecycle_profile, off_hand_weapon_allowed};
use sk_npc_world::npc_positioning::{normalize_npc_world_state, npc_interaction_target_for_viewer, npc_vital_for, MAX_NPC_INVENTORY_ITEMS, MAX_NPC_INVENTORY_OWNERS};

/// `ITEM_LIFECYCLE_COMMAND_TYPES`.
pub const ITEM_LIFECYCLE_COMMAND_TYPES: [&str; 5] = ["EquipItem", "UseItem", "TransferItem", "AttuneItem", "ActivateItem"];
pub const MAX_ATTUNED_ITEMS: i64 = 3;
pub const MAX_ACTIVE_ITEM_EFFECT_BONUS: i64 = 100;
pub const ITEM_DESTROYED_EVENT_SCHEMA_VERSION: i64 = 1;
pub const MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION: i64 = 1;

const DEFAULT_CODE: &str = "ITEM_LIFECYCLE_INVALID";
const HERO_INVENTORY_LIMIT: usize = 200;

const COMMAND_FIELDS: [&str; 28] = [
    "command_type",
    "command_id",
    "campaign_id",
    "actor_id",
    "target_id",
    "target_ids",
    "item_id",
    "quantity",
    "equipped",
    "attuned",
    "recipient_id",
    "charges_to_spend",
    "activated",
    "merchant_id",
    "stock_id",
    "action_id",
    // Клетка рассыпания, выбор режима фляги и оружие под яд. Поля недоверенные:
    // допустимость клетки, дальность и принадлежность оружия проверяет Rules
    // Engine, а не отправитель команды.
    "to",
    "use_mode",
    "weapon_id",
    // Вторая рука для лёгкого оружия: слот проверяет сам жизненный цикл.
    "equip_slot",
    "expected_state_version",
    "ruleset_id",
    "source_rule_ids",
    "house_rule_id",
    "ruling_id",
    "visibility",
    "request_fingerprint",
    "server_authoritative",
];

/// Отказ модуля: `ItemLifecycleValidationError` (сообщение и код) или
/// `TypeError` JS на мусоре старого сохранения.
#[derive(Debug, Clone, PartialEq)]
pub enum ItemLifecycleError {
    Validation { message: String, code: String },
    /// `TypeError` JS. Текст — описание для людей, не текст V8.
    Type(String),
}

impl ItemLifecycleError {
    fn new(message: impl Into<String>, code: &str) -> Self {
        Self::Validation { message: message.into(), code: code.into() }
    }

    /// `error.code`; у `TypeError` кода нет.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Validation { code, .. } => Some(code),
            Self::Type(_) => None,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Validation { message, .. } | Self::Type(message) => message,
        }
    }
}

impl std::fmt::Display for ItemLifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ItemLifecycleError {}

type Result<T> = std::result::Result<T, ItemLifecycleError>;

fn reject<T>(message: impl Into<String>, code: &str) -> Result<T> {
    Err(ItemLifecycleError::new(message, code))
}

fn type_error<T>(what: &str) -> Result<T> {
    Err(ItemLifecycleError::Type(what.into()))
}

// --- доступ к значениям, как в JS ------------------------------------------

fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `value?.key` (у массива — индекс).
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        Some(Value::Array(items)) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `value.key`: у `undefined`/`null` — `TypeError`.
fn member<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>> {
    if nullish(value) {
        return type_error("Cannot read properties of null or undefined");
    }
    Ok(get(value, key))
}

/// `a ?? b`.
fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if nullish(a) {
        b
    } else {
        a
    }
}

/// `value?.[0]`: у строки — первый символ, у объекта — ключ `"0"`.
fn first_of(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => items.first().cloned(),
        Some(Value::String(text)) => text.chars().next().map(|ch| Value::String(ch.to_string())),
        Some(Value::Object(map)) => map.get("0").cloned(),
        _ => None,
    }
}

/// `(value ?? []).find/filter/map/some/reduce`: методы есть только у массива.
fn list(value: Option<&Value>) -> Result<&[Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => type_error("value.map is not a function"),
    }
}

/// `for (const x of value ?? [])` и `[...(value ?? [])]`: строка — по символам.
fn iter_of(value: Option<&Value>) -> Result<Cow<'_, [Value]>> {
    match value {
        None | Some(Value::Null) => Ok(Cow::Borrowed(&[])),
        Some(Value::Array(items)) => Ok(Cow::Borrowed(items)),
        Some(Value::String(text)) => Ok(Cow::Owned(text.chars().map(|ch| Value::String(ch.to_string())).collect())),
        Some(_) => type_error("value is not iterable"),
    }
}

/// `{ ...value }`: объект — его поля, массив и строка — индексы.
fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::clean(value, maximum)
}

/// `integer(value, fallback)`.
fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// `Number.isSafeInteger(Number(value)) ? Number(value) : NaN`.
fn integer_or_nan(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer_number(value).then(|| js::number(value) as i64)
}

/// `Math.max(a, b)` с заразным `NaN`.
fn jmax(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

fn jmin(a: f64, b: f64) -> f64 {
    js::min_of([a, b])
}

/// `Math.round(x * 100) / 100`.
fn round2(value: f64) -> f64 {
    js::round(value * 100.0) / 100.0
}

/// `(values ?? []).includes(needle)`: массив — строгое равенство, строка —
/// подстрока, прочее — `TypeError`.
fn includes(value: Option<&Value>, needle: &str) -> Result<bool> {
    match value {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Array(items)) => Ok(items.iter().any(|item| item == needle)),
        Some(Value::String(text)) => Ok(text.contains(needle)),
        Some(_) => type_error("includes is not a function"),
    }
}

/// `x?.includes?.(needle)`: метода нет — `undefined`.
fn includes_optional(value: Option<&Value>, needle: &str) -> bool {
    match value {
        Some(Value::Array(items)) => items.iter().any(|item| item == needle),
        Some(Value::String(text)) => text.contains(needle),
        _ => false,
    }
}

fn utf16_sort(values: &mut [String]) {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `rulesetId` по умолчанию `''` только для `undefined`; дальше JS сравнивает
/// `String(rulesetId)`.
fn ruleset_text(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        some => js::string(some),
    }
}

fn actor_id(actor: Option<&Value>) -> String {
    js::s(coalesce(get(actor, "id"), get(actor, "actor_id")))
}

fn catalog_id_of(item: Option<&Value>) -> String {
    js::s(coalesce(get(item, "catalog_id"), get(item, "catalogId")))
}

/// `(state.players ?? []).find(actorId(c) === id) ?? null`, затем `!owner`.
fn player<'a>(state: &'a Value, id: &str) -> Result<Option<&'a Value>> {
    let players = list(member(Some(state), "players")?)?;
    Ok(players.iter().find(|candidate| actor_id(Some(candidate)) == id).filter(|found| js::truthy(Some(found))))
}

/// `itemFor(actor, id)`: первая вещь с этим id и количеством больше нуля.
fn item_for<'a>(actor: Option<&'a Value>, id: &str) -> Result<Option<&'a Value>> {
    let inventory = list(get(actor, "inventory"))?;
    let quantity = |item: &Value| {
        let quantity = get(Some(item), "quantity");
        if nullish(quantity) {
            1.0
        } else {
            js::number(quantity)
        }
    };
    Ok(inventory.iter().find(|item| js::string(get(Some(item), "id")) == id && quantity(item) > 0.0).filter(|found| js::truthy(Some(found))))
}

/// Слот, который вещь занимает сейчас: оружие второй руки помечено на экземпляре.
fn effective_equip_slot(item: Option<&Value>, ruleset_id: &str) -> String {
    if is_str(get(item, "equipped_slot"), "off_hand") {
        return "off_hand".into();
    }
    js::s(profile_for(item, ruleset_id).get("equip_slot"))
}

fn profile_for(item: Option<&Value>, ruleset_id: &str) -> Value {
    if let Some(catalog) = item_lifecycle_profile(&catalog_id_of(item), ruleset_id) {
        return catalog;
    }
    let mut profile = Map::new();
    profile.insert("requires_attunement".into(), Value::Bool(js::is_true(get(item, "requires_attunement"))));
    if is_str(get(item, "type"), "weapon") && js::truthy(get(item, "combat")) {
        profile.insert("equip_slot".into(), json!("main_hand"));
    } else if is_str(get(item, "type"), "armor") {
        profile.insert("equip_slot".into(), json!("body"));
    }
    Value::Object(profile)
}

/// Ручное взаимодействие с предметом в бою: обычное оружие, фокус или
/// инструмент-фокус в руке. Поля экземпляра — только для старого оружия без
/// `catalog_id`.
fn combat_held_item(item: &Value, profile: &Value) -> bool {
    let slot = js::s(profile.get("equip_slot"));
    if slot != "main_hand" && slot != "off_hand" {
        return false;
    }
    let catalog_id = catalog_id_of(Some(item));
    if let Some(catalog) = catalog_item(&catalog_id) {
        if is_str(catalog.get("type"), "weapon") && js::truthy(catalog.get("combat")) {
            return true;
        }
        return is_str(catalog.get("focus_mode"), "held") && catalog.get("spellcasting_focus").and_then(Value::as_array).is_some_and(|focus| !focus.is_empty());
    }
    if catalog_item_truthy(&catalog_id) {
        // Ключ прототипа: JS находит у каталога функцию — вещь «из каталога».
        return false;
    }
    is_str(item.get("type"), "weapon") && js::truthy(item.get("combat")) && matches!(item.get("combat"), Some(Value::Object(_) | Value::Array(_)))
}

fn charge_state_for(item: &Value, profile: &Value) -> Option<(i64, i64)> {
    let charges = profile.get("charges").filter(|charges| js::truthy(Some(charges)))?;
    let maximum = integer(charges.get("max"), 0).max(0);
    let requested = coalesce(get(get(Some(item), "charges"), "current"), charges.get("current"));
    Some((integer(requested, maximum).min(maximum).max(0), maximum))
}

fn charge_state_from_event(payload: &Value) -> Value {
    let maximum = integer(get(Some(payload), "max"), 0).max(0);
    json!({ "current": integer(get(Some(payload), "after"), 0).min(maximum).max(0), "max": maximum })
}

fn same_party(state: &Value, id: &str) -> Result<bool> {
    let members = member(Some(state), "partyMemberIds")?;
    let has_length = match members {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(map)) => js::truthy(map.get("length")),
        _ => false,
    };
    let ids: Vec<String> = if has_length {
        match members {
            Some(Value::Array(items)) => items.iter().map(|item| js::string(Some(item))).collect(),
            _ => return type_error("partyMemberIds.map is not a function"),
        }
    } else {
        list(member(Some(state), "players")?)?.iter().map(|actor| actor_id(Some(actor))).collect()
    };
    Ok(ids.iter().any(|candidate| candidate == id))
}

fn allowed_actor(context: &Value, id: &str) -> Result<bool> {
    if js::is_true(member(Some(context), "isAdmin")?) {
        return Ok(true);
    }
    Ok(list(member(Some(context), "allowedActorIds")?)?.iter().any(|candidate| js::string(Some(candidate)) == id))
}

fn assert_plain_command(command: &Value) -> Result<()> {
    let Value::Object(fields) = command else {
        return reject("Команда предмета должна быть объектом", DEFAULT_CODE);
    };
    let unexpected: Vec<&str> = js::keys(fields).into_iter().map(String::as_str).filter(|key| !COMMAND_FIELDS.contains(key)).collect();
    if !unexpected.is_empty() {
        return reject(format!("Команда предмета содержит запрещённые поля: {}", unexpected.join(", ")), "ITEM_COMMAND_UNKNOWN_FIELD");
    }
    Ok(())
}

/// `itemProfileFor(item, { rulesetId })`: профиль жизни вещи — из каталога
/// или (для старых вещей без `catalog_id`) по типу экземпляра.
pub fn item_profile_for(item: Option<&Value>, ruleset_id: Option<&Value>) -> Value {
    profile_for(item, &ruleset_text(ruleset_id))
}

fn inventory_weight_f64(actor: Option<&Value>) -> Result<f64> {
    let mut total = 0.0;
    for item in list(get(actor, "inventory"))? {
        let weight = js::number(get(Some(item), "weight"));
        let weight = if weight.is_nan() || weight == 0.0 { 0.0 } else { weight };
        total += jmax(0.0, weight) * (integer(get(Some(item), "quantity"), 1).max(0) as f64);
    }
    Ok(round2(total))
}

/// `inventoryWeight(actor)`: вес вещей в фунтах, до сотых.
pub fn inventory_weight(actor: Option<&Value>) -> Result<Value> {
    inventory_weight_f64(actor).map(js::num)
}

fn carrying_capacity_f64(actor: Option<&Value>) -> f64 {
    integer(get(get(actor, "abilities"), "str"), 10).max(0) as f64 * 15.0
}

/// `carryingCapacity(actor)`: Сила × 15.
pub fn carrying_capacity(actor: Option<&Value>) -> Value {
    js::num(carrying_capacity_f64(actor))
}

/// `inventoryLoadFor(actor)`: вес, грузоподъёмность, перегруз, остаток и
/// число настроенных вещей.
pub fn inventory_load_for(actor: Option<&Value>) -> Result<Value> {
    let weight = inventory_weight_f64(actor)?;
    let capacity = carrying_capacity_f64(actor);
    let owner = actor_id(actor);
    let attuned = list(get(actor, "inventory"))?.iter().filter(|item| is_str(get(Some(item), "attuned_to"), &owner)).count();
    Ok(json!({
        "weight": js::num(weight),
        "capacity": js::num(capacity),
        "encumbered": capacity > 0.0 && weight > capacity,
        "remaining": js::num(jmax(0.0, round2(capacity - weight))),
        "attuned": attuned,
        "attunement_limit": MAX_ATTUNED_ITEMS,
    }))
}

/// `activeItemEffectTotals(actor)`: надбавки КД и спасбросков от пассивных
/// эффектов вещей; в каждой группе — наибольшая, суммы не выше 100.
pub fn active_item_effect_totals(actor: Option<&Value>) -> Result<Value> {
    let owner = actor_id(actor);
    let mut groups: Vec<(String, i64, i64)> = Vec::new();
    for item in iter_of(get(actor, "inventory"))?.iter() {
        if !js::truthy(Some(item)) || integer(get(Some(item), "quantity"), 1) <= 0 {
            continue;
        }
        let Some(Value::Array(effects)) = get(Some(item), "passive_effects") else { continue };
        for effect in effects.iter().take(32) {
            if !js::truthy(Some(effect)) || integer(get(Some(effect), "schema_version"), 0) != 1 {
                continue;
            }
            let group = clean(get(Some(effect), "group"), 120);
            if group.is_empty() || clean(get(Some(effect), "effect_id"), 120).is_empty() {
                continue;
            }
            if js::is_true(get(Some(effect), "requires_equipped")) && !js::is_true(get(Some(item), "equipped")) {
                continue;
            }
            if js::is_true(get(Some(effect), "requires_attunement")) && (owner.is_empty() || js::s(get(Some(item), "attuned_to")) != owner) {
                continue;
            }
            let armor = integer(get(Some(effect), "armor_class_bonus"), 0).max(0).min(MAX_ACTIVE_ITEM_EFFECT_BONUS);
            let saving = integer(get(Some(effect), "saving_throw_bonus"), 0).max(0).min(MAX_ACTIVE_ITEM_EFFECT_BONUS);
            if armor == 0 && saving == 0 {
                continue;
            }
            match groups.iter_mut().find(|(name, _, _)| *name == group) {
                Some(entry) => {
                    entry.1 = entry.1.max(armor);
                    entry.2 = entry.2.max(saving);
                }
                None => groups.push((group, armor, saving)),
            }
        }
    }
    let mut armor_total = 0;
    let mut saving_total = 0;
    for (_, armor, saving) in &groups {
        armor_total = (armor_total + armor).min(MAX_ACTIVE_ITEM_EFFECT_BONUS);
        saving_total = (saving_total + saving).min(MAX_ACTIVE_ITEM_EFFECT_BONUS);
    }
    let mut names: Vec<String> = groups.into_iter().map(|(name, _, _)| name).collect();
    utf16_sort(&mut names);
    Ok(json!({ "armor_class_bonus": armor_total, "saving_throw_bonus": saving_total, "active_groups": names }))
}

fn normalized_weapon_damage_rider(input: Option<&Value>) -> Option<Value> {
    let Some(Value::Object(fields)) = input else { return None };
    let expression = text::replace_all(sk_core::re!(r"\s+", "gu"), &text::lower(&clean(fields.get("expression"), 40)), "");
    if !text::test(sk_core::re!(r"^([1-9]|1\d|20)d(4|6|8|10|12)$", "u"), &expression) {
        return None;
    }
    let damage_type = text::lower(&clean(fields.get("damage_type"), 40));
    if damage_type.is_empty() {
        return None;
    }
    Some(json!({ "expression": expression, "damage_type": damage_type, "critical_doubles": js::is_true(fields.get("critical_doubles")) }))
}

fn normalized_passive_effect_contract(effect: &Value) -> Option<Value> {
    let Value::Object(fields) = effect else { return None };
    if integer(fields.get("schema_version"), 0) != 1 {
        return None;
    }
    let effect_id = clean(fields.get("effect_id"), 120);
    let group = clean(fields.get("group"), 120);
    if effect_id.is_empty() || group.is_empty() {
        return None;
    }
    let bonus = |key: &str| integer(fields.get(key), 0).max(0).min(MAX_ACTIVE_ITEM_EFFECT_BONUS);
    Some(json!({
        "schema_version": 1,
        "effect_id": effect_id,
        "group": group,
        "requires_equipped": js::is_true(fields.get("requires_equipped")),
        "requires_attunement": js::is_true(fields.get("requires_attunement")),
        "requires_activated": js::is_true(fields.get("requires_activated")),
        "armor_class_bonus": bonus("armor_class_bonus"),
        "saving_throw_bonus": bonus("saving_throw_bonus"),
        "damage_resistances": unique_clean_strings(fields.get("damage_resistances")),
        "spell_immunities": unique_clean_strings(fields.get("spell_immunities")),
        "prevents_critical_hits": js::is_true(fields.get("prevents_critical_hits")),
        "initiative_advantage": js::is_true(fields.get("initiative_advantage")),
        "weapon_damage_rider": normalized_weapon_damage_rider(fields.get("weapon_damage_rider")).unwrap_or(Value::Null),
    }))
}

/// Эффекты экземпляра, совпадающие с каталожными тем же `effect_id` текстом JSON.
fn trusted_item_passive_effects(item: &Value) -> Vec<Value> {
    let catalog_id = clean(coalesce(item.get("catalog_id"), item.get("catalogId")), 120);
    let entry = if catalog_id.is_empty() { None } else { catalog_item(&catalog_id) };
    let (Some(entry), Some(Value::Array(own))) = (entry, item.get("passive_effects")) else { return Vec::new() };
    let Some(Value::Array(canonical)) = entry.get("passive_effects") else { return Vec::new() };
    let mut canonical_by_id: Vec<(String, String)> = Vec::new();
    for effect in canonical.iter().take(32).filter_map(normalized_passive_effect_contract) {
        let id = js::s(effect.get("effect_id"));
        let text = js::stringify(&effect);
        match canonical_by_id.iter_mut().find(|(known, _)| *known == id) {
            Some(entry) => entry.1 = text,
            None => canonical_by_id.push((id, text)),
        }
    }
    own.iter()
        .take(32)
        .filter_map(normalized_passive_effect_contract)
        .filter(|effect| {
            let id = js::s(effect.get("effect_id"));
            canonical_by_id.iter().any(|(known, text)| *known == id && *text == js::stringify(effect))
        })
        .collect()
}

fn unique_clean_strings(values: Option<&Value>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for value in values.and_then(Value::as_array).into_iter().flatten().take(32) {
        let cleaned = text::lower(&clean(Some(value), 80));
        if !cleaned.is_empty() && !unique.contains(&cleaned) {
            unique.push(cleaned);
        }
    }
    utf16_sort(&mut unique);
    unique
}

/// Параметры `activeItemMechanicEffects(actor, { selectedItemId,
/// selectedCountsAsEquipped })`.
#[derive(Debug, Clone, Default)]
pub struct MechanicEffectOptions<'a> {
    /// `selectedItemId`; `None` и `null` — не выбрано.
    pub selected_item_id: Option<&'a Value>,
    /// `selectedCountsAsEquipped` (по истинности).
    pub selected_counts_as_equipped: bool,
}

/// `activeItemMechanicEffects(actor, options)`: расширенные эффекты известных
/// предметов (сопротивления, иммунитеты, надбавки урона), прочитанные из
/// сохранённого экземпляра и сверенные с каталогом.
pub fn active_item_mechanic_effects(actor: Option<&Value>, options: &MechanicEffectOptions<'_>) -> Result<Vec<Value>> {
    let owner = actor_id(actor);
    let mut result = Vec::new();
    for item in iter_of(get(actor, "inventory"))?.iter() {
        if !js::truthy(Some(item)) || integer(get(Some(item), "quantity"), 1) <= 0 {
            continue;
        }
        let catalog_id = clean(coalesce(get(Some(item), "catalog_id"), get(Some(item), "catalogId")), 120);
        if catalog_id.is_empty() {
            continue;
        }
        let selected = !nullish(options.selected_item_id) && js::string(get(Some(item), "id")) == js::string(options.selected_item_id);
        let considered_equipped = js::is_true(get(Some(item), "equipped")) || (selected && options.selected_counts_as_equipped);
        for effect in trusted_item_passive_effects(item) {
            let effect_id = clean(effect.get("effect_id"), 120);
            let group = clean(effect.get("group"), 120);
            if effect_id.is_empty() || group.is_empty() {
                continue;
            }
            if js::is_true(effect.get("requires_equipped")) && !considered_equipped {
                continue;
            }
            if js::is_true(effect.get("requires_attunement")) && (owner.is_empty() || js::s(get(Some(item), "attuned_to")) != owner) {
                continue;
            }
            if js::is_true(effect.get("requires_activated")) && !js::is_true(get(Some(item), "activated")) {
                continue;
            }
            let mut entry = Map::new();
            entry.insert("schema_version".into(), json!(1));
            entry.insert("effect_id".into(), json!(effect_id));
            entry.insert("group".into(), json!(group));
            entry.insert("item_id".into(), json!(clean(get(Some(item), "id"), 120)));
            entry.insert("item_name".into(), json!(clean(get(Some(item), "name"), 120)));
            entry.insert("catalog_id".into(), json!(catalog_id));
            entry.insert("damage_resistances".into(), json!(unique_clean_strings(effect.get("damage_resistances"))));
            entry.insert("spell_immunities".into(), json!(unique_clean_strings(effect.get("spell_immunities"))));
            entry.insert("prevents_critical_hits".into(), Value::Bool(js::is_true(effect.get("prevents_critical_hits"))));
            entry.insert("initiative_advantage".into(), Value::Bool(js::is_true(effect.get("initiative_advantage"))));
            if let Some(rider) = normalized_weapon_damage_rider(effect.get("weapon_damage_rider")) {
                entry.insert("weapon_damage_rider".into(), rider);
            }
            result.push(Value::Object(entry));
        }
    }
    Ok(result)
}

/// `weaponDamageRidersForItem(actor, itemId, { selectedCountsAsEquipped })`:
/// надбавки урона оружия в основной руке, по одной на группу.
pub fn weapon_damage_riders_for_item(actor: Option<&Value>, item_id: Option<&Value>, selected_counts_as_equipped: bool) -> Result<Vec<Value>> {
    let Some(item) = item_for(actor, &js::s(item_id))? else { return Ok(Vec::new()) };
    if !is_str(item.get("type"), "weapon") || !is_str(profile_for(Some(item), "").get("equip_slot"), "main_hand") {
        return Ok(Vec::new());
    }
    let wanted = js::string(item_id);
    let options = MechanicEffectOptions { selected_item_id: item_id, selected_counts_as_equipped };
    let mut seen_groups: Vec<String> = Vec::new();
    let mut result = Vec::new();
    for effect in active_item_mechanic_effects(actor, &options)? {
        let Some(rider) = effect.get("weapon_damage_rider") else { continue };
        if !is_str(effect.get("item_id"), &wanted) {
            continue;
        }
        let group = js::s(effect.get("group"));
        if seen_groups.contains(&group) {
            continue;
        }
        seen_groups.push(group);
        let mut entry = Map::new();
        for key in ["effect_id", "group", "item_id", "item_name", "catalog_id"] {
            entry.insert(key.into(), effect.get(key).cloned().unwrap_or(Value::Null));
        }
        for (key, value) in spread(rider) {
            entry.insert(key, value);
        }
        result.push(Value::Object(entry));
    }
    Ok(result)
}

fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_nan() {
        0.0
    } else {
        number
    }
}

/// `equippedShieldBonus(actor)`: надбавка КД надетых щитов.
pub fn equipped_shield_bonus(actor: Option<&Value>) -> Result<Value> {
    let mut bonus = 0.0;
    for item in iter_of(get(actor, "inventory"))?.iter() {
        if js::truthy(get(Some(item), "equipped")) {
            bonus += number_or_zero(profile_for(Some(item), "").get("armor_bonus"));
        }
    }
    Ok(js::num(bonus))
}

/// `derivedEquipmentArmorClass(actor, { includeItemEffects })`: КД от
/// надетого доспеха, щита и пассивных эффектов; `null`, если снаряжение КД не
/// задаёт.
pub fn derived_equipment_armor_class(actor: Option<&Value>, include_item_effects: bool) -> Result<Value> {
    let dex_score = number_or_zero(get(get(actor, "abilities"), "dex"));
    let dexterity = (((if dex_score == 0.0 { 10.0 } else { dex_score }) - 10.0) / 2.0).floor();
    let mut body: Option<f64> = None;
    let mut bonus = 0.0;
    for item in iter_of(get(actor, "inventory"))?.iter() {
        if !js::truthy(get(Some(item), "equipped")) {
            continue;
        }
        let profile = profile_for(Some(item), "");
        if let Some(armor) = profile.get("armor").filter(|armor| js::truthy(Some(armor))) {
            let dexterity_bonus = if js::truthy(armor.get("dexterity")) {
                if nullish(armor.get("dexterity_cap")) {
                    dexterity
                } else {
                    jmin(dexterity, number_or_zero(armor.get("dexterity_cap")))
                }
            } else {
                0.0
            };
            body = Some(jmax(body.unwrap_or(0.0), js::number(armor.get("base")) + dexterity_bonus));
        }
        bonus += number_or_zero(profile.get("armor_bonus"));
    }
    let item_bonus = if include_item_effects { js::number(active_item_effect_totals(actor)?.get("armor_class_bonus")) } else { 0.0 };
    if body.is_none() && bonus == 0.0 && item_bonus == 0.0 {
        return Ok(Value::Null);
    }
    Ok(js::num(jmax(0.0, body.unwrap_or(10.0 + dexterity)) + bonus + item_bonus))
}

fn transfer_item_id(command: &Value, item: &Value, recipient_id: &str) -> String {
    let item_id = js::string(get(Some(item), "id"));
    let digest = hash::sha256_hex(format!("{}\0{item_id}\0{recipient_id}", js::s(command.get("command_id"))));
    format!("{}:transfer:{}", text::slice(&item_id, 0, Some(80)), &digest[..20])
}

/// `validateItemLifecycleCommand(command, state, context)`: проверка команды
/// жизни вещи и её серверная форма; чужие команды возвращаются как есть.
pub fn validate_item_lifecycle_command(command: &Value, state: &Value, context: Option<&Value>) -> Result<Value> {
    let command_type = member(Some(command), "command_type")?;
    let Some(Value::String(command_type)) = command_type.filter(|kind| ITEM_LIFECYCLE_COMMAND_TYPES.iter().any(|known| is_str(Some(kind), known))) else {
        return Ok(command.clone());
    };
    let command_type = command_type.as_str();
    assert_plain_command(command)?;
    let owner_id = clean(command.get("actor_id"), 120);
    let Some(owner) = player(state, &owner_id)? else {
        return reject("Герой не найден", "ACTOR_NOT_FOUND");
    };
    let empty_context = Value::Object(Map::new());
    if !allowed_actor(context.unwrap_or(&empty_context), &owner_id)? {
        return reject("Предмет доступен только владельцу героя", "ACTOR_FORBIDDEN");
    }
    let item_id = clean(command.get("item_id"), 120);
    let Some(item) = item_for(Some(owner), &item_id)? else {
        return reject("Предмет не найден", "ITEM_NOT_FOUND");
    };
    let ruleset_id = ruleset_text(state.get("ruleset_id"));
    let profile = profile_for(Some(item), &ruleset_id);
    let mut result = spread(command);
    result.insert("actor_id".into(), json!(owner_id));
    result.insert("item_id".into(), json!(item_id));
    result.insert("target_ids".into(), json!([owner_id]));
    result.insert("visibility".into(), json!("party"));
    result.insert("item_profile".into(), profile.clone());
    let combat = get(get(Some(state), "mechanics"), "combat");
    let combat_active = js::truthy(get(combat, "active"));
    let inventory = || list(get(Some(owner), "inventory"));

    if command_type == "EquipItem" {
        let equipped = !js::is_false(command.get("equipped"));
        if !js::truthy(profile.get("equip_slot")) {
            return reject("Этот предмет нельзя экипировать", "ITEM_NOT_EQUIPPABLE");
        }
        if js::is_true(item.get("equipped")) == equipped {
            return reject(if equipped { "Предмет уже экипирован" } else { "Предмет уже снят" }, "ITEM_EQUIP_UNCHANGED");
        }
        let off_hand = equipped && js::s(command.get("equip_slot")) == "off_hand";
        if off_hand {
            if !off_hand_weapon_allowed(Some(item)) {
                return reject("Во вторую руку берут только лёгкое оружие ближнего боя", "OFF_HAND_WEAPON_NOT_LIGHT");
            }
            let main_hand = inventory()?.iter().find(|candidate| {
                js::is_true(get(Some(candidate), "equipped"))
                    && js::string(candidate.get("id")) != item_id
                    && effective_equip_slot(Some(candidate), &ruleset_id) == "main_hand"
                    && is_str(candidate.get("type"), "weapon")
            });
            if !main_hand.is_some_and(|main_hand| off_hand_weapon_allowed(Some(main_hand))) {
                return reject("Сначала возьмите в основную руку лёгкое оружие ближнего боя", "OFF_HAND_MAIN_HAND_NOT_LIGHT");
            }
        }
        let target_slot = if off_hand { "off_hand".to_string() } else { js::string(profile.get("equip_slot")) };
        if combat_active {
            if !combat_held_item(item, &profile) {
                return reject("В бою сейчас можно убрать или достать только оружие, ручной фокус или инструмент-фокус", "ITEM_EQUIP_DURING_COMBAT_UNSUPPORTED");
            }
            let catalog = catalog_item(&catalog_id_of(Some(item)));
            let catalog_combat = get(catalog, "combat");
            let two_handed = js::is_true(get(catalog_combat, "twoHanded")) || includes_optional(get(catalog_combat, "properties"), "two-handed");
            let equipped_shield = inventory()?.iter().any(|candidate| {
                js::is_true(get(Some(candidate), "equipped"))
                    && (is_str(get(get(get(catalog_item(&catalog_id_of(Some(candidate))), "equip"), "armor"), "kind"), "shield")
                        || is_str(get(get(Some(candidate), "armor_profile"), "kind"), "shield"))
            });
            if equipped && two_handed && equipped_shield {
                return reject("Для двуручного оружия нужно снять щит вне боя", "TWO_HANDED_WITH_SHIELD");
            }
            if equipped {
                let occupying = inventory()?.iter().find(|candidate| {
                    js::string(get(Some(candidate), "id")) != item_id && js::is_true(get(Some(candidate), "equipped")) && effective_equip_slot(Some(candidate), &ruleset_id) == target_slot
                });
                if let Some(occupying) = occupying {
                    let name = coalesce(occupying.get("name"), None).map_or_else(|| "предмет".to_string(), |name| js::string(Some(name)));
                    return reject(format!("Сначала снимите «{name}»: две вещи нельзя достать из одного слота одним взаимодействием"), "ITEM_COMBAT_SLOT_OCCUPIED");
                }
            }
            // В D&D 2014 первое взаимодействие с объектом в своём ходу
            // бесплатно, второе требует действия; отсутствие флага — первое.
            let economy = get(get(combat, "action_economy"), &owner_id);
            let action = if js::is_false(get(economy, "object_interaction")) { "action" } else { "object_interaction" };
            result.insert("combat_action".into(), json!(action));
        }
        result.insert("equipped".into(), Value::Bool(equipped));
        result.insert("equip_slot".into(), json!(target_slot));
    }

    if command_type == "UseItem" {
        let Some(item_use) = profile.get("use").filter(|item_use| js::truthy(Some(item_use))) else {
            return reject("У предмета нет серверного профиля использования", "ITEM_NOT_USABLE");
        };
        let requested_target = command.get("target_id").filter(|target| js::truthy(Some(target))).cloned().unwrap_or_else(|| json!(owner_id));
        let target_id = clean(Some(&requested_target), 120);
        let use_target = item_use.get("target");
        let creature_target = is_str(use_target, "creature") || is_str(use_target, "enemy");
        let target_found = if creature_target {
            let mut pool: Vec<Value> = Vec::new();
            for key in ["players", "actors", "enemies"] {
                pool.extend(iter_of(member(Some(state), key)?)?.iter().cloned());
            }
            pool.iter().find(|candidate| actor_id(Some(candidate)) == target_id).is_some_and(|found| js::truthy(Some(found)))
        } else {
            player(state, &target_id)?.is_some()
        };
        let enemy_target = list(member(Some(state), "enemies")?)?.iter().any(|candidate| actor_id(Some(candidate)) == target_id);
        let invalid = !target_found || (is_str(use_target, "enemy") && !enemy_target) || (!creature_target && !same_party(state, &target_id)?);
        if invalid {
            return reject(if creature_target { "Цель использования не является допустимым противником" } else { "Цель использования не входит в отряд" }, "INVALID_ITEM_TARGET");
        }
        if is_str(use_target, "self") && target_id != owner_id {
            return reject("Этот предмет можно использовать только на себя", "INVALID_ITEM_TARGET");
        }
        if js::is_true(item_use.get("combat_only")) && !js::is_true(get(combat, "active")) {
            return reject("Этот предмет можно использовать только в бою", "COMBAT_NOT_ACTIVE");
        }
        if js::is_true(item_use.get("requires_equipped")) && !js::is_true(item.get("equipped")) {
            return reject("Чтобы использовать этот предмет, его нужно держать экипированным", "ITEM_NOT_EQUIPPED");
        }
        if is_str(item_use.get("kind"), "ration") && combat_active {
            return reject("Паёк нельзя использовать во время боя", "ITEM_USE_DURING_COMBAT");
        }
        let minimum = integer(item_use.get("min_charges_to_spend"), 0).max(0);
        let maximum = integer(item_use.get("max_charges_to_spend"), minimum).max(minimum);
        let variable = maximum > 0;
        let requested = integer_or_nan(command.get("charges_to_spend"));
        if variable && !requested.is_some_and(|requested| requested >= minimum && requested <= maximum) {
            return reject(format!("Нужно потратить от {minimum} до {maximum} зарядов"), "INVALID_ITEM_CHARGE_SPEND");
        }
        let charge_cost = if variable { requested.unwrap_or(0) } else { integer(item_use.get("charges_per_use"), 0).max(0) };
        if charge_cost > 0 {
            let Some((current, charge_max)) = charge_state_for(item, &profile).filter(|(current, _)| *current >= charge_cost) else {
                return reject("У предмета не осталось применений", "ITEM_CHARGES_EXHAUSTED");
            };
            result.insert("charge_spend".into(), json!({ "before": current, "spent": charge_cost, "after": current - charge_cost, "max": charge_max }));
        }
        if variable {
            result.insert("charges_to_spend".into(), json!(charge_cost));
        }
        result.insert("target_id".into(), json!(target_id));
        result.insert("target_ids".into(), json!([target_id]));
        result.insert("use_profile".into(), item_use.clone());
    }

    if command_type == "TransferItem" {
        validate_transfer(command, state, &mut result, TransferInput { owner_id: &owner_id, item, profile: &profile, combat_active })?;
    }

    if command_type == "AttuneItem" {
        if combat_active {
            return reject("Настройка на предмет выполняется вне боя", "ITEM_ATTUNE_DURING_COMBAT");
        }
        let attuned = !js::is_false(command.get("attuned"));
        if attuned && !js::is_true(profile.get("requires_attunement")) {
            return reject("Этот предмет не требует настройки", "ITEM_NOT_ATTUNABLE");
        }
        if attuned && js::truthy(item.get("attuned_to")) && !is_str(item.get("attuned_to"), &owner_id) {
            return reject("Предмет уже настроен на другого героя", "ITEM_ALREADY_ATTUNED");
        }
        let catalog_id = clean(coalesce(item.get("catalog_id"), item.get("catalogId")), 120);
        if attuned && !catalog_id.is_empty() {
            for candidate in inventory()? {
                let candidate_id = js::string(member(Some(candidate), "id")?);
                if candidate_id != item_id && clean(coalesce(candidate.get("catalog_id"), candidate.get("catalogId")), 120) == catalog_id && js::s(candidate.get("attuned_to")) == owner_id {
                    return reject("Нельзя настроиться на несколько копий одного и того же предмета", "DUPLICATE_ITEM_ATTUNEMENT");
                }
            }
        }
        let mut current = 0;
        for candidate in inventory()? {
            let attuned_to = member(Some(candidate), "attuned_to")?;
            if is_str(attuned_to, &owner_id) && !is_str(candidate.get("id"), &item_id) {
                current += 1;
            }
        }
        if attuned && current >= MAX_ATTUNED_ITEMS {
            return reject("Достигнут лимит из трёх настроенных предметов", "ATTUNEMENT_LIMIT_REACHED");
        }
        result.insert("attuned".into(), Value::Bool(attuned));
    }

    if command_type == "ActivateItem" {
        let activation = profile.get("activation").filter(|activation| js::truthy(Some(activation)));
        let Some(activation) = activation.filter(|activation| integer(activation.get("schema_version"), 0) == MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION) else {
            return reject("Этот предмет нельзя активировать", "ITEM_NOT_ACTIVATABLE");
        };
        let Some(Value::Bool(activated)) = command.get("activated") else {
            return reject("Нужно явно выбрать включение или выключение предмета", "INVALID_ITEM_ACTIVATION");
        };
        if js::is_true(activation.get("requires_equipped")) && !js::is_true(item.get("equipped")) {
            return reject("Чтобы активировать предмет, его нужно держать экипированным", "ITEM_NOT_EQUIPPED");
        }
        if js::is_true(activation.get("requires_attunement")) && js::s(item.get("attuned_to")) != owner_id {
            return reject("Для активации нужна настройка на предмет", "ITEM_NOT_ATTUNED");
        }
        if matches!(item.get("activated"), Some(Value::Bool(current)) if current == activated) {
            return reject("Предмет уже находится в выбранном состоянии", "ITEM_ACTIVATION_UNCHANGED");
        }
        result.insert("activated".into(), Value::Bool(*activated));
        result.insert("activation_profile".into(), activation.clone());
        result.insert("activation_before".into(), Value::Bool(js::is_true(item.get("activated"))));
    }
    Ok(Value::Object(result))
}

struct TransferInput<'a> {
    owner_id: &'a str,
    item: &'a Value,
    profile: &'a Value,
    combat_active: bool,
}

fn validate_transfer(command: &Value, state: &Value, result: &mut Map<String, Value>, input: TransferInput<'_>) -> Result<()> {
    let TransferInput { owner_id, item, profile, combat_active } = input;
    if combat_active {
        return reject("Передача предметов во время боя недоступна", "ITEM_TRANSFER_DURING_COMBAT");
    }
    if js::truthy(get(Some(item), "equipped")) {
        return reject("Сначала снимите предмет", "ITEM_EQUIPPED");
    }
    if js::truthy(get(Some(item), "attuned_to")) {
        return reject("Сначала разорвите настройку с предметом", "ITEM_ATTUNED");
    }
    let recipient_source = command.get("recipient_id").filter(|recipient| js::truthy(Some(recipient))).or_else(|| command.get("target_id"));
    let recipient_id = clean(recipient_source, 120);
    if recipient_id.is_empty() || recipient_id == owner_id {
        return reject("Получатель должен отличаться от владельца предмета", "INVALID_ITEM_RECIPIENT");
    }
    let hero = player(state, &recipient_id)?;
    let npc_inventory: Value;
    let empty = Value::Array(Vec::new());
    let mut recipient_inventory = coalesce(get(hero, "inventory"), None).unwrap_or(&empty);
    let recipient_is_npc;
    if hero.is_some() {
        if !same_party(state, &recipient_id)? {
            return reject("Получатель должен быть другим героем отряда", "INVALID_ITEM_RECIPIENT");
        }
        recipient_is_npc = false;
    } else {
        let recipient_value = Value::String(recipient_id.clone());
        let Some(target) = npc_interaction_target_for_viewer(state, &recipient_value) else {
            return reject("NPC должен быть видим и реально присутствовать в текущей сцене", "NPC_ITEM_RECIPIENT_NOT_VISIBLE");
        };
        if js::is_false(get(Some(&target.npc), "available")) {
            return reject("NPC сейчас недоступен для взаимодействия", "NPC_ITEM_RECIPIENT_UNAVAILABLE");
        }
        if !js::is_true(npc_vital_for(state, &recipient_value).get("alive")) {
            return reject("Нельзя передать предмет погибшему NPC", "NPC_ITEM_RECIPIENT_DEAD");
        }
        recipient_is_npc = true;
        let world = normalize_npc_world_state(state.get("npc_world"), &json!({}));
        let inventories = world.get("inventories").and_then(Value::as_object);
        let known = inventories.and_then(|inventories| inventories.get(&recipient_id)).cloned();
        let owners = inventories.map_or(0, Map::len);
        if known.is_none() && owners >= MAX_NPC_INVENTORY_OWNERS {
            return reject("Хранилище инвентарей NPC заполнено", "NPC_INVENTORY_CAPACITY_EXCEEDED");
        }
        npc_inventory = known.unwrap_or_else(|| Value::Array(Vec::new()));
        recipient_inventory = &npc_inventory;
    }
    let quantity = integer(command.get("quantity"), 1);
    if quantity < 1 || quantity > integer(get(Some(item), "quantity"), 1) {
        return reject("Некорректное количество предметов", "INVALID_ITEM_QUANTITY");
    }
    let mut draft = spread(item);
    draft.insert("id".into(), json!(transfer_item_id(command, item, &recipient_id)));
    draft.insert("quantity".into(), json!(quantity));
    draft.insert("equipped".into(), Value::Bool(false));
    draft.insert("attuned_to".into(), Value::Null);
    let transferred = normalize_inventory_item(Some(&Value::Object(draft)), InventoryItemOptions { preserve_unknown: true, ..Default::default() });
    let stackable = !js::is_false(profile.get("stackable"));
    if !stackable && quantity != 1 {
        return reject("Этот предмет переносится только отдельным экземпляром", "ITEM_NOT_STACKABLE");
    }
    let transferred_key = inventory_stack_key(Some(&transferred));
    let matches_stack = |candidate: &Value| -> Result<bool> {
        let equipped = member(Some(candidate), "equipped")?;
        Ok(!js::truthy(equipped) && !js::truthy(get(Some(candidate), "attuned_to")) && inventory_stack_key(Some(candidate)) == transferred_key)
    };
    let mut mergeable = false;
    if stackable {
        for candidate in list(Some(recipient_inventory))? {
            if matches_stack(candidate)? {
                mergeable = true;
                break;
            }
        }
    }
    let mut matching_quantity = 0i64;
    if stackable {
        for candidate in list(Some(recipient_inventory))? {
            if matches_stack(candidate)? {
                matching_quantity += integer(candidate.get("quantity"), 1);
            }
        }
    }
    let limit = if recipient_is_npc { MAX_NPC_INVENTORY_ITEMS } else { HERO_INVENTORY_LIMIT };
    // `recipientInventory.length`: у объекта — его поле `length`, у числа — нет.
    let inventory_length = match recipient_inventory {
        Value::Array(items) => items.len() as f64,
        Value::String(text) => text.encode_utf16().count() as f64,
        Value::Object(map) => map.get("length").map_or(f64::NAN, |length| js::number(Some(length))),
        _ => f64::NAN,
    };
    if !mergeable && inventory_length >= limit as f64 {
        return if recipient_is_npc {
            reject("Инвентарь NPC заполнен", "NPC_INVENTORY_CAPACITY_EXCEEDED")
        } else {
            reject("Инвентарь получателя заполнен", "INVENTORY_CAPACITY_EXCEEDED")
        };
    }
    if matching_quantity + quantity > MAX_STOCK_QUANTITY {
        return reject("Стопка предметов получателя превысит допустимый размер", "ITEM_STACK_LIMIT_EXCEEDED");
    }
    if let Some(hero) = hero {
        let projected = inventory_weight_f64(Some(hero))? + js::number(transferred.get("weight")) * quantity as f64;
        if projected > carrying_capacity_f64(Some(hero)) {
            return reject("Получатель превысит грузоподъёмность", "CARRYING_CAPACITY_EXCEEDED");
        }
    }
    result.insert("recipient_id".into(), json!(recipient_id));
    result.insert("recipient_kind".into(), json!(if recipient_is_npc { "npc" } else { "hero" }));
    result.insert("quantity".into(), json!(quantity));
    result.insert("transferred_item".into(), transferred);
    result.insert("item_stackable".into(), Value::Bool(stackable));
    result.insert("target_ids".into(), json!([owner_id, recipient_id]));
    Ok(())
}

/// `{ key: value }` без поля, если значение `undefined`.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn or_null(value: Option<&Value>) -> Value {
    coalesce(value, None).cloned().unwrap_or(Value::Null)
}

/// `itemLifecycleEvents(command)`: события проверенной команды.
pub fn item_lifecycle_events(command: &Value) -> Result<Vec<Value>> {
    let command_type = member(Some(command), "command_type")?;
    let field = |key: &str| command.get(key);
    let array_item = |key: &str| field(key).cloned().unwrap_or(Value::Null);
    let fingerprint = or_null(field("request_fingerprint"));
    let mut payload = Map::new();
    let event = if is_str(command_type, "EquipItem") {
        put(&mut payload, "item_id", field("item_id"));
        put(&mut payload, "equip_slot", field("equip_slot"));
        if js::truthy(field("combat_action")) {
            put(&mut payload, "combat_action", field("combat_action"));
        }
        payload.insert("request_fingerprint".into(), fingerprint);
        let kind = if js::truthy(field("equipped")) { "ItemEquipped" } else { "ItemUnequipped" };
        json!({ "event_type": kind, "payload": payload, "target_ids": [array_item("actor_id")] })
    } else if is_str(command_type, "TransferItem") {
        put(&mut payload, "item_id", field("item_id"));
        put(&mut payload, "from_actor_id", field("actor_id"));
        put(&mut payload, "to_actor_id", field("recipient_id"));
        put(&mut payload, "recipient_kind", field("recipient_kind"));
        put(&mut payload, "quantity", field("quantity"));
        put(&mut payload, "item", field("transferred_item"));
        payload.insert("stackable".into(), Value::Bool(!js::is_false(field("item_stackable"))));
        payload.insert("request_fingerprint".into(), fingerprint);
        json!({ "event_type": "ItemTransferred", "payload": payload, "target_ids": [array_item("actor_id"), array_item("recipient_id")] })
    } else if is_str(command_type, "AttuneItem") {
        put(&mut payload, "item_id", field("item_id"));
        put(&mut payload, "actor_id", field("actor_id"));
        put(&mut payload, "attuned", field("attuned"));
        payload.insert("request_fingerprint".into(), fingerprint);
        json!({ "event_type": "ItemAttunementChanged", "payload": payload, "target_ids": [array_item("actor_id")] })
    } else if is_str(command_type, "ActivateItem") {
        let activation = member(field("activation_profile"), "activation_id").map(|_| field("activation_profile"))?;
        payload.insert("schema_version".into(), json!(MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION));
        put(&mut payload, "owner_id", field("actor_id"));
        put(&mut payload, "item_id", field("item_id"));
        put(&mut payload, "activation_id", get(activation, "activation_id"));
        payload.insert("activated_before".into(), Value::Bool(js::is_true(field("activation_before"))));
        payload.insert("activated".into(), Value::Bool(js::is_true(field("activated"))));
        payload.insert("combat_action".into(), or_null(get(activation, "combat_action")));
        payload.insert("request_fingerprint".into(), fingerprint);
        json!({
            "event_type": "MagicItemActivationChanged",
            "event_schema_version": MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION,
            "payload": payload,
            "target_ids": [array_item("actor_id")],
        })
    } else {
        return Ok(Vec::new());
    };
    Ok(vec![event])
}

/// `{ ...item }` без `equipped_slot`.
fn without_slot(item: &Value) -> Map<String, Value> {
    let mut rest = spread(item);
    rest.shift_remove("equipped_slot");
    rest
}

fn unequip(item: &Value) -> Value {
    let mut rest = without_slot(item);
    rest.insert("equipped".into(), Value::Bool(false));
    rest.insert("activated".into(), Value::Bool(false));
    Value::Object(rest)
}

/// `{ ...actor, inventory }`.
fn with_inventory(actor: &Value, inventory: Vec<Value>) -> Value {
    let mut next = spread(actor);
    next.insert("inventory".into(), Value::Array(inventory));
    Value::Object(next)
}

/// `String(item.id) === String(payload.item_id)`; у `null` вещи — `TypeError`.
fn is_item(item: &Value, wanted: &str) -> Result<bool> {
    Ok(js::string(member(Some(item), "id")?) == wanted)
}

/// Владелец по событию: `payload.owner_id ?? event.target_ids?.[0] ?? event.actor_id ?? ''`.
fn event_owner(first: Option<&Value>, event: &Value) -> String {
    let target = first_of(event.get("target_ids"));
    js::s(coalesce(coalesce(first, target.as_ref()), event.get("actor_id")))
}

/// `next.map((actor) => actorId(actor) !== ownerId ? actor : update(actor))`.
fn map_owner(next: Vec<Value>, owner_id: &str, mut update: impl FnMut(&Value) -> Result<Value>) -> Result<Vec<Value>> {
    next.into_iter().map(|actor| if actor_id(Some(&actor)) != owner_id { Ok(actor) } else { update(&actor) }).collect()
}

/// `applyItemLifecycleEventToPlayers(players, event)`: герои после события
/// жизни вещи (надеть, снять, настройка, передача, заряды, уничтожение,
/// включение).
pub fn apply_item_lifecycle_event_to_players(players: Option<&Value>, event: &Value) -> Result<Value> {
    let raw_payload = member(Some(event), "payload")?;
    let empty = Value::Object(Map::new());
    let payload = coalesce(raw_payload, None).unwrap_or(&empty);
    let field = |key: &str| get(Some(payload), key);
    let wanted_item = js::string(field("item_id"));
    let mut next: Vec<Value> = players.and_then(Value::as_array).cloned().unwrap_or_default();
    let event_type = event.get("event_type");
    let schema_ok = |version: i64| js::number(event.get("event_schema_version")) == version as f64 && js::number(field("schema_version")) == version as f64;

    if is_str(event_type, "ItemEquipped") || is_str(event_type, "ItemUnequipped") {
        let owner_id = event_owner(None, event);
        let equipped = is_str(event_type, "ItemEquipped");
        let slot = field("equip_slot");
        next = map_owner(next, &owner_id, |actor| {
            let inventory = list(member(Some(actor), "inventory")?)?;
            let mut target = None;
            for item in inventory {
                if is_item(item, &wanted_item)? {
                    target = Some(item);
                    break;
                }
            }
            let catalog_combat = get(catalog_item(&catalog_id_of(target)), "combat");
            let frees_off_hand = equipped && is_str(slot, "main_hand") && (js::is_true(get(catalog_combat, "twoHanded")) || includes(get(catalog_combat, "properties"), "two-handed")?);
            let mut items = Vec::with_capacity(inventory.len());
            for item in inventory {
                if is_item(item, &wanted_item)? {
                    let mut rest = without_slot(item);
                    rest.insert("equipped".into(), Value::Bool(equipped));
                    if equipped && is_str(slot, "off_hand") {
                        rest.insert("equipped_slot".into(), json!("off_hand"));
                    }
                    if !equipped {
                        rest.insert("activated".into(), Value::Bool(false));
                    }
                    items.push(Value::Object(rest));
                } else if equipped && js::is_true(item.get("equipped")) && is_str(slot, &effective_equip_slot(Some(item), "")) {
                    items.push(unequip(item));
                } else if frees_off_hand && js::is_true(item.get("equipped")) && is_str(item.get("equipped_slot"), "off_hand") {
                    items.push(unequip(item));
                } else {
                    items.push(item.clone());
                }
            }
            Ok(with_inventory(actor, items))
        })?;
    }

    if is_str(event_type, "ItemAttunementChanged") {
        let owner_id = js::s(coalesce(field("actor_id"), event.get("actor_id")));
        let attuned = js::truthy(field("attuned"));
        next = map_owner(next, &owner_id, |actor| {
            let mut items = Vec::new();
            for item in list(member(Some(actor), "inventory")?)? {
                if is_item(item, &wanted_item)? {
                    let mut next_item = spread(item);
                    next_item.insert("attuned_to".into(), if attuned { json!(owner_id) } else { Value::Null });
                    if !attuned {
                        next_item.insert("activated".into(), Value::Bool(false));
                    }
                    items.push(Value::Object(next_item));
                } else {
                    items.push(item.clone());
                }
            }
            Ok(with_inventory(actor, items))
        })?;
    }

    if is_str(event_type, "ItemTransferred") {
        let quantity = integer(field("quantity"), 1).max(1);
        let from = js::string(field("from_actor_id"));
        let to = js::string(field("to_actor_id"));
        let mut updated = Vec::with_capacity(next.len());
        for actor in next {
            let id = actor_id(Some(&actor));
            if id == from {
                let mut items = Vec::new();
                for item in list(member(Some(&actor), "inventory")?)? {
                    if is_item(item, &wanted_item)? {
                        let mut next_item = spread(item);
                        next_item.insert("quantity".into(), json!((integer(item.get("quantity"), 1) - quantity).max(0)));
                        items.push(Value::Object(next_item));
                    } else {
                        items.push(item.clone());
                    }
                }
                let mut kept = Vec::new();
                for item in items {
                    if integer(member(Some(&item), "quantity")?, 0) > 0 {
                        kept.push(item);
                    }
                }
                updated.push(with_inventory(&actor, kept));
            } else if id == to {
                let incoming = normalize_inventory_item(field("item"), InventoryItemOptions { preserve_unknown: true, ..Default::default() });
                let incoming_key = inventory_stack_key(Some(&incoming));
                let mut stack_index = None;
                if !js::is_false(field("stackable")) {
                    for (index, item) in list(member(Some(&actor), "inventory")?)?.iter().enumerate() {
                        let equipped = member(Some(item), "equipped")?;
                        if !js::truthy(equipped) && !js::truthy(item.get("attuned_to")) && inventory_stack_key(Some(item)) == incoming_key {
                            stack_index = Some(index);
                            break;
                        }
                    }
                }
                let inventory = member(Some(&actor), "inventory")?;
                let items: Vec<Value> = match stack_index {
                    None => {
                        let mut items = iter_of(inventory)?.into_owned();
                        items.push(incoming);
                        items
                    }
                    Some(stack_index) => list(inventory)?
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            if index != stack_index {
                                return item.clone();
                            }
                            let mut next_item = spread(item);
                            next_item.insert("quantity".into(), json!(integer(item.get("quantity"), 1) + quantity));
                            Value::Object(next_item)
                        })
                        .collect(),
                };
                updated.push(with_inventory(&actor, items));
            } else {
                updated.push(actor);
            }
        }
        next = updated;
    }

    if is_str(event_type, "ItemChargesSpent") {
        let owner_id = event_owner(None, event);
        let charges = charge_state_from_event(payload);
        next = map_owner(next, &owner_id, |actor| {
            let mut items = Vec::new();
            for item in list(member(Some(actor), "inventory")?)? {
                if is_item(item, &wanted_item)? {
                    let mut next_item = spread(item);
                    next_item.insert("charges".into(), charges.clone());
                    items.push(Value::Object(next_item));
                } else {
                    items.push(item.clone());
                }
            }
            Ok(with_inventory(actor, items))
        })?;
    }

    if is_str(event_type, "ItemDestroyed") && schema_ok(ITEM_DESTROYED_EVENT_SCHEMA_VERSION) {
        let owner_id = event_owner(field("owner_id"), event);
        next = map_owner(next, &owner_id, |actor| {
            let mut items = Vec::new();
            for item in list(member(Some(actor), "inventory")?)? {
                if !is_item(item, &wanted_item)? {
                    items.push(item.clone());
                }
            }
            Ok(with_inventory(actor, items))
        })?;
    }

    if is_str(event_type, "MagicItemActivationChanged") && schema_ok(MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION) {
        let owner_id = event_owner(field("owner_id"), event);
        let activated = js::is_true(field("activated"));
        next = map_owner(next, &owner_id, |actor| {
            let mut items = Vec::new();
            for item in list(member(Some(actor), "inventory")?)? {
                if is_item(item, &wanted_item)? {
                    let mut next_item = spread(item);
                    next_item.insert("activated".into(), Value::Bool(activated));
                    items.push(Value::Object(next_item));
                } else {
                    items.push(item.clone());
                }
            }
            Ok(with_inventory(actor, items))
        })?;
    }
    Ok(Value::Array(next))
}
