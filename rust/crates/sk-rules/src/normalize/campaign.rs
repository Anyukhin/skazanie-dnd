//! Нормализация состояния кампании `normalizeCampaignState` и производные поля героя. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 1663–2219, 23603.
//!
//! Заготовка каркаса Р0: модуль объявлен заранее (`lib.rs` и `mod.rs` правит
//! только Р0); тела пишет задача-владелец.

use serde_json::Value;

use crate::pause::{unported, Halt};

/// `normalizeCampaignState(rawState)` (1936–2219): копия состояния со всеми
/// умолчаниями и производными полями. Вход не меняется (кроме `worldMemory`
/// в JS — см. риск §4 п.4 плана).
pub fn normalize_campaign_state(_raw: &Value) -> Result<Value, Halt> {
    Err(unported("normalizeCampaignState").into())
}
