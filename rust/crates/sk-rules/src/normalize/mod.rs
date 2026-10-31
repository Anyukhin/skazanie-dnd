//! Нормализация состояния кампании — точка входа `normalizeCampaignState`.
//! Задача Р0 (точка входа); тела — Р4 (`campaign.rs`, `scene.rs`,
//! `summons.rs`).
//!
//! Урок 4: нормализация зовётся только на границе — состояние, прошедшее
//! её, ходит типом [`crate::normalized::NormalizedState`]. Прежняя память
//! недавних итогов (Ск3, сверка входа с последними итогами) убрана:
//! повторную нормализацию уже нормализованного состояния исключает тип, а не
//! сравнение. [`assume_normalized`] остался только для эталона веток
//! `tests/vitals.rs` (см. там).

pub mod campaign;
pub mod scene;
pub mod summons;

use std::borrow::Cow;
use std::cell::Cell;

use serde_json::Value;

use crate::pause::Halt;

thread_local! {
    static ASSUME_NORMALIZED: Cell<bool> = const { Cell::new(false) };
}

/// `normalizeCampaignState(rawState)`.
pub fn normalize_campaign_state(raw: &Value) -> Result<Value, Halt> {
    if ASSUME_NORMALIZED.with(Cell::get) {
        return Ok(raw.clone());
    }
    let _span = sk_store::perf::span("normalize.full");
    campaign::normalize_campaign_state(raw)
}

/// [`normalize_campaign_state`] в виде `Cow` (прежний вход чтения; итог
/// всегда свой).
pub fn normalize_campaign_state_cow(raw: &Value) -> Result<Cow<'_, Value>, Halt> {
    normalize_campaign_state(raw).map(Cow::Owned)
}

/// [`normalize_campaign_state`] для своего значения: без копии входа.
pub fn normalize_campaign_state_owned(raw: Value) -> Result<Value, Halt> {
    if ASSUME_NORMALIZED.with(Cell::get) {
        return Ok(raw);
    }
    let _span = sk_store::perf::span("normalize.full");
    campaign::normalize_campaign_state_owned(raw)
}

/// Выполнить `operation`, считая каждое состояние уже нормализованным: все
/// нормализации внутри — тождество. **Только для эталона веток
/// `tests/vitals.rs`**: его состояния JS снял без нормализации (до Р4б), и
/// перегенерировать эталоны нельзя. Рабочий путь, сверка корпуса и остальные
/// тесты этот режим не включают (урок 4).
#[doc(hidden)]
pub fn assume_normalized<T>(operation: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            ASSUME_NORMALIZED.with(|cell| cell.set(self.0));
        }
    }
    let _restore = Restore(ASSUME_NORMALIZED.with(|cell| cell.replace(true)));
    operation()
}
