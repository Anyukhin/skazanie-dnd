//! Заклинание: переливание жизни, лечение, «Открывание», «Рассеивание
//! магии», усиление навыка и прочие усиления и полезные заклинания. Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 18227–18589.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::common::{actor_id_of, at, field, fold, fold_but_last, hp, hp_after_zero, is_true, items, level_of, nn, payload_with, put, slot_level_of, template, with_fields, Cast};
use super::super::kernel::undef;
use super::super::Resolve;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with, command_with_rules, condition_ids_for, event_from, spread_value};
use crate::pause::{rule, Step};
use crate::tactical_geometry::npc_positioning::NpcTargetGeometry;

/// Переливание жизни: заклинатель платит хитами, цель получает вдвое (18227–18248).
pub(super) fn life_transference(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor_id = cast.actor_id.clone();
    let spell_id = cast.spell_id();
    let self_damage = field(&spell, "selfDamage").cloned();
    let cost_expression = crate::spells::slots::scaled_spell_dice(Some(&with_fields(&spell, &[("damage", self_damage.clone())])), cast.actor.as_ref(), command.get("slot_level")).or(self_damage);
    let cost_roll = r.spell_roll(Value::String(js::string(Some(cost_expression.as_ref().unwrap_or(&Value::Null)))), &format!("spell_self_damage:{spell_id}"))?;
    r.rolls.push(cost_roll.clone());
    r.push_die(cost_roll.clone());
    let damage_type = Value::String(js::string(Some(nn(field(&spell, "selfDamageType")).unwrap_or(&json!("necrotic")))));
    let cost = r.resolve_damage_payload(&state, &actor_id, cost_roll.get("total").cloned().unwrap_or(Value::Null), &damage_type, None, None)?;
    let mut extra = Map::new();
    put(&mut extra, "spell_id", field(&spell, "id"));
    extra.insert("self_inflicted".into(), Value::Bool(true));
    r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", payload_with(&cost, Value::Object(extra)), json!([actor_id]));
    if hp_after_zero(&cost) {
        let before = fold_but_last(&state, &r.events)?;
        r.push_zero_hp(&before, &actor_id, &cost, false);
    }
    let healed_state = fold(&state, &r.events)?;
    let doubled = js::number(cost.get("applied_amount")) * 2.0;
    for target in cast.affected.clone() {
        let target_id = actor_id_of(&target);
        if target_id == actor_id {
            continue;
        }
        let living = sk_core::game::find_actor(&healed_state, &target_id);
        let before = hp(living);
        let after = if condition_ids_for(&healed_state, &target_id).contains("healing-blocked") { before as f64 } else { (crate::core::actor_max_hp(living) as f64).min(before as f64 + doubled) };
        let mut payload = Map::new();
        put(&mut payload, "spell_id", field(&spell, "id"));
        payload.insert("requested_amount".into(), js::num(doubled));
        payload.insert("applied_amount".into(), js::num(after - before as f64));
        payload.insert("hp_before".into(), Value::from(before));
        payload.insert("hp_after".into(), js::num(after));
        payload.insert("life_transference".into(), Value::Bool(true));
        r.push_ruled(&[rule_ids::HEALING], "HealingApplied", Value::Object(payload), json!([target_id]));
    }
    Ok(())
}

/// Лечение (18249–18306).
pub(super) fn healing(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor = cast.actor.clone();
    let actor_id = cast.actor_id.clone();
    let spell_id = cast.spell_id();
    let uses_2014 = sk_core::game::uses_2014(&state);
    let flat = js::safe_int(field(&spell, "healingAmount"), 0).max(0);
    let expression = if flat > 0 {
        None
    } else {
        let healing_spell = with_fields(&spell, &[("damage", field(&spell, "healing").cloned()), ("upcastDicePerLevel", field(&spell, "upcastHealingDicePerLevel").cloned())]);
        let scaled = crate::spells::slots::scaled_spell_dice(Some(&healing_spell), actor.as_ref(), command.get("slot_level")).or_else(|| field(&spell, "healing").cloned());
        if js::truthy(field(&spell, "addAbilityModifier")) {
            Some(Value::String(crate::core::dice_expression(scaled.as_ref(), Some(&Value::from(cast.spell_modifier)), 4)?))
        } else {
            scaled
        }
    };
    let mut entries: Vec<(Value, String, Option<String>)> = cast.affected.iter().map(|target| (target.clone(), actor_id_of(target), None)).collect();
    for npc in &cast.npc_affected {
        let npc_id = npc.id();
        if let Some(target) = crate::tactical_geometry::npc_positioning::npc_combat_actor_for(&state, &npc_id) {
            entries.push((target, npc_id.clone(), Some(npc_id)));
        }
    }
    entries.retain(|(target, _, _)| js::truthy(Some(target)));
    let immune = |target: &Value| super::common::list_includes(field(&spell, "immuneCreatureTypes"), &crate::spells::slots::creature_type_for(Some(target)));
    let any_target = entries.iter().any(|(target, _, _)| !immune(target));
    let healing_roll = match expression.as_ref().filter(|value| js::truthy(Some(value))) {
        Some(expression) if any_target => {
            let roll = r.spell_roll(expression.clone(), &format!("spell_healing:{spell_id}"))?;
            r.rolls.push(roll.clone());
            r.push_die(roll.clone());
            Some(roll)
        }
        _ => None,
    };
    let slot_level = slot_level_of(&spell, &command);
    let life_domain = crate::spells::slots::life_domain_caster(actor.as_ref());
    let disciple = if uses_2014 && life_domain && level_of(&spell) > 0 { 2 + slot_level } else { 0 };
    let healed_total = match healing_roll.as_ref() {
        Some(roll) => js::number(roll.get("total")),
        None => flat as f64,
    } + disciple as f64;
    let healed_total_value = js::num(healed_total);
    let mut restored_other = false;
    for (target, target_id, npc_id) in entries {
        if immune(&target) {
            continue;
        }
        let healing = crate::damage::resolved_healing_roll(&state, &target_id, expression.as_ref(), Some(&healed_total_value));
        let amount = js::number(healing.get("amount"));
        let before = sk_core::game::actor_hp(&target) as f64;
        let blocked = condition_ids_for(&state, &target_id).contains("healing-blocked");
        let after = if blocked { before } else { (crate::core::actor_max_hp(Some(&target)) as f64).min(before + amount) };
        let mut payload = Map::new();
        put(&mut payload, "spell_id", field(&spell, "id"));
        if let Some(npc_id) = npc_id.as_ref() {
            payload.insert("npc_id".into(), Value::String(npc_id.clone()));
        }
        put(&mut payload, "requested_amount", healing.get("amount"));
        payload.insert("applied_amount".into(), js::num(after - before));
        payload.insert("hp_before".into(), js::num(before));
        payload.insert("hp_after".into(), js::num(after));
        for (key, value) in spread_value(Some(&healing)) {
            payload.insert(key, value);
        }
        if disciple != 0 {
            payload.insert("disciple_of_life_bonus".into(), Value::from(disciple));
        }
        r.push_ruled(&[rule_ids::HEALING], "HealingApplied", Value::Object(payload), json!([target_id]));
        if after > before && target_id != actor_id {
            restored_other = true;
        }
        for condition in items(field(&spell, "removesConditions")) {
            let name = js::string(Some(&condition));
            if !condition_ids_for(&state, &target_id).contains(&name) {
                continue;
            }
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String(name));
            put(&mut payload, "spell_id", field(&spell, "id"));
            payload.insert("trigger".into(), json!("restoration"));
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", Value::Object(payload), json!([target_id]));
        }
    }
    if restored_other && uses_2014 && life_domain && js::safe_int(at(actor.as_ref(), "level"), 1) >= 6 {
        let current = fold(&state, &r.events)?;
        let caster = sk_core::game::find_actor(&current, &actor_id);
        let before = hp(caster);
        let amount = 2 + slot_level;
        let after = if condition_ids_for(&current, &actor_id).contains("healing-blocked") { before } else { crate::core::actor_max_hp(caster).min(before + amount) };
        let mut payload = Map::new();
        put(&mut payload, "spell_id", field(&spell, "id"));
        payload.insert("reason".into(), json!("blessed-healer"));
        payload.insert("requested_amount".into(), Value::from(amount));
        payload.insert("applied_amount".into(), Value::from(after - before));
        payload.insert("hp_before".into(), Value::from(before));
        payload.insert("hp_after".into(), Value::from(after));
        r.push_ruled(&[rule_ids::HEALING], "HealingApplied", Value::Object(payload), json!([actor_id]));
    }
    Ok(())
}

/// «Открывание»: замок снимается без проверки, и стук слышно (18307–18346).
pub(super) fn knock(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor_id = cast.actor_id.clone();
    // `ensureSceneTacticalMap(state)` в JS пишет собранную карту в `state.scene.map`.
    let map = crate::scene_map_sync::ensure_scene_tactical_map(&mut r.state).map_err(crate::scene::placement::map_error)?;
    let state = r.state.clone();
    let to = command.get("to");
    let at_point = sk_geometry::Point::from_value(to);
    let integral = |value: f64| value.is_finite() && value.fract() == 0.0;
    let door = match map.as_ref() {
        Some(map) if integral(at_point.x) && integral(at_point.y) => sk_tactical::tactical_map::doors_reachable_from(map, at_point.x as i64, at_point.y as i64).into_iter().find(|door| door.state == "locked").cloned(),
        _ => None,
    };
    let prop = match (map.as_ref(), door.as_ref()) {
        (Some(map), None) => {
            let props: Vec<Value> = map.props.iter().map(|prop| prop.to_json()).collect();
            map.props
                .iter()
                .zip(props.iter())
                .find(|(prop, json)| {
                    if !prop.interactive || crate::geometry::footprint::actor_object_distance_cells(&state, &actor_id, json, Some(at_point)) > 1.0 {
                        return false;
                    }
                    let Some(definition) = sk_tactical::scene_interactions::scene_interaction_definition(&map.seed, &props, json.get("id")) else { return false };
                    crate::scene::objects::scene_object_state(&state, prop, &definition).get("state").and_then(Value::as_str) == Some("locked")
                })
                .map(|(prop, json)| (prop.clone(), json.clone()))
        }
        _ => None,
    };
    if door.is_none() && prop.is_none() {
        return Err(rule("Здесь нет запертого замка", "NO_LOCK_TO_OPEN"));
    }
    let notice = json!({ "reason": "noise", "severity": sk_ruleset::lockpicking::LOCKPICK_NOISE_SEVERITY.fumble, "loud": true });
    if let Some(door) = door {
        let mut payload = Map::new();
        payload.insert("door_id".into(), Value::String(door.id.clone()));
        payload.insert("state".into(), json!("closed"));
        payload.insert("previous_state".into(), json!("locked"));
        payload.insert("method".into(), json!("knock"));
        put(&mut payload, "spell_id", field(&spell, "id"));
        r.events.push(event_from(&command, "DoorStateChanged", Some(Value::Object(payload)), Some(&json!([]))));
        let kind = json!("door");
        let id = Value::String(door.id.clone());
        let label = json!("дверь");
        let events = crate::lockpick::lockpick_notice_events(&state, &command, crate::lockpick::LockpickNotice { target_kind: Some(&kind), target_id: Some(&id), target_label: Some(&label), check: None, notice: Some(&notice) });
        r.events.extend(events);
    } else if let Some((prop, _)) = prop {
        let mut payload = Map::new();
        payload.insert("prop_id".into(), Value::String(prop.id.clone()));
        payload.insert("state".into(), json!("closed"));
        payload.insert("previous_state".into(), json!("locked"));
        payload.insert("success".into(), Value::Bool(true));
        payload.insert("intent".into(), json!("lockpick"));
        payload.insert("method".into(), json!("knock"));
        put(&mut payload, "spell_id", field(&spell, "id"));
        r.events.push(event_from(&command, "SceneObjectStateChanged", Some(Value::Object(payload)), Some(&json!([]))));
        let kind = json!("prop");
        let id = Value::String(prop.id.clone());
        let label_text = sk_tactical::scene_interactions::scene_object_label_for(Some(&Value::String(prop.asset_id.clone())));
        let label = Value::String(if label_text.is_empty() { "чужой замок".into() } else { label_text });
        let events = crate::lockpick::lockpick_notice_events(&state, &command, crate::lockpick::LockpickNotice { target_kind: Some(&kind), target_id: Some(&id), target_label: Some(&label), check: None, notice: Some(&notice) });
        r.events.extend(events);
    }
    Ok(())
}

/// «Рассеивание магии»: концентрация и длящиеся области в точке (18347–18396).
pub(super) fn dispel_magic(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor_id = cast.actor_id.clone();
    let uses_2014 = sk_core::game::uses_2014(&state);
    let at_point = sk_geometry::Point::from_value(command.get("to"));
    let slot_level = slot_level_of(&spell, &command);
    let caught: Vec<Value> = items(sk_core::game::mechanics(&state).get("active_effects")).into_iter().filter(|effect| crate::areas::shape::position_in_effect(&state, Some(at_point), effect, None)).collect();
    if caught.is_empty() {
        return Err(rule("В этой точке нет магического эффекта", "NO_MAGIC_TO_DISPEL"));
    }
    let ability = Value::String(cast.spell_ability.clone());
    for effect in caught {
        let effect_spell = sk_combat_content::combat_spells::canonical_combat_spell_for(effect.get("spell_id"), None);
        let base_level = js::safe_int(at(effect_spell.as_ref(), "level"), 0).max(0);
        let effect_level = if uses_2014 && effect.get("spell_level_version").and_then(Value::as_f64) == Some(1.0) { base_level.max(js::safe_int(effect.get("slot_level"), base_level)) } else { base_level };
        let mut dispelled = true;
        if effect_level > slot_level {
            let modifier = if uses_2014 { ability_modifier(at(at(cast.actor.as_ref(), "abilities"), &cast.spell_ability)) } else { cast.spell_attack_modifier };
            let mut options = Map::new();
            options.insert("modifier".into(), Value::from(modifier));
            options.insert("difficulty".into(), Value::from(10 + effect_level));
            options.insert("purpose".into(), Value::String(format!("spell_dispel:{}", template(effect.get("spell_id")))));
            options.insert("actorId".into(), Value::String(actor_id.clone()));
            options.insert("visibility".into(), undef(command.get("visibility")));
            let check = crate::checks::saves::roll_ability_check_with_conditions(&state, &mut r.dice, &actor_id, Some(&ability), &Value::Object(options), crate::checks::saves::D20Method::RollCheck)?;
            r.rolls.push(check.clone());
            let mut payload = Map::new();
            payload.insert("ability".into(), ability.clone());
            for (key, value) in spread_value(Some(&check)) {
                payload.insert(key, value);
            }
            put(&mut payload, "spell_id", field(&spell, "id"));
            put(&mut payload, "dispel_target_spell_id", effect.get("spell_id"));
            r.push_ruled(&[rule_ids::ABILITY_CHECK], "AbilityCheckResolved", Value::Object(payload), json!([actor_id]));
            dispelled = js::truthy(check.get("success"));
        }
        if !dispelled {
            continue;
        }
        let owner = js::s(effect.get("source_actor"));
        let effect_id = js::s(nn(effect.get("effect_id")).or_else(|| effect.get("id")));
        let concentration = at(at(sk_core::game::mechanics(&state).get("concentration"), &owner), "effect_id");
        if !owner.is_empty() && js::s(concentration) == effect_id {
            let source = command_with_rules(&command_with(&command, "actor_id", Value::String(owner.clone())), &[rule_ids::CONCENTRATION]);
            let mut payload = Map::new();
            payload.insert("reason".into(), json!("dispelled"));
            payload.insert("effect_id".into(), Value::String(effect_id));
            put(&mut payload, "spell_id", field(&spell, "id"));
            r.events.push(event_from(&source, "ConcentrationEnded", Some(Value::Object(payload)), Some(&json!([owner]))));
        } else {
            let mut payload = Map::new();
            payload.insert("effect_id".into(), Value::String(effect_id));
            put(&mut payload, "spell_id", effect.get("spell_id"));
            payload.insert("reason".into(), json!("dispelled"));
            r.push_ruled(&[rule_ids::CONDITIONS], "SpellAreaRemoved", Value::Object(payload), json!([]));
        }
    }
    Ok(())
}

/// «Заимствованные знания» и «Усиление навыка» (18397–18428).
pub(super) fn skill_buff(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let spell_id = cast.spell_id();
    let target = match cast.affected.first() {
        Some(target) => Some(target.clone()),
        None if field(&spell, "target").and_then(Value::as_str) == Some("self") => cast.actor.clone(),
        None => None,
    };
    let target_id = target.as_ref().map(actor_id_of).unwrap_or_default();
    let skill = crate::checks::skills::canonical_skill_id(command.get("spell_option"));
    let borrowed = spell_id == "borrowed-knowledge";
    let prefix = if borrowed { crate::checks::skills::BORROWED_KNOWLEDGE_CONDITION_PREFIX } else { crate::checks::skills::SKILL_EMPOWERMENT_CONDITION_PREFIX };
    let started = crate::world_clock::world_time_seconds(&state);
    if borrowed {
        for condition in sk_core::game::conditions(&state, &target_id).to_vec() {
            if crate::checks::skills::skill_from_condition(&condition, crate::checks::skills::BORROWED_KNOWLEDGE_CONDITION_PREFIX).is_some() {
                let mut payload = Map::new();
                payload.insert("condition".into(), Value::String(js::string(condition.get("id"))));
                put(&mut payload, "spell_id", field(&spell, "id"));
                payload.insert("trigger".into(), json!("recast"));
                r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", Value::Object(payload), json!([target_id]));
            }
        }
    }
    let mut payload = Map::new();
    payload.insert("condition".into(), Value::String(format!("{prefix}{skill}")));
    payload.insert("duration".into(), json!(if spell_id == "skill-empowerment" { "concentration" } else { "minutes:60" }));
    payload.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
    payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
    put(&mut payload, "spell_id", field(&spell, "id"));
    payload.insert("spell_option".into(), Value::String(skill));
    payload.insert("skill_buff_version".into(), json!(1));
    payload.insert("timing_version".into(), json!(2));
    payload.insert("started_at_seconds".into(), js::num(started));
    payload.insert("expires_at_seconds".into(), js::num(started + 3_600.0));
    r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
    Ok(())
}

/// Состояния усиления (18435–18448).
fn buff_conditions(spell: &Value, command: &Value, uses_2014: bool) -> Vec<Value> {
    let option = js::s(command.get("spell_option"));
    let chosen = at(field(spell, "conditionsByOption"), &option).and_then(Value::as_array).filter(|list| !list.is_empty());
    if let Some(chosen) = chosen {
        return chosen.clone();
    }
    if let Some(by_slot) = crate::spells::slots::conditions_for_slot_level(Some(spell), command.get("slot_level")).filter(|list| !list.is_empty()) {
        return by_slot.into_iter().map(Value::String).collect();
    }
    let id = field(spell, "id").and_then(Value::as_str);
    if id == Some("resistance") && uses_2014 {
        return vec![json!("resistance-d4")];
    }
    if id == Some("resistance") {
        return vec![Value::String(format!("resistance-damage:{}", js::string(command.get("spell_option"))))];
    }
    if let Some(list) = field(spell, "conditions").and_then(Value::as_array).filter(|list| !list.is_empty()) {
        return list.clone();
    }
    if js::truthy(field(spell, "removesConditions")) || js::truthy(field(spell, "removesConditionsByOption")) {
        return Vec::new();
    }
    if field(spell, "kind").and_then(Value::as_str) == Some("buff") && !js::truthy(field(spell, "nextWeaponHit")) {
        return vec![Value::String(format!("spell-effect:{}", template(field(spell, "id"))))];
    }
    Vec::new()
}

/// Усиления и полезные заклинания (18429–18589).
pub(super) fn buff(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor_id = cast.actor_id.clone();
    let spell_id = cast.spell_id();
    let uses_2014 = sk_core::game::uses_2014(&state);
    let scoped_true_strike = uses_2014 && spell_id == "true-strike";
    let actor_value = cast.actor.clone().unwrap_or(Value::Null);
    let targets = if scoped_true_strike {
        vec![actor_value.clone()]
    } else if !cast.affected.is_empty() {
        cast.affected.clone()
    } else if field(&spell, "target").and_then(Value::as_str) == Some("self") {
        vec![actor_value.clone()]
    } else {
        Vec::new()
    };
    let conditions = buff_conditions(&spell, &command, uses_2014);
    let level = level_of(&spell);
    let extended = cast.metamagic.contains("metamagic-extended");
    let source_actor = command.get("actor_id").cloned().unwrap_or(Value::Null);
    let option_text = js::s(command.get("spell_option"));
    for target in targets {
        let target_id = actor_id_of(&target);
        let slot_level = slot_level_of(&spell, &command);
        let extra_levels = (slot_level - level).max(0);
        if is_true(field(&spell, "revivesDead")) {
            let hero = crate::core::player_actor(&state, Some(&Value::String(target_id.clone())));
            let name = nn(at(hero, "character")).or_else(|| nn(at(hero, "name"))).map(|value| js::string(Some(value))).unwrap_or_else(|| target_id.clone());
            let mut payload = Map::new();
            payload.insert("hp_after".into(), json!(1));
            payload.insert("previous_name".into(), Value::String(name));
            payload.insert("method".into(), json!("revivify"));
            put(&mut payload, "spell_id", field(&spell, "id"));
            r.push_ruled(&[rule_ids::ZERO_HP, rule_ids::HEALING], "HeroResurrected", Value::Object(payload), json!([target_id]));
            continue;
        }
        if is_true(field(&spell, "stabilizesDying")) {
            let hero = crate::core::player_actor(&state, Some(&Value::String(target_id.clone())));
            let name = nn(at(hero, "character")).or_else(|| nn(at(hero, "name"))).map(|value| js::string(Some(value))).unwrap_or_else(|| target_id.clone());
            let mut payload = Map::new();
            payload.insert("hero_name".into(), Value::String(name));
            payload.insert("method".into(), json!("spare-the-dying"));
            put(&mut payload, "spell_id", field(&spell, "id"));
            r.push_ruled(&[rule_ids::ZERO_HP], "HeroStabilized", Value::Object(payload), json!([target_id]));
            continue;
        }
        let mut offered = 0.0;
        if js::truthy(field(&spell, "temporaryHpDice")) {
            let roll = r.spell_roll(Value::String(template(field(&spell, "temporaryHpDice"))), &format!("spell_temporary_hp:{spell_id}"))?;
            r.rolls.push(roll.clone());
            r.push_die(roll.clone());
            offered = js::number(roll.get("total")) + (extra_levels * js::safe_int(field(&spell, "temporaryHpPerUpcastLevel"), 0).max(0)) as f64;
        } else if js::truthy(field(&spell, "temporaryHp")) {
            offered = (js::safe_int(field(&spell, "temporaryHp"), 0) + extra_levels * js::safe_int(field(&spell, "temporaryHpPerSlotLevel"), 0).max(0)).max(0) as f64;
        } else if js::truthy(field(&spell, "temporaryHpAbilityModifier")) && !js::is_false(field(&spell, "temporaryHpOnCast")) {
            offered = cast.spell_modifier.max(0) as f64;
        }
        if offered > 0.0 {
            let before = js::safe_int(at(sk_core::game::mechanics(&state).get("temporary_hp"), &target_id), 0).max(0) as f64;
            let mut payload = Map::new();
            put(&mut payload, "spell_id", field(&spell, "id"));
            payload.insert("offered".into(), js::num(offered));
            payload.insert("temporary_hp_before".into(), js::num(before));
            payload.insert("temporary_hp_after".into(), js::num(before.max(offered)));
            r.push_ruled(&[rule_ids::TEMPORARY_HP], "TemporaryHitPointsGranted", Value::Object(payload), json!([target_id]));
        }
        if let Some(form) = field(&spell, "polymorphForm").filter(|value| js::truthy(Some(value))) {
            let mut form = form.clone();
            if let Some(map) = form.as_object_mut() {
                if map.contains_key("size") && sk_geometry::actor_footprint::normalize_footprint_metadata(map.get("footprint")).is_none() {
                    let footprint = sk_geometry::actor_footprint::footprint_metadata_for_size(map.get("size")).to_value();
                    map.insert("footprint".into(), footprint);
                }
            }
            let mut payload = Map::new();
            put(&mut payload, "spell_id", field(&spell, "id"));
            payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
            payload.insert("shape_contract_version".into(), json!(2));
            payload.insert("form".into(), form);
            r.push_ruled(&[rule_ids::CONDITIONS], "ShapeChanged", Value::Object(payload), json!([target_id]));
        }
        let maximum_bonus = (js::safe_int(field(&spell, "hitPointMaximumBonus"), 0) + extra_levels * js::safe_int(field(&spell, "hitPointMaximumBonusPerSlotLevel"), 0).max(0)).max(0);
        if maximum_bonus > 0 {
            let maximum_before = crate::core::actor_max_hp(Some(&target));
            let hp_before = sk_core::game::actor_hp(&target);
            let mut payload = Map::new();
            put(&mut payload, "spell_id", field(&spell, "id"));
            payload.insert("requested_amount".into(), Value::from(maximum_bonus));
            payload.insert("applied_amount".into(), Value::from(maximum_bonus));
            payload.insert("maximum_hp_before".into(), Value::from(maximum_before));
            payload.insert("maximum_hp_after".into(), Value::from(maximum_before + maximum_bonus));
            payload.insert("hp_before".into(), Value::from(hp_before));
            payload.insert("hp_after".into(), Value::from(hp_before + maximum_bonus));
            r.push_ruled(&[rule_ids::HEALING], "HitPointMaximumIncreased", Value::Object(payload), json!([target_id]));
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String(format!("{}{maximum_bonus}", crate::conditions::HIT_POINT_MAXIMUM_BONUS_CONDITION_PREFIX)));
            payload.insert("duration".into(), json!("until-long-rest"));
            payload.insert("source_actor".into(), source_actor.clone());
            payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
            put(&mut payload, "spell_id", field(&spell, "id"));
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
        }
        let removable = nn(at(field(&spell, "removesConditionsByOption"), &option_text)).or_else(|| nn(field(&spell, "removesConditions"))).cloned();
        for condition in items(removable.as_ref()) {
            let name = js::string(Some(&condition));
            if name == crate::conditions::EXHAUSTION_LADDER {
                let events = crate::conditions::exhaustion_step_down_events(&state, &command, &target_id, field(&spell, "id"));
                r.events.extend(events);
                continue;
            }
            if !condition_ids_for(&state, &target_id).contains(&name) {
                continue;
            }
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String(name));
            put(&mut payload, "spell_id", field(&spell, "id"));
            payload.insert("trigger".into(), json!("restoration"));
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", Value::Object(payload), json!([target_id]));
        }
        for configured in &conditions {
            let condition = match configured.as_str() {
                Some("hunters-mark") => Value::String(format!("hunters-mark:{actor_id}")),
                Some("hexed") => Value::String(format!("hexed:{actor_id}")),
                _ => configured.clone(),
            };
            let started_minutes = js::safe_int(at(sk_core::game::mechanics(&state).get("world_time"), "elapsed_minutes"), 0).max(0);
            let duration_minutes = js::safe_int(field(&spell, "conditionDurationMinutes"), 0).max(0);
            let by_slot = nn(at(field(&spell, "conditionDurationSecondsBySlotLevel"), &slot_level.to_string())).or_else(|| field(&spell, "conditionDurationSeconds"));
            let combat_active = js::truthy(sk_core::game::combat(&state).get("active"));
            let primary = js::safe_int(by_slot, 0);
            let duration_seconds = (if primary != 0 { primary } else if !combat_active { js::safe_int(field(&spell, "conditionDurationSecondsOutsideCombat"), 0) } else { 0 }).max(0);
            let started_seconds = crate::world_clock::world_time_seconds(&state);
            let duration = if js::truthy(field(&spell, "conditionDuration")) {
                Value::String(template(field(&spell, "conditionDuration")))
            } else if js::truthy(field(&spell, "concentration")) {
                json!("concentration")
            } else if duration_seconds > 0 {
                Value::String(format!("seconds:{duration_seconds}"))
            } else if duration_minutes > 0 {
                Value::String(format!("minutes:{duration_minutes}"))
            } else if js::truthy(field(&spell, "durationRounds")) {
                Value::String(format!("rounds:{}", template(field(&spell, "durationRounds"))))
            } else {
                Value::Null
            };
            let mut payload = Map::new();
            payload.insert("condition".into(), condition.clone());
            payload.insert("duration".into(), duration);
            payload.insert("source_actor".into(), source_actor.clone());
            payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
            put(&mut payload, "spell_id", field(&spell, "id"));
            if uses_2014 && (spell_id == "hex" || (is_true(field(&spell, "storesSpellOption")) && js::truthy(command.get("spell_option")))) {
                payload.insert("spell_option".into(), Value::String(js::string(command.get("spell_option"))));
            }
            if scoped_true_strike {
                payload.insert("true_strike_version".into(), json!(1));
                payload.insert("target_actor_id".into(), Value::String(cast.affected.first().map(actor_id_of).unwrap_or_default()));
                payload.insert("true_strike_armed".into(), Value::Bool(false));
            }
            if field(&spell, "id").and_then(Value::as_str) == Some(crate::combat::weapons::SHILLELAGH_CONDITION) {
                payload.insert("source_item_id".into(), cast.shillelagh_item_id.clone().map(Value::String).unwrap_or(Value::Null));
                payload.insert("spellcasting_ability".into(), Value::String(cast.spell_ability.clone()));
                payload.insert("magical_weapon".into(), Value::Bool(true));
            }
            if duration_minutes > 0 {
                payload.insert("started_at_minutes".into(), Value::from(started_minutes));
                payload.insert("expires_at_minutes".into(), Value::from(started_minutes + duration_minutes));
            }
            if duration_seconds > 0 {
                payload.insert("started_at_seconds".into(), js::num(started_seconds));
                payload.insert("expires_at_seconds".into(), js::num(started_seconds + duration_seconds as f64));
                payload.insert("timing_version".into(), json!(2));
            }
            if spell_id == "protection-from-energy" {
                payload.insert("expiry_policy".into(), json!(crate::constants::PROTECTION_FROM_ENERGY_EXPIRY_POLICY));
            }
            if let Some(policy) = field(&spell, "conditionExpiryPolicy").filter(|value| js::truthy(Some(value))) {
                payload.insert("expiry_policy".into(), policy.clone());
            }
            for (key, value) in crate::conditions::spell_timed_condition_payload(&state, &command, &spell, extended) {
                payload.insert(key, value);
            }
            if js::truthy(field(&spell, "temporaryHpAbilityModifier")) {
                payload.insert("temporary_hp_amount".into(), Value::from(cast.spell_modifier.max(0)));
            }
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
            if condition.as_str() == Some("heroism") {
                let mut payload = Map::new();
                payload.insert("condition".into(), json!("frightened"));
                payload.insert("reason".into(), json!("fear-immunity"));
                put(&mut payload, "spell_id", field(&spell, "id"));
                r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", Value::Object(payload), json!([target_id]));
            }
        }
        if js::truthy(field(&spell, "meleeRetaliationDamage")) {
            let retaliation = (js::safe_int(field(&spell, "meleeRetaliationDamage"), 0) + extra_levels * js::safe_int(field(&spell, "meleeRetaliationDamagePerSlotLevel"), 0).max(0)).max(0);
            let duration = if js::truthy(field(&spell, "durationRounds")) { Value::String(format!("rounds:{}", template(field(&spell, "durationRounds")))) } else { Value::Null };
            let payload = json!({ "condition": format!("armor-of-agathys:{retaliation}"), "duration": duration, "source_actor": source_actor, "effect_id": cast.effect_id });
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", payload, json!([target_id]));
        }
    }
    Ok(())
}
