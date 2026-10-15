//! Метка времени раунда — `withCombatRoundTimeMarker` (`rules-engine.mjs`,
//! 12555–12584). Задача Р0.
//!
//! Первое действие хода, которое тратит время раунда, получает в начало
//! событий `CombatRoundTimeMarked` (часы мира считают раунд по шесть секунд).
//! Вложенный разбор метку не ставит: её ставит команда верхнего уровня.

use serde_json::{Map, Value};
use sk_core::js;

use super::Resolved;
use crate::command::rules::rule_ids;
use crate::context::Context;
use crate::core::{command_with, command_with_rules, event_from};

/// `COMBAT_ROUND_TIME_POLICY`.
pub const COMBAT_ROUND_TIME_POLICY: &str = "round6-completed-and-final-started";

/// `COMBAT_ROUND_TIME_COMMANDS`: команды, действие которых тратит время раунда.
pub const COMBAT_ROUND_TIME_COMMANDS: [&str; 23] = [
    "MakeAttack", "MakeAreaAttack", "CastSpell", "UseCombatAction", "UseMonsterAction",
    "UseLegendaryAction", "MoveActor", "ChangeWeapon", "UseItem", "ActivateItem", "EquipItem",
    "IdentifyEnemy", "ResolveImprovisedAction", "CalmBeast", "FeedBeast", "ScareWithBeast",
    "ProposeParley", "BarricadeDoor", "ClearDoorBarricade", "OperateDoor", "OperateSceneObject",
    "ReturnKnightHead", "NegotiateScenarioTreaty",
];

fn payload_str<'a>(event: &'a Value, key: &str) -> Option<&'a str> {
    event.get("payload").and_then(|payload| payload.get(key)).and_then(Value::as_str)
}

fn payload_number(event: &Value, key: &str) -> f64 {
    js::number(event.get("payload").and_then(|payload| payload.get(key)))
}

/// Тратит ли событие время раунда.
fn acted(event: &Value) -> bool {
    let event_type = event.get("event_type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "AttackResolved" | "AreaAttackResolved" | "SpellCast" | "DoorBarricaded" | "DoorBarricadeCleared" | "DoorLockpicked" | "DoorForced" | "DoorBarricadeForced" => true,
        "ActorMoved" => payload_number(event, "distance") > 0.0,
        "CombatActionUsed" => matches!(payload_str(event, "action_type"), Some("action" | "bonus_action" | "reaction")) || payload_number(event, "movement_spent") > 0.0,
        "EquipmentChanged" => payload_str(event, "timing") == Some("action"),
        "ItemUsed" | "ItemEquipped" | "ItemUnequipped" | "MagicItemActivationChanged" => {
            matches!(payload_str(event, "combat_action"), Some("action" | "bonus_action" | "reaction" | "object_interaction"))
        }
        _ => false,
    }
}

/// `withCombatRoundTimeMarker(result, rawState, context)`.
pub fn with_combat_round_time_marker(result: Resolved, raw_state: &Value, context: &Context) -> Resolved {
    let command_type = js::s(result.command.get("command_type"));
    if context.resolve_depth() > 0 || !COMBAT_ROUND_TIME_COMMANDS.contains(&command_type.as_str()) {
        return result;
    }
    let combat = raw_state.get("mechanics").and_then(|mechanics| mechanics.get("combat"));
    let active = combat.and_then(|combat| combat.get("active"));
    if !js::truthy(active) || js::is_true(combat.and_then(|combat| combat.get("round_time_pending"))) {
        return result;
    }
    if !result.events.iter().any(acted) {
        return result;
    }
    let source = command_with(&command_with_rules(&result.command, &[rule_ids::TURNS]), "visibility", Value::String("gm_only".into()));
    let mut payload = Map::new();
    payload.insert("clock_version".into(), Value::from(2));
    payload.insert("policy_id".into(), Value::String(COMBAT_ROUND_TIME_POLICY.into()));
    payload.insert("round".into(), Value::from(js::safe_int(combat.and_then(|combat| combat.get("round")), 1)));
    let mut marker = event_from(&source, "CombatRoundTimeMarked", Some(Value::Object(payload)), Some(&Value::Array(Vec::new())));
    marker["event_schema_version"] = Value::from(2);
    let mut events = Vec::with_capacity(result.events.len() + 1);
    events.push(marker);
    events.extend(result.events);
    Resolved { command: result.command, events, rolls: result.rolls }
}
