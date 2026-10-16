//! Перенос `server/encounter-narration.mjs`: рассказчик появления противников
//! без модели.
//!
//! Вступление общее с боевым рассказчиком ([`encounter_intro`]): обстановка —
//! тема сцены, тема встречи и время суток, состав — имена из события. Смертельная
//! сборка называется прямо: это решение владельца про честный мир.
//!
//! Регистрируется в общем реестре с приоритетом `encounter`: в JS — при
//! импорте модуля, здесь — [`register_encounter_narrator`].

use std::sync::{Arc, LazyLock, OnceLock};

use serde_json::Value;
use sk_core::js;
use sk_narration_base::deterministic_narration::{register_deterministic_narrator, DeterministicNarrator, NarratorContractError, SharedNarrator, NARRATOR_PRIORITY};

use crate::combat_narration::encounter_intro;
use crate::jsv::{get, path};

fn event_type(event: &Value) -> Option<&str> {
    get(Some(event), "event_type").and_then(Value::as_str)
}

/// `hasEncounterEvent(events)`: тип сравнивается как `String(event_type)`.
pub fn has_encounter_event(events: &[Value]) -> bool {
    events.iter().any(|event| js::s(get(Some(event), "event_type")) == "EncounterCreated")
}

/// `encounterNarration(events, state)`: вступление по первому
/// `EncounterCreated` или `None`, если столкновения в событиях нет.
pub fn encounter_narration(events: &[Value], state: &Value) -> Option<String> {
    let created = events.iter().find(|event| event_type(event) == Some("EncounterCreated"))?;
    let encounter = path(Some(created), &["payload", "encounter"]).filter(|value| value.is_object() || value.is_array());
    let initiative_started = events.iter().any(|event| event_type(event) == Some("CombatStarted"));
    let deadly = if js::s(get(encounter, "difficulty")) == "deadly" { " Силы неравны: это заведомо превосходящий противник." } else { "" };
    Some(format!("{}{deadly}{}", encounter_intro(created, state), if initiative_started { " Инициатива определена, бой начинается." } else { "" }))
}

/// `encounterNarrator`: рассказчик появления противников.
#[derive(Debug, Default, Clone, Copy)]
pub struct EncounterNarrator;

impl DeterministicNarrator for EncounterNarrator {
    fn id(&self) -> &str {
        "encounter"
    }

    fn prompt_version(&self) -> &str {
        "encounter-narrator/v2"
    }

    fn provider(&self) -> &str {
        "deterministic-encounter"
    }

    fn priority(&self) -> f64 {
        NARRATOR_PRIORITY.encounter
    }

    fn matches(&self, events: &[Value]) -> bool {
        has_encounter_event(events)
    }

    fn narrate(&self, events: &[Value], state: &Value) -> Option<String> {
        encounter_narration(events, state)
    }
}

/// Рассказчик столкновения как общий объект реестра.
pub static ENCOUNTER_NARRATOR: LazyLock<SharedNarrator> = LazyLock::new(|| Arc::new(EncounterNarrator));

/// Зарегистрировать рассказчика в общем реестре сервера (в JS — при импорте
/// модуля). Повторный вызов возвращает итог первой регистрации.
pub fn register_encounter_narrator() -> Result<SharedNarrator, NarratorContractError> {
    static REGISTERED: OnceLock<Result<SharedNarrator, NarratorContractError>> = OnceLock::new();
    REGISTERED.get_or_init(|| register_deterministic_narrator(Arc::clone(&ENCOUNTER_NARRATOR))).clone()
}
