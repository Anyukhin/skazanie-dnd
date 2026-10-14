//! `image_generation`: проверка сигнатур и генератора (из
//! `test/enemy-portrait-tool.test.mjs` — отказ по сигнатуре) и сверка с
//! эталоном JS (`fixtures/gen-image-generation.mjs`).

mod common;

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::{json, Value};
use sk_infra::image_generation::{
    create_router_image_generator, is_png, is_webp, ImageFuture, ImageGenerationError, ImageHttpRequest, ImageHttpResponse, ImageHttpTransport, RouterImageGeneratorOptions,
    IMAGE_GENERATION_MAX_BYTES,
};

use common::{fixture_path, same_json};

const WEBP_HEX: &str = "524946460400000057454250";

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex")).collect()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Транспорт из сценария: отвечает заданным, запросы записывает.
struct Scripted {
    response: ImageHttpResponse,
    requests: Mutex<Vec<ImageHttpRequest>>,
}

impl ImageHttpTransport for Scripted {
    fn post(&self, request: ImageHttpRequest) -> ImageFuture<'_> {
        self.requests.lock().expect("запросы").push(request);
        let response = self.response.clone();
        Box::pin(async move { Ok(response) })
    }
}

fn scripted(status: u16, body: &str) -> Arc<Scripted> {
    Arc::new(Scripted { response: ImageHttpResponse { status, body: body.as_bytes().to_vec() }, requests: Mutex::new(Vec::new()) })
}

#[test]
fn signatures_are_checked_by_bytes() {
    let webp = hex(WEBP_HEX);
    assert!(is_webp(&webp));
    assert!(!is_png(&webp));
    assert!(is_png(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert!(!is_webp(&webp[..11]));
    assert!(!is_webp(b"<html>not an image</html>"));
    // Node сравнивает `toString('ascii')`, а он снимает старший бит.
    let mut high = webp.clone();
    high[0] |= 0x80;
    assert!(is_webp(&high));
    assert_eq!(IMAGE_GENERATION_MAX_BYTES, 8 * 1024 * 1024);
}

#[tokio::test]
async fn webp_instead_of_png_is_rejected_by_signature_not_by_provider_word() {
    let transport = scripted(200, &json!({ "data": [{ "b64_json": b64(&hex(WEBP_HEX)) }] }).to_string());
    let generator = create_router_image_generator(
        RouterImageGeneratorOptions { base_url: "https://images.example/v1".into(), api_key: "fake-key".into(), output_format: "png".into(), ..RouterImageGeneratorOptions::default() },
        transport,
    )
    .expect("генератор");
    let error = generator.generate("p", "m").await.expect_err("отказ");
    assert!(error.to_string().contains("неподдерживаемого формата"));
}

#[tokio::test]
async fn request_contract_and_usage_with_cost() {
    let transport = scripted(200, &json!({ "data": [{ "b64_json": b64(&hex(WEBP_HEX)) }], "usage": { "total_tokens": 12 }, "cost": 0.4 }).to_string());
    let generator = create_router_image_generator(
        RouterImageGeneratorOptions { base_url: "https://images.example/v1//".into(), api_key: "fake-key".into(), ..RouterImageGeneratorOptions::default() },
        Arc::clone(&transport) as Arc<dyn ImageHttpTransport>,
    )
    .expect("генератор");
    assert_eq!(generator.endpoint(), "https://images.example/v1/images");
    let image = generator.generate("портрет", "openai/gpt-image-1").await.expect("картинка");
    assert_eq!(image.bytes, hex(WEBP_HEX));
    assert_eq!(Value::Object(image.usage), json!({ "total_tokens": 12, "cost": 0.4 }));
    let requests = transport.requests.lock().expect("запросы");
    assert_eq!(requests[0].headers, [("Content-Type".to_string(), "application/json".to_string()), ("Authorization".to_string(), "Bearer fake-key".to_string())]);
    assert_eq!(requests[0].timeout_ms, 120_000);
    assert_eq!(
        serde_json::from_str::<Value>(&requests[0].body).expect("json"),
        json!({ "model": "openai/gpt-image-1", "prompt": "портрет", "n": 1, "aspect_ratio": "1:1", "resolution": "1K", "quality": "low", "output_format": "webp" })
    );
}

#[tokio::test]
async fn provider_errors_keep_js_texts() {
    let options = || RouterImageGeneratorOptions { base_url: "https://images.example/v1".into(), api_key: "k".into(), ..RouterImageGeneratorOptions::default() };
    let status = create_router_image_generator(options(), scripted(503, "{}")).expect("генератор").generate("p", "m").await.expect_err("503");
    assert_eq!(status.to_string(), "Генератор изображений ответил 503");
    let size = create_router_image_generator(options(), scripted(200, "{\"data\":[{}]}")).expect("генератор").generate("p", "m").await.expect_err("пусто");
    assert_eq!(size, ImageGenerationError::InvalidSize);
    assert_eq!(size.to_string(), "Генератор изображений вернул некорректный размер");
    let garbage = create_router_image_generator(options(), scripted(200, "<html>")).expect("генератор").generate("p", "m").await.expect_err("не JSON");
    assert_eq!(garbage.name(), "SyntaxError");
    let unknown = create_router_image_generator(RouterImageGeneratorOptions { output_format: "gif".into(), ..options() }, scripted(200, "{}")).err().expect("формат");
    assert_eq!(unknown.to_string(), "Неизвестный формат изображения: gif");
}

#[test]
fn signatures_match_js() {
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(fixture_path("image-generation.json")).expect("эталон")).expect("json");
    let cases = fixture["signatures"].as_array().expect("сигнатуры");
    for case in cases {
        let bytes = base64::engine::general_purpose::STANDARD.decode(case["bytes"].as_str().expect("байты")).expect("base64");
        assert_eq!(Value::Bool(is_webp(&bytes)), case["is_webp"], "{case}");
        assert_eq!(Value::Bool(is_png(&bytes)), case["is_png"], "{case}");
    }
    assert!(cases.len() >= 400);
}

#[tokio::test]
async fn generator_matches_js() {
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(fixture_path("image-generation.json")).expect("эталон")).expect("json");
    let cases = fixture["generators"].as_array().expect("ответы");
    for (index, case) in cases.iter().enumerate() {
        let options = &case["options"];
        let transport = Arc::new(Scripted {
            response: ImageHttpResponse { status: case["response"]["status"].as_u64().expect("код") as u16, body: case["response"]["body"].as_str().expect("тело").as_bytes().to_vec() },
            requests: Mutex::new(Vec::new()),
        });
        let text = |key: &str| options[key].as_str().expect("строка").to_string();
        let created = create_router_image_generator(
            RouterImageGeneratorOptions {
                base_url: text("baseUrl"),
                api_key: text("apiKey"),
                timeout_ms: options["timeoutMs"].as_u64().expect("тайм-аут"),
                output_format: text("outputFormat"),
                aspect_ratio: text("aspectRatio"),
                resolution: text("resolution"),
                quality: text("quality"),
                max_bytes: options["maxBytes"].as_u64().expect("предел") as usize,
            },
            Arc::clone(&transport) as Arc<dyn ImageHttpTransport>,
        );
        let outcome = match created {
            Ok(generator) => generator.generate(case["prompt"].as_str().expect("подсказка"), case["model"].as_str().expect("модель")).await,
            Err(error) => Err(error),
        };
        let place = format!("ответ {index}");
        match (outcome, case.get("error")) {
            (Ok(image), None) => {
                let expected = &case["result"];
                assert_eq!(b64(&image.bytes), expected["bytes"].as_str().expect("байты"), "{place}: байты");
                assert!(same_json(&Value::Object(image.usage.clone()), &expected["usage"]), "{place}: usage {:?} вместо {}", image.usage, expected["usage"]);
            }
            (Err(error), Some(expected)) => {
                assert_eq!(error.name(), expected["name"].as_str().expect("имя"), "{place}: имя");
                // Текст `SyntaxError` — от разборщика JSON, у V8 и serde он свой.
                if error.name() != "SyntaxError" {
                    assert_eq!(error.to_string(), expected["message"].as_str().expect("текст"), "{place}: текст");
                }
            }
            (actual, expected) => panic!("{place}: Rust {actual:?}, JS {expected:?}"),
        }
        let requests = transport.requests.lock().expect("запросы");
        let expected_requests = case["requests"].as_array().expect("запросы");
        assert_eq!(requests.len(), expected_requests.len(), "{place}: число запросов");
        for (request, expected) in requests.iter().zip(expected_requests) {
            assert_eq!(request.url, expected["url"].as_str().expect("адрес"), "{place}: адрес");
            assert_eq!(request.body, expected["body"].as_str().expect("тело"), "{place}: тело");
            let headers: Vec<Value> = request.headers.iter().map(|(name, value)| json!([name, value])).collect();
            assert_eq!(Value::from(headers), expected["headers"], "{place}: заголовки");
            assert_eq!(expected["method"], "POST");
        }
    }
    assert!(cases.len() >= 500);
}
