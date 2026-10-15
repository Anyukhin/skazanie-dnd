//! Блоки `validateCommand`: Социальная проверка `MakeAbilityCheck` от контроллера NPC. Задача Р5.
//!
//! JS: `server/rules-engine.mjs`, 6152–6183. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 8 (6152–6183): социальная проверка только от контроллера NPC.
pub fn check_social_check(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_social_check").into())
}
