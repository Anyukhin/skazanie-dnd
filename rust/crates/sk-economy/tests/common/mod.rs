//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Каждый случай — вызов функции JS с аргументами и её результат или
//! исключение; связка (`bundle:*`) — один большой вход и список вызовов над
//! ним. Результат сравнивается строкой JSON, то есть вместе с порядком ключей
//! и видом чисел (`2`, а не `2.0`).
//!
//! `TypeError` рантайма JS (обращение к полю функции-прототипа, `.map` у не
//! массива) не сравнивается: Rust на таком мусоре сознательно не падает, и
//! проверяется только, что вызов прошёл без паники.

#![allow(dead_code)] // не каждый тестовый файл зовёт все помощники

use serde_json::Value;

/// Аргумент или результат `undefined` в эталоне.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Ожидаемое исключение JS.
#[derive(Debug, Clone)]
pub struct JsError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

/// Итог вызова Rust: значение (`None` — `undefined`) или исключение.
pub type Outcome = Result<Option<Value>, JsError>;

pub fn error(name: &str, code: &str, message: &str) -> JsError {
    JsError { name: name.into(), code: Some(code.into()), message: message.into() }
}

/// Аргументы случая: `None` — `undefined`.
pub struct Args(pub Vec<Option<Value>>);

impl Args {
    fn decode(values: &[Value]) -> Self {
        Self(values.iter().map(|arg| (arg.as_str() != Some(UNDEFINED)).then(|| arg.clone())).collect())
    }

    pub fn get(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }

    /// `String(arg ?? '')`.
    pub fn s(&self, index: usize) -> String {
        sk_core::js::s(self.get(index))
    }

    /// Поле объекта-параметров (`{ allowRemote }`).
    pub fn option(&self, index: usize, key: &str) -> Option<&Value> {
        self.get(index).and_then(|options| options.get(key))
    }

    /// Число аргументов.
    pub fn len(&self) -> usize {
        self.0.len()
    }
}

fn compare(name: &str, expected_result: Option<&Value>, expected_error: Option<&Value>, actual: Outcome) -> Result<bool, String> {
    match (expected_error, actual) {
        (Some(expected), actual) if expected["name"] == "TypeError" && expected["code"].is_null() => {
            // Падение рантайма JS: Rust обязан лишь не паниковать.
            let _ = actual;
            Ok(true)
        }
        (Some(expected), Err(actual)) => {
            let same = expected["name"].as_str() == Some(actual.name.as_str()) && expected["code"].as_str() == actual.code.as_deref() && expected["message"].as_str() == Some(actual.message.as_str());
            if same {
                Ok(false)
            } else {
                Err(format!("{name}: ожидалось исключение {expected}, получено {actual:?}"))
            }
        }
        (Some(expected), Ok(actual)) => Err(format!("{name}: ожидалось исключение {expected}, получено {actual:?}")),
        (None, Err(actual)) => Err(format!("{name}: ожидалось {}, получено исключение {actual:?}", expected_result.cloned().unwrap_or(Value::Null))),
        (None, Ok(actual)) => {
            let expected = expected_result.cloned().unwrap_or(Value::Null);
            let actual = actual.unwrap_or_else(|| Value::String(UNDEFINED.into()));
            let expected_text = serde_json::to_string(&expected).unwrap_or_default();
            let actual_text = serde_json::to_string(&actual).unwrap_or_default();
            if expected_text == actual_text {
                Ok(false)
            } else {
                Err(format!("{name}: ожидалось\n    {expected_text}\n  получено\n    {actual_text}"))
            }
        }
    }
}

/// Сводка прогона эталона.
#[derive(Debug, Default, Clone, Copy)]
pub struct Summary {
    /// Сверенных вызовов (в связках — каждый вызов отдельно).
    pub calls: usize,
    /// Из них — падений рантайма JS, где проверялось только отсутствие паники.
    pub js_crashes: usize,
}

/// Прогнать все случаи эталона через `run` и упасть со сводкой расхождений.
pub fn check(source: &str, mut run: impl FnMut(&str, &Args) -> Outcome) -> Summary {
    let fixture: Value = serde_json::from_str(source).expect("эталон — JSON");
    let cases = fixture["cases"].as_array().expect("cases — массив");
    let mut failures: Vec<String> = Vec::new();
    let mut summary = Summary::default();
    let record = |label: String, outcome: Result<bool, String>, summary: &mut Summary, failures: &mut Vec<String>| {
        summary.calls += 1;
        match outcome {
            Ok(crash) => summary.js_crashes += usize::from(crash),
            Err(mismatch) => failures.push(format!("{label}\n  {mismatch}")),
        }
    };
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().unwrap_or_default();
        let raw_args = case["args"].as_array().cloned().unwrap_or_default();
        if name.starts_with("bundle:") {
            let subject = raw_args.first().cloned().unwrap_or(Value::Null);
            let calls = raw_args.get(1).and_then(Value::as_array).cloned().unwrap_or_default();
            let results = case["result"].as_array().cloned().unwrap_or_default();
            for (call_index, call) in calls.iter().enumerate() {
                let call = call.as_array().cloned().unwrap_or_default();
                let fn_name = call.first().and_then(Value::as_str).unwrap_or_default().to_string();
                let mut values = vec![subject.clone()];
                values.extend(call.iter().skip(1).cloned());
                let args = Args::decode(&values);
                let expected = results.get(call_index).cloned().unwrap_or(Value::Null);
                let outcome = compare(&fn_name, expected.get("result"), expected.get("error"), run(&fn_name, &args));
                let label = format!("#{index}.{call_index} {name} → {fn_name}({})", serde_json::to_string(&Value::Array(call[1..].to_vec())).unwrap_or_default());
                record(label, outcome, &mut summary, &mut failures);
            }
            continue;
        }
        let args = Args::decode(&raw_args);
        let outcome = compare(name, case.get("result"), case.get("error"), run(name, &args));
        let label = format!("#{index} {name}({})", text_head(&serde_json::to_string(&case["args"]).unwrap_or_default(), 600));
        record(label, outcome, &mut summary, &mut failures);
    }
    assert!(
        failures.is_empty(),
        "расхождений с JS: {} из {}\n\n{}",
        failures.len(),
        summary.calls,
        failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n\n")
    );
    summary
}

fn text_head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Значение как итог вызова.
pub fn ok(value: Value) -> Outcome {
    Ok(Some(value))
}

/// `Option` как итог: `None` — `null`.
pub fn ok_or_null(value: Option<Value>) -> Outcome {
    Ok(Some(value.unwrap_or(Value::Null)))
}
