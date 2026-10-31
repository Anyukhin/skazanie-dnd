//! С9: живой поток и присутствие: `presence/typing` PUT (4173), `stream` GET (4194).
//!
//! Обработчики только разбирают запрос и ждут ядро: реестр соединений,
//! сверка прав и рассылка — в [`crate::streams`].

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use serde_json::{json, Value};
use sk_store::accounts::Accounts;

use crate::access::require_user;
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::streams::TYPING_TTL_MS;

pub fn routes() -> Vec<Route> {
    vec![
        Route::new(4187, Methods::One(Method::PUT), Matcher::path_template("/api/campaigns/{id}/presence/typing"), typing),
        Route::get(4208, Matcher::path_template("/api/campaigns/{id}/stream"), stream),
    ]
}

/// `PUT /api/campaigns/:id/presence/typing` (4173–4192): тело читается после
/// проверки комнаты и доступа, как в JS.
fn typing(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        {
            let (user, campaign_id) = (user.clone(), campaign_id.clone());
            ctx.state.core.call(move |core| Box::pin(async move { crate::streams::typing_room_check(&core, &user, &campaign_id) })).await??;
        }
        let body = ctx.json_body().await?;
        // `String(body.actor_id ?? '')`.
        let actor_id = match body.get("actor_id") {
            None | Some(Value::Null) => String::new(),
            value => sk_core::js::string(value),
        };
        let typing = body.get("typing") == Some(&Value::Bool(true));
        ctx.state.core.call(move |core| Box::pin(async move { crate::streams::set_typing(&core, &user, &campaign_id, &actor_id, typing) })).await??;
        Ok(crate::http::json(StatusCode::OK, &json!({ "ok": true, "typing": typing, "ttl_ms": TYPING_TTL_MS })))
    })
}

/// `GET /api/campaigns/:id/stream` (4194–4281): рукопожатие в ядре, затем
/// тело SSE до отзыва доступа, переполнения очереди или ухода клиента.
fn stream(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let session_key = Accounts::session_key_for_token(&ctx.session_token().unwrap_or_default());
        let (pending, body) = crate::streams::prepare_stream(&ctx.state, &campaign_id);
        ctx.state.core.call(move |core| Box::pin(async move { crate::streams::open_stream(&core, &user, &campaign_id, session_key, pending) })).await??;
        let mut response = Response::new(body.into_body());
        *response.status_mut() = StatusCode::OK;
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
        Ok::<Response<Body>, crate::error::ApiError>(response)
    })
}
