//! Ветки `resolveCommandInternal`: Предметы: выдача, жизненный цикл (надеть, передать, настроиться, активировать), использование. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 22755–22760, 22897–22931, 22932–23127. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::{game, js};
use sk_items_life::item_lifecycle::{item_lifecycle_events, ItemLifecycleError, ITEM_DESTROYED_EVENT_SCHEMA_VERSION};

use super::kernel::MagicMissile;
use super::Resolve;
use crate::combat::weapons::{combat_item_for_command, item_instance_key, shillelagh_removal_events, ShillelaghRemoval};
use crate::command::rules::rule_ids;
use crate::core::{actor_max_hp, assert_mechanics_supported, command_with_rules, event_from, inventory_item, item_granted_event_from, spread_value, unique_strings};
use crate::npc_item_events::{npc_item_use_events, spilled_zone_events, thrown_flask_events, FlaskItem};
use crate::pause::{rule, Fault, Halt, Step};
use crate::turn_economy::ACTION_ECONOMY_EVENT_VERSION;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// Поле, которое JS кладёт как есть (`undefined` в JSON не попадает).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `value ?? null`.
fn or_null(value: Option<&Value>) -> Value {
    value.filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

/// `String(value ?? fallback)`.
fn string_or(value: Option<&Value>, fallback: &str) -> String {
    match value.filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => fallback.to_string(),
    }
}

fn lifecycle_halt(error: ItemLifecycleError) -> Halt {
    match error {
        ItemLifecycleError::Validation { message, code } => rule(message, &code),
        ItemLifecycleError::Type(message) => Fault::type_error(message).into(),
    }
}

/// `[command.actor_id]`.
fn actor_targets(command: &Value) -> Value {
    json!([command.get("actor_id").cloned().unwrap_or(Value::Null)])
}

/// `[command.target_id]`.
fn target_targets(command: &Value) -> Value {
    json!([command.get("target_id").cloned().unwrap_or(Value::Null)])
}

/// `command.visibility ?? fallback`.
fn visibility_or(command: &Value, fallback: &str) -> Value {
    command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!(fallback))
}

/// `GrantItem` (22755–22760).
pub fn grant_item(r: &mut Resolve<'_>) -> Step {
    let mut item = match r.command.get("item") {
        None | Some(Value::Null) => js::obj(),
        Some(item) => item.clone(),
    };
    if !js::truthy(item.get("id")) {
        let id = (r.uuid)();
        match item.as_object_mut() {
            Some(map) => {
                map.insert("id".into(), Value::String(id));
            }
            None => return Err(Fault::type_error("Cannot create property 'id' on primitive").into()),
        }
    }
    let event = item_granted_event_from(&r.command, Some(json!({ "item": item })), Some(&actor_targets(&r.command)));
    r.events.push(event);
    Ok(())
}

/// `EquipItem`, `TransferItem`, `AttuneItem`, `ActivateItem` (22897–22931).
pub fn item_lifecycle(r: &mut Resolve<'_>) -> Step {
    for item_event in item_lifecycle_events(&r.command).map_err(lifecycle_halt)? {
        let event_type = js::s(item_event.get("event_type"));
        let resolved = event_from(&r.command, &event_type, item_event.get("payload").cloned(), item_event.get("target_ids"));
        let resolved = match item_event.get("event_schema_version").filter(|value| js::truthy(Some(value))) {
            Some(version) => {
                let mut map = spread_value(Some(&resolved));
                map.insert("event_schema_version".into(), version.clone());
                Value::Object(map)
            }
            None => resolved,
        };
        r.events.push(resolved);
    }
    let kind = r.command_type();
    let actor_id = js::s(r.command.get("actor_id"));
    let item_key = || {
        let actor = game::find_actor(&r.state, &actor_id);
        item_instance_key(combat_item_for_command(actor, r.command.get("item_id")))
    };
    if kind == "EquipItem" && js::is_false(r.command.get("equipped")) {
        let key = item_key();
        let removed = shillelagh_removal_events(&r.state, &r.command, ShillelaghRemoval { item_key: Some(&key), exclude_item_key: None, reason: Some("weapon-released") });
        r.events.extend(removed);
    }
    if kind == "EquipItem" && js::is_true(r.command.get("equipped")) && js::s(r.command.get("equip_slot")) == "main_hand" {
        let key = item_key();
        let removed = shillelagh_removal_events(&r.state, &r.command, ShillelaghRemoval { item_key: None, exclude_item_key: Some(&key), reason: Some("weapon-swapped") });
        r.events.extend(removed);
    }
    if kind == "TransferItem" {
        let key = item_key();
        let removed = shillelagh_removal_events(&r.state, &r.command, ShillelaghRemoval { item_key: Some(&key), exclude_item_key: None, reason: Some("weapon-transferred") });
        r.events.extend(removed);
    }
    Ok(())
}

/// Каким временем мира начинается состояние «в раундах»: `timing_version: 2`.
fn timed_condition(condition: &str, rounds: i64, command: &Value, item: &Value, started_at: f64) -> Value {
    let mut payload = Map::new();
    payload.insert("condition".into(), json!(condition));
    payload.insert("duration".into(), Value::String(format!("rounds:{rounds}")));
    insert_present(&mut payload, "source_actor", command.get("actor_id"));
    insert_present(&mut payload, "source_item_id", item.get("id"));
    payload.insert("timing_version".into(), json!(2));
    payload.insert("started_at_seconds".into(), js::num(started_at));
    payload.insert("expires_at_seconds".into(), js::num(started_at + (rounds * 6) as f64));
    Value::Object(payload)
}

/// `UseItem` (22932–23127).
pub fn use_item(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    if js::truthy(command.get("npc_item")) {
        let events = npc_item_use_events(r, &state, &command)?;
        r.events.extend(events);
        return Ok(());
    }
    let actor_id = js::s(command.get("actor_id"));
    let actor = game::find_actor(&state, &actor_id).cloned();
    let Some(item) = inventory_item(actor.as_ref(), command.get("item_id")).cloned() else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'id')").into());
    };
    let profile = command.get("use_profile").cloned().unwrap_or(Value::Null);
    let use_kind = profile.get("kind").and_then(Value::as_str).map(str::to_string);
    let kind_is = |wanted: &str| use_kind.as_deref() == Some(wanted);
    let casts_spell = kind_is("cast_spell");
    let spill = command.get("use_mode").and_then(Value::as_str) == Some("spill");
    let mut payload = Map::new();
    insert_present(&mut payload, "item_id", item.get("id"));
    insert_present(&mut payload, "item_name", item.get("name"));
    insert_present(&mut payload, "kind", profile.get("kind"));
    insert_present(&mut payload, "target_id", command.get("target_id"));
    if casts_spell {
        payload.insert("combat_action".into(), Value::Null);
    } else {
        insert_present(&mut payload, "combat_action", profile.get("combat_action"));
    }
    payload.insert("attack_replacement".into(), json!(js::is_true(profile.get("attack_replacement")) && !spill));
    if game::combat_active(&state) {
        payload.insert("action_economy_version".into(), json!(ACTION_ECONOMY_EVENT_VERSION));
    }
    if casts_spell {
        insert_present(&mut payload, "declared_combat_action", profile.get("combat_action"));
        insert_present(&mut payload, "charges_to_spend", command.get("charges_to_spend"));
    }
    payload.insert("request_fingerprint".into(), or_null(command.get("request_fingerprint")));
    r.events.push(event_from(&command, "ItemUsed", Some(Value::Object(payload)), Some(&target_targets(&command))));
    let target_id = js::s(command.get("target_id"));
    if casts_spell {
        let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(profile.get("spell_id"), None);
        let usable = spell.as_ref().is_some_and(|spell| spell.get("id").and_then(Value::as_str) == Some("magic-missile") && js::is_true(spell.get("automaticHit")) && js::truthy(spell.get("projectileCount")));
        let Some(spell) = spell.filter(|_| usable) else {
            return Err(rule("Серверный профиль заклинания предмета недоступен", "ITEM_SPELL_NOT_AVAILABLE"));
        };
        assert_mechanics_supported(Some(&spell), "заклинания предмета")?;
        let mut source = Map::new();
        source.insert("kind".into(), json!("magic-item"));
        insert_present(&mut source, "item_id", item.get("id"));
        insert_present(&mut source, "item_name", item.get("name"));
        source.insert("catalog_id".into(), or_null(item.get("catalog_id")));
        // `spell.damageType ?? spell.damageTypes?.[0] ?? 'force'`.
        let damage_type = crate::core::coalesce(&[spell.get("damageType"), spell.get("damageTypes").and_then(|types| types.get(0))]).cloned().unwrap_or_else(|| json!("force"));
        let mut cast = Map::new();
        insert_present(&mut cast, "spell_id", spell.get("id"));
        insert_present(&mut cast, "name", spell.get("name"));
        insert_present(&mut cast, "kind", spell.get("kind"));
        insert_present(&mut cast, "action_type", profile.get("combat_action"));
        insert_present(&mut cast, "level", spell.get("level"));
        insert_present(&mut cast, "slot_level", command.get("charges_to_spend"));
        insert_present(&mut cast, "range_feet", profile.get("range_feet"));
        cast.insert("concentration".into(), json!(false));
        insert_present(&mut cast, "source_url", spell.get("sourceUrl"));
        cast.insert("spell_option".into(), Value::Null);
        cast.insert("damage_type".into(), damage_type.clone());
        cast.insert("source".into(), Value::Object(source));
        r.events.push(event_from(&command, "SpellCast", Some(Value::Object(cast)), Some(&target_targets(&command))));
        let target = game::find_actor(&state, &target_id).cloned().unwrap_or(Value::Null);
        r.append_magic_missile_resolution(MagicMissile {
            source_command: &command,
            spell: &spell,
            target: &target,
            slot_level: command.get("charges_to_spend"),
            damage_type: &damage_type,
            source_item: Some(&item),
        })?;
    }
    if kind_is("healing") {
        let visibility = visibility_or(&command, "party");
        let purpose = format!("item:{}:healing", js::string(item.get("id")));
        let roll = r.roll_dice(profile.get("expression").cloned().unwrap_or(Value::Null), &purpose, command.get("actor_id").cloned().unwrap_or(Value::Null), visibility)?;
        r.rolls.push(roll.clone());
        r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        let target = game::find_actor(&state, &target_id);
        let before = target.map_or(0, game::actor_hp);
        let healed = js::safe_int(roll.get("total"), 0).max(0);
        let after = actor_max_hp(target).min(before + healed);
        let mut payload = Map::new();
        payload.insert("requested_amount".into(), json!(healed));
        payload.insert("applied_amount".into(), json!(after - before));
        payload.insert("hp_before".into(), json!(before));
        payload.insert("hp_after".into(), json!(after));
        insert_present(&mut payload, "item_id", item.get("id"));
        insert_present(&mut payload, "item_name", item.get("name"));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::HEALING]), "HealingApplied", Some(Value::Object(payload)), Some(&target_targets(&command))));
    }
    if kind_is("stabilize") {
        let mut payload = Map::new();
        payload.insert("method".into(), json!("healers-kit"));
        insert_present(&mut payload, "item_id", item.get("id"));
        insert_present(&mut payload, "item_name", item.get("name"));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::ZERO_HP]), "HeroStabilized", Some(Value::Object(payload)), Some(&target_targets(&command))));
    }
    if kind_is("thrown_flask") && !spill {
        let flask = FlaskItem { item: &item, purpose_subject: None };
        let events = thrown_flask_events(r, &state, &command, actor.as_ref(), flask, &profile)?;
        r.events.extend(events);
    }
    if kind_is("spill_zone") || (kind_is("thrown_flask") && spill) {
        let events = spilled_zone_events(&state, &command, &item, &profile)?;
        r.events.extend(events);
    }
    if kind_is("coat_weapon") {
        let wanted = js::s(command.get("weapon_id"));
        let inventory = actor.as_ref().and_then(|actor| actor.get("inventory")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let weapon = inventory.iter().find(|candidate| js::string(at(Some(candidate), "id")) == wanted);
        let valid = weapon.is_some_and(|weapon| js::truthy(weapon.get("combat")) && weapon.get("type").and_then(Value::as_str) == Some("weapon"));
        let Some(weapon) = weapon.filter(|_| valid) else {
            return Err(rule("Яд наносится на оружие из инвентаря героя", "INVALID_WEAPON"));
        };
        let mut payload = Map::new();
        payload.insert("condition".into(), Value::String(format!("weapon-coated:{}", js::string(weapon.get("id")))));
        payload.insert("duration".into(), Value::String(string_or(profile.get("duration"), "rounds:10")));
        insert_present(&mut payload, "source_actor", command.get("actor_id"));
        payload.insert("rider_damage".into(), Value::String(js::string(profile.get("rider_damage"))));
        payload.insert("rider_damage_type".into(), Value::String(string_or(profile.get("rider_damage_type"), "poison")));
        payload.insert("rider_source_name".into(), Value::String(js::string(item.get("name"))));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(payload)), Some(&actor_targets(&command))));
    }
    if kind_is("knight_tear") {
        if js::string(command.get("target_id")) == js::string(command.get("actor_id")) {
            let amount = js::safe_int(profile.get("shield_temporary_hp"), 50).max(1);
            let before = js::safe_int(game::mechanics(&state).get("temporary_hp").and_then(|all| all.get(actor_id.as_str())), 0).max(0);
            let mut payload = Map::new();
            payload.insert("offered".into(), json!(amount));
            payload.insert("temporary_hp_before".into(), json!(before));
            payload.insert("temporary_hp_after".into(), json!(before.max(amount)));
            insert_present(&mut payload, "item_id", item.get("id"));
            insert_present(&mut payload, "item_name", item.get("name"));
            payload.insert("effect".into(), json!("knight-tear-shield"));
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::HEALING]), "TemporaryHitPointsGranted", Some(Value::Object(payload)), Some(&actor_targets(&command))));
        } else {
            let rounds = js::safe_int(profile.get("scale_duration_rounds"), 10).max(1);
            let started = crate::world_clock::world_time_seconds(&state);
            let payload = timed_condition("fragile-scale", rounds, &command, &item, started);
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&target_targets(&command))));
        }
    }
    if kind_is("party_fire_ward") {
        let rounds = js::safe_int(profile.get("duration_rounds"), 10).max(1);
        let started = crate::world_clock::world_time_seconds(&state);
        let empty = json!([]);
        for hero_id in unique_strings(Some(state.get("partyMemberIds").filter(|value| !value.is_null()).unwrap_or(&empty))) {
            if !game::find_actor(&state, &hero_id).is_some_and(game::is_living_actor) {
                continue;
            }
            let payload = timed_condition("lomar-ward", rounds, &command, &item, started);
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&json!([hero_id]))));
        }
    }
    if kind_is("antitoxin") {
        let minutes = js::safe_int(profile.get("duration_minutes"), 60).max(1);
        let started = js::safe_int(js::path(&state, &["mechanics", "world_time", "elapsed_minutes"]), 0).max(0);
        let mut payload = Map::new();
        payload.insert("condition".into(), json!("antitoxin"));
        payload.insert("duration".into(), Value::String(format!("minutes:{minutes}")));
        insert_present(&mut payload, "source_actor", command.get("actor_id"));
        insert_present(&mut payload, "source_item_id", item.get("id"));
        payload.insert("save_condition".into(), json!("poisoned"));
        payload.insert("started_at_minutes".into(), json!(started));
        payload.insert("expires_at_minutes".into(), json!(started + minutes));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS, rule_ids::ADVANTAGE]), "ConditionAdded", Some(Value::Object(payload)), Some(&actor_targets(&command))));
    }
    if js::safe_int(profile.get("consumes"), 0) > 0 {
        let mut payload = Map::new();
        insert_present(&mut payload, "item_id", item.get("id"));
        insert_present(&mut payload, "item_name", item.get("name"));
        payload.insert("quantity".into(), json!(js::safe_int(profile.get("consumes"), 1)));
        r.events.push(event_from(&command, "ItemConsumed", Some(Value::Object(payload)), Some(&actor_targets(&command))));
    }
    if let Some(charge) = command.get("charge_spend").filter(|value| js::truthy(Some(value))) {
        let mut payload = Map::new();
        insert_present(&mut payload, "item_id", item.get("id"));
        insert_present(&mut payload, "item_name", item.get("name"));
        for key in ["before", "spent", "after", "max"] {
            insert_present(&mut payload, key, charge.get(key));
        }
        let reason = if kind_is("stabilize") {
            "healers-kit-stabilization"
        } else if casts_spell {
            "wand-of-magic-missiles-cast"
        } else {
            "item-use"
        };
        payload.insert("reason".into(), json!(reason));
        payload.insert("request_fingerprint".into(), or_null(command.get("request_fingerprint")));
        r.events.push(event_from(&command, "ItemChargesSpent", Some(Value::Object(payload)), Some(&actor_targets(&command))));
        let last_charge = charge.get("after").and_then(Value::as_f64) == Some(0.0);
        if casts_spell && last_charge {
            let visibility = visibility_or(&command, "party");
            let item_id_text = js::string(item.get("id"));
            let roll = r.roll_dice(json!("1d20"), &format!("item:last-charge:{item_id_text}"), command.get("actor_id").cloned().unwrap_or(Value::Null), visibility)?;
            r.rolls.push(roll.clone());
            let natural = js::safe_int(roll.get("dice").and_then(Value::as_array).and_then(|dice| dice.first()), 0);
            let mut rolled = spread_value(Some(&roll));
            insert_present(&mut rolled, "item_id", item.get("id"));
            insert_present(&mut rolled, "item_name", item.get("name"));
            rolled.insert("last_charge".into(), json!(true));
            rolled.insert("natural".into(), json!(natural));
            r.events.push(event_from(&command, "DieRolled", Some(Value::Object(rolled)), Some(&json!([]))));
            if natural == 1 {
                let mut payload = Map::new();
                payload.insert("schema_version".into(), json!(ITEM_DESTROYED_EVENT_SCHEMA_VERSION));
                insert_present(&mut payload, "owner_id", command.get("actor_id"));
                insert_present(&mut payload, "item_id", item.get("id"));
                insert_present(&mut payload, "item_name", item.get("name"));
                payload.insert("catalog_id".into(), or_null(item.get("catalog_id")));
                payload.insert("reason".into(), json!("last-charge-natural-1"));
                insert_present(&mut payload, "trigger_roll_id", roll.get("roll_id"));
                payload.insert("natural".into(), json!(natural));
                payload.insert("request_fingerprint".into(), or_null(command.get("request_fingerprint")));
                let mut event = spread_value(Some(&event_from(&command, "ItemDestroyed", Some(Value::Object(payload)), Some(&actor_targets(&command)))));
                event.insert("event_schema_version".into(), json!(ITEM_DESTROYED_EVENT_SCHEMA_VERSION));
                r.events.push(Value::Object(event));
            }
        }
    }
    Ok(())
}
