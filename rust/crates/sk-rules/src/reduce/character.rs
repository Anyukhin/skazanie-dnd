//! Ветки редьюсера `applyGameEventCurrent`: Герой: выбор заклинаний и умений, броски характеристик и богатства, уровень и импорт, награды, опыт и вехи. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 26809–26825, 26826–26868, 26869–26871, 26872–26874, 26876–26916, 26917–26921, 26957–26971, 26972–26987. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.

use serde_json::Value;
use sk_core::Event;

use super::Reduced;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "SpellSelectionsUpdated",
    "CharacterChoicesUpdated",
    "CharacterAbilitiesRolled",
    "CharacterWealthRolled",
    "CharacterLeveledUp",
    "CharacterImported",
    "EncounterRewardsDistributed",
    "ExperienceAwarded",
    "MilestoneAwarded",
];

/// `SpellSelectionsUpdated` (26809–26825).
pub(super) fn spell_selections_updated(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SpellSelectionsUpdated"))
}

/// `CharacterChoicesUpdated` (26826–26868).
pub(super) fn character_choices_updated(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CharacterChoicesUpdated"))
}

/// `CharacterAbilitiesRolled` (26869–26871).
pub(super) fn character_abilities_rolled(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CharacterAbilitiesRolled"))
}

/// `CharacterWealthRolled` (26872–26874).
pub(super) fn character_wealth_rolled(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CharacterWealthRolled"))
}

/// `CharacterLeveledUp`, `CharacterImported` (26876–26916).
pub(super) fn character_lifecycle_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CharacterLeveledUp"))
}

/// `EncounterRewardsDistributed` (26917–26921).
pub(super) fn encounter_rewards_distributed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:EncounterRewardsDistributed"))
}

/// `ExperienceAwarded` (26957–26971).
pub(super) fn experience_awarded(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ExperienceAwarded"))
}

/// `MilestoneAwarded` (26972–26987).
pub(super) fn milestone_awarded(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MilestoneAwarded"))
}
