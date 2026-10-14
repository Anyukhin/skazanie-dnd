//! Общие для модулей крейта приведения JS, которых нет в `sk_core`.
//!
//! Оба JS-модуля держат свои копии `clean`; здесь они собраны один раз и ведут
//! себя ровно как каждая из копий.

use serde_json::{Map, Value};
use sk_core::{js, text};

/// `value?.key` — поле объекта. У прочих значений JSON (строка, число, массив)
/// полей с такими именами нет: модули читают только именованные поля, а не
/// `length` и не индексы.
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `value ?? fallback`: `null` и отсутствие уступают запасу.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
pub(crate) fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

/// `clean` и затем `toLocaleLowerCase('ru')`.
pub(crate) fn clean_lower(value: Option<&Value>, maximum: usize) -> String {
    text::lower(&clean(value, maximum))
}

/// Подстановка в шаблонную строку и `String(value)`: `undefined` и `null`
/// пишутся словами.
pub(crate) fn tpl(value: Option<&Value>) -> String {
    js::string(value)
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `for (const item of value)` и `[...value]`: массив — элементы, строка —
/// символы. Прочие значения в JS бросают `TypeError`; здесь — пусто.
pub(crate) fn iterate(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// `value === 'text'`.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `SET.has(value)` для набора строк: только строка из набора.
pub(crate) fn one_of<'a>(value: Option<&'a Value>, set: &[&str]) -> Option<&'a str> {
    value.and_then(Value::as_str).filter(|text| set.contains(text))
}

/// Строгое равенство `a === b` для значений JSON; `None` — `undefined`.
/// Объекты и массивы равны только сами себе, а разные значения JSON — всегда
/// разные объекты, поэтому для них ответ «нет».
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

/// `Object.entries(value)` для любого значения JSON (индексы раньше прочих
/// ключей; строка — по символам; прочее — пусто).
pub(crate) fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// Порядок ключей объекта JS: сначала ключи-индексы по возрастанию, затем
/// остальные в порядке вставки. Нужен там, где ключи приходят из данных.
pub(crate) fn js_order(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|key| js::is_array_index_key(key)) {
        return map;
    }
    let mut indexed: Vec<(String, Value)> = Vec::new();
    let mut named: Vec<(String, Value)> = Vec::new();
    for (key, value) in map {
        if js::is_array_index_key(&key) {
            indexed.push((key, value));
        } else {
            named.push((key, value));
        }
    }
    indexed.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indexed.into_iter().chain(named).collect()
}

/// `structuredClone(value)`: копия в порядке ключей объекта JS на всех уровнях.
pub(crate) fn clone_js(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(js_order(map.iter().map(|(key, item)| (key.clone(), clone_js(item))).collect())),
        Value::Array(items) => Value::Array(items.iter().map(clone_js).collect()),
        other => other.clone(),
    }
}

/// `{ ...value }` для любого значения: объект копируется (в порядке JS),
/// массив и строка дают ключи-индексы, прочее — пустой объект.
pub(crate) fn spread_of(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => js_order(map.clone()),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// Вставить поле, если оно есть: `{ key: value }`, где `undefined` в JSON не
/// попадает.
pub(crate) fn put_opt(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.to_string(), value.clone());
    }
}

/// Элемент массива JSON: `undefined` в массиве `JSON.stringify` пишет `null`.
pub(crate) fn element(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// Пустой объект для значений по умолчанию (`value = {}`).
pub(crate) fn empty() -> &'static Value {
    static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Value::Object(Map::new()))
}

/// Параметр со значением по умолчанию `= {}`: JS подставляет его вместо
/// `undefined`, а на `null` падает с `TypeError`. Здесь `null` читается как
/// `{}` — это и есть то, что вызывающий получил бы без падения.
pub(crate) fn or_empty(value: &Value) -> &Value {
    if value.is_null() {
        empty()
    } else {
        value
    }
}

/// Безопасное целое JS (`Number.isSafeInteger`) для уже посчитанного числа.
pub(crate) fn is_safe(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}
