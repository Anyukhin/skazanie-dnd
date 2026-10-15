//! Блоки `validateCommand`: Торговля: жизненный цикл торговцев, сделки, карманная кража. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6922–6954, 7064–7156, 7171–7200. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 49 (6922–6954): жизненный цикл торговцев.
pub fn check_merchant_lifecycle(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_merchant_lifecycle").into())
}

/// Блок 63 (7064–7156): сделки с торговцем.
pub fn check_trade(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_trade").into())
}

/// Блок 64 (7171–7200): карманная кража.
pub fn check_pickpocket(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_pickpocket").into())
}
