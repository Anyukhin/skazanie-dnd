//! Текст по правилам JS: `normalize('NFKC')`, `trim()`, `slice()`,
//! `toLocaleLowerCase('ru-RU')`, `localeCompare`, регулярные выражения.
//!
//! JS считает длину строки в единицах UTF-16; здесь — в символах Unicode. Для
//! кириллицы и латиницы это одно и то же; расходятся только символы вне BMP
//! (эмодзи), которых в правилах и репликах игры нет.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// `text.normalize('NFKC')`.
pub fn nfkc(text: &str) -> String {
    text.nfkc().collect()
}

/// `text.normalize('NFC')`.
pub fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// Пробельный символ по `String.prototype.trim` (WhiteSpace + LineTerminator,
/// включая BOM, которого нет в `char::is_whitespace`).
pub fn is_js_space(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{FEFF}'
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

/// `text.trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// `text.toLocaleLowerCase('ru-RU')` и `toLowerCase()`.
pub fn lower(text: &str) -> String {
    text.to_lowercase()
}

/// `text.toLocaleUpperCase('ru-RU')` и `toUpperCase()`.
pub fn upper(text: &str) -> String {
    text.to_uppercase()
}

/// Длина строки (`text.length`) в символах.
pub fn len(text: &str) -> usize {
    text.chars().count()
}

fn clamp_index(index: i64, length: usize) -> usize {
    let length = length as i64;
    (if index < 0 { (length + index).max(0) } else { index.min(length) }) as usize
}

/// `text.slice(start, end)` с отрицательными индексами, по символам.
pub fn slice(text: &str, start: i64, end: Option<i64>) -> String {
    let length = len(text);
    let from = clamp_index(start, length);
    let to = end.map_or(length, |end| clamp_index(end, length));
    if to <= from {
        return String::new();
    }
    text.chars().skip(from).take(to - from).collect()
}

/// `text.slice(0, limit)`.
pub fn head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Частая форма JS: `String(value ?? '').normalize('NFKC').trim().slice(0, max)`.
pub fn clean(value: Option<&Value>, max: usize) -> String {
    head(trim(&nfkc(&crate::js::s(value))), max)
}

/// `clean` и затем `toLocaleLowerCase('ru-RU')`.
pub fn clean_lower(value: Option<&Value>, max: usize) -> String {
    lower(&clean(value, max))
}

/// Схлопнуть пробелы: `text.replace(/\s+/g, ' ').trim()`.
pub fn squash_spaces(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if is_js_space(ch) {
            space = true;
        } else {
            if space && !result.is_empty() {
                result.push(' ');
            }
            space = false;
            result.push(ch);
        }
    }
    result
}

/// `text.charAt(0).toUpperCase() + text.slice(1)`.
pub fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), CollatorOptions::default()).expect("сопоставитель строк ICU")
});

/// `a.localeCompare(b)` (корневая сортировка ICU, как у Node без локали).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    COLLATOR.compare(a, b)
}

const ASCII_WORD: &str = "A-Za-z0-9_";

/// Источник регулярного выражения JS в синтаксисе `fancy_regex`.
///
/// В JS `\b`, `\B`, `\w`, `\W`, `\d`, `\D` — только ASCII даже с флагом `u`,
/// а в Rust — Unicode; здесь они раскрываются в ASCII-классы и lookaround.
/// `\/` и `\-` вне класса становятся обычными символами, `\u{…}` — `\x{…}`.
/// Флаги: `i`, `m`, `s` — префиксом `(?ims)`; `g`, `u`, `y` значения не имеют.
pub fn js_regex_source(pattern: &str, flags: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 16);
    let inline: String = flags.chars().filter(|flag| matches!(flag, 'i' | 'm' | 's')).collect();
    if !inline.is_empty() {
        out.push_str("(?");
        out.push_str(&inline);
        out.push(')');
    }
    let word_class = format!("[{ASCII_WORD}]");
    let boundary = format!("(?:(?<={word_class})(?!{word_class})|(?<!{word_class})(?={word_class}))");
    let non_boundary = format!("(?:(?<={word_class})(?={word_class})|(?<!{word_class})(?!{word_class}))");
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                let Some(next) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match (next, in_class) {
                    ('w', false) => out.push_str(&word_class),
                    ('W', false) => out.push_str(&format!("[^{ASCII_WORD}]")),
                    ('d', false) => out.push_str("[0-9]"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('w', true) => out.push_str(ASCII_WORD),
                    ('d', true) => out.push_str("0-9"),
                    ('b', false) => out.push_str(&boundary),
                    ('B', false) => out.push_str(&non_boundary),
                    ('/', _) => out.push('/'),
                    ('-', false) => out.push('-'),
                    ('u', _) if chars.peek() == Some(&'{') => out.push_str("\\x"),
                    _ => {
                        out.push('\\');
                        out.push(next);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                let negated = chars.peek() == Some(&'^');
                if negated {
                    chars.next();
                }
                // В JS `[]` — пустой класс, `[^]` — любой символ.
                if chars.peek() == Some(&']') {
                    chars.next();
                    in_class = false;
                    out.push_str(if negated { "(?s:.)" } else { "[^\\s\\S]" });
                } else {
                    out.push_str(if negated { "[^" } else { "[" });
                }
            }
            '[' => out.push_str("\\["),
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Скомпилированное регулярное выражение JS, созданное один раз:
/// `re!(r"…")` или `re!(r"…", "iu")` с флагами JS. Синтаксис — JS (`\b`,
/// `\w`, `\d` — ASCII), перевод — [`js_regex_source`]; движок — `fancy_regex`
/// (lookbehind, обратные ссылки).
#[macro_export]
macro_rules! re {
    ($pattern:expr) => {
        $crate::re!($pattern, "")
    };
    ($pattern:expr, $flags:expr) => {{
        static RE: ::std::sync::LazyLock<$crate::fancy_regex::Regex> = ::std::sync::LazyLock::new(|| {
            $crate::fancy_regex::Regex::new(&$crate::text::js_regex_source($pattern, $flags)).expect("регулярное выражение")
        });
        &*RE
    }};
}

/// Регулярное выражение JS, собранное во время работы (`new RegExp(source, flags)`).
pub fn js_regex(pattern: &str, flags: &str) -> Option<fancy_regex::Regex> {
    fancy_regex::Regex::new(&js_regex_source(pattern, flags)).ok()
}

/// Экранировать текст для вставки в регулярное выражение.
pub fn escape_regex(text: &str) -> String {
    fancy_regex::escape(text).into_owned()
}

/// `regex.test(text)`; ошибка движка (переполнение возвратов) — «нет».
pub fn test(regex: &fancy_regex::Regex, text: &str) -> bool {
    regex.is_match(text).unwrap_or(false)
}

/// `text.replace(regex_g, replacement)` — все вхождения; `$1` в замене работает,
/// `$&` из JS пишется как `${0}`.
pub fn replace_all(regex: &fancy_regex::Regex, text: &str, replacement: &str) -> String {
    regex.replace_all(text, replacement).into_owned()
}

/// `text.replace(regex, replacement)` — первое вхождение.
pub fn replace_first(regex: &fancy_regex::Regex, text: &str, replacement: &str) -> String {
    regex.replace(text, replacement).into_owned()
}

/// Группа первого совпадения (`text.match(regex)?.[group]`).
pub fn capture(regex: &fancy_regex::Regex, text: &str, group: usize) -> Option<String> {
    regex.captures(text).ok().flatten().and_then(|captures| captures.get(group).map(|m| m.as_str().to_string()))
}

/// Все совпадения целиком (`text.match(regex_g) ?? []`).
pub fn find_all(regex: &fancy_regex::Regex, text: &str) -> Vec<String> {
    regex.find_iter(text).filter_map(Result::ok).map(|m| m.as_str().to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_follows_js() {
        assert_eq!(slice("привет", 1, Some(3)), "ри");
        assert_eq!(slice("привет", -2, None), "ет");
        assert_eq!(slice("привет", 4, Some(2)), "");
        assert_eq!(head("привет", 3), "при");
    }

    #[test]
    fn regex_macro_follows_js_syntax() {
        let word = re!(r"(?<!\p{L})крыс[аы]?(?!\p{L})", "iu");
        assert!(test(word, "Большая Крыса"));
        assert!(!test(word, "Крысолов"));
        let ascii = re!(r"\bsword\b", "i");
        assert!(test(ascii, "long Sword"));
        assert!(!test(ascii, "longsword"));
        // \b в JS — граница ASCII-слова: вокруг кириллицы её нет.
        assert!(!test(re!(r"\bмеч\b"), "меч"));
        assert!(test(re!(r"^[\w-]+$"), "a-b_1"));
        assert!(!test(re!(r"^\w+$"), "меч"));
        assert!(test(re!(r"^a\/b$"), "a/b"));
        assert!(test(re!(r"^[^]$"), "\n"));
        assert_eq!(replace_all(re!(r"\s+", "g"), "a  b", " "), "a b");
        assert_eq!(capture(re!(r"(\d+)\s*фут"), "на 30 футов", 1).as_deref(), Some("30"));
    }

    #[test]
    fn locale_compare_follows_icu_root() {
        assert_eq!(locale_compare("арбалет", "Булава"), Ordering::Less);
        assert_eq!(locale_compare("a", "B"), Ordering::Less);
        // В корневой сортировке ICU «ё» отличается от «е» только вторично.
        assert_eq!(locale_compare("ель", "ёж"), Ordering::Greater);
        assert_eq!(locale_compare("ель", "ёль"), Ordering::Less);
    }

    #[test]
    fn clean_normalizes_trims_and_cuts() {
        assert_eq!(clean(Some(&Value::String("  Ｍеч  ".into())), 3), "Mеч");
        assert_eq!(squash_spaces("  a \n\t b  "), "a b");
    }
}
