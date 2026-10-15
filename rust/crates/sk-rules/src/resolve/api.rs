//! Публичные обёртки разбора (`rules-engine.mjs`): `resolveCommand`
//! (12808–12822), `resolveCommandWithPauses` (12994–13011), предпочтения
//! реакций `resolveReactionPreferences` (12762–12806), план `resolveCommands`
//! (27190–27244) и `RulesEngine` (27504–27528). Задача Р5.
//!
//! Пауза боя ловится здесь (`isCombatPause`): на верхнем уровне итог — префикс
//! и событие окна с `pending_execution ??= pendingExecutionFor(context)`, во
//! вложенном разборе пауза летит дальше (см. риск §4 п.2 плана).

use serde_json::Value;

use super::Resolved;
use crate::context::{Context, Uuid};
use crate::dice_record::RulesDice;
use crate::pause::{unported, Halt};

/// `resolveCommand(input, rawState, { diceService, context })`.
pub fn resolve_command(_input: &Value, _raw_state: &Value, _dice: &mut dyn RulesDice, _context: &Context, _uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    Err(unported("resolveCommand").into())
}

/// `resolveCommandWithPauses(input, rawState, { diceService, context })`.
pub fn resolve_command_with_pauses(_input: &Value, _raw_state: &Value, _dice: &mut dyn RulesDice, _context: &Context, _uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    Err(unported("resolveCommandWithPauses").into())
}

/// Итог плана: `{ commands, events, rolls, state }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlan {
    pub commands: Vec<Value>,
    pub events: Vec<Value>,
    pub rolls: Vec<Value>,
    pub state: Value,
}

/// `resolveCommands(commands, initialState, options)`.
pub fn resolve_commands(
    _commands: &[Value],
    _initial_state: &Value,
    _dice: &mut dyn RulesDice,
    _context: &Context,
    _stop_attack_after_movement: bool,
    _uuid: Uuid<'_>,
) -> Result<ResolvedPlan, Halt> {
    Err(unported("resolveCommands").into())
}
