//! Блоки `validateCommand`: Боевой приём `UseCombatAction`. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 7586–7768. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Отказ от реакции (`decline-reaction`) в JS выходит из `validateCommand`
//! досрочно (`return command`, 7594). Здесь блок просто заканчивается: из
//! блоков после него для `UseCombatAction` срабатывает только проверка
//! происхождения (7819), а она видит непустые `source_rule_ids`, которые
//! `normalizeCommand` берёт из `COMMAND_RULES`.
//!
//! Действие, которое блок кладёт в `command.combat_action`, разбор берёт
//! как есть (`resolve/combat_action.rs`).

use serde_json::{json, Map, Value};
use sk_core::js;

use super::common::js_includes;
use super::Validation;
use crate::combat::class_features::{assert_monk_unarmed_action_allowed, divine_smite_action_for, font_of_magic_action_for, lay_on_hands_action_for};
use crate::combat::weapons::{item_attack_profile, off_hand_weapon_for, trusted_attack_profile, AttackOptions};
use crate::context::Context;
use crate::core::{assert_mechanics_supported, condition_ids_for, resource_pool, spread_value, target_for};
use crate::enervation_link::{enervation_continuation_action_for, enervation_link_for};
use crate::geometry::footprint::distance_between_actor_positions;
use crate::geometry::forced::assert_clear_actor_trajectory;
use crate::pause::{rule, Fault, Halt, Step};
use crate::spells::components::assert_spell_components_allowed;
use crate::spells::enervation::enervation_continuation_invalid_reason;
use crate::spells::slots::{assert_bonus_action_spell_allowed, reaction_slot_choice};
use crate::tactical_geometry::actor_point;
use crate::targets::{distance_between_actors, is_dying_hero};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `isLivingActor(actor)` (`null` — не живой).
fn living(actor: Option<&Value>) -> bool {
    actor.is_some_and(sk_core::game::is_living_actor)
}

/// `{ rulesetId: state.ruleset_id }`.
pub(crate) fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

/// `command.key = value`.
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// `list?.find((candidate) => candidate.id === id)`: `null` в списке — `TypeError`.
pub(crate) fn find_by_id<'a>(list: Option<&'a Value>, id: Option<&Value>) -> Result<Option<&'a Value>, Halt> {
    let items = match list {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(Value::Object(_) | Value::String(_)) => return Err(Fault::type_error("reactionWindow.action_options?.find is not a function").into()),
        Some(_) => return Err(Fault::type_error("reactionWindow.action_options?.find is not a function").into()),
    };
    for item in items {
        if item.is_null() {
            return Err(Fault::type_error("Cannot read properties of null (reading 'id')").into());
        }
        if super::common::strict_equal(item.get("id"), id) {
            return Ok(Some(item));
        }
    }
    Ok(None)
}

/// `(window.action_ids ?? []).includes(id)`.
fn window_offers(window: Option<&Value>, id: Option<&Value>) -> Result<bool, Halt> {
    js_includes(at(window, "action_ids"), id, "reactionWindow.action_ids")
}

/// `String(window.actor_id) !== command.actor_id`.
fn other_window_actor(window: &Value, command: &Value) -> bool {
    !super::common::strict_equal(Some(&Value::String(js::string(window.get("actor_id")))), command.get("actor_id"))
}

/// Выбор Сопротивления в окне спасброска (7604–7619).
fn resistance_choice_action(action_id: &str) -> Value {
    let used = action_id == "use-resistance";
    json!({
        "id": action_id,
        "name": if used { "Использовать Сопротивление" } else { "Без бонуса" },
        "category": "spell",
        "target": "self",
        "actionType": "free",
        "range": 0,
        "mechanicsSupport": "verified",
        "cost": 0,
        "resource": null,
        "description": if used { "Добавить 1к4 к этому спасброску." } else { "Сохранить Сопротивление для следующего спасброска." },
    })
}

/// Встроенные реакции и Несгибаемый (7620–7636).
fn builtin_action(action_id: &str) -> Option<Value> {
    Some(match action_id {
        "indomitable" => json!({
            "id": "indomitable", "name": "Несгибаемый", "category": "class", "target": "self", "actionType": "free", "range": 0,
            "mechanicsSupport": "verified",
            "resource": "indomitable", "cost": 1, "description": "Перебросить проваленный спасбросок с бонусом, равным уровню воина.",
        }),
        "opportunity-attack" => json!({
            "id": "opportunity-attack", "name": "Атака по возможности", "category": "common", "target": "self", "actionType": "reaction", "range": 5,
            "mechanicsSupport": "verified",
            "description": "Атаковать оружием противника, покидающего вашу досягаемость.",
        }),
        "readied-attack" => json!({
            "id": "readied-attack", "name": "Заготовленная атака", "category": "common", "target": "self", "actionType": "reaction", "range": 5,
            "mechanicsSupport": "verified",
            "description": "Нанести заготовленный удар: триггер сработал.",
        }),
        "readied-spell" => json!({
            "id": "readied-spell", "name": "Выпустить заготовленное заклинание", "category": "common", "target": "self", "actionType": "reaction", "range": 0,
            "mechanicsSupport": "verified",
            "description": "Отпустить удерживаемое заклинание: триггер сработал.",
        }),
        _ => return None,
    })
}

/// Карточка заклинания-реакции (7637–7648).
fn reaction_spell_action(spell: &Value, option: Option<&Value>) -> Value {
    let mut action = Map::new();
    action.insert("id".into(), Value::String(format!("cast:{}", js::string(spell.get("id")))));
    insert_defined(&mut action, "name", spell.get("name"));
    action.insert("category".into(), Value::String("spell".into()));
    let target = if matches!(spell.get("id").and_then(Value::as_str), Some("hellish-rebuke" | "counterspell" | "silvery-barbs")) { "enemy" } else { "self" };
    action.insert("target".into(), Value::String(target.into()));
    action.insert("actionType".into(), Value::String("reaction".into()));
    insert_defined(&mut action, "range", spell.get("range"));
    let resource = crate::core::coalesce(&[at(option, "resource")]).or_else(|| spell.get("slotResource"));
    insert_defined(&mut action, "resource", resource);
    insert_defined(&mut action, "mechanicsSupport", spell.get("mechanicsSupport"));
    action.insert("cost".into(), Value::from(1));
    let mut card = spread_value(Some(spell));
    let slot_level = crate::core::coalesce(&[at(option, "slot_level")]).or_else(|| spell.get("level"));
    match slot_level {
        Some(level) => {
            card.insert("reactionSlotLevel".into(), level.clone());
        }
        None => {
            card.shift_remove("reactionSlotLevel");
        }
    }
    action.insert("spell".into(), Value::Object(card));
    Value::Object(action)
}

/// Значение, кроме `undefined`: ключ с `undefined` в JSON не попадает.
fn insert_defined(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `{ ...action, ...extra }`.
fn with_fields(action: &Value, fields: &[(&str, Value)]) -> Value {
    let mut map = spread_value(Some(action));
    for (key, value) in fields {
        map.insert((*key).into(), value.clone());
    }
    Value::Object(map)
}

/// Блок 71 (7586–7768): боевой приём (авторитетный бой).
pub fn check_combat_action(v: &mut Validation<'_>) -> Step {
    if v.command.get("command_type").and_then(Value::as_str) != Some("UseCombatAction") || !(js::truthy(v.command.get("server_authoritative")) || v.context.truthy("serverAuthoritativeCombat")) {
        return Ok(());
    }
    let state = v.state;
    let actor_id = js::s(v.command.get("actor_id"));
    let actor = sk_core::game::find_actor(state, &actor_id);
    let state_window = sk_core::game::combat(state).get("reaction_window");
    let reaction_window: Option<Value> = if v.context.is_true("indomitableResume") && js::truthy(v.command.get("reaction_window")) {
        v.command.get("reaction_window").cloned()
    } else {
        state_window.cloned()
    };
    let window = reaction_window.as_ref().filter(|window| !window.is_null());
    let action_id_value = v.command.get("action_id").cloned();
    let action_id = js::string(action_id_value.as_ref());
    if action_id_value.as_ref().and_then(Value::as_str) == Some("decline-reaction") {
        let declined = match reaction_window.as_ref() {
            Some(window) if js::truthy(Some(window)) => other_window_actor(window, &v.command),
            _ => true,
        };
        if declined {
            return Err(rule("Нет ожидающей реакции", "REACTION_NOT_AVAILABLE"));
        }
        set_field(&mut v.command, "reaction_window", reaction_window.clone().unwrap_or(Value::Null));
        return Ok(());
    }
    let reaction_spell_id = action_id.strip_prefix("cast:").map(str::to_string).unwrap_or_default();
    let options = ruleset_options(state);
    let reaction_spell = if reaction_spell_id.is_empty() { None } else { sk_combat_content::combat_spells::combat_spell_for(actor, Some(&Value::String(reaction_spell_id)), Some(&options)) };
    let offered = find_by_id(at(window, "action_options"), action_id_value.as_ref())?.cloned();
    let reaction_option = match (&reaction_spell, &offered) {
        (Some(spell), Some(offered)) if js::present(v.command.get("slot_level")) => Some(reaction_slot_choice(state, &actor_id, spell, offered, v.command.get("slot_level"))?),
        _ => offered.clone(),
    };
    let resistance_choice = window.is_some_and(|window| window.get("trigger").and_then(Value::as_str) == Some("saving-throw-bonus-choice")) && window_offers(window, action_id_value.as_ref())?;
    let resistance_action = resistance_choice.then(|| resistance_choice_action(&action_id));
    let action = match &resistance_action {
        Some(action) => Some(action.clone()),
        None => match builtin_action(action_id_value.as_ref().and_then(Value::as_str).unwrap_or("\u{0}")) {
            Some(action) => Some(action),
            None => match reaction_spell.as_ref().filter(|spell| spell.get("actionType").and_then(Value::as_str) == Some("reaction")) {
                Some(spell) => Some(reaction_spell_action(spell, reaction_option.as_ref())),
                None => sk_combat_content::combat_actions::combat_action_for(actor, action_id_value.as_ref())
                    .or_else(|| enervation_continuation_action_for(state, v.command.get("actor_id"), action_id_value.as_ref())),
            },
        },
    };
    let Some(action) = action.filter(|action| js::truthy(Some(action))) else {
        if action_id == "enervation-repeat" {
            return Err(rule("Связь «Обессиливания» больше не существует", "ENERVATION_NOT_ACTIVE"));
        }
        return Err(rule("Это действие недоступно активному герою", "COMBAT_ACTION_NOT_AVAILABLE"));
    };
    assert_mechanics_supported(Some(&action), "действия")?;
    let action_spell = action.get("spell").filter(|spell| js::truthy(Some(spell))).cloned();
    if let Some(spell) = &action_spell {
        assert_spell_components_allowed(state, actor, Some(spell), &Context::default())?;
        assert_bonus_action_spell_allowed(state, &actor_id, spell, Some(&Value::String("reaction".into())))?;
    }
    let is_indomitable = action.get("id").and_then(Value::as_str) == Some("indomitable");
    if !sk_core::game::combat_active(state) && resistance_action.is_none() && !is_indomitable && sk_combat_content::combat_actions::exploration_use_for(Some(&action)) != "allowed" {
        let message = if sk_combat_content::combat_actions::exploration_use_for(Some(&action)) == "opens-combat" { "Сначала нужно начать бой и определить инициативу" } else { "Это действие имеет смысл только в бою, в свой ход" };
        return Err(rule(message, "COMBAT_NOT_ACTIVE"));
    }
    assert_monk_unarmed_action_allowed(state, actor, Some(&action))?;
    let has_death_saves = js::truthy(sk_core::game::mechanics(state).get("death").and_then(|death| death.get("saving_throws")).and_then(|saves| saves.get(&actor_id)));
    if !living(actor) && !(is_indomitable && actor.is_some() && has_death_saves) {
        return Err(rule("Побеждённый участник не может действовать", "ACTOR_DEFEATED"));
    }
    let action_type = action.get("actionType").and_then(Value::as_str);
    if is_indomitable {
        let available = match window {
            Some(window) if js::truthy(Some(window)) => window.get("trigger").and_then(Value::as_str) == Some("failed-saving-throw") && !other_window_actor(window, &v.command) && window_offers(Some(window), Some(&Value::String("indomitable".into())))?,
            _ => false,
        };
        if !available {
            return Err(rule("Сейчас нет проваленного спасброска для Indomitable", "INDOMITABLE_NOT_AVAILABLE"));
        }
        set_field(&mut v.command, "reaction_window", reaction_window.clone().unwrap_or(Value::Null));
    } else if resistance_action.is_some() {
        set_field(&mut v.command, "reaction_window", reaction_window.clone().unwrap_or(Value::Null));
    } else if action_type == Some("reaction") {
        let available = match window {
            Some(window) if js::truthy(Some(window)) => !other_window_actor(window, &v.command) && window_offers(Some(window), action.get("id"))?,
            _ => false,
        };
        if !available {
            return Err(rule("У этой реакции сейчас нет подходящего триггера", "REACTION_NOT_AVAILABLE"));
        }
        set_field(&mut v.command, "reaction_window", reaction_window.clone().unwrap_or(Value::Null));
        if action.get("target").and_then(Value::as_str) == Some("enemy") {
            let source = js::string(window.and_then(|window| window.get("source_actor_id")));
            set_field(&mut v.command, "target_id", Value::String(source));
        }
    }
    let shape = sk_core::game::mechanics(state).get("shapes").and_then(|shapes| shapes.get(&actor_id)).filter(|shape| !shape.is_null()).cloned();
    let effect_kind = at(action.get("effect"), "kind").and_then(Value::as_str).map(str::to_string);
    let mut wild_shape_action: Option<Value> = None;
    if effect_kind.as_deref() == Some("wild_shape") {
        if js::is_true(at(at(shape.as_ref(), "form"), "wild_shape")) {
            wild_shape_action = Some(with_fields(&action, &[("resource", Value::Null), ("actionType", Value::String("bonus_action".into())), ("revert", Value::Bool(true))]));
        } else {
            if js::truthy(shape.as_ref()) {
                return Err(rule("Друид уже в чужом облике: сначала он должен закончиться", "WILD_SHAPE_ALREADY_SHAPED"));
            }
            let Some(form) = sk_combat_content::wild_shape::wild_shape_form_for(actor, v.command.get("form_id")) else {
                return Err(rule("Друиду пока некого принять: Дикий облик — со 2-го уровня", "WILD_SHAPE_NO_FORM"));
            };
            set_field(&mut v.command, "form_id", Value::String(form.id.into()));
            wild_shape_action = Some(with_fields(&action, &[("wild_shape_form", form.to_value())]));
        }
    }
    if effect_kind.as_deref() == Some("ally_attack_reaction") {
        let window = state_window.filter(|window| js::truthy(Some(window)));
        let allowed = match window {
            Some(window) => js::truthy(window.get("pending_protective_reaction")) && js::string(window.get("actor_id")) == js::string(v.command.get("actor_id")) && window_offers(Some(window), action.get("id"))?,
            None => false,
        };
        if !allowed {
            return Err(rule(format!("«{}» — реакция на атаку врага по союзнику: её предлагает окно реакции", js::string(action.get("name"))), "REACTION_TRIGGER_REQUIRED"));
        }
    }
    if effect_kind.as_deref() == Some("wild_shape_heal") {
        if !js::is_true(at(at(shape.as_ref(), "form"), "wild_shape")) {
            return Err(rule("Целебный облик — только в диком облике", "WILD_SHAPE_REQUIRED"));
        }
        let Some(slot) = (1..=5).find(|level| resource_pool(state, &actor_id, &format!("spell_slots_{level}"), 0).current > 0) else {
            return Err(rule("Для целебного облика нужна свободная ячейка заклинаний", "INSUFFICIENT_RESOURCE"));
        };
        wild_shape_action = Some(with_fields(&action, &[("resource", Value::String(format!("spell_slots_{slot}"))), ("heal_slot_level", Value::from(slot))]));
    }
    if js::truthy(action.get("requiresCondition")) && !condition_ids_for(state, &actor_id).contains(&js::string(action.get("requiresCondition"))) {
        let message = if action.get("requiresCondition").and_then(Value::as_str) == Some("raging") { "Бешенство — только в ярости" } else { "Умение сейчас недоступно" };
        return Err(rule(message, "ACTION_CONDITION_REQUIRED"));
    }
    if js::is_true(at(action.get("effect"), "offHand")) {
        let Some(item) = off_hand_weapon_for(actor) else {
            return Err(rule("Для атаки второй рукой нужны лёгкое оружие ближнего боя в обеих руках", "OFFHAND_WEAPON_REQUIRED"));
        };
        let item_id = js::string(item.get("id"));
        let attack_action = sk_core::game::combat(state).get("action_economy").and_then(|economy| economy.get(&actor_id)).and_then(|economy| economy.get("attack_action_id"));
        if !js::truthy(attack_action) {
            return Err(rule("Атака второй рукой — бонусным действием после действия Атака", "OFFHAND_ATTACK_REQUIRES_ATTACK"));
        }
        set_field(&mut v.command, "item_id", Value::String(item_id));
    }
    let chosen = match action.get("id").and_then(Value::as_str) {
        Some("divine-smite") => divine_smite_action_for(state, &mut v.command, &action)?,
        Some("lay-on-hands") => lay_on_hands_action_for(state, &mut v.command, &action)?,
        Some("font-of-magic") => font_of_magic_action_for(state, &mut v.command, &action)?,
        _ => wild_shape_action.clone().unwrap_or_else(|| action.clone()),
    };
    set_field(&mut v.command, "combat_action", chosen.clone());
    if at(action_spell.as_ref(), "id").and_then(Value::as_str) == Some("silvery-barbs") {
        let beneficiary_id = js::string(crate::core::coalesce(&[v.command.get("beneficiary_id"), v.command.get("beneficiaryId"), v.command.get("actor_id")]));
        let beneficiary = sk_core::game::find_actor(state, &beneficiary_id);
        if !living(beneficiary) || sk_core::game::is_enemy_actor(state, &beneficiary_id) != sk_core::game::is_enemy_actor(state, &actor_id) {
            return Err(rule("Искусная острота требует живого союзника для преимущества", "INVALID_REACTION_BENEFICIARY"));
        }
        let distance = distance_between_actors(state, &actor_id, &beneficiary_id);
        if distance.is_none_or(|distance| distance > 60.0) {
            return Err(rule("Союзник находится вне дистанции Искусной остроты", "TARGET_OUT_OF_RANGE"));
        }
        set_field(&mut v.command, "beneficiary_id", Value::String(beneficiary_id));
    }
    if js::truthy(chosen.get("resource")) {
        let pool = resource_pool(state, &actor_id, &js::string(chosen.get("resource")), 0);
        if pool.current < js::safe_int(chosen.get("cost"), 1).max(1) {
            return Err(rule("Недостаточно классового ресурса", "INSUFFICIENT_RESOURCE"));
        }
    }
    if action.get("target").and_then(Value::as_str) != Some("self") {
        check_action_target(v, &action, &actor_id, actor)?;
    }
    Ok(())
}

/// Цель приёма (7724–7766).
fn check_action_target(v: &mut Validation<'_>, action: &Value, actor_id: &str, actor: Option<&Value>) -> Step {
    let state = v.state;
    let target_value = target_for(&v.command);
    let target = sk_core::game::find_actor(state, &js::s(Some(&target_value)));
    let effect = action.get("effect");
    let continuation = at(effect, "kind").and_then(Value::as_str) == Some("enervation-continuation");
    let continuation_matches = continuation && js::string(Some(&target_value)) == js::string(at(effect, "target_id"));
    if continuation && !continuation_matches {
        return Err(rule("«Обессиливание» можно продолжить только по исходной цели", "ENERVATION_TARGET_MISMATCH"));
    }
    let action_id = action.get("id").and_then(Value::as_str);
    let can_target_dying = target.is_some_and(|target| is_dying_hero(state, &sk_core::game::actor_id(target)) && (action_id == Some("stabilize") || at(effect, "kind").and_then(Value::as_str) == Some("heal")));
    let invalid = || rule("Нужна другая допустимая цель действия", "INVALID_COMBAT_ACTION_TARGET");
    if target.is_none() && !continuation_matches {
        return Err(invalid());
    }
    if target.is_some_and(|target| super::common::strict_equal(Some(&Value::String(sk_core::game::actor_id(target))), v.command.get("actor_id"))) {
        return Err(invalid());
    }
    if target.is_some_and(|target| !sk_core::game::is_living_actor(target)) && !can_target_dying && !continuation_matches {
        return Err(invalid());
    }
    if let Some(target) = target {
        let hostile = sk_core::game::is_enemy_actor(state, &sk_core::game::actor_id(target)) != sk_core::game::is_enemy_actor(state, actor_id);
        let kind = action.get("target").and_then(Value::as_str);
        if kind == Some("enemy") && !hostile {
            return Err(rule("Это действие требует противника", "INVALID_COMBAT_ACTION_TARGET"));
        }
        if kind == Some("ally") && hostile {
            return Err(rule("Это действие требует союзника", "INVALID_COMBAT_ACTION_TARGET"));
        }
    }
    if continuation {
        let link = enervation_link_for(state, v.command.get("actor_id"));
        let Some(link) = link.filter(|link| link.target_id == js::string(Some(&target_value))) else {
            return Err(rule("Связь «Обессиливания» больше не существует", "ENERVATION_NOT_ACTIVE"));
        };
        let reason = enervation_continuation_invalid_reason(state, &link).map_or(Value::Null, |reason| Value::String(reason.into()));
        let record = json!({
            "effect_id": link.effect_id,
            "target_id": link.target_id,
            "slot_level": link.slot_level,
            "invalid_reason": reason,
        });
        set_field(&mut v.command, "enervation_continuation", record);
        return Ok(());
    }
    let Some(target) = target else { return Err(invalid()) };
    let target_id = sk_core::game::actor_id(target);
    let from = actor_point(state, actor_id);
    let to = actor_point(state, &target_id);
    if from.is_none() || to.is_none() {
        return Err(rule("Участники должны находиться на карте", "MAP_POSITION_REQUIRED"));
    }
    let requires_weapon = js::truthy(action.get("requiresWeapon"));
    let profile = if requires_weapon && js::truthy(v.command.get("item_id")) {
        item_attack_profile(state, actor, v.command.get("item_id"), AttackOptions::default())
    } else if requires_weapon {
        Some(trusted_attack_profile(state, actor, None)?)
    } else {
        None
    };
    let range = js::number(action.get("range"));
    let maximum = if requires_weapon {
        let weapon_range = match at(profile.as_ref(), "range_feet").filter(|value| !value.is_null()) {
            Some(value) => js::number(Some(value)),
            None => 5.0,
        };
        js::min_of([range, weapon_range])
    } else {
        range
    };
    let distance = distance_between_actor_positions(state, actor_id, from, &target_id, to).unwrap_or(0.0);
    if distance < 5.0 || distance > maximum {
        return Err(rule("Цель находится вне дальности действия", "TARGET_OUT_OF_RANGE"));
    }
    if distance > 5.0 {
        assert_clear_actor_trajectory(state, actor_id, &target_id, from, to, false)?;
    }
    Ok(())
}
