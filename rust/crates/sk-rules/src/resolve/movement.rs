//! Ветки `resolveCommandInternal`: Перемещение `MoveActor`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 18833–19127. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Путь — авторитетный (поиск по карте с ценой шага, раскачка на люстре,
//! прыжок в длину) или «доверенный» старого клиента. Уход героя из
//! досягаемости врага вызывает удар вдогонку тут же (`MakeAttack` реакцией);
//! пауза внутри удара (например, окно «Щита») останавливает перемещение
//! целиком: продолжение повторит путь по стенограмме костей этой команды.
//! Уход врага от героя открывает окно реакции герою, подход — заготовленную
//! атаку.

use std::sync::Arc;
use serde_json::{json, Map, Value};
use sk_combat_content::scene_hazards::SCENE_SWING_POLICY_ID;
use sk_core::js;
use sk_geometry::Point;

use super::kernel::undef;
use super::resume::{at, reduce_events};
use super::{api, Resolve};
use crate::checks::saves::{roll_ability_check_with_conditions, D20Method};
use crate::checks::skills::skill_proficiency_bonus;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, coalesce, command_with_rules, condition_ids_for, event_from, monster_trait_for, readied_option_for, spread_value};
use crate::death::zero_hit_point_damage_consequences;
use crate::geometry::footprint::{actor_footprint_fits, FitOptions};
use crate::pause::{pending_execution_for, rule, Fault, Interrupt, Flow};
use crate::reactions::{opportunity_attackers, opportunity_blocking_conditions};
use crate::resolve::world_time::TimeAdvanceOptions;
use crate::speed::{effective_speed_feet, movement_bonus_feet};
use crate::tactical_geometry::{cells_visible_from, point_json, points_json, scene_tactical_map, shortest_tactical_path, tactical_cell_map, PathOptions, MOVEMENT_SIGHT_CELLS};

fn living(actor: Option<&Value>) -> bool {
    actor.is_some_and(sk_core::game::is_living_actor)
}

/// `footprintDistanceFeet(left, right, leftAnchor, rightAnchor)`.
fn footprint_distance(left: Option<&Value>, right: Option<&Value>, left_anchor: &Value, right_anchor: &Value) -> Option<f64> {
    sk_geometry::actor_footprint::footprint_distance_feet(left, right, Some(left_anchor), Some(right_anchor))
}

/// Порядок по инициативе: место в очереди, затем `localeCompare` id.
fn initiative_order(state: &Value) -> sk_core::indexmap::IndexMap<String, usize> {
    let mut order = sk_core::indexmap::IndexMap::new();
    if let Some(Value::Array(entries)) = sk_core::game::combat(state).get("initiative") {
        for (index, entry) in entries.iter().enumerate() {
            order.insert(js::string(entry.get("actor_id")), index);
        }
    }
    order
}

fn order_compare(order: &sk_core::indexmap::IndexMap<String, usize>, left: &str, right: &str) -> std::cmp::Ordering {
    let position = |id: &str| order.get(id).map(|index| *index as f64).unwrap_or(9_007_199_254_740_991.0);
    let difference = position(left) - position(right);
    if difference != 0.0 {
        return difference.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
    }
    sk_core::text::locale_compare(left, right)
}

/// Путь перемещения: точки или `null`.
enum Route {
    None,
    Points(Vec<Point>),
}

impl Route {
    fn json(&self) -> Value {
        match self {
            Route::None => Value::Null,
            Route::Points(points) => points_json(points),
        }
    }

    fn points(&self) -> &[Point] {
        match self {
            Route::None => &[],
            Route::Points(points) => points,
        }
    }
}

/// `MoveActor` (18833–19127).
pub fn move_actor(r: &mut Resolve<'_>) -> Flow {
    let state = r.state.clone();
    let command = r.command.clone();
    let actor_id = js::s(command.get("actor_id"));
    // Та же ссылка, что в состоянии: стат-блок 2014 узнаётся по тождеству.
    let actor = sk_core::game::find_actor(&state, &actor_id);
    let is_enemy = sk_core::game::is_enemy_actor(&state, &actor_id);
    let authoritative = js::truthy(command.get("server_authoritative")) || r.context.truthy("serverAuthoritativeCombat") || r.context.truthy("isNpcScheduler") || is_enemy;
    let Some(to_field) = command.get("to").filter(|value| !value.is_null()) else {
        return Err(Fault::type_error(format!("Cannot read properties of {} (reading 'x')", if command.get("to").is_some() { "null" } else { "undefined" })).into());
    };
    let to = Point::new(js::number(to_field.get("x")), js::number(to_field.get("y")));
    let to_json = json!({ "x": js::num(to.x), "y": js::num(to.y) });
    let from = crate::tactical_geometry::actor_point(&state, &actor_id);
    let from_json = from.map(point_json);
    let combat_active = sk_core::game::combat_active(&state);
    let mode = command.get("movement_mode").and_then(Value::as_str).map(str::to_string);
    let mut route = Route::None;
    let distance: f64;
    let movement_cost: f64;
    let reaction_movement = js::is_true(command.get("reaction_movement"));
    let economy = sk_core::game::combat(&state).get("action_economy").and_then(|all| all.get(&actor_id)).cloned();
    let mut movement_spent = if reaction_movement { 0.0 } else { js::safe_int(at(economy.as_ref(), "movement_spent"), 0).max(0) as f64 };
    if authoritative {
        if from.is_none() {
            return Err(rule("Участник должен находиться на карте", "MAP_POSITION_REQUIRED"));
        }
        let cells = tactical_cell_map(&state);
        if cells.is_empty() {
            return Err(rule("Для перемещения нужна тактическая карта", "TACTICAL_MAP_REQUIRED"));
        }
        if mode.as_deref() == Some("swing") {
            if reaction_movement {
                return Err(rule("Swing нельзя выполнить как реакционное перемещение", "SWING_REACTION_FORBIDDEN"));
            }
            let running = js::is_true(command.get("swing_running_start"));
            let details = crate::combat::weapons::swing_details_for(&state, &actor_id, command.get("swing_prop_id"), running)?;
            let jump = crate::geometry::movement::long_jump_movement_for(&state, &actor_id, Some(&to_json), running, 5.0)?;
            let check_profile = details.profile.get("check");
            let ability = at(check_profile, "ability").cloned();
            let skill = at(check_profile, "skill").cloned();
            let difficulty = at(check_profile, "difficulty").cloned();
            let modifier = ability_modifier(at(at(actor, "abilities"), &js::s(ability.as_ref()))) + skill_proficiency_bonus(actor, &js::s(skill.as_ref()), Some(&state));
            let mut options = Map::new();
            options.insert("modifier".into(), Value::from(modifier));
            options.insert("difficulty".into(), undef(difficulty.as_ref()));
            options.insert("purpose".into(), Value::String("scene_swing:athletics".into()));
            options.insert("actorId".into(), undef(command.get("actor_id")));
            options.insert("visibility".into(), r.visibility());
            let check = roll_ability_check_with_conditions(&state, &mut r.dice, &actor_id, ability.as_ref(), &Value::Object(options), D20Method::RollCheck)?;
            r.rolls.push(check.clone());
            let prop_id = js::string(command.get("swing_prop_id"));
            let mut payload = Map::new();
            if let Some(ability) = &ability {
                payload.insert("ability".into(), ability.clone());
            }
            if let Some(skill) = &skill {
                payload.insert("skill".into(), skill.clone());
            }
            for (key, value) in spread_value(Some(&check)) {
                payload.insert(key, value);
            }
            payload.insert("swing_prop_id".into(), Value::String(prop_id.clone()));
            payload.insert("policy_id".into(), Value::String(SCENE_SWING_POLICY_ID.into()));
            r.events.push(event_from(&r.command_with_rules(&[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&json!([actor_id]))));
            let difficulty_field = |map: &mut Map<String, Value>| {
                if let Some(difficulty) = &difficulty {
                    map.insert("difficulty".into(), difficulty.clone());
                }
            };
            if !js::is_true(check.get("success")) {
                r.events.push(event_from(&r.command_with_rules(&[rule_ids::TURNS]), "CombatActionUsed", Some(json!({ "action_id": "scene-swing", "name": "Раскачка на люстре", "action_type": "action" })), Some(&json!([actor_id]))));
                let mut condition = Map::new();
                if let Some(failure) = details.profile.get("failure_condition") {
                    condition.insert("condition".into(), failure.clone());
                }
                condition.insert("duration".into(), Value::String("until-next-turn".into()));
                condition.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
                condition.insert("swing_prop_id".into(), Value::String(prop_id.clone()));
                condition.insert("policy_id".into(), Value::String(SCENE_SWING_POLICY_ID.into()));
                r.events.push(event_from(&r.command_with_rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(condition)), Some(&json!([actor_id]))));
                let mut swing = Map::new();
                swing.insert("success".into(), Value::Bool(false));
                swing.insert("prop_id".into(), Value::String(prop_id));
                swing.insert("policy_id".into(), Value::String(SCENE_SWING_POLICY_ID.into()));
                difficulty_field(&mut swing);
                swing.insert("failure".into(), Value::String("сорвался при попытке ухватиться за опору; упал ничком у неё".into()));
                r.events.push(event_from(&command, "SwingResolved", Some(Value::Object(swing)), Some(&json!([actor_id]))));
                return Ok(());
            }
            let mut swing = Map::new();
            swing.insert("success".into(), Value::Bool(true));
            swing.insert("prop_id".into(), Value::String(prop_id));
            swing.insert("policy_id".into(), Value::String(SCENE_SWING_POLICY_ID.into()));
            difficulty_field(&mut swing);
            r.events.push(event_from(&command, "SwingResolved", Some(Value::Object(swing)), Some(&json!([actor_id]))));
            route = Route::Points(jump.path.clone());
            distance = jump.distance_feet;
            movement_cost = jump.distance_feet;
            movement_spent = jump.movement_spent;
        } else if mode.as_deref() == Some("long_jump") {
            if reaction_movement {
                return Err(rule("Прыжок нельзя выполнить как реакционное перемещение", "JUMP_REACTION_FORBIDDEN"));
            }
            let jump = crate::geometry::movement::long_jump_movement_for(&state, &actor_id, Some(&to_json), js::is_true(command.get("jump_running_start")), 5.0)?;
            route = Route::Points(jump.path.clone());
            distance = jump.distance_feet;
            movement_cost = jump.distance_feet;
            movement_spent = jump.movement_spent;
        } else {
            let movement_map = scene_tactical_map(&state);
            if !actor_footprint_fits(&state, &actor_id, to, FitOptions { map: Some(movement_map.as_ref()), cells: Some(&cells), ..FitOptions::default() }) {
                return Err(rule("Клетка назначения недоступна", "INVALID_DESTINATION"));
            }
            let cost = crate::geometry::terrain::movement_step_cost_for(&state, &actor_id, None);
            let step = |point: Point, map: Option<&sk_tactical::tactical_map::TacticalMap>| cost.step_cost_on(point, map);
            let path = shortest_tactical_path(&state, &actor_id, to, PathOptions { allow_occupied_destination: false, step_cost: Some(&step), tactical_map: Some(cost.map()) });
            let Some(path) = path.filter(|path| !path.is_empty()) else {
                return Err(rule("До клетки назначения нет свободного пути", "PATH_BLOCKED"));
            };
            if !reaction_movement {
                if let Some(start) = from {
                    crate::geometry::movement::assert_voluntary_movement_path(&state, &actor_id, start, to, &path)?;
                }
            }
            distance = path.len() as f64 * 5.0;
            // Цена пути — тот же предикат, что у взвешенного поиска и у
            // планировщика NPC.
            movement_cost = path.iter().fold(0.0, |total, point| total + cost.step_cost_on(*point, cost.map()));
            let speed = effective_speed_feet(&state, actor.unwrap_or(&Value::Null), &actor_id);
            let bonus = movement_bonus_feet(&state, &actor_id, speed);
            let aggressive = command.get("monster_ability").and_then(Value::as_str) == Some("aggressive")
                && r.context.truthy("isNpcScheduler")
                && is_enemy
                && monster_trait_for(actor, "aggressive").is_some_and(|value| js::truthy(Some(value)))
                && at(economy.as_ref(), "bonus_action") != Some(&Value::Bool(false));
            let aggressive_bonus = if aggressive { speed } else { 0 };
            // В бою скорость за ход ограничена; вне боя ведущий подытоживает путь.
            let limit = speed as f64 + if reaction_movement { 0.0 } else { (bonus + aggressive_bonus) as f64 };
            if combat_active && movement_spent + movement_cost > limit {
                return Err(rule("Недостаточно скорости для этого перемещения", "SPEED_EXCEEDED"));
            }
            movement_spent = if combat_active && !reaction_movement { movement_spent + movement_cost } else { 0.0 };
            route = Route::Points(path);
        }
    } else {
        let legacy_from = from.or_else(|| {
            let from_field = command.get("from").filter(|value| js::truthy(Some(value)))?;
            let x = from_field.get("x");
            let y = from_field.get("y");
            (js::is_safe_integer_number(x) && js::is_safe_integer_number(y)).then(|| Point::new(js::number(x), js::number(y)))
        });
        match legacy_from {
            Some(start) => {
                route = Route::Points(vec![to]);
                distance = ((start.x - to.x).abs() + (start.y - to.y).abs()) * 5.0;
            }
            None => {
                let raw = js::number(command.get("distance"));
                distance = js::max_of([0.0, if raw.is_nan() || raw == 0.0 { 0.0 } else { raw }]);
            }
        }
        movement_cost = distance;
    }

    // Добровольный уход из досягаемости врага вызывает удар вдогонку.
    // Отход, невидимость и состояния без реакции его гасят.
    let mut reaction_state = state.clone();
    let path_values: Vec<Value> = route.points().iter().copied().map(point_json).collect();
    if combat_active && from.is_some() && !route.points().is_empty() && !is_enemy {
        let attackers = opportunity_attackers(&state, &actor_id, from_json.as_ref(), &path_values)?;
        // Первый противник считается по тому же состоянию, что вернуло список
        // (`reactionState === state`): его карточка — та же ссылка.
        let mut pristine = true;
        for threatening in attackers {
            let threatening_id = sk_core::game::actor_id(&threatening);
            let threatening_ref = if pristine { sk_core::game::find_actor(&reaction_state, &threatening_id).unwrap_or(&threatening) } else { &threatening };
            let opportunity = crate::combat::weapons::opportunity_attack_profile(&reaction_state, Some(threatening_ref))?;
            let Some(opportunity) = opportunity.filter(|_| living(sk_core::game::find_actor(&reaction_state, &actor_id))) else { break };
            let mut map = spread_value(Some(&command));
            map.insert("command_id".into(), Value::String(format!("{}:opportunity:{threatening_id}", js::string(command.get("command_id")))));
            map.insert("command_type".into(), Value::String("MakeAttack".into()));
            map.insert("actor_id".into(), Value::String(threatening_id.clone()));
            map.insert("target_id".into(), Value::String(actor_id.clone()));
            map.insert("target_ids".into(), json!([actor_id]));
            map.insert("item_id".into(), opportunity.item_id.clone());
            map.insert("reaction_attack".into(), Value::Bool(true));
            map.insert("server_authoritative".into(), Value::Bool(true));
            let mut reaction_command = command_with_rules(&Value::Object(map), &[rule_ids::ATTACK, rule_ids::REACTION]);
            let mut used = Map::new();
            used.insert("action_id".into(), Value::String("opportunity-attack".into()));
            used.insert("name".into(), Value::String("Атака по возможности".into()));
            used.insert("action_type".into(), Value::String("reaction".into()));
            if sk_core::game::uses_2014(&state) {
                used.insert("spellcasting_2014_version".into(), Value::from(1));
            }
            used.insert("target_id".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
            let action_event = event_from(&reaction_command, "CombatActionUsed", Some(Value::Object(used)), Some(&json!([actor_id])));
            r.events.push(action_event.clone());
            reaction_state = Arc::new(crate::replay::apply_game_event(&reaction_state, &action_event)?);
            pristine = false;
            if let Some(map) = reaction_command.as_object_mut() {
                match reaction_state.get("state_version") {
                    Some(version) => {
                        map.insert("expected_state_version".into(), version.clone());
                    }
                    None => {
                        map.shift_remove("expected_state_version");
                    }
                }
            }
            let mut context = r.context.clone();
            context.set("isAdmin", Value::Bool(true));
            context.set("reactionResolution", Value::Bool(true));
            context.set("serverAuthoritativeCombat", Value::Bool(true));
            let result = match api::resolve_command_inner(&reaction_command, &reaction_state, &mut r.dice, &context, &mut *r.uuid) {
                Ok(result) => result,
                Err(Interrupt::Pause(mut pause)) => {
                    // Удар реакцией прерывает перемещение, но не заменяет его:
                    // продолжение повторит путь с сохранёнными бросками.
                    pause.command = command.clone();
                    let transcript = Value::Array(r.dice.transcript.clone());
                    let execution = pending_execution_for(&r.context);
                    let payload = pause.window_payload_mut();
                    payload.insert("pending_command".into(), command.clone());
                    payload.insert("pending_dice_transcript".into(), transcript);
                    payload.insert("pending_execution".into(), execution);
                    return Err(Interrupt::Pause(pause));
                }
                Err(other) => return Err(other),
            };
            r.events.extend(result.events.iter().cloned());
            r.rolls.extend(result.rolls);
            reaction_state = Arc::new(reduce_events(&reaction_state, &result.events)?);
        }
    }
    if !living(sk_core::game::find_actor(&reaction_state, &actor_id)) {
        return Ok(());
    }
    let aggressive_bonus = if command.get("monster_ability").and_then(Value::as_str) == Some("aggressive") && r.context.truthy("isNpcScheduler") && monster_trait_for(actor, "aggressive").is_some_and(|value| js::truthy(Some(value))) {
        effective_speed_feet(&state, actor.unwrap_or(&Value::Null), &actor_id)
    } else {
        0
    };
    let own_speed = effective_speed_feet(&state, actor.unwrap_or(&Value::Null), &actor_id);
    let default_speed = effective_speed_feet(&state, sk_core::game::find_actor(&state, &actor_id).unwrap_or(&Value::Null), &actor_id);
    let speed = own_speed + movement_bonus_feet(&state, &actor_id, default_speed) + aggressive_bonus;
    let mut payload = Map::new();
    let moved_from = from_json.clone().or_else(|| coalesce(&[command.get("from")]).cloned()).unwrap_or(Value::Null);
    payload.insert("from".into(), moved_from);
    payload.insert("to".into(), to_json.clone());
    payload.insert("path".into(), route.json());
    payload.insert("distance".into(), js::num(distance));
    payload.insert("movement_cost".into(), js::num(movement_cost));
    payload.insert("movement_spent".into(), js::num(movement_spent));
    payload.insert("movement_remaining".into(), js::num(js::max_of([0.0, speed as f64 - movement_spent])));
    payload.insert("spend_movement".into(), Value::Bool(!reaction_movement));
    payload.insert("reaction_movement".into(), Value::Bool(reaction_movement));
    if mode.as_deref() == Some("long_jump") {
        payload.insert("movement_mode".into(), Value::String("long_jump".into()));
        payload.insert("jump".into(), json!({ "running_start": js::is_true(command.get("jump_running_start")), "distance_feet": js::num(distance) }));
    } else if mode.as_deref() == Some("swing") {
        payload.insert("movement_mode".into(), Value::String("swing".into()));
        payload.insert("swing".into(), json!({ "prop_id": js::string(command.get("swing_prop_id")), "distance_feet": js::num(distance), "policy_id": SCENE_SWING_POLICY_ID }));
    }
    payload.insert("monster_ability".into(), if aggressive_bonus > 0 { Value::String("aggressive".into()) } else { Value::Null });
    payload.insert("phase".into(), Value::String(if combat_active { "combat" } else { "exploration" }.into()));
    r.events.push(event_from(&command, "ActorMoved", Some(Value::Object(payload)), Some(&json!([actor_id]))));
    // Разведка местом, где герой оказался: без неё туман снимался только
    // переходом сцены и открытой дверью, и отряд запирался в стартовом пятне.
    if !is_enemy {
        let mut scouting = r.state.clone();
        let scouted_map = crate::scene_map_sync::ensure_scene_tactical_map_shared(&mut scouting).map_err(|error| Interrupt::Fault(Fault::new(error.name, error.message).with_code(error.code)))?;
        if !Arc::ptr_eq(&scouting, &r.state) && scouting != r.state {
            r.state = scouting;
            r.projector = crate::replay::CommandProjector::new(&r.state);
        }
        if let Some(map) = scouted_map {
            let scouted: Vec<Value> = cells_visible_from(&map, to, MOVEMENT_SIGHT_CELLS, None)
                .into_iter()
                .filter(|cell| !sk_tactical::tactical_map::cell_at(&map, cell.x, cell.y).is_some_and(|tactical| tactical.revealed))
                .map(|cell| cell.to_value())
                .collect();
            if !scouted.is_empty() {
                r.events.push(event_from(&command, "AreaRevealed", Some(json!({ "cells": scouted })), Some(&json!([]))));
            }
        }
    }
    let entered = r.project_events_shared()?;
    let from_value = from_json.clone().unwrap_or(Value::Null);
    let consequences = r.area_entry_consequences(&entered, &actor_id, Some(&from_value), Some(&to_json), None)?;
    r.events.extend(consequences);
    let mover_conditions = condition_ids_for(&state, &actor_id);
    let booming = sk_core::game::conditions(&state, &actor_id).iter().find(|condition| condition_name(condition).starts_with("booming-blade-move:")).cloned();
    if let Some(booming) = booming.filter(|_| distance > 0.0) {
        let id = js::string(booming.get("id"));
        // `String(id).slice('booming-blade-move:'.length)` по единицам UTF-16.
        let units: Vec<u16> = id.encode_utf16().collect();
        let expression = String::from_utf16_lossy(&units[units.len().min("booming-blade-move:".len())..]);
        let source = match coalesce(&[booming.get("source_actor")]) {
            Some(source) => js::string(Some(source)),
            None => actor_id.clone(),
        };
        let visibility = r.visibility();
        let damage_roll = r.roll_dice(Value::String(expression), "spell:booming-blade:movement", Value::String(source), visibility)?;
        r.rolls.push(damage_roll.clone());
        r.events.push(event_from(&command, "DieRolled", Some(damage_roll.clone()), Some(&json!([]))));
        let payload = r.resolve_damage_payload(&reaction_state, &actor_id, damage_roll.get("total").cloned().unwrap_or(Value::Null), &Value::String("thunder".into()), None, None)?;
        let mut damage = spread_value(Some(&payload));
        damage.insert("spell_id".into(), Value::String("booming-blade".into()));
        damage.insert("movement_triggered".into(), Value::Bool(true));
        r.events.push(event_from(&r.command_with_rules(&[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(damage)), Some(&json!([actor_id]))));
        let removed = match booming.get("id") {
            Some(id) => json!({ "condition": id }),
            None => json!({}),
        };
        r.events.push(event_from(&r.command_with_rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(removed), Some(&json!([actor_id]))));
        if payload.get("hp_after").and_then(Value::as_f64) == Some(0.0) {
            let prior = reduce_events(&state, &r.events[..r.events.len() - 1])?;
            r.events.extend(zero_hit_point_damage_consequences(&prior, &command, &actor_id, &payload, false));
        }
    }
    if combat_active && is_enemy && from.is_some() && !["disengaged", "invisible", "zephyr-strike"].iter().any(|condition| mover_conditions.contains(*condition)) {
        if let Some(reactor) = opportunity_reactor(&state, actor, from_json.as_ref().unwrap_or(&Value::Null), &route)? {
            let payload = json!({
                "id": format!("reaction:{}:opportunity", js::string(command.get("command_id"))),
                "trigger": "enemy-left-reach",
                "actor_id": reactor,
                "source_actor_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
                "target_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
                "source_previous_position": from_json.clone().unwrap_or(Value::Null),
                "action_ids": ["opportunity-attack"],
                "action_options": [{ "id": "opportunity-attack", "name": "Атака по возможности", "description": "Атаковать оружием противника, покидающего вашу досягаемость.", "resource": null, "cost": 1 }],
                "damage": null,
            });
            r.events.push(event_from(&r.command_with_rules(&[rule_ids::REACTION]), "ReactionWindowOpened", Some(payload), Some(&json!([reactor]))));
        }
    }
    // Заготовленная атака на подход — только если этим шагом не открылось
    // окно атаки по возможности: слот окна реакции один.
    if combat_active && from.is_some() && !r.events.iter().any(|event| event.get("event_type").and_then(Value::as_str) == Some("ReactionWindowOpened")) {
        let destination = route.points().last().copied().map(point_json).or_else(|| command.get("to").cloned());
        if let Some((ready_id, readied)) = readied_reactor(&state, &actor_id, from_json.as_ref().unwrap_or(&Value::Null), destination.as_ref()) {
            let option = readied_option_for(Some(&readied), None);
            let payload = json!({
                "id": format!("reaction:{}:readied", js::string(command.get("command_id"))),
                "trigger": "readied",
                "readied_trigger": "enemy-approaches",
                "actor_id": ready_id,
                "source_actor_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
                "target_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
                "action_ids": [option.get("id").cloned().unwrap_or(Value::Null)],
                "action_options": [readied_option_for(Some(&readied), Some("Враг подошёл вплотную"))],
                "damage": null,
            });
            r.events.push(event_from(&r.command_with_rules(&[rule_ids::REACTION]), "ReactionWindowOpened", Some(payload), Some(&json!([ready_id]))));
        }
    }
    if !combat_active && movement_cost > 0.0 && !reaction_movement {
        let seconds = crate::geometry::movement::exploration_movement_duration_seconds(&state, &actor_id, movement_cost)?;
        let source = r.command_with_rules(&[rule_ids::TURNS]);
        r.append_world_time_consequences(&source, Some(&js::num(seconds)), Some(&Value::String("second".into())), TimeAdvanceOptions { policy_id: Some("local-movement-speed/v1".into()), ..TimeAdvanceOptions::default() })?;
    }
    Ok(())
}

/// `String(condition?.id ?? condition)`.
fn condition_name(condition: &Value) -> String {
    match condition.get("id").filter(|value| !value.is_null()) {
        Some(id) => js::string(Some(id)),
        None => js::string(Some(condition)),
    }
}

/// Герой (или призыв отряда), из чьей досягаемости уходит враг (19043–19062).
fn opportunity_reactor(state: &Value, mover: Option<&Value>, from: &Value, route: &Route) -> Result<Option<String>, Interrupt> {
    let order = initiative_order(state);
    let economy = sk_core::game::combat(state).get("action_economy");
    let mut candidates: Vec<&Value> = state.get("players").and_then(Value::as_array).map(|players| players.iter().collect()).unwrap_or_default();
    if let Some(Value::Array(actors)) = state.get("actors") {
        candidates.extend(actors.iter().filter(|candidate| sk_combat_content::combat_spells::is_party_summon(Some(candidate))));
    }
    let blocking = opportunity_blocking_conditions();
    let mut eligible: Vec<String> = Vec::new();
    for candidate in candidates {
        let id = sk_core::game::actor_id(candidate);
        if !sk_core::game::is_living_actor(candidate) || at(at(economy, &id), "reaction") == Some(&Value::Bool(false)) {
            continue;
        }
        let conditions = condition_ids_for(state, &id);
        if blocking.iter().any(|condition| conditions.contains(*condition)) {
            continue;
        }
        let Some(position) = sk_core::game::actor_position(state, &id) else { continue };
        let Some(opportunity) = crate::combat::weapons::opportunity_attack_profile(state, Some(candidate))? else { continue };
        let reach = js::safe_int(opportunity.profile.get("range_feet"), 5).max(5) as f64;
        let at_point = json!({ "x": position.x, "y": position.y });
        let before = footprint_distance(Some(candidate), mover, &at_point, from).unwrap_or(0.0);
        let leaves = match route {
            Route::None => false,
            Route::Points(points) => points.iter().any(|step| footprint_distance(Some(candidate), mover, &at_point, &point_json(*step)).unwrap_or(0.0) > reach),
        };
        if before <= reach && leaves {
            eligible.push(id);
        }
    }
    eligible.sort_by(|left, right| order_compare(&order, left, right));
    Ok(eligible.into_iter().next())
}

/// Заготовивший атаку на подход врага (19068–19096).
fn readied_reactor(state: &Value, mover_id: &str, from: &Value, destination: Option<&Value>) -> Option<(String, Value)> {
    let order = initiative_order(state);
    let mover_enemy = sk_core::game::is_enemy_actor(state, mover_id);
    let economy = sk_core::game::combat(state).get("action_economy");
    let blocking = opportunity_blocking_conditions();
    let readied = match sk_core::game::combat(state).get("readied") {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let mover = sk_core::game::find_actor(state, mover_id);
    let mut eligible: Vec<(String, Value)> = Vec::new();
    for (ready_id, entry) in readied {
        let trigger = match entry.get("trigger") {
            Some(value) => js::string(Some(value)),
            None => "undefined".into(),
        };
        if trigger != "enemy-approaches"
            || ready_id == mover_id
            || sk_core::game::is_enemy_actor(state, &ready_id) == mover_enemy
            || !living(sk_core::game::find_actor(state, &ready_id))
            || at(at(economy, &ready_id), "reaction") == Some(&Value::Bool(false))
        {
            continue;
        }
        let conditions = condition_ids_for(state, &ready_id);
        if blocking.iter().any(|condition| conditions.contains(*condition)) {
            continue;
        }
        let Some(position) = sk_core::game::actor_position(state, &ready_id) else { continue };
        let Some(destination) = destination.filter(|value| js::truthy(Some(value))) else { continue };
        let at_point = json!({ "x": position.x, "y": position.y });
        let ready_actor = sk_core::game::find_actor(state, &ready_id);
        let before = footprint_distance(ready_actor, mover, &at_point, from);
        let after = footprint_distance(ready_actor, mover, &at_point, destination);
        // Именно «подошёл»: был дальше досягаемости, стал в её пределах.
        if before.unwrap_or(0.0) > 5.0 && after.unwrap_or(0.0) <= 5.0 {
            eligible.push((ready_id, entry));
        }
    }
    eligible.sort_by(|left, right| order_compare(&order, &left.0, &right.0));
    eligible.into_iter().next()
}
