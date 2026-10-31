//! Эталоны задачи А4 (`fixtures/gen-a4.mjs` → `fixtures/a4.json.gz`):
//! `NpcSocialController` JS и Rust на одной заглушке модели — сверяются
//! запросы к модели (брифы байт в байт) и итог; плюс экспорты модуля.

use std::future::Future;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_agents::npc_social_controller::{conversation_leads, fresh_reply_text, others_said_nearby, without_circular_referral, NpcSocialController, NPC_SOCIAL_PROMPT};
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_core::js;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/a4.json.gz")[..]).read_to_string(&mut text).expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn state_of(reference: &Value) -> Option<&'static Value> {
    reference.as_str().map(|key| &FIXTURE["states"][key])
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
    model: Option<String>,
    replies: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
}

impl Scripted {
    fn new(script: &Value, model: &Value) -> Arc<Self> {
        Arc::new(Self { model: model.as_str().map(String::from), replies: Mutex::new(script.as_array().cloned().unwrap_or_default()), calls: Mutex::new(Vec::new()) })
    }

    fn calls(&self) -> Value {
        Value::Array(self.calls.lock().unwrap().clone())
    }

    fn answer(&self) -> Result<Value, LlmError> {
        let mut replies = self.replies.lock().unwrap();
        if replies.is_empty() {
            return Err(LlmError { name: "Error".into(), code: None, message: "Сценарий модели закончился".into(), details: Map::new(), provider_usage: None });
        }
        let reply = replies.remove(0);
        if let Some(error) = reply.get("error") {
            return Err(LlmError {
                name: error.get("name").and_then(Value::as_str).unwrap_or("Error").into(),
                code: error.get("code").and_then(Value::as_str).map(String::from),
                message: error.get("message").and_then(Value::as_str).unwrap_or("отказ").into(),
                details: Map::new(),
                provider_usage: None,
            });
        }
        Ok(reply.get("value").cloned().unwrap_or(Value::Null))
    }
}

impl LlmClient for Scripted {
    fn model(&self) -> Option<String> {
        self.model.clone()
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError { name: "Error".into(), code: None, message: "complete не ожидается".into(), details: Map::new(), provider_usage: None }) })
    }

    fn complete_json<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let mut input = input.clone();
        if let Some(messages) = input.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if message.get("role").and_then(Value::as_str) == Some("system") {
                    let content = js::s(message.get("content"));
                    message["content"] = json!(format!("sha256:{}", sk_core::hash::sha256_hex(content.as_bytes())));
                }
            }
        }
        self.calls.lock().unwrap().push(json!({ "method": "completeJson", "input": input, "options": options }));
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

// --- сравнение ---------------------------------------------------------------------

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
            let keys_a: Vec<&String> = a.keys().collect();
            let keys_b: Vec<&String> = b.keys().collect();
            (keys_a != keys_b).then(|| format!("{path}: ключи {keys_a:?} против {keys_b:?}"))
        }
        (Value::Array(a), Value::Array(b)) => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                if let Some(diff) = first_diff(&format!("{path}[{index}]"), x, y) {
                    return Some(diff);
                }
            }
            (a.len() != b.len()).then(|| format!("{path}: длина {} против {}", a.len(), b.len()))
        }
        (Value::String(a), Value::String(b)) if a != b => {
            let prefix = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
            let from = prefix.saturating_sub(80);
            Some(format!(
                "{path}: строки расходятся с {prefix}-го знака\n  Rust: …{}\n  JS:   …{}",
                a.chars().skip(from).take(240).collect::<String>(),
                b.chars().skip(from).take(240).collect::<String>()
            ))
        }
        _ => (js::stringify(left) != js::stringify(right))
            .then(|| format!("{path}: {} против {}", js::stringify(left).chars().take(300).collect::<String>(), js::stringify(right).chars().take(300).collect::<String>())),
    }
}

/// Вход `respond`: сохранённые поля плюс состояние из таблицы.
fn respond_input(case: &Value) -> Value {
    let mut input = case["input"].as_object().cloned().unwrap_or_default();
    if let Some(state) = state_of(&case["stateRef"]) {
        input.insert("state".into(), state.clone());
    }
    Value::Object(input)
}

#[test]
fn prompt_is_lf_blob() {
    assert!(!NPC_SOCIAL_PROMPT.contains('\r'), "промпт должен быть с LF, как блоб git");
    assert!(NPC_SOCIAL_PROMPT.starts_with("PROMPT_ID: npc_controller/social-v8"));
}

/// Мусор, на котором JS бросает исключение в соседнем модуле, а его перенос
/// мусор переживает (решение того переноса, не этого модуля):
/// `sceneContextForAgent` (`sk-encounters`) — `state.players` не массив или
/// с `null`, `social.conversations` объектом (бриф в JS падает до вызова
/// модели, Rust модель зовёт); `safeConversation` (`sk-social`) — `null` среди
/// разговоров (JS отвергает весь `respond`).
const UPSTREAM_DIVERGENCES: [&str; 5] = [
    "garbage-players-object-model",
    "garbage-players-null-entry-model",
    "garbage-social-conversations-object-model",
    "garbage-social-conversations-junk-none",
    "garbage-social-conversations-junk-model",
];

#[test]
fn respond_matches_js() {
    let cases = section("respond");
    assert!(cases.len() > 1_000, "случаев {}", cases.len());
    let mut failures = Vec::new();
    let mut upstream = Vec::new();
    for case in cases {
        let label = js::s(case.get("label"));
        if UPSTREAM_DIVERGENCES.contains(&label.as_str()) {
            upstream.push(label);
            continue;
        }
        let client = case["hasClient"].as_bool().unwrap_or(false).then(|| Scripted::new(&case["script"], &case["model"]));
        let mut controller = NpcSocialController::new(client.as_ref().map(|client| Arc::clone(client) as Arc<dyn LlmClient>));
        if let Some(name) = case["className"].as_str() {
            controller = controller.with_provider_name(name);
        }
        let outcome = block_on(controller.respond(&respond_input(case)));
        let calls = client.as_ref().map(|client| client.calls()).unwrap_or_else(|| json!([]));
        if let Some(diff) = first_diff("calls", &calls, &case["calls"]) {
            failures.push(format!("{label}: запросы к модели — {diff}"));
            continue;
        }
        match (outcome, case.get("err")) {
            (Ok(out), None) => {
                if let Some(diff) = first_diff("out", &out.unwrap_or(Value::Null), &case["out"]) {
                    failures.push(format!("{label}: итог — {diff}"));
                }
            }
            (Ok(out), Some(err)) => failures.push(format!("{label}: Rust ответил {}, JS — исключение {}", js::stringify(&out.unwrap_or(Value::Null)).chars().take(200).collect::<String>(), js::stringify(err))),
            (Err(error), Some(err)) => {
                if json!({ "name": error.name, "message": error.message }) != json!({ "name": err["name"], "message": err["message"] }) {
                    failures.push(format!("{label}: исключение {error} против {}", js::stringify(err)));
                }
            }
            (Err(error), None) => failures.push(format!("{label}: Rust — исключение {error}, JS ответил")),
        }
    }
    assert!(failures.is_empty(), "{} из {} случаев:\n{}", failures.len(), cases.len(), failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
    assert_eq!(upstream.len(), UPSTREAM_DIVERGENCES.len(), "известные расхождения соседних модулей есть в эталоне");
}

#[test]
fn conversation_leads_match_js() {
    let cases = section("leads");
    assert!(cases.len() > 100);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let state = state_of(&case["stateRef"]).expect("состояние");
        match (conversation_leads(state, &case["profile"], Some(&case["message"]), None, &sk_core::js::string(case.get("playerId"))), case.get("err")) {
            (Ok(leads), None) => {
                if let Some(diff) = first_diff("leads", &json!(leads), &case["out"]) {
                    failures.push(format!("leads[{index}]: {diff}"));
                }
            }
            (outcome, err) => failures.push(format!("leads[{index}]: {outcome:?} против {err:?}")),
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn others_said_nearby_match_js() {
    for (index, case) in section("others").iter().enumerate() {
        let state = state_of(&case["stateRef"]).expect("состояние");
        let empty = json!({});
        let social = state.get("social").filter(|social| !social.is_null()).unwrap_or(&empty);
        let out = others_said_nearby(state, social, &case["profile"]);
        assert_eq!(json!(out), case["out"], "others[{index}]");
    }
}

#[test]
fn fresh_reply_text_matches_js() {
    let cases = section("fresh");
    assert!(cases.len() > 100);
    for (index, case) in cases.iter().enumerate() {
        let earlier: Vec<String> = case["earlier"].as_array().map(|items| items.iter().map(|item| js::s(Some(item))).collect()).unwrap_or_default();
        let out = fresh_reply_text(&js::s(case.get("reply")), &earlier);
        assert_eq!(out.to_json(), case["out"], "fresh[{index}]: {}", js::stringify(case));
    }
}

#[test]
fn circular_referral_matches_js() {
    let cases = section("circular");
    assert!(cases.len() > 100);
    for (index, case) in cases.iter().enumerate() {
        let state = state_of(&case["stateRef"]).expect("состояние");
        let empty = json!({});
        let social = state.get("social").filter(|social| !social.is_null()).unwrap_or(&empty);
        let out = without_circular_referral(&js::s(case.get("reply")), social, &case["profile"]);
        assert_eq!(json!(out), case["out"], "circular[{index}]: {}", js::s(case.get("reply")));
    }
}
