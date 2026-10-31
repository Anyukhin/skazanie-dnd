//! `server/game-orchestrator.mjs` — оркестрация цикла `/api/narrate`
//! (задача О2).
//!
//! Ход игрока: разбор намерения → маршрут (вопрос, обсуждение, Хранитель
//! знаний, уточнение, свободное действие, разговор с NPC, механика) → план
//! команд → Rules Engine → коммит в журнал → проекция для зрителя → бриф
//! Рассказчика и текст после коммита → трасса хода. Модель не стоит в
//! горячем пути хода: механику решает сервер, Рассказчик описывает только
//! закоммиченные события, а свободное действие уходит исполнителю О1
//! ([`crate::autonomous_orchestrator`]).
//!
//! Внедряется всё, что JS получал в конструкторе ([`GameOrchestratorOptions`]):
//! журнал ([`OrchestratorJournal`] О1), движок ([`TurnRules`]), разбор
//! намерения ([`IntentReader`]), поиск правил ([`RuleSearch`]), план механики
//! ([`PlanAdjudicator`]), трассы ([`TurnTraceStore`]), Рассказчик
//! ([`TurnNarrator`]), собеседник-NPC ([`SocialResponder`]), исполнитель
//! свободного действия ([`UnknownActionHandler`]), судья обсуждения
//! ([`TableDiscussion`]), голос Хранителя ([`LoreRetell`]), реестр бросков
//! ([`TurnRollRegistry`]), реестр уточнений (общий с HTTP-слоем, как
//! `gameOrchestrator.clarificationRegistry` в `server/index.mjs`), источник
//! идентификаторов и часы.
//!
//! «Комнату» этот модуль JS не читает и не пишет: состояние хода приходит
//! полем `state` запроса и из журнала. Транспорт живого рассказа
//! (`onNarrationStart`, `onNarrationProgress`) и серверная метка Режиссёра
//! (`DIRECTOR_COMMAND_CAPABILITY`, `Symbol` в JS) не сериализуются — это поля
//! [`HandleInput`], а не JSON запроса.

use std::cell::RefCell;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll, Waker};

use serde_json::{json, Map, Value};
use sk_agents::action_adjudicator::{ActionAdjudicator, DiscussOptions};
use sk_agents::free_action_adjudication::{
    d20_check_label, explain_action_check, free_action_approach_plan, free_action_goal_is_passage, free_action_is_copy_request, has_recognized_free_action_approach, interpret_free_action, minutes_label_ru, SKILL_LABELS_RU,
};
use sk_agents::lore_voice::LoreVoice;
use sk_agents::narrator::{deterministic_narration, narrator_response_plan, verify_narrator_craft, Narrator, NarratorError, ProgressCallback, RenderOptions, NARRATOR_PROMPT_VERSION, NARRATOR_RECENT_TEXT_LIMIT};
use sk_agents::npc_social_controller::NpcSocialController;
use sk_agents::player_request_router::{answer_known_lore, answer_table_question, KnownLoreOptions};
use sk_core::fancy_regex;
use sk_core::indexmap::IndexMap;
use sk_core::{hash, js, re, text, RuleError};
use sk_economy::merchant_economy::currency_to_copper;
use sk_encounters::agent_context::{agent_context_metadata, campaign_concept_for_agent, hero_card_for_agent, npc_known_by_name, scene_context_for_agent, AgentContextOptions};
use sk_infra::roll_registry::RollRegistry;
use sk_items::pickpocket::{pickpocket_difficulty_for, PICKPOCKET_ABILITY, PICKPOCKET_POLICY_ID, PICKPOCKET_SKILL};
use sk_memory::world_memory::{free_action_discovery_commands, free_action_surface_commands, retrieve_world_memory, thorough_search_detail, thorough_search_outcome, DISCOVERY_SKILLS};
use sk_narration::combat_narration::{combat_narration, damage_type_label, COMBAT_NARRATOR};
use sk_narration_base::clarification_registry::{ClarificationRegistry, ClarificationRegistryOptions};
use sk_narration_base::deterministic_narration::{deterministic_narrator_for, render_deterministic_narration, DeterministicNarrator};
use sk_narration_base::prompt_descriptors::PROMPT_DESCRIPTORS;
use sk_npc_world::beast_taming::{beast_for, beast_id_for, beast_taming_policy, tameable_beasts, BEAST_TAMING_ABILITY, BEAST_TAMING_POLICY_ID, BEAST_TAMING_SKILL};
use sk_npc_world::blessings::{BLESSINGS_POLICY_ID, PRAYER_ABILITY, PRAYER_DC, PRAYER_SKILL};
use sk_npc_world::npc_positioning::present_scene_npcs;
use sk_npc_world::tavern_life::{tavern_round_for, TAVERN_DICE_APPROACHES, TAVERN_POLICY_ID};
use sk_projection::trace_store::{build_turn_explanation, is_mechanical_trace, FileTraceStore, TraceStoreError, TURN_TRACE_SCHEMA_VERSION};
use sk_projection::viewer_projection::{campaign_state_for_viewer, mechanics_for_viewer, public_adventure_for, turn_explanation_for_viewer, ProjectionError};
use sk_rules::context::Context;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::normalized::NormalizedState;
use sk_rules::pause::Halt;
use sk_rules::preview_checks::{preview_d20_check, preview_tavern_dice_roll, shrine_prayer_refusal_for};
use sk_rules::resolve::api::RulesEngine;
use sk_rules::summary::{actor_name_resolver, event_summary, NameResolver};
use sk_scenario::campaign_scenario::scenario_narrator_brief;
use sk_social::npc_social::{ensure_npc_social_state, npc_conversation_narration, npc_profile_at_world_time, npc_social_for_viewer, relationship_tier};
use sk_social::npc_social_check::{assert_npc_social_check_fingerprint, build_npc_social_check_policy, npc_social_check_outcome};
use sk_society::law_and_order::{guard_encounter_for, LAW_POLICY_ID};
use sk_society::parley::{mentions_parley, parley_morale_for, parley_skill_for, truce_for, PARLEY_ABILITY, PARLEY_POLICY_ID};
use sk_society::quest_consequences::{knowledge_gate_visible, quest_state_for_viewer};
use sk_store::{CommitRequest, CommitResult, StoreError};
use sk_story::intent_parser::{action_sequence, build_rule_queries, infer_request_kind, named_known_spell, normalize_request_kind, same_name_token, IntentParser};
use sk_tactics::adjudicator::Adjudicator;
use sk_tactics::security::{build_narration_brief, project_visible_state, redact_trace, validate_allowed_commands, verify_narration, SecurityValidationError};
use sk_world_story::scene_canon::scene_canon_for;
use sk_world_time::weather::world_clock_for_agents;

use crate::autonomous_orchestrator::{AgentFuture, AutonomousCampaignOrchestrator, CheckRegistry, FreeActionReader, OrchestratorError, OrchestratorJournal, OrchestratorResult, OrchestratorRules, UnknownAction};

// --- ошибки соседних модулей ------------------------------------------------------------

fn security_error(error: SecurityValidationError) -> OrchestratorError {
    OrchestratorError::named(error.name, error.code, error.message)
}

fn projection_error(error: ProjectionError) -> OrchestratorError {
    OrchestratorError::named(&error.name, error.code, error.message)
}

fn trace_error(error: TraceStoreError) -> OrchestratorError {
    match error {
        TraceStoreError::Type(message) => OrchestratorError::named("TypeError", None, message),
        TraceStoreError::Io(cause) => OrchestratorError::plain(cause.to_string()),
        TraceStoreError::Json(message) => OrchestratorError::named("SyntaxError", None, message),
    }
}

/// Отказ реестра уточнений: `Object.assign(new Error(message), { code })`.
fn registry_error(error: RuleError) -> OrchestratorError {
    OrchestratorError::coded(&error.code, error.message)
}

fn roll_registry_error(error: sk_infra::roll_registry::RollRegistryError) -> OrchestratorError {
    OrchestratorError::named(error.name(), error.code().map(str::to_string), error.to_string())
}

fn type_error(message: impl Into<String>) -> OrchestratorError {
    OrchestratorError::named("TypeError", None, message)
}

fn context_mismatch(message: &str) -> OrchestratorError {
    OrchestratorError::coded("ROLL_CONTEXT_MISMATCH", message)
}

fn idempotency_conflict(campaign_id: &str, idempotency_key: &str) -> OrchestratorError {
    OrchestratorError::Store(StoreError::idempotency_conflict(campaign_id, idempotency_key))
}

// --- внедрение -----------------------------------------------------------------------------

/// Движок правил хода: `resolvePlan(plan, state, context)` с полным планом
/// (манёвр плана останавливает атаку после шага) и `validate` от О1.
pub trait TurnRules: OrchestratorRules {
    /// `rulesEngine.resolvePlan(plan, state, context)` → `{ commands, events, rolls, state }`.
    fn resolve_turn_plan(&self, plan: &Value, state: &Value, context: &Value) -> Result<Value, Halt>;
    /// [`Self::resolve_turn_plan`] над нормализованным состоянием (урок 4):
    /// движок не нормализует его заново.
    fn resolve_turn_plan_normalized(&self, plan: &Value, state: &NormalizedState, context: &Value) -> Result<Value, Halt> {
        self.resolve_turn_plan(plan, state.value(), context)
    }
}

impl TurnRules for RefCell<RulesEngine> {
    fn resolve_turn_plan(&self, plan: &Value, state: &Value, context: &Value) -> Result<Value, Halt> {
        let resolved = self.borrow_mut().resolve_plan(plan, state, &Context::from_json(context))?;
        Ok(json!({ "commands": resolved.commands, "events": resolved.events, "rolls": resolved.rolls, "state": resolved.state }))
    }

    fn resolve_turn_plan_normalized(&self, plan: &Value, state: &NormalizedState, context: &Value) -> Result<Value, Halt> {
        let resolved = self.borrow_mut().resolve_plan_normalized(plan, state, &Context::from_json(context))?;
        Ok(json!({ "commands": resolved.commands, "events": resolved.events, "rolls": resolved.rolls, "state": resolved.state }))
    }
}

/// Разбор намерения (`intentParser.parse({ message, playerId, visibleState })`).
pub trait IntentReader {
    fn parse<'a>(&'a self, message: &'a str, player_id: &'a str, visible_state: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>>;
}

impl IntentReader for IntentParser {
    fn parse<'a>(&'a self, message: &'a str, player_id: &'a str, visible_state: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            let message = Value::String(message.into());
            let player = Value::String(player_id.into());
            Ok(IntentParser::parse(self, Some(&message), Some(&player), Some(visible_state)))
        })
    }
}

/// План механики (`adjudicator.createPlan({ intent, state, retrievedRules })`).
pub trait PlanAdjudicator {
    fn create_plan<'a>(&'a self, intent: &'a Value, state: &'a Value, retrieved_rules: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>>;
}

impl PlanAdjudicator for Adjudicator {
    fn create_plan<'a>(&'a self, intent: &'a Value, state: &'a Value, retrieved_rules: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { Adjudicator::create_plan(self, Some(intent), state, Some(retrieved_rules)).map_err(OrchestratorError::from) })
    }
}

/// Поиск правил (`ruleRetriever.search({ queries, ruleset_id, enabled_packs, limit })`).
/// Реализация — `sk_rulepack::rule_retriever` у HTTP-слоя: зависимости на
/// `sk-rulepack` у этого крейта нет.
pub trait RuleSearch {
    fn search<'a>(&'a self, request: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>>;
}

/// Хранилище трасс хода (`traceStore`).
pub trait TurnTraceStore {
    /// `get(campaignId, turnId)`.
    fn get(&self, campaign_id: &str, turn_id: &str) -> OrchestratorResult<Option<Value>>;
    /// `latest(campaignId, { predicate })`.
    fn latest(&self, campaign_id: &str, predicate: Option<&dyn Fn(&Value) -> bool>) -> OrchestratorResult<Option<Value>>;
    /// `recent(campaignId, limit, { predicate })`.
    fn recent(&self, campaign_id: &str, limit: usize, predicate: Option<&dyn Fn(&Value) -> bool>) -> OrchestratorResult<Vec<Value>>;
    /// `save(input)`.
    fn save(&self, input: &Value) -> OrchestratorResult<Value>;
    /// `saveIfAbsent(input).trace`; `None` — у хранилища такого метода нет.
    fn save_if_absent(&self, _input: &Value) -> Option<OrchestratorResult<Value>> {
        None
    }
}

impl TurnTraceStore for FileTraceStore {
    fn get(&self, campaign_id: &str, turn_id: &str) -> OrchestratorResult<Option<Value>> {
        FileTraceStore::get(self, Some(&Value::String(campaign_id.into())), Some(&Value::String(turn_id.into()))).map_err(trace_error)
    }

    fn latest(&self, campaign_id: &str, predicate: Option<&dyn Fn(&Value) -> bool>) -> OrchestratorResult<Option<Value>> {
        FileTraceStore::latest(self, Some(&Value::String(campaign_id.into())), predicate).map_err(trace_error)
    }

    fn recent(&self, campaign_id: &str, limit: usize, predicate: Option<&dyn Fn(&Value) -> bool>) -> OrchestratorResult<Vec<Value>> {
        FileTraceStore::recent(self, Some(&Value::String(campaign_id.into())), Some(&Value::from(limit as u64)), predicate).map_err(trace_error)
    }

    fn save(&self, input: &Value) -> OrchestratorResult<Value> {
        FileTraceStore::save(self, input).map_err(trace_error)
    }

    fn save_if_absent(&self, input: &Value) -> Option<OrchestratorResult<Value>> {
        Some(FileTraceStore::save_if_absent(self, input).map(|(trace, _)| trace).map_err(trace_error))
    }
}

/// Параметры `narrator.render(brief, { knownRuleIds, recentNarrations, onProgress })`.
#[derive(Clone, Default)]
pub struct NarrationOptions {
    pub known_rule_ids: Vec<Value>,
    pub recent_narrations: Vec<String>,
    pub on_progress: Option<ProgressCallback>,
}

/// Рассказчик хода (`narrator.render`).
pub trait TurnNarrator {
    fn render<'a>(&'a self, brief: &'a Value, options: NarrationOptions) -> AgentFuture<'a, OrchestratorResult<Value>>;
}

impl TurnNarrator for Narrator {
    fn render<'a>(&'a self, brief: &'a Value, options: NarrationOptions) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            let render = RenderOptions {
                known_rule_ids: Some(Value::Array(options.known_rule_ids)),
                style: None,
                timeout_ms: None,
                recent_narrations: Value::Array(options.recent_narrations.into_iter().map(Value::String).collect()),
                on_progress: options.on_progress,
            };
            Narrator::render(self, brief, render).await.map_err(|error| match error {
                NarratorError::Security(error) => security_error(error),
            })
        })
    }
}

/// Собеседник-NPC (`npcSocialController.respond(input)`).
pub trait SocialResponder {
    fn respond<'a>(&'a self, input: &'a Value) -> AgentFuture<'a, OrchestratorResult<Option<Value>>>;
}

impl SocialResponder for NpcSocialController {
    fn respond<'a>(&'a self, input: &'a Value) -> AgentFuture<'a, OrchestratorResult<Option<Value>>> {
        Box::pin(async move { NpcSocialController::respond(self, input).await.map_err(|error| OrchestratorError::named(&error.name, error.code, error.message)) })
    }
}

/// Голос Хранителя знаний (`loreVoice.retell(input)`).
pub trait LoreRetell {
    fn retell<'a>(&'a self, input: &'a Value) -> AgentFuture<'a, OrchestratorResult<Option<Value>>>;
}

impl LoreRetell for LoreVoice {
    fn retell<'a>(&'a self, input: &'a Value) -> AgentFuture<'a, OrchestratorResult<Option<Value>>> {
        Box::pin(async move { Ok(LoreVoice::retell(self, input).await) })
    }
}

/// Судья обсуждения (`actionAdjudicator.discuss(state, actorId, question, { action, recent })`).
pub trait TableDiscussion {
    fn discuss<'a>(&'a self, state: &'a Value, actor_id: &'a str, question: &'a str, action: String, recent: Vec<Value>) -> AgentFuture<'a, OrchestratorResult<Value>>;
}

impl TableDiscussion for ActionAdjudicator {
    fn discuss<'a>(&'a self, state: &'a Value, actor_id: &'a str, question: &'a str, action: String, recent: Vec<Value>) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            let options = DiscussOptions { action, recent, check: None };
            ActionAdjudicator::discuss(self, state, actor_id, question, &options).await.map_err(OrchestratorError::from)
        })
    }
}

/// Исполнитель свободного действия (`unknownActionHandler`): О1 или его замена.
pub trait UnknownActionHandler {
    /// `handleUnknownAction({ campaignId, action, idempotencyKey, playerId, intent, manualRoll, verifiedRoll, confirmedAction })`.
    fn handle_unknown_action<'a>(&'a self, request: &'a UnknownAction) -> AgentFuture<'a, OrchestratorResult<Value>>;
    /// `unknownActionHandler.actionAdjudicator`: судья, которым читаются
    /// детали прямой проверки навыка.
    fn action_adjudicator(&self) -> Option<Arc<dyn FreeActionReader>>;
}

impl UnknownActionHandler for AutonomousCampaignOrchestrator {
    fn handle_unknown_action<'a>(&'a self, request: &'a UnknownAction) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(AutonomousCampaignOrchestrator::handle_unknown_action(self, request))
    }

    fn action_adjudicator(&self) -> Option<Arc<dyn FreeActionReader>> {
        self.action_adjudicator.clone()
    }
}

/// Реестр бросков хода: регистрация карточки (О1), чтение, отзыв.
pub trait TurnRollRegistry: CheckRegistry {
    /// `getCheck(checkId, { campaignId, actorId, includeContext })`.
    fn get_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<Value>;
    /// `invalidateCheck(checkId, { campaignId, actorId, reason })`.
    fn invalidate_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<bool>;
    /// `invalidateProposal(proposalId, { campaignId, actorId, reason })`.
    fn invalidate_proposal(&self, proposal_id: &str, options: &Value) -> OrchestratorResult<bool>;
}

impl TurnRollRegistry for Mutex<RollRegistry> {
    fn get_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<Value> {
        lock(self).get_check(&Value::String(check_id.into()), options).map_err(roll_registry_error)
    }

    fn invalidate_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<bool> {
        lock(self).invalidate_check(&Value::String(check_id.into()), options).map_err(roll_registry_error)
    }

    fn invalidate_proposal(&self, proposal_id: &str, options: &Value) -> OrchestratorResult<bool> {
        lock(self).invalidate_proposal(&Value::String(proposal_id.into()), options).map_err(roll_registry_error)
    }
}

impl TurnRollRegistry for RefCell<RollRegistry> {
    fn get_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<Value> {
        self.borrow_mut().get_check(&Value::String(check_id.into()), options).map_err(roll_registry_error)
    }

    fn invalidate_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<bool> {
        self.borrow_mut().invalidate_check(&Value::String(check_id.into()), options).map_err(roll_registry_error)
    }

    fn invalidate_proposal(&self, proposal_id: &str, options: &Value) -> OrchestratorResult<bool> {
        self.borrow_mut().invalidate_proposal(&Value::String(proposal_id.into()), options).map_err(roll_registry_error)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// --- приведения JS ----------------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn at<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| get(current, key))
}

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

/// `a ?? b ?? …`: первое не-`null`.
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| matches!(value, Some(found) if !found.is_null())).flatten()
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

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

fn str_value(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

fn set(target: &mut Value, key: &str, value: Value) {
    if let Some(map) = target.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// `{ ...base, key: undefined }`: поле `undefined` в JSON не попадает.
fn unset(target: &mut Value, key: &str) {
    if let Some(map) = target.as_object_mut() {
        map.shift_remove(key);
    }
}

fn with(base: &Value, patch: Value) -> Value {
    js::spread(base, patch)
}

fn len_of(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(text)) => text.encode_utf16().count(),
        _ => 0,
    }
}

/// `memoryText(value, maximum)`: NFKC, пробелы схлопнуты, края обрезаны, срез.
fn memory_text(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

fn memory_str(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(value)), maximum)
}

/// `String(x).trim().toLocaleLowerCase('ru')`.
fn place_key(value: Option<&Value>) -> String {
    text::lower(text::trim(&js::s(value)))
}

/// `text.toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
fn yo_lower(value: &str) -> String {
    text::lower(value).replace('ё', "е")
}

fn sha256(value: &str) -> String {
    hash::sha256_hex(value)
}

/// `Number.isSafeInteger(Number(value))`.
fn safe_number(value: Option<&Value>) -> Option<f64> {
    let number = js::number(value);
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number)
}

/// `${value}` в шаблонной строке.
fn template(value: Option<&Value>) -> String {
    js::string(value)
}

/// Параметр функции JS со значением по умолчанию `''`: `undefined` — пусто,
/// прочее — `String(value)`.
fn param_str(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        some => js::string(some),
    }
}

/// Совпадения регулярного выражения: индекс начала в символах, текст и группы.
struct Found {
    index: usize,
    text: String,
    groups: Vec<Option<String>>,
}

fn match_all(regex: &fancy_regex::Regex, value: &str) -> Vec<Found> {
    regex
        .captures_iter(value)
        .filter_map(Result::ok)
        .filter_map(|captures| {
            let whole = captures.get(0)?;
            Some(Found {
                index: value[..whole.start()].chars().count(),
                text: whole.as_str().to_string(),
                groups: (1..captures.len()).map(|group| captures.get(group).map(|found| found.as_str().to_string())).collect(),
            })
        })
        .collect()
}

fn group(found: &Found, index: usize) -> String {
    found.groups.get(index.saturating_sub(1)).cloned().flatten().unwrap_or_default()
}

/// `value.split(regex)` (без групп в выражении).
fn split_by(regex: &fancy_regex::Regex, value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(value).filter_map(Result::ok) {
        if found.end() == found.start() {
            continue;
        }
        parts.push(value[last..found.start()].to_string());
        last = found.end();
    }
    parts.push(value[last..].to_string());
    parts
}

/// `new Set(values)` — уникальные по `===` в порядке первого появления.
fn unique_values(values: Vec<Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for value in values {
        let duplicate = result.iter().any(|seen| match (seen, &value) {
            (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => false,
            _ => same(Some(seen), Some(&value)),
        });
        if !duplicate {
            result.push(value);
        }
    }
    result
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values.into_iter().filter(|value| seen.insert(value.clone())).collect()
}

/// `array.flatMap((item) => item.field ?? [])`: массив разворачивается, прочее
/// значение идёт как есть.
fn flat_field(items: &[Value], key: &str) -> Vec<Value> {
    let mut result = Vec::new();
    for item in items {
        match nullish(get(Some(item), key), None) {
            Some(Value::Array(values)) => result.extend(values.iter().cloned()),
            Some(other) => result.push(other.clone()),
            None => {}
        }
    }
    result
}

/// Ключ `value` в объекте JSON, если `value` задан: `{ key: value }` с
/// `undefined` не создаёт ключа.
fn obj(entries: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            map.insert(key.into(), value);
        }
    }
    Value::Object(map)
}

// --- бриф Рассказчика --------------------------------------------------------------------------

/// `narrationScenarioContext(state)`: сюжет авторского сценария по состоянию
/// для отряда — ненайденного в нём нет.
fn narration_scenario_context(state: &Value) -> Option<Value> {
    let visible = quest_state_for_viewer(state, &json!({ "isPartyMember": true }));
    scenario_narrator_brief(&visible).map(|scenario| json!({ "scenario": scenario }))
}

fn empty_effects() -> Value {
    json!({ "roll": null, "reveal": [], "spawn": [], "objective": null, "grantItems": [] })
}

pub const DIALOGUE_RESPONSE_PLAN_VERSION: &str = "dialogue-response-plan/v1";

/// `dialogueVerification(mode, upstream)`.
fn dialogue_verification(mode: &str, upstream: Option<&Value>) -> Value {
    let mut origin = json!({ "source": "template", "reason": "server_policy" });
    if js::truthy(upstream) {
        set(&mut origin, "upstream", str_value(text::head(&js::string(upstream), 80)));
    }
    json!({
        "valid": true,
        "violations": [],
        "response_plan": {
            "version": DIALOGUE_RESPONSE_PLAN_VERSION,
            "mode": mode,
            "speech_act": if mode == "silence" { "none" } else { "answer_question" },
        },
        "origin": origin,
    })
}

/// Сколько фактов памяти мира получает Рассказчик.
pub const NARRATION_WORLD_FACT_LIMIT: usize = 3;

fn party_visibility(event: &Value) -> bool {
    let visibility = match nullish(event.get("visibility"), None) {
        Some(value) => js::string(Some(value)),
        None => "public".into(),
    };
    visibility == "public" || visibility == "party"
}

/// `sharedNarrationEvents(events, state)`.
fn shared_narration_events(events: &[Value], state: &Value) -> Vec<Value> {
    let memory = state.get("worldMemory").cloned().unwrap_or(Value::Null);
    let viewer = json!({ "isPartyMember": true });
    events.iter().filter(|event| party_visibility(event) && knowledge_gate_visible(at(Some(event), &["payload", "knowledge_gate"]), &memory, &viewer)).cloned().collect()
}

fn identity_name(id: Option<&Value>) -> Option<Value> {
    id.cloned()
}

/// `narrationMemoryQuery(state, message, events)`.
fn narration_memory_query(state: &Value, message: &str, events: &[Value]) -> String {
    let message = str_value(message);
    let mut parts: Vec<String> = Vec::new();
    for value in [Some(&message), at(Some(state), &["scene", "title"]), at(Some(state), &["scene", "location"]), at(Some(state), &["scene", "objective"])] {
        if js::truthy(value) {
            parts.push(js::s(value));
        }
    }
    for event in events {
        let summary = event_summary(event, &identity_name);
        if !summary.is_empty() {
            parts.push(summary);
        }
    }
    text::head(&parts.join(" "), 4_000)
}

/// `narrationWorldFacts(state, viewer, message, events)`.
fn narration_world_facts(state: &Value, viewer: &Value, message: &str, events: &[Value]) -> Vec<Value> {
    let mut memory = match state.get("worldMemory") {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    };
    let facts: Vec<Value> = list(at(Some(state), &["worldMemory", "facts"])).iter().filter(|fact| is_str(get(Some(fact), "visibility"), "public") || is_str(get(Some(fact), "visibility"), "party")).cloned().collect();
    set(&mut memory, "facts", Value::Array(facts));
    let scoped = obj(vec![("playerId", get(Some(viewer), "playerId").cloned()), ("partyIds", get(Some(viewer), "partyIds").cloned()), ("isPartyMember", get(Some(viewer), "isPartyMember").cloned())]);
    let mut options = json!({ "query": narration_memory_query(state, message, events), "limit": NARRATION_WORLD_FACT_LIMIT });
    if let Some(minutes) = at(Some(state), &["mechanics", "world_time", "elapsed_minutes"]) {
        set(&mut options, "asOfMinutes", minutes.clone());
    }
    set(&mut options, "whenUnmatched", str_value("none"));
    retrieve_world_memory(&memory, &scoped, &options)
        .iter()
        .filter(|record| is_str(record.get("kind"), "fact") && (is_str(at(Some(record), &["fact", "visibility"]), "public") || is_str(at(Some(record), &["fact", "visibility"]), "party")))
        .map(|record| {
            json!({
                "id": memory_text(at(Some(record), &["fact", "id"]), 120),
                "subject": memory_text(or(at(Some(record), &["entity", "name"]), at(Some(record), &["fact", "subject_id"])), 120),
                "predicate": memory_text(at(Some(record), &["fact", "predicate"]), 80),
                "summary": memory_text(or(at(Some(record), &["fact", "summary"]), at(Some(record), &["fact", "object"])), 280),
            })
        })
        .filter(|fact| js::truthy(fact.get("id")) && js::truthy(fact.get("summary")))
        .take(NARRATION_WORLD_FACT_LIMIT)
        .collect()
}

/// Пределы контекста сюжета Рассказчика (`NARRATION_STORY_LIMITS`).
pub struct NarrationStoryLimits {
    pub quests: usize,
    pub threads: usize,
    pub summaries: usize,
    pub decisions: usize,
    pub heroes: usize,
    pub npcs: usize,
    pub promises: usize,
    pub interactions: usize,
}

pub const NARRATION_STORY_LIMITS: NarrationStoryLimits = NarrationStoryLimits { quests: 2, threads: 2, summaries: 2, decisions: 2, heroes: 6, npcs: 4, promises: 4, interactions: 4 };

fn party_visible_record(value: Option<&Value>) -> bool {
    let visibility = text::lower(&js::s(get(value, "visibility")));
    visibility == "public" || visibility == "party"
}

fn last_n<T: Clone>(items: &[T], count: usize) -> Vec<T> {
    items[items.len().saturating_sub(count)..].to_vec()
}

/// `narrationQuestClock(clock)`.
fn narration_quest_clock(clock: Option<&Value>) -> Option<Value> {
    let max = safe_number(get(clock, "max"))?;
    if max <= 0.0 {
        return None;
    }
    let current = js::number(get(clock, "current"));
    let current = if current.is_nan() { 0.0 } else { current };
    Some(json!({ "label": memory_text(get(clock, "label"), 80), "current": js::num(current.max(0.0)), "max": js::num(max) }))
}

/// `narrationStoryContext(state, viewer, events)`: связность, а не власть —
/// активные задания, нити, сводки, отряд, NPC в сцене и их обещания.
pub fn narration_story_context(state: &Value, viewer: &Value, events: &[Value]) -> OrchestratorResult<Value> {
    let state = quest_state_for_viewer(state, &json!({ "isPartyMember": true }));
    let state = &state;
    if state.get("players").is_some_and(|players| !players.is_null() && !players.is_array()) {
        return Err(type_error("(state.players ?? []).slice(...).map is not a function"));
    }
    let memory = nullish(state.get("worldMemory"), None);
    let active_quests: Vec<Value> = last_n(&list(get(memory, "quests")).iter().filter(|quest| is_str(get(Some(quest), "status"), "active") && party_visible_record(Some(quest))).cloned().collect::<Vec<_>>(), NARRATION_STORY_LIMITS.quests)
        .iter()
        .map(|quest| {
            let objectives: Vec<Value> = list(get(Some(quest), "objectives")).iter().take(3).map(|objective| memory_text(Some(objective), 200)).filter(|objective| !objective.is_empty()).map(Value::String).collect();
            let mut entry = json!({ "title": memory_text(get(Some(quest), "title"), 160), "summary": memory_text(get(Some(quest), "summary"), 400), "objectives": objectives });
            if let Some(clock) = narration_quest_clock(get(Some(quest), "clock")) {
                set(&mut entry, "clock", clock);
            }
            entry
        })
        .filter(|quest| js::truthy(quest.get("title")))
        .collect();
    let active_threads: Vec<Value> = last_n(&list(get(memory, "threads")).iter().filter(|thread| is_str(get(Some(thread), "status"), "active") && party_visible_record(Some(thread))).cloned().collect::<Vec<_>>(), NARRATION_STORY_LIMITS.threads)
        .iter()
        .map(|thread| json!({ "title": memory_text(get(Some(thread), "title"), 160), "summary": memory_text(get(Some(thread), "summary"), 300) }))
        .filter(|thread| js::truthy(thread.get("title")))
        .collect();
    let recent_summaries: Vec<Value> = last_n(&list(get(memory, "summaries")).iter().filter(|summary| party_visible_record(Some(summary))).cloned().collect::<Vec<_>>(), NARRATION_STORY_LIMITS.summaries)
        .iter()
        .map(|summary| {
            let kind = memory_text(get(Some(summary), "kind"), 40);
            json!({
                "id": memory_text(get(Some(summary), "id"), 120),
                "kind": if kind.is_empty() { "scene".to_string() } else { kind },
                "title": memory_text(get(Some(summary), "title"), 160),
                "summary": memory_text(get(Some(summary), "summary"), 500),
            })
        })
        .filter(|summary| js::truthy(summary.get("title")) && js::truthy(summary.get("summary")))
        .collect();
    let mut visible_adventure = match nullish(state.get("adventure"), None) {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(other) => js::spread(other, json!({})),
        None => json!({}),
    };
    let history: Vec<Value> = list(at(Some(state), &["adventure", "history"])).iter().filter(|entry| !js::truthy(get(Some(entry), "visibility")) || party_visible_record(Some(entry))).cloned().collect();
    set(&mut visible_adventure, "history", Value::Array(history));
    let public_adventure = public_adventure_for(Some(&visible_adventure)).map_err(projection_error)?;
    let recent_decisions: Vec<Value> = last_n(list(public_adventure.get("history")), NARRATION_STORY_LIMITS.decisions)
        .iter()
        .map(|entry| {
            let mut decision = json!({
                "title": memory_text(get(Some(entry), "title"), 160),
                "location": memory_text(get(Some(entry), "location"), 180),
                "objective": memory_text(get(Some(entry), "objective"), 300),
                "outcome": memory_text(get(Some(entry), "outcome"), 300),
            });
            if js::truthy(get(Some(entry), "status")) {
                set(&mut decision, "status", str_value(memory_text(get(Some(entry), "status"), 40)));
            }
            decision
        })
        .filter(|entry| ["title", "location", "objective", "outcome"].iter().any(|key| js::truthy(entry.get(*key))))
        .collect();
    let viewer_id = js::s(get(Some(viewer), "playerId"));
    let heroes: Vec<Value> = list(state.get("players"))
        .iter()
        .take(NARRATION_STORY_LIMITS.heroes)
        .map(|actor| {
            let id = js::s(get(Some(actor), "id"));
            let is_viewer = id == viewer_id;
            let role = memory_text(or(get(Some(actor), "role"), get(Some(actor), "characterClass")), 120);
            let role = text::trim(&text::replace_first(re!(r"\s*[·—-]?\s*(?:ур(?:овень)?\.?|level)\s*\d+.*$", "iu"), &role, "")).to_string();
            let card = if is_viewer { hero_card_for_agent(state, Some(&str_value(id.clone()))) } else { None };
            let mut hero = json!({ "id": id, "name": memory_text(or(get(Some(actor), "character"), get(Some(actor), "name")), 120), "is_viewer": is_viewer });
            if is_viewer && !role.is_empty() {
                set(&mut hero, "class_name", str_value(role));
            }
            if is_viewer && js::truthy(get(Some(actor), "background")) {
                set(&mut hero, "background", str_value(memory_text(get(Some(actor), "background"), 160)));
            }
            for key in ["backstory", "bonds", "ideals"] {
                if js::truthy(get(card.as_ref(), key)) {
                    set(&mut hero, key, get(card.as_ref(), key).cloned().unwrap_or(Value::Null));
                }
            }
            hero
        })
        .filter(|hero| js::truthy(hero.get("id")) && js::truthy(hero.get("name")))
        .collect();

    let social = ensure_npc_social_state(state.get("social").unwrap_or(&Value::Null), state, &json!({}));
    let scene_location = text::lower(&memory_text(at(Some(state), &["scene", "location"]), 180));
    let mut viewer_options = match viewer {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({}),
    };
    set(&mut viewer_options, "playerId", str_value(""));
    set(&mut viewer_options, "isPartyMember", Value::Bool(true));
    set(&mut viewer_options, "isAdmin", Value::Bool(false));
    set(&mut viewer_options, "state", state.clone());
    let viewer_social = npc_social_for_viewer(&social, &viewer_options);
    let mut viewer_profiles: IndexMap<String, Value> = IndexMap::new();
    for npc in list(viewer_social.get("npcs")) {
        viewer_profiles.insert(js::string(npc.get("id")), npc.clone());
    }
    let present_profiles: Vec<Value> = list(social.get("npcs"))
        .iter()
        .filter_map(|npc| {
            let visible = viewer_profiles.get(&js::string(npc.get("id")))?;
            let mut current = npc.clone();
            for key in ["location", "available"] {
                match visible.get(key) {
                    Some(value) => set(&mut current, key, value.clone()),
                    None => unset(&mut current, key),
                }
            }
            Some(current)
        })
        .filter(|npc| !js::is_false(npc.get("available")) && party_visible_record(Some(npc)))
        .filter(|npc| js::truthy(npc.get("location")) && !scene_location.is_empty() && text::lower(&js::s(npc.get("location"))) == scene_location)
        .take(NARRATION_STORY_LIMITS.npcs)
        .collect();
    let relationships = nullish(social.get("relationships"), None);
    let viewer_key = js::string(get(Some(viewer), "playerId"));
    let present_npcs: Vec<Value> = present_profiles
        .iter()
        .map(|npc| {
            let relation = nullish(get(get(relationships, &js::string(npc.get("id"))), &viewer_key), None).cloned().unwrap_or(Value::from(0));
            let mut entry = json!({
                "id": js::string(npc.get("id")),
                "name": memory_text(npc.get("name"), 120),
                "role": memory_text(npc.get("role"), 120),
                "public_summary": memory_text(npc.get("public_summary"), 300),
                "voice": memory_text(npc.get("voice"), 200),
                "speech_profile": {
                    "pace": memory_text(at(Some(npc), &["speech_profile", "pace"]), 100),
                    "lexicon": memory_text(at(Some(npc), &["speech_profile", "lexicon"]), 180),
                    "mannerism": memory_text(at(Some(npc), &["speech_profile", "mannerism"]), 180),
                },
                "relationship": relationship_tier(&relation),
            });
            if !npc_known_by_name(state, npc) {
                set(&mut entry, "known_by_name", Value::Bool(false));
            }
            entry
        })
        .filter(|npc| js::truthy(npc.get("id")) && js::truthy(npc.get("name")))
        .collect();
    let present_ids: HashSet<String> = present_profiles.iter().map(|npc| js::string(npc.get("id"))).collect();
    let mut npc_names: IndexMap<String, Value> = IndexMap::new();
    for npc in &present_profiles {
        npc_names.insert(js::string(npc.get("id")), npc.get("name").cloned().unwrap_or(Value::Null));
    }
    let open_promises: Vec<Value> = last_n(&list(social.get("promises")).iter().filter(|promise| is_str(promise.get("status"), "open") && party_visible_record(Some(promise)) && present_ids.contains(&js::string(promise.get("npc_id")))).cloned().collect::<Vec<_>>(), NARRATION_STORY_LIMITS.promises)
        .iter()
        .map(|promise| {
            let name = npc_names.get(&js::string(promise.get("npc_id")));
            let mut entry = json!({
                "id": memory_text(promise.get("id"), 120),
                "npc": memory_text(or(name, promise.get("npc_id")), 120),
                "direction": memory_text(promise.get("direction"), 40),
                "text": memory_text(promise.get("text"), 280),
            });
            if js::truthy(promise.get("due_hint")) {
                set(&mut entry, "due_hint", str_value(memory_text(promise.get("due_hint"), 160)));
            }
            entry
        })
        .filter(|promise| js::truthy(promise.get("text")))
        .collect();
    let mut hero_names: IndexMap<String, Value> = IndexMap::new();
    for hero in &heroes {
        hero_names.insert(js::string(hero.get("id")), hero.get("name").cloned().unwrap_or(Value::Null));
    }
    let recent_interactions: Vec<Value> = last_n(&list(social.get("conversations")).iter().filter(|entry| is_str(entry.get("visibility"), "party") && present_ids.contains(&js::string(entry.get("npc_id")))).cloned().collect::<Vec<_>>(), NARRATION_STORY_LIMITS.interactions)
        .iter()
        .map(|entry| {
            json!({
                "npc": memory_text(or(npc_names.get(&js::string(entry.get("npc_id"))), entry.get("npc_id")), 120),
                "hero": memory_text(or(hero_names.get(&js::string(entry.get("hero_id"))), entry.get("hero_id")), 120),
                "player_message": memory_text(entry.get("player_message"), 240),
                "npc_reply": memory_text(entry.get("npc_reply"), 240),
                "stance": memory_text(entry.get("stance"), 40),
            })
        })
        .filter(|entry| js::truthy(entry.get("npc")) && js::truthy(entry.get("npc_reply")))
        .collect();
    let current_event = events.iter().rev().find(|event| is_str(get(Some(event), "event_type"), "NpcConversationRecorded") && js::truthy(at(Some(event), &["payload", "conversation", "npc_id"])));
    let current_conversation_id = memory_text(at(current_event, &["payload", "conversation", "id"]), 120);
    let current_npc_id = memory_text(at(current_event, &["payload", "conversation", "npc_id"]), 120);
    let current_profile = if !current_npc_id.is_empty() && present_ids.contains(&current_npc_id) { viewer_profiles.get(&current_npc_id) } else { None };
    let prior_dossier: Vec<Value> = list(get(current_profile, "dossier")).iter().filter(|entry| js::s(at(Some(entry), &["provenance", "source_conversation_id"])) != current_conversation_id).cloned().collect();
    let npc_dossiers: Vec<Value> = match current_profile {
        Some(profile) if !prior_dossier.is_empty() => {
            let tier = present_npcs.iter().find(|npc| is_str(npc.get("id"), &current_npc_id)).and_then(|npc| nullish(npc.get("relationship"), None).cloned()).unwrap_or_else(|| str_value("neutral"));
            let promises: Vec<Value> = list(viewer_social.get("promises")).iter().filter(|promise| is_str(promise.get("status"), "open") && js::string(promise.get("npc_id")) == current_npc_id).cloned().collect();
            vec![json!({
                "npc_id": current_npc_id,
                "name": memory_text(profile.get("name"), 120),
                "relationship": { "tier": tier, "provenance": { "source_event_ids": [] } },
                "interactions": prior_dossier,
                "promises": promises,
            })]
        }
        _ => Vec::new(),
    };
    let entities = list(get(memory, "entities"));
    let known_dead: Vec<Value> = last_n(&list(get(memory, "facts")).iter().filter(|fact| is_str(fact.get("status"), "active") && is_str(fact.get("predicate"), "died") && party_visible_record(Some(fact))).cloned().collect::<Vec<_>>(), 12)
        .iter()
        .map(|fact| {
            let name = memory_text(entities.iter().find(|entity| same(entity.get("id"), fact.get("subject_id"))).and_then(|entity| entity.get("name")), 120);
            obj(vec![("id", fact.get("subject_id").cloned()), ("name", Some(str_value(name)))])
        })
        .filter(|npc| js::truthy(npc.get("id")) && js::truthy(npc.get("name")))
        .collect();
    Ok(json!({
        "active_quests": active_quests,
        "known_dead_npcs": known_dead,
        "active_threads": active_threads,
        "recent_summaries": recent_summaries,
        "recent_decisions": recent_decisions,
        "heroes": heroes,
        "present_npcs": present_npcs,
        "open_promises": open_promises,
        "recent_interactions": recent_interactions,
        "npc_dossiers": npc_dossiers,
    }))
}

/// Сколько реакций NPC разрешено Рассказчику.
pub const NPC_REACTION_LIMIT: usize = 3;

fn npc_reaction_label(reaction: &str) -> Option<&'static str> {
    Some(match reaction {
        "alarmed" => "встревожен происходящим",
        "persuaded" => "принимает довод героя",
        "unconvinced" => "остаётся при своём",
        "welcoming" => "держится приветливо",
        "attentive" => "молча наблюдает за разговором",
        "watchful" => "держится настороже",
        "cold" => "держится холодно",
        "reacts_to_act" => "отзывается на поступок героя по своему нраву — взглядом, жестом или выражением лица; без слов, согласия и уступок",
        _ => return None,
    })
}

fn npc_reaction_by_tier(tier: Option<&Value>) -> Option<&'static str> {
    match tier.and_then(Value::as_str)? {
        "trusted" | "friendly" => Some("welcoming"),
        "neutral" => Some("attentive"),
        "unfriendly" => Some("watchful"),
        "hostile" => Some("cold"),
        _ => None,
    }
}

/// Цель уговора для реакций: `{ npcId, success }`.
#[derive(Debug, Clone)]
pub struct SocialTarget {
    pub npc_id: Value,
    pub success: Option<bool>,
}

fn reaction_entry(npc: &Value, reaction: &str) -> Value {
    obj(vec![
        ("npc_id", Some(str_value(js::string(npc.get("id"))))),
        ("name", Some(str_value(memory_text(npc.get("name"), 120)))),
        ("reaction", Some(str_value(reaction))),
        ("description", npc_reaction_label(reaction).map(str_value)),
    ])
}

/// `narrationNpcReactions(presentNpcs, events, { heroDeed, socialTarget })`:
/// реакции присутствующих NPC — allowlist, а не подсказка.
pub fn narration_npc_reactions(present_npcs: &[Value], events: &[Value], hero_deed: bool, social_target: Option<&SocialTarget>) -> Vec<Value> {
    let alarming = events.iter().any(|event| text::test(re!(r"damage|hitpointsreducedtozero|herodied|combatstarted", "i"), &js::s(get(Some(event), "event_type"))));
    if hero_deed && !alarming {
        return present_npcs
            .iter()
            .take(NPC_REACTION_LIMIT)
            .map(|npc| {
                let targeted = social_target.filter(|target| js::string(Some(&target.npc_id)) == js::string(npc.get("id")) && target.success.is_some());
                let reaction = match targeted.and_then(|target| target.success) {
                    Some(true) => "persuaded",
                    Some(false) => "unconvinced",
                    None => "reacts_to_act",
                };
                reaction_entry(npc, reaction)
            })
            .collect();
    }
    let mut outcomes: IndexMap<String, bool> = IndexMap::new();
    for event in events.iter().filter(|event| is_str(get(Some(event), "event_type"), "AbilityCheckResolved") && js::truthy(at(Some(event), &["payload", "social_check", "npc_id"]))) {
        outcomes.insert(js::string(at(Some(event), &["payload", "social_check", "npc_id"])), js::is_true(at(Some(event), &["payload", "success"])));
    }
    present_npcs
        .iter()
        .take(NPC_REACTION_LIMIT)
        .map(|npc| {
            let reaction = if alarming {
                "alarmed"
            } else {
                match outcomes.get(&js::string(npc.get("id"))) {
                    Some(true) => "persuaded",
                    Some(false) => "unconvinced",
                    None => npc_reaction_by_tier(npc.get("relationship")).unwrap_or("attentive"),
                }
            };
            reaction_entry(npc, reaction)
        })
        .collect()
}

/// `withDetailReactions(permits, details)`: реакция, названная подтверждённой
/// деталью исхода, дописывается к разрешённой реакции того же NPC.
pub fn with_detail_reactions(permits: Vec<Value>, details: &[String]) -> Vec<Value> {
    let texts: Vec<String> = details.iter().map(|detail| memory_str(detail, 300)).filter(|detail| !detail.is_empty()).collect();
    if texts.is_empty() {
        return permits;
    }
    let stem = |word: &str| text::head(&yo_lower(word), 4);
    permits
        .into_iter()
        .map(|permit| {
            let name = memory_text(get(Some(&permit), "name"), 120);
            let first = split_by(re!(r"\s+", "u"), &name).into_iter().next().unwrap_or_default();
            if text::len(&first) < 3 {
                return permit;
            }
            let named: Vec<String> = texts
                .iter()
                .filter(|detail| text::find_all(re!(r"\p{L}{3,}", "gu"), detail).iter().any(|word| stem(word) == stem(&first) && text::test(re!(r"^\p{Lu}", "u"), word)))
                .cloned()
                .collect();
            if named.is_empty() {
                return permit;
            }
            let mut parts: Vec<String> = Vec::new();
            if js::truthy(permit.get("description")) {
                parts.push(js::s(permit.get("description")));
            }
            parts.extend(named);
            with(&permit, json!({ "description": parts.join(" ") }))
        })
        .collect()
}

/// `narrationParticipants(state, events)`: участники видимых событий по именам.
fn narration_participants(state: &Value, events: &[Value]) -> Value {
    let mut ids: HashSet<String> = HashSet::new();
    for event in events {
        let mut values = vec![get(Some(event), "actor_id")];
        values.extend(list(get(Some(event), "target_ids")).iter().map(Some));
        for value in values {
            if js::truthy(value) {
                ids.insert(js::string(value));
            }
        }
    }
    let pick = |key: &str| -> Vec<Value> {
        list(state.get(key))
            .iter()
            .filter(|actor| ids.contains(&js::s(get(Some(actor), "id"))))
            .map(|actor| json!({ "id": js::string(actor.get("id")), "name": memory_text(or(actor.get("character"), actor.get("name")), 120) }))
            .filter(|actor| js::truthy(actor.get("name")))
            .collect()
    };
    json!({ "heroes": pick("players"), "enemies": pick("enemies") })
}

fn is_discovery_fact(event: &Value) -> bool {
    is_str(get(Some(event), "event_type"), "WorldFactRecorded") && is_str(at(Some(event), &["payload", "fact", "predicate"]), "discovery")
}

/// `discoveryDetailTexts(events)`.
fn discovery_detail_texts(events: &[Value]) -> Vec<String> {
    events.iter().filter(|event| is_discovery_fact(event)).map(|event| js::s(at(Some(event), &["payload", "fact", "summary"]))).collect()
}

/// `narrationSocialConsequences(events, state)`.
fn narration_social_consequences(events: &[Value], state: &Value) -> Vec<Value> {
    let mut promises: IndexMap<String, &Value> = IndexMap::new();
    for promise in list(at(Some(state), &["social", "promises"])) {
        promises.insert(js::string(promise.get("id")), promise);
    }
    let entries: Vec<Value> = events
        .iter()
        .filter(|event| is_str(event.get("event_type"), "NpcPromiseResolved"))
        .map(|event| {
            let promise_id = memory_text(at(Some(event), &["payload", "promise_id"]), 120);
            let promise = promises.get(&promise_id).copied();
            let delta = safe_number(at(Some(event), &["payload", "consequence_delta"])).unwrap_or(0.0);
            json!({
                "promise_id": promise_id,
                "status": memory_text(at(Some(event), &["payload", "status"]), 30),
                "npc_id": memory_text(get(promise, "npc_id"), 120),
                "direction": memory_text(get(promise, "direction"), 40),
                "text": memory_text(get(promise, "text"), 280),
                "consequence_delta": js::num(delta),
            })
        })
        .filter(|entry| js::truthy(entry.get("promise_id")) && js::truthy(entry.get("status")))
        .collect();
    last_n(&entries, 6)
}

// --- карточка результата -------------------------------------------------------------------

fn ability_check_label(ability: &str) -> Option<&'static str> {
    Some(match ability {
        "str" => "Проверка Силы",
        "dex" => "Проверка Ловкости",
        "con" => "Проверка Телосложения",
        "int" => "Проверка Интеллекта",
        "wis" => "Проверка Мудрости",
        "cha" => "Проверка Харизмы",
        _ => return None,
    })
}

fn saving_throw_label(ability: &str) -> Option<&'static str> {
    Some(match ability {
        "str" => "Спасбросок Силы",
        "dex" => "Спасбросок Ловкости",
        "con" => "Спасбросок Телосложения",
        "int" => "Спасбросок Интеллекта",
        "wis" => "Спасбросок Мудрости",
        "cha" => "Спасбросок Харизмы",
        _ => return None,
    })
}

/// `rollPurposeLabel(purpose)`: служебный ключ броска — название для игрока.
pub fn roll_purpose_label(purpose: Option<&Value>) -> String {
    let value = text::trim(&js::s(purpose)).to_string();
    if value.is_empty() {
        return "Проверка".into();
    }
    let mut pieces = value.split(':');
    let kind = pieces.next().unwrap_or_default();
    let ability = pieces.next().unwrap_or_default().to_lowercase();
    match kind {
        "ability_check" => ability_check_label(&ability).unwrap_or("Проверка характеристики").into(),
        "saving_throw" => saving_throw_label(&ability).unwrap_or("Спасбросок").into(),
        "attack_roll" | "attack" => "Бросок атаки".into(),
        "initiative" => "Инициатива".into(),
        "death_save" => "Спасбросок от смерти".into(),
        "free_roll" => "Свободный бросок".into(),
        _ if text::test(re!(r"^[a-z0-9_:.-]+$", "i"), &value) => "Проверка".into(),
        _ => value,
    }
}

/// `rollForClient(roll)`.
fn roll_for_client(roll: Option<&Value>) -> Value {
    if !js::truthy(roll) {
        return Value::Null;
    }
    let number_or_zero = |value: Option<&Value>| {
        let number = js::number(value);
        js::num(if number.is_nan() { 0.0 } else { number })
    };
    let value = coalesce(&[get(roll, "kept"), list(get(roll, "dice")).first()]).cloned().unwrap_or(Value::from(0));
    let visibility = match nullish(get(roll, "visibility"), None) {
        Some(found) => js::string(Some(found)),
        None => "public".into(),
    };
    obj(vec![
        ("roll_id", get(roll, "roll_id").cloned()),
        ("actor_id", Some(str_value(js::s(coalesce(&[get(roll, "actor_id"), get(roll, "actorId")]))))),
        ("value", Some(value)),
        ("modifier", Some(number_or_zero(get(roll, "modifier")))),
        ("total", Some(number_or_zero(get(roll, "total")))),
        ("label", Some(str_value(roll_purpose_label(get(roll, "purpose"))))),
        ("visibility", Some(str_value(visibility))),
        ("success", get(roll, "success").filter(|value| value.is_boolean()).cloned()),
    ])
}

/// `eventsToClientEffects(events, rolls)`.
pub fn events_to_client_effects(events: &[Value], rolls: &[Value]) -> Value {
    let mut reveal: Vec<Value> = Vec::new();
    let mut spawn: Vec<Value> = Vec::new();
    let mut objective = Value::Null;
    let mut grant_items: Vec<Value> = Vec::new();
    for event in events {
        let kind = get(Some(event), "event_type");
        if is_str(kind, "AreaRevealed") {
            reveal.extend(list(at(Some(event), &["payload", "cells"])).iter().cloned());
        }
        if is_str(kind, "ObjectiveUpdated") {
            objective = nullish(at(Some(event), &["payload", "objective"]), None).cloned().unwrap_or(Value::Null);
        }
        if is_str(kind, "EntitySpawned") {
            spawn.push(at(Some(event), &["payload", "entity"]).cloned().unwrap_or(Value::Null));
        }
        if is_str(kind, "ItemGranted") {
            let item = at(Some(event), &["payload", "item"]).cloned().unwrap_or(Value::Null);
            let owner = nullish(list(get(Some(event), "target_ids")).first(), get(Some(event), "actor_id"));
            let mut granted = js::spread(&item, json!({}));
            match owner {
                Some(owner) => set(&mut granted, "ownerId", owner.clone()),
                None => unset(&mut granted, "ownerId"),
            }
            grant_items.push(granted);
        }
    }
    json!({ "roll": roll_for_client(rolls.first()), "reveal": reveal, "spawn": spawn, "objective": objective, "grantItems": grant_items })
}

/// `visibleChanges(events)`.
fn visible_changes(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .map(|event| {
            obj(vec![
                ("event_type", get(Some(event), "event_type").cloned()),
                ("actor_id", get(Some(event), "actor_id").cloned()),
                ("target_ids", get(Some(event), "target_ids").cloned()),
                ("payload", get(Some(event), "payload").cloned()),
                ("source_rule_ids", get(Some(event), "source_rule_ids").cloned()),
                ("ruling_id", Some(nullish(get(Some(event), "ruling_id"), None).cloned().unwrap_or(Value::Null))),
                ("visibility", Some(nullish(get(Some(event), "visibility"), None).cloned().unwrap_or_else(|| str_value("public")))),
            ])
        })
        .collect()
}

// --- объяснение хода («/why») -----------------------------------------------------------------

fn describe_command_for_player(command: &Value, resolver: &NameResolver) -> Option<String> {
    let kind = js::s(get(Some(command), "command_type"));
    let difficulty = match safe_number(get(Some(command), "difficulty")) {
        Some(number) => format!(" против СЛ {}", js::f64_string(number)),
        None => String::new(),
    };
    let check = |kind: &str| obj(vec![("kind", Some(str_value(kind))), ("ability", get(Some(command), "ability").cloned()), ("skill", get(Some(command), "skill").cloned())]);
    Some(match kind.as_str() {
        "MakeAbilityCheck" => format!("{}{difficulty}", d20_check_label(&check("check"))),
        "MakeSavingThrow" => format!("{}{difficulty}", d20_check_label(&obj(vec![("kind", Some(str_value("save"))), ("ability", get(Some(command), "ability").cloned())]))),
        "MakeAttack" => format!("атака по цели «{}»", template(resolver.resolve(get(Some(command), "target_id")).as_ref())),
        "MakeAreaAttack" => "атака по области".into(),
        "CastSpell" => "применение заклинания".into(),
        "MoveActor" => "перемещение".into(),
        "UseCombatAction" => "боевое действие".into(),
        "OperateSceneObject" | "OperateDoor" => "взаимодействие с объектом сцены".into(),
        "RecordRuling" => "судейское решение ведущего".into(),
        "UpdateObjective" => "обновление цели отряда".into(),
        _ => return None,
    })
}

fn describe_roll_for_player(roll: &Value) -> String {
    let roll = Some(roll);
    let kept = match nullish(get(roll, "kept"), None) {
        Some(value) => Some(value.clone()),
        None => match get(roll, "dice") {
            Some(Value::Array(dice)) => dice.first().cloned(),
            _ => None,
        },
    };
    let modifier = js::number(get(roll, "modifier"));
    let modifier = if modifier.is_nan() { 0.0 } else { modifier };
    let modifier_text = if modifier != 0.0 { format!(" {} {} (модификатор)", if modifier > 0.0 { "+" } else { "−" }, js::f64_string(modifier.abs())) } else { String::new() };
    let base = match kept.filter(|value| !value.is_null()) {
        Some(kept) => format!("выпало {}{modifier_text}, итого {}", template(Some(&kept)), template(get(roll, "total"))),
        None => format!("{} = {}", nullish(get(roll, "expression"), None).map_or_else(|| "бросок".to_string(), |value| template(Some(value))), template(get(roll, "total"))),
    };
    let target = match nullish(get(roll, "difficulty"), None) {
        Some(difficulty) => format!(" против СЛ {}", template(Some(difficulty))),
        None => String::new(),
    };
    let outcome = match get(roll, "success") {
        Some(Value::Bool(success)) => format!(" — {}", if *success { "успех" } else { "провал" }),
        _ => String::new(),
    };
    format!("{}: {base}{target}{outcome}", roll_purpose_label(get(roll, "purpose")))
}

/// `whyNarration(explanation, resolveName)`.
fn why_narration(explanation: Option<&Value>, resolver: &NameResolver) -> String {
    if !js::truthy(explanation) {
        return "Для этой кампании ещё нет сохранённого механического решения.".into();
    }
    let mut sentences: Vec<String> = Vec::new();
    let recognized: Vec<String> = list(get(explanation, "commands")).iter().filter_map(|command| describe_command_for_player(command, resolver)).filter(|text| !text.is_empty()).collect();
    sentences.push(if recognized.is_empty() { "Действие не потребовало механических команд.".into() } else { format!("Игра прочла действие как: {}.", unique_strings(recognized).join("; ")) });
    let rolls = list(get(explanation, "rolls"));
    sentences.push(if rolls.is_empty() { "Бросков не потребовалось.".into() } else { format!("{}.", rolls.iter().take(3).map(describe_roll_for_player).collect::<Vec<_>>().join(". ")) });
    let resolve = |id: Option<&Value>| resolver.resolve(id);
    let outcomes: Vec<String> = list(get(explanation, "events")).iter().map(|event| event_summary(event, &resolve)).filter(|summary| !summary.is_empty()).collect();
    if !outcomes.is_empty() {
        sentences.push(format!("В итоге: {}.", outcomes.iter().take(4).cloned().collect::<Vec<_>>().join("; ")));
    }
    sentences.push(if js::truthy(get(explanation, "ruling")) {
        "Основание: разовое судейское решение ведущего — точного правила для этого случая движок не исполняет.".into()
    } else {
        "Основание: закреплённые правила игры, результат рассчитан сервером.".into()
    });
    sentences.join(" ")
}

fn model_identifiers(narration: Option<&Value>) -> Value {
    json!({ "narrator": nullish(get(narration, "provider"), None).cloned().unwrap_or(Value::Null) })
}

/// Сколько кампаний держать в тёплой памяти рассказов.
const NARRATION_MEMORY_CAMPAIGNS: usize = 64;

fn is_narration_memory_trace(trace: &Value) -> bool {
    let trace = Some(trace);
    let mode = at(trace, &["narration_result", "verification", "response_plan", "mode"]);
    let visibility = match nullish(at(trace, &["narration_result", "visibility"]), None) {
        Some(value) => js::string(Some(value)),
        None => "party".into(),
    };
    (visibility == "public" || visibility == "party")
        && !list(get(trace, "events")).iter().any(|event| is_str(event.get("event_type"), "NpcConversationRecorded") && is_str(event.get("visibility"), "specific_player"))
        && !["table_talk", "silence"].contains(&js::s(mode).as_str())
}

fn recent_campaign_narrations(trace_store: Option<&Arc<dyn TurnTraceStore>>, campaign_id: &str) -> OrchestratorResult<Vec<String>> {
    let Some(store) = trace_store else { return Ok(Vec::new()) };
    if campaign_id.is_empty() {
        return Ok(Vec::new());
    }
    let traces = store.recent(campaign_id, NARRATOR_RECENT_TEXT_LIMIT, Some(&is_narration_memory_trace))?;
    let texts: Vec<String> = traces
        .iter()
        .filter(|trace| js::truthy(Some(trace)) && is_narration_memory_trace(trace))
        .rev()
        .map(|trace| text::trim(&js::s(at(Some(trace), &["narration_result", "narration"]))).to_string())
        .filter(|text| !text.is_empty())
        .collect();
    Ok(last_n(&texts, NARRATOR_RECENT_TEXT_LIMIT))
}

/// `structuredCommandTurnId(campaignId, idempotencyKey)`.
pub fn structured_command_turn_id(campaign_id: &str, idempotency_key: &str) -> String {
    format!("turn-{}", text::head(&sha256(&format!("{campaign_id}\0{idempotency_key}")), 32))
}

// --- отпечатки запроса ------------------------------------------------------------------------

const COMMAND_FINGERPRINT_IGNORED_FIELDS: [&str; 9] = ["command_id", "campaign_id", "idempotency_key", "expected_state_version", "expectedStateVersion", "server_authoritative", "verified_roll", "request_fingerprint", "rest_id"];

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `canonicalJson(value)`: ключи по порядку, без пробелов.
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| utf16_cmp(left, right));
            format!("{{{}}}", keys.iter().map(|key| format!("{}:{}", js::stringify(&str_value(key.as_str())), canonical_json(&map[key.as_str()]))).collect::<Vec<_>>().join(","))
        }
        other => js::stringify(other),
    }
}

/// `structuredCommandsFingerprint(commands)`: отпечаток пакета команд клиента
/// без транспортных и серверных полей.
pub fn structured_commands_fingerprint(commands: Option<&Value>) -> String {
    let semantic: Vec<Value> = list(commands)
        .iter()
        .map(|command| match command {
            Value::Object(map) => Value::Object(map.iter().filter(|(key, _)| !COMMAND_FINGERPRINT_IGNORED_FIELDS.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect()),
            other => other.clone(),
        })
        .collect();
    sha256(&canonical_json(&Value::Array(semantic)))
}

const MESSAGE_REQUEST_OPERATION: &str = "message";

/// `requestOperationFor(input)`.
fn request_operation_for(input: &Value) -> String {
    match input.get("requestCommands") {
        Some(commands @ Value::Array(_)) => format!("commands:{}", structured_commands_fingerprint(Some(commands))),
        _ => MESSAGE_REQUEST_OPERATION.into(),
    }
}

/// Поля отпечатка запроса (`narrationRequestFingerprint`).
#[derive(Debug, Clone)]
pub struct RequestFingerprint {
    pub campaign_id: String,
    pub player_id: String,
    pub message: String,
    pub npc_id: String,
    pub request_kind: String,
    pub clarification_id: String,
    pub supersedes_check_id: String,
    pub supersedes_proposal_id: String,
    pub question_check_id: String,
    pub question_proposal_id: String,
    pub operation: String,
}

impl Default for RequestFingerprint {
    fn default() -> Self {
        Self {
            campaign_id: String::new(),
            player_id: String::new(),
            message: String::new(),
            npc_id: String::new(),
            request_kind: "action".into(),
            clarification_id: String::new(),
            supersedes_check_id: String::new(),
            supersedes_proposal_id: String::new(),
            question_check_id: String::new(),
            question_proposal_id: String::new(),
            operation: String::new(),
        }
    }
}

/// `narrationRequestFingerprint(fields)`: пустая операция даёт прежний
/// отпечаток (записи до аудита PR #131).
pub fn narration_request_fingerprint(fields: &RequestFingerprint) -> String {
    let mut source = format!(
        "{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        text::upper(&fields.campaign_id),
        fields.player_id,
        text::squash_spaces(&text::nfkc(&fields.message)),
        fields.npc_id,
        fields.request_kind,
        fields.clarification_id,
        fields.supersedes_check_id,
        fields.supersedes_proposal_id,
        fields.question_check_id,
        fields.question_proposal_id,
    );
    if !fields.operation.is_empty() {
        source.push_str(&format!("\0operation:{}", fields.operation));
    }
    sha256(&source)
}

fn legacy_narration_request_fingerprint(fields: &RequestFingerprint) -> String {
    sha256(&format!("{}\0{}\0{}\0{}", text::upper(&fields.campaign_id), fields.player_id, text::squash_spaces(&text::nfkc(&fields.message)), fields.npc_id))
}

/// `assertNarrationRequestIdempotency(duplicate, trace, request)`.
fn assert_narration_request_idempotency(duplicate: Option<&Value>, trace: Option<&Value>, request: &RequestFingerprint, idempotency_key: &str) -> OrchestratorResult<()> {
    let Some(duplicate) = duplicate.filter(|value| js::truthy(Some(value))) else { return Ok(()) };
    let fields = RequestFingerprint { operation: String::new(), ..request.clone() };
    let request_fingerprint = narration_request_fingerprint(&fields);
    if js::truthy(get(trace, "request_fingerprint")) {
        let stored = js::string(get(trace, "request_fingerprint"));
        let exact = stored == narration_request_fingerprint(request);
        let compatible_without_operation = !request.operation.is_empty() && stored == request_fingerprint;
        let compatible_legacy = request.request_kind == "action" && request.clarification_id.is_empty() && request.supersedes_check_id.is_empty() && request.supersedes_proposal_id.is_empty() && stored == legacy_narration_request_fingerprint(request);
        if !exact && !compatible_without_operation && !compatible_legacy {
            return Err(idempotency_conflict(&request.campaign_id, idempotency_key));
        }
        return Ok(());
    }
    if request.npc_id.is_empty() {
        return Ok(());
    }
    let conversation = list(duplicate.get("events")).iter().find(|event| is_str(get(Some(event), "event_type"), "NpcConversationRecorded")).and_then(|event| at(Some(event), &["payload", "conversation"]));
    let replay = match conversation {
        Some(conversation) if js::truthy(Some(conversation)) => narration_request_fingerprint(&RequestFingerprint {
            player_id: param_str(conversation.get("hero_id")),
            message: param_str(conversation.get("player_message")),
            npc_id: param_str(conversation.get("npc_id")),
            operation: String::new(),
            ..request.clone()
        }),
        _ => String::new(),
    };
    if replay.is_empty() || replay != request_fingerprint {
        return Err(idempotency_conflict(&request.campaign_id, idempotency_key));
    }
    Ok(())
}

// --- повтор и запасной рассказ ---------------------------------------------------------------

fn known_rules(known_rule_ids: &[Value]) -> Value {
    json!({ "knownRuleIds": known_rule_ids })
}

fn verify_text(narration: &str, brief: &Value, known_rule_ids: &[Value]) -> OrchestratorResult<Value> {
    verify_narration(Some(&str_value(narration)), Some(brief), Some(&known_rules(known_rule_ids))).map_err(security_error)
}

const ORIGIN_REASONS: [&str; 7] = ["generated", "no_provider", "provider_error", "verification_rejected", "empty_response", "cached_response", "replay_fallback"];

/// `cachedNarration(trace, brief, knownRuleIds)`: прежний текст хода, заново
/// прошедший проверки.
fn cached_narration(trace: Option<&Value>, brief: &Value, known_rule_ids: &[Value]) -> OrchestratorResult<Option<Value>> {
    let cached = get(trace, "narration_result");
    let narration = match get(cached, "narration") {
        Some(Value::String(text)) => text::trim(text).to_string(),
        _ => String::new(),
    };
    if narration.is_empty() {
        return Ok(None);
    }
    let verification = verify_narrator_craft(&narration, brief, &verify_text(&narration, brief, known_rule_ids)?, &[]);
    if !js::truthy(verification.get("valid")) {
        return Ok(None);
    }
    let origin = at(cached, &["verification", "origin"]);
    let source = if is_str(get(origin, "source"), "llm") { "llm" } else { "template" };
    let reason = js::string(get(origin, "reason"));
    let elapsed = js::number(get(origin, "elapsed_ms"));
    let mut response_plan = narrator_response_plan(brief);
    set(&mut response_plan, "delivery", str_value("cached"));
    let mut origin_out = json!({ "source": source, "reason": "cached_response" });
    if ORIGIN_REASONS.contains(&reason.as_str()) {
        set(&mut origin_out, "upstream", str_value(reason));
    }
    set(&mut origin_out, "elapsed_ms", js::num(if elapsed.is_finite() { elapsed } else { 0.0 }));
    let verification = with(&verification, json!({ "response_plan": response_plan, "origin": origin_out }));
    let prompt_version = match cached.and_then(Value::as_object).and_then(|map| map.get("prompt_version")) {
        Some(value) => value.clone(),
        None => str_value(NARRATOR_PROMPT_VERSION),
    };
    let provider = if js::truthy(get(cached, "provider")) { js::string(get(cached, "provider")) } else { "cached-idempotent-replay".into() };
    Ok(Some(json!({ "narration": narration, "verification": verification, "prompt_version": prompt_version, "provider": provider })))
}

fn fallback_narration(brief: &Value, resolver: &NameResolver) -> OrchestratorResult<Value> {
    let resolve = |id: Option<&Value>| resolver.resolve(id);
    deterministic_narration(brief, Some(&resolve), &[]).map_err(security_error)
}

/// `deterministicReplayNarration(brief, knownRuleIds, resolveName)`.
fn deterministic_replay_narration(brief: &Value, known_rule_ids: &[Value], resolver: &NameResolver) -> OrchestratorResult<Value> {
    let fallback = fallback_narration(brief, resolver)?;
    let text_value = js::s(fallback.get("narration"));
    let verification = verify_narrator_craft(&text_value, brief, &verify_text(&text_value, brief, known_rule_ids)?, &[]);
    let verification = with(&verification, json!({ "response_plan": narrator_response_plan(brief), "origin": { "source": "template", "reason": "replay_fallback", "elapsed_ms": 0 } }));
    Ok(with(&fallback, json!({ "verification": verification, "prompt_version": NARRATOR_PROMPT_VERSION, "provider": "deterministic-idempotent-replay" })))
}

/// `deterministicMechanicsNarration(brief, knownRuleIds, resolveName)`.
fn deterministic_mechanics_narration(brief: &Value, known_rule_ids: &[Value], resolver: &NameResolver) -> OrchestratorResult<Value> {
    let fallback = fallback_narration(brief, resolver)?;
    let verification = verify_text(&js::s(fallback.get("narration")), brief, known_rule_ids)?;
    Ok(with(&fallback, json!({ "verification": verification, "prompt_version": "mechanics-log/v1", "provider": "deterministic-mechanics" })))
}

/// `deterministicNarratorResponse(narrator, events, state, brief, knownRuleIds)`.
fn deterministic_narrator_response(narrator: &dyn DeterministicNarrator, events: &[Value], state: &Value, brief: &Value, known_rule_ids: &[Value]) -> OrchestratorResult<Value> {
    let fallback = fallback_narration(brief, &actor_name_resolver(state))?;
    let rendered = render_deterministic_narration(narrator, events, state, &js::s(fallback.get("narration")));
    let verification = verify_text(&rendered.narration, brief, known_rule_ids)?;
    Ok(json!({ "narration": rendered.narration, "prompt_version": rendered.prompt_version, "provider": rendered.provider, "verification": verification }))
}

// --- уточнения -------------------------------------------------------------------------------

/// `availableNpcNames(state, actorId)`: кто в сцене может ответить.
fn available_npc_names(state: &Value, actor_id: Option<&Value>) -> Vec<String> {
    let scene_location = place_key(at(Some(state), &["scene", "location"]));
    let viewer = obj(vec![("state", Some(state.clone())), ("playerId", actor_id.cloned()), ("isPartyMember", Some(Value::Bool(true)))]);
    let social = npc_social_for_viewer(state.get("social").unwrap_or(&Value::Null), &viewer);
    list(social.get("npcs"))
        .iter()
        .filter(|npc| !js::is_false(get(Some(npc), "available")))
        .filter(|npc| {
            let npc_location = place_key(get(Some(npc), "location"));
            scene_location.is_empty() || npc_location.is_empty() || scene_location == npc_location
        })
        .map(|npc| text::trim(&js::s(get(Some(npc), "name"))).to_string())
        .filter(|name| !name.is_empty())
        .take(6)
        .collect()
}

/// `humanMissingInformation(values, state, intent)`.
fn human_missing_information(values: Option<&Value>, state: &Value, intent: &Value) -> String {
    let missing = unique_strings(list(values).iter().map(|value| js::string(Some(value))).filter(|value| !value.is_empty()).collect());
    let has = |key: &str| missing.iter().any(|value| value == key);
    if has("ambiguous_npc") {
        let candidates: Vec<String> = list(intent.get("target_candidates"))
            .iter()
            .map(|candidate| {
                let name = text::trim(&js::s(get(Some(candidate), "name"))).to_string();
                let role = text::trim(&js::s(get(Some(candidate), "role"))).to_string();
                if role.is_empty() {
                    name
                } else {
                    format!("{name} ({role})")
                }
            })
            .filter(|candidate| !candidate.is_empty())
            .take(6)
            .collect();
        return if candidates.is_empty() { "Кому именно? Здесь таких несколько.".into() } else { format!("Кому именно — {}?", candidates.join(", ")) };
    }
    if has("npc_id") || has("available_npc") {
        let names = available_npc_names(state, intent.get("actor_id"));
        let absent = intent.get("absent_npc");
        if js::truthy(get(absent, "name")) {
            let name = template(get(absent, "name"));
            let why = if is_str(get(absent, "reason"), "combat") {
                format!("{name} сейчас не ответит: идёт схватка.")
            } else if is_str(get(absent, "reason"), "elsewhere") && js::truthy(get(absent, "location")) {
                format!("{name} — не здесь, а в другом месте: {}.", template(get(absent, "location")))
            } else {
                format!("{name} сейчас не ответит.")
            };
            if is_str(get(absent, "reason"), "combat") {
                return why;
            }
            let others: Vec<String> = names.into_iter().filter(|other| Some(other.as_str()) != get(absent, "name").and_then(Value::as_str)).collect();
            return if others.is_empty() { format!("{why} Рядом никого, кто бы ответил.") } else { format!("{why} Здесь можно поговорить: {}.", others.join(", ")) };
        }
        return if names.is_empty() { "Рядом никого, кто бы ответил: люди — там, где жильё и дорога.".into() } else { format!("Кому это — {}?", names.join(", ")) };
    }
    if missing.is_empty() {
        return "Опишите действие подробнее, чтобы его можно было разрешить по правилам.".into();
    }
    let labels: Vec<&str> = missing
        .iter()
        .map(|value| match value.as_str() {
            "message" => "само действие",
            "target_id" => "цель действия",
            "npc_id" => "имя собеседника",
            "available_npc" => "доступного собеседника",
            "ambiguous_npc" => "конкретного собеседника",
            _ => "деталь действия",
        })
        .collect();
    format!("Уточните {}.", labels.join(" и "))
}

fn no_world_change_constraint(plan: &Value) -> bool {
    js::is_false(at(Some(plan), &["ruling_draft", "world_change"])) || list(plan.get("narration_constraints")).iter().any(|constraint| is_str(Some(constraint), "no-unconfirmed-world-changes"))
}

/// `proposalIdFor(campaignId, seed)`: сквозной ключ объяснения хода.
fn proposal_id_for(campaign_id: &str, seed: &str) -> String {
    format!("proposal:{}", text::head(&sha256(&format!("{campaign_id} {seed}")), 20))
}

/// `mergeClarificationAction(original, answer)`.
fn merge_clarification_action(original: &Value, answer: &str) -> String {
    let first = text::trim(&js::s(original.get("action"))).to_string();
    let second = text::trim(answer).to_string();
    let steps = list(at(Some(original), &["original_intent", "action_steps"]));
    if is_str(at(Some(original), &["original_intent", "pending_step"]), "proposal") && text::test(re!(r"^(?:да|согласен|согласна|выполнить)[.!\s]*$", "iu"), &second) {
        return first;
    }
    if !steps.is_empty() && (text::test(re!(r"^(?:да|продолжить|продолжай|выполнить|выполняю|первый шаг|согласен|согласна)[.!\s]*$", "iu"), &second) || is_str(steps.first(), &second)) {
        return js::s(steps.first());
    }
    if text::test(re!(r"^(?:нет\s*[,.:]|я\s+имел[аи]?\s+в\s+виду|вместо\s+этого)", "iu"), &second) {
        return text::trim(&text::replace_first(re!(r"^(?:нет\s*[,.:]?\s*)?(?:я\s+имел[аи]?\s+в\s+виду\s*[:,-]?\s*|вместо\s+этого\s*[,.:]?\s*)?", "iu"), &second, "")).to_string();
    }
    if text::test(re!(r"^(?:я\s+)?(?:убираю|снимаю|открываю|закрываю|подпираю|подхожу|иду|говорю|спрашиваю|передаю|беру|атакую|сматываю|развязываю|подбрасываю|осматриваю|зажигаю|прячусь|меняю)\s", "iu"), &second) {
        return second;
    }
    if first.is_empty() {
        return second;
    }
    if second.is_empty() {
        return first;
    }
    text::head(&format!("{first}. Уточнение игрока: {second}"), 2_000)
}

fn scene_people_filter(state: &Value) -> impl Fn(&&Value) -> bool + '_ {
    let location = place_key(at(Some(state), &["scene", "location"]));
    move |npc: &&Value| !js::is_false(get(Some(npc), "available")) && (location.is_empty() || !js::truthy(get(Some(npc), "location")) || place_key(get(Some(npc), "location")) == location)
}

/// `speechToPartyOrAir(message, state, playerId, explicitNpcId)`: реплика
/// спутнику или в пустоту — отыгрыш, а не разговор с NPC.
fn speech_to_party_or_air(message: &str, state: &Value, player_id: &str, explicit_npc_id: &str) -> bool {
    if !explicit_npc_id.is_empty() {
        return false;
    }
    let stem = |value: &str| text::head(&yo_lower(value), 4);
    let words: HashSet<String> = text::find_all(re!(r"\p{L}{3,}", "gu"), &yo_lower(message)).iter().map(|word| stem(word)).collect();
    let names_word = |name: Option<&Value>| text::find_all(re!(r"\p{L}{3,}", "gu"), &js::s(name)).iter().any(|word| words.contains(&stem(word)));
    let names_hero = list(state.get("players")).iter().filter(|player| js::string(get(Some(player), "id")) != player_id).any(|hero| names_word(get(Some(hero), "character")) || names_word(get(Some(hero), "name")));
    let present: Vec<&Value> = list(at(Some(state), &["social", "npcs"])).iter().filter(scene_people_filter(state)).collect();
    let quoted = match_all(re!(r#"[«"“]([^«»"“”]{1,800})[»"”]"#, "gu"), message).iter().map(|found| group(found, 1)).collect::<Vec<_>>().join(" ");
    let names_npc = present.iter().any(|npc| names_word(get(Some(npc), "name")));
    let request = text::test(re!(r"(?<![\p{L}\p{M}])(?:расскаж\p{L}*|скажи\p{L}*|скажите|подскаж\p{L}*|объясн\p{L}*|покаж\p{L}*|дай|дайте|ответь\p{L}*|помоги\p{L}*|прошу)(?![\p{L}\p{M}])", "iu"), &quoted);
    let statement = !quoted.is_empty() && !quoted.contains('?') && !request && !names_npc;
    names_hero || present.is_empty() || statement
}

fn spellcasting_pattern() -> &'static fancy_regex::Regex {
    re!(r"(?<![\p{L}\p{M}])(?:заклинани\p{L}*|сотвор\p{L}*|колду\p{L}*|чару\p{L}*|читаю\s+«|творю\s+«)", "iu")
}

fn address_cue_pattern() -> &'static fancy_regex::Regex {
    re!(
        r"(?:^|[\s,])(?:к|ко|у|перед|для|обраща\p{L}*|говор\p{L}*|скаж\p{L}*|спрашива\p{L}*|спрос\p{L}*|шепч\p{L}*|шепта\p{L}*|оклика\p{L}*|окликн\p{L}*|зов[её]т|кива\p{L}*|протягива\p{L}*|показыва\p{L}*|подход\p{L}*|наклоня\p{L}*|поворачива\p{L}*|клад[её]т|обеща\p{L}*)\s+(?:\p{L}+\s+){0,2}$",
        "iu"
    )
}

/// Адресат прямой речи: NPC в сцене или другой герой.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Addressee {
    /// `npc` или `hero`.
    pub kind: &'static str,
    pub id: String,
}

impl Addressee {
    pub fn to_json(&self) -> Value {
        json!({ "kind": self.kind, "id": self.id })
    }
}

struct Person {
    kind: &'static str,
    id: String,
    name: String,
}

/// `speechAddressee(message, state, playerId, { allowSpell })`: кому
/// обращена прямая речь заявки.
pub fn speech_addressee(message: &str, state: &Value, player_id: &str, allow_spell: bool) -> Option<Addressee> {
    if !allow_spell && text::test(spellcasting_pattern(), message) {
        return None;
    }
    let quotes = match_all(re!(r#"[«"“]([^«»"“”]{1,800})[»"”]"#, "gu"), message);
    let quote = quotes.iter().find(|found| text::test(re!(r"[.!?…,:;—]", "u"), &group(found, 1))).or_else(|| quotes.last())?;
    let mut people: Vec<Person> = list(at(Some(state), &["social", "npcs"])).iter().filter(scene_people_filter(state)).map(|npc| Person { kind: "npc", id: js::string(get(Some(npc), "id")), name: js::s(get(Some(npc), "name")) }).collect();
    people.extend(
        list(state.get("players"))
            .iter()
            .filter(|hero| js::string(get(Some(hero), "id")) != player_id)
            .map(|hero| Person { kind: "hero", id: js::string(get(Some(hero), "id")), name: js::s(or(or(get(Some(hero), "character"), get(Some(hero), "name")), Some(&str_value("")))) }),
    );
    let normal = |word: &str| yo_lower(word);
    let person_for = |word: &str| -> Option<&Person> {
        let spoken = normal(word);
        people
            .iter()
            .find(|person| split_by(re!(r"[\s-]+", "u"), &normal(&person.name)).iter().any(|part| text::len(part) >= 3 && same_name_token(part, &spoken)))
            .or_else(|| {
                people.iter().find(|person| {
                    let first = normal(&split_by(re!(r"\s+", "u"), &person.name).into_iter().next().unwrap_or_default());
                    let length = text::len(&first);
                    if length < 3 {
                        return false;
                    }
                    let stem = text::head(&first, 3.max(length - 1));
                    spoken.starts_with(&stem) && text::len(&spoken) <= length + 3
                })
            })
    };
    let quoted = group(quote, 1);
    let vocative = re!(r"^\s*(?:(?:[Гг]оспож\p{L}*|[Гг]осподин\p{L}*|[Мм]астер\p{L}*|[Сс]удар\p{L}*|[Хх]озяй\p{L}*|[Пп]очтенн\p{L}*|[Уу]важаем\p{L}*|[Дд]обр\p{L}*)\s+)?([А-ЯЁ][\p{L}-]+)(?:\s+([А-ЯЁ][\p{L}-]+))?\s*[,!]", "u");
    if let Some(found) = match_all(vocative, &quoted).into_iter().next() {
        let called = person_for(&group(&found, 1)).or_else(|| found.groups.get(1).cloned().flatten().and_then(|second| person_for(&second)));
        if let Some(called) = called {
            return Some(Addressee { kind: called.kind, id: called.id.clone() });
        }
    }
    let before = text::head(message, quote.index);
    let lead_of = |index: usize| text::slice(&before, index.saturating_sub(60) as i64, Some(index as i64));
    let mentions = match_all(re!(r"(?<![\p{L}\p{M}])[А-ЯЁ][\p{L}-]+", "gu"), &before);
    let cued: Vec<&Person> = mentions.iter().filter(|found| text::test(address_cue_pattern(), &lead_of(found.index))).filter_map(|found| person_for(&found.text)).collect();
    let named: Vec<&Person> = mentions
        .iter()
        .filter_map(|found| {
            let spoken = normal(&found.text);
            let person = person_for(&found.text)?;
            let nominative = split_by(re!(r"[\s-]+", "u"), &normal(&person.name)).iter().any(|part| *part == spoken);
            let toward = !nominative && text::test(re!(r"(?:у|ю|е|и|ой|ей|ом|ем|ою|ею)$", "u"), &spoken);
            (toward || text::test(address_cue_pattern(), &lead_of(found.index))).then_some(person)
        })
        .collect();
    let last = cued.last().or_else(|| named.last())?;
    Some(Addressee { kind: last.kind, id: last.id.clone() })
}

/// Заклинание и вопрос человеку рядом одной заявкой.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpellSpeech {
    pub npc_id: String,
    pub speech: String,
}

/// `spellSpeechFollowUp(message, state, playerId)`.
pub fn spell_speech_follow_up(message: &str, state: &Value, player_id: &str) -> Option<SpellSpeech> {
    if !text::test(spellcasting_pattern(), message) {
        return None;
    }
    let speech = match_all(re!(r"«([^«»]{1,800})»", "gu"), message).iter().map(|found| text::trim(&group(found, 1)).to_string()).find(|quote| text::test(re!(r"[.!?…,:;—]", "u"), quote))?;
    let addressee = speech_addressee(message, state, player_id, true)?;
    if addressee.kind != "npc" {
        return None;
    }
    Some(SpellSpeech { npc_id: addressee.id, speech: format!("«{speech}»") })
}

/// `actsBeyondSpeech(message)`: вне кавычек герой что-то делает.
fn acts_beyond_speech(message: &str) -> bool {
    has_recognized_free_action_approach(&text::replace_all(re!(r#"[«"“][^«»"“”]*[»"”]"#, "gu"), message, " "))
}

fn speech_handover_pattern() -> &'static fancy_regex::Regex {
    re!(r"(?<![\p{L}\p{M}])(?:переда|отда|вруча|протягива)\p{L}*", "iu")
}

/// Сколько шагов одной заявки ведущий исполняет подряд без вопроса.
pub const PLAN_STEP_LIMIT: f64 = 4.0;

/// `mergePlanStepResults(first, next)`: два шага одной заявки — один ответ.
fn merge_plan_step_results(first: &Value, next: &Value) -> Value {
    let mut parts: Vec<(String, String)> = Vec::new();
    for result in [first, next] {
        let text_value = text::trim(&js::s(get(Some(result), "narration"))).to_string();
        let author = text::trim(&js::s(get(Some(result), "journal_author"))).to_string();
        if !text_value.is_empty() && !parts.iter().any(|(other, _)| *other == text_value) {
            parts.push((text_value, author));
        }
    }
    let authors: HashSet<&String> = parts.iter().map(|(_, author)| author).collect();
    let mixed = authors.len() > 1;
    let narration = parts
        .iter()
        .map(|(text_value, author)| if mixed && !author.is_empty() { format!("{author}: «{}»", text::replace_all(re!(r"^«|»$", "gu"), text_value, "")) } else { text_value.clone() })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut merged = js::spread(next, json!({}));
    if mixed {
        unset(&mut merged, "journal_author");
    }
    let joined = |key: &str| -> Value { Value::Array(list(get(Some(first), key)).iter().chain(list(get(Some(next), key))).cloned().collect()) };
    set(&mut merged, "narration", str_value(narration));
    set(&mut merged, "mechanics", joined("mechanics"));
    set(&mut merged, "visible_state_changes", joined("visible_state_changes"));
    set(&mut merged, "turn_consumed", Value::Bool(js::truthy(get(Some(first), "turn_consumed")) || js::truthy(get(Some(next), "turn_consumed"))));
    let turn_ids = |result: &Value| -> Vec<Value> {
        match nullish(get(Some(result), "plan_turn_ids"), None) {
            Some(Value::Array(items)) => items.clone(),
            Some(other) => vec![other.clone()],
            None => vec![get(Some(result), "turn_id").cloned().unwrap_or(Value::Null)],
        }
    };
    let ids: Vec<Value> = turn_ids(first).into_iter().chain(turn_ids(next)).filter(|id| js::truthy(Some(id))).collect();
    set(&mut merged, "plan_turn_ids", Value::Array(ids));
    merged
}

const INDEPENDENT_ACTION_INTENTS: [&str; 19] = [
    "attack", "saving_throw", "ability_check", "healing", "damage", "cast_spell", "start_combat", "end_combat", "end_turn", "rest", "wait", "scenario_knight", "scenario_treaty", "scenario_purse", "scenario_armory", "scenario_informant", "social", "explore", "approach_attack",
];

fn independent_action_intent(kind: &str) -> bool {
    INDEPENDENT_ACTION_INTENTS.contains(&kind) || kind == "compound_maneuver"
}

/// `hasActionVerbShape(value)`: в полном новом тексте обычно есть сказуемое.
fn has_action_verb_shape(value: &str) -> bool {
    let words = text::find_all(re!(r"[а-яё]{3,}", "gu"), &text::lower(value));
    if words.len() < 2 {
        return false;
    }
    words.iter().take(3).any(|word| text::test(re!(r"(?:ю|у|ем|им|ешь|ишь|ете|ите|ают|яют|ут|ют|ай|яй|йте|ть|ться)$", "u"), word))
}

/// `standaloneActionReading(message, intent)`: ответ на уточнение — новая заявка?
fn standalone_action_reading(message: &str, intent: &Value) -> bool {
    if js::truthy(intent.get("free_action_kind")) {
        return true;
    }
    if independent_action_intent(&js::s(intent.get("intent"))) {
        return true;
    }
    if js::truthy(intent.get("approach")) && !is_str(intent.get("approach"), "unspecified") {
        return true;
    }
    has_recognized_free_action_approach(message) || has_action_verb_shape(message)
}

/// `maneuverProposalFingerprint(proposal)`: план манёвра без его id.
fn maneuver_proposal_fingerprint(proposal: Option<&Value>) -> String {
    let mut body = match nullish(proposal, None) {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(other) => js::spread(other, json!({})),
        None => json!({}),
    };
    unset(&mut body, "id");
    sha256(&js::stringify(&body))
}

/// `trimSentenceEnd(value, maximum)`.
fn trim_sentence_end(value: Option<&Value>, maximum: usize) -> String {
    let squashed = text::squash_spaces(&text::nfkc(&js::s(value)));
    text::head(&text::replace_first(re!(r"[.!?…]+$", "u"), &squashed, ""), maximum)
}

// --- запасной текст свободного действия ------------------------------------------------------

fn free_action_time_text(events: &[Value]) -> String {
    let Some(time) = events.iter().rev().find(|event| is_str(get(Some(event), "event_type"), "TimeAdvanced")) else { return String::new() };
    let amount = js::number(at(Some(time), &["payload", "amount"]));
    if !amount.is_finite() || amount <= 0.0 {
        return String::new();
    }
    let unit = match nullish(at(Some(time), &["payload", "unit"]), None) {
        Some(unit) => js::string(Some(unit)).to_lowercase(),
        None => "minute".into(),
    };
    let shown = js::f64_string(amount);
    if unit == "hour" || unit == "hours" {
        return format!("Прошло {shown} ч.");
    }
    if unit == "day" || unit == "days" {
        return format!("Прошёл {shown} день.");
    }
    if amount >= 10.0 {
        format!("На это ушло {}.", minutes_label_ru(Some(&js::num(amount))))
    } else {
        String::new()
    }
}

fn combat_text(events: &[Value], state: &Value) -> OrchestratorResult<String> {
    combat_narration(events, state, None).map_err(|error| type_error(error.to_string()))
}

/// `freeActionEffectText(events, state)`: слова ведущего о подтверждённых последствиях.
fn free_action_effect_text(events: &[Value], state: &Value) -> OrchestratorResult<Vec<String>> {
    let mut texts: Vec<String> = Vec::new();
    for event in events {
        let kind = get(Some(event), "event_type");
        let entry = if is_str(kind, "DamageApplied") {
            format!("{}: {}", damage_type_label(at(Some(event), &["payload", "damage_type"])), combat_text(std::slice::from_ref(event), state)?)
        } else if is_str(kind, "HitPointsReducedToZero") || is_str(kind, "HeroDied") {
            combat_text(std::slice::from_ref(event), state)?
        } else if is_discovery_fact(event) && ["party", "public"].contains(&js::string(at(Some(event), &["payload", "fact", "visibility"])).as_str()) {
            let summary = text::head(&text::squash_spaces(&js::s(at(Some(event), &["payload", "fact", "summary"]))), 600);
            if summary.is_empty() {
                String::new()
            } else if text::test(re!(r"[.!?…]$", "u"), &summary) {
                summary
            } else {
                format!("{summary}.")
            }
        } else {
            String::new()
        };
        if !entry.is_empty() {
            texts.push(entry);
        }
    }
    Ok(unique_strings(texts))
}

fn safe_narration_violations(value: Option<&Value>) -> Vec<Value> {
    let entries: Vec<Value> = list(value)
        .iter()
        .filter_map(|entry| {
            if !matches!(entry, Value::Object(_) | Value::Array(_)) {
                return None;
            }
            let code = text::head(text::trim(&js::s(get(Some(entry), "code"))), 120);
            if code.is_empty() {
                return None;
            }
            let found = text::head(text::trim(&js::s(get(Some(entry), "match"))), 240);
            Some(if found.is_empty() { json!({ "code": code }) } else { json!({ "code": code, "match": found }) })
        })
        .take(32)
        .collect();
    match redact_trace(Some(&Value::Array(entries)), None) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn safe_narration_provider_error(value: Option<&Value>) -> String {
    let code = text::head(text::trim(&js::s(value)), 80);
    if text::test(re!(r"^[A-Z][A-Z0-9_.:-]*$", "u"), &code) {
        code
    } else {
        String::new()
    }
}

fn kind_of(free_action: &Value) -> String {
    js::s(free_action.get("kind"))
}

fn succeeded_kind(kind: &str) -> bool {
    kind == "auto_success" || kind == "check_success"
}

fn played_kind(kind: &str) -> bool {
    succeeded_kind(kind) || kind == "check_failure"
}

fn goal_or_message<'a>(free_action: &'a Value, message: &'a Value) -> Option<&'a Value> {
    or(at(Some(free_action), &["reading", "goal_summary"]), Some(message))
}

/// `unconfirmedFreeActionPassage(...)`: удачная заявка-перемещение без события перемещения.
fn unconfirmed_free_action_passage(free_action: &Value, message: &str, events: &[Value], state: &Value) -> bool {
    if !succeeded_kind(&kind_of(free_action)) {
        return false;
    }
    if js::truthy(at(Some(state), &["mechanics", "combat", "active"])) {
        return false;
    }
    let message = str_value(message);
    if !free_action_goal_is_passage(&js::s(goal_or_message(free_action, &message))) {
        return false;
    }
    !events.iter().any(|event| text::test(re!(r"move|travel|arriv|depart|relocat|levelchanged|sceneadvanced", "iu"), &js::s(get(Some(event), "event_type"))))
}

fn free_action_hero_name(events: &[Value], state: &Value) -> String {
    let actor_id = js::s(events.iter().find(|event| is_str(get(Some(event), "event_type"), "ActionDeclared")).and_then(|event| event.get("actor_id")));
    let hero = list(state.get("players")).iter().find(|player| js::s(get(Some(player), "id")) == actor_id);
    let name = trim_sentence_end(or(get(hero, "character"), get(hero, "name")), 80);
    if name.is_empty() {
        "Герой".into()
    } else {
        name
    }
}

fn free_action_passage_narration(events: &[Value], state: &Value) -> String {
    format!("{} остаётся где стоял: прохода туда отсюда нет — нужна дверь, проём или лестница рядом.", free_action_hero_name(events, state))
}

fn knowledge_goal_pattern() -> &'static fancy_regex::Regex {
    re!(r"(?<![\p{L}])(?:узна|вызна|разузна|выясн|выспрос|расспрос|спроси|выведа|понять|поясни|объясни|услыш|подслуш|поговор|разговор|договор|убедить(?!ся)|уговор|найти|найд|отыска|отыщ|обнаруж)", "iu")
}

fn unconfirmed_free_action_disclosure(free_action: &Value, message: &str, events: &[Value]) -> bool {
    if !succeeded_kind(&kind_of(free_action)) {
        return false;
    }
    let message = str_value(message);
    let goal = js::s(or(goal_or_message(free_action, &message), Some(&str_value(""))));
    if !text::test(knowledge_goal_pattern(), &goal) {
        return false;
    }
    !events.iter().any(|event| text::test(re!(r"^(?:WorldFact(?:Recorded|Revealed)|KnowledgeRevealed|Clue\w*|NpcSocial\w*|NpcConversation\w*)$", "u"), &js::s(get(Some(event), "event_type"))))
}

fn free_action_unchanged_scene_narration(free_action: &Value, message: &str, events: &[Value], state: &Value) -> String {
    let name = free_action_hero_name(events, state);
    let message = str_value(message);
    let goal = js::s(or(goal_or_message(free_action, &message), Some(&str_value(""))));
    let failed = kind_of(free_action) == "check_failure";
    let route = if text::test(knowledge_goal_pattern(), &goal) {
        "Может, кто-то из здешних знает больше — стоит расспросить."
    } else if free_action_goal_is_passage(&goal) {
        "Пройти можно только настоящим проходом — дверью, проёмом или лестницей рядом."
    } else {
        ""
    };
    let line = if failed { format!("{name} пробует, но не выходит. {route}") } else { format!("{name} старается, но нового это не приносит. {route}") };
    text::trim(&line).to_string()
}

fn free_action_copy_note(free_action: &Value, message: &str, events: &[Value]) -> &'static str {
    if !succeeded_kind(&kind_of(free_action)) || !free_action_is_copy_request(message) {
        return "";
    }
    if events.iter().any(|event| text::test(re!(r"item|loot", "iu"), &js::s(get(Some(event), "event_type")))) {
        return "";
    }
    "Копия осталась записью в хронике отряда: отдельного документа в инвентаре нет."
}

/// `goalEchoesPlayer(goal, message)`: цель — сама фраза игрока, и фраза — реплика.
fn goal_echoes_player(goal: &str, message: &str) -> bool {
    let plain = |value: &str| text::trim(&text::replace_all(re!(r"[^\p{L}\p{N}]+", "gu"), &text::lower(value), " ")).to_string();
    let own = plain(goal);
    if own.is_empty() || !plain(message).starts_with(&text::head(&own, 60)) {
        return false;
    }
    text::test(re!(r#"[:«»"!?]"#, "u"), message) || own.split(' ').count() > 8
}

fn infinitive_goal() -> &'static fancy_regex::Regex {
    re!(r"^\p{L}+(?:ть|ться|ти|чь)(?![\p{L}\p{M}])", "u")
}

/// `deterministicFreeActionNarration(...)`: короткий текст свободного
/// действия из задумки и записанных событий.
fn deterministic_free_action_narration(free_action: &Value, message: &str, events: &[Value], state: &Value, unconfirmed_passage: bool, roleplay_speech: bool) -> OrchestratorResult<String> {
    let kind = kind_of(free_action);
    if roleplay_speech && succeeded_kind(&kind) {
        let quote = match_all(re!(r"«([^«»]{3,400})»", "gu"), message).iter().map(|found| text::trim(&group(found, 1)).to_string()).collect::<Vec<_>>().join(" ");
        if !quote.is_empty() {
            let nearby = list(at(Some(state), &["social", "npcs"])).iter().filter(scene_people_filter(state)).find(|npc| js::truthy(get(Some(npc), "name")));
            return Ok(match nearby {
                Some(npc) => format!("{} оборачивается на голос.", template(get(Some(npc), "name"))),
                None => format!("{} говорит негромко — так, чтобы слышали только свои.", free_action_hero_name(events, state)),
            });
        }
    }
    if !roleplay_speech && !unconfirmed_passage && unconfirmed_free_action_disclosure(free_action, message, events) {
        let mut parts = vec![free_action_unchanged_scene_narration(free_action, message, events, state)];
        parts.extend(free_action_effect_text(events, state)?);
        parts.push(free_action_time_text(events));
        return Ok(parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "));
    }
    if kind == "hazard_contact" {
        let mut parts = free_action_effect_text(events, state)?;
        parts.push(free_action_time_text(events));
        return Ok(parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "));
    }
    if !played_kind(&kind) {
        return Ok(String::new());
    }
    let message_value = str_value(message);
    let raw_goal = trim_sentence_end(goal_or_message(free_action, &message_value), 280);
    let goal = if !raw_goal.is_empty() && text::test(infinitive_goal(), &raw_goal) {
        let mut chars = raw_goal.chars();
        let first = chars.next().map(|ch| text::lower(&ch.to_string())).unwrap_or_default();
        format!("{first}{}", chars.as_str())
    } else {
        raw_goal.clone()
    };
    let failed = kind == "check_failure";
    let watch_question = !unconfirmed_passage
        && text::test(re!(r"\?|(?<![\p{L}\p{M}])ли(?![\p{L}\p{M}])", "u"), &format!("{message} {raw_goal}"))
        && text::test(re!(r"(?<![\p{L}\p{M}])(?:смотр|наблюда|след|слеж|вгляд|высматр|всматр|прислуш|жд|караул)\p{L}*", "iu"), &raw_goal);
    let hero = free_action_hero_name(events, state);
    let outcome_detail = text::trim(&js::s(free_action.get("outcome_detail"))).to_string();
    let lead = if !outcome_detail.is_empty() && !unconfirmed_passage {
        outcome_detail
    } else if watch_question {
        if failed {
            format!("{hero} всматривается, но толком ничего не разглядеть.")
        } else {
            format!("{hero} не сводит глаз, но ничего заметного за это время не происходит.")
        }
    } else if unconfirmed_passage && !failed {
        free_action_passage_narration(events, state)
    } else if is_str(at(Some(free_action), &["reading", "activity_kind"]), "stunt") {
        if failed { "Трюк сорвался." } else { "Трюк удался." }.to_string()
    } else if !goal.is_empty() {
        let named = format!("{hero} ");
        if !failed && raw_goal.starts_with(&named) {
            format!("{raw_goal}.")
        } else if !failed && !text::test(infinitive_goal(), &raw_goal) && text::test(re!(r"^\p{Ll}", "u"), &raw_goal) {
            format!("{hero} {}.", text::replace_first(re!(r"\s+[—–-]\s+[^—–]*(?:\?|(?<![\p{L}\p{M}])ли(?![\p{L}\p{M}]))[^—–]*$", "u"), &raw_goal, ""))
        } else if failed && free_action_goal_is_passage(&raw_goal) {
            "Дверь не поддаётся.".into()
        } else if failed && raw_goal.starts_with(&named) {
            if free_action_goal_is_passage(&raw_goal) {
                "Дверь не поддаётся.".into()
            } else {
                format!("{hero} пробует, но не выходит.")
            }
        } else if goal_echoes_player(&raw_goal, message) {
            if failed {
                format!("{hero} пробует, но не выходит.")
            } else {
                format!("{hero} добивается своего.")
            }
        } else {
            format!("{}: {goal}.", if failed { "Не вышло" } else { "Вышло" })
        }
    } else if failed {
        "Не вышло.".into()
    } else {
        "Вышло.".into()
    };
    let mut parts = vec![lead];
    let effects = free_action_effect_text(events, state)?;
    let discovered = !failed && events.iter().any(is_discovery_fact);
    if discovered && !effects.is_empty() {
        parts.clear();
    }
    parts.extend(effects);
    let time = free_action_time_text(events);
    if !time.is_empty() && !discovered {
        parts.push(time);
    }
    Ok(parts.join(" "))
}

/// `turnPromptVersions(narration)`: честные версии промптов хода.
fn turn_prompt_versions(narration: Option<&Value>) -> Value {
    let mut by_role: IndexMap<&str, &str> = IndexMap::new();
    for descriptor in PROMPT_DESCRIPTORS {
        by_role.insert(descriptor.role, descriptor.prompt_id);
    }
    let narrator = match narration.filter(|value| js::truthy(Some(value))).and_then(Value::as_object).and_then(|map| map.get("prompt_version")) {
        Some(version) => version.clone(),
        None => by_role.get("narrator").map_or(Value::Null, |id| str_value(*id)),
    };
    json!({
        "intent_parser": null,
        "action_adjudicator": by_role.get("action_adjudicator").map_or(Value::Null, |id| str_value(*id)),
        "narrator": narrator,
        "verifier": null,
    })
}

/// `encodeURIComponent(value)`.
fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn explanation_url(campaign_id: &str, turn_id: &str) -> String {
    format!("/api/campaigns/{}/turns/{}/explanation", encode_uri_component(campaign_id), encode_uri_component(turn_id))
}

fn constraints_of(message: &str) -> Vec<Value> {
    text::find_all(re!(r"(?:не\s+|без\s+)[^,.;!?]+", "giu"), message).into_iter().take(6).map(Value::String).collect()
}

// --- оркестратор ------------------------------------------------------------------------------

/// Источник идентификаторов (`randomUUID`).
pub type IdFactory = Arc<dyn Fn() -> String>;
/// Часы (`() => Date.now()`).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Параметры конструктора `new GameOrchestrator({ … })`. Незаданное поле —
/// значение по умолчанию JS.
pub struct GameOrchestratorOptions {
    pub event_store: Arc<dyn OrchestratorJournal>,
    pub rules_engine: Arc<dyn TurnRules>,
    /// `None` — `new IntentParser()`.
    pub intent_parser: Option<Arc<dyn IntentReader>>,
    pub rule_retriever: Option<Arc<dyn RuleSearch>>,
    /// `None` — `new Adjudicator()`.
    pub adjudicator: Option<Arc<dyn PlanAdjudicator>>,
    pub trace_store: Option<Arc<dyn TurnTraceStore>>,
    /// `None` — `new Narrator()`; `Some(None)` — `narrator: null`.
    pub narrator: Option<Option<Arc<dyn TurnNarrator>>>,
    pub npc_social_controller: Option<Arc<dyn SocialResponder>>,
    /// `None` — `new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, rollRegistry, now })`.
    pub unknown_action_handler: Option<Arc<dyn UnknownActionHandler>>,
    /// Судья обсуждения. В JS это `unknownActionHandler.actionAdjudicator`,
    /// если у него есть `discuss`, иначе `new ActionAdjudicator()`; здесь —
    /// явно (сервер передаёт тот же судья, что и исполнителю О1).
    pub action_adjudicator: Option<Arc<dyn TableDiscussion>>,
    pub lore_voice: Option<Arc<dyn LoreRetell>>,
    pub roll_registry: Option<Arc<dyn TurnRollRegistry>>,
    /// Реестр уточнений, общий с HTTP-слоем. `None` — реестр в памяти (в JS —
    /// файл `clarifications.json` рядом с журналом).
    pub clarification_registry: Option<Arc<Mutex<ClarificationRegistry>>>,
    pub id_factory: Option<IdFactory>,
    pub now: Option<Clock>,
}

impl GameOrchestratorOptions {
    pub fn new(event_store: Arc<dyn OrchestratorJournal>, rules_engine: Arc<dyn TurnRules>) -> Self {
        Self {
            event_store,
            rules_engine,
            intent_parser: None,
            rule_retriever: None,
            adjudicator: None,
            trace_store: None,
            narrator: None,
            npc_social_controller: None,
            unknown_action_handler: None,
            action_adjudicator: None,
            lore_voice: None,
            roll_registry: None,
            clarification_registry: None,
            id_factory: None,
            now: None,
        }
    }
}

/// Транспорт живого рассказа: начало (`onNarrationStart({ stateVersion })`).
pub type NarrationStart = Arc<dyn Fn(&Value)>;
/// Транспорт живого рассказа: кусок текста (`onNarrationProgress(text, { stateVersion })`).
pub type NarrationProgress = Arc<dyn Fn(&str, &Value) + Send + Sync>;

/// Вход `handle(input)`: поля JSON запроса и то, что JSON не переносит.
#[derive(Clone, Default)]
pub struct HandleInput {
    /// Объект запроса JS (`state`, `campaignId`, `playerId`, `message`,
    /// `commands`, `idempotencyKey`, `user`, `manualRoll`, `verifiedRoll`, …).
    pub fields: Value,
    /// `commandCapability === DIRECTOR_COMMAND_CAPABILITY`: серверная метка
    /// Режиссёра, которую JSON-запрос подделать не может.
    pub director_capability: bool,
    pub on_narration_start: Option<NarrationStart>,
    pub on_narration_progress: Option<NarrationProgress>,
}

impl HandleInput {
    pub fn new(fields: Value) -> Self {
        Self { fields, ..Self::default() }
    }

    fn field(&self, key: &str) -> Option<&Value> {
        get(Some(&self.fields), key)
    }

    /// `input.a ?? input.b`.
    fn either(&self, a: &str, b: &str) -> Option<&Value> {
        coalesce(&[self.field(a), self.field(b)])
    }

    /// `Boolean(input.commands)`.
    fn has_commands(&self) -> bool {
        js::truthy(self.field("commands"))
    }

    /// `{ ...input, key: value }`.
    fn with(&self, entries: Vec<(&str, Value)>) -> Self {
        let mut next = self.clone();
        if !next.fields.is_object() {
            next.fields = json!({});
        }
        for (key, value) in entries {
            set(&mut next.fields, key, value);
        }
        next
    }

    /// `planStepInput(input)`: вход внутреннего запроса — без броска,
    /// подтверждений и потока прошлого запроса.
    fn plan_step(&self) -> Self {
        let mut next = self.clone();
        if !next.fields.is_object() {
            next.fields = json!({});
        }
        for key in [
            "action", "message", "clarification_id", "clarificationId", "idempotency_key", "confirmed_proposal_id", "supersedesCheckId", "supersedes_check_id", "supersedesProposalId", "supersedes_proposal_id", "questionCheckId", "question_check_id", "questionProposalId", "question_proposal_id", "turnId", "turn_id",
        ] {
            unset(&mut next.fields, key);
        }
        set(&mut next.fields, "verifiedRoll", Value::Null);
        set(&mut next.fields, "confirmedProposalId", Value::Null);
        next.on_narration_start = None;
        next.on_narration_progress = None;
        next
    }

    /// `(input.commands ?? []).find(predicate)`: индекс команды. Не массив
    /// (и не `null`) — `TypeError`, как у `.find` в JS.
    fn find_command(&self, predicate: impl Fn(&Value) -> bool) -> OrchestratorResult<Option<usize>> {
        match nullish(self.field("commands"), None) {
            None => Ok(None),
            Some(Value::Array(items)) => Ok(items.iter().position(predicate)),
            Some(_) => Err(type_error("(input.commands ?? []).find is not a function")),
        }
    }

    fn command_mut(&mut self, index: usize) -> Option<&mut Value> {
        self.fields.get_mut("commands").and_then(Value::as_array_mut).and_then(|items| items.get_mut(index))
    }
}

/// Общий итог одинаковых параллельных запросов (`narrationInflight`).
struct InflightSlot {
    done: Option<OrchestratorResult<Value>>,
    wakers: Vec<Waker>,
}

type SharedInflight = Arc<Mutex<InflightSlot>>;

struct AwaitInflight(SharedInflight);

impl Future for AwaitInflight {
    type Output = OrchestratorResult<Value>;

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

struct InflightGuard<'a> {
    owner: &'a GameOrchestrator,
    key: String,
    slot: SharedInflight,
}

impl InflightGuard<'_> {
    fn finish(&self, result: OrchestratorResult<Value>) {
        let wakers = {
            let mut slot = lock(&self.slot);
            if slot.done.is_none() {
                slot.done = Some(result);
            }
            std::mem::take(&mut slot.wakers)
        };
        let mut inflight = lock(&self.owner.narration_inflight);
        if inflight.get(&self.key).is_some_and(|(_, current)| Arc::ptr_eq(current, &self.slot)) {
            inflight.shift_remove(&self.key);
        }
        drop(inflight);
        for waker in wakers {
            waker.wake();
        }
    }
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.finish(Err(OrchestratorError::plain("Запрос рассказа прерван")));
    }
}

/// Вход трассы хода (`saveTrace({ … })`).
#[derive(Clone, Default)]
struct TraceInput {
    turn_id: String,
    campaign_id: String,
    idempotency_key: Option<String>,
    request_fingerprint: Option<String>,
    intent: Option<Value>,
    retrieval_queries: Option<Value>,
    retrieved_rules: Option<Value>,
    plan: Value,
    engine_result: Option<Value>,
    state_before: Option<Value>,
    state_after: Option<Value>,
    verification: Option<Value>,
    latency: Value,
    narration: Option<Value>,
    ruling: Option<Value>,
    recovery: Option<Value>,
    created_at: Option<Value>,
    /// Общие ссылки объекта трассы JS (см. [`mark_shared_references`]).
    aliases: TraceAliases,
}

/// Как `validated_commands` трассы связаны с `plan.proposed_commands` в JS.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum CommandsAlias {
    /// Разные объекты.
    #[default]
    None,
    /// Тот же массив.
    Whole,
    /// Новый массив из тех же команд (повтор хода).
    Elements,
    /// Копии движка `{ ...command }`: вложенные поля — те же объекты.
    Engine,
}

/// Какие части трассы JS ссылаются на одни и те же объекты.
#[derive(Clone, Debug, Default)]
struct TraceAliases {
    commands: CommandsAlias,
    /// `ruling` трассы — тот же объект, что `plan.ruling_draft`.
    ruling: bool,
    /// `RecordRuling` собран оркестратором из черновика: `ruling_draft` — тот
    /// же объект, что `ruling` команды, а `supporting_rule_ids` — `plan.rule_ids`.
    ruling_from_draft: bool,
    /// Черновик О1 и `ruling` его команд — `{ ...ruling }`: вложенное общее.
    ruling_spread: bool,
    /// События, чей `payload` — тот же объект, что бросок в `rolls`.
    rolled_payloads: Vec<usize>,
}

/// `GameOrchestrator`.
pub struct GameOrchestrator {
    pub intent_parser: Arc<dyn IntentReader>,
    pub rule_retriever: Option<Arc<dyn RuleSearch>>,
    pub adjudicator: Arc<dyn PlanAdjudicator>,
    pub rules_engine: Arc<dyn TurnRules>,
    pub event_store: Arc<dyn OrchestratorJournal>,
    pub trace_store: Option<Arc<dyn TurnTraceStore>>,
    pub narrator: Option<Arc<dyn TurnNarrator>>,
    pub npc_social_controller: Option<Arc<dyn SocialResponder>>,
    pub unknown_action_handler: Arc<dyn UnknownActionHandler>,
    pub action_adjudicator: Arc<dyn TableDiscussion>,
    pub lore_voice: Option<Arc<dyn LoreRetell>>,
    /// Ручное подтверждение кубика игроком; без реестра d20-проверки
    /// разрешаются немедленным серверным броском.
    pub roll_registry: Option<Arc<dyn TurnRollRegistry>>,
    pub clarification_registry: Arc<Mutex<ClarificationRegistry>>,
    pub id_factory: IdFactory,
    pub now: Clock,
    /// Тёплый буфер последних рассказов кампании (`narrationMemory`).
    narration_memory: Mutex<IndexMap<String, Vec<String>>>,
    /// Одинаковые параллельные запросы (`narrationInflight`).
    narration_inflight: Mutex<IndexMap<String, (String, SharedInflight)>>,
}

/// Рассказчики событий без модели регистрируются при импорте модулей JS
/// (`encounter-narration`, `merchant-narration`, `scene-narration`,
/// `scene-hazard-narration`); здесь — при первом оркестраторе.
fn register_deterministic_narrators() {
    let _ = sk_narration::encounter_narration::register_encounter_narrator();
    let _ = sk_economy::merchant_narration::merchant_narrator();
    let _ = sk_narration::scene_narration::register_scene_narrator();
    let _ = sk_combat_content::scene_hazard_narration::register_scene_hazard_narrator();
}

impl GameOrchestrator {
    /// `new GameOrchestrator(options)`.
    pub fn new(options: GameOrchestratorOptions) -> OrchestratorResult<Self> {
        register_deterministic_narrators();
        let now: Clock = options.now.unwrap_or_else(|| Arc::new(sk_core::clock::now_ms));
        let unknown_action_handler: Arc<dyn UnknownActionHandler> = match options.unknown_action_handler {
            Some(handler) => handler,
            None => {
                let rules: Arc<dyn OrchestratorRules> = options.rules_engine.clone();
                let clock = now.clone();
                let mut autonomous = AutonomousCampaignOrchestrator::new(options.event_store.clone(), rules).with_now(Arc::new(move || clock()));
                if let Some(registry) = &options.roll_registry {
                    let registry: Arc<dyn CheckRegistry> = registry.clone();
                    autonomous = autonomous.with_roll_registry(registry);
                }
                Arc::new(autonomous)
            }
        };
        let clarification_registry = match options.clarification_registry {
            Some(registry) => registry,
            None => {
                let clock = now.clone();
                let registry = ClarificationRegistry::new(ClarificationRegistryOptions { storage_file: None, ttl_ms: None, now: Some(Box::new(move || clock() as f64)), id_factory: None }).map_err(registry_error)?;
                Arc::new(Mutex::new(registry))
            }
        };
        Ok(Self {
            intent_parser: options.intent_parser.unwrap_or_else(|| Arc::new(IntentParser)),
            rule_retriever: options.rule_retriever,
            adjudicator: options.adjudicator.unwrap_or_else(|| Arc::new(Adjudicator)),
            rules_engine: options.rules_engine,
            event_store: options.event_store,
            trace_store: options.trace_store,
            narrator: match options.narrator {
                Some(narrator) => narrator,
                None => Some(Arc::new(Narrator::new(Default::default()))),
            },
            npc_social_controller: options.npc_social_controller,
            unknown_action_handler,
            action_adjudicator: options.action_adjudicator.unwrap_or_else(|| Arc::new(ActionAdjudicator::new(None, None, None))),
            lore_voice: options.lore_voice,
            roll_registry: options.roll_registry,
            clarification_registry,
            id_factory: options.id_factory.unwrap_or_else(|| Arc::new(hash::uuid_v4)),
            now,
            narration_memory: Mutex::new(IndexMap::new()),
            narration_inflight: Mutex::new(IndexMap::new()),
        })
    }

    fn now_ms(&self) -> i64 {
        (self.now)()
    }

    fn clarifications(&self) -> std::sync::MutexGuard<'_, ClarificationRegistry> {
        lock(&self.clarification_registry)
    }

    /// `recentNarrationsFor(campaignId)`: холодный старт поднимает историю из
    /// трасс один раз, дальше отвечает тёплый буфер.
    pub fn recent_narrations_for(&self, campaign_id: &str) -> OrchestratorResult<Vec<String>> {
        if campaign_id.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(warm) = lock(&self.narration_memory).get(campaign_id) {
            return Ok(warm.clone());
        }
        let cold = recent_campaign_narrations(self.trace_store.as_ref(), campaign_id)?;
        lock(&self.narration_memory).insert(campaign_id.to_string(), cold.clone());
        Ok(cold)
    }

    /// `rememberNarration(campaignId, value)`.
    pub fn remember_narration(&self, campaign_id: &str, value: &str) -> OrchestratorResult<()> {
        let value = text::trim(value).to_string();
        if campaign_id.is_empty() || value.is_empty() {
            return Ok(());
        }
        let mut next = self.recent_narrations_for(campaign_id)?;
        next.push(value);
        let next = last_n(&next, NARRATOR_RECENT_TEXT_LIMIT);
        let mut memory = lock(&self.narration_memory);
        memory.shift_remove(campaign_id);
        memory.insert(campaign_id.to_string(), next);
        while memory.len() > NARRATION_MEMORY_CAMPAIGNS {
            memory.shift_remove_index(0);
        }
        Ok(())
    }

    /// `explanation(campaignId, turnId, viewer)`.
    pub fn explanation(&self, campaign_id: &str, turn_id: Option<&Value>, viewer: &Value) -> OrchestratorResult<Value> {
        let Some(store) = &self.trace_store else { return Ok(Value::Null) };
        let trace = if js::truthy(turn_id) { store.get(campaign_id, &js::s(turn_id))? } else { store.latest(campaign_id, Some(&|trace: &Value| is_mechanical_trace(Some(trace))))? };
        Ok(build_turn_explanation(trace.as_ref(), Some(viewer)))
    }

    /// `parleyCommandFor({ input, playerId, message, state })`: команда
    /// парлея из хотбара или из окрика в бою; `None` — обычный ход.
    fn parley_command_for(&self, input: &HandleInput, player_id: &str, message: &str, state: &Value) -> Option<Value> {
        let explicit = list(input.field("commands")).iter().find(|command| js::s(get(Some(command), "command_type")) == "ProposeParley");
        if let Some(explicit) = explicit {
            let actor = js::s(Some(nullish(explicit.get("actor_id"), None).unwrap_or(&str_value(player_id))));
            let skill = if is_str(explicit.get("skill"), "intimidation") { "intimidation" } else { "persuasion" };
            return Some(with(explicit, json!({ "actor_id": actor, "skill": skill })));
        }
        if input.has_commands() || player_id.is_empty() {
            return None;
        }
        if !js::is_true(at(Some(state), &["mechanics", "combat", "active"])) || truce_for(state).is_some() {
            return None;
        }
        let message = str_value(message);
        if !mentions_parley(&message) {
            return None;
        }
        Some(json!({ "command_type": "ProposeParley", "actor_id": player_id, "skill": parley_skill_for(&message) }))
    }

    fn registry(&self) -> OrchestratorResult<&Arc<dyn TurnRollRegistry>> {
        self.roll_registry.as_ref().ok_or_else(|| type_error("Cannot read properties of null (reading 'registerCheck')"))
    }

    /// Карточка проверки: `registerCheck` с полями предпросмотра.
    fn register_card(&self, campaign_id: &str, actor_id: &str, preview: &Value, difficulty: Value, disadvantage: Value, context: Value) -> OrchestratorResult<Value> {
        let label = d20_check_label(&obj(vec![("kind", Some(str_value("check"))), ("ability", preview.get("ability").cloned()), ("skill", preview.get("skill").cloned())]));
        let options = obj(vec![
            ("campaignId", Some(str_value(campaign_id))),
            ("actorId", Some(str_value(actor_id))),
            ("label", Some(str_value(label))),
            ("modifier", preview.get("modifier").cloned()),
            ("difficulty", Some(difficulty)),
            ("ability", preview.get("ability").cloned()),
            ("advantage", preview.get("advantage").cloned()),
            ("disadvantage", Some(disadvantage)),
            ("context", Some(context)),
        ]);
        self.registry()?.register_check(&options)
    }

    fn with_skill(check: Value, skill: Option<&Value>) -> Value {
        let mut card = js::spread(&check, json!({}));
        match skill {
            Some(skill) => set(&mut card, "skill", skill.clone()),
            None => unset(&mut card, "skill"),
        }
        card
    }

    fn actor_of(command: &Value, player_id: &str) -> String {
        js::s(Some(nullish(command.get("actor_id"), None).unwrap_or(&str_value(player_id))))
    }

    /// `parleyCheckCard(...)`: СЛ — та же серверная мораль, что во второй фазе.
    fn parley_check_card(&self, campaign_id: &str, player_id: &str, state: &Value, command: &Value) -> OrchestratorResult<Option<Value>> {
        let morale = parley_morale_for(state);
        if js::truthy(morale.get("refuses")) {
            return Ok(None);
        }
        let attempts = js::number(at(Some(state), &["mechanics", "combat", "parley_attempts"]));
        let attempts = if attempts.is_nan() { 0.0 } else { attempts }.max(0.0);
        let actor = Self::actor_of(command, player_id);
        let difficulty = morale.get("difficulty").cloned().unwrap_or(Value::Null);
        let preview = preview_d20_check(state, &obj(vec![("actorId", Some(str_value(actor.clone()))), ("kind", Some(str_value("check"))), ("ability", Some(str_value(PARLEY_ABILITY))), ("skill", command.get("skill").cloned()), ("difficulty", morale.get("difficulty").cloned())]))?;
        let disadvantage = if js::truthy(preview.get("disadvantage")) { preview["disadvantage"].clone() } else { Value::Bool(attempts > 0.0) };
        let context = obj(vec![("kind", Some(str_value("parley"))), ("policy", Some(str_value(PARLEY_POLICY_ID))), ("skill", command.get("skill").cloned())]);
        let check = self.register_card(campaign_id, &actor, &preview, difficulty, disadvantage, context)?;
        Ok(Some(Self::with_skill(check, preview.get("skill"))))
    }

    /// `guardEscapeCheckCard(...)`: СЛ — пассивное Восприятие стражи.
    fn guard_escape_check_card(&self, campaign_id: &str, player_id: &str, state: &Value, command: &Value) -> OrchestratorResult<Option<Value>> {
        let encounter = guard_encounter_for(state);
        if !js::truthy(Some(&encounter)) {
            return Ok(None);
        }
        let actor = Self::actor_of(command, player_id);
        let preview = preview_d20_check(state, &obj(vec![("actorId", Some(str_value(actor.clone()))), ("kind", Some(str_value("check"))), ("skill", command.get("skill").cloned()), ("difficulty", encounter.get("escape_dc").cloned())]))?;
        let disadvantage = if js::truthy(preview.get("disadvantage")) { preview["disadvantage"].clone() } else { Value::Bool(js::number(encounter.get("escape_attempts")) > 0.0) };
        let context = obj(vec![("kind", Some(str_value("guard-escape"))), ("policy", Some(str_value(LAW_POLICY_ID))), ("skill", command.get("skill").cloned())]);
        let check = self.register_card(campaign_id, &actor, &preview, encounter.get("escape_dc").cloned().unwrap_or(Value::Null), disadvantage, context)?;
        Ok(Some(Self::with_skill(check, preview.get("skill"))))
    }

    /// `tavernDiceCheckCard(...)`: СЛ — кость соперника на столе плюс один.
    fn tavern_dice_check_card(&self, campaign_id: &str, player_id: &str, state: &Value, command: &Value) -> OrchestratorResult<Option<Value>> {
        let actor = Self::actor_of(command, player_id);
        let Some(round) = tavern_round_for(state, &str_value(actor.clone())) else { return Ok(None) };
        let approach = js::s(Some(nullish(command.get("approach"), None).unwrap_or(&str_value("fair"))));
        let preview = preview_tavern_dice_roll(state, Some(&str_value(actor.clone())), Some(&str_value(approach.clone())));
        let label = format!("Кости против {}", if round.npc_name.is_empty() { "соперника" } else { round.npc_name.as_str() });
        let options = obj(vec![
            ("campaignId", Some(str_value(campaign_id))),
            ("actorId", Some(str_value(actor))),
            ("label", Some(str_value(label))),
            ("modifier", preview.get("modifier").cloned()),
            ("difficulty", Some(Value::from(round.target))),
            ("ability", Some(Value::Null)),
            ("advantage", preview.get("advantage").cloned()),
            ("disadvantage", preview.get("disadvantage").cloned()),
            ("context", Some(json!({ "kind": "tavern-dice", "policy": TAVERN_POLICY_ID, "round_id": round.id, "approach": approach }))),
        ]);
        Ok(Some(self.registry()?.register_check(&options)?))
    }

    /// `shrinePrayerCheckCard(...)`: `None` — молиться нельзя, отказ до кубика.
    fn shrine_prayer_check_card(&self, campaign_id: &str, player_id: &str, state: &Value, command: &Value) -> OrchestratorResult<Option<Value>> {
        let actor = Self::actor_of(command, player_id);
        let prop_id = js::s(command.get("prop_id"));
        if shrine_prayer_refusal_for(state, &str_value(actor.clone()), &str_value(prop_id.clone()))?.is_some() {
            return Ok(None);
        }
        let preview = preview_d20_check(state, &json!({ "actorId": actor, "kind": "check", "ability": PRAYER_ABILITY, "skill": PRAYER_SKILL, "difficulty": PRAYER_DC }))?;
        let context = json!({ "kind": "shrine-prayer", "policy": BLESSINGS_POLICY_ID, "prop_id": prop_id });
        let disadvantage = preview.get("disadvantage").cloned().unwrap_or(Value::Null);
        let check = self.register_card_plain(campaign_id, &actor, &preview, Value::from(PRAYER_DC), disadvantage, context)?;
        Ok(Some(Self::with_skill(check, preview.get("skill"))))
    }

    /// Как `register_card`, но `disadvantage` идёт из предпросмотра как есть
    /// (`undefined` — без ключа).
    fn register_card_plain(&self, campaign_id: &str, actor_id: &str, preview: &Value, difficulty: Value, disadvantage: Value, context: Value) -> OrchestratorResult<Value> {
        let label = d20_check_label(&obj(vec![("kind", Some(str_value("check"))), ("ability", preview.get("ability").cloned()), ("skill", preview.get("skill").cloned())]));
        let options = obj(vec![
            ("campaignId", Some(str_value(campaign_id))),
            ("actorId", Some(str_value(actor_id))),
            ("label", Some(str_value(label))),
            ("modifier", preview.get("modifier").cloned()),
            ("difficulty", Some(difficulty)),
            ("ability", preview.get("ability").cloned()),
            ("advantage", preview.get("advantage").cloned()),
            ("disadvantage", preview.get("disadvantage").map(|_| disadvantage)),
            ("context", Some(context)),
        ]);
        self.registry()?.register_check(&options)
    }

    /// `pickpocketCheckCard(...)`: СЛ объявляется — вор видит толчею сам.
    fn pickpocket_check_card(&self, campaign_id: &str, player_id: &str, state: &Value, command: &Value) -> OrchestratorResult<Option<Value>> {
        let actor = Self::actor_of(command, player_id);
        let npc_id = js::s(command.get("npc_id"));
        let present_npcs = present_scene_npcs(state);
        let Some(npc) = present_npcs.iter().find(|candidate| js::string(candidate.get("id")) == npc_id) else { return Ok(None) };
        let standing = list(state.get("players")).iter().filter(|player| js::number(Some(nullish(get(Some(player), "hp"), None).unwrap_or(&Value::from(1)))) > 0.0).count();
        let present = Value::from((present_npcs.len() + standing) as u64);
        let difficulty = pickpocket_difficulty_for(state, npc, Some(&present));
        let crowd_label = difficulty.get("crowd_label").cloned();
        let preview = preview_d20_check(state, &obj(vec![("actorId", Some(str_value(actor.clone()))), ("kind", Some(str_value("check"))), ("ability", Some(str_value(PICKPOCKET_ABILITY))), ("skill", Some(str_value(PICKPOCKET_SKILL))), ("difficulty", difficulty.get("difficulty").cloned())]))?;
        let context = obj(vec![("kind", Some(str_value("pickpocket"))), ("policy", Some(str_value(PICKPOCKET_POLICY_ID))), ("npc_id", Some(str_value(npc_id))), ("crowd_label", crowd_label.clone())]);
        let disadvantage = preview.get("disadvantage").cloned().unwrap_or(Value::Null);
        let check = self.register_card_plain(campaign_id, &actor, &preview, difficulty.get("difficulty").cloned().unwrap_or(Value::Null), disadvantage, context)?;
        let mut card = Self::with_skill(check, preview.get("skill"));
        match crowd_label {
            Some(label) => set(&mut card, "crowd_label", label),
            None => unset(&mut card, "crowd_label"),
        }
        Ok(Some(card))
    }

    /// Сторож второй фазы кражи: та же проверка и тот же карман.
    pub fn assert_pickpocket_roll_context(command: &Value, context: Option<&Value>) -> OrchestratorResult<()> {
        if js::s(get(context, "kind")) != "pickpocket" {
            return Err(context_mismatch("Этот бросок регистрировался не для карманной кражи"));
        }
        if js::s(get(context, "npc_id")) != js::s(command.get("npc_id")) {
            return Err(context_mismatch("Этот бросок регистрировался против другого человека"));
        }
        Ok(())
    }

    /// Сторож второй фазы молитвы: бросок молитвы и у этой святыни.
    pub fn assert_shrine_prayer_roll_context(command: &Value, context: Option<&Value>) -> OrchestratorResult<()> {
        if js::s(get(context, "kind")) != "shrine-prayer" {
            return Err(context_mismatch("Этот бросок регистрировался не для молитвы"));
        }
        if js::s(get(context, "prop_id")) != js::s(command.get("prop_id")) {
            return Err(context_mismatch("Этот бросок регистрировался у другой святыни"));
        }
        Ok(())
    }

    /// `beastTamingPolicyFor(state, beastId)`: одна политика на обе фазы.
    pub fn beast_taming_policy_for(state: &Value, beast_id: &str) -> Option<Value> {
        let candidate = tameable_beasts(state).into_iter().find(|entry| match nullish(get(entry.beast.as_ref(), "id"), None) {
            Some(id) => is_str(Some(id), beast_id),
            None => beast_id_for(state, entry.enemy.get("id")) == beast_id,
        })?;
        if candidate.blocked_reason.is_some() {
            return None;
        }
        Some(beast_taming_policy(state, Some(&candidate.enemy), candidate.beast.as_ref()).to_json())
    }

    /// `beastTamingCheckCard(...)`: в контекст уезжают ступень и объявленная СЛ.
    fn beast_taming_check_card(&self, campaign_id: &str, player_id: &str, state: &Value, command: &Value) -> OrchestratorResult<Option<Value>> {
        let actor = Self::actor_of(command, player_id);
        let beast_id = js::s(command.get("beast_id"));
        let Some(policy) = Self::beast_taming_policy_for(state, &beast_id) else { return Ok(None) };
        let difficulty = policy.get("difficulty").cloned().unwrap_or(Value::Null);
        let preview = preview_d20_check(state, &json!({ "actorId": actor, "kind": "check", "ability": BEAST_TAMING_ABILITY, "skill": BEAST_TAMING_SKILL, "difficulty": difficulty }))?;
        let context = obj(vec![
            ("kind", Some(str_value("beast-taming"))),
            ("policy", Some(str_value(BEAST_TAMING_POLICY_ID))),
            ("beast_id", Some(str_value(beast_id))),
            ("stage", policy.get("stage").cloned()),
            ("difficulty", Some(difficulty.clone())),
        ]);
        let disadvantage = preview.get("disadvantage").cloned().unwrap_or(Value::Null);
        let check = self.register_card_plain(campaign_id, &actor, &preview, difficulty, disadvantage, context)?;
        let mut card = Self::with_skill(check, preview.get("skill"));
        set(&mut card, "stage", policy.get("stage").cloned().unwrap_or(Value::Null));
        set(&mut card, "difficulty_parts", policy.get("parts").cloned().unwrap_or(Value::Null));
        Ok(Some(card))
    }

    /// Сторож второй фазы уговора: этот зверь, та же ступень и та же СЛ.
    pub fn assert_beast_roll_context(state: &Value, command: &Value, context: Option<&Value>) -> OrchestratorResult<()> {
        if js::s(get(context, "kind")) != "beast-taming" {
            return Err(context_mismatch("Этот бросок регистрировался не для уговора зверя"));
        }
        let beast_id = js::s(command.get("beast_id"));
        if js::s(get(context, "beast_id")) != beast_id {
            return Err(context_mismatch("Этот бросок регистрировался для другого зверя"));
        }
        let policy = Self::beast_taming_policy_for(state, &beast_id);
        let stage = match nullish(get(policy.as_ref(), "stage"), None) {
            Some(stage) => stage.clone(),
            None => beast_for(state, Some(&str_value(beast_id.clone()))).and_then(|beast| nullish(beast.get("stage"), None).cloned()).unwrap_or_else(|| str_value("wary")),
        };
        if !same(Some(&str_value(js::s(get(context, "stage")))), Some(&stage)) {
            return Err(context_mismatch("Между броском и ходом зверь переменился: бросьте кость заново"));
        }
        if let Some(policy) = &policy {
            if js::number(get(context, "difficulty")) != js::number(policy.get("difficulty")) {
                return Err(context_mismatch("Между броском и ходом СЛ уговора переменилась: бросьте кость заново"));
            }
        }
        Ok(())
    }

    /// `freeActionResponse({ … })`: ответ на свободное действие после О1.
    #[allow(clippy::too_many_arguments)] // параметры объекта JS `freeActionResponse({ … })`
    async fn free_action_response(
        &self,
        free_action: Value,
        campaign_id: &str,
        player_id: &str,
        viewer: &Value,
        message: &str,
        intent: &Value,
        retrieval_queries: &Value,
        retrieved_rules: &Value,
        plan: &Value,
        authoritative_state: &Value,
        idempotency_key: &str,
        request_fingerprint: Option<String>,
        turn_id: &str,
        started: i64,
        resolved_action: Option<&str>,
    ) -> OrchestratorResult<Value> {
        let state = nullish(free_action.get("state"), None).cloned().unwrap_or_else(|| authoritative_state.clone());
        let kind = kind_of(&free_action);
        if kind == "check_required" {
            let check = match free_action.get("check").filter(|check| js::truthy(Some(check))) {
                Some(check) => with(check, json!({ "proposal_id": coalesce(&[check.get("proposal_id"), check.get("check_id")]).cloned().unwrap_or(Value::Null) })),
                None => Value::Null,
            };
            let mut response = obj(vec![
                ("narration", Some(str_value(js::s(free_action.get("narration"))))),
                ("effects", Some(empty_effects())),
                ("provider", Some(str_value("deterministic-free-action"))),
                ("model", Some(str_value("server-policy"))),
                ("turn_id", Some(str_value(turn_id))),
                ("engine_mode", Some(str_value("enforce"))),
                ("state_version", coalesce(&[free_action.get("state_version"), state.get("state_version")]).cloned()),
                ("mechanics", Some(json!([]))),
                ("visible_state_changes", Some(json!([]))),
                ("proposal_id", Some(nullish(get(Some(&check), "proposal_id"), None).cloned().unwrap_or(Value::Null))),
                ("check", Some(check)),
            ]);
            if let Some(action) = resolved_action {
                set(&mut response, "resolved_action", str_value(action));
            }
            if js::truthy(free_action.get("stakes")) {
                set(&mut response, "stakes", free_action["stakes"].clone());
            }
            set(&mut response, "turn_consumed", Value::Bool(false));
            set(&mut response, "action_kind", str_value("free"));
            set(&mut response, "request_kind", str_value("action"));
            set(&mut response, "free_action_outcome", free_action.get("kind").cloned().unwrap_or(Value::Null));
            return Ok(response);
        }
        let committed_events: Vec<Value> = list(free_action.get("events")).to_vec();
        let shared = shared_narration_events(&committed_events, &state);
        let public_events: Vec<Value> = mechanics_for_viewer(Some(&Value::Array(shared)), Some(&json!({ "isPartyMember": true })), Some(&str_value(player_id)), Some(&state)).map_err(projection_error)?.and_then(|value| value.as_array().cloned()).unwrap_or_default();
        let mut constraints: Vec<Value> = list(plan.get("narration_constraints")).to_vec();
        if no_world_change_constraint(plan) {
            constraints.push(str_value("no-unconfirmed-world-changes"));
        }
        constraints.extend(list(free_action.get("narration_constraints")).iter().cloned());
        let story_context = narration_story_context(&state, viewer, &public_events)?;
        let reading = free_action.get("reading");
        let message_value = str_value(message);
        let mut player_intent = json!({
            "action": message,
            "constraints": constraints_of(message),
            "goal": text::head(&js::s(Some(nullish(get(reading, "goal_summary"), None).unwrap_or(&message_value))), 500),
            "approach": text::head(&js::s(get(reading, "approach_summary")), 500),
        });
        if let Some(outcome) = free_action.get("kind") {
            set(&mut player_intent, "outcome", outcome.clone());
        }
        if js::is_true(intent.get("roleplay_speech")) {
            set(&mut player_intent, "roleplay_speech", Value::Bool(true));
        }
        if js::truthy(free_action.get("outcome_detail")) {
            set(&mut player_intent, "outcome_detail", str_value(text::head(&js::string(free_action.get("outcome_detail")), 300)));
        }
        if js::truthy(free_action.get("thorough_search")) {
            set(&mut player_intent, "thorough_search", str_value(js::string(free_action.get("thorough_search"))));
        }
        let in_combat = js::truthy(at(Some(&state), &["mechanics", "combat", "active"]));
        if !in_combat {
            if let Some(spell) = named_known_spell(Some(&message_value), Some(&state), Some(&str_value(player_id))) {
                set(&mut player_intent, "spell_cast", json!({ "name": text::head(&spell.name, 120) }));
            }
        }
        let mut environment = json!({
            "context_metadata": agent_context_metadata(&state, &AgentContextOptions { role: Some(&str_value("narrator")), actor_id: Some(&str_value(player_id)), target_id: None, contract_version: Some(&str_value(NARRATOR_PROMPT_VERSION)) }),
            "scene": scene_context_for_agent(&state, Some(&str_value(player_id))),
            "campaign_premise": campaign_concept_for_agent(&state, None),
            "player_intent": player_intent,
            "structured_result": obj(vec![("outcome", free_action.get("kind").cloned()), ("event_types", Some(Value::Array(public_events.iter().map(|event| event.get("event_type").cloned().unwrap_or(Value::Null)).collect())))]),
            "world_clock": world_clock_for_agents(&state, Some(&str_value(player_id))),
            "scene_canon": scene_canon_for(&state, Some(&json!({ "playerId": nullish(viewer.get("playerId"), None).cloned().unwrap_or_else(|| str_value(player_id)), "actorId": player_id }))),
            "world_memory": { "facts": narration_world_facts(&state, viewer, message, &public_events) },
            "story_context": story_context.clone(),
        });
        if let Some(scenario) = narration_scenario_context(&state) {
            js::assign(&mut environment, scenario);
        }
        set(&mut environment, "social_consequences", Value::Array(narration_social_consequences(&public_events, &state)));
        let activity = get(reading, "activity_kind");
        let hero_deed = played_kind(&kind) && !in_combat && !(is_str(activity, "stealth") && kind != "check_failure");
        let social_target = (is_str(activity, "social") && js::truthy(get(reading, "target_id")) && (kind == "check_success" || kind == "check_failure")).then(|| SocialTarget { npc_id: get(reading, "target_id").cloned().unwrap_or(Value::Null), success: Some(kind == "check_success") });
        let mut details = vec![js::s(free_action.get("outcome_detail"))];
        details.extend(discovery_detail_texts(&public_events));
        let reactions = with_detail_reactions(narration_npc_reactions(list(story_context.get("present_npcs")), &public_events, hero_deed, social_target.as_ref()), &details);
        let brief = build_narration_brief(Some(&json!({
            "visible_events": public_events,
            "visible_state_changes": visible_changes(&public_events),
            "known_environment": environment,
            "permitted_npc_reactions": reactions,
            "narration_constraints": constraints,
            "viewer": viewer,
        })))
        .map_err(security_error)?;
        let candidate_narration = text::trim(&js::s(free_action.get("narration"))).to_string();
        let mut rendered_narration = String::new();
        let mut rendered_provider = String::new();
        let mut rendered_verification: Option<Value> = None;
        let mut rendered_prompt_version: Value = Value::Null;
        let mut rendered_failure_reason = String::new();
        let mut rendered_elapsed_ms: i64 = 0;
        let roleplay_speech = js::is_true(intent.get("roleplay_speech"));
        let unconfirmed_passage = !roleplay_speech && unconfirmed_free_action_passage(&free_action, message, &public_events, &state);
        let narrate_committed_improvisation = !js::truthy(free_action.get("duplicate"))
            && !unconfirmed_passage
            && (!is_str(get(reading, "source"), "deterministic-trivial") || roleplay_speech)
            && played_kind(&kind)
            && !committed_events.is_empty()
            && self.narrator.is_some();
        if narrate_committed_improvisation {
            let render_started = self.now_ms();
            let outcome = match (&self.narrator, self.recent_narrations_for(campaign_id)) {
                (Some(narrator), Ok(recent)) => narrator.render(&brief, NarrationOptions { known_rule_ids: Vec::new(), recent_narrations: recent, on_progress: None }).await,
                (_, Err(error)) => Err(error),
                (None, _) => Err(type_error("narrator.render is not a function")),
            };
            match outcome {
                Ok(rendered) => {
                    rendered_narration = text::trim(&js::s(rendered.get("narration"))).to_string();
                    rendered_provider = text::trim(&js::s(rendered.get("provider"))).to_string();
                    rendered_verification = rendered.get("verification").filter(|value| value.is_object() || value.is_array()).cloned();
                    rendered_prompt_version = nullish(rendered.get("prompt_version"), None).cloned().unwrap_or(Value::Null);
                }
                Err(_) => rendered_failure_reason = "provider_error".into(),
            }
            rendered_elapsed_ms = (self.now_ms() - render_started).max(0);
        }
        let narration_state = campaign_state_for_viewer(Some(&state), Some(viewer), Some(&str_value(player_id))).map_err(projection_error)?.unwrap_or_else(|| json!({}));
        let deterministic_text = deterministic_free_action_narration(&free_action, message, &public_events, &narration_state, unconfirmed_passage, roleplay_speech)?;
        let deterministic_provider = text::test(re!(r"^deterministic(?:-|$)", "u"), &rendered_provider);
        let first_nonempty = |options: [&String; 3]| options.into_iter().find(|text| !text.is_empty()).cloned().unwrap_or_default();
        let preferred = if deterministic_provider || unconfirmed_passage { first_nonempty([&deterministic_text, &candidate_narration, &rendered_narration]) } else { first_nonempty([&rendered_narration, &candidate_narration, &deterministic_text]) };
        let candidate_verification = verify_text(&preferred, &brief, &[])?;
        let mut grounded_parts = free_action_effect_text(&public_events, &narration_state)?;
        grounded_parts.push(free_action_time_text(&public_events));
        let grounded = grounded_parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        let grounded_valid = if grounded.is_empty() { false } else { js::truthy(verify_text(&grounded, &brief, &[])?.get("valid")) };
        let candidate_valid = js::truthy(candidate_verification.get("valid"));
        let rejected: Vec<Value> = if !preferred.is_empty() && !candidate_valid { list(candidate_verification.get("violations")).to_vec() } else { Vec::new() };
        let mut repaired_from: Vec<Value> = Vec::new();
        for entry in safe_narration_violations(get(rendered_verification.as_ref(), "repaired_from")).into_iter().chain(safe_narration_violations(Some(&Value::Array(rejected)))) {
            if !repaired_from.iter().any(|seen| js::stringify(seen) == js::stringify(&entry)) {
                repaired_from.push(entry);
            }
        }
        let provider_error = safe_narration_provider_error(get(rendered_verification.as_ref(), "provider_error"));
        let mut fallbacks: Vec<String> = Vec::new();
        if played_kind(&kind) {
            fallbacks.push(deterministic_text.clone());
            if !roleplay_speech {
                fallbacks.push(free_action_unchanged_scene_narration(&free_action, message, &public_events, &narration_state));
            }
        }
        let mut verified_fallback = String::new();
        for candidate in &fallbacks {
            if !candidate.is_empty() && *candidate != preferred && js::truthy(verify_text(candidate, &brief, &[])?.get("valid")) {
                verified_fallback = candidate.clone();
                break;
            }
        }
        let chosen = if candidate_valid && !preferred.is_empty() {
            preferred.clone()
        } else if !verified_fallback.is_empty() {
            verified_fallback
        } else if grounded_valid {
            grounded
        } else if kind == "clarification" || kind == "loot_inspection" {
            first_nonempty([&candidate_narration, &deterministic_text, &"Опишите действие подробнее, чтобы его можно было разрешить по правилам.".to_string()])
        } else if succeeded_kind(&kind) {
            "Вышло.".into()
        } else if kind == "check_failure" {
            "Не вышло.".into()
        } else {
            "Действие не получило подтверждённого последствия. Уточните, чего герой хочет добиться.".into()
        };
        let copy_note = free_action_copy_note(&free_action, message, &committed_events);
        let narration = if copy_note.is_empty() { chosen } else { format!("{chosen} {copy_note}") };
        let accepted = !deterministic_provider && !rendered_narration.is_empty() && rendered_narration == preferred && candidate_valid;
        let template_reason = match at(rendered_verification.as_ref(), &["origin"]) {
            Some(origin) if is_str(origin.get("source"), "template") => origin.get("reason").cloned().unwrap_or(Value::Null),
            _ => str_value(""),
        };
        let fallback_reason = if !repaired_from.is_empty() {
            str_value("verification_rejected")
        } else if !rendered_failure_reason.is_empty() {
            str_value(rendered_failure_reason.clone())
        } else if js::truthy(Some(&template_reason)) {
            template_reason
        } else if !narrate_committed_improvisation {
            str_value("no_provider")
        } else if rendered_narration.is_empty() {
            str_value("empty_response")
        } else {
            str_value("no_provider")
        };
        let mut verification = if accepted { rendered_verification.clone().unwrap_or_else(|| json!({})) } else { json!({}) };
        if !verification.is_object() {
            verification = js::spread(&verification, json!({}));
        }
        js::assign(&mut verification, verify_text(&narration, &brief, &[])?);
        if !repaired_from.is_empty() {
            set(&mut verification, "repaired_from", Value::Array(repaired_from));
        }
        if !provider_error.is_empty() {
            set(&mut verification, "provider_error", str_value(provider_error));
        }
        let response_plan = match get(rendered_verification.as_ref(), "response_plan") {
            Some(plan) if js::truthy(Some(plan)) => plan.clone(),
            _ => narrator_response_plan(&brief),
        };
        set(&mut verification, "response_plan", response_plan);
        let origin = if accepted {
            let source = at(rendered_verification.as_ref(), &["origin"]);
            let mut origin = if js::truthy(source) { js::spread(source.unwrap_or(&Value::Null), json!({})) } else { json!({}) };
            let elapsed = js::number(get(source, "elapsed_ms"));
            set(&mut origin, "source", str_value("llm"));
            set(&mut origin, "reason", str_value("generated"));
            set(&mut origin, "elapsed_ms", if elapsed.is_finite() { js::num(elapsed) } else { Value::from(rendered_elapsed_ms) });
            origin
        } else {
            let mut origin = json!({ "source": "template", "reason": fallback_reason, "elapsed_ms": rendered_elapsed_ms });
            if !rendered_provider.is_empty() {
                set(&mut origin, "upstream", str_value(text::head(&rendered_provider, 80)));
            }
            origin
        };
        set(&mut verification, "origin", origin);
        let prompt_version = if accepted && js::truthy(Some(&rendered_prompt_version)) { rendered_prompt_version } else { str_value("deterministic-free-action/v1") };
        let provider = if accepted { rendered_provider.clone() } else { "deterministic-free-action".into() };
        let idempotent_replay = js::truthy(free_action.get("duplicate"));
        let rolls = nullish(free_action.get("rolls"), None).cloned().unwrap_or_else(|| json!([]));
        let visible = project_visible_state(Some(&Value::Array(visible_changes(&public_events))), Some(viewer), None).unwrap_or_else(|| json!([]));
        let mut response = obj(vec![
            ("narration", Some(str_value(narration.clone()))),
            ("effects", Some(events_to_client_effects(&committed_events, list(Some(&rolls))))),
            ("provider", Some(str_value(provider.clone()))),
            ("prompt_version", Some(prompt_version.clone())),
            ("model", Some(str_value("server-policy"))),
            ("turn_id", Some(str_value(turn_id))),
            ("engine_mode", Some(str_value("enforce"))),
            ("state_version", state.get("state_version").cloned()),
            ("mechanics", Some(Value::Array(committed_events.clone()))),
            ("visible_state_changes", Some(visible)),
            ("authoritative_state", Some(state.clone())),
            ("verification", Some(verification.clone())),
            ("ruling", Some(nullish(free_action.get("ruling"), None).cloned().unwrap_or(Value::Null))),
        ]);
        if js::truthy(free_action.get("stakes")) {
            set(&mut response, "stakes", free_action["stakes"].clone());
        }
        set(&mut response, "explanation_url", str_value(explanation_url(campaign_id, turn_id)));
        set(&mut response, "idempotent_replay", Value::Bool(idempotent_replay));
        set(&mut response, "turn_consumed", Value::Bool(false));
        set(&mut response, "action_kind", str_value("free"));
        set(&mut response, "request_kind", str_value("action"));
        set(&mut response, "free_action_outcome", free_action.get("kind").cloned().unwrap_or(Value::Null));
        if js::truthy(free_action.get("rejected")) {
            set(&mut response, "rejected", Value::Bool(true));
        }
        if let Some(action) = resolved_action {
            set(&mut response, "resolved_action", str_value(action));
        }
        if is_str(at(Some(&free_action), &["route_hint", "route"]), "talk") && js::truthy(at(Some(&free_action), &["route_hint", "npc_hint"])) {
            set(&mut response, "route_hint", json!({ "route": "talk", "npc_hint": js::string(at(Some(&free_action), &["route_hint", "npc_hint"])) }));
        }
        if kind == "clarification" || kind == "counter_offer" {
            let pending_intent = if js::truthy(free_action.get("confirmation_required")) { with(intent, json!({ "pending_step": "proposal" })) } else { intent.clone() };
            let question = if narration.is_empty() { "Уточните, как именно герой хочет поступить.".to_string() } else { narration.clone() };
            let request = obj(vec![
                ("campaignId", Some(str_value(campaign_id))),
                ("actorId", Some(str_value(player_id))),
                ("stateVersion", state.get("state_version").cloned()),
                ("action", Some(str_value(message))),
                ("question", Some(str_value(question))),
                ("intent", Some(pending_intent)),
            ]);
            let clarification = self.clarifications().create(&request).map_err(registry_error)?;
            set(&mut response, "clarification", clarification);
        }
        let mut trace_plan = js::spread(plan, json!({}));
        set(&mut trace_plan, "proposed_commands", nullish(free_action.get("commands"), None).cloned().unwrap_or_else(|| json!([])));
        set(&mut trace_plan, "ruling_required", Value::Bool(js::truthy(free_action.get("ruling"))));
        set(&mut trace_plan, "ruling_draft", nullish(free_action.get("ruling"), None).cloned().unwrap_or(Value::Null));
        set(&mut trace_plan, "narration_constraints", Value::Array(constraints));
        if js::truthy(free_action.get("context_metadata")) {
            set(&mut trace_plan, "agent_contexts", json!([free_action["context_metadata"].clone()]));
        }
        let trace = TraceInput {
            turn_id: turn_id.into(),
            campaign_id: campaign_id.into(),
            idempotency_key: Some(idempotency_key.into()),
            request_fingerprint,
            intent: Some(intent.clone()),
            retrieval_queries: Some(retrieval_queries.clone()),
            retrieved_rules: Some(retrieved_rules.clone()),
            plan: trace_plan,
            engine_result: Some(json!({ "commands": nullish(free_action.get("commands"), None).cloned().unwrap_or_else(|| json!([])), "events": committed_events.clone(), "rolls": rolls })),
            aliases: TraceAliases { commands: if nullish(free_action.get("commands"), None).is_some() { CommandsAlias::Whole } else { CommandsAlias::None }, ruling: true, ruling_spread: true, ..TraceAliases::default() },
            state_before: authoritative_state.get("state_version").cloned(),
            state_after: state.get("state_version").cloned(),
            verification: Some(verification.clone()),
            latency: Value::from(self.now_ms() - started),
            narration: Some(json!({ "narration": narration, "verification": verification, "prompt_version": prompt_version, "provider": provider })),
            ruling: Some(nullish(free_action.get("ruling"), None).cloned().unwrap_or(Value::Null)),
            ..TraceInput::default()
        };
        if !idempotent_replay {
            if !committed_events.is_empty() {
                self.remember_narration(campaign_id, &narration)?;
            }
            self.save_trace(trace, false)?;
        } else {
            self.recover_missing_trace(trace);
        }
        Ok(response)
    }

    /// `voiceLore(lore, { message, state, playerId })`: пересказ материала
    /// Хранителя голосом ведущего; сам материал наружу не уходит.
    async fn voice_lore(&self, lore: Option<Value>, message: &str, state: &Value, player_id: &str) -> OrchestratorResult<Option<Value>> {
        let Some(lore) = lore.filter(|lore| js::truthy(Some(lore))) else { return Ok(None) };
        let material = lore.get("lore_material").cloned();
        let mut answer = js::spread(&lore, json!({}));
        unset(&mut answer, "lore_material");
        let Some(voice) = self.lore_voice.as_ref().filter(|_| js::truthy(material.as_ref())) else { return Ok(Some(answer)) };
        let hero = list(state.get("players")).iter().find(|player| js::string(get(Some(player), "id")) == player_id);
        let input = json!({
            "question": message,
            "material": material,
            "location": js::s(at(Some(state), &["scene", "location"])),
            "hero": js::s(coalesce(&[get(hero, "character"), get(hero, "name")])),
        });
        Ok(Some(match voice.retell(&input).await? {
            Some(voiced) if js::truthy(Some(&voiced)) => with(
                &answer,
                obj(vec![("narration", Some(voiced.get("narration").cloned().unwrap_or(Value::Null))), ("prompt_version", Some(voiced.get("prompt_version").cloned().unwrap_or(Value::Null))), ("lore_voiced", Some(Value::Bool(true)))]),
            ),
            _ => answer,
        }))
    }

    /// `nonActionResponse({ … })`: вопрос и обсуждение не трогают Rules Engine.
    #[allow(clippy::too_many_arguments)] // параметры объекта JS `nonActionResponse({ … })`
    async fn non_action_response(&self, campaign_id: &str, player_id: &str, request_kind: &str, message: &str, pending_clarification: Option<&Value>, question_check_id: &str, question_proposal_id: &str, state: &Value, turn_id: &str, viewer: &Value, idempotency_key: &str, started: i64) -> OrchestratorResult<Value> {
        let is_question = request_kind == "question";
        let mut lore = if is_question { self.voice_lore(answer_known_lore(message, state, &KnownLoreOptions { viewer: Some(viewer.clone()), actor_id: None }), message, state, player_id).await? } else { None };
        let mut pending: Option<Value> = pending_clarification.filter(|value| js::truthy(Some(value))).map(|pending| {
            let mut entry = obj(vec![
                ("id", pending.get("id").cloned()),
                ("campaign_id", pending.get("campaign_id").cloned()),
                ("actor_id", pending.get("actor_id").cloned()),
                ("state_version", pending.get("state_version").cloned()),
                ("action", pending.get("action").cloned()),
                ("question", pending.get("question").cloned()),
            ]);
            if len_of(at(Some(pending), &["original_intent", "action_steps"])) > 0 || is_str(at(Some(pending), &["original_intent", "pending_step"]), "proposal") {
                set(&mut entry, "confirmation_required", Value::Bool(true));
            }
            entry
        });
        let mut check_answer = String::new();
        if is_question && !question_check_id.is_empty() {
            if let Some(registry) = &self.roll_registry {
                match registry.get_check(question_check_id, &json!({ "campaignId": campaign_id, "actorId": player_id, "includeContext": true })) {
                    Ok(check) => {
                        let proposal = at(Some(&check), &["context", "proposal"]).filter(|value| !value.is_null());
                        let label = template(check.get("label"));
                        let difficulty = template(check.get("difficulty"));
                        let answer = match proposal.filter(|value| js::truthy(Some(value))) {
                            Some(proposal) => {
                                let part = |key: &str, fallback: &str| trim_sentence_end(Some(nullish(proposal.get(key), None).unwrap_or(&str_value(fallback))), 500);
                                format!(
                                    "Карточка готова: {label}, СЛ {difficulty}. Цена: {}. При успехе: {}. При провале: {}.",
                                    part("cost", "указана на карточке"),
                                    part("on_success", "подтверждённый результат"),
                                    part("on_failure", "последствие указано на карточке")
                                )
                            }
                            None => format!("Карточка готова: {label}, СЛ {difficulty}. Сначала подтвердите или измените способ действия, затем бросок будет принят только для этой заявки."),
                        };
                        let skill = coalesce(&[check.get("skill"), at(Some(&check), &["context", "reading", "skill"]), at(Some(&check), &["context", "skill"])]);
                        let explained = explain_action_check(&obj(vec![("ability", check.get("ability").cloned()), ("skill", skill.cloned())]));
                        check_answer = format!("{explained} {answer}");
                    }
                    Err(error) => {
                        if !matches!(error.code(), Some("CHECK_NOT_FOUND" | "CHECK_INVALIDATED")) {
                            return Err(error);
                        }
                        check_answer = "Эта карточка уже устарела или отменена. Измените заявку и получите новое предложение; старый бросок не исполнится.".into();
                    }
                }
            }
        }
        if is_question && !question_proposal_id.is_empty() && check_answer.is_empty() {
            let request = obj(vec![("campaignId", Some(str_value(campaign_id))), ("actorId", Some(str_value(player_id))), ("stateVersion", state.get("state_version").cloned())]);
            let found = self.clarifications().get_proposal(Some(&str_value(question_proposal_id)), &request);
            match found {
                Ok(entry) => {
                    let proposal = nullish(entry.get("proposal"), None).cloned().unwrap_or_else(|| json!({}));
                    let field = |key: &str, fallback: &str| match nullish(proposal.get(key), None) {
                        Some(value) => js::string(Some(value)),
                        None => fallback.to_string(),
                    };
                    check_answer = format!("Предложение «{}»: цена — {}; результат — {}", text::head(&field("title", "действие"), 180), field("cost", "указана на карточке"), field("consequence", "определяется после подтверждения"));
                }
                Err(error) => {
                    if !["PROPOSAL_NOT_FOUND", "PROPOSAL_REVOKED", "PROPOSAL_STALE"].contains(&error.code.as_str()) {
                        return Err(registry_error(error));
                    }
                    check_answer = "Предложение уже устарело. Получите новую карточку после изменения заявки; старый маршрут не будет исполнен.".into();
                }
            }
        }
        let mut recent = self.clarifications().recent_dialogue(&json!({ "campaignId": campaign_id, "actorId": player_id })).map_err(registry_error)?;
        recent.reverse();
        let lore_narration = |lore: &Option<Value>| js::truthy(get(lore.as_ref(), "narration"));
        if is_question && !lore_narration(&lore) && check_answer.is_empty() && pending.is_none() {
            let world_clock = if js::truthy(at(Some(state), &["weather", "weather"])) {
                let weather = state.get("weather");
                obj(vec![
                    ("clock", get(weather, "clock").cloned()),
                    ("time_of_day_label", get(weather, "phase_label").cloned()),
                    ("weather_label", get(weather, "weather_label").cloned()),
                    ("weather_summary", get(weather, "weather_summary").cloned()),
                    ("indoors", get(weather, "indoors").cloned()),
                ])
            } else {
                world_clock_for_agents(state, Some(&str_value(player_id)))
            };
            if let Some(table) = answer_table_question(message, state, Some(&world_clock)) {
                if js::truthy(table.get("narration")) {
                    lore = Some(table);
                }
            }
        }
        let last_action = |recent: &[Value]| recent.last().and_then(|entry| nullish(entry.get("action"), None)).cloned();
        let discussed = if is_question && !lore_narration(&lore) && check_answer.is_empty() {
            let action = match get(pending.as_ref(), "action").filter(|value| !value.is_null()).cloned().or_else(|| last_action(&recent)) {
                Some(value) => js::s(Some(&value)),
                None => String::new(),
            };
            Some(self.action_adjudicator.discuss(state, player_id, message, action, recent.clone()).await?)
        } else {
            None
        };
        if pending.is_none() && js::truthy(get(discussed.as_ref(), "proposed_action")) {
            let request = obj(vec![
                ("campaignId", Some(str_value(campaign_id))),
                ("actorId", Some(str_value(player_id))),
                ("stateVersion", state.get("state_version").cloned()),
                ("action", get(discussed.as_ref(), "proposed_action").cloned()),
                ("question", get(discussed.as_ref(), "narration").cloned()),
                ("intent", Some(json!({ "pending_step": "proposal" }))),
            ]);
            pending = Some(self.clarifications().create(&request).map_err(registry_error)?);
        }
        let narration = if request_kind == "discussion" {
            String::new()
        } else if lore_narration(&lore) {
            let text_value = template(get(lore.as_ref(), "narration"));
            if pending.is_some() {
                format!("{text_value} Заявка всё ещё ждёт уточнения и не выполнена.")
            } else {
                text_value
            }
        } else if !check_answer.is_empty() {
            check_answer.clone()
        } else if js::truthy(get(discussed.as_ref(), "narration")) {
            template(get(discussed.as_ref(), "narration"))
        } else if pending.is_some() {
            "Уточнение относится к заявке, но само действие ещё не выполнено. Ответьте на вопрос карточки отдельной репликой.".into()
        } else {
            "По доступным подтверждённым сведениям точного ответа пока нет. Вопрос не расходует ход; узнайте это исследованием или у собеседника.".into()
        };
        if is_question {
            let action = get(pending.as_ref(), "action").filter(|value| !value.is_null()).cloned().or_else(|| last_action(&recent)).unwrap_or_else(|| str_value(message));
            let request = obj(vec![
                ("campaignId", Some(str_value(campaign_id))),
                ("actorId", Some(str_value(player_id))),
                ("question", Some(str_value(message))),
                ("answer", Some(str_value(narration.clone()))),
                ("action", Some(action)),
                ("stateVersion", state.get("state_version").cloned()),
            ]);
            self.clarifications().remember_dialogue(&request).map_err(registry_error)?;
        }
        let response_mode = if request_kind == "discussion" { "silence" } else { "table_talk" };
        let upstream = if request_kind == "discussion" {
            Some(str_value("party-chat"))
        } else {
            nullish(get(lore.as_ref(), "provider"), None)
                .cloned()
                .or_else(|| (!check_answer.is_empty()).then(|| str_value(if !question_check_id.is_empty() { "roll-registry" } else { "clarification-registry" })))
                .or_else(|| nullish(at(discussed.as_ref(), &["reading", "source"]), None).cloned())
                .or_else(|| Some(str_value(if discussed.is_some() { "action-adjudicator" } else if pending.is_some() { "clarification-registry" } else { "dialogue-policy" })))
        };
        let verification = dialogue_verification(response_mode, upstream.as_ref());
        let provider = nullish(get(lore.as_ref(), "provider"), None).cloned().unwrap_or_else(|| str_value("deterministic-dialogue"));
        let mut response = obj(vec![
            ("narration", Some(str_value(narration.clone()))),
            ("effects", Some(empty_effects())),
            ("provider", Some(provider.clone())),
            ("model", Some(nullish(get(lore.as_ref(), "model"), None).cloned().unwrap_or_else(|| str_value("server-policy")))),
            ("turn_id", Some(str_value(turn_id))),
            ("engine_mode", Some(str_value("enforce"))),
            ("state_version", state.get("state_version").cloned()),
            ("mechanics", Some(json!([]))),
            ("visible_state_changes", Some(json!([]))),
            ("check", Some(Value::Null)),
            ("action_proposal", Some(Value::Null)),
            ("turn_consumed", Some(Value::Bool(false))),
            ("action_kind", Some(str_value(request_kind))),
            ("request_kind", Some(str_value(request_kind))),
            ("verification", Some(verification.clone())),
        ]);
        if let Some(pending) = &pending {
            set(&mut response, "clarification", pending.clone());
        }
        if js::truthy(get(lore.as_ref(), "agent_context")) {
            set(&mut response, "agent_context", get(lore.as_ref(), "agent_context").cloned().unwrap_or(Value::Null));
        }
        set(&mut response, "idempotent_replay", Value::Bool(false));
        set(&mut response, "chat_message", str_value(message));
        if !campaign_id.is_empty() {
            set(&mut response, "room_id", str_value(campaign_id));
        }
        let exists = match &self.trace_store {
            Some(store) => store.get(campaign_id, turn_id)?.is_some_and(|trace| js::truthy(Some(&trace))),
            None => false,
        };
        if !exists {
            self.save_trace(
                TraceInput {
                    turn_id: turn_id.into(),
                    campaign_id: campaign_id.into(),
                    idempotency_key: Some(idempotency_key.into()),
                    intent: Some(json!({
                        "actor_id": player_id,
                        "intent": if request_kind == "discussion" { "table_talk" } else { "question" },
                        "approach": "deterministic",
                        "targets": [],
                        "mentioned_entities": [],
                        "missing_information": [],
                        "requires_clarification": pending.is_some(),
                        "confidence": 1,
                        "raw_message": message,
                    })),
                    retrieval_queries: Some(json!([])),
                    retrieved_rules: Some(json!({ "results": [], "confidence": 1, "count": 0 })),
                    plan: json!({ "rule_ids": [], "proposed_commands": [], "roll_requests": [], "ruling_required": false, "narration_constraints": ["dialogue-only", "no-world-change"], "confidence": 1 }),
                    engine_result: Some(json!({ "commands": [], "events": [], "rolls": [] })),
                    state_before: state.get("state_version").cloned(),
                    state_after: state.get("state_version").cloned(),
                    verification: Some(verification.clone()),
                    latency: Value::from(self.now_ms() - started),
                    narration: Some(json!({ "narration": narration, "verification": verification, "prompt_version": null, "provider": provider })),
                    ..TraceInput::default()
                },
                false,
            )?;
        }
        Ok(response)
    }

    /// `handle(input)`: ход игрока целиком — с переадресацией к собеседнику,
    /// ответом человека после заклинания и шагами плана; одинаковые
    /// параллельные запросы делят один итог.
    pub fn handle(&self, input: HandleInput) -> AgentFuture<'_, OrchestratorResult<Value>> {
        Box::pin(async move { self.handle_coalesced(input).await })
    }

    async fn handle_coalesced(&self, input: HandleInput) -> OrchestratorResult<Value> {
        let original_state = normalize_campaign_state(nullish(input.field("state"), None).unwrap_or(&json!({})))?;
        let head = RequestHead::read(&input, &original_state);
        let coalesces = !input.has_commands() && head.message != "/why" && !js::is_true(input.field("why")) && !head.campaign_id.is_empty() && !head.idempotency_key.is_empty();
        if !coalesces {
            return self.run_handle(input, &head, original_state).await;
        }
        let key = format!("{}\u{1f}{}", head.campaign_id, head.idempotency_key);
        let fingerprint = narration_request_fingerprint(&head.fingerprint(""));
        let existing = lock(&self.narration_inflight).get(&key).cloned();
        if let Some((stored, slot)) = existing {
            if stored != fingerprint {
                return Err(idempotency_conflict(&head.campaign_id, &head.idempotency_key));
            }
            let result = AwaitInflight(slot).await?;
            return Ok(with(&result, json!({ "idempotent_replay": true })));
        }
        let slot: SharedInflight = Arc::new(Mutex::new(InflightSlot { done: None, wakers: Vec::new() }));
        lock(&self.narration_inflight).insert(key.clone(), (fingerprint, slot.clone()));
        let guard = InflightGuard { owner: self, key, slot };
        let result = self.run_handle(input, &head, original_state).await;
        guard.finish(result.clone());
        result
    }

    /// Тело `run` из `handle`.
    /// `original_state` — `normalizeCampaignState(input.state)`, уже
    /// посчитанное для заголовка запроса: `_handle` берёт его, а не
    /// нормализует тот же вход второй раз (урок 4).
    async fn run_handle(&self, input: HandleInput, head: &RequestHead, original_state: Value) -> OrchestratorResult<Value> {
        let result = self.handle_turn(input.clone(), original_state).await?;
        let talk_npc_id = if is_str(at(Some(&result), &["route_hint", "route"]), "talk") { js::s(at(Some(&result), &["route_hint", "npc_hint"])) } else { String::new() };
        let redirected = js::is_true(input.field("routeRedirect"));
        if !talk_npc_id.is_empty() && self.npc_social_controller.is_some() && head.npc_id.is_empty() && !redirected && head.request_kind == "action" && !input.has_commands() {
            let next = input.plan_step().with(vec![("message", str_value(head.message.clone())), ("npcId", str_value(talk_npc_id)), ("idempotencyKey", str_value(format!("{}:talk", head.idempotency_key))), ("routeRedirect", Value::Bool(true))]);
            return self.handle(next).await;
        }
        let spell_reply = if head.clarification_id.is_empty()
            && head.npc_id.is_empty()
            && head.request_kind == "action"
            && !input.has_commands()
            && !redirected
            && self.npc_social_controller.is_some()
            && len_of(result.get("mechanics")) > 0
            && !js::truthy(result.get("check"))
            && !js::truthy(result.get("clarification"))
            && !js::truthy(result.get("action_proposal"))
            && !js::is_true(at(Some(&result), &["authoritative_state", "mechanics", "combat", "active"]))
        {
            let state = nullish(result.get("authoritative_state"), input.field("state")).cloned().unwrap_or(Value::Null);
            spell_speech_follow_up(&head.message, &state, &head.player_id).map(|reply| (reply, state))
        } else {
            None
        };
        if let Some((reply, state)) = spell_reply {
            let preceding = joined_step(&head.message, result.get("narration"));
            let next = input.plan_step().with(vec![
                ("state", state),
                ("message", str_value(reply.speech)),
                ("npcId", str_value(reply.npc_id)),
                ("idempotencyKey", str_value(format!("{}:reply", head.idempotency_key))),
                ("routeRedirect", Value::Bool(true)),
                ("precedingStep", str_value(preceding)),
            ]);
            let replied = self.handle(next).await?;
            return Ok(merge_plan_step_results(&result, &replied));
        }
        if head.clarification_id.is_empty() || head.request_kind != "action" {
            return Ok(result);
        }
        let scope = json!({ "campaignId": head.campaign_id, "actorId": head.player_id });
        let pending = self.clarifications().resolve(Some(&str_value(head.clarification_id.clone())), &scope).map_err(registry_error)?;
        if len_of(result.get("mechanics")) > 0 && !js::truthy(result.get("check")) && !js::truthy(result.get("action_proposal")) {
            self.clarifications().complete(Some(&str_value(head.clarification_id.clone())), &scope).map_err(registry_error)?;
        }
        let steps = list(at(Some(&pending), &["original_intent", "action_steps"])).to_vec();
        let step_text = if !steps.is_empty() && is_str(steps.first(), &head.message) { head.message.clone() } else { merge_clarification_action(&pending, &head.message) };
        if steps.is_empty() || !is_str(steps.first(), &step_text) {
            return Ok(result);
        }
        if js::truthy(result.get("check")) {
            let check = with(&result["check"], json!({ "clarification_id": head.clarification_id }));
            return Ok(with(&result, json!({ "check": check })));
        }
        if len_of(result.get("mechanics")) == 0 || js::truthy(result.get("clarification")) || js::truthy(result.get("action_proposal")) || steps.len() < 2 {
            return Ok(result);
        }
        let depth = js::number(Some(nullish(input.field("planStep"), None).unwrap_or(&Value::from(0))));
        let next_key = format!("{}:step-{}", head.idempotency_key, js::f64_string(depth + 2.0));
        let next_replay = self.by_key(&head.campaign_id, &next_key)?;
        if js::truthy(result.get("idempotent_replay")) && list(get(next_replay.as_ref(), "events")).is_empty() {
            let latest = self.event_store.load(&head.campaign_id)?;
            if (latest.state_version as f64) > js::number(result.get("state_version")) {
                return Ok(result);
            }
        }
        let failed = list(result.get("mechanics")).iter().any(|event| is_str(event.get("event_type"), "AbilityCheckResolved") && js::is_false(at(Some(event), &["payload", "success"])));
        if failed {
            return Ok(result);
        }
        let rest: Vec<Value> = steps[1..].to_vec();
        let state_version = coalesce(&[list(get(next_replay.as_ref(), "events")).first().and_then(|event| event.get("state_version_before")), result.get("state_version")]).cloned();
        let request = obj(vec![
            ("campaignId", Some(str_value(head.campaign_id.clone()))),
            ("actorId", Some(str_value(head.player_id.clone()))),
            ("stateVersion", state_version),
            ("action", Some(str_value(rest.iter().map(|step| js::s(Some(step))).collect::<Vec<_>>().join("; затем ")))),
            ("question", Some(str_value(format!("Дальше по плану: «{}».", template(rest.first()))))),
            ("intent", Some(json!({ "action_steps": rest }))),
        ]);
        let next = self.clarifications().create(&request).map_err(registry_error)?;
        if depth >= PLAN_STEP_LIMIT {
            return Ok(with(&result, json!({ "clarification": next })));
        }
        let state = nullish(result.get("authoritative_state"), input.field("state")).cloned().unwrap_or(Value::Null);
        let preceding = joined_step(&step_text, result.get("narration"));
        let continued_input = input.plan_step().with(vec![
            ("state", state),
            ("message", str_value("Да")),
            ("clarificationId", next.get("id").cloned().unwrap_or(Value::Null)),
            ("idempotencyKey", str_value(next_key)),
            ("planStep", js::num(depth + 1.0)),
            ("precedingStep", str_value(preceding)),
        ]);
        let continued = self.handle(continued_input).await?;
        Ok(merge_plan_step_results(&result, &continued))
    }

    fn by_key(&self, campaign_id: &str, key: &str) -> OrchestratorResult<Option<Value>> {
        Ok(self.event_store.get_by_idempotency_key(campaign_id, key)?.map(|commit| commit.to_json()))
    }

    /// Состояние журнала: голова хранилища уже нормализована (урок 4).
    fn load_state(&self, campaign_id: &str) -> OrchestratorResult<(NormalizedState, i64)> {
        let loaded = self.event_store.load(campaign_id)?;
        Ok((NormalizedState::from_loaded(&loaded)?, loaded.state_version))
    }

    fn commit(&self, campaign_id: &str, expected: Option<&Value>, key: &str, events: Vec<Value>) -> Result<CommitResult, StoreError> {
        self.event_store.commit(CommitRequest { campaign_id: campaign_id.into(), expected_state_version: js::safe_int(expected, 0), idempotency_key: key.into(), command_id: Some(key.into()), events, ..CommitRequest::default() })
    }

    fn check_response(narration: String, turn_id: &str, state: &Value, card: Value) -> Value {
        obj(vec![
            ("narration", Some(str_value(narration))),
            ("effects", Some(empty_effects())),
            ("provider", Some(str_value("RulesEngine"))),
            ("model", Some(str_value("deterministic"))),
            ("turn_id", Some(str_value(turn_id))),
            ("engine_mode", Some(str_value("enforce"))),
            ("state_version", state.get("state_version").cloned()),
            ("mechanics", Some(json!([]))),
            ("visible_state_changes", Some(json!([]))),
            ("authoritative_state", Some(state.clone())),
            ("check", Some(with(&card, json!({ "sides": 20 })))),
            ("turn_consumed", Some(Value::Bool(false))),
        ])
    }

    /// `verifiedRoll` без `context`: полезная нагрузка кубика для движка.
    fn roll_payload(verified_roll: &Value) -> (Option<Value>, Value) {
        let context = verified_roll.get("context").cloned();
        let mut payload = js::spread(verified_roll, json!({}));
        unset(&mut payload, "context");
        (context, payload)
    }

    /// `_handle(input)`.
    async fn handle_turn(&self, mut input: HandleInput, original_state: Value) -> OrchestratorResult<Value> {
        let prelude_span = sk_store::perf::span("orch.handle_turn.prelude");
        let started = self.now_ms();
        let request_operation = request_operation_for(&input.fields);
        let head = RequestHead::read(&input, &original_state);
        let campaign_id = head.campaign_id.clone();
        let player_id = head.player_id.clone();
        let raw_message = head.message.clone();
        let request_kind = head.request_kind.clone();
        let clarification_id = head.clarification_id.clone();
        let scope = json!({ "campaignId": campaign_id, "actorId": player_id });
        let mut pending_clarification = if clarification_id.is_empty() { None } else { Some(self.clarifications().resolve(Some(&str_value(clarification_id.clone())), &scope).map_err(registry_error)?) };
        let mut standalone_action = false;
        if pending_clarification.is_some() && request_kind == "action" && !input.has_commands() {
            standalone_action = match self.intent_parser.parse(&raw_message, &player_id, &original_state).await {
                Ok(candidate) => standalone_action_reading(&raw_message, &candidate),
                Err(_) => false,
            };
        }
        let message = match &pending_clarification {
            Some(pending) if request_kind == "action" && !standalone_action => merge_clarification_action(pending, &raw_message),
            _ => raw_message.clone(),
        };
        let idempotency_key = match input.either("idempotencyKey", "idempotency_key") {
            Some(key) => js::s(Some(key)),
            None => (self.id_factory)(),
        };
        let explicit_npc_id = head.npc_id.clone();
        let user = nullish(input.field("user"), None).cloned().unwrap_or_else(|| json!({}));
        let role = at(Some(&user), &["role"]).cloned();
        let is_admin = is_str(role.as_ref(), "admin");
        let mut rules_context = json!({
            "allowedActorIds": nullish(input.field("allowedActorIds"), None).cloned().unwrap_or_else(|| json!([player_id])),
            "isAdmin": is_admin,
            "isDirector": input.director_capability,
        });
        let mut turn_id = structured_command_turn_id(&campaign_id, &idempotency_key);
        let manual_roll = js::is_true(input.field("manualRoll"));
        let verified_roll = nullish(input.field("verifiedRoll"), None).cloned();

        if message == "/why" || js::is_true(input.field("why")) {
            let viewer = obj(vec![("playerId", Some(str_value(player_id.clone()))), ("isPartyMember", Some(Value::Bool(true))), ("role", role.clone())]);
            let raw = self.explanation(&campaign_id, input.either("turnId", "turn_id"), &viewer)?;
            let explanation = turn_explanation_for_viewer(Some(&raw), Some(&user), Some(&str_value(player_id.clone())), Some(&original_state)).map_err(projection_error)?.unwrap_or(Value::Null);
            let resolver = actor_name_resolver(&original_state);
            return Ok(obj(vec![
                ("narration", Some(str_value(why_narration(Some(&explanation), &resolver)))),
                ("effects", Some(empty_effects())),
                ("provider", Some(str_value("RulesEngine"))),
                ("model", Some(str_value("deterministic"))),
                ("engine_mode", Some(str_value("enforce"))),
                ("turn_id", Some(nullish(get(Some(&explanation), "turn_id"), None).cloned().unwrap_or(Value::Null))),
                ("state_version", original_state.get("state_version").cloned()),
                ("explanation", Some(explanation)),
                ("turn_consumed", Some(Value::Bool(false))),
            ]));
        }

        let viewer = obj(vec![
            ("playerId", Some(str_value(player_id.clone()))),
            ("partyIds", Some(nullish(input.field("partyIds"), None).cloned().unwrap_or_else(|| json!([])))),
            ("isPartyMember", Some(Value::Bool(true))),
            ("role", role.clone()),
        ]);
        let mut visible_state = campaign_state_for_viewer(Some(&original_state), Some(&user), Some(&str_value(player_id.clone()))).map_err(projection_error)?.unwrap_or_else(|| json!({}));
        let social_options = json!({ "playerId": player_id, "isAdmin": is_admin, "isPartyMember": true, "state": original_state });
        let ensured = ensure_npc_social_state(original_state.get("social").unwrap_or(&Value::Null), &original_state, &json!({}));
        set(&mut visible_state, "social", npc_social_for_viewer(&ensured, &social_options));
        let worldkeeper_viewer = obj(vec![("playerId", Some(str_value(player_id.clone()))), ("isAdmin", Some(Value::Bool(is_admin))), ("isPartyMember", Some(Value::Bool(true))), ("role", role.clone())]);
        let mut worldkeeper_state = js::spread(&visible_state, json!({}));
        match original_state.get("worldMemory") {
            Some(memory) => set(&mut worldkeeper_state, "worldMemory", memory.clone()),
            None => unset(&mut worldkeeper_state, "worldMemory"),
        }
        let in_combat = js::is_true(at(Some(&original_state), &["mechanics", "combat", "active"]));
        let lore_answer = if request_kind != "action" || input.has_commands() || !explicit_npc_id.is_empty() || (in_combat && mentions_parley(&str_value(message.clone()))) {
            None
        } else {
            let known = answer_known_lore(&message, &worldkeeper_state, &KnownLoreOptions { viewer: Some(worldkeeper_viewer), actor_id: None });
            self.voice_lore(known, &message, &worldkeeper_state, &player_id).await?
        };
        if let Some(lore_answer) = lore_answer {
            let lore_intent = json!({
                "actor_id": player_id, "intent": "known_lore_query", "approach": "deterministic",
                "targets": [], "mentioned_entities": [], "missing_information": [],
                "requires_clarification": false, "confidence": 1, "raw_message": message,
            });
            let lore_plan = json!({ "rule_ids": [], "proposed_commands": [], "roll_requests": [], "ruling_required": false, "narration_constraints": ["known-world-facts-only"], "confidence": 1 });
            let verification = dialogue_verification("table_talk", lore_answer.get("provider"));
            let mut response = js::spread(&lore_answer, json!({ "engine_mode": "enforce", "turn_id": turn_id }));
            match original_state.get("state_version") {
                Some(version) => set(&mut response, "state_version", version.clone()),
                None => unset(&mut response, "state_version"),
            }
            set(&mut response, "verification", verification.clone());
            self.save_trace(
                TraceInput {
                    turn_id: turn_id.clone(),
                    campaign_id: campaign_id.clone(),
                    idempotency_key: Some(idempotency_key.clone()),
                    intent: Some(lore_intent),
                    retrieval_queries: Some(json!([])),
                    retrieved_rules: Some(json!({ "results": [], "confidence": 1, "count": 0 })),
                    plan: lore_plan,
                    state_before: original_state.get("state_version").cloned(),
                    state_after: original_state.get("state_version").cloned(),
                    verification: Some(verification.clone()),
                    latency: Value::from(self.now_ms() - started),
                    narration: Some(obj(vec![("narration", response.get("narration").cloned()), ("verification", Some(verification)), ("prompt_version", Some(Value::Null)), ("provider", response.get("provider").cloned())])),
                    ..TraceInput::default()
                },
                false,
            )?;
            return Ok(response);
        }
        let (authoritative_state, _) = self.load_state(&campaign_id)?;
        if request_kind != "action" {
            if let Some(pending) = &pending_clarification {
                if js::number(pending.get("state_version")) != js::number(authoritative_state.get("state_version")) {
                    pending_clarification = None;
                }
            }
        }
        if let Some(_pending) = pending_clarification.as_ref().filter(|_| request_kind == "action") {
            if standalone_action {
                self.clarifications().complete(Some(&str_value(clarification_id.clone())), &scope).map_err(registry_error)?;
            } else {
                let replay = self.by_key(&campaign_id, &idempotency_key)?;
                let version = coalesce(&[list(get(replay.as_ref(), "events")).first().and_then(|event| event.get("state_version_before")), authoritative_state.get("state_version")]).cloned();
                let request = obj(vec![("campaignId", Some(str_value(campaign_id.clone()))), ("actorId", Some(str_value(player_id.clone()))), ("stateVersion", version)]);
                self.clarifications().resolve(Some(&str_value(clarification_id.clone())), &request).map_err(registry_error)?;
            }
        }
        if request_kind != "action" {
            let non_action_state = campaign_state_for_viewer(Some(&authoritative_state), Some(&user), Some(&str_value(player_id.clone()))).map_err(projection_error)?.unwrap_or_else(|| json!({}));
            return self.non_action_response(&campaign_id, &player_id, &request_kind, &raw_message, pending_clarification.as_ref(), &head.question_check_id, &head.question_proposal_id, &non_action_state, &turn_id, &viewer, &idempotency_key, started).await;
        }
        let constraints = constraints_of(&message);
        let steps: Vec<String> = action_sequence(Some(&str_value(message.clone())))
            .into_iter()
            .map(|step| {
                let missing: Vec<String> = constraints.iter().map(|constraint| js::s(Some(constraint))).filter(|constraint| !step.contains(constraint.as_str())).collect();
                if missing.is_empty() {
                    step
                } else {
                    format!("{step}. Ограничение игрока: {}", missing.join("; "))
                }
            })
            .collect();
        let pending_steps = len_of(at(pending_clarification.as_ref(), &["original_intent", "action_steps"]));
        if !input.has_commands() && explicit_npc_id.is_empty() && !steps.is_empty() && (standalone_action || pending_steps == 0) {
            let first_step_key = format!("{idempotency_key}:step-1");
            let first_step_replay = self.by_key(&campaign_id, &first_step_key)?;
            let version = coalesce(&[list(get(first_step_replay.as_ref(), "events")).first().and_then(|event| event.get("state_version_before")), authoritative_state.get("state_version")]).cloned();
            let request = obj(vec![
                ("campaignId", Some(str_value(campaign_id.clone()))),
                ("actorId", Some(str_value(player_id.clone()))),
                ("stateVersion", version),
                ("action", Some(str_value(message.clone()))),
                ("question", Some(str_value(format!("Сначала: «{}».", steps[0])))),
                ("intent", Some(json!({ "action_steps": steps, "constraints": constraints }))),
            ]);
            let plan_entry = self.clarifications().create(&request).map_err(registry_error)?;
            let next = input.plan_step().with(vec![("message", str_value("Да")), ("clarificationId", plan_entry.get("id").cloned().unwrap_or(Value::Null)), ("idempotencyKey", str_value(first_step_key)), ("planStep", Value::from(0))]);
            return self.handle(next).await;
        }
        let supersedes_check_id = head.supersedes_check_id.clone();
        let supersedes_proposal_id = head.supersedes_proposal_id.clone();
        if !supersedes_proposal_id.is_empty() {
            self.clarifications().revoke_proposal(Some(&str_value(supersedes_proposal_id.clone())), &scope).map_err(registry_error)?;
        }
        if let Some(registry) = self.roll_registry.as_ref().filter(|_| !supersedes_check_id.is_empty() || !supersedes_proposal_id.is_empty()) {
            let edited = json!({ "campaignId": campaign_id, "actorId": player_id, "reason": "proposal-edited" });
            if !supersedes_check_id.is_empty() {
                registry.invalidate_check(&supersedes_check_id, &edited)?;
            }
            if !supersedes_proposal_id.is_empty() {
                if let Err(error) = registry.invalidate_proposal(&supersedes_proposal_id, &edited) {
                    if error.code() != Some("CHECK_NOT_FOUND") {
                        return Err(error);
                    }
                }
            }
        }
        let duplicate = self.by_key(&campaign_id, &idempotency_key)?;
        let idempotency_request = RequestFingerprint { message: message.clone(), operation: request_operation.clone(), ..head.fingerprint("") };
        let request_fingerprint = narration_request_fingerprint(&idempotency_request);
        let request_trace = match (&duplicate, &self.trace_store) {
            (Some(_), Some(store)) => store.get(&campaign_id, &turn_id)?,
            _ => None,
        };
        assert_narration_request_idempotency(duplicate.as_ref(), request_trace.as_ref(), &idempotency_request, &idempotency_key)?;

        // Парлей: единственная развилка на оба входа (хотбар и окрик).
        if let Some(mut parley_command) = self.parley_command_for(&input, &player_id, &message, &authoritative_state) {
            if manual_roll && verified_roll.is_none() && self.roll_registry.is_some() && duplicate.is_none() {
                if let Some(card) = self.parley_check_card(&campaign_id, &player_id, &authoritative_state, &parley_command)? {
                    let narration = format!("Требуется проверка: {}, СЛ {}. Бросьте d20, чтобы узнать, услышат ли вас.", template(card.get("label")), template(card.get("difficulty")));
                    return Ok(Self::check_response(narration, &turn_id, &authoritative_state, card));
                }
            }
            if let Some(roll) = &verified_roll {
                let (context, payload) = Self::roll_payload(roll);
                if js::s(get(context.as_ref(), "kind")) != "parley" {
                    return Err(context_mismatch("Этот бросок регистрировался не для переговоров"));
                }
                set(&mut parley_command, "verified_roll", payload);
            }
            input = input.with(vec![("commands", json!([parley_command]))]);
        }
        // Побег от стражи — тот же двухфазный ручной кубик.
        if let Some(index) = input.find_command(|candidate| js::s(get(Some(candidate), "command_type")) == "ResolveGuardEncounter" && js::s(get(Some(candidate), "resolution")) == "flee")? {
            let command = input.command_mut(index).cloned().unwrap_or(Value::Null);
            if manual_roll && verified_roll.is_none() && self.roll_registry.is_some() && duplicate.is_none() {
                if let Some(card) = self.guard_escape_check_card(&campaign_id, &player_id, &authoritative_state, &command)? {
                    let narration = format!("Требуется проверка: {}, СЛ {}. Бросьте d20, чтобы узнать, уйдёт ли отряд.", template(card.get("label")), template(card.get("difficulty")));
                    return Ok(Self::check_response(narration, &turn_id, &authoritative_state, card));
                }
            }
            if let Some(roll) = &verified_roll {
                let (context, payload) = Self::roll_payload(roll);
                if js::s(get(context.as_ref(), "kind")) != "guard-escape" {
                    return Err(context_mismatch("Этот бросок регистрировался не для побега от стражи"));
                }
                if let Some(target) = input.command_mut(index) {
                    set(target, "verified_roll", payload);
                }
            }
        }
        // Ответный бросок за костями.
        if let Some(index) = input.find_command(|candidate| js::s(get(Some(candidate), "command_type")) == "AnswerTavernDiceRound")? {
            let command = input.command_mut(index).cloned().unwrap_or(Value::Null);
            if manual_roll && verified_roll.is_none() && self.roll_registry.is_some() && duplicate.is_none() {
                if let Some(card) = self.tavern_dice_check_card(&campaign_id, &player_id, &authoritative_state, &command)? {
                    let narration = format!("Кость соперника на столе: нужно {} или больше. Бросайте.", template(card.get("difficulty")));
                    return Ok(Self::check_response(narration, &turn_id, &authoritative_state, card));
                }
            }
            if let Some(roll) = &verified_roll {
                let (context, payload) = Self::roll_payload(roll);
                if js::s(get(context.as_ref(), "kind")) != "tavern-dice" {
                    return Err(context_mismatch("Этот бросок регистрировался не для игры в кости"));
                }
                let registered = js::s(get(context.as_ref(), "approach"));
                if !TAVERN_DICE_APPROACHES.contains(&registered.as_str()) {
                    return Err(context_mismatch("Этот бросок регистрировался без подхода к игре: бросьте кость заново"));
                }
                let declared = match nullish(command.get("approach"), None) {
                    Some(approach) => js::string(Some(approach)),
                    None => registered.clone(),
                };
                if declared != registered {
                    return Err(context_mismatch("Подход к броску выбирается до кости, а не после: этот бросок регистрировался иначе"));
                }
                let actor = Self::actor_of(&command, &player_id);
                let round_id = tavern_round_for(&authoritative_state, &str_value(actor)).map(|round| round.id).unwrap_or_default();
                if js::s(get(context.as_ref(), "round_id")) != round_id {
                    return Err(context_mismatch("За столом уже другой раунд: этот бросок к нему не относится"));
                }
                if let Some(target) = input.command_mut(index) {
                    set(target, "approach", str_value(registered));
                    set(target, "verified_roll", payload);
                }
            }
        }
        // Молитва у святыни.
        if let Some(index) = input.find_command(|candidate| js::s(get(Some(candidate), "command_type")) == "OperateSceneObject" && js::s(get(Some(candidate), "intent")) == "pray")? {
            let command = input.command_mut(index).cloned().unwrap_or(Value::Null);
            if manual_roll && verified_roll.is_none() && self.roll_registry.is_some() && duplicate.is_none() {
                if let Some(card) = self.shrine_prayer_check_card(&campaign_id, &player_id, &authoritative_state, &command)? {
                    let narration = format!("Требуется проверка: {}, СЛ {}. Бросьте d20 — услышат ли молитву.", template(card.get("label")), template(card.get("difficulty")));
                    return Ok(Self::check_response(narration, &turn_id, &authoritative_state, card));
                }
            }
            if let Some(roll) = &verified_roll {
                let (context, payload) = Self::roll_payload(roll);
                Self::assert_shrine_prayer_roll_context(&command, context.as_ref())?;
                if let Some(target) = input.command_mut(index) {
                    set(target, "verified_roll", payload);
                }
            }
        }
        // Карманная кража.
        if let Some(index) = input.find_command(|candidate| js::s(get(Some(candidate), "command_type")) == "PickpocketNpc")? {
            let command = input.command_mut(index).cloned().unwrap_or(Value::Null);
            if manual_roll && verified_roll.is_none() && self.roll_registry.is_some() && duplicate.is_none() {
                if let Some(card) = self.pickpocket_check_card(&campaign_id, &player_id, &authoritative_state, &command)? {
                    let narration = format!("Требуется проверка: {}, СЛ {} ({}). Бросьте d20 — заметят ли руку.", template(card.get("label")), template(card.get("difficulty")), template(card.get("crowd_label")));
                    return Ok(Self::check_response(narration, &turn_id, &authoritative_state, card));
                }
            }
            if let Some(roll) = &verified_roll {
                let (context, payload) = Self::roll_payload(roll);
                Self::assert_pickpocket_roll_context(&command, context.as_ref())?;
                if let Some(target) = input.command_mut(index) {
                    set(target, "verified_roll", payload);
                }
            }
        }
        // Уговор зверя.
        if let Some(index) = input.find_command(|candidate| js::s(get(Some(candidate), "command_type")) == "CalmBeast")? {
            let command = input.command_mut(index).cloned().unwrap_or(Value::Null);
            if manual_roll && verified_roll.is_none() && self.roll_registry.is_some() && duplicate.is_none() {
                if let Some(card) = self.beast_taming_check_card(&campaign_id, &player_id, &authoritative_state, &command)? {
                    let narration = format!("Требуется проверка: {}, СЛ {}. Бросьте d20 — зверь смотрит и решает.", template(card.get("label")), template(card.get("difficulty")));
                    return Ok(Self::check_response(narration, &turn_id, &authoritative_state, card));
                }
            }
            if let Some(roll) = &verified_roll {
                let (context, payload) = Self::roll_payload(roll);
                Self::assert_beast_roll_context(&authoritative_state, &command, context.as_ref())?;
                if let Some(target) = input.command_mut(index) {
                    set(target, "verified_roll", payload);
                }
            }
        }
        drop(prelude_span);
        self.handle_planned(input, HandleContext {
            started,
            campaign_id,
            player_id,
            message,
            idempotency_key,
            explicit_npc_id,
            user,
            viewer,
            visible_state,
            original_state,
            authoritative_state,
            pending_clarification,
            standalone_action,
            rules_context: std::mem::take(&mut rules_context),
            turn_id: std::mem::take(&mut turn_id),
            manual_roll,
            verified_roll,
            duplicate,
            request_trace,
            idempotency_request,
            request_fingerprint,
        })
        .await
    }

    /// Вторая половина `_handle`: разбор намерения, план, разговор,
    /// исполнение, рассказ и трасса.
    async fn handle_planned(&self, input: HandleInput, context: HandleContext) -> OrchestratorResult<Value> {
        let HandleContext {
            started,
            campaign_id,
            player_id,
            message,
            idempotency_key,
            explicit_npc_id,
            user,
            viewer,
            visible_state,
            original_state,
            authoritative_state,
            pending_clarification,
            standalone_action,
            mut rules_context,
            turn_id,
            manual_roll,
            verified_roll,
            duplicate,
            request_trace,
            idempotency_request,
            request_fingerprint,
        } = context;
        let pre_resolve_span = sk_store::perf::span("orch.planned.pre_resolve");
        let has_commands = input.has_commands();
        let mut intent = if has_commands {
            json!({ "actor_id": player_id, "intent": "structured_commands", "approach": "api", "targets": [], "mentioned_entities": [], "missing_information": [], "requires_clarification": false, "confidence": 1, "raw_message": message })
        } else {
            self.intent_parser.parse(&message, &player_id, &visible_state).await?
        };
        let intent_kind = |intent: &Value| js::s(intent.get("intent"));
        const DETERMINISTIC_ACTION_INTENTS: [&str; 19] = [
            "improvised_action", "compound_maneuver", "approach_attack", "attack", "damage", "ability_check", "saving_throw", "healing", "cast_spell", "start_combat", "end_combat", "end_turn", "rest", "wait", "scenario_knight", "scenario_treaty", "scenario_purse", "scenario_armory", "scenario_informant",
        ];
        let explicit_pickpocket = is_str(intent.get("intent"), "improvised_action") && text::test(re!(r"(?:обчищ|обчист|карман|кошел)", "iu"), &message);
        let deterministic_action = intent.get("intent").and_then(Value::as_str).is_some_and(|kind| DETERMINISTIC_ACTION_INTENTS.contains(&kind))
            && (!is_str(intent.get("intent"), "improvised_action") || js::truthy(intent.get("free_action_kind")) || explicit_pickpocket);
        if !has_commands && !explicit_npc_id.is_empty() && !deterministic_action {
            intent = with(&intent, json!({ "intent": "social", "targets": [explicit_npc_id], "missing_information": [], "requires_clarification": false }));
        }
        let original_combat = js::is_true(at(Some(&original_state), &["mechanics", "combat", "active"]));
        if !has_commands && !original_combat && is_str(intent.get("intent"), "cast_spell") && !js::truthy(intent.get("spell_id")) {
            intent = with(&intent, json!({ "intent": "improvised_action", "missing_information": [], "requires_clarification": false }));
        }
        if !has_commands && explicit_npc_id.is_empty() && !original_combat && ["improvised_action", "explore", "unknown", "social"].contains(&js::string(intent.get("intent")).as_str()) {
            let addressee = speech_addressee(&message, &visible_state, &player_id, false);
            let social_ids: HashSet<String> = list(at(Some(&visible_state), &["social", "npcs"])).iter().map(|npc| js::string(npc.get("id"))).collect();
            let asks = match_all(re!(r"«([^«»]{1,800})»", "gu"), &message).iter().map(|found| group(found, 1)).collect::<Vec<_>>().join(" ").contains('?');
            match &addressee {
                Some(found) if found.kind == "npc" && social_ids.contains(&found.id) && (!text::test(speech_handover_pattern(), &message) || asks) => {
                    intent = with(&intent, json!({ "intent": "social", "targets": [found.id], "missing_information": [], "requires_clarification": false }));
                }
                Some(found) if found.kind == "hero" => {
                    intent = with(&intent, json!({ "intent": "improvised_action", "roleplay_speech": !acts_beyond_speech(&message), "targets": [], "missing_information": [], "requires_clarification": false }));
                }
                _ => {}
            }
        }
        let mut social_request: Option<String> = None;
        if !has_commands && is_str(intent.get("intent"), "social") && self.npc_social_controller.is_some() {
            let social_ids: HashSet<String> = list(at(Some(&visible_state), &["social", "npcs"])).iter().map(|npc| js::string(npc.get("id"))).collect();
            let npc_id = list(intent.get("targets")).iter().map(|target| js::string(Some(target))).find(|candidate| social_ids.contains(candidate));
            if js::truthy(intent.get("requires_clarification")) {
                social_request = None;
            } else if npc_id.is_none() && speech_to_party_or_air(&message, &visible_state, &player_id, &explicit_npc_id) {
                intent = with(&intent, json!({ "intent": "improvised_action", "roleplay_speech": !acts_beyond_speech(&message), "targets": [], "missing_information": [], "requires_clarification": false }));
            } else if let Some(npc_id) = npc_id {
                social_request = Some(npc_id);
            } else {
                set(&mut intent, "requires_clarification", Value::Bool(true));
                set(&mut intent, "missing_information", json!(["npc_id"]));
            }
        }
        let retrieval_queries = Value::Array(build_rule_queries(Some(&intent), Some(&original_state)).into_iter().map(Value::String).collect());
        let retrieved_rules = match &self.rule_retriever {
            Some(retriever) if len_of(Some(&retrieval_queries)) > 0 => {
                let request = obj(vec![
                    ("queries", Some(retrieval_queries.clone())),
                    ("ruleset_id", original_state.get("ruleset_id").cloned()),
                    ("enabled_packs", original_state.get("enabled_rule_packs").cloned()),
                    ("limit", Some(Value::from(10))),
                ]);
                retriever.search(&request).await?
            }
            _ => json!({ "results": [], "confidence": 0, "count": 0 }),
        };
        let free_action_request = !has_commands && ["improvised_action", "unknown", "explore"].contains(&intent_kind(&intent).as_str()) && intent.get("intent").is_some_and(Value::is_string);
        let confidence = intent.get("confidence").cloned();
        let base_plan = |constraints: Value| obj(vec![
            ("rule_ids", Some(json!([]))),
            ("proposed_commands", Some(json!([]))),
            ("roll_requests", Some(json!([]))),
            ("ruling_required", Some(Value::Bool(false))),
            ("ruling_draft", Some(Value::Null)),
            ("narration_constraints", Some(constraints)),
            ("confidence", confidence.clone()),
        ]);
        let mut plan = if has_commands {
            let commands = input.field("commands").cloned().unwrap_or(Value::Null);
            let Value::Array(items) = &commands else { return Err(type_error("input.commands.flatMap is not a function")) };
            if items.iter().any(Value::is_null) {
                return Err(type_error("Cannot read properties of null (reading 'source_rule_ids')"));
            }
            let rule_ids = unique_values(flat_field(items, "source_rule_ids"));
            json!({ "rule_ids": rule_ids, "proposed_commands": commands, "roll_requests": [], "ruling_required": false, "ruling_draft": null, "narration_constraints": [], "confidence": 1 })
        } else if js::truthy(intent.get("requires_clarification")) {
            let mut plan = base_plan(json!([]));
            set(&mut plan, "clarification_required", Value::Bool(true));
            if let Some(missing) = intent.get("missing_information") {
                set(&mut plan, "missing_information", missing.clone());
            }
            plan
        } else if social_request.is_some() {
            base_plan(json!(["server-social-check-before-dialogue", "npc-dialogue-from-committed-event-only"]))
        } else if free_action_request {
            base_plan(json!(["free-action-committed-consequences-only"]))
        } else {
            let maneuver_intent = is_str(intent.get("intent"), "approach_attack") || is_str(intent.get("intent"), "compound_maneuver");
            let plan_state = if maneuver_intent {
                match &duplicate {
                    Some(duplicate) => {
                        let first = list(duplicate.get("events")).first().ok_or_else(|| type_error("Cannot read properties of undefined (reading 'state_version_before')"))?;
                        self.event_store.load_at(&campaign_id, js::safe_int(first.get("state_version_before"), 0))?.state.as_ref().clone()
                    }
                    None => authoritative_state.to_value(),
                }
            } else {
                original_state.clone()
            };
            self.adjudicator.create_plan(&intent, &plan_state, &retrieved_rules).await?
        };
        if !has_commands
            && duplicate.is_none()
            && is_str(intent.get("intent"), "ability_check")
            && !js::truthy(at(Some(&authoritative_state), &["mechanics", "combat", "active"]))
            && list(plan.get("proposed_commands")).iter().any(|command| is_str(command.get("command_type"), "MakeAbilityCheck"))
        {
            let approach = free_action_approach_plan(&authoritative_state, &player_id, &message);
            if is_str(approach.get("status"), "ready") && js::truthy(approach.get("remainder")) {
                let mut commands = vec![obj(vec![
                    ("command_type", Some(str_value("MoveActor"))),
                    ("actor_id", Some(str_value(player_id.clone()))),
                    ("to", at(Some(&approach), &["destination", "to"]).cloned()),
                    ("server_authoritative", Some(Value::Bool(true))),
                ])];
                commands.extend(list(plan.get("proposed_commands")).iter().cloned());
                plan = with(&plan, json!({ "proposed_commands": commands }));
            }
        }
        let proposed = nullish(plan.get("proposed_commands"), None).cloned().unwrap_or_else(|| json!([]));
        let knock_out = js::truthy(intent.get("knock_out"));
        let commands: Vec<Value> = validate_allowed_commands(Some(&proposed), None)
            .map_err(security_error)?
            .into_iter()
            .enumerate()
            .map(|(index, command)| {
                let mut next = js::spread(&command, json!({}));
                if knock_out && (is_str(command.get("command_type"), "MakeAttack") || is_str(command.get("command_type"), "CastSpell")) {
                    set(&mut next, "knock_out", Value::Bool(true));
                }
                set(&mut next, "campaign_id", str_value(campaign_id.clone()));
                set(&mut next, "command_id", str_value(format!("{idempotency_key}:{}", index + 1)));
                next
            })
            .collect();
        set(&mut plan, "proposed_commands", Value::Array(commands));
        let maneuver = ["approach_attack", "long_jump_attack", "swing_attack"].contains(&js::string(plan.get("maneuver")).as_str()) && plan.get("maneuver").is_some_and(Value::is_string);
        if maneuver && duplicate.is_none() {
            let first = list(plan.get("proposed_commands")).first().cloned().unwrap_or(Value::Null);
            self.rules_engine.validate_normalized(&first, &authoritative_state, &rules_context)?;
            let confirmed = input.field("confirmedProposalId").filter(|value| js::truthy(Some(value))).cloned();
            let Some(confirmed) = confirmed else {
                let request = obj(vec![
                    ("campaignId", Some(str_value(campaign_id.clone()))),
                    ("actorId", Some(str_value(player_id.clone()))),
                    ("stateVersion", authoritative_state.get("state_version").cloned()),
                    ("proposal", plan.get("proposal").cloned()),
                    ("planFingerprint", Some(str_value(maneuver_proposal_fingerprint(plan.get("proposal"))))),
                ]);
                let issued = self.clarifications().issue_proposal(&request).map_err(registry_error)?;
                set(&mut plan, "proposal", issued.clone());
                let mut response = obj(vec![
                    ("narration", Some(str_value("Проверьте маршрут и цену манёвра. Подтвердите план или откажитесь от него."))),
                    ("action_proposal", Some(issued.clone())),
                    ("proposal_id", Some(nullish(issued.get("id"), None).cloned().unwrap_or(Value::Null))),
                    ("effects", Some(empty_effects())),
                    ("provider", Some(str_value("RulesEngine"))),
                    ("model", Some(str_value("deterministic"))),
                    ("turn_id", Some(str_value(turn_id.clone()))),
                    ("engine_mode", Some(str_value("enforce"))),
                    ("state_version", authoritative_state.get("state_version").cloned()),
                    ("mechanics", Some(json!([]))),
                    ("visible_state_changes", Some(json!([]))),
                    ("turn_consumed", Some(Value::Bool(false))),
                    ("action_kind", Some(str_value("proposal"))),
                    ("request_kind", Some(str_value("action"))),
                ]);
                if pending_clarification.is_some() {
                    set(&mut response, "resolved_action", str_value(message.clone()));
                }
                return Ok(response);
            };
            let request = obj(vec![("campaignId", Some(str_value(campaign_id.clone()))), ("actorId", Some(str_value(player_id.clone()))), ("stateVersion", authoritative_state.get("state_version").cloned())]);
            let approved = self.clarifications().resolve_proposal(Some(&confirmed), &request);
            let approved = match approved {
                Ok(approved) => approved,
                Err(error) if ["PROPOSAL_NOT_FOUND", "PROPOSAL_FORBIDDEN", "PROPOSAL_STALE"].contains(&error.code.as_str()) => {
                    return Err(OrchestratorError::coded("STATE_VERSION_CONFLICT", "План манёвра изменился. Отправьте заявку заново и подтвердите новый маршрут."));
                }
                Err(error) => return Err(registry_error(error)),
            };
            if !is_str(approved.get("plan_fingerprint"), &maneuver_proposal_fingerprint(plan.get("proposal"))) {
                return Err(OrchestratorError::coded("STATE_VERSION_CONFLICT", "План манёвра изменился. Отправьте заявку заново и подтвердите новый маршрут."));
            }
        }

        if free_action_request {
            let turn_id = structured_command_turn_id(&campaign_id, &idempotency_key);
            let confirmed_action = !standalone_action && pending_clarification.as_ref().is_some_and(|pending| is_str(at(Some(pending), &["original_intent", "pending_step"]), "proposal") && is_str(pending.get("action"), &message));
            let request = UnknownAction {
                campaign_id: campaign_id.clone(),
                action: str_value(message.clone()),
                idempotency_key: idempotency_key.clone(),
                player_id: str_value(player_id.clone()),
                intent: Some(intent.clone()),
                verified_roll: verified_roll.clone(),
                confirmed_action,
            };
            let _ = manual_roll;
            let free_action = self.unknown_action_handler.handle_unknown_action(&request).await?;
            let resolved = pending_clarification.as_ref().map(|_| message.as_str());
            return self
                .free_action_response(free_action, &campaign_id, &player_id, &viewer, &message, &intent, &retrieval_queries, &retrieved_rules, &plan, &authoritative_state, &idempotency_key, Some(request_fingerprint), &turn_id, started, resolved)
                .await;
        }
        if let Some(npc_id) = social_request.as_ref().filter(|_| duplicate.is_none()) {
            let social = ensure_npc_social_state(authoritative_state.get("social").unwrap_or(&Value::Null), &authoritative_state, &json!({}));
            let persisted = list(social.get("npcs")).iter().find(|npc| is_str(npc.get("id"), npc_id)).cloned();
            let profile = persisted.as_ref().map(|profile| npc_profile_at_world_time(profile, &authoritative_state));
            let scene_location = place_key(at(Some(&authoritative_state), &["scene", "location"]));
            let npc_location = place_key(get(profile.as_ref(), "location"));
            let truce_leader = js::s(get(truce_for(&authoritative_state).as_ref(), "leader_id"));
            let speaks_under_truce = !truce_leader.is_empty() && *npc_id == truce_leader;
            let in_combat = js::truthy(at(Some(&authoritative_state), &["mechanics", "combat", "active"]));
            let elsewhere = !scene_location.is_empty() && !npc_location.is_empty() && scene_location != npc_location;
            let unavailable = profile.is_none() || (!speaks_under_truce && (js::is_false(get(profile.as_ref(), "available")) || in_combat || elsewhere));
            if unavailable {
                set(&mut intent, "requires_clarification", Value::Bool(true));
                set(&mut intent, "missing_information", json!(["available_npc"]));
                let viewer_social = npc_social_for_viewer(authoritative_state.get("social").unwrap_or(&Value::Null), &json!({ "state": authoritative_state.value(), "playerId": player_id, "isPartyMember": true }));
                let known = list(viewer_social.get("npcs")).iter().any(|npc| js::s(npc.get("id")) == js::s(get(profile.as_ref(), "id")));
                if js::truthy(get(profile.as_ref(), "name")) && !speaks_under_truce && known {
                    let reason = if in_combat { "combat" } else if elsewhere { "elsewhere" } else { "unavailable" };
                    let location = if js::truthy(get(profile.as_ref(), "location")) { str_value(js::string(get(profile.as_ref(), "location"))) } else { Value::Null };
                    set(&mut intent, "absent_npc", json!({ "name": js::string(get(profile.as_ref(), "name")), "reason": reason, "location": location }));
                }
            }
        }

        if js::truthy(intent.get("requires_clarification")) || js::truthy(plan.get("clarification_required")) {
            let narration = match nullish(plan.get("clarification_message"), None) {
                Some(message) => message.clone(),
                None => str_value(human_missing_information(nullish(intent.get("missing_information"), plan.get("missing_information")), &authoritative_state, &intent)),
            };
            let absent = js::truthy(intent.get("absent_npc"));
            let mut response = obj(vec![
                ("narration", Some(narration.clone())),
                ("effects", Some(empty_effects())),
                ("provider", Some(str_value("RulesEngine"))),
                ("model", Some(str_value("deterministic"))),
                ("turn_id", Some(str_value(turn_id.clone()))),
                ("engine_mode", Some(str_value("enforce"))),
                ("state_version", authoritative_state.get("state_version").cloned()),
                ("mechanics", Some(json!([]))),
                ("visible_state_changes", Some(json!([]))),
                ("authoritative_state", Some(authoritative_state.to_value())),
                ("turn_consumed", Some(Value::Bool(false))),
                ("action_kind", Some(str_value(if absent { "answer" } else { "clarification" }))),
                ("request_kind", Some(str_value("action"))),
            ]);
            if !absent {
                let request = obj(vec![
                    ("campaignId", Some(str_value(campaign_id.clone()))),
                    ("actorId", Some(str_value(player_id.clone()))),
                    ("stateVersion", authoritative_state.get("state_version").cloned()),
                    ("action", Some(str_value(message.clone()))),
                    ("question", Some(narration)),
                    ("intent", Some(intent.clone())),
                ]);
                let clarification = self.clarifications().create(&request).map_err(registry_error)?;
                set(&mut response, "clarification", clarification);
            }
            if pending_clarification.is_some() {
                set(&mut response, "resolved_action", str_value(message.clone()));
            }
            self.save_trace(
                TraceInput {
                    turn_id: turn_id.clone(),
                    campaign_id: campaign_id.clone(),
                    intent: Some(intent),
                    retrieval_queries: Some(retrieval_queries),
                    retrieved_rules: Some(retrieved_rules),
                    plan,
                    state_before: authoritative_state.get("state_version").cloned(),
                    state_after: authoritative_state.get("state_version").cloned(),
                    verification: Some(json!({ "valid": true })),
                    latency: Value::from(self.now_ms() - started),
                    ..TraceInput::default()
                },
                false,
            )?;
            return Ok(response);
        }

        // Ручной бросок распознанной проверки: кубик остаётся за игроком.
        let plan_check_index = if !has_commands && social_request.is_none() && duplicate.is_none() {
            list(plan.get("proposed_commands")).iter().position(|command| (is_str(command.get("command_type"), "MakeAbilityCheck") || is_str(command.get("command_type"), "MakeSavingThrow")) && !js::truthy(command.get("social_check")))
        } else {
            None
        };
        let plan_check = plan_check_index.and_then(|index| list(plan.get("proposed_commands")).get(index).cloned());
        if let (Some(command), true, None, Some(registry)) = (&plan_check, manual_roll, &verified_roll, &self.roll_registry) {
            let actor = nullish(command.get("actor_id"), None).cloned().unwrap_or_else(|| str_value(player_id.clone()));
            let preview = preview_d20_check(
                &authoritative_state,
                &json!({
                    "actorId": actor,
                    "kind": if is_str(command.get("command_type"), "MakeSavingThrow") { "save" } else { "check" },
                    "ability": nullish(command.get("ability"), None).cloned().unwrap_or(Value::Null),
                    "skill": nullish(command.get("skill"), None).cloned().unwrap_or(Value::Null),
                    "difficulty": nullish(command.get("difficulty"), None).cloned().unwrap_or(Value::from(10)),
                    "proficient": js::truthy(command.get("proficient")),
                }),
            )?;
            let label = d20_check_label(&obj(vec![("kind", preview.get("kind").cloned()), ("ability", preview.get("ability").cloned()), ("skill", preview.get("skill").cloned())]));
            let options = obj(vec![
                ("campaignId", Some(str_value(campaign_id.clone()))),
                ("actorId", Some(str_value(js::s(Some(&actor))))),
                ("label", Some(str_value(label))),
                ("modifier", preview.get("modifier").cloned()),
                ("difficulty", preview.get("difficulty").cloned()),
                ("ability", preview.get("ability").cloned()),
                ("advantage", preview.get("advantage").cloned()),
                ("disadvantage", preview.get("disadvantage").cloned()),
                ("context", Some(obj(vec![("kind", Some(str_value("ability_action"))), ("action", Some(str_value(message.clone()))), ("state_version", authoritative_state.get("state_version").cloned()), ("skill", preview.get("skill").cloned())]))),
            ]);
            let check = registry.register_check(&options)?;
            let mut card = with(&check, json!({ "sides": 20 }));
            match preview.get("skill") {
                Some(skill) => set(&mut card, "skill", skill.clone()),
                None => unset(&mut card, "skill"),
            }
            let mut response = obj(vec![
                ("narration", Some(str_value(format!("Требуется проверка: {}, СЛ {}. Бросьте d20, чтобы узнать исход.", template(check.get("label")), template(check.get("difficulty")))))),
                ("effects", Some(empty_effects())),
                ("provider", Some(str_value("RulesEngine"))),
                ("model", Some(str_value("deterministic"))),
                ("turn_id", Some(str_value(turn_id.clone()))),
                ("engine_mode", Some(str_value("enforce"))),
                ("state_version", authoritative_state.get("state_version").cloned()),
                ("mechanics", Some(json!([]))),
                ("visible_state_changes", Some(json!([]))),
                ("check", Some(card)),
                ("turn_consumed", Some(Value::Bool(false))),
            ]);
            if pending_clarification.is_some() {
                set(&mut response, "resolved_action", str_value(message.clone()));
            }
            return Ok(response);
        }
        let mut plan_check = plan_check;
        if let (Some(index), Some(roll)) = (plan_check_index, &verified_roll) {
            let (check_context, payload) = Self::roll_payload(roll);
            if js::s(get(check_context.as_ref(), "kind")) != "ability_action" {
                return Err(context_mismatch("Этот бросок регистрировался не для этой проверки. Объявите действие заново."));
            }
            if let Some(command) = plan.get_mut("proposed_commands").and_then(Value::as_array_mut).and_then(|items| items.get_mut(index)) {
                set(command, "verified_roll", payload);
                plan_check = Some(command.clone());
            }
        }

        let mut social_base_state = authoritative_state.clone();
        let mut preceding_events: Vec<Value> = Vec::new();
        let mut preceding_rolls: Vec<Value> = Vec::new();
        let mut preceding_commands: Vec<Value> = Vec::new();
        let mut rolled_payloads: Vec<usize> = Vec::new();
        if let Some(npc_id) = &social_request {
            let hero = list(authoritative_state.get("players")).iter().find(|hero| js::s(get(Some(hero), "id")) == player_id);
            let bribe_reference = currency_to_copper(get(hero, "currency"));
            let policy = build_npc_social_check_policy(&json!({ "state": authoritative_state.value(), "npcId": npc_id, "heroId": player_id, "message": message, "turnId": turn_id, "bribeReferenceCp": bribe_reference }));
            let check_key = format!("{idempotency_key}:social-check");
            let mut check_commit = if policy.is_some() { self.by_key(&campaign_id, &check_key)? } else { None };
            if duplicate.is_none() {
                if let (Some(policy), None) = (&policy, &check_commit) {
                    let check_command = json!({ "command_type": "MakeAbilityCheck", "actor_id": player_id, "social_check": { "requested": true }, "campaign_id": campaign_id, "command_id": format!("{check_key}:1") });
                    set(&mut rules_context, "isSocialController", Value::Bool(true));
                    set(&mut rules_context, "socialCheck", policy.clone());
                    let check_plan = json!({ "rule_ids": [], "proposed_commands": [check_command], "roll_requests": [], "ruling_required": false, "ruling_draft": null, "narration_constraints": [], "confidence": 1 });
                    let check_result = self.rules_engine.resolve_turn_plan_normalized(&check_plan, &authoritative_state, &rules_context)?;
                    let events = list(check_result.get("events")).to_vec();
                    check_commit = match self.commit(&campaign_id, authoritative_state.get("state_version"), &check_key, events) {
                        Ok(commit) => Some(commit.to_json()),
                        Err(error) if error.code == "IDEMPOTENCY_CONFLICT" => match self.by_key(&campaign_id, &check_key)? {
                            Some(commit) => Some(commit),
                            None => return Err(error.into()),
                        },
                        Err(error) => return Err(error.into()),
                    };
                    preceding_commands = list(check_result.get("commands")).to_vec();
                    preceding_rolls = list(check_result.get("rolls")).to_vec();
                }
            }
            let mut check_outcome = Value::Null;
            if let (Some(policy), Some(commit)) = (&policy, &check_commit) {
                let check_event = list(commit.get("events")).iter().find(|event| is_str(event.get("event_type"), "AbilityCheckResolved") && js::truthy(at(Some(event), &["payload", "social_check"]))).cloned().unwrap_or(Value::Null);
                assert_npc_social_check_fingerprint(&check_event, policy).map_err(registry_error)?;
                check_outcome = npc_social_check_outcome(&check_event).ok_or_else(|| OrchestratorError::plain("Committed social check has no usable outcome"))?;
                preceding_events = list(commit.get("events")).to_vec();
                if preceding_rolls.is_empty() {
                    preceding_rolls = vec![check_event.get("payload").cloned().unwrap_or(Value::Null)];
                    rolled_payloads = list(commit.get("events")).iter().position(|event| is_str(event.get("event_type"), "AbilityCheckResolved") && js::truthy(at(Some(event), &["payload", "social_check"]))).into_iter().collect();
                }
                social_base_state = self.load_state(&campaign_id)?.0;
            }
            if duplicate.is_none() {
                let controller = self.npc_social_controller.as_ref().ok_or_else(|| type_error("npcSocialController is null"))?;
                let request = json!({
                    "state": social_base_state.value(), "playerId": player_id, "npcId": npc_id, "message": message, "turnId": turn_id, "checkOutcome": check_outcome,
                    "justSeen": js::s(input.field("precedingStep")),
                });
                let social_turn = controller.respond(&request).await?.filter(|turn| js::truthy(Some(turn))).ok_or_else(|| OrchestratorError::plain("NPC is no longer available for this social turn"))?;
                set(&mut rules_context, "isSocialController", Value::Bool(true));
                set(&mut rules_context, "socialCheckOutcome", check_outcome.clone());
                let social_command = obj(vec![
                    ("command_type", Some(str_value("RecordNpcSocialTurn"))),
                    ("actor_id", Some(str_value(player_id.clone()))),
                    ("conversation", social_turn.get("conversation").cloned()),
                    ("campaign_id", Some(str_value(campaign_id.clone()))),
                    ("command_id", Some(str_value(format!("{idempotency_key}:dialogue")))),
                ]);
                let validated = validate_allowed_commands(Some(&json!([social_command])), None).map_err(security_error)?;
                set(&mut plan, "proposed_commands", Value::Array(validated));
                if js::truthy(social_turn.get("context_metadata")) {
                    set(&mut plan, "agent_contexts", json!([social_turn["context_metadata"].clone()]));
                }
                set(&mut plan, "confidence", social_turn.get("confidence").cloned().unwrap_or(Value::Null));
                if social_turn.get("confidence").is_none() {
                    unset(&mut plan, "confidence");
                }
                let social_check = match &policy {
                    Some(policy) => obj(vec![("check_id", policy.get("check_id").cloned()), ("skill", policy.get("skill").cloned())]),
                    None => Value::Null,
                };
                set(&mut plan, "social_check", social_check);
            }
        }

        drop(pre_resolve_span);
        let mut replayed_commit = duplicate.is_some();
        let mut ruling_from_draft = false;
        let (mut committed, mut engine_result) = match &duplicate {
            Some(duplicate) => {
                let events = list(duplicate.get("events")).to_vec();
                let rolls: Vec<Value> = events.iter().filter(|event| is_str(event.get("event_type"), "DieRolled")).map(|event| event.get("payload").cloned().unwrap_or(Value::Null)).collect();
                let engine = json!({ "commands": plan.get("proposed_commands").cloned().unwrap_or(Value::Null), "events": events, "rolls": rolls, "state": duplicate.get("state").cloned().unwrap_or(Value::Null) });
                (duplicate.clone(), engine)
            }
            None => {
                if js::truthy(plan.get("ruling_required")) && len_of(plan.get("proposed_commands")) == 0 {
                    ruling_from_draft = true;
                    let mut ruling = json!({ "id": (self.id_factory)(), "campaign_id": campaign_id });
                    if let Some(Value::Object(draft)) = plan.get("ruling_draft") {
                        for (key, value) in draft {
                            set(&mut ruling, key, value.clone());
                        }
                    }
                    let command = json!({ "command_type": "RecordRuling", "actor_id": if player_id.is_empty() { Value::Null } else { str_value(player_id.clone()) }, "ruling": ruling, "ruling_id": ruling.get("id").cloned().unwrap_or(Value::Null), "campaign_id": campaign_id, "command_id": format!("{idempotency_key}:ruling") });
                    set(&mut plan, "ruling_draft", ruling);
                    set(&mut plan, "proposed_commands", json!([command]));
                }
                let mut resolution_state = if social_request.is_some() { social_base_state.clone() } else { authoritative_state.clone() };
                let mut outcome: Option<(Value, Value)> = None;
                for attempt in 0..3 {
                    let resolve_span = sk_store::perf::span("orch.resolve_turn_plan");
                    let engine = self.rules_engine.resolve_turn_plan_normalized(&plan, &resolution_state, &rules_context)?;
                    drop(resolve_span);
                    let events = list(engine.get("events")).to_vec();
                    if events.is_empty() {
                        return Err(OrchestratorError::plain("Enforce-ход не создал ни события, ни ruling"));
                    }
                    let _commit_span = sk_store::perf::span("orch.commit");
                    match self.commit(&campaign_id, resolution_state.get("state_version"), &idempotency_key, events) {
                        Ok(commit) => {
                            outcome = Some((commit.to_json(), engine));
                            break;
                        }
                        Err(error) => {
                            if error.code == "STATE_VERSION_CONFLICT" && attempt < 2 && !js::truthy(plan.get("maneuver")) {
                                resolution_state = self.load_state(&campaign_id)?.0;
                                continue;
                            }
                            if error.code != "IDEMPOTENCY_CONFLICT" {
                                return Err(error.into());
                            }
                            let Some(commit) = self.by_key(&campaign_id, &idempotency_key)? else { return Err(error.into()) };
                            let trace = match &self.trace_store {
                                Some(store) => store.get(&campaign_id, &turn_id)?,
                                None => None,
                            };
                            assert_narration_request_idempotency(Some(&commit), trace.as_ref(), &idempotency_request, &idempotency_key)?;
                            replayed_commit = true;
                            outcome = Some((commit, engine));
                            break;
                        }
                    }
                }
                outcome.ok_or_else(|| OrchestratorError::plain("Enforce-ход не зафиксирован"))?
            }
        };

        let brief_span = sk_store::perf::span("orch.post_commit_brief");
        let check_command = plan_check.filter(|command| social_request.is_none() && is_str(command.get("command_type"), "MakeAbilityCheck"));
        committed = self.commit_check_discovery(&campaign_id, &idempotency_key, committed, &message, &rules_context, check_command.as_ref()).await?;
        let main_events = match nullish(committed.get("events"), None) {
            Some(events) => list(Some(events)).to_vec(),
            None => list(engine_result.get("events")).to_vec(),
        };
        let mut committed_events = preceding_events.clone();
        committed_events.extend(main_events);
        // Состояние коммита дальше читается только отсюда: забирается из
        // итога без копии (Ск5).
        let mut committed_state = committed.get_mut("state").map(std::mem::take).unwrap_or(Value::Null);
        let shared = shared_narration_events(&committed_events, &committed_state);
        let public_events: Vec<Value> = mechanics_for_viewer(Some(&Value::Array(shared)), Some(&user), Some(&str_value(player_id.clone())), Some(&committed_state)).map_err(projection_error)?.and_then(|value| value.as_array().cloned()).unwrap_or_default();
        let mut all_commands = preceding_commands.clone();
        all_commands.extend(list(engine_result.get("commands")).iter().cloned());
        let mut all_rolls = preceding_rolls.clone();
        all_rolls.extend(list(engine_result.get("rolls")).iter().cloned());
        set(&mut engine_result, "commands", Value::Array(all_commands));
        set(&mut engine_result, "events", Value::Array(committed_events.clone()));
        set(&mut engine_result, "rolls", Value::Array(all_rolls.clone()));
        let changes = visible_changes(&committed_events);
        let story_context = narration_story_context(&committed_state, &viewer, &public_events)?;
        let mut player_intent = json!({ "action": message, "constraints": constraints_of(&message) });
        if js::truthy(plan.get("wait")) {
            set(&mut player_intent, "wait", json!({ "until": js::s(at(Some(&plan), &["wait", "label"])), "already": js::is_true(at(Some(&plan), &["wait", "already"])) }));
        }
        if js::truthy(committed.get("outcome_detail")) {
            set(&mut player_intent, "outcome_detail", str_value(text::head(&js::string(committed.get("outcome_detail")), 300)));
        }
        if js::truthy(committed.get("thorough_search")) {
            set(&mut player_intent, "thorough_search", str_value(js::string(committed.get("thorough_search"))));
        }
        let mut environment = json!({
            "context_metadata": agent_context_metadata(&committed_state, &AgentContextOptions { role: Some(&str_value("narrator")), actor_id: Some(&str_value(player_id.clone())), target_id: None, contract_version: Some(&str_value(NARRATOR_PROMPT_VERSION)) }),
            "scene": scene_context_for_agent(&committed_state, Some(&str_value(player_id.clone()))),
            "player_intent": player_intent,
            "campaign_premise": campaign_concept_for_agent(&committed_state, None),
            "participants": narration_participants(&committed_state, &public_events),
            "world_clock": world_clock_for_agents(&committed_state, Some(&str_value(player_id.clone()))),
            "scene_canon": scene_canon_for(&committed_state, Some(&json!({ "playerId": nullish(viewer.get("playerId"), None).cloned().unwrap_or_else(|| str_value(player_id.clone())), "actorId": player_id }))),
            "world_memory": { "facts": narration_world_facts(&committed_state, &viewer, &message, &public_events) },
            "story_context": story_context.clone(),
        });
        if let Some(scenario) = narration_scenario_context(&committed_state) {
            js::assign(&mut environment, scenario);
        }
        set(&mut environment, "social_consequences", Value::Array(narration_social_consequences(&public_events, &committed_state)));
        let mut details = vec![js::s(committed.get("outcome_detail"))];
        details.extend(discovery_detail_texts(&public_events));
        let reactions = with_detail_reactions(narration_npc_reactions(list(story_context.get("present_npcs")), &public_events, false, None), &details);
        let brief = build_narration_brief(Some(&json!({
            "visible_events": public_events,
            "visible_state_changes": visible_changes(&public_events),
            "known_environment": environment,
            "permitted_npc_reactions": reactions,
            "viewer": viewer,
        })))
        .map_err(security_error)?;
        let mut rule_ids = list(plan.get("rule_ids")).to_vec();
        rule_ids.extend(flat_field(&committed_events, "source_rule_ids"));
        let resolved_rule_ids = unique_values(rule_ids);
        let idempotent_replay = replayed_commit || js::truthy(committed.get("duplicate"));
        let replay_trace = match (&self.trace_store, idempotent_replay) {
            (Some(store), true) => match &request_trace {
                Some(trace) => Some(trace.clone()),
                None => store.get(&campaign_id, &turn_id)?,
            },
            _ => None,
        };
        let stored_social = npc_conversation_narration(&committed_events, &committed_state);
        let private_social = committed_events.iter().any(|event| is_str(event.get("event_type"), "NpcConversationRecorded") && is_str(event.get("visibility"), "specific_player"));
        let resolver = actor_name_resolver(&committed_state);
        let explicit_combat_maneuver = maneuver;
        let deterministic_narrator: Option<Arc<dyn DeterministicNarrator>> = if explicit_combat_maneuver { Some(COMBAT_NARRATOR.clone()) } else { deterministic_narrator_for(&committed_events) };
        let deterministic_response = match &deterministic_narrator {
            Some(narrator) => Some(deterministic_narrator_response(narrator.as_ref(), &committed_events, &committed_state, &brief, &resolved_rule_ids)?),
            None => None,
        };
        let replay_fallback = match (&deterministic_response, &stored_social) {
            (Some(response), _) => response.clone(),
            (None, Some(social)) => social.clone(),
            (None, None) => deterministic_replay_narration(&brief, &resolved_rule_ids, &resolver)?,
        };
        let structured_mechanics = (input.field("commands").is_some_and(Value::is_array) || maneuver) && deterministic_narrator.is_none();
        let streams_model = !idempotent_replay && deterministic_response.is_none() && stored_social.is_none() && !structured_mechanics;
        let state_version_payload = json!({ "stateVersion": committed.get("state_version").cloned().unwrap_or(Value::Null) });
        if streams_model {
            if let Some(start) = &input.on_narration_start {
                start(&state_version_payload);
            }
        }
        let progress: Option<ProgressCallback> = input.on_narration_progress.clone().map(|callback| {
            let payload = state_version_payload.clone();
            let wrapped: ProgressCallback = Arc::new(move |text_value: &str| callback(text_value, &payload));
            wrapped
        });
        drop(brief_span);
        let narration_span = sk_store::perf::span("orch.narration");
        let narration = if idempotent_replay {
            cached_narration(replay_trace.as_ref(), &brief, &resolved_rule_ids)?.unwrap_or(replay_fallback)
        } else if let Some(response) = &deterministic_response {
            response.clone()
        } else if let Some(social) = &stored_social {
            social.clone()
        } else if structured_mechanics {
            deterministic_mechanics_narration(&brief, &resolved_rule_ids, &resolver)?
        } else {
            let narrator = self.narrator.as_ref().ok_or_else(|| type_error("Cannot read properties of null (reading 'render')"))?;
            let recent = self.recent_narrations_for(&campaign_id)?;
            narrator.render(&brief, NarrationOptions { known_rule_ids: resolved_rule_ids.clone(), recent_narrations: recent, on_progress: progress }).await?
        };
        drop(narration_span);
        let _tail_span = sk_store::perf::span("orch.response_and_trace");
        if !idempotent_replay && !private_social {
            self.remember_narration(&campaign_id, &js::s(narration.get("narration")))?;
        }
        let visible = project_visible_state(Some(&Value::Array(changes)), Some(&viewer), None).unwrap_or_else(|| json!([]));
        let mut response = obj(vec![("narration", narration.get("narration").cloned())]);
        if private_social {
            set(&mut response, "narration_visibility", str_value("specific_player"));
        }
        if js::truthy(narration.get("journal_author")) {
            set(&mut response, "journal_author", narration["journal_author"].clone());
        }
        let fields = vec![
            ("effects", Some(events_to_client_effects(&committed_events, &all_rolls))),
            ("provider", narration.get("provider").cloned()),
            ("model", Some(str_value("orchestrated"))),
            ("turn_id", Some(str_value(turn_id.clone()))),
            ("engine_mode", Some(str_value("enforce"))),
            ("state_version", committed.get("state_version").cloned()),
            ("mechanics", Some(Value::Array(committed_events.clone()))),
            ("visible_state_changes", Some(visible)),
            ("authoritative_state", Some(std::mem::take(&mut committed_state))),
            ("verification", narration.get("verification").cloned()),
            ("ruling", Some(nullish(plan.get("ruling_draft"), None).cloned().unwrap_or(Value::Null))),
        ];
        for (key, value) in fields {
            if let Some(value) = value {
                set(&mut response, key, value);
            }
        }
        if pending_clarification.is_some() {
            set(&mut response, "resolved_action", str_value(message.clone()));
        }
        set(&mut response, "explanation_url", str_value(explanation_url(&campaign_id, &turn_id)));
        set(&mut response, "idempotent_replay", Value::Bool(idempotent_replay));
        if stored_social.is_some() {
            set(&mut response, "turn_consumed", Value::Bool(true));
            set(&mut response, "action_kind", str_value("social"));
        }
        let mut trace_engine = std::mem::take(&mut engine_result);
        set(&mut trace_engine, "events", Value::Array(committed_events.clone()));
        let trace_narration = with(&narration, json!({ "visibility": if private_social { "specific_player" } else { "party" } }));
        let aliases = TraceAliases {
            commands: if duplicate.is_some() { CommandsAlias::Elements } else { CommandsAlias::Engine },
            ruling: true,
            ruling_from_draft,
            rolled_payloads: {
                let mut indices = rolled_payloads.clone();
                if let Some(duplicate) = &duplicate {
                    let offset = preceding_events.len();
                    indices.extend(list(duplicate.get("events")).iter().enumerate().filter(|(_, event)| is_str(event.get("event_type"), "DieRolled")).map(|(index, _)| offset + index));
                }
                indices
            },
            ..TraceAliases::default()
        };
        let turn_trace = TraceInput {
            aliases,
            turn_id: turn_id.clone(),
            campaign_id: campaign_id.clone(),
            idempotency_key: Some(idempotency_key.clone()),
            request_fingerprint: Some(request_fingerprint),
            intent: Some(intent),
            retrieval_queries: Some(retrieval_queries),
            retrieved_rules: Some(retrieved_rules),
            plan: plan.clone(),
            engine_result: Some(trace_engine),
            state_before: authoritative_state.get("state_version").cloned(),
            state_after: committed.get("state_version").cloned(),
            verification: narration.get("verification").cloned(),
            latency: Value::from(self.now_ms() - started),
            narration: Some(trace_narration),
            ruling: plan.get("ruling_draft").cloned(),
            ..TraceInput::default()
        };
        if !idempotent_replay {
            self.save_trace(turn_trace, false)?;
        } else if replay_trace.is_none() {
            self.recover_missing_trace(turn_trace);
        }
        Ok(response)
    }

    /// `commitCheckDiscovery({ … })`: улика удачной проверки навыка —
    /// отдельным коммитом после проверки, ключ `:discovery`.
    async fn commit_check_discovery(&self, campaign_id: &str, idempotency_key: &str, committed: Value, message: &str, rules_context: &Value, check_command: Option<&Value>) -> OrchestratorResult<Value> {
        let discovery_key = format!("{idempotency_key}:discovery");
        if check_command.is_none() && js::truthy(committed.get("duplicate")) {
            let prior = self.by_key(campaign_id, &discovery_key)?;
            return Ok(match prior {
                Some(prior) => {
                    let mut events = list(committed.get("events")).to_vec();
                    events.extend(list(prior.get("events")).iter().cloned());
                    with(&committed, obj(vec![("state", prior.get("state").cloned()), ("state_version", prior.get("state_version").cloned()), ("events", Some(Value::Array(events)))]))
                }
                None => committed,
            });
        }
        let Some(check_command) = check_command else { return Ok(committed) };
        if js::is_true(at(Some(&committed), &["state", "mechanics", "combat", "active"])) {
            return Ok(committed);
        }
        let Some(check_event) = list(committed.get("events")).iter().find(|event| is_str(event.get("event_type"), "AbilityCheckResolved")).cloned() else { return Ok(committed) };
        let succeeded = js::is_true(at(Some(&check_event), &["payload", "success"]));
        let skill = js::s(coalesce(&[at(Some(&check_event), &["payload", "skill"]), check_command.get("skill")])).replace('_', "-");
        let mut discovery_commit = self.by_key(campaign_id, &discovery_key)?;
        let committed_state = committed.get("state").cloned().unwrap_or(Value::Null);
        let mut base_state = committed_state.clone();
        let mut base_version = committed.get("state_version").cloned();
        let details = if discovery_commit.is_some() { CheckDetails::default() } else { self.check_details_for(&committed_state, check_command.get("actor_id"), message, &skill).await };
        let search_input = |state_event: &Value| json!({ "checkEvent": state_event, "skill": skill, "actionText": message });
        let thorough = if succeeded { None } else { thorough_search_outcome(&committed_state, &search_input(&check_event)) };
        let hero_name = {
            let hero = list(committed_state.get("players")).iter().find(|player| js::string(get(Some(player), "id")) == js::string(check_command.get("actor_id")));
            let character = get(hero, "character");
            if js::truthy(character) {
                js::string(character)
            } else {
                "Герой".to_string()
            }
        };
        let discovery_skill = DISCOVERY_SKILLS.contains(&skill.as_str());
        let outcome_detail = if succeeded {
            if discovery_skill {
                String::new()
            } else {
                details.success_detail.clone()
            }
        } else if let Some(thorough) = &thorough {
            thorough_search_detail(Some(thorough), Some(&str_value(hero_name)))
        } else {
            details.failure_detail.clone()
        };
        let mut committed = committed;
        if !outcome_detail.is_empty() {
            committed = with(&committed, json!({ "outcome_detail": outcome_detail }));
        }
        if let Some(thorough) = &thorough {
            committed = with(&committed, json!({ "thorough_search": if js::truthy(thorough.get("found")) { "found" } else { "nothing" } }));
        }
        if !discovery_skill {
            return Ok(committed);
        }
        let skill_label = SKILL_LABELS_RU.iter().find(|(key, _)| *key == skill).map_or("", |(_, label)| label);
        let mut attempt = 0;
        while discovery_commit.is_none() && attempt < 3 {
            attempt += 1;
            let found: Vec<Value> = if succeeded {
                free_action_discovery_commands(&base_state, &json!({ "checkEvent": check_event, "skill": skill, "actionText": message, "skillLabel": skill_label, "successDetail": details.success_detail, "surfaceDetail": details.surface_detail }))
            } else {
                let mut commands = free_action_surface_commands(&base_state, &json!({ "checkEvent": check_event, "skill": skill, "surfaceDetail": details.surface_detail }));
                if let Some(thorough) = &thorough {
                    commands.extend(list(thorough_search_outcome(&base_state, &search_input(&check_event)).as_ref().and_then(|outcome| outcome.get("commands"))).iter().cloned());
                    commands.push(obj(vec![("command_type", Some(str_value("AdvanceTime"))), ("amount", thorough.get("minutes").cloned()), ("unit", Some(str_value("minute")))]));
                }
                commands
            };
            let commands: Vec<Value> = found.iter().enumerate().map(|(index, command)| with(command, json!({ "campaign_id": campaign_id, "command_id": format!("{discovery_key}:{}", index + 1) }))).collect();
            if commands.is_empty() {
                return Ok(committed);
            }
            let director_context = with(rules_context, json!({ "isDirector": true }));
            let outcome = self
                .rules_engine
                .resolve_turn_plan(&json!({ "proposed_commands": commands }), &base_state, &director_context)
                .map_err(OrchestratorError::from)
                .and_then(|resolved| self.commit(campaign_id, base_version.as_ref(), &discovery_key, list(resolved.get("events")).to_vec()).map_err(OrchestratorError::from));
            match outcome {
                Ok(commit) => discovery_commit = Some(commit.to_json()),
                Err(error) => {
                    if error.code() != Some("STATE_VERSION_CONFLICT") {
                        return Ok(committed);
                    }
                    let (state, version) = self.load_state(campaign_id)?;
                    base_state = state.into_value();
                    base_version = Some(Value::from(version));
                }
            }
        }
        let Some(discovery) = discovery_commit else { return Ok(committed) };
        let mut events = list(committed.get("events")).to_vec();
        events.extend(list(discovery.get("events")).iter().cloned());
        Ok(with(&committed, obj(vec![("state", discovery.get("state").cloned()), ("state_version", discovery.get("state_version").cloned()), ("events", Some(Value::Array(events)))])))
    }

    /// `checkDetailsFor(state, actorId, message, skill)`: детали осмотра от
    /// судьи — только с моделью; отказ модели — пустые детали.
    async fn check_details_for(&self, state: &Value, actor_id: Option<&Value>, message: &str, skill: &str) -> CheckDetails {
        let Some(adjudicator) = self.unknown_action_handler.action_adjudicator() else { return CheckDetails::default() };
        if skill.is_empty() || !adjudicator.awaits_model() {
            return CheckDetails::default();
        }
        let fallback = interpret_free_action(message);
        match adjudicator.read(state, &js::s(actor_id), message, &fallback).await {
            Ok(reading) => CheckDetails { success_detail: js::s(reading.get("success_detail")), surface_detail: js::s(reading.get("surface_detail")), failure_detail: js::s(reading.get("failure_detail")) },
            Err(_) => CheckDetails::default(),
        }
    }

    /// `recoverMissingTrace(trace)`: повтор хода, чей commit пережил сбой
    /// записи трассы, восстанавливает её; сбой восстановления ход не ломает.
    fn recover_missing_trace(&self, trace: TraceInput) -> Option<Value> {
        let store = self.trace_store.as_ref()?;
        let events = list(get(trace.engine_result.as_ref(), "events")).to_vec();
        if events.is_empty() {
            return None;
        }
        let recovered = (|| -> OrchestratorResult<Option<Value>> {
            if store.get(&trace.campaign_id, &trace.turn_id)?.is_some_and(|existing| js::truthy(Some(&existing))) {
                return Ok(None);
            }
            let before = js::number(coalesce(&[events.first().and_then(|event| event.get("state_version_before")), trace.state_before.as_ref()]));
            let recovery = json!({
                "reason": "trace_missing_after_commit",
                "events_source": "event_store",
                "request_source": "idempotent_retry",
                "recovered_at": sk_core::clock::iso(sk_core::clock::now_ms()),
            });
            let created_at = nullish(events.last().and_then(|event| event.get("created_at")), None).cloned();
            let next = TraceInput { request_fingerprint: None, state_before: Some(js::num(before)), latency: Value::from(0), created_at, recovery: Some(recovery), ..trace.clone() };
            self.save_trace(next, true)
        })();
        recovered.unwrap_or_default()
    }

    /// `saveTrace({ … }, { ifAbsent })`.
    fn save_trace(&self, trace: TraceInput, if_absent: bool) -> OrchestratorResult<Option<Value>> {
        let Some(store) = &self.trace_store else { return Ok(None) };
        let plan = &trace.plan;
        let narration = trace.narration.as_ref().filter(|value| js::truthy(Some(value)));
        let mut agent_contexts: Vec<Value> = list(plan.get("agent_contexts")).to_vec();
        if let Some(narration) = narration {
            let mut seed = json!({ "sessionCode": trace.campaign_id });
            if let Some(after) = &trace.state_after {
                set(&mut seed, "state_version", after.clone());
            }
            let contract = nullish(narration.get("prompt_version"), None).cloned().unwrap_or(Value::Null);
            agent_contexts.push(agent_context_metadata(&seed, &AgentContextOptions { role: Some(&str_value("narrator")), actor_id: get(trace.intent.as_ref(), "actor_id"), target_id: None, contract_version: Some(&contract) }));
        }
        let engine = trace.engine_result.clone().unwrap_or_else(|| json!({}));
        let mut rule_ids: Vec<Value> = list(plan.get("rule_ids")).to_vec();
        rule_ids.extend(list(get(trace.retrieved_rules.as_ref(), "results")).iter().map(|result| get(Some(result), "rule_id").cloned().unwrap_or(Value::Null)));
        rule_ids.extend(flat_field(list(engine.get("events")), "source_rule_ids"));
        let verification = trace.verification.clone().unwrap_or_else(|| json!({}));
        let narration_result = match narration {
            Some(narration) => json!({
                "narration": narration.get("narration").cloned().unwrap_or(Value::Null),
                "visibility": nullish(narration.get("visibility"), None).cloned().unwrap_or_else(|| str_value("party")),
                "verification": nullish(narration.get("verification"), None).cloned().unwrap_or_else(|| verification.clone()),
                "prompt_version": nullish(narration.get("prompt_version"), None).cloned().unwrap_or(Value::Null),
                "provider": nullish(narration.get("provider"), None).cloned().unwrap_or(Value::Null),
            }),
            None => Value::Null,
        };
        let seed = trace.idempotency_key.clone().unwrap_or_else(|| trace.turn_id.clone());
        let mut input = obj(vec![
            ("schema_version", Some(str_value(TURN_TRACE_SCHEMA_VERSION))),
            ("turn_id", Some(str_value(trace.turn_id.clone()))),
            ("campaign_id", Some(str_value(trace.campaign_id.clone()))),
            ("idempotency_key", Some(trace.idempotency_key.clone().map_or(Value::Null, Value::String))),
            ("request_fingerprint", Some(trace.request_fingerprint.clone().map_or(Value::Null, Value::String))),
            ("proposal_id", Some(str_value(proposal_id_for(&trace.campaign_id, &seed)))),
            ("engine_mode", Some(str_value("enforce"))),
            ("prompt_versions", Some(turn_prompt_versions(narration))),
            ("model_identifiers", Some(model_identifiers(narration))),
            ("agent_contexts", Some(Value::Array(agent_contexts))),
            ("intent", trace.intent.clone()),
            ("retrieval_queries", trace.retrieval_queries.clone()),
            ("retrieved_rule_ids", Some(Value::Array(unique_values(rule_ids)))),
            ("adjudication_plan", Some(plan.clone())),
            ("validated_commands", Some(coalesce(&[engine.get("commands"), plan.get("proposed_commands")]).cloned().unwrap_or_else(|| json!([])))),
            ("rolls", Some(nullish(engine.get("rolls"), None).cloned().unwrap_or_else(|| json!([])))),
            ("events", Some(nullish(engine.get("events"), None).cloned().unwrap_or_else(|| json!([])))),
            ("state_version_before", trace.state_before.clone()),
            ("state_version_after", trace.state_after.clone()),
            ("verification_result", Some(verification)),
            ("latency_ms", Some(trace.latency.clone())),
            ("token_usage", Some(nullish(get(narration, "token_usage"), None).cloned().unwrap_or_else(|| json!({})))),
            ("narration_result", Some(narration_result)),
            ("ruling", Some(trace.ruling.clone().unwrap_or(Value::Null))),
        ]);
        mark_shared_references(&mut input, &trace);
        if let Some(recovery) = trace.recovery.filter(|value| js::truthy(Some(value))) {
            set(&mut input, "recovery", recovery);
        }
        if let Some(created_at) = trace.created_at.filter(|value| js::truthy(Some(value))) {
            set(&mut input, "created_at", created_at);
        }
        let written = match (if_absent, if if_absent { store.save_if_absent(&input) } else { None }) {
            (true, Some(result)) => result?,
            _ => store.save(&input)?,
        };
        Ok(Some(written))
    }
}

/// Детали осмотра от судьи (`checkDetailsFor`).
#[derive(Debug, Clone, Default)]
struct CheckDetails {
    success_detail: String,
    surface_detail: String,
    failure_detail: String,
}

/// Поля запроса, общие для `handle` и `_handle`.
struct RequestHead {
    campaign_id: String,
    player_id: String,
    message: String,
    request_kind: String,
    clarification_id: String,
    supersedes_check_id: String,
    supersedes_proposal_id: String,
    question_check_id: String,
    question_proposal_id: String,
    idempotency_key: String,
    npc_id: String,
}

impl RequestHead {
    fn read(input: &HandleInput, original_state: &Value) -> Self {
        let trimmed = |a: &str, b: &str, maximum: usize| text::head(text::trim(&js::s(input.either(a, b))), maximum);
        let message = text::head(text::trim(&js::s(input.either("message", "action"))), 2_000);
        let request_kind = match input.either("requestKind", "request_kind") {
            None => infer_request_kind(Some(&str_value(message.clone()))).to_string(),
            Some(kind) => normalize_request_kind(Some(kind)).to_string(),
        };
        Self {
            campaign_id: js::s(coalesce(&[input.field("campaignId"), input.field("campaign_id"), original_state.get("sessionCode"), original_state.get("campaign_id")])),
            player_id: js::s(coalesce(&[input.field("playerId"), input.field("player_id"), original_state.get("activePlayerId")])),
            message,
            request_kind,
            clarification_id: trimmed("clarificationId", "clarification_id", 8_000),
            supersedes_check_id: trimmed("supersedesCheckId", "supersedes_check_id", 200),
            supersedes_proposal_id: trimmed("supersedesProposalId", "supersedes_proposal_id", 300),
            question_check_id: trimmed("questionCheckId", "question_check_id", 200),
            question_proposal_id: trimmed("questionProposalId", "question_proposal_id", 300),
            idempotency_key: js::s(input.either("idempotencyKey", "idempotency_key")),
            npc_id: trimmed("npcId", "npc_id", 120),
        }
    }

    fn fingerprint(&self, operation: &str) -> RequestFingerprint {
        RequestFingerprint {
            campaign_id: self.campaign_id.clone(),
            player_id: self.player_id.clone(),
            message: self.message.clone(),
            npc_id: self.npc_id.clone(),
            request_kind: self.request_kind.clone(),
            clarification_id: self.clarification_id.clone(),
            supersedes_check_id: self.supersedes_check_id.clone(),
            supersedes_proposal_id: self.supersedes_proposal_id.clone(),
            question_check_id: self.question_check_id.clone(),
            question_proposal_id: self.question_proposal_id.clone(),
            operation: operation.into(),
        }
    }
}

/// Состояние `_handle` после развилок ручного броска.
struct HandleContext {
    started: i64,
    campaign_id: String,
    player_id: String,
    message: String,
    idempotency_key: String,
    explicit_npc_id: String,
    user: Value,
    viewer: Value,
    visible_state: Value,
    original_state: Value,
    authoritative_state: NormalizedState,
    pending_clarification: Option<Value>,
    standalone_action: bool,
    rules_context: Value,
    turn_id: String,
    manual_roll: bool,
    verified_roll: Option<Value>,
    duplicate: Option<Value>,
    request_trace: Option<Value>,
    idempotency_request: RequestFingerprint,
    request_fingerprint: String,
}

/// `[step, narration].map((text) => String(text ?? '').trim()).filter(Boolean).join(' — ').slice(0, 600)`.
fn joined_step(step: &str, narration: Option<&Value>) -> String {
    let parts: Vec<String> = [text::trim(step).to_string(), text::trim(&js::s(narration)).to_string()].into_iter().filter(|part| !part.is_empty()).collect();
    text::head(&parts.join(" — "), 600)
}

// --- общие ссылки трассы -----------------------------------------------------------------------

fn is_reference(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

fn circular() -> Value {
    str_value("[CIRCULAR]")
}

/// Замечено в JS: `redactTrace` из `security.mjs` помнит каждый уже
/// пройденный объект и заменяет любую повторную ссылку на `"[CIRCULAR]"` —
/// не только цикл. Трасса JS собирается из общих объектов (план и
/// подтверждённые команды, черновик решения и команда `RecordRuling`,
/// `intent.missing_information`, контексты агентов), и в файл трассы (а
/// значит, в `/why`) уходят пометки вместо данных. В `serde_json::Value`
/// ссылок нет, поэтому общие места объекта трассы, которые создаёт этот
/// модуль, помечаются здесь явно — в порядке обхода JS (ключи `save`
/// хранилища трасс: контексты, намерение, план, команды, броски, события,
/// решение).
fn mark_shared_references(input: &mut Value, trace: &TraceInput) {
    let mut aliases = trace.aliases.clone();
    if trace.engine_result.is_none() {
        // `engineResult = {}`: `validated_commands` — сам `plan.proposed_commands`.
        aliases.commands = CommandsAlias::Whole;
    }
    let original_plan = input.get("adjudication_plan").cloned().unwrap_or(Value::Null);
    let intent_missing = at(Some(input), &["intent", "missing_information"]).cloned();
    if let Some(plan) = input.get_mut("adjudication_plan").filter(|plan| plan.is_object()) {
        // Контексты агентов плана уже пройдены в `agent_contexts` трассы.
        if let Some(contexts) = plan.get_mut("agent_contexts").and_then(Value::as_array_mut) {
            for context in contexts.iter_mut().filter(|context| is_reference(context)) {
                *context = circular();
            }
        }
        // `missing_information` плана уточнения — массив самого намерения.
        if let (Some(missing), Some(intent_missing)) = (plan.get_mut("missing_information"), &intent_missing) {
            if is_reference(missing) && missing == intent_missing {
                *missing = circular();
            }
        }
        let rule_ids = plan.get("rule_ids").cloned();
        if aliases.ruling_from_draft {
            if let Some(ruling) = plan.get_mut("proposed_commands").and_then(Value::as_array_mut).and_then(|commands| commands.first_mut()).and_then(|command| command.get_mut("ruling")) {
                if let (Some(supporting), Some(rule_ids)) = (ruling.get_mut("supporting_rule_ids"), &rule_ids) {
                    if is_reference(supporting) && supporting == rule_ids {
                        *supporting = circular();
                    }
                }
            }
            if let Some(draft) = plan.get_mut("ruling_draft").filter(|draft| is_reference(draft)) {
                *draft = circular();
            }
        }
        if aliases.ruling_spread {
            let rulings: Vec<Value> = list(original_plan.get("proposed_commands")).iter().filter_map(|command| command.get("ruling").filter(|ruling| ruling.is_object()).cloned()).collect();
            if let Some(Value::Object(draft)) = plan.get_mut("ruling_draft") {
                for (key, value) in draft.iter_mut() {
                    if is_reference(value) && rulings.iter().any(|ruling| ruling.get(key) == Some(&*value)) {
                        *value = circular();
                    }
                }
            }
        }
        // Манёвр: `proposal.to` — тот же объект, что `to` команды шага.
        if js::truthy(original_plan.get("maneuver")) {
            let targets: Vec<Value> = list(original_plan.get("proposed_commands")).iter().filter_map(|command| command.get("to").filter(|to| is_reference(to)).cloned()).collect();
            if let Some(to) = plan.get_mut("proposal").and_then(|proposal| proposal.get_mut("to")) {
                if is_reference(to) && targets.iter().any(|target| target == to) {
                    *to = circular();
                }
            }
        }
    }
    let plan_commands = list(original_plan.get("proposed_commands")).to_vec();
    if let Some(validated) = input.get_mut("validated_commands") {
        match aliases.commands {
            CommandsAlias::None => {}
            CommandsAlias::Whole => {
                if is_reference(validated) {
                    *validated = circular();
                }
            }
            CommandsAlias::Elements => {
                for command in validated.as_array_mut().into_iter().flatten().filter(|command| is_reference(command)) {
                    *command = circular();
                }
            }
            CommandsAlias::Engine => {
                for command in validated.as_array_mut().into_iter().flatten() {
                    let id = command.get("command_id").cloned();
                    let Some(source) = plan_commands.iter().find(|candidate| id.is_some() && candidate.get("command_id") == id.as_ref()) else { continue };
                    if let Value::Object(fields) = command {
                        for (key, value) in fields.iter_mut() {
                            if key != "target_ids" && key != "source_rule_ids" && is_reference(value) && source.get(key) == Some(&*value) {
                                *value = circular();
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(events) = input.get_mut("events").and_then(Value::as_array_mut) {
        for index in &aliases.rolled_payloads {
            if let Some(payload) = events.get_mut(*index).and_then(|event| event.get_mut("payload")).filter(|payload| is_reference(payload)) {
                *payload = circular();
            }
        }
    }
    if aliases.ruling || aliases.ruling_from_draft {
        if let Some(ruling) = input.get_mut("ruling").filter(|ruling| is_reference(ruling)) {
            *ruling = circular();
        }
    }
}
