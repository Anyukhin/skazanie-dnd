//! Приведения JS, которых нет в `sk_core::js` или которые там приблизительны.
//!
//! - `String(x)` для чисел: `sk_core::js::s` печатает дробь через `f64::to_string`
//!   (`1e21` → `1000000000000000000000`), а JS — `1e+21`. Здесь число всегда
//!   печатается через [`sk_core::js::f64_string`], как `Number.prototype.toString`.
//! - `JSON.stringify`: `serde_json` пишет `3.0` для дробного нуля после точки и
//!   `1e21` без знака; JS — `3` и `1e+21`, и ключи-индексы объекта у него идут
//!   первыми. От точной строки зависит хеш проекции и файл реестра уточнений.
//! - `text.replace('строка', замена)`: замена в JS понимает `$&`, `` $` ``,
//!   `$'` и `$$` даже при строковом образце.
//! - Сравнение строк по единицам UTF-16 (`Array.prototype.sort()`) и длина
//!   `text.length`.

use std::cmp::Ordering;

use serde_json::{Number, Value};
use sk_core::js;

/// `String(number)` для числа JSON — так, как печатает JS (через `f64`).
pub fn number_string(number: &Number) -> String {
    js::f64_string(number.as_f64().unwrap_or(f64::NAN))
}

/// `String(value ?? '')`. Массив — как `Array.prototype.join(',')`: `null`
/// внутри даёт пустую строку.
pub fn string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number_string(number),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items.iter().map(|item| string(Some(item))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(value)` без `?? ''`: отсутствующее поле — `"undefined"`, `null` — `"null"`.
pub fn string_strict(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        other => string(other),
    }
}

/// `JSON.stringify(value)` байт в байт: числа как в JS, ключи объекта в
/// порядке `Object.keys` (индексы — первыми), экранирование строк как у V8.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_string(text: &str, out: &mut String) {
    // Экранирование `serde_json` совпадает с JSON.stringify: `\"`, `\\`, `\b`,
    // `\f`, `\n`, `\r`, `\t`, прочие управляющие — `\u00xx` строчными цифрами.
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let float = number.as_f64().unwrap_or(f64::NAN);
            if float.is_finite() {
                out.push_str(&js::f64_string(float));
            } else {
                out.push_str("null");
            }
        }
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in js::entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// `haystack.replace(pattern, replacement)` со строковым образцом: первое
/// вхождение, замена по правилам `GetSubstitution` (`$$`, `$&`, `` $` ``, `$'`;
/// `$1` и `$<name>` остаются как есть — групп у строкового образца нет).
pub fn replace_first_str(haystack: &str, pattern: &str, replacement: &str) -> String {
    let Some(position) = haystack.find(pattern) else {
        return haystack.to_string();
    };
    let before = &haystack[..position];
    let after = &haystack[position + pattern.len()..];
    let mut out = String::with_capacity(haystack.len() + replacement.len());
    out.push_str(before);
    let mut chars = replacement.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            Some('$') => {
                chars.next();
                out.push('$');
            }
            Some('&') => {
                chars.next();
                out.push_str(pattern);
            }
            Some('`') => {
                chars.next();
                out.push_str(before);
            }
            Some('\'') => {
                chars.next();
                out.push_str(after);
            }
            _ => out.push('$'),
        }
    }
    out.push_str(after);
    out
}

/// Сериализатор `f64` для `#[serde(serialize_with = …)]`: целое пишется без
/// `.0`, как его записал бы `JSON.stringify`.
pub fn serialize_js_number<S: serde::Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&js::num(*value), serializer)
}

/// Сравнение строк, как `Array.prototype.sort()` без сравнителя: по единицам UTF-16.
pub fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `text.length` — в единицах UTF-16.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_prints_numbers_like_js() {
        assert_eq!(string(Some(&json!(3.0))), "3");
        assert_eq!(string(Some(&json!(1e21))), "1e+21");
        assert_eq!(string(Some(&json!(1.5e-7))), "1.5e-7");
        assert_eq!(string(Some(&json!([1, null, [2, 3], "a"]))), "1,,2,3,a");
        assert_eq!(string_strict(None), "undefined");
        assert_eq!(string_strict(Some(&Value::Null)), "null");
    }

    #[test]
    fn stringify_matches_v8() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2.0,"a":[1e21,-0,0.1,"\u0001\"\n"],"2":null}"#).expect("json");
        assert_eq!(stringify(&value), r#"{"2":null,"10":2,"b":1,"a":[1e+21,0,0.1,"\u0001\"\n"]}"#);
    }

    #[test]
    fn replace_follows_get_substitution() {
        assert_eq!(replace_first_str("{a} и {a}", "{a}", "x"), "x и {a}");
        assert_eq!(replace_first_str("<{a}>", "{a}", "[$&|$`|$'|$$|$1]"), "<[{a}|<|>|$|$1]>");
        assert_eq!(replace_first_str("abc", "z", "y"), "abc");
        assert_eq!(replace_first_str("abc", "", "-"), "-abc");
    }

    #[test]
    fn utf16_order_differs_from_code_points() {
        // U+FF61 больше U+1F600 по кодовым точкам, но меньше по UTF-16 (суррогат D83D).
        assert_eq!(utf16_cmp("\u{1F600}", "\u{FF61}"), Ordering::Less);
        assert_eq!(utf16_len("\u{1F600}"), 2);
    }
}
