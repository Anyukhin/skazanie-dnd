//! Сверка `pickpocket` с эталоном JS (`fixtures/pickpocket.json`, генератор —
//! `fixtures/gen-pickpocket.mjs`) и перенесённые проверки кармана и сложности
//! из `test/pickpocket.test.mjs` (команда, проекция и HTTP-путь остаются за
//! Rules Engine).

mod common;

use common::{check, ok, ok_or_null, Outcome};
use serde_json::{json, Value};
use sk_items::pickpocket as m;

#[test]
fn pickpocket_matches_js() {
    let count = check(include_str!("../fixtures/pickpocket.json"), |name, args| -> Outcome {
        let state = args.get(0).cloned().unwrap_or(Value::Null);
        let npc = args.get(1).cloned().unwrap_or(Value::Null);
        match name {
            "const:PICKPOCKET_POLICY_ID" => ok(json!(m::PICKPOCKET_POLICY_ID)),
            "const:PICKPOCKET_SKILL" => ok(json!(m::PICKPOCKET_SKILL)),
            "const:PICKPOCKET_ABILITY" => ok(json!(m::PICKPOCKET_ABILITY)),
            "const:PICKPOCKET_CROWD_STEPS" => ok(Value::Array(m::PICKPOCKET_CROWD_STEPS.iter().map(m::PickpocketCrowdStep::to_json).collect())),
            "const:PICKPOCKET_MIN_DC" => ok(json!(m::PICKPOCKET_MIN_DC)),
            "const:PICKPOCKET_MAX_DC" => ok(json!(m::PICKPOCKET_MAX_DC)),
            "npcPocketFor" => ok_or_null(m::npc_pocket_for(&state, &npc)),
            "npcPassiveInsightFor" => ok(json!(m::npc_passive_insight_for(&state, &npc))),
            "pickpocketDifficultyFor" => ok(m::pickpocket_difficulty_for(&state, &npc, args.get(2))),
            "pickpocketCrowdStep" => ok(m::pickpocket_crowd_step(args.get(0)).to_json()),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 1_500, "{count}");
}

fn state() -> Value {
    json!({ "sessionCode": "THIEF-UNIT" })
}

#[test]
fn pocket_is_derived_from_seed_not_stored() {
    let state = state();
    let merchant = json!({ "id": "npc-1", "role": "купец" });
    let first = m::npc_pocket_for(&state, &merchant).expect("карман");
    assert_eq!(Some(&first), m::npc_pocket_for(&state, &merchant).as_ref(), "replay обязан дать тот же карман");
    assert!(first["purse_cp"].as_i64().unwrap_or(0) > 0);
    assert_ne!(Some(&first), m::npc_pocket_for(&state, &json!({ "id": "npc-2", "role": "купец" })).as_ref(), "у разных людей карманы разные");
    assert_ne!(Some(&first), m::npc_pocket_for(&json!({ "sessionCode": "OTHER" }), &merchant).as_ref(), "другая кампания — другой карман");
    // Нищий беднее купца по построению таблицы, а не по удаче броска.
    assert!(m::npc_pocket_for(&state, &json!({ "id": "npc-3", "role": "нищий" })).expect("нищий")["purse_cp"].as_i64().unwrap_or(99) < 20);
    assert_eq!(m::npc_pocket_for(&state, &json!({})), None);
}

#[test]
fn crowd_helps_the_thief_and_privacy_helps_the_victim() {
    let state = state();
    let npc = json!({ "id": "npc-1", "role": "купец" });
    let alone = m::pickpocket_difficulty_for(&state, &npc, Some(&json!(1)));
    let crowd = m::pickpocket_difficulty_for(&state, &npc, Some(&json!(8)));
    assert!(crowd["difficulty"].as_i64() < alone["difficulty"].as_i64(), "в толчее рука теряется, наедине — нет");
    assert_eq!(alone["crowd_label"], json!("наедине"));
    assert_eq!(crowd["crowd_label"], json!("в толчее"));
    assert_eq!(m::pickpocket_crowd_step(Some(&json!(0))).shift, 3);
    assert_eq!(m::pickpocket_crowd_step(Some(&json!(999))).shift, -3);
    for count in 0..=12 {
        assert!(m::PICKPOCKET_CROWD_STEPS.contains(m::pickpocket_crowd_step(Some(&json!(count)))));
    }
    assert_eq!(alone["difficulty"], json!(m::npc_passive_insight_for(&state, &npc) + 3));
}
