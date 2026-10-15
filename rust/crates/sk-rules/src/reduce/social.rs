//! Ветки редьюсера `applyGameEventCurrent`: Общество: пленные, звери, парлей и перемирие, стража, благословения, письма, таверна, подкуп и карманы, мир NPC. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 26114–26127, 26128–26143, 26155–26163, 26168–26188, 26189–26198, 26199–26208, 26209–26220, 26221–26232, 26233–26245, 26246–26258, 26262–26282, 26283–26305, 26781–26789, 26790–26802, 27044–27051. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.

use serde_json::Value;
use sk_core::Event;

use super::Reduced;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "CaptiveTaken",
    "BeastTamed",
    "CaptiveHandedOver",
    "ParleyProposed",
    "ParleyRejected",
    "TruceEstablished",
    "TruceBroken",
    "GuardEncounterResolved",
    "NpcBlessingGranted",
    "CourierLetterSent",
    "TavernDiceRoundOpened",
    "TavernDiceRoundCancelled",
    "TavernDiceRoundResolved",
    "TavernDrinkOrdered",
    "ParleySettled",
    "NpcBribeOffered",
    "NpcPocketPicked",
    "NpcPlaced",
    "NpcMoved",
    "NpcHarmed",
    "NpcDied",
    "NpcStanceChanged",
];

/// `CaptiveTaken` (26114–26127).
pub(super) fn captive_taken(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CaptiveTaken"))
}

/// `BeastTamed` (26128–26143).
pub(super) fn beast_tamed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:BeastTamed"))
}

/// `CaptiveHandedOver` (26155–26163).
pub(super) fn captive_handed_over(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CaptiveHandedOver"))
}

/// `ParleyProposed` (26168–26188).
pub(super) fn parley_proposed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ParleyProposed"))
}

/// `ParleyRejected` (26189–26198).
pub(super) fn parley_rejected(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ParleyRejected"))
}

/// `TruceEstablished` (26199–26208).
pub(super) fn truce_established(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:TruceEstablished"))
}

/// `TruceBroken` (26209–26220).
pub(super) fn truce_broken(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:TruceBroken"))
}

/// `GuardEncounterResolved` (26221–26232).
pub(super) fn guard_encounter_resolved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:GuardEncounterResolved"))
}

/// `NpcBlessingGranted` (26233–26245).
pub(super) fn npc_blessing_granted(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:NpcBlessingGranted"))
}

/// `CourierLetterSent` (26246–26258).
pub(super) fn courier_letter_sent(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CourierLetterSent"))
}

/// `TavernDiceRoundOpened`, `TavernDiceRoundCancelled`, `TavernDiceRoundResolved`, `TavernDrinkOrdered` (26262–26282).
pub(super) fn tavern_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:TavernDiceRoundOpened"))
}

/// `ParleySettled` (26283–26305).
pub(super) fn parley_settled(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ParleySettled"))
}

/// `NpcBribeOffered` (26781–26789).
pub(super) fn npc_bribe_offered(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:NpcBribeOffered"))
}

/// `NpcPocketPicked` (26790–26802).
pub(super) fn npc_pocket_picked(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:NpcPocketPicked"))
}

/// `NpcPlaced`, `NpcMoved`, `NpcHarmed`, `NpcDied`, `NpcStanceChanged` (27044–27051).
pub(super) fn npc_world_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:NpcPlaced"))
}
