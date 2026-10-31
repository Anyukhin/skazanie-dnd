//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Значения сравниваются строкой `JSON.stringify`, то есть вместе с порядком
//! ключей и записью чисел; крупный выход — SHA-256 той же строки
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

/// Массив эталона.
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).expect("массив в эталоне")
}

/// `JSON.stringify(value)` байт в байт.
pub fn stringify(value: &Value) -> String {
    sk_core::js::stringify(value)
}

/// SHA-256 `JSON.stringify(value)`.
pub fn hash(value: &Value) -> String {
    sk_core::hash::sha256_hex(stringify(value))
}

/// Значение или UNDEFINED.
pub fn encode(value: Option<Value>) -> Value {
    value.unwrap_or_else(|| Value::String(UNDEFINED.into()))
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
