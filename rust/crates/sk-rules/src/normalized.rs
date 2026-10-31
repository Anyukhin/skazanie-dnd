//! Нормализованное состояние кампании — [`NormalizedState`] (урок 4).
//!
//! `normalizeCampaignState` в JS зовётся на каждом шаге; в Rust нормализация
//! идёт на границе, а дальше состояние ходит типом, который получить можно
//! лишь так:
//!
//! - нормализацией на границе — [`NormalizedState::normalize`] и
//!   [`NormalizedState::normalize_owned`]: состояние от клиента (тестовые
//!   крючки), импорт старого storage и кампании, миграция снимка, новое
//!   состояние, собранное кодом (сцена лаборатории боя, отступление NPC),
//!   итог редьюсера, который дальше читается нормализованным;
//! - из журнала — [`NormalizedState::from_loaded`]: хранилище с редьюсером
//!   движка держит голову нормализованной в текущем режиме удержания; голова
//!   прежнего режима (журнал JS с событиями старого редьюсера)
//!   нормализуется здесь, это та же граница;
//! - применением события — [`NormalizedState::applied`]: ветка редьюсера
//!   над нормализованным входом без его повторной нормализации, итог
//!   нормализуется один раз. Редьюсер не замкнут относительно нормализации
//!   (`sk-corpus closure`), поэтому нормализация итога остаётся — по одной
//!   на событие, как и в JS (там её делает следующий шаг).
//!
//! Нормализация зависит от режима удержания (`legacy`/`current`), поэтому тип
//! помнит режим, в котором нормализован: потребитель в другом режиме
//! нормализует заново ([`NormalizedState::in_ambient_mode`]) — ровно то, что
//! делала прежняя память итогов, у которой ключом тоже был режим.
//!
//! Внутри — `Arc<Value>`: клон дешёвый, чтение — `Deref` в `&Value`. Рабочее
//! представление остаётся `serde_json::Value` той же формы, что в JS; перевод
//! обращений к полям на типы в этот урок не входит.

use std::borrow::Cow;
use std::ops::Deref;
use std::sync::Arc;

use serde_json::Value;
use sk_society::retention_context::retention_mode;

use crate::pause::Halt;

/// Состояние кампании, прошедшее нормализацию (см. шапку модуля).
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedState {
    value: Arc<Value>,
    /// Режим удержания, в котором состояние нормализовано.
    mode: &'static str,
}

impl NormalizedState {
    /// Граница: `normalizeCampaignState(raw)` в текущем режиме удержания.
    pub fn normalize(raw: &Value) -> Result<Self, Halt> {
        crate::normalize::normalize_campaign_state(raw).map(|value| Self::trusted(value, retention_mode()))
    }

    /// Граница для своего значения: без копии входа.
    pub fn normalize_owned(raw: Value) -> Result<Self, Halt> {
        crate::normalize::normalize_campaign_state_owned(raw).map(|value| Self::trusted(value, retention_mode()))
    }

    /// Состояние из журнала. Хранилище с редьюсером движка (`GameReducer`)
    /// нормализует голову в режиме её последнего события, поэтому голова
    /// текущей версии редьюсера берётся как есть, без копии; голова журнала
    /// прежней версии нормализуется в текущем режиме — так же, как её
    /// нормализовал бы первый же шаг команды.
    pub fn from_loaded(loaded: &sk_store::Loaded) -> Result<Self, Halt> {
        Self::from_journal(&loaded.state, loaded.reducer_version)
    }

    /// Общее состояние журнала и версия редьюсера, в режиме которой оно
    /// нормализовано.
    pub fn from_journal(state: &Arc<Value>, reducer_version: i64) -> Result<Self, Halt> {
        if reducer_version == crate::replay::RETENTION_REDUCER_VERSION {
            return Ok(Self { value: Arc::clone(state), mode: "current" });
        }
        crate::replay::with_retention_mode("current", || Self::normalize(state)).map_err(|message| Halt::Fault(crate::pause::Fault::new("Error", message)))?
    }

    /// Голова хранилища с редьюсером движка, переданная редьюсеру по
    /// значению: хранилище держит её нормализованной в текущем режиме
    /// (`sk_store::Reducer::apply_to_head`).
    pub fn from_store_head(state: Value) -> Self {
        Self { value: Arc::new(state), mode: "current" }
    }

    /// Итог нормализации в режиме `mode` (только внутри движка).
    pub(crate) fn trusted(value: Value, mode: &'static str) -> Self {
        Self { value: Arc::new(value), mode }
    }

    /// Режим удержания, в котором состояние нормализовано.
    pub fn mode(&self) -> &'static str {
        self.mode
    }

    /// Это же состояние для потребителя в текущем режиме удержания: в другом
    /// режиме — нормализация заново.
    pub fn in_ambient_mode(&self) -> Result<Cow<'_, Self>, Halt> {
        if self.mode == retention_mode() {
            return Ok(Cow::Borrowed(self));
        }
        Self::normalize(&self.value).map(Cow::Owned)
    }

    /// [`Self::in_ambient_mode`] для своего значения.
    pub fn into_ambient_mode(self) -> Result<Self, Halt> {
        if self.mode == retention_mode() {
            return Ok(self);
        }
        Self::normalize(&self.value)
    }

    /// `applyGameEvent(state, event)` без нормализации входа: сырой итог
    /// ветки редьюсера. Вход в режиме события не нормализуется повторно;
    /// событие другого режима нормализует его в своём (как прежде).
    pub fn reduced(self, event: &Value) -> Result<Value, Halt> {
        crate::replay::apply_game_event_normalized(self, event)
    }

    /// Применить событие: [`Self::reduced`] и одна нормализация итога в
    /// текущем режиме удержания.
    pub fn applied(self, event: &Value) -> Result<Self, Halt> {
        let reduced = self.reduced(event)?;
        Self::normalize_owned(reduced)
    }

    /// Состояние по ссылке.
    pub fn value(&self) -> &Value {
        &self.value
    }

    /// Общее состояние (для хранилища и ответов), без копии.
    pub fn shared(&self) -> Arc<Value> {
        Arc::clone(&self.value)
    }

    /// Своё значение: без копии, если состояние больше никто не держит.
    pub fn into_value(self) -> Value {
        if Arc::strong_count(&self.value) > 1 {
            let _span = sk_store::perf::span("state.copy");
        }
        Arc::unwrap_or_clone(self.value)
    }

    /// Явная копия для изменения вне редьюсера: итог — уже не
    /// [`NormalizedState`], а сырое состояние.
    pub fn to_value(&self) -> Value {
        let _span = sk_store::perf::span("state.copy");
        (*self.value).clone()
    }
}

impl Deref for NormalizedState {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.value
    }
}

impl AsRef<Value> for NormalizedState {
    fn as_ref(&self) -> &Value {
        &self.value
    }
}

/// Вход разбора команды: состояние вызывающего как есть и его нормализация.
///
/// Функции JS читают часть полей `rawState` до нормализации (бой активен,
/// окно реакции, «Обессиливание»), поэтому сырое значение идёт рядом; у
/// вызывающего с нормализованным состоянием оба указывают на одно.
#[derive(Debug, Clone, Copy)]
pub struct StateIn<'a> {
    pub raw: &'a Value,
    pub normalized: &'a NormalizedState,
}

impl<'a> StateIn<'a> {
    /// Вход, уже нормализованный.
    pub fn of(normalized: &'a NormalizedState) -> Self {
        Self { raw: normalized.value(), normalized }
    }
}

/// Цепочка событий над состоянием, где читается сырой итог каждого события
/// (как в JS: `state = applyGameEvent(state, event)`), а нормализация
/// нужна следующему шагу. Нормализованный вид считается лениво и один раз
/// на итог.
#[derive(Debug, Clone)]
pub struct EventChain {
    /// Сырой итог последнего события; `None` — читать нормализованный.
    raw: Option<Value>,
    normalized: Option<NormalizedState>,
}

impl EventChain {
    /// Начало цепочки — нормализованное состояние.
    pub fn new(start: NormalizedState) -> Self {
        Self { raw: None, normalized: Some(start) }
    }

    /// Состояние так, как его читал бы JS после последнего события.
    pub fn raw(&self) -> &Value {
        match (&self.raw, &self.normalized) {
            (Some(raw), _) => raw,
            (None, Some(normalized)) => normalized.value(),
            (None, None) => unreachable!("в цепочке всегда есть состояние"),
        }
    }

    /// Нормализованное состояние в текущем режиме удержания (считается один
    /// раз на итог события).
    pub fn normalized(&mut self) -> Result<&NormalizedState, Halt> {
        let stale = match &self.normalized {
            Some(normalized) => normalized.mode() != retention_mode(),
            None => true,
        };
        if stale {
            let normalized = NormalizedState::normalize(self.raw())?;
            self.normalized = Some(normalized);
        }
        Ok(self.normalized.as_ref().expect("нормализовано выше"))
    }

    /// `state = applyGameEvent(state, event)`.
    pub fn apply(&mut self, event: &Value) -> Result<(), Halt> {
        let next = match (self.normalized.take(), self.raw.take()) {
            // Событие другого режима нормализует сырой итог в своём режиме.
            (Some(normalized), Some(raw)) if normalized.mode() != crate::replay::event_retention_mode(event) => crate::replay::apply_game_event_owned(raw, event)?,
            (Some(normalized), _) => normalized.reduced(event)?,
            (None, Some(raw)) => crate::replay::apply_game_event_owned(raw, event)?,
            (None, None) => unreachable!("в цепочке всегда есть состояние"),
        };
        self.raw = Some(next);
        Ok(())
    }

    /// Сырое состояние после последнего события.
    pub fn into_raw(self) -> Value {
        match (self.raw, self.normalized) {
            (Some(raw), _) => raw,
            (None, Some(normalized)) => normalized.into_value(),
            (None, None) => unreachable!("в цепочке всегда есть состояние"),
        }
    }
}
