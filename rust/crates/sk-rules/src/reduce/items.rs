//! Ветки редьюсера `applyGameEventCurrent`: Предметы и боеприпасы: снаряжение, жизненный цикл предметов, заряды на рассвете, использование и расход, боеприпасы, снаряжение NPC, выдача, контейнеры добычи, кошель сценария. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 25390–25395, 25402–25421, 25422–25424, 25425–25440, 25441–25444, 25449–25468, 25486–25491, 26144–26154, 26803–26808, 26923–26956. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.

use serde_json::Value;
use sk_core::Event;

use super::Reduced;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "EquipmentChanged",
    "ItemEquipped",
    "ItemUnequipped",
    "ItemTransferred",
    "ItemAttunementChanged",
    "ItemChargesSpent",
    "ItemDestroyed",
    "MagicItemActivationChanged",
    "ItemDawnRechargeResolved",
    "ItemUsed",
    "ItemConsumed",
    "AmmunitionSpent",
    "NpcEquipmentSpent",
    "ScenarioPurseGranted",
    "ItemGranted",
    "LootContainerCreated",
    "LootContainerTaken",
];

/// `EquipmentChanged` (25390–25395).
pub(super) fn equipment_changed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:EquipmentChanged"))
}

/// `ItemEquipped`, `ItemUnequipped`, `ItemTransferred`, `ItemAttunementChanged`, `ItemChargesSpent`, `ItemDestroyed`, `MagicItemActivationChanged` (25402–25421).
pub(super) fn item_lifecycle_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ItemEquipped"))
}

/// `ItemDawnRechargeResolved` (25422–25424).
pub(super) fn item_dawn_recharge_resolved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ItemDawnRechargeResolved"))
}

/// `ItemUsed` (25425–25440).
pub(super) fn item_used(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ItemUsed"))
}

/// `ItemConsumed` (25441–25444).
pub(super) fn item_consumed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ItemConsumed"))
}

/// `AmmunitionSpent` (25449–25468).
pub(super) fn ammunition_spent(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:AmmunitionSpent"))
}

/// `NpcEquipmentSpent` (25486–25491).
pub(super) fn npc_equipment_spent(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:NpcEquipmentSpent"))
}

/// `ScenarioPurseGranted` (26144–26154).
pub(super) fn scenario_purse_granted(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ScenarioPurseGranted"))
}

/// `ItemGranted` (26803–26808).
pub(super) fn item_granted(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ItemGranted"))
}

/// `LootContainerCreated`, `LootContainerTaken` (26923–26956).
pub(super) fn loot_container_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:LootContainerCreated"))
}
