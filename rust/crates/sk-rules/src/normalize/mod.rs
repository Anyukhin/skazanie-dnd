//! Нормализация состояния кампании — точка входа `normalizeCampaignState`.
//! Задача Р0 (точка входа); тела — Р4 (`campaign.rs`, `scene.rs`,
//! `summons.rs`).
//!
//! Пока нормализация не перенесена, тесты разбора идут на состояниях, уже
//! нормализованных JS (эталоны снимают их генераторы): [`assume_normalized`]
//! делает точку входа тождественной на время замыкания. На корпусе 88 %
//! состояний — неподвижные точки нормализации (план, §5).

pub mod campaign;
pub mod scene;
pub mod summons;

use std::cell::Cell;

use serde_json::Value;

use crate::pause::Halt;

thread_local! {
    static ASSUME_NORMALIZED: Cell<bool> = const { Cell::new(false) };
}

/// `normalizeCampaignState(rawState)`.
pub fn normalize_campaign_state(raw: &Value) -> Result<Value, Halt> {
    let _span = sk_store::perf::span("normalize.ref");
    if ASSUME_NORMALIZED.with(Cell::get) {
        return Ok(raw.clone());
    }
    if known(raw) {
        let _clone = sk_store::perf::span("normalize.ref.hit_clone");
        return Ok(raw.clone());
    }
    let _full = sk_store::perf::span("normalize.full");
    let normalized = campaign::normalize_campaign_state(raw)?;
    {
        let _remember = sk_store::perf::span("normalize.remember");
        fixed_point::remember(&normalized);
    }
    Ok(normalized)
}

/// [`normalize_campaign_state`] для чтения (Ск3): уже нормализованный вход
/// (неподвижная точка из памяти итогов) возвращается заимствованным, без копии.
pub fn normalize_campaign_state_cow(raw: &Value) -> Result<std::borrow::Cow<'_, Value>, Halt> {
    let _span = sk_store::perf::span("normalize.cow");
    if ASSUME_NORMALIZED.with(Cell::get) || known(raw) {
        return Ok(std::borrow::Cow::Borrowed(raw));
    }
    let _full = sk_store::perf::span("normalize.full");
    let normalized = campaign::normalize_campaign_state(raw)?;
    {
        let _remember = sk_store::perf::span("normalize.remember");
        fixed_point::remember(&normalized);
    }
    Ok(std::borrow::Cow::Owned(normalized))
}

/// [`normalize_campaign_state`] для своего значения: без копии входа.
pub fn normalize_campaign_state_owned(raw: Value) -> Result<Value, Halt> {
    let _span = sk_store::perf::span("normalize.owned");
    if ASSUME_NORMALIZED.with(Cell::get) {
        return Ok(raw);
    }
    if known(&raw) {
        return Ok(raw);
    }
    let _full = sk_store::perf::span("normalize.full");
    let normalized = campaign::normalize_campaign_state_owned(raw)?;
    {
        let _remember = sk_store::perf::span("normalize.remember");
        fixed_point::remember(&normalized);
    }
    Ok(normalized)
}

/// `fixed_point::known` под отрезком замера: сравнение с памятью итогов
/// (`normalize.memo_check`) и попадание (`normalize.memo_hit`, число).
fn known(raw: &Value) -> bool {
    let check = sk_store::perf::span("normalize.memo_check");
    let hit = fixed_point::known(raw);
    drop(check);
    if hit {
        drop(sk_store::perf::span("normalize.memo_hit"));
    }
    hit
}

/// Память недавних итогов нормализации (Ск3).
///
/// Нормализация — чистая функция входа (и режима удержания редьюсера) и
/// идемпотентна: `normalize(normalize(s)) == normalize(s)` на всех 10336
/// состояниях корпуса. Движок, как и JS, нормализует одно и то же уже
/// нормализованное состояние по многу раз за команду (разбор хода — 14 раз).
/// Поэтому вход, совпадающий байт в байт (порядок ключей и запись чисел —
/// тоже) с одним из последних итогов в том же режиме, — неподвижная точка:
/// его нормализация вернула бы его же, и она пропускается. Сравнение точное
/// (не по хешу), стоит долю миллисекунды против нескольких миллисекунд
/// нормализации.
mod fixed_point {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use serde_json::Value;

    /// Сколько итогов помнить на поток.
    const LIMIT: usize = 4;

    thread_local! {
        static KNOWN: RefCell<VecDeque<(&'static str, Value)>> = const { RefCell::new(VecDeque::new()) };
        static DISABLED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    /// Выполнить `operation` без памяти итогов (замеры настоящей нормализации).
    pub fn without<T>(operation: impl FnOnce() -> T) -> T {
        struct Restore(bool);
        impl Drop for Restore {
            fn drop(&mut self) {
                DISABLED.with(|cell| cell.set(self.0));
            }
        }
        let _restore = Restore(DISABLED.with(|cell| cell.replace(true)));
        operation()
    }

    /// Равенство с порядком ключей объектов (`Map::eq` порядок не учитывает).
    fn same(left: &Value, right: &Value) -> bool {
        match (left, right) {
            (Value::Object(left), Value::Object(right)) => left.len() == right.len() && left.iter().zip(right.iter()).all(|((left_key, left), (right_key, right))| left_key == right_key && same(left, right)),
            (Value::Array(left), Value::Array(right)) => left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| same(left, right)),
            _ => left == right,
        }
    }

    /// Совпадает ли `state` с одним из недавних итогов в текущем режиме.
    pub(super) fn known(state: &Value) -> bool {
        if !state.is_object() || DISABLED.with(std::cell::Cell::get) {
            return false;
        }
        let mode = sk_society::retention_context::retention_mode();
        KNOWN.with(|known| known.borrow().iter().any(|(known_mode, known)| *known_mode == mode && same(known, state)))
    }

    /// Запомнить итог нормализации.
    pub(super) fn remember(state: &Value) {
        if !state.is_object() || DISABLED.with(std::cell::Cell::get) {
            return;
        }
        let mode = sk_society::retention_context::retention_mode();
        KNOWN.with(|known| {
            let mut known = known.borrow_mut();
            known.push_front((mode, state.clone()));
            known.truncate(LIMIT);
        });
    }
}

/// Выполнить `operation` без памяти недавних итогов нормализации: каждая
/// нормализация считается заново (бюджет скорости ядра правил меряет её саму).
pub fn without_fixed_point_memory<T>(operation: impl FnOnce() -> T) -> T {
    fixed_point::without(operation)
}

/// Выполнить `operation`, считая каждое входное состояние уже нормализованным
/// (только для тестов и сверки, пока Р4 не перенесла нормализацию).
pub fn assume_normalized<T>(operation: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            ASSUME_NORMALIZED.with(|cell| cell.set(self.0));
        }
    }
    let _restore = Restore(ASSUME_NORMALIZED.with(Cell::get));
    ASSUME_NORMALIZED.with(|cell| cell.set(true));
    operation()
}
