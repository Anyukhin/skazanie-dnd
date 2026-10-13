//! Перенос `server/projection-integrity.mjs`: каноническая проекция комнаты и
//! её хеш для сверки «комната против авторитетного состояния».
//!
//! Хеш — SHA-256 от `JSON.stringify` канонической проекции, поэтому строка
//! собирается точно как в V8 ([`crate::jsx::stringify`]): ключи отсортированы
//! по единицам UTF-16, целочисленные ключи всё равно идут первыми (так JS
//! хранит ключи объекта), числа печатаются как в JS.

use serde::Serialize;
use serde_json::{Map, Value};

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
pub fn projection_hash(state: &Value) -> String {
    sk_core::hash::sha256_hex(jsx::stringify(&canonical_projection(state)))
}

/// Итог `compareProjection`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectionComparison {
    pub matched: bool,
    pub authoritative_hash: String,
    pub projected_hash: String,
}

/// `compareProjection(authoritativeState, projectedState)`.
pub fn compare_projection(authoritative_state: &Value, projected_state: &Value) -> ProjectionComparison {
    let authoritative_hash = projection_hash(authoritative_state);
    let projected_hash = projection_hash(projected_state);
    ProjectionComparison { matched: authoritative_hash == projected_hash, authoritative_hash, projected_hash }
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
