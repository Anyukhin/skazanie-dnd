//! Раздача собранного клиента — `serveStatic` (`server/index.mjs:3798–3833`):
//! файлы из `dist/`, неизвестный путь — `index.html` (маршруты клиента),
//! слабый ETag по размеру и времени, вечный кэш для собранных vite-чанков с
//! хешем, час — для `public/`. Отвечает на **любой** метод (6478): не-API
//! `POST`/`DELETE` с разрешённого источника получают клиента, как в JS.
//! Без `dist` — 404 «Сначала выполните pnpm build», битый процентный код
//! пути — 400 «Некорректный путь».

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

/// `resolve(dist, requested)` с проверкой «внутри `dist`» (3803–3804):
/// `..` разбирается лексически, выход за `dist` и абсолютный путь — `None`.
fn inside(dist: &Path, requested: &str) -> Option<PathBuf> {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let mut path = dist.to_path_buf();
    path.extend(parts);
    Some(path)
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

fn parse_http_date(text: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let month = MONTHS.iter().position(|month| *month == parts[2])? + 1;
    sk_core::clock::parse_iso(&format!("{}-{month:02}-{}T{}Z", parts[3], parts[1], parts[4]))
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
    let none_match = headers.get(header::IF_NONE_MATCH).and_then(|value| value.to_str().ok()).unwrap_or("");
    let fresh = if !none_match.is_empty() {
        none_match.split(',').any(|tag| tag.trim() == etag)
    } else {
        headers
            .get(header::IF_MODIFIED_SINCE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_http_date)
            .is_some_and(|since| since >= (modified_ms as i64 / 1000) * 1000)
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

    #[test]
    fn paths_stay_inside_dist() {
        let dist = Path::new("dist");
        assert!(inside(dist, "../secret").is_none());
        assert_eq!(inside(dist, "assets/../favicon.png"), Some(PathBuf::from("dist/favicon.png")), "`..` внутри dist разбирается, как resolve");
        assert_eq!(inside(dist, "assets/a.js"), Some(PathBuf::from("dist/assets/a.js")));
    }
}
