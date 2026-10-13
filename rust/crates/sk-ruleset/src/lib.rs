//! Редакции правил и создание героя «Сказания» — перенос нижнего слоя
//! `server/*.mjs`, от которого зависят создание персонажа, заклинания и Rules
//! Engine.
//!
//! Модуль на каждый JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/ruleset-config.mjs` | [`ruleset_config`] |
//! | `server/rules/core.mjs` | [`rules_core`] |
//! | `server/rules/actors.mjs` | [`rules_actors`] |
//! | `server/campaign-ruleset.mjs` | [`campaign_ruleset`] |
//! | `server/character-progression.mjs` | [`character_progression`] |
//! | `server/character-creation-class-options.mjs` | [`character_creation_class_options`] |
//! | `server/character-creation-feats.mjs` | [`character_creation_feats`] |
//! | `server/character-creation-catalog.mjs` | [`character_creation_catalog`] |
//! | `server/backgrounds.mjs` | [`backgrounds`] |
//! | `server/lockpicking.mjs` | [`lockpicking`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты отказов и коды —
//! байт в байт. Данные `data/*.json` встроены `include_str!`.

pub mod backgrounds;
pub mod campaign_ruleset;
pub mod character_creation_catalog;
pub mod character_creation_class_options;
pub mod character_creation_feats;
pub mod character_progression;
pub mod lockpicking;
pub mod rules_actors;
pub mod rules_core;
pub mod ruleset_config;

mod support;
