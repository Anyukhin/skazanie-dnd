//! Основа агентов «Сказания» — перенос модулей `server/*.mjs`, на которые
//! опираются роли агентов:
//!
//! | JS | модуль |
//! | --- | --- |
//! | `llm-client.mjs` | [`llm_client`] |
//! | `architect-usage.mjs` | [`architect_usage`] |
//!
//! Контракт клиента модели — `sk_infra::usage_ledger::LlmClient` (его же
//! оборачивает `MeteredLLMClient`); [`llm_client::LlmClientExt`] добавляет к
//! нему то, что в JS передавалось функциями в `options` (сигнал отмены,
//! потоковый получатель, проверка ответа).
//!
//! `JSON.parse`/`JSON.stringify` по правилам V8, на которых держится строгий
//! разбор ответа модели и файл учёта Архитектора, — в `js_json` (внутренний).
//! Правила переноса — `rust/PORTING.md`.

pub mod architect_usage;
mod js_json;
pub mod llm_client;
