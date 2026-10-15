//! Блоки `validateCommand`: Предметы: предметы NPC, жизненный цикл предметов, выдача. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 6714–6763, 7201–7221. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 32 (6714–6763): предметы NPC и жизненный цикл предметов (с объявлением 31).
pub fn check_item_use(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_item_use").into())
}

/// Блок 65 (7201–7221): выдача предмета.
pub fn check_grant_item(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_grant_item").into())
}
