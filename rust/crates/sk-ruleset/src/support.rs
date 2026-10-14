//! Приведения JS, общие для модулей крейта и отсутствующие в `sk_core::js`:
//! строгий `String(x)`, `x?.[key]`, `new Set(...)` по SameValueZero, порядок
//! ключей объекта и `slice(0, n)` с числом JS.

use serde_json::{Map, Value};
use sk_core::js;

/// `String(value)` без `?? ''`: отсутствующее — `"undefined"`, `null` — `"null"`.
pub(crate) fn string_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(other) => js::s(Some(other)),
    }
}

/// Значение, если оно не `null`/`undefined` (левая часть `a ?? b`).
pub(crate) fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `value?.[key]`: поле объекта или элемент массива по ключу-индексу.
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(map) => map.get(key),
        Value::Array(items) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `value?.a?.b?.c`.
pub(crate) fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in keys {
        current = prop(current, key);
    }
    current
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `[...value]` для массива и строки (строка распадается на символы); прочее
/// в JS бросило бы `TypeError` — здесь пусто.
pub(crate) fn spread_items(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// SameValueZero для JSON (`Set`, `includes`): объекты и массивы равны только
/// самим себе, а у разобранного JSON общих ссылок нет.
pub(crate) fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

/// `list.includes(value)`.
pub(crate) fn includes(list: &[Value], value: &Value) -> bool {
    list.iter().any(|entry| same_value_zero(entry, value))
}

/// `list.includes(text)` для строки.
pub(crate) fn includes_str(list: &[Value], text: &str) -> bool {
    list.iter().any(|entry| entry.as_str() == Some(text))
}

/// `[...new Set(values)]`.
pub(crate) fn unique_values(values: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for value in values {
        if !includes(&result, &value) {
            result.push(value);
        }
    }
    result
}

/// `[...new Set(strings)]`.
pub(crate) fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

/// Длина `list.slice(0, end)` при `end` — числе JS (`NaN` → 0, отрицательное —
/// от конца).
pub(crate) fn slice_len(len: usize, end: f64) -> usize {
    if end.is_nan() {
        return 0;
    }
    let end = end.trunc();
    if end < 0.0 {
        (len as f64 + end).max(0.0) as usize
    } else {
        end.min(len as f64) as usize
    }
}

/// Объект в порядке ключей JS: ключи-индексы по возрастанию впереди, прочие —
/// в порядке вставки (`Object.fromEntries` с вычисляемыми ключами).
pub(crate) fn js_ordered(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|key| js::is_array_index_key(key)) {
        return map;
    }
    let order: Vec<String> = js::keys(&map).into_iter().cloned().collect();
    let mut source = map;
    let mut result = Map::new();
    for key in order {
        if let Some(value) = source.remove(&key) {
            result.insert(key, value);
        }
    }
    result
}

/// Рекурсивно привести порядок ключей к JS — для данных, прочитанных из
/// JSON-файла: `JSON.parse` ставит ключи-индексы впереди.
pub(crate) fn js_ordered_deep(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let map = js_ordered(map.into_iter().map(|(key, value)| (key, js_ordered_deep(value))).collect());
            Value::Object(map)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(js_ordered_deep).collect()),
        other => other,
    }
}

/// Разобрать встроенный JSON из `data/`. Файлы проверены тестами, поэтому
/// ошибка разбора — дефект сборки, а не данных игрока.
pub(crate) fn embedded_json(source: &str) -> Value {
    js_ordered_deep(serde_json::from_str(source).unwrap_or(Value::Null))
}

/// Массив строк в JSON.
pub(crate) fn str_array<S: AsRef<str>>(items: &[S]) -> Value {
    Value::Array(items.iter().map(|item| Value::String(item.as_ref().to_string())).collect())
}

/// `{ ...base, ...patch }`: поля `patch` перекрывают `base`, существующий ключ
/// остаётся на своём месте.
pub(crate) fn spread_into(target: &mut Map<String, Value>, source: Option<&Value>) {
    if let Some(Value::Object(source)) = source {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slice_len_follows_js() {
        assert_eq!(slice_len(5, 2.0), 2);
        assert_eq!(slice_len(5, 9.0), 5);
        assert_eq!(slice_len(5, -1.0), 4);
        assert_eq!(slice_len(5, f64::NAN), 0);
        assert_eq!(slice_len(5, 2.7), 2);
    }

    #[test]
    fn ordered_puts_index_keys_first() {
        let map = json!({ "b": 1, "10": 2, "3": 3 }).as_object().cloned().unwrap_or_default();
        let ordered: Vec<String> = js_ordered(map).keys().cloned().collect();
        assert_eq!(ordered, ["3", "10", "b"]);
        assert_eq!(string_of(None), "undefined");
        assert_eq!(string_of(Some(&Value::Null)), "null");
        assert_eq!(unique_values(vec![json!("a"), json!("a"), json!({}), json!({})]).len(), 3);
    }
}
