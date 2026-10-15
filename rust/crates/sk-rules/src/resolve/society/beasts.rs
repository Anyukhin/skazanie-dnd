//! Ветки `resolveCommandInternal`: Звери: кормление и отпугивание. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21361–21400, 21401–21418. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `FeedBeast` (21361–21400).
pub fn feed_beast(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:FeedBeast").into())
}

/// `ScareWithBeast` (21401–21418).
pub fn scare_with_beast(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ScareWithBeast").into())
}
