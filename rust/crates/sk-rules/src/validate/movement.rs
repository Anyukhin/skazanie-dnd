//! Блоки `validateCommand`: Перемещение `MoveActor`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 7769–7791, 7796–7801. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 72 (7769–7791): путь перемещения.
pub fn check_move_actor(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_move_actor").into())
}

/// Блок 73 (7796–7801): скорость и состояния при перемещении.
pub fn check_move_speed(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_move_speed").into())
}
