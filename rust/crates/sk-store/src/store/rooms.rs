//! Накладка комнаты — хранилище для `sk-server::room` (задача С1).
//!
//! Решение ведущего №2 (`rust/SERVER-PLAN.md`): комната — проекция журнала
//! плюс накладка в той же базе. Строка накладки — счётчик `room.version`,
//! время `updatedAt` и тело (JSON, форма — забота сервера: летопись, присутствие,
//! поля только комнаты и отсылка к версии журнала). Файла комнаты с полным
//! состоянием, как в JS (`server/store.mjs:438–477`), нет.
//!
//! Запись — сравнение с обменом: строка пишется с версией `expected + 1`,
//! только если текущая версия равна `expected` (отсутствующая строка — версия
//! 0, как `getRoom` JS на несозданной комнате). Подтверждение проекции
//! (`acknowledgeProjection`) можно передать в ту же транзакцию: счётчик и
//! отметка проекции фиксируются вместе или не фиксируются вовсе. Отказ самого
//! подтверждения (версия новее головы, повреждённый журнал) откатывает только
//! его — до точки сохранения: в JS подтверждение — отдельное обещание после
//! записи комнаты, и его отказ комнату не отменяет.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use crate::error::{StoreError, StoreResult};
use crate::store::{safe_id, safe_version, EventStore};

/// Строка накладки комнаты.
#[derive(Debug, Clone, PartialEq)]
pub struct RoomOverlay {
    pub room_id: String,
    /// `room.version`.
    pub version: i64,
    /// Тело накладки (форму задаёт сервер).
    pub body: Value,
    /// `room.updatedAt`.
    pub updated_at: String,
}

/// Подтверждение проекции в транзакции записи накладки.
#[derive(Debug, Clone, PartialEq)]
pub struct RoomProjectionAck {
    pub campaign_id: String,
    pub projected_version: i64,
    pub projection_hash: Option<String>,
}

/// Запись накладки.
#[derive(Debug, Clone, PartialEq)]
pub struct RoomOverlayWrite<'a> {
    pub room_id: &'a str,
    /// Версия, на которой основана запись (`baseVersion` у `saveRoom`).
    pub expected_version: i64,
    pub body: &'a Value,
    pub ack: Option<RoomProjectionAck>,
}

/// Итог записи накладки.
#[derive(Debug, Clone, PartialEq)]
pub enum RoomOverlaySave {
    /// Записано; `ack` — итог подтверждения проекции, если оно было в запросе.
    Saved { overlay: RoomOverlay, ack: Option<StoreResult<Value>> },
    /// Версия не совпала: строка не тронута, подтверждения не было.
    Conflict { current: Option<RoomOverlay> },
}

#[cfg(test)]
thread_local! {
    /// Сбой перед фиксацией транзакции (проверка атомарности).
    static FAIL_BEFORE_COMMIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn read_overlay(conn: &rusqlite::Connection, room_id: &str) -> StoreResult<Option<RoomOverlay>> {
    let row: Option<(i64, String, String)> =
        conn.query_row("SELECT version, body, updated_at FROM room_overlays WHERE room_id = ?1", params![room_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
    let Some((version, body, updated_at)) = row else { return Ok(None) };
    let body: Value = serde_json::from_str(&body).map_err(|error| StoreError::new("STORAGE_CORRUPTION", format!("Хранилище повреждено и не будет перезаписано автоматически: накладка комнаты {room_id} ({error})")))?;
    if version < 0 {
        return Err(StoreError::new("STORAGE_CORRUPTION", format!("Хранилище повреждено и не будет перезаписано автоматически: накладка комнаты {room_id} (Некорректная структура комнаты)")));
    }
    Ok(Some(RoomOverlay { room_id: room_id.to_string(), version, body, updated_at }))
}

impl EventStore {
    /// Накладка комнаты или `None` (комнаты нет).
    pub fn room_overlay(&self, room_id: &str) -> StoreResult<Option<RoomOverlay>> {
        let _span = crate::perf::span("store.room_overlay.read");
        let room_id = safe_id(room_id, "room_id")?;
        let inner = self.lock();
        read_overlay(&inner.conn, &room_id)
    }

    /// Коды комнат по возрастанию (`listRoomCodes`).
    pub fn room_overlay_ids(&self) -> StoreResult<Vec<String>> {
        let inner = self.lock();
        let mut statement = inner.conn.prepare("SELECT room_id FROM room_overlays ORDER BY room_id")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Записать накладку с проверкой версии; подтверждение проекции — в той же
    /// транзакции (см. шапку модуля).
    pub fn save_room_overlay(&self, request: RoomOverlayWrite<'_>) -> StoreResult<RoomOverlaySave> {
        let _span = crate::perf::span("store.room_overlay.save");
        let room_id = safe_id(request.room_id, "room_id")?;
        let expected = safe_version(request.expected_version, "expected_version")?;
        let body = serde_json::to_string(request.body)?;
        let mut inner = self.lock();
        let updated_at = self.now_iso();
        let transaction = inner.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_overlay(&transaction, &room_id)?;
        if current.as_ref().map_or(0, |overlay| overlay.version) != expected {
            drop(transaction);
            return Ok(RoomOverlaySave::Conflict { current });
        }
        let version = expected + 1;
        transaction.execute(
            "INSERT INTO room_overlays (room_id, version, body, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(room_id) DO UPDATE SET version = excluded.version, body = excluded.body, updated_at = excluded.updated_at",
            params![room_id, version, body, updated_at],
        )?;
        let ack = match request.ack {
            Some(ack) => {
                transaction.execute_batch("SAVEPOINT room_projection_ack")?;
                let outcome = safe_id(&ack.campaign_id, "campaign_id").and_then(|campaign_id| self.acknowledge_in(&transaction, &campaign_id, ack.projected_version, ack.projection_hash.as_deref()));
                if outcome.is_err() {
                    transaction.execute_batch("ROLLBACK TO room_projection_ack")?;
                }
                transaction.execute_batch("RELEASE room_projection_ack")?;
                Some(outcome)
            }
            None => None,
        };
        #[cfg(test)]
        if FAIL_BEFORE_COMMIT.with(|flag| flag.replace(false)) {
            return Err(StoreError::new("EVENT_STORE_ERROR", "synthetic room overlay failure"));
        }
        transaction.commit()?;
        Ok(RoomOverlaySave::Saved { overlay: RoomOverlay { room_id, version, body: request.body.clone(), updated_at }, ack })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{CommitRequest, InitializeRequest, StoreOptions, VersionOnlyReducer};
    use serde_json::json;
    use std::sync::Arc;

    fn store() -> EventStore {
        let options = StoreOptions { clock: Arc::new(|| 1_700_000_000_000), ..StoreOptions::default() };
        EventStore::in_memory(Arc::new(VersionOnlyReducer), options).unwrap_or_else(|error| panic!("{error}"))
    }

    fn write<'a>(room_id: &'a str, expected: i64, body: &'a Value, ack: Option<RoomProjectionAck>) -> RoomOverlayWrite<'a> {
        RoomOverlayWrite { room_id, expected_version: expected, body, ack }
    }

    fn checkpoint(store: &EventStore, campaign: &str) -> i64 {
        store.get_metadata(campaign).ok().and_then(|metadata| metadata["projection_checkpoint_version"].as_i64()).unwrap_or(-1)
    }

    fn seeded() -> EventStore {
        let store = store();
        assert!(store.initialize_campaign(InitializeRequest::new("ROOM-1", json!({}))).is_ok());
        let commit = store.commit(CommitRequest { campaign_id: "ROOM-1".into(), expected_state_version: 0, idempotency_key: "k1".into(), events: vec![json!({ "event_type": "Tick" })], ..Default::default() });
        assert!(commit.is_ok(), "{commit:?}");
        store
    }

    #[test]
    fn compare_and_swap_counts_versions_and_reports_conflict() {
        let store = store();
        assert_eq!(store.room_overlay("ROOM-1").ok(), Some(None));
        let body = json!({ "a": 1 });
        let saved = store.save_room_overlay(write("ROOM-1", 0, &body, None));
        let Ok(RoomOverlaySave::Saved { overlay, ack: None }) = saved else { panic!("{saved:?}") };
        assert_eq!((overlay.version, overlay.updated_at.as_str()), (1, "2023-11-14T22:13:20.000Z"));
        let stale = store.save_room_overlay(write("ROOM-1", 0, &json!({ "a": 2 }), None));
        let Ok(RoomOverlaySave::Conflict { current: Some(current) }) = stale else { panic!("{stale:?}") };
        assert_eq!((current.version, current.body), (1, json!({ "a": 1 })), "конфликт строку не трогает");
        assert!(matches!(store.save_room_overlay(write("ROOM-1", 1, &json!({ "a": 3 }), None)), Ok(RoomOverlaySave::Saved { .. })));
        assert_eq!(store.room_overlay("ROOM-1").ok().flatten().map(|overlay| (overlay.version, overlay.body)), Some((2, json!({ "a": 3 }))));
        let missing = store.save_room_overlay(write("ROOM-2", 4, &body, None));
        assert!(matches!(missing, Ok(RoomOverlaySave::Conflict { current: None })), "несозданная комната — версия 0");
        assert_eq!(store.room_overlay_ids().ok(), Some(vec!["ROOM-1".to_string()]));
    }

    #[test]
    fn acknowledgement_shares_the_transaction() {
        let store = seeded();
        assert_eq!(checkpoint(&store, "ROOM-1"), 0);
        let body = json!({});
        let ack = RoomProjectionAck { campaign_id: "ROOM-1".into(), projected_version: 1, projection_hash: Some("h".into()) };
        // Сбой перед фиксацией: ни счётчика, ни отметки проекции.
        FAIL_BEFORE_COMMIT.with(|flag| flag.set(true));
        assert!(store.save_room_overlay(write("ROOM-1", 0, &body, Some(ack.clone()))).is_err());
        assert_eq!(store.room_overlay("ROOM-1").ok(), Some(None), "счётчик откатился вместе с подтверждением");
        assert_eq!(checkpoint(&store, "ROOM-1"), 0, "подтверждение откатилось вместе со счётчиком");
        let saved = store.save_room_overlay(write("ROOM-1", 0, &body, Some(ack)));
        let Ok(RoomOverlaySave::Saved { overlay, ack: Some(Ok(metadata)) }) = saved else { panic!("{saved:?}") };
        assert_eq!(overlay.version, 1);
        assert_eq!((metadata["projection_checkpoint_version"].clone(), metadata["projection_checkpoint_hash"].clone()), (json!(1), json!("h")));
        assert_eq!(checkpoint(&store, "ROOM-1"), 1);
    }

    #[test]
    fn failed_acknowledgement_keeps_the_room_write() {
        let store = seeded();
        let body = json!({ "b": true });
        let ack = RoomProjectionAck { campaign_id: "ROOM-1".into(), projected_version: 5, projection_hash: None };
        let saved = store.save_room_overlay(write("ROOM-1", 0, &body, Some(ack)));
        let Ok(RoomOverlaySave::Saved { overlay, ack: Some(Err(error)) }) = saved else { panic!("{saved:?}") };
        assert_eq!((overlay.version, error.code), (1, "STATE_VERSION_CONFLICT"));
        assert_eq!(store.room_overlay("ROOM-1").ok().flatten().map(|overlay| overlay.version), Some(1), "отказ подтверждения комнату не отменяет (как в JS)");
        assert_eq!(checkpoint(&store, "ROOM-1"), 0);
    }
}
