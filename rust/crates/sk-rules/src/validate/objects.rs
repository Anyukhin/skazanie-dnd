//! Блоки `validateCommand`: Объекты и двери: баррикада, объект сцены. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 6998–7001, 7855–7876. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::Value;
use sk_core::{game, js};

use super::Validation;
use crate::core::incapacitating_condition_for;
use crate::pause::{rule, Step};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// Глаголы объекта сцены (7857).
const SCENE_OBJECT_INTENTS: [&str; 8] = ["inspect", "open", "lockpick", "take", "use", "topple", "ignite", "pray"];

/// Блок 54 (6998–7001): с баррикадой работает дееспособный живой.
pub fn check_barricade_actor(v: &mut Validation<'_>) -> Step {
    if !matches!(command_type(v).as_str(), "BarricadeDoor" | "ClearDoorBarricade") {
        return Ok(());
    }
    let actor_id = js::s(v.command.get("actor_id"));
    let living = game::find_actor(v.state, &actor_id).is_some_and(game::is_living_actor);
    if !living || incapacitating_condition_for(v.state, &actor_id).is_some() {
        return Err(rule("С баррикадой может работать только дееспособный живой герой", "ACTOR_INCAPACITATED"));
    }
    Ok(())
}

/// Блок 78 (7855–7876): взаимодействие с объектом сцены.
pub fn check_scene_object(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "OperateSceneObject" {
        return Ok(());
    }
    if !js::truthy(v.command.get("prop_id")) {
        return Err(rule("Не выбран объект сцены", "SCENE_OBJECT_REQUIRED"));
    }
    let intent = v.command.get("intent").and_then(Value::as_str);
    if !intent.is_some_and(|intent| SCENE_OBJECT_INTENTS.contains(&intent)) {
        return Err(rule("Неизвестный способ взаимодействия с объектом сцены", "SCENE_OBJECT_INTENT_NOT_ALLOWED"));
    }
    if intent == Some("pray") && game::combat_active(v.state) {
        return Err(rule("Посреди боя благословений не раздают", "BLESSING_DURING_COMBAT"));
    }
    if v.command.get("approach").and_then(Value::as_str) == Some("force") && !js::is_true(v.command.get("server_authoritative")) && !v.context.server_authoritative_combat() {
        return Err(rule("Силовой подход выбирает только серверный разбор свободного действия", "SCENE_OBJECT_FORCE_FORBIDDEN"));
    }
    Ok(())
}
