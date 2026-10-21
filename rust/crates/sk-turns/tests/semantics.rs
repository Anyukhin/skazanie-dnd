//! Смысловые проверки тестов JS (`test/npc-turn-scheduler.test.mjs`,
//! `test/combat-turn-coordinator.test.mjs`), перенесённые на крейт: цикл
//! планировщика на настоящем хранилище, мораль, конец боя, восстановление
//! стабилизированного отряда, часы хода, авто-пропуск, повтор с задержкой и
//! удержание автохода.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll, Wake, Waker};

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng, SequenceRng};
use sk_rules::constants::GAME_STATE_PROJECTOR_VERSION;
use sk_rules::dice_record::{RulesDice, ServiceDice};
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::pause::{Fault, Halt};
use sk_rules::replay::{apply_game_event, with_retention_mode, RETENTION_REDUCER_VERSION};
use sk_rules::resolve::api::RulesEngine;
use sk_store::executor::Journal;
use sk_store::{CommitRequest, CommitResult, EventStore, InitializeRequest, Loaded, Reducer, RetentionMode, StoreError, StoreOptions, StoreResult};
use sk_turns::combat_turn_coordinator::{combat_turn_clock, turn_activity_key, ClockOptions, CombatTurnCoordinator, CoordinatorHost, CoordinatorSettings, HostFuture, TimerAction, ACTIVE_TURN_LIMIT_FACTOR};
use sk_turns::npc_turn_scheduler::{npc_behavior_policies, plan_npc_turn, run_npc_turn_scheduler, DecisionFuture, NpcController, NpcRulesEngine, NpcTurnJournal, SchedulerError, SchedulerOptions, SchedulerResult};

// --- окружение ---------------------------------------------------------------------------

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

/// Один шаг будущего: `Some` — готово.
fn poll_once<F: Future>(future: &mut std::pin::Pin<Box<F>>) -> Option<F::Output> {
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = TaskContext::from_waker(&waker);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => Some(value),
        Poll::Pending => None,
    }
}

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

fn store_at(clock_ms: Arc<AtomicU64>) -> EventStore {
    let serial = Arc::new(AtomicU64::new(0));
    let options = StoreOptions {
        clock: Arc::new(move || clock_ms.load(Ordering::SeqCst) as i64),
        id_factory: Arc::new(move || format!("turn-event-{}", serial.fetch_add(1, Ordering::SeqCst) + 1)),
        ..StoreOptions::default()
    };
    EventStore::in_memory(Arc::new(GameReducer), options).expect("хранилище")
}

fn store() -> EventStore {
    store_at(Arc::new(AtomicU64::new(ms("2026-07-12T00:00:00.000Z") as u64)))
}

fn ms(iso: &str) -> i64 {
    sk_core::clock::parse_iso(iso).expect("момент")
}

fn engine_with(dice: Box<dyn RulesDice>) -> RefCell<RulesEngine> {
    let mut uuid = 0u64;
    RefCell::new(RulesEngine {
        dice,
        uuid: Box::new(move || {
            uuid += 1;
            format!("uuid-{uuid}")
        }),
    })
}

fn dice(values: &[i64]) -> RefCell<RulesEngine> {
    engine_with(Box::new(ServiceDice::new(DiceService::deterministic(SequenceRng::new(values.to_vec()), "roll"))))
}

/// `boundedDice()`: d20 — 15, прочие кости — не больше 3.
struct Bounded;

impl Rng for Bounded {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        Ok(if maximum == 20 { 15 } else { maximum.min(3).max(minimum) })
    }
}

fn bounded() -> RefCell<RulesEngine> {
    engine_with(Box::new(ServiceDice::new(DiceService::deterministic(Bounded, "bounded-roll"))))
}

fn cells(width: i64, height: i64) -> Vec<Value> {
    (0..width * height).map(|index| json!({ "x": index % width, "y": index / width, "type": "floor", "revealed": true })).collect()
}

/// `fixture()` из `test/npc-turn-scheduler.test.mjs`.
fn fixture() -> Value {
    let state = json!({
        "sessionCode": "NPC-UNIT",
        "partyMemberIds": ["hero"],
        "players": [{
            "id": "hero", "hp": 30, "maxHp": 30, "armor": 12, "speed": 30, "proficiency": 2,
            "abilities": { "str": 16, "dex": 14, "con": 12, "int": 10, "wis": 10, "cha": 10 },
            "attackBonus": 7, "damageDice": 6, "damageBonus": 2, "x": 0, "y": 1,
        }],
        "enemies": [{
            "id": "wolf", "hp": 20, "maxHp": 20, "armor": 11, "speed": 10, "attackBonus": 4, "damageDice": 4, "damageBonus": 1,
            "abilities": { "str": 14, "dex": 12, "con": 12, "int": 4, "wis": 12, "cha": 6 }, "x": 3, "y": 1, "alive": true,
        }],
        "scene": { "turn": 1, "cells": cells(9, 3) },
        "mechanics": {
            "combat": {
                "active": true, "round": 1, "active_index": 0,
                "initiative": [{ "actor_id": "hero", "total": 20 }, { "actor_id": "wolf", "total": 10 }],
                "action_economy": {
                    "hero": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                    "wolf": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                },
            },
        },
    });
    let state = normalize_campaign_state(&state).expect("нормализация");
    normalize_campaign_state(&state).expect("нормализация")
}

fn initialize(journal: &EventStore, campaign: &str, state: Value) {
    journal.initialize_campaign(InitializeRequest::new(campaign, state)).expect("кампания");
}

fn run<'a>(campaign: &'a str, journal: &'a dyn NpcTurnJournal, engine: &'a dyn NpcRulesEngine, controller: Option<&'a dyn NpcController>) -> SchedulerOptions<'a> {
    let mut options = SchedulerOptions::new(campaign, journal, engine);
    options.npc_controller = controller;
    options
}

fn event_types(events: &[Value]) -> Vec<String> {
    events.iter().map(|event| js::s(event.get("event_type"))).collect()
}

/// Контроллер морали с постоянным решением и счётчиком вызовов.
struct FixedController {
    calls: Cell<usize>,
    decision: Value,
}

impl NpcController for FixedController {
    fn decide<'a>(&'a self, _state: &'a Value, _enemy_id: &'a str) -> DecisionFuture<'a> {
        self.calls.set(self.calls.get() + 1);
        let decision = self.decision.clone();
        Box::pin(async move { Some(decision) })
    }
}

// --- планировщик -----------------------------------------------------------------------

#[test]
fn behavior_dictionary_exposes_only_named_policies() {
    assert_eq!(
        npc_behavior_policies(),
        json!({ "multiattack": "multiattack", "keepDistance": "keep-distance", "charge": "charge", "bloodiedFrenzy": "bloodied-frenzy", "relentlessPursuit": "relentless-pursuit" })
    );
}

/// Журнал, который на любой ключ отвечает прежним коммитом без прогресса.
struct DuplicateJournal {
    state: Value,
    lookups: Cell<usize>,
}

impl Journal for DuplicateJournal {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        Ok(Loaded { campaign_id: campaign_id.into(), state_version: 41, current_state_version: 41, state: self.state.clone(), reducer_version: 1, metadata: json!({}), events_applied: 0 })
    }

    fn commit(&self, _request: CommitRequest) -> StoreResult<CommitResult> {
        Err(StoreError::new("UNEXPECTED_COMMIT", "коммита быть не должно"))
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>> {
        self.lookups.set(self.lookups.get() + 1);
        Ok(Some(CommitResult {
            campaign_id: campaign_id.into(),
            state_version: 41,
            current_state_version: 41,
            state: self.state.clone(),
            metadata: json!({}),
            events: vec![json!({ "event_type": "TurnEnded", "actor_id": "wolf", "payload": { "round": 1 } })],
            duplicate: true,
            idempotency_key: key.into(),
            command_id: key.into(),
        }))
    }
}

impl NpcTurnJournal for DuplicateJournal {}

#[test]
fn scheduler_exits_a_duplicate_commit_without_progress() {
    let mut state = fixture();
    state["state_version"] = json!(41);
    state["mechanics"]["combat"]["initiative"] = json!([{ "actor_id": "wolf", "total": 20 }, { "actor_id": "hero", "total": 10 }]);
    state["mechanics"]["combat"]["active_index"] = json!(0);
    state["mechanics"]["combat"]["combat_instance_id"] = json!("combat-started:duplicate");
    let journal = DuplicateJournal { state, lookups: Cell::new(0) };
    let engine = dice(&[]);
    let mut options = run("NPC-DUPLICATE", &journal, &engine, None);
    options.max_turns = 4;
    let result = block_on(run_npc_turn_scheduler(options)).expect("планировщик");
    assert_eq!(journal.lookups.get(), 1);
    assert!(result.turns.is_empty());
    assert_eq!(result.state_version, 41);
}

#[test]
fn scheduler_moves_attacks_and_returns_control_to_a_living_hero() {
    let mut state = fixture();
    state["mechanics"]["combat"]["active_index"] = json!(1);
    let journal = store();
    initialize(&journal, "NPC-UNIT", state);
    let engine = dice(&[15, 3]);
    let controller = FixedController { calls: Cell::new(0), decision: json!({ "disposition": "surrender", "provider": "test" }) };
    let result = block_on(run_npc_turn_scheduler(run("NPC-UNIT", &journal, &engine, Some(&controller)))).expect("планировщик");
    assert_eq!(controller.calls.get(), 0, "вне момента морали контроллер не зовётся");
    assert_eq!(result.turns.len(), 1);
    assert_eq!(result.turns[0]["commands"], json!(["MoveActor", "MakeAttack", "EndTurn"]));
    assert_eq!(result.turns[0]["tactic"], json!("сокращает дистанцию"));
    assert_eq!(result.turns[0]["target_id"], json!("hero"));
    assert_eq!((result.state["enemies"][0]["x"].clone(), result.state["enemies"][0]["y"].clone()), (json!(1), json!(1)));
    assert_eq!(result.state["players"][0]["hp"], json!(26));
    assert_eq!(result.state["activePlayerId"], json!("hero"));
    let wolf: Vec<Value> = result.events.iter().filter(|event| event["actor_id"] == json!("wolf")).cloned().collect();
    assert_eq!(event_types(&wolf), ["CombatRoundTimeMarked", "ActorMoved", "AttackResolved", "DieRolled", "DamageApplied", "TurnEnded", "TimeAdvanced", "TurnStarted"]);
    assert_eq!(sk_rules::world_clock::world_time_seconds(&result.state), 6.0);
}

#[test]
fn morale_controller_is_called_once_and_surrender_is_applied() {
    let mut state = fixture();
    state["mechanics"]["combat"]["active_index"] = json!(1);
    state["enemies"][0]["hp"] = json!(5);
    let journal = store();
    initialize(&journal, "NPC-MORALE", state);
    let engine = dice(&[]);
    let controller = FixedController { calls: Cell::new(0), decision: json!({ "disposition": "surrender", "reaction": "Волк прижимается к земле.", "provider": "fake-agent" }) };
    let result = block_on(run_npc_turn_scheduler(run("NPC-MORALE", &journal, &engine, Some(&controller)))).expect("планировщик");
    assert_eq!(controller.calls.get(), 1);
    assert_eq!(result.turns[0]["commands"], json!(["AddCondition"]));
    assert_eq!(result.turns[0]["creative_decision"]["disposition"], json!("surrender"));
    assert_eq!(result.state["enemies"][0]["alive"], json!(false));
    assert_eq!(result.state["mechanics"]["combat"]["active"], json!(false));
    assert!(result.events.iter().any(|event| event["event_type"] == json!("ConditionAdded") && event["payload"]["condition"] == json!("surrendered")));
}

/// Движок, отвергающий бегство (`RejectingFleeEngine` теста JS).
struct RejectingFlee(RefCell<RulesEngine>);

impl NpcRulesEngine for RejectingFlee {
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, Halt> {
        if commands.iter().any(|command| command["command_type"] == json!("AddCondition") && command["condition"] == json!("fled")) {
            return Err(sk_rules::pause::rule("Недостаточно скорости для этого перемещения", "SPEED_EXCEEDED"));
        }
        self.0.resolve_plan(commands, state, context)
    }
}

#[test]
fn a_rejected_morale_plan_falls_back_to_an_ordinary_turn() {
    let mut state = fixture();
    state["sessionCode"] = json!("NPC-CORNERED");
    state["mechanics"]["combat"]["active_index"] = json!(1);
    state["enemies"][0]["hp"] = json!(5);
    state["enemies"][0]["speed"] = json!(30);
    let journal = store();
    initialize(&journal, "NPC-CORNERED", state);
    let engine = RejectingFlee(bounded());
    let controller = FixedController { calls: Cell::new(0), decision: json!({ "disposition": "flee", "reaction": "Волк пятится.", "provider": "fake-agent" }) };
    let result = block_on(run_npc_turn_scheduler(run("NPC-CORNERED", &journal, &engine, Some(&controller)))).expect("планировщик");
    assert_eq!(controller.calls.get(), 1, "после отказа модель о том же существе не спрашивают");
    let turn = result.turns.iter().find(|turn| turn["actor_id"] == json!("wolf")).expect("ход волка");
    assert_eq!(turn["creative_decision"]["disposition"], json!("flee"));
    assert_eq!(turn["creative_decision"]["rejected"], json!("SPEED_EXCEEDED"));
    assert_eq!(turn["creative_decision"]["applied"], json!("fight"));
    assert_eq!(turn["tactic"], json!("загнан в угол"));
    assert!(js::s(turn.get("idempotency_key")).starts_with("npc:"));
    let wolf_conditions = result.state["mechanics"]["conditions"]["wolf"].as_array().cloned().unwrap_or_default();
    assert!(wolf_conditions.iter().any(|condition| condition["id"] == json!("morale-tested")));
    assert!(!wolf_conditions.iter().any(|condition| condition["id"] == json!("fled")));
    assert_eq!(result.state["activePlayerId"], json!("hero"), "ход вернулся герою — бой не встал");
}

#[test]
fn a_large_creature_approaches_a_target_whose_cell_cannot_hold_it() {
    let mut state = fixture();
    let mut scene = cells(10, 5);
    scene.extend([5, 6, 7].map(|y| json!({ "x": 5, "y": y, "type": "floor", "revealed": true })));
    state["scene"]["cells"] = Value::Array(scene);
    state["players"][0]["x"] = json!(5);
    state["players"][0]["y"] = json!(5);
    state["mechanics"]["positions"]["hero"] = json!({ "x": 5, "y": 5 });
    let wolf = js::spread(&state["enemies"][0], json!({ "name": "Бурый медведь", "size": "large", "footprint": { "version": 1, "size": 2 }, "speed": 40, "x": 1, "y": 1 }));
    state["enemies"][0] = wolf;
    state["mechanics"]["positions"]["wolf"] = json!({ "x": 1, "y": 1 });
    state["mechanics"]["combat"]["active_index"] = json!(1);
    let commands = plan_npc_turn(&state, "wolf").expect("план");
    assert_eq!(event_types_of_commands(&commands), ["MoveActor", "MakeAttack", "EndTurn"]);
    let proposed: Vec<Value> = commands.iter().enumerate().map(|(index, command)| js::spread(command, json!({ "server_authoritative": true, "command_id": format!("large-{index}") }))).collect();
    let resolved = bounded().resolve_plan(&proposed, &state, &json!({ "isAdmin": true, "isNpcScheduler": true, "serverAuthoritativeCombat": true })).expect("движок");
    let events = resolved["events"].as_array().cloned().unwrap_or_default();
    assert!(events.iter().any(|event| event["event_type"] == json!("ActorMoved")));
    assert!(events.iter().any(|event| event["event_type"] == json!("AttackResolved") && event["payload"]["target_id"] == json!("hero")));
}

fn event_types_of_commands(commands: &[Value]) -> Vec<String> {
    commands.iter().map(|command| js::s(command.get("command_type"))).collect()
}

#[test]
fn a_fallen_companion_outside_the_initiative_does_not_hold_combat_open() {
    let mut state = fixture();
    state["partyMemberIds"] = json!(["hero", "companion"]);
    state["players"][0]["hp"] = json!(0);
    let companion = js::spread(&state["players"][0], json!({ "id": "companion", "character": "Спутник", "hp": 0, "characterSetupRequired": true, "x": 0, "y": 0 }));
    state["players"].as_array_mut().expect("герои").push(companion);
    state["mechanics"]["positions"]["companion"] = json!({ "x": 0, "y": 0 });
    state["mechanics"]["conditions"]["hero"] = json!([{ "id": "unconscious" }]);
    state["mechanics"]["conditions"]["companion"] = json!([{ "id": "unconscious" }]);
    state["mechanics"]["death"] = json!({ "campaign_status": "active", "heroes": {}, "saving_throws": {
        "hero": { "successes": 3, "failures": 0, "stable": true },
        "companion": { "successes": 0, "failures": 0, "stable": false },
    } });
    state["mechanics"]["combat"]["active_index"] = json!(1);
    let journal = store();
    initialize(&journal, "NPC-UNQUEUED-DYING", state);
    let engine = bounded();
    let mut options = run("NPC-UNQUEUED-DYING", &journal, &engine, None);
    options.max_turns = 12;
    let result = block_on(run_npc_turn_scheduler(options)).expect("планировщик");
    assert_eq!(result.state["mechanics"]["combat"]["active"], json!(false), "бой закончен, а не упёрся в предел ходов");
    let ended = result.events.iter().find(|event| event["event_type"] == json!("CombatEnded")).expect("CombatEnded");
    assert_eq!(ended["payload"]["reason"], json!("party_incapacitated"));
}

#[test]
fn scheduler_closes_combat_when_the_last_enemy_is_defeated() {
    let mut state = fixture();
    state["enemies"][0]["hp"] = json!(0);
    state["enemies"][0]["alive"] = json!(false);
    let journal = store();
    initialize(&journal, "NPC-TERMINAL", state);
    let engine = dice(&[]);
    let mut options = run("NPC-TERMINAL", &journal, &engine, None);
    options.advance_npc = false;
    let result = block_on(run_npc_turn_scheduler(options)).expect("планировщик");
    assert_eq!(result.state["mechanics"]["combat"]["active"], json!(false));
    assert_eq!(result.turns[0]["kind"], json!("combat-end"));
    assert_eq!(result.turns[0]["reason"], json!("enemies_defeated"));
    assert_eq!(result.events.last().map(|event| event["event_type"].clone()), Some(json!("CombatEnded")));
}

#[test]
fn a_knocked_out_enemy_at_one_hit_point_counts_as_defeated() {
    let mut state = fixture();
    state["enemies"][0]["hp"] = json!(1);
    state["mechanics"]["conditions"]["wolf"] = json!([{ "id": "unconscious" }]);
    state["mechanics"]["resting"]["wolf"] = json!({ "kind": "short", "reason": "knockout", "recovery_minutes_remaining": 60 });
    let journal = store();
    initialize(&journal, "NPC-KNOCKOUT", state);
    let engine = dice(&[]);
    let mut options = run("NPC-KNOCKOUT", &journal, &engine, None);
    options.advance_npc = false;
    let result = block_on(run_npc_turn_scheduler(options)).expect("планировщик");
    assert_eq!(result.turns[0]["reason"], json!("enemies_defeated"));
    assert_eq!(result.state["enemies"][0]["hp"], json!(1));
    assert_eq!(result.state["enemies"][0]["alive"], json!(true));
    assert_eq!(result.state["mechanics"]["resting"]["wolf"]["reason"], json!("knockout"));
}

#[test]
fn scheduler_closes_combat_as_party_defeated() {
    let mut state = fixture();
    state["players"][0]["hp"] = json!(0);
    state["players"][0]["alive"] = json!(false);
    state["mechanics"]["death"]["heroes"]["hero"] = json!({ "status": "dead" });
    state["mechanics"]["death"]["campaign_status"] = json!("party_defeated");
    let journal = store();
    initialize(&journal, "NPC-PARTY-DEFEATED", state);
    let engine = dice(&[]);
    let result = block_on(run_npc_turn_scheduler(run("NPC-PARTY-DEFEATED", &journal, &engine, None))).expect("планировщик");
    assert_eq!(result.turns[0]["kind"], json!("combat-end"));
    assert_eq!(result.turns[0]["reason"], json!("party_defeated"));
}

#[test]
fn death_saves_end_combat_and_a_stable_party_wakes_after_hours() {
    let mut state = fixture();
    state["players"][0]["hp"] = json!(0);
    state["enemies"][0]["hp"] = json!(0);
    state["enemies"][0]["alive"] = json!(false);
    state["mechanics"]["conditions"]["hero"] = json!([{ "id": "unconscious" }]);
    state["mechanics"]["death"]["saving_throws"]["hero"] = json!({ "successes": 0, "failures": 0, "stable": false });
    let journal = store();
    initialize(&journal, "NPC-DEATH-SAVES", state);
    let engine = dice(&[10, 10, 10, 3]);
    let result = block_on(run_npc_turn_scheduler(run("NPC-DEATH-SAVES", &journal, &engine, None))).expect("планировщик");
    assert_eq!(result.state["mechanics"]["combat"]["active"], json!(false));
    assert_eq!(result.turns.iter().find(|turn| turn["kind"] == json!("combat-end")).map(|turn| turn["reason"].clone()), Some(json!("enemies_defeated")));
    assert_eq!(result.turns.iter().filter(|turn| turn["kind"] == json!("stable-recovery")).count(), 3);
    assert_eq!(result.state["players"][0]["hp"], json!(1));
    assert_eq!(result.events.iter().filter(|event| event["event_type"] == json!("DeathSavingThrowRolled")).count(), 3);
    assert_eq!(sk_rules::world_clock::world_time_seconds(&result.state), 10_818.0);
    let replayed = Journal::load(&journal, "NPC-DEATH-SAVES").expect("загрузка");
    assert_eq!(replayed.state["mechanics"]["death"], result.state["mechanics"]["death"]);
}

#[test]
fn stable_recovery_is_not_fast_forwarded_while_enemies_hold_the_field() {
    let mut state = fixture();
    state["players"][0]["hp"] = json!(0);
    state["mechanics"]["conditions"]["hero"] = json!([{ "id": "unconscious" }]);
    state["mechanics"]["death"]["saving_throws"]["hero"] = json!({ "successes": 0, "failures": 0, "stable": false });
    let journal = store();
    initialize(&journal, "NPC-HOSTILE-INCAPACITATION", state);
    let engine = dice(&[10, 10, 10]);
    let result = block_on(run_npc_turn_scheduler(run("NPC-HOSTILE-INCAPACITATION", &journal, &engine, None))).expect("планировщик");
    assert_eq!(result.turns.iter().find(|turn| turn["kind"] == json!("combat-end")).map(|turn| turn["reason"].clone()), Some(json!("party_incapacitated")));
    assert!(!result.turns.iter().any(|turn| turn["kind"] == json!("stable-recovery")));
    assert_eq!(sk_rules::world_clock::world_time_seconds(&result.state), 18.0);
    assert_eq!(result.state["mechanics"]["death"]["saving_throws"]["hero"], json!({ "successes": 0, "failures": 0, "stable": true }));
}

#[test]
fn scheduler_pauses_while_a_player_reaction_is_pending() {
    let mut state = fixture();
    state["mechanics"]["combat"]["active_index"] = json!(1);
    state["mechanics"]["combat"]["reaction_window"] = json!({
        "id": "reaction:test", "trigger": "enemy-left-reach", "actor_id": "hero", "source_actor_id": "wolf",
        "target_id": "wolf", "action_ids": ["opportunity-attack"], "action_options": [],
    });
    let journal = store();
    initialize(&journal, "NPC-REACTION-PAUSE", state);
    let engine = dice(&[]);
    let result = block_on(run_npc_turn_scheduler(run("NPC-REACTION-PAUSE", &journal, &engine, None))).expect("планировщик");
    assert!(result.turns.is_empty() && result.events.is_empty());
    assert_eq!(result.state_version, 0);
    assert_eq!(result.state["mechanics"]["combat"]["reaction_window"]["id"], json!("reaction:test"));
}

#[test]
fn max_turns_outside_its_range_is_a_range_error() {
    let journal = store();
    let engine = dice(&[]);
    let mut options = run("NPC-RANGE", &journal, &engine, None);
    options.max_turns = 0;
    assert!(matches!(block_on(run_npc_turn_scheduler(options)), Err(SchedulerError::Range(_))));
}

// --- координатор -------------------------------------------------------------------------

/// `fixture()` из `test/combat-turn-coordinator.test.mjs`.
fn clock_fixture(active_actor: &str, group: bool) -> Value {
    let initiative = if active_actor == "wolf" { json!([{ "actor_id": "wolf", "total": 20 }, { "actor_id": "hero", "total": 10 }]) } else { json!([{ "actor_id": "hero", "total": 20 }, { "actor_id": "wolf", "total": 10 }]) };
    let conditions = if active_actor == "wolf" { json!({ "wolf": [{ "id": "stunned", "duration": "until-own-turn-end" }] }) } else { json!({}) };
    normalize_campaign_state(&json!({
        "sessionCode": "TURN-CLOCK",
        "partyMemberIds": ["hero"],
        "players": [{ "id": "hero", "character": "Ада", "hp": 20, "maxHp": 20, "armor": 14, "speed": 30, "abilities": { "str": 14, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 10 } }],
        "enemies": [{ "id": "wolf", "name": "Волк", "hp": 12, "maxHp": 12, "armor": 12, "speed": 40, "abilities": { "str": 12, "dex": 14, "con": 12, "int": 3, "wis": 12, "cha": 6 }, "alive": true }],
        "scene": { "turn": 1, "cells": [] },
        "mechanics": {
            "conditions": conditions,
            "combat": {
                "active": true, "round": 1, "active_index": 0, "initiative": initiative, "group_initiative": group, "turn_completed": [],
                "action_economy": {
                    "hero": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                    "wolf": { "action": true, "bonus_action": true, "reaction": true, "movement": true, "movement_spent": 0 },
                },
            },
        },
    }))
    .expect("нормализация")
}

fn record_turn_start(journal: &EventStore, campaign: &str, state: Value, actor: &str) {
    initialize(journal, campaign, state);
    journal
        .commit(CommitRequest {
            campaign_id: campaign.into(),
            expected_state_version: 0,
            idempotency_key: format!("start:{campaign}"),
            command_id: Some(format!("start:{campaign}")),
            events: vec![json!({ "event_type": "TurnStarted", "actor_id": actor, "target_ids": [actor], "payload": { "round": 1, "active_index": 0 }, "source_rule_ids": ["srd_5_2_1:combat/turns"], "visibility": "public" })],
            ..Default::default()
        })
        .expect("начало хода");
}

/// Хозяин координатора теста: часы, таймеры и журналы обратных вызовов.
#[derive(Default)]
struct TestHost {
    now: Cell<f64>,
    timers: RefCell<Vec<(u64, f64, TimerAction)>>,
    committed: RefCell<Vec<Vec<Value>>>,
    errors: RefCell<Vec<Option<String>>>,
    skip_npc: bool,
    unclaimed: bool,
    npc_calls: Cell<usize>,
}

impl CoordinatorHost for TestHost {
    fn now(&self) -> f64 {
        self.now.get()
    }

    fn set_timer(&self, delay_ms: f64, action: TimerAction) -> u64 {
        let id = self.timers.borrow().len() as u64 + 1;
        self.timers.borrow_mut().push((id, delay_ms, action));
        id
    }

    fn is_seat_unclaimed(&self, _campaign_id: &str, _state: &Value, _actor_ids: &[String]) -> bool {
        self.unclaimed
    }

    fn run_npc_turns<'a>(&'a self, _campaign_id: &'a str) -> Option<HostFuture<'a, Result<SchedulerResult, SchedulerError>>> {
        if !self.skip_npc {
            return None;
        }
        self.npc_calls.set(self.npc_calls.get() + 1);
        Some(Box::pin(async { Ok(SchedulerResult { state: Value::Null, state_version: 0, turns: Vec::new(), events: Vec::new() }) }))
    }

    fn on_committed(&self, _campaign_id: &str, _state: &Value, events: &[Value], _turns: Option<&[Value]>) {
        self.committed.borrow_mut().push(events.to_vec());
    }

    fn on_error(&self, error: &SchedulerError, _campaign_id: &str) {
        self.errors.borrow_mut().push(error.code().map(str::to_string));
    }
}

fn settings(timeout_ms: i64) -> CoordinatorSettings {
    CoordinatorSettings { timeout_ms: json!(timeout_ms), ..CoordinatorSettings::default() }
}

fn active_actor(state: &Value) -> Value {
    let combat = &state["mechanics"]["combat"];
    combat["initiative"][combat["active_index"].as_u64().unwrap_or(0) as usize]["actor_id"].clone()
}

#[test]
fn coordinator_finishes_the_npc_turn_and_opens_the_hero_clock() {
    let now = ms("2026-07-30T12:00:00.000Z");
    let journal = store_at(Arc::new(AtomicU64::new(now as u64)));
    record_turn_start(&journal, "NPC-PUSH", clock_fixture("wolf", false), "wolf");
    let host = TestHost { now: Cell::new(now as f64), ..TestHost::default() };
    let engine = dice(&[]);
    let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &settings(120_000));
    block_on(coordinator.settle_now("NPC-PUSH"));
    let loaded = Journal::load(&journal, "NPC-PUSH").expect("загрузка");
    assert_eq!(active_actor(&loaded.state), json!("hero"));
    assert!(host.committed.borrow().iter().flatten().any(|event| event["event_type"] == json!("TurnEnded") && event["actor_id"] == json!("wolf")));
    assert_eq!(coordinator.clock_for("NPC-PUSH").map(|clock| clock["actor_ids"].clone()), Some(json!(["hero"])));
    assert_eq!(host.timers.borrow().last().map(|timer| timer.1), Some(120_000.0));
    coordinator.close();
}

#[test]
fn an_expired_deadline_commits_one_replay_safe_auto_skip() {
    let start = ms("2026-07-30T12:00:00.000Z");
    let clock = Arc::new(AtomicU64::new(start as u64));
    let journal = store_at(clock.clone());
    record_turn_start(&journal, "TIMEOUT-REPLAY", clock_fixture("hero", false), "hero");
    clock.store((start + 30_000) as u64, Ordering::SeqCst);
    let host = TestHost { now: Cell::new((start + 30_000) as f64), skip_npc: true, ..TestHost::default() };
    let engine = dice(&[]);
    let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &settings(20_000));
    block_on(coordinator.settle_now("TIMEOUT-REPLAY"));
    block_on(coordinator.settle_now("TIMEOUT-REPLAY"));
    assert!(host.errors.borrow().is_empty());
    let events = journal.get_events("TIMEOUT-REPLAY", 0, None).expect("события");
    let skipped: Vec<&Value> = events.iter().filter(|event| event["event_type"] == json!("TurnEnded") && event["payload"]["auto_skipped"] == json!(true)).collect();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["payload"]["auto_skip_reason"], json!("turn-timeout"));
    let key = js::s(skipped[0].get("idempotency_key"));
    let parts: Vec<&str> = key.split(':').collect();
    assert_eq!(&parts[..4], ["turn-timeout", "TIMEOUT-REPLAY", "r1", "i0"], "{key}");
    assert!(parts[4].len() == 20 && parts[5].len() == 20, "{key}");
    let loaded = Journal::load(&journal, "TIMEOUT-REPLAY").expect("загрузка");
    assert_eq!(loaded.state["mechanics"]["combat"]["active_index"], json!(1));
}

/// Движок, падающий на первом разборе (`flakyEngine` теста JS).
struct FlakyEngine {
    inner: RefCell<RulesEngine>,
    attempts: Cell<usize>,
}

impl NpcRulesEngine for FlakyEngine {
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, Halt> {
        self.attempts.set(self.attempts.get() + 1);
        if self.attempts.get() == 1 {
            return Err(Halt::Fault(Fault::new("Error", "временная ошибка диска")));
        }
        self.inner.resolve_plan(commands, state, context)
    }
}

#[test]
fn an_ordinary_auto_skip_error_schedules_a_delayed_retry() {
    let start = ms("2026-07-30T12:00:00.000Z");
    let clock = Arc::new(AtomicU64::new(start as u64));
    let journal = store_at(clock.clone());
    record_turn_start(&journal, "RETRY-AFTER-ERROR", clock_fixture("hero", false), "hero");
    clock.store((start + 30_000) as u64, Ordering::SeqCst);
    let host = TestHost { now: Cell::new((start + 30_000) as f64), skip_npc: true, ..TestHost::default() };
    let engine = FlakyEngine { inner: dice(&[]), attempts: Cell::new(0) };
    let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &CoordinatorSettings { timeout_ms: json!(20_000), retry_base_delay_ms: json!(100), retry_max_delay_ms: json!(1_000), ..CoordinatorSettings::default() });
    block_on(coordinator.settle_now("RETRY-AFTER-ERROR"));
    assert_eq!(engine.attempts.get(), 1);
    assert_eq!(host.errors.borrow().len(), 1);
    assert_eq!(host.timers.borrow().len(), 1);
    assert_eq!(host.timers.borrow()[0].1, 100.0);
    let action = host.timers.borrow()[0].2.clone();
    coordinator.timer_fired(&action);
    block_on(coordinator.run_queued());
    assert_eq!(engine.attempts.get(), 2);
    let loaded = Journal::load(&journal, "RETRY-AFTER-ERROR").expect("загрузка");
    assert_eq!(loaded.state["mechanics"]["combat"]["active_index"], json!(1));
    assert_eq!(host.errors.borrow().len(), 1);
}

/// Журнал с вечным конфликтом версии на коммите.
struct ConflictingJournal<'a> {
    inner: &'a EventStore,
    commits: Cell<usize>,
}

impl Journal for ConflictingJournal<'_> {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        Journal::load(self.inner, campaign_id)
    }

    fn commit(&self, _request: CommitRequest) -> StoreResult<CommitResult> {
        self.commits.set(self.commits.get() + 1);
        Err(StoreError::new("STATE_VERSION_CONFLICT", "устойчивый конфликт"))
    }

    fn get_by_idempotency_key(&self, _campaign_id: &str, _key: &str) -> StoreResult<Option<CommitResult>> {
        Ok(None)
    }
}

impl NpcTurnJournal for ConflictingJournal<'_> {}

#[test]
fn a_version_conflict_retries_only_with_bounded_exponential_delay() {
    let start = ms("2026-07-30T12:00:00.000Z");
    let clock = Arc::new(AtomicU64::new(start as u64));
    let backing = store_at(clock.clone());
    record_turn_start(&backing, "CONFLICT-BACKOFF", clock_fixture("hero", false), "hero");
    let journal = ConflictingJournal { inner: &backing, commits: Cell::new(0) };
    let host = TestHost { now: Cell::new((start + 30_000) as f64), skip_npc: true, ..TestHost::default() };
    let engine = dice(&[]);
    let coordinator = CombatTurnCoordinator::new(
        &journal,
        &engine,
        None,
        &host,
        &CoordinatorSettings { timeout_ms: json!(20_000), retry_base_delay_ms: json!(100), retry_max_delay_ms: json!(400), retry_backoff_steps: json!(3), ..CoordinatorSettings::default() },
    );
    block_on(coordinator.settle_now("CONFLICT-BACKOFF"));
    assert_eq!(journal.commits.get(), 1);
    assert_eq!(coordinator.queued(), 0, "конфликт не запускает горячий цикл");
    for _ in 0..3 {
        let action = host.timers.borrow().last().map(|timer| timer.2.clone()).expect("таймер повтора");
        coordinator.timer_fired(&action);
        block_on(coordinator.run_queued());
    }
    assert_eq!(journal.commits.get(), 4);
    assert_eq!(host.timers.borrow().iter().map(|timer| timer.1).collect::<Vec<_>>(), [100.0, 200.0, 400.0, 400.0]);
    assert!(host.errors.borrow().is_empty(), "ожидаемые конфликты не засоряют журнал ошибок");
}

#[test]
fn an_unclaimed_hero_seat_gets_the_short_deadline() {
    let start = ms("2026-07-30T12:00:00.000Z");
    for (campaign, unclaimed, expected) in [("SEAT-FREE", true, 3_000.0), ("SEAT-TAKEN", false, 120_000.0)] {
        let journal = store_at(Arc::new(AtomicU64::new(start as u64)));
        record_turn_start(&journal, campaign, clock_fixture("hero", false), "hero");
        let host = TestHost { now: Cell::new(start as f64), skip_npc: true, unclaimed, ..TestHost::default() };
        let engine = dice(&[]);
        let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &settings(120_000));
        block_on(coordinator.settle_now(campaign));
        assert_eq!(host.timers.borrow().last().map(|timer| timer.1), Some(expected), "{campaign}");
        assert_eq!(coordinator.clock_for(campaign).map(|clock| clock["duration_ms"].clone()), Some(json!(expected as i64)));
    }
}

#[test]
fn owner_activity_extends_the_deadline_up_to_the_ceiling() {
    let mut state = clock_fixture("hero", false);
    state["mechanics"]["combat"]["turn_started_at"] = json!("2026-07-30T12:00:00.000Z");
    let at = |activity: Option<&str>| {
        let options = ClockOptions { timeout_ms: json!(60_000), now: ms("2026-07-30T12:00:50.000Z") as f64, previous_clock: None, activity_at: activity.map(|iso| json!(iso)) };
        combat_turn_clock(&state, &[], &options).expect("часы").expect("часы есть")
    };
    assert_eq!(at(None)["deadline_at"], json!("2026-07-30T12:01:00.000Z"));
    assert!(at(None).get("activity_at").is_none(), "без действия часы прежние");
    assert_eq!(at(Some("2026-07-30T12:00:50.000Z"))["deadline_at"], json!("2026-07-30T12:01:50.000Z"));
    assert_eq!(at(Some("2026-07-30T12:02:30.000Z"))["deadline_at"], json!("2026-07-30T12:03:00.000Z"), "потолок — {ACTIVE_TURN_LIMIT_FACTOR} срока");
}

#[test]
fn only_the_clock_owner_economy_changes_the_activity_key() {
    let state = clock_fixture("hero", false);
    let before = turn_activity_key(&state).expect("отпечаток");
    let mut wolf_acted = state.clone();
    wolf_acted["mechanics"]["combat"]["action_economy"]["wolf"]["action"] = json!(false);
    assert_eq!(turn_activity_key(&wolf_acted).expect("отпечаток"), before);
    let mut hero_moved = state;
    hero_moved["mechanics"]["combat"]["action_economy"]["hero"]["movement_spent"] = json!(15);
    assert_ne!(turn_activity_key(&hero_moved).expect("отпечаток"), before);
}

/// Журнал из одного изменяемого состояния (`eventStore: { load }` теста JS).
struct CurrentJournal {
    current: RefCell<(Value, i64)>,
}

impl Journal for CurrentJournal {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        let (state, version) = self.current.borrow().clone();
        Ok(Loaded { campaign_id: campaign_id.into(), state_version: version, current_state_version: version, state, reducer_version: 1, metadata: json!({}), events_applied: 0 })
    }

    fn commit(&self, _request: CommitRequest) -> StoreResult<CommitResult> {
        Err(StoreError::new("UNEXPECTED_COMMIT", "коммита быть не должно"))
    }

    fn get_by_idempotency_key(&self, _campaign_id: &str, _key: &str) -> StoreResult<Option<CommitResult>> {
        Ok(None)
    }
}

impl NpcTurnJournal for CurrentJournal {}

#[test]
fn coordinator_extends_the_deadline_after_the_hero_acts() {
    let start = ms("2026-07-30T12:00:00.000Z") as f64;
    let mut state = clock_fixture("hero", false);
    state["mechanics"]["combat"]["turn_started_at"] = json!("2026-07-30T12:00:00.000Z");
    state["mechanics"]["combat"]["turn_started_event_id"] = json!("turn-start");
    let journal = CurrentJournal { current: RefCell::new((state.clone(), 1)) };
    let host = TestHost { now: Cell::new(start), skip_npc: true, ..TestHost::default() };
    let engine = dice(&[]);
    let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &settings(120_000));
    block_on(coordinator.settle_now("ACTIVE-HERO"));
    assert_eq!(host.timers.borrow().last().map(|timer| timer.1), Some(120_000.0));
    host.now.set(start + 100_000.0);
    let mut moved = state;
    moved["mechanics"]["combat"]["action_economy"]["hero"]["movement_spent"] = json!(10);
    *journal.current.borrow_mut() = (moved.clone(), 2);
    block_on(coordinator.settle_now("ACTIVE-HERO"));
    assert_eq!(host.timers.borrow().last().map(|timer| timer.1), Some(120_000.0));
    assert_eq!(coordinator.clock_for("ACTIVE-HERO").map(|clock| clock["activity_at"].clone()), Some(json!(sk_core::clock::iso((start + 100_000.0) as i64))));
    host.now.set(start + 130_000.0);
    *journal.current.borrow_mut() = (moved, 3);
    block_on(coordinator.settle_now("ACTIVE-HERO"));
    assert_eq!(host.timers.borrow().last().map(|timer| timer.1), Some(90_000.0));
}

fn hold_journal() -> CurrentJournal {
    CurrentJournal { current: RefCell::new((normalize_campaign_state(&json!({ "players": [], "enemies": [], "mechanics": {} })).expect("состояние"), 1)) }
}

#[test]
fn a_hold_delays_autoplay_until_released() {
    let journal = hold_journal();
    let host = TestHost { skip_npc: true, ..TestHost::default() };
    let engine = dice(&[]);
    let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &CoordinatorSettings::default());
    let release = coordinator.hold("hold-camp", None);
    coordinator.nudge("HOLD-CAMP");
    let mut pending = Box::pin(coordinator.run_queued());
    assert!(poll_once(&mut pending).is_none());
    assert_eq!(host.npc_calls.get(), 0, "пока ход идёт к летописи, координатор не играет за NPC");
    coordinator.release(&release);
    assert!(poll_once(&mut pending).is_some());
    assert_eq!(host.npc_calls.get(), 1, "после отпускания автоход продолжается");
    drop(pending);
    coordinator.release(&release);
    coordinator.nudge("HOLD-CAMP");
    block_on(coordinator.run_queued());
    assert_eq!(host.npc_calls.get(), 2, "повторное отпускание ничего не держит");
    coordinator.close();
}

#[test]
fn a_forgotten_hold_is_released_by_its_limit() {
    let journal = hold_journal();
    let host = TestHost { skip_npc: true, ..TestHost::default() };
    let engine = dice(&[]);
    let coordinator = CombatTurnCoordinator::new(&journal, &engine, None, &host, &CoordinatorSettings::default());
    coordinator.hold("stuck-camp", Some(&json!(500)));
    coordinator.nudge("stuck-camp");
    let mut pending = Box::pin(coordinator.run_queued());
    assert!(poll_once(&mut pending).is_none());
    assert_eq!(host.npc_calls.get(), 0);
    let limit = host.timers.borrow().iter().find(|timer| timer.1 == 500.0).map(|timer| timer.2.clone()).expect("у удержания есть предел");
    coordinator.timer_fired(&limit);
    assert!(poll_once(&mut pending).is_some());
    assert_eq!(host.npc_calls.get(), 1, "по пределу автоход идёт сам");
}
