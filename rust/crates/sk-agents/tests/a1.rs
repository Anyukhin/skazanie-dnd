//! Эталоны задачи А1 (`fixtures/gen-a1.mjs` → `fixtures/a1.json.gz`): роли
//! JS и Rust на одной заглушке модели — сверяются запросы к модели и итог.

use std::future::Future;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_agents::campaign_bootstrap::{normalize_opening_canon, BootstrapError, CampaignBootstrapper, InspirationDraw};
use sk_agents::campaign_recap::{deterministic_recap_text, recap_sources, CampaignRecapService, RecapCacheStore};
use sk_agents::creative_director::{critical_moment_for, critical_moment_line, hero_flourish_for, CriticalNarrationCoordinator, CriticalNarrator};
use sk_agents::lore_author::LoreAuthor;
use sk_agents::lore_voice::{verify_lore_answer, LoreVoice};
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_core::js;
use sk_narration_base::campaign_inspiration::{CampaignInspiration, CAMPAIGN_INSPIRATION_POLICY_ID, INSPIRATION_DETAILS, INSPIRATION_GENRE_LEANS, INSPIRATION_HOOKS, INSPIRATION_REGIONS};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/a1.json.gz")[..]).read_to_string(&mut text).expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

// --- исполнитель без рантайма -----------------------------------------------------

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

// --- заглушка модели по сценарию --------------------------------------------------

fn sha(text: &str) -> String {
    sk_core::hash::sha256_hex(text.as_bytes())
}

struct Scripted {
    replies: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
    retry_timeouts: bool,
}

impl Scripted {
    fn new(script: &Value, retry_timeouts: bool) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(script.as_array().cloned().unwrap_or_default()), calls: Mutex::new(Vec::new()), retry_timeouts })
    }

    fn calls(&self) -> Value {
        Value::Array(self.calls.lock().unwrap().clone())
    }

    fn record(&self, method: &str, input: &Value, options: &Value) {
        let mut input = input.clone();
        if let Some(messages) = input.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if message.get("role").and_then(Value::as_str) == Some("system") {
                    let content = js::s(message.get("content"));
                    message["content"] = json!(format!("sha256:{}", sha(&content)));
                }
            }
        }
        let mut calls = self.calls.lock().unwrap();
        if self.retry_timeouts && !calls.is_empty() {
            if let Some(timeout) = input.get("timeoutMs").and_then(Value::as_f64) {
                assert!((30_000.0..=120_000.0).contains(&timeout), "срок повтора {timeout}");
                input["timeoutMs"] = json!("<remaining>");
            }
        }
        calls.push(json!({ "method": method, "input": input, "options": options }));
    }

    fn answer(&self) -> Result<Value, LlmError> {
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err(error_without_code("Сценарий модели закончился"));
        }
        let reply = replies.remove(0);
        if let Some(error) = reply.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("отказ");
            return Err(match error.get("code").and_then(Value::as_str) {
                Some(code) => LlmError::new(code, message),
                None => error_without_code(message),
            });
        }
        Ok(reply.get("value").cloned().unwrap_or(Value::Null))
    }
}

fn error_without_code(message: &str) -> LlmError {
    LlmError { name: "Error".into(), code: None, message: message.into(), details: Map::new(), provider_usage: None }
}

impl LlmClient for Scripted {
    fn model(&self) -> Option<String> {
        None
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.record("complete", input, options);
        let answer = self.answer();
        Box::pin(async move { answer })
    }

    fn complete_json<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.record("completeJson", input, options);
        let answer = self.answer();
        Box::pin(async move { answer })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

fn client_of(script: &Value, retry: bool) -> Option<Arc<Scripted>> {
    (!script.is_null()).then(|| Scripted::new(script, retry))
}

fn as_client(client: &Option<Arc<Scripted>>) -> Option<Arc<dyn LlmClient>> {
    client.as_ref().map(|client| Arc::clone(client) as Arc<dyn LlmClient>)
}

fn recorded(client: &Option<Arc<Scripted>>) -> Value {
    client.as_ref().map(|client| client.calls()).unwrap_or_else(|| json!([]))
}

fn error_json(name: &str, code: Option<&str>, message: &str) -> Value {
    json!({ "name": name, "code": code, "message": message })
}

fn bootstrap_error(error: &BootstrapError) -> Value {
    error_json(&error.name, error.code.as_deref(), &error.message)
}

/// Броски `DiceService` поверх `SequenceDiceRng`: `drawCampaignInspiration`
/// с костями (крейта костей в зависимостях `sk-agents` нет).
fn sequence_inspiration(sequence: Vec<i64>) -> Box<InspirationDraw> {
    let mut sequence = sequence.into_iter();
    Box::new(move |world: &Value| {
        let filled = |key: &str| !sk_core::text::trim(&js::s(world.get(key))).is_empty();
        let genre = !filled("genre") && !filled("preset");
        let place = !filled("startingLocation");
        let story = !filled("premise") && !filled("openingSituation") && !filled("themes");
        if !(genre || place || story) {
            return Ok(CampaignInspiration { policy_id: CAMPAIGN_INSPIRATION_POLICY_ID, applied: false, genre_lean: None, region: None, hook: None, detail: None });
        }
        let mut roll = |sides: usize| -> Result<usize, BootstrapError> {
            let value = sequence.next().ok_or_else(|| BootstrapError::new("RangeError", None, "Тестовая последовательность бросков закончилась"))?;
            if value < 1 || value > sides as i64 {
                return Err(BootstrapError::new("RangeError", None, format!("Тестовое значение {value} не входит в диапазон 1..{sides}")));
            }
            Ok(value as usize - 1)
        };
        let genre_lean = if genre { Some(INSPIRATION_GENRE_LEANS[roll(INSPIRATION_GENRE_LEANS.len())?]) } else { None };
        let region = if place { Some(&INSPIRATION_REGIONS[roll(INSPIRATION_REGIONS.len())?]) } else { None };
        let hook = if story { Some(INSPIRATION_HOOKS[roll(INSPIRATION_HOOKS.len())?]) } else { None };
        let detail = Some(INSPIRATION_DETAILS[roll(INSPIRATION_DETAILS.len())?]);
        Ok(CampaignInspiration { policy_id: CAMPAIGN_INSPIRATION_POLICY_ID, applied: true, genre_lean, region, hook, detail })
    })
}

fn sanitize(mut state: Value) -> Value {
    if let Some(map) = state.as_object_mut() {
        if map.contains_key("ruleset_locked_at") {
            map.insert("ruleset_locked_at".into(), json!("<now>"));
        }
        if let Some(Value::Array(messages)) = map.get_mut("messages") {
            for message in messages {
                if let Some(message) = message.as_object_mut() {
                    if message.contains_key("timestamp") {
                        message.insert("timestamp".into(), json!("<now>"));
                    }
                }
            }
        }
    }
    state
}

/// Первое расхождение двух значений JSON — путь и обе стороны.
fn first_diff(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            let keys_a: Vec<&String> = a.keys().collect();
            let keys_b: Vec<&String> = b.keys().collect();
            for key in a.keys() {
                match b.get(key) {
                    Some(other) => {
                        if let Some(diff) = first_diff(&format!("{path}.{key}"), &a[key], other) {
                            return Some(diff);
                        }
                    }
                    None => return Some(format!("{path}.{key}: только в Rust")),
                }
            }
            if keys_a != keys_b {
                return Some(format!("{path}: ключи {keys_a:?} против {keys_b:?}"));
            }
            None
        }
        (Value::Array(a), Value::Array(b)) => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                if let Some(diff) = first_diff(&format!("{path}[{index}]"), x, y) {
                    return Some(diff);
                }
            }
            (a.len() != b.len()).then(|| format!("{path}: длина {} против {}", a.len(), b.len()))
        }
        _ => (js::stringify(left) != js::stringify(right)).then(|| format!("{path}: {} против {}", js::stringify(left).chars().take(300).collect::<String>(), js::stringify(right).chars().take(300).collect::<String>())),
    }
}

fn assert_same(label: &str, rust: &Value, js_value: &Value) {
    if let Some(diff) = first_diff("", rust, js_value) {
        panic!("{label}: {diff}");
    }
}

// --- создание кампании --------------------------------------------------------------

#[test]
fn bootstrap_matches_js() {
    let cases = section("bootstrap");
    assert!(cases.len() > 150);
    let mut failures = Vec::new();
    for case in cases {
        let label = js::s(case.get("label"));
        let client = client_of(&case["llm"], true);
        let lore = client_of(&case["lore"], false);
        let author = case["hasLoreAuthor"].as_bool().unwrap_or(false).then(|| LoreAuthor::new(as_client(&lore)));
        let dice = case["dice"].as_array().map(|values| sequence_inspiration(values.iter().filter_map(Value::as_i64).collect()));
        let bootstrapper = CampaignBootstrapper::new(as_client(&client), author, dice, Some(&json!(0)));
        let outcome = block_on(bootstrapper.create(&case["input"]));
        let calls = recorded(&client);
        if let Some(diff) = first_diff("calls", &calls, &case["calls"]) {
            failures.push(format!("{label}: запросы к модели — {diff}"));
            continue;
        }
        if let Some(diff) = first_diff("loreCalls", &recorded(&lore), &case["loreCalls"]) {
            failures.push(format!("{label}: летописец — {diff}"));
            continue;
        }
        match outcome {
            Ok(state) => {
                let state = sanitize(state);
                match case.get("ok") {
                    Some(expected) => {
                        let hash = sha(&js::stringify(&state));
                        if Some(hash.as_str()) != expected.as_str() {
                            let detail = match case.get("state") {
                                Some(full) => first_diff("state", &state, full).unwrap_or_default(),
                                None => format!(
                                    "сводка Rust {}, JS {}",
                                    js::stringify(&json!({
                                        "campaign": state["campaign"], "generatedBy": state["campaignConcept"]["generatedBy"], "location": state["scene"]["location"],
                                        "players": state["players"].as_array().map(|players| players.iter().map(|p| json!([p["id"], p["x"], p["y"]])).collect::<Vec<_>>()),
                                    })),
                                    js::stringify(&case["summary"])
                                ),
                            };
                            failures.push(format!("{label}: состояние расходится — {detail}"));
                        }
                    }
                    None => failures.push(format!("{label}: Rust создал кампанию, JS — {}", js::stringify(&case["err"]))),
                }
            }
            Err(error) => {
                if bootstrap_error(&error) != case["err"] {
                    failures.push(format!("{label}: ошибка {} против {}", js::stringify(&bootstrap_error(&error)), js::stringify(&case["err"])));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} из {} случаев:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

#[test]
fn opening_canon_matches_js() {
    for case in section("canon") {
        let value = if case["undef"].as_bool() == Some(true) { None } else { Some(&case["value"]) };
        assert_eq!(json!(normalize_opening_canon(value)), case["out"], "{}", js::stringify(&case["value"]));
    }
}

// --- рекап -----------------------------------------------------------------------------

#[test]
fn recap_sources_match_js() {
    for case in section("recapSources") {
        let sources = recap_sources(&case["state"], None);
        assert_same("recapSources", &sources, &case["sources"]);
        assert_eq!(deterministic_recap_text(&sources), js::s(case.get("text")));
    }
    for case in section("recapDeterministic") {
        assert_eq!(deterministic_recap_text(&case["sources"]), js::s(case.get("text")), "{}", js::stringify(&case["sources"]));
    }
}

fn temp_file(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sk-a1-{}-{}", std::process::id(), sk_core::hash::uuid_v4()));
    std::fs::create_dir_all(&dir).expect("временный каталог");
    dir.join(name)
}

#[test]
fn recap_service_matches_js() {
    let now = FIXTURE["recapNow"].as_f64().expect("часы");
    for (index, run) in section("recapRuns").iter().enumerate() {
        let file = temp_file("recap-cache.json");
        let script = &run["script"];
        // В JS сценарий повторён десять раз — по ответу на каждый вызов.
        let repeated: Value = if script.is_null() {
            Value::Null
        } else {
            Value::Array((0..10).flat_map(|_| script.as_array().cloned().unwrap_or_default()).collect())
        };
        let client = client_of(&repeated, false);
        let with_cache = run["withCache"].as_bool().unwrap_or(false);
        let gap = run.get("gapHours").filter(|value| value.as_str() != Some("__undefined__"));
        let service = CampaignRecapService::new(as_client(&client), with_cache.then(|| RecapCacheStore::new(&file)), gap, Some(Arc::new(move || now)));
        let inputs = section("recapCalls");
        let results: Vec<Value> = inputs.iter().map(|input| block_on(service.recap_for(input)).expect("кеш пишется")).collect();
        assert_same(&format!("recapRuns[{index}].results"), &json!(results), &run["results"]);
        assert_same(&format!("recapRuns[{index}].calls"), &recorded(&client), &run["calls"]);
        let cache = std::fs::read_to_string(&file).ok().map(|text| serde_json::from_str::<Value>(&text).expect("кеш — JSON")).unwrap_or(Value::Null);
        assert_same(&format!("recapRuns[{index}].cache"), &cache, &run["cache"]);
    }
}

#[test]
fn recap_cache_matches_js() {
    let cases = section("recapCache");
    let gets = [("ASTO-1", json!(3)), ("ASTO-1", json!(2)), ("X", json!(1)), ("B", json!(1)), ("x", json!("1"))];
    for (index, case) in cases.iter().enumerate() {
        let file = temp_file("recap-cache.json");
        let store = RecapCacheStore::new(&file);
        match case["content"].as_str() {
            Some(content) => {
                std::fs::write(&file, content).expect("запись");
                let got: Vec<Value> = gets.iter().map(|(id, version)| store.get(Some(&json!(id)), Some(version)).unwrap_or(Value::Null)).collect();
                assert_same(&format!("recapCache[{index}].gets"), &json!(got), &case["gets"]);
                store.set(Some(&json!("ASTO-1")), Some(&json!(9)), &json!({ "text": "новое", "provider": "model", "created_at": "c" })).expect("set");
            }
            None => {
                for n in 0..205 {
                    store.set(Some(&json!(format!("C-{n}"))), Some(&json!(n)), &json!({ "text": format!("t{n}") })).expect("set");
                }
                store.set(Some(&json!("C-3")), Some(&json!(50)), &json!({ "text": "обновлено" })).expect("set");
            }
        }
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("кеш")).expect("JSON");
        assert_same(&format!("recapCache[{index}].after"), &after, &case["after"]);
    }
    for case in section("recapKeys") {
        let args = case["args"].as_array().expect("args");
        let undef = case["undef"].as_array().expect("undef");
        let arg = |index: usize| if undef[index].as_bool() == Some(true) { None } else { Some(&args[index]) };
        let store = RecapCacheStore::new(temp_file("k.json"));
        assert_eq!(store.key(arg(0), arg(1)), js::s(case.get("key")), "{}", js::stringify(case));
    }
}

// --- творческий режиссёр --------------------------------------------------------------

struct Narrator {
    reply: Value,
    renders: Mutex<Vec<Value>>,
}

impl CriticalNarrator for Narrator {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.renders.lock().unwrap().push(json!({ "brief": brief, "options": options }));
        let reply = self.reply.clone();
        Box::pin(async move { Ok(reply) })
    }
}

fn optional<'a>(case: &'a Value, key: &str, undef: &str) -> Option<&'a Value> {
    if case[undef].as_bool() == Some(true) {
        None
    } else {
        Some(&case[key])
    }
}

#[test]
fn critical_moments_match_js() {
    for case in section("moments") {
        let events = case["events"].as_array().cloned().unwrap_or_default();
        let moment = critical_moment_for(&events, &case["state"]).unwrap_or(Value::Null);
        assert_same("criticalMomentFor", &moment, &case["moment"]);
        let flourish = hero_flourish_for(&events, &case["state"], optional(case, "note", "noteUndef"), optional(case, "actorId", "actorUndef")).unwrap_or(Value::Null);
        assert_same("heroFlourishFor", &flourish, &case["flourish"]);
    }
    for case in section("lines") {
        let events = case["events"].as_array().cloned().unwrap_or_default();
        assert_eq!(critical_moment_line(&case["trigger"], &events), js::s(case.get("out")), "{}", js::stringify(case));
    }
}

#[test]
fn creative_director_matches_js() {
    for (index, case) in section("creative").iter().enumerate() {
        let narrator = Arc::new(Narrator { reply: case["reply"].clone(), renders: Mutex::new(Vec::new()) });
        let director = CriticalNarrationCoordinator::new(Arc::clone(&narrator) as Arc<dyn CriticalNarrator>);
        let input = &case["input"];
        let outcome = block_on(async {
            match case["method"].as_str() {
                Some("renderAftermath") => director.render_aftermath(input).await,
                Some("renderEncounterOpening") => director.render_encounter_opening(input).await,
                _ => director.render_critical_moment(input).await,
            }
        });
        let renders = Value::Array(narrator.renders.lock().unwrap().clone());
        assert_same(&format!("creative[{index}] {} renders", js::s(case.get("method"))), &renders, &case["renders"]);
        match outcome {
            Ok(out) => assert_same(&format!("creative[{index}] out"), &out.unwrap_or(Value::Null), &case["out"]),
            Err(error) => panic!("creative[{index}]: {error}, JS {}", js::stringify(&case["err"])),
        }
    }
}

// --- летописец и хранитель знаний -----------------------------------------------------

#[test]
fn lore_author_matches_js() {
    for (index, case) in section("lore").iter().enumerate() {
        let client = client_of(&case["script"], false);
        let author = LoreAuthor::new(as_client(&client));
        let outcome = block_on(async {
            if case["kind"] == "prologue" {
                author.compose_prologue(&case["input"]).await
            } else {
                author.compose_arc_chronicle(&case["input"]).await
            }
        });
        assert_same(&format!("lore[{index}] calls"), &recorded(&client), &case["calls"]);
        match outcome {
            Ok(text) => assert_eq!(json!(text), case["out"], "lore[{index}]"),
            Err(error) => assert_eq!(error_json(&error.name, None, &error.message), case["err"], "lore[{index}]"),
        }
    }
}

#[test]
fn lore_voice_matches_js() {
    for case in section("verify") {
        let material = optional(case, "material", "materialUndef");
        let context = optional(case, "context", "contextUndef");
        let outcome = verify_lore_answer(Some(&case["answer"]), material, context);
        match outcome {
            Ok(verdict) => assert_eq!(verdict.to_json(), case["out"], "{}", js::stringify(case)),
            Err(error) => assert_eq!(json!(error), json!(format!("{}: {}", js::s(case["err"].get("name")), js::s(case["err"].get("message")))), "{}", js::stringify(case)),
        }
    }
    for (index, case) in section("retell").iter().enumerate() {
        let client = client_of(&case["script"], false);
        let timeout = case.get("timeout").filter(|value| value.as_str() != Some("__undefined__")).cloned();
        let voice = LoreVoice::new(as_client(&client), timeout);
        let out = block_on(voice.retell(&case["input"])).unwrap_or(Value::Null);
        assert_same(&format!("retell[{index}] calls"), &recorded(&client), &case["calls"]);
        assert_same(&format!("retell[{index}] out"), &out, &case["out"]);
    }
}
