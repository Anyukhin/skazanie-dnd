//! Подкоманда `skazanie-server audit-storage` (С19): рабочий аудит
//! хранилища перед переключением и после него — аналог `pnpm cutover:audit`
//! (`server/cutover-audit.mjs`, `tools/audit-cutover.mjs`).
//!
//! ```text
//! skazanie-server audit-storage [--storage <каталог>] [--json]
//! ```
//!
//! Что сверяется:
//!
//! - журнал кампании против полного replay и подтверждение проекции —
//!   [`sk_tactics::cutover_audit::audit_legacy_cutover`] (`REPLAY_DIVERGENCE`,
//!   `PROJECTION_NOT_ACKNOWLEDGED`, `CAMPAIGN_AUDIT_FAILED`, замечание
//!   `PROJECTION_CHECKPOINT_HASH_MISMATCH`);
//! - комната (журнал плюс накладка `room_overlays`, решение ведущего №2) против
//!   головы журнала, как `auditLegacyCutover` JS сверял файл комнаты:
//!   `ROOM_PROJECTION_MISSING`, `EVENT_STREAM_MISSING`,
//!   `PROJECTION_DIVERGENCE`, `PROJECTION_VERSION_DIVERGENCE`,
//!   `RETIRED_MODE_IN_ROOM`. Накладка может держать канонические поля, которых
//!   нет в журнале, — дрейф через неё возможен; сверка проекций при старте
//!   сервера его чинит, а этот аудит показывает до запуска.
//!
//! Данные не меняются: база только читается (при открытии схема создаётся
//! `IF NOT EXISTS` — на готовой базе это пустая операция). Живой писатель
//! storage (`.server-writer.json`, как у бэкапа и `import-legacy`) — отказ:
//! снимок работающего сервера несогласован. Тестовая подкоманда `audit`
//! (`test_hooks::room_cli`) зовёт ту же сверку [`audit_storage`] без этой
//! проверки — набор тестов JS сверяет хранилище при живом тестовом сервере.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_narration_base::projection_integrity::compare_projection;
use sk_store::{EventStore, LoadOptions};
use sk_tactics::cutover_audit::{open_game_store, GameReducer, STORE_FILE};

use crate::room::read_room;

/// Есть блокеры.
pub const BLOCKERS_EXIT: i32 = 1;
/// Неверные аргументы.
pub const USAGE_EXIT: i32 = 2;
/// Отказ или сбой: нет базы, работает сервер, база не открывается.
pub const REFUSED_EXIT: i32 = 3;

const USAGE: &str = "Использование: skazanie-server audit-storage [--storage <каталог>] [--json]

  --storage  хранилище Rust-сервера (каталог с skazanie.sqlite); по умолчанию
             DND_STORAGE_DIR, иначе ./storage
  --json     отчёт аудита в JSON (schema_version 2, как у pnpm cutover:audit)

Сверяет журнал с replay, подтверждение проекции и комнаты (накладки) с головой
журнала. Ничего не пишет; на хранилище работающего сервера — отказ.

Коды выхода: 0 — блокеров нет; 1 — есть блокеры (список в отчёте); 2 — неверные
аргументы; 3 — отказ или сбой (нет базы, работает сервер, база не читается).";

/// Разобранные аргументы.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Args {
    pub storage: Option<PathBuf>,
    pub json: bool,
    pub help: bool,
}

/// Разбор аргументов после `audit-storage`.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--storage" => parsed.storage = Some(PathBuf::from(iter.next().filter(|value| !value.is_empty()).ok_or("--storage: нужен каталог")?)),
            "--json" => parsed.json = true,
            "--help" | "-h" => parsed.help = true,
            other => return Err(format!("Неизвестный аргумент: {other}")),
        }
    }
    Ok(parsed)
}

/// Каталог хранилища: `--storage`, иначе `DND_STORAGE_DIR`, иначе `./storage`.
fn storage_dir(requested: Option<&Path>) -> PathBuf {
    let chosen = requested
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("DND_STORAGE_DIR").filter(|value| !value.is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("storage"));
    std::path::absolute(&chosen).unwrap_or(chosen)
}

/// Отчёт аудита или отказ (`Err` — текст для человека).
#[derive(Debug)]
pub enum Outcome {
    Report(Value),
    Refused(String),
}

/// Рабочий аудит: отказ без базы и при живом писателе, иначе [`audit_storage`].
pub fn audit_for_cutover(storage: &Path) -> Outcome {
    let database = storage.join(STORE_FILE);
    if !database.is_file() {
        return Outcome::Refused(format!("В {} нет базы {STORE_FILE} — это не хранилище Rust-сервера (импорт — skazanie-server import-legacy)", storage.display()));
    }
    match sk_infra::backup_service::inspect_storage_writer(storage, &Default::default()) {
        Ok(writer) if writer.get("state").and_then(Value::as_str) == Some("live") => {
            return Outcome::Refused(format!(
                "В {} работает сервер (отметка {}, pid {}): остановите его — аудит живого хранилища несогласован",
                storage.display(),
                js::s(writer.get("marker_file")),
                writer.get("pid").map_or_else(String::new, Value::to_string)
            ));
        }
        Ok(_) => {}
        Err(error) => return Outcome::Refused(format!("Отметка писателя {} не читается: {error}", storage.display())),
    }
    match audit_storage(storage) {
        Ok(report) => Outcome::Report(report),
        Err(error) => Outcome::Refused(error),
    }
}

/// Аудит хранилища: `sk_tactics` (журнал против replay, подтверждение
/// проекции) плюс сверка комнат с головой журнала. Базы нет — пустой готовый
/// отчёт (как у JS). Живого писателя не проверяет.
pub fn audit_storage(storage: &Path) -> Result<Value, String> {
    let mut report = sk_tactics::cutover_audit::audit_legacy_cutover(Some(storage))?;
    let database = storage.join(STORE_FILE);
    if !database.is_file() {
        return Ok(report);
    }
    let store = open_game_store(&database, Arc::new(GameReducer::new()))?;
    let journal_ids: Vec<String> = report["campaigns"].as_array().map(|list| list.iter().map(|entry| js::string(entry.get("campaign_id"))).collect()).unwrap_or_default();
    let room_ids = store.room_overlay_ids().map_err(|error| error.to_string())?;
    let mut blockers = Vec::new();
    let mut extra_campaigns = Vec::new();
    for campaign_id in &journal_ids {
        if !room_ids.contains(campaign_id) {
            blockers.push(json!({ "code": "ROOM_PROJECTION_MISSING", "campaign_id": campaign_id }));
        }
    }
    for room_id in &room_ids {
        if !journal_ids.contains(room_id) {
            blockers.push(json!({ "code": "EVENT_STREAM_MISSING", "campaign_id": room_id }));
            extra_campaigns.push(json!({ "campaign_id": room_id, "room": true, "event_stream": false }));
        }
    }
    let mut room_fields: Vec<(String, Map<String, Value>)> = Vec::new();
    for campaign_id in journal_ids.iter().filter(|id| room_ids.contains(*id)) {
        let mut fields = Map::new();
        fields.insert("room".into(), Value::Bool(true));
        match room_entry(&store, campaign_id) {
            Ok((entry, found)) => {
                fields.extend(entry);
                blockers.extend(found);
            }
            Err(error) => {
                fields.insert("room_error".into(), Value::String(error.clone()));
                blockers.push(json!({ "code": "CAMPAIGN_AUDIT_FAILED", "campaign_id": campaign_id, "error": error }));
            }
        }
        room_fields.push((campaign_id.clone(), fields));
    }
    if let Some(Value::Array(campaigns)) = report.get_mut("campaigns") {
        for entry in campaigns.iter_mut() {
            let id = js::string(entry.get("campaign_id"));
            if let (Value::Object(map), Some((_, fields))) = (entry, room_fields.iter().find(|(candidate, _)| *candidate == id)) {
                map.extend(fields.clone());
            }
        }
        campaigns.extend(extra_campaigns);
        let count = campaigns.len();
        report["campaign_count"] = Value::from(count);
    }
    if let Some(Value::Array(existing)) = report.get_mut("blockers") {
        existing.extend(blockers);
        let ready = existing.is_empty();
        report["ready"] = Value::Bool(ready);
    }
    Ok(report)
}

/// Сверка записанной комнаты кампании с головой журнала (как в JS:
/// `compareProjection(loaded.state, normalizeCampaignState(room.state))`).
fn room_entry(store: &EventStore, campaign_id: &str) -> Result<(Map<String, Value>, Vec<Value>), String> {
    let room = read_room(store, campaign_id).map_err(|failure| failure.message)?;
    let loaded = store.load(campaign_id, &LoadOptions::default()).map_err(|error| error.to_string())?;
    let mut entry = Map::new();
    let mut blockers = Vec::new();
    let Some(state) = room.state.as_ref() else { return Ok((entry, blockers)) };
    let normalized = sk_rules::normalize::normalize_campaign_state(state).map_err(|halt| crate::error::Failure::from(halt).message)?;
    let comparison = compare_projection(&loaded.state, &normalized);
    let room_version = state.get("state_version").map_or(-1.0, |value| js::number(Some(value)));
    entry.insert("room_version".into(), js::num(room_version));
    entry.insert("projected_sha256".into(), Value::String(comparison.projected_hash.clone()));
    entry.insert("projection_matched".into(), Value::Bool(comparison.matched));
    entry.insert("raw_room_engine_mode".into(), state.get("engine_mode").cloned().unwrap_or(Value::Null));
    if !comparison.matched {
        blockers.push(json!({ "code": "PROJECTION_DIVERGENCE", "campaign_id": campaign_id }));
    }
    if room_version != loaded.state_version as f64 {
        blockers.push(json!({ "code": "PROJECTION_VERSION_DIVERGENCE", "campaign_id": campaign_id }));
    }
    if let Some(mode) = state.get("engine_mode").filter(|mode| !mode.is_null() && mode.as_str() != Some("enforce") && js::truthy(Some(mode))) {
        blockers.push(json!({ "code": "RETIRED_MODE_IN_ROOM", "campaign_id": campaign_id, "value": mode }));
    }
    Ok((entry, blockers))
}

/// Код выхода по отчёту: 0 — готово, [`BLOCKERS_EXIT`] — есть блокеры.
pub fn exit_code(report: &Value) -> i32 {
    if report.get("ready") == Some(&Value::Bool(true)) {
        0
    } else {
        BLOCKERS_EXIT
    }
}

/// Сводка для человека.
pub fn to_text(report: &Value) -> String {
    let list = |key: &str| report.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let blockers = list("blockers");
    let warnings = list("warnings");
    let mut lines = vec![
        format!("Хранилище: {}", js::s(report.get("storage_root"))),
        format!("Кампаний: {}", report.get("campaign_count").map_or_else(|| "0".to_string(), Value::to_string)),
        format!("Блокеров: {}, замечаний: {}", blockers.len(), warnings.len()),
    ];
    for (label, items) in [("блокер", &blockers), ("замечание", &warnings)] {
        for item in items {
            let reason = item.get("reason").or_else(|| item.get("error")).map(|value| format!(" — {}", js::s(Some(value)))).unwrap_or_default();
            lines.push(format!("  {label} {} {}{reason}", js::s(item.get("code")), js::s(item.get("campaign_id"))));
        }
    }
    lines.push(if blockers.is_empty() { "Готово к запуску.".to_string() } else { "Есть блокеры — запускать нельзя.".to_string() });
    lines.join("\n")
}

/// Точка входа подкоманды (`main.rs`): код выхода.
pub fn run(args: &[String]) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("[Сказание] {error}\n\n{USAGE}");
            return USAGE_EXIT;
        }
    };
    if parsed.help {
        println!("{USAGE}");
        return 0;
    }
    let storage = storage_dir(parsed.storage.as_deref());
    match audit_for_cutover(&storage) {
        Outcome::Report(report) => {
            if parsed.json {
                println!("{}", js::stringify_pretty(&report, 2));
            } else {
                println!("{}", to_text(&report));
            }
            exit_code(&report)
        }
        Outcome::Refused(error) => {
            if parsed.json {
                println!("{}", js::stringify_pretty(&json!({ "schema_version": 2, "storage_root": storage.to_string_lossy(), "ready": false, "error": error }), 2));
            }
            eprintln!("[Сказание] audit-storage: {error}");
            REFUSED_EXIT
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_arguments() {
        assert_eq!(parse_args(&[]), Ok(Args::default()));
        assert_eq!(parse_args(&strings(&["--storage", "s", "--json"])), Ok(Args { storage: Some(PathBuf::from("s")), json: true, help: false }));
        assert!(parse_args(&strings(&["--storage"])).is_err());
        assert!(parse_args(&strings(&["--storage", ""])).is_err());
        assert!(parse_args(&strings(&["--write"])).is_err());
        assert_eq!(exit_code(&json!({ "ready": true })), 0);
        assert_eq!(exit_code(&json!({ "ready": false })), BLOCKERS_EXIT);
    }
}
