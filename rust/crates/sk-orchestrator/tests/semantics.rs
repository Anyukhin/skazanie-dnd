//! Смысловые проверки `autonomous_orchestrator`, перенесённые из тестов JS
//! (`test/autonomous-campaign.test.mjs`, `test/encounter-rewards-v2.test.mjs`,
//! `test/free-action.test.mjs`): строка шага Режиссёра, восстановление после
//! победы, идемпотентность намерения, подсказка маршрута, блокировка
//! завершения встречи, отказ устаревшей версии.

use std::cell::RefCell;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::task::{Context as TaskContext, Poll, Wake, Waker};

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng};
use sk_orchestrator::autonomous_orchestrator::{director_step_narration, incapacitated_action_refusal, AutonomousCampaignOrchestrator, OrchestratorJournal, OrchestratorRules};
use sk_rules::constants::GAME_STATE_PROJECTOR_VERSION;
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::replay::{apply_game_event, with_retention_mode, RETENTION_REDUCER_VERSION};
use sk_rules::resolve::api::RulesEngine;
use sk_store::{EventStore, InitializeRequest, Reducer, RetentionMode, StoreOptions};

static WORLDS: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../../../../data/campaign-worlds-v1.json")).expect("миры"));

struct GameReducer;

fn mode_name(mode: RetentionMode) -> &'static str {
    match mode {
        RetentionMode::Legacy => "legacy",
        RetentionMode::Current => "current",
    }
}

impl Reducer for GameReducer {
    fn reducer_version(&self) -> i64 {
        RETENTION_REDUCER_VERSION
    }

    fn snapshot_projector_version(&self) -> i64 {
        GAME_STATE_PROJECTOR_VERSION
    }

    fn normalize(&self, state: Value, mode: RetentionMode) -> Value {
        match with_retention_mode(mode_name(mode), || normalize_campaign_state(&state)) {
            Ok(Ok(normalized)) => normalized,
            _ => state,
        }
    }

    fn apply(&self, state: Value, event: &Value, mode: RetentionMode) -> Result<Value, String> {
        with_retention_mode(mode_name(mode), || apply_game_event(&state, event))?.map_err(|error| error.to_string())
    }
}

/// ЛКГ теста JS (`SeededDiceRng`).
struct Lcg(u32);

impl Rng for Lcg {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        Ok(minimum + i64::from(self.0) % (maximum - minimum + 1))
    }
}

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = TaskContext::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

fn cells(width: i64, height: i64) -> Value {
    Value::Array((0..width * height).map(|index| json!({ "x": index % width, "y": index / width, "type": "floor", "revealed": index % width < 5 })).collect())
}

/// `campaign()` теста JS.
fn campaign() -> Value {
    normalize_campaign_state(&json!({
        "sessionCode": "AUTONOMY-30",
        "campaign": "Autonomous test campaign",
        "partyMemberIds": ["hero"],
        "activePlayerId": "hero",
        "players": [{
            "id": "hero", "character": "Aster", "level": 5, "hp": 200, "maxHp": 200, "armor": 25,
            "speed": 30, "proficiency": 3, "experience": 0,
            "abilities": { "str": 18, "dex": 14, "con": 18, "int": 10, "wis": 12, "cha": 16 },
            "x": 0, "y": 0,
            "inventory": [{
                "id": "server-longsword", "name": "Longsword", "type": "weapon", "quantity": 1, "equipped": true,
                "combat": { "kind": "melee", "ability": "str", "range_feet": 5, "damage_expression": "1d8+4", "damage_type": "slashing", "proficient": true },
            }],
        }],
        "enemies": [],
        "scene": { "title": "Old Road", "location": "Old Road", "objective": "Find the missing ledger", "turn": 1, "cells": cells(13, 9) },
        "mechanics": { "positions": { "hero": { "x": 0, "y": 0 } }, "world_time": { "elapsed_minutes": 0 } },
        "worldMemory": {
            "entities": [
                { "id": "old-road", "kind": "location", "name": "Old Road", "summary": "", "aliases": [], "visibility": "party", "tags": [] },
                { "id": "guild", "kind": "faction", "name": "Road Wardens", "summary": "", "aliases": [], "visibility": "party", "tags": [] },
            ],
            "facts": [],
            "quests": [{
                "id": "ledger-quest", "title": "The Missing Ledger", "summary": "", "status": "active", "visibility": "party", "entity_ids": ["old-road"], "objectives": ["Find the ledger"],
                "clock": { "current": 0, "max": 8, "label": "Evidence" },
            }],
            "knowledge": {},
        },
        "social": {
            "npcs": [{
                "id": "marta", "name": "Marta", "role": "warden", "location": "Old Road", "public_summary": "A road warden.",
                "voice": "Brief.", "goals": [], "beliefs": [], "known_fact_ids": [], "visibility": "party", "available": true,
                "tags": ["faction:guild"],
            }],
            "relationships": { "marta": { "hero": 0 } },
            "conversations": [{ "id": "opening-talk", "npc_id": "marta", "hero_id": "hero", "player_message": "We will find it.", "npc_reply": "Return before nightfall.", "stance": "neutral", "disclosed_fact_ids": [], "visibility": "party" }],
            "promises": [{
                "id": "promise-ledger", "npc_id": "marta", "hero_id": "hero", "direction": "party_to_npc", "text": "Find the ledger.",
                "due_hint": "in 1 day", "status": "open", "visibility": "party", "source_conversation_id": "opening-talk", "created_at_minutes": 0, "deadline_minutes": 1440,
            }],
        },
    }))
    .expect("кампания")
}

fn fixture(initial: Value) -> (Arc<EventStore>, AutonomousCampaignOrchestrator) {
    let serial = Arc::new(AtomicU64::new(0));
    let options = StoreOptions { snapshot_every: 7, id_factory: Arc::new(move || format!("event-{}", serial.fetch_add(1, Ordering::SeqCst) + 1)), ..StoreOptions::default() };
    let store = Arc::new(EventStore::in_memory(Arc::new(GameReducer), options).expect("хранилище"));
    store.initialize_campaign(InitializeRequest::new("AUTONOMY-30", initial)).expect("кампания");
    let engine = RefCell::new(RulesEngine::new(Box::new(ServiceDice::new(DiceService::deterministic(Lcg(0x5eed_1234), "roll")))));
    let rules: Arc<dyn OrchestratorRules> = Arc::new(engine);
    let orchestrator = AutonomousCampaignOrchestrator::new(store.clone() as Arc<dyn OrchestratorJournal>, rules).with_now(Arc::new(|| 1_784_466_000_000));
    (store, orchestrator)
}

#[test]
fn director_step_says_what_it_did() {
    let template = WORLDS["templates"].as_array().and_then(|templates| templates.iter().find(|entry| entry["id"] == "astohan-plains")).cloned().expect("Асстохан");
    let mut world_map = template["world_map"].clone();
    world_map["currentLocationId"] = json!("astohan-ash-watch");
    let state = json!({
        "scene": { "location": "Пепельная застава", "objective": "Найти, кто открыл ворота", "map": { "props": [{ "assetId": "well", "x": 3.5, "y": 3.5, "footprint": [{ "x": 3, "y": 3 }] }, { "assetId": "chest", "x": 9.5, "y": 9.5 }] } },
        "worldMap": world_map,
    });
    let revealed = director_step_narration(Some(&json!("continue_exploration")), &[json!({ "event_type": "AreaRevealed", "payload": { "cells": [{ "x": 3, "y": 3 }, { "x": 4, "y": 3 }] } })], &state);
    assert!(revealed.contains("открывается новая часть «Пепельная застава» — здесь колодец."), "{revealed}");
    assert!(!revealed.contains("сундук"), "сундук в нераскрытой клетке не называется");
    let exhausted = director_step_narration(Some(&json!("continue_exploration")), &[json!({ "event_type": "ObjectiveUpdated", "payload": {} })], &state);
    assert!(exhausted.contains("осмотрел всё"));
    assert!(exhausted.contains("Цель: Найти, кто открыл ворота."));
    assert!(exhausted.contains("Дальше можно отправиться в «Обсидиановый перевал» — скажите «Перейти дальше»."), "{exhausted}");
    assert_eq!(director_step_narration(Some(&json!("advance_quest_clock")), &[], &state), "", "у прочих шагов свой текст");
}

#[test]
fn victory_does_not_fast_forward_unless_nobody_stands() {
    for all_down in [false, true] {
        let mut initial = campaign();
        initial["partyMemberIds"] = json!(["hero", "ally"]);
        initial["players"][0]["hp"] = json!(30);
        initial["players"][0]["maxHp"] = json!(30);
        let mut ally = initial["players"][0].clone();
        ally["id"] = json!("ally");
        ally["character"] = json!("Bryn");
        ally["x"] = json!(1);
        initial["players"].as_array_mut().expect("герои").push(ally);
        initial["mechanics"]["positions"]["ally"] = json!({ "x": 1, "y": 0 });
        let (store, autonomy) = fixture(initial);
        let none = json!({});
        autonomy
            .run_commands("AUTONOMY-30", "victory-encounter", &[json!({ "command_type": "CreateEncounter", "theme": "beasts", "difficulty": "easy", "seed": "victory" }), json!({ "command_type": "StartCombat", "server_authoritative": true })], &none, None)
            .expect("встреча");
        let state = autonomy.load("AUTONOMY-30").expect("состояние").state;
        let enemy_id = js::s(state["enemies"][0].get("id"));
        for hero in if all_down { vec!["hero", "ally"] } else { vec!["ally"] } {
            autonomy.run_commands("AUTONOMY-30", &format!("down-{hero}"), &[json!({ "command_type": "ApplyDamage", "actor_id": enemy_id, "target_id": hero, "amount": 30, "damage_type": "slashing" })], &none, None).expect("урон");
            autonomy
                .commit_events_with_retry(
                    "AUTONOMY-30",
                    &format!("stable-{hero}"),
                    &[json!({ "command_id": format!("stable-{hero}"), "event_type": "HeroStabilized", "actor_id": null, "target_ids": [hero], "payload": { "method": "three-death-save-successes" }, "source_rule_ids": [], "house_rule_id": null, "ruling_id": null, "visibility": "party" })],
                    None,
                )
                .expect("стабилизация");
        }
        for enemy in state["enemies"].as_array().into_iter().flatten() {
            let id = js::s(enemy.get("id"));
            autonomy.run_commands("AUTONOMY-30", &format!("kill-{id}"), &[json!({ "command_type": "ApplyDamage", "actor_id": "hero", "target_id": id, "amount": 999, "damage_type": "slashing" })], &none, None).expect("победа");
        }
        let before = js::number(autonomy.load("AUTONOMY-30").expect("до").state["mechanics"]["world_time"].get("elapsed_minutes"));
        let result = block_on(autonomy.complete_encounter("AUTONOMY-30", Some(&json!("enemies_defeated")))).expect("итог встречи");
        let after = js::number(result["state"]["mechanics"]["world_time"].get("elapsed_minutes"));
        assert_eq!(result["state"]["autonomy"]["downtime_history"].as_array().map(Vec::len), Some(0), "привала после победы нет");
        if all_down {
            assert!(after > before, "время идёт до пробуждения");
            assert!(result["state"]["players"].as_array().into_iter().flatten().all(|hero| js::number(hero.get("hp")) >= 1.0 && js::number(hero.get("hp")) < js::number(hero.get("maxHp"))), "пришли в себя, но не отдохнули");
        } else {
            assert_eq!(after, before, "герой на ногах — время стоит");
        }
        // Повтор завершения той же встречи ничего не пишет.
        let version = sk_store::executor::Journal::load(store.as_ref(), "AUTONOMY-30").expect("журнал").state_version;
        let again = block_on(autonomy.complete_encounter("AUTONOMY-30", Some(&json!("enemies_defeated"))));
        if let Ok(again) = again {
            assert_eq!(again["duplicate"], json!(true));
        }
        assert_eq!(sk_store::executor::Journal::load(store.as_ref(), "AUTONOMY-30").expect("журнал").state_version, version);
    }
}

#[test]
fn intent_replay_is_idempotent() {
    let (store, autonomy) = fixture(campaign());
    let intent = json!({ "type": "continue_exploration" });
    let first = block_on(autonomy.run_intent("AUTONOMY-30", Some(&intent), Some(&json!("step-1")), None)).expect("шаг");
    let version = sk_store::executor::Journal::load(store.as_ref(), "AUTONOMY-30").expect("журнал").state_version;
    assert!(version > 0);
    assert!(first["results"].as_array().is_some_and(|results| results.iter().any(|result| result["events"].as_array().into_iter().flatten().any(|event| event["event_type"] == "AreaRevealed"))));
    let second = block_on(autonomy.run_intent("AUTONOMY-30", Some(&intent), Some(&json!("step-1")), None)).expect("повтор");
    assert_eq!(second["duplicate"], json!(true));
    assert_eq!(second["state_version"], json!(version));
    assert_eq!(sk_store::executor::Journal::load(store.as_ref(), "AUTONOMY-30").expect("журнал").state_version, version, "повтор не пишет событий");
}

#[test]
fn director_cannot_resolve_scene_without_proof() {
    let (_store, autonomy) = fixture(campaign());
    // Политика может заменить намерение; если нет — развязка без факта отклоняется.
    match block_on(autonomy.run_intent("AUTONOMY-30", Some(&json!({ "type": "resolve_scene", "resolution": "objective" })), Some(&json!("resolve-1")), None)) {
        Ok(result) => assert_ne!(result["intent"]["type"], json!("resolve_scene"), "развязка без факта не исполняется"),
        Err(error) => assert!(error.is_rules_validation(), "{error}"),
    }
}

#[test]
fn stale_expected_version_is_a_conflict() {
    let (_store, autonomy) = fixture(campaign());
    let error = autonomy.run_commands("AUTONOMY-30", "stale", &[json!({ "command_type": "UpdateObjective", "objective": "x" })], &json!({}), Some(42)).expect_err("версия");
    assert_eq!(error.code(), Some("STATE_VERSION_CONFLICT"));
    assert_eq!(error.message(), "Обстановка изменилась до сохранения свободного действия");
}

#[test]
fn route_hint_is_taken_once() {
    let (_store, autonomy) = fixture(campaign());
    autonomy.remember_route_hint("AUTONOMY-30", "key-1", json!({ "route": "travel", "destination": "Маяк", "actor_id": "hero" }));
    assert_eq!(autonomy.take_route_hint("AUTONOMY-30", "key-1"), Some(json!({ "route": "travel", "destination": "Маяк", "actor_id": "hero" })));
    assert_eq!(autonomy.take_route_hint("AUTONOMY-30", "key-1"), None);
    for index in 0..205 {
        autonomy.remember_route_hint("AUTONOMY-30", &format!("k{index}"), json!({ "route": "travel" }));
    }
    assert_eq!(autonomy.take_route_hint("AUTONOMY-30", "k0"), None, "старейшие подсказки вытесняются после 200");
    assert!(autonomy.take_route_hint("AUTONOMY-30", "k204").is_some());
}

#[test]
fn incapacitated_refusal_speaks_as_gm() {
    let hero = json!({ "character": "Ирма" });
    assert!(incapacitated_action_refusal(Some(&hero), Some("unconscious")).starts_with("Ирма без сознания"));
    assert!(incapacitated_action_refusal(Some(&hero), None).contains("Медицина"));
    assert_eq!(incapacitated_action_refusal(Some(&hero), Some("stunned")), "Ирма сейчас не может действовать — оглушение; пока это не пройдёт, ход за отрядом.");
    assert!(incapacitated_action_refusal(None, Some("grappled")).starts_with("Герой сейчас не может действовать — бессилие"));
}

#[test]
fn unknown_hero_action_is_rejected_without_events() {
    let (store, autonomy) = fixture(campaign());
    let request = sk_orchestrator::autonomous_orchestrator::UnknownAction::from_json(&json!({ "campaignId": "AUTONOMY-30", "action": "Осматриваю дорогу", "idempotencyKey": "free-1", "playerId": "nobody" }));
    let reply = block_on(autonomy.handle_unknown_action(&request)).expect("ответ");
    assert_eq!(reply["kind"], json!("rejected"));
    assert_eq!(reply["narration"], json!("Герой для действия не найден."));
    assert_eq!(sk_store::executor::Journal::load(store.as_ref(), "AUTONOMY-30").expect("журнал").state_version, 0);
}
