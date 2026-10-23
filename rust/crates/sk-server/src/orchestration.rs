//! Оркестраторы и агенты ядра — сборка верхушки `server/index.mjs`
//! (291–295 кости и реестр бросков, 320 движок, 395–420 рассказчик,
//! критический момент, мораль и собеседник NPC, летописец, судья
//! свободного действия, автономный цикл; 2997–3010 `GameOrchestrator`).
//!
//! Всё здесь без `Send` (`RefCell`, `Rc`) и живёт только на потоке ядра:
//! один набор на ядро, собирается при первом обращении маршрута
//! ([`orchestration`]) из настроек процесса. Маршруты С18 (`/commands`,
//! `/api/narrate`, автономия, торговля, встречи) берут его отсюда, а не
//! собирают свой: в JS это одни и те же объекты на весь процесс (общий
//! реестр бросков, память рассказов, реестр уточнений).
//!
//! Журнал оркестраторов — [`CoreJournal`]: коммит идёт через
//! [`crate::test_hooks::commit`] (сбои `DND_COMMIT_FAULTS`), как у
//! `projection::HookedJournal`. Реестр бросков — тот же
//! `GameCore::rolls`, через [`CoreRolls`]. Движок правил — один на ядро, с
//! общими костями ядра (`new RulesEngine({ diceService })`, 320).
//!
//! Чего здесь нет (задачи С17): `CombatTurnCoordinator` (автоход по часам,
//! `hold`) и `PostCommitCoordinator` целиком — продолжение боя после хода
//! маршрут `/commands` зовёт напрямую (`routes::commands`,
//! `settle_combat_continuation`).

use std::cell::{OnceCell, RefCell};
use std::path::Path;
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex, Weak as ArcWeak};

use serde_json::Value;
use sk_agents::action_adjudicator::ActionAdjudicator;
use sk_agents::creative_director::CriticalNarrationCoordinator;
use sk_agents::director_agent::RoleClient;
use sk_agents::lore_author::LoreAuthor;
use sk_agents::lore_voice::LoreVoice;
use sk_agents::narrator::{Narrator, NarratorConfig};
use sk_agents::npc_controller::NpcMoraleAgent;
use sk_agents::npc_social_controller::NpcSocialController;
use sk_infra::roll_registry::RollRegistryError;
use sk_infra::usage_ledger::LlmClient;
use sk_narration_base::clarification_registry::{ClarificationRegistry, ClarificationRegistryOptions};
use sk_orchestrator::autonomous_orchestrator::{AgentFuture, AutonomousCampaignOrchestrator, CheckRegistry, OrchestratorError, OrchestratorJournal, OrchestratorResult};
use sk_orchestrator::game_orchestrator::{GameOrchestrator, GameOrchestratorOptions, RuleSearch, TurnRollRegistry};
use sk_projection::trace_store::FileTraceStore;
use sk_rules::resolve::api::RulesEngine;
use sk_store::executor::Journal;
use sk_store::{CommitRequest, CommitResult, EventStore, LoadOptions, Loaded, StoreResult};
use sk_turns::npc_turn_scheduler::NpcTurnJournal;

use crate::core::GameCore;
use crate::error::Failure;
use crate::state::AppState;

/// Имя класса клиента модели JS (`llmClient.constructor.name`): роли пишут
/// его в `provider` ответа. Горячий путь — `FallbackLLMClient` (303).
const HOT_CLIENT_CLASS: &str = "FallbackLLMClient";

// --- журнал и реестр бросков ядра ------------------------------------------

/// Журнал ядра для оркестраторов и планировщика ходов NPC: коммит — через
/// тестовые крючки, чтение — напрямую.
pub struct CoreJournal(pub Arc<EventStore>);

impl Journal for CoreJournal {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        self.0.load(campaign_id, &LoadOptions::default())
    }

    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        crate::test_hooks::commit(&self.0, request)
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>> {
        self.0.get_by_idempotency_key(campaign_id, key)
    }
}

impl OrchestratorJournal for CoreJournal {
    fn load_at(&self, campaign_id: &str, at_version: i64) -> StoreResult<Loaded> {
        self.0.load(campaign_id, &LoadOptions { at_version: Some(at_version), ..LoadOptions::default() })
    }

    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: Option<i64>) -> Option<StoreResult<Vec<Value>>> {
        Some(self.0.get_events(campaign_id, after_version, up_to_version))
    }
}

impl NpcTurnJournal for CoreJournal {
    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: i64) -> Option<StoreResult<Vec<Value>>> {
        Some(self.0.get_events(campaign_id, after_version, Some(up_to_version)))
    }
}

/// Реестр бросков ядра (`GameCore::rolls`) для оркестраторов. Ссылка
/// слабая: набор живёт в локальной памяти потока ядра и не держит ядро.
pub struct CoreRolls(Weak<GameCore>);

fn stopped() -> OrchestratorError {
    OrchestratorError::plain("игровое ядро остановлено")
}

fn roll_error(error: RollRegistryError) -> OrchestratorError {
    OrchestratorError::named(error.name(), error.code().map(str::to_string), error.to_string())
}

impl CoreRolls {
    fn with<R>(&self, operation: impl FnOnce(&mut sk_infra::roll_registry::RollRegistry) -> Result<R, RollRegistryError>) -> OrchestratorResult<R> {
        let core = self.0.upgrade().ok_or_else(stopped)?;
        let mut rolls = core.rolls.borrow_mut();
        operation(&mut rolls).map_err(roll_error)
    }
}

impl CheckRegistry for CoreRolls {
    fn register_check(&self, options: &Value) -> OrchestratorResult<Value> {
        self.with(|rolls| rolls.register_check(options))
    }
}

impl TurnRollRegistry for CoreRolls {
    fn get_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<Value> {
        self.with(|rolls| rolls.get_check(&Value::String(check_id.into()), options))
    }

    fn invalidate_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<bool> {
        self.with(|rolls| rolls.invalidate_check(&Value::String(check_id.into()), options))
    }

    fn invalidate_proposal(&self, proposal_id: &str, options: &Value) -> OrchestratorResult<bool> {
        self.with(|rolls| rolls.invalidate_proposal(&Value::String(proposal_id.into()), options))
    }
}

/// Поиск правил процесса (`ruleRetriever`, 318): каталог из `AppState`.
struct CatalogSearch(ArcWeak<AppState>);

impl RuleSearch for CatalogSearch {
    fn search<'a>(&'a self, request: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            let state = self.0.upgrade().ok_or_else(stopped)?;
            state.rules.retriever.search(request).map_err(|error| OrchestratorError::plain(error.message().to_string()))
        })
    }
}

// --- набор ядра --------------------------------------------------------------

/// Оркестраторы, агенты и движок одного ядра.
pub struct Orchestration {
    /// `rulesEngine` (320): общие кости ядра.
    pub rules: Arc<RefCell<RulesEngine>>,
    pub journal: Arc<CoreJournal>,
    pub rolls: Arc<CoreRolls>,
    /// `gameOrchestrator` (2997–3010).
    pub game: GameOrchestrator,
    /// `autonomousCampaign` (421).
    pub autonomous: Arc<AutonomousCampaignOrchestrator>,
    /// `narrator` (396).
    pub narrator: Arc<Narrator>,
    /// `creativeDirector` (397).
    pub creative: CriticalNarrationCoordinator,
    /// `npcController` (398): мораль врага на ходу NPC.
    pub npc_controller: NpcMoraleAgent,
    /// `npcSocialController` (399).
    pub npc_social: Arc<NpcSocialController>,
    /// `apiKey ? llmClient : null`: есть ли у ролей модель.
    pub has_model: bool,
}

thread_local! {
    /// Набор ядра этого потока (у каждого ядра свой поток).
    static ORCHESTRATION: OnceCell<Rc<Orchestration>> = const { OnceCell::new() };
}

/// Набор ядра: собирается при первом вызове на потоке ядра и дальше
/// переиспользуется (как объекты верхушки `index.mjs`).
pub fn orchestration(core: &Rc<GameCore>, state: &Arc<AppState>) -> Result<Rc<Orchestration>, Failure> {
    if let Some(ready) = ORCHESTRATION.with(|slot| slot.get().cloned()) {
        return Ok(ready);
    }
    let built = Rc::new(build(core, state)?);
    Ok(ORCHESTRATION.with(|slot| slot.get_or_init(|| built).clone()))
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

fn build(core: &Rc<GameCore>, state: &Arc<AppState>) -> Result<Orchestration, Failure> {
    let storage: &Path = &state.config.storage_dir;
    let llm: Option<Arc<dyn LlmClient>> = state.agent_llm().map(|client| client.client());
    let lore: Option<Arc<dyn LlmClient>> = state.lore_llm().map(|client| client.client());
    let rules = Arc::new(RefCell::new(RulesEngine::new(Box::new(sk_rules::dice_record::ServiceDice::new(core.dice.clone())))));
    let journal = Arc::new(CoreJournal(core.events.clone()));
    let rolls = Arc::new(CoreRolls(Rc::downgrade(core)));
    let narrator = Arc::new(Narrator::new(match &llm {
        Some(client) => NarratorConfig::with_client(client.clone(), HOT_CLIENT_CLASS),
        None => NarratorConfig::default(),
    }));
    let creative = CriticalNarrationCoordinator::new(narrator.clone());
    let npc_controller = NpcMoraleAgent::new(llm.clone().map(|client| RoleClient::new(client, HOT_CLIENT_CLASS)));
    let npc_social = Arc::new(NpcSocialController::new(llm.clone()).with_provider_name(HOT_CLIENT_CLASS));
    let lore_author = Arc::new(LoreAuthor::new(lore));
    let action_adjudicator = Arc::new(ActionAdjudicator::new(llm.clone(), None, None));
    let autonomous = Arc::new(
        AutonomousCampaignOrchestrator::new(journal.clone(), rules.clone())
            .with_narrator(narrator.clone())
            .with_action_adjudicator(action_adjudicator.clone())
            .with_lore_author(lore_author)
            .with_roll_registry(rolls.clone()),
    );
    let trace_store = FileTraceStore::new(storage.join("turn-traces")).map_err(|error| Failure::new(format!("{error:?}"), None))?;
    // `new ClarificationRegistry({ storageFile: join(eventStore.rootDir, 'clarifications.json') })`
    // (`game-orchestrator.mjs`): реестр по умолчанию у JS — файл рядом с журналом.
    let clarifications = ClarificationRegistry::new(ClarificationRegistryOptions { storage_file: Some(storage.join("engine").join("clarifications.json")), ttl_ms: None, now: None, id_factory: None })?;
    let mut options = GameOrchestratorOptions::new(journal.clone(), rules.clone());
    options.rule_retriever = Some(Arc::new(CatalogSearch(Arc::downgrade(state))));
    options.trace_store = Some(Arc::new(trace_store));
    options.narrator = Some(Some(narrator.clone()));
    options.npc_social_controller = Some(npc_social.clone());
    options.unknown_action_handler = Some(autonomous.clone());
    options.action_adjudicator = Some(action_adjudicator);
    options.lore_voice = Some(Arc::new(LoreVoice::new(llm.clone(), None)));
    options.roll_registry = Some(rolls.clone());
    options.clarification_registry = Some(Arc::new(Mutex::new(clarifications)));
    let game = GameOrchestrator::new(options).map_err(orchestrator_failure)?;
    Ok(Orchestration { rules, journal, rolls, game, autonomous, narrator, creative, npc_controller, npc_social, has_model: llm.is_some() })
}
