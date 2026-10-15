//! Единственный исполнитель записи в журнал — перенос
//! `server/authoritative-executor.mjs`.
//!
//! Три входа с одной политикой устойчивости (оптимистичный повтор на конфликте
//! версии, перечитывание по ключу на повторе):
//!
//! - [`AuthoritativeExecutor::execute_commands`] — план → разбор Rules Engine →
//!   коммит;
//! - [`AuthoritativeExecutor::commit_derived`] — готовые события производителя,
//!   разрешённые явной таблицей и правом [`Producer`];
//! - [`AuthoritativeExecutor::commit_control`] — владельческий откат
//!   (`CampaignRewound`), который переписывает состояние целиком.
//!
//! Право производителя в JS — `Symbol`, который JSON-запрос подделать не может.
//! В Rust это перечисление без `Deserialize`: из тела запроса его не получить.

use serde_json::{Map, Value};
use sk_core::RuleError;

use crate::error::StoreError;
use crate::store::{CommitRequest, CommitResult, EventStore, LoadOptions, Loaded};
use crate::StoreResult;

/// Неподделываемое право производителя событий.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Producer {
    PartyDecision,
    Presence,
    EconomyClock,
    WorldRumor,
    CampaignLifecycle,
    PublicDice,
    CampaignRuleset,
    /// Управляющий вход: только откат кампании.
    CampaignControl,
}

impl Producer {
    /// `DERIVED_PRODUCERS`: имя производителя в таблице для ревью.
    pub fn review_name(self) -> Option<&'static str> {
        Some(match self {
            Self::PartyDecision => "partyDecision",
            Self::Presence => "presence",
            Self::EconomyClock => "economyClock",
            Self::WorldRumor => "worldRumor",
            Self::CampaignLifecycle => "campaignLifecycle",
            Self::PublicDice => "publicDice",
            Self::CampaignRuleset => "campaignRuleset",
            Self::CampaignControl => return None,
        })
    }

    /// `DERIVED_EVENT_ALLOWLIST`: ровно свои типы событий.
    pub fn allowed_events(self) -> &'static [&'static str] {
        match self {
            // Групповой бросок решает исход голосования; разрешён явно, а
            // инвариант ниже не даёт ему тронуть владения Rules Engine.
            Self::PartyDecision => &["PartyDecisionOpened", "PartyVoteCast", "PartyDecisionAbstained", "PartyDecisionResolved", "PartyDecisionExpired", "DieRolled"],
            Self::Presence => &["PartyDecisionAbstained", "PartyDecisionResolved"],
            // Только событие часов: пополнение лавки остаётся за Rules Engine.
            Self::EconomyClock => &["MerchantEconomyClockAdvanced"],
            // Только реакция мира на дошедший слух; сами слухи — команды памяти мира.
            Self::WorldRumor => &["FactionReputationAdjusted"],
            Self::CampaignLifecycle => &[
                "CampaignActivated",
                "CampaignPaused",
                "CampaignResumed",
                "CampaignCompleted",
                "CampaignFailed",
                "CampaignArchived",
                "CampaignArcChainSet",
                "NarrativeSummaryRecorded",
            ],
            Self::PublicDice => &["PublicDieRolled"],
            Self::CampaignRuleset => &["CampaignHouseRuleChanged", "CampaignRulesetChanged"],
            Self::CampaignControl => &[],
        }
    }

    pub const DERIVED: [Producer; 7] = [
        Producer::PartyDecision,
        Producer::Presence,
        Producer::EconomyClock,
        Producer::WorldRumor,
        Producer::CampaignLifecycle,
        Producer::PublicDice,
        Producer::CampaignRuleset,
    ];
}

/// `derivedEventAllowlistForReview()`: таблица целиком, типы по алфавиту.
pub fn derived_event_allowlist_for_review() -> Map<String, Value> {
    let mut table = Map::new();
    for producer in Producer::DERIVED {
        let mut types: Vec<&str> = producer.allowed_events().to_vec();
        types.sort_unstable();
        table.insert(producer.review_name().unwrap_or_default().into(), sk_core::js::strings_value(types));
    }
    table
}

/// Поля, которыми владеет Rules Engine: производное событие их не трогает.
const RULES_ENGINE_OWNED_KEYS: [&str; 19] = [
    "hp", "hp_after", "hp_before", "max_hp", "damage", "healing", "resources", "position", "positions", "to", "from", "inventory", "item_id", "initiative", "action_economy",
    "conditions", "currency", "currency_cp", "experience",
];

/// `rulesEngineOwnedKeyIn(payload)`: первое поле Rules Engine на любой глубине.
fn rules_engine_owned_key_in(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, item) in sk_core::js::entries(map) {
                if RULES_ENGINE_OWNED_KEYS.contains(&key.as_str()) {
                    return Some(key.clone());
                }
                if let Some(nested) = rules_engine_owned_key_in(item) {
                    return Some(nested);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(rules_engine_owned_key_in),
        _ => None,
    }
}

/// Отказ исполнителя.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ExecutorError {
    #[error("{code}: {message}")]
    Executor { code: &'static str, message: String },
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Rule(#[from] RuleError),
}

impl ExecutorError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self::Executor { code, message: message.into() }
    }

    /// Код для HTTP и сверки.
    pub fn code(&self) -> &str {
        match self {
            Self::Executor { code, .. } => code,
            Self::Store(error) => error.code,
            Self::Rule(error) => &error.code,
        }
    }
}

pub type ExecutorResult<T> = Result<T, ExecutorError>;

/// Журнал, в который пишет исполнитель (в JS — любой объект с `load`,
/// `commit`, `getByIdempotencyKey`). Нужен тестам, чтобы воспроизвести гонку.
pub trait Journal {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded>;
    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult>;
    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>>;
}

impl Journal for EventStore {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        EventStore::load(self, campaign_id, &LoadOptions::default())
    }

    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        EventStore::commit(self, request)
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>> {
        EventStore::get_by_idempotency_key(self, campaign_id, key)
    }
}

/// Итог коммита исполнителя: подтверждённый коммит, признак повтора и
/// разобранный план, если он считался в этом вызове.
#[derive(Debug, Clone, PartialEq)]
pub struct Executed {
    pub commit: CommitResult,
    pub replayed: bool,
    pub resolved: Option<Value>,
}

/// Разбор плана Rules Engine: команды, состояние, контекст → `{ events, … }`.
pub type ResolvePlan<'a> = dyn Fn(&[Value], &Value, &Value) -> Result<Value, RuleError> + 'a;

/// Сборка производных событий против свежего состояния.
pub type DeriveEvents<'a> = dyn Fn(&Value, &Loaded) -> Result<Vec<Value>, RuleError> + 'a;

/// Метаданные коммита по событиям и состоянию.
pub type DeriveMetadata<'a> = dyn Fn(&[Value], &Value, &Loaded) -> Value + 'a;

/// Запрос производного коммита.
pub struct DerivedRequest<'a> {
    pub campaign_id: &'a str,
    pub idempotency_key: &'a str,
    pub events: Option<Vec<Value>>,
    pub derive_events: Option<&'a DeriveEvents<'a>>,
    pub producer: Option<Producer>,
    pub derived_from: Vec<String>,
    pub metadata: Value,
    pub derive_metadata: Option<&'a DeriveMetadata<'a>>,
}

impl<'a> DerivedRequest<'a> {
    pub fn events(campaign_id: &'a str, idempotency_key: &'a str, producer: Producer, events: Vec<Value>) -> Self {
        Self { campaign_id, idempotency_key, events: Some(events), derive_events: None, producer: Some(producer), derived_from: Vec::new(), metadata: Value::Null, derive_metadata: None }
    }
}

/// `AuthoritativeExecutor`.
pub struct AuthoritativeExecutor<'a> {
    journal: &'a dyn Journal,
    max_attempts: usize,
}

fn is_version_conflict(error: &StoreError) -> bool {
    error.code == "STATE_VERSION_CONFLICT"
}

impl<'a> AuthoritativeExecutor<'a> {
    pub fn new(journal: &'a dyn Journal) -> Self {
        Self { journal, max_attempts: 3 }
    }

    pub fn with_max_attempts(mut self, attempts: usize) -> Self {
        self.max_attempts = attempts.max(1);
        self
    }

    fn replayed(commit: CommitResult) -> Executed {
        Executed { commit, replayed: true, resolved: None }
    }

    /// `executeCommands`: план → разбор → коммит с повтором на конфликте версии.
    pub fn execute_commands(&self, campaign_id: &str, idempotency_key: &str, commands: &[Value], context: &Value, resolve_plan: &ResolvePlan<'_>) -> ExecutorResult<Executed> {
        if idempotency_key.is_empty() {
            return Err(ExecutorError::new("IDEMPOTENCY_KEY_REQUIRED", "Нужен идемпотентный ключ"));
        }
        if commands.is_empty() {
            return Err(ExecutorError::new("EMPTY_COMMAND_SET", "Пустой набор команд не коммитится"));
        }
        if let Some(duplicate) = self.journal.get_by_idempotency_key(campaign_id, idempotency_key)? {
            return Ok(Self::replayed(duplicate));
        }
        let mut state = self.journal.load(campaign_id)?.state;
        let mut last_error = None;
        for attempt in 0..self.max_attempts {
            let resolved = resolve_plan(commands, &state, context)?;
            let events = resolved.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            if events.is_empty() {
                return Err(ExecutorError::new("EMPTY_EVENT_SET", "План не создал ни одного события"));
            }
            let request = CommitRequest {
                campaign_id: campaign_id.into(),
                expected_state_version: sk_core::js::safe_int(state.get("state_version"), 0),
                idempotency_key: idempotency_key.into(),
                command_id: Some(idempotency_key.into()),
                events,
                ..Default::default()
            };
            match self.journal.commit(request) {
                Ok(commit) => {
                    let replayed = commit.duplicate;
                    return Ok(Executed { commit, replayed, resolved: Some(resolved) });
                }
                Err(error) if is_version_conflict(&error) && attempt + 1 < self.max_attempts => {
                    last_error = Some(error);
                    state = self.journal.load(campaign_id)?.state;
                }
                Err(error) if error.code == "IDEMPOTENCY_CONFLICT" => {
                    if let Some(existing) = self.journal.get_by_idempotency_key(campaign_id, idempotency_key)? {
                        return Ok(Self::replayed(existing));
                    }
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(last_error.map_or_else(|| ExecutorError::new("COMMIT_FAILED", "Команда не была подтверждена"), ExecutorError::from))
    }

    fn assert_allowed(producer: Producer, candidate: &[Value]) -> ExecutorResult<()> {
        if candidate.is_empty() {
            return Err(ExecutorError::new("EMPTY_EVENT_SET", "Пустой набор событий не коммитится"));
        }
        for event in candidate {
            let kind = sk_core::js::s(event.get("event_type"));
            if !producer.allowed_events().contains(&kind.as_str()) {
                let shown = if kind.is_empty() { "(без типа)".to_string() } else { kind };
                return Err(ExecutorError::new("DERIVED_EVENT_NOT_ALLOWED", format!("Событие {shown} не разрешено этому производителю")));
            }
            if let Some(owned) = event.get("payload").and_then(rules_engine_owned_key_in) {
                return Err(ExecutorError::new("DERIVED_EVENT_TOUCHES_RULES_STATE", format!("Производное событие {kind} трогает «{owned}» — этим владеет Rules Engine")));
            }
        }
        Ok(())
    }

    /// `commitDerived`: производные события по таблице производителя; при
    /// `derive_events` они пересобираются против свежего состояния на каждой
    /// попытке. `Ok(None)` — сборщик ничего не вернул.
    pub fn commit_derived(&self, request: DerivedRequest<'_>) -> ExecutorResult<Option<Executed>> {
        if request.idempotency_key.is_empty() {
            return Err(ExecutorError::new("IDEMPOTENCY_KEY_REQUIRED", "Нужен идемпотентный ключ"));
        }
        let producer = match request.producer {
            Some(producer) if producer != Producer::CampaignControl => producer,
            _ => return Err(ExecutorError::new("PRODUCER_CAPABILITY_REQUIRED", "Производитель не объявлен в таблице производных событий")),
        };
        if request.derive_events.is_none() {
            Self::assert_allowed(producer, request.events.as_deref().unwrap_or(&[]))?;
        }
        if let Some(duplicate) = self.journal.get_by_idempotency_key(request.campaign_id, request.idempotency_key)? {
            return Ok(Some(Self::replayed(duplicate)));
        }
        for attempt in 0..self.max_attempts {
            let loaded = self.journal.load(request.campaign_id)?;
            let prepared = match request.derive_events {
                Some(derive) => {
                    let events = derive(&loaded.state, &loaded)?;
                    if events.is_empty() {
                        return Ok(None);
                    }
                    Self::assert_allowed(producer, &events)?;
                    events
                }
                None => request.events.clone().unwrap_or_default(),
            };
            let metadata = match request.derive_metadata {
                Some(derive) => derive(&prepared, &loaded.state, &loaded),
                None => request.metadata.clone(),
            };
            let events = prepared
                .into_iter()
                .map(|event| {
                    let mut event = sk_core::js::spread(&event, serde_json::json!({ "campaign_id": request.campaign_id }));
                    if !request.derived_from.is_empty() {
                        event["source_event_ids"] = sk_core::js::strings_value(request.derived_from.iter().take(32).cloned());
                    }
                    event
                })
                .collect();
            let has_metadata = metadata.as_object().is_some_and(|map| !map.is_empty());
            let commit_request = CommitRequest {
                campaign_id: request.campaign_id.into(),
                expected_state_version: loaded.state_version,
                idempotency_key: request.idempotency_key.into(),
                command_id: Some(request.idempotency_key.into()),
                events,
                metadata: if has_metadata { metadata } else { Value::Object(Map::new()) },
                ..Default::default()
            };
            match self.journal.commit(commit_request) {
                Ok(commit) => {
                    let replayed = commit.duplicate;
                    return Ok(Some(Executed { commit, replayed, resolved: None }));
                }
                Err(error) if is_version_conflict(&error) && attempt + 1 < self.max_attempts => continue,
                Err(error) if error.code == "IDEMPOTENCY_CONFLICT" => {
                    if let Some(existing) = self.journal.get_by_idempotency_key(request.campaign_id, request.idempotency_key)? {
                        return Ok(Some(Self::replayed(existing)));
                    }
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(ExecutorError::new("COMMIT_FAILED", "Производное событие не было подтверждено"))
    }

    /// `commitControl`: только `CampaignRewound` и только с правом управления.
    pub fn commit_control(&self, campaign_id: &str, idempotency_key: &str, event: &Value, producer: Producer, force_snapshot: bool) -> ExecutorResult<Executed> {
        if producer != Producer::CampaignControl {
            return Err(ExecutorError::new("PRODUCER_CAPABILITY_REQUIRED", "Управление кампанией: производитель не предъявил неподделываемую capability"));
        }
        if idempotency_key.is_empty() {
            return Err(ExecutorError::new("IDEMPOTENCY_KEY_REQUIRED", "Нужен идемпотентный ключ"));
        }
        if event.get("event_type").and_then(Value::as_str) != Some("CampaignRewound") {
            return Err(ExecutorError::new("CONTROL_EVENT_NOT_ALLOWED", "Через управляющий вход проходит только CampaignRewound"));
        }
        if let Some(duplicate) = self.journal.get_by_idempotency_key(campaign_id, idempotency_key)? {
            return Ok(Self::replayed(duplicate));
        }
        let loaded = self.journal.load(campaign_id)?;
        let commit = self.journal.commit(CommitRequest {
            campaign_id: campaign_id.into(),
            expected_state_version: loaded.state_version,
            idempotency_key: idempotency_key.into(),
            command_id: Some(idempotency_key.into()),
            events: vec![sk_core::js::spread(event, serde_json::json!({ "campaign_id": campaign_id }))],
            force_snapshot,
            ..Default::default()
        })?;
        let replayed = commit.duplicate;
        Ok(Executed { commit, replayed, resolved: None })
    }
}
