//! Ветки `resolveCommandInternal`: Вход в бой и выход: нападение на NPC, сборка встречи, начало и конец боя. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 19783–19820, 19821–19843, 19844–19973, 19974–20004. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `AttackNpc` (19783–19820).
pub fn attack_npc(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AttackNpc").into())
}

/// `CreateEncounter` (19821–19843).
pub fn create_encounter(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:CreateEncounter").into())
}

/// `StartCombat` (19844–19973).
pub fn start_combat(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:StartCombat").into())
}

/// `EndCombat` (19974–20004).
pub fn end_combat(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:EndCombat").into())
}
