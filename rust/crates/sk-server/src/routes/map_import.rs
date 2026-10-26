//! С13: импорт и перестройка карт — `POST /api/campaigns/:id/map-import`
//! (`server/routes/map-import-routes.mjs`, подключение — `index.mjs:3960`,
//! сборка — 352–361).
//!
//! Один маршрут, три режима тела:
//!
//! - `mode: 'rebuild'` — команда `RebuildLocationMap` (перестройка карты
//!   текущей сцены по программе или, с `preserve_layout: true`, только
//!   покрытий этажей);
//! - `mode: 'apply'` — команда `ImportLocationMap` со слэбом TaleSpire;
//! - любой другой — предпросмотр: разбор слэба без записи (тот же
//!   `importTaleSpireSlab`, что зовёт движок при применении).
//!
//! Метод проверяет сам маршрут: **любой** метод, кроме POST (и GET, и HEAD),
//! — 405 `{ error: 'Метод не поддерживается' }` (поправка рецензии №9), ещё
//! до входа. Совпадение — по `pathname` (`requestPath`), строка запроса не
//! мешает.
//!
//! Полномочие ведущего передаётся движку флагом контекста
//! `mapImportAuthorized`, который ставит только этот маршрут; права (админ
//! или владелец кампании), бой, голосование отряда — в Rules Engine и здесь,
//! открытая проверка героя — по реестру бросков ядра.
//!
//! Обработка ошибок повторяет `try/catch` JS: `requireUser` вне `try`;
//! исключение с кодом-строкой — 409 для [`CONFLICT_CODES`], иначе 400
//! `{ error, code }`; без кода (`TypeError` и т. п.) — мимо `catch`, 500
//! `INTERNAL_ERROR` последней границы. `String(x)` полей тела — строго, как
//! JS: объект со своим `toString` (`{"toString":1}`) бросает `TypeError`
//! ([`js_string`]).
//!
//! Журнал, реестр бросков и движок — в ядре одним заданием на режим;
//! разбор слэба для предпросмотра — в блокирующем пуле (ядру состояние
//! кампании не нужно, а разбор слэба на 400 000 клеток долгий); аккаунты —
//! через [`blocking`]. Строки обрезаются по единицам UTF-16, как `slice` JS.
//!
//! [`install`] — проводка процесса (`index.mjs:353–357`): импортёр TaleSpire
//! для движка (`sk_rules::merchants::install_talespire_importer`, как у
//! `sk-corpus`) и библиотека готовых карт по `DND_MAP_LIBRARY=on`.

use std::rc::Rc;
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use sk_core::js;
use sk_store::executor::AuthoritativeExecutor;
use sk_store::CommitResult;

use crate::access::{campaign_hero_ids, require_user, viewer_state_for};
use crate::config::Config;
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::projection::{executor_failure, persist_authoritative_projection, with_rules_plan, HookedJournal, PersistOptions};
use crate::room::{self, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/map-import$/u` по `requestPath`;
    // метод — в обработчике (405 на любой, кроме POST).
    vec![Route::new(3960, Methods::Any, Matcher::path_template("/api/campaigns/{id}/map-import"), map_import)]
}

/// `CONFLICT_CODES` (`map-import-routes.mjs:27`): эти коды — 409, прочие — 400.
pub const CONFLICT_CODES: [&str; 6] = ["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "MAP_IMPORT_DURING_COMBAT", "MAP_REBUILD_DURING_COMBAT", "MAP_REBUILD_DECISION_OPEN", "MAP_REBUILD_CHECK_OPEN"];

/// Форматы источника у событий перестройки (`map-import-routes.mjs:87`).
const REBUILD_FORMATS: [&str; 2] = ["scene-program-rebuild", "scene-floor-refresh"];

const READ_ONLY: &str = "Завершённая или архивная кампания доступна только для чтения";

/// Проводка процесса (`index.mjs:353–357`): импортёр слэба для движка и
/// глобальная библиотека карт (`setActiveMapLibrary`: включена только при
/// `DND_MAP_LIBRARY=on`, иначе снята — как у JS при каждом старте).
pub fn install(config: &Config) {
    sk_rules::merchants::install_talespire_importer(import_for_engine);
    let library = config.map_library.then(|| Arc::new(sk_story::map_library::MapLibrary::new(&config.storage_dir)));
    sk_story::map_library::set_active_map_library(library);
}

/// `importTaleSpireSlab(slab, { locationId, theme })` для движка.
fn import_for_engine(slab: Option<&str>, location_id: &str, theme: &str) -> Result<Value, sk_rules::merchants::TaleSpireFailure> {
    import_slab(slab, location_id, theme).map_err(|error| sk_rules::merchants::TaleSpireFailure { name: error.name, code: error.code, message: error.message })
}

fn import_slab(slab: Option<&str>, location_id: &str, theme: &str) -> Result<Value, sk_talespire::talespire_import::TaleSpireImportError> {
    let options = sk_talespire::talespire_import::ImportOptions { location_id: location_id.to_string(), theme: theme.to_string(), ..Default::default() };
    sk_talespire::talespire_import::import_talespire_slab(slab, &options)
}

// --- приведения JS ------------------------------------------------------------

/// `TypeError` приведения к строке: кода нет, поэтому `catch` маршрута его
/// не ловит (500 на границе).
fn primitive_error() -> Failure {
    Failure::new("Cannot convert object to primitive value", None)
}

/// `String(value)` для значения из JSON. Функций в JSON нет, поэтому объект со
/// своим полем `toString` не приводится (`toString` не вызывается, `valueOf`
/// возвращает объект) — `TypeError`; массив — `join(',')` с тем же правилом
/// для элементов, `null` в нём — пустая строка.
fn js_string(value: &Value) -> Result<String, Failure> {
    match value {
        Value::Object(map) if map.contains_key("toString") => Err(primitive_error()),
        Value::Array(items) => {
            let parts: Result<Vec<String>, Failure> = items.iter().map(|item| if item.is_null() { Ok(String::new()) } else { js_string(item) }).collect();
            Ok(parts?.join(","))
        }
        other => Ok(js::string(Some(other))),
    }
}

/// `String(a ?? b ?? '')`.
fn js_string_nullish(values: &[Option<&Value>]) -> Result<String, Failure> {
    match values.iter().flatten().find(|value| !value.is_null()) {
        Some(value) => js_string(value),
        None => Ok(String::new()),
    }
}

/// `text.slice(0, limit)` по единицам UTF-16.
fn slice_utf16(text: &str, limit: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(limit + 1).collect();
    if units.len() <= limit {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[..limit])
}

/// `String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim().slice(0, 200)`.
fn idempotency_key(body: &Value, ctx: &RouteCtx) -> Result<String, Failure> {
    let header = crate::http::has_header(&ctx.headers, "x-idempotency-key").then(|| Value::String(ctx.header("x-idempotency-key")));
    let raw = js_string_nullish(&[body.get("idempotency_key"), header.as_ref()])?;
    Ok(slice_utf16(sk_core::text::trim(&raw), 200))
}

fn key_required() -> ApiError {
    ApiError::coded(StatusCode::BAD_REQUEST, "Нужен idempotency_key", "IDEMPOTENCY_KEY_REQUIRED")
}

/// `createHash('sha256').update(text).digest('hex').slice(0, 24)`.
fn digest24(text: &str) -> String {
    sk_core::text::head(&sk_core::hash::sha256_hex(text), 24)
}

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

/// `committed.events.find((event) => event?.event_type === 'LocationMapImported')`.
fn imported_event(events: &[Value]) -> Option<&Value> {
    events.iter().find(|event| event.get("event_type").and_then(Value::as_str) == Some("LocationMapImported"))
}

fn payload_field<'a>(event: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    event.and_then(|event| event.get("payload")).and_then(|payload| payload.get(key))
}

/// `event?.payload?.warnings ?? []`.
fn warnings_of(event: Option<&Value>) -> Value {
    payload_field(event, "warnings").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]))
}

// --- ядро ---------------------------------------------------------------------

/// `getRoom(code)` в ядре.
async fn get_room(state: &AppState, code: &str) -> Result<Room, Caught> {
    let code = code.to_string();
    Ok(state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await??)
}

/// Итог команды карты для ответа.
struct Committed {
    duplicate: bool,
    /// `projected?.state ?? committed.state`.
    state: Value,
    /// `projected?.version` (`None` — проекции нет, ответ берёт `room.version`).
    version: Option<i64>,
    /// Событие `LocationMapImported` коммита.
    event: Option<Value>,
}

/// Повтор ключа: найденный коммит сверяется с режимом запроса
/// (`same_intent`), чужой — 409 с текстом режима.
type SameIntent = Box<dyn FnOnce(Option<&Value>) -> bool + Send>;

/// Тело задания ядра (`map-import-routes.mjs:83–111`, 155–182): сверка ключа,
/// команда через общий исполнитель с `mapImportAuthorized`, проекция с
/// обновлением проектора (повтор ничего не пишет и отдаёт комнату как есть).
fn execute(core: &Rc<GameCore>, campaign_id: &str, idempotency_key: &str, command: Value, same_intent: SameIntent, conflict: &str) -> Result<Committed, Caught> {
    if let Some(previous) = core.events.get_by_idempotency_key(campaign_id, idempotency_key).map_err(Failure::from)? {
        if !same_intent(imported_event(&previous.events)) {
            return Err(ApiError::coded(StatusCode::CONFLICT, conflict, "IDEMPOTENCY_CONFLICT").into());
        }
    }
    let journal = HookedJournal(&core.events);
    let context = json!({ "mapImportAuthorized": true });
    let executed = with_rules_plan(core, |resolve| AuthoritativeExecutor::new(&journal).execute_commands(campaign_id, idempotency_key, &[command], &context, resolve)).map_err(executor_failure)?;
    let duplicate = executed.replayed || executed.commit.duplicate;
    let CommitResult { state: committed_state, events, .. } = executed.commit;
    let (state, version) = if duplicate {
        let current = room::get_room(core, campaign_id)?;
        (current.state.unwrap_or(committed_state), Some(current.version))
    } else {
        let projected = persist_authoritative_projection(core, campaign_id, &committed_state, &events, None, PersistOptions { force_projector_refresh: true, await_projection: false })?;
        match projected {
            Some(room) => (room.state.unwrap_or(committed_state), Some(room.version)),
            None => (committed_state, None),
        }
    };
    let event = imported_event(&events).cloned();
    Ok(Committed { duplicate, state, version, event })
}

/// `viewerStateFor(responseState, user, actorId)`, где актор — первый свой
/// герой, который есть в `responseState.players`.
async fn viewer_state(state: &AppState, user: &Value, campaign_id: &str, response_state: &Value) -> Result<Value, Caught> {
    let accounts = state.accounts.clone();
    let (viewer, campaign) = (user.clone(), campaign_id.to_string());
    let hero_ids = blocking(move || campaign_hero_ids(&accounts, &viewer, &campaign)).await??;
    let players = response_state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let actor_id = hero_ids.into_iter().find(|id| players.iter().any(|player| js::string(player.get("id")) == *id)).unwrap_or_default();
    Ok(viewer_state_for(response_state, user, Some(&Value::String(actor_id)))?.unwrap_or(Value::Null))
}

// --- маршрут --------------------------------------------------------------------

fn map_import(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        if ctx.method != Method::POST {
            return Err(ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "Метод не поддерживается"));
        }
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        match handle(ctx, &user, &campaign_id).await {
            Ok(response) => Ok(response),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => match failure.code {
                // `const known = … || typeof code === 'string'; if (!known) throw error`.
                None => Err(ApiError::from(failure)),
                Some(_) => Err(failure.respond_by(&[(&CONFLICT_CODES, StatusCode::CONFLICT)], StatusCode::BAD_REQUEST)),
            },
        }
    })
}

/// Тело `try` (`map-import-routes.mjs:63–193`).
async fn handle(ctx: &mut RouteCtx, user: &Value, campaign_id: &str) -> Result<Response, Caught> {
    let room = get_room(&ctx.state, campaign_id).await?;
    let Some(state) = room.state.clone().filter(js_truthy) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена").into());
    };
    if !is_admin(user) {
        let accounts = ctx.state.accounts.clone();
        let (user_id, campaign) = (js::s(user.get("id")), campaign_id.to_string());
        let membership = blocking(move || accounts.campaign_membership_for(&user_id, &campaign)).await??;
        if membership.as_ref().and_then(|membership| membership.get("role")).and_then(Value::as_str) != Some("owner") {
            return Err(ApiError::coded(StatusCode::FORBIDDEN, "Загружать карту может только ведущий кампании", "MAP_IMPORT_FORBIDDEN").into());
        }
    }
    // `readBody` отказывает сам (не объект — `INVALID_JSON_BODY`); ошибка
    // тела — в `try`, то есть 400 с её кодом.
    let body = ctx.json_body().await?;
    if body.get("mode").and_then(Value::as_str) == Some("rebuild") {
        return rebuild(ctx, user, campaign_id, &room, &state, &body).await;
    }
    import(ctx, user, campaign_id, &room, &state, &body).await
}

/// `!room?.state`.
fn js_truthy(value: &Value) -> bool {
    js::truthy(Some(value))
}

/// `mode: 'rebuild'` (`map-import-routes.mjs:73–123`).
async fn rebuild(ctx: &RouteCtx, user: &Value, campaign_id: &str, room: &Room, state: &Value, body: &Value) -> Result<Response, Caught> {
    if sk_director::campaign_lifecycle::campaign_is_read_only(state) {
        return Err(ApiError::coded(StatusCode::CONFLICT, READ_ONLY, "CAMPAIGN_READ_ONLY").into());
    }
    // `hasOpenCheck(campaignId, Number(state.state_version))`; ключ тела
    // приводится в JS после этой проверки, поэтому `TypeError` ключа — тоже после.
    let options = json!({ "campaignId": campaign_id, "stateVersion": js::num(js::number(state.get("state_version"))) });
    let open = ctx.state.core.call(move |core| Box::pin(async move { core.rolls.borrow_mut().has_open_check(&options) })).await?.map_err(Failure::from)?;
    if open {
        return Err(ApiError::coded(StatusCode::CONFLICT, "Сначала завершите открытую проверку героя", "MAP_REBUILD_CHECK_OPEN").into());
    }
    let idempotency_key = idempotency_key(body, ctx)?;
    if idempotency_key.is_empty() {
        return Err(key_required().into());
    }
    let text = body.get("text").and_then(Value::as_str).map(|text| slice_utf16(text, 2_000)).unwrap_or_default();
    let preserve_layout = body.get("preserve_layout") == Some(&Value::Bool(true));
    let command = json!({
        "command_type": "RebuildLocationMap",
        "command_id": format!("map-rebuild:{}", digest24(&format!("{campaign_id}\0{idempotency_key}"))),
        "text": text,
        "preserve_layout": preserve_layout,
    });
    let same_intent: SameIntent = Box::new(move |recorded| {
        let Some(recorded) = recorded else { return false };
        let format = js_string_nullish(&[payload_field(Some(recorded), "source").and_then(|source| source.get("format"))]).unwrap_or_default();
        REBUILD_FORMATS.contains(&format.as_str()) && (payload_field(Some(recorded), "preserve_layout") == Some(&Value::Bool(true))) == preserve_layout
    });
    let job = (campaign_id.to_string(), idempotency_key);
    let committed = ctx
        .state
        .core
        .call(move |core| Box::pin(async move { execute(&core, &job.0, &job.1, command, same_intent, "Этот idempotency_key уже использован для другого режима перестройки") }))
        .await??;
    let viewer = viewer_state(&ctx.state, user, campaign_id, &committed.state).await?;
    let event = committed.event.as_ref();
    let mut reply = Map::new();
    reply.insert("mode".into(), json!("rebuild"));
    reply.insert("preserve_layout".into(), Value::Bool(payload_field(event, "preserve_layout") == Some(&Value::Bool(true))));
    reply.insert("duplicate".into(), Value::Bool(committed.duplicate));
    reply.insert("warnings".into(), warnings_of(event));
    reply.insert("version".into(), Value::from(committed.version.unwrap_or(room.version)));
    reply.insert("state".into(), viewer);
    Ok(json(StatusCode::OK, &Value::Object(reply)))
}

/// Предпросмотр и `mode: 'apply'` (`map-import-routes.mjs:124–192`).
async fn import(ctx: &RouteCtx, user: &Value, campaign_id: &str, room: &Room, state: &Value, body: &Value) -> Result<Response, Caught> {
    let slab = body.get("slab").and_then(Value::as_str).unwrap_or_default().to_string();
    if sk_core::text::trim(&slab).is_empty() {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Вставьте строку слэба TaleSpire", "SLAB_EMPTY").into());
    }
    if slab.encode_utf16().count() > slab_max_text_length() {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Слэб длиннее, чем допускает TaleSpire", "SLAB_TOO_LARGE").into());
    }
    let current_location_id = sk_director::adventure_director::memory::scene_location_id(state);
    let requested = slice_utf16(sk_core::text::trim(&js_string_nullish(&[body.get("location_id")])?), 120);
    let location_id = if requested.is_empty() { current_location_id.clone() } else { requested };
    let location = sk_geometry::world_map::world_location_by_id(state.get("worldMap"), &location_id);
    let current = location_id == current_location_id;
    if location_id.is_empty() || (!current && location.is_none()) {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Такой локации нет на карте мира кампании", "MAP_IMPORT_LOCATION_UNKNOWN").into());
    }
    // `String(location?.name ?? (current ? state.scene?.location : '') ?? locationId).slice(0, 120) || locationId`.
    let scene_location = if current { state.get("scene").and_then(|scene| scene.get("location")) } else { None };
    let fallback = if current { None } else { Some(Value::String(String::new())) };
    let location_id_value = Value::String(location_id.clone());
    let name_source = [location.and_then(|location| location.get("name")), scene_location.or(fallback.as_ref()), Some(&location_id_value)];
    let name = slice_utf16(&js_string_nullish(&name_source)?, 120);
    let mut location_info = Map::new();
    location_info.insert("id".into(), Value::String(location_id.clone()));
    location_info.insert("name".into(), Value::String(if name.is_empty() { location_id.clone() } else { name }));
    location_info.insert("current".into(), Value::Bool(current));

    if body.get("mode").and_then(Value::as_str) != Some("apply") {
        let theme = if current { slice_utf16(&js_string_nullish(&[state.get("scene").and_then(|scene| scene.get("theme"))])?, 60) } else { String::new() };
        let (slab_text, location) = (slab, location_id);
        let preview = blocking(move || import_slab(Some(&slab_text), &location, &theme)).await?.map_err(|error| Failure::new(error.message, Some(&error.code)))?;
        let mut reply = Map::new();
        reply.insert("mode".into(), json!("preview"));
        reply.insert("location".into(), Value::Object(location_info));
        if let Value::Object(fields) = preview {
            reply.extend(fields);
        }
        return Ok(json(StatusCode::OK, &Value::Object(reply)));
    }

    // Пауза не мешает: ведущему удобно готовить карты, пока кампания стоит.
    if sk_director::campaign_lifecycle::campaign_is_read_only(state) {
        return Err(ApiError::coded(StatusCode::CONFLICT, READ_ONLY, "CAMPAIGN_READ_ONLY").into());
    }
    let idempotency_key = idempotency_key(body, ctx)?;
    if idempotency_key.is_empty() {
        return Err(key_required().into());
    }
    // Повтор того же ключа с другим слэбом — не повтор, а ошибка клиента.
    let slab_hash = sk_core::hash::sha256_hex(&slab);
    let expected_location = location_id.clone();
    let same_intent: SameIntent = Box::new(move |recorded| {
        let Some(recorded) = recorded else { return false };
        payload_field(Some(recorded), "source").and_then(|source| source.get("sha256")).and_then(Value::as_str) == Some(slab_hash.as_str())
            && payload_field(Some(recorded), "location_id").and_then(Value::as_str) == Some(expected_location.as_str())
    });
    let command = json!({
        "command_type": "ImportLocationMap",
        "command_id": format!("map-import:{}", digest24(&format!("{campaign_id}\0{idempotency_key}"))),
        "location_id": location_id,
        "slab": slab,
    });
    let job = (campaign_id.to_string(), idempotency_key);
    let committed = ctx
        .state
        .core
        .call(move |core| Box::pin(async move { execute(&core, &job.0, &job.1, command, same_intent, "Этот idempotency_key уже использован для другого импорта") }))
        .await??;
    let viewer = viewer_state(&ctx.state, user, campaign_id, &committed.state).await?;
    let event = committed.event.as_ref();
    let levels: Vec<Value> = payload_field(event, "levels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .map(|level| {
                    // `({ index: level.index, label: level.label })`: `undefined` в JSON не попадает.
                    let mut entry = Map::new();
                    for key in ["index", "label"] {
                        if let Some(value) = level.get(key) {
                            entry.insert(key.into(), value.clone());
                        }
                    }
                    Value::Object(entry)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut reply = Map::new();
    reply.insert("mode".into(), json!("apply"));
    reply.insert("location".into(), Value::Object(location_info));
    reply.insert("duplicate".into(), Value::Bool(committed.duplicate));
    reply.insert("applied_to_scene".into(), Value::Bool(payload_field(event, "applied_to_scene") == Some(&Value::Bool(true))));
    reply.insert("levels".into(), Value::Array(levels));
    reply.insert("warnings".into(), warnings_of(event));
    reply.insert("version".into(), Value::from(committed.version.unwrap_or(room.version)));
    reply.insert("state".into(), viewer);
    Ok(json(StatusCode::OK, &Value::Object(reply)))
}

/// `SLAB_MAX_TEXT_LENGTH` (`talespire-slab.mjs`).
fn slab_max_text_length() -> usize {
    sk_rules::command::types::SLAB_MAX_TEXT_LENGTH
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_follows_to_primitive() {
        assert_eq!(js_string(&json!("a")).ok(), Some("a".into()));
        assert_eq!(js_string(&json!(5)).ok(), Some("5".into()));
        assert_eq!(js_string(&json!({})).ok(), Some("[object Object]".into()));
        assert_eq!(js_string(&json!({ "valueOf": 1 })).ok(), Some("[object Object]".into()));
        assert_eq!(js_string(&json!([1, null, "x", [2, 3]])).ok(), Some("1,,x,2,3".into()));
        assert!(js_string(&json!({ "toString": 1 })).is_err());
        assert!(js_string(&json!([{ "toString": null }])).is_err());
        assert_eq!(js_string_nullish(&[None, Some(&Value::Null), Some(&json!("k"))]).ok(), Some("k".into()));
    }

    #[test]
    fn utf16_slice() {
        assert_eq!(slice_utf16("абв", 2), "аб");
        assert_eq!(slice_utf16("ab", 5), "ab");
        assert_eq!(slice_utf16("a😀b", 2), "a\u{fffd}");
    }
}
