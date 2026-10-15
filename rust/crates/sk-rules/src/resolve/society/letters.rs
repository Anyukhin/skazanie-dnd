//! Ветки `resolveCommandInternal`: Почта отряда. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 22075–22116. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `SendLetter` (22075–22116).
pub fn send_letter(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SendLetter").into())
}
