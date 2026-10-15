//! Ветки `resolveCommandInternal`: Уговор зверя `CalmBeast` (проверка характеристики с укусом на провале). Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 21245–21360. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `CalmBeast` (21245–21360).
pub fn calm_beast(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:CalmBeast").into())
}
