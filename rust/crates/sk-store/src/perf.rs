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

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// 0 — не прочитано, 1 — выключено, 2 — трасса запросов, 3 — только накопление.
static STATE: AtomicU8 = AtomicU8::new(0);
static TOTALS: Mutex<Vec<(&'static str, u32, u128, u64)>> = Mutex::new(Vec::new());

/// Счётчики выделений памяти процесса (все потоки): байты, число выделений и
/// число крупных (от [`BIG_ALLOCATION`] байт). Растут, только если бинарь
/// собран с распределителем-счётчиком (`sk-server`, фича `alloc-count`);
/// иначе — нули. Отрезок записывает, сколько байт выделено за его время.
pub static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);
/// Число выделений.
pub static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
/// Число крупных выделений.
pub static BIG_ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
/// Порог крупного выделения, байт.
pub const BIG_ALLOCATION: usize = 64 * 1024;

/// Учесть выделение `size` байт (зовёт распределитель-счётчик).
#[inline]
pub fn note_allocation(size: usize) {
    ALLOCATED_BYTES.fetch_add(size as u64, Ordering::Relaxed);
    ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    if size >= BIG_ALLOCATION {
        BIG_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    }
}

/// Снимок счётчиков: (байты, выделения, крупные выделения).
pub fn allocation_counters() -> (u64, u64, u64) {
    (ALLOCATED_BYTES.load(Ordering::Relaxed), ALLOCATIONS.load(Ordering::Relaxed), BIG_ALLOCATIONS.load(Ordering::Relaxed))
}

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
pub struct Span(Option<(&'static str, Instant, u64)>);

/// Начать отрезок `name`.
#[inline]
pub fn span(name: &'static str) -> Span {
    Span(enabled().then(|| (name, Instant::now(), ALLOCATED_BYTES.load(Ordering::Relaxed))))
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some((name, started, bytes_before)) = self.0.take() {
            let nanos = started.elapsed().as_nanos();
            let bytes = ALLOCATED_BYTES.load(Ordering::Relaxed).saturating_sub(bytes_before);
            let mut totals = TOTALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match totals.iter_mut().find(|(known, _, _, _)| *known == name) {
                Some(entry) => {
                    entry.1 += 1;
                    entry.2 += nanos;
                    entry.3 += bytes;
                }
                None => totals.push((name, 1, nanos, bytes)),
            }
        }
    }
}

/// Прибавить готовую длительность к имени `name`.
pub fn record(name: &'static str, elapsed: std::time::Duration) {
    if !enabled() {
        return;
    }
    drop(Span(Some((name, Instant::now() - elapsed, ALLOCATED_BYTES.load(Ordering::Relaxed)))));
}

/// Забрать накопленное: `(имя, число, миллисекунды)` в порядке первого появления.
pub fn take() -> Vec<(&'static str, u32, f64)> {
    take_with_allocations().into_iter().map(|(name, count, ms, _)| (name, count, ms)).collect()
}

/// [`take`] и мегабайты, выделенные за время отрезка (нули без счётчика).
pub fn take_with_allocations() -> Vec<(&'static str, u32, f64, f64)> {
    let mut totals = TOTALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    totals.drain(..).map(|(name, count, nanos, bytes)| (name, count, nanos as f64 / 1e6, bytes as f64 / 1e6)).collect()
}
