//! Ветки `resolveCommandInternal`: Сценарий: кошель короля, осведомитель, авторский диалог, оружейная, договор, проклятый рыцарь. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 20680–20693, 20694–20727, 20728–20847, 20848–20854, 20855–20890, 20891–20897, 20898–20929. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `ReceiveScenarioPurse` (20680–20693).
pub fn receive_scenario_purse(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ReceiveScenarioPurse").into())
}

/// `ResolveScenarioInformant` (20694–20727).
pub fn resolve_scenario_informant(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ResolveScenarioInformant").into())
}

/// `ChooseDialogueOption` (20728–20847).
pub fn choose_dialogue_option(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ChooseDialogueOption").into())
}

/// `ChooseScenarioArmoryItem` (20848–20854).
pub fn choose_scenario_armory_item(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ChooseScenarioArmoryItem").into())
}

/// `NegotiateScenarioTreaty` (20855–20890).
pub fn negotiate_scenario_treaty(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:NegotiateScenarioTreaty").into())
}

/// `ReturnKnightHead` (20891–20897).
pub fn return_knight_head(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ReturnKnightHead").into())
}

/// `ReleaseCursedKnight` (20898–20929).
pub fn release_cursed_knight(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ReleaseCursedKnight").into())
}
