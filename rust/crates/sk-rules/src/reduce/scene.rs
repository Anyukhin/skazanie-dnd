//! Ветки редьюсера `applyGameEventCurrent`: Сцена и карта: смена сцены, импорт карты, этажи, встреча и начало боя, перемещение, раскрытие, двери, взлом, объекты сцены, сущности. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 24439–24509, 24519–24617, 24628–24695, 26059–26089, 26090–26113, 26458–26488, 26606–26608, 26609–26611, 26612–26621, 26622–26631, 26632–26635, 26636–26641, 26642–26659, 26663–26664, 26665–26671, 26672–26676, 26677–26678, 26679–26691, 26692–26698, 26699–26705, 26706–26712, 26713–26731, 26732–26749, 26750–26760, 26764–26774. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.

use serde_json::Value;
use sk_core::Event;

use super::Reduced;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "SceneAdvanced",
    "LocationMapImported",
    "MapLevelChanged",
    "EncounterCreated",
    "CombatStarted",
    "ActorMoved",
    "AreaRevealed",
    "DoorStateChanged",
    "DoorBarricaded",
    "DoorBarricadeCleared",
    "DoorBarricadeForced",
    "DoorForced",
    "DoorLockpicked",
    "LockpickNoticed",
    "SceneObjectOperated",
    "ScenarioKnightHeadReturned",
    "SceneObjectCheckResolved",
    "SceneObjectInspected",
    "SceneObjectUseRecorded",
    "SceneObjectKnowledgeRevealed",
    "SceneObjectLootRevealed",
    "SceneObjectStateChanged",
    "SceneObjectLootGranted",
    "SceneObjectEffectApplied",
    "EntitySpawned",
];

/// `SceneAdvanced` (24439–24509).
pub(super) fn scene_advanced(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneAdvanced"))
}

/// `LocationMapImported` (24519–24617).
pub(super) fn location_map_imported(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:LocationMapImported"))
}

/// `MapLevelChanged` (24628–24695).
pub(super) fn map_level_changed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MapLevelChanged"))
}

/// `EncounterCreated` (26059–26089).
pub(super) fn encounter_created(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:EncounterCreated"))
}

/// `CombatStarted` (26090–26113).
pub(super) fn combat_started(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CombatStarted"))
}

/// `ActorMoved` (26458–26488).
pub(super) fn actor_moved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ActorMoved"))
}

/// `AreaRevealed` (26606–26608).
pub(super) fn area_revealed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:AreaRevealed"))
}

/// `DoorStateChanged` (26609–26611).
pub(super) fn door_state_changed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:DoorStateChanged"))
}

/// `DoorBarricaded` (26612–26621).
pub(super) fn door_barricaded(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:DoorBarricaded"))
}

/// `DoorBarricadeCleared` (26622–26631).
pub(super) fn door_barricade_cleared(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:DoorBarricadeCleared"))
}

/// `DoorBarricadeForced` (26632–26635).
pub(super) fn door_barricade_forced(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:DoorBarricadeForced"))
}

/// `DoorForced` (26636–26641).
pub(super) fn door_forced(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:DoorForced"))
}

/// `DoorLockpicked` (26642–26659).
pub(super) fn door_lockpicked(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:DoorLockpicked"))
}

/// `LockpickNoticed` (26663–26664).
pub(super) fn lockpick_noticed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:LockpickNoticed"))
}

/// `SceneObjectOperated` (26665–26671).
pub(super) fn scene_object_operated(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectOperated"))
}

/// `ScenarioKnightHeadReturned` (26672–26676).
pub(super) fn scenario_knight_head_returned(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ScenarioKnightHeadReturned"))
}

/// `SceneObjectCheckResolved` (26677–26678).
pub(super) fn scene_object_check_resolved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectCheckResolved"))
}

/// `SceneObjectInspected` (26679–26691).
pub(super) fn scene_object_inspected(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectInspected"))
}

/// `SceneObjectUseRecorded` (26692–26698).
pub(super) fn scene_object_use_recorded(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectUseRecorded"))
}

/// `SceneObjectKnowledgeRevealed` (26699–26705).
pub(super) fn scene_object_knowledge_revealed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectKnowledgeRevealed"))
}

/// `SceneObjectLootRevealed` (26706–26712).
pub(super) fn scene_object_loot_revealed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectLootRevealed"))
}

/// `SceneObjectStateChanged` (26713–26731).
pub(super) fn scene_object_state_changed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectStateChanged"))
}

/// `SceneObjectLootGranted` (26732–26749).
pub(super) fn scene_object_loot_granted(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectLootGranted"))
}

/// `SceneObjectEffectApplied` (26750–26760).
pub(super) fn scene_object_effect_applied(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SceneObjectEffectApplied"))
}

/// `EntitySpawned` (26764–26774).
pub(super) fn entity_spawned(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:EntitySpawned"))
}
