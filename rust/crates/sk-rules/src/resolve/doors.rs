//! Ветки `resolveCommandInternal`: Двери: баррикада, разбор баррикады, открыть и выломать. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 19120–19140, 19141–19164, 19165–19257. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `BarricadeDoor` (19120–19140).
pub fn barricade_door(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:BarricadeDoor").into())
}

/// `ClearDoorBarricade` (19141–19164).
pub fn clear_door_barricade(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ClearDoorBarricade").into())
}

/// `OperateDoor` (19165–19257).
pub fn operate_door(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:OperateDoor").into())
}
