//! Живой поток рассказа — перенос `server/narration-stream.mjs`.
//!
//! `CampaignNarrationStream` держит короткие публичные снимки текста
//! рассказа, пока модель его пишет: начало, схлопнутые за `coalesce_ms`
//! промежуточные снимки и канонический финал. Авторитетное состояние,
//! события механики и ключ идемпотентности сюда не принимаются; размер
//! текста и кадра ограничен, активных сообщений на кампанию — не больше
//! `max_active`.
//!
//! `CampaignStreamOutbox` — одна ограниченная очередь на SSE-соединение для
//! всех кадров (комната, присутствие, пульс, рассказ): пока сокет занят, кадр
//! с тем же ключом заменяет непрочитанный прежний, переполнение закрывает
//! соединение. Это инвариант «медленный читатель не копит кадры». Сокет
//! поверх `tokio::sync::mpsc` с семантикой `res.write()`/`drain` Node —
//! [`sse_socket`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{json, Value};
use sk_core::js;

use crate::support::{field, stringify, template};

pub const NARRATION_STREAM_TEXT_MAX_BYTES: usize = 12 * 1024;
pub const NARRATION_STREAM_EVENT_MAX_BYTES: usize = 16 * 1024;
pub const NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN: usize = 16;
pub const NARRATION_STREAM_COALESCE_MS: u64 = 50;

const FINAL_PHASES: [&str; 3] = ["complete", "replaced", "aborted"];

/// Отказ потока рассказа (`streamError(message, code)`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct NarrationStreamError {
    pub code: &'static str,
    pub message: String,
}

fn stream_error(message: &str, code: &'static str) -> NarrationStreamError {
    NarrationStreamError { code, message: message.into() }
}

fn normalized_campaign_id(value: &str) -> String {
    sk_core::text::upper(sk_core::text::trim(value))
}

/// `/^[A-Za-z0-9._:-]{1,120}$/u`.
fn normalized_message_id(value: &str) -> Result<String, NarrationStreamError> {
    let message_id = sk_core::text::trim(value);
    let valid = !message_id.is_empty()
        && message_id.chars().count() <= 120
        && message_id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'));
    if !valid {
        return Err(stream_error("Некорректный идентификатор потокового повествования", "NARRATION_MESSAGE_ID_INVALID"));
    }
    Ok(message_id.to_string())
}

fn bounded_text(text: &str) -> Result<&str, NarrationStreamError> {
    if text.len() > NARRATION_STREAM_TEXT_MAX_BYTES {
        return Err(stream_error("Потоковое повествование превышает допустимый размер", "NARRATION_STREAM_TOO_LARGE"));
    }
    Ok(text)
}

fn public_payload(message_id: &str, text: &str, phase: &str, replayed: bool) -> Result<Value, NarrationStreamError> {
    let payload = json!({
        "message_id": normalized_message_id(message_id)?,
        "text": bounded_text(text)?,
        "phase": phase,
        "replace": true,
        "replayed": replayed,
    });
    if stringify(&payload).len() > NARRATION_STREAM_EVENT_MAX_BYTES {
        return Err(stream_error("SSE-событие повествования превышает допустимый размер", "NARRATION_STREAM_EVENT_TOO_LARGE"));
    }
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Таймеры
// ---------------------------------------------------------------------------

/// Идентификатор таймера (`setTimeout` → `clearTimeout`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimerId(pub u64);

/// Обратный вызов таймера.
pub type TimerCallback = Box<dyn FnOnce() + Send + 'static>;

/// Внедряемые таймеры (`setTimer`/`clearTimer` в JS): в игре — [`TokioTimers`],
/// в тестах — ручные.
pub trait StreamTimers: Send + Sync {
    fn set_timer(&self, delay: Duration, callback: TimerCallback) -> TimerId;
    fn clear_timer(&self, timer: TimerId);
}

/// Таймеры на `tokio`: каждый — задача со сном; отменённый не срабатывает,
/// даже если его сон уже кончился.
pub struct TokioTimers {
    handle: tokio::runtime::Handle,
    next: AtomicU64,
    tasks: Arc<Mutex<HashMap<u64, tokio::task::AbortHandle>>>,
}

impl TokioTimers {
    pub fn new(handle: tokio::runtime::Handle) -> Self {
        Self { handle, next: AtomicU64::new(0), tasks: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Таймеры текущей среды `tokio`, если она есть.
    pub fn current() -> Option<Self> {
        tokio::runtime::Handle::try_current().ok().map(Self::new)
    }
}

impl StreamTimers for TokioTimers {
    fn set_timer(&self, delay: Duration, callback: TimerCallback) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let tasks = Arc::clone(&self.tasks);
        let mut registry = lock(&self.tasks);
        let task = self.handle.spawn(async move {
            tokio::time::sleep(delay).await;
            let armed = lock(&tasks).remove(&id).is_some();
            if armed {
                callback();
            }
        });
        registry.insert(id, task.abort_handle());
        TimerId(id)
    }

    fn clear_timer(&self, timer: TimerId) {
        if let Some(task) = lock(&self.tasks).remove(&timer.0) {
            task.abort();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------
// Поток рассказа кампании
// ---------------------------------------------------------------------------

/// Соединение, которому рассылаются кадры рассказа.
pub trait NarrationConnection {
    /// `connection.closed || connection.res?.destroyed`: закрытому не пишем.
    fn is_closed(&self) -> bool;
}

/// Настройки `new CampaignNarrationStream({ … })`. Числа приводятся, как в JS:
/// `coalesce_ms` — `Math.max(0, Number(x) || 0)`, `max_active` —
/// `Math.max(1, Number(x) || 16)`.
pub struct NarrationStreamOptions<C> {
    pub connections_for: Box<dyn Fn(&str) -> Vec<C> + Send + Sync>,
    pub write: Box<dyn Fn(&C, &str, &Value) + Send + Sync>,
    pub coalesce_ms: Option<f64>,
    pub max_active: Option<f64>,
    pub timers: Arc<dyn StreamTimers>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

struct Entry {
    seq: u64,
    message_id: String,
    text: String,
    updated_at: i64,
    timer: Option<TimerId>,
}

/// Сообщения одной кампании. `generation` — тождество JS-объекта `Map`:
/// отложенный снимок проверяет «свой» контейнер, а не новый с тем же ключом.
struct CampaignEntries {
    generation: u64,
    entries: IndexMap<String, Entry>,
}

#[derive(Default)]
struct HubState {
    active: IndexMap<String, CampaignEntries>,
    next_seq: u64,
    next_generation: u64,
    /// Текст записей, которые `start` заменил под тем же id, пока их снимок
    /// ждал таймера: в JS такой таймер не отменяется и срабатывает со старым
    /// текстом.
    replaced: HashMap<u64, String>,
}

struct Shared<C> {
    connections_for: Box<dyn Fn(&str) -> Vec<C> + Send + Sync>,
    write: Box<dyn Fn(&C, &str, &Value) + Send + Sync>,
    coalesce: Duration,
    max_active: f64,
    timers: Arc<dyn StreamTimers>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    state: Mutex<HubState>,
}

/// `CampaignNarrationStream`.
///
/// Рассылка идёт под замком потока — так порядок кадров тот же, что в
/// однопоточном JS. Поэтому `connections_for` и `write` не должны вызывать
/// методы этого же потока (в JS они этого и не делают).
pub struct CampaignNarrationStream<C> {
    shared: Arc<Shared<C>>,
}

impl<C> Clone for CampaignNarrationStream<C> {
    fn clone(&self) -> Self {
        Self { shared: Arc::clone(&self.shared) }
    }
}

impl<C: NarrationConnection + Send + 'static> CampaignNarrationStream<C> {
    pub fn new(options: NarrationStreamOptions<C>) -> Self {
        let coalesce_ms = options.coalesce_ms.filter(|value| !value.is_nan() && *value != 0.0).unwrap_or(0.0).max(0.0);
        let max_active = options.max_active.filter(|value| !value.is_nan() && *value != 0.0).unwrap_or(NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN as f64).max(1.0);
        Self {
            shared: Arc::new(Shared {
                connections_for: options.connections_for,
                write: options.write,
                coalesce: Duration::from_secs_f64(if coalesce_ms.is_finite() { coalesce_ms / 1000.0 } else { 0.0 }),
                max_active,
                timers: options.timers,
                now: options.now,
                state: Mutex::new(HubState::default()),
            }),
        }
    }

    fn deliver(shared: &Shared<C>, connection: &C, event: &str, payload: &Value) {
        if connection.is_closed() {
            return;
        }
        // Аудит PR #131, SEC-06: своей очереди у повествования больше нет. Раньше
        // backpressure держал только этот класс, а `room`, `presence` и пульс шли
        // в сокет мимо него. Теперь кадр уходит в общую очередь соединения
        // (`CampaignStreamOutbox` ниже): она и схлопывает снимки одного сообщения
        // до последнего, пока клиент не дочитал прежние.
        (shared.write)(connection, event, payload);
    }

    fn broadcast(shared: &Shared<C>, campaign_id: &str, event: &str, payload: &Value) {
        for connection in (shared.connections_for)(campaign_id) {
            Self::deliver(shared, &connection, event, payload);
        }
    }

    fn require_campaign(campaign_id: &str) -> Result<String, NarrationStreamError> {
        let normalized = normalized_campaign_id(campaign_id);
        if normalized.is_empty() {
            return Err(stream_error("Не указана кампания потокового повествования", "NARRATION_CAMPAIGN_REQUIRED"));
        }
        Ok(normalized)
    }

    /// `_remove`: убрать сообщение, отменить его таймер; опустевший контейнер
    /// уходит из реестра и возвращается вторым значением.
    fn remove(shared: &Shared<C>, state: &mut HubState, normalized: &str, message_id: &str) -> (Option<Entry>, Option<CampaignEntries>) {
        let Some(container) = state.active.get_mut(normalized) else { return (None, None) };
        let entry = container.entries.shift_remove(message_id);
        if let Some(timer) = entry.as_ref().and_then(|entry| entry.timer) {
            shared.timers.clear_timer(timer);
        }
        let detached = if container.entries.is_empty() { state.active.shift_remove(normalized) } else { None };
        (entry, detached)
    }

    /// `start(campaignId, { messageId })`.
    pub fn start(&self, campaign_id: &str, message_id: &str) -> Result<Value, NarrationStreamError> {
        let shared = &*self.shared;
        let mut state = lock(&shared.state);
        let normalized = Self::require_campaign(campaign_id)?;
        if !state.active.contains_key(&normalized) {
            state.next_generation += 1;
            let generation = state.next_generation;
            state.active.insert(normalized.clone(), CampaignEntries { generation, entries: IndexMap::new() });
        }
        let id = normalized_message_id(message_id)?;
        let container = &state.active[&normalized];
        let mut kept = None;
        if !container.entries.contains_key(&id) && container.entries.len() as f64 >= shared.max_active {
            let oldest = container.entries.values().fold(None::<&Entry>, |best, entry| match best {
                Some(best) if best.updated_at <= entry.updated_at => Some(best),
                _ => Some(entry),
            });
            // Лимит относится только к process-local preview. Генерацию и commit он
            // не отменяет, поэтому `aborted` здесь был бы ложным финалом: старый ход
            // всё равно позже пришлёт канонический complete/replaced.
            if let Some(oldest) = oldest.map(|entry| entry.message_id.clone()) {
                kept = Self::remove(shared, &mut state, &normalized, &oldest).1;
            }
        }
        // При max_active=1 удаление единственной старой записи убирает контейнер
        // из верхнего реестра; возвращаем тот же ограниченный контейнер перед записью.
        if !state.active.contains_key(&normalized) {
            if let Some(container) = kept {
                state.active.insert(normalized.clone(), container);
            }
        }
        state.next_seq += 1;
        let entry = Entry { seq: state.next_seq, message_id: id.clone(), text: String::new(), updated_at: (shared.now)(), timer: None };
        let previous = state.active.get_mut(&normalized).and_then(|container| container.entries.insert(id.clone(), entry));
        if let Some(previous) = previous.filter(|previous| previous.timer.is_some()) {
            state.replaced.insert(previous.seq, previous.text);
        }
        let payload = public_payload(&id, "", "start", false)?;
        Self::broadcast(shared, &normalized, "narration.start", &payload);
        Ok(payload)
    }

    /// `progress(campaignId, { messageId, text })`: запомнить полный текст;
    /// снимок уходит не чаще раза в `coalesce_ms`.
    pub fn progress(&self, campaign_id: &str, message_id: &str, text: &str) -> Result<(), NarrationStreamError> {
        let shared = &*self.shared;
        let mut state = lock(&shared.state);
        let normalized = Self::require_campaign(campaign_id)?;
        let id = normalized_message_id(message_id)?;
        let now = (shared.now)();
        let Some(container) = state.active.get_mut(&normalized) else {
            return Err(stream_error("Повествование не было начато после commit", "NARRATION_STREAM_NOT_STARTED"));
        };
        let generation = container.generation;
        let Some(entry) = container.entries.get_mut(&id) else {
            return Err(stream_error("Повествование не было начато после commit", "NARRATION_STREAM_NOT_STARTED"));
        };
        entry.text = bounded_text(text)?.to_string();
        entry.updated_at = now;
        if entry.timer.is_some() {
            return Ok(());
        }
        let seq = entry.seq;
        let weak: Weak<Shared<C>> = Arc::downgrade(&self.shared);
        let timer_campaign = normalized.clone();
        let timer = shared.timers.set_timer(
            shared.coalesce,
            Box::new(move || {
                if let Some(shared) = weak.upgrade() {
                    Self::flush_snapshot(&shared, &timer_campaign, generation, &id, seq);
                }
            }),
        );
        if let Some(entry) = state.active.get_mut(&normalized).and_then(|container| container.entries.values_mut().find(|entry| entry.seq == seq)) {
            entry.timer = Some(timer);
        }
        Ok(())
    }

    fn flush_snapshot(shared: &Shared<C>, campaign: &str, generation: u64, message_id: &str, seq: u64) {
        let mut state = lock(&shared.state);
        let container = state.active.get_mut(campaign).filter(|container| container.generation == generation);
        let current = container.and_then(|container| container.entries.get_mut(message_id)).filter(|entry| entry.seq == seq);
        let text = match current {
            Some(entry) => {
                entry.timer = None;
                entry.text.clone()
            }
            None => match state.replaced.remove(&seq) {
                Some(text) => text,
                None => return,
            },
        };
        let present = state.active.get(campaign).filter(|container| container.generation == generation).is_some_and(|container| container.entries.contains_key(message_id));
        if !present {
            return;
        }
        // В JS ошибка сборки кадра в обратном вызове таймера — необработанное
        // исключение процесса; здесь кадр просто не уходит.
        if let Ok(payload) = public_payload(message_id, &text, "streaming", false) {
            Self::broadcast(shared, campaign, "narration.chunk", &payload);
        }
    }

    fn complete_locked(&self, state: &mut HubState, campaign_id: &str, message_id: &str, text: &str, phase: &str, replayed: bool) -> Result<Value, NarrationStreamError> {
        let shared = &*self.shared;
        if !FINAL_PHASES.contains(&phase) {
            return Err(stream_error("Некорректная финальная фаза повествования", "NARRATION_PHASE_INVALID"));
        }
        let id = normalized_message_id(message_id)?;
        let normalized = Self::require_campaign(campaign_id)?;
        Self::remove(shared, state, &normalized, &id);
        let payload = public_payload(&id, text, phase, replayed)?;
        // Как в JS, рассылка идёт по campaignId в том виде, в каком его передали.
        Self::broadcast(shared, campaign_id, "narration.complete", &payload);
        Ok(payload)
    }

    /// `complete(campaignId, { messageId, text, phase, replayed })`: канонический
    /// финал (`complete`, `replaced` или `aborted`; `None` — `complete`).
    pub fn complete(&self, campaign_id: &str, message_id: &str, text: &str, phase: Option<&str>, replayed: bool) -> Result<Value, NarrationStreamError> {
        let mut state = lock(&self.shared.state);
        self.complete_locked(&mut state, campaign_id, message_id, text, phase.unwrap_or("complete"), replayed)
    }

    /// `abort(campaignId, { messageId })`: финал `aborted` с последним текстом.
    pub fn abort(&self, campaign_id: &str, message_id: &str) -> Result<Value, NarrationStreamError> {
        let shared = &*self.shared;
        let mut state = lock(&shared.state);
        let id = normalized_message_id(message_id)?;
        let normalized = Self::require_campaign(campaign_id)?;
        let entry = Self::remove(shared, &mut state, &normalized, &id).0;
        let text = entry.map(|entry| entry.text).unwrap_or_default();
        self.complete_locked(&mut state, campaign_id, &id, &text, "aborted", false)
    }

    /// `replay(campaignId, connection)`: переподключение получает последний
    /// снимок каждого активного сообщения своей кампании.
    pub fn replay(&self, campaign_id: &str, connection: &C) -> Result<(), NarrationStreamError> {
        let shared = &*self.shared;
        let state = lock(&shared.state);
        let normalized = Self::require_campaign(campaign_id)?;
        let Some(container) = state.active.get(&normalized) else { return Ok(()) };
        let mut entries: Vec<&Entry> = container.entries.values().collect();
        entries.sort_by_key(|entry| entry.updated_at);
        for entry in entries {
            let streaming = !entry.text.is_empty();
            let payload = public_payload(&entry.message_id, &entry.text, if streaming { "streaming" } else { "start" }, false)?;
            Self::deliver(shared, connection, if streaming { "narration.chunk" } else { "narration.start" }, &payload);
        }
        Ok(())
    }

    /// `activeCount(campaignId)`.
    pub fn active_count(&self, campaign_id: &str) -> Result<usize, NarrationStreamError> {
        let state = lock(&self.shared.state);
        let normalized = Self::require_campaign(campaign_id)?;
        Ok(state.active.get(&normalized).map_or(0, |container| container.entries.len()))
    }
}

// ---------------------------------------------------------------------------
// Очередь кадров одного SSE-соединения
// ---------------------------------------------------------------------------

/// Сколько непрочитанных кадров держит одно соединение, пока сокет не принял
/// прежние. Кадры с ключом схлопываются — одна `room`, одна `presence`, один
/// пульс, по снимку на сообщение повествования, — поэтому до предела доходит
/// только поток разных сообщений к клиенту, который не читает вовсе.
pub const CAMPAIGN_STREAM_MAX_PENDING_FRAMES: usize = 32;

/// Ключ схлопывания кадра: непрочитанный кадр с тем же ключом заменяется новым.
/// `room` несёт полное разрешённое состояние, `presence` — полный список
/// печатающих, снимок повествования — полный текст своего сообщения, так что
/// промежуточные клиенту не нужны. Остальные кадры (`None`) не схлопываются и
/// считаются в предел по одному.
pub fn campaign_stream_frame_key(event: &str, payload: &Value) -> Option<String> {
    if matches!(event, "room" | "presence" | "heartbeat") {
        return Some(event.to_string());
    }
    let message_id = field(Some(payload), "message_id");
    if event.starts_with("narration.") && js::truthy(message_id) {
        return Some(format!("narration:{}", template(message_id)));
    }
    None
}

/// Ошибка сборки кадра.
pub type RenderError = Box<dyn std::error::Error + Send + Sync>;

/// Сборка кадра: готовая строка SSE или `None`, если писать нечего.
pub type FrameRender = Box<dyn FnOnce() -> Result<Option<String>, RenderError> + Send>;

/// Почему очередь закрыла соединение.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxCloseReason {
    Overflow,
    RenderFailed,
}

impl OutboxCloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            OutboxCloseReason::Overflow => "overflow",
            OutboxCloseReason::RenderFailed => "render_failed",
        }
    }
}

/// Запись в сокет: результат `res.write()` (`Some(false)` — буфер полон, кадр
/// принят) либо `None`, если соединение уже закрыто.
pub type OutboxWrite = Box<dyn FnMut(&str) -> Option<bool> + Send>;

/// Обратный вызов закрытия очереди.
pub type OutboxOnClose = Box<dyn FnMut(OutboxCloseReason, Option<&RenderError>) + Send>;

/// Аудит PR #131, SEC-06: одна ограниченная очередь на SSE-соединение для всех
/// кадров — комнаты, присутствия, пульса и повествования.
///
/// `ServerResponse.write()` возвращает `false`, когда буфер сокета переполнен,
/// но кадр при этом уже принят и будет отправлен после `drain`. Раньше это
/// учитывал только поток повествования, а рассылка комнаты и индикатор ввода
/// продолжали писать: клиент, который не читает сокет, копил в памяти сервера
/// по полному состоянию кампании на каждый ход.
///
/// Теперь пока сокет занят, новые кадры ждут здесь, и кадр с тем же ключом
/// ([`campaign_stream_frame_key`]) заменяет непрочитанный прежний. На `drain`
/// уходит последнее. Кадр собирается **в момент записи** (`render`), а не
/// постановки: кадр комнаты сжимается относительно карты, которую соединение
/// действительно отправило (`mapHash`), — выброшенный промежуточный кадр не
/// оставит клиенту хеш карты, которую тот так и не получил.
///
/// Очередь ограничена `max_pending`. Переполнение значит, что клиент не читает
/// вовсе: соединение закрывается (`on_close(Overflow)`), а переподключение
/// получает полное разрешённое состояние обычным рукопожатием.
///
/// Отзыв прав (`access`) сюда не входит: он выбрасывает ожидающие кадры
/// (`discard`) — они собраны под прежними правами — и пишется в сокет напрямую
/// перед закрытием потока.
pub struct CampaignStreamOutbox {
    write: OutboxWrite,
    max_pending: f64,
    on_close: OutboxOnClose,
    blocked: bool,
    closed: bool,
    pending: IndexMap<String, FrameRender>,
    sequence: u64,
}

impl CampaignStreamOutbox {
    /// `max_pending` приводится как `Math.max(1, Number(x) || 32)`.
    pub fn new(write: OutboxWrite, max_pending: Option<f64>, on_close: Option<OutboxOnClose>) -> Self {
        let max_pending = max_pending.filter(|value| !value.is_nan() && *value != 0.0).unwrap_or(CAMPAIGN_STREAM_MAX_PENDING_FRAMES as f64).max(1.0);
        Self {
            write,
            max_pending,
            on_close: on_close.unwrap_or_else(|| Box::new(|_, _| {})),
            blocked: false,
            closed: false,
            pending: IndexMap::new(),
            sequence: 0,
        }
    }

    /// Сколько кадров ждут сокета.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Закрыта ли очередь.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    fn close(&mut self, reason: OutboxCloseReason, error: Option<&RenderError>) {
        self.pending.clear();
        if self.closed {
            return;
        }
        self.closed = true;
        (self.on_close)(reason, error);
    }

    /// Отправляет кадр сразу либо ставит его в очередь, если сокет занят.
    /// `render` вызывается ровно тогда, когда кадр уходит в сокет; его ошибка
    /// при немедленной отправке возвращается вызывающему (в JS — `throw`).
    ///
    /// Возвращает результат записи: `Some(false)` — кадр в очереди или буфер
    /// полон; `None` — соединение закрыто или переполнено.
    pub fn send(&mut self, key: Option<&str>, render: FrameRender) -> Result<Option<bool>, RenderError> {
        if self.closed {
            return Ok(None);
        }
        if !self.blocked && self.pending.is_empty() {
            return self.flush(render);
        }
        let slot = match key {
            Some(key) => key.to_string(),
            None => {
                self.sequence += 1;
                format!("frame:{}", self.sequence)
            }
        };
        // Удаление перед вставкой переносит схлопнутый кадр в конец: порядок
        // уцелевших кадров тот же, в каком приходили их последние версии.
        self.pending.shift_remove(&slot);
        self.pending.insert(slot, render);
        if self.pending.len() as f64 > self.max_pending {
            self.close(OutboxCloseReason::Overflow, None);
            return Ok(None);
        }
        Ok(Some(false))
    }

    /// Сокет освободился: отправить ожидающее, пока он снова не заполнится.
    pub fn drain(&mut self) {
        self.blocked = false;
        while !self.closed && !self.pending.is_empty() && !self.blocked {
            let Some((_, render)) = self.pending.shift_remove_index(0) else { break };
            // `drain` приходит из события сокета: ошибка здесь не должна уронить
            // процесс. Не собрался кадр — соединение закрывается, клиент
            // переподключится и получит состояние заново.
            match self.flush(render) {
                Err(error) => {
                    self.close(OutboxCloseReason::RenderFailed, Some(&error));
                    return;
                }
                Ok(None) => {
                    self.pending.clear();
                    return;
                }
                Ok(Some(_)) => {}
            }
        }
    }

    /// Выбросить непрочитанное — перед отзывом прав и закрытием потока.
    pub fn discard(&mut self) {
        self.pending.clear();
    }

    fn flush(&mut self, render: FrameRender) -> Result<Option<bool>, RenderError> {
        let Some(chunk) = render()? else { return Ok(Some(true)) };
        let written = (self.write)(&chunk);
        if written == Some(false) {
            self.blocked = true;
        }
        Ok(written)
    }
}

// ---------------------------------------------------------------------------
// Сокет SSE на tokio
// ---------------------------------------------------------------------------

struct SocketShared {
    buffered: AtomicUsize,
    needs_drain: AtomicBool,
    high_water: usize,
}

/// Пишущая сторона сокета SSE: как `res.write()` Node, кадр принимается всегда
/// (пока читатель жив), а `Some(false)` значит, что непрочитанных кадров уже
/// `high_water` и пора ждать `drain`.
#[derive(Clone)]
pub struct SseSocket {
    sender: tokio::sync::mpsc::UnboundedSender<String>,
    shared: Arc<SocketShared>,
}

impl SseSocket {
    /// `res.write(chunk)`; `None` — читатель закрыт.
    pub fn write(&self, chunk: &str) -> Option<bool> {
        if self.sender.send(chunk.to_string()).is_err() {
            return None;
        }
        let buffered = self.shared.buffered.fetch_add(1, Ordering::SeqCst) + 1;
        let accepted = buffered < self.shared.high_water;
        if !accepted {
            self.shared.needs_drain.store(true, Ordering::SeqCst);
        }
        Some(accepted)
    }

    /// Сколько кадров записано и ещё не прочитано.
    pub fn buffered(&self) -> usize {
        self.shared.buffered.load(Ordering::SeqCst)
    }
}

/// Читающая сторона: тело ответа SSE берёт кадры отсюда. Когда буфер опустел
/// после переполнения, вызывается `on_drain` — событие `drain` сокета Node.
pub struct SseSocketReader {
    receiver: tokio::sync::mpsc::UnboundedReceiver<String>,
    shared: Arc<SocketShared>,
    on_drain: Option<Box<dyn FnMut() + Send>>,
}

impl SseSocketReader {
    /// Обработчик `drain` (обычно — `outbox.lock().drain()`).
    pub fn set_on_drain(&mut self, on_drain: Box<dyn FnMut() + Send>) {
        self.on_drain = Some(on_drain);
    }

    /// Следующий кадр; `None` — все писатели закрыты и кадров нет.
    pub async fn recv(&mut self) -> Option<String> {
        let chunk = self.receiver.recv().await?;
        let left = self.shared.buffered.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
        if left == 0 && self.shared.needs_drain.swap(false, Ordering::SeqCst) {
            if let Some(on_drain) = self.on_drain.as_mut() {
                on_drain();
            }
        }
        Some(chunk)
    }

    /// Закрыть сокет: дальнейшие записи вернут `None`.
    pub fn close(&mut self) {
        self.receiver.close();
    }
}

/// Сокет SSE с буфером в `high_water` кадров (не меньше одного).
pub fn sse_socket(high_water: usize) -> (SseSocket, SseSocketReader) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let shared = Arc::new(SocketShared { buffered: AtomicUsize::new(0), needs_drain: AtomicBool::new(false), high_water: high_water.max(1) });
    (SseSocket { sender, shared: Arc::clone(&shared) }, SseSocketReader { receiver, shared, on_drain: None })
}
