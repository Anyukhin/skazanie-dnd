//! Живые потоки кампаний и присутствие — перенос `server/index.mjs:271–291,
//! 2362–2483, 2602–2713, 2830–2836, 4173–4283` (задача С9).
//!
//! Где живёт реестр (решение №1, рецензия С0 CORE-03): **в ядре**,
//! [`crate::core::GameCore::streams`]. Рассылка кадров, отзыв доступа,
//! сверка прав и чтение присутствия идут только на потоке ядра, синхронно и
//! без замков, которые держат через `await`. Поэтому:
//!
//! - рассылка после коммита не может перемежиться с отзывом: оба — отрезки
//!   одного потока, кадр вышедшей сессии не уходит после ответа на logout;
//! - HTTP-слой зовёт хуки только через [`revoke_for_session`] и
//!   [`refresh_for_user`] — задание ядра, ответ маршрута уходит **после**
//!   подтверждения ядра (как синхронный вызов в JS, 4007, 4023);
//! - рассылка комнаты подписана на хук «проекция записана» ([`install`]) и
//!   идёт отдельной фоновой задачей ядра — после того как коммитящее задание
//!   отпустило свои займы (`queueMicrotask` JS, 2829–2835; рецензия плана:
//!   «рассылать после снятия замков»).
//!
//! **Сверка прав читает аккаунты синхронно** — как `usersForSessionKeys` JS
//! (2405), но через **своё** соединение SQLite только для чтения ядра
//! ([`LiveStreams::open`]), а не через общее `Accounts` HTTP-слоя. Запрет
//! CORE-02 («вход другого игрока или запись сессии остановили бы ядро на
//! замке») касается общего замка: здесь замок свой и его держит только поток
//! ядра, а читатель WAL не ждёт пишущих. Так сверка остаётся синхронной там,
//! где синхронна в JS: внутри [`Presence::connected_hero_ids`], перед каждой
//! рассылкой и на пульсе.
//!
//! Соединение ([`Connection`]) — запись реестра с сессией (`sessionKey` —
//! хеш токена, не cookie), пользователем, героями, актёром проекции, хешем
//! карты клиента и ограниченной очередью кадров (`CampaignStreamOutbox`).
//! Сокет — [`sk_infra::narration_stream::sse_socket`]: запись принимает кадр
//! всегда, а «занято» (`res.write() === false`) сообщает, когда тело ответа
//! не забрало [`SOCKET_HIGH_WATER`] кадров; тело зовёт `drain` заданием ядра.
//! Hyper забирает следующий кадр тела только когда сбросил предыдущий в
//! сокет (буфер записи ≈ 400 КБ), поэтому клиент, который не читает, быстро
//! упирается в очередь и `room`/`presence`/пульс схлопываются до последнего.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_infra::narration_stream::{
    campaign_stream_frame_key, CampaignNarrationStream, CampaignStreamOutbox, FrameRender, NarrationConnection, NarrationStreamOptions, OutboxCloseReason, RenderError, SseSocket, SseSocketReader, StreamTimers, TimerCallback, TimerId,
};
use sk_store::accounts::Accounts;

use crate::core::{CoreError, GameCore};
use crate::error::{ApiError, Failure};
use crate::room::Room;
use crate::state::{AppState, Clock};

/// `STREAM_ACCESS_RECHECK_MS` (282): частота лёгкой сверки потоков с сессиями.
pub const STREAM_ACCESS_RECHECK_MS: i64 = 1_000;
/// `TYPING_TTL_MS` (276): сколько живёт индикатор ввода.
pub const TYPING_TTL_MS: i64 = 4_000;
/// Пульс тихого потока (`setInterval(…, 20_000)`, 4253).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
/// Сколько кадров тела ответа может ждать hyper, прежде чем запись скажет
/// «занято» (аналог `highWaterMark` сокета Node, но в кадрах).
pub const SOCKET_HIGH_WATER: usize = 2;
/// `retry: 2000\n\n` — первый кусок тела (4208).
pub const RETRY_CHUNK: &str = "retry: 2000\n\n";

/// `connectedHeroIdsForCampaign(campaignId)`: герои, чьи хозяева сейчас
/// держат открытый поток (после сверки доступа). Только на потоке ядра.
pub trait Presence {
    fn connected_hero_ids(&self, campaign_id: &str) -> IndexSet<String>;
}

/// Реестр живых потоков. Только на потоке ядра.
pub trait StreamRegistry: Presence {
    /// `revokeCampaignStreamsForSession(sessionKey)`: закрыть потоки этой
    /// сессии кадром отзыва доступа; потоки других входов того же игрока живут.
    fn revoke_for_session(&self, session_key: &str);
    /// `refreshCampaignStreamsForUser(userId)`: пересчитать героев и проекцию
    /// уже открытых потоков пользователя.
    fn refresh_for_user(&self, user_id: &str);
    /// Настоящий реестр соединений, если это он (заглушки — `None`):
    /// маршрут потока, рассылка комнаты и индикатор ввода работают с ним.
    fn live(&self) -> Option<&LiveStreams> {
        None
    }
}

/// Сборщик реестра: вызывается на потоке ядра при его запуске.
pub type StreamFactory = Box<dyn FnOnce() -> Result<Box<dyn StreamRegistry>, String> + Send>;

/// Заглушка: потоков нет, присутствующих нет (тесты ядра без HTTP).
pub struct NoStreams;

impl Presence for NoStreams {
    fn connected_hero_ids(&self, _campaign_id: &str) -> IndexSet<String> {
        IndexSet::new()
    }
}

impl StreamRegistry for NoStreams {
    fn revoke_for_session(&self, _session_key: &str) {}

    fn refresh_for_user(&self, _user_id: &str) {}
}

macro_rules! shared_registry {
    ($($pointer:ident),*) => {
        $(impl<T: Presence + ?Sized> Presence for $pointer<T> {
            fn connected_hero_ids(&self, campaign_id: &str) -> IndexSet<String> {
                (**self).connected_hero_ids(campaign_id)
            }
        }

        impl<T: StreamRegistry + ?Sized> StreamRegistry for $pointer<T> {
            fn revoke_for_session(&self, session_key: &str) {
                (**self).revoke_for_session(session_key)
            }

            fn refresh_for_user(&self, user_id: &str) {
                (**self).refresh_for_user(user_id)
            }

            fn live(&self) -> Option<&LiveStreams> {
                (**self).live()
            }
        })*
    };
}

shared_registry!(Rc, Arc, Box);

/// `revokeCampaignStreamsForSession(sessionKey)` из HTTP-слоя: задание ядра;
/// возвращается после того, как ядро закрыло потоки.
pub async fn revoke_for_session(state: &AppState, session_key: String) -> Result<(), CoreError> {
    state.core.call(move |core| Box::pin(async move { core.streams.revoke_for_session(&session_key) })).await
}

/// `refreshCampaignStreamsForUser(userId)` из HTTP-слоя: задание ядра;
/// возвращается после пересчёта потоков.
pub async fn refresh_for_user(state: &AppState, user_id: String) -> Result<(), CoreError> {
    state.core.call(move |core| Box::pin(async move { core.streams.refresh_for_user(&user_id) })).await
}

// --- настройки и сборка -----------------------------------------------------

/// Настройки реестра (тесты укорачивают пульс).
#[derive(Debug, Clone, Copy)]
pub struct LiveOptions {
    pub heartbeat: Duration,
}

impl Default for LiveOptions {
    fn default() -> Self {
        Self { heartbeat: HEARTBEAT_INTERVAL }
    }
}

/// Сборщик настоящего реестра над базой аккаунтов `database` (тот же файл
/// `skazanie.sqlite`, своё соединение для чтения). `clock` — те же часы, что у
/// `Accounts` HTTP-слоя: сроки сессий сверяются одинаково.
pub fn live_factory(database: PathBuf, clock: Clock, options: LiveOptions) -> StreamFactory {
    Box::new(move || Ok(Box::new(LiveStreams::open(&database, clock, options)?) as Box<dyn StreamRegistry>))
}

/// Источник часов хода боя для `turn_clock` присутствия
/// (`combatTurnCoordinator.clockFor(campaignId)`, 2611). Его ставит С17.
pub type TurnClockSource = Box<dyn Fn(&str) -> Option<Value>>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn upper(campaign_id: &str) -> String {
    campaign_id.to_uppercase()
}

fn render_error(message: impl Into<String>) -> RenderError {
    Box::<dyn std::error::Error + Send + Sync>::from(message.into())
}

/// `campaignStreamFrame(event, payload)` (2644–2646): общий счётчик кадров и
/// соединений процесса.
fn frame(sequence: &AtomicU64, event: &str, payload: &Value) -> String {
    frame_with_data(sequence, event, &js::stringify(payload))
}

/// [`frame`] с уже сериализованным содержимым.
fn frame_with_data(sequence: &AtomicU64, event: &str, data: &str) -> String {
    let id = sequence.fetch_add(1, Ordering::SeqCst) + 1;
    format!("id: {id}\nevent: {event}\ndata: {data}\n\n")
}

// --- связь соединения с телом ответа ----------------------------------------

/// Общая часть соединения и тела ответа: пишущая сторона сокета и признаки
/// `connection.closed`, `res.destroyed`. Живёт и в ядре, и в теле ответа
/// (поток axum), поэтому — только атомики и замки без ожидания.
pub struct StreamLink {
    campaign: String,
    id: Mutex<String>,
    /// `connection.closed`.
    closed: AtomicBool,
    /// Тело ответа уничтожено: клиент ушёл (`req` `close`).
    gone: AtomicBool,
    /// Сервер оборвал ответ (`res.destroy()`): тело кончается ошибкой.
    destroyed: AtomicBool,
    /// Очередь закрыла поток (переполнение, сбой сборки кадра).
    overflowed: AtomicBool,
    /// Пишущая сторона; `None` — `res.end()`/`res.destroy()` уже были.
    socket: Mutex<Option<SseSocket>>,
}

impl StreamLink {
    fn new(campaign: String, socket: SseSocket) -> Self {
        Self {
            campaign,
            id: Mutex::new(String::new()),
            closed: AtomicBool::new(false),
            gone: AtomicBool::new(false),
            destroyed: AtomicBool::new(false),
            overflowed: AtomicBool::new(false),
            socket: Mutex::new(Some(socket)),
        }
    }

    /// `res.destroyed`.
    fn is_destroyed(&self) -> bool {
        self.gone.load(Ordering::SeqCst) || self.destroyed.load(Ordering::SeqCst)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// `res.write(chunk)`: `None` — ответ закончен или клиент ушёл.
    fn write(&self, chunk: &str) -> Option<bool> {
        if self.gone.load(Ordering::SeqCst) {
            return None;
        }
        lock(&self.socket).as_ref()?.write(chunk)
    }

    /// `res.end()`: тело отдаёт уже принятые кадры и кончается.
    fn end(&self) {
        lock(&self.socket).take();
    }

    /// `res.destroy()`: тело обрывается без завершающего куска.
    fn destroy(&self) {
        self.destroyed.store(true, Ordering::SeqCst);
        lock(&self.socket).take();
    }
}

/// Соединение для потока рассказа (С18.5): `Send`-ссылка на запись реестра.
/// Писать в него — [`LiveStreams::write_event`] на потоке ядра.
#[derive(Clone)]
pub struct StreamHandle {
    link: Arc<StreamLink>,
}

impl StreamHandle {
    pub fn campaign_id(&self) -> &str {
        &self.link.campaign
    }

    pub fn connection_id(&self) -> String {
        lock(&self.link.id).clone()
    }
}

impl NarrationConnection for StreamHandle {
    fn is_closed(&self) -> bool {
        self.link.is_closed() || self.link.is_destroyed()
    }
}

/// Тело ответа SSE: кадры сокета; уничтожение тела (клиент ушёл, сервер
/// остановлен) — `close` соединения заданием ядра (`req.once('close')`).
pub struct SseBody {
    reader: SseSocketReader,
    guard: BodyGuard,
}

struct BodyGuard {
    link: Arc<StreamLink>,
    state: std::sync::Weak<AppState>,
}

impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.link.gone.store(true, Ordering::SeqCst);
        let Some(state) = self.state.upgrade() else { return };
        let link = self.link.clone();
        // Ядро остановлено — закрывать уже нечего.
        let _ = state.core.spawn(move |core| {
            Box::pin(async move {
                if let Some(live) = core.streams.live() {
                    live.socket_gone(&link);
                }
            })
        });
    }
}

impl SseBody {
    /// Тело axum: кадры по мере записи; `res.destroy()` — ошибка тела, и
    /// hyper обрывает соединение без завершающего куска.
    pub fn into_body(self) -> axum::body::Body {
        let stream = futures_util::stream::unfold(self, |mut body| async move {
            let next = body.reader.recv().await;
            if body.guard.link.destroyed.load(Ordering::SeqCst) {
                return Some((Err(std::io::Error::other("живой поток оборван сервером")), body));
            }
            next.map(|chunk| (Ok(axum::body::Bytes::from(chunk)), body))
        });
        axum::body::Body::from_stream(stream)
    }
}

// --- реестр -----------------------------------------------------------------

/// Права и вид соединения: их обновляет каждая сверка, а кадр комнаты читает
/// в момент записи в сокет (кадр может ждать в очереди).
struct View {
    user: Value,
    user_id: String,
    hero_ids: Vec<String>,
    actor_id: String,
    controls_party: bool,
    /// Хеш карты, которую соединение действительно отправило.
    map_hash: String,
}

/// Запись реестра (`connection`, 4211–4229).
struct Connection {
    id: String,
    campaign: String,
    session_key: String,
    link: Arc<StreamLink>,
    view: Arc<Mutex<View>>,
    outbox: RefCell<CampaignStreamOutbox>,
    heartbeat: RefCell<Option<tokio::task::JoinHandle<()>>>,
}

impl Connection {
    fn closed(&self) -> bool {
        self.link.is_closed()
    }

    fn destroyed(&self) -> bool {
        self.link.is_destroyed()
    }

    fn view(&self) -> MutexGuard<'_, View> {
        lock(&self.view)
    }
}

struct Typing {
    actor_id: String,
    expires_at: i64,
}

/// Настоящий реестр живых потоков (`campaignStreams`, `campaignTyping`,
/// `campaignStreamAccessCheckedAt`). Только на потоке ядра.
pub struct LiveStreams {
    accounts: Accounts,
    clock: Clock,
    options: LiveOptions,
    /// `campaignStreamSequence`: id кадров и номера соединений.
    sequence: Arc<AtomicU64>,
    /// Ядро для фоновых задач `close` (ставится при первом рукопожатии; до
    /// него соединений нет, и закрывать нечего).
    core: RefCell<Weak<GameCore>>,
    campaigns: RefCell<IndexMap<String, IndexMap<String, Rc<Connection>>>>,
    checked_at: RefCell<HashMap<String, i64>>,
    typing: RefCell<HashMap<String, IndexMap<String, Typing>>>,
    turn_clock: RefCell<Option<TurnClockSource>>,
}

impl LiveStreams {
    /// Реестр со своим соединением для чтения аккаунтов (`database` —
    /// `skazanie.sqlite` хранилища).
    pub fn open(database: &std::path::Path, clock: Clock, options: LiveOptions) -> Result<Self, String> {
        let accounts = Accounts::open(database).map_err(|error| format!("Живые потоки: аккаунты не открылись: {}", error.message))?.with_clock(clock.clone());
        Ok(Self {
            accounts,
            clock,
            options,
            sequence: Arc::new(AtomicU64::new(0)),
            core: RefCell::new(Weak::new()),
            campaigns: RefCell::default(),
            checked_at: RefCell::default(),
            typing: RefCell::default(),
            turn_clock: RefCell::new(None),
        })
    }

    /// Аккаунты для проверок на потоке ядра (своё соединение реестра).
    pub fn accounts(&self) -> &Accounts {
        &self.accounts
    }

    /// Поставить источник часов хода боя (С17).
    pub fn set_turn_clock_source(&self, source: TurnClockSource) {
        *self.turn_clock.borrow_mut() = Some(source);
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn bind(&self, core: &Rc<GameCore>) {
        *self.core.borrow_mut() = Rc::downgrade(core);
    }

    fn core(&self) -> Option<Rc<GameCore>> {
        self.core.borrow().upgrade()
    }

    /// `streamConnections(campaignId).values()` — снимок (без побочной записи
    /// пустой карты, как в JS).
    fn connections(&self, campaign_id: &str) -> Vec<Rc<Connection>> {
        self.campaigns.borrow().get(&upper(campaign_id)).map(|connections| connections.values().cloned().collect()).unwrap_or_default()
    }

    fn connection(&self, campaign_id: &str, id: &str) -> Option<Rc<Connection>> {
        self.campaigns.borrow().get(campaign_id).and_then(|connections| connections.get(id)).cloned()
    }

    /// Есть ли у кампании открытые потоки.
    pub fn has_connections(&self, campaign_id: &str) -> bool {
        self.campaigns.borrow().get(&upper(campaign_id)).is_some_and(|connections| !connections.is_empty())
    }

    /// `revalidateCampaignStreams(campaignId, { state, maxAgeMs })` (2381–2434).
    pub fn revalidate(&self, campaign_id: &str, state: Option<&Value>, max_age_ms: i64) {
        let normalized = upper(campaign_id);
        let live = self.connections(&normalized);
        if live.is_empty() {
            // Без потоков отметка не нужна: следующий поток будет сверен сразу.
            self.checked_at.borrow_mut().remove(&normalized);
            return;
        }
        let now = self.now();
        let checked = self.checked_at.borrow().get(&normalized).copied().unwrap_or(0);
        if state.is_none() && max_age_ms > 0 && now - checked < max_age_ms {
            return;
        }
        self.checked_at.borrow_mut().insert(normalized.clone(), now);
        // Поток зарегистрирован под этой кампанией: её код и решает членство,
        // даже если в переданном состоянии кода нет.
        let access_room = state.map(|state| {
            let session_code = match state.get("sessionCode") {
                code if js::truthy(code) => code.cloned().unwrap_or(Value::Null),
                _ => Value::String(normalized.clone()),
            };
            let mut room_state = Map::new();
            room_state.insert("sessionCode".into(), session_code);
            room_state.insert("players".into(), state.get("players").cloned().unwrap_or(Value::Null));
            room_state.insert("partyMemberIds".into(), state.get("partyMemberIds").cloned().unwrap_or(Value::Null));
            Room { code: normalized.clone(), version: 0, state: Some(Value::Object(room_state)), updated_at: None }
        });
        // Не смогли проверить права — не отправляем: поток закрывается, а
        // клиент переподключится через обычное рукопожатие.
        let keys: Vec<String> = live.iter().map(|connection| connection.session_key.clone()).collect();
        let (users, failure) = match self.accounts.users_for_session_keys(&keys) {
            Ok(users) => (users, ""),
            Err(error) => {
                eprintln!("[Сказание] Не удалось сверить живые потоки с сессиями: {}", error.message);
                (Vec::new(), "access_unverified")
            }
        };
        for connection in &live {
            let Some(user) = users.iter().find(|(key, _)| *key == connection.session_key).map(|(_, user)| user) else {
                self.revoke(connection, if failure.is_empty() { "session_ended" } else { failure });
                continue;
            };
            if let Err(error) = self.refresh_view(connection, user, &normalized, access_room.as_ref(), state) {
                match error {
                    ViewError::AccessLost => self.revoke(connection, "access_lost"),
                    ViewError::Failed(failure) => {
                        eprintln!("[Сказание] Не удалось сверить доступ живого потока: {}", failure.message);
                        self.revoke(connection, "access_unverified");
                    }
                }
            }
        }
    }

    fn refresh_view(&self, connection: &Connection, user: &Value, campaign: &str, access_room: Option<&Room>, state: Option<&Value>) -> Result<(), ViewError> {
        if let Some(room) = access_room {
            if !crate::access::can_access_room(&self.accounts, Some(user), room).map_err(ViewError::Failed)? {
                return Err(ViewError::AccessLost);
            }
        }
        let hero_ids = crate::access::campaign_hero_ids(&self.accounts, user, campaign).map_err(ViewError::Failed)?;
        let mut view = connection.view();
        view.user = user.clone();
        view.user_id = js::string(user.get("id"));
        view.controls_party = user.get("role").and_then(Value::as_str) == Some("admin");
        if let Some(state) = state {
            let actor_id = actor_for(&hero_ids, state);
            // Сменился актёр — клиентский кэш карты принадлежал прежней
            // проекции: следующий кадр уходит целиком.
            if actor_id != view.actor_id {
                view.map_hash.clear();
            }
            view.actor_id = actor_id;
        }
        view.hero_ids = hero_ids;
        Ok(())
    }

    /// `revokeCampaignStream(connection, reason)` (2441–2450).
    fn revoke(&self, connection: &Rc<Connection>, reason: &str) {
        if connection.closed() {
            return;
        }
        // Кадры, ждущие сокета, собраны под прежними правами — выбрасываются, а
        // кадр отзыва идёт мимо очереди после уже принятых.
        if let Ok(mut outbox) = connection.outbox.try_borrow_mut() {
            outbox.discard();
        }
        if !connection.destroyed() {
            connection.link.write(&frame(&self.sequence, "access", &json!({ "status": "revoked", "reason": reason })));
        }
        self.close(connection);
        if !connection.destroyed() {
            connection.link.end();
        }
    }

    /// `close` соединения (4256–4273): снять с реестра; затем фоновой задачей —
    /// воздержание ушедших голосующих и рассылка комнаты.
    fn close(&self, connection: &Rc<Connection>) {
        if connection.link.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(heartbeat) = connection.heartbeat.borrow_mut().take() {
            heartbeat.abort();
        }
        {
            let mut campaigns = self.campaigns.borrow_mut();
            let emptied = campaigns.get_mut(&connection.campaign).is_some_and(|remaining| {
                remaining.shift_remove(&connection.id);
                remaining.is_empty()
            });
            // Последний поток кампании закрыт — её записи в картах не нужны.
            if emptied {
                campaigns.shift_remove(&connection.campaign);
                self.checked_at.borrow_mut().remove(&connection.campaign);
            }
        }
        let Some(core) = self.core() else { return };
        let campaign = connection.campaign.clone();
        let _ = crate::core::spawn_in_context(async move {
            if let Err(error) = crate::projection::reconcile_party_decision_presence(&core, &campaign) {
                eprintln!("[Сказание] Не удалось зафиксировать отключение участника: {}", error.message);
            }
            if let Err(error) = broadcast_campaign_room(&core, &campaign, None) {
                eprintln!("[Сказание] Не удалось разослать комнату {campaign}: {}", error.message);
            }
        });
    }

    /// Очередь закрыла поток внутри `send`/`drain`: `onClose` уже записал в
    /// лог и оборвал ответ, осталось снять соединение с реестра.
    fn after_outbox(&self, connection: &Rc<Connection>) {
        if connection.link.overflowed.load(Ordering::SeqCst) {
            self.close(connection);
        }
    }

    /// `writeCampaignStream(connection, event, payload)` (2655–2661): кадр
    /// через очередь соединения; `render` собирает его в момент записи.
    fn write(&self, connection: &Rc<Connection>, key: Option<String>, render: FrameRender) -> Result<Option<bool>, RenderError> {
        if connection.closed() || connection.destroyed() {
            return Ok(None);
        }
        let sent = match connection.outbox.try_borrow_mut() {
            Ok(mut outbox) => outbox.send(key.as_deref(), render),
            Err(_) => Ok(None),
        };
        self.after_outbox(connection);
        sent
    }

    /// Кадр `event` с готовым содержимым — для потока рассказа (С18.5).
    pub fn write_event(&self, handle: &StreamHandle, event: &str, payload: &Value) -> Result<Option<bool>, RenderError> {
        let Some(connection) = self.connection(&handle.link.campaign, &handle.connection_id()) else { return Ok(None) };
        let sequence = self.sequence.clone();
        let (event_name, data) = (event.to_string(), payload.clone());
        self.write(&connection, campaign_stream_frame_key(event, payload), Box::new(move || Ok(Some(frame(&sequence, &event_name, &data)))))
    }

    /// `connectionsFor` потока рассказа (286–289): лёгкая сверка, затем
    /// открытые соединения кампании (С18.5).
    pub fn narration_connections(&self, campaign_id: &str) -> Vec<StreamHandle> {
        self.revalidate(campaign_id, None, STREAM_ACCESS_RECHECK_MS);
        self.connections(campaign_id).into_iter().map(|connection| StreamHandle { link: connection.link.clone() }).collect()
    }

    /// Тело ответа ушло (клиент закрыл соединение, `req` `close`).
    fn socket_gone(&self, link: &StreamLink) {
        let id = lock(&link.id).clone();
        if let Some(connection) = self.connection(&link.campaign, &id) {
            self.close(&connection);
        }
    }

    /// `res.on('drain')`: сокет освободился — отправить ожидающее.
    fn drain(&self, link: &StreamLink) {
        let id = lock(&link.id).clone();
        let Some(connection) = self.connection(&link.campaign, &id) else { return };
        if connection.closed() {
            return;
        }
        if let Ok(mut outbox) = connection.outbox.try_borrow_mut() {
            outbox.drain();
        }
        self.after_outbox(&connection);
    }

    /// Пульс (4248–4255): тихий поток сверяется с сессией, затем через очередь
    /// уходит комментарий — один, сколько бы их ни набежало, пока сокет занят.
    fn heartbeat(&self, connection: &Rc<Connection>) {
        if connection.closed() || connection.destroyed() {
            return;
        }
        // Истечение сессии не присылает события: тихий поток сверяется на пульсе.
        self.revalidate(&connection.campaign, None, STREAM_ACCESS_RECHECK_MS);
        if connection.closed() || connection.destroyed() {
            return;
        }
        let now = self.now();
        let sent = match connection.outbox.try_borrow_mut() {
            Ok(mut outbox) => outbox.send(Some("heartbeat"), Box::new(move || Ok(Some(format!(": heartbeat {now}\n\n"))))),
            Err(_) => Ok(None),
        };
        self.after_outbox(connection);
        if let Err(error) = sent {
            eprintln!("[Сказание] Не удалось отправить пульс живого потока: {error}");
        }
    }

    /// `typingActorIdsForCampaign(campaignId)` (2634–2642).
    pub fn typing_actor_ids(&self, campaign_id: &str) -> Vec<String> {
        let normalized = upper(campaign_id);
        let now = self.now();
        let mut typing = self.typing.borrow_mut();
        let mut actors: Vec<Value> = Vec::new();
        if let Some(entries) = typing.get_mut(&normalized) {
            entries.retain(|_, entry| entry.expires_at > now);
            let mut unique: IndexSet<String> = IndexSet::new();
            for entry in entries.values() {
                unique.insert(entry.actor_id.clone());
            }
            actors = unique.into_iter().map(Value::String).collect();
            if entries.is_empty() {
                typing.remove(&normalized);
            }
        }
        js::default_sort(&mut actors);
        actors.iter().map(|actor| js::s(Some(actor))).collect()
    }

    /// Запись индикатора ввода (4185–4190).
    fn set_typing(&self, campaign_id: &str, user_id: &str, actor_id: &str, typing: bool) {
        let mut all = self.typing.borrow_mut();
        let entries = all.entry(campaign_id.to_string()).or_default();
        if typing {
            entries.insert(user_id.to_string(), Typing { actor_id: actor_id.to_string(), expires_at: self.now() + TYPING_TTL_MS });
        } else {
            entries.shift_remove(user_id);
        }
        if entries.is_empty() {
            all.remove(campaign_id);
        }
    }

    /// `broadcastCampaignTyping(campaignId)` (2663–2670).
    fn broadcast_typing(&self, campaign_id: &str) {
        let normalized = upper(campaign_id);
        self.revalidate(&normalized, None, STREAM_ACCESS_RECHECK_MS);
        let payload = json!({ "typing_actor_ids": self.typing_actor_ids(&normalized) });
        for connection in self.connections(&normalized) {
            let sequence = self.sequence.clone();
            let data = payload.clone();
            // Кадр присутствия собирается без ошибок.
            let _ = self.write(&connection, campaign_stream_frame_key("presence", &payload), Box::new(move || Ok(Some(frame(&sequence, "presence", &data)))));
        }
    }

    /// Остановка сервера: закончить тела всех потоков (без кадра и без
    /// фоновых задач `close` — в JS процесс просто завершается), чтобы
    /// плавная остановка соединений не ждала их до предела.
    pub fn end_all(&self) {
        let campaigns = std::mem::take(&mut *self.campaigns.borrow_mut());
        self.checked_at.borrow_mut().clear();
        for connection in campaigns.into_values().flat_map(IndexMap::into_values) {
            connection.link.closed.store(true, Ordering::SeqCst);
            if let Some(heartbeat) = connection.heartbeat.borrow_mut().take() {
                heartbeat.abort();
            }
            if let Ok(mut outbox) = connection.outbox.try_borrow_mut() {
                outbox.discard();
            }
            connection.link.end();
        }
    }

    /// Соединения кампании для тестов и диагностики: id, пользователь, герои,
    /// актёр, сколько кадров ждут сокета.
    pub fn connection_infos(&self, campaign_id: &str) -> Vec<Value> {
        self.connections(campaign_id)
            .iter()
            .map(|connection| {
                let view = connection.view();
                json!({
                    "id": connection.id,
                    "user_id": view.user_id,
                    "hero_ids": view.hero_ids,
                    "actor_id": view.actor_id,
                    "map_hash": view.map_hash,
                    "pending": connection.outbox.try_borrow().map(|outbox| outbox.pending_count()).unwrap_or(0),
                    "closed": connection.closed(),
                })
            })
            .collect()
    }

    fn turn_clock_for(&self, campaign_id: &str) -> Option<Value> {
        self.turn_clock.borrow().as_ref().and_then(|source| source(campaign_id))
    }
}

enum ViewError {
    AccessLost,
    Failed(Failure),
}

/// `heroIds.find((id) => state.players?.some((player) => String(player.id) === id)) ?? ''`.
fn actor_for(hero_ids: &[String], state: &Value) -> String {
    let players = state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    hero_ids.iter().find(|id| players.iter().any(|player| js::string(player.get("id")) == **id)).cloned().unwrap_or_default()
}

impl Presence for LiveStreams {
    /// `connectedHeroIdsForCampaign` (2477–2481): присутствие и состав
    /// голосующих не держат отозванные соединения.
    fn connected_hero_ids(&self, campaign_id: &str) -> IndexSet<String> {
        self.revalidate(campaign_id, None, STREAM_ACCESS_RECHECK_MS);
        let mut heroes = IndexSet::new();
        for connection in self.connections(campaign_id) {
            for hero in &connection.view().hero_ids {
                heroes.insert(hero.clone());
            }
        }
        heroes
    }
}

impl StreamRegistry for LiveStreams {
    /// Logout закрывает потоки только этой сессии (2453–2460).
    fn revoke_for_session(&self, session_key: &str) {
        if session_key.is_empty() {
            return;
        }
        let all: Vec<Rc<Connection>> = self.campaigns.borrow().values().flat_map(|connections| connections.values().cloned()).collect();
        for connection in all {
            if connection.session_key == session_key {
                self.revoke(&connection, "session_ended");
            }
        }
    }

    /// Администратор поменял роль или героев (2462–2475): открытые потоки
    /// пользователя получают свежую проекцию, потерявшие доступ закрываются
    /// внутри той же рассылки.
    fn refresh_for_user(&self, user_id: &str) {
        let campaigns: Vec<String> = self.campaigns.borrow().keys().cloned().collect();
        for campaign in campaigns {
            if !self.connections(&campaign).iter().any(|connection| connection.view().user_id == user_id) {
                continue;
            }
            let Some(core) = self.core() else { return };
            if let Err(error) = broadcast_campaign_room(&core, &campaign, None) {
                eprintln!("[Сказание] Не удалось обновить живые потоки {campaign}: {}", error.message);
            }
        }
    }

    fn live(&self) -> Option<&LiveStreams> {
        Some(self)
    }
}

// --- присутствие и рассылка комнаты ------------------------------------------

/// `stateWithLivePresence(state, campaignId)` (2602–2632): полная сверка
/// потоков по этому состоянию, затем присутствие — только по соединениям с
/// живой сессией и доступом. С заглушкой реестра потоков нет: герои не в сети.
pub fn state_with_live_presence(core: &GameCore, state: &Value, campaign_id: &str) -> Result<Value, Failure> {
    live_presence(core, state, campaign_id, false)
}

/// [`state_with_live_presence`] для уже нормализованного состояния (Ск3):
/// часы хода сверяются с ним без повторной нормализации (она идемпотентна).
pub fn normalized_state_with_live_presence(core: &GameCore, state: &Value, campaign_id: &str) -> Result<Value, Failure> {
    live_presence(core, state, campaign_id, true)
}

fn live_presence(core: &GameCore, state: &Value, campaign_id: &str, normalized: bool) -> Result<Value, Failure> {
    let Value::Object(object) = state else { return Ok(state.clone()) };
    let live = core.streams.live();
    if let Some(live) = live {
        live.revalidate(campaign_id, Some(state), 0);
    }
    let connections = live.map(|live| live.connections(campaign_id)).unwrap_or_default();
    let mut online = core.streams.connected_hero_ids(campaign_id);
    let typing = live.map(|live| live.typing_actor_ids(campaign_id)).unwrap_or_default();
    let clock = live.and_then(|live| live.turn_clock_for(campaign_id));
    let turn_clock = if normalized {
        sk_turns::combat_turn_coordinator::combat_turn_clock_for_normalized_state(state, clock.as_ref())
    } else {
        sk_turns::combat_turn_coordinator::combat_turn_clock_for_state(state, clock.as_ref())?
    };
    let players = state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if connections.iter().any(|connection| connection.view().controls_party) {
        for player in players {
            online.insert(js::string(player.get("id")));
        }
    }
    let players: Vec<Value> = players
        .iter()
        .map(|player| {
            let mut map = player.as_object().cloned().unwrap_or_default();
            map.insert("online".into(), Value::Bool(online.contains(&js::string(player.get("id")))));
            Value::Object(map)
        })
        .collect();
    let mut users: IndexSet<String> = IndexSet::new();
    for connection in &connections {
        users.insert(connection.view().user_id.clone());
    }
    let mut online_ids: Vec<Value> = online.iter().cloned().map(Value::String).collect();
    js::default_sort(&mut online_ids);
    let mut next = object.clone();
    next.insert("players".into(), Value::Array(players));
    next.insert(
        "presence".into(),
        json!({
            "transport": "sse",
            "connected_users": users.len(),
            "connected_heroes": online.len(),
            "online_hero_ids": online_ids,
            "typing_actor_ids": typing,
        }),
    );
    next.insert("turn_clock".into(), turn_clock.unwrap_or(Value::Null));
    Ok(Value::Object(next))
}

/// Собранный кадр комнаты одной рассылки: для кого и с какой картой.
struct RenderedRoom {
    user: String,
    actor_id: String,
    map_hash_before: String,
    map_hash_after: String,
    data: Arc<str>,
}

/// `broadcastCampaignRoom(campaignId, suppliedRoom)` (2672–2707): каждому
/// соединению — его проекция, сжатая относительно карты, которую оно
/// действительно отправило. Кадр собирается в момент записи в сокет: пока
/// медленный клиент не дочитал прежнее, кадр ждёт в очереди и может быть
/// заменён следующей рассылкой, а хеш карты продвигается только с записью.
/// Ошибка сборки кадра при немедленной записи прерывает рассылку, как
/// `throw` в JS.
pub fn broadcast_campaign_room(core: &Rc<GameCore>, campaign_id: &str, supplied: Option<Room>) -> Result<(), Failure> {
    let Some(live) = core.streams.live() else { return Ok(()) };
    let normalized = upper(campaign_id);
    if !live.has_connections(&normalized) {
        return Ok(());
    }
    let room_span = sk_store::perf::span("broadcast.get_room");
    let room = match supplied {
        Some(room) => room,
        None => crate::room::get_room(core, &normalized)?,
    };
    drop(room_span);
    let Some(raw) = room.state.as_ref() else { return Ok(()) };
    let _span = sk_store::perf::span("broadcast.prepare");
    let norm_span = sk_store::perf::span("broadcast.normalize");
    let normalized_state = sk_rules::normalize::normalize_campaign_state_cow(raw)?;
    drop(norm_span);
    let presence_span = sk_store::perf::span("broadcast.presence");
    // Внутри — сверка сессий и прав: отозванные соединения закрываются до
    // цикла, остальные получают актуальные права.
    let state = Arc::new(normalized_state_with_live_presence(core, &normalized_state, &normalized)?);
    // Кадры одной рассылки для одинаковых зрителей (тот же пользователь, герой
    // и карта, которую соединение уже отправило) совпадают байт в байт, кроме
    // номера кадра: проекция и сжатие считаются один раз (Ск3). Кадр
    // по-прежнему собирается в момент записи, номер — свой у каждого.
    let rendered: Arc<Mutex<Vec<RenderedRoom>>> = Arc::default();
    drop(presence_span);
    for connection in live.connections(&normalized) {
        let view = connection.view.clone();
        let state = state.clone();
        let sequence = live.sequence.clone();
        let version = room.version;
        let updated_at = room.updated_at.clone();
        let rendered = rendered.clone();
        let render: FrameRender = Box::new(move || {
            let _span = sk_store::perf::span("broadcast.render");
            let mut view = lock(&view);
            let user_key = js::stringify(&view.user);
            let reused = lock(&rendered).iter().find(|done| done.user == user_key && done.actor_id == view.actor_id && done.map_hash_before == view.map_hash).map(|done| (done.data.clone(), done.map_hash_after.clone()));
            if let Some((data, hash)) = reused {
                view.map_hash = hash;
                return Ok(Some(frame_with_data(&sequence, "room", &data)));
            }
            let actor = Value::String(view.actor_id.clone());
            let vs = sk_store::perf::span("broadcast.viewer_state");
            let projected = crate::access::viewer_state_for(&state, &view.user, Some(&actor)).map_err(|error| render_error(error.message))?.unwrap_or(Value::Null);
            drop(vs);
            let cs = sk_store::perf::span("broadcast.compact");
            let (compacted, hash) = sk_tactical::reveal_transport::compact_state_for_transport(&projected, &view.map_hash);
            drop(cs);
            let payload = json!({ "version": version, "updatedAt": updated_at, "state": compacted.unwrap_or(projected) });
            let fs = sk_store::perf::span("broadcast.frame");
            let data: Arc<str> = Arc::from(js::stringify(&payload));
            drop(fs);
            lock(&rendered).push(RenderedRoom { user: user_key, actor_id: view.actor_id.clone(), map_hash_before: std::mem::replace(&mut view.map_hash, hash.clone()), map_hash_after: hash, data: data.clone() });
            Ok(Some(frame_with_data(&sequence, "room", &data)))
        });
        live.write(&connection, campaign_stream_frame_key("room", &Value::Null), render).map_err(|error| Failure::new(error.to_string(), None))?;
    }
    Ok(())
}

/// Хук «проекция записана» (`onRoomSaved`, 2829–2835) — рассылка комнаты.
/// Толчки координатора боя и часов мира из того же хука — у С17.
fn broadcast_hook(core: Rc<GameCore>, campaign_id: String, room: Room) -> crate::core::LocalFuture<()> {
    Box::pin(async move {
        if let Err(error) = broadcast_campaign_room(&core, &campaign_id, Some(room)) {
            eprintln!("[Сказание] Не удалось разослать комнату {campaign_id}: {}", error.message);
        }
    })
}

/// Подписать рассылку комнаты на хук «проекция записана» (при сборке ядра).
pub fn install(core: &GameCore) {
    crate::projection::subscribe_projection_saved(core, broadcast_hook);
}

// --- рукопожатие и индикатор ввода (маршруты `routes/stream.rs`) -------------

/// Сокет и тело ответа одного потока до рукопожатия: тело создаётся сразу,
/// чтобы уход клиента во время рукопожатия тоже закрыл соединение.
pub struct PendingStream {
    link: Arc<StreamLink>,
    socket: SseSocket,
}

/// Подготовить поток: пишущая сторона уходит в ядро ([`open_stream`]), тело —
/// в ответ. `drain` сокета и уход клиента — задания ядра.
pub fn prepare_stream(state: &Arc<AppState>, campaign_id: &str) -> (PendingStream, SseBody) {
    let (socket, mut reader) = sk_infra::narration_stream::sse_socket(SOCKET_HIGH_WATER);
    let link = Arc::new(StreamLink::new(campaign_id.to_string(), socket.clone()));
    let weak = Arc::downgrade(state);
    let drained = link.clone();
    reader.set_on_drain(Box::new(move || {
        let Some(state) = weak.upgrade() else { return };
        let link = drained.clone();
        let _ = state.core.spawn(move |core| {
            Box::pin(async move {
                if let Some(live) = core.streams.live() {
                    live.drain(&link);
                }
            })
        });
    }));
    let body = SseBody { reader, guard: BodyGuard { link: link.clone(), state: Arc::downgrade(state) } };
    (PendingStream { link, socket }, body)
}

/// Рукопожатие `GET /api/campaigns/:id/stream` (4195–4281) на потоке ядра:
/// отказ до сверки, сверка проекции, доступ, затем регистрация соединения,
/// пульс и первая рассылка. `Err` — ответ JSON (заголовки ещё не ушли).
/// Сбой после «заголовков» (4203) обрывает поток, как `res.destroy()`
/// последней границы JS, и в лог идёт как необработанная ошибка маршрута.
pub fn open_stream(core: &Rc<GameCore>, user: &Value, campaign_id: &str, session_key: String, pending: PendingStream) -> Result<(), ApiError> {
    let Some(live) = core.streams.live() else { return Err(ApiError::internal("Реестр живых потоков не подключён")) };
    let forbidden = || ApiError::new(axum::http::StatusCode::FORBIDDEN, "Нет доступа к этой кампании");
    if crate::access::access_denied_before_reconcile(&live.accounts, Some(user), campaign_id, |id| crate::room::get_room(core, id)) {
        return Err(forbidden());
    }
    let room = crate::projection::reconcile_campaign_projection(core, campaign_id)?.ok_or_else(|| ApiError::internal("Cannot read properties of null (reading 'state')"))?;
    let Some(room_state) = room.state.as_ref() else { return Err(ApiError::new(axum::http::StatusCode::NOT_FOUND, "Кампания не найдена")) };
    if !crate::access::can_access_room(&live.accounts, Some(user), &room)? {
        return Err(forbidden());
    }
    live.bind(core);
    let PendingStream { link, socket } = pending;
    socket.write(RETRY_CHUNK);
    drop(socket);
    if let Err(error) = live.register(core, user, campaign_id, session_key, room_state, &link) {
        eprintln!("[Сказание] Необработанная ошибка GET /api/campaigns/{campaign_id}/stream: {}", error.message);
        link.destroy();
        if let Some(connection) = live.connection(campaign_id, &lock(&link.id)) {
            live.close(&connection);
        }
    }
    Ok(())
}

impl LiveStreams {
    fn register(&self, core: &Rc<GameCore>, user: &Value, campaign_id: &str, session_key: String, room_state: &Value, link: &Arc<StreamLink>) -> Result<(), Failure> {
        let id = format!("stream-{}-{}", std::process::id(), self.sequence.fetch_add(1, Ordering::SeqCst) + 1);
        *lock(&link.id) = id.clone();
        let hero_ids = crate::access::campaign_hero_ids(&self.accounts, user, campaign_id)?;
        let actor_id = actor_for(&hero_ids, room_state);
        // Администратор ведёт весь отряд, но за его аккаунтом герои не
        // закреплены, поэтому heroIds пуст и присутствие показывало «0 в сети».
        let controls_party = user.get("role").and_then(Value::as_str) == Some("admin");
        let view = View { user: user.clone(), user_id: js::string(user.get("id")), hero_ids, actor_id, controls_party, map_hash: String::new() };
        // Одна ограниченная очередь на соединение для всех кадров:
        // `room`/`presence` схлопываются до последнего, переполнение закрывает
        // поток — переподключение получит полное разрешённое состояние.
        let writer = link.clone();
        let closer = link.clone();
        let campaign = campaign_id.to_string();
        let outbox = CampaignStreamOutbox::new(
            Box::new(move |chunk| if writer.is_closed() || writer.is_destroyed() { None } else { writer.write(chunk) }),
            None,
            Some(Box::new(move |reason: OutboxCloseReason, error: Option<&RenderError>| {
                let detail = error.map(|error| format!(": {error}")).unwrap_or_default();
                eprintln!("[Сказание] Живой поток {campaign} закрыт ({}{detail}): клиент переподключится и получит состояние заново", reason.as_str());
                closer.overflowed.store(true, Ordering::SeqCst);
                if !closer.is_destroyed() {
                    closer.destroy();
                }
            })),
        );
        let connection = Rc::new(Connection {
            id: id.clone(),
            campaign: campaign_id.to_string(),
            session_key,
            link: link.clone(),
            view: Arc::new(Mutex::new(view)),
            outbox: RefCell::new(outbox),
            heartbeat: RefCell::new(None),
        });
        self.campaigns.borrow_mut().entry(campaign_id.to_string()).or_default().insert(id, connection.clone());
        // Клиент ушёл, пока шло рукопожатие: тело уже уничтожено.
        if link.is_destroyed() {
            self.close(&connection);
            return Ok(());
        }
        *connection.heartbeat.borrow_mut() = Some(spawn_heartbeat(core, &connection, self.options.heartbeat));
        // При переподключении достаточно последнего полного снимка каждого
        // незавершённого текста; сырьевые дельты и механика здесь не хранятся
        // (`campaignNarrationStream.replay`, 4279; С18.5).
        narration(core).replay(campaign_id, &StreamHandle { link: link.clone() }).map_err(|error| Failure::new(error.message, Some(error.code)))?;
        broadcast_campaign_room(core, campaign_id, None)
    }
}

fn spawn_heartbeat(core: &Rc<GameCore>, connection: &Rc<Connection>, period: Duration) -> tokio::task::JoinHandle<()> {
    let core = Rc::downgrade(core);
    let connection = Rc::downgrade(connection);
    // Таймер, а не задание: остановка ядра его не ждёт (`spawn_in_context`
    // учитывает задачи до предела), а `close` снимает его сразу.
    tokio::task::spawn_local(async move {
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let (Some(core), Some(connection)) = (core.upgrade(), connection.upgrade()) else { break };
            let Some(live) = core.streams.live() else { break };
            live.heartbeat(&connection);
        }
    })
}

// --- поток рассказа ядра (С18.5) -------------------------------------------

/// `campaignNarrationStream` (`index.mjs:285–291`): снимки текста рассказа,
/// пока его пишет модель.
pub type NarrationHub = CampaignNarrationStream<StreamHandle>;

/// Таймер снимка, сработавший в рантайме ядра: id и обратный вызов.
type FiredTimer = (u64, TimerCallback);

thread_local! {
    /// Поток рассказа этого ядра: живёт на потоке ядра, как и реестр потоков.
    static NARRATION: RefCell<Option<NarrationHub>> = const { RefCell::new(None) };
    /// Ядро для `connectionsFor` и `write` потока рассказа: замыкания
    /// `CampaignNarrationStream` обязаны быть `Send + Sync`, поэтому ядро они
    /// берут отсюда, а не захватывают.
    static NARRATION_CORE: RefCell<Weak<GameCore>> = RefCell::new(Weak::new());
}

fn with_narration_core<R>(operation: impl FnOnce(&GameCore) -> R) -> Option<R> {
    let core = NARRATION_CORE.with(|slot| slot.borrow().upgrade())?;
    Some(operation(&core))
}

/// Таймеры снимков (`setTimeout` потока рассказа): сон — задача рантайма
/// ядра, а обратный вызов исполняется в `LocalSet` ядра (через канал),
/// потому что рассылка может закрыть соединение, а закрытие ставит фоновую
/// задачу ядра (`spawn_local`). Отменённый таймер не срабатывает, даже если
/// его сон уже кончился.
struct CoreTimers {
    handle: tokio::runtime::Handle,
    next: AtomicU64,
    armed: Arc<Mutex<HashMap<u64, Option<tokio::task::AbortHandle>>>>,
    fire: tokio::sync::mpsc::UnboundedSender<FiredTimer>,
}

impl StreamTimers for CoreTimers {
    fn set_timer(&self, delay: Duration, callback: TimerCallback) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&self.armed).insert(id, None);
        let fire = self.fire.clone();
        let task = self.handle.spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = fire.send((id, callback));
        });
        if let Some(slot) = lock(&self.armed).get_mut(&id) {
            *slot = Some(task.abort_handle());
        }
        TimerId(id)
    }

    fn clear_timer(&self, timer: TimerId) {
        if let Some(Some(task)) = lock(&self.armed).remove(&timer.0) {
            task.abort();
        }
    }
}

fn build_narration() -> NarrationHub {
    let (fire, mut fired) = tokio::sync::mpsc::unbounded_channel::<FiredTimer>();
    let armed: Arc<Mutex<HashMap<u64, Option<tokio::task::AbortHandle>>>> = Arc::default();
    let timers = CoreTimers { handle: tokio::runtime::Handle::current(), next: AtomicU64::new(0), armed: armed.clone(), fire };
    // Задача вне учёта ядра: остановка её просто отменяет вместе с `LocalSet`.
    tokio::task::spawn_local(async move {
        while let Some((id, callback)) = fired.recv().await {
            if lock(&armed).remove(&id).is_some() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback));
            }
        }
    });
    CampaignNarrationStream::new(NarrationStreamOptions {
        // `connectionsFor` (286–289): лёгкая сверка, затем открытые соединения.
        connections_for: Box::new(|campaign_id| with_narration_core(|core| core.streams.live().map(|live| live.narration_connections(campaign_id)).unwrap_or_default()).unwrap_or_default()),
        // `write` (290): кадр через очередь соединения (`writeCampaignStream`).
        write: Box::new(|handle, event, payload| {
            with_narration_core(|core| {
                if let Some(live) = core.streams.live() {
                    if let Err(error) = live.write_event(handle, event, payload) {
                        eprintln!("[Сказание] Кадр рассказа не собран: {error}");
                    }
                }
            });
        }),
        coalesce_ms: None,
        max_active: None,
        timers: Arc::new(timers),
        now: Arc::new(sk_core::clock::now_ms),
    })
}

/// Поток рассказа ядра; вызывается только из задания ядра (в `LocalSet`):
/// первый вызов собирает поток и его таймеры, каждый — привязывает ядро для
/// рассылки.
pub fn narration(core: &Rc<GameCore>) -> NarrationHub {
    NARRATION_CORE.with(|slot| *slot.borrow_mut() = Rc::downgrade(core));
    NARRATION.with(|slot| {
        let mut slot = slot.borrow_mut();
        slot.get_or_insert_with(build_narration).clone()
    })
}

/// Проверки `PUT …/presence/typing` до чтения тела (4175–4179): комната без
/// сверки, затем доступ.
pub fn typing_room_check(core: &GameCore, user: &Value, campaign_id: &str) -> Result<(), ApiError> {
    let Some(live) = core.streams.live() else { return Err(ApiError::internal("Реестр живых потоков не подключён")) };
    let room = crate::room::get_room(core, campaign_id)?;
    if room.state.is_none() {
        return Err(ApiError::new(axum::http::StatusCode::NOT_FOUND, "Кампания не найдена"));
    }
    if !crate::access::can_access_room(&live.accounts, Some(user), &room)? {
        return Err(ApiError::new(axum::http::StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
    }
    Ok(())
}

/// Остаток `PUT …/presence/typing` (4181–4192): владелец героя, запись
/// индикатора, рассылка кадра `presence`.
pub fn set_typing(core: &GameCore, user: &Value, campaign_id: &str, actor_id: &str, typing: bool) -> Result<(), ApiError> {
    let Some(live) = core.streams.live() else { return Err(ApiError::internal("Реестр живых потоков не подключён")) };
    if !crate::access::can_use_hero(&live.accounts, user, Some(&Value::String(actor_id.to_string())), campaign_id)? {
        return Err(ApiError::coded(axum::http::StatusCode::FORBIDDEN, "Индикатор ввода доступен только владельцу героя", "ACTOR_FORBIDDEN"));
    }
    live.set_typing(campaign_id, &js::string(user.get("id")), actor_id, typing);
    live.broadcast_typing(campaign_id);
    Ok(())
}

/// Закончить все живые потоки при остановке (до ожидания соединений).
pub async fn close_all(state: &AppState) {
    let ended = state.core.call(|core| {
        Box::pin(async move {
            if let Some(live) = core.streams.live() {
                live.end_all();
            }
        })
    });
    let _ = tokio::time::timeout(Duration::from_secs(1), ended).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_numbers_share_one_sequence() {
        let sequence = AtomicU64::new(0);
        assert_eq!(frame(&sequence, "access", &json!({ "status": "revoked", "reason": "session_ended" })), "id: 1\nevent: access\ndata: {\"status\":\"revoked\",\"reason\":\"session_ended\"}\n\n");
        assert_eq!(frame(&sequence, "presence", &json!({ "typing_actor_ids": [] })), "id: 2\nevent: presence\ndata: {\"typing_actor_ids\":[]}\n\n");
    }

    #[test]
    fn actor_is_first_own_hero_on_the_board() {
        let state = json!({ "players": [{ "id": "b" }, { "id": 7 }] });
        assert_eq!(actor_for(&["a".into(), "7".into(), "b".into()], &state), "7");
        assert_eq!(actor_for(&["z".into()], &state), "");
        assert_eq!(actor_for(&["b".into()], &json!({})), "");
    }
}
