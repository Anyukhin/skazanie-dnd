//! Оркестраторы ядра — сборка служб `server/index.mjs` вокруг
//! `gameOrchestrator` (2997–3010) и `autonomousCampaign` (401):
//! Рассказчик, судья свободных действий, летописец, Хранитель знаний,
//! собеседник-NPC, трассы ходов (`storage/turn-traces`), реестр уточнений
//! (`engine/clarifications.json`), архитектор сцены (311) и поиск правил.
//!
//! Крейты оркестрации без `Send` (`RefCell`, `Rc`), поэтому службы живут на
//! потоке ядра ([`crate::core`]) и собираются лениво первым заданием, которому
//! они нужны: [`orchestration`] держит их в `thread_local` потока ядра (у
//! каждого ядра — свои). Журнал и реестр бросков — те же, что у остального
//! ядра: журнал коммитит только через [`crate::test_hooks::commit`] (сбои
//! `DND_COMMIT_FAULTS`), реестр бросков — `GameCore::rolls`. Модель — только
//! клиенты [`crate::state::Metered`] из `AppState` (`apiKey ? llmClient :
//! null`).

use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sk_agents::action_adjudicator::ActionAdjudicator;
use sk_agents::lore_author::LoreAuthor;
use sk_agents::lore_voice::LoreVoice;
use sk_agents::narrator::{Narrator, NarratorConfig};
use sk_agents::npc_social_controller::NpcSocialController;
use sk_agents::scene_architect::SceneArchitectAgent;
use sk_agents::director_agent::RoleClient;
use sk_narration_base::clarification_registry::{ClarificationRegistry, ClarificationRegistryOptions};
use sk_orchestrator::autonomous_orchestrator::{AgentFuture, AutonomousCampaignOrchestrator, CheckRegistry, OrchestratorError, OrchestratorJournal, OrchestratorResult};
use sk_orchestrator::game_orchestrator::{GameOrchestrator, GameOrchestratorOptions, RuleSearch, TurnRollRegistry, TurnRules, TurnTraceStore};
use sk_projection::trace_store::FileTraceStore;
use sk_rulepack::rule_retriever::RetrieverError;
use sk_rules::resolve::api::RulesEngine;
use sk_store::{CommitRequest, CommitResult, EventStore, LoadOptions, Loaded, StoreResult};

use crate::core::GameCore;
use crate::error::Failure;
use crate::state::AppState;

/// Имя класса клиента модели в JS (`llmClient.constructor.name`): роли пишут
/// его в `provider`.
const LLM_CLASS_NAME: &str = "FallbackLLMClient";

/// Службы оркестрации одного ядра.
pub struct Orchestration {
    /// `gameOrchestrator`.
    pub game: GameOrchestrator,
    /// `autonomousCampaign` — тот же экземпляр, что исполнитель свободного
    /// действия у `game` (`unknownActionHandler`, 3007).
    pub autonomous: Arc<AutonomousCampaignOrchestrator>,
    /// `sceneArchitect` (311).
    pub scene_architect: SceneArchitectAgent,
    /// `gameOrchestrator.clarificationRegistry` — общий с HTTP-слоем (4881).
    pub clarifications: Arc<Mutex<ClarificationRegistry>>,
}

thread_local! {
    static ORCHESTRATION: RefCell<Option<Rc<Orchestration>>> = const { RefCell::new(None) };
}

/// Службы оркестрации ядра; собираются при первом обращении. Вызывается
/// только из задания ядра.
pub fn orchestration(core: &Rc<GameCore>, app: &Arc<AppState>) -> Result<Rc<Orchestration>, Failure> {
    if let Some(ready) = ORCHESTRATION.with(|slot| slot.borrow().clone()) {
        return Ok(ready);
    }
    let built = Rc::new(build(core, app)?);
    ORCHESTRATION.with(|slot| *slot.borrow_mut() = Some(built.clone()));
    Ok(built)
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

fn build(core: &Rc<GameCore>, app: &Arc<AppState>) -> Result<Orchestration, Failure> {
    let storage = &app.config.storage_dir;
    let journal: Arc<dyn OrchestratorJournal> = Arc::new(CoreJournal(core.events.clone()));
    // `rulesEngine = new RulesEngine({ diceService })` (325): общие кости ядра.
    let rules = Arc::new(RefCell::new(RulesEngine::new(Box::new(sk_rules::dice_record::ServiceDice::new(core.dice.clone())))));
    let rolls = Arc::new(CoreRolls(Rc::downgrade(core)));
    let llm = app.agent_llm().map(|client| client.client());
    let lore = app.lore_llm().map(|client| client.client());
    let narrator = Arc::new(Narrator::new(match &llm {
        Some(client) => NarratorConfig::with_client(client.clone(), LLM_CLASS_NAME),
        None => NarratorConfig::default(),
    }));
    let action_adjudicator = Arc::new(ActionAdjudicator::new(llm.clone(), None, None));
    // `new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, narrator,
    // actionAdjudicator, loreAuthor, rollRegistry })` (401).
    let autonomous = Arc::new(
        AutonomousCampaignOrchestrator::new(journal.clone(), rules.clone())
            .with_narrator(narrator.clone())
            .with_action_adjudicator(action_adjudicator.clone())
            .with_lore_author(Arc::new(LoreAuthor::new(lore)))
            .with_roll_registry(rolls.clone() as Arc<dyn CheckRegistry>),
    );
    let traces = FileTraceStore::new(storage.join("turn-traces")).map_err(|error| Failure::new(error.to_string(), None))?;
    // В JS реестр уточнений создаёт сам оркестратор: файл рядом с журналом
    // (`join(eventStore.rootDir, 'clarifications.json')`).
    let clarifications = ClarificationRegistry::new(ClarificationRegistryOptions { storage_file: Some(storage.join("engine").join("clarifications.json")), ttl_ms: None, now: None, id_factory: None })?;
    let clarifications = Arc::new(Mutex::new(clarifications));
    let mut options = GameOrchestratorOptions::new(journal, rules as Arc<dyn TurnRules>);
    options.rule_retriever = Some(Arc::new(Retriever(Arc::downgrade(app))));
    options.trace_store = Some(Arc::new(traces) as Arc<dyn TurnTraceStore>);
    options.narrator = Some(Some(narrator));
    options.npc_social_controller = Some(Arc::new(NpcSocialController::new(llm.clone())));
    options.unknown_action_handler = Some(autonomous.clone());
    // `unknownActionHandler.actionAdjudicator` — тот же судья.
    options.action_adjudicator = Some(action_adjudicator);
    options.lore_voice = Some(Arc::new(LoreVoice::new(llm.clone(), None)));
    options.roll_registry = Some(rolls as Arc<dyn TurnRollRegistry>);
    options.clarification_registry = Some(clarifications.clone());
    let game = GameOrchestrator::new(options).map_err(orchestrator_failure)?;
    let scene_architect = SceneArchitectAgent::new(llm.map(|client| RoleClient::new(client, LLM_CLASS_NAME)));
    Ok(Orchestration { game, autonomous, scene_architect, clarifications })
}

// --- журнал ----------------------------------------------------------------

/// Журнал ядра для оркестраторов: коммит — через [`crate::test_hooks::commit`],
/// чтение — напрямую (как [`crate::projection::HookedJournal`], но владеющий).
pub struct CoreJournal(pub Arc<EventStore>);

impl sk_store::executor::Journal for CoreJournal {
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
        OrchestratorJournal::load_at(self.0.as_ref(), campaign_id, at_version)
    }

    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: Option<i64>) -> Option<StoreResult<Vec<Value>>> {
        OrchestratorJournal::events_between(self.0.as_ref(), campaign_id, after_version, up_to_version)
    }
}

// --- реестр бросков ----------------------------------------------------------

/// `rollRegistry` ядра для оркестраторов (`GameCore::rolls`); займ — только
/// на время синхронного вызова.
struct CoreRolls(Weak<GameCore>);

impl CoreRolls {
    fn with<T>(&self, operation: impl FnOnce(&RefCell<sk_infra::roll_registry::RollRegistry>) -> OrchestratorResult<T>) -> OrchestratorResult<T> {
        let core = self.0.upgrade().ok_or_else(|| OrchestratorError::plain("игровое ядро остановлено"))?;
        operation(&core.rolls)
    }
}

impl CheckRegistry for CoreRolls {
    fn register_check(&self, options: &Value) -> OrchestratorResult<Value> {
        self.with(|rolls| CheckRegistry::register_check(rolls, options))
    }
}

impl TurnRollRegistry for CoreRolls {
    fn get_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<Value> {
        self.with(|rolls| TurnRollRegistry::get_check(rolls, check_id, options))
    }

    fn invalidate_check(&self, check_id: &str, options: &Value) -> OrchestratorResult<bool> {
        self.with(|rolls| TurnRollRegistry::invalidate_check(rolls, check_id, options))
    }

    fn invalidate_proposal(&self, proposal_id: &str, options: &Value) -> OrchestratorResult<bool> {
        self.with(|rolls| TurnRollRegistry::invalidate_proposal(rolls, proposal_id, options))
    }
}

// --- поиск правил ------------------------------------------------------------

/// `ruleRetriever` (`createRuleRetriever(installedRulePacks)`, 320) из каталога
/// пакетов `AppState`.
struct Retriever(std::sync::Weak<AppState>);

impl RuleSearch for Retriever {
    fn search<'a>(&'a self, request: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            let Some(app) = self.0.upgrade() else { return Ok(json!({ "results": [], "confidence": 0, "count": 0 })) };
            app.rules.retriever.search(request).map_err(|error| match error {
                RetrieverError::Type(message) => OrchestratorError::named("TypeError", None, message),
                RetrieverError::Range(message) => OrchestratorError::named("RangeError", None, message),
                RetrieverError::Validation(error) => OrchestratorError::named("RulePackValidationError", None, error.message),
            })
        })
    }
}
