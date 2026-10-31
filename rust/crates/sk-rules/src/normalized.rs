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
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use sk_society::retention_context::retention_mode;

use crate::pause::Halt;

/// Типы событий, ветка редьюсера которых над нормализованным состоянием
/// (режим `current`) сразу даёт нормализованный итог — неподвижную точку
/// `normalizeCampaignState` (Ск5); у `TurnStarted`, `TurnEnded`,
/// `ReactionWindowClosed` — после шага метки начала хода ([`settle_closed`]).
/// После них полная нормализация итога не нужна:
/// [`NormalizedState::applied`], [`EventChain::apply`], проектор команды и
/// коммит хранилища (`GameReducer::keeps_normalized`) её пропускают.
///
/// Это частые события хода. Доказательство — `sk-corpus closure` по корпусу
/// v2 (для каждого типа списка: проверено N состояний, 0 расхождений; код
/// выхода 3, если хоть одно разошлось) и `tests/normalization_closure.rs` по
/// эталонам JS. Сторож в работе: `SK_CHECK_CLOSURE=1` сверяет каждый
/// пропуск с полной нормализацией и падает на расхождении. Тип, которого
/// нет в списке, нормализуется, как прежде.
pub const NORMALIZATION_CLOSED_EVENT_TYPES: &[&str] = &[
    "AbilityCheckResolved",
    "ActionDeclared",
    "ActorMoved",
    "AreaRevealed",
    "AttackResolved",
    "CombatActionUsed",
    "CombatRoundTimeMarked",
    "ConcentrationEnded",
    "ConcentrationStarted",
    "ConditionAdded",
    "ConditionRemoved",
    "DamageApplied",
    "DieRolled",
    "HealingApplied",
    "HitPointsReducedToZero",
    "PublicDieRolled",
    "ReactionWindowClosed",
    "ReactionWindowOpened",
    "ResourceSpent",
    "SavingThrowResolved",
    "SpellAreaCreated",
    "SpellCast",
    "SpellSavingThrowResolved",
    "TimeAdvanced",
    "TurnEnded",
    "TurnStarted",
];

/// Итог события `event` над нормализованным в режиме `mode` состоянием
/// нормализован и без нормализации (см. [`NORMALIZATION_CLOSED_EVENT_TYPES`]):
/// только режим `current` — и вход, и событие, и окружение.
pub fn keeps_normalized(mode: &str, event: &Value) -> bool {
    mode == "current"
        && retention_mode() == "current"
        && crate::replay::event_retention_mode(event) == "current"
        && event.get("event_type").and_then(Value::as_str).is_some_and(|kind| NORMALIZATION_CLOSED_EVENT_TYPES.contains(&kind))
}

/// Типы из [`NORMALIZATION_CLOSED_EVENT_TYPES`], итог которых — неподвижная
/// точка нормализации после одного шага: метки начала хода
/// (`normalize::campaign::settle_turn_marks`). Ветки редьюсера пишут метку как
/// JS (`null`, если у события нет `created_at`/`event_id`), и сырой итог
/// цепочки разбора остаётся байт в байт итогом JS; нормализованным он
/// становится этим шагом, а не полной нормализацией.
const TURN_MARK_EVENT_TYPES: &[&str] = &["ReactionWindowClosed", "TurnEnded", "TurnStarted"];

fn settles_turn_marks(event: &Value) -> bool {
    event.get("event_type").and_then(Value::as_str).is_some_and(|kind| TURN_MARK_EVENT_TYPES.contains(&kind))
}

/// Довести итог замкнутого события ([`keeps_normalized`]) до нормализованного
/// вида: для типов с меткой начала хода — её шаг нормализации, для прочих —
/// ничего (итог уже неподвижная точка).
pub fn settle_closed(reduced: &mut Value, event: &Value) {
    if settles_turn_marks(event) {
        settle_turn_marks_of(reduced);
    }
}

fn settle_turn_marks_of(state: &mut Value) {
    if let Some(combat) = state.get_mut("mechanics").and_then(|mechanics| mechanics.get_mut("combat")).and_then(Value::as_object_mut) {
        crate::normalize::campaign::settle_turn_marks(combat);
    }
}

/// `SK_CHECK_CLOSURE=1`: каждый пропуск нормализации сверяется с полной
/// (сторож для тестов и прогонов контракта; в работе выключен).
fn closure_check_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("SK_CHECK_CLOSURE").is_ok_and(|value| value == "1"))
}

/// Итог замкнутого события как нормализованное состояние; под
/// `SK_CHECK_CLOSURE=1` — со сверкой с полной нормализацией.
fn trusted_closed(reduced: Value, event: &Value) -> NormalizedState {
    check_closed(&reduced, event);
    sk_store::perf::record("normalize.skipped", std::time::Duration::ZERO);
    NormalizedState { value: Arc::new(reduced), mode: "current" }
}

/// Сторож пропуска (`SK_CHECK_CLOSURE=1`): итог замкнутого события `event`
/// после [`settle_closed`] обязан быть неподвижной точкой нормализации. Без
/// переменной — ничего.
pub fn check_closed(reduced: &Value, event: &Value) {
    if closure_check_enabled() {
        let full = crate::normalize::normalize_campaign_state(reduced);
        let same = full.as_ref().is_ok_and(|full| sk_core::js::stringify(full) == sk_core::js::stringify(reduced));
        assert!(same, "SK_CHECK_CLOSURE: после {} нормализация меняет итог редьюсера", sk_core::js::s(event.get("event_type")));
    }
}

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
        let keeps = keeps_normalized(self.mode, event);
        let mut reduced = self.reduced(event)?;
        if keeps {
            settle_closed(&mut reduced, event);
            return Ok(trusted_closed(reduced, event));
        }
        Self::normalize_owned(reduced)
    }

    /// Состояние по ссылке.
    pub fn value(&self) -> &Value {
        &self.value
    }

    /// `state` — это же состояние (тот же `Arc`), а не копия.
    pub fn shares(&self, state: &Arc<Value>) -> bool {
        Arc::ptr_eq(&self.value, state)
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

impl Deref for EventChain {
    type Target = Value;

    /// [`EventChain::raw`].
    fn deref(&self) -> &Value {
        self.raw()
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
    /// `raw` — итог замкнутого события с меткой начала хода над
    /// нормализованным входом: нормализованным его делает [`settle_closed`].
    settle: bool,
}

impl EventChain {
    /// Начало цепочки — нормализованное состояние.
    pub fn new(start: NormalizedState) -> Self {
        Self { raw: None, normalized: Some(start), settle: false }
    }

    /// Начало цепочки — состояние как есть: первое событие нормализует его
    /// (`applyGameEvent(state, event)`).
    pub fn from_raw(start: Value) -> Self {
        Self { raw: Some(start), normalized: None, settle: false }
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
        if stale && self.settle && retention_mode() == "current" {
            // Сырой итог остаётся читаемым как в JS: доводится копия.
            let mut settled = {
                let _span = sk_store::perf::span("state.copy");
                self.raw().clone()
            };
            settle_turn_marks_of(&mut settled);
            self.normalized = Some(trusted_closed(settled, &Value::Null));
        } else if stale {
            let normalized = NormalizedState::normalize(self.raw())?;
            self.normalized = Some(normalized);
        }
        Ok(self.normalized.as_ref().expect("нормализовано выше"))
    }

    /// `state = applyGameEvent(state, event)`. Итог замкнутого события
    /// ([`keeps_normalized`]) над нормализованным входом сразу считается
    /// нормализованным: следующему шагу нормализация не нужна.
    pub fn apply(&mut self, event: &Value) -> Result<(), Halt> {
        if std::mem::take(&mut self.settle) {
            // Прежний сырой итог больше не читается: доводится на месте.
            let raw = self.raw.take().expect("сырой итог замкнутого события");
            if !self.normalized.as_ref().is_some_and(|normalized| normalized.mode() == "current") {
                let mut raw = raw;
                settle_turn_marks_of(&mut raw);
                self.normalized = Some(trusted_closed(raw, event));
            }
        }
        let (next, keeps) = match (self.normalized.take(), self.raw.take()) {
            // Событие другого режима нормализует сырой итог в своём режиме.
            (Some(normalized), Some(raw)) if normalized.mode() != crate::replay::event_retention_mode(event) => (crate::replay::apply_game_event_owned(raw, event)?, false),
            (Some(normalized), _) => {
                let keeps = keeps_normalized(normalized.mode(), event);
                (normalized.reduced(event)?, keeps)
            }
            (None, Some(raw)) => (crate::replay::apply_game_event_owned(raw, event)?, false),
            (None, None) => unreachable!("в цепочке всегда есть состояние"),
        };
        if keeps && settles_turn_marks(event) {
            self.raw = Some(next);
            self.settle = true;
        } else if keeps {
            self.normalized = Some(trusted_closed(next, event));
        } else {
            self.raw = Some(next);
        }
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
