//! Ветки `resolveCommandInternal`: NPC мира: пост, перемещение, вред. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 20986–21001, 21002–21018, 21019–21029. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `PlaceNpc` (20986–21001).
pub fn place_npc(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:PlaceNpc").into())
}

/// `MoveNpc` (21002–21018).
pub fn move_npc(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MoveNpc").into())
}

/// `HarmNpc` (21019–21029).
pub fn harm_npc(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:HarmNpc").into())
}
