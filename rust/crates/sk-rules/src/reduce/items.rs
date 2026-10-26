//! Ветки редьюсера `applyGameEventCurrent`: Предметы и боеприпасы: снаряжение, жизненный цикл предметов, заряды на рассвете, использование и расход, боеприпасы, снаряжение NPC, выдача, контейнеры добычи, кошель сценария. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 25412–25417, 25424–25443, 25444–25446, 25447–25462, 25463–25466, 25471–25490, 25508–25513, 26166–26176, 26825–26830, 26945–26978. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Жизнь вещи — `applyItemLifecycleEventToPlayers` (`sk-items-life`),
//! контейнеры добычи — `applyLootContainerEvent` (`sk-director`), лист героя
//! в `refreshPlayerDerivedState` — `deriveCharacterSheet` (`sk-character`).
//!
//! Здесь же общие помощники предметов для соседних веток: `addInventoryItem`
//! (23993; стопка — `society_helpers::inventory_stack_index`), `npcLoadoutAfterSpend` (23565) и
//! `refreshPlayerDerivedState` (23625).

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, combat_active, find_actor, replace_actor};
use sk_core::js::{self, is_true, s, safe_int, truthy};
use sk_core::{Event, RuleError};

use super::social::{actor_value, event_value, set_hero_currency};
use super::world::type_error;
use super::{scene_turn_and_round, target_of, Reduced};
use crate::journal::{append_battle_log, Entry};
use crate::turn_economy::{economy_of, event_version, set_economy, spend_combat_economy, spend_versioned_action_frame, spend_versioned_attack_replacement, with, ACTION_ECONOMY_EVENT_VERSION};

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[];

// --- общие помощники предметов --------------------------------------------

/// Список инвентаря: не массив — пусто (`Array.isArray(x) ? x : []`).
fn inventory_list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `addInventoryItem(inventory, incoming)` (24015) — `society_helpers`.
pub(super) use crate::society_helpers::add_inventory_item;

/// `{ rulesetId: state.ruleset_id }` — опции `combatSpellsFor`.
pub(super) fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

/// `classResourceOptionsFor(state)` объектом JS (`{ classResources2024 }`).
pub(super) fn class_resource_options(state: &Value) -> Value {
    sk_combat_content::combat_actions::class_resource_options_for(Some(state)).to_value()
}

/// Отказ `character-lifecycle` (`TypeError` или отказ модуля) — отказ
/// редьюсера: событие дальше не идёт, как исключение в JS.
pub(super) fn lifecycle_error(error: sk_character::character_lifecycle::CharacterLifecycleError) -> RuleError {
    module_error(error.code, error.message)
}

/// `sheet.<field>.value`: у отсутствующего или `null` поля JS бросает
/// `TypeError`; у примитива `.value` — `undefined` (`None`, ключ в JSON не
/// попадает).
pub(super) fn sheet_value(sheet: &Value, field: &str) -> Result<Option<Value>, RuleError> {
    match sheet.get(field) {
        None | Some(Value::Null) => Err(type_error(&format!("Cannot read properties of {} (reading 'value')", if sheet.get(field).is_some() { "null" } else { "undefined" }))),
        Some(inner) => Ok(inner.get("value").cloned()),
    }
}

/// `{ ...actor, key: value }`, где `value` может быть `undefined`: такой ключ
/// JSON не печатает, поэтому он убирается.
pub(super) fn put_defined(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.into(), value);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// `refreshPlayerDerivedState(state, actorIds)` (23625): лист героя
/// выводится заново (`deriveCharacterSheet`; отказ вывода — прежний лист,
/// как `try {} catch {}` в JS), затем заклинания, боевые действия и груз.
///
/// Груз — `inventoryLoadFor` крейта `sk-items-life`. Его `TypeError` на
/// мусорном инвентаре (не массив) обрывает событие, как в JS: `state.players`
/// остаётся прежним. Так же обрывает лист без `armor_class` или `speed`.
pub(super) fn refresh_player_derived_state(state: &mut Value, actor_ids: &[String]) -> Reduced {
    let requested: HashSet<&str> = actor_ids.iter().map(String::as_str).collect();
    let options = ruleset_options(state);
    let sheet_options = class_resource_options(state);
    let players = match state.get("players") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(players)) => players.clone(),
        Some(_) => return Err(type_error("(state.players ?? []).map is not a function")),
    };
    let mut next = Vec::with_capacity(players.len());
    for actor in players {
        let id = actor_id(&actor);
        if !requested.is_empty() && !requested.contains(id.as_str()) {
            next.push(actor);
            continue;
        }
        if actor.is_null() {
            return Err(type_error("Cannot read properties of null (reading 'characterSheet')"));
        }
        let sheet = match sk_character::character_lifecycle::derive_character_sheet(Some(&actor), Some(&sheet_options)) {
            Ok(sheet) => sheet,
            Err(_) => actor.get("characterSheet").filter(|sheet| !sheet.is_null()).cloned().unwrap_or(Value::Null),
        };
        // Заклинания, действия и груз читают прежнего героя (до полей листа),
        // поэтому считаются до того, как он переедет в новый объект; порядок
        // отказов прежний: сначала поля листа, затем груз.
        let spells = sk_combat_content::combat_spells::combat_spells_for(Some(&actor), Some(&options));
        let mut actions = sk_combat_content::combat_actions::combat_actions_for(Some(&actor));
        if let Some(continuation) = crate::enervation_link::enervation_continuation_action_for(state, Some(&Value::String(id.clone())), None) {
            actions.push(continuation);
        }
        let load = sk_items_life::item_lifecycle::inventory_load_for(Some(&actor));
        let mut map = match actor {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        if truthy(Some(&sheet)) {
            put_defined(&mut map, "armor", sheet_value(&sheet, "armor_class")?);
            put_defined(&mut map, "speed", sheet_value(&sheet, "speed")?);
            put_defined(&mut map, "proficiency", sheet.get("proficiency_bonus").cloned());
        }
        let load = load.map_err(|error| type_error(error.message()))?;
        map.insert("characterSheet".into(), sheet);
        map.insert("combatSpells".into(), Value::Array(spells));
        map.insert("combatActions".into(), Value::Array(actions));
        map.insert("inventoryLoad".into(), load);
        next.push(Value::Object(map));
    }
    state["players"] = Value::Array(next);
    Ok(())
}

/// `npcLoadoutAfterSpend(loadout, payload)` (23565): остаток берётся из
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

/// `EquipmentChanged` (25412–25417).
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

/// `ItemEquipped`, `ItemUnequipped`, `ItemTransferred`, `ItemAttunementChanged`, `ItemChargesSpent`, `ItemDestroyed`, `MagicItemActivationChanged` (25424–25443).
pub(super) fn item_lifecycle_event(state: &mut Value, event: &Event) -> Reduced {
    let event_json = event_value(event);
    let players = sk_items_life::item_lifecycle::apply_item_lifecycle_event_to_players(state.get("players"), &event_json)
        .map_err(|error| module_error(error.code().map(str::to_string), error.message().to_string()))?;
    state["players"] = players;
    let payload = &event.payload;
    if event.event_type == "ItemTransferred" && payload.get("recipient_kind").and_then(Value::as_str) == Some("npc") {
        state["npc_world"] = super::social::apply_npc_world(state, event);
    }
    refresh_player_derived_state(state, &crate::core::unique_string_list(&event.target_ids))?;
    let combat_action = payload.get("combat_action");
    if event.event_type == "MagicItemActivationChanged" && truthy(combat_action) {
        spend_combat_economy(state, event.actor_id.as_deref().unwrap_or_default(), &js::string(combat_action), false, false);
    }
    let equip = matches!(event.event_type.as_str(), "ItemEquipped" | "ItemUnequipped");
    let action = s(combat_action);
    if equip && matches!(action.as_str(), "object_interaction" | "action") && combat_active(state) {
        if combat_action.and_then(Value::as_str) == Some("object_interaction") {
            let key = unchecked_actor_key(event);
            let economy = economy_of(state, &key);
            set_economy(state, &key, with(&economy, json!({ "object_interaction": false })));
        } else {
            spend_combat_economy(state, event.actor_id.as_deref().unwrap_or_default(), "action", false, false);
        }
    }
    Ok(())
}

/// `ItemDawnRechargeResolved` (25444–25446).
pub(super) fn item_dawn_recharge_resolved(state: &mut Value, event: &Event) -> Reduced {
    let players = state.get("players").cloned().unwrap_or(Value::Null);
    state["players"] = sk_items::item_dawn_recharge::apply_item_dawn_recharge_to_players(&players, &event_value(event));
    Ok(())
}

/// Ключ экономики хода без проверки на пустоту: `action_economy[event.actor_id]`.
fn unchecked_actor_key(event: &Event) -> String {
    event.actor_id.clone().unwrap_or_else(|| "null".into())
}

/// `ItemUsed` (25447–25462).
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

/// `ItemConsumed` (25463–25466).
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

/// `AmmunitionSpent` (25471–25490).
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

/// `NpcEquipmentSpent` (25508–25513).
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

/// `ScenarioPurseGranted` (26166–26176).
pub(super) fn scenario_purse_granted(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// `ItemGranted` (26825–26830).
pub(super) fn item_granted(state: &mut Value, event: &Event) -> Reduced {
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

/// `LootContainerCreated`, `LootContainerTaken` (26945–26978).
pub(super) fn loot_container_event(state: &mut Value, event: &Event) -> Reduced {
    let recipient_ids = sk_director::loot_containers::apply_loot_container_event(state, &event_value(event)).map_err(|error| module_error(error.code, error.message))?;
    let payload = &event.payload;
    let created = event.event_type == "LootContainerCreated";
    if !created && truthy(payload.get("combat_action")) {
        spend_combat_economy(state, event.actor_id.as_deref().unwrap_or_default(), &js::string(payload.get("combat_action")), false, false);
    }
    if !recipient_ids.is_empty() {
        refresh_player_derived_state(state, &recipient_ids)?;
    }
    let entry = if created {
        let container = payload.get("container");
        let field = |key: &str| container.and_then(|container| container.get(key));
        Entry::new()
            .set("type", "loot-container")
            .set("containerId", s(field("id")))
            .set("containerKind", s(field("kind")))
            .set("containerName", s(field("name")))
            .opt("itemCount", js_length(field("items")))
    } else {
        let actor = event.actor_id.clone().unwrap_or_default();
        Entry::new()
            .set("type", "loot-taken")
            .set("actorId", actor_value(event))
            .set("actorKind", crate::core::combat_actor_kind(state, &actor))
            .set("containerId", s(payload.get("container_id")))
            .set("containerName", s(payload.get("container_name")))
            .set("recipientId", s(payload.get("recipient_id")))
            .opt("itemCount", js_length(payload.get("items")))
            .set("remainingCount", safe_int(payload.get("remaining_count"), 0).max(0))
            .set("statusAfter", s(payload.get("status_after")))
    };
    append_battle_log(state, event, entry.build());
    Ok(())
}

/// Отказ модуля ниже (`{ code, message }`): с кодом — отказ правила, без
/// кода — `TypeError`.
pub(super) fn module_error(code: Option<String>, message: String) -> RuleError {
    match code {
        Some(code) => RuleError::new(code, message),
        None => type_error(&message),
    }
}

/// `(value ?? []).length`: у массива — длина, у строки — число единиц
/// UTF-16, у объекта — его поле `length`, у числа и логического —
/// `undefined` (`None`).
fn js_length(value: Option<&Value>) -> Option<Value> {
    match value {
        None | Some(Value::Null) => Some(Value::from(0)),
        Some(Value::Array(items)) => Some(Value::from(items.len())),
        Some(Value::String(text)) => Some(Value::from(text.encode_utf16().count())),
        Some(Value::Object(map)) => map.get("length").cloned(),
        Some(_) => None,
    }
}
