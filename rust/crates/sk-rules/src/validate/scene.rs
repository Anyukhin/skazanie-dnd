//! Блоки `validateCommand`: Сцена и карта: импорт, перестройка, смена сцены. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6843–6862, 6863–6878, 6879–6899. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 44 (6843–6862): импорт карты.
pub fn check_import_location_map(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_import_location_map").into())
}

/// Блок 45 (6863–6878): перестройка карты.
pub fn check_rebuild_location_map(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_rebuild_location_map").into())
}

/// Блок 46 (6879–6899): смена сцены.
pub fn check_advance_scene(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_advance_scene").into())
}
