//! С18.4: автономия кампании — `server/index.mjs`:
//!
//! - `POST /api/campaigns/:id/autonomy/intents` (5039–5066) — намерение
//!   Режиссёра от администратора: `autonomousCampaign.runIntent`, по
//!   `run_combat: true` — автобой (`runCombat`, ключи `${key}:combat:…`) и
//!   завершение встречи (`${key}:completion`), проекция;
//! - `POST /api/campaigns/:id/autonomy/advance` (5069–5197) — шаг Режиссёра от
//!   игрока: продолжение решения отряда по `interaction_id`
//!   (`directorResumeKeyForInteraction`, 2575–2599), повтор ключа
//!   (`${key}:intent`, `${key}:custom`), готовность героев
//!   (`assertDirectorAdvanceReady`, 2563–2573), завершение встречи стадией
//!   `encounter-completion` координатора последствий, выбор Режиссёра,
//!   `runIntent`, строка Режиссёра и сцена после схватки в летописи;
//! - `warnOnDeadlyEncounter` (3094–3105) — строка «Оценка угрозы» после
//!   смертельной встречи.
//!
//! Стадия `encounter-completion` координатора последствий
//! ([`crate::clocks::run_post_commit`]) исполняется здесь же —
//! [`complete_encounter_stage`] (`completeEncounter`, 377–387).
//!
//! Устройство как у остальных маршрутов С18: тело, комната, доступ и герой —
//! в HTTP-слое (аккаунты через [`blocking`]); всё остальное — одно задание
//! ядра. Ожидание модели (Режиссёр, сцена после схватки) — `await` внутри
//! задания без займов `RefCell`. Аккаунты внутри задания — тоже через
//! [`blocking`]: герои зрителя (`campaignHeroIds`) читаются один раз до шагов,
//! назначенные герои (`assignedCampaignHeroIds`) — в том месте, где их читает
//! JS.
//!
//! Отклонение: `body.player_action` не строкой (число, объект) Режиссёр
//! получает приведённым `String(x ?? '')`; в JS `choose` видит само значение
//! (`affirmativePlayerAction` и бриф приводят его так же).

use std::rc::Rc;
use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Map, Value};
use sk_agents::director_agent::{DirectorAgent, RoleClient};
use sk_core::{js, text};
use sk_encounters::encounter_assembler::DEADLY_ENCOUNTER_WARNING;

use crate::access::{assigned_campaign_hero_ids, campaign_hero_values, can_access_room, can_use_hero, require_admin, require_user, viewer_state_for};
use crate::clocks::{run_post_commit, PostCommitRequest};
use crate::core::{blocking, GameCore};
use crate::director_transition::{orchestrator_failure, policy_error};
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::{has_header, header_text, json};
use crate::journal::{append_room_journal, recent_narrator_texts};
use crate::orchestration::orchestration;
use crate::projection::{persist_authoritative_projection, PersistOptions};
use crate::room::get_room;
use crate::routes::campaigns::Caught;
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    vec![
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/autonomy\/intents$/` и `POST` (5039–5040).
        Route::post(5040, Matcher::path_template("/api/campaigns/{id}/autonomy/intents"), intents),
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/autonomy\/advance$/` и `POST` (5069–5070).
        Route::post(5070, Matcher::path_template("/api/campaigns/{id}/autonomy/advance"), advance),
    ]
}

/// Имя класса клиента модели JS для Режиссёра (`new DirectorAgent({ llmClient })`,
/// 403): тот же горячий `FallbackLLMClient`, что у ролей `orchestration.rs`.
const HOT_CLIENT_CLASS: &str = "FallbackLLMClient";
const NOT_FOUND: &str = "Кампания не найдена";
const NO_ACCESS: &str = "Нет доступа к этой кампании";
/// Коды 400 обоих маршрутов (5065, 5193).
const BAD_REQUEST_CODES: [&str; 2] = ["DIRECTOR_INTENT_NOT_ALLOWED", "DIRECTOR_MECHANICS_FORBIDDEN"];
const IDEMPOTENCY_HEADER: &str = "x-idempotency-key";

// --- общее ----------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn at<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| get(current, key))
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn is_type(event: &Value, event_type: &str) -> bool {
    get(Some(event), "event_type").and_then(Value::as_str) == Some(event_type)
}

/// `a ?? b`.
fn nullish(a: Option<Value>, b: Option<Value>) -> Option<Value> {
    a.filter(|value| !value.is_null()).or(b.filter(|value| !value.is_null()))
}

/// `req.headers['x-idempotency-key']` (`undefined` — `None`).
fn header_key(headers: &HeaderMap) -> Option<Value> {
    has_header(headers, IDEMPOTENCY_HEADER).then(|| Value::String(header_text(headers, IDEMPOTENCY_HEADER)))
}

fn sha_tail(key: &str) -> String {
    sk_core::hash::sha256_hex(key.as_bytes())[..20].to_string()
}

/// `TypeError` JS при чтении поля у `null`.
fn null_read(field: &str) -> Failure {
    Failure::new(format!("Cannot read properties of null (reading '{field}')"), None)
}

/// `for (const stage of result.results ?? []) events.push(...(stage.events ?? []))`.
fn stage_events(result: &Value, events: &mut Vec<Value>) -> Result<(), Failure> {
    for stage in array(result.get("results")) {
        if stage.is_null() {
            return Err(null_read("events"));
        }
        events.extend(array(stage.get("events")).iter().cloned());
    }
    Ok(())
}

/// `catch` маршрута: `ACTOR_FORBIDDEN` — 403 (только у `advance`), коды
/// Режиссёра — 400, прочее — 409; `{ error: error.message, code }`.
fn thrown(failure: Failure, actor_forbidden: bool) -> ApiError {
    let code = failure.code.as_deref().unwrap_or("");
    let status = if actor_forbidden && code == "ACTOR_FORBIDDEN" {
        StatusCode::FORBIDDEN
    } else if BAD_REQUEST_CODES.contains(&code) {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::CONFLICT
    };
    failure.respond(status)
}

fn reply(caught: Caught, actor_forbidden: bool) -> ApiError {
    match caught {
        Caught::Reply(error) => error,
        Caught::Thrown(failure) => thrown(failure, actor_forbidden),
    }
}

/// Тело, комната, 404 и доступ — первые шаги `try` обоих маршрутов.
async fn admit(ctx: &mut RouteCtx, user: &Value) -> Result<(Value, String, Value), Caught> {
    let body = ctx.json_body().await?;
    let campaign_id = ctx.param(0).to_string();
    let state = ctx.state.clone();
    let code = campaign_id.clone();
    let room = state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
    let Some(room_state) = room.state.clone() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, NOT_FOUND).into());
    };
    let accounts = state.accounts.clone();
    let checked_user = user.clone();
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &room)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NO_ACCESS).into());
    }
    Ok((body, campaign_id, room_state))
}

fn playable(state: &Value) -> Result<(), Failure> {
    sk_director::campaign_lifecycle::assert_campaign_playable(state).map(|_| ()).map_err(|error| Failure::new(error.message, error.code.as_deref()))
}

/// `warnOnDeadlyEncounter(campaignId, events)` (3094–3105): строка «Оценка
/// угрозы» после созданной смертельной встречи; id — по событию встречи.
pub fn warn_on_deadly_encounter(core: &Rc<GameCore>, campaign_id: &str, events: &[Value]) -> Result<(), Failure> {
    let created = events.iter().find(|event| is_type(event, "EncounterCreated") && js::s(at(Some(event), &["payload", "encounter", "difficulty"])) == "deadly");
    let Some(created) = created else { return Ok(()) };
    let anchor = nullish(get(Some(created), "event_id").cloned(), get(Some(created), "state_version_after").cloned());
    let entry = json!({
        "id": format!("deadly-warning-{campaign_id}-{}", js::s(anchor.as_ref())),
        "speaker": "system",
        "author": "Оценка угрозы",
        "text": DEADLY_ENCOUNTER_WARNING,
    });
    append_room_journal(core, campaign_id, &[entry]).map(|_| ())
}

// --- POST autonomy/intents (5039–5066) -----------------------------------------

fn intents(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_admin(ctx).await?;
        intents_body(ctx, user).await.map_err(|caught| reply(caught, false))
    })
}

async fn intents_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let (body, campaign_id, room_state) = admit(ctx, &user).await?;
    playable(&room_state)?;
    // `String(body.idempotency_key ?? body.idempotencyKey ?? req.headers[…] ?? randomUUID())`.
    let key = match nullish(nullish(body.get("idempotency_key").cloned(), body.get("idempotencyKey").cloned()), header_key(&ctx.headers)) {
        Some(value) => js::string(Some(&value)),
        None => sk_core::hash::uuid_v4(),
    };
    let app = ctx.state.clone();
    let answer = ctx.state.core.call(move |core| Box::pin(async move { run_intents(core, app, user, body, campaign_id, key).await })).await??;
    Ok(json(StatusCode::OK, &answer))
}

async fn run_intents(core: Rc<GameCore>, app: Arc<AppState>, user: Value, body: Value, campaign_id: String, key: String) -> Result<Value, Caught> {
    let set = orchestration(&core, &app)?;
    let key_value = Value::String(key.clone());
    let result = set.autonomous.run_intent(&campaign_id, body.get("intent"), Some(&key_value), None).await.map_err(orchestrator_failure)?;
    let mut events = Vec::new();
    stage_events(&result, &mut events)?;
    // Предупреждение уходит до того, как отряд получит ход в этом бою.
    warn_on_deadly_encounter(&core, &campaign_id, &events)?;
    if body.get("run_combat") == Some(&Value::Bool(true)) && js::truthy(at(result.get("state"), &["mechanics", "combat", "active"])) {
        let combat = set.autonomous.run_combat(&campaign_id, &format!("{key}:combat"), 200).map_err(orchestrator_failure)?;
        // Исход берётся из закрытой встречи: бой с главным противником
        // сценария может кончиться бегством или договором, а не победой.
        if !js::truthy(at(combat.get("state"), &["mechanics", "combat", "active"])) {
            let outcome = at(combat.get("state"), &["mechanics", "encounter", "outcome"]).filter(|outcome| js::truthy(Some(outcome))).cloned().unwrap_or_else(|| Value::from("enemies_defeated"));
            // `idempotencyKey: `${key}:completion`` JS завершение не читает:
            // ключи шагов — от id встречи.
            set.autonomous.complete_encounter(&campaign_id, Some(&outcome)).await.map_err(orchestrator_failure)?;
        }
    }
    let authoritative = set.autonomous.load(&campaign_id).map_err(orchestrator_failure)?;
    persist_authoritative_projection(&core, &campaign_id, &authoritative.state, &events, None, PersistOptions::default())?;
    let viewer = viewer_state_for(&authoritative.state, &user, authoritative.state.get("activePlayerId"))?.unwrap_or(Value::Null);
    let mut answer = Map::new();
    if let Some(intent) = result.get("intent") {
        answer.insert("intent".into(), intent.clone());
    }
    answer.insert("state_version".into(), json!(authoritative.state_version));
    answer.insert("admin_commands".into(), json!(0));
    answer.insert("state".into(), viewer);
    Ok(Value::Object(answer))
}

// --- directorResumeKeyForInteraction (2575–2599) --------------------------------

/// `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u`.
fn valid_interaction_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_alphanumeric() && id.chars().count() <= 120 && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

/// Ключ исходного хода Режиссёра, открывшего решение отряда `interaction_id`:
/// решение открыто коммитом `${key}:custom`, намерение `end_scene` записано
/// раньше коммитом `${key}:intent`.
fn director_resume_key(core: &GameCore, campaign_id: &str, interaction_id: &str) -> Result<String, Failure> {
    let id = text::trim(interaction_id).to_string();
    if !valid_interaction_id(&id) {
        return Err(policy_error("Некорректный идентификатор решения отряда", "PARTY_DECISION_INVALID"));
    }
    let events = core.events.get_events(campaign_id, 0, None)?;
    let opened = events.iter().rev().find(|event| is_type(event, "PartyDecisionOpened") && js::s(at(Some(event), &["payload", "interaction", "id"])) == id);
    let custom_key = js::s(opened.and_then(|event| event.get("idempotency_key")));
    const SUFFIX: &str = ":custom";
    let Some(opened) = opened.filter(|_| custom_key.ends_with(SUFFIX)) else {
        return Err(policy_error("Это решение не связано с ожидающим ходом Режиссёра", "DIRECTOR_RESUME_NOT_FOUND"));
    };
    let intent_key = custom_key[..custom_key.len() - SUFFIX.len()].to_string();
    if intent_key.is_empty() {
        return Err(policy_error("Не найден исходный ход Режиссёра", "DIRECTOR_RESUME_NOT_FOUND"));
    }
    let intent_commit = core.events.get_by_idempotency_key(campaign_id, &format!("{intent_key}:intent"))?;
    let intent_event = intent_commit.as_ref().and_then(|commit| commit.events.iter().find(|event| is_type(event, "DirectorIntentRecorded")));
    let confirms = intent_event.is_some_and(|event| {
        at(Some(event), &["payload", "intent", "type"]).and_then(Value::as_str) == Some("end_scene") && !(js::number(event.get("state_version_after")) >= js::number(opened.get("state_version_after")))
    });
    if !confirms {
        return Err(policy_error("Решение не подтверждает ожидаемый переход Режиссёра", "DIRECTOR_RESUME_NOT_FOUND"));
    }
    Ok(intent_key)
}

// --- POST autonomy/advance (5069–5197) -----------------------------------------

fn advance(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        advance_body(ctx, user).await.map_err(|caught| reply(caught, true))
    })
}

/// Шаг после проверок HTTP-слоя.
struct Advance {
    app: Arc<AppState>,
    user: Value,
    body: Value,
    campaign_id: String,
    /// `req.headers['x-idempotency-key']`.
    header_key: Option<Value>,
    /// `campaignHeroIds(user, campaignId)`.
    hero_ids: Vec<Value>,
}

async fn advance_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let (body, campaign_id, _) = admit(ctx, &user).await?;
    let actor_id = text::trim(&js::s(body.get("actor_id"))).to_string();
    let accounts = ctx.state.accounts.clone();
    let (checked_user, code) = (user.clone(), campaign_id.clone());
    let actor = (!actor_id.is_empty()).then(|| Value::String(actor_id));
    let (allowed, hero_ids) = blocking(move || -> Result<(bool, Vec<Value>), Failure> {
        let allowed = match &actor {
            Some(actor) => can_use_hero(&accounts, &checked_user, Some(actor), &code)?,
            None => true,
        };
        Ok((allowed, campaign_hero_values(&accounts, &checked_user, &code)?))
    })
    .await??;
    if !allowed {
        return Err(ApiError::coded(StatusCode::FORBIDDEN, "Этот герой не принадлежит вашему аккаунту", "ACTOR_FORBIDDEN").into());
    }
    let step = Advance { app: ctx.state.clone(), user, body, campaign_id, header_key: header_key(&ctx.headers), hero_ids };
    let answer = ctx.state.core.call(move |core| Box::pin(async move { run_advance(core, step).await })).await??;
    Ok(json(StatusCode::OK, &answer))
}

/// `ownedViewerActorId(state, user, campaignId)` по заранее прочитанным героям.
fn owned_viewer(hero_ids: &[Value], state: &Value) -> String {
    let players = array(state.get("players"));
    hero_ids.iter().map(|id| js::string(Some(id))).find(|id| players.iter().any(|player| js::string(player.get("id")) == *id)).unwrap_or_default()
}

fn viewer(state: &Value, user: &Value, hero_ids: &[Value]) -> Result<Value, Failure> {
    Ok(viewer_state_for(state, user, Some(&Value::String(owned_viewer(hero_ids, state))))?.unwrap_or(Value::Null))
}

/// `assertDirectorAdvanceReady(campaignId, state)` (2563–2573).
async fn assert_director_advance_ready(app: &Arc<AppState>, campaign_id: &str, state: &Value) -> Result<(), Caught> {
    let accounts = app.accounts.clone();
    let (code, checked) = (campaign_id.to_string(), state.clone());
    let assigned = blocking(move || assigned_campaign_hero_ids(&accounts, &code, &checked)).await??;
    if assigned.is_empty() {
        return Ok(());
    }
    let unfinished = array(state.get("players")).iter().any(|player| {
        assigned.contains(&js::string(player.get("id"))) && (player.get("characterSetupRequired") == Some(&Value::Bool(true)) || player.get("characterSetupStage").and_then(Value::as_str) == Some("leveling"))
    });
    if unfinished {
        return Err(Failure::new("Сначала завершите подготовку всех назначенных героев", Some("CHARACTER_SETUP_REQUIRED")).into());
    }
    Ok(())
}

fn director_agent(app: &AppState) -> DirectorAgent {
    DirectorAgent::new(app.agent_llm().map(|client| RoleClient::new(client.client(), HOT_CLIENT_CLASS)))
}

async fn run_advance(core: Rc<GameCore>, step: Advance) -> Result<Value, Caught> {
    let Advance { app, user, body, campaign_id, header_key, hero_ids } = step;
    let requested_interaction = text::trim(&js::s(body.get("interaction_id"))).to_string();
    let resume = if requested_interaction.is_empty() { None } else { Some(director_resume_key(&core, &campaign_id, &requested_interaction)?) };
    // `String(resume?.key ?? body.idempotency_key ?? req.headers[…] ?? '').slice(0, 120)`.
    let raw_key = match resume {
        Some(key) => key,
        None => js::s(nullish(body.get("idempotency_key").cloned(), header_key).as_ref()),
    };
    let key = text::slice(&raw_key, 0, Some(120));
    if key.is_empty() {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Нужен idempotency_key", "IDEMPOTENCY_KEY_REQUIRED").into());
    }
    let set = orchestration(&core, &app)?;
    let duplicate = core.events.get_by_idempotency_key(&campaign_id, &format!("{key}:intent")).map_err(Failure::from)?;
    let mut replayed_intent: Option<Value> = None;
    if let Some(duplicate) = duplicate {
        let current = set.autonomous.load(&campaign_id).map_err(orchestrator_failure)?;
        let decision_commit = core.events.get_by_idempotency_key(&campaign_id, &format!("{key}:custom")).map_err(Failure::from)?;
        let opened = decision_commit.as_ref().and_then(|commit| commit.events.iter().find(|event| is_type(event, "PartyDecisionOpened"))).and_then(|event| at(Some(event), &["payload", "interaction"]));
        // Намерение и голосование записаны отдельными коммитами. Тот же ключ
        // после кворума продолжает именно открытый им переход; завершённый
        // переход или другое голосование повторно не исполняются.
        let current_decision = current.state.get("agentInteraction").filter(|value| !value.is_null());
        let can_continue = opened.filter(|opened| js::truthy(Some(opened))).is_some_and(|opened| {
            same_value(get(current_decision, "id"), get(Some(opened), "id"))
                && get(current_decision, "status").and_then(Value::as_str) == Some("resolved")
                && get(current_decision, "resolvedOptionId").and_then(Value::as_str) == Some("continue")
        });
        if !can_continue {
            return Ok(json!({
                "duplicate": true,
                "state_version": current.state_version,
                "admin_commands": 0,
                "state": viewer(&current.state, &user, &hero_ids)?,
            }));
        }
        replayed_intent = duplicate.events.iter().find(|event| is_type(event, "DirectorIntentRecorded")).and_then(|event| at(Some(event), &["payload", "intent"])).filter(|intent| !intent.is_null()).cloned();
    }
    let mut loaded = set.autonomous.load(&campaign_id).map_err(orchestrator_failure)?;
    playable(&loaded.state)?;
    assert_director_advance_ready(&app, &campaign_id, &loaded.state).await?;
    let interaction = loaded.state.get("agentInteraction");
    let interaction_status = get(interaction, "status").and_then(Value::as_str);
    if replayed_intent.is_none() && interaction_status == Some("open") {
        return Err(policy_error("Сначала завершите открытое решение отряда", "PARTY_DECISION_OPEN").into());
    }
    if replayed_intent.is_none() && interaction_status == Some("resolved") {
        let id = js::s(get(interaction, "id"));
        match director_resume_key(&core, &campaign_id, &id) {
            Ok(_) => return Err(policy_error("Продолжите уже принятое решение отряда через interaction_id", "PARTY_DECISION_RESUME_REQUIRED").into()),
            Err(error) if error.code.as_deref() == Some("DIRECTOR_RESUME_NOT_FOUND") => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut events: Vec<Value> = Vec::new();
    let mut reward: Option<Value> = Some(Value::Null);
    // Завершение встречи — одноразовое последствие, и решает это координатор,
    // а не маршрут: он же владеет ключом `encounter-completion:<id>:transition`.
    let stages: [&str; 1] = ["encounter-completion"];
    let completion_run = run_post_commit(&core, PostCommitRequest { campaign_id: &campaign_id, state: &loaded.state, events: &[], commit_key: &key, stages: Some(&stages), context: Map::new() }).await;
    if let Some(completion) = completion_run.results.get("encounter-completion").cloned().flatten().filter(|completion| js::truthy(Some(completion))) {
        events.extend(array(completion.get("events")).iter().cloned());
        reward = completion.get("reward").cloned();
        loaded = set.autonomous.load(&campaign_id).map_err(orchestrator_failure)?;
    }
    if js::truthy(at(Some(&loaded.state), &["mechanics", "combat", "active"])) {
        return Err(ApiError::coded(StatusCode::CONFLICT, "Сначала завершите активный бой через тактический интерфейс", "COMBAT_ACTIVE").into());
    }
    let player_action = body.get("player_action");
    let decision = match replayed_intent {
        Some(intent) => json!({ "intent": intent, "trace": { "mode": "idempotent-pending-transition" } }),
        None => director_agent(&app).choose(&loaded.state, &js::s(player_action), None).await.map_err(|error| Failure::new(error.message, (!error.code.is_empty()).then_some(error.code.as_str())))?,
    };
    let key_value = Value::String(key.clone());
    let result = set.autonomous.run_intent(&campaign_id, decision.get("intent"), Some(&key_value), player_action).await.map_err(orchestrator_failure)?;
    stage_events(&result, &mut events)?;
    warn_on_deadly_encounter(&core, &campaign_id, &events)?;
    let authoritative = set.autonomous.load(&campaign_id).map_err(orchestrator_failure)?;
    let state = &authoritative.state;
    // Шаг Директора менял цель и сцену молча: строка Режиссёра в летописи.
    // Строка про небо запасной текст не вытесняет, а дописывается к нему;
    // брифу запасного рассказчика небо не показывают. Сцена незнакомца
    // сценария говорит своим авторским текстом.
    let director_narration = director_narration(&events, state, result.get("intent").and_then(|intent| get(Some(intent), "type")))?;
    // Победу «продолжим» закрывает сцена после схватки, а уже за ней —
    // строка дележа добычи. Без живого текста — только строка.
    let recent: Vec<Value> = recent_narrator_texts(get_room(&core, &campaign_id)?.state.as_ref(), 6).into_iter().map(Value::String).collect();
    let mut viewer_brief = Map::new();
    viewer_brief.insert("playerId".into(), Value::String(owned_viewer(&hero_ids, state)));
    viewer_brief.insert("partyIds".into(), Value::Array(hero_ids.clone()));
    viewer_brief.insert("isPartyMember".into(), Value::Bool(true));
    if let Some(role) = user.get("role") {
        viewer_brief.insert("role".into(), role.clone());
    }
    let aftermath_input = json!({ "events": events, "state": state, "viewer": viewer_brief, "recentNarrations": recent });
    // `.catch(() => null)`.
    let aftermath = set.creative.render_aftermath(&aftermath_input).await.ok().flatten();
    let aftermath_narration = aftermath.as_ref().and_then(|aftermath| aftermath.get("narration")).filter(|narration| js::truthy(Some(narration))).cloned();
    if let Some(narration) = &aftermath_narration {
        append_room_journal(&core, &campaign_id, &[json!({ "id": format!("aftermath-{}", sha_tail(&key)), "text": narration, "speaker": "narrator", "author": "Рассказчик", "turnConsumed": false })])?;
    }
    // После поражения сцена и есть рассказ: сухая сводка за ней повторяла бы
    // то же цифрами.
    let defeat_told = at(aftermath.as_ref(), &["trigger", "kind"]).and_then(Value::as_str) == Some("defeat_aftermath") && aftermath_narration.is_some();
    let message = (!director_narration.is_empty() && !defeat_told).then(|| json!({ "id": format!("director-{}", sha_tail(&key)), "text": director_narration, "speaker": "narrator", "turnConsumed": false }));
    persist_authoritative_projection(&core, &campaign_id, state, &events, message.as_ref(), PersistOptions::default())?;
    let mut answer = Map::new();
    if let Some(intent) = result.get("intent") {
        answer.insert("intent".into(), intent.clone());
    }
    if let Some(trace) = decision.get("trace") {
        answer.insert("director_trace".into(), trace.clone());
    }
    if let Some(reward) = reward {
        answer.insert("reward".into(), reward);
    }
    answer.insert("state_version".into(), json!(authoritative.state_version));
    answer.insert("admin_commands".into(), json!(0));
    answer.insert("state".into(), viewer(state, &user, &hero_ids)?);
    Ok(Value::Object(answer))
}

/// `a === b` для id решения (`undefined === undefined` — тоже равенство).
fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `scenarioStrangerNarration(events, state) || tacticalNarrationOr(events,
/// state, (briefEvents) => directorStepNarration(type, briefEvents, state) ||
/// deterministicNarration({ visible_events: briefEvents, … }, actorNameResolver(state)).narration)`.
fn director_narration(events: &[Value], state: &Value, intent_type: Option<&Value>) -> Result<String, Failure> {
    let stranger = sk_attention::scenario_attention::scenario_stranger_narration(Some(&Value::Array(events.to_vec())), state);
    if !stranger.is_empty() {
        return Ok(stranger);
    }
    let mut fallback_error: Option<Failure> = None;
    let text = sk_narration::combat_narration::tactical_narration_or(
        events,
        state,
        |brief_events| {
            let step = sk_orchestrator::autonomous_orchestrator::director_step_narration(intent_type, brief_events, state);
            if !step.is_empty() {
                return step;
            }
            let brief = json!({ "visible_events": brief_events, "visible_state_changes": [], "known_environment": {}, "permitted_npc_reactions": [] });
            let resolver = sk_rules::summary::actor_name_resolver(state);
            let resolve = |id: Option<&Value>| resolver.resolve(id);
            match sk_agents::narrator::deterministic_narration(&brief, Some(&resolve), &[]) {
                Ok(narrated) => js::s(narrated.get("narration")),
                Err(error) => {
                    fallback_error = Some(Failure::new(error.message, error.code.as_deref()));
                    String::new()
                }
            }
        },
        None,
    )
    .map_err(|error| Failure::new(error.0, None))?;
    match fallback_error {
        Some(error) => Err(error),
        None => Ok(text),
    }
}

// --- стадия encounter-completion координатора последствий (377–387) ------------

/// `completeEncounter({ campaignId, stageKey })`: встреча закрыта, а
/// завершения по ключу стадии ещё нет — `autonomousCampaign.completeEncounter`
/// с исходом встречи; иначе `null`.
pub async fn complete_encounter_stage(core: &Rc<GameCore>, campaign_id: &str, stage_key: &str) -> Result<Option<Value>, String> {
    let app = crate::clocks::app().ok_or_else(|| "игровое ядро остановлено".to_string())?;
    let set = orchestration(core, &app).map_err(|error| error.to_string())?;
    let current = set.autonomous.load(campaign_id).map_err(|error| error.message())?;
    let encounter = at(Some(&current.state), &["mechanics", "encounter"]);
    if !js::truthy(get(encounter, "id")) || get(encounter, "status").and_then(Value::as_str) != Some("ended") {
        return Ok(Some(Value::Null));
    }
    if core.events.get_by_idempotency_key(campaign_id, stage_key).map_err(|error| error.message)?.is_some() {
        return Ok(Some(Value::Null));
    }
    let outcome = get(encounter, "outcome").filter(|outcome| js::truthy(Some(outcome))).cloned().unwrap_or_else(|| Value::from("enemies_defeated"));
    set.autonomous.complete_encounter(campaign_id, Some(&outcome)).await.map(Some).map_err(|error| error.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interaction_id_pattern() {
        assert!(valid_interaction_id("interaction-1"));
        assert!(valid_interaction_id("a.b_c:d-e"));
        assert!(!valid_interaction_id(""));
        assert!(!valid_interaction_id("-lead"));
        assert!(!valid_interaction_id("bad id"));
        assert!(valid_interaction_id(&"a".repeat(120)));
        assert!(!valid_interaction_id(&"a".repeat(121)));
        assert!(!valid_interaction_id("идея"));
    }

    #[test]
    fn deadly_warning_anchor_and_null_stage() {
        let mut events = Vec::new();
        assert!(stage_events(&json!({ "results": [{ "events": [{ "event_type": "X" }] }, {}] }), &mut events).is_ok());
        assert_eq!(events.len(), 1);
        assert!(stage_events(&json!({ "results": [null] }), &mut events).is_err());
        assert_eq!(sha_tail("key").len(), 20);
    }
}
