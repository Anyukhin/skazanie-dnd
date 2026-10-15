//! Ветки `resolveCommandInternal`: Предметы: выдача, жизненный цикл (надеть, передать, настроиться, активировать), использование. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 22755–22760, 22897–22931, 22932–23127. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `GrantItem` (22755–22760).
pub fn grant_item(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:GrantItem").into())
}

/// `EquipItem`, `TransferItem`, `AttuneItem`, `ActivateItem` (22897–22931).
pub fn item_lifecycle(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:EquipItem").into())
}

/// `UseItem` (22932–23127).
pub fn use_item(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UseItem").into())
}
