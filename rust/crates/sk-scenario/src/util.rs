//! Общие для трёх модулей крейта приведения JS, которых нет в `sk_core`.
//!
//! Модули сценария и ухода чистят строки своими формулами (`clean`,
//! `compact`) с `/\s+/gu`: здесь пробел JS — ровно набор `WhiteSpace` и
//! `LineTerminator` из спецификации, без U+0085, который `char::is_whitespace`
//! считает пробелом, и с U+FEFF, которого он не считает.

use std::cmp::Ordering;

use serde_json::{Map, Value};
use sk_core::js;

/// Пробельный символ `\s` и `String.prototype.trim` в JS.
pub(crate) fn is_js_ws(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000D}'
            | ' '
            | '\u{00A0}'
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

/// `text.replace(/\s+/gu, ' ').trim()`.
pub(crate) fn squash(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if is_js_ws(ch) {
            pending_space = true;
            continue;
        }
        if pending_space && !result.is_empty() {
            result.push(' ');
        }
        pending_space = false;
        result.push(ch);
    }
    result
}

/// `text.trim()` по набору пробелов JS.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_ws)
}

/// `text.slice(0, limit)` по символам.
pub(crate) fn head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Длина строки JS (`text.length`) — в единицах UTF-16.
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `String(value)`: `undefined` и `null` пишутся словами, как в шаблонной
/// строке JS; остальное — как `String(value ?? '')`.
pub(crate) fn string_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        other => js::s(other),
    }
}

/// `{ ...value }`: копия объекта; строка и массив раскладываются по индексам,
/// прочее даёт пустой объект.
pub(crate) fn spread_copy(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// Сравнение строк, как `Array.prototype.sort()` без сравнителя: по единицам UTF-16.
pub(crate) fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    }
}

/// Строгое равенство JS (`===`) для значений JSON: числа сравниваются как
/// числа (`1 === 1.0`), объекты и массивы — по ссылке, поэтому разные
/// значения здесь не равны никогда.
pub(crate) fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// Строка-значение равна строке (`value === text`).
pub(crate) fn is_str(value: Option<&Value>, text: &str) -> bool {
    value.and_then(Value::as_str) == Some(text)
}

/// Позиция совпадения в символах (`regex.exec(text)?.index`).
pub(crate) fn first_index(regex: &sk_core::fancy_regex::Regex, text: &str) -> Option<usize> {
    let found = regex.find(text).ok().flatten()?;
    Some(text[..found.start()].chars().count())
}

/// `text.split(regex)` для выражения без групп и без пустых совпадений.
pub(crate) fn split(regex: &sk_core::fancy_regex::Regex, text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(text).filter_map(Result::ok) {
        parts.push(text[last..found.start()].to_string());
        last = found.end();
    }
    parts.push(text[last..].to_string());
    parts
}

/// `text.charAt(0).toLocaleUpperCase('ru') + text.slice(1)`.
pub(crate) fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn squash_follows_js_whitespace() {
        assert_eq!(squash("  a \u{FEFF} b\n"), "a b");
        assert_eq!(squash("a\u{0085}b"), "a\u{0085}b");
        assert_eq!(string_of(None), "undefined");
        assert_eq!(string_of(Some(&json!(null))), "null");
        assert_eq!(string_of(Some(&json!(5))), "5");
        assert!(strict_eq(Some(&json!(1)), Some(&json!(1.0))));
        assert!(!strict_eq(Some(&json!({})), Some(&json!({}))));
        assert_eq!(spread_copy(Some(&json!("ab"))), json!({ "0": "a", "1": "b" }).as_object().cloned().unwrap_or_default());
    }
}
