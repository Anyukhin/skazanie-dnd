//! `parseRouterAIEventStream` из `server/llm-client.mjs`: строгий
//! ограниченный разбор SSE-потока OpenAI-совместимого провайдера. Сырые
//! дельты провайдера не покидают адаптер: наружу уходит только текст.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};
use sk_core::{js, text};

use super::{index0, positive_or, prop, strict_json_parse, utf16_head, DeltaHandler, LlmError, StrictJsonOptions, DEFAULT_MAX_RESPONSE_BYTES, ROUTERAI_STREAM_MAX_EVENT_BYTES};

/// Источник кусков тела ответа (`response.body` в JS).
pub trait ChunkSource: Send {
    /// Следующий кусок; `None` — тело кончилось, `Err` — обрыв чтения.
    fn next_chunk(&mut self) -> Pin<Box<dyn Future<Output = Option<Result<Vec<u8>, LlmError>>> + Send + '_>>;
}

/// Тело из готовых кусков; `fail_with` — ошибка чтения после последнего куска
/// (обрыв соединения).
#[derive(Debug, Clone, Default)]
pub struct VecChunks {
    chunks: VecDeque<Vec<u8>>,
    fail_with: Option<LlmError>,
}

impl VecChunks {
    pub fn new<I, C>(chunks: I) -> Self
    where
        I: IntoIterator<Item = C>,
        C: Into<Vec<u8>>,
    {
        VecChunks { chunks: chunks.into_iter().map(Into::into).collect(), fail_with: None }
    }

    /// После кусков чтение обрывается этой ошибкой.
    pub fn then_fail(mut self, error: LlmError) -> Self {
        self.fail_with = Some(error);
        self
    }
}

impl ChunkSource for VecChunks {
    fn next_chunk(&mut self) -> Pin<Box<dyn Future<Output = Option<Result<Vec<u8>, LlmError>>> + Send + '_>> {
        let next = match self.chunks.pop_front() {
            Some(chunk) => Some(Ok(chunk)),
            None => self.fail_with.take().map(Err),
        };
        Box::pin(async move { next })
    }
}

/// Параметры разбора потока.
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    /// `onDelta`.
    pub on_delta: Option<DeltaHandler>,
    /// `maxEventBytes` (по умолчанию 64 КиБ; негодное значение — умолчание).
    pub max_event_bytes: Option<Value>,
    /// `maxResponseBytes` (по умолчанию 2 000 000).
    pub max_response_bytes: Option<Value>,
}

/// `{ content, model, usage, done }`.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamResult {
    pub content: String,
    /// `String(payload.model)` последнего события с моделью.
    pub model: Option<String>,
    /// `payload.usage` последнего события с расходом (`null` — `None`).
    pub usage: Option<Value>,
    pub done: bool,
}

impl StreamResult {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("content".into(), Value::String(self.content.clone()));
        map.insert("model".into(), self.model.clone().map_or(Value::Null, Value::String));
        map.insert("usage".into(), self.usage.clone().unwrap_or(Value::Null));
        map.insert("done".into(), Value::Bool(self.done));
        Value::Object(map)
    }
}

fn too_large(limit: i64) -> LlmError {
    LlmError::response_with_code(format!("RouterAI stream exceeds {limit} bytes"), "LLM_RESPONSE_TOO_LARGE")
}

fn event_too_large(limit: i64) -> LlmError {
    LlmError::response_with_code(format!("RouterAI SSE event exceeds {limit} bytes"), "LLM_RESPONSE_TOO_LARGE")
}

/// `/\r?\n\r?\n/u.exec(value)`: начало и длина первого разделителя кадров.
fn frame_separator(value: &str) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    let at = |index: usize| bytes.get(index).copied();
    for index in 0..bytes.len() {
        let mut position = index;
        if at(position) == Some(b'\r') && at(position + 1) == Some(b'\n') {
            // Жадный `\r?`: сначала с `\r`, затем без него.
            if at(position + 2) == Some(b'\r') && at(position + 3) == Some(b'\n') {
                return Some((index, 4));
            }
            if at(position + 2) == Some(b'\n') {
                return Some((index, 3));
            }
            continue;
        }
        if at(position) == Some(b'\n') {
            position += 1;
            if at(position) == Some(b'\r') && at(position + 1) == Some(b'\n') {
                return Some((index, 3));
            }
            if at(position) == Some(b'\n') {
                return Some((index, 2));
            }
        }
    }
    None
}

/// `.length` значения JS как истинность: непустые массив и строка, у объекта —
/// поле `length`.
fn length_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(map)) => js::truthy(map.get("length")),
        _ => false,
    }
}

/// `TextDecoder('utf-8', { fatal: true })` с `stream: true`: неполная
/// последовательность в конце куска ждёт следующего; BOM в начале потока
/// снимается один раз.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
    started: bool,
}

impl Utf8Stream {
    fn decode(&mut self, chunk: &[u8]) -> Result<String, LlmError> {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&data) {
            Ok(_) => data.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return Err(LlmError::type_error("The encoded data was not valid for encoding utf-8")),
        };
        self.pending = data.split_off(valid);
        let mut decoded = String::from_utf8(data).map_err(|_| LlmError::type_error("The encoded data was not valid for encoding utf-8"))?;
        if !self.started && !decoded.is_empty() {
            self.started = true;
            if decoded.starts_with('\u{FEFF}') {
                decoded.drain(..'\u{FEFF}'.len_utf8());
            }
        }
        Ok(decoded)
    }

    fn finish(&mut self) -> Result<String, LlmError> {
        if self.pending.is_empty() {
            Ok(String::new())
        } else {
            Err(LlmError::type_error("The encoded data was not valid for encoding utf-8"))
        }
    }
}

struct StreamState {
    content: String,
    model: Option<String>,
    usage: Option<Value>,
    done: bool,
    event_limit: i64,
    response_limit: i64,
    on_delta: Option<DeltaHandler>,
}

impl StreamState {
    async fn process_frame(&mut self, frame: &str) -> Result<(), LlmError> {
        let mut data_lines: Vec<&str> = Vec::new();
        for line in split_lines(frame) {
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if line == "data" {
                data_lines.push("");
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
            }
        }
        if data_lines.is_empty() {
            return Ok(());
        }
        let data = data_lines.join("\n");
        if text::trim(&data) == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let payload = strict_json_parse(data.as_str(), &StrictJsonOptions::new("RouterAI SSE event", "object").max_bytes(self.event_limit))?;
        if js::truthy(payload.get("error")) {
            let code = js::s(prop(payload.get("error"), "code"));
            return Err(LlmError::llm("RouterAI stream returned an error event", "LLM_PROVIDER_ERROR").with_detail("providerCode", Value::String(utf16_head(&code, 80))));
        }
        if js::present(payload.get("model")) {
            self.model = Some(js::s(payload.get("model")));
        }
        if js::present(payload.get("usage")) {
            self.usage = payload.get("usage").cloned();
        }
        let delta = prop(index0(payload.get("choices")), "delta");
        if length_truthy(prop(delta, "tool_calls")) || length_truthy(prop(delta, "toolCalls")) {
            return Err(LlmError::response_with_code("Streaming tool calls are not supported", "LLM_TOOL_CALL_INVALID"));
        }
        let content = match prop(delta, "content") {
            None | Some(Value::Null) => return Ok(()),
            Some(Value::String(content)) => content,
            Some(_) => return Err(LlmError::response("RouterAI stream returned non-text content")),
        };
        if content.is_empty() {
            return Ok(());
        }
        if (self.content.len() + content.len()) as i64 > self.response_limit {
            return Err(too_large(self.response_limit));
        }
        self.content.push_str(content);
        if let Some(handler) = &self.on_delta {
            handler.call(content.clone()).await?;
        }
        Ok(())
    }

    fn result(&self) -> StreamResult {
        StreamResult { content: self.content.clone(), model: self.model.clone(), usage: self.usage.clone(), done: self.done }
    }
}

/// `frame.split(/\r?\n/u)`.
fn split_lines(frame: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = frame.split('\n').collect();
    // `\r` перед `\n` входит в разделитель; у последней строки его нет.
    let last = lines.len().saturating_sub(1);
    for line in &mut lines[..last] {
        if let Some(stripped) = line.strip_suffix('\r') {
            *line = stripped;
        }
    }
    lines
}

/// `parseRouterAIEventStream(body, { onDelta, maxEventBytes, maxResponseBytes })`.
/// Тело `None` (у ответа нет тела) — `LLMResponseError`. Ошибка, не
/// относящаяся к `LLMError` (битый UTF-8, обрыв чтения, сбой `onDelta`), —
/// `LLM_STREAM_INVALID`.
pub async fn parse_router_ai_event_stream<S: ChunkSource>(body: Option<S>, options: StreamOptions) -> Result<StreamResult, LlmError> {
    let event_limit = positive_or(options.max_event_bytes.as_ref(), ROUTERAI_STREAM_MAX_EVENT_BYTES);
    let response_limit = positive_or(options.max_response_bytes.as_ref(), DEFAULT_MAX_RESPONSE_BYTES);
    let mut state = StreamState { content: String::new(), model: None, usage: None, done: false, event_limit, response_limit, on_delta: options.on_delta };
    let outcome = read_stream(body, &mut state).await;
    match outcome {
        Ok(result) => Ok(result),
        Err(error) if error.is_llm_error() => Err(error),
        Err(error) => Err(LlmError::response_with_code("RouterAI returned a malformed SSE stream", "LLM_STREAM_INVALID").with_cause(error)),
    }
}

async fn read_stream<S: ChunkSource>(body: Option<S>, state: &mut StreamState) -> Result<StreamResult, LlmError> {
    let Some(mut body) = body else {
        return Err(LlmError::response("RouterAI returned an empty streaming body"));
    };
    let mut decoder = Utf8Stream::default();
    let mut buffer = String::new();
    let mut received_bytes: i64 = 0;
    while let Some(chunk) = body.next_chunk().await {
        let bytes = chunk?;
        received_bytes += bytes.len() as i64;
        if received_bytes > state.response_limit {
            return Err(too_large(state.response_limit));
        }
        buffer.push_str(&decoder.decode(&bytes)?);
        while let Some((index, length)) = frame_separator(&buffer) {
            let frame = buffer[..index].to_string();
            buffer.drain(..index + length);
            if frame.len() as i64 > state.event_limit {
                return Err(event_too_large(state.event_limit));
            }
            state.process_frame(&frame).await?;
            if state.done {
                return Ok(state.result());
            }
        }
        if buffer.len() as i64 > state.event_limit {
            return Err(event_too_large(state.event_limit));
        }
    }
    buffer.push_str(&decoder.finish()?);
    if !text::trim(&buffer).is_empty() {
        if buffer.len() as i64 > state.event_limit {
            return Err(event_too_large(state.event_limit));
        }
        let frame = buffer.clone();
        state.process_frame(&frame).await?;
    }
    if !state.done {
        return Err(LlmError::response_with_code("RouterAI stream ended before [DONE]", "LLM_STREAM_INCOMPLETE"));
    }
    Ok(state.result())
}
