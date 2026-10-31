//! Разбор команды — `resolveCommandInternal` (`rules-engine.mjs`,
//! 13032–23439). Задача Р0: подготовка (13054–13139), контекст разбора
//! [`Resolve`], диспетчер (`dispatch.rs`).
//!
//! Замыкания JS (13083–13722) — методы [`Resolve`] в `impl`-блоках своих
//! файлов: время мира — `world_time.rs` (Р4), остальное — `kernel.rs` (Р5).
//! Хвост последствий (23156–23461) — `post.rs` (Р5); обёртки
//! `resolveCommand`, `resolveCommandWithPauses`, `resolveCommands` —
//! `api.rs` (Р5); удар-открытие — `opening_strike.rs` (Р5).
//!
//! Владельцы файлов веток — в их шапках (`basic` — Р5, `vitals`, `rest` —
//! Р2, `attack`, `monster` — Р8, `spell/` — Р9, `combat_action`, `resume`,
//! `movement`, `end_turn` — Р10, `combat_lifecycle`, `items`, `objects`,
//! `doors`, `beast_calm`, `stranger` — Р11, `scene`, `campaign`,
//! `character`, `trade`, `scenario` — Р6, `society/` — Р7).

pub mod api;
mod attack;
mod basic;
mod beast_calm;
mod campaign;
mod character;
mod combat_action;
mod combat_lifecycle;
mod dispatch;
mod doors;
mod end_turn;
mod items;
pub mod kernel;
mod monster;
mod movement;
mod objects;
pub mod opening_strike;
pub mod post;
mod rest;
pub mod resume;
pub mod round_time;
mod scenario;
mod scene;
mod society;
pub mod spell;
mod stranger;
mod trade;
pub mod vitals;
pub mod world_time;

pub use dispatch::RESOLVE_LABELS;

use std::sync::Arc;

use serde_json::{json, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;

use crate::command::types::{PARLEY_POLICY_ID, TRUCE_BREAKING_COMMAND_TYPES};
use crate::context::{Context, Uuid};
use crate::core::{coalesce, command_with, event_from, target_for, unique_strings};
use crate::dice_record::{Recording, RulesDice};
use crate::normalized::NormalizedState;
use crate::pause::{resistance_choices_from_context, Interrupt};
use crate::replay::CommandProjector;
use crate::validate::validate_normalized;

/// Итог разбора: `{ command, events, rolls }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub command: Value,
    pub events: Vec<Value>,
    pub rolls: Vec<Value>,
}

/// Контекст разбора — локальные переменные `resolveCommandInternal`, которые
/// в JS видят замыкания и ветки `switch`.
pub struct Resolve<'a> {
    /// `state`: нормализованное состояние до команды (с прокси NPC для
    /// заклинаний). Общее с входом разбора (`Arc`): ветки читают его по
    /// ссылке, а меняют через `Arc::make_mut` — копия только при записи.
    pub state: Arc<Value>,
    /// `command`: проверенная команда (`validateCommand`).
    pub command: Value,
    /// `context` с `__resolve_depth` на единицу больше входного.
    pub context: Context,
    /// `resolveDepth`: глубина до входа (0 — команда верхнего уровня).
    pub depth: i64,
    /// `diceService`: кости с записью стенограммы этой команды.
    pub dice: Recording<'a>,
    /// `randomUUID`.
    pub uuid: Uuid<'a>,
    /// `events`.
    pub events: Vec<Value>,
    /// `rolls`.
    pub rolls: Vec<Value>,
    /// `targetId = targetFor(command)` (сырое значение).
    pub target_id: Value,
    /// `inspirationSpent`: вдохновение барда тратится один раз на владельца.
    pub inspiration_spent: IndexSet<String>,
    /// `resistanceCantripUses`.
    pub resistance_cantrip_uses: IndexSet<String>,
    /// `resistanceChoices`: `save_key → { mode, … }` из контекста продолжения.
    pub resistance_choices: IndexMap<String, Value>,
    /// `resistanceUsedTargets`.
    pub resistance_used_targets: IndexSet<String>,
    /// `resistanceSaveSequence.value`.
    pub resistance_save_sequence: i64,
    /// `elementalReactionChoices`: `damage_key → { use, … }`.
    pub elemental_reaction_choices: IndexMap<String, Value>,
    /// `elementalReactionSequence.value`.
    pub elemental_reaction_sequence: i64,
    /// `protectiveReactionChoices`: `key → { use, … }`.
    pub protective_reaction_choices: IndexMap<String, Value>,
    /// `nestedConsequencesResolved`.
    pub nested_consequences_resolved: bool,
    /// `truceBeforeCommand = truceFor(state)`.
    pub truce_before_command: Option<Value>,
    /// `legendarySpendsInCommand`: легендарные сопротивления этой команды.
    pub legendary_spends_in_command: IndexMap<String, i64>,
    /// `oiledTargets`: цели, у которых масло уже сгорело в этой команде.
    pub oiled_targets: IndexSet<String>,
    /// `projectEvents`: инкрементальный проектор событий команды.
    pub projector: CommandProjector,
}

/// Выборы реакций из контекста: массив `{ [key]: …, use }` или объект
/// `key → выбор` (`elementalDamageChoices`, `protectiveReactionChoices`).
pub fn reaction_choices(raw: Option<&Value>, key_field: &str) -> IndexMap<String, Value> {
    let mut choices = IndexMap::new();
    match raw {
        Some(Value::Array(entries)) => {
            for entry in entries {
                let key = match entry.get(key_field).filter(|value| !value.is_null()) {
                    Some(value) => js::string(Some(value)),
                    None => String::new(),
                };
                let mut record = crate::core::spread_value(Some(entry).filter(|value| !value.is_null()));
                record.insert("use".into(), Value::Bool(js::is_true(entry.get("use"))));
                if !key.is_empty() {
                    choices.insert(key, Value::Object(record));
                }
            }
        }
        Some(value @ Value::Object(_)) => {
            for (key, choice) in crate::pause::object_entries(Some(value)) {
                let record = if matches!(choice, Value::Object(_) | Value::Array(_)) && js::truthy(Some(&choice)) { choice } else { json!({ "use": choice == Value::Bool(true) }) };
                choices.insert(key, record);
            }
        }
        _ => {}
    }
    choices
}

/// Прокси NPC сцены для заклинаний 2014 (13066–13075): видимый NPC без листа
/// в бою получает в расчёте свой стат-блок. События сохраняют id NPC.
/// Первое условие [`push_npc_spell_proxies`] — без копии состояния.
fn may_push_npc_spell_proxies(state: &Value, input: &Value) -> bool {
    input.get("command_type").and_then(Value::as_str) == Some("CastSpell") && sk_core::game::uses_2014(state)
}

fn push_npc_spell_proxies(state: &mut Value, input: &Value) -> Result<bool, Interrupt> {
    if !may_push_npc_spell_proxies(state, input) {
        return Ok(false);
    }
    let options = json!({ "rulesetId": "dnd_5e_2014" });
    let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(input.get("spell_id"), Some(&options));
    if !sk_core::MechanicsSupport::is(spell.as_ref().and_then(|spell| spell.get("mechanicsSupport")), sk_core::MechanicsSupport::Verified) {
        return Ok(false);
    }
    let mut pushed = false;
    let ids = match input.get("target_ids").and_then(Value::as_array).filter(|ids| !ids.is_empty()) {
        Some(_) => unique_strings(input.get("target_ids")),
        None => vec![js::s(input.get("target_id"))],
    };
    for id in ids {
        if sk_core::game::find_actor(state, &id).is_some() {
            continue;
        }
        if let Some(npc) = spell::common::npc_spell_proxy_for(state, &id)? {
            let mut proxy = crate::core::spread_value(Some(&npc));
            proxy.insert("kind".into(), Value::String("npc-spell-proxy".into()));
            js::array_mut(state, "actors").push(Value::Object(proxy));
            pushed = true;
        }
    }
    Ok(pushed)
}

/// Состояние команды над нормализованным входом: рабочая копия (`Resolve.state`)
/// с прокси NPC для заклинаний, проектор и нормализованный вход проверки.
/// Без прокси проектор и проверка берут вход как есть; с прокси изменённая
/// копия нормализуется один раз — её нормализовал бы `validateCommand`.
pub(crate) struct CommandStart {
    pub state: Arc<Value>,
    pub projector: CommandProjector,
    pub proxied: Option<NormalizedState>,
}

pub(crate) fn command_start(normalized: &NormalizedState, input: &Value) -> Result<CommandStart, Interrupt> {
    // Копия входа — только если прокси NPC могут понадобиться; без прокси
    // рабочее состояние — сам вход (общий `Arc`).
    if may_push_npc_spell_proxies(normalized, input) {
        let mut state = normalized.to_value();
        if push_npc_spell_proxies(&mut state, input)? {
            let projector = CommandProjector::new(&state);
            let proxied = NormalizedState::normalize(&state)?;
            return Ok(CommandStart { state: Arc::new(state), projector, proxied: Some(proxied) });
        }
    }
    Ok(CommandStart { state: normalized.shared(), projector: CommandProjector::over(normalized), proxied: None })
}

/// `TruceBroken` для команды, которая бьёт через линию перемирия
/// (13123–13138): `truce` — `truceFor(state)` до команды. Лечение своего под
/// перемирием — не нарушение.
pub fn truce_broken_event(state: &Value, command: &Value, target_id: &Value, truce: &Value) -> Option<Value> {
    if !TRUCE_BREAKING_COMMAND_TYPES.contains(&js::s(command.get("command_type")).as_str()) {
        return None;
    }
    let actor = js::s(command.get("actor_id"));
    let attacker_is_enemy = sk_core::game::is_enemy_actor(state, &actor);
    let victim_id = js::s(Some(target_id));
    let victim_is_enemy = if victim_id.is_empty() { !attacker_is_enemy } else { sk_core::game::is_enemy_actor(state, &victim_id) };
    if attacker_is_enemy == victim_is_enemy {
        return None;
    }
    let round = sk_core::game::combat(state).get("round").cloned();
    let mut payload = serde_json::Map::new();
    payload.insert("broken_by".into(), Value::String(if attacker_is_enemy { "enemies" } else { "party" }.into()));
    payload.insert("actor_id".into(), Value::String(actor.clone()));
    payload.insert("target_id".into(), Value::String(victim_id));
    if let Some(leader) = truce.get("leader_id") {
        payload.insert("leader_id".into(), leader.clone());
    }
    if let Some(name) = truce.get("leader_name") {
        payload.insert("leader_name".into(), name.clone());
    }
    if let Some(round) = round {
        payload.insert("round".into(), round);
    }
    payload.insert("at_minutes".into(), js::num(sk_social::npc_social::campaign_elapsed_minutes(state)));
    payload.insert("policy_id".into(), Value::String(PARLEY_POLICY_ID.into()));
    let targets: Vec<Value> = [truce.get("leader_id").cloned().unwrap_or(Value::Null), Value::String(actor)].into_iter().filter(|value| js::truthy(Some(value))).collect();
    let source = command_with(command, "visibility", Value::String("party".into()));
    Some(event_from(&source, "TruceBroken", Some(Value::Object(payload)), Some(&Value::Array(targets))))
}

/// `resolveCommandInternal(input, rawState, { diceService, context })`.
pub fn resolve_command_internal(input: &Value, raw_state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let normalized = NormalizedState::normalize(raw_state)?;
    resolve_command_internal_state(input, &normalized, dice, context, uuid)
}

/// [`resolve_command_internal`] над нормализованным состоянием.
pub(crate) fn resolve_command_internal_state(input: &Value, normalized: &NormalizedState, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let depth = context.resolve_depth().max(0);
    let context = context.with("__resolve_depth", Value::from(depth + 1));
    let recording = Recording::new(dice);
    let CommandStart { state, projector, proxied } = command_start(normalized, input)?;
    let command = validate_normalized(input, proxied.as_ref().unwrap_or(normalized), &context, &mut *uuid)?;
    let target_id = target_for(&command);
    let resistance_choices = resistance_choices_from_context(context.get("resistanceChoices"));
    let elemental_reaction_choices = reaction_choices(context.get("elementalDamageChoices"), "damage_key");
    let protective_reaction_choices = reaction_choices(context.get("protectiveReactionChoices"), "key");
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
    dispatch::dispatch(&mut r)?;
    post::finish(r)
}

impl Resolve<'_> {
    /// `command.command_type`.
    pub fn command_type(&self) -> String {
        js::s(self.command.get("command_type"))
    }

    /// Цепочка событий от состояния разбора (`state = applyGameEvent(state,
    /// event)` подряд): если `state` — сам нормализованный вход (тот же
    /// `Arc`, что у проектора), первое событие не нормализует его заново, а
    /// замкнутые события не нормализуют итог (Ск5). Итог тот же.
    pub fn state_chain(&self) -> crate::normalized::EventChain {
        match self.projector.normalized_start() {
            Some(start) if start.shares(&self.state) => crate::normalized::EventChain::new(start.clone()),
            _ => crate::normalized::EventChain::from_raw((*self.state).clone()),
        }
    }

    /// [`Self::project_events`] для чтения: общий итог, повтор с теми же
    /// событиями — без пересчёта (`CommandProjector::project_shared`).
    pub fn project_events_shared(&mut self) -> Result<Arc<Value>, Interrupt> {
        Ok(self.projector.project_shared(&self.events)?)
    }

    /// `projectEvents(events)`: состояние после событий команды.
    pub fn project_events(&mut self) -> Result<Value, Interrupt> {
        Ok(self.projector.project(&self.events)?)
    }

    /// Вероломство: удар под перемирием (13114–13139). Разрыв уговора идёт в
    /// журнал **перед** самим ударом.
    fn append_truce_broken(&mut self) {
        let Some(truce) = self.truce_before_command.clone() else { return };
        if let Some(event) = truce_broken_event(&self.state, &self.command, &self.target_id, &truce) {
            self.events.push(event);
        }
    }

    /// `commandWithRules(command, …)` текущей команды.
    pub fn command_with_rules(&self, rules: &[&str]) -> Value {
        crate::core::command_with_rules(&self.command, rules)
    }

    /// `command.visibility ?? 'public'`.
    pub fn visibility(&self) -> Value {
        coalesce(&[self.command.get("visibility")]).cloned().unwrap_or_else(|| Value::String("public".into()))
    }
}
