//! Метаданные попыток в границах одного хода, без запросов и ответов модели.

use std::cell::RefCell;
use std::future::Future;
use std::time::Instant;

use serde_json::{Value, json};

use super::{LlmError, LlmErrorExt};

tokio::task_local! {
    static MODEL_ATTEMPTS: RefCell<Vec<ModelAttempt>>;
}

struct ModelAttempt {
    started: Instant,
    row: Value,
    finished: bool,
}

pub async fn with_model_attempt_trace<F: Future>(operation: F) -> F::Output {
    if MODEL_ATTEMPTS.try_with(|_| ()).is_ok() {
        operation.await
    } else {
        MODEL_ATTEMPTS.scope(RefCell::new(Vec::new()), operation).await
    }
}

pub fn current_model_attempt_trace() -> Vec<Value> {
    MODEL_ATTEMPTS.try_with(|attempts| attempts.borrow().iter().map(|attempt| {
        let mut row = attempt.row.clone();
        if !attempt.finished {
            // Внешний таймер роли мог прервать future до получения ответа.
            row["duration_ms"] = json!(attempt.started.elapsed().as_millis() as u64);
            row["outcome"] = json!("error");
            row["error_code"] = json!("LLM_ATTEMPT_INTERRUPTED");
        }
        row
    }).collect()).unwrap_or_default()
}

fn identifier(value: &str) -> Option<&str> {
    (!value.is_empty() && value.len() <= 128 && !value.contains("://")
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-/:".contains(&b))).then_some(value)
}

pub(super) fn start_model_attempt(input: &Value, options: &Value, provider: Option<&str>, model: &str, fallback_reason: Option<&'static str>) -> Option<usize> {
    MODEL_ATTEMPTS.try_with(|items| {
        let mut items = items.borrow_mut();
        if items.len() >= 32 {
            return None;
        }
        let field = |key: &str| options.get(key).filter(|value| !value.is_null()).or_else(|| input.get(key));
        let role = [options.get("usageRole"), options.get("role"), input.get("usageRole"), input.get("role")]
            .into_iter().flatten().filter_map(Value::as_str).find_map(identifier).unwrap_or("unknown");
        let mut attempt = json!({
            "role": role,
            "provider": provider.and_then(identifier).unwrap_or("unknown"),
            "model": identifier(model).unwrap_or("unknown"),
            "schema_requested": field("jsonSchema").is_some_and(Value::is_object),
        });
        if let Some(reason) = fallback_reason {
            attempt["fallback_reason"] = json!(reason);
        }
        let index = items.len();
        items.push(ModelAttempt { started: Instant::now(), row: attempt, finished: false });
        Some(index)
    }).ok().flatten()
}

pub(super) fn finish_model_attempt(index: Option<usize>, result: &Result<Value, LlmError>) {
    let Some(index) = index else { return };
    let _ = MODEL_ATTEMPTS.try_with(|items| {
        let mut items = items.borrow_mut();
        let Some(attempt) = items.get_mut(index) else { return };
        attempt.finished = true;
        attempt.row["duration_ms"] = json!(attempt.started.elapsed().as_millis() as u64);
        attempt.row["outcome"] = json!(if result.is_ok() { "success" } else { "error" });
        match result {
            Ok(response) => {
                if let Some(model) = response.get("model").and_then(Value::as_str).and_then(identifier) {
                    attempt.row["resolved_model"] = json!(model);
                }
            }
            Err(error) => {
                attempt.row["error_code"] = json!(identifier(&error.code_or_name()).unwrap_or("LLM_ERROR"));
                if let Some(status) = error.details.get("status").and_then(Value::as_u64).filter(|code| (100..600).contains(code)) {
                    attempt.row["http_status"] = json!(status);
                }
            }
        }
    });
}
