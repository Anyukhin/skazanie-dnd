//! Общая часть сверки с эталонами JS (`fixtures/*.json.gz`, генераторы
//! `fixtures/gen-*.mjs`): разбор эталона, подстановка состояний, отчёт о
//! расхождениях.

#![allow(dead_code)] // каждый файл тестов берёт свою часть помощников

use std::io::Read;

use serde_json::{json, Value};

/// Метка `undefined` в эталоне.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Разобрать сжатый эталон.
pub fn load(bytes: &[u8]) -> Value {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон читается");
    serde_json::from_str(&text).expect("эталон — JSON")
}

/// Эталон модуля: состояния и случаи.
pub struct Fixture {
    pub states: Vec<Value>,
    pub cases: Vec<Value>,
}

impl Fixture {
    pub fn new(bytes: &[u8]) -> Self {
        let mut root = load(bytes);
        let take = |root: &mut Value, key: &str| match root.get_mut(key).map(Value::take) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        Self { states: take(&mut root, "states"), cases: take(&mut root, "cases") }
    }

    /// Аргумент случая: `{ "$state": i }` — состояние из таблицы, метка
    /// `undefined` и отсутствующий аргумент — `None`.
    pub fn arg(&self, case: &Value, index: usize) -> Option<Value> {
        let value = case["args"].get(index)?;
        if value.as_str() == Some(UNDEFINED) {
            return None;
        }
        if let Some(reference) = value.as_object().filter(|object| object.len() == 1).and_then(|object| object.get("$state")).and_then(Value::as_u64) {
            return self.states.get(reference as usize).cloned();
        }
        Some(value.clone())
    }

    /// Ожидаемый исход: `{ "result": … }` или `{ "error": true }`.
    pub fn expected(case: &Value) -> Value {
        if case.get("error").is_some() {
            json!({ "error": true })
        } else {
            json!({ "result": case.get("result").cloned().unwrap_or(Value::Null) })
        }
    }
}

/// Исход Rust в форме эталона.
pub fn outcome<T, E>(result: Result<T, E>, encode: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "result": encode(value) }),
        Err(_) => json!({ "error": true }),
    }
}

/// `Array.isArray(events) ? events : []`.
pub fn events_of(value: &Option<Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// Сверить все случаи; при расхождениях — первые из них с входом и паника.
pub fn verify(fixture: &Fixture, mut run: impl FnMut(&str, &Value) -> Option<Value>) -> usize {
    let mut checked = 0;
    let mut failures = Vec::new();
    for (index, case) in fixture.cases.iter().enumerate() {
        let name = case["fn"].as_str().unwrap_or("");
        let Some(actual) = run(name, case) else { continue };
        checked += 1;
        let expected = Fixture::expected(case);
        if actual != expected {
            failures.push(format!(
                "#{index} {name} ({}):\n  ожидалось {}\n  получено  {}\n  args {}",
                case["source"].as_str().unwrap_or("?"),
                expected,
                actual,
                sk_core::text::head(&case["args"].to_string(), 1_500)
            ));
        }
    }
    if !failures.is_empty() {
        let shown: Vec<&String> = failures.iter().take(12).collect();
        panic!("расхождений с JS: {} из {checked}\n{}", failures.len(), shown.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n"));
    }
    checked
}
