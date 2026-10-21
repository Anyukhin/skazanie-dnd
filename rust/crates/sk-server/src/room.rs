//! Комната кампании — **заглушка С0**, реализация — С1.
//!
//! Решение ведущего №2: комната — проекция журнала плюс накладка (летопись не
//! больше 400 записей, поля только комнаты, `room.version` — счётчик накладки
//! в одной транзакции SQLite с подтверждением проекции). Форма та же, что у
//! `getRoom(code)` JS (`server/store.mjs:444–450`):
//! `{ version, state, updatedAt }`.

use serde_json::{json, Value};

use crate::core::GameCore;
use crate::error::Failure;

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

/// `getRoom(code)`. С1: состояние из журнала плюс накладка.
pub fn get_room(_core: &GameCore, campaign_id: &str) -> Result<Room, Failure> {
    // До С1 комнат нет: любая кампания выглядит несозданной, как пустой
    // файл комнаты в JS.
    Ok(Room::empty(campaign_id))
}

/// `listRoomCodes()` (`store.mjs:472–476`). С1: кампании журнала.
pub fn list_room_codes(_core: &GameCore) -> Result<Vec<String>, Failure> {
    Ok(Vec::new())
}
