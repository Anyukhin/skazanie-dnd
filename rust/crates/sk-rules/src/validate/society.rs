//! Блоки `validateCommand`: Общество: NPC-мир, пленные, контейнеры, звери, парлей, закон, таверна, благословения, письма. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 6204–6213, 6214–6243, 6244–6251, 6252–6260, 6261–6287, 6288–6352, 6353–6465, 6641–6679, 6683. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 11 (6204–6213): команды мира NPC.
pub fn check_npc_world(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_npc_world").into())
}

/// Блок 12 (6214–6243): пленные.
pub fn check_captive(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_captive").into())
}

/// Блок 13 (6244–6251): контейнер добычи.
pub fn check_loot_container(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_loot_container").into())
}

/// Блок 14 (6252–6260): звери.
pub fn check_beast(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_beast").into())
}

/// Блок 15 (6261–6287): переговоры.
pub fn check_parley(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_parley").into())
}

/// Блок 16 (6288–6352): закон.
pub fn check_law(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_law").into())
}

/// Блок 17 (6353–6465): таверна.
pub fn check_tavern(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_tavern").into())
}

/// Блок 25 (6641–6679): благословение.
pub fn check_blessing(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_blessing").into())
}

/// Блок 26 (6683): письмо.
pub fn check_courier_letter(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_courier_letter").into())
}
