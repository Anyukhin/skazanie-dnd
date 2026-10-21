//! С4: служебные маршруты (`server/index.mjs:3931–3969`): полный health,
//! `admin/usage`, speech status и transcribe.
//!
//! До С4 здесь — только `/api/health` каркаса С0: сырой адрес и **любой**
//! метод (3940 метод не проверяет — `HEAD` и `POST` с разрешённого источника
//! получают 200). Поля, которых каркасу взять неоткуда (`ruleCount`,
//! `installedRulesets`, `characterCreation`), добавит С4.

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::http::json;

pub fn routes() -> Vec<Route> {
    vec![Route::new(3940, Methods::Any, Matcher::raw("/api/health"), health)]
}

/// `GET /api/health` (3940–3953), заглушка С0.
fn health(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let config = &ctx.state.config;
        let models = ctx.state.models.llm.as_ref().map_or_else(|| json!([]), |client| client.client().health());
        let body: Value = json!({
            "configured": config.model_configured(),
            "provider": "RouterAI",
            "model": config.model,
            "fallbackModels": config.fallback_models,
            "models": models,
            "imageModel": config.image_model,
            "engineMode": "enforce",
            "rulesetId": config.default_ruleset_id,
            "tools": [],
        });
        Ok(json(StatusCode::OK, &body))
    })
}
