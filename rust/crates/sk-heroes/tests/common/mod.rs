//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Каждый случай — вызов функции JS с аргументами и её результат (целиком
//! или хешем SHA-256 от `JSON.stringify`) либо исключение. Результат
//! сравнивается текстом `JSON.stringify` (`sk_core::js::stringify`), то есть
//! байт в байт, вместе с числами и порядком ключей JS.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::Value;
use sk_core::{hash, js};

/// Аргумент или результат `undefined` в эталоне.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Исключение JS: имя класса, код, текст; `runtime` — `TypeError` рантайма
/// V8, у которого сверяется только факт (текст V8 Rust не повторяет).
#[derive(Debug, Clone)]
pub struct JsError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
    pub runtime: bool,
}

/// Итог вызова Rust: значение (`None` — `undefined`) или исключение.
pub type Outcome = Result<Option<Value>, JsError>;

/// Исключение, которое бросает модуль: текст сверяется точно.
pub fn thrown(name: &str, code: Option<&str>, message: &str) -> JsError {
    JsError { name: name.into(), code: code.map(str::to_string), message: message.into(), runtime: false }
}

/// `TypeError` рантайма JS.
pub fn runtime(message: &str) -> JsError {
    JsError { name: "TypeError".into(), code: None, message: message.into(), runtime: true }
}

/// Аргументы случая: `None` — `undefined`.
pub struct Args(pub Vec<Option<Value>>);

impl Args {
    pub fn get(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }
}

pub fn ok(value: Value) -> Outcome {
    Ok(Some(value))
}

pub fn ok_or_null(value: Option<Value>) -> Outcome {
    Ok(Some(value.unwrap_or(Value::Null)))
}

/// Эталон: разобранный JSON и его случаи.
pub fn cases(source: &str) -> Vec<Value> {
    let fixture: Value = serde_json::from_str(source).expect("эталон — JSON");
    fixture["cases"].as_array().cloned().expect("cases — массив")
}

/// Результат константы `const:<name>` эталона.
pub fn constant(source: &str, name: &str) -> Value {
    cases(source)
        .into_iter()
        .find(|case| case["fn"].as_str() == Some(&format!("const:{name}")))
        .map(|case| case["result"].clone())
        .unwrap_or_else(|| panic!("в эталоне нет const:{name}"))
}

fn args_of(case: &Value) -> Args {
    Args(
        case["args"]
            .as_array()
            .map(|args| args.iter().map(|arg| (arg.as_str() != Some(UNDEFINED)).then(|| arg.clone())).collect())
            .unwrap_or_default(),
    )
}

/// Прогнать все случаи эталона через `run` и упасть со сводкой расхождений.
/// Возвращает число сверенных случаев.
pub fn check(source: &str, mut run: impl FnMut(&str, &Args) -> Outcome) -> usize {
    let cases = cases(source);
    let mut failures: Vec<String> = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().unwrap_or_default();
        let args = args_of(case);
        let actual = run(name, &args);
        let mismatch = match (case.get("error"), actual) {
            (Some(expected), Err(actual)) => {
                let same_kind = expected["name"].as_str() == Some(actual.name.as_str())
                    && expected["code"].as_str() == actual.code.as_deref()
                    && js::is_true(expected.get("runtime")) == actual.runtime;
                let same = same_kind && (actual.runtime || expected["message"].as_str() == Some(actual.message.as_str()));
                (!same).then(|| format!("ожидалось исключение {expected}, получено {actual:?}"))
            }
            (Some(expected), Ok(actual)) => Some(format!("ожидалось исключение {expected}, получено {}", actual.map_or("undefined".into(), |v| js::stringify(&v)))),
            (None, Err(actual)) => Some(format!("ожидался результат, получено исключение {actual:?}")),
            (None, Ok(actual)) => {
                let actual = actual.unwrap_or_else(|| Value::String(UNDEFINED.into()));
                let actual_text = js::stringify(&actual);
                if let Some(expected_hash) = case.get("sha256").and_then(Value::as_str) {
                    let actual_hash = hash::sha256_hex(&actual_text);
                    (actual_hash != expected_hash).then(|| format!("хеш JSON расходится; получено\n    {actual_text}"))
                } else {
                    let expected_text = js::stringify(&case["result"]);
                    (expected_text != actual_text).then(|| format!("ожидалось\n    {expected_text}\n  получено\n    {actual_text}"))
                }
            }
        };
        if let Some(mismatch) = mismatch {
            let shown_args = js::stringify(&case["args"]);
            let shown_args: String = shown_args.chars().take(600).collect();
            failures.push(format!("#{index} {name}({shown_args}):\n  {mismatch}"));
        }
    }
    assert!(
        failures.is_empty(),
        "расхождений с JS: {} из {}\n\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n\n")
    );
    cases.len()
}
