//! Ветки `resolveCommandInternal`: Особые действия монстров и легендарные действия. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 15032–15088, 16697–16835. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Особое действие стат-блока (дыхание, плевок) — область, посчитанная
//! предпросмотром: один бросок урона на всех, спасбросок и защиты у каждого.
//! Легендарное действие экономику хода не трогает вовсе: запас тратится
//! маркерами по одному на единицу стоимости.

use serde_json::{json, Map, Value};
use sk_core::{game, js, text};

use super::kernel::undef;
use super::Resolve;
use crate::checks::saves::{saved_damage_amount, saving_throw_succeeded};
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with, command_with_rules, event_from, spread_value};
use crate::pause::{Fault, Step};
use crate::preview_attack::{condition_id_values, preview_monster_action};
use crate::replay::apply_game_event;
use crate::tactical_geometry::{actor_point, line_cells, point_json, points_json};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

fn targets(id: &str) -> Value {
    json!([id])
}

/// `{ ...base, key: value, … }`.
fn spread(base: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut map = spread_value(Some(base));
    for (key, value) in fields {
        map.insert(key.into(), value);
    }
    Value::Object(map)
}

/// `UseMonsterAction` (15032–15088).
pub fn use_monster_action(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let actor_id = js::string(command.get("actor_id"));
    let preview = preview_monster_action(&state, &actor_id, command.get("action_id"), command.get("to"))?;
    let action = &preview.action;
    let shape = js::s(action.get("shape"));
    let affected_value = js::strings_value(preview.affected_ids.clone());
    let mut area = Map::new();
    area.insert("shape".into(), action.get("shape").cloned().unwrap_or(Value::Null));
    area.insert("from".into(), point_json(preview.origin));
    area.insert("to".into(), point_json(if shape == "sphere" { preview.origin } else { preview.to }));
    if let Some(size) = action.get("length_feet") {
        area.insert("size_feet".into(), size.clone());
    }
    let first_type = action.get("damage").and_then(Value::as_array).and_then(|items| items.first()).and_then(|component| component.get("type")).filter(|value| !value.is_null());
    area.insert("damage_type".into(), Value::String(js::s(first_type)));
    if let Some(ability) = at(action.get("save"), "ability") {
        area.insert("save_ability".into(), ability.clone());
    }
    area.insert("target_ids".into(), affected_value.clone());
    let mut used = Map::new();
    if let Some(id) = action.get("id") {
        used.insert("action_id".into(), id.clone());
    }
    if let Some(name) = action.get("name") {
        used.insert("name".into(), name.clone());
    }
    used.insert("action_type".into(), json!("action"));
    used.insert("monster_action".into(), json!(true));
    used.insert("area".into(), Value::Object(area));
    r.events.push(event_from(&command_with_rules(&command, &[rule_ids::ACTIONS]), "CombatActionUsed", Some(Value::Object(used)), Some(&affected_value)));
    let actor_targets = targets(&js::s(command.get("actor_id")));
    if let Some(marker) = sk_combat_base::monster_actions::monster_action_spent_marker(Some(action), &condition_id_values(&state, &actor_id)) {
        let mut body = Map::new();
        body.insert("condition".into(), Value::String(marker));
        body.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(body)), Some(&actor_targets)));
    }
    // Для одной области бросок урона общий, а спасбросок и защиты — у каждой цели.
    let components: &[Value] = action.get("damage").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let hidden = command_with(&command, "visibility", json!("gm_only"));
    let mut damage: Vec<Value> = Vec::new();
    for component in components {
        if !js::truthy(component.get("expression")) {
            damage.push(spread(component, vec![("rolled", component.get("amount").cloned().unwrap_or(Value::String(js::UNDEFINED.into())))]));
            continue;
        }
        let roll = r.roll_dice(component.get("expression").cloned().unwrap_or(Value::Null), "monster_area_damage", command.get("actor_id").cloned().unwrap_or(Value::Null), json!("gm_only"))?;
        r.rolls.push(roll.clone());
        r.events.push(event_from(&hidden, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        damage.push(spread(component, vec![("rolled", js::num(js::number(roll.get("total")).max(0.0)))]));
    }
    let mut working_state = r.project_events()?;
    let ability = at(action.get("save"), "ability").cloned().unwrap_or(Value::Null);
    let ability_key = js::string(Some(&ability));
    let dc = at(action.get("save"), "dc").cloned().unwrap_or(Value::Null);
    let half_on_save = at(action.get("save"), "success").and_then(Value::as_str) == Some("half_damage");
    let action_id = action.get("id").cloned().unwrap_or(Value::Null);
    for target_id in &preview.affected_ids {
        let target_value = Value::String(target_id.clone());
        let target = game::find_actor(&working_state, target_id);
        let mut options = Map::new();
        options.insert("ability".into(), ability.clone());
        options.insert("modifier".into(), Value::from(ability_modifier(at(at(target, "abilities"), &ability_key))));
        options.insert("purpose".into(), Value::String(format!("monster_area_save:{}:{ability_key}", js::string(Some(&action_id)))));
        options.insert("visibility".into(), undef(command.get("visibility")));
        options.insert("difficulty".into(), dc.clone());
        let save = r.roll_saving_throw(&working_state, Some(&target_value), &Value::Object(options))?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), js::number(Some(&dc)));
        let body = spread(&save, vec![("ability", ability.clone()), ("difficulty", dc.clone()), ("saved", json!(saved)), ("success", json!(saved)), ("source", json!("monster-action")), ("action_id", action_id.clone())]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(body), Some(&targets(target_id))));
        for component in &damage {
            let raw = saved_damage_amount(&working_state, target_id, Some(&ability), saved, half_on_save, component.get("rolled").filter(|value| value.as_str() != Some(js::UNDEFINED)));
            let before = working_state.clone();
            let damage_type = component.get("type").cloned().unwrap_or(Value::String(js::UNDEFINED.into()));
            let payload = r.resolve_damage_payload(&before, target_id, Value::from(raw), &damage_type, None, None)?;
            let body = spread(&payload, vec![("action_id", action_id.clone()), ("monster_action", json!(true)), ("saved", json!(saved))]);
            let damage_event = event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(body), Some(&targets(target_id)));
            r.events.push(damage_event.clone());
            working_state = apply_game_event(&working_state, &damage_event)?;
            let consequences = crate::death::zero_hit_point_damage_consequences(&before, &command, target_id, &payload, false);
            for event in &consequences {
                working_state = apply_game_event(&working_state, event)?;
            }
            r.events.extend(consequences);
        }
    }
    Ok(())
}

/// `UseLegendaryAction` (16697–16835).
pub fn use_legendary_action(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let declared = command.get("legendary_action").cloned().unwrap_or(Value::Null);
    let actor_id = js::s(command.get("actor_id"));
    let actor_value = command.get("actor_id").cloned().unwrap_or(Value::Null);
    let actor = game::find_actor(&state, &actor_id);
    let Some(action) = sk_combat_base::legendary_actions::legendary_action_for(actor, command.get("legendary_action_id")) else {
        return Err(Fault::type_error("Cannot read properties of undefined (reading 'areaShape')").into());
    };
    let target_id = js::s(command.get("target_id"));
    let target = game::find_actor(&state, &target_id);
    // Область спасброска: круг вокруг существа или конус к объявленной цели.
    let centre = actor_point(&state, &actor_id);
    let toward = if action.area_shape == "cone" { actor_point(&state, &target_id) } else { centre };
    let radius = action.radius_feet as f64;
    let actor_is_enemy = game::is_enemy_actor(&state, &actor_id);
    let caught: Vec<Value> = if action.kind != "save" {
        Vec::new()
    } else if action.radius_feet > 0 {
        game::list_actors(&state)
            .into_iter()
            .filter(|candidate| {
                let candidate_id = game::actor_id(candidate);
                let at_point = actor_point(&state, &candidate_id);
                let (Some(at_point), Some(centre)) = (at_point, centre) else { return false };
                if !game::is_living_actor(candidate) || game::is_enemy_actor(&state, &candidate_id) == actor_is_enemy {
                    return false;
                }
                if action.area_shape == "cone" {
                    return toward.is_some()
                        && crate::geometry::forced::has_clear_actor_trajectory(&state, &actor_id, &candidate_id, Some(centre), Some(at_point), false)
                        && crate::areas::shape::actor_in_area(&state, &candidate_id, Some(at_point), toward, radius, "cone", Some(&actor_id), Some(centre));
                }
                // `null <= radius`: неизвестное расстояние — ноль.
                sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), actor, Some(&point_json(at_point)), Some(&point_json(centre))).unwrap_or(0.0) <= radius
            })
            .cloned()
            .collect()
    } else {
        target.into_iter().cloned().collect()
    };
    let hidden = command_with(&command, "visibility", json!("gm_only"));
    let hidden_conditions = command_with_rules(&hidden, &[rule_ids::CONDITIONS]);
    let actor_targets = json!([actor_value]);
    let uses_before = js::number(declared.get("uses_before"));
    let uses_after = js::number(declared.get("uses_after"));
    let window_key = js::string(declared.get("window_key"));
    let mut ordinal = uses_before + 1.0;
    while ordinal <= uses_after {
        let marker = sk_combat_base::legendary_actions::legendary_action_marker(ordinal as i64, &window_key);
        r.events.push(event_from(&hidden_conditions, "ConditionAdded", Some(json!({ "condition": marker, "duration": "until-own-turn-start", "source_actor": actor_value })), Some(&actor_targets)));
        ordinal += 1.0;
    }
    let mut used = Map::new();
    used.insert("action_id".into(), Value::String(action.id.clone()));
    used.insert("name".into(), Value::String(action.name.clone()));
    used.insert("cost".into(), Value::from(action.cost));
    used.insert("uses_before".into(), declared.get("uses_before").cloned().unwrap_or(Value::Null));
    used.insert("uses_after".into(), declared.get("uses_after").cloned().unwrap_or(Value::Null));
    used.insert("uses_max".into(), declared.get("uses_max").cloned().unwrap_or(Value::Null));
    if let (true, Some(centre)) = (action.kind == "save" && action.radius_feet > 0, centre) {
        // СЛ — число стат-блока, игроку не принадлежит: в области её нет.
        used.insert(
            "area".into(),
            json!({
                "shape": action.area_shape,
                "from": point_json(centre),
                "to": point_json(toward.unwrap_or(centre)),
                "size_feet": action.radius_feet,
                "damage_type": action.damage_type,
                "save_ability": action.save_ability,
                "target_ids": caught.iter().map(game::actor_id).collect::<Vec<_>>(),
            }),
        );
    }
    r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "LegendaryActionUsed", Some(Value::Object(used)), Some(&actor_targets)));
    if action.cooldown_turns > 0 {
        r.events.push(event_from(
            &hidden_conditions,
            "ConditionAdded",
            Some(json!({ "condition": sk_combat_base::legendary_actions::legendary_cooldown_marker(&action.id), "duration": format!("source-turns:{}", action.cooldown_turns), "source_actor": actor_value })),
            Some(&actor_targets),
        ));
    }
    let visibility = r.visibility();
    let target_targets = targets(&target_id);
    if action.kind == "attack" {
        let attacker_at = actor_point(&state, &actor_id);
        let target_at = actor_point(&state, &target_id);
        let mut options = Map::new();
        options.insert("modifier".into(), js::num(action.attack_modifier));
        options.insert("purpose".into(), Value::String(format!("legendary_attack:{}", action.id)));
        if let Some(actor) = command.get("actor_id") {
            options.insert("actorId".into(), actor.clone());
        }
        options.insert("visibility".into(), visibility.clone());
        let roll = crate::dice_record::RulesDice::roll_d20(&mut r.dice, &Value::Object(options))?;
        r.rolls.push(roll.clone());
        let armor_class = crate::damage::effective_armor_class(&state, target, &target_id)?;
        let kept = js::number(roll.get("kept"));
        let critical = kept == 20.0;
        let hit = critical || (kept != 1.0 && js::number(roll.get("total")) >= armor_class);
        // Имя легендарного действия — не публичное `action_name`: облик неизвестен.
        let trajectory = match (attacker_at, target_at) {
            (Some(from), Some(to)) => {
                let mut cells = vec![from];
                cells.extend(line_cells(from, to));
                points_json(&cells)
            }
            _ => json!([]),
        };
        let body = spread(
            &roll,
            vec![
                ("target_id", Value::String(target_id.clone())),
                ("armor_class", js::num(armor_class)),
                ("hit", json!(hit)),
                ("critical", json!(critical)),
                ("legendary_action_id", Value::String(action.id.clone())),
                ("trajectory", trajectory),
                ("attack_visual", sk_scene_base::actor_appearance::attack_visual_for(None)),
            ],
        );
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::ATTACK]), "AttackResolved", Some(body), Some(&target_targets)));
        if let Some(expression) = action.damage_expression.clone().filter(|expression| hit && !expression.is_empty()) {
            let damage_roll = r.roll_dice(Value::String(expression.clone()), &format!("legendary_damage:{}", action.id), actor_value.clone(), visibility.clone())?;
            r.rolls.push(damage_roll.clone());
            r.events.push(event_from(&command, "DieRolled", Some(damage_roll.clone()), Some(&json!([]))));
            // Крит удваивает кости, а не итог: второй бросок — без постоянной прибавки.
            let critical_roll = if critical {
                let dice_only = text::replace_first(sk_core::re!(r"[+-]\s*\d+$", "u"), &expression, "");
                let roll = r.roll_dice(Value::String(dice_only), &format!("legendary_damage_critical:{}", action.id), actor_value.clone(), visibility.clone())?;
                r.rolls.push(roll.clone());
                r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
                Some(roll)
            } else {
                None
            };
            let damage_state = r.project_events()?;
            let total = js::number(damage_roll.get("total")) + critical_roll.as_ref().map_or(0.0, |roll| js::number(roll.get("total")));
            let payload = r.resolve_damage_payload(&damage_state, &target_id, js::num(total), &Value::String(action.damage_type.clone()), None, None)?;
            let body = spread(&payload, vec![("legendary_action_id", Value::String(action.id.clone())), ("critical", json!(critical))]);
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(body), Some(&target_targets)));
            r.events.extend(crate::death::zero_hit_point_damage_consequences(&damage_state, &command, &target_id, &payload, critical));
        }
        return Ok(());
    }
    // Спасбросок бьёт по всем в области, а не только по объявленной цели.
    let difficulty = match action.save_dc {
        Some(dc) => dc,
        None => sk_combat_content::combat_spells::monster_spellcasting_for(actor).map_or(10.0, |spellcasting| spellcasting.save_dc),
    };
    let damage_roll = match action.damage_expression.clone().filter(|expression| !expression.is_empty()) {
        Some(expression) => {
            let roll = r.roll_dice(Value::String(expression), &format!("legendary_damage:{}", action.id), actor_value.clone(), visibility.clone())?;
            r.rolls.push(roll.clone());
            r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
            Some(roll)
        }
        None => None,
    };
    let mut sweep_state = state.clone();
    let ability = Value::String(action.save_ability.clone());
    for caught_actor in &caught {
        let caught_id = game::actor_id(caught_actor);
        let caught_value = Value::String(caught_id.clone());
        let mut options = Map::new();
        options.insert("ability".into(), ability.clone());
        options.insert("modifier".into(), Value::from(ability_modifier(at(caught_actor.get("abilities"), &action.save_ability))));
        options.insert("purpose".into(), Value::String(format!("legendary_save:{}:{}", action.id, action.save_ability)));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.roll_saving_throw(&sweep_state, Some(&caught_value), &Value::Object(options))?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), difficulty);
        let body = spread(&save, vec![("ability", ability.clone()), ("difficulty", js::num(difficulty)), ("saved", json!(saved)), ("legendary_action_id", Value::String(action.id.clone()))]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(body), Some(&targets(&caught_id))));
        let amount = match &damage_roll {
            Some(roll) => saved_damage_amount(&sweep_state, &caught_id, Some(&ability), saved, action.half_on_save, roll.get("total")),
            None => 0,
        };
        if amount > 0 {
            let damage_state = sweep_state.clone();
            let payload = r.resolve_damage_payload(&damage_state, &caught_id, Value::from(amount), &Value::String(action.damage_type.clone()), None, None)?;
            let body = spread(&payload, vec![("legendary_action_id", Value::String(action.id.clone())), ("saved", json!(saved))]);
            let applied = event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(body), Some(&targets(&caught_id)));
            r.events.push(applied.clone());
            sweep_state = apply_game_event(&sweep_state, &applied)?;
            let consequences = crate::death::zero_hit_point_damage_consequences(&damage_state, &command, &caught_id, &payload, false);
            for event in &consequences {
                sweep_state = apply_game_event(&sweep_state, event)?;
            }
            r.events.extend(consequences);
        }
        if let Some(condition) = action.condition.clone().filter(|condition| !saved && !condition.is_empty()) {
            r.events.push(event_from(
                &command_with_rules(&command, &[rule_ids::CONDITIONS]),
                "ConditionAdded",
                Some(json!({ "condition": condition, "duration": "until-next-turn", "source_actor": actor_value, "legendary_action_id": action.id })),
                Some(&targets(&caught_id)),
            ));
        }
    }
    Ok(())
}
