//! Подкоманда `skazanie-server import-legacy` (С19.2): перенос хранилища
//! прежнего JS-сервера в хранилище Rust-сервера (`skazanie.sqlite` и файлы).
//!
//! ```text
//! skazanie-server import-legacy --from <каталог JS storage> [--to <каталог>] [--dry-run] [--force] [--json]
//! ```
//!
//! Что куда уходит (таблица — в отчёте С19.2 и `rust/SERVER-PLAN.md`):
//!
//! - `auth.json` (пользователи, живые сессии, членство, приглашения) и
//!   `campaign-settings/*.json` — в таблицы аккаунтов базы
//!   ([`sk_store::accounts::Accounts::import_legacy_report`]);
//! - `engine/campaigns/*` (журнал, seed и прочие снимки, metadata) и
//!   `engine/maps/*` — в журнал базы, строгой проверкой и загрузкой тем же
//!   редьюсером, что у сервера ([`sk_store::import_file_store_verified`]);
//!   кампания с потерянным хвостом или seed пропускается с причиной
//!   (`CAMPAIGN_RECOVERY_REQUIRED`), остальные переносятся;
//! - `rooms/*.json` — в накладки `room_overlays` (решение ведущего №2):
//!   отличия записанной комнаты от журнала на её версии — летопись (≤ 400),
//!   поля только комнаты, присутствие; версия и `updatedAt` — из файла.
//!   Комната пропущенной кампании не переносится: иначе сервер молча отдал бы
//!   старое состояние вместо отказа восстановления;
//! - файлы, которые Rust читает по тем же путям (`engine/*.json` учёта и
//!   реестров, `turn-traces/`, `generated/`, `map-library/`) — копией.
//!
//! Безопасность данных (AGENTS §9): `--from` только читается; запись — только
//! в пустой `--to` (непустой каталог — отказ без `--force`, база с данными —
//! отказ всегда); база пишется во временный файл и встаёт на место последней,
//! после проверок и копирования файлов. `--dry-run` ничего не пишет: перенос
//! идёт в базу в памяти, отчёт тот же. Живой писатель (`.server-writer.json`)
//! в `--from` или `--to` — отказ. Секретов (хешей паролей, токенов, почты) в
//! отчёте нет — только счётчики и коды кампаний.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_store::accounts::{Accounts, LegacyAccountsReport};
use sk_store::legacy::{copy_inventory, database_has_data, legacy_campaign_directory, legacy_inventory, legacy_markers, LegacyInventory};
use sk_store::{EventStore, ImportReport, LoadOptions, RoomOverlay, StoreError, StoreOptions};
use sk_tactics::cutover_audit::{GameReducer, TacticalMapCells, STORE_FILE};

use crate::journal::ROOM_JOURNAL_LIMIT;

/// Формат отчёта `--json`.
pub const REPORT_FORMAT: &str = "skazanie.import-legacy/1";

const USAGE: &str = "Использование: skazanie-server import-legacy --from <каталог JS storage> [--to <каталог Rust storage>] [--dry-run] [--force] [--json]

  --from     хранилище прежнего JS-сервера (только читается)
  --to       куда переносить; по умолчанию DND_STORAGE_DIR. Каталог должен быть
             пустым или отсутствовать; база с данными — отказ всегда
  --dry-run  ничего не писать, только проверить и показать сводку
  --force    разрешить непустой --to (посторонние файлы, пустая база);
             совпадающие файлы перезаписываются копиями из --from
  --json     отчёт в формате JSON (skazanie.import-legacy/1)

Коды выхода: 0 — перенесено всё; 3 — перенесено, но часть кампаний или
комнат пропущена (причины в отчёте); 1 — отказ или сбой; 2 — неверные аргументы.";

/// Разобранные аргументы.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Args {
    pub from: PathBuf,
    pub to: Option<PathBuf>,
    pub dry_run: bool,
    pub force: bool,
    pub json: bool,
    pub help: bool,
}

/// Разбор аргументов после `import-legacy`.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut from = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--from" => from = Some(PathBuf::from(iter.next().filter(|value| !value.is_empty()).ok_or("--from: нужен каталог")?)),
            "--to" => parsed.to = Some(PathBuf::from(iter.next().filter(|value| !value.is_empty()).ok_or("--to: нужен каталог")?)),
            "--dry-run" => parsed.dry_run = true,
            "--force" => parsed.force = true,
            "--json" => parsed.json = true,
            "--help" | "-h" => parsed.help = true,
            other => return Err(format!("Неизвестный аргумент: {other}")),
        }
    }
    if parsed.help {
        return Ok(parsed);
    }
    parsed.from = from.ok_or("Нужен --from <каталог JS storage>")?;
    Ok(parsed)
}

/// Точка входа подкоманды (`main.rs`): код выхода.
pub fn run(args: &[String]) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("[Сказание] {error}\n\n{USAGE}");
            return 2;
        }
    };
    if parsed.help {
        println!("{USAGE}");
        return 0;
    }
    let env_storage = std::env::var_os("DND_STORAGE_DIR").filter(|value| !value.is_empty()).map(PathBuf::from);
    let to = match parsed.to.clone().or(env_storage) {
        Some(to) => to,
        None => {
            eprintln!("[Сказание] Укажите --to <каталог> или DND_STORAGE_DIR: куда переносить хранилище\n\n{USAGE}");
            return 2;
        }
    };
    let options = ImportOptions { from: parsed.from.clone(), to, dry_run: parsed.dry_run, force: parsed.force };
    match import_legacy_storage(&options) {
        Ok(report) => {
            if parsed.json {
                println!("{}", js::stringify_pretty(&report.to_json(), 2));
            } else {
                println!("{}", report.to_text());
            }
            if report.skipped_count() > 0 {
                3
            } else {
                0
            }
        }
        Err(error) => {
            if parsed.json {
                println!("{}", js::stringify_pretty(&json!({ "format": REPORT_FORMAT, "ok": false, "error": error }), 2));
            }
            eprintln!("[Сказание] import-legacy: {error}");
            1
        }
    }
}

/// Настройки переноса.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportOptions {
    pub from: PathBuf,
    pub to: PathBuf,
    pub dry_run: bool,
    pub force: bool,
}

/// Перенесённая (или пропущенная) комната.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportedRoom {
    pub code: String,
    pub version: i64,
    /// Версия журнала, к которой привязана накладка (`None` — комната без журнала).
    pub base_version: Option<i64>,
    /// Поля состояния, которые хранит накладка (отличия от журнала).
    pub overlay_fields: Vec<String>,
    pub messages: usize,
    pub skipped: Option<String>,
    pub warnings: Vec<String>,
}

/// Отчёт переноса.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyImportReport {
    pub dry_run: bool,
    pub from: PathBuf,
    pub to: PathBuf,
    pub accounts: LegacyAccountsReport,
    pub journal: ImportReport,
    pub rooms: Vec<ImportedRoom>,
    pub inventory: LegacyInventory,
    pub files_copied: usize,
}

impl LegacyImportReport {
    /// Пропущенные кампании и комнаты.
    pub fn skipped_count(&self) -> usize {
        self.journal.campaigns.iter().filter(|campaign| campaign.skipped.is_some()).count() + self.rooms.iter().filter(|room| room.skipped.is_some()).count()
    }

    pub fn to_json(&self) -> Value {
        let accounts = &self.accounts;
        let campaigns: Vec<Value> = self
            .journal
            .campaigns
            .iter()
            .map(|campaign| {
                let mut entry = Map::new();
                entry.insert("campaign_id".into(), json!(campaign.campaign_id));
                entry.insert("directory".into(), json!(campaign.directory));
                entry.insert("status".into(), json!(if campaign.skipped.is_some() { "skipped" } else { "imported" }));
                entry.insert("commits".into(), json!(campaign.commits));
                entry.insert("snapshots".into(), json!(campaign.snapshots));
                entry.insert("state_version".into(), json!(campaign.state_version));
                if let Some(reason) = &campaign.skipped {
                    entry.insert("code".into(), json!(campaign.skipped_code));
                    entry.insert("reason".into(), json!(reason));
                }
                entry.insert("warnings".into(), json!(campaign.warnings));
                Value::Object(entry)
            })
            .collect();
        let rooms: Vec<Value> = self
            .rooms
            .iter()
            .map(|room| {
                let mut entry = Map::new();
                entry.insert("code".into(), json!(room.code));
                entry.insert("status".into(), json!(if room.skipped.is_some() { "skipped" } else { "imported" }));
                entry.insert("version".into(), json!(room.version));
                entry.insert("base_version".into(), json!(room.base_version));
                entry.insert("messages".into(), json!(room.messages));
                entry.insert("overlay_fields".into(), json!(room.overlay_fields));
                if let Some(reason) = &room.skipped {
                    entry.insert("reason".into(), json!(reason));
                }
                entry.insert("warnings".into(), json!(room.warnings));
                Value::Object(entry)
            })
            .collect();
        json!({
            "format": REPORT_FORMAT,
            "ok": true,
            "dry_run": self.dry_run,
            "from": self.from.to_string_lossy(),
            "to": self.to.to_string_lossy(),
            "accounts": {
                "users": accounts.users, "admins": accounts.admins,
                "sessions": accounts.sessions, "sessions_expired": accounts.sessions_expired,
                "memberships": accounts.memberships, "invites": accounts.invites,
                "campaign_settings": accounts.settings, "campaign_settings_rejected": accounts.settings_rejected,
            },
            "campaigns": campaigns,
            "map_blobs": self.journal.map_blobs,
            "map_blobs_rejected": self.journal.map_blobs_rejected,
            "rooms": rooms,
            "files": { "planned": self.inventory.copy.len(), "copied": self.files_copied, "bytes": self.inventory.copy_bytes },
            "ignored": self.inventory.ignored.iter().map(|(path, reason)| json!({ "path": path, "reason": reason })).collect::<Vec<_>>(),
            "unknown": self.inventory.unknown,
            "skipped": self.skipped_count(),
        })
    }

    pub fn to_text(&self) -> String {
        let mut lines = Vec::new();
        let mode = if self.dry_run { "проверка (--dry-run), ничего не записано" } else { "перенос выполнен" };
        lines.push(format!("Перенос хранилища JS → Rust: {mode}"));
        lines.push(format!("  из: {}", self.from.display()));
        lines.push(format!("  в:  {}", self.to.display()));
        let a = &self.accounts;
        lines.push(format!(
            "Аккаунты: пользователей {} (админов {}), сессий {} (истёкших отброшено {}), членств {}, приглашений {}, настроек ИИ {}{}",
            a.users,
            a.admins,
            a.sessions,
            a.sessions_expired,
            a.memberships,
            a.invites,
            a.settings,
            if a.settings_rejected > 0 { format!(" (повреждённых пропущено {})", a.settings_rejected) } else { String::new() }
        ));
        let imported = self.journal.campaigns.iter().filter(|campaign| campaign.skipped.is_none()).count();
        lines.push(format!("Кампании: перенесено {imported} из {}; карт по хешу {} (отвергнуто {})", self.journal.campaigns.len(), self.journal.map_blobs, self.journal.map_blobs_rejected));
        for campaign in &self.journal.campaigns {
            match &campaign.skipped {
                Some(reason) => lines.push(format!("  ПРОПУЩЕНА {} ({}): {reason}", campaign.campaign_id, campaign.directory)),
                None => lines.push(format!("  {} — версия {}, коммитов {}, снимков {}", campaign.campaign_id, campaign.state_version, campaign.commits, campaign.snapshots)),
            }
            for warning in &campaign.warnings {
                lines.push(format!("    замечание: {warning}"));
            }
        }
        let rooms = self.rooms.iter().filter(|room| room.skipped.is_none()).count();
        lines.push(format!("Комнаты: перенесено {rooms} из {}", self.rooms.len()));
        for room in &self.rooms {
            match &room.skipped {
                Some(reason) => lines.push(format!("  ПРОПУЩЕНА {}: {reason}", room.code)),
                None => lines.push(format!(
                    "  {} — версия {}, летопись {}, накладка: {}",
                    room.code,
                    room.version,
                    room.messages,
                    if room.overlay_fields.is_empty() { "—".to_string() } else { room.overlay_fields.join(", ") }
                )),
            }
            for warning in &room.warnings {
                lines.push(format!("    замечание: {warning}"));
            }
        }
        lines.push(format!("Файлы: {} к копированию ({} байт), скопировано {}", self.inventory.copy.len(), self.inventory.copy_bytes, self.files_copied));
        for (path, reason) in &self.inventory.ignored {
            lines.push(format!("  не переносится: {path} — {reason}"));
        }
        for path in &self.inventory.unknown {
            lines.push(format!("  НЕИЗВЕСТНО (не переносится): {path}"));
        }
        lines.join("\n")
    }
}

/// Путь без `..` и ссылок: существующая часть — `canonicalize`, остальное
/// дописывается как есть.
fn resolved(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    if let Ok(real) = absolute.canonicalize() {
        // `\\?\C:\…` (Windows) — обычный путь с буквой диска: так его печатает
        // отчёт и так его сравнивают обе стороны.
        let text = real.to_string_lossy();
        return match text.strip_prefix(r"\\?\") {
            Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
            _ => real,
        };
    }
    match (absolute.parent(), absolute.file_name()) {
        (Some(parent), Some(name)) if parent != absolute => resolved(parent).join(name),
        _ => absolute,
    }
}

fn writer_live(dir: &Path) -> Option<Value> {
    let inspected = sk_infra::backup_service::inspect_storage_writer(dir, &Default::default()).ok()?;
    (inspected.get("state").and_then(Value::as_str) == Some("live")).then_some(inspected)
}

/// Отказ старта (решение §4 п. 5 плана): в каталоге хранилища лежат файлы
/// JS-сервера, а база пуста — сервер не должен тихо начать с пустого мира.
pub fn startup_refusal(storage_dir: &Path) -> Option<String> {
    let markers = legacy_markers(storage_dir);
    if markers.is_empty() {
        return None;
    }
    // Нечитаемую базу судит обычное открытие хранилища, а не этот сторож.
    if database_has_data(&storage_dir.join(STORE_FILE)).unwrap_or(true) {
        return None;
    }
    Some(format!(
        "В {} лежит хранилище прежнего JS-сервера ({}), а база {STORE_FILE} пуста. Выполните import-legacy: skazanie-server import-legacy --from <копия JS storage> --to <пустой каталог> — и запустите сервер с DND_STORAGE_DIR=<этот каталог>.",
        storage_dir.display(),
        markers.join(", ")
    ))
}

fn check_target(to: &Path, force: bool) -> Result<(), String> {
    if !to.exists() {
        return Ok(());
    }
    if !to.is_dir() {
        return Err(format!("--to {} — не каталог", to.display()));
    }
    let database = to.join(STORE_FILE);
    match database_has_data(&database) {
        Ok(false) => {}
        Ok(true) => return Err(format!("В {} уже есть данные — перенос пишет только в пустое хранилище; база не перезаписывается и с --force", database.display())),
        Err(error) => return Err(format!("{}: база не читается ({error}) — перенос не пишет поверх неё", database.display())),
    }
    let entries: Vec<String> = std::fs::read_dir(to).map_err(|error| format!("{}: {error}", to.display()))?.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().to_string()).collect();
    if !entries.is_empty() && !force {
        let mut shown = entries.clone();
        shown.sort();
        shown.truncate(5);
        return Err(format!("Каталог {} не пуст ({}{}) — перенос пишет только в пустой каталог; --force разрешает непустой (совпадающие файлы будут перезаписаны)", to.display(), shown.join(", "), if entries.len() > 5 { ", …" } else { "" }));
    }
    Ok(())
}

/// Перенести хранилище. `Err` — отказ до записи или сбой (текст для человека).
pub fn import_legacy_storage(options: &ImportOptions) -> Result<LegacyImportReport, String> {
    let from = resolved(&options.from);
    let to = resolved(&options.to);
    if !from.is_dir() {
        return Err(format!("--from {} — нет такого каталога", options.from.display()));
    }
    if legacy_markers(&from).is_empty() {
        return Err(format!("В {} нет хранилища JS-сервера (auth.json, rooms/, campaign-settings/, engine/campaigns/)", from.display()));
    }
    if from == to || to.starts_with(&from) || from.starts_with(&to) {
        return Err(format!("--from и --to не должны совпадать или лежать друг в друге ({} и {})", from.display(), to.display()));
    }
    if let Some(writer) = writer_live(&from) {
        return Err(format!("В {} работает сервер (отметка {}, pid {}): остановите его — перенос с живого хранилища несогласован", from.display(), js::s(writer.get("marker_file")), writer.get("pid").map_or_else(String::new, Value::to_string)));
    }
    if !options.dry_run {
        check_target(&to, options.force)?;
        if let Some(writer) = writer_live(&to) {
            return Err(format!("В {} работает сервер (отметка {}): перенос в живое хранилище запрещён", to.display(), js::s(writer.get("marker_file"))));
        }
    }
    let inventory = legacy_inventory(&from);
    if options.dry_run {
        let accounts = Accounts::in_memory().map_err(|error| error.message)?;
        let reducer = Arc::new(GameReducer::new());
        let events = EventStore::in_memory(reducer.clone(), StoreOptions::default()).map_err(|error| error.to_string())?.with_map_cells(Arc::new(TacticalMapCells));
        let (accounts_report, journal, rooms) = import_into(&from, &accounts, &events, &reducer)?;
        return Ok(LegacyImportReport { dry_run: true, from, to, accounts: accounts_report, journal, rooms, inventory, files_copied: 0 });
    }
    std::fs::create_dir_all(&to).map_err(|error| format!("{}: {error}", to.display()))?;
    let mut writer = sk_infra::backup_service::claim_storage_writer(&to, Default::default()).map_err(|error| format!("Не удалось отметить писателя {}: {error}", to.display()))?;
    let outcome = import_to_disk(&from, &to, &inventory, options.force);
    writer.release();
    let (accounts_report, journal, rooms, files_copied) = outcome?;
    Ok(LegacyImportReport { dry_run: false, from, to, accounts: accounts_report, journal, rooms, inventory, files_copied })
}

type Imported = (LegacyAccountsReport, ImportReport, Vec<ImportedRoom>);

fn temp_database(to: &Path) -> PathBuf {
    to.join(format!("{STORE_FILE}.importing"))
}

fn remove_database(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}{suffix}", path.display())));
    }
}

fn import_to_disk(from: &Path, to: &Path, inventory: &LegacyInventory, force: bool) -> Result<(LegacyAccountsReport, ImportReport, Vec<ImportedRoom>, usize), String> {
    let temporary = temp_database(to);
    remove_database(&temporary);
    let result = (|| {
        let imported = {
            let accounts = Accounts::open(&temporary).map_err(|error| error.message)?;
            let reducer = Arc::new(GameReducer::new());
            let events = sk_tactics::cutover_audit::open_game_store(&temporary, reducer.clone())?;
            let imported = import_into(from, &accounts, &events, &reducer)?;
            // Один файл без -wal/-shm: база встаёт на место переименованием.
            // Режим журнала меняется только последним соединением.
            drop(accounts);
            events.with_connection_mut(|conn| Ok(conn.pragma_update(None, "journal_mode", "DELETE")?)).map_err(|error| error.to_string())?;
            imported
        };
        let copied = copy_inventory(inventory, from, to, force).map_err(|error| error.to_string())?;
        let target = to.join(STORE_FILE);
        if target.exists() {
            // Пустая база (проверено `check_target`): уступает место перенесённой.
            remove_database(&target);
        }
        // Если WAL всё же остался (смена режима не прошла), он едет вместе с базой.
        let wal = PathBuf::from(format!("{}-wal", temporary.display()));
        if wal.exists() {
            std::fs::rename(&wal, PathBuf::from(format!("{}-wal", target.display()))).map_err(|error| format!("{}: {error}", wal.display()))?;
        }
        std::fs::rename(&temporary, &target).map_err(|error| format!("{} → {}: {error}", temporary.display(), target.display()))?;
        Ok((imported.0, imported.1, imported.2, copied))
    })();
    if result.is_err() {
        remove_database(&temporary);
    }
    result
}

fn verify_campaign(reducer: &GameReducer) -> impl Fn(&EventStore, &str) -> Result<Vec<String>, StoreError> + '_ {
    move |store: &EventStore, campaign_id: &str| {
        reducer.take_failures();
        let head = store.load(campaign_id, &LoadOptions::default())?;
        let mut warnings: Vec<String> = reducer.take_failures().into_iter().map(|failure| format!("NORMALIZE_FAILED: {failure}")).collect();
        match store.load(campaign_id, &LoadOptions { use_snapshots: Some(false), ..LoadOptions::default() }) {
            Ok(replayed) => {
                let head_hash = sk_narration_base::projection_integrity::projection_hash(&head.state);
                if head_hash != sk_narration_base::projection_integrity::projection_hash(&replayed.state) {
                    warnings.push("REPLAY_DIVERGENCE: голова со снимками не совпала с полным replay".into());
                }
            }
            Err(error) => warnings.push(format!("REPLAY_FAILED: {error}")),
        }
        warnings.extend(reducer.take_failures().into_iter().map(|failure| format!("NORMALIZE_FAILED: {failure}")));
        Ok(warnings)
    }
}

fn import_into(from: &Path, accounts: &Accounts, events: &EventStore, reducer: &GameReducer) -> Result<Imported, String> {
    let accounts_report = accounts.import_legacy_report(from).map_err(|error| error.message)?;
    let verify = verify_campaign(reducer);
    let journal = sk_store::import_file_store_verified(events, from.join("engine"), &verify).map_err(|error| error.to_string())?;
    let rooms = import_rooms(from, events, &journal)?;
    Ok((accounts_report, journal, rooms))
}

fn room_files(from: &Path) -> Vec<(String, PathBuf)> {
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(from.join("rooms"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let code = name.strip_suffix(".json")?.to_string();
            // `listRoomCodes`: /^[A-Z0-9-]+\.json$/.
            (!code.is_empty() && code.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-')).then_some((code, entry.path()))
        })
        .collect();
    files.sort();
    files
}

fn import_rooms(from: &Path, events: &EventStore, journal: &ImportReport) -> Result<Vec<ImportedRoom>, String> {
    let skipped_dirs: HashSet<&str> = journal.campaigns.iter().filter(|campaign| campaign.skipped.is_some()).map(|campaign| campaign.directory.as_str()).collect();
    let imported_ids: HashSet<&str> = journal.campaigns.iter().filter(|campaign| campaign.skipped.is_none()).map(|campaign| campaign.campaign_id.as_str()).collect();
    let mut rooms = Vec::new();
    for (code, path) in room_files(from) {
        let mut room = ImportedRoom { code: code.clone(), ..ImportedRoom::default() };
        if code.chars().count() > 24 {
            // `roomFile(code)` обрезает код до 24 знаков: этот файл JS не читал.
            room.skipped = Some("код длиннее 24 знаков — комнату JS-сервер не открывал".into());
            rooms.push(room);
            continue;
        }
        let file = match std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
            Some(file) => file,
            None => {
                room.skipped = Some(format!("STORAGE_CORRUPTION: rooms/{code}.json не читается как JSON"));
                rooms.push(room);
                continue;
            }
        };
        let version = file.get("version").filter(|value| js::is_safe_integer(Some(value))).and_then(Value::as_i64).filter(|version| *version >= 0);
        let (true, Some(version)) = (file.is_object(), version) else {
            room.skipped = Some(format!("STORAGE_CORRUPTION: rooms/{code}.json — некорректная структура комнаты"));
            rooms.push(room);
            continue;
        };
        room.version = version;
        let mut state = match file.get("state") {
            Some(Value::Object(state)) => state.clone(),
            None | Some(Value::Null) => {
                // `getRoom` вернёт `state: null`, список кампаний её не покажет — как и Rust без накладки.
                room.skipped = Some("комната без состояния (state: null) — в списке кампаний её не было".into());
                rooms.push(room);
                continue;
            }
            Some(_) => {
                room.skipped = Some(format!("STORAGE_CORRUPTION: rooms/{code}.json — состояние не объект"));
                rooms.push(room);
                continue;
            }
        };
        if skipped_dirs.contains(legacy_campaign_directory(&code).as_str()) {
            room.skipped = Some("журнал кампании пропущен (см. кампании) — комнату без журнала сервер отдал бы вместо отказа восстановления".into());
            rooms.push(room);
            continue;
        }
        if !imported_ids.contains(code.as_str()) {
            room.warnings.push("у комнаты нет журнала — состояние перенесено накладкой целиком".into());
        }
        if let Some(Value::Array(messages)) = state.get_mut("messages") {
            if messages.len() > ROOM_JOURNAL_LIMIT {
                room.warnings.push(format!("летопись {} записей — оставлены последние {ROOM_JOURNAL_LIMIT}", messages.len()));
                messages.drain(..messages.len() - ROOM_JOURNAL_LIMIT);
            }
            room.messages = messages.len();
        }
        let mut state = Value::Object(state);
        // Комната JS хранит производные поля героя значениями; в каноническом
        // состоянии на их месте пустые слоты, значения выводятся при чтении
        // (урок 2) — иначе накладка тащила бы их и не сходилась с журналом.
        sk_rules::derived::strip_derived_fields(&mut state);
        let body = crate::room::overlay_for(events, &code, &state).map_err(|failure| failure.message)?;
        let composed = match crate::room::compose(events, &body) {
            Ok(composed) => composed,
            Err(failure) => {
                room.skipped = Some(format!("накладка не собирается: {}", failure.message));
                rooms.push(room);
                continue;
            }
        };
        if composed != state {
            room.skipped = Some("накладка поверх журнала не воспроизводит комнату".into());
            rooms.push(room);
            continue;
        }
        room.base_version = body.get("base").and_then(|base| base.get("state_version")).and_then(Value::as_i64);
        room.overlay_fields = body.get("fields").and_then(Value::as_object).map(|fields| fields.keys().cloned().collect()).unwrap_or_default();
        if body.get("online").is_some() {
            room.overlay_fields.push("players[].online".into());
        }
        for removed in body.get("removed").and_then(Value::as_array).into_iter().flatten() {
            room.overlay_fields.push(format!("-{}", js::s(Some(removed))));
        }
        let updated_at = match file.get("updatedAt").and_then(Value::as_str) {
            Some(updated_at) => updated_at.to_string(),
            None => {
                room.warnings.push("нет updatedAt — подставлено время переноса".into());
                sk_core::clock::iso(sk_core::clock::now_ms())
            }
        };
        let written = events.import_room_overlay(&RoomOverlay { room_id: code.clone(), version, body, updated_at }).map_err(|error| error.to_string())?;
        if !written {
            room.skipped = Some("накладка комнаты уже есть в базе".into());
        }
        rooms.push(room);
    }
    Ok(rooms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_arguments_and_refuses_unknown() {
        let parsed = parse_args(&strings(&["--from", "a", "--to", "b", "--dry-run", "--json"])).expect("аргументы");
        assert_eq!((parsed.from, parsed.to, parsed.dry_run, parsed.force, parsed.json), (PathBuf::from("a"), Some(PathBuf::from("b")), true, false, true));
        assert!(parse_args(&strings(&["--to", "b"])).is_err(), "без --from — отказ");
        assert!(parse_args(&strings(&["--from"])).is_err());
        assert!(parse_args(&strings(&["--from", "a", "--port", "1"])).is_err(), "неизвестный аргумент — отказ, а не запуск сервера");
        assert!(parse_args(&strings(&["--help"])).expect("справка").help);
    }
}
