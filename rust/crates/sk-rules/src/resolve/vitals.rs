//! Ветки `resolveCommandInternal`: Хиты, ресурсы, состояния: уменьшение максимума хитов, судьба погибшего героя, трата и восстановление ресурса, опознание противника, наложение и снятие состояния. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 15167–15199, 15200–15215, 15222–15229, 15230–15237, 15241–15283, 15295–15313, 15341–15343. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `ReduceHitPointMaximum` (15167–15199).
pub fn reduce_hit_point_maximum(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ReduceHitPointMaximum").into())
}

/// `ResolveHeroDeath` (15200–15215).
pub fn resolve_hero_death(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ResolveHeroDeath").into())
}

/// `SpendResource` (15222–15229).
pub fn spend_resource(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SpendResource").into())
}

/// `RestoreResource` (15230–15237).
pub fn restore_resource(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RestoreResource").into())
}

/// `IdentifyEnemy` (15241–15283).
pub fn identify_enemy(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:IdentifyEnemy").into())
}

/// `AddCondition` (15295–15313).
pub fn add_condition(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AddCondition").into())
}

/// `RemoveCondition` (15341–15343).
pub fn remove_condition(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RemoveCondition").into())
}
