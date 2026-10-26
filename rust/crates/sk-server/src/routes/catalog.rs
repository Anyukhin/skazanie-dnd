//! С4: справочники — `rulesets/:id/character-creation` (3931),
//! `rules/search` (4425), `world-templates` (4439), `engine-mode` → 410 (5216);
//! и [`RuleCatalog`] — пакеты правил процесса с отказом при старте
//! (`server/index.mjs:312–324`).
//!
//! Маршруты объявляются с номером строки `server/index.mjs`, где JS их
//! проверяет: порядок общей таблицы (`routes::table`) выводится из этих
//! номеров. Все четыре сравнивают `pathname`, поэтому строка запроса им не
//! мешает.

use std::path::{Path, PathBuf};

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use sk_core::js;
use sk_rulepack::rule_retriever::{create_rule_retriever, RuleRetriever};
use sk_ruleset::ruleset_config::{public_ruleset_profiles, ruleset_profile, ProfileOptions, INSTALLED_RULESET_IDS};

use crate::access::{require_admin, require_user};
use crate::core::blocking;
use crate::dispatch::{Matcher, Methods, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;

pub fn routes() -> Vec<Route> {
    vec![
        // `requestPath.match(/^\/api\/rulesets\/([a-z0-9_]+)\/character-creation$/u)`.
        Route::get(3932, Matcher::path_template("/api/rulesets/{ruleset}/character-creation"), character_creation),
        Route::get(4426, Matcher::path("/api/rules/search"), rules_search),
        Route::get(4440, Matcher::path("/api/world-templates"), world_templates),
        // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/engine-mode$/` и `PATCH`.
        Route::new(5217, Methods::One(Method::PATCH), Matcher::path_template("/api/campaigns/{id}/engine-mode"), engine_mode),
    ]
}

/// Каталог пакетов правил. В JS `rule-pack.mjs` берёт `data/rule_packs`
/// рядом со своим исходником; здесь — `data/rule_packs` корня данных процесса
/// (`sk_core::data_root`, С19.1: `DND_DATA_DIR`, каталог бинаря или дерево
/// сборки).
pub fn rule_packs_root() -> PathBuf {
    sk_core::data_root::join("data").join("rule_packs")
}

/// Пакеты правил процесса: `rulePack` редакции по умолчанию, поиск по всем
/// установленным и публичные профили с числом правил.
pub struct RuleCatalog {
    /// `rulePack.manifest.ruleset_id`.
    pub ruleset_id: String,
    /// `rulePack.rules.length`.
    pub rule_count: usize,
    /// `createRuleRetriever(installedRulePacks)`.
    pub retriever: RuleRetriever,
    /// `installedRulesetProfiles`: `publicRulesetProfiles()` с `ruleCount`.
    pub installed_profiles: Value,
}

fn rules_of(pack: &Value) -> usize {
    pack.get("rules").and_then(Value::as_array).map_or(0, Vec::len)
}

fn manifest_ruleset_id(pack: &Value) -> Option<&str> {
    pack.get("manifest").and_then(|manifest| manifest.get("ruleset_id")).and_then(Value::as_str)
}

/// Отказ старта до загрузки пакетов (`index.mjs:313, 317–319`): неизвестная
/// редакция и редакция, которой нельзя быть умолчанием процесса.
/// `main.rs` зовёт это до открытия состояния, чтобы отказ печатался своим
/// текстом, а не как сбой хранилища.
pub fn check_process_default(default_ruleset_id: &str) -> Result<(), String> {
    let profile = ruleset_profile(default_ruleset_id, ProfileOptions::default()).map_err(|error| error.message)?;
    if !profile.process_default_allowed {
        return Err(format!("Ruleset {default_ruleset_id} доступен для кампании, но не может быть process-wide runtime default"));
    }
    Ok(())
}

impl RuleCatalog {
    /// `index.mjs:313–324` в том же порядке проверок.
    pub fn load(default_ruleset_id: &str, root: &Path) -> Result<Self, String> {
        ruleset_profile(default_ruleset_id, ProfileOptions::default()).map_err(|error| error.message)?;
        // `[...new Set([...INSTALLED_RULESET_IDS, defaultRulesetId])]`.
        let mut ids: Vec<&str> = INSTALLED_RULESET_IDS.to_vec();
        if !ids.contains(&default_ruleset_id) {
            ids.push(default_ruleset_id);
        }
        let packs = sk_rulepack::rule_pack::load_rule_packs(&ids, root).map_err(|error| error.message)?;
        let Some(rule_pack) = packs.iter().find(|pack| manifest_ruleset_id(pack) == Some(default_ruleset_id)) else {
            return Err(format!("Не установлен ruleset DND_DEFAULT_RULESET_ID={default_ruleset_id}"));
        };
        let rule_count = rules_of(rule_pack);
        check_process_default(default_ruleset_id)?;
        let retriever = create_rule_retriever(&packs).map_err(|error| error.message().to_string())?;
        let profiles = public_ruleset_profiles();
        let installed_profiles = Value::Array(
            profiles
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(|profile| {
                    let id = profile.get("id").and_then(Value::as_str);
                    let count = packs.iter().find(|pack| manifest_ruleset_id(pack) == id).map_or(0, rules_of);
                    js::spread(profile, json!({ "ruleCount": count }))
                })
                .collect(),
        );
        Ok(Self { ruleset_id: default_ruleset_id.to_string(), rule_count, retriever, installed_profiles })
    }
}

/// `characterCreationCatalog(rulesetId)` как ошибка `{ message, code }`.
pub fn character_creation_catalog(ruleset_id: &str) -> Result<Value, Failure> {
    sk_character::character_lifecycle::character_creation_catalog(ruleset_id).map_err(|error| Failure::new(error.message, error.code.as_deref()))
}

/// `GET /api/rulesets/:id/character-creation` (3931–3939): без входа; любая
/// ошибка профиля или каталога — 404 с её текстом и кодом.
fn character_creation(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let requested = ctx.param(0).to_string();
        let result = blocking(move || {
            let profile = ruleset_profile(&requested, ProfileOptions { fallback: None, require_creation: true }).map_err(|error| Failure::new(error.message, Some(&error.code)))?;
            character_creation_catalog(profile.id)
        })
        .await?;
        match result {
            Ok(catalog) => Ok(json(StatusCode::OK, &catalog)),
            Err(failure) => Err(failure.respond(StatusCode::NOT_FOUND)),
        }
    })
}

/// `Math.min(20, Number(limit) || 10)`; `searchParams.get` без значения — `null`, `Number(null)` — 0.
fn search_limit(raw: Option<String>) -> f64 {
    let number = raw.map_or(0.0, |text| js::parse_number(&text));
    let number = if number.is_nan() || number == 0.0 { 10.0 } else { number };
    // `Math.min` с конечным 20: `-Infinity` остаётся, `Infinity` — 20.
    if number < 20.0 {
        number
    } else {
        20.0
    }
}

/// `GET /api/rules/search` (4425–4434).
fn rules_search(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_user(ctx).await?;
        let catalog = &ctx.state.rules;
        let queries: Vec<String> = crate::url::search_params_all(&ctx.raw_url, "q").into_iter().filter(|query| !query.is_empty()).collect();
        let ruleset_id = ctx.search_param("ruleset_id").filter(|id| !id.is_empty()).unwrap_or_else(|| catalog.ruleset_id.clone());
        let enabled_raw = ctx.search_param("enabled_packs").filter(|packs| !packs.is_empty()).unwrap_or_else(|| ruleset_id.clone());
        let enabled: Vec<&str> = enabled_raw.split(',').filter(|pack| !pack.is_empty()).collect();
        let limit = search_limit(ctx.search_param("limit"));
        let input = json!({ "queries": queries, "ruleset_id": ruleset_id, "enabled_packs": enabled, "limit": js::num(limit) });
        match catalog.retriever.search(&input) {
            Ok(result) => Ok(json(StatusCode::OK, &result)),
            Err(error) => Err(ApiError::new(StatusCode::BAD_REQUEST, error.message())),
        }
    })
}

/// `GET /api/world-templates` (4439–4442): только карточки выбора.
fn world_templates(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_user(ctx).await?;
        // В JS каталог проверяется при загрузке модуля, и сбой не даёт серверу
        // подняться; здесь он ленивый — сбой становится 500 этого запроса.
        let templates = blocking(sk_world_time::world_template_catalog::list_world_templates).await?.map_err(|error| ApiError::internal(error.to_string()))?;
        Ok(json(StatusCode::OK, &json!({ "templates": templates })))
    })
}

/// `PATCH /api/campaigns/:id/engine-mode` (5215–5219): только админу, всегда 410.
fn engine_mode(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        require_admin(ctx).await?;
        Err(ApiError::coded(StatusCode::GONE, "Переключение движка удалено: enforce является единственным runtime", "ENGINE_MODE_RETIRED"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_follows_js_number_or() {
        assert_eq!(search_limit(None), 10.0);
        assert_eq!(search_limit(Some(String::new())), 10.0);
        assert_eq!(search_limit(Some("abc".into())), 10.0);
        assert_eq!(search_limit(Some("0".into())), 10.0);
        assert_eq!(search_limit(Some(" 3 ".into())), 3.0);
        assert_eq!(search_limit(Some("50".into())), 20.0);
        assert_eq!(search_limit(Some("Infinity".into())), 20.0);
        assert_eq!(search_limit(Some("-2".into())), -2.0);
        assert_eq!(search_limit(Some("-Infinity".into())), f64::NEG_INFINITY);
    }

    #[test]
    fn process_default_guard() {
        assert_eq!(check_process_default("srd_5_2_1"), Ok(()));
        assert_eq!(
            check_process_default("dnd_5e_2014"),
            Err("Ruleset dnd_5e_2014 доступен для кампании, но не может быть process-wide runtime default".to_string())
        );
        assert_eq!(check_process_default("nope"), Err("Неизвестный ruleset «nope»".to_string()));
        assert!(RuleCatalog::load("dnd_5e_2014", &rule_packs_root()).is_err());
        let catalog = RuleCatalog::load("srd_5_2_1", &rule_packs_root()).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(catalog.rule_count, 23);
        let counts: Vec<(String, i64)> = catalog.installed_profiles.as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|profile| (js::string(profile.get("id")), profile["ruleCount"].as_i64().unwrap_or(-1))).collect();
        assert_eq!(counts, [("dnd_5e_2014".to_string(), 28), ("srd_5_2_1".to_string(), 23)]);
    }
}
