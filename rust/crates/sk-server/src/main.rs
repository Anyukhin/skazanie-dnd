//! Запуск сервера «Сказания»: `skazanie-server [корень-проекта]` — перенос
//! верхушки и хвоста `server/index.mjs` (1, 202–240, 287–310, 6481–6505).
//!
//! Порядок как в JS:
//!
//! 1. `.env` из текущего каталога (`import 'dotenv/config'`, строка 1):
//!    уже заданные переменные не перекрываются. Крейта `dotenvy` нет в
//!    офлайн-кэше, поэтому разборщик свой — только здесь, тесты его не видят;
//! 2. отметка писателя storage — **до** первой записи (236–240);
//! 3. клиенты модели — только здесь (AGENTS §4), сразу через учёт расхода;
//! 4. сверка проекций и резервов бросков (С1), затем `listen`;
//! 5. через 250 мс — фоновые толчки боя и часов (С17).
//!
//! Сигналы. JS на SIGINT/SIGTERM делает `process.exit(130/143)` без плавной
//! остановки. Здесь: приём соединений прекращается, текущие запросы
//! дожидаются до 5 с, ядро останавливается, отметка снимается, код выхода
//! тот же. **Отклонение для Windows:** SIGTERM там нет; `Ctrl+C` даёт 130, а
//! закрытие консоли и выключение системы (`ctrl_close`, `ctrl_shutdown`) —
//! 143, как SIGTERM.
//!
//! Тайм-ауты соединения (6485–6488): `headersTimeout` 66 с — предел чтения
//! заголовков (у hyper он же ограничивает простой соединения keep-alive,
//! поэтому отдельного `keepAliveTimeout` 65 с нет — простаивающее соединение
//! закрывается через 66 с). HTTP/2 не поддерживается, как и в JS.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use hyper_util::rt::{TokioIo, TokioTimer};
use sk_agents_base::llm_client::{RouterAiClient, RouterAiClientConfig};
use sk_infra::usage_ledger::DurableUsageLedger;
use sk_server::state::{LlmClients, Metered};
use sk_server::{app, AppState, Config, Injected};
use tower::ServiceExt;

/// `.env` по правилам пакета `dotenv`: `KEY=VALUE`, необязательный `export`,
/// комментарии `#`, значения в кавычках (`\n` раскрывается в двойных).
fn load_dotenv(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, raw)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-') {
            continue;
        }
        let raw = raw.trim();
        let value = match raw.chars().next() {
            Some(quote @ ('"' | '\'' | '`')) if raw.len() >= 2 && raw.ends_with(quote) => {
                let inner = &raw[1..raw.len() - 1];
                if quote == '"' {
                    inner.replace("\\n", "\n").replace("\\r", "\r")
                } else {
                    inner.to_string()
                }
            }
            _ => raw.split(" #").next().unwrap_or("").trim().to_string(),
        };
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

/// Клиенты модели (`index.mjs:296–310, 409–418`).
fn build_models(config: &Config, ledger: &Arc<DurableUsageLedger>) -> Result<LlmClients, String> {
    let router = |model: &str, timeout_ms: f64| -> Result<RouterAiClient, String> {
        RouterAiClient::new(RouterAiClientConfig {
            api_key: Some(config.api_key.clone()),
            base_url: Some(config.base_url.clone()),
            model: Some(model.to_string()),
            max_tokens: Some(config.ai_max_tokens),
            reasoning: sk_narration_base::model_style_profiles::reasoning_profile_for(Some(model)),
            timeout_ms: Some(timeout_ms),
            ..RouterAiClientConfig::default()
        })
        .map_err(|error| error.to_string())
    };
    let mut automatic = Vec::new();
    let mut selectable = Vec::new();
    for model in &config.allowed_ai_models {
        let client = Metered::wrap(router(model, config.ai_model_timeout_ms)?, ledger);
        if config.automatic_ai_models.contains(model) {
            automatic.push(client);
        } else {
            selectable.push(client);
        }
    }
    let llm = Metered::cascade(automatic, selectable, config.ai_probe_timeout_ms, config.ai_failure_cooldown_ms).map_err(|error| error.to_string())?;
    let lore = Metered::wrap(router(&config.lore_model, 30_000.0)?, ledger);
    Ok(LlmClients { llm: Some(llm), lore: Some(lore) })
}

/// Порт как `server.listen(Number(...))`: целое 0..65535, иначе отказ.
fn listen_port(port: f64) -> Result<u16, String> {
    if port.is_finite() && port.fract() == 0.0 && (0.0..=65_535.0).contains(&port) {
        Ok(port as u16)
    } else {
        Err(format!("Некорректный AGENT_PORT: {port}"))
    }
}

/// Сигнал остановки и код выхода (130 — SIGINT/Ctrl+C, 143 — SIGTERM).
async fn shutdown_signal() -> i32 {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            let _ = tokio::signal::ctrl_c().await;
            return 130;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => 130,
            _ = terminate.recv() => 143,
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows::{ctrl_close, ctrl_shutdown};
        let close = ctrl_close();
        let shutdown = ctrl_shutdown();
        match (close, shutdown) {
            (Ok(mut close), Ok(mut shutdown)) => tokio::select! {
                _ = tokio::signal::ctrl_c() => 130,
                _ = close.recv() => 143,
                _ = shutdown.recv() => 143,
            },
            _ => {
                let _ = tokio::signal::ctrl_c().await;
                130
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = tokio::signal::ctrl_c().await;
        130
    }
}

fn fail(message: String) -> ! {
    eprintln!("[Сказание] {message}");
    std::process::exit(1);
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    load_dotenv(&cwd.join(".env"));
    let root = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| cwd.clone());
    let config = Config::from_env(&root);
    let port = listen_port(config.port).unwrap_or_else(|error| fail(error));
    if let Err(error) = std::fs::create_dir_all(&config.storage_dir) {
        fail(format!("Не удалось создать каталог хранилища: {error}"));
    }
    // Аудит PR #131, RCV-05: отметка писателя — до первой записи в storage.
    let mut writer = sk_infra::backup_service::claim_storage_writer(&config.storage_dir, Default::default()).unwrap_or_else(|error| fail(format!("Не удалось отметить писателя storage: {error}")));
    let address = format!("{}:{port}", config.host);
    let banner = if config.model_configured() { format!("{} + {} fallback models", config.model, config.fallback_models.len()) } else { "демо-режим".to_string() };
    let factory_config = config.clone();
    let injected = Injected { llm: Some(Box::new(move |ledger| build_models(&factory_config, ledger))), ..Injected::default() };
    let state = match AppState::open(config, injected) {
        Ok(state) => Arc::new(state),
        Err(error) => {
            writer.release();
            fail(format!("Не удалось открыть хранилище: {error}"));
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|error| fail(format!("Не удалось запустить рантайм: {error}")));
    let code = runtime.block_on(serve(state.clone(), address, banner));
    state.core.shutdown();
    writer.release();
    std::process::exit(code);
}

async fn serve(state: Arc<AppState>, address: String, banner: String) -> i32 {
    // `void llmClient.probe()` при наличии ключа (309).
    if state.config.model_configured() {
        if let Some(llm) = state.models.llm.clone() {
            tokio::spawn(async move {
                let _ = llm.client().probe().await;
            });
        }
    }
    // С1: `reconcileAllCampaignProjections()` и `releaseOrphanRollReservations()`
    // (6481–6482) до `listen`.
    let reconciled = state.core.call(|core| Box::pin(async move { sk_server::projection::reconcile_all_campaign_projections(core).await })).await;
    if let Ok(Err(error)) | Err(error) = reconciled.map_err(sk_server::error::Failure::from) {
        eprintln!("[Сказание] Сверка проекций при старте не выполнена: {error}");
    }
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[Сказание] Не удалось занять {address}: {error}");
            return 1;
        }
    };
    println!("[Сказание] Сервер: http://{address} · {banner}");
    // Через 250 мс — фоновые толчки (6489–6504): боевой координатор и часы
    // мира (С17), домашние правила по умолчанию (С1). Точка подключения.
    {
        let state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let _ = state.core.call(|core| Box::pin(async move { sk_server::room::list_room_codes(&core).map(|codes| codes.len()) })).await;
        });
    }
    let router = app(state);
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let code = loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let router = router.clone();
                let service = hyper::service::service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
                    request.extensions_mut().insert(axum::extract::ConnectInfo(peer));
                    router.clone().oneshot(request.map(axum::body::Body::new))
                });
                let connection = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(66))
                    .keep_alive(true)
                    .serve_connection(TokioIo::new(stream), service);
                let watched = graceful.watch(connection);
                tokio::spawn(async move {
                    let _ = watched.await;
                });
            }
            code = &mut signal => break code,
        }
    };
    drop(listener);
    let _ = tokio::time::timeout(Duration::from_secs(5), graceful.shutdown()).await;
    code
}
