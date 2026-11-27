//! Учёт расхода вызовов модели — перенос `server/usage-ledger.mjs`.
//!
//! `DurableUsageLedger` резервирует оценку токенов до вызова поставщика,
//! закрывает резерв фактическим расходом (`settle`) или неудачей (`fail`) и
//! держит дневную квоту; записи хранятся в файле того же JSON, что пишет JS
//! (`{ schema_version: 1, requests: { <id>: запись } }`, отступ в два пробела).
//! `MeteredLLMClient` оборачивает клиента модели (трейт [`LlmClient`]) так,
//! что каждый вызов проходит через резерв и учёт — инвариант «весь вызов
//! модели идёт через учёт расхода; известный usage непригодного ответа тоже
//! записывается».

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::support::{atomic_write, clean_str, clean_text, field, nullish, number, read_utf8, resolve, strict_number, strict_str, stringify, stringify_pretty, template};

const LEDGER_SCHEMA_VERSION: f64 = 1.0;
const DEFAULT_DAILY_TOKEN_LIMIT: i64 = 2_000_000;
const DEFAULT_RETENTION_DAYS: i64 = 31;
const DEFAULT_RESERVATION_TTL_MS: i64 = 15 * 60 * 1000;

/// Ошибка учёта.
#[derive(Debug, thiserror::Error)]
pub enum UsageLedgerError {
    /// `UsageLedgerError` JS: код и текст.
    #[error("{message}")]
    Ledger { code: &'static str, message: String },
    /// `UsageQuotaExceededError`: дневная квота исчерпана.
    #[error("Daily LLM token quota exceeded: limit={limit}, committed_or_reserved={used}, requested={requested}")]
    QuotaExceeded { limit: i64, used: i64, requested: i64 },
    /// `TypeError` JS: недопустимый аргумент или испорченная запись.
    #[error("{0}")]
    Type(String),
    /// Сбой записи файла (в JS — ошибка `node:fs`).
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl UsageLedgerError {
    /// `error.code`; у `TypeError` и ошибок `node:fs` без кода — `None`.
    pub fn code(&self) -> Option<&str> {
        match self {
            UsageLedgerError::Ledger { code, .. } => Some(code),
            UsageLedgerError::QuotaExceeded { .. } => Some("LLM_QUOTA_EXCEEDED"),
            UsageLedgerError::Type(_) | UsageLedgerError::Io(_) => None,
        }
    }

    /// `error.name`.
    pub fn name(&self) -> &'static str {
        match self {
            UsageLedgerError::Ledger { .. } => "UsageLedgerError",
            UsageLedgerError::QuotaExceeded { .. } => "UsageQuotaExceededError",
            UsageLedgerError::Type(_) => "TypeError",
            UsageLedgerError::Io(_) => "Error",
        }
    }

    /// Поля, которые JS кладёт на ошибку (`Object.assign(this, details)`).
    pub fn details(&self) -> Map<String, Value> {
        match self {
            UsageLedgerError::QuotaExceeded { limit, used, requested } => {
                let mut details = Map::new();
                details.insert("daily_token_limit".into(), Value::from(*limit));
                details.insert("committed_or_reserved_tokens".into(), Value::from(*used));
                details.insert("requested_tokens".into(), Value::from(*requested));
                details
            }
            _ => Map::new(),
        }
    }
}

fn ledger_error(code: &'static str, message: String) -> UsageLedgerError {
    UsageLedgerError::Ledger { code, message }
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// `positiveInteger(value, fallback, label)` с запасом.
fn positive_or(value: Option<f64>, fallback: i64) -> i64 {
    match value {
        Some(number) if is_safe_integer(number) && number > 0.0 => number as i64,
        _ => fallback,
    }
}

fn day_key(timestamp: i64) -> String {
    sk_core::text::head(&sk_core::clock::iso(timestamp), 10)
}

fn empty_ledger() -> Value {
    json!({ "schema_version": 1, "requests": {} })
}

fn safe_token_count(value: Option<&Value>) -> i64 {
    let number = number(value);
    if is_safe_integer(number) && number >= 0.0 {
        number as i64
    } else {
        0
    }
}

fn safe_cost(value: Option<&Value>) -> f64 {
    let number = number(value);
    if number.is_finite() && number >= 0.0 {
        number
    } else {
        0.0
    }
}

fn reported_cost(usage: Option<&Value>) -> Option<f64> {
    let value = nullish(field(usage, "cost"), field(usage, "total_cost"))?;
    if !value.is_number() && !value.as_str().is_some_and(|value| !value.trim().is_empty()) {
        return None;
    }
    let amount = number(Some(value));
    (amount.is_finite() && amount >= 0.0).then_some(amount)
}

/// Закрытые попытки могут содержать подтверждённый расход поставщика.
fn spent_entry(entry: &Value) -> bool {
    matches!(entry["status"].as_str(), Some("completed" | "failed" | "interrupted"))
}

fn cost_tracked(entry: &Value) -> bool {
    entry["cost_tracked"] == true
}

fn reserved_tokens(entry: &Value) -> i64 {
    if cost_tracked(entry) || strict_str(entry.get("status"), "reserved") {
        safe_token_count(entry.get("reserved_tokens"))
    } else {
        0
    }
}

tokio::task_local! {
    static PROVIDER_RECEIPT: Arc<Mutex<ProviderReceipt>>;
}

#[derive(Clone, Default)]
struct ProviderReceipt {
    generation_id: Option<String>,
    usage: Option<Value>,
}

/// Сохраняет ID, как только поставщик его прислал. Он доступен и после
/// отмены future запроса, когда конечного `usage` могло ещё не быть.
pub fn record_provider_generation_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 160 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)) {
        return false;
    }
    let _ = PROVIDER_RECEIPT.try_with(|receipt| {
        receipt.lock().unwrap_or_else(PoisonError::into_inner).generation_id.get_or_insert_with(|| value.to_string());
    });
    true
}

/// У SSE-ответа итоговый usage может прийти раньше окончания соединения.
pub fn record_provider_usage(usage: &Value) {
    if usage.is_object() {
        let _ = PROVIDER_RECEIPT.try_with(|receipt| {
            receipt.lock().unwrap_or_else(PoisonError::into_inner).usage = Some(usage.clone());
        });
    }
}

/// `normalizeProviderUsage(usage, fallbackTokens)`: токены и цена из ответа
/// поставщика в обоих принятых написаниях. `usage` не-объект — как пустой
/// объект (JS на `null` бросил бы `TypeError`; `settle` это повторяет сам).
pub fn normalize_provider_usage(usage: Option<&Value>, fallback_tokens: Option<&Value>) -> Value {
    let get = |key: &str| field(usage, key);
    let input = safe_token_count(nullish(get("input_tokens"), get("prompt_tokens")));
    let output = safe_token_count(nullish(get("output_tokens"), get("completion_tokens")));
    let mut total = safe_token_count(get("total_tokens"));
    if total == 0 {
        total = input + output;
    }
    if total == 0 {
        // `fallbackTokens = 0` по умолчанию: у `undefined` и `0` исход один.
        total = safe_token_count(fallback_tokens);
    }
    json!({
        "input_tokens": input,
        "output_tokens": output,
        "total_tokens": total,
        "provider_cost": js::num(safe_cost(nullish(get("cost"), get("total_cost")))),
    })
}

/// Настройки `new DurableUsageLedger({ storageFile, dailyTokenLimit, retentionDays, reservationTtlMs, now })`.
/// Недопустимые числа (не целые, не положительные) заменяются умолчаниями, как в JS.
pub struct UsageLedgerOptions {
    pub storage_file: PathBuf,
    pub daily_token_limit: Option<f64>,
    pub retention_days: Option<f64>,
    pub reservation_ttl_ms: Option<f64>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl UsageLedgerOptions {
    pub fn new(storage_file: impl Into<PathBuf>) -> Self {
        Self { storage_file: storage_file.into(), daily_token_limit: None, retention_days: None, reservation_ttl_ms: None, now: Arc::new(sk_core::clock::now_ms) }
    }
}

/// Резерв (`ledger.reserve({ requestId, estimatedTokens, scope, model })`).
/// `None` — поле не передано (`undefined`), и действует умолчание JS.
#[derive(Debug, Clone, Default)]
pub struct ReserveRequest {
    pub request_id: Option<String>,
    pub estimated_tokens: f64,
    pub scope: Option<String>,
    pub model: Option<String>,
    pub role: Option<String>,
}

/// `DurableUsageLedger`.
///
/// Каждая операция читает файл, меняет и пишет его целиком; в JS это атомарно
/// по устройству цикла событий, здесь — под внутренним замком.
pub struct DurableUsageLedger {
    storage_file: PathBuf,
    daily_token_limit: i64,
    retention_days: i64,
    reservation_ttl_ms: i64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    lock: Mutex<()>,
}

impl DurableUsageLedger {
    pub fn new(options: UsageLedgerOptions) -> Result<Self, UsageLedgerError> {
        if options.storage_file.as_os_str().is_empty() {
            return Err(UsageLedgerError::Type("DurableUsageLedger requires storageFile".into()));
        }
        Ok(Self {
            storage_file: resolve(&options.storage_file),
            daily_token_limit: positive_or(options.daily_token_limit, DEFAULT_DAILY_TOKEN_LIMIT),
            retention_days: positive_or(options.retention_days, DEFAULT_RETENTION_DAYS),
            reservation_ttl_ms: positive_or(options.reservation_ttl_ms, DEFAULT_RESERVATION_TTL_MS),
            now: options.now,
            lock: Mutex::new(()),
        })
    }

    /// Файл учёта.
    pub fn storage_file(&self) -> &Path {
        &self.storage_file
    }

    /// Дневная квота.
    pub fn daily_token_limit(&self) -> i64 {
        self.daily_token_limit
    }

    /// Текущее время учёта (`ledger.now()`).
    pub fn now(&self) -> i64 {
        (self.now)()
    }

    fn read(&self) -> Result<Value, UsageLedgerError> {
        if !self.storage_file.exists() {
            return Ok(empty_ledger());
        }
        let parsed = read_utf8(&self.storage_file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
        match parsed {
            Some(value) if strict_number(value.get("schema_version"), LEDGER_SCHEMA_VERSION) && value.get("requests").is_some_and(Value::is_object) => Ok(value),
            _ => Err(ledger_error("USAGE_LEDGER_CORRUPT", format!("Usage ledger is corrupt and will not be overwritten: {}", self.storage_file.display()))),
        }
    }

    fn write(&self, ledger: &Value) -> Result<(), UsageLedgerError> {
        atomic_write(&self.storage_file, format!("{}\n", stringify_pretty(ledger)).as_bytes())?;
        Ok(())
    }

    fn prune(&self, ledger: &mut Value, now: i64) -> Result<(), UsageLedgerError> {
        let oldest = (now - self.retention_days * 24 * 60 * 60 * 1000) as f64;
        let Some(requests) = ledger.get_mut("requests").and_then(Value::as_object_mut) else { return Ok(()) };
        let ids: Vec<String> = js::keys(requests).into_iter().cloned().collect();
        for id in ids {
            let Some(entry) = requests.get_mut(&id) else { continue };
            if entry.is_null() {
                return Err(UsageLedgerError::Type("Cannot read properties of null (reading 'created_at_ms')".into()));
            }
            let created = number(field(Some(entry), "created_at_ms"));
            if !created.is_finite() || created < oldest {
                requests.shift_remove(&id);
            } else if strict_str(field(Some(entry), "status"), "reserved") && number(field(Some(entry), "expires_at_ms")) <= now as f64 {
                let tracked = cost_tracked(entry);
                if let Some(entry) = entry.as_object_mut() {
                    let status = if tracked { "interrupted" } else { "expired" };
                    entry.insert("status".into(), Value::String(status.into()));
                    if tracked {
                        entry.insert("error_code".into(), json!("LLM_ATTEMPT_INTERRUPTED"));
                    } else {
                        entry.insert("reserved_tokens".into(), Value::from(0));
                    }
                    entry.insert("finished_at_ms".into(), Value::from(now));
                }
            }
        }
        Ok(())
    }

    fn today<'a>(ledger: &'a Value, now: i64) -> Vec<&'a Value> {
        let day = day_key(now);
        match ledger.get("requests") {
            Some(Value::Object(requests)) => js::entries(requests).into_iter().map(|(_, entry)| entry).filter(|entry| strict_str(field(Some(entry), "day"), &day)).collect(),
            _ => Vec::new(),
        }
    }

    fn used_today(ledger: &Value, now: i64) -> i64 {
        Self::today(ledger, now)
            .into_iter()
            .map(|entry| {
                reserved_tokens(entry)
                    + if spent_entry(entry) { safe_token_count(field(Some(entry), "total_tokens")) } else { 0 }
            })
            .sum()
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `reserve({ requestId, estimatedTokens, scope, model })`: резерв оценки до
    /// вызова поставщика; повтор того же `requestId` с теми же параметрами
    /// возвращает прежнюю запись.
    pub fn reserve(&self, request: &ReserveRequest) -> Result<Value, UsageLedgerError> {
        self.reserve_request(request, false)
    }

    fn reserve_request(&self, request: &ReserveRequest, track_cost: bool) -> Result<Value, UsageLedgerError> {
        let _guard = self.guard();
        let id = clean_str(&request.request_id.clone().unwrap_or_else(sk_core::hash::uuid_v4), 160);
        if id.is_empty() {
            return Err(ledger_error("USAGE_REQUEST_ID_INVALID", "Usage request id is required".into()));
        }
        let requested = request.estimated_tokens;
        if !is_safe_integer(requested) || requested <= 0.0 {
            return Err(UsageLedgerError::Type("estimatedTokens must be a positive integer".into()));
        }
        let requested = requested as i64;
        // Повтор сравнивается с тем, что записано: пустые scope и model
        // хранятся как 'global' и 'unknown' (прежде повтор такого резерва
        // всегда давал USAGE_IDEMPOTENCY_CONFLICT).
        let scope = Some(clean_str(request.scope.as_deref().unwrap_or("global"), 120)).filter(|scope| !scope.is_empty()).unwrap_or_else(|| "global".into());
        let model = Some(clean_str(request.model.as_deref().unwrap_or("unknown"), 160)).filter(|model| !model.is_empty()).unwrap_or_else(|| "unknown".into());
        let role = request.role.as_deref().map(|role| clean_str(role, 120)).filter(|role| !role.is_empty());
        let now = self.now();
        let mut ledger = self.read()?;
        self.prune(&mut ledger, now)?;
        if let Some(existing) = ledger["requests"].get(&id).filter(|entry| js::truthy(Some(entry))) {
            if !strict_str(field(Some(existing), "scope"), &scope)
                || !strict_str(field(Some(existing), "model"), &model)
                || !strict_number(field(Some(existing), "estimated_tokens"), requested as f64)
            {
                return Err(ledger_error("USAGE_IDEMPOTENCY_CONFLICT", format!("Usage request id {id} was reused with different parameters")));
            }
            return Ok(existing.clone());
        }
        let used = Self::used_today(&ledger, now);
        if used + requested > self.daily_token_limit {
            return Err(UsageLedgerError::QuotaExceeded { limit: self.daily_token_limit, used, requested });
        }
        let mut entry = json!({
            "request_id": id,
            "day": day_key(now),
            "scope": scope,
            "model": model,
            "status": "reserved",
            "estimated_tokens": requested,
            "reserved_tokens": requested,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "provider_cost": 0,
            "created_at_ms": now,
            "expires_at_ms": now + self.reservation_ttl_ms,
            "finished_at_ms": null,
            "error_code": null,
        });
        if let Some(role) = role {
            if let Some(map) = entry.as_object_mut() {
                map.insert("role".into(), Value::String(role));
            }
        }
        if track_cost {
            entry["cost_tracked"] = Value::Bool(true);
            entry["provider_cost"] = Value::Null;
        }
        if let Some(requests) = ledger["requests"].as_object_mut() {
            requests.insert(id, entry.clone());
        }
        self.write(&ledger)?;
        Ok(entry)
    }

    fn open_entry<'a>(ledger: &'a mut Value, id: &str) -> Result<&'a mut Value, UsageLedgerError> {
        ledger["requests"]
            .get_mut(id)
            .filter(|entry| js::truthy(Some(entry)))
            .ok_or_else(|| ledger_error("USAGE_RESERVATION_NOT_FOUND", format!("Unknown usage reservation {id}")))
    }

    /// `settle(requestId, usage)`: закрыть резерв фактическим расходом.
    /// `usage = None` — аргумент не передан (`{}`).
    pub fn settle(&self, request_id: &str, usage: Option<&Value>) -> Result<Value, UsageLedgerError> {
        self.settle_reported_model(request_id, usage, None, None)
    }

    fn settle_reported_model(&self, request_id: &str, usage: Option<&Value>, reported_model: Option<&str>, generation_id: Option<&str>) -> Result<Value, UsageLedgerError> {
        let _guard = self.guard();
        let id = clean_str(request_id, 160);
        let now = self.now();
        let mut ledger = self.read()?;
        self.prune(&mut ledger, now)?;
        let entry = Self::open_entry(&mut ledger, &id)?;
        if strict_str(field(Some(entry), "status"), "completed") {
            return Ok(entry.clone());
        }
        if !strict_str(field(Some(entry), "status"), "reserved") {
            return Err(ledger_error("USAGE_RESERVATION_CLOSED", format!("Usage reservation {id} is {}", template(field(Some(entry), "status")))));
        }
        if matches!(usage, Some(Value::Null)) {
            return Err(UsageLedgerError::Type("Cannot read properties of null (reading 'input_tokens')".into()));
        }
        let track_cost = cost_tracked(entry);
        let fallback = (!track_cost).then(|| field(Some(&*entry), "estimated_tokens")).flatten();
        let mut normalized = normalize_provider_usage(usage, fallback);
        if track_cost {
            normalized["provider_cost"] = reported_cost(usage).map_or(Value::Null, js::num);
        }
        let actual_model = reported_model.map(|model| clean_str(model, 160)).filter(|model| !model.is_empty() && model != "openrouter/free");
        if let Some(map) = entry.as_object_mut() {
            map.insert("status".into(), Value::String("completed".into()));
            if let Some(id) = generation_id {
                map.insert("provider_generation_id".into(), json!(id));
            }
            if !track_cost || safe_token_count(normalized.get("total_tokens")) > 0 {
                map.insert("reserved_tokens".into(), Value::from(0));
            }
            if let Value::Object(normalized) = normalized {
                for (key, value) in normalized {
                    map.insert(key, value);
                }
            }
            if map.get("model").and_then(Value::as_str) == Some("openrouter/free") {
                if let Some(model) = actual_model {
                    map.insert("reported_model".into(), Value::String(model));
                }
            }
            map.insert("finished_at_ms".into(), Value::from(now));
        }
        let result = entry.clone();
        self.write(&ledger)?;
        Ok(result)
    }

    /// Закрывает резерв неудачной попытки.
    ///
    /// Аудит PR #131, COST-01: если поставщик ответил и назвал свой расход, а
    /// ответ отвергнут как непригодный, этот расход записывается в ту же запись
    /// (`provider_usage`) и считается в дневной квоте и отчёте наравне с
    /// успешным. Без `provider_usage` — таймаут, сеть, отказ до отправки — расход
    /// неизвестен: резерв освобождается, как раньше, и ничего не списывается.
    /// `error_code = None` — `'LLM_ERROR'`.
    pub fn fail(&self, request_id: &str, error_code: Option<&str>, provider_usage: Option<&Value>) -> Result<Value, UsageLedgerError> {
        self.close_failure(request_id, error_code, provider_usage, false, None)
    }

    fn close_failure(&self, request_id: &str, error_code: Option<&str>, provider_usage: Option<&Value>, interrupted: bool, generation_id: Option<&str>) -> Result<Value, UsageLedgerError> {
        let _guard = self.guard();
        let id = clean_str(request_id, 160);
        let now = self.now();
        let mut ledger = self.read()?;
        self.prune(&mut ledger, now)?;
        let entry = Self::open_entry(&mut ledger, &id)?;
        if !strict_str(field(Some(entry), "status"), "reserved") {
            return Ok(entry.clone());
        }
        let mut known = provider_usage.filter(|usage| usage.is_object()).map(|usage| normalize_provider_usage(Some(usage), None));
        if cost_tracked(entry) {
            if let Some(known) = &mut known {
                known["provider_cost"] = reported_cost(provider_usage).map_or(Value::Null, js::num);
            }
        }
        let code = clean_str(error_code.unwrap_or("LLM_ERROR"), 80);
        if let Some(map) = entry.as_object_mut() {
            map.insert("status".into(), Value::String(if interrupted { "interrupted" } else { "failed" }.into()));
            if let Some(id) = generation_id {
                map.insert("provider_generation_id".into(), json!(id));
            }
            if !interrupted || known.as_ref().is_some_and(|usage| safe_token_count(usage.get("total_tokens")) > 0) {
                map.insert("reserved_tokens".into(), Value::from(0));
            }
            if let Some(Value::Object(known)) = known {
                for (key, value) in known {
                    map.insert(key, value);
                }
            }
            map.insert("finished_at_ms".into(), Value::from(now));
            map.insert("error_code".into(), Value::String(if code.is_empty() { "LLM_ERROR".into() } else { code }));
        }
        let result = entry.clone();
        self.write(&ledger)?;
        Ok(result)
    }

    /// `report()`: сводка за текущие сутки (UTC). Файл переписывается и здесь —
    /// так обрезаются старые записи.
    pub fn report(&self) -> Result<Value, UsageLedgerError> {
        let _guard = self.guard();
        let now = self.now();
        let mut ledger = self.read()?;
        self.prune(&mut ledger, now)?;
        self.write(&ledger)?;
        let entries = Self::today(&ledger, now);
        let status = |entry: &&Value, wanted: &str| strict_str(field(Some(entry), "status"), wanted);
        // Расход — это всё, что поставщик назвал: успешные ответы и отвергнутые
        // непригодные (COST-01). У прочих неудач токены нулевые.
        let spent: Vec<&Value> = entries.iter().copied().filter(|entry| spent_entry(entry)).collect();
        let sum = |list: &[&Value], key: &str| list.iter().map(|entry| safe_token_count(field(Some(entry), key))).sum::<i64>();
        let cost = spent.iter().fold(0.0, |total, entry| total + safe_cost(field(Some(entry), "provider_cost")));
        let mut report = json!({
            "day": day_key(now),
            "daily_token_limit": self.daily_token_limit,
            "committed_tokens": sum(&spent, "total_tokens"),
            "reserved_tokens": entries.iter().map(|entry| reserved_tokens(entry)).sum::<i64>(),
            "input_tokens": sum(&spent, "input_tokens"),
            "output_tokens": sum(&spent, "output_tokens"),
            "provider_cost": js::num(cost),
            "requests": entries.len(),
            "completed_requests": entries.iter().filter(|entry| status(entry, "completed")).count(),
            "failed_requests": entries.iter().filter(|entry| status(entry, "failed")).count(),
        });
        let interrupted = entries.iter().filter(|entry| status(entry, "interrupted")).count();
        let unknown = entries.iter().filter(|entry| cost_tracked(entry) && entry["provider_cost"].is_null()).count();
        let confirmed = spent.iter().filter(|entry| cost_tracked(entry) && entry["provider_cost"].is_number()).count();
        if interrupted > 0 {
            report["interrupted_requests"] = json!(interrupted);
        }
        if unknown > 0 {
            report["unknown_cost_requests"] = json!(unknown);
        }
        if confirmed > 0 {
            report["confirmed_cost_requests"] = json!(confirmed);
        }
        Ok(report)
    }
}

/// Оценка входа в токенах: байты UTF-8 сообщений.
///
/// One token cannot encode more input units than the UTF-8 byte stream has
/// bytes. Reserving the full byte length is deliberately conservative and
/// prevents multilingual prompts from under-reserving the durable quota.
pub fn estimated_input_tokens(input: &Value) -> i64 {
    let messages = if input.is_array() { Some(input) } else { field(Some(input), "messages") };
    let messages = match messages {
        Some(value) if !value.is_null() => value.clone(),
        _ => json!([]),
    };
    (stringify(&messages).len() as i64).max(1)
}

// ---------------------------------------------------------------------------
// Клиент модели
// ---------------------------------------------------------------------------

/// Будущее клиента модели.
pub type LlmFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Ошибка клиента модели (`LLMError` и прочие ошибки, которые JS ловит по
/// `error.code ?? error.name`). `provider_usage` — расход, который поставщик
/// назвал в ответе, отвергнутом как непригодный (COST-01).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct LlmError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
    pub details: Map<String, Value>,
    pub provider_usage: Option<Value>,
}

impl LlmError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { name: "LLMError".into(), code: Some(code.into()), message: message.into(), details: Map::new(), provider_usage: None }
    }
}

impl From<UsageLedgerError> for LlmError {
    fn from(error: UsageLedgerError) -> Self {
        Self {
            name: error.name().into(),
            code: error.code().map(String::from),
            message: error.to_string(),
            details: error.details(),
            provider_usage: None,
        }
    }
}

/// Клиент модели (контракт `LLMClient` из `server/contracts.mjs`).
///
/// `input` — массив сообщений или объект запроса (`{ messages, maxTokens,
/// model, usageScope, usageRequestId, … }`), `options` — объект тех же
/// параметров. `complete` отдаёт ответ в форме JS: `{ role, content, json?,
/// model, usage, provider, … }`; `usage` — расход поставщика.
pub trait LlmClient: Send + Sync {
    /// `client.model`.
    fn model(&self) -> Option<String>;
    /// Имя провайдера для диагностики, без его адреса или настроек.
    fn trace_provider(&self) -> Option<&str> {
        None
    }
    /// `client.models` (список моделей каскада), если есть.
    fn models(&self) -> Option<Value> {
        None
    }
    /// `client.maxTokens`, если есть.
    fn max_tokens(&self) -> Option<Value> {
        None
    }
    /// `client.timeoutMs` — лимит модели, который читает каскад, если есть.
    fn model_timeout_ms(&self) -> Option<f64> {
        None
    }
    /// `client.complete(input, options)`.
    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>>;
    /// `client.probe()`.
    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>>;
    /// `client.health()`.
    fn health(&self) -> Value;

    /// `completeJson(input, options)`: `complete` с `json: true`, ответ — `result.json`
    /// (`null`, если его нет).
    fn complete_json<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async move {
            let options = js::spread(&normalize_options(options), json!({ "json": true }));
            let result = self.complete(input, &options).await?;
            Ok(result.get("json").cloned().unwrap_or(Value::Null))
        })
    }

    /// Текст ответа (`result.content`) — для ролей, которые читают только его.
    fn complete_text<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<String, LlmError>> {
        Box::pin(async move {
            let result = self.complete(input, options).await?;
            Ok(js::s(result.get("content")))
        })
    }
}

/// Общий клиент: один и тот же клиент модели держат несколько владельцев
/// (каскад, роли), как одну ссылку на объект в JS.
impl<T: LlmClient + ?Sized> LlmClient for Arc<T> {
    fn model(&self) -> Option<String> {
        (**self).model()
    }

    fn trace_provider(&self) -> Option<&str> {
        (**self).trace_provider()
    }

    fn models(&self) -> Option<Value> {
        (**self).models()
    }

    fn max_tokens(&self) -> Option<Value> {
        (**self).max_tokens()
    }

    fn model_timeout_ms(&self) -> Option<f64> {
        (**self).model_timeout_ms()
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        (**self).complete(input, options)
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        (**self).probe()
    }

    fn health(&self) -> Value {
        (**self).health()
    }

    // Переопределения внутреннего клиента (учёт расхода, заглушка с
    // собственным `completeJson`) не должны теряться за общей ссылкой.
    fn complete_json<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        (**self).complete_json(input, options)
    }

    fn complete_text<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<String, LlmError>> {
        (**self).complete_text(input, options)
    }
}

fn normalize_options(options: &Value) -> Value {
    if options.is_object() {
        options.clone()
    } else {
        json!({})
    }
}

/// `MeteredLLMClient`: каждый вызов — резерв в ledger до поставщика, затем
/// `settle` по его `usage` или `fail` с кодом ошибки и известным расходом.
pub struct MeteredLLMClient<C: LlmClient> {
    client: C,
    ledger: Arc<DurableUsageLedger>,
}

struct ActiveModelReservation<'a> {
    ledger: &'a DurableUsageLedger,
    id: String,
    open: bool,
    receipt: Arc<Mutex<ProviderReceipt>>,
}

impl Drop for ActiveModelReservation<'_> {
    fn drop(&mut self) {
        if self.open {
            let receipt = self.receipt.lock().unwrap_or_else(PoisonError::into_inner);
            if self.ledger.close_failure(&self.id, Some("LLM_ATTEMPT_INTERRUPTED"), receipt.usage.as_ref(), true, receipt.generation_id.as_deref()).is_err() {
                eprintln!("[Сказание] Не удалось закрыть резерв оборванного запроса модели");
            }
        }
    }
}

impl<C: LlmClient> MeteredLLMClient<C> {
    pub fn new(client: C, ledger: Arc<DurableUsageLedger>) -> Self {
        Self { client, ledger }
    }

    /// Обёрнутый клиент.
    pub fn inner(&self) -> &C {
        &self.client
    }

    /// `usage()`: отчёт ledger.
    pub fn usage(&self) -> Result<Value, UsageLedgerError> {
        self.ledger.report()
    }

    async fn metered_complete(&self, input: &Value, options: &Value) -> Result<Value, LlmError> {
        let request = if input.is_array() {
            json!({ "messages": input })
        } else if input.is_null() {
            json!({})
        } else {
            input.clone()
        };
        let option = |key: &str| field(Some(options), key);
        let from_request = |key: &str| field(Some(&request), key);
        let client_max = self.client.max_tokens();
        let maximum = nullish(nullish(option("maxTokens"), from_request("maxTokens")), client_max.as_ref());
        let maximum_output = match maximum {
            None => 1200,
            value => positive_or(Some(js::number(value)), 1200),
        };
        let mut request_id = clean_text(nullish(option("usageRequestId"), from_request("usageRequestId")), 160);
        if request_id.is_empty() {
            request_id = sk_core::hash::uuid_v4();
        }
        let scope = nullish(option("usageScope"), from_request("usageScope")).map(|value| js::s(Some(value))).unwrap_or_else(|| "global".into());
        let role = nullish(nullish(option("usageRole"), option("role")), nullish(from_request("usageRole"), from_request("role"))).map(|value| js::s(Some(value))).filter(|role| !role.is_empty());
        let model = match nullish(option("model"), from_request("model")) {
            Some(value) => Some(js::s(Some(value))),
            None => self.client.model(),
        };
        let reservation = self.ledger.reserve_request(&ReserveRequest {
            request_id: Some(request_id),
            estimated_tokens: (estimated_input_tokens(input) + maximum_output) as f64,
            scope: Some(scope),
            model,
            role,
        }, true)?;
        let receipt = Arc::new(Mutex::new(ProviderReceipt::default()));
        let mut reservation = ActiveModelReservation { ledger: &self.ledger, id: js::s(reservation.get("request_id")), open: true, receipt: Arc::clone(&receipt) };
        let call = PROVIDER_RECEIPT.scope(Arc::clone(&receipt), self.client.complete(input, options)).await;
        let receipt = receipt.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let outcome = match call {
            Ok(result) => {
                let usage = match field(Some(&result), "usage") {
                    Some(usage) if !usage.is_null() => usage.clone(),
                    _ => receipt.usage.clone().unwrap_or_else(|| json!({})),
                };
                match self.ledger.settle_reported_model(&reservation.id, Some(&usage), result.get("model").and_then(Value::as_str), receipt.generation_id.as_deref()) {
                    Ok(_) => {
                        reservation.open = false;
                        return Ok(result);
                    }
                    Err(error) => LlmError::from(error),
                }
            }
            Err(error) => error,
        };
        // Аудит PR #131, COST-01: RouterAIClient прикладывает к ошибке
        // непригодного ответа известный usage — он оплачен и уходит в ledger.
        let code = outcome.code.clone().unwrap_or_else(|| outcome.name.clone());
        let interrupted = matches!(code.as_str(), "LLM_ABORTED" | "LLM_TIMEOUT" | "LLM_TURN_DEADLINE" | "LLM_ATTEMPT_BUDGET" | "LLM_ATTEMPT_INTERRUPTED");
        self.ledger.close_failure(&reservation.id, Some(&code), outcome.provider_usage.as_ref().or(receipt.usage.as_ref()), interrupted, receipt.generation_id.as_deref())?;
        reservation.open = false;
        Err(outcome)
    }
}

impl<C: LlmClient> LlmClient for MeteredLLMClient<C> {
    fn model(&self) -> Option<String> {
        self.client.model()
    }

    fn trace_provider(&self) -> Option<&str> {
        self.client.trace_provider()
    }

    fn models(&self) -> Option<Value> {
        self.client.models()
    }

    /// `get timeoutMs()`: лимит обёрнутого клиента. Без него каскад не видел
    /// лимита модели за обёрткой учёта.
    fn model_timeout_ms(&self) -> Option<f64> {
        self.client.model_timeout_ms()
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(self.metered_complete(input, options))
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        self.client.probe()
    }

    fn health(&self) -> Value {
        self.client.health()
    }
}
