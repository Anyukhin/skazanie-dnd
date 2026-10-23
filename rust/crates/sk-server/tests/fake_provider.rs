//! Заглушка провайдера и учёт расхода (С2): сервер с ключом заглушки зовёт
//! только `127.0.0.1`, каждый вызов модели проходит `usage-ledger`, а
//! сценарная модель отвечает по очереди и падает на лишнем вызове.

mod kit;

use kit::fake_provider::{chat_completion, is_local_provider_url, FakeProvider, ProviderReply, FAKE_PROVIDER_KEY};
use kit::llm::ScriptedLlm;
use kit::{Model, Options, TestServer};
use serde_json::json;

#[tokio::test]
async fn provider_stub_serves_router_client_through_the_ledger() {
    let provider = FakeProvider::start(|request| {
        (request.path == "/chat/completions").then(|| ProviderReply::json(chat_completion(&json!({ "verdict": "ok", "model": request.body["model"] }))))
    });
    assert!(is_local_provider_url(&provider.base_url()));
    let server = TestServer::start_with(Options::provider(&provider, "kit/model")).await;

    let health = server.client().get("/api/health").await.expect(200);
    assert_eq!(health["configured"], true, "сервер видит ключ заглушки");
    assert_eq!(health["model"], "kit/model");

    let llm = server.state.agent_llm().expect("клиент модели");
    let answer = llm.client().complete_json(&json!({ "messages": [{ "role": "user", "content": "проверка" }] }), &json!({})).await.expect("ответ заглушки");
    assert_eq!(answer, json!({ "verdict": "ok", "model": "kit/model" }));
    let chat: Vec<_> = provider.requests().into_iter().filter(|request| request.path == "/chat/completions").collect();
    let last = chat.last().expect("запрос дошёл до заглушки");
    assert_eq!(last.method, "POST");
    assert_eq!(last.header("authorization"), Some(format!("Bearer {FAKE_PROVIDER_KEY}").as_str()));

    let usage = server.state.ledger.report().expect("учёт расхода");
    assert!(usage["completed_requests"].as_u64().unwrap() >= 1, "вызов модели записан в ledger: {usage}");
    assert!(usage["committed_tokens"].as_i64().unwrap() >= 20, "{usage}");
}

#[tokio::test]
async fn scripted_model_answers_in_order_and_is_metered() {
    let llm = ScriptedLlm::values([json!({ "narration": "Дверь поддаётся." }), json!("просто текст")]);
    let server = TestServer::start_with(Options { model: Model::Scripted(llm.clone()), ..Options::default() }).await;
    // Ключа нет — роли агентов модель не получают (`apiKey ? llmClient : null`),
    // но клиент собран и учтён.
    assert!(server.state.agent_llm().is_none());
    let client = server.state.models.llm.clone().expect("клиент модели").client();
    assert_eq!(client.complete_json(&json!([]), &json!({})).await.unwrap(), json!({ "narration": "Дверь поддаётся." }));
    assert_eq!(client.complete_text(&json!([]), &json!({})).await.unwrap(), "просто текст");
    let extra = client.complete(&json!([]), &json!({})).await.unwrap_err();
    assert_eq!(extra.code.as_deref(), Some("LLM_UNEXPECTED_CALL"), "лишний вызов — ошибка теста");
    assert_eq!(llm.calls().len(), 3);
    let usage = server.state.ledger.report().unwrap();
    assert_eq!(usage["completed_requests"], 2);
    assert_eq!(usage["failed_requests"], 1, "отказ тоже записан");
}

#[tokio::test]
async fn forbidden_model_is_the_default() {
    let server = TestServer::start().await;
    let client = server.state.models.llm.clone().expect("клиент модели").client();
    let error = client.complete(&json!([]), &json!({})).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("LLM_FORBIDDEN"));
    assert!(!is_local_provider_url("https://routerai.ru/api/v1"));
    assert!(!is_local_provider_url("http://127.0.0.1.evil.example/"));
}
