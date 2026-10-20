//! Блоки `validateCommand`: Перемещение `MoveActor`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 7769–7791, 7796–7801. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::Value;
use sk_combat_content::scene_hazards::SCENE_SWING_POLICY_ID;
use sk_core::js;

use super::Validation;
use crate::core::speed_zero_condition_for;
use crate::pause::{rule, Step};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

fn is_move(v: &Validation<'_>) -> bool {
    v.command.get("command_type").and_then(Value::as_str) == Some("MoveActor")
}

/// Блок 72 (7769–7791): путь перемещения.
pub fn check_move_actor(v: &mut Validation<'_>) -> Step {
    if !is_move(v) {
        return Ok(());
    }
    let command = &v.command;
    let to = command.get("to");
    if !js::is_safe_integer_number(at(to, "x")) || !js::is_safe_integer_number(at(to, "y")) {
        return Err(rule("Нужны целые координаты назначения", "INVALID_DESTINATION"));
    }
    let actor = sk_core::game::find_actor(v.state, &js::s(command.get("actor_id")));
    if !actor.is_some_and(sk_core::game::is_living_actor) {
        return Err(rule("Побеждённый участник не может двигаться", "ACTOR_DEFEATED"));
    }
    let mode = command.get("movement_mode");
    let jump_mode = matches!(mode.and_then(Value::as_str), Some("long_jump" | "swing"));
    if js::present(mode) && !jump_mode {
        return Err(rule("Неизвестный режим прыжкового перемещения", "MOVEMENT_MODE_INVALID"));
    }
    let long_jump = mode.and_then(Value::as_str) == Some("long_jump");
    if long_jump && (js::present(command.get("swing_prop_id")) || js::present(command.get("swing_ruling"))) {
        return Err(rule("Команда long jump содержит поля swing", "JUMP_FIELDS_CONFLICT"));
    }
    if jump_mode && !sk_core::game::combat_active(v.state) {
        return Err(rule("Прыжковый манёвр требует активного боя", "COMBAT_REQUIRED"));
    }
    if jump_mode && !js::is_true(command.get("server_authoritative")) && !v.context.server_authoritative_combat() {
        return Err(rule("Прыжковый манёвр выбирает только серверный план", "JUMP_SERVER_ONLY"));
    }
    if mode.and_then(Value::as_str) == Some("swing") {
        let policy = at(command.get("swing_ruling"), "policy_id");
        let wrong_policy = js::present(policy) && js::string(policy) != SCENE_SWING_POLICY_ID;
        if js::s(command.get("house_rule_id")) != SCENE_SWING_POLICY_ID || js::s(command.get("swing_prop_id")).is_empty() || wrong_policy {
            return Err(rule("Swing требует авторитетный профиль временного решения", "SWING_POLICY_REQUIRED"));
        }
    }
    Ok(())
}

/// Блок 73 (7796–7801): скорость и состояния при перемещении. Вынужденное
/// перемещение — не своё движение существа и под запрет не попадает.
pub fn check_move_speed(v: &mut Validation<'_>) -> Step {
    if !is_move(v) || js::is_true(v.command.get("reaction_movement")) {
        return Ok(());
    }
    if let Some(condition) = speed_zero_condition_for(v.state, &js::s(v.command.get("actor_id"))) {
        return Err(rule(format!("Скорость существа равна 0 из-за состояния «{condition}»"), "SPEED_IS_ZERO"));
    }
    Ok(())
}
