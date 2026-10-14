//! `FakeLLM` из `server/llm-client.mjs`: заглушка модели для тестов с теми же
//! строгими проверками ответа, что у настоящего клиента (JSON, инструменты,
//! предел вызовов, таймаут).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use sk_core::js;

use super::abort::{race, sleep_with_signal, AbortScope};
use super::{coalesce, index0, normalize_assistant_message, normalize_request, positive_or, prop, CallScope, HookFuture, LlmClient, LlmError, LlmErrorExt, LlmFuture, DEFAULT_MAX_TOOL_CALLS, DEFAULT_TIMEOUT_MS};

/// Ответ из очереди: значение (сообщение, конверт `choices` или данные для
/// `content`) или ошибка, которую вызов выбросит.
#[derive(Debug, Clone, PartialEq)]
pub enum FakeReply {
    Value(Value),
    Error(LlmError),
}

impl From<Value> for FakeReply {
    fn from(value: Value) -> Self {
        FakeReply::Value(value)
    }
}

impl From<LlmError> for FakeReply {
    fn from(error: LlmError) -> Self {
        FakeReply::Error(error)
    }
}

/// `handler(request, index)`: ответ по запросу; ошибка — отказ вызова.
pub type FakeHandler = Arc<dyn Fn(Value, usize) -> HookFuture<Value> + Send + Sync>;

/// `new FakeLLM(config)`.
#[derive(Clone, Default)]
pub struct FakeLlmConfig {
    pub responses: Vec<FakeReply>,
    pub handler: Option<FakeHandler>,
    /// `delayMs` (`Math.max(0, Number(x) || 0)`).
    pub delay_ms: Option<Value>,
    pub timeout_ms: Option<Value>,
    pub max_tool_calls: Option<Value>,
}

/// `FakeLLM`.
pub struct FakeLlm {
    responses: Mutex<VecDeque<FakeReply>>,
    handler: Option<FakeHandler>,
    delay_ms: f64,
    timeout_ms: i64,
    max_tool_calls: i64,
    requests: Mutex<Vec<Value>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `fakeMessage(response)`: сообщение из конверта, само сообщение или
/// данные, ставшие `content`.
fn fake_message(response: &Value) -> Value {
    if let Some(message) = prop(index0(prop(Some(response), "choices")), "message") {
        if js::truthy(Some(message)) {
            return message.clone();
        }
    }
    if let Value::Object(map) = response {
        if map.contains_key("content") || map.contains_key("tool_calls") || map.contains_key("toolCalls") || map.get("role").and_then(Value::as_str) == Some("assistant") {
            return response.clone();
        }
    }
    let content = match response {
        Value::String(text) => text.clone(),
        other => sk_narration_base::jsx::stringify(other),
    };
    let mut message = Map::new();
    message.insert("role".into(), Value::String("assistant".into()));
    message.insert("content".into(), Value::String(content));
    Value::Object(message)
}

impl FakeLlm {
    pub fn new(config: FakeLlmConfig) -> Self {
        let delay = js::number(config.delay_ms.as_ref());
        let default_timeout = Value::from(DEFAULT_TIMEOUT_MS);
        let default_tool_calls = Value::from(DEFAULT_MAX_TOOL_CALLS);
        FakeLlm {
            responses: Mutex::new(config.responses.into_iter().collect()),
            handler: config.handler,
            delay_ms: if delay.is_nan() || delay == 0.0 { 0.0 } else { delay.max(0.0) },
            timeout_ms: positive_or(coalesce(config.timeout_ms.as_ref(), Some(&default_timeout)), DEFAULT_TIMEOUT_MS),
            max_tool_calls: positive_or(coalesce(config.max_tool_calls.as_ref(), Some(&default_tool_calls)), DEFAULT_MAX_TOOL_CALLS),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// `new FakeLLM([…ответы])`.
    pub fn from_responses<I, R>(responses: I) -> Self
    where
        I: IntoIterator<Item = R>,
        R: Into<FakeReply>,
    {
        Self::new(FakeLlmConfig { responses: responses.into_iter().map(Into::into).collect(), ..FakeLlmConfig::default() })
    }

    /// `new FakeLLM(handler)`.
    pub fn from_handler<F, Fut>(handler: F) -> Self
    where
        F: Fn(Value, usize) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Value, LlmError>> + Send + 'static,
    {
        Self::new(FakeLlmConfig { handler: Some(Arc::new(move |request, index| Box::pin(handler(request, index)))), ..FakeLlmConfig::default() })
    }

    /// `enqueue(response)`.
    pub fn enqueue(&self, response: impl Into<FakeReply>) -> &Self {
        lock(&self.responses).push_back(response.into());
        self
    }

    /// `requests` (они же `calls`): нормализованные запросы по порядку.
    pub fn requests(&self) -> Vec<Value> {
        lock(&self.requests).clone()
    }

    pub fn timeout_ms(&self) -> i64 {
        self.timeout_ms
    }

    pub fn max_tool_calls(&self) -> i64 {
        self.max_tool_calls
    }

    async fn answer(&self, request: &Map<String, Value>, signal: &super::AbortSignal) -> Result<Value, LlmError> {
        let delay = coalesce(request.get("delayMs"), None).cloned().unwrap_or_else(|| js::num(self.delay_ms));
        if js::truthy(Some(&delay)) {
            sleep_with_signal(js::number(Some(&delay)), signal).await?;
        }
        let response = if let Some(handler) = &self.handler {
            let index = lock(&self.requests).len().saturating_sub(1);
            race(handler(Value::Object(request.clone()), index), Some(signal)).await?
        } else {
            let next = lock(&self.responses).pop_front();
            match next {
                Some(FakeReply::Value(value)) => value,
                Some(FakeReply::Error(error)) => return Err(error),
                None => return Err(LlmError::llm("У FakeLLM закончились ответы", "FAKE_LLM_EXHAUSTED")),
            }
        };
        let mut message = normalize_assistant_message(Some(&fake_message(&response)), request, self.max_tool_calls)?;
        message.insert("model".into(), Value::String("fake".into()));
        message.insert("usage".into(), Value::Null);
        message.insert("provider".into(), Value::String("FakeLLM".into()));
        Ok(Value::Object(message))
    }
}

impl LlmClient for FakeLlm {
    /// У `FakeLLM` в JS нет `model`.
    fn model(&self) -> Option<String> {
        None
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        // Запрос записывается при вызове, как в JS.
        let request = normalize_request(input, options).inspect(|request| lock(&self.requests).push(Value::Object(request.clone())));
        Box::pin(async move {
            let request = request?;
            let hooks = CallScope::current().hooks;
            let own_timeout = Value::from(self.timeout_ms);
            let timeout_ms = positive_or(coalesce(request.get("timeoutMs"), Some(&own_timeout)), self.timeout_ms);
            let scope = AbortScope::new(timeout_ms as f64, hooks.signal.as_ref());
            let outcome = self.answer(&request, &scope.signal()).await;
            outcome.map_err(|error| {
                if scope.timed_out() {
                    return LlmError::timeout(timeout_ms as f64);
                }
                if error.is_llm_error() {
                    return error;
                }
                LlmError::llm("FakeLLM завершился ошибкой", "FAKE_LLM_ERROR").with_cause(error)
            })
        })
    }

    /// У `FakeLLM` в JS нет `probe`.
    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(Value::Array(Vec::new())) })
    }

    /// У `FakeLLM` в JS нет `health`.
    fn health(&self) -> Value {
        Value::Array(Vec::new())
    }
}
