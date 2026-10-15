//! Ветки `resolveCommandInternal`: Особые действия монстров и легендарные действия. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 15010–15066, 16675–16813. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `UseMonsterAction` (15010–15066).
pub fn use_monster_action(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UseMonsterAction").into())
}

/// `UseLegendaryAction` (16675–16813).
pub fn use_legendary_action(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UseLegendaryAction").into())
}
