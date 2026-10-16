//! Общие для модулей крейта приведения JS, которых нет в `sk_core`.
//!
//! Модули JS держат свои копии `text`, `integer` и `digest`; здесь они собраны
//! один раз и ведут себя ровно как копии (там, где копии различаются, — свои
//! функции в модуле).

#![allow(dead_code)] // не каждый модуль крейта зовёт все помощники

use std::cmp::Ordering;

use serde_json::Value;
use sk_core::{hash, js, text as jstext};

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
pub(crate) fn text(value: Option<&Value>, maximum: usize) -> String {
    text_str(&js::s(value), maximum)
}

/// [`text`] для готовой строки.
pub(crate) fn text_str(value: &str, maximum: usize) -> String {
    jstext::head(&jstext::squash_spaces(&jstext::nfkc(value)), maximum)
}

/// `Number.isSafeInteger(Number(value)) ? Number(value) : fallback`.
pub(crate) fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// [`integer`] с дробным запасом: запас JS не проверяет, и сумма вроде
/// `atMinutes + 360` за пределом точных целых остаётся числом `f64`.
pub(crate) fn integer_or(value: Option<&Value>, fallback: f64) -> f64 {
    if js::is_safe_integer_number(value) {
        js::number(value)
    } else {
        fallback
    }
}

/// `value?.key` — собственное поле объекта.
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `a ?? b`.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `value === expected` для строки.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// Свойства `Object.prototype`, которые `obj[key]` находит у любого объекта.
pub(crate) const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Ключ, который у любого объекта JS находит что-то унаследованное.
pub(crate) fn is_prototype_key(key: &str) -> bool {
    OBJECT_PROTOTYPE_KEYS.contains(&key)
}

/// `String(obj[key])` для унаследованного свойства `Object.prototype`:
/// текст встроенной функции или самого прототипа.
pub(crate) fn prototype_member_string(key: &str) -> String {
    match key {
        "__proto__" => "[object Object]".to_string(),
        "constructor" => "function Object() { [native code] }".to_string(),
        other => format!("function {other}() {{ [native code] }}"),
    }
}

/// `createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')`.
pub(crate) fn digest(parts: &[String]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

/// Сравнение строк по единицам UTF-16 — так сравнивают `<` и `array.sort()`.
pub(crate) fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Строка-значение JSON.
pub(crate) fn string(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

/// `ID_PATTERN.test(value)` для `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,N}$/u`.
pub(crate) fn is_safe_id(value: &str, max_rest: usize) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let mut rest = 0usize;
    for ch in chars {
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')) {
            return false;
        }
        rest += 1;
    }
    rest <= max_rest
}

/// `[...new Set(items)]` для строк: первое вхождение, порядок вставки.
pub(crate) fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// `haystack.replaceAll(needle, replacement)` со строковым образцом: замена
/// проходит `GetSubstitution` (`$$`, `$&`, `` $` ``, `$'`; групп у строкового
/// образца нет, и `$1`, `$<` остаются как есть).
pub(crate) fn replace_all_literal(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let positions: Vec<usize> = haystack.match_indices(needle).map(|(index, _)| index).collect();
    if positions.is_empty() {
        return haystack.to_string();
    }
    let mut out = String::with_capacity(haystack.len());
    let mut last = 0;
    for position in positions {
        out.push_str(&haystack[last..position]);
        let end = position + needle.len();
        let mut chars = replacement.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch != '$' {
                out.push(ch);
                continue;
            }
            match chars.peek() {
                Some('$') => {
                    out.push('$');
                    chars.next();
                }
                Some('&') => {
                    out.push_str(needle);
                    chars.next();
                }
                Some('`') => {
                    out.push_str(&haystack[..position]);
                    chars.next();
                }
                Some('\'') => {
                    out.push_str(&haystack[end..]);
                    chars.next();
                }
                _ => out.push('$'),
            }
        }
        last = end;
    }
    out.push_str(&haystack[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_all_literal_follows_get_substitution() {
        assert_eq!(replace_all_literal("a {x} b {x}", "{x}", "Y"), "a Y b Y");
        assert_eq!(replace_all_literal("a {x} b", "{x}", "$&$$"), "a {x}$ b");
        assert_eq!(replace_all_literal("a {x} b", "{x}", "[$`|$']"), "a [a | b] b");
    }

    #[test]
    fn prototype_strings() {
        assert_eq!(prototype_member_string("constructor"), "function Object() { [native code] }");
        assert_eq!(prototype_member_string("toString"), "function toString() { [native code] }");
        assert_eq!(prototype_member_string("__proto__"), "[object Object]");
    }
}
