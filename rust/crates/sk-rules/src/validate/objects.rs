//! Блоки `validateCommand`: Объекты и двери: баррикада, объект сцены. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 6976–6979, 7833–7854. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use super::Validation;
use crate::pause::{unported, Step};

/// Блок 54 (6976–6979): с баррикадой работает дееспособный живой.
pub fn check_barricade_actor(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_barricade_actor").into())
}

/// Блок 78 (7833–7854): взаимодействие с объектом сцены.
pub fn check_scene_object(_v: &mut Validation<'_>) -> Step {
    Err(unported("validate:check_scene_object").into())
}
