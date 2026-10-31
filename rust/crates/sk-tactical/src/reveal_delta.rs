//! Перенос `server/reveal-delta.mjs`: дельты раскрытия вместо полной сетки
//! (`docs/tactical-map-plan.md`, 11.2). Дельта хранит интервалы индексов
//! `[начало, длина]` — раскрытые и снова скрытые клетки — и (формат v2)
//! значения слоёв `material`, `variant`, `surface` каждой затронутой клетки:
//! проекция обезличивает нераскрытую клетку, и без этих значений собранная
//! карта расходилась бы с проекцией.
//!
//! Дельта — JSON той же формы, что у JS; отказы — текстом сообщения JS
//! (`Error` без кода; отказ разбора карты — сообщение `TacticalMapError`).

use serde_json::{Map, Value};
use sk_core::js;

use crate::tactical_map::{cell_at, deserialize_tactical_map, set_cell, CellPatch, TacticalMap, MATERIALS, SURFACES};

pub const REVEAL_DELTA_VERSION: &str = "skazanie:reveal-delta-v2";

/// `toRuns(indexes)`: отсортированные индексы — интервалами `[начало, длина]`.
fn to_runs(indexes: &[usize]) -> Value {
    let mut runs = Vec::new();
    let mut start: Option<usize> = None;
    let mut length = 0;
    for index in indexes {
        if let Some(begin) = start {
            if *index == begin + length {
                length += 1;
                continue;
            }
            runs.push(Value::Array(vec![Value::from(begin), Value::from(length)]));
        }
        start = Some(*index);
        length = 1;
    }
    if let Some(begin) = start {
        runs.push(Value::Array(vec![Value::from(begin), Value::from(length)]));
    }
    Value::Array(runs)
}

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { BASE64_ALPHABET[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_ALPHABET[triple as usize & 63] as char } else { '=' });
    }
    out
}

/// `Buffer.from(text, 'base64')` как у Node: младший байт каждой единицы
/// UTF-16, посторонние символы пропускаются, `=` заканчивает данные.
fn base64_decode(text: &str) -> Vec<u8> {
    js::buffer_from_base64(text)
}

/// `encodeValues(values)`: однородный слой — одно число, иначе base64.
fn encode_values(values: &[u8]) -> Value {
    match values.first() {
        None => Value::from(0),
        Some(first) if values.iter().all(|value| value == first) => Value::from(*first),
        Some(_) => Value::String(base64_encode(values)),
    }
}

/// `decodeValues(value, expected, label)`: длина обязана совпасть с числом
/// затронутых клеток.
fn decode_values(value: Option<&Value>, expected: usize, label: &str) -> Result<Vec<u8>, String> {
    if let Some(Value::Number(number)) = value {
        if let Some(number) = number.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0) {
            return Ok(vec![(js::to_int32(number) & 0xff) as u8; expected]);
        }
    }
    let Some(Value::String(text)) = value else {
        return Err(format!("Слой {label} дельты раскрытия должен быть строкой base64 или числом"));
    };
    let bytes = base64_decode(text);
    if bytes.len() != expected {
        return Err(format!("Слой {label} дельты раскрытия покрывает {} клеток из {expected}", bytes.len()));
    }
    Ok(bytes)
}

/// `value?.[index]` для рыхлого интервала: массив, строка или объект.
fn loose_index(value: &Value, index: usize) -> Option<Value> {
    match value {
        Value::Array(items) => items.get(index).cloned(),
        Value::String(text) => text.chars().nth(index).map(|ch| Value::String(ch.to_string())),
        Value::Object(object) => object.get(&index.to_string()).cloned(),
        _ => None,
    }
}

/// `runIndexes(runs, limit)`: индексы интервалов подряд.
fn run_indexes(runs: Option<&Value>, limit: usize) -> Result<Vec<usize>, String> {
    let mut indexes = Vec::new();
    let Some(Value::Array(runs)) = runs else { return Ok(indexes) };
    for run in runs {
        let start = js::number(loose_index(run, 0).as_ref());
        let length = js::number(loose_index(run, 1).as_ref());
        let safe = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
        if !safe(start) || !safe(length) || start < 0.0 || length < 0.0 || start + length > limit as f64 {
            return Err("Интервал дельты раскрытия выходит за пределы карты".into());
        }
        indexes.extend(start as usize..(start + length) as usize);
    }
    Ok(indexes)
}

/// `revealDelta(before, after, baseHash)`: что изменилось в раскрытии между
/// двумя состояниями одной карты.
pub fn reveal_delta(before: &TacticalMap, after: &TacticalMap, base_hash: &str) -> Result<Value, String> {
    if before.width != after.width || before.height != after.height {
        return Err("Дельта раскрытия строится только между состояниями одной карты".into());
    }
    let mut revealed = Vec::new();
    let mut hidden = Vec::new();
    let length = (after.width * after.height).max(0) as usize;
    for index in 0..length {
        let x = index as i64 % after.width;
        let y = index as i64 / after.width;
        let Some(now) = cell_at(after, x, y) else { continue };
        let was = cell_at(before, x, y).is_some_and(|cell| cell.revealed);
        if was == now.revealed {
            continue;
        }
        if now.revealed {
            revealed.push(index);
        } else {
            hidden.push(index);
        }
    }
    let layer = |values: &Vec<u8>, index: usize| values.get(index).copied().unwrap_or(0);
    let touched: Vec<usize> = revealed.iter().chain(hidden.iter()).copied().collect();
    let material: Vec<u8> = touched.iter().map(|index| layer(&after.layers.material, *index)).collect();
    let variant: Vec<u8> = touched.iter().map(|index| layer(&after.layers.variant, *index)).collect();
    let surface: Vec<u8> = touched.iter().map(|index| layer(&after.layers.surface, *index)).collect();
    let mut values = Map::new();
    values.insert("material".into(), encode_values(&material));
    values.insert("variant".into(), encode_values(&variant));
    values.insert("surface".into(), encode_values(&surface));
    let mut delta = Map::new();
    delta.insert("version".into(), Value::String(REVEAL_DELTA_VERSION.into()));
    delta.insert("baseHash".into(), Value::String(base_hash.into()));
    delta.insert("width".into(), Value::from(after.width));
    delta.insert("revealed".into(), to_runs(&revealed));
    delta.insert("hidden".into(), to_runs(&hidden));
    delta.insert("values".into(), Value::Object(values));
    Ok(Value::Object(delta))
}

/// `applyRevealDelta(map, delta)`: накладывает дельту на карту (карта
/// меняется). Дельта чужой версии не трогает карту.
pub fn apply_reveal_delta(map: &mut TacticalMap, delta: &Value) -> Result<(), String> {
    let Value::Object(delta) = delta else { return Ok(()) };
    if delta.get("version").and_then(Value::as_str) != Some(REVEAL_DELTA_VERSION) {
        return Ok(());
    }
    let same_width = matches!(delta.get("width"), Some(Value::Number(width)) if width.as_f64() == Some(map.width as f64));
    if !same_width {
        return Err("Дельта раскрытия не подходит к этой карте: другая ширина".into());
    }
    let limit = (map.width * map.height).max(0) as usize;
    let revealed = run_indexes(delta.get("revealed"), limit)?;
    let hidden = run_indexes(delta.get("hidden"), limit)?;
    let touched = revealed.len() + hidden.len();
    let values = delta.get("values").filter(|values| !values.is_null());
    let field = |key: &str| values.and_then(Value::as_object).and_then(|values| values.get(key));
    let material = decode_values(field("material"), touched, "material")?;
    let variant = decode_values(field("variant"), touched, "variant")?;
    let surface = decode_values(field("surface"), touched, "surface")?;
    let mut position = 0;
    for (indexes, value) in [(&revealed, true), (&hidden, false)] {
        for index in indexes {
            let at = position;
            position += 1;
            let x = *index as i64 % map.width;
            let y = *index as i64 / map.width;
            if cell_at(map, x, y).is_none() {
                continue;
            }
            let (Some(material_name), Some(surface_name)) = (MATERIALS.get(material[at] as usize), SURFACES.get(surface[at] as usize)) else {
                return Err("Дельта раскрытия называет слой, которого нет в перечислении".into());
            };
            let patch = CellPatch {
                revealed: Some(value),
                material: Some(material_name),
                variant: Some(i64::from(variant[at])),
                surface: Some(surface_name),
                ..CellPatch::default()
            };
            set_cell(map, x, y, &patch).map_err(|error| error.message)?;
        }
    }
    Ok(())
}

/// `.length ?? 0` рыхлого значения: массив или строка.
fn loose_length(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(text)) => text.encode_utf16().count(),
        _ => 0,
    }
}

/// `revealDeltaEmpty(delta)`: пустую дельту незачем отправлять.
pub fn reveal_delta_empty(delta: Option<&Value>) -> bool {
    if !js::truthy(delta) {
        return true;
    }
    let get = |key: &str| delta.and_then(Value::as_object).and_then(|delta| delta.get(key));
    loose_length(get("revealed")) == 0 && loose_length(get("hidden")) == 0
}

/// `revealDeltaSize(delta)`: сколько клеток затрагивает дельта (для
/// правильной дельты — сумма длин интервалов).
pub fn reveal_delta_size(delta: Option<&Value>) -> f64 {
    if !js::truthy(delta) {
        return 0.0;
    }
    let mut total = 0.0;
    for key in ["revealed", "hidden"] {
        if let Some(Value::Array(runs)) = delta.and_then(Value::as_object).and_then(|delta| delta.get(key)) {
            for run in runs {
                // `total += length`: отсутствующая длина — NaN.
                total += js::number(loose_index(run, 1).as_ref());
            }
        }
    }
    total
}

/// Ответ `revealUpdateFor`.
#[derive(Clone, Debug, PartialEq)]
pub enum RevealUpdate {
    /// `{ kind: 'full', map: serializedMap, hash: currentHash }` — карта целиком.
    Full,
    /// `{ kind: 'delta', delta }`.
    Delta(Value),
}

impl RevealUpdate {
    /// Форма JS; для `full` — переданная карта и хеш.
    pub fn to_json(&self, serialized_map: &Value, current_hash: &str) -> Value {
        let mut object = Map::new();
        match self {
            RevealUpdate::Full => {
                object.insert("kind".into(), Value::String("full".into()));
                object.insert("map".into(), serialized_map.clone());
                object.insert("hash".into(), Value::String(current_hash.into()));
            }
            RevealUpdate::Delta(delta) => {
                object.insert("kind".into(), Value::String("delta".into()));
                object.insert("delta".into(), delta.clone());
            }
        }
        Value::Object(object)
    }
}

/// `revealUpdateFor({ serializedMap, currentHash, clientHash, clientMap })`:
/// карта у клиента та же — дельта; другая или её нет — карта целиком.
pub fn reveal_update_for(serialized_map: &Value, current_hash: &str, client_hash: Option<&str>, client_map: Option<&Value>) -> Result<RevealUpdate, String> {
    let client_hash = client_hash.unwrap_or("");
    let Some(client_map) = client_map.filter(|map| js::truthy(Some(map))) else { return Ok(RevealUpdate::Full) };
    if client_hash.is_empty() || client_hash != current_hash {
        return Ok(RevealUpdate::Full);
    }
    let before = deserialize_tactical_map(client_map).map_err(|error| error.message)?;
    let after = deserialize_tactical_map(serialized_map).map_err(|error| error.message)?;
    Ok(RevealUpdate::Delta(reveal_delta(&before, &after, current_hash)?))
}
