//! `captives`: эталон JS (`fixtures/captives.json`) — сценарии тестов модуля
//! через настоящий Rules Engine, перехват вызовов в конвейере на корпусе
//! паритета и случайные пленные с мусором старых сохранений.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_world_life::captives::*;

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    let empty = json!({});
    // Параметр по умолчанию `= {}` в JS: `undefined` — пустой объект.
    let d = |index: usize| args.get(index).unwrap_or(&empty);
    match name {
        "captiveBandId" => ok(json!(captive_band_id(a(0), a(1)))),
        "captivePersona" => ok(captive_persona(d(0), d(1))),
        "normalizeCaptivesState" => ok(normalize_captives_state(a(0))),
        "captiveList" => ok(Value::Array(captive_list(d(0)))),
        "captiveFor" => ok_opt(captive_for(d(0), a(1))),
        "heldCaptiveForNpc" => ok_opt(held_captive_for_npc(d(0), a(1))),
        "heldCaptives" => ok(Value::Array(held_captives(d(0)))),
        "captiveIdFor" => ok(json!(captive_id_for(v(0), a(1)))),
        "captiveOriginFor" => ok_opt(captive_origin_for(d(0), d(1)).map(Value::from)),
        "capturableEnemies" => ok(Value::Array(capturable_enemies(d(0)).iter().map(CapturableEnemy::to_json).collect())),
        "captiveKnowledgeDrafts" => ok(captive_knowledge_drafts(d(0), d(1))),
        "planCaptureDrafts" => ok(Value::Array(plan_capture_drafts(d(0)))),
        "planCaptiveRelocationDrafts" => ok(Value::Array(plan_captive_relocation_drafts(d(0)))),
        "captiveInterrogationPolicy" => ok(captive_interrogation_policy(d(0), d(1), d(2))),
        "captiveSparedDisposition" => ok(json!(captive_spared_disposition(d(0)))),
        "captiveBountyCp" => ok(json!(captive_bounty_cp(d(0)))),
        "captiveSettlementFor" => ok_opt(captive_settlement_for(d(0))),
        "localFactionIds" => ok(json!(local_faction_ids(d(0)))),
        "planCaptiveNeglectCommands" => ok(Value::Array(plan_captive_neglect_commands(d(0), args.option(1, "worldMinute")))),
        "captiveNeglectedPayload" => ok(captive_neglected_payload(v(0), a(1))),
        "planCaptiveNeglectDrafts" => ok(Value::Array(plan_captive_neglect_drafts(d(0), args.option(1, "worldMinute")))),
        "captiveForViewer" => ok_opt(captive_for_viewer(Some(d(0)))),
        "captivesForViewer" => ok(captives_for_viewer(d(0), d(1))),
        "applyCaptiveEvent" => ok(apply_captive_event(a(0), v(1), d(2))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn captives_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/captives.json"));
    let summary = check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 12_000, "{summary:?}");
}
