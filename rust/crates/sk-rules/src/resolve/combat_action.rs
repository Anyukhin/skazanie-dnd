//! Ветки `resolveCommandInternal`: Боевые приёмы `UseCombatAction`: возобновление пауз (15377–15717, помощники — `resolve/resume.rs`) и 45 приёмов. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 15344–16662. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `UseCombatAction` (15344–16662).
pub fn use_combat_action(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UseCombatAction").into())
}
