//! С18.2: торговля игрока `POST /api/campaigns/:id/merchants/:merchantId/commands`
//! (`server/index.mjs` 5473–5529).
//!
//! Одна торговая команда героя (`BuyItem`, `SellItem`, `AppraiseItem`,
//! `BargainWithMerchant`, `PurchaseMerchantService`): санитайзер игрока с id
//! торговца из пути (С16) → сверка повтора ключа → `GameOrchestrator::handle`
//! → сверка отпечатка итога (С14) → проекция в комнату с репликой торговца
//! (`merchantMessageId`) → витрина торговца после сделки → ответ зрителю
//! (`turnResultForViewer`).
//!
//! Как в JS: `requireUser` — вне `try` (401 границы); комната, доступ, лимит
//! 120, тело — внутри. Ранние ответы (404 без кода, 403 доступа, 429
//! `MERCHANT_RATE_LIMITED`, 400 без команды) идут мимо `catch`; исключения —
//! по таблице `catch` (409 конфликты ключа и версии, 403 отказы прав, 404
//! торговец/предмет/позиция, прочее — 400 с текстом ошибки). Сбой хранилища
//! у этого маршрута — тоже 400: отдельной ветки 500, как у `/commands`, нет.
//!
//! Разбор id торговца и 400 `INVALID_MERCHANT_ID` — общий страж таблицы
//! (`routes::mod`, 5449–5454); `POST …/merchants/:id` без хвоста `/commands`
//! идёт дальше по таблице.
//!
//! Отклонения (как у С14 и С18.1): членство кампании (для `canUseHero`
//! санитайзера) и герои пользователя (`campaignHeroIds`) узнаются в
//! [`blocking`] до задания ядра — то есть до сверки повтора ключа (в JS —
//! синхронно по месту). Членство известно для кода пути и `sessionCode`
//! комнаты; санитайзер спрашивает о `sessionCode` журнального состояния,
//! который с ними совпадает. Различие видно только при сбое хранилища
//! аккаунтов.

use std::rc::Rc;
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use sk_core::js;
use sk_orchestrator::autonomous_orchestrator::OrchestratorError;
use sk_orchestrator::game_orchestrator::HandleInput;

use crate::access::{campaign_hero_values, can_access_room, require_user, string_or_empty};
use crate::command_guard::{sanitize_merchant_command, Caller, GuardResult, Memberships};
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::idempotency::key_or_uuid;
use crate::journal::merchant_message_id;
use crate::merchant_guard::{assert_merchant_idempotency, assert_merchant_result_fingerprint};
use crate::orchestration::orchestration;
use crate::projection::{latest_campaign_state, persist_authoritative_projection, PersistOptions};
use crate::room::{get_room, Room};
use crate::routes::campaigns::Caught;
use crate::routes::{merchant_route_id, MERCHANT_PATH};
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    // Общая регулярка торговца (5450) и `POST` с хвостом `/commands` (5473).
    vec![Route::pass(5506, Methods::One(Method::POST), Matcher::path_template(MERCHANT_PATH), merchant_trade)]
}

/// Коды 409 (5524).
const CONFLICT_CODES: &[&str] = &["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"];
/// Коды 403 (5526).
const FORBIDDEN_CODES: &[&str] = &["ACTOR_FORBIDDEN", "PLAYER_COMMAND_FORBIDDEN"];
/// Коды 404 (5527).
const NOT_FOUND_CODES: &[&str] = &["MERCHANT_NOT_FOUND", "ITEM_NOT_FOUND", "STOCK_NOT_FOUND"];

/// Ответы `campaignHasMemberships`, узнанные в [`blocking`] до задания ядра.
struct KnownMemberships(Vec<(String, bool)>);

impl Memberships for KnownMemberships {
    fn campaign_has_memberships(&self, campaign_id: &str) -> GuardResult<bool> {
        let wanted = campaign_id.to_uppercase();
        Ok(self.0.iter().find(|(code, _)| *code == wanted).is_some_and(|(_, known)| *known))
    }
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

fn merchant_trade(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        // `parsedUrl.pathname.endsWith('/commands')`: иначе — дальше по таблице.
        if !ctx.pathname.ends_with("/commands") {
            return Ok(None);
        }
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_string();
        match trade_try(ctx, user, campaign_id).await {
            Ok(body) => Ok(Some(json(StatusCode::OK, &body))),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => {
                let groups: [(&[&str], StatusCode); 3] = [(CONFLICT_CODES, StatusCode::CONFLICT), (FORBIDDEN_CODES, StatusCode::FORBIDDEN), (NOT_FOUND_CODES, StatusCode::NOT_FOUND)];
                Err(failure.respond_by(&groups, StatusCode::BAD_REQUEST))
            }
        }
    })
}

/// Что узнано на стороне HTTP до задания ядра.
struct Trade {
    campaign_id: String,
    merchant_id: String,
    user: Value,
    body: Value,
    room: Room,
    idempotency_key: String,
    memberships: KnownMemberships,
    hero_ids: Vec<Value>,
}

/// Тело `try` до задания ядра (5475–5485).
async fn trade_try(ctx: &mut RouteCtx, user: Value, campaign_id: String) -> Result<Value, Caught> {
    let state = ctx.state.clone();
    let code = campaign_id.clone();
    let room = state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
    if !js::truthy(room.state.as_ref()) {
        return Err(Caught::Reply(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена")));
    }
    let accounts = state.accounts.clone();
    let (checked_user, checked_room) = (user.clone(), room.clone());
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &checked_room)).await?? {
        return Err(Caught::Reply(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании")));
    }
    if state.limits.exceeds_rate(&format!("merchant-command:{}", js::string(user.get("id"))), 120, None) {
        return Err(Caught::Reply(ApiError::coded(StatusCode::TOO_MANY_REQUESTS, "Слишком много торговых операций. Подождите немного и повторите попытку", "MERCHANT_RATE_LIMITED")));
    }
    let body = ctx.json_body().await?;
    if !body.get("command").is_some_and(Value::is_object) {
        return Err(Caught::Reply(ApiError::new(StatusCode::BAD_REQUEST, "Нужна одна торговая command")));
    }
    let idempotency_key = key_or_uuid(&body, &ctx.headers);
    let merchant_id = merchant_route_id(ctx.param(1)).unwrap_or_default();
    let session_code = string_or_empty(room.state.as_ref().and_then(|room_state| room_state.get("sessionCode")));
    let accounts = state.accounts.clone();
    let (checked_user, code) = (user.clone(), campaign_id.clone());
    let (memberships, hero_ids) = blocking(move || -> Result<(KnownMemberships, Vec<Value>), Failure> {
        let mut known: Vec<(String, bool)> = Vec::new();
        for candidate in [code.clone(), session_code] {
            let upper = candidate.to_uppercase();
            if sk_core::text::trim(&candidate).is_empty() || known.iter().any(|(seen, _)| *seen == upper) {
                continue;
            }
            known.push((upper, accounts.campaign_has_memberships(&candidate)?));
        }
        let hero_ids = campaign_hero_values(&accounts, &checked_user, &code)?;
        Ok((KnownMemberships(known), hero_ids))
    })
    .await??;
    let trade = Trade { campaign_id, merchant_id, user, body, room, idempotency_key, memberships, hero_ids };
    let app = state.clone();
    Ok(state.core.call(move |core| Box::pin(async move { run(core, app, trade).await })).await??)
}

/// Задание ядра (5486–5521).
async fn run(core: Rc<GameCore>, app: Arc<AppState>, trade: Trade) -> Result<Value, Failure> {
    let campaign_id = trade.campaign_id.as_str();
    let idempotency_key = trade.idempotency_key.as_str();
    let route_merchant = Value::String(trade.merchant_id.clone());
    let before = latest_campaign_state(&core, campaign_id, trade.room.state.as_ref())?;
    let caller = Caller::new(&trade.user, &trade.memberships);
    let raw_command = trade.body.get("command").cloned().unwrap_or(Value::Null);
    let command = sanitize_merchant_command(&caller, &before, &raw_command, Some(&route_merchant))?;
    assert_merchant_idempotency(core.events.as_ref(), campaign_id, idempotency_key, &command)?;
    let actor = command.get("actor_id").cloned().unwrap_or(Value::Null);
    // `String(body.message || 'Торговая операция')`.
    let message = match trade.body.get("message") {
        text if js::truthy(text) => js::s(text),
        _ => "Торговая операция".to_string(),
    };
    let input = json!({
        "state": trade.room.state.clone().unwrap_or(Value::Null),
        "campaignId": campaign_id,
        "playerId": actor,
        "message": message,
        "commands": [command.clone()],
        // Аудит PR #131, CMD-02: сделка объявляет свой пакет команд так же,
        // как `/commands`.
        "requestCommands": [command.clone()],
        "idempotencyKey": idempotency_key,
        "user": trade.user,
        "allowedActorIds": trade.hero_ids,
    });
    let set = orchestration(&core, &app)?;
    let mut result = set.game.handle(HandleInput::new(input)).await.map_err(orchestrator_failure)?;
    assert_merchant_result_fingerprint(&result, &command)?;
    let narration = result.get("narration").filter(|text| js::truthy(Some(text))).cloned();
    let narration_message_id = narration.as_ref().map(|_| merchant_message_id(idempotency_key));
    let narration_message = match (&narration_message_id, &narration) {
        (Some(id), Some(text)) => Some(json!({ "id": id, "text": text, "turnConsumed": false })),
        _ => None,
    };
    let projected = match result.get("authoritative_state").filter(|state| js::truthy(Some(state))).cloned() {
        Some(engine_state) => {
            let mechanics = result.get("mechanics").and_then(Value::as_array).cloned().unwrap_or_default();
            persist_authoritative_projection(&core, campaign_id, &engine_state, &mechanics, narration_message.as_ref(), PersistOptions::default())?
        }
        None => None,
    };
    // `projected?.state ?? result.authoritative_state`: без обоих — поля нет.
    let response_state = match projected.as_ref().and_then(|room| room.state.clone()).filter(|state| !state.is_null()) {
        Some(state) => Some(state),
        None => result.get("authoritative_state").cloned(),
    };
    let view = match &response_state {
        Some(state) if js::truthy(Some(state)) => sk_economy::merchant_economy::merchant_view_for(state, Some(&route_merchant), Some(&actor)),
        _ => None,
    };
    if let Some(map) = result.as_object_mut() {
        if let Some(id) = narration_message_id {
            map.insert("narration_message_id".into(), Value::String(id));
        }
        // Внутреннее состояние целиком: единственная публичная проекция —
        // `turnResultForViewer` ниже.
        match response_state {
            Some(state) => {
                map.insert("authoritative_state".into(), state);
            }
            None => {
                map.remove("authoritative_state");
            }
        }
        map.insert("merchant_view".into(), view.unwrap_or(Value::Null));
        map.insert("room_version".into(), Value::from(projected.as_ref().map_or(trade.room.version, |room| room.version)));
    }
    let reply = sk_projection::viewer_projection::turn_result_for_viewer(Some(&result), Some(&trade.user), Some(&actor)).map_err(Failure::from)?;
    Ok(reply.unwrap_or(Value::Null))
}
