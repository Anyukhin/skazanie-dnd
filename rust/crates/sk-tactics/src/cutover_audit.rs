//! Перенос `server/cutover-audit.mjs` — аудит хранилища перед выпуском:
//! сходится ли журнал кампании со своим replay и подтверждена ли проекция
//! последнего коммита. Отчёт — та же форма, что у JS (`schema_version: 2`,
//! `storage_root`, `campaign_count`, `ready`, `campaigns`, `blockers`,
//! `warnings`), виды расхождений — те же коды.
//!
//! JS сверял **два** хранилища: файл комнаты `storage/rooms/<id>.json`
//! (проекция для клиентов) и событийный журнал `storage/engine`. В Rust
//! хранилище одно — база `skazanie.sqlite` (`sk-store`): состояние, которое
//! видят клиенты, и есть голова журнала, второй копии «комнаты» нет. Поэтому
//! расхождения, возможные только между двумя копиями, здесь **не могут
//! возникнуть по устройству** и не имитируются:
//!
//! - `ROOM_PROJECTION_MISSING`, `EVENT_STREAM_MISSING` — кампания есть ровно
//!   тогда, когда есть её журнал;
//! - `PROJECTION_DIVERGENCE`, `PROJECTION_VERSION_DIVERGENCE` — нечему
//!   расходиться с головой журнала;
//! - `RETIRED_MODE_IN_ROOM` — режим движка не хранится отдельно от состояния;
//! - `INVALID_EVENT_METADATA` — метаданные — строка таблицы, а не файл в
//!   каталоге; битые метаданные дают `CAMPAIGN_AUDIT_FAILED`.
//!
//! Остаются и проверяются как в JS: `REPLAY_DIVERGENCE` (голова со снимками
//! против полного replay без снимков, по `projectionHash`),
//! `PROJECTION_NOT_ACKNOWLEDGED` (коммит после отметки проекции),
//! `PROJECTION_CHECKPOINT_HASH_MISMATCH` и `CAMPAIGN_AUDIT_FAILED`. Отметку
//! проекции JS сравнивал с хешем комнаты; здесь — с хешем головы журнала, а
//! сверка «проекция совпала» истинна по устройству, поэтому несовпадение
//! отметки — всегда замечание `STALE_CHECKPOINT_AFTER_SCHEMA_CHANGE`, как в JS
//! при совпавшей проекции.
//!
//! Оговорка С19: в `sk-server` комната — журнал плюс накладка
//! `room_overlays`, и накладка может разойтись с головой журнала. Эту сверку
//! (коды комнаты выше) добавляет поверх этого аудита
//! `sk_server::storage_audit` — подкоманда `skazanie-server audit-storage`.
//!
//! В записи кампании нет полей комнаты (`room`, `room_version`,
//! `room_file_sha256`, `projected_sha256`, `projection_matched`,
//! `raw_room_engine_mode`); прочие поля — как в JS.
//!
//! [`GameReducer`] — редьюсер хранилища поверх `sk_rules` (`applyGameEvent`,
//! `normalizeCampaignState` в retention-контексте), [`TacticalMapCells`] —
//! восстановление клеток сцены из карты по хешу, как `MapStore` в JS.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_narration_base::projection_integrity::projection_hash;
use sk_rules::constants::GAME_STATE_PROJECTOR_VERSION;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::replay::{apply_game_event, with_retention_mode, RETENTION_REDUCER_VERSION};
use sk_store::{EventStore, LoadOptions, MapCells, Reducer, RetentionMode, StoreOptions};
use sk_tactical::tactical_map::{deserialize_tactical_map, legacy_cells_from_tactical_map};

/// Имя базы в каталоге хранилища (как у `sk-server`).
pub const STORE_FILE: &str = "skazanie.sqlite";

fn mode_name(mode: RetentionMode) -> &'static str {
    match mode {
        RetentionMode::Legacy => "legacy",
        RetentionMode::Current => "current",
    }
}

/// Редьюсер хранилища поверх движка правил: то, что JS передавал в
/// `FileEventStore` (`reducer: applyGameEvent`, `normalizeState:
/// normalizeCampaignState`, `snapshotProjectorVersion`).
///
/// `Reducer::normalize` в `sk-store` не может вернуть ошибку, а
/// `normalizeCampaignState` в JS может бросить — такая ошибка запоминается
/// ([`GameReducer::take_failures`]), состояние остаётся как было, и аудит
/// считает кампанию непроверенной.
#[derive(Default)]
pub struct GameReducer {
    failures: Mutex<Vec<String>>,
}

impl GameReducer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ошибки нормализации с прошлого вызова.
    pub fn take_failures(&self) -> Vec<String> {
        std::mem::take(&mut *self.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

impl Reducer for GameReducer {
    fn reducer_version(&self) -> i64 {
        RETENTION_REDUCER_VERSION
    }

    fn snapshot_projector_version(&self) -> i64 {
        GAME_STATE_PROJECTOR_VERSION
    }

    fn normalize(&self, state: Value, mode: RetentionMode) -> Value {
        match with_retention_mode(mode_name(mode), || normalize_campaign_state(&state)) {
            Ok(Ok(normalized)) => normalized,
            Ok(Err(error)) => {
                self.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(error.to_string());
                state
            }
            Err(error) => {
                self.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(error);
                state
            }
        }
    }

    fn apply(&self, state: Value, event: &Value, mode: RetentionMode) -> Result<Value, String> {
        with_retention_mode(mode_name(mode), || apply_game_event(&state, event))?.map_err(|error| error.to_string())
    }

    /// Голова хранилища нормализована в текущем режиме: ветка редьюсера без
    /// повторной нормализации входа (`NormalizedState::reduced`).
    fn apply_to_head(&self, state: Value, event: &Value, mode: RetentionMode) -> Result<Value, String> {
        if mode != RetentionMode::Current {
            return self.apply(state, event, mode);
        }
        with_retention_mode(mode_name(mode), || sk_rules::normalized::NormalizedState::from_store_head(state).reduced(event))?.map_err(|error| error.to_string())
    }

    fn state_schema_version(&self) -> i64 {
        sk_rules::schema::STATE_SCHEMA_VERSION
    }

    /// Цепочка миграций движка (`sk_rules::schema::migrations`); ошибка — как
    /// у [`Self::normalize`]: запоминается, состояние остаётся как было.
    fn migrate(&self, state: Value, from: i64) -> Value {
        match with_retention_mode("current", || sk_rules::schema::migrations::migrate(&state, from)) {
            Ok(Ok(migrated)) => migrated,
            Ok(Err(error)) => {
                self.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(error.to_string());
                state
            }
            Err(error) => {
                self.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(error);
                state
            }
        }
    }

    fn check_shape(&self, state: &Value) -> Result<(), String> {
        sk_rules::schema::shape::check_campaign_state(state).map_err(|error| error.to_string())
    }
}

/// Клетки сцены из карты: `legacyCellsFromTacticalMap(deserializeTacticalMap(map))`,
/// при ошибке разбора — пустые (как `catch` в `map-store.mjs`).
pub struct TacticalMapCells;

impl MapCells for TacticalMapCells {
    fn cells_from_map(&self, map: &Value) -> Option<Value> {
        deserialize_tactical_map(map).ok().map(|map| Value::Array(legacy_cells_from_tactical_map(&map)))
    }
}

/// Хранилище с редьюсером движка и восстановлением карт.
pub fn open_game_store(database: &Path, reducer: Arc<GameReducer>) -> Result<EventStore, String> {
    EventStore::open(database, reducer, StoreOptions::default()).map(|store| store.with_map_cells(Arc::new(TacticalMapCells))).map_err(|error| error.message)
}

/// Каталог хранилища: `storageRoot || DND_STORAGE_DIR || 'storage'`, абсолютным путём.
fn storage_root(requested: Option<&Path>) -> PathBuf {
    let chosen = requested
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("DND_STORAGE_DIR").filter(|value| !value.is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("storage"));
    std::path::absolute(&chosen).unwrap_or(chosen)
}

fn report(root: &Path, campaigns: Vec<Value>, blockers: Vec<Value>, warnings: Vec<Value>) -> Value {
    json!({
        "schema_version": 2,
        "storage_root": root.to_string_lossy(),
        "campaign_count": campaigns.len(),
        "ready": blockers.is_empty(),
        "campaigns": campaigns,
        "blockers": blockers,
        "warnings": warnings,
    })
}

/// `auditLegacyCutover({ storageRoot })` над `<storage>/skazanie.sqlite`.
/// Базы нет — пустой готовый отчёт (база не создаётся). `Err` — базу нельзя
/// открыть или перечислить кампании.
pub fn audit_legacy_cutover(storage: Option<&Path>) -> Result<Value, String> {
    let root = storage_root(storage);
    let database = root.join(STORE_FILE);
    if !database.is_file() {
        return Ok(report(&root, Vec::new(), Vec::new(), Vec::new()));
    }
    let reducer = Arc::new(GameReducer::new());
    let store = open_game_store(&database, reducer.clone())?;
    audit_event_store(&store, &reducer, &root)
}

/// Аудит уже открытого хранилища (`reducer` — тот, с которым оно открыто).
pub fn audit_event_store(store: &EventStore, reducer: &GameReducer, root: &Path) -> Result<Value, String> {
    let mut ids: Vec<String> = store.list_campaigns().map_err(|error| error.message)?.into_iter().map(|(id, _)| id).collect();
    // `[...ids].sort()` — по единицам UTF-16.
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    ids.dedup();
    let mut campaigns = Vec::new();
    let mut blockers = Vec::new();
    // Замечания видны в отчёте, но выпуск не останавливают.
    let mut warnings = Vec::new();
    for campaign_id in ids {
        let mut entry = Map::new();
        entry.insert("campaign_id".into(), Value::String(campaign_id.clone()));
        entry.insert("event_stream".into(), Value::Bool(true));
        reducer.take_failures();
        match audit_campaign(store, reducer, &campaign_id) {
            Ok(audit) => {
                let Value::Object(fields) = audit.entry else { continue };
                entry.extend(fields);
                blockers.extend(audit.blockers);
                warnings.extend(audit.warnings);
            }
            Err(error) => {
                entry.insert("error".into(), Value::String(error.clone()));
                blockers.push(json!({ "code": "CAMPAIGN_AUDIT_FAILED", "campaign_id": campaign_id, "error": error }));
            }
        }
        campaigns.push(Value::Object(entry));
    }
    Ok(report(root, campaigns, blockers, warnings))
}

struct CampaignAudit {
    entry: Value,
    blockers: Vec<Value>,
    warnings: Vec<Value>,
}

fn audit_campaign(store: &EventStore, reducer: &GameReducer, campaign_id: &str) -> Result<CampaignAudit, String> {
    let loaded = store.load(campaign_id, &LoadOptions::default()).map_err(|error| error.message)?;
    let replayed = store.load(campaign_id, &LoadOptions { use_snapshots: Some(false), ..LoadOptions::default() }).map_err(|error| error.message)?;
    let metadata = store.get_metadata(campaign_id).map_err(|error| error.message)?;
    let pending = store.pending_projection(campaign_id, false).map_err(|error| error.message)?.is_some();
    if let Some(failure) = reducer.take_failures().into_iter().next() {
        return Err(failure);
    }
    let authoritative = projection_hash(&loaded.state);
    let replay_matched = authoritative == projection_hash(&replayed.state);
    let checkpoint_version = metadata.get("projection_checkpoint_version");
    let checkpoint_hash = metadata.get("projection_checkpoint_hash").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    let entry = json!({
        "event_version": loaded.state_version,
        "replay_version": replayed.state_version,
        "authoritative_sha256": authoritative,
        "replay_matched": replay_matched,
        "projection_checkpoint_version": js::num(js::number(Some(checkpoint_version.filter(|value| !value.is_null()).unwrap_or(&Value::from(0))))),
        "projection_checkpoint_hash": checkpoint_hash,
        "pending_projection": pending,
    });
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if !replay_matched {
        blockers.push(json!({ "code": "REPLAY_DIVERGENCE", "campaign_id": campaign_id }));
    }
    if pending {
        blockers.push(json!({ "code": "PROJECTION_NOT_ACKNOWLEDGED", "campaign_id": campaign_id }));
    }
    // Отметка хранит хеш, посчитанный кодом того дня, когда проекция
    // записывалась; проекция здесь — сама голова журнала, поэтому
    // несовпадение — устаревшая отметка, а не беда.
    if !pending && js::number(checkpoint_version) > 0.0 && checkpoint_hash.as_str() != Some(authoritative.as_str()) {
        warnings.push(json!({ "code": "PROJECTION_CHECKPOINT_HASH_MISMATCH", "campaign_id": campaign_id, "reason": "STALE_CHECKPOINT_AFTER_SCHEMA_CHANGE" }));
    }
    Ok(CampaignAudit { entry, blockers, warnings })
}
