//! Отказы хранилища — те же коды, что у `server/event-store.mjs`: по ним
//! HTTP отвечает игроку, а сторожа инвариантов отличают гонку от порчи.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct StoreError {
    pub code: &'static str,
    pub message: String,
    pub campaign_id: Option<String>,
    pub details: Value,
}

impl StoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), campaign_id: None, details: Value::Object(Default::default()) }
    }

    fn for_campaign(code: &'static str, campaign_id: &str, message: impl Into<String>, details: Value) -> Self {
        Self { code, message: message.into(), campaign_id: Some(campaign_id.to_string()), details }
    }

    pub fn campaign_not_found(campaign_id: &str) -> Self {
        Self::for_campaign("CAMPAIGN_NOT_FOUND", campaign_id, format!("Campaign {campaign_id} is not initialized"), json!({}))
    }

    pub fn already_initialized(campaign_id: &str, state_version: i64) -> Self {
        Self::for_campaign(
            "CAMPAIGN_ALREADY_INITIALIZED",
            campaign_id,
            format!("Campaign {campaign_id} is already initialized at state version {state_version}"),
            json!({ "state_version": state_version }),
        )
    }

    pub fn version_conflict(campaign_id: &str, expected: i64, actual: i64) -> Self {
        Self::for_campaign(
            "STATE_VERSION_CONFLICT",
            campaign_id,
            format!("State version conflict for {campaign_id}: expected {expected}, actual {actual}"),
            json!({ "expected_state_version": expected, "actual_state_version": actual }),
        )
    }

    pub fn idempotency_conflict(campaign_id: &str, key: &str) -> Self {
        Self::for_campaign(
            "IDEMPOTENCY_CONFLICT",
            campaign_id,
            format!("Idempotency key {key} was already used with a different request"),
            json!({ "idempotency_key": key }),
        )
    }

    pub fn corrupt(campaign_id: &str, message: impl Into<String>, details: Value) -> Self {
        Self::for_campaign("CORRUPT_EVENT_LOG", campaign_id, format!("Corrupt event log for {campaign_id}: {}", message.into()), details)
    }

    /// Журнал непригоден к тихой загрузке (`CAMPAIGN_RECOVERY_REQUIRED`):
    /// потерян хвост или исходный снимок.
    pub fn recovery_required(campaign_id: &str, reason: &str, message: impl Into<String>, details: Value) -> Self {
        let mut details = details;
        if let Some(map) = details.as_object_mut() {
            map.insert("reason".into(), Value::String(reason.to_string()));
        }
        Self::for_campaign("CAMPAIGN_RECOVERY_REQUIRED", campaign_id, format!("Campaign {campaign_id} requires recovery ({reason}): {}", message.into()), details)
    }

    pub fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }

    /// Тело ответа HTTP: `{ code, message, details }`.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message, "campaign_id": self.campaign_id, "details": self.details })
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(failure, _) = &error {
            if failure.code == rusqlite::ErrorCode::DatabaseBusy || failure.code == rusqlite::ErrorCode::DatabaseLocked {
                return Self::new("EVENT_STORE_BUSY", format!("Хранилище занято: {error}"));
            }
        }
        Self::new("EVENT_STORE_ERROR", format!("SQLite: {error}"))
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_STORE_FILE", format!("JSON: {error}"))
    }
}

pub type StoreResult<T> = Result<T, StoreError>;
