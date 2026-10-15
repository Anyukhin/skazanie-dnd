//! Общество: стойка скупщика, карманная кража, таверна, уход NPC из сцены. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 5455, 7911, 10746–10769, 11881–11920, 13013–13030.
//!
//! Перенесено: `inventoryStackIndex` (5455) — его зовёт редьюсер
//! (`NpcPocketPicked` через `addInventoryItem`). Остальное (7911, 10746–10769,
//! 11881–11920, 13013–13030) читает разбор команд и ждёт задачи общества (Р7).

use serde_json::Value;
use sk_core::js::{is_true, truthy};

/// `inventoryStackIndex(inventory, incoming)` (5455): стопка того же вида
/// среди ненадетых вещей; надетая входящая вещь в стопку не идёт.
pub fn inventory_stack_index(inventory: &[Value], incoming: &Value) -> Option<usize> {
    if !truthy(Some(incoming)) || is_true(incoming.get("equipped")) {
        return None;
    }
    let key = sk_economy::merchant_economy::inventory_stack_key(Some(incoming));
    inventory.iter().position(|item| !is_true(item.get("equipped")) && sk_economy::merchant_economy::inventory_stack_key(Some(item)) == key)
}
