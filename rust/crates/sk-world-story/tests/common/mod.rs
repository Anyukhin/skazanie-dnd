//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Эталон — таблицы `values` (крупные поддеревья) и `states` (состояния) и
//! случаи `{ fn, args, retention?, result | sha256 | error }`. Ссылки
//! `{ "$state": i }` и `{ "$value": j }` подставляются обратно. Результат
//! сравнивается строкой `JSON.stringify` (`sk_core::js::stringify`) — вместе с
//! порядком ключей и видом чисел; крупный — её SHA-256.
//!
//! Падение рантайма JS (`TypeError` на `null` в коллекции, `DataCloneError`
//! на функции-прототипе) не сравнивается: Rust на таком мусоре сознательно не
//! падает, и проверяется только, что вызов прошёл без паники. Результат JS
//! «функция» (`FUNCTION`, ключ прототипа как id) Rust передаёт пустым
//! объектом с тем же поведением полей.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::Value;
use sk_core::{hash, js};
use sk_society::retention_context::with_retention_mode;

pub const UNDEFINED: &str = "\u{0}undefined";
pub const FUNCTION: &str = "\u{0}function";

/// Ожидаемое исключение JS.
#[derive(Debug, Clone)]
pub struct JsError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl JsError {
    pub fn new(name: &str, code: &str, message: &str) -> Self {
        Self { name: name.into(), code: Some(code.into()), message: message.into() }
    }
}

/// Итог вызова Rust: значение (`None` — `undefined`) или исключение.
pub type Outcome = Result<Option<Value>, JsError>;

pub fn ok(value: Value) -> Outcome {
    Ok(Some(value))
}

pub fn ok_opt(value: Option<Value>) -> Outcome {
    Ok(Some(value.unwrap_or(Value::Null)))
}

/// Аргументы случая: `None` — `undefined`.
pub struct Args(pub Vec<Option<Value>>);

impl Args {
    pub fn get(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }

    /// Аргумент как значение (`undefined` — `null`).
    pub fn value(&self, index: usize) -> &Value {
        self.get(index).unwrap_or(&Value::Null)
    }

    /// Поле объекта-параметров.
    pub fn option(&self, index: usize, key: &str) -> Option<&Value> {
        self.get(index).and_then(|options| options.get(key))
    }
}

/// Загруженный эталон.
pub struct Fixture {
    pub values: Vec<Value>,
    pub states: Vec<Value>,
    pub labels: serde_json::Map<String, Value>,
    pub cases: Vec<Value>,
}

impl Fixture {
    pub fn load(source: &str) -> Self {
        let mut fixture: Value = serde_json::from_str(source).expect("эталон — JSON");
        let take = |fixture: &mut Value, key: &str| match fixture.get_mut(key).map(Value::take) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        let raw_values = take(&mut fixture, "values");
        let raw_states = take(&mut fixture, "states");
        let cases = take(&mut fixture, "cases");
        let labels = fixture.get("labels").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut values: Vec<Value> = Vec::with_capacity(raw_values.len());
        for value in raw_values {
            let resolved = resolve_with(&value, &values, &[]);
            values.push(resolved);
        }
        let states = raw_states.iter().map(|state| resolve_with(state, &values, &[])).collect();
        Self { values, states, labels, cases }
    }

    /// Состояние по метке генератора.
    pub fn labelled(&self, label: &str) -> &Value {
        let index = self.labels.get(label).and_then(Value::as_u64).unwrap_or_else(|| panic!("нет состояния с меткой {label}"));
        &self.states[index as usize]
    }

    pub fn resolve(&self, value: &Value) -> Value {
        resolve_with(value, &self.values, &self.states)
    }
}

fn reference(value: &Value, key: &str) -> Option<usize> {
    let map = value.as_object()?;
    if map.len() != 1 {
        return None;
    }
    map.get(key).and_then(Value::as_u64).map(|index| index as usize)
}

fn resolve_with(value: &Value, values: &[Value], states: &[Value]) -> Value {
    if let Some(index) = reference(value, "$value") {
        return values.get(index).cloned().unwrap_or(Value::Null);
    }
    if let Some(index) = reference(value, "$state") {
        return states.get(index).cloned().unwrap_or(Value::Null);
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve_with(item, values, states)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), resolve_with(item, values, states))).collect()),
        other => other.clone(),
    }
}

/// Сводка прогона эталона.
#[derive(Debug, Default, Clone, Copy)]
pub struct Summary {
    pub calls: usize,
    /// Падений рантайма JS, где проверялось только отсутствие паники.
    pub js_crashes: usize,
    /// Случаев в legacy-режиме удержания.
    pub legacy: usize,
}

fn is_runtime_crash(error: &Value) -> bool {
    match error["name"].as_str() {
        Some("TypeError" | "RangeError") => error["code"].is_null(),
        // `DOMException` с числовым кодом 25.
        Some("DataCloneError") => true,
        _ => false,
    }
}

fn compare(name: &str, case: &Value, actual: Outcome) -> Result<bool, String> {
    if let Some(expected) = case.get("error") {
        if is_runtime_crash(expected) {
            return Ok(true);
        }
        return match actual {
            Err(actual) if expected["name"].as_str() == Some(actual.name.as_str()) && expected["code"].as_str() == actual.code.as_deref() && expected["message"].as_str() == Some(actual.message.as_str()) => Ok(false),
            other => Err(format!("{name}: ожидалось исключение {expected}, получено {other:?}")),
        };
    }
    let actual = match actual {
        Ok(value) => value,
        Err(error) => return Err(format!("{name}: неожиданное исключение {error:?}")),
    };
    if let Some(expected_hash) = case.get("sha256").and_then(Value::as_str) {
        let text = actual.as_ref().map_or_else(|| UNDEFINED.to_string(), js::stringify);
        return if hash::sha256_hex(&text) == expected_hash { Ok(false) } else { Err(format!("{name}: хеш не совпал, получено\n    {}", head(&text))) };
    }
    let expected = case.get("result").cloned().unwrap_or(Value::Null);
    let matches = match (expected.as_str(), &actual) {
        (Some(UNDEFINED), None) => true,
        (Some(FUNCTION), Some(Value::Object(map))) => map.is_empty(),
        (_, Some(actual)) => js::stringify(&expected) == js::stringify(actual),
        _ => false,
    };
    if matches {
        Ok(false)
    } else {
        Err(format!("{name}: ожидалось\n    {}\n  получено\n    {}", head(&js::stringify(&expected)), actual.as_ref().map_or_else(|| "undefined".to_string(), |value| head(&js::stringify(value)))))
    }
}

fn head(text: &str) -> String {
    if text.chars().count() > 1_500 {
        format!("{}…", text.chars().take(1_500).collect::<String>())
    } else {
        text.to_string()
    }
}

/// Прогнать все случаи эталона через `run` и упасть со сводкой расхождений.
pub fn check(fixture: &Fixture, mut run: impl FnMut(&str, &Args) -> Outcome) -> Summary {
    let mut failures: Vec<String> = Vec::new();
    let mut summary = Summary::default();
    for (index, case) in fixture.cases.iter().enumerate() {
        let name = case["fn"].as_str().unwrap_or_default();
        let args = Args(
            case["args"]
                .as_array()
                .map(|items| items.iter().map(|arg| (arg.as_str() != Some(UNDEFINED)).then(|| fixture.resolve(arg))).collect())
                .unwrap_or_default(),
        );
        let legacy = case.get("retention").and_then(Value::as_str) == Some("legacy");
        let actual = if legacy {
            summary.legacy += 1;
            with_retention_mode("legacy", || run(name, &args)).expect("режим legacy")
        } else {
            run(name, &args)
        };
        summary.calls += 1;
        match compare(name, case, actual) {
            Ok(crash) => summary.js_crashes += usize::from(crash),
            Err(mismatch) => failures.push(format!("случай #{index}\n  {mismatch}")),
        }
    }
    if !failures.is_empty() {
        let limit = std::env::var("SK_FAILURES").ok().and_then(|value| value.parse().ok()).unwrap_or(12);
        let shown: Vec<&String> = failures.iter().take(limit).collect();
        panic!("расхождений с JS: {} из {}\n{}", failures.len(), summary.calls, shown.iter().map(|text| text.as_str()).collect::<Vec<_>>().join("\n"));
    }
    summary
}
