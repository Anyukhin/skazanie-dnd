//! Заглушки генератора картинок и леджера для тестов портретов и иллюстраций:
//! то же, что генераторы-функции и `DurableUsageLedger` в тестах JS.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sk_chargen::npc_portraits::{GeneratorError, GeneratorFuture, ImageGenerator, ImageServiceError};
use sk_infra::image_generation::GeneratedImage;
use sk_infra::usage_ledger::{DurableUsageLedger, UsageLedgerError, UsageLedgerOptions};

/// Заголовок RIFF/WEBP — минимальная «картинка» тестов JS.
pub fn webp() -> Vec<u8> {
    vec![0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]
}

/// Вызов генератора: модель и промпт.
#[derive(Debug, Clone)]
pub struct Call {
    pub model: String,
    pub prompt: String,
}

/// Генератор-сценарий: `ok`, `ok-no-usage`, `html`, `fail-code`,
/// `fail-undefined-code`, `fail-name`, `fail-string` (бросок не-Error).
pub struct Scripted {
    pub kind: Mutex<String>,
    pub calls: Mutex<Vec<Call>>,
    pub usage: Map<String, Value>,
}

impl Scripted {
    pub fn new(kind: &str) -> Arc<Self> {
        let usage = json!({ "input_tokens": 5, "output_tokens": 7, "total_tokens": 12, "cost": 0.014 });
        Self::with_usage(kind, usage)
    }

    pub fn with_usage(kind: &str, usage: Value) -> Arc<Self> {
        Arc::new(Self { kind: Mutex::new(kind.into()), calls: Mutex::new(Vec::new()), usage: usage.as_object().cloned().unwrap_or_default() })
    }

    pub fn set(&self, kind: &str) {
        *self.kind.lock().expect("вид") = kind.into();
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("вызовы").clone()
    }
}

impl ImageGenerator for Scripted {
    fn generate<'a>(&'a self, prompt: &'a str, model: &'a str) -> GeneratorFuture<'a> {
        self.calls.lock().expect("вызовы").push(Call { model: model.into(), prompt: prompt.into() });
        let kind = self.kind.lock().expect("вид").clone();
        let usage = self.usage.clone();
        Box::pin(async move {
            let error = |name: &str, code: Option<&str>, message: &str| Err(GeneratorError { name: name.into(), code: code.map(str::to_string), message: message.into() });
            match kind.as_str() {
                "ok" => Ok(GeneratedImage { bytes: webp(), usage }),
                "ok-no-usage" => Ok(GeneratedImage { bytes: webp(), usage: Map::new() }),
                "html" => Ok(GeneratedImage { bytes: "<html>не картинка</html>".as_bytes().to_vec(), usage: json!({ "total_tokens": 3 }).as_object().cloned().unwrap_or_default() }),
                "fail-code" => error("Error", Some("IMAGE_PROVIDER_FAILED"), "provider failed"),
                "fail-undefined-code" => error("Error", Some(""), "provider failed"),
                "fail-name" => error("TimeoutError", None, "timeout"),
                _ => error("", None, "not an error"),
            }
        })
    }
}

/// Леджер с неподвижным временем, как `new DurableUsageLedger({ storageFile, dailyTokenLimit, now })`.
pub fn ledger(file: &Path, daily_token_limit: f64, now_iso: &str) -> Arc<DurableUsageLedger> {
    let now = sk_core::clock::parse_iso(now_iso).expect("время");
    Arc::new(
        DurableUsageLedger::new(UsageLedgerOptions { storage_file: file.to_path_buf(), daily_token_limit: Some(daily_token_limit), retention_days: None, reservation_ttl_ms: None, now: Arc::new(move || now) })
            .expect("леджер"),
    )
}

/// Сводка леджера, как её пишет генератор эталона: отчёт и записи файла.
pub fn ledger_summary(ledger: &DurableUsageLedger, file: &Path) -> Value {
    let persisted: Value = std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({ "requests": {} }));
    let entries: Vec<Value> = persisted["requests"]
        .as_object()
        .map(|requests| {
            requests
                .values()
                .map(|entry| {
                    json!({
                        "scope": entry["scope"], "model": entry["model"], "status": entry["status"], "error_code": entry["error_code"],
                        "estimated_tokens": entry["estimated_tokens"], "total_tokens": entry["total_tokens"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "report": ledger.report().expect("отчёт"), "entries": entries })
}

/// Исключение сервиса как `{ name, code, message }` JS (`caught?.name ?? 'Error'`).
pub fn service_error(error: &ImageServiceError) -> Value {
    let (name, code) = match error {
        ImageServiceError::Generator(error) => (if error.name.is_empty() { "Error".to_string() } else { error.name.clone() }, error.code.clone().filter(|code| !code.is_empty())),
        ImageServiceError::Ledger(error) => match error.downcast_ref::<UsageLedgerError>() {
            // В JS `UsageQuotaExceededError` наследует `this.name = 'UsageLedgerError'`
            // родителя; `UsageLedgerError::name()` из sk-infra называет подкласс.
            Some(ledger) => (if ledger.name() == "UsageQuotaExceededError" { "UsageLedgerError".to_string() } else { ledger.name().to_string() }, ledger.code().map(str::to_string)),
            None => ("Error".to_string(), None),
        },
        other => ("Error".to_string(), other.code().map(str::to_string)),
    };
    json!({ "name": name, "code": code, "message": error.to_string() })
}

/// Путь относительно корня через `/`, как `relative(...).split(sep).join('/')`.
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).map(|rest| rest.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")).unwrap_or_default()
}

/// `filePath` результата — относительно storage.
pub fn relative_result(mut value: Value, storage: &Path) -> Value {
    if let Some(file) = value.get("filePath").and_then(Value::as_str).map(str::to_string) {
        value["filePath"] = json!(relative(storage, Path::new(&file)));
    }
    value
}
