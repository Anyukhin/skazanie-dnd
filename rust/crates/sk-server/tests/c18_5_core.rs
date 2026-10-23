//! С18.5, решение ведущего №1: ожидание модели в `/api/narrate` — `await`
//! внутри задания ядра, а не замок. Пока Рассказчик ждёт провайдера, ядро
//! исполняет другие задания стола: комнату, общий кубик (коммит в тот же
//! журнал), индикатор ввода. Затем ход завершается своим ответом.

mod kit;

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use kit::fake_provider::{chat_completion, FakeProvider, ProviderReply};
use kit::{Options, TestServer};

/// Сколько провайдер держит ответ на запрос хода.
const MODEL_DELAY: Duration = Duration::from_millis(1_500);
const ACTION: &str = "Осматриваю старые ворота";

fn state() -> Value {
    let hero = json!({ "id": "hero-one", "name": "Агата", "character": "Агата", "hp": 14, "maxHp": 14, "armor": 13, "speed": 30, "proficiency": 2, "abilities": { "str": 12, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 10 }, "inventory": [], "online": true });
    json!({
        "sessionCode": "WAIT-1", "campaign": "Ожидание модели", "activePlayerId": "hero-one", "partyMemberIds": ["hero-one"],
        "isNarrating": false, "pendingCheck": null, "agentInteraction": null, "suggestions": [], "messages": [], "players": [hero], "enemies": [],
        "scene": { "title": "Старые ворота", "location": "Старые ворота", "mood": "", "objective": "", "turn": 1, "cells": [] },
        "adventure": { "chapter": 1, "visitedLocations": ["Старые ворота"], "history": [] },
        "mechanics": { "combat": { "active": false }, "world_time": { "elapsed_minutes": 0 } },
        "social": { "npcs": [], "relationships": {}, "conversations": [], "promises": [] },
        "ruleset_id": "srd_5_2_1", "ruleset_version": "5.2.1", "enabled_rule_packs": ["srd_5_2_1"], "state_version": 0,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn model_wait_does_not_block_the_table() {
    let provider = FakeProvider::start(|request| {
        if request.path != "/chat/completions" {
            return None;
        }
        if request.text.contains(ACTION) {
            std::thread::sleep(MODEL_DELAY);
        }
        Some(ProviderReply::json(chat_completion(&json!("Агата осматривает старые ворота: створки держатся на ржавых петлях."))))
    });
    let options = Options { live_streams: Some(sk_server::streams::LiveOptions { heartbeat: Duration::from_secs(60) }), ..Options::provider(&provider, "kit/model") };
    let server = TestServer::start_with(options).await;
    let mut admin = server.client();
    admin.setup_admin().await;
    admin.post("/api/campaigns", &json!({ "code": "WAIT-1", "state": state() })).await.expect(201);

    let mut narrator = kit::Client { addr: admin.addr, cookies: admin.cookies.clone() };
    let turn = tokio::spawn(async move { narrator.post("/api/narrate", &json!({ "campaignId": "WAIT-1", "actor_id": "hero-one", "action": ACTION, "idempotency_key": "wait-1" })).await });
    // Ход дошёл до модели: провайдер получил запрос с текстом действия.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !provider.requests().iter().any(|request| request.text.contains(ACTION)) {
        assert!(Instant::now() < deadline, "ход не дошёл до модели");
        assert!(!turn.is_finished(), "ход закончился без модели");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let started = Instant::now();
    let room = admin.get("/api/rooms/WAIT-1").await;
    assert_eq!(room.status, 200, "{}", room.text());
    let die = admin.post("/api/rooms/WAIT-1/dice", &json!({ "playerId": "hero-one", "sides": 6, "idempotency_key": "wait-die" })).await;
    assert_eq!(die.status, 200, "{}", die.text());
    let typing = admin.put("/api/campaigns/WAIT-1/presence/typing", &json!({ "actor_id": "hero-one", "typing": true })).await;
    assert!(typing.status < 500, "{}", typing.text());
    let elapsed = started.elapsed();
    assert!(!turn.is_finished(), "запросы стола ответили, пока ход ждал модель");
    assert!(elapsed < MODEL_DELAY, "запросы стола ждали модель: {elapsed:?}");

    let answered = tokio::time::timeout(Duration::from_secs(30), turn).await.expect("ход за срок").expect("задача хода");
    assert_eq!(answered.status, 200, "{}", answered.text());
    let body = answered.json();
    assert!(body["room_version"].as_i64().unwrap_or(0) >= room.json()["version"].as_i64().unwrap_or(0), "версия комнаты перечитана после хода: {body}");
}
