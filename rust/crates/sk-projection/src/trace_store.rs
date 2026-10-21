//! Перенос `server/trace-store.mjs` — журнал трасс хода (`/why`): вычистка
//! секретов перед записью ([`redact_trace`]), файловое хранилище трасс
//! кампании ([`FileTraceStore`]), чтение старых трасс в форме v2
//! ([`migrate_trace_to_v2`]) и разбор хода для зрителя
//! ([`build_turn_explanation`]).
//!
//! Отличия от JS — только там, где JS не может вести себя иначе на JSON:
//! - циклов в `serde_json::Value` не бывает, поэтому `[CIRCULAR]` недостижим;
//! - `readdirSync` порядка не обещает; здесь имена файлов перед устойчивой
//!   сортировкой по `created_at` упорядочены по байтам, так трассы с одинаковым
//!   временем идут детерминированно;
//! - `predicate` — замыкание Rust вместо функции JS.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sk_core::{clock, hash, js, re, text};

/// `TURN_TRACE_SCHEMA_VERSION`.
pub const TURN_TRACE_SCHEMA_VERSION: &str = "turn-trace/v2";

/// Ошибка хранилища: `TypeError` JS (неверный идентификатор, нет `rootDir`),
/// сбой файловой системы или неразборчивый JSON трассы.
#[derive(Debug)]
pub enum TraceStoreError {
    Type(String),
    Io(io::Error),
    Json(String),
}

impl std::fmt::Display for TraceStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TraceStoreError::Type(message) => write!(f, "TypeError: {message}"),
            TraceStoreError::Io(error) => write!(f, "{error}"),
            TraceStoreError::Json(message) => write!(f, "SyntaxError: {message}"),
        }
    }
}

impl std::error::Error for TraceStoreError {}

impl From<io::Error> for TraceStoreError {
    fn from(error: io::Error) -> Self {
        TraceStoreError::Io(error)
    }
}

pub type TraceStoreResult<T> = Result<T, TraceStoreError>;

fn is_safe_id(id: &str) -> bool {
    text::test(re!(r"^[A-Za-z0-9._-]{1,120}$"), id)
}

/// `safeId(value, label)`: `String(value || '')`.
fn safe_id(value: Option<&Value>, label: &str) -> TraceStoreResult<String> {
    let id = if js::truthy(value) { js::s(value) } else { String::new() };
    if !is_safe_id(&id) {
        return Err(TraceStoreError::Type(format!("Некорректный {label}")));
    }
    Ok(id)
}

/// `SECRET_KEY`: флаг `i` без `u` сворачивает регистр только у ASCII, поэтому
/// ключ приводится к нижнему регистру по ASCII и ищется подстрока.
fn secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["api_key", "api-key", "apikey", "authorization", "cookie", "password", "passwd", "secret", "session", "token", "environment", "env"].iter().any(|word| lower.contains(word))
}

/// `text.slice(0, units)` по единицам UTF-16.
fn head16(value: &str, units: usize) -> String {
    let mut taken = 0;
    let mut out = String::new();
    for ch in value.chars() {
        taken += ch.len_utf16();
        if taken > units {
            break;
        }
        out.push(ch);
    }
    out
}

fn redact_node(value: &Value, key: &str) -> Value {
    let value = if key.is_empty() { sk_tactics::security::redact_trace(Some(value), None).unwrap_or(Value::Null) } else { value.clone() };
    if secret_key(key) {
        return Value::String("[REDACTED]".into());
    }
    match &value {
        Value::String(string) => {
            let redacted = text::replace_all(re!(r"[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~-]+", "g"), string, "Bearer [REDACTED]");
            let redacted = text::replace_all(re!(r"(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}", "g"), &redacted, "[REDACTED]");
            Value::String(head16(&redacted, 4000))
        }
        Value::Array(items) => Value::Array(items.iter().take(200).map(|item| redact_node(item, key)).collect()),
        Value::Object(map) => {
            let mut result = Map::new();
            for (child_key, child) in js::entries(map) {
                let redacted = redact_node(child, child_key);
                if child_key != "__proto__" {
                    result.insert(child_key.clone(), redacted);
                }
            }
            Value::Object(result)
        }
        other => other.clone(),
    }
}

/// `redactTrace(value)`: вычистка `security.redactTrace` плюс ключи-секреты,
/// токены в строках, предел 4000 знаков строки и 200 элементов массива.
/// `None` — `undefined`.
pub fn redact_trace(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    Some(redact_node(value, ""))
}

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn or_default(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(value) if !value.is_null() => value.clone(),
        _ => fallback,
    }
}

/// `atomicJson(file, value)`: запись во временный файл и переименование.
fn atomic_json(file: &Path, value: &Value) -> TraceStoreResult<()> {
    let temporary = PathBuf::from(format!("{}.{}.tmp", file.display(), hash::uuid_v4()));
    fs::write(&temporary, js::stringify_pretty(value, 2))?;
    fs::rename(&temporary, file)?;
    Ok(())
}

/// `FileTraceStore`: трассы хода в `<rootDir>/<campaign_id>/<turn_id>.json`.
#[derive(Debug, Clone)]
pub struct FileTraceStore {
    pub root_dir: PathBuf,
}

impl FileTraceStore {
    /// `new FileTraceStore({ rootDir })`.
    pub fn new(root_dir: impl AsRef<Path>) -> TraceStoreResult<Self> {
        let root = root_dir.as_ref();
        if root.as_os_str().is_empty() {
            return Err(TraceStoreError::Type("FileTraceStore требует rootDir".into()));
        }
        let root = std::path::absolute(root)?;
        fs::create_dir_all(&root)?;
        Ok(Self { root_dir: root })
    }

    /// `campaignDir(campaignId)`.
    pub fn campaign_dir(&self, campaign_id: Option<&Value>) -> TraceStoreResult<PathBuf> {
        let directory = self.root_dir.join(safe_id(campaign_id, "campaign_id")?);
        fs::create_dir_all(&directory)?;
        Ok(directory)
    }

    /// `save(input)`: трасса в форме JS, после вычистки.
    pub fn save(&self, input: &Value) -> TraceStoreResult<Value> {
        let source = Some(input);
        let mut trace = Map::new();
        let turn_id = get(source, "turn_id").filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| Value::String(hash::uuid_v4()));
        trace.insert("turn_id".into(), turn_id);
        if let Some(campaign) = get(source, "campaign_id") {
            trace.insert("campaign_id".into(), campaign.clone());
        }
        trace.insert("idempotency_key".into(), or_default(get(source, "idempotency_key"), Value::Null));
        trace.insert("request_fingerprint".into(), or_default(get(source, "request_fingerprint"), Value::Null));
        trace.insert("engine_mode".into(), Value::String("enforce".into()));
        trace.insert("prompt_versions".into(), or_default(get(source, "prompt_versions"), Value::Object(Map::new())));
        trace.insert("model_identifiers".into(), or_default(get(source, "model_identifiers"), Value::Object(Map::new())));
        if let Some(contexts @ Value::Array(_)) = get(source, "agent_contexts") {
            trace.insert("agent_contexts".into(), contexts.clone());
        }
        trace.insert("intent".into(), or_default(get(source, "intent"), Value::Object(Map::new())));
        for key in ["retrieval_queries", "retrieved_rule_ids"] {
            trace.insert(key.into(), or_default(get(source, key), Value::Array(Vec::new())));
        }
        trace.insert("adjudication_plan".into(), or_default(get(source, "adjudication_plan"), Value::Object(Map::new())));
        for key in ["validated_commands", "rolls", "events"] {
            trace.insert(key.into(), or_default(get(source, key), Value::Array(Vec::new())));
        }
        let before = or_default(get(source, "state_version_before"), Value::from(0));
        let after = or_default(get(source, "state_version_after"), before.clone());
        trace.insert("state_version_before".into(), js::num(js::number(Some(&before))));
        trace.insert("state_version_after".into(), js::num(js::number(Some(&after))));
        trace.insert("verification_result".into(), or_default(get(source, "verification_result"), Value::Object(Map::new())));
        trace.insert("latency_ms".into(), js::num(js::number(Some(&or_default(get(source, "latency_ms"), Value::from(0))))));
        trace.insert("token_usage".into(), or_default(get(source, "token_usage"), Value::Object(Map::new())));
        trace.insert("narration_result".into(), or_default(get(source, "narration_result"), Value::Null));
        trace.insert("ruling".into(), or_default(get(source, "ruling"), Value::Null));
        if let Some(recovery) = get(source, "recovery").filter(|value| js::truthy(Some(value))) {
            trace.insert("recovery".into(), recovery.clone());
        }
        let created = get(source, "created_at").filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| Value::String(clock::iso(clock::now_ms())));
        trace.insert("created_at".into(), created);
        let trace = redact_trace(Some(&Value::Object(trace))).unwrap_or(Value::Null);
        let turn_id = safe_id(get(Some(&trace), "turn_id"), "turn_id")?;
        safe_id(get(Some(&trace), "campaign_id"), "campaign_id")?;
        let directory = self.campaign_dir(get(Some(&trace), "campaign_id"))?;
        atomic_json(&directory.join(format!("{turn_id}.json")), &trace)?;
        Ok(trace)
    }

    /// `saveIfAbsent(input)`: `(трасса, created)`; существующую не затирает.
    pub fn save_if_absent(&self, input: &Value) -> TraceStoreResult<(Value, bool)> {
        if let Some(existing) = self.get(get(Some(input), "campaign_id"), get(Some(input), "turn_id"))? {
            return Ok((existing, false));
        }
        Ok((self.save(input)?, true))
    }

    /// `get(campaignId, turnId)`: `None` — трассы нет (`null`).
    pub fn get(&self, campaign_id: Option<&Value>, turn_id: Option<&Value>) -> TraceStoreResult<Option<Value>> {
        let directory = self.campaign_dir(campaign_id)?;
        let file = directory.join(format!("{}.json", safe_id(turn_id, "turn_id")?));
        if !file.exists() {
            return Ok(None);
        }
        parse_file(&file).map(Some)
    }

    /// `latest(campaignId, { predicate })`.
    pub fn latest(&self, campaign_id: Option<&Value>, predicate: Option<&dyn Fn(&Value) -> bool>) -> TraceStoreResult<Option<Value>> {
        Ok(self.recent(campaign_id, Some(&Value::from(1)), predicate)?.into_iter().next())
    }

    /// `recent(campaignId, limit, { predicate })`: свежие трассы, от 1 до 20.
    /// `limit` `None` — `undefined` (3).
    pub fn recent(&self, campaign_id: Option<&Value>, limit: Option<&Value>, predicate: Option<&dyn Fn(&Value) -> bool>) -> TraceStoreResult<Vec<Value>> {
        let directory = self.campaign_dir(campaign_id)?;
        let limit = limit.cloned().unwrap_or(Value::from(3));
        let number = js::number(Some(&limit));
        let number = if number.is_nan() || number == 0.0 { 3.0 } else { number };
        let bounded = number.clamp(1.0, 20.0);
        let mut names: Vec<String> = fs::read_dir(&directory)?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".json") && is_safe_id(&name[..name.len() - 5]))
            .collect();
        names.sort();
        let mut traces = Vec::new();
        for name in names {
            traces.push(parse_file(&directory.join(name))?);
        }
        traces.sort_by(|left, right| text::locale_compare(&js::string(get(Some(right), "created_at")), &js::string(get(Some(left), "created_at"))));
        let filtered: Vec<Value> = match predicate {
            Some(predicate) => traces.into_iter().filter(|trace| predicate(trace)).collect(),
            None => traces,
        };
        Ok(filtered.into_iter().take(bounded as usize).collect())
    }
}

fn parse_file(file: &Path) -> TraceStoreResult<Value> {
    let source = fs::read_to_string(file)?;
    serde_json::from_str(source.trim_start_matches('\u{feff}')).map_err(|error| TraceStoreError::Json(error.to_string()))
}

/// `isMechanicalTrace(trace)`: в трассе есть события, команды или броски.
pub fn is_mechanical_trace(trace: Option<&Value>) -> bool {
    let nonempty = |key: &str| matches!(get(trace, key), Some(Value::Array(items)) if !items.is_empty());
    matches!(trace, Some(Value::Object(_))) && (nonempty("events") || nonempty("validated_commands") || nonempty("rolls"))
}

/// `migrateTraceToV2(trace)`: трасса в форме v2 на чтении, файл не меняется.
pub fn migrate_trace_to_v2(trace: Option<&Value>) -> Option<Value> {
    let source = trace?;
    if !matches!(source, Value::Object(_) | Value::Array(_)) {
        return Some(source.clone());
    }
    let version = get(Some(source), "schema_version");
    if js::s(version) == TURN_TRACE_SCHEMA_VERSION {
        return Some(source.clone());
    }
    let mut out = match source {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        _ => Map::new(),
    };
    out.insert("schema_version".into(), Value::String(TURN_TRACE_SCHEMA_VERSION.into()));
    let from = match version {
        Some(value) if !value.is_null() => js::s(Some(value)),
        _ => "turn-trace/v1".into(),
    };
    out.insert("migrated_from".into(), Value::String(from));
    out.insert("proposal_id".into(), or_default(get(Some(source), "proposal_id"), Value::Null));
    Some(Value::Object(out))
}

/// `buildTurnExplanation(trace, viewer)`: разбор хода; с зрителем — команды,
/// броски, события и решение проходят его проекцию. `Null` — трассы нет.
pub fn build_turn_explanation(trace: Option<&Value>, viewer: Option<&Value>) -> Value {
    if !js::truthy(trace) {
        return Value::Null;
    }
    let record = migrate_trace_to_v2(trace).unwrap_or(Value::Null);
    let record_ref = Some(&record);
    let visible = |value: Value, fallback: Value| -> Value {
        if js::truthy(viewer) {
            match sk_tactics::security::project_visible_state(Some(&value), viewer, None) {
                Some(projected) if !projected.is_null() => projected,
                _ => fallback,
            }
        } else {
            value
        }
    };
    let mut out = Map::new();
    if let Some(turn) = get(record_ref, "turn_id") {
        out.insert("turn_id".into(), turn.clone());
    }
    if let Some(version) = get(record_ref, "schema_version") {
        out.insert("schema_version".into(), version.clone());
    }
    out.insert("proposal_id".into(), or_default(get(record_ref, "proposal_id"), Value::Null));
    if let Some(mode) = get(record_ref, "engine_mode") {
        out.insert("engine_mode".into(), mode.clone());
    }
    out.insert("rules_used".into(), or_default(get(record_ref, "retrieved_rule_ids"), Value::Array(Vec::new())));
    out.insert("commands".into(), visible(or_default(get(record_ref, "validated_commands"), Value::Array(Vec::new())), Value::Array(Vec::new())));
    out.insert("rolls".into(), visible(or_default(get(record_ref, "rolls"), Value::Array(Vec::new())), Value::Array(Vec::new())));
    out.insert("events".into(), visible(or_default(get(record_ref, "events"), Value::Array(Vec::new())), Value::Array(Vec::new())));
    out.insert("ruling".into(), visible(or_default(get(record_ref, "ruling"), Value::Null), Value::Null));
    for key in ["state_version_before", "state_version_after"] {
        if let Some(value) = get(record_ref, key) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("verification".into(), or_default(get(record_ref, "verification_result"), Value::Object(Map::new())));
    if let Some(recovery) = get(record_ref, "recovery").filter(|value| js::truthy(Some(value))) {
        out.insert("recovery".into(), recovery.clone());
    }
    Value::Object(out)
}
