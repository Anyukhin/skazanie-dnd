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
//! `audit` — та же сверка, что у рабочей подкоманды `audit-storage`
//! ([`crate::storage_audit::audit_storage`]: журнал против replay,
//! подтверждение проекции, комнаты против головы журнала), но без отказа на
//! живом писателе и всегда с JSON-отчётом.
//!
//! Чтение и аудит идут и при живом сервере (SQLite в WAL). Запись требует
//! `NODE_ENV=test` и хранилище прямо во временном каталоге. Без фичи
//! `test-hooks` подкоманд нет.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use sk_core::js;
use sk_store::{EventStore, RoomOverlaySave, RoomOverlayWrite};

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
    // Как `rooms/<код>.json` JS: производные поля героя — значениями, а не
    // пустыми слотами канонического состояния (урок 2). В той же форме сервер
    // считает хеш отметки проекции.
    let mut json = room.to_json();
    if let Some(state) = room.state.as_ref() {
        json["state"] = sk_rules::derived::materialized_state(state);
    }
    json
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
        Command::Audit { storage } => crate::storage_audit::audit_storage(storage),
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
    // Производные поля, пришедшие значениями, — не отличие от журнала: в
    // накладку ложатся только настоящие отличия.
    let mut state = state.clone();
    sk_rules::derived::strip_derived_fields(&mut state);
    let body = overlay_for(store, &key, &state).map_err(|failure| failure.message)?;
    match store.save_room_overlay(RoomOverlayWrite { room_id: &key, expected_version: current.version, body: &body, ack: None }).map_err(|error| error.to_string())? {
        RoomOverlaySave::Saved { .. } => Ok(room_json(&read_room(store, &key).map_err(|failure| failure.message)?)),
        RoomOverlaySave::Conflict { .. } => Err(format!("writeRoom: комнату {key} переписали одновременно — повторите")),
    }
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
