//! Общие помощники тестов задачи А2: записывающая заглушка модели,
//! исполнитель будущих значений без tokio, чтение эталона.

#![allow(dead_code)] // помощники делят несколько тестовых файлов

use std::future::Future;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use serde_json::{json, Map, Value};
use sk_agents::director_agent::RoleClient;
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};

/// Выполнить будущее значение заглушки (готово без ожидания).
pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}

/// Ответ заглушки: JSON или ошибка клиента.
#[derive(Clone, Debug)]
pub enum Reply {
    Json(Value),
    Error(LlmError),
}

impl Reply {
    /// Из записи эталона `{ json }` / `{ error: { name, code, message } }`.
    pub fn from_fixture(value: &Value) -> Reply {
        match value.get("error") {
            Some(error) => Reply::Error(LlmError {
                name: error.get("name").and_then(Value::as_str).unwrap_or("Error").to_string(),
                code: error.get("code").and_then(Value::as_str).map(str::to_string),
                message: error.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                details: Map::new(),
                provider_usage: None,
            }),
            None => Reply::Json(value.get("json").cloned().unwrap_or(Value::Null)),
        }
    }

    pub fn error(name: &str, code: &str, message: &str) -> Reply {
        Reply::Error(LlmError { name: name.into(), code: Some(code.into()), message: message.into(), details: Map::new(), provider_usage: None })
    }
}

/// Заглушка модели: записывает `{ input, options }` каждого `completeJson`
/// и отдаёт заданные ответы по очереди (как `RecordingLLM` генератора).
pub struct RecordingLlm {
    replies: Mutex<Vec<Reply>>,
    calls: Mutex<Vec<Value>>,
    model: Option<String>,
}

impl RecordingLlm {
    pub fn new(replies: Vec<Reply>, model: Option<&str>) -> Arc<Self> {
        let mut replies = replies;
        replies.reverse();
        Arc::new(RecordingLlm { replies: Mutex::new(replies), calls: Mutex::new(Vec::new()), model: model.map(str::to_string) })
    }

    pub fn calls(&self) -> Vec<Value> {
        self.calls.lock().map(|calls| calls.clone()).unwrap_or_default()
    }
}

impl LlmClient for RecordingLlm {
    fn model(&self) -> Option<String> {
        self.model.clone()
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(Reply::error("LLMError", "NOT_USED", "complete не используется").into_error()) })
    }

    fn complete_json<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(json!({ "input": input, "options": options }));
        }
        let next = self.replies.lock().ok().and_then(|mut replies| replies.pop());
        Box::pin(async move {
            match next {
                Some(Reply::Json(value)) => Ok(value),
                Some(Reply::Error(error)) => Err(error),
                None => Err(Reply::error("LLMError", "FAKE_LLM_EXHAUSTED", "У FakeLLM закончились ответы").into_error()),
            }
        })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(Value::Array(Vec::new())) })
    }

    fn health(&self) -> Value {
        Value::Array(Vec::new())
    }
}

impl Reply {
    fn into_error(self) -> LlmError {
        match self {
            Reply::Error(error) => error,
            Reply::Json(_) => LlmError { name: "Error".into(), code: None, message: String::new(), details: Map::new(), provider_usage: None },
        }
    }
}

/// Клиент роли поверх заглушки: имя класса JS — `RecordingLLM`.
pub fn role_client(llm: &Arc<RecordingLlm>) -> RoleClient {
    RoleClient::new(llm.clone(), "RecordingLLM")
}

/// Прочитать эталон `fixtures/<name>` (gzip).
pub fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("эталон {}: {error}", path.display()));
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice()).read_to_string(&mut text).unwrap_or_else(|error| panic!("распаковка {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("разбор {}: {error}", path.display()))
}

/// Состояние по ссылке `{ "$state": N }` или само значение.
pub fn resolve(value: &Value, states: &[Value]) -> Value {
    match value.get("$state").and_then(Value::as_u64) {
        Some(index) if value.as_object().is_some_and(|map| map.len() == 1) => states[index as usize].clone(),
        _ => value.clone(),
    }
}

/// SHA-256 строки `JSON.stringify(value)`.
pub fn hash(value: &Value) -> String {
    sk_core::hash::sha256_hex(sk_core::js::stringify(value))
}
