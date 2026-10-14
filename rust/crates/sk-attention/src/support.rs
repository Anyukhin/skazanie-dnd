//! Общие приведения JS для модулей крейта, которых нет в `sk_core`.

use serde_json::{Map, Value};
use sk_core::{js, text};

/// `value?.[key]` для объекта; у массива, строки и числа именованных полей нет.
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `a ?? b`.
pub(crate) fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

/// Массив или пусто: `Array.isArray(x) ? x : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// Длина строки в единицах UTF-16 (`text.length`).
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` в единицах UTF-16. Символ вне BMP, который JS разрезал
/// бы пополам, отбрасывается целиком: половину суррогатной пары строка Rust не
/// держит.
pub(crate) fn head_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
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

/// `a === b` над JSON: строки, числа, логические и `null` — по значению,
/// объекты и массивы — по ссылке (то есть никогда), `undefined === undefined`.
pub(crate) fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// Значение строкой равно `expected` (`value === 'expected'`).
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// Объект JS из пар в порядке создания свойств: ключи-индексы (`"0"`, `"12"`)
/// идут первыми по возрастанию, остальные — в порядке создания. Повтор ключа
/// меняет значение на месте.
pub(crate) fn js_object(entries: impl IntoIterator<Item = (String, Value)>) -> Map<String, Value> {
    let mut ordered = Map::new();
    for (key, value) in entries {
        ordered.insert(key, value);
    }
    let mut indexed: Vec<(String, Value)> = Vec::new();
    let mut named: Vec<(String, Value)> = Vec::new();
    for (key, value) in ordered {
        if js::is_array_index_key(&key) {
            indexed.push((key, value));
        } else {
            named.push((key, value));
        }
    }
    indexed.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indexed.into_iter().chain(named).collect()
}

/// Скопировать поле, если оно есть: `undefined` в JSON не попадает.
pub(crate) fn insert_raw(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.to_string(), value.clone());
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
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn object_order_puts_indices_first() {
        let map = js_object([("b".to_string(), json!(1)), ("10".to_string(), json!(2)), ("2".to_string(), json!(3)), ("b".to_string(), json!(4))]);
        assert_eq!(Value::Object(map).to_string(), r#"{"2":3,"10":2,"b":4}"#);
    }
}
