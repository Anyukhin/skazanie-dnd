//! `scene_canon`: эталон JS (`fixtures/scene-canon.json`, генератор —
//! `fixtures/gen-scene-canon.mjs`) — `test/scene-canon.test.mjs` под
//! перехватом, размеченный набор и сохранённые тексты моделей `eval/*.json`,
//! канон сцены по корпусу паритета и случайные вводные с мусором. Ниже —
//! проверки модуля из тестов JS, которые не требуют движка и модели.

mod harness;

use harness::{check, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_world_story::scene_canon::*;

fn run(name: &str, args: &Args) -> Outcome {
    Ok(Some(match name {
        "sceneCanonFor" => scene_canon_for(&args.or_empty(0), args.get(1)),
        "sceneCanonFromEnvironment" => scene_canon_from_environment(args.get(0)).unwrap_or(Value::Null),
        "requestedOpeningCanon" => requested_opening_canon(args.get(0)),
        "campaignStartCanon" => campaign_start_canon(args.get(0), args.get(1)),
        "sensoryAnchorConflicts" => json!(sensory_anchor_conflicts(args.get(0), args.get(1))),
        "sceneCanonContradictions" => Value::Array(scene_canon_contradictions(args.get(0), args.get(1), args.get(2))),
        other => panic!("неизвестная функция эталона {other}"),
    }))
}

static FIXTURE: std::sync::LazyLock<Fixture> = std::sync::LazyLock::new(|| Fixture::load_gz(include_bytes!("../fixtures/scene-canon.json.gz")));

#[test]
fn scene_canon_matches_js() {
    let summary = check(&FIXTURE, run);
    println!("{summary:?}");
    assert!(summary.calls > 6_000, "{summary:?}");
    assert_eq!(summary.per_fn.len(), 6, "{summary:?}");
}

#[test]
fn constants_match_js() {
    assert_eq!(FIXTURE.data["constants"]["SCENE_CANON_VERSION"], json!(SCENE_CANON_VERSION));
    assert_eq!(FIXTURE.data["constants"]["SCENE_CANON_CONTRADICTION"], json!(SCENE_CANON_CONTRADICTION));
}

fn canon(phase: &str, clock: &str, weather: &str, indoors: bool) -> Value {
    scene_canon_from_environment(Some(&json!({
        "world_clock": { "day": 1, "clock": clock, "time_of_day": phase, "weather": weather, "indoors": indoors, "effects": [] },
        "scene": { "location": "Причал Аквилона" },
    })))
    .expect("канон из часов")
}

fn kinds(narration: &str, canon: &Value) -> Vec<String> {
    scene_canon_contradictions(Some(&json!(narration)), Some(canon), None).iter().map(|found| found["kind"].as_str().unwrap_or_default().to_string()).collect()
}

#[test]
fn environment_without_clock_has_no_canon() {
    assert_eq!(scene_canon_from_environment(Some(&json!({ "scene": { "location": "Причал" } }))), None);
    assert_eq!(scene_canon_from_environment(None), None);
    let morning = canon("morning", "08:00", "clear", false);
    assert_eq!(morning["surfaces"]["water_nearby"], json!(true), "причал — у воды");
    assert!(morning["summary"].as_str().unwrap_or_default().starts_with("Утро, 08:00."));
}

#[test]
fn live_contradictions_of_2026_10_01() {
    let morning = canon("morning", "08:00", "fog", false);
    assert_eq!(kinds("Аквилон встречает ночь туманом.", &morning), vec!["time_of_day"]);
    assert_eq!(kinds("Покрытый пылью причал скрипит под ногами.", &morning), vec!["surface"]);
}

#[test]
fn speech_past_negation_and_windows_are_left_alone() {
    let morning = canon("morning", "08:00", "clear", false);
    assert!(kinds("— Ночь будет долгой, — говорит Иара.", &morning).is_empty());
    assert!(kinds("Вчера ночь опустилась рано.", &morning).is_empty());
    let inside = canon("day", "13:00", "rain", true);
    assert_eq!(kinds("Над головой серые тучи.", &inside), vec!["sky_indoors"]);
    assert!(kinds("За окном над головой тучи.", &inside).is_empty());
}

#[test]
fn opening_requests_read_phase_and_sky() {
    let request = requested_opening_canon(Some(&json!({ "openingSituation": "Ночь, гроза." })));
    assert_eq!(request, json!({ "phase": "night", "weather": "storm" }));
    let quoted = requested_opening_canon(Some(&json!({ "openingSituation": "Таверна «Ночной якорь».", "premise": "Утро." })));
    assert_eq!(quoted, json!({ "phase": "morning", "weather": "" }));
    let start = campaign_start_canon(Some(&json!("seed")), Some(&json!({ "phase": "night", "weather": "storm" })));
    assert_eq!(start["time"]["clock"], json!("23:00"));
    assert_eq!(start["weather_pin"], json!({ "day": 0, "weather": "storm" }));
}
