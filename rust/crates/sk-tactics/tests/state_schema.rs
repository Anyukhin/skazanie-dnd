//! Версия схемы состояния в снимке и проверка формы при загрузке (урок 4):
//! снимок пишет `state_schema_version`, снимок известной версии грузится без
//! нормализации в то же состояние, что держала голова; база прежнего
//! формата (снимок без версии) мигрирует в то же состояние; сломанная форма
//! — явный отказ с путём поля.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use sk_core::js;
use sk_rules::normalize::normalize_campaign_state;
use sk_store::{CommitRequest, EventStore, InitializeRequest, LoadOptions, StoreResult};
use sk_tactics::cutover_audit::{open_game_store, GameReducer};

const ID: &str = "SCHEMA-1";

struct Database(PathBuf);

impl Database {
    fn new(name: &str) -> Self {
        let directory = std::env::temp_dir().join(format!("skazanie-state-schema-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("каталог базы");
        Self(directory.join("journal.sqlite"))
    }

    fn open(&self) -> EventStore {
        open_game_store(&self.0, Arc::new(GameReducer::new())).expect("база")
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        if let Some(directory) = self.0.parent() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

fn floor_cells(size: i64) -> Value {
    Value::Array((0..size).flat_map(|y| (0..size).map(move |x| json!({ "x": x, "y": y, "type": "floor", "revealed": true }))).collect())
}

fn campaign() -> Value {
    normalize_campaign_state(&json!({
        "sessionCode": ID,
        "campaign": "Схема",
        "players": [{ "id": "hero", "name": "Герой", "hp": 9, "maxHp": 12 }],
        "messages": [],
        "scene": { "title": "Начало", "location": "", "turn": 0, "cells": floor_cells(9) }
    }))
    .expect("нормализация")
}

/// Кампания с двумя коммитами и снимком головы; состояние головы из кэша.
fn seeded(store: &EventStore) -> String {
    store.initialize_campaign(InitializeRequest::new(ID, campaign())).expect("кампания");
    for (index, value) in [17, 4].into_iter().enumerate() {
        store
            .commit(CommitRequest {
                campaign_id: ID.into(),
                expected_state_version: index as i64,
                idempotency_key: format!("roll-{index}"),
                command_id: Some(format!("roll-{index}")),
                events: vec![json!({ "event_type": "PublicDieRolled", "actor_id": "hero", "target_ids": [], "payload": { "roll": { "id": format!("roll-{index}"), "value": value } }, "source_rule_ids": [], "visibility": "public" })],
                ..CommitRequest::default()
            })
            .expect("коммит");
    }
    store.create_snapshot(ID).expect("снимок");
    js::stringify(&store.load(ID, &LoadOptions::default()).expect("голова").state)
}

fn snapshot_bodies(store: &EventStore) -> Vec<(i64, Value)> {
    store
        .with_connection_mut(|connection| -> StoreResult<Vec<(i64, Value)>> {
            let mut statement = connection.prepare("SELECT state_version, body FROM snapshots ORDER BY state_version")?;
            let rows = statement.query_map((), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
            let mut bodies = Vec::new();
            for row in rows {
                let (version, body) = row?;
                bodies.push((version, serde_json::from_str(&body)?));
            }
            Ok(bodies)
        })
        .expect("снимки")
}

fn rewrite_snapshot(store: &EventStore, version: i64, body: &Value) {
    let text = serde_json::to_string(body).expect("тело");
    store
        .with_connection_mut(|connection| -> StoreResult<()> {
            let mut statement = connection.prepare("UPDATE snapshots SET body = ?1 WHERE campaign_id = ?2 AND state_version = ?3")?;
            statement.execute((text.as_str(), ID, version))?;
            Ok(())
        })
        .expect("запись снимка");
}

fn checksum(state: &Value) -> String {
    sk_core::hash::sha256_hex(js::stringify(&sk_store::stable::sort_object(state)))
}

#[test]
fn snapshots_carry_the_state_schema_version() {
    let database = Database::new("version");
    let store = database.open();
    seeded(&store);
    let bodies = snapshot_bodies(&store);
    assert_eq!(bodies.iter().map(|(version, _)| *version).collect::<Vec<_>>(), vec![0, 2]);
    for (version, body) in &bodies {
        assert_eq!(body["state_schema_version"], json!(sk_rules::schema::STATE_SCHEMA_VERSION), "снимок {version}");
    }
}

#[test]
fn known_version_loads_without_normalization_into_the_head_state() {
    let database = Database::new("known");
    let head = seeded(&database.open());
    // Холодная загрузка: новый экземпляр хранилища, состояние — из снимка
    // версии 1 без нормализации (карта вернулась по хешу).
    let cold = database.open().load(ID, &LoadOptions::default()).expect("загрузка");
    assert_eq!(js::stringify(&cold.state), head, "состояние снимка = голова, с порядком ключей");
    // Переигрывание от исходного снимка — то же.
    let replayed = database.open().load(ID, &LoadOptions { use_snapshots: Some(false), ..LoadOptions::default() }).expect("переигрывание");
    assert_eq!(js::stringify(&replayed.state), head);
}

#[test]
fn snapshot_without_version_migrates_into_the_same_state() {
    let database = Database::new("legacy");
    let store = database.open();
    let head = seeded(&store);
    // База прежней сборки Rust: в снимках нет версии схемы.
    for (version, mut body) in snapshot_bodies(&store) {
        body.as_object_mut().expect("объект").shift_remove("state_schema_version");
        rewrite_snapshot(&store, version, &body);
    }
    drop(store);
    let reopened = database.open();
    let cold = reopened.load(ID, &LoadOptions::default()).expect("загрузка");
    assert_eq!(js::stringify(&cold.state), head, "миграция v0→v1 даёт то же состояние");
}

#[test]
fn broken_shape_is_refused_with_the_field_path() {
    let database = Database::new("broken");
    let store = database.open();
    seeded(&store);
    let (version, mut body) = snapshot_bodies(&store).pop().expect("снимок головы");
    body["state"]["players"] = json!({ "hero": {} });
    body["checksum"] = Value::String(checksum(&body["state"]));
    rewrite_snapshot(&store, version, &body);
    drop(store);
    let error = database.open().load(ID, &LoadOptions::default()).expect_err("сломанная форма");
    assert_eq!(error.code, "CORRUPT_EVENT_LOG");
    assert_eq!(error.campaign_id.as_deref(), Some(ID));
    assert!(error.message.contains("players"), "{}", error.message);
    assert_eq!(error.details["problem"].as_str().map(|problem| problem.starts_with("players:")), Some(true), "{}", error.details);
}

#[test]
fn newer_schema_version_is_refused() {
    let database = Database::new("newer");
    let store = database.open();
    seeded(&store);
    let (version, mut body) = snapshot_bodies(&store).pop().expect("снимок головы");
    body["state_schema_version"] = json!(sk_rules::schema::STATE_SCHEMA_VERSION + 1);
    rewrite_snapshot(&store, version, &body);
    drop(store);
    let error = database.open().load(ID, &LoadOptions::default()).expect_err("версия новее");
    assert_eq!(error.code, "CORRUPT_EVENT_LOG");
    assert!(error.message.contains("state schema version"), "{}", error.message);
}
