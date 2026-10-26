//! С6: кампании и членство — `GET /api/campaigns` (4445), `GET /api/heroes`
//! (4473), `POST /api/campaigns` (4485–4595), `POST …/invites` (4806–4844),
//! `POST …/join` (4847–4869).
//!
//! Маршруты объявляются с номером строки `server/index.mjs`, где JS их
//! проверяет: порядок общей таблицы (`routes::table`) выводится из этих
//! номеров. Все пять сравнивают `pathname`, строка запроса им не мешает.
//!
//! Обработка ошибок повторяет `try/catch` JS: то, что внутри `try`, бросает
//! [`Caught::Thrown`] и отвечает статусом своего `catch` (400 — или 409 для
//! `CAMPAIGN_FULL` у входа); `requireUser` стоит вне `try`. Аккаунты — только
//! через [`blocking`], комната и журнал — только в ядре.
//!
//! Отклонения от JS (комната — проекция журнала, `rust/SERVER-PLAN.md`,
//! решение №2): в JS комната — свой файл и не зависит от журнала, в Rust её
//! состояние собирается из журнала. Поэтому кампания с испорченным журналом
//! (`CAMPAIGN_RECOVERY_REQUIRED`) в списках `GET /api/campaigns` и
//! `GET /api/heroes` пропускается, а не роняет весь список; приглашение и вход
//! в такую кампанию отвечают 400 с текстом отказа восстановления (в JS они
//! прошли бы по файлу комнаты).

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sk_agents::campaign_bootstrap::{BootstrapError, CampaignBootstrapper, InspirationDraw};
use sk_agents::lore_author::LoreAuthor;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;
use sk_ruleset::ruleset_config::{ruleset_lock, ProfileOptions};
use sk_store::InitializeRequest;

use crate::access::{campaign_membership, can_access_room, require_user, string_or_empty};
use crate::config::{LEGACY_DEFAULT_RULESET_ID, MAX_PARTY_SLOTS, MIN_PARTY_SLOTS};
use crate::core::{blocking, CoreError};
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, ApiResult, Failure};
use crate::http::json;
use crate::room::{self, Room};
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    vec![
        Route::get(4445, Matcher::path("/api/campaigns"), list_campaigns),
        Route::get(4473, Matcher::path("/api/heroes"), list_heroes),
        Route::post(4485, Matcher::path("/api/campaigns"), create_campaign),
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/invites$/` и `POST`.
        Route::post(4807, Matcher::path_template("/api/campaigns/{id}/invites"), create_invite),
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/join$/` и `POST`.
        Route::post(4848, Matcher::path_template("/api/campaigns/{id}/join"), join_campaign),
    ]
}

// --- общее ------------------------------------------------------------------

/// Исход тела `try` маршрута: готовый ответ (`return json(...)` внутри `try`
/// или ошибка вне его) либо исключение, которое ловит `catch`.
pub(crate) enum Caught {
    Reply(ApiError),
    Thrown(Failure),
}

impl From<Failure> for Caught {
    fn from(failure: Failure) -> Self {
        Caught::Thrown(failure)
    }
}

impl From<ApiError> for Caught {
    fn from(error: ApiError) -> Self {
        Caught::Reply(error)
    }
}

/// Ядро остановлено или задание запаниковало — мимо `catch`, на последнюю
/// границу (500 `INTERNAL_ERROR`).
impl From<CoreError> for Caught {
    fn from(error: CoreError) -> Self {
        Caught::Reply(ApiError::from(error))
    }
}

impl From<crate::http::BodyError> for Caught {
    fn from(error: crate::http::BodyError) -> Self {
        Caught::Thrown(Failure::new(error.message, Some(error.code)))
    }
}

impl From<sk_store::accounts::AccountError> for Caught {
    fn from(error: sk_store::accounts::AccountError) -> Self {
        Caught::Thrown(Failure::from(error))
    }
}

impl From<BootstrapError> for Caught {
    fn from(error: BootstrapError) -> Self {
        Caught::Thrown(Failure::new(error.message, error.code.as_deref()))
    }
}

/// `catch (error) { return json(res, status, …) }` по исходу тела.
fn settle(outcome: Result<axum::response::Response, Caught>, catch: impl FnOnce(Failure) -> ApiError) -> ApiResult {
    match outcome {
        Ok(response) => Ok(response),
        Err(Caught::Reply(error)) => Err(error),
        Err(Caught::Thrown(failure)) => Err(catch(failure)),
    }
}

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `a ?? b`: `a`, если оно не `null`/`undefined`, иначе `b` как есть.
fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(first) {
        first
    } else {
        second
    }
}

/// `value?.length`: длина массива или строки (в единицах UTF-16), поле
/// `length` объекта; у прочего — `undefined`.
fn js_length(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => Some(Value::from(items.len())),
        Value::String(text) => Some(Value::from(text.encode_utf16().count())),
        Value::Object(map) => map.get("length").cloned(),
        _ => None,
    }
}

/// `getRoom(code)` в ядре.
async fn get_room(state: &AppState, code: &str) -> Result<Result<Room, Failure>, CoreError> {
    let code = code.to_string();
    state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await
}

/// `listRoomCodes().map(getRoom)`: комнаты всех кампаний. Кампания, чью
/// комнату не собрать из журнала, пропускается (см. шапку модуля).
async fn all_rooms(state: &AppState) -> Result<Result<Vec<Room>, Failure>, CoreError> {
    state
        .core
        .call(|core| {
            Box::pin(async move {
                let codes = room::list_room_codes(&core)?;
                Ok(codes.iter().filter_map(|code| room::get_room(&core, code).ok()).collect())
            })
        })
        .await
}

/// `userForToken(cookies(req).skazanie_session) ?? fallback` (сбой — исключение).
async fn refreshed_user(ctx: &RouteCtx, fallback: &Value) -> Result<Value, Caught> {
    let Some(token) = ctx.session_token().filter(|token| !token.is_empty()) else { return Ok(fallback.clone()) };
    let accounts = ctx.state.accounts.clone();
    let user = blocking(move || accounts.user_for_token(&token)).await??;
    Ok(user.unwrap_or_else(|| fallback.clone()))
}

/// `String(hero.id)` героев комнаты: `partyMemberIds`, если он не пуст, иначе
/// `players` (`room.state.partyMemberIds?.length ? … : room.state.players.map(…)`).
fn party_ids(state: &Value) -> Vec<String> {
    let party = state.get("partyMemberIds");
    if js::truthy(js_length(party).as_ref()) {
        array(party).iter().map(|id| js::string(Some(id))).collect()
    } else {
        array(state.get("players")).iter().map(|hero| js::string(hero.get("id"))).collect()
    }
}

/// Места, где герой уже создан (`characterSetupRequired === false`).
fn created_hero_ids(state: &Value) -> Vec<String> {
    array(state.get("players")).iter().filter(|hero| js::is_false(hero.get("characterSetupRequired"))).map(|hero| js::string(hero.get("id"))).collect()
}

// --- GET /api/campaigns -----------------------------------------------------

/// Карточка кампании списка (4452–4467).
fn campaign_card(user: &Value, code: &str, room: &Room, state: &Value) -> Value {
    let party = state.get("partyMemberIds");
    let players = state.get("players");
    let member_count = match js_length(party) {
        Some(length) if js::truthy(Some(&length)) => length,
        _ => Value::from(array(players).len()),
    };
    let player_count = js_length(players).filter(|length| !length.is_null()).unwrap_or_else(|| Value::from(0));
    let concept = state.get("campaignConcept");
    let setting: Vec<String> = [concept.and_then(|c| c.get("era")), concept.and_then(|c| c.get("genre"))].into_iter().filter(|value| js::truthy(*value)).map(js::s).collect();
    let mechanics = state.get("mechanics");
    let lifecycle = mechanics.and_then(|m| m.get("campaign_lifecycle")).and_then(|l| l.get("status")).filter(|status| !status.is_null()).cloned();
    let defeated = mechanics.and_then(|m| m.get("death")).and_then(|d| d.get("campaign_status")).and_then(Value::as_str) == Some("party_defeated");
    let lifecycle_status = lifecycle.unwrap_or_else(|| Value::from(if defeated { "failed" } else { "active" }));
    let membership_role = if is_admin(user) {
        Value::from("admin")
    } else {
        campaign_membership(user, code).and_then(|membership| membership.get("role")).filter(|role| !role.is_null()).cloned().unwrap_or_else(|| Value::from("legacy"))
    };
    let mut card = Map::new();
    card.insert("code".into(), Value::from(code));
    card.insert("name".into(), Value::from(if js::truthy(state.get("campaign")) { js::s(state.get("campaign")) } else { code.to_string() }));
    card.insert("partyName".into(), Value::from(if js::truthy(state.get("partyName")) { js::s(state.get("partyName")) } else { "Без названия".to_string() }));
    card.insert("memberCount".into(), member_count);
    card.insert("playerCount".into(), player_count);
    card.insert("setting".into(), Value::from(setting.join(" · ")));
    card.insert("lifecycleStatus".into(), lifecycle_status);
    // `rulesetId: state.ruleset_id` — `undefined` в JSON не попадает.
    if let Some(value) = state.get("ruleset_id") {
        card.insert("rulesetId".into(), value.clone());
    }
    if let Some(value) = state.get("ruleset_version") {
        card.insert("rulesetVersion".into(), value.clone());
    }
    card.insert("membershipRole".into(), membership_role);
    card.insert("updatedAt".into(), room.updated_at.clone().map_or(Value::Null, Value::from));
    Value::Object(card)
}

/// `GET /api/campaigns` (4445–4471): кампании, доступные пользователю, свежие
/// первыми; сбой — 500 с текстом ошибки.
fn list_campaigns(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let rooms = all_rooms(&ctx.state).await?;
        let accounts = ctx.state.accounts.clone();
        let listed = match rooms {
            Ok(rooms) => {
                blocking(move || -> Result<Vec<Value>, Failure> {
                    let mut cards: Vec<(String, Value)> = Vec::new();
                    for room in &rooms {
                        let Some(state) = room.state.as_ref().filter(|state| js::truthy(Some(state))) else { continue };
                        if !can_access_room(&accounts, Some(&user), room)? {
                            continue;
                        }
                        let updated = room.updated_at.clone().unwrap_or_default();
                        cards.push((updated, campaign_card(&user, &room.code, room, state)));
                    }
                    // `String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))`.
                    cards.sort_by(|left, right| sk_core::text::locale_compare(&right.0, &left.0));
                    Ok(cards.into_iter().map(|(_, card)| card).collect())
                })
                .await?
            }
            Err(failure) => Err(failure),
        };
        match listed {
            Ok(campaigns) => Ok(json(StatusCode::OK, &json!({ "campaigns": campaigns }))),
            Err(failure) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, failure.message)),
        }
    })
}

// --- GET /api/heroes --------------------------------------------------------

/// `GET /api/heroes` (4473–4483): только администратору — герои всех
/// кампаний, один на id (поздний перекрывает значение, место — первого),
/// по имени в русской локали.
fn list_heroes(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        crate::access::require_admin(ctx).await?;
        match all_rooms(&ctx.state).await? {
            Ok(rooms) => {
                let mut heroes: IndexMap<String, Value> = IndexMap::new();
                for room in &rooms {
                    for hero in array(room.state.as_ref().and_then(|state| state.get("players"))) {
                        heroes.insert(js::string(hero.get("id")), hero.clone());
                    }
                }
                let mut list: Vec<Value> = heroes.into_values().collect();
                list.sort_by(|left, right| sk_story::campaign_loop_policy::locale_compare_ru(&js::string(left.get("character")), &js::string(right.get("character"))));
                Ok(json(StatusCode::OK, &json!({ "heroes": list })))
            }
            Err(failure) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, failure.message)),
        }
    })
}

// --- POST /api/campaigns ----------------------------------------------------

/// `/^[A-Z0-9-]{3,24}$/`.
fn valid_campaign_code(code: &str) -> bool {
    (3..=24).contains(&code.chars().count()) && code.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-')
}

/// Хоть одно из полей задано (`!== undefined`), даже `null`.
fn has_any(object: Option<&Value>, keys: &[&str]) -> bool {
    keys.iter().any(|key| object.and_then(|object| object.get(*key)).is_some())
}

/// `body.bootstrap?.players?.[index]?.id`.
fn bootstrap_player_id(players: Option<&Value>, index: usize) -> Option<&Value> {
    let player = match players? {
        Value::Array(items) => items.get(index),
        Value::Object(map) => map.get(&index.to_string()),
        _ => None,
    };
    player.and_then(|player| player.get("id"))
}

/// Вход `campaignBootstrapper.create({...})`: поля со значением `undefined`
/// не попадают в объект.
fn bootstrap_input(code: &str, body: &Value, bootstrap: &Value, players: Value) -> Value {
    let mut input = Map::new();
    let mut put = |key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            input.insert(key.to_string(), value.clone());
        }
    };
    put("code", Some(&Value::from(code)));
    put("name", body.get("name"));
    put("partyName", bootstrap.get("partyName"));
    put("world", bootstrap.get("world"));
    put("worldTemplateId", nullish(bootstrap.get("worldTemplateId"), bootstrap.get("world_template_id")));
    put("players", Some(&players));
    put("rulesetId", nullish(bootstrap.get("rulesetId"), bootstrap.get("ruleset_id")));
    put("startLevel", nullish(bootstrap.get("startLevel"), bootstrap.get("start_level")));
    put("campaignMode", bootstrap.get("campaignMode"));
    Value::Object(input)
}

/// Импорт готового состояния администратором (4550–4576): режим кампании,
/// редакция и состав пакетов — серверные, выбор редакции сразу закреплён.
fn locked_import(body: &Value, initial: Value) -> Result<Value, Caught> {
    sk_society::campaign_stories::validate_campaign_mode(initial.get("campaignConcept").and_then(|concept| concept.get("campaign_mode"))).map_err(Failure::from)?;
    let supplied = body.get("state");
    let field = |key: &str| supplied.and_then(|state| state.get(key));
    let legacy = Value::from(LEGACY_DEFAULT_RULESET_ID);
    let requested = nullish(nullish(field("ruleset_id"), field("rulesetId")), Some(&legacy));
    let lock = ruleset_lock(&js::s(requested), ProfileOptions::fallback(LEGACY_DEFAULT_RULESET_ID)).map_err(|error| Failure::new(error.message, Some(&error.code)))?;
    let supplied_version = nullish(field("ruleset_version"), field("rulesetVersion"));
    if js::present(supplied_version) && js::s(supplied_version) != js::s(lock.get("ruleset_version")) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Версию ruleset определяет сервер", "RULESET_FIELDS_SERVER_OWNED").into());
    }
    if let Some(Value::Array(packs)) = nullish(field("enabled_rule_packs"), field("enabledRulePacks")) {
        let supplied: Vec<String> = packs.iter().map(|pack| js::string(Some(pack))).collect();
        let locked: Vec<String> = array(lock.get("enabled_rule_packs")).iter().map(|pack| js::s(Some(pack))).collect();
        if supplied != locked {
            return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Состав rule packs определяет сервер", "RULESET_FIELDS_SERVER_OWNED").into());
        }
    }
    let mut house_rules: IndexSet<String> = IndexSet::new();
    for rule in array(initial.get("enabled_house_rules")).iter().chain(array(lock.get("enabled_house_rules"))) {
        house_rules.insert(js::string(Some(rule)));
    }
    let mut locked = js::spread(&initial, lock);
    if let Some(map) = locked.as_object_mut() {
        map.insert("enabled_house_rules".into(), js::strings_value(house_rules));
        map.insert("ruleset_selection_locked".into(), Value::Bool(true));
    }
    Ok(locked)
}

/// `eventStore.initializeCampaign(...)` и `saveRoom(code, ..., 0)` (4578–4593).
fn initialize_request(code: &str, state: &Value) -> InitializeRequest {
    let mut request = InitializeRequest::new(code, state.clone());
    let text = |key: &str| state.get(key).filter(|value| !value.is_null()).map(|value| js::s(Some(value)));
    let list = |key: &str| state.get(key).and_then(Value::as_array).map(|items| items.iter().map(|item| js::s(Some(item))).collect::<Vec<_>>());
    if let Some(id) = text("ruleset_id") {
        request.ruleset_id = id;
    }
    if let Some(version) = text("ruleset_version") {
        request.ruleset_version = version;
    }
    if let Some(packs) = list("enabled_rule_packs") {
        request.enabled_rule_packs = packs;
    }
    if let Some(rules) = list("enabled_house_rules") {
        request.enabled_house_rules = rules;
    }
    request
}

async fn create_body(ctx: &mut RouteCtx, creator: &Value) -> Result<axum::response::Response, Caught> {
    let body = ctx.json_body().await?;
    let admin = is_admin(creator);
    let code = string_or_empty(body.get("code")).to_uppercase();
    if !valid_campaign_code(&code) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Код кампании должен содержать 3–24 латинских символа, цифры или дефис").into());
    }
    if get_room(&ctx.state, &code).await??.state.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Кампания с таким кодом уже существует").into());
    }
    let bootstrap = body.get("bootstrap");
    let has_bootstrap = js::truthy(bootstrap);
    let boot = |key: &str| bootstrap.and_then(|bootstrap| bootstrap.get(key));
    // `Number(body.bootstrap?.slotCount ?? body.bootstrap?.players?.length ?? 0)`.
    let players_length = js_length(boot("players"));
    let zero = Value::from(0);
    let requested_slot_count = js::number(nullish(nullish(boot("slotCount"), players_length.as_ref()), Some(&zero)));
    let min = MIN_PARTY_SLOTS as f64;
    let max = MAX_PARTY_SLOTS as f64;
    if !admin && (!has_bootstrap || !requested_slot_count.is_finite() || requested_slot_count < min || requested_slot_count > max) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("Число мест героев должно быть от {MIN_PARTY_SLOTS} до {MAX_PARTY_SLOTS}")).into());
    }
    if !admin && js::truthy(body.get("state")) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Обычный игрок создаёт кампанию только через проверенный мастер создания").into());
    }
    if has_bootstrap && has_any(bootstrap, &["rulesetVersion", "ruleset_version", "enabledRulePacks", "enabled_rule_packs"]) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Версию и состав rule packs определяет сервер", "RULESET_FIELDS_SERVER_OWNED").into());
    }
    if has_bootstrap && has_any(bootstrap, &["worldTemplateVersion", "world_template_version", "worldMap", "world_map"]) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Версию и содержимое авторского мира определяет сервер", "WORLD_TEMPLATE_FIELDS_SERVER_OWNED").into());
    }
    let own_players = boot("players").and_then(Value::as_array).filter(|players| !players.is_empty());
    let uses_server_slots = !admin || own_players.is_none();
    // `Math.min(MAX, Math.max(MIN, Math.trunc(requested) || MAX))`.
    let truncated = requested_slot_count.trunc();
    let truncated = if truncated.is_nan() || truncated == 0.0 { max } else { truncated };
    let slot_count = truncated.max(min).min(max) as usize;
    let bootstrap_players = match own_players {
        Some(players) if !uses_server_slots => Value::Array(players.clone()),
        _ => {
            let mut slots = Vec::with_capacity(slot_count);
            for index in 0..slot_count {
                let generated = Value::from(format!("hero-slot-{}", index + 1));
                let id = nullish(bootstrap_player_id(boot("players"), index), Some(&generated)).unwrap_or(&generated).clone();
                let slot = sk_character::character_lifecycle::create_character_slot(Some(&id), Some(&Value::from(index))).map_err(|error| Failure::new(error.message, error.code.as_deref()))?;
                slots.push(slot);
            }
            Value::Array(slots)
        }
    };
    let generated_state = match bootstrap.filter(|_| has_bootstrap) {
        Some(bootstrap) => {
            let input = bootstrap_input(&code, &body, bootstrap, bootstrap_players);
            let llm = ctx.state.agent_llm().map(|client| client.client());
            let lore = ctx.state.lore_llm().map(|client| client.client());
            let created = ctx
                .state
                .core
                .call(move |core| {
                    Box::pin(async move {
                        let mut dice = core.dice.clone();
                        let draw: Box<InspirationDraw> = Box::new(move |world: &Value| {
                            sk_narration_base::campaign_inspiration::draw_campaign_inspiration(Some(world), Some(&mut dice)).map_err(|error| BootstrapError::new("RangeError", None, error.to_string()))
                        });
                        let bootstrapper = CampaignBootstrapper::new(llm, Some(LoreAuthor::new(lore)), Some(draw), None);
                        bootstrapper.create(&input).await
                    })
                })
                .await??;
            Some(created)
        }
        None => None,
    };
    let initial = match (&generated_state, body.get("state").filter(|state| !state.is_null())) {
        (Some(generated), _) => generated.clone(),
        (None, Some(state)) => state.clone(),
        (None, None) => {
            let name = if js::truthy(body.get("name")) { js::s(body.get("name")) } else { "Новая кампания".to_string() };
            json!({
                "sessionCode": code,
                "campaign": sk_core::text::slice(&name, 0, Some(120)),
                "players": [], "messages": [], "activePlayerId": "", "isNarrating": false, "pendingCheck": null,
                "scene": { "title": "Начало", "location": "", "mood": "", "objective": "", "turn": 0, "cells": [] },
            })
        }
    };
    let initial = if generated_state.is_none() { locked_import(&body, initial)? } else { initial };
    let mut state = sk_rules::normalize::normalize_campaign_state(&initial).map_err(Failure::from)?;
    if let Some(map) = state.as_object_mut() {
        map.insert("sessionCode".into(), Value::from(code.clone()));
        map.insert("engine_mode".into(), Value::from("enforce"));
    }
    let request = initialize_request(&code, &state);
    let room_code = code.clone();
    let room = ctx
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                let (initialized, _) = core.events.initialize_campaign(request).map_err(Failure::from)?;
                let mut room_state = initialized.state;
                if let Some(map) = room_state.as_object_mut() {
                    let messages = map.get("messages").filter(|value| value.is_array()).cloned().unwrap_or_else(|| json!([]));
                    map.insert("messages".into(), messages);
                    map.insert("engine_mode".into(), Value::from("enforce"));
                    map.insert("state_projector_version".into(), Value::from(sk_rules::constants::GAME_STATE_PROJECTOR_VERSION));
                }
                room::save_room(&core, &room_code, &room_state, 0).map(|saved| saved.room)
            })
        })
        .await??;
    // Первое место — создателя (4594–4606): обычный игрок всегда, а
    // администратор — когда мастер создания оставил места пустыми.
    let owner_hero_ids: Vec<Value> = array(state.get("partyMemberIds")).iter().take(1).cloned().collect();
    let first_id = js::string(owner_hero_ids.first());
    let first_seat = array(state.get("players")).iter().find(|hero| js::string(hero.get("id")) == first_id);
    let empty_seats = generated_state.is_some() && first_seat.is_some_and(|hero| js::is_true(hero.get("characterSetupRequired")));
    if !admin || empty_seats {
        let accounts = ctx.state.accounts.clone();
        let user_id = js::s(creator.get("id"));
        let hero_ids: Vec<String> = owner_hero_ids.iter().map(|id| js::string(Some(id))).collect();
        let campaign = code.clone();
        blocking(move || accounts.upsert_campaign_membership(&campaign, &user_id, "owner", &hero_ids)).await??;
    }
    let user = refreshed_user(ctx, creator).await?;
    Ok(json(StatusCode::CREATED, &js::spread(&room.to_json(), json!({ "user": user }))))
}

/// `POST /api/campaigns` (4485–4595): мастер создания (`bootstrap`) для
/// всех, готовое состояние (`state`) — только администратору; любое
/// исключение — 400 `{ error, code }`.
fn create_campaign(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let creator = require_user(ctx).await?;
        let outcome = create_body(ctx, &creator).await;
        settle(outcome, |failure| failure.respond(StatusCode::BAD_REQUEST))
    })
}

// --- приглашения и вход -----------------------------------------------------

/// `expiresInMs: body.expires_in_ms` в `createCampaignInvite`: отсутствует —
/// неделя по умолчанию; иначе `Math.max(60_000, Math.min(Number(x) || 0, 30 суток))`
/// (дробные миллисекунды отбрасываются — отклонение от JS).
fn invite_lifetime(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    let number = js::number(Some(value));
    let number = if number.is_nan() { 0.0 } else { number };
    Some(number.min(30.0 * 24.0 * 60.0 * 60.0 * 1000.0).max(60_000.0) as i64)
}

async fn invite_body(ctx: &mut RouteCtx, user: &Value) -> Result<axum::response::Response, Caught> {
    let campaign_id = ctx.param(0).to_uppercase();
    let room = get_room(&ctx.state, &campaign_id).await??;
    let Some(state) = room.state else { return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into()) };
    let accounts = ctx.state.accounts.clone();
    let (user_id, campaign) = (js::s(user.get("id")), campaign_id.clone());
    let membership = blocking(move || accounts.campaign_membership_for(&user_id, &campaign)).await??;
    let owner = membership.as_ref().and_then(|membership| membership.get("role")).and_then(Value::as_str) == Some("owner");
    if !is_admin(user) && !owner {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Создавать приглашения может только владелец кампании").into());
    }
    let body = ctx.json_body().await?;
    let party = party_ids(&state);
    let accounts = ctx.state.accounts.clone();
    let campaign = campaign_id.clone();
    let memberships = blocking(move || accounts.list_campaign_memberships(&campaign)).await??;
    let assigned: IndexSet<String> = memberships.iter().flat_map(|membership| array(membership.get("heroIds")).iter().map(|id| js::string(Some(id)))).collect();
    let requested: IndexSet<String> = array(body.get("hero_ids")).iter().map(|id| js::string(Some(id))).collect();
    // Ссылка по умолчанию раздаёт места, где героя ещё нет: готовый герой
    // уже чей-то, даже если членства на него нет.
    let created: IndexSet<String> = created_hero_ids(&state).into_iter().collect();
    let hero_ids: Vec<String> = if requested.is_empty() {
        party.iter().filter(|id| !assigned.contains(*id) && !created.contains(*id)).cloned().collect()
    } else {
        requested.into_iter().collect()
    };
    if hero_ids.is_empty() {
        return Err(ApiError::new(StatusCode::CONFLICT, "В кампании не осталось свободных героев").into());
    }
    if hero_ids.iter().any(|id| !party.contains(id) || assigned.contains(id)) {
        return Err(ApiError::new(StatusCode::CONFLICT, "Приглашение содержит недоступного или уже назначенного героя").into());
    }
    let lifetime = invite_lifetime(body.get("expires_in_ms"));
    let accounts = ctx.state.accounts.clone();
    let (creator, campaign) = (js::s(user.get("id")), campaign_id.clone());
    let (token, invite) = blocking(move || accounts.create_campaign_invite(&campaign, &creator, &hero_ids, lifetime, true)).await??;
    let mut reply = Map::new();
    reply.insert("campaign_id".into(), Value::from(campaign_id));
    reply.insert("token".into(), Value::from(token));
    reply.insert("hero_ids".into(), invite.get("heroIds").cloned().unwrap_or(Value::Null));
    reply.insert("expires_at".into(), invite.get("expiresAt").cloned().unwrap_or(Value::Null));
    Ok(json(StatusCode::CREATED, &Value::Object(reply)))
}

/// `POST /api/campaigns/:id/invites` (4806–4844): приглашение владельца или
/// администратора на свободные места; исключение — 400 `{ error }`.
fn create_invite(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let outcome = invite_body(ctx, &user).await;
        settle(outcome, |failure| ApiError::new(StatusCode::BAD_REQUEST, failure.message))
    })
}

async fn join_body(ctx: &mut RouteCtx, user: &Value) -> Result<axum::response::Response, Caught> {
    let campaign_id = ctx.param(0).to_uppercase();
    let room = get_room(&ctx.state, &campaign_id).await??;
    let Some(state) = room.state else { return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into()) };
    let body = ctx.json_body().await?;
    let token = js::s(nullish(body.get("invite_token"), body.get("inviteToken")));
    if token.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Для входа нужна действующая ссылка-приглашение").into());
    }
    let created = created_hero_ids(&state);
    let accounts = ctx.state.accounts.clone();
    let (user_id, campaign) = (js::s(user.get("id")), campaign_id.clone());
    let (membership, duplicate) = blocking(move || accounts.redeem_campaign_invite(&campaign, &token, &user_id, &created)).await??;
    let party: IndexSet<String> = party_ids(&state).into_iter().collect();
    let hero_ids = membership.get("heroIds").cloned().unwrap_or(Value::Null);
    if array(Some(&hero_ids)).iter().any(|id| !party.contains(&js::string(Some(id)))) {
        return Err(ApiError::new(StatusCode::CONFLICT, "Приглашение ссылается на героя, которого нет в кампании").into());
    }
    let updated = refreshed_user(ctx, user).await?;
    let mut reply = Map::new();
    reply.insert("code".into(), Value::from(campaign_id));
    reply.insert("hero_ids".into(), hero_ids);
    reply.insert("user".into(), updated);
    reply.insert("duplicate".into(), Value::Bool(duplicate));
    Ok(json(StatusCode::OK, &Value::Object(reply)))
}

/// `POST /api/campaigns/:id/join` (4847–4869): вход по приглашению;
/// `CAMPAIGN_FULL` — 409, прочее исключение — 400 `{ error }`.
fn join_campaign(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let outcome = join_body(ctx, &user).await;
        settle(outcome, |failure| {
            let status = if failure.code.as_deref() == Some("CAMPAIGN_FULL") { StatusCode::CONFLICT } else { StatusCode::BAD_REQUEST };
            ApiError::new(status, failure.message)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_length_follows_optional_length() {
        assert_eq!(js_length(Some(&json!([1, 2]))), Some(json!(2)));
        assert_eq!(js_length(Some(&json!("ёж"))), Some(json!(2)));
        assert_eq!(js_length(Some(&json!("😀"))), Some(json!(2)), "единицы UTF-16");
        assert_eq!(js_length(Some(&json!({ "length": "x" }))), Some(json!("x")));
        assert_eq!(js_length(Some(&json!(5))), None);
        assert_eq!(js_length(None), None);
    }

    #[test]
    fn invite_lifetime_matches_create_campaign_invite() {
        assert_eq!(invite_lifetime(None), None, "по умолчанию — неделя в хранилище");
        assert_eq!(invite_lifetime(Some(&Value::Null)), Some(60_000));
        assert_eq!(invite_lifetime(Some(&json!("abc"))), Some(60_000));
        assert_eq!(invite_lifetime(Some(&json!(120_000))), Some(120_000));
        assert_eq!(invite_lifetime(Some(&json!(1e18))), Some(30 * 24 * 60 * 60 * 1000));
    }

    #[test]
    fn campaign_code_shape() {
        assert!(valid_campaign_code("AB-1"));
        assert!(!valid_campaign_code("AB"));
        assert!(!valid_campaign_code("ÄBC"));
        assert!(!valid_campaign_code(&"A".repeat(25)));
    }

    #[test]
    fn party_ids_prefer_party_member_ids() {
        let state = json!({ "partyMemberIds": ["b"], "players": [{ "id": "a" }, { "id": 7 }] });
        assert_eq!(party_ids(&state), ["b"]);
        assert_eq!(party_ids(&json!({ "partyMemberIds": [], "players": [{ "id": "a" }, { "id": 7 }] })), ["a", "7"]);
    }
}
