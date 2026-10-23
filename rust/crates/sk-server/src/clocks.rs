//! С17: фоновые драйверы ядра — перенос `server/index.mjs`:
//!
//! - **мировые часы** (2706–2827, 3696–3796): лавка
//!   ([`run_merchant_economy_clock`], три попытки на конфликт версии), голод
//!   пленных ([`run_captive_clock`]), молва ([`run_world_rumor_clock`]) и их
//!   общий драйвер [`nudge_world_clocks`] с пределом оборотов молвы
//!   [`WORLD_RUMOR_BURST_LIMIT`];
//! - **координатор хода боя** (432–467): один `CombatTurnCoordinator` на
//!   ядро — автоход NPC после коммита, `turn_clock` комнаты, автопропуск хода
//!   по сроку (`DND_COMBAT_TURN_TIMEOUT_MS`), удержание автохода маршрутом
//!   `/commands` ([`hold_combat`]);
//! - **координатор последствий** (372–395, 3352–3363): асинхронный прогон
//!   стадий `sk_society::post_commit_coordinator::STAGES` с памятью
//!   выполненных одноразовых стадий на ядро ([`run_post_commit`]),
//!   [`settle_combat_continuation`];
//! - хук «проекция записана» (2829–2835): толчок боя и часов
//!   ([`install`]), толчки при старте (6493–6503, [`startup_nudges`]).
//!
//! Всё живёт на потоке ядра (`thread_local`, без `Send`). Координатору боя и
//! стадиям с моделью нужен `AppState` (клиент модели, настройки): маршруты его
//! передают, а фоновым задачам ядра его даёт [`bind_app`] (зовёт
//! `serve::serve` до приёма соединений).
//!
//! Отклонения от JS:
//!
//! - `CombatTurnCoordinator` в Rust держит займы `&'a dyn …`. Чтобы он жил
//!   на ядре всё время работы, его журнал, движок, контроллер морали и хозяин
//!   таймеров — крошечные адаптеры со слабыми ссылками, выделенные один раз на
//!   поток ядра навсегда (`Box::leak`): они не держат ни базу, ни ядро, и
//!   после остановки ядра отвечают «ядро остановлено».
//! - Таймеры координатора — неучтённые локальные задачи (остановка их не
//!   ждёт, как `setTimeout` при `process.exit`); работа по срабатыванию —
//!   учтённая фоновая задача ядра с настройками ИИ, видимыми при постановке
//!   таймера (у JS — контекст `setTimeout`).
//! - `isSeatUnclaimed` читает членство через соединение аккаунтов живых
//!   потоков (решение ведущего по С9: синхронное чтение на ядре); без
//!   настоящего реестра потоков (заглушка тестов) место считается занятым.
//!   Ошибка чтения — тоже «занято» с записью в лог (в JS — исключение в
//!   `settle`, повтор по сроку).
//! - Сбой `onCommitted`/`onClockChanged` (проекция, летопись, рассылка) в JS
//!   — исключение внутри `settle` с повтором; здесь хозяин координатора не
//!   может вернуть ошибку (трейт `CoordinatorHost`), поэтому сбой пишется в
//!   лог тем же текстом `onError`, а повтора нет.
//! - Стадия `encounter-completion` (`completeEncounter`, О1) не подключена —
//!   это С18.4: прогон её отвергает и в лог пишет, а одноразовую память не
//!   помечает. Прочие стадии без зависимости у JS (`?.()`) — пустой результат,
//!   как там.

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_rules::resolve::api::RulesEngine;
use sk_society::post_commit_coordinator::{PostCommitDeps, StageContext, StageKeyKind, STAGES};
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Executed, Journal, Producer};
use sk_store::{CommitRequest, CommitResult, EventStore, LoadOptions, Loaded, StoreError, StoreResult};
use sk_turns::combat_turn_coordinator::{CombatTurnCoordinator, CoordinatorHost, CoordinatorSettings, HoldHandle, TimerAction};
use sk_turns::npc_turn_scheduler::{run_npc_turn_scheduler, DecisionFuture, NpcController, NpcRulesEngine, NpcTurnJournal, SchedulerError, SchedulerOptions};

use crate::core::{spawn_in_context, GameCore, LocalFuture};
use crate::error::Failure;
use crate::orchestration::{orchestration, CoreJournal, Orchestration};
use crate::projection::{executor_failure, persist_authoritative_projection, with_rules_plan, HookedJournal, PersistOptions};
use crate::room::{get_room, Room};
use crate::state::AppState;

/// Сколько коммитов часов молвы допустимо в одном заходе драйвера (274).
pub const WORLD_RUMOR_BURST_LIMIT: usize = 4;

// --- приложение ядра ---------------------------------------------------------

thread_local! {
    /// `AppState` для фоновых задач ядра (слабая ссылка: ядро не держит
    /// состояние HTTP-слоя).
    static APP: RefCell<std::sync::Weak<AppState>> = RefCell::new(std::sync::Weak::new());
}

/// Сообщить ядру его `AppState` (до приёма соединений): координатору боя и
/// зацепкам героев нужны клиент модели и настройки.
pub async fn bind_app(state: &Arc<AppState>) -> Result<(), crate::core::CoreError> {
    let weak = Arc::downgrade(state);
    state.core.call(move |_core| Box::pin(async move { APP.with(|slot| *slot.borrow_mut() = weak) })).await
}

/// `AppState`, если он ещё жив и привязан к этому ядру.
pub fn app() -> Option<Arc<AppState>> {
    APP.with(|slot| slot.borrow().upgrade())
}

// --- общее -------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    }
}

/// `normalizeCampaignState(state)`.
fn normalize(state: &Value) -> Result<Value, Failure> {
    Ok(sk_rules::normalize::normalize_campaign_state(state)?)
}

fn load(core: &GameCore, campaign_id: &str) -> Result<Loaded, Failure> {
    Ok(core.events.load(campaign_id, &LoadOptions::default())?)
}

/// `${value}` шаблонной строки JS.
fn tpl(value: Option<&Value>) -> String {
    js::string(value)
}

/// `Number(state.mechanics?.world_time?.elapsed_minutes ?? 0)`.
fn elapsed_minutes(state: &Value) -> f64 {
    match get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes") {
        None | Some(Value::Null) => 0.0,
        value => js::number(value),
    }
}

/// `Math.max(0, Number(... ?? 0))`: `NaN` остаётся `NaN`, как у `Math.max`.
fn world_minute(state: &Value) -> f64 {
    let minute = elapsed_minutes(state);
    if minute.is_nan() {
        minute
    } else {
        minute.max(0.0)
    }
}

/// `authoritativeExecutor.executeCommands({ campaignId, idempotencyKey,
/// commands, context })` (контекст получает `actor_ids: []`, как у JS).
pub(crate) fn execute_commands(core: &GameCore, campaign_id: &str, idempotency_key: &str, commands: &[Value], context: Value) -> Result<Executed, Failure> {
    let mut context = context;
    if let Some(map) = context.as_object_mut() {
        map.insert("actor_ids".into(), Value::Array(Vec::new()));
    }
    let journal = HookedJournal(&core.events);
    with_rules_plan(core, |resolve| AuthoritativeExecutor::new(&journal).execute_commands(campaign_id, idempotency_key, commands, &context, resolve)).map_err(executor_failure)
}

/// Итог такта часов: состояние и записанные события.
#[derive(Debug, Clone)]
pub struct ClockRun {
    pub state: Value,
    pub events: Vec<Value>,
}

impl ClockRun {
    fn idle(state: Value) -> Self {
        Self { state, events: Vec::new() }
    }
}

// --- часы лавки (3696–3747) ----------------------------------------------------

/// `runMerchantEconomyClock(campaignId)`: пополнение лавок и событие часов
/// одним прямым коммитом (как в JS — последний прямой писатель), три попытки
/// на `STATE_VERSION_CONFLICT`.
pub fn run_merchant_economy_clock(core: &GameCore, campaign_id: &str) -> Result<ClockRun, Failure> {
    let context = sk_rules::context::Context::from_json(&json!({ "isAdmin": true, "system": true }));
    for attempt in 0..3 {
        let loaded = load(core, campaign_id)?;
        let plans = sk_economy::merchant_economy::plan_merchant_economy_clock(&loaded.state, None);
        if plans.is_empty() {
            return Ok(ClockRun::idle(loaded.state));
        }
        let mut projected = loaded.state.clone();
        let mut events: Vec<Value> = Vec::new();
        let mut engine = RulesEngine::new(Box::new(sk_rules::dice_record::ServiceDice::new(core.dice.clone())));
        for plan in &plans {
            let Some(merchant) = sk_economy::merchant_economy::find_merchant(&projected, plan.get("merchant_id")).cloned() else { continue };
            if let Some(restock) = sk_economy::merchant_economy::merchant_restock_command_from_plan(Some(&merchant), Some(plan)) {
                let command = js::spread(
                    &restock,
                    json!({
                        "command_id": format!("economy-restock:{}:{}", tpl(plan.get("merchant_id")), tpl(plan.get("processed_at_world_minute"))),
                        "expected_state_version": projected.get("state_version").cloned().unwrap_or(Value::Null),
                        "request_fingerprint": format!("clock:{}:{}", tpl(plan.get("scheduled_for_world_minute")), tpl(plan.get("processed_at_world_minute"))),
                    }),
                );
                let resolved = engine.resolve(&command, &projected, &context)?;
                for event in resolved.events {
                    projected = sk_rules::replay::apply_game_event(&projected, &event)?;
                    events.push(event);
                }
            }
            if let Some(clock_event) = sk_economy::merchant_economy::merchant_economy_clock_event_from_plan(Some(&merchant), Some(plan)) {
                projected = sk_rules::replay::apply_game_event(&projected, &clock_event)?;
                events.push(clock_event);
            }
        }
        if events.is_empty() {
            return Ok(ClockRun::idle(loaded.state));
        }
        let minute = js::f64_string(elapsed_minutes(&loaded.state));
        let request = CommitRequest {
            campaign_id: campaign_id.to_string(),
            expected_state_version: loaded.state_version,
            idempotency_key: format!("merchant-economy-clock:{minute}:{}", loaded.state_version),
            command_id: Some(format!("merchant-economy-clock:{minute}")),
            events,
            ..Default::default()
        };
        match crate::test_hooks::commit(&core.events, request) {
            Ok(committed) => return Ok(ClockRun { state: committed.state, events: committed.events }),
            Err(error) if error.code == "STATE_VERSION_CONFLICT" && attempt < 2 => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Failure::new("Не удалось синхронизировать экономические часы", None))
}

// --- часы голода пленных (2724–2768) -------------------------------------------

/// `captiveClockHasWork(campaignId, room)`: калитка без чтения журнала.
pub fn captive_clock_has_work(room: &Room) -> bool {
    let Some(state) = room.state.as_ref() else { return false };
    if sk_director::campaign_lifecycle::assert_campaign_playable(state).is_err() {
        return false;
    }
    !sk_world_life::captives::plan_captive_neglect_commands(state, None).is_empty()
}

/// `runCaptiveClock(campaignId)`: идемпотентный догон голода пленных.
pub fn run_captive_clock(core: &GameCore, campaign_id: &str) -> Result<ClockRun, Failure> {
    let loaded = load(core, campaign_id)?;
    let state = normalize(&loaded.state)?;
    let minute = world_minute(&state);
    let commands = sk_world_life::captives::plan_captive_neglect_commands(&state, Some(&js::num(minute)));
    if commands.is_empty() {
        return Ok(ClockRun::idle(state));
    }
    let key = format!("captive-clock:{}:{}", js::f64_string(minute), loaded.state_version);
    let committed = execute_commands(core, campaign_id, &key, &commands, json!({ "isDirector": true }))?;
    if committed.replayed {
        return Ok(ClockRun::idle(state));
    }
    Ok(ClockRun { state: normalize(&committed.commit.state)?, events: committed.commit.events })
}

// --- часы молвы (2706–2719, 3749–3796) ------------------------------------------

/// `worldRumorClockHasWork(campaignId, room)`: есть ли в летописи поступки.
pub fn world_rumor_clock_has_work(room: &Room) -> bool {
    let Some(state) = room.state.as_ref() else { return false };
    if sk_director::campaign_lifecycle::assert_campaign_playable(state).is_err() {
        return false;
    }
    !array(get(get(Some(state), "world_deeds"), "deeds")).is_empty()
}

/// `runWorldRumorClock(campaignId)`: команды памяти мира (факты, слухи) через
/// общий исполнитель, затем производная реакция мира по состоянию с
/// записанными слухами.
pub fn run_world_rumor_clock(core: &GameCore, campaign_id: &str) -> Result<ClockRun, Failure> {
    let mut events: Vec<Value> = Vec::new();
    let loaded = load(core, campaign_id)?;
    let state = normalize(&loaded.state)?;
    let minute = world_minute(&state);
    let minute_key = js::f64_string(minute);
    let plan = sk_world_time::world_deeds::plan_world_rumor_tick(&state, &json!({ "worldMinute": js::num(minute) }));
    let commands = array(plan.get("commands")).to_vec();
    let mut committed: Option<Executed> = None;
    if !commands.is_empty() {
        let key = format!("world-rumor-clock:{minute_key}:{}", loaded.state_version);
        let executed = execute_commands(core, campaign_id, &key, &commands, json!({ "isDirector": true }))?;
        if !executed.replayed {
            events.extend(executed.commit.events.iter().cloned());
        }
        committed = Some(executed);
    }
    let version_for_key = committed.as_ref().map_or(loaded.state_version, |executed| executed.commit.state_version);
    let key = format!("world-rumor-reputation:{minute_key}:{version_for_key}");
    let derive = |current: &Value, _loaded: &Loaded| -> Result<Vec<Value>, sk_core::RuleError> {
        let normalized = sk_rules::normalize::normalize_campaign_state(current).map_err(|halt| sk_core::RuleError::new(halt.code().unwrap_or("ENGINE_FAULT").to_string(), halt.to_string()))?;
        Ok(sk_world_time::world_deeds::plan_world_rumor_reputation(&normalized))
    };
    let journal = HookedJournal(&core.events);
    let request = DerivedRequest {
        campaign_id,
        idempotency_key: &key,
        events: None,
        derive_events: Some(&derive),
        producer: Some(Producer::WorldRumor),
        derived_from: Vec::new(),
        metadata: Value::Null,
        derive_metadata: None,
    };
    let reputation = AuthoritativeExecutor::new(&journal).commit_derived(request).map_err(executor_failure)?;
    if let Some(reputation) = reputation.as_ref().filter(|executed| !executed.replayed) {
        events.extend(reputation.commit.events.iter().cloned());
    }
    if events.is_empty() {
        return Ok(ClockRun { state, events });
    }
    let last = match (reputation, committed) {
        (Some(reputation), _) => reputation.commit.state,
        (None, Some(committed)) => committed.commit.state,
        (None, None) => load(core, campaign_id)?.state,
    };
    Ok(ClockRun { state: normalize(&last)?, events })
}

// --- драйвер мировых часов (2770–2827) -----------------------------------------

#[derive(Default)]
struct ClockJob {
    running: Cell<bool>,
    pending: Cell<bool>,
}

thread_local! {
    /// `campaignWorldClockJobs`.
    static WORLD_CLOCK_JOBS: RefCell<HashMap<String, Rc<ClockJob>>> = RefCell::new(HashMap::new());
}

/// `nudgeWorldClocks(campaignId)`: один драйвер на кампанию; толчок во время
/// работы ставит ещё один оборот. Такт без работы ничего не пишет, поэтому
/// цепочка «коммит → проекция → толчок» затухает за один-два оборота.
pub fn nudge_world_clocks(core: &Rc<GameCore>, campaign_id: &str) {
    let normalized = campaign_id.to_uppercase();
    if normalized.is_empty() {
        return;
    }
    let job = WORLD_CLOCK_JOBS.with(|jobs| jobs.borrow_mut().entry(normalized.clone()).or_default().clone());
    job.pending.set(true);
    if job.running.get() {
        return;
    }
    job.running.set(true);
    let finish = ClockJobFinish { core: core.clone(), campaign_id: normalized, job, completed: Cell::new(false) };
    // Не поставилась (ядро остановлено) — `finish` уничтожится здесь же и
    // забудет кампанию.
    let _ = spawn_in_context(async move {
        let finish = finish;
        if let Err(error) = drive_world_clocks(&finish.core, &finish.campaign_id, &finish.job).await {
            eprintln!("[Сказание] Не удалось продвинуть мировые часы {}: {}", finish.campaign_id, error.message);
        }
        finish.completed.set(true);
    });
}

/// `finally` драйвера (2820–2825): снять отметку работы и либо начать новый
/// заход по толчку, пришедшему во время этого, либо забыть кампанию. На
/// панике захода, отмене остановкой и несостоявшейся постановке кампания
/// просто забывается: следующая запись проекции толкнёт часы заново (новый
/// заход отсюда мог бы зациклиться на остановленном ядре).
struct ClockJobFinish {
    core: Rc<GameCore>,
    campaign_id: String,
    job: Rc<ClockJob>,
    completed: Cell<bool>,
}

impl Drop for ClockJobFinish {
    fn drop(&mut self) {
        self.job.running.set(false);
        if self.completed.get() && self.job.pending.get() {
            nudge_world_clocks(&self.core, &self.campaign_id);
        } else {
            WORLD_CLOCK_JOBS.with(|jobs| jobs.borrow_mut().remove(&self.campaign_id));
        }
    }
}

/// Записать проекцию такта и дать хукам «проекция записана» отработать до
/// следующего шага — как `await` между тактами в JS: толчок от своей же
/// записи ставит следующий оборот этого же захода.
async fn persist_clock(core: &Rc<GameCore>, campaign_id: &str, run: &ClockRun) -> Result<(), Failure> {
    persist_authoritative_projection(core, campaign_id, &run.state, &run.events, None, PersistOptions::default())?;
    tokio::task::yield_now().await;
    Ok(())
}

async fn drive_world_clocks(core: &Rc<GameCore>, campaign_id: &str, job: &ClockJob) -> Result<(), Failure> {
    let mut rumor_commits = 0usize;
    while job.pending.get() {
        job.pending.set(false);
        let economy = run_merchant_economy_clock(core, campaign_id)?;
        if !economy.events.is_empty() {
            persist_clock(core, campaign_id, &economy).await?;
        }
        // Обе калитки читают комнату: без работы пленных хватает одного чтения.
        let mut gate_room = get_room(core, campaign_id)?;
        if captive_clock_has_work(&gate_room) {
            let captives = run_captive_clock(core, campaign_id)?;
            if !captives.events.is_empty() {
                persist_clock(core, campaign_id, &captives).await?;
            }
            gate_room = get_room(core, campaign_id)?;
        }
        if !world_rumor_clock_has_work(&gate_room) {
            continue;
        }
        // Предохранитель от несходящегося такта (см. JS 2797–2805).
        if rumor_commits >= WORLD_RUMOR_BURST_LIMIT {
            continue;
        }
        let rumor = run_world_rumor_clock(core, campaign_id)?;
        if rumor.events.is_empty() {
            continue;
        }
        rumor_commits += 1;
        if rumor_commits >= WORLD_RUMOR_BURST_LIMIT {
            eprintln!("[Сказание] Часы молвы {campaign_id} не сошлись за {WORLD_RUMOR_BURST_LIMIT} оборотов: такт отложен до следующего сохранения комнаты");
        }
        persist_clock(core, campaign_id, &rumor).await?;
    }
    Ok(())
}

// --- координатор последствий (372–395) -----------------------------------------

/// Запрос одного прогона (`postCommitCoordinator.run({ campaignId, state,
/// events, commitKey, stages, context })`).
pub struct PostCommitRequest<'a> {
    pub campaign_id: &'a str,
    pub state: &'a Value,
    pub events: &'a [Value],
    pub commit_key: &'a str,
    /// Подмножество стадий по именам; `None` — все.
    pub stages: Option<&'a [&'a str]>,
    pub context: Map<String, Value>,
}

/// Итог прогона: `{ ran, skipped, failed, results }`.
#[derive(Debug, Default)]
pub struct PostCommitRun {
    pub ran: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
    /// Результат стадии; `None` — `undefined`.
    pub results: HashMap<String, Option<Value>>,
}

thread_local! {
    /// `postCommitCoordinator.completed`: выполненные одноразовые стадии.
    static POST_COMMIT_DONE: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

fn post_commit_digest(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..20].to_string()
}

/// `String(commitKey || events[0]?.event_id || digest(JSON.stringify(ids)))`.
fn commit_key_for(commit_key: &str, events: &[Value]) -> String {
    if !commit_key.is_empty() {
        return commit_key.to_string();
    }
    if let Some(first) = events.first().and_then(|event| get(Some(event), "event_id")).filter(|id| js::truthy(Some(id))) {
        return js::string(Some(first));
    }
    let ids: Vec<Value> = events
        .iter()
        .map(|event| match get(Some(event), "event_id") {
            None | Some(Value::Null) => Value::String(String::new()),
            Some(id) => id.clone(),
        })
        .collect();
    post_commit_digest(&js::stringify(&Value::Array(ids)))
}

/// Зависимости для `applies`/`key` стадий: из них JS читает только
/// `heroesNeedingHooks` (2871–2874).
fn stage_deps() -> PostCommitDeps {
    PostCommitDeps { heroes_needing_hooks: Some(Box::new(|state, campaign_id| crate::hero_hooks::pending_hero_ids(state, campaign_id).into_iter().map(Value::String).collect())), ..PostCommitDeps::default() }
}

/// Исполнить стадию по имени — зависимости координатора JS (372–395, 2871–2874).
async fn run_stage(core: &Rc<GameCore>, name: &str, context: &StageContext<'_>) -> Result<Option<Value>, String> {
    match name {
        "combat-continuation" => {
            let advance_npc = match context.extra.get("advanceNpc") {
                None => true,
                some => js::truthy(some),
            };
            continue_combat(core, &context.campaign_id, advance_npc).await.map(Some)
        }
        "hero-hooks" => crate::hero_hooks::weave_hero_hooks_for(core, &context.campaign_id).await.map(Some),
        "visible-projection" => {
            let journal_message = context.extra.get("journalMessage").filter(|value| !value.is_null());
            let room = persist_authoritative_projection(core, &context.campaign_id, context.state, context.events, journal_message, PersistOptions::default()).map_err(|error| error.to_string())?;
            Ok(Some(room.map_or(Value::Null, |room| room.to_json())))
        }
        // `completeEncounter` (О1) подключит С18.4: до тех пор стадия не
        // засчитывается.
        "encounter-completion" => Err("Стадия encounter-completion не подключена (С18.4)".to_string()),
        // У JS этих зависимостей нет: `context.deps.x?.(context)` — `undefined`.
        _ => Ok(None),
    }
}

/// `postCommitCoordinator.run(...)`: стадии по порядку `STAGES`; упавшая
/// пишет в лог и повторится следующим вызовом, одноразовые выполненные — нет.
pub async fn run_post_commit(core: &Rc<GameCore>, request: PostCommitRequest<'_>) -> PostCommitRun {
    let deps = stage_deps();
    let context = StageContext {
        extra: request.context,
        campaign_id: request.campaign_id.to_string(),
        state: request.state,
        events: request.events,
        event_types: request.events.iter().map(|event| js::s(get(Some(event), "event_type"))).collect(),
        commit_key: commit_key_for(request.commit_key, request.events),
        stage_key: None,
    };
    let mut run = PostCommitRun::default();
    for stage in STAGES.iter().filter(|stage| request.stages.is_none_or(|names| names.contains(&stage.name))) {
        if !(stage.applies)(&context, &deps) {
            run.skipped.push(stage.name.into());
            continue;
        }
        let Some(key) = (stage.key)(&context, &deps) else {
            run.skipped.push(stage.name.into());
            continue;
        };
        let guard = format!("{} {} {key}", context.campaign_id, stage.name);
        if stage.key_kind == StageKeyKind::Once && POST_COMMIT_DONE.with(|done| done.borrow().contains(&guard)) {
            run.skipped.push(stage.name.into());
            continue;
        }
        let stage_context = StageContext {
            extra: context.extra.clone(),
            campaign_id: context.campaign_id.clone(),
            state: context.state,
            events: context.events,
            event_types: context.event_types.clone(),
            commit_key: context.commit_key.clone(),
            stage_key: Some(key),
        };
        match run_stage(core, stage.name, &stage_context).await {
            Ok(value) => {
                run.results.insert(stage.name.into(), value);
                if stage.key_kind == StageKeyKind::Once {
                    POST_COMMIT_DONE.with(|done| done.borrow_mut().insert(guard));
                }
                run.ran.push(stage.name.into());
            }
            Err(error) => {
                run.failed.push(stage.name.into());
                eprintln!("[Сказание] Стадия {} после коммита не выполнена: {error}", stage.name);
            }
        }
    }
    run
}

/// `continueCombat({ campaignId, advanceNpc })` → `runNpcTurnScheduler`.
async fn continue_combat(core: &Rc<GameCore>, campaign_id: &str, advance_npc: bool) -> Result<Value, String> {
    let app = app().ok_or_else(|| "игровое ядро остановлено".to_string())?;
    let set = orchestration(core, &app).map_err(|error| error.to_string())?;
    let controller: &dyn NpcController = &set.npc_controller;
    let mut options = SchedulerOptions::new(campaign_id, set.journal.as_ref(), set.rules.as_ref());
    options.npc_controller = Some(controller);
    options.advance_npc = advance_npc;
    run_npc_turn_scheduler(options).await.map(|result| result.to_json()).map_err(|error| error.to_string())
}

/// Ходы NPC до хода героя после команды (`settleCombatContinuation`).
#[derive(Debug, Clone, Default)]
pub struct Continued {
    pub turns: Vec<Value>,
    pub events: Vec<Value>,
}

/// `settleCombatContinuation(campaignId, { advanceNpc })` (3352–3363): стадия
/// `combat-continuation` координатора последствий по авторитетному
/// состоянию. Не применима или упала — пусто. Сбой чтения журнала — ошибка.
pub async fn settle_combat_continuation(core: &Rc<GameCore>, campaign_id: &str, advance_npc: bool) -> Result<Continued, Failure> {
    let loaded = load(core, campaign_id)?;
    let mut context = Map::new();
    context.insert("advanceNpc".into(), Value::Bool(advance_npc));
    let commit_key = format!("combat-continuation:{campaign_id}");
    let stages: [&str; 1] = ["combat-continuation"];
    let run = run_post_commit(core, PostCommitRequest { campaign_id, state: &loaded.state, events: &[], commit_key: &commit_key, stages: Some(&stages), context }).await;
    let result = run.results.get("combat-continuation").cloned().flatten();
    Ok(match result {
        Some(value) => Continued { turns: array(value.get("turns")).to_vec(), events: array(value.get("events")).to_vec() },
        None => Continued::default(),
    })
}

// --- координатор хода боя (432–467) --------------------------------------------

fn core_stopped() -> StoreError {
    StoreError::new("CORE_STOPPED", "игровое ядро остановлено")
}

/// Журнал координатора: слабая ссылка на базу ядра, коммит — через тестовые
/// крючки (как `CoreJournal`).
struct WeakJournal(std::sync::Weak<EventStore>);

impl WeakJournal {
    fn with<T>(&self, operation: impl FnOnce(&CoreJournal) -> StoreResult<T>) -> StoreResult<T> {
        let events = self.0.upgrade().ok_or_else(core_stopped)?;
        operation(&CoreJournal(events))
    }
}

impl Journal for WeakJournal {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        self.with(|journal| Journal::load(journal, campaign_id))
    }

    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        self.with(|journal| Journal::commit(journal, request))
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>> {
        self.with(|journal| Journal::get_by_idempotency_key(journal, campaign_id, key))
    }
}

impl NpcTurnJournal for WeakJournal {
    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: i64) -> Option<StoreResult<Vec<Value>>> {
        match self.0.upgrade() {
            Some(events) => Some(events.get_events(campaign_id, after_version, Some(up_to_version))),
            None => Some(Err(core_stopped())),
        }
    }
}

/// Движок координатора: тот же `rulesEngine` ядра, что у оркестраторов.
struct WeakRules(std::sync::Weak<RefCell<RulesEngine>>);

impl NpcRulesEngine for WeakRules {
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, sk_rules::pause::Halt> {
        match self.0.upgrade() {
            Some(rules) => NpcRulesEngine::resolve_plan(rules.as_ref(), commands, state, context),
            None => Err(sk_rules::pause::Halt::Rule(sk_core::RuleError::new("CORE_STOPPED", "игровое ядро остановлено"))),
        }
    }
}

/// Контроллер морали координатора (`npcController`, 398).
struct WeakController(Weak<Orchestration>);

impl NpcController for WeakController {
    fn decide<'a>(&'a self, state: &'a Value, enemy_id: &'a str) -> DecisionFuture<'a> {
        let set = self.0.upgrade();
        Box::pin(async move {
            match set {
                Some(set) => NpcController::decide(&set.npc_controller, state, enemy_id).await,
                None => None,
            }
        })
    }
}

/// Хозяин координатора: таймеры ядра и обратные вызовы `index.mjs:432–467`.
struct TurnHost {
    core: Weak<GameCore>,
    timers: RefCell<HashMap<u64, tokio::task::AbortHandle>>,
    next_timer: Cell<u64>,
}

/// `console.error('[Сказание] Не удалось автоматически продолжить бой …')` (464).
fn log_turn_error(campaign_id: &str, message: &str) {
    eprintln!("[Сказание] Не удалось автоматически продолжить бой {campaign_id}: {message}");
}

impl TurnHost {
    /// `isSeatUnclaimed` (440–445): в кампании с участниками герой без хозяина.
    fn seat_unclaimed(&self, campaign_id: &str, state: &Value, actor_ids: &[String]) -> Result<bool, Failure> {
        let Some(core) = self.core.upgrade() else { return Ok(false) };
        let Some(live) = core.streams.live() else { return Ok(false) };
        let accounts = live.accounts();
        if !accounts.campaign_has_memberships(campaign_id)? {
            return Ok(false);
        }
        let assigned: HashSet<String> = crate::access::assigned_campaign_hero_ids(accounts, campaign_id, state)?.into_iter().collect();
        let heroes: HashSet<String> = crate::access::party_hero_ids(state).into_iter().collect();
        Ok(actor_ids.iter().all(|actor_id| heroes.contains(actor_id) && !assigned.contains(actor_id)))
    }

    /// `onCommitted` (446–462): проекция и строка летописи «Система боя».
    fn committed(&self, campaign_id: &str, state: &Value, events: &[Value], turns: Option<&[Value]>) -> Result<(), Failure> {
        let Some(core) = self.core.upgrade() else { return Ok(()) };
        let options = json!({ "npcTurns": turns.unwrap_or(&[]) });
        let parts = sk_narration::combat_narration::tactical_narration_parts(events, state, Some(&options)).map_err(|error| Failure::new(error.to_string(), None))?;
        let text = [parts.main, parts.sky].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        let anchor = events
            .iter()
            .find_map(|event| get(Some(event), "event_id").filter(|id| js::truthy(Some(id))))
            .or_else(|| get(events.first(), "command_id").filter(|id| !id.is_null()))
            .or_else(|| get(Some(state), "state_version").filter(|version| !version.is_null()));
        let message = match anchor {
            Some(anchor) if !text.is_empty() => Some(json!({
                "id": crate::journal::combat_message_id(&format!("auto-turn:{}", tpl(Some(anchor)))),
                "text": text,
                "turnConsumed": true,
                "speaker": "system",
                "author": "Система боя",
            })),
            _ => None,
        };
        persist_authoritative_projection(&core, campaign_id, state, events, message.as_ref(), PersistOptions::default())?;
        Ok(())
    }
}

impl CoordinatorHost for TurnHost {
    fn set_timer(&self, delay_ms: f64, action: TimerAction) -> u64 {
        let id = self.next_timer.get() + 1;
        self.next_timer.set(id);
        // `setTimeout`: задержка меньше 1 мс (и не число) — 1 мс.
        let delay = if delay_ms.is_finite() && delay_ms >= 1.0 { delay_ms } else { 1.0 };
        let settings = crate::ai_context::capture();
        let task = tokio::task::spawn_local(async move {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            let Some(runtime) = TURNS.with(|slot| slot.get().cloned()) else { return };
            runtime.host.timers.borrow_mut().remove(&id);
            let fired = crate::ai_context::with_campaign_ai(settings, async move {
                let _ = spawn_in_context(async move {
                    runtime.coordinator.timer_fired(&action);
                    runtime.coordinator.run_queued().await;
                });
            });
            fired.await;
        });
        self.timers.borrow_mut().insert(id, task.abort_handle());
        id
    }

    fn clear_timer(&self, timer: u64) {
        if let Some(task) = self.timers.borrow_mut().remove(&timer) {
            task.abort();
        }
    }

    fn is_seat_unclaimed(&self, campaign_id: &str, state: &Value, actor_ids: &[String]) -> bool {
        self.seat_unclaimed(campaign_id, state, actor_ids).unwrap_or_else(|error| {
            log_turn_error(campaign_id, &error.message);
            false
        })
    }

    fn on_committed(&self, campaign_id: &str, state: &Value, events: &[Value], turns: Option<&[Value]>) {
        if let Err(error) = self.committed(campaign_id, state, events, turns) {
            log_turn_error(campaign_id, &error.message);
        }
    }

    fn on_clock_changed(&self, campaign_id: &str, _clock: Option<&Value>) {
        let Some(core) = self.core.upgrade() else { return };
        if let Err(error) = crate::streams::broadcast_campaign_room(&core, campaign_id, None) {
            log_turn_error(campaign_id, &error.message);
        }
    }

    fn on_error(&self, error: &SchedulerError, campaign_id: &str) {
        log_turn_error(campaign_id, &error.to_string());
    }
}

/// Координатор хода боя ядра и его хозяин.
pub struct TurnRuntime {
    coordinator: CombatTurnCoordinator<'static>,
    host: &'static TurnHost,
}

thread_local! {
    /// `combatTurnCoordinator` этого ядра.
    static TURNS: OnceCell<Rc<TurnRuntime>> = const { OnceCell::new() };
}

/// Координатор ядра: собирается при первом толчке, когда ядру известен
/// `AppState` ([`bind_app`]); до этого — `None` (толкать нечего).
fn turns(core: &Rc<GameCore>) -> Option<Rc<TurnRuntime>> {
    if let Some(ready) = TURNS.with(|slot| slot.get().cloned()) {
        return Some(ready);
    }
    let app = app()?;
    let set = match orchestration(core, &app) {
        Ok(set) => set,
        Err(error) => {
            eprintln!("[Сказание] Координатор хода боя не собран: {error}");
            return None;
        }
    };
    // Адаптеры живут, пока жив процесс: один набор на поток ядра (см. шапку).
    let journal: &'static WeakJournal = Box::leak(Box::new(WeakJournal(Arc::downgrade(&core.events))));
    let rules: &'static WeakRules = Box::leak(Box::new(WeakRules(Arc::downgrade(&set.rules))));
    let controller: &'static WeakController = Box::leak(Box::new(WeakController(Rc::downgrade(&set))));
    let host: &'static TurnHost = Box::leak(Box::new(TurnHost { core: Rc::downgrade(core), timers: RefCell::new(HashMap::new()), next_timer: Cell::new(0) }));
    let settings = CoordinatorSettings { timeout_ms: js::num(app.config.combat_turn_timeout_ms), ..CoordinatorSettings::default() };
    let coordinator = CombatTurnCoordinator::new(journal, rules, Some(controller), host, &settings);
    let built = Rc::new(TurnRuntime { coordinator, host });
    Some(TURNS.with(|slot| slot.get_or_init(|| built).clone()))
}

/// `combatTurnCoordinator.nudge(campaignId)`: отложенный `settle` — фоновая
/// задача ядра (`queueMicrotask`).
pub fn nudge_combat(core: &Rc<GameCore>, campaign_id: &str) {
    let Some(runtime) = turns(core) else { return };
    runtime.coordinator.nudge(campaign_id);
    if runtime.coordinator.queued() == 0 {
        return;
    }
    let _ = spawn_in_context(async move { runtime.coordinator.run_queued().await });
}

/// `combatTurnCoordinator.clockFor(campaignId)` — источник `turn_clock`
/// присутствия (`stateWithLivePresence`, 2611).
pub fn turn_clock_for(campaign_id: &str) -> Option<Value> {
    TURNS.with(|slot| slot.get().and_then(|runtime| runtime.coordinator.clock_for(campaign_id)))
}

/// Удержание автохода (`releaseCombatHold`): [`CombatHold::release`] или
/// уничтожение отпускают его, повтор безопасен.
pub struct CombatHold {
    runtime: Rc<TurnRuntime>,
    handle: HoldHandle,
}

impl CombatHold {
    /// `releaseCombatHold?.()`.
    pub fn release(self) {}
}

impl Drop for CombatHold {
    fn drop(&mut self) {
        self.runtime.coordinator.release(&self.handle);
    }
}

/// `combatTurnCoordinator.hold(campaignId)`: пока ход идёт к летописи,
/// координатор не начинает следующий автоход (не дольше своего предела).
pub fn hold_combat(core: &Rc<GameCore>, campaign_id: &str) -> Option<CombatHold> {
    let runtime = turns(core)?;
    let handle = runtime.coordinator.hold(campaign_id, None);
    Some(CombatHold { runtime, handle })
}

// --- хук проекции и запуск ----------------------------------------------------------

/// Хук «проекция записана» (2829–2835): толчок координатора боя и часов мира
/// (рассылку ставит С9 своим хуком раньше этого).
fn clocks_hook(core: Rc<GameCore>, campaign_id: String, _room: Room) -> LocalFuture<()> {
    Box::pin(async move {
        nudge_combat(&core, &campaign_id);
        nudge_world_clocks(&core, &campaign_id);
    })
}

/// Подписать толчки на хук проекции и дать живым потокам часы хода боя (при
/// сборке ядра).
pub fn install(core: &GameCore) {
    crate::projection::subscribe_projection_saved(core, clocks_hook);
    if let Some(live) = core.streams.live() {
        live.set_turn_clock_source(Box::new(turn_clock_for));
    }
}

/// Толчки через 250 мс после `listen` (6495–6499): координатор боя и часы мира
/// для каждой комнаты.
pub fn startup_nudges(core: &Rc<GameCore>, codes: &[String]) {
    for campaign_id in codes {
        nudge_combat(core, campaign_id);
        nudge_world_clocks(core, campaign_id);
    }
}
