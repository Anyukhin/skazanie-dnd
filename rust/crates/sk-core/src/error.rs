//! Отказ правила: код для клиента и сверки, текст — для человека.
//!
//! Урок §7 плана: правила возвращают код и параметры, а не только русскую
//! строку. Сверка с корпусом JS идёт по коду.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleError {
    pub code: String,
    pub message: String,
}

impl RuleError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    /// Команда этого типа ещё не перенесена.
    pub fn not_ported(command_type: &str) -> Self {
        Self::new("COMMAND_NOT_PORTED", format!("Команда {command_type} ещё не перенесена в Rust"))
    }
}

impl fmt::Display for RuleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RuleError {}

impl From<sk_dice::DiceError> for RuleError {
    fn from(error: sk_dice::DiceError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

pub type RuleResult<T> = Result<T, RuleError>;

/// Короткая запись отказа: `reject!("CODE", "текст {}", x)`.
#[macro_export]
macro_rules! reject {
    ($code:expr, $($message:tt)+) => {
        return Err($crate::RuleError::new($code, format!($($message)+)))
    };
}
