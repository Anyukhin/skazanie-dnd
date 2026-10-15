//! Жизнь героя и отряда «Сказания» — перенос `server/*.mjs`, по модулю на
//! JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/quest-decisions.mjs` | [`quest_decisions`] |
//!
//! `character-lifecycle` и `encounter-rewards` войдут сюда же, когда будут
//! перенесены их зависимости (`rust/PORT-STATUS.md`).

pub mod quest_decisions;
