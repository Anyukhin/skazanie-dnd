//! С7: то, чего нет в эталоне JS.
//!
//! - кампания с испорченным журналом (`CAMPAIGN_RECOVERY_REQUIRED`): `GET`
//!   участнику и администратору — 500 (в JS падает `eventStore.load` вне
//!   `try`), постороннему — 403; `PATCH` владельцу — 400 с отказом
//!   восстановления (в JS — `load` внутри `try`), игроку — 403;
//! - смена режима и модели пишет строки летописи, но не события журнала;
//! - выбор переживает перезапуск процесса (настройки — в базе аккаунтов).

mod kit;

use serde_json::{json, Value};
use sk_store::{CommitRequest, LoadOptions};

use kit::TestServer;

fn bootstrap(code: &str) -> Value {
    json!({ "code": code, "name": code, "bootstrap": { "partyName": "Отряд", "slotCount": 2, "rulesetId": "srd_5_2_1", "world": { "premise": "Мост", "startingLocation": "Переправа" } } })
}

/// Коммит в журнал кампании и удаление последнего коммита: метаданные
/// обгоняют журнал — `CAMPAIGN_RECOVERY_REQUIRED` (как в `server_c6.rs`).
async fn break_journal(server: &TestServer, code: &str) {
    let code = code.to_string();
    let broken = server
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                let head = core.events.load(&code, &LoadOptions::default()).map_err(|error| error.to_string())?;
                let event = json!({ "event_id": format!("{code}-e1"), "event_type": "ObjectiveUpdated", "payload": { "objective": "Мост" } });
                core.events
                    .commit(CommitRequest { campaign_id: code.clone(), expected_state_version: head.state_version, idempotency_key: format!("{code}:1"), command_id: Some(format!("{code}:1")), events: vec![event], ..Default::default() })
                    .map_err(|error| error.to_string())?;
                core.events
                    .with_connection_mut(|conn| {
                        conn.execute("DELETE FROM commits WHERE campaign_id = ?1 AND version_after = (SELECT MAX(version_after) FROM commits WHERE campaign_id = ?1)", [&code])?;
                        Ok(())
                    })
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>(sk_server::room::get_room(&core, &code).err().and_then(|failure| failure.code))
            })
        })
        .await
        .expect("ядро");
    assert_eq!(broken.expect("порча журнала").as_deref(), Some("CAMPAIGN_RECOVERY_REQUIRED"));
}

/// Версия журнала и тексты строк «Настройки кампании».
async fn journal_and_notes(server: &TestServer, code: &str) -> (i64, Vec<String>) {
    let code = code.to_string();
    server
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                let version = core.events.load(&code, &LoadOptions::default()).map(|loaded| loaded.state_version).unwrap_or(-1);
                let room = sk_server::room::get_room(&core, &code).ok();
                let messages = room.and_then(|room| room.state).and_then(|state| state.get("messages").and_then(Value::as_array).cloned()).unwrap_or_default();
                let notes = messages.iter().filter(|message| message.get("author").and_then(Value::as_str) == Some("Настройки кампании")).map(|message| sk_core::js::s(message.get("text"))).collect();
                (version, notes)
            })
        })
        .await
        .expect("ядро")
}

#[tokio::test]
async fn broken_journal_settings_follow_js_order() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let mut owner = server.client();
    owner.register("owner@mail.ru").await;
    let mut outsider = server.client();
    outsider.register("outsider@mail.ru").await;
    owner.post("/api/campaigns", &bootstrap("C7-BROKEN")).await.expect(201);
    break_journal(&server, "C7-BROKEN").await;

    let path = "/api/campaigns/C7-BROKEN/settings";
    assert_eq!(owner.get(path).await.expect(500)["code"], "INTERNAL_ERROR");
    assert_eq!(admin.get(path).await.expect(500)["code"], "INTERNAL_ERROR");
    assert_eq!(outsider.get(path).await.expect(403)["error"], "Нет доступа к этой кампании");
    assert_eq!(outsider.patch(path, &json!({ "improvMode": "chaos" })).await.expect(403)["error"], "Настройки ИИ может менять только владелец кампании");
    assert_eq!(owner.patch(path, &json!({ "improvMode": "chaos" })).await.expect(400)["code"], "CAMPAIGN_RECOVERY_REQUIRED");
    // Тело читается раньше журнала, как `readBody` в начале `try`.
    assert_eq!(owner.patch(path, &json!([])).await.expect(400)["code"], "INVALID_JSON_BODY");
}

#[tokio::test]
async fn mode_and_model_go_to_chronicle_not_journal_and_survive_restart() {
    let server = TestServer::start().await;
    let mut owner = server.client();
    owner.register("owner@mail.ru").await;
    owner.post("/api/campaigns", &bootstrap("C7-NOTES")).await.expect(201);
    let (before, _) = journal_and_notes(&server, "C7-NOTES").await;
    let saved = owner.patch("/api/campaigns/C7-NOTES/settings", &json!({ "improvMode": "chaos", "model": "openai/gpt-6-luna", "reasoningLevel": "deep" })).await.expect(200);
    assert_eq!(saved["settings"], json!({ "model": "openai/gpt-6-luna", "narratorStyle": "neutral", "improvMode": "chaos", "reasoningLevel": "deep" }));
    let (after, notes) = journal_and_notes(&server, "C7-NOTES").await;
    assert_eq!(after, before, "режим и модель — не события журнала");
    assert_eq!(notes, ["Режим импровизации изменён: Хаос — можно всё, мир подстраивается под выбор отряда.", "Ведущий ИИ: GPT-6 Luna, рассуждения — глубже."]);
    // Повтор без изменений строк не добавляет.
    owner.patch("/api/campaigns/C7-NOTES/settings", &json!({ "improvMode": "chaos" })).await.expect(200);
    assert_eq!(journal_and_notes(&server, "C7-NOTES").await.1.len(), 2);

    // Выбор хранится в базе аккаунтов: второй процесс на том же storage его видит.
    let reopened = sk_store::accounts::Accounts::open(server.storage().join("skazanie.sqlite")).expect("база аккаунтов");
    let stored = reopened.get_campaign_ai_settings("C7-NOTES").expect("настройки");
    assert_eq!((stored.model.as_str(), stored.improv_mode.as_str(), stored.reasoning_level.as_str()), ("openai/gpt-6-luna", "chaos", "deep"));
}

/// Домашнее правило посреди боя — 409 `HOUSE_RULE_DURING_COMBAT`, журнал не
/// меняется. Бой — импортом с `mechanics.combat.active`: координатора боя
/// (С17), который в JS тут же закрыл бы пустую схватку, здесь ещё нет.
#[tokio::test]
async fn house_rule_during_combat_is_conflict() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let state = json!({
        "sessionCode": "C7-FIGHT", "campaign": "Бой", "partyMemberIds": ["hero"],
        "players": [{ "id": "hero", "character": "Иван", "name": "Иван", "hp": 10, "maxHp": 10, "x": 0, "y": 0 }],
        "messages": [], "scene": { "title": "Начало", "location": "", "mood": "", "objective": "", "turn": 0, "cells": [] },
        "mechanics": { "combat": { "active": true } },
    });
    admin.post("/api/campaigns", &json!({ "code": "C7-FIGHT", "state": state })).await.expect(201);
    let (before, _) = journal_and_notes(&server, "C7-FIGHT").await;
    let refused = admin.patch("/api/campaigns/C7-FIGHT/settings", &json!({ "houseRules": { "house:bg3-opening-strike": false }, "idempotency_key": "fight" })).await.expect(409);
    assert_eq!(refused, json!({ "error": "Домашние правила боя не меняют посреди боя", "code": "HOUSE_RULE_DURING_COMBAT" }));
    assert_eq!(journal_and_notes(&server, "C7-FIGHT").await.0, before);
}
