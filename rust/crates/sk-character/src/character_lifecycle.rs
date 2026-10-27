//! Перенос `server/character-lifecycle.mjs`: жизненный цикл героя.
//!
//! Слот героя и его оформление, производный лист (`deriveCharacterSheet`:
//! характеристики, спасброски, навыки, КД, скорость, хиты, ресурсы класса),
//! проверка обязательных выборов поэтапного создания, повышение уровня,
//! строгий импорт листа (v1 и миграция v0) и чистый редьюсер событий
//! `CharacterLeveledUp` / `CharacterImported`.
//!
//! Модуль не знает Rules Engine: адаптер проверяет команду (`validate_*`),
//! строит событие (`level_up_event`, `character_import_event`) и проводит его
//! через [`apply_character_lifecycle_event`]; браузер не распоряжается ни
//! хитами, ни КД, ни скоростью, ни ресурсами.
//!
//! Входы — `serde_json::Value` той же формы, что в JS; опции JS (`options`) —
//! тоже объектом JS, кроме опций импорта ([`ImportOptions`]).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_chargen::character_creation_wealth::{phb_starting_wealth_json, resolve_starting_purchases, starting_purchase_catalog, PHB_STARTING_WEALTH};
use sk_chargen::starter_kit::{
    complete_background_choices_for_hero, default_starter_equipment_choices, resolve_starter_equipment_choices, starter_equipment_catalog_for, starter_kit_2024_preview,
    validate_complete_background_choices, with_starter_kit, StarterKitError, StarterKitOptions, STARTER_KIT_2024_POLICY,
};
use sk_combat_content::combat_actions::{
    combat_class_catalog_info, combat_resource_maximums_for, combat_resource_recovery_for, normalized_combat_subclass_for, ClassResourceOptions, ONE_ON_SHORT_REST,
};
use sk_combat_content::combat_spells::{combat_spells_for, normalized_spell_selections_for, spell_selection_rules_for, spell_slot_maximums_for};
use sk_core::{js, text};
use sk_heroes::character_creation_phb::{phb_creation_catalog, phb_first_level_spells, resolve_phb_creation, PhbCreationError, PHB_FIGHTING_STYLES};
use sk_items::item_catalog::ITEM_ARMOR_PROFILES;
use sk_items_life::item_lifecycle::{active_item_effect_totals, ItemLifecycleError};
use sk_ruleset::backgrounds::{
    background_by_id, background_catalog_for, default_background_choices, resolve_background_ability_choice, resolve_background_choices, resolve_background_customization,
    with_background_benefits, BackgroundError,
};
use sk_ruleset::character_creation_catalog::{
    character_creation_policy_for, default_species_choices, origin_bonus_profile_for, resolve_species_choices, species_benefits_for, species_option_for,
    validate_species_origin_bonuses,
};
use sk_ruleset::character_creation_class_options::class_option_for;
use sk_ruleset::character_progression::{
    ability_score_choice_levels_for, catalog_skill_id, character_class_key, class_build_catalog_info, class_skill_rule_for, feature_choice_groups_for,
    normalized_class_skill_proficiencies, normalized_selected_feature_ids, skill_ability,
};
use sk_ruleset::ruleset_config::{RulesetSelectionError, DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID};

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

pub const CHARACTER_LIFECYCLE_SCHEMA_VERSION: i64 = 1;
pub const CHARACTER_IMPORT_SCHEMA: &str = "skazanie.character";
pub const CHARACTER_IMPORT_SCHEMA_VERSION: i64 = 1;
pub const CHARACTER_LIFECYCLE_COMMAND_TYPES: [&str; 4] = ["LevelUp", "ImportCharacter", "RollCharacterAbilities", "RollCharacterWealth"];
pub const CHARACTER_LIFECYCLE_EVENT_TYPES: [&str; 2] = ["CharacterLeveledUp", "CharacterImported"];

pub const ABILITY_IDS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
pub const SKILL_IDS: [&str; 18] = [
    "acrobatics",
    "animal_handling",
    "arcana",
    "athletics",
    "deception",
    "history",
    "insight",
    "intimidation",
    "investigation",
    "medicine",
    "nature",
    "perception",
    "performance",
    "persuasion",
    "religion",
    "sleight_of_hand",
    "stealth",
    "survival",
];

/// Пороги опыта 2014/SRD, урезанные до 12-го уровня, который исполняет
/// каталог классов: `EXPERIENCE_THRESHOLDS[level]`.
pub const EXPERIENCE_THRESHOLDS: [(i64, i64); 12] = [
    (1, 0),
    (2, 300),
    (3, 900),
    (4, 2_700),
    (5, 6_500),
    (6, 14_000),
    (7, 23_000),
    (8, 34_000),
    (9, 48_000),
    (10, 64_000),
    (11, 85_000),
    (12, 100_000),
];

pub const MAX_CHARACTER_LEVEL: i64 = 12;

/// `DERIVED_CHARACTER_POLICY`.
pub static DERIVED_CHARACTER_POLICY: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "maximumLevel": MAX_CHARACTER_LEVEL,
        "proficiency": "2 + floor((level - 1) / 4)",
        "hitPoints": "level 1 uses the maximum hit die; later levels use a recorded dN roll or the fixed average, then add CON with a minimum of 1 per level",
        "armorClass": "only equipped items resolved through a server-owned armor profile affect AC; otherwise the class unarmored rule applies",
        "speed": "base_speed minus server-owned equipped armor penalties; the browser-supplied speed field is ignored",
        "imports": "v1 excludes id, current/max HP, AC, proficiency, inventory, currency, resources, and all derived fields",
    })
});

/// `POINT_BUY_COSTS`: цена значения характеристики при покупке.
pub const POINT_BUY_COSTS: [(i64, i64); 8] = [(8, 0), (9, 1), (10, 2), (11, 3), (12, 4), (13, 5), (14, 7), (15, 9)];

pub const PARTY_PORTRAIT_SHEET: &str = "/assets/party-portraits.png";
pub const PARTY_PORTRAIT_POSITIONS: [&str; 4] = ["0% 0%", "100% 0%", "0% 100%", "100% 100%"];
pub const PARTY_TOKEN_COLORS: [&str; 4] = ["#d79b5b", "#758f78", "#8b789e", "#9a745d"];

const MAX_LEVEL: i64 = MAX_CHARACTER_LEVEL;
const MAX_EXPERIENCE: i64 = 2_000_000_000;
const MAX_SAFE: i64 = 9_007_199_254_740_991;
const DEFAULT_BASE_SPEED: i64 = 30;
const UNCLAIMED_CHARACTER_ROLE: &str = "Герой ещё не создан · ур. 1";
const DEFAULT_SOURCE_RULE: &str = "srd_5_2_1:resources:spending";

const HIT_DICE: [(&str, i64); 12] = [
    ("barbarian", 12),
    ("bard", 8),
    ("cleric", 8),
    ("druid", 8),
    ("fighter", 10),
    ("monk", 8),
    ("paladin", 10),
    ("ranger", 10),
    ("rogue", 8),
    ("sorcerer", 6),
    ("warlock", 8),
    ("wizard", 6),
];

const SAVING_THROW_PROFICIENCIES: [(&str, [&str; 2]); 12] = [
    ("barbarian", ["str", "con"]),
    ("bard", ["dex", "cha"]),
    ("cleric", ["wis", "cha"]),
    ("druid", ["int", "wis"]),
    ("fighter", ["str", "con"]),
    ("monk", ["str", "dex"]),
    ("paladin", ["wis", "cha"]),
    ("ranger", ["str", "dex"]),
    ("rogue", ["dex", "int"]),
    ("sorcerer", ["con", "cha"]),
    ("warlock", ["wis", "cha"]),
    ("wizard", ["int", "wis"]),
];

const ABILITY_GENERATION_FIELDS: [&str; 8] = ["policyId", "policyVersion", "method", "baseScores", "originBonusProfileId", "originBonuses", "speciesOptionId", "rollId"];

const IMPORT_TOP_LEVEL_V1: [&str; 3] = ["schema", "schema_version", "character"];
const IMPORT_CHARACTER_V1: [&str; 30] = [
    "phbCreation",
    "character",
    "name",
    "role",
    "characterClass",
    "subclass",
    "species",
    "background",
    "alignment",
    "traits",
    "ideals",
    "bonds",
    "flaws",
    "backstory",
    "notes",
    "level",
    "experience",
    "abilities",
    "abilityGeneration",
    "baseSpeed",
    "hitPointIncreases",
    "classSkillProficiencies",
    "selectedFeatureIds",
    "knownSpellIds",
    "preparedSpellIds",
    "backgroundId",
    "backgroundAbilityChoice",
    "backgroundChoices",
    "speciesChoices",
    "starterEquipmentChoices",
];
const IMPORT_V0_ALIASES: [(&str, &str); 8] = [
    ("character_class", "characterClass"),
    ("ability_generation", "abilityGeneration"),
    ("base_speed", "baseSpeed"),
    ("hit_point_increases", "hitPointIncreases"),
    ("class_skill_proficiencies", "classSkillProficiencies"),
    ("selected_feature_ids", "selectedFeatureIds"),
    ("known_spell_ids", "knownSpellIds"),
    ("prepared_spell_ids", "preparedSpellIds"),
];

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/// Исключение модуля: `CharacterLifecycleValidationError` (код и текст) или
/// пропущенное насквозь исключение модуля ниже (`RulesetSelectionError`,
/// `TypeError`, `ItemLifecycleValidationError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterLifecycleError {
    /// Имя класса исключения JS.
    pub name: &'static str,
    pub code: Option<String>,
    pub message: String,
    /// Текст — сообщение `TypeError` рантайма V8 (обращение к полю `null`,
    /// распаковка неитерируемого) или обёрнутое в отказ модуля; Rust его
    /// дословно не повторяет.
    pub runtime_message: bool,
}

pub const VALIDATION_ERROR: &str = "CharacterLifecycleValidationError";

impl CharacterLifecycleError {
    pub fn invalid(message: impl Into<String>, code: &str) -> Self {
        Self { name: VALIDATION_ERROR, code: Some(code.into()), message: message.into(), runtime_message: false }
    }

    fn type_error(message: impl Into<String>, runtime: bool) -> Self {
        Self { name: "TypeError", code: None, message: message.into(), runtime_message: runtime }
    }

    fn runtime(message: impl Into<String>) -> Self {
        Self::type_error(message, true)
    }

    /// `catch (error) { throw new CharacterLifecycleValidationError(error.message, code) }`.
    fn wrapped(self, code: &str) -> Self {
        Self { name: VALIDATION_ERROR, code: Some(code.into()), message: self.message, runtime_message: self.runtime_message }
    }

    /// `throw new Error(message)` внутри `try`, который его заворачивает.
    fn plain(message: impl Into<String>) -> Self {
        Self { name: "Error", code: None, message: message.into(), runtime_message: false }
    }

    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    /// `error instanceof CharacterLifecycleValidationError`.
    pub fn is_validation(&self) -> bool {
        self.name == VALIDATION_ERROR
    }
}

impl std::fmt::Display for CharacterLifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CharacterLifecycleError {}

impl From<RulesetSelectionError> for CharacterLifecycleError {
    fn from(error: RulesetSelectionError) -> Self {
        Self { name: "RulesetSelectionError", code: Some(error.code), message: error.message, runtime_message: false }
    }
}

impl From<BackgroundError> for CharacterLifecycleError {
    fn from(error: BackgroundError) -> Self {
        match error {
            BackgroundError::Ruleset(error) => error.into(),
            BackgroundError::Type(message) => Self::type_error(message, false),
            BackgroundError::Runtime(message) => Self::runtime(message),
        }
    }
}

impl From<PhbCreationError> for CharacterLifecycleError {
    fn from(error: PhbCreationError) -> Self {
        match error {
            PhbCreationError::Invalid(message) => Self::type_error(message, false),
            PhbCreationError::Runtime(message) => Self::runtime(message),
        }
    }
}

impl From<StarterKitError> for CharacterLifecycleError {
    fn from(error: StarterKitError) -> Self {
        match error {
            StarterKitError::Type(message) => Self::type_error(message, false),
            StarterKitError::Runtime(message) => Self::runtime(message),
        }
    }
}

impl From<ItemLifecycleError> for CharacterLifecycleError {
    fn from(error: ItemLifecycleError) -> Self {
        match error {
            ItemLifecycleError::Validation { message, code } => Self { name: "ItemLifecycleValidationError", code: Some(code), message, runtime_message: false },
            ItemLifecycleError::Type(message) => Self::runtime(message),
        }
    }
}

pub type LifecycleResult<T> = Result<T, CharacterLifecycleError>;

/// Отказ `assertActorAuthority` по умолчанию — для повышения уровня.
const LEVEL_UP_FORBIDDEN: &str = "Повысить уровень может только владелец героя";

fn invalid<T>(message: impl Into<String>, code: &str) -> LifecycleResult<T> {
    Err(CharacterLifecycleError::invalid(message, code))
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

/// `value?.[key]` для объекта; у прочего — `undefined`.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `value?.a?.b…`.
fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |current, key| Some(prop(current, key))).flatten()
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

/// Поле, без `null`: `value ?? undefined`.
fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `{ ...value }`.
fn spread_of(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.encode_utf16().enumerate().map(|(index, unit)| (index.to_string(), Value::String(String::from_utf16_lossy(&[unit])))).collect(),
        _ => Map::new(),
    }
}

/// Производные поля героя, которые лист не читает.
const DERIVED_ACTOR_FIELDS: [&str; 4] = ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"];

/// [`spread_of`] героя без копий производных полей: ключ остаётся на своём
/// месте со значением `null`.
fn spread_without_derived(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.iter().map(|(key, item)| (key.clone(), if DERIVED_ACTOR_FIELDS.contains(&key.as_str()) { Value::Null } else { item.clone() })).collect(),
        other => spread_of(other),
    }
}

/// `value === expected` для строки.
fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `a === b` над значениями JSON: объекты и массивы различны всегда
/// (сравнение ссылок), числа — по величине.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `Math.max(a, b)` с `NaN`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)` с `NaN`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `text.slice(0, limit)` по кодовым единицам UTF-16 (половинка суррогатной
/// пары на границе отбрасывается — в Rust её не представить).
fn utf16_head(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > limit {
            break;
        }
        result.push(ch);
    }
    result
}

/// `cleanText(value, maximum)`: `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
fn clean_text(value: Option<&Value>, maximum: usize) -> String {
    utf16_head(text::trim(&text::nfkc(&js::s(value))), maximum)
}

/// Свойство-ключ JS (`ToPropertyKey`) для поиска `object[key]`.
fn property_key(value: Option<&Value>) -> String {
    js::string(value)
}

/// `[...value]`: массив — как есть, строка — по символам (кодовым точкам),
/// `null`/`undefined` → по месту вызова; прочее — `TypeError`.
fn iterate(value: &Value, what: &str) -> LifecycleResult<Vec<Value>> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        _ => Err(CharacterLifecycleError::runtime(format!("{what} is not iterable"))),
    }
}

/// `(value ?? []).includes(item)` по JS: у массива — строгое равенство
/// элемента, у строки — подстрока; у прочего метода нет (`TypeError`).
fn includes_or_empty(value: Option<&Value>, item: &str, what: &str) -> LifecycleResult<bool> {
    match defined(value) {
        None => Ok(false),
        Some(Value::Array(items)) => Ok(items.iter().any(|entry| is_str(Some(entry), item))),
        Some(Value::String(text)) => Ok(text.contains(item)),
        Some(_) => Err(CharacterLifecycleError::runtime(format!("{what}.includes is not a function"))),
    }
}

fn array_of(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn int(value: i64) -> Value {
    Value::from(value)
}

/// Вставка поля, которое JS кладёт как `undefined` при отсутствии значения.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `integer(value, field, { minimum, maximum, fallback })`.
fn integer(value: Option<&Value>, field: &str, minimum: i64, maximum: i64, fallback: Option<&Value>) -> LifecycleResult<i64> {
    let candidate = if !js::present(value) && fallback.is_some() { fallback } else { value };
    let result = js::number(candidate);
    let safe = result.is_finite() && result.fract() == 0.0 && result.abs() <= MAX_SAFE as f64;
    if !safe || result < minimum as f64 || result > maximum as f64 {
        return invalid(format!("{field} должен быть целым числом от {minimum} до {maximum}"), "INVALID_CHARACTER_VALUE");
    }
    Ok(result as i64)
}

fn is_identifier(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 120 {
        return false;
    }
    let head = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    head(bytes[0]) && bytes[1..].iter().all(|&byte| head(byte) || byte == b'_' || byte == b'-')
}

/// `cleanIdentifier(value, field)`.
fn clean_identifier(value: Option<&Value>, field: &str) -> LifecycleResult<String> {
    let result = clean_text(value, 120);
    if result.is_empty() || !is_identifier(&result) {
        return invalid(format!("{field} должен быть непустым идентификатором"), "INVALID_IDENTIFIER");
    }
    Ok(result)
}

fn same_string_set(left: &[String], right: &[String]) -> bool {
    left.len() == right.len() && left.iter().all(|entry| right.contains(entry))
}

/// `exactKeys(record, allowed, label)`.
fn exact_keys(record: Option<&Value>, allowed: &[&str], label: &str) -> LifecycleResult<()> {
    let Some(Value::Object(map)) = record else {
        return invalid(format!("{label} должен быть объектом"), "IMPORT_INVALID_SHAPE");
    };
    let unexpected: Vec<&str> = js::keys(map).into_iter().filter(|key| !allowed.contains(&key.as_str())).map(String::as_str).collect();
    if !unexpected.is_empty() {
        return invalid(format!("{label} содержит неподдерживаемые поля: {}", unexpected.join(", ")), "IMPORT_UNKNOWN_FIELD");
    }
    Ok(())
}

/// `uniqueIdentifiers(value, field, { maximum })`.
fn unique_identifiers(value: Option<&Value>, field: &str, maximum: usize) -> LifecycleResult<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return invalid(format!("{field} должен быть массивом"), "IMPORT_INVALID_FIELD");
    };
    if items.len() > maximum {
        return invalid(format!("{field} превышает лимит {maximum}"), "IMPORT_LIMIT_EXCEEDED");
    }
    let result = items.iter().map(|entry| clean_identifier(Some(entry), field)).collect::<LifecycleResult<Vec<_>>>()?;
    if result.iter().collect::<HashSet<_>>().len() != result.len() {
        return invalid(format!("{field} содержит повторяющиеся значения"), "IMPORT_DUPLICATE_VALUE");
    }
    Ok(result)
}

fn unique_in_order(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

/// `value ?? []` — массив строк (элементы через `String`).
fn catalog_skill_ids(value: Option<&Value>) -> Vec<String> {
    array_of(value).iter().map(|entry| catalog_skill_id(Some(entry))).collect()
}

// ---------------------------------------------------------------------------
// Уровень, характеристики, кость хитов
// ---------------------------------------------------------------------------

fn normalized_level(value: Option<&Value>) -> LifecycleResult<i64> {
    integer(value, "level", 1, MAX_LEVEL, Some(&json!(1)))
}

/// `abilityModifier(score)`.
pub fn ability_modifier(score: Option<&Value>) -> LifecycleResult<i64> {
    Ok((integer(score, "ability score", 1, 30, Some(&json!(10)))? - 10).div_euclid(2))
}

fn modifier_of(score: i64) -> i64 {
    (score - 10).div_euclid(2)
}

/// `proficiencyBonusForLevel(level)`.
pub fn proficiency_bonus_for_level(level: Option<&Value>) -> LifecycleResult<i64> {
    Ok(2 + (normalized_level(level)? - 1).div_euclid(4))
}

fn threshold(level: i64) -> i64 {
    EXPERIENCE_THRESHOLDS.iter().find(|(entry, _)| *entry == level).map_or(0, |(_, xp)| *xp)
}

/// `experienceForLevel(level)`.
pub fn experience_for_level(level: Option<&Value>) -> LifecycleResult<i64> {
    Ok(threshold(normalized_level(level)?))
}

/// `levelForExperience(experience)`.
pub fn level_for_experience(experience: Option<&Value>) -> LifecycleResult<i64> {
    let xp = integer(experience, "experience", 0, MAX_EXPERIENCE, Some(&json!(0)))?;
    Ok(EXPERIENCE_THRESHOLDS.iter().rev().find(|(_, threshold)| xp >= *threshold).map_or(1, |(level, _)| *level))
}

fn class_key(actor: Option<&Value>) -> Option<String> {
    character_class_key(actor)
}

/// `hitDieFor(actor)`.
pub fn hit_die_for(actor: Option<&Value>) -> i64 {
    let key = class_key(actor);
    HIT_DICE.iter().find(|(class, _)| Some(*class) == key.as_deref()).map_or(8, |(_, die)| *die)
}

/// `savingThrowProficienciesFor(actor)`.
pub fn saving_throw_proficiencies_for(actor: Option<&Value>) -> Vec<String> {
    let key = class_key(actor);
    SAVING_THROW_PROFICIENCIES
        .iter()
        .find(|(class, _)| Some(*class) == key.as_deref())
        .map(|(_, saves)| saves.iter().map(|save| save.to_string()).collect())
        .unwrap_or_default()
}

/// Характеристики героя в порядке [`ABILITY_IDS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Abilities(pub [i64; 6]);

impl Abilities {
    pub fn get(&self, ability: &str) -> i64 {
        ABILITY_IDS.iter().position(|id| *id == ability).map_or(10, |index| self.0[index])
    }

    pub fn to_value(&self) -> Value {
        Value::Object(ABILITY_IDS.iter().zip(self.0).map(|(id, score)| (id.to_string(), int(score))).collect())
    }
}

fn normalized_abilities(input: Option<&Value>) -> LifecycleResult<Abilities> {
    if js::present(input) && !js::is_plain(input) {
        return invalid("abilities должен быть объектом", "INVALID_ABILITIES");
    }
    if js::present(input) {
        exact_keys(input, &ABILITY_IDS, "abilities")?;
    }
    let mut scores = [10; 6];
    for (index, ability) in ABILITY_IDS.iter().enumerate() {
        scores[index] = integer(prop(input, ability), &format!("abilities.{ability}"), 1, 30, Some(&json!(10)))?;
    }
    Ok(Abilities(scores))
}

/// `normalizedAbilityScores(input)`.
pub fn normalized_ability_scores(input: Option<&Value>) -> LifecycleResult<Value> {
    normalized_abilities(input).map(|abilities| abilities.to_value())
}

/// `abilityScoreMap(input, field, { minimum, maximum })`.
fn ability_score_map(input: Option<&Value>, field: &str, minimum: i64, maximum: i64) -> LifecycleResult<Abilities> {
    if !js::is_plain(input) {
        return invalid(format!("{field} должен быть объектом"), "IMPORT_ABILITY_BUDGET_INVALID");
    }
    exact_keys(input, &ABILITY_IDS, field)?;
    let mut scores = [0; 6];
    for (index, ability) in ABILITY_IDS.iter().enumerate() {
        scores[index] = integer(prop(input, ability), &format!("{field}.{ability}"), minimum, maximum, None)?;
    }
    Ok(Abilities(scores))
}

fn sorted_numbers(values: &[f64]) -> Vec<f64> {
    let mut values = values.to_vec();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values
}

fn numbers_json(values: &[f64]) -> String {
    js::stringify(&Value::Array(values.iter().map(|value| js::num(*value)).collect()))
}

/// `JSON.stringify([...(roll?.scores ?? [])].sort((a, b) => a - b)) === JSON.stringify(expected)`.
fn trusted_scores_match(roll: Option<&Value>, expected: &[f64]) -> LifecycleResult<bool> {
    let scores = match defined(prop(roll, "scores")) {
        None => Vec::new(),
        Some(value) => iterate(value, "trustedAbilityRoll.scores")?,
    };
    let numbers: Option<Vec<f64>> = scores.iter().map(|score| score.as_f64()).collect();
    let Some(numbers) = numbers else {
        // Хоть один элемент — не число: строка JSON заведомо другая.
        return Ok(false);
    };
    Ok(numbers_json(&sorted_numbers(&numbers)) == numbers_json(expected))
}

struct AbilityGenerationOptions<'a> {
    allow_legacy_ability_policy: bool,
    ruleset_id: &'a str,
    trusted_ability_roll: Option<&'a Value>,
    /// `additionalAbilityBonuses`: `None` — не передано (`{}`).
    additional_ability_bonuses: Option<&'a Value>,
}

/// `validateAbilityGeneration(source, abilities, options)`.
fn validate_ability_generation(source: Option<&Value>, abilities: &Abilities, options: &AbilityGenerationOptions<'_>) -> LifecycleResult<Option<Value>> {
    let ruleset_id = options.ruleset_id;
    let policy = character_creation_policy_for(ruleset_id)?;
    if !js::is_plain(source) {
        if options.allow_legacy_ability_policy {
            return Ok(None);
        }
        return invalid("Импорт должен явно указывать versioned policy генерации характеристик", "IMPORT_ABILITY_POLICY_REQUIRED");
    }
    exact_keys(source, &ABILITY_GENERATION_FIELDS, "character.abilityGeneration")?;
    let field = |key: &str| prop(source, key);
    let policy_id = policy.get("policy_id");
    let policy_version = js::number(policy.get("policy_version"));
    let policy_method = policy.get("method");
    let is_2014 = ruleset_id == DND_2014_RULESET_ID;
    let legacy_classic_policy = options.allow_legacy_ability_policy
        && is_2014
        && strict_eq(field("policyId"), policy_id)
        && js::number(field("policyVersion")) == 1.0
        && strict_eq(field("method"), policy_method);
    let method_allowed = if is_2014 {
        ["standard_array", "point_buy", "rolled"].iter().any(|method| is_str(field("method"), method))
    } else {
        strict_eq(field("method"), policy_method)
    };
    if !legacy_classic_policy && (!strict_eq(field("policyId"), policy_id) || js::number(field("policyVersion")) != policy_version || !method_allowed) {
        return invalid("Импорт использует неподдерживаемую policy генерации характеристик", "IMPORT_ABILITY_POLICY_UNSUPPORTED");
    }
    let base_scores = ability_score_map(field("baseScores"), "character.abilityGeneration.baseScores", 1, 30)?;
    let standard: Vec<f64> = array_of(policy.get("standard_array")).iter().map(|value| js::number(Some(value))).collect();
    let expected_array = sorted_numbers(&standard);
    let actual_array = sorted_numbers(&base_scores.0.map(|score| score as f64));
    if is_str(field("method"), "point_buy") {
        let cost = base_scores.0.iter().fold(0.0, |sum, score| sum + POINT_BUY_COSTS.iter().find(|(value, _)| value == score).map_or(f64::INFINITY, |(_, cost)| *cost as f64));
        if cost > 27.0 {
            return invalid("Покупка характеристик: значения 8–15, бюджет не больше 27 очков", "IMPORT_ABILITY_BUDGET_INVALID");
        }
    } else if is_str(field("method"), "rolled") {
        if !js::truthy(field("rollId")) || base_scores.0.iter().any(|score| *score < 3 || *score > 18) {
            return invalid("Для бросков характеристик нужен серверный результат 4к6", "IMPORT_ABILITY_ROLL_REQUIRED");
        }
        if !options.allow_legacy_ability_policy
            && (!strict_eq(prop(options.trusted_ability_roll, "id"), field("rollId")) || !trusted_scores_match(options.trusted_ability_roll, &actual_array)?)
        {
            return invalid("Распределение не совпадает с сохранёнными серверными бросками этого героя", "IMPORT_ABILITY_ROLL_INVALID");
        }
    } else if numbers_json(&actual_array) != numbers_json(&expected_array) {
        let joined = array_of(policy.get("standard_array")).iter().map(|value| js::s(Some(value))).collect::<Vec<_>>().join(", ");
        return invalid(format!("Базовые характеристики должны быть распределением стандартного массива {joined}"), "IMPORT_ABILITY_BUDGET_INVALID");
    }
    let Some(bonus_profile) = origin_bonus_profile_for(&js::s(field("originBonusProfileId")), ruleset_id)? else {
        return invalid("Неизвестный профиль бонусов происхождения", "IMPORT_ABILITY_POLICY_UNSUPPORTED");
    };
    let origin_bonuses = ability_score_map(field("originBonuses"), "character.abilityGeneration.originBonuses", 0, 10)?;
    let expected_bonuses = sorted_numbers(&array_of(bonus_profile.get("bonuses")).iter().map(|value| js::number(Some(value))).collect::<Vec<_>>());
    let actual_bonuses = sorted_numbers(&origin_bonuses.0.iter().filter(|value| **value != 0).map(|value| *value as f64).collect::<Vec<_>>());
    if numbers_json(&actual_bonuses) != numbers_json(&expected_bonuses) {
        return invalid("Бонусы происхождения не соответствуют выбранному серверному профилю", "IMPORT_ABILITY_BUDGET_INVALID");
    }
    let Some(species_option) = species_option_for(&js::s(field("speciesOptionId")), ruleset_id)? else {
        return invalid("Выбран неподдерживаемый вид персонажа", "IMPORT_SPECIES_UNSUPPORTED");
    };
    let additional = |ability: &str| -> LifecycleResult<f64> {
        match options.additional_ability_bonuses {
            None => Ok(0.0),
            Some(Value::Null) => Err(CharacterLifecycleError::runtime(format!("Cannot read properties of null (reading '{ability}')"))),
            Some(value) => Ok(js::number(Some(nullish(prop(Some(value), ability), Some(&json!(0))).unwrap_or(&json!(0))))),
        }
    };
    for (index, ability) in ABILITY_IDS.iter().enumerate() {
        let expected = js_min(20.0, (base_scores.0[index] + origin_bonuses.0[index]) as f64 + additional(ability)?);
        if abilities.0[index] as f64 != expected {
            return invalid("Итоговые характеристики не совпадают с базовым массивом и явными бонусами происхождения", "IMPORT_ABILITY_BUDGET_INVALID");
        }
    }
    let species_id = js::s(species_option.get("id"));
    let species_validation = validate_species_origin_bonuses(&species_id, bonus_profile.get("id"), Some(&origin_bonuses.to_value()), ruleset_id)?;
    if !js::truthy(species_validation.get("ok")) {
        return invalid(js::s(species_validation.get("reason")), "IMPORT_SPECIES_ABILITY_INVALID");
    }
    let mut result = Map::new();
    put(&mut result, "policyId", policy_id);
    result.insert("policyVersion".into(), if legacy_classic_policy { int(1) } else { policy.get("policy_version").cloned().unwrap_or(Value::Null) });
    put(&mut result, "method", field("method"));
    if is_str(field("method"), "rolled") {
        result.insert("rollId".into(), Value::String(js::string(field("rollId"))));
    }
    result.insert("baseScores".into(), base_scores.to_value());
    put(&mut result, "originBonusProfileId", bonus_profile.get("id"));
    result.insert("originBonuses".into(), origin_bonuses.to_value());
    put(&mut result, "speciesOptionId", species_option.get("id"));
    Ok(Some(Value::Object(result)))
}

// ---------------------------------------------------------------------------
// Каталог создания
// ---------------------------------------------------------------------------

/// `characterCreationCatalog(rulesetId)`: каталог мастера создания героя.
pub fn character_creation_catalog(ruleset_id: &str) -> LifecycleResult<Value> {
    let policy = character_creation_policy_for(ruleset_id)?;
    let is_2014 = ruleset_id == DND_2014_RULESET_ID;
    let backgrounds = background_catalog_for(ruleset_id)?;
    let class_build = class_build_catalog_info();
    let class_combat = combat_class_catalog_info();
    let starter_equipment = starter_equipment_catalog_for(ruleset_id, is_2014);
    let mut starter_by_class: HashMap<String, Value> = HashMap::new();
    for entry in array_of(path(starter_equipment.as_ref(), &["classes"])) {
        starter_by_class.insert(js::string(entry.get("class_id")), entry.clone());
    }
    let skills = array_of(class_build.get("skills"));
    let mut skills_by_id: HashMap<String, &Value> = HashMap::new();
    for skill in skills {
        skills_by_id.insert(js::string(skill.get("id")), skill);
    }
    let phb_spells = if is_2014 { phb_first_level_spells()? } else { Vec::new() };
    let standard = array_of(policy.get("standard_array"));
    let mut classes = Vec::new();
    for class_option in array_of(class_combat.get("classes")) {
        let key = js::s(class_option.get("classKey"));
        let mut actor_abilities = Map::new();
        for (index, ability) in ABILITY_IDS.iter().enumerate() {
            put(&mut actor_abilities, ability, standard.get(index));
        }
        let actor = json!({ "characterClass": class_option.get("classKey").cloned().unwrap_or(Value::Null), "level": 1, "abilities": actor_abilities });
        let skill_rule = class_skill_rule_for(Some(&actor));
        let spell_rules = spell_selection_rules_for(Some(&actor));
        let available_spells: Vec<Value> = match spell_rules {
            None => Vec::new(),
            Some(_) if is_2014 => phb_spells.iter().filter(|spell| array_of(spell.get("classes")).iter().any(|entry| is_str(Some(entry), &key))).cloned().collect(),
            Some(_) => combat_spells_for(Some(&actor), Some(&json!({ "rulesetId": ruleset_id }))).into_iter().filter(|spell| js::number(spell.get("level")) <= 1.0).collect(),
        };
        let phb_class = if is_2014 { class_option_for(class_option.get("classKey")) } else { None };
        let subclasses = match &phb_class {
            Some(phb) if js::number(phb.get("subclass_level")) == 1.0 && phb.get("subclass_level").is_some_and(Value::is_number) => Value::Array(
                array_of(phb.get("subclass_options"))
                    .iter()
                    .map(|entry| {
                        let mut item = Map::new();
                        put(&mut item, "id", entry.get("id"));
                        put(&mut item, "name", entry.get("label"));
                        Value::Object(item)
                    })
                    .collect(),
            ),
            _ => class_option.get("subclassOptions").cloned().unwrap_or(Value::Null),
        };
        let class_skills = match &skill_rule {
            Some(rule) => {
                let options: Vec<Value> = array_of(rule.get("skills"))
                    .iter()
                    .filter_map(|id| skills_by_id.get(&js::string(Some(id))).map(|skill| (*skill).clone()))
                    .filter(|skill| js::truthy(Some(skill)))
                    .collect();
                let mut item = Map::new();
                put(&mut item, "choice_count", rule.get("choiceCount"));
                item.insert("options".into(), Value::Array(options));
                Value::Object(item)
            }
            None => Value::Null,
        };
        let fighter_filter = phb_class.is_some() && key == "fighter";
        let feature_choice_groups: Vec<Value> = feature_choice_groups_for(Some(&actor))
            .into_iter()
            .map(|group| {
                let mut group = spread_of(Some(&group));
                if fighter_filter {
                    let options: Vec<Value> = array_of(group.get("options"))
                        .iter()
                        .filter(|entry| {
                            let id = property_key(entry.get("id"));
                            PHB_FIGHTING_STYLES.iter().any(|(style, _)| *style == id)
                        })
                        .cloned()
                        .collect();
                    group.insert("options".into(), Value::Array(options));
                } else if let Some(options) = group.get("options").cloned() {
                    group.insert("options".into(), options);
                }
                Value::Object(group)
            })
            .collect();
        let starter = starter_by_class.get(&key).cloned().or_else(|| if is_2014 { None } else { starter_kit_2024_preview(&key) }).unwrap_or(Value::Null);
        let spell_selection = match &spell_rules {
            Some(rules) => {
                let mut selection = spread_of(Some(&rules.to_value()));
                let ability = nullish(nullish(path(phb_class.as_ref(), &["spellcasting", "ability"]), available_spells.first().and_then(|spell| spell.get("spellcastingAbility"))), Some(&Value::Null))
                    .cloned()
                    .unwrap_or(Value::Null);
                selection.insert("spellcastingAbility".into(), ability);
                let spells: Vec<Value> = available_spells
                    .iter()
                    .map(|spell| {
                        let mut item = Map::new();
                        for (to, from) in [("id", "id"), ("name", "name"), ("level", "level"), ("description", "description"), ("casting_time", "castingTime"), ("range_text", "rangeText"), ("mechanics_support", "mechanicsSupport")] {
                            put(&mut item, to, spell.get(from));
                        }
                        Value::Object(item)
                    })
                    .collect();
                selection.insert("spells".into(), Value::Array(spells));
                Value::Object(selection)
            }
            None => Value::Null,
        };
        let mut entry = Map::new();
        put(&mut entry, "id", class_option.get("classKey"));
        put(&mut entry, "label", class_option.get("label"));
        put(&mut entry, "source_url", class_option.get("sourceUrl"));
        put(&mut entry, "subclass_level", class_option.get("subclassLevel"));
        // Предпросмотр мастера (хиты 1 уровня, спасброски) берёт числа отсюда,
        // а не из своей копии таблиц: лист всё равно пересчитывает сервер
        // (`server/character-lifecycle.mjs:398`, #190).
        entry.insert("hit_die".into(), int(hit_die_for(Some(&actor))));
        entry.insert("saving_throws".into(), json!(saving_throw_proficiencies_for(Some(&actor))));
        entry.insert("subclasses".into(), subclasses);
        entry.insert("class_skills".into(), class_skills);
        entry.insert("feature_choice_groups".into(), Value::Array(feature_choice_groups));
        entry.insert("starter_equipment".into(), starter);
        entry.insert("spell_selection".into(), spell_selection);
        classes.push(Value::Object(entry));
    }
    let mut catalog = Map::new();
    catalog.insert("schema_version".into(), int(1));
    put(&mut catalog, "ruleset_id", policy.get("ruleset_id"));
    put(&mut catalog, "edition_family", policy.get("edition_family"));
    catalog.insert("import_schema".into(), json!(CHARACTER_IMPORT_SCHEMA));
    catalog.insert("import_schema_version".into(), int(CHARACTER_IMPORT_SCHEMA_VERSION));
    catalog.insert("ability_policy".into(), policy.clone());
    catalog.insert("ability_methods".into(), if is_2014 { json!(["standard_array", "point_buy", "rolled"]) } else { json!(["standard_array"]) });
    let costs: Map<String, Value> = POINT_BUY_COSTS.iter().map(|(score, cost)| (score.to_string(), int(*cost))).collect();
    catalog.insert("point_buy".into(), json!({ "budget": 27, "costs": costs }));
    if is_2014 {
        catalog.insert("starting_wealth".into(), json!({ "formulas": phb_starting_wealth_json(), "items": starting_purchase_catalog() }));
        let mut phb = spread_of(Some(&phb_creation_catalog()?));
        let skill_names: Vec<Value> = skills
            .iter()
            .map(|skill| {
                let mut item = Map::new();
                put(&mut item, "id", skill.get("id"));
                put(&mut item, "name", skill.get("name"));
                Value::Object(item)
            })
            .collect();
        phb.insert("skills".into(), Value::Array(skill_names));
        catalog.insert("phb".into(), Value::Object(phb));
    }
    catalog.insert("backgrounds".into(), backgrounds);
    catalog.insert("starter_equipment".into(), starter_equipment.unwrap_or(Value::Null));
    catalog.insert("classes".into(), Value::Array(classes));
    Ok(Value::Object(catalog))
}

// ---------------------------------------------------------------------------
// Слот героя
// ---------------------------------------------------------------------------

/// `partyPresentationFor(index)`: цвет фишки и портрет по месту в отряде.
pub fn party_presentation_for(index: Option<&Value>) -> Value {
    let raw = js::number(Some(index.unwrap_or(&json!(0))));
    let raw = if raw.is_nan() || raw == 0.0 { 0.0 } else { raw };
    let slot = js_max(0.0, raw.trunc());
    let mut result = Map::new();
    if slot.is_finite() {
        let position = (slot % 4.0) as usize;
        result.insert("color".into(), json!(PARTY_TOKEN_COLORS[position]));
        result.insert("portrait".into(), json!(PARTY_PORTRAIT_SHEET));
        result.insert("portraitPosition".into(), json!(PARTY_PORTRAIT_POSITIONS[position]));
    } else {
        result.insert("portrait".into(), json!(PARTY_PORTRAIT_SHEET));
    }
    Value::Object(result)
}

/// `index + 1` по JS: строка склеивается, прочее складывается как число.
fn js_plus_one(index: &Value) -> Value {
    match index {
        Value::String(text) => Value::String(format!("{text}1")),
        Value::Array(_) | Value::Object(_) => Value::String(format!("{}1", js::s(Some(index)))),
        other => js::num(js::number(Some(other)) + 1.0),
    }
}

/// `createCharacterSlot({ id, index })`: пустое место героя до создания.
pub fn create_character_slot(id: Option<&Value>, index: Option<&Value>) -> LifecycleResult<Value> {
    let index = index.cloned().unwrap_or_else(|| json!(0));
    let next = js_plus_one(&index);
    let next_text = js::s(Some(&next));
    let generated = Value::String(format!("hero-slot-{next_text}"));
    let slot_id = clean_identifier(Some(defined(id).unwrap_or(&generated)), "character slot id")?;
    let policy = character_creation_policy_for(LEGACY_DEFAULT_RULESET_ID)?;
    let mut abilities = Map::new();
    for (position, ability) in ABILITY_IDS.iter().enumerate() {
        put(&mut abilities, ability, array_of(policy.get("standard_array")).get(position));
    }
    let mut slot = json!({
        "id": slot_id,
        "name": "Ожидает игрока",
        "character": format!("Место героя {next_text}"),
        "role": UNCLAIMED_CHARACTER_ROLE,
        "characterClass": "fighter",
        "level": 1,
        "experience": 0,
        "abilities": abilities,
        "baseSpeed": 30,
        "classSkillProficiencies": [],
        "selectedFeatureIds": [],
        "knownSpellIds": [],
        "preparedSpellIds": [],
        "hitPointIncreases": [],
        "species": "Не выбран",
        "background": "Не выбрано",
        "alignment": "Не определено",
        "traits": "",
        "ideals": "",
        "bonds": "",
        "flaws": "",
        "backstory": "",
        "features": "",
        "notes": "",
        "inventory": [],
        "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 },
    });
    if let (Some(map), Value::Object(presentation)) = (slot.as_object_mut(), party_presentation_for(Some(&index))) {
        for (key, value) in presentation {
            map.insert(key, value);
        }
        map.insert("initials".into(), Value::String(next_text));
        map.insert("online".into(), json!(false));
        map.insert("characterSetupRequired".into(), json!(true));
    }
    Ok(slot)
}

// ---------------------------------------------------------------------------
// Хиты, КД, скорость
// ---------------------------------------------------------------------------

fn normalized_base_speed(actor: Option<&Value>) -> LifecycleResult<i64> {
    integer(nullish(prop(actor, "baseSpeed"), prop(actor, "base_speed")), "base_speed", 5, 120, Some(&json!(DEFAULT_BASE_SPEED)))
}

fn fixed_hit_point_increase(hit_die: i64) -> i64 {
    hit_die.div_euclid(2) + 1
}

/// `normalizedHitPointIncreases(actor, { level, hitDie })`; `None` —
/// значение по умолчанию JS (уровень героя, кость его класса).
pub fn normalized_hit_point_increases(actor: Option<&Value>, level: Option<i64>, hit_die: Option<i64>) -> LifecycleResult<Vec<i64>> {
    let level = match level {
        Some(level) => level,
        None => normalized_level(prop(actor, "level"))?,
    };
    let hit_die = hit_die.unwrap_or_else(|| hit_die_for(actor));
    let raw = nullish(prop(actor, "hitPointIncreases"), prop(actor, "hit_point_increases"));
    let items = match defined(raw) {
        None => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return invalid("hit_point_increases должен быть массивом", "INVALID_HIT_POINT_HISTORY"),
    };
    if items.len() as i64 > (level - 1).max(0) {
        return invalid("hit_point_increases содержит больше уровней, чем герой уже получил", "INVALID_HIT_POINT_HISTORY");
    }
    items.iter().enumerate().map(|(index, entry)| integer(Some(entry), &format!("hit_point_increases.{index}"), 1, hit_die, None)).collect()
}

/// `deriveMaximumHitPoints(actor, { level, abilities })`.
pub fn derive_maximum_hit_points(actor: Option<&Value>, level: Option<i64>, abilities: Option<&Abilities>) -> LifecycleResult<Value> {
    let level = match level {
        Some(level) => level,
        None => normalized_level(prop(actor, "level"))?,
    };
    let abilities = match abilities {
        Some(abilities) => *abilities,
        None => normalized_abilities(prop(actor, "abilities"))?,
    };
    let hit_die = hit_die_for(actor);
    let constitution_modifier = modifier_of(abilities.get("con"));
    let increases = normalized_hit_point_increases(actor, Some(level), Some(hit_die))?;
    let per_level: Vec<i64> = (0..(level - 1).max(0) as usize).map(|index| increases.get(index).copied().unwrap_or_else(|| fixed_hit_point_increase(hit_die))).collect();
    let species_raw = js::number(path(actor, &["speciesBenefits", "mechanics", "extra_hit_points_per_level"]));
    let species_bonus = js_max(0.0, if species_raw.is_nan() || species_raw == 0.0 { 0.0 } else { species_raw });
    let creation_bonus = js::number(Some(nullish(path(actor, &["creationBenefits", "extra_hit_points_per_level"]), Some(&json!(0))).unwrap_or(&json!(0))));
    let con = constitution_modifier as f64;
    let first_level = js_max(1.0, hit_die as f64 + con + species_bonus + creation_bonus);
    let later: Vec<f64> = per_level.iter().map(|increase| js_max(1.0, *increase as f64 + con + species_bonus + creation_bonus)).collect();
    let value = first_level + later.iter().sum::<f64>();
    let mut result = Map::new();
    result.insert("value".into(), js::num(value));
    result.insert("hitDie".into(), int(hit_die));
    result.insert("constitutionModifier".into(), int(constitution_modifier));
    result.insert("levelOne".into(), js::num(first_level));
    result.insert("speciesBonusPerLevel".into(), js::num(species_bonus));
    result.insert("increases".into(), Value::Array(per_level.iter().map(|value| int(*value)).collect()));
    result.insert("policy".into(), json!(if increases.len() as i64 == level - 1 { "recorded_rolls" } else { "fixed_average_for_missing_levels" }));
    Ok(Value::Object(result))
}

fn normalized_armor_profiles(input: Option<&Value>) -> LifecycleResult<&Value> {
    match defined(input) {
        None => Ok(&ITEM_ARMOR_PROFILES),
        Some(value @ Value::Object(_)) => Ok(value),
        Some(_) => invalid("armorProfiles должен быть объектом", "INVALID_ARMOR_PROFILES"),
    }
}

struct ArmorEntry<'a> {
    catalog_id: String,
    profile: &'a Value,
}

/// `equippedArmorEntries(actor, armorProfiles)`. Профиль по ключу прототипа
/// (`__proto__` → `Object.prototype`) в JS — объект без полей, ни на что не
/// влияющий; здесь такой ключ просто не находится.
fn equipped_armor_entries<'a>(actor: Option<&Value>, profiles: &'a Value) -> Vec<ArmorEntry<'a>> {
    array_of(prop(actor, "inventory"))
        .iter()
        .filter_map(|item| {
            if !item.is_object() || !js::is_true(item.get("equipped")) {
                return None;
            }
            let catalog_id = clean_text(nullish(item.get("catalog_id"), item.get("catalogId")), 120);
            if catalog_id.is_empty() {
                return None;
            }
            let profile = profiles.get(&catalog_id).filter(|profile| profile.is_object())?;
            Some(ArmorEntry { catalog_id, profile })
        })
        .collect()
}

/// `deriveArmorClass(actor, { abilities, armorProfiles })`.
pub fn derive_armor_class(actor: Option<&Value>, abilities: Option<&Abilities>, armor_profiles: Option<&Value>) -> LifecycleResult<Value> {
    let abilities = match abilities {
        Some(abilities) => *abilities,
        None => normalized_abilities(prop(actor, "abilities"))?,
    };
    let profiles = normalized_armor_profiles(armor_profiles)?;
    let key = class_key(actor);
    let dexterity = modifier_of(abilities.get("dex")) as f64;
    let equipped = equipped_armor_entries(actor, profiles);
    let kind = |entry: &ArmorEntry<'_>, expected: &str| is_str(entry.profile.get("kind"), expected);
    let unarmored_base = if js::truthy(path(actor, &["creationBenefits", "unarmored_armor_class"])) {
        js::number(path(actor, &["creationBenefits", "unarmored_armor_class", "base"])) + dexterity
    } else if key.as_deref() == Some("barbarian") {
        10.0 + dexterity + modifier_of(abilities.get("con")) as f64
    } else if key.as_deref() == Some("monk") && !equipped.iter().any(|entry| kind(entry, "shield")) {
        10.0 + dexterity + modifier_of(abilities.get("wis")) as f64
    } else if key.as_deref() == Some("warlock") && normalized_selected_feature_ids(actor).iter().any(|id| id == "armor-of-shadows") {
        13.0 + dexterity
    } else {
        10.0 + dexterity
    };
    struct Body {
        catalog_id: String,
        base: i64,
        dexterity_cap: Option<i64>,
    }
    let mut bodies = Vec::new();
    for entry in equipped.iter().filter(|entry| kind(entry, "armor")) {
        let base = integer(entry.profile.get("armorClassBase"), &format!("armor profile {}.armorClassBase", entry.catalog_id), 1, 30, None)?;
        let cap = match defined(entry.profile.get("dexterityCap")) {
            None => None,
            Some(cap) => Some(integer(Some(cap), &format!("armor profile {}.dexterityCap", entry.catalog_id), -5, 10, None)?),
        };
        bodies.push(Body { catalog_id: entry.catalog_id.clone(), base, dexterity_cap: cap });
    }
    bodies.sort_by(|left, right| right.base.cmp(&left.base).then_with(|| text::locale_compare(&left.catalog_id, &right.catalog_id)));
    let body = bodies.into_iter().next();
    let mut shields: Vec<&ArmorEntry<'_>> = equipped.iter().filter(|entry| kind(entry, "shield")).collect();
    shields.sort_by(|left, right| text::locale_compare(&left.catalog_id, &right.catalog_id));
    shields.truncate(1);
    let level_feats = defined(prop(actor, "levelFeats"));
    let level_feat_ids: Vec<String> = match level_feats {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(_, value)| value).filter(|entry| entry.is_object() || entry.is_array()).map(|entry| js::s(defined(prop(Some(entry), "id")))).collect(),
        Some(Value::Array(items)) => items.iter().filter(|entry| entry.is_object() || entry.is_array()).map(|entry| js::s(defined(prop(Some(entry), "id")))).collect(),
        _ => Vec::new(),
    };
    let medium_armor_master = is_str(path(actor, &["creationBenefits", "feat", "id"]), "medium-armor-master") || level_feat_ids.iter().any(|id| id == "medium-armor-master");
    let armor_dexterity = match &body {
        None => 0.0,
        Some(body) if body.dexterity_cap == Some(0) => 0.0,
        Some(body) => {
            let cap = if medium_armor_master && body.dexterity_cap == Some(2) { 3.0 } else { body.dexterity_cap.map_or(dexterity, |cap| cap as f64) };
            js_min(dexterity, cap)
        }
    };
    let mut shield_bonus = 0.0;
    for entry in &shields {
        shield_bonus += integer(entry.profile.get("armorClassBonus"), &format!("armor profile {}.armorClassBonus", entry.catalog_id), 0, 10, None)? as f64;
    }
    let item_effect_bonus = js::number(active_item_effect_totals(actor)?.get("armor_class_bonus"));
    let defense_bonus = if body.is_some() && normalized_selected_feature_ids(actor).iter().any(|id| id == "fighting-style-defense") { 1.0 } else { 0.0 };
    let base = body.as_ref().map_or(unarmored_base, |body| body.base as f64);
    let value = body.as_ref().map_or(unarmored_base, |body| body.base as f64 + armor_dexterity) + shield_bonus + item_effect_bonus + defense_bonus;
    let source = if body.is_some() {
        "equipped_server_profile"
    } else if matches!(key.as_deref(), Some("barbarian") | Some("monk")) {
        "class_unarmored_defense"
    } else {
        "unarmored"
    };
    let mut result = Map::new();
    result.insert("value".into(), js::num(value));
    result.insert("base".into(), js::num(base));
    result.insert("dexterityModifier".into(), js::num(if body.is_some() { armor_dexterity } else { dexterity }));
    result.insert("shieldBonus".into(), js::num(shield_bonus));
    result.insert("item_effect_bonus".into(), js::num(item_effect_bonus));
    result.insert("fighting_style_bonus".into(), js::num(defense_bonus));
    result.insert("source".into(), json!(source));
    result.insert("armorCatalogId".into(), body.as_ref().map_or(Value::Null, |body| Value::String(body.catalog_id.clone())));
    result.insert("shieldCatalogIds".into(), Value::Array(shields.iter().map(|entry| Value::String(entry.catalog_id.clone())).collect()));
    Ok(Value::Object(result))
}

/// `deriveSpeed(actor, { armorProfiles })`.
pub fn derive_speed(actor: Option<&Value>, armor_profiles: Option<&Value>) -> LifecycleResult<Value> {
    let profiles = normalized_armor_profiles(armor_profiles)?;
    let base = normalized_base_speed(actor)?;
    let creation_bonus = js::number(Some(nullish(path(actor, &["creationBenefits", "speed_bonus"]), Some(&json!(0))).unwrap_or(&json!(0))));
    let has_creation = js::truthy(prop(actor, "creationBenefits"));
    let strength = js::number(path(actor, &["abilities", "str"]));
    let penalties: Vec<f64> = equipped_armor_entries(actor, profiles)
        .iter()
        .map(|entry| {
            let raw = js::number(entry.profile.get("speedPenalty"));
            let speed_penalty = if raw.is_nan() || raw == 0.0 { 0.0 } else { raw };
            let requirement = js::number(Some(nullish(entry.profile.get("strengthRequirement"), Some(&json!(0))).unwrap_or(&json!(0))));
            let heavy = if has_creation && strength < requirement { 10.0 } else { 0.0 };
            js_max(js_max(0.0, speed_penalty), heavy)
        })
        .collect();
    let penalty = if js::is_true(path(actor, &["speciesBenefits", "mechanics", "ignore_armor_speed_penalty"])) {
        0.0
    } else {
        penalties.iter().fold(0.0, |max, value| js_max(max, *value))
    };
    let mut result = Map::new();
    result.insert("base".into(), int(base));
    if creation_bonus != 0.0 && !creation_bonus.is_nan() {
        result.insert("creation_bonus".into(), js::num(creation_bonus));
    }
    result.insert("penalty".into(), js::num(penalty));
    result.insert("value".into(), js::num(js_max(0.0, base as f64 + creation_bonus - penalty)));
    Ok(Value::Object(result))
}

/// Итог `canonicalCharacterChoices`: герой и поля, которые JS оставил
/// ключом со значением `undefined` (в JSON их нет, но в `{ ...a, ...b }`
/// они затирают поле `a`).
struct Canonical {
    actor: Map<String, Value>,
    unset: Vec<&'static str>,
}

/// Прочитать поля героя как `Value::Object` без копии: объект на время вызова
/// переезжает в `Value` и возвращается обратно.
fn with_value<T>(fields: &mut Map<String, Value>, read: impl FnOnce(&Value) -> T) -> T {
    let actor = Value::Object(std::mem::take(fields));
    let result = read(&actor);
    if let Value::Object(map) = actor {
        *fields = map;
    }
    result
}

/// `canonicalCharacterChoices(actor, options)`.
fn canonical_character_choices(actor: Map<String, Value>) -> Canonical {
    let mut candidate = actor;
    let mut unset = Vec::new();
    let subclass = with_value(&mut candidate, |actor| normalized_combat_subclass_for(Some(actor)));
    if candidate.contains_key("subclass") {
        match subclass {
            Some(subclass) => {
                candidate.insert("subclass".into(), Value::String(subclass));
            }
            None => {
                candidate.shift_remove("subclass");
                unset.push("subclass");
            }
        }
    }
    if candidate.contains_key("classSkillProficiencies") {
        let skills = with_value(&mut candidate, |actor| normalized_class_skill_proficiencies(Some(actor)));
        candidate.insert("classSkillProficiencies".into(), strings(&skills));
    }
    if candidate.contains_key("selectedFeatureIds") {
        let features = with_value(&mut candidate, |actor| normalized_selected_feature_ids(Some(actor)));
        candidate.insert("selectedFeatureIds".into(), strings(&features));
    }
    let spells = with_value(&mut candidate, |actor| normalized_spell_selections_for(Some(actor)));
    for key in ["knownSpellIds", "preparedSpellIds"] {
        if candidate.contains_key(key) {
            candidate.insert(key.into(), spells.get(key).cloned().unwrap_or_else(|| json!([])));
        }
    }
    Canonical { actor: candidate, unset }
}

/// `new Set([...a, ...b])` над значениями JSON (`SameValueZero`; объекты
/// различны всегда).
fn push_unique(target: &mut Vec<Value>, value: Value) {
    let duplicate = match &value {
        Value::Object(_) | Value::Array(_) => false,
        other => target.iter().any(|entry| strict_eq(Some(entry), Some(other))),
    };
    if !duplicate {
        target.push(value);
    }
}

fn options_flag(options: Option<&Value>, key: &str) -> bool {
    js::is_true(prop(options, key))
}

/// `deriveCharacterSheet(actor, options)`: производный лист героя. Из
/// `options` читаются `armorProfiles` и `classResources2024`.
pub fn derive_character_sheet(actor: Option<&Value>, options: Option<&Value>) -> LifecycleResult<Value> {
    let Some(character_class) = class_key(actor) else {
        return invalid("Для листа героя требуется поддерживаемый класс", "CHARACTER_CLASS_UNSUPPORTED");
    };
    let level = normalized_level(prop(actor, "level"))?;
    let experience = integer(prop(actor, "experience"), "experience", 0, MAX_EXPERIENCE, Some(&json!(0)))?;
    let abilities = normalized_abilities(prop(actor, "abilities"))?;
    let proficiency_bonus = 2 + (level - 1).div_euclid(4);
    // Лист не читает производных полей героя (`combatSpells`, `combatActions`,
    // `characterSheet`, `inventoryLoad`; JS их тоже не трогает), а копия
    // карточек заклинаний — самая дорогая часть `{ ...actor }`: ключи остаются
    // на месте, значения — `null`.
    let mut base = spread_without_derived(actor);
    base.insert("characterClass".into(), Value::String(character_class.clone()));
    base.insert("level".into(), int(level));
    base.insert("abilities".into(), abilities.to_value());
    let canonical = Value::Object(canonical_character_choices(base).actor);
    let canonical = Some(&canonical);
    let item_effects = active_item_effect_totals(canonical)?;
    let mut saving_throw_proficiencies: Vec<Value> = Vec::new();
    for save in saving_throw_proficiencies_for(canonical) {
        push_unique(&mut saving_throw_proficiencies, Value::String(save));
    }
    if let Some(extra) = defined(path(canonical, &["creationBenefits", "saving_throw_proficiencies"])) {
        for save in iterate(extra, "creationBenefits.saving_throw_proficiencies")? {
            push_unique(&mut saving_throw_proficiencies, save);
        }
    }
    let class_skills: HashSet<String> = normalized_class_skill_proficiencies(canonical).into_iter().collect();
    let background_skills: HashSet<String> = catalog_skill_ids(prop(canonical, "backgroundSkillProficiencies")).into_iter().collect();
    let species_skills: HashSet<String> = catalog_skill_ids(prop(canonical, "speciesSkillProficiencies")).into_iter().collect();
    let mut skills = Map::new();
    let mut skill_totals: HashMap<&str, i64> = HashMap::new();
    for id in SKILL_IDS {
        let ability = skill_ability(Some(&json!(id))).unwrap_or(Value::Null);
        let creation_skill = includes_or_empty(prop(canonical, "creationSkillProficiencies"), id, "creationSkillProficiencies")?;
        let proficient = class_skills.contains(id) || background_skills.contains(id) || species_skills.contains(id) || creation_skill;
        let expertise = proficient && includes_or_empty(path(canonical, &["creationBenefits", "expertise"]), id, "creationBenefits.expertise")?;
        let modifier = modifier_of(abilities.get(ability.as_str().unwrap_or("")));
        let bonus = if proficient { proficiency_bonus * if expertise { 2 } else { 1 } } else { 0 };
        skill_totals.insert(id, modifier + bonus);
        skills.insert(
            id.into(),
            json!({ "ability": ability, "modifier": modifier, "proficient": proficient, "expertise": expertise, "proficiencyBonus": bonus, "total": modifier + bonus }),
        );
    }
    let saving_throw_bonus = js::number(item_effects.get("saving_throw_bonus"));
    let mut saving_throws = Map::new();
    for ability in ABILITY_IDS {
        let proficient = saving_throw_proficiencies.iter().any(|entry| is_str(Some(entry), ability));
        let modifier = modifier_of(abilities.get(ability));
        let bonus = if proficient { proficiency_bonus } else { 0 };
        saving_throws.insert(
            ability.into(),
            json!({
                "modifier": modifier,
                "proficient": proficient,
                "proficiencyBonus": bonus,
                "item_effect_bonus": js::num(saving_throw_bonus),
                "total": js::num((modifier + bonus) as f64 + saving_throw_bonus),
            }),
        );
    }
    let hit_points = derive_maximum_hit_points(canonical, Some(level), Some(&abilities))?;
    let armor_profiles = prop(options, "armorProfiles");
    let armor_class = derive_armor_class(canonical, Some(&abilities), armor_profiles)?;
    let speed = derive_speed(canonical, armor_profiles)?;
    let number_or_zero = |keys: &[&str]| js::number(Some(nullish(path(canonical, keys), Some(&json!(0))).unwrap_or(&json!(0))));
    let actor_id = clean_text(prop(canonical, "id"), 120);
    let mut sheet = Map::new();
    sheet.insert("schema_version".into(), int(CHARACTER_LIFECYCLE_SCHEMA_VERSION));
    sheet.insert("actor_id".into(), if actor_id.is_empty() { Value::Null } else { Value::String(actor_id) });
    sheet.insert("character_class".into(), Value::String(character_class));
    sheet.insert("level".into(), int(level));
    sheet.insert("experience".into(), int(experience));
    sheet.insert("experience_for_next_level".into(), if level < MAX_LEVEL { int(threshold(level + 1)) } else { Value::Null });
    sheet.insert(
        "abilities".into(),
        Value::Object(ABILITY_IDS.iter().map(|ability| (ability.to_string(), json!({ "score": abilities.get(ability), "modifier": modifier_of(abilities.get(ability)) }))).collect()),
    );
    sheet.insert("proficiency_bonus".into(), int(proficiency_bonus));
    sheet.insert("saving_throw_proficiencies".into(), Value::Array(saving_throw_proficiencies));
    sheet.insert("saving_throws".into(), Value::Object(saving_throws));
    sheet.insert("skills".into(), Value::Object(skills));
    sheet.insert("passive_perception".into(), js::num(10.0 + skill_totals["perception"] as f64 + number_or_zero(&["creationBenefits", "passive_skill_bonuses", "perception"])));
    sheet.insert("passive_investigation".into(), js::num(10.0 + skill_totals["investigation"] as f64 + number_or_zero(&["creationBenefits", "passive_skill_bonuses", "investigation"])));
    sheet.insert("initiative".into(), js::num(modifier_of(abilities.get("dex")) as f64 + number_or_zero(&["creationBenefits", "initiative_bonus"])));
    sheet.insert("skill_expertise".into(), nullish(path(canonical, &["creationBenefits", "expertise"]), Some(&json!([]))).cloned().unwrap_or_else(|| json!([])));
    sheet.insert("creation_benefits".into(), defined(prop(canonical, "creationBenefits")).cloned().unwrap_or(Value::Null));
    sheet.insert("armor_class".into(), armor_class);
    sheet.insert("speed".into(), speed);
    sheet.insert("hit_points".into(), hit_points);
    sheet.insert("species_traits".into(), defined(prop(canonical, "speciesBenefits")).cloned().unwrap_or(Value::Null));
    sheet.insert("class_resources".into(), class_resource_plan(canonical, options_flag(options, "classResources2024")));
    Ok(Value::Object(sheet))
}

/// `normalizeCharacterSheet(actor, options)`: `{ actor, sheet }` —
/// канонические поля героя и производный лист.
pub fn normalize_character_sheet(actor: Option<&Value>, options: Option<&Value>) -> LifecycleResult<Value> {
    let sheet = derive_character_sheet(actor, options)?;
    let abilities: Map<String, Value> = ABILITY_IDS.iter().map(|ability| (ability.to_string(), sheet["abilities"][ability]["score"].clone())).collect();
    let increases = normalized_hit_point_increases(actor, sheet["level"].as_i64(), sheet["hit_points"]["hitDie"].as_i64())?;
    let mut base = spread_of(Some(actor.filter(|actor| !actor.is_null()).unwrap_or(&json!({}))));
    base.insert("characterClass".into(), sheet["character_class"].clone());
    base.insert("level".into(), sheet["level"].clone());
    base.insert("experience".into(), sheet["experience"].clone());
    base.insert("abilities".into(), Value::Object(abilities));
    base.insert("baseSpeed".into(), sheet["speed"]["base"].clone());
    base.insert("hitPointIncreases".into(), Value::Array(increases.into_iter().map(int).collect()));
    let canonical = canonical_character_choices(base).actor;
    Ok(json!({ "actor": canonical, "sheet": sheet }))
}

/// `classResourcePlan(actor, { classResources2024 })`: максимумы ресурсов
/// класса и заклинаний и единственная политика их восстановления.
pub fn class_resource_plan(actor: Option<&Value>, class_resources_2024: bool) -> Value {
    let options = ClassResourceOptions { class_resources_2024 };
    let slots = spell_slot_maximums_for(actor);
    let mut maximums = spread_of(Some(&slots));
    for (key, value) in spread_of(Some(&combat_resource_maximums_for(actor, options))) {
        maximums.insert(key, value);
    }
    let mut recovery = Map::new();
    if let Value::Object(slots) = &slots {
        for key in js::keys(slots) {
            recovery.insert(key.clone(), json!(if key == "pact_slots" { "short_or_long" } else { "long" }));
        }
    }
    for (key, value) in spread_of(Some(&combat_resource_recovery_for(actor, options))) {
        recovery.insert(key, value);
    }
    let rests = |kinds: &[&str]| -> Value {
        Value::Array(js::keys(&maximums).into_iter().filter(|resource| kinds.iter().any(|kind| is_str(recovery.get(resource.as_str()), kind))).map(|resource| Value::String(resource.clone())).collect())
    };
    let short = rests(&["short_or_long", ONE_ON_SHORT_REST]);
    let long = rests(&["long", "short_or_long", ONE_ON_SHORT_REST]);
    json!({ "maximums": maximums, "recovery": recovery, "by_rest": { "short": short, "long": long } })
}

/// `resourcesAfterRest(actor, resources, kind, options)`.
pub fn resources_after_rest(actor: Option<&Value>, resources: Option<&Value>, kind: Option<&Value>, class_resources_2024: bool) -> LifecycleResult<Value> {
    let kind = match kind {
        Some(Value::String(kind)) if kind == "short" || kind == "long" => kind.as_str(),
        _ => return invalid("kind отдыха должен быть short или long", "INVALID_REST_KIND"),
    };
    let plan = class_resource_plan(actor, class_resources_2024);
    let source = if js::is_plain(resources) { resources } else { None };
    let mut result = Map::new();
    if let Some(Value::Object(maximums)) = plan.get("maximums") {
        for (resource, maximum) in js::entries(maximums) {
            let maximum_number = js::number(Some(maximum));
            let raw = js::number(Some(nullish(path(source, &[resource.as_str(), "current"]), Some(maximum)).unwrap_or(maximum)));
            let raw = if raw.is_nan() || raw == 0.0 { 0.0 } else { raw };
            let current = js_max(0.0, js_min(maximum_number, raw));
            let recovery = path(Some(&plan), &["recovery", resource.as_str()]);
            let restored = kind == "long" || is_str(recovery, "short_or_long");
            let one_back = kind == "short" && is_str(recovery, ONE_ON_SHORT_REST);
            let current = if restored {
                maximum_number
            } else if one_back {
                js_min(maximum_number, current + 1.0)
            } else {
                current
            };
            let mut entry = Map::new();
            entry.insert("current".into(), js::num(current));
            entry.insert("max".into(), maximum.clone());
            put(&mut entry, "recovery", recovery);
            result.insert(resource.clone(), Value::Object(entry));
        }
    }
    Ok(Value::Object(result))
}

// ---------------------------------------------------------------------------
// Состояние кампании
// ---------------------------------------------------------------------------

fn players_of<'a>(state: Option<&'a Value>) -> LifecycleResult<&'a [Value]> {
    match defined(prop(state, "players")) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(CharacterLifecycleError::runtime("(state?.players ?? []).find is not a function")),
    }
}

fn actor_from_state<'a>(state: Option<&'a Value>, actor_id: &str) -> LifecycleResult<&'a Value> {
    players_of(state)?
        .iter()
        .find(|candidate| js::string(prop(Some(candidate), "id")) == actor_id)
        .ok_or_else(|| CharacterLifecycleError::invalid("Герой не найден в кампании", "ACTOR_NOT_FOUND"))
}

/// `characterCreationTargetLevel(state)`: стартовый уровень кампании.
pub fn character_creation_target_level(state: Option<&Value>) -> LifecycleResult<i64> {
    integer(nullish(prop(state, "character_start_level"), prop(state, "characterStartLevel")), "character_start_level", 1, MAX_LEVEL, Some(&json!(1)))
}

fn staged_character_setup_for(state: Option<&Value>, actor: Option<&Value>) -> LifecycleResult<bool> {
    if !js::is_true(prop(actor, "characterSetupRequired")) || !is_str(prop(actor, "characterSetupStage"), "leveling") {
        return Ok(false);
    }
    Ok(character_creation_target_level(state)? > normalized_level(prop(actor, "level"))?)
}

/// `characterCreationChoicesComplete(actor, options)`: все обязательные
/// выборы текущего уровня сделаны. Из `options` читается `rulesetId`.
pub fn character_creation_choices_complete(actor: Option<&Value>, options: Option<&Value>) -> LifecycleResult<bool> {
    Ok(missing_character_creation_choice(actor, options)?.is_none())
}

/// `missingCharacterCreationChoice(actor, options)`
/// (`server/character-lifecycle.mjs:793`, #190): первый незавершённый выбор
/// текущего уровня словами для игрока, либо `None`.
pub fn missing_character_creation_choice(actor: Option<&Value>, options: Option<&Value>) -> LifecycleResult<Option<String>> {
    let ability_choices = prop(actor, "abilityScoreIncreases").filter(|value| value.is_object());
    let level_feats = prop(actor, "levelFeats").filter(|value| value.is_object());
    for level in ability_score_choice_levels_for(actor) {
        if actor.is_none_or(Value::is_null) {
            return Err(CharacterLifecycleError::runtime("Cannot read properties of null (reading 'level')"));
        }
        if level > normalized_level(prop(actor, "level"))? {
            continue;
        }
        let key = level.to_string();
        let asi = prop(ability_choices, &key);
        let feat = prop(level_feats, &key);
        let asi_ok = matches!(asi, Some(Value::Array(items)) if items.len() == 1 || items.len() == 2);
        let feat_ok = matches!(feat, Some(Value::Object(_)) | Some(Value::Array(_))) && !text::trim(&js::s(defined(prop(feat, "id")))).is_empty();
        if !(asi_ok || feat_ok) {
            return Ok(Some("Выберите повышение характеристик или черту уровня".into()));
        }
    }
    if let Some(rule) = class_skill_rule_for(actor) {
        if normalized_class_skill_proficiencies(actor).len() as f64 != js::number(rule.get("choiceCount")) || !rule.get("choiceCount").is_some_and(Value::is_number) {
            return Ok(Some(format!("Выберите классовые навыки: {}", js::string(rule.get("choiceCount")))));
        }
    }
    let key = class_key(actor);
    let catalog = combat_class_catalog_info();
    let class_info = array_of(catalog.get("classes")).iter().find(|entry| key.as_deref().is_some_and(|key| is_str(entry.get("classKey"), key)));
    if let Some(class_info) = class_info {
        let subclass_level = js::number(Some(nullish(class_info.get("subclassLevel"), Some(&json!(1))).unwrap_or(&json!(1))));
        if (normalized_level(prop(actor, "level"))? as f64) >= subclass_level && js::number(class_info.get("subclasses")) > 0.0 && normalized_combat_subclass_for(actor).is_none() {
            return Ok(Some("Выберите подкласс".into()));
        }
    }
    let selected_features: HashSet<String> = normalized_selected_feature_ids(actor).into_iter().collect();
    for group in feature_choice_groups_for(actor) {
        let selected = array_of(group.get("options")).iter().filter(|option| option.get("id").and_then(Value::as_str).is_some_and(|id| selected_features.contains(id))).count();
        if !strict_eq(Some(&int(selected as i64)), group.get("choiceCount")) {
            return Ok(Some(format!("{}: выберите {}", js::string(group.get("name")), js::string(group.get("choiceCount")))));
        }
    }
    let Some(rules) = spell_selection_rules_for(actor) else {
        return Ok(None);
    };
    let selected = normalized_spell_selections_for(actor);
    let known: Vec<String> = unique_in_order(array_of(selected.get("knownSpellIds")).iter().map(|id| js::s(Some(id))).collect());
    let mut spells: HashMap<String, Value> = HashMap::new();
    for spell in combat_spells_for(actor, options) {
        spells.insert(js::string(spell.get("id")), spell);
    }
    let level_of = |id: &String| spells.get(id).and_then(|spell| spell.get("level"));
    let cantrips = known.iter().filter(|id| strict_eq(level_of(id), Some(&int(0)))).count() as f64;
    let leveled = known.iter().filter(|id| js::number(Some(nullish(level_of(id), Some(&json!(0))).unwrap_or(&json!(0)))) > 0.0).count() as f64;
    if cantrips != rules.cantrips {
        return Ok(Some(format!("Выберите заговоры: {}", js::f64_string(rules.cantrips))));
    }
    if rules.mode == "known" && leveled != rules.spells_known {
        return Ok(Some(format!("Выберите известные заклинания: {}", js::f64_string(rules.spells_known))));
    }
    if rules.mode == "spellbook" && leveled < rules.spellbook_minimum {
        return Ok(Some(format!("Впишите в книгу заклинаний: {}", js::f64_string(rules.spellbook_minimum))));
    }
    Ok(None)
}

/// `assertActorAuthority(actorId, context, message)`; текст отказа по умолчанию —
/// повышения уровня, импорт и броски создания передают свой (#190).
fn assert_actor_authority(actor_id: &str, context: Option<&Value>, message: &str) -> LifecycleResult<()> {
    let allowed: Vec<String> = match defined(prop(context, "allowedActorIds")) {
        None => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(|item| js::string(Some(item))).collect(),
        Some(_) => return Err(CharacterLifecycleError::runtime("(context?.allowedActorIds ?? []).map is not a function")),
    };
    if !js::is_true(prop(context, "isAdmin")) && !allowed.iter().any(|id| id == actor_id) {
        return invalid(message, "ACTOR_FORBIDDEN");
    }
    Ok(())
}

fn combat_active(state: Option<&Value>) -> bool {
    js::truthy(path(state, &["mechanics", "combat", "active"]))
}

/// `source_rule_ids` команды: непустой массив — копией, иначе по умолчанию.
fn command_source_rules(command: &Value, fallback: &str) -> Value {
    match command.get("source_rule_ids") {
        Some(Value::Array(items)) if !items.is_empty() => Value::Array(items.clone()),
        _ => json!([fallback]),
    }
}

/// `validateLevelUpCommand(command, state, context)`.
pub fn validate_level_up_command(command: Option<&Value>, state: Option<&Value>, context: Option<&Value>) -> LifecycleResult<Value> {
    let command = match command {
        Some(command @ Value::Object(_)) if is_str(command.get("command_type"), "LevelUp") => command,
        _ => return invalid("Нужна команда LevelUp", "INVALID_LEVEL_UP_COMMAND"),
    };
    if combat_active(state) {
        return invalid("Нельзя повышать уровень во время боя", "LEVEL_UP_DURING_COMBAT");
    }
    let actor_id = clean_identifier(nullish(command.get("actor_id"), command.get("actorId")), "actor_id")?;
    let actor = actor_from_state(state, &actor_id)?;
    assert_actor_authority(&actor_id, context, LEVEL_UP_FORBIDDEN)?;
    let current_level = normalized_level(actor.get("level"))?;
    if current_level >= MAX_LEVEL {
        return invalid("Достигнут максимальный поддерживаемый уровень", "LEVEL_CAP_REACHED");
    }
    let next_level = current_level + 1;
    let expected_level = nullish(command.get("expected_level"), command.get("expectedLevel"));
    if js::present(expected_level) && integer(expected_level, "expected_level", 1, MAX_LEVEL, None)? != current_level {
        return invalid("Лист героя изменился: expected_level не совпадает", "LEVEL_UP_CONFLICT");
    }
    if js::present(command.get("next_level")) && integer(command.get("next_level"), "next_level", 1, MAX_LEVEL, None)? != next_level {
        return invalid("За одну команду можно повысить ровно один уровень", "LEVEL_UP_STEP_INVALID");
    }
    let creation_level_up = staged_character_setup_for(state, Some(actor))?;
    if js::is_true(actor.get("characterSetupRequired")) && !creation_level_up {
        return invalid("Сначала импортируйте героя и начните его поэтапную подготовку", "CHARACTER_SETUP_REQUIRED");
    }
    if creation_level_up && next_level > character_creation_target_level(state)? {
        return invalid("Герой уже достиг выбранного стартового уровня", "CHARACTER_CREATION_LEVEL_REACHED");
    }
    if creation_level_up {
        let mut options = Map::new();
        put(&mut options, "rulesetId", prop(state, "ruleset_id"));
        if !character_creation_choices_complete(Some(actor), Some(&Value::Object(options)))? {
            return invalid("Сначала завершите выборы текущего уровня персонажа", "CHARACTER_CREATION_CHOICES_REQUIRED");
        }
    }
    let experience = integer(actor.get("experience"), "experience", 0, MAX_EXPERIENCE, Some(&json!(0)))?;
    let required_experience = threshold(next_level);
    let milestone_earned = js::is_true(path(state, &["mechanics", "progression", "level_up_available"]));
    if !creation_level_up && experience < required_experience && !milestone_earned {
        return invalid(format!("Для уровня {next_level} нужно {required_experience} XP или заслуженная веха"), "LEVEL_UP_PROGRESSION_REQUIRED");
    }
    let progression_source = if creation_level_up {
        "character_creation"
    } else if experience >= required_experience {
        "experience"
    } else {
        "milestone"
    };
    let hit_die = hit_die_for(Some(actor));
    let raw_roll = nullish(command.get("hit_point_roll"), command.get("hitPointRoll"));
    let hit_point_roll = if js::present(raw_roll) { integer(raw_roll, "hit_point_roll", 1, hit_die, None)? } else { fixed_hit_point_increase(hit_die) };
    let hit_point_policy = if js::present(raw_roll) { "server_roll" } else { "fixed_average" };
    let before = derive_maximum_hit_points(Some(actor), Some(current_level), None)?;
    let mut increases = normalized_hit_point_increases(Some(actor), Some(current_level), Some(hit_die))?;
    increases.push(hit_point_roll);
    let mut after_actor = spread_of(Some(actor));
    after_actor.insert("level".into(), int(next_level));
    after_actor.insert("hitPointIncreases".into(), Value::Array(increases.into_iter().map(int).collect()));
    let after = derive_maximum_hit_points(Some(&Value::Object(after_actor)), Some(next_level), None)?;
    Ok(json!({
        "command_type": "LevelUp",
        "actor_id": actor_id,
        "target_id": actor_id,
        "target_ids": [actor_id],
        "expected_level": current_level,
        "level_before": current_level,
        "level_after": next_level,
        "experience": if creation_level_up { required_experience } else { experience },
        "experience_required": required_experience,
        "progression_source": progression_source,
        "hit_die": hit_die,
        "hit_point_roll": hit_point_roll,
        "hit_point_policy": hit_point_policy,
        "max_hp_before": before["value"],
        "max_hp_after": after["value"],
        "source_rule_ids": command_source_rules(command, DEFAULT_SOURCE_RULE),
        "visibility": "party",
    }))
}

/// `[...(command.source_rule_ids ?? [fallback])]`.
fn spread_source_rules(command: &Value, fallback: &str) -> LifecycleResult<Value> {
    match defined(command.get("source_rule_ids")) {
        None => Ok(json!([fallback])),
        Some(value) => Ok(Value::Array(iterate(value, "command.source_rule_ids")?)),
    }
}

/// `levelUpEvent(command)`: событие `CharacterLeveledUp` из проверенной команды.
pub fn level_up_event(command: Option<&Value>) -> LifecycleResult<Value> {
    let command = match command {
        Some(command) if is_str(command.get("command_type"), "LevelUp") && js::truthy(command.get("actor_id")) => command,
        _ => return invalid("Нужна валидированная команда LevelUp", "INVALID_LEVEL_UP_COMMAND"),
    };
    let field = |key: &str| command.get(key);
    let mut payload = Map::new();
    payload.insert("schema_version".into(), int(CHARACTER_LIFECYCLE_SCHEMA_VERSION));
    for key in ["level_before", "level_after", "experience", "experience_required"] {
        put(&mut payload, key, field(key));
    }
    payload.insert("progression_source".into(), nullish(field("progression_source"), Some(&json!("experience"))).cloned().unwrap_or_else(|| json!("experience")));
    for key in ["hit_die", "hit_point_roll", "hit_point_policy", "max_hp_before", "max_hp_after"] {
        put(&mut payload, key, field(key));
    }
    payload.insert("resource_grant_version".into(), int(1));
    let mut event = Map::new();
    event.insert("event_type".into(), json!("CharacterLeveledUp"));
    put(&mut event, "actor_id", field("actor_id"));
    event.insert("target_ids".into(), Value::Array(vec![field("actor_id").cloned().unwrap_or(Value::Null)]));
    event.insert("source_rule_ids".into(), spread_source_rules(command, DEFAULT_SOURCE_RULE)?);
    event.insert("visibility".into(), nullish(field("visibility"), Some(&json!("party"))).cloned().unwrap_or_else(|| json!("party")));
    event.insert("payload".into(), Value::Object(payload));
    Ok(Value::Object(event))
}

/// `validateCharacterImportCommand(command, state, context)`.
pub fn validate_character_import_command(command: Option<&Value>, state: Option<&Value>, context: Option<&Value>) -> LifecycleResult<Value> {
    let command = match command {
        Some(command @ Value::Object(_)) if is_str(command.get("command_type"), "ImportCharacter") => command,
        _ => return invalid("Нужна команда ImportCharacter", "INVALID_CHARACTER_IMPORT_COMMAND"),
    };
    if combat_active(state) {
        return invalid("Нельзя импортировать лист во время боя", "IMPORT_DURING_COMBAT");
    }
    let actor_id = clean_identifier(nullish(command.get("actor_id"), command.get("actorId")), "actor_id")?;
    let actor = actor_from_state(state, &actor_id)?;
    assert_actor_authority(&actor_id, context, "Импортировать лист может только владелец героя")?;
    // Импорт поверх готового героя переписывает уровень, опыт и броски хитов
    // документом клиента: готового героя развивает только LevelUp, перезаписать
    // лист целиком может ведущий (`server/character-lifecycle.mjs:984`, #190).
    if !js::is_true(actor.get("characterSetupRequired")) && !js::is_true(prop(context, "isAdmin")) {
        return invalid("Герой уже создан: развивайте его повышением уровня, а заменить лист целиком может ведущий", "CHARACTER_ALREADY_CREATED");
    }
    let ruleset_id = js::s(Some(nullish(prop(state, "ruleset_id"), Some(&json!(LEGACY_DEFAULT_RULESET_ID))).unwrap_or(&Value::Null)));
    let rolls = prop(Some(actor), "characterCreationRolls");
    let parsed = parse_character_import(
        command.get("document"),
        &ImportOptions {
            ruleset_id: Some(&ruleset_id),
            validate_creation_languages: true,
            trusted_ability_roll: prop(rolls, "abilities"),
            trusted_wealth_roll: prop(rolls, "wealth"),
            ..ImportOptions::default()
        },
    )?;
    if js::is_true(actor.get("characterSetupRequired")) && !strict_eq(parsed.patch.get("level"), Some(&int(1))) {
        return invalid("Новый герой должен начинать с первого уровня; последующие уровни проходят по одному в мастере подготовки", "IMPORT_LEVEL_MUST_START_AT_ONE");
    }
    let starter_catalog = starter_equipment_catalog_for(&ruleset_id, false);
    let species_policy = character_creation_policy_for(&ruleset_id)?;
    let is_2014 = ruleset_id == DND_2014_RULESET_ID;
    // Новый герой обязан прийти с полным набором выборов первого уровня; в
    // кампании 2014 без `phbCreation` пропускались бы все проверки PHB.
    if js::is_true(actor.get("characterSetupRequired")) && is_2014 && !js::truthy(parsed.creation.as_ref()) {
        return invalid("Герой редакции 2014 создаётся с выборами PHB (phbCreation)", "IMPORT_PHB_CREATION_REQUIRED");
    }
    // В 2024 прибавки характеристик даёт предыстория: без неё сверять не с чем,
    // значит, и прибавок нет.
    let origin_bonuses = path(parsed.patch.get("abilityGeneration"), &["originBonuses"]);
    if is_str(species_policy.get("bonus_source"), "background")
        && !js::truthy(parsed.patch.get("backgroundId"))
        && object_values(defined(origin_bonuses)).iter().any(|value| js::number(Some(value)) != 0.0)
    {
        return invalid("Прибавки характеристик даёт предыстория: выберите её", "IMPORT_BACKGROUND_REQUIRED");
    }
    let policy_field = |key: &str, fallback: Value| -> Value {
        defined(path(starter_catalog.as_ref(), &[key])).cloned().unwrap_or(if is_2014 { Value::Null } else { fallback })
    };
    let mut result = Map::new();
    result.insert("command_type".into(), json!("ImportCharacter"));
    result.insert("actor_id".into(), json!(actor_id));
    result.insert("target_id".into(), json!(actor_id));
    result.insert("target_ids".into(), json!([actor_id]));
    result.insert("document".into(), parsed.document.clone());
    result.insert("patch".into(), Value::Object(parsed.patch.clone()));
    if js::truthy(parsed.creation.as_ref()) {
        result.insert("creation_result".into(), parsed.creation.clone().unwrap_or(Value::Null));
    }
    result.insert("derived_sheet".into(), parsed.sheet.clone());
    result.insert("ruleset_id".into(), json!(ruleset_id));
    result.insert("starter_equipment_policy_id".into(), policy_field("policy_id", json!(STARTER_KIT_2024_POLICY.policy_id)));
    result.insert("starter_equipment_policy_version".into(), policy_field("policy_version", json!(STARTER_KIT_2024_POLICY.policy_version)));
    put(&mut result, "species_policy_version", species_policy.get("policy_version"));
    result.insert("source_rule_ids".into(), command_source_rules(command, &format!("{ruleset_id}:resources:spending")));
    result.insert("visibility".into(), json!("party"));
    let validated = Value::Object(result);
    // При стартовом уровне выше первого выборы досдаются командами подготовки, и
    // полноту сторожит LevelUp. Здесь — импорт, сразу завершающий создание:
    // полнота проверяется на том герое, которого запишет reducer.
    if js::is_true(actor.get("characterSetupRequired")) && character_creation_target_level(state)? <= 1 {
        let after = apply_character_lifecycle_event(state.unwrap_or(&Value::Null), &character_import_event(Some(&validated))?)?;
        let mut imported = spread_of(Some(actor_from_state(Some(&after), &actor_id)?));
        imported.insert("level".into(), int(1));
        let options = json!({ "rulesetId": ruleset_id });
        if let Some(missing) = missing_character_creation_choice(Some(&Value::Object(imported)), Some(&options))? {
            return invalid(format!("Герой не завершён: {missing}"), "IMPORT_CHOICES_INCOMPLETE");
        }
    }
    Ok(validated)
}

/// `Object.values(value ?? {})`: значения объекта, элементы массива, символы
/// строки; у прочего — пусто.
fn object_values(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(_, value)| value.clone()).collect(),
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.encode_utf16().map(|unit| Value::String(String::from_utf16_lossy(&[unit]))).collect(),
        _ => Vec::new(),
    }
}

/// `validateCharacterAbilityRollCommand(command, state, context)`: броски
/// характеристик и стартового богатства при создании героя D&D 2014.
pub fn validate_character_ability_roll_command(command: Option<&Value>, state: Option<&Value>, context: Option<&Value>) -> LifecycleResult<Value> {
    let Some(command) = defined(command) else {
        return Err(CharacterLifecycleError::runtime("Cannot read properties of null (reading 'actor_id')"));
    };
    let actor_id = clean_identifier(prop(Some(command), "actor_id"), "actor_id")?;
    let actor = actor_from_state(state, &actor_id)?;
    assert_actor_authority(&actor_id, context, "Бросать за героя может только владелец героя")?;
    if !is_str(prop(state, "ruleset_id"), DND_2014_RULESET_ID) || !js::truthy(actor.get("characterSetupRequired")) || js::truthy(path(state, &["mechanics", "combat", "active"])) {
        return invalid("Броски характеристик доступны только при создании героя D&D 2014", "CHARACTER_ROLL_UNAVAILABLE");
    }
    let rolls = prop(Some(actor), "characterCreationRolls");
    if is_str(prop(Some(command), "command_type"), "RollCharacterWealth") {
        let key = property_key(prop(Some(command), "character_class"));
        let known = PHB_STARTING_WEALTH.iter().any(|entry| entry.class_id == key);
        if !known {
            return invalid("Выберите класс PHB 2014", "CHARACTER_CLASS_UNSUPPORTED");
        }
        if js::truthy(prop(rolls, "wealth")) {
            return invalid("Стартовое богатство уже определено", "CHARACTER_WEALTH_ALREADY_ROLLED");
        }
        let mut result = Map::new();
        result.insert("command_type".into(), json!("RollCharacterWealth"));
        result.insert("actor_id".into(), json!(actor_id));
        result.insert("target_id".into(), json!(actor_id));
        result.insert("target_ids".into(), json!([actor_id]));
        put(&mut result, "character_class", prop(Some(command), "character_class"));
        result.insert("visibility".into(), json!("party"));
        return Ok(Value::Object(result));
    }
    // `actor.characterCreationRolls?.abilities?.scores?.length ?? 0`.
    let roll_index = match defined(path(rolls, &["abilities", "scores"])) {
        Some(Value::Array(items)) => int(items.len() as i64),
        Some(Value::String(text)) => int(text.encode_utf16().count() as i64),
        Some(Value::Object(map)) => defined(map.get("length")).cloned().unwrap_or_else(|| int(0)),
        _ => int(0),
    };
    if js::number(Some(&roll_index)) >= 6.0 {
        return invalid("Броски уже сохранены: распределите имеющиеся значения", "CHARACTER_ABILITIES_ALREADY_ROLLED");
    }
    let requested = prop(Some(command), "roll_index");
    let is_integer = requested.and_then(Value::as_f64).is_some_and(|value| value.is_finite() && value.fract() == 0.0);
    if !is_integer || !strict_eq(requested, Some(&roll_index)) {
        return invalid("Этот бросок уже выполнен или запрошен не по порядку. Продолжите с очередного броска.", "CHARACTER_ABILITY_ROLL_INDEX_CONFLICT");
    }
    Ok(json!({
        "command_type": "RollCharacterAbilities",
        "actor_id": actor_id,
        "roll_index": roll_index,
        "target_id": actor_id,
        "target_ids": [actor_id],
        "source_rule_ids": [format!("{DND_2014_RULESET_ID}:resources:spending")],
        "visibility": "party",
    }))
}

/// `characterImportEvent(command)`: событие `CharacterImported`.
pub fn character_import_event(command: Option<&Value>) -> LifecycleResult<Value> {
    let command = match command {
        Some(command) if is_str(command.get("command_type"), "ImportCharacter") && js::truthy(command.get("actor_id")) && command.get("patch").is_some_and(Value::is_object) => command,
        _ => return invalid("Нужна валидированная команда ImportCharacter", "INVALID_CHARACTER_IMPORT_COMMAND"),
    };
    let field = |key: &str| command.get(key);
    let or_null = |key: &str| defined(field(key)).cloned().unwrap_or(Value::Null);
    let mut payload = Map::new();
    payload.insert("schema".into(), json!(CHARACTER_IMPORT_SCHEMA));
    payload.insert("schema_version".into(), int(CHARACTER_IMPORT_SCHEMA_VERSION));
    payload.insert("ruleset_id".into(), defined(field("ruleset_id")).cloned().unwrap_or_else(|| json!(LEGACY_DEFAULT_RULESET_ID)));
    payload.insert("starter_equipment_policy_id".into(), or_null("starter_equipment_policy_id"));
    payload.insert("starter_equipment_policy_version".into(), or_null("starter_equipment_policy_version"));
    payload.insert("species_policy_version".into(), or_null("species_policy_version"));
    payload.insert("patch".into(), field("patch").cloned().unwrap_or(Value::Null));
    if js::truthy(field("creation_result")) {
        payload.insert("phb_creation_result".into(), field("creation_result").cloned().unwrap_or(Value::Null));
    }
    let mut event = Map::new();
    event.insert("event_type".into(), json!("CharacterImported"));
    put(&mut event, "actor_id", field("actor_id"));
    event.insert("target_ids".into(), Value::Array(vec![field("actor_id").cloned().unwrap_or(Value::Null)]));
    event.insert("source_rule_ids".into(), spread_source_rules(command, DEFAULT_SOURCE_RULE)?);
    event.insert("visibility".into(), nullish(field("visibility"), Some(&json!("party"))).cloned().unwrap_or_else(|| json!("party")));
    event.insert("payload".into(), Value::Object(payload));
    Ok(Value::Object(event))
}

/// `resolveLevelUp(command, state, context)`: `{ command, event, state, sheet }`.
pub fn resolve_level_up(command: Option<&Value>, state: Option<&Value>, context: Option<&Value>) -> LifecycleResult<Value> {
    let validated = validate_level_up_command(command, state, context)?;
    let event = level_up_event(Some(&validated))?;
    let state_after = apply_character_lifecycle_event(state.unwrap_or(&Value::Null), &event)?;
    let actor = actor_from_state(Some(&state_after), validated["actor_id"].as_str().unwrap_or(""))?;
    let mut options = Map::new();
    put(&mut options, "rulesetId", prop(Some(&state_after), "ruleset_id"));
    let sheet = derive_character_sheet(Some(actor), Some(&Value::Object(options)))?;
    Ok(json!({ "command": validated, "event": event, "state": state_after, "sheet": sheet }))
}

/// `isCharacterLifecycleEvent(event)`.
pub fn is_character_lifecycle_event(event: Option<&Value>) -> bool {
    let event_type = js::s(prop(event, "event_type"));
    CHARACTER_LIFECYCLE_EVENT_TYPES.contains(&event_type.as_str())
}

/// `value?.[0]`: элемент массива, символ строки, поле `"0"` объекта.
fn first_of(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => items.first().cloned(),
        Some(Value::String(text)) => text.encode_utf16().next().map(|unit| Value::String(String::from_utf16_lossy(&[unit]))),
        Some(Value::Object(map)) => map.get("0").cloned(),
        _ => None,
    }
}

/// `applyCharacterLifecycleEvent(state, event)`: чистый редьюсер событий
/// героя; `state_version` ведёт хранилище событий.
pub fn apply_character_lifecycle_event(state: &Value, event: &Value) -> LifecycleResult<Value> {
    if !is_character_lifecycle_event(Some(event)) {
        return Ok(state.clone());
    }
    let mut next = if state.is_null() { json!({}) } else { state.clone() };
    let target = first_of(event.get("target_ids"));
    let actor_id = js::s(nullish(target.as_ref(), event.get("actor_id")));
    let index = players_of(Some(&next))?.iter().position(|candidate| js::string(prop(Some(candidate), "id")) == actor_id);
    let Some(index) = index else {
        return invalid(format!("Событие {} ссылается на отсутствующего героя", js::string(event.get("event_type"))), "ACTOR_NOT_FOUND");
    };
    let actor = next["players"][index].clone();
    if actor.is_null() {
        return Err(CharacterLifecycleError::runtime("Cannot read properties of null (reading 'characterSetupRequired')"));
    }
    let empty = json!({});
    let payload = defined(event.get("payload")).unwrap_or(&empty);
    let field = |key: &str| prop(Some(payload), key);
    let event_ruleset_id = js::s(Some(nullish(nullish(field("ruleset_id"), prop(Some(&next), "ruleset_id")), Some(&json!(LEGACY_DEFAULT_RULESET_ID))).unwrap_or(&Value::Null)));
    let updated = if is_str(event.get("event_type"), "CharacterImported") {
        apply_import(&next, &actor, payload, &event_ruleset_id)?
    } else {
        apply_level_up(&next, &actor, payload, &event_ruleset_id)?
    };
    next["players"][index] = updated;
    Ok(next)
}

fn apply_import(next: &Value, actor: &Value, payload: &Value, event_ruleset_id: &str) -> LifecycleResult<Value> {
    let field = |key: &str| prop(Some(payload), key);
    let state_ruleset = prop(Some(next), "ruleset_id");
    if js::truthy(field("ruleset_id")) && js::truthy(state_ruleset) && event_ruleset_id != js::string(state_ruleset) {
        return invalid("Событие героя принадлежит другой редакции", "IMPORT_RULESET_MISMATCH");
    }
    let mut raw = Map::new();
    put(&mut raw, "schema", field("schema"));
    put(&mut raw, "schema_version", field("schema_version"));
    put(&mut raw, "character", field("patch"));
    let parsed = parse_character_import(
        Some(&Value::Object(raw)),
        &ImportOptions { allow_legacy_ability_policy: true, ruleset_id: Some(event_ruleset_id), recorded_creation: field("phb_creation_result"), ..ImportOptions::default() },
    )?;
    let patch = &parsed.patch;
    let was_character_slot = js::is_true(actor.get("characterSetupRequired"));
    let ability_generation = patch.get("abilityGeneration").filter(|value| js::truthy(Some(value)));
    let mut species_benefits = match ability_generation {
        Some(generation) => species_benefits_for(&js::s(generation.get("speciesOptionId")), event_ruleset_id, patch.get("speciesChoices"))?,
        None => None,
    };
    let version_source = nullish(field("species_policy_version"), path(ability_generation, &["policyVersion"]));
    let version_raw = js::number(version_source);
    let species_policy_version = js_max(1.0, if version_raw.is_nan() || version_raw == 0.0 { 1.0 } else { version_raw });
    if let Some(Value::Object(benefits)) = species_benefits.as_mut() {
        if event_ruleset_id == DND_2014_RULESET_ID && species_policy_version < 2.0 {
            benefits.insert("choices".into(), json!({}));
            benefits.insert("skill_proficiencies".into(), json!([]));
            benefits.insert("tool_proficiencies".into(), json!([]));
            benefits.insert("innate_spells".into(), json!([]));
            benefits.insert("mechanics".into(), json!({}));
            benefits.insert("traits_supported".into(), json!(false));
        }
    }
    let imported_role = if !patch.contains_key("role") && is_str(actor.get("role"), UNCLAIMED_CHARACTER_ROLE) {
        let class_value = patch.get("characterClass");
        let label = class_option_for(class_value).and_then(|option| defined(option.get("label")).cloned());
        let label = match &label {
            Some(label) => js::string(Some(label)),
            None => js::string(class_value),
        };
        Some(format!("{label} · ур. {}", js::string(patch.get("level"))))
    } else {
        None
    };
    let mut merged = spread_of(Some(actor));
    for (key, value) in patch {
        merged.insert(key.clone(), value.clone());
    }
    for key in &parsed.patch_unset {
        merged.shift_remove(*key);
    }
    if let Some(role) = imported_role {
        merged.insert("role".into(), Value::String(role));
    }
    if let Some(creation) = parsed.creation.as_ref().filter(|creation| js::truthy(Some(creation))) {
        put(&mut merged, "creationBenefits", creation.get("benefits"));
        if creation.get("benefits").is_none() {
            merged.shift_remove("creationBenefits");
        }
        match creation.get("additionalSkills") {
            Some(value) => {
                merged.insert("creationSkillProficiencies".into(), value.clone());
            }
            None => {
                merged.shift_remove("creationSkillProficiencies");
            }
        }
        match path(Some(creation), &["benefits", "spell_grants"]) {
            Some(value) => {
                merged.insert("creationSpellGrants".into(), value.clone());
            }
            None => {
                if creation.get("benefits").is_some_and(Value::is_null) {
                    return Err(CharacterLifecycleError::runtime("Cannot read properties of null (reading 'spell_grants')"));
                }
                merged.shift_remove("creationSpellGrants");
            }
        }
    }
    match actor.get("id") {
        Some(id) => {
            merged.insert("id".into(), id.clone());
        }
        None => {
            merged.shift_remove("id");
        }
    }
    merged.insert("inventory".into(), defined(actor.get("inventory")).cloned().unwrap_or_else(|| json!([])));
    merged.insert("currency".into(), defined(actor.get("currency")).cloned().unwrap_or_else(|| json!({})));
    merged.insert("speciesBenefits".into(), species_benefits.clone().unwrap_or(Value::Null));
    let benefits = species_benefits.as_ref();
    merged.insert("speciesSkillProficiencies".into(), defined(prop(benefits, "skill_proficiencies")).cloned().unwrap_or_else(|| json!([])));
    merged.insert("speciesToolProficiencies".into(), defined(prop(benefits, "tool_proficiencies")).cloned().unwrap_or_else(|| json!([])));
    merged.insert("speciesLanguages".into(), defined(prop(benefits, "languages")).cloned().unwrap_or_else(|| json!([])));
    merged.insert("speciesSpellIds".into(), innate_spell_ids(prop(benefits, "innate_spells"))?);
    let mut updated = with_background_benefits(Some(&Value::Object(merged)), event_ruleset_id)?;
    let wealth = parsed.creation.as_ref().and_then(|creation| prop(Some(creation), "wealth")).filter(|wealth| js::truthy(Some(wealth)));
    if was_character_slot && wealth.is_some() {
        let wealth = wealth.cloned().unwrap_or(Value::Null);
        let currency = wealth.get("remaining_currency");
        if !js::present(currency) {
            return Err(CharacterLifecycleError::runtime("Cannot read properties of undefined (reading 'gold')"));
        }
        if let Some(map) = updated.as_object_mut() {
            put(map, "inventory", wealth.get("inventory"));
            if wealth.get("inventory").is_none() {
                map.shift_remove("inventory");
            }
            let mut coins = Map::new();
            for coin in ["gold", "silver", "copper"] {
                put(&mut coins, coin, prop(currency, coin));
            }
            coins.insert("platinum".into(), int(0));
            map.insert("currency".into(), Value::Object(coins));
        }
        set_initials(&mut updated)?;
    } else if was_character_slot {
        let mut base = spread_of(Some(&updated));
        base.insert("inventory".into(), json!([]));
        base.insert("currency".into(), json!({ "copper": 0, "silver": 0, "gold": 0, "platinum": 0 }));
        let options = StarterKitOptions {
            ruleset_id: event_ruleset_id.to_string(),
            starter_policy_version: Some(defined(field("starter_equipment_policy_version")).cloned().unwrap_or_else(|| int(1))),
            starter_policy_id: field("starter_equipment_policy_id").and_then(Value::as_str).map(String::from),
            complete: false,
        };
        updated = with_starter_kit(Some(&Value::Object(base)), &options)?;
        set_initials(&mut updated)?;
    }
    let sheet = derive_character_sheet(Some(&updated), Some(&json!({ "rulesetId": event_ruleset_id })))?;
    let maximum = js::number(sheet["hit_points"].get("value"));
    let hp = if was_character_slot {
        maximum
    } else {
        let raw = js::number(actor.get("hp"));
        js_min(js_max(0.0, if raw.is_nan() || raw == 0.0 { maximum } else { raw }), maximum)
    };
    let target_level = character_creation_target_level(Some(next))?;
    let level = normalized_level(updated.get("level"))?;
    if let Some(map) = updated.as_object_mut() {
        map.insert("maxHp".into(), js::num(maximum));
        map.insert("hp".into(), js::num(hp));
        let required = was_character_slot && target_level > level;
        map.insert("characterSetupRequired".into(), json!(required));
        if required {
            map.insert("characterSetupStage".into(), json!("leveling"));
        } else {
            map.shift_remove("characterSetupStage");
        }
    }
    Ok(updated)
}

/// `(innate_spells ?? []).map((entry) => entry.id)`.
fn innate_spell_ids(value: Option<&Value>) -> LifecycleResult<Value> {
    match defined(value) {
        None => Ok(json!([])),
        Some(Value::Array(items)) => items
            .iter()
            .map(|entry| match entry {
                Value::Null => Err(CharacterLifecycleError::runtime("Cannot read properties of null (reading 'id')")),
                other => Ok(defined(prop(Some(other), "id")).cloned().unwrap_or(Value::Null)),
            })
            .collect::<LifecycleResult<Vec<_>>>()
            .map(Value::Array),
        Some(_) => Err(CharacterLifecycleError::runtime("innate_spells.map is not a function")),
    }
}

/// `updated.initials = updated.character.slice(0, 2).toLocaleUpperCase('ru')`.
fn set_initials(updated: &mut Value) -> LifecycleResult<()> {
    let initials = match updated.get("character") {
        Some(Value::String(character)) => text::upper(&utf16_head(character, 2)),
        _ => return Err(CharacterLifecycleError::runtime("updated.character.slice is not a function")),
    };
    if let Some(map) = updated.as_object_mut() {
        map.insert("initials".into(), Value::String(initials));
    }
    Ok(())
}

fn apply_level_up(next: &Value, actor: &Value, payload: &Value, event_ruleset_id: &str) -> LifecycleResult<Value> {
    let field = |key: &str| prop(Some(payload), key);
    let previous_level = normalized_level(actor.get("level"))?;
    let level_after = integer(field("level_after"), "event.level_after", 1, MAX_LEVEL, None)?;
    if level_after != previous_level + 1 {
        return invalid("Событие LevelUp должно повышать уровень ровно на один", "LEVEL_UP_STEP_INVALID");
    }
    let hit_die = hit_die_for(Some(actor));
    let roll = integer(field("hit_point_roll"), "event.hit_point_roll", 1, hit_die, None)?;
    let experience_fallback = defined(actor.get("experience")).cloned().unwrap_or_else(|| int(0));
    let experience = integer(field("experience"), "event.experience", 0, MAX_EXPERIENCE, Some(&experience_fallback))?;
    let mut increases = normalized_hit_point_increases(Some(actor), Some(previous_level), Some(hit_die))?;
    increases.push(roll);
    let mut updated = spread_of(Some(actor));
    updated.insert("level".into(), int(level_after));
    updated.insert("experience".into(), int(experience));
    updated.insert("hitPointIncreases".into(), Value::Array(increases.into_iter().map(int).collect()));
    let mut updated = Value::Object(updated);
    let hit_points = derive_maximum_hit_points(Some(&updated), Some(level_after), None)?;
    let maximum = js::number(hit_points.get("value"));
    let creation = is_str(field("progression_source"), "character_creation");
    let hp = if creation {
        maximum
    } else {
        let raw = js::number(updated.get("hp"));
        js_min(js_max(0.0, if raw.is_nan() { 0.0 } else { raw }), maximum)
    };
    if let Some(map) = updated.as_object_mut() {
        map.insert("maxHp".into(), js::num(maximum));
        map.insert("hp".into(), js::num(hp));
    }
    if creation {
        let target_level = character_creation_target_level(Some(next))?;
        if !is_str(actor.get("characterSetupStage"), "leveling") || level_after > target_level {
            return invalid("Событие поэтапного создания героя вышло за пределы стартового уровня", "CHARACTER_CREATION_LEVEL_INVALID");
        }
        let required = level_after < target_level || !character_creation_choices_complete(Some(&updated), Some(&json!({ "rulesetId": event_ruleset_id })))?;
        if let Some(map) = updated.as_object_mut() {
            map.insert("characterSetupRequired".into(), json!(required));
            if required {
                map.insert("characterSetupStage".into(), json!("leveling"));
            } else {
                map.shift_remove("characterSetupStage");
            }
        }
    }
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Импорт
// ---------------------------------------------------------------------------

fn migrate_v0_character(source: Option<&Value>) -> LifecycleResult<Map<String, Value>> {
    let Some(Value::Object(source)) = source else {
        return invalid("character v0 должен быть объектом", "IMPORT_INVALID_SHAPE");
    };
    let mut migrated = Map::new();
    for (key, value) in js::entries(source) {
        let destination = IMPORT_V0_ALIASES.iter().find(|(alias, _)| *alias == key.as_str()).map_or(key.as_str(), |(_, destination)| *destination);
        if !IMPORT_CHARACTER_V1.contains(&destination) {
            return invalid(format!("character v0 содержит неподдерживаемое поле: {key}"), "IMPORT_UNKNOWN_FIELD");
        }
        if let Some(existing) = migrated.get(destination) {
            if js::stringify(existing) != js::stringify(value) {
                return invalid(format!("character v0 содержит конфликтующие {key} и {destination}"), "IMPORT_MIGRATION_CONFLICT");
            }
        }
        migrated.insert(destination.to_string(), value.clone());
    }
    Ok(migrated)
}

/// `migrateCharacterImport(raw)`: строгая миграция задокументированных
/// псевдонимов v0; незнакомое поле или конфликт — отказ.
pub fn migrate_character_import(raw: Option<&Value>) -> LifecycleResult<Value> {
    if !js::is_plain(raw) {
        return invalid("Импорт должен быть JSON-объектом", "IMPORT_INVALID_SHAPE");
    }
    exact_keys(raw, &IMPORT_TOP_LEVEL_V1, "import")?;
    if !is_str(prop(raw, "schema"), CHARACTER_IMPORT_SCHEMA) {
        return invalid(format!("schema должен быть {CHARACTER_IMPORT_SCHEMA}"), "IMPORT_SCHEMA_UNSUPPORTED");
    }
    let version = integer(prop(raw, "schema_version"), "schema_version", 0, CHARACTER_IMPORT_SCHEMA_VERSION, None)?;
    if version == CHARACTER_IMPORT_SCHEMA_VERSION {
        exact_keys(prop(raw, "character"), &IMPORT_CHARACTER_V1, "character")?;
        return Ok(json!({ "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": CHARACTER_IMPORT_SCHEMA_VERSION, "character": prop(raw, "character") }));
    }
    let character = migrate_v0_character(prop(raw, "character"))?;
    Ok(json!({ "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": CHARACTER_IMPORT_SCHEMA_VERSION, "character": character }))
}

fn optional_text(value: Option<&Value>, field: &str, maximum: usize) -> LifecycleResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(_)) => Ok(Some(clean_text(value, maximum))),
        Some(_) => invalid(format!("{field} должен быть строкой"), "IMPORT_INVALID_FIELD"),
    }
}

/// Опции `parseCharacterImport`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOptions<'a> {
    /// `rulesetId`; `None` — `LEGACY_DEFAULT_RULESET_ID`.
    pub ruleset_id: Option<&'a str>,
    /// Повтор записанного события: прежние характеристики без политики.
    pub allow_legacy_ability_policy: bool,
    pub validate_creation_languages: bool,
    pub trusted_ability_roll: Option<&'a Value>,
    pub trusted_wealth_roll: Option<&'a Value>,
    /// `recordedCreation`: записанный итог создания PHB из события.
    pub recorded_creation: Option<&'a Value>,
}

/// Итог `parseCharacterImport`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedImport {
    pub document: Value,
    /// `creation` (итог создания PHB); `None` — `null` JS.
    pub creation: Option<Value>,
    pub patch: Map<String, Value>,
    /// Поля патча, которые JS держит ключом со значением `undefined`: в JSON
    /// их нет, но `{ ...actor, ...patch }` стирает их у героя.
    pub patch_unset: Vec<&'static str>,
    pub sheet: Value,
}

impl ParsedImport {
    /// Форма JS: `{ document, creation, patch, sheet }`.
    pub fn to_value(&self) -> Value {
        json!({ "document": self.document, "creation": self.creation.clone().unwrap_or(Value::Null), "patch": self.patch, "sheet": self.sheet })
    }
}

/// Тело `try` создания PHB (`resolvePhbCreation` и покупки за стартовое
/// богатство); любое исключение заворачивается в `IMPORT_PHB_CHOICES_INVALID`.
fn resolve_import_phb(source: &mut Map<String, Value>, class_id: &str, options: &ImportOptions<'_>, ruleset_id: &str) -> LifecycleResult<Option<Value>> {
    if js::truthy(source.get("phbCreation")) && ruleset_id != DND_2014_RULESET_ID {
        return Err(CharacterLifecycleError::plain("Создание PHB требует редакцию 2014"));
    }
    let source_value = Value::Object(source.clone());
    let mut phb = if options.allow_legacy_ability_policy && js::truthy(options.recorded_creation) {
        options.recorded_creation.cloned()
    } else {
        resolve_phb_creation(Some(&source_value))?
    };
    if js::truthy(phb.as_ref()) {
        let creation = source.get("phbCreation");
        if !js::present(creation) {
            return Err(CharacterLifecycleError::runtime("Cannot read properties of undefined (reading 'equipmentMode')"));
        }
        if is_str(prop(creation, "equipmentMode"), "wealth") && !js::truthy(options.recorded_creation) {
            let roll = options.trusted_wealth_roll;
            if !js::truthy(roll) || !strict_eq(prop(roll, "id"), prop(creation, "wealthRollId")) {
                return Err(CharacterLifecycleError::plain("Нужен сохранённый серверный бросок стартового богатства этого героя"));
            }
            let purchases = prop(creation, "purchases");
            let items = match purchases {
                Some(Value::Array(items)) if items.len() <= 250 => items.clone(),
                _ => return Err(CharacterLifecycleError::plain("Покупки должны быть списком до 250 позиций")),
            };
            let result = resolve_starting_purchases(Some(&json!(class_id)), roll, purchases);
            if !js::truthy(result.get("ok")) {
                return Err(CharacterLifecycleError::plain(js::s(result.get("reason"))));
            }
            let purchased = items
                .iter()
                .map(|item| match item {
                    Value::Null => Err(CharacterLifecycleError::runtime("Cannot read properties of null (reading 'id')")),
                    other => {
                        let mut entry = Map::new();
                        put(&mut entry, "id", prop(Some(other), "id"));
                        put(&mut entry, "quantity", prop(Some(other), "quantity"));
                        Ok(Value::Object(entry))
                    }
                })
                .collect::<LifecycleResult<Vec<_>>>()?;
            let Some(Value::Object(phb_map)) = phb.as_mut() else {
                return Err(CharacterLifecycleError::runtime("Cannot create property 'wealth' on a non-object"));
            };
            phb_map.insert("wealth".into(), result);
            let Some(Value::Object(value)) = phb_map.get_mut("value") else {
                return Err(CharacterLifecycleError::runtime("Cannot set properties of undefined (setting 'equipmentMode')"));
            };
            value.insert("equipmentMode".into(), json!("wealth"));
            put(value, "wealthRollId", prop(roll, "id"));
            if prop(roll, "id").is_none() {
                value.shift_remove("wealthRollId");
            }
            value.insert("purchases".into(), Value::Array(purchased));
        }
    }
    Ok(phb)
}

/// `parseCharacterImport(raw, options)`: документ v1 → безопасный патч героя.
/// В итоге намеренно нет id, хитов, КД, мастерства, скорости, инвентаря,
/// денег и ресурсов.
pub fn parse_character_import(raw: Option<&Value>, options: &ImportOptions<'_>) -> LifecycleResult<ParsedImport> {
    let ruleset_id = options.ruleset_id.unwrap_or(LEGACY_DEFAULT_RULESET_ID);
    let is_2014 = ruleset_id == DND_2014_RULESET_ID;
    let creation_policy = character_creation_policy_for(ruleset_id)?;
    let mut document = migrate_character_import(raw)?;
    let mut source = match document.get("character") {
        Some(Value::Object(map)) => map.clone(),
        other => {
            exact_keys(other, &IMPORT_CHARACTER_V1, "character")?;
            Map::new()
        }
    };
    exact_keys(Some(&Value::Object(source.clone())), &IMPORT_CHARACTER_V1, "character")?;
    let field = |source: &Map<String, Value>, key: &str| source.get(key).cloned();
    let character = optional_text(source.get("character"), "character.character", 120)?.unwrap_or_default();
    if character.is_empty() {
        return invalid("character.character обязателен", "IMPORT_REQUIRED_FIELD");
    }
    let class_id = clean_identifier(source.get("characterClass"), "character.characterClass")?;
    if class_key(Some(&json!({ "characterClass": class_id }))).is_none() {
        return invalid("Импорт ссылается на неподдерживаемый класс", "CHARACTER_CLASS_UNSUPPORTED");
    }
    let experience = integer(source.get("experience"), "character.experience", 0, MAX_EXPERIENCE, None)?;
    let level = normalized_level(source.get("level"))?;
    if level != level_for_experience(Some(&int(experience)))? {
        return invalid("Уровень должен соответствовать порогу XP текущего ruleset", "IMPORT_LEVEL_EXPERIENCE_MISMATCH");
    }
    let abilities = normalized_abilities(source.get("abilities"))?;
    let mut phb = resolve_import_phb(&mut source, &class_id, options, ruleset_id).map_err(|error| error.wrapped("IMPORT_PHB_CHOICES_INVALID"))?;
    let phb_present = js::truthy(phb.as_ref());
    let additional = if phb_present { Some(prop(phb.as_ref(), "abilityBonuses").cloned()) } else { None };
    let ability_generation = validate_ability_generation(
        source.get("abilityGeneration"),
        &abilities,
        &AbilityGenerationOptions {
            allow_legacy_ability_policy: options.allow_legacy_ability_policy,
            ruleset_id,
            trusted_ability_roll: options.trusted_ability_roll,
            additional_ability_bonuses: additional.as_ref().and_then(Option::as_ref),
        },
    )?;
    let base_speed = integer(source.get("baseSpeed"), "character.baseSpeed", 5, 120, None)?;
    let mut derived_species = String::new();
    let mut resolved_species_benefits: Option<Value> = None;
    if let Some(generation) = &ability_generation {
        let species_id = js::s(generation.get("speciesOptionId"));
        let species_option = species_option_for(&species_id, ruleset_id)?.unwrap_or(Value::Null);
        let option_id = js::s(species_option.get("id"));
        let label = js::s(species_option.get("label"));
        let requested_species = optional_text(source.get("species"), "character.species", 120)?.unwrap_or_default();
        if !requested_species.is_empty() && option_id != "custom" && !strict_eq(Some(&json!(requested_species)), species_option.get("label")) {
            return invalid("Вид персонажа не соответствует выбранному серверному варианту", "IMPORT_SPECIES_UNSUPPORTED");
        }
        if option_id == "custom" && requested_species.is_empty() {
            return invalid("Авторский вид требует явного названия в character.species", "IMPORT_SPECIES_UNSUPPORTED");
        }
        derived_species = if requested_species.is_empty() { label } else { requested_species };
        if !strict_eq(Some(&int(base_speed)), species_option.get("base_speed")) {
            return invalid("Базовая скорость не соответствует выбранному серверному виду", "IMPORT_SPECIES_SPEED_INVALID");
        }
        let raw_species_choices = match defined(source.get("speciesChoices")) {
            Some(value) => value.clone(),
            None => default_species_choices(&option_id, ruleset_id)?.filter(|value| !value.is_null()).unwrap_or_else(|| json!({})),
        };
        if !raw_species_choices.is_object() {
            return invalid("speciesChoices должен быть объектом", "IMPORT_SPECIES_CHOICE_INVALID");
        }
        let resolved = resolve_species_choices(&option_id, Some(&raw_species_choices), ruleset_id)?;
        if !js::truthy(resolved.get("ok")) {
            return invalid(js::s(resolved.get("reason")), "IMPORT_SPECIES_CHOICE_INVALID");
        }
        let choices = resolved.get("choices").cloned();
        // `source.speciesChoices = resolvedChoices.choices`: правка видна и в
        // возвращаемом документе.
        match &choices {
            Some(choices) => {
                source.insert("speciesChoices".into(), choices.clone());
            }
            None => {
                source.shift_remove("speciesChoices");
            }
        }
        if let Some(Value::Object(character)) = document.get_mut("character") {
            match &choices {
                Some(choices) => {
                    character.insert("speciesChoices".into(), choices.clone());
                }
                None => {
                    character.shift_remove("speciesChoices");
                }
            }
        }
        resolved_species_benefits = species_benefits_for(&option_id, ruleset_id, choices.as_ref())?;
    }
    let mut provisional = Map::new();
    if phb_present {
        put(&mut provisional, "creationBenefits", prop(phb.as_ref(), "benefits"));
    }
    provisional.insert("character".into(), json!(character));
    provisional.insert("characterClass".into(), json!(class_id));
    provisional.insert("level".into(), int(level));
    provisional.insert("experience".into(), int(experience));
    provisional.insert("abilities".into(), abilities.to_value());
    if let Some(generation) = &ability_generation {
        provisional.insert("abilityGeneration".into(), generation.clone());
    }
    provisional.insert("baseSpeed".into(), int(base_speed));
    if js::present(source.get("subclass")) {
        put(&mut provisional, "subclass", optional_text(source.get("subclass"), "character.subclass", 160)?.map(Value::String).as_ref());
    }
    let list = |key: &str| field(&source, key).filter(|value| !value.is_null()).unwrap_or_else(|| json!([]));
    let class_skills = unique_in_order(unique_identifiers(Some(&list("classSkillProficiencies")), "character.classSkillProficiencies", 100)?.iter().map(|id| catalog_skill_id(Some(&json!(id)))).collect());
    let selected_features = unique_identifiers(Some(&list("selectedFeatureIds")), "character.selectedFeatureIds", 100)?;
    let known_spells = unique_identifiers(Some(&list("knownSpellIds")), "character.knownSpellIds", 100)?;
    let prepared_spells = unique_identifiers(Some(&list("preparedSpellIds")), "character.preparedSpellIds", 100)?;
    provisional.insert("classSkillProficiencies".into(), strings(&class_skills));
    provisional.insert("selectedFeatureIds".into(), strings(&selected_features));
    provisional.insert("knownSpellIds".into(), strings(&known_spells));
    provisional.insert("preparedSpellIds".into(), strings(&prepared_spells));
    let hit_die = hit_die_for(Some(&Value::Object(provisional.clone())));
    let raw_increases = match defined(source.get("hitPointIncreases")) {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return invalid("character.hitPointIncreases должен быть массивом", "IMPORT_INVALID_FIELD"),
    };
    let increases = raw_increases
        .iter()
        .enumerate()
        .map(|(index, entry)| integer(Some(entry), &format!("character.hitPointIncreases.{index}"), 1, hit_die, None))
        .collect::<LifecycleResult<Vec<_>>>()?;
    if increases.len() as i64 > level - 1 {
        return invalid("character.hitPointIncreases длиннее истории уровней", "IMPORT_INVALID_FIELD");
    }
    provisional.insert("hitPointIncreases".into(), Value::Array(increases.into_iter().map(int).collect()));
    let Canonical { actor: mut canonical, unset } = canonical_character_choices(provisional.clone());
    canonical.shift_remove("creationBenefits");
    if phb_present {
        canonical.insert("phbCreation".into(), prop(phb.as_ref(), "value").cloned().unwrap_or(Value::Null));
        let mut rules_actor = provisional.clone();
        rules_actor.insert("abilities".into(), abilities.to_value());
        let rules = spell_selection_rules_for(Some(&Value::Object(rules_actor)));
        let selected: Vec<Value> = phb_first_level_spells()?.into_iter().filter(|spell| spell.get("id").and_then(Value::as_str).is_some_and(|id| known_spells.iter().any(|known| known == id))).collect();
        if let Some(rules) = &rules {
            let cantrips = selected.iter().filter(|spell| strict_eq(spell.get("level"), Some(&int(0)))).count() as f64;
            if cantrips != rules.cantrips {
                return invalid(format!("Выберите {} классовых заговоров", js::f64_string(rules.cantrips)), "IMPORT_PHB_SPELL_COUNT_INVALID");
            }
            let expected = match rules.mode {
                "known" => Some(rules.spells_known),
                "spellbook" => Some(rules.spellbook_minimum),
                _ => None,
            };
            if let Some(expected) = expected {
                if selected.iter().filter(|spell| strict_eq(spell.get("level"), Some(&int(1)))).count() as f64 != expected {
                    return invalid(format!("Выберите {} известных заклинаний первого круга", js::f64_string(expected)), "IMPORT_PHB_SPELL_COUNT_INVALID");
                }
            }
        }
    }
    let requested_subclass = js::s(provisional.get("subclass"));
    let canonical_strings = |key: &str| -> Vec<String> { array_of(canonical.get(key)).iter().map(|value| js::s(Some(value))).collect() };
    if (!requested_subclass.is_empty() && !is_str(canonical.get("subclass"), &requested_subclass))
        || !same_string_set(&class_skills, &canonical_strings("classSkillProficiencies"))
        || !same_string_set(&selected_features, &canonical_strings("selectedFeatureIds"))
        || !same_string_set(&known_spells, &canonical_strings("knownSpellIds"))
        || !same_string_set(&prepared_spells, &canonical_strings("preparedSpellIds"))
    {
        return invalid("Импорт содержит недоступный выбор класса, особенности или заклинания", "IMPORT_CHARACTER_CHOICE_INVALID");
    }
    for (key, maximum) in [("name", 120), ("role", 160), ("species", 120), ("background", 160), ("alignment", 120), ("traits", 2_000), ("ideals", 2_000), ("bonds", 2_000), ("flaws", 2_000), ("backstory", 8_000), ("notes", 8_000)] {
        if let Some(value) = optional_text(source.get(key), &format!("character.{key}"), maximum)? {
            canonical.insert(key.into(), Value::String(value));
        }
    }
    if !derived_species.is_empty() {
        canonical.insert("species".into(), Value::String(derived_species));
    }
    if ability_generation.is_some() {
        canonical.insert("speciesChoices".into(), defined(source.get("speciesChoices")).cloned().unwrap_or_else(|| json!({})));
    }
    let background_id = optional_text(source.get("backgroundId"), "character.backgroundId", 60)?.unwrap_or_default();
    if !background_id.is_empty() {
        let customization = resolve_background_customization(path(Some(&Value::Object(source.clone())), &["backgroundChoices", "customization"]))
            .map_err(|error| CharacterLifecycleError::from(error).wrapped("IMPORT_BACKGROUND_CUSTOM_INVALID"))?;
        let customization = customization.filter(|value| js::truthy(Some(value)));
        if customization.is_some() && !is_2014 {
            return invalid("Настройка предыстории доступна только для PHB 2014", "IMPORT_BACKGROUND_CUSTOM_INVALID");
        }
        let Some(background) = background_by_id(&background_id, ruleset_id, customization.as_ref())?.filter(|value| js::truthy(Some(value))) else {
            return invalid("Такой предыстории нет в каталоге", "IMPORT_BACKGROUND_UNKNOWN");
        };
        let ability_choice = defined(source.get("backgroundAbilityChoice")).cloned().unwrap_or_else(|| json!({}));
        let resolved = resolve_background_ability_choice(&background_id, Some(&ability_choice), ruleset_id)?;
        if !js::truthy(resolved.get("ok")) {
            return invalid(js::s(resolved.get("reason")), "IMPORT_BACKGROUND_ABILITY_INVALID");
        }
        let declared = defined(path(canonical.get("abilityGeneration"), &["originBonuses"])).cloned().unwrap_or_else(|| json!({}));
        let from_background = is_str(creation_policy.get("bonus_source"), "background");
        let zero = int(0);
        let mismatch = from_background
            && ABILITY_IDS.iter().any(|ability| {
                let left = nullish(prop(Some(&declared), ability), Some(&zero));
                let right = nullish(path(Some(&resolved), &["bonuses", ability]), Some(&zero));
                !strict_eq(left, right)
            });
        if mismatch {
            return invalid("Бонусы происхождения не совпадают с прибавками выбранной предыстории", "IMPORT_BACKGROUND_ABILITY_INVALID");
        }
        put(&mut canonical, "backgroundId", background.get("id"));
        put(&mut canonical, "background", background.get("name"));
        if from_background {
            let keys: Vec<Value> = match resolved.get("bonuses") {
                Some(Value::Object(map)) => js::keys(map).into_iter().map(|key| Value::String(key.clone())).collect(),
                _ => Vec::new(),
            };
            let mut choice = Map::new();
            put(&mut choice, "mode", resolved.get("mode"));
            choice.insert("abilities".into(), Value::Array(keys));
            canonical.insert("backgroundAbilityChoice".into(), Value::Object(choice));
        }
        let raw_background_choices = match defined(source.get("backgroundChoices")) {
            Some(value) => value.clone(),
            None => default_background_choices(&background_id, ruleset_id)?.filter(|value| !value.is_null()).unwrap_or_else(|| json!({ "tools": [], "languages": [] })),
        };
        if !raw_background_choices.is_object() {
            return invalid("backgroundChoices должен быть объектом", "IMPORT_BACKGROUND_CHOICE_INVALID");
        }
        exact_keys(Some(&raw_background_choices), &["tools", "languages", "replacementSkills", "replacementTools", "customization"], "character.backgroundChoices")?;
        let raw_list = |key: &str| defined(raw_background_choices.get(key)).cloned().unwrap_or_else(|| json!([]));
        let tools = unique_identifiers(Some(&raw_list("tools")), "character.backgroundChoices.tools", 4)?;
        let languages = unique_identifiers(Some(&raw_list("languages")), "character.backgroundChoices.languages", 4)?;
        let mut background_choices = Map::new();
        if let Some(customization) = &customization {
            background_choices.insert("customization".into(), customization.clone());
        }
        background_choices.insert("tools".into(), strings(&tools));
        background_choices.insert("languages".into(), strings(&languages));
        let resolved_choices = resolve_background_choices(&background_id, Some(&Value::Object(background_choices)), ruleset_id)?;
        if !js::truthy(resolved_choices.get("ok")) {
            return invalid(js::s(resolved_choices.get("reason")), "IMPORT_BACKGROUND_CHOICE_INVALID");
        }
        let mut canonical_choices = Map::new();
        put(&mut canonical_choices, "tools", resolved_choices.get("tools"));
        put(&mut canonical_choices, "languages", resolved_choices.get("languages"));
        if let Some(customization) = &customization {
            canonical_choices.insert("customization".into(), customization.clone());
        }
        if is_2014 && options.validate_creation_languages {
            if let Some(benefits) = resolved_species_benefits.as_ref().filter(|value| !value.is_null()) {
                let species_languages = benefits.get("languages");
                for id in array_of(resolved_choices.get("languages")) {
                    let found = match species_languages {
                        Some(Value::Array(items)) => items.iter().any(|entry| strict_eq(Some(entry), Some(id))),
                        Some(Value::String(text)) => id.as_str().is_some_and(|id| text.contains(id)),
                        _ => return Err(CharacterLifecycleError::runtime("Cannot read properties of undefined (reading 'includes')")),
                    };
                    if found {
                        return invalid("Язык предыстории уже известен от расы: выберите другой язык", "IMPORT_LANGUAGE_DUPLICATE");
                    }
                }
            }
        }
        if raw_background_choices.get("replacementSkills").is_some() {
            let mut skills: Vec<String> = class_skills_of(&canonical);
            skills.extend(catalog_skill_ids(prop(resolved_species_benefits.as_ref(), "skill_proficiencies")));
            if phb_present {
                skills.extend(catalog_skill_ids(prop(phb.as_ref(), "additionalSkills")));
            }
            skills.extend(catalog_skill_ids(background.get("skillProficiencies")));
            let known: HashSet<String> = skills.iter().cloned().collect();
            let count = if is_2014 { skills.len() - known.len() } else { 0 };
            let replacements: Vec<String> =
                unique_identifiers(raw_background_choices.get("replacementSkills"), "character.backgroundChoices.replacementSkills", 100)?.iter().map(|id| catalog_skill_id(Some(&json!(id)))).collect();
            let allowed: HashSet<String> = array_of(class_build_catalog_info().get("skills")).iter().map(|skill| catalog_skill_id(skill.get("id"))).collect();
            let distinct: HashSet<&String> = replacements.iter().collect();
            if replacements.len() != count || distinct.len() != count || replacements.iter().any(|id| !allowed.contains(id) || known.contains(id)) {
                return invalid(format!("Выберите {count} новых навыков взамен повторяющихся владений"), "IMPORT_SKILL_REPLACEMENT_INVALID");
            }
            canonical_choices.insert("replacementSkills".into(), strings(&replacements));
        }
        if phb_present {
            canonical_choices.insert("replacementTools".into(), defined(raw_background_choices.get("replacementTools")).cloned().unwrap_or_else(|| json!([])));
        }
        canonical.insert("backgroundChoices".into(), Value::Object(canonical_choices));
    }
    let raw_starter_choices = match defined(source.get("starterEquipmentChoices")) {
        Some(value) => value.clone(),
        None => default_starter_equipment_choices(Some(&json!(class_id)), ruleset_id, false).filter(|value| !value.is_null()).unwrap_or_else(|| json!({})),
    };
    if !raw_starter_choices.is_object() {
        return invalid("starterEquipmentChoices должен быть объектом", "IMPORT_STARTER_EQUIPMENT_INVALID");
    }
    let resolved_starter = resolve_starter_equipment_choices(Some(&json!(class_id)), Some(&raw_starter_choices), ruleset_id, phb_present);
    if !js::truthy(resolved_starter.get("ok")) {
        return invalid(js::s(resolved_starter.get("reason")), "IMPORT_STARTER_EQUIPMENT_INVALID");
    }
    if phb_present && class_id == "cleric" && !js::truthy(prop(phb.as_ref(), "wealth")) {
        for option in array_of(resolved_starter.get("selected_options")) {
            let items: Vec<&Value> = match defined(option.get("items")) {
                None => Vec::new(),
                Some(Value::Array(items)) => items.iter().collect(),
                Some(other) => vec![other],
            };
            for item in items {
                let catalog_id = prop(Some(item), "catalog_id");
                if is_str(catalog_id, "srd_5_2_1:chain-mail") && !includes_or_empty(path(phb.as_ref(), &["benefits", "armor_proficiencies"]), "heavy", "armor_proficiencies")? {
                    return invalid("Кольчуга жрецу доступна в стартовом наборе только при владении тяжёлыми доспехами", "IMPORT_STARTER_PROFICIENCY_REQUIRED");
                }
                if is_str(catalog_id, "srd_5_2_1:warhammer") {
                    let weapons = array_of(path(phb.as_ref(), &["benefits", "weapon_proficiencies"]));
                    if !weapons.iter().any(|id| is_str(Some(id), "martial") || is_str(Some(id), "warhammer")) {
                        return invalid("Для выбора боевого молота в стартовом наборе нужно владение им", "IMPORT_STARTER_PROFICIENCY_REQUIRED");
                    }
                }
            }
        }
    }
    if phb_present {
        background_equipment(&mut canonical, &mut phb).map_err(|error| error.wrapped("IMPORT_BACKGROUND_EQUIPMENT_INVALID"))?;
    }
    if ruleset_id != LEGACY_DEFAULT_RULESET_ID {
        canonical.insert("starterEquipmentChoices".into(), resolved_starter.get("choices").cloned().unwrap_or(Value::Null));
    }
    let mut enriched = Map::new();
    if phb_present {
        put(&mut enriched, "creationBenefits", prop(phb.as_ref(), "benefits"));
        put(&mut enriched, "creationSkillProficiencies", prop(phb.as_ref(), "additionalSkills"));
        put(&mut enriched, "creationSpellGrants", path(phb.as_ref(), &["benefits", "spell_grants"]));
    }
    for (key, value) in &canonical {
        enriched.insert(key.clone(), value.clone());
    }
    let benefits = resolved_species_benefits.as_ref();
    enriched.insert("speciesBenefits".into(), benefits.cloned().unwrap_or(Value::Null));
    enriched.insert("speciesSkillProficiencies".into(), defined(prop(benefits, "skill_proficiencies")).cloned().unwrap_or_else(|| json!([])));
    enriched.insert("speciesToolProficiencies".into(), defined(prop(benefits, "tool_proficiencies")).cloned().unwrap_or_else(|| json!([])));
    enriched.insert("speciesLanguages".into(), defined(prop(benefits, "languages")).cloned().unwrap_or_else(|| json!([])));
    enriched.insert("speciesSpellIds".into(), innate_spell_ids(prop(benefits, "innate_spells"))?);
    let with_background = with_background_benefits(Some(&Value::Object(enriched)), ruleset_id)?;
    let sheet = derive_character_sheet(Some(&with_background), Some(&json!({ "rulesetId": ruleset_id })))?;
    Ok(ParsedImport { document, creation: phb, patch: canonical, patch_unset: unset, sheet })
}

fn class_skills_of(canonical: &Map<String, Value>) -> Vec<String> {
    catalog_skill_ids(canonical.get("classSkillProficiencies"))
}

/// Тело `try` полного набора предыстории PHB: выбор снаряжения предыстории
/// и владения от неё (`owned_assets`).
fn background_equipment(canonical: &mut Map<String, Value>, phb: &mut Option<Value>) -> LifecycleResult<()> {
    let phb_value = prop(phb.as_ref(), "value").cloned();
    let mut hero = canonical.clone();
    hero.insert("phbCreation".into(), phb_value.clone().unwrap_or(Value::Null));
    if phb_value.is_none() {
        hero.shift_remove("phbCreation");
    }
    let choices = complete_background_choices_for_hero(Some(&Value::Object(hero)), None).unwrap_or(Value::Null);
    // `canonical.phbCreation` и `phb.value` — один объект JS.
    match canonical.get_mut("phbCreation") {
        Some(Value::Object(creation)) => {
            creation.insert("backgroundEquipmentChoices".into(), choices.clone());
        }
        Some(Value::Null) | None => return Err(CharacterLifecycleError::runtime("Cannot set properties of undefined (setting 'backgroundEquipmentChoices')")),
        Some(_) => {}
    }
    if let Some(Value::Object(phb_map)) = phb.as_mut() {
        if let Some(Value::Object(value)) = phb_map.get_mut("value") {
            value.insert("backgroundEquipmentChoices".into(), choices.clone());
        }
    }
    let equipment = validate_complete_background_choices(canonical.get("backgroundId"), Some(&choices));
    if !js::truthy(equipment.get("ok")) {
        return Err(CharacterLifecycleError::plain(js::s(equipment.get("reason"))));
    }
    let owned_assets = match prop(phb.as_ref(), "wealth").filter(|wealth| js::truthy(Some(wealth))) {
        Some(wealth) => defined(wealth.get("owned_assets")).cloned().unwrap_or_else(|| json!([])),
        None => {
            let mut assets = Vec::new();
            for option in array_of(equipment.get("selected_options")) {
                match defined(option.get("owned_assets")) {
                    None => {}
                    Some(Value::Array(items)) => assets.extend(items.iter().cloned()),
                    Some(other) => assets.push(other.clone()),
                }
            }
            Value::Array(assets)
        }
    };
    match phb.as_mut().and_then(|phb| phb.get_mut("benefits")) {
        Some(Value::Object(benefits)) => {
            benefits.insert("owned_assets".into(), owned_assets);
        }
        Some(Value::Null) | None => return Err(CharacterLifecycleError::runtime("Cannot set properties of undefined (setting 'owned_assets')")),
        Some(_) => {}
    }
    Ok(())
}
