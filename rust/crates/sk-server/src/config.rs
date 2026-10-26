//! Настройки сервера — перенос верхушки `server/index.mjs` (202–231, 251, 312,
//! 356, 409, 430, 494) и переменных, которые JS читает в других модулях:
//! `store.mjs:8,138` (`DND_STORAGE_DIR`, `ADMIN_SETUP_TOKEN`),
//! `speech-input.mjs:11` (`DND_WHISPER_*`), `rules-corpus.mjs:29`
//! (`DND_CORPUS_DIR`), `migrations/001-event-engine.mjs:73–74`
//! (`DND_DEFAULT_RULESET_*`).
//!
//! Числа читаются как `Number(process.env.X || умолчание)`: пустая строка —
//! умолчание, `'0'` — ноль, мусор — `NaN`. Поэтому числовые поля — `f64`, а
//! решение «NaN и 0 при `||`» принимает потребитель, как в JS.
//!
//! [`Config::for_tests`] окружение не читает вовсе: тестовый сервер не может
//! унаследовать `ROUTERAI_API_KEY` машины (инвариант «корпус тестов не ходит в
//! интернет»). Ключ и адрес модели передаются клиентам только явно.

use std::fmt;
use std::path::{Path, PathBuf};

use sk_narration_base::model_style_profiles::SELECTABLE_EXTRA_MODELS;

/// `LEGACY_DEFAULT_RULESET_ID` (`server/ruleset-config.mjs:2`).
pub const LEGACY_DEFAULT_RULESET_ID: &str = sk_ruleset::ruleset_config::LEGACY_DEFAULT_RULESET_ID;
/// `DEFAULT_RULESET_VERSION` (`server/migrations/001-event-engine.mjs:18`).
pub const DEFAULT_RULESET_VERSION: &str = "5.2.1";
/// `MIN_PARTY_SLOTS` / `MAX_PARTY_SLOTS` (`index.mjs:206–207`).
pub const MIN_PARTY_SLOTS: i64 = 1;
pub const MAX_PARTY_SLOTS: i64 = 5;

const DEFAULT_MODEL: &str = "openai/gpt-6-luna";
const DEFAULT_FALLBACK_MODELS: &str = "google/gemini-2.5-flash-lite,z-ai/glm-5.3-flash,deepseek/deepseek-v4-flash,openai/gpt-4.1-nano";
const DEFAULT_BASE_URL: &str = "https://routerai.ru/api/v1";
const DEFAULT_LORE_MODEL: &str = "openai/gpt-5.6-luna-pro";
const DEFAULT_IMAGE_MODEL: &str = "openai/gpt-image-1";

/// Все настройки процесса.
#[derive(Clone)]
pub struct Config {
    /// `AGENT_HOST || '0.0.0.0'`.
    pub host: String,
    /// `Number(AGENT_PORT || 8787)`; допустимость порта проверяет `main.rs`.
    pub port: f64,
    /// `DND_STORAGE_DIR ? resolve(…) : join(cwd, 'storage')`.
    pub storage_dir: PathBuf,
    /// `join(root, 'dist')`, `root` — корень данных процесса.
    pub dist_dir: PathBuf,
    /// `String(ADMIN_SETUP_TOKEN || '')`.
    pub admin_setup_token: String,
    /// `COOKIE_SECURE === 'true'`.
    pub cookie_secure: bool,
    /// `ROUTERAI_API_KEY || ''` — значение не печатается (`Debug` его скрывает).
    pub api_key: String,
    /// `(ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1').replace(/\/$/, '')`.
    pub base_url: String,
    /// `DND_AI_MODEL || 'openai/gpt-6-luna'`.
    pub model: String,
    /// `DND_AI_FALLBACK_MODELS`: без повторов и без основной модели, не больше пяти.
    pub fallback_models: Vec<String>,
    /// `[model, ...fallbackModels]`.
    pub automatic_ai_models: Vec<String>,
    /// `[...new Set([...automaticAiModels, ...SELECTABLE_EXTRA_MODELS])]`.
    pub allowed_ai_models: Vec<String>,
    /// `Number(DND_AI_MAX_TOKENS || 1200)`.
    pub ai_max_tokens: f64,
    /// `Number(DND_AI_MODEL_TIMEOUT_MS || 9000)`.
    pub ai_model_timeout_ms: f64,
    /// `Number(DND_AI_PROBE_TIMEOUT_MS || 15000)`.
    pub ai_probe_timeout_ms: f64,
    /// `Number(DND_AI_FAILURE_COOLDOWN_MS || 120000)`.
    pub ai_failure_cooldown_ms: f64,
    /// `Number(DND_AI_DAILY_TOKEN_LIMIT || 2000000)`.
    pub ai_daily_token_limit: f64,
    /// `DND_AI_LORE_MODEL || 'openai/gpt-5.6-luna-pro'`.
    pub lore_model: String,
    /// `Number(DND_COMBAT_TURN_TIMEOUT_MS || 120000)`.
    pub combat_turn_timeout_ms: f64,
    /// `DND_IMAGE_MODEL || 'openai/gpt-image-1'`.
    pub image_model: String,
    /// `['on','true','1','yes'].includes(String(DND_RUNTIME_IMAGE_GENERATION ?? '').trim().toLowerCase())`.
    pub runtime_image_generation: bool,
    /// `Number(DND_ARCHITECT_ALERT_THRESHOLD || DEFAULT_ARCHITECT_ALERT_THRESHOLD)`.
    pub architect_alert_threshold: f64,
    /// `DND_DEFAULT_RULESET_ID || LEGACY_DEFAULT_RULESET_ID`.
    pub default_ruleset_id: String,
    /// `DND_DEFAULT_RULESET_VERSION || DEFAULT_RULESET_VERSION`.
    pub default_ruleset_version: String,
    /// `String(DND_MAP_LIBRARY ?? '').trim().toLowerCase() === 'on'`.
    pub map_library: bool,
    /// `Number(DND_RECAP_GAP_HOURS || DEFAULT_RECAP_GAP_HOURS)`.
    pub recap_gap_hours: f64,
    /// `DND_CORPUS_DIR ? String(…) : ''`.
    pub corpus_dir: String,
    /// `DND_WHISPER_EXECUTABLE` как есть (`undefined` — `None`).
    pub whisper_executable: Option<String>,
    /// `DND_WHISPER_MODEL` как есть.
    pub whisper_model: Option<String>,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("storage_dir", &self.storage_dir)
            .field("dist_dir", &self.dist_dir)
            .field("admin_setup_token", &if self.admin_setup_token.is_empty() { "" } else { "<скрыт>" })
            .field("cookie_secure", &self.cookie_secure)
            .field("api_key", &if self.api_key.is_empty() { "" } else { "<скрыт>" })
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("fallback_models", &self.fallback_models)
            .field("default_ruleset_id", &self.default_ruleset_id)
            .finish_non_exhaustive()
    }
}

/// `process.env.X || ''`: пустая строка — как отсутствие.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// `Number(process.env.X || fallback)`.
fn env_number(env: &dyn Fn(&str) -> Option<String>, name: &str, fallback: f64) -> f64 {
    non_empty(env(name)).map_or(fallback, |text| sk_core::js::parse_number(&text))
}

/// `String(x ?? '').trim().toLowerCase()`.
fn lowered(value: Option<String>) -> String {
    sk_core::text::trim(&value.unwrap_or_default()).to_lowercase()
}

/// Список моделей каскада (`index.mjs:214–215`).
pub fn fallback_models_from(raw: Option<String>, model: &str) -> Vec<String> {
    let raw = non_empty(raw).unwrap_or_else(|| DEFAULT_FALLBACK_MODELS.to_string());
    let mut unique: Vec<String> = Vec::new();
    for value in raw.split(',').map(|value| sk_core::text::trim(value).to_string()) {
        if !value.is_empty() && value != model && !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique.truncate(5);
    unique
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

impl Config {
    /// Настройки из окружения процесса. `root` — корень данных
    /// (`sk_core::data_root`), клиент раздаётся из его `dist/`; хранилище по
    /// умолчанию — `storage/` в текущем каталоге, как у JS.
    pub fn from_env(root: &Path) -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| root.to_path_buf());
        Self::from_env_with(root, &cwd, &|name| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
    }

    /// То же с подставным окружением (тесты паритета `Number(env)`).
    pub fn from_env_with(root: &Path, cwd: &Path, env: &dyn Fn(&str) -> Option<String>) -> Self {
        let model = non_empty(env("DND_AI_MODEL")).unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let fallback_models = fallback_models_from(env("DND_AI_FALLBACK_MODELS"), &model);
        let automatic_ai_models: Vec<String> = std::iter::once(model.clone()).chain(fallback_models.iter().cloned()).collect();
        let allowed_ai_models = unique(automatic_ai_models.iter().cloned().chain(SELECTABLE_EXTRA_MODELS.iter().map(|model| model.to_string())));
        let base_url = non_empty(env("ROUTERAI_BASE_URL")).unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let base_url = base_url.strip_suffix('/').map_or_else(|| base_url.clone(), str::to_string);
        let storage_dir = non_empty(env("DND_STORAGE_DIR")).map_or_else(|| cwd.join("storage"), |dir| absolute(cwd, Path::new(&dir)));
        Self {
            host: non_empty(env("AGENT_HOST")).unwrap_or_else(|| "0.0.0.0".to_string()),
            port: env_number(env, "AGENT_PORT", 8787.0),
            storage_dir,
            dist_dir: root.join("dist"),
            admin_setup_token: non_empty(env("ADMIN_SETUP_TOKEN")).unwrap_or_default(),
            cookie_secure: env("COOKIE_SECURE").as_deref() == Some("true"),
            api_key: non_empty(env("ROUTERAI_API_KEY")).unwrap_or_default(),
            base_url,
            model,
            fallback_models,
            automatic_ai_models,
            allowed_ai_models,
            ai_max_tokens: env_number(env, "DND_AI_MAX_TOKENS", 1200.0),
            ai_model_timeout_ms: env_number(env, "DND_AI_MODEL_TIMEOUT_MS", 9_000.0),
            ai_probe_timeout_ms: env_number(env, "DND_AI_PROBE_TIMEOUT_MS", 15_000.0),
            ai_failure_cooldown_ms: env_number(env, "DND_AI_FAILURE_COOLDOWN_MS", 120_000.0),
            ai_daily_token_limit: env_number(env, "DND_AI_DAILY_TOKEN_LIMIT", 2_000_000.0),
            lore_model: non_empty(env("DND_AI_LORE_MODEL")).unwrap_or_else(|| DEFAULT_LORE_MODEL.to_string()),
            combat_turn_timeout_ms: env_number(env, "DND_COMBAT_TURN_TIMEOUT_MS", 120_000.0),
            image_model: non_empty(env("DND_IMAGE_MODEL")).unwrap_or_else(|| DEFAULT_IMAGE_MODEL.to_string()),
            runtime_image_generation: ["on", "true", "1", "yes"].contains(&lowered(env("DND_RUNTIME_IMAGE_GENERATION")).as_str()),
            architect_alert_threshold: env_number(env, "DND_ARCHITECT_ALERT_THRESHOLD", sk_agents_base::architect_usage::DEFAULT_ARCHITECT_ALERT_THRESHOLD as f64),
            default_ruleset_id: non_empty(env("DND_DEFAULT_RULESET_ID")).unwrap_or_else(|| LEGACY_DEFAULT_RULESET_ID.to_string()),
            default_ruleset_version: non_empty(env("DND_DEFAULT_RULESET_VERSION")).unwrap_or_else(|| DEFAULT_RULESET_VERSION.to_string()),
            map_library: lowered(env("DND_MAP_LIBRARY")) == "on",
            recap_gap_hours: env_number(env, "DND_RECAP_GAP_HOURS", sk_agents::campaign_recap::DEFAULT_RECAP_GAP_HOURS),
            corpus_dir: non_empty(env("DND_CORPUS_DIR")).unwrap_or_default(),
            whisper_executable: env("DND_WHISPER_EXECUTABLE"),
            whisper_model: env("DND_WHISPER_MODEL"),
        }
    }

    /// Тестовые настройки: всё — умолчания JS, хранилище и клиент — в `dir`,
    /// ключа модели нет, адрес модели — локальный и никуда не ведёт.
    /// Окружение процесса не читается.
    pub fn for_tests(dir: &Path) -> Self {
        let mut config = Self::from_env_with(dir, dir, &|_| None);
        config.host = "127.0.0.1".to_string();
        config.port = 0.0;
        config.storage_dir = dir.join("storage");
        config.dist_dir = dir.join("dist");
        config.api_key = String::new();
        config.base_url = "http://127.0.0.1:9/never".to_string();
        config
    }

    /// Есть ли ключ модели (`Boolean(apiKey)`); значение не раскрывается.
    pub fn model_configured(&self) -> bool {
        !self.api_key.is_empty()
    }
}

/// `path.resolve(cwd, dir)` без обращения к диску.
fn absolute(cwd: &Path, dir: &Path) -> PathBuf {
    if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        cwd.join(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = vars.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
        Config::from_env_with(Path::new("/root"), Path::new("/cwd"), &move |name| map.get(name).cloned())
    }

    #[test]
    fn numbers_follow_js_number_with_or() {
        let defaults = config(&[]);
        assert_eq!(defaults.port, 8787.0);
        assert_eq!(defaults.ai_max_tokens, 1200.0);
        let empty = config(&[("AGENT_PORT", ""), ("DND_AI_MAX_TOKENS", "")]);
        assert_eq!(empty.port, 8787.0, "пустая строка — умолчание, как `||`");
        let zero = config(&[("DND_AI_MAX_TOKENS", "0"), ("DND_RECAP_GAP_HOURS", " 0x10 ")]);
        assert_eq!(zero.ai_max_tokens, 0.0, "'0' — истинная строка, Number('0') = 0");
        assert_eq!(zero.recap_gap_hours, 16.0);
        assert!(config(&[("DND_AI_MAX_TOKENS", "много")]).ai_max_tokens.is_nan());
    }

    #[test]
    fn models_and_flags() {
        let config = config(&[
            ("DND_AI_MODEL", "a/x"),
            ("DND_AI_FALLBACK_MODELS", " b/y ,a/x,,b/y,c,d,e,f,g"),
            ("ROUTERAI_BASE_URL", "http://local//"),
            ("DND_RUNTIME_IMAGE_GENERATION", " YES "),
            ("DND_MAP_LIBRARY", "On"),
            ("COOKIE_SECURE", "TRUE"),
            ("DND_STORAGE_DIR", "data"),
            ("DND_CORPUS_DIR", "corpus"),
            ("DND_DEFAULT_RULESET_VERSION", "5.2.2"),
        ]);
        assert_eq!(config.fallback_models, ["b/y", "c", "d", "e", "f"]);
        assert_eq!(config.allowed_ai_models[..6], ["a/x", "b/y", "c", "d", "e", "f"]);
        assert!(config.allowed_ai_models.contains(&"openai/gpt-6-luna-pro".to_string()));
        assert_eq!(config.base_url, "http://local/", "снимается один завершающий слэш");
        assert!(config.runtime_image_generation);
        assert!(config.map_library);
        assert!(!config.cookie_secure, "COOKIE_SECURE сравнивается точно");
        assert_eq!(config.storage_dir, Path::new("/cwd").join("data"));
        assert_eq!(config.corpus_dir, "corpus");
        assert_eq!(config.default_ruleset_version, "5.2.2");
        assert_eq!(config.default_ruleset_id, "srd_5_2_1");
    }

    #[test]
    fn test_config_ignores_process_environment() {
        let dir = Path::new("/tmp/x");
        let config = Config::for_tests(dir);
        assert!(config.api_key.is_empty());
        assert!(config.base_url.starts_with("http://127.0.0.1:"));
        assert!(!format!("{config:?}").contains("<скрыт>"));
    }
}
