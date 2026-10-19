//! Помощники Р4б против JS: переход сцены, план торговли, ссылка на решение
//! группы, поля жизненного цикла торговцев, срок призывов, общество.
//!
//! Эталон снимает `fixtures/gen-helpers-r4b.mjs`. Чистые функции сверяются
//! всегда; зависящие от состояния — на состояниях корпуса из `SK_CORPUS`
//! (тест `#[ignore]`).

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::RuleError;
use sk_rules::normalize::{scene, summons};
use sk_rules::pause::Halt;
use sk_rules::society_helpers as society;

static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/helpers-r4b.json")).expect("эталон читается")).expect("эталон"));

/// Аргумент эталона: `{ "$undefined": true }` — `undefined`.
fn arg(case: &Value, index: usize) -> Option<&Value> {
    let value = case["a"].get(index)?;
    (value.get("$undefined").is_none()).then_some(value)
}

enum Outcome {
    Value(Value),
    Rule(RuleError),
    Halt(Halt),
}

fn rule(result: Result<Value, RuleError>) -> Outcome {
    match result {
        Ok(value) => Outcome::Value(value),
        Err(error) => Outcome::Rule(error),
    }
}

fn undefined() -> Value {
    json!({ "undefined": true })
}

fn pure(case: &Value) -> Outcome {
    let a = |index| arg(case, index);
    match case["f"].as_str().unwrap_or_default() {
        "normalizeSceneAdvanceArgs" => rule(scene::normalize_scene_advance_args(a(0))),
        "canonicalSceneMetadata" => Outcome::Value(scene::canonical_scene_metadata(a(0).unwrap_or(&Value::Null), a(1))),
        "normalizeSceneCommerce" => rule(scene::normalize_scene_commerce(a(0))),
        "normalizePartyDecisionReference" => rule(scene::normalize_party_decision_reference(a(0), a(1).and_then(Value::as_bool).unwrap_or(false))),
        "lifecycleText" => rule(scene::lifecycle_text(a(0), 20, a(2).and_then(Value::as_bool).unwrap_or(false), "запас", "C", "Поле").map(Value::String)),
        "lifecycleInteger" => rule(scene::lifecycle_integer(a(0), 0, 100, json!(3), "C", "Число")),
        "lifecyclePurseCp" => rule(scene::lifecycle_purse_cp(a(0), None)),
        "lifecycleId" => rule(scene::lifecycle_id(a(0), "C", "id").map(Value::String)),
        "lifecycleObject" => rule(scene::lifecycle_object(a(0), "C", "Торговец").map(|fields| Value::Object(fields.clone()))),
        "assertLifecycleKeys" => rule(scene::assert_lifecycle_keys(a(0).and_then(Value::as_object).expect("объект"), &["a"], "C", "Торговец").map(|()| undefined())),
        "privateAdventureBuckets" => Outcome::Value(Value::Object(scene::private_adventure_buckets(a(0)))),
        "pickpocketSpentCondition" => Outcome::Value(Value::String(society::pickpocket_spent_condition(a(0)))),
        "addInventoryItem" => Outcome::Value(society::add_inventory_item(a(0), a(1).unwrap_or(&Value::Null))),
        other => panic!("неизвестная функция {other}"),
    }
}

fn ids(list: Vec<Value>) -> Value {
    Value::Array(list.iter().map(|summon| summon.get("id").cloned().unwrap_or(Value::Null)).collect())
}

fn stateful(case: &Value, state: &Value, command: &Value) -> Outcome {
    let a = |index| arg(case, index);
    let number = |index| a(index).and_then(Value::as_f64).unwrap_or(0.0);
    match case["f"].as_str().unwrap_or_default() {
        "npcRelationshipEventsFrom" => Outcome::Value(Value::Array(society::npc_relationship_events_from(command, state, a(0), a(1), a(2), Some(&json!("причина"))))),
        "fenceStanceFor" => Outcome::Value(society::fence_stance_for(state, a(0), a(1))),
        "npcDepartureEvents" => match society::npc_departure_events(command, state, a(0).and_then(Value::as_str).unwrap_or_default()) {
            Ok(events) => Outcome::Value(Value::Array(events)),
            Err(halt) => Outcome::Halt(halt),
        },
        "livingPartySize" => Outcome::Value(json!(society::living_party_size(state))),
        "tavernRoundsClosedByDeparture" => Outcome::Value(Value::Array(society::tavern_rounds_closed_by_departure(command, state, a(0).unwrap_or(&Value::Null)))),
        "tavernRoundCancelledEvent" => Outcome::Value(society::tavern_round_cancelled_event(command, state, a(0).unwrap_or(&Value::Null), a(1).unwrap_or(&Value::Null), None)),
        "partySummonsForExpiry" => Outcome::Value(ids(summons::party_summons_for_expiry(state))),
        "summonIdsExpiredAt" => Outcome::Value(json!(summons::summon_ids_expired_at(state, number(0)))),
        "expiredSummonsBetween" => Outcome::Value(ids(summons::expired_summons_between(state, number(0), number(1)))),
        "summonExpiryEvents" => Outcome::Value(Value::Array(summons::summon_expiry_events(command, state, &summons::expired_summons_between(state, number(0), number(1)), true))),
        other => panic!("неизвестная функция {other}"),
    }
}

/// `None` — совпало с эталоном.
fn compare(outcome: Outcome, case: &Value) -> Option<String> {
    match (outcome, case.get("throws").and_then(Value::as_str)) {
        (Outcome::Value(value), None) => (sk_core::js::stringify(&value) != sk_core::js::stringify(&case["ok"])).then(|| format!("JS {} / Rust {}", case["ok"], value)),
        (Outcome::Rule(error), Some(message)) => (error.message != message || Some(error.code.as_str()) != case["code"].as_str()).then(|| format!("отказ JS {message} {} / Rust {} {}", case["code"], error.message, error.code)),
        (Outcome::Halt(halt), Some(message)) => (!halt.to_string().contains(message) || halt.code() != case["code"].as_str()).then(|| format!("отказ JS {message} / Rust {halt}")),
        (Outcome::Value(value), Some(message)) => Some(format!("JS бросает {message}, Rust {value}")),
        (Outcome::Rule(error), None) => Some(format!("Rust бросает {} {}", error.code, error.message)),
        (Outcome::Halt(halt), None) => Some(format!("Rust бросает {halt}")),
    }
}

#[test]
fn pure_helpers_match_js() {
    let mut failures = Vec::new();
    let cases = DATA["pure"].as_array().expect("случаи");
    for (index, case) in cases.iter().enumerate() {
        if let Some(failure) = compare(pure(case), case) {
            failures.push(format!("#{index} {} {}: {failure}", case["f"], case["a"]));
        }
    }
    assert!(failures.is_empty(), "{} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
#[ignore = "читает состояния корпуса из SK_CORPUS"]
fn state_helpers_match_js_on_corpus() {
    let Ok(root) = std::env::var("SK_CORPUS") else { return };
    let command = &DATA["command"];
    let mut total = 0;
    let mut failures = Vec::new();
    for entry in DATA["stateful"].as_array().expect("состояния") {
        let hash = entry["state_hash"].as_str().unwrap_or_default();
        let Ok(text) = std::fs::read_to_string(format!("{root}/states/{hash}.json")) else { continue };
        let raw: Value = serde_json::from_str(&text).expect("состояние");
        let state = sk_rules::normalize::normalize_campaign_state(&raw).expect("нормализация");
        for case in entry["cases"].as_array().into_iter().flatten() {
            total += 1;
            if let Some(failure) = compare(stateful(case, &state, command), case) {
                failures.push(format!("{hash} {} {}: {failure}", case["f"], case["a"]));
            }
        }
    }
    assert!(total > 1000, "сверено случаев: {total}");
    assert!(failures.is_empty(), "{} из {total}:\n{}", failures.len(), failures.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}
