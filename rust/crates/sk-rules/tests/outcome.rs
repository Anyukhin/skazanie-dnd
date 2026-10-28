//! Итог разбора на границе API (урок 5 плана переноса): ожидание решения —
//! [`Outcome::Pending`] с [`Prompt`], а не пауза-ошибка.
//!
//! Разборы берутся из эталонов Р8 (атаки: «Щит», «Оборона», «Острое
//! словцо», удар вдогонку) и Р10 (`UseCombatAction`, `MoveActor`, `EndTurn`
//! и цепочки «окно → ответ»). Эталон здесь не сверяется — это делают `r8.rs`
//! и `r10.rs`; проверяется, что тип итога согласован с событиями.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::{Continuation, Deadline, Outcome, Prompt};
use sk_rules::pause::{Pause, ProtectiveReactionArgs};
use sk_rules::resolve::api;

fn gunzip(bytes: &[u8]) -> Value {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
}

static R8: LazyLock<Value> = LazyLock::new(|| gunzip(include_bytes!("../fixtures/r8.json.gz")));
static R10: LazyLock<Value> = LazyLock::new(|| gunzip(include_bytes!("../fixtures/r10.json.gz")));

const U: &str = "__undefined__";

/// `undefined` эталона: поле объекта выпадает, элемент массива — `null` (Р8).
fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|item| if item.as_str() == Some(U) { Value::Null } else { deep(item) }).collect()),
        other => other.clone(),
    }
}

/// Кости генераторов: Р8 — по кругу с приведением через остаток, Р10 — так же
/// без отрицательных значений.
struct CycleRng {
    values: Vec<i64>,
    index: usize,
}

impl Rng for CycleRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        let value = self.values.get(self.index % self.values.len().max(1)).copied().unwrap_or(1);
        self.index += 1;
        Ok(minimum + (value - 1).rem_euclid(maximum - minimum + 1))
    }
}

fn dice(values: &Value) -> ServiceDice<DiceService<CycleRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(CycleRng { values, index: 0 }, "roll"))
}

fn event_type(event: &Value) -> &str {
    event.get("event_type").and_then(Value::as_str).unwrap_or("")
}

#[derive(Default)]
struct Tally {
    committed: usize,
    pending: usize,
    replay: usize,
    ally: usize,
}

/// Итог разбора согласован с его событиями.
fn check(outcome: &Outcome, label: &str, tally: &mut Tally) {
    let events = &outcome.resolved().events;
    let opened: Vec<&Value> = events.iter().filter(|event| event_type(event) == "ReactionWindowOpened").map(|event| &event["payload"]).collect();
    match outcome {
        Outcome::Committed(_) => tally.committed += 1,
        Outcome::Pending { prompt, .. } => {
            tally.pending += 1;
            let window = opened.iter().rev().find(|payload| js::s(payload.get("id")) == prompt.window_id).unwrap_or_else(|| panic!("{label}: ожидание без своего окна в событиях"));
            assert_eq!(prompt.reactor, js::s(window.get("actor_id")), "{label}: реагирующий — actor_id окна");
            assert_eq!(*prompt, Prompt::from_window(window), "{label}: ожидание — окно словами типа");
            assert_eq!(prompt.reactors().first().copied(), Some(prompt.reactor.as_str()), "{label}: первым отвечает реагирующий окна");
            if matches!(prompt.resume, Continuation::Replay { .. }) {
                tally.replay += 1;
            }
            if prompt.target.as_deref().is_some_and(|target| target != prompt.reactor) {
                tally.ally += 1;
            }
        }
    }
    if opened.is_empty() {
        assert!(!outcome.is_pending(), "{label}: без открытого окна ждать нечего");
    }
}

#[test]
fn outcome_follows_reaction_windows() {
    let mut tally = Tally::default();
    for case in R8["resolves"].as_array().expect("разборы Р8") {
        let raw = &R8["states"][case["s"].as_u64().expect("состояние") as usize];
        let input = deep(&case["input"]);
        let context = Context::from_json(&deep(&case["context"]));
        let mut dice = dice(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        if let Ok(outcome) = api::with_lenient_validation(|| api::resolve_command(&input, raw, &mut dice, &context, &mut uuid)) {
            check(&outcome, &format!("Р8 {}", input["command_id"]), &mut tally);
        }
    }
    for case in R10["resolves"].as_array().expect("разборы Р10") {
        let raw = &R10["states"][case["s"].as_u64().expect("состояние") as usize];
        let input = deep(&case["input"]);
        let context = Context::from_json(&case["context"]);
        let mut dice = dice(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        if let Ok(outcome) = api::with_lenient_validation(|| api::resolve_command(&input, raw, &mut dice, &context, &mut uuid)) {
            check(&outcome, &format!("Р10 {} {}", input["command_type"], input["action_id"]), &mut tally);
        }
    }
    eprintln!("итоги: исполнено {}, ждут {} (остановленных команд {}, решает союзник цели {})", tally.committed, tally.pending, tally.replay, tally.ally);
    assert!(tally.committed > 0 && tally.pending > 0, "в эталонах есть оба исхода");
    assert!(tally.replay > 0, "пауза посреди действия приходит итогом Pending");
    assert!(tally.ally > 0, "окно союзной реакции называет реагирующим союзника");
}

#[test]
fn plan_reports_window_it_stopped_on() {
    let mut pending = 0;
    for case in R10["resolves"].as_array().expect("разборы Р10") {
        let raw = &R10["states"][case["s"].as_u64().expect("состояние") as usize];
        let input = deep(&case["input"]);
        let context = Context::from_json(&case["context"]);
        let mut single = dice(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let Ok(outcome) = api::with_lenient_validation(|| api::resolve_command(&input, raw, &mut single, &context, &mut uuid)) else { continue };
        let mut planned = dice(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let Ok(plan) = api::with_lenient_validation(|| api::resolve_commands(std::slice::from_ref(&input), raw, &mut planned, &context, false, &mut uuid)) else { continue };
        // План из одной команды — та же команда: то же ожидание.
        if plan.events == outcome.resolved().events {
            assert_eq!(plan.pending.as_ref(), outcome.prompt(), "план {}", input["command_type"]);
            pending += usize::from(plan.pending.is_some());
        }
    }
    assert!(pending > 0, "план встаёт на окне и называет его");
}

/// «Оборона» и «Острое словцо»: окно — союзнику цели, тем же типом.
#[test]
fn prompt_names_ally_of_target_as_reactor() {
    let command = json!({ "command_type": "MakeAttack", "command_id": "attack-1", "actor_id": "goblin", "target_id": "hero-a" });
    let options = json!([{ "id": "protection", "name": "Защита", "resource": null, "cost": 1, "reactor_id": "hero-b" }]);
    let transcript = vec![json!({ "method": "rollD20", "args": [], "result": { "kept": 14 } })];
    let pause = Pause::protective_reaction(&ProtectiveReactionArgs {
        command: &command,
        target_id: &json!("hero-a"),
        reactor_id: Some(&json!("hero-b")),
        source_actor_id: Some(&json!("goblin")),
        trigger: &json!("attack-protection-choice"),
        kind: &json!("protection"),
        decision_key: Some(&json!("protection:attack-1:hero-a")),
        action_options: &options,
        trigger_roll: None,
        damage: None,
        dice_transcript: &transcript,
        choices: None,
        resistance_choices: None,
        elemental_choices: None,
    });
    let prompt = Prompt::from_window(&pause.window_event["payload"]);
    assert_eq!(prompt.reactor, "hero-b");
    assert_eq!(prompt.target.as_deref(), Some("hero-a"));
    assert_eq!(prompt.source.as_deref(), Some("goblin"));
    assert_eq!(prompt.trigger, "attack-protection-choice");
    assert_eq!(prompt.options.len(), 1);
    assert_eq!(prompt.options[0].id, "protection");
    assert_eq!(prompt.options[0].reactor, "hero-b");
    assert_eq!(prompt.reactors(), vec!["hero-b"]);
    assert!(!prompt.free_choice);
    assert_eq!(prompt.deadline, Deadline::TurnClock);
    match &prompt.resume {
        Continuation::Replay { command: pending, dice_transcript, .. } => {
            assert_eq!(pending, &command);
            assert_eq!(dice_transcript, &transcript);
        }
        other => panic!("остановленная атака продолжается повтором, а не {other:?}"),
    }
}

/// Варианты разных реагирующих в одном окне и окна без остановленной команды.
#[test]
fn prompt_options_and_continuations() {
    let window = json!({
        "id": "reaction:attack-2",
        "trigger": "spell-attack-hit",
        "actor_id": "hero-a",
        "target_id": "hero-a",
        "source_actor_id": "mage",
        "action_options": [
            { "id": "cast:shield", "cost": 1 },
            { "id": "cast:silvery-barbs", "cost": 1, "reactor_id": "hero-c" }
        ]
    });
    let prompt = Prompt::from_window(&window);
    assert_eq!(prompt.resume, Continuation::Answer);
    assert_eq!(prompt.options[0].reactor, "hero-a");
    assert_eq!(prompt.options[1].reactor, "hero-c");
    assert_eq!(prompt.reactors(), vec!["hero-a", "hero-c"]);

    let counterspell = json!({
        "id": "reaction:cast-1:counterspell",
        "trigger": "spell-cast",
        "actor_id": "hero-b",
        "target_id": "mage",
        "pending_spell_command": { "command_type": "CastSpell", "command_id": "cast-1" }
    });
    assert_eq!(Prompt::from_window(&counterspell).resume, Continuation::Spell { command: json!({ "command_type": "CastSpell", "command_id": "cast-1" }) });

    let resistance = json!({ "id": "resistance:save-1:abc", "trigger": "saving-throw-bonus-choice", "free_choice": true, "actor_id": "hero-a" });
    let prompt = Prompt::from_window(&resistance);
    assert!(prompt.free_choice);
    assert_eq!(prompt.target, None);
}
