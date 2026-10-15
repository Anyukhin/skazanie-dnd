//! Блоки `validateCommand`: Хиты и отдых: судьба погибшего, отдых, лечение погибшего, максимум хитов, опознание. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 6985–6992, 6994–7042, 7058–7060, 7061–7063, 7569–7585. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 57 (6985–6992): судьба погибшего героя.
pub fn check_resolve_hero_death(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_resolve_hero_death").into())
}

/// Блок 58 (6994–7042): отдых.
pub fn check_rest(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_rest").into())
}

/// Блок 61 (7058–7060): лечение не поднимает погибшего.
pub fn check_healing_dead_hero(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_healing_dead_hero").into())
}

/// Блок 62 (7061–7063): уменьшение максимума хитов.
pub fn check_reduce_hit_point_maximum(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_reduce_hit_point_maximum").into())
}

/// Блок 70 (7569–7585): опознание противника.
pub fn check_identify_enemy(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_identify_enemy").into())
}
