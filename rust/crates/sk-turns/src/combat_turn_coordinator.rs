//! Перенос `server/combat-turn-coordinator.mjs`: один владелец продвижения
//! боёв.
//!
//! - чистые функции часов хода: [`active_turn_actor_ids`],
//!   [`turn_activity_key`], [`combat_turn_clock`], [`combat_turn_clock_for_state`];
//! - [`CombatTurnCoordinator`] — после каждого коммита исполняет ходы NPC
//!   ([`run_npc_turn_scheduler`]), выводит срок хода героя из durable
//!   `TurnStarted` и по истечении коммитит авто-пропуск с устойчивым
//!   идемпотентным ключом; ошибка ставит повтор с ограниченной
//!   экспоненциальной задержкой.
//!
//! Таймеры и `queueMicrotask` JS здесь — данные: хозяин рантайма
//! ([`CoordinatorHost`]) ставит таймер с [`TimerAction`] и по срабатыванию
//! зовёт [`CombatTurnCoordinator::timer_fired`]; отложенный `settle`
//! («микрозадача») ждёт в очереди [`CombatTurnCoordinator::run_queued`].
//! Координатор однопоточный (`RefCell`): один на рантайм-поток, как один
//! процесс Node.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll, Waker};

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{clock, game, hash, js, text};
use sk_rules::combat::turn::initiative_group_ids;
use sk_rules::normalize::normalize_campaign_state_cow;
use sk_rules::pause::{Fault, Halt};
use sk_society::parley::truce_holds;
use sk_store::executor::Executed;
use sk_store::Loaded;

use crate::npc_turn_scheduler::{execute_plan, run_npc_turn_scheduler_marked, NpcController, NpcRulesEngine, NpcTurnJournal, SchedulerError, SchedulerOptions, SchedulerResult};

pub const DEFAULT_TURN_TIMEOUT_MS: i64 = 120_000;
/// Ход героя, которого не занял ни один участник кампании.
pub const DEFAULT_UNCLAIMED_TURN_TIMEOUT_MS: i64 = 3_000;
pub const DEFAULT_RETRY_BASE_DELAY_MS: i64 = 250;
/// Потолок продления хода действующим игроком — столько сроков от начала.
pub const ACTIVE_TURN_LIMIT_FACTOR: i64 = 3;
pub const DEFAULT_RETRY_MAX_DELAY_MS: i64 = 30_000;
pub const DEFAULT_RETRY_BACKOFF_STEPS: i64 = 8;
/// Предел удержания автохода (`hold`).
pub const DEFAULT_HOLD_MAX_MS: i64 = 12_000;

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    }
}

/// `String(value ?? '').trim().toUpperCase()`.
pub fn normalized_campaign_id(value: &str) -> String {
    text::trim(value).to_uppercase()
}

/// `keyPart(value)` координатора: регулярка с флагом `u` — замена по кодовым точкам.
fn key_part(value: &str) -> String {
    let replaced: String = value.chars().map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '-' }).take(60).collect();
    if replaced.is_empty() {
        "none".into()
    } else {
        replaced
    }
}

fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// `positiveTimeout(value)`.
pub fn positive_timeout(value: Option<&Value>) -> i64 {
    let number = js::number(value);
    if safe_integer(number) && (50.0..=3_600_000.0).contains(&number) {
        number as i64
    } else {
        DEFAULT_TURN_TIMEOUT_MS
    }
}

/// `positiveRetryDelay(value, fallback)`.
fn positive_retry_delay(value: Option<&Value>, fallback: i64) -> i64 {
    let number = js::number(value);
    if safe_integer(number) && (1.0..=3_600_000.0).contains(&number) {
        number as i64
    } else {
        fallback
    }
}

/// `positiveRetrySteps(value)`.
fn positive_retry_steps(value: Option<&Value>) -> i64 {
    let number = js::number(value);
    if safe_integer(number) && (1.0..=20.0).contains(&number) {
        number as i64
    } else {
        DEFAULT_RETRY_BACKOFF_STEPS
    }
}

fn combat_of(state: &Value) -> Option<&Value> {
    get(get(Some(state), "mechanics"), "combat")
}

/// `activeTurnActorIds(rawState)`: кто ещё не завершил ход текущей фазы.
pub fn active_turn_actor_ids(raw_state: &Value) -> Result<Vec<String>, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    Ok(active_ids_normalized(&state))
}

fn active_ids_normalized(state: &Value) -> Vec<String> {
    let combat = combat_of(state);
    let initiative = match get(combat, "initiative") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return Vec::new(),
    };
    if !js::truthy(get(combat, "active")) {
        return Vec::new();
    }
    let window_actor = get(get(combat, "reaction_window"), "actor_id");
    if js::truthy(window_actor) {
        return vec![js::string(window_actor)];
    }
    let completed: IndexSet<String> = list(get(combat, "turn_completed")).iter().map(|id| js::string(Some(id))).collect();
    let grouped = initiative_group_ids(state);
    let ids = if grouped.is_empty() {
        let index = js::number(get(combat, "active_index"));
        let entry = (index >= 0.0 && index.fract() == 0.0 && index < initiative.len() as f64).then(|| &initiative[index as usize]);
        vec![js::s(get(entry, "actor_id"))]
    } else {
        grouped
    };
    ids.into_iter().filter(|id| !id.is_empty() && !completed.contains(id)).collect()
}

/// `timedTurnActorIds(state)`: владельцы часов. Вход уже нормализован
/// (`activeTurnActorIds` JS нормализует его повторно; нормализация идемпотентна
/// — на корпусе 10336/10336 состояний, Ск3 — поэтому второй проход опущен).
fn timed_turn_actor_ids(state: &Value) -> Vec<String> {
    let ids = active_ids_normalized(state);
    if ids.is_empty() {
        return ids;
    }
    let combat = combat_of(state);
    if js::truthy(get(get(combat, "reaction_window"), "actor_id")) || js::is_true(get(combat, "group_initiative")) {
        return ids.into_iter().take(1).collect();
    }
    ids
}

/// `turnActivityKey(rawState)`: отпечаток экономики хода владельцев часов.
pub fn turn_activity_key(raw_state: &Value) -> Result<String, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    Ok(activity_key_normalized(&state))
}

/// [`turn_activity_key`] по уже нормализованному состоянию.
fn activity_key_normalized(state: &Value) -> String {
    let economy = get(combat_of(state), "action_economy");
    let rows: Vec<Value> = timed_turn_actor_ids(state)
        .into_iter()
        .map(|actor_id| {
            let entry = get(economy, &actor_id);
            let field = |key: &str| get(entry, key).cloned().unwrap_or(Value::Null);
            json!([actor_id, field("action"), field("bonus_action"), field("movement_spent"), field("attacks_used"), field("object_interaction"), field("extra_actions")])
        })
        .collect();
    js::stringify(&Value::Array(rows))
}

/// Параметры `combatTurnClock`.
#[derive(Debug, Clone)]
pub struct ClockOptions {
    /// `timeoutMs` как пришёл (число или мусор — `positiveTimeout`).
    pub timeout_ms: Value,
    /// `now` — миллисекунды.
    pub now: f64,
    pub previous_clock: Option<Value>,
    pub activity_at: Option<Value>,
}

impl Default for ClockOptions {
    fn default() -> Self {
        Self { timeout_ms: Value::from(DEFAULT_TURN_TIMEOUT_MS), now: clock::now_ms() as f64, previous_clock: None, activity_at: None }
    }
}

impl ClockOptions {
    /// Из объекта JS `{ timeoutMs, now, previousClock, activityAt }`.
    pub fn from_json(options: Option<&Value>) -> Self {
        let mut result = Self::default();
        if let Some(timeout) = get(options, "timeoutMs") {
            result.timeout_ms = timeout.clone();
        }
        if let Some(now) = get(options, "now") {
            result.now = js::number(Some(now));
        }
        result.previous_clock = get(options, "previousClock").cloned();
        result.activity_at = get(options, "activityAt").cloned();
        result
    }
}

/// `Date.parse(String(value ?? ''))`.
fn date_parse(value: Option<&Value>) -> f64 {
    let text = js::s(value);
    clock::parse_iso(&text).map_or(f64::NAN, |ms| ms as f64)
}

/// `new Date(ms).toISOString()`: вне диапазона дат — `RangeError`.
fn iso(ms: f64) -> Result<String, Halt> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return Err(Halt::Fault(Fault::new("RangeError", "Invalid time value")));
    }
    Ok(clock::iso(ms.trunc() as i64))
}

/// `combatTurnClock(rawState, events, { timeoutMs, now, previousClock, activityAt })`.
pub fn combat_turn_clock(raw_state: &Value, events: &[Value], options: &ClockOptions) -> Result<Option<Value>, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    clock_normalized(&state, events, options)
}

/// [`combat_turn_clock`] по уже нормализованному состоянию.
fn clock_normalized(state: &Value, events: &[Value], options: &ClockOptions) -> Result<Option<Value>, Halt> {
    let combat = combat_of(state);
    if !js::truthy(get(combat, "active")) {
        return Ok(None);
    }
    if truce_holds(state) {
        return Ok(None);
    }
    let actor_ids = timed_turn_actor_ids(state);
    if actor_ids.is_empty() || actor_ids.iter().all(|id| game::is_enemy_actor(state, id)) {
        return Ok(None);
    }
    let window = get(combat, "reaction_window");
    let window_id = js::s(get(window, "id"));
    let fallback = events.iter().rev().find(|event| {
        let kind = get(Some(event), "event_type").and_then(Value::as_str);
        if !window_id.is_empty() {
            kind == Some("ReactionWindowOpened") && js::s(get(get(Some(event), "payload"), "id")) == window_id
        } else {
            matches!(kind, Some("TurnStarted" | "ReactionWindowClosed"))
        }
    });
    let (projected_at, projected_event) = if window_id.is_empty() { (get(combat, "turn_started_at"), get(combat, "turn_started_event_id")) } else { (get(window, "opened_at"), get(window, "opened_event_id")) };
    let round = number_or(get(combat, "round"), 1.0);
    let active_index = number_or(get(combat, "active_index"), 0.0);
    let previous = options.previous_clock.as_ref().filter(|clock| js::truthy(Some(clock)));
    let previous_matches = previous.is_some_and(|clock| {
        let clock = Some(clock);
        js::number(get(clock, "round")) == round
            && js::number(get(clock, "active_index")) == active_index
            && js::s(get(clock, "reaction_window_id")) == window_id
            && matches!(get(clock, "actor_ids"), Some(Value::Array(ids)) if ids.len() == actor_ids.len() && actor_ids.iter().enumerate().all(|(index, id)| js::string(ids.get(index)) == *id))
    });
    let previous_started = if previous_matches { get(previous, "started_at") } else { None };
    let started_at = nullish(nullish(projected_at, get(fallback, "created_at")), previous_started);
    let previous_event = if previous_matches {
        let turn_id = js::s(get(previous, "turn_id"));
        turn_id.strip_prefix("event:").map(|rest| Value::String(rest.to_string()))
    } else {
        None
    };
    let started_event = nullish(projected_event, get(fallback, "event_id")).cloned().filter(|value| !value.is_null()).or(previous_event);
    let started_ms = date_parse(started_at);
    let safe_started = if started_ms.is_finite() { started_ms } else { options.now };
    let duration = positive_timeout(Some(&options.timeout_ms)) as f64;
    let activity_ms = date_parse(options.activity_at.as_ref());
    let active_ms = (activity_ms.is_finite() && activity_ms > safe_started).then_some(activity_ms);
    let deadline = match active_ms {
        None => safe_started + duration,
        Some(active) => (active + duration).min(safe_started + duration * ACTIVE_TURN_LIMIT_FACTOR as f64),
    };
    let started_iso = iso(safe_started)?;
    let turn_id = match started_event.filter(|value| js::truthy(Some(value))) {
        Some(event) => format!("event:{}", js::string(Some(&event))),
        None => format!("legacy:{}:{}:{}", js::f64_string(round), js::f64_string(active_index), started_iso),
    };
    let mut result = Map::new();
    result.insert("actor_ids".into(), js::strings_value(actor_ids));
    result.insert("round".into(), js::num(round));
    result.insert("active_index".into(), js::num(active_index));
    result.insert("turn_id".into(), Value::String(turn_id));
    result.insert("started_at".into(), Value::String(started_iso));
    result.insert("deadline_at".into(), Value::String(iso(deadline)?));
    result.insert("duration_ms".into(), js::num(duration));
    if let Some(active) = active_ms {
        result.insert("activity_at".into(), Value::String(iso(active)?));
    }
    if !window_id.is_empty() {
        result.insert("reaction_window_id".into(), Value::String(window_id));
    }
    Ok(Some(Value::Object(result)))
}

/// `combatTurnClockForState(rawState, clock)`: часы, если они всё ещё про
/// текущий ход.
pub fn combat_turn_clock_for_state(raw_state: &Value, clock: Option<&Value>) -> Result<Option<Value>, Halt> {
    let Some(clock) = clock.filter(|clock| js::truthy(Some(clock))) else { return Ok(None) };
    let state = normalize_campaign_state_cow(raw_state)?;
    Ok(clock_for_normalized_state(&state, clock))
}

/// [`combat_turn_clock_for_state`] по уже нормализованному состоянию (Ск3:
/// рассылка комнаты нормализует состояние сама и не платит за второй проход).
pub fn combat_turn_clock_for_normalized_state(state: &Value, clock: Option<&Value>) -> Option<Value> {
    let clock = clock.filter(|clock| js::truthy(Some(clock)))?;
    clock_for_normalized_state(state, clock)
}

fn clock_for_normalized_state(state: &Value, clock: &Value) -> Option<Value> {
    let combat = combat_of(state);
    if !js::truthy(get(combat, "active")) || js::number(get(Some(clock), "round")) != number_or(get(combat, "round"), 1.0) || js::number(get(Some(clock), "active_index")) != number_or(get(combat, "active_index"), 0.0) {
        return None;
    }
    let expected = timed_turn_actor_ids(state);
    let actual: Vec<String> = list(get(Some(clock), "actor_ids")).iter().map(|id| js::string(Some(id))).collect();
    if expected != actual {
        return None;
    }
    Some(clock.clone())
}

/// Итог авто-пропуска: коммит исполнителя или ничего (некого пропускать).
#[derive(Debug, Clone)]
pub enum TimedOut {
    Committed(Box<Executed>),
    Nothing { state: std::sync::Arc<Value>, state_version: i64 },
}

impl TimedOut {
    pub fn events(&self) -> &[Value] {
        match self {
            Self::Committed(executed) => &executed.commit.events,
            Self::Nothing { .. } => &[],
        }
    }
}

fn short_sha(text: &str) -> String {
    hash::sha256_hex(text).chars().take(20).collect()
}

/// `commitTimedOutTurn({ campaignId, eventStore, rulesEngine, loaded, clock })`.
pub fn commit_timed_out_turn(journal: &dyn NpcTurnJournal, rules_engine: &dyn NpcRulesEngine, campaign_id: &str, loaded: &Loaded, clock: Option<&Value>) -> Result<TimedOut, SchedulerError> {
    let combat = combat_of(&loaded.state);
    let eligible: IndexSet<String> = active_turn_actor_ids(&loaded.state)?.into_iter().collect();
    let actor_ids: Vec<String> = list(get(clock, "actor_ids")).iter().map(|id| js::string(Some(id))).filter(|id| eligible.contains(id)).collect();
    if actor_ids.is_empty() {
        return Ok(TimedOut::Nothing { state: loaded.state.clone(), state_version: loaded.state_version });
    }
    let actor_fingerprint = short_sha(&actor_ids.join("\0"));
    let window_id = js::s(get(get(combat, "reaction_window"), "id"));
    let round = js::string(get(combat, "round"));
    let active_index = js::string(get(combat, "active_index"));
    let turn_source = match get(clock, "turn_id") {
        Some(value) if !value.is_null() => js::string(Some(value)),
        _ => format!("legacy:{round}:{active_index}"),
    };
    let turn_fingerprint = short_sha(&turn_source);
    let campaign_part: String = key_part(campaign_id).chars().take(40).collect();
    let key = if window_id.is_empty() {
        format!("turn-timeout:{campaign_part}:r{round}:i{active_index}:{actor_fingerprint}:{turn_fingerprint}")
    } else {
        format!("reaction-timeout:{campaign_part}:{}", short_sha(&window_id))
    };
    let commands: Vec<Value> = actor_ids
        .iter()
        .enumerate()
        .map(|(index, actor_id)| {
            let mut command = Map::new();
            command.insert("command_type".into(), Value::from(if window_id.is_empty() { "EndTurn" } else { "UseCombatAction" }));
            command.insert("command_id".into(), Value::String(format!("{key}:{}", index + 1)));
            command.insert("campaign_id".into(), Value::from(campaign_id));
            command.insert("actor_id".into(), Value::String(actor_id.clone()));
            if !window_id.is_empty() {
                command.insert("action_id".into(), Value::from("decline-reaction"));
            }
            command.insert("server_authoritative".into(), Value::Bool(true));
            command.insert("auto_skip_reason".into(), Value::from("turn-timeout"));
            Value::Object(command)
        })
        .collect();
    let context = json!({ "isAdmin": true, "serverAuthoritativeCombat": true, "actor_ids": [] });
    let executed = execute_plan(journal, rules_engine, campaign_id, &key, &commands, &context, 1)?;
    Ok(TimedOut::Committed(Box::new(executed)))
}

/// Что сделать по срабатыванию таймера (в JS — замыкание `setTimeout`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerAction {
    /// Срок хода или повтор: `entry.timer = null; nudge(campaignId)`.
    Nudge { campaign_id: String, generation: u64 },
    /// Предел удержания автохода.
    ReleaseHold { campaign_id: String, hold: u64 },
}

/// Будущее хозяина.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Рантайм координатора: часы, таймеры и обратные вызовы (`now`, `setTimer`,
/// `clearTimer`, `isSeatUnclaimed`, `runNpcTurns`, `onCommitted`,
/// `onClockChanged`, `onError`).
pub trait CoordinatorHost {
    fn now(&self) -> f64 {
        clock::now_ms() as f64
    }
    /// `setTimer(callback, delay)`: id таймера.
    fn set_timer(&self, delay_ms: f64, action: TimerAction) -> u64;
    fn clear_timer(&self, _timer: u64) {}
    fn is_seat_unclaimed(&self, _campaign_id: &str, _state: &Value, _actor_ids: &[String]) -> bool {
        false
    }
    /// Своя замена планировщика (`runNpcTurns`); `None` — настоящий.
    fn run_npc_turns<'a>(&'a self, _campaign_id: &'a str) -> Option<HostFuture<'a, Result<SchedulerResult, SchedulerError>>> {
        None
    }
    fn on_committed(&self, _campaign_id: &str, _state: &Value, _events: &[Value], _turns: Option<&[Value]>) {}
    fn on_clock_changed(&self, _campaign_id: &str, _clock: Option<&Value>) {}
    fn on_error(&self, _error: &SchedulerError, _campaign_id: &str) {}
}

/// Настройки `new CombatTurnCoordinator({ ... })` (числа — как пришли).
#[derive(Debug, Clone)]
pub struct CoordinatorSettings {
    pub timeout_ms: Value,
    pub unclaimed_timeout_ms: Value,
    pub retry_base_delay_ms: Value,
    pub retry_max_delay_ms: Value,
    pub retry_backoff_steps: Value,
}

impl Default for CoordinatorSettings {
    fn default() -> Self {
        Self {
            timeout_ms: Value::from(DEFAULT_TURN_TIMEOUT_MS),
            unclaimed_timeout_ms: Value::from(DEFAULT_UNCLAIMED_TURN_TIMEOUT_MS),
            retry_base_delay_ms: Value::from(DEFAULT_RETRY_BASE_DELAY_MS),
            retry_max_delay_ms: Value::from(DEFAULT_RETRY_MAX_DELAY_MS),
            retry_backoff_steps: Value::from(DEFAULT_RETRY_BACKOFF_STEPS),
        }
    }
}

#[derive(Debug, Default)]
struct Entry {
    running: bool,
    pending: bool,
    timer: Option<u64>,
    clock: Option<Value>,
    retry_attempt: i64,
    holds: IndexMap<u64, Option<u64>>,
    activity_key: Option<String>,
    generation: u64,
}

/// Удержание автохода: [`CombatTurnCoordinator::release`] отпускает его,
/// повторное отпускание безопасно.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldHandle {
    campaign_id: String,
    id: u64,
}

/// `CombatTurnCoordinator`.
pub struct CombatTurnCoordinator<'a> {
    journal: &'a dyn NpcTurnJournal,
    rules_engine: &'a dyn NpcRulesEngine,
    npc_controller: Option<&'a dyn NpcController>,
    host: &'a dyn CoordinatorHost,
    timeout_ms: i64,
    unclaimed_timeout_ms: i64,
    retry_base_delay_ms: i64,
    retry_max_delay_ms: i64,
    retry_backoff_steps: i64,
    entries: RefCell<IndexMap<String, Entry>>,
    queue: RefCell<VecDeque<String>>,
    wakers: RefCell<Vec<Waker>>,
    serial: Cell<u64>,
}

impl<'a> CombatTurnCoordinator<'a> {
    pub fn new(journal: &'a dyn NpcTurnJournal, rules_engine: &'a dyn NpcRulesEngine, npc_controller: Option<&'a dyn NpcController>, host: &'a dyn CoordinatorHost, settings: &CoordinatorSettings) -> Self {
        let timeout_ms = positive_timeout(Some(&settings.timeout_ms));
        let retry_base_delay_ms = positive_retry_delay(Some(&settings.retry_base_delay_ms), DEFAULT_RETRY_BASE_DELAY_MS);
        Self {
            journal,
            rules_engine,
            npc_controller,
            host,
            timeout_ms,
            unclaimed_timeout_ms: timeout_ms.min(positive_timeout(Some(&settings.unclaimed_timeout_ms))),
            retry_base_delay_ms,
            retry_max_delay_ms: retry_base_delay_ms.max(positive_retry_delay(Some(&settings.retry_max_delay_ms), DEFAULT_RETRY_MAX_DELAY_MS)),
            retry_backoff_steps: positive_retry_steps(Some(&settings.retry_backoff_steps)),
            entries: RefCell::new(IndexMap::new()),
            queue: RefCell::new(VecDeque::new()),
            wakers: RefCell::new(Vec::new()),
            serial: Cell::new(0),
        }
    }

    fn next_serial(&self) -> u64 {
        let next = self.serial.get() + 1;
        self.serial.set(next);
        next
    }

    /// `clockFor(campaignId)`: копия текущих часов кампании.
    pub fn clock_for(&self, campaign_id: &str) -> Option<Value> {
        self.entries.borrow().get(&normalized_campaign_id(campaign_id)).and_then(|entry| entry.clock.clone())
    }

    fn with_entry<T>(&self, id: &str, update: impl FnOnce(&mut Entry) -> T) -> T {
        let mut entries = self.entries.borrow_mut();
        if !entries.contains_key(id) {
            let generation = self.next_serial();
            entries.insert(id.to_string(), Entry { generation, ..Entry::default() });
        }
        update(entries.get_mut(id).expect("запись кампании только что создана"))
    }

    fn existing<T>(&self, id: &str, update: impl FnOnce(&mut Entry) -> T) -> Option<T> {
        self.entries.borrow_mut().get_mut(id).map(update)
    }

    /// `nudge(campaignId)`: отложенный `settle` (микрозадача JS) — в очередь
    /// [`Self::run_queued`].
    pub fn nudge(&self, campaign_id: &str) {
        let id = normalized_campaign_id(campaign_id);
        if id.is_empty() {
            return;
        }
        let running = self.with_entry(&id, |entry| {
            entry.pending = true;
            entry.running
        });
        if !running {
            self.queue.borrow_mut().push_back(id);
        }
    }

    /// Исполнить отложенные `settle` по порядку.
    pub async fn run_queued(&self) {
        loop {
            let next = self.queue.borrow_mut().pop_front();
            let Some(id) = next else { break };
            self.settle(&id).await;
        }
    }

    /// Сколько отложенных `settle` ждёт.
    pub fn queued(&self) -> usize {
        self.queue.borrow().len()
    }

    /// `settleNow(campaignId)`.
    pub async fn settle_now(&self, campaign_id: &str) {
        let id = normalized_campaign_id(campaign_id);
        if id.is_empty() {
            return;
        }
        self.with_entry(&id, |entry| entry.pending = true);
        self.settle(&id).await;
    }

    /// `hold(campaignId, { maxMs })`: придержать автоход кампании.
    pub fn hold(&self, campaign_id: &str, max_ms: Option<&Value>) -> HoldHandle {
        let id = normalized_campaign_id(campaign_id);
        if id.is_empty() {
            return HoldHandle { campaign_id: id, id: 0 };
        }
        let hold = self.next_serial();
        self.with_entry(&id, |entry| {
            entry.holds.insert(hold, None);
        });
        let delay = positive_retry_delay(max_ms, DEFAULT_HOLD_MAX_MS) as f64;
        let timer = self.host.set_timer(delay, TimerAction::ReleaseHold { campaign_id: id.clone(), hold });
        self.existing(&id, |entry| {
            if let Some(slot) = entry.holds.get_mut(&hold) {
                *slot = Some(timer);
            }
        });
        HoldHandle { campaign_id: id, id: hold }
    }

    /// Отпустить удержание (повторный вызов ничего не делает).
    pub fn release(&self, handle: &HoldHandle) {
        let removed = self.existing(&handle.campaign_id, |entry| entry.holds.shift_remove(&handle.id)).flatten();
        if let Some(timer) = removed {
            if let Some(timer) = timer {
                self.host.clear_timer(timer);
            }
            self.wake();
        }
    }

    fn wake(&self) {
        for waker in self.wakers.borrow_mut().drain(..) {
            waker.wake();
        }
    }

    /// `close()`: снять таймеры, отпустить удержания, забыть кампании.
    pub fn close(&self) {
        let entries: Vec<Entry> = self.entries.borrow_mut().drain(..).map(|(_, entry)| entry).collect();
        for entry in entries {
            if let Some(timer) = entry.timer {
                self.host.clear_timer(timer);
            }
            for timer in entry.holds.values().flatten() {
                self.host.clear_timer(*timer);
            }
        }
        self.queue.borrow_mut().clear();
        self.wake();
    }

    /// Сработал таймер, поставленный через [`CoordinatorHost::set_timer`].
    pub fn timer_fired(&self, action: &TimerAction) {
        match action {
            TimerAction::Nudge { campaign_id, generation } => {
                self.existing(campaign_id, |entry| {
                    if entry.generation == *generation {
                        entry.timer = None;
                    }
                });
                self.nudge(campaign_id);
            }
            TimerAction::ReleaseHold { campaign_id, hold } => self.release(&HoldHandle { campaign_id: campaign_id.clone(), id: *hold }),
        }
    }

    fn schedule_retry(&self, id: &str, generation: u64) {
        let delay = self.existing(id, |entry| {
            if entry.generation != generation {
                return None;
            }
            entry.pending = false;
            entry.retry_attempt = (entry.retry_attempt + 1).min(self.retry_backoff_steps);
            let factor = 2f64.powi((entry.retry_attempt - 1) as i32);
            Some((self.retry_max_delay_ms as f64).min(self.retry_base_delay_ms as f64 * factor))
        });
        if let Some(Some(delay)) = delay {
            let timer = self.host.set_timer(delay, TimerAction::Nudge { campaign_id: id.to_string(), generation });
            self.existing(id, |entry| entry.timer = Some(timer));
        }
    }

    async fn settle(&self, id: &str) {
        let start = self.existing(id, |entry| {
            if entry.running {
                None
            } else {
                entry.running = true;
                Some(entry.generation)
            }
        });
        let Some(Some(generation)) = start else { return };
        if let Err(error) = self.settle_loop(id, generation).await {
            self.schedule_retry(id, generation);
            if !matches!(error.code(), Some("STATE_VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT")) {
                self.host.on_error(&error, id);
            }
        }
        let pending = self.existing(id, |entry| {
            if entry.generation != generation {
                return false;
            }
            entry.running = false;
            entry.pending
        });
        if pending == Some(true) {
            self.queue.borrow_mut().push_back(id.to_string());
        }
    }

    fn holds_released(&self, id: &str) -> HoldsReleased<'_, 'a> {
        HoldsReleased { coordinator: self, id: id.to_string() }
    }

    async fn settle_loop(&self, id: &str, generation: u64) -> Result<(), SchedulerError> {
        loop {
            let pending = self.existing(id, |entry| entry.generation == generation && entry.pending).unwrap_or(false);
            if !pending {
                return Ok(());
            }
            self.holds_released(id).await;
            let timer = self.existing(id, |entry| {
                entry.pending = false;
                entry.timer.take()
            });
            if let Some(Some(timer)) = timer {
                self.host.clear_timer(timer);
            }
            let sched_span = sk_store::perf::span("combat.scheduler");
            let (npc, npc_normalized) = match self.host.run_npc_turns(id) {
                Some(future) => (future.await?, false),
                None => {
                    let mut options = SchedulerOptions::new(id, self.journal, self.rules_engine);
                    options.npc_controller = self.npc_controller;
                    options.advance_npc = true;
                    run_npc_turn_scheduler_marked(options).await?
                }
            };
            drop(sched_span);
            let load_span = sk_store::perf::span("combat.load");
            let mut loaded = self.journal.load(id)?;
            drop(load_span);
            if !npc.events.is_empty() {
                self.host.on_committed(id, &loaded.state, &npc.events, Some(&npc.turns));
            }
            let clock_span = sk_store::perf::span("combat.clock");
            // Одна нормализация на оборот (Ск3): JS нормализует то же состояние
            // в `activeTurnActorIds`, `combatTurnClock` и `turnActivityKey`
            // заново; нормализация идемпотентна, итог тот же. Версию, которую
            // планировщик уже нормализовал, второй раз не нормализуем.
            let normalized = if npc_normalized && npc.state_version == loaded.state_version {
                npc.state
            } else {
                sk_rules::normalized::NormalizedState::from_loaded(&loaded)?.shared()
            };
            let turn_actor_ids = active_ids_normalized(&normalized);
            let unclaimed = !turn_actor_ids.is_empty() && self.host.is_seat_unclaimed(id, &loaded.state, &turn_actor_ids);
            let timeout = if unclaimed { self.unclaimed_timeout_ms } else { self.timeout_ms };
            let previous = self.existing(id, |entry| entry.clock.clone()).flatten();
            let base_options = ClockOptions { timeout_ms: Value::from(timeout), now: self.host.now(), previous_clock: previous.clone(), activity_at: None };
            let base_clock = clock_normalized(&normalized, &[], &base_options)?;
            let activity_key = activity_key_normalized(&normalized);
            let same_turn = match (&base_clock, &previous) {
                (Some(base), Some(previous)) => previous.get("turn_id") == base.get("turn_id"),
                _ => false,
            };
            let previous_key = self.existing(id, |entry| entry.activity_key.clone()).flatten();
            let activity_at: Option<Value> = if !same_turn {
                None
            } else if previous_key.as_ref().is_some_and(|key| *key != activity_key) {
                Some(Value::String(iso(self.host.now())?))
            } else {
                previous.as_ref().and_then(|clock| clock.get("activity_at")).filter(|value| !value.is_null()).cloned()
            };
            self.existing(id, |entry| entry.activity_key = Some(activity_key));
            let clock = match activity_at.filter(|value| js::truthy(Some(value))) {
                Some(activity) => clock_normalized(&normalized, &[], &ClockOptions { timeout_ms: Value::from(timeout), now: self.host.now(), previous_clock: previous, activity_at: Some(activity) })?,
                None => base_clock,
            };
            self.existing(id, |entry| entry.clock = clock.clone());
            drop(clock_span);
            let changed_span = sk_store::perf::span("combat.on_clock_changed");
            self.host.on_clock_changed(id, clock.as_ref());
            drop(changed_span);
            let Some(clock) = clock else {
                self.existing(id, |entry| entry.retry_attempt = 0);
                continue;
            };
            let remaining = date_parse(clock.get("deadline_at")) - self.host.now();
            if remaining > 0.0 {
                self.existing(id, |entry| entry.retry_attempt = 0);
                let timer = self.host.set_timer(remaining, TimerAction::Nudge { campaign_id: id.to_string(), generation });
                self.existing(id, |entry| entry.timer = Some(timer));
                continue;
            }
            let committed = commit_timed_out_turn(self.journal, self.rules_engine, id, &loaded, Some(&clock))?;
            loaded = self.journal.load(id)?;
            if !committed.events().is_empty() {
                self.host.on_committed(id, &loaded.state, committed.events(), None);
            }
            self.existing(id, |entry| {
                entry.retry_attempt = 0;
                entry.pending = true;
            });
        }
    }
}

/// Ожидание, пока у кампании не останется удержаний.
struct HoldsReleased<'c, 'a> {
    coordinator: &'c CombatTurnCoordinator<'a>,
    id: String,
}

impl Future for HoldsReleased<'_, '_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<()> {
        let held = self.coordinator.entries.borrow().get(&self.id).is_some_and(|entry| !entry.holds.is_empty());
        if !held {
            return Poll::Ready(());
        }
        self.coordinator.wakers.borrow_mut().push(context.waker().clone());
        Poll::Pending
    }
}
