//! Ветки `resolveCommandInternal`: Обыск контейнера добычи. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21634–21645. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `LootContainer` (21634–21645).
pub fn loot_container(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:LootContainer").into())
}
