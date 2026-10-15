//! Блоки `validateCommand`: Боевой приём `UseCombatAction`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 7586–7768. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 71 (7586–7768): боевой приём (авторитетный бой).
pub fn check_combat_action(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_combat_action").into())
}
