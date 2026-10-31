//! Сверка `item_lifecycle` с эталонами JS и перенос проверок
//! `test/item-lifecycle.test.mjs`.
//!
//! - `fixtures/item-lifecycle-capture.json` (`gen-item-lifecycle-capture.mjs`)
//!   — настоящие вызовы модуля из тестов `item-lifecycle`,
//!   `combat-equipment-interaction` и `npc-equipment` (через Rules Engine);
//! - `fixtures/item-lifecycle.json` (`gen-item-lifecycle.mjs`) — состояния
//!   корпуса паритета, случайные отряды с мусором старых сохранений, цепочки
//!   команда → события → герои и редкие ветки проверки.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_items_life::item_lifecycle::{
    active_item_effect_totals, active_item_mechanic_effects, apply_item_lifecycle_event_to_players, carrying_capacity, derived_equipment_armor_class,
    equipped_shield_bonus, inventory_load_for, inventory_weight, item_lifecycle_events, item_profile_for, validate_item_lifecycle_command,
    weapon_damage_riders_for_item, ItemLifecycleError, MechanicEffectOptions,
};
use sk_society::retention_context::with_retention_mode;

static CAPTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/item-lifecycle-capture.json")).expect("эталон перехвата"));
static CASES: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/item-lifecycle.json")).expect("эталон item-lifecycle"));

/// Аргумент эталона: `{ "$undefined": true }` — `None`, `{ "$v": i, "path"? }`
/// — значение из таблицы.
fn resolve(fixture: &Value, arg: &Value) -> Option<Value> {
    if arg.get("$undefined") == Some(&Value::Bool(true)) {
        return None;
    }
    let Some(index) = arg.get("$v").and_then(Value::as_u64) else { return Some(arg.clone()) };
    let mut value = &fixture["values"][index as usize];
    for step in arg.get("path").and_then(Value::as_array).into_iter().flatten() {
        value = match step {
            Value::Number(position) => &value[position.as_u64().expect("индекс") as usize],
            Value::String(key) => &value[key.as_str()],
            other => panic!("шаг пути {other}"),
        };
    }
    Some(value.clone())
}

fn error_json(error: &ItemLifecycleError) -> Value {
    match error {
        ItemLifecycleError::Type(_) => json!({ "name": "TypeError" }),
        ItemLifecycleError::Validation { message, code } => json!({ "name": "ItemLifecycleValidationError", "code": code, "message": message }),
    }
}

fn wrap(result: Result<Value, ItemLifecycleError>) -> Result<Value, Value> {
    result.map_err(|error| error_json(&error))
}

fn run(name: &str, args: &[Option<Value>]) -> Result<Value, Value> {
    let arg = |index: usize| args.get(index).and_then(Option::as_ref);
    let null = Value::Null;
    let options = arg(1);
    match name {
        "itemProfileFor" => Ok(item_profile_for(arg(0), options.and_then(|options| options.get("rulesetId")))),
        "inventoryWeight" => wrap(inventory_weight(arg(0))),
        "carryingCapacity" => Ok(carrying_capacity(arg(0))),
        "inventoryLoadFor" => wrap(inventory_load_for(arg(0))),
        "activeItemEffectTotals" => wrap(active_item_effect_totals(arg(0))),
        "equippedShieldBonus" => wrap(equipped_shield_bonus(arg(0))),
        "activeItemMechanicEffects" => {
            let options = MechanicEffectOptions {
                selected_item_id: options.and_then(|options| options.get("selectedItemId")),
                selected_counts_as_equipped: js::truthy(options.and_then(|options| options.get("selectedCountsAsEquipped"))),
            };
            wrap(active_item_mechanic_effects(arg(0), &options).map(Value::Array))
        }
        "weaponDamageRidersForItem" => {
            let counts = js::truthy(arg(2).and_then(|options| options.get("selectedCountsAsEquipped")));
            wrap(weapon_damage_riders_for_item(arg(0), arg(1), counts).map(Value::Array))
        }
        "derivedEquipmentArmorClass" => {
            let include = match options.and_then(|options| options.get("includeItemEffects")) {
                None => true,
                some => js::truthy(some),
            };
            wrap(derived_equipment_armor_class(arg(0), include))
        }
        "validateItemLifecycleCommand" => wrap(validate_item_lifecycle_command(arg(0).unwrap_or(&null), arg(1).unwrap_or(&null), arg(2))),
        "itemLifecycleEvents" => wrap(item_lifecycle_events(arg(0).unwrap_or(&null)).map(Value::Array)),
        "applyItemLifecycleEventToPlayers" => wrap(apply_item_lifecycle_event_to_players(arg(0), arg(1).unwrap_or(&null))),
        other => panic!("неизвестная функция {other}"),
    }
}

fn check_fixture(fixture: &Value, minimum: usize) {
    let cases = fixture["cases"].as_array().expect("случаи");
    assert!(cases.len() >= minimum, "случаев {}", cases.len());
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().expect("fn");
        let args: Vec<Option<Value>> = case["args"].as_array().expect("args").iter().map(|arg| resolve(fixture, arg)).collect();
        let legacy = case.get("retention").and_then(Value::as_str) == Some("legacy");
        let actual = if legacy { with_retention_mode("legacy", || run(name, &args)).expect("режим legacy") } else { run(name, &args) };
        let matches = match (&actual, case) {
            (Err(error), case) if case.get("error").is_some() => *error == case["error"],
            (Ok(value), case) if case.get("sha256").is_some() => hash::sha256_hex(js::stringify(value)) == case["sha256"].as_str().expect("sha256"),
            (Ok(value), case) if case.get("result").is_some() => js::stringify(value) == js::stringify(&case["result"]),
            _ => false,
        };
        if !matches {
            let shown = match &actual {
                Ok(value) => text_head(&js::stringify(value)),
                Err(error) => js::stringify(error),
            };
            failures.push(format!("#{index} {name}\n  JS:   {}\n  Rust: {shown}", text_head(&js::stringify(&json!({ "result": case.get("result"), "sha256": case.get("sha256"), "error": case.get("error") })))));
        }
    }
    let total = failures.len();
    failures.truncate(25);
    assert!(total == 0, "расхождений {total}:\n{}", failures.join("\n"));
}

fn text_head(text: &str) -> String {
    text.chars().take(1200).collect()
}

#[test]
fn captured_calls_match_js() {
    check_fixture(&CAPTURE, 60);
}

#[test]
fn corpus_and_random_squads_match_js() {
    check_fixture(&CASES, 15_000);
}

// --- перенос test/item-lifecycle.test.mjs ----------------------------------

fn hero(id: &str, inventory: Value) -> Value {
    json!({ "id": id, "abilities": { "str": 10, "dex": 14 }, "inventory": inventory })
}

fn state(players: &[Value], combat: bool, ruleset_id: &str) -> Value {
    let ids: Vec<Value> = players.iter().map(|player| player["id"].clone()).collect();
    json!({ "ruleset_id": ruleset_id, "players": players, "partyMemberIds": ids, "mechanics": { "combat": { "active": combat } } })
}

fn context(id: &str) -> Value {
    json!({ "allowedActorIds": [id] })
}

fn find<'a>(actor: &'a Value, id: &str) -> &'a Value {
    actor["inventory"].as_array().expect("инвентарь").iter().find(|item| item["id"] == id).expect("вещь")
}

#[test]
fn equipment_replaces_the_same_slot_and_derives_armor_class() {
    let owner = hero(
        "hero-1",
        json!([
            { "id": "armor", "catalog_id": "srd_5_2_1:leather-armor", "name": "Leather", "type": "armor", "quantity": 1 },
            { "id": "shield", "catalog_id": "srd_5_2_1:shield", "name": "Shield", "type": "armor", "quantity": 1, "equipped": true },
            { "id": "old-weapon", "catalog_id": "srd_5_2_1:dagger", "name": "Dagger", "type": "weapon", "quantity": 1, "equipped": true },
            { "id": "new-weapon", "catalog_id": "srd_5_2_1:longsword", "name": "Longsword", "type": "weapon", "quantity": 1 },
        ]),
    );
    let command = json!({ "command_type": "EquipItem", "command_id": "equip-1", "actor_id": "hero-1", "item_id": "new-weapon", "equipped": true });
    let validated = validate_item_lifecycle_command(&command, &state(&[owner.clone()], false, "srd_5_2_1"), Some(&context("hero-1"))).expect("команда");
    let events = item_lifecycle_events(&validated).expect("события");
    let next = apply_item_lifecycle_event_to_players(Some(&json!([owner])), &events[0]).expect("герои");
    let next = &next[0];
    assert_eq!(find(next, "old-weapon")["equipped"], false);
    assert_eq!(find(next, "new-weapon")["equipped"], true);
    assert_eq!(derived_equipment_armor_class(Some(next), true).expect("КД"), json!(14));
}

#[test]
fn transfer_conserves_quantity_and_rejects_over_capacity_recipients() {
    let source = hero("hero-1", json!([{ "id": "ration", "catalog_id": "srd_5_2_1:rations-one-day", "name": "Rations", "type": "consumable", "quantity": 4, "weight": 2 }]));
    let recipient = hero("hero-2", json!([]));
    let command = json!({ "command_type": "TransferItem", "command_id": "transfer-1", "actor_id": "hero-1", "item_id": "ration", "recipient_id": "hero-2", "quantity": 3 });
    let validated = validate_item_lifecycle_command(&command, &state(&[source.clone(), recipient.clone()], false, "srd_5_2_1"), Some(&context("hero-1"))).expect("команда");
    let events = item_lifecycle_events(&validated).expect("события");
    let next = apply_item_lifecycle_event_to_players(Some(&json!([source.clone(), recipient])), &events[0]).expect("герои");
    assert_eq!(next[0]["inventory"][0]["quantity"], 1);
    assert_eq!(next[1]["inventory"][0]["quantity"], 3);
    assert_eq!(inventory_load_for(Some(&next[1])).expect("нагрузка")["weight"], 6);
    assert_eq!(carrying_capacity(Some(&next[1])), json!(150));

    let mut overloaded = hero("hero-3", json!([]));
    overloaded["abilities"] = json!({ "str": 0, "dex": 10 });
    let command = json!({ "command_type": "TransferItem", "command_id": "transfer-2", "actor_id": "hero-1", "item_id": "ration", "recipient_id": "hero-3", "quantity": 4 });
    let error = validate_item_lifecycle_command(&command, &state(&[source, overloaded], false, "srd_5_2_1"), Some(&context("hero-1"))).expect_err("перегруз");
    assert_eq!(error.code(), Some("CARRYING_CAPACITY_EXCEEDED"));
}

#[test]
fn usable_items_are_server_profiled_and_attunement_is_limited() {
    let mut inventory = vec![json!({ "id": "potion", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Potion", "type": "consumable", "quantity": 1 })];
    for number in 1..=3 {
        inventory.push(json!({ "id": format!("magic-{number}"), "name": format!("Magic {number}"), "type": "other", "quantity": 1, "requires_attunement": true, "attuned_to": "hero-1" }));
    }
    inventory.push(json!({ "id": "fourth", "name": "Fourth", "type": "other", "quantity": 1, "requires_attunement": true }));
    let owner = hero("hero-1", Value::Array(inventory));
    let use_command = json!({ "command_type": "UseItem", "actor_id": "hero-1", "item_id": "potion", "target_id": "hero-1" });
    let used = validate_item_lifecycle_command(&use_command, &state(&[owner.clone()], true, "srd_5_2_1"), Some(&context("hero-1"))).expect("применение");
    assert_eq!(
        used["use_profile"],
        json!({ "kind": "healing", "expression": "2d4+2", "consumes": 1, "combat_action": "bonus_action", "range_feet": 5, "target": "party" })
    );
    let classic = validate_item_lifecycle_command(&use_command, &state(&[owner.clone()], true, "dnd_5e_2014"), Some(&context("hero-1"))).expect("применение 2014");
    assert_eq!(classic["use_profile"]["combat_action"], "action");
    let attune = json!({ "command_type": "AttuneItem", "actor_id": "hero-1", "item_id": "fourth", "attuned": true });
    let error = validate_item_lifecycle_command(&attune, &state(&[owner], false, "srd_5_2_1"), Some(&context("hero-1"))).expect_err("предел");
    assert_eq!(error.code(), Some("ATTUNEMENT_LIMIT_REACHED"));
}

#[test]
fn passive_effect_totals_clamp_and_deduplicate_groups() {
    let effect = |group: &str, armor: Value| json!({ "schema_version": 1, "effect_id": format!("{group}:e"), "group": group, "armor_class_bonus": armor, "saving_throw_bonus": 1 });
    let actor = json!({ "id": "hero", "inventory": [
        { "id": "a", "quantity": 1, "passive_effects": [effect("ring", json!(2)), effect("ring", json!(1))] },
        { "id": "b", "quantity": 1, "passive_effects": [effect("cloak", json!(1000))] },
        { "id": "c", "quantity": 0, "passive_effects": [effect("zero", json!(5))] },
    ] });
    assert_eq!(active_item_effect_totals(Some(&actor)).expect("итог"), json!({ "armor_class_bonus": 100, "saving_throw_bonus": 2, "active_groups": ["cloak", "ring"] }));
    // Мусор старого сохранения: инвентарь-объект — TypeError, как у JS.
    assert!(matches!(active_item_effect_totals(Some(&json!({ "inventory": {} }))), Err(ItemLifecycleError::Type(_))));
}
