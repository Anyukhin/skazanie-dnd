//! Ветки `resolveCommandInternal`: Двери: баррикада, разбор баррикады, открыть и выломать. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 19142–19162, 19163–19186, 19187–19279. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::{game, js, text};
use sk_ruleset::lockpicking::{has_thieves_tools, LOCKPICKING_POLICY_ID, THIEVES_TOOLS_REQUIRED_CODE, THIEVES_TOOLS_REQUIRED_MESSAGE};
use sk_tactical::tactical_map::{cell_at, door_by_id, doors_reachable_from, TacticalDoor, TacticalMap, TacticalMapError};

use super::kernel::{defined, undef};
use super::Resolve;
use crate::checks::saves::{roll_ability_check_with_conditions, D20Method};
use crate::checks::skills::skill_proficiency_bonus;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with_rules, event_from, inventory_item, spread_value};
use crate::lockpick::{lockpick_check_modifier, lockpick_notice_events, LockpickNotice};
use crate::normalize::scene::DOOR_BARRICADE_EVENT_SCHEMA_VERSION;
use crate::pause::{rule, Fault, Interrupt, Flow};
use crate::tactical_geometry::{cells_visible_from, DOORWAY_SIGHT_CELLS};

/// `TacticalMapError` JS — обычная ошибка с кодом.
pub(crate) fn map_fault(error: TacticalMapError) -> Interrupt {
    Fault::new(error.name, error.message).with_code(error.code).into()
}

/// `ensureSceneTacticalMap(state)`: пишет карту в состояние разбора, как JS.
pub(crate) fn ensure_map(r: &mut Resolve<'_>) -> Result<Option<TacticalMap>, Interrupt> {
    crate::scene_map_sync::ensure_scene_tactical_map_shared(&mut r.state).map_err(map_fault)
}

/// `[command.actor_id]`.
pub(crate) fn actor_targets(command: &Value) -> Value {
    json!([command.get("actor_id").cloned().unwrap_or(Value::Null)])
}

/// `state.mechanics.combat.active && economy && economy.action === false`.
pub(crate) fn action_spent(state: &Value, actor_id: &str) -> bool {
    let combat = game::combat(state);
    let economy = combat.get("action_economy").and_then(|all| all.get(actor_id));
    game::combat_active(state) && js::truthy(economy) && economy.and_then(|economy| economy.get("action")) == Some(&Value::Bool(false))
}

fn action_spent_error() -> Interrupt {
    rule("Действие на этом ходу уже потрачено", "ACTION_SPENT")
}

/// `cellAt(map, door.x, door.y)?.revealed === false`.
fn door_hidden(map: &TacticalMap, door: &TacticalDoor) -> bool {
    cell_at(map, door.x, door.y).is_some_and(|cell| !cell.revealed)
}

/// `!at || !doorsReachableFrom(map, at.x, at.y).some((entry) => entry.id === door.id)`.
fn out_of_reach(map: &TacticalMap, at: Option<sk_core::Point>, door: &TacticalDoor) -> bool {
    match at {
        None => true,
        Some(at) => !doors_reachable_from(map, at.x, at.y).iter().any(|entry| entry.id == door.id),
    }
}

/// `item.tags?.includes?.('quest')`.
fn tags_include_quest(item: &Value) -> bool {
    match item.get("tags") {
        Some(Value::Array(tags)) => tags.iter().any(|tag| tag.as_str() == Some("quest")),
        Some(Value::String(tags)) => tags.contains("quest"),
        _ => false,
    }
}

/// `[...]join(' ')` по правилам `Array.prototype.join`: `null` и `undefined` — пустые.
fn join_tags(item: &Value) -> String {
    match item.get("tags") {
        Some(Value::Array(tags)) => tags.iter().map(|tag| js::s(Some(tag))).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

/// Проверка Силы (Атлетика) у двери (`rollAbilityCheckWithConditions`).
fn athletics_check(r: &mut Resolve<'_>, difficulty: i64, purpose: &str) -> Result<Value, Interrupt> {
    let actor_id = js::s(r.command.get("actor_id"));
    let actor = game::find_actor(&r.state, &actor_id);
    let modifier = ability_modifier(actor.and_then(|actor| actor.get("abilities")).and_then(|abilities| abilities.get("str"))) + skill_proficiency_bonus(actor, "athletics", Some(&r.state));
    let mut options = Map::new();
    options.insert("modifier".into(), Value::from(modifier));
    options.insert("difficulty".into(), Value::from(difficulty));
    options.insert("purpose".into(), Value::String(purpose.into()));
    options.insert("actorId".into(), undef(r.command.get("actor_id")));
    options.insert("visibility".into(), undef(r.command.get("visibility")));
    let check = roll_ability_check_with_conditions(&r.state, &mut r.dice, &actor_id, Some(&json!("str")), &Value::Object(options), D20Method::RollCheck)?;
    r.rolls.push(check.clone());
    Ok(check)
}

/// `AbilityCheckResolved` `{ ability, skill, ...check }`.
fn check_resolved(r: &mut Resolve<'_>, ability: &str, skill: &str, check: &Value) {
    let mut payload = Map::new();
    payload.insert("ability".into(), json!(ability));
    payload.insert("skill".into(), json!(skill));
    payload.extend(spread_value(Some(check)));
    let source = command_with_rules(&r.command, &[rule_ids::ABILITY_CHECK]);
    r.events.push(event_from(&source, "AbilityCheckResolved", Some(Value::Object(payload)), Some(&json!([]))));
}

/// `BarricadeDoor` (19142–19162).
pub fn barricade_door(r: &mut Resolve<'_>) -> Flow {
    let Some(map) = ensure_map(r)? else {
        return Err(rule("Для баррикады нужна тактическая карта", "TACTICAL_MAP_REQUIRED"));
    };
    let Some(door) = door_by_id(&map, &js::s(r.command.get("door_id"))) else {
        return Err(rule("Такой двери нет на карте", "DOOR_NOT_FOUND"));
    };
    if door_hidden(&map, door) {
        return Err(rule("Дверь скрыта туманом войны", "DOOR_HIDDEN"));
    }
    if !matches!(door.state.as_str(), "open" | "closed") {
        return Err(rule("Баррикаду нельзя поставить на сломанную дверь", "DOOR_BARRICADE_INVALID_STATE"));
    }
    if door.barricade().is_some() {
        return Err(rule("Дверь уже забаррикадирована", "DOOR_ALREADY_BARRICADED"));
    }
    let actor_id = js::s(r.command.get("actor_id"));
    let at = game::actor_position(&r.state, &actor_id);
    if out_of_reach(&map, at, door) {
        return Err(rule("До двери нужно дотянуться: встаньте вплотную", "DOOR_OUT_OF_REACH"));
    }
    let Some(at) = at else { return Err(rule("До двери нужно дотянуться: встаньте вплотную", "DOOR_OUT_OF_REACH")) };
    let actor = game::find_actor(&r.state, &actor_id);
    let item = inventory_item(actor, r.command.get("material_item_id")).cloned();
    if let Some(item) = &item {
        let protected = js::truthy(item.get("equipped")) || js::truthy(item.get("attuned_to")) || js::truthy(item.get("quest_item")) || tags_include_quest(item);
        if protected {
            return Err(rule("Сначала снимите обычный материал: надетая, настроенная или сюжетная вещь не расходуется на баррикаду", "BARRICADE_MATERIAL_PROTECTED"));
        }
    }
    let material_text = item.as_ref().map_or_else(String::new, |item| {
        text::lower(&format!("{} {} {}", js::s(item.get("name")), join_tags(item), js::s(item.get("material"))))
    });
    let material_ok = item.as_ref().is_some_and(|item| {
        let quantity = js::number(Some(item.get("quantity").filter(|value| !value.is_null()).unwrap_or(&json!(0))));
        !(quantity < 1.0) && text::test(sk_core::re!(r"(доск|дерев|бревн|верёв|верев|канат|скамь|баррикад|plank|wood|rope|bench)", "iu"), &material_text)
    });
    let Some(item) = item.filter(|_| material_ok) else {
        return Err(rule("Нужен настоящий материал для баррикады: доски, верёвка или подходящая скамья", "BARRICADE_MATERIAL_REQUIRED"));
    };
    if action_spent(&r.state, &actor_id) {
        return Err(action_spent_error());
    }
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(DOOR_BARRICADE_EVENT_SCHEMA_VERSION));
    payload.insert("door_id".into(), json!(door.id));
    if let Some(item_id) = item.get("id") {
        payload.insert("material_item_id".into(), item_id.clone());
    }
    payload.insert("previous_state".into(), json!(door.state));
    payload.insert("side_x".into(), json!(at.x));
    payload.insert("side_y".into(), json!(at.y));
    r.events.push(event_from(&r.command, "DoorBarricaded", Some(Value::Object(payload)), Some(&json!([]))));
    let mut consumed = Map::new();
    if let Some(item_id) = item.get("id") {
        consumed.insert("item_id".into(), item_id.clone());
    }
    consumed.insert("quantity".into(), json!(1));
    consumed.insert("reason".into(), json!("door-barricade"));
    r.events.push(event_from(&r.command, "ItemConsumed", Some(Value::Object(consumed)), Some(&actor_targets(&r.command))));
    Ok(())
}

/// `ClearDoorBarricade` (19163–19186).
pub fn clear_door_barricade(r: &mut Resolve<'_>) -> Flow {
    let map = ensure_map(r)?;
    let Some((map, door)) = map.as_ref().and_then(|map| door_by_id(map, &js::s(r.command.get("door_id"))).map(|door| (map, door))) else {
        return Err(rule("Такой двери нет на карте", "DOOR_NOT_FOUND"));
    };
    if door_hidden(map, door) {
        return Err(rule("Дверь скрыта туманом войны", "DOOR_HIDDEN"));
    }
    let Some(barricade) = door.barricade() else {
        return Err(rule("На двери нет баррикады", "DOOR_NOT_BARRICADED"));
    };
    let actor_id = js::s(r.command.get("actor_id"));
    let clearer = game::find_actor(&r.state, &actor_id).cloned();
    if !clearer.as_ref().is_some_and(game::is_living_actor) {
        return Err(rule("Баррикаду может снять только живой герой", "BARRICADE_ACTOR_INVALID"));
    }
    let at = game::actor_position(&r.state, &actor_id);
    if out_of_reach(map, at, door) {
        return Err(rule("До баррикады нужно дотянуться: встаньте вплотную", "DOOR_OUT_OF_REACH"));
    }
    let Some(at) = at else { return Err(rule("До баррикады нужно дотянуться: встаньте вплотную", "DOOR_OUT_OF_REACH")) };
    let wrong_side = at.x != barricade.side_x || at.y != barricade.side_y;
    if wrong_side && !js::is_true(r.command.get("force")) {
        return Err(rule("Баррикада закрыта с другой стороны; требуется выбивание", "BARRICADE_WRONG_SIDE"));
    }
    if action_spent(&r.state, &actor_id) {
        return Err(action_spent_error());
    }
    let door_id = door.id.clone();
    // `previous_state ?? 'open'`: разбор карты уже ставит `open` вместо неизвестного.
    let restored = barricade.previous_state.clone();
    if wrong_side {
        let check = athletics_check(r, 15, "door:barricade-force")?;
        check_resolved(r, "str", "athletics", &check);
        let mut payload = Map::new();
        payload.insert("schema_version".into(), json!(DOOR_BARRICADE_EVENT_SCHEMA_VERSION));
        payload.insert("door_id".into(), json!(door_id));
        if let Some(success) = check.get("success") {
            payload.insert("success".into(), success.clone());
        }
        r.events.push(event_from(&r.command, "DoorBarricadeForced", Some(Value::Object(payload)), Some(&json!([]))));
        if !js::truthy(check.get("success")) {
            return Ok(());
        }
    }
    let payload = json!({ "schema_version": DOOR_BARRICADE_EVENT_SCHEMA_VERSION, "door_id": door_id, "restored_state": restored });
    r.events.push(event_from(&r.command, "DoorBarricadeCleared", Some(payload), Some(&json!([]))));
    Ok(())
}

/// Раскрытие за распахнутой дверью (`revealBeyondDoor`).
fn reveal_beyond_door(r: &mut Resolve<'_>, map: &TacticalMap, at: sk_core::Point, door_id: &str) {
    let origin = sk_geometry::Point::new(at.x as f64, at.y as f64);
    let cells: Vec<Value> = cells_visible_from(map, origin, DOORWAY_SIGHT_CELLS, Some(door_id))
        .into_iter()
        .filter(|cell| !cell_at(map, cell.x, cell.y).is_some_and(|found| found.revealed))
        .map(|cell| cell.to_value())
        .collect();
    if !cells.is_empty() {
        r.events.push(event_from(&r.command, "AreaRevealed", Some(json!({ "cells": cells })), Some(&json!([]))));
    }
}

/// `OperateDoor` (19187–19279).
pub fn operate_door(r: &mut Resolve<'_>) -> Flow {
    let Some(map) = ensure_map(r)? else {
        return Err(rule("Для двери нужна тактическая карта", "TACTICAL_MAP_REQUIRED"));
    };
    let Some(door) = door_by_id(&map, &js::s(r.command.get("door_id"))).cloned() else {
        return Err(rule("Такой двери нет на карте", "DOOR_NOT_FOUND"));
    };
    let actor_id = js::s(r.command.get("actor_id"));
    let Some(at) = game::actor_position(&r.state, &actor_id) else {
        return Err(rule("Участник должен находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    if out_of_reach(&map, Some(at), &door) {
        return Err(rule("До двери нужно дотянуться: встаньте вплотную", "DOOR_OUT_OF_REACH"));
    }
    let intent = match r.command.get("intent") {
        Some(value) if matches!(js::string(Some(value)).as_str(), "open" | "close" | "force" | "lockpick") => js::string(Some(value)),
        _ => "open".to_string(),
    };
    if door.barricade().is_some() {
        return Err(rule("Дверь забаррикадирована: сначала снимите или выбейте баррикаду", "DOOR_BARRICADED"));
    }
    let before = door.state.clone();
    if intent == "lockpick" {
        if before != "locked" {
            return Err(rule("Взламывать нечего: замок не заперт", "DOOR_NOT_LOCKED"));
        }
        let picker = game::find_actor(&r.state, &actor_id).cloned();
        if !has_thieves_tools(picker.as_ref()) {
            return Err(rule(THIEVES_TOOLS_REQUIRED_MESSAGE, THIEVES_TOOLS_REQUIRED_CODE));
        }
        if action_spent(&r.state, &actor_id) {
            return Err(action_spent_error());
        }
        let difficulty = door.lock_dc.max(10);
        let mut options = Map::new();
        options.insert("modifier".into(), Value::from(lockpick_check_modifier(picker.as_ref())));
        options.insert("difficulty".into(), Value::from(difficulty));
        options.insert("purpose".into(), json!("door:lockpick"));
        options.insert("actorId".into(), undef(r.command.get("actor_id")));
        options.insert("visibility".into(), undef(r.command.get("visibility")));
        let check = roll_check(r, &Value::Object(options))?;
        r.rolls.push(check.clone());
        check_resolved(r, "dex", "sleight_of_hand", &check);
        let mut payload = Map::new();
        payload.insert("door_id".into(), json!(door.id));
        if let Some(success) = check.get("success") {
            payload.insert("success".into(), success.clone());
        }
        payload.insert("previous_state".into(), json!(before));
        payload.insert("difficulty".into(), json!(difficulty));
        if let Some(total) = check.get("total") {
            payload.insert("check_total".into(), total.clone());
        }
        payload.insert("policy_id".into(), json!(LOCKPICKING_POLICY_ID));
        r.events.push(event_from(&r.command, "DoorLockpicked", Some(Value::Object(payload)), Some(&json!([]))));
        let kind = json!("door");
        let target = json!(door.id);
        let label = json!("дверь");
        let notices = lockpick_notice_events(&r.state, &r.command, LockpickNotice { target_kind: Some(&kind), target_id: Some(&target), target_label: Some(&label), check: Some(&check), notice: None });
        r.events.extend(notices);
        if js::truthy(check.get("success")) {
            reveal_beyond_door(r, &map, at, &door.id);
        }
        return Ok(());
    }
    if intent == "open" {
        if before == "locked" {
            return Err(rule("Дверь заперта: её придётся выломать", "DOOR_LOCKED"));
        }
        if before != "closed" {
            return Err(rule("Эта дверь и так открыта", "DOOR_ALREADY_OPEN"));
        }
        let payload = json!({ "door_id": door.id, "state": "open", "previous_state": before, "method": "hand" });
        r.events.push(event_from(&r.command, "DoorStateChanged", Some(payload), Some(&json!([]))));
        reveal_beyond_door(r, &map, at, &door.id);
        return Ok(());
    }
    if intent == "close" {
        if before == "broken" {
            return Err(rule("Выломанную дверь уже не закрыть", "DOOR_BROKEN"));
        }
        if before != "open" {
            return Err(rule("Эта дверь и так закрыта", "DOOR_ALREADY_CLOSED"));
        }
        let payload = json!({ "door_id": door.id, "state": "closed", "previous_state": before, "method": "hand" });
        r.events.push(event_from(&r.command, "DoorStateChanged", Some(payload), Some(&json!([]))));
        return Ok(());
    }
    if before == "open" || before == "broken" {
        return Err(rule("Ломать нечего: проход свободен", "DOOR_ALREADY_OPEN"));
    }
    if action_spent(&r.state, &actor_id) {
        return Err(action_spent_error());
    }
    let difficulty = door.lock_dc.max(10);
    let check = athletics_check(r, difficulty, "door:athletics")?;
    check_resolved(r, "str", "athletics", &check);
    let mut payload = Map::new();
    payload.insert("door_id".into(), json!(door.id));
    if let Some(success) = check.get("success") {
        payload.insert("success".into(), success.clone());
    }
    payload.insert("previous_state".into(), json!(before));
    payload.insert("difficulty".into(), json!(difficulty));
    if let Some(total) = check.get("total") {
        payload.insert("check_total".into(), total.clone());
    }
    r.events.push(event_from(&r.command, "DoorForced", Some(Value::Object(payload)), Some(&json!([]))));
    if js::truthy(check.get("success")) {
        reveal_beyond_door(r, &map, at, &door.id);
    }
    Ok(())
}

/// `diceService.rollCheck(options)` (поля `undefined` в кости не идут).
pub(crate) fn roll_check(r: &mut Resolve<'_>, options: &Value) -> Result<Value, Interrupt> {
    use crate::dice_record::RulesDice;
    Ok(r.dice.roll_check(&defined(options))?)
}
