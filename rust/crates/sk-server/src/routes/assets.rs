//! С12: ассеты и картинки — `server/index.mjs`:
//!
//! - `GET /api/campaigns/:id/npcs/:npc/portrait` (4028–4065): заглушка — 302,
//!   портрет из кеша или свежий — файл с `ETag`, заголовки `X-NPC-Portrait-*`;
//! - `GET /api/campaigns/:id/locations/:loc/illustration` (4067–4099): только
//!   кеш, модель не зовётся ни при каком флаге;
//! - `GET`/`POST /api/campaigns/:id/asset-preparation` (4103–4172): список
//!   пробелов и подготовка заранее, независимо от рантайм-флага;
//! - `GET /generated/items/:file` (сырой префикс, 6114; строка запроса
//!   допускается — `split('?')`);
//! - `POST /api/items/generate-image` (сырой адрес, 6118): лимит 10 на
//!   пользователя, резерв в учёте расхода до запроса к поставщику (429
//!   `LLM_QUOTA_EXCEEDED` — до провайдера), закрытие резерва расходом или
//!   неудачей (`generateItemImage`, 2962–2995).
//!
//! Маршруты объявлены с номером строки `server/index.mjs`, где JS проверяет
//! метод: порядок общей таблицы выводится из этих номеров.
//!
//! Картинки — только через [`Images`] из `AppState`: сервисы портретов и
//! иллюстраций получают учёт расхода, генераторы предметов закрыты в
//! [`ItemImages`], у которого нет пути к поставщику мимо резерва (AGENTS §5:
//! «весь вызов модели и картинок идёт через учёт расхода»). Собираются они
//! только в `state.rs`.
//!
//! Комната и журнал — в ядре; права (аккаунты) — в блокирующем потоке;
//! сервисы картинок (файлы, сеть) — в обработчике.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use serde_json::{json, Map, Value};
use sk_chargen::location_illustrations::{location_illustration_inventory, visible_campaign_locations, visible_location_profile, LocationIllustrationService};
use sk_chargen::npc_portraits::{npc_portrait_significance, public_npc_portrait_profile, visible_npc_portrait_profile, NpcPortraitRequest, NpcPortraitResult, NpcPortraitService, NPC_PORTRAIT_GENERATION_LIMIT};
use sk_core::js;
use sk_infra::asset_preparation::{items_without_illustration, npc_portrait_inventory, plan_preparation, ASSET_PREPARATION_POLICY_ID, MAX_PREPARATION_BATCH};
use sk_infra::image_generation::RouterImageGenerator;
use sk_infra::usage_ledger::{DurableUsageLedger, ReserveRequest};

use crate::access::{can_access_room, can_manage_campaign_assets, owned_viewer_actor_id, require_user, viewer_state_for};
use crate::core::blocking;
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, ApiResult, Failure};
use crate::files::{serve_generated, serve_generated_image, serve_static_portrait, CachedImage};
use crate::http::json;
use crate::projection::latest_campaign_state;
use crate::room::{self, Room};
use crate::state::AppState;

const ASSET_METHODS: &[Method] = &[Method::GET, Method::POST];

pub fn routes() -> Vec<Route> {
    vec![
        // `parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/npcs\/([^/]+)\/portrait$/)` и `GET` (4029–4030).
        Route::get(4030, Matcher::path_template("/api/campaigns/{id}/npcs/{seg}/portrait"), npc_portrait),
        // `.../locations/([^/]+)/illustration$/` и `GET` (4068–4069).
        Route::get(4069, Matcher::path_template("/api/campaigns/{id}/locations/{seg}/illustration"), location_illustration),
        // `.../asset-preparation$/` и `GET || POST` (4103–4104).
        Route::new(4104, Methods::Set(ASSET_METHODS), Matcher::path_template("/api/campaigns/{id}/asset-preparation"), asset_preparation),
        // `req.url?.startsWith('/generated/items/') && req.method === 'GET'` (6115).
        Route::get(6115, Matcher::raw_prefix("/generated/items/"), generated_item_file),
        // `req.url === '/api/items/generate-image' && req.method === 'POST'` (6119).
        Route::post(6119, Matcher::raw("/api/items/generate-image"), generate_item_image_route),
    ]
}

// --- картинки процесса ----------------------------------------------------

/// Картинки процесса: сервисы портретов и иллюстраций (`index.mjs:254–270`) и
/// генераторы предметов (2972–2975). Все — через учёт расхода.
pub struct Images {
    pub portraits: NpcPortraitService,
    pub illustrations: LocationIllustrationService,
    pub items: ItemImages,
}

/// Оценка выхода картинки предмета (`ITEM_IMAGE_ESTIMATED_OUTPUT_TOKENS`).
const ITEM_IMAGE_ESTIMATED_OUTPUT_TOKENS: usize = 1_024;

/// Генераторы картинок предметов 1:1 и 16:9. Поля закрыты: поставщик
/// достижим только через [`ItemImages::generate`], а он резервирует расход
/// до запроса и закрывает резерв в любом исходе.
pub struct ItemImages {
    square: RouterImageGenerator,
    wide: RouterImageGenerator,
    ledger: Arc<DurableUsageLedger>,
    model: String,
    directory: PathBuf,
}

impl ItemImages {
    /// Генераторы `'1:1'` и `'16:9'`, учёт расхода, модель и каталог
    /// `storage/generated/items`.
    pub fn new(square: RouterImageGenerator, wide: RouterImageGenerator, ledger: Arc<DurableUsageLedger>, model: String, directory: PathBuf) -> Self {
        Self { square, wide, ledger, model, directory }
    }

    /// Каталог файлов картинок предметов.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// `generateItemImage(prompt, aspectRatio)` (2963–2996): ответ
    /// `{ url, model, cost }` или ошибка с `code` (`LLM_QUOTA_EXCEEDED` —
    /// отказ резерва до запроса).
    pub async fn generate(&self, prompt: &Value, aspect_ratio: &str) -> Result<Value, Failure> {
        let image_prompt = format!(
            "Fantasy tabletop RPG inventory illustration. {}. No text, letters, logo, watermark, UI or characters.",
            crate::merchant_guard::slice_utf16(&js::string(Some(prompt)), 1600)
        );
        let reservation = self.ledger.reserve(&ReserveRequest {
            request_id: Some(format!("item-image:{}", sk_core::hash::uuid_v4())),
            estimated_tokens: (image_prompt.len() + ITEM_IMAGE_ESTIMATED_OUTPUT_TOKENS) as f64,
            scope: Some("item-image".into()),
            model: Some(self.model.clone()),
        })?;
        let request_id = js::s(reservation.get("request_id"));
        let generator = if aspect_ratio == "16:9" { &self.wide } else { &self.square };
        let generated = match generator.generate(&image_prompt, &self.model).await {
            Ok(generated) => generated,
            Err(error) => {
                let code = crate::merchant_guard::slice_utf16(error.name(), 80);
                self.ledger.fail(&request_id, Some(&code), None)?;
                return Err(Failure::new(error.to_string(), None));
            }
        };
        self.ledger.settle(&request_id, Some(&Value::Object(generated.usage.clone())))?;
        let filename = format!("{}.webp", sk_core::hash::uuid_v4());
        let file = self.directory.join(&filename);
        tokio::fs::write(&file, &generated.bytes).await.map_err(|error| Failure::new(format!("{error}, open '{}'", file.display()), None))?;
        let mut result = Map::new();
        result.insert("url".into(), Value::String(format!("/generated/items/{filename}")));
        result.insert("model".into(), Value::String(self.model.clone()));
        if let Some(cost) = generated.usage.get("cost") {
            result.insert("cost".into(), cost.clone());
        }
        Ok(Value::Object(result))
    }
}

// --- общее ------------------------------------------------------------------

/// `getRoom(campaignId)` — вне `try` маршрутов: сбой — 500 границы.
async fn get_room(state: &AppState, code: &str) -> ApiResult<Room> {
    let code = code.to_string();
    Ok(state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await??)
}

/// `latestCampaignState(campaignId, room.state)`.
async fn authoritative_state(state: &AppState, code: &str, room: &Room) -> Result<Value, Failure> {
    let code = code.to_string();
    let fallback = room.state.clone();
    state.core.call(move |core| Box::pin(async move { latest_campaign_state(&core, &code, fallback.as_ref()) })).await?
}

/// `canAccessRoom(user, room)` в блокирующем потоке.
async fn room_access(state: &AppState, user: &Value, room: &Room) -> ApiResult<bool> {
    let accounts = state.accounts.clone();
    let (user, room) = (user.clone(), room.clone());
    Ok(blocking(move || can_access_room(&accounts, Some(&user), &room)).await??)
}

/// Проекция зрителя-игрока (4041–4044, 4079–4085): герой — первый из героев
/// пользователя в кампании, который есть среди игроков журнала.
async fn player_projection(state: &AppState, user: &Value, code: &str, authoritative: &Value) -> Result<Value, Failure> {
    let accounts = state.accounts.clone();
    let (checked_user, checked_code, checked_state) = (user.clone(), code.to_string(), authoritative.clone());
    let actor_id = blocking(move || owned_viewer_actor_id(&accounts, &checked_state, &checked_user, &checked_code)).await??;
    Ok(viewer_state_for(authoritative, user, Some(&Value::String(actor_id)))?.unwrap_or(Value::Null))
}

/// Номер 404 «Кампания не найдена».
fn campaign_not_found() -> ApiError {
    ApiError::coded(StatusCode::NOT_FOUND, "Кампания не найдена", "CAMPAIGN_NOT_FOUND")
}

// --- портрет NPC ----------------------------------------------------------

fn npc_portrait(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let invalid = || ApiError::coded(StatusCode::BAD_REQUEST, "Некорректный npc_id", "INVALID_NPC_ID");
        let npc_id = crate::url::decode_uri_component(ctx.param(1)).ok_or_else(invalid)?;
        if npc_id.is_empty() || npc_id.encode_utf16().count() > 120 {
            return Err(invalid());
        }
        let state = ctx.state.clone();
        let room = get_room(&state, &campaign_id).await?;
        if room.state.is_none() {
            return Err(campaign_not_found());
        }
        if !room_access(&state, &user, &room).await? {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
        }
        let failed = || ApiError::coded(StatusCode::BAD_GATEWAY, "Не удалось подготовить портрет NPC", "NPC_PORTRAIT_FAILED");
        // Всё ниже — `try` JS: любой сбой — 502.
        let outcome: Result<Option<ApiResult>, Failure> = async {
            let authoritative = authoritative_state(&state, &campaign_id, &room).await?;
            let projected = player_projection(&state, &user, &campaign_id, &authoritative).await?;
            let Some(profile) = visible_npc_portrait_profile(&projected, Some(&Value::String(npc_id.clone()))) else {
                return Ok(Some(Err(ApiError::coded(StatusCode::NOT_FOUND, "NPC не найден", "NPC_NOT_VISIBLE"))));
            };
            let rate_key = format!("npc-portrait:{}", js::s(user.get("id")));
            let limits = &state.limits;
            let allow = move || !limits.exceeds_rate(&rate_key, NPC_PORTRAIT_GENERATION_LIMIT as usize, None);
            let request = NpcPortraitRequest {
                campaign_id: &campaign_id,
                profile: &profile,
                projected_state: &projected,
                allow_generation: &allow,
                generation_enabled: state.config.runtime_image_generation,
            };
            let portrait = state.images.portraits.resolve(request).await.map_err(|error| Failure::new(error.to_string(), error.code()))?;
            let response = match &portrait {
                NpcPortraitResult::RateLimited => {
                    return Ok(Some(Err(ApiError::coded(
                        StatusCode::TOO_MANY_REQUESTS,
                        "Слишком много запросов генерации портретов. Подождите немного и повторите попытку",
                        "NPC_PORTRAIT_RATE_LIMITED",
                    ))))
                }
                NpcPortraitResult::Static(portrait) => serve_static_portrait(portrait, &js::s(profile.get("id"))),
                NpcPortraitResult::Generated(portrait) => {
                    serve_generated_image(&ctx.headers, CachedImage { file_path: &portrait.file_path, etag: &portrait.etag, cache_hit: portrait.cache_hit }, "X-NPC-Portrait", "private, max-age=3600").await
                }
            };
            Ok(response.ok().map(Ok))
        }
        .await;
        match outcome {
            Ok(Some(result)) => result,
            _ => Err(failed()),
        }
    })
}

// --- иллюстрация места ----------------------------------------------------

fn location_illustration(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let location_id = crate::url::decode_uri_component(ctx.param(1)).ok_or_else(|| ApiError::coded(StatusCode::BAD_REQUEST, "Некорректный location_id", "INVALID_LOCATION_ID"))?;
        let state = ctx.state.clone();
        let room = get_room(&state, &campaign_id).await?;
        if room.state.is_none() {
            return Err(campaign_not_found());
        }
        if !room_access(&state, &user, &room).await? {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
        }
        let outcome: Result<Option<ApiResult>, Failure> = async {
            let authoritative = authoritative_state(&state, &campaign_id, &room).await?;
            // Видимость решает проекция зрителя: локация, которую этот игрок
            // ещё не должен знать, здесь не существует.
            let projected = player_projection(&state, &user, &campaign_id, &authoritative).await?;
            let Some(location) = visible_location_profile(&projected, Some(&Value::String(location_id.clone()))) else {
                return Ok(Some(Err(ApiError::coded(StatusCode::NOT_FOUND, "Локация не найдена", "LOCATION_NOT_VISIBLE"))));
            };
            let cached = state.images.illustrations.cached(&campaign_id, location.get("id").unwrap_or(&Value::Null)).await.map_err(|error| Failure::new(error.to_string(), error.code()))?;
            let Some(illustration) = cached else {
                return Ok(Some(Err(ApiError::coded(StatusCode::NOT_FOUND, "Иллюстрация ещё не подготовлена", "LOCATION_ILLUSTRATION_ABSENT"))));
            };
            // `no-cache`: адрес иллюстрации один на всю жизнь локации, после
            // перегенерации браузер обязан переспросить (ETag отвечает 304).
            let image = CachedImage { file_path: &illustration.file_path, etag: &illustration.etag, cache_hit: illustration.cache_hit };
            Ok(serve_generated_image(&ctx.headers, image, "X-Location-Illustration", "private, no-cache").await.ok().map(Ok))
        }
        .await;
        match outcome {
            Ok(Some(result)) => result,
            _ => Err(ApiError::coded(StatusCode::BAD_GATEWAY, "Не удалось отдать иллюстрацию локации", "LOCATION_ILLUSTRATION_FAILED")),
        }
    })
}

// --- подготовка ассетов ---------------------------------------------------

fn asset_preparation(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let state = ctx.state.clone();
        let room = get_room(&state, &campaign_id).await?;
        if room.state.is_none() {
            return Err(campaign_not_found());
        }
        let accounts = state.accounts.clone();
        let (checked_user, checked_room) = (user.clone(), room.clone());
        if !blocking(move || can_manage_campaign_assets(&accounts, Some(&checked_user), &checked_room)).await?? {
            return Err(ApiError::coded(StatusCode::FORBIDDEN, "Подготовка ассетов доступна администратору или владельцу кампании", "ASSET_PREPARATION_FORBIDDEN"));
        }
        let outcome = prepare_assets(ctx, &state, &user, &campaign_id, &room).await;
        match outcome {
            Ok(response) => response,
            Err(_) => Err(ApiError::coded(StatusCode::BAD_GATEWAY, "Не удалось подготовить ассеты", "ASSET_PREPARATION_FAILED")),
        }
    })
}

/// У NPC с id свойства прототипа (`toString`, `constructor`…) JS кладёт в
/// `portrait_url` функцию `NPC_PORTRAIT_CHARACTER_ASSETS[id]`, и список
/// подготовки (`String(profile.portrait_url).trim()`) считает портрет готовым.
/// Профиль Rust функцию в JSON не держит (поле пропадает, как в
/// `JSON.stringify`), поэтому для списка подставляется её текст —
/// `static_npc_portrait` без адреса и есть этот случай (замечено в JS).
fn with_prototype_portrait(mut profile: Value) -> Value {
    let missing = profile.get("portrait_url").is_none() && sk_chargen::npc_portraits::static_npc_portrait(&profile, "prepared_asset").url.is_none();
    if missing {
        let text = crate::files::location_text(None, &js::s(profile.get("id")));
        if let Some(map) = profile.as_object_mut() {
            map.insert("portrait_url".into(), Value::String(text));
        }
    }
    profile
}

/// Тело `try` подготовки (4111–4171); `Err` — 502 `ASSET_PREPARATION_FAILED`.
async fn prepare_assets(ctx: &mut RouteCtx, state: &AppState, user: &Value, campaign_id: &str, room: &Room) -> Result<ApiResult, Failure> {
    let image_failure = |error: sk_chargen::npc_portraits::ImageServiceError| Failure::new(error.to_string(), error.code());
    let authoritative = authoritative_state(state, campaign_id, room).await?;
    let viewer = json!({ "role": "admin", "id": user.get("id").cloned().unwrap_or(Value::Null) });
    let projected = viewer_state_for(&authoritative, &viewer, Some(&Value::String(String::new())))?.unwrap_or(Value::Null);
    let profiles: Vec<Value> = projected.pointer("/social/npcs").and_then(Value::as_array).map_or(&[][..], Vec::as_slice).iter().filter_map(|npc| public_npc_portrait_profile(Some(npc))).map(with_prototype_portrait).collect();
    let images = &state.images;
    let npcs = npc_portrait_inventory(&images.portraits, campaign_id, &projected, |state, profile| npc_portrait_significance(state, profile).significant, &profiles).await.map_err(image_failure)?;
    let known_locations = visible_campaign_locations(&projected);
    let locations = location_illustration_inventory(&images.illustrations, campaign_id, &known_locations).await.map_err(image_failure)?;
    let configured = state.config.model_configured() && !state.config.image_model.is_empty();
    if ctx.method == Method::GET {
        return Ok(Ok(json(
            StatusCode::OK,
            &json!({
                "policy_id": ASSET_PREPARATION_POLICY_ID,
                "runtime_image_generation": state.config.runtime_image_generation,
                "generator_configured": configured,
                "maximum_batch": MAX_PREPARATION_BATCH,
                "npc_portraits": npcs,
                "location_illustrations": locations,
                "items_without_illustration": items_without_illustration(&authoritative),
                "items_note": "Иллюстрация предмета хранится на самой записи предмета и проставляется редактором инвентаря; серверного кеша для неё нет.",
            }),
        )));
    }
    // `readBody(req).catch(() => ({}))`: битое тело — пустой запрос.
    let body = ctx.json_body().await.unwrap_or_else(|_| json!({}));
    let plan = plan_preparation(&body, &json!({ "npcs": npcs, "locations": locations }), js::is_true(body.get("regenerate")));
    if !js::is_true(plan.get("ok")) {
        let mut refusal = ApiError::new(StatusCode::BAD_REQUEST, js::s(plan.get("message")));
        refusal.body.insert("code".into(), plan.get("code").cloned().unwrap_or(Value::Null));
        return Ok(Err(refusal));
    }
    if !configured {
        return Ok(Err(ApiError::coded(StatusCode::SERVICE_UNAVAILABLE, "Генератор изображений не настроен", "IMAGE_GENERATOR_UNAVAILABLE")));
    }
    let ids = |key: &str| -> Vec<String> { plan.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice).iter().map(|id| js::s(Some(id))).collect() };
    let mut prepared = Vec::new();
    // Последовательно и намеренно: параллельный запуск скрыл бы расход и
    // упёрся бы в лимит провайдера на середине пачки.
    for npc_id in ids("npc_ids") {
        let Some(profile) = profiles.iter().find(|candidate| js::string(candidate.get("id")) == npc_id) else { continue };
        match images.portraits.prepare(campaign_id, profile).await {
            Ok(_) => prepared.push(json!({ "id": npc_id, "kind": "npc_portrait", "status": "ready" })),
            Err(error) => prepared.push(json!({ "id": npc_id, "kind": "npc_portrait", "status": "failed", "error": error.to_string() })),
        }
    }
    for location_id in ids("location_ids") {
        let Some(location) = known_locations.iter().find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(location_id.as_str())) else { continue };
        match images.illustrations.prepare(campaign_id, location).await {
            Ok(_) => prepared.push(json!({ "id": location_id, "kind": "location_illustration", "status": "ready" })),
            Err(error) => prepared.push(json!({ "id": location_id, "kind": "location_illustration", "status": "failed", "error": error.to_string() })),
        }
    }
    Ok(Ok(json(StatusCode::OK, &json!({ "policy_id": ASSET_PREPARATION_POLICY_ID, "prepared": prepared }))))
}

// --- картинки предметов ---------------------------------------------------

fn generated_item_file(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_user(ctx).await?;
        serve_generated(ctx.state.images.items.directory(), ctx.param(0)).await
    })
}

fn generate_item_image_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let state = ctx.state.clone();
        if state.limits.exceeds_rate(&format!("image:{}", js::s(user.get("id"))), 10, None) {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Слишком много запросов генерации изображений"));
        }
        // Игровой путь закрыт флагом целиком, включая администратора:
        // картинки готовятся заранее, а не посреди вечера.
        if !state.config.runtime_image_generation {
            return Err(ApiError::coded(
                StatusCode::CONFLICT,
                "Генерация изображений во время игры выключена. Подготовьте картинки заранее в разделе подготовки ассетов",
                "RUNTIME_IMAGE_GENERATION_DISABLED",
            ));
        }
        if !state.config.model_configured() {
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Генератор изображений не настроен"));
        }
        // `readBody` — внутри `try` JS: ошибка тела — 502 с её текстом, а не 400.
        let body = match ctx.json_body().await {
            Ok(body) => body,
            Err(error) => return Err(ApiError::new(StatusCode::BAD_GATEWAY, error.message)),
        };
        let prompt = body.get("prompt");
        if !js::truthy(prompt) || js::string(prompt).encode_utf16().count() < 20 {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "Нужен подробный промпт"));
        }
        let aspect_ratio = if body.get("aspectRatio").and_then(Value::as_str) == Some("16:9") { "16:9" } else { "1:1" };
        match state.images.items.generate(prompt.unwrap_or(&Value::Null), aspect_ratio).await {
            Ok(result) => Ok(json(StatusCode::OK, &result)),
            // Исчерпанный предел — не сбой поставщика, а отказ до запроса.
            Err(failure) if failure.code.as_deref() == Some("LLM_QUOTA_EXCEEDED") => {
                Err(ApiError::coded(StatusCode::TOO_MANY_REQUESTS, "Дневной предел расхода модели исчерпан", "LLM_QUOTA_EXCEEDED"))
            }
            Err(failure) => Err(ApiError::new(StatusCode::BAD_GATEWAY, failure.message)),
        }
    })
}
