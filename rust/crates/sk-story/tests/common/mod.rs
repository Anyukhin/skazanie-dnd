//! Сверка с эталонами JS (`fixtures/*.json.gz`, генераторы
//! `fixtures/gen-*.mjs`, писатель — `sk-world-story/fixtures/story-lib.mjs`).
//!
//! Эталон — таблицы `values` (крупные поддеревья) и `states` (состояния) и
//! случаи `{ fn, args, result | sha256 | error }`. Ссылки `{ "$state": i }` и
//! `{ "$value": j }` подставляются обратно. Результат сравнивается строкой
//! `JSON.stringify` (`sk_core::js::stringify`) — вместе с порядком ключей и
//! видом чисел; крупный — её SHA-256.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use std::io::Read;

use serde_json::Value;
use sk_core::{hash, js};

pub const UNDEFINED: &str = "\u{0}undefined";

/// Итог вызова Rust: значение (`None` — `undefined`) или текст исключения.
pub type Outcome = Result<Option<Value>, String>;

/// Аргументы случая: `None` — `undefined`.
pub struct Args(pub Vec<Option<Value>>);

impl Args {
    pub fn get(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }

    pub fn value(&self, index: usize) -> &Value {
        self.get(index).unwrap_or(&Value::Null)
    }

    pub fn str(&self, index: usize) -> &str {
        self.get(index).and_then(Value::as_str).unwrap_or_default()
    }
}

pub struct Fixture {
    pub values: Vec<Value>,
    pub states: Vec<Value>,
    pub cases: Vec<Value>,
}

impl Fixture {
    pub fn load_gz(bytes: &[u8]) -> Self {
        let mut text = String::new();
        flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон — gzip");
        let mut fixture: Value = serde_json::from_str(&text).expect("эталон — JSON");
        let mut take = |key: &str| match fixture.get_mut(key).map(Value::take) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        let values = take("values");
        let states = take("states");
        let cases = take("cases");
        let mut fixture = Self { values, states, cases: Vec::new() };
        let states: Vec<Value> = fixture.states.iter().map(|state| fixture.resolve(state)).collect();
        fixture.states = states;
        fixture.cases = cases;
        fixture
    }

    /// Подставить `$value` и `$state` обратно.
    pub fn resolve(&self, value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                if map.len() == 1 {
                    if let Some(index) = map.get("$value").and_then(Value::as_u64) {
                        return self.resolve(&self.values[index as usize]);
                    }
                    if let Some(index) = map.get("$state").and_then(Value::as_u64) {
                        return self.states[index as usize].clone();
                    }
                }
                Value::Object(map.iter().map(|(key, item)| (key.clone(), self.resolve(item))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(|item| self.resolve(item)).collect()),
            other => other.clone(),
        }
    }

    pub fn args(&self, case: &Value) -> Args {
        Args(
            case.get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().map(|arg| if arg.as_str() == Some(UNDEFINED) { None } else { Some(self.resolve(arg)) }).collect())
                .unwrap_or_default(),
        )
    }
}

/// Сравнить итог с ожидаемым; `Some(описание)` — расхождение.
pub fn compare(case: &Value, outcome: &Outcome) -> Option<String> {
    if let Some(error) = case.get("error") {
        // Падение рантайма JS (`TypeError` на мусоре старого сохранения) не
        // сравнивается: Rust на таком входе сознательно не падает.
        if error.get("name").and_then(Value::as_str) != Some("Error") {
            return None;
        }
        let expected = error.get("message").and_then(Value::as_str).unwrap_or_default();
        return match outcome {
            Err(message) if message == expected => None,
            other => Some(format!("ожидалась ошибка «{expected}», получено {other:?}")),
        };
    }
    let actual = match outcome {
        Err(message) => return Some(format!("ошибка «{message}»")),
        Ok(None) => UNDEFINED.to_string(),
        Ok(Some(value)) => js::stringify(value),
    };
    if let Some(expected) = case.get("sha256").and_then(Value::as_str) {
        return (hash::sha256_hex(&actual) != expected).then(|| format!("sha256 расходится: {}", head(&actual)));
    }
    let expected = match case.get("result") {
        Some(Value::String(text)) if text == UNDEFINED => UNDEFINED.to_string(),
        Some(value) => js::stringify(value),
        None => "<нет результата>".into(),
    };
    (actual != expected).then(|| format!("ожидалось {}\n   получено {}", head(&expected), head(&actual)))
}

fn head(text: &str) -> String {
    text.chars().take(700).collect()
}

/// Прогнать все случаи; паника с первыми расхождениями.
pub fn run(fixture: &Fixture, mut call: impl FnMut(&str, &Args) -> Option<Outcome>) {
    let mut failures = Vec::new();
    let mut checked = 0;
    let mut by_fn: std::collections::BTreeMap<String, usize> = Default::default();
    for (index, case) in fixture.cases.iter().enumerate() {
        let name = case.get("fn").and_then(Value::as_str).unwrap_or_default();
        let args = fixture.args(case);
        let Some(outcome) = call(name, &args) else {
            failures.push(format!("#{index} {name}: функция не перенесена"));
            continue;
        };
        checked += 1;
        *by_fn.entry(name.to_string()).or_default() += 1;
        if let Some(problem) = compare(case, &outcome) {
            failures.push(format!("#{index} {name}({}): {problem}", head(&js::stringify(&Value::Array(args.0.iter().map(|arg| arg.clone().unwrap_or(Value::Null)).collect())))));
        }
    }
    eprintln!("сверено {checked} случаев: {by_fn:?}");
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), fixture.cases.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

/// Множество строк — массив JSON.
pub fn set_value<'a>(items: impl IntoIterator<Item = &'a String>) -> Value {
    Value::Array(items.into_iter().map(|item| Value::String(item.clone())).collect())
}
