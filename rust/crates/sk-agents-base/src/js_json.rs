//! `JSON.parse` и `JSON.stringify(value, null, 2)` по правилам V8.
//!
//! Строгий разбор ответа модели (`strictJsonParse` в `server/llm-client.mjs`)
//! и файл учёта Архитектора (`server/architect-usage.mjs`) зависят от того, как
//! именно V8 читает и пишет JSON, а `serde_json` в нескольких местах ведёт себя
//! иначе:
//!
//! - число вне диапазона `f64` (`1e400`) V8 читает как `Infinity`, и отказ
//!   приходит позже, от проверки дерева, с путём до числа; `serde_json` падает
//!   на разборе;
//! - глубина вложенности у V8 не ограничена (разбор итеративный), у
//!   `serde_json` — 128 уровней;
//! - ключи-индексы (`"0"`, `"12"`) объект JS держит первыми по возрастанию, и
//!   в этом порядке их обходят `Object.keys` и `JSON.stringify`;
//! - все числа JS — `f64`: `12345678901234567890` становится
//!   `12345678901234567000`.
//!
//! Разбор возвращает [`Js`] — дерево с числами `f64` (в том числе
//! бесконечными) и ключами в порядке JS; [`Js::into_value`] переводит его в
//! `serde_json::Value` (целые — без `.0`, как `JSON.stringify`).
//!
//! Отличие от V8: одиночный суррогат из `\uD800` в строке Rust непредставим и
//! заменяется на U+FFFD.

use serde_json::{Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::js;

/// Сколько уровней дерева обходит рекурсивная проверка `assertSafeJsonTree`
/// до переполнения стека V8 (замер Node 24 на машине владельца: глубина 4687
/// проходит, 4688 — `RangeError`). Узлы глубже в дереве не строятся: обход до
/// них в JS всё равно оборвался бы переполнением.
pub(crate) const JS_STACK_DEPTH: usize = 4687;

/// Значение JSON так, как его держит JS после `JSON.parse`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    /// Пары в порядке `Object.keys`: индексы по возрастанию, затем остальные
    /// в порядке первого появления (повтор ключа заменяет значение на месте).
    Object(Vec<(String, Js)>),
    /// Узел глубже [`JS_STACK_DEPTH`]: обход, дошедший сюда, в V8 переполнил
    /// бы стек.
    TooDeep,
}

impl Js {
    /// Перевод в `serde_json::Value`: число — как его записал бы
    /// `JSON.stringify` (`js::num`: целое без дроби, бесконечность — `null`).
    /// Перевод итеративный: глубина дерева — до предела стека V8, а не Rust.
    pub(crate) fn into_value(self) -> Value {
        enum Frame {
            Array(Vec<Value>, std::vec::IntoIter<Js>),
            Object(Map<String, Value>, Option<String>, std::vec::IntoIter<(String, Js)>),
        }
        fn open(node: Js, stack: &mut Vec<Frame>) -> Option<Value> {
            match node {
                Js::Null | Js::TooDeep => Some(Value::Null),
                Js::Bool(flag) => Some(Value::Bool(flag)),
                Js::Number(number) => Some(js::num(number)),
                Js::String(text) => Some(Value::String(text)),
                Js::Array(items) => {
                    stack.push(Frame::Array(Vec::with_capacity(items.len()), items.into_iter()));
                    None
                }
                Js::Object(entries) => {
                    stack.push(Frame::Object(Map::new(), None, entries.into_iter()));
                    None
                }
            }
        }
        let mut stack = Vec::new();
        let mut ready = open(self, &mut stack);
        loop {
            if let Some(value) = ready.take() {
                match stack.last_mut() {
                    None => return value,
                    Some(Frame::Array(out, _)) => out.push(value),
                    Some(Frame::Object(out, key, _)) => {
                        out.insert(key.take().unwrap_or_default(), value);
                    }
                }
            }
            let next = match stack.last_mut() {
                Some(Frame::Array(_, rest)) => rest.next(),
                Some(Frame::Object(_, key, rest)) => rest.next().map(|(name, item)| {
                    *key = Some(name);
                    item
                }),
                None => return Value::Null,
            };
            ready = match next {
                Some(child) => open(child, &mut stack),
                None => match stack.pop() {
                    Some(Frame::Array(out, _)) => Some(Value::Array(out)),
                    Some(Frame::Object(out, _, _)) => Some(Value::Object(out)),
                    None => return Value::Null,
                },
            };
        }
    }
}

/// Ошибка `JSON.parse` (`SyntaxError`). Текст — для причины в журнале, с
/// текстом V8 он не сверяется.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyntaxError(pub String);

enum Container {
    Array(Vec<Js>),
    Object { entries: IndexMap<String, Js>, key: Option<String> },
    /// Контейнер глубже предела: синтаксис проверяется, значения не хранятся.
    Phantom { is_array: bool, expect_key: bool },
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn error(&self, what: &str) -> SyntaxError {
        SyntaxError(format!("{what} at position {}", self.position))
    }

    fn skip_space(&mut self) {
        while let Some(byte) = self.bytes.get(self.position) {
            if matches!(byte, b' ' | b'\t' | b'\n' | b'\r') {
                self.position += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn literal(&mut self, word: &str, value: Js) -> Result<Js, SyntaxError> {
        if self.text[self.position..].starts_with(word) {
            self.position += word.len();
            Ok(value)
        } else {
            Err(self.error("Unexpected token"))
        }
    }

    fn number(&mut self) -> Result<Js, SyntaxError> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(self.error("No number after minus sign")),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("Unterminated fractional number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("Exponent part is missing a number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        // Грамматика числа JSON — подмножество грамматики `f64` в Rust, и
        // разбор Rust округляет точно, как V8; переполнение даёт бесконечность.
        let number = self.text[start..self.position].parse::<f64>().map_err(|_| self.error("Invalid number"))?;
        Ok(Js::Number(number))
    }

    fn hex4(&mut self) -> Result<u16, SyntaxError> {
        let digits = self.text.get(self.position..self.position + 4).ok_or_else(|| self.error("Bad Unicode escape"))?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(self.error("Bad Unicode escape"));
        }
        self.position += 4;
        u16::from_str_radix(digits, 16).map_err(|_| self.error("Bad Unicode escape"))
    }

    fn string(&mut self) -> Result<String, SyntaxError> {
        // Открывающая кавычка уже проверена.
        self.position += 1;
        let mut out = String::new();
        let mut pending_high: Option<u16> = None;
        loop {
            let Some(byte) = self.peek() else {
                return Err(self.error("Unterminated string in JSON"));
            };
            if byte == b'\\' {
                self.position += 1;
                let Some(escape) = self.peek() else {
                    return Err(self.error("Bad escaped character"));
                };
                self.position += 1;
                let unit = match escape {
                    b'"' => Some('"'),
                    b'\\' => Some('\\'),
                    b'/' => Some('/'),
                    b'b' => Some('\u{8}'),
                    b'f' => Some('\u{c}'),
                    b'n' => Some('\n'),
                    b'r' => Some('\r'),
                    b't' => Some('\t'),
                    b'u' => None,
                    _ => return Err(self.error("Bad escaped character")),
                };
                match unit {
                    Some(ch) => {
                        if pending_high.take().is_some() {
                            out.push('\u{FFFD}');
                        }
                        out.push(ch);
                    }
                    None => {
                        let code = self.hex4()?;
                        match code {
                            0xD800..=0xDBFF => {
                                if pending_high.replace(code).is_some() {
                                    out.push('\u{FFFD}');
                                }
                            }
                            0xDC00..=0xDFFF => match pending_high.take() {
                                Some(high) => {
                                    let scalar = 0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(code) - 0xDC00);
                                    out.push(char::from_u32(scalar).unwrap_or('\u{FFFD}'));
                                }
                                None => out.push('\u{FFFD}'),
                            },
                            _ => {
                                if pending_high.take().is_some() {
                                    out.push('\u{FFFD}');
                                }
                                out.push(char::from_u32(u32::from(code)).unwrap_or('\u{FFFD}'));
                            }
                        }
                    }
                }
                continue;
            }
            if pending_high.take().is_some() {
                out.push('\u{FFFD}');
            }
            if byte == b'"' {
                self.position += 1;
                return Ok(out);
            }
            if byte < 0x20 {
                return Err(self.error("Bad control character in string literal"));
            }
            // Символ целиком (вход — корректный UTF-8).
            let ch = self.text[self.position..].chars().next().ok_or_else(|| self.error("Unterminated string in JSON"))?;
            out.push(ch);
            self.position += ch.len_utf8();
        }
    }
}

/// Пары объекта в порядке JS: ключи-индексы по возрастанию, затем остальные.
fn js_ordered(entries: IndexMap<String, Js>) -> Vec<(String, Js)> {
    let (mut indexed, named): (Vec<(String, Js)>, Vec<(String, Js)>) = entries.into_iter().partition(|(key, _)| js::is_array_index_key(key));
    indexed.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indexed.extend(named);
    indexed
}

/// `JSON.parse(text)`. Разбор итеративный: глубина ограничена только памятью,
/// как у V8.
pub(crate) fn parse(text: &str) -> Result<Js, SyntaxError> {
    let mut parser = Parser { bytes: text.as_bytes(), text, position: 0 };
    let mut stack: Vec<Container> = Vec::new();
    loop {
        // Ожидается значение: в корне, после `[`, `,` или `:`. Узел глубже
        // предела (или внутри фантомного контейнера) не строится.
        parser.skip_space();
        let real = stack.len() < JS_STACK_DEPTH && !matches!(stack.last(), Some(Container::Phantom { .. }));
        let mut finished = match parser.peek() {
            Some(b'{') => {
                parser.position += 1;
                stack.push(if real { Container::Object { entries: IndexMap::new(), key: None } } else { Container::Phantom { is_array: false } });
                parser.skip_space();
                if parser.peek() != Some(b'}') {
                    expect_key(&mut parser, &mut stack)?;
                    continue;
                }
                parser.position += 1;
                close(stack.pop())
            }
            Some(b'[') => {
                parser.position += 1;
                stack.push(if real { Container::Array(Vec::new()) } else { Container::Phantom { is_array: true } });
                parser.skip_space();
                if parser.peek() != Some(b']') {
                    continue;
                }
                parser.position += 1;
                close(stack.pop())
            }
            Some(b'"') => Js::String(parser.string()?),
            Some(b't') => parser.literal("true", Js::Bool(true))?,
            Some(b'f') => parser.literal("false", Js::Bool(false))?,
            Some(b'n') => parser.literal("null", Js::Null)?,
            Some(b'-' | b'0'..=b'9') => parser.number()?,
            Some(_) => return Err(parser.error("Unexpected token")),
            None => return Err(parser.error("Unexpected end of JSON input")),
        };
        if !real {
            finished = Js::TooDeep;
        }
        // Законченное значение встаёт в родителя; закрывающие скобки сворачивают
        // контейнеры вверх, пока родитель не ждёт следующего элемента.
        loop {
            let Some(top) = stack.last_mut() else {
                parser.skip_space();
                if parser.position != parser.bytes.len() {
                    return Err(parser.error("Unexpected non-whitespace character after JSON"));
                }
                return Ok(finished);
            };
            let is_array = match top {
                Container::Array(items) => {
                    items.push(finished);
                    true
                }
                Container::Object { entries, key } => {
                    entries.insert(key.take().unwrap_or_default(), finished);
                    false
                }
                Container::Phantom { is_array } => *is_array,
            };
            parser.skip_space();
            match parser.peek() {
                Some(b',') => {
                    parser.position += 1;
                    if !is_array {
                        parser.skip_space();
                        expect_key(&mut parser, &mut stack)?;
                    }
                    break;
                }
                Some(b']') if is_array => {
                    parser.position += 1;
                    finished = close(stack.pop());
                }
                Some(b'}') if !is_array => {
                    parser.position += 1;
                    finished = close(stack.pop());
                }
                Some(_) => return Err(parser.error("Unexpected token")),
                None => return Err(parser.error("Unexpected end of JSON input")),
            }
        }
    }
}

/// Закрытый контейнер — значение для родителя; фантомный даёт `TooDeep`.
fn close(container: Option<Container>) -> Js {
    match container {
        Some(Container::Array(items)) => Js::Array(items),
        Some(Container::Object { entries, .. }) => Js::Object(js_ordered(entries)),
        Some(Container::Phantom { .. }) | None => Js::TooDeep,
    }
}

/// После `{` или `,` в объекте: ключ-строка и `:`.
fn expect_key(parser: &mut Parser<'_>, stack: &mut [Container]) -> Result<(), SyntaxError> {
    if parser.peek() != Some(b'"') {
        return Err(parser.error("Expected double-quoted property name"));
    }
    let name = parser.string()?;
    parser.skip_space();
    if parser.peek() != Some(b':') {
        return Err(parser.error("Expected ':' after property name"));
    }
    parser.position += 1;
    if let Some(Container::Object { key, .. }) = stack.last_mut() {
        *key = Some(name);
    }
    Ok(())
}

/// `JSON.stringify(value, null, 2)`: отступ в два пробела, числа и порядок
/// ключей как в JS.
pub(crate) fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, level: usize, out: &mut String) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push('\n');
                indent(level + 1, out);
                write_pretty(item, level + 1, out);
            }
            out.push('\n');
            indent(level, out);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (index, (key, item)) in js::entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push('\n');
                indent(level + 1, out);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                write_pretty(item, level + 1, out);
            }
            out.push('\n');
            indent(level, out);
            out.push('}');
        }
        other => out.push_str(&sk_narration_base::jsx::stringify(other)),
    }
}

fn indent(level: usize, out: &mut String) {
    for _ in 0..level {
        out.push_str("  ");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(text: &str) -> Value {
        parse(text).expect("json").into_value()
    }

    #[test]
    fn parse_follows_v8_order_and_numbers() {
        assert_eq!(sk_narration_base::jsx::stringify(&value(r#"{"b":1,"10":2.0,"a":{"x":1,"2":2},"1":-0,"b":3}"#)), r#"{"1":0,"10":2,"b":3,"a":{"2":2,"x":1}}"#);
        assert_eq!(sk_narration_base::jsx::stringify(&value("12345678901234567890")), "12345678901234567000");
        assert_eq!(parse("1e400").expect("json"), Js::Number(f64::INFINITY));
        assert_eq!(parse("[-1e400]").expect("json"), Js::Array(vec![Js::Number(f64::NEG_INFINITY)]));
        assert_eq!(value(r#""\ud83d\ude00\u0041\n""#), json!("😀A\n"));
        assert_eq!(value(r#""\ud800x""#), json!("\u{FFFD}x"));
        assert_eq!(value(r#"{"__proto__":{"a":1}}"#), json!({ "__proto__": { "a": 1 } }));
    }

    #[test]
    fn parse_rejects_what_v8_rejects() {
        for text in [
            "", " ", "{", "[1,]", "{\"a\":1,}", "01", "+1", ".5", "5.", "1e", "NaN", "Infinity", "undefined", "'a'", "{a:1}", "\"\t\"", "[1] x", "{\"a\" 1}", "\u{FEFF}{}", "tru", "nul", "[1 2]", "\"\\x\"", "\"\\u12\"", "\u{A0}1",
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }
        for text in ["0", "-0", "1.5e-3", " \t\r\n[ ] ", "\"\u{2028}\"", "{\"\":\"\"}", "[[],{}]", "true", "null"] {
            assert!(parse(text).is_ok(), "{text:?}");
        }
    }

    #[test]
    fn deep_nesting_marks_nodes_beyond_v8_stack() {
        let depth = JS_STACK_DEPTH + 3;
        let text = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        let mut node = parse(&text).expect("json");
        let mut level = 1;
        while let Js::Array(mut items) = node {
            level += 1;
            node = if items.is_empty() { break } else { items.remove(0) };
        }
        assert_eq!(node, Js::TooDeep);
        assert_eq!(level, JS_STACK_DEPTH + 1);
        assert!(parse(&format!("{}1{}", "[".repeat(100_000), "]".repeat(99_999))).is_err(), "синтаксис проверяется и глубже предела");
    }

    #[test]
    fn pretty_matches_json_stringify_with_indent() {
        let state = json!({ "schema_version": 1, "day": "2026-08-02", "campaigns": { "ALFA": { "generations": 2.0, "alerted": false }, "1": {}, "E": [] , "L": [1, [2]] } });
        assert_eq!(
            stringify_pretty(&state),
            "{\n  \"schema_version\": 1,\n  \"day\": \"2026-08-02\",\n  \"campaigns\": {\n    \"1\": {},\n    \"ALFA\": {\n      \"generations\": 2,\n      \"alerted\": false\n    },\n    \"E\": [],\n    \"L\": [\n      1,\n      [\n        2\n      ]\n    ]\n  }\n}"
        );
    }
}
