//! Общество «Сказания»: закон и розыск, репутация, парлей, изнанка торговли,
//! последствия поручений, истории постоянного мира, координатор после коммита
//! и онтология памяти мира.
//!
//! Перенос модулей `server/*.mjs` строка в строку по смыслу (`rust/PORTING.md`):
//! данные на границе — `serde_json::Value` той же формы, что в JS, поведение
//! сверяется с эталонами из прогона JS (`fixtures/`).

mod common;

pub mod campaign_stories;
pub mod law_and_order;
pub mod parley;
pub mod post_commit_coordinator;
pub mod quest_consequences;
pub mod reputation_policy;
pub mod retention_context;
pub mod underworld;
pub mod world_ontology;
