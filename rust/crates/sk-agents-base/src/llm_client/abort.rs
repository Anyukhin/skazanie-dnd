//! Отмена по образцу `AbortController`/`AbortSignal` и помощники
//! `makeAbortScope`, `raceWithSignal` из `server/llm-client.mjs`.
//!
//! Сигнал хранит причину отмены (ошибку) и будит ждущих. Дочерние сигналы
//! (`addEventListener('abort', …)` в JS) получают ту же причину. Область
//! [`AbortScope`] — свой контроллер с таймером и связью с внешним сигналом;
//! снимается при выходе из области (`finally { scope.close() }`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::Notify;

use super::{node_timer_delay, LlmError, LlmErrorExt};

#[derive(Default)]
struct SignalInner {
    reason: Mutex<Option<LlmError>>,
    notify: Notify,
    children: Mutex<Vec<(u64, Weak<SignalInner>)>>,
}

static NEXT_LINK: AtomicU64 = AtomicU64::new(1);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl SignalInner {
    fn abort(&self, reason: LlmError) {
        {
            let mut slot = lock(&self.reason);
            if slot.is_some() {
                return;
            }
            *slot = Some(reason.clone());
        }
        let children = std::mem::take(&mut *lock(&self.children));
        for (_, child) in children {
            if let Some(child) = child.upgrade() {
                child.abort(reason.clone());
            }
        }
        self.notify.notify_waiters();
    }
}

/// `AbortSignal`: признак отмены и её причина.
#[derive(Clone, Default)]
pub struct AbortSignal {
    inner: Arc<SignalInner>,
}

impl std::fmt::Debug for AbortSignal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AbortSignal").field("aborted", &self.aborted()).finish()
    }
}

impl AbortSignal {
    /// `signal.aborted`.
    pub fn aborted(&self) -> bool {
        lock(&self.inner.reason).is_some()
    }

    /// `signal.reason`.
    pub fn reason(&self) -> Option<LlmError> {
        lock(&self.inner.reason).clone()
    }

    /// Дождаться отмены; результат — причина.
    pub async fn wait(&self) -> LlmError {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(reason) = self.reason() {
                return reason;
            }
            notified.await;
        }
    }

    /// `signal.addEventListener('abort', () => child.abort(signal.reason))`:
    /// уже отменённый сигнал отменяет ребёнка сразу.
    fn link(&self, child: &AbortController) -> Option<u64> {
        let mut children = lock(&self.inner.children);
        if let Some(reason) = self.reason() {
            drop(children);
            child.abort(reason);
            return None;
        }
        let id = NEXT_LINK.fetch_add(1, Ordering::Relaxed);
        children.push((id, Arc::downgrade(&child.signal.inner)));
        Some(id)
    }

    fn unlink(&self, id: u64) {
        lock(&self.inner.children).retain(|(link, child)| *link != id && child.strong_count() > 0);
    }
}

/// `AbortController`.
#[derive(Clone, Default, Debug)]
pub struct AbortController {
    signal: AbortSignal,
}

impl AbortController {
    pub fn new() -> Self {
        Self::default()
    }

    /// `controller.signal`.
    pub fn signal(&self) -> AbortSignal {
        self.signal.clone()
    }

    /// `controller.abort(reason)`; повторный вызов ничего не меняет.
    pub fn abort(&self, reason: LlmError) {
        self.signal.inner.abort(reason);
    }

    /// `controller.abort()` без причины: `AbortError`.
    pub fn abort_default(&self) {
        self.abort(LlmError::other("AbortError", "This operation was aborted"));
    }
}

/// `makeAbortScope(timeoutMs, externalSignal)`: контроллер, который отменяется
/// по таймеру (`LLMTimeoutError`) или вместе с внешним сигналом.
pub(crate) struct AbortScope {
    controller: AbortController,
    timed_out: Arc<AtomicBool>,
    timer: tokio::task::JoinHandle<()>,
    link: Option<(AbortSignal, u64)>,
}

impl AbortScope {
    /// Требует среды tokio (таймер — отдельная задача).
    pub(crate) fn new(timeout_ms: f64, external: Option<&AbortSignal>) -> Self {
        let controller = AbortController::new();
        let timed_out = Arc::new(AtomicBool::new(false));
        let timer = {
            let controller = controller.clone();
            let timed_out = Arc::clone(&timed_out);
            tokio::spawn(async move {
                tokio::time::sleep(node_timer_delay(timeout_ms)).await;
                timed_out.store(true, Ordering::SeqCst);
                controller.abort(LlmError::timeout(timeout_ms));
            })
        };
        let link = external.and_then(|signal| signal.link(&controller).map(|id| (signal.clone(), id)));
        AbortScope { controller, timed_out, timer, link }
    }

    pub(crate) fn signal(&self) -> AbortSignal {
        self.controller.signal()
    }

    /// `scope.timedOut()`.
    pub(crate) fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::SeqCst)
    }
}

impl Drop for AbortScope {
    fn drop(&mut self) {
        self.timer.abort();
        if let Some((signal, id)) = self.link.take() {
            signal.unlink(id);
        }
    }
}

/// Связь «внешний сигнал → контроллер» без таймера (`deadlineController` в
/// каскаде); снимается при выходе из области.
pub(crate) struct SignalLink {
    link: Option<(AbortSignal, u64)>,
}

impl SignalLink {
    pub(crate) fn new(parent: &AbortSignal, child: &AbortController) -> Self {
        SignalLink { link: parent.link(child).map(|id| (parent.clone(), id)) }
    }
}

impl Drop for SignalLink {
    fn drop(&mut self) {
        if let Some((signal, id)) = self.link.take() {
            signal.unlink(id);
        }
    }
}

/// `raceWithSignal(operation, signal)`: результат операции или причина
/// отмены сигнала, что наступит раньше. Отменённая гонка снимает операцию
/// (в JS она продолжала бы работать в фоне).
pub(crate) async fn race<T>(operation: impl std::future::Future<Output = Result<T, LlmError>>, signal: Option<&AbortSignal>) -> Result<T, LlmError> {
    let Some(signal) = signal else {
        return operation.await;
    };
    if let Some(reason) = signal.reason() {
        return Err(reason);
    }
    tokio::select! {
        biased;
        reason = signal.wait() => Err(reason),
        result = operation => result,
    }
}

/// Таймер как `setTimeout`, прерываемый сигналом (`waitFor` у `FakeLLM`).
pub(crate) async fn sleep_with_signal(milliseconds: f64, signal: &AbortSignal) -> Result<(), LlmError> {
    if let Some(reason) = signal.reason() {
        return Err(reason);
    }
    tokio::select! {
        biased;
        reason = signal.wait() => Err(reason),
        () = tokio::time::sleep(node_timer_delay(milliseconds)) => Ok(()),
    }
}
