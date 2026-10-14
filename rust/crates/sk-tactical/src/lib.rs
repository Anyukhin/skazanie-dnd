//! Тактическая карта «Сказания» — перенос `server/*.mjs` четвёртой волны, по
//! модулю на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/scene-interactions.mjs` | [`scene_interactions`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты байт в байт.

pub mod scene_interactions;
