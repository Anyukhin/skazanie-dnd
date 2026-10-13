//! Вход и учётные записи: `/api/auth/*` и `/api/admin/users`.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::Extension;
use axum::http::{header, HeaderMap, Response, StatusCode};
use serde_json::{json, Value};
use sk_store::accounts::AccessPatch;

use crate::http::{error, json, read_body, session_cookie, session_token};
use crate::{current_user, peer, Shared};

const TOO_MANY: &str = "Слишком много попыток. Попробуйте позже";

fn text(body: &Value, key: &str) -> String {
    sk_core::js::s(body.get(key))
}

fn with_cookie(mut response: Response<Body>, cookie: axum::http::HeaderValue) -> Response<Body> {
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    response
}

/// Пользователь-администратор или готовый отказ (401/403).
pub fn require_admin(state: &Shared, headers: &HeaderMap) -> Result<Value, Response<Body>> {
    let Some(user) = current_user(state, headers) else {
        return Err(error(StatusCode::UNAUTHORIZED, "Нужно войти в аккаунт", None));
    };
    if user.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(error(StatusCode::FORBIDDEN, "Требуются права администратора", None));
    }
    Ok(user)
}

/// Пользователь или отказ 401.
pub fn require_user(state: &Shared, headers: &HeaderMap) -> Result<Value, Response<Body>> {
    current_user(state, headers).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Нужно войти в аккаунт", None))
}

pub async fn me(State(state): State<Shared>, headers: HeaderMap) -> Response<Body> {
    let user = current_user(&state, &headers).unwrap_or(Value::Null);
    let setup_required = !state.accounts.has_admin().unwrap_or(false);
    json(StatusCode::OK, json!({ "user": user, "setupRequired": setup_required }))
}

pub async fn setup_admin(State(state): State<Shared>, info: Option<Extension<ConnectInfo<SocketAddr>>>, headers: HeaderMap, body: Body) -> Response<Body> {
    if state.rate_limited(peer(info)) {
        return error(StatusCode::TOO_MANY_REQUESTS, TOO_MANY, None);
    }
    let body = match read_body(body).await {
        Ok(body) => body,
        Err(failure) => return error(StatusCode::BAD_REQUEST, failure.message, None),
    };
    let created = state.accounts.create_admin(&text(&body, "email"), &text(&body, "password"), &text(&body, "name"), &text(&body, "setupToken"), &state.config.admin_setup_token);
    match created.and_then(|user| state.accounts.create_session(&text(&user, "id")).map(|token| (user, token))) {
        Ok((user, token)) => with_cookie(json(StatusCode::CREATED, json!({ "user": user, "setupRequired": false })), session_cookie(&headers, &token, false, state.config.cookie_secure)),
        Err(failure) => error(StatusCode::BAD_REQUEST, failure.message, None),
    }
}

pub async fn register(State(state): State<Shared>, info: Option<Extension<ConnectInfo<SocketAddr>>>, headers: HeaderMap, body: Body) -> Response<Body> {
    if state.rate_limited(peer(info)) {
        return error(StatusCode::TOO_MANY_REQUESTS, TOO_MANY, None);
    }
    let body = match read_body(body).await {
        Ok(body) => body,
        Err(failure) => return error(StatusCode::BAD_REQUEST, failure.message, None),
    };
    let created = state.accounts.register_user(&text(&body, "email"), &text(&body, "password"), &text(&body, "name"));
    match created.and_then(|user| state.accounts.create_session(&text(&user, "id")).map(|token| (user, token))) {
        Ok((user, token)) => with_cookie(json(StatusCode::CREATED, json!({ "user": user })), session_cookie(&headers, &token, false, state.config.cookie_secure)),
        Err(failure) => error(StatusCode::BAD_REQUEST, failure.message, None),
    }
}

pub async fn login(State(state): State<Shared>, info: Option<Extension<ConnectInfo<SocketAddr>>>, headers: HeaderMap, body: Body) -> Response<Body> {
    if state.rate_limited(peer(info)) {
        return error(StatusCode::TOO_MANY_REQUESTS, TOO_MANY, None);
    }
    let body = read_body(body).await.unwrap_or_else(|_| json!({}));
    let user = state.accounts.verify_user(&text(&body, "email"), &text(&body, "password")).ok().flatten();
    let Some(user) = user else {
        return error(StatusCode::UNAUTHORIZED, "Неверная почта или пароль", None);
    };
    match state.accounts.create_session(&text(&user, "id")) {
        Ok(token) => with_cookie(json(StatusCode::OK, json!({ "user": user })), session_cookie(&headers, &token, false, state.config.cookie_secure)),
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, failure.message, None),
    }
}

pub async fn logout(State(state): State<Shared>, headers: HeaderMap) -> Response<Body> {
    let token = session_token(&headers);
    let _ = state.accounts.delete_session(&token);
    with_cookie(json(StatusCode::OK, json!({ "ok": true })), session_cookie(&headers, "", true, state.config.cookie_secure))
}

pub async fn admin_users(State(state): State<Shared>, headers: HeaderMap) -> Response<Body> {
    if let Err(response) = require_admin(&state, &headers) {
        return response;
    }
    match state.accounts.list_users() {
        Ok(users) => json(StatusCode::OK, json!({ "users": users })),
        Err(failure) => error(StatusCode::INTERNAL_SERVER_ERROR, failure.message, None),
    }
}

pub async fn admin_update_user(State(state): State<Shared>, Path(id): Path<String>, headers: HeaderMap, body: Body) -> Response<Body> {
    if let Err(response) = require_admin(&state, &headers) {
        return response;
    }
    if !(1..=64).contains(&id.len()) || !id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-') {
        return error(StatusCode::NOT_FOUND, "API endpoint не найден", None);
    }
    let body = match read_body(body).await {
        Ok(body) => body,
        Err(failure) => return error(StatusCode::BAD_REQUEST, failure.message, None),
    };
    let patch = AccessPatch {
        hero_ids: body.get("heroIds").and_then(Value::as_array).map(|list| list.iter().map(|item| sk_core::js::s(Some(item))).collect()),
        name: body.get("name").and_then(Value::as_str).map(str::to_string),
        role: body.get("role").and_then(Value::as_str).map(str::to_string),
        engine_mode: match body.get("engineMode") {
            Some(Value::Null) => Some(None),
            Some(Value::String(mode)) => Some(Some(mode.clone())),
            _ => None,
        },
    };
    match state.accounts.update_user_access(&id, patch) {
        Ok(user) => json(StatusCode::OK, json!({ "user": user })),
        Err(failure) => error(StatusCode::BAD_REQUEST, failure.message, None),
    }
}
