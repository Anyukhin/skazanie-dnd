//! `scenario_knight`: эталон JS (`fixtures/scenario-knight.json`, генератор —
//! `fixtures/gen-scenario-knight.mjs`) — сценарии `test/scenario-knight.test.mjs`
//! через настоящий Rules Engine, корпус паритета Асстохана и случайные
//! состояния, события и фразы с мусором старых сохранений. Ниже — проверки
//! модуля из тестов JS, которые не требуют движка.

mod harness;

use harness::{check, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_world_story::scenario_knight::*;

fn run(name: &str, args: &Args) -> Outcome {
    let state = args.or_empty(0);
    Ok(Some(match name {
        "scenarioNightVisitorIds" => json!(scenario_night_visitor_ids(args.get(0))),
        "scenarioKnightStartingInventory" => scenario_knight_starting_inventory(args.get(0)),
        "minuteInWindow" => json!(minute_in_window(args.number(0).unwrap_or(f64::NAN), &args.or_empty(1))),
        "scenarioKnightShouldBePresent" => json!(scenario_knight_should_be_present(&state)),
        "scenarioKnightPresencePlan" => scenario_knight_presence_plan(&state).unwrap_or(Value::Null),
        "normalizeScenarioKnightState" => normalize_scenario_knight_state(args.get(0).or(Some(&json!({})))).to_json(),
        "scenarioNightIndex" => sk_core::js::num(scenario_night_index(&state)),
        "applyScenarioKnightEvent" => apply_scenario_knight_event(args.get(0), args.get(1), &args.or_empty(2)).to_json(),
        "scenarioKnightState" => scenario_knight_state(&state).unwrap_or(Value::Null),
        "scenarioKnightRiddleSolved" => json!(scenario_knight_riddle_solved(&state)),
        "scenarioKnightPresent" => json!(scenario_knight_present(&state)),
        "scenarioKnightWard" => scenario_knight_ward(&state, args.get(1)).unwrap_or(Value::Null),
        "scenarioKnightDreadFor" => scenario_knight_dread_for(&state, args.get(1), args.number(2)).unwrap_or(Value::Null),
        "scenarioKnightRules" => scenario_knight_rules(&state).unwrap_or(Value::Null),
        "scenarioKnightActionFromText" => scenario_knight_action_from_text(args.get(0)).map_or(Value::Null, KnightAction::to_json),
        other => panic!("неизвестная функция эталона {other}"),
    }))
}

static FIXTURE: std::sync::LazyLock<Fixture> = std::sync::LazyLock::new(|| Fixture::load_gz(include_bytes!("../fixtures/scenario-knight.json.gz")));

#[test]
fn scenario_knight_matches_js() {
    let summary = check(&FIXTURE, run);
    println!("{summary:?}");
    assert!(summary.calls > 8_000, "{summary:?}");
    assert!(summary.per_fn.len() == 15, "{summary:?}");
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE.data["constants"];
    assert_eq!(constants["SCENARIO_KNIGHT_PRESENCE_EVENT"], json!(SCENARIO_KNIGHT_PRESENCE_EVENT));
    assert_eq!(constants["SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION"], json!(SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION));
    assert_eq!(constants["SCENARIO_KNIGHT_SCHEMA_VERSION"], json!(SCENARIO_KNIGHT_SCHEMA_VERSION));
    assert_eq!(constants["SCENARIO_KNIGHT_COMMAND_TYPES"], json!(SCENARIO_KNIGHT_COMMAND_TYPES));
    assert_eq!(constants["SCENARIO_KNIGHT_HEAD_EVENT"], json!(SCENARIO_KNIGHT_HEAD_EVENT));
    assert_eq!(constants["SCENARIO_KNIGHT_RELEASED_EVENT"], json!(SCENARIO_KNIGHT_RELEASED_EVENT));
    assert_eq!(constants["SCENARIO_KNIGHT_RELEASE_FAILED_EVENT"], json!(SCENARIO_KNIGHT_RELEASE_FAILED_EVENT));
    assert_eq!(constants["SCENARIO_KNIGHT_DREAD_SOURCE"], json!(SCENARIO_KNIGHT_DREAD_SOURCE));
}

/// Состояние Асстохана в замке: концепция кампании — из первого состояния эталона.
fn astohan_at(minute_of_day: i64, location: &str) -> Value {
    let concept = FIXTURE
        .data["values"]
        .as_array()
        .and_then(|values| values.iter().find(|value| value.pointer("/arc/scenario_id").is_some()))
        .cloned()
        .or_else(|| FIXTURE.data["states"].as_array().and_then(|states| states.iter().find_map(|state| state.get("campaignConcept").filter(|c| c.get("arc").is_some()).cloned())))
        .expect("концепция Асстохана в эталоне");
    // Кампания начинается в 08:00.
    let elapsed = (minute_of_day - 480).rem_euclid(1_440);
    json!({
        "campaignConcept": concept,
        "scene": { "location_id": location },
        "mechanics": { "world_time": { "elapsed_minutes": elapsed }, "combat": { "active": false } },
        "social": { "npcs": [{ "id": "astohan-kaelan", "name": "Каэлан", "available": false }] },
        "partyMemberIds": ["knight-hero"],
    })
}

#[test]
fn knight_comes_only_at_night_and_only_with_party() {
    let castle = "astohan-forgotten-cliffs";
    assert!(!scenario_knight_should_be_present(&astohan_at(12 * 60, castle)), "днём замок пуст");
    assert!(scenario_knight_should_be_present(&astohan_at(0, castle)), "в полночь рыцарь в замке");
    assert!(scenario_knight_should_be_present(&astohan_at(23 * 60, castle)));
    assert!(!scenario_knight_should_be_present(&astohan_at(60, castle)), "в час ночи уходит");
    assert!(!scenario_knight_should_be_present(&astohan_at(0, "astohan-mittlayd")), "без отряда не ждёт");

    let plan = scenario_knight_presence_plan(&astohan_at(0, castle)).expect("приход");
    assert_eq!(plan["present"], json!(true));
    assert!(plan["text"].as_str().unwrap_or_default().contains("Вечного Стража"));
    assert_eq!(plan["profile"]["available"], json!(true));

    let mut fighting = astohan_at(0, castle);
    fighting["mechanics"]["combat"]["active"] = json!(true);
    assert_eq!(scenario_knight_presence_plan(&fighting), None, "посреди боя присутствие не меняется");
}

#[test]
fn ward_and_dread_follow_the_head() {
    let mut state = astohan_at(0, "astohan-forgotten-cliffs");
    let ward = scenario_knight_ward(&state, Some(&json!("astohan-kaelan"))).expect("защита");
    assert_eq!(ward["kind"], json!("immune"));
    assert!(ward["laugh"].as_str().unwrap_or_default().contains("Голова спит там, где пали небеса"));
    state["mechanics"]["combat"]["active"] = json!(true);
    let dread = scenario_knight_dread_for(&state, Some(&json!("knight-hero")), Some(5.0)).expect("ужас");
    assert_eq!(dread["dc"], json!(15));
    assert_eq!(dread["ability"], json!("wis"));
    assert_eq!(scenario_knight_dread_for(&state, Some(&json!("knight-hero")), Some(35.0)), None, "вне радиуса");
    state["scenario_knight"] = json!({ "head_returned": true });
    assert_eq!(scenario_knight_ward(&state, Some(&json!("astohan-kaelan"))), Some(json!({ "kind": "resist", "except": ["force"] })));
    assert_eq!(scenario_knight_dread_for(&state, Some(&json!("knight-hero")), Some(5.0)), None);
}

#[test]
fn player_phrases_become_knight_actions() {
    let action = |text: &str| scenario_knight_action_from_text(Some(&json!(text)));
    assert_eq!(action("Ставлю голову перед рыцарем"), Some(KnightAction::ReturnHead));
    assert_eq!(action("Молюсь об упокоении Каэлана"), Some(KnightAction::Release { skill: "religion" }));
    assert_eq!(action("Убеждаю рыцаря обрести покой"), Some(KnightAction::Release { skill: "persuasion" }));
    assert_eq!(action("Смотрю на рыцаря"), None);
}

#[test]
fn failed_release_spends_the_night() {
    let state = astohan_at(0, "astohan-forgotten-cliffs");
    let night = scenario_night_index(&state);
    let event = json!({ "event_type": SCENARIO_KNIGHT_RELEASE_FAILED_EVENT, "actor_id": "knight-hero", "payload": { "night": night } });
    let ledger = apply_scenario_knight_event(None, Some(&event), &state);
    assert_eq!(ledger.attempts, vec![format!("knight-hero:{night}")]);
}
