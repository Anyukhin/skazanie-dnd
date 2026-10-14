//! Приведения JS, которых нет в `sk_core::js`: `String(x)` с `undefined` и
//! `null`, шаблонная строка `${x || '…'}`, строгое сравнение, длина в
//! единицах UTF-16.

use serde_json::Value;
use sk_core::{js, text};

/// `String(value)`: `undefined` → `"undefined"`, `null` → `"null"`.
pub(crate) fn string_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Number(number)) => number_string(number),
        Some(other) => js::s(Some(other)),
    }
}

/// Число так, как его печатает `String(number)`.
pub(crate) fn number_string(number: &serde_json::Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    if let Some(int) = number.as_u64() {
        return int.to_string();
    }
    js::f64_string(number.as_f64().unwrap_or(f64::NAN))
}

/// `${value || fallback}`.
pub(crate) fn or_text(value: Option<&Value>, fallback: &str) -> String {
    if js::truthy(value) {
        string_of(value)
    } else {
        fallback.to_string()
    }
}

/// `typeof value === 'string' && value.trim()` — непустая строка.
pub(crate) fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) if !text::trim(text).is_empty() => Some(text.as_str()),
        _ => None,
    }
}

/// `value === expected` для строки.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `value === expected` для числа.
pub(crate) fn is_number(value: Option<&Value>, expected: f64) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64() == Some(expected))
}

/// `Number.isInteger(value)` без приведения.
pub(crate) fn is_integer(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64().is_some_and(|f| f.is_finite() && f.fract() == 0.0))
}

/// `value && typeof value === 'object'` (массив тоже объект).
pub(crate) fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)) | Some(Value::Array(_)))
}

/// `a ?? b`: `undefined` — `None`, `null` — `Some(Null)`.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// Длина строки в единицах UTF-16 (`text.length`).
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Поле объекта или элемент массива по строковому ключу (`value[key]`).
pub(crate) fn member<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        Some(Value::Array(items)) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// Строки по `/\r?\n/`: перевод строки и стоящий перед ним `\r`.
pub(crate) fn split_lines(source: &str) -> Vec<&str> {
    let pieces: Vec<&str> = source.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .into_iter()
        .enumerate()
        .map(|(index, piece)| if index < last { piece.strip_suffix('\r').unwrap_or(piece) } else { piece })
        .collect()
}

/// Сообщение ошибки чтения файла в духе Node (`ENOENT: no such file …`).
pub(crate) fn io_message(error: &std::io::Error, path: &std::path::Path) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{}'", path.display()),
        _ => format!("{error}, open '{}'", path.display()),
    }
}

/// Пробел JS (`\s`): WhiteSpace и LineTerminator. В `regex` у `\s` другой
/// набор (есть U+0085, нет U+FEFF), поэтому класс выписан явно.
macro_rules! ws {
    () => {
        r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"
    };
}

/// Точка JS без флага `s`: любой символ, кроме концов строк.
macro_rules! dot {
    () => {
        r"[^\n\r\x{2028}\x{2029}]"
    };
}

pub(crate) use {dot, ws};
