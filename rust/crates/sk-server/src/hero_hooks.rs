//! С17: зацепки из предысторий героев на хуке проекции — перенос
//! `server/index.mjs:2838–2893`.
//!
//! Стадия `hero-hooks` координатора последствий
//! ([`crate::clocks::run_post_commit`]): когда у героя собран лист, а зацепок
//! из его предыстории в мире ещё нет, модель (`HeroHookWeaver`,
//! `sk_agents::hero_hooks`) предлагает их, сервер проверяет и пишет командами
//! памяти мира через общий исполнитель (ключ `hero-hooks:<hero_id>`). Вход —
//! запись проекции, как у мировых часов. Без модели список ждущих пуст;
//! ошибка модели или коммита запрос игрока не задевает — стадия упадёт в лог
//! и повторится после паузы (`HERO_HOOK_RETRY_MS`).
//!
//! Плетельщик один на ядро (счёт попыток живёт в процессе, как в JS) и
//! собирается при первом обращении, когда ядру известен `AppState`
//! ([`crate::clocks::bind_app`]): модель — `apiKey ? llmClient : null`.

use std::cell::{OnceCell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use serde_json::{json, Map, Value};
use sk_agents::director_agent::RoleClient;
use sk_agents::hero_hooks::{HeroHookWeaver, HeroHookWeaverConfig};
use sk_core::js;
use sk_store::LoadOptions;

use crate::clocks::{app, execute_commands, run_post_commit, PostCommitRequest};
use crate::core::{GameCore, LocalFuture};
use crate::projection::{persist_authoritative_projection, PersistOptions};
use crate::room::Room;

/// Имя класса клиента горячего пути (`llmClient.constructor.name`).
const HOT_CLIENT_CLASS: &str = "FallbackLLMClient";

thread_local! {
    /// `heroHookWeaver` этого ядра.
    static WEAVER: OnceCell<Rc<HeroHookWeaver>> = const { OnceCell::new() };
    /// `heroHookJobs`: кампании, где плетение уже идёт.
    static JOBS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// Плетельщик ядра; без `AppState` — `None`.
fn weaver() -> Option<Rc<HeroHookWeaver>> {
    if let Some(ready) = WEAVER.with(|slot| slot.get().cloned()) {
        return Some(ready);
    }
    let app = app()?;
    let llm_client = app.agent_llm().map(|client| RoleClient::new(client.client(), HOT_CLIENT_CLASS));
    let built = Rc::new(HeroHookWeaver::new(HeroHookWeaverConfig { llm_client, ..HeroHookWeaverConfig::default() }));
    Some(WEAVER.with(|slot| slot.get_or_init(|| built).clone()))
}

/// `heroesNeedingHooks(state, campaignId)` → `heroHookWeaver.pendingHeroIds`.
pub fn pending_hero_ids(state: &Value, campaign_id: &str) -> Vec<String> {
    weaver().map(|weaver| weaver.pending_hero_ids(state, campaign_id)).unwrap_or_default()
}

/// `weaveHeroHooksFor({ campaignId })` (2851–2870): план модели — коммит на
/// героя; кому не сплелось, а попытки ещё есть — стадия не засчитывается.
pub async fn weave_hero_hooks_for(core: &Rc<GameCore>, campaign_id: &str) -> Result<Value, String> {
    let weaver = weaver().ok_or_else(|| "игровое ядро остановлено".to_string())?;
    let loaded = core.events.load(campaign_id, &LoadOptions::default()).map_err(|error| crate::error::Failure::from(error).to_string())?;
    let state = sk_rules::normalize::normalize_campaign_state(&loaded.state).map_err(|halt| halt.to_string())?;
    let woven = weaver.weave(&state, campaign_id, None).await;
    let mut committed_hero_ids: Vec<String> = Vec::new();
    for plan in woven.get("plans").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let key = js::s(plan.get("idempotency_key"));
        let commands = plan.get("commands").and_then(Value::as_array).cloned().unwrap_or_default();
        let committed = execute_commands(core, campaign_id, &key, &commands, json!({ "isDirector": true })).map_err(|error| error.to_string())?;
        committed_hero_ids.push(js::string(plan.get("hero_id")));
        if !committed.replayed {
            persist_authoritative_projection(core, campaign_id, &committed.commit.state, &committed.commit.events, None, PersistOptions::default()).map_err(|error| error.to_string())?;
        }
    }
    let hero_ids: Vec<String> = woven.get("hero_ids").and_then(Value::as_array).map(|ids| ids.iter().map(|id| js::string(Some(id))).collect()).unwrap_or_default();
    let retryable = hero_ids.iter().any(|hero_id| !committed_hero_ids.contains(hero_id) && weaver.attempts_left(campaign_id, hero_id));
    if retryable {
        let reason = match woven.get("error") {
            None | Some(Value::Null) => "empty".to_string(),
            some => js::string(some),
        };
        return Err(format!("HERO_HOOKS_NOT_WOVEN: {reason}"));
    }
    Ok(json!({ "hero_ids": hero_ids, "committed_hero_ids": committed_hero_ids, "provider": woven.get("provider").cloned().unwrap_or(Value::Null) }))
}

/// Хук «проекция записана» (2877–2893): ждущие герои вне уже идущего
/// плетения — прогон стадии `hero-hooks`.
fn hero_hooks_hook(core: Rc<GameCore>, campaign_id: String, room: Room) -> LocalFuture<()> {
    Box::pin(async move {
        let normalized = campaign_id.to_uppercase();
        let Some(state) = room.state.as_ref() else { return };
        if normalized.is_empty() || JOBS.with(|jobs| jobs.borrow().contains(&normalized)) {
            return;
        }
        if pending_hero_ids(state, &normalized).is_empty() {
            return;
        }
        JOBS.with(|jobs| jobs.borrow_mut().insert(normalized.clone()));
        // `finally`: и паника прогона снимает отметку.
        let _job = JobGuard(normalized.clone());
        let commit_key = format!("hero-hooks:{normalized}");
        let stages: [&str; 1] = ["hero-hooks"];
        run_post_commit(&core, PostCommitRequest { campaign_id: &normalized, state, events: &[], commit_key: &commit_key, stages: Some(&stages), context: Map::new() }).await;
    })
}

/// Снимает отметку `heroHookJobs` при выходе из прогона.
struct JobGuard(String);

impl Drop for JobGuard {
    fn drop(&mut self) {
        JOBS.with(|jobs| jobs.borrow_mut().remove(&self.0));
    }
}

/// Подписать плетение на хук проекции (при сборке ядра, после рассылки и часов).
pub fn install(core: &GameCore) {
    crate::projection::subscribe_projection_saved(core, hero_hooks_hook);
}
