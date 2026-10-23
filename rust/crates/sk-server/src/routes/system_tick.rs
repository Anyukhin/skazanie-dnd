//! С17: системный такт — `POST /api/campaigns/:id/system-tick`
//! (`server/index.mjs:5958–6005`).
//!
//! Устаревшая проекция переписывается из головы журнала, идущий бой
//! продолжается стадией `combat-continuation` координатора последствий, затем
//! такт часов лавки и молвы; ответ — комната зрителя со счётчиками событий
//! часов. `STATE_VERSION_CONFLICT` и `IDEMPOTENCY_CONFLICT` (такт столкнулся с
//! чужим коммитом) — 200 с текущей комнатой без счётчиков; прочий сбой внутри
//! `try` — 400 с текстом ошибки, без кода.
//!
//! Маршрут объявлен с номером строки `server/index.mjs`, где JS его проверяет
//! (`systemTickMatch`, 5958): путь (`pathname`), метод POST.
//!
//! Комната, журнал и часы — одно задание ядра; аккаунты (доступ, герои
//! зрителя) — через [`blocking`] до и после него. Проверка «кампания играбельна»
//! идёт по снимку комнаты первого шага, как `room.state` в JS.

use axum::http::StatusCode;
use serde_json::Value;
use sk_core::js;

use crate::access::{can_access_room, owned_viewer_actor_id, require_user, viewer_state_for};
use crate::core::blocking;
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, ApiResult, Failure};
use crate::http::json;
use crate::projection::{persist_authoritative_projection, PersistOptions};
use crate::room::{get_room, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    // `parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/system-tick$/)` и `POST` (5958–5959).
    vec![Route::post(5958, Matcher::path_template("/api/campaigns/{id}/system-tick"), system_tick)]
}

/// Конфликты такта с чужим коммитом: ответ — комната как есть (5994–5998).
const RACE_CODES: [&str; 2] = ["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"];

fn system_tick(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let state = ctx.state.clone();
        match tick(&state, &campaign_id, &user).await {
            Ok(response) => Ok(response),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) if failure.code.as_deref().is_some_and(|code| RACE_CODES.contains(&code)) => current_room(&state, &campaign_id, &user).await,
            Err(Caught::Thrown(failure)) => Err(ApiError::new(StatusCode::BAD_REQUEST, failure.message)),
        }
    })
}

/// Итог задания ядра: комната после такта и сколько событий записали часы.
struct Ticked {
    room: Room,
    economy_events: usize,
    rumor_events: usize,
}

/// Тело `try` (5961–5992).
async fn tick(state: &std::sync::Arc<AppState>, campaign_id: &str, user: &Value) -> Result<axum::response::Response, Caught> {
    let code = campaign_id.to_string();
    let room = state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
    let Some(room_state) = room.state.clone() else { return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into()) };
    let accounts = state.accounts.clone();
    let (checked_user, checked_room) = (user.clone(), room.clone());
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &checked_room)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании").into());
    }
    sk_director::campaign_lifecycle::assert_campaign_playable(&room_state).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
    let code = campaign_id.to_string();
    let ticked = state.core.call(move |core| Box::pin(async move { run_tick(&core, &code, &room_state).await })).await??;
    let economy = ticked.economy_events;
    let rumor = ticked.rumor_events;
    let mut body = viewer_room(state, &ticked.room, campaign_id, user).await?;
    if let Some(map) = body.as_object_mut() {
        map.insert("economy_clock_events".into(), Value::from(economy));
        map.insert("rumor_clock_events".into(), Value::from(rumor));
    }
    Ok(json(StatusCode::OK, &body))
}

/// `Number(x ?? fallback)`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        None | Some(Value::Null) => fallback,
        some => js::number(some),
    }
}

/// Задание ядра: сверка проекции, продолжение боя, часы лавки и молвы.
async fn run_tick(core: &std::rc::Rc<crate::core::GameCore>, campaign_id: &str, room_state: &Value) -> Result<Ticked, Failure> {
    let latest = core.events.load(campaign_id, &sk_store::LoadOptions::default())?;
    let mut room = get_room(core, campaign_id)?;
    let projector = number_or(room_state.get("state_projector_version"), 1.0);
    let version = number_or(room_state.get("state_version"), 0.0);
    if projector < sk_rules::constants::GAME_STATE_PROJECTOR_VERSION as f64 || version < latest.state_version as f64 {
        persist_authoritative_projection(core, campaign_id, &latest.state, &[], None, PersistOptions { force_projector_refresh: true, ..PersistOptions::default() })?;
        room = get_room(core, campaign_id)?;
    }
    let combat_active = js::truthy(latest.state.get("mechanics").and_then(|mechanics| mechanics.get("combat")).and_then(|combat| combat.get("active")));
    if combat_active {
        let scheduler = crate::clocks::settle_combat_continuation(core, campaign_id, true).await?;
        if !scheduler.events.is_empty() {
            let advanced = core.events.load(campaign_id, &sk_store::LoadOptions::default())?;
            persist_authoritative_projection(core, campaign_id, &advanced.state, &scheduler.events, None, PersistOptions::default())?;
            room = get_room(core, campaign_id)?;
        }
    }
    let economy = crate::clocks::run_merchant_economy_clock(core, campaign_id)?;
    if !economy.events.is_empty() {
        persist_authoritative_projection(core, campaign_id, &economy.state, &economy.events, None, PersistOptions::default())?;
        room = get_room(core, campaign_id)?;
    }
    let rumor = crate::clocks::run_world_rumor_clock(core, campaign_id)?;
    if !rumor.events.is_empty() {
        persist_authoritative_projection(core, campaign_id, &rumor.state, &rumor.events, None, PersistOptions::default())?;
        room = get_room(core, campaign_id)?;
    }
    Ok(Ticked { room, economy_events: economy.events.len(), rumor_events: rumor.events.len() })
}

/// `{ ...room, state: viewerStateFor(normalizeCampaignState(room.state), user, actorId) }`,
/// где `actorId` — первый герой зрителя из состава комнаты.
async fn viewer_room(state: &AppState, room: &Room, campaign_id: &str, user: &Value) -> Result<Value, Caught> {
    let accounts = state.accounts.clone();
    let (room, code, user) = (room.clone(), campaign_id.to_string(), user.clone());
    let body = blocking(move || -> Result<Value, Failure> {
        let room_state = room.state.clone().unwrap_or(Value::Null);
        let actor = match &room_state {
            Value::Object(_) => owned_viewer_actor_id(&accounts, &room_state, &user, &code)?,
            _ => String::new(),
        };
        let normalized = sk_rules::normalize::normalize_campaign_state(&room_state)?;
        let projected = viewer_state_for(&normalized, &user, Some(&Value::String(actor)))?.unwrap_or(Value::Null);
        let mut body = room.to_json();
        body["state"] = projected;
        Ok(body)
    })
    .await??;
    Ok(body)
}

/// `catch` гонки (5994–5998): текущая комната зрителя, без счётчиков.
async fn current_room(state: &std::sync::Arc<AppState>, campaign_id: &str, user: &Value) -> ApiResult {
    let code = campaign_id.to_string();
    let outcome: Result<Value, Caught> = async {
        let room = state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
        viewer_room(state, &room, campaign_id, user).await
    }
    .await;
    match outcome {
        Ok(body) => Ok(json(StatusCode::OK, &body)),
        Err(Caught::Reply(error)) => Err(error),
        // Сбой внутри `catch` в JS уходит мимо маршрута — граница 500.
        Err(Caught::Thrown(failure)) => Err(ApiError::internal(failure.message)),
    }
}
