//! Паритет `campaign_loop_policy` с `server/campaign-loop-policy.mjs` по
//! эталону `fixtures/campaign-loop-policy.json.gz`
//! (`fixtures/gen-campaign-loop-policy.mjs`), плюс перенесённые проверки
//! `test/campaign-loop-policy.test.mjs`.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_story::campaign_loop_policy as p;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/campaign-loop-policy.json.gz")[..])
        .read_to_string(&mut text)
        .expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон — JSON")
});

#[derive(Debug, PartialEq)]
enum Outcome {
    Out(String),
    Error(String, String),
}

/// `undefined` аргумента в эталоне.
fn arg(value: Option<&Value>) -> Option<&Value> {
    match value {
        Some(Value::String(text)) if text == js::UNDEFINED => None,
        other => other,
    }
}

/// Подстановка `${value}` с запасом `''` для `undefined`.
fn template(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        other => js::string(other),
    }
}

fn out(value: Value) -> Outcome {
    Outcome::Out(js::stringify(&value))
}

fn run(name: &str, state: &Value, args: &[Option<&Value>]) -> Outcome {
    let at = |index: usize| args.get(index).copied().flatten();
    let empty = json!({});
    let or_empty = |index: usize| at(index).unwrap_or(&empty);
    let opt = |value: Option<Value>| value.unwrap_or(Value::Null);
    let intent_result = |result: Result<Value, sk_world_story::autonomous_campaign::DirectorIntentError>| match result {
        Ok(value) => out(value),
        Err(error) => Outcome::Error(error.code, error.message),
    };
    match name {
        "abandonedQuestsForDirector" => out(Value::Array(p::abandoned_quests_for_director(state))),
        "directorObjectiveAfterQuestAbandonment" => {
            let fallback = at(1).map(|value| js::s(Some(value)));
            out(json!(p::director_objective_after_quest_abandonment(state, fallback.as_deref())))
        }
        "questWasAbandonedInPlace" => out(json!(p::quest_was_abandoned_in_place(at(0).unwrap_or(&Value::Null)))),
        "affirmativePlayerAction" => out(json!(p::affirmative_player_action(at(0), &template(at(1))))),
        "arcSeedFor" => out(json!(p::arc_seed_for(at(0), at(1)))),
        "buildCampaignArcPlan" => out(p::build_campaign_arc_plan(at(0), at(1))),
        "campaignArcPlan" => out(opt(p::campaign_arc_plan(state))),
        "confirmedQuestProgress" => out(json!(p::confirmed_quest_progress(state, &template(at(1))))),
        "mainQuestFor" => out(opt(p::main_quest_for(state).cloned())),
        "campaignArcClimaxSatisfied" => out(json!(p::campaign_arc_climax_satisfied(state))),
        "campaignArcPosition" => out(opt(p::campaign_arc_position(state))),
        "scenarioEncounterIntent" => intent_result(p::scenario_encounter_intent(state, or_empty(1))),
        "authorizeDirectorIntent" => intent_result(p::authorize_director_intent(state, at(1), Some(or_empty(2)))),
        "directorProgressFingerprint" => out(json!(p::director_progress_fingerprint(state))),
        "pacingForDirectorIntent" => out(p::pacing_for_director_intent(state, or_empty(1))),
        "nextWorldMapDestination" => out(opt(p::next_world_map_destination(state).map(Value::String))),
        "planServerTravel" => out(p::plan_server_travel(state, or_empty(1))),
        "assembleSocialNpc" => out(p::assemble_social_npc(state, or_empty(1))),
        "completedDowntime" => out(p::completed_downtime(state, or_empty(1))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn matches_js_fixture() {
    let states = FIXTURE["states"].as_array().expect("состояния");
    let cases = FIXTURE["cases"].as_array().expect("случаи");
    let empty = json!({});
    let mut checked = 0;
    let mut tolerated = 0;
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().expect("имя функции");
        let raw: Vec<Option<&Value>> = case["args"].as_array().expect("аргументы").iter().map(|value| arg(Some(value))).collect();
        let state = match case.get("state").and_then(Value::as_u64) {
            Some(state) => &states[state as usize],
            None => match raw.first().copied() {
                None => &empty,
                Some(value) => value.unwrap_or(&empty),
            },
        };
        let result = run(name, state, &raw);
        // JS бросил TypeError на мусоре: Rust обязан только не упасть.
        if case.get("throws").is_some() {
            tolerated += 1;
            continue;
        }
        let expected = if let Some(error) = case.get("error") {
            Outcome::Error(js::s(error.get("code")), js::s(error.get("message")))
        } else if case.get("undef").is_some() {
            Outcome::Out("null".into())
        } else {
            Outcome::Out(js::stringify(&case["out"]))
        };
        checked += 1;
        if result != expected {
            failures.push(format!("#{index} {name}: ждали {expected:?}, получили {result:?}"));
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {checked}:\n{}", failures.len(), failures.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
    assert!(checked > 3000, "случаев мало: {checked}");
    eprintln!("campaign-loop-policy: сверено {checked}, мусор JS {tolerated}");
}

// --- Проверки из test/campaign-loop-policy.test.mjs -------------------------

fn base_state() -> Value {
    json!({
        "sessionCode": "LOOP-1",
        "partyMemberIds": ["hero-a", "hero-b"],
        "players": [{ "id": "hero-a" }, { "id": "hero-b" }],
        "scene": { "location": "Северный тракт", "scene_kind": "wilderness" },
        "adventure": { "chapter": 2 },
        "mechanics": { "world_time": { "elapsed_minutes": 120 }, "death": { "heroes": {} } },
        "worldMemory": {
            "entities": [{ "id": "wardens", "kind": "faction" }],
            "facts": [{ "id": "fact-1", "predicate": "discovery", "subject_id": "wardens", "source_event_ids": ["event-1"], "status": "active", "visibility": "party" }],
            "quests": [{ "id": "quest-1", "status": "active", "entity_ids": ["wardens"], "clock": { "current": 0, "max": 6 } }],
        },
        "autonomy": { "pacing": { "beat": 4, "phase": "escalation", "tension": 82 } },
    })
}

#[test]
fn pacing_derives_bounded_tension() {
    let pacing = p::pacing_for_director_intent(&base_state(), &json!({ "type": "advance_quest_clock" }));
    assert_eq!(
        pacing,
        json!({ "beat": 5, "phase": "climax", "tension_before": 82, "tension_after": 96, "delta": 14, "intent_type": "advance_quest_clock", "policy": "campaign-pacing-v1" })
    );
    let social = p::pacing_for_director_intent(&json!({ "autonomy": { "pacing": { "tension": 10 } } }), &json!({ "type": "open_social_scene" }));
    assert_eq!(social["tension_after"], json!(18));
}

#[test]
fn policy_replaces_repeated_intent() {
    let mut state = base_state();
    state["autonomy"]["director_history"] = json!([{ "intent": { "type": "open_social_scene" } }]);
    state["autonomy"]["director_outcomes"] = json!([{ "intent_type": "open_social_scene", "state_changed": false }, { "state_changed": true }]);
    state["autonomy"]["pacing"] = json!({ "beat": 7, "phase": "escalation", "tension": 68 });
    let authorized = p::authorize_director_intent(&state, Some(&json!({ "type": "open_social_scene" })), None).expect("намерение");
    assert_eq!(authorized["replaced"], json!(true));
    assert_eq!(authorized["reason"], json!("anti_stall_replacement"));
    assert_eq!(authorized["intent"]["type"], json!("advance_quest_clock"));
    assert_eq!(authorized["intent"]["quest_id"], json!("quest-1"));
}

#[test]
fn travel_is_deterministic_and_can_trigger_encounter() {
    let state = base_state();
    let options = json!({ "campaignId": "LOOP-1", "destination": "Заброшенный склеп", "idempotencyKey": "travel-1" });
    let first = p::plan_server_travel(&state, &options);
    assert_eq!(first, p::plan_server_travel(&state, &options));
    assert!(first["duration_minutes"].as_i64().unwrap_or(0) >= 75);
    assert!(first["risk_score"].as_f64().unwrap_or(0.0) >= 65.0);
    let triggered = (0..200)
        .map(|index| p::plan_server_travel(&state, &json!({ "campaignId": "LOOP-1", "destination": "Заброшенный склеп", "idempotencyKey": format!("travel-risk-{index}") })))
        .find(|travel| travel["random_encounter"] == json!(true))
        .expect("высокий риск даёт стычку");
    assert!(["undead", "raiders"].contains(&triggered["encounter"]["theme"].as_str().unwrap_or("")));
}

#[test]
fn social_npc_and_downtime() {
    let state = base_state();
    let npc = p::assemble_social_npc(&state, &json!({ "campaignId": "LOOP-1", "idempotencyKey": "social-1" }));
    assert!(npc["id"].as_str().unwrap_or("").starts_with("npc-"));
    assert_eq!(npc["known_fact_ids"], json!([]));
    assert_eq!(npc["tags"], json!(["faction:wardens"]));
    let mut dead = base_state();
    dead["mechanics"]["death"]["heroes"]["hero-b"] = json!({ "status": "dead" });
    let downtime = p::completed_downtime(&dead, &json!({}));
    assert_eq!(downtime["participant_ids"], json!(["hero-a"]));
    assert_eq!(downtime["duration_minutes"], json!(480));
}

#[test]
fn evening_arc_is_bounded_and_climax_needs_hard_encounter() {
    let plan = p::build_campaign_arc_plan(Some(&json!("climax-proof")), None);
    let target = plan["target_scenes"].as_i64().unwrap_or(0);
    assert!((3..=5).contains(&target));
    let mut state = base_state();
    state["campaignConcept"] = json!({ "arc": plan });
    state["adventure"]["chapter"] = json!(target);
    state["mechanics"]["encounter"] = json!({ "id": "final-encounter", "status": "ended", "difficulty": "medium", "created_in_chapter": target });
    state["autonomy"]["encounter_outcomes"] = json!([{ "encounter_id": "final-encounter", "outcome": "enemies_defeated" }]);
    assert!(!p::campaign_arc_climax_satisfied(&state));
    state["mechanics"]["encounter"]["difficulty"] = json!("hard");
    assert!(p::campaign_arc_climax_satisfied(&state));
    for lost in ["party_incapacitated", "party_defeated"] {
        state["autonomy"]["encounter_outcomes"] = json!([{ "encounter_id": "final-encounter", "outcome": lost }]);
        assert!(!p::campaign_arc_climax_satisfied(&state), "{lost}");
    }
}

#[test]
fn abandonment_in_place_gives_neutral_objective() {
    let mut state = base_state();
    let arc = p::build_campaign_arc_plan(Some(&json!("in-place-abandonment")), None);
    state["adventure"]["chapter"] = arc["target_scenes"].clone();
    state["campaignConcept"] = json!({ "arc": arc });
    state["worldMemory"]["quests"] = json!([{ "id": "quest:main", "title": "Старая цель", "status": "abandoned", "stay_in_location": true, "clock": { "current": 1, "max": 3 } }]);
    assert_eq!(p::director_objective_after_quest_abandonment(&state, None), p::QUEST_ABANDONMENT_NEXT_OBJECTIVE);
}
