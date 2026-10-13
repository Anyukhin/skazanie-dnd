//! Команда игрока, Режиссёра или планировщика врагов.
//!
//! Команда приходит JSON-объектом с `command_type` и плоскими полями — как в
//! JS. Клиентские поля недоверенные: читаем их через аксессоры с проверкой, а
//! не десериализуем «как есть» в доверенные структуры.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::json;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct Command(pub Map<String, Value>);

impl Command {
    pub fn from_json(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(Self(map)),
            _ => None,
        }
    }

    pub fn new(command_type: &str, actor_id: &str) -> Self {
        let mut map = Map::new();
        map.insert("command_type".into(), Value::String(command_type.into()));
        map.insert("actor_id".into(), Value::String(actor_id.into()));
        Self(map)
    }

    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.into(), value.into());
        self
    }

    pub fn command_type(&self) -> &str {
        self.0.get("command_type").or_else(|| self.0.get("type")).and_then(Value::as_str).unwrap_or("")
    }

    pub fn command_id(&self) -> String {
        json::string(self.0.get("command_id"))
    }

    pub fn actor_id(&self) -> String {
        json::string(self.0.get("actor_id"))
    }

    /// Цель: `target_id`, иначе первая из `target_ids`.
    pub fn target_id(&self) -> Option<String> {
        let direct = json::string(self.0.get("target_id"));
        if !direct.is_empty() {
            return Some(direct);
        }
        json::strings(self.0.get("target_ids")).into_iter().next().filter(|id| !id.is_empty())
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn string(&self, key: &str) -> String {
        json::string(self.0.get(key))
    }

    pub fn int(&self, key: &str) -> Option<i64> {
        self.0.get(key).filter(|value| !value.is_null()).map(|value| json::int(Some(value), 0))
    }

    pub fn is_true(&self, key: &str) -> bool {
        json::is_true(self.0.get(key))
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key).filter(|value| !value.is_null())
    }

    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.0.insert(key.into(), value.into());
    }

    pub fn remove(&mut self, key: &str) {
        self.0.remove(key);
    }

    pub fn strings(&self, key: &str) -> Vec<String> {
        json::strings(self.0.get(key))
    }

    pub fn visibility(&self) -> sk_dice::Visibility {
        self.str("visibility").map(sk_dice::Visibility::parse_lenient).unwrap_or_default()
    }

    /// Точка `to`/`destination`.
    pub fn point(&self, key: &str) -> Option<crate::Point> {
        let value = self.get(key)?.as_object()?;
        Some(crate::Point::new(json::int(value.get("x"), 0), json::int(value.get("y"), 0)))
    }
}
