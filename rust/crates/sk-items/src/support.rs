//! Приведения JS, общие для модулей крейта: `value?.[key]`, `a ?? b`,
//! `Number.isSafeInteger`, `x || 0`, `Math.max`/`Math.min` над числами.

use serde_json::Value;
use sk_core::js;

/// `value?.[key]`: поле объекта (у массива, строки и прочего — `undefined`).
pub(crate) fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `a ?? b`.
pub(crate) fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

/// `Number.isSafeInteger(x)` для уже приведённого числа.
pub(crate) fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// `x || 0` для числа.
pub(crate) fn or_zero(value: f64) -> f64 {
    or_value(value, 0.0)
}

/// `x || fallback` для числа: `NaN` и ноль ложны.
pub(crate) fn or_value(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 {
        fallback
    } else {
        value
    }
}

/// `Math.max(a, b)` с заразным `NaN`.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

/// `Math.min(a, b)` с заразным `NaN`.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    js::min_of([a, b])
}


/// Число в JSON так, как его записывает `JSON.stringify`: целое — без дроби
/// (и за пределом безопасного целого, пока помещается в 64 бита: JS печатает
/// его цифрами до 1e21), `NaN` и бесконечность — `null`.
pub(crate) fn json_num(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 {
        if value.abs() < 9_223_372_036_854_775_808.0 {
            return Value::from(value as i64);
        }
        if (0.0..18_446_744_073_709_551_616.0).contains(&value) {
            return Value::from(value as u64);
        }
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}
