//! С6: то, чего нет в эталоне JS.
//!
//! - кампания с испорченным журналом (`CAMPAIGN_RECOVERY_REQUIRED`) не роняет
//!   `GET /api/campaigns` и `GET /api/heroes` — она пропускается, соседние
//!   видны (в JS комната — отдельный файл и от журнала не зависит);
//! - рекап такой кампании: участнику — `unavailable`, постороннему — 403;
//!   приглашение в неё — 400 с текстом отказа восстановления;
//! - рекап после перерыва читает журнал (`no_summaries` у новой кампании);
//! - два одновременных создания с одним кодом и разным состоянием: одно 201,
//!   другое — отказ.

mod kit;

use serde_json::{json, Value};
use sk_store::{CommitRequest, LoadOptions};

use kit::{Options, TestServer};

fn bootstrap(code: &str) -> Value {
    json!({ "code": code, "name": code, "bootstrap": { "partyName": "Отряд", "slotCount": 2, "rulesetId": "srd_5_2_1", "world": { "premise": "Мост", "startingLocation": "Переправа" } } })
}

/// Коммит в журнал кампании и удаление последнего коммита: метаданные
/// обгоняют журнал — `CAMPAIGN_RECOVERY_REQUIRED`.
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

#[tokio::test]
async fn broken_journal_does_not_break_lists_and_recap_stays_quiet() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let mut owner = server.client();
    owner.register("owner@mail.ru").await;
    let mut outsider = server.client();
    outsider.register("outsider@mail.ru").await;
    owner.post("/api/campaigns", &bootstrap("C6-BROKEN")).await.expect(201);
    owner.post("/api/campaigns", &bootstrap("C6-FINE")).await.expect(201);
    break_journal(&server, "C6-BROKEN").await;

    let listed = owner.get("/api/campaigns").await.expect(200);
    let codes: Vec<&str> = listed["campaigns"].as_array().map(|list| list.iter().filter_map(|card| card["code"].as_str()).collect()).unwrap_or_default();
    assert_eq!(codes, ["C6-FINE"], "испорченная кампания пропущена, соседняя видна");
    assert_eq!(listed["campaigns"][0]["membershipRole"], json!("owner"));
    let heroes = admin.get("/api/heroes").await.expect(200);
    assert_eq!(heroes["heroes"].as_array().map(Vec::len), Some(2), "герои соседней кампании");

    assert_eq!(owner.get("/api/campaigns/C6-BROKEN/recap").await.expect(200), json!({ "recap": null, "reason": "unavailable" }));
    assert_eq!(admin.get("/api/campaigns/c6-broken/recap").await.expect(200), json!({ "recap": null, "reason": "unavailable" }));
    assert_eq!(outsider.get("/api/campaigns/C6-BROKEN/recap").await.expect(403), json!({ "error": "Нет доступа к этой кампании" }));

    let invite = owner.post("/api/campaigns/C6-BROKEN/invites", &json!({})).await.expect(400);
    assert!(invite.get("code").is_none(), "у catch приглашения только текст: {invite}");
    assert!(invite["error"].as_str().is_some_and(|text| !text.is_empty()));
    // Сервер жив, соседняя кампания приглашает.
    let fine = owner.post("/api/campaigns/C6-FINE/invites", &json!({})).await.expect(201);
    assert_eq!(fine["hero_ids"], json!(["hero-slot-2"]));
}

#[tokio::test]
async fn recap_after_gap_reads_the_journal() {
    let options = Options { configure: Some(Box::new(|config| config.recap_gap_hours = 1e-9)), ..Options::default() };
    let server = TestServer::start_with(options).await;
    let mut owner = server.client();
    owner.register("owner@mail.ru").await;
    owner.post("/api/campaigns", &bootstrap("C6-GAP")).await.expect(201);
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert_eq!(owner.get("/api/campaigns/C6-GAP/recap").await.expect(200), json!({ "recap": null, "reason": "no_summaries" }));
}

#[tokio::test]
async fn concurrent_create_with_one_code_keeps_one_campaign() {
    let server = TestServer::start().await;
    let mut first = server.client();
    first.register("first@mail.ru").await;
    let mut second = server.client();
    second.register("second@mail.ru").await;
    // Разные имена — разные начальные состояния: второе `initializeCampaign`
    // не совпадает по хешу с первым. (Одинаковые тела в JS и здесь оба дают
    // 201 и двух владельцев — см. отчёт С6.)
    let mut other = bootstrap("C6-RACE");
    other["name"] = json!("Другое имя");
    let body = bootstrap("C6-RACE");
    let (left, right) = tokio::join!(first.post("/api/campaigns", &body), second.post("/api/campaigns", &other));
    let mut statuses = [left.status, right.status];
    statuses.sort_unstable();
    assert_eq!(statuses[0], 201, "одно создание проходит: {} / {}", left.text(), right.text());
    assert!(matches!(statuses[1], 400 | 409), "второе — отказ, а не перезапись: {} / {}", left.text(), right.text());
    let winner = if left.status == 201 { &left } else { &right };
    let campaigns = if left.status == 201 { first.get("/api/campaigns").await } else { second.get("/api/campaigns").await }.expect(200);
    assert_eq!(campaigns["campaigns"][0]["membershipRole"], json!("owner"));
    assert_eq!(winner.json()["state"]["sessionCode"], json!("C6-RACE"));
}
