//! Живые потоки кампаний и присутствие — **заглушка С0**, реализация — С9
//! (`server/index.mjs:270–290, 2361–2477, 2601–2712, 4172–4282`).
//!
//! Где живёт реестр (решение №1, рецензия С0 CORE-03): **в ядре**,
//! [`crate::core::GameCore::streams`]. Рассылка кадров, отзыв доступа,
//! пересчёт проекции и чтение присутствия идут только на потоке ядра,
//! синхронно и без замков, которые держат через `await`. Поэтому:
//!
//! - рассылка после коммита не может перемежиться с отзывом: оба — отрезки
//!   одного потока, кадр вышедшей сессии не уходит после ответа на logout;
//! - HTTP-слой зовёт хуки только через [`revoke_for_session`] и
//!   [`refresh_for_user`] — задание ядра, ответ маршрута уходит **после**
//!   подтверждения ядра (как синхронный вызов в JS, 4007, 4023);
//! - проекцию зрителя для `refresh` и рассылки реестр считает из состояния
//!   ядра, а не из копии вне его.
//!
//! Каркас уже зовёт хуки там, где их зовёт JS: выход закрывает потоки своей
//! сессии (`revokeCampaignStreamsForSession`, 4007), смена доступа
//! администратором обновляет потоки пользователя
//! (`refreshCampaignStreamsForUser`, 4023). Кворум голосований и выбор
//! голосующих читают присутствие через [`Presence`] (2478–2482).

use std::rc::Rc;
use std::sync::Arc;

use sk_core::indexmap::IndexSet;

use crate::core::CoreError;
use crate::state::AppState;

/// `connectedHeroIdsForCampaign(campaignId)`: герои, чьи хозяева сейчас
/// держат открытый поток (после сверки доступа). Только на потоке ядра.
pub trait Presence {
    fn connected_hero_ids(&self, campaign_id: &str) -> IndexSet<String>;
}

/// Реестр живых потоков. Только на потоке ядра.
pub trait StreamRegistry: Presence {
    /// `revokeCampaignStreamsForSession(sessionKey)`: закрыть потоки этой
    /// сессии кадром отзыва доступа; потоки других входов того же игрока живут.
    fn revoke_for_session(&self, session_key: &str);
    /// `refreshCampaignStreamsForUser(userId)`: пересчитать героев и проекцию
    /// уже открытых потоков пользователя.
    fn refresh_for_user(&self, user_id: &str);
}

/// Сборщик реестра: вызывается на потоке ядра при его запуске.
pub type StreamFactory = Box<dyn FnOnce() -> Box<dyn StreamRegistry> + Send>;

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

macro_rules! shared_registry {
    ($($pointer:ident),*) => {
        $(impl<T: Presence + ?Sized> Presence for $pointer<T> {
            fn connected_hero_ids(&self, campaign_id: &str) -> IndexSet<String> {
                (**self).connected_hero_ids(campaign_id)
            }
        }

        impl<T: StreamRegistry + ?Sized> StreamRegistry for $pointer<T> {
            fn revoke_for_session(&self, session_key: &str) {
                (**self).revoke_for_session(session_key)
            }

            fn refresh_for_user(&self, user_id: &str) {
                (**self).refresh_for_user(user_id)
            }
        })*
    };
}

shared_registry!(Rc, Arc, Box);

/// `revokeCampaignStreamsForSession(sessionKey)` из HTTP-слоя: задание ядра;
/// возвращается после того, как ядро закрыло потоки.
pub async fn revoke_for_session(state: &AppState, session_key: String) -> Result<(), CoreError> {
    state.core.call(move |core| Box::pin(async move { core.streams.revoke_for_session(&session_key) })).await
}

/// `refreshCampaignStreamsForUser(userId)` из HTTP-слоя: задание ядра;
/// возвращается после пересчёта потоков.
pub async fn refresh_for_user(state: &AppState, user_id: String) -> Result<(), CoreError> {
    state.core.call(move |core| Box::pin(async move { core.streams.refresh_for_user(&user_id) })).await
}
