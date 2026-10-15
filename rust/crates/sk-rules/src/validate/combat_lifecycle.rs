//! Блоки `validateCommand`: Вход в бой: нападение на NPC, встреча, старт и конец боя. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 6900–6902, 6903–6921, 7044–7046, 7047–7057. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 47 (6900–6902): нападение на NPC.
pub fn check_attack_npc(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_attack_npc").into())
}

/// Блок 48 (6903–6921): сборка встречи.
pub fn check_encounter_lifecycle(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_encounter_lifecycle").into())
}

/// Блок 59 (7044–7046): бой ещё не начат.
pub fn check_start_combat(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_start_combat").into())
}

/// Блок 60 (7047–7057): конец боя.
pub fn check_end_combat(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_end_combat").into())
}
