//! Ветки `resolveCommandInternal`: Таверна: кости на деньги и выпивка. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21646–21714, 21715–21948, 21949–21960, 21961–22017. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `OpenTavernDiceRound` (21646–21714).
pub fn open_tavern_dice_round(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:OpenTavernDiceRound").into())
}

/// `AnswerTavernDiceRound` (21715–21948).
pub fn answer_tavern_dice_round(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AnswerTavernDiceRound").into())
}

/// `LeaveTavernDiceRound` (21949–21960).
pub fn leave_tavern_dice_round(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:LeaveTavernDiceRound").into())
}

/// `OrderTavernDrink` (21961–22017).
pub fn order_tavern_drink(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:OrderTavernDrink").into())
}
