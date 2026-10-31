//! Перенос прежнего файлового хранилища (`storage/engine`) в SQLite.
//!
//! Файлы `FileEventStore` читаются как есть: `campaigns/<ключ>/metadata.json`,
//! `events/<начало>-<конец>-<commit>.json`, `snapshots/<версия>.json` и карты
//! `maps/<aa>/<hash>.json`. Тела коммитов и снимков ложатся в базу байт в байт
//! по смыслу (тот же JSON), поэтому журнал после переноса проигрывается тем же
//! редьюсером, а контрольные суммы снимков и адреса карт остаются верными.
//! Каталог-источник не меняется.
//!
//! Два входа:
//!
//! - [`import_file_store`] — прежний мягкий перенос (аудит выпуска
//!   `sk-tactics`): кампания пишется, даже если её журнал потом не откроется;
//! - [`import_file_store_verified`] — перенос подкоманды `import-legacy`
//!   (С19.2): журнал проверяется так же, как его читает `_readCommitFiles` JS,
//!   а после записи — загрузкой вызывающего (тот же редьюсер, что у сервера).
//!   Непригодная кампания (`CAMPAIGN_RECOVERY_REQUIRED`, `CORRUPT_EVENT_LOG`)
//!   убирается из базы целиком и попадает в отчёт с причиной; остальные
//!   переносятся.
//!
//! Здесь же — опись остального JS-хранилища ([`legacy_inventory`]): что
//! копируется файлами, что ложится в базу, что не переносится и почему.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{StoreError, StoreResult};
use crate::store::EventStore;

/// Итог переноса одной кампании.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportedCampaign {
    pub campaign_id: String,
    /// Каталог кампании в `engine/campaigns`.
    pub directory: String,
    pub commits: usize,
    pub snapshots: usize,
    pub state_version: i64,
    /// Причина пропуска (`КОД: сообщение`); кампании в базе нет.
    pub skipped: Option<String>,
    /// Код отказа пропуска (`CAMPAIGN_RECOVERY_REQUIRED`, `CORRUPT_EVENT_LOG`, …).
    pub skipped_code: Option<String>,
    /// Замечания проверки: кампания перенесена, но что-то не сошлось.
    pub warnings: Vec<String>,
}

/// Итог переноса каталога.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportReport {
    pub campaigns: Vec<ImportedCampaign>,
    pub map_blobs: usize,
    /// Файлы карт, чьё содержимое не совпало с адресом (не перенесены).
    pub map_blobs_rejected: usize,
}

/// Проверка перенесённой кампании вызывающим (обычно — загрузка головы и
/// полный replay редьюсером сервера). `Ok` — замечания, `Err` — кампания
/// непригодна и убирается из базы.
pub type VerifyCampaign<'a> = &'a dyn Fn(&EventStore, &str) -> Result<Vec<String>, StoreError>;

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

/// Каталог кампании `FileEventStore._layout(campaignId)`: слаг до 48 символов
/// и первые 16 знаков sha256 идентификатора.
pub fn legacy_campaign_directory(campaign_id: &str) -> String {
    let id = sk_core::text::trim(campaign_id);
    let mut slug = String::new();
    let mut dash = false;
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            slug.push(ch);
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(48).collect();
    let slug = if slug.is_empty() { "campaign".to_string() } else { slug };
    format!("{slug}-{}", &sk_core::hash::sha256_hex(id)[..16])
}

fn import_maps(conn: &Connection, root: &Path) -> StoreResult<(usize, usize)> {
    let maps = root.join("maps");
    let mut count = 0;
    let mut rejected = 0;
    let mut shards: Vec<PathBuf> = fs::read_dir(&maps).into_iter().flatten().filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    shards.sort();
    for shard in shards {
        for file in sorted_files(&shard) {
            let Ok(text) = fs::read_to_string(&file) else {
                rejected += 1;
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                rejected += 1;
                continue;
            };
            let canonical = sk_core::js::stringify(&parsed);
            let hash = sk_core::hash::sha256_hex(&canonical);
            // Файл под чужим адресом не переносится: адрес задаёт содержимое.
            if file.file_stem().is_some_and(|stem| stem.to_string_lossy() == hash) {
                count += conn.execute("INSERT OR IGNORE INTO map_blobs (hash, body) VALUES (?1, ?2)", params![hash, canonical])?;
            } else {
                rejected += 1;
            }
        }
    }
    Ok((count, rejected))
}

/// Проверки `_readCommitFiles` JS над одним файлом коммита (строгий перенос).
fn check_commit_file(campaign_id: &str, name: &str, commit: &Value, start: i64, end: i64, version: i64) -> StoreResult<()> {
    if commit.get("campaign_id").and_then(Value::as_str) != Some(campaign_id) {
        return Err(StoreError::corrupt(campaign_id, format!("{name} belongs to another campaign"), json!({})));
    }
    let before = commit.get("state_version_before").and_then(Value::as_i64);
    if before != Some(version) || start != version + 1 {
        return Err(StoreError::corrupt(campaign_id, format!("non-contiguous commit {name}"), json!({ "expected_state_version": version })));
    }
    let events = commit.get("events").and_then(Value::as_array);
    let count = events.map_or(0, Vec::len) as i64;
    if count < 1 || end != version + count || commit.get("state_version_after").and_then(Value::as_i64) != Some(end) {
        return Err(StoreError::corrupt(campaign_id, format!("invalid version range in {name}"), json!({})));
    }
    for (index, event) in events.into_iter().flatten().enumerate() {
        let expected = version + index as i64;
        if event.get("campaign_id").and_then(Value::as_str) != Some(campaign_id)
            || event.get("state_version_before").and_then(Value::as_i64) != Some(expected)
            || event.get("state_version_after").and_then(Value::as_i64) != Some(expected + 1)
        {
            return Err(StoreError::corrupt(campaign_id, format!("invalid event version in {name}"), json!({ "event_id": event.get("event_id") })));
        }
    }
    Ok(())
}

fn import_campaign(conn: &Connection, dir: &Path, strict: bool) -> StoreResult<ImportedCampaign> {
    let directory = dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let mut commits = Vec::new();
    for file in sorted_files(&dir.join("events")) {
        let name = file.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(range) = is_event_file(&name) {
            commits.push((name, range, read_json(&file)?));
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
        .or_else(|| commits.first().and_then(|(_, _, commit)| commit.get("campaign_id")))
        .or_else(|| snapshots.first().and_then(|(_, snapshot)| snapshot.get("campaign_id")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| StoreError::new("INVALID_STORE_FILE", format!("{}: не найден campaign_id", dir.display())))?;
    let existing: i64 = conn.query_row("SELECT COUNT(*) FROM campaigns WHERE campaign_id = ?1", params![campaign_id], |row| row.get(0))?;
    if existing > 0 {
        return Ok(ImportedCampaign { campaign_id, directory, skipped: Some("кампания уже есть в базе".into()), skipped_code: Some("CAMPAIGN_ALREADY_IMPORTED".into()), ..Default::default() });
    }
    if strict && legacy_campaign_directory(&campaign_id) != directory {
        // JS открывает кампанию только по каталогу, вычисленному из её
        // идентификатора: чужой каталог (копия, переименование) сервер не видел.
        return Err(StoreError::corrupt(&campaign_id, format!("directory {directory} is not the layout of this campaign ({})", legacy_campaign_directory(&campaign_id)), json!({})));
    }
    let mut version = 0;
    for (name, (start, end), commit) in &commits {
        if strict {
            check_commit_file(&campaign_id, name, commit, *start, *end, version)?;
        } else if commit.get("campaign_id").and_then(Value::as_str) != Some(campaign_id.as_str()) || *start != version + 1 {
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
    Ok(ImportedCampaign { campaign_id, directory, commits: commits.len(), snapshots: snapshots.len(), state_version: version, ..Default::default() })
}

fn campaign_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(root.join("campaigns")).into_iter().flatten().filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    dirs.sort();
    dirs
}

fn skipped(dir: &Path, error: &StoreError) -> ImportedCampaign {
    ImportedCampaign {
        campaign_id: error.campaign_id.clone().unwrap_or_else(|| dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()),
        directory: dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        skipped: Some(error.to_string()),
        skipped_code: Some(error.code.to_string()),
        ..Default::default()
    }
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
            (report.map_blobs, report.map_blobs_rejected) = import_maps(&transaction, root)?;
            transaction.commit()?;
        }
        for dir in campaign_dirs(root) {
            let transaction = conn.transaction()?;
            match import_campaign(&transaction, &dir, false) {
                Ok(imported) => {
                    transaction.commit()?;
                    report.campaigns.push(imported);
                }
                Err(error) => {
                    drop(transaction);
                    report.campaigns.push(skipped(&dir, &error));
                }
            }
        }
        Ok(report)
    })
}

fn remove_campaign(conn: &mut Connection, campaign_id: &str) -> StoreResult<()> {
    let transaction = conn.transaction()?;
    for table in ["commits", "snapshots", "campaigns"] {
        transaction.execute(&format!("DELETE FROM {table} WHERE campaign_id = ?1"), params![campaign_id])?;
    }
    transaction.commit()?;
    Ok(())
}

/// Строгий перенос для подкоманды `import-legacy`: файлы журнала проверяются,
/// как их читает JS, затем кампанию проверяет `verify` (загрузка тем же
/// редьюсером, что у сервера). Непригодная кампания убирается из базы и
/// попадает в отчёт с кодом отказа; ошибка самой базы вне кампании (карты,
/// удаление непригодной кампании) прерывает перенос.
pub fn import_file_store_verified(store: &EventStore, root: impl AsRef<Path>, verify: VerifyCampaign<'_>) -> StoreResult<ImportReport> {
    let root = root.as_ref();
    let mut report = ImportReport::default();
    (report.map_blobs, report.map_blobs_rejected) = store.with_connection_mut(|conn| {
        let transaction = conn.transaction()?;
        let counts = import_maps(&transaction, root)?;
        transaction.commit()?;
        Ok(counts)
    })?;
    for dir in campaign_dirs(root) {
        let written = store.with_connection_mut(|conn| {
            let transaction = conn.transaction()?;
            match import_campaign(&transaction, &dir, true) {
                Ok(imported) => {
                    transaction.commit()?;
                    Ok(Ok(imported))
                }
                // Ошибка SQLite внутри кампании (повтор ключа идемпотентности в
                // журнале и т. п.) — порча этой кампании: отчёт, а не обрыв.
                Err(error) => Ok(Err(error)),
            }
        })?;
        let mut imported = match written {
            Ok(imported) => imported,
            Err(error) => {
                report.campaigns.push(skipped(&dir, &error));
                continue;
            }
        };
        if imported.skipped.is_none() {
            match verify(store, &imported.campaign_id) {
                Ok(warnings) => imported.warnings = warnings,
                Err(error) => {
                    store.with_connection_mut(|conn| remove_campaign(conn, &imported.campaign_id))?;
                    imported = ImportedCampaign { campaign_id: imported.campaign_id, directory: imported.directory, skipped: Some(error.to_string()), skipped_code: Some(error.code.to_string()), ..Default::default() };
                }
            }
        }
        report.campaigns.push(imported);
    }
    Ok(report)
}

// --- опись хранилища -------------------------------------------------------

/// Файлы, которые Rust-сервер читает по тем же путям и в той же форме:
/// переносятся копией байт в байт.
pub const LEGACY_COPIED_FILES: &[&str] = &[
    "engine/llm-usage.json",
    "engine/architect-usage.json",
    "engine/roll-registry.json",
    "engine/clarifications.json",
    "engine/campaign-recap.json",
];

/// Каталоги, которые Rust-сервер читает по тем же путям: копируются целиком
/// (кроме временных файлов `*.tmp` и скрытых `.*`).
pub const LEGACY_COPIED_DIRS: &[&str] = &["turn-traces", "generated", "map-library"];

/// Опись JS-хранилища.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LegacyInventory {
    /// Файлы к копированию (пути от корня, через `/`).
    pub copy: Vec<String>,
    /// Их общий размер в байтах.
    pub copy_bytes: u64,
    /// Записи, которые сознательно не переносятся: путь и причина.
    pub ignored: Vec<(String, &'static str)>,
    /// Записи, назначение которых неизвестно: не переносятся, но видны в отчёте.
    pub unknown: Vec<String>,
}

fn rel(path: &str, name: &str) -> String {
    if path.is_empty() { name.to_string() } else { format!("{path}/{name}") }
}

fn is_transient(name: &str) -> bool {
    name.starts_with('.') || name.ends_with(".tmp") || name.ends_with(".lock")
}

fn sorted_entries(dir: &Path) -> Vec<(String, PathBuf, bool)> {
    let mut entries: Vec<(String, PathBuf, bool)> =
        fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok).map(|entry| (entry.file_name().to_string_lossy().to_string(), entry.path(), entry.path().is_dir())).collect();
    entries.sort();
    entries
}

fn collect_copy(dir: &Path, prefix: &str, inventory: &mut LegacyInventory) {
    for (name, path, is_dir) in sorted_entries(dir) {
        let relative = rel(prefix, &name);
        if is_transient(&name) {
            inventory.ignored.push((relative, "временный или служебный файл"));
        } else if is_dir {
            collect_copy(&path, &relative, inventory);
        } else {
            inventory.copy_bytes += fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            inventory.copy.push(relative);
        }
    }
}

/// Опись каталога JS-хранилища: что копируется файлами, что уходит в базу
/// (не входит в опись), что сознательно не переносится и что неизвестно.
pub fn legacy_inventory(from: &Path) -> LegacyInventory {
    let mut inventory = LegacyInventory::default();
    for (name, path, is_dir) in sorted_entries(from) {
        match (name.as_str(), is_dir) {
            ("auth.json", false) | ("rooms", true) | ("campaign-settings", true) => {}
            ("auth.json.lock", false) => inventory.ignored.push((name, "замок записи auth.json живого процесса")),
            (".server-writer.json", false) => inventory.ignored.push((name, "отметка писателя прежнего сервера")),
            ("engine", true) => {
                for (inner, inner_path, inner_dir) in sorted_entries(&path) {
                    let relative = rel("engine", &inner);
                    match (inner.as_str(), inner_dir) {
                        ("campaigns", true) | ("maps", true) => {}
                        _ if !inner_dir && LEGACY_COPIED_FILES.contains(&relative.as_str()) => {
                            inventory.copy_bytes += fs::metadata(&inner_path).map(|meta| meta.len()).unwrap_or(0);
                            inventory.copy.push(relative);
                        }
                        _ if is_transient(&inner) => inventory.ignored.push((relative, "временный или служебный файл")),
                        _ => inventory.unknown.push(relative),
                    }
                }
            }
            _ if is_dir && LEGACY_COPIED_DIRS.contains(&name.as_str()) => collect_copy(&path, &name, &mut inventory),
            _ if name.starts_with("skazanie.sqlite") => inventory.ignored.push((name, "база Rust-сервера, а не файлы JS")),
            _ if is_transient(&name) => inventory.ignored.push((name, "временный или служебный файл")),
            _ => inventory.unknown.push(name),
        }
    }
    inventory
}

/// Признаки JS-хранилища в каталоге: `auth.json`, комнаты `rooms/*.json`,
/// настройки `campaign-settings/*.json`, журналы `engine/campaigns/*`.
pub fn legacy_markers(dir: &Path) -> Vec<String> {
    let mut markers = Vec::new();
    if dir.join("auth.json").is_file() {
        markers.push("auth.json".to_string());
    }
    let has_json = |sub: &str| fs::read_dir(dir.join(sub)).into_iter().flatten().filter_map(Result::ok).any(|entry| entry.file_name().to_string_lossy().ends_with(".json") && entry.path().is_file());
    if has_json("rooms") {
        markers.push("rooms/".to_string());
    }
    if has_json("campaign-settings") {
        markers.push("campaign-settings/".to_string());
    }
    if fs::read_dir(dir.join("engine").join("campaigns")).into_iter().flatten().filter_map(Result::ok).any(|entry| entry.path().is_dir()) {
        markers.push("engine/campaigns/".to_string());
    }
    markers
}

/// В базе есть данные: пользователи, кампании или комнаты. Нет файла или
/// таблиц — `false`. База открывается только для чтения и не создаётся.
pub fn database_has_data(database: &Path) -> StoreResult<bool> {
    if !database.is_file() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    for table in ["users", "campaigns", "room_overlays", "sessions", "memberships", "invites", "campaign_settings", "commits"] {
        let exists: Option<i64> = conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", params![table], |row| row.get(0)).optional()?;
        if exists.is_none() {
            continue;
        }
        let any: Option<i64> = conn.query_row(&format!("SELECT 1 FROM {table} LIMIT 1"), [], |row| row.get(0)).optional()?;
        if any.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Скопировать файлы описи из `from` в `to` (каталоги создаются). Источник
/// только читается. Существующий файл назначения без `overwrite` — отказ.
pub fn copy_inventory(inventory: &LegacyInventory, from: &Path, to: &Path, overwrite: bool) -> StoreResult<usize> {
    let mut copied = 0;
    for relative in &inventory.copy {
        let source = from.join(relative);
        let target = to.join(relative);
        if target.exists() && !overwrite {
            return Err(StoreError::new("IMPORT_TARGET_EXISTS", format!("{} уже существует", target.display())));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| StoreError::new("IMPORT_COPY_FAILED", format!("{}: {error}", parent.display())))?;
        }
        fs::copy(&source, &target).map_err(|error| StoreError::new("IMPORT_COPY_FAILED", format!("{relative}: {error}")))?;
        copied += 1;
    }
    Ok(copied)
}
