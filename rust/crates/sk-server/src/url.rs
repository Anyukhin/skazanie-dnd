//! Разбор адреса запроса так, как его видит `server/index.mjs`.
//!
//! - [`pathname`] — `new URL(req.url || '/', 'http://skazanie.local').pathname`
//!   (3920, 4027): разбор `.`/`..` (и `%2e`), `\` как `/`, «схемная» форма
//!   `//хост/путь`, процентное кодирование набора пути WHATWG; ошибка разбора —
//!   как исключение `new URL` (отказ всего запроса 500).
//! - [`decode_uri_component`] — `decodeURIComponent`: `None` там, где JS
//!   бросает `URIError`.
//! - [`origin_host`] — `new URL(origin).host` для `originAllowed` (2266).
//! - [`search_param`] — `url.searchParams.get(name)`.
//!
//! Hyper сам отвергает часть сырых адресов (пробелы, `\`, управляющие
//! символы) ещё до сервера; разбор ниже повторяет JS и для них — на случай
//! другого транспорта и ради тестов.

/// Специальные схемы WHATWG и их порты по умолчанию.
fn special_default_port(scheme: &str) -> Option<Option<u16>> {
    match scheme {
        "http" | "ws" => Some(Some(80)),
        "https" | "wss" => Some(Some(443)),
        "ftp" => Some(Some(21)),
        "file" => Some(None),
        _ => None,
    }
}

/// Набор процентного кодирования пути (Node 24, ada): C0, пробел, `"`, `#`,
/// `<`, `>`, `?`, `^`, `` ` ``, `{`, `}` и всё выше U+007E.
fn path_encodes(byte: u8) -> bool {
    byte < 0x21 || byte > 0x7E || matches!(byte, b'"' | b'#' | b'<' | b'>' | b'?' | b'^' | b'`' | b'{' | b'}')
}

fn single_dot(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn double_dot(segment: &str) -> bool {
    matches!(segment.to_ascii_lowercase().as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
}

/// Разбор пути специальной схемы (состояние «path» WHATWG), вход — без
/// ведущего разделителя не требуется: `/a/b` и `a/b` дают одно и то же.
fn normalize_path(raw: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    let body = raw.strip_prefix(['/', '\\']).unwrap_or(raw);
    let parts: Vec<&str> = body.split(['/', '\\']).collect();
    let last = parts.len().saturating_sub(1);
    for (index, part) in parts.iter().enumerate() {
        let at_end = index == last;
        if double_dot(part) {
            segments.pop();
            if at_end {
                segments.push(String::new());
            }
        } else if single_dot(part) {
            if at_end {
                segments.push(String::new());
            }
        } else {
            let mut encoded = String::with_capacity(part.len());
            for byte in part.bytes() {
                if path_encodes(byte) {
                    encoded.push_str(&format!("%{byte:02X}"));
                } else {
                    encoded.push(byte as char);
                }
            }
            segments.push(encoded);
        }
    }
    format!("/{}", segments.join("/"))
}

/// Удаление того, что парсер URL выкидывает до разбора: ведущие и
/// завершающие C0 и пробелы, все табуляции и переводы строк.
fn strip_input(input: &str) -> String {
    let trimmed = input.trim_matches(|ch: char| ch <= ' ');
    trimmed.chars().filter(|ch| !matches!(ch, '\t' | '\n' | '\r')).collect()
}

/// Хост и порт из полномочия (`user@host:port`); `None` — `new URL` бросил бы.
fn parse_authority(authority: &str, special: Option<Option<u16>>) -> Option<String> {
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, rest)| rest);
    let (host, port) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let rest = &host_port[close + 1..];
        let port = match rest.strip_prefix(':') {
            Some(port) => Some(port),
            None if rest.is_empty() => None,
            None => return None,
        };
        (&host_port[..=close], port)
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        }
    };
    let port = match port {
        Some("") | None => None,
        Some(digits) => {
            if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let value: u32 = digits.trim_start_matches('0').parse().unwrap_or(0);
            if value > 65_535 {
                return None;
            }
            Some(value as u16)
        }
    };
    if special.is_some() && host.is_empty() {
        return None;
    }
    let forbidden = |ch: char| matches!(ch, ' ' | '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '\\' | '^' | '|') || ch < ' ' || ch == '\u{7f}';
    let bare = host.strip_prefix('[').and_then(|host| host.strip_suffix(']'));
    match bare {
        Some(inner) => {
            if inner.is_empty() || !inner.chars().all(|ch| ch.is_ascii_hexdigit() || ch == ':' || ch == '.') {
                return None;
            }
        }
        None => {
            if host.contains(['[', ']']) || host.chars().any(forbidden) {
                return None;
            }
        }
    }
    let host = if special.is_some() { host.to_lowercase() } else { host.to_string() };
    let default_port = special.flatten();
    Some(match port {
        Some(port) if Some(port) != default_port => format!("{host}:{port}"),
        _ => host,
    })
}

/// `new URL(raw, 'http://skazanie.local').pathname`; `None` — исключение.
pub fn pathname(raw: &str) -> Option<String> {
    let input = strip_input(if raw.is_empty() { "/" } else { raw });
    let before_query = input.split(['?', '#']).next().unwrap_or("");
    // Абсолютная форма: `схема:` в начале.
    if let Some((scheme, rest)) = split_scheme(&input) {
        let special = special_default_port(&scheme);
        if special.is_none() {
            // Чужая схема: путь непрозрачный, как его вернул бы URL.
            let rest = rest.split(['?', '#']).next().unwrap_or("");
            return Some(match rest.strip_prefix("//") {
                Some(after) => after.find('/').map_or_else(String::new, |index| after[index..].to_string()),
                None => rest.to_string(),
            });
        }
        let rest = rest.split(['?', '#']).next().unwrap_or("");
        let after = rest.trim_start_matches(['/', '\\']);
        let end = after.find(['/', '\\']).unwrap_or(after.len());
        parse_authority(&after[..end], special)?;
        return Some(normalize_path(&after[end..]));
    }
    // Относительная «схемная» форма `//хост/путь`.
    if before_query.starts_with("//") || before_query.starts_with("\\\\") || before_query.starts_with("/\\") || before_query.starts_with("\\/") {
        let after = before_query.trim_start_matches(['/', '\\']);
        let end = after.find(['/', '\\']).unwrap_or(after.len());
        parse_authority(&after[..end], Some(Some(80)))?;
        return Some(normalize_path(&after[end..]));
    }
    if before_query.starts_with(['/', '\\']) {
        return Some(normalize_path(before_query));
    }
    // Относительный путь от `/` базы.
    Some(normalize_path(&format!("/{before_query}")))
}

/// `схема:` в начале строки: буква, затем буквы, цифры, `+`, `-`, `.`.
fn split_scheme(input: &str) -> Option<(String, &str)> {
    let colon = input.find(':')?;
    let scheme = &input[..colon];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() || !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.')) {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), &input[colon + 1..]))
}

/// `new URL(origin).host`; `None` — `new URL` бросил бы.
pub fn origin_host(origin: &str) -> Option<String> {
    let input = strip_input(origin);
    let (scheme, rest) = split_scheme(&input)?;
    let special = special_default_port(&scheme);
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    match special {
        Some(_) => {
            let after = rest.trim_start_matches(['/', '\\']);
            let end = after.find(['/', '\\']).unwrap_or(after.len());
            if scheme == "file" {
                return Some(after[..end].to_lowercase());
            }
            parse_authority(&after[..end], special)
        }
        None => match rest.strip_prefix("//") {
            Some(after) => {
                let end = after.find('/').unwrap_or(after.len());
                parse_authority(&after[..end], None)
            }
            None => Some(String::new()),
        },
    }
}

/// `decodeURIComponent(text)`; `None` — `URIError`.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let high = (hex[0] as char).to_digit(16)?;
            let low = (hex[1] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    // Rust отвергает те же последовательности, что и JS: обрывы, лишние
    // байты продолжения, «длинные» формы и закодированные суррогаты.
    String::from_utf8(out).ok()
}

/// Декодирование `application/x-www-form-urlencoded` (`URLSearchParams`):
/// `+` — пробел, битые `%xx` остаются как есть, битый UTF-8 — U+FFFD.
fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' => {
                let decoded = bytes.get(index + 1..index + 3).and_then(|hex| {
                    let high = (hex[0] as char).to_digit(16)?;
                    let low = (hex[1] as char).to_digit(16)?;
                    Some((high * 16 + low) as u8)
                });
                match decoded {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Строка запроса сырого адреса (без `?`), `None` — её нет.
pub fn query(raw: &str) -> Option<&str> {
    let without_fragment = raw.split('#').next().unwrap_or("");
    without_fragment.split_once('?').map(|(_, query)| query)
}

/// `url.searchParams.get(name)`: первое значение или `None`.
pub fn search_param(raw: &str, name: &str) -> Option<String> {
    query(raw)?.split('&').filter(|pair| !pair.is_empty()).find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (form_decode(key) == name).then(|| form_decode(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Эталон — `new URL(input, 'http://skazanie.local').pathname` в Node 24.14.
    #[test]
    fn pathname_matches_whatwg() {
        let cases: &[(&str, Option<&str>)] = &[
            ("/", Some("/")),
            ("/api/health", Some("/api/health")),
            ("/api/health?x=1", Some("/api/health")),
            ("/api/x/../rooms/ABC", Some("/api/rooms/ABC")),
            ("/api/./health", Some("/api/health")),
            ("/api/%2e%2E/api/health", Some("/api/health")),
            ("/a/.%2e/b", Some("/b")),
            ("/a/b/..", Some("/a/")),
            ("/a/b/.", Some("/a/b/")),
            ("/a//b", Some("/a//b")),
            ("/a\\b", Some("/a/b")),
            ("//api/health", Some("/health")),
            ("///api/health", Some("/health")),
            ("//host:80/x", Some("/x")),
            ("//host:x/x", None),
            ("//", None),
            ("//[/x", None),
            ("/a b", Some("/a%20b")),
            ("/a\"b", Some("/a%22b")),
            ("/a<b>", Some("/a%3Cb%3E")),
            ("/a`b", Some("/a%60b")),
            ("/a{b}", Some("/a%7Bb%7D")),
            ("/a^b", Some("/a%5Eb")),
            ("/a|b", Some("/a|b")),
            ("/a\u{1}b", Some("/a%01b")),
            ("/привет", Some("/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82")),
            ("/a#frag", Some("/a")),
            ("/a?b#c", Some("/a")),
            ("/a%zz", Some("/a%zz")),
            ("http://foo/api/health", Some("/api/health")),
            ("/a/%2E", Some("/a/")),
            ("/..", Some("/")),
            ("/../..", Some("/")),
            ("/a/..%2f", Some("/a/..%2f")),
            ("/a/%2e%2e%2fb", Some("/a/%2e%2e%2fb")),
            ("//user@host/p", Some("/p")),
            ("//h%20x/p", None),
            ("//é/p", Some("/p")),
            ("/a\tb", Some("/ab")),
            (" /a", Some("/a")),
            ("/a ", Some("/a")),
            ("/a\nb", Some("/ab")),
            ("//host:65536/x", None),
            ("//host:/x", Some("/x")),
            ("//a@b@c/x", Some("/x")),
            ("/a'b", Some("/a'b")),
            ("/a[b]", Some("/a[b]")),
            ("/%", Some("/%")),
            ("/a%2", Some("/a%2")),
            ("//host:080/x", Some("/x")),
            ("", Some("/")),
        ];
        for (input, expected) in cases {
            assert_eq!(pathname(input).as_deref(), *expected, "{input:?}");
        }
    }

    #[test]
    fn decode_matches_decode_uri_component() {
        assert_eq!(decode_uri_component("%E0"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%C3%A9").as_deref(), Some("é"));
        assert_eq!(decode_uri_component("%ED%A0%80"), None, "закодированный суррогат");
        assert_eq!(decode_uri_component("%C0%AF"), None, "длинная форма");
        assert_eq!(decode_uri_component("a%2Fb").as_deref(), Some("a/b"));
        assert_eq!(decode_uri_component("%F0%9F%98%80").as_deref(), Some("😀"));
        assert_eq!(decode_uri_component("%f0%9f%98"), None);
    }

    #[test]
    fn origin_host_like_new_url() {
        assert_eq!(origin_host("http://LocalHost:8787").as_deref(), Some("localhost:8787"));
        assert_eq!(origin_host("https://example.com:443").as_deref(), Some("example.com"));
        assert_eq!(origin_host("http://example.com:80/x").as_deref(), Some("example.com"));
        assert_eq!(origin_host("null"), None);
        assert_eq!(origin_host("http://"), None);
        assert_eq!(origin_host("chrome-extension://abc").as_deref(), Some("abc"));
    }

    #[test]
    fn search_params() {
        assert_eq!(search_param("/x?after=5&after=6", "after").as_deref(), Some("5"));
        assert_eq!(search_param("/x?map_hash=a+b%20c", "map_hash").as_deref(), Some("a b c"));
        assert_eq!(search_param("/x?flag", "flag").as_deref(), Some(""));
        assert_eq!(search_param("/x", "flag"), None);
        assert_eq!(search_param("/x?bad=%zz", "bad").as_deref(), Some("%zz"));
    }
}
