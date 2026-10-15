//! Ветки `resolveCommandInternal`: Атака оружием `MakeAttack`, смена оружия, областная атака предметом. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 13857–14999, 15000–15009, 15068–15150. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `MakeAttack` (13857–14999).
pub fn make_attack(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MakeAttack").into())
}

/// `ChangeWeapon` (15000–15009).
pub fn change_weapon(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ChangeWeapon").into())
}

/// `MakeAreaAttack` (15068–15150).
pub fn make_area_attack(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MakeAreaAttack").into())
}
