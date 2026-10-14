//! Общие помощники крейта: приведения JS, которых нет в `sk_core::js`, или
//! которые там считают строку в символах, а не в единицах UTF-16.

use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};
use sk_core::js;

/// Поле объекта; у не-объекта полей нет (`x?.field`).
pub(crate) fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// Поле по цепочке `a?.b?.c`.
pub(crate) fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| field(current, key))
}

/// `a ?? b`.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(first) {
        first
    } else {
        second
    }
}

/// `a ?? b ?? c …`: первое значение не `null`/`undefined`.
pub(crate) fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::present(*value)).flatten()
}

/// `(value ?? [])` для массива: не-массив — пусто.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// Шаблонная строка `${value}` и `String(value)`: отсутствующее поле —
/// `undefined`, `null` — `null`, число — как его печатает JS.
pub(crate) fn template(value: Option<&Value>) -> String {
    sk_narration_base::jsx::string_strict(value)
}

/// `String(value ?? '')` с числами, как их печатает JS.
pub(crate) fn string(value: Option<&Value>) -> String {
    sk_narration_base::jsx::string(value)
}

/// `text.slice(0, limit)` в единицах UTF-16, как JS. Если граница режет пару
/// суррогатов, JS оставляет одинокую половину; в строке Rust её нет, и на её
/// месте остаётся U+FFFD — то же, во что Node превращает одинокую половину при
/// записи UTF-8 (`createHash().update`, `Buffer.byteLength`).
pub(crate) fn utf16_head(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            if units < limit {
                out.push('\u{FFFD}');
            }
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// Конец `array.slice(0, end)` для числа JS: `NaN` — 0, отрицательное —
/// от конца, дробь отбрасывается.
pub(crate) fn slice_end(length: usize, end: f64) -> usize {
    if end.is_nan() {
        return 0;
    }
    let end = end.trunc();
    if end < 0.0 {
        (length as f64 + end).max(0.0) as usize
    } else {
        end.min(length as f64) as usize
    }
}

/// Объект с ключами в порядке перечисления JS: ключи-индексы (`"0"`, `"12"`)
/// раньше прочих. JS держит такой порядок у любого объекта, а `serde_json`
/// пишет ключи в порядке вставки — без перестановки `JSON.stringify` и
/// `serde_json::to_string` разошлись бы на объектах из ключей игрока.
pub(crate) fn js_ordered(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|key| js::is_array_index_key(key)) {
        return map;
    }
    js::entries(&map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect()
}

/// `{ ...value }` для объекта из входа: копия в порядке перечисления JS;
/// не-объект — пустой объект.
pub(crate) fn own_entries(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => js_ordered(map.clone()),
        _ => Map::new(),
    }
}

/// `{ ...base, ...patch }` с порядком ключей JS.
pub(crate) fn spread(base: Option<&Value>, patch: Value) -> Value {
    let mut result = own_entries(base);
    if let Value::Object(patch) = patch {
        for (key, value) in patch {
            result.insert(key, value);
        }
    }
    Value::Object(js_ordered(result))
}

/// `path.resolve(...parts)`: абсолютный путь от текущего каталога с
/// лексически убранными `.` и `..`.
pub(crate) fn resolve_path(path: &Path) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_default();
    let joined = if path.as_os_str().is_empty() { base } else { base.join(path) };
    let mut result = PathBuf::new();
    for component in joined.components() {
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

/// Путь строкой, как его печатает Node.
pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum)`
/// — общая чистка публичного текста портретов и иллюстраций.
pub(crate) fn image_text(value: Option<&Value>, maximum: usize) -> String {
    let raw = string(value);
    let without_controls: String = raw.chars().map(|ch| if ch <= '\u{1f}' || ch == '\u{7f}' { ' ' } else { ch }).collect();
    utf16_head(&sk_core::text::squash_spaces(&without_controls), maximum)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_head_counts_like_js() {
        assert_eq!(utf16_head("привет", 3), "при");
        assert_eq!(utf16_head("a😀b", 3), "a😀");
        assert_eq!(utf16_head("a😀b", 2), "a\u{FFFD}");
        assert_eq!(utf16_head("a😀b", 1), "a");
    }

    #[test]
    fn slice_end_follows_js() {
        assert_eq!(slice_end(5, 2.0), 2);
        assert_eq!(slice_end(5, -1.0), 4);
        assert_eq!(slice_end(5, f64::NAN), 0);
        assert_eq!(slice_end(5, 9.0), 5);
        assert_eq!(slice_end(5, 1.7), 1);
    }

    #[test]
    fn spread_puts_index_keys_first() {
        let result = spread(Some(&json!({ "b": 1, "a": 2 })), json!({ "0": 3, "b": 4 }));
        assert_eq!(serde_json::to_string(&result).expect("json"), r#"{"0":3,"b":4,"a":2}"#);
    }

    #[test]
    fn image_text_cleans_controls_and_spaces() {
        assert_eq!(image_text(Some(&json!("  a\u{0}\tb\u{7f}  c ")), 10), "a b c");
        assert_eq!(image_text(Some(&json!(5)), 10), "5");
        assert_eq!(image_text(None, 10), "");
        assert_eq!(image_text(Some(&json!("abcdef")), 3), "abc");
    }
}
