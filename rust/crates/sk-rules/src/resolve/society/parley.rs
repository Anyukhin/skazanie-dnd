//! Ветки `resolveCommandInternal`: Переговоры посреди боя: предложение и уговор. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21419–21566, 21567–21633. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `ProposeParley` (21419–21566).
pub fn propose_parley(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ProposeParley").into())
}

/// `SettleParley` (21567–21633).
pub fn settle_parley(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SettleParley").into())
}
