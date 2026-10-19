//! Публичные обёртки разбора (`rules-engine.mjs`): `resolveCommand`
//! (12808–12822), `resolveCommandWithPauses` (12994–13011), предпочтения
//! реакций `resolveReactionPreferences` (12762–12806), план `resolveCommands`
//! (27190–27244) и `RulesEngine` (27504–27528). Задача Р5.
//!
//! Пауза боя ловится здесь (`isCombatPause`): на верхнем уровне итог — префикс
//! и событие окна с `pending_execution ??= pendingExecutionFor(context)`, во
//! вложенном разборе пауза летит дальше (см. риск §4 п.2 плана).
//!
//! Запись корпуса (`recordCorpusCommand`, `__corpus_recording`) не переносится.
//!
//! Сверка с корпусом, пока не все блоки `validateCommand` перенесены:
//! [`with_lenient_validation`] включает в этом потоке «мягкую» проверку —
//! блок-заглушка пропускается (его имя пишется в [`take_skipped_blocks`]), и
//! все обёртки, вложенные разборы и удар-открытие идут через неё.

use std::cell::{Cell, RefCell};

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;

use super::{opening_strike, Resolve, Resolved};
use crate::context::{Context, Uuid};
use crate::core::{command_with, target_for};
use crate::dice_record::{Recording, RulesDice};
use crate::pause::{pending_execution_for, resistance_choices_from_context, Halt};
use crate::reactions::REACTION_PREFERENCE_CHAIN_LIMIT;
use crate::replay::{apply_game_event, CommandProjector};

thread_local! {
    static LENIENT: Cell<bool> = const { Cell::new(false) };
    static SKIPPED: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
}

/// Выполнить `operation` с мягкой проверкой команды (только для сверки с корпусом).
pub fn with_lenient_validation<T>(operation: impl FnOnce() -> T) -> T {
    let previous = LENIENT.with(|flag| flag.replace(true));
    let result = operation();
    LENIENT.with(|flag| flag.set(previous));
    result
}

/// Имена блоков проверки, пропущенных мягкой проверкой с прошлого вызова.
pub fn take_skipped_blocks() -> Vec<&'static str> {
    SKIPPED.with(|skipped| std::mem::take(&mut *skipped.borrow_mut()))
}

/// `validateCommand`: обычная или мягкая (блок-заглушка пропускается).
pub fn validate(input: &Value, raw_state: &Value, context: &Context, uuid: Uuid<'_>) -> Result<Value, Halt> {
    if !LENIENT.with(Cell::get) {
        return crate::validate::validate_command(input, raw_state, context, uuid);
    }
    let state = crate::normalize::normalize_campaign_state(raw_state)?;
    let command = crate::command::normalize::normalize_command(input, &state, uuid)?;
    let mut validation = crate::validate::Validation { state: &state, command, context, actor_fate: None };
    for block in crate::validate::BLOCKS {
        match (block.check)(&mut validation) {
            Ok(()) => {}
            Err(halt) if halt.is_unported() => SKIPPED.with(|skipped| skipped.borrow_mut().push(block.name)),
            Err(halt) => return Err(halt),
        }
    }
    Ok(validation.command)
}

/// `resolveCommandInternal` для обёрток: обычный или с мягкой проверкой.
pub(crate) fn resolve_internal(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    if !LENIENT.with(Cell::get) {
        return super::resolve_command_internal(input, raw_state, dice, context, uuid);
    }
    let depth = context.resolve_depth().max(0);
    let context = context.with("__resolve_depth", Value::from(depth + 1));
    let recording = Recording::new(dice);
    let mut state = crate::normalize::normalize_campaign_state(raw_state)?;
    super::push_npc_spell_proxies(&mut state, input)?;
    let projector = CommandProjector::new(&state);
    let command = validate(input, &state, &context, &mut *uuid)?;
    let target_id = target_for(&command);
    let resistance_choices = resistance_choices_from_context(context.get("resistanceChoices"));
    let elemental_reaction_choices = super::reaction_choices(context.get("elementalDamageChoices"), "damage_key");
    let protective_reaction_choices = super::reaction_choices(context.get("protectiveReactionChoices"), "key");
    let truce_before_command = sk_society::parley::truce_for(&state);
    let mut r = Resolve {
        state,
        command,
        context,
        depth,
        dice: recording,
        uuid,
        events: Vec::new(),
        rolls: Vec::new(),
        target_id,
        inspiration_spent: IndexSet::new(),
        resistance_cantrip_uses: IndexSet::new(),
        resistance_choices,
        resistance_used_targets: IndexSet::new(),
        resistance_save_sequence: 0,
        elemental_reaction_choices,
        elemental_reaction_sequence: 0,
        protective_reaction_choices,
        nested_consequences_resolved: false,
        truce_before_command,
        legendary_spends_in_command: IndexMap::new(),
        oiled_targets: IndexSet::new(),
        projector,
    };
    r.append_truce_broken();
    super::dispatch::dispatch(&mut r)?;
    super::post::finish(r)
}

/// `resolveCommand(input, rawState, { diceService, context })`.
pub fn resolve_command(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    let result = resolve_command_with_pauses(input, raw_state, dice, context, &mut *uuid)?;
    if context.resolve_depth() != 0 {
        return Ok(result);
    }
    resolve_reaction_preferences(result, raw_state, input, dice, uuid)
}

/// `resolveCommandWithPauses(input, rawState, { diceService, context })`.
pub fn resolve_command_with_pauses(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    match resolve_and_close(input, raw_state, dice, context, uuid) {
        Ok(resolved) => Ok(resolved),
        Err(Halt::Pause(mut pause)) => {
            let payload = pause.window_payload_mut();
            if !js::present(payload.get("pending_execution")) {
                payload.insert("pending_execution".into(), pending_execution_for(context));
            }
            if context.resolve_depth() != 0 {
                return Err(Halt::Pause(pause));
            }
            let mut events = std::mem::take(&mut pause.prefix_events);
            events.push(pause.window_event.clone());
            let result = Resolved { command: pause.command.clone(), events, rolls: std::mem::take(&mut pause.prefix_rolls) };
            Ok(super::round_time::with_combat_round_time_marker(result, raw_state, context))
        }
        Err(other) => Err(other),
    }
}

/// Тело `try` в `resolveCommandWithPauses`: удар-открытие или разбор, затем
/// закрытие «Обессиливания», отработавших усилений и метка раунда.
fn resolve_and_close(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    let opening = opening_strike::opening_strike_for(input, raw_state, context)?;
    let resolved = match opening {
        Some(opening) => opening_strike::resolve_opening_strike(input, raw_state, &opening, dice, context, uuid)?,
        None => resolve_internal(input, raw_state, dice, context, uuid)?,
    };
    let after_action = crate::spells::enervation::close_enervation_after_other_action(resolved, raw_state)?;
    let after_triggers = crate::spells::enervation::close_enervation_after_triggers(after_action, raw_state)?;
    let finished = crate::spells::enervation::close_finished_spell_buffs(after_triggers, raw_state)?;
    Ok(super::round_time::with_combat_round_time_marker(finished, raw_state, context))
}

fn event_type(event: &Value) -> &str {
    event.get("event_type").and_then(Value::as_str).unwrap_or("")
}

/// `resolveReactionPreferences(result, rawState, input, diceService)`: режимы
/// реакций «сразу» и «никогда» отвечают на окно в той же команде обычным
/// `UseCombatAction`. Отказ движка оставляет окно открытым.
pub fn resolve_reaction_preferences(result: Resolved, raw_state: &Value, input: &Value, dice: &mut dyn RulesDice, uuid: Uuid<'_>) -> Result<Resolved, Halt> {
    let preference_events = |events: &[Value]| events.iter().any(|event| event_type(event) == "ReactionPreferenceChanged");
    let has_preferences = raw_state.get("mechanics").and_then(|mechanics| mechanics.get("reaction_preferences")).and_then(Value::as_object).is_some_and(|map| !map.is_empty());
    if !has_preferences && !preference_events(&result.events) {
        return Ok(result);
    }
    let window_was_open = js::truthy(raw_state.get("mechanics").and_then(|mechanics| mechanics.get("combat")).and_then(|combat| combat.get("reaction_window")));
    if !window_was_open && !result.events.iter().any(|event| event_type(event) == "ReactionWindowOpened") {
        return Ok(result);
    }
    let mut after = crate::normalize::normalize_campaign_state(raw_state)?;
    for event in &result.events {
        after = apply_game_event(&after, event)?;
    }
    let base_id = match crate::core::coalesce(&[result.command.get("command_id")]).or_else(|| crate::core::coalesce(&[input.get("command_id")])) {
        Some(id) => js::string(Some(id)),
        None => "command".into(),
    };
    let mut combined = result;
    for step in 0..REACTION_PREFERENCE_CHAIN_LIMIT {
        let window = sk_core::game::combat(&after).get("reaction_window").filter(|value| js::truthy(Some(value))).cloned();
        let Some(window) = window else { return Ok(combined) };
        let window_actor = js::s(window.get("actor_id"));
        let is_hero = after.get("players").and_then(Value::as_array).is_some_and(|players| players.iter().any(|player| sk_core::game::actor_id(player) == window_actor));
        if !is_hero {
            return Ok(combined);
        }
        let preferences = sk_core::game::mechanics(&after).get("reaction_preferences");
        let Some(plan) = sk_combat_base::reaction_preferences::plan_reaction_by_preference(preferences, Some(&window)) else { return Ok(combined) };
        let plan = plan.to_json();
        let mode = js::s(plan.get("mode"));
        let mut follow_up = Map::new();
        follow_up.insert("command_type".into(), Value::String("UseCombatAction".into()));
        follow_up.insert("command_id".into(), Value::String(format!("{base_id}:reaction-preference:{}", step + 1)));
        if let Some(campaign) = combined.command.get("campaign_id").filter(|value| !value.is_null()) {
            follow_up.insert("campaign_id".into(), campaign.clone());
        }
        follow_up.insert("actor_id".into(), Value::String(js::string(window.get("actor_id"))));
        follow_up.insert("action_id".into(), plan.get("action_id").cloned().unwrap_or(Value::Null));
        if mode == "never" {
            follow_up.insert("auto_skip_reason".into(), Value::String("reaction-preference".into()));
        } else if let Some(source) = window.get("source_actor_id").filter(|value| js::truthy(Some(value))) {
            follow_up.insert("target_id".into(), Value::String(js::string(Some(source))));
        }
        follow_up.insert("server_authoritative".into(), Value::Bool(true));
        follow_up.insert("expected_state_version".into(), after.get("state_version").cloned().unwrap_or(Value::Null));
        let context = Context::from_json(&json!({ "isAdmin": true, "serverAuthoritativeCombat": true }));
        let answer = match resolve_command_with_pauses(&Value::Object(follow_up), &after, dice, &context, &mut *uuid) {
            Ok(answer) => answer,
            // Заглушка ещё не перенесённой ветки — не отказ движка: пусть видно.
            Err(halt) if halt.is_rule() && !halt.is_unported() => return Ok(combined),
            Err(halt) => return Err(halt),
        };
        let window_id = js::s(window.get("id"));
        let mut answer_events = answer.events;
        for event in answer_events.iter_mut() {
            let payload = event.get("payload");
            let closes = event_type(event) == "ReactionWindowClosed" && js::s(payload.and_then(|payload| payload.get("id"))) == window_id;
            let answers = event_type(event) == "CombatActionUsed" && js::s(payload.and_then(|payload| payload.get("reaction_window_id"))) == window_id;
            if closes || answers {
                let mut map = crate::core::spread_value(payload);
                map.insert("reaction_preference".into(), Value::String(mode.clone()));
                event["payload"] = Value::Object(map);
            }
        }
        for event in &answer_events {
            after = apply_game_event(&after, event)?;
        }
        combined.events.extend(answer_events);
        combined.rolls.extend(answer.rolls);
    }
    Ok(combined)
}

/// Итог плана: `{ commands, events, rolls, state }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlan {
    pub commands: Vec<Value>,
    pub events: Vec<Value>,
    pub rolls: Vec<Value>,
    pub state: Value,
}

/// `resolveCommands(commands, initialState, options)`: команды плана одна за
/// другой над состоянием после предыдущих; план встаёт на новом окне реакции.
pub fn resolve_commands(commands: &[Value], initial_state: &Value, dice: &mut dyn RulesDice, context: &Context, stop_attack_after_movement: bool, uuid: Uuid<'_>) -> Result<ResolvedPlan, Halt> {
    let mut state = crate::normalize::normalize_campaign_state(initial_state)?;
    let mut all_events: Vec<Value> = Vec::new();
    let mut all_rolls: Vec<Value> = Vec::new();
    let mut validated: Vec<Value> = Vec::new();
    for (index, item) in commands.iter().enumerate() {
        let explicit = js::present(item.get("expected_state_version")) || js::present(item.get("expectedStateVersion"));
        let expected = if index == 0 && explicit {
            crate::core::coalesce(&[item.get("expected_state_version")]).or_else(|| item.get("expectedStateVersion")).cloned().unwrap_or(Value::Null)
        } else {
            state.get("state_version").cloned().unwrap_or(Value::Null)
        };
        let failed_swing = all_events.iter().any(|event| event_type(event) == "SwingResolved" && js::is_false(event.get("payload").and_then(|payload| payload.get("success"))));
        let item_type = item.get("command_type").and_then(Value::as_str);
        if failed_swing && item_type == Some("MakeAttack") {
            break;
        }
        let input = command_with(item, "expected_state_version", expected);
        if stop_attack_after_movement && item_type == Some("MakeAttack") && validated.iter().any(|entry| entry.get("command_type").and_then(Value::as_str) == Some("MoveActor")) {
            match validate(&input, &state, context, &mut *uuid) {
                Ok(_) => {}
                Err(halt) if halt.is_rule() => break,
                Err(halt) => return Err(halt),
            }
        }
        let window_before = js::s(sk_core::game::combat(&state).get("reaction_window").and_then(|window| window.get("id")));
        let result = resolve_command(&input, &state, dice, context, &mut *uuid)?;
        validated.push(result.command.clone());
        for event in &result.events {
            state = apply_game_event(&state, event)?;
            all_events.push(event.clone());
        }
        let created: IndexSet<String> = result
            .events
            .iter()
            .filter(|event| event_type(event) == "MerchantCreated")
            .map(|event| {
                let payload = event.get("payload");
                js::s(crate::core::coalesce(&[payload.and_then(|payload| payload.get("merchant_id"))]).or_else(|| payload.and_then(|payload| payload.get("merchant")).and_then(|merchant| merchant.get("id"))))
            })
            .filter(|id| !id.is_empty())
            .collect();
        if !created.is_empty() {
            let placement_state = crate::normalize::normalize_campaign_state(&state)?;
            let placements: Vec<Value> = sk_npc_world::npc_positioning::plan_scene_npc_placement_events(&placement_state)
                .into_iter()
                .filter(|draft| event_type(draft) == "NpcPlaced" && created.contains(&js::s(draft.get("payload").and_then(|payload| payload.get("npc_id")))))
                .collect();
            for placement in crate::core::npc_world_events_from(&result.command, &Value::Array(placements)) {
                state = apply_game_event(&state, &placement)?;
                all_events.push(placement);
            }
        }
        all_rolls.extend(result.rolls);
        let paused = sk_core::game::combat(&state).get("reaction_window").filter(|window| js::truthy(Some(window)));
        if let Some(paused) = paused {
            let pending = js::truthy(paused.get("pending_command")) || js::truthy(paused.get("pending_spell_command"));
            if pending && js::s(paused.get("id")) != window_before {
                break;
            }
        }
    }
    Ok(ResolvedPlan { commands: validated, events: all_events, rolls: all_rolls, state })
}

/// `RulesEngine`: движок с внедрёнными костями и источником UUID.
pub struct RulesEngine {
    pub dice: Box<dyn RulesDice>,
    pub uuid: Box<dyn FnMut() -> String>,
}

impl RulesEngine {
    /// `new RulesEngine({ diceService })`; UUID — `randomUUID`.
    pub fn new(dice: Box<dyn RulesDice>) -> Self {
        Self { dice, uuid: Box::new(crate::context::random_uuid) }
    }

    /// `validate(command, state, context)`.
    pub fn validate(&mut self, command: &Value, state: &Value, context: &Context) -> Result<Value, Halt> {
        crate::validate::validate_command(command, state, context, &mut *self.uuid)
    }

    /// `resolve(command, state, context)`.
    pub fn resolve(&mut self, command: &Value, state: &Value, context: &Context) -> Result<Resolved, Halt> {
        resolve_command(command, state, &mut *self.dice, context, &mut *self.uuid)
    }

    /// `resolvePlan(plan, state, context)`.
    pub fn resolve_plan(&mut self, plan: &Value, state: &Value, context: &Context) -> Result<ResolvedPlan, Halt> {
        let commands = match crate::core::coalesce(&[plan.get("proposed_commands")]).or_else(|| crate::core::coalesce(&[plan.get("commands")])) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let stop = matches!(plan.get("maneuver").and_then(Value::as_str), Some("approach_attack" | "long_jump_attack" | "swing_attack"));
        resolve_commands(&commands, state, &mut *self.dice, context, stop, &mut *self.uuid)
    }

    /// `authorizeDirectorIntent(intent, state)`.
    pub fn authorize_director_intent(&self, intent: &Value, state: &Value) -> Result<Value, Halt> {
        let normalized = crate::normalize::normalize_campaign_state(state)?;
        sk_story::campaign_loop_policy::authorize_director_intent(&normalized, Some(intent), None).map_err(|error| {
            Halt::Fault(crate::pause::Fault::new(sk_world_story::autonomous_campaign::DirectorIntentError::NAME, error.message).with_code(error.code))
        })
    }
}
