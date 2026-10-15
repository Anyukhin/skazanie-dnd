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
    if ASSUME_NORMALIZED.with(Cell::get) {
        return Ok(raw.clone());
    }
    campaign::normalize_campaign_state(raw)
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
