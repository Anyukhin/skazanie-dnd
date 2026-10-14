//! Проверки `llm_client`: эталоны JS (`fixtures/llm-client.json`, генератор —
//! `fixtures/gen-llm-client.mjs`) и перенесённые тесты `test/security.test.mjs`,
//! `test/llm-streaming.test.mjs`, `test/llm-json-schemas.test.mjs`,
//! `test/campaign-reasoning-settings.test.mjs`, `test/usage-ledger.test.mjs`
//! (COST-01 с настоящим `RouterAIClient`). Сетевые случаи — против локального
//! сервера на `127.0.0.1`; ключ — выдуманная строка.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sk_narration_base::campaign_ai_context::{current_campaign_model, run_with_campaign_ai_settings};
use sk_narration_base::jsx::stringify;
use sk_narration_base::model_style_profiles::{reasoning_profile_for, supports_json_schema, STRUCTURED_OUTPUT_MODELS};

use super::test_server::{Reply, TestServer};
use super::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../../fixtures/llm-client.json")).expect("эталон"));

const KEY: &str = "test-key-not-secret";

fn cases(section: &str) -> &'static [Value] {
    FIXTURE[section].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn messages() -> Value {
    json!([{ "role": "user", "content": "test" }])
}

fn error_json(error: &LlmError) -> Value {
    let mut value = error.to_json();
    if let Value::Object(map) = &mut value {
        map.shift_remove("cause");
    }
    value
}

/// Итог Rust против итога JS (`{ ok: JSON.stringify(...) }` или `{ error }`).
fn compare(label: &str, actual: &Result<Value, LlmError>, expected: &Value, failures: &mut Vec<String>) {
    let matches = match (actual, expected.get("ok"), expected.get("error")) {
        (Ok(value), Some(Value::String(ok)), _) => stringify(value) == *ok,
        (Err(error), _, Some(js_error)) => error_json(error) == *js_error,
        _ => false,
    };
    if !matches {
        let actual = match actual {
            Ok(value) => format!("ok {}", stringify(value)),
            Err(error) => format!("error {}", error_json(error)),
        };
        failures.push(format!("{label}\n  Rust: {actual}\n  JS:   {}", stringify(expected)));
    }
}

fn finish(section: &str, total: usize, failures: Vec<String>) {
    assert!(total > 0, "{section}: нет случаев");
    assert!(failures.is_empty(), "{section}: {} из {total} расходятся с JS:\n{}", failures.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).filter_map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok()).collect()
}

fn router(base_url: &str, model: &str) -> RouterAiClient {
    RouterAiClient::with_env(RouterAiClientConfig { api_key: Some(KEY.into()), base_url: Some(base_url.into()), model: Some(model.into()), ..RouterAiClientConfig::default() }, |_| None).expect("клиент")
}

fn envelope(content: &str) -> Value {
    json!({ "model": "provider-model", "choices": [{ "message": { "role": "assistant", "content": content } }], "usage": { "total_tokens": 4 } })
}

// ---------------------------------------------------------------------------
// Эталоны JS
// ---------------------------------------------------------------------------

#[test]
fn strict_json_parse_matches_js() {
    let mut failures = Vec::new();
    for (index, case) in cases("strict").iter().enumerate() {
        let options = &case["options"];
        let options = StrictJsonOptions { label: options.get("label").and_then(Value::as_str).map(str::to_string), expected: options.get("expected").cloned(), max_bytes: options.get("maxBytes").cloned() };
        let actual = match case.get("value") {
            Some(value) => strict_json_parse(value, &options),
            None => strict_json_parse(case["input"].as_str().unwrap_or(""), &options),
        };
        compare(&format!("strict #{index} {}", stringify(case)), &actual, &case["out"], &mut failures);
    }
    finish("strict", cases("strict").len(), failures);
}

#[test]
fn validate_tool_calls_matches_js() {
    let mut failures = Vec::new();
    for (index, case) in cases("tools").iter().enumerate() {
        let allowed: Vec<String> = case["allowed"].as_array().map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let actual = validate_tool_calls(case.get("toolCalls"), &allowed, case.get("max")).map(Value::Array);
        compare(&format!("tools #{index} {}", stringify(case)), &actual, &case["out"], &mut failures);
    }
    finish("tools", cases("tools").len(), failures);
}

#[tokio::test]
async fn fake_llm_matches_js() {
    let mut failures = Vec::new();
    for (index, case) in cases("fake").iter().enumerate() {
        let fake = FakeLlm::from_responses([case["response"].clone()]);
        let actual = fake.complete(&case["input"], &case["options"]).await;
        compare(&format!("fake #{index} {}", stringify(case)), &actual, &case["out"], &mut failures);
        let recorded = fake.requests().first().map(stringify);
        if recorded.as_deref() != case["request"].as_str() {
            failures.push(format!("fake #{index}: запрос {recorded:?} против {}", case["request"]));
        }
    }
    finish("fake", cases("fake").len(), failures);
}

async fn run_router_cases(section: &str) {
    let slot: Arc<Mutex<Reply>> = Arc::new(Mutex::new(Reply::Drop));
    let shared = Arc::clone(&slot);
    let server = TestServer::start(Arc::new(move |_, _| shared.lock().expect("ответ").clone())).await;
    let key = FIXTURE["key"].as_str().unwrap_or(KEY).to_string();
    let mut failures = Vec::new();
    for (index, case) in cases(section).iter().enumerate() {
        let response = &case["response"];
        let status = response.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
        *slot.lock().expect("ответ") = match response.get("chunks").and_then(Value::as_array) {
            Some(chunks) => Reply::Chunks { status, chunks: chunks.iter().map(|chunk| hex(chunk.as_str().unwrap_or(""))).collect(), delay_ms: 0, fail: js::is_true(response.get("fail")) },
            None => Reply::text(status, response["text"].as_str().unwrap_or("")),
        };
        let config = &case["config"];
        let js_base = config.get("baseUrl").and_then(Value::as_str).unwrap_or("http://127.0.0.1:9/api/v1");
        let path = reqwest::Url::parse(js_base).map(|url| url.path().to_string()).unwrap_or_default();
        let mut client = RouterAiClient::with_env(
            RouterAiClientConfig {
                api_key: Some(config.get("apiKey").and_then(Value::as_str).unwrap_or(&key).to_string()),
                base_url: Some(format!("{}{path}", server.origin)),
                model: Some(config.get("model").and_then(Value::as_str).unwrap_or("test/model").to_string()),
                reasoning: config.get("reasoning").cloned(),
                max_response_bytes: config.get("maxResponseBytes").and_then(Value::as_f64),
                max_tool_calls: config.get("maxToolCalls").and_then(Value::as_f64),
                timeout_ms: Some(5_000.0),
                ..RouterAiClientConfig::default()
            },
            |_| None,
        )
        .expect("клиент");
        // Провайдер — по адресу JS; запрос уходит на локальный сервер.
        client.provider = llm_provider_for(js_base);
        client.provider_label = if client.provider == "ohmylama" { "OhMyLama" } else { "RouterAI" };
        let deltas = Arc::new(Mutex::new(Vec::<String>::new()));
        let hooks = if js::is_true(case.get("stream")) {
            let deltas = Arc::clone(&deltas);
            CallHooks::new().on_delta(DeltaHandler::sync(move |delta| {
                deltas.lock().expect("дельты").push(delta.to_string());
                Ok(())
            }))
        } else {
            CallHooks::new()
        };
        let before = server.requests().len();
        let (input, options) = (case["input"].clone(), case["options"].clone());
        let call = || client.complete_with(&input, &options, hooks.clone());
        let actual = match case.get("campaign") {
            Some(campaign) => run_with_campaign_ai_settings(Some(campaign), call).await,
            None => call().await,
        };
        let label = format!("{section} #{index} {}", stringify(case));
        let expected = &case["out"];
        compare(&label, &actual, expected, &mut failures);
        let sent = server.requests().get(before).cloned();
        match (expected["body"].as_str(), &sent) {
            (None, None) => {}
            (Some(body), Some(request)) if request.text() == body && Some(request.path.as_str()) == expected["path"].as_str() => {}
            (body, request) => failures.push(format!("{label}: тело {:?} {:?} против {body:?} {}", request.as_ref().map(|request| request.text()), request.as_ref().map(|request| request.path.clone()), expected["path"])),
        }
        if let Some(Value::Array(js_deltas)) = expected.get("deltas") {
            let rust_deltas: Vec<Value> = deltas.lock().expect("дельты").iter().cloned().map(Value::String).collect();
            if rust_deltas != *js_deltas {
                failures.push(format!("{label}: дельты {rust_deltas:?} против {js_deltas:?}"));
            }
        }
    }
    finish(section, cases(section).len(), failures);
}

#[tokio::test]
async fn router_ai_client_matches_js_over_local_http() {
    run_router_cases("router").await;
}

#[tokio::test]
async fn router_ai_streaming_matches_js_over_local_http() {
    run_router_cases("routerStream").await;
}

#[tokio::test]
async fn sse_parser_matches_js_with_breaks_and_splits() {
    let mut failures = Vec::new();
    for (index, case) in cases("stream").iter().enumerate() {
        let chunks: Vec<Vec<u8>> = case["chunks"].as_array().map(|chunks| chunks.iter().map(|chunk| hex(chunk.as_str().unwrap_or(""))).collect()).unwrap_or_default();
        let body = if js::is_true(case.get("nullBody")) {
            None
        } else {
            let source = VecChunks::new(chunks);
            Some(if js::is_true(case.get("fail")) { source.then_fail(LlmError::other("TypeError", "terminated")) } else { source })
        };
        let deltas = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = Arc::new(AtomicUsize::new(0));
        let fail_at = case.get("failDelta").and_then(Value::as_u64).map(|at| at as usize);
        let fail_llm = js::is_true(case.get("failDeltaLlm"));
        let on_delta = {
            let deltas = Arc::clone(&deltas);
            DeltaHandler::sync(move |delta| {
                let number = seen.fetch_add(1, Ordering::SeqCst) + 1;
                if Some(number) == fail_at {
                    return Err(if fail_llm { LlmError::llm("Получатель остановил поток", "LLM_ABORTED") } else { LlmError::other("Error", "Получатель упал") });
                }
                deltas.lock().expect("дельты").push(delta.to_string());
                Ok(())
            })
        };
        let options = StreamOptions { on_delta: Some(on_delta), max_event_bytes: case["options"].get("maxEventBytes").cloned(), max_response_bytes: case["options"].get("maxResponseBytes").cloned() };
        let actual = parse_router_ai_event_stream(body, options).await.map(|result| result.to_json());
        let label = format!("stream #{index} {}", stringify(case));
        compare(&label, &actual, &case["out"], &mut failures);
        let rust_deltas: Vec<Value> = deltas.lock().expect("дельты").iter().cloned().map(Value::String).collect();
        if Some(&Value::Array(rust_deltas.clone())) != case["out"].get("deltas") {
            failures.push(format!("{label}: дельты {rust_deltas:?}"));
        }
    }
    finish("stream", cases("stream").len(), failures);
}

#[test]
fn provider_body_and_schema_match_js() {
    let mut failures = Vec::new();
    for case in cases("provider") {
        let url = case["url"].as_str().unwrap_or("");
        if llm_provider_for(url) != case["out"].as_str().unwrap_or("") {
            failures.push(format!("provider {url}"));
        }
    }
    for case in cases("body") {
        let actual = stringify(&provider_request_body(case["provider"].as_str().unwrap_or(""), &case["body"]));
        if actual != case["out"].as_str().unwrap_or("") {
            failures.push(format!("body {} → {actual}", stringify(case)));
        }
    }
    for case in cases("schema") {
        let actual = usable_json_schema(Some(&case["value"])).map_or_else(|| "null".to_string(), |schema| stringify(&schema));
        if actual != case["out"].as_str().unwrap_or("") {
            failures.push(format!("schema {} → {actual}", stringify(case)));
        }
    }
    finish("provider/body/schema", cases("provider").len() + cases("body").len() + cases("schema").len(), failures);
}

// ---------------------------------------------------------------------------
// test/security.test.mjs
// ---------------------------------------------------------------------------

#[test]
fn strict_json_parser_rejects_prose_markdown_and_prototype_keys() {
    let object = StrictJsonOptions { expected: Some(json!("object")), ..StrictJsonOptions::default() };
    assert_eq!(strict_json_parse(r#"{"ok":true}"#, &object).expect("json"), json!({ "ok": true }));
    let wrapped = stringify(&json!({ "content": "```json\n{\"ok\":true}\n```" }));
    assert_eq!(strict_json_parse(wrapped.as_str(), &object).expect("json"), json!({ "content": "```json\n{\"ok\":true}\n```" }));
    for text in [r#"answer: {"ok":true}"#, "```json\n{\"ok\":true}\n```", r#"{"__proto__":{"admin":true}}"#] {
        let error = strict_json_parse(text, &StrictJsonOptions::default()).expect_err(text);
        assert!(error.is_response_error(), "{text}");
    }
}

#[tokio::test]
async fn fake_llm_uses_strict_json_tool_allowlist_tool_call_limit_and_timeout() {
    let input = json!({ "messages": [{ "role": "system", "content": "s" }, { "role": "user", "content": "u" }] });
    let fake = FakeLlm::from_responses([json!({ "intent": "look", "confidence": 1 })]);
    assert_eq!(fake.complete_json(&input, &json!({})).await.expect("json"), json!({ "intent": "look", "confidence": 1 }));
    assert_eq!(fake.requests().len(), 1);

    let too_many = FakeLlm::new(FakeLlmConfig {
        max_tool_calls: Some(json!(1)),
        responses: vec![FakeReply::Value(json!({ "content": "", "tool_calls": [
            { "id": "1", "type": "function", "function": { "name": "roll", "arguments": "{}" } },
            { "id": "2", "type": "function", "function": { "name": "roll", "arguments": "{}" } },
        ] }))],
        ..FakeLlmConfig::default()
    });
    let error = too_many.complete(&input, &json!({ "allowedToolNames": ["roll"] })).await.expect_err("предел");
    assert_eq!(error.name, "LLMToolCallLimitError");
    assert!(error.is_response_error());

    let unknown = FakeLlm::from_responses([json!({ "content": "", "tool_calls": [{ "type": "function", "function": { "name": "shell", "arguments": "{}" } }] })]);
    let error = unknown.complete(&input, &json!({ "allowedToolNames": ["roll"] })).await.expect_err("allowlist");
    assert_eq!(error.code.as_deref(), Some("LLM_TOOL_NOT_ALLOWED"));
    assert_eq!(error.details["toolName"], "shell");

    let slow = FakeLlm::new(FakeLlmConfig { responses: vec![FakeReply::Value(json!({ "ok": true }))], delay_ms: Some(json!(30)), timeout_ms: Some(json!(5)), ..FakeLlmConfig::default() });
    assert!(slow.complete_json(&input, &json!({})).await.expect_err("таймаут").is_timeout());

    let stuck = FakeLlm::new(FakeLlmConfig { handler: Some(Arc::new(|_, _| -> HookFuture<Value> { Box::pin(std::future::pending()) })), timeout_ms: Some(json!(5)), ..FakeLlmConfig::default() });
    let error = stuck.complete(&input, &json!({})).await.expect_err("таймаут");
    assert!(error.is_timeout());
    assert_eq!(error.message, "LLM не ответил за 5 мс");
    assert_eq!(error.details["timeoutMs"], 5);
}

#[tokio::test]
async fn fake_llm_handler_sees_request_index_and_wraps_foreign_errors() {
    let fake = FakeLlm::from_handler(|request: Value, index| async move {
        if index == 1 {
            return Err(LlmError::other("Error", "сценарий упал"));
        }
        Ok(json!({ "content": format!("ответ {index} на {}", request["messages"][0]["content"].as_str().unwrap_or("")) }))
    });
    let first = fake.complete(&json!([{ "role": "user", "content": "раз" }]), &json!({})).await.expect("ответ");
    assert_eq!(first["content"], "ответ 0 на раз");
    assert_eq!(first["model"], "fake");
    assert_eq!(first["provider"], "FakeLLM");
    let error = fake.complete(&json!([{ "role": "user", "content": "два" }]), &json!({})).await.expect_err("ошибка");
    assert_eq!(error.code.as_deref(), Some("FAKE_LLM_ERROR"));
    assert_eq!(error.details["cause"]["message"], "сценарий упал");
    let exhausted = FakeLlm::from_responses(Vec::<Value>::new());
    assert_eq!(exhausted.complete(&messages(), &json!({})).await.expect_err("пусто").code.as_deref(), Some("FAKE_LLM_EXHAUSTED"));
    let queued = FakeLlm::from_responses([FakeReply::Error(LlmError::llm("broken json", "LLM_JSON_INVALID"))]);
    queued.enqueue(json!("второй"));
    assert_eq!(queued.complete(&messages(), &json!({})).await.expect_err("ошибка").code.as_deref(), Some("LLM_JSON_INVALID"));
    assert_eq!(queued.complete(&messages(), &json!({})).await.expect("ответ")["content"], "второй");
    assert_eq!(fake.requests().len(), 2);
}

#[tokio::test]
async fn router_ai_sends_bounded_json_request_with_repetition_penalties() {
    let server = TestServer::replying(Reply::json(200, &json!({ "model": "test-model", "usage": { "total_tokens": 4 }, "choices": [{ "message": { "role": "assistant", "content": "{\"intent\":\"look\"}" } }] }))).await;
    let client = router(&format!("{}/api/v1", server.origin), "test-model");
    let result = client.complete_json(&json!({ "messages": messages(), "temperature": 0.8, "frequencyPenalty": 0.35, "presencePenalty": 0.2 }), &json!({})).await.expect("json");
    assert_eq!(result, json!({ "intent": "look" }));
    let request = &server.requests()[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/v1/chat/completions");
    assert_eq!(request.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
    assert_eq!(request.header("content-type"), Some("application/json"));
    let body = request.json();
    assert_eq!(body["response_format"], json!({ "type": "json_object" }));
    assert_eq!(body["temperature"], 0.8);
    assert_eq!(body["frequency_penalty"], 0.35);
    assert_eq!(body["presence_penalty"], 0.2);
}

#[tokio::test]
async fn router_ai_rejects_repetition_penalties_before_network() {
    let server = TestServer::replying(Reply::Drop).await;
    let client = router(&server.origin, "test/model");
    let error = client.complete_json(&json!({ "messages": messages(), "frequencyPenalty": 2.01 }), &json!({})).await.expect_err("предел");
    assert_eq!(error.name, "RangeError");
    assert!(error.message.contains("frequencyPenalty"));
    let error = client.complete_json(&json!({ "messages": messages(), "presence_penalty": -2.01 }), &json!({})).await.expect_err("предел");
    assert!(error.message.contains("presencePenalty"));
    assert!(server.requests().is_empty(), "до сети запрос не дошёл");
}

#[tokio::test]
async fn router_ai_forwards_per_model_reasoning_policy() {
    let server = TestServer::replying(Reply::json(200, &envelope("{\"ok\":true}"))).await;
    let client = RouterAiClient::with_env(
        RouterAiClientConfig { api_key: Some(KEY.into()), base_url: Some(server.origin.clone()), model: Some("reasoning-model".into()), reasoning: Some(json!({ "enabled": false })), ..RouterAiClientConfig::default() },
        |_| None,
    )
    .expect("клиент");
    client.complete_json(&json!({ "messages": messages() }), &json!({})).await.expect("json");
    assert_eq!(server.requests()[0].json()["reasoning"], json!({ "enabled": false }));
}

#[tokio::test]
async fn router_ai_accepts_fenced_transport_envelopes_but_keeps_strict_inner_json() {
    let inner = stringify(&json!({ "choices": [{ "message": { "role": "assistant", "content": "{\"ok\":true}" } }] }));
    for body in [format!("```json\n{inner}\n```"), format!("```json{inner}```"), format!("```application/json\n{inner}\n```")] {
        let server = TestServer::replying(Reply::text(200, &body)).await;
        let client = router(&server.origin, "test/model");
        let result = client.complete(&json!({ "messages": messages(), "expectJson": true }), &json!({})).await.expect("ответ");
        assert_eq!(result["json"], json!({ "ok": true }), "{body}");
    }
    let server = TestServer::replying(Reply::text(200, &format!("```json\n{}\n```", stringify(&json!({ "choices": [{ "message": { "role": "assistant", "content": "{\"narration\":\"ok\"}" } }] }))))).await;
    let result = router(&server.origin, "test/model").complete(&json!({ "messages": messages() }), &json!({})).await.expect("ответ");
    assert_eq!(result["content"], "{\"narration\":\"ok\"}");
}

#[tokio::test]
async fn router_ai_timeout_does_not_depend_on_transport_honouring_cancel() {
    let server = TestServer::replying(Reply::Hang).await;
    let client = RouterAiClient::with_env(RouterAiClientConfig { api_key: Some(KEY.into()), base_url: Some(server.origin.clone()), timeout_ms: Some(5.0), ..RouterAiClientConfig::default() }, |_| None).expect("клиент");
    let started = std::time::Instant::now();
    let error = client.complete(&json!({ "messages": messages() }), &json!({})).await.expect_err("таймаут");
    assert!(error.is_timeout(), "{error:?}");
    assert_eq!(error.code.as_deref(), Some("LLM_TIMEOUT"));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn router_ai_reports_unavailable_provider_abort_and_missing_key() {
    let dropped = TestServer::replying(Reply::Drop).await;
    let error = router(&dropped.origin, "m").complete(&json!({ "messages": messages() }), &json!({})).await.expect_err("обрыв");
    assert_eq!(error.code.as_deref(), Some("LLM_PROVIDER_UNAVAILABLE"));
    assert_eq!(error.message, "Не удалось вызвать RouterAI");
    for base in ["", "not a url", "ftp://127.0.0.1:1/v1", "http://user:pass@127.0.0.1:1/v1"] {
        let error = router(base, "m").complete(&json!({ "messages": messages() }), &json!({})).await.expect_err(base);
        assert_eq!(error.code.as_deref(), Some("LLM_PROVIDER_UNAVAILABLE"), "{base}");
    }
    let hang = TestServer::replying(Reply::Hang).await;
    let controller = AbortController::new();
    let client = router(&hang.origin, "m");
    let input = json!({ "messages": messages() });
    let options = json!({});
    let call = client.complete_with(&input, &options, CallHooks::new().signal(controller.signal()));
    let aborter = {
        let controller = controller.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            controller.abort_default();
        })
    };
    let error = call.await.expect_err("отмена");
    aborter.await.expect("задача");
    assert_eq!(error.code.as_deref(), Some("LLM_ABORTED"));
    assert_eq!(error.message, "LLM-запрос отменён");
    let aborted = AbortController::new();
    aborted.abort(LlmError::llm("уже", "LLM_ABORTED"));
    let error = client.complete_with(&input, &options, CallHooks::new().signal(aborted.signal())).await.expect_err("отмена");
    assert_eq!(error.code.as_deref(), Some("LLM_ABORTED"));
    let unconfigured = RouterAiClient::with_env(RouterAiClientConfig { base_url: Some(hang.origin.clone()), ..RouterAiClientConfig::default() }, |_| None).expect("клиент");
    let error = unconfigured.complete(&input, &options).await.expect_err("ключ");
    assert_eq!((error.name.as_str(), error.code.as_deref(), error.message.as_str()), ("LLMError", Some("LLM_NOT_CONFIGURED"), "ROUTERAI_API_KEY не настроен"));
}

#[tokio::test]
async fn router_ai_no_content_response_is_empty_body() {
    let server = TestServer::replying(Reply::Full { status: 204, body: Vec::new() }).await;
    let client = router(&server.origin, "m");
    let error = client.complete(&json!({ "messages": messages() }), &json!({})).await.expect_err("пусто");
    assert_eq!(error.message, "ответ RouterAI: пустой JSON");
    let error = client.complete_streaming(&json!({ "messages": messages() }), &json!({}), DeltaHandler::sync(|_| Ok(()))).await.expect_err("пусто");
    assert_eq!(error.message, "RouterAI returned an empty streaming body");
}

#[tokio::test]
async fn router_ai_reads_environment_like_js_and_hides_the_key() {
    let env = |values: &'static [(&'static str, &'static str)]| move |name: &str| values.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string());
    let client = RouterAiClient::with_env(RouterAiClientConfig::default(), env(&[("ROUTERAI_API_KEY", "env-key-not-secret"), ("DND_AI_MAX_TOKENS", "300")])).expect("клиент");
    assert!(client.api_key_configured());
    assert_eq!(client.base_url(), "https://routerai.ru/api/v1");
    assert_eq!(client.model().as_deref(), Some("z-ai/glm-5.3-flash"));
    assert_eq!(client.max_tokens(), Some(json!(300)));
    assert_eq!(client.provider(), "routerai");
    assert!(!format!("{client:?}").contains("env-key-not-secret"), "ключ не печатается");
    let config = RouterAiClientConfig { api_key: Some("config-key-not-secret".into()), ..RouterAiClientConfig::default() };
    assert!(!format!("{config:?}").contains("config-key-not-secret"));
    for (raw, expected) in [("", 1200), ("abc", 1200), ("0", 1200), ("1.5", 1200), ("-5", 1200), ("0x10", 16), (" 64 ", 64)] {
        let values: &'static [(&'static str, &'static str)] = Box::leak(Box::new([("DND_AI_MAX_TOKENS", raw)]));
        assert_eq!(RouterAiClient::with_env(RouterAiClientConfig::default(), env(values)).expect("клиент").max_tokens(), Some(json!(expected)), "{raw:?}");
    }
    let custom = RouterAiClient::with_env(RouterAiClientConfig::default(), env(&[("ROUTERAI_BASE_URL", "https://ohmylama.ru/v1/"), ("DND_AI_MODEL", "openai/gpt-6-luna")])).expect("клиент");
    assert_eq!((custom.base_url(), custom.provider(), custom.provider_label()), ("https://ohmylama.ru/v1", "ohmylama", "OhMyLama"));
    assert_eq!(custom.model().as_deref(), Some("openai/gpt-6-luna"));
    assert!(!custom.api_key_configured());
    // `??` в JS: пустая переменная — пустой адрес, а не умолчание.
    let empty = RouterAiClient::with_env(RouterAiClientConfig::default(), env(&[("ROUTERAI_BASE_URL", "")])).expect("клиент");
    assert_eq!(empty.base_url(), "");
}

// ---------------------------------------------------------------------------
// Каскад: test/security.test.mjs, test/llm-json-schemas.test.mjs
// ---------------------------------------------------------------------------

type Behaviour = Arc<dyn Fn(Value, Value, CallHooks) -> HookFuture<Value> + Send + Sync>;

/// Клиент из сценария (объект `{ model, timeoutMs, complete }` тестов JS).
struct Scripted {
    model: Option<String>,
    calls: Arc<Mutex<Vec<String>>>,
    behaviour: Behaviour,
}

impl LlmClient for Scripted {
    fn model(&self) -> Option<String> {
        self.model.clone()
    }

    fn complete<'a>(&'a self, input: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        let (input, options) = (input.clone(), options.clone());
        if let Some(model) = &self.model {
            self.calls.lock().expect("вызовы").push(model.clone());
        }
        Box::pin(async move {
            let hooks = CallScope::current().hooks;
            (self.behaviour)(input, options, hooks).await
        })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

fn scripted<F, Fut>(model: &str, calls: &Arc<Mutex<Vec<String>>>, behaviour: F) -> Arc<dyn LlmClient>
where
    F: Fn(Value, Value, CallHooks) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, LlmError>> + Send + 'static,
{
    Arc::new(Scripted { model: Some(model.into()), calls: Arc::clone(calls), behaviour: Arc::new(move |input, options, hooks| Box::pin(behaviour(input, options, hooks))) })
}

fn answer(content: &str, model: &str) -> Result<Value, LlmError> {
    Ok(json!({ "role": "assistant", "content": content, "tool_calls": [], "model": model }))
}

fn cascade(clients: Vec<Arc<dyn LlmClient>>) -> FallbackLlmClient {
    FallbackLlmClient::new(FallbackLlmClientConfig { clients: clients.into_iter().map(FallbackMember::new).collect(), ..FallbackLlmClientConfig::default() }).expect("каскад")
}

fn calls() -> Arc<Mutex<Vec<String>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn taken(calls: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    calls.lock().expect("вызовы").clone()
}

fn input() -> Value {
    json!({ "messages": messages() })
}

#[tokio::test]
async fn fallback_switches_models_on_timeout_and_observes_cooldown() {
    let log = calls();
    let primary = scripted("primary", &log, |_, _, _| async { Err(LlmError::timeout(10.0)) });
    let secondary = scripted("secondary", &log, |_, _, _| async { answer("A complete usable response.", "secondary") });
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig {
        clients: vec![FallbackMember::new(primary), FallbackMember::new(secondary)],
        failure_cooldown_ms: Some(1000.0),
        now: Some(Arc::new(|| 100.0)),
        ..FallbackLlmClientConfig::default()
    })
    .expect("каскад");
    let first = chain.complete(&input(), &json!({})).await.expect("ответ");
    let second = chain.complete(&input(), &json!({})).await.expect("ответ");
    assert_eq!(first["model"], "secondary");
    assert_eq!(first["fallback_used"], true);
    assert_eq!(first["fallback_attempts"], json!([{ "model": "primary", "code": "LLM_TIMEOUT" }]));
    assert_eq!(second["fallback_used"], false);
    assert_eq!(taken(&log), ["primary", "secondary", "secondary"]);
    let health = chain.health();
    assert_eq!(health[0], json!({ "model": "primary", "primary": true, "state": "cooldown", "failures": 1, "last_error_code": "LLM_TIMEOUT", "retry_after_ms": 1000 }));
    assert_eq!(health[1], json!({ "model": "secondary", "primary": false, "state": "ready", "failures": 0, "last_error_code": null, "retry_after_ms": 0 }));
    assert_eq!(chain.models(), Some(json!(["primary", "secondary"])));
}

#[tokio::test(start_paused = true)]
async fn fallback_divides_timeout_between_providers_instead_of_multiplying() {
    let log = calls();
    let primary = scripted("primary-budget", &log, |_, _, _| async {
        tokio::time::sleep(Duration::from_millis(15)).await;
        Err(LlmError::timeout(15.0))
    });
    let secondary = scripted("secondary-budget", &log, |_, _, hooks: CallHooks| async move {
        match hooks.signal {
            Some(signal) => Err(signal.wait().await),
            None => std::future::pending().await,
        }
    });
    let chain = cascade(vec![primary, secondary]);
    let started = tokio::time::Instant::now();
    let error = chain.complete(&input(), &json!({ "timeoutMs": 40 })).await.expect_err("таймаут");
    assert!(error.is_timeout(), "{error:?}");
    assert_eq!(taken(&log), ["primary-budget", "secondary-budget"]);
    assert!(started.elapsed() < Duration::from_millis(180), "бюджет умножен: {:?}", started.elapsed());
}

#[tokio::test(start_paused = true)]
async fn fallback_keeps_reserve_for_secondary_after_primary_timeout() {
    let log = calls();
    let primary = scripted("primary-slow", &log, |_, _, _| async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        Err(LlmError::timeout(10.0))
    });
    let secondary = scripted("secondary-fast", &log, |_, _, _| async { Ok(json!({ "content": "usable fallback response", "model": "secondary-fast" })) });
    let started = tokio::time::Instant::now();
    let result = cascade(vec![primary, secondary]).complete(&input(), &json!({ "timeoutMs": 40 })).await.expect("ответ");
    assert_eq!(result["model"], "secondary-fast");
    assert_eq!(result["fallback_used"], true);
    assert!(started.elapsed() < Duration::from_millis(100));
}

#[tokio::test(start_paused = true)]
async fn fallback_interrupts_primary_that_ignores_signal() {
    let log = calls();
    let primary = scripted("primary-ignores-signal", &log, |_, _, _| std::future::pending());
    let secondary = scripted("secondary-after-stall", &log, |_, _, _| async { Ok(json!({ "content": "usable fallback response", "model": "secondary-after-stall" })) });
    let result = cascade(vec![primary, secondary]).complete(&input(), &json!({ "timeoutMs": 40 })).await.expect("ответ");
    assert_eq!(result["model"], "secondary-after-stall");
    assert_eq!(taken(&log), ["primary-ignores-signal", "secondary-after-stall"]);
}

#[tokio::test]
async fn fallback_prioritizes_model_selected_for_current_campaign_only() {
    let log = calls();
    let primary = scripted("primary", &log, |_, _, _| async { Ok(json!({ "content": "primary", "model": "primary" })) });
    let secondary = scripted("secondary", &log, |_, _, _| async { Ok(json!({ "content": "secondary", "model": "secondary" })) });
    let chain = Arc::new(cascade(vec![primary, secondary]));
    let ask = |model: &'static str, style: &'static str| {
        let chain = Arc::clone(&chain);
        async move {
            let input = input();
            let options = json!({});
            let settings = json!({ "model": model, "narratorStyle": style });
            let call = run_with_campaign_ai_settings(Some(&settings), || {
                assert_eq!(current_campaign_model(), model);
                chain.complete(&input, &options)
            });
            tokio::task::yield_now().await;
            call.await
        }
    };
    let (selected, isolated) = tokio::join!(ask("secondary", "ironic"), ask("primary", "neutral"));
    assert_eq!(selected.expect("ответ")["model"], "secondary");
    assert_eq!(isolated.expect("ответ")["model"], "primary");
    let mut seen = taken(&log);
    seen.sort();
    assert_eq!(seen, ["primary", "secondary"]);
    assert_eq!(current_campaign_model(), "");
}

#[tokio::test]
async fn muse_is_called_with_low_only_after_campaign_choice_and_never_as_automatic_reserve() {
    let log = calls();
    let primary = scripted("primary", &log, |input: Value, options: Value, _| async move {
        if js::is_true(input.get("json")) || js::is_true(options.get("json")) {
            return Ok(json!({ "content": "{\"ok\":true}", "json": { "ok": true } }));
        }
        Err(LlmError::timeout(10.0))
    });
    let muse_log = Arc::clone(&log);
    let server = TestServer::start(Arc::new(move |request, _| {
        let body = request.json();
        muse_log.lock().expect("вызовы").push(js::s(body.get("model")));
        assert_eq!(body["reasoning"], json!({ "effort": "low" }));
        Reply::json(200, &json!({ "model": body["model"], "choices": [{ "message": { "role": "assistant", "content": "Действие ещё не выполнено." } }] }))
    }))
    .await;
    let muse = Arc::new(
        RouterAiClient::with_env(
            RouterAiClientConfig { api_key: Some(KEY.into()), base_url: Some(server.origin.clone()), model: Some("meta/muse-spark-1.3".into()), reasoning: reasoning_profile_for(Some("meta/muse-spark-1.3")), ..RouterAiClientConfig::default() },
            |_| None,
        )
        .expect("клиент"),
    );
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig { clients: vec![FallbackMember::new(primary)], selectable_clients: vec![FallbackMember::router(muse)], ..FallbackLlmClientConfig::default() }).expect("каскад");
    chain.probe().await.expect("проба");
    assert_eq!(taken(&log), ["primary"], "ручная модель не получает фоновый probe");
    assert_eq!(chain.complete(&input(), &json!({})).await.expect_err("исчерпан").code.as_deref(), Some("LLM_FALLBACK_EXHAUSTED"));
    assert_eq!(taken(&log), ["primary", "primary"]);
    let settings = json!({ "model": "meta/muse-spark-1.3" });
    let request = input();
    let options = json!({});
    let result = run_with_campaign_ai_settings(Some(&settings), || chain.complete(&request, &options)).await.expect("ответ");
    assert_eq!(result["model"], "meta/muse-spark-1.3");
    assert_eq!(chain.model().as_deref(), Some("primary"));
    let health = chain.health();
    let muse_health = health.as_array().expect("здоровье").iter().find(|entry| entry["model"] == "meta/muse-spark-1.3").expect("muse").clone();
    assert_eq!(muse_health["primary"], false);
    assert_eq!(chain.complete(&input(), &json!({})).await.expect_err("исчерпан").code.as_deref(), Some("LLM_FALLBACK_EXHAUSTED"));
    assert_eq!(taken(&log).iter().filter(|model| *model == "meta/muse-spark-1.3").count(), 1, "выбор не протекает в следующую кампанию");
}

#[tokio::test]
async fn manual_model_failure_keeps_regular_reserve() {
    let log = calls();
    let primary = scripted("primary", &log, |_, _, _| async { Ok(json!({ "content": "Резервный ответ.", "model": "primary" })) });
    let muse = scripted("meta/muse-spark-1.3", &log, |_, _, _| async { Err(LlmError::timeout(10.0)) });
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig { clients: vec![FallbackMember::new(primary)], selectable_clients: vec![FallbackMember::new(muse)], ..FallbackLlmClientConfig::default() }).expect("каскад");
    let settings = json!({ "model": "meta/muse-spark-1.3" });
    let (request, options) = (input(), json!({}));
    let result = run_with_campaign_ai_settings(Some(&settings), || chain.complete(&request, &options)).await.expect("ответ");
    assert_eq!(result["model"], "primary");
    assert_eq!(result["fallback_attempts"], json!([{ "model": "meta/muse-spark-1.3", "code": "LLM_TIMEOUT" }]));
}

#[tokio::test]
async fn fallback_rejects_formally_successful_but_unusable_response() {
    let log = calls();
    let primary = scripted("empty-model", &log, |_, _, _| async { answer("no", "empty-model") });
    let secondary = scripted("answering-model", &log, |_, _, _| async { answer("The fallback gives a useful answer.", "answering-model") });
    let hooks = CallHooks::new().validate_response(ResponseValidator::sync(|response| js::s(response.get("content")).chars().count() >= 20));
    let result = cascade(vec![primary, secondary]).complete_with(&input(), &json!({}), hooks).await.expect("ответ");
    assert_eq!(result["model"], "answering-model");
    assert_eq!(result["fallback_attempts"], json!([{ "model": "empty-model", "code": "LLM_RESPONSE_INVALID" }]));
}

#[tokio::test]
async fn fallback_switches_provider_only_before_first_delivered_delta() {
    let log = calls();
    let deltas = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = |deltas: &Arc<Mutex<Vec<String>>>| {
        let deltas = Arc::clone(deltas);
        DeltaHandler::sync(move |delta| {
            deltas.lock().expect("дельты").push(delta.to_string());
            Ok(())
        })
    };
    let primary = scripted("primary-before", &log, |_, _, _| async { Err(LlmError::timeout(10.0)) });
    let secondary = scripted("secondary", &log, |_, _, hooks: CallHooks| async move {
        if let Some(on_delta) = hooks.on_delta {
            on_delta.call("Цельный ответ.".into()).await?;
        }
        answer("Цельный ответ.", "secondary")
    });
    let recovered = cascade(vec![primary, secondary]).complete_streaming(&input(), &json!({}), sink(&deltas)).await.expect("ответ");
    assert_eq!(recovered["content"], "Цельный ответ.");
    assert_eq!(taken(&log), ["primary-before", "secondary"]);
    assert_eq!(*deltas.lock().expect("дельты"), ["Цельный ответ."]);

    let log = calls();
    let delivered = Arc::new(Mutex::new(Vec::<String>::new()));
    let primary = scripted("primary-after", &log, |_, _, hooks: CallHooks| async move {
        if let Some(on_delta) = hooks.on_delta {
            on_delta.call("Начало первого провайдера.".into()).await?;
        }
        Err(LlmError::timeout(10.0))
    });
    let forbidden = scripted("forbidden-secondary", &log, |_, _, _| async { answer("Другой ответ.", "forbidden-secondary") });
    let error = cascade(vec![primary, forbidden]).complete_streaming(&input(), &json!({}), sink(&delivered)).await.expect_err("таймаут");
    assert!(error.is_timeout());
    assert_eq!(*delivered.lock().expect("дельты"), ["Начало первого провайдера."]);
    assert_eq!(taken(&log), ["primary-after"]);
}

#[tokio::test(start_paused = true)]
async fn long_single_call_is_not_cut_by_hot_path_limit_of_first_model() {
    let log = calls();
    let slow = scripted("primary", &log, |_, _, hooks: CallHooks| async move {
        let wait = tokio::time::sleep(Duration::from_millis(40));
        match hooks.signal {
            Some(signal) => tokio::select! {
                () = wait => {}
                _ = signal.wait() => return Err(LlmError::other("Error", "aborted")),
            },
            None => wait.await,
        }
        Ok(json!({ "content": "мир", "model": "primary" }))
    });
    let reserve = scripted("reserve", &log, |_, _, _| async { Ok(json!({ "content": "запас", "model": "reserve" })) });
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig { clients: vec![FallbackMember::new(slow).with_timeout(20.0), FallbackMember::new(reserve).with_timeout(20.0)], ..FallbackLlmClientConfig::default() }).expect("каскад");
    let long = chain.complete(&json!({ "messages": [{ "role": "user", "content": "мир" }] }), &json!({ "timeoutMs": 400 })).await.expect("ответ");
    assert_eq!(long["content"], "мир", "длинный вызов дождался первой модели");
}

fn flaky(model: &str, log: &Arc<Mutex<Vec<String>>>, failing: &Arc<AtomicUsize>, error: LlmError, content: &'static str) -> Arc<dyn LlmClient> {
    let failing = Arc::clone(failing);
    let model_name = model.to_string();
    scripted(model, log, move |_, _, _| {
        let fail = failing.load(Ordering::SeqCst) == 1;
        let error = error.clone();
        let model_name = model_name.clone();
        async move {
            if fail {
                return Err(error);
            }
            Ok(json!({ "content": content, "model": model_name }))
        }
    })
}

fn fixed_cascade(primary: Arc<dyn LlmClient>, reserve: Arc<dyn LlmClient>) -> FallbackLlmClient {
    FallbackLlmClient::new(FallbackLlmClientConfig {
        clients: vec![FallbackMember::new(primary), FallbackMember::new(reserve)],
        failure_cooldown_ms: Some(60_000.0),
        now: Some(Arc::new(|| 1_000.0)),
        ..FallbackLlmClientConfig::default()
    })
    .expect("каскад")
}

fn ask(text: &str) -> Value {
    json!({ "messages": [{ "role": "user", "content": text }] })
}

#[tokio::test]
async fn single_timeout_after_success_does_not_cool_down_primary() {
    let log = calls();
    let slow = Arc::new(AtomicUsize::new(0));
    let reserve = scripted("reserve", &log, |_, _, _| async { Ok(json!({ "content": "запас", "model": "reserve" })) });
    let chain = fixed_cascade(flaky("primary", &log, &slow, LlmError::timeout(10.0), "основная"), reserve);
    assert_eq!(chain.complete(&ask("раз"), &json!({})).await.expect("ответ")["content"], "основная");
    slow.store(1, Ordering::SeqCst);
    assert_eq!(chain.complete(&ask("два"), &json!({})).await.expect("ответ")["content"], "запас");
    assert_eq!(chain.health()[0]["state"], "ready");
    assert_eq!(chain.complete(&ask("три"), &json!({})).await.expect("ответ")["content"], "запас");
    assert_eq!(taken(&log), ["primary", "primary", "reserve", "primary", "reserve"], "после первого тайм-аута основную спрашивают снова");
    log.lock().expect("вызовы").clear();
    chain.complete(&ask("четыре"), &json!({})).await.expect("ответ");
    assert_eq!(taken(&log), ["reserve"], "второй тайм-аут подряд — остывание");
}

#[tokio::test]
async fn unusable_answer_does_not_cool_down_model() {
    let log = calls();
    let broken = Arc::new(AtomicUsize::new(1));
    let reserve = scripted("reserve", &log, |_, _, _| async { Ok(json!({ "content": "запас", "model": "reserve" })) });
    let chain = fixed_cascade(flaky("primary", &log, &broken, LlmError::llm("broken json", "LLM_JSON_INVALID"), "основная"), reserve);
    assert_eq!(chain.complete(&ask("мир"), &json!({})).await.expect("ответ")["content"], "запас");
    assert_eq!(chain.health()[0], json!({ "model": "primary", "primary": true, "state": "unknown", "failures": 0, "last_error_code": "LLM_JSON_INVALID", "retry_after_ms": 0 }));
    broken.store(0, Ordering::SeqCst);
    assert_eq!(chain.complete(&ask("ход"), &json!({})).await.expect("ответ")["content"], "основная");
    assert_eq!(taken(&log), ["primary", "reserve", "primary"]);
    assert_eq!(chain.health()[0]["last_error_code"], Value::Null, "успех стирает код ошибки");
}

#[tokio::test]
async fn single_provider_outage_after_success_does_not_cool_down_model() {
    let log = calls();
    let down = Arc::new(AtomicUsize::new(0));
    let reserve = scripted("reserve", &log, |_, _, _| async { Ok(json!({ "content": "запас", "model": "reserve" })) });
    let chain = fixed_cascade(flaky("primary", &log, &down, LlmError::llm("reset", "LLM_PROVIDER_UNAVAILABLE"), "основная"), reserve);
    chain.complete(&ask("раз"), &json!({})).await.expect("ответ");
    down.store(1, Ordering::SeqCst);
    assert_eq!(chain.complete(&ask("мир"), &json!({})).await.expect("ответ")["content"], "запас");
    down.store(0, Ordering::SeqCst);
    assert_eq!(chain.complete(&ask("ход"), &json!({})).await.expect("ответ")["content"], "основная");
    down.store(1, Ordering::SeqCst);
    chain.complete(&ask("два"), &json!({})).await.expect("ответ");
    chain.complete(&ask("три"), &json!({})).await.expect("ответ");
    log.lock().expect("вызовы").clear();
    down.store(0, Ordering::SeqCst);
    chain.complete(&ask("четыре"), &json!({})).await.expect("ответ");
    assert_eq!(taken(&log), ["reserve"], "вторая недоступность подряд — остывание");
}

#[tokio::test]
async fn fallback_does_not_retry_aborts_auth_and_foreign_errors() {
    for (error, retried) in [
        (LlmError::llm("отменён", "LLM_ABORTED"), false),
        (LlmError::llm("нет ключа", "LLM_NOT_CONFIGURED"), false),
        (LlmError::llm("HTTP 401", "LLM_PROVIDER_ERROR").with_detail("status", json!(401)), false),
        (LlmError::llm("HTTP 402", "LLM_PROVIDER_ERROR").with_detail("status", json!(402)), false),
        (LlmError::llm("HTTP 503", "LLM_PROVIDER_ERROR").with_detail("status", json!(503)), true),
        (LlmError::type_error("плохой вызов"), false),
        (LlmError::other_with_code("Error", "сценарий", "LLM_UNEXPECTED_CALL"), false),
        (LlmError::response_with_code("любой код ответа", "LLM_ABORTED"), true),
        (LlmError::llm("неизвестный", "LLM_SOMETHING"), false),
    ] {
        let log = calls();
        let failing = error.clone();
        let primary = scripted("primary", &log, move |_, _, _| {
            let failing = failing.clone();
            async move { Err(failing) }
        });
        let reserve = scripted("reserve", &log, |_, _, _| async { Ok(json!({ "content": "запас", "model": "reserve" })) });
        let outcome = cascade(vec![primary, reserve]).complete(&input(), &json!({})).await;
        assert_eq!(outcome.is_ok(), retried, "{error:?}");
        if !retried {
            assert_eq!(outcome.expect_err("ошибка"), error);
        }
    }
    let log = calls();
    let one = scripted("only", &log, |_, _, _| async { Err(LlmError::llm("HTTP 500", "LLM_PROVIDER_ERROR").with_detail("status", json!(500))) });
    let error = cascade(vec![one]).complete(&input(), &json!({})).await.expect_err("исчерпан");
    assert_eq!(error.to_json(), json!({ "name": "LLMError", "code": "LLM_FALLBACK_EXHAUSTED", "message": "All configured RouterAI models failed", "attempts": [{ "model": "only", "code": "LLM_PROVIDER_ERROR" }] }));
    assert_eq!(FallbackLlmClient::new(FallbackLlmClientConfig::default()).err().map(|error| error.message), Some("FallbackLLMClient requires at least one LLM client".into()));
}

#[tokio::test]
async fn fallback_probe_marks_models_and_reports_health() {
    let log = calls();
    let good = scripted("good", &log, |input: Value, options: Value, _| async move {
        assert_eq!(input["maxTokens"], 128);
        assert_eq!(input["timeoutMs"], 8000);
        assert_eq!(options, json!({}));
        Ok(json!({ "content": "{\"ok\":true}", "json": { "ok": true } }))
    });
    let wrong = scripted("wrong", &log, |_, _, _| async { Ok(json!({ "content": "{\"ok\":false}", "json": { "ok": false } })) });
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig { clients: vec![FallbackMember::new(good), FallbackMember::new(wrong)], now: Some(Arc::new(|| 5_000.0)), ..FallbackLlmClientConfig::default() }).expect("каскад");
    let health = chain.probe().await.expect("проба");
    assert_eq!(health[0], json!({ "model": "good", "primary": true, "state": "ready", "failures": 0, "last_error_code": null, "retry_after_ms": 0 }));
    assert_eq!(health[1], json!({ "model": "wrong", "primary": false, "state": "cooldown", "failures": 1, "last_error_code": "LLM_PROBE_INVALID", "retry_after_ms": 120000 }));
}

// ---------------------------------------------------------------------------
// test/llm-streaming.test.mjs
// ---------------------------------------------------------------------------

fn sse(payload: &Value) -> String {
    format!("data: {}\n\n", stringify(payload))
}

#[tokio::test]
async fn sse_parser_joins_split_frames_emits_raw_deltas_and_keeps_usage() {
    let source = [
        sse(&json!({ "model": "stream-model", "choices": [{ "delta": { "content": "Первая " } }] })),
        sse(&json!({ "choices": [{ "delta": { "content": "фраза." } }] })),
        sse(&json!({ "choices": [], "usage": { "prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15 } })),
        "data: [DONE]\n\n".to_string(),
    ]
    .concat();
    let bytes = source.as_bytes();
    let chunks = [&bytes[..7], &bytes[7..43], &bytes[43..89], &bytes[89..]].map(<[u8]>::to_vec);
    let deltas = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&deltas);
    let result = parse_router_ai_event_stream(
        Some(VecChunks::new(chunks)),
        StreamOptions {
            on_delta: Some(DeltaHandler::sync(move |delta| {
                sink.lock().expect("дельты").push(delta.into());
                Ok(())
            })),
            ..StreamOptions::default()
        },
    )
    .await
    .expect("поток");
    assert_eq!(result.content, "Первая фраза.");
    assert_eq!(*deltas.lock().expect("дельты"), ["Первая ", "фраза."]);
    assert_eq!(result.model.as_deref(), Some("stream-model"));
    assert_eq!(result.usage, Some(json!({ "prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15 })));
    assert!(result.done);
}

#[tokio::test]
async fn sse_parser_rejects_malformed_incomplete_and_oversized_streams() {
    let run = |chunks: Vec<String>, event: Option<i64>, total: Option<i64>| async move {
        parse_router_ai_event_stream(Some(VecChunks::new(chunks)), StreamOptions { on_delta: None, max_event_bytes: event.map(Value::from), max_response_bytes: total.map(Value::from) }).await.expect_err("отказ")
    };
    let error = run(vec!["data: {\"choices\":\n\n".into(), "data: [DONE]\n\n".into()], None, None).await;
    assert!(error.is_response_error() && error.code.as_deref() == Some("LLM_JSON_INVALID"));
    let error = run(vec![sse(&json!({ "choices": [{ "delta": { "content": "Обрезанный ответ." } }] }))], None, None).await;
    assert_eq!(error.code.as_deref(), Some("LLM_STREAM_INCOMPLETE"));
    let long = sse(&json!({ "choices": [{ "delta": { "content": "x".repeat(200) } }] }));
    assert_eq!(run(vec![long.clone(), "data: [DONE]\n\n".into()], Some(64), Some(1_000)).await.code.as_deref(), Some("LLM_RESPONSE_TOO_LARGE"));
    let medium = sse(&json!({ "choices": [{ "delta": { "content": "x".repeat(80) } }] }));
    assert_eq!(run(vec![medium, "data: [DONE]\n\n".into()], Some(512), Some(100)).await.code.as_deref(), Some("LLM_RESPONSE_TOO_LARGE"));
}

#[tokio::test]
async fn router_ai_requests_streaming_only_with_on_delta_and_keeps_plain_calls() {
    let stream_body = [
        sse(&json!({ "model": "stream-model", "choices": [{ "delta": { "content": "Готово." } }] })),
        sse(&json!({ "choices": [], "usage": { "total_tokens": 3 } })),
        "data: [DONE]\n\n".to_string(),
    ];
    let server = TestServer::replying(Reply::Chunks { status: 200, chunks: stream_body.iter().map(|chunk| chunk.as_bytes().to_vec()).collect(), delay_ms: 5, fail: false }).await;
    let client = router(&server.origin, "test/model");
    let deltas = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&deltas);
    let streamed = client
        .complete_streaming(
            &input(),
            &json!({}),
            DeltaHandler::sync(move |delta| {
                sink.lock().expect("дельты").push(delta.into());
                Ok(())
            }),
        )
        .await
        .expect("поток");
    let sent = server.requests()[0].json();
    assert_eq!(sent["stream"], true);
    assert_eq!(sent["stream_options"], json!({ "include_usage": true }));
    assert_eq!(streamed["content"], "Готово.");
    assert_eq!(streamed["usage"], json!({ "total_tokens": 3 }));
    assert_eq!(streamed["model"], "stream-model");
    assert_eq!(streamed["streamed"], true);
    assert_eq!(*deltas.lock().expect("дельты"), ["Готово."]);

    let plain_server = TestServer::replying(Reply::json(200, &json!({ "model": "plain-model", "choices": [{ "message": { "role": "assistant", "content": "Обычный ответ." } }], "usage": { "total_tokens": 2 } }))).await;
    let plain = router(&plain_server.origin, "test/model").complete(&input(), &json!({})).await.expect("ответ");
    assert_eq!(plain_server.requests()[0].json().get("stream"), None);
    assert_eq!(plain["content"], "Обычный ответ.");
    assert_eq!(plain.get("streamed"), None);
}

#[tokio::test]
async fn hooks_pass_through_metered_client_to_router() {
    let directory = tempfile::tempdir().expect("каталог");
    let ledger = Arc::new(sk_infra::usage_ledger::DurableUsageLedger::new(sk_infra::usage_ledger::UsageLedgerOptions::new(directory.path().join("usage.json"))).expect("учёт"));
    let body = [sse(&json!({ "choices": [{ "delta": { "content": "Сквозь" } }] })), sse(&json!({ "choices": [{ "delta": { "content": " учёт." } }], "usage": { "total_tokens": 7 } })), "data: [DONE]\n\n".to_string()];
    let server = TestServer::replying(Reply::Chunks { status: 200, chunks: body.iter().map(|chunk| chunk.as_bytes().to_vec()).collect(), delay_ms: 0, fail: false }).await;
    let metered = sk_infra::usage_ledger::MeteredLLMClient::new(router(&server.origin, "test/model"), Arc::clone(&ledger));
    let deltas = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&deltas);
    let result = metered
        .complete_streaming(
            &input(),
            &json!({}),
            DeltaHandler::sync(move |delta| {
                sink.lock().expect("дельты").push(delta.into());
                Ok(())
            }),
        )
        .await
        .expect("поток");
    assert_eq!(result["content"], "Сквозь учёт.");
    assert_eq!(*deltas.lock().expect("дельты"), ["Сквозь", " учёт."]);
    assert_eq!(ledger.report().expect("отчёт")["committed_tokens"], 7);
    // Каскад над учтёнными клиентами передаёт сигнал и дельты тоже.
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig { clients: vec![FallbackMember::new(Arc::new(metered))], ..FallbackLlmClientConfig::default() }).expect("каскад");
    let sink = Arc::clone(&deltas);
    let streamed = chain
        .complete_streaming(
            &input(),
            &json!({ "timeoutMs": 5_000 }),
            DeltaHandler::sync(move |delta| {
                sink.lock().expect("дельты").push(delta.into());
                Ok(())
            }),
        )
        .await
        .expect("поток");
    assert_eq!(streamed["fallback_used"], false);
    assert_eq!(deltas.lock().expect("дельты").len(), 4);
}

// ---------------------------------------------------------------------------
// test/llm-json-schemas.test.mjs
// ---------------------------------------------------------------------------

fn director_schema() -> Value {
    json!({ "name": "director_intent", "strict": true, "schema": { "type": "object", "properties": { "type": { "type": "string" } }, "required": ["type"], "additionalProperties": false } })
}

async fn capturing(model: &str, input: &Value, json_call: bool) -> Value {
    let server = TestServer::replying(Reply::json(200, &json!({ "model": model, "choices": [{ "message": { "role": "assistant", "content": "{\"ok\":true}" } }] }))).await;
    let client = router(&server.origin, model);
    let result = if json_call { client.complete_json(input, &json!({})).await } else { client.complete(input, &json!({})).await };
    result.expect("ответ");
    server.requests()[0].json()
}

#[tokio::test]
async fn router_ai_sends_strict_json_schema_only_to_capable_models() {
    let system = json!([{ "role": "system", "content": "Система." }, { "role": "user", "content": "Данные." }]);
    let request = json!({ "messages": system, "jsonSchema": director_schema() });
    assert!(!STRUCTURED_OUTPUT_MODELS.is_empty());
    for model in STRUCTURED_OUTPUT_MODELS {
        assert!(supports_json_schema(Some(model)));
        let body = capturing(model, &request, true).await;
        assert_eq!(body["response_format"], json!({ "type": "json_schema", "json_schema": director_schema() }), "{model}");
        assert_eq!(body["messages"], system, "{model}: схема не добавляет директив");
    }
    assert!(!supports_json_schema(Some("vendor/unknown-model")));
    assert_eq!(capturing("vendor/unknown-model", &request, true).await["response_format"], json!({ "type": "json_object" }));
    assert_eq!(capturing("deepseek/deepseek-v4-flash", &request, true).await["response_format"], json!({ "type": "json_object" }));
    let glm = capturing("z-ai/glm-5.3-flash", &request, true).await;
    assert_eq!(glm.get("response_format"), None);
    assert!(glm["messages"][0]["content"].as_str().unwrap_or("").contains("Верни только полное JSON-значение"));
}

#[tokio::test]
async fn router_ai_without_schema_or_with_broken_schema_behaves_as_before() {
    let plain = json!({ "messages": [{ "role": "system", "content": "Система." }, { "role": "user", "content": "Данные." }] });
    assert_eq!(capturing("openai/gpt-6-luna", &plain, true).await["response_format"], json!({ "type": "json_object" }));
    let glm = capturing("z-ai/glm-5.3-flash", &plain, true).await;
    assert_eq!(glm.get("response_format"), None);
    assert!(glm["messages"][0]["content"].as_str().unwrap_or("").contains("Верни только полное JSON-значение"));
    for schema in [json!({ "name": "с пробелом", "schema": { "type": "object" } }), json!({ "name": "ok", "schema": { "type": "array" } }), json!("director_intent"), json!([])] {
        let mut request = plain.clone();
        request["jsonSchema"] = schema.clone();
        assert_eq!(capturing("openai/gpt-6-luna", &request, true).await["response_format"]["type"], "json_object", "{schema}");
    }
    let mut text = plain.clone();
    text["jsonSchema"] = director_schema();
    assert_eq!(capturing("openai/gpt-6-luna", &text, false).await.get("response_format"), None, "текстовый запрос схему игнорирует");
}

#[tokio::test]
async fn ohmylama_behind_base_url_strips_vendor_prefix_and_keeps_internal_model() {
    assert_eq!(llm_provider_for("https://ohmylama.ru/v1"), "ohmylama");
    assert_eq!(llm_provider_for("https://routerai.ru/api/v1"), "routerai");
    assert_eq!(llm_provider_for("http://127.0.0.1:9999/v1"), "routerai");
    assert_eq!(
        provider_request_body("ohmylama", &json!({ "model": "anthropic/claude-sonnet-5.5", "temperature": 0, "reasoning": { "effort": "low" }, "messages": [] })),
        json!({ "model": "claude-sonnet-5.5", "messages": [], "reasoning_effort": "low" }),
        "Claude у OhMyLama не принимает temperature"
    );
    assert_eq!(provider_request_body("ohmylama", &json!({ "model": "openai/gpt-6-luna", "reasoning": { "enabled": false }, "messages": [] })), json!({ "model": "gpt-6-luna", "messages": [] }));
    let routed = json!({ "model": "openai/gpt-6-luna", "reasoning": { "enabled": false }, "messages": [] });
    assert_eq!(provider_request_body("routerai", &routed), routed);
    let server = TestServer::replying(Reply::json(200, &json!({ "model": "gpt-6-luna", "choices": [{ "message": { "role": "assistant", "content": "да" } }], "usage": { "prompt_tokens": 3, "completion_tokens": 1 } }))).await;
    let mut client = RouterAiClient::with_env(
        RouterAiClientConfig { api_key: Some(KEY.into()), base_url: Some(format!("{}/v1", server.origin)), model: Some("openai/gpt-6-luna".into()), reasoning: Some(json!({ "enabled": false })), ..RouterAiClientConfig::default() },
        |_| None,
    )
    .expect("клиент");
    // Хост OhMyLama в тесте недостижим: провайдер — как у `https://ohmylama.ru/v1`.
    client.provider = llm_provider_for("https://ohmylama.ru/v1");
    client.provider_label = "OhMyLama";
    let result = client.complete(&json!({ "messages": [{ "role": "user", "content": "да?" }] }), &json!({})).await.expect("ответ");
    let sent = &server.requests()[0];
    assert_eq!(sent.path, "/v1/chat/completions");
    assert_eq!(sent.json()["model"], "gpt-6-luna");
    assert_eq!(sent.json().get("reasoning"), None);
    assert_eq!(result["model"], "openai/gpt-6-luna", "учёт расхода видит внутреннее имя");
    assert_eq!(result["provider"], "OhMyLama");
}

#[test]
fn gemini_on_ohmylama_drops_penalties_and_json_schema() {
    let schema = json!({ "type": "json_schema", "json_schema": { "name": "probe", "strict": true, "schema": { "type": "object" } } });
    assert_eq!(
        provider_request_body("ohmylama", &json!({ "model": "google/gemini-2.5-flash", "temperature": 0.4, "frequency_penalty": 0.3, "presence_penalty": 0.2, "response_format": schema, "messages": [] })),
        json!({ "model": "gemini-2.5-flash", "temperature": 0.4, "response_format": { "type": "json_object" }, "messages": [] })
    );
    let luna = provider_request_body("ohmylama", &json!({ "model": "openai/gpt-6-luna", "presence_penalty": 0.2, "response_format": schema, "messages": [] }));
    assert_eq!(luna["presence_penalty"], 0.2, "Luna штрафы принимает");
    assert_eq!(luna["response_format"], schema);
}

// ---------------------------------------------------------------------------
// test/campaign-reasoning-settings.test.mjs
// ---------------------------------------------------------------------------

async fn recording_server(sent: &Arc<Mutex<Vec<Value>>>, status: u16) -> TestServer {
    let sent = Arc::clone(sent);
    TestServer::start(Arc::new(move |request, _| {
        let body = request.json();
        sent.lock().expect("запросы").push(json!({ "model": body["model"], "reasoning": body.get("reasoning").cloned().unwrap_or(Value::Null) }));
        if status != 200 {
            return Reply::text(status, "{}");
        }
        Reply::json(200, &json!({ "model": body["model"], "choices": [{ "message": { "role": "assistant", "content": "Ответ." } }] }))
    }))
    .await
}

fn recording_client(server: &TestServer, model: &str, reasoning: Option<Value>) -> RouterAiClient {
    RouterAiClient::with_env(RouterAiClientConfig { api_key: Some(KEY.into()), base_url: Some(server.origin.clone()), model: Some(model.into()), reasoning, ..RouterAiClientConfig::default() }, |_| None).expect("клиент")
}

#[tokio::test]
async fn campaign_reasoning_reaches_provider_only_for_selected_model_and_creative_roles() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let server = recording_server(&sent, 200).await;
    let luna = recording_client(&server, "openai/gpt-6-luna", reasoning_profile_for(Some("openai/gpt-6-luna")));
    let glm = recording_client(&server, "z-ai/glm-5.3-flash", reasoning_profile_for(Some("z-ai/glm-5.3-flash")));
    let ask = |extra: Value| {
        let mut request = json!({ "messages": [{ "role": "user", "content": "Привет" }] });
        if let (Value::Object(target), Value::Object(extra)) = (&mut request, extra) {
            target.extend(extra);
        }
        request
    };
    let options = json!({});
    let deep = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "deep" });
    for (client, extra) in [(&luna, json!({ "role": "narrator" })), (&luna, json!({ "role": "director" })), (&luna, json!({ "role": "npc" })), (&luna, json!({})), (&glm, json!({ "role": "narrator" })), (&luna, json!({ "role": "narrator", "reasoning": { "enabled": false } }))] {
        let request = ask(extra);
        run_with_campaign_ai_settings(Some(&deep), || client.complete(&request, &options)).await.expect("ответ");
    }
    let thoughtful = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "thoughtful" });
    for extra in [json!({ "role": "narrator" }), json!({ "role": "director" })] {
        let request = ask(extra);
        run_with_campaign_ai_settings(Some(&thoughtful), || luna.complete(&request, &options)).await.expect("ответ");
    }
    let auto = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "auto" });
    let request = ask(json!({ "role": "narrator" }));
    run_with_campaign_ai_settings(Some(&auto), || luna.complete(&request, &options)).await.expect("ответ");
    assert_eq!(
        *sent.lock().expect("запросы"),
        [
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "effort": "high" } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "effort": "high" } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "effort": "medium" } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "enabled": false } }),
            json!({ "model": "z-ai/glm-5.3-flash", "reasoning": { "effort": "low" } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "enabled": false } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "enabled": false } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "effort": "low" } }),
            json!({ "model": "openai/gpt-6-luna", "reasoning": { "enabled": false } }),
        ]
    );
}

#[tokio::test]
async fn fallback_reserve_does_not_get_reasoning_selected_for_primary() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let failing_server = recording_server(&sent, 503).await;
    let good_server = recording_server(&sent, 200).await;
    let failing = Arc::new(recording_client(&failing_server, "openai/gpt-6-luna", None));
    let fallback = Arc::new(recording_client(&good_server, "google/gemini-2.5-flash-lite", None));
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig { clients: vec![FallbackMember::router(failing), FallbackMember::router(fallback)], ..FallbackLlmClientConfig::default() }).expect("каскад");
    let deep = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "deep" });
    let request = json!({ "messages": [{ "role": "user", "content": "Привет" }], "role": "narrator" });
    let options = json!({});
    // Ответ после `await` внутри каскада: контекст кампании переносит снимок.
    let result = run_with_campaign_ai_settings(Some(&deep), || chain.complete(&request, &options)).await.expect("ответ");
    assert_eq!(result["fallback_used"], true);
    assert_eq!(*sent.lock().expect("запросы"), [json!({ "model": "openai/gpt-6-luna", "reasoning": { "effort": "high" } }), json!({ "model": "google/gemini-2.5-flash-lite", "reasoning": null })]);
}

#[tokio::test]
async fn campaign_context_reaches_router_behind_metered_wrapper() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let server = recording_server(&sent, 200).await;
    let directory = tempfile::tempdir().expect("каталог");
    let ledger = Arc::new(sk_infra::usage_ledger::DurableUsageLedger::new(sk_infra::usage_ledger::UsageLedgerOptions::new(directory.path().join("usage.json"))).expect("учёт"));
    let metered = sk_infra::usage_ledger::MeteredLLMClient::new(recording_client(&server, "openai/gpt-6-luna", None), ledger);
    let deep = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "deep" });
    let request = json!({ "messages": [{ "role": "user", "content": "Привет" }], "role": "narrator" });
    let options = json!({});
    // `MeteredLLMClient` зовёт внутренний клиент уже после `await`: контекст
    // кампании туда доносит область вызова `complete_with`.
    run_with_campaign_ai_settings(Some(&deep), || metered.complete_with(&request, &options, CallHooks::new())).await.expect("ответ");
    assert_eq!(*sent.lock().expect("запросы"), [json!({ "model": "openai/gpt-6-luna", "reasoning": { "effort": "high" } })]);
}

// ---------------------------------------------------------------------------
// test/usage-ledger.test.mjs: COST-01 с настоящим RouterAIClient
// ---------------------------------------------------------------------------

struct Ledger {
    _directory: tempfile::TempDir,
    file: std::path::PathBuf,
    ledger: Arc<sk_infra::usage_ledger::DurableUsageLedger>,
}

fn ledger(daily_token_limit: f64) -> Ledger {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("usage.json");
    let now = Arc::new(AtomicI64::new(sk_core::clock::parse_iso("2026-07-24T12:00:00.000Z").expect("время")));
    let ledger = sk_infra::usage_ledger::DurableUsageLedger::new(sk_infra::usage_ledger::UsageLedgerOptions {
        daily_token_limit: Some(daily_token_limit),
        now: Arc::new(move || now.load(Ordering::SeqCst)),
        ..sk_infra::usage_ledger::UsageLedgerOptions::new(file.clone())
    })
    .expect("учёт");
    Ledger { _directory: directory, file, ledger: Arc::new(ledger) }
}

fn accounting_messages() -> Value {
    json!([{ "role": "user", "content": "usage check" }])
}

fn completion(content: &str, usage: Value) -> Reply {
    Reply::json(200, &json!({ "model": "test/model", "usage": usage, "choices": [{ "message": { "role": "assistant", "content": content } }] }))
}

async fn scripted_provider(replies: Vec<Reply>) -> TestServer {
    let replies = Arc::new(replies);
    TestServer::start(Arc::new(move |_, index| replies.get(index).cloned().unwrap_or(Reply::Drop))).await
}

fn accounting_client(server: &TestServer, model: &str, api_key: &str) -> RouterAiClient {
    RouterAiClient::with_env(
        RouterAiClientConfig { api_key: Some(api_key.into()), base_url: Some(format!("{}/api/v1", server.origin)), model: Some(model.into()), max_tokens: Some(50.0), timeout_ms: Some(1_000.0), ..RouterAiClientConfig::default() },
        |_| None,
    )
    .expect("клиент")
}

#[tokio::test]
async fn cost01_successful_answer_is_counted_once_by_provider_usage() {
    let fixture = ledger(10_000.0);
    let server = scripted_provider(vec![completion("{\"ok\":true}", json!({ "prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40, "cost": 0.1 }))]).await;
    let client = sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&server, "test/model", KEY), Arc::clone(&fixture.ledger));
    assert_eq!(client.complete_json(&json!({ "messages": accounting_messages() }), &json!({})).await.expect("json"), json!({ "ok": true }));
    assert_eq!(server.requests().len(), 1);
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!((report["committed_tokens"].clone(), report["input_tokens"].clone(), report["output_tokens"].clone()), (json!(40), json!(30), json!(10)));
    assert_eq!(report["provider_cost"], 0.1);
    assert_eq!((report["completed_requests"].clone(), report["failed_requests"].clone(), report["reserved_tokens"].clone()), (json!(1), json!(0), json!(0)));
}

#[tokio::test]
async fn cost01_paid_invalid_json_records_usage_and_keeps_error() {
    let fixture = ledger(10_000.0);
    let server = scripted_provider(vec![completion("{\"ok\":", json!({ "total_tokens": 100, "cost": 0.25 }))]).await;
    let client = sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&server, "test/model", KEY), Arc::clone(&fixture.ledger));
    let error = client.complete_json(&json!({ "messages": accounting_messages() }), &json!({})).await.expect_err("ошибка");
    assert!(error.is_response_error());
    assert_eq!(error.code.as_deref(), Some("LLM_JSON_INVALID"));
    assert!(error.message.contains("некорректный JSON"));
    assert_eq!(error.provider_usage, Some(json!({ "total_tokens": 100, "cost": 0.25 })));
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!(report["committed_tokens"], 100);
    assert_eq!(report["provider_cost"], 0.25);
    assert_eq!(report["completed_requests"], 0);
    assert_eq!(report["failed_requests"], 1);
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&fixture.file).expect("файл")).expect("json");
    let entry = stored["requests"].as_object().expect("записи").values().next().expect("запись").clone();
    assert_eq!((entry["status"].clone(), entry["error_code"].clone(), entry["total_tokens"].clone()), (json!("failed"), json!("LLM_JSON_INVALID"), json!(100)));
}

#[tokio::test]
async fn cost01_known_usage_of_invalid_answers_counts_toward_quota() {
    // Оценка одного запроса: 41 байт сообщений + 50 токенов ответа = 91.
    let fixture = ledger(250.0);
    let server = scripted_provider((0..3).map(|_| completion("not json", json!({ "total_tokens": 100 }))).collect()).await;
    let client = sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&server, "test/model", KEY), Arc::clone(&fixture.ledger));
    for _ in 0..2 {
        assert_eq!(client.complete_json(&json!({ "messages": accounting_messages() }), &json!({})).await.expect_err("ошибка").code.as_deref(), Some("LLM_JSON_INVALID"));
    }
    let error = client.complete_json(&json!({ "messages": accounting_messages() }), &json!({})).await.expect_err("квота");
    assert_eq!(error.name, "UsageQuotaExceededError");
    assert_eq!(server.requests().len(), 2, "третий запрос до поставщика не доходит");
    assert_eq!(fixture.ledger.report().expect("отчёт")["committed_tokens"], 200);
}

#[tokio::test]
async fn cost01_failures_without_parsed_answer_charge_nothing() {
    let fixture = ledger(10_000.0);
    let server = scripted_provider(vec![Reply::json(503, &json!({ "error": "unavailable" }))]).await;
    let unconfigured = sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&server, "test/model", ""), Arc::clone(&fixture.ledger));
    assert_eq!(unconfigured.complete_json(&json!({ "messages": accounting_messages() }), &json!({})).await.expect_err("ключ").code.as_deref(), Some("LLM_NOT_CONFIGURED"));
    assert!(server.requests().is_empty());
    let failing = sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&server, "test/model", KEY), Arc::clone(&fixture.ledger));
    let error = failing.complete_json(&json!({ "messages": accounting_messages() }), &json!({})).await.expect_err("503");
    assert_eq!((error.code.as_deref(), error.details.get("status")), (Some("LLM_PROVIDER_ERROR"), Some(&json!(503))));
    assert_eq!(server.requests().len(), 1);
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!((report["committed_tokens"].clone(), report["provider_cost"].clone(), report["failed_requests"].clone(), report["reserved_tokens"].clone()), (json!(0), json!(0), json!(2), json!(0)));
}

#[tokio::test]
async fn cost01_cascade_keeps_usage_of_every_attempt() {
    let fixture = ledger(10_000.0);
    let first = scripted_provider(vec![completion("not json", json!({ "total_tokens": 70 }))]).await;
    let second = scripted_provider(vec![completion("{\"ok\":true}", json!({ "total_tokens": 30 }))]).await;
    let chain = FallbackLlmClient::new(FallbackLlmClientConfig {
        clients: vec![
            FallbackMember::new(Arc::new(sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&first, "test/first", KEY), Arc::clone(&fixture.ledger)))),
            FallbackMember::new(Arc::new(sk_infra::usage_ledger::MeteredLLMClient::new(accounting_client(&second, "test/second", KEY), Arc::clone(&fixture.ledger)))),
        ],
        ..FallbackLlmClientConfig::default()
    })
    .expect("каскад");
    let result = chain.complete(&json!({ "messages": accounting_messages(), "json": true }), &json!({})).await.expect("ответ");
    assert_eq!(result["json"], json!({ "ok": true }));
    assert_eq!(result["fallback_used"], true);
    let report = fixture.ledger.report().expect("отчёт");
    assert_eq!((report["committed_tokens"].clone(), report["completed_requests"].clone(), report["failed_requests"].clone()), (json!(100), json!(1), json!(1)));
}

// ---------------------------------------------------------------------------
// Глубина и одиночные суррогаты
// ---------------------------------------------------------------------------

#[test]
fn deep_nesting_follows_v8_stack_limit_without_overflowing_rust_stack() {
    // Поток с обычным для tokio стеком в 2 МиБ: глубина предела V8 не роняет Rust.
    let worker = std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(|| {
            let depth = JS_STACK_DEPTH;
            let ok = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
            let parsed = strict_json_parse(ok.as_str(), &StrictJsonOptions::default().max_bytes(10_000_000)).expect("глубина V8 проходит");
            let text = stringify(&parsed);
            assert_eq!(text.len(), ok.len());
            assert!(strict_json_parse(&parsed, &StrictJsonOptions::default().max_bytes(10_000_000)).is_ok(), "готовое значение той же глубины");
            drop(parsed);
            let deep = format!("{}{}", "[".repeat(depth + 1), "]".repeat(depth + 1));
            let error = strict_json_parse(deep.as_str(), &StrictJsonOptions::default().max_bytes(10_000_000)).expect_err("глубже предела");
            assert_eq!((error.name.as_str(), error.message.as_str()), ("RangeError", "Maximum call stack size exceeded"));
            // Опасный ключ раньше глубокой ветви — отказ по ключу, как в JS.
            let keyed = format!("{{\"__proto__\":1,\"a\":{}{}}}", "[".repeat(10_000), "]".repeat(10_000));
            assert!(strict_json_parse(keyed.as_str(), &StrictJsonOptions::default().max_bytes(10_000_000)).expect_err("ключ").message.contains("$.__proto__"));
            let huge = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
            assert_eq!(strict_json_parse(huge.as_str(), &StrictJsonOptions::default().max_bytes(10_000_000)).expect_err("глубина").name, "RangeError");
        })
        .expect("поток");
    worker.join().expect("без переполнения стека");
}

#[test]
fn lone_surrogate_becomes_replacement_character() {
    // Отличие от V8: строка Rust не держит одиночный суррогат.
    assert_eq!(strict_json_parse(r#"{"a":"x\ud800y"}"#, &StrictJsonOptions::default()).expect("json"), json!({ "a": "x\u{FFFD}y" }));
}
