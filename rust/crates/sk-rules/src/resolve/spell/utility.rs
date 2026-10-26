//! Заклинание: телепорт и гром на месте ухода («Громовой шаг»). Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 18612–18645.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::common::{actor_id_of, at, field, fold_but_last, hp_after_zero, payload_with, put, Cast};
use super::super::kernel::undef;
use super::super::Resolve;
use crate::checks::saves::saving_throw_succeeded;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, spread_value};
use crate::pause::Step;
use crate::tactical_geometry::point_json;

/// Телепорт (18612–18645).
pub(super) fn teleport(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor_id = cast.actor_id.clone();
    let spell_id = cast.spell_id();
    let to = sk_geometry::Point::from_value(command.get("to"));
    let from = crate::tactical_geometry::actor_point(&state, &actor_id);
    let combat = sk_core::game::combat(&state);
    let spent = super::common::nn(at(at(combat.get("action_economy"), &actor_id), "movement_spent")).cloned().unwrap_or(json!(0));
    let movement = crate::geometry::movement::movement_for_actor(&state, &actor_id);
    let mut payload = Map::new();
    payload.insert("from".into(), super::common::point_value(from));
    payload.insert("to".into(), point_json(to));
    payload.insert("path".into(), json!([point_json(to)]));
    payload.insert("distance".into(), json!(0));
    payload.insert("movement_spent".into(), spent);
    put(&mut payload, "movement_remaining", movement.get("movement_remaining"));
    payload.insert("teleport".into(), Value::Bool(true));
    r.push_ruled(&[rule_ids::TURNS], "ActorMoved", Value::Object(payload), json!([actor_id]));
    let Some(origin) = from else { return Ok(()) };
    if !js::truthy(field(&spell, "damage")) || !js::truthy(field(&spell, "saveAbility")) {
        return Ok(());
    }
    let radius = js::safe_int(field(&spell, "radius"), 10).max(5) as f64;
    let origin_json = point_json(origin);
    let caught: Vec<Value> = sk_core::game::list_actors(&state)
        .into_iter()
        .filter(|candidate| {
            let id = actor_id_of(candidate);
            if !sk_core::game::is_living_actor(candidate) || id == actor_id {
                return false;
            }
            let Some(at_point) = crate::tactical_geometry::actor_point(&state, &id) else { return false };
            sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), cast.actor.as_ref(), Some(&point_json(at_point)), Some(&origin_json)).unwrap_or(0.0) <= radius
        })
        .cloned()
        .collect();
    if caught.is_empty() {
        return Ok(());
    }
    let expression = crate::spells::slots::scaled_spell_dice(Some(&spell), cast.actor.as_ref(), command.get("slot_level")).or_else(|| field(&spell, "damage").cloned()).unwrap_or(Value::Null);
    let blast = r.spell_roll(expression, &format!("spell_damage:{spell_id}"))?;
    r.rolls.push(blast.clone());
    r.push_die(blast.clone());
    let ability = js::string(field(&spell, "saveAbility"));
    let ability_value = Value::String(ability.clone());
    for target in caught {
        let target_id = actor_id_of(&target);
        let mut options = Map::new();
        options.insert("ability".into(), ability_value.clone());
        options.insert("modifier".into(), Value::from(ability_modifier(at(target.get("abilities"), &ability))));
        options.insert("purpose".into(), Value::String(format!("spell_save:{spell_id}:{ability}")));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.spell_save(&state, &target_id, Value::Object(options))?;
        let saved = saving_throw_succeeded(Some(&save), cast.spell_save_dc as f64);
        r.rolls.push(save.clone());
        let mut resolved = spread_value(Some(&save));
        put(&mut resolved, "spell_id", field(&spell, "id"));
        resolved.insert("ability".into(), ability_value.clone());
        resolved.insert("difficulty".into(), Value::from(cast.spell_save_dc));
        resolved.insert("saved".into(), Value::Bool(saved));
        r.push_ruled(&[rule_ids::SAVING_THROW], "SpellSavingThrowResolved", Value::Object(resolved), json!([target_id]));
        let amount = crate::checks::saves::saved_damage_amount(&state, &target_id, Some(&ability_value), saved, js::truthy(field(&spell, "halfOnSave")), blast.get("total"));
        if amount <= 0 {
            continue;
        }
        let payload = r.resolve_damage_payload(&state, &target_id, Value::from(amount), &cast.damage_type.clone(), None, None)?;
        let mut extra = Map::new();
        put(&mut extra, "spell_id", field(&spell, "id"));
        extra.insert("saved".into(), Value::Bool(saved));
        r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", payload_with(&payload, Value::Object(extra)), json!([target_id]));
        if hp_after_zero(&payload) {
            let before = fold_but_last(&state, &r.events)?;
            r.push_zero_hp(&before, &target_id, &payload, false);
        }
    }
    Ok(())
}
