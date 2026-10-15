//! Ветки `resolveCommandInternal`: Отдых: начало, трата кости хитов, завершение. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 22605–22623, 22624–22664, 22665–22738. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `StartRest` (22605–22623).
pub fn start_rest(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:StartRest").into())
}

/// `SpendHitPointDie` (22624–22664).
pub fn spend_hit_point_die(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SpendHitPointDie").into())
}

/// `CompleteRest` (22665–22738).
pub fn complete_rest(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:CompleteRest").into())
}
