//! Игровое ядро в одном потоке — решение ведущего №1 (`rust/SERVER-PLAN.md`,
//! «Решения ведущего»).
//!
//! JS однопоточный: запросы перемежаются на `await`, а крейты движка
//! (`CombatTurnCoordinator`, `PostCommitCoordinator`, планировщик ходов NPC)
//! перенесены с `RefCell`/`Rc`, то есть без `Send`. Поэтому всё игровое
//! состояние живёт в [`GameCore`] на отдельном потоке с `current_thread`-
//! рантаймом и `LocalSet`. HTTP-слой axum шлёт ядру задания по каналу
//! ([`LocalExecutor::call`]) и ждёт ответ:
//!
//! - каждое задание — своя локальная задача (`spawn_local`), поэтому ожидание
//!   модели в одном запросе не блокирует голоса, кубик и `typing` другого —
//!   как цикл событий Node; отдельный замок кампании не нужен, а конфликт
//!   `expected_state_version` по-прежнему ловит хранилище (409);
//! - блокирующие вызовы (SQLite с fsync FULL, scrypt) задание уводит в
//!   [`blocking`] — `spawn_blocking` рантайма ядра, — и результат
//!   возвращается в ядро;
//! - паника в задании гасит только его: вызывающий получает
//!   [`CoreError::Panicked`] (граница отвечает 500), ядро живёт дальше;
//! - настройки ИИ кампании ([`crate::ai_context`]) переносятся в задание.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Mutex;
use std::thread::JoinHandle;

use tokio::sync::{mpsc, oneshot};

/// Будущее задания ядра: локальное, без `Send`.
pub type LocalFuture<T> = Pin<Box<dyn Future<Output = T> + 'static>>;

type Job<C> = Box<dyn FnOnce(Rc<C>) -> LocalFuture<()> + Send + 'static>;

/// Отказ обращения к ядру.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    /// Ядро остановлено (или не запустилось).
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
/// С0 кладёт сюда журнал и реестр бросков; С1 (комната, проекция), С9
/// (рассылка), С17 (координатор боя, часы) и О1/О2 (оркестраторы) добавляют
/// свои поля сюда же — через ведущего, как и в `AppState`.
pub struct GameCore {
    /// Журнал кампаний (`FileEventStore`, `index.mjs:327–337`): редьюсер
    /// движка, карты по хешу, один файл `skazanie.sqlite`.
    pub events: std::sync::Arc<sk_store::EventStore>,
    /// `RollRegistry` (`index.mjs:292–295`), файл `engine/roll-registry.json`.
    pub rolls: std::cell::RefCell<sk_infra::roll_registry::RollRegistry>,
    /// Общие кости ядра (`diceService`, `index.mjs:291`).
    pub dice: crate::state::SharedDice,
}

/// Однопоточный исполнитель заданий над состоянием `C`.
pub struct LocalExecutor<C: 'static> {
    sender: Mutex<Option<mpsc::UnboundedSender<Job<C>>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

/// Связь с игровым ядром.
pub type CoreHandle = LocalExecutor<GameCore>;

impl<C: 'static> LocalExecutor<C> {
    /// Запустить поток; `build` собирает состояние уже на нём.
    pub fn start<B>(name: &str, build: B) -> Result<Self, String>
    where
        B: FnOnce() -> Result<C, String> + Send + 'static,
    {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Job<C>>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("рантайм ядра не запустился: {error}")));
                        return;
                    }
                };
                let state = match build() {
                    Ok(state) => Rc::new(state),
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    while let Some(job) = receiver.recv().await {
                        // Паника внутри задачи ловится рантаймом: отправитель
                        // ответа уничтожается вместе с ней, вызывающий видит
                        // `Panicked`, цикл заданий продолжается.
                        tokio::task::spawn_local(job(state.clone()));
                    }
                });
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
    /// возвращает, живёт только там и может держать `Rc`/`RefCell`.
    /// Настройки ИИ кампании текущего запроса действуют и в задании.
    pub async fn call<R, F>(&self, job: F) -> Result<R, CoreError>
    where
        R: Send + 'static,
        F: FnOnce(Rc<C>) -> LocalFuture<R> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel::<R>();
        let settings = crate::ai_context::capture();
        self.send(Box::new(move |state| {
            Box::pin(crate::ai_context::with_campaign_ai(settings, async move {
                let result = job(state).await;
                let _ = reply_tx.send(result);
            }))
        }))?;
        reply_rx.await.map_err(|_| CoreError::Panicked)
    }

    /// Поставить задание без ожидания ответа (фоновая работа ядра). Настройки
    /// ИИ захватываются при постановке, как `queueMicrotask` в JS.
    pub fn spawn<F>(&self, job: F) -> Result<(), CoreError>
    where
        F: FnOnce(Rc<C>) -> LocalFuture<()> + Send + 'static,
    {
        let settings = crate::ai_context::capture();
        self.send(Box::new(move |state| Box::pin(crate::ai_context::with_campaign_ai(settings, job(state)))))
    }

    /// Остановить ядро: новые задания не принимаются, цикл заданий
    /// завершается, незаконченные задачи отменяются, поток дожидается.
    /// Повторный вызов ничего не делает.
    pub fn shutdown(&self) {
        drop(self.sender.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take());
        let thread = self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(thread) = thread {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl<C: 'static> Drop for LocalExecutor<C> {
    fn drop(&mut self) {
        // Закрытый канал сам завершает цикл ядра; поток не ждём, чтобы
        // уничтожение состояния не зависело от незаконченных задач.
        drop(self.sender.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take());
    }
}

/// Блокирующая работа из задания ядра (или любой задачи): `spawn_blocking`
/// текущего рантайма с переносом настроек ИИ кампании; результат
/// возвращается вызывающему. Паника внутри — [`CoreError::Panicked`].
pub async fn blocking<R, F>(operation: F) -> Result<R, CoreError>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let settings = crate::ai_context::capture();
    tokio::task::spawn_blocking(move || crate::ai_context::run_sync(settings, operation)).await.map_err(|_| CoreError::Panicked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_jobs_interleave_on_await() {
        let core = Arc::new(executor());
        let first = {
            let core = core.clone();
            tokio::spawn(async move {
                core.call(|state| {
                    Box::pin(async move {
                        state.lines.borrow_mut().push("a:начало".into());
                        let gate = state.gate.clone();
                        // Ждёт, пока второе задание не откроет ворота: при
                        // последовательной обработке это была бы взаимная блокировка.
                        gate.notified().await;
                        state.lines.borrow_mut().push("a:конец".into());
                        std::thread::current().id()
                    })
                })
                .await
            })
        };
        // Первое задание должно успеть дойти до ожидания.
        loop {
            let started = core.call(|state| Box::pin(async move { state.lines.borrow().len() })).await;
            if started == Ok(1) {
                break;
            }
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
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), first).await.ok().and_then(Result::ok).and_then(Result::ok);
        let lines = core.call(|state| Box::pin(async move { state.lines.borrow().clone() })).await;
        assert_eq!(lines, Ok(vec!["a:начало".to_string(), "b".to_string(), "a:конец".to_string()]));
        assert_eq!(first, second.ok(), "оба задания — в одном потоке ядра");
        core.shutdown();
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
        let alive = core.call(|state| Box::pin(async move { state.lines.borrow().len() })).await;
        assert_eq!(alive, Ok(0));
        core.shutdown();
        let stopped = core.call(|_state| Box::pin(async move {})).await;
        assert_eq!(stopped, Err(CoreError::Stopped));
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
}
