//! Общие для модулей крейта приведения JS, которых нет в `sk_core`.
//!
//! Модули-источники держат свои копии `text`, `integer`, `digest` и `pick`;
//! здесь они собраны один раз, но ведут себя ровно как каждая из копий.

use serde_json::{Map, Value};
use sk_core::js;
use sk_core::text;

/// Число так, как его печатает `String(number)`: целые без дроби, прочее —
/// по правилам JS (`1e+21`, `1e-7`).
pub(crate) fn number_string(number: &serde_json::Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    if let Some(int) = number.as_u64() {
        return int.to_string();
    }
    js::f64_string(number.as_f64().unwrap_or(f64::NAN))
}

/// `String(value ?? '')` с печатью чисел по правилам JS.
pub(crate) fn s(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number_string(number),
        Some(Value::Array(items)) => items.iter().map(|item| s(Some(item))).collect::<Vec<_>>().join(","),
        other => js::s(other),
    }
}

/// `String(value)` для присутствующего значения: `null` печатается как `"null"`.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        other => s(Some(other)),
    }
}

/// Подстановка в шаблонную строку (`${value}`): `undefined` и `null` пишутся словами.
pub(crate) fn tpl(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(value) => js_string(value),
    }
}

/// `createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')`.
pub(crate) fn digest(parts: &[String]) -> String {
    sk_core::hash::sha256_hex(parts.join("\0"))
}

/// `Number.parseInt(hex.slice(0, 8), 16)`.
pub(crate) fn hex8(hex: &str) -> u64 {
    u64::from_str_radix(&hex[..8.min(hex.len())], 16).unwrap_or(0)
}

/// `pick(list, seed, salt)`: детерминированный выбор из таблицы.
pub(crate) fn pick<'a>(list: &[&'a str], seed: &str, salt: &str) -> Option<&'a str> {
    if list.is_empty() {
        return None;
    }
    let index = hex8(&digest(&[seed.to_string(), salt.to_string()])) % list.len() as u64;
    list.get(index as usize).copied()
}

/// `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
pub(crate) fn text_trim(value: Option<&Value>, maximum: usize) -> String {
    text::head(text::trim(&text::nfkc(&s(value))), maximum)
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
pub(crate) fn text_squash(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&s(value))), maximum)
}

/// `Number.isSafeInteger(Number(value)) ? Number(value) : fallback`.
pub(crate) fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// Строгое равенство `a === b` для значений JSON; `None` — `undefined`.
/// Объекты и массивы равны только сами себе, а разобранные из JSON — всегда
/// разные, поэтому для них ответ «нет».
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

/// `value === 'text'`.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `container?.includes(needle)`: массив — по SameValueZero, строка — поиск
/// подстроки `String(needle)`. Прочее в JS бросает `TypeError`; здесь — «нет».
pub(crate) fn includes(container: Option<&Value>, needle: Option<&Value>) -> bool {
    match container {
        Some(Value::Array(items)) => items.iter().any(|item| strict_eq(Some(item), needle)),
        Some(Value::String(text)) => text.contains(&tpl(needle)),
        _ => false,
    }
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `[...value]` для итерируемого: массив — элементы, строка — символы.
/// Прочие значения в JS бросают `TypeError`; здесь — пусто.
pub(crate) fn spread_iter(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// `value.length` для массива и строки (в символах), иначе `undefined`.
pub(crate) fn length(value: Option<&Value>) -> Option<usize> {
    match value {
        Some(Value::Array(items)) => Some(items.len()),
        Some(Value::String(text)) => Some(text.chars().count()),
        _ => None,
    }
}

/// Сравнение строк, как `<` и `sort()` в JS: по единицам UTF-16.
pub(crate) fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `value?.[key]` для объекта и массива.
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        Some(Value::Array(items)) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `value?.field` — поле объекта (у прочих значений JSON полей нет).
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `{ ...value }` для любого значения: объект копируется, массив и строка дают
/// ключи-индексы, прочее — пустой объект.
pub(crate) fn spread_any(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
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

/// `Object.entries(value)` для любого значения JSON.
pub(crate) fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `Number(value) || 0`.
pub(crate) fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }
}

/// `value ?? fallback` для поля: `null` и отсутствие уступают запасу.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `Number(value || 0)`: ложное — ноль, прочее — `Number` (строка без числа — `NaN`).
pub(crate) fn number_of_truthy(value: Option<&Value>) -> f64 {
    if js::truthy(value) {
        js::number(value)
    } else {
        0.0
    }
}

/// Пустой объект для значений по умолчанию (`value = {}`).
pub(crate) fn empty() -> &'static Value {
    static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Value::Object(Map::new()))
}

/// Убрать ключ, сохранив порядок остальных (`delete object[key]`).
pub(crate) fn delete(map: &mut Map<String, Value>, key: &str) {
    map.shift_remove(key);
}

/// Объект из пар `(ключ, значение)` в заданном порядке.
pub(crate) fn object<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Value::Object(pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strings_follow_js() {
        assert_eq!(tpl(None), "undefined");
        assert_eq!(tpl(Some(&json!(null))), "null");
        assert_eq!(s(Some(&json!(null))), "");
        assert_eq!(s(Some(&json!(1e21))), "1e+21");
        assert_eq!(s(Some(&json!([1, null, "a"]))), "1,,a");
        assert!(includes(Some(&json!("abc undefined")), None));
        assert!(includes(Some(&json!([1, "x"])), Some(&json!(1.0))));
    }

    #[test]
    fn order_puts_indices_first() {
        let map: Map<String, Value> = [("b", 1), ("10", 2), ("2", 3)].into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
        let ordered: Vec<String> = js_order(map).keys().cloned().collect();
        assert_eq!(ordered, ["2", "10", "b"]);
    }
}
