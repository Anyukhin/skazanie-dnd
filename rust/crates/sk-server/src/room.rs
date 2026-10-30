//! Комната кампании — перенос `getRoom`, `saveRoom`, `listRoomCodes` и
//! `onRoomSaved` (`server/store.mjs:394–398, 438–477`).
//!
//! Решение ведущего №2: комната — **проекция журнала плюс накладка** в той же
//! SQLite (`sk_store::RoomOverlay`). Файла с полным состоянием, как в JS, нет:
//! накладка хранит отсылку к версии журнала (`base`) и только то, чем
//! записанное состояние комнаты отличается от состояния журнала на этой
//! версии:
//!
//! - `fields` — поля верхнего уровня, которых нет в журнале или которые
//!   отличаются (летопись `messages`, `isNarrating`, `state_projector_version`
//!   и всё, что маршрут положил в комнату сверх журнала);
//! - `removed` — поля журнала, которых в комнате нет;
//! - `online` — присутствие героев (`players[].online`), если в остальном
//!   герои комнаты совпадают с героями журнала; иначе `players` целиком в
//!   `fields`.
//!
//! Чтение — состояние журнала на `base` (голова берётся из кэша хранилища) с
//! наложенными отличиями, то есть ровно то состояние, которое записал
//! `save_room` (порядок ключей верхнего уровня — журнала, а не JS; сравнение
//! `Value` и хеш проекции от порядка не зависят). Комната без журнала (импорт,
//! тесты) хранит состояние целиком в `fields` (`base: null`).
//!
//! `room.version` — счётчик строки накладки: запись идёт сравнением с обменом
//! (`saveRoom(code, state, baseVersion)` → `{ conflict, room }`), а
//! подтверждение проекции можно передать в ту же транзакцию (см.
//! [`crate::projection`]).

use std::rc::Rc;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_store::{EventStore, LoadOptions, RoomOverlaySave, RoomOverlayWrite, RoomProjectionAck, StoreResult};

use crate::core::GameCore;
use crate::error::Failure;

/// Версия формы тела накладки.
const OVERLAY_SCHEMA: i64 = 1;

/// `getRoom(code)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    /// Код кампании в верхнем регистре.
    pub code: String,
    /// `room.version`.
    pub version: i64,
    /// `room.state` (`null` — кампании ещё нет).
    pub state: Option<Value>,
    /// `room.updatedAt` (ISO-строка) или `null`.
    pub updated_at: Option<String>,
}

impl Room {
    /// Комната без состояния: `{ version: 0, state: null, updatedAt: null }`.
    pub fn empty(code: &str) -> Self {
        Self { code: code.to_uppercase(), version: 0, state: None, updated_at: None }
    }

    /// `{ version, state, updatedAt }` — как `{...room}` в ответах JS.
    pub fn to_json(&self) -> Value {
        json!({ "version": self.version, "state": self.state, "updatedAt": self.updated_at })
    }
}

/// `saveRoom(...)` → `{ conflict, room }`.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedRoom {
    pub conflict: bool,
    pub room: Room,
}

/// `roomFile(code)` (`store.mjs:394–398`): верхний регистр, только
/// `[A-Z0-9-]`, не длиннее 24; пустой — `Error('Некорректный код комнаты')`.
pub fn room_key(code: &str) -> Result<String, Failure> {
    let key: String = code.to_uppercase().chars().filter(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '-').take(24).collect();
    if key.is_empty() {
        return Err(Failure::new("Некорректный код комнаты", None));
    }
    Ok(key)
}

/// `getRoom(code)`: накладка поверх журнала; комнаты нет — пустая.
pub fn get_room(core: &GameCore, campaign_id: &str) -> Result<Room, Failure> {
    let _span = sk_store::perf::span("room.get_room");
    read_room(&core.events, campaign_id)
}

/// [`get_room`] над журналом без ядра — для служебных подкоманд набора тестов
/// (`skazanie-server room`, `audit`): то же состояние, что прочтёт сервер.
pub fn read_room(events: &EventStore, campaign_id: &str) -> Result<Room, Failure> {
    let key = room_key(campaign_id)?;
    let Some(overlay) = events.room_overlay(&key)? else { return Ok(Room::empty(&key)) };
    let state = compose(events, &overlay.body)?;
    Ok(Room { code: key, version: overlay.version, state: Some(state), updated_at: Some(overlay.updated_at) })
}

/// `listRoomCodes()` (`store.mjs:472–476`): коды комнат (`/^[A-Z0-9-]+$/`).
pub fn list_room_codes(core: &GameCore) -> Result<Vec<String>, Failure> {
    let codes = core.events.room_overlay_ids()?;
    Ok(codes.into_iter().filter(|code| !code.is_empty() && code.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-')).collect())
}

/// `saveRoom(code, state, baseVersion)` (`store.mjs:452–470`).
pub fn save_room(core: &Rc<GameCore>, code: &str, state: &Value, base_version: i64) -> Result<SavedRoom, Failure> {
    Ok(save_room_with_ack(core, code, state, base_version, None)?.0)
}

/// `saveRoom` с подтверждением проекции в той же транзакции; второе значение —
/// итог подтверждения (если запись состоялась и оно было запрошено).
pub(crate) fn save_room_with_ack(core: &Rc<GameCore>, code: &str, state: &Value, base_version: i64, ack: Option<RoomProjectionAck>) -> Result<(SavedRoom, Option<StoreResult<Value>>), Failure> {
    if !state.is_object() {
        return Err(Failure::new("Состояние комнаты должно быть объектом", Some("TYPE_ERROR")));
    }
    let key = room_key(code)?;
    let current = get_room(core, &key)?;
    if base_version != current.version {
        return Ok((SavedRoom { conflict: true, room: current }, None));
    }
    save_composed_room_with_ack(core, &key, state, base_version, ack)
}

/// [`save_room_with_ack`] для комнаты, которую вызывающий только что прочёл
/// [`get_room`] той же версии `base_version` в том же потоке ядра: сверка
/// версии и проверка, что накладка собирается, уже сделаны, второй сборки
/// комнаты нет (урок 11). Версию в транзакции всё равно сверяет хранилище —
/// чужая запись между чтением и записью даёт конфликт, как прежде.
pub(crate) fn save_composed_room_with_ack(core: &Rc<GameCore>, code: &str, state: &Value, base_version: i64, ack: Option<RoomProjectionAck>) -> Result<(SavedRoom, Option<StoreResult<Value>>), Failure> {
    if !state.is_object() {
        return Err(Failure::new("Состояние комнаты должно быть объектом", Some("TYPE_ERROR")));
    }
    let key = room_key(code)?;
    // Признак загрузки принадлежит запросу браузера, а не кампании (JS 457–458).
    let persistent = js::spread(state, json!({ "isNarrating": false }));
    let body = {
        let _span = sk_store::perf::span("room.overlay_for");
        overlay_for(&core.events, &key, &persistent)?
    };
    // Сбой подтверждения из данных (`DND_COMMIT_FAULTS`, С2): подтверждение не
    // идёт в транзакцию, комната пишется — как отказ обещания в JS.
    let mut faulted = None;
    let ack = match ack {
        Some(ack) => match crate::test_hooks::acknowledge_fault(&ack.campaign_id, ack.projected_version) {
            Ok(()) => Some(ack),
            Err(error) => {
                faulted = Some(error);
                None
            }
        },
        None => None,
    };
    let saved = core.events.save_room_overlay(RoomOverlayWrite { room_id: &key, expected_version: base_version, body: &body, ack })?;
    match saved {
        RoomOverlaySave::Conflict { .. } => {
            let room = get_room(core, &key)?;
            Ok((SavedRoom { conflict: true, room }, None))
        }
        RoomOverlaySave::Saved { overlay, ack } => {
            let room = Room { code: key.clone(), version: overlay.version, state: Some(persistent), updated_at: Some(overlay.updated_at) };
            // Слушатели — по возможности, сохранённая комната от них не зависит
            // (JS 464–467); вне потока ядра хуки не ставятся.
            let hooks = core.room_hooks.borrow().clone();
            let _ = crate::projection::on_projection_saved(core, &key, &room, &hooks);
            Ok((SavedRoom { conflict: false, room }, faulted.map(Err).or(ack)))
        }
    }
}

// --- накладка ---------------------------------------------------------------

/// Состояние журнала, к которому привязывается запись: версия комнаты, если
/// она есть в журнале, иначе голова; журнала нет или он не читается — `None`
/// (комната хранится целиком). Состояние читается по ссылке из кэша журнала
/// (`EventStore::inspect`), без копии (Ск2).
fn with_base<T>(events: &EventStore, campaign_id: &str, state: &Value, operation: impl FnOnce(Option<(i64, &Value)>) -> T) -> T {
    let mut operation = Some(operation);
    let mut run = |base: Option<(i64, &Value)>| operation.take().map(|operation| operation(base));
    let wanted = state.get("state_version").filter(|value| js::is_safe_integer(Some(value))).and_then(Value::as_i64);
    let head = events.inspect(campaign_id, &LoadOptions::default(), |head, head_version| match wanted {
        Some(version) if (0..head_version).contains(&version) => Err(version),
        _ => Ok(run(Some((head_version, head)))),
    });
    let done = match head {
        Err(_) => run(None),
        Ok(Ok(done)) => done,
        Ok(Err(version)) => match events.inspect(campaign_id, &LoadOptions { at_version: Some(version), ..LoadOptions::default() }, |loaded, _| run(Some((version, loaded)))) {
            Ok(done) => done,
            Err(_) => run(None),
        },
    };
    done.or_else(|| run(None)).expect("операция над основой накладки исполняется ровно один раз")
}

/// Тело накладки: отличия записанного состояния от журнала. `pub(crate)` —
/// для записи комнаты мимо сервера подкомандой набора тестов
/// (`test_hooks::room_cli`).
pub(crate) fn overlay_for(events: &EventStore, key: &str, state: &Value) -> Result<Value, Failure> {
    with_base(events, key, state, |base| overlay_body(key, state, base))
}

fn overlay_body(key: &str, state: &Value, base: Option<(i64, &Value)>) -> Result<Value, Failure> {
    let empty = Map::new();
    let next = state.as_object().unwrap_or(&empty);
    let base_map = base.and_then(|(_, state)| state.as_object()).unwrap_or(&empty);
    let mut fields = Map::new();
    let mut online: Option<Map<String, Value>> = None;
    for (field, value) in next {
        if base_map.get(field) == Some(value) {
            continue;
        }
        if field == "players" {
            if let Some(map) = online_overlay(base_map.get("players"), value) {
                online = Some(map);
                continue;
            }
        }
        fields.insert(field.clone(), value.clone());
    }
    let removed: Vec<Value> = base_map.keys().filter(|field| !next.contains_key(*field)).map(|field| Value::String(field.clone())).collect();
    let mut body = Map::new();
    body.insert("schema".into(), Value::from(OVERLAY_SCHEMA));
    body.insert("base".into(), base.map_or(Value::Null, |(version, _)| json!({ "campaign_id": key, "state_version": version })));
    body.insert("removed".into(), Value::Array(removed));
    if let Some(online) = online {
        body.insert("online".into(), Value::Object(online));
    }
    body.insert("fields".into(), Value::Object(fields));
    Ok(Value::Object(body))
}

/// Герои комнаты = герои журнала плюс `online`: карта присутствия по id или
/// `None`, если отличаются не только присутствием.
fn online_overlay(base: Option<&Value>, next: &Value) -> Option<Map<String, Value>> {
    let (Some(Value::Array(base)), Value::Array(next_players)) = (base, next) else { return None };
    if base.len() != next_players.len() {
        return None;
    }
    let mut online = Map::new();
    for (before, after) in base.iter().zip(next_players) {
        let (Value::Object(before), Value::Object(after)) = (before, after) else { return None };
        if before.get("online") == after.get("online") {
            continue;
        }
        let value = after.get("online")?;
        online.insert(js::string(after.get("id")), value.clone());
    }
    let composed = with_online(base, &online);
    (composed == *next_players).then_some(online)
}

/// `{ ...player, online }` для героев из карты присутствия.
fn with_online(players: &[Value], online: &Map<String, Value>) -> Vec<Value> {
    players
        .iter()
        .map(|player| match (player, online.get(&js::string(player.get("id")))) {
            (Value::Object(map), Some(value)) => {
                let mut map = map.clone();
                map.insert("online".into(), value.clone());
                Value::Object(map)
            }
            _ => player.clone(),
        })
        .collect()
}

/// Состояние комнаты из журнала и накладки.
pub(crate) fn compose(events: &EventStore, body: &Value) -> Result<Value, Failure> {
    let mut state = match body.get("base") {
        Some(Value::Object(base)) => {
            let campaign_id = js::s(base.get("campaign_id"));
            let version = js::safe_int(base.get("state_version"), 0);
            events.load(&campaign_id, &LoadOptions { at_version: Some(version), ..LoadOptions::default() })?.state
        }
        _ => Value::Object(Map::new()),
    };
    let Value::Object(map) = &mut state else {
        return Err(Failure::new("Хранилище повреждено и не будет перезаписано автоматически: состояние журнала комнаты — не объект", Some("STORAGE_CORRUPTION")));
    };
    for field in body.get("removed").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        map.shift_remove(&js::s(Some(field)));
    }
    if let Some(Value::Object(online)) = body.get("online") {
        if let Some(Value::Array(players)) = map.get("players") {
            let players = with_online(players, online);
            map.insert("players".into(), Value::Array(players));
        }
    }
    if let Some(Value::Object(fields)) = body.get("fields") {
        for (field, value) in fields {
            map.insert(field.clone(), value.clone());
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_key_matches_js_room_file() {
        assert_eq!(room_key("abc-1").ok().as_deref(), Some("ABC-1"));
        assert_eq!(room_key(" a_b.c ").ok().as_deref(), Some("ABC"));
        assert_eq!(room_key("ıx").ok().as_deref(), Some("IX"), "toUpperCase до фильтра, как в JS");
        assert_eq!(room_key("abcdefghijklmnopqrstuvwxyz").ok().as_deref(), Some("ABCDEFGHIJKLMNOPQRSTUVWX"));
        assert_eq!(room_key("___").err().map(|failure| failure.message), Some("Некорректный код комнаты".to_string()));
    }

    #[test]
    fn online_overlay_only_when_heroes_match() {
        let base = json!([{ "id": "a", "hp": 3 }, { "id": "b", "online": false }]);
        let next = json!([{ "id": "a", "hp": 3, "online": true }, { "id": "b", "online": false }]);
        assert_eq!(online_overlay(Some(&base), &next), Some(json!({ "a": true }).as_object().cloned().unwrap_or_default()));
        let changed = json!([{ "id": "a", "hp": 4, "online": true }, { "id": "b", "online": false }]);
        assert_eq!(online_overlay(Some(&base), &changed), None);
        let dropped = json!([{ "id": "a", "hp": 3 }, { "id": "b" }]);
        assert_eq!(online_overlay(Some(&base), &dropped), None, "снятый online картой не выразить");
    }
}
