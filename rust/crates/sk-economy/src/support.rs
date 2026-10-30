//! Приведения JS, общие для модулей крейта: `value?.[key]`, `a ?? b`,
//! `clampInteger`, `cleanId`/`cleanText`, `stableValue`, порядок ключей
//! объекта по `Object.keys`, распаковка `{ ...value }`, свойства
//! `Object.prototype`, длина и сравнение строк в единицах UTF-16.

use std::cmp::Ordering;

use serde_json::{Map, Value};
use sk_core::{hash, js, text};

/// `value?.[key]` для объекта. У массива ключ-индекс находит элемент, как
/// `array['0']` в JS; у строки, числа и прочего — `undefined`.
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        Some(Value::Array(items)) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `a ?? b`.
pub(crate) fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

/// `value && typeof value === 'object' && !Array.isArray(value)`: словарь.
pub(crate) fn plain(value: Option<&Value>) -> Option<&Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `value && typeof value === 'object'`: объект или массив.
pub(crate) fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)) | Some(Value::Array(_)))
}

/// Пустой словарь как значение.
pub(crate) fn empty() -> Value {
    Value::Object(Map::new())
}

/// `Number.isSafeInteger(n)` для уже приведённого числа.
pub(crate) fn is_safe(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `Math.max(min, Math.min(max, safeInteger(n, fallback)))` над числом JS.
pub(crate) fn clamp_num(number: f64, minimum: i64, maximum: i64, fallback: i64) -> i64 {
    let value = if is_safe(number) { number as i64 } else { fallback };
    minimum.max(maximum.min(value))
}

/// `clampInteger(value, min, max, fallback)`.
pub(crate) fn clamp_int(value: Option<&Value>, minimum: i64, maximum: i64, fallback: i64) -> i64 {
    clamp_num(js::number(value), minimum, maximum, fallback)
}

/// `safeInteger(value, fallback)`.
pub(crate) fn safe_int(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// `String(value ?? '').trim().slice(0, maximum) || fallback`.
pub(crate) fn clean_text(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    let source = js::s(value);
    let result = text::head(text::trim(&source), maximum);
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

/// `cleanId(value, fallback)`: строка до 120 символов после `trim`.
pub(crate) fn clean_id(value: Option<&Value>, fallback: &str) -> String {
    clean_text(value, 120, fallback)
}

/// `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
pub(crate) fn nfkc_text(value: Option<&Value>, maximum: usize) -> String {
    text::clean(value, maximum)
}

/// `String(value || '')`: ложное значение — пустая строка.
pub(crate) fn string_or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        String::new()
    }
}

/// Длина строки JS (`text.length`) — в единицах UTF-16.
pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Сравнение строк, как `Array.prototype.sort()` без сравнителя: по единицам UTF-16.
pub(crate) fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Объект в порядке ключей JS: сначала индексы по возрастанию, затем прочие
/// ключи в порядке вставки. Так JS сам перечисляет собственные свойства.
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

/// `{ ...value }`: словарь — копия; массив — ключи-индексы; прочее — ничего.
pub(crate) fn spread_of(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `stableValue(value)`: ключи объектов отсортированы (по UTF-16, как
/// `sort()`), рекурсивно; массивы сохраняют порядок.
pub(crate) fn stable_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(stable_value).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| utf16_cmp(left, right));
            let sorted: Map<String, Value> = keys.into_iter().map(|key| (key.clone(), stable_value(&map[key]))).collect();
            Value::Object(js_order(sorted))
        }
        other => other.clone(),
    }
}

/// `JSON.stringify(value)` байт в байт.
pub(crate) fn stringify(value: &Value) -> String {
    sk_narration_base::jsx::stringify(value)
}

/// `createHash('sha256').update(text).digest('hex')`.
pub(crate) fn sha256_hex(data: &str) -> String {
    hash::sha256_hex(data)
}

/// `Number.parseInt(hex.slice(0, 8), 16)`.
pub(crate) fn hex8(digest: &str) -> u64 {
    u64::from_str_radix(&digest[..8.min(digest.len())], 16).unwrap_or(0)
}

/// Поле `source[key]`, если оно есть (`undefined` в JSON не попадает).
pub(crate) fn copy_field(target: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        target.insert(key.to_string(), value.clone());
    }
}

/// Число JS в JSON: целое — без дроби, `NaN` — `null`.
pub(crate) fn num(value: f64) -> Value {
    js::num(value)
}

/// Массив JSON как срез (не массив — пусто).
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    }
}

/// `Math.max(1, Math.ceil(a / b))` и родственные операции считаются в f64,
/// как в JS; здесь — целое из f64 для деления цены.
pub(crate) fn ceil_div(numerator: f64, denominator: f64) -> f64 {
    (numerator / denominator).ceil()
}

/// `Math.floor(a / b)` в f64.
pub(crate) fn floor_div(numerator: f64, denominator: f64) -> f64 {
    (numerator / denominator).floor()
}
