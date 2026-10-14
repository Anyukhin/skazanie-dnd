//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Случай — `{ fn, args, out | throws }`; крупные значения лежат в таблице
//! `values` и подставляются по `{ "$ref": n }`, `undefined` записан как
//! `{ "$undefined": true }`. Выход Rust сравнивается с эталоном текстом JSON:
//! так ловятся и порядок ключей, и `2` против `2.0`.

#![allow(dead_code)] // Каждый тестовый файл берёт свою часть помощников.

use serde_json::{json, Value};

pub struct Fixture {
    pub root: Value,
    values: Vec<Value>,
    pub cases: Vec<Case>,
}

pub struct Case {
    pub name: String,
    pub args: Vec<Option<Value>>,
    pub expected: Expected,
}

#[derive(Debug, PartialEq)]
pub enum Expected {
    /// `None` — функция вернула `undefined`.
    Value(Option<Value>),
    Throws { code: Option<String>, message: String },
}

/// Что вернул перенос.
pub enum Outcome {
    Value(Option<Value>),
    Throws { code: Option<String>, message: String },
    /// Функции нет в диспетчере — это ошибка теста, а не пропуск.
    Unknown,
}

impl Outcome {
    pub fn of(value: impl Into<Value>) -> Self {
        Self::Value(Some(value.into()))
    }

    pub fn option(value: Option<impl Into<Value>>) -> Self {
        Self::Value(Some(value.map(Into::into).unwrap_or(Value::Null)))
    }
}

impl Fixture {
    pub fn load(text: &str) -> Self {
        let root: Value = serde_json::from_str(text).expect("эталон — JSON");
        let values = root.get("values").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut fixture = Self { root, values, cases: Vec::new() };
        let cases: Vec<Value> = fixture.root.get("cases").and_then(Value::as_array).cloned().unwrap_or_default();
        fixture.cases = cases
            .iter()
            .map(|case| {
                let args = case.get("args").and_then(Value::as_array).map(|args| args.iter().map(|arg| fixture.resolve(arg)).collect()).unwrap_or_default();
                let expected = match case.get("throws") {
                    Some(throws) => Expected::Throws {
                        code: throws.get("code").and_then(Value::as_str).map(str::to_string),
                        message: throws.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
                    },
                    None => Expected::Value(case.get("out").and_then(|out| fixture.resolve(out))),
                };
                Case { name: case.get("fn").and_then(Value::as_str).unwrap_or_default().to_string(), args, expected }
            })
            .collect();
        fixture
    }

    fn resolve(&self, value: &Value) -> Option<Value> {
        if value.get("$undefined") == Some(&json!(true)) {
            return None;
        }
        if let Some(index) = value.get("$ref").and_then(Value::as_u64) {
            return self.values.get(index as usize).cloned();
        }
        Some(value.clone())
    }

    /// Прогнать все случаи через диспетчер и упасть со списком расхождений.
    pub fn check(&self, dispatch: impl Fn(&str, &Args) -> Outcome) -> usize {
        let mut failures = Vec::new();
        for (index, case) in self.cases.iter().enumerate() {
            let args = Args(&case.args);
            let actual = match dispatch(&case.name, &args) {
                Outcome::Unknown => {
                    failures.push(format!("#{index} {}: функции нет в диспетчере", case.name));
                    continue;
                }
                Outcome::Value(value) => Expected::Value(value),
                Outcome::Throws { code, message } => Expected::Throws { code, message },
            };
            if render(&actual) != render(&case.expected) {
                failures.push(format!(
                    "#{index} {}({})\n  JS:   {}\n  Rust: {}",
                    case.name,
                    clip(&serde_json::to_string(&case.args).unwrap_or_default(), 600),
                    clip(&render(&case.expected), 900),
                    clip(&render(&actual), 900)
                ));
            }
        }
        let total = self.cases.len();
        assert!(failures.is_empty(), "расхождений с JS: {} из {total}\n{}", failures.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
        total
    }
}

fn render(expected: &Expected) -> String {
    match expected {
        Expected::Value(None) => "undefined".into(),
        Expected::Value(Some(value)) => serde_json::to_string(value).unwrap_or_default(),
        Expected::Throws { code, message } => format!("throws {code:?}: {message}"),
    }
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(limit).collect::<String>())
    }
}

/// Аргументы случая: `None` — `undefined`.
pub struct Args<'a>(pub &'a [Option<Value>]);

impl Args<'_> {
    /// Аргумент как есть (`None` — `undefined` или его нет).
    pub fn opt(&self, index: usize) -> Option<&Value> {
        self.0.get(index).and_then(Option::as_ref)
    }

    /// Аргумент с умолчанием JS `= {}`/`= ''`: `undefined` читается как `null`,
    /// который перенос понимает так же.
    pub fn val(&self, index: usize) -> &Value {
        static NULL: Value = Value::Null;
        self.opt(index).unwrap_or(&NULL)
    }

    /// Аргумент с умолчанием JS `= {}`.
    pub fn obj(&self, index: usize) -> Value {
        self.opt(index).cloned().unwrap_or_else(|| json!({}))
    }

    /// Массив-аргумент (события и т. п.).
    pub fn list(&self, index: usize) -> Vec<Value> {
        self.opt(index).and_then(Value::as_array).cloned().unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}
