//! Заглушки модели — по образцу `test/kit/llm.mjs`:
//!
//! - [`ForbiddenLlm`] — обращение к модели есть ошибка теста (`forbiddenLlm`);
//! - [`ScriptedLlm`] — ответы по очереди, вызовы записываются; очередь
//!   кончилась — `LLM_UNEXPECTED_CALL` (`scriptedLlm`).
//!
//! В `AppState` они попадают только через учёт расхода (`Metered::wrap`), как
//! настоящие клиенты: так тест видит и вызов, и запись в `usage-ledger`.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sk_infra::usage_ledger::{LlmClient, LlmError, LlmFuture};

/// Клиент модели, который не отвечает никогда.
pub struct ForbiddenLlm;

impl LlmClient for ForbiddenLlm {
    fn model(&self) -> Option<String> {
        Some("test/forbidden".into())
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError::new("LLM_FORBIDDEN", "Тест не должен звать модель")) })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError::new("LLM_FORBIDDEN", "Тест не должен звать модель")) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

/// Один ответ сценария.
pub enum Reply {
    /// Значение: строка — текст, объект с `content` — ответ как есть,
    /// иное — JSON-ответ (`{ content, json }`), как `scriptedLlm.complete`.
    Value(Value),
    /// Отказ модели.
    Error(LlmError),
}

/// Вызов модели, записанный заглушкой.
#[derive(Debug, Clone)]
pub struct Call {
    pub input: Value,
    pub options: Value,
}

/// Модель со сценарием ответов.
pub struct ScriptedLlm {
    model: String,
    queue: Mutex<VecDeque<Reply>>,
    calls: Mutex<Vec<Call>>,
    usage: Value,
}

impl ScriptedLlm {
    pub fn new(replies: impl IntoIterator<Item = Reply>) -> Arc<Self> {
        Arc::new(Self {
            model: "kit/scripted".into(),
            queue: Mutex::new(replies.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
            usage: json!({ "prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20 }),
        })
    }

    /// Сценарий из одних значений.
    pub fn values(values: impl IntoIterator<Item = Value>) -> Arc<Self> {
        Self::new(values.into_iter().map(Reply::Value))
    }

    /// Записанные вызовы.
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Сколько ответов осталось.
    pub fn remaining(&self) -> usize {
        self.queue.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len()
    }

    fn shape(&self, value: Value) -> Value {
        let mut result = match value {
            Value::String(text) => json!({ "content": text, "json": null }),
            Value::Object(map) if map.contains_key("content") => Value::Object(map),
            other => json!({ "content": other.to_string(), "json": other }),
        };
        if let Some(map) = result.as_object_mut() {
            map.entry("model").or_insert_with(|| Value::from(self.model.clone()));
            map.entry("usage").or_insert_with(|| self.usage.clone());
        }
        result
    }
}

impl LlmClient for ScriptedLlm {
    fn model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async move {
            self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(Call { input: input.clone(), options: options.clone() });
            let next = self.queue.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front();
            match next {
                Some(Reply::Value(value)) => Ok(self.shape(value)),
                Some(Reply::Error(error)) => Err(error),
                None => Err(LlmError::new("LLM_UNEXPECTED_CALL", "Сценарий модели исчерпан: лишний вызов")),
            }
        })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!({ "ok": true })) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}
