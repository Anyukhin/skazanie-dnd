//! Блоки `validateCommand`: Сценарий: кошель, осведомитель, диалог, оружейная, договор, рыцарь, незнакомец. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6466–6479, 6480–6502, 6503–6526, 6527–6549, 6550–6579, 6580–6619, 6620–6640. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 18 (6466–6479): кошель короля.
pub fn check_scenario_purse(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scenario_purse").into())
}

/// Блок 19 (6480–6502): осведомитель.
pub fn check_scenario_informant(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scenario_informant").into())
}

/// Блок 20 (6503–6526): авторский диалог.
pub fn check_dialogue(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_dialogue").into())
}

/// Блок 21 (6527–6549): оружейная.
pub fn check_scenario_armory(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scenario_armory").into())
}

/// Блок 22 (6550–6579): договор.
pub fn check_scenario_treaty(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scenario_treaty").into())
}

/// Блок 23 (6580–6619): проклятый рыцарь.
pub fn check_scenario_knight(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scenario_knight").into())
}

/// Блок 24 (6620–6640): незнакомец.
pub fn check_scenario_stranger(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scenario_stranger").into())
}
