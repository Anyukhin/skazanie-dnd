//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Каждый случай — вызов функции JS с аргументами и её результат, хеш
//! результата или исключение. Результат сравнивается строкой JSON, то есть
//! вместе с порядком ключей, как его видит `JSON.stringify`; хеш — SHA-256 той
//! же строки. Копия помощника `sk-items/tests/common` с хешированными случаями.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::Value;

pub mod images;

/// Аргумент или результат `undefined` в эталоне.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Результат-функция: так `KITS_2024['constructor']` находит свойство прототипа.
pub const FUNCTION: &str = "\u{0}function";

/// Ожидаемое исключение JS.
#[derive(Debug, Clone)]
pub struct JsError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

/// Итог вызова Rust: значение (`None` — `undefined`) или исключение.
pub type Outcome = Result<Option<Value>, JsError>;

pub fn error(name: &str, code: Option<&str>, message: &str) -> JsError {
    JsError { name: name.into(), code: code.map(str::to_string), message: message.into() }
}

/// Пометка `TypeError` рантайма JS (обращение к полю `null`, распаковка
/// неитерируемого): текст V8 не сравнивается, только сам факт исключения.
pub const RUNTIME: &str = "\u{0}runtime:";

/// `TypeError` рантайма JS.
pub fn type_error(message: impl Into<String>) -> JsError {
    JsError { name: "TypeError".into(), code: None, message: format!("{RUNTIME}{}", message.into()) }
}

/// `TypeError`, который JS-модуль бросает сам, — текст сверяется точно.
pub fn thrown_type_error(message: impl Into<String>) -> JsError {
    JsError { name: "TypeError".into(), code: None, message: message.into() }
}

/// Аргументы случая: `None` — `undefined`.
pub struct Args(pub Vec<Option<Value>>);

impl Args {
    pub fn get(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }

    /// `String(arg ?? '')`.
    pub fn s(&self, index: usize) -> String {
        sk_core::js::s(self.get(index))
    }

    /// Поле объекта-параметров (`{ complete, rulesetId }`).
    pub fn option(&self, index: usize, key: &str) -> Option<&Value> {
        self.get(index).and_then(|options| options.get(key))
    }
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Прогнать все случаи эталона через `run` и упасть со сводкой расхождений.
pub fn check(source: &str, mut run: impl FnMut(&str, &Args) -> Outcome) -> usize {
    let fixture: Value = serde_json::from_str(source).expect("эталон — JSON");
    let cases = fixture["cases"].as_array().expect("cases — массив");
    let mut failures: Vec<String> = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().unwrap_or_default();
        let args = Args(
            case["args"]
                .as_array()
                .map(|args| args.iter().map(|arg| (arg.as_str() != Some(UNDEFINED)).then(|| arg.clone())).collect())
                .unwrap_or_default(),
        );
        let actual = run(name, &args);
        let mismatch = match (case.get("error"), actual) {
            (Some(expected), Err(actual)) => {
                let expected_name = expected["name"].as_str().unwrap_or_default();
                let same = if expected_name == "TypeError" && actual.name == "TypeError" && actual.message.starts_with(RUNTIME) {
                    true
                } else {
                    expected_name == actual.name && expected["code"].as_str() == actual.code.as_deref() && expected["message"].as_str() == Some(actual.message.as_str())
                };
                (!same).then(|| format!("ожидалось исключение {expected}, получено {actual:?}"))
            }
            (Some(expected), Ok(actual)) => Some(format!("ожидалось исключение {expected}, получено {}", actual.map(|value| json_text(&value)).unwrap_or_default())),
            (None, Err(actual)) => Some(format!("ожидалось {}, получено исключение {actual:?}", case.get("result").or(case.get("sha256")).cloned().unwrap_or_default())),
            (None, Ok(actual)) => {
                let actual = actual.unwrap_or_else(|| Value::String(UNDEFINED.into()));
                let actual_text = json_text(&actual);
                if let Some(hash) = case.get("sha256").and_then(Value::as_str) {
                    (sk_core::hash::sha256_hex(&actual_text) != hash).then(|| format!("хеш JSON.stringify разошёлся; получено\n    {}", sk_core::text::head(&actual_text, 4_000)))
                } else {
                    let expected_text = json_text(&case["result"]);
                    // Строки совпадают, кроме целых за 2^53: `JSON.stringify` пишет
                    // кратчайшую запись (`900719925474099100`), а `serde_json` — точные
                    // цифры того же f64 (`900719925474099072`). Тогда сверка — по значению.
                    (expected_text != actual_text && !same_json(&case["result"], &actual)).then(|| format!("ожидалось\n    {expected_text}\n  получено\n    {actual_text}"))
                }
            }
        };
        if let Some(mismatch) = mismatch {
            failures.push(format!("#{index} {name}({}):\n  {mismatch}", sk_core::text::head(&json_text(&case["args"]), 1_500)));
        }
    }
    assert!(
        failures.is_empty(),
        "расхождений с JS: {} из {}\n\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n\n")
    );
    cases.len()
}

/// Равенство JSON с числами по значению f64; порядок ключей тоже сверяется.
pub fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_json(x, y)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().zip(b.iter()).all(|((key_a, x), (key_b, y))| key_a == key_b && same_json(x, y)),
        _ => left == right,
    }
}

/// Значение как итог вызова.
pub fn ok(value: Value) -> Outcome {
    Ok(Some(value))
}

/// `Option` как итог: `None` — `null`.
pub fn ok_or_null(value: Option<Value>) -> Outcome {
    Ok(Some(value.unwrap_or(Value::Null)))
}
