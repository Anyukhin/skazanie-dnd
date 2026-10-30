//! Приведения JS, общие для модулей крейта и отсутствующие в `sk_core::js`:
//! `x?.[key]`, `??`, SameValueZero для `Set` и `includes` (с `undefined`),
//! ключи `Object.prototype`.

use serde_json::{Map, Value};
use sk_core::js;

/// Значение, если оно не `null`/`undefined` (левая часть `a ?? b`).
pub(crate) fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `value?.[key]`: поле объекта или элемент массива по ключу-индексу; у
/// строки, числа и булева значения своих полей с такими именами нет.
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(map) => map.get(key),
        Value::Array(items) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// SameValueZero для JSON с `undefined` (`None`): объекты и массивы равны
/// только самим себе, а у разобранного JSON общих ссылок нет.
pub(crate) fn same_value_zero(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// `list.includes(value)`.
pub(crate) fn includes(list: &[Value], value: &Value) -> bool {
    list.iter().any(|entry| same_value_zero(Some(entry), Some(value)))
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

/// Вставить поле, если оно есть: `{ key: value }`, где `undefined` в JSON не
/// попадает, а `null` — попадает.
pub(crate) fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}
