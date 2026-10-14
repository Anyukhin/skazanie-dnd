//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Значения сравниваются строкой `JSON.stringify`, то есть вместе с порядком
//! ключей и записью чисел; крупный выход — коротким хешем той же строки
//! (`fixtures/common.mjs`). Дополнительно проверяется, что объект Rust уже
//! хранит ключи в порядке JS (индексы — первыми): потребители сериализуют
//! его сами.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::Value;

/// Аргумент `undefined` в эталоне.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Разобрать эталон.
pub fn parse(source: &str) -> Value {
    serde_json::from_str(source).expect("эталон JSON")
}

/// Аргумент случая: `None` — `undefined`.
pub fn arg(value: &Value) -> Option<&Value> {
    (value.as_str() != Some(UNDEFINED)).then_some(value)
}

/// Значение результата: `undefined` — `None`.
pub fn result(value: &Value) -> Option<Value> {
    arg(value).cloned()
}

/// `JSON.stringify(value)` байт в байт.
pub fn stringify(value: &Value) -> String {
    sk_narration_base::jsx::stringify(value)
}

/// Короткий хеш `JSON.stringify(value)`; `None` — UNDEFINED.
pub fn hash(value: Option<&Value>) -> String {
    match value {
        None => UNDEFINED.into(),
        Some(value) => sk_core::hash::sha256_hex(stringify(value))[..16].to_string(),
    }
}

/// Хеши карточек `[id, хеш]`.
pub fn card_hashes(cards: &[Value]) -> Value {
    Value::Array(cards.iter().map(|card| serde_json::json!([card.get("id"), hash(Some(card))])).collect())
}

/// Ключи всех объектов — в порядке объекта JS.
pub fn assert_js_order(value: &Value, context: &str) {
    match value {
        Value::Object(map) => {
            let keys: Vec<&String> = map.keys().collect();
            let expected = sk_core::js::keys(map);
            assert_eq!(keys, expected, "порядок ключей не как в JS: {context}");
            for item in map.values() {
                assert_js_order(item, context);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_js_order(item, context);
            }
        }
        _ => {}
    }
}

/// Совпадение строкой JSON и порядок ключей.
#[track_caller]
pub fn assert_same(actual: &Value, expected: &Value, context: &str) {
    assert_js_order(actual, context);
    let (actual, expected) = (stringify(actual), stringify(expected));
    if actual != expected {
        panic!("расхождение с JS: {context}\n  Rust: {}\n  JS:   {}", head(&actual), head(&expected));
    }
}

fn head(text: &str) -> String {
    text.chars().take(4_000).collect()
}

/// Массив эталона.
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Значение или `null`.
pub fn or_null(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}
