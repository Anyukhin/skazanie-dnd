//! Смысловые проверки `game_orchestrator`, перенесённые из тестов JS
//! (`test/game-orchestrator.test.mjs`, `test/narration-npc-reactions.test.mjs`,
//! `test/dialogue-interaction.test.mjs`): поток рассказа только после
//! коммита, общий итог параллельных запросов, конфликт ключа, повтор без
//! трассы, повторная проверка старого рассказа, торговля без свободного
//! рассказчика, `/why` без служебных идентификаторов, отпечатки запроса.

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll, Wake, Waker};

use serde_json::{json, Value};
use sk_core::{js, re, text};
use sk_dice::{DiceError, DiceService, Rng};
use sk_orchestrator::autonomous_orchestrator::{AgentFuture, OrchestratorError, OrchestratorJournal, OrchestratorResult};
use sk_orchestrator::game_orchestrator::{
    narration_npc_reactions, narration_request_fingerprint, roll_purpose_label, speech_addressee, structured_commands_fingerprint, GameOrchestrator, GameOrchestratorOptions, HandleInput, IntentReader, NarrationOptions, PlanAdjudicator, RequestFingerprint, SocialTarget, TurnNarrator,
    TurnRules, TurnTraceStore,
};
use sk_projection::trace_store::FileTraceStore;
use sk_rules::constants::GAME_STATE_PROJECTOR_VERSION;
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::replay::{apply_game_event, with_retention_mode, RETENTION_REDUCER_VERSION};
use sk_rules::resolve::api::RulesEngine;
use sk_store::{EventStore, InitializeRequest, Reducer, RetentionMode, StoreOptions};

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

struct Fixed(i64);

impl Rng for Fixed {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        Ok(self.0.clamp(minimum, maximum))
    }
}

fn room_state() -> Value {
    normalize_campaign_state(&json!({
        "sessionCode": "TEST-ROOM", "activePlayerId": "hero", "scene": { "title": "Зал", "cells": [] },
        "players": [
            { "id": "hero", "character": "Ада", "hp": 10, "maxHp": 10, "armor": 14, "abilities": { "str": 14 }, "inventory": [] },
            { "id": "goblin", "character": "Гоблин", "hp": 8, "maxHp": 8, "armor": 12, "abilities": { "dex": 12 }, "inventory": [] },
        ],
    }))
    .expect("состояние")
}

static DIRS: AtomicU64 = AtomicU64::new(0);

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sk-o2-semantics-{}-{}", std::process::id(), DIRS.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

struct Setup {
    journal: Arc<EventStore>,
    rules: Arc<RefCell<RulesEngine>>,
    traces: Arc<FileTraceStore>,
}

fn setup() -> Setup {
    let journal = Arc::new(EventStore::in_memory(Arc::new(GameReducer), StoreOptions::default()).expect("журнал"));
    journal.initialize_campaign(InitializeRequest::new("TEST-ROOM", room_state())).expect("кампания");
    let mut serial = 0u64;
    let dice = DiceService::new(
        Fixed(10),
        Box::new(move || {
            serial += 1;
            format!("roll-{serial}")
        }),
        Box::new(|| "2026-08-01T10:00:00.000Z".to_string()),
    );
    let rules = Arc::new(RefCell::new(RulesEngine { dice: Box::new(ServiceDice::new(dice)), uuid: Box::new(sk_core::hash::uuid_v4) }));
    let traces = Arc::new(FileTraceStore::new(temp_dir()).expect("трассы"));
    Setup { journal, rules, traces }
}

fn orchestrator(setup: &Setup, configure: impl FnOnce(&mut GameOrchestratorOptions)) -> GameOrchestrator {
    let journal: Arc<dyn OrchestratorJournal> = setup.journal.clone();
    let mut options = GameOrchestratorOptions::new(journal, setup.rules.clone() as Arc<dyn TurnRules>);
    options.trace_store = Some(setup.traces.clone() as Arc<dyn TurnTraceStore>);
    let ids = Arc::new(AtomicU64::new(0));
    options.id_factory = Some(Arc::new(move || format!("turn-{}", ids.fetch_add(1, Ordering::SeqCst) + 1)));
    configure(&mut options);
    GameOrchestrator::new(options).expect("оркестратор")
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
        std::thread::park_timeout(std::time::Duration::from_millis(5));
    }
}

fn damage_input(key: &str, amount: i64) -> HandleInput {
    HandleInput::new(json!({
        "state": room_state(), "playerId": "hero", "message": "Системная команда", "idempotencyKey": key,
        "commands": [{ "command_type": "ApplyDamage", "actor_id": "hero", "target_id": "goblin", "amount": amount, "damage_type": "slashing" }],
    }))
}

fn hp(response: &Value, index: usize) -> i64 {
    response["authoritative_state"]["players"][index]["hp"].as_i64().unwrap_or(-1)
}

/// Разбор и план «прозы»: одно судейское решение без механики.
struct ProseParser;

impl IntentReader for ProseParser {
    fn parse<'a>(&'a self, message: &'a str, player_id: &'a str, _state: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            Ok(json!({ "actor_id": player_id, "intent": "custom_ruling", "approach": "test", "targets": [], "mentioned_entities": [], "missing_information": [], "requires_clarification": false, "confidence": 1, "raw_message": message }))
        })
    }
}

struct ProsePlan;

impl PlanAdjudicator for ProsePlan {
    fn create_plan<'a>(&'a self, _intent: &'a Value, _state: &'a Value, _rules: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            Ok(json!({
                "rule_ids": [],
                "proposed_commands": [{ "command_type": "RecordRuling", "actor_id": "hero", "ruling_id": "stream-ruling", "ruling": { "id": "stream-ruling", "question": "Что изменилось?", "selected_interpretation": "Ничего." } }],
                "roll_requests": [], "ruling_required": false, "ruling_draft": null, "narration_constraints": [], "confidence": 1,
            }))
        })
    }
}

/// Рассказчик теста: считает вызовы, ждёт открытия ворот, шлёт кусок текста.
struct GatedNarrator {
    calls: AtomicU64,
    gate: Arc<AtomicBool>,
    text: &'static str,
    log: Arc<Mutex<Vec<&'static str>>>,
}

struct Gate(Arc<AtomicBool>);

impl Future for Gate {
    type Output = ();
    fn poll(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<()> {
        if self.0.load(Ordering::SeqCst) {
            Poll::Ready(())
        } else {
            context.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

impl TurnNarrator for GatedNarrator {
    fn render<'a>(&'a self, _brief: &'a Value, options: NarrationOptions) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.log.lock().expect("журнал").push("render");
            Gate(self.gate.clone()).await;
            if let Some(progress) = &options.on_progress {
                progress(self.text);
            }
            Ok(json!({ "narration": self.text, "verification": { "valid": true, "violations": [] }, "prompt_version": "narrator/v7", "provider": "TestNarrator" }))
        })
    }
}

fn prose(options: &mut GameOrchestratorOptions, narrator: Arc<GatedNarrator>) {
    options.intent_parser = Some(Arc::new(ProseParser));
    options.adjudicator = Some(Arc::new(ProsePlan));
    options.narrator = Some(Some(narrator));
}

#[test]
fn narration_stream_starts_after_commit_and_replay_does_not_stream() {
    let setup = setup();
    let log = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new(AtomicBool::new(false));
    let narrator = Arc::new(GatedNarrator { calls: AtomicU64::new(0), gate: gate.clone(), text: "Пока ничего не меняется.", log: log.clone() });
    let orchestrator = orchestrator(&setup, |options| prose(options, narrator.clone()));
    let journal = setup.journal.clone();
    let order = Arc::new(Mutex::new(Vec::new()));
    let mut input = HandleInput::new(json!({ "state": room_state(), "playerId": "hero", "message": "Проверяю обстановку", "idempotencyKey": "stream-after-commit" }));
    let (start_order, start_gate) = (order.clone(), gate.clone());
    input.on_narration_start = Some(Arc::new(move |payload: &Value| {
        // До начала потока механика уже в журнале.
        let version = sk_store::executor::Journal::load(journal.as_ref(), "TEST-ROOM").map(|loaded| loaded.state_version).unwrap_or(0);
        assert_eq!(Some(version), payload["stateVersion"].as_i64());
        assert!(version > 0, "до narration.start механика уже должна быть committed");
        start_order.lock().expect("порядок").push("start");
        start_gate.store(true, Ordering::SeqCst);
    }));
    let chunk_order = order.clone();
    input.on_narration_progress = Some(Arc::new(move |_text: &str, _payload: &Value| chunk_order.lock().expect("порядок").push("chunk")));
    let first = block_on(orchestrator.handle(input.clone())).expect("первый ход");
    let replay = block_on(orchestrator.handle(input)).expect("повтор");
    assert_eq!(*order.lock().expect("порядок"), vec!["start", "chunk"]);
    assert_eq!(first["idempotent_replay"], json!(false));
    assert_eq!(replay["idempotent_replay"], json!(true));
    assert_eq!(replay["narration"], first["narration"]);
    assert_eq!(narrator.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn parallel_identical_requests_share_one_commit_and_narrator() {
    let setup = setup();
    let gate = Arc::new(AtomicBool::new(false));
    let narrator = Arc::new(GatedNarrator { calls: AtomicU64::new(0), gate: gate.clone(), text: "Проверенный итог остаётся неизменным.", log: Arc::new(Mutex::new(Vec::new())) });
    let orchestrator = orchestrator(&setup, |options| prose(options, narrator.clone()));
    let starts = Arc::new(AtomicU64::new(0));
    let mut input = HandleInput::new(json!({ "state": room_state(), "playerId": "hero", "message": "Проверяю обстановку", "idempotencyKey": "parallel-stream" }));
    let counter = starts.clone();
    input.on_narration_start = Some(Arc::new(move |_payload: &Value| {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let mut conflicting = input.clone();
    conflicting.fields["message"] = json!("Другое действие");
    let results = block_on(async {
        let mut first = orchestrator.handle(input.clone());
        let mut second = orchestrator.handle(input.clone());
        let mut third = orchestrator.handle(conflicting);
        let mut outputs: [Option<OrchestratorResult<Value>>; 3] = [None, None, None];
        std::future::poll_fn(|context| {
            for (slot, future) in outputs.iter_mut().zip([&mut first, &mut second, &mut third]) {
                if slot.is_none() {
                    if let Poll::Ready(value) = future.as_mut().poll(context) {
                        *slot = Some(value);
                    }
                }
            }
            // Ворота открываются, когда все три запроса уже в работе.
            if outputs[2].is_some() {
                gate.store(true, Ordering::SeqCst);
            }
            if outputs.iter().all(Option::is_some) {
                Poll::Ready(())
            } else {
                context.waker().wake_by_ref();
                Poll::Pending
            }
        })
        .await;
        outputs
    });
    let [first, replay, conflict] = results;
    let conflict = conflict.expect("третий").expect_err("конфликт ключа");
    assert_eq!(conflict.code(), Some("IDEMPOTENCY_CONFLICT"));
    let first = first.expect("первый").expect("первый ход");
    let replay = replay.expect("второй").expect("повтор");
    assert_eq!(narrator.calls.load(Ordering::SeqCst), 1);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(first["idempotent_replay"], json!(false));
    assert_eq!(replay["idempotent_replay"], json!(true));
    assert_eq!(replay["narration"], first["narration"]);
    assert_eq!(replay["state_version"], first["state_version"]);
}

/// Рассказчик, которому нельзя звонить.
struct ForbiddenNarrator(AtomicU64);

impl TurnNarrator for ForbiddenNarrator {
    fn render<'a>(&'a self, _brief: &'a Value, _options: NarrationOptions) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(OrchestratorError::plain("Narrator must not run"))
        })
    }
}

#[test]
fn enforce_commits_once_and_repeated_key_is_safe() {
    let setup = setup();
    let narrator = Arc::new(ForbiddenNarrator(AtomicU64::new(0)));
    let orchestrator = orchestrator(&setup, |options| options.narrator = Some(Some(narrator.clone())));
    let first = block_on(orchestrator.handle(damage_input("damage-1", 3))).expect("ход");
    let second = block_on(orchestrator.handle(damage_input("damage-1", 3))).expect("повтор");
    assert_eq!(hp(&first, 1), 5);
    assert_eq!(hp(&second, 1), 5);
    assert_eq!(second["idempotent_replay"], json!(true));
    assert_eq!(second["turn_id"], first["turn_id"]);
    assert_eq!(second["narration"], first["narration"]);
    assert_eq!(narrator.0.load(Ordering::SeqCst), 0);
    assert_eq!(first["provider"], json!("deterministic-mechanics"));
    let loaded = sk_store::executor::Journal::load(setup.journal.as_ref(), "TEST-ROOM").expect("журнал");
    assert_eq!(loaded.state["players"][1]["hp"], json!(5));
}

#[test]
fn replay_without_trace_uses_deterministic_fallback() {
    let setup = setup();
    let first = block_on(orchestrator(&setup, |_| {}).handle(damage_input("missing-trace-replay", 2))).expect("ход");
    let narrator = Arc::new(ForbiddenNarrator(AtomicU64::new(0)));
    let empty = Arc::new(FileTraceStore::new(temp_dir()).expect("трассы"));
    let replayer = orchestrator(&setup, |options| {
        options.narrator = Some(Some(narrator.clone()));
        options.trace_store = Some(empty.clone() as Arc<dyn TurnTraceStore>);
    });
    let replay = block_on(replayer.handle(damage_input("missing-trace-replay", 2))).expect("повтор");
    assert_eq!(replay["idempotent_replay"], json!(true));
    assert_eq!(replay["turn_id"], first["turn_id"]);
    assert_eq!(replay["provider"], json!("deterministic-idempotent-replay"));
    assert_eq!(replay["verification"]["valid"], json!(true));
    assert_eq!(replay["verification"]["response_plan"]["mode"], json!("world_narration"));
    assert_eq!(replay["verification"]["origin"]["source"], json!("template"));
    assert_eq!(replay["verification"]["origin"]["reason"], json!("replay_fallback"));
    assert_eq!(hp(&replay, 1), 6);
    assert_eq!(narrator.0.load(Ordering::SeqCst), 0);
    // Повтор восстановил потерянную трассу (аудит PR #131, SEC-03).
    let restored = TurnTraceStore::get(empty.as_ref(), "TEST-ROOM", &js::s(first.get("turn_id"))).expect("чтение").expect("трасса");
    assert_eq!(restored["recovery"]["reason"], json!("trace_missing_after_commit"));
    assert_eq!(restored["request_fingerprint"], Value::Null);
}

#[test]
fn replay_rechecks_cached_narration_and_keeps_safe_metadata() {
    let setup = setup();
    let orchestrator = orchestrator(&setup, |_| {});
    let first = block_on(orchestrator.handle(damage_input("unsafe-cached-replay", 2))).expect("ход");
    let turn = js::s(first.get("turn_id"));
    let mut trace = TurnTraceStore::get(setup.traces.as_ref(), "TEST-ROOM", &turn).expect("чтение").expect("трасса");
    trace["narration_result"] = json!({ "narration": "Ада проверяет дверь.", "suggestions": [], "verification": { "valid": true, "violations": [] }, "prompt_version": "narrator/v2", "provider": "legacy-cached" });
    TurnTraceStore::save(setup.traces.as_ref(), &trace).expect("запись");
    let replay = block_on(orchestrator.handle(damage_input("unsafe-cached-replay", 2))).expect("повтор");
    assert_eq!(replay["idempotent_replay"], json!(true));
    assert_eq!(replay["provider"], json!("deterministic-idempotent-replay"));
    assert!(!js::s(replay.get("narration")).contains("Ада проверяет дверь"));

    let second = block_on(orchestrator.handle(damage_input("safe-cached-metadata", 2))).expect("ход");
    let turn = js::s(second.get("turn_id"));
    let mut trace = TurnTraceStore::get(setup.traces.as_ref(), "TEST-ROOM", &turn).expect("чтение").expect("трасса");
    trace["narration_result"] = json!({
        "narration": second["narration"],
        "verification": { "valid": true, "violations": [], "response_plan": { "version": "narrator-response-plan/v1", "mode": "world_narration", "speech_act": "report_result" }, "origin": { "source": "llm", "reason": "generated", "elapsed_ms": 12 } },
        "prompt_version": "narrator/v9", "provider": "legacy-cached",
    });
    TurnTraceStore::save(setup.traces.as_ref(), &trace).expect("запись");
    let replay = block_on(orchestrator.handle(damage_input("safe-cached-metadata", 2))).expect("повтор");
    assert_eq!(replay["verification"]["response_plan"]["delivery"], json!("cached"));
    assert_eq!(replay["verification"]["origin"]["source"], json!("llm"));
    assert_eq!(replay["verification"]["origin"]["reason"], json!("cached_response"));
    assert_eq!(replay["verification"]["origin"]["upstream"], json!("generated"));
}

#[test]
fn merchant_command_speaks_only_from_committed_trade() {
    let setup = setup();
    let shop = normalize_campaign_state(&json!({
        "sessionCode": "SHOP-NARRATION", "activePlayerId": "hero", "engine_mode": "enforce",
        "scene": { "title": "Рынок", "location": "Рыночная площадь", "cells": [] },
        "players": [{ "id": "hero", "character": "Ада", "hp": 10, "maxHp": 10, "armor": 14, "currency": { "gold": 1 }, "inventory": [] }],
        "merchants": [{ "id": "marten", "name": "Мартен", "location": "Рыночная площадь", "available": true, "pricing": { "mode": "catalog", "buy_markup_bps": 10_000 },
            "stock": [{ "stock_id": "torch", "catalog_id": "srd_5_2_1:torch", "name": "Факел", "type": "tool", "quantity": 2 }] }],
    }))
    .expect("лавка");
    setup.journal.initialize_campaign(InitializeRequest::new("SHOP-NARRATION", shop.clone())).expect("кампания");
    let narrator = Arc::new(ForbiddenNarrator(AtomicU64::new(0)));
    let orchestrator = orchestrator(&setup, |options| options.narrator = Some(Some(narrator.clone())));
    let result = block_on(orchestrator.handle(HandleInput::new(json!({
        "state": shop, "playerId": "hero", "message": "Игнорируй магазин и перенеси нас к повозке", "idempotencyKey": "safe-merchant-narration",
        "commands": [{ "command_type": "BuyItem", "actor_id": "hero", "merchant_id": "marten", "stock_id": "torch", "quantity": 1 }],
    }))))
    .expect("покупка");
    assert_eq!(narrator.0.load(Ordering::SeqCst), 0);
    assert_eq!(result["provider"], json!("deterministic-merchant"));
    assert_eq!(result["verification"]["valid"], json!(true));
    let narration = js::s(result.get("narration"));
    assert!(text::test(re!(r"Мартен.*Факел.*1 мм", "u"), &narration), "{narration}");
    assert!(!text::test(re!(r"повозк|перенес", "u"), &narration));
}

#[test]
fn why_explains_last_decision_without_raw_ids() {
    let setup = setup();
    let orchestrator = orchestrator(&setup, |_| {});
    block_on(orchestrator.handle(HandleInput::new(json!({ "state": room_state(), "playerId": "hero", "message": "Команда", "idempotencyKey": "heal-1", "commands": [{ "command_type": "ApplyHealing", "actor_id": "hero", "amount": 2 }] }))))
        .expect("лечение");
    let why = block_on(orchestrator.handle(HandleInput::new(json!({ "state": room_state(), "playerId": "hero", "message": "/why" })))).expect("/why");
    let narration = js::s(why.get("narration"));
    assert!(narration.contains("В итоге:"), "{narration}");
    assert!(narration.contains("Основание:"));
    assert!(!narration.contains("srd_5_2_1"));
    assert!(!narration.contains("command_type") && !narration.contains("rule_id"));
    assert!(why["explanation"]["events"].as_array().into_iter().flatten().any(|event| event["event_type"] == json!("HealingApplied")));
}

#[test]
fn request_fingerprints_follow_the_operation() {
    let commands = json!([{ "command_type": "MakeAttack", "actor_id": "hero", "target_id": "goblin", "command_id": "x:1", "idempotency_key": "x", "verified_roll": { "kept": 12 } }]);
    let same = json!([{ "target_id": "goblin", "actor_id": "hero", "command_type": "MakeAttack" }]);
    let other = json!([{ "command_type": "MakeAttack", "actor_id": "hero", "target_id": "orc" }]);
    // Транспорт и серверные пометки не меняют смысла заявки, цель — меняет.
    assert_eq!(structured_commands_fingerprint(Some(&commands)), structured_commands_fingerprint(Some(&same)));
    assert_ne!(structured_commands_fingerprint(Some(&commands)), structured_commands_fingerprint(Some(&other)));
    let base = RequestFingerprint { campaign_id: "room".into(), player_id: "hero".into(), message: "  Осматриваю   зал ".into(), ..RequestFingerprint::default() };
    let spaced = RequestFingerprint { campaign_id: "ROOM".into(), message: "Осматриваю зал".into(), ..base.clone() };
    assert_eq!(narration_request_fingerprint(&base), narration_request_fingerprint(&spaced));
    let with_operation = RequestFingerprint { operation: "message".into(), ..base.clone() };
    assert_ne!(narration_request_fingerprint(&base), narration_request_fingerprint(&with_operation));
}

#[test]
fn roll_labels_hide_service_keys() {
    assert_eq!(roll_purpose_label(Some(&json!("ability_check:WIS"))), "Проверка Мудрости");
    assert_eq!(roll_purpose_label(Some(&json!("saving_throw:dex"))), "Спасбросок Ловкости");
    assert_eq!(roll_purpose_label(Some(&json!("mystery_key:x"))), "Проверка");
    assert_eq!(roll_purpose_label(Some(&json!("Бросок удачи"))), "Бросок удачи");
    assert_eq!(roll_purpose_label(None), "Проверка");
}

#[test]
fn violence_overrides_relationships_and_deeds_get_a_reaction() {
    let npcs = vec![json!({ "id": "mara", "name": "Мара", "relationship": "friendly" }), json!({ "id": "ivar", "name": "Ивар", "relationship": "hostile" })];
    let calm = narration_npc_reactions(&npcs, &[], false, None);
    assert_eq!(calm[0]["reaction"], json!("welcoming"));
    assert_eq!(calm[1]["reaction"], json!("cold"));
    let blood = narration_npc_reactions(&npcs, &[json!({ "event_type": "DamageApplied" })], true, None);
    assert!(blood.iter().all(|entry| entry["reaction"] == json!("alarmed")));
    let target = SocialTarget { npc_id: json!("mara"), success: Some(true) };
    let deed = narration_npc_reactions(&npcs, &[], true, Some(&target));
    assert_eq!(deed[0]["reaction"], json!("persuaded"));
    assert_eq!(deed[1]["reaction"], json!("reacts_to_act"));
}

#[test]
fn quoted_speech_finds_its_addressee() {
    let state = json!({
        "scene": { "location": "Причал" },
        "social": { "npcs": [{ "id": "ivar", "name": "Ивар", "location": "Причал" }, { "id": "lina", "name": "Лина", "location": "Причал" }] },
        "players": [{ "id": "hero", "character": "Мирель" }, { "id": "borin", "character": "Борин" }],
    });
    let vocative = speech_addressee("Мирель раскрывает тетрадь. «Ивар, чей это баркас?»", &state, "hero", false).expect("обращение");
    assert_eq!((vocative.kind, vocative.id.as_str()), ("npc", "ivar"));
    let cued = speech_addressee("Подходит к Лине, кладёт монету. «Скажите честно…»", &state, "hero", false).expect("подход");
    assert_eq!(cued.id, "lina");
    let party = speech_addressee("Говорю Борину: «Я не уйду, пока не узнаю правду»", &state, "hero", false).expect("спутник");
    assert_eq!(party.kind, "hero");
    assert!(speech_addressee("Сотворяю «Безмолвный образ» перед Ивар", &state, "hero", false).is_none());
}
