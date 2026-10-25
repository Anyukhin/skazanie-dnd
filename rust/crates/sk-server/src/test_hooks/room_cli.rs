//! Подкоманды `skazanie-server room` и `skazanie-server audit` — комната и
//! целостность хранилища глазами теста. Контракт — шапка `test/kit/rooms.mjs`
//! (режим `rust` набора):
//!
//! ```text
//! skazanie-server room  --storage <dir> --campaign <код>            → { version, state, updatedAt } | null
//! skazanie-server room  --storage <dir> --campaign <код> --write    (JSON { "state": … } на stdin)
//! skazanie-server audit --storage <dir>                             → отчёт аудита
//! ```
//!
//! Комната — проекция журнала плюс накладка (решение ведущего №2): чтение
//! собирает её тем же [`crate::room::read_room`], что и сервер. Запись мимо
//! сервера кладёт отличия состояния от журнала в накладку — так, как их
//! положил бы `save_room`, но без подтверждения проекции и без слушателей:
//! это «внешний дрейф» комнаты (`projection-postcommit-error-api`,
//! `reconcile-access-perf-api`), который сервер обязан найти сверкой.
//!
//! `audit` — аудит `sk_tactics::cutover_audit` (журнал против replay,
//! подтверждение проекции) плюс сверка записанной комнаты с головой журнала,
//! как у `auditLegacyCutover` JS: `ROOM_PROJECTION_MISSING`,
//! `EVENT_STREAM_MISSING`, `PROJECTION_DIVERGENCE`,
//! `PROJECTION_VERSION_DIVERGENCE`, `RETIRED_MODE_IN_ROOM`. Накладка может
//! держать канонические поля, которых нет в журнале, поэтому расхождение
//! комнаты в Rust не невозможно, а находится той же сверкой.
//!
//! Чтение и аудит идут и при живом сервере (SQLite в WAL). Запись требует
//! `NODE_ENV=test` и хранилище прямо во временном каталоге. Без фичи
//! `test-hooks` подкоманд нет.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_narration_base::projection_integrity::compare_projection;
use sk_store::{EventStore, LoadOptions, RoomOverlaySave, RoomOverlayWrite};

use crate::room::{overlay_for, read_room, room_key, Room};

/// Подкоманда.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// `room` — прочитать или (`write`) записать комнату кампании.
    Room { storage: PathBuf, campaign: String, write: bool },
    /// `audit` — аудит хранилища.
    Audit { storage: PathBuf },
}

/// Разбор аргументов после слова `room` или `audit`.
pub fn parse_args(name: &str, args: &[String]) -> Result<Command, String> {
    let mut storage = None;
    let mut campaign = None;
    let mut write = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--storage" => storage = Some(PathBuf::from(iter.next().ok_or("--storage: нужно значение")?)),
            "--campaign" if name == "room" => campaign = Some(iter.next().ok_or("--campaign: нужно значение")?.clone()),
            "--write" if name == "room" => write = true,
            other => return Err(format!("неизвестный аргумент {other}")),
        }
    }
    let storage = storage.ok_or("нужен --storage <каталог>")?;
    match name {
        "room" => Ok(Command::Room { storage, campaign: campaign.filter(|code| !code.is_empty()).ok_or("нужен --campaign <код>")?, write }),
        "audit" => Ok(Command::Audit { storage }),
        other => Err(format!("неизвестная подкоманда {other}")),
    }
}

fn open(storage: &Path) -> Result<EventStore, String> {
    let database = storage.join(sk_tactics::cutover_audit::STORE_FILE);
    if !database.is_file() {
        return Err(format!("Нет хранилища: в {} нет {}", storage.display(), sk_tactics::cutover_audit::STORE_FILE));
    }
    sk_tactics::cutover_audit::open_game_store(&database, Arc::new(sk_tactics::cutover_audit::GameReducer::new()))
}

fn room_json(room: &Room) -> Value {
    if room.state.is_none() && room.updated_at.is_none() {
        return Value::Null;
    }
    room.to_json()
}

/// Исполнить подкоманду.
pub fn run(command: &Command, input: &str, node_env: Option<&str>, temp_dir: &Path) -> Result<Value, String> {
    match command {
        Command::Room { storage, campaign, write: false } => {
            let store = open(storage)?;
            Ok(room_json(&read_room(&store, campaign).map_err(|failure| failure.message)?))
        }
        Command::Room { storage, campaign, write: true } => {
            let absolute = std::path::absolute(storage).unwrap_or_else(|_| storage.clone());
            if node_env != Some("test") || !super::directly_in(&absolute, temp_dir) {
                return Err("room --write: только при NODE_ENV=test и хранилище прямо во временном каталоге".to_string());
            }
            let body: Value = serde_json::from_str(input).map_err(|error| format!("room --write: JSON {{ state }} на stdin: {error}"))?;
            let state = body.get("state").filter(|state| state.is_object()).ok_or("room --write: state — объект")?;
            let store = open(storage)?;
            write_room(&store, campaign, state)
        }
        Command::Audit { storage } => audit(storage),
    }
}

/// Записать состояние комнаты мимо сервера: накладка с отличиями от журнала,
/// версия — следующая за текущей, подтверждения проекции нет.
fn write_room(store: &EventStore, campaign: &str, state: &Value) -> Result<Value, String> {
    let key = room_key(campaign).map_err(|failure| failure.message)?;
    let current = read_room(store, &key).map_err(|failure| failure.message)?;
    if current.state.is_none() {
        return Err(format!("writeRoom: нет комнаты {key}"));
    }
    let body = overlay_for(store, &key, state).map_err(|failure| failure.message)?;
    match store.save_room_overlay(RoomOverlayWrite { room_id: &key, expected_version: current.version, body: &body, ack: None }).map_err(|error| error.to_string())? {
        RoomOverlaySave::Saved { .. } => Ok(room_json(&read_room(store, &key).map_err(|failure| failure.message)?)),
        RoomOverlaySave::Conflict { .. } => Err(format!("writeRoom: комнату {key} переписали одновременно — повторите")),
    }
}

/// Аудит хранилища: `sk_tactics` плюс сверка комнат с журналом.
fn audit(storage: &Path) -> Result<Value, String> {
    let mut report = sk_tactics::cutover_audit::audit_legacy_cutover(Some(storage))?;
    let database = storage.join(sk_tactics::cutover_audit::STORE_FILE);
    if !database.is_file() {
        return Ok(report);
    }
    let store = open(storage)?;
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

/// Точка входа из `main.rs` (`name` — `room` или `audit`): печатает JSON или
/// ошибку, возвращает код выхода.
pub fn main(name: &str, args: &[String]) -> i32 {
    if !super::ENABLED {
        eprintln!("skazanie-server {name}: бинарь собран без фичи test-hooks (cargo build --release -p sk-server --features test-hooks)");
        return 2;
    }
    let command = match parse_args(name, args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("skazanie-server {name}: {message}");
            return 2;
        }
    };
    let mut input = String::new();
    if matches!(command, Command::Room { write: true, .. }) {
        if let Err(error) = std::io::stdin().read_to_string(&mut input) {
            eprintln!("skazanie-server {name}: stdin: {error}");
            return 1;
        }
    }
    let node_env = std::env::var("NODE_ENV").ok();
    match run(&command, &input, node_env.as_deref(), &std::env::temp_dir()) {
        Ok(output) => {
            println!("{}", js::stringify(&output));
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
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
    fn parses_contract_forms() {
        assert_eq!(parse_args("room", &strings(&["--storage", "s", "--campaign", "A"])), Ok(Command::Room { storage: PathBuf::from("s"), campaign: "A".into(), write: false }));
        assert_eq!(parse_args("room", &strings(&["--storage", "s", "--campaign", "A", "--write"])), Ok(Command::Room { storage: PathBuf::from("s"), campaign: "A".into(), write: true }));
        assert_eq!(parse_args("audit", &strings(&["--storage", "s"])), Ok(Command::Audit { storage: PathBuf::from("s") }));
        assert!(parse_args("room", &strings(&["--storage", "s"])).is_err(), "без кампании");
        assert!(parse_args("audit", &strings(&["--storage", "s", "--write"])).is_err(), "запись — только у room");
    }
}
