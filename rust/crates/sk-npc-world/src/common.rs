//! Общие для модулей крейта приведения JS, которых нет в `sk_core`.
//!
//! Все четыре JS-модуля держат свои копии `text`, `integer` и `digest`; здесь
//! они собраны один раз и ведут себя ровно как каждая из копий. Отдельно —
//! чтение поля объекта так, как его читает JS (`obj[key]`): у любого объекта
//! есть унаследованные `constructor`, `toString`, `__proto__`, и старые
//! сохранения с такими идентификаторами ведут себя в JS по-особому.

use std::cmp::Ordering;

use serde_json::{Map, Value};
use sk_core::{hash, js, text as jstext};

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
pub(crate) fn text(value: Option<&Value>, maximum: usize) -> String {
    jstext::head(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), maximum)
}

/// [`text`] для готовой строки.
pub(crate) fn text_str(value: &str, maximum: usize) -> String {
    jstext::head(&jstext::squash_spaces(&jstext::nfkc(value)), maximum)
}

/// `text(value, 180).toLocaleLowerCase('ru')`.
pub(crate) fn comparable(value: Option<&Value>) -> String {
    jstext::lower(&text(value, 180))
}

/// `Number.isSafeInteger(Number(value)) ? Number(value) : fallback`.
pub(crate) fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// `integer(value, Number.NaN)`: `None` — `NaN`.
pub(crate) fn opt_integer(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer_number(value).then(|| js::number(value) as i64)
}

/// `integer(value, fallback)` с дробным запасом (`NaN`, бесконечность).
pub(crate) fn integer_or(value: Option<&Value>, fallback: f64) -> f64 {
    if js::is_safe_integer_number(value) {
        js::number(value)
    } else {
        fallback
    }
}

/// `Math.max(a, b)` с заразным `NaN`, как в JS (у `f64::max` `NaN` проигрывает).
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `value?.key` — поле объекта; у прочих значений JSON полей с такими именами
/// нет (модули читают только именованные поля, а не `length` и не индексы).
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `a ?? b`.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `[...(value ?? [])]` и `for (const item of value ?? [])`: массив — его
/// элементы, строка — символы. Прочее в JS бросает `TypeError`; здесь — пусто.
pub(crate) fn iterate(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// `Object.entries(value ?? {})`: у объекта — пары в порядке JS (индексы
/// раньше), у массива и строки — индексы, у прочего — ничего.
pub(crate) fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `{ ...value }`: собственные перечислимые поля. У строки и массива — индексы,
/// у функции и примитива — ничего.
pub(crate) fn spread(value: Option<&Value>) -> Map<String, Value> {
    object_entries(value).into_iter().collect()
}

/// Свойства `Object.prototype`, которые `obj[key]` находит у любого объекта.
pub(crate) const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Ключ, который у любого объекта JS находит что-то унаследованное.
pub(crate) fn is_prototype_key(key: &str) -> bool {
    OBJECT_PROTOTYPE_KEYS.contains(&key)
}

/// Что находит `obj[key]` в JS.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Member<'a> {
    /// Собственное поле объекта (или элемент массива по индексу).
    Own(&'a Value),
    /// Унаследованная функция `Object.prototype` (`constructor`, `toString`…):
    /// истинна, своих данных у неё нет, `JSON.stringify` её не пишет.
    Function,
    /// `__proto__` без собственного поля — сам `Object.prototype`: истинный
    /// объект без своих перечислимых полей, в JSON — `{}`.
    Prototype,
    /// `undefined`.
    Missing,
}

impl<'a> Member<'a> {
    /// Собственное значение, если оно есть.
    pub(crate) fn own(self) -> Option<&'a Value> {
        match self {
            Member::Own(value) => Some(value),
            _ => None,
        }
    }

    /// `Boolean(obj[key])`.
    pub(crate) fn truthy(self) -> bool {
        match self {
            Member::Own(value) => js::truthy(Some(value)),
            Member::Function | Member::Prototype => true,
            Member::Missing => false,
        }
    }

    /// `obj[key] == null`.
    pub(crate) fn nullish(self) -> bool {
        matches!(self, Member::Missing | Member::Own(Value::Null))
    }

    /// `obj[key]?.field` для поля с данными: у функции и `Object.prototype`
    /// своих данных нет.
    pub(crate) fn field(self, key: &str) -> Member<'a> {
        match self {
            Member::Own(value) => member(Some(value), key),
            Member::Function | Member::Prototype => {
                if key == "__proto__" {
                    Member::Prototype
                } else if is_prototype_key(key) {
                    Member::Function
                } else {
                    Member::Missing
                }
            }
            Member::Missing => Member::Missing,
        }
    }
}

/// `obj[key]` по правилам JS для объекта и массива.
pub(crate) fn member<'a>(value: Option<&'a Value>, key: &str) -> Member<'a> {
    match value {
        Some(Value::Object(map)) => match map.get(key) {
            Some(found) => Member::Own(found),
            None if key == "__proto__" => Member::Prototype,
            None if is_prototype_key(key) => Member::Function,
            None => Member::Missing,
        },
        Some(Value::Array(items)) => {
            if js::is_array_index_key(key) {
                key.parse::<usize>().ok().and_then(|index| items.get(index)).map_or(Member::Missing, Member::Own)
            } else if is_prototype_key(key) {
                if key == "__proto__" {
                    Member::Prototype
                } else {
                    Member::Function
                }
            } else {
                Member::Missing
            }
        }
        _ => Member::Missing,
    }
}

/// `obj[key] = value` у объекта-словаря, собранного из JSON. Ключ `__proto__`
/// без собственного поля меняет прототип, а не пишет поле: в `Object.entries`
/// и JSON запись не попадает.
pub(crate) fn assign_key(map: &mut Map<String, Value>, key: &str, value: Value) {
    if key == "__proto__" && !map.contains_key(key) {
        return;
    }
    map.insert(key.to_string(), value);
}

/// `createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')`.
pub(crate) fn digest(parts: &[String]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

/// Сравнение строк по единицам UTF-16 — так сравнивают `<` и `array.sort()`.
pub(crate) fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Видимость события по видимости NPC: `public`, `gm_only` или `party`.
pub(crate) fn visibility_of(npc: Option<&Value>) -> &'static str {
    match get(npc, "visibility").and_then(Value::as_str) {
        Some("public") => "public",
        Some("gm_only") => "gm_only",
        _ => "party",
    }
}

/// Строка-значение JSON.
pub(crate) fn string(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

/// `Number.isSafeInteger(value)` для числа JS.
pub(crate) fn is_safe_f64(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// Число JS как ключ `` `${number}` ``.
pub(crate) fn number_key(value: f64) -> String {
    js::f64_string(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn member_reads_like_js() {
        let object = json!({ "a": 1, "__proto__": 2 });
        assert!(matches!(member(Some(&object), "a"), Member::Own(_)));
        assert!(matches!(member(Some(&object), "__proto__"), Member::Own(_)));
        assert!(matches!(member(Some(&json!({})), "__proto__"), Member::Prototype));
        assert!(matches!(member(Some(&json!({})), "constructor"), Member::Function));
        assert!(matches!(member(Some(&json!({})), "x"), Member::Missing));
        assert!(matches!(member(Some(&json!([5, 6])), "1"), Member::Own(_)));
        assert!(matches!(member(Some(&json!("abc")), "0"), Member::Missing));
    }

    #[test]
    fn assign_to_proto_without_own_field_is_lost() {
        let mut map = Map::new();
        assign_key(&mut map, "__proto__", json!({ "a": 1 }));
        assert!(map.is_empty());
        map.insert("__proto__".into(), json!(1));
        assign_key(&mut map, "__proto__", json!(2));
        assert_eq!(map.get("__proto__"), Some(&json!(2)));
    }

    #[test]
    fn text_squashes_spaces_and_cuts() {
        assert_eq!(text(Some(&json!("  a \n b  ")), 180), "a b");
        assert_eq!(text(Some(&json!(12)), 1), "1");
        assert_eq!(text(None, 5), "");
    }
}
