//! Вход и учётные записи (С0): `/api/auth/*` и `/api/admin/users`
//! (`server/index.mjs:3970–4026`).
//!
//! Все шесть маршрутов сравнивают **сырой** `req.url`, поэтому
//! `/api/auth/me?x` в JS — 404; так и здесь ([`Matcher::raw`]).
//! Тексты отказов и что ловит `try` маршрута — как в JS:
//! `setup-admin`, `register` и `PATCH users` отвечают 400 без кода на любую
//! ошибку внутри `try` (включая тело и `createSession`), `login` глотает
//! ошибку тела (`readBody(req).catch(() => ({}))`), а сбой хранилища вне
//! `try` (`verifyUser`, `createSession` при входе, `hasAdmin`,
//! `listUsers`) — необработанная ошибка, 500 `INTERNAL_ERROR`.

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use serde_json::{json, Value};
use sk_store::accounts::{AccessPatch, Accounts};

use crate::access::{current_user, require_admin};
use crate::core::blocking;
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::ApiError;
use crate::http::{json, session_cookie};

const TOO_MANY: &str = "Слишком много попыток. Попробуйте позже";

pub fn routes() -> Vec<Route> {
    vec![
        Route::get(3970, Matcher::raw("/api/auth/me"), me),
        Route::post(3974, Matcher::raw("/api/auth/setup-admin"), setup_admin),
        Route::post(3984, Matcher::raw("/api/auth/register"), register),
        Route::post(3993, Matcher::raw("/api/auth/login"), login),
        Route::post(4002, Matcher::raw("/api/auth/logout"), logout),
        Route::get(4011, Matcher::raw("/api/admin/users"), admin_users),
        // `req.url?.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/i)` — сырой адрес, флаг `i`, без предела длины.
        Route::new(4015, Methods::One(Method::PATCH), Matcher::raw_template("/api/admin/users/{hex}").ignore_case(), admin_update_user),
    ]
}

fn text(body: &Value, key: &str) -> String {
    sk_core::js::s(body.get(key))
}

fn with_cookie(mut response: Response<Body>, cookie: HeaderValue) -> Response<Body> {
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    response
}

fn too_many() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, TOO_MANY)
}

/// Аккаунты для блокирующего вызова.
fn accounts(ctx: &RouteCtx) -> std::sync::Arc<Accounts> {
    ctx.state.accounts.clone()
}

/// `GET /api/auth/me` (3970–3973).
fn me(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = current_user(ctx).await?;
        let accounts = accounts(ctx);
        let has_admin = blocking(move || accounts.has_admin()).await??;
        Ok(json(StatusCode::OK, &json!({ "user": user, "setupRequired": !has_admin })))
    })
}

/// Тело `setup-admin`/`register` внутри `try`: любая ошибка — 400 без кода
/// с её текстом (`error.message`; запасной текст JS — только для бросков не-`Error`).
async fn create_account(ctx: &mut RouteCtx, admin: bool) -> Result<(Value, String), String> {
    let body = ctx.json_body().await.map_err(|error| error.message.to_string())?;
    let accounts = accounts(ctx);
    let expected = ctx.state.config.admin_setup_token.clone();
    let created = blocking(move || {
        let user = if admin {
            accounts.create_admin(&text(&body, "email"), &text(&body, "password"), &text(&body, "name"), &text(&body, "setupToken"), &expected)?
        } else {
            accounts.register_user(&text(&body, "email"), &text(&body, "password"), &text(&body, "name"))?
        };
        let token = accounts.create_session(&text(&user, "id"))?;
        Ok::<_, sk_store::accounts::AccountError>((user, token))
    })
    .await
    .map_err(|error| error.to_string())?;
    created.map_err(|error| error.message)
}

/// `POST /api/auth/setup-admin` (3974–3983).
fn setup_admin(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if ctx.state.limits.rate_limited(ctx.peer) {
            return Err(too_many());
        }
        match create_account(ctx, true).await {
            Ok((user, token)) => Ok(with_cookie(json(StatusCode::CREATED, &json!({ "user": user, "setupRequired": false })), session_cookie(&ctx.headers, &token, false, ctx.state.config.cookie_secure))),
            Err(message) => Err(ApiError::new(StatusCode::BAD_REQUEST, message)),
        }
    })
}

/// `POST /api/auth/register` (3984–3992).
fn register(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if ctx.state.limits.rate_limited(ctx.peer) {
            return Err(too_many());
        }
        match create_account(ctx, false).await {
            Ok((user, token)) => Ok(with_cookie(json(StatusCode::CREATED, &json!({ "user": user })), session_cookie(&ctx.headers, &token, false, ctx.state.config.cookie_secure))),
            Err(message) => Err(ApiError::new(StatusCode::BAD_REQUEST, message)),
        }
    })
}

/// `POST /api/auth/login` (3993–4001): тело `null` или битое — как `{}`.
fn login(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if ctx.state.limits.rate_limited(ctx.peer) {
            return Err(too_many());
        }
        let body = ctx.json_body().await.unwrap_or_else(|_| json!({}));
        let store = accounts(ctx);
        let user = blocking(move || store.verify_user(&text(&body, "email"), &text(&body, "password"))).await??;
        let Some(user) = user else {
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Неверная почта или пароль"));
        };
        let store = accounts(ctx);
        let id = text(&user, "id");
        let token = blocking(move || store.create_session(&id)).await??;
        Ok(with_cookie(json(StatusCode::OK, &json!({ "user": user })), session_cookie(&ctx.headers, &token, false, ctx.state.config.cookie_secure)))
    })
}

/// `POST /api/auth/logout` (4002–4010): потоки этой сессии закрываются сразу.
fn logout(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let token = ctx.session_token().unwrap_or_default();
        if !token.is_empty() {
            let store = accounts(ctx);
            let deleted = token.clone();
            blocking(move || store.delete_session(&deleted)).await??;
        }
        let session_key = if token.is_empty() { String::new() } else { Accounts::session_key_for_token(&token) };
        ctx.state.streams.revoke_for_session(&session_key);
        Ok(with_cookie(json(StatusCode::OK, &json!({ "ok": true })), session_cookie(&ctx.headers, "", true, ctx.state.config.cookie_secure)))
    })
}

/// `GET /api/admin/users` (4011–4014).
fn admin_users(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_admin(ctx).await?;
        let accounts = accounts(ctx);
        let users = blocking(move || accounts.list_users()).await??;
        Ok(json(StatusCode::OK, &json!({ "users": users })))
    })
}

/// `updateUserAccess(userId, patch)`: поля тела так, как их читает JS-хранилище
/// (`store.mjs:222–234`).
fn access_patch(body: &Value) -> AccessPatch {
    AccessPatch {
        hero_ids: body.get("heroIds").and_then(Value::as_array).map(|list| list.iter().map(|item| sk_core::js::string(Some(item))).collect()),
        name: body.get("name").and_then(Value::as_str).map(str::to_string),
        role: body.get("role").and_then(Value::as_str).map(str::to_string),
        engine_mode: match body.get("engineMode") {
            Some(Value::Null) => Some(None),
            Some(Value::String(mode)) => Some(Some(mode.clone())),
            _ => None,
        },
    }
}

/// `PATCH /api/admin/users/:id` (4015–4025).
fn admin_update_user(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_admin(ctx).await?;
        let id = ctx.param(0).to_string();
        let attempt: Result<Value, String> = async {
            let body = ctx.json_body().await.map_err(|error| error.message.to_string())?;
            let accounts = accounts(ctx);
            let patch = access_patch(&body);
            blocking(move || accounts.update_user_access(&id, patch)).await.map_err(|error| error.to_string())?.map_err(|error| error.message)
        }
        .await;
        let updated = match attempt {
            Ok(updated) => updated,
            Err(message) => return Err(ApiError::new(StatusCode::BAD_REQUEST, message)),
        };
        ctx.state.streams.refresh_for_user(&sk_core::js::s(updated.get("id")));
        Ok(json(StatusCode::OK, &json!({ "user": updated })))
    })
}
