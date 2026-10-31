//! Приведения JS над рыхлым JSON, общие для модулей крейта и которых нет в
//! `sk_core::js`: доступ к полю, шаблонная строка, `SameValueZero`,
//! итерация по массиву или строке, `Object.entries` и порядок ключей объекта.

use serde_json::{Map, Value};
use sk_core::{js, text};

/// `value?.[key]` для объекта; у прочих значений JSON своих полей нет.
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `value?.[index]` для массива, строки (символ) и объекта (ключ `"0"`), как `list?.[0]`.
pub(crate) fn at(value: Option<&Value>, index: usize) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => items.get(index).cloned(),
        Some(Value::String(text)) => text.chars().nth(index).map(|ch| Value::String(ch.to_string())),
        Some(Value::Object(map)) => map.get(&index.to_string()).cloned(),
        _ => None,
    }
}

/// `String(value ?? '')`.
pub(crate) fn s(value: Option<&Value>) -> String {
    js::s(value)
}

/// `String(value)`: `undefined` и `null` печатаются словами.
pub(crate) fn string(value: Option<&Value>) -> String {
    js::string(value)
}

/// Подстановка в шаблонную строку `${value}`.
pub(crate) fn tpl(value: Option<&Value>) -> String {
    js::string(value)
}

/// `value ?? fallback`.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `value || fallback`.
pub(crate) fn or<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(value) {
        value
    } else {
        fallback
    }
}

/// `value === 'text'`.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `value === number`.
pub(crate) fn is_num(value: Option<&Value>, expected: f64) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64() == Some(expected))
}

/// `SameValueZero(a, b)` для значений JSON (`Set.has`, `includes`). Объекты и
/// массивы равны только сами себе, а разобранные из JSON — всегда разные.
pub(crate) fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// `a === b`; `None` — `undefined`.
pub(crate) fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_value_zero(a, b),
        _ => false,
    }
}

/// `list.includes(value)` по `SameValueZero`.
pub(crate) fn contains(list: &[Value], value: Option<&Value>) -> bool {
    match value {
        Some(value) => list.iter().any(|item| same_value_zero(item, value)),
        None => false,
    }
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `[...value]`: массив — элементы, строка — символы. Прочее в JS бросает
/// `TypeError`; здесь — пусто.
pub(crate) fn spread(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// Объект JSON по ссылке или `None`.
pub(crate) fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `Object.entries(value)` для любого значения JSON: объект — в порядке JS
/// (индексы раньше прочих ключей), массив и строка — по индексам.
pub(crate) fn entries(value: Option<&Value>) -> Vec<(String, Value)> {
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

/// Ключи объекта в порядке `Object.keys`.
pub(crate) fn keys(map: &Map<String, Value>) -> Vec<String> {
    js::keys(map).into_iter().cloned().collect()
}

/// `{ ...value }` для объекта; прочее — пустой объект.
pub(crate) fn spread_object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// Вставить поле, если значение есть: `{ key: value }`, где `undefined` в
/// JSON не попадает.
pub(crate) fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value {
        Some(value) => {
            map.insert(key.to_string(), value.clone());
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
pub(crate) fn squash(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&s(value))), maximum)
}

/// `text.slice(0, limit)` по символам.
pub(crate) fn head(value: &str, limit: usize) -> String {
    text::head(value, limit)
}

/// `createHash('sha256').update(text).digest('hex')`.
pub(crate) fn sha256(value: &str) -> String {
    sk_core::hash::sha256_hex(value)
}

/// `value.toLocaleLowerCase('ru')`.
pub(crate) fn lower(value: &str) -> String {
    text::lower(value)
}

/// `text.charAt(0).toLocaleLowerCase('ru') + text.slice(1)`.
pub(crate) fn lower_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => {
            let mut result = lower(&first.to_string());
            result.extend(chars);
            result
        }
        None => String::new(),
    }
}

/// `value.trim().split(/\s+/u)[0] ?? ''`.
pub(crate) fn first_word(value: &str) -> String {
    text::trim(value).split(text::is_js_space).next().unwrap_or("").to_string()
}

/// Безопасный идентификатор `^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`.
pub(crate) fn safe_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let mut count = 1;
    for ch in chars {
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')) {
            return false;
        }
        count += 1;
    }
    count <= 120
}

/// Набор строк в порядке первого вхождения (`new Set(list)` над строками).
pub(crate) fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    result
}

/// Список строк как JSON-массив.
pub(crate) fn strings_value(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}
