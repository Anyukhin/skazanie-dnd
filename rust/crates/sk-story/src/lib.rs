//! Сюжетный слой сцены — перенос `server/*.mjs` десятой волны, по модулю на
//! JS-файл. По плану (`rust/PORT-STATUS.md`) в крейте будут
//! `campaign-dialogues`, `campaign-loop-policy`, `intent-parser`,
//! `llm-json-schemas` и `map-library`; сейчас перенесены:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/campaign-loop-policy.mjs` | [`campaign_loop_policy`] |
//! | `server/map-library.mjs` | [`map_library`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе — `serde_json::Value` той же
//! формы, что у JS; файлы библиотеки на диске — байт в байт как у JS, чтобы
//! Rust читал библиотеку, записанную JS, и наоборот.

pub mod campaign_loop_policy;
pub mod map_library;
