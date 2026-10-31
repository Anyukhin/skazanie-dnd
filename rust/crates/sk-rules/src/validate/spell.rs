//! Блоки `validateCommand`: Заклинание: магия стат-блока и `CastSpell`. Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 6733–6735, 7347–7590. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Блок дополняет команду на месте, как JS: выбранная ячейка
//! (`spell_slot_resource`, `slot_level`), вариант эффекта врага
//! (`spell_option`), цели области вокруг себя (`target_ids`, `target_id`) и
//! навык усиления (`spell_option`).

use serde_json::{json, Value};
use sk_core::{js, MechanicsSupport};
use sk_geometry::Point;

use super::Validation;
use crate::core::{condition_ids_for, target_for, unique_strings};
use crate::pause::{rule, Step};
use crate::tactical_geometry::npc_positioning::NpcTargetGeometry;
use crate::tactical_geometry::point_json;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    at(Some(value), key)
}

/// `command.key = value` (команда после `normalizeCommand` — объект).
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// `x ?? y` для полей команды.
fn nn(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `circularLineOfEffectFor(state, origin, target, radiusFeet, aroundCorners)`
/// (10010–10020). Перенесённое тело (`areas/shape.rs`, Р1) закрыто в своём
/// модуле; здесь — та же сборка из открытых частей геометрии.
fn circular_line_of_effect_for(state: &Value, origin: Point, target: Point, radius_feet: f64, around_corners: bool) -> bool {
    let cells = crate::tactical_geometry::tactical_cell_map(state);
    if cells.is_empty() {
        return true;
    }
    let map = crate::tactical_geometry::scene_tactical_map(state);
    let is_open = |cell: sk_geometry::GridCell| crate::tactical_geometry::is_transparent_cell(cells.get(&crate::tactical_geometry::key_of(crate::tactical_geometry::grid_point(cell))).copied());
    let is_blocked = |from: sk_geometry::GridCell, to: sk_geometry::GridCell| crate::tactical_geometry::sight_edge_blocked(map.as_ref(), crate::tactical_geometry::grid_point(from), crate::tactical_geometry::grid_point(to));
    sk_geometry::circular_area_geometry::circular_area_line_of_effect(
        origin,
        target,
        &sk_geometry::circular_area_geometry::LineOfEffectOptions { radius_feet, spreads_around_corners: around_corners, is_open_cell: Some(&is_open), is_blocked_edge: Some(&is_blocked) },
    )
}

/// `{ ...command, target_ids: [id] }`.
fn with_single_target(command: &Value, id: &str) -> Value {
    crate::core::command_with(command, "target_ids", json!([id]))
}

/// Цель внутри выбранной области: актёр или NPC сцены.
fn selected_in_area(state: &Value, command: &Value, spell: &Value, id: &str) -> bool {
    let probe = with_single_target(command, id);
    crate::areas::shape::spell_targets_at(state, &probe, spell).iter().any(|candidate| sk_core::game::actor_id(candidate) == id)
        || crate::areas::shape::npc_spell_targets_at(state, &probe, spell).iter().any(|target| target.id() == id)
}

/// `isLivingActor(target)` для возможного отсутствия.
fn living(target: Option<&Value>) -> bool {
    target.is_some_and(sk_core::game::is_living_actor)
}

/// Блок 30 (6733–6735): магия стат-блока.
pub fn check_monster_spell(v: &mut Validation<'_>) -> Step {
    if v.command.get("command_type").and_then(Value::as_str) != Some("CastSpell") {
        return Ok(());
    }
    let actor_id = js::s(v.command.get("actor_id"));
    if sk_combat_content::combat_spells::monster_spellcasting_for(sk_core::game::find_actor(v.state, &actor_id)).is_none() {
        return Ok(());
    }
    let extra = crate::combat::monsters::validate_monster_spell_command(&v.command, v.state, v.context)?;
    if let (Some(command), Some(extra)) = (v.command.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            command.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// Блок 69 (7347–7590): заклинание (авторитетный бой).
pub fn check_cast_spell(v: &mut Validation<'_>) -> Step {
    if v.command.get("command_type").and_then(Value::as_str) != Some("CastSpell") || !(js::truthy(v.command.get("server_authoritative")) || v.context.truthy("serverAuthoritativeCombat")) {
        return Ok(());
    }
    let state = v.state;
    let context = v.context;
    let actor_id = js::s(v.command.get("actor_id"));
    let actor = sk_core::game::find_actor(state, &actor_id);
    let options = json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) });
    let spell = if sk_combat_content::combat_spells::monster_spellcasting_for(actor).is_some() {
        sk_combat_content::combat_spells::monster_combat_spell_for(actor, v.command.get("spell_id"), Some(&options))
    } else {
        sk_combat_content::combat_spells::combat_spell_for(actor, v.command.get("spell_id"), Some(&options))
    };
    if !living(actor) {
        return Err(rule("Побеждённый участник не может творить заклинания", "ACTOR_DEFEATED"));
    }
    let Some(spell) = spell else { return Err(rule("Заклинание не найдено среди доступных герою", "SPELL_NOT_AVAILABLE")) };
    let combat_active = js::truthy(sk_core::game::combat(state).get("active"));
    let kind = js::string(field(&spell, "kind"));
    if !combat_active && crate::resolve::opening_strike::HARMFUL_SPELL_KINDS.contains(&kind.as_str()) {
        return Err(rule("Боевое заклинание требует инициативы: сначала начните бой", "COMBAT_NOT_ACTIVE"));
    }
    let action_type = field(&spell, "actionType").and_then(Value::as_str).map(str::to_owned);
    let action_type = action_type.as_deref();
    if action_type == Some("long_cast") && combat_active {
        return Err(rule("Это заклинание требует больше одного хода и в бою недоступно", "SPELL_CAST_TIME_TOO_LONG"));
    }
    let spell = crate::executable::Executable::admit(Some(spell), "заклинания")?;
    let uses_2014 = sk_core::game::uses_2014(state);
    if uses_2014 && action_type == Some("reaction") {
        return Err(rule("Заклинание-реакция применяется через окно реакции после подходящего события", "REACTION_NOT_AVAILABLE"));
    }
    crate::spells::components::assert_spell_components_allowed(state, actor, Some(&spell), context)?;
    let beam_or_readied = context.truthy("additionalBeam") || context.truthy("readiedRelease");
    let metamagic = condition_ids_for(state, &actor_id);
    if !beam_or_readied {
        let effective = if metamagic.contains("metamagic-quickened") && action_type == Some("action") { Some(json!("bonus_action")) } else { field(&spell, "actionType").cloned() };
        crate::spells::slots::assert_bonus_action_spell_allowed(state, &actor_id, &spell, effective.as_ref())?;
    }
    let spell_id = field(&spell, "id").and_then(Value::as_str).unwrap_or("");
    if spell_id == crate::combat::weapons::SHILLELAGH_CONDITION {
        let item = crate::combat::weapons::combat_item_for_command(actor, v.command.get("item_id"));
        if item.is_none() || crate::combat::weapons::shillelagh_weapon_for(item).is_none() {
            return Err(rule("Для Дубинки нужно выбрать экземпляр дубинки или боевого посоха", "SHILLELAGH_WEAPON_REQUIRED"));
        }
        if !js::is_true(item.and_then(|item| item.get("equipped"))) {
            return Err(rule("Дубинка или боевой посох должны быть в руке", "SHILLELAGH_WEAPON_NOT_HELD"));
        }
    }
    let level = crate::spells::slots::spell_level(&spell);
    let has_slot = js::truthy(field(&spell, "slotResource"));
    let requested_slot = nn(v.command.get("slot_level")).or_else(|| v.command.get("slotLevel")).cloned();
    let resolved_slot = if has_slot && !beam_or_readied {
        crate::spells::slots::choose_spell_slot(state, &actor_id, Some(&spell), requested_slot.as_ref(), v.command.get("casting_resource"))?
    } else {
        None
    };
    if has_slot && !beam_or_readied {
        let Some(slot) = resolved_slot.as_ref() else { return Err(rule("Нет доступной ячейки подходящего уровня", "INSUFFICIENT_RESOURCE")) };
        set_field(&mut v.command, "spell_slot_resource", Value::String(slot.resource.clone()));
        set_field(&mut v.command, "slot_level", Value::from(slot.level));
    }
    let resolved_slot_level = match resolved_slot.as_ref() {
        Some(slot) => slot.level,
        None if has_slot => {
            let requested = nn(v.command.get("slot_level")).or_else(|| v.command.get("slotLevel"));
            level.max(js::safe_int(requested, level))
        }
        None => level,
    };
    if js::is_true(v.command.get("knock_out")) && !(kind == "attack" && field(&spell, "attackKind").and_then(Value::as_str) == Some("melee")) {
        return Err(rule("Нокаутировать можно только ближней атакой заклинанием", "KNOCKOUT_REQUIRES_MELEE_ATTACK"));
    }
    if let Some(options) = field(&spell, "spellOptions").and_then(Value::as_array).filter(|options| !options.is_empty()) {
        let chosen = js::s(v.command.get("spell_option"));
        if !options.iter().any(|option| option.as_str() == Some(chosen.as_str())) {
            if sk_core::game::is_enemy_actor(state, &actor_id) && nn(v.command.get("spell_option")).is_none() {
                let first = options[0].clone();
                set_field(&mut v.command, "spell_option", first);
            } else {
                return Err(rule("Для этого заклинания нужно выбрать вариант эффекта", "SPELL_OPTION_REQUIRED"));
            }
        }
    }
    let range = field(&spell, "range");
    let maximum_range = if metamagic.contains("metamagic-distant") && js::number(range) > 0.0 { js::number(range) * 2.0 } else { js::number(range) };
    let Some(from) = crate::tactical_geometry::actor_point(state, &actor_id) else { return Err(rule("Заклинатель должен находиться на карте", "MAP_POSITION_REQUIRED")) };
    let blind = crate::geometry::footprint::blind_target_allowed(&v.command, context, Some(state));
    let target_kind = field(&spell, "target").and_then(Value::as_str);
    let select_in_area = js::is_true(field(&spell, "selectTargetsInArea"));
    if target_kind == Some("point") {
        check_point_target(v, &spell, from, maximum_range, blind)?;
    } else if target_kind == Some("self") && select_in_area {
        check_self_area_targets(v, &spell)?;
    } else if target_kind != Some("self") {
        check_creature_targets(v, &spell, from, maximum_range, resolved_slot_level, blind)?;
    }
    if spell_id == "borrowed-knowledge" || spell_id == "skill-empowerment" {
        let skill = crate::checks::skills::canonical_skill_id(v.command.get("spell_option"));
        let skill_value = Value::String(skill.clone());
        if skill.is_empty() || sk_ruleset::character_progression::skill_ability(Some(&skill_value)).filter(|value| js::truthy(Some(value))).is_none() {
            return Err(rule("Нужно выбрать существующий навык", "SPELL_SKILL_INVALID"));
        }
        let target = if target_kind == Some("self") {
            actor
        } else {
            let first = v.command.get("target_ids").and_then(Value::as_array).and_then(|ids| ids.first()).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| target_for(&v.command));
            sk_core::game::find_actor(state, &js::string(Some(&first)))
        };
        let Some(target) = target else { return Err(rule("Для усиления навыка нужна живая цель", "INVALID_SPELL_TARGET")) };
        let proficiency = crate::checks::skills::skill_proficiency_for_actor(Some(target), Some(&skill_value), Some(state));
        let proficient = js::truthy(proficiency.get("proficient"));
        if spell_id == "borrowed-knowledge" && proficient {
            return Err(rule("«Заимствованные знания» требует навыка, которым цель не владеет", "BORROWED_KNOWLEDGE_SKILL_ALREADY_PROFICIENT"));
        }
        if spell_id == "skill-empowerment" {
            if !proficient {
                return Err(rule("«Усиление навыка» требует владения выбранным навыком", "SKILL_EMPOWERMENT_REQUIRES_PROFICIENCY"));
            }
            if js::truthy(proficiency.get("expertise")) {
                return Err(rule("«Усиление навыка» нельзя наложить на уже удвоенное мастерство", "SKILL_EMPOWERMENT_EXPERTISE_BLOCKED"));
            }
            if js::number(proficiency.get("multiplier")) >= 2.0 {
                return Err(rule("Бонус мастерства этого навыка уже удвоен", "SKILL_EMPOWERMENT_ALREADY_DOUBLED"));
            }
        }
        set_field(&mut v.command, "spell_option", skill_value);
    }
    Ok(())
}

/// Заклинание в точку (7410–7456).
fn check_point_target(v: &mut Validation<'_>, spell: &Value, from: Point, maximum_range: f64, blind: bool) -> Step {
    let state = v.state;
    let actor_id = js::s(v.command.get("actor_id"));
    let to = Point::from_value(v.command.get("to"));
    if !crate::core::is_safe_integer_f64(to.x) || !crate::core::is_safe_integer_f64(to.y) {
        return Err(rule("Нужно выбрать клетку для заклинания", "INVALID_DESTINATION"));
    }
    let shape = field(spell, "areaShape").and_then(Value::as_str);
    if field(spell, "areaOrigin").and_then(Value::as_str) == Some("self") && matches!(shape, Some("cone" | "cube" | "line")) && to.x == from.x && to.y == from.y {
        return Err(rule("Выберите направление области от заклинателя", "SPELL_DIRECTION_REQUIRED"));
    }
    let cells = crate::tactical_geometry::tactical_cell_map(state);
    let cell = cells.get(&crate::tactical_geometry::key_of(to)).copied();
    let kind = field(spell, "kind").and_then(Value::as_str);
    let needs_empty = matches!(kind, Some("summon" | "teleport"));
    if !crate::tactical_geometry::is_walkable_cell(cell) || (needs_empty && !crate::geometry::footprint::actor_footprint_fits(state, &actor_id, to, crate::geometry::footprint::FitOptions::default())) {
        return Err(rule("Выбранная клетка недоступна", "INVALID_DESTINATION"));
    }
    let without_sight = kind == Some("teleport") && field(spell, "id").and_then(Value::as_str) == Some("dimension-door");
    if !without_sight && !js::is_true(cell.and_then(|cell| cell.get("revealed"))) && !blind {
        return Err(rule("Точка находится в нераскрытой части карты", "TARGET_NOT_VISIBLE"));
    }
    let distance = sk_geometry::actor_footprint::footprint_distance_feet(sk_core::game::find_actor(state, &actor_id), Some(&json!([point_json(to)])), Some(&point_json(from)), None);
    if distance.unwrap_or(0.0) > maximum_range {
        return Err(rule("Клетка находится вне дальности заклинания", "TARGET_OUT_OF_RANGE"));
    }
    if !without_sight {
        if crate::areas::shape::circular_spell_geometry(spell) {
            let origin = Point::from(sk_geometry::circular_area_geometry::grid_origin_for_target_cell(to));
            let clear = crate::tactical_geometry::actor_footprint_cells_at(state, &actor_id, Some(from)).into_iter().any(|cell| circular_line_of_effect_for(state, origin, cell, 600.0, false));
            if !clear {
                return Err(rule("Траекторию к центру области перекрывает преграда", "TRAJECTORY_BLOCKED"));
            }
        } else {
            crate::geometry::forced::assert_clear_actor_to_point(state, &actor_id, Some(from), to)?;
        }
    }
    if js::is_true(field(spell, "selectTargetsInArea")) {
        let requested = if v.command.get("target_ids").and_then(Value::as_array).is_some_and(|ids| !ids.is_empty()) || matches!(v.command.get("target_ids"), Some(Value::String(text)) if !text.is_empty()) {
            unique_strings(v.command.get("target_ids"))
        } else {
            Vec::new()
        };
        let maximum = js::safe_int(field(spell, "maxTargets"), 1).max(1);
        if requested.is_empty() {
            return Err(rule("Выберите хотя бы одну цель заклинания", "SPELL_TARGET_REQUIRED"));
        }
        if requested.len() as i64 > maximum {
            return Err(rule("Слишком много целей для этого уровня ячейки", "TOO_MANY_SPELL_TARGETS"));
        }
        let kind_heals = matches!(kind, Some("healing" | "buff"));
        for id in &requested {
            let target = crate::targets::spell_creature_for(state, id, spell);
            let target_state = match target.as_ref() {
                Some(_) if sk_core::game::find_actor(state, id).is_none() => crate::combat::monsters::npc_damage_context(state, id).into_owned(),
                _ => state.clone(),
            };
            let dying = target.is_some() && crate::targets::is_dying_hero(state, id) && kind_heals;
            if target.is_none() || (!living(target.as_ref()) && !dying) {
                return Err(rule("Нужна допустимая цель заклинания", "INVALID_SPELL_TARGET"));
            }
            let target_id = sk_core::game::actor_id(target.as_ref().unwrap_or(&Value::Null));
            if crate::tactical_geometry::actor_point(&target_state, &target_id).is_none() {
                return Err(rule("Цель должна находиться на карте", "MAP_POSITION_REQUIRED"));
            }
            if !selected_in_area(state, &v.command, spell, id) {
                return Err(rule("Цель находится вне области заклинания", "INVALID_SPELL_TARGET"));
            }
        }
    }
    Ok(())
}

/// Область вокруг себя с выбором целей (7457–7478).
fn check_self_area_targets(v: &mut Validation<'_>, spell: &Value) -> Step {
    let state = v.state;
    let raw: Vec<Value> = v.command.get("target_ids").and_then(Value::as_array).cloned().unwrap_or_default();
    let requested = unique_strings(Some(&Value::Array(raw.clone())));
    let maximum = if nn(field(spell, "maxTargets")).is_none() { f64::INFINITY } else { js::safe_int(field(spell, "maxTargets"), 1).max(1) as f64 };
    if requested.is_empty() {
        return Err(rule("Выберите хотя бы одну цель заклинания", "SPELL_TARGET_REQUIRED"));
    }
    if requested.len() != raw.len() {
        return Err(rule("Нужно выбрать разные существа в области заклинания", "INVALID_SPELL_TARGET"));
    }
    if requested.len() as f64 > maximum {
        return Err(rule("Слишком много целей для этого уровня ячейки", "TOO_MANY_SPELL_TARGETS"));
    }
    for id in &requested {
        let target = sk_core::game::find_actor(state, id).cloned().or_else(|| crate::tactical_geometry::npc_positioning::npc_combat_actor_for(state, id));
        let target_state = match target.as_ref() {
            Some(_) if sk_core::game::find_actor(state, id).is_none() => crate::combat::monsters::npc_damage_context(state, id).into_owned(),
            _ => state.clone(),
        };
        let dying = target.is_some() && crate::targets::is_dying_hero(state, id);
        if target.is_none() || (!living(target.as_ref()) && !dying) {
            return Err(rule("Нужна допустимая цель заклинания", "INVALID_SPELL_TARGET"));
        }
        if crate::tactical_geometry::actor_point(&target_state, id).is_none() {
            return Err(rule("Цель должна находиться на карте", "MAP_POSITION_REQUIRED"));
        }
        if !selected_in_area(state, &v.command, spell, id) {
            return Err(rule("Цель находится вне области заклинания", "INVALID_SPELL_TARGET"));
        }
    }
    let first = requested.first().cloned().unwrap_or_default();
    set_field(&mut v.command, "target_ids", js::strings_value(requested));
    set_field(&mut v.command, "target_id", Value::String(first));
    Ok(())
}

/// Заклинание по существам (7479–7566).
fn check_creature_targets(v: &mut Validation<'_>, spell: &Value, from: Point, maximum_range: f64, slot_level: i64, blind: bool) -> Step {
    let state = v.state;
    let command = v.command.clone();
    let actor_id = js::s(command.get("actor_id"));
    let requested: Vec<String> = if command.get("target_ids").and_then(Value::as_array).is_some_and(|ids| !ids.is_empty()) || matches!(command.get("target_ids"), Some(Value::String(text)) if !text.is_empty()) {
        unique_strings(command.get("target_ids"))
    } else {
        vec![js::string(Some(&target_for(&command)))]
    };
    let level = crate::spells::slots::spell_level(spell);
    let maximum = if crate::spells::slots::has_multiple_beams(Some(spell)) {
        crate::spells::slots::beam_count_for(sk_core::game::find_actor(state, &actor_id), Some(spell), Some(&Value::from(slot_level)))
    } else {
        (js::safe_int(field(spell, "maxTargets"), 1) + (slot_level - level.max(1)).max(0) * js::safe_int(field(spell, "upcastTargetsPerLevel"), 0).max(0)).max(1)
    };
    if requested.len() as i64 > maximum {
        return Err(rule("Слишком много целей для этого уровня ячейки", "TOO_MANY_SPELL_TARGETS"));
    }
    let separation = js::safe_int(field(spell, "maxTargetSeparationFeet"), 0).max(0);
    let anchor = (field(spell, "targetSeparationAnchor").and_then(Value::as_str) == Some("primary") && separation > 0).then(|| requested.first().cloned()).flatten();
    let kind = field(spell, "kind").and_then(Value::as_str);
    let kind_heals = matches!(kind, Some("healing" | "buff"));
    let revives = js::is_true(field(spell, "revivesDead"));
    let actor_enemy = sk_core::game::is_enemy_actor(state, &actor_id);
    let combat_active = js::truthy(sk_core::game::combat(state).get("active"));
    let target_kind = field(spell, "target").and_then(Value::as_str);
    let has_cells = !crate::tactical_geometry::tactical_cell_map(state).is_empty();
    for (index, id) in requested.iter().enumerate() {
        let target = crate::targets::spell_creature_for(state, id, spell);
        let target_state = match target.as_ref() {
            Some(_) if sk_core::game::find_actor(state, id).is_none() => crate::combat::monsters::npc_damage_context(state, id).into_owned(),
            _ => state.clone(),
        };
        let dying = target.is_some() && crate::targets::is_dying_hero(state, id) && kind_heals;
        if revives {
            crate::death::assert_revivable_hero(state, id, spell)?;
        }
        let Some(target) = target.filter(|target| living(Some(target)) || dying || revives) else {
            return Err(rule("Нужна допустимая цель заклинания", "INVALID_SPELL_TARGET"));
        };
        let target_id = sk_core::game::actor_id(&target);
        let hostile = sk_core::game::is_enemy_actor(state, &target_id) != actor_enemy;
        if target_kind == Some("enemy") && !hostile {
            return Err(rule("Это заклинание требует противника", "INVALID_SPELL_TARGET"));
        }
        if target_kind == Some("ally") && hostile {
            return Err(rule("Это заклинание требует союзника", "INVALID_SPELL_TARGET"));
        }
        let stabilizes = js::is_true(field(spell, "stabilizesDying"));
        if stabilizes && !crate::targets::is_unstable_dying_hero(state, &target_id) {
            return Err(rule("Заклинание стабилизирует только существо с 0 хитов, которое ещё совершает спасброски от смерти", "STABILIZATION_NOT_REQUIRED"));
        }
        if stabilizes {
            let creature_type = crate::spells::slots::creature_type_for(Some(&target));
            if field(spell, "immuneCreatureTypes").and_then(Value::as_array).is_some_and(|types| types.iter().any(|kind| kind.as_str() == Some(creature_type.as_str()))) {
                return Err(rule("Заклинание не действует на этот тип существ", "INVALID_SPELL_TARGET"));
            }
        }
        if !combat_active && hostile && !js::is_false(field(spell, "requiresCombatAgainstHostile")) {
            return Err(rule("Заклинание против противника требует инициативы: сначала начните бой", "COMBAT_NOT_ACTIVE"));
        }
        let Some(to) = crate::tactical_geometry::actor_point(&target_state, &target_id) else { return Err(rule("Цель должна находиться на карте", "MAP_POSITION_REQUIRED")) };
        if has_cells && !crate::geometry::footprint::actor_footprint_visible(&target_state, id, Some(to)) && !blind {
            return Err(rule("Цель находится в нераскрытой части карты", "TARGET_NOT_VISIBLE"));
        }
        let secondary = anchor.is_some() && index > 0;
        let source_id = if secondary { anchor.clone().unwrap_or_default() } else { actor_id.clone() };
        let source_position = if secondary { crate::tactical_geometry::actor_point(state, &source_id) } else { Some(from) };
        let Some(source_position) = source_position else { return Err(rule("Цель должна находиться на карте", "MAP_POSITION_REQUIRED")) };
        let distance = crate::geometry::footprint::distance_between_actor_positions(&target_state, &source_id, Some(source_position), id, Some(to));
        let distance_value = distance.unwrap_or(0.0);
        if secondary {
            if distance_value > separation as f64 {
                return Err(rule(format!("Цели должны находиться в пределах {separation} футов от первой цели"), "SPELL_TARGETS_TOO_FAR_APART"));
            }
            crate::geometry::forced::assert_clear_actor_trajectory(&target_state, &source_id, id, Some(source_position), Some(to), blind)?;
        } else {
            if distance_value > maximum_range {
                return Err(rule("Цель находится вне дальности заклинания", "TARGET_OUT_OF_RANGE"));
            }
            let verified_2014 = sk_core::game::uses_2014(state) && MechanicsSupport::is(field(spell, "mechanicsSupport"), MechanicsSupport::Verified);
            if distance_value > 5.0 || field(spell, "id").and_then(Value::as_str) == Some("longstrider") || verified_2014 {
                crate::geometry::forced::assert_clear_actor_trajectory(&target_state, &source_id, id, Some(source_position), Some(to), blind)?;
            }
        }
        if js::is_true(field(spell, "requiresSight")) {
            let source_conditions = condition_ids_for(state, &actor_id);
            let target_conditions = condition_ids_for(state, id);
            let darkness = (source_conditions.contains("magical-darkness") || target_conditions.contains("magical-darkness")) && !crate::checks::saves::sees_in_magical_darkness(sk_core::game::find_actor(state, &actor_id));
            if source_conditions.contains("blinded") || (target_conditions.contains("invisible") && *id != actor_id) || darkness {
                return Err(rule("Для этого заклинания нужно видеть выбранное существо", "SPELL_TARGET_REQUIRES_SIGHT"));
            }
        }
    }
    if separation > 0 && anchor.is_none() {
        for first in 0..requested.len() {
            for second in first + 1..requested.len() {
                let left = &requested[first];
                let right = &requested[second];
                let distance = crate::geometry::footprint::distance_between_actor_positions(state, left, crate::tactical_geometry::actor_point(state, left), right, crate::tactical_geometry::actor_point(state, right));
                if distance.unwrap_or(0.0) > separation as f64 {
                    return Err(rule(format!("Цели должны находиться в пределах {separation} футов друг от друга"), "SPELL_TARGETS_TOO_FAR_APART"));
                }
            }
        }
    }
    Ok(())
}

