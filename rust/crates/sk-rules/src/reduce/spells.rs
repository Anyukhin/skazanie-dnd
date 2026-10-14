//! Заклинание, смена облика и призыв — ветки `SpellCast`, `ShapeChanged`,
//! `SummonedCreatureCreated` редьюсера `applyGameEventCurrent`.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_hp, actor_id, actor_max_hp, combat, combat_actor_kind, find_actor, is_hostile_summon, is_party_summon, mechanics_mut, replace_actor};
use sk_core::js::{is_false, number, present, s, safe_int, truthy, unique_strings};
use sk_core::Event;
use sk_geometry::actor_footprint::{footprint_metadata_for_size, normalize_footprint_metadata};
use sk_geometry::circular_area_geometry::{grid_origin_for_target_cell, CIRCULAR_AREA_GEOMETRY_VERSION};
use sk_geometry::Point;

use super::conditions::summon_cleanup;
use super::turns::initiative_group_ids;
use super::{scene_turn_and_round, target_of};
use crate::economy::{action_economy, economy_of, event_version, set_economy, spend_combat_economy, spend_versioned_spell_action, ACTION_ECONOMY_EVENT_VERSION};
use crate::journal::{append_battle_log, Entry};

/// `normalizeActorFootprintFields(actor)`: поле `footprint`, если оно есть, —
/// только версионированная метадата, иначе одна клетка.
pub(crate) fn normalize_actor_footprint_fields(actor: Value) -> Value {
    let Value::Object(mut map) = actor else { return actor };
    if !map.contains_key("footprint") {
        return Value::Object(map);
    }
    let footprint = normalize_footprint_metadata(map.get("footprint")).unwrap_or_else(|| footprint_metadata_for_size(Some(&json!(1))));
    map.insert("footprint".into(), footprint.to_value());
    Value::Object(map)
}

/// `isOwnCombatTurn(state, id)`.
pub(crate) fn is_own_combat_turn(state: &Value, id: Option<&str>) -> bool {
    let Some(id) = id else { return false };
    let combat = combat(state);
    if !truthy(combat.get("active")) {
        return false;
    }
    let completed = combat.get("turn_completed").and_then(Value::as_array).is_some_and(|list| list.iter().any(|entry| entry.as_str() == Some(id)));
    if completed {
        return false;
    }
    let index = safe_int(combat.get("active_index"), -1);
    let active = if index >= 0 { combat.get("initiative").and_then(Value::as_array).and_then(|list| list.get(index as usize)).and_then(|entry| entry.get("actor_id")) } else { None };
    sk_core::js::string(active) == id || initiative_group_ids(state).iter().any(|member| member == id)
}

fn safe_point(value: Option<&Value>) -> Option<Value> {
    let value = value.filter(|v| truthy(Some(v)))?;
    let (x, y) = (value.get("x"), value.get("y"));
    (sk_core::js::is_safe_integer_number(x) && sk_core::js::is_safe_integer_number(y)).then(|| json!({ "x": number(x) as i64, "y": number(y) as i64 }))
}

pub fn spell_cast(state: &mut Value, event: &Event) {
    let payload = event.payload.clone();
    let actor = event.actor_id.clone();
    let action_type = payload.get("action_type").and_then(Value::as_str).unwrap_or("").to_string();
    let economy_consumed = !is_false(payload.get("economy_consumed"));
    if payload.get("spellcasting_2014_version").and_then(Value::as_f64) == Some(1.0) && economy_consumed && is_own_combat_turn(state, actor.as_deref()) {
        let id = actor.clone().unwrap_or_default();
        let mut economy = economy_of(state, &id);
        if action_type == "bonus_action" {
            economy["bonus_spell_cast_2014"] = Value::Bool(true);
        } else if payload.get("level").and_then(Value::as_f64) != Some(0.0) || action_type != "action" {
            economy["other_spell_cast_2014"] = Value::Bool(true);
        }
        set_economy(state, &id, economy);
    }
    if payload.get("slot_spell_2024_version").and_then(Value::as_f64) == Some(1.0) && is_own_combat_turn(state, actor.as_deref()) {
        let id = actor.clone().unwrap_or_default();
        let mut economy = economy_of(state, &id);
        economy["slot_spell_cast_2024"] = Value::Bool(true);
        set_economy(state, &id, economy);
    }
    if truthy(combat(state).get("active")) && actor.as_deref().is_some_and(|id| !id.is_empty()) && economy_consumed {
        let id = actor.clone().unwrap_or_default();
        let resource = match action_type.as_str() {
            "bonus_action" => "bonus_action",
            "reaction" => "reaction",
            _ => "action",
        };
        let economy = economy_of(state, &id);
        if resource == "action" && event_version(&economy) >= ACTION_ECONOMY_EVENT_VERSION {
            spend_versioned_spell_action(state, &id);
        } else {
            spend_combat_economy(state, &id, resource, resource == "action", false);
        }
    }
    let from = safe_point(payload.get("from"));
    let to = safe_point(payload.get("to"));
    let area = match (&to, present(payload.get("radius_feet"))) {
        (Some(to), true) => {
            let mut area = to.as_object().cloned().unwrap_or_default();
            area.insert("radiusFeet".into(), Value::from(safe_int(payload.get("radius_feet"), 0).max(0)));
            if payload.get("area_geometry_version").and_then(Value::as_str) == Some(CIRCULAR_AREA_GEOMETRY_VERSION) && truthy(payload.get("area_grid_origin")) {
                let origin = payload.get("area_grid_origin");
                let cell = grid_origin_for_target_cell(Point::new(number(origin.and_then(|o| o.get("x"))), number(origin.and_then(|o| o.get("y")))));
                area.insert("geometryVersion".into(), Value::from(CIRCULAR_AREA_GEOMETRY_VERSION));
                area.insert("gridOrigin".into(), json!({ "x": cell.x, "y": cell.y }));
                area.insert("shape".into(), payload.get("area_shape").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("sphere")));
            }
            Some(Value::Object(area))
        }
        _ => None,
    };
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor_text = actor.clone().unwrap_or_default();
    let mut entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "spell")
        .set("actorId", actor.clone().map_or(Value::Null, Value::from))
        .set("actorKind", combat_actor_kind(state, &actor_text))
        .set("targetId", target_of(event))
        .opt("spellId", payload.get("spell_id").cloned())
        .opt("spellName", payload.get("name").cloned());
    if payload.get("spell_id").and_then(Value::as_str) == Some("longstrider") {
        let targets = Value::Array(event.target_ids.iter().map(|id| Value::String(id.clone())).collect());
        entry = entry.set("targetIds", sk_core::js::strings_value(unique_strings(Some(&targets))));
    }
    let entry = entry.opt("from", from).opt("to", to).opt("area", area).build();
    append_battle_log(state, event, entry);
}

pub fn shape_changed(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let Some(form) = payload.get("form").filter(|form| form.is_object()).cloned() else { return };
    let target = target_of(event);
    let Some(actor) = find_actor(state, &target).cloned() else { return };
    let form_footprint = normalize_footprint_metadata(form.get("footprint"));
    let mut shape = Map::new();
    shape.insert("spell_id".into(), payload.get("spell_id").cloned().unwrap_or(Value::Null));
    if payload.get("shape_contract_version").and_then(Value::as_f64) == Some(2.0) {
        shape.insert("shape_contract_version".into(), json!(2));
        shape.insert("effect_id".into(), payload.get("effect_id").cloned().unwrap_or(Value::Null));
        shape.insert("concentration_actor_id".into(), event.actor_id.clone().map_or(Value::Null, Value::from));
    }
    shape.insert("form".into(), form.clone());
    let armor_source = actor.get("armor").filter(|v| !v.is_null()).or_else(|| actor.get("armorClass"));
    let mut original = json!({
        "hp": actor_hp(&actor),
        "maxHp": actor_max_hp(&actor),
        "armor": safe_int(armor_source, 10),
        "speed": safe_int(actor.get("speed"), 30),
        "attack_profile": if truthy(actor.get("attack_profile")) { actor["attack_profile"].clone() } else { Value::Null },
    });
    if let Some(footprint) = actor.get("footprint") {
        original["footprint"] = footprint.clone();
    }
    shape.insert("original".into(), original);
    {
        let mechanics = mechanics_mut(state);
        let shapes = mechanics.entry("shapes").or_insert_with(sk_core::js::obj);
        if !shapes.is_object() {
            *shapes = sk_core::js::obj();
        }
        if let Some(map) = shapes.as_object_mut() {
            map.insert(target.clone(), Value::Object(shape));
        }
    }
    replace_actor(state, &target, |current| {
        let hp = safe_int(form.get("hp"), 1).max(1);
        let mut patch = json!({
            "hp": hp,
            "maxHp": hp,
            "armor": safe_int(form.get("armor"), 10).max(1),
            "speed": safe_int(form.get("speed"), 30).max(0),
            "attack_profile": if truthy(form.get("attack_profile")) { form["attack_profile"].clone() } else { Value::Null },
        });
        if let Some(footprint) = form_footprint {
            patch["footprint"] = footprint.to_value();
        }
        *current = sk_core::js::spread(current, patch);
    });
}

fn summon_log(state: &mut Value, event: &Event, summon: &Value) {
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor_text = event.actor_id.clone().unwrap_or_default();
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "summon")
        .set("actorId", event.actor_id.clone().map_or(Value::Null, Value::from))
        .set("actorKind", combat_actor_kind(state, &actor_text))
        .set("targetId", actor_id(summon))
        .opt("spellId", summon.get("sourceSpellId").cloned())
        .opt("spellName", summon.get("name").cloned())
        .build();
    append_battle_log(state, event, entry);
}

fn insert_initiative(state: &mut Value, index: usize, entry: Value) -> usize {
    let combat = sk_core::game::combat_mut(state);
    let list = sk_core::js::array_mut(combat, "initiative");
    let at = index.min(list.len());
    list.insert(at, entry);
    at
}

pub fn summoned_creature_created(state: &mut Value, event: &Event) {
    let payload = &event.payload;
    let raw = payload.get("summon").filter(|v| !v.is_null()).cloned().unwrap_or_else(sk_core::js::obj);
    let lifecycle = summon_cleanup(payload) && summon_cleanup(&raw);
    let mut summon = normalize_actor_footprint_fields(raw);
    if !lifecycle {
        if let Some(map) = summon.as_object_mut() {
            for key in ["summon_lifecycle_version", "summonLifecycleVersion", "expires_at_seconds", "expiresAtSeconds"] {
                map.shift_remove(key);
            }
        }
    }
    let id = actor_id(&summon);
    if id.is_empty() || find_actor(state, &id).is_some() {
        return;
    }
    let position = json!({ "x": safe_int(summon.get("x"), 0), "y": safe_int(summon.get("y"), 0) });
    let active = truthy(combat(state).get("active"));
    if is_hostile_summon(&summon) {
        sk_core::js::array_mut(state, "enemies").push(sk_core::js::spread(&summon, json!({ "alive": true })));
        sk_core::js::object_mut(&mut state["mechanics"], "positions").insert(id.clone(), position);
        if active {
            let total = safe_int(payload.get("initiative_total"), 0);
            let initiative = combat(state).get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
            let insert_at = initiative.iter().position(|entry| safe_int(entry.get("total"), 0) < total).unwrap_or(initiative.len());
            insert_initiative(state, insert_at, json!({ "actor_id": id, "total": total, "modifier": safe_int(payload.get("initiative_modifier"), 0) }));
            let active_index = safe_int(combat(state).get("active_index"), 0);
            if insert_at as i64 <= active_index {
                sk_core::game::combat_mut(state)["active_index"] = Value::from(active_index + 1);
            }
            set_economy(state, &id, action_economy());
        }
        summon_log(state, event, &summon);
        return;
    }
    sk_core::js::array_mut(state, "actors").push(summon.clone());
    sk_core::js::object_mut(&mut state["mechanics"], "positions").insert(id.clone(), position);
    if active {
        let initiative = combat(state).get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
        let owner_source = summon.get("ownerId").filter(|v| !v.is_null()).or_else(|| summon.get("owner_id")).filter(|v| !v.is_null());
        let owner = match owner_source {
            Some(value) => s(Some(value)),
            // `?? event.actor_id`: в журнале actor_id без значения — null, String(null) = "null".
            None => event.actor_id.clone().unwrap_or_else(|| "null".into()),
        };
        let owner_index = initiative.iter().position(|entry| sk_core::js::string(entry.get("actor_id")) == owner);
        let mut insert_at = owner_index.map_or(initiative.len(), |index| index + 1);
        while insert_at < initiative.len() {
            let queued = find_actor(state, &s(initiative[insert_at].get("actor_id")));
            let same_owner = queued.is_some_and(|queued| {
                let queued_owner = queued.get("ownerId").filter(|v| !v.is_null()).or_else(|| queued.get("owner_id"));
                is_party_summon(queued) && sk_core::js::string(queued_owner) == owner
            });
            if !same_owner {
                break;
            }
            insert_at += 1;
        }
        let owner_entry = owner_index.and_then(|index| initiative.get(index));
        let mut entry = Map::new();
        entry.insert("actor_id".into(), Value::from(id.clone()));
        if let Some(total) = owner_entry.and_then(|entry| entry.get("total")) {
            entry.insert("total".into(), total.clone());
        }
        if let Some(modifier) = owner_entry.and_then(|entry| entry.get("modifier")) {
            entry.insert("modifier".into(), modifier.clone());
        }
        entry.insert("shared_with".into(), Value::from(owner));
        insert_initiative(state, insert_at, Value::Object(entry));
        set_economy(state, &id, action_economy());
    }
    summon_log(state, event, &summon);
}
