//! Канонический JSON и хеши — как `stableJson` и `sha256` в
//! `server/event-store.mjs`: ключи объектов по возрастанию на всех уровнях,
//! без пробелов. По этим хешам сверяются снимки, идемпотентность и импорт.

use serde_json::{Map, Value};

/// `sortObject(value)`: тот же JSON с ключами по возрастанию на всех уровнях.
pub fn sort_object(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_object).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            // `Object.keys(value).sort()` сравнивает единицы UTF-16; для ключей
            // состояния (латиница, цифры, кириллица) это порядок кодовых точек.
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), sort_object(&map[key]));
            }
            Value::Object(sorted)
        }
        other => other.clone(),
    }
}

/// `stableJson(value)`.
pub fn stable_json(value: &Value) -> String {
    sk_core::js::stringify(&sort_object(value))
}

/// `sha256(value)` хранилища: строка хешируется как есть, остальное — по
/// каноническому JSON.
pub fn stable_hash(value: &Value) -> String {
    match value {
        Value::String(text) => sk_core::hash::sha256_hex(text),
        other => sk_core::hash::sha256_hex(stable_json(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stable_json_sorts_keys_recursively() {
        let value = json!({ "b": 1, "a": { "d": [ { "z": 1, "y": 2 } ], "c": null } });
        assert_eq!(stable_json(&value), r#"{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}"#);
    }

    #[test]
    fn hash_matches_node_for_known_value() {
        // node -e "…createHash('sha256').update(JSON.stringify({a:1,b:[2]})).digest('hex')"
        assert_eq!(stable_hash(&json!({ "b": [2], "a": 1 })), sk_core::hash::sha256_hex(r#"{"a":1,"b":[2]}"#));
    }
}
