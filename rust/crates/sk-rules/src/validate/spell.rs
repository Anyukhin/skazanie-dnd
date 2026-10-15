//! Блоки `validateCommand`: Заклинание: магия стат-блока и `CastSpell`. Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 6711–6713, 7325–7568. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 30 (6711–6713): магия стат-блока.
pub fn check_monster_spell(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_monster_spell").into())
}

/// Блок 69 (7325–7568): заклинание (авторитетный бой).
pub fn check_cast_spell(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_cast_spell").into())
}
