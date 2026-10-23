//! Общее состояние HTTP-слоя — сборка служб верхушки `server/index.mjs`
//! (236–467, 2895–2903, 2971–2974, 2997–3010).
//!
//! Разделение по решению ведущего №1: в [`AppState`] — то, что безопасно
//! делить между потоками axum (настройки, аккаунты, учёт расхода, клиенты
//! модели, окна запросов, таблица маршрутов); всё игровое (журнал, кости,
//! реестр бросков, реестр живых потоков, позже — комната, координаторы,
//! оркестраторы) — в [`crate::core::GameCore`] за [`CoreHandle`].
//!
//! Клиенты модели собираются только в `main.rs` и в тестовом наборе
//! (AGENTS §4: `llm-client` знает только точка входа) и попадают сюда через
//! [`Injected::llm`] уже обёрнутыми: тип [`Metered`] нельзя получить мимо
//! `MeteredLLMClient`, поэтому каждый вызов модели проходит учёт расхода.
//!
//! Что добавят следующие задачи (поля — через ведущего): генераторы картинок
//! и сервисы портретов/иллюстраций (С12), журнал трасс (С15), реестр уточнений
//! и оркестраторы (О1/О2), `PostCommitCoordinator` и координатор боя в ядре
//! (С17), прогоны боевого стенда (С5). Пакеты правил, поиск, профили редакций
//! и учёт Архитектора добавил С4.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sk_agents_base::architect_usage::ArchitectUsageStore;
use sk_agents_base::llm_client::{FallbackLlmClient, FallbackLlmClientConfig, FallbackMember};
use sk_dice::{D20Request, Dice, DiceError, Roll, Visibility};
use sk_infra::roll_registry::{RollRegistry, RollRegistryOptions};
use sk_infra::usage_ledger::{DurableUsageLedger, LlmClient, LlmError, MeteredLLMClient, UsageLedgerOptions};
use sk_store::accounts::Accounts;

use crate::config::Config;
use crate::core::{CoreHandle, GameCore};
use crate::dispatch::Route;
use crate::limits::Limits;
use crate::routes::catalog::RuleCatalog;
use crate::streams::{LiveOptions, StreamFactory};

/// Общие кости: один `DiceService` на ядро, реестр бросков и движок, как
/// единственный `diceService` JS.
#[derive(Clone)]
pub struct SharedDice(Arc<Mutex<Box<dyn Dice + Send>>>);

impl SharedDice {
    pub fn new(dice: Box<dyn Dice + Send>) -> Self {
        Self(Arc::new(Mutex::new(dice)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Box<dyn Dice + Send>> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Dice for SharedDice {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError> {
        self.lock().roll(expression, purpose, actor_id, visibility)
    }

    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
        self.lock().roll_d20(request)
    }

    fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError> {
        self.lock().roll_check(request, difficulty)
    }
}

/// Клиент модели, у которого каждый вызов идёт через `MeteredLLMClient`.
#[derive(Clone)]
pub struct Metered(Arc<dyn LlmClient>);

impl Metered {
    /// `new MeteredLLMClient({ client, ledger })`.
    pub fn wrap<C: LlmClient + 'static>(client: C, ledger: &Arc<DurableUsageLedger>) -> Self {
        Self(Arc::new(MeteredLLMClient::new(client, ledger.clone())))
    }

    /// `new FallbackLLMClient({ clients, selectableClients, probeTimeoutMs,
    /// failureCooldownMs })` над уже учтёнными клиентами (`index.mjs:303–308`).
    /// У `MeteredLLMClient` нет `timeoutMs`, поэтому срок модели каскад берёт
    /// по умолчанию — как в JS.
    pub fn cascade(clients: Vec<Metered>, selectable: Vec<Metered>, probe_timeout_ms: f64, failure_cooldown_ms: f64) -> Result<Self, LlmError> {
        let member = |client: Metered| FallbackMember::new(client.0);
        let cascade = FallbackLlmClient::new(FallbackLlmClientConfig {
            clients: clients.into_iter().map(member).collect(),
            selectable_clients: selectable.into_iter().map(member).collect(),
            failure_cooldown_ms: Some(failure_cooldown_ms),
            probe_timeout_ms: Some(probe_timeout_ms),
            now: None,
        })?;
        Ok(Self(Arc::new(cascade)))
    }

    /// Клиент для вызова.
    pub fn client(&self) -> Arc<dyn LlmClient> {
        self.0.clone()
    }

    /// `client.model`.
    pub fn model(&self) -> Option<String> {
        self.0.model()
    }
}

/// Клиенты модели процесса.
#[derive(Clone, Default)]
pub struct LlmClients {
    /// Каскад горячего пути (`llmClient`, `index.mjs:303`).
    pub llm: Option<Metered>,
    /// Летописец длинной формы (`loreLlmClient`, 412–418).
    pub lore: Option<Metered>,
}

/// Сборщик клиентов: получает учёт расхода, созданный [`AppState::open`].
pub type LlmFactory = Box<dyn FnOnce(&Arc<DurableUsageLedger>) -> Result<LlmClients, String> + Send>;

/// Часы процесса (мс), внедряемые в тестах.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Внедряемые зависимости [`AppState::open`].
pub struct Injected {
    /// Источник случайности; `None` — системные кости.
    pub dice: Option<Box<dyn Dice + Send>>,
    /// Сборщик клиентов модели; `None` — без модели (демо-режим).
    pub llm: Option<LlmFactory>,
    /// Часы окон запросов и реестра бросков; `None` — системные.
    pub clock: Option<Clock>,
    /// Сборщик реестра живых потоков, вызывается на потоке ядра; `None` —
    /// настоящий реестр С9 (`streams::LiveStreams`) над базой хранилища.
    pub streams: Option<StreamFactory>,
    /// Дополнительные маршруты (тесты границы); встают в таблицу по номеру строки.
    pub extra_routes: Vec<Route>,
}

impl Default for Injected {
    fn default() -> Self {
        Self { dice: None, llm: None, clock: None, streams: None, extra_routes: Vec::new() }
    }
}

/// Состояние обработчиков.
pub struct AppState {
    pub config: Config,
    /// Аккаунты, сессии, членство, настройки ИИ (`store.mjs`, SQLite).
    pub accounts: Arc<Accounts>,
    /// Игровое ядро в своём потоке.
    pub core: CoreHandle,
    /// `DurableUsageLedger` (`index.mjs:243–246`).
    pub ledger: Arc<DurableUsageLedger>,
    /// `ArchitectUsageStore` (`index.mjs:249–252`).
    pub architect_usage: Arc<ArchitectUsageStore>,
    /// Пакеты правил, поиск и профили редакций (`index.mjs:312–324`).
    pub rules: RuleCatalog,
    /// Клиенты модели (всегда через учёт расхода).
    pub models: LlmClients,
    /// `loginAttempts` и `costlyRequests` (2894–2903).
    pub limits: Limits,
    /// Упорядоченная таблица маршрутов (`routes::table`).
    pub routes: Vec<Route>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    /// Собрать состояние: каталоги, база, учёт расхода, клиенты, ядро.
    pub fn open(config: Config, injected: Injected) -> Result<Self, String> {
        let storage = config.storage_dir.clone();
        // `mkdirSync(generatedDir, { recursive: true })` (241–242).
        std::fs::create_dir_all(storage.join("generated").join("items")).map_err(|error| format!("Не удалось создать каталог хранилища: {error}"))?;
        std::fs::create_dir_all(storage.join("engine")).map_err(|error| format!("Не удалось создать каталог хранилища: {error}"))?;
        let database = storage.join("skazanie.sqlite");
        let clock: Clock = injected.clock.unwrap_or_else(|| Arc::new(sk_core::clock::now_ms));
        let accounts = Accounts::open(&database).map_err(|error| error.message.clone())?.with_clock(clock.clone());
        let mut ledger_options = UsageLedgerOptions::new(storage.join("engine").join("llm-usage.json"));
        ledger_options.daily_token_limit = Some(config.ai_daily_token_limit);
        let ledger = Arc::new(DurableUsageLedger::new(ledger_options).map_err(|error| error.to_string())?);
        let architect_threshold = sk_core::js::num(config.architect_alert_threshold);
        let architect_usage = Arc::new(ArchitectUsageStore::new(storage.join("engine").join("architect-usage.json"), Some(&architect_threshold), Some(clock.clone()))?);
        let rules = RuleCatalog::load(&config.default_ruleset_id, &crate::routes::catalog::rule_packs_root())?;
        let models = match injected.llm {
            Some(factory) => factory(&ledger)?,
            None => LlmClients::default(),
        };
        let dice = SharedDice::new(injected.dice.unwrap_or_else(|| Box::new(sk_dice::DiceService::system())));
        let streams: StreamFactory = injected.streams.unwrap_or_else(|| crate::streams::live_factory(database.clone(), clock.clone(), LiveOptions::default()));
        // С13: импортёр TaleSpire для движка и библиотека карт (`index.mjs:352–356`).
        crate::routes::map_import::install(&config);
        let core = start_core(database, storage.join("engine").join("roll-registry.json"), dice, clock.clone(), streams)?;
        Ok(Self { config, accounts: Arc::new(accounts), core, ledger, architect_usage, rules, models, limits: Limits::new(clock), routes: crate::routes::table(injected.extra_routes) })
    }

    /// Клиент для ролей агентов: `apiKey ? llmClient : null` (310, 397–399…).
    pub fn agent_llm(&self) -> Option<Metered> {
        if self.config.model_configured() {
            self.models.llm.clone()
        } else {
            None
        }
    }

    /// Клиент летописца: `apiKey ? loreLlmClient : null` (419).
    pub fn lore_llm(&self) -> Option<Metered> {
        if self.config.model_configured() {
            self.models.lore.clone()
        } else {
            None
        }
    }
}

// `Drop` у `AppState` нет: последний `Arc` может уйти на потоке tokio или в
// блокирующем потоке ядра, где ждать поток ядра нельзя (рецензия С0,
// CORE-07). Уничтожение `CoreHandle` только закрывает приём заданий, а
// дожидается ядра явно `main` и тестовый набор (`core.shutdown()`).

fn start_core(database: PathBuf, roll_file: PathBuf, dice: SharedDice, clock: Clock, streams: StreamFactory) -> Result<CoreHandle, String> {
    CoreHandle::start("skazanie-core", move || {
        let events = sk_tactics::cutover_audit::open_game_store(&database, Arc::new(sk_tactics::cutover_audit::GameReducer::new()))?;
        let options = RollRegistryOptions { storage_file: Some(roll_file), now: clock, ..RollRegistryOptions::default() };
        let rolls = RollRegistry::new(Box::new(dice.clone()), options).map_err(|error| error.to_string())?;
        let core = GameCore { events: Arc::new(events), rolls: std::cell::RefCell::new(rolls), dice, streams: streams()?, room_hooks: std::cell::RefCell::default() };
        // С9: рассылка комнаты на каждую запись проекции (`onRoomSaved`, 2829–2835).
        crate::streams::install(&core);
        // С17 (правка общего файла): толчки боя и часов мира, затем зацепки
        // героев — тем же порядком подписки, что `onRoomSaved` в JS (2829, 2876).
        crate::clocks::install(&core);
        crate::hero_hooks::install(&core);
        Ok(core)
    })
}
