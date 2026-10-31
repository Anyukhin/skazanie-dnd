//! Перенос модульных проверок `test/loot-containers.test.mjs`,
//! `test/npc-loot-containers.test.mjs` и `test/thrown-weapon-drop.test.mjs`:
//! вместо движка правил — те же шаги модуля (черновик выбытия, применение,
//! проверка обыска, событие обыска).

use serde_json::{json, Value};
use sk_director::loot_containers::*;

fn instance(id: &str, catalog_id: &str, quantity: i64, weight: f64) -> Value {
    json!({
        "schema_version": 1, "item_instance_id": id, "catalog_id": catalog_id,
        "snapshot": { "catalog_id": catalog_id, "name": format!("Вещь {id}"), "type": "weapon", "weight": weight, "description": "Описание." },
        "quantity": quantity, "equipped": false, "owner": { "kind": "enemy", "actor_id": "foe-1" },
        "origin": { "kind": "enemy_loadout", "template_id": "bandit", "source_id": "enc-1" }, "lootable": true,
    })
}

fn bandit(hp: i64) -> Value {
    json!({ "id": "foe-1", "name": "Разбойник 1", "hp": hp, "x": 2, "y": 1, "loadout": { "items": [
        instance("foe-1-scimitar", "srd_5_2_1:scimitar", 1, 3.0),
        instance("foe-1-bolts", "srd_5_2_1:bolts-20", 6, 1.5),
    ] } })
}

fn campaign(combat: bool, hero_str: i64) -> Value {
    json!({
        "partyMemberIds": ["hero", "mate"],
        "scene": { "location": "Склад", "location_id": "warehouse" },
        "players": [
            { "id": "hero", "hp": 24, "abilities": { "str": hero_str }, "inventory": [], "x": 2, "y": 2 },
            { "id": "mate", "hp": 24, "abilities": { "str": 16 }, "inventory": [], "x": 6, "y": 4 },
        ],
        "enemies": [bandit(11)],
        "mechanics": {
            "world_time": { "elapsed_minutes": 120 },
            "positions": { "hero": { "x": 2, "y": 2 }, "mate": { "x": 6, "y": 4 }, "foe-1": { "x": 2, "y": 1 } },
            "encounter": { "id": "enc-1" },
            "combat": if combat { json!({ "active": true, "action_economy": { "hero": { "action": true }, "mate": { "action": true } } }) } else { json!({ "active": false }) },
        },
    })
}

/// Убить разбойника: черновик тела и его применение.
fn kill(before: &Value) -> (Value, Value) {
    let mut after = before.clone();
    after["enemies"][0]["hp"] = json!(0);
    let events = json!([{ "event_type": "DamageApplied", "target_ids": ["foe-1"], "payload": { "hp_after": 0 } }]);
    assert!(loot_commit_touches_containers(before, &events));
    let drafts = plan_loot_container_drafts(before, &after, &events).expect("черновики");
    assert_eq!(drafts.len(), 1, "тело в той же фиксации");
    apply_loot_container_event(&mut after, &drafts[0]).expect("применение");
    let container = loot_container_list(&after).into_iter().next().expect("контейнер");
    (after, container)
}

fn loot(state: &Value, actor: &str, container: &Value, lines: Value, extra: Value) -> Result<Value, LootContainerError> {
    let mut command = json!({ "command_type": "LootContainer", "command_id": "cmd-1", "campaign_id": "LOOT", "actor_id": actor, "container_id": container["id"], "lines": lines });
    if let (Some(map), Value::Object(patch)) = (command.as_object_mut(), extra) {
        map.extend(patch);
    }
    validate_loot_container_command(&command, state, &json!({ "allowedActorIds": ["hero", "mate"] }))
}

fn code(result: Result<Value, LootContainerError>) -> String {
    result.err().and_then(|error| error.code).unwrap_or_default()
}

fn all_lines(container: &Value) -> Value {
    Value::Array(container["items"].as_array().unwrap().iter().map(|item| json!({ "item_instance_id": item["item_instance_id"], "quantity": item["quantity"] })).collect())
}

#[test]
fn death_moves_remainder_into_container() {
    let (after, container) = kill(&campaign(true, 16));
    assert_eq!(container["kind"], "corpse");
    assert_eq!(container["source_enemy_id"], "foe-1");
    assert_eq!(container["encounter_id"], "enc-1");
    assert_eq!(container["name"], "Тело: Разбойник 1");
    assert_eq!((container["x"].clone(), container["y"].clone()), (json!(2), json!(1)));
    assert!(container["items"].as_array().unwrap().iter().all(|item| item["owner"]["actor_id"] == container["id"]));
    assert_eq!(after["enemies"][0]["loadout"]["items"], json!([]), "остаток покинул инвентарь противника");
}

#[test]
fn empty_inventory_creates_no_container() {
    let mut before = campaign(true, 16);
    before["enemies"][0]["loadout"] = json!({ "items": [] });
    let mut after = before.clone();
    after["enemies"][0]["hp"] = json!(0);
    let events = json!([{ "event_type": "DamageApplied", "target_ids": ["foe-1"], "payload": { "hp_after": 0 } }]);
    assert!(!loot_commit_touches_containers(&before, &events));
    assert!(plan_loot_container_drafts(&before, &after, &events).unwrap().is_empty());
}

#[test]
fn hero_falling_does_not_touch_containers() {
    let before = campaign(true, 16);
    let events = json!([{ "event_type": "DamageApplied", "target_ids": ["hero"], "payload": { "hp_after": 0 } }]);
    assert!(!loot_commit_touches_containers(&before, &events));
}

#[test]
fn overflow_evicts_emptied_first() {
    let (_, untouched) = kill(&campaign(false, 16));
    let emptied: Vec<Value> = (0..MAX_LOOT_CONTAINERS + 2)
        .map(|index| json!({ "id": format!("loot:corpse:filler-{index}"), "kind": "corpse", "location_id": "warehouse", "status": "emptied", "items": [] }))
        .collect();
    let mut containers = vec![untouched.clone()];
    containers.extend(emptied.iter().cloned());
    let crowded = normalize_loot_containers_state(Some(&json!({ "containers": containers })));
    let list = crowded["containers"].as_array().unwrap();
    assert_eq!(list.len(), MAX_LOOT_CONTAINERS);
    assert!(list.iter().any(|container| container["id"] == untouched["id"]));

    let mut many: Vec<Value> = (0..=MAX_LOOT_CONTAINERS)
        .map(|index| {
            let mut copy = untouched.clone();
            copy["id"] = json!(format!("loot:corpse:full-{index:03}"));
            copy
        })
        .collect();
    many.extend(emptied);
    let overfull = normalize_loot_containers_state(Some(&json!({ "containers": many })));
    let list = overfull["containers"].as_array().unwrap();
    assert_eq!(list.len(), MAX_LOOT_CONTAINERS);
    assert!(list.iter().all(|container| container["status"] == "available"));
    assert!(!list.iter().any(|container| container["id"] == "loot:corpse:full-000"));
}

#[test]
fn search_checks_rights_reach_lines_and_recipient() {
    let (state, container) = kill(&campaign(false, 16));
    let line = json!([{ "item_instance_id": container["items"][0]["item_instance_id"], "quantity": 1 }]);
    assert_eq!(code(loot(&state, "mate", &container, line.clone(), json!({}))), "LOOT_CONTAINER_OUT_OF_REACH");
    assert_eq!(code(loot(&state, "hero", &json!({ "id": "loot:corpse:нет" }), line.clone(), json!({}))), "LOOT_CONTAINER_NOT_FOUND");
    assert_eq!(code(loot(&state, "hero", &container, json!([]), json!({}))), "LOOT_LINES_REQUIRED");
    assert_eq!(code(loot(&state, "hero", &container, json!([{ "item_instance_id": "нет", "quantity": 1 }]), json!({}))), "LOOT_ITEM_GONE");
    let too_many = json!([{ "item_instance_id": container["items"][0]["item_instance_id"], "quantity": 99 }]);
    assert_eq!(code(loot(&state, "hero", &container, too_many, json!({}))), "LOOT_QUANTITY_INVALID");
    let twice = json!([line[0].clone(), line[0].clone()]);
    assert_eq!(code(loot(&state, "hero", &container, twice, json!({}))), "LOOT_LINE_DUPLICATE");
    assert_eq!(code(loot(&state, "hero", &container, line.clone(), json!({ "recipient_id": "foe-1" }))), "LOOT_RECIPIENT_INVALID");
    assert_eq!(code(loot(&state, "foe-1", &container, line.clone(), json!({}))), "ACTOR_FORBIDDEN");
    assert_eq!(code(loot(&state, "hero", &container, line.clone(), json!({ "name": "Меч +3" }))), "LOOT_COMMAND_UNKNOWN_FIELD");
    // Вне боя добыча достаётся любому герою отряда.
    assert!(loot(&state, "hero", &container, line.clone(), json!({ "recipient_id": "mate" })).is_ok());
    // Соседняя клетка — в пределах пяти футов.
    let mut adjacent = state.clone();
    adjacent["mechanics"]["positions"]["mate"] = json!({ "x": 3, "y": 1 });
    assert!(loot(&adjacent, "mate", &container, line, json!({})).is_ok());
    assert_eq!(LOOT_CONTAINER_REACH_FEET, 5);
}

#[test]
fn combat_search_costs_action_and_keeps_recipient() {
    let (state, container) = kill(&campaign(true, 16));
    let line = json!([{ "item_instance_id": container["items"][0]["item_instance_id"], "quantity": 1 }]);
    assert_eq!(code(loot(&state, "hero", &container, line.clone(), json!({ "recipient_id": "mate" }))), "LOOT_RECIPIENT_DURING_COMBAT");
    let command = loot(&state, "hero", &container, line, json!({})).unwrap();
    assert_eq!(command["loot_combat_action"], "action");
    let view = loot_containers_for_viewer(&state, Some(&json!("hero")), None).unwrap();
    assert_eq!(view["action_cost"], "action");
    assert_eq!(view["action_spent"], false);
    assert_eq!(view["containers"][0]["can_inspect"], true);
    // Издали — карточка без содержимого.
    let far = loot_containers_for_viewer(&state, Some(&json!("mate")), None).unwrap();
    assert_eq!(far["containers"][0]["can_inspect"], false);
    assert!(far["containers"][0].get("items").is_none());
}

#[test]
fn fog_hides_cell_from_player_not_from_admin() {
    let (mut state, _) = kill(&campaign(false, 16));
    state["scene"]["cells"] = json!([{ "x": 2, "y": 1, "revealed": false }, { "x": 2, "y": 2, "revealed": true }]);
    let player = loot_containers_for_viewer(&state, Some(&json!("hero")), None).unwrap();
    assert_eq!(player["containers"][0]["cell_revealed"], false);
    let admin = loot_containers_for_viewer(&state, None, Some(&json!(true))).unwrap();
    assert_eq!(admin["containers"][0]["cell_revealed"], true);
}

#[test]
fn overload_cancels_whole_set() {
    let mut before = campaign(true, 1);
    before["players"][0]["inventory"] = json!([{ "id": "anvil", "name": "Наковальня", "type": "gear", "quantity": 1, "weight": 12 }]);
    let (state, container) = kill(&before);
    assert_eq!(code(loot(&state, "hero", &container, all_lines(&container), json!({}))), "CARRYING_CAPACITY_EXCEEDED");
    let bolts = json!([{ "item_instance_id": "foe-1-bolts", "quantity": 1 }]);
    assert!(loot(&state, "hero", &container, bolts, json!({})).is_ok());
}

#[test]
fn taking_the_set_empties_container_and_replay_does_not_double() {
    let (state, container) = kill(&campaign(false, 16));
    let command = loot(&state, "hero", &container, all_lines(&container), json!({ "recipient_id": "mate" })).unwrap();
    let events = loot_container_command_events(&command).unwrap();
    assert_eq!(events[0]["payload"]["status_after"], "emptied");
    assert_eq!(events[0]["payload"]["combat_action"], Value::Null);
    let mut next = state.clone();
    assert_eq!(apply_loot_container_event(&mut next, &events[0]).unwrap(), vec!["mate".to_string()]);
    assert_eq!(next["players"][1]["inventory"].as_array().unwrap().len(), 2);
    assert!(loot_containers_in_scene(&next, false).unwrap().is_empty());
    let mut twice = next.clone();
    assert!(apply_loot_container_event(&mut twice, &events[0]).unwrap().is_empty());
    assert_eq!(twice, next, "повтор не выдаёт добычу второй раз");
    let bolts = json!([{ "item_instance_id": "foe-1-bolts", "quantity": 1 }]);
    assert_eq!(code(loot(&next, "hero", &container, bolts, json!({}))), "LOOT_CONTAINER_EMPTY");
}

#[test]
fn part_of_stack_stays_in_container() {
    let (state, container) = kill(&campaign(false, 16));
    let bolts = json!([{ "item_instance_id": "foe-1-bolts", "quantity": 1 }]);
    let command = loot(&state, "hero", &container, bolts, json!({})).unwrap();
    let event = loot_container_command_events(&command).unwrap().remove(0);
    let mut next = state.clone();
    apply_loot_container_event(&mut next, &event).unwrap();
    let after = loot_container_list(&next).remove(0);
    assert_eq!(after["status"], "available");
    let left = after["items"].as_array().unwrap().iter().find(|item| item["item_instance_id"] == "foe-1-bolts").unwrap();
    assert_eq!(left["quantity"], 5);
    assert_eq!(next["players"][0]["inventory"][0]["quantity"], 1);
}

fn npc_state(inventory: Value) -> Value {
    json!({
        "scene": { "location": "Рынок", "location_id": "market", "level": { "index": 2 } },
        "mechanics": { "world_time": { "elapsed_minutes": 120 }, "positions": {} },
        "social": { "npcs": [{ "id": "marta", "name": "Марта" }] },
        "npc_world": { "placements": [{ "npc_id": "marta", "location_id": "market", "x": 2, "y": 3 }], "inventories": { "marta": inventory } },
        "enemies": [],
        "loot_containers": { "schema_version": 1, "containers": [] },
    })
}

fn npc_drafts(before: &Value) -> Vec<Value> {
    let events = json!([{ "event_type": "NpcDied", "payload": { "npc_id": "marta", "npc_name": "Марта" }, "target_ids": ["marta"] }]);
    assert!(loot_commit_touches_containers(before, &events));
    plan_loot_container_drafts(before, before, &events).unwrap()
}

#[test]
fn npc_body_takes_actual_inventory_on_current_level() {
    let before = npc_state(json!([{ "id": "marta-item", "item_instance_id": "marta-instance", "catalog_id": "srd_5_2_1:dagger", "name": "Кинжал", "type": "weapon", "quantity": 1, "origin": "gifted" }]));
    let drafts = npc_drafts(&before);
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["target_ids"], json!(["marta"]));
    let container = &drafts[0]["payload"]["container"];
    assert_eq!(container["location_id"], "market@L2");
    assert_eq!((container["x"].clone(), container["y"].clone()), (json!(2), json!(3)));
    assert_eq!(container["name"], "Тело: Марта");
    assert_eq!(container["items"][0]["item_instance_id"], "marta-instance");
    assert_eq!(container["items"][0]["origin"]["kind"], "gifted");
    assert_eq!(drafts[0]["payload"]["npc_loot"]["clear_inventory"], true);
    let mut reduced = before.clone();
    apply_loot_container_event(&mut reduced, &drafts[0]).unwrap();
    assert!(reduced["npc_world"]["inventories"].get("marta").is_none());
    let mut replayed = reduced.clone();
    apply_loot_container_event(&mut replayed, &drafts[0]).unwrap();
    assert_eq!(replayed, reduced, "повтор создания не дублирует контейнер");
}

#[test]
fn npc_quantity_and_segments_split_without_loss() {
    let before = npc_state(json!([{ "id": "b", "item_instance_id": "marta-bolts", "catalog_id": "srd_5_2_1:dagger", "quantity": 2500 }]));
    let drafts = npc_drafts(&before);
    let quantities: Vec<Value> = drafts[0]["payload"]["container"]["items"].as_array().unwrap().iter().map(|item| item["quantity"].clone()).collect();
    assert_eq!(quantities, vec![json!(999), json!(999), json!(502)]);
    assert_eq!(drafts[0]["payload"]["container"]["items"][0]["item_instance_id"], "marta-bolts");
    let many: Vec<Value> = (0..25).map(|index| json!({ "id": format!("i{index}"), "item_instance_id": format!("marta-instance-{index}"), "catalog_id": "srd_5_2_1:dagger", "quantity": 1 })).collect();
    let drafts = npc_drafts(&npc_state(json!(many)));
    let sizes: Vec<usize> = drafts.iter().map(|draft| draft["payload"]["container"]["items"].as_array().unwrap().len()).collect();
    assert_eq!(sizes, vec![24, 1]);
    assert_eq!(drafts[1]["payload"]["npc_loot"]["part_count"], 2);
}

#[test]
fn unknown_npc_item_stays_explicitly_unknown() {
    let drafts = npc_drafts(&npc_state(json!([{ "id": "mystery", "name": "Непонятная реликвия", "quantity": 1 }])));
    let item = &drafts[0]["payload"]["container"]["items"][0];
    assert_eq!(item["snapshot"]["name"], "Непонятная реликвия");
    assert_ne!(item["snapshot"]["type"], "weapon");
    assert_eq!(item["origin"]["kind"], "unknown");
    assert!(item["catalog_id"].as_str().unwrap().starts_with("npc-raw:"));
    assert_eq!(drafts[0]["payload"]["npc_loot"]["unknown_items"].as_array().unwrap().len(), 1);
}

#[test]
fn thrown_dagger_drops_and_returns_to_its_stack() {
    let mut state = campaign(true, 16);
    state["players"][0]["inventory"] = json!([{ "id": "dagger", "catalog_id": "srd_5_2_1:dagger", "name": "Кинжал", "type": "weapon", "quantity": 2, "weight": 1, "equipped": true }]);
    let item = state["players"][0]["inventory"][0].clone();
    let position = json!({ "x": 2, "y": 3 });
    let info = ThrownWeaponInfo { command_id: Some(&json!("throw-1")), owner_id: Some(&json!("hero")), item: Some(&item), position: Some(&position) };
    let draft = thrown_weapon_drop_draft(&state, info).unwrap().expect("черновик");
    assert_eq!(draft["payload"]["container"]["name"], "Брошенное оружие: Кинжал");
    let mut next = state.clone();
    assert_eq!(apply_loot_container_event(&mut next, &draft).unwrap(), vec!["hero".to_string()]);
    assert_eq!(next["players"][0]["inventory"][0]["quantity"], 1, "из стопки в два ушёл один");
    let mut twice = next.clone();
    apply_loot_container_event(&mut twice, &draft).unwrap();
    assert_eq!(twice["players"][0]["inventory"][0]["quantity"], 1, "повтор не забирает второй кинжал");
    let container = loot_container_list(&next).remove(0);
    assert_eq!(loot_combat_action_for(&next, Some(&json!("hero")), Some(&container)), Some("object_interaction"));
    let line = json!([{ "item_instance_id": container["items"][0]["item_instance_id"], "quantity": 1 }]);
    let command = loot(&next, "hero", &container, line, json!({})).unwrap();
    assert_eq!(command["loot_returns"][0]["to_item_id"], "dagger");
    assert_eq!(command["loot_combat_action"], "object_interaction");
    let event = loot_container_command_events(&command).unwrap().remove(0);
    apply_loot_container_event(&mut next, &event).unwrap();
    assert_eq!(next["players"][0]["inventory"].as_array().unwrap().len(), 1);
    assert_eq!(next["players"][0]["inventory"][0]["quantity"], 2, "вернулся в ту же стопку");
}

/// Замечено в JS: `coordinate(null)` — это `Number(null)`, то есть 0, и
/// контейнер «без клетки» после нормализации стоит на клетке 0:0. Перенесено
/// как есть: нормализация идёт в редьюсере, исправление изменило бы
/// проигрывание старых журналов.
#[test]
fn js_quirk_null_coordinates_become_zero() {
    let container = json!({ "id": "loot:corpse:a", "kind": "corpse", "x": null, "y": null, "items": [instance("i", "srd_5_2_1:dagger", 1, 1.0)] });
    let normalized = normalize_loot_container(Some(&container)).unwrap();
    assert_eq!((normalized["x"].clone(), normalized["y"].clone()), (json!(0), json!(0)));
}

/// Без расстояния (`distanceFeet = null`) карточка — без поля, а не
/// `distance_feet: 0` (`Number(null)` — 0). Исправлено в обоих серверах.
#[test]
fn viewer_card_without_distance_has_no_distance_field() {
    let container = json!({ "id": "loot:corpse:a", "kind": "corpse", "x": 2, "y": 2, "items": [instance("i", "srd_5_2_1:dagger", 1, 1.0)] });
    let view = loot_container_for_viewer(&container, ContainerViewOptions::default()).unwrap();
    assert!(view.get("distance_feet").is_none(), "померить нечем — поля нет");
    let measured = loot_container_for_viewer(&container, ContainerViewOptions { distance_feet: Some(&json!(0)), ..ContainerViewOptions::default() }).unwrap();
    assert_eq!(measured["distance_feet"], 0, "настоящий ноль остаётся");
}
