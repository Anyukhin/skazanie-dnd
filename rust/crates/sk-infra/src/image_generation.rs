//! Единственный путь к картиночной модели провайдера — перенос
//! `server/image-generation.mjs`.
//!
//! Раньше контракт запроса жил внутри `npc-portraits.mjs`, и всякий, кому нужна
//! была картинка другого формата, обязан был написать свой `fetch` — то есть
//! второй авторитетный путь к той же модели. Здесь он один: адрес, заголовки,
//! тайм-аут, разбор ответа и проверка формата. Сеть — за трейтом
//! [`ImageHttpTransport`] (в JS — внедряемый `fetchImpl`).
//!
//! Формат проверяется по сигнатуре файла, а не по слову провайдера: `webp` в
//! поле `output_format` — это просьба, а не гарантия, и подсунутый вместо
//! картинки HTML или JSON должен отсекаться до записи на диск.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::support::{base64_decode_lenient, field, nullish, utf16_len};

/// Потолок одного изображения. Восемь мегабайт — это уже не портрет, а ошибка.
pub const IMAGE_GENERATION_MAX_BYTES: usize = 8 * 1024 * 1024;

/// `bytes.subarray(a, b).toString('ascii')` Node снимает старший бит каждого
/// байта — сигнатура сравнивается так же.
fn ascii_equals(bytes: &[u8], expected: &[u8]) -> bool {
    bytes.len() == expected.len() && bytes.iter().zip(expected).all(|(byte, wanted)| byte & 0x7f == *wanted)
}

/// Заголовок RIFF/WEBP: байты 0..4 и 8..12.
pub fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && ascii_equals(&bytes[0..4], b"RIFF") && ascii_equals(&bytes[8..12], b"WEBP")
}

/// Восьмибайтная сигнатура PNG.
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
}

/// Формат из таблицы `IMAGE_FORMATS` JS. Поле `contentType` той таблицы
/// генератор не читает, поэтому здесь его нет.
struct ImageFormat {
    matches: fn(&[u8]) -> bool,
}

fn image_format(name: &str) -> Option<ImageFormat> {
    match name {
        "webp" => Some(ImageFormat { matches: is_webp }),
        "png" => Some(ImageFormat { matches: is_png }),
        _ => None,
    }
}

/// Картинка и расход поставщика.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub usage: Map<String, Value>,
}

/// Запрос `POST {baseUrl}/images`.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub timeout_ms: u64,
}

/// Ответ поставщика: код и тело.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Сбой транспорта (сеть, тайм-аут): имя ошибки, как у `fetch` (`TypeError`,
/// `TimeoutError`, …), и текст.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct ImageTransportError {
    pub name: String,
    pub message: String,
}

/// Будущее транспорта.
pub type ImageFuture<'a> = Pin<Box<dyn Future<Output = Result<ImageHttpResponse, ImageTransportError>> + Send + 'a>>;

/// HTTP-транспорт генератора (`fetchImpl`).
pub trait ImageHttpTransport: Send + Sync {
    fn post(&self, request: ImageHttpRequest) -> ImageFuture<'_>;
}

/// Ошибка генератора; тексты — как в JS.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ImageGenerationError {
    #[error("Неизвестный формат изображения: {0}")]
    UnknownFormat(String),
    #[error(transparent)]
    Transport(ImageTransportError),
    #[error("Генератор изображений ответил {0}")]
    Status(u16),
    /// Тело ответа — не JSON (`response.json()` бросает `SyntaxError`).
    #[error("{0}")]
    InvalidJson(String),
    #[error("Генератор изображений вернул некорректный размер")]
    InvalidSize,
    #[error("Генератор изображений вернул файл неподдерживаемого формата")]
    UnsupportedFormat,
}

impl ImageGenerationError {
    /// `error.name` (кода у этих ошибок в JS нет: вызывающие пишут в ledger
    /// `error.code ?? error.name`).
    pub fn name(&self) -> &str {
        match self {
            ImageGenerationError::Transport(error) => &error.name,
            ImageGenerationError::InvalidJson(_) => "SyntaxError",
            _ => "Error",
        }
    }
}

/// Настройки `createRouterImageGenerator({ … })`.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterImageGeneratorOptions {
    pub base_url: String,
    pub api_key: String,
    pub timeout_ms: u64,
    pub output_format: String,
    pub aspect_ratio: String,
    pub resolution: String,
    pub quality: String,
    pub max_bytes: usize,
}

impl Default for RouterImageGeneratorOptions {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_key: String::new(),
            timeout_ms: 120_000,
            output_format: "webp".into(),
            aspect_ratio: "1:1".into(),
            resolution: "1K".into(),
            quality: "low".into(),
            max_bytes: IMAGE_GENERATION_MAX_BYTES,
        }
    }
}

/// Клиент `POST {baseUrl}/images` (`createRouterImageGenerator`): в JS
/// возвращается функция генерации, здесь — значение с методом `generate`.
pub struct RouterImageGenerator {
    options: RouterImageGeneratorOptions,
    format: ImageFormat,
    endpoint: String,
    transport: Arc<dyn ImageHttpTransport>,
}

/// `createRouterImageGenerator(options)`.
pub fn create_router_image_generator(options: RouterImageGeneratorOptions, transport: Arc<dyn ImageHttpTransport>) -> Result<RouterImageGenerator, ImageGenerationError> {
    let format = image_format(&options.output_format).ok_or_else(|| ImageGenerationError::UnknownFormat(options.output_format.clone()))?;
    let endpoint = format!("{}/images", options.base_url.trim_end_matches('/'));
    Ok(RouterImageGenerator { options, format, endpoint, transport })
}

impl RouterImageGenerator {
    /// Адрес запроса.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// `generator({ prompt, model })`.
    pub async fn generate(&self, prompt: &str, model: &str) -> Result<GeneratedImage, ImageGenerationError> {
        let options = &self.options;
        let body = crate::support::stringify(&json!({
            "model": model,
            "prompt": prompt,
            "n": 1,
            "aspect_ratio": options.aspect_ratio,
            "resolution": options.resolution,
            "quality": options.quality,
            "output_format": options.output_format,
        }));
        let request = ImageHttpRequest {
            url: self.endpoint.clone(),
            headers: vec![("Content-Type".into(), "application/json".into()), ("Authorization".into(), format!("Bearer {}", options.api_key))],
            body,
            timeout_ms: options.timeout_ms,
        };
        let response = self.transport.post(request).await.map_err(ImageGenerationError::Transport)?;
        if !(200..300).contains(&response.status) {
            return Err(ImageGenerationError::Status(response.status));
        }
        // `response.json()`: UTF-8 с заменой неверных байтов, BOM снимается.
        let text = String::from_utf8_lossy(&response.body);
        let payload: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).map_err(|error| ImageGenerationError::InvalidJson(error.to_string()))?;
        let data = field(Some(&payload), "data");
        let first = match data {
            Some(Value::Array(items)) => items.first(),
            other => field(other, "0"),
        };
        let encoded = match field(first, "b64_json") {
            Some(Value::String(text)) => text.as_str(),
            _ => "",
        };
        let limit = (options.max_bytes as f64 * 4.0 / 3.0).ceil() + 16.0;
        if encoded.is_empty() || utf16_len(encoded) as f64 > limit {
            return Err(ImageGenerationError::InvalidSize);
        }
        let bytes = base64_decode_lenient(encoded);
        if !(self.format.matches)(&bytes) || bytes.len() > options.max_bytes {
            return Err(ImageGenerationError::UnsupportedFormat);
        }
        let mut usage = match field(Some(&payload), "usage") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        let provider_cost = nullish(field(Some(&payload), "cost"), nullish(usage.get("cost"), usage.get("total_cost"))).cloned();
        if let Some(cost) = provider_cost.filter(|cost| js::present(Some(cost))) {
            usage.insert("cost".into(), cost);
        }
        Ok(GeneratedImage { bytes, usage })
    }
}
