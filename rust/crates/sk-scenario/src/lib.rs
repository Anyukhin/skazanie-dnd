//! Сценарий авторской кампании, намерение отряда уйти из сцены и откат ведущего.
//!
//! Перенос трёх листовых модулей `server/`: `campaign-scenario.mjs`,
//! `party-exit-intent.mjs` и `campaign-controls.mjs`. Правила переноса —
//! `rust/PORTING.md`.

pub mod campaign_controls;
pub mod campaign_scenario;
pub mod party_exit_intent;
mod util;
