//! `npc_positioning`: эталон JS (`fixtures/npc-positioning.json`) — сценарии
//! тестов модуля через настоящий Rules Engine, перехват вызовов в конвейере
//! на корпусе паритета и случайные сцены с мусором старых сохранений.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_core::indexmap::IndexSet;
use sk_npc_world::npc_positioning::*;

fn targets(list: Vec<NpcTarget>) -> Value {
    Value::Array(list.iter().map(NpcTarget::to_json).collect())
}

fn cells(set: IndexSet<String>) -> Value {
    Value::Array(set.into_iter().map(Value::String).collect())
}

fn options(args: &Args, index: usize) -> &Value {
    args.value(index)
}

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    match name {
        "normalizeNpcWorldState" => ok(normalize_npc_world_state(a(0), v(1))),
        "normalizeNpcWorldStateLegacy" => ok(normalize_npc_world_state_legacy(a(0))),
        "sceneLocationId" => ok(json!(scene_location_id(v(0)))),
        "presentSceneNpcs" => ok(Value::Array(present_scene_npcs(v(0)))),
        "npcPlacementFor" => ok_opt(npc_placement_for(v(0), v(1), a(2))),
        "npcVitalFor" => ok(npc_vital_for(v(0), v(1))),
        "npcMechanicsFor" => ok_opt(npc_mechanics_for(v(0), v(1))),
        "npcCombatActorFor" => ok_opt(npc_combat_actor_for(v(0), v(1))),
        "npcInteractionTargetForViewer" => ok_opt(npc_interaction_target_for_viewer(v(0), v(1)).map(|target| target.to_json())),
        "initialNpcVital" => ok(initial_npc_vital(a(0))),
        "isValidNpcPost" => {
            let occupied = args.option(2, "occupied").and_then(Value::as_array).map(|items| items.iter().map(|item| sk_core::js::s(Some(item))).collect());
            let except = args.option(2, "exceptNpcId").map(|value| sk_core::js::s(Some(value))).unwrap_or_default();
            ok(json!(is_valid_npc_post(v(0), a(1), occupied, &except)))
        }
        "planSceneNpcPlacementEvents" => ok(Value::Array(plan_scene_npc_placement_events(v(0)))),
        "validateNpcWorldCommand" => match validate_npc_world_command(v(0), v(1), v(2)) {
            Ok(command) => ok(command),
            Err(error) => Err(common::JsError::new(NpcWorldValidationError::NAME, &error.code, &error.message)),
        },
        "placedSceneNpcTargets" => ok(targets(placed_scene_npc_targets(v(0)))),
        "sceneNpcOccupiedCells" => ok(cells(scene_npc_occupied_cells(v(0)))),
        "sceneNpcTransitCells" => ok(cells(scene_npc_transit_cells(v(0)))),
        "npcTargetsWithinArea" => ok(targets(npc_targets_within_area(v(0), a(1), a(2)))),
        "npcMissCollateralTarget" => ok_opt(
            npc_miss_collateral_target(v(0), args.option(1, "targetPosition"), args.option(1, "attackTotal"), args.option(1, "armorClass")).map(|target| target.to_json()),
        ),
        "npcHarmEventDrafts" => ok(Value::Array(npc_harm_event_drafts(v(0), &NpcHarmOptions::from_json(options(args, 1))))),
        "planAuthoredNpcWorldEvents" => {
            let command_id = args.option(3, "commandId").cloned().unwrap_or_else(|| json!(""));
            let actor_id = args.option(3, "actorId").cloned().unwrap_or_else(|| json!(""));
            ok(Value::Array(plan_authored_npc_world_events(v(0), v(1), v(2), &command_id, &actor_id)))
        }
        "npcCombatStanceEventDrafts" => {
            let source = args.option(1, "sourceEventId").cloned().unwrap_or_else(|| json!(""));
            let participants = args.option(1, "participantIds").cloned().unwrap_or_else(|| json!([]));
            ok(Value::Array(npc_combat_stance_event_drafts(v(0), &source, &participants)))
        }
        "applyNpcWorldEvent" => ok(apply_npc_world_event(a(0), v(1), v(2))),
        "sceneNpcsForViewer" => ok(Value::Array(scene_npcs_for_viewer(v(0)))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn npc_positioning_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-positioning.json"));
    let summary = check(&fixture, run);
    assert!(summary.calls > 7_000, "{summary:?}");
    println!("{summary:?}");
    assert!(summary.legacy > 1_000, "{summary:?}");
}
