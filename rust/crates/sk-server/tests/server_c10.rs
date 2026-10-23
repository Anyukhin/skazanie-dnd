//! С10: комната и общий кубик по настоящему HTTP — то, чего не видит эталон:
//!
//! - испорченная кампания (`CAMPAIGN_RECOVERY_REQUIRED`): `GET /api/rooms`
//!   её отказывает 500 `INTERNAL_ERROR` последней границы, сервер жив,
//!   соседняя кампания открывается (HTTP-часть `recovery-required-api`);
//! - кубик пишет в журнал ровно одно событие `PublicDieRolled` с ключом
//!   `public-die:<roll_id>`, комната после него — проекция журнала.

mod kit;

use serde_json::{json, Value};
use sk_store::LoadOptions;

use kit::TestServer;

fn state(code: &str) -> Value {
    json!({
        "sessionCode": code, "campaign": format!("Кампания {code}"), "partyName": "Один",
        "partyMemberIds": ["hero-1"], "activePlayerId": "hero-1", "messages": [],
        "players": [{ "id": "hero-1", "character": "Первый", "name": "Первый", "hp": 10, "maxHp": 10, "x": 0, "y": 0 }],
        "scene": { "title": "Зал", "location": "Зал", "mood": "", "objective": "", "turn": 0, "cells": [] },
        "ruleset_id": "srd_5_2_1", "ruleset_version": "5.2.1", "enabled_rule_packs": ["srd_5_2_1"],
        "state_version": 0,
    })
}

/// Удалить последний коммит кампании: метаданные обгоняют журнал.
async fn break_tail(server: &TestServer, code: &str) {
    let code = code.to_string();
    server
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                core.events
                    .with_connection_mut(|conn| {
                        conn.execute("DELETE FROM commits WHERE campaign_id = ?1 AND version_after = (SELECT MAX(version_after) FROM commits WHERE campaign_id = ?1)", [&code])?;
                        Ok(())
                    })
                    .expect("порча журнала");
            })
        })
        .await
        .expect("ядро");
}

/// Версия журнала кампании.
async fn journal_version(server: &TestServer, code: &str) -> i64 {
    let code = code.to_string();
    server.state.core.call(move |core| Box::pin(async move { core.events.load(&code, &LoadOptions::default()).expect("журнал").state_version })).await.expect("ядро")
}

#[tokio::test]
async fn broken_campaign_fails_alone() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    for code in ["RECOVA", "RECOVB"] {
        let created = admin.post("/api/campaigns", &json!({ "code": code, "state": state(code) })).await;
        assert_eq!(created.status, 201, "{}", created.text());
    }
    // Коммит в каждую: повреждать есть что (хвост журнала).
    for code in ["RECOVA", "RECOVB"] {
        let rolled = admin.post(&format!("/api/rooms/{code}/dice"), &json!({ "playerId": "hero-1", "sides": 20 })).await;
        assert_eq!(rolled.status, 200, "{}", rolled.text());
        assert_eq!(rolled.json()["state"]["lastDiceRoll"]["id"], rolled.json()["roll"]["id"]);
    }
    assert_eq!(journal_version(&server, "RECOVA").await, 1, "один коммит броска");
    assert_eq!(admin.get("/api/rooms/RECOVA").await.status, 200);

    break_tail(&server, "RECOVA").await;
    let damaged = admin.get("/api/rooms/RECOVA").await;
    assert_eq!(damaged.status, 500, "{}", damaged.text());
    assert_eq!(damaged.json(), json!({ "error": "Внутренняя ошибка сервера", "code": "INTERNAL_ERROR" }));
    assert_eq!(server.client().get("/api/health").await.status, 200, "сервер жив");
    let healthy = admin.get("/api/rooms/RECOVB").await;
    assert_eq!(healthy.status, 200, "{}", healthy.text());
    assert_eq!(healthy.json()["state"]["state_version"], json!(1));
    assert_eq!(admin.get("/api/rooms/RECOVA").await.status, 500, "повтор отказывает так же");
    // Кубик в испорченную: комната не собирается — отказ внутри `try`, 400.
    let rolled = admin.post("/api/rooms/RECOVA/dice", &json!({ "playerId": "hero-1" })).await;
    assert_eq!(rolled.status, 400, "{}", rolled.text());
    assert_eq!(rolled.json()["code"], Value::Null, "кубик отвечает только текстом");
}

#[tokio::test]
async fn public_die_commit_is_keyed_by_roll_id() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let created = admin.post("/api/campaigns", &json!({ "code": "DICE-1", "state": state("DICE-1") })).await;
    assert_eq!(created.status, 201, "{}", created.text());
    let rolled = admin.post("/api/rooms/DICE-1/dice", &json!({ "playerId": "hero-1", "sides": "12" })).await.expect(200);
    assert_eq!((rolled["roll"]["sides"].clone(), rolled["roll"]["value"].clone()), (json!(12), json!(10)), "кость набора — d12, грань от костей сервера");
    let roll_id = rolled["roll"]["id"].as_str().unwrap_or_default().to_string();
    let key = format!("public-die:{roll_id}");
    let found = server
        .state
        .core
        .call(move |core| Box::pin(async move { core.events.get_by_idempotency_key("DICE-1", &key).expect("журнал").map(|commit| commit.events.iter().map(|event| event["event_type"].clone()).collect::<Vec<_>>()) }))
        .await
        .expect("ядро");
    assert_eq!(found, Some(vec![json!("PublicDieRolled")]), "ровно одно событие броска, коммит под ключом public-die:<roll_id>");
    let room = admin.get("/api/rooms/DICE-1").await.expect(200);
    assert_eq!(room["version"], rolled["version"], "комната — та же проекция");
    assert_eq!(room["state"]["lastDiceRoll"], rolled["roll"]);
}
