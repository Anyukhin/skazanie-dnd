//! Ветки `resolveCommandInternal`: Незнакомец сценария `StageScenarioStranger` (приход и выдох). Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 20930–20985. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `StageScenarioStranger` (20930–20985).
pub fn stage_scenario_stranger(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:StageScenarioStranger").into())
}
