//! Перенос `test/usage-ledger.test.mjs`. Транспорт `RouterAIClient` в JS
//! подменён сценарием; здесь подменён сам клиент модели — он возвращает то же,
//! что `RouterAIClient` отдал бы на эти ответы поставщика (успех с `usage`,
//! ошибка с приложенным `providerUsage`, ошибка без расхода).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sk_infra::usage_ledger::{DurableUsageLedger, LlmClient, LlmError, LlmFuture, MeteredLLMClient, ReserveRequest, UsageLedgerError, UsageLedgerOptions};

struct Fixture {
    _directory: tempfile::TempDir,
    file: std::path::PathBuf,
    now: Arc<AtomicI64>,
    ledger: Arc<DurableUsageLedger>,
}

fn fixture(daily_token_limit: f64) -> Fixture {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("usage.json");
    let now = Arc::new(AtomicI64::new(sk_core::clock::parse_iso("2026-07-24T12:00:00.000Z").expect("время")));
    let clock = Arc::clone(&now);
    let ledger = DurableUsageLedger::new(UsageLedgerOptions {
        storage_file: file.clone(),
        daily_token_limit: Some(daily_token_limit),
        reservation_ttl_ms: Some(1_000.0),
        retention_days: None,
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
    })
    .expect("учёт");
    Fixture { _directory: directory, file, now, ledger: Arc::new(ledger) }
}

fn reserve(ledger: &DurableUsageLedger, id: &str, tokens: f64) -> Result<Value, UsageLedgerError> {
    ledger.reserve(&ReserveRequest { request_id: Some(id.into()), estimated_tokens: tokens, ..ReserveRequest::default() })
}

#[test]
fn durable_quota_reserves_settles_and_survives_restart() {
    let fixture = fixture(100.0);
    let ledger = &fixture.ledger;
    ledger.reserve(&ReserveRequest { request_id: Some("one".into()), estimated_tokens: 60.0, scope: Some("campaign:a".into()), model: Some("test".into()) }).expect("резерв");
    assert_eq!(ledger.report().expect("отчёт")["reserved_tokens"], 60);
    ledger.settle("one", Some(&json!({ "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20, "cost": 0.004 }))).expect("закрытие");
    assert_eq!(
        ledger.report().expect("отчёт"),
        json!({
            "day": "2026-07-24", "daily_token_limit": 100, "committed_tokens": 20, "reserved_tokens": 0,
            "input_tokens": 12, "output_tokens": 8, "provider_cost": 0.004, "requests": 1, "completed_requests": 1, "failed_requests": 0,
        })
    );
    let reopened = DurableUsageLedger::new(UsageLedgerOptions {
        daily_token_limit: Some(100.0),
        now: Arc::new(|| sk_core::clock::parse_iso("2026-07-24T12:01:00.000Z").expect("время")),
        ..UsageLedgerOptions::new(fixture.file.clone())
    })
    .expect("учёт");
    assert_eq!(reopened.report().expect("отчёт")["committed_tokens"], 20);
    let error = reserve(&reopened, "two", 81.0).expect_err("квота");
    assert!(matches!(error, UsageLedgerError::QuotaExceeded { limit: 100, used: 20, requested: 81 }));
    assert_eq!(error.code(), Some("LLM_QUOTA_EXCEEDED"));
    assert_eq!(error.to_string(), "Daily LLM token quota exceeded: limit=100, committed_or_reserved=20, requested=81");
}

#[test]
fn expired_and_failed_reservations_release_quota() {
    let fixture = fixture(100.0);
    let ledger = &fixture.ledger;
    ledger.reserve(&ReserveRequest { request_id: Some("expired".into()), estimated_tokens: 90.0, scope: Some("campaign:secret".into()), model: Some("test".into()) }).expect("резерв");
    fixture.now.fetch_add(1_001, Ordering::SeqCst);
    assert_eq!(ledger.report().expect("отчёт")["reserved_tokens"], 0);
    reserve(ledger, "failed", 90.0).expect("резерв");
    ledger.fail("failed", Some("LLM_TIMEOUT"), None).expect("неудача");
    assert_eq!(ledger.report().expect("отчёт")["failed_requests"], 1);
    assert_eq!(ledger.report().expect("отчёт")["reserved_tokens"], 0);
    // Подсказки и сообщения в файл не попадают.
    let text = std::fs::read_to_string(&fixture.file).expect("файл");
    assert!(!text.contains("messages"));
}

#[test]
fn repeated_reserve_with_blank_scope_and_model_returns_same_entry() {
    // Пустые scope и model хранятся как 'global' и 'unknown'; повтор
    // сравнивался с сырым значением и всегда давал USAGE_IDEMPOTENCY_CONFLICT.
    let fixture = fixture(100.0);
    let ledger = &fixture.ledger;
    let blank = |scope: &str, model: &str| ReserveRequest { request_id: Some("blank".into()), estimated_tokens: 10.0, scope: Some(scope.into()), model: Some(model.into()) };
    let first = ledger.reserve(&blank("", "   ")).expect("резерв");
    assert_eq!(first["scope"], "global");
    assert_eq!(first["model"], "unknown");
    assert_eq!(ledger.reserve(&blank("", "   ")).expect("повтор"), first);
    assert_eq!(ledger.reserve(&blank("global", "unknown")).expect("повтор"), first);
    assert_eq!(ledger.report().expect("отчёт")["reserved_tokens"], 10);
    assert_eq!(ledger.reserve(&blank("campaign:a", "")).expect_err("конфликт").code(), Some("USAGE_IDEMPOTENCY_CONFLICT"));
}

#[test]
fn reused_request_id_with_other_parameters_conflicts() {
    let fixture = fixture(1_000.0);
    let ledger = &fixture.ledger;
    let first = reserve(ledger, "same", 10.0).expect("резерв");
    assert_eq!(reserve(ledger, "same", 10.0).expect("повтор"), first);
    let error = reserve(ledger, "same", 11.0).expect_err("конфликт");
    assert_eq!(error.code(), Some("USAGE_IDEMPOTENCY_CONFLICT"));
    assert_eq!(reserve(ledger, " ", 10.0).expect_err("пустой id").code(), Some("USAGE_REQUEST_ID_INVALID"));
    assert_eq!(reserve(ledger, "x", 0.5).expect_err("дробь").to_string(), "estimatedTokens must be a positive integer");
    std::fs::write(&fixture.file, "[]").expect("файл");
    let corrupt = ledger.report().expect_err("испорчен");
    assert_eq!(corrupt.code(), Some("USAGE_LEDGER_CORRUPT"));
    assert_eq!(std::fs::read_to_string(&fixture.file).expect("файл"), "[]", "испорченный файл не перезаписывается");
}

// ---------------------------------------------------------------------------
// MeteredLLMClient
// ---------------------------------------------------------------------------

struct ScriptedClient {
    model: String,
    max_tokens: Option<Value>,
    responses: Mutex<VecDeque<Result<Value, LlmError>>>,
    calls: AtomicUsize,
}

impl ScriptedClient {
    fn new(model: &str, max_tokens: i64, responses: Vec<Result<Value, LlmError>>) -> Self {
        Self { model: model.into(), max_tokens: Some(json!(max_tokens)), responses: Mutex::new(responses.into()), calls: AtomicUsize::new(0) }
    }
}

impl LlmClient for ScriptedClient {
    fn model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn max_tokens(&self) -> Option<Value> {
        self.max_tokens.clone()
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.responses.lock().expect("сценарий").pop_front().unwrap_or_else(|| Err(LlmError::new("LLM_ERROR", "scripted provider exhausted")))
        })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

fn completion(json_value: Value, usage: Value) -> Result<Value, LlmError> {
    Ok(json!({ "role": "assistant", "content": json_value.to_string(), "json": json_value, "model": "test/model", "usage": usage, "provider": "RouterAI" }))
}

/// Ошибка непригодного ответа: `RouterAIClient` прикладывает известный usage.
fn invalid_json(usage: Value) -> Result<Value, LlmError> {
    Err(LlmError { name: "LLMResponseError".into(), provider_usage: Some(usage), ..LlmError::new("LLM_JSON_INVALID", "Модель вернула некорректный JSON") })
}

fn messages() -> Value {
    json!({ "messages": [{ "role": "user", "content": "usage check" }] })
}

#[tokio::test]
async fn metered_client_rejects_over_budget_requests_before_provider() {
    let fixture = fixture(100.0);
    let provider = Arc::new(ScriptedClient::new("fake", 20, vec![completion(json!({}), json!({ "input_tokens": 5, "output_tokens": 5, "total_tokens": 10 }))]));
    let client = MeteredLLMClient::new(Arc::clone(&provider), Arc::clone(&fixture.ledger));
    client.complete(&json!({ "messages": [{ "role": "user", "content": "small" }], "maxTokens": 20 }), &json!({})).await.expect("вызов");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let error = client.complete(&json!({ "messages": [{ "role": "user", "content": "large" }], "maxTokens": 90 }), &json!({})).await.expect_err("квота");
    assert_eq!(error.code.as_deref(), Some("LLM_QUOTA_EXCEEDED"));
    assert_eq!(error.name, "UsageQuotaExceededError");
    assert_eq!(error.details["requested_tokens"], 125);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cost01_successful_answer_is_counted_once() {
    let fixture = fixture(10_000.0);
    let provider = Arc::new(ScriptedClient::new("test/model", 50, vec![completion(json!({ "ok": true }), json!({ "prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40, "cost": 0.1 }))]));
    let client = MeteredLLMClient::new(Arc::clone(&provider), Arc::clone(&fixture.ledger));
    assert_eq!(client.complete_json(&messages(), &json!({})).await.expect("ответ"), json!({ "ok": true }));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!(report["committed_tokens"], 40);
    assert_eq!(report["input_tokens"], 30);
    assert_eq!(report["output_tokens"], 10);
    assert_eq!(report["provider_cost"], 0.1);
    assert_eq!(report["completed_requests"], 1);
    assert_eq!(report["failed_requests"], 0);
    assert_eq!(report["reserved_tokens"], 0);
}

#[tokio::test]
async fn cost01_paid_invalid_json_records_usage_and_keeps_error() {
    let fixture = fixture(10_000.0);
    let provider = Arc::new(ScriptedClient::new("test/model", 50, vec![invalid_json(json!({ "total_tokens": 100, "cost": 0.25 }))]));
    let client = MeteredLLMClient::new(Arc::clone(&provider), Arc::clone(&fixture.ledger));
    let error = client.complete_json(&messages(), &json!({})).await.expect_err("ошибка");
    assert_eq!(error.code.as_deref(), Some("LLM_JSON_INVALID"));
    assert!(error.message.contains("некорректный JSON"));
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!(report["committed_tokens"], 100);
    assert_eq!(report["provider_cost"], 0.25);
    assert_eq!(report["completed_requests"], 0);
    assert_eq!(report["failed_requests"], 1);
    assert_eq!(report["reserved_tokens"], 0);
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&fixture.file).expect("файл")).expect("json");
    let entry = stored["requests"].as_object().expect("записи").values().next().expect("запись").clone();
    assert_eq!(entry["status"], "failed");
    assert_eq!(entry["error_code"], "LLM_JSON_INVALID");
    assert_eq!(entry["total_tokens"], 100);
    // Расход переживает перезапуск так же, как расход успешного ответа.
    let clock = Arc::clone(&fixture.now);
    let reopened = DurableUsageLedger::new(UsageLedgerOptions {
        daily_token_limit: Some(10_000.0),
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
        ..UsageLedgerOptions::new(fixture.file.clone())
    })
    .expect("учёт");
    assert_eq!(reopened.report().expect("отчёт")["committed_tokens"], 100);
}

#[tokio::test]
async fn cost01_known_usage_of_invalid_answers_counts_toward_quota() {
    // Оценка одного запроса: 41 байт сообщений + 50 токенов ответа = 91.
    let fixture = fixture(250.0);
    let provider = Arc::new(ScriptedClient::new("test/model", 50, (0..3).map(|_| invalid_json(json!({ "total_tokens": 100 }))).collect()));
    let client = MeteredLLMClient::new(Arc::clone(&provider), Arc::clone(&fixture.ledger));
    for _ in 0..2 {
        let error = client.complete_json(&messages(), &json!({})).await.expect_err("ошибка");
        assert_eq!(error.code.as_deref(), Some("LLM_JSON_INVALID"));
    }
    // 200 потрачено + 91 в резерв > 250: третий запрос до поставщика не доходит.
    let error = client.complete_json(&messages(), &json!({})).await.expect_err("квота");
    assert_eq!(error.code.as_deref(), Some("LLM_QUOTA_EXCEEDED"));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.ledger.report().expect("отчёт")["committed_tokens"], 200);
}

#[tokio::test]
async fn cost01_failures_without_parsed_answer_charge_nothing() {
    let fixture = fixture(10_000.0);
    // Без ключа запрос не уходит вовсе; HTTP-ошибка: тело не разбирается.
    let provider = Arc::new(ScriptedClient::new(
        "test/model",
        50,
        vec![Err(LlmError::new("LLM_NOT_CONFIGURED", "ROUTERAI_API_KEY не настроен")), Err(LlmError::new("LLM_PROVIDER_ERROR", "RouterAI ответил HTTP 503"))],
    ));
    let client = MeteredLLMClient::new(Arc::clone(&provider), Arc::clone(&fixture.ledger));
    assert_eq!(client.complete_json(&messages(), &json!({})).await.expect_err("нет ключа").code.as_deref(), Some("LLM_NOT_CONFIGURED"));
    assert_eq!(client.complete_json(&messages(), &json!({})).await.expect_err("503").code.as_deref(), Some("LLM_PROVIDER_ERROR"));
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!(report["committed_tokens"], 0);
    assert_eq!(report["provider_cost"], 0);
    assert_eq!(report["failed_requests"], 2);
    assert_eq!(report["reserved_tokens"], 0);
}

#[tokio::test]
async fn cost01_cascade_keeps_usage_of_every_attempt() {
    let fixture = fixture(10_000.0);
    let first = MeteredLLMClient::new(ScriptedClient::new("test/first", 50, vec![invalid_json(json!({ "total_tokens": 70 }))]), Arc::clone(&fixture.ledger));
    let second = MeteredLLMClient::new(ScriptedClient::new("test/second", 50, vec![completion(json!({ "ok": true }), json!({ "total_tokens": 30 }))]), Arc::clone(&fixture.ledger));
    // Каскад `FallbackLLMClient` (llm-client.mjs) переходит ко второй модели
    // после непригодного ответа первой; здесь — тот же порядок вызовов.
    assert!(first.complete(&messages(), &json!({ "json": true })).await.is_err());
    let result = second.complete(&messages(), &json!({ "json": true })).await.expect("второй");
    assert_eq!(result["json"], json!({ "ok": true }));
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!(report["committed_tokens"], 100);
    assert_eq!(report["completed_requests"], 1);
    assert_eq!(report["failed_requests"], 1);
}

#[tokio::test]
async fn metered_request_id_scope_and_model_reach_the_ledger() {
    let fixture = fixture(10_000.0);
    let client = MeteredLLMClient::new(ScriptedClient::new("test/model", 50, vec![completion(json!({}), json!({ "total_tokens": 7 }))]), Arc::clone(&fixture.ledger));
    client
        .complete(&json!([{ "role": "user", "content": "hi" }]), &json!({ "usageRequestId": "  req   1 ", "usageScope": "campaign:x", "maxTokens": 3 }))
        .await
        .expect("вызов");
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&fixture.file).expect("файл")).expect("json");
    let entry = &stored["requests"]["req 1"];
    assert_eq!(entry["scope"], "campaign:x");
    assert_eq!(entry["model"], "test/model");
    // `[{"role":"user","content":"hi"}]` — 32 байта, плюс 3 токена ответа.
    assert_eq!(entry["estimated_tokens"], 35);
    assert_eq!(entry["total_tokens"], 7);
    assert_eq!(client.usage().expect("отчёт")["completed_requests"], 1);
}
