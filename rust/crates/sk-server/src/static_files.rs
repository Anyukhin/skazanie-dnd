//! Раздача собранного клиента — `serveStatic` (`server/index.mjs:3798–3833`):
//! файлы из `dist/`, неизвестный путь — `index.html` (маршруты клиента),
//! слабый ETag по размеру и времени, вечный кэш для собранных vite-чанков с
//! хешем, час — для `public/`. Отвечает на **любой** метод (6478): не-API
//! `POST`/`DELETE` с разрешённого источника получают клиента, как в JS.
//! Без `dist` — 404 «Сначала выполните pnpm build», битый процентный код
//! пути — 400 «Некорректный путь».
//!
//! Свежесть: `If-None-Match` и `If-Modified-Since` читаются как
//! `req.headers[...]` ([`crate::http::header_text`]: latin1, повторы
//! `If-None-Match` склеены через `, `). Дату разбирает [`parse_http_date`] —
//! совместимо с `Date.parse` для форматов HTTP (IMF-fixdate, RFC 850,
//! asctime), ISO и смещений зоны (`GMT+0300`, `-0500`). **Отклонение:** дату
//! без зоны V8 читает в местном времени процесса, здесь — в UTC; прочие
//! вольные формы `Date.parse` (`11/06/1994` без года и т. п.) не
//! поддерживаются и дают «не свежий» ответ 200 вместо 304.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};

use crate::http::error;

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// Лексическая нормализация, как `path.resolve`: `.` выбрасывается, `..`
/// снимает предыдущий обычный компонент (выше корня не поднимается).
fn normalize(path: &Path) -> PathBuf {
    let mut parts: Vec<Component<'_>> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match parts.last() {
                Some(Component::Normal(_)) => {
                    parts.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => parts.push(component),
            },
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

/// `resolve(dist, requested)` с проверкой «внутри `dist`» (3803–3804):
/// путь собирается от `dist` (абсолютный `requested` его заменяет, как в
/// `resolve`), нормализуется целиком — вместе с компонентами самого `dist`
/// — и только потом сравнивается с `dist` по компонентам
/// (`file.startsWith(dist + sep)`). Поэтому `x/../../dist/a.js` попадает
/// внутрь, а `../secret` — нет.
fn inside(dist: &Path, requested: &str) -> Option<PathBuf> {
    let root = normalize(dist);
    let file = normalize(&dist.join(requested));
    file.starts_with(&root).then_some(file)
}

fn http_date(seconds: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let iso = sk_core::clock::iso(seconds as i64 * 1000);
    let year = &iso[0..4];
    let month: usize = iso[5..7].parse().unwrap_or(1);
    let day = &iso[8..10];
    let time = &iso[11..19];
    let weekday = DAYS[((seconds / 86_400) % 7) as usize];
    format!("{weekday}, {day} {} {year} {time} GMT", MONTHS[month - 1])
}

/// Смещение зоны `+0300`, `-05`, `+03:00` в минутах.
fn zone_offset(text: &str) -> Option<i64> {
    let (sign, rest) = match text.as_bytes().first()? {
        b'+' => (1, &text[1..]),
        b'-' => (-1, &text[1..]),
        _ => return None,
    };
    let digits: String = rest.chars().filter(|ch| *ch != ':').collect();
    if digits.is_empty() || digits.len() > 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: i64 = digits.parse().ok()?;
    let (hours, minutes) = if digits.len() <= 2 { (value, 0) } else { (value / 100, value % 100) };
    Some(sign * (hours * 60 + minutes))
}

/// `Date.parse(text)` для дат HTTP (см. шапку модуля); `None` — `NaN`.
pub fn parse_http_date(text: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(ms) = sk_core::clock::parse_iso(text) {
        return Some(ms);
    }
    // Комментарии в скобках V8 пропускает.
    let mut cleaned = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => cleaned.push(ch),
            _ => {}
        }
    }
    let (mut month, mut numbers, mut time, mut offset) = (None::<usize>, Vec::<i64>::new(), None::<(i64, i64, i64)>, None::<i64>);
    for token in cleaned.split(|ch: char| ch.is_whitespace() || ch == ',').filter(|token| !token.is_empty()) {
        let lower = token.to_ascii_lowercase();
        if let Some(minutes) = zone_offset(token) {
            offset = Some(minutes);
            continue;
        }
        if let Some(zone) = ["gmt", "utc", "ut", "z"].iter().find(|zone| lower.starts_with(**zone)) {
            let rest = &token[zone.len()..];
            offset = Some(if rest.is_empty() { 0 } else { zone_offset(rest)? });
            continue;
        }
        if token.contains(':') {
            let parts: Vec<&str> = token.split(':').collect();
            if parts.len() > 3 || parts.iter().any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit())) {
                return None;
            }
            let number = |index: usize| parts.get(index).map_or(Some(0), |part| part.parse::<i64>().ok());
            time = Some((number(0)?, number(1)?, number(2)?));
            continue;
        }
        for part in token.split(['-', '/']).filter(|part| !part.is_empty()) {
            if part.bytes().all(|byte| byte.is_ascii_digit()) {
                numbers.push(part.parse().ok()?);
            } else {
                let word = part.to_ascii_lowercase();
                if let Some(index) = MONTHS.iter().position(|name| word.starts_with(name)) {
                    month = Some(index + 1);
                } else if !WEEKDAYS.iter().any(|name| word.starts_with(name)) {
                    return None;
                }
            }
        }
    }
    let (month, day, year) = match (month, numbers.as_slice()) {
        (Some(month), [first, second]) if *first > 31 => (month as i64, *second, *first),
        (Some(month), [day, year]) => (month as i64, *day, *year),
        (None, [month, day, year]) => (*month, *day, *year),
        _ => return None,
    };
    let year = match year {
        0..=49 => year + 2000,
        50..=99 => year + 1900,
        _ => year,
    };
    let (hours, minutes, seconds) = time.unwrap_or((0, 0, 0));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..=9999).contains(&year) || hours > 24 || minutes > 59 || seconds > 59 {
        return None;
    }
    let utc = sk_core::clock::parse_iso(&format!("{year:04}-{month:02}-{day:02}T00:00:00Z"))?;
    Some(utc + ((hours * 60 + minutes) * 60 + seconds) * 1000 - offset.unwrap_or(0) * 60_000)
}

/// Ответ на не-API путь (`req.url` как есть).
pub fn serve(dist: &Path, raw_path: &str, headers: &HeaderMap) -> Response<Body> {
    if !dist.exists() {
        return error(StatusCode::NOT_FOUND, "Сначала выполните pnpm build");
    }
    let requested = if raw_path == "/" {
        "index.html".to_string()
    } else {
        match crate::url::decode_uri_component(raw_path.split('?').next().unwrap_or("")) {
            Some(path) => path.trim_start_matches('/').to_string(),
            None => return error(StatusCode::BAD_REQUEST, "Некорректный путь"),
        }
    };
    let index = dist.join("index.html");
    let file = inside(dist, &requested).filter(|path| path.is_file()).unwrap_or_else(|| index.clone());
    // Без `index.html` в `dist` JS падает на `statSync` — необработанная ошибка, 500.
    let metadata = match std::fs::metadata(&file) {
        Ok(metadata) => metadata,
        Err(failure) => {
            eprintln!("[Сказание] Необработанная ошибка раздачи клиента: {failure}");
            return crate::error::ApiError::internal(failure.to_string()).into_response();
        }
    };
    let modified_ms = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |duration| duration.as_millis() as u64);
    let etag = format!("W/\"{:x}-{:x}\"", metadata.len(), modified_ms);
    let immutable = sk_core::text::test(sk_core::re!(r"^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$"), &requested);
    let cache_control = if file == index {
        "no-cache"
    } else if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    let last_modified = http_date(modified_ms / 1000);
    // `String(req.headers['if-none-match'] || '')`, `Date.parse(req.headers['if-modified-since'] || '')` (3825–3826).
    let none_match = crate::http::header_text(headers, "if-none-match");
    let fresh = if !none_match.is_empty() {
        none_match.split(',').any(|tag| sk_core::text::trim(tag) == etag)
    } else {
        parse_http_date(&crate::http::header_text(headers, "if-modified-since")).is_some_and(|since| since >= (modified_ms as i64 / 1000) * 1000)
    };
    let mut response = if fresh {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(failure) => {
                eprintln!("[Сказание] Необработанная ошибка раздачи клиента: {failure}");
                return crate::error::ApiError::internal(failure.to_string()).into_response();
            }
        };
        let mut response = Response::new(Body::from(bytes));
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&file)));
        response
    };
    let out = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&etag) {
        out.insert(header::ETAG, value);
    }
    if let Ok(value) = HeaderValue::from_str(&last_modified) {
        out.insert(header::LAST_MODIFIED, value);
    }
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_dates_round_trip() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:10 GMT"), Some(10_000));
    }

    /// Эталон — `Date.parse(...)` в Node 24 (`TZ=UTC` для даты без зоны).
    #[test]
    fn http_dates_like_date_parse() {
        let cases: &[(&str, Option<i64>)] = &[
            ("Sun, 06 Nov 1994 08:49:37 GMT", Some(784_111_777_000)),
            ("Sunday, 06-Nov-94 08:49:37 GMT", Some(784_111_777_000)),
            ("Sun Nov  6 08:49:37 1994", Some(784_111_777_000)),
            ("1994-11-06T08:49:37Z", Some(784_111_777_000)),
            ("1994-11-06T11:49:37+03:00", Some(784_111_777_000)),
            ("Sun, 06 Nov 1994 11:49:37 GMT+0300", Some(784_111_777_000)),
            ("Sun, 06 Nov 1994 03:49:37 -0500", Some(784_111_777_000)),
            ("Sun, 06 Nov 1994 08:49:37 GMT (UTC)", Some(784_111_777_000)),
            ("", None),
            ("вчера", None),
            ("Sun, 06 Nov 1994 25:00:00 GMT", None),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_http_date(input), *expected, "{input:?}");
        }
    }

    #[test]
    fn paths_stay_inside_dist() {
        let root = std::env::temp_dir().join("sk-root");
        let dist = root.join("dist");
        assert!(inside(&dist, "../secret").is_none());
        assert_eq!(inside(&dist, "assets/../favicon.png"), Some(dist.join("favicon.png")), "`..` внутри dist разбирается, как resolve");
        assert_eq!(inside(&dist, "assets/a.js"), Some(dist.join("assets").join("a.js")));
        assert_eq!(inside(&dist, "x/../../dist/assets/a.js"), Some(dist.join("assets").join("a.js")), "выход и возврат в dist — как resolve");
        assert!(inside(&dist, "../dist-other/a.js").is_none(), "сосед с тем же префиксом имени — снаружи");
        assert_eq!(inside(&dist, ""), Some(dist.clone()), "сам dist — каталог, дальше index.html");
        let absolute = dist.join("assets").join("a.js");
        assert_eq!(inside(&dist, &absolute.to_string_lossy()), Some(absolute.clone()), "абсолютный путь внутрь dist — как resolve");
        assert!(inside(&dist, &root.join("secret").to_string_lossy()).is_none());
    }
}
