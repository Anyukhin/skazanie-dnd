//! Сверка `post_commit_coordinator` с эталоном JS
//! (`fixtures/gen-post-commit-coordinator.mjs`): ключи позиции на мусорных
//! состояниях и сценарии координатора — порядок вызовов зависимостей, ключи
//! стадии и коммита, итоги и повторы после падения.

mod common;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Map, Value};
use sk_society::post_commit_coordinator::*;

type Order = Rc<RefCell<Vec<String>>>;

fn dependency(name: &'static str, order: &Order, failures: &Rc<RefCell<HashMap<String, i64>>>, results: bool) -> Option<DepFn> {
    let (order, failures) = (Rc::clone(order), Rc::clone(failures));
    Some(Box::new(move |context: &StageContext| {
        let extra = context.extra.get("extra").and_then(Value::as_str).unwrap_or_default();
        order.borrow_mut().push(format!("{name}|{}|{}|{}|{extra}", context.stage_key.clone().unwrap_or_default(), context.commit_key, context.campaign_id));
        let mut failures = failures.borrow_mut();
        let left = failures.get(name).copied().unwrap_or(0);
        if left > 0 {
            failures.insert(name.to_string(), left - 1);
            return Err(format!("{name} упал"));
        }
        Ok(results.then(|| json!({ "stage": name, "events": context.events.len() })))
    }))
}

fn run_scenario(config: &Value) -> Value {
    let deps_config = &config["deps"];
    let present: Vec<&str> = deps_config["present"].as_array().map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let fail_times = deps_config["failTimes"].as_i64().unwrap_or(0);
    let failures: HashMap<String, i64> = deps_config["fail"].as_array().map(|list| list.iter().filter_map(Value::as_str).map(|name| (name.to_string(), fail_times)).collect()).unwrap_or_default();
    let failures = Rc::new(RefCell::new(failures));
    let results = deps_config["results"].as_bool().unwrap_or(false);
    let order: Order = Rc::new(RefCell::new(Vec::new()));
    let make = |name: &'static str| if present.contains(&name) { dependency(name, &order, &failures, results) } else { None };
    let heroes = deps_config.get("heroes").and_then(Value::as_array).cloned();
    let deps = PostCommitDeps {
        apply_quest_consequences: make("applyQuestConsequences"),
        continue_combat: make("continueCombat"),
        complete_encounter: make("completeEncounter"),
        heroes_needing_hooks: heroes.map(|heroes| Box::new(move |_: &Value, _: &str| heroes.clone()) as Box<dyn Fn(&Value, &str) -> Vec<Value>>),
        weave_hero_hooks: make("weaveHeroHooks"),
        run_director: make("runDirector"),
        persist_projection: make("persistProjection"),
        narrate: make("narrate"),
    };
    let errors: Order = Rc::new(RefCell::new(Vec::new()));
    let seen = Rc::clone(&errors);
    let mut coordinator = PostCommitCoordinator::new(deps).with_on_error(move |error, stage| seen.borrow_mut().push(format!("{stage}: {error}")));
    let mut runs = Vec::new();
    for run in config["runs"].as_array().cloned().unwrap_or_default() {
        let state = run.get("state").cloned().unwrap_or(Value::Null);
        let events = run.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
        let stage_names: Option<Vec<String>> = run.get("stages").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect());
        let stage_refs: Option<Vec<&str>> = stage_names.as_ref().map(|names| names.iter().map(String::as_str).collect());
        let context: Map<String, Value> = run.get("context").and_then(Value::as_object).cloned().unwrap_or_default();
        let result = coordinator.run(RunInput {
            campaign_id: run["campaignId"].as_str().unwrap_or_default(),
            state: &state,
            events: &events,
            commit_key: run.get("commitKey").and_then(Value::as_str).unwrap_or_default(),
            stages: stage_refs.as_deref(),
            context,
        });
        let results: Map<String, Value> = result.results.into_iter().filter_map(|(name, value)| value.map(|value| (name, value))).collect();
        runs.push(json!({ "ran": result.ran, "skipped": result.skipped, "failed": result.failed, "results": results }));
    }
    let order = order.borrow().clone();
    let errors = errors.borrow().clone();
    json!({ "runs": runs, "order": order, "errors": errors })
}

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "combatPositionKey" => Outcome::option(combat_position_key(args.val(0))),
        "directorPositionKey" => Outcome::of(director_position_key(args.val(0))),
        "coordinatorScenario" => Outcome::of(run_scenario(args.val(0))),
        _ => Outcome::Unknown,
    }
}

#[test]
fn coordinator_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/post-commit-coordinator.json"));
    assert!(fixture.check(dispatch) > 500);
    let order: Vec<Value> = stage_order_for_review().into_iter().map(|(name, kind)| json!({ "name": name, "keyKind": kind })).collect();
    assert_eq!(fixture.root["constants"], json!({ "STAGE_KEY_KINDS": STAGE_KEY_KINDS, "stageOrderForReview": order }));
}
