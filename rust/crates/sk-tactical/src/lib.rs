//! Тактическая карта «Сказания» — перенос `server/*.mjs` четвёртой волны, по
//! модулю на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/scene-interactions.mjs` | [`scene_interactions`] |
//! | `server/tactical-map.mjs` | [`tactical_map`] |
//! | `server/combat-bounds.mjs` | [`combat_bounds`] (и `syncCombatBounds`, `growCombatBounds` движка) |
//! | `server/reveal-delta.mjs` | [`reveal_delta`] |
//! | `server/reveal-transport.mjs` | [`reveal_transport`] |
//! | `server/action-hints.mjs` | [`action_hints`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты байт в байт.

pub mod action_hints;
pub mod combat_bounds;
pub mod reveal_delta;
pub mod reveal_transport;
pub mod scene_interactions;
pub mod tactical_map;
