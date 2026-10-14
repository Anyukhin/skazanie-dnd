//! Сверка `campaign_controls` с эталоном JS (`fixtures/campaign-controls.json`,
//! генератор — `fixtures/gen-campaign-controls.mjs`).

use serde_json::Value;
use sk_scenario::campaign_controls::{campaign_rewind_event, plan_campaign_control, CampaignControlError};

const FIXTURE: &str = include_str!("../fixtures/campaign-controls.json");
/// Так генератор записывает `undefined`: в JSON его нет.
const UNDEFINED: &str = "__undefined__";

fn arg<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input.get(key).filter(|value| value.as_str() != Some(UNDEFINED))
}

fn error_value(error: &CampaignControlError) -> Value {
    serde_json::json!({ "code": error.code, "message": error.message, "name": "CampaignControlError" })
}

fn compare(label: &str, input: &Value, actual: Value, expected: &Value, failures: &mut Vec<String>) {
    let same = actual == *expected && serde_json::to_string(&actual).ok() == serde_json::to_string(expected).ok();
    if !same {
        failures.push(format!("{label} {input}:\n    rust: {actual}\n    js:   {expected}"));
    }
}

#[test]
fn plans_match_js() {
    let data: Value = serde_json::from_str(FIXTURE).expect("эталон — JSON");
    let mut failures = Vec::new();
    let plans = data["plans"].as_array().expect("планы");
    for case in plans {
        let input = &case["input"];
        let result = plan_campaign_control(arg(input, "action"), arg(input, "events"), arg(input, "currentVersion"));
        let actual = match &result {
            Ok(plan) => serde_json::json!({ "ok": plan }),
            Err(error) => serde_json::json!({ "error": error_value(error) }),
        };
        compare("план", input, actual, &case["result"], &mut failures);
    }
    let rewinds = data["rewinds"].as_array().expect("откаты");
    for case in rewinds {
        let input = &case["input"];
        let result = campaign_rewind_event(
            arg(input, "action"),
            arg(input, "targetState"),
            arg(input, "currentState"),
            arg(input, "targetVersion"),
            arg(input, "actorId"),
            arg(input, "occurredAt"),
        );
        let actual = match &result {
            Ok(event) => serde_json::json!({ "ok": event }),
            Err(error) => serde_json::json!({ "error": error_value(error) }),
        };
        compare("откат", input, actual, &case["result"], &mut failures);
    }
    let shown: Vec<&String> = failures.iter().take(30).collect();
    assert!(
        failures.is_empty(),
        "расхождений с JS {} из {}:\n{}",
        failures.len(),
        plans.len() + rewinds.len(),
        shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn rewind_without_time_uses_now() {
    let event = campaign_rewind_event(
        Some(&Value::from("replay_scene")),
        Some(&serde_json::json!({ "state_version": 2 })),
        None,
        Some(&Value::from(1)),
        None,
        None,
    )
    .expect("событие");
    let occurred = event["payload"]["occurred_at"].as_str().expect("время");
    assert!(sk_core::clock::parse_iso(occurred).is_some(), "{occurred}");
    assert_eq!(event["actor_id"], "");
    assert_eq!(event["payload"]["rewound_from_version"], 0);
}
