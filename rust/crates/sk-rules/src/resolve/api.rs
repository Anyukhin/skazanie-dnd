//! Публичные обёртки разбора (`rules-engine.mjs`): `resolveCommand`
//! (12830–12844), `resolveCommandWithPauses` (13016–13033), предпочтения
//! реакций `resolveReactionPreferences` (12784–12828), план `resolveCommands`
//! (27212–27266) и `RulesEngine` (27526–27550). Задача Р5.
//!
//! Пауза боя ловится здесь (`isCombatPause`): на верхнем уровне итог — префикс
//! и событие окна с `pending_execution ??= pendingExecutionFor(context)`, во
//! вложенном разборе пауза летит дальше (см. риск §4 п.2 плана).
//!
//! Граница API (урок 5): публичные [`resolve_command`],
//! [`resolve_command_with_pauses`], [`resolve_commands`] и [`RulesEngine`]
//! отдают [`Outcome`] (план — [`ResolvedPlan::pending`]) и [`Halt`] без паузы.
//! Внутри движка вложенный разбор идёт через [`resolve_command_inner`] и
//! [`resolve_with_pauses_inner`] с [`Interrupt`]: так пауза вложенной команды
//! долетает до своего места ловли.
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
use crate::outcome::{prompt_after, Outcome, Prompt};
use crate::pause::{pending_execution_for, resistance_choices_from_context, Fault, Halt, Interrupt};
use crate::reactions::REACTION_PREFERENCE_CHAIN_LIMIT;
use crate::normalized::{EventChain, NormalizedState, StateIn};

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
    let state = NormalizedState::normalize(raw_state)?;
    validate_state(input, &state, context, uuid)
}

/// [`validate`] над нормализованным состоянием.
pub fn validate_state(input: &Value, state: &NormalizedState, context: &Context, uuid: Uuid<'_>) -> Result<Value, Halt> {
    let ambient = state.in_ambient_mode()?;
    let state = ambient.value();
    if !LENIENT.with(Cell::get) {
        return crate::validate::validate_normalized(input, state, context, uuid);
    }
    let command = crate::command::normalize::normalize_command(input, state, uuid)?;
    let mut validation = crate::validate::Validation { state, command, context, actor_fate: None };
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
pub(crate) fn resolve_internal(input: &Value, normalized: &NormalizedState, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    if !LENIENT.with(Cell::get) {
        return super::resolve_command_internal_state(input, normalized, dice, context, uuid);
    }
    let depth = context.resolve_depth().max(0);
    let context = context.with("__resolve_depth", Value::from(depth + 1));
    let recording = Recording::new(dice);
    let super::CommandStart { state, projector, proxied } = super::command_start(normalized, input)?;
    let command = validate_state(input, proxied.as_ref().unwrap_or(normalized), &context, &mut *uuid)?;
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

/// `resolveCommand(input, rawState, { diceService, context })` команды
/// верхнего уровня: исполнена или ждёт решения игрока.
pub fn resolve_command(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Outcome, Halt> {
    let normalized = NormalizedState::normalize(raw_state)?;
    let resolved = top_level(resolve_command_inner_state(input, StateIn { raw: raw_state, normalized: &normalized }, dice, context, uuid))?;
    Ok(Outcome::with_normalized_state_before(resolved, &normalized))
}

/// [`resolve_command`] над нормализованным состоянием: без повторной
/// нормализации и без копии входа.
pub fn resolve_command_normalized(input: &Value, state: &NormalizedState, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Outcome, Halt> {
    let normalized = state.in_ambient_mode()?;
    let resolved = top_level(resolve_command_inner_state(input, StateIn::of(&normalized), dice, context, uuid))?;
    Ok(Outcome::with_normalized_state_before(resolved, &normalized))
}

/// `resolveCommandWithPauses(input, rawState, { diceService, context })`
/// команды верхнего уровня (без режимов реакций).
pub fn resolve_command_with_pauses(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Outcome, Halt> {
    let normalized = NormalizedState::normalize(raw_state)?;
    let resolved = top_level(resolve_with_pauses_inner(input, StateIn { raw: raw_state, normalized: &normalized }, dice, context, uuid))?;
    Ok(Outcome::with_normalized_state_before(resolved, &normalized))
}

/// Граница API: на верхнем уровне пауза уже стала событием окна, наружу
/// уходят только отказ и сбой. Пауза здесь — вложенный контекст
/// (`__resolve_depth`) у публичного входа: это ошибка вызывающего.
fn top_level<T>(result: Result<T, Interrupt>) -> Result<T, Halt> {
    result.map_err(|interrupt| match interrupt.into_halt() {
        Ok(halt) => halt,
        Err(pause) => Halt::Fault(Fault::new("Error", format!("Пауза вложенного разбора на входе движка: {}", pause.message()))),
    })
}

/// `resolveCommand` внутри движка: пауза вложенного разбора летит дальше.
/// Вход — состояние как есть (итог проекции вложенного шага): нормализуется
/// здесь один раз.
pub(crate) fn resolve_command_inner(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let normalized = NormalizedState::normalize(raw_state)?;
    resolve_command_inner_state(input, StateIn { raw: raw_state, normalized: &normalized }, dice, context, uuid)
}

/// [`resolve_command_inner`] над входом с готовой нормализацией.
pub(crate) fn resolve_command_inner_state(input: &Value, state: StateIn<'_>, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let result = resolve_with_pauses_inner(input, state, dice, context, &mut *uuid)?;
    if context.resolve_depth() != 0 {
        return Ok(result);
    }
    resolve_reaction_preferences(result, state, input, dice, uuid)
}

/// `resolveCommandWithPauses` внутри движка.
pub(crate) fn resolve_with_pauses_inner(input: &Value, state: StateIn<'_>, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    match resolve_and_close(input, state, dice, context, uuid) {
        Ok(resolved) => Ok(resolved),
        Err(Interrupt::Pause(mut pause)) => {
            let payload = pause.window_payload_mut();
            if !js::present(payload.get("pending_execution")) {
                payload.insert("pending_execution".into(), pending_execution_for(context));
            }
            if context.resolve_depth() != 0 {
                return Err(Interrupt::Pause(pause));
            }
            let mut events = std::mem::take(&mut pause.prefix_events);
            events.push(pause.window_event.clone());
            let result = Resolved { command: pause.command.clone(), events, rolls: std::mem::take(&mut pause.prefix_rolls) };
            Ok(super::round_time::with_combat_round_time_marker(result, state.raw, context))
        }
        Err(other) => Err(other),
    }
}

/// Тело `try` в `resolveCommandWithPauses`: удар-открытие или разбор, затем
/// закрытие «Обессиливания», отработавших усилений и метка раунда.
fn resolve_and_close(input: &Value, state: StateIn<'_>, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let opening = opening_strike::opening_strike_for(input, state, context)?;
    let resolved = match opening {
        Some(opening) => opening_strike::resolve_opening_strike(input, state.normalized, &opening, dice, context, uuid)?,
        None => resolve_internal(input, state.normalized, dice, context, uuid)?,
    };
    let after_action = crate::spells::enervation::close_enervation_after_other_action(resolved, state)?;
    let after_triggers = crate::spells::enervation::close_enervation_after_triggers(after_action, state)?;
    let finished = crate::spells::enervation::close_finished_spell_buffs(after_triggers, state.raw)?;
    Ok(super::round_time::with_combat_round_time_marker(finished, state.raw, context))
}

fn event_type(event: &Value) -> &str {
    event.get("event_type").and_then(Value::as_str).unwrap_or("")
}

/// `resolveReactionPreferences(result, rawState, input, diceService)`: режимы
/// реакций «сразу» и «никогда» отвечают на окно в той же команде обычным
/// `UseCombatAction`. Отказ движка оставляет окно открытым.
fn resolve_reaction_preferences(result: Resolved, state: StateIn<'_>, input: &Value, dice: &mut dyn RulesDice, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let raw_state = state.raw;
    let preference_events = |events: &[Value]| events.iter().any(|event| event_type(event) == "ReactionPreferenceChanged");
    let has_preferences = raw_state.get("mechanics").and_then(|mechanics| mechanics.get("reaction_preferences")).and_then(Value::as_object).is_some_and(|map| !map.is_empty());
    if !has_preferences && !preference_events(&result.events) {
        return Ok(result);
    }
    let window_was_open = js::truthy(raw_state.get("mechanics").and_then(|mechanics| mechanics.get("combat")).and_then(|combat| combat.get("reaction_window")));
    if !window_was_open && !result.events.iter().any(|event| event_type(event) == "ReactionWindowOpened") {
        return Ok(result);
    }
    let mut chain = EventChain::new(state.normalized.clone());
    for event in &result.events {
        chain.apply(event)?;
    }
    let base_id = match crate::core::coalesce(&[result.command.get("command_id")]).or_else(|| crate::core::coalesce(&[input.get("command_id")])) {
        Some(id) => js::string(Some(id)),
        None => "command".into(),
    };
    let mut combined = result;
    for step in 0..REACTION_PREFERENCE_CHAIN_LIMIT {
        let after = chain.raw();
        let window = sk_core::game::combat(after).get("reaction_window").filter(|value| js::truthy(Some(value))).cloned();
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
        let normalized = chain.normalized()?.clone();
        let answer = match resolve_with_pauses_inner(&Value::Object(follow_up), StateIn { raw: chain.raw(), normalized: &normalized }, dice, &context, &mut *uuid) {
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
        drop(normalized);
        for event in &answer_events {
            chain.apply(event)?;
        }
        combined.events.extend(answer_events);
        combined.rolls.extend(answer.rolls);
    }
    Ok(combined)
}

/// Итог плана: `{ commands, events, rolls, state }` и ожидание, на котором
/// план встал.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlan {
    pub commands: Vec<Value>,
    pub events: Vec<Value>,
    pub rolls: Vec<Value>,
    pub state: Value,
    /// Окно, которое план открыл и оставил открытым (в JSON плана не входит).
    pub pending: Option<Prompt>,
}

/// `resolveCommands(commands, initialState, options)`: команды плана одна за
/// другой над состоянием после предыдущих; план встаёт на новом окне реакции.
pub fn resolve_commands(commands: &[Value], initial_state: &Value, dice: &mut dyn RulesDice, context: &Context, stop_attack_after_movement: bool, uuid: Uuid<'_>) -> Result<ResolvedPlan, Halt> {
    let normalized = NormalizedState::normalize(initial_state)?;
    top_level(resolve_plan_inner(commands, normalized, dice, context, stop_attack_after_movement, uuid))
}

/// [`resolve_commands`] над нормализованным состоянием.
pub fn resolve_commands_normalized(commands: &[Value], initial_state: &NormalizedState, dice: &mut dyn RulesDice, context: &Context, stop_attack_after_movement: bool, uuid: Uuid<'_>) -> Result<ResolvedPlan, Halt> {
    let normalized = initial_state.in_ambient_mode()?.into_owned();
    top_level(resolve_plan_inner(commands, normalized, dice, context, stop_attack_after_movement, uuid))
}

/// Состояние плана — цепочка событий: шаги читают сырой итог событий
/// (`state = applyGameEvent(state, event)`), разбор шага получает его
/// нормализацию, посчитанную один раз.
fn resolve_plan_inner(commands: &[Value], initial_state: NormalizedState, dice: &mut dyn RulesDice, context: &Context, stop_attack_after_movement: bool, uuid: Uuid<'_>) -> Result<ResolvedPlan, Interrupt> {
    let mut chain = EventChain::new(initial_state);
    let mut all_events: Vec<Value> = Vec::new();
    let mut all_rolls: Vec<Value> = Vec::new();
    let mut validated: Vec<Value> = Vec::new();
    for (index, item) in commands.iter().enumerate() {
        let explicit = js::present(item.get("expected_state_version")) || js::present(item.get("expectedStateVersion"));
        let expected = if index == 0 && explicit {
            crate::core::coalesce(&[item.get("expected_state_version")]).or_else(|| item.get("expectedStateVersion")).cloned().unwrap_or(Value::Null)
        } else {
            chain.raw().get("state_version").cloned().unwrap_or(Value::Null)
        };
        let failed_swing = all_events.iter().any(|event| event_type(event) == "SwingResolved" && js::is_false(event.get("payload").and_then(|payload| payload.get("success"))));
        let item_type = item.get("command_type").and_then(Value::as_str);
        if failed_swing && item_type == Some("MakeAttack") {
            break;
        }
        let input = command_with(item, "expected_state_version", expected);
        if stop_attack_after_movement && item_type == Some("MakeAttack") && validated.iter().any(|entry| entry.get("command_type").and_then(Value::as_str) == Some("MoveActor")) {
            let normalized = chain.normalized()?;
            match validate_state(&input, normalized, context, &mut *uuid) {
                Ok(_) => {}
                Err(halt) if halt.is_rule() => break,
                Err(halt) => return Err(halt.into()),
            }
        }
        let window_before = js::s(sk_core::game::combat(chain.raw()).get("reaction_window").and_then(|window| window.get("id")));
        let resolve_span = sk_store::perf::span("rules.resolve_command");
        let result = {
            let normalized = chain.normalized()?.clone();
            resolve_command_inner_state(&input, StateIn { raw: chain.raw(), normalized: &normalized }, dice, context, &mut *uuid)?
        };
        drop(resolve_span);
        validated.push(result.command.clone());
        for event in &result.events {
            let _apply_span = sk_store::perf::span("rules.apply_game_event");
            chain.apply(event)?;
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
            let placement_state = chain.normalized()?;
            let placements: Vec<Value> = sk_npc_world::npc_positioning::plan_scene_npc_placement_events(placement_state)
                .into_iter()
                .filter(|draft| event_type(draft) == "NpcPlaced" && created.contains(&js::s(draft.get("payload").and_then(|payload| payload.get("npc_id")))))
                .collect();
            for placement in crate::core::npc_world_events_from(&result.command, &Value::Array(placements)) {
                chain.apply(&placement)?;
                all_events.push(placement);
            }
        }
        all_rolls.extend(result.rolls);
        let paused = sk_core::game::combat(chain.raw()).get("reaction_window").filter(|window| js::truthy(Some(window)));
        if let Some(paused) = paused {
            let pending = js::truthy(paused.get("pending_command")) || js::truthy(paused.get("pending_spell_command"));
            if pending && js::s(paused.get("id")) != window_before {
                break;
            }
        }
    }
    let pending = prompt_after(&all_events, chain.raw());
    Ok(ResolvedPlan { commands: validated, events: all_events, rolls: all_rolls, state: chain.into_raw(), pending })
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

    /// [`Self::validate`] над нормализованным состоянием.
    pub fn validate_normalized(&mut self, command: &Value, state: &NormalizedState, context: &Context) -> Result<Value, Halt> {
        let ambient = state.in_ambient_mode()?;
        crate::validate::validate_normalized(command, ambient.value(), context, &mut *self.uuid)
    }

    /// `resolve(command, state, context)`.
    pub fn resolve(&mut self, command: &Value, state: &Value, context: &Context) -> Result<Outcome, Halt> {
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

    /// [`Self::resolve_plan`] над нормализованным состоянием.
    pub fn resolve_plan_normalized(&mut self, plan: &Value, state: &NormalizedState, context: &Context) -> Result<ResolvedPlan, Halt> {
        let commands = match crate::core::coalesce(&[plan.get("proposed_commands")]).or_else(|| crate::core::coalesce(&[plan.get("commands")])) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let stop = matches!(plan.get("maneuver").and_then(Value::as_str), Some("approach_attack" | "long_jump_attack" | "swing_attack"));
        resolve_commands_normalized(&commands, state, &mut *self.dice, context, stop, &mut *self.uuid)
    }

    /// `authorizeDirectorIntent(intent, state)`.
    pub fn authorize_director_intent(&self, intent: &Value, state: &Value) -> Result<Value, Halt> {
        let normalized = NormalizedState::normalize(state)?;
        sk_story::campaign_loop_policy::authorize_director_intent(&normalized, Some(intent), None).map_err(|error| {
            Halt::Fault(crate::pause::Fault::new(sk_world_story::autonomous_campaign::DirectorIntentError::NAME, error.message).with_code(error.code))
        })
    }
}
