//! Обязательные тесты каркаса С0 (`rust/SERVER-PLAN.md` §1 с поправками
//! рецензии §3): диспетчер в порядке JS, граница ошибок, тело запроса,
//! пределы, вход и админка через новый диспетчер, настройки ИИ кампании.

mod kit;

use std::net::SocketAddr;

use axum::http::{Method, StatusCode};
use kit::{Options, Req, TestServer};
use serde_json::{json, Value};
use sk_server::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx, RouteFuture};
use sk_server::http::json as json_response;

const API_NOT_FOUND: &str = "API endpoint не найден";

// --- тестовые маршруты (вставляются в таблицу через `Injected::extra_routes`) ---

fn panic_route(_ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if std::hint::black_box(true) {
            panic!("сбой тестового маршрута");
        }
        Ok(json_response(StatusCode::OK, &json!({})))
    })
}

fn core_panic_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let outcome: Result<(), _> = ctx.state.core.call(|_core| Box::pin(async move { panic!("сбой задания ядра") })).await;
        outcome?;
        Ok(json_response(StatusCode::OK, &json!({})))
    })
}

fn core_alive_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let version = ctx.state.core.call(|core| Box::pin(async move { core.events.list_campaigns().map(|list| list.len()).unwrap_or(0) })).await?;
        Ok(json_response(StatusCode::OK, &json!({ "campaigns": version })))
    })
}

fn echo_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let body = ctx.json_body().await?;
        Ok(json_response(StatusCode::OK, &body))
    })
}

fn param_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move { Ok(json_response(StatusCode::OK, &json!({ "id": ctx.param(0), "pathname": ctx.pathname }))) })
}

fn ai_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        use sk_narration_base::campaign_ai_context::current_campaign_model;
        let direct = current_campaign_model();
        let core = ctx.state.core.call(|_core| Box::pin(async move { current_campaign_model() })).await?;
        let blocking = sk_server::core::blocking(current_campaign_model).await?;
        Ok(json_response(StatusCode::OK, &json!({ "direct": direct, "core": core, "blocking": blocking })))
    })
}

/// Как `map-import`: маршрут на любой метод, сам отвечает 405.
fn only_post_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if ctx.method != Method::POST {
            return Ok(json_response(StatusCode::METHOD_NOT_ALLOWED, &json!({ "error": "Метод не поддерживается" })));
        }
        Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
    })
}

/// Как боевой стенд: знакомый путь — ответ, незнакомый — дальше по таблице.
fn lab_route(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        if ctx.pathname == "/api/test/lab/scenarios" {
            return Ok(Some(json_response(StatusCode::OK, &json!({ "scenarios": [] }))));
        }
        Ok(None)
    })
}

fn test_routes() -> Vec<Route> {
    vec![
        Route::get(1, Matcher::path("/api/test/panic"), panic_route),
        Route::get(1, Matcher::path("/api/test/core-panic"), core_panic_route),
        Route::get(1, Matcher::path("/api/test/core-alive"), core_alive_route),
        Route::post(1, Matcher::path("/api/test/echo"), echo_route),
        Route::get(1, Matcher::path_template("/api/test/rooms/{id}"), param_route),
        Route::get(1, Matcher::path_template("/api/campaigns/{id}/test-ai"), ai_route),
        Route::get(1, Matcher::path("/api/test/ai"), ai_route),
        Route::new(1, Methods::Any, Matcher::path_template("/api/test/campaigns/{id}/map-import"), only_post_route),
        Route::pass(1, Methods::Any, Matcher::path_prefix("/api/test/lab/"), lab_route),
    ]
}

async fn server() -> TestServer {
    TestServer::start_with(Options { extra_routes: test_routes(), ..Options::default() }).await
}

#[tokio::test]
async fn wrong_method_is_api_404_not_405() {
    let server = server().await;
    let mut client = server.client();
    for (method, target) in [("GET", "/api/auth/login"), ("DELETE", "/api/auth/me"), ("PUT", "/api/admin/users"), ("HEAD", "/api/auth/me"), ("GET", "/api/nope")] {
        let response = client.send(Req::new(method, target)).await;
        assert_eq!(response.status, 404, "{method} {target}");
        if method != "HEAD" {
            assert_eq!(response.json(), json!({ "error": API_NOT_FOUND }), "{method} {target}");
        }
    }
}

#[tokio::test]
async fn health_answers_any_method() {
    let server = server().await;
    let mut client = server.client();
    for method in ["GET", "HEAD", "POST", "PUT", "DELETE"] {
        let response = client.send(Req::new(method, "/api/health")).await;
        assert_eq!(response.status, 200, "{method} /api/health");
    }
    let body = client.get("/api/health").await.json();
    assert_eq!(body["provider"], "RouterAI");
    assert_eq!(body["configured"], false, "ключа модели в тестах нет");
    assert_eq!(body["engineMode"], "enforce");
}

/// Пятнадцать сырых маршрутов JS (`req.url === …`): со строкой запроса — 404
/// API. Для реализованных положительный контроль — тот же метод и путь без
/// строки запроса доходят до маршрута. Флаг «реализован» включает задача,
/// которая переносит маршрут: С4 — `admin/usage`, `speech/*`; С10 —
/// `rooms/:id/dice`, `/api/roll`; С12 — `generate-image`; С18.5 — `narrate`.
#[tokio::test]
async fn raw_routes_with_query_are_404() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let raw: [(&str, &str, bool); 15] = [
        ("GET", "/api/health", true),
        ("GET", "/api/admin/usage", false),
        ("GET", "/api/speech/status", false),
        ("POST", "/api/speech/transcribe", false),
        ("GET", "/api/auth/me", true),
        ("POST", "/api/auth/setup-admin", true),
        ("POST", "/api/auth/register", true),
        ("POST", "/api/auth/login", true),
        ("POST", "/api/auth/logout", true),
        ("GET", "/api/admin/users", true),
        ("PATCH", "/api/admin/users/abc-1", true),
        ("POST", "/api/rooms/ABC/dice", false),
        ("POST", "/api/roll", false),
        ("POST", "/api/items/generate-image", false),
        ("POST", "/api/narrate", false),
    ];
    for (method, path, implemented) in raw {
        let target = format!("{path}?x=1");
        let response = admin.send(Req::new(method, &target).json(&json!({}))).await;
        assert_eq!(response.status, 404, "{method} {target}");
        assert_eq!(response.json(), json!({ "error": API_NOT_FOUND }), "{method} {target}");
        if implemented && path != "/api/auth/logout" {
            let direct = admin.send(Req::new(method, path).json(&json!({}))).await;
            assert_ne!(direct.json(), json!({ "error": API_NOT_FOUND }), "без строки запроса маршрут на месте: {method} {path}");
        }
    }
    let logout = admin.send(Req::new("POST", "/api/auth/logout").json(&json!({}))).await;
    assert_eq!(logout.json(), json!({ "ok": true }), "выход — последним, чтобы не потерять сессию админа");
}

/// llhttp пропускает только свои методы в верхнем регистре; прочие — голый 400
/// до обработчика (без JSON и проверки источника).
#[tokio::test]
async fn unknown_methods_are_400_like_llhttp() {
    let server = server().await;
    let mut client = server.client();
    for (method, target) in [("foo", "/api/health"), ("post", "/api/auth/login"), ("FOO", "/campaign/ABC"), ("patch", "/api/campaigns/ABC/merchants/%E0")] {
        let response = client.send(Req::new(method, target)).await;
        assert_eq!(response.status, 400, "{method} {target}");
        assert!(response.body.is_empty(), "{method} {target}: тело пустое");
        assert_eq!(response.header("x-content-type-options"), None, "до handleHttpRequest заголовков безопасности нет");
    }
    assert_eq!(client.send(Req::new("PURGE", "/api/health")).await.status, 200, "метод из списка llhttp доходит до health");
}

/// **Отклонение** (шапка `dispatch.rs`): крейт `http` отрезает фрагмент `#…`
/// до диспетчера. В Node `GET /api/health#x` — 404 API, а чанк с `#x` —
/// `index.html`; здесь фрагмента нет вовсе.
#[tokio::test]
async fn fragment_is_dropped_by_http_parser() {
    let server = server().await;
    let mut client = server.client();
    assert_eq!(client.get("/api/health#x").await.status, 200);
    let chunk = client.get("/assets/main-abcdef12.js#x").await;
    assert_eq!(chunk.text(), "console.log(1)");
    assert_eq!(chunk.header("cache-control"), Some("public, max-age=31536000, immutable"));
}

#[tokio::test]
async fn panic_is_500_and_next_request_passes() {
    let server = server().await;
    let mut client = server.client();
    let internal = json!({ "error": "Внутренняя ошибка сервера", "code": "INTERNAL_ERROR" });
    let response = client.get("/api/test/panic").await;
    assert_eq!(response.status, 500);
    assert_eq!(response.json(), internal);
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"), "заголовки безопасности ставятся и на 500");
    assert_eq!(client.get("/api/health").await.status, 200, "сервер жив после паники маршрута");
    let response = client.get("/api/test/core-panic").await;
    assert_eq!(response.status, 500);
    assert_eq!(response.json(), internal);
    let alive = client.get("/api/test/core-alive").await;
    assert_eq!(alive.status, 200, "ядро живо после паники задания: {}", alive.text());
}

#[tokio::test]
async fn body_must_be_json_object() {
    let server = server().await;
    let mut client = server.client();
    for raw in ["null", "[]", "42", "\"x\"", "true"] {
        let response = client.post_raw("/api/test/echo", raw).await;
        assert_eq!(response.status, 400, "{raw}");
        assert_eq!(response.json(), json!({ "error": "Тело запроса должно быть JSON-объектом", "code": "INVALID_JSON_BODY" }), "{raw}");
    }
    let broken = client.post_raw("/api/test/echo", "{").await;
    assert_eq!(broken.json(), json!({ "error": "Некорректный JSON в запросе", "code": "INVALID_JSON" }));
    let empty = client.post_raw("/api/test/echo", "").await;
    assert_eq!(empty.json(), json!({}), "пустое тело — пустой объект");
    // Печать чисел — как JSON.stringify.
    let numbers = client.post_raw("/api/test/echo", r#"{"n":5.0,"b":1e21,"c":-0.0,"d":0.1}"#).await;
    assert_eq!(numbers.text(), r#"{"n":5,"b":1e+21,"c":0,"d":0.1}"#);
    // Вход принимает `null` как `{}` (3995): ответ — неверный пароль, а не 400.
    let login = client.post_raw("/api/auth/login", "null").await;
    assert_eq!(login.status, 401);
    assert_eq!(login.json(), json!({ "error": "Неверная почта или пароль" }));
    // Регистрация ловит ошибку тела своим `try`: 400 без кода.
    let register = client.post_raw("/api/auth/register", "null").await;
    assert_eq!(register.status, 400);
    assert_eq!(register.json(), json!({ "error": "Тело запроса должно быть JSON-объектом" }));
}

#[tokio::test]
async fn body_limit_counts_utf16_units() {
    let server = server().await;
    let mut client = server.client();
    // `{"t":"…"}` — восемь единиц обёртки; кириллица — одна единица UTF-16, два байта UTF-8.
    let body = |units: usize| format!("{{\"t\":\"{}\"}}", "й".repeat(units - 8));
    let fits = client.post_raw("/api/test/echo", body(1_000_000)).await;
    assert_eq!(fits.status, 200, "ровно миллион единиц (≈2 МБ) — можно");
    let over = client.post_raw("/api/test/echo", body(1_000_001)).await;
    assert_eq!(over.status, 400);
    assert_eq!(over.json(), json!({ "error": "Слишком большой запрос", "code": "REQUEST_TOO_LARGE" }));
    let huge = client.post_raw("/api/test/echo", vec![b' '; 4 * 1024 * 1024 + 10]).await;
    assert_eq!(huge.status, 400, "сверх потолка 4 МБ");
    assert_eq!(huge.json()["code"], "REQUEST_TOO_LARGE");
}

/// Боевой цикл соединений (`sk_server::serve`) кладёт адрес сокета в
/// запрос: двадцать неудачных входов с `127.0.0.1` закрывают вход именно
/// этому адресу, а не всем (`'unknown'` при потерянном `ConnectInfo`).
#[tokio::test]
async fn login_rate_limit_over_tcp_uses_socket_address() {
    use tower::ServiceExt;
    let server = server().await;
    let mut client = server.client();
    for attempt in 0..20 {
        assert_eq!(client.post("/api/auth/login", &json!({})).await.status, 401, "попытка {attempt}");
    }
    let limited = client.post("/api/auth/login", &json!({})).await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.json(), json!({ "error": "Слишком много попыток. Попробуйте позже" }));
    let request = |address: SocketAddr| {
        let mut request = axum::http::Request::post("/api/auth/login").header("content-type", "application/json").body(axum::body::Body::from("{}")).expect("запрос");
        request.extensions_mut().insert(axum::extract::ConnectInfo(address));
        request
    };
    let same_ip = sk_server::app(server.state.clone()).oneshot(request(SocketAddr::from(([127, 0, 0, 1], 1)))).await.expect("ответ");
    assert_eq!(same_ip.status(), StatusCode::TOO_MANY_REQUESTS, "окно TCP-клиента — по адресу 127.0.0.1, без порта");
    let unknown = sk_server::app(server.state.clone()).oneshot(axum::http::Request::post("/api/auth/login").body(axum::body::Body::from("{}")).expect("запрос")).await.expect("ответ");
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED, "окно 'unknown' не тронуто: адрес сокета не потерян");
}

#[tokio::test]
async fn login_rate_limit_per_connect_info_address() {
    use tower::ServiceExt;
    let server = server().await;
    let request = |address: SocketAddr| {
        let mut request = axum::http::Request::post("/api/auth/login").header("content-type", "application/json").body(axum::body::Body::from("{}")).expect("запрос");
        request.extensions_mut().insert(axum::extract::ConnectInfo(address));
        request
    };
    let first: SocketAddr = SocketAddr::from(([10, 0, 0, 1], 4000));
    let second: SocketAddr = SocketAddr::from(([10, 0, 0, 2], 4000));
    for attempt in 0..20 {
        let response = sk_server::app(server.state.clone()).oneshot(request(first)).await.expect("ответ");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "попытка {attempt}");
    }
    let limited = sk_server::app(server.state.clone()).oneshot(request(first)).await.expect("ответ");
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let bytes = axum::body::to_bytes(limited.into_body(), 1 << 20).await.expect("тело");
    assert_eq!(serde_json::from_slice::<Value>(&bytes).ok(), Some(json!({ "error": "Слишком много попыток. Попробуйте позже" })));
    let other = sk_server::app(server.state.clone()).oneshot(request(second)).await.expect("ответ");
    assert_eq!(other.status(), StatusCode::UNAUTHORIZED, "у другого адреса своё окно");
}

#[tokio::test]
async fn register_login_me_and_logout() {
    let server = server().await;
    let mut anonymous = server.client();
    assert_eq!(anonymous.get("/api/auth/me").await.json(), json!({ "user": null, "setupRequired": true }));
    let wrong = anonymous.post("/api/auth/setup-admin", &json!({ "email": "gm@mail.ru", "password": "длинный-пароль", "setupToken": "wrong" })).await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.json(), json!({ "error": "Неверный код первоначальной настройки" }));

    let mut admin = server.client();
    let admin_user = admin.setup_admin().await;
    assert_eq!(admin_user["role"], "admin");
    let mut player = server.client();
    let player_user = player.register("hero@mail.ru").await;
    let me = player.get("/api/auth/me").await.json();
    assert_eq!(me["user"]["email"], "hero@mail.ru");
    assert_eq!(me["setupRequired"], false);

    let mut second = server.client();
    let bad = second.post("/api/auth/login", &json!({ "email": "hero@mail.ru", "password": "не-тот-пароль" })).await;
    assert_eq!(bad.status, 401);
    let good = second.post("/api/auth/login", &json!({ "email": "HERO@mail.ru", "password": "длинный-пароль" })).await;
    assert_eq!(good.status, 200);
    let cookie = good.header("set-cookie").unwrap_or_default().to_string();
    assert!(cookie.contains("HttpOnly; SameSite=Lax; Max-Age=2592000"), "{cookie}");

    assert_eq!(player.get("/api/admin/users").await.status, 403);
    let users = admin.get("/api/admin/users").await;
    assert_eq!(users.status, 200);
    assert_eq!(users.json()["users"].as_array().map(Vec::len), Some(2));

    let token = player.cookies.get("skazanie_session").cloned().unwrap_or_default();
    let logout = player.post("/api/auth/logout", &json!({})).await;
    assert_eq!(logout.status, 200);
    assert_eq!(logout.json(), json!({ "ok": true }));
    assert!(logout.header("set-cookie").unwrap_or_default().contains("Max-Age=0"));
    let revoked = server.streams.revoked.lock().map(|list| list.clone()).unwrap_or_default();
    assert_eq!(revoked, vec![sk_store::accounts::Accounts::session_key_for_token(&token)], "выход закрывает потоки своей сессии");
    assert_eq!(player.get("/api/auth/me").await.json()["user"], Value::Null);
    assert_eq!(second.get("/api/auth/me").await.json()["user"]["id"], player_user["id"], "другие входы того же игрока живут");
}

/// `String(name || '')` (`store.mjs:121`): `0` и `false` — пустое имя,
/// значит имя — локальная часть почты.
#[tokio::test]
async fn falsy_body_fields_are_empty_strings() {
    let server = server().await;
    let mut client = server.client();
    for (email, name) in [("zero@mail.ru", json!(0)), ("off@mail.ru", json!(false))] {
        let created = client.post("/api/auth/register", &json!({ "email": email, "password": "длинный-пароль", "name": name })).await;
        assert_eq!(created.status, 201, "{}", created.text());
        assert_eq!(created.json()["user"]["name"], email.split('@').next().unwrap_or_default());
    }
    let zero_password = client.post("/api/auth/register", &json!({ "email": "z@mail.ru", "password": 1234567890 })).await;
    assert_eq!(zero_password.status, 201, "число — строка «1234567890»");
    let no_password = client.post("/api/auth/register", &json!({ "email": "n@mail.ru", "password": 0 })).await;
    assert_eq!(no_password.json(), json!({ "error": "Пароль должен содержать не менее 10 символов" }));
}

#[tokio::test]
async fn admin_patches_user_access() {
    let server = server().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let mut player = server.client();
    let user = player.register("hero@mail.ru").await;
    let id = user["id"].as_str().unwrap_or_default().to_string();

    let path = format!("/api/admin/users/{id}");
    let forbidden = player.send(Req::new("PATCH", &path).json(&json!({ "role": "admin" }))).await;
    assert_eq!(forbidden.status, 403);
    assert_eq!(forbidden.json(), json!({ "error": "Требуются права администратора" }));

    let updated = admin.send(Req::new("PATCH", &path).json(&json!({ "heroIds": ["hero-a", null, "bad id"], "name": "  Борис  ", "engineMode": null }))).await;
    assert_eq!(updated.status, 200, "{}", updated.text());
    let body = updated.json();
    assert_eq!(body["user"]["heroIds"], json!(["hero-a", "null"]), "`map(String)`: null — строка «null»");
    assert_eq!(body["user"]["name"], "Борис");
    let refreshed = server.streams.refreshed.lock().map(|list| list.clone()).unwrap_or_default();
    assert_eq!(refreshed, vec![id.clone()], "смена доступа обновляет открытые потоки");

    // Регулярка с флагом `i`: верхний регистр совпадает с маршрутом, а
    // хранилище ищет id точно — «Пользователь не найден».
    let upper = admin.send(Req::new("PATCH", &format!("/api/admin/users/{}", id.to_uppercase())).json(&json!({}))).await;
    assert_eq!(upper.status, 400);
    assert_eq!(upper.json(), json!({ "error": "Пользователь не найден" }));
    let not_hex = admin.send(Req::new("PATCH", "/api/admin/users/xyz").json(&json!({}))).await;
    assert_eq!(not_hex.status, 404, "не [a-f0-9-] — маршрута нет");
    let null_body = admin.send(Req::new("PATCH", &path).body("null").header("content-type", "application/json")).await;
    assert_eq!(null_body.status, 400);
    assert_eq!(null_body.json(), json!({ "error": "Тело запроса должно быть JSON-объектом" }), "ошибка тела внутри try маршрута — без кода");
}

#[tokio::test]
async fn merchant_id_is_decoded_before_method_check() {
    let server = server().await;
    let mut client = server.client();
    for method in ["DELETE", "GET", "POST", "PUT"] {
        let response = client.send(Req::new(method, "/api/campaigns/ABC/merchants/%E0").json(&json!({}))).await;
        assert_eq!(response.status, 400, "{method}");
        assert_eq!(response.json(), json!({ "error": "Некорректный id торговца", "code": "INVALID_MERCHANT_ID" }), "{method}");
    }
    let fine = client.get("/api/campaigns/ABC/merchants/m%201").await;
    assert_eq!(fine.status, 404, "исправный id идёт дальше по таблице");
}

#[tokio::test]
async fn pathname_is_normalized_like_whatwg_url() {
    let server = server().await;
    let mut client = server.client();
    let dotted = client.get("/api/x/../test/rooms/ABC").await;
    assert_eq!(dotted.status, 200);
    assert_eq!(dotted.json(), json!({ "id": "ABC", "pathname": "/api/test/rooms/ABC" }));
    let encoded = client.get("/api/test/%2e%2e/test/rooms/X-1?q=1").await;
    assert_eq!(encoded.json()["pathname"], "/api/test/rooms/X-1");
    let underscore = client.get("/api/test/rooms/A_B").await;
    assert_eq!(underscore.status, 404, "`_` нет в [A-Za-z0-9-]");
    // `//api/…` — схемная форма: хост `api`, путь `/test/…` — уже не API.
    let scheme_relative = client.get("//api/test/rooms/ABC").await;
    assert_eq!(scheme_relative.status, 200);
    assert!(scheme_relative.text().contains("Сказание"), "отдан клиент");
    // `new URL` бросает — необработанная ошибка, 500.
    let invalid = client.get("//host:x/api/health").await;
    assert_eq!(invalid.status, 500);
    assert_eq!(invalid.json(), json!({ "error": "Внутренняя ошибка сервера", "code": "INTERNAL_ERROR" }));
}

#[tokio::test]
async fn route_exceptions_405_and_pass_through() {
    let server = server().await;
    let mut client = server.client();
    for method in ["GET", "DELETE", "PUT"] {
        let response = client.send(Req::new(method, "/api/test/campaigns/ABC/map-import")).await;
        assert_eq!(response.status, 405, "{method}");
        assert_eq!(response.json(), json!({ "error": "Метод не поддерживается" }));
    }
    assert_eq!(client.post("/api/test/campaigns/ABC/map-import", &json!({})).await.status, 200);
    assert_eq!(client.get("/api/test/lab/scenarios").await.status, 200);
    let unknown = client.get("/api/test/lab/unknown").await;
    assert_eq!(unknown.status, 404, "незнакомый путь стенда проваливается дальше");
    assert_eq!(unknown.json(), json!({ "error": API_NOT_FOUND }));
}

fn etag_of(response: &kit::TestResponse) -> String {
    response.header("etag").unwrap_or_default().to_string()
}

#[tokio::test]
async fn static_client_on_any_method() {
    let server = server().await;
    let mut client = server.client();
    for method in ["GET", "POST", "DELETE", "PUT"] {
        let response = client.send(Req::new(method, "/campaign/ABC")).await;
        assert_eq!(response.status, 200, "{method}");
        assert_eq!(response.header("cache-control"), Some("no-cache"));
    }
    let chunk = client.get("/assets/main-abcdef12.js").await;
    assert_eq!(chunk.header("cache-control"), Some("public, max-age=31536000, immutable"));
    let etag = chunk.header("etag").unwrap_or_default().to_string();
    let cached = client.send(Req::new("GET", "/assets/main-abcdef12.js").header("if-none-match", etag)).await;
    assert_eq!(cached.status, 304);
    let bad = client.get("/%E0").await;
    assert_eq!(bad.status, 400);
    assert_eq!(bad.json(), json!({ "error": "Некорректный путь" }));
    // `secret.txt` лежит рядом с `dist/`: ни одна форма выхода его не отдаёт.
    for target in ["/../secret.txt", "/..%2fsecret.txt", "/..%5csecret.txt", "/%2e%2e%2fsecret.txt", "/assets/..%2f..%2fsecret.txt"] {
        let escaped = client.get(target).await;
        assert_eq!(escaped.status, 200, "{target}");
        assert!(escaped.text().contains("Сказание"), "{target}: выход за dist отдаёт клиент");
        assert!(!escaped.text().contains(kit::SECRET), "{target}: секрет не отдан");
    }
    // `resolve(dist, 'x/../../dist/…')` возвращается внутрь dist — сам файл.
    let dist_name = server.dir.path().join("dist");
    assert!(dist_name.is_dir());
    let back = client.get("/x/..%2f..%2fdist%2fassets%2fmain-abcdef12.js").await;
    assert_eq!(back.text(), "console.log(1)", "выход и возврат в dist — файл, как resolve");
    let joined = client.send(Req::new("GET", "/assets/main-abcdef12.js").header("if-none-match", "W/\"0-0\"").header("if-none-match", etag_of(&chunk))).await;
    assert_eq!(joined.status, 304, "повторы If-None-Match склеиваются, как в Node");
    let since = client.send(Req::new("GET", "/assets/main-abcdef12.js").header("if-modified-since", "Fri, 01 Jan 2100 00:00:00 GMT+0300")).await;
    assert_eq!(since.status, 304, "If-Modified-Since — как Date.parse");
    let preflight = client.send(Req::new("OPTIONS", "/api/anything")).await;
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.header("access-control-allow-headers"), Some("Content-Type, X-Idempotency-Key"));

    let bare = TestServer::start_with(Options { dist: false, ..Options::default() }).await;
    let response = bare.client().get("/").await;
    assert_eq!(response.status, 404);
    assert_eq!(response.json(), json!({ "error": "Сначала выполните pnpm build" }));
}

#[tokio::test]
async fn foreign_origin_is_rejected() {
    let server = server().await;
    let mut client = server.client();
    let response = client.send(Req::new("POST", "/api/auth/register").json(&json!({})).header("origin", "https://evil.example")).await;
    assert_eq!(response.status, 403);
    assert_eq!(response.json(), json!({ "error": "Запрос с другого источника отклонён" }));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    let own = format!("http://{}", server.addr);
    let allowed = client.send(Req::new("POST", "/api/auth/login").json(&json!({})).header("origin", own)).await;
    assert_eq!(allowed.status, 401, "свой источник проходит к маршруту");
}

#[tokio::test]
async fn campaign_ai_settings_follow_request_into_core_and_blocking() {
    let server = server().await;
    let mut client = server.client();
    let outside = client.get("/api/test/ai").await.json();
    assert_eq!(outside, json!({ "direct": "", "core": "", "blocking": "" }), "вне кампании контекста нет");
    let defaults = client.get("/api/campaigns/abc-1/test-ai").await.json();
    assert_eq!(defaults["direct"], "openai/gpt-6-luna", "пустая модель кампании — модель сервера");
    let settings = sk_store::accounts::CampaignAiSettings { model: "x/chosen".into(), narrator_style: "neutral".into(), improv_mode: "story".into(), reasoning_level: "auto".into() };
    server.state.accounts.save_campaign_ai_settings("ABC-1", &settings).expect("настройки");
    let chosen = client.get("/api/campaigns/abc-1/test-ai").await.json();
    assert_eq!(chosen, json!({ "direct": "x/chosen", "core": "x/chosen", "blocking": "x/chosen" }), "id из пути — в верхний регистр");
}

/// Сбой чтения настроек ИИ одной кампании — 500 этого запроса (в JS
/// исключение до `applySecurityHeaders`, 3924); соседняя кампания и
/// сервер работают дальше.
#[tokio::test]
async fn broken_campaign_settings_fail_only_that_campaign() {
    let server = server().await;
    let mut client = server.client();
    let broken = server
        .state
        .core
        .call(|core| Box::pin(async move { core.events.with_connection_mut(|conn| Ok(conn.execute_batch("INSERT INTO campaign_settings (campaign_id, body) VALUES ('BROKEN-1', '[1]')")?)) }))
        .await;
    assert!(matches!(broken, Ok(Ok(()))), "{broken:?}");
    let failed = client.get("/api/campaigns/broken-1/test-ai").await;
    assert_eq!(failed.status, 500);
    assert_eq!(failed.json(), json!({ "error": "Внутренняя ошибка сервера", "code": "INTERNAL_ERROR" }));
    assert_eq!(failed.header("x-content-type-options"), None, "отказ до заголовков безопасности, как в JS");
    let neighbour = client.get("/api/campaigns/fine-1/test-ai").await;
    assert_eq!(neighbour.status, 200, "соседняя кампания обслуживается");
    assert_eq!(client.get("/api/health").await.status, 200);
}

static HOOK_MODELS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn record_model_hook(_core: std::rc::Rc<sk_server::core::GameCore>, campaign_id: String, _room: sk_server::room::Room) -> sk_server::core::LocalFuture<()> {
    Box::pin(async move {
        let model = sk_narration_base::campaign_ai_context::current_campaign_model();
        HOOK_MODELS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(format!("{campaign_id}:{model}"));
    })
}

/// Хук «проекция записана» — фоновая задача ядра с настройками кампании
/// постановщика (`queueMicrotask` JS наследует контекст запроса).
#[tokio::test]
async fn projection_hooks_run_in_campaign_context() {
    let server = server().await;
    let settings = json!({ "model": "x/hook" });
    let queued = sk_server::ai_context::with_campaign_ai(Some(settings), async {
        server
            .state
            .core
            .call(|core| {
                Box::pin(async move {
                    let room = sk_server::room::Room::empty("HOOK-1");
                    sk_server::projection::on_projection_saved(&core, "HOOK-1", &room, &[record_model_hook])
                })
            })
            .await
    })
    .await;
    assert!(matches!(queued, Ok(Ok(()))), "{queued:?}");
    let mut seen = Vec::new();
    for _ in 0..200 {
        seen = HOOK_MODELS.lock().map(|list| list.clone()).unwrap_or_default();
        if !seen.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(seen, vec!["HOOK-1:x/hook".to_string()]);
}

/// Сторож решения №1 на уровне ядра (не маршрута: HTTP-вариант с двумя
/// командами через настоящий маршрут — критерий С10/С18.5 рядом с
/// `narrate-room-version-race`). Два **задания** ядра читают одну версию,
/// перемежаются на `await` (барьер: при последовательном исполнении —
/// зависание, которое ловит предел) и коммитят с прочитанной версией:
/// один успех, один `STATE_VERSION_CONFLICT` → 409 по общему набору кодов.
/// Журнал зовётся синхронно на потоке ядра, поэтому отрезок «коммит →
/// подтверждение проекции» (и рассылка С9 в нём же) не перемежается с чужим
/// коммитом: побочные действия после коммитов идут в порядке коммитов
/// (рецензия С0, CORE-05).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn version_conflict_still_409_with_single_threaded_core() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use sk_server::error::{Failure, STATE_CONFLICT_CODES};
    use sk_store::{CommitRequest, InitializeRequest, LoadOptions};
    let server = server().await;
    let initialized = server.state.core.call(|core| Box::pin(async move { core.events.initialize_campaign(InitializeRequest::new("RACE-1", json!({ "sessionCode": "RACE-1" }))).map(|_| ()) })).await;
    assert!(matches!(initialized, Ok(Ok(()))), "{initialized:?}");
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let sequence = Arc::new(AtomicUsize::new(0));
    let job = |key: &'static str| {
        let barrier = barrier.clone();
        let sequence = sequence.clone();
        let state = server.state.clone();
        async move {
            state
                .core
                .call(move |core| {
                    Box::pin(async move {
                        let version = core.events.load("RACE-1", &LoadOptions::default()).map(|loaded| loaded.state_version).unwrap_or(-1);
                        barrier.wait().await;
                        let request = CommitRequest {
                            campaign_id: "RACE-1".into(),
                            expected_state_version: version,
                            idempotency_key: key.into(),
                            events: vec![json!({ "event_type": "CampaignRewound", "payload": { "state": { "sessionCode": "RACE-1", "note": key } } })],
                            ..CommitRequest::default()
                        };
                        let committed_at = sequence.fetch_add(1, Ordering::SeqCst);
                        let outcome = match core.events.commit(request) {
                            Ok(result) => {
                                let acknowledged = core.events.acknowledge_projection("RACE-1", result.state_version, Some(key));
                                format!("ok:{}:{}", result.state_version, acknowledged.is_ok())
                            }
                            Err(error) => {
                                let failure = Failure::from(error);
                                let response = failure.respond_by(&[(&STATE_CONFLICT_CODES, StatusCode::CONFLICT)], StatusCode::BAD_REQUEST);
                                format!("{}:{}", response.status.as_u16(), failure.code.unwrap_or_default())
                            }
                        };
                        let acknowledged_at = sequence.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        (version, outcome, committed_at, acknowledged_at)
                    })
                })
                .await
        }
    };
    let both = tokio::time::timeout(std::time::Duration::from_secs(10), futures_util::future::join(job("a"), job("b"))).await;
    let Ok((Ok(first), Ok(second))) = both else { panic!("задания ядра не перемежаются: {both:?}") };
    assert_eq!((first.0, second.0), (0, 0), "оба прочитали одну версию до коммита");
    let mut outcomes = vec![first.1.clone(), second.1.clone()];
    outcomes.sort();
    assert_eq!(outcomes, vec!["409:STATE_VERSION_CONFLICT".to_string(), "ok:1:true".to_string()], "конфликт версии не сериализуется молча");
    let (earlier, later) = if first.2 < second.2 { (&first, &second) } else { (&second, &first) };
    assert_eq!(earlier.3, earlier.2 + 1, "коммит и подтверждение — один отрезок: {first:?} {second:?}");
    assert!(earlier.3 < later.2, "чужой коммит не встаёт между коммитом и его подтверждением: {first:?} {second:?}");
    let metadata = server.state.core.call(|core| Box::pin(async move { core.events.get_metadata("RACE-1").map(|meta| (meta["projection_checkpoint_version"].clone(), meta["projection_checkpoint_hash"].clone())) })).await;
    let winner = if first.1.starts_with("ok") { "a" } else { "b" };
    assert_eq!(metadata.ok().and_then(Result::ok), Some((json!(1), json!(winner))), "проверочная точка — версия и хеш одного коммита");
}
