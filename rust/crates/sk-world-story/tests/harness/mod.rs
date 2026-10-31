//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Эталон — таблицы `values` и `states` и случаи `{ fn, args, result | sha256 |
//! error }`. Ссылки `{ "$state": i }` и `{ "$value": j }` подставляются
//! обратно. Результат сравнивается строкой `JSON.stringify`
//! (`sk_core::js::stringify`), крупный — её SHA-256.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::{Map, Value};
use sk_core::{hash, js};

pub const UNDEFINED: &str = "\u{0}undefined";

/// Аргументы случая: `None` — `undefined`.
pub struct Args(pub Vec<Option<Value>>);

impl Args {
    pub fn get(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }

    /// Аргумент-объект с параметром по умолчанию `= {}`.
    pub fn or_empty(&self, index: usize) -> Value {
        self.get(index).cloned().unwrap_or_else(|| Value::Object(Map::new()))
    }

    /// Аргумент-число (`null`/нечисло — `None`).
    pub fn number(&self, index: usize) -> Option<f64> {
        self.get(index).and_then(Value::as_f64)
    }
}

/// Итог Rust: значение (`None` — `undefined`) или исключение.
pub type Outcome = Result<Option<Value>, String>;

pub struct Fixture {
    pub data: Value,
}

impl Fixture {
    pub fn load(text: &str) -> Self {
        Self { data: serde_json::from_str(text).expect("эталон — JSON") }
    }

    /// Эталон в gzip (`fixtures/*.json.gz`).
    pub fn load_gz(bytes: &[u8]) -> Self {
        use std::io::Read;
        let mut text = String::new();
        flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон — gzip");
        Self::load(&text)
    }

    fn expand(&self, value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                if map.len() == 1 {
                    if let Some(index) = map.get("$state").and_then(Value::as_u64) {
                        return self.expand(&self.data["states"][index as usize]);
                    }
                    if let Some(index) = map.get("$value").and_then(Value::as_u64) {
                        return self.data["values"][index as usize].clone();
                    }
                }
                Value::Object(map.iter().map(|(key, child)| (key.clone(), self.expand(child))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(|item| self.expand(item)).collect()),
            other => other.clone(),
        }
    }

    pub fn args(&self, case: &Value) -> Args {
        Args(
            case["args"]
                .as_array()
                .map(|items| items.iter().map(|item| if item.as_str() == Some(UNDEFINED) { None } else { Some(self.expand(item)) }).collect())
                .unwrap_or_default(),
        )
    }

    pub fn cases(&self) -> &[Value] {
        self.data["cases"].as_array().map(Vec::as_slice).unwrap_or(&[])
    }
}

#[derive(Debug, Default)]
pub struct Summary {
    pub calls: usize,
    pub errors: usize,
    pub per_fn: std::collections::BTreeMap<String, usize>,
}

/// Прогнать все случаи; первое расхождение — паника с подробностями.
pub fn check(fixture: &Fixture, run: impl Fn(&str, &Args) -> Outcome) -> Summary {
    let mut summary = Summary::default();
    for (index, case) in fixture.cases().iter().enumerate() {
        let name = case["fn"].as_str().unwrap_or_default();
        let args = fixture.args(case);
        let actual = run(name, &args);
        *summary.per_fn.entry(name.to_string()).or_default() += 1;
        summary.calls += 1;
        if let Some(error) = case.get("error") {
            summary.errors += 1;
            // Отказ с кодом (`TaleSpireImportError`, `RuleError`) сверяется по
            // коду; падение рантайма JS без кода (`TypeError` на мусоре) — нет:
            // Rust на таком входе сознательно не падает.
            if let Some(code) = error.get("code").and_then(Value::as_str) {
                match &actual {
                    Err(actual_code) => assert_eq!(actual_code, code, "случай {index} {name}: код отказа; JS: {}", js::stringify(error)),
                    Ok(value) => panic!("случай {index} {name}: JS отказал {}, Rust вернул {:?}", js::stringify(error), value.as_ref().map(js::stringify)),
                }
            }
            continue;
        }
        let actual = match actual {
            Ok(value) => value,
            Err(error) => panic!("случай {index} {name}: Rust вернул ошибку {error}, JS — значение"),
        };
        let actual_text = actual.as_ref().map_or_else(|| "undefined".to_string(), js::stringify);
        if let Some(expected) = case.get("result") {
            let expected_text = if expected.as_str() == Some(UNDEFINED) { "undefined".to_string() } else { js::stringify(expected) };
            assert_eq!(actual_text, expected_text, "случай {index} {name}: args {}", js::stringify(&case["args"]));
        } else if let Some(expected) = case.get("sha256").and_then(Value::as_str) {
            assert_eq!(hash::sha256_hex(&actual_text), expected, "случай {index} {name}: {actual_text}");
        }
    }
    summary
}
