//! Таблицы, выгруженные из JS (`tools/export-rust-tables.mjs`): эффекты
//! состояний и каталог предметов. Значения совпадают с JS по построению.

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

/// Состояния с нулевой скоростью (`SPEED_ZERO_CONDITIONS`) в порядке таблицы.
pub fn speed_zero_conditions() -> Vec<&'static str> {
    condition_effects()
        .as_object()
        .map(|map| map.iter().filter(|(_, effect)| effect.get("speedZero") == Some(&Value::Bool(true))).map(|(name, _)| name.as_str()).collect())
        .unwrap_or_default()
}

/// Ключ класса героя (`characterClassKey`): явный `characterClass`, если это
/// известный класс, иначе по тексту роли.
pub fn character_class_key(actor: &Value) -> Option<&'static str> {
    const CLASSES: [&str; 12] = ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"];
    let explicit = sk_core::js::s(actor.get("characterClass")).to_lowercase();
    if let Some(known) = CLASSES.iter().find(|class| **class == explicit) {
        return Some(known);
    }
    crate::classes::actor_class(actor)
}
