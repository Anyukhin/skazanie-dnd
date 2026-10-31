//! Скользящее окно запросов по ключу — перенос `server/rate-window.mjs`:
//! предел частоты входа и дорогих запросов. Ключ без отметок внутри окна
//! удаляется; уборка — не чаще раза в окно или когда карта переросла порог.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Окно по умолчанию: десять минут, как у входа и дорогих запросов.
pub const RATE_WINDOW_MS: i64 = 10 * 60 * 1000;

struct Inner {
    entries: HashMap<String, Vec<i64>>,
    pruned_at: i64,
    size_prune_at: usize,
    widest_window_ms: i64,
}

/// `SlidingWindowCounter`.
pub struct SlidingWindowCounter {
    window_ms: i64,
    prune_above_size: usize,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    inner: Mutex<Inner>,
}

impl SlidingWindowCounter {
    pub fn new(window_ms: i64, prune_above_size: usize, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        let started = now();
        Self {
            window_ms,
            prune_above_size,
            now,
            inner: Mutex::new(Inner { entries: HashMap::new(), pruned_at: started, size_prune_at: prune_above_size, widest_window_ms: window_ms }),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(RATE_WINDOW_MS, 1_000, Arc::new(sk_core::clock::now_ms))
    }

    /// `hit(key, limit, windowMs)`: отметить запрос; `true` — предел превышен.
    pub fn hit(&self, key: &str, limit: usize, window_ms: Option<i64>) -> bool {
        let window_ms = window_ms.unwrap_or(self.window_ms);
        let now = (self.now)();
        let mut inner = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if window_ms > inner.widest_window_ms {
            inner.widest_window_ms = window_ms;
        }
        Self::prune(&mut inner, now, self.prune_above_size);
        let mut recent: Vec<i64> = inner.entries.get(key).map(|times| times.iter().copied().filter(|time| now - time < window_ms).collect()).unwrap_or_default();
        recent.push(now);
        let exceeded = recent.len() > limit;
        inner.entries.insert(key.to_string(), recent);
        exceeded
    }

    fn prune(inner: &mut Inner, now: i64, prune_above_size: usize) {
        if inner.entries.len() <= inner.size_prune_at && now - inner.pruned_at < inner.widest_window_ms {
            return;
        }
        inner.pruned_at = now;
        let widest = inner.widest_window_ms;
        inner.entries.retain(|_, times| times.iter().any(|time| now - time < widest));
        inner.size_prune_at = prune_above_size.max(inner.entries.len() * 2);
    }

    /// Число ключей в памяти.
    pub fn size(&self) -> usize {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    #[test]
    fn window_limits_and_forgets_idle_keys() {
        let clock = Arc::new(AtomicI64::new(0));
        let reader = clock.clone();
        let counter = SlidingWindowCounter::new(1_000, 2, Arc::new(move || reader.load(Ordering::SeqCst)));
        assert!(!counter.hit("a", 2, None));
        assert!(!counter.hit("a", 2, None));
        assert!(counter.hit("a", 2, None), "третий за окно — сверх предела");
        clock.store(1_500, Ordering::SeqCst);
        assert!(!counter.hit("b", 2, None));
        assert!(!counter.hit("c", 2, None));
        assert!(!counter.hit("d", 2, None));
        assert!(counter.size() <= 3, "ключ без живых отметок убран");
    }
}
