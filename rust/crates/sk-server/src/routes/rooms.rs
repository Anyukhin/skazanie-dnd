//! С10: комната, общий кубик, выдача кости — `server/index.mjs:6008–6114`:
//! `POST /api/rooms/:id/dice` (сырой адрес, 6010), `GET`/`PUT /api/rooms/:id`
//! (6070, 6084), `POST /api/roll` (сырой адрес, 6093).
//!
//! Маршруты объявляются с номером строки `server/index.mjs`, где JS их
//! проверяет: порядок общей таблицы (`routes::table`) выводится из этих
//! номеров. Комната (`roomMatch`) разбирается один раз на строке 6010, а метод
//! JS сверяет ниже (6069 GET, 6083 PUT): здесь это один маршрут строки 6010 с
//! набором методов `GET`/`PUT` и выбором по методу внутри. Между 6009 и 6093
//! других маршрутов нет, порядок проверок тот же. Кубик и `/api/roll`
//! сравнивают сырой `req.url`: со строкой запроса они не совпадают (404),
//! комната — `pathname` (у неё `?map_hash=`).
//!
//! Комната и журнал — только в ядре, аккаунты — только через [`blocking`]:
//! синхронный в JS шаг «комната → права → коммит» здесь — задание ядра,
//! блокирующая проверка прав и снова задание ядра. Между ними ядро может
//! исполнить чужое задание; решение принимается по снимку комнаты первого
//! шага, как в JS (`current`), а коммит всё равно идёт через журнал с
//! проверкой версии.

use axum::http::{Method, StatusCode};
use serde_json::{json, Map, Value};
use sk_core::js;
use sk_dice::{Dice, Visibility};
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Producer};

use crate::access::{access_denied_before_reconcile, campaign_membership, can_access_room, can_use_hero, owned_viewer_actor_id, require_user, string_or_empty, viewer_state_for};
use crate::command_guard::PUBLIC_DIE_SIDES;
use crate::core::{blocking, CoreError};
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, ApiResult, Failure};
use crate::http::json;
use crate::projection::{self, executor_failure, HookedJournal, PersistOptions};
use crate::room::{self, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;

/// Методы комнаты: GET (6070) и PUT (6084); прочие идут дальше, к 404.
const ROOM_METHODS: &[Method] = &[Method::GET, Method::PUT];

pub fn routes() -> Vec<Route> {
    vec![
        // `parsedUrl.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]+)$/)` (6010), GET 6069 и PUT 6083.
        Route::new(6010, Methods::Set(ROOM_METHODS), Matcher::path_template("/api/rooms/{id}"), room_route),
        // `req.url?.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/dice$/)` и `POST` (6011–6012).
        Route::post(6011, Matcher::raw_template("/api/rooms/{id}/dice"), public_die),
        // `req.url === '/api/roll' && req.method === 'POST'` (6094).
        Route::post(6094, Matcher::raw("/api/roll"), issue_roll),
    ]
}

// --- общее ------------------------------------------------------------------

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

/// `a ?? b`.
fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(first) {
        first
    } else {
        second
    }
}

/// `normalizeCampaignState(state)`.
fn normalize(state: &Value) -> Result<Value, Failure> {
    Ok(sk_rules::normalize::normalize_campaign_state(state)?)
}

/// `{ ...room, state }`: ключи комнаты в её порядке, `state` — на своём месте.
/// Состояние комнаты не копируется (Ск4): оно всё равно заменяется.
fn room_with_state(room: &Room, state: Value) -> Value {
    let mut body = Map::new();
    body.insert("version".into(), json!(room.version));
    body.insert("state".into(), state);
    body.insert("updatedAt".into(), json!(room.updated_at));
    Value::Object(body)
}

/// `getRoom(code)` в ядре.
async fn get_room(state: &AppState, code: &str) -> Result<Result<Room, Failure>, CoreError> {
    let code = code.to_string();
    state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await
}

/// `canAccessRoom(user, room)` через блокирующий поток.
async fn access(state: &AppState, user: &Value, room: Room) -> Result<Result<bool, Failure>, CoreError> {
    let accounts = state.accounts.clone();
    let user = user.clone();
    blocking(move || can_access_room(&accounts, Some(&user), &room)).await
}

// --- GET/PUT /api/rooms/:id -------------------------------------------------

fn room_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if ctx.method == Method::PUT {
            retired_room_write(ctx).await
        } else {
            read_room(ctx).await
        }
    })
}

/// `GET /api/rooms/:id?map_hash=` (6070–6083): отказ до сверки, сверка
/// проекции, права, присутствие, проекция зрителя и сжатие карты по хешу
/// клиента. Комната без `state` — 200 как есть, но только тому, кого пустил
/// `canAccessRoom` (без `sessionCode` — только администратору). Всё вне
/// `try` в JS: сбой (испорченный журнал — `CAMPAIGN_RECOVERY_REQUIRED`) —
/// 500 `INTERNAL_ERROR` последней границы, соседние кампании не задеты.
async fn read_room(ctx: &mut RouteCtx) -> ApiResult {
    let user = require_user(ctx).await?;
    let pre_span = sk_store::perf::span("rooms.pre_access");
    let code = ctx.param(0).to_string();
    let state = ctx.state.clone();
    // `accessDeniedBeforeReconcile` читает комнату, только если пользователь
    // не администратор и не участник по профилю; её сбой — «решит прежний путь».
    let prefetched = if is_admin(&user) || campaign_membership(&user, &code).is_some() { None } else { Some(get_room(&state, &code).await?) };
    let accounts = state.accounts.clone();
    let (checked_user, checked_code) = (user.clone(), code.clone());
    let denied = blocking(move || {
        let fallback = Room::empty(&checked_code);
        access_denied_before_reconcile(&accounts, Some(&checked_user), &checked_code, move |_| prefetched.unwrap_or(Ok(fallback)))
    })
    .await?;
    drop(pre_span);
    if denied {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой комнате"));
    }
    let reconciled = {
        let code = code.clone();
        state.core.call(move |core| Box::pin(async move { projection::reconcile_campaign_projection(&core, &code) })).await??
    };
    let access_span = sk_store::perf::span("rooms.access");
    let accounts = state.accounts.clone();
    // Комната — одна на оба потока (Ск4): права читают её по ссылке, без копии
    // состояния; после проверки она снова только у маршрута.
    let reconciled = std::sync::Arc::new(reconciled);
    let (checked_user, checked_code, checked_room) = (user.clone(), code.clone(), reconciled.clone());
    let (allowed, actor_id) = blocking(move || -> Result<(bool, String), Failure> {
        let fallback;
        let room = match checked_room.as_ref() {
            Some(room) => room,
            None => {
                fallback = Room::empty(&checked_code);
                &fallback
            }
        };
        if !can_access_room(&accounts, Some(&checked_user), room)? {
            return Ok((false, String::new()));
        }
        let actor = match room.state.as_ref() {
            Some(room_state) => owned_viewer_actor_id(&accounts, room_state, &checked_user, &checked_code)?,
            None => String::new(),
        };
        Ok((true, actor))
    })
    .await??;
    drop(access_span);
    if !allowed {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой комнате"));
    }
    // `persistAuthoritativeProjection` вернул `null`: в JS `room.state` у
    // `null` — `TypeError` мимо маршрута.
    let reconciled = std::sync::Arc::try_unwrap(reconciled).unwrap_or_else(|shared| (*shared).clone());
    let mut room = reconciled.ok_or_else(|| ApiError::internal("TypeError: Cannot read properties of null (reading 'state')"))?;
    let Some(room_state) = room.state.take() else { return Ok(json(StatusCode::OK, &room.to_json())) };
    // Поле недоверенное: лишь ключ поиска в кэше проекций. Неизвестный или
    // чужой хеш — «карты у клиента нет», карта уходит целиком.
    let client_map_hash = sk_core::text::head(&ctx.search_param("map_hash").unwrap_or_default(), 128);
    let body = state
        .core
        .call(move |core| {
            Box::pin(async move {
                let normalize_span = sk_store::perf::span("rooms.normalize");
                let normalized = sk_rules::normalize::normalize_campaign_state_owned(room_state)?;
                drop(normalize_span);
                let presence_span = sk_store::perf::span("rooms.presence");
                let present = crate::streams::normalized_state_with_live_presence(&core, &normalized, &code)?;
                drop(presence_span);
                let viewer_span = sk_store::perf::span("rooms.viewer_state_for");
                let projected = viewer_state_for(&present, &user, Some(&Value::String(actor_id)))?.unwrap_or(Value::Null);
                drop(viewer_span);
                let compact_span = sk_store::perf::span("rooms.compact");
                let (compacted, _hash) = sk_tactical::reveal_transport::compact_state_for_transport(&projected, &client_map_hash);
                drop(compact_span);
                let _body = sk_store::perf::span("rooms.body");
                Ok::<Value, Failure>(room_with_state(&room, compacted.unwrap_or(projected)))
            })
        })
        .await??;
    let _serialize = sk_store::perf::span("rooms.serialize");
    Ok(json(StatusCode::OK, &body))
}

/// `PUT /api/rooms/:id` (6084–6093): полная запись комнаты снята — 410
/// `ROOM_MUTATION_RETIRED` тому, кому комната доступна. Тело не читается.
async fn retired_room_write(ctx: &mut RouteCtx) -> ApiResult {
    let user = require_user(ctx).await?;
    let existing = get_room(&ctx.state, ctx.param(0)).await??;
    if existing.state.is_none() {
        return Err(ApiError::coded(StatusCode::NOT_FOUND, "Кампания не найдена", "CAMPAIGN_NOT_FOUND"));
    }
    if !access(&ctx.state, &user, existing).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
    }
    Err(ApiError::coded(StatusCode::GONE, "Полная запись room state удалена. Используйте типизированные campaign commands", "ROOM_MUTATION_RETIRED"))
}

// --- POST /api/rooms/:id/dice -----------------------------------------------

/// `POST /api/rooms/:id/dice` (6011–6068): общий свободный бросок владельца
/// героя. Кость — из закрытого набора [`PUBLIC_DIE_SIDES`], бросает сервер,
/// событие `PublicDieRolled` идёт производным путём с ключом
/// `public-die:<roll_id>`. Исключение внутри — 400 с одним текстом (без кода).
fn public_die(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        match public_die_body(ctx, user).await {
            Ok(response) => Ok(response),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => Err(ApiError::new(StatusCode::BAD_REQUEST, failure.message)),
        }
    })
}

async fn public_die_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let body = ctx.json_body().await?;
    let code = ctx.param(0).to_string();
    let state = ctx.state.clone();
    let player_id = string_or_empty(body.get("playerId"));
    let accounts = state.accounts.clone();
    let (checked_user, checked_player, checked_code) = (user.clone(), player_id.clone(), code.clone());
    let allowed = blocking(move || can_use_hero(&accounts, &checked_user, Some(&Value::String(checked_player)), &checked_code)).await??;
    if !allowed {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Бросок доступен только владельцу героя").into());
    }
    // Набор костей закрыт и серверный: клиент выбирает из него, но подставить
    // произвольную грань не может.
    let raw_sides = body.get("sides");
    let sides = if js::present(raw_sides) { js::number(raw_sides) } else { 20.0 };
    if !(sides.fract() == 0.0 && PUBLIC_DIE_SIDES.contains(&(sides as i64))) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Такой кости нет: доступны d4, d6, d8, d10, d12, d20 и d100").into());
    }
    let sides = sides as i64;

    let current = get_room(&state, &code).await??;
    let Some(current_state) = current.state.clone() else {
        return Err(ApiError::new(StatusCode::CONFLICT, "Комната ещё не готова — повторите бросок через секунду").into());
    };
    if !access(&state, &user, current).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой комнате").into());
    }
    state
        .core
        .call(move |core| Box::pin(async move { roll_public_die(&core, &code, &current_state, &user, &player_id, sides) }))
        .await?
}

/// Шаги кубика после проверки прав (6025–6067), в ядре.
fn roll_public_die(core: &std::rc::Rc<crate::core::GameCore>, code: &str, current: &Value, user: &Value, player_id: &str, sides: i64) -> Result<axum::response::Response, Caught> {
    sk_director::campaign_lifecycle::assert_campaign_playable(current).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
    let players = current.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let Some(player) = players.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(player_id)) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Герой не найден в этой комнате").into());
    };
    let mut dice = core.dice.clone();
    let rolled = dice.roll(&format!("1d{sides}"), "free_roll", Some(player_id), Visibility::Public).map_err(|error| Failure::new(error.to_string(), None))?;
    let name = [player.get("character"), player.get("name")].into_iter().find(|value| js::truthy(*value)).map_or_else(|| "Игрок".to_string(), js::s);
    let roll = json!({
        "id": rolled.roll_id,
        "kind": "free",
        "sides": sides,
        "value": rolled.dice.first().copied().map_or(Value::Null, Value::from),
        "playerId": player_id,
        "playerName": sk_core::text::head(&name, 80),
        "rolledAt": sk_core::clock::now_ms(),
    });
    // Единственный путь, у которого повтора не было вовсе: конфликт версии
    // терял внеигровой бросок. Политика общая — производный коммит.
    let key = format!("public-die:{}", rolled.roll_id);
    let event = json!({
        "event_type": "PublicDieRolled",
        "actor_id": player_id,
        "target_ids": [],
        "payload": { "roll": roll },
        "source_rule_ids": [],
        "ruling_id": null,
        "visibility": "public",
    });
    let journal = HookedJournal(&core.events);
    let executor = AuthoritativeExecutor::new(&journal);
    let committed = executor.commit_derived(DerivedRequest::events(code, &key, Producer::PublicDice, vec![event])).map_err(executor_failure)?;
    let Some(committed) = committed else { return Err(Failure::new("Cannot read properties of null (reading 'state')", Some("TYPE_ERROR")).into()) };
    let options = PersistOptions { force_projector_refresh: true, await_projection: false };
    let Some(projected) = projection::persist_authoritative_projection(core, code, &committed.commit.state, &committed.commit.events, None, options)? else {
        return Err(ApiError::new(StatusCode::CONFLICT, "Не удалось обновить публичную проекцию броска").into());
    };
    let projected_state = normalize(projected.state.as_ref().unwrap_or(&Value::Null))?;
    let viewer = viewer_state_for(&projected_state, user, Some(&Value::String(player_id.to_string())))?.unwrap_or(Value::Null);
    let mut response = Map::new();
    response.insert("roll".into(), roll);
    if let Value::Object(room) = room_with_state(&projected, viewer) {
        response.extend(room);
    }
    Ok(json(StatusCode::OK, &Value::Object(response)))
}

// --- POST /api/roll ---------------------------------------------------------

/// `POST /api/roll` (6094–6114): кость только под объявленную проверку
/// (`check_id` карточки первой фазы), подпись, модификатор и СЛ — из
/// карточки. Без `check_id` — 400 `CHECK_REQUIRED`. Исключение — 400 с
/// текстом и кодом.
fn issue_roll(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        match issue_roll_body(ctx, user).await {
            Ok(response) => Ok(response),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => Err(failure.respond(StatusCode::BAD_REQUEST)),
        }
    })
}

async fn issue_roll_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let body = ctx.json_body().await?;
    let state = ctx.state.clone();
    let campaign_id = js::s(nullish(body.get("campaignId"), body.get("campaign_id")));
    let player = body.get("playerId").cloned();
    let forbidden = || ApiError::new(StatusCode::FORBIDDEN, "Бросок доступен только владельцу героя");
    if campaign_id.is_empty() {
        return Err(forbidden().into());
    }
    let accounts = state.accounts.clone();
    let (checked_user, checked_player, checked_code) = (user.clone(), player.clone(), campaign_id.clone());
    if !blocking(move || can_use_hero(&accounts, &checked_user, checked_player.as_ref(), &checked_code)).await?? {
        return Err(forbidden().into());
    }
    let room = get_room(&state, &campaign_id).await??;
    let Some(room_state) = room.state.clone() else { return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании").into()) };
    if !access(&state, &user, room).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании").into());
    }
    let mut options = Map::new();
    if let Some(check) = nullish(body.get("checkId"), body.get("check_id")) {
        options.insert("checkId".into(), check.clone());
    }
    options.insert("campaignId".into(), Value::String(campaign_id));
    if let Some(player) = player {
        options.insert("actorId".into(), player);
    }
    let issued = state
        .core
        .call(move |core| {
            Box::pin(async move {
                sk_director::campaign_lifecycle::assert_campaign_playable(&room_state).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
                Ok::<Value, Failure>(core.rolls.borrow_mut().issue(&Value::Object(options))?)
            })
        })
        .await??;
    // `{ roll_id, value: kept, … }`: `undefined` в JSON не попадает.
    let mut reply = Map::new();
    for (field, source) in [("roll_id", "roll_id"), ("value", "kept"), ("modifier", "modifier"), ("total", "total"), ("difficulty", "difficulty"), ("label", "label"), ("success", "success"), ("ability", "ability")] {
        if let Some(value) = issued.get(source) {
            reply.insert(field.into(), value.clone());
        }
    }
    Ok(json(StatusCode::OK, &Value::Object(reply)))
}
