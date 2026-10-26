//! С7: настройки ИИ кампании, редакция правил и домашние правила —
//! `GET`/`PATCH /api/campaigns/:id/settings` (`server/index.mjs:4623–4804`).
//!
//! Один маршрут на строке разбора регулярки (4623) с любым методом: метод
//! проверяет обработчик, как JS (`campaignAiSettingsMatch && req.method === …`,
//! 4649 и 4661); прочие методы идут дальше по таблице. Путь сравнивается по
//! `pathname`, строка запроса не мешает.
//!
//! Настройки ИИ (модель, стиль рассказчика, режим импровизации, рассуждения) —
//! запись аккаунтов, только через [`blocking`]. Смена режима и модели не
//! создаёт события: это строка летописи (`journal::append_room_journal`).
//! Смена редакции и домашнего правила — производные коммиты журнала
//! (`AuthoritativeExecutor::commit_derived` над [`HookedJournal`]) с
//! обязательным `idempotency_key`; ключ правила — `${key}:house-rule:${id}`.
//!
//! Обработка ошибок повторяет JS: в `GET` всё вне `try` (сбой — 500 на
//! последней границе); в `PATCH` комната и членство вне `try`, остальное —
//! в нём: `CAMPAIGN_RULESET_LOCKED`, `IDEMPOTENCY_CONFLICT`,
//! `STATE_VERSION_CONFLICT`, `HOUSE_RULE_DURING_COMBAT` — 409, иное — 400
//! `{ error, code }`.
//!
//! Отклонение (комната — проекция журнала, `rust/SERVER-PLAN.md`, решение
//! №2): у кампании с испорченным журналом в JS есть файл комнаты, и отказ
//! случается позже — на `eventStore.load`. Здесь комнату не собрать, поэтому
//! `GET` решает доступ по членству (как рекап С6): администратору и участнику
//! — 500 (как падение `load` в JS), прочим — 403; `PATCH` проверяет владельца
//! и отвечает 400 с отказом восстановления (как `load` внутри `try` JS).

use axum::body::Body;
use axum::http::{Method, Response, StatusCode};
use serde_json::{json, Value};
use sk_core::{js, text, RuleError};
use sk_narration_base::campaign_ai_context::{normalize_improv_mode, normalize_narrator_style, normalize_reasoning_level, IMPROV_MODES, NARRATOR_STYLES, REASONING_LEVELS};
use sk_narration_base::model_style_profiles::{model_option_for, reasoning_level_allowed_for, RECOMMENDED_MODEL};
use sk_ruleset::campaign_ruleset::{campaign_house_rule_change_event, campaign_house_rule_metadata, campaign_ruleset_change_event, campaign_ruleset_metadata, campaign_ruleset_settings, CampaignRulesetError, EventOptions};
use sk_store::accounts::CampaignAiSettings;
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Producer};
use sk_store::LoadOptions;

use crate::access::{campaign_membership, can_access_room, require_user};
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::projection::{executor_failure, persist_authoritative_projection, HookedJournal, PersistOptions};
use crate::room::{self, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/settings$/`; метод — в обработчике.
    vec![Route::pass(4623, Methods::Any, Matcher::path_template("/api/campaigns/{id}/settings"), campaign_settings)]
}

fn campaign_settings(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        if ctx.method == Method::GET {
            get_settings(ctx).await.map(Some)
        } else if ctx.method == Method::PATCH {
            patch_settings(ctx).await.map(Some)
        } else {
            Ok(None)
        }
    })
}

/// Коды отказа, которым `catch` отвечает 409 (4800).
const CONFLICT_CODES: &[&str] = &["CAMPAIGN_RULESET_LOCKED", "IDEMPOTENCY_CONFLICT", "STATE_VERSION_CONFLICT", "HOUSE_RULE_DURING_COMBAT"];

const SETTINGS_AUTHOR: &str = "Настройки кампании";

// --- общее ------------------------------------------------------------------

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

fn ruleset_failure(error: CampaignRulesetError) -> Failure {
    Failure::new(error.message, Some(&error.code))
}

/// `getRoom(code)` в ядре.
async fn get_room(state: &AppState, code: &str) -> Result<Result<Room, Failure>, ApiError> {
    let code = code.to_string();
    Ok(state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await?)
}

/// `eventStore.load(id).state` и `eventStore.getEvents(id)` в ядре.
async fn load_with_events(state: &AppState, campaign_id: &str) -> Result<Result<(Value, Value), Failure>, ApiError> {
    let campaign_id = campaign_id.to_string();
    Ok(state
        .core
        .call(move |core| {
            Box::pin(async move {
                let loaded = core.events.load(&campaign_id, &LoadOptions::default())?;
                let events = core.events.get_events(&campaign_id, 0, None)?;
                Ok::<_, Failure>((loaded.state, Value::Array(events)))
            })
        })
        .await?)
}

/// `getCampaignAiSettings(code)` через `blocking`.
async fn stored_settings(state: &AppState, campaign_id: &str) -> Result<Result<CampaignAiSettings, Failure>, ApiError> {
    let accounts = state.accounts.clone();
    let campaign_id = campaign_id.to_string();
    Ok(blocking(move || accounts.get_campaign_ai_settings(&campaign_id).map_err(Failure::from)).await?)
}

/// `campaignMembershipFor(userId, campaignId)?.role === 'owner'` через `blocking`.
async fn is_owner(state: &AppState, user: &Value, campaign_id: &str) -> Result<bool, ApiError> {
    let accounts = state.accounts.clone();
    let (user_id, campaign_id) = (js::s(user.get("id")), campaign_id.to_string());
    let membership = blocking(move || accounts.campaign_membership_for(&user_id, &campaign_id)).await?.map_err(Failure::from)?;
    Ok(membership.as_ref().and_then(|membership| membership.get("role")).and_then(Value::as_str) == Some("owner"))
}

/// `campaignAiSettingsPayload(saved, campaignId, { canManage, rulesetState, rulesetEvents })`
/// (4629–4649): модель вне серверного списка показывается как модель
/// сервера, уровень, который модель не принимает, — как `auto`.
fn settings_payload(app: &AppState, saved: &CampaignAiSettings, generations_today: i64, can_manage: bool, ruleset_state: &Value, ruleset_events: &Value) -> Result<Value, Failure> {
    let config = &app.config;
    let selected_model = if config.allowed_ai_models.contains(&saved.model) { saved.model.clone() } else { config.model.clone() };
    let reasoning_level = normalize_reasoning_level(Some(&Value::String(saved.reasoning_level.clone())));
    let reasoning = if reasoning_level_allowed_for(&selected_model, Some(reasoning_level)) { reasoning_level } else { "auto" };
    let ruleset = campaign_ruleset_settings(Some(ruleset_state), Some(ruleset_events), can_manage).map_err(|error| Failure::new(error.message, Some(&error.code)))?;
    let model_options: Vec<Value> = config.allowed_ai_models.iter().map(|id| serde_json::to_value(model_option_for(id, RECOMMENDED_MODEL)).unwrap_or(Value::Null)).collect();
    Ok(json!({
        "settings": {
            "model": selected_model,
            "narratorStyle": normalize_narrator_style(Some(&Value::String(saved.narrator_style.clone()))),
            "improvMode": normalize_improv_mode(Some(&Value::String(saved.improv_mode.clone()))),
            "reasoningLevel": reasoning,
        },
        "availableModels": config.allowed_ai_models,
        "modelOptions": model_options,
        "reasoningLevels": REASONING_LEVELS.iter().map(|level| json!({ "id": level.id, "label": level.label, "description": level.description })).collect::<Vec<_>>(),
        "narratorStyles": NARRATOR_STYLES.iter().map(|style| json!({ "id": style.id, "label": style.label })).collect::<Vec<_>>(),
        "improvModes": IMPROV_MODES.iter().map(|mode| json!({ "id": mode.id, "label": mode.label, "description": mode.description })).collect::<Vec<_>>(),
        "architectGenerationsToday": generations_today,
        "architectAlertThreshold": app.architect_usage.alert_threshold(),
        "canManage": can_manage,
        "ruleset": ruleset,
    }))
}

/// `architectUsage.generationsToday(campaignId)` — чтение файла, через `blocking`.
async fn generations_today(state: &AppState, campaign_id: &str) -> Result<i64, ApiError> {
    let usage = state.architect_usage.clone();
    let campaign_id = campaign_id.to_string();
    Ok(blocking(move || usage.generations_today(&campaign_id)).await?)
}

// --- GET ----------------------------------------------------------------------

/// `GET /api/campaigns/:id/settings` (4650–4660): видят все, у кого есть
/// доступ к кампании; `canManage` — администратору и владельцу.
async fn get_settings(ctx: &mut RouteCtx) -> Result<Response<Body>, ApiError> {
    let user = require_user(ctx).await?;
    let campaign_id = ctx.param(0).to_uppercase();
    let room = match get_room(&ctx.state, &campaign_id).await? {
        Ok(room) => room,
        Err(failure) => {
            // Журнал не собирается (см. шапку модуля).
            if is_admin(&user) || campaign_membership(&user, &campaign_id).is_some() {
                return Err(failure.into());
            }
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
        }
    };
    if room.state.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена"));
    }
    let accounts = ctx.state.accounts.clone();
    let (viewer, checked) = (user.clone(), room.clone());
    if !blocking(move || can_access_room(&accounts, Some(&viewer), &checked)).await?? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
    }
    let (ruleset_state, ruleset_events) = load_with_events(&ctx.state, &campaign_id).await??;
    let saved = stored_settings(&ctx.state, &campaign_id).await??;
    let can_manage = is_admin(&user) || is_owner(&ctx.state, &user, &campaign_id).await?;
    let generations = generations_today(&ctx.state, &campaign_id).await?;
    let payload = settings_payload(&ctx.state, &saved, generations, can_manage, &ruleset_state, &ruleset_events)?;
    Ok(json(StatusCode::OK, &payload))
}

// --- PATCH --------------------------------------------------------------------

/// `String(value).trim()` поля тела.
fn trimmed(value: &Value) -> String {
    text::trim(&js::string(Some(value))).to_string()
}

/// `String(value).trim().toLowerCase()` поля тела.
fn lowered(value: &Value) -> String {
    text::lower(&trimmed(value))
}

/// Запрошенные настройки ИИ после проверки (4673–4701).
struct Requested {
    model: String,
    style: String,
    improv_mode: String,
    reasoning: String,
}

/// Разбор и проверка настроек ИИ из тела (4673–4701).
fn requested_settings(app: &AppState, body: &Value, current: &CampaignAiSettings) -> Result<Requested, ApiError> {
    let allowed = &app.config.allowed_ai_models;
    let model = match body.get("model") {
        None => {
            if current.model.is_empty() {
                app.config.model.clone()
            } else {
                current.model.clone()
            }
        }
        Some(value) => trimmed(value),
    };
    let style = body.get("narratorStyle").map_or_else(|| current.narrator_style.clone(), lowered);
    let improv_mode = body.get("improvMode").map_or_else(|| normalize_improv_mode(Some(&Value::String(current.improv_mode.clone()))).to_string(), lowered);
    if !allowed.contains(&model) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Эта модель не входит в серверный список разрешённых моделей", "AI_MODEL_NOT_ALLOWED"));
    }
    if !NARRATOR_STYLES.iter().any(|known| known.id == style) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Неизвестный стиль рассказчика", "NARRATOR_STYLE_NOT_ALLOWED"));
    }
    if !IMPROV_MODES.iter().any(|known| known.id == improv_mode) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Неизвестный режим импровизации", "IMPROV_MODE_INVALID"));
    }
    // Смена модели без явного уровня сбрасывает уровень, который новая модель
    // не принимает, на `auto` — а не отвергает смену модели.
    let current_reasoning = normalize_reasoning_level(Some(&Value::String(current.reasoning_level.clone())));
    let reasoning = match body.get("reasoningLevel") {
        None => (if reasoning_level_allowed_for(&model, Some(current_reasoning)) { current_reasoning } else { "auto" }).to_string(),
        Some(value) => lowered(value),
    };
    if !REASONING_LEVELS.iter().any(|known| known.id == reasoning) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Неизвестный уровень рассуждений", "REASONING_LEVEL_INVALID"));
    }
    if !reasoning_level_allowed_for(&model, Some(&reasoning)) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Выбранная модель не поддерживает этот уровень рассуждений", "REASONING_LEVEL_NOT_SUPPORTED"));
    }
    Ok(Requested { model, style, improv_mode, reasoning })
}

/// Вход ядра для редакции и домашних правил.
struct RulesetChange {
    campaign_id: String,
    actor_id: Value,
    /// `String(loaded.state.ruleset_id)`, на которое смотрел запрос.
    loaded_state: Value,
    /// `rulesetId ?? ruleset_id`: `None` — поле не задано.
    requested_ruleset_id: String,
    /// `String(body.idempotency_key ?? header ?? '').trim()`.
    idempotency_key: String,
    /// `Object.entries(body.houseRules)` (объект, не массив).
    house_rules: Vec<(String, Value)>,
}

/// Производный коммит в ядре: события `derive` против свежего состояния.
fn commit_derived(core: &GameCore, campaign_id: &str, key: &str, derive: &sk_store::executor::DeriveEvents<'_>, metadata: &sk_store::executor::DeriveMetadata<'_>) -> Result<Option<sk_store::executor::Executed>, Failure> {
    let journal = HookedJournal(&core.events);
    let executor = AuthoritativeExecutor::new(&journal);
    let request = DerivedRequest {
        campaign_id,
        idempotency_key: key,
        events: None,
        derive_events: Some(derive),
        producer: Some(Producer::CampaignRuleset),
        derived_from: Vec::new(),
        metadata: Value::Null,
        derive_metadata: Some(metadata),
    };
    executor.commit_derived(request).map_err(executor_failure)
}

/// Смена редакции (4701–4735) и домашние правила (4737–4770) в ядре; ответ —
/// состояние, по которому собирается раздел `ruleset` ответа.
fn change_ruleset(core: &std::rc::Rc<GameCore>, change: &RulesetChange) -> Result<Value, Failure> {
    let campaign_id = change.campaign_id.as_str();
    let options = EventOptions { actor_id: Some(change.actor_id.clone()), now: None };
    let mut ruleset_state = change.loaded_state.clone();
    if change.requested_ruleset_id != js::string(change.loaded_state.get("ruleset_id")) {
        let key = change.idempotency_key.as_str();
        if key.is_empty() {
            return Err(Failure::new("Для смены редакции нужен idempotency_key", Some("IDEMPOTENCY_KEY_REQUIRED")));
        }
        let requested = change.requested_ruleset_id.as_str();
        let committed_events = match core.events.get_by_idempotency_key(campaign_id, key)? {
            Some(duplicate) => {
                let selected = duplicate.events.iter().find(|event| event.get("event_type").and_then(Value::as_str) == Some("CampaignRulesetChanged")).and_then(|event| event.get("payload")).and_then(|payload| payload.get("ruleset_id_after"));
                if js::s(selected) != requested {
                    return Err(Failure::new("Этот idempotency_key уже использован для другой редакции", Some("IDEMPOTENCY_CONFLICT")));
                }
                // Найденный по ключу коммит без `replayed` (4710): его события
                // идут в проекцию, как в JS.
                duplicate.events
            }
            None => {
                let derive = |fresh: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, RuleError> {
                    let history = Value::Array(core.events.get_events(campaign_id, 0, None).map_err(|error| RuleError::new(error.code, error.message))?);
                    let event = campaign_ruleset_change_event(requested, Some(fresh), Some(&history), &options).map_err(|error| RuleError::new(error.code(), error.message()))?;
                    Ok(event.into_iter().collect())
                };
                // Метаданные — по собственному событию: ошибка разбора невозможна.
                let metadata = |events: &[Value], _state: &Value, _loaded: &sk_store::Loaded| -> Value { campaign_ruleset_metadata(events.first()).unwrap_or_else(|_| json!({})) };
                match commit_derived(core, campaign_id, key, &derive, &metadata)? {
                    Some(executed) if !executed.replayed => executed.commit.events,
                    _ => Vec::new(),
                }
            }
        };
        let latest = core.events.load(campaign_id, &LoadOptions::default())?;
        persist_authoritative_projection(core, campaign_id, &latest.state, &committed_events, None, PersistOptions::default())?;
        ruleset_state = latest.state;
    }
    // Домашние правила идущей кампании — механика, а не настройка ИИ: событие
    // журнала тем же производным путём, что и смена редакции.
    for (house_rule_id, enabled) in &change.house_rules {
        let blank = js::spread(&ruleset_state, json!({ "enabled_house_rules": [] }));
        campaign_house_rule_change_event(house_rule_id, Some(enabled), Some(&blank), &options).map_err(ruleset_failure)?;
        if change.idempotency_key.is_empty() {
            return Err(Failure::new("Для смены домашнего правила нужен idempotency_key", Some("IDEMPOTENCY_KEY_REQUIRED")));
        }
        let key = format!("{}:house-rule:{house_rule_id}", change.idempotency_key);
        let derive = |fresh: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, RuleError> {
            let event = campaign_house_rule_change_event(house_rule_id, Some(enabled), Some(fresh), &options).map_err(|error| RuleError::new(error.code, error.message))?;
            Ok(event.into_iter().collect())
        };
        let metadata = |events: &[Value], _state: &Value, _loaded: &sk_store::Loaded| -> Value { campaign_house_rule_metadata(events.first()).unwrap_or_else(|_| json!({})) };
        let Some(committed) = commit_derived(core, campaign_id, &key, &derive, &metadata)? else { continue };
        let latest = core.events.load(campaign_id, &LoadOptions::default())?;
        let events = if committed.replayed { Vec::new() } else { committed.commit.events };
        persist_authoritative_projection(core, campaign_id, &latest.state, &events, None, PersistOptions::default())?;
        ruleset_state = latest.state;
        if !committed.replayed {
            let settings = campaign_ruleset_settings(Some(&ruleset_state), None, false).map_err(|error| Failure::new(error.message, Some(&error.code)))?;
            let rule = settings.get("houseRules").and_then(Value::as_array).and_then(|rules| rules.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(house_rule_id.as_str())));
            let label = rule.and_then(|rule| rule.get("label")).filter(|label| js::present(Some(label))).map_or_else(|| house_rule_id.clone(), |label| js::s(Some(label)));
            let description = rule.and_then(|rule| rule.get("description")).filter(|description| js::truthy(Some(description))).map_or_else(String::new, |description| format!(" {}.", js::s(Some(description))));
            let state_word = if js::truthy(Some(enabled)) { "включено" } else { "выключено" };
            crate::journal::append_room_journal(
                core,
                campaign_id,
                &[json!({
                    "id": format!("house-rule-{campaign_id}-{}", sk_core::clock::now_ms()),
                    "speaker": "system",
                    "author": SETTINGS_AUTHOR,
                    "text": format!("Домашнее правило «{label}» {state_word}.{description}"),
                })],
            )?;
        }
    }
    Ok(ruleset_state)
}

/// Строки летописи о смене режима и модели (4784–4797): не событие движка,
/// а запись комнаты — режим живёт в настройках, а не в состоянии.
fn settings_journal(campaign_id: &str, requested: &Requested, previous_improv_mode: &str, model_changed: bool) -> Vec<Value> {
    let mut entries = Vec::new();
    if requested.improv_mode != previous_improv_mode {
        if let Some(mode) = IMPROV_MODES.iter().find(|mode| mode.id == requested.improv_mode) {
            entries.push(json!({
                "id": format!("improv-mode-{campaign_id}-{}", sk_core::clock::now_ms()),
                "speaker": "system",
                "author": SETTINGS_AUTHOR,
                "text": format!("Режим импровизации изменён: {} — {}.", mode.label, mode.description),
            }));
        }
    }
    if model_changed {
        let level = REASONING_LEVELS.iter().find(|level| level.id == requested.reasoning).map_or("", |level| level.label);
        entries.push(json!({
            "id": format!("ai-model-{campaign_id}-{}", sk_core::clock::now_ms()),
            "speaker": "system",
            "author": SETTINGS_AUTHOR,
            "text": format!("Ведущий ИИ: {}, рассуждения — {}.", model_option_for(&requested.model, "").label, text::lower(level)),
        }));
    }
    entries
}

async fn patch_body(ctx: &mut RouteCtx, user: &Value, campaign_id: &str, room: Result<Room, Failure>) -> Result<Response<Body>, Caught> {
    let body = ctx.json_body().await?;
    // `eventStore.load` внутри `try`: несобранная комната — тот же отказ.
    room?;
    let loaded = {
        let campaign_id = campaign_id.to_string();
        ctx.state.core.call(move |core| Box::pin(async move { core.events.load(&campaign_id, &LoadOptions::default()).map(|loaded| loaded.state) })).await?.map_err(Failure::from)?
    };
    let current = stored_settings(&ctx.state, campaign_id).await.map_err(Caught::Reply)??;
    let requested = requested_settings(&ctx.state, &body, &current)?;
    let requested_ruleset_id = if body.get("rulesetId").is_none() && body.get("ruleset_id").is_none() {
        js::string(loaded.get("ruleset_id"))
    } else {
        let first = body.get("rulesetId");
        let chosen = if js::present(first) { first } else { body.get("ruleset_id") };
        text::trim(&js::string(chosen)).to_string()
    };
    let house_rules: Vec<(String, Value)> = match body.get("houseRules") {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(id, enabled)| (id.clone(), enabled.clone())).collect(),
        _ => Vec::new(),
    };
    let change = RulesetChange {
        campaign_id: campaign_id.to_string(),
        actor_id: user.get("id").cloned().unwrap_or(Value::Null),
        loaded_state: loaded,
        requested_ruleset_id,
        idempotency_key: crate::idempotency::key_nullish(&body, &ctx.headers),
        house_rules,
    };
    let ruleset_state = ctx.state.core.call(move |core| Box::pin(async move { change_ruleset(&core, &change) })).await??;
    let previous_improv_mode = normalize_improv_mode(Some(&Value::String(current.improv_mode.clone())));
    let to_save = CampaignAiSettings { model: requested.model.clone(), narrator_style: requested.style.clone(), improv_mode: requested.improv_mode.clone(), reasoning_level: requested.reasoning.clone() };
    let accounts = ctx.state.accounts.clone();
    let (settings_key, saving) = (campaign_id.to_string(), to_save.clone());
    let saved_value = blocking(move || accounts.save_campaign_ai_settings(&settings_key, &saving)).await??;
    let saved = saved_from(&saved_value, &to_save);
    let config = &ctx.state.config;
    let previous_model = if config.allowed_ai_models.contains(&current.model) { current.model.clone() } else { config.model.clone() };
    let current_reasoning = normalize_reasoning_level(Some(&Value::String(current.reasoning_level.clone())));
    let model_changed = requested.model != previous_model || requested.reasoning != current_reasoning;
    let entries = settings_journal(campaign_id, &requested, previous_improv_mode, model_changed);
    let journal_campaign = campaign_id.to_string();
    let ruleset_events = ctx
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                for entry in entries {
                    crate::journal::append_room_journal(&core, &journal_campaign, &[entry])?;
                }
                Ok::<_, Failure>(Value::Array(core.events.get_events(&journal_campaign, 0, None)?))
            })
        })
        .await??;
    let generations = generations_today(&ctx.state, campaign_id).await.map_err(Caught::Reply)?;
    let payload = settings_payload(&ctx.state, &saved, generations, true, &ruleset_state, &ruleset_events)?;
    Ok(json(StatusCode::OK, &payload))
}

/// Сохранённые настройки (`saveCampaignAiSettings` возвращает записанное).
fn saved_from(saved: &Value, fallback: &CampaignAiSettings) -> CampaignAiSettings {
    let field = |key: &str, fallback: &str| saved.get(key).and_then(Value::as_str).map_or_else(|| fallback.to_string(), str::to_string);
    CampaignAiSettings {
        model: field("model", &fallback.model),
        narrator_style: field("narratorStyle", &fallback.narrator_style),
        improv_mode: field("improvMode", &fallback.improv_mode),
        reasoning_level: field("reasoningLevel", &fallback.reasoning_level),
    }
}

/// `PATCH /api/campaigns/:id/settings` (4662–4803): только администратор и
/// владелец кампании.
async fn patch_settings(ctx: &mut RouteCtx) -> Result<Response<Body>, ApiError> {
    let user = require_user(ctx).await?;
    let campaign_id = ctx.param(0).to_uppercase();
    let room = get_room(&ctx.state, &campaign_id).await?;
    if room.as_ref().is_ok_and(|room| room.state.is_none()) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена"));
    }
    if !is_admin(&user) && !is_owner(&ctx.state, &user, &campaign_id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Настройки ИИ может менять только владелец кампании"));
    }
    match patch_body(ctx, &user, &campaign_id, room).await {
        Ok(response) => Ok(response),
        Err(Caught::Reply(error)) => Err(error),
        Err(Caught::Thrown(failure)) => Err(failure.respond_by(&[(CONFLICT_CODES, StatusCode::CONFLICT)], StatusCode::BAD_REQUEST)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_lines_follow_js_texts() {
        let requested = Requested { model: "openai/gpt-6-luna".into(), style: "neutral".into(), improv_mode: "chaos".into(), reasoning: "deep".into() };
        let entries = settings_journal("CODE", &requested, "story", true);
        let texts: Vec<&str> = entries.iter().filter_map(|entry| entry.get("text").and_then(Value::as_str)).collect();
        assert_eq!(texts, ["Режим импровизации изменён: Хаос — можно всё, мир подстраивается под выбор отряда.", "Ведущий ИИ: GPT-6 Luna, рассуждения — глубже."]);
        assert!(entries[0]["id"].as_str().is_some_and(|id| id.starts_with("improv-mode-CODE-")));
        assert!(entries[1]["id"].as_str().is_some_and(|id| id.starts_with("ai-model-CODE-")));
        assert!(settings_journal("CODE", &requested, "chaos", false).is_empty());
    }

    #[test]
    fn body_strings_like_js() {
        assert_eq!(trimmed(&Value::Null), "null");
        assert_eq!(lowered(&json!("  DEEP ")), "deep");
        assert_eq!(trimmed(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(trimmed(&json!(5)), "5");
    }
}
