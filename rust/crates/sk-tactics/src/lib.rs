//! Права и полномочия, разбор свободного действия, автотактика героев,
//! прогноз удара, стенд боёв и аудит переключения — перенос `server/*.mjs`
//! четырнадцатой волны (`rust/PORT-STATUS.md`), по модулю на JS-файл:
//!
//! | JS | Rust | Задача |
//! | --- | --- | --- |
//! | `server/security.mjs` | [`security`] | Т1 |
//! | `server/combat-forecast-view.mjs` | [`combat_forecast_view`] | Т1 |
//! | `server/cutover-audit.mjs` | [`cutover_audit`] | Т1 |
//! | `server/adjudicator.mjs` | [`adjudicator`] | Т2 |
//! | `server/party-tactics.mjs` | [`party_tactics`] | Т2 |
//! | `server/combat-lab-setup.mjs` | [`combat_lab_setup`] | Т3 |
//! | `server/combat-lab.mjs` | [`combat_lab`] | Т3 |
//!
//! Этап паритета (`rust/PORTING.md`): на границе — `serde_json::Value` той же
//! формы, что у JS; правила — только через `sk_rules`. Каждым файлом владеет
//! одна задача; этот файл и `Cargo.toml` правит только ведущий переноса.

pub mod adjudicator;
pub mod combat_forecast_view;
pub mod combat_lab;
pub mod combat_lab_setup;
pub mod cutover_audit;
pub mod party_tactics;
pub mod security;
