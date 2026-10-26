//! Заклинание: спасбросок и ослабление (`save`, `area-save`, `debuff`) и урон
//! без спасброска (`damage`, `area-damage`), в том числе по мирным NPC сцены.
//! Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 17740–18248.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;

use super::common::{actor_id_of, at, field, fold, fold_but_last, hp, hp_after_zero, is_true, items, level_of, list_includes, living, nn, payload_with, positive, put, slot_level_of, template, with_fields, Cast};
use super::super::kernel::undef;
use super::super::Resolve;
use crate::checks::saves::saving_throw_succeeded;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with, command_with_rules, condition_ids_for, event_from, spread_value};
use crate::pause::Step;
use crate::replay::apply_game_event;
use crate::tactical_geometry::npc_positioning::NpcTargetGeometry;

/// `Math.max(a, b)` по правилам JS (`NaN` — заразен).
fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

/// `spell.conditionsByOption?.[String(command.spell_option ?? '')] ?? spell.conditions ?? []`.
fn chosen_conditions(spell: &Value, command: &Value) -> Vec<Value> {
    let option = js::s(command.get("spell_option"));
    match nn(at(field(spell, "conditionsByOption"), &option)).or_else(|| nn(field(spell, "conditions"))) {
        Some(list) => items(Some(list)),
        None => Vec::new(),
    }
}

/// Длительность состояния провала: `conditionDuration`, концентрация, раунды
/// (`rounds` — текст раундов, если они есть) или до следующего хода.
fn failure_duration(spell: &Value, rounds: Option<String>) -> String {
    if js::truthy(field(spell, "conditionDuration")) {
        template(field(spell, "conditionDuration"))
    } else if js::truthy(field(spell, "concentration")) {
        "concentration".into()
    } else if let Some(rounds) = rounds {
        format!("rounds:{rounds}")
    } else {
        "until-next-turn".into()
    }
}

/// Спасбросок и ослабление (17740–18221).
pub(super) fn saving_throw_spell(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor = cast.actor.clone();
    let actor_id = cast.actor_id.clone();
    let spell_id = cast.spell_id();
    let save_ability = field(&spell, "saveAbility").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "dex".into());
    let save_ability_value = Value::String(save_ability.clone());
    let careful_limit = ability_modifier(at(at(actor.as_ref(), "abilities"), "cha")).max(1) as usize;
    let sculpt_limit = crate::spells::slots::sculpt_spells_limit(actor.as_ref(), &spell, command.get("slot_level"));
    let actor_enemy = sk_core::game::is_enemy_actor(&state, &actor_id);
    let sculpted: IndexSet<String> = if sculpt_limit != 0 {
        cast.affected
            .iter()
            .filter(|candidate| actor_id_of(candidate) != actor_id && sk_core::game::is_enemy_actor(&state, &actor_id_of(candidate)) == actor_enemy)
            .take(sculpt_limit.max(0) as usize)
            .map(actor_id_of)
            .collect()
    } else {
        IndexSet::new()
    };
    let mut careful: IndexSet<String> = if cast.metamagic.contains("metamagic-careful") {
        cast.affected.iter().filter(|candidate| actor_id_of(candidate) != actor_id && !sk_core::game::is_enemy_actor(&state, &actor_id_of(candidate))).take(careful_limit).map(actor_id_of).collect()
    } else {
        IndexSet::new()
    };
    careful.extend(sculpted.iter().cloned());
    let any_affected = !cast.affected.is_empty() || !cast.npc_affected.is_empty();
    let shared_roll = if js::truthy(cast.damage_expression.as_ref()) && any_affected && !js::truthy(field(&spell, "saveDamage")) {
        let roll = r.spell_roll(cast.damage_expression.clone().unwrap_or(Value::Null), &format!("spell_damage:{spell_id}"))?;
        r.rolls.push(roll.clone());
        r.push_die(roll.clone());
        Some(roll)
    } else {
        None
    };
    let option = js::s(command.get("spell_option"));
    let bonus_type = js::string(Some(nn(at(field(&spell, "bonusDamageTypeByOption"), &option)).or_else(|| nn(field(&spell, "bonusDamageType"))).unwrap_or(&json!("untyped"))));
    let level = level_of(&spell);
    let bonus_roll = if js::truthy(field(&spell, "bonusDamage")) && any_affected {
        let extra = Value::from((js::safe_int(command.get("slot_level"), level) - level).max(0));
        let per_level = Value::from(js::safe_int(field(&spell, "bonusDamageUpcastDicePerLevel"), 0));
        let expression = crate::spells::slots::scaled_dice_expression(&template(field(&spell, "bonusDamage")), Some(&extra), Some(&per_level), None);
        let roll = r.spell_roll(Value::String(expression), &format!("spell_damage:{spell_id}:{bonus_type}"))?;
        r.rolls.push(roll.clone());
        r.push_die(roll.clone());
        Some(roll)
    } else {
        None
    };
    let actor_targets = json!([actor_id]);
    let combat_active = sk_core::game::combat(&state).get("active").cloned();
    let affected = cast.affected.clone();
    for target in affected {
        if is_true(at(field(&spell, "createsAreaEffect"), "triggerOnTurnStart")) && nn(field(&spell, "damage")).is_none() && !js::truthy(field(&spell, "secondaryBurst")) {
            continue;
        }
        let target_id = actor_id_of(&target);
        let target_value = Value::String(target_id.clone());
        let creature_type = crate::spells::slots::creature_type_for(Some(&target));
        if is_true(field(&spell, "undeadGainsTemporaryHp")) && creature_type == "undead" {
            if let Some(shared) = shared_roll.as_ref() {
                let projected = fold(&state, &r.events)?;
                let before = js::safe_int(at(sk_core::game::mechanics(&projected).get("temporary_hp"), &target_id), 0).max(0);
                let offered = (js::number(shared.get("total")) / 2.0).floor() as i64;
                let mut payload = Map::new();
                payload.insert("offered".into(), Value::from(offered));
                payload.insert("temporary_hp_before".into(), Value::from(before));
                payload.insert("temporary_hp_after".into(), Value::from(before.max(offered)));
                put(&mut payload, "spell_id", field(&spell, "id"));
                r.push_ruled(&[rule_ids::HEALING], "TemporaryHitPointsGranted", Value::Object(payload), json!([target_id]));
                continue;
            }
        }
        let target_conditions = condition_ids_for(&state, &target_id);
        let chosen = chosen_conditions(&spell, &command);
        let immune_types = field(&spell, "immuneCreatureTypes");
        let required_types = field(&spell, "requiredCreatureTypes");
        let required_count = required_types.and_then(Value::as_array).map_or(0, Vec::len);
        let minimum_intelligence = nn(field(&spell, "minimumIntelligence"));
        let immune_by_type = list_includes(immune_types, &creature_type)
            || (required_count > 0 && !list_includes(required_types, &creature_type))
            || minimum_intelligence.is_some_and(|minimum| js::number(Some(nn(at(target.get("abilities"), "int")).unwrap_or(&json!(10)))) < js::number(Some(minimum)));
        let immune_by_language = is_true(field(&spell, "requiresLanguage")) && (!crate::spells::slots::understands_spell_language(Some(&target)) || target_conditions.contains("cannot-understand-language"));
        let deafened = target_conditions.contains("deafened");
        let automatic_save = immune_by_type
            || immune_by_language
            || (list_includes(field(&spell, "conditions"), "frightened") && target_conditions.contains("heroism"))
            || (is_true(field(&spell, "deafenedAutoSave")) && (deafened || is_true(target.get("deafened"))));
        let auto_failed = crate::conditions::auto_failed_save_condition_for(&state, &target_id, Some(&save_ability_value));
        let mut save_modifier = ability_modifier(at(target.get("abilities"), &save_ability)) as f64;
        if save_ability == "dex" && !is_true(field(&spell, "ignoresCover")) {
            let cover = crate::tactical_geometry::cover_between(&state, &actor_id, &target_id, crate::tactical_geometry::actor_point(&state, &actor_id), crate::tactical_geometry::actor_point(&state, &target_id));
            save_modifier += js::number(cover.get("armorClassBonus"));
        }
        let visibility = r.visibility();
        if crate::conditions::bless_bonus_enabled(&state, &target_id) {
            let blessing = r.roll_dice(json!("1d4"), "spell:bless:saving-throw", target_value.clone(), visibility.clone())?;
            r.rolls.push(blessing.clone());
            r.push_die(blessing.clone());
            save_modifier += js::number(blessing.get("total"));
        }
        if target_conditions.contains("bane-d4") {
            let bane = r.roll_dice(json!("1d4"), "spell:bane:saving-throw", target_value.clone(), visibility.clone())?;
            r.rolls.push(bane.clone());
            r.push_die(bane.clone());
            save_modifier -= js::number(bane.get("total"));
        }
        if auto_failed.is_none() && target_conditions.contains("next-save-minus-d4") {
            let penalty = r.roll_dice(json!("1d4"), "spell:mind-sliver", target_value.clone(), visibility)?;
            r.rolls.push(penalty.clone());
            r.push_die(penalty.clone());
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", json!({ "condition": "next-save-minus-d4" }), json!([target_id]));
            save_modifier -= js::number(penalty.get("total"));
        }
        let silvery_fortune = auto_failed.is_none() && target_conditions.contains("silvery-fortune");
        let advantage = if silvery_fortune {
            Value::Bool(true)
        } else if !is_true(field(&spell, "saveAdvantageIfHostile")) {
            Value::Bool(false)
        } else {
            undef(combat_active.as_ref())
        };
        let mut options = Map::new();
        options.insert("ability".into(), save_ability_value.clone());
        options.insert("modifier".into(), js::num(save_modifier));
        options.insert("purpose".into(), Value::String(format!("spell_save:{spell_id}:{save_ability}")));
        options.insert("resistanceEligible".into(), Value::Bool(!automatic_save && auto_failed.is_none() && !careful.contains(&target_id)));
        options.insert("advantage".into(), advantage);
        options.insert("disadvantage".into(), Value::Bool(cast.metamagic.contains("metamagic-heightened")));
        options.insert("avoid_or_end_condition".into(), if chosen.iter().any(|condition| condition.as_str() == Some("poisoned")) { json!("poisoned") } else { Value::Null });
        options.insert("visibility".into(), undef(command.get("visibility")));
        options.insert("difficulty".into(), Value::from(cast.spell_save_dc));
        let save = r.spell_save(&state, &target_id, Value::Object(options))?;
        if silvery_fortune && !automatic_save && !careful.contains(&target_id) {
            r.events.push(crate::spells::enervation::remove_silvery_fortune_event(&command, &state, &target_id, None));
        }
        let willing = is_true(field(&spell, "willingAlliesSkipSave")) && sk_core::game::is_enemy_actor(&state, &target_id) == actor_enemy;
        let no_initial_save = is_true(field(&spell, "noInitialSave")) && !automatic_save;
        let natural_save = !willing && !no_initial_save && (automatic_save || careful.contains(&target_id) || saving_throw_succeeded(Some(&save), cast.spell_save_dc as f64));
        let legendary = if natural_save || no_initial_save || willing {
            None
        } else {
            let damage = shared_roll.as_ref().map_or(0.0, |shared| js::number(shared.get("total")) + bonus_roll.as_ref().map_or(0.0, |bonus| js::number(bonus.get("total"))));
            r.legendary_resistance_for(&state, Some(&target_value), &chosen, damage)
        };
        let saved = natural_save || legendary.is_some();
        r.rolls.push(save.clone());
        let mut payload = spread_value(Some(&save));
        put(&mut payload, "spell_id", field(&spell, "id"));
        payload.insert("ability".into(), save_ability_value.clone());
        payload.insert("difficulty".into(), Value::from(cast.spell_save_dc));
        payload.insert("saved".into(), Value::Bool(saved));
        payload.insert("automatic_success".into(), Value::Bool(automatic_save));
        if willing {
            payload.insert("willing_target".into(), Value::Bool(true));
        }
        if no_initial_save {
            payload.insert("no_initial_save".into(), Value::Bool(true));
        }
        if legendary.is_some() {
            payload.insert("legendary_resistance".into(), Value::Bool(true));
        }
        let immunity = if immune_by_type {
            Value::String(creature_type.clone())
        } else if immune_by_language {
            json!("language")
        } else if is_true(field(&spell, "deafenedAutoSave")) && deafened {
            json!("deafened")
        } else {
            Value::Null
        };
        payload.insert("immunity".into(), immunity);
        r.push_ruled(&[rule_ids::SAVING_THROW], "SpellSavingThrowResolved", Value::Object(payload), json!([target_id]));
        if let Some(legendary) = legendary {
            r.events.extend(legendary.events);
        }
        if saved && is_true(field(&spell, "endsOnSave")) && js::truthy(field(&spell, "concentration")) {
            r.push_ruled(&[rule_ids::CONCENTRATION], "ConcentrationEnded", json!({ "reason": "save-success", "effect_id": cast.effect_id }), actor_targets.clone());
        }
        if !saved && positive(field(&spell, "pullFeet")) {
            let pull_state = fold(&state, &r.events)?;
            let pulled = sk_core::game::find_actor(&pull_state, &target_id).cloned();
            if living(pulled.as_ref()) && crate::geometry::forced::forced_movement_size_allowed(&spell, pulled.as_ref()) {
                let pulled_from = crate::tactical_geometry::actor_point(&pull_state, &target_id);
                let path = crate::geometry::forced::forced_pull_path(&pull_state, &target_id, crate::tactical_geometry::actor_point(&pull_state, &actor_id), js::number(field(&spell, "pullFeet")));
                if !path.is_empty() {
                    let remaining = crate::speed::effective_speed_feet(&pull_state, pulled.as_ref().unwrap_or(&Value::Null), &target_id);
                    let mut extra = Map::new();
                    extra.insert("pulled".into(), Value::Bool(true));
                    put(&mut extra, "spell_id", field(&spell, "id"));
                    extra.insert("phase".into(), json!("combat"));
                    r.forced_spell_move(&target_id, pulled_from, &path, path.len() as i64 * 5, remaining, Value::Object(extra))?;
                }
            }
        }
        let out_of_reach = positive(field(&spell, "damageOnlyWithinFeet")) && {
            let projected = fold(&state, &r.events)?;
            crate::targets::distance_between_actors(&projected, &actor_id, &target_id).is_some_and(|distance| distance > js::safe_int(field(&spell, "damageOnlyWithinFeet"), 5) as f64)
        };
        let outcome_roll = if js::truthy(field(&spell, "saveDamage")) {
            let expression = if saved {
                let outcome_spell = with_fields(&spell, &[("damage", field(&spell, "saveDamage").cloned()), ("upcastDicePerLevel", field(&spell, "saveDamageUpcastDicePerLevel").cloned())]);
                crate::spells::slots::scaled_spell_dice(Some(&outcome_spell), actor.as_ref(), command.get("slot_level"))
            } else {
                cast.damage_expression.clone()
            };
            let purpose = if saved { format!("spell_save_damage:{spell_id}") } else { format!("spell_damage:{spell_id}") };
            let roll = r.spell_roll(Value::String(js::string(Some(expression.as_ref().unwrap_or(&Value::Null)))), &purpose)?;
            r.rolls.push(roll.clone());
            let mut die = spread_value(Some(&roll));
            put(&mut die, "spell_id", field(&spell, "id"));
            die.insert("saved".into(), Value::Bool(saved));
            r.push_die(Value::Object(die));
            Some(roll)
        } else {
            None
        };
        let half_on_save = js::truthy(field(&spell, "halfOnSave"));
        let damage = if immune_by_type || out_of_reach || sculpted.contains(&target_id) {
            0
        } else if js::truthy(field(&spell, "saveDamage")) {
            js::safe_int(outcome_roll.as_ref().and_then(|roll| nn(roll.get("total"))), 0)
        } else if let Some(shared) = shared_roll.as_ref() {
            crate::checks::saves::saved_damage_amount(&state, &target_id, Some(&save_ability_value), saved, half_on_save, shared.get("total"))
        } else {
            0
        };
        let bonus_damage = if immune_by_type || sculpted.contains(&target_id) {
            0
        } else if let Some(bonus) = bonus_roll.as_ref() {
            crate::checks::saves::saved_damage_amount(&state, &target_id, Some(&save_ability_value), saved, half_on_save, bonus.get("total"))
        } else {
            0
        };
        let reaction_key = if js::truthy(field(&spell, "bonusDamage")) {
            format!("{}:{target_id}:spell-area:{spell_id}", template(command.get("command_id")))
        } else {
            format!("{}:{target_id}:{}", template(command.get("command_id")), js::string(Some(&cast.damage_type)))
        };
        let reaction_key_value = Value::String(reaction_key);
        let mut damage_payloads: Vec<Value> = Vec::new();
        let save_fields = |payload: &Value| {
            let mut extra = Map::new();
            put(&mut extra, "spell_id", field(&spell, "id"));
            put(&mut extra, "save_total", save.get("total"));
            extra.insert("save_dc".into(), Value::from(cast.spell_save_dc));
            extra.insert("saved".into(), Value::Bool(saved));
            payload_with(payload, Value::Object(extra))
        };
        if damage > 0 {
            let resolved = r.resolve_damage_payload(&state, &target_id, Value::from(damage), &cast.damage_type.clone(), None, None)?;
            let floored = crate::damage::damage_payload_with_hp_floor(&resolved, field(&spell, "damageMinimumHp"));
            let payload = r.prepare_elemental_reaction_damage(&state, &target_id, floored, Some(&reaction_key_value), None)?;
            damage_payloads.push(payload.clone());
            r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", save_fields(&payload), json!([target_id]));
            if hp_after_zero(&payload) && bonus_damage <= 0 {
                let before = fold_but_last(&state, &r.events)?;
                r.push_zero_hp(&before, &target_id, &payload, false);
            }
        }
        if bonus_damage > 0 {
            let projected = fold(&state, &r.events)?;
            let resolved = r.resolve_damage_payload(&projected, &target_id, Value::from(bonus_damage), &Value::String(bonus_type.clone()), None, None)?;
            let payload = r.prepare_elemental_reaction_damage(&projected, &target_id, resolved, Some(&reaction_key_value), None)?;
            damage_payloads.push(payload.clone());
            r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", save_fields(&payload), json!([target_id]));
            if hp_after_zero(&payload) {
                let before = fold_but_last(&state, &r.events)?;
                r.push_zero_hp(&before, &target_id, &payload, false);
            }
        }
        if is_true(field(&spell, "healsHalfDamageToCaster")) && !damage_payloads.is_empty() {
            let life_steal: i64 = damage_payloads.iter().map(|payload| js::safe_int(payload.get("applied_amount"), 0).max(0) + js::safe_int(payload.get("temporary_hp_absorbed"), 0).max(0)).sum();
            if life_steal > 0 {
                let healed_state = fold(&state, &r.events)?;
                let caster = sk_core::game::find_actor(&healed_state, &actor_id);
                let before = hp(caster);
                let requested = life_steal.div_euclid(2);
                let after = if condition_ids_for(&healed_state, &actor_id).contains("healing-blocked") { before } else { crate::core::actor_max_hp(caster).min(before + requested) };
                if after > before {
                    let mut payload = Map::new();
                    put(&mut payload, "spell_id", field(&spell, "id"));
                    payload.insert("requested_amount".into(), Value::from(requested));
                    payload.insert("applied_amount".into(), Value::from(after - before));
                    payload.insert("damage_for_life_steal".into(), Value::from(life_steal));
                    payload.insert("hp_before".into(), Value::from(before));
                    payload.insert("hp_after".into(), Value::from(after));
                    payload.insert("life_steal".into(), Value::Bool(true));
                    r.push_ruled(&[rule_ids::HEALING], "HealingApplied", Value::Object(payload), actor_targets.clone());
                }
            }
        }
        if !saved {
            for condition in items(field(&spell, "removesConditions")) {
                let name = js::string(Some(&condition));
                if target_conditions.contains(&name) {
                    let mut payload = Map::new();
                    payload.insert("condition".into(), Value::String(name));
                    put(&mut payload, "spell_id", field(&spell, "id"));
                    r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", Value::Object(payload), json!([target_id]));
                }
            }
            for condition in &chosen {
                apply_failed_condition(r, cast, &state, &target_id, condition, &save_ability)?;
            }
        }
        if !saved && field(&spell, "id").and_then(Value::as_str) == Some("command") {
            let option = js::string(command.get("spell_option"));
            let payload = json!({ "condition": format!("command:{option}"), "duration": "command-next-turn", "source_actor": command.get("actor_id").cloned().unwrap_or(Value::Null), "effect_id": cast.effect_id, "spell_option": option });
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", payload, json!([target_id]));
        }
        if !saved && positive(field(&spell, "pushFeet")) && crate::geometry::forced::forced_movement_size_allowed(&spell, Some(&target)) {
            let origin = crate::tactical_geometry::actor_point(&state, &actor_id);
            let pushed_from = crate::tactical_geometry::actor_point(&state, &target_id);
            let path = crate::geometry::forced::forced_push_path(&state, &target_id, origin, js::number(field(&spell, "pushFeet")));
            if !path.is_empty() {
                let remaining = crate::speed::effective_speed_feet(&state, &target, &target_id);
                let mut extra = Map::new();
                put(&mut extra, "spell_id", field(&spell, "id"));
                extra.insert("phase".into(), json!("combat"));
                r.forced_spell_move(&target_id, pushed_from, &path, path.len() as i64 * 5, remaining, Value::Object(extra))?;
            }
        }
        if !saved && positive(field(&spell, "randomMoveFeet")) {
            let movement_state = fold(&state, &r.events)?;
            let mover = sk_core::game::find_actor(&movement_state, &target_id).cloned();
            if living(mover.as_ref()) && crate::speed::effective_speed_feet(&movement_state, mover.as_ref().unwrap_or(&Value::Null), &target_id) >= 5 {
                let direction = r.spell_roll(json!("1d4"), &format!("spell_random_move:{spell_id}"))?;
                r.rolls.push(direction.clone());
                let mut die = spread_value(Some(&direction));
                put(&mut die, "spell_id", field(&spell, "id"));
                r.push_die(Value::Object(die));
                let moved_from = crate::tactical_geometry::actor_point(&movement_state, &target_id);
                let path = crate::geometry::forced::forced_random_step_path(&movement_state, &target_id, direction.get("total"));
                if !path.is_empty() {
                    let remaining = crate::speed::effective_speed_feet(&movement_state, mover.as_ref().unwrap_or(&Value::Null), &target_id);
                    let mut extra = Map::new();
                    put(&mut extra, "spell_id", field(&spell, "id"));
                    extra.insert("phase".into(), json!("combat"));
                    r.forced_spell_move(&target_id, moved_from, &path, 5, remaining, Value::Object(extra))?;
                }
            }
        }
        if !saved && is_true(field(&spell, "reactionMoveAway")) {
            reaction_move_away(r, cast, &state, &target, &target_id)?;
        }
    }
    npc_saving_throws(r, cast, shared_roll.as_ref(), bonus_roll.as_ref(), &bonus_type, &save_ability)
}

/// Состояние провалившему спасбросок (17954–18053).
fn apply_failed_condition(r: &mut Resolve<'_>, cast: &Cast, state: &Value, target_id: &str, condition: &Value, save_ability: &str) -> Step {
    let spell = &cast.spell;
    let command = &cast.command;
    let condition_text = js::string(Some(condition));
    if crate::conditions::freedom_blocks_spell_condition(state, target_id, &condition_text) {
        return Ok(());
    }
    let source_actor = command.get("actor_id").cloned().unwrap_or(Value::Null);
    if condition.as_str() == Some("exhaustion") {
        let current = crate::conditions::exhaustion_level_of(state, target_id);
        if current >= 6 {
            return Ok(());
        }
        if current > 0 {
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String(format!("exhaustion:{current}")));
            put(&mut payload, "spell_id", field(spell, "id"));
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", Value::Object(payload), json!([target_id]));
        }
        let mut payload = Map::new();
        payload.insert("condition".into(), Value::String(format!("exhaustion:{}", current + 1)));
        payload.insert("exhaustion_level".into(), Value::from(current + 1));
        payload.insert("duration".into(), json!("until-removed"));
        payload.insert("source_actor".into(), source_actor);
        payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
        put(&mut payload, "spell_id", field(spell, "id"));
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
        return Ok(());
    }
    let extended = cast.metamagic.contains("metamagic-extended");
    let rounds_base = js::number(Some(nn(field(spell, "durationRounds")).unwrap_or(&json!(0))));
    let rounds = if extended { rounds_base * 2.0 } else { rounds_base };
    let level = level_of(spell);
    let recurring_slot = slot_level_of(spell, command);
    let recurring_expression = js::truthy(field(spell, "recurringDamage")).then(|| {
        crate::spells::slots::scaled_dice_expression(&template(field(spell, "recurringDamage")), Some(&Value::from((recurring_slot - level).max(0))), Some(&Value::from(js::safe_int(field(spell, "upcastDicePerLevel"), 0))), None)
    });
    let spell_id = field(spell, "id").and_then(Value::as_str).unwrap_or("");
    let stored = if spell_id == "vitriolic-sphere" && condition.as_str() == Some("acid-covered") { json!("vitriolic-acid-covered") } else { condition.clone() };
    let enervated = spell_id == "enervation" && condition.as_str() == Some("enervated");
    let first_condition = field(spell, "conditions").and_then(Value::as_array).and_then(|list| list.first());
    let is_first = first_condition == Some(condition);
    let dc = Value::from(cast.spell_save_dc);
    let mut payload = Map::new();
    payload.insert("condition".into(), stored);
    let rounds_text = (rounds != 0.0 && !rounds.is_nan()).then(|| js::f64_string(rounds));
    payload.insert("duration".into(), Value::String(failure_duration(spell, rounds_text)));
    payload.insert("source_actor".into(), source_actor);
    payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
    let continuation_seconds = js::safe_int(field(spell, "continuationDurationSeconds"), 60).max(1);
    if enervated {
        let started = crate::world_clock::world_time_seconds(state);
        payload.insert("timing_version".into(), json!(2));
        payload.insert("started_at_seconds".into(), js::num(started));
        payload.insert("expires_at_seconds".into(), js::num(started + continuation_seconds as f64));
    }
    for (key, value) in crate::conditions::spell_timed_condition_payload(state, command, spell, extended) {
        payload.insert(key, value);
    }
    if enervated {
        let continuation = field(spell, "continuation");
        payload.insert("continuation_version".into(), Value::from(js::safe_int(field(spell, "continuationVersion"), 1).max(1)));
        payload.insert("continuation_damage".into(), Value::String(js::string(Some(nn(at(continuation, "damage")).or_else(|| nn(field(spell, "damage"))).unwrap_or(&json!(""))))));
        payload.insert("continuation_damage_type".into(), Value::String(js::string(Some(nn(at(continuation, "damageType")).or_else(|| nn(field(spell, "damageType"))).unwrap_or(&json!("necrotic"))))));
        let range = crate::core::safe_integer_or(at(continuation, "range"), field(spell, "range"));
        payload.insert("continuation_range".into(), js::num(js_max(0.0, js::number(Some(&range)))));
        payload.insert("continuation_upcast_dice_per_level".into(), Value::from(js::safe_int(field(spell, "upcastDicePerLevel"), 0).max(0)));
        payload.insert("continuation_duration_seconds".into(), Value::from(continuation_seconds));
        payload.insert("slot_level".into(), Value::from(slot_level_of(spell, command)));
    }
    if js::truthy(field(spell, "actionRepeatSave")) && is_first {
        payload.insert("action_save_ability".into(), Value::String(template(field(spell, "actionRepeatSave"))));
        payload.insert("save_dc".into(), dc.clone());
        put(&mut payload, "spell_id", field(spell, "id"));
    }
    if condition.as_str() == Some("restrained") {
        if is_true(field(spell, "noEscapeCheck")) {
            payload.insert("no_escape".into(), Value::Bool(true));
        } else {
            payload.insert("escape_dc".into(), dc.clone());
        }
    }
    if is_true(field(spell, "repeatSaveAtTurnEnd")) && is_first {
        payload.insert("repeat_save_timing".into(), json!("turn-end"));
        payload.insert("save_ability".into(), Value::String(save_ability.into()));
        payload.insert("save_dc".into(), dc.clone());
        put(&mut payload, "spell_id", field(spell, "id"));
        let tally = js::safe_int(field(spell, "repeatSaveTally"), 0);
        if tally > 0 {
            payload.insert("repeat_save_tally".into(), Value::from(tally));
            payload.insert("tally_successes".into(), json!(0));
            payload.insert("tally_failures".into(), json!(0));
            if js::truthy(field(spell, "tallyFailureCondition")) {
                payload.insert("tally_failure_condition".into(), Value::String(template(field(spell, "tallyFailureCondition"))));
            }
        }
        if !is_true(field(spell, "repeatSaveEndsConcentration")) {
            payload.insert("repeat_save_ends_concentration".into(), Value::Bool(false));
        }
    }
    if is_true(field(spell, "repeatSaveOnDamage")) && is_first {
        payload.insert("repeat_save_on_damage".into(), Value::Bool(true));
        payload.insert("damage_save_advantage".into(), Value::Bool(is_true(field(spell, "damageRepeatSaveAdvantage"))));
        payload.insert("save_ability".into(), Value::String(save_ability.into()));
        payload.insert("save_dc".into(), dc.clone());
        put(&mut payload, "spell_id", field(spell, "id"));
    }
    if is_true(field(spell, "breakOnDamageFromSourceAllies")) {
        payload.insert("break_on_damage_from_source_allies".into(), Value::Bool(true));
    }
    if is_true(field(spell, "breakOnAnyDamage")) {
        payload.insert("break_on_any_damage".into(), Value::Bool(true));
    }
    if js::truthy(field(spell, "delayedDamage")) && is_first {
        payload.insert("recurring_damage".into(), Value::String(crate::spells::slots::delayed_spell_damage_expression(spell, command.get("slot_level"))));
        let damage_type = js::string(Some(nn(field(spell, "delayedDamageType")).or_else(|| nn(field(spell, "damageType"))).unwrap_or(&json!("untyped"))));
        payload.insert("recurring_damage_type".into(), Value::String(damage_type));
        payload.insert("recurring_once".into(), Value::Bool(true));
        payload.insert("recurring_damage_timing".into(), json!("turn-end"));
        if crate::combat::turn::is_active_turn_actor(state, target_id) {
            if let Some(turn_key) = crate::areas::consequences::area_trigger_turn_key(state) {
                payload.insert("recurring_skip_turn_key".into(), Value::String(turn_key));
            }
        }
        put(&mut payload, "spell_id", field(spell, "id"));
    }
    if js::truthy(field(spell, "recurringDamage")) && is_first {
        payload.insert("recurring_damage".into(), recurring_expression.map(Value::String).unwrap_or(Value::Null));
        let damage_type = js::string(Some(nn(field(spell, "recurringDamageType")).or_else(|| nn(field(spell, "damageType"))).unwrap_or(&json!("untyped"))));
        payload.insert("recurring_damage_type".into(), Value::String(damage_type));
        put(&mut payload, "spell_id", field(spell, "id"));
        if spell_id == "tasha-s-caustic-brew" {
            payload.insert("slot_level".into(), Value::from(recurring_slot));
        }
        if js::truthy(field(spell, "recurringDamageTiming")) {
            payload.insert("recurring_damage_timing".into(), Value::String(template(field(spell, "recurringDamageTiming"))));
        }
        if js::truthy(field(spell, "startTurnSave")) {
            payload.insert("start_turn_save".into(), Value::String(template(field(spell, "startTurnSave"))));
            payload.insert("save_dc".into(), dc);
        }
    }
    r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
    Ok(())
}

/// «Диссонирующий шёпот»: цель тратит реакцию и уходит от заклинателя
/// (18103–18135).
fn reaction_move_away(r: &mut Resolve<'_>, cast: &Cast, state: &Value, target: &Value, target_id: &str) -> Step {
    let command = &cast.command;
    let actor_id = cast.actor_id.as_str();
    let mut movement_state = fold(state, &r.events)?;
    let ready = !js::is_false(at(at(sk_core::game::combat(&movement_state).get("action_economy"), target_id), "reaction"))
        && !condition_ids_for(&movement_state, target_id).contains("no-reactions")
        && living(sk_core::game::find_actor(&movement_state, target_id));
    let origin = crate::tactical_geometry::actor_point(&movement_state, actor_id);
    let destination = if ready {
        let speed = crate::speed::effective_speed_feet(&movement_state, target, target_id) as f64;
        crate::geometry::forced::farthest_safe_destination_away_from(&movement_state, target_id, origin, speed)
    } else {
        None
    };
    let Some(destination) = destination.filter(|destination| !destination.path.is_empty()) else { return Ok(()) };
    let reactor = command_with(command, "actor_id", Value::String(target_id.into()));
    let mut payload = Map::new();
    payload.insert("action_id".into(), json!("dissonant-whispers-movement"));
    put(&mut payload, "name", cast.spell("name"));
    payload.insert("action_type".into(), json!("reaction"));
    payload.insert("target_id".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
    let reaction_event = event_from(&command_with_rules(&reactor, &[rule_ids::REACTION]), "CombatActionUsed", Some(Value::Object(payload)), Some(&json!([actor_id])));
    r.events.push(reaction_event.clone());
    movement_state = apply_game_event(&movement_state, &reaction_event)?;
    let mut move_command = spread_value(Some(command));
    move_command.insert("command_id".into(), Value::String(format!("{}:reaction-move:{target_id}", template(command.get("command_id")))));
    match movement_state.get("state_version") {
        Some(version) => {
            move_command.insert("expected_state_version".into(), version.clone());
        }
        None => {
            move_command.shift_remove("expected_state_version");
        }
    }
    move_command.insert("command_type".into(), json!("MoveActor"));
    move_command.insert("actor_id".into(), Value::String(target_id.into()));
    move_command.insert("target_id".into(), json!(""));
    move_command.insert("target_ids".into(), json!([]));
    move_command.insert("to".into(), crate::tactical_geometry::point_json(destination.position));
    move_command.insert("reaction_movement".into(), Value::Bool(true));
    move_command.insert("server_authoritative".into(), Value::Bool(true));
    let move_command = command_with_rules(&Value::Object(move_command), &[rule_ids::REACTION]);
    let context = r.context.with("isAdmin", Value::Bool(true)).with("serverAuthoritativeCombat", Value::Bool(true)).with("spellMovement", Value::Bool(true));
    let movement = crate::resolve::api::resolve_command(&move_command, &movement_state, &mut r.dice, &context, &mut *r.uuid)?;
    r.events.extend(movement.events);
    r.rolls.extend(movement.rolls);
    Ok(())
}

/// Спасброски и урон мирных NPC сцены от заклинания со спасброском (18137–18221).
fn npc_saving_throws(r: &mut Resolve<'_>, cast: &Cast, shared_roll: Option<&Value>, bonus_roll: Option<&Value>, bonus_type: &str, save_ability: &str) -> Step {
    let spell = &cast.spell;
    let command = &cast.command;
    let spell_id = cast.spell_id();
    let mut npc_state = r.project_events()?;
    let save_ability_value = Value::String(save_ability.into());
    let half_on_save = js::truthy(field(spell, "halfOnSave"));
    for target in cast.npc_affected.clone() {
        if shared_roll.is_none() && bonus_roll.is_none() {
            continue;
        }
        let npc_id = target.id();
        let npc_context = crate::combat::monsters::npc_damage_context(&npc_state, &npc_id).into_owned();
        let mut options = Map::new();
        options.insert("ability".into(), save_ability_value.clone());
        options.insert("modifier".into(), Value::from(ability_modifier(at(at(sk_core::game::find_actor(&npc_context, &npc_id), "abilities"), save_ability))));
        options.insert("purpose".into(), Value::String(format!("npc_spell_save:{spell_id}:{save_ability}")));
        options.insert("actorId".into(), Value::String(npc_id.clone()));
        options.insert("disadvantage".into(), Value::Bool(cast.metamagic.contains("metamagic-heightened")));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.spell_save(&npc_context, &npc_id, Value::Object(options))?;
        let saved = saving_throw_succeeded(Some(&save), cast.spell_save_dc as f64);
        r.rolls.push(save.clone());
        let mut payload = spread_value(Some(&save));
        payload.insert("npc_id".into(), Value::String(npc_id.clone()));
        put(&mut payload, "spell_id", field(spell, "id"));
        payload.insert("ability".into(), save_ability_value.clone());
        payload.insert("difficulty".into(), Value::from(cast.spell_save_dc));
        payload.insert("saved".into(), Value::Bool(saved));
        payload.insert("source_event_id".into(), Value::String(cast.spell_cast_event_id.clone()));
        payload.insert("policy_id".into(), json!(sk_npc_world::npc_positioning::NPC_WORLD_POLICY_ID));
        r.push_ruled(&[rule_ids::SAVING_THROW], "NpcSavingThrowResolved", Value::Object(payload), json!([npc_id]));
        let chosen = chosen_conditions(spell, command);
        if !saved && chosen.iter().any(|condition| condition.as_str() == Some("prone")) && !crate::damage::stat_block_condition_immunities(&npc_context, &npc_id).contains("prone") {
            let rounds = js::truthy(field(spell, "durationRounds")).then(|| template(field(spell, "durationRounds")));
            let duration = failure_duration(spell, rounds);
            let mut payload = Map::new();
            payload.insert("condition".into(), json!("prone"));
            payload.insert("duration".into(), Value::String(duration));
            payload.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
            payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
            put(&mut payload, "spell_id", field(spell, "id"));
            let prone = event_from(&command_with_rules(command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(payload)), Some(&json!([npc_id])));
            r.events.push(prone.clone());
            npc_state = apply_game_event(&npc_state, &prone)?;
        }
        let base_amount = shared_roll.map_or(0, |roll| crate::checks::saves::saved_damage_amount(&npc_context, &npc_id, Some(&save_ability_value), saved, half_on_save, roll.get("total")));
        let bonus_amount = bonus_roll.map_or(0, |roll| crate::checks::saves::saved_damage_amount(&npc_context, &npc_id, Some(&save_ability_value), saved, half_on_save, roll.get("total")));
        let mut parts: Vec<(Value, i64)> = Vec::new();
        if shared_roll.is_some() {
            parts.push((cast.damage_type.clone(), base_amount));
        }
        if bonus_roll.is_some() {
            parts.push((Value::String(bonus_type.into()), bonus_amount));
        }
        let temporary_before = js::safe_int(at(at(npc_context.get("mechanics"), "temporary_hp"), &npc_id), 0).max(0);
        let mut damage_state = npc_context.clone();
        let mut components = Vec::new();
        for (damage_type, raw) in parts {
            let payload = r.resolve_damage_payload(&damage_state, &npc_id, Value::from(raw), &damage_type, None, None)?;
            let mut component = Map::new();
            component.insert("damage_type".into(), damage_type.clone());
            component.insert("raw_amount".into(), Value::from(raw));
            put(&mut component, "applied_amount", payload.get("applied_amount"));
            put(&mut component, "temporary_hp_absorbed", payload.get("temporary_hp_absorbed"));
            components.push(Value::Object(component));
            if let Some(after) = nn(payload.get("temporary_hp_after")) {
                let mechanics = js::object_mut(&mut damage_state, "mechanics");
                let temporary = mechanics.entry("temporary_hp").or_insert_with(js::obj);
                if !temporary.is_object() {
                    *temporary = js::obj();
                }
                if let Some(map) = temporary.as_object_mut() {
                    map.insert(npc_id.clone(), after.clone());
                }
            }
        }
        let temporary_after = js::safe_int(at(at(damage_state.get("mechanics"), "temporary_hp"), &npc_id), temporary_before).max(0);
        let amount: f64 = components.iter().map(|component| js::number(component.get("applied_amount"))).sum();
        let options = sk_npc_world::npc_positioning::NpcHarmOptions {
            npc_id: Some(Value::String(npc_id.clone())),
            amount: Some(js::num(amount)),
            damage_type: Some(if bonus_roll.is_some() { json!("mixed") } else { cast.damage_type.clone() }),
            damage_components: Some(Value::Array(components)),
            temporary_hp_before: Some(Value::from(temporary_before)),
            temporary_hp_after: Some(Value::from(temporary_after)),
            temporary_hp_absorbed: Some(Value::from((temporary_before - temporary_after).max(0))),
            source_event_id: Some(Value::String(cast.spell_cast_event_id.clone())),
            source_actor_id: command.get("actor_id").cloned(),
            trigger: Some(json!("area-spell")),
            command_id: Some(Value::String(format!("{}:{npc_id}", template(command.get("command_id"))))),
        };
        let drafts = sk_npc_world::npc_positioning::npc_harm_event_drafts(&npc_state, &options);
        let harm = crate::core::npc_world_events_from(&command_with_rules(command, &[rule_ids::DAMAGE]), &Value::Array(drafts));
        for event in &harm {
            npc_state = apply_game_event(&npc_state, event)?;
        }
        r.events.extend(harm);
    }
    Ok(())
}

/// Урон без спасброска (18222–18248).
pub(super) fn damage_spell(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let spell_id = cast.spell_id();
    if !js::truthy(cast.damage_expression.as_ref()) || (cast.affected.is_empty() && cast.npc_affected.is_empty()) {
        return Ok(());
    }
    let roll = r.spell_roll(cast.damage_expression.clone().unwrap_or(Value::Null), &format!("spell_damage:{spell_id}"))?;
    r.rolls.push(roll.clone());
    r.push_die(roll.clone());
    for target in cast.affected.clone() {
        let target_id = actor_id_of(&target);
        let payload = r.resolve_damage_payload(&state, &target_id, roll.get("total").cloned().unwrap_or(Value::Null), &cast.damage_type.clone(), None, None)?;
        let mut extra = Map::new();
        put(&mut extra, "spell_id", field(&spell, "id"));
        r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", payload_with(&payload, Value::Object(extra)), json!([target_id]));
        if hp_after_zero(&payload) {
            let before = fold_but_last(&state, &r.events)?;
            r.push_zero_hp(&before, &target_id, &payload, false);
        }
    }
    let mut npc_state = r.project_events()?;
    for target in cast.npc_affected.clone() {
        let npc_id = target.id();
        let context = crate::combat::monsters::npc_damage_context(&npc_state, &npc_id).into_owned();
        let payload = r.resolve_damage_payload(&context, &npc_id, roll.get("total").cloned().unwrap_or(Value::Null), &cast.damage_type.clone(), None, None)?;
        let options = sk_npc_world::npc_positioning::NpcHarmOptions {
            npc_id: Some(Value::String(npc_id.clone())),
            amount: payload.get("applied_amount").cloned(),
            damage_type: Some(cast.damage_type.clone()),
            source_event_id: Some(Value::String(cast.spell_cast_event_id.clone())),
            source_actor_id: command.get("actor_id").cloned(),
            trigger: Some(json!("area-spell")),
            command_id: Some(Value::String(format!("{}:{npc_id}", template(command.get("command_id"))))),
            ..Default::default()
        };
        let drafts = sk_npc_world::npc_positioning::npc_harm_event_drafts(&npc_state, &options);
        let harm = crate::core::npc_world_events_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), &Value::Array(drafts));
        for event in &harm {
            npc_state = apply_game_event(&npc_state, event)?;
        }
        r.events.extend(harm);
    }
    Ok(())
}
