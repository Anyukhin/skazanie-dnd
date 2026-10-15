//! Локальный поставщик картинок — перенос части `server/image-generation.mjs`
//! (`createLocalImageGenerator`, `localImageServerHealth`, выбор поставщика по
//! окружению): сервер FLUX 3 Image Klein на своей видеокарте
//! (`tools/image-server`, `docs/local-image-generation.md`).
//!
//! Контракт тот же, что у [`crate::image_generation::RouterImageGenerator`]:
//! картинка проверяется по сигнатуре и потолку размера, расход — ноль рублей,
//! но вызов всё равно идёт в учёт. Недоступный сервер — отказ с кодом, а не
//! тихий переход на платного поставщика.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::image_generation::{is_png, is_webp, GeneratedImage, ImageHttpRequest, ImageHttpTransport, IMAGE_GENERATION_MAX_BYTES};
use crate::support::{base64_decode_lenient, field, utf16_len};

/// Модель локального сервера — для учёта расхода и подписи картинки.
pub const LOCAL_IMAGE_MODEL: &str = "local/flux-3-image-klein";

/// Адрес по умолчанию (`pnpm dev` на той же машине).
pub const DEFAULT_LOCAL_IMAGE_URL: &str = "http://127.0.0.1:8790";

/// Размер кадра по соотношению сторон (`LOCAL_IMAGE_SIZES`): стороны кратны 32.
pub fn local_image_size(aspect_ratio: &str) -> Option<(u32, u32)> {
    match aspect_ratio {
        "1:1" => Some((1024, 1024)),
        "16:9" => Some((1344, 768)),
        _ => None,
    }
}

/// Отказ локального поставщика: ошибка настройки (в JS — `Error` при создании)
/// или отказ сервера с машинным кодом (`LocalImageServerError`).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LocalImageError {
    #[error("{0}")]
    Config(String),
    #[error("{message}")]
    Server { code: String, message: String },
}

impl LocalImageError {
    fn server(code: &str, message: &str) -> Self {
        Self::Server { code: code.into(), message: message.into() }
    }

    /// Код для учёта расхода и ответа игре (`error.code`).
    pub fn code(&self) -> &str {
        match self {
            Self::Config(_) => "Error",
            Self::Server { code, .. } => code,
        }
    }
}

/// Настройки `createLocalImageGenerator({ … })`.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalImageGeneratorOptions {
    pub base_url: String,
    pub token: String,
    pub timeout_ms: u64,
    pub output_format: String,
    pub aspect_ratio: String,
    pub steps: Option<i64>,
    pub max_bytes: usize,
}

impl Default for LocalImageGeneratorOptions {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_LOCAL_IMAGE_URL.into(),
            token: String::new(),
            timeout_ms: 180_000,
            output_format: "webp".into(),
            aspect_ratio: "1:1".into(),
            steps: None,
            max_bytes: IMAGE_GENERATION_MAX_BYTES,
        }
    }
}

/// Клиент `POST {baseUrl}/v1/images`.
pub struct LocalImageGenerator {
    options: LocalImageGeneratorOptions,
    matches: fn(&[u8]) -> bool,
    size: (u32, u32),
    endpoint: String,
    transport: Arc<dyn ImageHttpTransport>,
}

fn trimmed_base(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

/// `createLocalImageGenerator(options)`.
pub fn create_local_image_generator(options: LocalImageGeneratorOptions, transport: Arc<dyn ImageHttpTransport>) -> Result<LocalImageGenerator, LocalImageError> {
    let matches: fn(&[u8]) -> bool = match options.output_format.as_str() {
        "webp" => is_webp,
        "png" => is_png,
        other => return Err(LocalImageError::Config(format!("Неизвестный формат изображения: {other}"))),
    };
    let size = local_image_size(&options.aspect_ratio).ok_or_else(|| LocalImageError::Config(format!("Неизвестное соотношение сторон: {}", options.aspect_ratio)))?;
    let endpoint = format!("{}/v1/images", trimmed_base(&options.base_url));
    Ok(LocalImageGenerator { options, matches, size, endpoint, transport })
}

fn headers(token: &str, json_body: bool) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    if json_body {
        headers.push(("Content-Type".into(), "application/json".into()));
    }
    if !token.is_empty() {
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    headers
}

/// `response.json().catch(() => null)`.
fn json_or_null(body: &[u8]) -> Value {
    let text = String::from_utf8_lossy(body);
    serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).unwrap_or(Value::Null)
}

/// `/^[A-Z_]{3,64}$/u` — код ответа сервера, которому можно верить.
fn server_code(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|code| (3..=64).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_uppercase() || byte == b'_'))
}

impl LocalImageGenerator {
    /// Адрес запроса.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// `generator({ prompt, seed })`: `seed` уходит только целым неотрицательным.
    pub async fn generate(&self, prompt: &str, seed: Option<i64>) -> Result<GeneratedImage, LocalImageError> {
        let options = &self.options;
        let mut body = Map::new();
        body.insert("prompt".into(), json!(prompt));
        body.insert("width".into(), json!(self.size.0));
        body.insert("height".into(), json!(self.size.1));
        body.insert("output_format".into(), json!(options.output_format));
        if let Some(steps) = options.steps.filter(|steps| steps.unsigned_abs() <= 9_007_199_254_740_991) {
            body.insert("steps".into(), json!(steps));
        }
        if let Some(seed) = seed.filter(|seed| (0..=9_007_199_254_740_991).contains(seed)) {
            body.insert("seed".into(), json!(seed));
        }
        let request = ImageHttpRequest {
            url: self.endpoint.clone(),
            headers: headers(&options.token, true),
            body: js::stringify(&Value::Object(body)),
            timeout_ms: options.timeout_ms,
        };
        let response = match self.transport.post(request).await {
            Ok(response) => response,
            Err(error) if error.name == "TimeoutError" => return Err(LocalImageError::server("LOCAL_IMAGE_SERVER_TIMEOUT", "Локальный сервер картинок не ответил вовремя")),
            Err(_) => return Err(LocalImageError::server("LOCAL_IMAGE_SERVER_UNAVAILABLE", "Локальный сервер картинок недоступен")),
        };
        let payload = json_or_null(&response.body);
        if !(200..300).contains(&response.status) {
            let code = server_code(field(Some(&payload), "code")).unwrap_or("LOCAL_IMAGE_SERVER_ERROR");
            return Err(LocalImageError::server(code, &format!("Локальный сервер картинок ответил {}", response.status)));
        }
        let encoded = match field(Some(&payload), "b64_json") {
            Some(Value::String(text)) => text.as_str(),
            _ => "",
        };
        let limit = (options.max_bytes as f64 * 4.0 / 3.0).ceil() + 16.0;
        if encoded.is_empty() || utf16_len(encoded) as f64 > limit {
            return Err(LocalImageError::server("LOCAL_IMAGE_INVALID_RESPONSE", "Локальный сервер картинок вернул некорректный размер"));
        }
        let bytes = base64_decode_lenient(encoded);
        if !(self.matches)(&bytes) || bytes.len() > options.max_bytes {
            return Err(LocalImageError::server("LOCAL_IMAGE_INVALID_RESPONSE", "Локальный сервер картинок вернул файл неподдерживаемого формата"));
        }
        let mut usage = Map::new();
        usage.insert("cost".into(), json!(0));
        usage.insert("provider".into(), json!("local"));
        let elapsed = js::number(field(Some(&payload), "elapsed_ms"));
        if elapsed.is_finite() && elapsed >= 0.0 {
            usage.insert("elapsed_ms".into(), js::num(js::round(elapsed)));
        }
        Ok(GeneratedImage { bytes, usage })
    }
}

/// Состояние локального сервера для админа (`localImageServerHealth`):
/// статус, видеокарта, очередь, последние замеры; описаний и картинок нет.
pub async fn local_image_server_health(transport: &dyn ImageHttpTransport, base_url: &str, token: &str, timeout_ms: u64) -> Value {
    let request = ImageHttpRequest { url: format!("{}/health", trimmed_base(base_url)), headers: headers(token, false), body: String::new(), timeout_ms };
    let Ok(response) = transport.get(request).await else {
        return json!({ "status": "unreachable" });
    };
    if response.status == 401 {
        return json!({ "status": "unauthorized" });
    }
    let payload = json_or_null(&response.body);
    // `typeof payload === 'object'` в JS пропускает и массив: у него нет полей.
    let empty = Map::new();
    let map = match &payload {
        Value::Object(map) if (200..300).contains(&response.status) => map,
        Value::Array(_) if (200..300).contains(&response.status) => &empty,
        _ => return json!({ "status": "error", "http_status": response.status }),
    };
    let mut health = Map::new();
    let status = map.get("status").and_then(Value::as_str).filter(|status| ["loading", "ready", "error"].contains(status)).unwrap_or("error");
    health.insert("status".into(), json!(status));
    for key in ["device", "vram_total_mb", "vram_free_mb", "queue", "queue_limit", "generated", "loaded_in_ms", "last_elapsed_ms"] {
        match map.get(key) {
            Some(Value::Number(number)) if number.as_f64().is_some_and(f64::is_finite) => {
                health.insert(key.into(), Value::Number(number.clone()));
            }
            Some(Value::String(text)) if key == "device" => {
                health.insert(key.into(), json!(sk_core::text::slice(text, 0, Some(80))));
            }
            _ => {}
        }
    }
    if let Some(Value::String(error)) = map.get("error") {
        health.insert("error".into(), json!(sk_core::text::slice(error, 0, Some(300))));
    }
    Value::Object(health)
}

/// Кто рисует (`DND_IMAGE_PROVIDER`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProviderKind {
    RouterAi,
    Local,
}

impl ImageProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RouterAi => "routerai",
            Self::Local => "local",
        }
    }
}

/// Поставщик по окружению (`imageProviderFromEnv`) без самих генераторов:
/// их строит сервер под формат и кадр каждого сервиса.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageProviderSettings {
    pub provider: ImageProviderKind,
    pub model: String,
    pub configured: bool,
    pub runtime_generation: bool,
    pub local_url: String,
    pub local_token: String,
    pub local_steps: Option<i64>,
}

impl ImageProviderSettings {
    /// `env` — чтение переменной окружения; `api_key` и `image_model` — RouterAI.
    pub fn from_env(env: impl Fn(&str) -> Option<String>, api_key: &str, image_model: &str) -> Result<Self, String> {
        let read = |key: &str| sk_core::text::trim(&env(key).unwrap_or_default()).to_string();
        let requested = read("DND_IMAGE_PROVIDER").to_lowercase();
        let runtime = read("DND_RUNTIME_IMAGE_GENERATION").to_lowercase();
        if requested == "local" {
            let url = read("DND_LOCAL_IMAGE_URL");
            let steps = js::parse_number(&env("DND_LOCAL_IMAGE_STEPS").unwrap_or_default());
            return Ok(Self {
                provider: ImageProviderKind::Local,
                model: LOCAL_IMAGE_MODEL.into(),
                configured: true,
                runtime_generation: !["off", "false", "0", "no"].contains(&runtime.as_str()),
                local_url: if url.is_empty() { DEFAULT_LOCAL_IMAGE_URL.into() } else { url },
                local_token: read("DND_LOCAL_IMAGE_TOKEN"),
                local_steps: (steps.fract() == 0.0 && steps > 0.0 && steps <= 9_007_199_254_740_991.0).then_some(steps as i64),
            });
        }
        if !requested.is_empty() && requested != "routerai" {
            return Err(format!("Неизвестный поставщик картинок DND_IMAGE_PROVIDER={requested}"));
        }
        Ok(Self {
            provider: ImageProviderKind::RouterAi,
            model: image_model.into(),
            configured: !api_key.is_empty() && !image_model.is_empty(),
            runtime_generation: ["on", "true", "1", "yes"].contains(&runtime.as_str()),
            local_url: String::new(),
            local_token: String::new(),
            local_steps: None,
        })
    }

    /// Настройки локального генератора под кадр и формат сервиса.
    pub fn local_options(&self, aspect_ratio: &str, output_format: &str, max_bytes: usize) -> LocalImageGeneratorOptions {
        LocalImageGeneratorOptions {
            base_url: self.local_url.clone(),
            token: self.local_token.clone(),
            aspect_ratio: aspect_ratio.into(),
            output_format: output_format.into(),
            max_bytes,
            steps: self.local_steps,
            ..LocalImageGeneratorOptions::default()
        }
    }
}
