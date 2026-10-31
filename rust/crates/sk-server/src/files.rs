//! С12: отдача файлов картинок — `serveGenerated`, `serveNpcPortrait`,
//! `serveGeneratedImage` (`server/index.mjs:3835–3884`).
//!
//! Ответы с файлом пишутся мимо `json(...)`: в них нет заголовков CORS и
//! `no-store`, только свои (`res.writeHead`); заголовки безопасности
//! добавляет диспетчер, как `applySecurityHeaders` в начале обработчика JS.
//!
//! - `/generated/items/:file` — тело потоком без `Content-Length`, как
//!   `createReadStream(file).pipe(res)` (кодирование по кускам);
//! - портрет и иллюстрация из кеша — с `Content-Length` (`statSync`), `ETag`
//!   и ответом 304 на совпавший `If-None-Match` (строгое сравнение строки).

use std::path::{Path, PathBuf};

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use serde_json::Value;
use sk_chargen::npc_portraits::StaticNpcPortrait;

use crate::error::{ApiError, ApiResult};

/// Ответ с заголовками; недопустимое значение заголовка — необработанная
/// ошибка (в JS `writeHead` бросает `ERR_INVALID_CHAR` внутри `try` маршрута).
fn response(status: StatusCode, headers: &[(&str, String)], body: Body) -> Result<Response<Body>, String> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?;
        let value = HeaderValue::from_str(value).map_err(|_| format!("Invalid character in header content [\"{name}\"]"))?;
        response.headers_mut().append(name, value);
    }
    Ok(response)
}

/// `/^[a-f0-9-]+\.(png|webp|jpe?g)$/i`.
fn generated_name_allowed(name: &str) -> bool {
    let Some((stem, extension)) = name.split_once('.') else { return false };
    let extension = extension.to_ascii_lowercase();
    !stem.is_empty() && stem.chars().all(|ch| matches!(ch.to_ascii_lowercase(), 'a'..='f' | '0'..='9' | '-')) && matches!(extension.as_str(), "png" | "webp" | "jpg" | "jpeg")
}

/// `serveGenerated(req, res)` (3835–3842): `tail` — адрес после
/// `/generated/items/` вместе со строкой запроса (`req.url.split('?')[0]`).
///
/// Тип файла JS выбирает по `name.endsWith('.webp')` с учётом регистра, хотя
/// регулярка имени регистр не различает: `A1.WEBP` уходит как `image/jpeg`.
/// Повторено как есть (замечено в JS).
pub async fn serve_generated(generated_dir: &Path, tail: &str) -> ApiResult {
    let name = tail.split('?').next().unwrap_or("");
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, "Файл не найден");
    if !generated_name_allowed(name) {
        return Err(not_found());
    }
    let file = generated_dir.join(name);
    if !file.exists() {
        return Err(not_found());
    }
    // В JS ошибка чтения уже существующего пути (каталог с таким именем)
    // приходит событием потока после заголовков; здесь — 500 границы.
    let bytes = tokio::fs::read(&file).await.map_err(|error| ApiError::internal(format!("{}: {error}", file.display())))?;
    let content_type = if name.ends_with(".webp") {
        "image/webp"
    } else if name.ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    let body = Body::from_stream(futures_util::stream::once(async move { Ok::<Bytes, std::io::Error>(Bytes::from(bytes)) }));
    let headers = [("Content-Type", content_type.to_string()), ("Cache-Control", "public, max-age=31536000, immutable".to_string())];
    response(StatusCode::OK, &headers, body).map_err(ApiError::internal)
}

/// `String(value)` адреса заглушки для заголовка `Location`. Свойство
/// прототипа (`NPC_PORTRAIT_CHARACTER_ASSETS[id]` для id `toString`,
/// `constructor`…) — функция, и Node пишет её текст `function toString() {
/// [native code] }`; `__proto__` — `Object.prototype`, `[object Object]`.
pub(crate) fn location_text(url: Option<&Value>, npc_id: &str) -> String {
    match url {
        Some(Value::String(text)) => text.clone(),
        Some(other) => sk_core::js::s(Some(other)),
        None => {
            let name = if npc_id == "constructor" { "Object" } else { npc_id };
            format!("function {name}() {{ [native code] }}")
        }
    }
}

/// `serveNpcPortrait(req, res, portrait)` для заглушки (3844–3855): 302 на
/// ролевую или предзаготовленную картинку. `npc_id` — id профиля (для
/// адреса-свойства прототипа).
pub fn serve_static_portrait(portrait: &StaticNpcPortrait, npc_id: &str) -> Result<Response<Body>, String> {
    let headers = [
        ("Location", location_text(portrait.url.as_ref(), npc_id)),
        ("Cache-Control", "private, no-store".to_string()),
        ("Vary", "Cookie".to_string()),
        ("X-NPC-Portrait-Source", "static".to_string()),
        ("X-NPC-Portrait-Role", portrait.role.to_string()),
        ("X-NPC-Portrait-Reason", portrait.reason.to_string()),
    ];
    response(StatusCode::FOUND, &headers, Body::empty())
}

/// Картинка из кеша кампании для [`serve_generated_image`].
pub struct CachedImage<'a> {
    pub file_path: &'a PathBuf,
    pub etag: &'a str,
    pub cache_hit: bool,
}

/// `serveGeneratedImage(req, res, image, headerPrefix, cacheControl)`
/// (3864–3884): `source` у сгенерированной картинки — всегда `generated`,
/// тип — `image/webp`.
pub async fn serve_generated_image(request_headers: &HeaderMap, image: CachedImage<'_>, header_prefix: &str, cache_control: &str) -> Result<Response<Body>, String> {
    let source = format!("{header_prefix}-Source");
    let cache = format!("{header_prefix}-Cache");
    let mut headers: Vec<(&str, String)> = vec![
        ("ETag", image.etag.to_string()),
        ("Cache-Control", cache_control.to_string()),
        ("Vary", "Cookie".to_string()),
        (source.as_str(), "generated".to_string()),
        (cache.as_str(), if image.cache_hit { "hit" } else { "miss" }.to_string()),
    ];
    if crate::http::header_text(request_headers, "if-none-match") == image.etag {
        return response(StatusCode::NOT_MODIFIED, &headers, Body::empty());
    }
    let bytes = tokio::fs::read(image.file_path).await.map_err(|error| error.to_string())?;
    headers.push(("Content-Type", "image/webp".to_string()));
    headers.push((header::CONTENT_LENGTH.as_str(), bytes.len().to_string()));
    response(StatusCode::OK, &headers, Body::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn generated_names_follow_js_regex() {
        for good in ["abc-123.webp", "ABC.PNG", "0.jpg", "f.JPEG"] {
            assert!(generated_name_allowed(good), "{good}");
        }
        for bad in ["", ".webp", "abc.gif", "g.webp", "a.b.webp", "../a.webp", "a.webp.png", "a.jpgx"] {
            assert!(!generated_name_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn prototype_locations_print_like_node() {
        assert_eq!(location_text(Some(&json!("/assets/x.png")), "x"), "/assets/x.png");
        assert_eq!(location_text(Some(&json!({})), "__proto__"), "[object Object]");
        assert_eq!(location_text(None, "constructor"), "function Object() { [native code] }");
        assert_eq!(location_text(None, "toString"), "function toString() { [native code] }");
    }
}
