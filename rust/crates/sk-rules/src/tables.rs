//! Таблицы, выгруженные из JS (`tools/export-rust-tables.mjs`): эффекты
//! состояний (`CONDITION_EFFECTS`, 4355–4496) и каталог предметов. Эталон
//! `fixtures/core.json` сверяет таблицу состояний с JS. Задача Р0.

use std::sync::OnceLock;

use serde_json::Value;

static CONDITION_EFFECTS: OnceLock<Value> = OnceLock::new();
static ITEM_CATALOG: OnceLock<Value> = OnceLock::new();

/// `CONDITION_EFFECTS` целиком.
pub fn condition_effects() -> &'static Value {
    CONDITION_EFFECTS.get_or_init(|| serde_json::from_str(include_str!("../../../data/condition-effects.json")).expect("таблица эффектов состояний"))
}

/// Эффект состояния или `None`.
pub fn condition_effect(condition: &str) -> Option<&'static Value> {
    condition_effects().get(condition).filter(|value| value.is_object())
}

/// `catalogItem(catalogId)`: обычный каталог, затем предметы сценариев.
pub fn catalog_item(catalog_id: &str) -> Option<&'static Value> {
    ITEM_CATALOG
        .get_or_init(|| serde_json::from_str(include_str!("../../../data/item-catalog.json")).expect("каталог предметов"))
        .get(catalog_id)
        .filter(|value| value.is_object())
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
