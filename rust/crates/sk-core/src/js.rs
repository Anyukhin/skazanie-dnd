//! Помощники для переноса JS-логики над рыхлым JSON строка в строку.
//!
//! JS-движок правит состояние как объекты без схемы: `state.mechanics.combat
//! .action_economy[id] = { ...economy, action: false }`. На этапе паритета Rust
//! держит ту же форму (`serde_json::Value`) и те же правила приведения:
//! `safeInteger`, `String(x ?? '')`, `x === true`, `x ?? y`. Здесь они собраны,
//! чтобы перенесённый код читался как исходный и вёл себя так же.

use serde_json::{Map, Value};

/// `safeInteger(value, fallback)`: целое из числа или строки, иначе запас.
pub fn safe_int(value: Option<&Value>, fallback: i64) -> i64 {
    crate::json::int(value, fallback)
}

/// `String(value)` без `??`: отсутствующее поле — `"undefined"`, `null` —
/// `"null"`. Нужен там, где JS сравнивает `String(x) === String(y)`.
pub fn string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        other => s(other),
    }
}

/// `String(value ?? '')`.
pub fn s(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => js_number_string(number),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items.iter().map(|item| s(Some(item))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Число так, как его печатает JS: `3`, а не `3.0`; `1e+21`, `1e-7`.
pub fn js_number_string(number: &serde_json::Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    if let Some(unsigned) = number.as_u64() {
        return f64_string(unsigned as f64);
    }
    number.as_f64().map_or_else(|| number.to_string(), f64_string)
}

/// `value === true`.
pub fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

/// `value === false`.
pub fn is_false(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(false)))
}

/// Истинность по JS: `Boolean(value)`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `value != null` (не `undefined` и не `null`).
pub fn present(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null))
}

/// Объект-словарь (`value && typeof value === 'object' && !Array.isArray(value)`).
pub fn is_plain(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// Пустой объект.
pub fn obj() -> Value {
    Value::Object(Map::new())
}

/// Строка-значение.
pub fn str_value(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

/// `uniqueStrings(list)`: строки без пустых и повторов, порядок первого вхождения.
pub fn unique_strings(value: Option<&Value>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    if let Some(Value::Array(items)) = value {
        for item in items {
            let text = s(Some(item));
            if !text.is_empty() && seen.insert(text.clone()) {
                result.push(text);
            }
        }
    }
    result
}

/// Массив строк в JSON.
pub fn strings_value<I, S>(items: I) -> Value
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    Value::Array(items.into_iter().map(|item| Value::String(item.into())).collect())
}

/// `text.slice(0, limit)` по символам.
pub fn slice(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Изменяемый объект по ключу; создаётся пустым, если его нет или там не объект.
pub fn object_mut<'a>(parent: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !parent.is_object() {
        *parent = obj();
    }
    let map = parent.as_object_mut().expect("объект");
    let slot = map.entry(key.to_string()).or_insert_with(obj);
    if !slot.is_object() {
        *slot = obj();
    }
    slot.as_object_mut().expect("объект")
}

/// Изменяемый массив по ключу; создаётся пустым, если его нет.
pub fn array_mut<'a>(parent: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !parent.is_object() {
        *parent = obj();
    }
    let map = parent.as_object_mut().expect("объект");
    let slot = map.entry(key.to_string()).or_insert_with(|| Value::Array(Vec::new()));
    if !slot.is_array() {
        *slot = Value::Array(Vec::new());
    }
    slot.as_array_mut().expect("массив")
}

/// `{ ...base, ...patch }` для объектов: поля `patch` перекрывают `base`.
pub fn spread(base: &Value, patch: Value) -> Value {
    let mut result = match base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    if let Value::Object(patch) = patch {
        for (key, value) in patch {
            result.insert(key, value);
        }
    }
    Value::Object(result)
}

/// Добавить поля в объект на месте (`Object.assign`).
pub fn assign(target: &mut Value, patch: Value) {
    if !target.is_object() {
        *target = obj();
    }
    if let (Some(map), Value::Object(patch)) = (target.as_object_mut(), patch) {
        for (key, value) in patch {
            map.insert(key, value);
        }
    }
}

/// Поле по пути `a.b.c`, без паники.
pub fn path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in keys {
        current = current.get(*key)?;
    }
    (!current.is_null()).then_some(current)
}

/// Удалить ключ из объекта, если это объект.
pub fn delete(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.shift_remove(key);
    }
}

/// `Number.isSafeInteger(value)` для JSON.
pub fn is_safe_integer(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(number)) => number.as_f64().is_some_and(|f| f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0),
        _ => false,
    }
}

/// Целое как JSON-число.
pub fn int_value(value: i64) -> Value {
    Value::from(value)
}

/// Необязательная строка как JSON (`null`, если `None`).
pub fn opt_str(value: Option<&str>) -> Value {
    value.map(|text| Value::String(text.to_string())).unwrap_or(Value::Null)
}

/// Удалить поля со значением «undefined». В Rust его нет; так помечаются
/// поля, которые JS положил бы как `undefined` и не сериализовал бы.
pub const UNDEFINED: &str = "\u{0}undefined";

/// Убрать из объекта поля, помеченные [`UNDEFINED`], — как `JSON.stringify`.
pub fn strip_undefined(value: &mut Value) {
    if let Some(map) = value.as_object_mut() {
        map.retain(|_, field| field.as_str() != Some(UNDEFINED));
    }
}

/// Значение или «undefined»: `cond ? value : undefined`.
pub fn or_undefined(value: Option<Value>) -> Value {
    value.unwrap_or_else(|| Value::String(UNDEFINED.into()))
}

/// `Number(value)` по правилам JS: `null`, `""`, `false` — 0; `true` — 1;
/// строка — десятичное, `0x`/`0o`/`0b` или `Infinity` после `trim`; массив из
/// одного элемента — его число; остальное (и отсутствующее поле) — `NaN`.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => parse_number(text),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [single] => number(Some(&Value::String(s(Some(single))))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number(text)` для строки.
pub fn parse_number(text: &str) -> f64 {
    let text = crate::text::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|ch| ch.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, ch| acc * f64::from(radix) + f64::from(ch.to_digit(radix).unwrap_or(0)));
        }
    }
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(index) => (&body[..index], Some(&body[index + 1..])),
        None => (body, None),
    };
    let mantissa_ok = {
        let mut parts = mantissa.splitn(2, '.');
        let whole = parts.next().unwrap_or("");
        let fraction = parts.next();
        let digits = |part: &str| part.chars().all(|ch| ch.is_ascii_digit());
        digits(whole) && fraction.is_none_or(digits) && !(whole.is_empty() && fraction.is_none_or(str::is_empty))
    };
    let exponent_ok = exponent.is_none_or(|exponent| {
        let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit())
    });
    if !mantissa_ok || !exponent_ok {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isFinite(Number(value))`.
pub fn is_finite_number(value: Option<&Value>) -> bool {
    number(value).is_finite()
}

/// `Number.isSafeInteger(Number(value))`.
pub fn is_safe_integer_number(value: Option<&Value>) -> bool {
    let number = number(value);
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// Число в JSON так, как его записал бы `JSON.stringify`: целое без `.0`,
/// `NaN` и бесконечность — `null`.
pub fn num(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
}

/// `Math.round(value)`: половина — вверх (к +∞), а не от нуля.
pub fn round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `parseInt(text, 10)`: ведущее целое после пробелов, иначе `NaN`.
pub fn parse_int(text: &str) -> f64 {
    let text = crate::text::trim_start(text);
    let (sign, body) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: String = body.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseFloat(text)`: самое длинное десятичное число в начале строки после
/// пробелов, иначе `NaN`.
pub fn parse_float(text: &str) -> f64 {
    let text = crate::text::trim_start(text);
    let mut best = f64::NAN;
    for (index, ch) in text.char_indices() {
        let candidate = &text[..index + ch.len_utf8()];
        if !(ch.is_ascii_digit() || matches!(ch, 'e' | 'E' | '+' | '-' | '.')) {
            break;
        }
        let value = parse_number(candidate);
        if !value.is_nan() {
            best = value;
        }
    }
    best
}

/// `String(number)` для f64: целые без дроби, экспонента от 1e21 и до 1e-7.
pub fn f64_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if value == 0.0 {
        return "0".into();
    }
    let formatted = format!("{value:e}");
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let negative = mantissa.starts_with('-');
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let sign = if negative { "-" } else { "" };
    if (-6..21).contains(&exponent) {
        let point = exponent + 1;
        if point <= 0 {
            format!("{sign}0.{}{digits}", "0".repeat((-point) as usize))
        } else if point as usize >= digits.len() {
            format!("{sign}{digits}{}", "0".repeat(point as usize - digits.len()))
        } else {
            format!("{sign}{}.{}", &digits[..point as usize], &digits[point as usize..])
        }
    } else {
        let rest = &digits[1..];
        let exponent_text = if exponent >= 0 { format!("+{exponent}") } else { exponent.to_string() };
        if rest.is_empty() {
            format!("{sign}{}e{exponent_text}", &digits[..1])
        } else {
            format!("{sign}{}.{rest}e{exponent_text}", &digits[..1])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_follows_js() {
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!(""))), 0.0);
        assert_eq!(number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(number(Some(&json!("0x10"))), 16.0);
        assert!(number(Some(&json!("12px"))).is_nan());
        assert!(number(Some(&json!("inf"))).is_nan());
        assert_eq!(number(Some(&json!(true))), 1.0);
        assert_eq!(number(Some(&json!([7]))), 7.0);
        assert_eq!(number(Some(&json!(".5"))), 0.5);
        assert_eq!(number(Some(&json!("5."))), 5.0);
        assert!(number(Some(&json!("."))).is_nan());
    }

    #[test]
    fn safe_int_follows_js() {
        assert_eq!(safe_int(Some(&json!(2.5)), 9), 9);
        assert_eq!(safe_int(Some(&json!(null)), 9), 0);
        assert_eq!(safe_int(None, 9), 9);
        assert_eq!(safe_int(Some(&json!("7")), 9), 7);
        assert_eq!(safe_int(Some(&json!(true)), 9), 1);
        assert_eq!(safe_int(Some(&json!(3.0)), 9), 3);
    }

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(f64_string(3.0), "3");
        assert_eq!(f64_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(f64_string(1e21), "1e+21");
        assert_eq!(f64_string(1.5e-7), "1.5e-7");
        assert_eq!(f64_string(-0.000001), "-0.000001");
        assert_eq!(f64_string(123456.789), "123456.789");
        assert_eq!(num(2.0), json!(2));
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(parse_int(" 42px"), 42.0);
        assert_eq!(parse_float("3.5 футов"), 3.5);
        assert_eq!(parse_float("1e3x"), 1000.0);
    }
}

/// `ToInt32(value)` — то, что делают `value | 0`, `value >> 0`, `~~value`.
pub fn to_int32(value: f64) -> i32 {
    to_uint32(value) as i32
}

/// `ToUint32(value)` — то, что делает `value >>> 0`.
pub fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    let truncated = value.trunc();
    let modulo = truncated.rem_euclid(4_294_967_296.0);
    modulo as u32
}

/// `Math.imul(a, b)`.
pub fn imul(a: f64, b: f64) -> i32 {
    to_int32(a).wrapping_mul(to_int32(b))
}

/// `value.toFixed(digits)`: ровно `digits` знаков после точки; половина —
/// к большему по модулю, как в JS, а не к чётному, как `format!`.
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return f64_string(value);
    }
    if value.abs() >= 1e21 {
        return f64_string(value);
    }
    let negative = value < 0.0;
    // Точное десятичное разложение двоичного числа: у f64 не больше 1074
    // знаков после точки.
    let exact = format!("{:.1100}", value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let kept = &fraction[..digits.min(fraction.len())];
    let rest = &fraction[digits.min(fraction.len())..];
    let round_up = rest.as_bytes().first().is_some_and(|digit| *digit >= b'5');
    let mut number: Vec<u8> = whole.bytes().chain(kept.bytes()).collect();
    if round_up {
        let mut index = number.len();
        loop {
            if index == 0 {
                number.insert(0, b'1');
                break;
            }
            index -= 1;
            if number[index] == b'9' {
                number[index] = b'0';
            } else {
                number[index] += 1;
                break;
            }
        }
    }
    let text = String::from_utf8(number).unwrap_or_default();
    let split = text.len() - digits;
    let body = if digits == 0 { text } else { format!("{}.{}", &text[..split], &text[split..]) };
    let is_zero = body.bytes().all(|byte| byte == b'0' || byte == b'.');
    if negative && !is_zero {
        format!("-{body}")
    } else {
        body
    }
}

/// Ключ объекта, который JS считает индексом массива: `"0"`, `"12"`, но не
/// `"01"` и не `"-1"`.
pub fn is_array_index_key(key: &str) -> bool {
    !key.is_empty()
        && key.bytes().all(|byte| byte.is_ascii_digit())
        && (key == "0" || !key.starts_with('0'))
        && key.parse::<u64>().is_ok_and(|index| index < 4_294_967_295)
}

/// Пары объекта в порядке `Object.entries`: сначала ключи-индексы по
/// возрастанию, затем остальные в порядке вставки.
pub fn entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(&String, &Value)> = map.iter().filter(|(key, _)| is_array_index_key(key)).collect();
    indexed.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indexed.extend(map.iter().filter(|(key, _)| !is_array_index_key(key)));
    indexed
}

/// Ключи в порядке `Object.keys`.
pub fn keys(map: &Map<String, Value>) -> Vec<&String> {
    entries(map).into_iter().map(|(key, _)| key).collect()
}

/// `array.sort()` без сравнителя: по строковому виду элементов (UTF-16 —
/// здесь по кодовым точкам), `undefined` в конце. Сортировка устойчивая.
pub fn default_sort(values: &mut [Value]) {
    values.sort_by_key(|value| s(Some(value)));
}

/// `Math.max(...values)`: `-Infinity` для пустого списка, `NaN` заразен.
pub fn max_of(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut result = f64::NEG_INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if value > result {
            result = value;
        }
    }
    result
}

/// `Math.min(...values)`: `Infinity` для пустого списка, `NaN` заразен.
pub fn min_of(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut result = f64::INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if value < result {
            result = value;
        }
    }
    result
}

/// `value.toLocaleString('ru-RU')` для целого: группы по три через
/// неразрывный пробел (U+00A0), как печатает ICU.
pub fn ru_integer(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push('\u{a0}');
        }
        grouped.push(digit);
    }
    if value < 0 {
        format!("-{grouped}")
    } else {
        grouped
    }
}

#[cfg(test)]
mod more_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integer_coercions_follow_js() {
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_uint32(-1.0), 4_294_967_295);
        assert_eq!(imul(0x7fff_ffff as f64, 2.0), -2);
    }

    #[test]
    fn to_fixed_rounds_half_up_on_exact_binary() {
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(-0.0001, 2), "0.00");
        assert_eq!(to_fixed(0.1, 3), "0.100");
        assert_eq!(to_fixed(99.96, 1), "100.0");
    }

    #[test]
    fn entries_put_index_keys_first() {
        let map = json!({ "b": 1, "10": 2, "a": 3, "2": 4, "01": 5 });
        let keys: Vec<&str> = keys(map.as_object().expect("объект")).into_iter().map(String::as_str).collect();
        assert_eq!(keys, ["2", "10", "b", "a", "01"]);
    }

    #[test]
    fn default_sort_compares_strings() {
        let mut values = vec![json!(10), json!(9), json!(1)];
        default_sort(&mut values);
        assert_eq!(values, vec![json!(1), json!(10), json!(9)]);
        assert_eq!(ru_integer(1234567), "1\u{a0}234\u{a0}567");
        assert_eq!(max_of([]), f64::NEG_INFINITY);
    }
}
