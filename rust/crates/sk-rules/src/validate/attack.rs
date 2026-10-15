//! Блоки `validateCommand`: Атака: легендарное и особое действие монстра, атака оружием, смена оружия, областная атака. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 6703–6705, 6706–6710, 7222–7301, 7302–7316, 7317–7324. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 28 (6703–6705): легендарное действие.
pub fn check_legendary_action(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_legendary_action").into())
}

/// Блок 29 (6706–6710): особое действие монстра.
pub fn check_monster_action(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_monster_action").into())
}

/// Блок 66 (7222–7301): атака оружием.
pub fn check_make_attack(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_make_attack").into())
}

/// Блок 67 (7302–7316): смена оружия.
pub fn check_change_weapon(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_change_weapon").into())
}

/// Блок 68 (7317–7324): областная атака предметом.
pub fn check_make_area_attack(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_make_area_attack").into())
}
