//! С4: служебные маршруты (`server/index.mjs:3941–3970`): health,
//! `admin/usage`, speech status и transcribe.
//!
//! Все четыре сравнивают **сырой** `req.url`: `/api/health?x` — 404.
//! `/api/health` метод не проверяет (3940): `HEAD` и `POST` с разрешённого
//! источника тоже получают 200.

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use sk_narration_base::speech_input::{speech_input_available, transcribe_speech, validate_speech_wav, SpeechError};

use crate::access::{require_admin, require_user};
use crate::config::LEGACY_DEFAULT_RULESET_ID;
use crate::core::blocking;
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::ApiError;
use crate::http::{json, TOO_LARGE};

/// `MAX_AUDIO` `speech-input.mjs`: заголовок 44 байта и минута 16-битного моно 16 кГц.
const MAX_AUDIO: usize = 44 + 16_000 * 2 * 60;

pub fn routes() -> Vec<Route> {
    vec![
        Route::new(3954, Methods::Any, Matcher::raw("/api/health"), health),
        Route::get(3968, Matcher::raw("/api/admin/usage"), admin_usage),
        Route::get(3974, Matcher::raw("/api/speech/status"), speech_status),
        Route::new(3978, Methods::One(Method::POST), Matcher::raw("/api/speech/transcribe"), speech_transcribe),
    ]
}

/// `llmClient.health()`; без клиента (демо-режим набора) — пустой список.
fn models_health(ctx: &RouteCtx) -> Value {
    ctx.state.models.llm.as_ref().map_or_else(|| json!([]), |client| client.client().health())
}

/// `/api/health` (3940–3953).
fn health(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let config = &ctx.state.config;
        let rules = &ctx.state.rules;
        let models = models_health(ctx);
        // `characterCreationCatalog(LEGACY_DEFAULT_RULESET_ID)` вне `try` (один раз на процесс):
        // сбой — необработанная ошибка (500).
        let character_creation = blocking(|| crate::routes::catalog::health_character_creation_catalog(LEGACY_DEFAULT_RULESET_ID)).await??;
        let body: Value = json!({
            "configured": config.model_configured(),
            "provider": "RouterAI",
            "model": config.model,
            "fallbackModels": config.fallback_models,
            "models": models,
            "imageModel": config.image_model,
            "engineMode": "enforce",
            "rulesetId": rules.ruleset_id,
            "ruleCount": rules.rule_count,
            "installedRulesets": rules.installed_profiles,
            "characterCreation": character_creation,
            "tools": [],
        });
        Ok(json(StatusCode::OK, &body))
    })
}

/// `GET /api/admin/usage` (3954–3957).
fn admin_usage(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_admin(ctx).await?;
        let ledger = ctx.state.ledger.clone();
        let architect = ctx.state.architect_usage.clone();
        let (usage, architect) = blocking(move || (ledger.report(), architect.report())).await?;
        let body = json!({ "usage": usage?, "architect": architect, "models": models_health(ctx) });
        Ok(json(StatusCode::OK, &body))
    })
}

/// `GET /api/speech/status` (3960–3963).
fn speech_status(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_user(ctx).await?;
        let available = blocking(speech_input_available).await?;
        Ok(json(StatusCode::OK, &json!({ "available": available, "maxSeconds": 60 })))
    })
}

fn speech_failure(error: SpeechError) -> ApiError {
    // `error.status ?? 400`.
    let status = error.status.and_then(|code| StatusCode::from_u16(code).ok()).unwrap_or(StatusCode::BAD_REQUEST);
    ApiError::new(status, error.message)
}

/// `POST /api/speech/transcribe` (3964–3969): сырое тело WAV.
fn speech_transcribe(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_user(ctx).await?;
        if ctx.state.limits.rate_limited(ctx.peer) {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Слишком много запросов. Попробуйте позже."));
        }
        // `readSpeechWav(req)`: больше минуты записи — отказ на лету; обрыв
        // соединения — текст ошибки потока (`aborted`), тоже 400.
        let audio = match ctx.body.bytes(MAX_AUDIO).await {
            Ok(audio) => audio,
            Err(error) if error == TOO_LARGE => return Err(ApiError::new(StatusCode::BAD_REQUEST, "Запись превышает 60 секунд.")),
            Err(error) => return Err(ApiError::new(StatusCode::BAD_REQUEST, error.message)),
        };
        if let Err(error) = validate_speech_wav(&audio) {
            return Err(speech_failure(error));
        }
        match blocking(move || transcribe_speech(&audio)).await? {
            Ok(text) => Ok(json(StatusCode::OK, &json!({ "text": text }))),
            Err(error) => Err(speech_failure(error)),
        }
    })
}
