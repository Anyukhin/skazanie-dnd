//! Сверка `npc_portraits` с эталоном JS (`fixtures/npc-portraits.json`,
//! генератор — `fixtures/gen-npc-portraits.mjs`) и перенесённые проверки из
//! `test/npc-portraits.test.mjs`, `test/npc-portrait-assets.test.mjs`,
//! `test/asset-preparation.test.mjs` (портретная часть) и
//! `test/authored-world-npcs.test.mjs` (набор предзаготовленных портретов).
//! Генерация — заглушкой трейта, ключей и сети нет.

mod common;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::images::{ledger, ledger_summary, relative, relative_result, service_error, webp, Scripted};
use common::{check, ok, ok_or_null, Args, Outcome};
use serde_json::{json, Value};
use sk_chargen::npc_portraits::{self as m, ImageGeneratorSource, ImageUsageLedger, NpcPortraitRequest, NpcPortraitResult, NpcPortraitService, NpcPortraitServiceOptions};
use sk_infra::image_generation::{ImageFuture, ImageHttpRequest, ImageHttpResponse, ImageHttpTransport, RouterImageGeneratorOptions};

const NOW: &str = "2026-07-31T12:00:00.000Z";

fn service(storage: &Path, model: &str, api_key: &str, generator: Arc<Scripted>, usage_ledger: Option<Arc<dyn ImageUsageLedger>>) -> NpcPortraitService {
    NpcPortraitService::new(NpcPortraitServiceOptions {
        storage_dir: storage.to_path_buf(),
        image_model: model.into(),
        api_key: api_key.into(),
        base_url: String::new(),
        generator: ImageGeneratorSource::Generator(generator),
        usage_ledger,
    })
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("рантайм")
}

/// Сценарий сервиса — то же, что `scenario(input)` генератора эталона.
async fn scenario(input: &Value) -> Value {
    let directory = tempfile::tempdir().expect("каталог");
    let storage = directory.path();
    let generator = Scripted::new(input["generator"].as_str().unwrap_or_default());
    let ledger_file = storage.join("engine").join("usage.json");
    let usage_ledger = input["ledger"].as_f64().map(|limit| ledger(&ledger_file, limit, NOW));
    let service = service(
        storage,
        input["imageModel"].as_str().unwrap_or_default(),
        input["apiKey"].as_str().unwrap_or_default(),
        Arc::clone(&generator),
        usage_ledger.clone().map(|ledger| ledger as Arc<dyn ImageUsageLedger>),
    );
    let campaign = input["campaignId"].as_str().unwrap_or_default();
    let profile = &input["profile"];
    let location = m::npc_portrait_cache_location(&storage.join("generated").join("npcs"), Some(&json!(campaign)), profile.get("id")).ok();
    if let (Some(location), Some(kind)) = (&location, input["precache"].as_str()) {
        std::fs::create_dir_all(&location.directory).expect("каталог кеша");
        std::fs::write(&location.file_path, if kind == "webp" { webp() } else { "<html>страница ошибки</html>".as_bytes().to_vec() }).expect("файл кеша");
    }
    let allow = input["allowGeneration"] == true;
    let allow_generation = move || allow;
    let outcome = if input["mode"] == "prepare" {
        service.prepare(campaign, profile).await.map(|portrait| portrait.to_json())
    } else {
        let request = NpcPortraitRequest { campaign_id: campaign, profile, projected_state: &input["projectedState"], allow_generation: &allow_generation, generation_enabled: input["generationEnabled"] == true };
        service.resolve(request).await.map(|result| result.to_json())
    };
    let (result, error) = match outcome {
        Ok(result) => (relative_result(result, storage), Value::Null),
        Err(error) => (Value::Null, service_error(&error)),
    };
    let prompts: Vec<Value> = generator.calls().iter().map(|call| json!({ "model": call.model, "prompt_length": sk_narration_base::jsx::utf16_len(&call.prompt) })).collect();
    json!({
        "result": result,
        "error": error,
        "prompts": prompts,
        "file_exists": location.as_ref().is_some_and(|location| location.file_path.exists()),
        "ledger": usage_ledger.map_or(Value::Null, |ledger| ledger_summary(&ledger, &ledger_file)),
    })
}

fn cache_location_relative(args: &Args) -> Outcome {
    let base = std::env::temp_dir().join("sk-chargen-portrait-root");
    match m::npc_portrait_cache_location(&base, args.get(0), args.get(1)) {
        Ok(location) => ok(json!({ "key": location.key, "file": relative(&location.root, &location.file_path), "directory": relative(&location.root, &location.directory) })),
        Err(error) => Err(common::error("Error", None, &error.to_string())),
    }
}

fn reason(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("prepared_asset") => "prepared_asset",
        Some("generator_unavailable") => "generator_unavailable",
        Some("generation_failed") => "generation_failed",
        Some("runtime_generation_disabled") => "runtime_generation_disabled",
        _ => "secondary_npc",
    }
}

#[test]
fn matches_js_fixture() {
    let runtime = runtime();
    let cases = check(include_str!("../fixtures/npc-portraits.json"), |name, args| match name {
        "const:NPC_PORTRAIT_GENERATION_LIMIT" => ok(json!(m::NPC_PORTRAIT_GENERATION_LIMIT)),
        "const:NPC_PORTRAIT_MAX_BYTES" => ok(json!(m::NPC_PORTRAIT_MAX_BYTES)),
        "const:NPC_PORTRAIT_ROLE_ASSETS" => ok(m::npc_portrait_role_assets_json()),
        "const:NPC_PORTRAIT_CHARACTER_ASSETS" => ok(m::npc_portrait_character_assets_json()),
        "publicNpcPortraitProfile" => ok_or_null(m::public_npc_portrait_profile(args.get(0))),
        "visibleNpcPortraitProfile" => ok_or_null(m::visible_npc_portrait_profile(args.get(0).unwrap_or(&Value::Null), args.get(1))),
        "npcPortraitSignificance" => ok(m::npc_portrait_significance(args.get(0).unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null)).to_json()),
        "npcPortraitRole" => ok(json!(m::npc_portrait_role(args.get(0).unwrap_or(&Value::Null)))),
        "staticNpcPortrait" => ok(NpcPortraitResult::Static(m::static_npc_portrait(args.get(0).unwrap_or(&Value::Null), reason(args.get(1)))).to_json()),
        "buildNpcPortraitPrompt" => ok(json!(m::build_npc_portrait_prompt(args.get(0).unwrap_or(&Value::Null)))),
        "cacheLocationRelative" => cache_location_relative(args),
        "serviceScenario" => ok(runtime.block_on(scenario(args.get(0).unwrap_or(&Value::Null)))),
        other => panic!("неизвестный случай {other}"),
    });
    assert!(cases > 2_000, "{cases}");
}

// --- test/npc-portraits.test.mjs ---

fn profile(overrides: Value) -> Value {
    let mut base = json!({
        "id": "npc:marta", "name": "Марта", "role": "merchant", "public_summary": "Осторожная торговка со старым шрамом.", "tags": [],
        "goals": ["PRIVATE_GOAL"], "beliefs": ["PRIVATE_BELIEF"], "gm_notes": "GM_ONLY_NOTE",
    });
    for (key, value) in overrides.as_object().cloned().unwrap_or_default() {
        base[key] = value;
    }
    m::public_npc_portrait_profile(Some(&base)).expect("профиль")
}

fn projected(npc: &Value, overrides: Value) -> Value {
    let id = npc["id"].as_str().expect("id");
    let mut social = json!({ "npcs": [npc], "conversations": [], "promises": [], "relationships": { id: { "hero:ada": 0 } } });
    for (key, value) in overrides["social"].as_object().cloned().unwrap_or_default() {
        social[key] = value;
    }
    json!({ "social": social, "merchants": overrides.get("merchants").cloned().unwrap_or_else(|| json!([])) })
}

#[test]
fn portrait_takes_only_public_fields_and_builds_bounded_prompt() {
    let safe = profile(json!({}));
    let mut keys: Vec<&String> = safe.as_object().expect("объект").keys().collect();
    keys.sort();
    assert_eq!(keys, ["id", "name", "public_summary", "role", "tags"]);
    let prompt = m::build_npc_portrait_prompt(&safe);
    assert!(prompt.contains("Марта") && prompt.contains("Осторожная торговка"));
    for private in ["PRIVATE_GOAL", "PRIVATE_BELIEF", "GM_ONLY_NOTE", "goals", "beliefs", "gm_notes"] {
        assert!(!prompt.contains(private), "{private}");
    }
    assert!(sk_narration_base::jsx::utf16_len(&prompt) < 1_400);
}

#[test]
fn visibility_and_significance_come_only_from_projection() {
    let minor = profile(json!({ "role": "baker" }));
    let state = projected(&minor, json!({}));
    assert_eq!(m::visible_npc_portrait_profile(&state, Some(&json!("npc:marta"))).map(|profile| profile["name"].clone()), Some(json!("Марта")));
    assert_eq!(m::visible_npc_portrait_profile(&state, Some(&json!("npc:hidden"))), None);
    assert_eq!(m::npc_portrait_significance(&state, &minor).to_json(), json!({ "significant": false, "reasons": [] }));
    let cases = [
        (projected(&minor, json!({ "merchants": [{ "id": "npc:marta" }] })), "merchant"),
        (projected(&minor, json!({ "social": { "conversations": [{ "npc_id": "npc:marta" }] } })), "conversation"),
        (projected(&minor, json!({ "social": { "promises": [{ "npc_id": "npc:marta", "status": "open" }] } })), "open_promise"),
        (projected(&minor, json!({ "social": { "relationships": { "npc:marta": { "hero:ada": -1 } } } })), "relationship"),
    ];
    for (state, reason) in cases {
        let significance = m::npc_portrait_significance(&state, &minor);
        assert!(significance.significant && significance.reasons.contains(&reason), "{reason}");
    }
    let tagged = profile(json!({ "role": "baker", "tags": ["key_npc"] }));
    assert_eq!(m::npc_portrait_significance(&projected(&tagged, json!({})), &tagged).to_json(), json!({ "significant": true, "reasons": ["important_tag"] }));
}

#[tokio::test]
async fn secondary_npc_gets_deterministic_role_without_generator() {
    let directory = tempfile::tempdir().expect("каталог");
    let generator = Scripted::new("ok");
    let service = service(directory.path(), "test/image", "configured", Arc::clone(&generator), None);
    let minor = profile(json!({ "role": "village baker" }));
    let state = projected(&minor, json!({}));
    let result = service.resolve(NpcPortraitRequest::new("CAMP", &minor, &state)).await.expect("портрет");
    assert_eq!(result.to_json(), json!({ "kind": "static", "source": "static", "role": "artisan", "url": "/assets/npcs/roles/artisan.png", "reason": "secondary_npc" }));
    assert!(generator.calls().is_empty());
    assert_eq!(m::npc_portrait_role(&profile(json!({ "role": "captain of the guard" }))), "guard");
    assert_eq!(m::npc_portrait_role(&profile(json!({ "role": "court scholar" }))), "scholar");
}

#[tokio::test]
async fn prepared_npc_gets_authored_portrait_without_runtime_generation() {
    let directory = tempfile::tempdir().expect("каталог");
    let generator = Scripted::new("ok");
    let service = service(directory.path(), "test/image", "configured", Arc::clone(&generator), None);
    assert_eq!(m::NPC_PORTRAIT_CHARACTER_ASSETS.len(), 8);
    for (id, url) in m::NPC_PORTRAIT_CHARACTER_ASSETS {
        let authored = m::public_npc_portrait_profile(Some(&json!({ "id": id, "name": id, "role": "named NPC", "public_summary": "Авторский персонаж.", "tags": [] }))).expect("профиль");
        assert_eq!(authored["portrait_url"], url, "{id}");
        let state = projected(&authored, json!({}));
        let request = NpcPortraitRequest { generation_enabled: false, ..NpcPortraitRequest::new("ASTOHAN-AUTHORED", &authored, &state) };
        let result = service.resolve(request).await.expect("портрет").to_json();
        assert_eq!((result["kind"].clone(), result["url"].clone(), result["reason"].clone()), (json!("static"), json!(url), json!("prepared_asset")), "{id}");
    }
    assert!(generator.calls().is_empty());
}

#[tokio::test]
async fn significant_npc_is_generated_once_and_read_from_cache_after_restart() {
    let directory = tempfile::tempdir().expect("каталог");
    let storage = directory.path();
    let important = profile(json!({ "tags": ["important"] }));
    let state = projected(&important, json!({}));
    let generator = Scripted::new("ok");
    let first_service = service(storage, "test/image-v1", "configured", Arc::clone(&generator), None);
    let first = first_service.resolve(NpcPortraitRequest::new("CAMP-ONE", &important, &state)).await.expect("портрет").to_json();
    let second = first_service.resolve(NpcPortraitRequest::new("CAMP-ONE", &important, &state)).await.expect("портрет").to_json();
    assert_eq!((first["kind"].clone(), first["cacheHit"].clone()), (json!("generated"), json!(false)));
    assert_eq!((second["kind"].clone(), second["cacheHit"].clone()), (json!("generated"), json!(true)));
    let calls = generator.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].model, "test/image-v1");
    assert!(!calls[0].prompt.contains("PRIVATE_") && !calls[0].prompt.contains("GM_ONLY"));

    let location = m::npc_portrait_cache_location(&storage.join("generated").join("npcs"), Some(&json!("CAMP-ONE")), Some(&important["id"])).expect("путь");
    assert_eq!(std::fs::read(&location.file_path).expect("файл"), webp());
    assert!(location.file_path.is_absolute());
    assert!(location.file_path.starts_with(&location.root));
    let text = location.file_path.to_string_lossy();
    assert!(!text.contains("CAMP-ONE") && !text.contains("npc:marta"));

    let restarted = service(storage, "test/image-v1", "configured", Scripted::new("fail-code"), None);
    let after = restarted.resolve(NpcPortraitRequest::new("CAMP-ONE", &important, &state)).await.expect("портрет").to_json();
    assert_eq!((after["kind"].clone(), after["cacheHit"].clone()), (json!("generated"), json!(true)));
}

#[tokio::test]
async fn usage_ledger_counts_generation_and_failure_but_not_cache_or_static() {
    let directory = tempfile::tempdir().expect("каталог");
    let storage = directory.path();
    let ledger_file = storage.join("engine").join("usage.json");
    let usage = ledger(&ledger_file, 20_000.0, NOW);
    let generator = Scripted::new("ok");
    let service = service(storage, "test/image-metered", "configured", Arc::clone(&generator), Some(usage.clone()));
    let minor = profile(json!({ "id": "npc:minor", "role": "village baker" }));
    let important = profile(json!({ "id": "npc:important", "tags": ["important"] }));
    let minor_state = projected(&minor, json!({}));
    let important_state = projected(&important, json!({}));

    let static_result = service.resolve(NpcPortraitRequest::new("CAMP", &minor, &minor_state)).await.expect("портрет");
    assert!(matches!(static_result, NpcPortraitResult::Static(_)));
    assert_eq!(usage.report().expect("отчёт")["requests"], 0);

    let generated = service.resolve(NpcPortraitRequest::new("CAMP", &important, &important_state)).await.expect("портрет").to_json();
    assert_eq!(generated["cacheHit"], false);
    assert_eq!(
        usage.report().expect("отчёт"),
        json!({
            "day": "2026-07-31", "daily_token_limit": 20_000, "committed_tokens": 12, "reserved_tokens": 0, "input_tokens": 5, "output_tokens": 7,
            "provider_cost": 0.014, "requests": 1, "completed_requests": 1, "failed_requests": 0,
        })
    );
    let cached = service.resolve(NpcPortraitRequest::new("CAMP", &important, &important_state)).await.expect("портрет").to_json();
    assert_eq!(cached["cacheHit"], true);
    assert_eq!(generator.calls().len(), 1);
    assert_eq!(usage.report().expect("отчёт")["requests"], 1);

    generator.set("fail-code");
    let failed = service.resolve(NpcPortraitRequest::new("FAIL", &important, &important_state)).await.expect("портрет").to_json();
    assert_eq!((failed["kind"].clone(), failed["reason"].clone()), (json!("static"), json!("generation_failed")));
    assert_eq!(generator.calls().len(), 2);
    let report = usage.report().expect("отчёт");
    assert_eq!((report["completed_requests"].clone(), report["failed_requests"].clone(), report["reserved_tokens"].clone(), report["provider_cost"].clone()), (json!(1), json!(1), json!(0), json!(0.014)));
    let persisted: Value = serde_json::from_str(&std::fs::read_to_string(&ledger_file).expect("леджер")).expect("json");
    let entries: Vec<&Value> = persisted["requests"].as_object().expect("записи").values().collect();
    assert_eq!(entries.iter().map(|entry| entry["scope"].clone()).collect::<Vec<_>>(), [json!("npc-portrait"), json!("npc-portrait")]);
    assert_eq!(entries.iter().map(|entry| entry["model"].clone()).collect::<Vec<_>>(), [json!("test/image-metered"), json!("test/image-metered")]);
    assert_eq!(entries[1]["error_code"], "IMAGE_PROVIDER_FAILED");
    assert!(!persisted.to_string().contains("Осторожная торговка"));
}

/// Генератор, который ждёт сигнала: так два запроса гарантированно пересекаются.
struct Gated {
    calls: AtomicUsize,
    release: tokio::sync::Notify,
}

impl m::ImageGenerator for Gated {
    fn generate<'a>(&'a self, _prompt: &'a str, _model: &'a str) -> m::GeneratorFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            self.release.notified().await;
            Ok(sk_infra::image_generation::GeneratedImage { bytes: webp(), usage: Default::default() })
        })
    }
}

#[tokio::test]
async fn concurrent_requests_share_one_generation_and_rate_limit_is_checked_only_on_miss() {
    let directory = tempfile::tempdir().expect("каталог");
    let important = profile(json!({ "tags": ["important"] }));
    let state = projected(&important, json!({}));
    let gated = Arc::new(Gated { calls: AtomicUsize::new(0), release: tokio::sync::Notify::new() });
    let service = NpcPortraitService::new(NpcPortraitServiceOptions {
        storage_dir: directory.path().to_path_buf(),
        image_model: "test/image".into(),
        api_key: "configured".into(),
        base_url: String::new(),
        generator: ImageGeneratorSource::Generator(gated.clone()),
        usage_ledger: None,
    });
    let first = service.resolve(NpcPortraitRequest::new("CAMP", &important, &state));
    let second = service.resolve(NpcPortraitRequest::new("CAMP", &important, &state));
    let release = async {
        while gated.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        gated.release.notify_waiters();
    };
    let (first, second, ()) = tokio::join!(first, second, release);
    assert_eq!(gated.calls.load(Ordering::SeqCst), 1);
    assert!([first, second].iter().all(|result| matches!(result, Ok(NpcPortraitResult::Generated(_)))));

    let checks = AtomicUsize::new(0);
    let deny = || {
        checks.fetch_add(1, Ordering::SeqCst);
        false
    };
    let cached = service.resolve(NpcPortraitRequest { allow_generation: &deny, ..NpcPortraitRequest::new("CAMP", &important, &state) }).await.expect("портрет");
    assert!(matches!(cached, NpcPortraitResult::Generated(_)));
    assert_eq!(checks.load(Ordering::SeqCst), 0);
    let blocked = service.resolve(NpcPortraitRequest { allow_generation: &deny, ..NpcPortraitRequest::new("OTHER", &important, &state) }).await.expect("портрет");
    assert_eq!(blocked.to_json(), json!({ "kind": "rate_limited", "source": "rate_limited" }));
    assert_eq!(checks.load(Ordering::SeqCst), 1);
}

/// Транспорт из сценария: отвечает заданным, запросы записывает.
struct Recorded {
    body: String,
    requests: Mutex<Vec<ImageHttpRequest>>,
}

impl ImageHttpTransport for Recorded {
    fn post(&self, request: ImageHttpRequest) -> ImageFuture<'_> {
        self.requests.lock().expect("запросы").push(request);
        let body = self.body.clone().into_bytes();
        Box::pin(async move { Ok(ImageHttpResponse { status: 200, body }) })
    }
}

#[tokio::test]
async fn router_generator_gets_server_owned_image_contract_through_injected_transport() {
    // base64 заголовка RIFF/WEBP из теста JS.
    let body = json!({ "data": [{ "b64_json": "UklGRgQAAABXRUJQ" }], "usage": { "input_tokens": 4, "output_tokens": 8, "total_tokens": 12 }, "cost": 0.025 }).to_string();
    let transport = Arc::new(Recorded { body, requests: Mutex::new(Vec::new()) });
    let options = RouterImageGeneratorOptions { base_url: "https://images.example/v1/".into(), api_key: "fake-key".into(), ..RouterImageGeneratorOptions::default() };
    let generator = m::create_router_npc_portrait_generator(options, transport.clone()).expect("генератор");
    let generated = generator.generate("server prompt", "image/model").await.expect("картинка");
    assert_eq!(generated.bytes, webp());
    assert_eq!(Value::Object(generated.usage), json!({ "input_tokens": 4, "output_tokens": 8, "total_tokens": 12, "cost": 0.025 }));
    let requests = transport.requests.lock().expect("запросы");
    assert_eq!(requests[0].url, "https://images.example/v1/images");
    assert!(requests[0].headers.contains(&("Authorization".to_string(), "Bearer fake-key".to_string())));
    let body: Value = serde_json::from_str(&requests[0].body).expect("тело");
    assert_eq!(body, json!({ "model": "image/model", "prompt": "server prompt", "n": 1, "aspect_ratio": "1:1", "resolution": "1K", "quality": "low", "output_format": "webp" }));
}

#[test]
fn cache_path_does_not_use_campaign_or_npc_as_segments() {
    let root = std::env::temp_dir().join("npc-portrait-root");
    let location = m::npc_portrait_cache_location(&root, Some(&json!("..\\..\\outside")), Some(&json!("../../secret"))).expect("путь");
    assert!(location.file_path.starts_with(&root));
    let text = location.file_path.to_string_lossy();
    assert!(!text.contains("outside") && !text.contains("secret"));
}

#[test]
fn astohan_speakers_get_fitting_role_portraits() {
    let profile = |role: &str, tags: Value| json!({ "id": "x", "name": "x", "role": role, "tags": tags });
    assert_eq!(m::npc_portrait_role(&profile("комендант лагеря Тихой Стражи", json!(["veteran", "commander"]))), "guard");
    assert_eq!(m::npc_portrait_role(&profile("мельник Редстоуновки", json!(["miller", "informant"]))), "artisan");
    assert_eq!(m::npc_portrait_role(&profile("перевозчик Митглайда", json!(["ferryman", "informant"]))), "traveler");
}

#[test]
fn prototype_key_id_is_treated_as_prepared_like_js() {
    let toy = json!({ "id": "toString", "name": "Т", "role": "village baker", "tags": [] });
    let profile = m::public_npc_portrait_profile(Some(&toy)).expect("профиль");
    assert!(profile.get("portrait_url").is_none(), "функция прототипа в JSON пропадает");
    let portrait = m::static_npc_portrait(&profile, "prepared_asset");
    assert_eq!(portrait.url, None);
}

// --- test/npc-portrait-assets.test.mjs ---

fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "ожидался PNG");
    (u32::from_be_bytes(bytes[16..20].try_into().expect("ширина")), u32::from_be_bytes(bytes[20..24].try_into().expect("высота")))
}

fn check_assets(assets: &[(&str, &str)], size: u32, url: impl Fn(&str) -> String) {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let rights: Value = serde_json::from_str(&std::fs::read_to_string(repo.join("data/asset-rights.json")).expect("реестр прав")).expect("json");
    let registered: Vec<&Value> = rights["assets"].as_array().expect("ассеты").iter().collect();
    let mut hashes = HashSet::new();
    for (key, asset) in assets {
        assert_eq!(*asset, url(key));
        let relative = asset.trim_start_matches("/assets/");
        let bytes = std::fs::read(repo.join("public/assets").join(relative)).unwrap_or_else(|_| panic!("{relative}: файла нет"));
        assert_eq!(png_dimensions(&bytes), (size, size), "{relative}: production-размер");
        assert!(bytes.len() >= 20_000, "{relative}: файл подозрительно мал");
        let hash = sk_core::hash::sha256_hex(&bytes);
        assert!(hashes.insert(hash.clone()), "{relative}: изображение дублирует другое");
        let tuple = registered.iter().find(|tuple| tuple[0] == relative).unwrap_or_else(|| panic!("{relative}: не зарегистрирован в data/asset-rights.json"));
        assert_eq!(tuple[1], hash.as_str(), "{relative}: SHA-256 разошёлся с реестром прав");
        assert_eq!(tuple[2], bytes.len(), "{relative}: размер разошёлся с реестром прав");
    }
}

#[test]
fn role_portraits_are_complete_square_unique_and_registered() {
    let mut roles: Vec<&str> = m::NPC_PORTRAIT_ROLE_ASSETS.iter().map(|(role, _)| *role).collect();
    roles.sort_unstable();
    assert_eq!(roles, ["artisan", "commoner", "guard", "merchant", "noble", "priest", "scholar", "traveler"]);
    check_assets(&m::NPC_PORTRAIT_ROLE_ASSETS, 320, |role| format!("/assets/npcs/roles/{role}.png"));
}

#[test]
fn astohan_portraits_are_complete_square_unique_and_registered() {
    let mut ids: Vec<&str> = m::NPC_PORTRAIT_CHARACTER_ASSETS.iter().map(|(id, _)| *id).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["astohan-ares", "astohan-eldrin", "astohan-ivara", "astohan-kaelan", "astohan-lomar", "astohan-mira", "astohan-oren", "astohan-sargat"]);
    check_assets(&m::NPC_PORTRAIT_CHARACTER_ASSETS, 512, |id| format!("/assets/npcs/astohan/{id}-v1.png"));
}

// --- test/asset-preparation.test.mjs (портреты) ---

fn merchant_profile(id: &str, name: &str) -> Value {
    m::public_npc_portrait_profile(Some(&json!({ "id": id, "name": name, "role": "merchant", "public_summary": "Осторожная торговка.", "tags": ["merchant"] }))).expect("профиль")
}

fn merchants(npcs: &[&Value]) -> Value {
    json!({ "social": { "npcs": npcs, "conversations": [], "promises": [], "relationships": {} }, "merchants": npcs.iter().map(|npc| json!({ "id": npc["id"] })).collect::<Vec<_>>() })
}

#[tokio::test]
async fn disabled_runtime_generation_serves_placeholder_and_enabled_one_generates() {
    let directory = tempfile::tempdir().expect("каталог");
    let generator = Scripted::with_usage("ok", json!({ "total_tokens": 12, "cost": 0.4 }));
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Arc::clone(&generator), None);
    let npc = merchant_profile("npc:marta", "Марта");
    let state = merchants(&[&npc]);
    let off = service.resolve(NpcPortraitRequest { generation_enabled: false, ..NpcPortraitRequest::new("PREP", &npc, &state) }).await.expect("портрет").to_json();
    assert!(generator.calls().is_empty(), "модель не должна вызываться при выключенном флаге");
    assert_eq!((off["kind"].clone(), off["reason"].clone()), (json!("static"), json!("runtime_generation_disabled")));
    assert!(off["url"].as_str().is_some_and(|url| url.starts_with("/assets/npcs/roles/")));
    let on = service.resolve(NpcPortraitRequest::new("PREP", &npc, &state)).await.expect("портрет").to_json();
    assert_eq!(generator.calls().len(), 1);
    assert_eq!((on["kind"].clone(), on["cacheHit"].clone()), (json!("generated"), json!(false)));
}

#[tokio::test]
async fn ready_cache_is_served_even_with_generation_disabled_and_preparation_is_metered() {
    let directory = tempfile::tempdir().expect("каталог");
    let ledger_file = directory.path().join("engine").join("usage.json");
    let usage = ledger(&ledger_file, 10_000.0, NOW);
    let generator = Scripted::with_usage("ok", json!({ "total_tokens": 12, "cost": 0.4 }));
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Arc::clone(&generator), Some(usage.clone()));
    let npc = merchant_profile("npc:marta", "Марта");
    let state = merchants(&[&npc]);
    let prepared = service.prepare("PREP", &npc).await.expect("подготовка");
    assert!(!prepared.cache_hit);
    assert_eq!(generator.calls().len(), 1);
    assert_eq!(service.cached("PREP", &npc["id"]).await.expect("кеш").map(|portrait| portrait.cache_hit), Some(true));
    let report = usage.report().expect("отчёт");
    assert_eq!((report["completed_requests"].clone(), report["committed_tokens"].clone(), report["provider_cost"].clone()), (json!(1), json!(12), json!(0.4)));
    let served = service.resolve(NpcPortraitRequest { generation_enabled: false, ..NpcPortraitRequest::new("PREP", &npc, &state) }).await.expect("портрет").to_json();
    assert_eq!((served["kind"].clone(), served["cacheHit"].clone()), (json!("generated"), json!(true)));
    assert_eq!(generator.calls().len(), 1, "второй генерации не случилось");
    let again = service.prepare("PREP", &npc).await.expect("повторная подготовка");
    assert!(!again.cache_hit);
    assert_eq!(generator.calls().len(), 2);
}

#[tokio::test]
async fn preparation_inventory_shows_who_has_no_portrait_yet() {
    let directory = tempfile::tempdir().expect("каталог");
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Scripted::new("ok"), None);
    let first = merchant_profile("npc:bram", "Брам");
    let second = merchant_profile("npc:marta", "Марта");
    service.prepare("PREP", &second).await.expect("подготовка");
    let state = merchants(&[&first, &second]);
    let inventory = sk_infra::asset_preparation::npc_portrait_inventory(&service, "PREP", &state, |_, _| true, &[second.clone(), first.clone()]).await.expect("инвентарь");
    let pairs: Vec<(Value, Value)> = inventory.iter().map(|entry| (entry["id"].clone(), entry["has_portrait"].clone())).collect();
    assert_eq!(pairs, [(json!("npc:bram"), json!(false)), (json!("npc:marta"), json!(true))], "порядок детерминирован, состояние кеша честное");
    let filtered = sk_infra::asset_preparation::npc_portrait_inventory(&service, "PREP", &merchants(&[&first]), |_, _| false, std::slice::from_ref(&first)).await.expect("инвентарь");
    assert!(filtered.is_empty(), "второстепенные NPC в подготовку не попадают");
    // Правило значимости — то же, что в игре.
    let minor = m::public_npc_portrait_profile(Some(&json!({ "id": "npc:minor", "name": "Пекарь", "role": "baker", "tags": [] }))).expect("профиль");
    let significance = |state: &Value, profile: &Value| m::npc_portrait_significance(state, profile).significant;
    let only_marta = sk_infra::asset_preparation::npc_portrait_inventory(&service, "PREP", &json!({}), significance, &[minor, second.clone()]).await.expect("инвентарь");
    assert_eq!(only_marta.iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>(), [json!("npc:marta")]);
    let authored = m::public_npc_portrait_profile(Some(&json!({ "id": "astohan-sargat", "name": "Саргат", "role": "молодой красный дракон", "public_summary": "Авторский дракон.", "tags": ["boss"] }))).expect("профиль");
    let inventory = sk_infra::asset_preparation::npc_portrait_inventory(&service, "ASTOHAN-AUTHORED", &json!({}), |_, _| false, &[authored]).await.expect("инвентарь");
    assert_eq!(inventory.iter().map(|entry| (entry["id"].clone(), entry["has_portrait"].clone())).collect::<Vec<_>>(), [(json!("astohan-sargat"), json!(true))]);
}

#[tokio::test]
async fn unsupported_generator_file_fails_reservation_before_settle() {
    let directory = tempfile::tempdir().expect("каталог");
    let ledger_file = directory.path().join("engine").join("usage.json");
    let usage = ledger(&ledger_file, 10_000.0, NOW);
    let service = service(directory.path(), "test/image", "configured", Scripted::new("html"), Some(usage.clone()));
    let npc = merchant_profile("npc:marta", "Марта");
    let error = service.prepare("PREP", &npc).await.expect_err("отказ");
    assert_eq!(error.to_string(), "Генератор портретов вернул неподдерживаемый файл");
    assert_eq!(error.code(), Some("IMAGE_FORMAT_REJECTED"));
    // Формат проверяется до списания, как у иллюстраций: пустой портрет не
    // записан успешной генерацией, его расход не считается.
    let report = usage.report().expect("отчёт");
    assert_eq!(report["completed_requests"], 0);
    assert_eq!(report["failed_requests"], 1);
    assert_eq!(report["committed_tokens"], 0);
    assert_eq!(service.cached("PREP", &npc["id"]).await.expect("кеш"), None);
}
