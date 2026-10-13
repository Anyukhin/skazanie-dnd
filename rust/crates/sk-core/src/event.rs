//! Событие — контракт хранения и replay.
//!
//! Конверт совпадает с JS: `event_type`, `actor_id`, `target_ids`, `payload`,
//! `source_rule_ids`, `visibility` и необязательная версия схемы. Полезная
//! нагрузка пока — JSON: типы событий переводятся в структуры по мере переноса
//! редьюсера, а журнал прежнего движка читается без перевода.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sk_dice::Visibility;

use crate::{json, Command};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Event {
    #[serde(default)]
    pub campaign_id: Option<String>,
    #[serde(default)]
    pub command_id: Option<String>,
    pub event_type: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub target_ids: Vec<String>,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub source_rule_ids: Vec<String>,
    #[serde(default)]
    pub house_rule_id: Option<String>,
    #[serde(default)]
    pub ruling_id: Option<String>,
    #[serde(default)]
    pub visibility: Visibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_schema_version: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Event {
    pub fn payload_str(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(Value::as_str)
    }

    pub fn payload_int(&self, key: &str, fallback: i64) -> i64 {
        json::int(self.payload.get(key), fallback)
    }

    pub fn payload_bool(&self, key: &str) -> bool {
        json::is_true(self.payload.get(key))
    }

    pub fn payload(&self, key: &str) -> Option<&Value> {
        self.payload.get(key).filter(|value| !value.is_null())
    }

    /// Первая цель или действующее лицо.
    pub fn target(&self) -> Option<&str> {
        self.target_ids.first().map(String::as_str).or(self.actor_id.as_deref())
    }
}

/// Сборка события от команды: те же поля, что `eventFrom` в JS.
#[derive(Debug, Clone)]
pub struct EventDraft {
    event: Event,
}

impl EventDraft {
    pub fn new(command: &Command, event_type: &str) -> Self {
        let command_id = command.command_id();
        let campaign_id = command.string("campaign_id");
        Self {
            event: Event {
                campaign_id: (!campaign_id.is_empty()).then_some(campaign_id),
                command_id: (!command_id.is_empty()).then_some(command_id),
                event_type: event_type.into(),
                actor_id: Some(command.actor_id()).filter(|id| !id.is_empty()),
                target_ids: Vec::new(),
                payload: Value::Object(Map::new()),
                source_rule_ids: Vec::new(),
                house_rule_id: None,
                ruling_id: None,
                visibility: command.visibility(),
                event_schema_version: None,
                extra: Map::new(),
            },
        }
    }

    pub fn actor(mut self, actor_id: impl Into<String>) -> Self {
        self.event.actor_id = Some(actor_id.into());
        self
    }

    pub fn targets<I, S>(mut self, targets: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.event.target_ids = targets.into_iter().map(Into::into).collect();
        self
    }

    pub fn target(self, target: impl Into<String>) -> Self {
        self.targets([target.into()])
    }

    pub fn payload(mut self, payload: Value) -> Self {
        self.event.payload = payload;
        self
    }

    pub fn rules<I, S>(mut self, rules: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.event.source_rule_ids = rules.into_iter().map(Into::into).collect();
        self
    }

    pub fn visibility(mut self, visibility: Visibility) -> Self {
        self.event.visibility = visibility;
        self
    }

    pub fn schema(mut self, version: i64) -> Self {
        self.event.event_schema_version = Some(version);
        self
    }

    pub fn build(self) -> Event {
        self.event
    }
}
