//! `applyGameEvent`, `replayEvents`, проектор команды `createCommandProjector`
//! (`rules-engine.mjs`, 24201–24211, 27108–27188). Задача Р4б.
//!
//! `applyGameEvent` выбирает режим retention по `reducer_version` и
//! `state_version_after` события (`INVALID_REDUCER_VERSION`,
//! `UNSUPPORTED_REDUCER_VERSION`), заменяет состояние целиком
//! (`LegacyStateImported`, `CampaignRewound`) или нормализует его и зовёт
//! редьюсер (`reduce::apply_event_checked`). Проектор помнит состояние после
//! всех событий, кроме последнего, сверяет префикс по JSON событий и
//! сбрасывает кэш при любом расхождении (риск §4 п.1 плана).
//!
//! Отличие от JS: префикс проектора JS сверяет ещё и по ссылке на объект
//! события. В Rust ссылок нет — остаётся сверка по `JSON.stringify`; событие,
//! заменённое объектом с тем же JSON, JS проиграл бы с нуля, а итог один и тот
//! же (редьюсер детерминирован).

use serde_json::Value;
use sk_core::js;
use sk_core::Event;
use sk_society::retention_context::{retention_context_active, retention_mode, with_retention_mode, RETENTION_REDUCER_VERSION};

use crate::normalize::normalize_campaign_state;
use crate::pause::{Fault, Halt};

fn coded(message: String, code: &str) -> Halt {
    Halt::Fault(Fault::new("Error", message).with_code(code))
}

/// `withRetentionMode(mode, operation)`: режим всегда из известных двух.
fn in_mode<T>(mode: &str, operation: impl FnOnce() -> Result<T, Halt>) -> Result<T, Halt> {
    with_retention_mode(mode, operation).map_err(|message| Halt::Fault(Fault::new("Error", message)))?
}

/// Событие JSON → конверт редьюсера. Поля не той формы приводятся мягко
/// (строки — `String(x ?? '')`, видимость — как у прежнего движка).
pub fn event_envelope(event: &Value) -> Event {
    if let Ok(envelope) = serde_json::from_value::<Event>(event.clone()) {
        return envelope;
    }
    let mut fields = event.as_object().cloned().unwrap_or_default();
    let text = |value: Option<&Value>| match value {
        None | Some(Value::Null) => Value::Null,
        some => Value::String(js::s(some)),
    };
    for key in ["campaign_id", "command_id", "actor_id", "house_rule_id", "ruling_id"] {
        let value = text(fields.get(key));
        fields.insert(key.into(), value);
    }
    fields.insert("event_type".into(), Value::String(js::s(event.get("event_type"))));
    for key in ["target_ids", "source_rule_ids"] {
        let list = match fields.get(key) {
            Some(Value::Array(items)) => items.iter().map(|item| Value::String(js::s(Some(item)))).collect(),
            _ => Vec::new(),
        };
        fields.insert(key.into(), Value::Array(list));
    }
    let visibility = sk_dice::Visibility::parse_lenient(&js::s(event.get("visibility")));
    fields.insert("visibility".into(), serde_json::to_value(visibility).unwrap_or(Value::Null));
    if !js::is_safe_integer(fields.get("event_schema_version")) {
        fields.shift_remove("event_schema_version");
    }
    serde_json::from_value::<Event>(Value::Object(fields)).unwrap_or_else(|_| Event { event_type: js::s(event.get("event_type")), payload: event.get("payload").cloned().unwrap_or(Value::Null), ..Event::default() })
}

/// Режим события: `legacy` для журналов прежних версий редьюсера.
fn event_mode(marker: f64, event: &Value) -> &'static str {
    if retention_context_active() {
        return retention_mode();
    }
    let legacy = (marker > 0.0 && marker < RETENTION_REDUCER_VERSION as f64) || (marker == 0.0 && js::is_safe_integer(event.get("state_version_after")));
    if legacy {
        "legacy"
    } else {
        "current"
    }
}

/// `applyGameEvent(rawState, event)`: событие в явном retention-контексте.
pub fn apply_game_event(raw_state: &Value, event: &Value) -> Result<Value, Halt> {
    let raw_marker = event.get("reducer_version");
    let marker = if js::present(raw_marker) { js::number(raw_marker) } else { 0.0 };
    let safe = marker.is_finite() && marker.fract() == 0.0 && marker.abs() <= 9_007_199_254_740_991.0;
    if !safe || marker < 0.0 {
        return Err(coded(format!("Некорректная версия reducer: {}", js::string(raw_marker)), "INVALID_REDUCER_VERSION"));
    }
    if marker > RETENTION_REDUCER_VERSION as f64 {
        return Err(coded(format!("Версия reducer {} не поддерживается; текущая версия {RETENTION_REDUCER_VERSION}", js::f64_string(marker)), "UNSUPPORTED_REDUCER_VERSION"));
    }
    let mode = event_mode(marker, event);
    in_mode(mode, || apply_game_event_current(raw_state, event))
}

/// `applyGameEventCurrent(rawState, event)`: замена состояния (24201–24211)
/// или нормализация и ветка редьюсера.
fn apply_game_event_current(raw_state: &Value, event: &Value) -> Result<Value, Halt> {
    let kind = event.get("event_type").and_then(Value::as_str);
    let replacement = event.get("payload").and_then(|payload| payload.get("state")).filter(|state| js::truthy(Some(state)) && (state.is_object() || state.is_array()));
    if let (Some(kind @ ("LegacyStateImported" | "CampaignRewound")), Some(replacement)) = (kind, replacement) {
        let mut imported = normalize_campaign_state(replacement)?;
        let after = event.get("state_version_after").filter(|value| js::is_safe_integer(Some(value))).cloned();
        let version = match after {
            Some(version) => version,
            None if kind == "LegacyStateImported" => Value::from(1),
            None => {
                let current = raw_state.get("state_version").filter(|value| js::is_safe_integer(Some(value))).map(|value| js::safe_int(Some(value), 0)).unwrap_or(0);
                Value::from(current + 1)
            }
        };
        imported["state_version"] = version;
        return Ok(imported);
    }
    let mut state = normalize_campaign_state(raw_state)?;
    let envelope = event_envelope(event);
    crate::reduce::apply_event_checked(&mut state, &envelope)?;
    Ok(state)
}

/// `replayModeFor(stream)`: режим потока — по первому событию.
fn replay_mode_for(stream: &[Value]) -> &'static str {
    if retention_context_active() {
        return retention_mode();
    }
    let first = stream.first();
    let marker = match first.and_then(|event| event.get("reducer_version")) {
        None | Some(Value::Null) => 0.0,
        some => js::number(some),
    };
    let legacy = (marker > 0.0 && marker < RETENTION_REDUCER_VERSION as f64) || (marker == 0.0 && js::is_safe_integer(first.and_then(|event| event.get("state_version_after"))));
    if legacy {
        "legacy"
    } else {
        "current"
    }
}

/// `replayEvents(initialState, events)`.
pub fn replay_events(initial_state: &Value, events: &[Value]) -> Result<Value, Halt> {
    let mode = replay_mode_for(events);
    let mut state = in_mode(mode, || normalize_campaign_state(initial_state))?;
    for event in events {
        state = apply_game_event(&state, event)?;
    }
    Ok(state)
}

#[derive(Debug, Clone)]
struct ProjectorCache {
    mode: &'static str,
    fingerprints: Vec<String>,
    state: Value,
}

/// `createCommandProjector(initialState)`: состояние после событий команды,
/// где список событий только растёт.
#[derive(Debug, Clone)]
pub struct CommandProjector {
    /// Исходное состояние команды — её приватная нормализованная копия.
    initial: Value,
    cache: Option<ProjectorCache>,
}

impl CommandProjector {
    pub fn new(initial: &Value) -> Self {
        Self { initial: initial.clone(), cache: None }
    }

    /// Исходное состояние проектора.
    pub fn initial(&self) -> &Value {
        &self.initial
    }

    /// `projectEvents(events)`: последнее событие применяется всегда заново,
    /// префикс берётся из кэша, если он совпал целиком.
    pub fn project(&mut self, events: &[Value]) -> Result<Value, Halt> {
        if events.is_empty() {
            return replay_events(&self.initial, events);
        }
        let mode = replay_mode_for(events);
        let last = events.len() - 1;
        let mut applied = 0;
        let mut fingerprints: Vec<String> = Vec::new();
        let mut state = None;
        if let Some(cache) = self.cache.take() {
            if cache.mode == mode && cache.fingerprints.len() <= last {
                while applied < cache.fingerprints.len() {
                    let fingerprint = js::stringify(&events[applied]);
                    if fingerprint != cache.fingerprints[applied] {
                        break;
                    }
                    fingerprints.push(fingerprint);
                    applied += 1;
                }
                if applied == cache.fingerprints.len() {
                    state = Some(cache.state);
                }
            }
        }
        let mut state = match state {
            Some(state) => state,
            None => {
                applied = 0;
                fingerprints.clear();
                in_mode(mode, || normalize_campaign_state(&self.initial))?
            }
        };
        for event in &events[applied..last] {
            state = apply_game_event(&state, event)?;
            fingerprints.push(js::stringify(event));
        }
        let result = apply_game_event(&state, &events[last]);
        self.cache = Some(ProjectorCache { mode, fingerprints, state });
        result
    }
}

