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

#[tokio::test]
async fn raw_routes_with_query_are_404() {
    let server = server().await;
    let mut client = server.client();
    let raw = [
        ("GET", "/api/health?x=1"),
        ("GET", "/api/admin/usage?x=1"),
        ("GET", "/api/speech/status?x=1"),
        ("POST", "/api/speech/transcribe?x=1"),
        ("GET", "/api/auth/me?x=1"),
        ("POST", "/api/auth/setup-admin?x=1"),
        ("POST", "/api/auth/register?x=1"),
        ("POST", "/api/auth/login?x=1"),
        ("POST", "/api/auth/logout?x=1"),
        ("GET", "/api/admin/users?x=1"),
        ("PATCH", "/api/admin/users/abc-1?x=1"),
        ("POST", "/api/rooms/ABC/dice?x=1"),
        ("POST", "/api/roll?x=1"),
        ("POST", "/api/items/generate-image?x=1"),
        ("POST", "/api/narrate?x=1"),
    ];
    for (method, target) in raw {
        let response = client.send(Req::new(method, target).json(&json!({}))).await;
        assert_eq!(response.status, 404, "{method} {target}");
        assert_eq!(response.json(), json!({ "error": API_NOT_FOUND }), "{method} {target}");
    }
    // Тот же путь без строки запроса — маршрут на месте.
    assert_eq!(client.get("/api/auth/me").await.status, 200);
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
    let escaped = client.get("/../Cargo.toml").await;
    assert_eq!(escaped.status, 200);
    assert!(escaped.text().contains("Сказание"), "выход за dist отдаёт клиент");
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

#[tokio::test]
async fn version_conflict_still_409_with_single_threaded_core() {
    use sk_server::error::Failure;
    use sk_store::{CommitRequest, InitializeRequest};
    let server = server().await;
    let outcomes = server
        .state
        .core
        .call(|core| {
            Box::pin(async move {
                let events = core.events.clone();
                let init = events.clone();
                let initialized = sk_server::core::blocking(move || init.initialize_campaign(InitializeRequest::new("RACE-1", json!({ "sessionCode": "RACE-1" })))).await;
                if !matches!(initialized, Ok(Ok(_))) {
                    return vec![format!("init: {initialized:?}")];
                }
                let commit = |key: &'static str| {
                    let events = events.clone();
                    async move {
                        let request = CommitRequest {
                            campaign_id: "RACE-1".into(),
                            expected_state_version: 0,
                            idempotency_key: key.into(),
                            events: vec![json!({ "event_type": "CampaignRewound", "payload": { "state": { "sessionCode": "RACE-1", "note": key } } })],
                            ..CommitRequest::default()
                        };
                        match sk_server::core::blocking(move || events.commit(request)).await {
                            Ok(Ok(result)) => format!("ok:{}", result.state_version),
                            Ok(Err(error)) => {
                                let failure = Failure::from(error);
                                let response = failure.respond_by(&[(&["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"], StatusCode::CONFLICT)], StatusCode::BAD_REQUEST);
                                format!("{}:{}", response.status.as_u16(), failure.code.unwrap_or_default())
                            }
                            Err(error) => format!("core:{error}"),
                        }
                    }
                };
                // Два задания одновременно с одной и той же ожидаемой версией.
                let (first, second) = futures_util::future::join(commit("a"), commit("b")).await;
                let mut outcomes = vec![first, second];
                outcomes.sort();
                outcomes
            })
        })
        .await
        .expect("ядро");
    assert_eq!(outcomes, vec!["409:STATE_VERSION_CONFLICT".to_string(), "ok:1".to_string()], "конфликт версии не сериализуется молча");
}
