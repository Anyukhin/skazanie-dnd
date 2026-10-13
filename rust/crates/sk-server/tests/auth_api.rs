//! HTTP-путь входа: регистрация, cookie сессии, `me`, выход, права
//! администратора, отказ чужому источнику, неизвестный API и раздача клиента.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use sk_server::{app, AppState, Config};
use tower::ServiceExt;

fn state(dir: &std::path::Path) -> Arc<AppState> {
    std::fs::create_dir_all(dir.join("dist").join("assets")).expect("dist");
    std::fs::write(dir.join("dist").join("index.html"), "<!doctype html><title>Сказание</title>").expect("index");
    std::fs::write(dir.join("dist").join("assets").join("main-abcdef12.js"), "console.log(1)").expect("чанк");
    let config = Config {
        host: "127.0.0.1".into(),
        port: 0,
        storage_dir: dir.join("storage"),
        dist_dir: dir.join("dist"),
        admin_setup_token: "setup-code".into(),
        cookie_secure: false,
    };
    Arc::new(AppState::open(config).expect("состояние"))
}

async fn call(state: &Arc<AppState>, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let response = app(state.clone()).oneshot(request).await.expect("ответ");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 10_000_000).await.expect("тело");
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()));
    (status, headers, body)
}

fn post(path: &str, body: Value, cookie: Option<&str>) -> Request<Body> {
    let mut builder = Request::post(path).header(header::CONTENT_TYPE, "application/json").header(header::HOST, "localhost:8787");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    builder.body(Body::from(body.to_string())).expect("запрос")
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut builder = Request::get(path);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    builder.body(Body::empty()).expect("запрос")
}

fn session_cookie(headers: &axum::http::HeaderMap) -> String {
    let raw = headers.get(header::SET_COOKIE).expect("cookie").to_str().expect("строка");
    assert!(raw.contains("HttpOnly; SameSite=Lax; Max-Age=2592000"), "{raw}");
    raw.split(';').next().expect("пара").to_string()
}

#[tokio::test]
async fn register_login_me_and_logout() {
    let dir = tempfile::tempdir().expect("каталог");
    let state = state(dir.path());
    let (status, _, body) = call(&state, get("/api/auth/me", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "user": null, "setupRequired": true }));

    let (status, _, body) = call(&state, post("/api/auth/setup-admin", json!({ "email": "gm@mail.ru", "password": "длинный-пароль", "setupToken": "wrong" }), None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "Неверный код первоначальной настройки");
    let (status, headers, body) = call(&state, post("/api/auth/setup-admin", json!({ "email": "gm@mail.ru", "password": "длинный-пароль", "setupToken": "setup-code" }), None)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["user"]["role"], "admin");
    let admin_cookie = session_cookie(&headers);

    let (status, headers, body) = call(&state, post("/api/auth/register", json!({ "email": "hero@mail.ru", "password": "длинный-пароль", "name": "Аня" }), None)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["user"]["name"], "Аня");
    let player_cookie = session_cookie(&headers);
    let (_, _, me) = call(&state, get("/api/auth/me", Some(&player_cookie))).await;
    assert_eq!(me["user"]["email"], "hero@mail.ru");
    assert_eq!(me["setupRequired"], false);

    let (status, _, body) = call(&state, post("/api/auth/login", json!({ "email": "hero@mail.ru", "password": "не-тот-пароль" }), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "Неверная почта или пароль");
    let (status, headers, _) = call(&state, post("/api/auth/login", json!({ "email": "HERO@mail.ru", "password": "длинный-пароль" }), None)).await;
    assert_eq!(status, StatusCode::OK);
    let second_cookie = session_cookie(&headers);

    let (status, _, _) = call(&state, get("/api/admin/users", Some(&player_cookie))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, body) = call(&state, get("/api/admin/users", Some(&admin_cookie))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["users"].as_array().map(Vec::len), Some(2));

    let (status, headers, _) = call(&state, post("/api/auth/logout", json!({}), Some(&player_cookie))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.get(header::SET_COOKIE).expect("cookie").to_str().expect("строка").contains("Max-Age=0"));
    let (_, _, me) = call(&state, get("/api/auth/me", Some(&player_cookie))).await;
    assert_eq!(me["user"], Value::Null, "вышедшая сессия больше не пускает");
    let (_, _, me) = call(&state, get("/api/auth/me", Some(&second_cookie))).await;
    assert_eq!(me["user"]["email"], "hero@mail.ru", "другие входы того же игрока живут");
}

#[tokio::test]
async fn boundaries_origin_body_unknown_api_and_static() {
    let dir = tempfile::tempdir().expect("каталог");
    let state = state(dir.path());
    let foreign = Request::post("/api/auth/register")
        .header(header::HOST, "localhost:8787")
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::from("{}"))
        .expect("запрос");
    let (status, headers, body) = call(&state, foreign).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "Запрос с другого источника отклонён");
    assert_eq!(headers.get("x-content-type-options").expect("заголовок"), "nosniff");

    let (status, _, body) = call(&state, Request::post("/api/auth/register").body(Body::from("[1]")).expect("запрос")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "Тело запроса должно быть JSON-объектом");

    let (status, _, body) = call(&state, get("/api/nope", None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "API endpoint не найден");

    let (status, headers, body) = call(&state, get("/campaign/ABC", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get(header::CACHE_CONTROL).expect("кэш"), "no-cache");
    assert!(body.as_str().expect("html").contains("Сказание"));
    let (status, headers, _) = call(&state, get("/assets/main-abcdef12.js", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get(header::CACHE_CONTROL).expect("кэш"), "public, max-age=31536000, immutable");
    let etag = headers.get(header::ETAG).expect("etag").clone();
    let cached = Request::get("/assets/main-abcdef12.js").header(header::IF_NONE_MATCH, etag).body(Body::empty()).expect("запрос");
    let (status, _, _) = call(&state, cached).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    let (status, _, _) = call(&state, get("/../Cargo.toml", None)).await;
    assert_eq!(status, StatusCode::OK, "выход за dist отдаёт клиент, а не файл");
}
