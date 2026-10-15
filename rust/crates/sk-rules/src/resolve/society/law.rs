//! Ветки `resolveCommandInternal`: Закон: амнистия и встреча со стражей. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 22117–22130, 22131–22309. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `ClearWantedLevel` (22117–22130).
pub fn clear_wanted_level(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ClearWantedLevel").into())
}

/// `ResolveGuardEncounter` (22131–22309).
pub fn resolve_guard_encounter(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ResolveGuardEncounter").into())
}
