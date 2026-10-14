//! Жизнь вещи на нижнем уровне «Сказания» — перенос `server/*.mjs`, от
//! которых зависят торговля, добыча, инвентарь героя и снаряжение противника.
//!
//! Модуль на каждый JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/item-catalog.mjs` | [`item_catalog`] |
//! | `server/item-dawn-recharge.mjs` | [`item_dawn_recharge`] |
//! | `server/loot-tables.mjs` | [`loot_tables`] |
//! | `server/pickpocket.mjs` | [`pickpocket`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты отказов и коды —
//! байт в байт. Случайность — только через внедрённый [`sk_dice::Dice`].

pub mod item_catalog;
pub mod item_dawn_recharge;
pub mod loot_tables;
pub mod pickpocket;

mod support;
