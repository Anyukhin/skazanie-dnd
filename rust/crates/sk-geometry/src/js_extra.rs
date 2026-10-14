//! Приведения JS, которых нет в `sk_core::js` или которые там приблизительны
//! для этих модулей: `String(x)` с `undefined`/`null`, точный набор пробелов
//! `\s`, `slice` по единицам UTF-16, `Math.hypot` и `Math.max/min` как в V8,
//! строковый порядок `array.sort()`.

use std::cmp::Ordering;

use serde_json::Value;

/// `String(value)`: `undefined` → `"undefined"`, `null` → `"null"`, число —
/// как его печатает JS (`1e+21`, а не `1000000000000000000000`), массив —
/// `join(',')` с пустыми `null`, объект — `"[object Object]"`.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => sk_core::js::f64_string(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(value ?? '')`.
pub(crate) fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    }
}

/// Пробел регулярного выражения JS `\s` и `String.prototype.trim`:
/// WhiteSpace (TAB, VT, FF, ZWNBSP, категория Zs) и LineTerminator. В отличие от
/// `char::is_whitespace`, U+0085 сюда не входит, а U+FEFF входит.
pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{9}'
            | '\u{A}'
            | '\u{B}'
            | '\u{C}'
            | '\u{D}'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `text.trim()` с точным набором пробелов JS.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.replace(/\s+/gu, ' ')`.
pub(crate) fn collapse_js_whitespace(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_space = false;
    for ch in text.chars() {
        if is_js_whitespace(ch) {
            if !in_space {
                result.push(' ');
            }
            in_space = true;
        } else {
            in_space = false;
            result.push(ch);
        }
    }
    result
}

/// `text.slice(0, limit)` по единицам UTF-16, как в JS. Если граница режет
/// суррогатную пару, JS оставляет одинокий старший суррогат; строка Rust его
/// не держит, поэтому символ отбрасывается целиком.
pub(crate) fn slice_utf16(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        result.push(ch);
    }
    result
}

/// Порядок `array.sort()` без сравнителя для строк: по единицам UTF-16.
pub(crate) fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `Number.isSafeInteger(number)` для уже приведённого числа.
pub(crate) fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `Math.max(a, b)`: `NaN` заразен, `+0` больше `-0`.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: `NaN` заразен, `-0` меньше `+0`.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// `Math.hypot(a, b)` по алгоритму V8 (`builtins/math.tq`): нормировка на
/// наибольший модуль и сумма Кэхэна. Системный `f64::hypot` может отличаться
/// в последнем бите, а карта мира сортирует по разности таких расстояний —
/// равные в JS расстояния должны остаться равными.
pub(crate) fn js_hypot(a: f64, b: f64) -> f64 {
    let mut abs_values = [0.0_f64; 2];
    let mut one_is_nan = false;
    let mut max = 0.0_f64;
    for (slot, value) in abs_values.iter_mut().zip([a, b]) {
        if value.is_nan() {
            one_is_nan = true;
        } else {
            let abs = value.abs();
            *slot = abs;
            if abs > max {
                max = abs;
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if one_is_nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for abs in abs_values {
        let normalized = abs / max;
        let summand = normalized * normalized - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_follows_js() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&json!(null))), "null");
        assert_eq!(js_string(Some(&json!(1e21))), "1e+21");
        assert_eq!(js_string(Some(&json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(js_string(Some(&json!({ "a": 1 }))), "[object Object]");
        assert_eq!(js_string_or_empty(Some(&json!(null))), "");
    }

    #[test]
    fn whitespace_and_slices_follow_js() {
        assert_eq!(collapse_js_whitespace("a \u{FEFF}\n b\u{85}c"), "a b\u{85}c");
        assert_eq!(js_trim("\u{3000} a \u{FEFF}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert_eq!(slice_utf16("ab😀c", 3), "ab");
        assert_eq!(slice_utf16("ab😀c", 4), "ab😀");
        assert_eq!(utf16_cmp("\u{FF61}", "😀"), Ordering::Greater);
    }

    #[test]
    fn math_follows_v8() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
        assert_eq!(js_hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(-0.0, 0.0).is_sign_negative());
        assert!(js_max(f64::NAN, 1.0).is_nan());
    }
}
