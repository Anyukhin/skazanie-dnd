//! Ветки `resolveCommandInternal`: Перемещение `MoveActor`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 18811–19105. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `MoveActor` (18811–19105).
pub fn move_actor(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MoveActor").into())
}
