//! Эталоны JS `fixtures/director-scene-transition.json.gz` (генератор
//! `fixtures/gen-director-scene-transition.mjs`) и перенос проверок
//! `test/director-scene-transition.test.mjs`,
//! `test/director-transition-clock.test.mjs` (часть про пакет команд).
//!
//! Итог перехода и предложение лавки сверяются SHA-256 строки
//! `JSON.stringify`; у `TypeError` — только имя.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_director::director_scene_transition::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/director-scene-transition.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    serde_json::from_str(&text).expect("эталон JSON")
});

fn hash(value: &Value) -> String {
    sk_core::hash::sha256_hex(js::stringify(value))
}

fn args(entry: &Value) -> Vec<Option<Value>> {
    let undef: Vec<u64> = entry["undef"].as_array().map(|items| items.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    entry["args"]
        .as_array()
        .expect("аргументы")
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let mut value = value.clone();
            if let Some(reference) = value.get("state").and_then(|state| state.get("$ref")).and_then(Value::as_u64) {
                value["state"] = FIXTURE["values"][reference as usize].clone();
            }
            (!undef.contains(&(index as u64))).then_some(value)
        })
        .collect()
}

fn type_error() -> DirectorTransitionError {
    DirectorTransitionError { name: "TypeError".into(), code: None, message: String::new() }
}

fn input_of(value: &Value) -> DirectorTransitionInput<'_> {
    let field = |key: &str| value.get(key);
    DirectorTransitionInput {
        campaign_id: field("campaignId"),
        action: field("action"),
        state: field("state"),
        scene_args: field("sceneArgs"),
        shop_intent: field("shopIntent"),
        party_decision: field("partyDecision"),
        abandon_quest: field("abandonQuest"),
    }
}

fn call(fn_name: &str, args: &[Option<Value>]) -> Result<Value, DirectorTransitionError> {
    let a = |index: usize| args.get(index).and_then(Option::as_ref);
    let empty = json!({});
    // Деструктуризация параметров JS: `undefined` — `{}`, `null` — `TypeError`.
    let options = |index: usize| match a(index) {
        Some(Value::Null) => Err(type_error()),
        other => Ok(other.unwrap_or(&empty)),
    };
    Ok(match fn_name {
        "resolvedPartyDecisionReference" => {
            let required = !js::is_false(options(1)?.get("required"));
            resolved_party_decision_reference(a(0), required)?.unwrap_or(Value::Null)
        }
        "directorTransitionFingerprint" => {
            let input = options(0)?;
            Value::String(director_transition_fingerprint(input.get("campaignId"), input.get("action"))?)
        }
        "directorDecisionFingerprint" => {
            let input = options(0)?;
            Value::String(director_decision_fingerprint(input.get("campaignId"), input.get("partyDecision"))?)
        }
        "buildDirectorTransitionCommands" => {
            let input = options(0)?;
            let mut out = build_director_transition_commands(input_of(input))?;
            out["transition"] = json!(hash(&out["transition"]));
            if !out["shopProposal"].is_null() {
                out["shopProposal"] = json!(hash(&out["shopProposal"]));
            }
            out
        }
        "assertDirectorTransitionResult" => assert_director_transition_result(a(0), a(1))?,
        other => panic!("неизвестная функция эталона: {other}"),
    })
}

fn error_json(error: &DirectorTransitionError) -> Value {
    if error.name == "TypeError" {
        json!({ "name": "TypeError" })
    } else {
        error.to_json()
    }
}

#[test]
fn director_transition_calls_match_js() {
    let cases = FIXTURE["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in cases {
        let fn_name = case["fn"].as_str().expect("fn");
        let label = format!("{fn_name} {} {}", case["label"].as_str().unwrap_or(""), js::stringify(&case["args"]).chars().take(200).collect::<String>());
        let actual = match call(fn_name, &args(case)) {
            Ok(value) => json!({ "out": value }),
            Err(error) => json!({ "error": error_json(&error) }),
        };
        let expected = match case.get("error") {
            Some(error) if error["name"] == "TypeError" => json!({ "error": { "name": "TypeError" } }),
            Some(error) => json!({ "error": error }),
            None => json!({ "out": case["out"] }),
        };
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!(
                "{label}\n  JS:   {}\n  Rust: {}",
                js::stringify(&expected).chars().take(1200).collect::<String>(),
                js::stringify(&actual).chars().take(1200).collect::<String>()
            ));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}:\n{}", failures.len(), cases.len(), failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() > 500, "вызовов: {}", cases.len());
}

// --- перенос проверок test/director-scene-transition.test.mjs ------------------------------

fn state(merchants: Value) -> Value {
    json!({
        "sessionCode": "DIRECTOR-1",
        "state_version": 7,
        "players": [{ "id": "hero", "x": 1, "y": 1 }],
        "merchants": merchants,
        "scene": { "title": "Склеп", "location": "Склеп Норвин", "objective": "Найти выход", "turn": 3, "cells": [] },
        "adventure": { "chapter": 1, "history": [], "visitedLocations": ["Склеп Норвин"] },
        "agentInteraction": {
            "id": "decision-1", "type": "vote", "status": "resolved", "resolvedOptionId": "go",
            "options": [{ "id": "go", "label": "Идём дальше" }], "votes": { "hero": "go" },
        },
    })
}

fn urban_scene() -> Value {
    json!({ "title": "Глава 2 · Город Норвин", "location": "Город Норвин", "theme": "городские улицы", "objective": "Найти архив гильдии", "seed": "director-city", "map": { "layout": "streets", "width": 11, "height": 9 } })
}

fn forest_scene(seed: &str) -> Value {
    json!({ "title": "Чаща", "location": "Серая чаща", "theme": "дикая местность", "objective": "Осмотреться", "seed": seed })
}

fn build(action: &str, state: &Value, scene: &Value, shop: Option<&Value>, abandon: Option<&Value>) -> Value {
    let campaign = json!("DIRECTOR-1");
    let action = json!(action);
    build_director_transition_commands(DirectorTransitionInput {
        campaign_id: Some(&campaign),
        action: Some(&action),
        state: Some(state),
        scene_args: Some(scene),
        shop_intent: shop,
        abandon_quest: abandon,
        ..DirectorTransitionInput::default()
    })
    .expect("пакет перехода")
}

fn types(planned: &Value) -> Vec<String> {
    planned["commands"].as_array().unwrap().iter().map(|command| js::s(command.get("command_type"))).collect()
}

#[test]
fn city_gets_atomic_batch_with_catalog_merchant() {
    let planned = build("[РЕШЕНИЕ ГРУППЫ] Идём в город", &state(json!([])), &urban_scene(), None, None);
    assert_eq!(types(&planned), ["AdvanceTime", "AdvanceScene", "CreateMerchant"]);
    assert_eq!(planned["commands"][1]["request_fingerprint"], planned["commands"][2]["request_fingerprint"]);
    assert_eq!(planned["commands"][1]["party_decision"], json!({ "interaction_id": "decision-1", "resolved_option_id": "go" }));
    assert_eq!(planned["partyDecision"], planned["commands"][1]["party_decision"]);
    assert_eq!(planned["commands"][2]["merchant"]["location"], "Город Норвин");
    assert!(planned["commands"][2]["merchant"]["stock"].as_array().unwrap().iter().all(|item| item["catalog_id"].as_str().unwrap().starts_with("srd_5_2_1:")));
    assert_eq!(planned["shopIntent"]["action"], "create");
    assert_eq!(planned["shopIntent"]["settlement_type"], "city");
}

#[test]
fn abandoned_quest_rides_the_same_batch() {
    let quest = json!({ "id": "quest:main", "title": "Найти выход" });
    let planned = build("[РЕШЕНИЕ ГРУППЫ] Уходим и бросаем задание", &state(json!([])), &forest_scene("forest-abandon"), None, Some(&quest));
    assert_eq!(types(&planned), ["AdvanceTime", "AdvanceScene", "ResolveQuest"]);
    assert_eq!(planned["abandonedQuestId"], "quest:main");
    let resolve = &planned["commands"][2];
    assert_eq!(resolve["outcome"], "abandoned");
    assert_eq!(resolve["request_fingerprint"], planned["fingerprint"]);
    assert!(resolve["summary"].as_str().unwrap().contains("Склеп Норвин"));
    assert!(!resolve["next_objective"].as_str().unwrap().is_empty());
    let without = build("[РЕШЕНИЕ ГРУППЫ] Уходим в чащу", &state(json!([])), &forest_scene("forest-abandon"), None, None);
    assert_eq!(types(&without), ["AdvanceTime", "AdvanceScene"]);
    assert_eq!(without["abandonedQuestId"], Value::Null);
}

#[test]
fn forest_never_becomes_a_settlement() {
    let none_city = json!({ "action": "none", "settlement_type": "city", "theme": "general", "budget_cp": 50_000, "reason": "Торговая точка не запрашивается." });
    let planned = build("[РЕШЕНИЕ ГРУППЫ] Идём в чащу", &state(json!([])), &forest_scene("forest-none-city"), Some(&none_city), None);
    assert_eq!(types(&planned), ["AdvanceTime", "AdvanceScene"]);
    assert_eq!(planned["commands"][1]["scene_args"]["scene_kind"], "wilderness");
    assert_eq!(planned["commands"][1]["scene_args"]["settlement_type"], Value::Null);
    assert_eq!(planned["commands"][1]["scene_commerce"]["outcome"], "not-requested");
    assert_eq!(planned["commands"][1]["scene_commerce"]["merchant_id"], Value::Null);
    let outpost = json!({ "action": "create", "settlement_type": "outpost", "theme": "provisions", "budget_cp": 12_000, "reason": "Ошибка." });
    let planned = build("[РЕШЕНИЕ ГРУППЫ] Уходим в лес", &state(json!([])), &forest_scene("forest-create-outpost"), Some(&outpost), None);
    assert_eq!(types(&planned), ["AdvanceTime", "AdvanceScene"]);
    assert_eq!(planned["shopIntent"]["action"], "none");
    assert_eq!(planned["shopProposal"], Value::Null);
}

#[test]
fn revisit_reuses_merchant_at_location() {
    let merchants = json!([{ "id": "norvin-shop", "location": "  ГОРОД   НОРВИН  ", "stock": [{ "stock_id": "rope", "quantity": 1 }] }]);
    let planned = build("[РЕШЕНИЕ ГРУППЫ] Возвращаемся в город", &state(merchants), &urban_scene(), None, None);
    assert_eq!(types(&planned), ["AdvanceTime", "AdvanceScene"]);
    assert_eq!(planned["existingMerchantId"], "norvin-shop");
    assert_eq!(planned["commands"][1]["scene_commerce"]["outcome"], "reused");
}

#[test]
fn fingerprint_is_semantic_and_shop_seed_follows_decision() {
    let campaign = json!("DIRECTOR-1");
    let first = director_transition_fingerprint(Some(&campaign), Some(&json!("  Идём   в город "))).unwrap();
    let retry = director_transition_fingerprint(Some(&campaign), Some(&json!("Идём в город"))).unwrap();
    let conflict = director_transition_fingerprint(Some(&campaign), Some(&json!("Идём в лес"))).unwrap();
    assert_eq!(first, retry);
    assert_ne!(first, conflict);

    let shop = json!({ "action": "create", "settlement_type": "city", "theme": "general", "budget_cp": 20_000 });
    let decision = json!({ "interaction_id": "vote-stable", "resolved_option_id": "city" });
    let state = state(json!([]));
    let scene = urban_scene();
    let plan = |action: &str| {
        let action = json!(action);
        build_director_transition_commands(DirectorTransitionInput {
            campaign_id: Some(&campaign),
            action: Some(&action),
            state: Some(&state),
            scene_args: Some(&scene),
            shop_intent: Some(&shop),
            party_decision: Some(&decision),
            abandon_quest: None,
        })
        .unwrap()
    };
    let (a, b) = (plan("[РЕШЕНИЕ ГРУППЫ] Идём в город nonce-a"), plan("[РЕШЕНИЕ ГРУППЫ] Идём в город nonce-b"));
    assert_ne!(a["fingerprint"], b["fingerprint"]);
    assert_eq!(a["decisionFingerprint"], b["decisionFingerprint"]);
    assert_eq!(a["shopProposal"], b["shopProposal"]);
}

#[test]
fn result_assertion_rejects_foreign_events() {
    let fingerprint = json!("a".repeat(64));
    let ok = json!({ "mechanics": [{ "event_type": "SceneAdvanced", "payload": { "request_fingerprint": fingerprint } }] });
    assert_eq!(assert_director_transition_result(Some(&ok), Some(&fingerprint)).unwrap()["mechanics"].as_array().unwrap().len(), 1);
    let other = json!({ "mechanics": [{ "event_type": "SceneAdvanced", "payload": { "request_fingerprint": "b".repeat(64) } }] });
    assert_eq!(assert_director_transition_result(Some(&other), Some(&fingerprint)).unwrap_err().code.as_deref(), Some("IDEMPOTENCY_CONFLICT"));
    let foreign_abandon = json!({ "mechanics": [
        { "event_type": "SceneAdvanced", "payload": { "request_fingerprint": fingerprint } },
        { "event_type": "QuestResolved", "payload": { "outcome": "abandoned", "request_fingerprint": "другой-запрос" } },
    ] });
    assert!(assert_director_transition_result(Some(&foreign_abandon), Some(&fingerprint)).is_err());
    let clock_resolution = json!({ "mechanics": [
        { "event_type": "SceneAdvanced", "payload": { "request_fingerprint": fingerprint } },
        { "event_type": "QuestResolved", "payload": { "outcome": "success" } },
    ] });
    assert!(assert_director_transition_result(Some(&clock_resolution), Some(&fingerprint)).is_ok());
}

/// `test/director-transition-clock.test.mjs`: переход по карте мира ставит
/// мировые минуты пути в тот же пакет (дорога в 4 перехода — 150 минут).
/// Состояние — перехваченный вызов теста: `normalizeCampaignState` движка в
/// крейт не входит, а без него часы пути другие (120 минут и в JS).
#[test]
fn group_transition_carries_travel_clock() {
    let case = FIXTURE["calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["fn"] == "buildDirectorTransitionCommands" && case["label"].as_str().unwrap_or("").starts_with("test/групповой переход"))
        .expect("вызов теста часов");
    let input = &args(case)[0];
    let planned = build_director_transition_commands(input_of(input.as_ref().unwrap())).unwrap();
    assert_eq!(planned["commands"][0]["command_type"], "AdvanceTime");
    assert_eq!(planned["commands"][0]["amount"], 150);
    assert_eq!(planned["commands"][1]["command_type"], "AdvanceScene");
}
