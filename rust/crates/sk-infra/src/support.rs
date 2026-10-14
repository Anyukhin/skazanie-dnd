//! Общие помощники крейта: то, что в JS делали `JSON.stringify`, шаблонная
//! строка `${x}`, `Buffer.from(x, 'base64')`, `path.resolve`/`path.relative` и
//! `readdirSync().sort()`. Нужны, чтобы файлы на диске совпадали с теми, что
//! пишет JS, и чтобы прежние файлы читались так же.

use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use sk_core::js;

/// `JSON.stringify(value)`: числа так, как их печатает JS (`2`, а не `2.0`;
/// `1e+21`), ключи-индексы объекта — первыми по возрастанию.
pub(crate) fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub(crate) fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(2), 0);
    out
}

fn write_number(out: &mut String, number: &serde_json::Number) {
    if let Some(int) = number.as_i64() {
        out.push_str(&int.to_string());
    } else if let Some(int) = number.as_u64() {
        out.push_str(&int.to_string());
    } else {
        let float = number.as_f64().unwrap_or(f64::NAN);
        if float.is_finite() {
            out.push_str(&js::f64_string(float));
        } else {
            out.push_str("null");
        }
    }
}

fn write_string(out: &mut String, text: &str) {
    // Набор экранирования serde_json совпадает с `JSON.stringify`: кавычка,
    // обратная косая черта и управляющие символы до U+001F.
    out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()));
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(step) = indent {
        out.push('\n');
        out.push_str(&" ".repeat(step * depth));
    }
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(out, number),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in js::entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

/// Шаблонная строка `${value}` / `String(value)`: в отличие от
/// `String(value ?? '')`, отсутствующее поле — `undefined`, `null` — `null`.
pub(crate) fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(other) => js::s(Some(other)),
    }
}

/// `String(value || '')`: ложное значение — пустая строка.
pub(crate) fn string_or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        String::new()
    }
}

/// `String(value ?? '')`.
pub(crate) fn string_or_blank(value: Option<&Value>) -> String {
    js::s(value)
}

/// Поле объекта; у не-объекта полей нет (`x?.field`).
pub(crate) fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `a ?? b`.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(first) {
        first
    } else {
        second
    }
}

/// `value === text`.
pub(crate) fn strict_str(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(own)) if own == text)
}

/// `value === number` для числа JSON.
pub(crate) fn strict_number(value: Option<&Value>, number: f64) -> bool {
    matches!(value, Some(Value::Number(own)) if own.as_f64() == Some(number))
}

/// `Number(value)` с отсутствующим полем как `undefined` (`NaN`).
pub(crate) fn number(value: Option<&Value>) -> f64 {
    js::number(value)
}

/// `text.replace(/\s+/gu, ' ').trim().slice(0, maximum)` над `String(value ?? '')`.
pub(crate) fn clean_text(value: Option<&Value>, maximum: usize) -> String {
    sk_core::text::head(&sk_core::text::squash_spaces(&js::s(value)), maximum)
}

/// То же для готовой строки.
pub(crate) fn clean_str(text: &str, maximum: usize) -> String {
    sk_core::text::head(&sk_core::text::squash_spaces(text), maximum)
}

/// Длина строки в единицах UTF-16 (`text.length`).
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Сравнение строк, как у `Array.prototype.sort()` без сравнителя: по
/// единицам UTF-16.
pub(crate) fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// `Buffer.from(text, 'base64')`: снисходительный разбор Node — посторонние
/// символы пропускаются, `=` заканчивает данные, принимается и URL-алфавит,
/// неполная последняя группа даёт столько байтов, сколько успела набрать.
pub(crate) fn base64_decode_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut group = [0u8; 4];
    let mut filled = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let Some(value) = base64_value(byte) else { continue };
        group[filled] = value;
        filled += 1;
        if filled == 4 {
            out.push((group[0] << 2) | (group[1] >> 4));
            out.push((group[1] << 4) | (group[2] >> 2));
            out.push((group[2] << 6) | group[3]);
            filled = 0;
        }
    }
    if filled >= 2 {
        out.push((group[0] << 2) | (group[1] >> 4));
    }
    if filled >= 3 {
        out.push((group[1] << 4) | (group[2] >> 2));
    }
    out
}

/// Стандартный base64 с выравниванием — как `buffer.toString('base64')`.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `Buffer.from(value, 'base64')` для поля JSON: строка — base64, массив —
/// байты (`value & 255`), `{ type: 'Buffer', data: [...] }` — его байты.
/// Прочие объекты Node превращает в пустой или нулевой буфер либо отвергает
/// `TypeError`; для конверта копии исход у них один — отказ проверки, поэтому
/// здесь они — `None`.
pub(crate) fn node_buffer_from(value: Option<&Value>) -> Option<Vec<u8>> {
    fn array_bytes(items: &[Value]) -> Vec<u8> {
        items.iter().map(|item| js::to_uint32(js::number(Some(item))) as u8).collect()
    }
    match value {
        Some(Value::String(text)) => Some(base64_decode_lenient(text)),
        Some(Value::Array(items)) => Some(array_bytes(items)),
        Some(Value::Object(map)) => match (map.get("type"), map.get("data")) {
            (Some(Value::String(kind)), Some(Value::Array(items))) if kind == "Buffer" && !map.contains_key("length") => Some(array_bytes(items)),
            _ => None,
        },
        _ => None,
    }
}

/// `path.resolve(text)`: абсолютный путь от текущего каталога с лексически
/// убранными `.` и `..`; пустой путь — текущий каталог.
pub(crate) fn resolve(path: &Path) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_default();
    let joined = if path.as_os_str().is_empty() { base } else { base.join(path) };
    normalize(&joined)
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let at_root = matches!(result.components().next_back(), None | Some(Component::RootDir) | Some(Component::Prefix(_)));
                if !at_root {
                    result.pop();
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn same_component(left: &Component<'_>, right: &Component<'_>) -> bool {
    if cfg!(windows) {
        // `path.win32.relative` сравнивает без учёта регистра.
        left.as_os_str().to_string_lossy().to_lowercase() == right.as_os_str().to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

/// `path.relative(from, to)` для двух уже разрешённых путей.
pub(crate) fn relative(from: &Path, to: &Path) -> String {
    let from: Vec<Component<'_>> = from.components().collect();
    let to: Vec<Component<'_>> = to.components().collect();
    let separator = std::path::MAIN_SEPARATOR_STR;
    if cfg!(windows) {
        // Другой диск: Node отдаёт целевой путь как есть.
        let prefix = |parts: &[Component<'_>]| parts.first().filter(|part| matches!(part, Component::Prefix(_))).map(|part| part.as_os_str().to_string_lossy().to_lowercase());
        if prefix(&from) != prefix(&to) {
            return to.iter().collect::<PathBuf>().to_string_lossy().into_owned();
        }
    }
    let common = from.iter().zip(to.iter()).take_while(|(left, right)| same_component(left, right)).count();
    let mut parts: Vec<String> = Vec::new();
    for _ in common..from.len() {
        parts.push("..".into());
    }
    for part in &to[common..] {
        parts.push(part.as_os_str().to_string_lossy().into_owned());
    }
    parts.join(separator)
}

/// `path.isAbsolute(text)`.
pub(crate) fn is_absolute_text(text: &str) -> bool {
    Path::new(text).is_absolute() || (cfg!(windows) && (text.starts_with('\\') || text.starts_with('/')))
}

/// Путь строкой, как его печатает Node.
pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `openSync(path, 'wx', 0o600)`: новый файл только для владельца; занятое
/// имя — ошибка.
pub(crate) fn create_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

/// `atomicWrite(file, bytes)` из `usage-ledger.mjs` и `backup-service.mjs`:
/// временный `.<имя>.<uuid>.tmp` рядом, запись, переименование поверх; при
/// сбое временный файл убирается.
pub(crate) fn atomic_write(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let directory = file.parent().map(Path::to_path_buf).unwrap_or_default();
    std::fs::create_dir_all(&directory)?;
    let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = directory.join(format!(".{name}.{}.tmp", sk_core::hash::uuid_v4()));
    let result = (|| {
        let mut handle = create_exclusive(&temporary)?;
        handle.write_all(bytes)?;
        drop(handle);
        std::fs::rename(&temporary, file)
    })();
    if result.is_err() && temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// `readFileSync(file, 'utf8')`: неверные последовательности UTF-8 — U+FFFD.
pub(crate) fn read_utf8(file: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(file)?).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringify_matches_js() {
        let value: Value = serde_json::from_str(r#"{"b":1.0,"10":[],"2":{},"a":"т\"\n","x":[1,2.5,1e21]}"#).expect("json");
        assert_eq!(stringify(&value), r#"{"2":{},"10":[],"b":1,"a":"т\"\n","x":[1,2.5,1e+21]}"#);
        assert_eq!(stringify_pretty(&json!({"a": [1, {"b": null}], "c": {}})), "{\n  \"a\": [\n    1,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": {}\n}");
    }

    #[test]
    fn base64_is_lenient_like_node() {
        assert_eq!(base64_decode_lenient("aGVsbG8="), b"hello");
        assert_eq!(base64_decode_lenient("aGVs bG8"), b"hello");
        assert_eq!(base64_decode_lenient("aGVsbG8=AAAA"), b"hello");
        assert_eq!(base64_decode_lenient("-_8"), vec![0xfb, 0xff]);
        assert_eq!(base64_decode_lenient("QQ"), b"A");
        assert_eq!(base64_decode_lenient("Q"), b"");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn template_strings() {
        assert_eq!(template(None), "undefined");
        assert_eq!(template(Some(&Value::Null)), "null");
        assert_eq!(template(Some(&json!(5))), "5");
        assert_eq!(string_or_empty(Some(&json!(0))), "");
    }
}
