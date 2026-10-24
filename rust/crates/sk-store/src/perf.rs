//! Замер горячего пути по этапам (Ск2): именованные отрезки времени.
//!
//! Два режима:
//!
//! - переменная окружения `SKAZANIE_PERF_TRACE=1` (читается один раз) — сервер
//!   забирает таблицу [`take`] в конце каждого запроса и печатает строкой
//!   `[perf]` в stderr ([`request_trace`]); её разбирает
//!   `rust/crates/sk-server/bench/hot-path.mjs`;
//! - [`enable`] из кода — только накопление: таблицу забирает тест
//!   (`sk-server/tests/hot_path_budget.rs`).
//!
//! Выключенный отрезок стоит одной атомарной загрузки и на поведение не
//! влияет. Отрезки копятся в общей таблице процесса; вложенные считаются
//! целиком (время родителя включает детей).

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// 0 — не прочитано, 1 — выключено, 2 — трасса запросов, 3 — только накопление.
static STATE: AtomicU8 = AtomicU8::new(0);
static TOTALS: Mutex<Vec<(&'static str, u32, u128)>> = Mutex::new(Vec::new());

fn state() -> u8 {
    match STATE.load(Ordering::Relaxed) {
        0 => {
            let on = std::env::var("SKAZANIE_PERF_TRACE").is_ok_and(|value| value == "1");
            let state = if on { 2 } else { 1 };
            STATE.store(state, Ordering::Relaxed);
            state
        }
        state => state,
    }
}

/// Включён ли замер.
#[inline]
pub fn enabled() -> bool {
    state() >= 2
}

/// Печатать ли таблицу в конце каждого запроса (`SKAZANIE_PERF_TRACE=1`).
pub fn request_trace() -> bool {
    state() == 2
}

/// Включить накопление из кода (тест-бюджет в процессе).
pub fn enable() {
    STATE.store(3, Ordering::Relaxed);
}

/// Отрезок: время до уничтожения прибавляется к своему имени.
#[must_use]
pub struct Span(Option<(&'static str, Instant)>);

/// Начать отрезок `name`.
#[inline]
pub fn span(name: &'static str) -> Span {
    Span(enabled().then(|| (name, Instant::now())))
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some((name, started)) = self.0.take() {
            let nanos = started.elapsed().as_nanos();
            let mut totals = TOTALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match totals.iter_mut().find(|(known, _, _)| *known == name) {
                Some(entry) => {
                    entry.1 += 1;
                    entry.2 += nanos;
                }
                None => totals.push((name, 1, nanos)),
            }
        }
    }
}

/// Прибавить готовую длительность к имени `name`.
pub fn record(name: &'static str, elapsed: std::time::Duration) {
    if !enabled() {
        return;
    }
    drop(Span(Some((name, Instant::now() - elapsed))));
}

/// Забрать накопленное: `(имя, число, миллисекунды)` в порядке первого появления.
pub fn take() -> Vec<(&'static str, u32, f64)> {
    let mut totals = TOTALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    totals.drain(..).map(|(name, count, nanos)| (name, count, nanos as f64 / 1e6)).collect()
}
