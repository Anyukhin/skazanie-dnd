//! Тестовые крючки внутри сервера (С2): кости из правил доходят до ядра,
//! сбои журнала срабатывают на `test_hooks::commit` / `acknowledge_projection`
//! один раз и только у своего сервера.

mod kit;

use axum::http::StatusCode;
use kit::{dice, Options, TestServer};
use serde_json::{json, Value};
use sk_dice::{Dice, Visibility};
use sk_server::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use sk_server::http::json as json_response;
use sk_store::{CommitRequest, InitializeRequest};

/// `POST /api/test/hooks` `{ op, … }` — операция над ядром тестового сервера.
fn hooks_route(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let body = ctx.json_body().await?;
        let outcome = ctx
            .state
            .core
            .call(move |core| {
                Box::pin(async move {
                    let text = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
                    let result: Result<Value, sk_store::StoreError> = match text("op").as_str() {
                        "roll" => {
                            let mut dice = core.dice.clone();
                            let actor = body.get("actor").and_then(Value::as_str).map(str::to_string);
                            let roll = dice.roll(&text("expression"), &text("purpose"), actor.as_deref(), Visibility::Public).map_err(|error| sk_store::StoreError::new("DICE", error.to_string()))?;
                            Ok(json!({ "total": roll.total, "dice": roll.dice }))
                        }
                        "init" => core.events.initialize_campaign(InitializeRequest::new(text("campaign"), json!({ "campaign_id": text("campaign") }))).map(|(loaded, _)| json!({ "state_version": loaded.state_version })),
                        "commit" => sk_server::test_hooks::commit(
                            &core.events,
                            CommitRequest {
                                campaign_id: text("campaign"),
                                expected_state_version: body["expected"].as_i64().unwrap_or(0),
                                idempotency_key: text("key"),
                                events: vec![json!({ "event_type": "TimeAdvanced", "actor_id": null, "target_ids": [], "payload": { "elapsed_minutes": 5 } })],
                                metadata: json!({}),
                                ..CommitRequest::default()
                            },
                        )
                        .map(|result| json!({ "state_version": result.state_version })),
                        "ack" => sk_server::test_hooks::acknowledge_projection(&core.events, &text("campaign"), body["version"].as_i64().unwrap_or(0), None).map(|_| json!({ "acknowledged": true })),
                        other => Err(sk_store::StoreError::new("BAD_OP", format!("неизвестная операция {other}"))),
                    };
                    result
                })
            })
            .await?;
        Ok(match outcome {
            Ok(value) => json_response(StatusCode::OK, &value),
            Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "code": error.code, "error": error.message })),
        })
    })
}

fn routes() -> Vec<Route> {
    vec![Route::post(1, Matcher::path("/api/test/hooks"), hooks_route)]
}

#[tokio::test]
async fn dice_rules_reach_the_core_dice() {
    let server = TestServer::start_with(Options {
        extra_routes: routes(),
        dice: Some(dice::rules(json!({ "rules": [{ "actor": "^hero-1$", "purpose": "^free_roll$", "values": [2, 5], "value": "max" }] }))),
        ..Options::default()
    })
    .await;
    let mut client = server.client();
    let mut totals = Vec::new();
    for _ in 0..3 {
        let rolled = client.post("/api/test/hooks", &json!({ "op": "roll", "expression": "1d6", "purpose": "free_roll", "actor": "hero-1" })).await.expect(200);
        totals.push(rolled["total"].as_i64().unwrap());
    }
    assert_eq!(totals, [2, 5, 6], "сервер бросил по правилам из данных");
    let other = client.post("/api/test/hooks", &json!({ "op": "roll", "expression": "1d20", "purpose": "attack", "actor": "goblin" })).await.expect(200);
    let value = other["total"].as_i64().unwrap();
    assert!((1..=20).contains(&value), "без правила — настоящая кость");
}

#[tokio::test]
async fn shared_dice_fixture_file_parses() {
    // Те же файлы, что у JS-тестов (`test/fixtures/*.dice.json`).
    let mut rolled = dice::rules_file("mvp-player-cycle");
    assert!(rolled.roll("1d20", "unspecified", None, Visibility::Public).is_ok());
}

#[tokio::test]
async fn commit_and_ack_faults_fire_once_per_server() {
    let options = Options { extra_routes: routes(), ..Options::default() }
        .with_faults(json!({ "commit": [{ "idempotency_key": "kit-fault-throw", "mode": "throw" }], "projection_ack": [{ "campaign": "hooks", "version": 1 }] }));
    let server = TestServer::start_with(options).await;
    let neighbour = TestServer::start_with(Options { extra_routes: routes(), ..Options::default() }).await;
    let mut client = server.client();
    client.post("/api/test/hooks", &json!({ "op": "init", "campaign": "HOOKS" })).await.expect(200);

    let failed = client.post("/api/test/hooks", &json!({ "op": "commit", "campaign": "HOOKS", "key": "kit-fault-throw", "expected": 0 })).await;
    assert_eq!(failed.status, 500);
    assert_eq!(failed.json()["error"], "synthetic commit failure before journal write");
    let retried = client.post("/api/test/hooks", &json!({ "op": "commit", "campaign": "HOOKS", "key": "kit-fault-throw", "expected": 0 })).await.expect(200);
    assert_eq!(retried["state_version"], 1, "сбой срабатывает один раз, отказ не оставил записи");

    let ack = client.post("/api/test/hooks", &json!({ "op": "ack", "campaign": "HOOKS", "version": 1 })).await;
    assert_eq!(ack.json()["error"], "synthetic projection acknowledgement failure", "кампания сбоя — без учёта регистра");
    client.post("/api/test/hooks", &json!({ "op": "ack", "campaign": "HOOKS", "version": 1 })).await.expect(200);

    // Соседний сервер в том же процессе сбоев не видит.
    let mut other = neighbour.client();
    other.post("/api/test/hooks", &json!({ "op": "init", "campaign": "HOOKS" })).await.expect(200);
    other.post("/api/test/hooks", &json!({ "op": "commit", "campaign": "HOOKS", "key": "kit-fault-throw", "expected": 0 })).await.expect(200);
    other.post("/api/test/hooks", &json!({ "op": "ack", "campaign": "HOOKS", "version": 1 })).await.expect(200);
}
