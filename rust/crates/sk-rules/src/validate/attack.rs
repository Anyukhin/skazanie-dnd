//! Блоки `validateCommand`: Атака: легендарное и особое действие монстра, атака оружием, смена оружия, областная атака. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 6703–6705, 6706–6710, 7222–7301, 7302–7316, 7317–7324. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела. Блок 30 (6711–6713, магия
//! стат-блока) — точка входа Р9 (`validate/spell.rs`).

use serde_json::Value;
use sk_core::{game, js};

use super::common::strict_equal;
use super::Validation;
use crate::combat::monsters::validate_legendary_action_command;
use crate::combat::weapons::{combat_item, hero_ammunition_supply, item_attack_profile, trusted_attack_profile, AttackOptions};
use crate::core::{has_equipped_shield, monster_action_for, target_for};
use crate::pause::{rule, Fault, Halt, Step};
use crate::preview_attack::{condition_id_values, preview_monster_action};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// Блок 28 (6703–6705): легендарное действие.
pub fn check_legendary_action(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "UseLegendaryAction" {
        return Ok(());
    }
    let patch = validate_legendary_action_command(&v.command, v.state, v.context)?;
    js::assign(&mut v.command, patch);
    Ok(())
}

/// Блок 29 (6706–6710): особое действие монстра.
pub fn check_monster_action(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "UseMonsterAction" {
        return Ok(());
    }
    if !v.context.is_npc_scheduler() {
        return Err(rule("Особые приёмы существа выбирает только серверный планировщик", "NPC_ACTION_FORBIDDEN"));
    }
    if !game::combat_active(v.state) {
        return Err(rule("Приём требует начатого боя", "COMBAT_NOT_ACTIVE"));
    }
    preview_monster_action(v.state, &js::string(v.command.get("actor_id")), v.command.get("action_id"), v.command.get("to"))?;
    Ok(())
}

/// `value.endsWith(suffix)` / `value.includes(item)` на поле профиля: у не той
/// формы JS бросает `TypeError`.
fn type_error(value: Option<&Value>, method: &str) -> Halt {
    let base = if value.is_some_and(Value::is_null) { "null" } else { "undefined" };
    Fault::type_error(format!("Cannot read properties of {base} (reading '{method}')")).into()
}

/// Блок 66 (7222–7301): атака оружием.
pub fn check_make_attack(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "MakeAttack" {
        return Ok(());
    }
    let state = v.state;
    let command = &v.command;
    let actor_id = js::s(command.get("actor_id"));
    let target_value = target_for(command);
    let target_id = js::s(Some(&target_value));
    let actor = game::find_actor(state, &actor_id);
    let target = game::find_actor(state, &target_id);
    let authoritative_combat = js::truthy(command.get("server_authoritative"))
        || v.context.truthy("serverAuthoritativeCombat")
        || v.context.truthy("isNpcScheduler")
        || game::is_enemy_actor(state, &actor_id)
        || game::is_enemy_actor(state, &target_id);
    if authoritative_combat && !game::combat_active(state) {
        return Err(rule("Сначала нужно начать бой и определить инициативу", "COMBAT_NOT_ACTIVE"));
    }
    let Some(target) = target.filter(|_| !strict_equal(Some(&target_value), command.get("actor_id"))) else {
        return Err(rule("Нужна другая живая цель атаки", "INVALID_ATTACK_TARGET"));
    };
    if sk_combat_content::combat_spells::is_untargetable_summon(Some(target)) {
        return Err(rule("Эту фишку нельзя атаковать: это сила заклинания, а не существо", "INVALID_ATTACK_TARGET"));
    }
    let Some(actor) = actor.filter(|actor| game::is_living_actor(actor)) else {
        return Err(rule("Побеждённый участник не может атаковать", "ACTOR_DEFEATED"));
    };
    if !game::is_living_actor(target) && !crate::targets::is_dying_hero(state, &target_id) {
        return Err(rule("Цель уже побеждена", "TARGET_DEFEATED"));
    }
    let item_id = command.get("item_id");
    let selected_item_profile = if js::truthy(item_id) {
        item_attack_profile(state, Some(actor), item_id, AttackOptions { attack_mode: command.get("attack_mode"), attack_ability: command.get("attack_ability"), off_hand: false })
    } else {
        None
    };
    if js::truthy(item_id) && selected_item_profile.is_none() {
        return Err(rule("Выбранный режим или характеристика оружия недоступны", "INVALID_WEAPON_PROFILE"));
    }
    let attack_profile = match &selected_item_profile {
        Some(profile) => profile.clone(),
        None => trusted_attack_profile(state, Some(actor), command.get("action_id"))?,
    };
    let target_conditions = game::conditions(state, &js::string(Some(&target_value)));
    if !sk_combat_base::monster_actions::monster_attack_target_allowed(Some(&attack_profile), target_conditions, Some(&actor_id)) {
        return Err(rule("Цель не соответствует условиям выбранного приёма", "MONSTER_ACTION_TARGET_CONDITION"));
    }
    if js::truthy(command.get("sneak_attack")) {
        if crate::tables::character_class_key(actor).as_deref() != Some("rogue") {
            return Err(rule("Коварная атака доступна только плуту", "SNEAK_ATTACK_CLASS_REQUIRED"));
        }
        let Some(selected) = &selected_item_profile else {
            return Err(rule("Для Коварной атаки выберите оружие из инвентаря", "SNEAK_ATTACK_WEAPON_REQUIRED"));
        };
        let ranged = match selected.get("weapon_group") {
            Some(Value::String(group)) => group.ends_with("-ranged"),
            other => return Err(type_error(other, "endsWith")),
        };
        let finesse = match selected.get("properties") {
            Some(Value::Array(properties)) => properties.iter().any(|property| property.as_str() == Some("finesse")),
            Some(Value::String(properties)) => properties.contains("finesse"),
            other => return Err(type_error(other, "includes")),
        };
        if !ranged && !finesse {
            return Err(rule("Коварная атака требует дальнобойного оружия или оружия со свойством finesse", "SNEAK_ATTACK_WEAPON_INELIGIBLE"));
        }
    }
    if js::is_true(command.get("knock_out")) && attack_profile.get("kind").and_then(Value::as_str) != Some("melee") {
        return Err(rule("Нокаутировать можно только ближней атакой", "KNOCKOUT_REQUIRES_MELEE_ATTACK"));
    }
    let actor_is_enemy = game::is_enemy_actor(state, &actor_id);
    if js::truthy(command.get("action_id")) && actor_is_enemy {
        let Some(monster_action) = monster_action_for(Some(actor), command.get("action_id")) else {
            return Err(rule("Выбранное действие отсутствует в блоке статистики существа", "MONSTER_ACTION_NOT_AVAILABLE"));
        };
        if !sk_combat_base::monster_actions::monster_action_available(Some(monster_action), &condition_id_values(state, &actor_id)) {
            return Err(rule("Ограниченное действие существа уже использовано", "MONSTER_ACTION_SPENT"));
        }
    }
    // Действие, привязанное к вещи, живёт ровно столько, сколько живёт вещь.
    if actor_is_enemy {
        let declared = js::s(command.get("action_id"));
        let bound = if declared.is_empty() { js::s(at(monster_action_for(Some(actor), None), "id")) } else { declared };
        let unavailable = if bound.is_empty() { None } else { sk_economy::npc_equipment::npc_action_unavailable_reason(Some(actor), Some(&Value::String(bound))) };
        if let Some(reason) = unavailable {
            let message = sk_economy::npc_equipment::NPC_ACTION_UNAVAILABLE_MESSAGES.iter().find(|(key, _)| *key == reason).map_or("", |(_, text)| *text);
            return Err(rule(message, if reason == "weapon-lost" { "NPC_WEAPON_UNAVAILABLE" } else { "NPC_AMMUNITION_SPENT" }));
        }
    }
    // Пустой колчан героя закрывает выстрел до броска и до расхода хода.
    if !actor_is_enemy && selected_item_profile.as_ref().is_some_and(|profile| js::truthy(profile.get("ammunition"))) {
        if let Some(supply) = hero_ammunition_supply(Some(actor), selected_item_profile.as_ref()) {
            if js::number(supply.get("shots_left")) <= 0.0 {
                return Err(rule(format!("Колчан пуст: для этого выстрела нужен боеприпас «{}»", js::string(supply.get("item_name"))), "AMMUNITION_SPENT"));
            }
        }
    }
    let selected = if js::truthy(item_id) { combat_item(Some(actor), &js::string(item_id)) } else { None };
    if selected_item_profile.as_ref().is_some_and(|profile| js::truthy(profile.get("two_handed"))) && has_equipped_shield(Some(actor)) {
        return Err(rule("Двуручное оружие нельзя использовать вместе с надетым щитом", "TWO_HANDED_WITH_SHIELD"));
    }
    let requested = js::string(item_id);
    let inventory = actor.get("inventory").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let other_equipped = inventory.iter().any(|item| item.get("type").and_then(Value::as_str) == Some("weapon") && js::truthy(item.get("equipped")) && js::string(item.get("id")) != requested);
    if selected.is_some_and(|item| item.get("type").and_then(Value::as_str) == Some("weapon") && !js::truthy(item.get("equipped"))) && other_equipped {
        return Err(rule("Сначала уберите экипированное оружие; смена занимает действие", "WEAPON_SWAP_REQUIRED"));
    }
    Ok(())
}

/// Блок 67 (7302–7316): смена оружия.
pub fn check_change_weapon(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "ChangeWeapon" {
        return Ok(());
    }
    let actor = game::find_actor(v.state, &js::s(v.command.get("actor_id")));
    let weapon = combat_item(actor, &js::string(v.command.get("item_id")));
    let Some(weapon) = weapon.filter(|weapon| js::truthy(weapon.get("combat")) && weapon.get("type").and_then(Value::as_str) == Some("weapon")) else {
        return Err(rule("Оружие не найдено в инвентаре", "INVALID_WEAPON"));
    };
    // Вне боя смену запрещает жизненный цикл вещи; в бою двуручное со щитом
    // отказывается до расхода действия, тем же кодом, что у атаки.
    let catalog_id = js::s(crate::core::coalesce(&[weapon.get("catalog_id"), weapon.get("catalogId")]));
    let combat = match crate::tables::catalog_item(&catalog_id).and_then(|entry| entry.get("combat")).filter(|value| !value.is_null()) {
        Some(combat) => Some(combat),
        None => weapon.get("combat"),
    };
    let modes: Vec<Option<&Value>> = match at(combat, "modes") {
        Some(Value::Array(modes)) if !modes.is_empty() => modes.iter().map(Some).collect(),
        _ => vec![combat],
    };
    if modes.iter().all(|mode| js::is_true(at(*mode, "twoHanded"))) && has_equipped_shield(actor) {
        return Err(rule("Двуручное оружие не взять в бою, пока надет щит: щит снимают вне боя", "TWO_HANDED_WITH_SHIELD"));
    }
    Ok(())
}

/// Блок 68 (7317–7324): областная атака предметом.
pub fn check_make_area_attack(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "MakeAreaAttack" {
        return Ok(());
    }
    let actor = game::find_actor(v.state, &js::s(v.command.get("actor_id")));
    let item = combat_item(actor, &js::string(v.command.get("item_id")));
    if at(at(item, "combat"), "kind").and_then(Value::as_str) != Some("thrown-area") {
        return Err(rule("Метательный предмет недоступен", "INVALID_THROWABLE"));
    }
    let to = v.command.get("to");
    let x = js::number(at(to, "x"));
    let y = js::number(at(to, "y"));
    let safe = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
    if !safe(x) || !safe(y) {
        return Err(rule("Нужна клетка броска", "INVALID_DESTINATION"));
    }
    let cells = crate::tactical_geometry::tactical_cell_map(v.state);
    let cell = cells.get(&crate::tactical_geometry::key(x, y));
    if cell.is_none_or(|cell| js::is_false(cell.get("revealed")) || cell.get("type").and_then(Value::as_str) == Some("wall")) {
        return Err(rule("В эту клетку нельзя бросить предмет", "INVALID_DESTINATION"));
    }
    Ok(())
}
