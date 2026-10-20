//! Возобновление пауз в `UseCombatAction` (`resolvePendingCommand` и его
//! пять замыканий). Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 15345–15717.
//!
//! Окно реакции (`ReactionWindowOpened`) хранит остановленную команду
//! (`pending_command` или `pending_spell_command`), стенограмму её костей
//! (`pending_dice_transcript`), флаги исполнения (`pending_execution`) и уже
//! сделанные выборы реакций (`resistance_choices`, `elemental_damage_choices`,
//! `protective_reaction_choices`). Ответ на окно закрывает его, при нужде
//! оплачивает реакцию и разбирает сохранённую команду заново над состоянием
//! после ответа: кости повторяются по стенограмме (мягкий повтор
//! [`Replay`]: сверяется только метод, сверх записанного — новые броски),
//! а выбор передаётся контекстом. Новая пауза внутри продолжения несёт
//! префиксом всё, что ответ уже успел записать.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::{api, Resolve, Resolved};
use crate::command::rules::rule_ids;
use crate::context::Context;
use crate::core::{command_with, command_with_rules, event_from, resource_pool, spread_value};
use crate::dice_record::{roll_indomitable_replacement, Replay};
use crate::pause::{resistance_choice_mode, Fault, Halt, Step};
use crate::replay::apply_game_event;

pub(super) fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `events.reduce(applyGameEvent, state)`.
pub(super) fn reduce_events(state: &Value, events: &[Value]) -> Result<Value, Halt> {
    let mut current = state.clone();
    for event in events {
        current = apply_game_event(&current, event)?;
    }
    Ok(current)
}

/// `{ ...clone(command), expected_state_version: state.state_version }`
/// (`undefined` держит место ключа, но в JSON не попадает).
pub(super) fn with_expected_version(command: &Value, state: &Value) -> Value {
    let mut map = spread_value(Some(command));
    match state.get("state_version") {
        Some(version) => {
            map.insert("expected_state_version".into(), version.clone());
        }
        None => {
            map.shift_remove("expected_state_version");
        }
    }
    Value::Object(map)
}

/// `{ rulesetId: state.ruleset_id }`.
pub(super) fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

/// Как кости идут в продолжение.
pub(super) enum PendingDice {
    /// Кости этой команды (с её стенограммой).
    Direct,
    /// `replayDiceService(diceService, transcript, replacements, { allowAdditionalRolls })`.
    Replay { transcript: Vec<Value>, replacements: Option<Value>, allow_additional_rolls: bool },
}

/// Общее для ответа на окно: окно, контекст продолжения и пометка автоотказа.
pub struct Resume {
    /// `reactionWindow = command.reaction_window ?? state.mechanics.combat.reaction_window`.
    pub window: Option<Value>,
    /// `resumeContext`: полномочие сохранённой команды, а не отвечающего игрока.
    pub context: Context,
    /// `automaticDeclinePayload`: отказ по таймеру хода или по предпочтению.
    pub automatic_decline: Map<String, Value>,
}

impl Resume {
    /// Подготовка ветки `UseCombatAction` (15345–15377).
    pub fn new(r: &Resolve<'_>) -> Self {
        let command = &r.command;
        let window = crate::core::coalesce(&[command.get("reaction_window")]).or_else(|| sk_core::game::combat(&r.state).get("reaction_window")).cloned();
        let window_ref = window.as_ref();
        let pending = crate::core::coalesce(&[at(window_ref, "pending_command")]).or_else(|| at(window_ref, "pending_spell_command"));
        let pending_actor = at(pending, "actor_id");
        let execution = at(window_ref, "pending_execution").filter(|execution| at(Some(execution), "schema_version").and_then(Value::as_f64) == Some(1.0));
        let mut context = r.context.clone();
        context.set("isAdmin", Value::Bool(true));
        context.set("serverAuthoritativeCombat", Value::Bool(true));
        context.set("readiedRelease", Value::Bool(js::is_true(at(execution, "readied_release"))));
        context.set("additionalBeam", Value::Bool(js::is_true(at(execution, "additional_beam"))));
        context.set("reactionResolution", Value::Bool(js::is_true(at(execution, "reaction_resolution"))));
        match at(execution, "finalize_flee_actor_id") {
            Some(value) => context.set("finalizeFleeActorId", value.clone()),
            None => {
                context.fields.shift_remove("finalizeFleeActorId");
            }
        }
        if js::truthy(pending_actor) && sk_core::game::is_enemy_actor(&r.state, &js::string(pending_actor)) {
            context.set("isNpcScheduler", Value::Bool(true));
        }
        let mut automatic_decline = Map::new();
        let reason = js::s(command.get("auto_skip_reason"));
        if command.get("action_id").and_then(Value::as_str) == Some("decline-reaction")
            && js::is_true(command.get("server_authoritative"))
            && r.context.server_authoritative_combat()
            && matches!(reason.as_str(), "turn-timeout" | "reaction-preference")
        {
            automatic_decline.insert("auto_declined".into(), Value::Bool(true));
            automatic_decline.insert("auto_decline_reason".into(), Value::String(reason));
        }
        Self { window, context, automatic_decline }
    }

    fn window(&self) -> Option<&Value> {
        self.window.as_ref()
    }

    fn field(&self, key: &str) -> Option<&Value> {
        at(self.window(), key)
    }

    fn trigger_is(&self, trigger: &str) -> bool {
        self.field("trigger").and_then(Value::as_str) == Some(trigger)
    }

    /// `Array.isArray(window[key]) ? window[key] : context[contextKey]`.
    fn choices_or_context(&self, r: &Resolve<'_>, key: &str, context_key: &str, context: &mut Context) {
        match self.field(key) {
            Some(value @ Value::Array(_)) => context.set(context_key, value.clone()),
            _ => match r.context.get(context_key) {
                Some(value) => context.set(context_key, value.clone()),
                None => {
                    context.fields.shift_remove(context_key);
                }
            },
        }
    }

    /// Стенограмма костей окна (`Array.isArray(...) ? ... : []`).
    fn transcript(&self) -> Vec<Value> {
        match self.field("pending_dice_transcript") {
            Some(Value::Array(entries)) => entries.clone(),
            _ => Vec::new(),
        }
    }

    fn closed_event(&self, source: &Value, payload: Map<String, Value>, actor: &Value) -> Value {
        event_from(source, "ReactionWindowClosed", Some(Value::Object(payload)), Some(&json!([actor])))
    }

    fn with_automatic_decline(&self, mut payload: Map<String, Value>) -> Map<String, Value> {
        for (key, value) in &self.automatic_decline {
            payload.insert(key.clone(), value.clone());
        }
        payload
    }
}

/// `resolvePendingCommand(pendingCommand, resumedState, options)`: пауза
/// внутри продолжения несёт префиксом события и броски этого ответа.
pub(super) fn resolve_pending(r: &mut Resolve<'_>, command: &Value, state: &Value, dice: PendingDice, context: &Context) -> Result<Resolved, Halt> {
    let result = match dice {
        PendingDice::Direct => api::resolve_command(command, state, &mut r.dice, context, &mut *r.uuid),
        PendingDice::Replay { transcript, replacements, allow_additional_rolls } => {
            let mut replay = Replay::new(&mut r.dice, transcript, replacements.as_ref(), allow_additional_rolls);
            api::resolve_command(command, state, &mut replay, context, &mut *r.uuid)
        }
    };
    match result {
        Err(Halt::Pause(mut pause)) => {
            let mut prefix = r.events.clone();
            prefix.append(&mut pause.prefix_events);
            pause.prefix_events = prefix;
            let mut rolls = r.rolls.clone();
            rolls.append(&mut pause.prefix_rolls);
            pause.prefix_rolls = rolls;
            Err(Halt::Pause(pause))
        }
        other => other,
    }
}

/// Итог продолжения — в события и броски ответа.
fn absorb(r: &mut Resolve<'_>, result: Resolved) {
    r.events.extend(result.events);
    r.rolls.extend(result.rolls);
    r.nested_consequences_resolved = true;
}

/// `Object.fromEntries(list.map((entry) => [String(entry?.[keyField] ?? ''), record(entry)]).filter(([key]) => key))`.
fn previous_choices(list: Option<&Value>, key_field: &str, record: impl Fn(&Value) -> Value) -> Map<String, Value> {
    let mut choices = Map::new();
    let Some(Value::Array(entries)) = list else { return choices };
    for entry in entries {
        let key = js::s(at(Some(entry), key_field));
        let value = record(entry);
        if !key.is_empty() {
            choices.insert(key, value);
        }
    }
    choices
}

/// `{ ...(entry ?? {}), [field]: value }`.
fn entry_with(entry: &Value, field: &str, value: Value) -> Value {
    let mut map = spread_value(Some(entry).filter(|entry| !entry.is_null()));
    map.insert(field.into(), value);
    Value::Object(map)
}

/// `Object.values(object)` в порядке JS.
fn object_values(map: &Map<String, Value>) -> Vec<Value> {
    js::entries(map).into_iter().map(|(_, value)| value.clone()).collect()
}

/// `resumePendingSpell()` (15377–15392): отказ от контрзаклинания —
/// сохранённое заклинание творится дальше.
pub(super) fn resume_pending_spell(r: &mut Resolve<'_>, resume: &Resume) -> Step {
    let Some(pending) = resume.field("pending_spell_command").filter(|value| js::truthy(Some(value))).cloned() else { return Ok(()) };
    let resumed = reduce_events(&r.state, &r.events)?;
    let command = with_expected_version(&command_with(&pending, "counterspell_bypassed", Value::Bool(true)), &resumed);
    let result = resolve_pending(r, &command, &resumed, PendingDice::Direct, &resume.context)?;
    absorb(r, result);
    Ok(())
}

/// `resumePendingElementalDamage(useAbsorb, absorbAction)` (15393–15467).
pub(super) fn resume_pending_elemental_damage(r: &mut Resolve<'_>, resume: &Resume, use_absorb: bool, absorb_action: Option<&Value>) -> Step {
    if !resume.trigger_is("spell-area-damage") || !js::truthy(resume.field("pending_command")) || !js::truthy(resume.field("pending_elemental_damage")) {
        return Ok(());
    }
    let pending_damage = resume.field("pending_elemental_damage").cloned().unwrap_or(Value::Null);
    let previous = previous_choices(resume.field("elemental_damage_choices"), "damage_key", |entry| entry_with(entry, "use", Value::Bool(js::is_true(at(Some(entry), "use")))));
    let damage_key = js::string(pending_damage.get("damage_key"));
    let target_id = js::string(pending_damage.get("target_id"));
    let mut choice = Map::new();
    choice.insert("damage_key".into(), Value::String(damage_key.clone()));
    choice.insert("target_id".into(), Value::String(target_id.clone()));
    choice.insert("use".into(), Value::Bool(use_absorb));
    if let Some(resource) = at(absorb_action, "resource").filter(|value| js::truthy(Some(value))) {
        choice.insert("resource".into(), resource.clone());
    }
    if let Some(spell) = at(absorb_action, "spell").filter(|value| js::truthy(Some(value))) {
        if let Some(level) = crate::core::coalesce(&[spell.get("reactionSlotLevel")]).or_else(|| spell.get("level")) {
            choice.insert("slot_level".into(), level.clone());
        }
    }
    if let Some(damage_type) = at(resume.field("damage"), "damage_type").filter(|value| js::truthy(Some(value))) {
        choice.insert("damage_type".into(), damage_type.clone());
    }
    let mut choices = previous.clone();
    choices.insert(damage_key.clone(), Value::Object(choice));
    // Старые окна могли потерять оплату предыдущей реакции: новая фаза
    // сохраняет её сразу, а потраченную реакцию повторно не оплачивает.
    let mut reconstructed: Vec<String> = Vec::new();
    for choice in object_values(&previous) {
        if !js::is_true(at(Some(&choice), "use")) || reconstructed.contains(&js::s(at(Some(&choice), "target_id"))) {
            continue;
        }
        let previous_target = js::s(at(Some(&choice), "target_id"));
        let economy = sk_core::game::combat(&r.state).get("action_economy").and_then(|economy| economy.get(&previous_target));
        if previous_target.is_empty() || at(economy, "reaction") == Some(&Value::Bool(false)) {
            continue;
        }
        let previous_actor = sk_core::game::find_actor(&r.state, &previous_target);
        let options = ruleset_options(&r.state);
        let previous_spell = sk_combat_content::combat_spells::combat_spell_for(previous_actor, Some(&Value::String("absorb-elements".into())), Some(&options));
        let Some(previous_spell) = previous_spell.filter(|_| previous_actor.is_some()) else { continue };
        if reconstructed.contains(&previous_target) {
            continue;
        }
        let resource = js::s(crate::core::coalesce(&[at(Some(&choice), "resource")]).or_else(|| previous_spell.get("slotResource")));
        let reactor_command = command_with(&r.command, "actor_id", Value::String(previous_target.clone()));
        if !resource.is_empty() {
            let pool = resource_pool(&r.state, &previous_target, &resource, 0);
            if pool.current > 0 {
                let payload = json!({ "resource": resource, "amount": 1, "before": pool.current, "after": pool.current - 1, "max": pool.max });
                r.events.push(event_from(&command_with_rules(&reactor_command, &[rule_ids::RESOURCE]), "ResourceSpent", Some(payload), Some(&json!([previous_target]))));
            }
        }
        let mut payload = Map::new();
        payload.insert("action_id".into(), Value::String("cast:absorb-elements".into()));
        if let Some(name) = previous_spell.get("name") {
            payload.insert("name".into(), name.clone());
        }
        payload.insert("category".into(), Value::String("spell".into()));
        payload.insert("action_type".into(), Value::String("reaction".into()));
        if sk_core::game::uses_2014(&r.state) {
            payload.insert("spellcasting_2014_version".into(), Value::from(1));
        }
        if let Some(id) = resume.field("id") {
            payload.insert("reaction_window_id".into(), id.clone());
        }
        payload.insert("reconstructed_reaction".into(), Value::Bool(true));
        r.events.push(event_from(&reactor_command, "CombatActionUsed", Some(Value::Object(payload)), Some(&json!([previous_target]))));
        reconstructed.push(previous_target);
    }
    let mut closed = Map::new();
    if let Some(id) = resume.field("id") {
        closed.insert("id".into(), id.clone());
    }
    closed.insert("accepted".into(), Value::Bool(use_absorb));
    closed.insert("action_id".into(), Value::String(if use_absorb { "cast:absorb-elements" } else { "decline-reaction" }.into()));
    let closed = resume.with_automatic_decline(closed);
    let actor = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let event = resume.closed_event(&r.command_with_rules(&[rule_ids::REACTION]), closed, &actor);
    r.events.push(event);
    let resumed = reduce_events(&r.state, &r.events)?;
    let command = with_expected_version(resume.field("pending_command").unwrap_or(&Value::Null), &resumed);
    let mut context = resume.context.clone();
    context.set("elementalDamageChoice", json!({ "target_id": target_id, "damage_key": damage_key, "use": use_absorb }));
    context.set("elementalDamageChoices", Value::Object(choices));
    resume.choices_or_context(r, "resistance_choices", "resistanceChoices", &mut context);
    resume.choices_or_context(r, "protective_reaction_choices", "protectiveReactionChoices", &mut context);
    let dice = PendingDice::Replay { transcript: resume.transcript(), replacements: None, allow_additional_rolls: true };
    let result = resolve_pending(r, &command, &resumed, dice, &context)?;
    absorb(r, result);
    Ok(())
}

/// `resumePendingProtectiveReaction(useProtection, protectionAction)` (15468–15524).
pub(super) fn resume_pending_protective_reaction(r: &mut Resolve<'_>, resume: &Resume, use_protection: bool, protection_action: Option<&Value>) -> Step {
    if !js::truthy(resume.field("pending_command")) || !js::truthy(resume.field("pending_protective_reaction")) {
        return Ok(());
    }
    let pending = resume.field("pending_protective_reaction").cloned().unwrap_or(Value::Null);
    let key = match pending.get("key").filter(|value| !value.is_null()) {
        Some(key) => js::string(Some(key)),
        None => format!("{}:{}", js::string(pending.get("kind")), js::string(pending.get("target_id"))),
    };
    let action_id = at(protection_action, "id");
    let selected_kind = match action_id.and_then(Value::as_str) {
        Some("cast:shield") => "shield".to_string(),
        Some("uncanny-dodge") => "uncanny-dodge".to_string(),
        Some("cast:absorb-elements") => "absorb-elements".to_string(),
        _ => js::string(pending.get("kind")),
    };
    let previous = previous_choices(resume.field("protective_reaction_choices"), "key", |entry| entry_with(entry, "use", Value::Bool(js::is_true(at(Some(entry), "use")))));
    let mut choice = Map::new();
    choice.insert("key".into(), Value::String(key.clone()));
    choice.insert("kind".into(), Value::String(selected_kind));
    choice.insert("action_id".into(), crate::core::coalesce(&[action_id]).cloned().unwrap_or(Value::Null));
    choice.insert("target_id".into(), Value::String(js::string(pending.get("target_id"))));
    choice.insert("reactor_id".into(), Value::String(js::string(r.command.get("actor_id"))));
    choice.insert("use".into(), Value::Bool(use_protection));
    if let Some(damage_type) = at(resume.field("damage"), "damage_type") {
        choice.insert("damage_type".into(), damage_type.clone());
    }
    let spell = at(protection_action, "spell");
    if let Some(level) = crate::core::coalesce(&[at(spell, "reactionSlotLevel")]).or_else(|| at(spell, "level")) {
        choice.insert("slot_level".into(), level.clone());
    }
    let choice = Value::Object(choice);
    let mut choices = previous;
    choices.insert(key.clone(), choice.clone());
    let mut closed = Map::new();
    if let Some(id) = resume.field("id") {
        closed.insert("id".into(), id.clone());
    }
    closed.insert("accepted".into(), Value::Bool(use_protection));
    let closed_action = if use_protection { r.command.get("action_id").cloned() } else { Some(Value::String("decline-reaction".into())) };
    if let Some(closed_action) = closed_action {
        closed.insert("action_id".into(), closed_action);
    }
    let closed = resume.with_automatic_decline(closed);
    let actor = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let event = resume.closed_event(&r.command_with_rules(&[rule_ids::REACTION]), closed, &actor);
    r.events.push(event);
    let resumed = reduce_events(&r.state, &r.events)?;
    let command = with_expected_version(resume.field("pending_command").unwrap_or(&Value::Null), &resumed);
    let mut context = resume.context.clone();
    let stored = choices.get(&key).cloned().unwrap_or(choice);
    context.set("protectiveReactionChoice", entry_with(&stored, "key", Value::String(key)));
    context.set("protectiveReactionChoices", Value::Object(choices));
    resume.choices_or_context(r, "resistance_choices", "resistanceChoices", &mut context);
    resume.choices_or_context(r, "elemental_damage_choices", "elementalDamageChoices", &mut context);
    let dice = PendingDice::Replay { transcript: resume.transcript(), replacements: None, allow_additional_rolls: true };
    let result = resolve_pending(r, &command, &resumed, dice, &context)?;
    absorb(r, result);
    Ok(())
}

/// Действие выбора Сопротивления: `roll-first-resistance`, `use-resistance`,
/// `skip-resistance`.
fn resistance_action(mode: &str, accepted: bool) -> (&'static str, &'static str) {
    if mode == "after" {
        ("roll-first-resistance", "Сначала бросить")
    } else if accepted {
        ("use-resistance", "Использовать Сопротивление")
    } else {
        ("skip-resistance", "Без бонуса")
    }
}

/// `resumeResistanceChoice(choiceMode)` (15525–15591).
pub(super) fn resume_resistance_choice(r: &mut Resolve<'_>, resume: &Resume, choice_mode: &str) -> Step {
    if !resume.trigger_is("saving-throw-bonus-choice") || !js::truthy(resume.field("pending_command")) || !js::truthy(resume.field("pending_resistance_choice")) {
        return Ok(());
    }
    let pending = resume.field("pending_resistance_choice").cloned().unwrap_or(Value::Null);
    let mode = resistance_choice_mode(Some(&Value::String(choice_mode.into())));
    let accepted = mode == "before-roll" || mode == "after-use";
    let previous = previous_choices(resume.field("resistance_choices"), "save_key", |entry| entry_with(entry, "mode", Value::String(resistance_choice_mode(Some(entry)))));
    let save_key = js::string(pending.get("save_key"));
    let mut choices = previous;
    choices.insert(save_key.clone(), json!({ "save_key": save_key, "mode": mode, "use": mode == "before-roll" }));
    let (action_id, name) = resistance_action(&mode, accepted);
    let mut closed = Map::new();
    if let Some(id) = resume.field("id") {
        closed.insert("id".into(), id.clone());
    }
    closed.insert("accepted".into(), Value::Bool(accepted));
    closed.insert("free_choice".into(), Value::Bool(true));
    closed.insert("action_id".into(), Value::String(action_id.into()));
    let closed = resume.with_automatic_decline(closed);
    let actor = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let event = resume.closed_event(&r.command_with_rules(&[rule_ids::RESISTANCE, rule_ids::SAVING_THROW]), closed, &actor);
    r.events.push(event);
    let mut used = Map::new();
    used.insert("action_id".into(), Value::String(action_id.into()));
    used.insert("name".into(), Value::String(name.into()));
    used.insert("category".into(), Value::String("spell".into()));
    used.insert("action_type".into(), Value::String("free".into()));
    used.insert("saving_throw_bonus_choice".into(), Value::Bool(true));
    used.insert("free_choice".into(), Value::Bool(true));
    if let Some(id) = resume.field("id") {
        used.insert("reaction_window_id".into(), id.clone());
    }
    used.insert("resistance_used".into(), Value::Bool(accepted));
    r.events.push(event_from(&r.command, "CombatActionUsed", Some(Value::Object(used)), Some(&json!([actor]))));
    let resumed = reduce_events(&r.state, &r.events)?;
    let command = with_expected_version(resume.field("pending_command").unwrap_or(&Value::Null), &resumed);
    let mut context = resume.context.clone();
    context.set("resistanceResume", Value::Bool(true));
    context.set("resistanceChoice", json!({ "target_id": js::string(pending.get("target_id")), "save_key": save_key, "use": mode }));
    context.set("resistanceChoices", Value::Object(choices));
    resume.choices_or_context(r, "elemental_damage_choices", "elementalDamageChoices", &mut context);
    resume.choices_or_context(r, "protective_reaction_choices", "protectiveReactionChoices", &mut context);
    let dice = PendingDice::Replay { transcript: resume.transcript(), replacements: None, allow_additional_rolls: true };
    let result = resolve_pending(r, &command, &resumed, dice, &context)?;
    absorb(r, result);
    Ok(())
}

/// `resolveIndomitableChoice(accepted)` (15592–15695): Несгибаемый — переброс
/// проваленного спасброска; очередь окон для следующих воинов.
pub(super) fn resolve_indomitable_choice(r: &mut Resolve<'_>, resume: &Resume, accepted: bool) -> Step {
    if !resume.trigger_is("failed-saving-throw") || !js::truthy(resume.field("pending_command")) || !matches!(resume.field("pending_dice_transcript"), Some(Value::Array(_))) {
        return Ok(());
    }
    let uses_2014 = sk_core::game::uses_2014(&r.state);
    let actor = sk_core::game::find_actor(&r.state, &js::s(r.command.get("actor_id")));
    let fallback = if uses_2014 { 0 } else { js::safe_int(resume.field("fighter_level"), js::safe_int(at(actor, "level"), 9)) };
    let bonus = js::safe_int(resume.field("indomitable_bonus"), fallback).max(0);
    let failed_roll_id = js::s(resume.field("failed_roll_id"));
    let transcript = resume.transcript();
    let rerolled = if accepted { Some(roll_indomitable_replacement(&mut r.dice, &transcript, Some(&Value::String(failed_roll_id.clone())), Some(&Value::from(bonus)))?) } else { None };
    let mut decisions: Vec<Value> = match resume.field("indomitable_decisions") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let mut decision = Map::new();
    if let Some(actor_id) = r.command.get("actor_id") {
        decision.insert("actor_id".into(), actor_id.clone());
    }
    decision.insert("accepted".into(), Value::Bool(accepted));
    decision.insert("roll_id".into(), Value::String(failed_roll_id));
    decision.insert("bonus".into(), Value::from(bonus));
    decision.insert("original_total".into(), Value::from(js::safe_int(at(resume.field("trigger_roll"), "total"), 0)));
    if let Some(rerolled) = &rerolled {
        decision.insert("result".into(), rerolled.clone());
    }
    decisions.push(Value::Object(decision));
    let queue: Vec<Value> = match resume.field("pending_indomitable_queue") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let mut closed = Map::new();
    if let Some(id) = resume.field("id") {
        closed.insert("id".into(), id.clone());
    }
    closed.insert("accepted".into(), Value::Bool(accepted));
    if accepted {
        closed.insert("action_id".into(), Value::String("indomitable".into()));
    }
    closed.insert("deferred".into(), Value::Bool(!queue.is_empty()));
    let closed = resume.with_automatic_decline(closed);
    let actor_value = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let event = resume.closed_event(&r.command_with_rules(&[rule_ids::REACTION, rule_ids::INDOMITABLE]), closed, &actor_value);
    r.events.push(event);
    if let Some(next) = queue.first() {
        if next.is_null() {
            return Err(Fault::type_error("Cannot read properties of null (reading 'failed_event')").into());
        }
        let failed_event = crate::core::coalesce(&[next.get("failed_event")]).cloned().unwrap_or_else(js::obj);
        let failed = crate::core::coalesce(&[at(Some(&failed_event), "payload")]).cloned().unwrap_or_else(js::obj);
        let next_level = js::safe_int(next.get("fighter_level"), 9).max(9);
        let next_bonus = js::safe_int(next.get("indomitable_bonus"), if uses_2014 { 0 } else { next_level }).max(0);
        let death = at(Some(&failed_event), "event_type").and_then(Value::as_str) == Some("DeathSavingThrowRolled");
        let next_target = js::string(next.get("target_id"));
        let pending_command_id = crate::core::coalesce(&[at(resume.field("pending_command"), "command_id")]).or_else(|| r.command.get("command_id"));
        let mut payload = spread_value(resume.window());
        payload.insert("id".into(), Value::String(format!("indomitable:{}:{next_target}", js::string(pending_command_id))));
        payload.insert("actor_id".into(), Value::String(next_target.clone()));
        payload.insert("target_id".into(), Value::String(next_target.clone()));
        payload.insert("action_ids".into(), json!(["indomitable"]));
        let description = if next_bonus > 0 { format!("Перебросить спасбросок с бонусом +{next_bonus}. Новый результат обязателен.") } else { "Перебросить проваленный спасбросок. Новый результат обязателен.".to_string() };
        payload.insert("action_options".into(), json!([{ "id": "indomitable", "name": "Несгибаемый", "resource": "indomitable", "cost": 1, "description": description }]));
        let kept = crate::core::coalesce(&[at(Some(&failed), "kept")]).or_else(|| at(Some(&failed), "natural_roll"));
        let ability = match at(Some(&failed), "ability").filter(|value| !value.is_null()) {
            Some(ability) => js::string(Some(ability)),
            None => if death { "death".into() } else { String::new() },
        };
        payload.insert(
            "trigger_roll".into(),
            json!({
                "kept": js::safe_int(kept, 0),
                "modifier": js::safe_int(at(Some(&failed), "modifier"), 0),
                "total": js::safe_int(at(Some(&failed), "total"), 0),
                "difficulty": js::safe_int(at(Some(&failed), "difficulty"), if death { 10 } else { 0 }),
                "ability": ability,
                "save_event_type": js::s(at(Some(&failed_event), "event_type")),
            }),
        );
        payload.insert("failed_roll_id".into(), Value::String(js::s(at(Some(&failed), "roll_id"))));
        payload.insert("fighter_level".into(), Value::from(next_level));
        payload.insert("indomitable_bonus".into(), Value::from(next_bonus));
        payload.insert("pending_indomitable_queue".into(), Value::Array(queue[1..].to_vec()));
        payload.insert("indomitable_decisions".into(), Value::Array(decisions));
        let source = r.command_with_rules(&[rule_ids::SAVING_THROW, rule_ids::INDOMITABLE]);
        r.events.push(event_from(&source, "ReactionWindowOpened", Some(Value::Object(payload)), Some(&json!([next_target]))));
        if let Some(rerolled) = rerolled {
            r.rolls.push(rerolled);
        }
        return Ok(());
    }
    let accepted_decisions: Vec<&Value> = decisions.iter().filter(|decision| js::is_true(decision.get("accepted"))).collect();
    for decision in &accepted_decisions {
        let decision_actor = js::string(decision.get("actor_id"));
        let source = command_with_rules(&command_with(&r.command, "actor_id", Value::String(decision_actor.clone())), &[rule_ids::RESOURCE, rule_ids::INDOMITABLE]);
        let pool = resource_pool(&r.state, &decision_actor, "indomitable", 1);
        r.events.push(event_from(&source, "ResourceSpent", Some(json!({ "resource": "indomitable", "amount": 1, "before": pool.current, "after": pool.current - 1, "max": pool.max })), Some(&json!([decision_actor]))));
        let bonus = js::safe_int(decision.get("bonus"), 0).max(0);
        let mut used = Map::new();
        used.insert("action_id".into(), Value::String("indomitable".into()));
        used.insert("name".into(), Value::String("Несгибаемый".into()));
        used.insert("category".into(), Value::String("class".into()));
        used.insert("action_type".into(), Value::String("free".into()));
        if let Some(id) = resume.field("id") {
            used.insert("reaction_window_id".into(), id.clone());
        }
        used.insert("original_total".into(), Value::from(js::safe_int(decision.get("original_total"), 0)));
        used.insert("bonus".into(), Value::from(bonus));
        used.insert("indomitable_bonus".into(), Value::from(bonus));
        r.events.push(event_from(&source, "CombatActionUsed", Some(Value::Object(used)), Some(&json!([decision_actor]))));
    }
    let mut bypass: Vec<String> = Vec::new();
    match r.context.get("indomitable_bypass_actor_ids") {
        Some(Value::Array(items)) => bypass.extend(items.iter().map(|item| js::string(Some(item)))),
        Some(Value::String(text)) => bypass.extend(text.chars().map(|ch| ch.to_string())),
        _ => {}
    }
    bypass.extend(decisions.iter().map(|decision| js::string(decision.get("actor_id"))));
    let mut unique: Vec<String> = Vec::new();
    for id in bypass {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    r.context.set("indomitable_bypass_actor_ids", js::strings_value(unique));
    let resumed = reduce_events(&r.state, &r.events)?;
    let replacements: Vec<Value> = accepted_decisions
        .iter()
        .map(|decision| {
            let mut replacement = Map::new();
            replacement.insert("roll_id".into(), Value::String(js::string(decision.get("roll_id"))));
            replacement.insert("bonus".into(), Value::from(js::safe_int(decision.get("bonus"), 0).max(0)));
            if let Some(result) = decision.get("result") {
                replacement.insert("result".into(), result.clone());
            }
            Value::Object(replacement)
        })
        .collect();
    let command = with_expected_version(resume.field("pending_command").unwrap_or(&Value::Null), &resumed);
    let mut context = resume.context.clone();
    context.set("indomitableResume", Value::Bool(true));
    let dice = PendingDice::Replay { transcript, replacements: Some(Value::Array(replacements)), allow_additional_rolls: false };
    let result = resolve_pending(r, &command, &resumed, dice, &context)?;
    absorb(r, result);
    Ok(())
}
