//! Перенос прежнего файлового хранилища (`storage/engine`) в SQLite.
//!
//! Файлы `FileEventStore` читаются как есть: `campaigns/<ключ>/metadata.json`,
//! `events/<начало>-<конец>-<commit>.json`, `snapshots/<версия>.json` и карты
//! `maps/<aa>/<hash>.json`. Тела коммитов и снимков ложатся в базу байт в байт
//! по смыслу (тот же JSON), поэтому журнал после переноса проигрывается тем же
//! редьюсером, а контрольные суммы снимков и адреса карт остаются верными.
//! Каталог-источник не меняется.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::error::{StoreError, StoreResult};
use crate::store::EventStore;

/// Итог переноса одной кампании.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedCampaign {
    pub campaign_id: String,
    pub commits: usize,
    pub snapshots: usize,
    pub state_version: i64,
    pub skipped: Option<String>,
}

/// Итог переноса каталога.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportReport {
    pub campaigns: Vec<ImportedCampaign>,
    pub map_blobs: usize,
}

fn read_json(path: &Path) -> StoreResult<Value> {
    let text = fs::read_to_string(path).map_err(|error| StoreError::new("INVALID_STORE_FILE", format!("Cannot read {}: {error}", path.display())))?;
    serde_json::from_str(&text).map_err(|error| StoreError::new("INVALID_STORE_FILE", format!("Cannot read {}: {error}", path.display())))
}

fn sorted_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json") && !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.')))
        .collect();
    files.sort();
    files
}

fn is_event_file(name: &str) -> Option<(i64, i64)> {
    let stem = name.strip_suffix(".json")?;
    let mut parts = stem.splitn(3, '-');
    let start = parts.next()?;
    let end = parts.next()?;
    let commit = parts.next()?;
    if start.len() != 16 || end.len() != 16 || commit.is_empty() || !start.bytes().chain(end.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((start.parse().ok()?, end.parse().ok()?))
}

fn is_snapshot_file(name: &str) -> Option<i64> {
    let stem = name.strip_suffix(".json")?;
    (stem.len() == 16 && stem.bytes().all(|b| b.is_ascii_digit())).then(|| stem.parse().ok()).flatten()
}

fn import_maps(conn: &Connection, root: &Path) -> StoreResult<usize> {
    let maps = root.join("maps");
    let mut count = 0;
    for shard in fs::read_dir(&maps).into_iter().flatten().filter_map(Result::ok) {
        for file in sorted_files(&shard.path()) {
            let Ok(text) = fs::read_to_string(&file) else { continue };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
            let canonical = serde_json::to_string(&parsed)?;
            let hash = sk_core::hash::sha256_hex(&canonical);
            // Файл под чужим адресом не переносится: адрес задаёт содержимое.
            if file.file_stem().is_some_and(|stem| stem.to_string_lossy() == hash) {
                count += conn.execute("INSERT OR IGNORE INTO map_blobs (hash, body) VALUES (?1, ?2)", params![hash, canonical])?;
            }
        }
    }
    Ok(count)
}

fn import_campaign(conn: &Connection, dir: &Path) -> StoreResult<ImportedCampaign> {
    let mut commits = Vec::new();
    for file in sorted_files(&dir.join("events")) {
        let name = file.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(range) = is_event_file(&name) {
            commits.push((range, read_json(&file)?));
        }
    }
    let mut snapshots = Vec::new();
    for file in sorted_files(&dir.join("snapshots")) {
        let name = file.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(version) = is_snapshot_file(&name) {
            snapshots.push((version, read_json(&file)?));
        }
    }
    let metadata_path = dir.join("metadata.json");
    let metadata = if metadata_path.exists() { Some(read_json(&metadata_path)?) } else { None };
    let campaign_id = metadata
        .as_ref()
        .and_then(|value| value.get("campaign_id"))
        .or_else(|| commits.first().and_then(|(_, commit)| commit.get("campaign_id")))
        .or_else(|| snapshots.first().and_then(|(_, snapshot)| snapshot.get("campaign_id")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| StoreError::new("INVALID_STORE_FILE", format!("{}: не найден campaign_id", dir.display())))?;
    let existing: i64 = conn.query_row("SELECT COUNT(*) FROM campaigns WHERE campaign_id = ?1", params![campaign_id], |row| row.get(0))?;
    if existing > 0 {
        return Ok(ImportedCampaign { campaign_id, commits: 0, snapshots: 0, state_version: 0, skipped: Some("кампания уже есть в базе".into()) });
    }
    let mut version = 0;
    for ((start, end), commit) in &commits {
        if commit.get("campaign_id").and_then(Value::as_str) != Some(campaign_id.as_str()) || *start != version + 1 {
            return Err(StoreError::corrupt(&campaign_id, format!("non-contiguous commit {start:016}-{end:016}"), json!({ "expected_state_version": version })));
        }
        conn.execute(
            "INSERT INTO commits (campaign_id, version_after, version_before, commit_id, idempotency_key, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                campaign_id,
                end,
                version,
                sk_core::js::s(commit.get("commit_id")),
                sk_core::js::s(commit.get("idempotency_key")),
                serde_json::to_string(commit)?,
            ],
        )?;
        version = *end;
    }
    for (state_version, snapshot) in &snapshots {
        conn.execute(
            "INSERT INTO snapshots (campaign_id, state_version, body) VALUES (?1, ?2, ?3)",
            params![campaign_id, state_version, serde_json::to_string(snapshot)?],
        )?;
    }
    let metadata = metadata.unwrap_or_else(|| json!({ "schema_version": 1, "campaign_id": campaign_id, "state_version": version, "current_version": version, "projection_checkpoint_version": 0 }));
    conn.execute("INSERT INTO campaigns (campaign_id, metadata) VALUES (?1, ?2)", params![campaign_id, serde_json::to_string(&metadata)?])?;
    Ok(ImportedCampaign { campaign_id, commits: commits.len(), snapshots: snapshots.len(), state_version: version, skipped: None })
}

/// Перенести каталог `storage/engine` прежнего сервера в базу. Каждая
/// кампания — своя транзакция: битая кампания не мешает остальным и
/// попадает в отчёт.
pub fn import_file_store(store: &EventStore, root: impl AsRef<Path>) -> StoreResult<ImportReport> {
    let root = root.as_ref();
    store.with_connection_mut(|conn| {
        let mut report = ImportReport::default();
        {
            let transaction = conn.transaction()?;
            report.map_blobs = import_maps(&transaction, root)?;
            transaction.commit()?;
        }
        let mut dirs: Vec<PathBuf> = fs::read_dir(root.join("campaigns")).into_iter().flatten().filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let transaction = conn.transaction()?;
            match import_campaign(&transaction, &dir) {
                Ok(imported) => {
                    transaction.commit()?;
                    report.campaigns.push(imported);
                }
                Err(error) => {
                    drop(transaction);
                    report.campaigns.push(ImportedCampaign {
                        campaign_id: dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
                        commits: 0,
                        snapshots: 0,
                        state_version: 0,
                        skipped: Some(error.to_string()),
                    });
                }
            }
        }
        Ok(report)
    })
}
