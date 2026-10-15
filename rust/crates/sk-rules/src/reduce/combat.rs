//! Бой: атаки, действия, экономика хода в событиях.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_position, combat_active, combat_actor_kind, find_actor};
use sk_core::js::{is_true, present, s, safe_int, truthy};
use sk_core::Event;

use super::{scene_turn_and_round, target_of};
use crate::turn_economy::{
    action_economy, apply_versioned_attack_economy, clear_loading_weapon_resource, current_frame, economy_of, event_version, frames_value, loading_resource_for, pending_frames, set_economy,
    spend_combat_economy, spend_versioned_action_frame, weapon_attack_limit_for_action, with, with_frame, with_loading_weapon_item, Frame, ACTION_ECONOMY_EVENT_VERSION,
};
use crate::journal::{append_battle_log, append_map_feedback, Entry};

fn event_ref(event: &Event) -> String {
    event.command_id.clone().filter(|id| !id.is_empty()).or_else(|| event.extra.get("event_id").filter(|v| !v.is_null()).map(|v| s(Some(v)))).unwrap_or_else(|| "unknown".into())
}

pub fn sneak_attack_applied(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = event.payload.clone();
    if combat_active(state) {
        if let Some(actor) = event.actor_id.as_deref().filter(|id| !id.is_empty()) {
            let economy = economy_of(state, actor);
            let key = if present(payload.get("turn_key")) { s(payload.get("turn_key")) } else { crate::turn_economy::combat_turn_key(state, actor).unwrap_or_default() };
            set_economy(state, actor, with(&economy, json!({ "sneak_attack_turn_key": key })));
        }
    }
    let actor = event.actor_id.clone().unwrap_or_default();
    if let Some(log) = state.get_mut("battleLog").and_then(Value::as_array_mut) {
        for entry in log.iter_mut().rev() {
            if s(entry.get("type")) != "attack" || s(entry.get("actorId")) != actor || s(entry.get("targetId")) != target {
                continue;
            }
            entry["sneakAttack"] = Value::Bool(true);
            entry["sneakAttackDamage"] = Value::from(safe_int(payload.get("damage"), 0).max(0));
            entry["sneakAttackExpression"] = Value::String(s(payload.get("expression")));
            entry["sneakAttackCritical"] = Value::Bool(is_true(payload.get("critical")));
            entry["sneakAttackEligibleBy"] = Value::String(s(payload.get("eligible_by")));
            if truthy(payload.get("supporter_id")) {
                entry["sneakAttackSupporterId"] = Value::String(s(payload.get("supporter_id")));
            }
            break;
        }
    }
}

/// Точка `{x, y}` из рыхлого значения или `None`.
fn point(value: Option<&Value>) -> Option<(i64, i64)> {
    let value = value.filter(|v| v.is_object())?;
    let coord = |key: &str| -> Option<i64> {
        let number = match value.get(key)? {
            Value::Number(number) => number.as_f64()?,
            Value::String(text) => text.trim().parse::<f64>().ok()?,
            Value::Null => 0.0,
            Value::Bool(flag) => f64::from(u8::from(*flag)),
            _ => return None,
        };
        (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
    };
    Some((coord("x")?, coord("y")?))
}

/// `normalizeAttackVisual(payload.attack_visual)` — пока переносится как есть,
/// если это объект с видом и снарядом.
fn normalize_attack_visual(value: Option<&Value>) -> Option<Value> {
    value.filter(|v| v.is_object()).cloned()
}

/// `attackEndpointsFor(trajectory)`: `{ from: {x, y}, to: {x, y} }`.
fn attack_endpoints(value: Option<&Value>) -> Option<Map<String, Value>> {
    let list = value?.as_array()?;
    if list.len() < 2 {
        return None;
    }
    let first = list.first()?.as_object()?;
    let last = list.last()?.as_object()?;
    let coord = |object: &Map<String, Value>, key: &str| -> Option<i64> {
        sk_core::js::is_safe_integer_number(object.get(key)).then(|| sk_core::js::number(object.get(key)) as i64)
    };
    let mut map = Map::new();
    map.insert("from".into(), json!({ "x": coord(first, "x")?, "y": coord(first, "y")? }));
    map.insert("to".into(), json!({ "x": coord(last, "x")?, "y": coord(last, "y")? }));
    Some(map)
}

pub fn attack_resolved(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = event.payload.clone();
    let actor_id = event.actor_id.clone().unwrap_or_default();
    if event_version(&payload) >= ACTION_ECONOMY_EVENT_VERSION {
        if !truthy(payload.get("legendary_action_id")) {
            apply_versioned_attack_economy(state, event.actor_id.as_deref(), &event_ref(event), &payload);
        }
    } else {
        let mut loading_boundary_started = false;
        if !truthy(payload.get("reaction_attack")) && !truthy(payload.get("legendary_action_id")) {
            let economy_info = payload.get("economy").filter(|v| v.is_object()).cloned().unwrap_or_else(sk_core::js::obj);
            let before = economy_of(state, &actor_id);
            loading_boundary_started = economy_info.get("action") != Some(&Value::Bool(false)) && safe_int(before.get("extra_actions"), 0) > 0;
            if economy_info.get("action") != Some(&Value::Bool(false)) {
                spend_combat_economy(state, &actor_id, "action", false, false);
            }
            let attacker = find_actor(state, &actor_id).cloned();
            if economy_info.get("attack") != Some(&Value::Bool(false)) && combat_active(state) && !actor_id.is_empty() {
                if let Some(attacker) = attacker {
                    let economy = economy_of(state, &actor_id);
                    let used_ids: Vec<Value> = economy.get("multiattack_action_ids").and_then(Value::as_array).map(|ids| ids.iter().map(|id| Value::String(s(Some(id)))).collect()).unwrap_or_default();
                    let mut patch = json!({
                        "attacks_used": safe_int(economy.get("attacks_used"), 0).max(0) + 1,
                        "attacks_allowed": crate::turn_economy::allowed_weapon_attacks(state, &attacker, &actor_id),
                    });
                    if truthy(payload.get("action_id")) {
                        let first = if present(economy.get("multiattack_action_id")) { s(economy.get("multiattack_action_id")) } else { s(payload.get("action_id")) };
                        patch["multiattack_action_id"] = Value::String(first);
                        if crate::classes::monster_trait(&attacker, "multiattack").is_some() {
                            let mut ids = used_ids;
                            ids.push(Value::String(s(payload.get("action_id"))));
                            patch["multiattack_action_ids"] = Value::Array(ids);
                        }
                    }
                    set_economy(state, &actor_id, with(&economy, patch));
                }
            }
        }
        if is_true(payload.get("loading_weapon")) && payload.get("loading_limit_applies") != Some(&Value::Bool(false)) && present(payload.get("item_id")) && !truthy(payload.get("legendary_action_id")) && combat_active(state) && !actor_id.is_empty() && !loading_boundary_started {
            let resource = loading_resource_for(is_true(payload.get("reaction_attack")), Some(&payload));
            let economy = economy_of(state, &actor_id);
            set_economy(state, &actor_id, with_loading_weapon_item(&economy, resource, &payload["item_id"]));
        }
    }
    if truthy(payload.get("colossus_slayer_turn_key")) && combat_active(state) && !actor_id.is_empty() {
        let economy = economy_of(state, &actor_id);
        set_economy(state, &actor_id, with(&economy, json!({ "colossus_slayer_turn_key": s(payload.get("colossus_slayer_turn_key")) })));
    }
    let attack_visual = normalize_attack_visual(payload.get("attack_visual"));
    let endpoints = attack_visual.as_ref().and_then(|_| attack_endpoints(payload.get("trajectory")));
    let (scene_turn, round) = scene_turn_and_round(state);
    let mode = s(payload.get("mode"));
    let dice: Vec<Value> = payload.get("dice").and_then(Value::as_array).map(|dice| dice.iter().map(|die| safe_int(Some(die), 0)).filter(|die| *die > 0).map(Value::from).collect()).unwrap_or_default();
    let reasons = |key: &str| -> Value { Value::Array(payload.get(key).and_then(Value::as_array).map(|list| list.iter().map(|item| Value::String(s(Some(item)))).collect()).unwrap_or_default()) };
    let attack_kind = s(payload.get("attack_kind"));
    let distance = payload.get("distance_feet").and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok().or(if text.trim().is_empty() { Some(0.0) } else { None }),
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        _ => None,
    }).filter(|f| f.is_finite());
    let mut entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "attack")
        .opt("actorId", event.actor_id.clone())
        .set("actorKind", combat_actor_kind(state, &actor_id))
        .set("targetId", target.clone())
        .set(
            "roll",
            json!({
                "die": safe_int(payload.get("kept"), 0), "modifier": safe_int(payload.get("modifier"), 0), "total": safe_int(payload.get("total"), 0),
                "difficulty": safe_int(payload.get("armor_class"), 10), "hit": truthy(payload.get("hit")),
            }),
        )
        .set("rollMode", if mode == "advantage" || mode == "disadvantage" { mode } else { "normal".into() })
        .set("rollDice", Value::Array(dice))
        .set("advantageReasons", reasons("advantage_sources"))
        .set("disadvantageReasons", reasons("disadvantage_sources"))
        .set("damage", if truthy(payload.get("hit")) { Value::Null } else { Value::from(0) })
        .text_if("spellId", payload.get("spell_id"))
        .text_if("spellName", payload.get("spell_name"))
        .opt("itemId", payload.get("item_id").filter(|v| !v.is_null()).cloned())
        .opt("itemName", payload.get("item_name").filter(|v| !v.is_null()).cloned())
        .text_if("attackMode", payload.get("attack_mode"))
        .text_if("attackAbility", payload.get("attack_ability"))
        .set("twoHanded", is_true(payload.get("two_handed")))
        .set("thrown", is_true(payload.get("thrown")))
        .opt("attackKind", matches!(attack_kind.as_str(), "melee" | "ranged" | "thrown").then_some(attack_kind));
    if let Some(visual) = attack_visual {
        entry = entry.set("attackVisual", visual);
    }
    if let Some(endpoints) = endpoints {
        for (key, value) in endpoints {
            entry = entry.set(&key, value);
        }
    }
    entry = entry
        .opt("distanceFeet", distance.map(|_| safe_int(payload.get("distance_feet"), 0).max(0)))
        .flag_if("longRange", is_true(payload.get("long_range")))
        .text_if("actionName", payload.get("action_name"))
        .flag_if("packTactics", is_true(payload.get("pack_tactics")))
        .flag_if("charge", is_true(payload.get("charge")))
        .flag_if("bloodiedFrenzy", is_true(payload.get("bloodied_frenzy")))
        .flag_if("blocked", is_true(payload.get("blocked")) || (is_true(payload.get("shielded_by_reaction")) && !is_true(payload.get("hit"))));
    let entry = entry.build();
    append_battle_log(state, event, entry);
    if !truthy(payload.get("hit")) {
        if let Some(position) = actor_position(state, &target) {
            let entry = Entry::new().set("x", position.x).set("y", position.y).set("text", "Промах").set("kind", "miss").build();
            append_map_feedback(state, event, entry);
        }
    }
}

pub fn area_attack_resolved(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    let actor_id = event.actor_id.clone().unwrap_or_default();
    if event_version(&payload) >= ACTION_ECONOMY_EVENT_VERSION {
        if combat_active(state) && !actor_id.is_empty() {
            spend_versioned_action_frame(state, &actor_id, true, false);
        }
    } else {
        spend_combat_economy(state, &actor_id, "action", false, false);
    }
    let (scene_turn, round) = scene_turn_and_round(state);
    let mut area = payload.get("to").filter(|v| v.is_object()).cloned().unwrap_or_else(sk_core::js::obj);
    area["radiusFeet"] = Value::from(safe_int(payload.get("radius_feet"), 5));
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "area-attack")
        .opt("actorId", event.actor_id.clone())
        .set("actorKind", "player")
        .opt("itemId", payload.get("item_id").filter(|v| !v.is_null()).cloned())
        .opt("itemName", payload.get("item_name").filter(|v| !v.is_null()).cloned())
        .set("area", area)
        .text_if("damageType", payload.get("damage_type"))
        .text_if("ability", payload.get("save_ability"))
        .opt("savingThrowDifficulty", present(payload.get("save_dc")).then(|| safe_int(payload.get("save_dc"), 12)))
        .build();
    append_battle_log(state, event, entry);
}

fn haste_action_allows(action_id: &str) -> bool {
    matches!(action_id, "dash" | "disengage" | "hide" | "use-object")
}

fn remove(value: &mut Value, keys: &[&str]) {
    if let Some(map) = value.as_object_mut() {
        for key in keys {
            map.shift_remove(*key);
        }
    }
}

pub fn combat_action_used(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = event.payload.clone();
    let actor_id = event.actor_id.clone().unwrap_or_default();
    if combat_active(state) && !actor_id.is_empty() {
        let economy = economy_of(state, &actor_id);
        let versioned = event_version(&payload) >= ACTION_ECONOMY_EVENT_VERSION;
        let actor = find_actor(state, &actor_id).cloned();
        if versioned {
            let mut next = with(&economy, json!({ "action_economy_version": ACTION_ECONOMY_EVENT_VERSION }));
            if truthy(payload.get("restore_action")) {
                let already_ready = economy.get("action") != Some(&Value::Bool(false));
                let normal_limit = weapon_attack_limit_for_action(state, actor.as_ref(), &actor_id, false);
                let limit = safe_int(payload.get("action_boundary_limit"), normal_limit).max(1);
                let current = current_frame(&economy);
                let pending = pending_frames(&economy);
                let fallback = (current.is_none() && economy.get("action") != Some(&Value::Bool(false))).then(|| {
                    let reference = event.extra.get("event_id").filter(|v| !v.is_null()).map(|v| s(Some(v))).or_else(|| event.command_id.clone()).unwrap_or_else(|| "restore".into());
                    Frame { id: format!("turn-action:{reference}:normal"), kind: "normal".into(), limit: normal_limit, attacks_used: 0, loading: json!({ "action": [], "bonus_action": [], "reaction": [] }) }
                });
                let resumable: Vec<Frame> = match (&current, fallback) {
                    (Some(frame), _) if frame.attacks_used < frame.limit => std::iter::once(frame.clone()).chain(pending.iter().cloned()).collect(),
                    (_, Some(fallback)) => std::iter::once(fallback).chain(pending.iter().cloned()).collect(),
                    _ => pending.clone(),
                };
                let boundary_ref = event.command_id.clone().or_else(|| event.extra.get("event_id").filter(|v| !v.is_null()).map(|v| s(Some(v)))).unwrap_or_else(|| "restore".into());
                let surge = Frame {
                    id: if present(payload.get("action_boundary_id")) { s(payload.get("action_boundary_id")) } else { format!("attack-action:{boundary_ref}") },
                    kind: if present(payload.get("action_boundary_kind")) { s(payload.get("action_boundary_kind")) } else { "surge".into() },
                    limit,
                    attacks_used: 0,
                    loading: json!({ "action": [], "bonus_action": [], "reaction": [] }),
                };
                let extra_actions = safe_int(economy.get("extra_actions"), 0).max(0) + i64::from(already_ready);
                let base = with(&next, json!({ "action": true, "extra_actions": extra_actions, "surged_action_only": !already_ready, "attack_action_stack": frames_value(&resumable) }));
                let framed = with_frame(&base, &surge);
                next = with(&next, json!({ "action": true, "extra_actions": extra_actions, "attacks_used": 0, "attacks_allowed": limit, "attack_action_stack": frames_value(&resumable), "surged_action_only": !already_ready }));
                if let Some(map) = framed.as_object() {
                    for (key, value) in map {
                        next[key.as_str()] = value.clone();
                    }
                }
                remove(&mut next, &["extra_action_kind", "extra_action_limit"]);
                if limit < normal_limit {
                    next["surged_action_only"] = Value::Bool(true);
                }
                next = clear_loading_weapon_resource(&next, "action");
            } else if !truthy(payload.get("economy_consumed_by_attack")) {
                let resource = match s(payload.get("action_type")).as_str() {
                    "bonus_action" => Some("bonus_action"),
                    "reaction" => Some("reaction"),
                    "free" => None,
                    _ => Some("action"),
                };
                if resource == Some("action") && event_version(&economy) >= ACTION_ECONOMY_EVENT_VERSION {
                    let mut pending = pending_frames(&economy);
                    let current = current_frame(&economy);
                    let use_current = current.as_ref().map(|frame| frame.kind.as_str()) != Some("haste") || haste_action_allows(&s(payload.get("action_id")));
                    let normal_index = pending.iter().position(|frame| frame.kind == "normal" && frame.attacks_used == 0);
                    if let (false, Some(index)) = (use_current, normal_index) {
                        pending.remove(index);
                        next = with(&next, json!({ "action": true, "attack_action_stack": frames_value(&pending) }));
                    } else if !pending.is_empty() {
                        let resumed = pending.remove(0);
                        let extra_actions = (safe_int(economy.get("extra_actions"), 0) - 1).max(0);
                        let resumed_action = resumed.attacks_used == 0;
                        let base = with(&next, json!({ "action": resumed_action, "extra_actions": extra_actions, "surged_action_only": resumed.kind == "surge", "attack_action_stack": frames_value(&pending) }));
                        next = with(&with_frame(&base, &resumed), json!({ "action": resumed_action, "extra_actions": extra_actions, "surged_action_only": resumed.kind == "surge", "attack_action_stack": frames_value(&pending) }));
                    } else {
                        next = with(&next, json!({ "action": false, "extra_actions": (safe_int(economy.get("extra_actions"), 0) - 1).max(0), "attacks_used": 0, "attack_action_stack": [] }));
                    }
                    next = clear_loading_weapon_resource(&next, "action");
                } else if resource == Some("action") && safe_int(economy.get("extra_actions"), 0).max(0) > 0 {
                    next = with(
                        &next,
                        json!({
                            "action": true, "extra_actions": safe_int(economy.get("extra_actions"), 0).max(0) - 1, "attacks_used": 0,
                            "attacks_allowed": weapon_attack_limit_for_action(state, actor.as_ref(), &actor_id, false),
                        }),
                    );
                    remove(&mut next, &["extra_action_kind", "extra_action_limit", "attack_action_id", "attack_action_kind", "attack_action_limit"]);
                    next = clear_loading_weapon_resource(&next, "action");
                } else if let Some(resource) = resource {
                    spend_combat_economy(state, &actor_id, resource, false, is_true(payload.get("normal_action_only")));
                    let spent = sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(actor_id.as_str())).cloned().unwrap_or(next.clone());
                    next = with(&spent, json!({ "action_economy_version": ACTION_ECONOMY_EVENT_VERSION }));
                }
            }
            set_economy(state, &actor_id, next);
        } else if truthy(payload.get("restore_action")) {
            let already_ready = economy.get("action") != Some(&Value::Bool(false));
            let restored = with(&economy, json!({ "action": true, "extra_actions": safe_int(economy.get("extra_actions"), 0).max(0) + i64::from(already_ready), "surged_action_only": !already_ready }));
            set_economy(state, &actor_id, if already_ready { restored } else { clear_loading_weapon_resource(&restored, "action") });
        } else if !truthy(payload.get("economy_consumed_by_attack")) {
            let resource = match s(payload.get("action_type")).as_str() {
                "bonus_action" => Some("bonus_action"),
                "reaction" => Some("reaction"),
                "free" => None,
                _ => Some("action"),
            };
            if let Some(resource) = resource {
                spend_combat_economy(state, &actor_id, resource, false, is_true(payload.get("normal_action_only")));
            }
        }
        let contract_two = payload.get("movement_contract_version").and_then(Value::as_f64) == Some(2.0);
        if safe_int(payload.get("movement_bonus"), 0) > 0 || (contract_two && payload.get("dash_count").and_then(Value::as_f64).is_some_and(|count| count > 0.0)) {
            let updated = sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(actor_id.as_str())).cloned().unwrap_or(economy.clone());
            let mut patch = json!({ "movement": true, "movement_bonus": safe_int(updated.get("movement_bonus"), 0).max(0) + safe_int(payload.get("movement_bonus"), 0) });
            if contract_two {
                patch["dash_count"] = Value::from(safe_int(updated.get("dash_count"), 0) + safe_int(payload.get("dash_count"), 0));
                patch["dash_movement_credit"] = Value::from(safe_int(updated.get("dash_movement_credit"), 0) + safe_int(payload.get("movement_bonus"), 0));
            }
            set_economy(state, &actor_id, with(&updated, patch));
        }
        if safe_int(payload.get("movement_spent"), 0) > 0 {
            let updated = sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(actor_id.as_str())).cloned().unwrap_or(economy.clone());
            let spent = (safe_int(updated.get("movement_spent"), 0) + safe_int(payload.get("movement_spent"), 0)).max(0);
            let actor = find_actor(state, &actor_id).cloned().unwrap_or(Value::Null);
            let total = if contract_two {
                let speed = crate::speed::effective_speed_feet(state, &actor, &actor_id);
                speed + crate::speed::movement_bonus_feet(state, &actor_id, speed)
            } else {
                (safe_int(actor.get("speed"), 30) + safe_int(updated.get("movement_bonus"), 0)).max(0)
            };
            set_economy(state, &actor_id, with(&updated, json!({ "movement_spent": spent, "movement": spent < total })));
        }
        let _ = action_economy;
    }
    if is_true(payload.get("monster_action")) || truthy(payload.get("monster_action")) {
        if let Some(area) = battle_log_area_from_payload(state, event, &payload) {
            append_battle_log(state, event, area);
            return;
        }
    }
    let (scene_turn, round) = scene_turn_and_round(state);
    let mut entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "action")
        .opt("actorId", event.actor_id.clone())
        .set("actorKind", combat_actor_kind(state, &actor_id))
        .set("targetId", target)
        .opt("actionId", payload.get("action_id").filter(|v| !v.is_null()).cloned())
        .opt("actionName", payload.get("name").filter(|v| !v.is_null()).cloned());
    if truthy(payload.get("indomitable_bonus")) {
        entry = entry.set("indomitableBonus", safe_int(payload.get("indomitable_bonus"), 1).max(1)).set("indomitableOriginalTotal", safe_int(payload.get("original_total"), 0));
    }
    let entry = entry.build();
    append_battle_log(state, event, entry);
}

/// `battleLogAreaFromPayload(state, event, payload)`.
pub(crate) fn battle_log_area_from_payload(state: &Value, event: &Event, payload: &Value) -> Option<Map<String, Value>> {
    let area = payload.get("area")?;
    let from = point(area.get("from"))?;
    let to = point(area.get("to"))?;
    let shape = s(area.get("shape"));
    let shape = if matches!(shape.as_str(), "sphere" | "cone" | "line") { shape } else { "sphere".into() };
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor_id = event.actor_id.clone().unwrap_or_default();
    let item_name = if present(payload.get("name")) { s(payload.get("name")) } else { s(payload.get("action_id")) };
    let targets = Value::Array(area.get("target_ids").and_then(Value::as_array).map(|list| list.iter().map(|id| Value::String(s(Some(id)))).collect()).unwrap_or_default());
    Some(
        Entry::new()
            .set("sceneTurn", scene_turn)
            .set("round", round)
            .set("type", "area-attack")
            .opt("actorId", event.actor_id.clone())
            .set("actorKind", combat_actor_kind(state, &actor_id))
            .set("itemName", item_name)
            .set("from", json!({ "x": from.0, "y": from.1 }))
            .set("area", json!({ "x": to.0, "y": to.1, "radiusFeet": safe_int(area.get("size_feet"), 5).max(5), "shape": shape }))
            .set("targetIds", targets)
            .text_if("damageType", area.get("damage_type"))
            .text_if("ability", area.get("save_ability"))
            .build(),
    )
}

/// `LegendaryActionUsed`: механику несут соседние события (спасброски, урон,
/// маркеры); здесь — только строка хроники с областью для доски.
pub fn legendary_action_used(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    if let Some(entry) = battle_log_area_from_payload(state, event, &payload) {
        append_battle_log(state, event, entry);
    }
}

/// `NpcItemUsed`: трата экономики хода и строка хроники без каталога и
/// экземпляра — инвентарь живого противника закрыт до обыска тела.
pub fn npc_item_used(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    let actor = event.actor_id.clone().unwrap_or_default();
    if sk_core::js::truthy(payload.get("combat_action")) {
        spend_combat_economy(state, &actor, &s(payload.get("combat_action")), false, false);
    }
    let (scene_turn, round) = super::scene_turn_and_round(state);
    let target = match payload.get("target_id").filter(|v| !v.is_null()) {
        Some(value) => s(Some(value)),
        None => event.actor_id.clone().unwrap_or_else(|| "null".into()),
    };
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "npc-item")
        .set("actorId", event.actor_id.clone().map_or(Value::Null, Value::from))
        .set("actorKind", combat_actor_kind(state, &actor))
        .set("targetId", target)
        .set("tactic", s(payload.get("tactic")))
        .set("label", sk_core::text::head(&s(payload.get("label")), 120))
        .build();
    append_battle_log(state, event, entry);
}
