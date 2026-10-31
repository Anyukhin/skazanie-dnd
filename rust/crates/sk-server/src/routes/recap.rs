//! С6: рекап «в прошлой серии» — `GET /api/campaigns/:id/recap` (4597–4621).
//!
//! Маршрут объявлен с номером строки `server/index.mjs`, где JS его
//! проверяет: порядок общей таблицы (`routes::table`) выводится из этих
//! номеров.
//!
//! Рекап — украшение возвращения за стол, а не условие входа в игру: любая
//! поломка источника (журнал, кеш, модель) внутри `try` JS — 200
//! `{ recap: null, reason: 'unavailable' }`. Сервис собирается на запрос:
//! состояния у него нет, кеш — файл `engine/campaign-recap.json`, как у
//! `CampaignRecapService` JS (`index.mjs:428–432`).
//!
//! Отклонение от JS (комната — проекция журнала, решение №2): в JS комната —
//! свой файл, и при испорченном журнале проверка доступа идёт по нему, а
//! рекап отвечает `unavailable`. В Rust комнату из такого журнала не собрать,
//! поэтому доступ решает членство: администратору и участнику (членство в
//! профиле) — `unavailable`, остальным — 403 «Нет доступа к этой кампании».

use axum::http::StatusCode;
use serde_json::{json, Value};
use sk_agents::campaign_recap::{CampaignRecapService, RecapCacheStore};
use sk_core::js;
use sk_store::LoadOptions;

use crate::access::{campaign_membership, can_access_room, require_user};
use crate::core::blocking;
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::room::{self, Room};

pub fn routes() -> Vec<Route> {
    // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/recap$/` и `GET`.
    vec![Route::get(4616, Matcher::path_template("/api/campaigns/{id}/recap"), campaign_recap)]
}

fn unavailable() -> Value {
    json!({ "recap": null, "reason": "unavailable" })
}

fn campaign_recap(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_uppercase();
        let code = campaign_id.clone();
        let room: Result<Room, Failure> = ctx.state.core.call(move |core| Box::pin(async move { room::get_room(&core, &code) })).await?;
        let room = match room {
            Ok(room) => room,
            Err(_) => {
                let admin = user.get("role").and_then(Value::as_str) == Some("admin");
                if admin || campaign_membership(&user, &campaign_id).is_some() {
                    return Ok(json(StatusCode::OK, &unavailable()));
                }
                return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
            }
        };
        if room.state.is_none() {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "Кампания не найдена"));
        }
        let accounts = ctx.state.accounts.clone();
        let viewer = user.clone();
        let checked = room.clone();
        if !blocking(move || can_access_room(&accounts, Some(&viewer), &checked)).await?? {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Нет доступа к этой кампании"));
        }
        let llm = ctx.state.agent_llm().map(|client| client.client());
        let cache = RecapCacheStore::new(ctx.state.config.storage_dir.join("engine").join("campaign-recap.json"));
        let gap_hours = js::num(ctx.state.config.recap_gap_hours);
        let recap = ctx
            .state
            .core
            .call(move |core| {
                Box::pin(async move {
                    let service = CampaignRecapService::new(llm, Some(cache), Some(&gap_hours), None);
                    // `load` уже отдаёт metadata: второй вызов `getMetadata` не нужен.
                    let loaded = core.events.load(&campaign_id, &LoadOptions::default()).ok()?;
                    let input = json!({
                        "campaignId": campaign_id,
                        "state": loaded.state,
                        "stateVersion": loaded.state_version,
                        "lastEventAt": loaded.metadata.get("updated_at").cloned(),
                    });
                    service.recap_for(&input).await.ok()
                })
            })
            .await;
        // Паника задания — тоже «любая поломка источника».
        Ok(json(StatusCode::OK, &recap.ok().flatten().unwrap_or_else(unavailable)))
    })
}
