//! Перенос `server/llm-client.mjs`: клиент языковой модели.
//!
//! - строгий разбор JSON ответа ([`strict_json_parse`]) — без восстановления
//!   из markdown и прозы, с проверкой опасных ключей и размера;
//! - проверка вызовов инструментов ([`validate_tool_calls`]) и формы
//!   `json_schema` ([`usable_json_schema`]);
//! - разбор потока SSE ([`parse_router_ai_event_stream`]) с пределами размера
//!   события и всего ответа;
//! - провайдер по базовому адресу ([`llm_provider_for`]) и форма тела запроса
//!   ([`provider_request_body`]);
//! - [`RouterAiClient`] — OpenAI-совместимый клиент RouterAI/OhMyLama
//!   (таймауты, отмена, usage), [`FallbackLlmClient`] — каскад запасных
//!   моделей, [`FakeLlm`] — заглушка для тестов;
//! - ошибки [`LlmError`] с теми же классами, кодами и текстами, что в JS.
//!
//! Роли агентов зависят от трейта [`LlmModelClient`], а не от RouterAI.
//!
//! Форма данных — как в JS: запрос — JSON (`{ messages, temperature, … }` или
//! массив сообщений), ответ — JSON-объект `{ role, content, tool_calls, json?,
//! model, usage, provider, … }`. То, что в JS было функциями внутри запроса
//! (`signal`, `onDelta`, `validateResponse`), здесь лежит в [`CallOptions`].
//!
//! Контекст кампании (`campaign-ai-context`) клиент читает в синхронной части
//! вызова `complete` — до первого опроса future; каскад переносит его в вызовы
//! запасных моделей. Так поведение совпадает с `AsyncLocalStorage` JS, пока
//! вызывающий открывает контекст вокруг вызова.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, text};

use crate::js_json::{self, Js, JS_STACK_DEPTH};

mod abort;
mod fake;
mod fallback;
mod router_ai;
mod sse;

#[cfg(test)]
mod test_server;
#[cfg(test)]
mod tests;

pub use abort::{AbortController, AbortSignal};
pub use fake::{FakeHandler, FakeLlm, FakeLlmConfig, FakeReply};
pub use fallback::{FallbackLlmClient, FallbackLlmClientConfig};
pub use router_ai::{RouterAiClient, RouterAiClientConfig};
pub use sse::{parse_router_ai_event_stream, ChunkSource, StreamOptions, StreamResult, VecChunks};

/// `DEFAULT_TIMEOUT_MS`.
pub const DEFAULT_TIMEOUT_MS: i64 = 45_000;
/// `DEFAULT_MAX_TOOL_CALLS`.
pub const DEFAULT_MAX_TOOL_CALLS: i64 = 8;
/// `DEFAULT_MAX_RESPONSE_BYTES`.
pub const DEFAULT_MAX_RESPONSE_BYTES: i64 = 2_000_000;
/// `ROUTERAI_STREAM_MAX_EVENT_BYTES`.
pub const ROUTERAI_STREAM_MAX_EVENT_BYTES: i64 = 64 * 1024;
const DANGEROUS_JSON_KEYS: [&str; 3] = ["__proto__", "prototype", "constructor"];

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/// Класс ошибки JS. `instanceof` в JS: `LLMToolCallLimitError` —
/// подкласс `LLMResponseError`, оба и `LLMTimeoutError` — подклассы `LLMError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmErrorKind {
    /// `LLMError`.
    Llm,
    /// `LLMTimeoutError`.
    Timeout,
    /// `LLMResponseError`.
    Response,
    /// `LLMToolCallLimitError`.
    ToolCallLimit,
    /// `TypeError`: неверный вызов клиента, не ошибка модели.
    Type,
    /// `RangeError`.
    Range,
    /// Прочие ошибки (`Error`, `AbortError`, сбой сети): имя — в `name`.
    Other,
}

/// Ошибка клиента модели: класс, `name`, `code`, текст и поля `details`
/// (`timeoutMs`, `status`, `toolName`, `attempts`, …) — как у объекта ошибки JS.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmError {
    pub kind: LlmErrorKind,
    /// `error.name`.
    pub name: String,
    /// `error.code`; у `TypeError`/`RangeError` — `None`.
    pub code: Option<String>,
    pub message: String,
    /// Поля, которые JS кладёт в ошибку `Object.assign(this, details)`, кроме
    /// `cause`.
    pub details: Map<String, Value>,
    /// `error.cause`.
    pub cause: Option<Box<LlmError>>,
    /// `error.providerUsage`: известный расход оплаченного, но негодного ответа.
    pub provider_usage: Option<Value>,
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LlmError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}

impl LlmError {
    fn with_kind(kind: LlmErrorKind, name: &str, message: impl Into<String>, code: Option<&str>) -> Self {
        LlmError { kind, name: name.to_string(), code: code.map(str::to_string), message: message.into(), details: Map::new(), cause: None, provider_usage: None }
    }

    /// `new LLMError(message, code)`.
    pub fn llm(message: impl Into<String>, code: &str) -> Self {
        Self::with_kind(LlmErrorKind::Llm, "LLMError", message, Some(code))
    }

    /// `new LLMTimeoutError(timeoutMs)`.
    pub fn timeout(timeout_ms: f64) -> Self {
        Self::with_kind(LlmErrorKind::Timeout, "LLMTimeoutError", format!("LLM не ответил за {} мс", js::f64_string(timeout_ms)), Some("LLM_TIMEOUT"))
            .with_detail("timeoutMs", js::num(timeout_ms))
    }

    /// `new LLMResponseError(message)` — код `LLM_RESPONSE_INVALID`.
    pub fn response(message: impl Into<String>) -> Self {
        Self::response_with_code(message, "LLM_RESPONSE_INVALID")
    }

    /// `new LLMResponseError(message, code)`.
    pub fn response_with_code(message: impl Into<String>, code: &str) -> Self {
        Self::with_kind(LlmErrorKind::Response, "LLMResponseError", message, Some(code))
    }

    /// `new LLMToolCallLimitError(actual, maximum)`.
    pub fn tool_call_limit(actual: usize, maximum: i64) -> Self {
        Self::with_kind(LlmErrorKind::ToolCallLimit, "LLMToolCallLimitError", format!("Модель запросила {actual} инструментов при лимите {maximum}"), Some("LLM_TOOL_CALL_LIMIT"))
            .with_detail("actual", Value::from(actual as u64))
            .with_detail("maximum", Value::from(maximum))
    }

    /// `new TypeError(message)`.
    pub fn type_error(message: impl Into<String>) -> Self {
        Self::with_kind(LlmErrorKind::Type, "TypeError", message, None)
    }

    /// `new RangeError(message)`.
    pub fn range_error(message: impl Into<String>) -> Self {
        Self::with_kind(LlmErrorKind::Range, "RangeError", message, None)
    }

    /// Ошибка не из иерархии `LLMError` (`new Error(message)`, `AbortError`,
    /// сбой сети) с именем класса `name`.
    pub fn other(name: &str, message: impl Into<String>) -> Self {
        Self::with_kind(LlmErrorKind::Other, name, message, None)
    }

    /// Обычная ошибка JS с полем `code` (`Object.assign(new Error(…), { code })`).
    pub fn other_with_code(name: &str, message: impl Into<String>, code: &str) -> Self {
        Self::with_kind(LlmErrorKind::Other, name, message, Some(code))
    }

    /// Поле `details`.
    pub fn with_detail(mut self, key: &str, value: Value) -> Self {
        self.details.insert(key.to_string(), value);
        self
    }

    /// `details.cause`.
    pub fn with_cause(mut self, cause: LlmError) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    /// `error instanceof LLMError`.
    pub fn is_llm_error(&self) -> bool {
        matches!(self.kind, LlmErrorKind::Llm | LlmErrorKind::Timeout | LlmErrorKind::Response | LlmErrorKind::ToolCallLimit)
    }

    /// `error instanceof LLMResponseError`.
    pub fn is_response_error(&self) -> bool {
        matches!(self.kind, LlmErrorKind::Response | LlmErrorKind::ToolCallLimit)
    }

    /// `error instanceof LLMTimeoutError`.
    pub fn is_timeout(&self) -> bool {
        self.kind == LlmErrorKind::Timeout
    }

    /// Код ошибки или пустая строка (`String(error?.code ?? '')`).
    pub fn code_str(&self) -> &str {
        self.code.as_deref().unwrap_or("")
    }

    /// `error?.code ?? error?.name` — так ошибку называют журнал попыток и учёт.
    pub fn code_or_name(&self) -> String {
        self.code.clone().unwrap_or_else(|| self.name.clone())
    }

    /// `Number(error.status)`: HTTP-статус отказа провайдера (`NaN`, если нет).
    pub fn status(&self) -> f64 {
        js::number(self.details.get("status"))
    }

    /// Поле `details` по имени.
    pub fn detail(&self, key: &str) -> Option<&Value> {
        self.details.get(key)
    }

    /// Ошибка как JSON: `{ name, code?, message, …details, providerUsage? }`.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("name".into(), Value::String(self.name.clone()));
        if let Some(code) = &self.code {
            map.insert("code".into(), Value::String(code.clone()));
        }
        map.insert("message".into(), Value::String(self.message.clone()));
        for (key, value) in &self.details {
            map.insert(key.clone(), value.clone());
        }
        if let Some(usage) = &self.provider_usage {
            map.insert("providerUsage".into(), usage.clone());
        }
        Value::Object(map)
    }
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

/// `obj[key]` для JSON: поле объекта; у массива и примитива такого поля нет.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `value?.[0]`: элемент массива или поле `"0"` объекта.
fn index0(value: Option<&Value>) -> Option<&Value> {
    match value? {
        Value::Array(items) => items.first(),
        Value::Object(map) => map.get("0"),
        _ => None,
    }
}

/// `a ?? b` для полей JSON (`undefined` и `null` пропускаются).
fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second.filter(|value| !value.is_null()),
    }
}

/// `typeof value === 'object' && value !== null` (массивы — тоже).
fn is_js_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `{ ...value }` для объекта или массива (индексы — ключами), иначе `{}`.
pub(crate) fn spread_object(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Value::String(text) => text.encode_utf16().enumerate().map(|(index, unit)| (index.to_string(), Value::String(String::from_utf16_lossy(&[unit])))).collect(),
        _ => Map::new(),
    }
}

/// `text.slice(0, limit)` в единицах UTF-16 (половина суррогатной пары
/// отбрасывается — в строке Rust её не удержать).
pub(crate) fn utf16_head(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > limit {
            break;
        }
        out.push(ch);
    }
    out
}

/// `Number.isSafeInteger(number)` для `f64`.
fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `positiveInteger(value, fallback, label)` над числом `Number(value)`.
pub(crate) fn positive_integer_number(number: f64, fallback: Option<i64>, label: &str) -> Result<i64, LlmError> {
    if !is_safe_integer(number) || number <= 0.0 {
        return fallback.ok_or_else(|| LlmError::type_error(format!("{label} должен быть положительным целым числом")));
    }
    Ok(number as i64)
}

/// `positiveInteger(value, fallback, label)`: `Number(value)` — безопасное
/// целое больше нуля, иначе запас (или `TypeError`, если запаса нет).
pub(crate) fn positive_integer(value: Option<&Value>, fallback: Option<i64>, label: &str) -> Result<i64, LlmError> {
    positive_integer_number(js::number(value), fallback, label)
}

/// `positiveInteger(value, fallback)` с обязательным запасом.
pub(crate) fn positive_or(value: Option<&Value>, fallback: i64) -> i64 {
    positive_integer(value, Some(fallback), "").unwrap_or(fallback)
}

/// `optionalNumberInRange(value, minimum, maximum, label)`.
fn optional_number_in_range(value: Option<&Value>, minimum: f64, maximum: f64, label: &str) -> Result<Option<f64>, LlmError> {
    if !js::present(value) {
        return Ok(None);
    }
    let number = js::number(value);
    if !number.is_finite() || number < minimum || number > maximum {
        return Err(LlmError::range_error(format!("{label} должен быть числом от {} до {}", js::f64_string(minimum), js::f64_string(maximum))));
    }
    Ok(Some(number))
}

/// Задержка `setTimeout` в Node: вне `[1, 2^31 − 1]` (и `NaN`) — 1 мс.
pub(crate) fn node_timer_delay(milliseconds: f64) -> std::time::Duration {
    let milliseconds = if (1.0..=2_147_483_647.0).contains(&milliseconds) { milliseconds } else { 1.0 };
    std::time::Duration::from_secs_f64(milliseconds / 1000.0)
}

// ---------------------------------------------------------------------------
// Строгий JSON
// ---------------------------------------------------------------------------

/// Какое значение ждёт [`strict_json_parse`] (`expected`).
pub const EXPECTED_JSON_TYPES: [&str; 4] = ["object", "array", "object-or-array", "any"];

/// Вход [`strict_json_parse`]: строка разбирается, готовое значение
/// проверяется (`typeof input === 'string'` в JS).
#[derive(Debug, Clone, Copy)]
pub enum JsonInput<'a> {
    Text(&'a str),
    Value(&'a Value),
}

impl<'a> From<&'a str> for JsonInput<'a> {
    fn from(text: &'a str) -> Self {
        JsonInput::Text(text)
    }
}

impl<'a> From<&'a Value> for JsonInput<'a> {
    fn from(value: &'a Value) -> Self {
        match value {
            Value::String(text) => JsonInput::Text(text),
            other => JsonInput::Value(other),
        }
    }
}

/// Параметры [`strict_json_parse`]; `None` — значение по умолчанию JS.
#[derive(Debug, Clone, Default)]
pub struct StrictJsonOptions {
    /// `label` (по умолчанию `ответ LLM`).
    pub label: Option<String>,
    /// `expected`: строка из [`EXPECTED_JSON_TYPES`] или любое значение JSON
    /// (неизвестное — `TypeError`). По умолчанию `object-or-array`.
    pub expected: Option<Value>,
    /// `maxBytes` (по умолчанию 2 000 000); не безопасное положительное
    /// целое — `TypeError`.
    pub max_bytes: Option<Value>,
}

impl StrictJsonOptions {
    pub fn new(label: &str, expected: &str) -> Self {
        StrictJsonOptions { label: Some(label.to_string()), expected: Some(Value::String(expected.to_string())), max_bytes: None }
    }

    pub fn max_bytes(mut self, max_bytes: i64) -> Self {
        self.max_bytes = Some(Value::from(max_bytes));
        self
    }
}

fn stack_overflow() -> LlmError {
    LlmError::range_error("Maximum call stack size exceeded")
}

/// Дети узла для обхода `assertSafeJsonTree`: ключ (индекс массива — строкой)
/// и значение, в порядке `Object.keys`.
trait SafeNode: Sized {
    /// Отказ самого узла (не его детей) по пути `path`.
    fn own_fault(&self, path: &str) -> Option<LlmError>;
    fn children(&self) -> Vec<(String, &Self)>;
}

impl SafeNode for Js {
    fn own_fault(&self, path: &str) -> Option<LlmError> {
        match self {
            Js::Number(number) if !number.is_finite() => Some(LlmError::response(format!("Недопустимое число в {path}"))),
            Js::TooDeep => Some(stack_overflow()),
            _ => None,
        }
    }

    fn children(&self) -> Vec<(String, &Self)> {
        match self {
            Js::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
            Js::Object(entries) => entries.iter().map(|(key, item)| (key.clone(), item)).collect(),
            _ => Vec::new(),
        }
    }
}

impl SafeNode for Value {
    fn own_fault(&self, _path: &str) -> Option<LlmError> {
        None
    }

    fn children(&self) -> Vec<(String, &Self)> {
        match self {
            Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
            Value::Object(map) => js::entries(map).into_iter().map(|(key, item)| (key.clone(), item)).collect(),
            _ => Vec::new(),
        }
    }
}

/// `assertSafeJsonTree(value)`: обход в глубину в порядке JS без рекурсии
/// Rust (глубина дерева — до предела стека V8). Узел глубже
/// [`JS_STACK_DEPTH`] — `RangeError`, как переполнение стека в JS.
fn assert_safe_json_tree<T: SafeNode>(root: &T) -> Result<(), LlmError> {
    let mut path = String::from("$");
    if let Some(fault) = root.own_fault(&path) {
        return Err(fault);
    }
    // Кадр: дети узла, следующий ребёнок, длина пути самого узла.
    let mut stack: Vec<(Vec<(String, &T)>, usize, usize)> = vec![(root.children(), 0, path.len())];
    while let Some((children, next, base)) = stack.last_mut() {
        let Some((key, child)) = children.get(*next) else {
            stack.pop();
            continue;
        };
        *next += 1;
        let (key, child) = (key.clone(), *child);
        let base = *base;
        path.truncate(base);
        if DANGEROUS_JSON_KEYS.contains(&key.as_str()) {
            return Err(LlmError::response(format!("Запрещённое JSON-поле {path}.{key}")));
        }
        path.push('.');
        path.push_str(&key);
        if stack.len() + 1 > JS_STACK_DEPTH {
            return Err(stack_overflow());
        }
        if let Some(fault) = child.own_fault(&path) {
            return Err(fault);
        }
        let grandchildren = child.children();
        if !grandchildren.is_empty() {
            let length = path.len();
            stack.push((grandchildren, 0, length));
        }
    }
    Ok(())
}


/// `strictJsonParse(input, { label, expected, maxBytes })`: `JSON.parse` без
/// восстановления из markdown и прозы. Принимается только полное значение
/// JSON; опасные ключи (`__proto__`, `prototype`, `constructor`), бесконечные
/// числа и лишний размер — отказ `LLMResponseError`.
pub fn strict_json_parse<'a>(input: impl Into<JsonInput<'a>>, options: &StrictJsonOptions) -> Result<Value, LlmError> {
    let input = input.into();
    let label = options.label.as_deref().unwrap_or("ответ LLM");
    let expected = match &options.expected {
        None => "object-or-array",
        Some(Value::String(name)) if EXPECTED_JSON_TYPES.contains(&name.as_str()) => name.as_str(),
        Some(other) => return Err(LlmError::type_error(format!("Неизвестный expected JSON type: {}", js::string(Some(other))))),
    };
    let max_bytes = match &options.max_bytes {
        None => DEFAULT_MAX_RESPONSE_BYTES,
        Some(Value::Number(number)) if number.as_f64().is_some_and(|value| is_safe_integer(value) && value >= 1.0) => number.as_f64().unwrap_or(0.0) as i64,
        Some(_) => return Err(LlmError::type_error("maxBytes должен быть положительным целым числом")),
    };
    let too_large = || LlmError::response_with_code(format!("{label}: JSON превышает лимит {max_bytes} байт"), "LLM_RESPONSE_TOO_LARGE");
    let (is_array, is_object) = match input {
        JsonInput::Text(raw) => {
            let source = text::trim(raw);
            if source.is_empty() {
                return Err(LlmError::response(format!("{label}: пустой JSON")));
            }
            if source.len() as i64 > max_bytes {
                return Err(too_large());
            }
            if source.starts_with("```") {
                return Err(LlmError::response(format!("{label}: markdown-обёртка запрещена")));
            }
            let parsed = js_json::parse(source).map_err(|error| {
                LlmError::response_with_code(format!("{label}: некорректный JSON"), "LLM_JSON_INVALID").with_cause(LlmError::other("SyntaxError", error.0))
            })?;
            check_expected(label, expected, matches!(parsed, Js::Array(_)), matches!(parsed, Js::Object(_)))?;
            assert_safe_json_tree(&parsed)?;
            return Ok(parsed.into_value());
        }
        JsonInput::Value(value) => (value.is_array(), value.is_object()),
    };
    let JsonInput::Value(value) = input else { unreachable!("строка разобрана выше") };
    check_expected(label, expected, is_array, is_object)?;
    assert_safe_json_tree(value)?;
    if sk_narration_base::jsx::stringify(value).len() as i64 > max_bytes {
        return Err(too_large());
    }
    Ok(value.clone())
}

fn check_expected(label: &str, expected: &str, is_array: bool, is_object: bool) -> Result<(), LlmError> {
    if expected == "object" && !is_object {
        return Err(LlmError::response(format!("{label}: ожидался JSON-объект")));
    }
    if expected == "array" && !is_array {
        return Err(LlmError::response(format!("{label}: ожидался JSON-массив")));
    }
    if expected == "object-or-array" && !is_object && !is_array {
        return Err(LlmError::response(format!("{label}: ожидался объект или массив")));
    }
    Ok(())
}

/// `parseStrictJson` — прежнее имя [`strict_json_parse`].
pub use self::strict_json_parse as parse_strict_json;

// ---------------------------------------------------------------------------
// Запрос
// ---------------------------------------------------------------------------

/// Будущий результат вызова модели.
pub type LlmFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, LlmError>> + Send + 'a>>;
/// Будущий результат обработчика (`onDelta`, `validateResponse`, ответ `FakeLLM`).
pub type HookFuture<T> = Pin<Box<dyn Future<Output = Result<T, LlmError>> + Send + 'static>>;

/// `onDelta(delta)`: получатель кусков потокового ответа. Ошибка обработчика
/// обрывает поток (не `LLMError` — как `LLM_STREAM_INVALID`).
#[derive(Clone)]
pub struct DeltaHandler(Arc<dyn Fn(String) -> HookFuture<()> + Send + Sync>);

impl DeltaHandler {
    pub fn new<F, Fut>(handler: F) -> Self
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), LlmError>> + Send + 'static,
    {
        DeltaHandler(Arc::new(move |delta| Box::pin(handler(delta))))
    }

    /// Синхронный обработчик.
    pub fn sync(handler: impl Fn(&str) -> Result<(), LlmError> + Send + Sync + 'static) -> Self {
        DeltaHandler(Arc::new(move |delta: String| {
            let result = handler(&delta);
            Box::pin(async move { result })
        }))
    }

    pub async fn call(&self, delta: String) -> Result<(), LlmError> {
        (self.0)(delta).await
    }
}

impl std::fmt::Debug for DeltaHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DeltaHandler")
    }
}

/// `validateResponse(result)`: `false` — ответ модели негоден, каскад идёт
/// к следующей модели.
#[derive(Clone)]
pub struct ResponseValidator(Arc<dyn Fn(Value) -> HookFuture<bool> + Send + Sync>);

impl ResponseValidator {
    pub fn new<F, Fut>(validator: F) -> Self
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<bool, LlmError>> + Send + 'static,
    {
        ResponseValidator(Arc::new(move |value| Box::pin(validator(value))))
    }

    /// Синхронная проверка.
    pub fn sync(validator: impl Fn(&Value) -> bool + Send + Sync + 'static) -> Self {
        ResponseValidator(Arc::new(move |value: Value| {
            let result = validator(&value);
            Box::pin(async move { Ok(result) })
        }))
    }

    pub async fn call(&self, value: Value) -> Result<bool, LlmError> {
        (self.0)(value).await
    }
}

impl std::fmt::Debug for ResponseValidator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ResponseValidator")
    }
}

/// Второй аргумент `complete(input, options)`: поля JSON (`timeoutMs`,
/// `json`, `model`, …) и то, что в JS было функциями и сигналом.
#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    /// Поля JSON; при слиянии с запросом перекрывают его (`{ ...input, ...options }`).
    pub fields: Map<String, Value>,
    /// `signal`: внешняя отмена.
    pub signal: Option<AbortSignal>,
    /// `onDelta`: потоковый ответ.
    pub on_delta: Option<DeltaHandler>,
    /// `validateResponse`.
    pub validate_response: Option<ResponseValidator>,
}

impl CallOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Поля из JSON-объекта (иное — пусто).
    pub fn from_fields(fields: Value) -> Self {
        CallOptions { fields: fields.as_object().cloned().unwrap_or_default(), ..Self::default() }
    }

    /// Поле JSON (перекрывает прежнее на его месте).
    pub fn field(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.fields.insert(key.to_string(), value.into());
        self
    }

    pub fn signal(mut self, signal: AbortSignal) -> Self {
        self.signal = Some(signal);
        self
    }

    pub fn on_delta(mut self, handler: DeltaHandler) -> Self {
        self.on_delta = Some(handler);
        self
    }

    pub fn validate_response(mut self, validator: ResponseValidator) -> Self {
        self.validate_response = Some(validator);
        self
    }
}

/// `normalizeRequest(input, options)`: запрос с непустым `messages`, у
/// каждого сообщения — строковая `role`.
pub(crate) fn normalize_request(input: &Value, fields: &Map<String, Value>) -> Result<Map<String, Value>, LlmError> {
    let mut request = match input {
        Value::Array(messages) => {
            let mut request = fields.clone();
            request.insert("messages".into(), Value::Array(messages.clone()));
            request
        }
        Value::Object(map) => {
            let mut request = map.clone();
            for (key, value) in fields {
                request.insert(key.clone(), value.clone());
            }
            request
        }
        _ => fields.clone(),
    };
    let messages = match request.get("messages") {
        Some(Value::Array(messages)) if !messages.is_empty() => messages.clone(),
        _ => return Err(LlmError::type_error("LLM-запрос должен содержать непустой массив messages")),
    };
    let mut normalized = Vec::with_capacity(messages.len());
    for message in messages {
        let role = message.get("role");
        let role_text = if js::truthy(role) { js::s(role) } else { String::new() };
        let Value::Object(mut map) = message else {
            return Err(LlmError::type_error("Каждое LLM-сообщение должно иметь role"));
        };
        if text::trim(&role_text).is_empty() {
            return Err(LlmError::type_error("Каждое LLM-сообщение должно иметь role"));
        }
        map.insert("role".into(), Value::String(role_text));
        normalized.push(Value::Object(map));
    }
    request.insert("messages".into(), Value::Array(normalized));
    Ok(request)
}

/// Имена инструментов запроса: `tools[].function.name ?? tools[].name` и
/// явный `allowedToolNames`.
fn tool_names(tools: Option<&Value>, explicit: Option<&Value>) -> IndexSet<String> {
    let mut names = IndexSet::new();
    if let Some(Value::Array(tools)) = tools {
        for tool in tools {
            let name = coalesce(prop(prop(Some(tool), "function"), "name"), prop(Some(tool), "name"));
            if js::truthy(name) {
                names.insert(js::s(name));
            }
        }
    }
    if let Some(Value::Array(explicit)) = explicit {
        for name in explicit {
            names.insert(js::string(Some(name)));
        }
    }
    names
}

/// `usableJsonSchema(value)`: `{ name, strict, schema }`, если имя по правилам
/// OpenAI-совместимого API и в корне объектная схема; иначе `None` (клиент
/// останется на `json_object`).
pub fn usable_json_schema(value: Option<&Value>) -> Option<Value> {
    let map = value?.as_object()?;
    let name = map.get("name")?.as_str()?;
    if name.is_empty() || name.len() > 64 || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
        return None;
    }
    let schema = map.get("schema")?;
    if !schema.is_object() || schema.get("type").and_then(Value::as_str) != Some("object") {
        return None;
    }
    let mut result = Map::new();
    result.insert("name".into(), Value::String(name.to_string()));
    result.insert("strict".into(), Value::Bool(!js::is_false(map.get("strict"))));
    result.insert("schema".into(), schema.clone());
    Some(Value::Object(result))
}

/// `wantsJson(request)`.
fn wants_json(request: &Map<String, Value>) -> bool {
    js::is_true(request.get("json"))
        || js::is_true(request.get("expectJson"))
        || matches!(request.get("responseFormat").and_then(Value::as_str), Some("json" | "json_object"))
}

fn is_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty() && bytes.len() <= 80 && bytes[0].is_ascii_alphabetic() && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// `validateToolCalls(toolCalls, { allowedToolNames, maxToolCalls })`:
/// вызовы инструментов модели — массив не длиннее предела, имя по правилам и
/// из списка разрешённых, аргументы — строгий JSON-объект. Возвращает
/// `{ id, type: 'function', function: { name, arguments }, arguments }`.
pub fn validate_tool_calls(tool_calls: Option<&Value>, allowed_tool_names: &[String], max_tool_calls: Option<&Value>) -> Result<Vec<Value>, LlmError> {
    let allowed: IndexSet<String> = allowed_tool_names.iter().cloned().collect();
    validate_tool_calls_with(tool_calls, &allowed, max_tool_calls)
}

fn validate_tool_calls_with(tool_calls: Option<&Value>, allowed: &IndexSet<String>, max_tool_calls: Option<&Value>) -> Result<Vec<Value>, LlmError> {
    let calls: &[Value] = match tool_calls {
        None | Some(Value::Null) => &[],
        Some(Value::Array(calls)) => calls,
        Some(_) => return Err(LlmError::response_with_code("tool_calls должен быть массивом", "LLM_TOOL_CALL_INVALID")),
    };
    let maximum = positive_or(max_tool_calls.or(Some(&Value::from(DEFAULT_MAX_TOOL_CALLS))), DEFAULT_MAX_TOOL_CALLS);
    if calls.len() as i64 > maximum {
        return Err(LlmError::tool_call_limit(calls.len(), maximum));
    }
    let mut result = Vec::with_capacity(calls.len());
    for (index, call) in calls.iter().enumerate() {
        let call_type = call.get("type");
        if !is_js_object(Some(call)) || (js::truthy(call_type) && call_type.and_then(Value::as_str) != Some("function")) {
            return Err(LlmError::response_with_code(format!("Tool call {index} имеет недопустимый формат"), "LLM_TOOL_CALL_INVALID"));
        }
        let function = prop(Some(call), "function");
        let name = js::s(coalesce(prop(function, "name"), prop(Some(call), "name")));
        if !is_tool_name(&name) {
            return Err(LlmError::response_with_code(format!("Tool call {index}: недопустимое имя"), "LLM_TOOL_NAME_INVALID"));
        }
        if !allowed.contains(&name) {
            return Err(LlmError::response_with_code(format!("Инструмент {name} не входит в allowlist"), "LLM_TOOL_NOT_ALLOWED").with_detail("toolName", Value::String(name)));
        }
        let default_arguments = Value::String("{}".into());
        let raw_arguments = coalesce(prop(function, "arguments"), prop(Some(call), "arguments")).unwrap_or(&default_arguments);
        let arguments = strict_json_parse(raw_arguments, &StrictJsonOptions::new(&format!("аргументы {name}"), "object"))?;
        let id = call.get("id");
        let id = if js::truthy(id) { js::s(id) } else { format!("tool-call-{}", index + 1) };
        let mut function_out = Map::new();
        function_out.insert("name".into(), Value::String(name));
        function_out.insert(
            "arguments".into(),
            Value::String(match raw_arguments {
                Value::String(text) => text.clone(),
                other => sk_narration_base::jsx::stringify(other),
            }),
        );
        let mut normalized = Map::new();
        normalized.insert("id".into(), Value::String(id));
        normalized.insert("type".into(), Value::String("function".into()));
        normalized.insert("function".into(), Value::Object(function_out));
        normalized.insert("arguments".into(), arguments);
        result.push(Value::Object(normalized));
    }
    Ok(result)
}

/// `normalizeAssistantMessage(message, request, defaults)`: ответ модели —
/// `{ role: 'assistant', content, tool_calls, json? }`.
pub(crate) fn normalize_assistant_message(message: Option<&Value>, request: &Map<String, Value>, default_max_tool_calls: i64) -> Result<Map<String, Value>, LlmError> {
    let Some(message) = message.filter(|message| is_js_object(Some(message))) else {
        return Err(LlmError::response("LLM не вернул assistant message"));
    };
    let role = message.get("role");
    if js::truthy(role) && role.and_then(Value::as_str) != Some("assistant") {
        return Err(LlmError::response("LLM вернул сообщение с неверной ролью"));
    }
    let allowed = tool_names(request.get("tools"), request.get("allowedToolNames"));
    let default_max = Value::from(default_max_tool_calls);
    let tool_calls = validate_tool_calls_with(coalesce(message.get("tool_calls"), message.get("toolCalls")), &allowed, Some(coalesce(request.get("maxToolCalls"), Some(&default_max)).unwrap_or(&default_max)))?;
    let content = match message.get("content") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => sk_narration_base::jsx::stringify(other),
    };
    let mut normalized = Map::new();
    normalized.insert("role".into(), Value::String("assistant".into()));
    normalized.insert("content".into(), Value::String(content.clone()));
    normalized.insert("tool_calls".into(), Value::Array(tool_calls.clone()));
    if text::trim(&content).is_empty() && tool_calls.is_empty() {
        return Err(LlmError::response("LLM returned an empty assistant response"));
    }
    if wants_json(request) {
        let expected = coalesce(request.get("jsonExpected"), None).cloned().unwrap_or_else(|| Value::String("object".into()));
        let options = StrictJsonOptions { label: Some("JSON content".into()), expected: Some(expected.clone()), max_bytes: None };
        let json = strict_json_parse(content.as_str(), &options)?;
        if expected.as_str() == Some("object") && json.as_object().is_some_and(Map::is_empty) {
            return Err(LlmError::response("LLM вернул пустой объект вместо результата роли"));
        }
        normalized.insert("json".into(), json);
    }
    Ok(normalized)
}

/// `normalizeWithKnownUsage(usage, normalize)`: известный `usage` оплаченного
/// ответа прикладывается к ошибке нормализации (`providerUsage`).
pub(crate) fn with_known_usage<T>(usage: Option<&Value>, result: Result<T, LlmError>) -> Result<T, LlmError> {
    result.map_err(|mut error| {
        if error.is_llm_error() {
            if let Some(usage @ Value::Object(_)) = usage {
                error.provider_usage = Some(usage.clone());
            }
        }
        error
    })
}

// ---------------------------------------------------------------------------
// Провайдер
// ---------------------------------------------------------------------------

/// `llmProviderFor(baseUrl)`: `ohmylama` для хоста `ohmylama.ru` (и его
/// поддоменов), иначе `routerai`.
pub fn llm_provider_for(base_url: &str) -> &'static str {
    match reqwest::Url::parse(base_url) {
        Ok(url) => {
            let host = text::lower(url.host_str().unwrap_or(""));
            if host == "ohmylama.ru" || host.ends_with(".ohmylama.ru") {
                "ohmylama"
            } else {
                "routerai"
            }
        }
        Err(_) => "routerai",
    }
}

const VENDOR_MODEL_PREFIXES: [&str; 10] = ["openai/", "anthropic/", "google/", "z-ai/", "deepseek/", "meta/", "x-ai/", "mistralai/", "qwen/", "moonshotai/"];

/// `providerRequestBody(provider, body)`: имя модели и параметры рассуждений в
/// формате провайдера. Для RouterAI тело уходит как есть.
pub fn provider_request_body(provider: &str, body: &Value) -> Value {
    if provider != "ohmylama" {
        return body.clone();
    }
    let mut rest = spread_object(body);
    let reasoning = rest.shift_remove("reasoning");
    let effort = match reasoning.as_ref().and_then(|reasoning| if is_js_object(Some(reasoning)) { reasoning.get("effort") } else { None }) {
        Some(Value::String(effort)) => effort.clone(),
        _ => String::new(),
    };
    let full = js::s(body.get("model"));
    let model = VENDOR_MODEL_PREFIXES.iter().find_map(|prefix| full.strip_prefix(prefix)).unwrap_or(&full).to_string();
    // Claude у OhMyLama отклоняет temperature и штрафы повторов (HTTP 400
    // unsupported_parameter, проба 2026-10-11); RouterAI их молча пропускал.
    if model.starts_with("claude-") {
        rest.shift_remove("temperature");
        rest.shift_remove("frequency_penalty");
        rest.shift_remove("presence_penalty");
    }
    // Gemini у OhMyLama: штрафы повторов — HTTP 400, strict json_schema — 503
    // при каждом вызове (проба 2026-10-11). JSON mode она исполняет.
    if model.starts_with("gemini-") {
        rest.shift_remove("frequency_penalty");
        rest.shift_remove("presence_penalty");
        if prop(rest.get("response_format"), "type").and_then(Value::as_str) == Some("json_schema") {
            let mut format = Map::new();
            format.insert("type".into(), Value::String("json_object".into()));
            rest.insert("response_format".into(), Value::Object(format));
        }
    }
    rest.insert("model".into(), Value::String(model));
    if ["low", "medium", "high"].contains(&effort.as_str()) {
        rest.insert("reasoning_effort".into(), Value::String(effort));
    }
    Value::Object(rest)
}

// ---------------------------------------------------------------------------
// Контракт клиента модели
// ---------------------------------------------------------------------------

/// Состояние модели в каскаде (`health()`), как его видит `/api/admin/usage`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelHealth {
    pub model: String,
    pub primary: bool,
    /// `ready`, `unknown`, `cooldown`, `retry-ready`.
    pub state: String,
    pub failures: i64,
    pub last_error_code: Option<String>,
    #[serde(serialize_with = "sk_narration_base::jsx::serialize_js_number")]
    pub retry_after_ms: f64,
}

/// Клиент модели, от которого зависят роли агентов (`LLMClient` в JS).
///
/// `complete` возвращает ответ JSON-объектом той же формы, что в JS. Контекст
/// кампании реализация читает в синхронной части вызова (до первого опроса
/// future), как [`RouterAiClient`] и [`FallbackLlmClient`].
pub trait LlmModelClient: Send + Sync {
    /// `client.model` (`undefined` — `None`).
    fn model(&self) -> Option<String> {
        None
    }

    /// `client.timeoutMs`: лимит горячего пути модели для каскада.
    fn timeout_ms(&self) -> Option<f64> {
        None
    }

    /// `client.maxTokens`.
    fn max_tokens(&self) -> Option<i64> {
        None
    }

    /// `complete(input, options)`: `input` — `{ messages, … }` или массив
    /// сообщений.
    fn complete(&self, input: Value, options: CallOptions) -> LlmFuture<'_, Value>;

    /// `completeJson(input, options)`: `complete` с `json: true`, результат —
    /// поле `json` (`None`, если клиент его не вернул).
    fn complete_json(&self, input: Value, options: CallOptions) -> LlmFuture<'_, Option<Value>> {
        let operation = self.complete(input, options.field("json", true));
        Box::pin(async move { Ok(operation.await?.get("json").cloned()) })
    }

    /// Текст ответа (`String(result.content ?? '')`).
    fn complete_text(&self, input: Value, options: CallOptions) -> LlmFuture<'_, String> {
        let operation = self.complete(input, options);
        Box::pin(async move { Ok(js::s(operation.await?.get("content"))) })
    }

    /// Потоковый ответ: `complete` с `onDelta`.
    fn complete_streaming(&self, input: Value, options: CallOptions, on_delta: DeltaHandler) -> LlmFuture<'_, Value> {
        self.complete(input, options.on_delta(on_delta))
    }

    /// `probe()`: проверка моделей; по умолчанию — текущее состояние.
    fn probe(&self) -> LlmFuture<'_, Vec<ModelHealth>> {
        let health = self.health();
        Box::pin(async move { Ok(health) })
    }

    /// `health()`.
    fn health(&self) -> Vec<ModelHealth> {
        Vec::new()
    }
}

impl<T: LlmModelClient + ?Sized> LlmModelClient for Arc<T> {
    fn model(&self) -> Option<String> {
        (**self).model()
    }
    fn timeout_ms(&self) -> Option<f64> {
        (**self).timeout_ms()
    }
    fn max_tokens(&self) -> Option<i64> {
        (**self).max_tokens()
    }
    fn complete(&self, input: Value, options: CallOptions) -> LlmFuture<'_, Value> {
        (**self).complete(input, options)
    }
    fn complete_json(&self, input: Value, options: CallOptions) -> LlmFuture<'_, Option<Value>> {
        (**self).complete_json(input, options)
    }
    fn complete_text(&self, input: Value, options: CallOptions) -> LlmFuture<'_, String> {
        (**self).complete_text(input, options)
    }
    fn complete_streaming(&self, input: Value, options: CallOptions, on_delta: DeltaHandler) -> LlmFuture<'_, Value> {
        (**self).complete_streaming(input, options, on_delta)
    }
    fn probe(&self) -> LlmFuture<'_, Vec<ModelHealth>> {
        (**self).probe()
    }
    fn health(&self) -> Vec<ModelHealth> {
        (**self).health()
    }
}

/// Снимок контекста кампании для переноса в вызовы, идущие после `await`.
#[derive(Debug, Clone)]
pub(crate) struct CampaignSnapshot(Option<Value>);

impl CampaignSnapshot {
    pub(crate) fn capture() -> Self {
        CampaignSnapshot(sk_narration_base::campaign_ai_context::current_campaign_ai_settings().and_then(|settings| serde_json::to_value(settings).ok()))
    }

    /// Выполнить синхронную часть вызова внутри снятого контекста.
    pub(crate) fn enter<R>(&self, operation: impl FnOnce() -> R) -> R {
        sk_narration_base::campaign_ai_context::run_with_campaign_ai_settings(self.0.as_ref(), operation)
    }
}

/// Псевдонимы JS: `RouterAIAdapter`, `RouterAILLMClient`, `FakeLLMClient`.
pub type RouterAiAdapter = RouterAiClient;
pub type RouterAiLlmClient = RouterAiClient;
pub type FakeLlmClient = FakeLlm;
