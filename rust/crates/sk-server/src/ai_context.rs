//! Настройки ИИ кампании на время запроса — `runWithCampaignAiSettings`
//! (`server/index.mjs:3920–3929`) поверх `AsyncLocalStorage`.
//!
//! В Rust контекст `sk_narration_base::campaign_ai_context` — стек на поток:
//! через `.await` (задача может проснуться на другом потоке) и через
//! `spawn_blocking` он теряется. Поэтому здесь два слоя:
//!
//! - `tokio::task_local!` [`REQUEST_AI_SETTINGS`] держит настройки запроса;
//! - [`with_campaign_ai`] оборачивает будущее так, что **каждый** его опрос
//!   идёт внутри `run_with_campaign_ai_settings`: синхронный код агентов и
//!   клиента модели в любой глубине видит `current_campaign_model()` и т. п.
//!
//! Через границы задач настройки переносятся явно: [`capture`] на стороне
//! постановщика, [`with_campaign_ai`] на стороне исполнителя (ядро
//! [`crate::core::CoreHandle`], [`crate::blocking::run_blocking`], фоновые
//! задачи). Так ведёт себя и `queueMicrotask` в JS: он наследует контекст
//! запроса (`index.mjs:2830–2836`).

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use serde_json::Value;

tokio::task_local! {
    /// Настройки ИИ текущего запроса: `null` вне кампании.
    pub static REQUEST_AI_SETTINGS: Option<Value>;
}

/// Настройки, видимые сейчас (для переноса в другую задачу). Вне
/// [`with_campaign_ai`] — `None`.
pub fn capture() -> Option<Value> {
    REQUEST_AI_SETTINGS.try_with(Clone::clone).ok().flatten()
}

/// Будущее, каждый опрос которого идёт в контексте настроек кампании.
pub struct WithCampaignAi<F> {
    settings: Option<Value>,
    inner: Pin<Box<F>>,
}

impl<F: Future> Future for WithCampaignAi<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.get_mut();
        let settings = this.settings.clone();
        let inner = this.inner.as_mut();
        REQUEST_AI_SETTINGS.sync_scope(settings.clone(), || {
            sk_narration_base::campaign_ai_context::run_with_campaign_ai_settings(settings.as_ref(), || inner.poll(cx))
        })
    }
}

/// `runWithCampaignAiSettings(settings, operation)` для асинхронной операции.
pub fn with_campaign_ai<F: Future>(settings: Option<Value>, future: F) -> WithCampaignAi<F> {
    WithCampaignAi { settings, inner: Box::pin(future) }
}

/// Синхронный вариант — для замыкания `spawn_blocking`.
pub fn run_sync<R>(settings: Option<Value>, operation: impl FnOnce() -> R) -> R {
    REQUEST_AI_SETTINGS.sync_scope(settings.clone(), || sk_narration_base::campaign_ai_context::run_with_campaign_ai_settings(settings.as_ref(), operation))
}

/// `requestPath.match(/^\/api\/(?:campaigns|rooms)\/([A-Za-z0-9-]+)/)?.[1]?.toUpperCase()`
/// (3922–3923): id кампании из начала пути, без якоря в конце.
pub fn campaign_id_from_path(pathname: &str) -> Option<String> {
    let rest = pathname.strip_prefix("/api/campaigns/").or_else(|| pathname.strip_prefix("/api/rooms/"))?;
    let id: String = rest.chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-').collect();
    (!id.is_empty()).then(|| id.to_uppercase())
}

/// `{ ...stored, model: stored.model || model }` (3925–3927).
pub fn request_settings(stored: &sk_store::accounts::CampaignAiSettings, server_model: &str) -> Value {
    let mut value = stored.to_json();
    if stored.model.is_empty() {
        value["model"] = Value::String(server_model.to_string());
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sk_narration_base::campaign_ai_context::{current_campaign_model, current_improv_mode};

    #[test]
    fn campaign_id_like_regex() {
        assert_eq!(campaign_id_from_path("/api/campaigns/ab-1/commands").as_deref(), Some("AB-1"));
        assert_eq!(campaign_id_from_path("/api/rooms/xyz").as_deref(), Some("XYZ"));
        assert_eq!(campaign_id_from_path("/api/rooms/xyz_1").as_deref(), Some("XYZ"), "регулярка без якоря берёт префикс");
        assert_eq!(campaign_id_from_path("/api/campaigns/"), None);
        assert_eq!(campaign_id_from_path("/api/campaigns"), None);
        assert_eq!(campaign_id_from_path("/api/heroes"), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn context_survives_await_and_blocking() {
        let settings = json!({ "model": "a/x", "improvMode": "chaos" });
        let seen = with_campaign_ai(Some(settings), async {
            let before = current_campaign_model();
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let after = current_campaign_model();
            let carried = capture();
            let blocking = tokio::task::spawn_blocking(move || run_sync(carried, || (current_campaign_model(), current_improv_mode()))).await;
            (before, after, blocking.ok())
        })
        .await;
        assert_eq!(seen.0, "a/x");
        assert_eq!(seen.1, "a/x", "после await на другом потоке");
        assert_eq!(seen.2, Some(("a/x".to_string(), "chaos".to_string())), "в spawn_blocking после явного переноса");
        assert_eq!(current_campaign_model(), "", "вне запроса контекста нет");
        assert_eq!(capture(), None);
    }

    #[test]
    fn stored_model_falls_back_to_server_model() {
        let stored = sk_store::accounts::CampaignAiSettings { model: String::new(), narrator_style: "neutral".into(), improv_mode: "story".into(), reasoning_level: "auto".into() };
        assert_eq!(request_settings(&stored, "srv/m")["model"], "srv/m");
    }
}
