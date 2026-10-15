//! Ветки редьюсера `applyGameEventCurrent`: Кампания и мир: замена состояния (`LegacyStateImported`, `CampaignRewound` до `switch`), история и дуги кампании, решения отряда, должности. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 24285–24301, 24302–24304, 24305–24347, 24357–24359, 24360–24378, 24379–24397, 24398–24415, 24416–24432, 24433–24438, 27037–27039. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.

use serde_json::Value;
use sk_core::Event;

use super::Reduced;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "LegacyStateImported",
    "CampaignRewound",
    "CampaignStoryCompleted",
    "CampaignArcChainSet",
    "CampaignArcCompleted",
    "PartyDecisionOpened",
    "PartyVoteCast",
    "PartyDecisionAbstained",
    "PartyDecisionResolved",
    "PartyDecisionExpired",
    "PartyDecisionConsumed",
    "OfficeVacated",
    "OfficeHolderInstalled",
    "OfficeSuccessionSkipped",
];

/// `CampaignStoryCompleted` (24285–24301).
pub(super) fn campaign_story_completed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CampaignStoryCompleted"))
}

/// `CampaignArcChainSet` (24302–24304).
pub(super) fn campaign_arc_chain_set(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CampaignArcChainSet"))
}

/// `CampaignArcCompleted` (24305–24347).
pub(super) fn campaign_arc_completed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CampaignArcCompleted"))
}

/// `PartyDecisionOpened` (24357–24359).
pub(super) fn party_decision_opened(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:PartyDecisionOpened"))
}

/// `PartyVoteCast` (24360–24378).
pub(super) fn party_vote_cast(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:PartyVoteCast"))
}

/// `PartyDecisionAbstained` (24379–24397).
pub(super) fn party_decision_abstained(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:PartyDecisionAbstained"))
}

/// `PartyDecisionResolved` (24398–24415).
pub(super) fn party_decision_resolved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:PartyDecisionResolved"))
}

/// `PartyDecisionExpired` (24416–24432).
pub(super) fn party_decision_expired(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:PartyDecisionExpired"))
}

/// `PartyDecisionConsumed` (24433–24438).
pub(super) fn party_decision_consumed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:PartyDecisionConsumed"))
}

/// `OfficeVacated`, `OfficeHolderInstalled`, `OfficeSuccessionSkipped` (27037–27039).
pub(super) fn world_office_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:OfficeVacated"))
}

/// Замена состояния до `switch` (24201–24211): `LegacyStateImported` и
/// `CampaignRewound` с объектом `payload.state` возвращают нормализованную
/// копию этого состояния, без общих шагов после `switch`. `None` — событие
/// идёт обычным путём.
pub(super) fn replace_state(_state: &mut Value, event: &Event) -> Option<Reduced> {
    if !matches!(event.event_type.as_str(), "LegacyStateImported" | "CampaignRewound") {
        return None;
    }
    let replacement = event.payload.get("state");
    if !(sk_core::js::truthy(replacement) && matches!(replacement, Some(Value::Object(_) | Value::Array(_)))) {
        return None;
    }
    Some(Err(unported(&format!("reduce:{}", event.event_type))))
}
