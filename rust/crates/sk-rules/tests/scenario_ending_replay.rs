//! AGENTS.md §5: развязка сценария — исход боя с главным противником в
//! логове; `CompleteCampaign` записывает её в `CampaignCompleted`, и она
//! переживает replay. Перенос сторожа `CompleteCampaign записывает развязку
//! сценария` из `archive/js-server/test/campaign-scenario.test.mjs`.
//!
//! Состояния «бой с Саргатом завершён» — из эталона `sk-scenario`
//! (`fixtures/campaign-scenario.json`, снят с JS): основа логова плюс
//! исход встречи. Сама развязка там сверена с JS (`states_match_js`).

use serde_json::{json, Value};
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::replay::replay_events;
use sk_rules::resolve::api;

struct NoRolls;

impl Rng for NoRolls {
    fn randint(&mut self, _minimum: i64, _maximum: i64) -> Result<i64, DiceError> {
        panic!("завершение кампании не бросает кости")
    }
}

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sk-scenario/fixtures/campaign-scenario.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("эталон sk-scenario")).expect("JSON")
}

fn spread(base: &Value, patch: &Value) -> Value {
    let mut result = base.as_object().cloned().unwrap_or_default();
    for (key, value) in patch.as_object().into_iter().flatten() {
        result.insert(key.clone(), value.clone());
    }
    Value::Object(result)
}

fn lifecycle(state: &Value) -> Value {
    let normalized = sk_rules::normalize::normalize_campaign_state(state).expect("нормализация");
    normalized["mechanics"]["campaign_lifecycle"].clone()
}

#[test]
fn complete_campaign_records_the_scenario_ending_and_it_survives_replay() {
    let data = fixture();
    let bases = data["bases"].as_array().expect("основы");
    let mut seen = Vec::new();
    for case in data["cases"].as_array().expect("случаи") {
        let ending = &case["out"]["ending"];
        // Состояния логова после боя: исход встречи в `mechanics`/`autonomy`.
        let patch_keys: Vec<&String> = case["patch"].as_object().map(|patch| patch.keys().collect()).unwrap_or_default();
        if ending.is_null() || patch_keys.iter().any(|key| *key != "mechanics" && *key != "autonomy") {
            continue;
        }
        let id = ending["id"].as_str().expect("id развязки").to_string();
        if seen.contains(&id) {
            continue;
        }
        let ready = spread(&bases[case["base"].as_u64().expect("основа") as usize], &case["patch"]);
        let command = json!({ "command_type": "CompleteCampaign", "command_id": format!("scenario-complete-{id}"), "reason": "main_thread_resolved_at_climax", "epilogue": ending["epilogue"] });
        let mut dice = ServiceDice::new(DiceService::deterministic(NoRolls, "complete"));
        let mut uuid = sequence_uuids("complete");
        let outcome = api::resolve_command(&command, &ready, &mut dice, &Context::from_json(&json!({ "isDirector": true })), &mut uuid).unwrap_or_else(|error| panic!("{id}: {error}"));
        let Outcome::Committed(resolved) = outcome else { panic!("{id}: завершение не ждёт решения") };
        let completed = resolved.events.iter().find(|event| event["event_type"] == "CampaignCompleted").unwrap_or_else(|| panic!("{id}: нет CampaignCompleted"));
        assert_eq!(completed["payload"]["ending"], json!({ "id": ending["id"], "title": ending["title"], "outcome": ending["outcome"] }), "{id}");

        // Replay потока события от состояния до команды — развязка из журнала.
        let replayed = lifecycle(&replay_events(&ready, &resolved.events).expect("replay"));
        assert_eq!(replayed["status"], "completed", "{id}");
        assert_eq!(replayed["ending"]["id"], ending["id"], "{id}");
        assert_eq!(replayed["ending"]["title"], ending["title"], "{id}");
        seen.push(id);
    }
    seen.sort();
    assert_eq!(seen, ["banished", "defeat", "slain", "treaty"], "все четыре развязки Асстохана");
}
