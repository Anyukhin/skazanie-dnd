//! `server/autonomous-orchestrator.mjs` — исполнитель автономного цикла
//! кампании (задача О1).
//!
//! Цикл: `sk_agents::director_agent` выбирает намерение →
//! `sk_world_story::autonomous_campaign` нормализует его контракт →
//! [`AutonomousCampaignOrchestrator::run_intent`] исполняет его командами
//! через тот же Rules Engine (`resolvePlan`) и журнал событий, что и ход
//! игрока; `sk_story::campaign_loop_policy` — политика и запасной путь без
//! модели. Здесь же свободное действие героя
//! ([`AutonomousCampaignOrchestrator::handle_unknown_action`]), автобой
//! ([`AutonomousCampaignOrchestrator::run_combat`]), завершение встречи с
//! наградой, свидетели и обещания.
//!
//! Внедряется всё, что JS получал в конструкторе: журнал
//! ([`OrchestratorJournal`]), движок ([`OrchestratorRules`]), рассказчик
//! эпилога ([`EpilogueNarrator`]), судья свободного действия
//! ([`FreeActionReader`]), летописец арки ([`ArcChronicler`]), реестр
//! бросков ([`CheckRegistry`]) и часы `now`. «Комнаты» (`store.getRoom`,
//! летописи `messages`) этот модуль JS не читает и не пишет: всё его
//! состояние — журнал событий кампании и подсказки маршрута в памяти.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context as TaskContext, Poll, Waker};

use serde_json::{json, Map, Value};
use sk_agents::action_adjudicator::{revealed_prop_predicate, ActionAdjudicator, ACTION_ADJUDICATOR_PROMPT_VERSION};
use sk_agents::free_action_adjudication::{
    assert_free_action_confirmation, attempt_fingerprint, bind_free_action_reading_to_state, confirmed_hazard_near, contextual_resolution_for, d20_check_label, damage_type_label_ru, free_action_approach_plan, free_action_is_corpse_search, free_action_passage_plan,
    free_action_resolution_policy, free_action_success_promise, harmless_free_action_reading, has_recognized_free_action_approach, interpret_free_action, loot_approach_destination, mundane_action_outcome, passage_destination_place, previous_failed_attempt, resolve_corpse_search,
    resolve_exploration_command, resolve_hazard_contact, resolve_inventory_transfer, resolve_pickpocket, roleplay_speech_reading, situation_fingerprint, stakes_for, verify_means, FreeActionError, MundaneContext, FREE_ACTION_RESOLUTION_POLICY_VERSION, SKILL_LABELS_RU,
};
use sk_agents::lore_author::LoreAuthor;
use sk_agents::narrator::{Narrator, RenderOptions};
use sk_agents::player_request_router::unknown_destination_reply;
use sk_attention::improvised_effects::{plan_improvised_effect, resolve_action_cost, scene_prop_intent_for, ImprovisedEffectRequest};
use sk_attention::scenario_attention::{scenario_stranger_npc_id, scenario_stranger_stage};
use sk_character::encounter_rewards::{
    assert_encounter_distribution_preconditions, assert_encounter_reward_recipients, distribute_encounter_rewards, encounter_completion_stage_key, encounter_reward_response, freeze_encounter_outcome_plan, frozen_encounter_outcome_plan_from_event, loot_for_encounter_outcome,
    roll_encounter_coins, EncounterRewardError, RewardResult, ENCOUNTER_COINS_POLICY_ID, ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION, ENCOUNTER_REWARD_POLICY_ID, SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION,
};
use sk_combat_content::scene_hazard_narration::scene_hazard_narration;
use sk_core::indexmap::IndexMap;
use sk_core::{clock, game, hash, js, re, text, v8sort, RuleError};
use sk_director::campaign_lifecycle::{build_deterministic_epilogue, build_epilogue_narration_brief, campaign_can_advance_arc, campaign_can_auto_complete};
use sk_director::scene_memory::quest_title_from_objective;
use sk_encounters::agent_context::{agent_context_metadata, AgentContextOptions};
use sk_infra::roll_registry::RollRegistry;
use sk_items::loot_tables::ENCOUNTER_LOOT_POLICY_ID;
use sk_memory::party_decision::party_decision_opened_event;
use sk_memory::world_memory::{corpse_clue_command, free_action_discovery_commands, free_action_surface_commands, quest_progress_evidence_for, thorough_search_detail, thorough_search_outcome, DISCOVERY_SKILLS};
use sk_narration::combat_narration::encounter_end_text;
use sk_rules::context::Context;
use sk_rules::core::incapacitating_condition_for;
use sk_rules::dice_record::RulesDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::pause::Halt;
use sk_rules::preview_checks::preview_d20_check;
use sk_rules::resolve::api::RulesEngine;
use sk_scenario::campaign_scenario::{scenario_encounter_end_reason, scenario_ending};
use sk_scene_base::scene_requirements::SCENE_REQUIREMENT_KINDS;
use sk_social::npc_social::npc_profile_at_world_time;
use sk_society::campaign_stories::{campaign_mode_for, PERSISTENT_WORLD_OBJECTIVE};
use sk_store::executor::Journal;
use sk_store::{CommitRequest, CommitResult, EventStore, LoadOptions, Loaded, StoreError, StoreResult};
use sk_story::campaign_loop_policy::{assemble_social_npc, authorize_director_intent, completed_downtime, director_progress_fingerprint, next_world_map_destination, pacing_for_director_intent, plan_server_travel};
use sk_story::intent_parser::classify_free_action_kind;
use sk_tactical::scene_interactions::{nearest_scene_object_command, scene_interaction_narration};
use sk_tactics::party_tactics::{plan_hero_reaction, plan_hero_turn};
use sk_turns::npc_turn_scheduler::plan_npc_turn;
use sk_world_story::autonomous_campaign::{normalize_director_intent, server_reputation_delta, DirectorIntentError, SCENE_RESOLUTION_EVENT_SCHEMA_VERSION};

/// Стабилизированный герой приходит в себя за 1d4 часа: четыре часа — самое
/// долгое ожидание, после которого долгий отдых имеет смысл.
const STABLE_RECOVERY_MINUTES: i64 = 240;

// --- ошибка ---------------------------------------------------------------------------

/// Исключение JS, которое оркестратор пропускает наружу.
#[derive(Debug, Clone)]
pub enum OrchestratorError {
    /// `RulesValidationError`: отказ движка или самого оркестратора.
    Rule(RuleError),
    /// Прочая остановка движка (`TypeError`, пауза боя).
    Engine(Halt),
    /// Отказ журнала (`STATE_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, …).
    Store(StoreError),
    /// `new Error(message)` (с полем `code` или без) и ошибки модулей.
    Error { name: String, code: Option<String>, message: String },
}

impl OrchestratorError {
    /// `new Error(message)`.
    pub fn plain(message: impl Into<String>) -> Self {
        Self::Error { name: "Error".into(), code: None, message: message.into() }
    }

    /// `Object.assign(new Error(message), { code })`.
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self::Error { name: "Error".into(), code: Some(code.into()), message: message.into() }
    }

    /// Ошибка модуля с именем класса JS; `RulesValidationError` — отказ правила.
    pub fn named(name: &str, code: Option<String>, message: impl Into<String>) -> Self {
        let message = message.into();
        if name == "RulesValidationError" {
            return Self::Rule(RuleError::new(code.unwrap_or_else(|| "RULES_VALIDATION_FAILED".into()), message));
        }
        Self::Error { name: name.into(), code, message }
    }

    /// `error.code`.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Rule(error) => Some(&error.code),
            Self::Engine(halt) => halt.code(),
            Self::Store(error) => Some(error.code),
            Self::Error { code, .. } => code.as_deref(),
        }
    }

    /// `error.message`.
    pub fn message(&self) -> String {
        match self {
            Self::Rule(error) => error.message.clone(),
            Self::Engine(Halt::Rule(error)) => error.message.clone(),
            Self::Engine(Halt::Fault(fault)) => fault.message.clone(),
            Self::Engine(halt) => halt.to_string(),
            Self::Store(error) => error.message.clone(),
            Self::Error { message, .. } => message.clone(),
        }
    }

    /// Имя класса JS.
    pub fn name(&self) -> String {
        match self {
            Self::Rule(_) => "RulesValidationError".into(),
            Self::Engine(Halt::Rule(_)) => "RulesValidationError".into(),
            Self::Engine(Halt::Fault(fault)) => fault.name.clone(),
            Self::Engine(_) => "CombatPause".into(),
            Self::Store(_) => "Error".into(),
            Self::Error { name, .. } => name.clone(),
        }
    }

    /// `error instanceof RulesValidationError`.
    pub fn is_rules_validation(&self) -> bool {
        matches!(self, Self::Rule(_) | Self::Engine(Halt::Rule(_)))
    }

    /// Форма эталона: отказ правила `{ err: [code, message] }`, прочее —
    /// `{ fault, code, message }`.
    pub fn to_json(&self) -> Value {
        if self.is_rules_validation() {
            return json!({ "err": [self.code(), self.message()] });
        }
        json!({ "fault": self.name(), "code": self.code(), "message": text::head(&self.message(), 300) })
    }
}

impl std::fmt::Display for OrchestratorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.name(), self.message())
    }
}

impl std::error::Error for OrchestratorError {}

impl From<Halt> for OrchestratorError {
    fn from(halt: Halt) -> Self {
        match halt {
            Halt::Rule(error) => Self::Rule(error),
            other => Self::Engine(other),
        }
    }
}

impl From<RuleError> for OrchestratorError {
    fn from(error: RuleError) -> Self {
        Self::Rule(error)
    }
}

impl From<StoreError> for OrchestratorError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<FreeActionError> for OrchestratorError {
    fn from(error: FreeActionError) -> Self {
        Self::named(&error.name, error.code, error.message)
    }
}

impl From<DirectorIntentError> for OrchestratorError {
    fn from(error: DirectorIntentError) -> Self {
        Self::named(DirectorIntentError::NAME, Some(error.code), error.message)
    }
}

impl From<EncounterRewardError> for OrchestratorError {
    fn from(error: EncounterRewardError) -> Self {
        Self::named(error.name, error.code, error.message)
    }
}

impl From<sk_director::adventure_director::DirectorError> for OrchestratorError {
    fn from(error: sk_director::adventure_director::DirectorError) -> Self {
        Self::named(&error.name, error.code, error.message)
    }
}

impl From<sk_memory::party_decision::PartyDecisionError> for OrchestratorError {
    fn from(error: sk_memory::party_decision::PartyDecisionError) -> Self {
        Self::named("PartyDecisionError", Some(error.code), error.message)
    }
}

pub type OrchestratorResult<T> = Result<T, OrchestratorError>;

// --- внедрение ------------------------------------------------------------------------

/// Будущее внедрённой роли (рассказчик, судья, летописец).
pub type AgentFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Журнал кампании (`eventStore`): исполнителю нужны загрузка, коммит и
/// повтор по ключу ([`Journal`]), загрузка на версии и чтение событий.
pub trait OrchestratorJournal: Journal {
    /// `eventStore.load(campaignId, { atVersion })`.
    fn load_at(&self, campaign_id: &str, at_version: i64) -> StoreResult<Loaded>;
    /// `eventStore.getEvents(campaignId, { afterVersion, upToVersion })`;
    /// `None` — у журнала такого метода нет (`getEvents?.`).
    fn events_between(&self, _campaign_id: &str, _after_version: i64, _up_to_version: Option<i64>) -> Option<StoreResult<Vec<Value>>> {
        None
    }
}

impl OrchestratorJournal for EventStore {
    fn load_at(&self, campaign_id: &str, at_version: i64) -> StoreResult<Loaded> {
        EventStore::load(self, campaign_id, &LoadOptions { at_version: Some(at_version), ..LoadOptions::default() })
    }

    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: Option<i64>) -> Option<StoreResult<Vec<Value>>> {
        Some(self.get_events(campaign_id, after_version, up_to_version))
    }
}

/// Движок правил (`rulesEngine`): разбор плана, проверка команды и кости
/// для монет встречи (`rulesEngine.diceService`).
pub trait OrchestratorRules {
    /// `resolvePlan({ proposed_commands }, state, context)` → `{ commands, events, rolls, state }`.
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, Halt>;
    /// `validate(command, state, context)`.
    fn validate(&self, command: &Value, state: &Value, context: &Value) -> Result<Value, Halt>;
    /// `rollEncounterCoins(plan, rulesEngine.diceService)`.
    fn roll_encounter_coins(&self, plan: &Value) -> RewardResult<Value>;
}

/// Кости движка как `sk_dice::Dice`: бросок монет идёт теми же костями, что
/// и разбор команд (как `rulesEngine.diceService` в JS).
struct DiceBridge<'a> {
    inner: &'a mut dyn RulesDice,
}

impl sk_dice::Dice for DiceBridge<'_> {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: sk_dice::Visibility) -> Result<sk_dice::Roll, sk_dice::DiceError> {
        let args = [Value::String(expression.into()), Value::String(purpose.into()), actor_id.map(|id| Value::String(id.into())).unwrap_or(Value::Null), serde_json::to_value(visibility).unwrap_or(Value::Null)];
        match self.inner.roll(&args) {
            Ok(roll) => serde_json::from_value(roll).map_err(|error| sk_dice::DiceError::Transcript(error.to_string())),
            Err(halt) => Err(sk_dice::DiceError::Transcript(halt.to_string())),
        }
    }

    fn roll_d20(&mut self, _request: &sk_dice::D20Request) -> Result<sk_dice::Roll, sk_dice::DiceError> {
        Err(sk_dice::DiceError::Transcript("rollD20 через мост костей не поддержан".into()))
    }

    fn roll_check(&mut self, _request: &sk_dice::D20Request, _difficulty: i64) -> Result<sk_dice::Roll, sk_dice::DiceError> {
        Err(sk_dice::DiceError::Transcript("rollCheck через мост костей не поддержан".into()))
    }
}

impl OrchestratorRules for RefCell<RulesEngine> {
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, Halt> {
        let plan = json!({ "proposed_commands": commands });
        let resolved = self.borrow_mut().resolve_plan(&plan, state, &Context::from_json(context))?;
        Ok(json!({ "commands": resolved.commands, "events": resolved.events, "rolls": resolved.rolls, "state": resolved.state }))
    }

    fn validate(&self, command: &Value, state: &Value, context: &Value) -> Result<Value, Halt> {
        self.borrow_mut().validate(command, state, &Context::from_json(context))
    }

    fn roll_encounter_coins(&self, plan: &Value) -> RewardResult<Value> {
        let mut engine = self.borrow_mut();
        let mut bridge = DiceBridge { inner: &mut *engine.dice };
        roll_encounter_coins(Some(plan), Some(&mut bridge))
    }
}

/// `rulesEngine: {}` тестов JS: у движка нет ни `resolvePlan`, ни костей.
pub struct NoRulesEngine;

impl OrchestratorRules for NoRulesEngine {
    fn resolve_plan(&self, _commands: &[Value], _state: &Value, _context: &Value) -> Result<Value, Halt> {
        Err(sk_rules::pause::Fault::type_error("this.rulesEngine.resolvePlan is not a function").into())
    }

    fn validate(&self, _command: &Value, _state: &Value, _context: &Value) -> Result<Value, Halt> {
        Err(sk_rules::pause::Fault::type_error("this.rulesEngine.validate is not a function").into())
    }

    fn roll_encounter_coins(&self, plan: &Value) -> RewardResult<Value> {
        roll_encounter_coins(Some(plan), None)
    }
}

/// Рассказчик эпилога (`narrator.render(brief, { style })`).
pub trait EpilogueNarrator {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>>;
}

impl EpilogueNarrator for Narrator {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            Narrator::render(self, brief, RenderOptions::from_json(options)).await.map_err(|error| match error {
                sk_agents::narrator::NarratorError::Security(error) => OrchestratorError::named(error.name, error.code, error.message),
            })
        })
    }
}

/// Судья свободного действия (`actionAdjudicator`).
pub trait FreeActionReader {
    /// `read(state, actorId, text, fallbackReading)`.
    fn read<'a>(&'a self, state: &'a Value, actor_id: &'a str, text: &'a str, fallback: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>>;
    /// `Boolean(actionAdjudicator?.llmClient?.completeJson)`: разбор может
    /// ждать модель, и за это время журнал мог уйти вперёд.
    fn awaits_model(&self) -> bool;
}

impl FreeActionReader for ActionAdjudicator {
    fn read<'a>(&'a self, state: &'a Value, actor_id: &'a str, text: &'a str, fallback: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { ActionAdjudicator::read(self, state, actor_id, text, fallback, None).await.map_err(OrchestratorError::from) })
    }

    fn awaits_model(&self) -> bool {
        self.llm_client.is_some()
    }
}

/// Летописец арки (`loreAuthor.composeArcChronicle`).
pub trait ArcChronicler {
    fn compose_arc_chronicle<'a>(&'a self, input: &'a Value) -> AgentFuture<'a, OrchestratorResult<String>>;
}

impl ArcChronicler for LoreAuthor {
    fn compose_arc_chronicle<'a>(&'a self, input: &'a Value) -> AgentFuture<'a, OrchestratorResult<String>> {
        Box::pin(async move { LoreAuthor::compose_arc_chronicle(self, input).await.map_err(|error| OrchestratorError::named(&error.name, None, error.message)) })
    }
}

/// Реестр бросков (`rollRegistry.registerCheck`): только ручное
/// подтверждение кубика игроком.
pub trait CheckRegistry {
    fn register_check(&self, options: &Value) -> OrchestratorResult<Value>;
}

fn registry_error(error: sk_infra::roll_registry::RollRegistryError) -> OrchestratorError {
    OrchestratorError::named(error.name(), error.code().map(str::to_string), error.to_string())
}

impl CheckRegistry for Mutex<RollRegistry> {
    fn register_check(&self, options: &Value) -> OrchestratorResult<Value> {
        let mut registry = self.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        registry.register_check(options).map_err(registry_error)
    }
}

impl CheckRegistry for RefCell<RollRegistry> {
    fn register_check(&self, options: &Value) -> OrchestratorResult<Value> {
        self.borrow_mut().register_check(options).map_err(registry_error)
    }
}

// --- приведения JS --------------------------------------------------------------------

/// Поле объекта (у не-объекта полей нет).
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `value?.a?.b?.c`.
fn at<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| get(current, key))
}

/// `value ?? []` для массива; не массив — пусто.
fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(value) if !value.is_null() => Some(value),
        _ => b,
    }
}

/// `a || b`.
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(a) {
        a
    } else {
        b
    }
}

/// `a === b` для значений JSON (объекты и массивы — разные ссылки).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `value === 'text'`.
fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `array.includes(item)`.
fn includes(items: &[Value], item: Option<&Value>) -> bool {
    items.iter().any(|candidate| same(Some(candidate), item))
}

fn str_value(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

/// Строка из `&str` как `Option<&Value>` не построить без владения — помощник
/// для мест, где JS передаёт строку туда, где Rust ждёт `Value`.
fn type_is(event: &Value, name: &str) -> bool {
    is_str(event.get("event_type"), name)
}

/// `clean(value, maximum)` модуля: NFKC, пробелы схлопнуты, `trim`, срез.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

fn clean_text(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(value)), maximum)
}

/// `clean(value, maximum).toLocaleLowerCase('ru')`.
fn clean_lower(value: Option<&Value>, maximum: usize) -> String {
    text::lower(&clean(value, maximum))
}

/// `sha256(JSON.stringify(value)).slice(0, 20)`.
fn digest(value: &Value) -> String {
    text::head(&hash::sha256_hex(js::stringify(value)), 20)
}

fn digest_text(value: &str) -> String {
    digest(&str_value(value))
}

/// Поле объекта JS: значение `undefined` (`None`) ключа не создаёт.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn object(map: Map<String, Value>) -> Value {
    Value::Object(map)
}

/// `{ ...base, key: value }`.
fn with_field(base: &Value, key: &str, value: Value) -> Value {
    let mut map = base.as_object().cloned().unwrap_or_default();
    map.insert(key.into(), value);
    Value::Object(map)
}

/// `Math.max(1, Number(state.adventure?.chapter) || 1)`.
fn chapter_of(state: &Value) -> f64 {
    let number = js::number(at(Some(state), &["adventure", "chapter"]));
    let number = if number.is_nan() || number == 0.0 { 1.0 } else { number };
    number.max(1.0)
}

/// `targets.map(String)`.
fn strings_of(items: &[Value]) -> Vec<String> {
    items.iter().map(|item| js::string(Some(item))).collect()
}

fn event(command_id: &str, event_type: &str, payload: Value, targets: &[String], visibility: &str) -> Value {
    json!({
        "command_id": command_id,
        "event_type": event_type,
        "actor_id": null,
        "target_ids": targets,
        "payload": payload,
        "source_rule_ids": [],
        "house_rule_id": null,
        "ruling_id": null,
        "visibility": visibility,
    })
}

// --- отряд ----------------------------------------------------------------------------

/// `partyOrderIds(state)`: порядок отряда — явный список, иначе герои состояния.
pub fn party_order_ids(state: &Value) -> Vec<String> {
    let members = list(get(Some(state), "partyMemberIds"));
    let ids: Vec<Option<&Value>> = if !members.is_empty() { members.iter().map(Some).collect() } else { list(get(Some(state), "players")).iter().map(|hero| get(Some(hero), "id")).collect() };
    ids.into_iter().map(js::s).filter(|id| !id.is_empty()).collect()
}

/// `isUnresolvedDeadHero(state, id)`.
pub fn is_unresolved_dead_hero(state: &Value, id: &str) -> bool {
    is_str(get(at(Some(state), &["mechanics", "death", "heroes"]).and_then(|heroes| get(Some(heroes), id)), "status"), "dead")
}

/// `lootOwnerId(state)`: кому достаётся добыча — первый в отряде, кто не погиб.
pub fn loot_owner_id(state: &Value) -> String {
    let order = party_order_ids(state);
    if let Some(alive) = order.iter().find(|id| !is_unresolved_dead_hero(state, id)) {
        return alive.clone();
    }
    if let Some(first) = order.first() {
        return first.clone();
    }
    js::s(get(list(get(Some(state), "players")).first(), "id"))
}

/// Имя героя для реплики ведущего; служебный id игроку не показывается.
fn hero_name_for_text(state: &Value, actor_id: &str) -> String {
    let hero = list(get(Some(state), "players")).iter().find(|entry| js::string(get(Some(entry), "id")) == actor_id);
    let name = clean(or(get(hero, "character"), get(hero, "name")), 80);
    if name.is_empty() {
        "герой".into()
    } else {
        name
    }
}

fn quests(state: &Value) -> &[Value] {
    list(at(Some(state), &["worldMemory", "quests"]))
}

/// `openQuest(state, requestedId = '')`.
fn open_quest<'a>(state: &'a Value, requested_id: Option<&Value>) -> Option<&'a Value> {
    let empty = str_value("");
    let requested = requested_id.unwrap_or(&empty);
    quests(state)
        .iter()
        .find(|quest| same(get(Some(quest), "id"), Some(requested)) && is_str(get(Some(quest), "status"), "active"))
        .or_else(|| quests(state).iter().find(|quest| is_str(get(Some(quest), "status"), "active") && !js::truthy(at(Some(quest), &["clock", "triggered"]))))
}

const CLOSED_STATUSES: [&str; 3] = ["completed", "failed", "abandoned"];

/// `sceneResolutionProof(state, intent)`: подтверждённый факт развязки сцены
/// или `None`.
pub fn scene_resolution_proof(state: &Value, intent: &Value) -> Option<Value> {
    let chapter = chapter_of(state);
    if !is_str(intent.get("type"), "resolve_scene") {
        return None;
    }
    let chapter_id = format!("quest:chapter:{}", js::f64_string(chapter));
    let chapter_quest = quests(state).iter().find(|quest| js::string(get(Some(quest), "id")) == chapter_id);
    if is_str(intent.get("resolution"), "negotiation") {
        let mut terms: Vec<Option<&Value>> = vec![get(chapter_quest, "title")];
        terms.extend(list(get(chapter_quest, "objectives")).iter().map(Some));
        let objective_terms: Vec<String> = terms.into_iter().map(|term| clean_lower(term, 160)).filter(|term| text::len(term) >= 4).collect();
        let party = party_order_ids(state);
        let location = clean_lower(at(Some(state), &["scene", "location"]), 180);
        let npcs = list(at(Some(state), &["social", "npcs"]));
        let facts = list(at(Some(state), &["worldMemory", "facts"]));
        let conversation = list(at(Some(state), &["social", "conversations"])).iter().rev().find(|entry| {
            js::is_true(at(Some(entry), &["check", "success"]))
                && js::truthy(get(Some(entry), "hero_id"))
                && party.contains(&js::string(get(Some(entry), "hero_id")))
                && npcs.iter().any(|npc| js::string(get(Some(npc), "id")) == js::string(get(Some(entry), "npc_id")) && !js::is_false(get(Some(npc), "available")) && clean_lower(get(Some(npc), "location"), 180) == location)
                && list(get(Some(entry), "disclosed_fact_ids")).iter().any(|fact_id| {
                    let Some(fact) = facts.iter().find(|candidate| js::string(get(Some(candidate), "id")) == js::string(Some(fact_id))) else { return false };
                    let fact_text = text::lower(&clean_text(&format!("{} {}", js::s(get(Some(fact), "summary")), js::s(get(Some(fact), "object"))), 500));
                    includes(list(get(chapter_quest, "entity_ids")), get(Some(fact), "subject_id")) || objective_terms.iter().any(|term| fact_text.contains(term.as_str()))
                })
        })?;
        let mut proof = Map::new();
        proof.insert("evidence_type".into(), str_value("successful_npc_check"));
        put(&mut proof, "evidence_id", get(Some(conversation), "id"));
        return Some(object(proof));
    }
    if is_str(intent.get("resolution"), "objective") {
        let quest = quests(state).iter().find(|entry| js::string(get(Some(entry), "id")) == chapter_id && CLOSED_STATUSES.contains(&js::string(get(Some(entry), "status")).as_str()))?;
        let mut proof = Map::new();
        proof.insert("evidence_type".into(), str_value("chapter_quest_resolved"));
        put(&mut proof, "evidence_id", get(Some(quest), "id"));
        return Some(object(proof));
    }
    let decision = get(Some(state), "agentInteraction");
    let resolved = is_str(get(decision, "status"), "resolved")
        && js::truthy(get(decision, "resolvedOptionId"))
        && js::s(get(decision, "resolutionPrompt")).starts_with("resolve_scene:")
        && CLOSED_STATUSES.contains(&js::string(get(chapter_quest, "status")).as_str());
    if !resolved {
        return None;
    }
    let mut proof = Map::new();
    proof.insert("evidence_type".into(), str_value("party_decision_resolved"));
    put(&mut proof, "evidence_id", get(decision, "id"));
    Some(object(proof))
}

/// `transitionDecisionMatches(interaction, { decisionId, destination })`.
pub fn transition_decision_matches(interaction: Option<&Value>, decision_id: Option<&Value>, destination: Option<&Value>) -> bool {
    let empty = str_value("");
    let decision_id = decision_id.unwrap_or(&empty);
    let destination = destination.unwrap_or(&empty);
    same(get(interaction, "id"), Some(decision_id))
        && is_str(get(interaction, "destinationLocationId"), &clean(Some(destination), 160))
        && is_str(get(interaction, "status"), "resolved")
        && is_str(get(interaction, "resolvedOptionId"), "continue")
        && list(get(interaction, "options")).iter().any(|option| is_str(get(Some(option), "id"), "continue"))
}

/// `currentSubject(state)`: сущность текущего места или первая сущность.
fn current_subject(state: &Value) -> Option<Value> {
    let entities = list(at(Some(state), &["worldMemory", "entities"]));
    let location = at(Some(state), &["scene", "location"]);
    entities.iter().find(|entity| is_str(get(Some(entity), "kind"), "location") && same(get(Some(entity), "name"), location)).or_else(|| entities.first()).filter(|entity| !entity.is_null()).cloned()
}

/// Предмет без записи о себе: `location-…` по месту сцены.
fn location_subject(state: &Value, seed: &Value) -> Value {
    let location = at(Some(state), &["scene", "location"]);
    let name = if js::truthy(location) { location.cloned().unwrap_or(Value::Null) } else { str_value("Текущая сцена") };
    json!({
        "id": format!("location-{}", digest(seed)),
        "kind": "location",
        "name": name,
        "summary": "", "aliases": [], "visibility": "party", "tags": [],
    })
}

/// `materialConsequenceCommands(state, { succeeded, committedEvents })` —
/// задача 2.1 плана: успех, изменивший мир (дверь, баррикада, предмет
/// обстановки), оставляет факт, который дальше видят Режиссёр, Рассказчик и
/// сводка сцены. Обычная удачная проверка мир не меняет.
pub fn material_consequence_commands(state: &Value, succeeded: bool, committed_events: Option<&Value>) -> Vec<Value> {
    if !succeeded {
        return Vec::new();
    }
    let effects: Vec<&Value> = list(committed_events)
        .iter()
        .filter(|event| {
            if !js::truthy(Some(event)) {
                return false;
            }
            let visibility = event.get("visibility");
            let visible = match visibility {
                None | Some(Value::Null) => true,
                Some(Value::String(text)) => ["party", "public", ""].contains(&text.as_str()),
                _ => false,
            };
            if !visible {
                return false;
            }
            let kind = js::s(event.get("event_type"));
            match kind.as_str() {
                "DoorBarricaded" | "DoorBarricadeCleared" => true,
                // Взлом и выламывание меняют дверь своим событием, без
                // DoorStateChanged. Провал двери не меняет.
                "DoorForced" | "DoorLockpicked" => js::is_true(at(Some(event), &["payload", "success"])),
                "DoorStateChanged" => js::s(at(Some(event), &["payload", "state"])) != js::s(at(Some(event), &["payload", "previous_state"])),
                "SceneObjectStateChanged" => !js::is_false(at(Some(event), &["payload", "success"])) && !js::s(at(Some(event), &["payload", "state"])).is_empty(),
                _ => false,
            }
        })
        .collect();
    if effects.is_empty() {
        return Vec::new();
    }
    let effect_ids: Vec<String> = effects.iter().map(|event| js::s(event.get("event_id"))).filter(|id| !id.is_empty()).collect();
    if effect_ids.is_empty() {
        return Vec::new();
    }
    let fact_id = format!("fact-scene-change-{}", digest_text(&effect_ids.join("\0")));
    if list(at(Some(state), &["worldMemory", "facts"])).iter().any(|fact| is_str(get(Some(fact), "id"), &fact_id)) {
        return Vec::new();
    }
    let prop_label = |asset: &str| match asset {
        "bookshelf" => Some("стеллаж"),
        "table" => Some("стол"),
        "barrel" => Some("бочка"),
        "crate" => Some("ящик"),
        "campfire" => Some("костёр"),
        "bar_counter" => Some("стойка"),
        _ => None,
    };
    let state_label = |value: &str| match value {
        "burning" => Some("загорелся"),
        "burned" => Some("сгорел"),
        "toppled" => Some("опрокинут"),
        "open" => Some("открыт"),
        "taken" => Some("опустел"),
        "closed" => Some("закрыт"),
        _ => None,
    };
    let props = list(at(Some(state), &["scene", "map", "props"]));
    let facts: Vec<String> = effects
        .iter()
        .map(|event| {
            let payload = event.get("payload");
            match js::string(event.get("event_type")).as_str() {
                "DoorBarricaded" => "Дверь забаррикадирована".to_string(),
                "DoorBarricadeCleared" => "Баррикада двери снята".to_string(),
                "DoorForced" => "Дверь выломана".to_string(),
                "DoorLockpicked" => "Замок двери взломан".to_string(),
                "DoorStateChanged" => {
                    let label = match js::string(get(payload, "state")).as_str() {
                        "open" => "открыта",
                        "closed" => "закрыта",
                        "locked" => "заперта",
                        "broken" => "выломана",
                        _ => "изменилась",
                    };
                    format!("Дверь {label}")
                }
                _ => {
                    let prop = props.iter().find(|candidate| js::string(get(Some(candidate), "id")) == js::string(get(payload, "prop_id")));
                    let asset_path = js::s(get(prop, "assetId"));
                    let last = asset_path.split(['\\', '/']).next_back().unwrap_or("");
                    let asset = text::replace_first(re!(r"\.[a-z0-9]+$", "iu"), last, "");
                    let name = match or(get(prop, "name"), get(prop, "label")) {
                        Some(value) if js::truthy(Some(value)) => js::string(Some(value)),
                        _ => prop_label(&asset).unwrap_or("Предмет обстановки").to_string(),
                    };
                    format!("{name} {}", state_label(&js::string(get(payload, "state"))).unwrap_or("изменил состояние"))
                }
            }
        })
        .collect();
    let mut commands = Vec::new();
    let subject = match current_subject(state) {
        Some(subject) => subject,
        None => {
            let location = at(Some(state), &["scene", "location"]);
            let seed = if js::truthy(location) { location.cloned().unwrap_or(Value::Null) } else { str_value("scene") };
            let subject = location_subject(state, &seed);
            commands.push(json!({ "command_type": "UpsertWorldEntity", "entity": subject }));
            subject
        }
    };
    let place = text::trim(&js::s(at(Some(state), &["scene", "location"]))).to_string();
    let joined = facts.join("; ");
    let mut fact = Map::new();
    fact.insert("id".into(), str_value(fact_id));
    put(&mut fact, "subject_id", subject.get("id"));
    fact.insert("predicate".into(), str_value("scene_change"));
    fact.insert("object".into(), str_value(joined.clone()));
    fact.insert("summary".into(), str_value(if place.is_empty() { joined } else { format!("{joined} ({place})") }));
    fact.insert("visibility".into(), str_value("party"));
    fact.insert("source_event_ids".into(), json!(effect_ids));
    commands.push(json!({ "command_type": "RecordWorldFact", "fact": object(fact) }));
    commands
}

/// Нераскрытые клетки пола и дверей сверху вниз, слева направо.
fn exploration_cells(state: &Value) -> Vec<Value> {
    let mut cells: Vec<&Value> = list(at(Some(state), &["scene", "cells"]))
        .iter()
        .filter(|cell| !js::is_true(get(Some(cell), "revealed")) && ["floor", "door"].contains(&js::string(get(Some(cell), "type")).as_str()))
        .collect();
    v8sort::sort_by(&mut cells, |a, b| {
        let dy = js::number(get(Some(a), "y")) - js::number(get(Some(b), "y"));
        if dy != 0.0 && !dy.is_nan() {
            return dy;
        }
        js::number(get(Some(a), "x")) - js::number(get(Some(b), "x"))
    });
    cells.into_iter().map(|cell| json!({ "x": js::num(js::number(get(Some(cell), "x"))), "y": js::num(js::number(get(Some(cell), "y"))) })).collect()
}

/// `availableNpc(state, requestedId)`: собеседник, которого можно позвать
/// сейчас, — по профилю на текущую минуту (расписание уводит NPC из
/// локации), но возвращается **записанный** профиль.
fn available_npc(state: &Value, requested_id: Option<&Value>) -> Option<Value> {
    let here = clean_lower(at(Some(state), &["scene", "location"]), 180);
    list(at(Some(state), &["social", "npcs"]))
        .iter()
        .find(|npc| {
            if js::truthy(requested_id) && !same(get(Some(npc), "id"), requested_id) {
                return false;
            }
            let now = npc_profile_at_world_time(npc, state);
            let location = get(Some(&now), "location");
            !js::is_false(get(Some(&now), "available")) && (!js::truthy(location) || here.is_empty() || clean_lower(location, 180) == here)
        })
        .cloned()
}

/// Заголовок разворачивается перед подстановкой: в старых кампаниях он мог
/// накопить обёртки «Продолжить квест «…».
fn quest_goal(quest: Option<&Value>) -> String {
    clean_text(&quest_title_from_objective(get(quest, "title")), 180)
}

/// `nextHook(state, reason = '')`.
fn next_hook(state: &Value, reason: Option<&Value>) -> String {
    let reason = clean(reason, 300);
    if !reason.is_empty() {
        return reason;
    }
    match open_quest(state, None) {
        Some(quest) => format!("Продолжить квест «{}»", quest_goal(Some(quest))),
        None => {
            let location = at(Some(state), &["scene", "location"]);
            let place = if js::truthy(location) { js::string(location) } else { "окрестности".into() };
            format!("Исследовать {place} и найти новую зацепку")
        }
    }
}

fn next_hook_with(state: &Value, reason: &str) -> String {
    next_hook(state, Some(&str_value(reason)))
}

/// Название предмета карты по словарю программы сцены: «колодец», «сундук».
static PROP_LABEL_BY_ASSET: LazyLock<IndexMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut labels = IndexMap::new();
    for kind in SCENE_REQUIREMENT_KINDS.iter() {
        for asset in kind.assets {
            labels.insert(*asset, kind.label);
        }
    }
    labels
});

/// `directorStepNarration(intentType, events, state)`: строка ленты после
/// шага Режиссёра без «громких» событий — что открылось в новых клетках, а
/// если смотреть больше не на что — цель и куда идти дальше. Пустая строка —
/// у шага есть свой текст.
pub fn director_step_narration(intent_type: Option<&Value>, events: &[Value], state: &Value) -> String {
    let intent_type = js::string(intent_type);
    if !["continue_exploration", "offer_next_hook"].contains(&intent_type.as_str()) {
        return String::new();
    }
    let mut revealed: Vec<String> = Vec::new();
    for event in events.iter().filter(|event| is_str(get(Some(event), "event_type"), "AreaRevealed")) {
        let cells = nullish(at(Some(event), &["payload", "cells"]), None);
        let cells: Vec<&Value> = match cells {
            Some(Value::Array(items)) => items.iter().collect(),
            Some(other) => vec![other],
            None => Vec::new(),
        };
        for cell in cells {
            let key = format!("{},{}", js::string(get(Some(cell), "x")), js::string(get(Some(cell), "y")));
            if !revealed.contains(&key) {
                revealed.push(key);
            }
        }
    }
    let objective = clean(at(Some(state), &["scene", "objective"]), 160);
    let onward = next_world_map_destination(state);
    if !revealed.is_empty() {
        let mut seen: Vec<&str> = Vec::new();
        for prop in list(at(Some(state), &["scene", "map", "props"])) {
            let label = get(Some(prop), "assetId").and_then(Value::as_str).and_then(|asset| PROP_LABEL_BY_ASSET.get(asset).copied());
            let footprint = list(get(Some(prop), "footprint"));
            let cells: Vec<String> = if matches!(get(Some(prop), "footprint"), Some(Value::Array(items)) if !items.is_empty()) {
                footprint.iter().map(|cell| format!("{},{}", js::string(get(Some(cell), "x")), js::string(get(Some(cell), "y")))).collect()
            } else {
                vec![format!("{},{}", js::f64_string(js::number(get(Some(prop), "x")).floor()), js::f64_string(js::number(get(Some(prop), "y")).floor()))]
            };
            if let Some(label) = label {
                if !seen.contains(&label) && cells.iter().any(|cell| revealed.contains(cell)) {
                    seen.push(label);
                }
            }
        }
        let place = clean(at(Some(state), &["scene", "location"]), 120);
        let place = if place.is_empty() { "места".to_string() } else { place };
        let here = if seen.is_empty() { String::new() } else { format!(" — здесь {}", seen.iter().take(4).copied().collect::<Vec<_>>().join(", ")) };
        return format!("Отряд продвигается дальше и осматривается: открывается новая часть «{place}»{here}.");
    }
    let mut parts: Vec<String> = Vec::new();
    if intent_type == "continue_exploration" {
        parts.push("Здесь отряд осмотрел всё, что было на виду.".into());
    }
    if !objective.is_empty() {
        parts.push(format!("Цель: {}.", text::replace_first(re!(r"[.!…]+$", "u"), &objective, "")));
    }
    if let Some(onward) = onward.filter(|onward| !onward.is_empty()) {
        parts.push(format!("Дальше можно отправиться в «{}» — скажите «Перейти дальше».", clean_text(&onward, 120)));
    }
    parts.join(" ")
}

/// Зацепка следующей арки: первая незакрытая нить, затем неисполненное
/// обещание, затем активный квест, и лишь потом нейтральное продолжение.
fn next_arc_hook(state: &Value) -> String {
    if let Some(thread) = list(at(Some(state), &["worldMemory", "threads"])).iter().find(|entry| is_str(get(Some(entry), "status"), "active")) {
        return clean_text(&format!("Вернуться к незакрытому: {}", clean(get(Some(thread), "title"), 180)), 300);
    }
    for promise in list(at(Some(state), &["social", "promises"])) {
        if ["fulfilled", "broken"].contains(&js::s(get(Some(promise), "status")).as_str()) {
            continue;
        }
        let npc = list(at(Some(state), &["social", "npcs"])).iter().find(|entry| js::string(get(Some(entry), "id")) == js::string(get(Some(promise), "npc_id")));
        if js::truthy(Some(promise)) {
            let name = clean(get(npc, "name"), 120);
            let name = if name.is_empty() { "союзнику".to_string() } else { name };
            return clean_text(&format!("Сдержать слово, данное {name}: {}", clean(get(Some(promise), "text"), 160)), 300);
        }
    }
    if let Some(quest) = quests(state).iter().find(|entry| is_str(get(Some(entry), "status"), "active")) {
        return clean_text(&format!("Довести до конца: {}", quest_goal(Some(quest))), 300);
    }
    let place = clean(at(Some(state), &["scene", "location"]), 120);
    let place = if place.is_empty() { "знакомых мест".to_string() } else { place };
    clean_text(&format!("Новая дорога уводит отряд из {place}"), 300)
}

struct QuestResolution {
    outcome: &'static str,
    summary: String,
    next_objective: String,
}

fn quest_resolution_for(quest: &Value) -> QuestResolution {
    let label = clean(at(Some(quest), &["clock", "label"]), 160);
    let failure_clock = text::test(re!(r"(угроз|опасност|провал|разыск|подозрен|deadline|danger|failure)", "iu"), &label);
    let goal = quest_goal(Some(quest));
    if failure_clock {
        QuestResolution {
            outcome: "failure",
            summary: format!("Угроза в квесте «{goal}» осуществилась: заполненные часы подтвердили неудачу, но история продолжается с последствиями."),
            next_objective: format!("Ответить на последствия провала квеста «{goal}» и найти новый путь"),
        }
    } else {
        QuestResolution {
            outcome: "success",
            summary: format!("Цель «{goal}» достигнута: заполненные часы подтвердили успех отряда."),
            next_objective: format!("Развить последствия победы в квесте «{goal}» и приблизить развязку"),
        }
    }
}

fn declared_action_command(player_id: &str, action: &str) -> Option<Value> {
    (!player_id.is_empty()).then(|| json!({ "command_type": "DeclareAction", "actor_id": player_id, "action": action }))
}

fn is_noise(value: &str) -> bool {
    text::test(re!(r"^[a-z]{8,}$", "iu"), value) && !text::test(re!(r"\s", "u"), value)
}

fn faction_ids_for_witnesses(state: &Value, witness_ids: &[String]) -> Vec<Value> {
    let mut values: Vec<String> = Vec::new();
    for npc in list(at(Some(state), &["social", "npcs"])) {
        if !witness_ids.contains(&js::string(get(Some(npc), "id"))) {
            continue;
        }
        for tag in list(get(Some(npc), "tags")) {
            let tag = js::string(Some(tag));
            if let Some(faction) = tag.strip_prefix("faction:") {
                values.push(faction.to_string());
            }
        }
    }
    let mut unique: Vec<Value> = Vec::new();
    for value in values.into_iter().filter(|value| !value.is_empty()) {
        let value = str_value(value);
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    js::default_sort(&mut unique);
    unique
}

fn parse_json_fact(fact: &Value) -> Option<Value> {
    serde_json::from_str::<Value>(&js::s(get(Some(fact), "object"))).ok()
}

/// Вход через закрытую дверь: подойти, открыть, затем общий шаг внутрь.
/// Герой уже у двери — шага к ней нет.
fn passage_door_commands(actor_id: &str, plan: &Value, ruling_id: &Value) -> Vec<Value> {
    if !js::is_true(get(Some(plan), "open_door")) || !js::truthy(get(Some(plan), "door_id")) {
        return Vec::new();
    }
    let mut commands = Vec::new();
    if !js::truthy(get(Some(plan), "at_door")) {
        let mut move_command = Map::new();
        move_command.insert("command_type".into(), str_value("MoveActor"));
        move_command.insert("actor_id".into(), str_value(actor_id));
        put(&mut move_command, "to", get(Some(plan), "approach"));
        move_command.insert("server_authoritative".into(), Value::Bool(true));
        move_command.insert("ruling_id".into(), ruling_id.clone());
        commands.push(object(move_command));
    }
    commands.push(json!({ "command_type": "OperateDoor", "actor_id": actor_id, "door_id": get(Some(plan), "door_id"), "intent": "open" }));
    commands
}

/// События, которые пишут память мира в фоне и не трогают сцену, героя и
/// экономику хода (и расстановка хранителя зацепки).
const BACKGROUND_MEMORY_EVENT_TYPES: [&str; 8] = [
    "WorldFactRecorded",
    "WorldEntityUpserted",
    "WorldRelationshipRecorded",
    "NarrativeThreadUpserted",
    "NarrativeThreadClockAdvanced",
    "NarrativeSummaryRecorded",
    "NpcSocialProfileUpserted",
    "NpcPlaced",
];

/// Живые герои отряда есть, но все на нуле: заявить отдых некому.
fn nobody_standing(state: &Value) -> bool {
    let party: Vec<String> = list(get(Some(state), "partyMemberIds")).iter().map(|id| js::string(Some(id))).collect();
    let alive: Vec<&Value> = list(get(Some(state), "players"))
        .iter()
        .filter(|hero| party.contains(&js::string(get(Some(hero), "id"))) && !is_str(get(at(Some(state), &["mechanics", "death", "heroes"]).and_then(|heroes| get(Some(heroes), &js::string(get(Some(hero), "id")))), "status"), "dead"))
        .collect();
    !alive.is_empty() && alive.iter().all(|hero| js::number(get(Some(hero), "hp")) <= 0.0)
}

/// `incapacitatedActionRefusal(actor, condition)`: отказ действию героя,
/// который лежит без сознания или скован, — словом ведущего, а не кодом.
pub fn incapacitated_action_refusal(actor: Option<&Value>, condition: Option<&str>) -> String {
    let name = match or(get(actor, "character"), get(actor, "name")) {
        Some(value) if js::truthy(Some(value)) => js::string(Some(value)),
        _ => "Герой".to_string(),
    };
    let name = text::head(&name, 80);
    match condition {
        None | Some("unconscious") | Some("") => format!("{name} без сознания и сейчас ничего не сделает сам. Поднять героя может отряд: перевязать раны (Мудрость (Медицина), СЛ 10), дать зелье или исцелить чарами."),
        Some(condition) => {
            let reason = match condition {
                "paralyzed" => "паралич",
                "stunned" => "оглушение",
                "petrified" => "окаменение",
                _ => "бессилие",
            };
            format!("{name} сейчас не может действовать — {reason}; пока это не пройдёт, ход за отрядом.")
        }
    }
}

// --- блокировка завершения встречи ------------------------------------------------------

/// Завершение одной встречи идёт одно за раз на процесс (`encounterCompletionLocks`
/// модуля JS): второй вызов ждёт первый и затем выполняется без блокировки.
struct CompletionSlot {
    done: Option<Result<(), OrchestratorError>>,
    wakers: Vec<Waker>,
}

type SharedSlot = Arc<Mutex<CompletionSlot>>;

static COMPLETION_LOCKS: LazyLock<Mutex<HashMap<String, SharedSlot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `await previous`: ждать конца прежней операции; её отказ — и наш отказ.
struct AwaitSlot(SharedSlot);

impl Future for AwaitSlot {
    type Output = Result<(), OrchestratorError>;

    fn poll(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<Self::Output> {
        let mut slot = lock(&self.0);
        match &slot.done {
            Some(result) => Poll::Ready(result.clone()),
            None => {
                slot.wakers.push(context.waker().clone());
                Poll::Pending
            }
        }
    }
}

/// Владелец блокировки: снимает её при завершении (и при отмене будущего).
struct CompletionGuard {
    key: String,
    slot: SharedSlot,
}

impl CompletionGuard {
    fn finish(&self, result: Result<(), OrchestratorError>) {
        let wakers = {
            let mut slot = lock(&self.slot);
            if slot.done.is_none() {
                slot.done = Some(result);
            }
            std::mem::take(&mut slot.wakers)
        };
        let mut locks = lock(&COMPLETION_LOCKS);
        if locks.get(&self.key).is_some_and(|current| Arc::ptr_eq(current, &self.slot)) {
            locks.remove(&self.key);
        }
        drop(locks);
        for waker in wakers {
            waker.wake();
        }
    }
}

impl Drop for CompletionGuard {
    fn drop(&mut self) {
        self.finish(Ok(()));
    }
}

// --- оркестратор ----------------------------------------------------------------------

/// Проверка состояния перед коммитом этапа награды.
type ValidateState<'v> = &'v dyn Fn(&Value) -> OrchestratorResult<()>;

/// `AutonomousCampaignOrchestrator`.
pub struct AutonomousCampaignOrchestrator {
    pub event_store: Arc<dyn OrchestratorJournal>,
    pub rules_engine: Arc<dyn OrchestratorRules>,
    pub narrator: Option<Arc<dyn EpilogueNarrator>>,
    /// Без судьи свободное действие читает детерминированная таблица: игра
    /// обязана оставаться играбельной без ключа модели.
    pub action_adjudicator: Option<Arc<dyn FreeActionReader>>,
    pub lore_author: Option<Arc<dyn ArcChronicler>>,
    /// Реестр бросков нужен только ручному подтверждению кубика игроком.
    pub roll_registry: Option<Arc<dyn CheckRegistry>>,
    /// `now = () => Date.now()`.
    pub now: Arc<dyn Fn() -> i64>,
    /// Подсказки маршрута (`routeHints`): ключ — `campaignId\0idempotencyKey`.
    route_hints: Mutex<IndexMap<String, Value>>,
}

/// Параметры `handleUnknownAction`.
#[derive(Debug, Clone, Default)]
pub struct UnknownAction {
    pub campaign_id: String,
    pub action: Value,
    pub idempotency_key: String,
    pub player_id: Value,
    pub intent: Option<Value>,
    pub verified_roll: Option<Value>,
    pub confirmed_action: bool,
}

impl UnknownAction {
    /// Из объекта JS `{ campaignId, action, idempotencyKey, playerId, intent,
    /// verifiedRoll, confirmedAction }`.
    pub fn from_json(options: &Value) -> Self {
        let field = |key: &str| get(Some(options), key);
        Self {
            campaign_id: js::s(field("campaignId")),
            action: field("action").cloned().unwrap_or(Value::Null),
            idempotency_key: js::s(field("idempotencyKey")),
            player_id: field("playerId").cloned().unwrap_or_else(|| str_value("")),
            intent: field("intent").filter(|value| !value.is_null()).cloned(),
            verified_roll: field("verifiedRoll").filter(|value| !value.is_null()).cloned(),
            confirmed_action: js::truthy(field("confirmedAction")),
        }
    }
}

impl AutonomousCampaignOrchestrator {
    /// `new AutonomousCampaignOrchestrator({ eventStore, rulesEngine })`.
    pub fn new(event_store: Arc<dyn OrchestratorJournal>, rules_engine: Arc<dyn OrchestratorRules>) -> Self {
        Self { event_store, rules_engine, narrator: None, action_adjudicator: None, lore_author: None, roll_registry: None, now: Arc::new(clock::now_ms), route_hints: Mutex::new(IndexMap::new()) }
    }

    pub fn with_narrator(mut self, narrator: Arc<dyn EpilogueNarrator>) -> Self {
        self.narrator = Some(narrator);
        self
    }

    pub fn with_action_adjudicator(mut self, adjudicator: Arc<dyn FreeActionReader>) -> Self {
        self.action_adjudicator = Some(adjudicator);
        self
    }

    pub fn with_lore_author(mut self, author: Arc<dyn ArcChronicler>) -> Self {
        self.lore_author = Some(author);
        self
    }

    pub fn with_roll_registry(mut self, registry: Arc<dyn CheckRegistry>) -> Self {
        self.roll_registry = Some(registry);
        self
    }

    pub fn with_now(mut self, now: Arc<dyn Fn() -> i64>) -> Self {
        self.now = now;
        self
    }

    fn now_iso(&self) -> String {
        clock::iso((self.now)())
    }

    /// `load(campaignId)`: голова журнала с нормализованным состоянием.
    pub fn load(&self, campaign_id: &str) -> OrchestratorResult<Loaded> {
        let mut loaded = self.event_store.load(campaign_id)?;
        loaded.state = normalize_campaign_state(&loaded.state)?;
        Ok(loaded)
    }

    fn by_key(&self, campaign_id: &str, key: &str) -> OrchestratorResult<Option<CommitResult>> {
        Ok(self.event_store.get_by_idempotency_key(campaign_id, key)?)
    }

    fn by_key_json(&self, campaign_id: &str, key: &str) -> OrchestratorResult<Option<Value>> {
        Ok(self.by_key(campaign_id, key)?.map(|commit| commit.to_json()))
    }

    /// `getEvents?.(campaignId) ?? []`.
    fn all_events(&self, campaign_id: &str) -> OrchestratorResult<Vec<Value>> {
        match self.event_store.events_between(campaign_id, 0, None) {
            Some(events) => Ok(events?),
            None => Ok(Vec::new()),
        }
    }

    fn prepare(campaign_id: &str, events: &[Value]) -> Vec<Value> {
        events.iter().map(|entry| with_field(entry, "campaign_id", str_value(campaign_id))).collect()
    }

    fn store_commit(&self, campaign_id: &str, expected: i64, key: &str, events: Vec<Value>) -> StoreResult<CommitResult> {
        self.event_store.commit(CommitRequest {
            campaign_id: campaign_id.into(),
            expected_state_version: expected,
            idempotency_key: key.into(),
            command_id: Some(key.into()),
            events,
            force_snapshot: false,
            metadata: json!({}),
        })
    }

    /// `commitEvents(campaignId, idempotencyKey, events)`.
    pub fn commit_events(&self, campaign_id: &str, idempotency_key: &str, events: &[Value]) -> OrchestratorResult<Value> {
        if let Some(duplicate) = self.by_key_json(campaign_id, idempotency_key)? {
            return Ok(duplicate);
        }
        let loaded = self.load(campaign_id)?;
        Ok(self.store_commit(campaign_id, loaded.state_version, idempotency_key, Self::prepare(campaign_id, events))?.to_json())
    }

    /// `commitEventsWithRetry(campaignId, idempotencyKey, events, { validateState })`:
    /// этап награды, который переживает гонку версий и повтор по ключу.
    pub fn commit_events_with_retry(&self, campaign_id: &str, idempotency_key: &str, events: &[Value], validate_state: Option<ValidateState<'_>>) -> OrchestratorResult<Value> {
        let maximum_attempts = 3;
        let prepared = Self::prepare(campaign_id, events);
        let accepts_stored_stage = |stored: &CommitResult| {
            if stored.events.len() != prepared.len() {
                return false;
            }
            prepared.iter().zip(&stored.events).all(|(expected, actual)| {
                let expected_encounter = js::s(at(Some(expected), &["payload", "encounter_id"]));
                let actual_encounter = js::s(at(Some(actual), &["payload", "encounter_id"]));
                let policy_of = |entry: &Value| nullish(at(Some(entry), &["payload", "provenance", "policy"]), at(Some(entry), &["payload", "policy"])).cloned().unwrap_or(Value::Null);
                let expected_policy = policy_of(expected);
                let actual_policy = policy_of(actual);
                same(actual.get("event_type"), expected.get("event_type"))
                    && (expected_encounter.is_empty() || actual_encounter == expected_encounter)
                    && (!js::truthy(Some(&expected_policy)) || same(Some(&actual_policy), Some(&expected_policy)))
                    && (!js::present(expected.get("event_schema_version")) || js::number(actual.get("event_schema_version")) == js::number(expected.get("event_schema_version")))
            })
        };
        let duplicate_of = |stored: CommitResult| with_field(&stored.to_json(), "duplicate", Value::Bool(true));
        for attempt in 0..maximum_attempts {
            if let Some(duplicate) = self.by_key(campaign_id, idempotency_key)? {
                if !accepts_stored_stage(&duplicate) {
                    return Err(OrchestratorError::plain(format!("Stored encounter reward stage {idempotency_key} has an incompatible contract")));
                }
                return Ok(duplicate_of(duplicate));
            }
            let loaded = self.load(campaign_id)?;
            if let Some(validate) = validate_state {
                validate(&loaded.state)?;
            }
            match self.store_commit(campaign_id, loaded.state_version, idempotency_key, prepared.clone()) {
                Ok(committed) => return Ok(committed.to_json()),
                Err(error) => {
                    if error.code == "IDEMPOTENCY_CONFLICT" {
                        if let Some(stored) = self.by_key(campaign_id, idempotency_key)? {
                            if accepts_stored_stage(&stored) {
                                return Ok(duplicate_of(stored));
                            }
                        }
                    }
                    if error.code != "STATE_VERSION_CONFLICT" || attempt == maximum_attempts - 1 {
                        return Err(error.into());
                    }
                }
            }
        }
        Err(OrchestratorError::plain("Encounter reward stage exhausted its retry budget"))
    }

    /// `runCommands(campaignId, idempotencyKey, commands, context, expectedStateVersion)`:
    /// пакет команд через Rules Engine (`resolvePlan`) одним коммитом.
    pub fn run_commands(&self, campaign_id: &str, idempotency_key: &str, commands: &[Value], context: &Value, expected_state_version: Option<i64>) -> OrchestratorResult<Value> {
        if let Some(duplicate) = self.by_key_json(campaign_id, idempotency_key)? {
            return Ok(js::spread(&duplicate, json!({ "duplicate": true, "commands": [] })));
        }
        let loaded = self.load(campaign_id)?;
        let expected = expected_state_version.unwrap_or(loaded.state_version);
        if expected != loaded.state_version {
            return Err(OrchestratorError::coded("STATE_VERSION_CONFLICT", "Обстановка изменилась до сохранения свободного действия"));
        }
        let proposed: Vec<Value> = commands
            .iter()
            .enumerate()
            .map(|(index, command)| js::spread(command, json!({ "campaign_id": campaign_id, "command_id": format!("{idempotency_key}:{}", index + 1) })))
            .collect();
        let state = &loaded.state;
        let allowed: Vec<Value> = list(state.get("players"))
            .iter()
            .chain(list(state.get("enemies")))
            .chain(list(state.get("actors")))
            .map(|actor| str_value(js::string(nullish(get(Some(actor), "id"), get(Some(actor), "actor_id")))))
            .collect();
        let full_context = js::spread(&json!({ "isDirector": true, "serverAuthoritativeCombat": true, "allowedActorIds": allowed }), context.clone());
        let resolved = self.rules_engine.resolve_plan(&proposed, state, &full_context)?;
        let events = list(resolved.get("events")).to_vec();
        if events.is_empty() {
            return Err(OrchestratorError::plain("Autonomous command batch produced no events"));
        }
        let committed = self.store_commit(campaign_id, expected, idempotency_key, events)?;
        self.resolve_promise_conditions(campaign_id, &committed.events, &format!("{idempotency_key}:promises"))?;
        Ok(js::spread(&committed.to_json(), json!({ "commands": resolved.get("commands").cloned().unwrap_or(json!([])), "rolls": resolved.get("rolls").cloned().unwrap_or(json!([])) })))
    }

    fn run(&self, campaign_id: &str, key: &str, commands: &[Value]) -> OrchestratorResult<Value> {
        self.run_commands(campaign_id, key, commands, &json!({}), None)
    }

    /// `resolveTriggeredQuests(campaignId, idempotencyKey, sourceEvents)`:
    /// заполненные часы цели, подтверждённые доказанным прогрессом, — развязка
    /// квеста.
    pub fn resolve_triggered_quests(&self, campaign_id: &str, idempotency_key: &str, source_events: &[Value]) -> OrchestratorResult<Option<Value>> {
        let loaded = self.load(campaign_id)?;
        let mut requested: Vec<Value> = Vec::new();
        for entry in source_events.iter().filter(|entry| type_is(entry, "QuestClockAdvanced")) {
            if let Some(id) = entry.get("event_id").filter(|id| js::truthy(Some(id))) {
                if !includes(&requested, Some(id)) {
                    requested.push(id.clone());
                }
            }
        }
        if requested.is_empty() {
            return Ok(None);
        }
        let committed = self.all_events(campaign_id)?;
        let progress_events: Vec<&Value> = committed
            .iter()
            .filter(|entry| {
                includes(&requested, entry.get("event_id"))
                    && type_is(entry, "QuestClockAdvanced")
                    && at(Some(entry), &["payload", "schema_version"]).and_then(Value::as_f64) == Some(2.0)
                    && list_len(at(Some(entry), &["payload", "proof_fact_ids"])) > 0
            })
            .collect();
        let state = &loaded.state;
        let triggered: Vec<&Value> = quests(state).iter().filter(|quest| is_str(get(Some(quest), "status"), "active") && js::is_true(at(Some(quest), &["clock", "triggered"]))).collect();
        if triggered.is_empty() {
            return Ok(None);
        }
        let persistent = campaign_mode_for(state) == "persistent";
        let mut commands = Vec::new();
        for quest in triggered {
            let quest_id = quest_id_text(get(Some(quest), "id"));
            let valid_facts: Vec<Value> = quest_progress_evidence_for(state, &quest_id, true).iter().map(|fact| fact.get("id").cloned().unwrap_or(Value::Null)).collect();
            let progress_ids = list(get(Some(quest), "progress_fact_ids"));
            let source_event_ids: Vec<Value> = progress_events
                .iter()
                .filter(|entry| {
                    same(at(Some(entry), &["payload", "quest_id"]), get(Some(quest), "id"))
                        && list(at(Some(entry), &["payload", "proof_fact_ids"])).iter().all(|id| includes(&valid_facts, Some(id)) && includes(progress_ids, Some(id)))
                })
                .map(|entry| entry.get("event_id").cloned().unwrap_or(Value::Null))
                .collect();
            if source_event_ids.is_empty() {
                continue;
            }
            let resolution = quest_resolution_for(quest);
            let next_objective = if persistent { PERSISTENT_WORLD_OBJECTIVE.to_string() } else { resolution.next_objective.clone() };
            let entities = list(at(Some(state), &["worldMemory", "entities"]));
            let entity_ids = get(Some(quest), "entity_ids");
            let found = entities.iter().find(|entity| entity_ids.is_some_and(|ids| includes_of(ids, entity.get("id")))).cloned().or_else(|| current_subject(state));
            let gm_only = is_str(get(Some(quest), "visibility"), "gm_only");
            let visibility = if gm_only { "gm_only" } else { "party" };
            let subject = match found {
                Some(subject) => subject,
                None => {
                    let subject = json!({
                        "id": format!("quest-resolution-{}", digest(get(Some(quest), "id").unwrap_or(&Value::Null))),
                        "kind": "event",
                        "name": format!("Развязка: {}", clean(get(Some(quest), "title"), 160)),
                        "summary": resolution.summary,
                        "aliases": [],
                        "visibility": visibility,
                        "tags": ["quest-resolution"],
                    });
                    commands.push(json!({ "command_type": "UpsertWorldEntity", "entity": subject }));
                    subject
                }
            };
            let mut resolve = Map::new();
            resolve.insert("command_type".into(), str_value("ResolveQuest"));
            put(&mut resolve, "quest_id", get(Some(quest), "id"));
            resolve.insert("outcome".into(), str_value(resolution.outcome));
            resolve.insert("summary".into(), str_value(resolution.summary.clone()));
            resolve.insert("next_objective".into(), str_value(next_objective.clone()));
            resolve.insert("source_event_ids".into(), json!(source_event_ids));
            commands.push(object(resolve));
            let mut fingerprint = Map::new();
            put(&mut fingerprint, "quest", get(Some(quest), "id"));
            put(&mut fingerprint, "clock", get(Some(quest), "clock"));
            let mut fact = Map::new();
            fact.insert("id".into(), str_value(format!("fact-quest-resolution-{}", digest(&object(fingerprint)))));
            put(&mut fact, "subject_id", subject.get("id"));
            fact.insert("predicate".into(), str_value("quest_outcome"));
            fact.insert("object".into(), str_value(resolution.outcome));
            fact.insert("summary".into(), str_value(resolution.summary.clone()));
            fact.insert("visibility".into(), str_value(visibility));
            fact.insert("source_event_ids".into(), json!(source_event_ids));
            commands.push(json!({ "command_type": "RecordWorldFact", "fact": object(fact) }));
            // В постоянном мире цель меняет только подтверждённое завершение
            // основной истории.
            if !persistent {
                commands.push(json!({ "command_type": "UpdateObjective", "objective": next_objective }));
            }
        }
        if commands.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.run(campaign_id, &format!("{idempotency_key}:quest-resolution"), &commands)?))
    }

    /// `completeCampaignIfReady(campaignId, idempotencyKey)`: развязка кампании
    /// (или арки цепочки) с эпилогом.
    pub async fn complete_campaign_if_ready(&self, campaign_id: &str, idempotency_key: &str) -> OrchestratorResult<Option<Value>> {
        let loaded = self.load(campaign_id)?;
        let state = &loaded.state;
        if !campaign_can_auto_complete(state)? {
            return Ok(None);
        }
        // Развязку сценария выбрал исход боя; её авторский текст идёт первым.
        let ending = scenario_ending(state);
        let deterministic = build_deterministic_epilogue(state, None);
        let fallback = match &ending {
            Some(ending) => text::head(&format!("{} {deterministic}", js::string(ending.get("epilogue"))), 8_000),
            None => deterministic,
        };
        let mut epilogue = str_value(fallback);
        let mut provider = str_value("deterministic");
        if let Some(narrator) = &self.narrator {
            let brief = build_epilogue_narration_brief(state, None)?;
            let brief = match &ending {
                Some(ending) => {
                    let mut visible = vec![json!({ "event_type": "CampaignEndingReached", "payload": {
                        "title": ending.get("title").cloned().unwrap_or(Value::Null),
                        "outcome": ending.get("outcome").cloned().unwrap_or(Value::Null),
                        "summary": ending.get("epilogue").cloned().unwrap_or(Value::Null),
                    } })];
                    match nullish(brief.get("visible_events"), None) {
                        Some(Value::Array(items)) => visible.extend(items.iter().cloned()),
                        Some(other) => visible.push(other.clone()),
                        None => {}
                    }
                    with_field(&brief, "visible_events", Value::Array(visible))
                }
                None => brief,
            };
            let options = json!({ "style": "Связный русский эпилог в 3–5 предложениях: эмоциональная развязка без новых фактов и решений за героев." });
            let rendered = narrator.render(&brief, &options).await?;
            let rendered_provider = rendered.get("provider");
            if js::truthy(rendered_provider) && !js::string(rendered_provider).starts_with("deterministic") && js::truthy(rendered.get("narration")) {
                epilogue = rendered.get("narration").cloned().unwrap_or(Value::Null);
                provider = rendered_provider.cloned().unwrap_or(Value::Null);
            } else if let Some(value) = nullish(rendered_provider, None) {
                provider = value.clone();
            }
        }
        // Стол заранее объявил цепочку арок: тот же момент закрывает арку.
        if js::is_true(at(Some(state), &["campaignConcept", "arc_chain"])) && campaign_can_advance_arc(state)? {
            // Хроника арки пишется до коммита: она едет в payload события, и
            // replay не зависит от доступности провайдера.
            let chronicle = match &self.lore_author {
                Some(author) => {
                    let arc_number = js::number(at(Some(state), &["campaignConcept", "arc", "arc_number"]));
                    let arc_number = if arc_number.is_nan() || arc_number == 0.0 { 1.0 } else { arc_number };
                    let facts = list(at(Some(state), &["worldMemory", "facts"]));
                    let promises: Vec<Value> = list(at(Some(state), &["social", "promises"])).iter().filter(|entry| is_str(get(Some(entry), "status"), "open")).take(12).cloned().collect();
                    let input = json!({
                        "arcNumber": js::num(arc_number),
                        "epilogue": epilogue,
                        "facts": facts[facts.len().saturating_sub(24)..].to_vec(),
                        "promises": promises,
                    });
                    author.compose_arc_chronicle(&input).await?
                }
                None => String::new(),
            };
            let mut command = Map::new();
            command.insert("command_type".into(), str_value("AdvanceCampaignArc"));
            command.insert("reason".into(), str_value("arc_resolved_at_climax"));
            command.insert("occurred_at".into(), str_value(self.now_iso()));
            command.insert("epilogue".into(), epilogue.clone());
            if !chronicle.is_empty() {
                command.insert("chronicle".into(), str_value(chronicle));
            }
            command.insert("hook".into(), str_value(next_arc_hook(state)));
            let committed = self.run(campaign_id, &format!("{idempotency_key}:campaign-arc"), &[object(command)])?;
            return Ok(Some(js::spread(&committed, json!({ "epilogue_provider": provider, "arc_advanced": true }))));
        }
        let committed = self.run(
            campaign_id,
            &format!("{idempotency_key}:campaign-completion"),
            &[json!({ "command_type": "CompleteCampaign", "reason": "main_thread_resolved_at_climax", "occurred_at": self.now_iso(), "epilogue": epilogue })],
        )?;
        Ok(Some(js::spread(&committed, json!({ "epilogue_provider": provider }))))
    }

    /// `recordIntent(campaignId, intent, idempotencyKey, authorization, proofFactIds)`.
    pub fn record_intent(&self, campaign_id: &str, intent: &Value, idempotency_key: &str, authorization: Option<&Value>, proof_fact_ids: &[Value]) -> OrchestratorResult<Value> {
        let loaded = self.load(campaign_id)?;
        let mut provenance = Map::new();
        provenance.insert("source".into(), str_value("director"));
        provenance.insert("contract".into(), str_value("skazanie:director-intent-v1"));
        put(&mut provenance, "intent_type", intent.get("type"));
        provenance.insert("request_fingerprint".into(), str_value(digest(&json!({ "campaignId": campaign_id, "intent": intent }))));
        provenance.insert("recorded_at_ms".into(), Value::from((self.now)()));
        let mut payload = Map::new();
        payload.insert("intent".into(), intent.clone());
        payload.insert("provenance".into(), object(provenance));
        if !proof_fact_ids.is_empty() {
            payload.insert("schema_version".into(), Value::from(2));
            payload.insert("proof_fact_ids".into(), Value::Array(proof_fact_ids.to_vec()));
        }
        let policy = match authorization.filter(|value| js::truthy(Some(value))) {
            Some(authorization) => {
                let mut policy = Map::new();
                put(&mut policy, "policy", authorization.get("policy"));
                put(&mut policy, "phase", authorization.get("phase"));
                put(&mut policy, "replaced", authorization.get("replaced"));
                put(&mut policy, "reason", authorization.get("reason"));
                put(&mut policy, "proposed_type", at(Some(authorization), &["proposed_intent", "type"]));
                object(policy)
            }
            None => Value::Null,
        };
        payload.insert("policy".into(), policy);
        let pacing = js::spread(&pacing_for_director_intent(&loaded.state, intent), json!({ "provenance": { "source": "server-pacing-policy" } }));
        self.commit_events(
            campaign_id,
            &format!("{idempotency_key}:intent"),
            &[event(&format!("{idempotency_key}:intent"), "DirectorIntentRecorded", object(payload), &[], "party"), event(&format!("{idempotency_key}:pacing"), "CampaignPacingAdvanced", pacing, &[], "party")],
        )
    }

    /// `runIntent({ campaignId, intent, idempotencyKey, playerAction })`:
    /// намерение Режиссёра — запись, проверка политикой и исполнение
    /// командами движка; повтор того же ключа возвращает записанное.
    pub async fn run_intent(&self, campaign_id: &str, raw_intent: Option<&Value>, idempotency_key: Option<&Value>, player_action: Option<&Value>) -> OrchestratorResult<Value> {
        let proposed = normalize_director_intent(raw_intent)?;
        let key = {
            let cleaned = clean(idempotency_key, 120);
            if cleaned.is_empty() {
                format!("director-{}", digest(&json!({ "campaignId": campaign_id, "intent": proposed })))
            } else {
                cleaned
            }
        };
        let replay_authorization = json!({ "policy": "director-intent-policy-v1", "reason": "idempotent_replay", "replaced": false });
        if let Some(existing_completion) = self.by_key_json(campaign_id, &format!("{key}:campaign-completion"))? {
            let current = self.load(campaign_id)?;
            let intent_commit = self.by_key(campaign_id, &format!("{key}:intent"))?;
            let recorded = intent_commit.as_ref().and_then(|commit| commit.events.iter().find(|entry| type_is(entry, "DirectorIntentRecorded"))).and_then(|entry| at(Some(entry), &["payload", "intent"]));
            let intent = match recorded.filter(|value| js::truthy(Some(value))) {
                Some(recorded) => normalize_director_intent(Some(recorded))?,
                None => proposed.clone(),
            };
            return Ok(json!({
                "intent": intent,
                "authorization": replay_authorization,
                "results": [existing_completion],
                "state": current.state,
                "state_version": current.state_version,
                "admin_commands": 0,
                "duplicate": true,
            }));
        }
        let existing_intent_commit = self.by_key_json(campaign_id, &format!("{key}:intent"))?;
        let mut loaded = self.load(campaign_id)?;
        let existing_intent_record = existing_intent_commit.as_ref().and_then(|commit| list(commit.get("events")).iter().find(|entry| type_is(entry, "DirectorIntentRecorded"))).and_then(|entry| entry.get("payload")).cloned();
        let existing_intent = get(existing_intent_record.as_ref(), "intent").filter(|value| js::truthy(Some(value))).cloned();
        let existing_outcome_commit = self.by_key_json(campaign_id, &format!("{key}:director-outcome"))?;
        if let (Some(existing_intent), Some(existing_outcome)) = (&existing_intent, &existing_outcome_commit) {
            // После более позднего хода старый повтор уже не может завершать новую
            // арку. Замечено в JS: у ответа `getByIdempotencyKey` нет
            // `state_version_after`, сравнение с `NaN` всегда ложно — повтор
            // кампанию не завершает никогда; перенесено как есть.
            let completion = if js::number(Some(&Value::from(loaded.state_version))) == js::number(existing_outcome.get("state_version_after")) { self.complete_campaign_if_ready(campaign_id, &key).await? } else { None };
            loaded = self.load(campaign_id)?;
            let mut results = vec![existing_intent_commit.clone().unwrap_or(Value::Null), existing_outcome.clone()];
            results.extend(completion);
            return Ok(json!({
                "intent": normalize_director_intent(Some(existing_intent))?,
                "authorization": replay_authorization,
                "results": results,
                "state": loaded.state,
                "state_version": loaded.state_version,
                "admin_commands": 0,
                "duplicate": true,
            }));
        }
        let authorization = match &existing_intent {
            Some(existing) => {
                let mut authorization = Map::new();
                authorization.insert("intent".into(), normalize_director_intent(Some(existing))?);
                authorization.insert("proposed_intent".into(), proposed.clone());
                authorization.insert("replaced".into(), Value::Bool(false));
                put(&mut authorization, "phase", at(Some(&loaded.state), &["autonomy", "pacing", "phase"]));
                authorization.insert("policy".into(), str_value("director-intent-policy-v1"));
                authorization.insert("reason".into(), str_value("idempotent_replay"));
                object(authorization)
            }
            None => {
                let mut context = Map::new();
                context.insert("playerAction".into(), player_action.cloned().unwrap_or_else(|| str_value("")));
                authorize_director_intent(&loaded.state, Some(&proposed), Some(&object(context)))?
            }
        };
        let intent = authorization.get("intent").cloned().unwrap_or(Value::Null);
        let intent_type = js::s(intent.get("type"));
        let committed_effect = if existing_intent.is_some() && ["advance_quest_clock", "resolve_scene"].contains(&intent_type.as_str()) {
            self.by_key(campaign_id, &format!("{key}:{}", if intent_type == "resolve_scene" { "custom" } else { "commands" }))?
        } else {
            None
        };
        let effect_events: &[Value] = committed_effect.as_ref().map_or(&[], |commit| commit.events.as_slice());
        let recorded_progress = effect_events.iter().find(|entry| type_is(entry, "QuestClockAdvanced") && same(at(Some(entry), &["payload", "quest_id"]), intent.get("quest_id")));
        let mut progress_fact_ids: Vec<Value> = list(at(recorded_progress, &["payload", "proof_fact_ids"])).to_vec();
        if intent_type == "advance_quest_clock" && recorded_progress.is_none() {
            let candidates = quest_progress_evidence_for(&loaded.state, &quest_id_text(intent.get("quest_id")), false);
            let frozen_ids = get(existing_intent_record.as_ref(), "proof_fact_ids");
            let committed = self.all_events(campaign_id)?;
            let versions: HashMap<String, Option<&Value>> = committed.iter().filter_map(|entry| entry.get("event_id").and_then(Value::as_str).map(|id| (id.to_string(), entry.get("state_version_after")))).collect();
            let proven: Vec<&Value> = candidates
                .iter()
                .filter(|fact| {
                    committed.iter().any(|entry| {
                        let recorded = at(Some(entry), &["payload", "fact"]);
                        type_is(entry, "WorldFactRecorded")
                            && same(get(recorded, "id"), fact.get("id"))
                            && same(get(recorded, "subject_id"), fact.get("subject_id"))
                            && same(get(recorded, "predicate"), fact.get("predicate"))
                            && list(fact.get("source_event_ids")).iter().all(|id| {
                                let version = id.as_str().and_then(|id| versions.get(id));
                                includes_of_opt(get(recorded, "source_event_ids"), Some(id)) && version.is_some() && js::number(version.copied().flatten()) < js::number(entry.get("state_version_after"))
                            })
                    })
                })
                .collect();
            let selected: Vec<&Value> = match frozen_ids {
                Some(Value::Array(frozen)) => proven.into_iter().filter(|fact| includes(frozen, fact.get("id"))).collect(),
                _ => proven.into_iter().take(1).collect(),
            };
            let frozen_mismatch = js::truthy(frozen_ids) && length_of(frozen_ids) != Some(selected.len());
            if selected.len() != 1 || frozen_mismatch {
                return Err(RuleError::new("DIRECTOR_QUEST_PROGRESS_REQUIRED", "Часы цели продвигаются только после нового подтверждённого прогресса").into());
            }
            progress_fact_ids = selected.iter().map(|fact| fact.get("id").cloned().unwrap_or(Value::Null)).collect();
        }
        let recorded_resolution = effect_events.iter().find(|entry| type_is(entry, "SceneResolutionRecorded"));
        let resolution_proof = match nullish(at(recorded_resolution, &["payload", "evidence"]), None) {
            Some(evidence) => Some(evidence.clone()),
            None => scene_resolution_proof(&loaded.state, &intent),
        };
        if intent_type == "resolve_scene" && !js::truthy(resolution_proof.as_ref()) {
            return Err(RuleError::new("DIRECTOR_SCENE_RESOLUTION_UNPROVEN", "Развязка сцены требует подтверждённого факта, а не только предложения Директора").into());
        }
        let progress_before = director_progress_fingerprint(&loaded.state);
        self.record_intent(campaign_id, &intent, &key, Some(&authorization), &progress_fact_ids)?;
        loaded = self.load(campaign_id)?;
        let state = loaded.state.clone();
        let mut commands: Vec<Value> = Vec::new();
        let mut custom: Vec<Value> = Vec::new();
        let mut setup_commands: Vec<Value> = Vec::new();
        let mut travel: Option<Value> = None;

        if intent_type == "continue_exploration" {
            let cells = exploration_cells(&state);
            if !cells.is_empty() {
                commands.push(json!({ "command_type": "RevealArea", "cells": cells }));
            } else {
                commands.push(json!({ "command_type": "UpdateObjective", "objective": next_hook(&state, None) }));
            }
        }
        let stranger_id = scenario_stranger_npc_id(&state);
        let stranger_target = intent_type == "open_social_scene" && !stranger_id.is_empty() && is_str(intent.get("npc_id"), &stranger_id);
        let stranger_stage = if stranger_target { scenario_stranger_stage(&state) } else { None };
        if let Some(stage) = stranger_stage {
            // Незнакомец сценария: профиль, пост и выдох собирает Rules Engine
            // одной командой — исполнитель только называет шаг.
            commands.push(json!({ "command_type": "StageScenarioStranger", "stage": stage }));
            let objective = if stage == "arrive" { "Понять, чего хочет незнакомец в пепельном плаще".to_string() } else { next_hook(&state, None) };
            commands.push(json!({ "command_type": "UpdateObjective", "objective": objective }));
        } else if stranger_target {
            commands.push(json!({ "command_type": "UpdateObjective", "objective": next_hook(&state, None) }));
        } else if intent_type == "open_social_scene" {
            let mut npc = available_npc(&state, intent.get("npc_id"));
            if npc.is_none() {
                let mut options = Map::new();
                options.insert("campaignId".into(), str_value(campaign_id));
                put(&mut options, "requestedId", intent.get("npc_id"));
                options.insert("idempotencyKey".into(), str_value(key.clone()));
                let assembled = assemble_social_npc(&state, &object(options));
                setup_commands.push(json!({ "command_type": "UpsertNpcSocialProfile", "npc": assembled }));
                npc = Some(assembled).filter(|npc| js::truthy(Some(npc)));
            }
            match npc {
                Some(npc) => {
                    let mut payload = Map::new();
                    put(&mut payload, "npc_id", npc.get("id"));
                    payload.insert("server_check_required".into(), Value::Bool(true));
                    payload.insert("provenance".into(), json!({ "source": "director", "intent_type": intent.get("type") }));
                    let targets = vec![js::string(npc.get("id"))];
                    custom.push(event(&format!("{key}:social"), "SocialSceneOpened", object(payload), &targets, "party"));
                    // Имя в именительном падеже: склонять имена NPC движок не умеет.
                    commands.push(json!({ "command_type": "UpdateObjective", "objective": format!("Узнать, что скажет {}", js::string(npc.get("name"))) }));
                }
                None => commands.push(json!({ "command_type": "UpdateObjective", "objective": next_hook_with(&state, "Найти доступного очевидца") })),
            }
        }
        if intent_type == "advance_quest_clock" {
            match open_quest(&state, intent.get("quest_id")) {
                Some(quest) => {
                    let mut command = Map::new();
                    command.insert("command_type".into(), str_value("AdvanceQuestClock"));
                    put(&mut command, "quest_id", quest.get("id"));
                    command.insert("amount".into(), Value::from(1));
                    if !progress_fact_ids.is_empty() {
                        command.insert("proof_fact_ids".into(), Value::Array(progress_fact_ids.clone()));
                    }
                    commands.push(object(command));
                }
                None => commands.push(json!({ "command_type": "UpdateObjective", "objective": next_hook_with(&state, "Найти подтверждённую квестовую зацепку") })),
            }
        }
        if intent_type == "request_encounter" {
            let mut command = Map::new();
            command.insert("command_type".into(), str_value("CreateEncounter"));
            put(&mut command, "theme", intent.get("theme"));
            put(&mut command, "difficulty", intent.get("difficulty"));
            command.insert("seed".into(), str_value(format!("{campaign_id}:{key}")));
            if js::truthy(intent.get("npc_id")) {
                put(&mut command, "npc_id", intent.get("npc_id"));
            }
            commands.push(object(command));
            commands.push(json!({ "command_type": "StartCombat", "server_authoritative": true }));
        }
        let mut pending_party_decision = false;
        if intent_type == "resolve_scene" {
            let mut payload = Map::new();
            payload.insert("schema_version".into(), Value::from(SCENE_RESOLUTION_EVENT_SCHEMA_VERSION));
            payload.insert("chapter".into(), js::num(chapter_of(&state)));
            put(&mut payload, "resolution", intent.get("resolution"));
            payload.insert("status".into(), str_value("confirmed"));
            payload.insert("evidence".into(), resolution_proof.clone().unwrap_or(Value::Null));
            put(&mut payload, "intent_type", intent.get("type"));
            custom.push(event(&format!("{key}:scene-resolution"), "SceneResolutionRecorded", object(payload), &strings_of(list(state.get("partyMemberIds"))), "party"));
        }
        if intent_type == "end_scene" {
            let destination = if js::truthy(intent.get("destination")) {
                js::string(intent.get("destination"))
            } else {
                let location = at(Some(&state), &["scene", "location"]);
                format!("{} — следующая сцена", if js::truthy(location) { js::string(location) } else { "Путь".into() })
            };
            let planned = plan_server_travel(&state, &json!({ "campaignId": campaign_id, "destination": destination, "idempotencyKey": key }));
            let requested_destination = clean_text(&destination, 160);
            let mut fingerprint = Map::new();
            fingerprint.insert("campaignId".into(), str_value(campaign_id));
            fingerprint.insert("key".into(), str_value(key.clone()));
            put(&mut fingerprint, "chapter", at(Some(&state), &["adventure", "chapter"]));
            fingerprint.insert("destination".into(), str_value(requested_destination.clone()));
            let mut decision_id = format!("autonomy-{}", digest(&object(fingerprint)));
            let members = list(state.get("partyMemberIds"));
            let party_ids: Vec<String> = if !members.is_empty() { strings_of(members) } else { list(state.get("players")).iter().map(|player| js::string(player.get("id"))).collect() };
            // Голосовать за переход должен живой герой.
            let preferred = js::s(state.get("activePlayerId"));
            let actor_id = if !preferred.is_empty() && !is_unresolved_dead_hero(&state, &preferred) { preferred } else { loot_owner_id(&state) };
            let current_decision = state.get("agentInteraction");
            let decision_resolved = transition_decision_matches(current_decision, Some(&str_value(decision_id.clone())), Some(&str_value(requested_destination.clone())));
            if decision_resolved {
                decision_id = js::string(get(current_decision, "id"));
            }
            pending_party_decision = !decision_resolved;
            if !decision_resolved && (!js::truthy(current_decision) || is_str(get(current_decision, "status"), "resolved")) {
                let interaction = json!({
                    "id": decision_id,
                    "type": "vote",
                    "title": "Продолжить путь",
                    "description": format!("Отряд подтверждает переход в {destination}."),
                    "options": [{ "id": "continue", "label": format!("Перейти в {requested_destination}") }],
                    "destinationLocationId": requested_destination,
                    "resolutionPrompt": "Продолжить подтверждённый переход.",
                });
                let actor = (!actor_id.is_empty()).then(|| str_value(actor_id.clone()));
                custom.push(party_decision_opened_event(&interaction, actor.as_ref(), &json!({ "eligibleHeroIds": party_ids }))?);
            }
            commands.push(json!({ "command_type": "AdvanceScene", "scene_args": {
                "title": destination,
                "location": destination,
                "objective": next_hook(&state, None),
                "transition": format!("Завершив текущую сцену, отряд направляется в {destination}."),
                "hook": next_hook(&state, None),
                "seed": format!("{campaign_id}:{key}:scene"),
            }, "party_decision": { "interaction_id": decision_id, "resolved_option_id": "continue" } }));
            let mut advance = Map::new();
            advance.insert("command_type".into(), str_value("AdvanceTime"));
            put(&mut advance, "amount", planned.get("duration_minutes"));
            advance.insert("unit".into(), str_value("minute"));
            commands.insert(0, object(advance));
            if js::truthy(planned.get("random_encounter")) {
                let mut command = Map::new();
                command.insert("command_type".into(), str_value("CreateEncounter"));
                put(&mut command, "theme", at(Some(&planned), &["encounter", "theme"]));
                put(&mut command, "difficulty", at(Some(&planned), &["encounter", "difficulty"]));
                command.insert("seed".into(), str_value(format!("{campaign_id}:{}:random-encounter", js::string(planned.get("travel_id")))));
                commands.push(object(command));
                commands.push(json!({ "command_type": "StartCombat", "server_authoritative": true }));
            }
            travel = Some(planned);
        }
        if intent_type == "offer_next_hook" {
            commands.push(json!({ "command_type": "UpdateObjective", "objective": next_hook(&state, intent.get("hook")) }));
        }

        let mut results: Vec<Value> = Vec::new();
        if !setup_commands.is_empty() {
            results.push(self.run(campaign_id, &format!("{key}:setup"), &setup_commands)?);
        }
        if !custom.is_empty() {
            results.push(self.commit_events(campaign_id, &format!("{key}:custom"), &custom)?);
        }
        if pending_party_decision {
            loaded = self.load(campaign_id)?;
            return Ok(json!({ "intent": intent, "authorization": authorization, "results": results, "pending_party_decision": true, "state": loaded.state, "state_version": loaded.state_version, "admin_commands": 0 }));
        }
        if !commands.is_empty() {
            results.push(self.run(campaign_id, &format!("{key}:commands"), &commands)?);
        }
        let source_events: Vec<Value> = results.iter().flat_map(|result| list(result.get("events")).iter().cloned()).collect();
        if let Some(resolution) = self.resolve_triggered_quests(campaign_id, &key, &source_events)? {
            results.push(resolution);
        }
        if let Some(travel) = &travel {
            let party = &strings_of(list(state.get("partyMemberIds")));
            let mut travel_events = vec![event(&format!("{key}:travel"), "TravelResolved", js::spread(travel, json!({ "provenance": { "source": "server-travel-policy" } })), party, "party")];
            if js::truthy(travel.get("random_encounter")) {
                let mut payload = Map::new();
                put(&mut payload, "travel_id", travel.get("travel_id"));
                put(&mut payload, "theme", at(Some(travel), &["encounter", "theme"]));
                put(&mut payload, "difficulty", at(Some(travel), &["encounter", "difficulty"]));
                put(&mut payload, "risk_score", travel.get("risk_score"));
                payload.insert("provenance".into(), json!({ "source": "server-travel-policy" }));
                travel_events.push(event(&format!("{key}:random-encounter"), "RandomEncounterTriggered", object(payload), party, "party"));
            }
            results.push(self.commit_events(campaign_id, &format!("{key}:travel"), &travel_events)?);
        }
        loaded = self.load(campaign_id)?;
        if clean(at(Some(&loaded.state), &["scene", "objective"]), 300).is_empty() {
            results.push(self.run(campaign_id, &format!("{key}:failsafe-hook"), &[json!({ "command_type": "UpdateObjective", "objective": next_hook(&loaded.state, None) })])?);
            loaded = self.load(campaign_id)?;
        }
        let progress_after = director_progress_fingerprint(&loaded.state);
        let outcome = self.commit_events(
            campaign_id,
            &format!("{key}:director-outcome"),
            &[event(
                &format!("{key}:director-outcome"),
                "DirectorIntentOutcomeRecorded",
                {
                    let mut payload = Map::new();
                    put(&mut payload, "intent_type", intent.get("type"));
                    payload.insert("state_changed".into(), Value::Bool(progress_before != progress_after));
                    payload.insert("progress_before".into(), str_value(progress_before));
                    payload.insert("progress_after".into(), str_value(progress_after));
                    payload.insert("policy".into(), str_value("director-anti-stall-v1"));
                    object(payload)
                },
                &[],
                "party",
            )],
        )?;
        results.push(outcome);
        if let Some(completion) = self.complete_campaign_if_ready(campaign_id, &key).await? {
            results.push(completion);
        }
        loaded = self.load(campaign_id)?;
        Ok(json!({ "intent": intent, "authorization": authorization, "results": results, "state": loaded.state, "state_version": loaded.state_version, "admin_commands": 0 }))
    }

    /// `routedFreeAction(...)`: ответ без коммита на маршрут, который назвал
    /// судья (`travel`, `talk`, `clarify`); `None` — заявку судят как попытку.
    /// В бою переход и разговор не предлагаются; ответ игрока на уточнение
    /// маршрут не повторяет.
    fn routed_free_action(&self, loaded: &Loaded, actor_id: &str, action: &str, reading: &Value, idempotency_key: &str, campaign_id: &str) -> Option<Value> {
        let route = js::string(nullish(get(Some(reading), "route"), None).or(Some(&str_value("check"))));
        if route == "check" || text::test(re!(r"Уточнение игрока:", "u"), action) {
            return None;
        }
        let in_combat = js::truthy(at(Some(&loaded.state), &["mechanics", "combat", "active"]));
        if in_combat && route != "clarify" {
            return None;
        }
        let unchanged = json!({
            "turn_consumed": false, "admin_commands": 0, "state": loaded.state, "state_version": loaded.state_version,
            "events": [], "commands": [], "rolls": [], "duplicate": false, "route_hint": { "route": route },
        });
        if route == "travel" {
            // «Другой город», «куда-нибудь», «подальше» — не название места.
            let named = clean(get(Some(reading), "destination"), 80);
            let destination = if text::test(re!(r"^(?:в\s+)?(?:друг\p{L}*\s+\p{L}+|куда[-\s]?(?:нибудь|угодно|то)|подальше|прочь|отсюда|в\s+путь|дальше)$", "iu"), &named) { String::new() } else { named };
            self.remember_route_hint(campaign_id, idempotency_key, json!({ "route": route, "destination": destination, "actor_id": actor_id }));
            let phrase = if destination.is_empty() { "Уходим отсюда".to_string() } else { format!("Отправляемся в «{destination}»") };
            let narration = if destination.is_empty() { "Куда именно? Назовите место — дорогу отряд выбирает вместе.".to_string() } else { format!("«{destination}»? Дорогу отряд выбирает вместе: напишите «{phrase}», и все решат голосованием.") };
            return Some(js::spread(&unchanged, json!({ "kind": "route_travel", "route_hint": { "route": route, "destination": destination }, "narration": narration })));
        }
        if route == "talk" {
            let hint = js::s(get(Some(reading), "npc_hint"));
            let npc = list(at(Some(&loaded.state), &["social", "npcs"])).iter().find(|entry| js::string(get(Some(entry), "id")) == hint);
            let name = clean(get(npc, "name"), 80);
            let narration = if name.is_empty() { "Это разговор — назовите, к кому обращается герой, и скажите прямо: «Имя, …».".to_string() } else { format!("Это разговор — скажите прямо, от лица героя: «{name}, …», и вам ответят.") };
            let npc_hint = if name.is_empty() { String::new() } else { js::string(get(npc, "id")) };
            return Some(js::spread(&unchanged, json!({ "kind": "clarification", "route_hint": { "route": route, "npc_hint": npc_hint }, "narration": narration })));
        }
        let narration = format!(
            "Не совсем понял, что делает {}. Опишите действие: что, с чем или с кем и чего хотите добиться. Если это вопрос ко мне или реплика для отряда — так и скажите.",
            hero_name_for_text(&loaded.state, actor_id)
        );
        Some(js::spread(&unchanged, json!({ "kind": "clarification", "narration": narration })))
    }

    /// `rememberRouteHint(campaignId, idempotencyKey, hint)`: подсказка живёт
    /// только до ответа на тот же запрос; не больше 200 и не дольше двух минут.
    pub fn remember_route_hint(&self, campaign_id: &str, idempotency_key: &str, hint: Value) {
        let key = format!("{campaign_id}\u{0}{idempotency_key}");
        let mut hints = lock(&self.route_hints);
        hints.shift_remove(&key);
        hints.insert(key, with_field(&hint, "expires_at", Value::from(clock::now_ms() + 120_000)));
        while hints.len() > 200 {
            hints.shift_remove_index(0);
        }
    }

    /// `takeRouteHint(campaignId, idempotencyKey)`: забрать подсказку; повторно
    /// её не отдать.
    pub fn take_route_hint(&self, campaign_id: &str, idempotency_key: &str) -> Option<Value> {
        let key = format!("{campaign_id}\u{0}{idempotency_key}");
        let hint = lock(&self.route_hints).shift_remove(&key)?;
        if js::number(hint.get("expires_at")) < clock::now_ms() as f64 {
            return None;
        }
        let mut rest = hint;
        js::delete(&mut rest, "expires_at");
        Some(rest)
    }

    /// `handleUnknownAction({ campaignId, action, idempotencyKey, playerId,
    /// intent, verifiedRoll, confirmedAction })`: свободное действие героя —
    /// судейство как у живого ведущего. Смысл задумки понимает судья (если он
    /// есть); СЛ, бросок, сверка средств, цена хода и последствие — сервер.
    pub async fn handle_unknown_action(&self, request: &UnknownAction) -> OrchestratorResult<Value> {
        let campaign_id = request.campaign_id.as_str();
        let idempotency_key = request.idempotency_key.as_str();
        let action = clean(Some(&request.action), 1_000);
        let previous_commit = self.by_key_json(campaign_id, idempotency_key)?;
        let previous_events = list(previous_commit.as_ref().and_then(|commit| commit.get("events")));
        // Повтор и восстановление после первой фиксации используют исходную
        // обстановку: уже потраченный слот не должен превращать успех в отказ.
        let loaded = match previous_events.first() {
            Some(first) => self.event_store.load_at(campaign_id, js::safe_int(first.get("state_version_before"), 0))?,
            None => self.load(campaign_id)?,
        };
        let state = &loaded.state;
        let actor_id = clean(Some(&request.player_id), 120);
        let actor_value = str_value(actor_id.clone());
        let meta = agent_context_metadata(
            state,
            &AgentContextOptions { role: Some(&str_value("action_adjudicator")), actor_id: Some(&actor_value), target_id: None, contract_version: Some(&str_value(ACTION_ADJUDICATOR_PROMPT_VERSION)) },
        );
        let meta = Some(&meta);
        let declaration = declared_action_command(&actor_id, &action);
        let version = std::cell::Cell::new(loaded.state_version);
        let in_combat = js::truthy(at(Some(state), &["mechanics", "combat", "active"]));
        let run = |commands: Vec<Option<Value>>| -> OrchestratorResult<Value> {
            let actual: Vec<Value> = commands.into_iter().flatten().filter(|command| js::truthy(Some(command))).collect();
            if actual.is_empty() {
                return Ok(json!({ "state": state, "state_version": loaded.state_version, "events": [], "commands": [], "rolls": [], "duplicate": false }));
            }
            let committed = self.run_commands(campaign_id, idempotency_key, &actual, &json!({ "allowedActorIds": [actor_id] }), Some(version.get()))?;
            if let Some(next) = committed.get("state_version").and_then(Value::as_i64) {
                version.set(next);
            }
            let memory_commands = material_consequence_commands(committed.get("state").unwrap_or(state), true, Some(committed.get("events").unwrap_or(&json!([]))));
            if memory_commands.is_empty() {
                return Ok(committed);
            }
            let memory = self.run_commands(campaign_id, &format!("{idempotency_key}:material-memory"), &memory_commands, &json!({}), Some(version.get()))?;
            if let Some(next) = memory.get("state_version").and_then(Value::as_i64) {
                version.set(next);
            }
            let mut events = list(committed.get("events")).to_vec();
            events.extend(list(memory.get("events")).iter().cloned());
            let mut commands = list(committed.get("commands")).to_vec();
            commands.extend(list(memory.get("commands")).iter().cloned());
            Ok(js::spread(
                &committed,
                json!({ "state": memory.get("state").cloned().unwrap_or(Value::Null), "state_version": memory.get("state_version").cloned().unwrap_or(Value::Null), "events": events, "commands": commands }),
            ))
        };
        let verify_duplicate = |commit: Option<&Value>, requires_ruling: bool| -> OrchestratorResult<()> {
            let Some(commit) = commit.filter(|commit| js::truthy(commit.get("duplicate"))) else { return Ok(()) };
            let events = list(commit.get("events"));
            let conflict = || OrchestratorError::coded("IDEMPOTENCY_CONFLICT", "Этот ключ идемпотентности уже использован для другого свободного действия");
            if let Some(declared) = events.iter().find(|entry| type_is(entry, "ActionDeclared")) {
                if js::s(at(Some(declared), &["payload", "action"])) != action {
                    return Err(conflict());
                }
            }
            let ruling = events.iter().find(|entry| type_is(entry, "RulingRecorded"));
            if requires_ruling && ruling.is_none_or(|ruling| js::s(at(Some(ruling), &["payload", "ruling", "provenance", "action_fingerprint"])) != digest_text(&action)) {
                return Err(conflict());
            }
            Ok(())
        };
        let plain = |meta: Option<&Value>, kind: &str, narration: Value| -> Value {
            let mut map = Map::new();
            put(&mut map, "context_metadata", meta);
            map.insert("kind".into(), str_value(kind));
            map.insert("narration".into(), narration);
            map.insert("turn_consumed".into(), Value::Bool(false));
            map.insert("admin_commands".into(), Value::from(0));
            map.insert("state".into(), state.clone());
            map.insert("state_version".into(), Value::from(loaded.state_version));
            map.insert("events".into(), json!([]));
            map.insert("commands".into(), json!([]));
            map.insert("rolls".into(), json!([]));
            map.insert("duplicate".into(), Value::Bool(false));
            object(map)
        };
        let committed_reply = |meta: Option<&Value>, kind: &str, narration: Value, commit: &Value| -> Value {
            let mut map = Map::new();
            put(&mut map, "context_metadata", meta);
            map.insert("kind".into(), str_value(kind));
            map.insert("narration".into(), narration);
            map.insert("turn_consumed".into(), Value::Bool(false));
            map.insert("admin_commands".into(), Value::from(0));
            map.insert("state".into(), nullish(commit.get("state"), Some(state)).cloned().unwrap_or(Value::Null));
            map.insert("state_version".into(), nullish(commit.get("state_version"), None).cloned().unwrap_or_else(|| Value::from(loaded.state_version)));
            map.insert("events".into(), Value::Array(list(commit.get("events")).to_vec()));
            map.insert("commands".into(), Value::Array(list(commit.get("commands")).to_vec()));
            map.insert("rolls".into(), Value::Array(list(commit.get("rolls")).to_vec()));
            map.insert("duplicate".into(), Value::Bool(js::truthy(commit.get("duplicate"))));
            object(map)
        };

        let actor = game::find_actor(state, &actor_id);
        let incapacitating = if actor.is_some() { incapacitating_condition_for(state, &actor_id) } else { None };
        if !actor.is_some_and(game::is_living_actor) || incapacitating.is_some() {
            let narration = match actor {
                None => "Герой для действия не найден.".to_string(),
                Some(actor) => incapacitated_action_refusal(Some(actor), incapacitating),
            };
            return Ok(json!({
                "kind": "rejected", "narration": narration, "turn_consumed": false, "rejected": true, "admin_commands": 0,
                "state": state, "state_version": loaded.state_version, "events": [], "commands": [], "rolls": [], "duplicate": false,
            }));
        }
        let combat = at(Some(state), &["mechanics", "combat"]);
        let current_actor_id = js::s(get(index_of(get(combat, "initiative"), get(combat, "active_index")), "actor_id"));
        if in_combat && !current_actor_id.is_empty() && current_actor_id != actor_id {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            let mut reply = committed_reply(None, "rejected", str_value("Сейчас действует другой участник. Действие не выполнено, и ваш ход не потрачен."), &commit);
            insert_after(&mut reply, "turn_consumed", "rejected", Value::Bool(true));
            return Ok(reply);
        }
        let free_action_kind = match nullish(get(request.intent.as_ref(), "free_action_kind"), None) {
            Some(kind) => Some(kind.clone()),
            None => classify_free_action_kind(Some(&str_value(action.clone()))).map(str_value),
        };
        let kind_is = |name: &str| is_str(free_action_kind.as_ref(), name);
        if kind_is("compound_maneuver") || kind_is("compound_ranged_attack") {
            let narration = if kind_is("compound_ranged_attack") {
                "Связка подхода и выстрела пока не поддерживается. Выберите перемещение на карте и затем дальнюю атаку. Заявка не выполнена и ничего не расходует."
            } else {
                "В вашей заявке есть прыжок и атака. Пока я не умею связывать их в один манёвр с перемещением и приземлением. Действие не выполнено: выберите перемещение на карте и затем атаку или опишите отдельную импровизацию. Попытка ничего не расходует."
            };
            return Ok(plain(None, "clarification", str_value(narration)));
        }
        verify_duplicate(previous_commit.as_ref(), false)?;
        if let Some(transfer) = resolve_inventory_transfer(state, &actor_id, &action, &json!({})).filter(|transfer| is_str(transfer.get("status"), "command")) {
            let commit = run(vec![declaration.clone(), transfer.get("command").cloned()])?;
            verify_duplicate(Some(&commit), false)?;
            let mut reply = committed_reply(None, "item_transfer", transfer.get("narration").cloned().unwrap_or(Value::Null), &commit);
            reply["state"] = commit.get("state").cloned().unwrap_or(Value::Null);
            reply["state_version"] = commit.get("state_version").cloned().unwrap_or(Value::Null);
            return Ok(reply);
        }
        if let Some(exploration) = resolve_exploration_command(state, &actor_id, &action) {
            if is_str(exploration.get("status"), "clarification") {
                return Ok(unchanged_first(&plain(None, "clarification", exploration.get("narration").cloned().unwrap_or(Value::Null))));
            }
            if js::truthy(exploration.get("requires_confirmation")) && !request.confirmed_action && previous_commit.is_none() {
                self.rules_engine.validate(exploration.get("command").unwrap_or(&Value::Null), state, &json!({ "allowedActorIds": [actor_id] }))?;
                let mut reply = unchanged_first(&plain(None, "counter_offer", exploration.get("confirmation").cloned().unwrap_or(Value::Null)));
                reply["confirmation_required"] = Value::Bool(true);
                return Ok(reply);
            }
            // Подход к лестнице и подъём — два шага одного коммита.
            let mut commands = vec![declaration.clone()];
            match nullish(exploration.get("commands"), None) {
                Some(Value::Array(items)) => commands.extend(items.iter().cloned().map(Some)),
                Some(other) => commands.push(Some(other.clone())),
                None => commands.push(exploration.get("command").cloned()),
            }
            let attempt = run(commands).and_then(|commit| verify_duplicate(Some(&commit), false).map(|_| commit));
            return match attempt {
                Ok(commit) => {
                    let events = list(commit.get("events"));
                    let door = events.iter().find(|entry| type_is(entry, "DoorStateChanged"));
                    let forced = events.iter().find(|entry| ["DoorForced", "DoorLockpicked", "DoorBarricadeForced"].contains(&js::s(entry.get("event_type")).as_str()));
                    let narration = if let Some(door) = door {
                        str_value(if is_str(at(Some(door), &["payload", "state"]), "closed") { "Дверь закрыта." } else { "Дверь открыта; проход можно использовать." })
                    } else if let Some(forced) = forced {
                        let success = js::truthy(at(Some(forced), &["payload", "success"]));
                        str_value(if type_is(forced, "DoorBarricadeForced") {
                            if success {
                                "Баррикада убрана. Дверью снова можно пользоваться."
                            } else {
                                "Баррикада не поддалась. Можно изменить способ или выбрать другой проход."
                            }
                        } else if success {
                            "Замок преодолён, проход открыт."
                        } else {
                            "Замок не поддался. Можно изменить способ или выбрать другой проход."
                        })
                    } else {
                        exploration.get("narration").cloned().unwrap_or(Value::Null)
                    };
                    let mut reply = unchanged_first(&plain(None, "scene_interaction", narration));
                    reply["state"] = commit.get("state").cloned().unwrap_or(Value::Null);
                    reply["state_version"] = commit.get("state_version").cloned().unwrap_or(Value::Null);
                    reply["events"] = Value::Array(list(commit.get("events")).to_vec());
                    reply["commands"] = Value::Array(list(commit.get("commands")).to_vec());
                    reply["rolls"] = Value::Array(list(commit.get("rolls")).to_vec());
                    reply["duplicate"] = Value::Bool(js::truthy(commit.get("duplicate")));
                    Ok(reply)
                }
                Err(error) if error.is_rules_validation() => Ok(unchanged_first(&plain(None, "clarification", str_value(format!("{}. Измените способ или выберите доступную цель на карте.", error.message()))))),
                Err(error) => Err(error),
            };
        }
        let fresh = previous_events.is_empty();
        let passage_plan = if fresh { free_action_passage_plan(state, &actor_id, &action) } else { json!({ "status": "not_applicable" }) };
        // «Подхожу к баркасу и осматриваю его»: сначала шаги по карте, потом
        // сама попытка, в том же коммите. Вне боя.
        let approach_plan = if fresh && is_str(passage_plan.get("status"), "not_applicable") && !in_combat { free_action_approach_plan(state, &actor_id, &action) } else { json!({ "status": "not_applicable" }) };
        let approach_move: Vec<Option<Value>> = if is_str(approach_plan.get("status"), "ready") && js::truthy(approach_plan.get("remainder")) {
            let mut command = Map::new();
            command.insert("command_type".into(), str_value("MoveActor"));
            command.insert("actor_id".into(), str_value(actor_id.clone()));
            put(&mut command, "to", at(Some(&approach_plan), &["destination", "to"]));
            command.insert("server_authoritative".into(), Value::Bool(true));
            vec![Some(object(command))]
        } else {
            Vec::new()
        };
        // Постройка из заявки — другое место карты мира: ведущий зовёт в путь.
        let far_place = if is_str(passage_plan.get("reason"), "destination_mismatch") && !in_combat { passage_destination_place(state, &action) } else { String::new() };
        if !far_place.is_empty() {
            self.remember_route_hint(campaign_id, idempotency_key, json!({ "route": "travel", "destination": far_place, "actor_id": actor_id }));
            let mut reply = plain(meta, "route_travel", str_value(format!("«{far_place}» — не здесь: до него ещё дорога.")));
            insert_after(&mut reply, "kind", "route_hint", json!({ "route": "travel", "destination": far_place }));
            return Ok(reply);
        }
        let passage_status = js::s(passage_plan.get("status"));
        if ["blocked", "already_inside", "ambiguous"].contains(&passage_status.as_str()) {
            let hero = list(state.get("players")).iter().find(|player| js::string(get(Some(player), "id")) == actor_id);
            let hero_name = match get(hero, "character") {
                Some(name) if js::truthy(Some(name)) => js::string(Some(name)),
                _ => "Герой".to_string(),
            };
            let narration = if passage_status == "ambiguous" {
                format!("Входов рядом несколько, и все одинаково близко — в какой идёт {hero_name}? Укажите дверь на карте.")
            } else if passage_status == "already_inside" {
                let location = at(Some(state), &["scene", "location"]);
                let inside = if js::truthy(location) { format!(" — внутри «{}»", text::head(&js::string(location), 80)) } else { String::new() };
                format!("{hero_name} уже под крышей{inside}: дверь позади, можно осмотреться.")
            } else if is_str(passage_plan.get("reason"), "destination_mismatch") {
                "Здесь такого здания нет — до него ещё надо дойти.".to_string()
            } else if is_str(passage_plan.get("reason"), "alternate_route") {
                "Так не пролезть: нужен лаз — окно, пролом или щель. Укажите его на карте.".to_string()
            } else {
                "Дверь закрыта — откройте её на карте, и можно входить.".to_string()
            };
            return Ok(plain(meta, "clarification", str_value(narration)));
        }
        if action.encode_utf16().count() < 8 || is_noise(&action) || text::test(re!(r"^(?:это|туда|сделать|что-то|как-нибудь)[?.!]*$", "iu"), &action) {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            return Ok(committed_reply(None, "clarification", str_value("Опишите действие подробнее: что делает герой, с чем или с кем и какого результата хочет добиться."), &commit));
        }
        if kind_is("physically_impossible") {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            return Ok(committed_reply(None, "clarification", str_value("Для такого действия нужен подтверждённый способ — конкретное заклинание, предмет или способность героя. Укажите его, и я проверю допустимый вариант."), &commit));
        }
        // Частая фраза про существующий реквизит — та же OperateSceneObject,
        // что у кнопок; раскрытие — по авторитетной карте (не оракул по
        // неразведанной части подземелья).
        let scene_props = match at(Some(state), &["scene", "map", "props"]) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let position = game::actor_position(state, &actor_id).map(|point| json!({ "x": point.x, "y": point.y })).unwrap_or(Value::Null);
        let revealed = revealed_prop_predicate(state);
        let action_value = str_value(action.clone());
        let named_scene_object = nearest_scene_object_command(Some(&Value::Array(scene_props.clone())), Some(&position), Some(&action_value));
        let scene_object_command = if named_scene_object.is_some() {
            let visible: Vec<Value> = scene_props.iter().filter(|prop| revealed.test(prop)).cloned().collect();
            nearest_scene_object_command(Some(&Value::Array(visible)), Some(&position), Some(&action_value))
        } else {
            None
        };
        if named_scene_object.is_some() && scene_object_command.is_none() {
            return Ok(plain(None, "clarification", str_value("Отсюда такого не видно. Подойдите ближе или осмотритесь: на вашей карте этого места ещё нет.")));
        }
        if let Some(command) = scene_object_command {
            let command = js::spread(&command, json!({ "actor_id": actor_id, "server_authoritative": true }));
            let attempt = run(vec![declaration.clone(), Some(command)]).and_then(|commit| verify_duplicate(Some(&commit), false).map(|_| commit));
            return match attempt {
                Ok(commit) => {
                    let events = commit.get("events").cloned().unwrap_or(json!([]));
                    let narration = scene_interaction_narration(Some(&events));
                    let narration = if narration.is_empty() { "Герой взаимодействует с объектом сцены; результат подтверждён правилами.".to_string() } else { narration };
                    let mut reply = committed_reply(None, "scene_interaction", str_value(narration), &commit);
                    reply["turn_consumed"] = Value::Bool(spent_action(list(Some(&events))));
                    Ok(reply)
                }
                // Предмет выбирает текст игрока, досягаемость и состояние —
                // движок: это ответ правил игроку, а не ошибка запроса.
                Err(error) if error.is_rules_validation() => Ok(plain(None, "clarification", str_value(format!("{}.", error.message())))),
                Err(error) => Err(error),
            };
        }
        let deterministic_reading = interpret_free_action(&action);
        // Вторая фаза ручного броска: прочтение зафиксировано вместе с
        // проверкой в реестре — модель заново не спрашивают.
        let verified_roll = request.verified_roll.as_ref();
        let roll_context = get(verified_roll, "context");
        let stored_reading = if is_str(get(roll_context, "kind"), "free_action") && js::s(get(roll_context, "action_fingerprint")) == digest_text(&action) {
            nullish(get(roll_context, "reading"), None).cloned()
        } else {
            None
        };
        if verified_roll.is_some() {
            assert_free_action_confirmation(roll_context, &action, Some(&Value::from(loaded.state_version)))?;
        }
        let harmless_reading = match harmless_free_action_reading(state, &actor_id, &action) {
            Some(reading) => Some(reading),
            None if js::is_true(get(request.intent.as_ref(), "roleplay_speech")) => roleplay_speech_reading(state, &action),
            None => None,
        };
        let harmless_reading = harmless_reading.filter(|reading| !reading.is_null());
        let proposed_reading = match (&stored_reading, &harmless_reading, &self.action_adjudicator) {
            (Some(stored), _, _) => stored.clone(),
            (None, Some(harmless), _) => harmless.clone(),
            (None, None, Some(adjudicator)) => adjudicator.read(state, &actor_id, &action, &deterministic_reading).await?,
            (None, None, None) => deterministic_reading.clone(),
        };
        // Бриф мог быть собран до параллельного коммита: прочтение к
        // изменившейся сцене не применяется, кроме фоновой записи памяти.
        let may_await = stored_reading.is_none() && harmless_reading.is_none() && self.action_adjudicator.as_ref().is_some_and(|adjudicator| adjudicator.awaits_model());
        if may_await {
            let after = self.load(campaign_id)?;
            if after.state_version != loaded.state_version {
                if self.only_background_memory_changed(campaign_id, loaded.state_version, after.state_version)? {
                    version.set(after.state_version);
                } else {
                    let mut reply = plain(meta, "clarification", str_value("Обстановка изменилась, пока ведущий разбирал действие. Отправьте его ещё раз: цель и цена будут проверены заново."));
                    reply["state"] = after.state;
                    reply["state_version"] = Value::from(after.state_version);
                    return Ok(reply);
                }
            }
        }
        // Маршрут заявки (контракт судьи): переход, разговор или переспрос —
        // без коммита. Повтор исполненной заявки маршрут не пересчитывает.
        if stored_reading.is_none() && harmless_reading.is_none() && previous_events.is_empty() {
            if let Some(routed) = self.routed_free_action(&loaded, &actor_id, &action, &proposed_reading, idempotency_key, campaign_id) {
                let mut map = Map::new();
                put(&mut map, "context_metadata", meta);
                if let Value::Object(fields) = routed {
                    map.extend(fields);
                }
                return Ok(object(map));
            }
        }
        let mut reading = bind_free_action_reading_to_state(state, &actor_id, &action, &proposed_reading, stored_reading.is_some())?;
        let field = |reading: &Value, key: &str| reading.get(key).cloned();
        let ambiguities = list(reading.get("reference_ambiguities")).to_vec();
        // «Обыскивает тело прислужника» при двух прислужниках — обыск ближнего.
        let corpse_target_only = free_action_is_corpse_search(&action) && ambiguities.iter().all(|entry| is_str(Some(entry), "target_id"));
        if !ambiguities.is_empty() && !corpse_target_only {
            let narration = if includes(&ambiguities, Some(&str_value("item_id"))) {
                "В действии подходит несколько или не подтверждён предмет. Назовите конкретную вещь."
            } else if includes(&ambiguities, Some(&str_value("prop_id"))) {
                "Назовите конкретный видимый предмет обстановки из текущей сцены."
            } else {
                "Кого именно? Здесь таких несколько — назовите по имени."
            };
            return Ok(plain(meta, "clarification", str_value(narration)));
        }
        // Мост между свободной фразой и обстановкой как оружием: всё
        // остальное считает та же OperateSceneObject, что у кнопок пропса.
        let scene_prop_intent = scene_prop_intent_for(&js::s(reading.get("effect")));
        if let Some(intent) = scene_prop_intent.filter(|_| js::truthy(reading.get("prop_id"))) {
            let mut command = Map::new();
            command.insert("command_type".into(), str_value("OperateSceneObject"));
            command.insert("actor_id".into(), str_value(actor_id.clone()));
            put(&mut command, "prop_id", reading.get("prop_id"));
            command.insert("intent".into(), str_value(intent));
            command.insert("approach".into(), str_value("hand"));
            command.insert("server_authoritative".into(), Value::Bool(true));
            let attempt = run(vec![declaration.clone(), Some(object(command))]).and_then(|commit| verify_duplicate(Some(&commit), false).map(|_| commit));
            return match attempt {
                Ok(commit) => {
                    let events = list(commit.get("events")).to_vec();
                    let hazard_state = nullish(commit.get("state"), Some(state)).cloned().unwrap_or(Value::Null);
                    let narration = scene_hazard_narration(&events, &hazard_state).filter(|text| !text.is_empty()).unwrap_or_else(|| {
                        let interaction = scene_interaction_narration(Some(&Value::Array(events.clone())));
                        if interaction.is_empty() {
                            "Герой обращает обстановку против противника; результат подтверждён правилами.".to_string()
                        } else {
                            interaction
                        }
                    });
                    let mut reply = committed_reply(meta, "scene_interaction", str_value(narration), &commit);
                    reply["turn_consumed"] = Value::Bool(spent_action(&events));
                    reply["state"] = hazard_state;
                    Ok(reply)
                }
                // «Нечем поджечь», «встаньте вплотную» — честный ответ правил.
                Err(error) if error.is_rules_validation() => Ok(plain(meta, "clarification", str_value(format!("{}.", error.message())))),
                Err(error) => Err(error),
            };
        }
        // Намеренный контакт с опасностью — заявленный самоурон, а не
        // проверка «избежать» её.
        let hazard_contact = if is_str(reading.get("policy_version"), FREE_ACTION_RESOLUTION_POLICY_VERSION) { resolve_hazard_contact(state, &actor_id, &action, &reading) } else { None };
        let contact_status = js::s(get(hazard_contact.as_ref(), "status"));
        let contact = contact_status == "contact";
        let hazard_means = if contact { verify_means(state, &actor_id, reading.get("required_means")) } else { json!({ "satisfied": true, "missing": [] }) };
        let hazard_resolution = if contact { Some(contextual_resolution_for(state, &actor_id, &reading, &action)) } else { None };
        let missing_text = |means: &Value| {
            let missing = list(means.get("missing"));
            if missing.is_empty() {
                "Одной сноровкой тут не обойтись. Если у героя есть подходящее заклинание, умение или предмет — назовите его или предложите другой способ.".to_string()
            } else {
                format!(
                    "Так не выйдет — не хватает главного: {}. {} таким не располагает. Попробуйте иначе — тем, что есть под рукой.",
                    missing.iter().map(|entry| js::s(Some(entry))).collect::<Vec<_>>().join(", "),
                    hero_name_for_text(state, &actor_id)
                )
            }
        };
        if contact && (!js::truthy(hazard_means.get("satisfied")) || is_str(get(hazard_resolution.as_ref(), "mode"), "counter_offer")) {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            return Ok(committed_reply(meta, "counter_offer", str_value(missing_text(&hazard_means)), &commit));
        }
        if contact_status == "unavailable" {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            let narration = format!("{} Уточните место или сначала подойдите ближе; действие пока не выполнено.", js::string(get(hazard_contact.as_ref(), "reason")));
            return Ok(committed_reply(meta, "clarification", str_value(narration), &commit));
        }
        if let Some(hazard) = hazard_contact.as_ref().filter(|_| contact) {
            let action_cost = self.action_cost(state, &actor_id, in_combat, reading.get("action_cost"));
            if in_combat && !js::truthy(action_cost.get("available")) {
                let commit = run(vec![declaration.clone()])?;
                verify_duplicate(Some(&commit), false)?;
                let narration = format!("На этом ходу {} уже потрачено. Контакт с опасностью не выполнен.", js::string(action_cost.get("slot")));
                return Ok(committed_reply(meta, "clarification", str_value(narration), &commit));
            }
            let ruling_id = format!("ruling-{}", digest(&json!({ "campaignId": campaign_id, "text": action })));
            let mut interpretation = Map::new();
            put(&mut interpretation, "hazard", hazard.get("hazard_id"));
            put(&mut interpretation, "damage_type", hazard.get("damage_type"));
            put(&mut interpretation, "damage_expression", hazard.get("expression"));
            interpretation.insert("activity_kind".into(), or_null(reading.get("activity_kind")));
            put(&mut interpretation, "policy_version", reading.get("policy_version"));
            let ruling = json!({
                "id": ruling_id,
                "status": "applied", "scope": "single-action", "question": action,
                "bounded_options": ["hazard-contact"], "selected_option": "hazard-contact",
                "consequence": nullish(at(Some(state), &["scene", "objective"]), None).cloned().unwrap_or_else(|| str_value("")), "world_change": false,
                "interpretation": object(interpretation),
                "provenance": {
                    "source": "free-action-adjudication", "action_fingerprint": digest_text(&action),
                    "situation_fingerprint": situation_fingerprint(state), "policy": "free-action-adjudication-v2",
                },
            });
            let mut commands = vec![declaration.clone()];
            if in_combat {
                commands.push(Some(improvised_action_command(&actor_id, &action_cost, reading.get("goal_summary"), &ruling_id)));
            }
            commands.push(Some(json!({ "command_type": "RecordRuling", "ruling": with_field(&ruling, "outcome", str_value("applied")), "ruling_id": ruling_id })));
            let mut damage = Map::new();
            damage.insert("command_type".into(), str_value("ApplyDamage"));
            damage.insert("actor_id".into(), str_value(actor_id.clone()));
            damage.insert("target_id".into(), str_value(actor_id.clone()));
            put(&mut damage, "expression", hazard.get("expression"));
            put(&mut damage, "damage_type", hazard.get("damage_type"));
            damage.insert("source".into(), str_value(format!("free-action:hazard-contact:{}", js::string(hazard.get("hazard_id")))));
            damage.insert("ruling_id".into(), str_value(ruling_id.clone()));
            commands.push(Some(object(damage)));
            let commit = run(commands)?;
            verify_duplicate(Some(&commit), true)?;
            let events = list(commit.get("events")).to_vec();
            let applied = events.iter().find(|entry| type_is(entry, "DamageApplied") && includes(list(entry.get("target_ids")), Some(&actor_value)));
            let amount = js::number(at(applied, &["payload", "applied_amount"]));
            let amount = if amount.is_nan() { 0.0 } else { amount };
            let hero = game::find_actor(state, &actor_id);
            let name = match or(get(hero, "character"), get(hero, "name")) {
                Some(value) if js::truthy(Some(value)) => js::string(Some(value)),
                _ => "Герой".to_string(),
            };
            let name = text::head(&name, 120);
            let cause = if js::s(at(Some(hazard), &["source", "kind"])).starts_with("wall-") {
                "Удар о стену: "
            } else if is_str(hazard.get("hazard_id"), "fire") {
                "Ожог: "
            } else {
                ""
            };
            let narration = if amount > 0.0 { format!("{cause}{name} получает {} {} урона.", js::f64_string(amount), damage_type_label_ru(hazard.get("damage_type"))) } else { format!("{name} не получает урона от контакта.") };
            let mut reply = committed_reply(meta, "hazard_contact", str_value(narration), &commit);
            insert_after(&mut reply, "kind", "ruling", ruling.clone());
            insert_after(&mut reply, "ruling", "reading", reading.clone());
            reply["turn_consumed"] = Value::Bool(events.iter().any(|entry| type_is(entry, "CombatActionUsed")));
            return Ok(reply);
        }
        // Карманная кража разбирается **до** обыска тела: у того в шаблоне уже
        // есть слово «карман».
        let pickpocket = resolve_pickpocket(state, &actor_id, &action, &reading);
        if is_str(get(pickpocket.as_ref(), "status"), "clarification") {
            return Ok(plain(meta, "clarification", get(pickpocket.as_ref(), "narration").cloned().unwrap_or(Value::Null)));
        }
        if let Some(pickpocket) = pickpocket.as_ref().filter(|plan| is_str(plan.get("status"), "command")) {
            let commit = match run(vec![declaration.clone(), pickpocket.get("command").cloned()]) {
                Ok(commit) => commit,
                Err(error) => {
                    // Отказ правила — реплика ведущего («до кармана надо дойти»).
                    if !["PICKPOCKET_OUT_OF_REACH", "PICKPOCKET_POCKET_EMPTY", "NPC_NOT_PRESENT"].contains(&error.code().unwrap_or("")) {
                        return Err(error);
                    }
                    let message = text::replace_first(re!(r"[.!]*$", "u"), &error.message(), "");
                    return Ok(plain(meta, "clarification", str_value(format!("{message}."))));
                }
            };
            verify_duplicate(Some(&commit), false)?;
            return Ok(committed_reply(meta, "pickpocket", pickpocket.get("narration").cloned().unwrap_or(Value::Null), &commit));
        }
        let mut corpse_search = resolve_corpse_search(state, &actor_id, &action, &reading)?;
        let mut corpse_approach: Option<Value> = None;
        // Вне боя герой сам подходит к телу и смотрит.
        if let Some(search) = corpse_search.clone() {
            if js::truthy(search.get("loot_container_id")) && list_len(get(Some(&search), "loot_items")) == 0 && js::present(search.get("distance_feet")) && !in_combat {
                let container = list(at(Some(state), &["loot_containers", "containers"])).iter().find(|entry| js::string(get(Some(entry), "id")) == js::string(search.get("loot_container_id")));
                let to = container.and_then(|container| loot_approach_destination(state, &actor_id, container));
                if let Some(to) = to.filter(|to| js::truthy(Some(to))) {
                    let attempt = run(vec![Some(json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": to, "server_authoritative": true }))]).and_then(|approach| {
                        let next = resolve_corpse_search(nullish(approach.get("state"), Some(state)).unwrap_or(state), &actor_id, &action, &reading)?;
                        Ok((approach, next))
                    });
                    match attempt {
                        Ok((approach, next)) => {
                            corpse_approach = Some(approach);
                            if next.is_some() {
                                corpse_search = next;
                            }
                        }
                        Err(error) if error.is_rules_validation() => corpse_approach = None,
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        // Знак культа на теле культиста — улика сюжета, а не только добыча.
        let mut corpse_clue: Option<Value> = None;
        let bodies_searched = is_str(get(corpse_search.as_ref(), "status"), "bodies_searched");
        if let Some(search) = corpse_search.as_ref().filter(|search| list_len(search.get("loot_items")) > 0 || bodies_searched) {
            let now_state = corpse_approach.as_ref().and_then(|approach| nullish(approach.get("state"), None)).unwrap_or(state);
            let mut ids: Vec<String> = Vec::new();
            let mut container_ids: Vec<Value> = vec![search.get("loot_container_id").cloned().unwrap_or(Value::Null)];
            container_ids.extend(list(search.get("loot_container_ids")).iter().cloned());
            for id in container_ids.iter().filter(|id| js::truthy(Some(id))) {
                let id = js::string(Some(id));
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            let encounter = at(Some(now_state), &["mechanics", "encounter"]);
            let encounter_id = js::s(nullish(get(encounter, "id"), get(encounter, "encounter_id")));
            let corpse_ids = list(search.get("corpse_ids"));
            let mut candidates: Vec<Value> = list(at(Some(now_state), &["loot_containers", "containers"])).iter().filter(|entry| ids.contains(&js::string(get(Some(entry), "id")))).cloned().collect();
            if bodies_searched {
                candidates.push(json!({
                    "kind": "corpse",
                    "id": format!("bodies:{}", corpse_ids.iter().map(|id| js::s(Some(id))).collect::<Vec<_>>().join(",")),
                    "encounter_id": encounter_id,
                    "source_enemy_ids": corpse_ids,
                }));
            }
            if let Some(clue) = candidates.iter().find_map(|entry| corpse_clue_command(now_state, entry).filter(|command| js::truthy(Some(command)))) {
                match self.run(campaign_id, &format!("{idempotency_key}:clue"), &[clue]) {
                    Ok(commit) => corpse_clue = Some(commit),
                    Err(error) if error.is_rules_validation() || error.code() == Some("STATE_VERSION_CONFLICT") => {}
                    Err(error) => return Err(error),
                }
            }
        }
        if let Some(search) = corpse_search.as_ref() {
            let clue_text = list(corpse_clue.as_ref().and_then(|clue| clue.get("events")))
                .iter()
                .filter(|entry| type_is(entry, "WorldFactRecorded"))
                .map(|entry| js::s(at(Some(entry), &["payload", "fact", "summary"])))
                .filter(|summary| !summary.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let has_items = matches!(search.get("loot_items"), Some(Value::Array(items)) if !items.is_empty());
            let kind = if has_items || bodies_searched { "loot_inspection" } else { "clarification" };
            let narration = if clue_text.is_empty() { search.get("narration").cloned().unwrap_or(Value::Null) } else { str_value(format!("{} {clue_text}", js::string(search.get("narration")))) };
            let pick = |key: &str, fallback: Value| -> Value {
                nullish(corpse_clue.as_ref().and_then(|clue| clue.get(key)), corpse_approach.as_ref().and_then(|approach| approach.get(key))).filter(|value| !value.is_null()).cloned().unwrap_or(fallback)
            };
            let mut events = list(corpse_approach.as_ref().and_then(|approach| approach.get("events"))).to_vec();
            events.extend(list(corpse_clue.as_ref().and_then(|clue| clue.get("events"))).iter().cloned());
            let mut commands = list(corpse_approach.as_ref().and_then(|approach| approach.get("commands"))).to_vec();
            commands.extend(list(corpse_clue.as_ref().and_then(|clue| clue.get("commands"))).iter().cloned());
            let mut reply = plain(meta, kind, narration);
            reply["state"] = pick("state", state.clone());
            reply["state_version"] = pick("state_version", Value::from(loaded.state_version));
            reply["events"] = Value::Array(events);
            reply["commands"] = Value::Array(commands);
            reply["duplicate"] = Value::Bool(js::truthy(corpse_approach.as_ref().and_then(|approach| approach.get("duplicate"))));
            return Ok(reply);
        }
        let inventory_transfer = resolve_inventory_transfer(state, &actor_id, &action, &reading);
        if is_str(get(inventory_transfer.as_ref(), "status"), "clarification") {
            return Ok(plain(meta, "clarification", get(inventory_transfer.as_ref(), "narration").cloned().unwrap_or(Value::Null)));
        }
        if let Some(transfer) = inventory_transfer.as_ref().filter(|plan| is_str(plan.get("status"), "command")) {
            let commit = run(vec![declaration.clone(), transfer.get("command").cloned()])?;
            verify_duplicate(Some(&commit), false)?;
            return Ok(committed_reply(meta, "item_transfer", transfer.get("narration").cloned().unwrap_or(Value::Null), &commit));
        }
        if stored_reading.is_none() && js::s(reading.get("source")).starts_with("deterministic-default") && !has_recognized_free_action_approach(&action) {
            // Герой идёт к месту, которого нет ни на карте мира, ни в сцене:
            // честный ответ с тем, что можно сделать.
            let is_revealed = |prop: &Value| revealed.test(prop);
            let unknown_place = unknown_destination_reply(&action, state, Some(&is_revealed));
            let scene_location = clean_lower(at(Some(state), &["scene", "location"]), 180);
            let mundane = if unknown_place.is_empty() {
                let npc_names = list(at(Some(state), &["social", "npcs"]))
                    .iter()
                    .filter(|npc| !js::is_false(get(Some(npc), "available")) && !is_str(get(Some(npc), "visibility"), "gm_only") && clean_lower(get(Some(npc), "location"), 180) == scene_location)
                    .map(|npc| js::s(get(Some(npc), "name")))
                    .collect();
                mundane_action_outcome(
                    &action,
                    &MundaneContext {
                        hero_name: hero_name_for_text(state, &actor_id),
                        in_combat: js::is_true(at(Some(state), &["mechanics", "combat", "active"])),
                        npc_names,
                        onward: next_world_map_destination(state).unwrap_or_default(),
                    },
                )
            } else {
                None
            };
            let mundane_text = get(mundane.as_ref(), "narration").filter(|value| js::truthy(Some(value))).cloned();
            let fallback = "Я не понял способ действия. Опишите, что именно делает герой, с чем или с кем он взаимодействует и какого результата хочет добиться.";
            let question = if !unknown_place.is_empty() { str_value(unknown_place.clone()) } else { mundane_text.clone().unwrap_or_else(|| str_value(fallback)) };
            let narration = if !unknown_place.is_empty() { str_value(unknown_place) } else { mundane_text.unwrap_or_else(|| str_value(format!("{fallback} Попытка ничего не расходует."))) };
            let mut reply = plain(meta, "clarification", narration);
            insert_after(&mut reply, "kind", "clarification_question", question);
            return Ok(reply);
        }
        let means = verify_means(state, &actor_id, reading.get("required_means"));
        let resolution = if js::truthy(means.get("satisfied")) {
            contextual_resolution_for(state, &actor_id, &reading, &action)
        } else {
            contextual_resolution_for(state, &actor_id, &with_field(&reading, "plausibility", str_value("impossible_without_means")), &action)
        };
        let attempt = attempt_fingerprint(&actor_id, &js::s(reading.get("approach_summary")), &js::s(reading.get("obstacle")));
        let repeated = previous_failed_attempt(state, &attempt);
        let objective = nullish(at(Some(state), &["scene", "objective"]), None).cloned().unwrap_or_else(|| str_value(""));

        // Тот же подход к тому же препятствию в неизменившейся обстановке
        // нового броска не даёт.
        if repeated.is_some() {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            let narration = format!("Этот способ уже не сработал, и обстановка с тех пор не изменилась. Нужен другой подход к препятствию «{}».", js::string(reading.get("obstacle")));
            return Ok(committed_reply(meta, "clarification", str_value(narration), &commit));
        }
        // Встречное предложение вместо отказа: «нет, но…».
        if is_str(resolution.get("mode"), "counter_offer") {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            return Ok(committed_reply(meta, "counter_offer", str_value(missing_text(&means)), &commit));
        }

        let outcome_policy = free_action_resolution_policy(&reading);
        let passage_destination = if !in_combat && is_str(passage_plan.get("status"), "ready") { passage_plan.get("destination").cloned() } else { None };
        let passage_available = js::truthy(passage_destination.as_ref());
        let mut stakes_input = Map::new();
        put(&mut stakes_input, "ability", reading.get("ability"));
        put(&mut stakes_input, "skill", reading.get("skill"));
        stakes_input.insert("resolution".into(), resolution.clone());
        put(&mut stakes_input, "risk", reading.get("risk"));
        put(&mut stakes_input, "proficiency", reading.get("proficiency"));
        put(&mut stakes_input, "consequence_type", reading.get("consequence_type"));
        stakes_input.insert("outcome_policy".into(), outcome_policy.clone());
        let mut stakes = stakes_for(&object(stakes_input)).unwrap_or(Value::Null);
        let ruling_id = format!("ruling-{}", digest(&json!({ "campaignId": campaign_id, "text": action })));
        let mut interpretation = Map::new();
        interpretation.insert("target_id".into(), or_null(reading.get("target_id")));
        interpretation.insert("item_id".into(), or_null(reading.get("item_id")));
        put(&mut interpretation, "skill", reading.get("skill"));
        put(&mut interpretation, "proficiency", reading.get("proficiency"));
        put(&mut interpretation, "consequence_type", reading.get("consequence_type"));
        interpretation.insert("activity_kind".into(), or_null(reading.get("activity_kind")));
        interpretation.insert("duration_class".into(), or_null(reading.get("duration_class")));
        put(&mut interpretation, "policy_version", reading.get("policy_version"));
        let auto_success = is_str(resolution.get("mode"), "auto_success");
        let mut ruling = json!({
            "id": ruling_id,
            "status": "applied",
            "scope": "single-action",
            "question": action,
            "bounded_options": ["auto-success", "ability-check", "counter-offer"],
            "selected_option": if auto_success { "auto-success" } else { "ability-check" },
            "consequence": objective,
            "world_change": false,
            "stakes": stakes,
            "interpretation": object(interpretation),
            "provenance": {
                "source": "free-action-adjudication",
                "action_fingerprint": digest_text(&action),
                "attempt_fingerprint": attempt,
                "situation_fingerprint": situation_fingerprint(state),
                "policy": if is_str(outcome_policy.get("version"), "legacy") { "free-action-adjudication-v1" } else { "free-action-adjudication-v2" },
            },
        });
        let passage_commands = |ruling_id: &str| -> Vec<Option<Value>> {
            let Some(destination) = passage_destination.as_ref() else { return Vec::new() };
            let ruling_value = str_value(ruling_id);
            let mut commands: Vec<Option<Value>> = passage_door_commands(&actor_id, &passage_plan, &ruling_value).into_iter().map(Some).collect();
            let mut move_command = Map::new();
            move_command.insert("command_type".into(), str_value("MoveActor"));
            move_command.insert("actor_id".into(), str_value(actor_id.clone()));
            put(&mut move_command, "to", destination.get("to"));
            move_command.insert("server_authoritative".into(), Value::Bool(true));
            move_command.insert("ruling_id".into(), ruling_value);
            commands.push(Some(object(move_command)));
            commands
        };

        // Автоуспех — тоже событие: replay обязан его воспроизводить.
        if auto_success {
            let success_ruling = js::spread(&ruling, json!({ "outcome": "success", "world_change": passage_available }));
            let mut commands = vec![declaration.clone()];
            commands.extend(approach_move.iter().cloned());
            commands.push(Some(json!({ "command_type": "RecordRuling", "ruling": success_ruling, "ruling_id": ruling_id })));
            commands.extend(passage_commands(&ruling_id));
            let success_minutes = js::number(outcome_policy.get("success_minutes"));
            if !in_combat && success_minutes > 0.0 {
                commands.push(Some(json!({ "command_type": "AdvanceTime", "amount": outcome_policy.get("success_minutes"), "unit": "minute" })));
            }
            let commit = run(commands)?;
            verify_duplicate(Some(&commit), true)?;
            // Без броска, но по делу: «изучаю повестку» открывает секрет темы
            // отдельным коммитом после решения.
            let ruling_event = list(commit.get("events")).iter().find(|entry| type_is(entry, "RulingRecorded")).cloned();
            let discovery = match ruling_event.filter(|_| !in_combat) {
                Some(ruling_event) => {
                    let mut input = Map::new();
                    input.insert("checkEvent".into(), ruling_event);
                    put(&mut input, "skill", reading.get("skill"));
                    input.insert("actionText".into(), str_value(action.clone()));
                    put(&mut input, "goalSummary", reading.get("goal_summary"));
                    input.insert("successDetail".into(), nullish(reading.get("success_detail"), None).cloned().unwrap_or_else(|| str_value("")));
                    input.insert("surfaceDetail".into(), nullish(reading.get("surface_detail"), None).cloned().unwrap_or_else(|| str_value("")));
                    free_action_discovery_commands(nullish(commit.get("state"), Some(state)).unwrap_or(state), &object(input))
                }
                None => Vec::new(),
            };
            let mut discovery_commit: Option<Value> = None;
            if !discovery.is_empty() {
                match self.run(campaign_id, &format!("{idempotency_key}:discovery"), &discovery) {
                    Ok(commit) => discovery_commit = Some(commit),
                    Err(error) if error.code() == Some("STATE_VERSION_CONFLICT") => {}
                    Err(error) => return Err(error),
                }
            }
            let mut events = list(commit.get("events")).to_vec();
            events.extend(list(discovery_commit.as_ref().and_then(|commit| commit.get("events"))).iter().cloned());
            let mut commands = list(commit.get("commands")).to_vec();
            commands.extend(list(discovery_commit.as_ref().and_then(|commit| commit.get("commands"))).iter().cloned());
            let mut reply = committed_reply(meta, "auto_success", str_value("Это удаётся без броска: для самой попытки нет риска или противодействия."), &commit);
            insert_after(&mut reply, "kind", "ruling", ruling.clone());
            insert_after(&mut reply, "ruling", "reading", reading.clone());
            if let Some(discovered) = &discovery_commit {
                reply["state"] = nullish(discovered.get("state"), Some(&reply["state"])).cloned().unwrap_or(Value::Null);
                reply["state_version"] = nullish(discovered.get("state_version"), Some(&reply["state_version"])).cloned().unwrap_or(Value::Null);
            }
            reply["events"] = Value::Array(events);
            reply["commands"] = Value::Array(commands);
            return Ok(reply);
        }

        // В бою импровизация платит слотом хода; проверка стоит до броска.
        let action_cost = self.action_cost(state, &actor_id, in_combat, reading.get("action_cost"));
        if in_combat && is_str(action_cost.get("cost"), "action") && js::truthy(at(Some(state), &["mechanics", "combat", "action_economy"]).and_then(|economy| get(Some(economy), &actor_id)).and_then(|entry| entry.get("surged_action_only"))) {
            return Ok(plain(meta, "clarification", str_value("Дополнительное действие от Всплеска действий нельзя потратить на импровизацию. Выберите другое доступное действие.")));
        }
        if in_combat && !js::truthy(action_cost.get("available")) {
            let commit = run(vec![declaration.clone()])?;
            verify_duplicate(Some(&commit), false)?;
            let narration = format!("На этом ходу {} уже потрачено. Импровизация обойдётся в него же — попробуйте на следующем ходу или опишите что-то, что укладывается в оставшееся.", js::string(action_cost.get("slot")));
            return Ok(committed_reply(meta, "clarification", str_value(narration), &commit));
        }
        let actor_json = str_value(actor_id.clone());
        let effect_request = |reading: &Value| -> (Option<Value>, Option<Value>, Option<Value>, Option<Value>) { (field(reading, "effect"), field(reading, "effect_target"), field(reading, "hazard"), field(reading, "risk")) };
        let plan_effect = |source: &Value| {
            let (effect, target, hazard, risk) = effect_request(&reading);
            let plan = plan_improvised_effect(source, ImprovisedEffectRequest { actor_id: Some(&actor_json), effect_id: effect.as_ref(), target_id: target.as_ref(), hazard_id: hazard.as_ref(), risk: risk.as_ref() });
            json!({ "effect": plan.effect, "rejected": plan.rejected, "commands": plan.commands, "summary": plan.summary })
        };
        let hazard_effect_unavailable = in_combat && is_str(reading.get("effect"), "hazard_damage") && !confirmed_hazard_near(state, &param_text(reading.get("effect_target")), reading.get("hazard"));
        let effect_preview = if in_combat {
            Some(if hazard_effect_unavailable { json!({ "effect": { "id": "none" }, "rejected": "рядом с целью нет подтверждённой видимой опасности" }) } else { plan_effect(state) })
        } else {
            None
        };
        if let Some(rejected) = get(effect_preview.as_ref(), "rejected").filter(|value| js::truthy(Some(value))) {
            return Ok(plain(meta, "clarification", str_value(format!("Этот результат пока недоступен: {}. Уточните цель или способ действия. Попытка ничего не расходует.", js::string(Some(rejected))))));
        }
        let failure = outcome_policy.get("failure").cloned().unwrap_or(Value::Null);
        let slot = action_cost.get("slot");
        let cost = if in_combat {
            match slot {
                Some(value) if js::truthy(Some(value)) => value.clone(),
                _ => str_value("свободное взаимодействие"),
            }
        } else {
            outcome_policy.get("cost").cloned().unwrap_or(Value::Null)
        };
        let on_success = if in_combat {
            if is_str(at(effect_preview.as_ref(), &["effect", "id"]), "none") { str_value("Попытка будет отмечена в истории без механического эффекта.") } else { get(effect_preview.as_ref(), "summary").cloned().unwrap_or(Value::Null) }
        } else if passage_available {
            str_value(free_action_success_promise(&reading, true))
        } else if is_str(reading.get("activity_kind"), "stunt") {
            str_value("Трюк удаётся; герой остаётся на месте.")
        } else {
            str_value(free_action_success_promise(&reading, false))
        };
        let on_failure = if in_combat {
            let base = if is_str(action_cost.get("cost"), "free") { "Задумка не удастся; действие и бонусное действие сохранятся.".to_string() } else { format!("Задумка не удастся; {} будет потрачено.", js::string(slot)) };
            let extra = if js::truthy(failure.get("damage_expression")) { format!(" {}", js::string(failure.get("summary"))) } else { String::new() };
            str_value(format!("{base}{extra}"))
        } else {
            failure.get("summary").cloned().unwrap_or(Value::Null)
        };
        let mut proposal = Map::new();
        put(&mut proposal, "summary", reading.get("goal_summary"));
        put(&mut proposal, "approach", reading.get("approach_summary"));
        proposal.insert("cost".into(), cost);
        proposal.insert("on_success".into(), on_success);
        proposal.insert("on_failure".into(), on_failure.clone());
        let proposal = object(proposal);
        if let Some(map) = stakes.as_object_mut() {
            map.insert("on_failure".into(), on_failure.clone());
            ruling["stakes"] = stakes.clone();
        }
        // Согласование рискованной импровизации обязательно и с автоброском:
        // проверка регистрируется в реестре бросков, коммита нет.
        if let (None, Some(registry)) = (verified_roll, &self.roll_registry) {
            let mut preview_options = Map::new();
            preview_options.insert("actorId".into(), str_value(actor_id.clone()));
            preview_options.insert("kind".into(), str_value("check"));
            put(&mut preview_options, "ability", reading.get("ability"));
            put(&mut preview_options, "skill", reading.get("skill"));
            put(&mut preview_options, "difficulty", resolution.get("difficulty"));
            let preview = preview_d20_check(state, &object(preview_options))?;
            let mut label = Map::new();
            label.insert("kind".into(), str_value("check"));
            put(&mut label, "ability", preview.get("ability"));
            put(&mut label, "skill", preview.get("skill"));
            let mut options = Map::new();
            options.insert("campaignId".into(), str_value(campaign_id));
            options.insert("actorId".into(), str_value(actor_id.clone()));
            options.insert("label".into(), str_value(d20_check_label(&object(label))));
            put(&mut options, "modifier", preview.get("modifier"));
            put(&mut options, "difficulty", preview.get("difficulty"));
            put(&mut options, "ability", preview.get("ability"));
            put(&mut options, "advantage", preview.get("advantage"));
            put(&mut options, "disadvantage", preview.get("disadvantage"));
            options.insert(
                "context".into(),
                json!({ "kind": "free_action", "action": action, "action_fingerprint": digest_text(&action), "state_version": loaded.state_version, "reading": reading, "proposal": proposal }),
            );
            let check = registry.register_check(&object(options))?;
            let narration = format!(
                "Это бросок: {}, СЛ {}. {} {} Бросаете или попробуете иначе?",
                js::string(check.get("label")),
                js::string(check.get("difficulty")),
                js::string(proposal.get("on_success")),
                js::string(proposal.get("on_failure"))
            );
            let mut check_reply = check.as_object().cloned().unwrap_or_default();
            check_reply.insert("sides".into(), Value::from(20));
            check_reply.insert("skill".into(), preview.get("skill").cloned().unwrap_or(Value::Null));
            check_reply.insert("proposal".into(), proposal.clone());
            let mut reply = plain(meta, "check_required", str_value(narration));
            insert_after(&mut reply, "kind", "check", object(check_reply));
            insert_after(&mut reply, "check", "reading", reading.clone());
            insert_after(&mut reply, "reading", "stakes", stakes.clone());
            return Ok(reply);
        }
        // Бросок, который игрок уже сделал через реестр, — выпавшие кости;
        // математику и итог движок пересчитывает сам.
        let verified_payload = verified_roll.map(|roll| {
            let mut payload = roll.clone();
            js::delete(&mut payload, "context");
            payload
        });
        let mut check_commands = vec![declaration.clone()];
        check_commands.extend(approach_move.iter().cloned());
        if in_combat {
            check_commands.push(Some(improvised_action_command(&actor_id, &action_cost, reading.get("goal_summary"), &ruling_id)));
        }
        let mut check = Map::new();
        check.insert("command_type".into(), str_value("MakeAbilityCheck"));
        check.insert("actor_id".into(), str_value(actor_id.clone()));
        put(&mut check, "ability", reading.get("ability"));
        put(&mut check, "skill", reading.get("skill"));
        put(&mut check, "difficulty", resolution.get("difficulty"));
        put(&mut check, "difficulty_category", resolution.get("difficulty_category"));
        if let Some(payload) = verified_payload {
            check.insert("verified_roll".into(), payload);
        }
        check_commands.push(Some(object(check)));
        let check_commit = run(check_commands)?;
        verify_duplicate(Some(&check_commit), false)?;
        let check_state = nullish(check_commit.get("state"), Some(state)).cloned().unwrap_or(Value::Null);
        let check_event = list(check_commit.get("events")).iter().find(|entry| type_is(entry, "AbilityCheckResolved")).cloned();
        let succeeded = js::is_true(at(check_event.as_ref(), &["payload", "success"]));
        let consequence = failure;
        let check_event_value = check_event.clone().unwrap_or(Value::Null);
        // Провал методичного поиска вне спешки решает время, а не находку.
        let thorough = if !succeeded && !in_combat {
            let mut input = Map::new();
            if let Some(event) = &check_event {
                input.insert("checkEvent".into(), event.clone());
            }
            put(&mut input, "skill", reading.get("skill"));
            input.insert("actionText".into(), str_value(action.clone()));
            thorough_search_outcome(&check_state, &object(input))
        } else {
            None
        };
        let failure_minutes = match &thorough {
            Some(thorough) => {
                let minutes = js::number(consequence.get("minutes"));
                let minutes = if minutes.is_nan() { 0.0 } else { minutes };
                js::num(js_max(minutes, js::number(thorough.get("minutes"))))
            }
            None => consequence.get("minutes").cloned().unwrap_or(Value::Null),
        };
        let outcome_ruling = js::spread(&ruling, json!({ "outcome": if succeeded { "success" } else { "failure" }, "world_change": succeeded && passage_available }));
        // Внутри раунда время не идёт и цель отряда не переписывается.
        let effect_plan = if succeeded && in_combat { Some(plan_effect(&check_state)) } else { None };
        let mut follow_up: Vec<Value> = vec![json!({ "command_type": "RecordRuling", "ruling": outcome_ruling, "ruling_id": ruling_id })];
        if succeeded {
            follow_up.extend(passage_commands(&ruling_id).into_iter().flatten());
        }
        follow_up.extend(list(get(effect_plan.as_ref(), "commands")).iter().cloned());
        if !succeeded && js::truthy(consequence.get("damage_expression")) {
            let mut damage = Map::new();
            damage.insert("command_type".into(), str_value("ApplyDamage"));
            damage.insert("actor_id".into(), str_value(actor_id.clone()));
            damage.insert("target_id".into(), str_value(actor_id.clone()));
            put(&mut damage, "expression", consequence.get("damage_expression"));
            put(&mut damage, "damage_type", consequence.get("damage_type"));
            damage.insert("source".into(), str_value(format!("free-action:{}", js::string(reading.get("activity_kind")))));
            damage.insert("ruling_id".into(), str_value(ruling_id.clone()));
            follow_up.push(object(damage));
        }
        let minutes_value = if succeeded { outcome_policy.get("success_minutes").cloned() } else { Some(failure_minutes.clone()) };
        if !(in_combat || js::number(minutes_value.as_ref()) <= 0.0) {
            let mut advance = Map::new();
            advance.insert("command_type".into(), str_value("AdvanceTime"));
            put(&mut advance, "amount", minutes_value.as_ref());
            advance.insert("unit".into(), str_value("minute"));
            follow_up.push(object(advance));
        }
        if !succeeded && !in_combat && js::truthy(consequence.get("advances_quest_clock")) {
            if let Some(quest) = open_quest(state, None) {
                let mut command = Map::new();
                command.insert("command_type".into(), str_value("AdvanceQuestClock"));
                put(&mut command, "quest_id", quest.get("id"));
                command.insert("amount".into(), Value::from(1));
                follow_up.push(object(command));
            }
        }
        // Удачный осмотр по делу оставляет улику; часы двигает Режиссёр.
        let skill_key = text::replace_all(re!(r"_", "gu"), &js::s(reading.get("skill")), "-");
        if succeeded && !in_combat {
            let label = SKILL_LABELS_RU.iter().find(|(key, _)| *key == skill_key).map_or("", |(_, label)| *label);
            let mut input = Map::new();
            if check_event.is_some() {
                input.insert("checkEvent".into(), check_event_value.clone());
            }
            put(&mut input, "skill", reading.get("skill"));
            input.insert("actionText".into(), str_value(action.clone()));
            put(&mut input, "goalSummary", reading.get("goal_summary"));
            input.insert("skillLabel".into(), str_value(label));
            input.insert("successDetail".into(), nullish(reading.get("success_detail"), None).cloned().unwrap_or_else(|| str_value("")));
            input.insert("surfaceDetail".into(), nullish(reading.get("surface_detail"), None).cloned().unwrap_or_else(|| str_value("")));
            follow_up.extend(free_action_discovery_commands(&check_state, &object(input)));
        } else if !in_combat {
            let mut input = Map::new();
            if check_event.is_some() {
                input.insert("checkEvent".into(), check_event_value.clone());
            }
            put(&mut input, "skill", reading.get("skill"));
            input.insert("surfaceDetail".into(), nullish(reading.get("surface_detail"), None).cloned().unwrap_or_else(|| str_value("")));
            follow_up.extend(free_action_surface_commands(&check_state, &object(input)));
            follow_up.extend(list(get(thorough.as_ref(), "commands")).iter().cloned());
        }
        let mut consequence_commit: Option<Value> = None;
        let mut passage_refused = false;
        let mut passage_refused_code = String::new();
        for attempt_index in 0..3 {
            match self.run(campaign_id, &format!("{idempotency_key}:consequence"), &follow_up) {
                Ok(commit) => {
                    consequence_commit = Some(commit);
                    break;
                }
                Err(error) => {
                    // Бросок уже сделан: если движок отклонил сам проход, ход
                    // доигрывается без перемещения.
                    let movement = |command: &Value| ["MoveActor", "OperateDoor"].contains(&js::s(command.get("command_type")).as_str());
                    if error.is_rules_validation() && !passage_refused && follow_up.iter().any(movement) {
                        passage_refused = true;
                        passage_refused_code = text::head(error.code().unwrap_or("RULES_VALIDATION_FAILED"), 80);
                        eprintln!("[Сказание] Проход после удачной проверки отклонён движком: {passage_refused_code} {}", text::head(&error.message(), 160));
                        follow_up.retain(|command| !movement(command));
                        continue;
                    }
                    if error.code() != Some("STATE_VERSION_CONFLICT") || attempt_index == 2 {
                        return Err(error);
                    }
                }
            }
        }
        let mut events = list(check_commit.get("events")).to_vec();
        events.extend(list(consequence_commit.as_ref().and_then(|commit| commit.get("events"))).iter().cloned());
        let injury: f64 = events
            .iter()
            .filter(|entry| type_is(entry, "DamageApplied") && includes(list(entry.get("target_ids")), Some(&actor_value)))
            .map(|entry| {
                let amount = js::number(at(Some(entry), &["payload", "applied_amount"]));
                if amount.is_nan() {
                    0.0
                } else {
                    amount
                }
            })
            .sum();
        let failure_text = if js::truthy(consequence.get("damage_expression")) {
            format!("Неудачное движение. Герой получает {} {} урона.", js::f64_string(injury), damage_type_label_ru(consequence.get("damage_type")))
        } else {
            js::string(consequence.get("summary"))
        };
        // Что герой видит при этом исходе — словами судьи до броска; находку
        // поиска записывает сервер фактом.
        let discovery_skill = DISCOVERY_SKILLS.contains(&skill_key.as_str());
        let hero_name = match get(game::find_actor(state, &actor_id), "character") {
            Some(name) if js::truthy(Some(name)) => js::string(Some(name)),
            _ => "Герой".to_string(),
        };
        let outcome_detail = if in_combat {
            String::new()
        } else if succeeded {
            if passage_refused || discovery_skill {
                String::new()
            } else {
                js::s(reading.get("success_detail"))
            }
        } else if let Some(thorough) = &thorough {
            thorough_search_detail(Some(thorough), Some(&str_value(hero_name)))
        } else {
            js::s(reading.get("failure_detail"))
        };
        let narration = if in_combat {
            if succeeded {
                text::trim(&format!("Проверка пройдена. {}", js::s(get(effect_plan.as_ref(), "summary")))).to_string()
            } else {
                let extra = if js::truthy(consequence.get("damage_expression")) { format!(" {failure_text}") } else { String::new() };
                format!("Не вышло: задумка сорвалась, и {} потрачено впустую.{extra}", js::string(action_cost.get("slot")))
            }
        } else if succeeded {
            "Проверка пройдена. Результат относится к заявленному способу; цель отряда сохраняется.".to_string()
        } else {
            format!("Не вышло. {failure_text} Можно изменить способ действия.")
        };
        let pick = |key: &str| -> Value {
            nullish(consequence_commit.as_ref().and_then(|commit| commit.get(key)), check_commit.get(key)).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| if key == "state" { state.clone() } else { Value::from(loaded.state_version) })
        };
        let mut commands = list(check_commit.get("commands")).to_vec();
        commands.extend(list(consequence_commit.as_ref().and_then(|commit| commit.get("commands"))).iter().cloned());
        let mut rolls = list(check_commit.get("rolls")).to_vec();
        rolls.extend(list(consequence_commit.as_ref().and_then(|commit| commit.get("rolls"))).iter().cloned());
        let mut reply = Map::new();
        put(&mut reply, "context_metadata", meta);
        reply.insert("kind".into(), str_value(if succeeded { "check_success" } else { "check_failure" }));
        if !outcome_detail.is_empty() {
            reply.insert("outcome_detail".into(), str_value(outcome_detail));
        }
        if let Some(thorough) = &thorough {
            reply.insert("thorough_search".into(), str_value(if js::truthy(thorough.get("found")) { "found" } else { "nothing" }));
        }
        if passage_refused {
            reply.insert("passage_refused".into(), str_value(passage_refused_code));
        }
        reply.insert("ruling".into(), outcome_ruling);
        reply.insert("reading".into(), std::mem::take(&mut reading));
        reply.insert("stakes".into(), stakes);
        reply.insert("narration".into(), str_value(narration));
        reply.insert("turn_consumed".into(), Value::Bool(false));
        reply.insert("admin_commands".into(), Value::from(0));
        reply.insert("state".into(), pick("state"));
        reply.insert("state_version".into(), pick("state_version"));
        reply.insert("events".into(), Value::Array(events));
        reply.insert("commands".into(), Value::Array(commands));
        reply.insert("rolls".into(), Value::Array(rolls));
        reply.insert("duplicate".into(), Value::Bool(js::truthy(check_commit.get("duplicate"))));
        Ok(object(reply))
    }

    /// `inCombat ? resolveActionCost(state, actorId, cost) : { cost: 'free', available: true }`.
    fn action_cost(&self, state: &Value, actor_id: &str, in_combat: bool, requested: Option<&Value>) -> Value {
        if !in_combat {
            return json!({ "cost": "free", "available": true });
        }
        let cost = resolve_action_cost(state, Some(&str_value(actor_id)), requested);
        let mut map = Map::new();
        map.insert("cost".into(), str_value(cost.cost));
        map.insert("available".into(), Value::Bool(cost.available));
        if let Some(slot) = cost.slot {
            map.insert("slot".into(), str_value(slot));
        }
        object(map)
    }

    /// `onlyBackgroundMemoryChanged(eventStore, campaignId, from, to)`.
    fn only_background_memory_changed(&self, campaign_id: &str, from_version: i64, to_version: i64) -> OrchestratorResult<bool> {
        let Some(events) = self.event_store.events_between(campaign_id, from_version, Some(to_version)) else { return Ok(false) };
        let events = events?;
        Ok(!events.is_empty() && events.iter().all(|event| BACKGROUND_MEMORY_EVENT_TYPES.contains(&js::s(event.get("event_type")).as_str())))
    }

    /// `runCombat(campaignId, { idempotencyPrefix, maxTurns })`: автобой — ход
    /// за ходом серверной тактикой героев (`party-tactics`) и NPC
    /// (`planNpcTurn`) до конца боя.
    pub fn run_combat(&self, campaign_id: &str, idempotency_prefix: &str, max_turns: i64) -> OrchestratorResult<Value> {
        let mut turns: Vec<Value> = Vec::new();
        let mut iteration = 0;
        while iteration < max_turns {
            let loaded = self.load(campaign_id)?;
            let state = &loaded.state;
            let combat = at(Some(state), &["mechanics", "combat"]);
            if !js::truthy(get(combat, "active")) {
                return Ok(json!({ "turns": turns, "state": loaded.state, "state_version": loaded.state_version }));
            }
            let actor_id = js::s(get(index_of(get(combat, "initiative"), get(combat, "active_index")), "actor_id"));
            let actor = game::find_actor(state, &actor_id);
            let living_enemies: Vec<&Value> = list(state.get("enemies")).iter().filter(|enemy| game::is_living_actor(enemy)).collect();
            let living_heroes: Vec<&Value> = list(state.get("players")).iter().filter(|hero| game::is_living_actor(hero)).collect();
            let mut hero_rule = String::new();
            let commands: Vec<Value> = if let Some(window) = get(combat, "reaction_window").filter(|window| js::truthy(Some(window))) {
                // Выбор реакции — такая же серверная политика, как и выбор хода.
                let plan = plan_hero_reaction(state, Some(window));
                hero_rule = plan.rule;
                plan.commands
            } else if living_enemies.is_empty() || living_heroes.is_empty() {
                let mut command = Map::new();
                command.insert("command_type".into(), str_value("EndCombat"));
                let actor_value = str_value(actor_id.clone());
                let chosen = or(Some(&actor_value), or(living_heroes.first().and_then(|hero| hero.get("id")), living_enemies.first().and_then(|enemy| enemy.get("id"))));
                put(&mut command, "actor_id", chosen);
                let reason = if !living_enemies.is_empty() { "party_defeated" } else { scenario_encounter_end_reason(state).unwrap_or("enemies_defeated") };
                command.insert("reason".into(), str_value(reason));
                vec![object(command)]
            } else if !actor.is_some_and(game::is_living_actor) {
                vec![json!({ "command_type": "EndTurn", "actor_id": actor_id })]
            } else if game::is_enemy_actor(state, &actor_id) {
                plan_npc_turn(state, &actor_id)?
            } else {
                // Тактика героя — отдельная серверная политика.
                let plan = plan_hero_turn(state, &actor_id)?;
                hero_rule = plan.rule;
                plan.commands
            };
            let key = format!("{idempotency_prefix}:{}:v{}", iteration + 1, loaded.state_version);
            let committed = self.run_commands(campaign_id, &key, &commands, &json!({ "isNpcScheduler": game::is_enemy_actor(state, &actor_id) }), None)?;
            let mut turn = Map::new();
            turn.insert("actor_id".into(), str_value(actor_id.clone()));
            turn.insert("commands".into(), Value::Array(commands.iter().map(|command| command.get("command_type").cloned().unwrap_or(Value::Null)).collect()));
            turn.insert("events".into(), Value::Array(list(committed.get("events")).iter().map(|entry| entry.get("event_type").cloned().unwrap_or(Value::Null)).collect()));
            if !hero_rule.is_empty() {
                turn.insert("tactic".into(), str_value(hero_rule));
            }
            turns.push(object(turn));
            iteration += 1;
        }
        Err(OrchestratorError::plain(format!("Autonomous combat exceeded {max_turns} turns")))
    }

    /// `completeEncounter({ campaignId, outcome })`: итог встречи, награды по
    /// этапам, свидетели, развязка и переход. Одна встреча — одно завершение
    /// за раз на процесс.
    pub async fn complete_encounter(&self, campaign_id: &str, outcome: Option<&Value>) -> OrchestratorResult<Value> {
        let loaded = self.load(campaign_id)?;
        let encounter = at(Some(&loaded.state), &["mechanics", "encounter"]);
        let encounter_id = js::s(nullish(get(encounter, "id"), get(encounter, "encounter_id")));
        if encounter_id.is_empty() {
            return Err(OrchestratorError::plain("Encounter completion requires an active encounter record"));
        }
        let lock_key = format!("{campaign_id}\u{0}{encounter_id}");
        let (previous, guard) = {
            let mut locks = lock(&COMPLETION_LOCKS);
            match locks.get(&lock_key) {
                Some(slot) => (Some(slot.clone()), None),
                None => {
                    let slot: SharedSlot = Arc::new(Mutex::new(CompletionSlot { done: None, wakers: Vec::new() }));
                    locks.insert(lock_key.clone(), slot.clone());
                    (None, Some(CompletionGuard { key: lock_key, slot }))
                }
            }
        };
        if let Some(previous) = previous {
            AwaitSlot(previous).await?;
            return self.complete_encounter_unlocked(campaign_id, outcome).await;
        }
        let result = self.complete_encounter_unlocked(campaign_id, outcome).await;
        if let Some(guard) = guard {
            guard.finish(result.as_ref().map(|_| ()).map_err(Clone::clone));
        }
        result
    }

    async fn complete_encounter_unlocked(&self, campaign_id: &str, outcome: Option<&Value>) -> OrchestratorResult<Value> {
        let default_outcome = str_value("enemies_defeated");
        let outcome = outcome.unwrap_or(&default_outcome);
        let mut loaded = self.load(campaign_id)?;
        let encounter = at(Some(&loaded.state), &["mechanics", "encounter"]);
        let encounter_id = js::s(nullish(get(encounter, "id"), get(encounter, "encounter_id")));
        let encounter_value = str_value(encounter_id.clone());
        let base_key = format!("encounter-completion:{encounter_id}");
        if js::truthy(at(Some(&loaded.state), &["mechanics", "combat", "active"])) {
            let combat = at(Some(&loaded.state), &["mechanics", "combat"]);
            let active = nullish(get(index_of(get(combat, "initiative"), get(combat, "active_index")), "actor_id"), get(list(loaded.state.get("players")).first(), "id"));
            self.run(campaign_id, &format!("{base_key}:end-combat"), &[json!({ "command_type": "EndCombat", "actor_id": js::s(active), "reason": outcome })])?;
            loaded = self.load(campaign_id)?;
        }
        let outcome_key = encounter_completion_stage_key(Some(&encounter_value), Some(&str_value("outcome")))?;
        let transition_key = encounter_completion_stage_key(Some(&encounter_value), Some(&str_value("transition")))?;
        let prepared_of = |event: Option<&Value>, message: &str| -> OrchestratorResult<Value> {
            let prepared = at(event, &["payload", "prepared_reward"]).cloned().unwrap_or(Value::Null);
            if !js::truthy(prepared.get("coins")) || !prepared.get("loot").is_some_and(Value::is_array) || !js::truthy(prepared.get("distribution")) {
                return Err(OrchestratorError::plain(message));
            }
            Ok(prepared)
        };
        let response_of = |plan: &Value, prepared: &Value| encounter_reward_response(Some(plan), prepared.get("coins"), prepared.get("loot"), prepared.get("distribution"));
        let outcome_commit = match self.by_key_json(campaign_id, &outcome_key)? {
            Some(commit) => {
                let outcome_event = list(commit.get("events")).iter().find(|entry| type_is(entry, "EncounterOutcomeRecorded"));
                let plan = frozen_encounter_outcome_plan_from_event(outcome_event)?;
                let prepared = prepared_of(outcome_event, "Frozen encounter reward preparation is missing")?;
                if self.by_key(campaign_id, &transition_key)?.is_some() {
                    let last = self.load(campaign_id)?;
                    return Ok(json!({ "events": [], "reward": response_of(&plan, &prepared)?, "state": last.state, "state_version": last.state_version, "admin_commands": 0, "duplicate": true }));
                }
                commit
            }
            None => {
                let plan = freeze_encounter_outcome_plan(&loaded.state, Some(outcome))?;
                let coins = self.rules_engine.roll_encounter_coins(&plan)?;
                let loot = loot_for_encounter_outcome(Some(&plan))?;
                let distribution = distribute_encounter_rewards(&loaded.state, Some(&plan), Some(&coins), Some(&Value::Array(loot.clone())))?;
                let prepared = json!({ "coins": coins, "loot": loot, "distribution": distribution });
                let mut payload = Map::new();
                put(&mut payload, "encounter_id", plan.get("encounter_id"));
                put(&mut payload, "outcome", plan.get("outcome"));
                payload.insert("plan".into(), plan.clone());
                payload.insert("prepared_reward".into(), prepared);
                payload.insert("provenance".into(), json!({ "source": "server-reward-policy", "policy": ENCOUNTER_REWARD_POLICY_ID }));
                self.commit_events_with_retry(campaign_id, &outcome_key, &[event(&outcome_key, "EncounterOutcomeRecorded", object(payload), &[], "party")], None)?
            }
        };
        let committed_outcome_event = list(outcome_commit.get("events")).iter().find(|entry| type_is(entry, "EncounterOutcomeRecorded")).cloned();
        let plan = frozen_encounter_outcome_plan_from_event(committed_outcome_event.as_ref())?;
        let prepared = prepared_of(committed_outcome_event.as_ref(), "Committed frozen encounter reward preparation is missing")?;

        let mut emitted: Vec<Value> = Vec::new();
        let mut collect = |commit: &Value| {
            if !js::truthy(commit.get("duplicate")) {
                emitted.extend(list(commit.get("events")).iter().cloned());
            }
        };
        collect(&outcome_commit);
        let eligible = js::truthy(plan.get("rewards_eligible"));
        let recipients = list(plan.get("recipients")).to_vec();
        let skipped = |key: &str, stage: &str| {
            let mut payload = Map::new();
            put(&mut payload, "encounter_id", plan.get("encounter_id"));
            payload.insert("stage".into(), str_value(stage));
            payload.insert("reason".into(), str_value("outcome-not-rewardable"));
            event(key, "EncounterRewardStageSkipped", object(payload), &[], "party")
        };
        let provenance = json!({ "source": "server-reward-policy", "policy": ENCOUNTER_REWARD_POLICY_ID });

        let xp_key = encounter_completion_stage_key(Some(&encounter_value), Some(&str_value("xp")))?;
        let xp_event = if eligible {
            let mut payload = Map::new();
            put(&mut payload, "encounter_id", plan.get("encounter_id"));
            put(&mut payload, "total_xp", plan.get("total_xp"));
            payload.insert("recipients".into(), Value::Array(recipients.clone()));
            payload.insert("unassigned_xp".into(), if recipients.is_empty() { plan.get("total_xp").cloned().unwrap_or(Value::Null) } else { Value::from(0) });
            put(&mut payload, "plan_version", plan.get("version"));
            payload.insert("provenance".into(), provenance.clone());
            event(&xp_key, "ExperienceAwarded", object(payload), &strings_of(&recipients), "party")
        } else {
            skipped(&xp_key, "xp")
        };
        let validate_recipients = |state: &Value| -> OrchestratorResult<()> {
            assert_encounter_reward_recipients(state, plan.get("recipients"))?;
            Ok(())
        };
        collect(&self.commit_events_with_retry(campaign_id, &xp_key, &[xp_event], if eligible { Some(&validate_recipients) } else { None })?);

        let coins_key = encounter_completion_stage_key(Some(&encounter_value), Some(&str_value("coins")))?;
        let coins_event = if eligible {
            let payload = js::spread(&js::spread(&json!({ "schema_version": 1 }), prepared.get("coins").cloned().unwrap_or(Value::Null)), json!({ "provenance": { "source": "server-coin-policy", "policy": ENCOUNTER_COINS_POLICY_ID } }));
            with_field(&event(&coins_key, "EncounterCoinsRolled", payload, &[], "party"), "event_schema_version", Value::from(1))
        } else {
            skipped(&coins_key, "coins")
        };
        collect(&self.commit_events_with_retry(campaign_id, &coins_key, &[coins_event], None)?);

        let loot_key = encounter_completion_stage_key(Some(&encounter_value), Some(&str_value("loot")))?;
        let loot_event = if eligible {
            let mut payload = Map::new();
            payload.insert("schema_version".into(), Value::from(SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION));
            put(&mut payload, "encounter_id", plan.get("encounter_id"));
            put(&mut payload, "loot", prepared.get("loot"));
            payload.insert("provenance".into(), json!({ "source": "server-loot-table", "policy": ENCOUNTER_LOOT_POLICY_ID }));
            with_field(&event(&loot_key, "ServerLootGenerated", object(payload), &[], "party"), "event_schema_version", Value::from(SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION))
        } else {
            skipped(&loot_key, "loot")
        };
        collect(&self.commit_events_with_retry(campaign_id, &loot_key, &[loot_event], None)?);

        let distribution_key = encounter_completion_stage_key(Some(&encounter_value), Some(&str_value("distribution")))?;
        let distribution_event = if eligible {
            with_field(
                &event(&distribution_key, "EncounterRewardsDistributed", prepared.get("distribution").cloned().unwrap_or(Value::Null), &strings_of(&recipients), "party"),
                "event_schema_version",
                Value::from(ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION),
            )
        } else {
            skipped(&distribution_key, "distribution")
        };
        let validate_distribution = |state: &Value| -> OrchestratorResult<()> {
            assert_encounter_distribution_preconditions(state, prepared.get("distribution"))?;
            Ok(())
        };
        collect(&self.commit_events_with_retry(campaign_id, &distribution_key, &[distribution_event], if eligible { Some(&validate_distribution) } else { None })?);

        loaded = self.load(campaign_id)?;
        let mut commands = Vec::new();
        let subject = match current_subject(&loaded.state) {
            Some(subject) => subject,
            None => {
                let location = at(Some(&loaded.state), &["scene", "location"]);
                let seed = if js::truthy(location) { location.cloned().unwrap_or(Value::Null) } else { str_value(campaign_id) };
                let subject = location_subject(&loaded.state, &seed);
                commands.push(json!({ "command_type": "UpsertWorldEntity", "entity": subject }));
                subject
            }
        };
        let fact_key = match plan.get("encounter_id") {
            Some(id) if js::truthy(Some(id)) => js::string(Some(id)),
            _ => digest_text(&base_key),
        };
        let mut fact = Map::new();
        fact.insert("id".into(), str_value(format!("fact-{fact_key}-outcome")));
        put(&mut fact, "subject_id", subject.get("id"));
        fact.insert("predicate".into(), str_value("encounter_outcome"));
        put(&mut fact, "object", plan.get("outcome"));
        // Код исхода — для механики (`object`), игроку и эпилогу — русская фраза.
        fact.insert("summary".into(), str_value(format!("Встреча завершилась: {}.", encounter_end_text(plan.get("outcome")))));
        fact.insert("visibility".into(), str_value("party"));
        fact.insert("source_event_ids".into(), Value::Array(list(outcome_commit.get("events")).iter().filter_map(|entry| entry.get("event_id").filter(|id| js::truthy(Some(id))).cloned()).collect()));
        commands.push(json!({ "command_type": "RecordWorldFact", "fact": object(fact) }));
        commands.push(json!({ "command_type": "UpdateObjective", "objective": next_hook(&loaded.state, None) }));
        let consequences = self.run(campaign_id, &format!("{base_key}:consequences"), &commands)?;
        collect(&consequences);

        // После поражения без смертей отряд приходит в себя через 1d4 часа и
        // отдыхает; после победы отдыха без заявки нет — кроме победы, после
        // которой на ногах никого (тогда время идёт до пробуждения).
        let plan_outcome = js::s(plan.get("outcome"));
        let incapacitated = plan_outcome == "party_incapacitated";
        let victory = plan_outcome == "enemies_defeated" || plan_outcome == "fled";
        if incapacitated || (victory && nobody_standing(&self.load(campaign_id)?.state)) {
            let mut after = self.load(campaign_id)?;
            if incapacitated {
                // Победители, уложив отряд, уходят — состоянием `fled`.
                let victors: Vec<Value> = list(after.state.get("enemies"))
                    .iter()
                    .filter(|enemy| game::is_living_actor(enemy))
                    .map(|enemy| {
                        let id = js::string(enemy.get("id"));
                        json!({ "command_type": "AddCondition", "actor_id": id, "target_id": id, "condition": "fled" })
                    })
                    .collect();
                if !victors.is_empty() {
                    let departed = self.run(campaign_id, &format!("{base_key}:victors-depart"), &victors)?;
                    collect(&departed);
                    after = self.load(campaign_id)?;
                }
            }
            let survivors = |state: &Value| -> Vec<Value> {
                let party: Vec<String> = strings_of(list(state.get("partyMemberIds")));
                list(state.get("players"))
                    .iter()
                    .filter(|hero| {
                        let id = js::string(hero.get("id"));
                        party.contains(&id) && !is_str(get(at(Some(state), &["mechanics", "death", "heroes"]).and_then(|heroes| get(Some(heroes), &id)), "status"), "dead")
                    })
                    .cloned()
                    .collect()
            };
            let stable_key = format!("{base_key}:stable-recovery");
            let existing_stable = self.by_key(campaign_id, &stable_key)?;
            let mut stable_minutes = if existing_stable.is_some() { STABLE_RECOVERY_MINUTES } else { 0 };
            if existing_stable.is_none() && survivors(&after.state).iter().any(|hero| js::number(hero.get("hp")) == 0.0) {
                stable_minutes = STABLE_RECOVERY_MINUTES;
                let stable = self.run(campaign_id, &stable_key, &[json!({ "command_type": "AdvanceTime", "amount": stable_minutes, "unit": "minute" })])?;
                collect(&stable);
                after = self.load(campaign_id)?;
            }
            let resting: Vec<Value> = survivors(&after.state).into_iter().filter(|hero| js::number(hero.get("hp")) > 0.0).collect();
            if !resting.is_empty() && incapacitated {
                let reason = "post_defeat_recovery";
                let downtime = completed_downtime(&after.state, &json!({ "kind": "long_rest", "durationMinutes": 480 + stable_minutes, "reason": reason }));
                let mut recovery_commands: Vec<Value> = resting.iter().map(|hero| json!({ "command_type": "StartRest", "actor_id": js::string(hero.get("id")), "kind": "long" })).collect();
                recovery_commands.push(json!({ "command_type": "AdvanceTime", "amount": 480, "unit": "minute" }));
                recovery_commands.extend(resting.iter().map(|hero| json!({ "command_type": "CompleteRest", "actor_id": js::string(hero.get("id")), "kind": "long" })));
                let recovery = self.run(campaign_id, &format!("{base_key}:recovery"), &recovery_commands)?;
                collect(&recovery);
                let downtime_key = format!("{base_key}:downtime");
                let payload = js::spread(&downtime, json!({ "provenance": { "source": "server-downtime-policy" } }));
                let downtime_commit = self.commit_events_with_retry(campaign_id, &downtime_key, &[event(&downtime_key, "DowntimeResolved", payload, &strings_of(list(downtime.get("participant_ids"))), "party")], None)?;
                collect(&downtime_commit);
            }
        }

        let source_event_id = list(outcome_commit.get("events")).iter().find(|entry| type_is(entry, "EncounterOutcomeRecorded")).and_then(|entry| entry.get("event_id")).cloned();
        self.propagate_witnesses(campaign_id, source_event_id.as_ref(), if victory { "helpful" } else { "harmful" }, "major", &format!("{base_key}:witnesses"))?;
        if let Some(completion) = self.complete_campaign_if_ready(campaign_id, &base_key).await? {
            collect(&completion);
        }

        let before_transition = self.load(campaign_id)?;
        let transition = json!({
            "transition_id": format!("transition-{fact_key}"),
            "status": "available",
            "hook": next_hook(&before_transition.state, None),
        });
        let mut payload = Map::new();
        put(&mut payload, "encounter_id", plan.get("encounter_id"));
        payload.insert("transition".into(), transition);
        payload.insert("provenance".into(), provenance.clone());
        let transition_commit = self.commit_events_with_retry(campaign_id, &transition_key, &[event(&transition_key, "TransitionUnlocked", object(payload), &[], "party")], None)?;
        collect(&transition_commit);

        let last = self.load(campaign_id)?;
        let duplicate = emitted.is_empty();
        Ok(json!({ "events": emitted, "reward": response_of(&plan, &prepared)?, "state": last.state, "state_version": last.state_version, "admin_commands": 0, "duplicate": duplicate }))
    }

    /// `propagateWitnesses(campaignId, { sourceEventId, outcome, severity, idempotencyKey })`:
    /// свидетели места и их фракции узнают об исходе.
    pub fn propagate_witnesses(&self, campaign_id: &str, source_event_id: Option<&Value>, outcome: &str, severity: &str, idempotency_key: &str) -> OrchestratorResult<Value> {
        let loaded = self.load(campaign_id)?;
        let state = &loaded.state;
        let source = source_event_id.cloned().unwrap_or_else(|| str_value(""));
        let location = clean_lower(at(Some(state), &["scene", "location"]), 180);
        let mut witnesses: Vec<Value> = list(at(Some(state), &["social", "npcs"]))
            .iter()
            .filter(|npc| !js::is_false(get(Some(npc), "available")) && (!js::truthy(get(Some(npc), "location")) || clean_lower(get(Some(npc), "location"), 180) == location))
            .map(|npc| str_value(js::string(get(Some(npc), "id"))))
            .collect();
        js::default_sort(&mut witnesses);
        let witness_ids = strings_of(&witnesses);
        let factions = faction_ids_for_witnesses(state, &witness_ids);
        let delta = server_reputation_delta(&json!({ "outcome": outcome, "severity": severity }));
        let mut events = vec![event(
            &format!("{idempotency_key}:graph"),
            "WitnessConsequencePropagated",
            json!({
                "source_event_id": source,
                "witness_ids": witnesses,
                "faction_ids": factions,
                "propagation_scope": "direct-factions-only",
                "outcome": outcome, "severity": severity,
                "provenance": { "source": "server-witness-policy" },
            }),
            &witness_ids,
            "party",
        )];
        for faction in &factions {
            events.push(event(
                &format!("{idempotency_key}:{}", js::string(Some(faction))),
                "FactionReputationAdjusted",
                json!({
                    "faction_id": faction,
                    "delta": delta,
                    "source_event_id": source,
                    "witness_ids": witnesses,
                    "provenance": { "source": "server-reputation-table", "policy": "faction-reputation-v1" },
                }),
                &[],
                "party",
            ));
        }
        self.commit_events(campaign_id, idempotency_key, &events)
    }

    /// `advanceTime(campaignId, { amount, unit, idempotencyKey })`: сдвиг
    /// мировых часов. Расписания NPC здесь не исполняются — их читает
    /// `npcProfileAtWorldTime` на текущую минуту.
    pub fn advance_time(&self, campaign_id: &str, amount: Option<&Value>, unit: Option<&Value>, idempotency_key: &str) -> OrchestratorResult<Value> {
        let elapsed = |state: &Value| {
            let value = js::number(at(Some(state), &["mechanics", "world_time", "elapsed_minutes"]));
            if value.is_nan() || value == 0.0 {
                None
            } else {
                Some(value)
            }
        };
        let before = self.load(campaign_id)?;
        let start = elapsed(&before.state).unwrap_or(0.0);
        let mut command = Map::new();
        command.insert("command_type".into(), str_value("AdvanceTime"));
        put(&mut command, "amount", amount);
        command.insert("unit".into(), unit.cloned().unwrap_or_else(|| str_value("minute")));
        self.run(campaign_id, &format!("{idempotency_key}:clock"), &[object(command)])?;
        let after = self.load(campaign_id)?;
        let end = elapsed(&after.state).unwrap_or(start);
        Ok(json!({ "before": js::num(start), "after": js::num(end), "state": after.state, "admin_commands": 0 }))
    }

    /// `bindPromise(campaignId, { promiseId, condition, idempotencyKey })`:
    /// условие исполнения обещания — факт памяти мира для ведущего.
    pub fn bind_promise(&self, campaign_id: &str, promise_id: Option<&Value>, condition: Option<&Value>, idempotency_key: Option<&str>) -> OrchestratorResult<Value> {
        let key = match idempotency_key {
            Some(key) => key.to_string(),
            None => format!("promise-binding-{}", js::string(promise_id)),
        };
        let loaded = self.load(campaign_id)?;
        let state = &loaded.state;
        if !list(at(Some(state), &["social", "promises"])).iter().any(|candidate| same(get(Some(candidate), "id"), promise_id) && is_str(get(Some(candidate), "status"), "open")) {
            return Err(OrchestratorError::plain("Open promise not found"));
        }
        if !["QuestClockAdvanced", "EncounterOutcomeRecorded", "WorldFactRecorded"].iter().any(|allowed| is_str(get(condition, "event_type"), allowed)) {
            return Err(OrchestratorError::plain("Promise condition event is not allowed"));
        }
        let mut commands = Vec::new();
        let subject = match current_subject(state) {
            Some(subject) => subject,
            None => {
                let subject = json!({ "id": format!("world-{}", digest_text(campaign_id)), "kind": "concept", "name": "События мира", "summary": "", "aliases": [], "visibility": "party", "tags": [] });
                commands.push(json!({ "command_type": "UpsertWorldEntity", "entity": subject }));
                subject
            }
        };
        let mut binding = Map::new();
        put(&mut binding, "promise_id", promise_id);
        put(&mut binding, "condition", condition);
        let condition_digest = match condition {
            Some(condition) => digest(condition),
            // `JSON.stringify(undefined)` — не строка; `update(undefined)` бросает.
            None => return Err(OrchestratorError::named("TypeError", Some("ERR_INVALID_ARG_TYPE".into()), "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined")),
        };
        let mut fact = Map::new();
        fact.insert("id".into(), str_value(format!("promise-condition-{}-{condition_digest}", js::string(promise_id))));
        put(&mut fact, "subject_id", subject.get("id"));
        fact.insert("predicate".into(), str_value("promise_condition"));
        fact.insert("object".into(), str_value(js::stringify(&object(binding))));
        fact.insert("summary".into(), str_value(format!("Условие обещания {}", js::string(promise_id))));
        fact.insert("visibility".into(), str_value("gm_only"));
        fact.insert("source_event_ids".into(), json!([]));
        commands.push(json!({ "command_type": "RecordWorldFact", "fact": object(fact) }));
        self.run(campaign_id, &key, &commands)
    }

    /// `resolvePromiseConditions(campaignId, triggeringEvents, idempotencyKey)`:
    /// событие, названное условием обещания, исполняет его.
    pub fn resolve_promise_conditions(&self, campaign_id: &str, triggering_events: &[Value], idempotency_key: &str) -> OrchestratorResult<Option<Value>> {
        if triggering_events.is_empty() {
            return Ok(None);
        }
        let loaded = self.load(campaign_id)?;
        let state = &loaded.state;
        let bindings: Vec<Value> = list(at(Some(state), &["worldMemory", "facts"]))
            .iter()
            .filter(|fact| is_str(get(Some(fact), "status"), "active") && is_str(get(Some(fact), "predicate"), "promise_condition"))
            .filter_map(parse_json_fact)
            .filter(|binding| js::truthy(Some(binding)))
            .collect();
        let mut commands = Vec::new();
        for binding in &bindings {
            let Some(promise) = list(at(Some(state), &["social", "promises"])).iter().find(|candidate| same(get(Some(candidate), "id"), get(Some(binding), "promise_id")) && is_str(get(Some(candidate), "status"), "open")) else {
                continue;
            };
            let condition = get(Some(binding), "condition");
            let matched = triggering_events.iter().any(|entry| {
                same(entry.get("event_type"), get(condition, "event_type"))
                    && (!js::truthy(get(condition, "quest_id")) || same(get(condition, "quest_id"), at(Some(entry), &["payload", "quest_id"])))
                    && (!js::truthy(get(condition, "outcome")) || same(get(condition, "outcome"), at(Some(entry), &["payload", "outcome"])))
            });
            if matched {
                let mut command = Map::new();
                command.insert("command_type".into(), str_value("ResolveNpcPromise"));
                put(&mut command, "promise_id", promise.get("id"));
                command.insert("status".into(), str_value("fulfilled"));
                commands.push(object(command));
            }
        }
        if commands.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.run_commands(campaign_id, idempotency_key, &commands, &json!({ "isSocialController": true }), None)?))
    }
}

// --- помощники ответа -------------------------------------------------------------------

/// `x.length` массива или строки (иначе 0).
fn list_len(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(text)) => text.encode_utf16().count(),
        _ => 0,
    }
}

/// `x.length` или `undefined`.
fn length_of(value: Option<&Value>) -> Option<usize> {
    match value {
        Some(Value::Array(items)) => Some(items.len()),
        Some(Value::String(text)) => Some(text.encode_utf16().count()),
        _ => None,
    }
}

/// Параметр со значением по умолчанию `''`, приведённый `String(x)`.
fn param_text(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        some => js::string(some),
    }
}

fn quest_id_text(value: Option<&Value>) -> String {
    param_text(value)
}

/// `container.includes(item)` для массива или строки.
fn includes_of(container: &Value, item: Option<&Value>) -> bool {
    match container {
        Value::Array(items) => includes(items, item),
        Value::String(text) => text.contains(js::string(item).as_str()),
        _ => false,
    }
}

/// `container?.includes(item)`.
fn includes_of_opt(container: Option<&Value>, item: Option<&Value>) -> bool {
    container.is_some_and(|container| includes_of(container, item))
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    if js::truthy(value) {
        value.cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

/// `Math.max(a, b)` чисел JS: `NaN` заражает.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `array[index]` JS: целое число или каноническая строка индекса.
fn index_of<'a>(items: Option<&'a Value>, index: Option<&Value>) -> Option<&'a Value> {
    let items = items?.as_array()?;
    let position = match index? {
        Value::Number(number) => {
            let value = number.as_f64()?;
            (value.fract() == 0.0 && value >= 0.0 && value < 4_294_967_295.0).then_some(value as usize)?
        }
        Value::String(text) => {
            let value: usize = text.parse().ok()?;
            (value.to_string() == *text).then_some(value)?
        }
        _ => return None,
    };
    items.get(position)
}

/// Событие пропса, потратившее действие хода.
fn spent_action(events: &[Value]) -> bool {
    events.iter().any(|entry| type_is(entry, "SceneObjectOperated") && js::is_true(at(Some(entry), &["payload", "action_spent"])))
}

/// `{ command_type: 'ResolveImprovisedAction', actor_id, action_cost, summary, ruling_id }`.
fn improvised_action_command(actor_id: &str, action_cost: &Value, summary: Option<&Value>, ruling_id: &str) -> Value {
    let mut command = Map::new();
    command.insert("command_type".into(), str_value("ResolveImprovisedAction"));
    command.insert("actor_id".into(), str_value(actor_id));
    put(&mut command, "action_cost", action_cost.get("cost"));
    put(&mut command, "summary", summary);
    command.insert("ruling_id".into(), str_value(ruling_id));
    object(command)
}

/// Вставить поле сразу после `after` (порядок ключей ответа как в JS).
fn insert_after(reply: &mut Value, after: &str, key: &str, value: Value) {
    let Some(map) = reply.as_object_mut() else { return };
    let mut next = Map::new();
    let mut placed = false;
    for (name, field) in std::mem::take(map) {
        let matched = name == after;
        next.insert(name, field);
        if matched {
            next.insert(key.into(), value.clone());
            placed = true;
        }
    }
    if !placed {
        next.insert(key.into(), value);
    }
    *map = next;
}

/// `{ ...unchanged, kind, narration }`: поля ответа идут первыми.
fn unchanged_first(reply: &Value) -> Value {
    let Some(map) = reply.as_object() else { return reply.clone() };
    let mut next = Map::new();
    for (name, field) in map {
        if name != "kind" && name != "narration" {
            next.insert(name.clone(), field.clone());
        }
    }
    for name in ["kind", "narration"] {
        if let Some(field) = map.get(name) {
            next.insert(name.into(), field.clone());
        }
    }
    Value::Object(next)
}
