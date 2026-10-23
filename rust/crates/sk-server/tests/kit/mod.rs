//! Тестовый набор sk-server (С2) — по образцу `test/kit/` JS
//! (`http.mjs:334–426`, `llm.mjs:151–291`):
//!
//! - [`TestServer`] — настоящий сервер на случайном порту `127.0.0.1` и во
//!   временном каталоге. Окружение процесса не читается (`Config::for_tests`):
//!   ключа модели нет, адрес модели локальный; клиент модели по умолчанию —
//!   [`llm::ForbiddenLlm`] через учёт расхода; кости детерминированы
//!   ([`dice`]). Соединения обслуживает тот же цикл, что у боевого сервера
//!   (`sk_server::serve`), на своём потоке; уничтожение останавливает его,
//!   ядро и только затем удаляет каталог;
//! - [`client`] — сырой HTTP/1.1-клиент с cookie;
//! - [`dice`] — кости: фиксированные, очередь, правила `skazanie.test-dice/1`;
//! - [`llm`] — заглушки модели (`forbiddenLlm`, `scriptedLlm`);
//! - [`fake_provider`] — локальный провайдер RouterAI (`startFakeProvider`);
//! - [`golden`] — эталоны «Г», снятые с JS-сервера;
//! - [`RecordingStreams`] — заглушка реестра потоков, запоминает вызовы.
//!
//! Сбои журнала (`skazanie.test-faults/1`) ставятся опцией [`Options::faults`]
//! в ядро этого сервера; выходы `exit-*` в процессе теста не применимы — их
//! проверяют контрактные тесты JS против бинаря.

#![allow(dead_code)] // набор общий для нескольких файлов тестов

pub mod client;
pub mod dice;
pub mod fake_provider;
pub mod golden;
pub mod llm;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sk_agents_base::llm_client::{RouterAiClient, RouterAiClientConfig};
use sk_core::indexmap::IndexSet;
use sk_dice::Dice;
use sk_server::dispatch::Route;
use sk_server::state::{LlmClients, Metered};
use sk_server::streams::{Presence, StreamRegistry};
use sk_server::test_hooks::CommitFaults;
use sk_server::{AppState, Config, Injected};

#[allow(unused_imports)] // не каждый файл тестов берёт всё
pub use client::{Client, Req, TestResponse, CLIENT_TIMEOUT};
pub use llm::ForbiddenLlm;

/// Реестр потоков, который запоминает вызовы.
#[derive(Default)]
pub struct RecordingStreams {
    pub revoked: Mutex<Vec<String>>,
    pub refreshed: Mutex<Vec<String>>,
}

impl Presence for RecordingStreams {
    fn connected_hero_ids(&self, _campaign_id: &str) -> IndexSet<String> {
        IndexSet::new()
    }
}

impl StreamRegistry for RecordingStreams {
    fn revoke_for_session(&self, session_key: &str) {
        self.revoked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session_key.to_string());
    }

    fn refresh_for_user(&self, user_id: &str) {
        self.refreshed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(user_id.to_string());
    }
}

/// Какой клиент модели получает сервер (всегда через учёт расхода).
pub enum Model {
    /// Обращение к модели — ошибка (`forbiddenLlm`), по умолчанию.
    Forbidden,
    /// Ответы по сценарию; тест держит ссылку и видит вызовы.
    Scripted(Arc<llm::ScriptedLlm>),
    /// Настоящий `RouterAiClient` против локальной заглушки провайдера:
    /// сервер видит ключ (`configured: true`), запросы уходят только на
    /// `127.0.0.1`.
    Provider { base_url: String, model: String },
    /// Без клиентов вовсе (демо-режим).
    None,
}

/// Настройки запуска.
pub struct Options {
    /// Создать `dist/` с `index.html` и чанком.
    pub dist: bool,
    pub admin_setup_token: String,
    pub extra_routes: Vec<Route>,
    /// Кости; `None` — каждая грань 10 (`dice::fixed(10)`).
    pub dice: Option<Box<dyn Dice + Send>>,
    pub model: Model,
    /// Сбои журнала этого сервера (`skazanie.test-faults/1`).
    pub faults: Option<CommitFaults>,
    /// Последняя правка настроек перед `AppState::open` (переменные
    /// сервера, которые JS-тест передал бы через `env`).
    pub configure: Option<Box<dyn FnOnce(&mut Config)>>,
}

impl Default for Options {
    fn default() -> Self {
        Self { dist: true, admin_setup_token: "setup-code".into(), extra_routes: Vec::new(), dice: None, model: Model::Forbidden, faults: None, configure: None }
    }
}

impl Options {
    /// Сервер с клиентом модели против заглушки провайдера.
    pub fn provider(provider: &fake_provider::FakeProvider, model: &str) -> Self {
        Self { model: Model::Provider { base_url: provider.base_url(), model: model.into() }, ..Self::default() }
    }

    /// Сбои из JSON (`format` можно опустить).
    pub fn with_faults(mut self, spec: serde_json::Value) -> Self {
        let mut spec = spec;
        if let Some(map) = spec.as_object_mut() {
            map.entry("format").or_insert_with(|| serde_json::Value::from(sk_server::test_hooks::FAULTS_FORMAT));
        }
        self.faults = Some(CommitFaults::parse(&spec.to_string()).unwrap_or_else(|error| panic!("сбои: {error}")));
        self
    }
}

/// Содержимое `secret.txt` рядом с `dist/`: его не должна отдать раздача клиента.
pub const SECRET: &str = "секрет-вне-dist";

/// Тестовый сервер. Порядок полей важен: каталог уничтожается последним,
/// после ядра и состояния (на Windows открытая база не даёт его удалить).
pub struct TestServer {
    pub state: Arc<AppState>,
    pub streams: Arc<RecordingStreams>,
    pub addr: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub dir: tempfile::TempDir,
}

pub fn write_dist(dir: &Path) {
    std::fs::create_dir_all(dir.join("dist").join("assets")).expect("dist");
    std::fs::write(dir.join("dist").join("index.html"), "<!doctype html><title>Сказание</title>").expect("index");
    std::fs::write(dir.join("dist").join("assets").join("main-abcdef12.js"), "console.log(1)").expect("чанк");
    std::fs::write(dir.join("secret.txt"), SECRET).expect("секрет");
}

/// Клиенты модели по выбору теста — единственное место набора, где
/// собирается `RouterAiClient` (сторож — `tests/model_clients_guard.rs`).
fn model_clients(model: Model, config: &mut Config) -> sk_server::state::LlmFactory {
    match model {
        Model::Forbidden => Box::new(|ledger| Ok(LlmClients { llm: Some(Metered::wrap(ForbiddenLlm, ledger)), lore: Some(Metered::wrap(ForbiddenLlm, ledger)) })),
        Model::Scripted(llm) => Box::new(move |ledger| Ok(LlmClients { llm: Some(Metered::wrap(llm.clone(), ledger)), lore: Some(Metered::wrap(llm, ledger)) })),
        Model::None => Box::new(|_| Ok(LlmClients::default())),
        Model::Provider { base_url, model } => {
            assert!(fake_provider::is_local_provider_url(&base_url), "тестовый сервер не ходит во внешнюю сеть: {base_url}");
            config.api_key = fake_provider::FAKE_PROVIDER_KEY.into();
            config.base_url = base_url.clone();
            config.model = model.clone();
            config.fallback_models.clear();
            Box::new(move |ledger| {
                let client = RouterAiClient::new(RouterAiClientConfig {
                    api_key: Some(fake_provider::FAKE_PROVIDER_KEY.into()),
                    base_url: Some(base_url),
                    model: Some(model),
                    timeout_ms: Some(5_000.0),
                    ..RouterAiClientConfig::default()
                })
                .map_err(|error| error.to_string())?;
                let metered = Metered::wrap(client, ledger);
                Ok(LlmClients { llm: Some(metered.clone()), lore: Some(metered) })
            })
        }
    }
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with(Options::default()).await
    }

    pub async fn start_with(options: Options) -> Self {
        let dir = tempfile::tempdir().expect("временный каталог");
        if options.dist {
            write_dist(dir.path());
        }
        let mut config = Config::for_tests(dir.path());
        config.admin_setup_token = options.admin_setup_token;
        let llm = model_clients(options.model, &mut config);
        if let Some(configure) = options.configure {
            configure(&mut config);
        }
        let streams = Arc::new(RecordingStreams::default());
        let recorder = streams.clone();
        let injected = Injected {
            dice: Some(options.dice.unwrap_or_else(|| dice::fixed(10))),
            llm: Some(llm),
            clock: None,
            streams: Some(Box::new(move || Box::new(recorder) as Box<dyn StreamRegistry>)),
            extra_routes: options.extra_routes,
        };
        let state = Arc::new(AppState::open(config, injected).expect("состояние сервера"));
        if options.faults.is_some() {
            sk_server::test_hooks::install(&state.core, options.faults).await.expect("сбои журнала в ядро");
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("порт");
        listener.set_nonblocking(true).expect("неблокирующий порт");
        let addr = listener.local_addr().expect("адрес");
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = state.clone();
        let thread = std::thread::Builder::new()
            .name("test-http".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("рантайм HTTP");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).expect("порт в рантайме");
                    sk_server::serve::serve(listener, served, async move { stopped.await.ok() }, |_| std::time::Duration::from_secs(1)).await;
                });
                runtime.shutdown_timeout(std::time::Duration::from_secs(1));
            })
            .expect("поток HTTP");
        Self { state, streams, addr, stop: Some(stop), thread: Some(thread), dir }
    }

    pub fn client(&self) -> Client {
        Client::new(self.addr)
    }

    pub fn storage(&self) -> PathBuf {
        self.dir.path().join("storage")
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        // Порядок остановки как в `main.rs`: приём и соединения, затем ядро;
        // поля (`state`, затем `dir`) уничтожаются уже после.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.state.core.shutdown();
    }
}
