//! `RouterAIClient` из `server/llm-client.mjs`: OpenAI-совместимый провайдер
//! за `ROUTERAI_BASE_URL` (RouterAI по умолчанию, OhMyLama — по адресу).
//!
//! HTTP — `reqwest` на `rustls` с криптографией `ring`; сертификаты проверяет
//! системный верификатор (`rustls-platform-verifier`): на машине владельца
//! HTTPS перехватывает Kaspersky, его корень лежит в системном хранилище.
//! Прокси из окружения не используется — как у `fetch` в Node.
//!
//! Ключ не печатается: его нет ни в `Debug`, ни в текстах ошибок, заголовок
//! `Authorization` помечен чувствительным.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{Map, Value};
use sk_core::js;
use sk_narration_base::campaign_ai_context::campaign_reasoning_for;
use sk_narration_base::jsx;
use sk_narration_base::model_style_profiles::supports_json_schema;

use super::abort::{race, AbortScope};
use super::sse::{parse_router_ai_event_stream, ChunkSource, StreamOptions};
use super::{
    coalesce, index0, is_js_object, llm_provider_for, normalize_assistant_message, normalize_request, optional_number_in_range, positive_integer_number, positive_or, prop, provider_request_body, spread_object, strict_json_parse, usable_json_schema, wants_json,
    with_known_usage, CallHooks, CallScope, CampaignSnapshot, LlmClient, LlmError, LlmErrorExt, LlmFuture, StrictJsonOptions, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_TOOL_CALLS, DEFAULT_TIMEOUT_MS, ROUTERAI_STREAM_MAX_EVENT_BYTES,
};

/// Директива формата для GLM Flash без `response_format`.
const GLM_JSON_DIRECTIVE: &str = "Верни только полное JSON-значение, соответствующее запрошенной схеме. Без Markdown, кодовых блоков, вступления и пояснений.";
const GLM_FLASH: &str = "z-ai/glm-5.3-flash";

/// Параметры `new RouterAIClient({ … })`; `None` — значение по умолчанию JS
/// (для ключа, адреса, модели и `maxTokens` — из окружения).
#[derive(Clone, Default)]
pub struct RouterAiClientConfig {
    /// `apiKey` (по умолчанию `ROUTERAI_API_KEY`, иначе пусто).
    pub api_key: Option<String>,
    /// `baseUrl` (по умолчанию `ROUTERAI_BASE_URL`, иначе `https://routerai.ru/api/v1`).
    pub base_url: Option<String>,
    /// `model` (по умолчанию `DND_AI_MODEL`, иначе `z-ai/glm-5.3-flash`).
    pub model: Option<String>,
    /// `maxTokens` (по умолчанию `Number(DND_AI_MAX_TOKENS) || 1200`).
    pub max_tokens: Option<f64>,
    /// `reasoning`: профиль рассуждений сервера для этой модели.
    pub reasoning: Option<Value>,
    pub timeout_ms: Option<f64>,
    pub max_tool_calls: Option<f64>,
    pub max_response_bytes: Option<f64>,
}

impl std::fmt::Debug for RouterAiClientConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RouterAiClientConfig")
            .field("api_key", &self.api_key.as_ref().map(|_| "<скрыт>"))
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .field("reasoning", &self.reasoning)
            .field("timeout_ms", &self.timeout_ms)
            .field("max_tool_calls", &self.max_tool_calls)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

/// `RouterAIClient`.
pub struct RouterAiClient {
    api_key: String,
    base_url: String,
    model: String,
    max_tokens: i64,
    reasoning: Option<Value>,
    timeout_ms: i64,
    max_tool_calls: i64,
    max_response_bytes: i64,
    pub(super) provider: &'static str,
    pub(super) provider_label: &'static str,
    http: reqwest::Client,
}

impl std::fmt::Debug for RouterAiClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RouterAiClient")
            .field("api_key", &if self.api_key.is_empty() { "<нет>" } else { "<скрыт>" })
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .field("timeout_ms", &self.timeout_ms)
            .field("provider", &self.provider)
            .finish()
    }
}

/// Подготовленный запрос: нормализованный запрос, тело для провайдера и то,
/// что нужно после ответа.
pub(super) struct Prepared {
    request: Map<String, Value>,
    wire: Value,
    internal_model: String,
    timeout_ms: i64,
    streaming: bool,
}

// С12: виден транспорту картинок (`image_http.rs`) — тот же TLS.
pub(super) fn build_http_client() -> Result<reqwest::Client, LlmError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| LlmError::type_error(format!("Не удалось подготовить TLS для RouterAIClient: {error}")))?;
    let mut tls = rustls_platform_verifier::BuilderVerifierExt::with_platform_verifier(builder)
        .map_err(|error| LlmError::type_error(format!("Не удалось подготовить TLS для RouterAIClient: {error}")))?
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .no_proxy()
        .build()
        .map_err(|error| LlmError::type_error(format!("Не удалось подготовить HTTP-клиент RouterAIClient: {}", error.without_url())))
}

/// Ограждение `/^\s*```[A-Za-z0-9_./+-]*\s*([\s\S]*?)\s*```\s*$/` (`\s` — пробелы JS).
static TRANSPORT_FENCE: LazyLock<sk_core::regex::Regex> = LazyLock::new(|| {
    let space = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
    sk_core::regex::Regex::new(&format!(r"^{space}*```[A-Za-z0-9_./+-]*{space}*((?s:.)*?){space}*```{space}*$")).expect("регулярное выражение")
});

/// `response.text()` у `fetch`: UTF-8 с заменой битых последовательностей и
/// без BOM в начале.
fn decode_body(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// `readProviderBody(response, maxBytes)` для готового текста тела: одна
/// markdown-ограда вокруг всего HTTP-конверта снимается (причуда шлюзов),
/// дальше — строгий разбор.
pub(super) fn parse_provider_body(text: &str, max_bytes: i64) -> Result<Value, LlmError> {
    let unwrapped = TRANSPORT_FENCE.captures(text).and_then(|captures| captures.get(1)).map(|group| group.as_str());
    strict_json_parse(unwrapped.unwrap_or(text), &StrictJsonOptions::new("ответ RouterAI", "object").max_bytes(max_bytes))
}

fn read_error(error: reqwest::Error) -> LlmError {
    LlmError::other("TypeError", "terminated").with_cause(LlmError::other("Error", error.without_url().to_string()))
}

struct ResponseChunks(reqwest::Response);

impl ChunkSource for ResponseChunks {
    fn next_chunk(&mut self) -> Pin<Box<dyn Future<Output = Option<Result<Vec<u8>, LlmError>>> + Send + '_>> {
        Box::pin(async move {
            match self.0.chunk().await {
                Ok(Some(bytes)) => Some(Ok(bytes.to_vec())),
                Ok(None) => None,
                Err(error) => Some(Err(read_error(error))),
            }
        })
    }
}

async fn read_all(mut response: reqwest::Response) -> Result<Vec<u8>, LlmError> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => body.extend_from_slice(&bytes),
            Ok(None) => return Ok(body),
            Err(error) => return Err(read_error(error)),
        }
    }
}

impl RouterAiClient {
    /// `new RouterAIClient(config)` с окружением процесса.
    pub fn new(config: RouterAiClientConfig) -> Result<Self, LlmError> {
        Self::with_env(config, |name| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
    }

    /// То же, но переменные окружения читаются через `env` (тесты).
    pub fn with_env(config: RouterAiClientConfig, env: impl Fn(&str) -> Option<String>) -> Result<Self, LlmError> {
        let api_key = config.api_key.unwrap_or_else(|| env("ROUTERAI_API_KEY").unwrap_or_default());
        let base_url = config.base_url.unwrap_or_else(|| env("ROUTERAI_BASE_URL").unwrap_or_else(|| "https://routerai.ru/api/v1".into()));
        let model = config.model.unwrap_or_else(|| env("DND_AI_MODEL").unwrap_or_else(|| GLM_FLASH.into()));
        let max_tokens = config.max_tokens.unwrap_or_else(|| {
            let number = env("DND_AI_MAX_TOKENS").map_or(f64::NAN, |text| js::parse_number(&text));
            if number.is_nan() || number == 0.0 {
                1200.0
            } else {
                number
            }
        });
        let base_url = base_url.strip_suffix('/').map_or_else(|| base_url.clone(), str::to_string);
        let provider = llm_provider_for(&base_url);
        Ok(RouterAiClient {
            api_key,
            model,
            max_tokens: positive_integer_number(max_tokens, Some(1200), "maxTokens")?,
            reasoning: config.reasoning.filter(|reasoning| is_js_object(Some(reasoning))).map(|reasoning| Value::Object(spread_object(&reasoning))),
            timeout_ms: positive_integer_number(config.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS as f64), Some(DEFAULT_TIMEOUT_MS), "timeoutMs")?,
            max_tool_calls: positive_integer_number(config.max_tool_calls.unwrap_or(DEFAULT_MAX_TOOL_CALLS as f64), Some(DEFAULT_MAX_TOOL_CALLS), "maxToolCalls")?,
            max_response_bytes: positive_integer_number(config.max_response_bytes.unwrap_or(DEFAULT_MAX_RESPONSE_BYTES as f64), Some(DEFAULT_MAX_RESPONSE_BYTES), "maxResponseBytes")?,
            provider,
            provider_label: if provider == "ohmylama" { "OhMyLama" } else { "RouterAI" },
            base_url,
            http: build_http_client()?,
        })
    }

    /// Есть ли ключ (значение не раскрывается).
    pub fn api_key_configured(&self) -> bool {
        !self.api_key.is_empty()
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// `ohmylama` или `routerai`.
    pub fn provider(&self) -> &'static str {
        self.provider
    }

    /// `OhMyLama` или `RouterAI`.
    pub fn provider_label(&self) -> &'static str {
        self.provider_label
    }

    pub fn reasoning(&self) -> Option<&Value> {
        self.reasoning.as_ref()
    }

    pub fn max_tool_calls(&self) -> i64 {
        self.max_tool_calls
    }

    pub fn max_response_bytes(&self) -> i64 {
        self.max_response_bytes
    }

    /// Тело запроса к провайдеру — то, что `complete` отправит в
    /// `{baseUrl}/chat/completions` (`JSON.stringify` этого значения), с теми
    /// же отказами до отправки.
    /// Контекст кампании — текущий поток-локальный.
    pub fn request_body(&self, input: &Value, options: &Value, hooks: &CallHooks) -> Result<Value, LlmError> {
        self.prepare(input, options, hooks).map(|prepared| prepared.wire)
    }

    /// `timeoutMs` клиента (для лимита модели в каскаде).
    pub fn timeout_ms(&self) -> i64 {
        self.timeout_ms
    }

    /// Синхронная часть `complete`: всё до первого `await` в JS.
    pub(super) fn prepare(&self, input: &Value, options: &Value, hooks: &CallHooks) -> Result<Prepared, LlmError> {
        let request = normalize_request(input, options)?;
        if self.api_key.is_empty() {
            return Err(LlmError::llm("ROUTERAI_API_KEY не настроен", "LLM_NOT_CONFIGURED"));
        }
        let own_timeout = Value::from(self.timeout_ms);
        let timeout_ms = positive_or(coalesce(request.get("timeoutMs"), Some(&own_timeout)), self.timeout_ms);
        let mut body = Map::new();
        let model = if js::truthy(request.get("model")) { js::s(request.get("model")) } else { self.model.clone() };
        body.insert("model".into(), Value::String(model.clone()));
        body.insert("messages".into(), request.get("messages").cloned().unwrap_or(Value::Null));
        let temperature = js::number(request.get("temperature"));
        body.insert("temperature".into(), js::num(if temperature.is_finite() { temperature } else { 0.0 }));
        let own_max_tokens = Value::from(self.max_tokens);
        body.insert("max_tokens".into(), Value::from(positive_or(coalesce(request.get("maxTokens"), Some(&own_max_tokens)), self.max_tokens)));
        let frequency_penalty = optional_number_in_range(coalesce(request.get("frequencyPenalty"), request.get("frequency_penalty")), -2.0, 2.0, "frequencyPenalty")?;
        let presence_penalty = optional_number_in_range(coalesce(request.get("presencePenalty"), request.get("presence_penalty")), -2.0, 2.0, "presencePenalty")?;
        if let Some(penalty) = frequency_penalty {
            body.insert("frequency_penalty".into(), js::num(penalty));
        }
        if let Some(penalty) = presence_penalty {
            body.insert("presence_penalty".into(), js::num(penalty));
        }
        if let Some(Value::Array(tools)) = request.get("tools") {
            if !tools.is_empty() {
                body.insert("tools".into(), Value::Array(tools.clone()));
                let choice = coalesce(request.get("toolChoice"), request.get("tool_choice")).cloned().unwrap_or_else(|| Value::String("auto".into()));
                body.insert("tool_choice".into(), choice);
            }
        }
        // Порядок: явный запрос → профиль лидера кампании для этой модели и
        // роли (только творческие роли, помеченные `role`) → профиль сервера.
        let reasoning = match request.get("reasoning") {
            Some(reasoning) if is_js_object(Some(reasoning)) => Some(reasoning.clone()),
            _ => campaign_reasoning_for(Some(&model), &js::s(request.get("role"))).or_else(|| self.reasoning.clone()),
        };
        if let Some(reasoning) = reasoning {
            body.insert("reasoning".into(), reasoning);
        }
        // Схема ответа роли (`jsonSchema`) уходит моделям, чей маршрут
        // исполняет strict json_schema; остальным — json_object. GLM Flash
        // отвечал {} в JSON mode: ему — директива в системном промпте.
        let json = wants_json(&request);
        let json_schema = if json { usable_json_schema(request.get("jsonSchema")) } else { None };
        match json_schema {
            Some(schema) if supports_json_schema(Some(&model)) => {
                let mut format = Map::new();
                format.insert("type".into(), Value::String("json_schema".into()));
                format.insert("json_schema".into(), schema);
                body.insert("response_format".into(), Value::Object(format));
            }
            _ if json => {
                if model != GLM_FLASH {
                    let mut format = Map::new();
                    format.insert("type".into(), Value::String("json_object".into()));
                    body.insert("response_format".into(), Value::Object(format));
                } else if let Some(Value::Array(messages)) = body.get_mut("messages") {
                    let system = messages.iter().position(|message| message.get("role").and_then(Value::as_str) == Some("system") && message.get("content").is_some_and(Value::is_string));
                    match system {
                        None => {
                            let mut directive = Map::new();
                            directive.insert("role".into(), Value::String("system".into()));
                            directive.insert("content".into(), Value::String(GLM_JSON_DIRECTIVE.into()));
                            messages.insert(0, Value::Object(directive));
                        }
                        Some(index) => {
                            if let Some(Value::Object(message)) = messages.get_mut(index) {
                                let content = js::s(message.get("content"));
                                message.insert("content".into(), Value::String(format!("{content}\n{GLM_JSON_DIRECTIVE}")));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        let streaming = hooks.on_delta.is_some();
        if streaming {
            if json {
                return Err(LlmError::type_error("Streaming JSON responses are not supported"));
            }
            body.insert("stream".into(), Value::Bool(true));
            let mut stream_options = Map::new();
            stream_options.insert("include_usage".into(), Value::Bool(true));
            body.insert("stream_options".into(), Value::Object(stream_options));
        }
        // Имя модели внутри сервера — прежнее; провайдеру уходит его формат.
        let wire = provider_request_body(self.provider, &Value::Object(body));
        Ok(Prepared { request, wire, internal_model: model, timeout_ms, streaming })
    }

    async fn send(&self, body: String) -> Result<reqwest::Response, LlmError> {
        let address = format!("{}/chat/completions", self.base_url);
        let url = reqwest::Url::parse(&address).map_err(|_| LlmError::type_error(format!("Failed to parse URL from {address}")))?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(LlmError::type_error("Request cannot be constructed from a URL that includes credentials"));
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", self.api_key)).map_err(|_| LlmError::type_error("Invalid Authorization header value"))?;
        authorization.set_sensitive(true);
        self.http
            .post(url)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .header(AUTHORIZATION, authorization)
            .body(body)
            .send()
            .await
            .map_err(|error| LlmError::other("TypeError", "fetch failed").with_cause(LlmError::other("Error", error.without_url().to_string())))
    }

    async fn exchange(&self, prepared: &Prepared, hooks: &CallHooks, scope: &AbortScope) -> Result<Value, LlmError> {
        let signal = scope.signal();
        let response = race(self.send(jsx::stringify(&prepared.wire)), Some(&signal)).await?;
        let status = response.status().as_u16();
        if !(200..=299).contains(&status) {
            return Err(LlmError::llm(format!("{} ответил HTTP {status}", self.provider_label), "LLM_PROVIDER_ERROR").with_detail("status", Value::from(status)));
        }
        let request = &prepared.request;
        let body_model = prepared.internal_model.clone();
        if prepared.streaming {
            // У ответов 204 и 205 тела нет (`response.body === null`).
            let body = if matches!(status, 204 | 205) { None } else { Some(ResponseChunks(response)) };
            let stream_options = StreamOptions {
                on_delta: hooks.on_delta.clone(),
                max_event_bytes: Some(coalesce(request.get("maxEventBytes"), None).cloned().unwrap_or_else(|| Value::from(ROUTERAI_STREAM_MAX_EVENT_BYTES))),
                max_response_bytes: Some(coalesce(request.get("maxResponseBytes"), None).cloned().unwrap_or_else(|| Value::from(self.max_response_bytes))),
            };
            let streamed = race(parse_router_ai_event_stream(body, stream_options), Some(&signal)).await?;
            let mut assistant = Map::new();
            assistant.insert("role".into(), Value::String("assistant".into()));
            assistant.insert("content".into(), Value::String(streamed.content.clone()));
            let mut message = with_known_usage(streamed.usage.as_ref(), normalize_assistant_message(Some(&Value::Object(assistant)), request, self.max_tool_calls))?;
            let model = if self.provider == "ohmylama" { body_model } else { streamed.model.clone().unwrap_or(body_model) };
            message.insert("model".into(), Value::String(model));
            message.insert("usage".into(), streamed.usage.clone().unwrap_or(Value::Null));
            message.insert("provider".into(), Value::String(self.provider_label.into()));
            message.insert("streamed".into(), Value::Bool(true));
            return Ok(Value::Object(message));
        }
        let max_bytes = self.max_response_bytes;
        let payload = race(async move { parse_provider_body(&decode_body(&read_all(response).await?), max_bytes) }, Some(&signal)).await?;
        let usage = coalesce(payload.get("usage"), None).cloned().unwrap_or(Value::Null);
        let mut message = with_known_usage(Some(&usage), normalize_assistant_message(prop(index0(payload.get("choices")), "message"), request, self.max_tool_calls))?;
        let model = if self.provider == "ohmylama" { Value::String(body_model) } else { coalesce(payload.get("model"), None).cloned().unwrap_or(Value::String(body_model)) };
        message.insert("model".into(), model);
        message.insert("usage".into(), usage);
        message.insert("provider".into(), Value::String(self.provider_label.into()));
        Ok(Value::Object(message))
    }

    async fn execute(&self, prepared: Prepared, hooks: &CallHooks) -> Result<Value, LlmError> {
        let scope = AbortScope::new(prepared.timeout_ms as f64, hooks.signal.as_ref());
        let outcome = self.exchange(&prepared, hooks, &scope).await;
        outcome.map_err(|error| {
            if scope.timed_out() {
                return LlmError::timeout(prepared.timeout_ms as f64);
            }
            if hooks.signal.as_ref().is_some_and(|signal| signal.aborted()) {
                return LlmError::llm("LLM-запрос отменён", "LLM_ABORTED").with_cause(error);
            }
            if error.is_llm_error() {
                return error;
            }
            LlmError::llm(format!("Не удалось вызвать {}", self.provider_label), "LLM_PROVIDER_UNAVAILABLE").with_cause(error)
        })
    }
}

impl LlmClient for RouterAiClient {
    fn model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn max_tokens(&self) -> Option<Value> {
        Some(Value::from(self.max_tokens))
    }

    fn model_timeout_ms(&self) -> Option<f64> {
        Some(self.timeout_ms as f64)
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        // Контекст кампании снимается при вызове; крючки — из области вызова.
        let at_call = CampaignSnapshot::capture();
        Box::pin(async move {
            let scope = CallScope::resolve(at_call);
            let prepared = scope.campaign.enter(|| self.prepare(input, options, &scope.hooks))?;
            self.execute(prepared, &scope.hooks).await
        })
    }

    /// У `RouterAIClient` в JS нет `probe`: проверку моделей ведёт каскад.
    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(Value::Array(Vec::new())) })
    }

    /// У `RouterAIClient` в JS нет `health`: состояние моделей ведёт каскад.
    fn health(&self) -> Value {
        Value::Array(Vec::new())
    }
}
