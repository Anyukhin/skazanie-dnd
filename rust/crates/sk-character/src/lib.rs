//! Жизнь героя и отряда «Сказания» — перенос `server/*.mjs`, по модулю на
//! JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/quest-decisions.mjs` | [`quest_decisions`] |
//! | `server/character-lifecycle.mjs` | [`character_lifecycle`] |
//! | `server/encounter-rewards.mjs` | [`encounter_rewards`] |

pub mod character_lifecycle;
pub mod encounter_rewards;
pub mod quest_decisions;
