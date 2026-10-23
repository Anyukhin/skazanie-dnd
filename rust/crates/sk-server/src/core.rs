//! Игровое ядро в одном потоке — решение ведущего №1 (`rust/SERVER-PLAN.md`,
//! «Решения ведущего»).
//!
//! JS однопоточный: запросы перемежаются на `await`, а крейты движка
//! (`CombatTurnCoordinator`, `PostCommitCoordinator`, планировщик ходов NPC)
//! перенесены с `RefCell`/`Rc`, то есть без `Send`. Поэтому всё игровое
//! состояние живёт в [`GameCore`] на отдельном потоке с `current_thread`-
//! рантаймом и `LocalSet`. HTTP-слой axum шлёт ядру задания по каналу
//! ([`LocalExecutor::call`]) и ждёт ответ.
//!
//! Правила ядра:
//!
//! - каждое задание — своя локальная задача (`spawn_local`), поэтому ожидание
//!   модели в одном запросе не блокирует голоса, кубик и `typing` другого —
//!   как цикл событий Node; отдельный замок кампании не нужен, а конфликт
//!   `expected_state_version` по-прежнему ловит хранилище (409);
//! - **журнал (`EventStore`: commit, подтверждение проекции, чтение) зовётся
//!   синхронно, прямо на потоке ядра**, как `_withLock` JS
//!   (`event-store.mjs:377`, 989, 1164): fsync держит ядро так же, как цикл
//!   Node, зато продолжения после коммитов идут строго в порядке коммитов, и
//!   подтверждения проекций не переставляются (рецензия С0, CORE-05; уточнение
//!   решения №1 — «SQLite FULL через `spawn_blocking`» относится к тому, что в
//!   JS асинхронно);
//! - [`blocking`] (`spawn_blocking` рантайма ядра с возвратом в ядро) — только
//!   для того, что JS делает вне цикла: scrypt, чтение больших файлов,
//!   внешние процессы. Аккаунты (`Accounts`) с потока ядра синхронно не
//!   зовутся: их замок держат и HTTP-потоки;
//! - займы `RefCell` — только в синхронных отрезках, без `await` внутри
//!   (сторож — `clippy::await_holding_refcell_ref` в `lib.rs`): займ через
//!   `await` — паника `BorrowMutError` в соседнем задании;
//! - паника в задании гасит только его: вызывающий получает
//!   [`CoreError::Panicked`] (граница отвечает 500), ядро живёт дальше; это
//!   касается и синхронной части замыкания до `async`;
//! - фоновая работа ядра (хуки «проекция записана», толчки боя и часов) —
//!   только через [`spawn_in_context`]: задача учитывается, получает
//!   настройки ИИ кампании постановщика (как `queueMicrotask` в JS,
//!   `index.mjs:2829–2835`) и при остановке дожидается до предела;
//! - остановка: приём заданий закрывается, задачи в работе дожидаются до
//!   [`DRAIN_LIMIT`], остальные отменяются (вызывающий получает
//!   [`CoreError::Stopped`], а не `Panicked`), блокирующие — до
//!   [`BLOCKING_LIMIT`].

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::thread::JoinHandle;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

/// Будущее задания ядра: локальное, без `Send`.
pub type LocalFuture<T> = Pin<Box<dyn Future<Output = T> + 'static>>;

type Job<C> = Box<dyn FnOnce(Rc<C>) -> LocalFuture<()> + Send + 'static>;

/// Сколько остановка ждёт задачи ядра в работе.
pub const DRAIN_LIMIT: Duration = Duration::from_secs(2);
/// Сколько остановка ждёт блокирующие задачи рантайма ядра.
pub const BLOCKING_LIMIT: Duration = Duration::from_secs(1);

/// Отказ обращения к ядру.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    /// Ядро остановлено (или не запустилось), либо задание отменено
    /// остановкой, либо фоновую задачу ставят не с потока ядра.
    Stopped,
    /// Задание запаниковало; ядро продолжает работу.
    Panicked,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::Stopped => formatter.write_str("игровое ядро остановлено"),
            CoreError::Panicked => formatter.write_str("задание игрового ядра завершилось паникой"),
        }
    }
}

impl std::error::Error for CoreError {}

/// Состояние, которым владеет только поток ядра.
///
/// С0 кладёт сюда журнал, реестр бросков и реестр живых потоков; С1
/// (комната, проекция), С9 (рассылка), С17 (координатор боя, часы) и О1/О2
/// (оркестраторы) добавляют свои поля сюда же — через ведущего, как и в
/// `AppState`.
pub struct GameCore {
    /// Журнал кампаний (`FileEventStore`, `index.mjs:327–337`): редьюсер
    /// движка, карты по хешу, один файл `skazanie.sqlite`. Вызывается
    /// синхронно на потоке ядра (см. шапку модуля).
    pub events: std::sync::Arc<sk_store::EventStore>,
    /// `RollRegistry` (`index.mjs:292–295`), файл `engine/roll-registry.json`.
    pub rolls: RefCell<sk_infra::roll_registry::RollRegistry>,
    /// Общие кости ядра (`diceService`, `index.mjs:291`).
    pub dice: crate::state::SharedDice,
    /// Живые потоки кампаний (`campaignStreams`); в С0 — заглушка. Только на
    /// потоке ядра: рассылка, отзыв и присутствие — без замков.
    pub streams: Box<dyn crate::streams::StreamRegistry>,
    /// Подписчики «проекция записана» (`onRoomSaved`, `store.mjs:438–442`):
    /// рассылка (С9), координатор боя и часы мира (С17). Вызываются после
    /// каждой записи комнаты (С1, `room::save_room`).
    pub room_hooks: RefCell<Vec<crate::projection::ProjectionSavedHook>>,
}

// --- учёт задач ядра -------------------------------------------------------

/// Счётчик задач ядра (заданий и фоновых); живёт в потоке ядра.
#[derive(Default)]
struct Tracker {
    active: Cell<usize>,
}

struct TrackGuard(Rc<Tracker>);

impl Drop for TrackGuard {
    fn drop(&mut self) {
        self.0.active.set(self.0.active.get().saturating_sub(1));
    }
}

thread_local! {
    /// Учёт задач — только у потока ядра.
    static TRACKER: RefCell<Option<Rc<Tracker>>> = const { RefCell::new(None) };
    /// Поток ядра или его блокирующий поток: отсюда ждать ядро нельзя.
    static ON_CORE: Cell<bool> = const { Cell::new(false) };
}

fn tracker() -> Option<Rc<Tracker>> {
    TRACKER.with(|slot| slot.borrow().clone())
}

/// Поставить локальную задачу с учётом; не с потока ядра — `Stopped`.
fn spawn_tracked<F: Future<Output = ()> + 'static>(future: F) -> Result<(), CoreError> {
    let tracker = tracker().ok_or(CoreError::Stopped)?;
    tracker.active.set(tracker.active.get() + 1);
    let guard = TrackGuard(tracker);
    tokio::task::spawn_local(async move {
        let _guard = guard;
        let _ = CatchUnwind::new(future).await;
    });
    Ok(())
}

/// Фоновая задача ядра — замена `queueMicrotask` JS: учитывается (остановка
/// её дожидается до предела), получает настройки ИИ кампании, видимые сейчас
/// (в задании запроса — настройки этой кампании), паника гасит только её.
/// Вызывается только с потока ядра; иначе — [`CoreError::Stopped`].
pub fn spawn_in_context<F: Future<Output = ()> + 'static>(future: F) -> Result<(), CoreError> {
    let settings = crate::ai_context::capture();
    spawn_tracked(crate::ai_context::with_campaign_ai(settings, future))
}

/// Текст паники для лога.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload.downcast_ref::<&str>().map(|text| text.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "паника без текста".to_string())
}

/// Будущее, паника в опросе которого становится `Err(())`.
struct CatchUnwind<F> {
    inner: Pin<Box<F>>,
}

impl<F> CatchUnwind<F> {
    fn new(inner: F) -> Self {
        Self { inner: Box::pin(inner) }
    }
}

impl<F: Future> Future for CatchUnwind<F> {
    type Output = Result<F::Output, ()>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let inner = self.get_mut().inner.as_mut();
        match std::panic::catch_unwind(AssertUnwindSafe(|| inner.poll(cx))) {
            Ok(Poll::Ready(value)) => Poll::Ready(Ok(value)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(Err(())),
        }
    }
}

/// Ответ заданию: если задачу отменили (остановка), вызывающий получает
/// `Stopped`, а не ложную «панику».
struct Reply<R> {
    sender: Option<oneshot::Sender<Result<R, CoreError>>>,
}

impl<R> Reply<R> {
    fn send(&mut self, value: Result<R, CoreError>) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(value);
        }
    }
}

impl<R> Drop for Reply<R> {
    fn drop(&mut self) {
        self.send(Err(CoreError::Stopped));
    }
}

// --- исполнитель -----------------------------------------------------------

/// Однопоточный исполнитель заданий над состоянием `C`.
pub struct LocalExecutor<C: 'static> {
    sender: Mutex<Option<mpsc::UnboundedSender<Job<C>>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

/// Связь с игровым ядром.
pub type CoreHandle = LocalExecutor<GameCore>;

impl<C: 'static> LocalExecutor<C> {
    /// Запустить поток; `build` собирает состояние уже на нём, внутри
    /// рантайма ядра (таймеры и `Handle::current()` при сборке доступны).
    pub fn start<B>(name: &str, build: B) -> Result<Self, String>
    where
        B: FnOnce() -> Result<C, String> + Send + 'static,
    {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Job<C>>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                ON_CORE.with(|flag| flag.set(true));
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().on_thread_start(|| ON_CORE.with(|flag| flag.set(true))).build() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("рантайм ядра не запустился: {error}")));
                        return;
                    }
                };
                let built = {
                    let _enter = runtime.enter();
                    std::panic::catch_unwind(AssertUnwindSafe(build))
                };
                let state = match built {
                    Ok(Ok(state)) => Rc::new(state),
                    Ok(Err(error)) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                    Err(payload) => {
                        let _ = ready_tx.send(Err(format!("сборка ядра запаниковала: {}", panic_text(payload.as_ref()))));
                        return;
                    }
                };
                let tracker = Rc::new(Tracker::default());
                TRACKER.with(|slot| *slot.borrow_mut() = Some(tracker.clone()));
                let _ = ready_tx.send(Ok(()));
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    while let Some(job) = receiver.recv().await {
                        // Синхронная часть замыкания тоже может запаниковать —
                        // это гасит только задание, не цикл ядра.
                        match std::panic::catch_unwind(AssertUnwindSafe(|| job(state.clone()))) {
                            Ok(future) => {
                                let _ = spawn_tracked(future);
                            }
                            Err(payload) => eprintln!("[Сказание] Задание ядра запаниковало при постановке: {}", panic_text(payload.as_ref())),
                        }
                    }
                    // Остановка: задачи в работе дожидаются до предела.
                    let _ = tokio::time::timeout(DRAIN_LIMIT, async {
                        while tracker.active.get() > 0 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    })
                    .await;
                });
                // Оставшиеся задачи отменяются (ответ — `Stopped`), затем
                // блокирующие задачи ждутся с пределом, а не бесконечно.
                drop(local);
                TRACKER.with(|slot| slot.borrow_mut().take());
                runtime.shutdown_timeout(BLOCKING_LIMIT);
            })
            .map_err(|error| format!("поток ядра не запустился: {error}"))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self { sender: Mutex::new(Some(sender)), thread: Mutex::new(Some(thread)) }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err("поток ядра завершился при запуске".into())
            }
        }
    }

    fn send(&self, job: Job<C>) -> Result<(), CoreError> {
        let sender = self.sender.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        sender.as_ref().ok_or(CoreError::Stopped)?.send(job).map_err(|_| CoreError::Stopped)
    }

    /// Выполнить задание в ядре и дождаться ответа.
    ///
    /// Замыкание переносится в поток ядра (`Send`), а будущее, которое оно
    /// возвращает, живёт только там и может держать `Rc`/`RefCell`. Замыкание
    /// вызывается уже внутри задачи, так что паника в его синхронной части —
    /// тоже [`CoreError::Panicked`]. Настройки ИИ кампании текущего запроса
    /// действуют и в задании.
    pub async fn call<R, F>(&self, job: F) -> Result<R, CoreError>
    where
        R: Send + 'static,
        F: FnOnce(Rc<C>) -> LocalFuture<R> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel::<Result<R, CoreError>>();
        let settings = crate::ai_context::capture();
        self.send(Box::new(move |state| {
            let mut reply = Reply { sender: Some(reply_tx) };
            Box::pin(crate::ai_context::with_campaign_ai(settings, async move {
                let outcome = CatchUnwind::new(async move { job(state).await }).await;
                reply.send(outcome.map_err(|()| CoreError::Panicked));
            }))
        }))?;
        reply_rx.await.unwrap_or(Err(CoreError::Stopped))
    }

    /// Поставить задание без ожидания ответа (фоновая работа из HTTP-слоя).
    /// Настройки ИИ захватываются при постановке, как `queueMicrotask` в JS;
    /// замыкание вызывается внутри задачи — его паника гасит только его.
    /// Изнутри ядра — [`spawn_in_context`].
    pub fn spawn<F>(&self, job: F) -> Result<(), CoreError>
    where
        F: FnOnce(Rc<C>) -> LocalFuture<()> + Send + 'static,
    {
        let settings = crate::ai_context::capture();
        self.send(Box::new(move |state| Box::pin(crate::ai_context::with_campaign_ai(settings, async move { job(state).await }))))
    }

    /// Остановить ядро и дождаться его потока (не дольше
    /// `DRAIN_LIMIT + BLOCKING_LIMIT` плюс время синхронного отрезка задания).
    /// Повторный вызов ничего не делает. С потока ядра и его блокирующих
    /// потоков — только закрывает приём (ждать себя же — взаимная блокировка).
    pub fn shutdown(&self) {
        drop(self.sender.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take());
        if ON_CORE.with(Cell::get) {
            return;
        }
        let thread = self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }

    /// Закрыть приём заданий, не дожидаясь потока ядра.
    pub fn close(&self) {
        drop(self.sender.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take());
    }
}

impl<C: 'static> Drop for LocalExecutor<C> {
    fn drop(&mut self) {
        // Закрытый канал сам завершает цикл ядра; поток не ждём: уничтожение
        // может идти на потоке tokio или в блокирующем потоке самого ядра.
        // Дождаться — явно, `shutdown()` (main, тестовый набор).
        self.close();
    }
}

/// Блокирующая работа из задания ядра (или любой задачи): `spawn_blocking`
/// текущего рантайма с переносом настроек ИИ кампании; результат
/// возвращается вызывающему. Паника внутри — [`CoreError::Panicked`],
/// отмена остановкой — [`CoreError::Stopped`].
pub async fn blocking<R, F>(operation: F) -> Result<R, CoreError>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let settings = crate::ai_context::capture();
    match tokio::task::spawn_blocking(move || crate::ai_context::run_sync(settings, operation)).await {
        Ok(value) => Ok(value),
        Err(error) if error.is_panic() => Err(CoreError::Panicked),
        Err(_) => Err(CoreError::Stopped),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Notify;

    /// Состояние без `Send`: так выглядят координаторы движка.
    struct Journal {
        lines: RefCell<Vec<String>>,
        gate: Rc<Notify>,
    }

    fn executor() -> LocalExecutor<Journal> {
        LocalExecutor::start("test-core", || Ok(Journal { lines: RefCell::new(Vec::new()), gate: Rc::new(Notify::new()) })).unwrap_or_else(|error| panic!("{error}"))
    }

    fn lines_len(core: &LocalExecutor<Journal>) -> impl Future<Output = Result<usize, CoreError>> + '_ {
        core.call(|state| Box::pin(async move { state.lines.borrow().len() }))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_jobs_interleave_on_await() {
        // Регрессия «задания по очереди» здесь — взаимная блокировка; предел
        // превращает зависание в падение теста.
        let outcome = tokio::time::timeout(Duration::from_secs(5), async {
            let core = Arc::new(executor());
            let first = {
                let core = core.clone();
                tokio::spawn(async move {
                    core.call(|state| {
                        Box::pin(async move {
                            state.lines.borrow_mut().push("a:начало".into());
                            let gate = state.gate.clone();
                            gate.notified().await;
                            state.lines.borrow_mut().push("a:конец".into());
                            std::thread::current().id()
                        })
                    })
                    .await
                })
            };
            while lines_len(&core).await != Ok(1) {
                tokio::task::yield_now().await;
            }
            let second = core
                .call(|state| {
                    Box::pin(async move {
                        state.lines.borrow_mut().push("b".into());
                        state.gate.notify_one();
                        std::thread::current().id()
                    })
                })
                .await;
            let first = first.await.ok().and_then(Result::ok);
            let lines = core.call(|state| Box::pin(async move { state.lines.borrow().clone() })).await;
            core.shutdown();
            (first, second.ok(), lines)
        })
        .await;
        let Ok((first, second, lines)) = outcome else { panic!("задания ядра не перемежаются") };
        assert_eq!(lines, Ok(vec!["a:начало".to_string(), "b".to_string(), "a:конец".to_string()]));
        assert_eq!(first, second, "оба задания — в одном потоке ядра");
    }

    #[tokio::test]
    async fn blocking_call_returns_to_core() {
        let core = executor();
        let threads = core
            .call(|_state| {
                Box::pin(async move {
                    let before = std::thread::current().id();
                    let inside = blocking(|| std::thread::current().id()).await;
                    let after = std::thread::current().id();
                    (before, inside, after)
                })
            })
            .await;
        let Ok((before, Ok(inside), after)) = threads else { panic!("задание не выполнилось: {threads:?}") };
        assert_ne!(before, inside, "блокирующая работа — не в потоке ядра");
        assert_eq!(before, after, "после await задание снова в ядре");
        core.shutdown();
    }

    #[tokio::test]
    async fn panic_in_job_keeps_core_alive() {
        let core = executor();
        let failed: Result<(), CoreError> = core.call(|_state| Box::pin(async move { panic!("сбой задания") })).await;
        assert_eq!(failed, Err(CoreError::Panicked));
        let failed_sync: Result<(), CoreError> = core
            .call(|_state| {
                if std::hint::black_box(true) {
                    panic!("сбой до будущего");
                }
                Box::pin(async move {})
            })
            .await;
        assert_eq!(failed_sync, Err(CoreError::Panicked), "синхронная часть замыкания");
        assert_eq!(lines_len(&core).await, Ok(0));
        core.shutdown();
        let stopped = core.call(|_state| Box::pin(async move {})).await;
        assert_eq!(stopped, Err(CoreError::Stopped));
    }

    #[tokio::test]
    async fn panic_in_spawned_job_keeps_core_alive() {
        let core = executor();
        // Паника в синхронной части замыкания `spawn` (раньше — смерть потока ядра).
        let queued = core.spawn(|_state| {
            if std::hint::black_box(true) {
                panic!("сбой до будущего");
            }
            Box::pin(async {})
        });
        assert_eq!(queued, Ok(()));
        assert_eq!(core.spawn(|_state| Box::pin(async { panic!("сбой в будущем") })), Ok(()));
        assert_eq!(lines_len(&core).await, Ok(0), "ядро живо после паник в spawn");
        core.shutdown();
    }

    #[tokio::test]
    async fn cancelled_by_shutdown_is_stopped_not_panicked() {
        let core = Arc::new(executor());
        let waiting = {
            let core = core.clone();
            tokio::spawn(async move { core.call(|_state| Box::pin(std::future::pending::<()>())).await })
        };
        // Канал заданий упорядочен: ответ на это задание значит, что
        // ожидающее уже поставлено в ядро.
        assert_eq!(lines_len(&core).await, Ok(0));
        let stopper = core.clone();
        let _ = tokio::task::spawn_blocking(move || stopper.shutdown()).await;
        assert_eq!(waiting.await.ok(), Some(Err(CoreError::Stopped)));
    }

    #[tokio::test]
    async fn build_runs_inside_runtime_and_reports_panics() {
        let timers = LocalExecutor::start("test-core-timer", || {
            // Без входа в рантайм это паника «there is no reactor running».
            let _sleep = tokio::time::sleep(Duration::from_millis(1));
            Ok(())
        });
        assert!(timers.is_ok(), "{:?}", timers.err());
        if let Ok(core) = timers {
            core.shutdown();
        }
        let failed = LocalExecutor::<()>::start("test-core-panic", || panic!("нет базы"));
        assert_eq!(failed.err().as_deref(), Some("сборка ядра запаниковала: нет базы"));
    }

    #[tokio::test]
    async fn campaign_ai_settings_travel_with_job() {
        let core = executor();
        let settings = serde_json::json!({ "model": "a/x" });
        let seen = crate::ai_context::with_campaign_ai(Some(settings), async {
            core.call(|_state| {
                Box::pin(async move {
                    let direct = sk_narration_base::campaign_ai_context::current_campaign_model();
                    let blocked = blocking(sk_narration_base::campaign_ai_context::current_campaign_model).await.unwrap_or_default();
                    (direct, blocked)
                })
            })
            .await
        })
        .await;
        assert_eq!(seen, Ok(("a/x".to_string(), "a/x".to_string())));
        core.shutdown();
    }

    /// Фоновая задача, поставленная из задания кампании, видит её настройки —
    /// даже после того как задание закончилось (`queueMicrotask` JS).
    #[tokio::test]
    async fn background_task_inherits_campaign_settings() {
        let core = executor();
        let queued = crate::ai_context::with_campaign_ai(Some(serde_json::json!({ "model": "a/bg" })), async {
            core.call(|state| {
                Box::pin(async move {
                    let target = state.clone();
                    spawn_in_context(async move {
                        tokio::task::yield_now().await;
                        target.lines.borrow_mut().push(sk_narration_base::campaign_ai_context::current_campaign_model());
                    })
                })
            })
            .await
        })
        .await;
        assert_eq!(queued, Ok(Ok(())));
        let mut seen = Vec::new();
        for _ in 0..200 {
            seen = core.call(|state| Box::pin(async move { state.lines.borrow().clone() })).await.unwrap_or_default();
            if !seen.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(seen, vec!["a/bg".to_string()]);
        assert_eq!(spawn_in_context(async {}), Err(CoreError::Stopped), "не с потока ядра");
        core.shutdown();
    }
}
