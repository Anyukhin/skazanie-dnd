//! Общие для модулей крейта приведения JS, которых нет в `sk_core`.
//!
//! Каждый из трёх JS-модулей держит свои копии `text`, `integer` и `digest`;
//! здесь они собраны один раз и ведут себя ровно как каждая из копий (там, где
//! копии различаются, — отдельные функции с пометкой, чья это копия).

use std::cmp::Ordering;

use serde_json::{Map, Value};
use sk_core::{hash, js, text as jstext};

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
pub(crate) fn text(value: Option<&Value>, maximum: usize) -> String {
    text_str(&js::s(value), maximum)
}

/// [`text`] для готовой строки.
pub(crate) fn text_str(value: &str, maximum: usize) -> String {
    jstext::head(&jstext::squash_spaces(&jstext::nfkc(value)), maximum)
}

/// `text(value, 180).toLocaleLowerCase('ru')`.
pub(crate) fn comparable(value: Option<&Value>) -> String {
    jstext::lower(&text(value, 180))
}

/// `Number.isSafeInteger(Number(value)) ? Number(value) : fallback`.
pub(crate) fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// `Number.isSafeInteger(Number(value))`, и тогда — само число.
pub(crate) fn safe_integer(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer_number(value).then(|| js::number(value) as i64)
}

/// `Math.max(a, b)` с заразным `NaN`, как в JS.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)` с заразным `NaN`, как в JS.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// Число JS как промежуточное значение JSON, которое потом снова читает
/// `integer(...)`. Конечное — обычное число; `NaN` и бесконечность —
/// строки `"NaN"`/`"Infinity"`: `Number()` даёт из них то же нечисло, а
/// `null` дал бы ноль (`Number(null) === 0`) и разошёлся бы с JS.
pub(crate) fn f64_value(value: f64) -> Value {
    if value.is_finite() {
        js::num(value)
    } else {
        Value::String(js::f64_string(value))
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

/// `[...value]`: массив — его элементы, строка — символы. Прочее в JS бросает
/// `TypeError`; здесь — пусто.
pub(crate) fn iterate(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// `{ ...value }`: собственные перечислимые поля в порядке JS (у строки и
/// массива — индексы, у примитива — ничего).
pub(crate) fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
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

/// Что находит `obj[key]` у объекта JSON.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Member<'a> {
    /// Собственное поле.
    Own(&'a Value),
    /// Унаследованное от `Object.prototype` (функция или сам прототип):
    /// истинное значение без собственных данных.
    Inherited,
    /// `undefined`.
    Missing,
}

/// `obj[key]` по правилам JS для объекта-словаря.
pub(crate) fn member<'a>(value: Option<&'a Value>, key: &str) -> Member<'a> {
    match value {
        Some(Value::Object(map)) => match map.get(key) {
            Some(found) => Member::Own(found),
            None if is_prototype_key(key) => Member::Inherited,
            None => Member::Missing,
        },
        _ => Member::Missing,
    }
}

/// `createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')`.
pub(crate) fn digest(parts: &[String]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

/// `Number.parseInt(digest(...).slice(0, 8), 16)`.
pub(crate) fn digest_u32(parts: &[String]) -> u64 {
    u64::from_str_radix(&digest(parts)[..8], 16).unwrap_or(0)
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

/// SameValueZero (`includes`, `Set`) для значений JSON: у объектов и
/// массивов совпадает только ссылка, а из JSON двух одинаковых ссылок не бывает.
pub(crate) fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => false,
    }
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

/// `value + 1` по правилам JS (сложение со строкой — склейка).
pub(crate) fn js_plus_one(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => string(format!("{text}1")),
        Some(Value::Array(_)) | Some(Value::Object(_)) => string(format!("{}1", js::s(value))),
        other => f64_value(js::number(other) + 1.0),
    }
}

/// `value.length` у массива или строки (UTF-16), у объекта — его поле
/// `length` числом; у прочего — `NaN`.
pub(crate) fn js_length(value: &Value) -> f64 {
    match value {
        Value::Array(items) => items.len() as f64,
        Value::String(text) => text.encode_utf16().count() as f64,
        Value::Object(map) => js::number(map.get("length")),
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replace_all_literal_follows_get_substitution() {
        assert_eq!(replace_all_literal("a {x} b {x}", "{x}", "Y"), "a Y b Y");
        assert_eq!(replace_all_literal("a {x} b", "{x}", "$&$$"), "a {x}$ b");
        assert_eq!(replace_all_literal("a {x} b", "{x}", "[$`|$']"), "a [a | b] b");
        assert_eq!(replace_all_literal("{x}", "{x}", "$1$<n>$"), "$1$<n>$");
    }

    #[test]
    fn plus_one_like_js() {
        assert_eq!(js_plus_one(Some(&json!(2))), json!(3));
        assert_eq!(js_plus_one(Some(&json!("2"))), json!("21"));
        assert_eq!(js_plus_one(Some(&Value::Null)), json!(1));
        assert_eq!(js_plus_one(None), json!("NaN"));
        assert_eq!(js_plus_one(Some(&json!([1, 2]))), json!("1,21"));
    }

    #[test]
    fn safe_id_pattern() {
        assert!(is_safe_id("captive:abc", 119));
        assert!(!is_safe_id(":abc", 119));
        assert!(!is_safe_id("a b", 119));
        assert!(!is_safe_id("", 119));
        assert!(is_safe_id(&"a".repeat(120), 119));
        assert!(!is_safe_id(&"a".repeat(121), 119));
    }
}
