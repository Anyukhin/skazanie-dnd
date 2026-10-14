//! Общие помощники крейта: строки по правилам JS там, где `sk_core` их не
//! держит.
//!
//! JS режет строки (`slice`) и считает их длину (`length`) в единицах UTF-16,
//! индексы совпадений (`match.index`) — тоже. Модули этого крейта режут
//! описания сцен и имена жителей, поэтому считают так же: символ вне BMP —
//! две единицы. Разрезанная пополам суррогатная пара в Rust непредставима и
//! отбрасывается целиком; для словарей сцены это то же самое, что одинокий
//! суррогат в JS (он не буква и не пробел).

use serde::Serializer;
use serde_json::Value;
use sk_core::{js, re, text};

/// `String(value)`: `undefined` — `"undefined"`, `null` — `"null"`, число —
/// как его печатает JS, массив — элементы через запятую.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Number(number)) => js::f64_string(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => js::s(Some(other)),
    }
}

/// `String(value ?? '')`.
pub(crate) fn str_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    }
}

/// `a ?? b` для полей JSON: первое не `null` и не отсутствующее.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// Поле `value?.[key]`; `null` в поле — `Some(Null)`, как в JS.
pub(crate) fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// Длина строки в единицах UTF-16 (`text.length`).
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, limit)` в единицах UTF-16.
pub(crate) fn utf16_head(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > limit {
            return &text[..index];
        }
    }
    text
}

/// Начало `text.slice(Math.max(0, at - units), at)` как байтовый индекс;
/// `at` — байтовый индекс конца.
pub(crate) fn utf16_back(text: &str, at: usize, units: usize) -> usize {
    let mut taken = 0;
    let mut start = at;
    for (index, ch) in text[..at].char_indices().rev() {
        taken += ch.len_utf16();
        if taken > units {
            break;
        }
        start = index;
    }
    start
}

/// `/\p{L}/u.test(ch)`.
pub(crate) fn is_letter(ch: char) -> bool {
    let mut buffer = [0u8; 4];
    text::test(re!(r"^\p{L}$", "u"), ch.encode_utf8(&mut buffer))
}

/// `at > 0 && /\p{L}/u.test(source[at - 1])`: единица UTF-16 перед
/// совпадением — буква. Половина суррогатной пары буквой не бывает.
pub(crate) fn letter_before(source: &str, at: usize) -> bool {
    source[..at].chars().next_back().is_some_and(|ch| ch.len_utf16() == 1 && is_letter(ch))
}

/// `text.split(regex)` для выражения, которое не совпадает с пустой строкой.
pub(crate) fn split_regex<'a>(regex: &sk_core::fancy_regex::Regex, text: &'a str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(text) {
        let Ok(found) = found else { break };
        if found.end() == found.start() {
            continue;
        }
        parts.push(&text[last..found.start()]);
        last = found.end();
    }
    parts.push(&text[last..]);
    parts
}

/// `Math.max(a, b)`: `NaN` заразен.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: `NaN` заразен.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Number(x) || 0`.
pub(crate) fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_nan() {
        0.0
    } else {
        number
    }
}

/// Свойства `Object.prototype`: обращение `object[key]` к обычному объекту JS
/// по такому ключу находит функцию (или сам прототип), а не `undefined`.
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

/// Методы `Array.prototype` (кроме `length` и индексов): `array[key]` — функция.
const ARRAY_PROTOTYPE_KEYS: [&str; 39] = [
    "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast",
    "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf",
    "map", "pop", "push", "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice",
    "toLocaleString", "toReversed", "toSorted", "toSpliced", "toString", "unshift", "values", "with",
    "constructor",
];

/// Ключ, по которому обычный объект JS находит унаследованное свойство.
pub(crate) fn is_prototype_key(key: &str) -> bool {
    OBJECT_PROTOTYPE_KEYS.contains(&key)
}

/// `Boolean(container[key])` для объекта или массива из JSON, с учётом
/// унаследованных свойств JS (`frames.constructor` — функция, истинна).
pub(crate) fn js_index_truthy(container: &Value, key: &str) -> bool {
    match container {
        Value::Object(map) => match map.get(key) {
            Some(value) => js::truthy(Some(value)),
            None => is_prototype_key(key),
        },
        Value::Array(items) => {
            if js::is_array_index_key(key) {
                return key.parse::<usize>().ok().and_then(|index| items.get(index)).is_some_and(|value| js::truthy(Some(value)));
            }
            if key == "length" {
                return !items.is_empty();
            }
            ARRAY_PROTOTYPE_KEYS.contains(&key) || is_prototype_key(key)
        }
        _ => false,
    }
}

/// Корень репозитория — аналог путей JS от `import.meta.url` модуля
/// (`new URL('../public/…', import.meta.url)`): каталог сборки крейта на три
/// уровня выше (`rust/crates/sk-scene-base` → корень).
pub(crate) fn repo_root() -> std::path::PathBuf {
    let mut root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..3 {
        root.pop();
    }
    root
}

/// Число в JSON так, как его записал бы `JSON.stringify` (для `serialize_with`).
pub(crate) fn ser_js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&js::num(*value), serializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_slicing_counts_surrogate_pairs() {
        assert_eq!(utf16_len("a😀b"), 4);
        assert_eq!(utf16_head("a😀b", 2), "a");
        assert_eq!(utf16_head("a😀b", 3), "a😀");
        let text = "ab😀cd";
        let at = text.find('d').expect("d");
        assert_eq!(&text[utf16_back(text, at, 2)..at], "c");
        assert_eq!(&text[utf16_back(text, at, 3)..at], "😀c");
        assert_eq!(&text[utf16_back(text, at, 64)..at], "ab😀c");
    }

    #[test]
    fn js_string_follows_js() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&json!(null))), "null");
        assert_eq!(js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(js_string(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(js_string(Some(&json!({}))), "[object Object]");
        assert_eq!(str_of(Some(&json!(null))), "");
    }

    #[test]
    fn prototype_lookups_follow_js() {
        assert!(js_index_truthy(&json!({}), "constructor"));
        assert!(!js_index_truthy(&json!({ "a": 0 }), "a"));
        assert!(js_index_truthy(&json!([0, 1]), "1"));
        assert!(js_index_truthy(&json!([]), "map"));
        assert!(!js_index_truthy(&json!([]), "length"));
    }
}
