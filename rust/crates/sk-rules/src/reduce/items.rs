//! Ветки редьюсера `applyGameEventCurrent`: Предметы и боеприпасы: снаряжение, жизненный цикл предметов, заряды на рассвете, использование и расход, боеприпасы, снаряжение NPC, выдача, контейнеры добычи, кошель сценария. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 25390–25395, 25402–25421, 25422–25424, 25425–25440, 25441–25444, 25449–25468, 25486–25491, 26144–26154, 26803–26808, 26923–26956. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Не перенесены: жизненный цикл предметов (`applyItemLifecycleEventToPlayers`
//! — крейт `sk-items-life` уже есть, но ветки зовут полный
//! `refreshPlayerDerivedState`, которому нужен вывод листа героя из
//! `sk-character`), выдача вещи (`ItemGranted`, та же причина) и контейнеры
//! добычи (`applyLootContainerEvent` — `loot-containers`, крейт `sk-director`).
//!
//! Здесь же общие помощники предметов для соседних веток: `addInventoryItem`
//! (23993; стопка — `society_helpers::inventory_stack_index`), `npcLoadoutAfterSpend` (23543) и
//! частичная копия `refreshPlayerDerivedState` (23603).

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, combat_active, find_actor, replace_actor};
use sk_core::js::{self, is_true, s, safe_int, truthy};
use sk_core::Event;

use super::social::{event_value, set_hero_currency};
use super::{scene_turn_and_round, target_of, Reduced};
use crate::journal::{append_battle_log, Entry};
use crate::pause::unported;
use crate::turn_economy::{economy_of, event_version, set_economy, spend_combat_economy, spend_versioned_action_frame, spend_versioned_attack_replacement, with, ACTION_ECONOMY_EVENT_VERSION};

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "ItemEquipped",
    "ItemUnequipped",
    "ItemTransferred",
    "ItemAttunementChanged",
    "ItemChargesSpent",
    "ItemDestroyed",
    "MagicItemActivationChanged",
    "ItemGranted",
    "LootContainerCreated",
    "LootContainerTaken",
];

// --- общие помощники предметов --------------------------------------------

/// Список инвентаря: не массив — пусто (`Array.isArray(x) ? x : []`).
fn inventory_list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `addInventoryItem(inventory, incoming)` (23993): в стопку того же вида,
/// иначе новой строкой.
pub(super) fn add_inventory_item(inventory: Option<&Value>, incoming: &Value) -> Value {
    let current = inventory_list(inventory);
    let Some(index) = crate::society_helpers::inventory_stack_index(&current, incoming) else {
        let mut next = current;
        next.push(incoming.clone());
        return Value::Array(next);
    };
    let maximum = sk_economy::merchant_economy::MAX_STOCK_QUANTITY;
    Value::Array(
        current
            .into_iter()
            .enumerate()
            .map(|(position, item)| {
                if position != index {
                    return item;
                }
                let quantity = (safe_int(item.get("quantity"), 1) + safe_int(incoming.get("quantity"), 1)).min(maximum);
                js::spread(&item, json!({ "quantity": quantity }))
            })
            .collect(),
    )
}

/// `refreshPlayerDerivedState(state, actorIds)` (23603) — **частичная** копия.
///
/// Лист героя (`deriveCharacterSheet`, `character-lifecycle` — крейт
/// `sk-character`) ещё не перенесён, поэтому лист не выводится заново, а
/// берётся прежний — ровно так JS ведёт себя, когда вывод листа бросает:
/// `armor`, `speed`, `proficiency` переписываются из прежнего листа, если он
/// есть. Заклинания и боевые действия пересчитываются, как в JS. Заменить на
/// полную версию, когда появятся `sk-character` (Р4б).
///
/// Груз — `inventoryLoadFor` крейта `sk-items-life`. Его `TypeError` на
/// мусорном инвентаре (не массив) обрывает событие, как в JS: `state.players`
/// остаётся прежним.
pub(super) fn refresh_player_derived_state(state: &mut Value, actor_ids: &[String]) -> Reduced {
    let requested: HashSet<&str> = actor_ids.iter().map(String::as_str).collect();
    let options = match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    };
    let Some(players) = state.get("players").and_then(Value::as_array).cloned() else {
        state["players"] = json!([]);
        return Ok(());
    };
    let mut next = Vec::with_capacity(players.len());
    for actor in players {
        let id = actor_id(&actor);
        if !requested.is_empty() && !requested.contains(id.as_str()) {
            next.push(actor);
            continue;
        }
        let sheet = actor.get("characterSheet").filter(|sheet| !sheet.is_null()).cloned().unwrap_or(Value::Null);
        let spells = sk_combat_content::combat_spells::combat_spells_for(Some(&actor), Some(&options));
        let mut actions = sk_combat_content::combat_actions::combat_actions_for(Some(&actor));
        if let Some(continuation) = crate::enervation_link::enervation_continuation_action_for(state, Some(&Value::String(id.clone())), None) {
            actions.push(continuation);
        }
        let load = sk_items_life::item_lifecycle::inventory_load_for(Some(&actor)).map_err(|error| super::world::type_error(error.message()))?;
        let Value::Object(mut map) = actor else {
            next.push(actor);
            continue;
        };
        if truthy(Some(&sheet)) {
            map.insert("armor".into(), sheet.get("armor_class").and_then(|armor| armor.get("value")).cloned().unwrap_or(Value::Null));
            map.insert("speed".into(), sheet.get("speed").and_then(|speed| speed.get("value")).cloned().unwrap_or(Value::Null));
            map.insert("proficiency".into(), sheet.get("proficiency_bonus").cloned().unwrap_or(Value::Null));
        }
        map.insert("characterSheet".into(), sheet);
        map.insert("combatSpells".into(), Value::Array(spells));
        map.insert("combatActions".into(), Value::Array(actions));
        map.insert("inventoryLoad".into(), load);
        next.push(Value::Object(map));
    }
    state["players"] = Value::Array(next);
    Ok(())
}

/// `npcLoadoutAfterSpend(loadout, payload)` (23543): остаток берётся из
/// события целиком, кончившееся убирается.
pub(super) fn npc_loadout_after_spend(loadout: Option<&Value>, payload: &Value) -> Value {
    let normalized = sk_economy::enemy_loadouts::normalize_enemy_loadout(loadout);
    let instance_id = s(payload.get("item_instance_id"));
    if instance_id.is_empty() {
        return normalized;
    }
    let quantity_after = safe_int(payload.get("quantity_after"), 0).max(0);
    let shots_after = safe_int(payload.get("shots_after"), quantity_after).max(0);
    let shots_before = safe_int(payload.get("shots_before"), shots_after).max(0);
    let ammunition = js::string(payload.get("reason")) == "ammunition";
    let items = inventory_list(normalized.get("items"));
    let items: Vec<Value> = items
        .into_iter()
        .filter_map(|item| {
            if js::string(item.get("item_instance_id")) != instance_id {
                return Some(item);
            }
            if quantity_after <= 0 || shots_after <= 0 {
                return None;
            }
            let mut patch = Map::new();
            patch.insert("quantity".into(), Value::from(quantity_after));
            if ammunition {
                let max = safe_int(item.get("charges").and_then(|charges| charges.get("max")), 0).max(shots_before);
                patch.insert("charges".into(), json!({ "current": shots_after, "max": max }));
            }
            Some(js::spread(&item, Value::Object(patch)))
        })
        .collect();
    js::spread(&normalized, json!({ "items": items }))
}

/// `item.quantity > 0` по сравнению JS.
fn positive_quantity(item: &Value) -> bool {
    js::number(item.get("quantity")) > 0.0
}

// --- ветки -----------------------------------------------------------------

/// `EquipmentChanged` (25390–25395).
pub(super) fn equipment_changed(state: &mut Value, event: &Event) -> Reduced {
    let target = target_of(event);
    let payload = event.payload.clone();
    let wanted = js::string(payload.get("item_id"));
    replace_actor(state, &target, |actor| {
        let inventory: Vec<Value> = inventory_list(actor.get("inventory"))
            .into_iter()
            .map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("weapon") {
                    let equipped = js::string(item.get("id")) == wanted;
                    js::spread(&item, json!({ "equipped": equipped }))
                } else {
                    item
                }
            })
            .collect();
        if let Some(map) = actor.as_object_mut() {
            map.insert("inventory".into(), Value::Array(inventory));
        }
    });
    let actor = event.actor_id.clone().unwrap_or_default();
    if payload.get("timing").and_then(Value::as_str) == Some("action") {
        spend_combat_economy(state, &actor, "action", false, false);
    }
    let (scene_turn, round) = scene_turn_and_round(state);
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "equipment")
        .set("actorId", super::social::actor_value(event))
        .set("actorKind", "player")
        .opt("itemId", payload.get("item_id").cloned())
        .opt("itemName", payload.get("item_name").cloned())
        .build();
    append_battle_log(state, event, entry);
    Ok(())
}

/// `ItemEquipped`, `ItemUnequipped`, `ItemTransferred`, `ItemAttunementChanged`, `ItemChargesSpent`, `ItemDestroyed`, `MagicItemActivationChanged` (25402–25421).
pub(super) fn item_lifecycle_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:ItemEquipped"))
}

/// `ItemDawnRechargeResolved` (25422–25424).
pub(super) fn item_dawn_recharge_resolved(state: &mut Value, event: &Event) -> Reduced {
    let players = state.get("players").cloned().unwrap_or(Value::Null);
    state["players"] = sk_items::item_dawn_recharge::apply_item_dawn_recharge_to_players(&players, &event_value(event));
    Ok(())
}

/// Ключ экономики хода без проверки на пустоту: `action_economy[event.actor_id]`.
fn unchecked_actor_key(event: &Event) -> String {
    event.actor_id.clone().unwrap_or_else(|| "null".into())
}

/// `ItemUsed` (25425–25440).
pub(super) fn item_used(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let versioned = event_version(&payload) >= ACTION_ECONOMY_EVENT_VERSION;
    let replacement = is_true(payload.get("attack_replacement"));
    let actor = event.actor_id.clone().filter(|id| !id.is_empty());
    let combat_action = payload.get("combat_action");
    if replacement && versioned && combat_active(state) && actor.is_some() {
        spend_versioned_attack_replacement(state, actor.as_deref().unwrap_or_default());
    } else if truthy(combat_action) && versioned && combat_action.and_then(Value::as_str) == Some("action") {
        spend_versioned_action_frame(state, &unchecked_actor_key(event), true, true);
    } else if truthy(combat_action) {
        spend_combat_economy(state, event.actor_id.as_deref().unwrap_or_default(), &js::string(combat_action), false, false);
    }
    if replacement && !versioned && combat_active(state) {
        if let Some(id) = actor {
            let attacker = find_actor(state, &id).cloned();
            let economy = economy_of(state, &id);
            let used = safe_int(economy.get("attacks_used"), 0).max(0) + 1;
            let allowed = sk_combat_content::combat_actions::weapon_attacks_per_action_for(attacker.as_ref());
            set_economy(state, &id, with(&economy, json!({ "attacks_used": used, "attacks_allowed": js::num(allowed) })));
        }
    }
    Ok(())
}

/// `ItemConsumed` (25441–25444).
pub(super) fn item_consumed(state: &mut Value, event: &Event) -> Reduced {
    let target = target_of(event);
    let payload = event.payload.clone();
    let wanted = js::string(payload.get("item_id"));
    let spent = safe_int(payload.get("quantity"), 1);
    replace_actor(state, &target, |actor| {
        let inventory: Vec<Value> = inventory_list(actor.get("inventory"))
            .into_iter()
            .map(|item| {
                if js::string(item.get("id")) == wanted {
                    let quantity = (safe_int(item.get("quantity"), 1) - spent).max(0);
                    js::spread(&item, json!({ "quantity": quantity }))
                } else {
                    item
                }
            })
            .filter(positive_quantity)
            .collect();
        if let Some(map) = actor.as_object_mut() {
            map.insert("inventory".into(), Value::Array(inventory));
        }
    });
    refresh_player_derived_state(state, &[target])?;
    Ok(())
}

/// `AmmunitionSpent` (25449–25468).
pub(super) fn ammunition_spent(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let owner = match payload.get("owner_id").filter(|value| !value.is_null()) {
        Some(value) => s(Some(value)),
        None => target_of(event),
    };
    let quantity_after = safe_int(payload.get("quantity_after"), 0).max(0);
    let shots_after = safe_int(payload.get("shots_after"), 0).max(0);
    let capacity_after = shots_after.max(safe_int(payload.get("capacity_after"), shots_after));
    let wanted = js::string(payload.get("item_id"));
    replace_actor(state, &owner, |actor| {
        let inventory: Vec<Value> = inventory_list(actor.get("inventory"))
            .into_iter()
            .filter_map(|item| {
                if js::string(item.get("id")) != wanted {
                    return Some(item);
                }
                if quantity_after <= 0 || shots_after <= 0 {
                    return None;
                }
                Some(js::spread(&item, json!({ "quantity": quantity_after, "charges": { "current": shots_after, "max": capacity_after } })))
            })
            .collect();
        if let Some(map) = actor.as_object_mut() {
            map.insert("inventory".into(), Value::Array(inventory));
        }
    });
    refresh_player_derived_state(state, &[owner])?;
    Ok(())
}

/// `NpcEquipmentSpent` (25486–25491).
pub(super) fn npc_equipment_spent(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let owner = match payload.get("owner_id").filter(|value| !value.is_null()) {
        Some(value) => s(Some(value)),
        None => event.actor_id.clone().unwrap_or_default(),
    };
    replace_actor(state, &owner, |actor| {
        let loadout = npc_loadout_after_spend(actor.get("loadout"), &payload);
        if let Some(map) = actor.as_object_mut() {
            map.insert("loadout".into(), loadout);
        }
    });
    Ok(())
}

/// `ScenarioPurseGranted` (26144–26154).
pub(super) fn scenario_purse_granted(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// Перенесён ли полный вывод листа героя (`deriveCharacterSheet`,
/// `sk-character`). Пока нет — выдача вещи (`ItemGranted` схемы 2) не
/// включена: надетая магическая вещь меняет КД (кольцо защиты), а частичный
/// `refreshPlayerDerivedState` лист не выводит. Тело ветки готово и
/// сверено с корпусом, кроме этого случая.
const CHARACTER_SHEET_PORTED: bool = false;

/// `ItemGranted` (26803–26808).
pub(super) fn item_granted(state: &mut Value, event: &Event) -> Reduced {
    if !CHARACTER_SHEET_PORTED {
        return Err(unported("reduce:ItemGranted"));
    }
    let target = target_of(event);
    let item = event.payload.get("item").cloned().unwrap_or(Value::Null);
    replace_actor(state, &target, |actor| {
        let mut inventory = inventory_list(actor.get("inventory"));
        inventory.push(item.clone());
        if let Some(map) = actor.as_object_mut() {
            map.insert("inventory".into(), Value::Array(inventory));
        }
    });
    if event.event_schema_version.is_some_and(|version| version >= 2) {
        refresh_player_derived_state(state, std::slice::from_ref(&target))?;
    }
    if truthy(event.payload.get("source_npc_id")) {
        state["npc_world"] = super::social::apply_npc_world(state, event);
    }
    Ok(())
}

/// `LootContainerCreated`, `LootContainerTaken` (26923–26956).
pub(super) fn loot_container_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:LootContainerCreated"))
}
