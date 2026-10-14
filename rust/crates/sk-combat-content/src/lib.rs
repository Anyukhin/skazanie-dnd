//! Боевое содержание «Сказания» — перенос `server/*.mjs` второй волны, по
//! модулю на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/combat-spells.mjs` | [`combat_spells`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты байт в байт.
//! Данные `data/*.json` встроены `include_str!`.

mod jsv;

pub mod combat_spells;
