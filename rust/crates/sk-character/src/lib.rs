//! Жизнь героя и отряда «Сказания» — перенос `server/*.mjs`, по модулю на
//! JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/quest-decisions.mjs` | [`quest_decisions`] |
//! | `server/character-lifecycle.mjs` | [`character_lifecycle`] |
//!
//! `encounter-rewards` войдёт сюда же отдельным модулем.

pub mod character_lifecycle;
pub mod quest_decisions;
