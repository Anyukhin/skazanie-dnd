//! Журнал кампаний — перенос `FileEventStore` (`server/event-store.mjs`) на
//! SQLite.
//!
//! Семантика та же: коммит — пакет событий одной команды с ожидаемой версией и
//! ключом идемпотентности; повтор с тем же ключом и тем же запросом отдаёт
//! прежний коммит, с другим — `IDEMPOTENCY_CONFLICT`; снимок каждые
//! `snapshot_every` событий с контрольной суммой; карты в снимке — ссылками
//! по хешу; загрузка — последний пригодный снимок и хвост журнала через
//! внедрённый редьюсер. Потерянный хвост или исходный снимок —
//! `CAMPAIGN_RECOVERY_REQUIRED`, а не тихая загрузка старого состояния.
//!
//! Отличие от JS — в устройстве, а не в поведении: одна база вместо каталога
//! файлов, коммит — одна транзакция (коммит, снимок и метаданные пишутся
//! вместе или не пишутся вовсе), ключ идемпотентности — уникальный индекс.
//! Тело коммита и снимка — тот же JSON, что в файлах JS, поэтому прежнее
//! хранилище переносится без перевода (`legacy.rs`).

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;

use crate::error::{StoreError, StoreResult};
use crate::maps::{self, MapCells, NoMapCells};
use crate::stable::{sort_object, stable_hash};

pub const STORE_SCHEMA_VERSION: i64 = 1;

/// Режим совместимости редьюсера (`retention-context`): события, записанные
/// прежней версией редьюсера, проигрываются по прежним правилам.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetentionMode {
    Legacy,
    Current,
}

/// Редьюсер, внедряемый в хранилище (в JS — `applyGameEvent` и
/// `normalizeCampaignState`). Хранилище от механики не зависит.
pub trait Reducer: Send + Sync {
    /// Текущая версия редьюсера (`RETENTION_REDUCER_VERSION`).
    fn reducer_version(&self) -> i64;
    /// Версия проектора снимков: снимок другой версии (кроме исходного)
    /// игнорируется, поток переигрывается.
    fn snapshot_projector_version(&self) -> i64 {
        1
    }
    /// Исходное состояние кампании без снимка.
    fn initial_state(&self, _campaign_id: &str) -> Value {
        json!({})
    }
    /// `normalizeCampaignState(state)`.
    fn normalize(&self, state: Value, mode: RetentionMode) -> Value;
    /// `applyGameEvent(state, event)`.
    fn apply(&self, state: Value, event: &Value, mode: RetentionMode) -> Result<Value, String>;
}

/// Редьюсер без механики: события только двигают версию. Для тестов
/// хранилища и инструментов, которым нужен журнал, а не мир.
pub struct VersionOnlyReducer;

impl Reducer for VersionOnlyReducer {
    fn reducer_version(&self) -> i64 {
        1
    }

    fn normalize(&self, state: Value, _mode: RetentionMode) -> Value {
        state
    }

    fn apply(&self, mut state: Value, event: &Value, _mode: RetentionMode) -> Result<Value, String> {
        if let Some(map) = state.as_object_mut() {
            let mut applied = map.get("applied").and_then(Value::as_array).cloned().unwrap_or_default();
            applied.push(event.get("event_type").cloned().unwrap_or(Value::Null));
            map.insert("applied".into(), Value::Array(applied));
        }
        Ok(state)
    }
}

/// Настройки хранилища.
pub struct StoreOptions {
    pub snapshot_every: i64,
    pub max_events_per_commit: usize,
    pub head_cache_limit: usize,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub id_factory: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            snapshot_every: 25,
            max_events_per_commit: 100,
            head_cache_limit: 32,
            clock: Arc::new(sk_core::clock::now_ms),
            id_factory: Arc::new(sk_core::hash::uuid_v4),
        }
    }
}

/// Параметры загрузки (`load`/`replay`).
#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
    pub at_version: Option<i64>,
    pub use_snapshots: Option<bool>,
    pub reducer_version: Option<i64>,
    pub from_initial: bool,
}

/// Загруженная кампания.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub campaign_id: String,
    pub state_version: i64,
    pub current_state_version: i64,
    pub state: Value,
    pub reducer_version: i64,
    pub metadata: Value,
    pub events_applied: usize,
}

impl Loaded {
    pub fn to_json(&self) -> Value {
        json!({
            "campaign_id": self.campaign_id,
            "state_version": self.state_version,
            "current_state_version": self.current_state_version,
            "state": self.state,
            "reducer_version": self.reducer_version,
            "metadata": self.metadata,
            "events_applied": self.events_applied,
        })
    }
}

/// Запрос коммита.
#[derive(Debug, Clone, Default)]
pub struct CommitRequest {
    pub campaign_id: String,
    pub expected_state_version: i64,
    pub idempotency_key: String,
    pub command_id: Option<String>,
    pub events: Vec<Value>,
    pub force_snapshot: bool,
    pub metadata: Value,
}

/// Итог коммита или повтора по ключу идемпотентности.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitResult {
    pub campaign_id: String,
    pub state_version: i64,
    pub current_state_version: i64,
    pub state: Value,
    pub metadata: Value,
    pub events: Vec<Value>,
    pub duplicate: bool,
    pub idempotency_key: String,
    pub command_id: String,
}

impl CommitResult {
    pub fn to_json(&self) -> Value {
        json!({
            "campaign_id": self.campaign_id,
            "state_version": self.state_version,
            "current_state_version": self.current_state_version,
            "state": self.state,
            "metadata": self.metadata,
            "events": self.events,
            "duplicate": self.duplicate,
            "idempotency_key": self.idempotency_key,
            "command_id": self.command_id,
        })
    }

    fn from_loaded(loaded: Loaded, events: Vec<Value>, duplicate: bool, key: &str, command_id: String) -> Self {
        Self {
            campaign_id: loaded.campaign_id,
            state_version: loaded.state_version,
            current_state_version: loaded.current_state_version,
            state: loaded.state,
            metadata: loaded.metadata,
            events,
            duplicate,
            idempotency_key: key.to_string(),
            command_id,
        }
    }
}

/// Запрос создания кампании.
#[derive(Debug, Clone)]
pub struct InitializeRequest {
    pub campaign_id: String,
    pub initial_state: Value,
    pub ruleset_id: String,
    pub ruleset_version: String,
    pub enabled_rule_packs: Vec<String>,
    pub enabled_house_rules: Vec<String>,
    pub metadata: Value,
}

impl InitializeRequest {
    pub fn new(campaign_id: impl Into<String>, initial_state: Value) -> Self {
        Self {
            campaign_id: campaign_id.into(),
            initial_state,
            ruleset_id: "srd_5_2_1".into(),
            ruleset_version: "5.2.1".into(),
            enabled_rule_packs: vec!["srd_5_2_1".into()],
            enabled_house_rules: Vec::new(),
            metadata: json!({}),
        }
    }
}

/// Запрос `importLegacySnapshot`.
#[derive(Debug, Clone)]
pub struct LegacyImportRequest {
    pub campaign_id: String,
    pub legacy_state: Value,
    pub idempotency_key: Option<String>,
    pub command_id: Option<String>,
    pub source: String,
    pub ruleset_id: String,
    pub ruleset_version: String,
    pub enabled_rule_packs: Vec<String>,
    pub enabled_house_rules: Vec<String>,
}

impl LegacyImportRequest {
    pub fn new(campaign_id: impl Into<String>, legacy_state: Value) -> Self {
        Self {
            campaign_id: campaign_id.into(),
            legacy_state,
            idempotency_key: None,
            command_id: None,
            source: "legacy_room_snapshot".into(),
            ruleset_id: "srd_5_2_1".into(),
            ruleset_version: "5.2.1".into(),
            enabled_rule_packs: vec!["srd_5_2_1".into()],
            enabled_house_rules: Vec::new(),
        }
    }
}

/// Отложенная проекция (`pendingProjection`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingProjection {
    pub campaign_id: String,
    pub checkpoint_version: i64,
    pub state_version: i64,
    pub state: Option<Value>,
    pub events: Vec<Value>,
}

struct HeadEntry {
    last_commit_id: String,
    version: i64,
    reducer_version: i64,
    events_applied: usize,
    state: Value,
}

struct Inner {
    conn: Connection,
    head_cache: IndexMap<String, HeadEntry>,
}

/// Журнал кампаний на SQLite.
pub struct EventStore {
    inner: Mutex<Inner>,
    reducer: Arc<dyn Reducer>,
    cells: Arc<dyn MapCells>,
    options: StoreOptions,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commits (
    campaign_id TEXT NOT NULL,
    version_after INTEGER NOT NULL,
    version_before INTEGER NOT NULL,
    commit_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (campaign_id, version_after),
    UNIQUE (campaign_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS snapshots (
    campaign_id TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (campaign_id, state_version)
);
CREATE TABLE IF NOT EXISTS map_blobs (
    hash TEXT PRIMARY KEY,
    body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_overlays (
    room_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

mod rooms;
pub use rooms::{RoomOverlay, RoomOverlaySave, RoomOverlayWrite, RoomProjectionAck};

fn safe_id(value: &str, label: &str) -> StoreResult<String> {
    let result = sk_core::text::trim(value).to_string();
    if result.is_empty() || result.chars().count() > 200 {
        return Err(StoreError::invalid("INVALID_IDENTIFIER", format!("{label} is required and must be at most 200 characters")));
    }
    Ok(result)
}

fn safe_version(value: i64, label: &str) -> StoreResult<i64> {
    if value < 0 {
        return Err(StoreError::invalid("INVALID_STATE_VERSION", format!("{label} must be a non-negative safe integer")));
    }
    Ok(value)
}

fn event_type(input: &Value) -> StoreResult<String> {
    let raw = input.get("event_type").filter(|v| sk_core::js::present(Some(v))).or_else(|| input.get("type"));
    let value = sk_core::text::trim(&sk_core::js::s(raw)).to_string();
    let valid = sk_core::text::test(sk_core::re!(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$"), &value);
    if !valid {
        let shown = if value.is_empty() { "<empty>".to_string() } else { value };
        return Err(StoreError::invalid("INVALID_EVENT_TYPE", format!("Invalid event_type: {shown}")));
    }
    Ok(value)
}

fn unique_strings(value: Option<&Value>) -> Value {
    sk_core::js::strings_value(sk_core::js::unique_strings(value))
}

fn snapshot_checksum(state: &Value) -> String {
    sk_core::hash::sha256_hex(sk_core::js::stringify(&sort_object(state)))
}

fn versioned_state(state: Value, version: i64) -> StoreResult<Value> {
    let Value::Object(mut map) = state else {
        return Err(StoreError::invalid("INVALID_CAMPAIGN_STATE", "Campaign state must be a JSON object"));
    };
    map.insert("state_version".into(), Value::from(version));
    Ok(Value::Object(map))
}

fn int_field(value: &Value, key: &str) -> i64 {
    sk_core::js::safe_int(value.get(key), 0)
}

impl EventStore {
    /// Открыть (или создать) базу по пути.
    pub fn open(path: impl AsRef<Path>, reducer: Arc<dyn Reducer>, options: StoreOptions) -> StoreResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|error| StoreError::new("EVENT_STORE_ERROR", format!("Каталог хранилища: {error}")))?;
        }
        let conn = Connection::open(path)?;
        Self::with_connection(conn, reducer, options)
    }

    /// База в памяти — для тестов.
    pub fn in_memory(reducer: Arc<dyn Reducer>, options: StoreOptions) -> StoreResult<Self> {
        Self::with_connection(Connection::open_in_memory()?, reducer, options)
    }

    fn with_connection(conn: Connection, reducer: Arc<dyn Reducer>, options: StoreOptions) -> StoreResult<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // FULL, а не NORMAL: в WAL с NORMAL последний коммит может откатиться
        // после сбоя питания или краха ОС, и сторож хвоста журнала этого не
        // увидит. JS делает fsync перед rename (`event-store.mjs`), целостность
        // данных — первый приоритет (`AGENTS.md` §9).
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { inner: Mutex::new(Inner { conn, head_cache: IndexMap::new() }), reducer, cells: Arc::new(NoMapCells), options })
    }

    /// Восстановление клеток сцены из карты (тактическая карта).
    pub fn with_map_cells(mut self, cells: Arc<dyn MapCells>) -> Self {
        self.cells = cells;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn now_iso(&self) -> String {
        sk_core::clock::iso((self.options.clock)())
    }

    fn new_id(&self, label: &str) -> StoreResult<String> {
        safe_id(&(self.options.id_factory)(), label)
    }

    fn retention_mode(&self, version: i64, current: i64) -> StoreResult<RetentionMode> {
        if version < 0 {
            return Err(StoreError::invalid("INVALID_REDUCER_VERSION", format!("Некорректная версия reducer: {version}")));
        }
        if version == 0 || version < current {
            return Ok(RetentionMode::Legacy);
        }
        if version == current {
            return Ok(RetentionMode::Current);
        }
        let mut error = StoreError::invalid(
            "UNSUPPORTED_REDUCER_VERSION",
            format!("Версия reducer {version} не поддерживается; текущая версия {current}"),
        );
        error.details = json!({ "reducer_version": version, "current_reducer_version": current });
        Err(error)
    }

    fn normalize_state(&self, state: Value, version: i64, reducer_version: i64) -> StoreResult<Value> {
        let _span = crate::perf::span("store.normalize");
        if !state.is_object() {
            return Err(StoreError::invalid("INVALID_CAMPAIGN_STATE", "Campaign state must be a JSON object"));
        }
        let mode = self.retention_mode(reducer_version, self.reducer.reducer_version())?;
        versioned_state(self.reducer.normalize(state, mode), version)
    }

    fn apply_event(&self, state: Value, event: &Value, forced: Option<i64>, skip_output_normalization: bool) -> StoreResult<Value> {
        let reducer_version = forced.unwrap_or_else(|| int_field(event, "reducer_version"));
        let current = forced.unwrap_or(self.reducer.reducer_version());
        let mode = self.retention_mode(reducer_version, current)?;
        let version_after = int_field(event, "state_version_after");
        if event.get("event_type").and_then(Value::as_str) == Some("LegacyStateImported") {
            if let Some(imported) = event.get("payload").and_then(|payload| payload.get("state")).filter(|value| sk_core::js::truthy(Some(value))) {
                return self.normalize_state(imported.clone(), version_after, reducer_version);
            }
        }
        let reduced = self
            .reducer
            .apply(state, event, mode)
            .map_err(|message| StoreError::new("INVALID_REDUCER_RESULT", format!("{}: {message}", sk_core::js::s(event.get("event_type")))))?;
        if skip_output_normalization && mode == RetentionMode::Current {
            return versioned_state(reduced, version_after);
        }
        self.normalize_state(reduced, version_after, reducer_version)
    }

    fn apply_events(&self, state: Value, events: &[Value], forced: Option<i64>) -> StoreResult<Value> {
        let _span = crate::perf::span("store.apply_events");
        if events.is_empty() {
            return Ok(state);
        }
        let current = self.reducer.reducer_version();
        let fast_path = match forced {
            Some(version) => version == current,
            None => events.iter().all(|event| int_field(event, "reducer_version") == current),
        };
        let mut next = state;
        for event in events {
            next = self.apply_event(next, event, forced, fast_path)?;
        }
        if !fast_path {
            return Ok(next);
        }
        let last = events.last().expect("непустой пакет");
        let reducer_version = forced.unwrap_or_else(|| int_field(last, "reducer_version"));
        self.normalize_state(next, int_field(last, "state_version_after"), reducer_version)
    }

    fn exists(conn: &Connection, campaign_id: &str) -> StoreResult<bool> {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM campaigns WHERE campaign_id = ?1 UNION SELECT 1 FROM snapshots WHERE campaign_id = ?1 UNION SELECT 1 FROM commits WHERE campaign_id = ?1 LIMIT 1",
                params![campaign_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    fn head(conn: &Connection, campaign_id: &str) -> StoreResult<(i64, Option<String>)> {
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT version_after, commit_id FROM commits WHERE campaign_id = ?1 ORDER BY version_after DESC LIMIT 1",
                params![campaign_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(row.map_or((0, None), |(version, id)| (version, Some(id))))
    }

    /// Свидетельства головы журнала (аудит RCV-01): метаданные и снимки не
    /// бывают новее журнала.
    fn check_head_evidence(conn: &Connection, campaign_id: &str, head: i64) -> StoreResult<()> {
        let mut ahead = Vec::new();
        if let Some(metadata) = Self::read_metadata_raw(conn, campaign_id)? {
            if metadata.get("campaign_id").and_then(Value::as_str) == Some(campaign_id) {
                for field in ["state_version", "current_version"] {
                    let value = int_field(&metadata, field);
                    if value > head {
                        ahead.push(json!({ "source": format!("metadata.{field}"), "state_version": value }));
                    }
                }
            }
        }
        let newest: Option<i64> = conn.query_row("SELECT MAX(state_version) FROM snapshots WHERE campaign_id = ?1", params![campaign_id], |row| row.get(0))?;
        if let Some(newest) = newest.filter(|version| *version > head) {
            ahead.push(json!({ "source": format!("snapshots/{newest:016}.json"), "state_version": newest }));
        }
        if !ahead.is_empty() {
            let reached = ahead.iter().map(|item| int_field(item, "state_version")).max().unwrap_or(head);
            return Err(StoreError::recovery_required(
                campaign_id,
                "EVENT_LOG_TAIL_MISSING",
                format!("stored evidence reaches state version {reached}, but the event log ends at {head}"),
                json!({ "log_state_version": head, "evidence_state_version": reached, "evidence": ahead }),
            ));
        }
        Ok(())
    }

    fn read_commits(conn: &Connection, campaign_id: &str, after: i64, up_to: i64) -> StoreResult<Vec<Value>> {
        let mut statement = conn.prepare_cached(
            "SELECT version_before, version_after, body FROM commits WHERE campaign_id = ?1 AND version_after > ?2 AND version_before < ?3 ORDER BY version_after",
        )?;
        let rows = statement.query_map(params![campaign_id, after, up_to], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))?;
        let mut commits = Vec::new();
        let mut expected_before: Option<i64> = None;
        for row in rows {
            let (before, after_version, body) = row?;
            let commit: Value = serde_json::from_str(&body).map_err(|error| StoreError::corrupt(campaign_id, format!("unreadable commit {after_version}: {error}"), json!({})))?;
            if let Some(expected) = expected_before {
                if before != expected {
                    return Err(StoreError::corrupt(campaign_id, format!("non-contiguous commit ending at {after_version}"), json!({ "expected_state_version": expected })));
                }
            }
            let events = commit.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            if events.is_empty() || after_version != before + events.len() as i64 {
                return Err(StoreError::corrupt(campaign_id, format!("invalid version range in commit ending at {after_version}"), json!({})));
            }
            for (index, event) in events.iter().enumerate() {
                let expected = before + index as i64;
                if event.get("campaign_id").and_then(Value::as_str) != Some(campaign_id)
                    || int_field(event, "state_version_before") != expected
                    || int_field(event, "state_version_after") != expected + 1
                {
                    return Err(StoreError::corrupt(campaign_id, format!("invalid event version in commit ending at {after_version}"), json!({ "event_id": event.get("event_id") })));
                }
            }
            expected_before = Some(after_version);
            commits.push(commit);
        }
        Ok(commits)
    }

    fn read_metadata_raw(conn: &Connection, campaign_id: &str) -> StoreResult<Option<Value>> {
        let body: Option<String> = conn.query_row("SELECT metadata FROM campaigns WHERE campaign_id = ?1", params![campaign_id], |row| row.get(0)).optional()?;
        Ok(match body {
            Some(text) => Some(serde_json::from_str(&text)?),
            None => None,
        })
    }

    fn read_metadata(conn: &Connection, campaign_id: &str, state_version: i64) -> StoreResult<Value> {
        let Some(metadata) = Self::read_metadata_raw(conn, campaign_id)? else {
            return Ok(json!({
                "schema_version": STORE_SCHEMA_VERSION,
                "campaign_id": campaign_id,
                "state_version": state_version,
                "current_version": state_version,
                "projection_checkpoint_version": 0,
            }));
        };
        if metadata.get("campaign_id").and_then(Value::as_str) != Some(campaign_id) {
            return Err(StoreError::corrupt(campaign_id, "metadata belongs to another campaign", json!({})));
        }
        Ok(sk_core::js::spread(&metadata, json!({ "state_version": state_version, "current_version": state_version })))
    }

    fn write_metadata(&self, conn: &Connection, campaign_id: &str, current: Option<&Value>, patch: &Value, state_version: i64) -> StoreResult<Value> {
        let timestamp = self.now_iso();
        let mut metadata = Map::new();
        metadata.insert("schema_version".into(), Value::from(STORE_SCHEMA_VERSION));
        metadata.insert("campaign_id".into(), Value::from(campaign_id));
        metadata.insert("ruleset_id".into(), Value::from("srd_5_2_1"));
        metadata.insert("ruleset_version".into(), Value::from("5.2.1"));
        metadata.insert("enabled_rule_packs".into(), json!(["srd_5_2_1"]));
        metadata.insert("enabled_house_rules".into(), json!([]));
        metadata.insert("created_at".into(), current.and_then(|value| value.get("created_at")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::from(timestamp.clone())));
        for source in [current.cloned().unwrap_or_else(sk_core::js::obj), patch.clone()] {
            if let Value::Object(map) = source {
                for (key, value) in map {
                    metadata.insert(key, value);
                }
            }
        }
        let checkpoint_source = patch.get("projection_checkpoint_version").filter(|v| !v.is_null()).or_else(|| current.and_then(|value| value.get("projection_checkpoint_version")));
        let checkpoint = sk_core::js::number(checkpoint_source);
        let checkpoint = if checkpoint.is_finite() { checkpoint.trunc() as i64 } else { 0 };
        metadata.insert("schema_version".into(), Value::from(STORE_SCHEMA_VERSION));
        metadata.insert("campaign_id".into(), Value::from(campaign_id));
        metadata.insert("state_version".into(), Value::from(state_version));
        metadata.insert("current_version".into(), Value::from(state_version));
        metadata.insert("projection_checkpoint_version".into(), Value::from(checkpoint.min(state_version).max(0)));
        metadata.insert("updated_at".into(), Value::from(timestamp));
        let metadata = Value::Object(metadata);
        conn.execute(
            "INSERT INTO campaigns (campaign_id, metadata) VALUES (?1, ?2) ON CONFLICT(campaign_id) DO UPDATE SET metadata = excluded.metadata",
            params![campaign_id, serde_json::to_string(&metadata)?],
        )?;
        Ok(metadata)
    }

    /// Пригодный снимок не новее `target`: контрольная сумма сходится, версия
    /// проектора та же (кроме исходного), карты возвращаются на место.
    fn read_snapshot(&self, conn: &Connection, campaign_id: &str, target: i64, use_snapshots: bool) -> StoreResult<Option<Value>> {
        let mut statement = conn.prepare_cached("SELECT state_version, body FROM snapshots WHERE campaign_id = ?1 AND state_version <= ?2 ORDER BY state_version DESC")?;
        let rows: Vec<(i64, String)> = statement.query_map(params![campaign_id, target], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<_, _>>()?;
        for (version, body) in rows {
            if !use_snapshots && version != 0 {
                continue;
            }
            let snapshot: Value = serde_json::from_str(&body).map_err(|error| StoreError::corrupt(campaign_id, format!("invalid snapshot {version:016}.json: {error}"), json!({})))?;
            if snapshot.get("campaign_id").and_then(Value::as_str) != Some(campaign_id) || int_field(&snapshot, "state_version") != version {
                return Err(StoreError::corrupt(campaign_id, format!("invalid snapshot {version:016}.json"), json!({})));
            }
            let state = snapshot.get("state").cloned().unwrap_or(Value::Null);
            if snapshot.get("checksum").and_then(Value::as_str) != Some(snapshot_checksum(&state).as_str()) {
                return Err(StoreError::corrupt(campaign_id, format!("snapshot checksum mismatch {version:016}.json"), json!({})));
            }
            let projector = sk_core::js::safe_int(snapshot.get("projector_version"), 1);
            if version != 0 && projector != self.reducer.snapshot_projector_version() {
                continue;
            }
            let restored = maps::internalize(conn, &state, self.cells.as_ref())?;
            if !restored.missing.is_empty() {
                continue;
            }
            let mut snapshot = snapshot;
            snapshot["state"] = restored.state;
            return Ok(Some(snapshot));
        }
        Ok(None)
    }

    fn write_snapshot(&self, conn: &Connection, campaign_id: &str, state: &Value, state_version: i64, reducer_version: i64) -> StoreResult<Value> {
        let externalized = maps::externalize(conn, state)?;
        let snapshot = json!({
            "schema_version": STORE_SCHEMA_VERSION,
            "projector_version": self.reducer.snapshot_projector_version(),
            "reducer_version": reducer_version,
            "campaign_id": campaign_id,
            "state_version": state_version,
            "created_at": self.now_iso(),
            "checksum": snapshot_checksum(&externalized),
            "state": externalized,
        });
        let existing: Option<String> = conn
            .query_row("SELECT body FROM snapshots WHERE campaign_id = ?1 AND state_version = ?2", params![campaign_id, state_version], |row| row.get(0))
            .optional()?;
        if let Some(existing) = existing {
            let existing: Value = serde_json::from_str(&existing)?;
            if existing.get("checksum") != snapshot.get("checksum") {
                return Err(StoreError::corrupt(campaign_id, format!("conflicting immutable snapshot {state_version:016}.json"), json!({})));
            }
            return Ok(existing);
        }
        conn.execute("INSERT INTO snapshots (campaign_id, state_version, body) VALUES (?1, ?2, ?3)", params![campaign_id, state_version, serde_json::to_string(&snapshot)?])?;
        Ok(snapshot)
    }

    /// Исходный снимок недоступен (аудит RCV-02): пустое состояние фабрики с
    /// наложенными событиями — не загрузка, а подмена кампании.
    fn assert_seed_available(conn: &Connection, campaign_id: &str, commits: &[Value], target: i64) -> StoreResult<()> {
        if target > 0 {
            let first = commits.first().and_then(|commit| commit.get("events")).and_then(|events| events.get(0));
            if let Some(first) = first {
                if first.get("event_type").and_then(Value::as_str) == Some("LegacyStateImported") && sk_core::js::truthy(first.get("payload").and_then(|payload| payload.get("state"))) {
                    return Ok(());
                }
            }
        }
        let seed: Option<i64> = conn.query_row("SELECT 1 FROM snapshots WHERE campaign_id = ?1 AND state_version = 0", params![campaign_id], |row| row.get(0)).optional()?;
        let file = format!("{:016}.json", 0);
        let (reason, message) = if seed.is_none() {
            ("SEED_SNAPSHOT_MISSING", format!("seed snapshot {file} is missing"))
        } else {
            ("SEED_SNAPSHOT_UNUSABLE", format!("seed snapshot {file} references missing map blobs"))
        };
        Err(StoreError::recovery_required(campaign_id, reason, message, json!({ "state_version": target })))
    }

    fn remember_head(&self, inner: &mut Inner, campaign_id: &str, entry: HeadEntry) {
        inner.head_cache.shift_remove(campaign_id);
        inner.head_cache.insert(campaign_id.to_string(), entry);
        while inner.head_cache.len() > self.options.head_cache_limit.max(1) {
            inner.head_cache.shift_remove_index(0);
        }
    }

    fn load_inner(&self, inner: &mut Inner, campaign_id: &str, options: &LoadOptions) -> StoreResult<Loaded> {
        let (current_version, last_commit_id) = Self::head(&inner.conn, campaign_id)?;
        Self::check_head_evidence(&inner.conn, campaign_id, current_version)?;
        if !Self::exists(&inner.conn, campaign_id)? {
            return Err(StoreError::campaign_not_found(campaign_id));
        }
        let target = match options.at_version {
            Some(version) => safe_version(version, "atVersion")?,
            None => current_version,
        };
        if target > current_version {
            return Err(StoreError::version_conflict(campaign_id, target, current_version));
        }
        let forced = match options.reducer_version {
            Some(version) => Some(safe_version(version, "reducerVersion")?),
            None => None,
        };
        let use_snapshots = options.use_snapshots.unwrap_or(true);
        let head_load = target == current_version && use_snapshots && forced.is_none() && !options.from_initial;
        if head_load {
            if let (Some(last_commit_id), Some(entry)) = (last_commit_id.as_ref(), inner.head_cache.get(campaign_id)) {
                if &entry.last_commit_id == last_commit_id && entry.version == current_version {
                    let _span = crate::perf::span("store.load.cache_hit");
                    let loaded = Loaded {
                        campaign_id: campaign_id.to_string(),
                        state_version: target,
                        current_state_version: current_version,
                        state: entry.state.clone(),
                        reducer_version: entry.reducer_version,
                        metadata: Self::read_metadata(&inner.conn, campaign_id, current_version)?,
                        events_applied: entry.events_applied,
                    };
                    if let Some(entry) = inner.head_cache.shift_remove(campaign_id) {
                        inner.head_cache.insert(campaign_id.to_string(), entry);
                    }
                    return Ok(loaded);
                }
            }
        }
        let _replay = crate::perf::span(if head_load { "store.load.head_replay" } else { "store.load.at_version_replay" });
        let snapshot = if options.from_initial { None } else { self.read_snapshot(&inner.conn, campaign_id, target, use_snapshots)? };
        let (mut state, from_version, selected_reducer_version) = match snapshot {
            Some(snapshot) => {
                let reducer_version = forced.unwrap_or_else(|| int_field(&snapshot, "reducer_version"));
                let version = int_field(&snapshot, "state_version");
                let state = self.normalize_state(snapshot["state"].clone(), version, reducer_version)?;
                (state, version, reducer_version)
            }
            None => {
                let commits = Self::read_commits(&inner.conn, campaign_id, 0, target.max(1))?;
                if !options.from_initial {
                    Self::assert_seed_available(&inner.conn, campaign_id, &commits, target)?;
                }
                let first_event = commits.iter().flat_map(|commit| commit["events"].as_array().cloned().unwrap_or_default()).find(|event| int_field(event, "state_version_after") <= target);
                let reducer_version = forced.unwrap_or_else(|| first_event.as_ref().map_or(0, |event| int_field(event, "reducer_version")));
                let state = self.normalize_state(self.reducer.initial_state(campaign_id), 0, reducer_version)?;
                (state, 0, reducer_version)
            }
        };
        let commits = Self::read_commits(&inner.conn, campaign_id, from_version, target)?;
        let events: Vec<Value> = commits
            .iter()
            .flat_map(|commit| commit["events"].as_array().cloned().unwrap_or_default())
            .filter(|event| {
                let after = int_field(event, "state_version_after");
                after > from_version && after <= target
            })
            .collect();
        state = self.apply_events(state, &events, forced)?;
        let final_reducer_version = forced.unwrap_or_else(|| events.last().map_or(selected_reducer_version, |event| int_field(event, "reducer_version")));
        if head_load {
            if let Some(last_commit_id) = last_commit_id {
                self.remember_head(
                    inner,
                    campaign_id,
                    HeadEntry { last_commit_id, version: current_version, reducer_version: final_reducer_version, events_applied: events.len(), state: state.clone() },
                );
            }
        }
        Ok(Loaded {
            campaign_id: campaign_id.to_string(),
            state_version: target,
            current_state_version: current_version,
            state,
            reducer_version: final_reducer_version,
            metadata: Self::read_metadata(&inner.conn, campaign_id, current_version)?,
            events_applied: events.len(),
        })
    }

    fn normalize_event(&self, raw: &Value, campaign_id: &str, command_id: &str, key: &str, before: i64, timestamp: &str) -> StoreResult<Value> {
        let kind = event_type(raw)?;
        let mut event = match raw {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let event_id_source = raw.get("event_id").filter(|v| !v.is_null()).or_else(|| raw.get("eventId")).filter(|v| !v.is_null());
        let event_id = match event_id_source {
            Some(value) => safe_id(&sk_core::js::s(Some(value)), "event_id")?,
            None => self.new_id("event_id")?,
        };
        let payload = raw.get("payload").filter(|v| !v.is_null()).cloned().unwrap_or_else(sk_core::js::obj);
        event.insert("event_id".into(), Value::from(event_id));
        event.insert("campaign_id".into(), Value::from(campaign_id));
        event.insert("command_id".into(), Value::from(command_id));
        event.insert("idempotency_key".into(), Value::from(key));
        event.insert("event_type".into(), Value::from(kind));
        event.insert("reducer_version".into(), Value::from(self.reducer.reducer_version()));
        event.insert("actor_id".into(), raw.get("actor_id").cloned().unwrap_or(Value::Null));
        event.insert("target_ids".into(), unique_strings(raw.get("target_ids")));
        event.insert("payload".into(), payload);
        event.insert("source_rule_ids".into(), unique_strings(raw.get("source_rule_ids")));
        event.insert("ruling_id".into(), raw.get("ruling_id").cloned().unwrap_or(Value::Null));
        event.insert("state_version_before".into(), Value::from(before));
        event.insert("state_version_after".into(), Value::from(before + 1));
        let created_at = raw.get("created_at").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::from(timestamp));
        event.insert("created_at".into(), created_at);
        Ok(Value::Object(event))
    }

    fn insert_commit(conn: &Connection, campaign_id: &str, commit: &Value) -> StoreResult<()> {
        conn.execute(
            "INSERT INTO commits (campaign_id, version_after, version_before, commit_id, idempotency_key, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                campaign_id,
                int_field(commit, "state_version_after"),
                int_field(commit, "state_version_before"),
                sk_core::js::s(commit.get("commit_id")),
                sk_core::js::s(commit.get("idempotency_key")),
                serde_json::to_string(commit)?,
            ],
        )?;
        Ok(())
    }

    fn commit_by_key(conn: &Connection, campaign_id: &str, key: &str) -> StoreResult<Option<Value>> {
        let body: Option<String> = conn
            .query_row("SELECT body FROM commits WHERE campaign_id = ?1 AND idempotency_key = ?2", params![campaign_id, key], |row| row.get(0))
            .optional()?;
        Ok(match body {
            Some(text) => Some(serde_json::from_str(&text)?),
            None => None,
        })
    }

    /// `initializeCampaign`: исходный снимок v0 и метаданные. Повтор с тем же
    /// состоянием — не ошибка.
    pub fn initialize_campaign(&self, request: InitializeRequest) -> StoreResult<(Loaded, bool)> {
        let campaign_id = safe_id(&request.campaign_id, "campaign_id")?;
        let mut inner = self.lock();
        let requested = self.normalize_state(request.initial_state, 0, self.reducer.reducer_version())?;
        if Self::exists(&inner.conn, &campaign_id)? {
            let existing = self.load_inner(&mut inner, &campaign_id, &LoadOptions { at_version: Some(0), use_snapshots: Some(false), ..Default::default() })?;
            if stable_hash(&existing.state) != stable_hash(&requested) {
                return Err(StoreError::already_initialized(&campaign_id, existing.current_state_version));
            }
            return Ok((existing, false));
        }
        let transaction = inner.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.write_snapshot(&transaction, &campaign_id, &requested, 0, self.reducer.reducer_version())?;
        let mut patch = request.metadata.as_object().cloned().unwrap_or_default();
        patch.insert("ruleset_id".into(), Value::from(request.ruleset_id));
        patch.insert("ruleset_version".into(), Value::from(request.ruleset_version));
        patch.insert("enabled_rule_packs".into(), sk_core::js::strings_value(request.enabled_rule_packs));
        patch.insert("enabled_house_rules".into(), sk_core::js::strings_value(request.enabled_house_rules));
        let metadata = self.write_metadata(&transaction, &campaign_id, None, &Value::Object(patch), 0)?;
        transaction.commit()?;
        Ok((
            Loaded { campaign_id: campaign_id.clone(), state_version: 0, current_state_version: 0, state: requested, reducer_version: self.reducer.reducer_version(), metadata, events_applied: 0 },
            true,
        ))
    }

    /// `importLegacySnapshot`: состояние прежнего хранилища становится
    /// версией 1 событием `LegacyStateImported`.
    pub fn import_legacy_snapshot(&self, request: LegacyImportRequest) -> StoreResult<CommitResult> {
        let LegacyImportRequest { campaign_id, legacy_state, idempotency_key, command_id, source, ruleset_id, ruleset_version, enabled_rule_packs, enabled_house_rules } = request;
        let campaign_id = safe_id(&campaign_id, "campaign_id")?;
        let key = safe_id(idempotency_key.unwrap_or_else(|| format!("legacy-import:{campaign_id}")).as_str(), "idempotency_key")?;
        let source = source.as_str();
        let mut inner = self.lock();
        if Self::exists(&inner.conn, &campaign_id)? {
            let (head, _) = Self::head(&inner.conn, &campaign_id)?;
            Self::check_head_evidence(&inner.conn, &campaign_id, head)?;
        }
        let imported = self.normalize_state(legacy_state, 1, self.reducer.reducer_version())?;
        let zero_state = sk_core::js::spread(&imported, json!({ "state_version": 0 }));
        let legacy_hash = stable_hash(&zero_state);
        if let Some(duplicate) = Self::commit_by_key(&inner.conn, &campaign_id, &key)? {
            if duplicate.get("legacy_state_hash").and_then(Value::as_str) != Some(legacy_hash.as_str()) {
                return Err(StoreError::idempotency_conflict(&campaign_id, &key));
            }
            let loaded = self.load_inner(&mut inner, &campaign_id, &LoadOptions { at_version: Some(int_field(&duplicate, "state_version_after")), ..Default::default() })?;
            let events = duplicate["events"].as_array().cloned().unwrap_or_default();
            return Ok(CommitResult::from_loaded(loaded, events, true, &key, sk_core::js::s(duplicate.get("command_id"))));
        }
        let (current_version, _) = Self::head(&inner.conn, &campaign_id)?;
        if current_version != 0 {
            return Err(StoreError::already_initialized(&campaign_id, current_version));
        }
        let transaction = inner.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if self.read_snapshot(&transaction, &campaign_id, 0, false)?.is_none() {
            let initial = self.normalize_state(self.reducer.initial_state(&campaign_id), 0, self.reducer.reducer_version())?;
            self.write_snapshot(&transaction, &campaign_id, &initial, 0, self.reducer.reducer_version())?;
        }
        let timestamp = self.now_iso();
        let resolved_command_id = match command_id {
            Some(id) => safe_id(&id, "command_id")?,
            None => self.new_id("command_id")?,
        };
        let event = self.normalize_event(
            &json!({ "event_type": "LegacyStateImported", "payload": { "state": zero_state, "source": source, "legacy_state_hash": legacy_hash } }),
            &campaign_id,
            &resolved_command_id,
            &key,
            0,
            &timestamp,
        )?;
        let commit = json!({
            "schema_version": STORE_SCHEMA_VERSION,
            "commit_id": self.new_id("commit_id")?,
            "campaign_id": campaign_id,
            "command_id": resolved_command_id,
            "idempotency_key": key,
            "request_hash": stable_hash(&json!({ "source": source, "legacy_state_hash": legacy_hash })),
            "legacy_state_hash": legacy_hash,
            "state_version_before": 0,
            "state_version_after": 1,
            "created_at": timestamp,
            "reducer_version": self.reducer.reducer_version(),
            "events": [event.clone()],
            "projection_outbox": { "schema_version": 1, "target": "compatibility-room", "state_version_after": 1 },
        });
        Self::insert_commit(&transaction, &campaign_id, &commit)?;
        self.write_snapshot(&transaction, &campaign_id, &imported, 1, self.reducer.reducer_version())?;
        let current = Self::read_metadata(&transaction, &campaign_id, 0)?;
        let metadata = self.write_metadata(
            &transaction,
            &campaign_id,
            Some(&current),
            &json!({
                "ruleset_id": ruleset_id,
                "ruleset_version": ruleset_version,
                "enabled_rule_packs": enabled_rule_packs,
                "enabled_house_rules": enabled_house_rules,
                "legacy_imported_at": timestamp,
            }),
            1,
        )?;
        transaction.commit()?;
        inner.head_cache.shift_remove(&campaign_id);
        Ok(CommitResult {
            campaign_id: campaign_id.clone(),
            state_version: 1,
            current_state_version: 1,
            state: imported,
            metadata,
            events: vec![event],
            duplicate: false,
            idempotency_key: key,
            command_id: resolved_command_id,
        })
    }

    /// `commit`: пакет событий одной команды.
    pub fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        let _span = crate::perf::span("store.commit");
        let campaign_id = safe_id(&request.campaign_id, "campaign_id")?;
        let expected = safe_version(request.expected_state_version, "expected_state_version")?;
        let key = safe_id(&request.idempotency_key, "idempotency_key")?;
        if request.events.is_empty() || request.events.len() > self.options.max_events_per_commit {
            return Err(StoreError::invalid("INVALID_EVENT_BATCH", format!("events must contain 1-{} entries", self.options.max_events_per_commit)));
        }
        let request_hash = stable_hash(&json!({ "command_id": request.command_id, "events": request.events }));
        let mut inner = self.lock();
        if !Self::exists(&inner.conn, &campaign_id)? {
            let initial = self.normalize_state(self.reducer.initial_state(&campaign_id), 0, self.reducer.reducer_version())?;
            let transaction = inner.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            self.write_snapshot(&transaction, &campaign_id, &initial, 0, self.reducer.reducer_version())?;
            self.write_metadata(&transaction, &campaign_id, None, &json!({}), 0)?;
            transaction.commit()?;
        }
        let (head, _) = Self::head(&inner.conn, &campaign_id)?;
        Self::check_head_evidence(&inner.conn, &campaign_id, head)?;
        if let Some(duplicate) = Self::commit_by_key(&inner.conn, &campaign_id, &key)? {
            if duplicate.get("request_hash").and_then(Value::as_str) != Some(request_hash.as_str()) {
                return Err(StoreError::idempotency_conflict(&campaign_id, &key));
            }
            let loaded = self.load_inner(&mut inner, &campaign_id, &LoadOptions { at_version: Some(int_field(&duplicate, "state_version_after")), ..Default::default() })?;
            let events = duplicate["events"].as_array().cloned().unwrap_or_default();
            return Ok(CommitResult::from_loaded(loaded, events, true, &key, sk_core::js::s(duplicate.get("command_id"))));
        }
        let (actual, _) = Self::head(&inner.conn, &campaign_id)?;
        if expected != actual {
            return Err(StoreError::version_conflict(&campaign_id, expected, actual));
        }
        let current = self.load_inner(&mut inner, &campaign_id, &LoadOptions::default())?;
        let timestamp = self.now_iso();
        let command_id = match &request.command_id {
            Some(id) => safe_id(id, "command_id")?,
            None => self.new_id("command_id")?,
        };
        let events = request
            .events
            .iter()
            .enumerate()
            .map(|(index, event)| self.normalize_event(event, &campaign_id, &command_id, &key, actual + index as i64, &timestamp))
            .collect::<StoreResult<Vec<_>>>()?;
        let next_state = self.apply_events(current.state.clone(), &events, None)?;
        let next_version = actual + events.len() as i64;
        let commit_id = self.new_id("commit_id")?;
        let commit = json!({
            "schema_version": STORE_SCHEMA_VERSION,
            "commit_id": commit_id,
            "campaign_id": campaign_id,
            "command_id": command_id,
            "idempotency_key": key,
            "request_hash": request_hash,
            "state_version_before": actual,
            "state_version_after": next_version,
            "created_at": timestamp,
            "events": events,
            "reducer_version": self.reducer.reducer_version(),
            "projection_outbox": { "schema_version": 1, "target": "compatibility-room", "state_version_after": next_version },
        });
        let snapshot_due = request.force_snapshot || (self.options.snapshot_every > 0 && (current.events_applied + events.len()) as i64 >= self.options.snapshot_every);
        let write = crate::perf::span("store.commit.sql");
        let transaction = inner.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::insert_commit(&transaction, &campaign_id, &commit)?;
        let last_reducer_version = events.last().map_or(0, |event| int_field(event, "reducer_version"));
        if snapshot_due {
            self.write_snapshot(&transaction, &campaign_id, &next_state, next_version, last_reducer_version)?;
        }
        let metadata = self.write_metadata(&transaction, &campaign_id, Some(&current.metadata), &request.metadata, next_version)?;
        transaction.commit()?;
        drop(write);
        self.remember_head(
            &mut inner,
            &campaign_id,
            HeadEntry {
                last_commit_id: commit_id,
                version: next_version,
                reducer_version: last_reducer_version,
                events_applied: if snapshot_due { 0 } else { current.events_applied + events.len() },
                state: next_state.clone(),
            },
        );
        Ok(CommitResult {
            campaign_id,
            state_version: next_version,
            current_state_version: next_version,
            state: next_state,
            metadata,
            events,
            duplicate: false,
            idempotency_key: key,
            command_id,
        })
    }

    /// `load(campaignId, options)`.
    pub fn load(&self, campaign_id: &str, options: &LoadOptions) -> StoreResult<Loaded> {
        let _span = crate::perf::span("store.load");
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let mut inner = self.lock();
        self.load_inner(&mut inner, &campaign_id, options)
    }

    /// `getByIdempotencyKey`: прежний коммит по ключу или `None`.
    pub fn get_by_idempotency_key(&self, campaign_id: &str, idempotency_key: &str) -> StoreResult<Option<CommitResult>> {
        let _span = crate::perf::span("store.get_by_idempotency_key");
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let mut inner = self.lock();
        if !Self::exists(&inner.conn, &campaign_id)? {
            return Ok(None);
        }
        let key = safe_id(idempotency_key, "idempotency_key")?;
        let (head, _) = Self::head(&inner.conn, &campaign_id)?;
        Self::check_head_evidence(&inner.conn, &campaign_id, head)?;
        let Some(commit) = Self::commit_by_key(&inner.conn, &campaign_id, &key)? else { return Ok(None) };
        let loaded = self.load_inner(&mut inner, &campaign_id, &LoadOptions { at_version: Some(int_field(&commit, "state_version_after")), ..Default::default() })?;
        let events = commit["events"].as_array().cloned().unwrap_or_default();
        Ok(Some(CommitResult::from_loaded(loaded, events, true, &key, sk_core::js::s(commit.get("command_id")))))
    }

    /// `getEvents`: события после `after_version` до `up_to_version` включительно.
    pub fn get_events(&self, campaign_id: &str, after_version: i64, up_to_version: Option<i64>) -> StoreResult<Vec<Value>> {
        let _span = crate::perf::span("store.get_events");
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let inner = self.lock();
        if !Self::exists(&inner.conn, &campaign_id)? {
            return Err(StoreError::campaign_not_found(&campaign_id));
        }
        let after = safe_version(after_version, "after_version")?;
        let up_to = safe_version(up_to_version.unwrap_or(i64::MAX / 2), "up_to_version")?;
        let (head, _) = Self::head(&inner.conn, &campaign_id)?;
        Self::check_head_evidence(&inner.conn, &campaign_id, head)?;
        let commits = Self::read_commits(&inner.conn, &campaign_id, after, up_to.saturating_add(1))?;
        Ok(commits
            .iter()
            .flat_map(|commit| commit["events"].as_array().cloned().unwrap_or_default())
            .filter(|event| {
                let version = int_field(event, "state_version_after");
                version > after && version <= up_to
            })
            .collect())
    }

    /// `createSnapshot`: снимок головы.
    pub fn create_snapshot(&self, campaign_id: &str) -> StoreResult<Value> {
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let mut inner = self.lock();
        let loaded = self.load_inner(&mut inner, &campaign_id, &LoadOptions::default())?;
        let snapshot = self.write_snapshot(&inner.conn, &campaign_id, &loaded.state, loaded.state_version, loaded.reducer_version)?;
        Ok(json!({ "campaign_id": campaign_id, "state_version": loaded.state_version, "snapshot": snapshot }))
    }

    /// `getMetadata`.
    pub fn get_metadata(&self, campaign_id: &str) -> StoreResult<Value> {
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let inner = self.lock();
        if !Self::exists(&inner.conn, &campaign_id)? {
            return Err(StoreError::campaign_not_found(&campaign_id));
        }
        let (head, _) = Self::head(&inner.conn, &campaign_id)?;
        Self::check_head_evidence(&inner.conn, &campaign_id, head)?;
        Self::read_metadata(&inner.conn, &campaign_id, head)
    }

    /// `pendingProjection`: события после отметки проекции или `None`.
    pub fn pending_projection(&self, campaign_id: &str, with_state: bool) -> StoreResult<Option<PendingProjection>> {
        let _span = crate::perf::span("store.pending_projection");
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let mut inner = self.lock();
        if !Self::exists(&inner.conn, &campaign_id)? {
            return Err(StoreError::campaign_not_found(&campaign_id));
        }
        let (head, _) = Self::head(&inner.conn, &campaign_id)?;
        Self::check_head_evidence(&inner.conn, &campaign_id, head)?;
        let metadata = Self::read_metadata(&inner.conn, &campaign_id, head)?;
        let checkpoint = int_field(&metadata, "projection_checkpoint_version").clamp(0, head);
        if checkpoint >= head {
            return Ok(None);
        }
        let state = if with_state { Some(self.load_inner(&mut inner, &campaign_id, &LoadOptions::default())?.state) } else { None };
        let events = Self::read_commits(&inner.conn, &campaign_id, checkpoint, i64::MAX / 2)?
            .iter()
            .flat_map(|commit| commit["events"].as_array().cloned().unwrap_or_default())
            .collect();
        Ok(Some(PendingProjection { campaign_id, checkpoint_version: checkpoint, state_version: head, state, events }))
    }

    /// `acknowledgeProjection`: проекция дошла до версии.
    pub fn acknowledge_projection(&self, campaign_id: &str, projected_version: i64, projection_hash: Option<&str>) -> StoreResult<Value> {
        let _span = crate::perf::span("store.acknowledge_projection");
        let campaign_id = safe_id(campaign_id, "campaign_id")?;
        let inner = self.lock();
        self.acknowledge_in(&inner.conn, &campaign_id, projected_version, projection_hash)
    }

    /// Тело `acknowledgeProjection` над уже взятым соединением (и транзакцией
    /// записи накладки комнаты, `rooms.rs`).
    fn acknowledge_in(&self, conn: &Connection, campaign_id: &str, projected_version: i64, projection_hash: Option<&str>) -> StoreResult<Value> {
        let requested = safe_version(projected_version, "projected_version")?;
        let (head, _) = Self::head(conn, campaign_id)?;
        Self::check_head_evidence(conn, campaign_id, head)?;
        if requested > head {
            return Err(StoreError::version_conflict(campaign_id, requested, head));
        }
        let metadata = Self::read_metadata(conn, campaign_id, head)?;
        let checkpoint = int_field(&metadata, "projection_checkpoint_version").max(requested);
        let hash = projection_hash.map(Value::from).or_else(|| metadata.get("projection_checkpoint_hash").cloned()).unwrap_or(Value::Null);
        self.write_metadata(
            conn,
            campaign_id,
            Some(&metadata),
            &json!({ "projection_checkpoint_version": checkpoint, "projection_checkpoint_at": self.now_iso(), "projection_checkpoint_hash": hash }),
            head,
        )
    }

    /// Кампании хранилища и их версии.
    pub fn list_campaigns(&self) -> StoreResult<Vec<(String, i64)>> {
        let inner = self.lock();
        let mut statement = inner.conn.prepare(
            "SELECT c.campaign_id, COALESCE((SELECT MAX(version_after) FROM commits WHERE campaign_id = c.campaign_id), 0) FROM campaigns c ORDER BY c.campaign_id",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Прямой доступ к базе для импорта и инструментов.
    pub fn with_connection_mut<T>(&self, operation: impl FnOnce(&mut Connection) -> StoreResult<T>) -> StoreResult<T> {
        let mut inner = self.lock();
        inner.head_cache.clear();
        operation(&mut inner.conn)
    }
}
