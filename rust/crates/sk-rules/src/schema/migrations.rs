//! Миграции состояния снимка до [`super::STATE_SCHEMA_VERSION`].
//!
//! Шаг `vN → vN+1` — чистая функция состояния в режиме удержания снимка.
//! Цепочка идёт в памяти при загрузке; на диск ничего не пишется.

use serde_json::Value;

use crate::pause::Halt;

/// v0 → v1: состояние без версии схемы (прежние сборки Rust, файлы JS) —
/// нынешняя нормализация `normalizeCampaignState`.
fn v0_to_v1(state: &Value) -> Result<Value, Halt> {
    crate::normalize::normalize_campaign_state(state)
}

/// Довести состояние версии `from` до текущей. Версия новее текущей —
/// отказ: снимок записан более новой сборкой.
pub fn migrate(state: &Value, from: i64) -> Result<Value, Halt> {
    if from > super::STATE_SCHEMA_VERSION {
        return Err(Halt::Fault(
            crate::pause::Fault::new("Error", format!("Версия схемы состояния {from} не поддерживается; текущая версия {}", super::STATE_SCHEMA_VERSION)).with_code("UNSUPPORTED_STATE_SCHEMA_VERSION"),
        ));
    }
    let mut state = std::borrow::Cow::Borrowed(state);
    let mut version = from.max(0);
    while version < super::STATE_SCHEMA_VERSION {
        state = std::borrow::Cow::Owned(match version {
            0 => v0_to_v1(&state)?,
            _ => unreachable!("шаг миграции v{version} не объявлен"),
        });
        version += 1;
    }
    Ok(state.into_owned())
}
