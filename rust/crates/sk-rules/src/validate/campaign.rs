//! Блоки `validateCommand`: Кампания: память мира, социальные NPC, сборка и жизненный цикл героя, решения отряда, финал, дуга. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6184–6193, 6194–6203, 6684–6693, 6764–6776, 6810–6813, 6814–6825, 6826–6842. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 9 (6184–6193): команды памяти мира.
pub fn check_world_memory(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_world_memory").into())
}

/// Блок 10 (6194–6203): социальные команды NPC.
pub fn check_npc_social(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_npc_social").into())
}

/// Блок 27 (6684–6693): сборка героя.
pub fn check_character_build(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_character_build").into())
}

/// Блок 33 (6764–6776): жизненный цикл героя.
pub fn check_character_lifecycle(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_character_lifecycle").into())
}

/// Блок 41 (6810–6813): решение отряда по поручению.
pub fn check_quest_decision(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_quest_decision").into())
}

/// Блок 42 (6814–6825): финал кампании.
pub fn check_complete_campaign(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_complete_campaign").into())
}

/// Блок 43 (6826–6842): следующая дуга.
pub fn check_advance_campaign_arc(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_advance_campaign_arc").into())
}
