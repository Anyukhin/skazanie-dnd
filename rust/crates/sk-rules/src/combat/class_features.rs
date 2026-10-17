//! Умения классов: монах, боевой стиль, вдохновение, кара, Font of Magic, Lay on Hands, скрытая атака. Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 586–595 (маркеры монаха), 3188–3238,
//! 3359–3401, 3429–3526, 5494–5503 (`assertMonkUnarmedActionAllowed`),
//! 9516–9534, 9620.
//!
//! Маркеры контекста на `Symbol` (удар монаха бонусным действием, кара) —
//! типизированные поля [`crate::context::Context`]; здесь — проверки по ним.
//! Функции, которые в JS дописывают команду (`command.slot_level = …`),
//! принимают её как `&mut Value`.

use serde_json::{json, Value};
use sk_core::{game, js, text};

use crate::combat::weapons::{inventory_of, item_attack_profile, AttackOptions};
use crate::conditions::{at, at_path};
use crate::context::Context;
use crate::core::{ability_modifier, armor_restrictions, coalesce, dice_expression, has_equipped_shield, resource_pool, string_of, target_for};
use crate::pause::{rule, Halt, Step};

/// `MONK_BONUS_UNARMED_ACTION_IDS`: безоружные удары монаха бонусным действием.
pub const MONK_BONUS_UNARMED_ACTION_IDS: [&str; 3] = ["martial-arts-strike", "flurry-of-blows", "monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni"];

/// `FONT_OF_MAGIC_SLOT_COST`: цена ячейки 1–5 круга в чародейских очках.
pub const FONT_OF_MAGIC_SLOT_COST: [i64; 5] = [2, 3, 5, 6, 7];

fn font_cost(level: i64) -> i64 {
    FONT_OF_MAGIC_SLOT_COST.get((level - 1) as usize).copied().unwrap_or(0)
}

/// Ключ свойства JS (`obj[x]` → `String(x)`).
fn key(value: Option<&Value>) -> String {
    js::string(value)
}

fn set(command: &mut Value, field: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(field.into(), value);
    }
}

/// `isMonkBonusAttackContext(context)`.
pub fn is_monk_bonus_attack_context(context: &Context) -> bool {
    context.monk_bonus_attack
}

/// `monkMartialArtsAttackProfile(actor)` (3192–3238): безоружный удар монаха.
pub fn monk_martial_arts_attack_profile(actor: Option<&Value>) -> Result<Value, Halt> {
    let level = js::safe_int(at(actor, "level"), 1).max(1);
    let die = if level >= 11 {
        8
    } else if level >= 5 {
        6
    } else {
        4
    };
    let strength = ability_modifier(at_path(actor, &["abilities", "str"]));
    let proficiency = js::safe_int(at(actor, "proficiency"), 0).max(0);
    let unarmored = armor_restrictions(actor).is_empty() && !has_equipped_shield(actor);
    if !unarmored {
        return Ok(json!({
            "id": "monk-unarmed-strike",
            "name": "Безоружный удар",
            "kind": "melee",
            "modifier": strength + proficiency,
            "damage_expression": null,
            "damage_amount": (1 + strength).max(0),
            "damage_type": "bludgeoning",
            "range_feet": 5,
            "normal_range_feet": 5,
            "advantage": false,
            "disadvantage": false,
            "on_hit": null,
            "uses": 0,
            "recharge": 0,
            "tactical_priority": 0,
        }));
    }
    let ability = strength.max(ability_modifier(at_path(actor, &["abilities", "dex"])));
    Ok(json!({
        "id": "monk-unarmed-strike",
        "name": "Безоружный удар монаха",
        "kind": "melee",
        "modifier": ability + proficiency,
        "damage_expression": dice_expression(Some(&Value::String(format!("1d{die}"))), Some(&Value::from(ability)), die)?,
        "damage_amount": null,
        "damage_type": "bludgeoning",
        "range_feet": 5,
        "normal_range_feet": 5,
        "advantage": false,
        "disadvantage": false,
        "on_hit": null,
        "uses": 0,
        "recharge": 0,
        "tactical_priority": 0,
    }))
}

/// Итог `weaponFightingStyleBonus`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FightingStyleBonus {
    pub attack_bonus: i64,
    pub damage_bonus: i64,
    pub great_weapon_fighting: bool,
    pub ids: Vec<String>,
}

impl FightingStyleBonus {
    pub fn to_value(&self) -> Value {
        json!({ "attack_bonus": self.attack_bonus, "damage_bonus": self.damage_bonus, "great_weapon_fighting": self.great_weapon_fighting, "ids": self.ids })
    }
}

/// `weaponFightingStyleBonus(actor, item, mode, properties)` (3359–3392):
/// «Стрельба», «Дуэлянт», «Метательное оружие», «Большое оружие».
pub fn weapon_fighting_style_bonus(actor: Option<&Value>, item: Option<&Value>, mode: &Value, properties: &[String]) -> FightingStyleBonus {
    let styles: Vec<String> = sk_ruleset::character_progression::normalized_selected_feature_ids(actor).into_iter().filter(|id| id.starts_with("fighting-style-")).collect();
    let mut result = FightingStyleBonus::default();
    if styles.is_empty() {
        return result;
    }
    let has = |id: &str| styles.iter().any(|style| style == id);
    let kind = mode.get("kind").and_then(Value::as_str);
    let melee = kind == Some("melee");
    let thrown = js::is_true(mode.get("thrown"));
    let two_hands = js::is_true(mode.get("twoHanded")) || properties.iter().any(|property| property == "two-handed");
    if has("fighting-style-archery") && kind == Some("ranged") && !thrown {
        result.attack_bonus += 2;
        result.ids.push("fighting-style-archery".into());
    }
    let item_id = js::string(at(item, "id"));
    let other_weapon_held = inventory_of(actor).iter().any(|candidate| {
        js::is_true(candidate.get("equipped"))
            && js::string(candidate.get("id")) != item_id
            && (candidate.get("type").and_then(Value::as_str) == Some("weapon") || {
                let catalog = sk_items::item_catalog::catalog_item(&js::s(coalesce(&[candidate.get("catalog_id"), candidate.get("catalogId")])));
                let combat_kind = js::s(at_path(catalog, &["combat", "kind"]));
                combat_kind == "melee" || combat_kind == "ranged"
            })
    });
    if has("fighting-style-dueling") && melee && !two_hands && !other_weapon_held {
        result.damage_bonus += 2;
        result.ids.push("fighting-style-dueling".into());
    }
    if has("fighting-style-thrown") && thrown {
        result.damage_bonus += 2;
        result.ids.push("fighting-style-thrown".into());
    }
    if has("fighting-style-great-weapon") && melee && two_hands {
        result.great_weapon_fighting = true;
        result.ids.push("fighting-style-great-weapon".into());
    }
    result
}

/// Вдохновение барда на существе (`bardicInspirationFor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BardicInspiration {
    pub sides: i64,
    pub source_actor: String,
}

impl BardicInspiration {
    pub fn to_value(&self) -> Value {
        json!({ "sides": self.sides, "source_actor": self.source_actor })
    }
}

/// `String(condition?.id ?? condition)`.
fn condition_name(condition: &Value) -> String {
    match at(Some(condition), "id").filter(|id| !id.is_null()) {
        Some(id) => string_of(id),
        None => string_of(condition),
    }
}

/// `bardicInspirationFor(state, actorId)` (3394–3401): кость по уровню
/// давшего вдохновение барда; `None` — вдохновения нет.
pub fn bardic_inspiration_for(state: &Value, actor_id: &str) -> Option<BardicInspiration> {
    let condition = game::conditions(state, actor_id).iter().find(|entry| condition_name(entry) == "bardic-inspiration")?;
    let source = js::s(at(Some(condition), "source_actor"));
    let bard = game::find_actor(state, &source);
    Some(BardicInspiration { sides: bardic_inspiration_die_sides(bard), source_actor: source })
}

/// `bardicInspirationDieSides(bard)` (9620): к6, с 5-го к8, с 10-го к10, с 15-го к12.
pub fn bardic_inspiration_die_sides(bard: Option<&Value>) -> i64 {
    let level = js::safe_int(at(bard, "level"), 1);
    if level >= 15 {
        12
    } else if level >= 10 {
        10
    } else if level >= 5 {
        8
    } else {
        6
    }
}

/// `divineSmiteActionFor(state, command, action)` (3429–3443): ячейка кары;
/// дописывает `command.slot_level`.
pub fn divine_smite_action_for(state: &Value, command: &mut Value, action: &Value) -> Result<Value, Halt> {
    let actor_id = command.get("actor_id").cloned();
    let actor = game::find_actor(state, &js::s(actor_id.as_ref()));
    if js::truthy(command.get("item_id")) {
        let profile = item_attack_profile(state, actor, command.get("item_id"), AttackOptions { attack_mode: command.get("attack_mode"), ..AttackOptions::default() });
        if profile.as_ref().is_some_and(|profile| profile.get("kind").and_then(Value::as_str) != Some("melee")) {
            return Err(rule("Божественная кара — только при атаке оружием ближнего боя", "DIVINE_SMITE_MELEE_ONLY"));
        }
    }
    let actor_key = key(actor_id.as_ref());
    let available: Vec<i64> = (1..=5).filter(|level| resource_pool(state, &actor_key, &format!("spell_slots_{level}"), 0).current > 0).collect();
    let requested = js::safe_int(command.get("slot_level"), 0);
    if requested != 0 && !available.contains(&requested) {
        return Err(rule(format!("Ячейки {requested}-го круга для кары нет"), "SPELL_SLOT_UNAVAILABLE"));
    }
    let slot = if requested != 0 { requested } else { available.first().copied().unwrap_or(0) };
    if slot == 0 {
        return Err(rule("Для Божественной кары нужна свободная ячейка заклинаний", "INSUFFICIENT_RESOURCE"));
    }
    set(command, "slot_level", Value::from(slot));
    Ok(js::spread(action, json!({ "resource": format!("spell_slots_{slot}"), "smite_slot_level": slot })))
}

/// `fontOfMagicActionFor(state, command, action)` (3456–3483): «Источник
/// магии» — ячейка из очков или очки из ячейки; дописывает `font_mode` и
/// `slot_level`.
pub fn font_of_magic_action_for(state: &Value, command: &mut Value, action: &Value) -> Result<Value, Halt> {
    let actor_key = key(command.get("actor_id"));
    let points = resource_pool(state, &actor_key, "sorcery_points", 0);
    let slots: Vec<(i64, crate::core::Pool)> = (1..=5).map(|level| (level, resource_pool(state, &actor_key, &format!("spell_slots_{level}"), 0))).filter(|(_, pool)| pool.max > 0).collect();
    let requested = js::safe_int(command.get("slot_level"), 0);
    let mode = match command.get("font_mode").and_then(Value::as_str) {
        Some(mode @ ("convert" | "create")) => Some(mode.to_string()),
        _ => None,
    };
    let creatable: Vec<i64> = slots.iter().filter(|(level, pool)| pool.current < pool.max && points.current >= font_cost(*level)).map(|(level, _)| *level).collect();
    let convertible: Vec<i64> = if points.current < points.max { slots.iter().filter(|(_, pool)| pool.current > 0).map(|(level, _)| *level).collect() } else { Vec::new() };
    let pick = |list: &[i64]| if requested != 0 { list.iter().copied().find(|level| *level == requested) } else { list.first().copied() };
    let create = if mode.as_deref() == Some("convert") { None } else { pick(&creatable) };
    let convert = if create.is_some() || mode.as_deref() == Some("create") { None } else { pick(&convertible) };
    if let Some(level) = create {
        set(command, "font_mode", Value::String("create".into()));
        set(command, "slot_level", Value::from(level));
        return Ok(js::spread(
            action,
            json!({ "resource": "sorcery_points", "cost": font_cost(level), "effect": { "kind": "restore_resource", "resource": format!("spell_slots_{level}"), "amount": 1 } }),
        ));
    }
    if let Some(level) = convert {
        set(command, "font_mode", Value::String("convert".into()));
        set(command, "slot_level", Value::from(level));
        return Ok(js::spread(
            action,
            json!({ "resource": format!("spell_slots_{level}"), "cost": 1, "effect": { "kind": "restore_resource", "resource": "sorcery_points", "amount": level } }),
        ));
    }
    if mode.as_deref() == Some("convert") || (mode.is_none() && points.current >= points.max) {
        let message = if points.current >= points.max { "Чародейские очки и так полны" } else { "Нет свободной ячейки, которую можно перевести в очки" };
        return Err(rule(message, "FONT_OF_MAGIC_NOTHING_TO_CONVERT"));
    }
    let message = if requested != 0 { format!("Ячейку {requested}-го круга сейчас не создать: запас полон или не хватает очков") } else { "Все ячейки полны или не хватает чародейских очков".into() };
    Err(rule(message, "FONT_OF_MAGIC_NOTHING_TO_CREATE"))
}

/// `layOnHandsActionFor(state, command, action)` (3492–3502): из запаса —
/// названная сумма или недостающие цели хиты; дописывает `command.amount`.
pub fn lay_on_hands_action_for(state: &Value, command: &mut Value, action: &Value) -> Result<Value, Halt> {
    let pool = resource_pool(state, &key(command.get("actor_id")), &key(action.get("resource")), 0);
    let target = game::find_actor(state, &js::s(Some(&target_for(command))));
    let missing = target.map_or(0, |target| (game::actor_max_hp(target) - game::actor_hp(target)).max(0));
    let requested = js::safe_int(command.get("amount"), 0);
    let amount = pool.current.max(0).min(if requested > 0 { requested } else { missing.max(1) });
    if amount < 1 {
        return Err(rule("Запас Наложения рук пуст", "INSUFFICIENT_RESOURCE"));
    }
    set(command, "amount", Value::from(amount));
    let effect = js::spread(&action.get("effect").map(|effect| Value::Object(crate::core::spread_value(Some(effect)))).unwrap_or_else(js::obj), json!({ "amount": amount }));
    Ok(js::spread(action, json!({ "cost": amount, "effect": effect })))
}

/// `colossusSlayerReady(state, actor, target)` (3512–3519): «Убийца колоссов»
/// следопыта-Охотника, раз в ход по раненой цели.
pub fn colossus_slayer_ready(state: &Value, actor: Option<&Value>, target: Option<&Value>) -> bool {
    let (Some(actor_value), Some(target)) = (actor, target) else { return false };
    let actor_key = game::actor_id(actor_value);
    if game::is_enemy_actor(state, &actor_key) || crate::tables::character_class_key(actor_value).as_deref() != Some("ranger") || js::safe_int(at(actor, "level"), 1) < 3 {
        return false;
    }
    let subclass = sk_combat_content::combat_actions::normalized_combat_subclass_for(actor).unwrap_or_default();
    if !text::test(sk_core::re!(r"охотник|hunter", "iu"), &subclass) {
        return false;
    }
    if game::actor_hp(target) >= game::actor_max_hp(target) {
        return false;
    }
    let Some(turn_key) = crate::turn_economy::combat_turn_key(state, &actor_key) else { return true };
    let stored = js::s(at_path(Some(game::combat(state)), &["action_economy", &actor_key, "colossus_slayer_turn_key"]));
    stored != turn_key
}

/// `sneakAttackDiceCount(actor)` (9516): половина уровня вверх, 1–6 костей.
pub fn sneak_attack_dice_count(actor: Option<&Value>) -> i64 {
    let level = js::safe_int(at(actor, "level"), 1).clamp(1, 12);
    (level + 1) / 2
}

/// `sneakAttackSupportingAlly(state, attackerId, targetId)` (9520–9534): союзник
/// атакующего в 5 футах от цели, дееспособный.
pub fn sneak_attack_supporting_ally<'a>(state: &'a Value, attacker_id: &str, target_id: &str) -> Option<&'a Value> {
    let attacker_is_enemy = game::is_enemy_actor(state, attacker_id);
    let target_is_enemy = game::is_enemy_actor(state, target_id);
    if attacker_is_enemy == target_is_enemy {
        return None;
    }
    let target_at = game::actor_position(state, target_id)?;
    let target = game::find_actor(state, target_id);
    let target_anchor = json!({ "x": target_at.x, "y": target_at.y });
    game::list_actors(state).into_iter().find(|candidate| {
        let id = game::actor_id(candidate);
        if id.is_empty() || id == attacker_id || id == target_id {
            return false;
        }
        let candidate_enemy = game::is_enemy_actor(state, &id);
        if candidate_enemy != attacker_is_enemy || candidate_enemy == target_is_enemy {
            return false;
        }
        if !game::is_living_actor(candidate) || crate::core::incapacitating_condition_for(state, &id).is_some() {
            return false;
        }
        let Some(at) = game::actor_position(state, &id) else { return false };
        let anchor = json!({ "x": at.x, "y": at.y });
        // `null <= 5` в JS истинно: без площади союзник считается рядом.
        sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), target, Some(&anchor), Some(&target_anchor)).is_none_or(|distance| distance <= 5.0)
    })
}

/// `assertMonkUnarmedActionAllowed(state, actor, action)` (5494–5503).
pub fn assert_monk_unarmed_action_allowed(state: &Value, actor: Option<&Value>, action: Option<&Value>) -> Step {
    let action_id = js::s(at(action, "id"));
    if !MONK_BONUS_UNARMED_ACTION_IDS.contains(&action_id.as_str()) {
        return Ok(());
    }
    let actor_key = actor.map(game::actor_id).unwrap_or_default();
    let economy = at_path(Some(game::combat(state)), &["action_economy", &actor_key]);
    if js::safe_int(at(economy, "attacks_used"), 0).max(0) < 1 {
        return Err(rule("Безоружный удар монаха бонусным действием доступен после действия «Атака»", "MONK_ATTACK_ACTION_REQUIRED"));
    }
    if at(action, "id").and_then(Value::as_str) == Some("martial-arts-strike") && (!armor_restrictions(actor).is_empty() || has_equipped_shield(actor)) {
        return Err(rule("Боевые искусства монаха требуют отсутствия доспеха и щита", "MONK_MARTIAL_ARTS_REQUIRES_UNARMORED"));
    }
    Ok(())
}
