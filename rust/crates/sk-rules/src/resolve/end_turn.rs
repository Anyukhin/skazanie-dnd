//! Ветки `resolveCommandInternal`: Конец хода `EndTurn`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 20005–20347. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Конец хода: области под уходящим, повторные спасброски «в конце хода» (со
//! счётом «Окаменения»), отложенный урон, «Приказ», дуэль, групповая фаза
//! инициативы. Затем — начало хода следующего: истёкшая «Готовность», «Аура
//! жизни», спасбросок от смерти, области, ужас проклятого рыцаря, урон и
//! спасбросок «в начале хода», «Героизм», перезарядка и легендарные действия.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::kernel::undef;
use super::resume::at;
use super::Resolve;
use crate::checks::saves::{active_aura_of_life_source, fear_source_in_sight, saving_throw_succeeded};
use crate::command::rules::rule_ids;
use crate::conditions::auto_failed_save_condition_for;
use crate::constants::ACTION_ECONOMY_EVENT_VERSION;
use crate::core::{ability_modifier, coalesce, command_with, command_with_rules, event_from, spread_value};
use crate::death::zero_hit_point_damage_consequences;
use crate::pause::{rule, Fault, Halt, Step};
use crate::replay::apply_game_event;
use crate::resolve::round_time::COMBAT_ROUND_TIME_POLICY;
use crate::resolve::world_time::TimeAdvanceOptions;
use crate::spells::enervation::{remove_silvery_fortune_event, silvery_fortune_for};
use crate::targets::{distance_between_actors, is_dead_hero, knight_distance_feet};

fn living(actor: Option<&Value>) -> bool {
    actor.is_some_and(sk_core::game::is_living_actor)
}

fn hp(actor: Option<&Value>) -> i64 {
    actor.map(sk_core::game::actor_hp).unwrap_or(0)
}

/// `abilityModifier(actor?.abilities?.[ability])`.
fn ability_of(actor: Option<&Value>, ability: &str) -> i64 {
    ability_modifier(at(at(actor, "abilities"), ability))
}

/// `{ ...base, key: value, … }` без полей `undefined` (`None`).
fn spread_defined(base: &Value, fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = spread_value(Some(base));
    for (key, value) in fields {
        if let Some(value) = value {
            map.insert(key.into(), value);
        }
    }
    Value::Object(map)
}

/// `{ key: value, … }` без полей `undefined` (`None`).
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    spread_defined(&Value::Object(Map::new()), fields)
}

/// `{ ...(condition.effect_id ? { effect_id } : {}) }`.
fn effect_field(condition: &Value) -> Option<Value> {
    condition.get("effect_id").filter(|value| js::truthy(Some(value))).cloned()
}

/// Состояния участника; `null` в списке — `TypeError` у JS-фильтра.
fn conditions_list(state: &Value, id: &str) -> Result<Vec<Value>, Halt> {
    let list = sk_core::game::conditions(state, id).to_vec();
    if list.iter().any(Value::is_null) {
        return Err(Fault::type_error("Cannot read properties of null (reading 'repeat_save_timing')").into());
    }
    Ok(list)
}

/// `String(condition?.id ?? condition)`.
fn condition_name(condition: &Value) -> String {
    match condition.get("id").filter(|value| !value.is_null()) {
        Some(id) => js::string(Some(id)),
        None => js::string(Some(condition)),
    }
}

/// `state.mechanics.concentration[id]`.
fn concentration_of<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    sk_core::game::mechanics(state).get("concentration").and_then(|all| all.get(id))
}

/// Ход раздела: применить событие к рабочему состоянию.
fn push_applied(r: &mut Resolve<'_>, working: &mut Value, event: Value) -> Step {
    *working = apply_game_event(working, &event)?;
    r.events.push(event);
    Ok(())
}

/// Опции спасброска в начале и конце хода.
#[allow(clippy::too_many_arguments)]
fn save_options(ability: &str, modifier: i64, purpose: String, advantage: Option<bool>, resistance_eligible: Option<bool>, poisoned: Option<bool>, frightened: bool, visibility: Value) -> Value {
    let mut options = Map::new();
    options.insert("ability".into(), Value::String(ability.into()));
    options.insert("modifier".into(), Value::from(modifier));
    options.insert("purpose".into(), Value::String(purpose));
    if let Some(advantage) = advantage {
        options.insert("advantage".into(), Value::Bool(advantage));
    }
    if let Some(eligible) = resistance_eligible {
        options.insert("resistanceEligible".into(), Value::Bool(eligible));
    }
    if frightened {
        options.insert("avoid_or_end_condition".into(), Value::String("frightened".into()));
    } else if let Some(poisoned) = poisoned {
        options.insert("avoid_or_end_condition".into(), if poisoned { Value::String("poisoned".into()) } else { Value::Null });
    }
    options.insert("visibility".into(), visibility);
    Value::Object(options)
}

/// `EndTurn` (20005–20347).
pub fn end_turn(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let combat = sk_core::game::combat(&state).clone();
    let initiative: Vec<Value> = combat.get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
    if !js::truthy(combat.get("active")) || initiative.is_empty() {
        return Err(rule("Бой не начат", "COMBAT_NOT_ACTIVE"));
    }
    let actor_id = js::s(command.get("actor_id"));
    let actor_value = command.get("actor_id").cloned().unwrap_or(Value::Null);
    let actor_targets = json!([actor_value]);
    let visibility = undef(command.get("visibility"));
    let roll_visibility = r.visibility();
    let automatic_skip = js::is_true(command.get("server_authoritative")) && r.context.server_authoritative_combat() && js::s(command.get("auto_skip_reason")) == "turn-timeout";
    let mut turn_end = Map::new();
    if let Some(round) = combat.get("round") {
        turn_end.insert("round".into(), round.clone());
    }
    if automatic_skip {
        turn_end.insert("auto_skipped".into(), Value::Bool(true));
        turn_end.insert("auto_skip_reason".into(), Value::String("turn-timeout".into()));
    }
    let ending_actor = sk_core::game::find_actor(&state, &actor_id).cloned();
    let area_end = r.area_turn_consequences(&state, command.get("actor_id"), Some("turn-end"))?;
    r.events.extend(area_end);
    let uses_2014 = sk_core::game::uses_2014(&state);
    let mut silvery_consumed = false;
    let mut repeat_state = state.clone();
    let repeating: Vec<Value> = conditions_list(&state, &actor_id)?.into_iter().filter(|condition| condition.get("repeat_save_timing").and_then(Value::as_str) == Some("turn-end")).collect();
    for condition in repeating {
        // «Ужас» позволяет повторить спасбросок только вне линии обзора источника.
        if uses_2014 && condition.get("spell_id").and_then(Value::as_str) == Some("fear") && fear_source_in_sight(&repeat_state, &actor_id, &js::s(condition.get("source_actor"))) {
            continue;
        }
        let ability = condition.get("save_ability").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "wis".into());
        let repeat_actor = sk_core::game::find_actor(&repeat_state, &actor_id).cloned().or_else(|| ending_actor.clone());
        let mut modifier = ability_of(repeat_actor.as_ref(), &ability);
        let auto_failed = auto_failed_save_condition_for(&repeat_state, &actor_id, Some(&Value::String(ability.clone())));
        let modifier_result = if auto_failed.is_some() { super::kernel::SaveModifier::default() } else { r.area_save_modifier_for(&repeat_state.clone(), command.get("actor_id"))? };
        for event in modifier_result.events {
            push_applied(r, &mut repeat_state, event)?;
        }
        modifier += modifier_result.modifier;
        let silvery = if auto_failed.is_none() && !silvery_consumed { silvery_fortune_for(&repeat_state, &actor_id) } else { None };
        let spell_id = condition.get("spell_id").cloned();
        let options = save_options(
            &ability,
            modifier,
            format!("spell_repeat_save:{}:{ability}", js::string(spell_id.as_ref())),
            Some(silvery.is_some()),
            Some(auto_failed.is_none()),
            Some(condition.get("id").and_then(Value::as_str) == Some("poisoned")),
            false,
            visibility.clone(),
        );
        let save = r.roll_saving_throw(&repeat_state.clone(), command.get("actor_id"), &options)?;
        let difficulty = js::safe_int(condition.get("save_dc"), 10).max(1);
        let saved = saving_throw_succeeded(Some(&save), difficulty as f64);
        r.rolls.push(save.clone());
        let payload = spread_defined(
            &save,
            vec![("spell_id", spell_id.clone()), ("ability", Some(Value::String(ability.clone()))), ("difficulty", Some(Value::from(difficulty))), ("saved", Some(Value::Bool(saved))), ("trigger", Some(Value::String("turn-end-repeat".into())))],
        );
        let event = event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(payload), Some(&actor_targets));
        push_applied(r, &mut repeat_state, event)?;
        if silvery.is_some() {
            let removed = remove_silvery_fortune_event(&command, &repeat_state, &actor_id, Some("turn-end-repeat"));
            push_applied(r, &mut repeat_state, removed)?;
            silvery_consumed = true;
        }
        // Счёт спасбросков («Окаменение» 2014): три успеха снимают эффект, три
        // провала обращают цель в камень; до тех пор бросок только двигает счёт.
        let tally = js::safe_int(condition.get("repeat_save_tally"), 0);
        if tally > 0 {
            let successes = js::safe_int(condition.get("tally_successes"), 0) + i64::from(saved);
            let failures = js::safe_int(condition.get("tally_failures"), 0) + i64::from(!saved);
            let failure_condition = condition.get("tally_failure_condition").filter(|value| js::truthy(Some(value))).cloned();
            if !saved && failures >= tally && failure_condition.is_some() {
                let removed = object(vec![("condition", condition.get("id").cloned()), ("effect_id", effect_field(&condition)), ("trigger", Some(Value::String("save-tally".into())))]);
                let added = object(vec![
                    ("condition", Some(Value::String(js::string(failure_condition.as_ref())))),
                    ("duration", Some(coalesce(&[condition.get("duration")]).cloned().unwrap_or_else(|| Value::String("concentration".into())))),
                    ("source_actor", condition.get("source_actor").cloned()),
                    ("effect_id", condition.get("effect_id").cloned()),
                    ("spell_id", spell_id.clone()),
                    ("trigger", Some(Value::String("save-tally".into()))),
                ]);
                let source = command_with_rules(&command, &[rule_ids::CONDITIONS]);
                push_applied(r, &mut repeat_state, event_from(&source, "ConditionRemoved", Some(removed), Some(&actor_targets)))?;
                push_applied(r, &mut repeat_state, event_from(&source, "ConditionAdded", Some(added), Some(&actor_targets)))?;
                continue;
            }
            if !saved || successes < tally {
                let mut fields = vec![
                    ("condition", condition.get("id").cloned()),
                    ("duration", Some(coalesce(&[condition.get("duration")]).cloned().unwrap_or(Value::Null))),
                    ("source_actor", condition.get("source_actor").cloned()),
                    ("effect_id", condition.get("effect_id").cloned()),
                    ("repeat_save_timing", Some(Value::String("turn-end".into()))),
                    ("save_ability", condition.get("save_ability").cloned()),
                    ("save_dc", condition.get("save_dc").cloned()),
                    ("spell_id", spell_id.clone()),
                ];
                if js::is_false(condition.get("repeat_save_ends_concentration")) {
                    fields.push(("repeat_save_ends_concentration", Some(Value::Bool(false))));
                }
                if js::present(condition.get("escape_dc")) {
                    fields.push(("escape_dc", condition.get("escape_dc").cloned()));
                }
                if js::is_true(condition.get("no_escape")) {
                    fields.push(("no_escape", Some(Value::Bool(true))));
                }
                fields.push(("repeat_save_tally", Some(Value::from(tally))));
                fields.push(("tally_successes", Some(Value::from(successes))));
                fields.push(("tally_failures", Some(Value::from(failures))));
                if let Some(failure) = failure_condition {
                    fields.push(("tally_failure_condition", Some(failure)));
                }
                let counted = event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(object(fields)), Some(&actor_targets));
                push_applied(r, &mut repeat_state, counted)?;
                continue;
            }
        }
        if !saved {
            continue;
        }
        let source_actor = js::s(condition.get("source_actor"));
        let source_concentration = concentration_of(&repeat_state, &source_actor).cloned();
        let effect = condition.get("effect_id").filter(|value| js::truthy(Some(value)));
        let ends_concentration = !js::is_false(condition.get("repeat_save_ends_concentration"));
        if ends_concentration && effect.is_some_and(|effect| js::s(at(source_concentration.as_ref(), "effect_id")) == js::string(Some(effect))) {
            let source_id = js::string(condition.get("source_actor"));
            let ended = event_from(
                &command_with_rules(&command_with(&command, "actor_id", Value::String(source_id.clone())), &[rule_ids::CONCENTRATION]),
                "ConcentrationEnded",
                Some(json!({ "reason": "repeat-save", "effect_id": effect.cloned().unwrap_or(Value::Null) })),
                Some(&json!([source_id])),
            );
            push_applied(r, &mut repeat_state, ended)?;
            continue;
        }
        let removed = event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(object(vec![("condition", condition.get("id").cloned()), ("effect_id", effect_field(&condition))])), Some(&actor_targets));
        push_applied(r, &mut repeat_state, removed)?;
        if !ends_concentration {
            if let Some(effect) = effect {
                let effect_id = js::string(Some(effect));
                let source_id = js::s(condition.get("source_actor"));
                let concentration = concentration_of(&repeat_state, &source_id);
                let mechanics = sk_core::game::mechanics(&repeat_state);
                let referenced_by_condition = match mechanics.get("conditions") {
                    Some(Value::Object(all)) => all.values().any(|list| list.as_array().is_some_and(|items| items.iter().any(|candidate| js::s(at(Some(candidate), "effect_id")) == effect_id))),
                    _ => false,
                };
                let referenced_by_area = mechanics.get("active_effects").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| js::s(coalesce(&[at(Some(item), "effect_id"), at(Some(item), "id")])) == effect_id));
                if !(referenced_by_condition || referenced_by_area) && js::s(at(concentration, "effect_id")) == effect_id {
                    let ended = event_from(
                        &command_with_rules(&command_with(&command, "actor_id", Value::String(source_id.clone())), &[rule_ids::CONCENTRATION]),
                        "ConcentrationEnded",
                        Some(json!({ "reason": "repeat-save", "effect_id": effect_id })),
                        Some(&json!([source_id])),
                    );
                    push_applied(r, &mut repeat_state, ended)?;
                }
            }
        }
    }
    let mut delayed_state = repeat_state.clone();
    let turn_key = crate::areas::consequences::area_trigger_turn_key(&repeat_state).unwrap_or_else(|| "null".into());
    let delayed: Vec<Value> = conditions_list(&repeat_state, &actor_id)?
        .into_iter()
        .filter(|condition| condition.get("recurring_damage_timing").and_then(Value::as_str) == Some("turn-end") && !(js::present(condition.get("recurring_skip_turn_key")) && js::string(condition.get("recurring_skip_turn_key")) == turn_key))
        .collect();
    for condition in delayed {
        let spell_id = condition.get("spell_id").cloned();
        let source = match coalesce(&[condition.get("source_actor")]) {
            Some(source) => js::string(Some(source)),
            None => actor_id.clone(),
        };
        let roll = r.roll_dice(Value::String(js::string(condition.get("recurring_damage"))), &format!("spell_turn_end_damage:{}", js::string(spell_id.as_ref())), Value::String(source.clone()), roll_visibility.clone())?;
        r.rolls.push(roll.clone());
        r.events.push(event_from(&command, "DieRolled", Some(spread_defined(&roll, vec![("spell_id", spell_id.clone()), ("damage_type", condition.get("recurring_damage_type").cloned())])), Some(&json!([]))));
        let damage_type = Value::String(js::string(coalesce(&[condition.get("recurring_damage_type")]).or(Some(&Value::String("untyped".into())))));
        let payload = r.resolve_damage_with_reactions(&delayed_state.clone(), &actor_id, roll.get("total").cloned().unwrap_or(Value::Null), &damage_type, None, None)?;
        let event = event_from(
            &command_with_rules(&command_with(&command, "actor_id", Value::String(source)), &[rule_ids::DAMAGE]),
            "DamageApplied",
            Some(spread_defined(&payload, vec![("spell_id", spell_id.clone()), ("recurring", Some(Value::Bool(true))), ("trigger", Some(Value::String("turn-end".into())))])),
            Some(&actor_targets),
        );
        push_applied(r, &mut delayed_state, event)?;
        if payload.get("hp_after").and_then(Value::as_f64) == Some(0.0) {
            let consequences = zero_hit_point_damage_consequences(&delayed_state, &command, &actor_id, &payload, false);
            for event in consequences {
                push_applied(r, &mut delayed_state, event)?;
            }
        }
        if js::is_true(condition.get("recurring_once")) {
            let spent = object(vec![("condition", condition.get("id").cloned()), ("effect_id", effect_field(&condition)), ("spell_id", spell_id), ("trigger", Some(Value::String("delayed-damage-spent".into())))]);
            push_applied(r, &mut delayed_state, event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(spent), Some(&actor_targets)))?;
        }
    }
    let commanded = sk_core::game::conditions(&state, &actor_id).iter().find(|condition| condition_name(condition).starts_with("command:")).cloned();
    if let Some(commanded) = commanded {
        let source = command_with_rules(&command, &[rule_ids::CONDITIONS]);
        if js::string(commanded.get("id")) == "command:grovel" {
            let duration = if uses_2014 { Value::Null } else { Value::String("until-next-turn".into()) };
            let payload = object(vec![("condition", Some(Value::String("prone".into()))), ("duration", Some(duration)), ("source_actor", commanded.get("source_actor").cloned()), ("effect_id", commanded.get("effect_id").cloned())]);
            r.events.push(event_from(&source, "ConditionAdded", Some(payload), Some(&actor_targets)));
        }
        r.events.push(event_from(&source, "ConditionRemoved", Some(object(vec![("condition", commanded.get("id").cloned())])), Some(&actor_targets)));
    }
    if let Some(Value::Object(all)) = sk_core::game::mechanics(&state).get("conditions") {
        for (duel_target, list) in js::entries(all) {
            let Some(items) = list.as_array() else { continue };
            let duel = items.iter().find(|condition| condition.get("id").and_then(Value::as_str) == Some("compelled-duel") && js::s(condition.get("source_actor")) == actor_id);
            if let Some(duel) = duel {
                if distance_between_actors(&state, &actor_id, duel_target).is_some_and(|distance| distance > 30.0) {
                    let payload = object(vec![("reason", Some(Value::String("duelist-too-far".into()))), ("effect_id", duel.get("effect_id").cloned())]);
                    r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&actor_targets)));
                }
            }
        }
    }
    // Групповая фаза: пока в ней остались не отходившие, очередь стоит на
    // месте и `TurnStarted` не выдаётся.
    let phase = crate::combat::turn::initiative_group_ids(&state);
    let mut done: Vec<String> = combat.get("turn_completed").and_then(Value::as_array).map(|items| items.iter().map(|item| js::string(Some(item))).collect()).unwrap_or_default();
    done.push(actor_id.clone());
    let pending: Vec<String> = phase.iter().filter(|id| !done.contains(id) && living(sk_core::game::find_actor(&state, id))).cloned().collect();
    if !phase.is_empty() && !pending.is_empty() {
        let mut payload = turn_end.clone();
        payload.insert("group_phase".into(), Value::Bool(true));
        payload.insert("phase_pending".into(), js::strings_value(pending));
        r.events.push(event_from(&command, "TurnEnded", Some(Value::Object(payload)), Some(&actor_targets)));
        return Ok(());
    }
    // Фаза закрыта: указатель прыгает за её последнего участника.
    let active_index = js::number(combat.get("active_index"));
    let last_of_phase = match phase.last() {
        Some(last) => initiative.iter().position(|entry| js::string(entry.get("actor_id")) == *last).map(|index| index as f64).unwrap_or(-1.0),
        None => active_index,
    };
    let length = initiative.len() as f64;
    let mut next_index = (js::max_of([active_index, last_of_phase]) + 1.0) % length;
    let round = js::number(combat.get("round"));
    let mut next_round = if next_index <= active_index { round + 1.0 } else { round };
    let mut next_id = initiative_entry(&initiative, next_index)?;
    r.events.push(event_from(&command, "TurnEnded", Some(Value::Object(turn_end)), Some(&actor_targets)));
    if next_round > round {
        let source = command_with_rules(&command, &[rule_ids::TURNS]);
        r.append_world_time_consequences(&source, Some(&Value::from(6)), Some(&Value::String("second".into())), TimeAdvanceOptions { elapsed_seconds: Some(6.0), policy_id: Some(COMBAT_ROUND_TIME_POLICY.into()), ..TimeAdvanceOptions::default() })?;
        let mut expired: Vec<String> = Vec::new();
        for event in &r.events {
            if event.get("event_type").and_then(Value::as_str) == Some("SummonedCreatureDismissed") && at(event.get("payload"), "reason").and_then(Value::as_str) == Some("duration_expired") {
                for id in event.get("target_ids").and_then(Value::as_array).into_iter().flatten() {
                    let id = js::string(Some(id));
                    if !expired.contains(&id) {
                        expired.push(id);
                    }
                }
            }
        }
        if !expired.is_empty() {
            let after = r.project_events()?;
            let after_initiative: Vec<Value> = sk_core::game::combat(&after).get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
            let old_next = next_index;
            for offset in 0..initiative.len() {
                let old_index = (old_next as usize + offset) % initiative.len();
                let candidate = js::string(initiative[old_index].get("actor_id"));
                if expired.contains(&candidate) {
                    continue;
                }
                let Some(candidate_index) = after_initiative.iter().position(|entry| js::string(entry.get("actor_id")) == candidate) else { continue };
                next_index = candidate_index as f64;
                next_id = Value::String(candidate);
                if (old_index as f64) < old_next {
                    next_round += 1.0;
                }
                break;
            }
        }
    }
    let next_key = js::s(Some(&next_id));
    let next_targets = json!([next_id]);
    r.events.push(event_from(&command, "TurnStarted", Some(json!({ "round": js::num(next_round), "active_index": js::num(next_index), "action_economy_version": ACTION_ECONOMY_EVENT_VERSION })), Some(&next_targets)));
    // Заготовка живёт до начала собственного следующего хода.
    if let Some(expiring) = sk_core::game::combat(&state).get("readied").and_then(|all| all.get(&next_key)).filter(|value| js::truthy(Some(value))) {
        let payload = object(vec![
            ("reason", Some(Value::String("turn-came-around".into()))),
            ("trigger", expiring.get("trigger").cloned()),
            ("spell_id", expiring.get("spell_id").filter(|value| js::truthy(Some(value))).cloned()),
        ]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "ReadiedActionExpired", Some(payload), Some(&next_targets)));
    }
    let mut start_state = r.project_events()?;
    let aura = active_aura_of_life_source(&start_state, &next_key);
    let aura_target = sk_core::game::find_actor(&start_state, &next_key).cloned();
    if let Some(aura) = aura.filter(|_| hp(aura_target.as_ref()) == 0 && !is_dead_hero(&start_state, &next_key)) {
        let payload = json!({
            "spell_id": "aura-of-life", "requested_amount": 1, "applied_amount": 1, "hp_before": 0,
            "hp_after": crate::core::actor_max_hp(aura_target.as_ref()).min(1), "trigger": "turn-start", "aura_of_life_source": aura.source_id,
        });
        let event = event_from(&command_with_rules(&command_with(&command, "actor_id", Value::String(aura.source_id.clone())), &[rule_ids::HEALING]), "HealingApplied", Some(payload), Some(&next_targets));
        push_applied(r, &mut start_state, event)?;
    }
    let death = crate::death::death_saving_throw_at_turn_start(&start_state, &command, &next_key, &mut r.dice)?;
    r.events.extend(death.events);
    r.rolls.extend(death.rolls);
    start_state = r.project_events()?;
    let area_start = r.area_turn_consequences(&start_state.clone(), Some(&next_id), Some("turn-start"))?;
    r.events.extend(area_start);
    start_state = r.project_events()?;
    // Ужас проклятого рыцаря: герой в его радиусе бросает спасбросок в начале
    // своего хода, пока голова не возвращена.
    let knight_id = sk_world_story::scenario_knight::scenario_knight_state(&start_state).and_then(|knight| knight.get("npc_id").cloned()).filter(|value| js::truthy(Some(value)));
    let knight = knight_id.as_ref().and_then(|id| sk_core::game::find_actor(&start_state, &js::s(Some(id))));
    let dread = if knight.is_some_and(sk_core::game::is_living_actor) && !is_dead_hero(&start_state, &next_key) && hp(sk_core::game::find_actor(&start_state, &next_key)) > 0 {
        let knight_key = js::s(knight_id.as_ref());
        sk_world_story::scenario_knight::scenario_knight_dread_for(&start_state, Some(&next_id), knight_distance_feet(&start_state, &next_key, &knight_key))
    } else {
        None
    };
    if let Some(dread) = dread {
        let dread_actor = sk_core::game::find_actor(&start_state, &next_key).cloned();
        let ability = js::s(dread.get("ability"));
        let source_name = sk_world_story::scenario_knight::SCENARIO_KNIGHT_DREAD_SOURCE;
        let mut options = Map::new();
        options.insert("ability".into(), undef(dread.get("ability")));
        options.insert("modifier".into(), Value::from(ability_of(dread_actor.as_ref(), &ability)));
        options.insert("purpose".into(), Value::String(format!("{source_name}:{}", js::string(dread.get("ability")))));
        options.insert("avoid_or_end_condition".into(), Value::String("frightened".into()));
        options.insert("visibility".into(), visibility.clone());
        let save = r.roll_saving_throw(&start_state.clone(), Some(&next_id), &Value::Object(options))?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), js::number(dread.get("dc")));
        let source_id = dread.get("source_id").cloned().unwrap_or(Value::Null);
        let source_command = command_with(&command, "actor_id", source_id.clone());
        let payload = spread_defined(
            &save,
            vec![
                ("ability", dread.get("ability").cloned()),
                ("difficulty", dread.get("dc").cloned()),
                ("saved", Some(Value::Bool(saved))),
                ("source", Some(Value::String(source_name.into()))),
                ("night", dread.get("night").cloned()),
            ],
        );
        r.events.push(event_from(&command_with_rules(&source_command, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(payload), Some(&next_targets)));
        if !saved {
            let payload = json!({ "condition": "frightened", "duration": "until-own-turn-end", "source_actor": source_id, "source": source_name });
            r.events.push(event_from(&command_with_rules(&source_command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&next_targets)));
        }
        start_state = r.project_events()?;
    }
    let starting_actor = sk_core::game::find_actor(&start_state, &next_key).cloned();
    let recurring: Vec<Value> = conditions_list(&start_state, &next_key)?
        .into_iter()
        .filter(|condition| js::truthy(condition.get("recurring_damage")) && condition.get("recurring_damage_timing").and_then(Value::as_str) != Some("turn-end"))
        .collect();
    for condition in recurring {
        let spell_id = condition.get("spell_id").cloned();
        let mut continues = true;
        if let Some(start_save) = condition.get("start_turn_save").filter(|value| js::truthy(Some(value))) {
            let ability = js::string(Some(start_save));
            let difficulty = js::safe_int(condition.get("save_dc"), 10).max(1);
            let auto_failed = auto_failed_save_condition_for(&start_state, &next_key, Some(&Value::String(ability.clone())));
            let silvery = if auto_failed.is_none() { silvery_fortune_for(&start_state, &next_key) } else { None };
            let options = save_options(
                &ability,
                ability_of(starting_actor.as_ref(), &ability),
                format!("spell_start_turn_save:{}:{ability}", js::string(spell_id.as_ref())),
                Some(silvery.is_some()),
                Some(auto_failed.is_none()),
                Some(condition.get("id").and_then(Value::as_str) == Some("poisoned")),
                false,
                visibility.clone(),
            );
            let save = r.roll_saving_throw(&start_state.clone(), Some(&next_id), &options)?;
            let saved = saving_throw_succeeded(Some(&save), difficulty as f64);
            r.rolls.push(save.clone());
            let payload = spread_defined(
                &save,
                vec![("spell_id", spell_id.clone()), ("ability", Some(Value::String(ability.clone()))), ("difficulty", Some(Value::from(difficulty))), ("saved", Some(Value::Bool(saved))), ("trigger", Some(Value::String("turn-start".into())))],
            );
            push_applied(r, &mut start_state, event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(payload), Some(&next_targets)))?;
            if silvery.is_some() {
                let removed = remove_silvery_fortune_event(&command, &start_state, &next_key, Some("turn-start"));
                push_applied(r, &mut start_state, removed)?;
            }
            if saved {
                continues = false;
                let source_id = js::s(condition.get("source_actor"));
                let concentration = concentration_of(&start_state, &source_id);
                let effect = condition.get("effect_id").filter(|value| js::truthy(Some(value)));
                let ended = if effect.is_some_and(|effect| js::s(at(concentration, "effect_id")) == js::string(Some(effect))) {
                    event_from(
                        &command_with_rules(&command_with(&command, "actor_id", Value::String(source_id.clone())), &[rule_ids::CONCENTRATION]),
                        "ConcentrationEnded",
                        Some(json!({ "reason": "turn-start-save", "effect_id": effect.cloned().unwrap_or(Value::Null) })),
                        Some(&json!([source_id])),
                    )
                } else {
                    let payload = object(vec![("condition", condition.get("id").cloned()), ("effect_id", effect_field(&condition)), ("trigger", Some(Value::String("turn-start-save".into()))), ("spell_id", spell_id.clone())]);
                    event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(payload), Some(&next_targets))
                };
                push_applied(r, &mut start_state, ended)?;
            }
        }
        if !continues || !living(sk_core::game::find_actor(&start_state, &next_key)) {
            continue;
        }
        let roll_source = match coalesce(&[condition.get("source_actor")]) {
            Some(source) => js::string(Some(source)),
            None => js::string(Some(&next_id)),
        };
        let roll = r.roll_dice(Value::String(js::string(condition.get("recurring_damage"))), &format!("spell_start_turn_damage:{}", js::string(spell_id.as_ref())), Value::String(roll_source), roll_visibility.clone())?;
        r.rolls.push(roll.clone());
        r.events.push(event_from(&command, "DieRolled", Some(spread_defined(&roll, vec![("spell_id", spell_id.clone()), ("damage_type", condition.get("recurring_damage_type").cloned())])), Some(&json!([]))));
        let damage_type = Value::String(js::string(coalesce(&[condition.get("recurring_damage_type")]).or(Some(&Value::String("untyped".into())))));
        let payload = r.resolve_damage_payload(&start_state.clone(), &next_key, roll.get("total").cloned().unwrap_or(Value::Null), &damage_type, None, None)?;
        let damage_source = match coalesce(&[condition.get("source_actor")]) {
            Some(source) => js::string(Some(source)),
            None => js::string(command.get("actor_id")),
        };
        let event = event_from(
            &command_with_rules(&command_with(&command, "actor_id", Value::String(damage_source)), &[rule_ids::DAMAGE]),
            "DamageApplied",
            Some(spread_defined(&payload, vec![("spell_id", spell_id.clone()), ("recurring", Some(Value::Bool(true))), ("trigger", Some(Value::String("turn-start".into())))])),
            Some(&next_targets),
        );
        push_applied(r, &mut start_state, event)?;
        if payload.get("hp_after").and_then(Value::as_f64) == Some(0.0) {
            let consequences = zero_hit_point_damage_consequences(&start_state, &command, &next_key, &payload, false);
            for event in consequences {
                push_applied(r, &mut start_state, event)?;
            }
        }
        // Отложенный урон срабатывает ровно один раз и сходит сам.
        if js::is_true(condition.get("recurring_once")) {
            let spent = object(vec![("condition", condition.get("id").cloned()), ("effect_id", effect_field(&condition)), ("spell_id", spell_id), ("trigger", Some(Value::String("delayed-damage-spent".into())))]);
            push_applied(r, &mut start_state, event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(spent), Some(&next_targets)))?;
        }
    }
    let heroism = sk_core::game::conditions(&start_state, &next_key).iter().find(|condition| condition.get("id").and_then(Value::as_str) == Some("heroism")).cloned();
    if let Some(heroism) = heroism.filter(|_| living(sk_core::game::find_actor(&start_state, &next_key))) {
        let offered = js::safe_int(heroism.get("temporary_hp_amount"), 0).max(0);
        let before = js::safe_int(sk_core::game::mechanics(&start_state).get("temporary_hp").and_then(|all| all.get(&next_key)), 0).max(0);
        if offered > 0 {
            let source = match coalesce(&[heroism.get("source_actor")]) {
                Some(source) => js::string(Some(source)),
                None => js::string(command.get("actor_id")),
            };
            let payload = json!({ "spell_id": "heroism", "offered": offered, "temporary_hp_before": before, "temporary_hp_after": before.max(offered), "trigger": "turn-start" });
            r.events.push(event_from(&command_with_rules(&command_with(&command, "actor_id", Value::String(source)), &[rule_ids::TEMPORARY_HP]), "TemporaryHitPointsGranted", Some(payload), Some(&next_targets)));
        }
    }
    let recharge = crate::combat::monsters::monster_recharge_at_turn_start(&start_state, &command, Some(&next_id), &mut r.dice)?;
    r.events.extend(recharge.events);
    r.rolls.extend(recharge.rolls);
    r.events.extend(crate::combat::monsters::legendary_actions_reset_at_turn_start(&start_state, &command, Some(&next_id)));
    Ok(())
}

/// `combat.initiative[nextIndex].actor_id`.
fn initiative_entry(initiative: &[Value], index: f64) -> Result<Value, Halt> {
    let entry = if index.is_finite() && index >= 0.0 { initiative.get(index as usize) } else { None };
    match entry {
        Some(entry) if !entry.is_null() => Ok(entry.get("actor_id").cloned().unwrap_or(Value::Null)),
        Some(_) => Err(Fault::type_error("Cannot read properties of null (reading 'actor_id')").into()),
        None => Err(Fault::type_error("Cannot read properties of undefined (reading 'actor_id')").into()),
    }
}
