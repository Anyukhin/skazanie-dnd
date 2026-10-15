//! Объекты сцены и двери: состояние дверей и пропсов, взаимодействия. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 2719–2904 (кроме взлома 2816–2852).
//!
//! Перенесено то, что зовёт редьюсер: `doorEdgeBlocks`, `setSceneDoorState`,
//! `setSceneObjectPropState`, `doorTraceKey`, `updateSceneObjectInteraction`,
//! `setScenePropAt`. `sceneObjectState` (2760) читает разбор команды — его
//! перенесёт задача объектов (Р11).

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_core::text::head;
use sk_core::RuleError;
use sk_tactical::combat_bounds::{ensure_scene_tactical_map, write_scene_tactical_map};
use sk_tactical::tactical_map::{add_prop, set_door, DOOR_STATES};

use super::placement::map_error;
use crate::core::{spread_value, unique_strings};

/// `doorEdgeBlocks(doorState)`: открытый и выломанный проём не держат ни
/// шаг, ни взгляд. `None` — `undefined` (держит).
pub fn door_edge_blocks(door_state: Option<&Value>) -> bool {
    !matches!(js::string(door_state).as_str(), "open" | "broken")
}

/// `setTacticalDoor(map, { ...door, ...patch })` для двери карты сцены и
/// запись карты обратно. Двери нет — ничего.
pub fn patch_scene_door(state: &mut Value, door_id: Option<&Value>, patch: impl FnOnce(&sk_tactical::tactical_map::TacticalDoor) -> Option<Value>) -> Result<bool, RuleError> {
    let Some(mut map) = ensure_scene_tactical_map(state).map_err(map_error)? else { return Ok(false) };
    let id = js::s(door_id);
    let Some(door) = map.door(&id).cloned() else { return Ok(false) };
    let Some(fields) = patch(&door) else { return Ok(false) };
    let next = js::spread(&door.to_json(), fields);
    set_door(&mut map, &next).map_err(map_error)?;
    write_scene_tactical_map(state, &map).map_err(map_error)?;
    Ok(true)
}

/// `setSceneDoorState(state, doorId, doorState)` (2731): признаки ребра
/// выводятся из состояния полотна и баррикады.
pub fn set_scene_door_state(state: &mut Value, door_id: Option<&Value>, door_state: Option<&Value>) -> Result<(), RuleError> {
    let wanted = js::string(door_state);
    patch_scene_door(state, door_id, |door| {
        if !DOOR_STATES.contains(&wanted.as_str()) {
            return None;
        }
        let blocks = door_edge_blocks(door_state) || door.barricade().is_some();
        Some(json!({ "state": wanted, "blocksMove": blocks, "blocksSight": blocks }))
    })?;
    Ok(())
}

/// `setSceneObjectPropState(state, propId, propState)` (2751).
pub fn set_scene_object_prop_state(state: &mut Value, prop_id: Option<&Value>, prop_state: Option<&Value>) -> Result<(), RuleError> {
    let Some(mut map) = ensure_scene_tactical_map(state).map_err(map_error)? else { return Ok(()) };
    let id = js::s(prop_id);
    let Some(prop) = map.props.iter_mut().find(|prop| prop.id == id) else { return Ok(()) };
    prop.state = head(&js::s(prop_state), 40);
    write_scene_tactical_map(state, &map).map_err(map_error)
}

/// `doorTraceKey(doorId)` (2803): след взлома двери в памяти сцены.
pub fn door_trace_key(door_id: Option<&Value>) -> String {
    format!("door:{}", head(&js::s(door_id), 110))
}

/// Запись взаимодействия по умолчанию (`updateSceneObjectInteraction`).
fn default_interaction() -> Value {
    json!({
        "state": "idle",
        "inspected": false,
        "inspection_attempted": false,
        "inspection_attempted_by": [],
        "opened": false,
        "taken": false,
        "used": false,
        "used_by": [],
        "loot_claimed": false,
        "loot_revealed": false,
        "trap_detected": false,
        "lockpicked": false,
        "lockpicked_by": null,
        "knowledge_ids": [],
        "last_actor_id": null,
    })
}

/// `updateSceneObjectInteraction(state, propId, updater)` (2854): `updater`
/// получает запись с уже очищенными списками и возвращает новую. Пустой id —
/// `None`, как `null` в JS.
pub fn update_scene_object_interaction(state: &mut Value, prop_id: &str, updater: impl FnOnce(Map<String, Value>) -> Map<String, Value>) -> Option<Value> {
    let id = head(prop_id, 120);
    if id.is_empty() {
        return None;
    }
    let mechanics = sk_core::game::mechanics_mut(state);
    let slot = mechanics.entry("scene_interactions").or_insert_with(js::obj);
    if !slot.is_object() {
        *slot = js::obj();
    }
    let interactions = slot.as_object_mut()?;
    let current = interactions.get(&id).filter(|value| !value.is_null()).cloned().unwrap_or_else(default_interaction);
    let mut prepared = spread_value(Some(&current));
    for key in ["inspection_attempted_by", "used_by", "knowledge_ids"] {
        prepared.insert(key.into(), js::strings_value(unique_strings(current.get(key))));
    }
    let next = Value::Object(updater(prepared));
    interactions.insert(id, next.clone());
    Some(next)
}

/// `setScenePropAt(state, x, y, assetId)` (2884): предмет в клетке заменяет
/// прежний одноклеточный предмет той же клетки.
pub fn set_scene_prop_at(state: &mut Value, x: Option<&Value>, y: Option<&Value>, asset_id: &Value) -> Result<(), RuleError> {
    let Some(mut map) = ensure_scene_tactical_map(state).map_err(map_error)? else { return Ok(()) };
    let safe_x = js::number(x);
    let safe_y = js::number(y);
    if !crate::core::is_safe_integer_f64(safe_x) || !crate::core::is_safe_integer_f64(safe_y) {
        return Ok(());
    }
    let (cx, cy) = (safe_x as i64, safe_y as i64);
    map.props.retain(|prop| !(prop.footprint.len() == 1 && prop.footprint[0].x == cx && prop.footprint[0].y == cy));
    let prop = json!({
        "id": format!("prop-{cx}-{cy}"),
        "assetId": js::string(Some(asset_id)),
        "x": js::num(safe_x + 0.5),
        "y": js::num(safe_y + 0.5),
        "rotation": 0,
        "scale": 1,
        "footprint": [{ "x": cx, "y": cy }],
        "zOrder": 0,
    });
    add_prop(&mut map, &prop).map_err(map_error)?;
    write_scene_tactical_map(state, &map).map_err(map_error)
}
