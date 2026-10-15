//! Ветки `resolveCommandInternal`: Благословение жреца. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 22024–22074. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `ReceiveNpcBlessing` (22024–22074).
pub fn receive_npc_blessing(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ReceiveNpcBlessing").into())
}
