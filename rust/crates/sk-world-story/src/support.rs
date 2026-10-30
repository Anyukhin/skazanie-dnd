//! Общие приведения JS для модулей крейта, которых нет в `sk_core`.

use serde_json::Value;
use sk_core::{js, text};

/// `value?.[key]` для объекта; у массива, строки и числа именованных полей нет.
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `value?.a?.b?.c`.
pub(crate) fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| prop(Some(current), key))
}

/// Массив или пусто: `Array.isArray(x) ? x : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `text.slice(0, max)` в единицах UTF-16. Символ вне BMP, который JS разрезал
/// бы пополам, отбрасывается целиком: половину суррогатной пары строка Rust не
/// держит.
pub(crate) fn head_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in source.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// `String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)`.
pub(crate) fn clean(value: Option<&Value>, max: usize) -> String {
    head_utf16(&text::squash_spaces(&js::s(value)), max)
}

/// `a === 'expected'`.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `a === b` над JSON: примитивы по значению, объекты и массивы — никогда.
pub(crate) fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// `value?.[0]`: элемент массива, поле `"0"` объекта, первая единица UTF-16
/// строки. Символ вне BMP строка Rust пополам не режет — он отдаётся целиком.
pub(crate) fn index0(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => items.first().cloned(),
        Value::Object(map) => map.get("0").cloned(),
        Value::String(text) => text.chars().next().map(|ch| Value::String(ch.to_string())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn head_counts_utf16_units() {
        assert_eq!(head_utf16("a😀b", 3), "a😀");
        assert_eq!(head_utf16("a😀b", 2), "a");
    }

    #[test]
    fn clean_squashes_spaces() {
        assert_eq!(clean(Some(&json!("  a \n\t b  ")), 10), "a b");
        assert_eq!(clean(Some(&json!({})), 10), "[object Ob");
        assert_eq!(clean(None, 10), "");
    }

    #[test]
    fn index0_reads_like_js() {
        assert_eq!(index0(Some(&json!(["x"]))), Some(json!("x")));
        assert_eq!(index0(Some(&json!("abc"))), Some(json!("a")));
        assert_eq!(index0(Some(&json!({"0": 5}))), Some(json!(5)));
        assert_eq!(index0(Some(&json!(7))), None);
    }
}
