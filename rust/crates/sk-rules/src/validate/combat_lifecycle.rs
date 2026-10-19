//! Блоки `validateCommand`: Вход в бой: нападение на NPC, встреча, старт и конец боя. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 6900–6902, 6903–6921, 7044–7046, 7047–7057. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::Value;
use sk_core::game;
use sk_core::indexmap::IndexSet;
use sk_core::js;

use super::Validation;
use crate::combat::encounter::{assemble_encounter_for_command, validate_attack_npc_command};
use crate::command::types::ENCOUNTER_LIFECYCLE_COMMAND_TYPES;
use crate::npc_item_events::party_member_ids;
use crate::pause::{rule, Step};
use crate::targets::is_unstable_dying_hero;

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

fn array_of(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Блок 47 (6900–6902): нападение на NPC.
pub fn check_attack_npc(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "AttackNpc" {
        return Ok(());
    }
    validate_attack_npc_command(&mut v.command, v.state)
}

/// Блок 48 (6903–6921): сборка встречи.
pub fn check_encounter_lifecycle(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    if !ENCOUNTER_LIFECYCLE_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    // `context?.allowPlayerNpcEncounter === true && command.npc_id && command.command_type === 'CreateEncounter'`.
    let player_npc_encounter = v.context.is_true("allowPlayerNpcEncounter") && js::truthy(v.command.get("npc_id")) && kind == "CreateEncounter";
    if !v.context.is_admin() && !v.context.is_director() && !player_npc_encounter {
        return Err(rule("Создать столкновение может только системный контур кампании", "ENCOUNTER_MANAGEMENT_FORBIDDEN"));
    }
    if game::combat_active(v.state) {
        return Err(rule("Нельзя создать новое столкновение во время активного боя", "ENCOUNTER_DURING_COMBAT"));
    }
    let status = js::s(game::mechanics(v.state).get("encounter").and_then(|encounter| encounter.get("status")));
    if array_of(v.state.get("enemies")).iter().any(game::is_living_actor) || matches!(status.as_str(), "staged" | "active") {
        return Err(rule("В текущей сцене уже есть незавершённое столкновение", "ENCOUNTER_ALREADY_PRESENT"));
    }
    let encounter = assemble_encounter_for_command(v.state, &v.command)?;
    if let Some(map) = v.command.as_object_mut() {
        map.insert("encounter".into(), encounter);
    }
    Ok(())
}

/// Блок 59 (7044–7046): бой ещё не начат.
pub fn check_start_combat(v: &mut Validation<'_>) -> Step {
    if command_type(v) == "StartCombat" && game::combat_active(v.state) {
        return Err(rule("Бой уже начат", "COMBAT_ALREADY_ACTIVE"));
    }
    Ok(())
}

/// Блок 60 (7047–7057): конец боя — не посреди спасбросков от смерти героя
/// из очереди.
pub fn check_end_combat(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "EndCombat" {
        return Ok(());
    }
    let members = party_member_ids(v.state);
    let combat = game::combat(v.state);
    let queued: IndexSet<String> = array_of(combat.get("initiative")).iter().map(|entry| js::s(entry.get("actor_id"))).collect();
    let active = game::combat_active(v.state);
    let pending = array_of(v.state.get("players")).iter().any(|hero| {
        let id = game::actor_id(hero);
        members.contains(&id) && (!active || queued.contains(&id)) && is_unstable_dying_hero(v.state, &id)
    });
    if pending {
        return Err(rule("Нельзя завершить бой, пока герой делает спасброски от смерти", "DEATH_SAVES_PENDING"));
    }
    Ok(())
}
