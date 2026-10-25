//! С8: откат ведущего и жизненный цикл кампании —
//! `POST /api/campaigns/:id/controls` (4901–4964), `GET` и `POST
//! /api/campaigns/:id/lifecycle` (4967–5037).
//!
//! Все три маршрута сравнивают `pathname` (строка запроса не мешает); на
//! другом методе запрос идёт дальше по таблице и кончается 404 «API endpoint
//! не найден».
//!
//! - **Откат** (`rewind_turn`, `replay_scene`) — владельческая операция над
//!   журналом: план по действующей ветви истории ([`plan_campaign_control`]),
//!   целевое состояние — загрузка на версии плана, событие `CampaignRewound`
//!   через управляющий вход исполнителя (`commit_control`) с
//!   **принудительным снимком**. Ключ обязателен (обрезается до 200), его
//!   повтор отдаёт прежний коммит, повтор с другим действием — 409
//!   `IDEMPOTENCY_CONFLICT`. `event_id` = `campaign-control:` +
//!   sha256(`campaignId\0key`)[..24].
//! - **Жизненный цикл** — производный коммит (`commit_derived`,
//!   `Producer::CampaignLifecycle`); ключ — из тела, заголовка или новый uuid.
//!   Финал (`CampaignCompleted`) дописывает сводку `NarrativeSummaryRecorded`
//!   с детерминированными id. Найденный по ключу коммит отдаётся как есть,
//!   без сверки действия (как в JS).
//!
//! Обработка ошибок повторяет `try/catch` JS: `requireUser` вне `try`;
//! в `controls` и `POST lifecycle` всё остальное — в нём, отказ — 409 для
//! своих кодов, иначе 400 `{ error, code }`. `GET lifecycle` целиком вне
//! `try`: сбой — 500 на последней границе. Журнал и комната — в ядре одним
//! заданием (между чтением ключа и коммитом JS тоже не уступал другим
//! запросам ничего, что меняет итог: коммит сверяет версию), аккаунты — через
//! [`blocking`].
//!
//! Отклонения: строки обрезаются по символам, а не по единицам UTF-16
//! (`slice(0, 180)`/`slice(0, 2_000)` у сводки финала) — разница только у
//! символов вне BMP на границе обрезки. Испорченный журнал (комнату не
//! собрать) — 400 с отказом восстановления у `controls`/`POST lifecycle` и
//! 500 у `GET lifecycle`; в JS комната — свой файл, и отказ пришёл бы позже,
//! из `eventStore.load`, с тем же статусом.

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sk_core::js;
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Producer};
use sk_store::{CommitResult, LoadOptions};

use crate::access::{campaign_hero_ids, can_access_room, require_user, viewer_state_for};
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, ApiResult, Failure};
use crate::http::json;
use crate::projection::{executor_failure, persist_authoritative_projection, HookedJournal, PersistOptions};
use crate::room::{self, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    vec![
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/controls$/` и `POST`.
        Route::post(4903, Matcher::path_template("/api/campaigns/{id}/controls"), campaign_controls),
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/lifecycle$/`; метод — в обработчике
        // (`GET` 4968, `POST` 4976), прочие идут дальше по таблице.
        Route::pass(4968, Methods::Any, Matcher::path_template("/api/campaigns/{id}/lifecycle"), campaign_lifecycle),
    ]
}

/// Коды отказа отката, которые JS отдаёт как 409 (4957).
const CONTROL_CONFLICTS: [&str; 4] = ["NOTHING_TO_REWIND", "NOTHING_TO_REPLAY", "STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"];
/// Коды отказа жизненного цикла, которые JS отдаёт как 409 (5034).
const LIFECYCLE_CONFLICTS: [&str; 4] = ["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "INVALID_CAMPAIGN_TRANSITION", "CAMPAIGN_COMBAT_ACTIVE"];

// --- общее ------------------------------------------------------------------

/// `catch (error) { const status = CODES.includes(error?.code) ? 409 : 400; … }`.
fn settle(outcome: Result<axum::response::Response, Caught>, conflicts: &[&str]) -> ApiResult {
    match outcome {
        Ok(response) => Ok(response),
        Err(Caught::Reply(error)) => Err(error),
        Err(Caught::Thrown(failure)) => Err(failure.respond_by(&[(conflicts, StatusCode::CONFLICT)], StatusCode::BAD_REQUEST)),
    }
}

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

/// `String(value ?? '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    if js::present(value) {
        js::s(value)
    } else {
        String::new()
    }
}

/// `createHash('sha256').update(text).digest('hex').slice(0, 24)`.
fn digest24(text: &str) -> String {
    sk_core::text::head(&sk_core::hash::sha256_hex(text), 24)
}

/// `getRoom(code)` в ядре.
async fn get_room(state: &AppState, code: &str) -> Result<Result<Room, Failure>, crate::core::CoreError> {
    let code = code.to_string();
    state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await
}

/// `campaignMembershipFor(user.id, campaignId)?.role === 'owner'` или администратор.
async fn may_manage(state: &AppState, user: &Value, campaign_id: &str) -> Result<bool, Caught> {
    if is_admin(user) {
        return Ok(true);
    }
    let accounts = state.accounts.clone();
    let (user_id, campaign) = (js::s(user.get("id")), campaign_id.to_string());
    let membership = blocking(move || accounts.campaign_membership_for(&user_id, &campaign)).await??;
    Ok(membership.as_ref().and_then(|membership| membership.get("role")).and_then(Value::as_str) == Some("owner"))
}

/// `viewerStateFor(state, user, actorId)`, где актор — первый свой герой,
/// который есть в `state.players` (4951, 5026).
async fn viewer_state(state: &AppState, user: &Value, campaign_id: &str, response_state: &Value) -> Result<Value, Caught> {
    let accounts = state.accounts.clone();
    let (viewer, campaign) = (user.clone(), campaign_id.to_string());
    let hero_ids = blocking(move || campaign_hero_ids(&accounts, &viewer, &campaign)).await??;
    let players = response_state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let actor_id = hero_ids.into_iter().find(|id| players.iter().any(|player| js::string(player.get("id")) == *id)).unwrap_or_default();
    Ok(viewer_state_for(response_state, user, Some(&Value::String(actor_id)))?.unwrap_or(Value::Null))
}

/// Первое событие коммита (`committed.events[0]`).
fn first_payload(commit: &CommitResult) -> Option<&Value> {
    commit.events.first().and_then(|event| event.get("payload"))
}

// --- POST /api/campaigns/:id/controls ---------------------------------------

/// Тело задания ядра (4916–4949): найти коммит по ключу или откатить, затем
/// спроецировать с обновлением проектора.
fn rewind(core: &std::rc::Rc<GameCore>, campaign_id: &str, idempotency_key: &str, action: &str, actor_id: &str) -> Result<(CommitResult, Option<Room>), Failure> {
    let mut committed = core.events.get_by_idempotency_key(campaign_id, idempotency_key)?;
    if let Some(found) = &committed {
        let committed_action = sk_core::text::trim(&string_or_empty(first_payload(found).and_then(|payload| payload.get("action")))).to_string();
        if committed_action != action {
            return Err(Failure::new("Этот idempotency_key уже использован для другого действия кампании", Some("IDEMPOTENCY_CONFLICT")));
        }
    }
    let committed = match committed.take() {
        Some(found) => found,
        None => {
            let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
            let events = core.events.get_events(campaign_id, 0, Some(loaded.state_version))?;
            let action_value = Value::String(action.to_string());
            let plan = sk_scenario::campaign_controls::plan_campaign_control(Some(&action_value), Some(&Value::Array(events)), Some(&Value::from(loaded.state_version))).map_err(control_failure)?;
            let target = core.events.load(campaign_id, &LoadOptions { at_version: Some(plan.target_version), ..LoadOptions::default() })?;
            let mut event = sk_scenario::campaign_controls::campaign_rewind_event(
                Some(&action_value),
                Some(&target.state),
                Some(&loaded.state),
                Some(&Value::from(plan.target_version)),
                Some(&Value::String(actor_id.to_string())),
                None,
            )
            .map_err(control_failure)?;
            if let Some(map) = event.as_object_mut() {
                map.insert("event_id".into(), Value::String(format!("campaign-control:{}", digest24(&format!("{campaign_id}\0{idempotency_key}")))));
            }
            // Откат переписывает состояние целиком: отдельный вход и снимок сразу.
            let journal = HookedJournal(&core.events);
            AuthoritativeExecutor::new(&journal).commit_control(campaign_id, idempotency_key, &event, Producer::CampaignControl, true).map_err(executor_failure)?.commit
        }
    };
    let projected = persist_authoritative_projection(core, campaign_id, &committed.state, &committed.events, None, PersistOptions { force_projector_refresh: true, await_projection: false })?;
    Ok((committed, projected))
}

fn control_failure(error: sk_scenario::campaign_controls::CampaignControlError) -> Failure {
    Failure::new(error.message, Some(&error.code))
}

async fn controls_body(ctx: &mut RouteCtx, user: &Value, campaign_id: &str) -> Result<axum::response::Response, Caught> {
    let room = get_room(&ctx.state, campaign_id).await??;
    if room.state.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into());
    }
    if !may_manage(&ctx.state, user, campaign_id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Откатывать ход или сцену может только владелец кампании").into());
    }
    let body = ctx.json_body().await?;
    let action = sk_core::text::trim(&string_or_empty(body.get("action"))).to_string();
    let idempotency_key = crate::idempotency::required_key_sliced(&body, &ctx.headers)?;
    let job = (campaign_id.to_string(), idempotency_key, action.clone(), js::s(user.get("id")));
    let (committed, projected) = ctx.state.core.call(move |core| Box::pin(async move { rewind(&core, &job.0, &job.1, &job.2, &job.3) })).await??;
    let response_state = projected.as_ref().and_then(|room| room.state.clone()).unwrap_or_else(|| committed.state.clone());
    let viewer = viewer_state(&ctx.state, user, campaign_id, &response_state).await?;
    let target_version = first_payload(&committed).and_then(|payload| payload.get("target_version")).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    let mut reply = Map::new();
    reply.insert("campaign_id".into(), Value::from(campaign_id));
    reply.insert("action".into(), Value::String(action));
    reply.insert("target_version".into(), target_version);
    reply.insert("duplicate".into(), Value::Bool(committed.duplicate));
    reply.insert("version".into(), Value::from(projected.as_ref().map_or(room.version, |room| room.version)));
    reply.insert("state".into(), viewer);
    Ok(json(StatusCode::OK, &Value::Object(reply)))
}

/// `POST /api/campaigns/:id/controls` (4901–4964): откат хода или сцены
/// владельцем кампании или администратором.
fn campaign_controls(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let outcome = controls_body(ctx, &user, &campaign_id).await;
        settle(outcome, &CONTROL_CONFLICTS)
    })
}

// --- GET /api/campaigns/:id/lifecycle ---------------------------------------

/// Разбор пути жизненного цикла (4967): `GET` и `POST` — свои обработчики.
fn campaign_lifecycle(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        if ctx.method == axum::http::Method::GET {
            get_lifecycle(ctx).await.map(Some)
        } else if ctx.method == axum::http::Method::POST {
            post_lifecycle(ctx).await.map(Some)
        } else {
            Ok(None)
        }
    })
}

/// `GET /api/campaigns/:id/lifecycle` (4967–4974): жизненный цикл любому, кто
/// видит кампанию; всё вне `try` — сбой даёт 500 на границе.
fn get_lifecycle(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let room = get_room(&ctx.state, &campaign_id).await?.map_err(|failure| ApiError::internal(failure.to_string()))?;
        let Some(state) = room.state.clone() else { return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена")) };
        let accounts = ctx.state.accounts.clone();
        let viewer = user.clone();
        let checked = room.clone();
        let allowed = blocking(move || can_access_room(&accounts, Some(&viewer), &checked)).await?.map_err(|failure| ApiError::internal(failure.to_string()))?;
        if !allowed {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
        }
        let normalized = sk_rules::normalize::normalize_campaign_state(&state).map_err(|error| ApiError::internal(Failure::from(error).to_string()))?;
        let mut reply = Map::new();
        reply.insert("campaign_id".into(), Value::String(campaign_id));
        // `lifecycle: undefined` в JSON не попадает.
        if let Some(lifecycle) = normalized.get("mechanics").and_then(|mechanics| mechanics.get("campaign_lifecycle")) {
            reply.insert("lifecycle".into(), lifecycle.clone());
        }
        Ok(json(StatusCode::OK, &Value::Object(reply)))
    })
}

// --- POST /api/campaigns/:id/lifecycle --------------------------------------

/// Сводка финала (4996–5017): `NarrativeSummaryRecorded` к `CampaignCompleted`.
fn finale_summary(campaign_id: &str, idempotency_key: &str, actor_id: &Value, state: &Value, lifecycle_event: &Value, lifecycle_event_id: &str) -> Result<Value, Failure> {
    let payload = lifecycle_event.get("payload");
    let epilogue = payload.and_then(|payload| payload.get("epilogue"));
    let summary_text = if js::truthy(epilogue) { epilogue } else { payload.and_then(|payload| payload.get("reason")) };
    let title = if js::truthy(state.get("campaign")) { js::s(state.get("campaign")) } else { "Финал кампании".to_string() };
    // `(loaded.state.worldMemory?.threads ?? []).filter(...)`.
    let threads = match state.get("worldMemory").and_then(|memory| memory.get("threads")) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(threads)) => threads.clone(),
        Some(_) => return Err(Failure::new("(intermediate value).filter is not a function", Some("TYPE_ERROR"))),
    };
    let mut thread_ids = Vec::new();
    for thread in &threads {
        if thread.is_null() {
            return Err(Failure::new("Cannot read properties of null (reading 'status')", Some("TYPE_ERROR")));
        }
        if thread.get("status").and_then(Value::as_str) == Some("active") {
            thread_ids.push(thread.get("id").cloned().unwrap_or(Value::Null));
        }
    }
    thread_ids.truncate(30);
    let elapsed = js::number(state.get("mechanics").and_then(|mechanics| mechanics.get("world_time")).and_then(|time| time.get("elapsed_minutes")));
    let elapsed = if elapsed.is_nan() { 0.0 } else { elapsed };
    // `Math.max(0, x)`: `-0` становится `0`.
    let recorded = if elapsed > 0.0 { elapsed } else { 0.0 };
    Ok(json!({
        "event_id": format!("session-summary:{}", digest24(&format!("{campaign_id}\0{idempotency_key}\0summary"))),
        "event_type": "NarrativeSummaryRecorded",
        "actor_id": actor_id,
        "target_ids": [],
        "visibility": "party",
        "source_rule_ids": [],
        "payload": {
            "summary": {
                "id": format!("campaign-summary:{}", digest24(&format!("{campaign_id}\0{idempotency_key}"))),
                "kind": "session",
                "title": sk_core::text::slice(&title, 0, Some(180)),
                "summary": sk_core::text::slice(&js::s(summary_text), 0, Some(2_000)),
                "visibility": "party",
                "entity_ids": [],
                "thread_ids": thread_ids,
                "source_event_ids": [lifecycle_event_id],
                "source_command_id": format!("campaign-lifecycle:{idempotency_key}"),
                "recorded_at_minutes": js::num(recorded),
            },
        },
    }))
}

/// Тело задания ядра (4985–5025): событие перехода (и сводка финала), коммит
/// или повтор по ключу, проекция.
fn transition(core: &std::rc::Rc<GameCore>, campaign_id: &str, idempotency_key: &str, body: &Value, actor_id: &str) -> Result<(CommitResult, Option<Room>), Failure> {
    let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
    let duplicate = core.events.get_by_idempotency_key(campaign_id, idempotency_key)?;
    let committed = match duplicate {
        Some(found) => found,
        None => {
            // `{ actorId: user.id, reason: body.reason }`: `reason: undefined` — поля нет.
            let mut options = Map::new();
            options.insert("actorId".into(), Value::String(actor_id.to_string()));
            if let Some(reason) = body.get("reason") {
                options.insert("reason".into(), reason.clone());
            }
            let mut lifecycle_event = sk_director::campaign_lifecycle::lifecycle_event_for_action(body.get("action"), &loaded.state, Some(&Value::Object(options))).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
            let lifecycle_event_id = format!("campaign-lifecycle:{}", digest24(&format!("{campaign_id}\0{idempotency_key}")));
            if let Some(map) = lifecycle_event.as_object_mut() {
                map.insert("event_id".into(), Value::String(lifecycle_event_id.clone()));
            }
            let mut events = vec![lifecycle_event.clone()];
            if lifecycle_event.get("event_type").and_then(Value::as_str) == Some("CampaignCompleted") {
                events.push(finale_summary(campaign_id, idempotency_key, &Value::String(actor_id.to_string()), &loaded.state, &lifecycle_event, &lifecycle_event_id)?);
            }
            let journal = HookedJournal(&core.events);
            let executed = AuthoritativeExecutor::new(&journal).commit_derived(DerivedRequest::events(campaign_id, idempotency_key, Producer::CampaignLifecycle, events)).map_err(executor_failure)?;
            // Готовые события не бывают пустыми: `None` только у сборщика `derive_events`.
            let Some(executed) = executed else { return Err(Failure::new("Производное событие не было подтверждено", Some("COMMIT_FAILED"))) };
            executed.commit
        }
    };
    let projected = persist_authoritative_projection(core, campaign_id, &committed.state, &committed.events, None, PersistOptions::default())?;
    Ok((committed, projected))
}

async fn lifecycle_body(ctx: &mut RouteCtx, user: &Value, campaign_id: &str) -> Result<axum::response::Response, Caught> {
    let room = get_room(&ctx.state, campaign_id).await??;
    if room.state.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into());
    }
    if !may_manage(&ctx.state, user, campaign_id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Управлять жизненным циклом может только владелец кампании").into());
    }
    let body = ctx.json_body().await?;
    // `String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? randomUUID())`.
    let idempotency_key = crate::idempotency::key_nullish_raw(&body, &ctx.headers).map_or_else(sk_core::hash::uuid_v4, |key| js::string(Some(&key)));
    let job = (campaign_id.to_string(), idempotency_key, body, js::s(user.get("id")));
    let (committed, projected) = ctx.state.core.call(move |core| Box::pin(async move { transition(&core, &job.0, &job.1, &job.2, &job.3) })).await??;
    // `projected.version` у `null` — TypeError внутри `try`.
    let Some(projected) = projected else { return Err(Failure::new("Cannot read properties of null (reading 'version')", Some("TYPE_ERROR")).into()) };
    let viewer = viewer_state(&ctx.state, user, campaign_id, &committed.state).await?;
    let Some(mechanics) = committed.state.get("mechanics").filter(|mechanics| js::present(Some(mechanics))) else {
        return Err(Failure::new("Cannot read properties of undefined (reading 'campaign_lifecycle')", Some("TYPE_ERROR")).into());
    };
    let mut reply = Map::new();
    reply.insert("campaign_id".into(), Value::from(campaign_id));
    if let Some(lifecycle) = mechanics.get("campaign_lifecycle") {
        reply.insert("lifecycle".into(), lifecycle.clone());
    }
    reply.insert("version".into(), Value::from(projected.version));
    reply.insert("state".into(), viewer);
    Ok(json(StatusCode::OK, &Value::Object(reply)))
}

/// `POST /api/campaigns/:id/lifecycle` (4975–5037): переход жизненного цикла
/// владельцем кампании или администратором.
fn post_lifecycle(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let outcome = lifecycle_body(ctx, &user, &campaign_id).await;
        settle(outcome, &LIFECYCLE_CONFLICTS)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_are_sha256_prefixes() {
        // `createHash('sha256').update('CTRL-1\0k').digest('hex').slice(0, 24)`.
        let id = digest24("CTRL-1\0k");
        assert_eq!(id.len(), 24);
        assert_eq!(id, sk_core::hash::sha256_hex("CTRL-1\0k")[..24]);
    }

    #[test]
    fn finale_summary_follows_js_fields() {
        let state = json!({
            "campaign": "Сказ",
            "worldMemory": { "threads": [{ "id": "t1", "status": "active" }, { "id": "t2", "status": "closed" }] },
            "mechanics": { "world_time": { "elapsed_minutes": "-5" } },
        });
        let event = json!({ "payload": { "epilogue": "", "reason": "complete" } });
        let summary = finale_summary("C", "k", &json!("u"), &state, &event, "campaign-lifecycle:x").map(|value| value["payload"]["summary"].clone()).ok();
        let summary = summary.unwrap_or(Value::Null);
        assert_eq!(summary["title"], json!("Сказ"));
        assert_eq!(summary["summary"], json!("complete"), "пустой эпилог — причина");
        assert_eq!(summary["thread_ids"], json!(["t1"]));
        assert_eq!(summary["recorded_at_minutes"], json!(0));
        assert_eq!(summary["source_command_id"], json!("campaign-lifecycle:k"));
        let untitled = finale_summary("C", "k", &json!("u"), &json!({}), &event, "x").map(|value| value["payload"]["summary"]["title"].clone()).ok();
        assert_eq!(untitled, Some(json!("Финал кампании")));
        assert!(finale_summary("C", "k", &json!("u"), &json!({ "worldMemory": { "threads": {} } }), &event, "x").is_err());
    }

    #[test]
    fn string_or_empty_is_nullish() {
        assert_eq!(string_or_empty(None), "");
        assert_eq!(string_or_empty(Some(&Value::Null)), "");
        assert_eq!(string_or_empty(Some(&json!(false))), "false");
    }
}
