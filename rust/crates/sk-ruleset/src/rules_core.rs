//! Перенос `server/rules/core.mjs`: примитивы движка правил, нужные и самому
//! Rules Engine, и вынесенным из него модулям, — редакция по умолчанию,
//! ошибка валидации и безопасное целое. Модуль — лист: о состоянии кампании
//! он знает только поле `ruleset_id`.

use serde_json::Value;
use sk_core::RuleError;

use crate::ruleset_config::{DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID};
use crate::support::defined;

pub const DEFAULT_RULESET_ID: &str = LEGACY_DEFAULT_RULESET_ID;

/// `usesDnd2014(state)`: `String(state?.ruleset_id ?? DEFAULT_RULESET_ID) === 'dnd_5e_2014'`.
/// Отсутствующая редакция — 2024, а не 2014.
pub fn uses_dnd2014(state: Option<&Value>) -> bool {
    match defined(state.and_then(|state| state.get("ruleset_id"))) {
        None => DEFAULT_RULESET_ID == DND_2014_RULESET_ID,
        Some(value) => sk_core::js::s(Some(value)) == DND_2014_RULESET_ID,
    }
}

/// Ошибка валидации правил (`RulesValidationError`) — это `sk_core::RuleError`.
pub type RulesValidationError = RuleError;

/// Код `RulesValidationError` по умолчанию.
pub const RULES_VALIDATION_FAILED: &str = "RULES_VALIDATION_FAILED";

/// `new RulesValidationError(message, code = 'RULES_VALIDATION_FAILED')`.
pub fn rules_validation_error(message: impl Into<String>, code: Option<&str>) -> RulesValidationError {
    RuleError::new(code.unwrap_or(RULES_VALIDATION_FAILED), message)
}

/// `safeInteger(value, fallback = 0)`: `Number(value)`, если это безопасное
/// целое, иначе запас.
pub fn safe_integer(value: Option<&Value>, fallback: i64) -> i64 {
    sk_core::js::safe_int(value, fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_ruleset_is_2024() {
        assert!(!uses_dnd2014(None));
        assert!(!uses_dnd2014(Some(&json!({}))));
        assert!(!uses_dnd2014(Some(&json!({ "ruleset_id": null }))));
        assert!(!uses_dnd2014(Some(&json!({ "ruleset_id": "" }))));
        assert!(uses_dnd2014(Some(&json!({ "ruleset_id": "dnd_5e_2014" }))));
        let error = rules_validation_error("нет", None);
        assert_eq!(error.code, "RULES_VALIDATION_FAILED");
        assert_eq!(safe_integer(Some(&json!("12")), 0), 12);
        assert_eq!(safe_integer(Some(&json!(1.5)), 7), 7);
    }
}
