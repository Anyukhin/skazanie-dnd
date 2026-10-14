//! Снаряжение и облик нового героя и мира «Сказания» — перенос `server/*.mjs`.
//!
//! Модуль на каждый JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/starter-kit.mjs` | [`starter_kit`] |
//! | `server/character-creation-wealth.mjs` | [`character_creation_wealth`] |
//! | `server/npc-portraits.mjs` | [`npc_portraits`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты отказов и коды —
//! байт в байт.

pub mod character_creation_wealth;
pub mod npc_portraits;
pub mod starter_kit;

mod support;
