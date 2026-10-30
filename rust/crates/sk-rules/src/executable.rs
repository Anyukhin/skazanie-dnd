//! Доказательство исполнимости карточки (урок 8 плана переноса).
//!
//! JS проверял статус строкой (`assertMechanicsSupported`, rules-engine
//! 1024–1044) и дальше работал с сырой карточкой. Здесь проверка — единственный
//! конструктор [`Executable`]: обработчики исполнения заклинаний
//! (`resolve::spell::Cast`), боевых действий (`resolve::combat_action::Act`) и
//! заклинаний предметов принимают [`Executable`], а получить его из карточки
//! `heuristic` или `ruling-only` нельзя. Отказы, их коды, тексты и порядок —
//! прежние: `MECHANICS_NOT_VERIFIED` для `heuristic`, `RULING_REQUIRED` для
//! всего остального неисполнимого (в том числе для отсутствующей карточки и
//! незнакомого статуса в карточке из команды или состояния).

use std::ops::Deref;

use serde_json::Value;
use sk_core::js;
use sk_core::{MechanicsSupport, RuleError};

/// Карточка со статусом `verified` или `partial`.
#[derive(Debug, Clone, PartialEq)]
pub struct Executable {
    card: Value,
    support: MechanicsSupport,
}

impl Executable {
    /// Граница команды: карточка становится исполнимой или команда получает
    /// отказ, который называет причину. `label` — «действия», «заклинания»,
    /// «заклинания предмета».
    pub fn admit(card: Option<Value>, label: &str) -> Result<Self, RuleError> {
        let support = MechanicsSupport::of(card.as_ref().and_then(|card| card.get("mechanicsSupport")));
        match (card, support) {
            (Some(card), Some(support)) if support.is_executable() => Ok(Self { card, support }),
            (_, Some(MechanicsSupport::Heuristic)) => Err(RuleError::new("MECHANICS_NOT_VERIFIED", format!("Механика {label} ещё не проверена для авторитетного боя"))),
            (card, _) => {
                let reason = sk_core::text::trim(&js::s(card.as_ref().and_then(|card| card.get("supportNote")))).to_string();
                let message = if reason.is_empty() {
                    format!("Для {label} требуется серверное решение правил")
                } else {
                    format!("Для {label} требуется серверное решение правил: {reason}")
                };
                Err(RuleError::new("RULING_REQUIRED", message))
            }
        }
    }

    /// `verified` или `partial`.
    pub fn support(&self) -> MechanicsSupport {
        self.support
    }

    /// Сырая карточка — для помощников, которые принимают `&Value`.
    pub fn card(&self) -> &Value {
        &self.card
    }

    pub fn into_card(self) -> Value {
        self.card
    }
}

impl Deref for Executable {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.card
    }
}

impl AsRef<Value> for Executable {
    fn as_ref(&self) -> &Value {
        &self.card
    }
}
