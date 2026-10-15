//! Хвост `resolveCommandInternal` (`rules-engine.mjs`, 23134–23439):
//! вложенные последствия событий, «Несгибаемый», гибель героя, бегство,
//! сверка концентрации, гибель NPC и уход по времени, контейнеры добычи,
//! должности и поручения. Задача Р5.

use super::{Resolve, Resolved};
use crate::pause::{unported, Halt};

/// Последствия после ветки и итог `{ command, events: resolvedEvents, rolls }`.
pub fn finish(_r: Resolve<'_>) -> Result<Resolved, Halt> {
    Err(unported("resolve:tail").into())
}
