//! Эталоны задачи А5 (`fixtures/gen-a5.mjs` → `fixtures/a5.json.gz`):
//! журналы вызовов рассказчика JS — открытые функции и `render` с
//! записанными ответами модели (куски потока, ошибки, зависания до срока) —
//! повторяются в Rust шаг в шаг, в том же порядке и с тем же контекстом
//! кампании. Сверяются итоги функций, запросы к модели (системный промпт —
//! хешем), снимки потока, итог `render` и память замечаний.
//!
//! Журналы — из прогонов тестов JS о рассказчике (`record-a5.mjs`) и из
//! сценариев генератора на состояниях корпуса, синтетике и мусоре.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{json, Map, Value};
use sk_agents::narrator::{self, ArcRecapOptions, FeedbackVerifier, Narrator, NarratorConfig, RenderOptions};
use sk_agents_base::llm_client::{CallScope, LlmClient, LlmError, LlmFuture};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;
use sk_narration_base::campaign_ai_context::run_with_campaign_ai_settings;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let bytes: Vec<u8> = match std::env::var("A5_FIXTURE") {
        Ok(path) => std::fs::read(path).expect("эталон читается"),
        Err(_) => include_bytes!("../fixtures/a5.json.gz").to_vec(),
    };
    let mut text = String::new();
    if bytes.starts_with(&[0x1f, 0x8b]) {
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut text).expect("эталон распаковывается");
    } else {
        text = String::from_utf8(bytes).expect("эталон — UTF-8");
    }
    serde_json::from_str(&text).expect("эталон — JSON")
});

/// `{ "$blob": sha }` → значение из таблицы общих кусков.
fn resolve(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            if let (1, Some(Value::String(key))) = (map.len(), map.get("$blob")) {
                return resolve(&FIXTURE["blobs"][key.as_str()]);
            }
            Value::Object(map.iter().map(|(key, item)| (key.clone(), resolve(item))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(resolve).collect()),
        other => other.clone(),
    }
}

/// `{ u: true }` — `undefined`, `{ v }` — значение.
fn decode(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if value.get("u").is_some() {
        return None;
    }
    value.get("v").map(resolve)
}

fn sha(text: &str) -> String {
    sk_core::hash::sha256_hex(text.as_bytes())
}

// --- клиент модели по записи ------------------------------------------------------

struct ReplayClient {
    model: Option<String>,
    script: Mutex<VecDeque<Value>>,
    seen: Mutex<Vec<Value>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn hashed_request(input: &Value) -> Value {
    let mut copy = input.clone();
    if let Some(messages) = copy.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if message.get("role").and_then(Value::as_str) == Some("system") {
                if let Some(content) = message.get("content").and_then(Value::as_str) {
                    let hashed = format!("sha256:{}", sha(content));
                    message["content"] = Value::String(hashed);
                }
            }
        }
    }
    copy
}

fn error_from(value: &Value) -> LlmError {
    LlmError {
        name: js::s(value.get("name")),
        code: value.get("code").and_then(Value::as_str).map(str::to_string),
        message: js::s(value.get("message")),
        details: Map::new(),
        provider_usage: None,
    }
}

impl ReplayClient {
    fn call<'a>(&'a self, method: &'static str, input: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let scripted = lock(&self.script).pop_front();
        let request = hashed_request(input);
        Box::pin(async move {
            let hooks = CallScope::current().hooks;
            let mut deltas_out = Vec::new();
            if let (Some(script), Some(handler)) = (scripted.as_ref(), hooks.on_delta.as_ref()) {
                for piece in script["deltas"].as_array().cloned().unwrap_or_default() {
                    let outcome = handler.call(js::s(piece.get("text"))).await;
                    deltas_out.push(json!({ "text": piece["text"], "threw": outcome.err().map(|error| error.code.unwrap_or_default()) }));
                }
            }
            lock(&self.seen).push(json!({
                "method": method,
                "request": request,
                "has_signal": hooks.signal.is_some(),
                "has_on_delta": hooks.on_delta.is_some(),
                "deltas": deltas_out,
            }));
            let Some(script) = scripted else {
                return Err(LlmError::new("REPLAY_EXHAUSTED", "в записи нет такого вызова"));
            };
            let pending = script.get("outcome").is_none() || script.get("after_abort") == Some(&Value::Bool(true));
            if pending {
                std::future::pending::<()>().await;
            }
            match (&script["outcome"]["value"], script["outcome"].get("error")) {
                (_, Some(error)) => Err(error_from(error)),
                (value, None) => Ok(resolve(value)),
            }
        })
    }
}

impl LlmClient for ReplayClient {
    fn model(&self) -> Option<String> {
        self.model.clone()
    }

    fn complete<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.call("complete", input)
    }

    fn complete_json<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.call("completeJson", input)
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

// --- повтор журнала ----------------------------------------------------------------

struct Instance {
    narrator: Narrator,
    client: Option<Arc<ReplayClient>>,
    skip: bool,
}

#[derive(Default)]
struct Report {
    checked: usize,
    skipped: usize,
    mismatches: Vec<String>,
    by_kind: IndexMap<String, usize>,
}

impl Report {
    fn compare(&mut self, label: &str, kind: &str, rust: &Value, expected: &Value) {
        self.checked += 1;
        *self.by_kind.entry(kind.to_string()).or_insert(0) += 1;
        let left = js::stringify(rust);
        let right = js::stringify(expected);
        if std::env::var("A5_DEBUG").is_ok_and(|filter| label.contains(&filter)) {
            eprintln!("{label} [{kind}]
  rust: {}
  js:   {}", left.chars().take(1500).collect::<String>(), right.chars().take(1500).collect::<String>());
        }
        if left != right {
            let at = left.chars().zip(right.chars()).take_while(|(a, b)| a == b).count();
            let window = |text: &str| text.chars().skip(at.saturating_sub(120)).take(360).collect::<String>();
            self.mismatches.push(format!("{label} [{kind}]\n  rust: …{}…\n  js:   …{}…", window(&left), window(&right)));
        }
    }
}

fn settings_of(event: &Value) -> Option<Value> {
    event.get("settings").filter(|value| !value.is_null()).cloned()
}

fn arg(event: &Value, index: usize) -> Option<Value> {
    decode(event["args"].get(index))
}

fn list(value: &Option<Value>) -> Vec<Value> {
    value.as_ref().and_then(Value::as_array).cloned().unwrap_or_default()
}

fn opt_prop(value: &Option<Value>, key: &str) -> Option<Value> {
    value.as_ref().and_then(|value| value.get(key)).cloned()
}

fn out_value(event: &Value) -> Value {
    decode(event.get("out")).unwrap_or(Value::Null)
}

/// Открытая функция по имени JS; `None` — случай не переносится (в JS —
/// исключение или аргумент, которого нет у Rust).
fn call_function(event: &Value) -> Option<Value> {
    let name = event["fn"].as_str().unwrap_or("");
    let brief_at = |index: usize| arg(event, index).unwrap_or(Value::Null);
    let text_at = |index: usize| -> Option<String> {
        match arg(event, index) {
            Some(Value::String(text)) => Some(text),
            None | Some(Value::Null) => Some(String::new()),
            _ => None,
        }
    };
    Some(match name {
        "weatherRecentlyMentioned" => Value::Bool(narrator::weather_recently_mentioned(&list(&arg(event, 0)))),
        "recentClicheReminders" => json!(narrator::recent_cliche_reminders(&list(&arg(event, 0)))),
        "narratorMomentFor" => json!(narrator::narrator_moment_for(&brief_at(0))),
        "freeActionRulingOutcome" => json!(narrator::free_action_ruling_outcome(&brief_at(0))),
        "withoutEchoOfPlayer" => {
            let Some(Value::String(narration)) = arg(event, 0) else { return None };
            json!(narrator::without_echo_of_player(&narration, &brief_at(1)))
        }
        "narratorResponsePlan" => narrator::narrator_response_plan(&brief_at(0)),
        "selectNarratorFewShotExamples" => {
            let options = arg(event, 1);
            let style = opt_prop(&options, "style");
            let count = opt_prop(&options, "count");
            Value::Array(narrator::select_narrator_few_shot_examples(&brief_at(0), style.as_ref(), count.as_ref()))
        }
        "narratorContentDirectives" => narrator::narrator_content_directives(&brief_at(0)),
        "narratorArcRecap" => {
            let options = arg(event, 1);
            let recent = list(&opt_prop(&options, "recentNarrations"));
            let keys: Option<IndexSet<String>> = opt_prop(&options, "recappedArcKeys").and_then(|keys| keys.as_array().map(|keys| keys.iter().map(|key| js::s(Some(key))).collect()));
            let include = js::truthy(opt_prop(&options, "includeOpeningArc").as_ref());
            narrator::narrator_arc_recap(&brief_at(0), &ArcRecapOptions { include_opening_arc: include, recent_narrations: &recent, recapped_arc_keys: keys.as_ref() }).unwrap_or(Value::Null)
        }
        "sensoryAnchorsFor" => {
            let rotation = opt_prop(&arg(event, 1), "rotation");
            narrator::sensory_anchors_for(&brief_at(0), rotation.as_ref())
        }
        "narratorMemoryFocus" => narrator::narrator_memory_focus(&brief_at(0)).unwrap_or(Value::Null),
        "freshSceneElement" => json!(narrator::fresh_scene_element(&brief_at(0), &list(&arg(event, 1)))),
        "confirmedOutcomeDetailSentence" => Value::Bool(narrator::confirmed_outcome_detail_sentence(&text_at(0)?, &brief_at(1))),
        "verifyNarratorCraft" => {
            let verification = arg(event, 2)?;
            narrator::verify_narrator_craft(&text_at(0)?, &brief_at(1), &verification, &list(&arg(event, 3)))
        }
        "verifyNarratorFeedback" => narrator::verify_narrator_feedback(&text_at(0)?, &brief_at(1), &arg(event, 2).unwrap_or_else(|| json!({}))),
        "narrationRepairNote" => json!(narrator::narration_repair_note(&list(&arg(event, 0)))),
        "deterministicNarration" => {
            let recent = list(&opt_prop(&arg(event, 2), "recentNarrations"));
            let answers: Vec<(String, Option<Value>)> = event["args"]
                .get(1)
                .and_then(|value| value.get("resolver"))
                .and_then(Value::as_array)
                .map(|pairs| pairs.iter().map(|pair| (js::stringify(&decode(pair.get(0)).unwrap_or(json!("$undefined"))), decode(pair.get(1)))).collect())
                .unwrap_or_default();
            let custom = event["args"].get(1).and_then(|value| value.get("resolver")).is_some();
            let resolver = move |id: Option<&Value>| {
                let key = js::stringify(&id.cloned().unwrap_or(json!("$undefined")));
                answers.iter().find(|(known, _)| *known == key).and_then(|(_, out)| out.clone()).or_else(|| id.cloned())
            };
            let brief = brief_at(0);
            let result = if custom { narrator::deterministic_narration(&brief, Some(&resolver), &recent) } else { narrator::deterministic_narration(&brief, None, &recent) };
            match result {
                Ok(value) => value,
                Err(error) => json!({ "$threw": error.code }),
            }
        }
        _ => return None,
    })
}

fn new_instance(config: &Value) -> Instance {
    let has_client = config["has_client"].as_bool().unwrap_or(false);
    let client = has_client.then(|| Arc::new(ReplayClient { model: config["model"].as_str().map(str::to_string), script: Mutex::new(VecDeque::new()), seen: Mutex::new(Vec::new()) }));
    let feedback_verifier: Option<FeedbackVerifier> = match config["feedback"].as_str() {
        Some("none") => None,
        Some("custom") => {
            let queue: Mutex<VecDeque<Value>> = Mutex::new(config["feedback_results"].as_array().cloned().unwrap_or_default().into());
            Some(Arc::new(move |_narration: &str, _brief: &Value, _options: &Value| {
                let slot = lock(&queue).pop_front().unwrap_or(json!({ "error": "REPLAY_EXHAUSTED" }));
                match slot.get("error") {
                    Some(code) => Err(js::s(Some(code))),
                    None => Ok(resolve(&slot["value"])),
                }
            }))
        }
        _ => Some(narrator::default_feedback_verifier()),
    };
    let skip = config["custom_verifier"].as_bool().unwrap_or(false)
        || config["feedback_results"].as_array().is_some_and(|slots| slots.iter().any(|slot| slot.get("pending").is_some()));
    let narrator = Narrator::new(NarratorConfig {
        llm_client: client.clone().map(|client| client as Arc<dyn LlmClient>),
        client_name: config["client_name"].as_str().map(str::to_string),
        json_only_client: config["json_only"].as_bool().unwrap_or(false),
        feedback_verifier,
        async_feedback: config["async_feedback"].as_bool().unwrap_or(true),
        ..NarratorConfig::default()
    });
    Instance { narrator, client, skip }
}

fn replay_render(instance: &Instance, event: &Value, runtime: &tokio::runtime::Runtime, report: &mut Report, label: &str) {
    let Some(brief) = decode(event.get("brief")) else {
        report.skipped += 1;
        return;
    };
    let options = &event["options"];
    let progress: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&progress);
    let render_options = RenderOptions {
        known_rule_ids: decode(options.get("knownRuleIds")),
        style: decode(options.get("style")),
        timeout_ms: decode(options.get("timeoutMs")),
        recent_narrations: decode(options.get("recentNarrations")).unwrap_or(Value::Null),
        on_progress: options["has_progress"].as_bool().unwrap_or(false).then(|| Arc::new(move |text: &str| lock(&sink).push(text.to_string())) as narrator::ProgressCallback),
    };
    let calls = event["calls"].as_array().cloned().unwrap_or_default();
    if let Some(client) = instance.client.as_ref() {
        *lock(&client.script) = calls.iter().cloned().collect();
        lock(&client.seen).clear();
    }
    let settings = settings_of(event);
    let outcome = run_with_campaign_ai_settings(settings.as_ref(), || runtime.block_on(instance.narrator.render(&brief, render_options)));
    let rust = match outcome {
        Ok(mut result) => {
            if let Some(origin) = result.pointer_mut("/verification/origin").and_then(Value::as_object_mut) {
                origin.shift_remove("elapsed_ms");
            }
            result
        }
        Err(error) => json!({ "$threw": js::s(Some(&json!(error.to_string()))) }),
    };
    let expected = match (event.get("result"), event.get("threw")) {
        (Some(result), _) => resolve(result),
        (None, Some(_)) => {
            report.checked += 1;
            if !rust.get("$threw").is_some() {
                report.mismatches.push(format!("{label} [render] JS бросил исключение, Rust — нет"));
            }
            return;
        }
        _ => {
            report.skipped += 1;
            return;
        }
    };
    report.compare(label, "render", &rust, &expected);
    report.compare(label, "progress", &json!(*lock(&progress)), &event["progress"]);
    if let Some(client) = instance.client.as_ref() {
        let seen = lock(&client.seen).clone();
        let expected_calls: Vec<Value> = calls
            .iter()
            .map(|call| {
                json!({
                    "method": call["method"],
                    "request": resolve(&call["request"]),
                    "has_signal": call["has_signal"],
                    "has_on_delta": call["has_on_delta"],
                    "deltas": call["deltas"].as_array().cloned().unwrap_or_default().iter().map(|piece| json!({ "text": piece["text"], "threw": piece.get("threw").map(|threw| threw["code"].as_str().unwrap_or("").to_string()) })).collect::<Vec<_>>(),
                })
            })
            .collect();
        report.compare(label, "llm-calls", &Value::Array(seen), &Value::Array(expected_calls));
    }
}

fn replay_process(process: &Value, runtime: &tokio::runtime::Runtime, report: &mut Report) {
    narrator::reset_sensory_anchor_cache();
    let source = process["source"].as_str().unwrap_or("?");
    let mut instances: IndexMap<i64, Instance> = IndexMap::new();
    for (index, event) in process["events"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let label = format!("{source} #{index}");
        match event["k"].as_str() {
            Some("call") => {
                let name = event["fn"].as_str().unwrap_or("");
                if event.get("threw").is_some() {
                    report.skipped += 1;
                    continue;
                }
                let settings = settings_of(event);
                let rust = run_with_campaign_ai_settings(settings.as_ref(), || call_function(event));
                match rust {
                    Some(rust) => report.compare(&format!("{label} {name}"), name, &rust, &out_value(event)),
                    None => report.skipped += 1,
                }
            }
            Some("new") => {
                let id = event["id"].as_i64().unwrap_or(0);
                instances.insert(id, new_instance(&event["config"]));
            }
            Some("render") => {
                let Some(instance) = instances.get_mut(&event["id"].as_i64().unwrap_or(0)) else { continue };
                // Исключение V8 (`TypeError` на мусоре) Rust не повторяет: он
                // доводит рассказ до конца. Память такого рассказчика дальше
                // расходится с JS, его следующие шаги не сверяются.
                if event["threw"]["name"].as_str() == Some("TypeError") {
                    instance.skip = true;
                }
                if instance.skip {
                    report.skipped += 1;
                    continue;
                }
                replay_render(instance, event, runtime, report, &label);
            }
            Some("awaitFeedback") => {
                let Some(instance) = instances.get(&event["id"].as_i64().unwrap_or(0)) else { continue };
                if instance.skip || event.get("out").is_none() {
                    report.skipped += 1;
                    continue;
                }
                let narration = decode(event.get("narration")).map(|value| js::s(Some(&value))).unwrap_or_default();
                let rust = instance.narrator.await_feedback(&narration).unwrap_or(Value::Null);
                report.compare(&label, "awaitFeedback", &rust, &out_value(event));
            }
            Some("drainFeedback") => {
                let Some(instance) = instances.get(&event["id"].as_i64().unwrap_or(0)) else { continue };
                if instance.skip || event.get("out").is_none() {
                    report.skipped += 1;
                    continue;
                }
                report.compare(&label, "drainFeedback", &Value::Array(instance.narrator.drain_feedback()), &resolve(&event["out"]));
            }
            _ => report.skipped += 1,
        }
    }
}

#[test]
fn narrator_matches_js_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("рантайм");
    let mut report = Report::default();
    for process in FIXTURE["processes"].as_array().cloned().unwrap_or_default() {
        replay_process(&process, &runtime, &mut report);
    }
    eprintln!("А5: сверено {} (по видам {:?}), пропущено {}", report.checked, report.by_kind, report.skipped);
    let shown: Vec<&String> = report.mismatches.iter().take(25).collect();
    assert!(report.mismatches.is_empty(), "расхождений {}:\n{}", report.mismatches.len(), shown.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n"));
    assert!(report.checked > 1_000, "эталонов слишком мало: {}", report.checked);
}
