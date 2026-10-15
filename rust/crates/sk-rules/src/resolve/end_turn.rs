//! Ветки `resolveCommandInternal`: Конец хода `EndTurn`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 20005–20347. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `EndTurn` (20005–20347).
pub fn end_turn(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:EndTurn").into())
}
