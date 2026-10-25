//! С18.5: `POST /api/narrate` — `server/index.mjs:6143–6476` (с помощниками
//! 2326–2359 `explicitNarrationNpcId` и 3595–3608 `finishFailedRollReservation`).
//!
//! Маршрут сравнивает **сырой** `req.url`: `/api/narrate?x` — 404.
//!
//! Устройство:
//!
//! - проверки до хода (тело, вид реплики, `LEGACY_PAYLOAD_RETIRED`,
//!   `UNVERIFIED_ROLL`, доступ, сверка проекции, герой, собеседник, чей ход,
//!   конец мира, лимит 40) — в HTTP-слое; аккаунты через [`blocking`],
//!   журнал и проекция — заданиями ядра;
//! - сам ход — **одно задание ядра**: резерв броска, решения Режиссёра,
//!   соло-выход, `gameOrchestrator.handle`, проекция голосования, летопись,
//!   финал живого рассказа и ответ зрителю. Ожидание модели — `await` внутри
//!   задания: ядро в это время исполняет другие задания (голоса, кубик,
//!   `typing`), замков через ожидание нет;
//! - живой рассказ — поток ядра [`crate::streams::narration`]: начало и
//!   снимки идут из колбэков оркестратора, канонический финал — после
//!   записи летописи, обрыв — на любом отказе после начала;
//! - приватный ответ (служебная команда `/…`, вопрос, Хранитель знаний,
//!   ответ одному игроку) в общий поток не идёт и пишется в летопись с
//!   `knowledge_gate` только для спрашивающего;
//! - `room_version` ответа перечитывается после хода (6431–6432): рассказ
//!   может пережить чужую запись комнаты.
//!
//! Отказы `catch` (6463–6474): `STATE_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
//! `PARTY_DECISION_ALREADY_CONSUMED` — 409; `ROLL_ALREADY_USED`,
//! `ROLL_FORBIDDEN` — 400; `LLM_*` — 502; прочее — 400.

use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sk_agents::free_action_adjudication::assert_free_action_confirmation;
use sk_agents::player_request_router::{propose_agent_interaction, propose_routed_travel, resolve_party_decision};
use sk_core::{js, text};
use sk_director::director_scene_transition::{director_transition_fingerprint, resolved_party_decision_reference};
use sk_orchestrator::game_orchestrator::{HandleInput, NarrationProgress, NarrationStart};
use sk_social::npc_social::{ensure_npc_social_state, npc_profile_at_world_time, npc_social_for_viewer};
use sk_story::intent_parser::{infer_request_kind, normalize_request_kind, REQUEST_KINDS};

use crate::access::{access_denied_before_reconcile, campaign_membership, can_access_room, can_use_hero, require_user};
use crate::core::{blocking, GameCore};
use crate::director_transition::{
    empty_effects, execute_director_scene_transition, execute_party_decision_tool, execute_solo_party_exit, orchestrator_failure, policy_error, replay_director_scene_transition, SoloExitInput, TransitionInput,
};
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::idempotency::narrate_key_or_uuid;
use crate::journal::{append_room_journal, narration_message_id, player_message_id};
use crate::projection::{persist_authoritative_projection, persist_interaction_projection, reconcile_campaign_projection, PersistOptions};
use crate::room::{get_room, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;
use crate::streams::NarrationHub;

pub fn routes() -> Vec<Route> {
    // `req.url === '/api/narrate' && req.method === 'POST'` (6143).
    vec![Route::post(6144, Matcher::raw("/api/narrate"), narrate)]
}

/// Коды 409 (6472).
const CONFLICTS: [&str; 3] = ["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "PARTY_DECISION_ALREADY_CONSUMED"];
const NO_ACCESS: &str = "Нет доступа к этой кампании";
/// `mode` всегда `enforce` (6197).
const MODE: &str = "enforce";

/// `catch` маршрута: статус по коду, `{ error: error.message, code }`.
fn thrown(failure: Failure) -> ApiError {
    let code = failure.code.as_deref().unwrap_or("");
    let status = if CONFLICTS.contains(&code) {
        StatusCode::CONFLICT
    } else if code == "ROLL_ALREADY_USED" || code == "ROLL_FORBIDDEN" {
        StatusCode::BAD_REQUEST
    } else if code.starts_with("LLM_") {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::BAD_REQUEST
    };
    failure.respond(status)
}

fn reply(caught: Caught) -> ApiError {
    match caught {
        Caught::Reply(error) => error,
        Caught::Thrown(failure) => thrown(failure),
    }
}

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

fn at<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| get(current, key))
}

/// `String(value || '')`.
fn or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        String::new()
    }
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|value| !value.is_null()).or(b)
}

/// `a === b` для значений JSON (объекты и массивы — разные ссылки).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `TypeError` JS при чтении поля у `null`.
fn null_read(field: &str) -> Failure {
    Failure::new(format!("Cannot read properties of null (reading '{field}')"), None)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `/^\s*\[РЕШЕНИЕ ГРУППЫ\]/iu` по NFKC (`isPartyDecisionAction`, 3025–3027).
fn is_party_decision_action(action: &str) -> bool {
    text::lower(text::trim_start(&text::nfkc(action))).starts_with("[решение группы]")
}

/// `array[index]` JS: индекс — целое число или его каноническая строка.
fn index_of<'a>(list: Option<&'a Value>, index: Option<&Value>) -> Option<&'a Value> {
    let key = match index {
        Some(Value::Number(number)) => js::js_number_string(number),
        Some(Value::String(text)) => text.clone(),
        Some(other) => js::s(Some(other)),
        None => "undefined".to_string(),
    };
    match list? {
        Value::Array(items) => key.parse::<usize>().ok().filter(|position| position.to_string() == key).and_then(|position| items.get(position)),
        Value::Object(map) => map.get(&key),
        _ => None,
    }
}

// --- explicitNarrationNpcId (2326–2359) ---------------------------------------

/// Собеседник, которого игрок выбрал явно: строка безопасных символов, виден
/// игроку, доступен, не в бою и в той же локации; пусто — не выбран.
fn explicit_narration_npc_id(state: &Value, user: &Value, player_id: &str, raw: Option<&Value>) -> Result<String, Failure> {
    let raw = match raw {
        None | Some(Value::Null) => return Ok(String::new()),
        Some(Value::String(text)) if text.is_empty() => return Ok(String::new()),
        Some(Value::String(text)) => text,
        Some(_) => return Err(policy_error("npc_id должен быть строковым идентификатором", "NPC_ID_INVALID")),
    };
    let npc_id = text::trim(raw).to_string();
    let safe = npc_id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'));
    if npc_id.is_empty() || npc_id.encode_utf16().count() > 120 || !safe {
        return Err(policy_error("npc_id должен содержать от 1 до 120 безопасных символов", "NPC_ID_INVALID"));
    }
    let social = ensure_npc_social_state(state.get("social").unwrap_or(&Value::Null), state, &json!({}));
    let viewer = json!({ "playerId": player_id, "isAdmin": user.get("role").and_then(Value::as_str) == Some("admin"), "isPartyMember": true, "state": state });
    let visible = npc_social_for_viewer(&social, &viewer);
    let listed = |social: &Value| social.get("npcs").and_then(Value::as_array).cloned().unwrap_or_default();
    if !listed(&visible).iter().any(|npc| js::string(npc.get("id")) == npc_id) {
        return Err(policy_error("Выбранный собеседник не виден этому игроку", "NPC_NOT_VISIBLE"));
    }
    let profile = listed(&social).into_iter().find(|npc| js::string(npc.get("id")) == npc_id).map(|persisted| npc_profile_at_world_time(&persisted, state));
    let Some(profile) = profile.filter(|profile| js::truthy(Some(profile)) && profile.get("available") != Some(&Value::Bool(false))) else {
        return Err(policy_error("Выбранный собеседник сейчас недоступен", "NPC_UNAVAILABLE"));
    };
    if js::truthy(at(Some(state), &["mechanics", "combat", "active"])) {
        return Err(policy_error("Развёрнутый разговор недоступен во время боя", "NPC_SOCIAL_BLOCKED_IN_COMBAT"));
    }
    let scene_location = text::lower(text::trim(&js::s(at(Some(state), &["scene", "location"]))));
    let npc_location = text::lower(text::trim(&js::s(profile.get("location"))));
    if !scene_location.is_empty() && !npc_location.is_empty() && scene_location != npc_location {
        return Err(policy_error("Выбранный собеседник находится в другой локации", "NPC_WRONG_LOCATION"));
    }
    Ok(npc_id)
}

// --- HTTP-слой ------------------------------------------------------------------

fn narrate(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        narrate_body(ctx, user).await.map_err(reply)
    })
}

/// Ход после проверок HTTP-слоя: всё, что JS делает после `exceedsRate`.
struct Turn {
    app: Arc<AppState>,
    user: Value,
    body: Value,
    action: String,
    request_kind: &'static str,
    conversation_only: bool,
    campaign_id: String,
    room: Room,
    state: Value,
    player_id: String,
    explicit_npc_id: String,
    idempotency_key: String,
}

async fn narrate_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let body = ctx.json_body().await?;
    let action = text::head(text::trim(&or_empty(body.get("action"))), 2_000);
    let raw_kind = body.get("request_kind").filter(|kind| !kind.is_null());
    if let Some(kind) = raw_kind {
        if !kind.as_str().is_some_and(|kind| REQUEST_KINDS.contains(&kind)) {
            return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Неизвестный тип реплики", "REQUEST_KIND_INVALID").into());
        }
    }
    let request_kind = match raw_kind {
        None => infer_request_kind(Some(&Value::String(action.clone()))),
        Some(kind) => normalize_request_kind(Some(kind)),
    };
    let conversation_only = request_kind != "action";
    let truthy = |key: &str| js::truthy(body.get(key));
    if conversation_only && (truthy("roll") || truthy("confirmed_proposal_id") || truthy("supersedes_check_id") || truthy("supersedes_proposal_id")) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Вопрос и обсуждение не могут подтверждать или изменять игровые действия", "NON_ACTION_EXECUTION_FORBIDDEN").into());
    }
    if ["state", "player", "engine_mode", "engineMode", "mode"].iter().any(|key| body.get(*key).is_some()) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Legacy payload удалён: состояние, игрок и режим определяются сервером", "LEGACY_PAYLOAD_RETIRED").into());
    }
    if truthy("roll") && !body.get("roll").and_then(Value::as_object).is_some_and(|roll| roll.keys().all(|key| key == "roll_id")) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Разрешена только ссылка на серверный roll_id", "UNVERIFIED_ROLL").into());
    }
    let campaign_id = if truthy("campaignId") { js::s(body.get("campaignId")) } else { or_empty(body.get("campaign_id")) };
    let state = ctx.state.clone();
    // `accessDeniedBeforeReconcile` читает комнату, только если пользователь
    // не администратор и не участник по профилю.
    let prefetched = if user.get("role").and_then(Value::as_str) == Some("admin") || campaign_membership(&user, &campaign_id).is_some() {
        None
    } else {
        let code = campaign_id.clone();
        Some(state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await?)
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
        state.core.call(move |core| Box::pin(async move { reconcile_campaign_projection(&core, &code) })).await??
    };
    let room = reconciled.ok_or_else(|| null_read("state"))?;
    let Some(trusted) = room.state.clone() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into());
    };
    let accounts = state.accounts.clone();
    let (checked_user, checked_room) = (user.clone(), room.clone());
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &checked_room)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NO_ACCESS).into());
    }
    if !conversation_only {
        sk_director::campaign_lifecycle::assert_campaign_playable(&trusted).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
    }
    let requested_player = js::s(body.get("actor_id"));
    let player_id = if requested_player.is_empty() { or_empty(trusted.get("activePlayerId")) } else { requested_player };
    let accounts = state.accounts.clone();
    let (checked_user, hero, code) = (user.clone(), Value::String(player_id.clone()), campaign_id.clone());
    if !blocking(move || can_use_hero(&accounts, &checked_user, Some(&hero), &code)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Этот герой не принадлежит вашему аккаунту").into());
    }
    let explicit_npc_id = if conversation_only { String::new() } else { explicit_narration_npc_id(&trusted, &user, &player_id, body.get("npc_id"))? };
    let combat = at(Some(&trusted), &["mechanics", "combat"]);
    let combat_actor_id = js::s(get(index_of(get(combat, "initiative"), Some(nullish(get(combat, "active_index"), None).unwrap_or(&json!(0)))), "actor_id"));
    if !conversation_only && js::truthy(get(combat, "active")) && !combat_actor_id.is_empty() && player_id != combat_actor_id {
        return Err(ApiError::coded(StatusCode::CONFLICT, format!("Сейчас ходит другой участник: {combat_actor_id}"), "NOT_ACTIVE_ACTOR").into());
    }
    let death = at(Some(&trusted), &["mechanics", "death"]);
    if !conversation_only && get(death, "campaign_status").and_then(Value::as_str) == Some("party_defeated") {
        return Err(ApiError::coded(StatusCode::CONFLICT, "Все герои погибли. Эта история завершена, продолжать игру в этом мире нельзя", "WORLD_ENDED").into());
    }
    if !conversation_only && at(death, &["heroes", &player_id, "status"]).and_then(Value::as_str) == Some("dead") {
        return Err(ApiError::coded(StatusCode::CONFLICT, "Сначала воскресите погибшего героя или замените его новым", "HERO_DEAD_UNRESOLVED").into());
    }
    if state.limits.exceeds_rate(&format!("narrate:{}", js::string(user.get("id"))), 40, None) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Слишком много ходов за короткое время").into());
    }
    let idempotency_key = narrate_key_or_uuid(&body, &ctx.headers);
    let turn = Turn { app: state.clone(), user, body, action, request_kind, conversation_only, campaign_id, room, state: trusted, player_id, explicit_npc_id, idempotency_key };
    let run_span = sk_store::perf::span("narrate.run_turn");
    let answered = state.core.call(move |core| Box::pin(async move { run_turn(core, turn).await })).await?;
    drop(run_span);
    Ok(json(StatusCode::OK, &answered?))
}

// --- ход в ядре -------------------------------------------------------------------

/// `narrationTransport` (6199–6205).
#[derive(Default)]
struct Transport {
    started: bool,
    finished: bool,
    last_progress: String,
}

/// Ход целиком с `catch`: на отказе — обрыв начатого рассказа и снятие
/// резерва броска (`finishFailedRollReservation`), затем статус по коду.
async fn run_turn(core: Rc<GameCore>, turn: Turn) -> Result<Value, ApiError> {
    let hub = crate::streams::narration(&core);
    let message_id = narration_message_id(&turn.idempotency_key);
    let transport = Arc::new(Mutex::new(Transport::default()));
    let mut reservation: Option<Value> = None;
    let outcome = turn_body(&core, &turn, &hub, &message_id, &transport, &mut reservation).await;
    let caught = match outcome {
        Ok(answer) => return Ok(answer),
        Err(caught) => caught,
    };
    let (started, finished) = {
        let transport = lock(&transport);
        (transport.started, transport.finished)
    };
    if started && !finished {
        // Ошибка SSE не подменяет исход авторитетного запроса.
        let _ = hub.abort(&turn.campaign_id, &message_id);
    }
    let code = match &caught {
        Caught::Thrown(failure) => failure.code.clone(),
        Caught::Reply(error) => error.body.get("code").and_then(Value::as_str).map(str::to_string),
    };
    finish_failed_roll_reservation(&core, reservation.as_ref(), &turn, code.as_deref());
    Err(reply(caught))
}

/// `finishFailedRollReservation(reservation, error)` (3595–3608): бросок снова
/// доступен, только если коммита по ключу нет; исход неизвестен — потреблён.
fn finish_failed_roll_reservation(core: &GameCore, reservation: Option<&Value>, turn: &Turn, code: Option<&str>) {
    let Some(roll_id) = reservation else { return };
    let committed = if code == Some("ROLL_CONTEXT_MISMATCH") { true } else { core.events.get_by_idempotency_key(&turn.campaign_id, &turn.idempotency_key).map_or(true, |found| found.is_some()) };
    let finished = core.rolls.borrow_mut().finish_reservation(roll_id, &json!({ "idempotencyKey": turn.idempotency_key, "committed": committed }));
    if let Err(error) = finished {
        eprintln!("[Сказание] Резерв броска не снят: {}", error.code().map(str::to_string).unwrap_or_else(|| error.to_string()));
    }
}

/// Итог ветки Режиссёра без коммита (`{ narration, effects, provider:
/// 'AgentDirector', model: 'deterministic-policy', … }`).
fn director_reply(narration: Value, effects: Value, state: &Value) -> Value {
    let mut result = Map::new();
    result.insert("narration".into(), narration);
    result.insert("effects".into(), effects);
    result.insert("provider".into(), json!("AgentDirector"));
    result.insert("model".into(), json!("deterministic-policy"));
    result.insert("engine_mode".into(), json!(MODE));
    // `state_version: trustedState.state_version` (`undefined` не печатается).
    if let Some(version) = state.get("state_version") {
        result.insert("state_version".into(), version.clone());
    }
    result.insert("turn_consumed".into(), Value::Bool(false));
    result.insert("action_kind".into(), json!("free"));
    result.insert("mechanics".into(), json!([]));
    Value::Object(result)
}

/// `effects.interaction.description` (чтение у `null` — `TypeError`).
fn interaction_description(effects: &Value) -> Result<Value, Failure> {
    match effects.get("interaction") {
        Some(interaction) if !interaction.is_null() => Ok(interaction.get("description").cloned().unwrap_or(Value::Null)),
        _ => Err(null_read("description")),
    }
}

async fn turn_body(core: &Rc<GameCore>, turn: &Turn, hub: &NarrationHub, message_id: &str, transport: &Arc<Mutex<Transport>>, reservation: &mut Option<Value>) -> Result<Value, Caught> {
    let Turn { app, user, body, action, request_kind, conversation_only, campaign_id, room, state, player_id, explicit_npc_id, idempotency_key } = turn;
    let (conversation_only, request_kind) = (*conversation_only, *request_kind);
    let start: NarrationStart = {
        let (hub, transport, campaign, id) = (hub.clone(), transport.clone(), campaign_id.clone(), message_id.to_string());
        Arc::new(move |_progress: &Value| {
            if hub.start(&campaign, &id).is_ok() {
                lock(&transport).started = true;
            }
        })
    };
    let progress: NarrationProgress = {
        let (hub, transport, campaign, id) = (hub.clone(), transport.clone(), campaign_id.clone(), message_id.to_string());
        Arc::new(move |text: &str, _progress: &Value| {
            if hub.progress(&campaign, &id, text).is_ok() {
                lock(&transport).last_progress = text.to_string();
            }
        })
    };

    // Аудит PR #131, SEC-04: резерв броска до исхода хода.
    let mut verified_roll = Value::Null;
    let roll_id = get(body.get("roll"), "roll_id").filter(|roll_id| js::truthy(Some(roll_id))).cloned();
    if let Some(roll_id) = roll_id {
        let previous = core.events.get_by_idempotency_key(campaign_id, idempotency_key).map_err(Failure::from)?;
        let before = nullish(previous.as_ref().and_then(|commit| commit.events.first()).and_then(|event| event.get("state_version_before")), state.get("state_version")).cloned();
        let raw_action = js::s(body.get("action"));
        let mut validate = |context: &Value| -> Result<(), sk_core::RuleError> {
            let kind = context.get("kind").and_then(Value::as_str);
            if kind == Some("free_action") {
                assert_free_action_confirmation(Some(context), &raw_action, before.as_ref()).map_err(|error| sk_core::RuleError::new(error.code.unwrap_or_default(), error.message))?;
            }
            if kind == Some("ability_action") && (!strict_eq(context.get("action"), Some(&Value::String(action.clone()))) || !strict_eq(context.get("state_version"), before.as_ref())) {
                return Err(sk_core::RuleError::new("ROLL_CONTEXT_MISMATCH", "Проверка относится к другой заявке или прежней обстановке. Согласуйте её заново."));
            }
            Ok(())
        };
        let options = json!({ "campaignId": campaign_id, "actorId": player_id, "idempotencyKey": idempotency_key });
        let consumed = core.rolls.borrow_mut().consume(&roll_id, &options, Some(&mut validate));
        verified_roll = consumed.map_err(Failure::from)?;
        *reservation = Some(roll_id);
    } else if js::truthy(body.get("roll")) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Enforce-режим принимает только серверный roll_id", "UNVERIFIED_ROLL").into());
    }
    let player = state.get("players").and_then(Value::as_array).and_then(|players| players.iter().find(|candidate| js::string(candidate.get("id")) == *player_id)).cloned();
    let actor_name = js::s(nullish(get(player.as_ref(), "character"), get(player.as_ref(), "name")));
    let campaign_value = Value::String(campaign_id.clone());
    let action_value = Value::String(action.clone());

    let mut director_resolution: Option<Value> = None;
    let mut director_replay: Option<(sk_store::CommitResult, Value)> = None;
    if !conversation_only && explicit_npc_id.is_empty() {
        let duplicate = core.events.get_by_idempotency_key(campaign_id, idempotency_key).map_err(Failure::from)?;
        let duplicate_scene = duplicate.as_ref().and_then(|commit| commit.events.iter().find(|event| event.get("event_type").and_then(Value::as_str) == Some("SceneAdvanced"))).cloned();
        let interaction = state.get("agentInteraction");
        if let Some(scene) = duplicate_scene {
            let fingerprint = director_transition_fingerprint(Some(&campaign_value), Some(&action_value)).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
            if get(scene.get("payload"), "request_fingerprint").and_then(Value::as_str) != Some(fingerprint.as_str()) {
                return Err(policy_error("Этот ключ идемпотентности уже использован для другого перехода сцены", "IDEMPOTENCY_CONFLICT").into());
            }
            let party_decision = resolved_party_decision_reference(get(scene.get("payload"), "party_decision"), true).map_err(|error| Failure::new(error.message, error.code.as_deref()))?.unwrap_or(Value::Null);
            let resolution = json!({ "type": "scene_request", "decision": action, "destinationHint": "", "partyDecision": party_decision });
            if let Some(duplicate) = duplicate {
                director_replay = Some((duplicate, resolution));
            }
        } else if get(interaction, "status").and_then(Value::as_str) == Some("resolved") && js::truthy(get(interaction, "resolvedOptionId")) {
            director_resolution = resolve_party_decision(Some(&action_value), state);
        } else if is_party_decision_action(action) {
            if duplicate.is_some() {
                return Err(policy_error("Этот ключ идемпотентности уже использован для другого игрового действия", "IDEMPOTENCY_CONFLICT").into());
            }
            let fingerprint = director_transition_fingerprint(Some(&campaign_value), Some(&action_value)).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
            if crate::director_transition::committed_scene_for_fingerprint(core, campaign_id, &fingerprint)?.is_some() {
                return Err(policy_error("Это решение группы уже было исполнено переходом сцены", "PARTY_DECISION_ALREADY_CONSUMED").into());
            }
            return Err(policy_error("Нет завершённого решения группы для перехода сцены", "PARTY_DECISION_REQUIRED").into());
        }
    }
    let director_interaction =
        if !conversation_only && explicit_npc_id.is_empty() && director_resolution.is_none() && director_replay.is_none() { propose_agent_interaction(action, state, "", &actor_name) } else { None };
    // Соло-стол не голосует. Бросок судьбы остаётся карточкой и в одиночку:
    // там решение принимает кубик, а не отряд.
    let solo_exit = match director_interaction.as_ref().filter(|proposal| proposal.get("type").and_then(Value::as_str) == Some("vote")) {
        Some(_) => {
            let accounts = app.accounts.clone();
            let (campaign, voters_state) = (campaign_id.clone(), state.clone());
            blocking(move || crate::access::campaign_voter_count(&accounts, &campaign, &voters_state)).await?? <= 1
        }
        None => false,
    };

    let settings = {
        let accounts = app.accounts.clone();
        let campaign = campaign_id.clone();
        let stored = blocking(move || accounts.get_campaign_ai_settings(&campaign)).await?.map_err(Failure::from)?;
        let mut settings = stored.to_json();
        if !app.config.allowed_ai_models.contains(&stored.model) {
            settings["model"] = Value::String(app.config.model.clone());
        }
        settings
    };
    let services = crate::orchestration::orchestration(core, app)?;
    let branch = async {
        if let Some((duplicate, resolution)) = director_replay {
            return replay_director_scene_transition(core, app, &services, campaign_id, state, user, action, idempotency_key, &duplicate, resolution).await;
        }
        match director_resolution {
            Some(resolution) if resolution.get("type").and_then(Value::as_str) == Some("scene_request") => {
                return execute_director_scene_transition(TransitionInput { core, app, services: &services, campaign_id, room_state: state.clone(), user, action, idempotency_key, resolution }).await;
            }
            Some(resolution) if resolution.get("type").and_then(Value::as_str) == Some("narration") => {
                return Ok(director_reply(resolution.get("narration").cloned().unwrap_or(Value::Null), empty_effects(), state));
            }
            _ => {}
        }
        if let Some(proposal) = director_interaction.as_ref() {
            // Соло-путь возвращает `None`, когда он неприменим, и тогда
            // карточка открывается обычным порядком.
            let solo = if solo_exit {
                execute_solo_party_exit(SoloExitInput { core, app, services: &services, campaign_id, room_state: state.clone(), user, action, idempotency_key, player_id, proposal }).await?
            } else {
                None
            };
            if let Some(result) = solo {
                return Ok(result);
            }
            let mut effects = empty_effects();
            execute_party_decision_tool(proposal, &mut effects, state);
            let narration = interaction_description(&effects)?;
            return Ok(director_reply(narration, effects, state));
        }
        let allowed = crate::director_transition::allowed_actor_ids(app, user, campaign_id).await?;
        let mut patch = Map::new();
        patch.insert("state".into(), state.clone());
        patch.insert("roomVersion".into(), Value::from(room.version));
        patch.insert("campaignId".into(), campaign_value.clone());
        patch.insert("playerId".into(), Value::String(player_id.clone()));
        if let Some(name) = nullish(nullish(get(player.as_ref(), "character"), get(player.as_ref(), "name")), body.get("player")) {
            patch.insert("playerName".into(), name.clone());
        }
        patch.insert("message".into(), action_value.clone());
        patch.insert("requestKind".into(), json!(request_kind));
        patch.insert("idempotencyKey".into(), Value::String(idempotency_key.clone()));
        patch.insert("npcId".into(), Value::String(explicit_npc_id.clone()));
        patch.insert("verifiedRoll".into(), verified_roll.clone());
        patch.insert("manualRoll".into(), Value::Bool(body.get("manual_roll") == Some(&Value::Bool(true))));
        patch.insert("confirmedProposalId".into(), body.get("confirmed_proposal_id").filter(|value| value.is_string()).cloned().unwrap_or(Value::Null));
        patch.insert("user".into(), user.clone());
        patch.insert("allowedActorIds".into(), allowed);
        let mut fields = js::spread(body, Value::Object(patch));
        // `/api/narrate` принимает только прозу: пакет команд, его отпечаток и
        // метка Режиссёра — только из серверных веток (CMD-02).
        for key in ["commands", "requestCommands", "commandCapability"] {
            js::delete(&mut fields, key);
        }
        let input = HandleInput { fields, director_capability: false, on_narration_start: Some(start.clone()), on_narration_progress: Some(progress.clone()) };
        let mut result = services.game.handle(input).await.map_err(orchestrator_failure)?;
        // Судья свободных действий понял заявку как переход: коммита не было;
        // открывается та же карточка решения отряда, что и у фразы ухода.
        if result.get("free_action_outcome").and_then(Value::as_str) == Some("route_travel") {
            let hint = services.autonomous.take_route_hint(campaign_id, idempotency_key);
            if let Some(routed) = propose_routed_travel(hint.as_ref(), state, action, &actor_name) {
                let mut effects = empty_effects();
                execute_party_decision_tool(&routed, &mut effects, state);
                if js::truthy(effects.get("interaction")) {
                    let narration = interaction_description(&effects)?;
                    result = js::spread(&result, json!({ "narration": narration, "effects": effects, "provider": "AgentDirector", "model": "adjudicator-route" }));
                }
            }
        }
        Ok(result)
    };
    let mut result = crate::ai_context::with_campaign_ai(Some(settings), branch).await?;

    // Ход исполнен: бросок остаётся потреблённым, как и прежде.
    if let Some(roll_id) = reservation.as_ref() {
        core.rolls.borrow_mut().finish_reservation(roll_id, &json!({ "idempotencyKey": idempotency_key, "committed": true })).map_err(Failure::from)?;
        *reservation = None;
    }
    if js::truthy(result.get("idempotent_replay")) {
        let current = get_room(core, campaign_id)?;
        let persisted = get(current.state.as_ref(), "messages").and_then(Value::as_array).and_then(|messages| messages.iter().find(|message| js::string(message.get("id")) == message_id)).cloned();
        if let Some(text) = get(persisted.as_ref(), "text").filter(|text| js::truthy(Some(text))) {
            // Повтор обязан вернуть тот же канонический текст, что лежит в летописи.
            result = js::spread(&result, json!({ "narration": js::s(Some(text)) }));
        }
    }
    if !conversation_only {
        let interaction = get(result.get("effects"), "interaction").cloned().unwrap_or(Value::Null);
        persist_interaction_projection(core.clone(), app.accounts.clone(), campaign_id, &interaction).await?;
    }
    // Служебные команды (`/why`) — не часть истории отряда.
    let meta_command = text::trim_start(action).starts_with('/');
    // Ответ из личной памяти получает только спрашивающий: общая рассылка и
    // журнал не расширяют аудиторию.
    let private_narration = meta_command || request_kind == "question" || result.get("provider").and_then(Value::as_str) == Some("AgentWorldkeeper") || result.get("narration_visibility").and_then(Value::as_str) == Some("specific_player");
    let journal_key = if private_narration { format!("{idempotency_key}:private:{player_id}") } else { idempotency_key.clone() };
    // Приглашение к броску не является событием истории.
    let check_required = js::truthy(result.get("check")) || js::truthy(result.get("action_proposal"));
    let journal_narration_id = (!check_required && !text::trim(&js::s(result.get("narration"))).is_empty()).then(|| narration_message_id(&journal_key));
    let narration_entry = journal_narration_id.as_ref().map(|id| {
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(id.clone()));
        if let Some(narration) = result.get("narration") {
            entry.insert("text".into(), narration.clone());
        }
        entry.insert("speaker".into(), json!(if meta_command { "system" } else { "narrator" }));
        let author = if meta_command {
            Some(json!("Разбор правил"))
        } else if request_kind == "question" {
            Some(json!("Ведущий · ответ"))
        } else {
            result.get("journal_author").cloned()
        };
        if let Some(author) = author {
            entry.insert("author".into(), author);
        }
        entry.insert("turnConsumed".into(), Value::Bool(result.get("turn_consumed") != Some(&Value::Bool(false)) && !meta_command));
        entry.insert("roll".into(), nullish(get(result.get("effects"), "roll"), None).cloned().unwrap_or(Value::Null));
        entry.insert("stakes".into(), nullish(result.get("stakes"), None).cloned().unwrap_or(Value::Null));
        if private_narration {
            entry.insert("knowledge_gate".into(), json!({ "visibility": "specific_player", "player_ids": [player_id], "fact_ids": [], "source_event_ids": [] }));
        }
        Value::Object(entry)
    });
    // Вторая фаза ручного броска приходит с тем же текстом действия: реплика
    // игрока уже записана первой фазой.
    let player_entry = (!meta_command && !js::truthy(get(body.get("roll"), "roll_id")) && !js::truthy(body.get("confirmed_proposal_id")) && !text::trim(action).is_empty()).then(|| {
        json!({
            "id": player_message_id(idempotency_key),
            "text": action,
            "speaker": "player",
            "author": nullish(nullish(get(player.as_ref(), "character"), get(player.as_ref(), "name")), None).cloned().unwrap_or_else(|| json!("Герой")),
        })
    });
    let authoritative = result.get("authoritative_state").filter(|state| js::truthy(Some(state))).cloned();
    let projected = match &authoritative {
        Some(engine_state) => {
            let events = result.get("mechanics").and_then(Value::as_array).cloned().unwrap_or_default();
            persist_authoritative_projection(core, campaign_id, engine_state, &events, None, PersistOptions::default())?
        }
        None => None,
    };
    // Летопись пишется отдельным шагом и всегда.
    let entries: Vec<Value> = [player_entry, narration_entry].into_iter().flatten().collect();
    let journaled = append_room_journal(core, campaign_id, &entries)?;
    let canonical_narration = match &journal_narration_id {
        Some(id) => {
            let written = get(journaled.as_ref().and_then(|room| room.state.as_ref()), "messages").and_then(Value::as_array).and_then(|messages| messages.iter().find(|message| js::string(message.get("id")) == *id)).and_then(|message| message.get("text")).filter(|text| !text.is_null());
            Some(Value::String(js::string(written.or(result.get("narration")))))
        }
        None => result.get("narration").cloned(),
    };
    let mut patch = Map::new();
    patch.insert("request_kind".into(), json!(request_kind));
    patch.insert("narration".into(), canonical_narration.clone().unwrap_or(Value::Null));
    if let Some(id) = &journal_narration_id {
        patch.insert("narration_message_id".into(), Value::String(id.clone()));
    }
    if let Some(engine_state) = &authoritative {
        let canonical = journaled.as_ref().and_then(|room| room.state.clone()).or_else(|| projected.as_ref().and_then(|room| room.state.clone())).unwrap_or_else(|| engine_state.clone());
        patch.insert("authoritative_state".into(), canonical);
    }
    // Рассказ может пережить чужую запись комнаты: версия при начале запроса
    // сдвинула бы курсор клиента назад.
    patch.insert("room_version".into(), Value::from(get_room(core, campaign_id)?.version));
    let mut response = js::spread(&result, Value::Object(patch));
    if canonical_narration.is_none() {
        // `narration: undefined` в JSON не попадает.
        js::delete(&mut response, "narration");
    }
    if let Some(id) = journal_narration_id.as_ref().filter(|_| !private_narration) {
        let final_text = js::s(response.get("narration"));
        let last_progress = lock(transport).last_progress.clone();
        let phase = if !last_progress.is_empty() && !final_text.starts_with(&last_progress) { "replaced" } else { "complete" };
        if let Err(error) = hub.complete(campaign_id, id, &final_text, Some(phase), js::truthy(result.get("idempotent_replay"))) {
            eprintln!("[Сказание] Не удалось завершить необязательный поток повествования: {}", error.code);
        }
        lock(transport).finished = true;
    } else if lock(transport).started {
        // Пустой SSE-финал не подменяет авторитетный HTTP-ответ.
        let _ = hub.abort(campaign_id, message_id);
        lock(transport).finished = true;
    }
    let viewer = sk_projection::viewer_projection::turn_result_for_viewer(Some(&response), Some(user), Some(&Value::String(player_id.clone()))).map_err(Failure::from)?;
    Ok(viewer.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_by_code_like_js() {
        let status = |code: Option<&str>| thrown(Failure::new("x", code)).status;
        assert_eq!(status(Some("STATE_VERSION_CONFLICT")), StatusCode::CONFLICT);
        assert_eq!(status(Some("PARTY_DECISION_ALREADY_CONSUMED")), StatusCode::CONFLICT);
        assert_eq!(status(Some("ROLL_FORBIDDEN")), StatusCode::BAD_REQUEST);
        assert_eq!(status(Some("LLM_TIMEOUT")), StatusCode::BAD_GATEWAY);
        assert_eq!(status(None), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn party_decision_marker_and_index() {
        assert!(is_party_decision_action("  [решение группы] Идти"));
        assert!(is_party_decision_action("[РЕШЕНИЕ ГРУППЫ]"));
        assert!(!is_party_decision_action("идём [РЕШЕНИЕ ГРУППЫ]"));
        let list = json!([{ "actor_id": "a" }, { "actor_id": "b" }]);
        assert_eq!(index_of(Some(&list), Some(&json!(1))).and_then(|entry| entry.get("actor_id")), Some(&json!("b")));
        assert_eq!(index_of(Some(&list), Some(&json!("0"))).and_then(|entry| entry.get("actor_id")), Some(&json!("a")));
        assert!(index_of(Some(&list), Some(&json!(1.5))).is_none());
        assert!(index_of(Some(&list), Some(&json!("01"))).is_none());
    }

    #[test]
    fn npc_id_shape_is_checked_before_social_state() {
        let state = json!({});
        let user = json!({ "role": "player" });
        assert_eq!(explicit_narration_npc_id(&state, &user, "h", None), Ok(String::new()));
        assert_eq!(explicit_narration_npc_id(&state, &user, "h", Some(&json!(""))), Ok(String::new()));
        assert_eq!(explicit_narration_npc_id(&state, &user, "h", Some(&json!(5))).map_err(|error| error.code), Err(Some("NPC_ID_INVALID".to_string())));
        assert_eq!(explicit_narration_npc_id(&state, &user, "h", Some(&json!("a b"))).map_err(|error| error.code), Err(Some("NPC_ID_INVALID".to_string())));
        assert_eq!(explicit_narration_npc_id(&state, &user, "h", Some(&json!("ghost"))).map_err(|error| error.code), Err(Some("NPC_NOT_VISIBLE".to_string())));
    }
}
