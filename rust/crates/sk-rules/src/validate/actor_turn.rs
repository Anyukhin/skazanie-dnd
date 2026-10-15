//! Блоки `validateCommand`: Актёр, цели, полномочия и ход (`assertActorPermission`, `assertTurn`). Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 6955–6957, 6958–6972, 6973, 6974. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 50 (6955–6957): действующий персонаж найден.
pub fn check_actor_exists(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_actor_exists").into())
}

/// Блок 51 (6958–6972): цели найдены.
pub fn check_targets_exist(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_targets_exist").into())
}

/// Блок 52 (6973): полномочия (`assertActorPermission`).
pub fn check_actor_permission(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_actor_permission").into())
}

/// Блок 53 (6974): ход и экономика хода (`assertTurn`).
pub fn check_turn(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_turn").into())
}
