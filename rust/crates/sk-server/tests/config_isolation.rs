//! Сторож «тестовый Config не наследует окружение процесса» (план С2,
//! закрыт в С0, рецензия F3). Отдельный файл — отдельный процесс: окружение
//! меняется до первого чтения, гонок с другими тестами нет.

mod kit;

use std::path::Path;

use sk_server::Config;

const LEAKS: [(&str, &str); 9] = [
    ("ROUTERAI_API_KEY", "sk-test-leak"),
    ("ROUTERAI_BASE_URL", "https://example.invalid"),
    ("DND_AI_MODEL", "leak/model"),
    ("DND_AI_FALLBACK_MODELS", "leak/fallback"),
    ("ADMIN_SETUP_TOKEN", "leak"),
    ("DND_AI_DAILY_TOKEN_LIMIT", "1"),
    ("DND_MAP_LIBRARY", "on"),
    ("COOKIE_SECURE", "true"),
    ("DND_RUNTIME_IMAGE_GENERATION", "yes"),
];

#[tokio::test]
async fn test_config_and_server_ignore_process_environment() {
    for (name, value) in LEAKS {
        std::env::set_var(name, value);
    }
    let config = Config::for_tests(Path::new("/tmp/isolated"));
    let reference = Config::from_env_with(Path::new("/tmp/isolated"), Path::new("/tmp/isolated"), &|_| None);
    assert!(config.api_key.is_empty(), "ключ модели не унаследован");
    assert!(config.base_url.starts_with("http://127.0.0.1:"), "адрес модели — локальный");
    assert_eq!(config.model, "openai/gpt-6-luna");
    assert_eq!(config.fallback_models, reference.fallback_models);
    assert!(!config.fallback_models.iter().any(|model| model.starts_with("leak/")));
    assert_eq!(config.admin_setup_token, "");
    assert_eq!(config.ai_daily_token_limit, reference.ai_daily_token_limit);
    assert!(!config.map_library && !config.cookie_secure && !config.runtime_image_generation);
    assert_eq!(config.storage_dir, Path::new("/tmp/isolated").join("storage"));

    let server = kit::TestServer::start().await;
    let health = server.client().get("/api/health").await.json();
    assert_eq!(health["configured"], false, "тестовый сервер — без ключа модели");
    assert_eq!(health["model"], "openai/gpt-6-luna");
}
