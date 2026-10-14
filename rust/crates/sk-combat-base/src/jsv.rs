//! Приведения JS, которых нет в `sk_core::js`: `String(x)` с `undefined` и
//! `null`, строгое сравнение, длина и срез в единицах UTF-16, `JSON.stringify`
//! с порядком ключей и числами как в JS.

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

pub(crate) use ws;

/// `a === b` для значений JSON: примитивы по значению (числа — как `f64`),
/// объекты и массивы — разные ссылки, кроме одного и того же значения.
pub(crate) fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(a @ (Value::Array(_) | Value::Object(_))), Some(b)) => std::ptr::eq(a, b),
        _ => false,
    }
}

/// `text.slice(0, limit)` в единицах UTF-16. Суррогатную пару, которую JS
/// разрезал бы пополам, Rust не может держать — она отбрасывается целиком.
pub(crate) fn utf16_head(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut result = String::new();
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > limit {
            break;
        }
        result.push(ch);
    }
    result
}

/// Пробел по `\s` JS (WhiteSpace и LineTerminator), без U+0085.
pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(ch, '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn write_string(out: &mut String, text: &str) {
    // Экранирование `JSON.stringify` и `serde_json` совпадает: кавычка,
    // обратная косая, `\b\f\n\r\t`, прочие управляющие — `\u00xx` строчными.
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

fn write_json(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    let newline = |out: &mut String, depth: usize| {
        if let Some(step) = indent {
            out.push('\n');
            out.push_str(&" ".repeat(step * depth));
        }
    };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => out.push_str(&number_string(number)),
        Value::Number(_) => out.push_str("null"),
        Value::String(text) => write_string(out, text),
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_json(out, item, indent, depth + 1);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) if map.is_empty() => out.push_str("{}"),
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in js::entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_json(out, item, indent, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)`: ключи в порядке `Object.keys`, числа как в JS.
pub(crate) fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, indent)`.
pub(crate) fn stringify_pretty(value: &Value, indent: usize) -> String {
    let mut out = String::new();
    write_json(&mut out, value, Some(indent), 0);
    out
}
