//! Сверка с эталонами JS (`fixtures/*.json`, генераторы `fixtures/gen-*.mjs`).
//!
//! Случай — `{ fn, args, out | outHash | throws }`; крупные значения лежат в
//! таблице `values` и подставляются по `{ "$ref": n }`, `undefined` записан как
//! `{ "$undefined": true }`. Выход Rust сравнивается с эталоном текстом JSON:
//! так ловятся и порядок ключей, и `2` против `2.0`; крупный выход — по
//! sha256 того же текста.

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
    Hash(String),
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

    pub fn result<T: Into<Value>, E: ErrorParts>(value: Result<T, E>) -> Self {
        match value {
            Ok(value) => Self::of(value),
            Err(error) => Self::Throws { code: Some(error.code().to_string()), message: error.message().to_string() },
        }
    }
}

/// Код и текст отказа для сравнения с `throws` эталона.
pub trait ErrorParts {
    fn code(&self) -> &str;
    fn message(&self) -> &str;
}

impl ErrorParts for sk_memory::world_memory::WorldMemoryValidationError {
    fn code(&self) -> &str {
        &self.code
    }
    fn message(&self) -> &str {
        &self.message
    }
}

impl ErrorParts for sk_memory::party_decision::PartyDecisionError {
    fn code(&self) -> &str {
        &self.code
    }
    fn message(&self) -> &str {
        &self.message
    }
}

impl ErrorParts for sk_memory::party_decision::QuestDecisionError {
    fn code(&self) -> &str {
        sk_memory::party_decision::QuestDecisionError::code(self)
    }
    fn message(&self) -> &str {
        sk_memory::party_decision::QuestDecisionError::message(self)
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
                let expected = if let Some(throws) = case.get("throws") {
                    Expected::Throws {
                        code: throws.get("code").and_then(Value::as_str).map(str::to_string),
                        message: throws.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
                    }
                } else if let Some(hash) = case.get("outHash").and_then(Value::as_str) {
                    Expected::Hash(hash.to_string())
                } else {
                    Expected::Value(case.get("out").and_then(|out| fixture.resolve(out)))
                };
                Case { name: case.get("fn").and_then(Value::as_str).unwrap_or_default().to_string(), args, expected }
            })
            .collect();
        fixture
    }

    pub fn resolve(&self, value: &Value) -> Option<Value> {
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
                Outcome::Value(value) => match (&case.expected, value) {
                    (Expected::Hash(_), Some(value)) => Expected::Hash(sk_core::hash::sha256_hex(serde_json::to_string(&value).unwrap_or_default())),
                    (_, value) => Expected::Value(value),
                },
                Outcome::Throws { code, message } => Expected::Throws { code, message },
            };
            if render(&actual) != render(&case.expected) {
                failures.push(format!(
                    "#{index} {}({})\n  JS:   {}\n  Rust: {}",
                    case.name,
                    clip(&serde_json::to_string(&case.args).unwrap_or_default(), 600),
                    clip(&render(&case.expected), 1200),
                    clip(&render(&actual), 1200)
                ));
            }
        }
        let total = self.cases.len();
        assert!(failures.is_empty(), "расхождений с JS: {} из {total}\n{}", failures.len(), failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
        total
    }
}

pub fn render(expected: &Expected) -> String {
    match expected {
        Expected::Value(None) => "undefined".into(),
        Expected::Value(Some(value)) => serde_json::to_string(value).unwrap_or_default(),
        Expected::Hash(hash) => format!("sha256:{hash}"),
        Expected::Throws { code, message } => format!("throws {code:?}: {message}"),
    }
}

pub fn clip(text: &str, limit: usize) -> String {
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

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

/// `String(value)` для аргумента JS (`undefined` → `"undefined"`).
pub fn js_string(value: Option<&Value>) -> String {
    sk_core::js::string(value)
}
