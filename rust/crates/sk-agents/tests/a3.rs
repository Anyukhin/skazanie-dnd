//! Эталоны задачи А3 (`fixtures/gen-a3.mjs` → `fixtures/a3.json.gz`):
//! `free-action-adjudication` и `action-adjudicator` JS и Rust на одних
//! входах — детерминированные функции по хешу результата, арбитр с моделью —
//! на одной записывающей заглушке (запросы к модели и итог).

use std::future::Future;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_agents::action_adjudicator::{
    adjudication_brief, clean_success_detail, clean_travel_destination, known_scene_description, revealed_prop_predicate, ActionAdjudicator, DiscussOptions,
    ACTION_ADJUDICATOR_PROMPT, ACTION_ADJUDICATOR_PROMPT_VERSION,
};
use sk_agents::free_action_adjudication as fa;
use sk_agents::free_action_adjudication::{FreeActionError, MundaneContext};
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_core::js;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/a3.json.gz")[..]).read_to_string(&mut text).expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn phrase(index: &Value) -> &'static str {
    index.as_u64().and_then(|index| FIXTURE["phrases"].get(index as usize)).and_then(Value::as_str).unwrap_or("")
}

fn state_at(index: &Value) -> &'static Value {
    &FIXTURE["states"][index.as_u64().unwrap_or(0) as usize]["state"]
}

fn sha(text: &str) -> String {
    sk_core::hash::sha256_hex(text.as_bytes())
}

fn short(value: &Value) -> String {
    sha(&js::stringify(value))[..12].to_string()
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

struct Scripted {
    replies: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
    /// Пользовательское сообщение записывается хешем (как в эталоне).
    hash_user: bool,
}

impl Scripted {
    fn new(replies: Vec<Value>, hash_user: bool) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies), calls: Mutex::new(Vec::new()), hash_user })
    }

    fn calls(&self) -> Value {
        Value::Array(self.calls.lock().unwrap().clone())
    }
}

fn error_without_code(message: &str) -> LlmError {
    LlmError { name: "Error".into(), code: None, message: message.into(), details: Map::new(), provider_usage: None }
}

impl LlmClient for Scripted {
    fn model(&self) -> Option<String> {
        None
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(error_without_code("complete не ожидается")) })
    }

    fn complete_json<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let mut copy = input.clone();
        if let Some(messages) = copy.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                let role = message.get("role").and_then(Value::as_str).unwrap_or("").to_string();
                if role == "system" || (role == "user" && self.hash_user) {
                    let content = js::s(message.get("content"));
                    message["content"] = json!(format!("sha256:{}", sha(&content)));
                }
            }
        }
        self.calls.lock().unwrap().push(json!({ "method": "completeJson", "input": copy, "options": options }));
        let reply = {
            let mut replies = self.replies.lock().unwrap();
            if replies.is_empty() { None } else { Some(replies.remove(0)) }
        };
        let answer = match reply {
            None => Err(error_without_code("Сценарий модели закончился")),
            Some(reply) => match reply.get("error") {
                Some(error) => {
                    let message = error.get("message").and_then(Value::as_str).unwrap_or("отказ");
                    Err(match error.get("code").and_then(Value::as_str) {
                        Some(code) => LlmError::new(code, message),
                        None => error_without_code(message),
                    })
                }
                None => Ok(reply.get("value").cloned().unwrap_or(Value::Null)),
            },
        };
        Box::pin(async move { answer })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

/// Первое расхождение двух значений JSON — путь и обе стороны.
fn first_diff(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
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
            for key in b.keys() {
                if !a.contains_key(key) {
                    return Some(format!("{path}.{key}: только в JS"));
                }
            }
            let (ka, kb): (Vec<_>, Vec<_>) = (a.keys().collect(), b.keys().collect());
            (ka != kb).then(|| format!("{path}: порядок ключей {ka:?} против {kb:?}"))
        }
        (Value::Array(a), Value::Array(b)) => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                if let Some(diff) = first_diff(&format!("{path}[{index}]"), x, y) {
                    return Some(diff);
                }
            }
            (a.len() != b.len()).then(|| format!("{path}: длина {} против {}", a.len(), b.len()))
        }
        _ => (js::stringify(left) != js::stringify(right)).then(|| {
            let cut = |value: &Value| js::stringify(value).chars().take(400).collect::<String>();
            format!("{path}: {} против {}", cut(left), cut(right))
        }),
    }
}

fn error_value(error: &FreeActionError) -> Value {
    json!({ "__error": error.to_json() })
}

fn or_null(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

fn result_value(result: Result<Value, FreeActionError>) -> Value {
    result.unwrap_or_else(|error| error_value(&error))
}

fn utf16_head(text: &str, limit: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(limit).collect();
    String::from_utf16_lossy(&units)
}

// --- без состояния -----------------------------------------------------------------

fn pure_bundle(text: &str) -> Value {
    let value = json!(text);
    let mut out = Map::new();
    out.insert("interpret".into(), fa::interpret_free_action(text));
    out.insert("recognized".into(), json!(fa::has_recognized_free_action_approach(text)));
    out.insert("approach".into(), or_null(fa::approach_request_from(text).map(|request| request.to_json())));
    out.insert("corpse".into(), json!(fa::free_action_is_corpse_search(text)));
    out.insert("copy".into(), json!(fa::free_action_is_copy_request(text)));
    out.insert("passageGoal".into(), json!(fa::free_action_goal_is_passage(text)));
    out.insert("hazardId".into(), json!(fa::canonical_environment_hazard_id(Some(&value))));
    out.insert("mundane".into(), or_null(fa::mundane_action_outcome(text, &MundaneContext::default())));
    let context = MundaneContext {
        hero_name: "Мирель".into(),
        in_combat: false,
        npc_names: vec!["Старый Финн".into(), "Лида".into(), "Ждан".into(), "Четвёртый".into()],
        onward: "Скальный маяк".into(),
    };
    out.insert("mundaneCtx".into(), or_null(fa::mundane_action_outcome(text, &context)));
    out.insert("mundaneCombat".into(), or_null(fa::mundane_action_outcome(text, &MundaneContext { in_combat: true, ..MundaneContext::default() })));
    out.insert("fingerprint".into(), json!(fa::attempt_fingerprint("hero", text, &utf16_head(text, 20))));
    out.insert("travel".into(), json!(clean_travel_destination(Some(&value))));
    out.insert("detail".into(), json!(clean_success_detail(Some(&value))));
    Value::Object(out)
}

#[test]
fn prompt_matches_js() {
    assert_eq!(FIXTURE["promptVersion"], json!(ACTION_ADJUDICATOR_PROMPT_VERSION));
    assert_eq!(FIXTURE["promptSha"], json!(sha(ACTION_ADJUDICATOR_PROMPT)), "промпт расходится с блобом JS (CRLF?)");
}

#[test]
fn pure_functions_match_js() {
    let phrases = FIXTURE["phrases"].as_array().expect("фразы");
    let cases = section("pure");
    assert_eq!(phrases.len(), cases.len());
    assert!(cases.len() > 1_000);
    let mut failures = Vec::new();
    for (text, case) in phrases.iter().zip(cases) {
        let text = text.as_str().unwrap_or("");
        let out = pure_bundle(text);
        if case["h"] != json!(short(&out)) {
            let detail = case.get("out").and_then(|expected| first_diff("", &out, expected)).unwrap_or_else(|| js::stringify(&out).chars().take(600).collect());
            failures.push(format!("{text:?}: {detail}"));
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

fn undefined_or(value: &Value) -> Option<&Value> {
    (value.as_str() != Some("__undefined__")).then_some(value)
}

#[test]
fn normalization_matches_js() {
    let cases = section("normalizeCases");
    assert!(cases.len() >= 600);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let text = js::s(case.get("text"));
        let mut out = Map::new();
        out.insert("normalize".into(), fa::normalize_free_action_reading(input, &text));
        out.insert("mode".into(), fa::resolution_mode_for(input));
        out.insert("policy".into(), fa::free_action_resolution_policy(input));
        out.insert("failForward".into(), fa::fail_forward_for(input.get("risk"), input.get("consequence_type")));
        out.insert("explain".into(), json!(fa::explain_action_check(input)));
        let mut label = Map::new();
        if let Some(kind) = undefined_or(&case["kind"]) {
            label.insert("kind".into(), kind.clone());
        }
        for key in ["ability", "skill"] {
            if let Some(value) = input.get(key) {
                label.insert(key.into(), value.clone());
            }
        }
        out.insert("label".into(), json!(fa::d20_check_label(&Value::Object(label))));
        out.insert("promise".into(), json!(fa::free_action_success_promise(input, case["passage"].as_bool().unwrap_or(false))));
        out.insert("promiseNo".into(), json!(fa::free_action_success_promise(input, false)));
        let mut stakes_input = input.as_object().cloned().unwrap_or_default();
        stakes_input.insert("resolution".into(), case["resolution"].clone());
        stakes_input.insert("outcome_policy".into(), if case["withPolicy"].as_bool() == Some(true) { fa::free_action_resolution_policy(input) } else { Value::Null });
        out.insert("stakes".into(), or_null(fa::stakes_for(&Value::Object(stakes_input))));
        out.insert("minutes".into(), json!(fa::minutes_label_ru(undefined_or(&case["minutes"]))));
        out.insert("damage".into(), json!(fa::damage_type_label_ru(undefined_or(&case["damage"]))));
        let out = Value::Object(out);
        if case["h"] != json!(short(&out)) {
            let detail = case.get("out").and_then(|expected| first_diff("", &out, expected)).unwrap_or_else(|| format!("вход {} → {}", js::stringify(input), js::stringify(&out).chars().take(900).collect::<String>()));
            failures.push(format!("[{index}] {detail}"));
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn confirmation_matches_js() {
    for case in section("confirmCases") {
        let context = (!case["context"].is_null()).then_some(&case["context"]);
        let outcome = fa::assert_free_action_confirmation(context, &js::s(case.get("text")), undefined_or(&case["version"]));
        let got = match outcome {
            Ok(()) => json!({ "ok": true }),
            Err(error) => json!({ "err": error.to_json() }),
        };
        // `null` в JS — TypeError на `context.kind`? Нет: `context?.kind` — сравнение даёт отказ.
        assert_eq!(got, case["out"], "{}", js::stringify(case));
    }
}

// --- с состоянием ------------------------------------------------------------------

fn state_bundle(state: &Value, actor_id: &str, text: &str) -> Map<String, Value> {
    let interp = fa::interpret_free_action(text);
    let bound = fa::bind_free_action_reading_to_state(state, actor_id, text, &interp, false).ok();
    let mut out = Map::new();
    out.insert("harmless".into(), or_null(fa::harmless_free_action_reading(state, actor_id, text)));
    out.insert("roleplay".into(), or_null(fa::roleplay_speech_reading(state, text)));
    out.insert("bound".into(), result_value(fa::bind_free_action_reading_to_state(state, actor_id, text, &interp, false)));
    let mut preserved = interp.clone();
    preserved["policy_version"] = json!("free-action-resolution/v1");
    preserved["target_id"] = json!("ally");
    out.insert("preserved".into(), result_value(fa::bind_free_action_reading_to_state(state, actor_id, text, &preserved, true)));
    let reading = bound.unwrap_or_else(|| interp.clone());
    out.insert("contextual".into(), fa::contextual_resolution_for(state, actor_id, &reading, text));
    out.insert("contact".into(), or_null(fa::resolve_hazard_contact(state, actor_id, text, &reading)));
    out.insert("contactRaw".into(), or_null(fa::resolve_hazard_contact(state, actor_id, text, &json!({ "risk": "deadly", "target_id": "x" }))));
    out.insert("transfer".into(), or_null(fa::resolve_inventory_transfer(state, actor_id, text, &reading)));
    out.insert("exploration".into(), or_null(fa::resolve_exploration_command(state, actor_id, text)));
    out.insert("approachPlan".into(), fa::free_action_approach_plan(state, actor_id, text));
    out.insert("pickpocket".into(), or_null(fa::resolve_pickpocket(state, actor_id, text, &reading)));
    out.insert("corpse".into(), fa::resolve_corpse_search(state, actor_id, text, &reading).map(or_null).unwrap_or_else(|error| error_value(&error)));
    out.insert("passage".into(), fa::free_action_passage_plan(state, actor_id, text));
    out.insert("passageDestination".into(), or_null(fa::free_action_passage_destination(state, actor_id, text)));
    out.insert("place".into(), json!(fa::passage_destination_place(state, text)));
    out.insert("means".into(), fa::verify_means(state, actor_id, reading.get("required_means")));
    let hazard = reading.get("hazard").filter(|hazard| js::truthy(Some(hazard))).cloned().unwrap_or_else(|| json!("fire"));
    out.insert("hazardNear".into(), json!(fa::confirmed_hazard_near(state, actor_id, Some(&hazard))));
    out.insert("policy".into(), fa::free_action_resolution_policy(&reading));
    out
}

/// Ключи, которые чаще всего расходятся, — по ним сводка в отчёте.
fn tally(failures: &mut std::collections::BTreeMap<String, (usize, Vec<String>)>, key: &str, note: String) {
    let entry = failures.entry(key.to_string()).or_default();
    entry.0 += 1;
    if entry.1.len() < 6 {
        entry.1.push(note);
    }
}

#[test]
fn state_functions_match_js() {
    let cases = section("stateCases");
    assert!(cases.len() > 10_000);
    // Случаи независимы: проверяются параллельно, расхождения собираются в конце.
    let threads = std::thread::available_parallelism().map_or(4, usize::from).clamp(1, 12);
    let chunk = cases.len().div_ceil(threads);
    let results: Vec<Vec<(String, String)>> = std::thread::scope(|scope| {
        let handles: Vec<_> = cases
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    let mut found = Vec::new();
                    for case in part {
                        let state = state_at(&case["s"]);
                        let actor = js::s(case.get("a"));
                        let text = phrase(&case["t"]);
                        for (key, value) in &state_bundle(state, &actor, text) {
                            if case["h"][key] != json!(short(value)) {
                                let label = js::s(FIXTURE["states"][case["s"].as_u64().unwrap_or(0) as usize].get("label"));
                                let detail = case.get("out").and_then(|full| full.get(key)).and_then(|expected| first_diff("", value, expected)).unwrap_or_else(|| js::stringify(value).chars().take(500).collect());
                                found.push((key.clone(), format!("{label} / {actor} / {text:?}: {detail}")));
                            }
                        }
                    }
                    found
                })
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap_or_default()).collect()
    });
    let mut failures = std::collections::BTreeMap::new();
    let mut failed = 0;
    for (key, note) in results.into_iter().flatten() {
        failed += 1;
        tally(&mut failures, &key, note);
    }
    let report: Vec<String> = failures.iter().map(|(key, (count, notes))| format!("{key}: {count}\n  {}", notes.join("\n  "))).collect();
    assert!(failed == 0, "{failed} из {} случаев:\n{}", cases.len(), report.join("\n"));
}

#[test]
fn per_state_summaries_match_js() {
    let probe = json!(["верёвка", "Верёвка", "огниво", "заклинание «Огненный снаряд»", "Священное пламя", "заговор «Священное пламя»", "sacred-flame", "меч", "Факел", "умение «Второе дыхание»", "боевой стиль «Защита»", "атлетика", "athletics", "несуществующее", ""]);
    let mut failures = Vec::new();
    for (index, (entry, case)) in FIXTURE["states"].as_array().expect("состояния").iter().zip(section("perState")).enumerate() {
        let state = &entry["state"];
        let actor = js::s(entry["actors"].get(0));
        let mut out = Map::new();
        out.insert("description".into(), json!(known_scene_description(state)));
        out.insert("situation".into(), json!(fa::situation_fingerprint(state)));
        out.insert("previous".into(), or_null(fa::previous_failed_attempt(state, "x")));
        out.insert("means".into(), fa::verify_means(state, &actor, Some(&probe)));
        out.insert("meansNone".into(), fa::verify_means(state, &actor, None));
        let predicate = revealed_prop_predicate(state);
        let props = state.pointer("/scene/map/props").and_then(Value::as_array).cloned().unwrap_or_default();
        out.insert("revealed".into(), json!(props.iter().map(|prop| predicate.test(prop)).collect::<Vec<_>>()));
        let mut containers = sk_director::loot_containers::loot_containers_in_scene(state, true).unwrap_or_default();
        containers.extend([json!({ "x": 1.5, "y": 2 }), json!({ "x": "a" }), json!({})]);
        out.insert("lootApproach".into(), json!(containers.iter().map(|container| or_null(fa::loot_approach_destination(state, &actor, container))).collect::<Vec<_>>()));
        let dialogue = json!({ "recent": [{ "question": "Можно?", "answer": "Да" }], "action": "Поджигаю", "request_kind": "question" });
        let briefs = [adjudication_brief(state, &actor, "Осматриваюсь", None), adjudication_brief(state, &actor, "Поджигаю сено", Some(&dialogue))];
        out.insert("briefs".into(), json!(briefs.iter().map(short).collect::<Vec<_>>()));
        for (key, value) in &out {
            if case["h"][key] != json!(short(value)) {
                let detail = case.get("out").and_then(|full| full.get(key)).and_then(|expected| first_diff("", value, expected)).unwrap_or_else(|| js::stringify(value).chars().take(400).collect());
                failures.push(format!("[{index}] {} {key}: {detail}", js::s(entry.get("label"))));
            }
        }
    }
    assert!(failures.is_empty(), "{}:\n{}", failures.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn full_briefs_match_js() {
    for (index, expected) in section("briefFull").iter().enumerate() {
        let entry = &FIXTURE["states"][index];
        let brief = adjudication_brief(&entry["state"], &js::s(entry["actors"].get(0)), "Осматриваюсь", None);
        if let Some(diff) = first_diff("brief", &brief, expected) {
            panic!("[{index}] {diff}");
        }
    }
}

// --- арбитр с моделью ---------------------------------------------------------------

fn user_hashed(calls: &Value) -> bool {
    calls[0]["input"]["messages"][1]["content"].as_str().is_some_and(|content| content.starts_with("sha256:"))
}

#[test]
fn adjudicator_read_matches_js() {
    let cases = section("readCases");
    assert!(cases.len() > 500);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let state = state_at(&case["s"]);
        let actor = js::s(case.get("a"));
        let text = js::s(case.get("text"));
        let client = (!case["reply"].is_null()).then(|| Scripted::new(vec![case["reply"].clone()], user_hashed(&case["calls"])));
        let timeout = case["timeout"].as_i64().map(Value::from);
        let prompt = case["systemPrompt"].as_str().map(str::to_string);
        let adjudicator = ActionAdjudicator::new(client.as_ref().map(|client| Arc::clone(client) as Arc<dyn LlmClient>), timeout, prompt);
        let dialogue = &case["dialogue"];
        let outcome = block_on(adjudicator.read(state, &actor, &text, &case["fallback"], Some(dialogue)));
        let calls = client.as_ref().map(|client| client.calls()).unwrap_or_else(|| json!([]));
        let label = format!("[{index}] {} / {}", js::s(case.get("label")), js::s(FIXTURE["states"][case["s"].as_u64().unwrap_or(0) as usize].get("label")));
        if let Some(diff) = first_diff("calls", &calls, &case["calls"]) {
            failures.push(format!("{label}: запросы — {diff}"));
            continue;
        }
        let got = match outcome {
            Ok(value) => json!({ "ok": value }),
            Err(error) => json!({ "err": error.to_json() }),
        };
        let expected = match case.get("ok") {
            Some(value) => json!({ "ok": value }),
            None => json!({ "err": case["err"] }),
        };
        if let Some(diff) = first_diff("", &got, &expected) {
            failures.push(format!("{label}: итог — {diff}"));
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn adjudicator_discuss_matches_js() {
    let cases = section("discussCases");
    assert!(cases.len() > 100);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let state = state_at(&case["s"]);
        let actor = js::s(case.get("a"));
        let client = (!case["reply"].is_null()).then(|| Scripted::new(vec![case["reply"].clone()], true));
        let adjudicator = ActionAdjudicator::new(client.as_ref().map(|client| Arc::clone(client) as Arc<dyn LlmClient>), None, None);
        let options = &case["options"];
        let discuss = DiscussOptions {
            action: js::s(options.get("action")),
            recent: options.get("recent").and_then(Value::as_array).cloned().unwrap_or_default(),
            check: options.get("check").cloned(),
        };
        let outcome = block_on(adjudicator.discuss(state, &actor, &js::s(case.get("question")), &discuss));
        let calls = client.as_ref().map(|client| client.calls()).unwrap_or_else(|| json!([]));
        let label = format!("[{index}] {} / {}", js::s(case.get("question")), js::s(FIXTURE["states"][case["s"].as_u64().unwrap_or(0) as usize].get("label")));
        if let Some(diff) = first_diff("calls", &calls, &case["calls"]) {
            failures.push(format!("{label}: запросы — {diff}"));
            continue;
        }
        let got = match outcome {
            Ok(value) => json!({ "ok": value }),
            Err(error) => json!({ "err": error.to_json() }),
        };
        let expected = match case.get("ok") {
            Some(value) => json!({ "ok": value }),
            None => json!({ "err": case["err"] }),
        };
        if let Some(diff) = first_diff("", &got, &expected) {
            failures.push(format!("{label}: итог — {diff}"));
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}
