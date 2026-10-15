//! `applyGameEvent`, `replayEvents`, проектор команды `createCommandProjector`
//! (`rules-engine.mjs`, 27108–27188). Задача Р4; точки входа — каркас Р0.
//!
//! `applyGameEvent` выбирает режим retention по `reducer_version` и
//! `state_version_after` события (`INVALID_REDUCER_VERSION`,
//! `UNSUPPORTED_REDUCER_VERSION`), нормализует состояние и зовёт редьюсер
//! (`reduce::apply_event`). Проектор помнит состояние после всех событий,
//! кроме последнего, сверяет префикс по JSON событий и сбрасывает кэш при
//! любом расхождении (риск §4 п.1 плана).

use serde_json::Value;

use crate::pause::{unported, Halt};

/// `applyGameEvent(rawState, event)`.
pub fn apply_game_event(_raw_state: &Value, _event: &Value) -> Result<Value, Halt> {
    Err(unported("applyGameEvent").into())
}

/// `replayEvents(initialState, events)`.
pub fn replay_events(_initial_state: &Value, _events: &[Value]) -> Result<Value, Halt> {
    Err(unported("replayEvents").into())
}

/// `createCommandProjector(initialState)`: состояние после событий команды,
/// где список событий только растёт.
#[derive(Debug, Clone)]
pub struct CommandProjector {
    /// Исходное состояние команды — её приватная нормализованная копия.
    initial: Value,
}

impl CommandProjector {
    pub fn new(initial: &Value) -> Self {
        Self { initial: initial.clone() }
    }

    /// Исходное состояние проектора.
    pub fn initial(&self) -> &Value {
        &self.initial
    }

    /// `projectEvents(events)`.
    pub fn project(&mut self, _events: &[Value]) -> Result<Value, Halt> {
        Err(unported("projectEvents").into())
    }
}
