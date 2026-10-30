//! Сверка `adjudicator` и `party_tactics` с эталонами JS
//! (`fixtures/gen-t2.mjs` → `fixtures/t2.json.gz`): вызовы из тестов JS,
//! боевые состояния корпуса с вариантами и заявки `createPlan`. Плюс
//! свойство «план автотактики принимается движком»: команда шага проходит
//! `validate` Rust-движка на той же технической копии, а исполнение плана
//! (`resolveCommand`/`resolvePlan`, кости `fixedDice(10)`) даёт тот же исход,
//! что у движка JS.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceService, FixedRng};
use sk_rules::context::Context;
use sk_rules::dice_record::ServiceDice;
use sk_rules::pause::Halt;
use sk_rules::resolve::api::{resolve_command, validate, RulesEngine};
use sk_tactics::{adjudicator, party_tactics};

struct Fixture {
    states: Vec<Value>,
    cases: Vec<Value>,
}

static FIXTURE: LazyLock<Fixture> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/t2.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    let mut root: Value = serde_json::from_str(&text).expect("эталон JSON");
    let states = root.get_mut("states").map(Value::take).and_then(|value| if let Value::Array(items) = value { Some(items) } else { None }).expect("states");
    let cases = root.get_mut("cases").map(Value::take).and_then(|value| if let Value::Array(items) = value { Some(items) } else { None }).expect("cases");
    Fixture { states, cases }
});

/// Аргумент со ссылкой `{ "$state": i }` → само состояние.
fn resolve_ref(value: &Value) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$state") => {
            let index = map.get("$state").and_then(Value::as_u64).expect("индекс состояния") as usize;
            FIXTURE.states[index].clone()
        }
        Value::Object(map) => Value::Object(map.iter().map(|(key, field)| (key.clone(), resolve_ref(field))).collect()),
        other => other.clone(),
    }
}

fn args_of(case: &Value) -> Vec<Value> {
    case.get("a").and_then(Value::as_array).map(|items| items.iter().map(resolve_ref).collect()).unwrap_or_default()
}

fn outcome(result: Result<Value, Halt>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Halt::Fault(fault)) => json!({ "fault": fault.name }),
    }
}

/// Вызов Rust по имени функции JS.
fn run(f: &str, args: &[Value]) -> Value {
    let arg = |index: usize| args.get(index);
    let id = |index: usize| js::s(arg(index));
    match f {
        "healingTargetFor" => outcome(party_tactics::healing_target_for(&args[0], &id(1)).map(|found| found.unwrap_or(Value::Null))),
        "planHeroTurn" => outcome(party_tactics::plan_hero_turn(&args[0], &id(1)).map(|plan| plan.to_json())),
        "planHeroReaction" => outcome(Ok(party_tactics::plan_hero_reaction(&args[0], arg(1)).to_json())),
        "planHeroCombatCommand" => outcome(party_tactics::plan_hero_combat_command(&args[0], &id(1)).map(|step| step.to_json())),
        "difficultyCategoryFor" => {
            let state = arg(1).cloned().unwrap_or_else(|| json!({}));
            outcome(Ok(Value::String(adjudicator::difficulty_category_for(arg(0).filter(|value| !value.is_null()), &state).into())))
        }
        "createPlan" => {
            let input = arg(0);
            let state = input.and_then(|input| input.get("state")).cloned().unwrap_or(Value::Null);
            let intent = input.and_then(|input| input.get("intent")).filter(|value| !value.is_null());
            let rules = input.and_then(|input| input.get("retrievedRules")).filter(|value| !value.is_null());
            outcome(adjudicator::Adjudicator.create_plan(intent, &state, rules))
        }
        other => panic!("неизвестная функция эталона {other}"),
    }
}

/// Эталон и итог Rust совпадают: `ok` — по тексту `JSON.stringify`, `err` —
/// код и сообщение, `fault` — сам факт ошибки не правила.
fn same(expected: &Value, actual: &Value) -> bool {
    match (expected.get("ok"), actual.get("ok")) {
        (Some(left), Some(right)) => js::stringify(left) == js::stringify(right),
        (None, None) => match (expected.get("err"), actual.get("err")) {
            (Some(left), Some(right)) => left == right,
            (None, None) => expected.get("fault").is_some() && actual.get("fault").is_some(),
            _ => false,
        },
        _ => false,
    }
}

fn clip(value: &Value) -> String {
    let text = js::stringify(value);
    text.chars().take(1500).collect()
}

fn check_source(prefix: &str) {
    let mut total = 0;
    let mut failures = Vec::new();
    for (index, case) in FIXTURE.cases.iter().enumerate() {
        let source = js::s(case.get("source"));
        if !source.starts_with(prefix) {
            continue;
        }
        total += 1;
        let f = js::s(case.get("f"));
        let actual = run(&f, &args_of(case));
        let expected = case.get("o").cloned().unwrap_or(Value::Null);
        if !same(&expected, &actual) {
            failures.push(format!("#{index} {source} {f}\n  JS:   {}\n  Rust: {}", clip(&expected), clip(&actual)));
        }
    }
    assert!(total > 0, "нет случаев {prefix}");
    assert!(failures.is_empty(), "{} из {total} случаев {prefix} расходятся:\n{}", failures.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
    eprintln!("{prefix}: {total} случаев совпали");
}

#[test]
fn recorded_js_tests_match() {
    check_source("test:");
}

#[test]
fn corpus_hero_turns_match() {
    check_source("corpus:hero");
}

#[test]
fn corpus_variants_match() {
    check_source("corpus:variant");
}

#[test]
fn corpus_reactions_and_other_turns_match() {
    check_source("corpus:reaction");
    check_source("corpus:other");
}

#[test]
fn adjudicator_plans_match() {
    check_source("plan");
}

fn dice() -> ServiceDice<DiceService<FixedRng>> {
    ServiceDice::new(DiceService::deterministic(FixedRng(10), "test-roll"))
}

fn accepted(result: Result<usize, Halt>) -> Value {
    match result {
        Ok(count) => json!({ "ok": count }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(_) => json!({ "fault": true }),
    }
}

/// Свойство: каждый план автотактики принимается движком Rust так же, как
/// движком JS, а выбранная команда шага проходит `validate` на технической
/// копии состояния (той, на которой её проверял сам планировщик).
#[test]
fn tactic_plans_are_accepted_by_the_engine() {
    // Исполнение плана движком — самая дорогая часть корпуса: случаи делятся
    // между потоками, итог не зависит от порядка.
    let threads = std::thread::available_parallelism().map_or(4, |count| count.get()).clamp(1, 16);
    let indices: Vec<usize> = (0..FIXTURE.cases.len()).collect();
    let chunk = indices.len().div_ceil(threads).max(1);
    let mut tally = Tally::default();
    std::thread::scope(|scope| {
        let workers: Vec<_> = indices.chunks(chunk).map(|part| scope.spawn(move || {
            let mut local = Tally::default();
            for index in part {
                check_plan(*index, &FIXTURE.cases[*index], &mut local);
            }
            local
        })).collect();
        for worker in workers {
            let local = worker.join().expect("поток проверки");
            tally.checked += local.checked;
            tally.validated += local.validated;
            tally.accepted += local.accepted;
            for (key, count) in local.rejected {
                *tally.rejected.entry(key).or_default() += count;
            }
            tally.failures.extend(local.failures);
        }
    });
    assert!(tally.checked > 0 && tally.validated > 0);
    assert!(tally.failures.is_empty(), "{} расхождений:
{}", tally.failures.len(), tally.failures.iter().take(12).cloned().collect::<Vec<_>>().join("
"));
    eprintln!("планов исполнено движком: {} (приняты обоими движками: {}); команд шага прошли validate: {}; отказы обоих движков: {:?}", tally.checked, tally.accepted, tally.validated, tally.rejected);
}

#[derive(Default)]
struct Tally {
    checked: usize,
    validated: usize,
    accepted: usize,
    rejected: std::collections::BTreeMap<String, usize>,
    failures: Vec<String>,
}

fn check_plan(index: usize, case: &Value, tally: &mut Tally) {
    let f = js::s(case.get("f"));
    if f != "planHeroTurn" && f != "planHeroCombatCommand" {
        return;
    }
    let Some(ok) = case.get("o").and_then(|o| o.get("ok")) else { return };
    let args = args_of(case);
    let state = &args[0];
    if f == "planHeroCombatCommand" {
        let command = ok.get("command").cloned().unwrap_or(Value::Null);
        let reason = js::s(ok.get("reason"));
        let fallback = reason.starts_with("Герой не может") || reason.starts_with("Сейчас ход") || reason.starts_with("Нет безопасной") || reason.starts_with("Реакция:");
        if !fallback {
            let actor_id = js::s(command.get("actor_id"));
            let technical = technical_copy(state);
            let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": [actor_id] }));
            let mut uuid = sk_rules::context::sequence_uuids("t2");
            match validate(&command, &technical, &context, &mut uuid) {
                Ok(_) => tally.validated += 1,
                Err(error) => tally.failures.push(format!("#{index} validate {}: {error}", clip(&command))),
            }
        }
    }
    let Some(expected) = case.get("accept") else { return };
    tally.checked += 1;
    let actual = engine_acceptance(&f, state, ok);
    let agrees = match (expected.get("ok"), actual.get("ok")) {
        (Some(left), Some(right)) => left == right,
        (None, None) => expected.get("err").map(|err| err.get(0)) == actual.get("err").map(|err| err.get(0)) || (expected.get("fault").is_some() && actual.get("fault").is_some()),
        _ => false,
    };
    if !agrees {
        tally.failures.push(format!("#{index} {f} исполнение: JS {} Rust {}", clip(expected), clip(&actual)));
    } else if expected.get("ok").is_some() {
        tally.accepted += 1;
    } else {
        let code = expected.get("err").and_then(|err| err.get(0)).map_or_else(|| "fault".to_string(), |code| js::s(Some(code)));
        let reason = ok.get("reason").map(|reason| js::s(Some(reason)).chars().take(24).collect::<String>()).unwrap_or_else(|| js::s(ok.get("rule")));
        *tally.rejected.entry(format!("{f}/{reason}/{code}")).or_default() += 1;
    }
}

/// `cloneForTacticValidation` теми же правилами, что в планировщике.
fn technical_copy(state: &Value) -> Value {
    let mut clone = state.clone();
    if let Some(Value::Array(cells)) = clone.get_mut("scene").and_then(|scene| scene.get_mut("cells")) {
        for cell in cells.iter_mut() {
            if let Value::Object(map) = cell {
                if map.get("revealed") != Some(&Value::Bool(false)) {
                    map.insert("revealed".into(), Value::Bool(true));
                }
            }
        }
    }
    if let Some(Value::Array(enemies)) = clone.get_mut("enemies") {
        for enemy in enemies.iter_mut() {
            if let Value::Object(map) = enemy {
                if map.get("alive") == Some(&Value::Bool(false)) || js::present(map.get("hp")) {
                    continue;
                }
                let max = js::number(map.get("maxHp").filter(|value| !value.is_null()).or(Some(&json!(1))));
                let max = if max.is_nan() || max == 0.0 { 1.0 } else { max };
                map.insert("hp".into(), json!(1));
                map.insert("maxHp".into(), js::num(max.max(1.0)));
                map.insert("alive".into(), json!(true));
            }
        }
    }
    clone
}

fn engine_acceptance(f: &str, state: &Value, ok: &Value) -> Value {
    if f == "planHeroTurn" {
        let mut ids = Vec::new();
        for key in ["players", "enemies", "actors"] {
            for actor in state.get(key).and_then(Value::as_array).into_iter().flatten() {
                let id = actor.get("id").filter(|value| !value.is_null()).or_else(|| actor.get("actor_id"));
                ids.push(Value::String(js::string(id)));
            }
        }
        let commands: Vec<Value> = ok
            .get("commands")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, command)| js::spread(command, json!({ "campaign_id": "T2", "command_id": format!("t2:{}", index + 1) })))
            .collect();
        let context = Context::from_json(&json!({ "isDirector": true, "serverAuthoritativeCombat": true, "allowedActorIds": ids }));
        let mut engine = RulesEngine { dice: Box::new(dice()), uuid: Box::new(sk_rules::context::sequence_uuids("t2")) };
        return accepted(engine.resolve_plan(&json!({ "proposed_commands": commands }), state, &context).map(|plan| plan.events.len()));
    }
    let command = js::spread(ok.get("command").unwrap_or(&Value::Null), json!({ "campaign_id": "T2", "command_id": "t2:1" }));
    let actor_id = js::string(command.get("actor_id"));
    let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": [actor_id] }));
    let mut dice = dice();
    let mut uuid = sk_rules::context::sequence_uuids("t2");
    accepted(resolve_command(&command, state, &mut dice, &context, &mut uuid).map(|outcome| outcome.resolved().events.len()))
}
