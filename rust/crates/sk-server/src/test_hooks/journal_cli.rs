//! Подкоманда `skazanie-server journal` — журнал кампании глазами теста.
//! Контракт — шапка `test/kit/journal.mjs` (режим `rust` набора):
//!
//! ```text
//! skazanie-server journal --storage <dir> --campaign <код> [--at-version N] [--no-snapshots]
//! skazanie-server journal --storage <dir> --campaign <код> --corrupt tail|seed
//! skazanie-server journal --storage <dir> --campaign <код> --append   (JSON коммита на stdin)
//! ```
//!
//! В stdout — ровно тот JSON, что возвращают `readJournal`, `corruptCampaign`
//! (ничего: причину знает набор) и `appendJournal` JS. Отказ — код 1 и
//! `КОД: сообщение` в stderr (набор показывает хвост stderr в ошибке, тест
//! сверяет `CAMPAIGN_RECOVERY_REQUIRED`, «Нет журнала» и т. п.); неверные
//! аргументы — код 2.
//!
//! Журнал открывается напрямую через `sk-store` той же сборкой, что у
//! сервера (`GameReducer`, клетки карт), без отметки писателя: чтение идёт и
//! при живом сервере (SQLite в WAL). Порча и запись мимо сервера требуют
//! `NODE_ENV=test` и хранилище прямо во временном каталоге — боевой storage
//! этой подкомандой не испортить. Без фичи `test-hooks` подкоманды нет.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_store::{CommitRequest, EventStore, LoadOptions, StoreError};

/// Режим подкоманды.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Read { at_version: Option<i64>, use_snapshots: bool },
    Corrupt(Corruption),
    Append,
}

/// Что портит `--corrupt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corruption {
    /// Потерять последний коммит журнала (`EVENT_LOG_TAIL_MISSING`).
    Tail,
    /// Потерять seed-снимок — снимок с наименьшей версией (`SEED_SNAPSHOT_MISSING`).
    Seed,
}

/// Разобранные аргументы.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub storage: PathBuf,
    pub campaign: String,
    pub mode: Mode,
}

/// Разбор аргументов после слова `journal`.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut storage = None;
    let mut campaign = None;
    let mut at_version = None;
    let mut use_snapshots = true;
    let mut corrupt = None;
    let mut append = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| iter.next().cloned().ok_or(format!("{name}: нужно значение"));
        match arg.as_str() {
            "--storage" => storage = Some(PathBuf::from(value("--storage")?)),
            "--campaign" => campaign = Some(value("--campaign")?),
            "--at-version" => {
                let text = value("--at-version")?;
                at_version = Some(text.parse::<i64>().ok().filter(|version| *version >= 0).ok_or(format!("--at-version: целое ≥ 0, получено {text}"))?);
            }
            "--no-snapshots" => use_snapshots = false,
            "--corrupt" => {
                corrupt = Some(match value("--corrupt")?.as_str() {
                    "tail" => Corruption::Tail,
                    "seed" => Corruption::Seed,
                    other => return Err(format!("--corrupt: режим tail или seed, получен {other}")),
                });
            }
            "--append" => append = true,
            other => return Err(format!("неизвестный аргумент {other}")),
        }
    }
    let storage = storage.ok_or("нужен --storage <каталог>")?;
    let campaign = campaign.filter(|code| !code.is_empty()).ok_or("нужен --campaign <код>")?;
    let mode = match (corrupt, append) {
        (Some(_), true) => return Err("--corrupt и --append вместе нельзя".to_string()),
        (Some(corruption), false) => Mode::Corrupt(corruption),
        (None, true) => Mode::Append,
        (None, false) => Mode::Read { at_version, use_snapshots },
    };
    if !matches!(mode, Mode::Read { .. }) && (at_version.is_some() || !use_snapshots) {
        return Err("--at-version и --no-snapshots — только для чтения".to_string());
    }
    Ok(Args { storage, campaign, mode })
}

/// Отказ подкоманды: сообщение в stderr и код выхода.
#[derive(Debug)]
pub struct CliError {
    pub code: i32,
    pub message: String,
}

impl From<StoreError> for CliError {
    fn from(error: StoreError) -> Self {
        Self { code: 1, message: error.to_string() }
    }
}

fn fail(message: impl Into<String>) -> CliError {
    CliError { code: 1, message: message.into() }
}

/// Точка входа из `main.rs`: печатает JSON или ошибку, возвращает код выхода.
pub fn main(args: &[String]) -> i32 {
    if !super::ENABLED {
        eprintln!("skazanie-server journal: бинарь собран без фичи test-hooks (cargo build --release -p sk-server --features test-hooks)");
        return 2;
    }
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("skazanie-server journal: {message}");
            return 2;
        }
    };
    let input = if parsed.mode == Mode::Append {
        let mut text = String::new();
        if let Err(error) = std::io::stdin().read_to_string(&mut text) {
            eprintln!("skazanie-server journal: stdin: {error}");
            return 1;
        }
        Some(text)
    } else {
        None
    };
    let node_env = std::env::var("NODE_ENV").ok();
    match run(&parsed, input.as_deref(), node_env.as_deref(), &std::env::temp_dir()) {
        Ok(output) => {
            if let Some(output) = output {
                println!("{}", sk_core::js::stringify(&output));
            }
            0
        }
        Err(error) => {
            eprintln!("{}", error.message);
            error.code
        }
    }
}

/// Исполнить подкоманду. `None` — печатать нечего (`--corrupt`).
pub fn run(args: &Args, input: Option<&str>, node_env: Option<&str>, temp_dir: &Path) -> Result<Option<Value>, CliError> {
    let destructive = !matches!(args.mode, Mode::Read { .. });
    if destructive && (node_env != Some("test") || !super::directly_in(&std::path::absolute(&args.storage).unwrap_or_else(|_| args.storage.clone()), temp_dir)) {
        return Err(fail("journal --corrupt/--append: только при NODE_ENV=test и хранилище прямо во временном каталоге"));
    }
    let store = open(&args.storage, &args.campaign)?;
    match &args.mode {
        Mode::Read { at_version, use_snapshots } => read(&store, &args.campaign, *at_version, *use_snapshots).map(Some),
        Mode::Corrupt(corruption) => corrupt(&store, &args.campaign, *corruption).map(|()| None),
        Mode::Append => append(&store, &args.campaign, input.unwrap_or("")).map(Some),
    }
}

/// Журнал хранилища; нет базы или кампании — «Нет журнала кампании», как
/// `jsLayout` набора (базу не создаём).
fn open(storage: &Path, campaign: &str) -> Result<EventStore, CliError> {
    let database = storage.join("skazanie.sqlite");
    if !database.is_file() {
        return Err(fail(format!("Нет журнала кампании {campaign}: в {} нет skazanie.sqlite", storage.display())));
    }
    let store = sk_tactics::cutover_audit::open_game_store(&database, Arc::new(sk_tactics::cutover_audit::GameReducer::new())).map_err(fail)?;
    let known = store.with_connection_mut(|conn| {
        let mut statement = conn.prepare("SELECT COUNT(*) FROM campaigns WHERE campaign_id = ?1")?;
        let count: i64 = statement.query_row([campaign], |row| row.get(0))?;
        Ok(count > 0)
    })?;
    if !known {
        return Err(fail(format!("Нет журнала кампании {campaign}")));
    }
    Ok(store)
}

/// Сырые тела коммитов по порядку — без проверки хвоста, как обход файлов JS.
fn raw_commits(store: &EventStore, campaign: &str) -> Result<Vec<Value>, CliError> {
    let bodies = store.with_connection_mut(|conn| {
        let mut statement = conn.prepare("SELECT body FROM commits WHERE campaign_id = ?1 ORDER BY version_after")?;
        let rows = statement.query_map([campaign], |row| row.get::<_, String>(0))?;
        let mut bodies = Vec::new();
        for row in rows {
            bodies.push(row?);
        }
        Ok(bodies)
    })?;
    bodies.iter().map(|body| serde_json::from_str::<Value>(body).map_err(|error| fail(format!("Нечитаемый коммит кампании {campaign}: {error}")))).collect()
}

/// `readJournal(server, code, { atVersion, useSnapshots })`.
fn read(store: &EventStore, campaign: &str, at_version: Option<i64>, use_snapshots: bool) -> Result<Value, CliError> {
    let commits = raw_commits(store, campaign)?;
    let loaded = store.load(campaign, &LoadOptions { at_version, use_snapshots: Some(use_snapshots), ..LoadOptions::default() })?;
    let pending = store.pending_projection(campaign, false)?;
    let events = |commit: &Value| commit.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(json!({
        "campaign_id": loaded.campaign_id,
        "state_version": loaded.state_version,
        "current_state_version": loaded.current_state_version,
        "state": loaded.state,
        "commits": commits.iter().map(|commit| json!({
            "idempotency_key": commit.get("idempotency_key"),
            "command_id": commit.get("command_id"),
            "state_version_before": commit.get("state_version_before"),
            "state_version_after": commit.get("state_version_after"),
            "events": events(commit),
        })).collect::<Vec<_>>(),
        "events": commits.iter().flat_map(events).collect::<Vec<_>>(),
        "pending_projection": pending.map(|pending| json!({ "checkpoint_version": pending.checkpoint_version, "state_version": pending.state_version })),
    }))
}

/// `corruptCampaign(server, code, 'tail' | 'seed')`: удалить последний коммит
/// или снимок с наименьшей версией (`sortedJson(snapshots)[0]` JS).
fn corrupt(store: &EventStore, campaign: &str, corruption: Corruption) -> Result<(), CliError> {
    let (table, column, order, empty) = match corruption {
        Corruption::Tail => ("commits", "version_after", "MAX", format!("corruptCampaign: у кампании {campaign} нет коммитов — терять нечего")),
        Corruption::Seed => ("snapshots", "state_version", "MIN", format!("corruptCampaign: у кампании {campaign} нет снимков")),
    };
    let removed = store.with_connection_mut(|conn| {
        let sql = format!("DELETE FROM {table} WHERE campaign_id = ?1 AND {column} = (SELECT {order}({column}) FROM {table} WHERE campaign_id = ?1)");
        Ok(conn.execute(&sql, [campaign])?)
    })?;
    if removed == 0 {
        return Err(fail(empty));
    }
    Ok(())
}

/// `appendJournal(server, code, commit)`: коммит мимо сервера; ожидаемая
/// версия по умолчанию — голова журнала.
fn append(store: &EventStore, campaign: &str, input: &str) -> Result<Value, CliError> {
    let commit: Value = serde_json::from_str(input).map_err(|error| fail(format!("appendJournal: JSON коммита на stdin: {error}")))?;
    let key = commit.get("idempotency_key").and_then(Value::as_str).ok_or_else(|| fail("appendJournal: нужен idempotency_key"))?;
    let events = commit.get("events").and_then(Value::as_array).cloned().ok_or_else(|| fail("appendJournal: нужен массив events"))?;
    let command_id = match commit.get("command_id") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().map(str::to_string).ok_or_else(|| fail("appendJournal: command_id — строка"))?),
    };
    let expected = match commit.get("expected_state_version") {
        None | Some(Value::Null) => store.load(campaign, &LoadOptions::default())?.state_version,
        Some(value) => value.as_i64().ok_or_else(|| fail("appendJournal: expected_state_version — целое"))?,
    };
    let result = store.commit(CommitRequest {
        campaign_id: campaign.to_string(),
        expected_state_version: expected,
        idempotency_key: key.to_string(),
        command_id,
        events,
        force_snapshot: false,
        metadata: json!({}),
    })?;
    Ok(json!({ "state_version": result.state_version, "state": result.state, "events": result.events, "duplicate": result.duplicate }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_contract_forms() {
        let read = parse_args(&strings(&["--storage", "/s", "--campaign", "ABC", "--at-version", "3", "--no-snapshots"])).unwrap();
        assert_eq!(read.mode, Mode::Read { at_version: Some(3), use_snapshots: false });
        assert_eq!(parse_args(&strings(&["--storage", "/s", "--campaign", "ABC", "--corrupt", "seed"])).unwrap().mode, Mode::Corrupt(Corruption::Seed));
        assert_eq!(parse_args(&strings(&["--storage", "/s", "--campaign", "ABC", "--append"])).unwrap().mode, Mode::Append);
        assert!(parse_args(&strings(&["--storage", "/s", "--campaign", "ABC", "--corrupt", "head"])).unwrap_err().contains("tail или seed"));
        assert!(parse_args(&strings(&["--campaign", "ABC"])).is_err());
        assert!(parse_args(&strings(&["--storage", "/s", "--campaign", "ABC", "--append", "--at-version", "1"])).is_err());
    }
}
