//! Проверки `test/npc-positioning.test.mjs` (и `destructive-wave-npc-temp`,
//! `npc-item-transfer`, `npc-retention` в части модуля) над состояниями,
//! которые генератор эталона собрал настоящим Rules Engine (метки
//! `fixtures/npc-positioning.json`). Что там идёт через движок и проекцию,
//! здесь проверяется на выходе самого модуля.

mod common;

use std::collections::HashSet;

use common::Fixture;
use serde_json::{json, Value};
use sk_npc_world::npc_positioning::*;
use sk_society::retention_context::with_retention_mode;

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/npc-positioning.json"))
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|event| event["event_type"] == kind).collect()
}

fn apply_all(world: &Value, events: &[Value]) -> Value {
    events.iter().fold(world.clone(), |world, event| apply_npc_world_event(Some(&world), event, &Value::Null))
}

fn with_world(state: &Value, world: Value) -> Value {
    let mut state = state.clone();
    state["npc_world"] = world;
    state
}

#[test]
fn scene_architect_gets_a_deterministic_free_post_next_to_a_suitable_prop() {
    let fixture = fixture();
    let state = fixture.labelled("npc-state");
    let first = plan_scene_npc_placement_events(state);
    assert_eq!(first, plan_scene_npc_placement_events(state));
    assert_eq!(first.len(), 2);
    assert_eq!(first[0]["event_type"], "NpcPlaced");
    let marta = first.iter().find(|event| event["payload"]["npc_id"] == "marta").expect("пост Марты");
    assert_eq!(marta["payload"]["anchor_prop_id"], "bar-1");
    let (x, y) = (marta["payload"]["x"].as_i64().expect("x"), marta["payload"]["y"].as_i64().expect("y"));
    assert_eq!((x - 7).abs().max((y - 2).abs()), 1);
}

#[test]
fn initial_posts_do_not_overlap_the_party_or_each_other() {
    let fixture = fixture();
    let planned = plan_scene_npc_placement_events(fixture.labelled("npc-state-two"));
    assert_eq!(planned.len(), 2);
    let positions: Vec<String> = planned.iter().map(|event| format!("{},{}", event["payload"]["x"], event["payload"]["y"])).collect();
    assert_eq!(positions.iter().collect::<HashSet<_>>().len(), positions.len(), "два NPC не должны получить один пост");
    assert!(positions.iter().all(|position| position != "0,1"), "пост NPC не должен занимать клетку героя");
}

#[test]
fn placed_npc_post_is_an_occupied_cell() {
    let fixture = fixture();
    let cells: Vec<String> = scene_npc_occupied_cells(fixture.labelled("observer")).into_iter().collect();
    assert_eq!(cells, vec!["2,1".to_string()]);
}

#[test]
fn peaceful_npc_allows_transit_but_hostile_blocks() {
    let fixture = fixture();
    let corridor = fixture.labelled("corridor");
    assert_eq!(scene_npc_occupied_cells(corridor).into_iter().collect::<Vec<_>>(), vec!["2,0".to_string()]);
    assert_eq!(scene_npc_transit_cells(corridor).into_iter().collect::<Vec<_>>(), vec!["2,0".to_string()]);
    assert!(scene_npc_transit_cells(fixture.labelled("corridor-hostile")).is_empty());
}

#[test]
fn auto_post_reserves_existing_post_and_party_cell() {
    let fixture = fixture();
    let state = fixture.labelled("auto-post-blocked");
    let command = validate_npc_world_command(&json!({ "command_type": "PlaceNpc", "command_id": "place-teren-auto", "npc_id": "teren" }), state, &json!({ "isDirector": true })).expect("автопост");
    let hero = &state["players"][0];
    let to = &command["to"];
    assert_ne!((to["x"].clone(), to["y"].clone()), (hero["x"].clone(), hero["y"].clone()), "автопост не должен занимать клетку партии");
    assert_ne!((to["x"].clone(), to["y"].clone()), (json!(6), json!(2)), "автопост не должен занимать пост Марты");
}

#[test]
fn place_and_move_are_system_only_and_replay_into_the_world() {
    let fixture = fixture();
    let initial = fixture.labelled("npc-state");
    let forbidden = validate_npc_world_command(&json!({ "command_type": "PlaceNpc", "npc_id": "marta", "to": { "x": 6, "y": 2 } }), initial, &json!({})).expect_err("только системный контур");
    assert_eq!(forbidden.code, "NPC_WORLD_FORBIDDEN");
    let on_bar = validate_npc_world_command(&json!({ "command_type": "PlaceNpc", "npc_id": "marta", "to": { "x": 7, "y": 2 } }), initial, &json!({ "isDirector": true })).expect_err("стойка занята");
    assert_eq!(on_bar.code, "NPC_POST_INVALID");
    let command = validate_npc_world_command(&json!({ "command_type": "PlaceNpc", "command_id": "place-marta", "npc_id": "marta", "to": { "x": 6, "y": 2 } }), initial, &json!({ "isDirector": true })).expect("пост");
    assert_eq!(command["to"], json!({ "x": 6, "y": 2 }));
    assert_eq!(command["actor_id"], Value::Null);
    let placed = apply_npc_world_event(
        initial.get("npc_world"),
        &json!({ "event_type": "NpcPlaced", "payload": { "npc_id": "marta", "location_id": "market", "x": 6, "y": 2, "placement_reason": "system-command", "vitality": { "hp": 4, "max_hp": 4, "alive": true } } }),
        &Value::Null,
    );
    assert_eq!(
        placed["placements"][0],
        json!({ "npc_id": "marta", "location_id": "market", "x": 6, "y": 2, "anchor_prop_id": "", "placement_reason": "system-command", "policy_id": NPC_WORLD_POLICY_ID, "source_event_id": "" })
    );
    let absent = fixture.labelled("absent-marta");
    let error = validate_npc_world_command(&json!({ "command_type": "HarmNpc", "npc_id": "marta", "amount": 1 }), absent, &json!({ "isAdmin": true, "serverAuthoritativeCombat": true })).expect_err("NPC ушёл");
    assert_eq!(error.code, "NPC_NOT_PRESENT");
    let moved = fixture.labelled("moved-marta");
    let again = validate_npc_world_command(&json!({ "command_type": "PlaceNpc", "npc_id": "marta", "to": { "x": 4, "y": 2 } }), moved, &json!({ "isDirector": true })).expect_err("уже размещён");
    assert_eq!(again.code, "NPC_ALREADY_PLACED");
}

#[test]
fn post_is_bound_to_location_id_and_returns_with_the_scene() {
    let fixture = fixture();
    assert!(scene_npcs_for_viewer(fixture.labelled("away-road")).is_empty());
    let returned: Vec<Value> = scene_npcs_for_viewer(fixture.labelled("returned-market")).into_iter().map(|npc| json!({ "id": npc["id"], "x": npc["x"], "y": npc["y"] })).collect();
    assert_eq!(returned, vec![json!({ "id": "marta", "x": 6, "y": 2 })]);
}

#[test]
fn peaceful_npc_takes_area_damage_death_and_witness_consequences() {
    let fixture = fixture();
    let state = fixture.labelled("area-victim");
    let events = npc_harm_event_drafts(state, &NpcHarmOptions { npc_id: Some(json!("marta")), amount: Some(json!(8)), damage_type: Some(json!("fire")), source_event_id: Some(json!("area:1")), command_id: Some(json!("area-collateral")), ..NpcHarmOptions::default() });
    for kind in ["NpcHarmed", "NpcDied", "NpcStanceChanged", "WitnessConsequencePropagated", "FactionReputationAdjusted", "WorldFactRecorded"] {
        assert!(!of_type(&events, kind).is_empty(), "нет события {kind}");
    }
    let reputation = of_type(&events, "FactionReputationAdjusted");
    assert!(reputation.iter().any(|event| event["payload"]["faction_id"] == "watch" && event["payload"]["delta"] == -5));
    let death = of_type(&events, "NpcDied")[0];
    let fact = of_type(&events, "WorldFactRecorded")[0];
    assert_eq!(fact["payload"]["fact"]["source_event_ids"], json!([death["event_id"]]));
    let world = apply_all(&state["npc_world"], &events);
    assert_eq!(world["vitals"]["marta"]["alive"], false);
    assert_eq!(world["stances"]["marta"]["stance"], "dead");
    assert_eq!(world["stances"]["bor"]["stance"], "frightened");
}

#[test]
fn combat_start_frightens_the_nearest_observer_without_a_turn() {
    let fixture = fixture();
    let drafts = npc_combat_stance_event_drafts(fixture.labelled("observer"), &json!("combat-started:x"), &json!(["hero", "bandit"]));
    let marta = drafts.iter().find(|event| event["payload"]["npc_id"] == "marta").expect("стойка Марты");
    assert_eq!(marta["payload"]["stance"], "frightened");
    assert_eq!(marta["payload"]["source_event_id"], "combat-started:x");
}

#[test]
fn near_miss_by_one_or_two_can_hit_exactly_one_neighbouring_npc() {
    let fixture = fixture();
    let state = fixture.labelled("near-miss");
    let target = npc_miss_collateral_target(state, Some(&json!({ "x": 6, "y": 1 })), Some(&json!(12)), Some(&json!(13))).expect("задетый NPC");
    assert_eq!(target.npc["id"], "marta");
    assert!(npc_miss_collateral_target(state, Some(&json!({ "x": 6, "y": 1 })), Some(&json!(10)), Some(&json!(13))).is_none(), "промах на три пункта никого не задевает");
}

#[test]
fn nearby_combat_panic_spreads_one_ring_and_is_bounded() {
    let fixture = fixture();
    let events = npc_combat_stance_event_drafts(fixture.labelled("panic-40"), &json!("combat-started:test"), &json!(["hero", "bandit"]));
    assert!(!events.is_empty());
    assert!(events.len() <= 24);
    assert!(events.iter().all(|event| event["payload"]["propagation_depth"].as_i64().is_some_and(|depth| depth <= 1)));
    assert!(events.iter().any(|event| event["payload"]["propagation_depth"] == 1));
    assert!(events.iter().all(|event| event["payload"]["source_event_id"] == "combat-started:test"));
}

#[test]
fn projection_gives_bounded_scene_npcs_without_server_hp() {
    let fixture = fixture();
    let visible = scene_npcs_for_viewer(fixture.labelled("bloodied-marta"));
    assert_eq!(
        visible,
        vec![json!({
            "id": "marta", "name": "Марта", "role": "трактирщица", "location_id": "market", "x": 6, "y": 2, "anchor_prop_id": null,
            "stance": "neutral", "alive": true, "health_status": "bloodied", "can_start_combat": false,
        })]
    );
    let text = sk_core::js::stringify(&Value::Array(visible));
    assert!(!text.contains("hp") && !text.contains("goals"));
}

#[test]
fn public_projection_keeps_only_the_normalized_server_footprint() {
    let fixture = fixture();
    let visible = scene_npcs_for_viewer(fixture.labelled("footprint-projection"));
    assert_eq!(visible[0]["footprint"], json!({ "version": 1, "size": 3 }));
    assert!(!sk_core::js::stringify(&Value::Array(visible)).contains("internal"));
}

#[test]
fn combat_actor_is_built_from_profile_vitality_and_post_with_fallback() {
    let fixture = fixture();
    let actor = npc_combat_actor_for(fixture.labelled("authored"), &json!("marta")).expect("боевой снимок");
    assert_eq!(actor["id"], "marta");
    assert_eq!(actor["origin"]["kind"], "authored-npc");
    assert_eq!(actor["stat_block_id"], "astohan:ares-v1");
    assert_eq!(actor["hp"], 20);
    assert_eq!(actor["maxHp"], 168);
    assert_eq!((actor["x"].clone(), actor["y"].clone()), (json!(6), json!(2)));
    assert_eq!(actor["action_profiles"][0]["id"], "royal-greatsword");
    let fallback = npc_combat_actor_for(fixture.labelled("placed-marta"), &json!("marta")).expect("запасной снимок");
    assert_eq!(fallback["id"], "marta");
    assert!(fallback.get("origin").is_none());
    assert_eq!(fallback["hp"], 4);
    assert_eq!((fallback["x"].clone(), fallback["y"].clone()), (json!(6), json!(2)));
}

#[test]
fn viewer_excludes_only_the_combat_copy_during_active_combat() {
    let fixture = fixture();
    assert!(!scene_npcs_for_viewer(fixture.labelled("authored-active")).iter().any(|npc| npc["id"] == "marta"));
    assert!(scene_npcs_for_viewer(fixture.labelled("authored-ended")).iter().any(|npc| npc["id"] == "marta"));
}

fn damage(hp_before: i64, hp_after: i64, event_id: &str, command_id: &str) -> Value {
    json!({
        "event_type": "DamageApplied", "event_id": event_id, "command_id": command_id, "actor_id": "hero", "target_ids": ["marta"],
        "payload": { "hp_before": hp_before, "hp_after": hp_after, "applied_amount": hp_before - hp_after, "raw_amount": hp_before - hp_after, "damage_type": "fire" },
        "visibility": "party",
    })
}

#[test]
fn authored_bridge_synchronizes_damage_and_movement_with_one_absolute_hp() {
    let fixture = fixture();
    let before = fixture.labelled("authored");
    let after = fixture.labelled("authored-moved-after");
    let events = json!([damage(20, 7, "damage-authored-marta", "cast-authored-marta"), {
        "event_type": "ActorMoved", "event_id": "move-authored-marta", "command_id": "cast-authored-marta", "actor_id": "marta", "target_ids": ["marta"],
        "payload": { "from": { "x": 6, "y": 2 }, "to": { "x": 5, "y": 2 } },
    }]);
    let bridge = plan_authored_npc_world_events(before, after, &events, &json!("cast-authored-marta"), &json!("hero"));
    let harms = of_type(&bridge, "NpcHarmed");
    assert_eq!(harms.len(), 1);
    assert!(of_type(&bridge, "NpcDied").is_empty());
    let harm = &harms[0]["payload"];
    assert_eq!((harm["hp_before"].clone(), harm["hp_after"].clone(), harm["applied_amount"].clone()), (json!(20), json!(7), json!(13)));
    let moved = of_type(&bridge, "NpcMoved")[0];
    assert_eq!((moved["payload"]["x"].clone(), moved["payload"]["y"].clone()), (json!(5), json!(2)));
    let world = apply_all(&before["npc_world"], &bridge);
    assert_eq!(world["vitals"]["marta"], json!({ "hp": 7, "max_hp": 168, "alive": true }));
    let placement = world["placements"].as_array().and_then(|list| list.iter().find(|entry| entry["npc_id"] == "marta")).cloned();
    assert_eq!(
        placement,
        Some(json!({ "npc_id": "marta", "location_id": "market", "x": 5, "y": 2, "anchor_prop_id": "", "placement_reason": "authored-actor-sync", "policy_id": NPC_WORLD_POLICY_ID, "source_event_id": moved["event_id"] }))
    );
}

#[test]
fn authored_bridge_writes_death_once_and_respects_knockout_or_surrender() {
    let fixture = fixture();
    let before = fixture.labelled("authored");
    let death_events = json!([damage(20, 0, "damage-authored-death", "kill-authored-marta"), {
        "event_type": "HitPointsReducedToZero", "event_id": "zero-authored-marta", "command_id": "kill-authored-marta", "actor_id": "hero", "target_ids": ["marta"], "payload": { "condition": "unconscious" },
    }]);
    let death = plan_authored_npc_world_events(before, fixture.labelled("authored-dead-after"), &death_events, &json!("kill-authored-marta"), &json!("hero"));
    assert_eq!(of_type(&death, "NpcHarmed").len(), 1);
    assert_eq!(of_type(&death, "NpcDied").len(), 1);
    assert!(!of_type(&death, "WorldFactRecorded").is_empty());
    assert_eq!(apply_all(&before["npc_world"], &death)["vitals"]["marta"], json!({ "hp": 0, "max_hp": 168, "alive": false }));

    let knockout_events = json!([damage(20, 0, "damage-authored-zero-knockout", "zero-knockout-authored-marta"), {
        "event_type": "CreatureKnockedOut", "event_id": "zero-knockout-authored-marta", "command_id": "zero-knockout-authored-marta", "actor_id": "hero", "target_ids": ["marta"], "payload": { "recovery_minutes": 60 },
    }]);
    let knockout = plan_authored_npc_world_events(before, fixture.labelled("authored-zero-after"), &knockout_events, &json!("zero-knockout-authored-marta"), &json!("hero"));
    assert!(of_type(&knockout, "NpcDied").is_empty());
    assert_eq!(of_type(&knockout, "NpcHarmed")[0]["payload"]["schema_version"], 2);
    assert_eq!(apply_all(&before["npc_world"], &knockout)["vitals"]["marta"], json!({ "hp": 0, "max_hp": 168, "alive": true }));
}

#[test]
fn scene_program_post_beats_the_role_guess() {
    let fixture = fixture();
    let marta = |label: &str| plan_scene_npc_placement_events(fixture.labelled(label)).into_iter().find(|event| event["payload"]["npc_id"] == "marta").expect("пост Марты");
    assert_eq!(marta("program-altar")["payload"]["anchor_prop_id"], "altar-1");
    assert_eq!(marta("npc-state")["payload"]["anchor_prop_id"], "bar-1", "без программы — прежняя расстановка");
    let platform = marta("program-platform");
    let (x, y) = (platform["payload"]["x"].as_i64().unwrap_or(-1), platform["payload"]["y"].as_i64().unwrap_or(-1));
    assert!((5..=7).contains(&x) && (4..=5).contains(&y), "Марта на настиле: {x},{y}");
}

#[test]
fn absorbed_only_harm_is_kept_with_the_temporary_pool() {
    let fixture = fixture();
    let state = fixture.labelled("temporary-hp");
    let options = NpcHarmOptions::from_json(&json!({
        "npcId": "villager", "amount": 0, "damageType": "mixed",
        "damageComponents": [
            { "damage_type": "thunder", "raw_amount": 15, "applied_amount": 0, "temporary_hp_absorbed": 7 },
            { "damage_type": "radiant", "raw_amount": 5, "applied_amount": 0, "temporary_hp_absorbed": 3 },
        ],
        "temporaryHpBefore": 10, "temporaryHpAfter": 0, "temporaryHpAbsorbed": 10,
        "sourceEventId": "spell-cast:wave", "sourceActorId": "hero", "trigger": "area-spell", "commandId": "wave-temp-test",
    }));
    let events = npc_harm_event_drafts(state, &options);
    let harmed = &of_type(&events, "NpcHarmed")[0]["payload"];
    assert_eq!(harmed["applied_amount"], 0);
    assert_eq!(harmed["hp_before"], 100);
    assert_eq!(harmed["hp_after"], 100);
    assert_eq!(harmed["temporary_hp_absorbed"], 10);
    assert_eq!(harmed["damage_type"], "mixed");
    assert_eq!(apply_all(&state["npc_world"], &events)["vitals"]["villager"]["hp"], 100);
}

#[test]
fn current_retention_keeps_accepted_npc_items_and_legacy_restores_old_limits() {
    let items: Vec<Value> = (0..101).map(|index| json!({ "id": format!("item:{index}"), "name": format!("Предмет {index}"), "type": "other", "quantity": 1 })).collect();
    let world = json!({ "inventories": { "marta": items } });
    assert_eq!(normalize_npc_world_state(Some(&world), &Value::Null)["inventories"]["marta"].as_array().map(Vec::len), Some(101));
    assert_eq!(normalize_npc_world_state_legacy(Some(&world))["inventories"]["marta"].as_array().map(Vec::len), Some(MAX_NPC_INVENTORY_ITEMS));
    let legacy = with_retention_mode("legacy", || normalize_npc_world_state(Some(&world), &Value::Null)).expect("режим");
    assert_eq!(legacy["inventories"]["marta"].as_array().map(Vec::len), Some(MAX_NPC_INVENTORY_ITEMS));
    // Явный параметр сильнее режима.
    let explicit = with_retention_mode("legacy", || normalize_npc_world_state(Some(&world), &json!({ "isLegacy": false }))).expect("режим");
    assert_eq!(explicit["inventories"]["marta"].as_array().map(Vec::len), Some(101));
    let vitals: serde_json::Map<String, Value> = (0..503).map(|index| (format!("npc:{index}"), json!({ "hp": 3 }))).collect();
    let big = json!({ "vitals": vitals });
    assert_eq!(normalize_npc_world_state(Some(&big), &Value::Null)["vitals"].as_object().map(serde_json::Map::len), Some(503));
    assert_eq!(normalize_npc_world_state_legacy(Some(&big))["vitals"].as_object().map(serde_json::Map::len), Some(500));
}

#[test]
fn item_given_from_npc_hands_leaves_the_inventory() {
    let world = json!({ "inventories": { "knight": [{ "id": "tear", "name": "Слеза", "type": "treasure", "quantity": 1 }, { "id": "ring", "name": "Кольцо", "quantity": 1 }] } });
    let after = apply_npc_world_event(Some(&world), &json!({ "event_type": "ItemGranted", "payload": { "source_npc_id": "knight", "item": { "item_instance_id": "inst-1", "id": "tear" } } }), &Value::Null);
    let names: Vec<Value> = after["inventories"]["knight"].as_array().map(|items| items.iter().map(|item| item["name"].clone()).collect()).unwrap_or_default();
    assert_eq!(names, vec![json!("Кольцо")]);
    let transferred = apply_npc_world_event(Some(&after), &json!({ "event_type": "ItemTransferred", "payload": { "recipient_kind": "npc", "to_actor_id": "knight", "quantity": 2, "item": { "id": "ring", "name": "Кольцо" } } }), &Value::Null);
    assert_eq!(transferred["inventories"]["knight"][0]["quantity"], 3, "та же стопка складывается");
}

#[test]
fn prototype_key_as_npc_id_behaves_like_js() {
    let state = json!({
        "scene": { "location": "Рынок", "location_id": "market" },
        "social": { "npcs": [{ "id": "constructor", "name": "Кон", "location": "Рынок" }] },
        "npc_world": { "placements": [{ "npc_id": "constructor", "location_id": "market", "x": 1, "y": 1 }] },
    });
    // Живучесть — унаследованная функция: полей нет, `alive` ложно.
    assert_eq!(npc_vital_for(&state, &json!("constructor")), json!({}));
    let error = validate_npc_world_command(&json!({ "command_type": "MoveNpc", "npc_id": "constructor", "to": { "x": 2, "y": 2 } }), &state, &json!({ "isDirector": true })).expect_err("отказ");
    assert_eq!(error.code, "NPC_ALREADY_DEAD");
    assert!(npc_harm_event_drafts(&state, &NpcHarmOptions { npc_id: Some(json!("constructor")), amount: Some(json!(2)), ..NpcHarmOptions::default() }).is_empty());
    let world_for = with_world(&state, json!({ "placements": [{ "npc_id": "constructor", "location_id": "market", "x": 1, "y": 1 }], "vitals": { "constructor": { "hp": 3, "max_hp": 4 } } }));
    assert_eq!(npc_vital_for(&world_for, &json!("constructor")), json!({ "hp": 3, "max_hp": 4, "alive": true }));
}
