//! Проекция журнала в комнату — **заглушка С0**, реализация — С1
//! (`server/index.mjs:3012–3019, 3365–3695`).
//!
//! Сигнатуры зафиксированы здесь, чтобы задачи волны 1 могли писать
//! маршруты против них, пока С1 наполняет тела.

use std::rc::Rc;

use serde_json::Value;

use crate::core::GameCore;
use crate::error::Failure;
use crate::room::Room;

/// Строка летописи, которую проекция дописывает вместе с собой
/// (`journalMessage` в `persistAuthoritativeProjection`).
pub type JournalMessage = Value;

/// Параметры `persistAuthoritativeProjection(..., { forceProjectorRefresh, awaitProjection })`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PersistOptions {
    pub force_projector_refresh: bool,
    pub await_projection: bool,
}

/// `latestCampaignState(campaignId, fallbackState)` (3012–3019): состояние
/// журнала, а без журнала — запасное.
pub async fn latest_campaign_state(_core: Rc<GameCore>, _campaign_id: &str, fallback_state: Option<Value>) -> Result<Option<Value>, Failure> {
    Ok(fallback_state)
}

/// `persistAuthoritativeProjection(campaignId, engineState, events, journalMessage, options)`
/// (3382–3496): подтвердить проекцию и вернуть комнату.
pub async fn persist_authoritative_projection(
    _core: Rc<GameCore>,
    campaign_id: &str,
    _engine_state: Value,
    _events: Vec<Value>,
    _journal_message: Option<JournalMessage>,
    _options: PersistOptions,
) -> Result<Room, Failure> {
    Err(Failure::new(format!("Проекция кампании {campaign_id} ещё не перенесена (С1)"), Some("NOT_PORTED")))
}

/// `reconcileCampaignProjection(campaignId)` (3497–3573): сверить комнату с
/// журналом, истечь голосования, вернуть свежую комнату.
pub async fn reconcile_campaign_projection(core: Rc<GameCore>, campaign_id: &str) -> Result<Room, Failure> {
    crate::room::get_room(&core, campaign_id)
}

/// `reconcileAllCampaignProjections()` (3574–3594): сверка при старте; сбой
/// одной кампании не мешает остальным.
pub async fn reconcile_all_campaign_projections(_core: Rc<GameCore>) -> Result<(), Failure> {
    Ok(())
}

/// Хук «проекция записана» — бывший `onRoomSaved` (`store.mjs:438–470`).
/// Подписчики: рассылка (С9), координатор боя и часы мира (С17), зацепки
/// героев (С17). Вызывается **после** снятия замков потоков.
pub type ProjectionSavedHook = fn(&Rc<GameCore>, &str, &Room);

/// Оповестить подписчиков о записанной проекции. До С1 подписчиков нет.
pub fn on_projection_saved(core: &Rc<GameCore>, campaign_id: &str, room: &Room, hooks: &[ProjectionSavedHook]) {
    for hook in hooks {
        hook(core, campaign_id, room);
    }
}
