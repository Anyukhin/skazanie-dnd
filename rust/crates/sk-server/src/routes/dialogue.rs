//! С15: диалог и объяснение хода — `server/index.mjs:4871–4900, 5199–5215`:
//! `GET`/`DELETE /api/campaigns/:id/dialogue` (4871),
//! `GET /api/campaigns/:id/turns/:turn/explanation` (5199).
//!
//! Маршруты объявляются с номером строки `server/index.mjs`, где JS их
//! проверяет: порядок общей таблицы (`routes::table`) выводится из этих
//! номеров. Оба сравнивают `pathname` (строка запроса не мешает).
//!
//! Диалог: всё после `requireUser` — внутри `try` JS, поэтому сбой сверки,
//! тела или реестра — 400 `{ error, code }`. Реестр уточнений — общий с
//! оркестратором (`gameOrchestrator.clarificationRegistry`, 4881): берётся из
//! набора ядра ([`crate::orchestration::orchestration`]), второго экземпляра
//! нет. Реестр бросков — `GameCore::rolls` (`rollRegistry`).
//!
//! Объяснение хода — вне `try`: сбой журнала или трасс — 500 последней
//! границы. Паритет JS (5202–5203): комната читается `getRoom` без сверки и
//! без проверки, что кампания есть; код кампании идёт в хранилище трасс и в
//! `campaignHeroIds` как есть, без перевода в верхний регистр (`getRoom`
//! переводит сам). Трассы — `traceStore` оркестратора
//! (`GameOrchestrator::explanation`, тот же `storage/turn-traces`).

use axum::http::{Method, StatusCode};
use serde_json::{json, Map, Value};
use sk_core::js;
use sk_orchestrator::autonomous_orchestrator::OrchestratorError;

use crate::access::{access_denied_before_reconcile, campaign_hero_ids, campaign_membership, can_access_room, can_use_hero, owned_viewer_actor_id, require_user};
use crate::core::blocking;
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::projection;
use crate::room::{self, Room};
use crate::routes::campaigns::Caught;

/// Методы диалога: GET и DELETE (4872); прочие идут дальше, к 404.
const DIALOGUE_METHODS: &[Method] = &[Method::GET, Method::DELETE];

const NO_ACCESS: &str = "Нет доступа к этой кампании";

pub fn routes() -> Vec<Route> {
    vec![
        // `parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/dialogue$/)` и `['GET', 'DELETE']` (4871–4872).
        Route::new(4899, Methods::Set(DIALOGUE_METHODS), Matcher::path_template("/api/campaigns/{id}/dialogue"), dialogue),
        // `…\/turns\/([A-Za-z0-9._-]+)\/explanation$/` и `GET` (5199–5200).
        Route::get(5232, Matcher::path_template("/api/campaigns/{id}/turns/{turn}/explanation"), explanation),
    ]
}

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

/// `TypeError` JS при чтении поля у `null`.
fn null_read(field: &str) -> Failure {
    Failure::new(format!("Cannot read properties of null (reading '{field}')"), None)
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

/// `a === b` по JS для значений JSON: примитивы — по значению, объекты и
/// массивы — по ссылке (у двух разных значений — никогда), `undefined` —
/// отсутствующее поле.
fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}

/// `value?.[0]`: элемент массива, первый символ строки (единица UTF-16),
/// поле `"0"` объекта.
fn first_of(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => items.first().cloned(),
        Value::String(text) => text.encode_utf16().next().map(|unit| Value::String(String::from_utf16_lossy(&[unit]))),
        Value::Object(map) => map.get("0").cloned(),
        _ => None,
    }
}

/// `{ campaignId, actorId, stateVersion }`: `undefined` версии — поля нет.
fn scope(campaign_id: &str, actor_id: &str, state_version: Option<&Value>) -> Value {
    let mut options = Map::new();
    options.insert("campaignId".into(), Value::String(campaign_id.into()));
    options.insert("actorId".into(), Value::String(actor_id.into()));
    if let Some(version) = state_version {
        options.insert("stateVersion".into(), version.clone());
    }
    Value::Object(options)
}

// --- GET/DELETE /api/campaigns/:id/dialogue ----------------------------------

/// Восстановить диалог героя (`GET`: открытое уточнение и ожидающая проверка
/// рассказа этой версии обстановки) или сбросить его (`DELETE`: завершить
/// уточнение из тела и стереть реплики). `catch` — 400 с текстом и кодом.
fn dialogue(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        dialogue_body(ctx, user).await.map_err(|caught| match caught {
            Caught::Reply(error) => error,
            Caught::Thrown(failure) => failure.respond(StatusCode::BAD_REQUEST),
        })
    })
}

async fn dialogue_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let campaign_id = ctx.param(0).to_uppercase();
    let state = ctx.state.clone();
    // `accessDeniedBeforeReconcile` читает комнату, только если пользователь
    // не администратор и не участник по профилю; её сбой — «решит прежний путь».
    let prefetched = if is_admin(&user) || campaign_membership(&user, &campaign_id).is_some() {
        None
    } else {
        let code = campaign_id.clone();
        Some(state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await?)
    };
    let accounts = state.accounts.clone();
    let (checked_user, checked_code) = (user.clone(), campaign_id.clone());
    let denied = blocking(move || {
        let fallback = Room::empty(&checked_code);
        access_denied_before_reconcile(&accounts, Some(&checked_user), &checked_code, move |_| prefetched.unwrap_or(Ok(fallback)))
    })
    .await?;
    if denied {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NO_ACCESS).into());
    }
    let reconciled = {
        let code = campaign_id.clone();
        state.core.call(move |core| Box::pin(async move { projection::reconcile_campaign_projection(&core, &code) })).await??
    };
    let room = reconciled.ok_or_else(|| null_read("state"))?;
    let Some(room_state) = room.state.clone() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into());
    };
    // `searchParams.get('actor_id') ?? ownedViewerActorId(...)`: пустая
    // строка запроса — тоже значение.
    let requested = ctx.search_param("actor_id");
    let accounts = state.accounts.clone();
    let (checked_user, checked_code, checked_state) = (user.clone(), campaign_id.clone(), room_state.clone());
    let admitted = blocking(move || -> Result<Result<String, &'static str>, Failure> {
        if !can_access_room(&accounts, Some(&checked_user), &room)? {
            return Ok(Err(NO_ACCESS));
        }
        let actor_id = match requested {
            Some(actor) => actor,
            None => owned_viewer_actor_id(&accounts, &checked_state, &checked_user, &checked_code)?,
        };
        if !can_use_hero(&accounts, &checked_user, Some(&Value::String(actor_id.clone())), &checked_code)? {
            return Ok(Err("Этот герой не принадлежит вашему аккаунту"));
        }
        Ok(Ok(actor_id))
    })
    .await??;
    let actor_id = admitted.map_err(|message| ApiError::new(StatusCode::FORBIDDEN, message))?;
    let body = if ctx.method == Method::DELETE { Some(ctx.json_body().await?) } else { None };
    let app = state.clone();
    let reply = state
        .core
        .call(move |core| {
            Box::pin(async move {
                // Набор ядра в JS собран при старте: его сбой — не ответ маршрута.
                let services = crate::orchestration::orchestration(&core, &app).map_err(|failure| Caught::Reply(ApiError::from(failure)))?;
                let mut registry = services.clarifications.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(body) = body {
                    let id = body.get("clarification_id");
                    if js::truthy(id) {
                        registry.complete(Some(&Value::String(js::string(id))), &scope(&campaign_id, &actor_id, None)).map_err(Failure::from)?;
                    }
                    registry.reset_dialogue(&scope(&campaign_id, &actor_id, None)).map_err(Failure::from)?;
                    return Ok::<Value, Caught>(json!({ "cleared": true }));
                }
                let options = scope(&campaign_id, &actor_id, room_state.get("state_version"));
                let clarification = registry.current(&options).map_err(Failure::from)?;
                let mut check = core.rolls.borrow_mut().pending_narration_check(&options).map_err(Failure::from)?;
                if let (Some(clarification), Some(Value::Object(check))) = (clarification.as_ref(), check.as_mut()) {
                    let id = clarification.get("id");
                    let stored = registry.resolve(id, &options).map_err(Failure::from)?;
                    let step = first_of(stored.get("original_intent").and_then(|intent| intent.get("action_steps")));
                    if strict_eq(step.as_ref(), check.get("action")) {
                        check.insert("clarification_id".into(), id.cloned().unwrap_or(Value::Null));
                    }
                }
                Ok(json!({ "actor_id": actor_id, "clarification": clarification, "check": check }))
            })
        })
        .await??;
    Ok(json(StatusCode::OK, &reply))
}

// --- GET /api/campaigns/:id/turns/:turn/explanation --------------------------

/// Разбор хода по трассе (`latest` — последний механический ход) в проекции
/// зрителя. Нет трассы — 404.
fn explanation(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_string();
        let turn_id = ctx.param(1).to_string();
        let state = ctx.state.clone();
        let room = {
            let code = campaign_id.clone();
            state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await??
        };
        let accounts = state.accounts.clone();
        let (checked_user, checked_code, checked_room) = (user.clone(), campaign_id.clone(), room.clone());
        let player_id = blocking(move || -> Result<Option<String>, Failure> {
            if !can_access_room(&accounts, Some(&checked_user), &checked_room)? {
                return Ok(None);
            }
            let players = checked_room.state.as_ref().and_then(|room_state| room_state.get("players")).and_then(Value::as_array).cloned().unwrap_or_default();
            let hero = campaign_hero_ids(&accounts, &checked_user, &checked_code)?.into_iter().find(|id| players.iter().any(|player| js::string(player.get("id")) == *id));
            Ok(Some(hero.unwrap_or_default()))
        })
        .await??;
        let Some(player_id) = player_id else { return Err(ApiError::new(StatusCode::FORBIDDEN, NO_ACCESS)) };
        let app = state.clone();
        let reply = state
            .core
            .call(move |core| {
                Box::pin(async move {
                    let services = crate::orchestration::orchestration(&core, &app)?;
                    let mut viewer = Map::new();
                    viewer.insert("playerId".into(), Value::String(player_id.clone()));
                    viewer.insert("isPartyMember".into(), Value::Bool(true));
                    if let Some(role) = user.get("role") {
                        viewer.insert("role".into(), role.clone());
                    }
                    let turn = (turn_id != "latest").then(|| Value::String(turn_id));
                    let explanation = services.game.explanation(&campaign_id, turn.as_ref(), &Value::Object(viewer)).map_err(orchestrator_failure)?;
                    if !js::truthy(Some(&explanation)) {
                        return Ok::<Option<Value>, Failure>(None);
                    }
                    let projected = sk_projection::viewer_projection::turn_explanation_for_viewer(Some(&explanation), Some(&user), Some(&Value::String(player_id)), room.state.as_ref())?;
                    Ok(Some(projected.unwrap_or(Value::Null)))
                })
            })
            .await??;
        match reply {
            Some(body) => Ok(json(StatusCode::OK, &body)),
            None => Err(ApiError::new(StatusCode::NOT_FOUND, "Трассировка хода не найдена")),
        }
    })
}
