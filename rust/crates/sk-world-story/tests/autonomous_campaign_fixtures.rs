//! `autonomous_campaign`: эталон JS (`fixtures/autonomous-campaign.json`) —
//! вызовы из тестов автономного цикла (оркестратор, политика цикла, редьюсер
//! Rules Engine), события корпуса паритета и случайные намерения Режиссёра и
//! цепочки событий `autonomy` с мусором старых сохранений.

mod common;

use common::{ok, Args, Fixture, JsError, Outcome};
use serde_json::{json, Value};
use sk_world_story::autonomous_campaign::*;

pub fn run(name: &str, args: &Args) -> Outcome {
    let empty = json!({});
    match name {
        "normalizeDirectorIntent" => normalize_director_intent(args.get(0)).map(Some).map_err(|error| JsError::new(DirectorIntentError::NAME, &error.code, &error.message)),
        "normalizeAutonomyState" => ok(normalize_autonomy_state(args.get(0))),
        "serverReputationDelta" => ok(server_reputation_delta(args.get(0).unwrap_or(&empty))),
        "ensureAvailableHook" => ok(ensure_available_hook(args.get(0).unwrap_or(&empty), args.get(1)).unwrap_or(Value::Null)),
        "applyAutonomyEvent" => ok(apply_autonomy_event(args.get(0), args.value(1))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn autonomous_campaign_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/autonomous-campaign.json"));
    let summary = common::check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 2_000, "{summary:?}");
}
