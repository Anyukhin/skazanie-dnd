//! Чтение рыхлого JSON прежнего движка: числа строками, `null` вместо пусто.
//!
//! JS приводит значения на лету (`safeInteger`, `String(x ?? '')`). Здесь те же
//! правила в одном месте, чтобы перенесённые ветки не изобретали своих.

use serde_json::{Map, Value};

/// Целое, как `safeInteger(value, fallback)`: `Number(value)`, если это
/// безопасное целое, иначе запас. Как в JS, `null` и `""` дают 0, `true` — 1,
/// а дробное число и `undefined` — запас.
pub fn int(value: Option<&Value>, fallback: i64) -> i64 {
    let number = crate::js::number(value);
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
        number as i64
    } else {
        fallback
    }
}

/// Строка, как `String(value ?? '')`.
pub fn string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => crate::js::js_number_string(number),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// `value === true`.
pub fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

/// Поле объекта.
pub fn field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

/// Список строк из массива; не строки пропускаются.
pub fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(|item| match item {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(crate::js::js_number_string(number)),
            _ => None,
        }).collect(),
        _ => Vec::new(),
    }
}

/// Модификатор характеристики: (значение − 10) / 2 с округлением вниз.
pub fn ability_modifier(score: i64) -> i64 {
    (score - 10).div_euclid(2)
}
