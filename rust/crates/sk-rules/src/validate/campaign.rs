//! Блоки `validateCommand`: Кампания: память мира, социальные NPC, сборка и жизненный цикл героя, решения отряда, финал, дуга. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6184–6193, 6194–6203, 6684–6693, 6764–6776, 6810–6813, 6814–6825, 6826–6842. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Отказ модуля (`WorldMemoryValidationError`, `NpcSocialValidationError`,
//! `CharacterBuildValidationError`, `CharacterLifecycleValidationError`) движок
//! переписывает в `RulesValidationError` с тем же кодом; прочие ошибки модуля
//! идут дальше как есть ([`Fault`] с именем класса JS).

use serde_json::Value;
use sk_core::js;

use super::Validation;
use crate::command::types::{CHARACTER_BUILD_COMMAND_TYPES, CHARACTER_LIFECYCLE_COMMAND_TYPES, NPC_SOCIAL_COMMAND_TYPES, WORLD_MEMORY_COMMAND_TYPES};
use crate::core::slice_utf16;
use crate::pause::{rule, Fault, Halt, Step};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `command.key = value`.
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// `Object.assign(command, result)`.
fn assign(command: &mut Value, result: Value) {
    js::assign(command, result);
}

/// Отказ `character-lifecycle`: свой класс — отказ правила, прочее — ошибка JS.
pub(crate) fn lifecycle_halt(error: sk_character::character_lifecycle::CharacterLifecycleError) -> Halt {
    if error.name == sk_character::character_lifecycle::VALIDATION_ERROR {
        return rule(error.message, error.code.as_deref().unwrap_or("CHARACTER_LIFECYCLE_INVALID"));
    }
    let fault = Fault::new(error.name, error.message);
    match error.code {
        Some(code) => fault.with_code(code).into(),
        None => fault.into(),
    }
}

/// Ошибка `campaign-lifecycle` (`TypeError` на испорченном состоянии).
pub(crate) fn director_halt(error: sk_director::adventure_director::DirectorError) -> Halt {
    let fault = Fault::new(error.name, error.message);
    match error.code {
        Some(code) => fault.with_code(code).into(),
        None => fault.into(),
    }
}

/// Ошибка `questDecisionEvents`: класс модуля, не `RulesValidationError`.
pub(crate) fn quest_decision_halt(error: sk_memory::party_decision::QuestDecisionError) -> Halt {
    let name = match &error {
        sk_memory::party_decision::QuestDecisionError::Party(_) => "PartyDecisionError",
        sk_memory::party_decision::QuestDecisionError::WorldMemory(_) => "WorldMemoryValidationError",
    };
    Fault::new(name, error.message()).with_code(error.code()).into()
}

/// Блок 9 (6184–6193): команды памяти мира.
pub fn check_world_memory(v: &mut Validation<'_>) -> Step {
    if !WORLD_MEMORY_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let result = sk_memory::world_memory::validate_world_memory_command(&v.command, v.state, &v.context.json()).map_err(|error| rule(error.message, &error.code))?;
    assign(&mut v.command, result);
    Ok(())
}

/// Блок 10 (6194–6203): социальные команды NPC.
pub fn check_npc_social(v: &mut Validation<'_>) -> Step {
    if !NPC_SOCIAL_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let result = sk_social::npc_social::validate_npc_social_command(&v.command, v.state, &v.context.json()).map_err(|error| rule(error.message, &error.code))?;
    assign(&mut v.command, result);
    Ok(())
}

/// Блок 27 (6684–6693): сборка героя.
pub fn check_character_build(v: &mut Validation<'_>) -> Step {
    if !CHARACTER_BUILD_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let context = v.context.json();
    let result = sk_combat_content::character_build::validate_character_build_command(&v.command, v.state, Some(&context)).map_err(|error| rule(error.message, &error.code))?;
    assign(&mut v.command, result);
    Ok(())
}

/// Блок 33 (6764–6776): жизненный цикл героя.
pub fn check_character_lifecycle(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    if !CHARACTER_LIFECYCLE_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    let context = v.context.json();
    let command = Some(&v.command);
    let state = Some(v.state);
    let result = match kind.as_str() {
        "LevelUp" => sk_character::character_lifecycle::validate_level_up_command(command, state, Some(&context)),
        "RollCharacterAbilities" | "RollCharacterWealth" => sk_character::character_lifecycle::validate_character_ability_roll_command(command, state, Some(&context)),
        _ => sk_character::character_lifecycle::validate_character_import_command(command, state, Some(&context)),
    }
    .map_err(lifecycle_halt)?;
    assign(&mut v.command, result);
    Ok(())
}

/// Блок 41 (6810–6813): решение отряда по поручению — ссылка проверяется
/// заново при каждом повторе.
pub fn check_quest_decision(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "ResolveQuestDecision" {
        return Ok(());
    }
    sk_memory::party_decision::quest_decision_events(&v.command, v.state, &v.context.json()).map_err(quest_decision_halt)?;
    Ok(())
}

/// `String(value || fallback)`.
fn or_text(value: Option<&Value>, fallback: &str) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        fallback.to_string()
    }
}

/// `String(value || '').normalize('NFKC').trim().slice(0, max)`.
fn clean_or_empty(value: Option<&Value>, max: usize) -> String {
    slice_utf16(sk_core::text::trim(&sk_core::text::nfkc(&or_text(value, ""))), max)
}

/// Блок 42 (6814–6825): финал кампании.
pub fn check_complete_campaign(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "CompleteCampaign" {
        return Ok(());
    }
    if !v.context.is_director() {
        return Err(rule("Автоматический финал доступен только серверному контуру кампании", "CAMPAIGN_COMPLETION_FORBIDDEN"));
    }
    if !sk_director::campaign_lifecycle::campaign_can_auto_complete(v.state).map_err(director_halt)? {
        return Err(rule("Условия автоматического финала ещё не достигнуты", "CAMPAIGN_COMPLETION_NOT_READY"));
    }
    let epilogue = clean_or_empty(v.command.get("epilogue"), 8_000);
    set_field(&mut v.command, "epilogue", Value::String(epilogue.clone()));
    if epilogue.is_empty() {
        return Err(rule("Финал требует связного эпилога", "CAMPAIGN_EPILOGUE_REQUIRED"));
    }
    let reason = slice_utf16(&or_text(v.command.get("reason"), "main_thread_resolved_at_climax"), 240);
    set_field(&mut v.command, "reason", Value::String(reason));
    let occurred_at = slice_utf16(&or_text(v.command.get("occurred_at"), ""), 40);
    set_field(&mut v.command, "occurred_at", Value::String(occurred_at));
    Ok(())
}

/// Блок 43 (6826–6842): следующая дуга.
pub fn check_advance_campaign_arc(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "AdvanceCampaignArc" {
        return Ok(());
    }
    if !v.context.is_director() {
        return Err(rule("Смена арки доступна только серверному контуру кампании", "CAMPAIGN_ARC_FORBIDDEN"));
    }
    if !sk_director::campaign_lifecycle::campaign_can_advance_arc(v.state).map_err(director_halt)? {
        return Err(rule("Арка ещё не закрыта подтверждённой кульминацией", "CAMPAIGN_ARC_NOT_READY"));
    }
    let epilogue = clean_or_empty(v.command.get("epilogue"), 8_000);
    set_field(&mut v.command, "epilogue", Value::String(epilogue.clone()));
    if epilogue.is_empty() {
        return Err(rule("Закрытие арки требует связного эпилога", "CAMPAIGN_EPILOGUE_REQUIRED"));
    }
    let hook = clean_or_empty(v.command.get("hook"), 300);
    set_field(&mut v.command, "hook", Value::String(hook.clone()));
    if hook.is_empty() {
        return Err(rule("Следующая арка требует зацепки", "CAMPAIGN_ARC_HOOK_REQUIRED"));
    }
    let reason = slice_utf16(&or_text(v.command.get("reason"), "arc_resolved_at_climax"), 240);
    set_field(&mut v.command, "reason", Value::String(reason));
    let occurred_at = slice_utf16(&or_text(v.command.get("occurred_at"), ""), 40);
    set_field(&mut v.command, "occurred_at", Value::String(occurred_at));
    Ok(())
}
