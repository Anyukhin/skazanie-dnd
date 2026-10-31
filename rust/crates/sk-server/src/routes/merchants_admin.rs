//! С14: торговцы — управление и сборка (`server/index.mjs`):
//!
//! - `POST /api/campaigns/:id/merchants/commands` (5222–5250) — одна
//!   lifecycle-команда ведущего (`CreateMerchant`, `ConfigureMerchant`,
//!   `RestockMerchant`, `MoveMerchant`, `SetMerchantAvailability`), лимит 60;
//! - `POST /api/campaigns/:id/merchants/assemble` (5252–5305) — торговец
//!   текущей сцены от `ShopAssembler`, лимит 30;
//! - `GET /api/campaigns/:id/merchants/:merchantId?actor_id=` (5450–5472) —
//!   витрина торговца для своего героя.
//!
//! Обе команды идут `executeMerchantLifecycleCommand` (1221–1240):
//! санитайзер (`merchant_guard`) → сверка повтора ключа →
//! `GameOrchestrator::handle` → сверка отпечатка итога → проекция в комнату.
//! Ответ — итог оркестратора как есть (без проекции зрителя), с
//! `authoritative_state` комнаты и `room_version`.
//!
//! Как в JS: `requireAdmin`/`requireUser` — вне `try` (401/403 границы);
//! комната, лимит, тело, ключ — внутри: ранние ответы (404, 429, 400 без
//! команды или ключа) идут мимо `catch`, исключения — по таблице `catch`
//! маршрута (у `commands`: 409 конфликты, 404 `MERCHANT_NOT_FOUND`, 403
//! отказы прав, прочее — 400; у `assemble`: 409 конфликты, прочее — 400), в
//! том числе ошибка без кода (`TypeError` приведения) — 400 с её текстом.
//! У витрины `try` нет: сбой хранилища — 500 границы.
//!
//! Разбор id торговца и 400 `INVALID_MERCHANT_ID` на любом методе — общий
//! страж таблицы (`routes::mod`, 5449–5454); витрина берёт уже разобранный id.
//!
//! Отклонение: герои ведущего (`campaignHeroIds`) узнаются в [`blocking`] до
//! задания ядра, то есть до сверки повтора ключа (в JS — после). Различие
//! видно только при сбое хранилища аккаунтов.

use std::rc::Rc;
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use sk_core::js;
use sk_orchestrator::autonomous_orchestrator::OrchestratorError;
use sk_orchestrator::game_orchestrator::HandleInput;

use crate::access::{campaign_hero_values, can_access_room, can_use_hero, require_admin, require_user};
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::merchant_guard::{assert_merchant_lifecycle_idempotency, assert_merchant_lifecycle_result_fingerprint, js_string, js_string_or_empty, lifecycle_integer_default, sanitize_merchant_lifecycle_command, utf16_len};
use crate::orchestration::orchestration;
use crate::projection::{latest_campaign_state, persist_authoritative_projection, PersistOptions};
use crate::room::{get_room, Room};
use crate::routes::campaigns::Caught;
use crate::routes::{merchant_route_id, MERCHANT_PATH};
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    vec![
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/merchants\/commands$/` и `POST` (5223–5224).
        Route::post(5257, Matcher::path_template("/api/campaigns/{id}/merchants/commands"), lifecycle),
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/merchants\/assemble$/` и `POST` (5253–5254).
        Route::post(5287, Matcher::path_template("/api/campaigns/{id}/merchants/assemble"), assemble),
        // Общая регулярка торговца (5450) и `GET` без хвоста `/commands` (5456).
        Route::pass(5489, Methods::One(Method::GET), Matcher::path_template(MERCHANT_PATH), merchant_view),
    ]
}

/// Коды 409 обоих маршрутов (5244, 5301).
const CONFLICT_CODES: &[&str] = &["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "MERCHANT_ALREADY_EXISTS"];
/// Коды 403 `merchants/commands` (5246).
const FORBIDDEN_CODES: &[&str] = &["ACTOR_FORBIDDEN", "PLAYER_COMMAND_FORBIDDEN", "MERCHANT_LIFECYCLE_COMMAND_FORBIDDEN"];
/// Ключи тела сборки (5264).
const ASSEMBLE_KEYS: &[&str] = &["expected_state_version", "settlement_type", "theme", "seed", "budget_cp", "director_intent", "idempotency_key"];

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(value) if !value.is_null() => Some(value),
        _ => b,
    }
}

fn reply(status: StatusCode, message: &str, code: &str) -> Caught {
    Caught::Reply(ApiError::coded(status, message, code))
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

/// `getRoom(code)` в ядре; сбой — в `catch` маршрута.
async fn room_of(state: &AppState, code: &str) -> Result<Room, Caught> {
    let code = code.to_string();
    Ok(state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??)
}

/// `!room.state`.
fn has_state(room: &Room) -> bool {
    js::truthy(room.state.as_ref())
}

/// `String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim()`;
/// пустой или длиннее 200 — ранний ответ 400.
fn idempotency_key(body: &Value, ctx: &RouteCtx) -> Result<String, Caught> {
    let header = crate::http::has_header(&ctx.headers, "x-idempotency-key").then(|| Value::String(ctx.header("x-idempotency-key")));
    let raw = js_string_or_empty(nullish(body.get("idempotency_key"), header.as_ref()))?;
    let key = sk_core::text::trim(&raw).to_string();
    if key.is_empty() || utf16_len(&key) > 200 {
        return Err(reply(StatusCode::BAD_REQUEST, "Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов", "IDEMPOTENCY_KEY_REQUIRED"));
    }
    Ok(key)
}

// --- executeMerchantLifecycleCommand (1221–1240) ---------------------------------

/// Вход `executeMerchantLifecycleCommand`.
struct Lifecycle {
    campaign_id: String,
    room: Room,
    admin: Value,
    command: Value,
    idempotency_key: String,
    message: &'static str,
}

/// Санитайзер, затем задание ядра: сверка ключа, оркестратор, отпечаток
/// итога, проекция.
async fn execute_lifecycle(state: &Arc<AppState>, job: Lifecycle) -> Result<Value, Caught> {
    let command = sanitize_merchant_lifecycle_command(&job.command)?;
    let accounts = state.accounts.clone();
    let (admin, campaign) = (job.admin.clone(), job.campaign_id.clone());
    let hero_ids = blocking(move || campaign_hero_values(&accounts, &admin, &campaign)).await??;
    let app = state.clone();
    let result = state.core.call(move |core| Box::pin(async move { run_lifecycle(core, app, job, command, hero_ids).await })).await??;
    Ok(result)
}

async fn run_lifecycle(core: Rc<GameCore>, app: Arc<AppState>, job: Lifecycle, command: Value, hero_ids: Vec<Value>) -> Result<Value, Failure> {
    let campaign_id = job.campaign_id.as_str();
    assert_merchant_lifecycle_idempotency(core.events.as_ref(), campaign_id, &job.idempotency_key, &command)?;
    let room_state = job.room.state.clone().unwrap_or(Value::Null);
    let active = room_state.get("activePlayerId");
    let player_id = if js::truthy(active) { js_string(active)? } else { String::new() };
    let input = json!({
        "state": room_state,
        "campaignId": campaign_id,
        "playerId": player_id,
        "message": job.message,
        "commands": [command.clone()],
        "idempotencyKey": job.idempotency_key,
        "user": job.admin,
        "allowedActorIds": hero_ids,
    });
    let set = orchestration(&core, &app)?;
    let mut result = set.game.handle(HandleInput::new(input)).await.map_err(orchestrator_failure)?;
    assert_merchant_lifecycle_result_fingerprint(&result, &command)?;
    let authoritative = result.get("authoritative_state").filter(|state| js::truthy(Some(state))).cloned();
    let projected = match &authoritative {
        Some(engine_state) => {
            let mechanics = result.get("mechanics").and_then(Value::as_array).cloned().unwrap_or_default();
            persist_authoritative_projection(&core, campaign_id, engine_state, &mechanics, None, PersistOptions::default())?
        }
        None => None,
    };
    if let Some(map) = result.as_object_mut() {
        // `projected?.state ?? result.authoritative_state`.
        if let Some(projected_state) = projected.as_ref().and_then(|room| room.state.clone()).filter(|state| !state.is_null()) {
            map.insert("authoritative_state".into(), projected_state);
        }
        // Ответ ведущему — состояние целиком, без проекции: в форме JS
        // (производные поля героев значениями, урок 2).
        if let Some(state) = map.get_mut("authoritative_state") {
            *state = sk_rules::derived::materialized_state(state);
        }
        let version = projected.as_ref().map_or(job.room.version, |room| room.version);
        map.insert("room_version".into(), Value::from(version));
    }
    Ok(result)
}

// --- POST merchants/commands (5222–5250) ---------------------------------------

fn lifecycle(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let admin = require_admin(ctx).await?;
        let campaign_id = ctx.param(0).to_string();
        match lifecycle_try(ctx, admin, campaign_id).await {
            Ok(body) => Ok(json(StatusCode::OK, &body)),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => {
                let groups: [(&[&str], StatusCode); 3] = [(CONFLICT_CODES, StatusCode::CONFLICT), (&["MERCHANT_NOT_FOUND"], StatusCode::NOT_FOUND), (FORBIDDEN_CODES, StatusCode::FORBIDDEN)];
                Err(failure.respond_by(&groups, StatusCode::BAD_REQUEST))
            }
        }
    })
}

async fn lifecycle_try(ctx: &mut RouteCtx, admin: Value, campaign_id: String) -> Result<Value, Caught> {
    let room = room_of(&ctx.state, &campaign_id).await?;
    if !has_state(&room) {
        return Err(reply(StatusCode::NOT_FOUND, "Кампания не найдена", "CAMPAIGN_NOT_FOUND"));
    }
    if ctx.state.limits.exceeds_rate(&format!("merchant-lifecycle:{}", js::string(admin.get("id"))), 60, None) {
        return Err(reply(StatusCode::TOO_MANY_REQUESTS, "Слишком много изменений торговцев. Подождите немного и повторите попытку", "MERCHANT_LIFECYCLE_RATE_LIMITED"));
    }
    let body = ctx.json_body().await?;
    let Some(command) = body.get("command").filter(|command| command.is_object()).cloned() else {
        return Err(reply(StatusCode::BAD_REQUEST, "Нужна ровно одна lifecycle-команда торговца", "INVALID_MERCHANT_LIFECYCLE_COMMAND"));
    };
    let idempotency_key = idempotency_key(&body, ctx)?;
    let state = ctx.state.clone();
    execute_lifecycle(&state, Lifecycle { campaign_id, room, admin, command, idempotency_key, message: "Административное изменение торговца" }).await
}

// --- POST merchants/assemble (5252–5305) ---------------------------------------

fn assemble(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let admin = require_admin(ctx).await?;
        let campaign_id = ctx.param(0).to_string();
        match assemble_try(ctx, admin, campaign_id).await {
            Ok(body) => Ok(json(StatusCode::OK, &body)),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => Err(failure.respond_by(&[(CONFLICT_CODES, StatusCode::CONFLICT)], StatusCode::BAD_REQUEST)),
        }
    })
}

/// Предложение `ShopAssembler` для текущей сцены (5271–5287): торговец и
/// команда `CreateMerchant` для него.
fn shop_proposal(core: &GameCore, campaign_id: &str, room: &Room, body: &Value) -> Result<Value, Failure> {
    let authoritative = latest_campaign_state(core, campaign_id, room.state.as_ref())?;
    let location = sk_core::text::trim(&js_string_or_empty(get(get(Some(&authoritative), "scene"), "location"))?).to_string();
    if location.is_empty() {
        return Err(Failure::new("У текущей сцены не задана локация для магазина", Some("INVALID_LOCATION")));
    }
    let town = Value::String("town".into());
    let general = Value::String("general".into());
    let settlement_type = nullish(body.get("settlement_type"), Some(&town)).cloned().unwrap_or(Value::Null);
    let theme = nullish(body.get("theme"), Some(&general)).cloned().unwrap_or(Value::Null);
    let seed_text = format!("{campaign_id}\0{location}\0{}\0{}", js_string(Some(&settlement_type))?, js_string(Some(&theme))?);
    let default_seed = Value::String(sk_core::hash::sha256_hex(seed_text.as_bytes()));
    let default_budget = Value::from(20_000);
    let mut input = Map::new();
    input.insert("location".into(), Value::String(location));
    input.insert("settlement_type".into(), settlement_type);
    input.insert("theme".into(), theme);
    input.insert("seed".into(), nullish(body.get("seed"), Some(&default_seed)).cloned().unwrap_or(Value::Null));
    input.insert("budget_cp".into(), nullish(body.get("budget_cp"), Some(&default_budget)).cloned().unwrap_or(Value::Null));
    if let Some(intent) = body.get("director_intent").filter(|intent| !intent.is_null()) {
        input.insert("director_intent".into(), intent.clone());
    }
    sk_economy::shop_assembler::assemble_shop(Some(&Value::Object(input))).map_err(|error| Failure::new(error.message, Some(&error.code)))
}

async fn assemble_try(ctx: &mut RouteCtx, admin: Value, campaign_id: String) -> Result<Value, Caught> {
    let room = room_of(&ctx.state, &campaign_id).await?;
    if !has_state(&room) {
        return Err(reply(StatusCode::NOT_FOUND, "Кампания не найдена", "CAMPAIGN_NOT_FOUND"));
    }
    if ctx.state.limits.exceeds_rate(&format!("shop-assemble:{}", js::string(admin.get("id"))), 30, None) {
        return Err(reply(StatusCode::TOO_MANY_REQUESTS, "Слишком много запросов сборки магазинов. Подождите немного и повторите попытку", "SHOP_ASSEMBLY_RATE_LIMITED"));
    }
    // `readBody` отказывает сам, если тело не объект (`INVALID_JSON_BODY`):
    // проверка `INVALID_SHOP_INPUT` (5262) до ответа не доходит.
    let body = ctx.json_body().await?;
    if body.as_object().is_some_and(|map| map.keys().any(|key| !ASSEMBLE_KEYS.contains(&key.as_str()))) {
        return Err(Failure::new("Запрос сборки содержит неизвестное поле", Some("UNEXPECTED_SHOP_FIELD")).into());
    }
    let idempotency_key = idempotency_key(&body, ctx)?;
    let expected_state_version = lifecycle_integer_default(body.get("expected_state_version"), "expected_state_version")?;
    let (code, job_room, job_body) = (campaign_id.clone(), room.clone(), body.clone());
    let proposal = ctx.state.core.call(move |core| Box::pin(async move { shop_proposal(&core, &code, &job_room, &job_body) })).await??;
    let mut command = Map::new();
    command.insert("command_type".into(), Value::String("CreateMerchant".into()));
    command.insert("expected_state_version".into(), Value::from(expected_state_version));
    if let Some(merchant) = proposal.get("merchant") {
        command.insert("merchant".into(), merchant.clone());
    }
    let state = ctx.state.clone();
    let job = Lifecycle { campaign_id, room, admin, command: Value::Object(command), idempotency_key, message: "ShopAssembler создаёт торговца для текущей сцены" };
    let mut result = execute_lifecycle(&state, job).await?;
    if let Some(map) = result.as_object_mut() {
        map.insert("shop_proposal".into(), proposal);
    }
    Ok(result)
}

// --- GET merchants/:id (5456–5472) ---------------------------------------------

fn merchant_view(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        // `!parsedUrl.pathname.endsWith('/commands')`: иначе — дальше по таблице.
        if ctx.pathname.ends_with("/commands") {
            return Ok(None);
        }
        let user = require_user(ctx).await?;
        Ok(Some(view(ctx, user).await?))
    })
}

async fn view(ctx: &RouteCtx, user: Value) -> Result<Response, ApiError> {
    let campaign_id = ctx.param(0).to_string();
    let merchant_id = merchant_route_id(ctx.param(1)).unwrap_or_default();
    let code = campaign_id.clone();
    let room = ctx.state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
    if !has_state(&room) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена"));
    }
    let accounts = ctx.state.accounts.clone();
    let (checked_user, checked_room) = (user.clone(), room.clone());
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &checked_room)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
    }
    // `String(parsedUrl.searchParams.get('actor_id') || '')`.
    let actor = ctx.search_param("actor_id").unwrap_or_default();
    let accounts = ctx.state.accounts.clone();
    let (checked_user, hero, code) = (user.clone(), Value::String(actor.clone()), campaign_id.clone());
    if actor.is_empty() || !blocking(move || can_use_hero(&accounts, &checked_user, Some(&hero), &code)).await?? {
        return Err(ApiError::coded(StatusCode::FORBIDDEN, "Торговать можно только от имени своего героя", "ACTOR_FORBIDDEN"));
    }
    let version = room.version;
    let (status, body) = ctx
        .state
        .core
        .call(move |core| Box::pin(async move { merchant_view_reply(&core, &campaign_id, &room, &merchant_id, &actor, version) }))
        .await??;
    Ok(json(status, &body))
}

/// Витрина и доступность торговца (5463–5471).
fn merchant_view_reply(core: &GameCore, campaign_id: &str, room: &Room, merchant_id: &str, actor: &str, version: i64) -> Result<(StatusCode, Value), Failure> {
    let state = latest_campaign_state(core, campaign_id, room.state.as_ref())?;
    let Some(view) = sk_economy::merchant_economy::merchant_view_for(&state, Some(&Value::String(merchant_id.to_string())), Some(&Value::String(actor.to_string()))) else {
        return Ok((StatusCode::NOT_FOUND, json!({ "error": "Торговец или герой не найден", "code": "MERCHANT_NOT_FOUND" })));
    };
    let availability = sk_economy::merchant_economy::merchant_trade_availability_for(&state, view.get("merchant"), false);
    if !availability.can_trade {
        let status = if availability.code == Some("MERCHANT_NOT_FOUND") { StatusCode::NOT_FOUND } else { StatusCode::CONFLICT };
        let error = availability.reason.filter(|reason| !reason.is_empty()).unwrap_or_else(|| "Торговец сейчас недоступен".to_string());
        let code = availability.code.filter(|code| !code.is_empty()).unwrap_or("MERCHANT_UNAVAILABLE");
        return Ok((status, json!({ "error": error, "code": code })));
    }
    Ok((StatusCode::OK, json!({ "merchant_view": view, "room_version": version })))
}
