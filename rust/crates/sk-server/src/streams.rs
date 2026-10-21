//! Живые потоки кампаний и присутствие — **заглушка С0**, реализация — С9
//! (`server/index.mjs:270–290, 2361–2477, 2601–2712, 4172–4282`).
//!
//! Каркас уже зовёт хуки там, где их зовёт JS: выход закрывает потоки своей
//! сессии (`revokeCampaignStreamsForSession`, 4007), смена доступа
//! администратором обновляет потоки пользователя
//! (`refreshCampaignStreamsForUser`, 4023). Кворум голосований и выбор
//! голосующих читают присутствие через [`Presence`] (2478–2482).

use sk_core::indexmap::IndexSet;

/// `connectedHeroIdsForCampaign(campaignId)`: герои, чьи хозяева сейчас
/// держат открытый поток (после сверки доступа).
pub trait Presence: Send + Sync {
    fn connected_hero_ids(&self, campaign_id: &str) -> IndexSet<String>;
}

/// Реестр живых потоков.
pub trait StreamRegistry: Presence {
    /// `revokeCampaignStreamsForSession(sessionKey)`: закрыть потоки этой
    /// сессии кадром отзыва доступа; потоки других входов того же игрока живут.
    fn revoke_for_session(&self, session_key: &str);
    /// `refreshCampaignStreamsForUser(userId)`: пересчитать героев и проекцию
    /// уже открытых потоков пользователя.
    fn refresh_for_user(&self, user_id: &str);
}

/// Заглушка С0: потоков нет, присутствующих нет.
pub struct NoStreams;

impl Presence for NoStreams {
    fn connected_hero_ids(&self, _campaign_id: &str) -> IndexSet<String> {
        IndexSet::new()
    }
}

impl StreamRegistry for NoStreams {
    fn revoke_for_session(&self, _session_key: &str) {}

    fn refresh_for_user(&self, _user_id: &str) {}
}
