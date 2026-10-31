//! Перенос `server/projection-integrity.mjs`: каноническая проекция комнаты и
//! её хеш для сверки «комната против авторитетного состояния».
//!
//! Хеш — SHA-256 от `JSON.stringify` канонической проекции, поэтому строка
//! собирается точно как в V8 ([`crate::jsx::stringify`]): ключи отсортированы
//! по единицам UTF-16, целочисленные ключи всё равно идут первыми (так JS
//! хранит ключи объекта), числа печатаются как в JS.

use serde::Serialize;
use serde_json::{Map, Value};

use sk_core::js;

use crate::jsx;

/// `CANONICAL_PROJECTION_FIELDS`: поля комнаты, которые целиком принадлежат
/// движку. Проекция обязана снимать из комнаты поле, которого в авторитетном
/// состоянии больше нет (аудит PR #131, SEC-02).
pub const CANONICAL_PROJECTION_FIELDS: &[&str] = &[
    "sessionCode",
    "campaign",
    "partyName",
    "partyMemberIds",
    "partyDecisionPolicy",
    "players",
    "enemies",
    "actors",
    "merchants",
    "worldMemory",
    "worldMap",
    "social",
    "npc_world",
    "mechanics",
    "rulings",
    "entities",
    "scene",
    "adventure",
    "agentInteraction",
    "activePlayerId",
    "tacticalTurn",
    "battleLog",
    "economyLog",
    "mapFeedback",
    "lastDiceRoll",
    "state_version",
    "ruleset_id",
    "ruleset_version",
    "enabled_rule_packs",
    "enabled_house_rules",
    "ruleset_locked_at",
    "engine_mode",
];

/// `stableValue`: ключи объектов по возрастанию (`Object.keys(value).sort()`).
fn stable_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(stable_value).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| jsx::utf16_cmp(left, right));
            Value::Object(keys.into_iter().map(|key| (key.clone(), stable_value(&map[key.as_str()]))).collect())
        }
        other => other.clone(),
    }
}

/// `canonicalPlayer`: игрок без `online`. Массив, как `{ ...array }` в JS,
/// становится объектом с ключами-индексами.
fn canonical_player(player: &Value) -> Value {
    match player {
        Value::Object(map) => {
            let mut canonical = map.clone();
            canonical.shift_remove("online");
            Value::Object(canonical)
        }
        Value::Array(items) => Value::Object(items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect()),
        other => other.clone(),
    }
}

/// `canonicalProjection(state)`. Не объект считается пустым состоянием
/// (в JS `null` бросил бы `TypeError` на `Object.hasOwn`).
pub fn canonical_projection(state: &Value) -> Value {
    let empty = Map::new();
    let source = state.as_object().unwrap_or(&empty);
    let mut projected = Map::new();
    for field in CANONICAL_PROJECTION_FIELDS {
        let Some(value) = source.get(*field) else {
            if *field == "agentInteraction" {
                projected.insert((*field).to_string(), Value::Null);
            }
            continue;
        };
        let value = if *field == "players" {
            match value {
                Value::Array(players) => Value::Array(players.iter().map(canonical_player).collect()),
                _ => Value::Array(Vec::new()),
            }
        } else {
            value.clone()
        };
        projected.insert((*field).to_string(), value);
    }
    stable_value(&Value::Object(projected))
}

/// `projectionHash(state)`: SHA-256 (hex) от `JSON.stringify(canonicalProjection(state))`.
///
/// Строка проекции пишется прямо из состояния (Ск4), без копии
/// [`canonical_projection`] и её сортированной копии: те же поля, те же ключи
/// в том же порядке, те же числа и экранирование — байт в байт
/// `jsx::stringify(&canonical_projection(state))` (сторож —
/// `tests/projection_integrity.rs`).
pub fn projection_hash(state: &Value) -> String {
    sk_core::hash::sha256_hex(canonical_projection_json(state))
}

/// [`projection_hash`] с героями `players` вместо `state.players` (если поле
/// `players` в состоянии есть): так хеш считается по героям в форме JS, когда
/// в состоянии на месте производных полей — пустые слоты (урок 2).
pub fn projection_hash_with_players(state: &Value, players: Option<&[Value]>) -> String {
    sk_core::hash::sha256_hex(canonical_projection_json_with(state, players))
}

/// `JSON.stringify(canonicalProjection(state))` без промежуточных значений.
pub fn canonical_projection_json(state: &Value) -> String {
    canonical_projection_json_with(state, None)
}

/// [`canonical_projection_json`] с подменой героев (см. [`projection_hash_with_players`]).
fn canonical_projection_json_with<'a>(state: &'a Value, override_players: Option<&'a [Value]>) -> String {
    enum Field<'a> {
        Plain(&'a Value),
        Players(&'a [Value]),
    }
    const NULL: Value = Value::Null;
    let mut fields: Vec<(&str, Field<'_>)> = Vec::with_capacity(CANONICAL_PROJECTION_FIELDS.len());
    let source = state.as_object();
    for field in CANONICAL_PROJECTION_FIELDS {
        let Some(value) = source.and_then(|map| map.get(*field)) else {
            if *field == "agentInteraction" {
                fields.push((field, Field::Plain(&NULL)));
            }
            continue;
        };
        if *field == "players" {
            fields.push((field, Field::Players(override_players.unwrap_or_else(|| value.as_array().map(Vec::as_slice).unwrap_or(&[])))));
        } else {
            fields.push((field, Field::Plain(value)));
        }
    }
    fields.sort_by(|(left, _), (right, _)| stable_key_order(left, right));
    let mut out = String::with_capacity(1 << 16);
    out.push('{');
    for (index, (key, field)) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        js::push_json_str(key, &mut out);
        out.push(':');
        match field {
            Field::Plain(value) => write_stable(value, &mut out),
            Field::Players(players) => {
                out.push('[');
                for (index, player) in players.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    match player {
                        // `canonicalPlayer`: игрок без `online`.
                        Value::Object(map) => write_stable_object(map.iter().filter(|(key, _)| key.as_str() != "online"), &mut out),
                        // `{ ...array }`: ключи-индексы, порядок по возрастанию.
                        Value::Array(items) => {
                            out.push('{');
                            for (index, item) in items.iter().enumerate() {
                                if index > 0 {
                                    out.push(',');
                                }
                                js::push_json_str(&index.to_string(), &mut out);
                                out.push(':');
                                write_stable(item, &mut out);
                            }
                            out.push('}');
                        }
                        other => write_stable(other, &mut out),
                    }
                }
                out.push(']');
            }
        }
    }
    out.push('}');
    out
}

/// Порядок ключей `JSON.stringify(stableValue(x))`: `stableValue` сортирует
/// ключи по единицам UTF-16, а объект JS всё равно ставит ключи-индексы
/// первыми, по возрастанию числа.
fn stable_key_order(left: &str, right: &str) -> std::cmp::Ordering {
    let index = |key: &str| if js::is_array_index_key(key) { key.parse::<u64>().ok() } else { None };
    match (index(left), index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        // Для ASCII порядок байтов и единиц UTF-16 один.
        (None, None) if left.is_ascii() && right.is_ascii() => left.cmp(right),
        (None, None) => jsx::utf16_cmp(left, right),
    }
}

fn write_stable_object<'a>(entries: impl Iterator<Item = (&'a String, &'a Value)>, out: &mut String) {
    let mut entries: Vec<(&String, &Value)> = entries.collect();
    if entries.len() > 1 {
        entries.sort_by(|(left, _), (right, _)| stable_key_order(left, right));
    }
    out.push('{');
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        js::push_json_str(key, out);
        out.push(':');
        write_stable(value, out);
    }
    out.push('}');
}

/// `JSON.stringify(stableValue(value))`, как [`jsx::stringify`] над [`stable_value`].
fn write_stable(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => js::push_json_number(number, out),
        Value::String(text) => js::push_json_str(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_stable(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => write_stable_object(map.iter(), out),
    }
}

/// Итог `compareProjection`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectionComparison {
    pub matched: bool,
    pub authoritative_hash: String,
    pub projected_hash: String,
}

/// `compareProjection(authoritativeState, projectedState)`.
///
/// Почти всегда комната совпадает с журналом: тогда канонические поля равны
/// значение в значение, их проекции — одна строка, и второй хеш не
/// считается (Ск4). Равенство строже канонического (`1` и `1.0`, порядок
/// ключей не важен, как и в проекции): несовпадение — просто второй хеш.
pub fn compare_projection(authoritative_state: &Value, projected_state: &Value) -> ProjectionComparison {
    let authoritative_hash = projection_hash(authoritative_state);
    let projected_hash = if canonically_equal(authoritative_state, projected_state) { authoritative_hash.clone() } else { projection_hash(projected_state) };
    ProjectionComparison { matched: authoritative_hash == projected_hash, authoritative_hash, projected_hash }
}

/// [`compare_projection`], где хеши считаются по героям `players_of(state)`
/// (герои в форме JS, урок 2); совпадение решает то же сравнение состояний.
pub fn compare_projection_with(authoritative_state: &Value, projected_state: &Value, players_of: &dyn Fn(&Value) -> Option<Vec<Value>>) -> ProjectionComparison {
    let hash = |state: &Value| {
        let players = players_of(state);
        projection_hash_with_players(state, players.as_deref())
    };
    let authoritative_hash = hash(authoritative_state);
    let projected_hash = if canonically_equal(authoritative_state, projected_state) { authoritative_hash.clone() } else { hash(projected_state) };
    ProjectionComparison { matched: authoritative_hash == projected_hash, authoritative_hash, projected_hash }
}

/// Равны ли канонические поля двух состояний значение в значение (игроки —
/// без `online`). `true` гарантирует одну и ту же строку проекции.
fn canonically_equal(left: &Value, right: &Value) -> bool {
    let (Some(left), Some(right)) = (left.as_object(), right.as_object()) else { return false };
    CANONICAL_PROJECTION_FIELDS.iter().all(|field| match (left.get(*field), right.get(*field)) {
        (None, None) => true,
        (Some(Value::Array(left)), Some(Value::Array(right))) if *field == "players" => {
            left.len() == right.len() && left.iter().zip(right).all(|(left, right)| player_equal(left, right))
        }
        (Some(left), Some(right)) => left == right,
        _ => false,
    })
}

fn player_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            let counted = |map: &Map<String, Value>| map.len() - usize::from(map.contains_key("online"));
            counted(left) == counted(right) && left.iter().filter(|(key, _)| key.as_str() != "online").all(|(key, value)| right.get(key) == Some(value))
        }
        _ => left == right,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projection_drops_online_and_foreign_fields() {
        let state = json!({ "players": [{ "id": "a", "online": true, "b": 1 }], "chat": [1], "scene": { "z": 1, "a": 2 } });
        let projected = canonical_projection(&state);
        assert_eq!(jsx::stringify(&projected), r#"{"agentInteraction":null,"players":[{"b":1,"id":"a"}],"scene":{"a":2,"z":1}}"#);
        let online = json!({ "players": [{ "id": "a", "online": false, "b": 1 }], "scene": { "a": 2, "z": 1 } });
        let comparison = compare_projection(&state, &online);
        assert!(comparison.matched, "online и порядок ключей не влияют на хеш");
        assert_eq!(comparison.authoritative_hash.len(), 64);
        assert!(!compare_projection(&state, &json!({})).matched);
        assert_eq!(canonical_projection(&Value::Null), json!({ "agentInteraction": null }));
    }
}
