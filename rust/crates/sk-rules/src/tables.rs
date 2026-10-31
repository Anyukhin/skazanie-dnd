//! Таблицы, выгруженные из JS (`tools/export-rust-tables.mjs`): эффекты
//! состояний (`CONDITION_EFFECTS`, 4355–4496) и каталог предметов. Эталон
//! `fixtures/core.json` сверяет таблицу состояний с JS. Задача Р0.

use std::sync::{LazyLock, OnceLock};

use serde_json::Value;
use sk_core::content::{self, ContentError, ContentResult};

/// Пути таблиц от корня репозитория.
pub const CONDITION_EFFECTS_FILE: &str = "rust/data/condition-effects.json";
pub const ITEM_CATALOG_FILE: &str = "rust/data/item-catalog.json";

/// Поля эффекта состояния, которые читает движок, и их вид в JSON. Поле с
/// опечаткой движок молча не видит (состояние теряет эффект), поэтому таблица
/// с неизвестным полем не проходит проверку при старте (урок 7).
const CONDITION_EFFECT_FIELDS: [(&str, &str); 38] = [
    ("attackDisadvantage", "boolean"), ("grantsAttackAdvantage", "boolean"), ("checkDisadvantage", "boolean"), ("forbidsReactions", "boolean"),
    ("singleAttackPerTurn", "boolean"), ("speedZero", "boolean"), ("attackAdvantage", "boolean"), ("grantsAttackDisadvantage", "boolean"),
    ("attackDisadvantageAgainstSource", "boolean"), ("immuneToSpeedZero", "boolean"), ("ignoresDifficultTerrain", "boolean"), ("incapacitated", "boolean"),
    ("immuneToAllDamage", "boolean"), ("grantsRangedWeaponAttackDisadvantage", "boolean"), ("autoCriticalInReach", "boolean"), ("resistsAllDamage", "boolean"),
    ("armorClassBonus", "number"), ("speedMultiplier", "number"), ("extraActions", "number"), ("speedBonusFeet", "number"),
    ("armorClassFloor", "number"), ("attackBonus", "number"), ("weaponDamageBonus", "number"), ("weaponDamageDiceWithinFeet", "number"),
    ("saveBonusAbilities", "object"), ("retaliates", "object"),
    ("saveAdvantageAbilities", "array"), ("resistsDamageTypes", "array"), ("suppressesDamageImmunities", "array"), ("checkAdvantageAbilities", "array"),
    ("checkDisadvantageAbilities", "array"), ("saveDisadvantageAbilities", "array"), ("saveAdvantageAgainstConditions", "array"), ("immuneToDamageTypes", "array"),
    ("autoFailedSaves", "array"),
    ("weaponDamageDice", "string"), ("halvesWeaponDamageForAbility", "string"), ("weaponDamagePenaltyDice", "string"),
];

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Разбор и проверка таблицы эффектов состояний из текста: объект
/// «состояние → эффект», у эффекта только известные поля своего вида.
pub fn parse_condition_effects(text: &str) -> ContentResult<Value> {
    let file = CONDITION_EFFECTS_FILE;
    let table = content::parse_json(file, text)?;
    for (condition, effect) in content::root_object(file, &table)? {
        let Some(effect) = effect.as_object() else {
            return Err(ContentError::at(file, condition.as_str(), "эффект должен быть объектом"));
        };
        for (key, value) in effect {
            match CONDITION_EFFECT_FIELDS.iter().find(|(name, _)| name == key) {
                None => return Err(ContentError::at(file, condition.as_str(), format!("неизвестное поле «{key}»"))),
                Some((_, kind)) if *kind != json_kind(value) => return Err(ContentError::at(file, condition.as_str(), format!("поле «{key}» должно быть {kind}"))),
                Some(_) => {}
            }
        }
    }
    Ok(table)
}

/// Разбор и проверка каталога предметов из текста: объект «id → запись»,
/// у записи `catalog_id` совпадает с ключом и есть имя.
pub fn parse_item_catalog(text: &str) -> ContentResult<Value> {
    let file = ITEM_CATALOG_FILE;
    let catalog = content::parse_json(file, text)?;
    for (id, entry) in content::root_object(file, &catalog)? {
        if !entry.is_object() {
            return Err(ContentError::at(file, id.as_str(), "запись должна быть объектом"));
        }
        if content::required_str(file, entry, "catalog_id", id)? != id {
            return Err(ContentError::at(file, id.as_str(), "catalog_id не совпадает с ключом"));
        }
        content::required_str(file, entry, "name", id)?;
    }
    Ok(catalog)
}

static CONDITION_EFFECTS: LazyLock<ContentResult<Value>> = LazyLock::new(|| parse_condition_effects(include_str!("../../../data/condition-effects.json")));
static ITEM_CATALOG: LazyLock<ContentResult<Value>> = LazyLock::new(|| parse_item_catalog(include_str!("../../../data/item-catalog.json")));

fn checked(table: &'static ContentResult<Value>) -> &'static Value {
    match table {
        Ok(value) => value,
        Err(error) => panic!("{error}"),
    }
}

/// Проверка встроенных таблиц (сервер зовёт её до приёма запросов).
pub fn check_tables() -> ContentResult<()> {
    CONDITION_EFFECTS.as_ref().map_err(Clone::clone)?;
    ITEM_CATALOG.as_ref().map(|_| ()).map_err(Clone::clone)
}

/// `CONDITION_EFFECTS` целиком.
pub fn condition_effects() -> &'static Value {
    checked(&CONDITION_EFFECTS)
}

/// Эффект состояния или `None`.
pub fn condition_effect(condition: &str) -> Option<&'static Value> {
    condition_effects().get(condition).filter(|value| value.is_object())
}

/// `catalogItem(catalogId)`: обычный каталог, затем предметы сценариев.
pub fn catalog_item(catalog_id: &str) -> Option<&'static Value> {
    checked(&ITEM_CATALOG).get(catalog_id).filter(|value| value.is_object())
}

/// Состояния таблицы с флагом `flag === true`, в порядке `Object.entries`.
fn conditions_with(flag: &str) -> Vec<&'static str> {
    condition_effects()
        .as_object()
        .map(|map| sk_core::js::entries(map).into_iter().filter(|(_, effect)| effect.get(flag) == Some(&Value::Bool(true))).map(|(name, _)| name.as_str()).collect())
        .unwrap_or_default()
}

/// Состояния с нулевой скоростью (`SPEED_ZERO_CONDITIONS`) в порядке таблицы.
pub fn speed_zero_conditions() -> Vec<&'static str> {
    static LIST: OnceLock<Vec<&'static str>> = OnceLock::new();
    LIST.get_or_init(|| conditions_with("speedZero")).clone()
}

/// Состояния, выводящие из боя (`INCAPACITATING_CONDITIONS`), в порядке таблицы.
pub fn incapacitating_conditions() -> &'static [&'static str] {
    static LIST: OnceLock<Vec<&'static str>> = OnceLock::new();
    LIST.get_or_init(|| conditions_with("incapacitated"))
}

/// Ключ класса героя (`characterClassKey`, `server/character-progression.mjs`).
pub fn character_class_key(actor: &Value) -> Option<String> {
    sk_ruleset::character_progression::character_class_key(Some(actor))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Урок 7: опечатка в ключевом поле копии таблицы — отказ, который
    /// называет файл и запись.
    #[test]
    fn broken_copies_name_file_and_record() {
        assert_eq!(check_tables(), Ok(()));
        let text = include_str!("../../../data/condition-effects.json").replace("\"speedZero\"", "\"speedzero\"");
        let error = parse_condition_effects(&text).err().map(|error| error.to_string());
        assert!(error.as_deref().is_some_and(|text| text.starts_with("rust/data/condition-effects.json: ") && text.ends_with(": неизвестное поле «speedzero»")), "{error:?}");
        let mut catalog: Value = serde_json::from_str(include_str!("../../../data/item-catalog.json")).expect("каталог");
        catalog["srd_5_2_1:dagger"]["catalog_id"] = Value::String("srd_5_2_1:daggr".into());
        let error = parse_item_catalog(&catalog.to_string()).err().map(|error| error.to_string());
        assert_eq!(error.as_deref(), Some("rust/data/item-catalog.json: srd_5_2_1:dagger: catalog_id не совпадает с ключом"));
    }
}
