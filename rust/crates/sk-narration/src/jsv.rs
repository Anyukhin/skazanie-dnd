//! Приведения JS для рассказчиков, которых нет в `sk_core`.
//!
//! - [`slice_utf16`] — `text.slice(0, n)` по единицам UTF-16, как в JS
//!   (`sk_core::text::head` режет по символам);
//! - [`table_lookup`] — `ownEntry(TABLE, key)`: только собственный ключ
//!   таблицы, ключ прототипа (`constructor`, `toString`…) — «нет записи»;
//! - [`JsTypeError`] — исключение `TypeError`, которое JS бросает на мусоре
//!   старых сохранений (`null` в списке событий, строка вместо массива);
//!   Rust возвращает его ошибкой, а не паникой.

use serde_json::Value;
use sk_core::js;

/// `TypeError` исходника: обращение к полю `null`, `.map` у не-массива,
/// разворот (`...x`) не-итерируемого значения. Текст — место в исходнике JS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsTypeError(pub &'static str);

impl std::fmt::Display for JsTypeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "TypeError: {}", self.0)
    }
}

impl std::error::Error for JsTypeError {}

/// Итог функции, которая в JS может бросить `TypeError`.
pub type JsResult<T> = Result<T, JsTypeError>;

/// `text.slice(0, max)` по единицам UTF-16. Половину суррогатной пары строка
/// Rust удержать не может — такой символ отбрасывается целиком (JS оставил бы
/// одинокий старший суррогат).
pub fn slice_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for ch in source.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        result.push(ch);
    }
    result
}

/// `String(x ?? '').replace(/s+/gu, ' ').trim().slice(0, max)` — в том числе
/// `cleanNarrationText` из `server/deterministic-narration.mjs` (перенос в
/// `sk_narration_base` режет по символам, а не по единицам UTF-16).
pub fn clean_text(value: Option<&Value>, maximum: usize) -> String {
    slice_utf16(&sk_core::text::squash_spaces(&js::s(value)), maximum)
}

/// `value?.[key]` / `value.key` для поля с буквальным именем: поля есть только
/// у объекта JSON (у строки, числа и массива таких полей нет).
pub fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|object| object.get(key))
}

/// Путь `a?.b?.c`.
pub fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

/// `value ?? null` как `Option`: `null` — то же, что отсутствие.
pub fn nn(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `a ?? b`.
pub fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    nn(first).or(second)
}

/// `value?.[0]`: элемент массива, первая единица строки, поле `"0"` объекта.
pub fn index0(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => items.first().cloned(),
        // Символ вне BMP JS разрезал бы пополам; здесь берётся целиком.
        Value::String(text) => text.chars().next().map(|ch| Value::String(ch.to_string())),
        Value::Object(object) => object.get("0").cloned(),
        _ => None,
    }
}

/// `value === 'text'`.
pub fn is_str(value: Option<&Value>, text: &str) -> bool {
    value.and_then(Value::as_str) == Some(text)
}

/// `String(value || '')`.
pub fn str_or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        String::new()
    }
}

/// `` `${value || fallback}` `` и `String(value || fallback)`.
pub fn text_or(value: Option<&Value>, fallback: &str) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        fallback.to_string()
    }
}

/// `` `${a || b || fallback}` ``.
pub fn text_or2(first: Option<&Value>, second: Option<&Value>, fallback: &str) -> String {
    if js::truthy(first) {
        js::s(first)
    } else {
        text_or(second, fallback)
    }
}

/// `Number(value) || 0`.
pub fn num_or0(value: Option<&Value>) -> f64 {
    num_or(value, 0.0)
}

/// `Number(value) || fallback`.
pub fn num_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}

/// `Math.max(low, value)` для чисел без `NaN` (у вызывающих всегда `|| 0`).
pub fn max(low: f64, value: f64) -> f64 {
    if value > low {
        value
    } else {
        low
    }
}

/// Печать числа в шаблонной строке.
pub fn n(value: f64) -> String {
    js::f64_string(value)
}

/// `ownEntry(TABLE, key)` над таблицей подписей: только своё поле.
pub fn table_lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    own_lookup(table, key)
}

/// Только своё поле таблицы (`Object.hasOwn`, `Map`, `Set`).
pub fn own_lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(id, _)| *id == key).map(|(_, value)| *value)
}

/// Элементы `value ?? []` для `.map`/`.flatMap`: не-массив — `TypeError`.
pub fn mappable<'a>(value: Option<&'a Value>, place: &'static str) -> JsResult<&'a [Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(JsTypeError(place)),
    }
}

/// `Array.isArray(value) ? value : []`.
pub fn array_or_empty(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_slice_counts_surrogate_pairs() {
        assert_eq!(slice_utf16("аб😀в", 3), "аб");
        assert_eq!(slice_utf16("аб😀в", 4), "аб😀");
        assert_eq!(slice_utf16("абв", 10), "абв");
    }

    #[test]
    fn prototype_keys_are_not_table_entries() {
        let table = [("acid", "Кислота")];
        assert_eq!(table_lookup(&table, "acid"), Some("Кислота"));
        assert_eq!(table_lookup(&table, "constructor"), None);
        assert_eq!(own_lookup(&table, "constructor"), None);
    }
}
