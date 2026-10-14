//! Общие помощники сверки с эталонами JS.

#![allow(dead_code)] // каждый тестовый файл берёт свою часть помощников

use serde_json::Value;

/// Равенство JSON с числами по значению: `2` и `2.0` равны, дробные числа
/// сравниваются с точностью до последнего бита (разбор JSON без
/// `float_roundtrip` может ошибиться на единицу младшего разряда).
pub fn json_eq(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(left), Value::Number(right)) => {
            let (Some(left), Some(right)) = (left.as_f64(), right.as_f64()) else { return left == right };
            left == right || (left - right).abs() <= f64::EPSILON * left.abs().max(right.abs())
        }
        (Value::Array(left), Value::Array(right)) => left.len() == right.len() && left.iter().zip(right).all(|(a, b)| json_eq(a, b)),
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().zip(right.iter()).all(|((left_key, left_value), (right_key, right_value))| left_key == right_key && json_eq(left_value, right_value))
        }
        _ => actual == expected,
    }
}

/// Сверка с эталоном с понятным сообщением о расхождении.
#[track_caller]
pub fn assert_json(actual: &Value, expected: &Value, context: impl std::fmt::Display) {
    assert!(json_eq(actual, expected), "{context}\n  Rust: {actual}\n  JS:   {expected}");
}

/// Сводка расхождений: тест падает со списком первых из них.
pub struct Mismatches {
    pub total: usize,
    pub failures: Vec<String>,
}

impl Mismatches {
    pub fn new() -> Self {
        Self { total: 0, failures: Vec::new() }
    }

    pub fn check(&mut self, actual: &Value, expected: &Value, context: impl FnOnce() -> String) {
        self.total += 1;
        if !json_eq(actual, expected) {
            self.failures.push(format!("{}\n  Rust: {actual}\n  JS:   {expected}", context()));
        }
    }

    #[track_caller]
    pub fn finish(self, name: &str) -> usize {
        assert!(
            self.failures.is_empty(),
            "{name}: {} расхождений из {}:\n{}",
            self.failures.len(),
            self.total,
            self.failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
        );
        assert!(self.total > 0, "{name}: пустой эталон");
        self.total
    }
}

/// Поле как `Option<&Value>`: `null` в эталоне — отсутствующее значение JS
/// там, где генератор так его записал.
pub fn opt(value: &Value) -> Option<&Value> {
    (!value.is_null()).then_some(value)
}
