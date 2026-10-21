//! Смысловые проверки из тестов JS о модулях А1 (`test/campaign-bootstrap*.test.mjs`,
//! `campaign-recap`, `creative-director`, `lore-author`, `lore-voice`,
//! `injection-surfaces`, `llm-refusal-fallback`) — без HTTP-сервера и движка
//! правил.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_agents::campaign_bootstrap::{CampaignBootstrapper, CAMPAIGN_BOOTSTRAP_TIMEOUT_MS};
use sk_agents::campaign_recap::{recap_sources, CampaignRecapService, RecapCacheStore};
use sk_agents::creative_director::{critical_moment_for, CriticalNarrationCoordinator, CriticalNarrator, CRITICAL_NARRATION_TIMEOUT_MS};
use sk_agents::lore_author::LoreAuthor;
use sk_agents::lore_voice::{verify_lore_answer, LoreVoice};
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_core::{js, text};
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map};
use sk_tactics::security::{UNTRUSTED_DATA_END, UNTRUSTED_DATA_START};

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

/// Заглушка модели: отдаёт ответы по очереди и записывает запросы.
struct Stub {
    replies: Mutex<Vec<Result<Value, LlmError>>>,
    requests: Mutex<Vec<Value>>,
}

impl Stub {
    fn new(replies: Vec<Result<Value, LlmError>>) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies), requests: Mutex::new(Vec::new()) })
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }

    fn next(&self, input: &Value) -> Result<Value, LlmError> {
        self.requests.lock().unwrap().push(input.clone());
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err(LlmError::new("FAKE_LLM_EXHAUSTED", "закончились ответы"));
        }
        replies.remove(0)
    }
}

impl LlmClient for Stub {
    fn model(&self) -> Option<String> {
        None
    }

    fn complete<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let answer = self.next(input);
        Box::pin(async move { answer })
    }

    fn complete_json<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let answer = self.next(input);
        Box::pin(async move { answer })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

fn client(stub: &Arc<Stub>) -> Option<Arc<dyn LlmClient>> {
    Some(Arc::clone(stub) as Arc<dyn LlmClient>)
}

/// Полезная нагрузка блока `UNTRUSTED_DATA:<section>`.
fn untrusted_payload(content: &str, section: &str) -> Value {
    let open = format!("{UNTRUSTED_DATA_START}:{section}>>>");
    let close = format!("{UNTRUSTED_DATA_END}:{section}>>>");
    let start = content.find(&open).unwrap_or_else(|| panic!("нет блока {section}"));
    let end = content.find(&close).expect("конец блока");
    serde_json::from_str(&content[start + open.len()..end]).expect("JSON блока")
}

fn hero() -> Value {
    json!({
        "id": "nova", "name": "Анна", "character": "Нова Рей", "role": "Пилот · ур. 1", "species": "Человек",
        "background": "Бывший навигатор", "backstory": "Ищет пропавший исследовательский корабль своего брата.",
        "speed": 30, "maxHp": 12, "armor": 13, "online": true,
    })
}

fn create(bootstrapper: &CampaignBootstrapper, input: Value) -> Value {
    block_on(bootstrapper.create(&input)).unwrap_or_else(|error| panic!("{error}"))
}

fn bootstrapper_with(stub: &Arc<Stub>) -> CampaignBootstrapper {
    CampaignBootstrapper::new(client(stub), None, None, Some(&json!(0)))
}

#[test]
fn bootstrap_requests_its_own_long_timeout() {
    let stub = Stub::new(vec![Ok(json!({}))]);
    create(&bootstrapper_with(&stub), json!({ "code": "BOOT-TIMEOUT", "name": "Проверка", "partyName": "Отряд", "world": {}, "players": [{ "id": "hero", "character": "Ада" }] }));
    let requests = stub.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["timeoutMs"], json!(CAMPAIGN_BOOTSTRAP_TIMEOUT_MS));
    assert!(CAMPAIGN_BOOTSTRAP_TIMEOUT_MS >= 30_000);
}

#[test]
fn model_failure_keeps_campaign_playable() {
    let stub = Stub::new(vec![Err(LlmError::new("LLM_TIMEOUT", "timeout"))]);
    let state = create(&bootstrapper_with(&stub), json!({ "code": "BOOT-FAIL", "name": "Проверка", "partyName": "Отряд", "world": {}, "players": [{ "id": "hero", "character": "Ада" }] }));
    assert_eq!(state["campaignConcept"]["generatedBy"], "local-storyteller");
    assert!(text::len(state["scene"]["location"].as_str().unwrap_or("")) > 2);
    assert!(text::len(state["messages"][0]["text"].as_str().unwrap_or("")) > 20);
    assert_eq!(stub.requests().len(), 1, "не повторяется: код не из списка повторов");
}

#[test]
fn provider_outage_is_retried_once() {
    let opening = json!({ "campaignName": "Сигнал", "scene": { "title": "Позывной", "location": "Станция", "map": { "layout": "rooms" } }, "hook": "Позывной пропавшего корабля" });
    let stub = Stub::new(vec![Err(LlmError::new("LLM_PROVIDER_UNAVAILABLE", "лёг")), Ok(opening)]);
    let state = create(&bootstrapper_with(&stub), json!({ "code": "RETRY-1", "world": {}, "players": [hero()] }));
    assert_eq!(stub.requests().len(), 2);
    assert_eq!(state["campaignConcept"]["generatedBy"], "ai-storyteller");
    let retry = stub.requests()[1]["timeoutMs"].as_i64().expect("срок повтора");
    assert!((30_000..=CAMPAIGN_BOOTSTRAP_TIMEOUT_MS).contains(&retry));
}

#[test]
fn storyteller_gets_owner_setup_and_backstories_inside_untrusted_data() {
    let opening = json!({
        "campaignName": "Небесные кочевники", "partyName": "Искатели рассвета",
        "worldSummary": "Мир независимых звёздных городов.",
        "openingNarration": "Нова узнаёт позывной корабля брата.\n\nШлюз станции открывается, и экипаж решает, кто войдёт первым.",
        "scene": { "title": "Позывной из тишины", "location": "Станция «Тихая гавань»", "mood": "Напряжённое ожидание", "objective": "Найти источник позывного", "theme": "заброшенная космическая станция", "danger": "средняя", "map": { "layout": "rooms", "width": 13, "height": 9, "openness": 0.6, "water": 0, "featureCount": 4 } },
        "hook": "Позывной пропавшего корабля",
        "suggestions": ["Проверить шлюз"],
    });
    let stub = Stub::new(vec![Ok(opening)]);
    let state = create(
        &bootstrapper_with(&stub),
        json!({ "code": "SIGNAL-7", "name": "Сигнал", "partyName": "Искатели", "world": { "era": "Будущее", "genre": "Научная фантастика", "premise": "Первый контакт", "openingSituation": "Неизвестный сигнал" }, "players": [hero()] }),
    );
    let request = &stub.requests()[0];
    let user = request["messages"][1]["content"].as_str().expect("сообщение");
    let setup = untrusted_payload(user, "campaign_setup");
    assert_eq!(setup["party_size"], 1);
    assert_eq!(setup["heroes"][0]["backstory"], hero()["backstory"]);
    assert_eq!(setup["world"]["premise"], "Первый контакт");
    assert!(request["messages"][0]["content"].as_str().unwrap_or("").contains("campaign_setup.party_size — точное число выбранных героев"));
    assert_eq!(state["campaignConcept"]["generatedBy"], "ai-storyteller");
    assert_eq!(state["scene"]["title"], "Позывной из тишины");
    let narration = state["messages"][0]["text"].as_str().unwrap_or("");
    assert!(narration.contains("корабля брата") && narration.contains("\n\n"));
}

#[test]
fn empty_world_is_sent_as_empty_fields_and_free_preset_verbatim() {
    let stub = Stub::new(vec![Ok(json!({})), Ok(json!({}))]);
    let bootstrapper = bootstrapper_with(&stub);
    create(&bootstrapper, json!({ "code": "AUTO-01", "name": "", "partyName": "", "world": {}, "players": [hero()] }));
    create(&bootstrapper, json!({ "code": "CUSTOM-1", "world": { "preset": "Подводный соларпанк с разумными китами" }, "players": [hero()] }));
    let requests = stub.requests();
    let first = untrusted_payload(requests[0]["messages"][1]["content"].as_str().unwrap_or(""), "campaign_setup");
    assert_eq!(first["world"]["era"], "");
    assert_eq!(first["world"]["genre"], "");
    assert_eq!(first["world"]["preset"], "");
    let second = untrusted_payload(requests[1]["messages"][1]["content"].as_str().unwrap_or(""), "campaign_setup");
    assert_eq!(second["world"]["preset"], "Подводный соларпанк с разумными китами");
}

#[test]
fn campaign_without_heroes_and_invalid_mode_are_rejected_before_the_model() {
    let stub = Stub::new(vec![Ok(json!({}))]);
    let bootstrapper = bootstrapper_with(&stub);
    let error = block_on(bootstrapper.create(&json!({ "code": "EMPTY-1", "world": {}, "players": [] }))).expect_err("без героев");
    assert!(error.message.contains("выберите от 1 до 12 героев"));
    let error = block_on(bootstrapper.create(&json!({ "code": "BAD-MODE", "campaignMode": "sandbox", "world": {}, "players": [hero()] }))).expect_err("режим");
    assert_eq!(error.code.as_deref(), Some("INVALID_CAMPAIGN_MODE"));
    assert!(stub.requests().is_empty());
}

#[test]
fn local_prologue_counts_unfilled_slots() {
    let forms = ["одного героя", "двух героев", "трёх героев", "четырёх героев", "пяти героев"];
    for count in 1..=5 {
        let players: Vec<Value> = (0..count)
            .map(|index| {
                let mut hero = hero();
                hero["id"] = json!(format!("slot-{count}-{}", index + 1));
                hero["character"] = json!(format!("Герой {}", index + 1));
                hero["characterSetupRequired"] = json!(true);
                hero
            })
            .collect();
        let state = create(&CampaignBootstrapper::default(), json!({ "code": format!("SLOTS-{count}"), "world": {}, "players": players }));
        assert!(state["messages"][0]["text"].as_str().unwrap_or("").contains(forms[count - 1]));
    }
}

#[test]
fn persistent_world_keeps_starter_quest_without_evening_arc() {
    let state = create(
        &CampaignBootstrapper::default(),
        json!({ "code": "PERSISTENT-1", "name": "Постоянный мир", "partyName": "Путники", "campaignMode": "persistent", "world": { "premise": "Границы мира меняются от решений героев." }, "players": [hero()] }),
    );
    let concept = &state["campaignConcept"];
    assert_eq!(concept["campaign_mode"], "persistent");
    assert!(concept.get("arc").is_none());
    assert_eq!(concept["story_sequence"], 0);
    assert_eq!(concept["story_history"], json!([]));
    let quest = state["worldMemory"]["quests"].as_array().and_then(|quests| quests.iter().find(|quest| quest["status"] == "active")).expect("стартовый квест");
    assert!(!js::s(quest.get("id")).starts_with("quest:chapter:"));
    assert_eq!(quest["clock"]["max"], 4);
    assert_eq!(concept["story_quest_id"], quest["id"]);
}

#[test]
fn fallback_prologue_tells_threat_as_rumour_and_calm_text_verbatim() {
    let situation = "Разбойник у моста требует плату с каждого путника.";
    let created = create(
        &CampaignBootstrapper::default(),
        json!({ "code": "BRIDGE-THREAT", "world": { "preset": "Классическое фэнтези", "startingLocation": "Деревня у старого моста", "openingSituation": situation }, "players": [hero()] }),
    );
    let narration = created["messages"][0]["text"].as_str().unwrap_or("").to_string();
    assert_eq!(created["campaignConcept"]["generatedBy"], "local-storyteller");
    assert_eq!(created["enemies"], json!([]));
    assert_eq!(created["npc_world"]["profiles"], json!({}));
    let sentence = narration.split(". ").find(|sentence| sentence.contains("Разбойник у моста")).expect("угроза названа").to_string();
    assert!(sentence.contains("молва") && sentence.contains("не видели"), "{sentence}");
    assert!(!narration.contains(situation));
    for (code, calm) in [("CALM-STATION", "Экипаж прибывает к молчащей орбитальной станции вслед за сигналом бедствия."), ("CALM-FAIR", "На огромной ярмарке играет оркестр, и никто не замечает пропажи.")] {
        let peaceful = create(&CampaignBootstrapper::default(), json!({ "code": code, "world": { "openingSituation": calm }, "players": [hero()] }));
        let text = peaceful["messages"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains(calm) && !text.contains("молва"), "{code}");
    }
}

fn starter_quest(state: &Value) -> Value {
    state["worldMemory"]["quests"]
        .as_array()
        .and_then(|quests| quests.iter().find(|quest| quest["status"] == "active" && !js::s(quest.get("id")).starts_with("quest:chapter:")))
        .cloned()
        .expect("стартовая задача")
}

#[test]
fn starter_quest_gets_short_title_and_full_hook_in_summary() {
    let situation = "Отряд просыпается на рыночной площади после дождя; рядом стоит проводница, которая знает о курьере.";
    let local = create(&CampaignBootstrapper::default(), json!({ "code": "TITLE-LOCAL", "world": { "openingSituation": situation }, "players": [hero()] }));
    let quest = starter_quest(&local);
    let title = quest["title"].as_str().unwrap_or("");
    assert!(text::len(title) <= 72);
    assert!(!local["messages"][0]["text"].as_str().unwrap_or("").contains(title));
    assert_eq!(quest["title"], local["scene"]["objective"]);
    assert_eq!(quest["summary"], situation);
    assert_eq!(quest["objectives"], json!([local["scene"]["objective"]]));

    let authored = create(&CampaignBootstrapper::default(), json!({ "code": "TITLE-TIDES", "worldTemplateId": "league-nine-tides", "players": [hero()] }));
    let quest = starter_quest(&authored);
    assert_eq!(quest["title"], "Первый отлив за четыреста лет открыл улицу Грунвика");
    assert_eq!(quest["summary"], authored["adventure"]["currentHook"]);

    let stub = Stub::new(vec![Ok(json!({
        "campaignName": "Сигнал", "partyName": "Экипаж",
        "openingNarration": "Нова узнаёт позывной корабля брата.\n\nШлюз станции открывается.",
        "scene": { "title": "Позывной из тишины", "location": "Станция «Тихая гавань»", "mood": "Напряжённое ожидание", "objective": "Найти источник позывного", "theme": "заброшенная космическая станция", "danger": "средняя", "map": { "layout": "rooms", "width": 13, "height": 9 } },
        "hook": "Позывной пропавшего корабля",
    }))]);
    let generated = create(&bootstrapper_with(&stub), json!({ "code": "TITLE-LLM", "world": {}, "players": [hero()] }));
    let quest = starter_quest(&generated);
    assert_eq!(quest["title"], "Позывной пропавшего корабля");
    assert_eq!(quest["summary"], "Найти источник позывного");
}

#[test]
fn heroes_sitting_in_a_tavern_start_inside_it() {
    let party: Vec<Value> = ["a", "b", "c", "d"]
        .iter()
        .enumerate()
        .map(|(index, id)| {
            let mut hero = hero();
            hero["id"] = json!(format!("hero-{id}"));
            hero["character"] = json!(format!("Герой {}", index + 1));
            hero
        })
        .collect();
    let world = json!({
        "startingLocation": "Серый Причал",
        "premise": "Туманный порт Серый Причал живёт контрабандой и рыбой.",
        "openingSituation": "Ночь, гроза. Герои сидят в портовой таверне «Ржавый якорь», когда в гавань без огней заходит рыбацкий баркас.",
    });
    let tavern = sk_core::re!(r"таверн|трактир|постоял|питейн|гостев|корчм|харчевн|общий зал", "iu");
    let zones_of = |state: &Value| {
        let map = deserialize_tactical_map(&state["scene"]["map"]).expect("карта");
        let zone = |x: i64, y: i64| cell_at(&map, x, y).and_then(|cell| map.zones.iter().find(|zone| zone.id == cell.zone)).map(|zone| (zone.id.clone(), zone.kind.clone(), zone.label.clone()));
        let spawn = map.spawn_points.iter().find(|point| point.role == "party").expect("точка входа").clone();
        let heroes: Vec<Option<(String, String, String)>> = state["players"].as_array().expect("герои").iter().map(|player| zone(player["x"].as_i64().unwrap_or(-1), player["y"].as_i64().unwrap_or(-1))).collect();
        (map.theme.clone(), spawn.id.clone(), zone(spawn.x, spawn.y), heroes)
    };
    for code in ["TAVERN-1", "TAVERN-2"] {
        let state = create(&CampaignBootstrapper::default(), json!({ "code": code, "world": world, "players": party }));
        let (theme, spawn_id, spawn_zone, heroes) = zones_of(&state);
        assert_eq!(theme, "settlement");
        assert_eq!(spawn_id, "party-entrance");
        assert_eq!(spawn_zone.map(|zone| zone.1).as_deref(), Some("exterior"));
        assert!(heroes.iter().all(|zone| zone.as_ref().is_some_and(|zone| zone.1 == "interior" && text::test(tavern, &zone.2))), "{heroes:?}");
        let rooms: std::collections::HashSet<String> = heroes.iter().flatten().map(|zone| zone.0.clone()).collect();
        assert_eq!(rooms.len(), 1, "весь отряд — в одном зале");
    }
    let mut outside_world = world.clone();
    outside_world["openingSituation"] = json!("Ночь, гроза. Герои идут в таверну, но у ворот их окликает стражник.");
    let outside = create(&CampaignBootstrapper::default(), json!({ "code": "TAVERN-OUT", "world": outside_world, "players": party }));
    let (_, _, _, heroes) = zones_of(&outside);
    assert!(heroes.iter().all(|zone| zone.as_ref().is_none_or(|zone| zone.1 != "interior")), "{heroes:?}");
}

#[test]
fn prologue_from_lore_author_goes_to_concept() {
    let lore = Stub::new(vec![Ok(json!({ "role": "assistant", "content": "  Давным-давно…  " }))]);
    let bootstrapper = CampaignBootstrapper::new(None, Some(LoreAuthor::new(client(&lore))), None, None);
    let state = create(&bootstrapper, json!({ "code": "LORE-1", "world": {}, "players": [hero()] }));
    assert_eq!(state["campaignConcept"]["prologue"], "Давным-давно…");
    let request = &lore.requests()[0];
    assert_eq!(request["usageScope"], "lore");
    let facts = untrusted_payload(request["messages"][1]["content"].as_str().unwrap_or(""), "lore_facts");
    assert_eq!(facts["heroes"][0]["character"], "Нова Рей");
}

// --- рекап ----------------------------------------------------------------------------

const HOUR: f64 = 3_600_000.0;

fn state_with_memory() -> Value {
    json!({
        "worldMemory": {
            "summaries": [
                { "id": "summary:1", "title": "Глава 1", "summary": "Отряд нашёл синюю нить у колодца.", "visibility": "party" },
                { "id": "summary:secret", "title": "Тайное", "summary": "Культ готовит обряд.", "visibility": "gm_only" },
                { "id": "summary:2", "title": "Глава 2", "summary": "Караван ушёл на север.", "visibility": "public" },
            ],
            "quests": [{ "id": "q", "title": "Пропавший караван", "summary": "Найти след", "status": "active", "visibility": "party" }, { "id": "q2", "title": "Тайный приказ", "status": "active", "visibility": "gm_only" }],
            "threads": [{ "id": "t", "title": "Сгоревшая мельница", "status": "active", "visibility": "party" }],
        },
        "social": { "npcs": [{ "id": "npc:mira", "name": "Мира", "visibility": "party", "available": true }], "promises": [
            { "id": "promise:1", "npc_id": "npc:mira", "hero_id": "hero-1", "direction": "party_to_npc", "text": "Вернуть Мире долг до заката", "due_hint": "к вечеру", "status": "open", "visibility": "party" },
            { "id": "promise:secret", "npc_id": "npc:mira", "hero_id": "hero-2", "direction": "party_to_npc", "text": "Личная услуга второго героя", "status": "open", "visibility": "specific_player" },
        ] },
    })
}

fn cache_file() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sk-a1s-{}-{}", std::process::id(), sk_core::hash::uuid_v4()));
    dir.join("recap.json")
}

fn iso(ms: f64) -> Value {
    json!(sk_core::clock::iso(ms as i64))
}

#[test]
fn recap_sources_are_party_visible_only() {
    let sources = recap_sources(&state_with_memory(), None);
    let ids: Vec<Value> = sources["summaries"].as_array().unwrap().iter().map(|entry| entry["id"].clone()).collect();
    assert_eq!(ids, vec![json!("summary:1"), json!("summary:2")]);
    let serialized = js::stringify(&sources);
    for secret in ["gm_only", "Культ готовит", "Тайный приказ", "Личная услуга"] {
        assert!(!serialized.contains(secret), "{secret}");
    }
}

#[test]
fn recap_model_sees_only_party_sources_and_cache_saves_calls() {
    let stub = Stub::new(vec![Ok(json!({ "recap": "Отряд шёл по следу каравана." })), Ok(json!({ "recap": "Отряд снова в пути." }))]);
    let service = CampaignRecapService::new(client(&stub), Some(RecapCacheStore::new(cache_file())), None, Some(Arc::new(|| 100.0 * HOUR)));
    let input = json!({ "campaignId": "RECAP", "state": state_with_memory(), "stateVersion": 7, "lastEventAt": iso(10.0 * HOUR) });
    let first = block_on(service.recap_for(&input)).expect("рекап");
    assert_eq!(first["recap"]["provider"], "model");
    let sent = js::stringify(&stub.requests()[0]["messages"]);
    assert!(!sent.contains("Культ готовит") && sent.contains("<<<UNTRUSTED_DATA:recap_sources>>>"));
    let again = block_on(service.recap_for(&input)).expect("рекап");
    assert_eq!(again["recap"]["text"], first["recap"]["text"]);
    assert_eq!(stub.requests().len(), 1, "повтор — из кеша");
    let mut newer = input.clone();
    newer["stateVersion"] = json!(8);
    let fresh = block_on(service.recap_for(&newer)).expect("рекап");
    assert_eq!(fresh["recap"]["text"], "Отряд снова в пути.");
    assert_eq!(stub.requests().len(), 2);
}

#[test]
fn recap_needs_gap_and_summaries_and_falls_back_without_model() {
    let service = CampaignRecapService::new(None, None, Some(&json!(8)), Some(Arc::new(|| 100.0 * HOUR)));
    let fresh = block_on(service.recap_for(&json!({ "campaignId": "R", "state": state_with_memory(), "stateVersion": 1, "lastEventAt": iso(97.0 * HOUR) }))).expect("рекап");
    assert_eq!(fresh, json!({ "recap": null, "reason": "no_gap" }));
    let back = block_on(service.recap_for(&json!({ "campaignId": "R", "state": state_with_memory(), "stateVersion": 3, "lastEventAt": iso(10.0 * HOUR) }))).expect("рекап");
    assert_eq!(back["recap"]["provider"], "deterministic");
    let text = back["recap"]["text"].as_str().unwrap_or("");
    assert!(text.contains("синюю нить") && text.contains("Открытая цель — Пропавший караван") && text.contains("Отряд остался должен: Вернуть Мире долг до заката"), "{text}");
    let mut empty = state_with_memory();
    empty["worldMemory"]["summaries"] = json!([]);
    let none = block_on(service.recap_for(&json!({ "campaignId": "R", "state": empty, "stateVersion": 1, "lastEventAt": iso(10.0 * HOUR) }))).expect("рекап");
    assert_eq!(none, json!({ "recap": null, "reason": "no_summaries" }));
    assert!(!service.has_gap(Some(&iso(99.0 * HOUR))));
    assert!(!service.has_gap(None));
    assert!(!service.has_gap(Some(&json!("не дата"))));
    for (value, expected) in [(json!(2), 2.0), (json!(-1), 8.0), (json!("x"), 8.0)] {
        assert_eq!(CampaignRecapService::new(None, None, Some(&value), None).gap_hours(), expected);
    }
}

// --- летописец и хранитель знаний --------------------------------------------------------

#[test]
fn lore_author_is_silent_without_client_and_on_provider_error() {
    assert_eq!(block_on(LoreAuthor::new(None).compose("x", &json!({}), 100)), "");
    let failing = Stub::new(vec![Err(LlmError::new("LLM_TIMEOUT", "нет"))]);
    assert_eq!(block_on(LoreAuthor::new(client(&failing)).compose("x", &json!({}), 100)), "");
    let stub = Stub::new(vec![Ok(json!({ "content": "Хроника." }))]);
    let text = block_on(LoreAuthor::new(client(&stub)).compose_arc_chronicle(&json!({ "arcNumber": 2, "epilogue": "э".repeat(3000), "facts": (0..30).collect::<Vec<_>>() }))).expect("хроника");
    assert_eq!(text, "Хроника.");
    let request = &stub.requests()[0];
    assert!(request["messages"][0]["content"].as_str().unwrap_or("").contains("Ничего не выдумывай"));
    let facts = untrusted_payload(request["messages"][1]["content"].as_str().unwrap_or(""), "lore_facts");
    assert_eq!(text::len(facts["epilogue"].as_str().unwrap_or("")), 2000);
    assert_eq!(facts["world_facts"].as_array().map(Vec::len), Some(24));
    assert_eq!(request["timeoutMs"], 45_000);
}

fn lore_material() -> Value {
    json!({
        "found": ["На корме выжжена чайка с перебитым крылом — знак артели Ворониных."],
        "heard": [{ "who": "Марен", "line": "Баркас «Чайка» видели у северной отмели в ночь грозы." }],
        "known": [], "lead": [{ "name": "Борс", "role": "рыбак" }], "hook": "", "unknown": false,
    })
}

#[test]
fn lore_answer_check_rejects_invented_names_digits_and_lost_findings() {
    let material = lore_material();
    let good = "Вы сами видели на корме выжженную чайку с перебитым крылом — так метит лодки артель Ворониных. А Марен рассказывала, что баркас видели у северной отмели в ночь грозы. Кто им правил — пока загадка; Борс, рыбак, может знать больше.";
    let context = json!({ "location": "Старый маяк", "hero": "Мирель" });
    assert!(verify_lore_answer(Some(&json!(good)), Some(&material), Some(&context)).expect("проверка").valid);
    let reasons = |answer: String| verify_lore_answer(Some(&json!(answer)), Some(&material), None).expect("проверка").reasons.join(",");
    assert!(reasons(format!("{good} Капитан Грейвз тоже что-то скрывает.")).contains("invented_names"));
    assert!(reasons(format!("{good} Это было 3 дня назад.")).contains("digits"));
    assert!(reasons("Марен рассказывала про отмель и грозу, а больше вы ничего не знаете о баркасе.".into()).contains("lost_finding"));
}

#[test]
fn lore_voice_retells_or_yields_to_server_answer() {
    let told = "Вы сами видели на корме выжженную чайку с перебитым крылом — знак артели Ворониных. Марен говорила, что баркас видели у северной отмели в ночь грозы.";
    let input = json!({ "question": "Что мы знаем о баркасе?", "material": lore_material() });
    let stub = Stub::new(vec![Ok(json!({ "answer": told }))]);
    let out = block_on(LoreVoice::new(client(&stub), None).retell(&input)).expect("пересказ");
    assert_eq!(out["narration"], told);
    let inventing = Stub::new(vec![Ok(json!({ "answer": format!("{told} Его хозяин — Грейвз из Нижнего города.") }))]);
    assert!(block_on(LoreVoice::new(client(&inventing), None).retell(&input)).is_none());
    assert!(block_on(LoreVoice::new(None, None).retell(&input)).is_none());
}

// --- творческий режиссёр -----------------------------------------------------------------

struct Narrator {
    reply: Value,
    calls: Mutex<Vec<(Value, Value)>>,
}

impl CriticalNarrator for Narrator {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.calls.lock().unwrap().push((brief.clone(), options.clone()));
        let reply = self.reply.clone();
        Box::pin(async move { Ok(reply) })
    }
}

fn director(reply: Value) -> (Arc<Narrator>, CriticalNarrationCoordinator) {
    let narrator = Arc::new(Narrator { reply, calls: Mutex::new(Vec::new()) });
    (Arc::clone(&narrator), CriticalNarrationCoordinator::new(narrator as Arc<dyn CriticalNarrator>))
}

fn fight() -> Value {
    json!({
        "scene": { "title": "Зал", "location": "Крепость", "mood": "Гулкий камень", "objective": "Выстоять" },
        "players": [{ "id": "hero", "character": "Лира" }],
        "enemies": [{ "id": "guard", "name": "Страж", "hp": 0, "maxHp": 12, "alive": false }],
        "actors": [],
    })
}

#[test]
fn creative_director_skips_movement_and_ordinary_attacks() {
    let (narrator, director) = director(json!({ "narration": "unexpected" }));
    let events = vec![
        json!({ "event_type": "ActorMoved", "actor_id": "hero", "target_ids": ["hero"], "payload": { "distance": 10 } }),
        json!({ "event_type": "AttackResolved", "actor_id": "hero", "target_ids": ["guard"], "payload": { "hit": true } }),
    ];
    assert!(critical_moment_for(&events, &fight()).is_none());
    assert!(block_on(director.render_critical_moment(&json!({ "events": events, "state": fight() }))).expect("без ошибки").is_none());
    assert!(narrator.calls.lock().unwrap().is_empty());
}

#[test]
fn enemy_defeat_is_narrated_and_fallback_line_is_stable() {
    let events = json!([{ "event_id": "down-1", "event_type": "HitPointsReducedToZero", "actor_id": "hero", "target_ids": ["guard"], "payload": {} }]);
    let (narrator, live) = director(json!({ "narration": "Страж оседает у расколотой колонны.", "provider": "fake-agent" }));
    let result = block_on(live.render_critical_moment(&json!({ "events": events, "state": fight(), "recentNarrations": ["Тишина звенит в ушах.", "", null] }))).expect("рассказ").expect("момент");
    assert_eq!(result["trigger"]["kind"], "enemy_defeated");
    let (brief, options) = narrator.calls.lock().unwrap()[0].clone();
    assert_eq!(brief["known_environment"]["critical_moment"]["kind"], "enemy_defeated");
    assert_eq!(options["timeoutMs"], CRITICAL_NARRATION_TIMEOUT_MS);
    assert_eq!(options["recentNarrations"], json!(["Тишина звенит в ушах."]));
    let (_, dry) = director(json!({ "narration": "Лира поражает Стража. Страж получает урон.", "provider": "deterministic-fallback" }));
    let first = block_on(dry.render_critical_moment(&json!({ "events": events, "state": fight() }))).expect("рассказ").expect("момент");
    let text = first["narration"].as_str().unwrap_or("");
    assert!(text.contains("Страж") && !text.contains("получает урон"));
    let second = block_on(dry.render_critical_moment(&json!({ "events": events, "state": fight() }))).expect("рассказ").expect("момент");
    assert_eq!(second["narration"], first["narration"]);
}

#[test]
fn aftermath_without_live_text_is_silent() {
    let events = json!([{ "event_type": "EncounterOutcomeRecorded", "payload": { "outcome": "enemies_defeated" } }]);
    let (_, dry) = director(json!({ "narration": "x", "provider": "deterministic" }));
    assert!(block_on(dry.render_aftermath(&json!({ "events": events, "state": fight() }))).expect("без ошибки").is_none());
    let (_, live) = director(json!({ "narration": "Тишина после схватки.", "provider": "RouterAI" }));
    let out = block_on(live.render_aftermath(&json!({ "events": events, "state": fight() }))).expect("без ошибки").expect("сцена");
    assert_eq!(out["trigger"]["kind"], "encounter_aftermath");
    let mut unknown = Map::new();
    unknown.insert("events".into(), json!([{ "event_type": "EncounterOutcomeRecorded", "payload": { "outcome": "draw" } }]));
    assert!(block_on(live.render_aftermath(&Value::Object(unknown))).expect("без ошибки").is_none());
}
