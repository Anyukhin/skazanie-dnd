//! С11: решения отряда и задания — `server/index.mjs:4284–4425`:
//! `POST /api/campaigns/:id/quests/{abandon|accept}` (4284),
//! `POST /api/campaigns/:id/party-decisions/:decision/votes` (4313),
//! `POST /api/campaigns/:id/party-decisions/:decision/roll` (4375).
//!
//! Маршруты объявляются с номером строки `server/index.mjs`, где JS их
//! проверяет: порядок общей таблицы (`routes::table`) выводится из этих
//! номеров. Все три сравнивают `pathname` (строка запроса не мешает).
//!
//! Общий вход (`admit`): отказ до сверки, сверка проекции, наличие кампании,
//! доступ к комнате, тело, владелец героя — всё внутри `try` JS, поэтому сбой
//! сверки или тела — ответ маршрута по его таблице кодов, а не 500.
//! Аккаунты — только через [`blocking`], журнал, присутствие и проекция —
//! заданием ядра. Решение (коммит, проверка повтора, проекция, ответ) — одно
//! задание ядра: между чтением ключа и коммитом чужое задание не встаёт.
//! Гонку повтора (`index.mjs:4353–4359`) это не отменяет: коммит может
//! вернуть чужой коммит того же ключа (`IDEMPOTENCY_CONFLICT` журнала →
//! прежний коммит), и голос по-прежнему сверяется с записанным после
//! коммита.

use std::rc::Rc;

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sk_character::quest_decisions::{request_quest_decision, QuestDecisionRequest, QuestDecisionRequestError};
use sk_core::js;
use sk_dice::{Dice, Visibility};
use sk_memory::party_decision::{resolve_party_abstain, resolve_party_roll, resolve_party_vote, PartyDecisionError};
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Producer};
use sk_store::{CommitResult, LoadOptions};

use crate::access::{access_denied_before_reconcile, campaign_membership, can_access_room, can_use_hero, party_hero_ids, party_voter_snapshot_with, require_user, viewer_state_for};
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::idempotency::{key_nullish_raw, key_or_uuid};
use crate::projection::{self, executor_failure, HookedJournal, PersistOptions};
use crate::room::{self, Room};
use crate::routes::campaigns::Caught;

pub fn routes() -> Vec<Route> {
    vec![
        // `parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/quests\/(abandon|accept)$/)` и `POST` (4284–4285).
        Route::post(4297, Matcher::path_template("/api/campaigns/{id}/quests/{abandon|accept}"), quest_decision),
        // `…\/party-decisions\/([A-Za-z0-9._:-]+)\/votes$/` и `POST` (4313–4314).
        Route::post(4326, Matcher::path_template("/api/campaigns/{id}/party-decisions/{decision}/votes"), party_vote),
        // `…\/party-decisions\/([A-Za-z0-9._:-]+)\/roll$/` и `POST` (4375–4376).
        Route::post(4388, Matcher::path_template("/api/campaigns/{id}/party-decisions/{decision}/roll"), party_roll),
    ]
}

/// Коды 409 решения по заданию (4307).
const QUEST_CONFLICTS: &[&str] = &["IDEMPOTENCY_CONFLICT", "PARTY_DECISION_CONFLICT", "WORLD_QUEST_CLOSED", "WORLD_QUEST_ALREADY_ACCEPTED", "CAMPAIGN_NOT_ACTIVE", "QUEST_DECISION_DURING_COMBAT"];
/// Коды 409 голоса (4369).
const VOTE_CONFLICTS: &[&str] = &["STATE_VERSION_CONFLICT", "PARTY_DECISION_CONFLICT", "PARTY_DECISION_CLOSED", "PARTY_DECISION_ABSTAINED", "IDEMPOTENCY_CONFLICT"];
/// Коды 409 общего броска (4421): без `IDEMPOTENCY_CONFLICT`.
const ROLL_CONFLICTS: &[&str] = &["STATE_VERSION_CONFLICT", "PARTY_DECISION_CONFLICT", "PARTY_DECISION_CLOSED", "PARTY_DECISION_ABSTAINED"];
const FORBIDDEN: &[&str] = &["ACTOR_FORBIDDEN"];

const NO_ACCESS: &str = "Нет доступа к этой кампании";

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

/// `TypeError` JS при чтении поля у `null`.
fn null_read(field: &str) -> Failure {
    Failure::new(format!("Cannot read properties of null (reading '{field}')"), None)
}

fn party_failure(error: PartyDecisionError) -> Failure {
    Failure::new(error.message, Some(&error.code))
}

fn party_rule(error: PartyDecisionError) -> sk_core::RuleError {
    sk_core::RuleError::new(error.code, error.message)
}

/// `catch (error)` маршрута: статус по коду, текст — `error.message`, а
/// пустой текст — `fallback` (только у задания: `error.message || …`).
fn reply(caught: Caught, conflicts: &[&str], fallback: Option<&str>) -> ApiError {
    match caught {
        Caught::Reply(error) => error,
        Caught::Thrown(mut failure) => {
            if let Some(fallback) = fallback.filter(|_| failure.message.is_empty()) {
                failure.message = fallback.to_string();
            }
            failure.respond_by(&[(conflicts, StatusCode::CONFLICT), (FORBIDDEN, StatusCode::FORBIDDEN)], StatusCode::BAD_REQUEST)
        }
    }
}

/// Кампания, пользователь и тело после общих проверок.
struct Admitted {
    campaign_id: String,
    user: Value,
    body: Value,
}

/// Общие шаги трёх маршрутов (4286–4293, 4315–4324, 4377–4388) до
/// `canUseHero`: отказ до сверки и после неё — 403 без кода, нет состояния —
/// 404, `null` от сверки — `TypeError` (400 по `catch`).
async fn admit(ctx: &mut RouteCtx, user: Value) -> Result<Admitted, Caught> {
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
    if room.state.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into());
    }
    let accounts = state.accounts.clone();
    let checked_user = user.clone();
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &room)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, NO_ACCESS).into());
    }
    let body = ctx.json_body().await?;
    Ok(Admitted { campaign_id, user, body })
}

/// `canUseHero(user, actor, campaignId)` → 403 `ACTOR_FORBIDDEN`.
async fn require_hero(ctx: &RouteCtx, admitted: &Admitted, actor: Option<Value>) -> Result<(), Caught> {
    let accounts = ctx.state.accounts.clone();
    let (user, code) = (admitted.user.clone(), admitted.campaign_id.clone());
    if !blocking(move || can_use_hero(&accounts, &user, actor.as_ref(), &code)).await?? {
        return Err(ApiError::coded(StatusCode::FORBIDDEN, "Этот герой не принадлежит вашему аккаунту", "ACTOR_FORBIDDEN").into());
    }
    Ok(())
}

/// `{ version, updatedAt, state: viewerStateFor(stateWithLivePresence(room.state, id), user, actor) }`
/// и поля решения после них.
fn room_reply(core: &GameCore, campaign_id: &str, room: &Room, user: &Value, actor: Option<&Value>, extra: Vec<(&str, Value)>) -> Result<Value, Failure> {
    let room_state = room.state.clone().unwrap_or(Value::Null);
    let present = crate::streams::state_with_live_presence(core, &room_state, campaign_id)?;
    let viewer = viewer_state_for(&present, user, actor)?.unwrap_or(Value::Null);
    let mut body = Map::new();
    body.insert("version".into(), Value::from(room.version));
    body.insert("updatedAt".into(), room.updated_at.clone().map_or(Value::Null, Value::String));
    body.insert("state".into(), viewer);
    for (key, value) in extra {
        body.insert(key.into(), value);
    }
    Ok(Value::Object(body))
}

/// Коммит в виде ответа: `mechanics` и `state_version`.
fn commit_fields(committed: &CommitResult) -> Vec<(&'static str, Value)> {
    vec![("mechanics", Value::Array(committed.events.clone())), ("state_version", Value::from(committed.state_version))]
}

// --- POST /api/campaigns/:id/quests/{abandon|accept} -------------------------

/// Предложить отряду отказаться от задания или принять его (4284–4311):
/// событие `PartyDecisionOpened` с голосующими всего отряда, повтор по
/// ключу — тот же коммит, другой запрос под тем же ключом — 409. Затем
/// сверка проекции (она же исполняет решённое задание).
fn quest_decision(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        quest_decision_body(ctx, user).await.map_err(|caught| reply(caught, QUEST_CONFLICTS, Some("Не удалось предложить решение по заданию")))
    })
}

async fn quest_decision_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let action = ctx.param(1).to_string();
    let admitted = admit(ctx, user).await?;
    require_hero(ctx, &admitted, admitted.body.get("actor_id").cloned()).await?;
    let key = key_nullish_raw(&admitted.body, &ctx.headers);
    // `voterSnapshot` JS читает членства синхронно внутри сборщика событий;
    // ядро аккаунты не читает — членства берутся заранее (`blocking`).
    let memberships = {
        let accounts = ctx.state.accounts.clone();
        let code = admitted.campaign_id.clone();
        blocking(move || accounts.list_campaign_memberships(&code)).await?.map_err(Failure::from)?
    };
    let Admitted { campaign_id, user, body } = admitted;
    let reply = ctx
        .state
        .core
        .call(move |core| Box::pin(async move { open_quest_decision(&core, &campaign_id, &user, &body, key.as_ref(), &action, &memberships) }))
        .await??;
    Ok(json(StatusCode::OK, &reply))
}

fn quest_failure(error: QuestDecisionRequestError) -> Failure {
    Failure::new(error.message(), Some(error.code()))
}

fn open_quest_decision(core: &Rc<GameCore>, campaign_id: &str, user: &Value, body: &Value, key: Option<&Value>, action: &str, memberships: &[Value]) -> Result<Value, Failure> {
    let snapshot = |state: &Value| -> Value {
        let eligible = party_hero_ids(state);
        let voters = party_voter_snapshot_with(memberships, campaign_id, state, &eligible);
        let mut snapshot = Map::new();
        snapshot.insert("eligibleHeroIds".into(), js::strings_value(eligible));
        if let Value::Object(voters) = voters {
            snapshot.extend(voters);
        }
        Value::Object(snapshot)
    };
    {
        let journal = HookedJournal(&core.events);
        let executor = AuthoritativeExecutor::new(&journal);
        let request = QuestDecisionRequest {
            campaign_id,
            actor_id: body.get("actor_id"),
            quest_id: body.get("quest_id"),
            idempotency_key: key,
            voter_snapshot: &snapshot,
            now: sk_core::clock::now_ms(),
            action: Some(action),
        };
        request_quest_decision(&executor, request).map_err(quest_failure)?;
    }
    let latest = projection::reconcile_campaign_projection(core, campaign_id)?.ok_or_else(|| null_read("version"))?;
    room_reply(core, campaign_id, &latest, user, body.get("actor_id"), Vec::new())
}

// --- POST /api/campaigns/:id/party-decisions/:decision/votes ----------------

/// Голос или воздержание героя (4313–4373). Кворум — по подключённым героям
/// отряда (живые потоки), без них — по `online` героев; события
/// пересобираются против свежего состояния. Ключ сверяется с записанным
/// голосом и после коммита: чужой коммит под тем же ключом — 409.
fn party_vote(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        party_vote_body(ctx, user).await.map_err(|caught| reply(caught, VOTE_CONFLICTS, None))
    })
}

async fn party_vote_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let interaction_id = ctx.param(1).to_string();
    let admitted = admit(ctx, user).await?;
    let hero_id = js::s(admitted.body.get("actor_id"));
    require_hero(ctx, &admitted, Some(Value::String(hero_id.clone()))).await?;
    let key = key_or_uuid(&admitted.body, &ctx.headers);
    let Admitted { campaign_id, user, body } = admitted;
    let reply = ctx.state.core.call(move |core| Box::pin(async move { cast_vote(&core, &campaign_id, &user, &body, &interaction_id, &hero_id, &key) })).await??;
    Ok(json(StatusCode::OK, &reply))
}

fn cast_vote(core: &Rc<GameCore>, campaign_id: &str, user: &Value, body: &Value, interaction_id: &str, hero_id: &str, key: &str) -> Result<Value, Failure> {
    let abstain = body.get("abstain") == Some(&Value::Bool(true));
    let committed = match core.events.get_by_idempotency_key(campaign_id, key)? {
        Some(previous) => previous,
        None => {
            let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
            let party_members = party_hero_ids(&loaded.state);
            let connected = core.streams.connected_hero_ids(campaign_id);
            let candidates: Vec<String> = if connected.is_empty() {
                let players = loaded.state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                players.iter().filter(|player| js::truthy(player.get("online"))).map(|player| js::string(player.get("id"))).collect()
            } else {
                connected.into_iter().collect()
            };
            let eligible: Vec<String> = candidates.into_iter().filter(|candidate| party_members.contains(candidate)).collect();
            let mut input = Map::new();
            input.insert("interactionId".into(), Value::String(interaction_id.to_string()));
            input.insert("heroId".into(), Value::String(hero_id.to_string()));
            if !abstain {
                if let Some(option) = body.get("option_id") {
                    input.insert("optionId".into(), option.clone());
                }
                input.insert("eligibleHeroIds".into(), js::strings_value(eligible));
            }
            let input = Value::Object(input);
            // Пересобирается против свежего состояния: кворум и разрешение
            // зависят от того, кто ещё в комнате на момент записи.
            let derive = |state: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, sk_core::RuleError> {
                let resolved = if abstain { resolve_party_abstain(state, &input) } else { resolve_party_vote(state, &input) }.map_err(party_rule)?;
                Ok(resolved.get("events").and_then(Value::as_array).cloned().unwrap_or_default())
            };
            let journal = HookedJournal(&core.events);
            let executor = AuthoritativeExecutor::new(&journal);
            let request = DerivedRequest { campaign_id, idempotency_key: key, events: None, derive_events: Some(&derive), producer: Some(Producer::PartyDecision), derived_from: Vec::new(), metadata: Value::Null, derive_metadata: None };
            executor.commit_derived(request).map_err(executor_failure)?.ok_or_else(|| null_read("events"))?.commit
        }
    };
    // Возврат по ключу проверяется и после гонки, а не только до commit.
    let expected_type = if abstain { "PartyDecisionAbstained" } else { "PartyVoteCast" };
    let recorded = committed.events.iter().find(|event| {
        event.get("event_type").and_then(Value::as_str) == Some(expected_type)
            && event.get("payload").and_then(|payload| payload.get("interaction_id")).and_then(Value::as_str) == Some(interaction_id)
            && event.get("payload").and_then(|payload| payload.get("hero_id")).and_then(Value::as_str) == Some(hero_id)
    });
    let same_option = |event: &Value| abstain || event.get("payload").and_then(|payload| payload.get("option_id")) == body.get("option_id");
    if !recorded.is_some_and(same_option) {
        return Err(Failure::new("Ключ уже использован для другого голоса", Some("IDEMPOTENCY_CONFLICT")));
    }
    let projected = projection::persist_authoritative_projection(core, campaign_id, &committed.state, &committed.events, None, PersistOptions::default())?;
    let latest = match projection::reconcile_campaign_projection(core, campaign_id)?.or(projected) {
        Some(room) => room,
        None => room::get_room(core, campaign_id)?,
    };
    room_reply(core, campaign_id, &latest, user, Some(&Value::String(hero_id.to_string())), commit_fields(&committed))
}

// --- POST /api/campaigns/:id/party-decisions/:decision/roll -----------------

/// Общий бросок отряда (4375–4425): `1d20` бросает серверный кубик
/// (назначение `party_decision`, видимость `party`) до разбора решения;
/// исход и `DieRolled` — производным коммитом. Повтор по ключу отдаёт
/// найденный коммит без сверки с запросом (как в JS).
fn party_roll(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        party_roll_body(ctx, user).await.map_err(|caught| reply(caught, ROLL_CONFLICTS, None))
    })
}

async fn party_roll_body(ctx: &mut RouteCtx, user: Value) -> Result<axum::response::Response, Caught> {
    let interaction_id = ctx.param(1).to_string();
    let admitted = admit(ctx, user).await?;
    let hero_id = js::s(admitted.body.get("actor_id"));
    require_hero(ctx, &admitted, Some(Value::String(hero_id.clone()))).await?;
    let key = key_or_uuid(&admitted.body, &ctx.headers);
    let Admitted { campaign_id, user, .. } = admitted;
    let reply = ctx.state.core.call(move |core| Box::pin(async move { roll_for_party(&core, &campaign_id, &user, &interaction_id, &hero_id, &key) })).await??;
    Ok(json(StatusCode::OK, &reply))
}

fn roll_for_party(core: &Rc<GameCore>, campaign_id: &str, user: &Value, interaction_id: &str, hero_id: &str, key: &str) -> Result<Value, Failure> {
    let committed = match core.events.get_by_idempotency_key(campaign_id, key)? {
        Some(previous) => previous,
        None => {
            let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
            // Бросок делает серверный кубик, а не клиент. Он решает только
            // исход голосования и не трогает владений Rules Engine —
            // производный вход это проверяет по содержимому payload.
            let mut dice = core.dice.clone();
            let rolled = dice.roll("1d20", "party_decision", Some(hero_id), Visibility::Party).map_err(|error| Failure::new(error.to_string(), Some(error.code())))?;
            let roll = serde_json::to_value(&rolled).map_err(|error| Failure::new(error.to_string(), None))?;
            let resolution = resolve_party_roll(&loaded.state, &json!({ "interactionId": interaction_id, "heroId": hero_id, "roll": roll })).map_err(party_failure)?;
            let events = resolution.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            let journal = HookedJournal(&core.events);
            let executor = AuthoritativeExecutor::new(&journal);
            executor.commit_derived(DerivedRequest::events(campaign_id, key, Producer::PartyDecision, events)).map_err(executor_failure)?.ok_or_else(|| null_read("events"))?.commit
        }
    };
    let resolved_roll = committed
        .events
        .iter()
        .find(|event| event.get("event_type").and_then(Value::as_str) == Some("PartyDecisionResolved"))
        .and_then(|event| event.get("payload"))
        .and_then(|payload| payload.get("roll"))
        .cloned();
    let projected = projection::persist_authoritative_projection(core, campaign_id, &committed.state, &committed.events, None, PersistOptions::default())?;
    let latest = match projected {
        Some(room) => room,
        None => room::get_room(core, campaign_id)?,
    };
    let mut extra = commit_fields(&committed);
    // `roll: undefined` в JSON не попадает.
    if let Some(roll) = resolved_roll {
        extra.push(("roll", roll));
    }
    room_reply(core, campaign_id, &latest, user, Some(&Value::String(hero_id.to_string())), extra)
}
