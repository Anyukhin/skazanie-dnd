//! Карты по хешу содержимого — перенос `server/map-store.mjs`.
//!
//! Снимок хранит ссылку `{ marker, hash, width, height }` вместо карты сцены,
//! карт и клеток запомненных локаций; сама карта лежит один раз в таблице
//! `map_blobs`. Хеш — SHA-256 от `JSON.stringify(map)` (порядок ключей как в
//! карте, без сортировки), поэтому файлы карт прежнего хранилища переносятся
//! без пересчёта адресов.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::StoreResult;

pub const MAP_REF_MARKER: &str = "skazanie:map-ref-v1";

/// Клетки сцены из карты (`legacyCellsFromTacticalMap(deserializeTacticalMap(map))`).
/// Внедряется, чтобы хранилище не зависело от тактической карты.
pub trait MapCells: Send + Sync {
    fn cells_from_map(&self, map: &Value) -> Option<Value>;
}

/// Без тактической карты: клетки сцены после восстановления пусты, как в JS
/// при ошибке разбора.
pub struct NoMapCells;

impl MapCells for NoMapCells {
    fn cells_from_map(&self, _map: &Value) -> Option<Value> {
        None
    }
}

/// `isMapRef(value)`.
pub fn is_map_ref(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(map)) if map.get("marker").and_then(Value::as_str) == Some(MAP_REF_MARKER) && map.get("hash").is_some_and(Value::is_string))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Положить карту и вернуть ссылку на неё (`MapStore.put`).
pub fn put(conn: &Connection, map: &Value) -> StoreResult<Value> {
    let text = serde_json::to_string(map)?;
    let hash = sk_core::hash::sha256_hex(&text);
    conn.execute("INSERT OR IGNORE INTO map_blobs (hash, body) VALUES (?1, ?2)", params![hash, text])?;
    // Испорченная запись под этим адресом переписывается верной: адрес задаёт
    // содержимое, и это восстановление карты, а не её правка.
    conn.execute("UPDATE map_blobs SET body = ?2 WHERE hash = ?1 AND body <> ?2", params![hash, text])?;
    let dimension = |key: &str| {
        let number = sk_core::js::number(map.get(key));
        if number.is_finite() && number != 0.0 { sk_core::js::num(number) } else { Value::from(0) }
    };
    Ok(json!({ "marker": MAP_REF_MARKER, "hash": hash, "width": dimension("width"), "height": dimension("height") }))
}

/// Исход чтения карты по адресу.
pub enum BlobRead {
    Found(Value),
    Missing,
    Corrupt,
}

/// Карта по адресу (`MapStore.get`): содержимое сверяется с адресом.
pub fn get(conn: &Connection, hash: &str) -> StoreResult<BlobRead> {
    if !valid_hash(hash) {
        return Ok(BlobRead::Corrupt);
    }
    let body: Option<String> = conn.query_row("SELECT body FROM map_blobs WHERE hash = ?1", params![hash], |row| row.get(0)).optional()?;
    let Some(body) = body else { return Ok(BlobRead::Missing) };
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else { return Ok(BlobRead::Missing) };
    let text = serde_json::to_string(&parsed)?;
    if sk_core::hash::sha256_hex(&text) != hash {
        return Ok(BlobRead::Corrupt);
    }
    Ok(BlobRead::Found(parsed))
}

fn put_cells(conn: &Connection, cells: &[Value]) -> StoreResult<Value> {
    let mut width = 0i64;
    let mut height = 0i64;
    for cell in cells {
        if sk_core::js::is_safe_integer_number(cell.get("x")) {
            width = width.max(sk_core::js::number(cell.get("x")) as i64 + 1);
        }
        if sk_core::js::is_safe_integer_number(cell.get("y")) {
            height = height.max(sk_core::js::number(cell.get("y")) as i64 + 1);
        }
    }
    put(conn, &json!({ "cells": cells, "width": width, "height": height }))
}

/// `externalizeMaps(state, store)`: карты — ссылками, производные клетки сцены
/// не хранятся.
pub fn externalize(conn: &Connection, state: &Value) -> StoreResult<Value> {
    let Value::Object(source) = state else { return Ok(state.clone()) };
    let mut next = source.clone();
    if let Some(Value::Object(scene)) = source.get("scene") {
        if sk_core::js::truthy(scene.get("map")) && !is_map_ref(scene.get("map")) {
            let mut scene = scene.clone();
            let reference = put(conn, &scene["map"])?;
            scene.insert("map".into(), reference);
            scene.shift_remove("cells");
            next.insert("scene".into(), Value::Object(scene));
        }
    }
    if let Some(Value::Object(location_maps)) = source.get("locationMaps") {
        let mut replaced = Map::new();
        for (id, record) in location_maps {
            let Value::Object(entry) = record else {
                replaced.insert(id.clone(), record.clone());
                continue;
            };
            let mut entry = entry.clone();
            if sk_core::js::truthy(entry.get("map")) && !is_map_ref(entry.get("map")) {
                let reference = put(conn, &entry["map"])?;
                entry.insert("map".into(), reference);
            }
            if let Some(Value::Array(cells)) = entry.get("cells") {
                let reference = put_cells(conn, cells)?;
                entry.insert("cells".into(), reference);
            }
            replaced.insert(id.clone(), Value::Object(entry));
        }
        next.insert("locationMaps".into(), Value::Object(replaced));
    }
    Ok(Value::Object(next))
}

/// Итог `internalizeMaps`: состояние и адреса, которые вернуть не удалось.
pub struct Internalized {
    pub state: Value,
    pub missing: Vec<String>,
    pub corrupt: Vec<String>,
}

/// `internalizeMaps(state, store)`: ссылки — обратно картами.
pub fn internalize(conn: &Connection, state: &Value, cells: &dyn MapCells) -> StoreResult<Internalized> {
    let mut missing = Vec::new();
    let mut corrupt = Vec::new();
    let Value::Object(source) = state else {
        return Ok(Internalized { state: state.clone(), missing, corrupt });
    };
    let mut next = source.clone();
    let restore = |hash: &str, missing: &mut Vec<String>, corrupt: &mut Vec<String>| -> StoreResult<Option<Value>> {
        Ok(match get(conn, hash)? {
            BlobRead::Found(value) => Some(value),
            BlobRead::Missing => {
                missing.push(hash.to_string());
                None
            }
            BlobRead::Corrupt => {
                corrupt.push(hash.to_string());
                missing.push(hash.to_string());
                None
            }
        })
    };
    if let Some(Value::Object(scene)) = source.get("scene") {
        if is_map_ref(scene.get("map")) {
            let hash = scene["map"]["hash"].as_str().unwrap_or_default().to_string();
            if let Some(map) = restore(&hash, &mut missing, &mut corrupt)? {
                let mut scene = scene.clone();
                if !scene.get("cells").is_some_and(Value::is_array) {
                    let derived = cells.cells_from_map(&map).unwrap_or_else(|| Value::Array(Vec::new()));
                    scene.insert("cells".into(), derived);
                }
                scene.insert("map".into(), map);
                next.insert("scene".into(), Value::Object(scene));
            }
        }
    }
    if let Some(Value::Object(location_maps)) = source.get("locationMaps") {
        let mut replaced = Map::new();
        for (id, record) in location_maps {
            let Value::Object(entry) = record else {
                replaced.insert(id.clone(), record.clone());
                continue;
            };
            let mut entry = entry.clone();
            if is_map_ref(entry.get("map")) {
                let hash = entry["map"]["hash"].as_str().unwrap_or_default().to_string();
                if let Some(map) = restore(&hash, &mut missing, &mut corrupt)? {
                    entry.insert("map".into(), map);
                }
            }
            if is_map_ref(entry.get("cells")) {
                let hash = entry["cells"]["hash"].as_str().unwrap_or_default().to_string();
                if let Some(body) = restore(&hash, &mut missing, &mut corrupt)? {
                    match body.get("cells") {
                        Some(Value::Array(list)) => {
                            entry.insert("cells".into(), Value::Array(list.clone()));
                        }
                        _ => missing.push(hash),
                    }
                }
            }
            replaced.insert(id.clone(), Value::Object(entry));
        }
        next.insert("locationMaps".into(), Value::Object(replaced));
    }
    Ok(Internalized { state: Value::Object(next), missing, corrupt })
}
