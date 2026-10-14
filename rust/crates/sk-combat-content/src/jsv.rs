//! Приведения JS, общие для модулей крейта и отсутствующие в `sk_core::js`:
//! `x?.[key]`, `a ?? b`, строгое сравнение, `includes` по SameValueZero,
//! порядок ключей объекта (индексы — первыми, как у объекта JS) и
//! `JSON.stringify` байт в байт.

use serde_json::{Map, Value};
use sk_core::js;

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

/// Левая часть `a ?? b`: значение, если оно не `null`/`undefined`.
pub(crate) fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `a ?? b`.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    defined(first).or(second)
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `[...(value ?? [])]` для массива и строки (строка распадается на символы).
/// Прочее в JS бросило бы `TypeError`; здесь — пусто (см. отчёт переноса).
pub(crate) fn spread_items(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// `value === expected` для строки.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `value === expected` для числа.
pub(crate) fn is_num(value: Option<&Value>, expected: f64) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64() == Some(expected))
}


/// `String(value)` без `?? ''`.
pub(crate) fn string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Number(number)) => js::f64_string(number.as_f64().unwrap_or(f64::NAN)),
        other => s(other),
    }
}

/// `String(value ?? '')` с числом, напечатанным как в JS.
pub(crate) fn s(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => js::f64_string(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(items)) => items.iter().map(|item| if item.is_null() { String::new() } else { s(Some(item)) }).collect::<Vec<_>>().join(","),
        other => js::s(other),
    }
}

/// SameValueZero для JSON: объекты и массивы равны только самим себе, а у
/// разных источников JSON общих ссылок нет.
pub(crate) fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

/// `a === b` для полей JSON: `undefined` равен только `undefined`, объекты и
/// массивы — только самим себе.
pub(crate) fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => same_value_zero(left, right),
        _ => false,
    }
}

/// `list.includes(value)` по SameValueZero.
pub(crate) fn includes(list: &[Value], value: &Value) -> bool {
    list.iter().any(|item| same_value_zero(item, value))
}

/// `list.includes('text')`.
pub(crate) fn includes_str(list: &[Value], text: &str) -> bool {
    list.iter().any(|item| item.as_str() == Some(text))
}

/// `value?.length` для массива и строки (в единицах UTF-16).
pub(crate) fn length(value: Option<&Value>) -> Option<usize> {
    match value? {
        Value::Array(items) => Some(items.len()),
        Value::String(text) => Some(text.chars().map(char::len_utf16).sum()),
        _ => None,
    }
}

/// Объект в порядке ключей JS: сначала ключи-индексы по возрастанию, затем
/// прочие в порядке вставки.
pub(crate) fn js_ordered(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|key| js::is_array_index_key(key)) {
        return map;
    }
    let mut indexed: Vec<(String, Value)> = Vec::new();
    let mut rest: Vec<(String, Value)> = Vec::new();
    for (key, value) in map {
        if js::is_array_index_key(&key) {
            indexed.push((key, value));
        } else {
            rest.push((key, value));
        }
    }
    indexed.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indexed.into_iter().chain(rest).collect()
}

/// [`js_ordered`] на всех уровнях вложенности — как объект после `JSON.parse`.
pub(crate) fn js_ordered_deep(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(js_ordered(map).into_iter().map(|(key, value)| (key, js_ordered_deep(value))).collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(js_ordered_deep).collect()),
        other => other,
    }
}

/// Встроенный JSON, разобранный как `JSON.parse`.
pub(crate) fn embedded_json(source: &str) -> Value {
    js_ordered_deep(serde_json::from_str(source).expect("встроенный JSON"))
}

/// `{ ...target, ...source }` на месте; `source` не объект — без изменений.
pub(crate) fn spread_into(target: &mut Map<String, Value>, source: Option<&Value>) {
    if let Some(Value::Object(source)) = source {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}


/// `JSON.stringify(value)` байт в байт.
pub(crate) fn stringify(value: &Value) -> String {
    sk_narration_base::jsx::stringify(value)
}

/// Число в JSON так, как его записал бы `JSON.stringify`.
pub(crate) fn num(value: f64) -> Value {
    js::num(value)
}

/// Индекс таблицы по уровню JS: `table[level]` существует, только если
/// уровень — целое неотрицательное число.
pub(crate) fn table_index(level: f64) -> Option<usize> {
    (level.is_finite() && level >= 0.0 && level.fract() == 0.0).then_some(level as usize)
}

/// `Math.max(a, b)` с заразным `NaN`.
pub(crate) fn max2(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

/// `Math.min(a, b)` с заразным `NaN`.
pub(crate) fn min2(a: f64, b: f64) -> f64 {
    js::min_of([a, b])
}

/// `Number(value) || fallback`: `NaN` и ноль — запас.
pub(crate) fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}


/// `Number.isSafeInteger(value)` для числа.
pub(crate) fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}
