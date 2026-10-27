//! `FallbackLLMClient` из `server/llm-client.mjs`: каскад моделей — основная,
//! затем резервные; модель кампании (ручной выбор лидера) идёт первой.
//! Общий срок `timeoutMs` делится между попытками, а не умножается; модель,
//! которая подряд отказывает, остывает `failureCooldownMs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sk_core::indexmap::IndexMap;
use sk_core::js;

use super::abort::{race, AbortController, AbortScope, SignalLink};
use super::{
    coalesce, llm_timer_delay, option_fields, positive_integer_number, prop, spread_object, utf16_head, CallHooks, CallScope, CampaignSnapshot, DeltaHandler, LlmClient, LlmError, LlmErrorExt, LlmFuture, RouterAiClient,
};

/// Ответы с изъяном содержания: модель отвечает, остывать ей незачем.
const CONTENT_FAILURE_CODES: [&str; 3] = ["LLM_JSON_INVALID", "LLM_RESPONSE_INVALID", "LLM_RESPONSE_TOO_LARGE"];

/// Часы каскада (`now`), миллисекунды.
pub type FallbackClock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// Клиент в каскаде и его `timeoutMs` (лимит горячего пути модели) —
/// `client.model_timeout_ms()`: у `RouterAIClient` и `FakeLLM` свой срок,
/// `MeteredLLMClient` показывает срок обёрнутого клиента.
#[derive(Clone)]
pub struct FallbackMember {
    pub client: Arc<dyn LlmClient>,
    pub timeout_ms: Option<f64>,
}

impl FallbackMember {
    pub fn new(client: Arc<dyn LlmClient>) -> Self {
        let timeout_ms = client.model_timeout_ms();
        FallbackMember { client, timeout_ms }
    }

    pub fn with_timeout(mut self, timeout_ms: f64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }

    /// `RouterAIClient` с его `timeoutMs`.
    pub fn router(client: Arc<RouterAiClient>) -> Self {
        let timeout_ms = client.timeout_ms() as f64;
        FallbackMember { client, timeout_ms: Some(timeout_ms) }
    }

    /// `String(client.model ?? 'unknown-model')`.
    fn key(&self) -> String {
        self.client.model().unwrap_or_else(|| "unknown-model".into())
    }
}

impl From<Arc<dyn LlmClient>> for FallbackMember {
    fn from(client: Arc<dyn LlmClient>) -> Self {
        FallbackMember::new(client)
    }
}

/// `new FallbackLLMClient({ clients, selectableClients, failureCooldownMs, probeTimeoutMs, now })`.
#[derive(Clone, Default)]
pub struct FallbackLlmClientConfig {
    pub clients: Vec<FallbackMember>,
    /// Ручные варианты: участвуют только в выбравшей их кампании, без фоновых проб.
    pub selectable_clients: Vec<FallbackMember>,
    pub failure_cooldown_ms: Option<f64>,
    pub probe_timeout_ms: Option<f64>,
    pub now: Option<FallbackClock>,
}

#[derive(Debug, Clone)]
struct ModelStatus {
    state: &'static str,
    failures: i64,
    disabled_until: f64,
    last_error_code: Option<String>,
    last_success_at: Option<f64>,
    last_failure_at: Option<f64>,
}

impl Default for ModelStatus {
    fn default() -> Self {
        ModelStatus { state: "unknown", failures: 0, disabled_until: 0.0, last_error_code: None, last_success_at: None, last_failure_at: None }
    }
}

/// `FallbackLLMClient`.
pub struct FallbackLlmClient {
    clients: Vec<FallbackMember>,
    selectable_clients: Vec<FallbackMember>,
    model: String,
    models: Vec<String>,
    failure_cooldown_ms: i64,
    probe_timeout_ms: i64,
    now: FallbackClock,
    statuses: Mutex<IndexMap<String, ModelStatus>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Таймер, который снимается при выходе из области (`clearTimeout`).
struct TimerGuard(Option<tokio::task::JoinHandle<()>>);

impl Drop for TimerGuard {
    fn drop(&mut self) {
        if let Some(timer) = self.0.take() {
            timer.abort();
        }
    }
}

impl FallbackLlmClient {
    pub fn new(config: FallbackLlmClientConfig) -> Result<Self, LlmError> {
        if config.clients.is_empty() {
            return Err(LlmError::type_error("FallbackLLMClient requires at least one LLM client"));
        }
        let model = config.clients[0].client.model().unwrap_or_else(|| "fallback-cascade".into());
        let models: Vec<String> = config.clients.iter().chain(config.selectable_clients.iter()).map(FallbackMember::key).collect();
        let statuses = models.iter().map(|model| (model.clone(), ModelStatus::default())).collect();
        Ok(FallbackLlmClient {
            failure_cooldown_ms: positive_integer_number(config.failure_cooldown_ms.unwrap_or(120_000.0), Some(120_000), "failureCooldownMs")?,
            probe_timeout_ms: positive_integer_number(config.probe_timeout_ms.unwrap_or(8_000.0), Some(8_000), "probeTimeoutMs")?,
            now: config.now.unwrap_or_else(|| Arc::new(|| sk_core::clock::now_ms() as f64)),
            clients: config.clients,
            selectable_clients: config.selectable_clients,
            model,
            models,
            statuses: Mutex::new(statuses),
        })
    }

    /// `this.models`: автоматические модели, затем ручные.
    pub fn model_names(&self) -> &[String] {
        &self.models
    }

    fn disabled_until(&self, member: &FallbackMember) -> f64 {
        lock(&self.statuses).get(&member.key()).map_or(0.0, |status| status.disabled_until)
    }

    fn mark_success(&self, member: &FallbackMember) {
        let now = (self.now)();
        let mut statuses = lock(&self.statuses);
        let status = statuses.entry(member.key()).or_default();
        *status = ModelStatus { state: "ready", failures: 0, disabled_until: 0.0, last_error_code: None, last_success_at: Some(now), last_failure_at: status.last_failure_at };
    }

    fn mark_failure(&self, member: &FallbackMember, error: &LlmError) {
        let key = member.key();
        let (failures, last_success_at) = {
            let statuses = lock(&self.statuses);
            statuses.get(&key).map_or((0, None), |status| (status.failures, status.last_success_at))
        };
        // Один тайм-аут или одна недоступность провайдера после успеха —
        // медленный ответ или обрыв, а не упавшая модель; второй подряд — отказ.
        let code = error.code_str();
        let transient = error.is_timeout() || code == "LLM_PROVIDER_UNAVAILABLE" || (code == "LLM_PROVIDER_ERROR" && error.status() >= 500.0);
        let slow_once = transient && failures == 0 && last_success_at.is_some();
        // Негодный ответ — изъян одного ответа: запрос уходит резервной, модель
        // остаётся в строю.
        if CONTENT_FAILURE_CODES.contains(&code) {
            let now = (self.now)();
            let mut statuses = lock(&self.statuses);
            let status = statuses.entry(key).or_default();
            status.last_error_code = Some(utf16_head(code, 80));
            status.last_failure_at = Some(now);
            return;
        }
        let disabled_until = if slow_once { 0.0 } else { (self.now)() + self.failure_cooldown_ms as f64 };
        let failed_at = (self.now)();
        let mut statuses = lock(&self.statuses);
        let status = statuses.entry(key).or_default();
        status.state = if slow_once { "ready" } else { "cooldown" };
        status.failures += 1;
        status.disabled_until = disabled_until;
        status.last_error_code = Some(utf16_head(&error.code_or_name(), 80));
        status.last_failure_at = Some(failed_at);
    }

    /// `_retryable(error)`.
    fn retryable(error: &LlmError) -> bool {
        if error.is_response_error() || error.is_timeout() {
            return true;
        }
        if !error.is_llm_error() {
            return false;
        }
        let code = error.code_str();
        if ["LLM_ABORTED", "LLM_NOT_CONFIGURED"].contains(&code) {
            return false;
        }
        if code == "LLM_PROVIDER_ERROR" && [401.0, 402.0].contains(&error.status()) {
            return false;
        }
        ["LLM_PROVIDER_ERROR", "LLM_PROVIDER_UNAVAILABLE", "LLM_RESPONSE_INVALID", "LLM_JSON_INVALID", "LLM_RESPONSE_TOO_LARGE"].contains(&code)
    }

    /// `_candidates()`: модель кампании первой, остывающие — в конце (или
    /// все по сроку остывания, если готовых нет).
    fn candidates(&self) -> Vec<&FallbackMember> {
        let now = (self.now)();
        let preferred = sk_narration_base::campaign_ai_context::current_campaign_model();
        let selected = self.selectable_clients.iter().find(|member| member.client.model().as_deref() == Some(preferred.as_str()));
        let pool: Vec<&FallbackMember> = selected.into_iter().chain(self.clients.iter()).collect();
        let ready: Vec<&FallbackMember> = pool.iter().copied().filter(|member| self.disabled_until(member) <= now).collect();
        let mut candidates = if ready.is_empty() {
            let mut sorted = pool.clone();
            sorted.sort_by(|left, right| self.disabled_until(left).partial_cmp(&self.disabled_until(right)).unwrap_or(std::cmp::Ordering::Equal));
            sorted
        } else {
            ready
        };
        if preferred.is_empty() {
            return candidates;
        }
        match candidates.iter().position(|member| member.client.model().unwrap_or_default() == preferred) {
            Some(index) if index > 0 => {
                let chosen = candidates.remove(index);
                candidates.insert(0, chosen);
                candidates
            }
            _ => candidates,
        }
    }

    #[allow(clippy::too_many_arguments)] // параметры одной попытки каскада JS
    async fn attempt(
        &self,
        member: &FallbackMember,
        index: usize,
        count: usize,
        input: &Value,
        options: &Value,
        scope: &CallScope,
        deadline: Option<(tokio::time::Instant, f64)>,
        shared_signal: Option<&super::AbortSignal>,
        on_delta: Option<DeltaHandler>,
    ) -> Result<Value, LlmError> {
        let remaining = deadline.map(|(started, requested)| requested - started.elapsed().as_millis() as f64);
        if let (Some(remaining), Some((_, requested))) = (remaining, deadline) {
            if remaining <= 0.0 {
                return Err(LlmError::timeout(requested));
            }
        }
        // Запас резервной модели: зависший основной запрос иначе израсходует
        // весь общий бюджет. Лимит модели — для горячего пути; разовый длинный
        // вызов, который просит больше, им не обрезается.
        let configured = member.timeout_ms.unwrap_or(f64::NAN);
        let requested = deadline.map_or(f64::NAN, |(_, requested)| requested);
        let model_limit = if configured.is_finite() && configured > 0.0 && !(deadline.is_some() && requested > configured) { Some(configured) } else { remaining };
        let attempt_budget = remaining.map(|remaining| {
            let reserve = if index == 0 && count > 1 { (requested * 0.6).floor() } else { remaining };
            1f64.max(remaining.min(model_limit.unwrap_or(remaining)).min(reserve))
        });
        let attempt_scope = attempt_budget.map(|budget| AbortScope::new(budget, shared_signal));
        let mut fields = option_fields(options);
        if let Some(budget) = attempt_budget {
            fields.insert("timeoutMs".into(), js::num(budget));
        }
        let sub_options = Value::Object(fields);
        let hooks = CallHooks {
            signal: attempt_scope.as_ref().map(AbortScope::signal).or_else(|| shared_signal.cloned()),
            on_delta,
            validate_response: scope.hooks.validate_response.clone(),
        };
        let sub_scope = CallScope { hooks, campaign: scope.campaign.clone() };
        let operation = scope.campaign.enter(|| sub_scope.run(member.client.complete(input, &sub_options)));
        let result = match &attempt_scope {
            Some(attempt_scope) => race(operation, Some(&attempt_scope.signal())).await?,
            None => operation.await?,
        };
        if let Some(validator) = &scope.hooks.validate_response {
            if !validator.call(result.clone()).await? {
                let model = member.client.model().unwrap_or_else(|| "undefined".into());
                return Err(LlmError::response(format!("Model {model} returned an unusable response")));
            }
        }
        self.mark_success(member);
        Ok(Value::Object(spread_object(&result)))
    }

    async fn run(&self, input: &Value, options: &Value, scope: CallScope) -> Result<Value, LlmError> {
        let requested_timeout = js::number(coalesce(options.get("timeoutMs"), prop(Some(input), "timeoutMs")));
        let has_deadline = requested_timeout.is_finite() && requested_timeout > 0.0;
        let deadline = has_deadline.then(|| (tokio::time::Instant::now(), requested_timeout));
        let deadline_controller = has_deadline.then(AbortController::new);
        let _timer = TimerGuard(deadline_controller.clone().map(|controller| {
            tokio::spawn(async move {
                tokio::time::sleep(llm_timer_delay(requested_timeout)).await;
                controller.abort(LlmError::timeout(requested_timeout));
            })
        }));
        let external = scope.hooks.signal.clone();
        let _link = match (&deadline_controller, &external) {
            (Some(controller), Some(external)) => Some(SignalLink::new(external, controller)),
            _ => None,
        };
        let shared_signal = deadline_controller.as_ref().map(AbortController::signal).or(external);
        let candidates = scope.campaign.enter(|| self.candidates());
        let mut attempts: Vec<Value> = Vec::new();
        for (index, member) in candidates.iter().enumerate() {
            let emitted = Arc::new(AtomicBool::new(false));
            // Закончившаяся попытка в живой поток больше не пишет: снятая по
            // сроку модель не вклинивает текст после переключения на резервную.
            let open = Arc::new(AtomicBool::new(true));
            let on_delta = scope.hooks.on_delta.clone().map(|requested| {
                let emitted = Arc::clone(&emitted);
                let open = Arc::clone(&open);
                DeltaHandler::new(move |delta| {
                    let live = open.load(Ordering::SeqCst);
                    if live {
                        emitted.store(true, Ordering::SeqCst);
                    }
                    let requested = requested.clone();
                    async move {
                        if live {
                            requested.call(delta).await
                        } else {
                            Ok(())
                        }
                    }
                })
            });
            let outcome = self.attempt(member, index, candidates.len(), input, options, &scope, deadline, shared_signal.as_ref(), on_delta).await;
            open.store(false, Ordering::SeqCst);
            match outcome {
                Ok(mut result) => {
                    if let Value::Object(map) = &mut result {
                        map.insert("fallback_attempts".into(), Value::Array(attempts.clone()));
                        map.insert("fallback_used".into(), Value::Bool(!attempts.is_empty()));
                    }
                    return Ok(result);
                }
                Err(error) => {
                    if deadline_controller.as_ref().is_some_and(|controller| controller.signal().aborted()) {
                        return Err(error);
                    }
                    if !Self::retryable(&error) {
                        return Err(error);
                    }
                    self.mark_failure(member, &error);
                    attempts.push(json!({ "model": member.key(), "code": error.code_or_name() }));
                    // После первой показанной дельты другой провайдер не может
                    // продолжить текст без склейки двух разных ответов.
                    if emitted.load(Ordering::SeqCst) {
                        return Err(error);
                    }
                }
            }
        }
        // Таймер попытки может сработать раньше общего на долю миллисекунды:
        // если истекли все попытки, причина остаётся timeout.
        if has_deadline && !attempts.is_empty() && attempts.iter().all(|attempt| attempt.get("code").and_then(Value::as_str) == Some("LLM_TIMEOUT")) {
            return Err(LlmError::timeout(requested_timeout));
        }
        Err(LlmError::llm("All configured RouterAI models failed", "LLM_FALLBACK_EXHAUSTED").with_detail("attempts", Value::Array(attempts)))
    }
}

impl LlmClient for FallbackLlmClient {
    fn model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn models(&self) -> Option<Value> {
        Some(Value::Array(self.models.iter().cloned().map(Value::String).collect()))
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let at_call = CampaignSnapshot::capture();
        Box::pin(async move { self.run(input, options, CallScope::resolve(at_call)).await })
    }

    /// `probe()`: проверка автоматических моделей (ручные фоновых проб не получают).
    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        let at_call = CampaignSnapshot::capture();
        Box::pin(async move {
            let campaign = CallScope::resolve(at_call).campaign;
            for member in &self.clients {
                let input = json!({
                    "messages": [
                        { "role": "system", "content": "Return only a JSON object with {\"ok\":true}." },
                        { "role": "user", "content": "Health check." },
                    ],
                    "json": true,
                    "jsonExpected": "object",
                    "temperature": 0,
                    "maxTokens": 128,
                    "timeoutMs": self.probe_timeout_ms,
                });
                let options = json!({});
                let scope = CallScope { hooks: CallHooks::default(), campaign: campaign.clone() };
                let outcome = campaign.enter(|| scope.run(member.client.complete(&input, &options))).await.and_then(|result| {
                    if js::is_true(prop(result.get("json"), "ok")) {
                        Ok(())
                    } else {
                        Err(LlmError::response_with_code("Model health check returned invalid JSON", "LLM_PROBE_INVALID"))
                    }
                });
                match outcome {
                    Ok(()) => self.mark_success(member),
                    Err(error) => self.mark_failure(member, &error),
                }
            }
            Ok(self.health())
        })
    }

    /// `health()`: состояние каждой модели для `/api/admin/usage`.
    fn health(&self) -> Value {
        let now = (self.now)();
        let statuses = lock(&self.statuses);
        let entries = self
            .models
            .iter()
            .enumerate()
            .map(|(index, model)| {
                let status = statuses.get(model).cloned().unwrap_or_default();
                let state = if status.disabled_until > now {
                    "cooldown"
                } else if status.state == "cooldown" {
                    "retry-ready"
                } else {
                    status.state
                };
                json!({
                    "model": model,
                    "primary": index == 0,
                    "state": state,
                    "failures": status.failures,
                    "last_error_code": status.last_error_code,
                    "retry_after_ms": js::num((status.disabled_until - now).max(0.0)),
                })
            })
            .collect();
        Value::Array(entries)
    }
}
