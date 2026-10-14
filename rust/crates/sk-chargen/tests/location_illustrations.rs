//! Сверка `location_illustrations` с эталоном JS
//! (`fixtures/location-illustrations.json`, генератор —
//! `fixtures/gen-location-illustrations.mjs`) и перенесённые проверки из
//! `test/location-illustrations.test.mjs`. Проекции ведущего и игрока в эталоне
//! сняты JS (`campaignStateForViewer` в Rust ещё нет); здесь проверяется только
//! то, что модуль делает с готовой проекцией. Генерация — заглушкой трейта.

mod common;

use std::sync::{Arc, Mutex};

use common::images::{ledger, relative, relative_result, service_error, webp, Scripted};
use common::{check, ok, ok_or_null, Args, Outcome};
use serde_json::{json, Value};
use sk_chargen::location_illustrations::{self as m, LocationIllustrationCache, LocationIllustrationService, LocationIllustrationServiceOptions};
use sk_chargen::npc_portraits::{ImageGeneratorSource, ImageServiceError, ImageUsageLedger};

const NOW: &str = "2026-07-31T12:00:00.000Z";

fn service(storage: &std::path::Path, model: &str, api_key: &str, generator: Arc<Scripted>, usage_ledger: Option<Arc<dyn ImageUsageLedger>>) -> LocationIllustrationService {
    LocationIllustrationService::new(LocationIllustrationServiceOptions {
        storage_dir: storage.to_path_buf(),
        image_model: model.into(),
        api_key: api_key.into(),
        base_url: String::new(),
        generator: ImageGeneratorSource::Generator(generator),
        usage_ledger,
    })
}

/// Исход шага сценария: `{ ok }` или `{ error }`; сбой ввода-вывода — как в
/// эталоне, без текста ОС.
fn step(result: Result<Value, ImageServiceError>, storage: &std::path::Path) -> Value {
    match result {
        Ok(value) => json!({ "ok": relative_result(value, storage) }),
        Err(ImageServiceError::Io(_)) => json!({ "error": { "name": "Error", "code": "FS", "message": "fs" } }),
        Err(error) => json!({ "error": service_error(&error) }),
    }
}

async fn scenario(input: &Value) -> Value {
    let directory = tempfile::tempdir().expect("каталог");
    let storage = directory.path();
    let kind = input["generator"].as_str().unwrap_or_default();
    let generator = Scripted::with_usage(kind, json!({ "total_tokens": 14, "cost": 0.5 }));
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
    for entry in input["precache"].as_array().into_iter().flatten() {
        let target = m::location_illustration_cache_location(&storage.join("generated").join("locations"), Some(&json!(campaign)), Some(&entry[0])).expect("путь");
        std::fs::create_dir_all(&target.directory).expect("каталог кеша");
        match entry[1].as_str().unwrap_or_default() {
            "directory" => std::fs::create_dir_all(&target.file_path).expect("каталог на месте файла"),
            other => {
                let bytes = match other {
                    "webp" => webp(),
                    "empty" => Vec::new(),
                    "short" => webp()[..8].to_vec(),
                    _ => "<html>страница ошибки</html>".as_bytes().to_vec(),
                };
                std::fs::write(&target.file_path, bytes).expect("файл кеша");
            }
        }
    }
    let mut steps = Vec::new();
    for entry in input["steps"].as_array().into_iter().flatten() {
        let campaign = entry["campaignId"].as_str().unwrap_or_default();
        let result = match entry["op"].as_str().unwrap_or_default() {
            "prepare" => service.prepare(campaign, &entry["location"]).await.map(|illustration| illustration.to_json()),
            "cached" => service.cached(campaign, &entry["id"]).await.map(|illustration| illustration.map_or(Value::Null, |illustration| illustration.to_json())),
            "hasCached" => service.has_cached(campaign, &entry["id"]).await.map(Value::Bool),
            _ => m::location_illustration_inventory(&service, campaign, entry["locations"].as_array().map_or(&[][..], Vec::as_slice)).await.map(Value::Array),
        };
        steps.push(step(result, storage));
    }
    let prompts: Vec<Value> = generator.calls().iter().map(|call| json!({ "model": call.model, "prompt_length": sk_narration_base::jsx::utf16_len(&call.prompt) })).collect();
    json!({
        "steps": steps,
        "prompts": prompts,
        "ledger": usage_ledger.map_or(Value::Null, |ledger| common::images::ledger_summary(&ledger, &ledger_file)),
    })
}

fn cache_location_relative(args: &Args) -> Outcome {
    let base = std::env::temp_dir().join("skazanie-location-root");
    match m::location_illustration_cache_location(&base, args.get(0), args.get(1)) {
        Ok(location) => ok(json!({ "key": location.key, "file": relative(&location.root, &location.file_path), "directory": relative(&location.root, &location.directory) })),
        Err(error) => Err(common::error("Error", None, &error.to_string())),
    }
}

#[test]
fn matches_js_fixture() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("рантайм");
    let cases = check(include_str!("../fixtures/location-illustrations.json"), |name, args| match name {
        "const:LOCATION_ILLUSTRATION_MAX_BYTES" => ok(json!(m::LOCATION_ILLUSTRATION_MAX_BYTES)),
        "normalizeLocationId" => ok(json!(m::normalize_location_id(args.get(0)))),
        "visibleCampaignLocations" => ok(Value::Array(m::visible_campaign_locations(args.get(0).unwrap_or(&Value::Null)))),
        "visibleLocationProfile" => ok_or_null(m::visible_location_profile(args.get(0).unwrap_or(&Value::Null), args.get(1))),
        "visibleLocationProfiles" => {
            let state = args.get(0).unwrap_or(&Value::Null);
            ok(Value::Array(args.get(1).and_then(Value::as_array).into_iter().flatten().map(|id| m::visible_location_profile(state, Some(id)).unwrap_or(Value::Null)).collect()))
        }
        "buildLocationIllustrationPrompt" => ok(json!(m::build_location_illustration_prompt(args.get(0).unwrap_or(&Value::Null)))),
        "cacheLocationRelative" => cache_location_relative(args),
        "serviceScenario" => ok(runtime.block_on(scenario(args.get(0).unwrap_or(&Value::Null)))),
        other => panic!("неизвестный случай {other}"),
    });
    assert!(cases > 900, "{cases}");
}

// --- test/location-illustrations.test.mjs ---

/// Проекция ведущего из теста JS: ведущий видит всё, что лежит в состоянии.
fn admin_projection() -> Value {
    json!({
        "scene": { "title": "Разбитый обоз", "location": "Норвинский тракт", "location_id": "loc:norvin-road", "scene_kind": "road" },
        "worldMap": {
            "currentLocationId": "loc:norvin-road",
            "locations": [
                { "id": "loc:norvin-road", "name": "Норвинский тракт", "kind": "landmark", "summary": "Разбитая дорога", "known": true, "visited": true },
                { "id": "loc:hidden-vault", "name": "Тайный схрон", "kind": "ruin", "summary": "Ещё не найден", "known": false, "visited": false },
            ],
        },
        "worldMemory": { "entities": [
            { "id": "loc:archive", "kind": "location", "name": "Затопленный архив", "summary": "Подвалы под городом", "visibility": "party" },
            { "id": "loc:cult-lair", "kind": "location", "name": "Логово культа", "summary": "Тайна ведущего", "visibility": "gm_only" },
            { "id": "npc:marta", "kind": "npc", "name": "Марта", "summary": "Торговка", "visibility": "public" },
        ] },
    })
}

#[test]
fn location_list_comes_from_scene_world_map_and_world_memory() {
    let locations = m::visible_campaign_locations(&admin_projection());
    let rows: Vec<(Value, Value, Value)> = locations.iter().map(|entry| (entry["id"].clone(), entry["name"].clone(), entry["source"].clone())).collect();
    assert_eq!(
        rows,
        [
            (json!("loc:archive"), json!("Затопленный архив"), json!("world_memory")),
            (json!("loc:cult-lair"), json!("Логово культа"), json!("world_memory")),
            (json!("loc:hidden-vault"), json!("Тайный схрон"), json!("world_map")),
            (json!("loc:norvin-road"), json!("Норвинский тракт"), json!("scene")),
        ],
        "порядок детерминирован; подпись текущей сцены побеждает сухую запись карты, NPC в список не попадают"
    );
}

#[test]
fn current_location_is_known_by_world_map_id_without_scene_location_id() {
    // Публичная сцена игрока не отдаёт `location_id`: текущее место опознаётся по карте.
    let mut player = admin_projection();
    player["scene"].as_object_mut().expect("сцена").shift_remove("location_id");
    let current = m::visible_location_profile(&player, Some(&json!("loc:norvin-road"))).expect("текущее место");
    assert_eq!(current["source"], "scene", "запись текущей сцены, а не сухая строка карты");
    assert_eq!((current["name"].clone(), current["summary"].clone()), (json!("Норвинский тракт"), json!("Разбитый обоз")));
}

#[test]
fn improvised_location_under_the_party_is_visible() {
    let improvised = json!({
        "scene": { "title": "Забытая часовня", "location": "Часовня на отшибе", "scene_kind": "dungeon" },
        "worldMap": { "currentLocationId": "loc:improvised-chapel", "locations": [] },
        "worldMemory": { "entities": [] },
    });
    let profile = m::visible_location_profile(&improvised, Some(&json!("loc:improvised-chapel"))).expect("место");
    assert_eq!((profile["name"].clone(), profile["source"].clone()), (json!("Часовня на отшибе"), json!("scene")));
    assert_eq!(m::visible_campaign_locations(&improvised).iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>(), [json!("loc:improvised-chapel")]);
    assert_eq!(m::visible_location_profile(&improvised, Some(&json!("loc:someone-else"))), None);
}

#[test]
fn location_id_is_checked_and_cache_key_hides_campaign_and_id() {
    assert_eq!(m::normalize_location_id(Some(&json!("loc:archive"))), "loc:archive");
    for bad in [json!(""), json!("../secret"), json!("loc archive"), json!("/loc"), json!("a".repeat(121))] {
        assert_eq!(m::normalize_location_id(Some(&bad)), "", "принят «{bad}»");
    }
    let root = std::env::temp_dir().join("skazanie-location-root");
    let location = m::location_illustration_cache_location(&root, Some(&json!("..\\..\\outside")), Some(&json!("../../secret"))).expect("путь");
    assert!(location.file_path.is_absolute());
    assert!(location.file_path.starts_with(&root));
    let text = location.file_path.to_string_lossy();
    assert!(!text.contains("outside") && !text.contains("secret"));
}

#[test]
fn prompt_takes_only_public_location_fields() {
    let prompt = m::build_location_illustration_prompt(&json!({
        "id": "loc:archive", "name": "Затопленный архив", "summary": "Подвалы под городом", "kind": "ruin", "source": "world_memory", "gm_notes": "GM_ONLY_NOTE",
    }));
    assert!(prompt.contains("Затопленный архив") && prompt.contains("Подвалы под городом"));
    assert!(!prompt.contains("GM_ONLY_NOTE") && !prompt.contains("gm_notes"));
    assert!(sk_narration_base::jsx::utf16_len(&prompt) < 1_400);
}

#[tokio::test]
async fn preparation_writes_cache_and_ledger_and_regeneration_overwrites() {
    let directory = tempfile::tempdir().expect("каталог");
    let ledger_file = directory.path().join("engine").join("usage.json");
    let usage = ledger(&ledger_file, 10_000.0, NOW);
    let generator = Scripted::with_usage("ok", json!({ "total_tokens": 14, "cost": 0.5 }));
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Arc::clone(&generator), Some(usage.clone()));
    let location = json!({ "id": "loc:archive", "name": "Затопленный архив", "summary": "Подвалы", "kind": "", "source": "world_memory" });
    assert_eq!(service.cached("PREP", &location["id"]).await.expect("кеш"), None);
    let prepared = service.prepare("PREP", &location).await.expect("подготовка");
    assert!(!prepared.cache_hit);
    assert_eq!(generator.calls().len(), 1);
    assert_eq!(generator.calls()[0].model, "openai/gpt-image-1");
    assert_eq!(service.cached("PREP", &location["id"]).await.expect("кеш").map(|illustration| illustration.cache_hit), Some(true));
    let report = usage.report().expect("отчёт");
    assert_eq!((report["completed_requests"].clone(), report["committed_tokens"].clone(), report["provider_cost"].clone()), (json!(1), json!(14), json!(0.5)), "расход подготовки обязан попасть в леджер");
    service.prepare("PREP", &location).await.expect("перегенерация");
    assert_eq!(generator.calls().len(), 2, "перегенерация не падает на существующем файле");
    assert_eq!(service.cached("OTHER", &location["id"]).await.expect("кеш"), None, "кеш разведён по кампаниям");
}

#[tokio::test]
async fn runtime_never_calls_the_model_service_only_reads_cache() {
    // У сервиса нет метода «достань или сгенерируй» — это держит сам тип.
    let directory = tempfile::tempdir().expect("каталог");
    let generator = Scripted::new("ok");
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Arc::clone(&generator), None);
    assert_eq!(service.cached("PREP", &json!("loc:archive")).await.expect("кеш"), None);
    assert!(generator.calls().is_empty(), "чтение кеша модель не трогает");
}

#[tokio::test]
async fn inventory_shows_which_location_still_lacks_a_picture() {
    let directory = tempfile::tempdir().expect("каталог");
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Scripted::new("ok"), None);
    let known = m::visible_campaign_locations(&admin_projection());
    let road = known.iter().find(|entry| entry["id"] == "loc:norvin-road").expect("тракт");
    service.prepare("PREP", road).await.expect("подготовка");
    let inventory = m::location_illustration_inventory(&service, "PREP", &known).await.expect("инвентарь");
    assert_eq!(
        inventory.iter().map(|entry| (entry["id"].clone(), entry["has_illustration"].clone())).collect::<Vec<_>>(),
        [(json!("loc:archive"), json!(false)), (json!("loc:cult-lair"), json!(false)), (json!("loc:hidden-vault"), json!(false)), (json!("loc:norvin-road"), json!(true))]
    );
    assert_eq!(inventory.iter().map(|entry| entry["name"].clone()).collect::<Vec<_>>(), [json!("Затопленный архив"), json!("Логово культа"), json!("Тайный схрон"), json!("Норвинский тракт")]);
}

#[tokio::test]
async fn unsupported_generator_answer_is_neither_cache_nor_ledger_success() {
    let directory = tempfile::tempdir().expect("каталог");
    let usage = ledger(&directory.path().join("engine").join("usage.json"), 10_000.0, NOW);
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Scripted::new("html"), Some(usage.clone()));
    let location = json!({ "id": "loc:archive", "name": "Архив", "summary": "", "kind": "", "source": "world_memory" });
    let error = service.prepare("PREP", &location).await.expect_err("отказ");
    assert!(error.to_string().contains("неподдерживаемый файл"));
    assert_eq!(error.code(), Some("IMAGE_FORMAT_REJECTED"));
    assert_eq!(service.cached("PREP", &location["id"]).await.expect("кеш"), None);
    let report = usage.report().expect("отчёт");
    assert_eq!((report["completed_requests"].clone(), report["failed_requests"].clone(), report["provider_cost"].clone()), (json!(0), json!(1), json!(0)), "брак не списывается как успех");
}

/// Кеш-шпион: список подготовки спрашивает только флаг.
struct Spy {
    asked: Mutex<Vec<Value>>,
}

impl LocationIllustrationCache for Spy {
    type Error = ImageServiceError;

    fn has_cached(&self, _campaign_id: &str, location_id: &Value) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        self.asked.lock().expect("вопросы").push(location_id.clone());
        let ready = location_id == "loc:archive";
        async move { Ok(ready) }
    }
}

#[tokio::test]
async fn preparation_list_learns_about_picture_from_metadata_not_full_read() {
    let directory = tempfile::tempdir().expect("каталог");
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Scripted::new("ok"), None);
    assert!(!service.has_cached("PREP", &json!("loc:archive")).await.expect("флаг"));
    service.prepare("PREP", &json!({ "id": "loc:archive", "name": "Архив", "summary": "", "kind": "", "source": "world_memory" })).await.expect("подготовка");
    assert!(service.has_cached("PREP", &json!("loc:archive")).await.expect("флаг"));
    assert!(!service.has_cached("OTHER", &json!("loc:archive")).await.expect("флаг"), "кеш разведён по кампаниям и здесь");
    let spy = Spy { asked: Mutex::new(Vec::new()) };
    let locations = [json!({ "id": "loc:archive", "name": "Архив", "kind": "", "source": "world_memory" }), json!({ "id": "loc:norvin-road", "name": "Тракт", "kind": "landmark", "source": "scene" })];
    let inventory = m::location_illustration_inventory(&spy, "PREP", &locations).await.expect("инвентарь");
    assert_eq!(inventory.iter().map(|entry| (entry["id"].clone(), entry["has_illustration"].clone())).collect::<Vec<_>>(), [(json!("loc:archive"), json!(true)), (json!("loc:norvin-road"), json!(false))]);
    assert_eq!(*spy.asked.lock().expect("вопросы"), [json!("loc:archive"), json!("loc:norvin-road")]);
}

#[tokio::test]
async fn list_flag_and_serving_agree_about_format() {
    let directory = tempfile::tempdir().expect("каталог");
    let service = service(directory.path(), "openai/gpt-image-1", "test-key", Scripted::new("ok"), None);
    let target = m::location_illustration_cache_location(service.cache_root(), Some(&json!("PREP")), Some(&json!("loc:archive"))).expect("путь");
    std::fs::create_dir_all(&target.directory).expect("каталог");
    std::fs::write(&target.file_path, "<html>провайдер прислал страницу ошибки</html>").expect("файл");
    assert!(!service.has_cached("PREP", &json!("loc:archive")).await.expect("флаг"), "по метаданным файл есть, но это не картинка");
    assert!(target.file_path.exists(), "список подготовки чужих файлов не трогает");
    assert_eq!(service.cached("PREP", &json!("loc:archive")).await.expect("кеш"), None);
    assert!(!target.file_path.exists(), "битый файл убирает cached() при отдаче");
}
