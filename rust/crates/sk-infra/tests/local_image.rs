//! Локальный поставщик картинок против эталона JS
//! (`fixtures/gen-local-image.mjs`): запрос к серверу FLUX, разбор ответа,
//! состояние сервера и выбор поставщика по окружению.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{json, Value};
use sk_infra::image_generation::{ImageFuture, ImageHttpRequest, ImageHttpResponse, ImageHttpTransport, ImageTransportError};
use sk_infra::local_image::{create_local_image_generator, local_image_server_health, ImageProviderKind, ImageProviderSettings, LocalImageError, LocalImageGeneratorOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/local-image.json")).expect("эталон"));

/// Транспорт из сценария эталона: отвечает телом или сбоем сети, запросы пишет.
struct Scripted {
    reply: Value,
    requests: Mutex<Vec<ImageHttpRequest>>,
}

impl Scripted {
    fn new(reply: &Value) -> Arc<Self> {
        Arc::new(Self { reply: reply.clone(), requests: Mutex::new(Vec::new()) })
    }

    fn answer(&self, request: ImageHttpRequest) -> ImageFuture<'_> {
        self.requests.lock().expect("запросы").push(request);
        let reply = self.reply.clone();
        Box::pin(async move {
            if let Some(name) = reply["transport"].as_str() {
                return Err(ImageTransportError { name: name.into(), message: "сбой".into() });
            }
            Ok(ImageHttpResponse { status: reply["status"].as_u64().unwrap_or(200) as u16, body: reply["body"].as_str().unwrap_or_default().as_bytes().to_vec() })
        })
    }

    fn request_json(&self) -> Value {
        let requests = self.requests.lock().expect("запросы");
        match requests.first() {
            Some(request) => json!({ "url": request.url, "headers": request.headers.iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(), "body": request.body }),
            None => Value::Null,
        }
    }
}

impl ImageHttpTransport for Scripted {
    fn post(&self, request: ImageHttpRequest) -> ImageFuture<'_> {
        self.answer(request)
    }

    fn get(&self, request: ImageHttpRequest) -> ImageFuture<'_> {
        self.answer(request)
    }
}

/// Запрос JS без метода: `{url, headers, body}`.
fn js_request(recorded: &Value) -> Value {
    if recorded.is_null() {
        return Value::Null;
    }
    json!({ "url": recorded["url"], "headers": recorded["headers"], "body": recorded["body"] })
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().build().expect("рантайм").block_on(future)
}

fn options_from(value: &Value) -> LocalImageGeneratorOptions {
    let mut options = LocalImageGeneratorOptions { base_url: value["baseUrl"].as_str().unwrap_or_default().into(), ..LocalImageGeneratorOptions::default() };
    if let Some(token) = value["token"].as_str() {
        options.token = token.into();
    }
    if let Some(format) = value["outputFormat"].as_str() {
        options.output_format = format.into();
    }
    if let Some(aspect) = value["aspectRatio"].as_str() {
        options.aspect_ratio = aspect.into();
    }
    // `Number.isSafeInteger(steps)` в JS: дробные шаги не уходят вовсе.
    options.steps = value["steps"].as_i64();
    if let Some(bytes) = value["maxBytes"].as_u64() {
        options.max_bytes = bytes as usize;
    }
    options
}

fn error_json(error: &LocalImageError) -> Value {
    json!({ "name": "LocalImageServerError", "code": error.code(), "message": error.to_string() })
}

#[test]
fn generation_matches_js() {
    let cases = FIXTURE["generate"].as_array().expect("генерации");
    assert!(cases.len() >= 500);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let transport = Scripted::new(&case["reply"]);
        let generator = create_local_image_generator(options_from(&case["options"]), transport.clone()).expect("настройки");
        let seed = case["seed"].as_i64();
        let actual = match block_on(generator.generate("Трактир «Пьяный гусь» вечером", seed)) {
            Ok(image) => json!({ "bytes": image.bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>(), "usage": image.usage }),
            Err(error) => json!({ "error": error_json(&error) }),
        };
        let request = transport.request_json();
        if actual != case["result"] || request != js_request(&case["request"]) {
            failures.push(format!("#{index}: ожидалось {} / {}\nполучено {} / {}", case["result"], js_request(&case["request"]), actual, request));
        }
    }
    assert!(failures.is_empty(), "{} расхождений:\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn bad_options_are_refused_like_js() {
    for case in FIXTURE["configErrors"].as_array().expect("настройки") {
        let options = options_from(&case["options"]);
        let error = create_local_image_generator(options, Scripted::new(&json!({}))).err().map(|error| error.to_string());
        assert_eq!(error.as_deref(), case["error"].as_str(), "{}", case["options"]);
    }
}

#[test]
fn health_matches_js() {
    for (index, case) in FIXTURE["health"].as_array().expect("состояния").iter().enumerate() {
        let transport = Scripted::new(&case["reply"]);
        let actual = block_on(local_image_server_health(transport.as_ref(), "http://127.0.0.1:8790/", case["token"].as_str().unwrap_or_default(), 3_000));
        assert_eq!(actual, case["result"], "#{index}: {}", case["reply"]);
        assert_eq!(transport.request_json(), js_request(&case["request"]), "#{index}: запрос");
    }
}

#[test]
fn provider_from_env_matches_js() {
    for (index, case) in FIXTURE["providers"].as_array().expect("окружения").iter().enumerate() {
        let env: HashMap<String, String> = case["env"].as_object().expect("окружение").iter().map(|(key, value)| (key.clone(), value.as_str().unwrap_or_default().to_string())).collect();
        let api_key = case["routerai"]["apiKey"].as_str().unwrap_or_default();
        let model = case["routerai"]["imageModel"].as_str().unwrap_or_default();
        let settings = ImageProviderSettings::from_env(|key| env.get(key).cloned(), api_key, model);
        let actual = match settings {
            Err(message) => json!({ "error": message }),
            Ok(settings) => {
                let local = if settings.provider == ImageProviderKind::Local {
                    let transport = Scripted::new(&json!({ "status": 200, "body": json!({ "b64_json": "UklGRgQAAABXRUJQ" }).to_string() }));
                    let generator = create_local_image_generator(settings.local_options("16:9", "webp", 1024), transport.clone()).expect("генератор");
                    block_on(generator.generate("Мост", None)).expect("картинка");
                    let request = transport.request_json();
                    json!({ "url": request["url"], "body": serde_json::from_str::<Value>(request["body"].as_str().unwrap_or("null")).expect("тело"), "headers": request["headers"] })
                } else {
                    Value::Null
                };
                json!({ "provider": settings.provider.as_str(), "model": settings.model, "configured": settings.configured, "runtimeGeneration": settings.runtime_generation, "local": local })
            }
        };
        assert_eq!(actual, case["result"], "#{index}: {} {}", case["env"], case["routerai"]);
    }
}
