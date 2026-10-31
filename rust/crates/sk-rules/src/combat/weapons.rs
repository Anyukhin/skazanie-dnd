//! Оружие и атака: профиль атаки, критический порог, вторая рука, боеприпасы, броня. Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 3130–3400 (кроме 3188–3192, 3359, 3394), 3527–3684, 3696–3738, 3917, 4005–4033, 4266–4290, 4532, 7961, 8962–8990.
//!
//! Профили атаки — JSON той же формы, что объекты JS (`itemAttackProfile`,
//! `trustedAttackProfile`): их раскладывают дальше (`{ ...profile }`) и
//! кладут в события, порядок ключей совпадает. Поле `item` профиля
//! предмета — копия записи инвентаря (в JS — ссылка на неё).

use serde_json::{json, Map, Value};
use sk_core::{game, js, text};
use sk_items::item_catalog::{ammunition_bundle_amount, ammunition_catalog_id_for_weapon, ammunition_shots_left, catalog_item, off_hand_weapon_allowed};

use crate::combat::class_features::weapon_fighting_style_bonus;
use crate::command::rules::rule_ids;
use crate::conditions::{at, at_path};
use crate::core::{ability_modifier, coalesce, command_with_rules, dice_expression, event_from, monster_action_for, string_of, unique_string_list, unique_strings};
use crate::dice_record::RulesDice;
use crate::pause::{rule, Halt};
use crate::targets::creature_height_feet;

/// `SHILLELAGH_CONDITION`.
pub const SHILLELAGH_CONDITION: &str = "shillelagh";
/// `SHILLELAGH_WEAPON_KEYS`.
pub const SHILLELAGH_WEAPON_KEYS: [&str; 2] = ["club", "quarterstaff"];
/// `MAGICAL_WEAPON_CONDITIONS`.
pub const MAGICAL_WEAPON_CONDITIONS: [&str; 6] = ["magic-weapon", "elemental-weapon", "elemental-weapon-2", "elemental-weapon-3", "holy-weapon", "sacred-weapon"];

const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

/// `Array.isArray(value) ? value : []`.
pub(crate) fn array_of(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `actor?.inventory` массивом.
pub(crate) fn inventory_of(actor: Option<&Value>) -> &[Value] {
    array_of(at(actor, "inventory"))
}

/// `value && typeof value === 'object'` (массив — тоже объект).
fn object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `value?.[key]` и для массива (у массива именованных полей нет, кроме индексов).
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().filter(|_| js::is_array_index_key(key)).and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `String(x).slice(0, n)` по единицам UTF-16.
fn sliced(value: &str, limit: usize) -> String {
    crate::core::slice_utf16(value, limit)
}

/// `Math.max(lo, Math.min(hi, value))` для целого.
fn clamp_i(value: i64, lo: i64, hi: i64) -> i64 {
    value.min(hi).max(lo)
}

/// `rechargeMinimumOf(profile)` — `monsterRechargeMinimum`.
pub fn recharge_minimum_of(profile: Option<&Value>) -> i64 {
    sk_combat_base::monster_actions::monster_recharge_minimum(profile)
}

/// `trustedAttackProfile(state, actor, actionId = null)` (3130–3186):
/// серверный профиль атаки существа или безоружного героя.
pub fn trusted_attack_profile(state: &Value, actor: Option<&Value>, action_id: Option<&Value>) -> Result<Value, Halt> {
    let monster_action = monster_action_for(actor, action_id);
    let empty = Value::Object(Map::new());
    let profile: &Value = if js::truthy(monster_action) && object_like(monster_action) {
        monster_action.unwrap_or(&empty)
    } else if js::truthy(at(actor, "attack_profile")) && object_like(at(actor, "attack_profile")) {
        at(actor, "attack_profile").unwrap_or(&empty)
    } else if js::truthy(at(actor, "attackProfile")) && object_like(at(actor, "attackProfile")) {
        at(actor, "attackProfile").unwrap_or(&empty)
    } else {
        &empty
    };
    let p = |key: &str| field(Some(profile), key);
    let enemy = game::is_enemy_actor(state, &actor.map(game::actor_id).unwrap_or_default());
    let strength = ability_modifier(at_path(actor, &["abilities", "str"]));
    let fallback_modifier = strength + js::safe_int(at(actor, "proficiency"), 0).max(0);
    let explicit_modifier = coalesce(&[p("attack_modifier"), p("attackModifier")]).or_else(|| at(actor, "attackBonus"));
    let modifier = if js::is_safe_integer_number(explicit_modifier) { js::number(explicit_modifier) as i64 } else { fallback_modifier };
    let damage_dice = coalesce(&[p("damage_dice"), p("damageDice")]).or_else(|| at(actor, "damageDice"));
    let damage_bonus = coalesce(&[p("damage_bonus"), p("damageBonus")]).or_else(|| at(actor, "damageBonus"));
    let damage_expression = coalesce(&[p("damage_expression"), p("damageExpression")]).or_else(|| at(actor, "damageExpression"));
    let explicit_flat = coalesce(&[p("damage_amount"), p("damageAmount")]);
    let bonus_or_strength = || if js::is_safe_integer_number(damage_bonus) { Value::from(js::number(damage_bonus) as i64) } else { Value::from(strength) };
    let mut expression: Value = Value::Null;
    let mut flat_damage = Value::Null;
    let mut unarmed_strike = false;
    if js::is_finite_number(explicit_flat) {
        flat_damage = Value::from(js::safe_int(explicit_flat, 0).max(0));
    } else if js::truthy(damage_expression) {
        expression = match sk_dice::parse_dice_expression(&js::s(damage_expression)) {
            Ok(parsed) => Value::String(parsed.canonical),
            Err(_) => Value::String(dice_expression(damage_dice, Some(&bonus_or_strength()), if enemy { 6 } else { 1 })?),
        };
    } else if !enemy && !js::is_safe_integer_number(damage_dice) {
        // Безоружный удар героя: 1 + модификатор Силы, дробящий урон.
        flat_damage = Value::from((1 + strength).max(0));
        unarmed_strike = true;
    } else {
        expression = Value::String(dice_expression(damage_dice, Some(&bonus_or_strength()), 6)?);
    }
    let range_source = coalesce(&[p("range_feet"), p("rangeFeet"), p("range")]).or_else(|| coalesce(&[at(actor, "attackRange"), at(actor, "rangeFeet")]));
    let range = js::safe_int(range_source, 5);
    let id = match p("id") {
        None | Some(Value::Null) => Value::Null,
        Some(id) => Value::String(sliced(&string_of(id), 120)),
    };
    let name_source = p("name").filter(|value| !value.is_null()).or_else(|| at(actor, "name").filter(|value| !value.is_null()));
    let name = match name_source {
        Some(name) => sliced(&string_of(name), 120),
        None => "Атака".into(),
    };
    let damage_type_source = coalesce(&[p("damage_type"), p("damageType")]).or_else(|| at(actor, "damageType").filter(|value| !value.is_null()));
    let damage_type = match damage_type_source {
        Some(kind) => sliced(&string_of(kind), 40),
        None => (if unarmed_strike { "bludgeoning" } else { "slashing" }).into(),
    };
    let normal_range = {
        let raw = coalesce(&[p("normal_range_feet"), p("normalRangeFeet")]);
        if js::is_safe_integer_number(raw) { js::number(raw) as i64 } else { range }
    };
    let advantage = js::truthy(p("advantage").filter(|value| !value.is_null()).or_else(|| at(actor, "attackAdvantage")));
    let disadvantage = js::truthy(p("disadvantage").filter(|value| !value.is_null()).or_else(|| at(actor, "attackDisadvantage")));
    let on_hit = match p("on_hit") {
        Some(value) if js::truthy(Some(value)) && object_like(Some(value)) => value.clone(),
        _ => Value::Null,
    };
    let mut out = Map::new();
    out.insert("id".into(), id);
    out.insert("name".into(), Value::String(name));
    out.insert("kind".into(), Value::String((if p("kind").and_then(Value::as_str) == Some("ranged") { "ranged" } else { "melee" }).into()));
    out.insert("modifier".into(), Value::from(clamp_i(modifier, -100, 100)));
    out.insert("damage_expression".into(), expression);
    out.insert("damage_amount".into(), flat_damage);
    out.insert("damage_type".into(), Value::String(damage_type));
    out.insert("range_feet".into(), Value::from(clamp_i(range, 5, 600)));
    out.insert("normal_range_feet".into(), Value::from(clamp_i(normal_range, 5, 600)));
    out.insert("advantage".into(), Value::Bool(advantage));
    out.insert("disadvantage".into(), Value::Bool(disadvantage));
    out.insert("on_hit".into(), on_hit);
    out.insert("uses".into(), Value::from(js::safe_int(p("uses"), 0).max(0)));
    out.insert("recharge".into(), Value::from(recharge_minimum_of(Some(profile))));
    out.insert("recharge_group".into(), p("recharge_group").cloned().unwrap_or(Value::Null));
    out.insert("tactical_priority".into(), Value::from(js::safe_int(p("tactical_priority"), 0)));
    out.insert("target_condition".into(), p("target_condition").cloned().unwrap_or(Value::Null));
    out.insert("target_any_conditions".into(), p("target_any_conditions").cloned().unwrap_or(Value::Null));
    Ok(Value::Object(out))
}

/// `combatItem(actor, itemId)`: вещь инвентаря с этим id и количеством больше нуля.
pub fn combat_item<'a>(actor: Option<&'a Value>, item_id: &str) -> Option<&'a Value> {
    inventory_of(actor).iter().find(|item| js::string(at(Some(item), "id")) == item_id && quantity_positive(item))
}

/// `Number(item?.quantity ?? 1) > 0`.
fn quantity_positive(item: &Value) -> bool {
    let quantity = at(Some(item), "quantity").filter(|value| !value.is_null());
    match quantity {
        None => true,
        Some(value) => js::number(Some(value)) > 0.0,
    }
}

/// `itemInstanceKey(item)`: `item_instance_id ?? itemInstanceId ?? id`.
pub fn item_instance_key(item: Option<&Value>) -> String {
    js::s(coalesce(&[at(item, "item_instance_id"), at(item, "itemInstanceId"), at(item, "id")]))
}

/// `combatItemForCommand(actor, itemId)`: по id вещи, затем по экземпляру.
pub fn combat_item_for_command<'a>(actor: Option<&'a Value>, item_id: Option<&Value>) -> Option<&'a Value> {
    let requested = js::s(item_id);
    combat_item(actor, &requested).or_else(|| inventory_of(actor).iter().find(|item| item_instance_key(Some(item)) == requested && quantity_positive(item)))
}

/// `weaponCatalogKey(item)`: последний сегмент `catalog_id` в нижнем регистре.
pub fn weapon_catalog_key(item: Option<&Value>) -> String {
    let id = js::s(coalesce(&[at(item, "catalog_id"), at(item, "catalogId"), at(item, "id")]));
    text::lower(id.split(':').next_back().unwrap_or(""))
}

fn conditions_of<'a>(state: &'a Value, id: &str) -> &'a [Value] {
    game::conditions(state, id)
}

/// `String(condition?.id ?? condition)`.
fn condition_name(condition: &Value) -> String {
    match at(Some(condition), "id").filter(|id| !id.is_null()) {
        Some(id) => string_of(id),
        None => string_of(condition),
    }
}

/// `shillelaghConditionFor(state, actorId, item)`.
pub fn shillelagh_condition_for<'a>(state: &'a Value, actor_id: &str, item: Option<&Value>) -> Option<&'a Value> {
    let item_key = item_instance_key(item);
    if item_key.is_empty() || !SHILLELAGH_WEAPON_KEYS.contains(&weapon_catalog_key(item).as_str()) {
        return None;
    }
    conditions_of(state, actor_id).iter().find(|condition| condition_name(condition) == SHILLELAGH_CONDITION && js::s(at(Some(condition), "source_item_id")) == item_key)
}

/// `shillelaghConditionsFor(state, actorId, itemKey = null)`.
pub fn shillelagh_conditions_for<'a>(state: &'a Value, actor_id: &str, item_key: Option<&str>) -> Vec<&'a Value> {
    conditions_of(state, actor_id)
        .iter()
        .filter(|condition| condition_name(condition) == SHILLELAGH_CONDITION && item_key.is_none_or(|key| js::s(at(Some(condition), "source_item_id")) == key))
        .collect()
}

/// Параметры `shillelaghRemovalEvents`.
#[derive(Debug, Clone, Default)]
pub struct ShillelaghRemoval<'a> {
    pub item_key: Option<&'a str>,
    pub exclude_item_key: Option<&'a str>,
    /// `reason = 'weapon-released'`.
    pub reason: Option<&'a str>,
}

/// `shillelaghRemovalEvents(state, command, { itemKey, excludeItemKey, reason })`.
pub fn shillelagh_removal_events(state: &Value, command: &Value, options: ShillelaghRemoval<'_>) -> Vec<Value> {
    let actor_id = js::s(command.get("actor_id"));
    let reason = options.reason.unwrap_or("weapon-released");
    let source_command = command_with_rules(command, &[rule_ids::CONDITIONS]);
    let targets = json!([actor_id]);
    shillelagh_conditions_for(state, &actor_id, None)
        .into_iter()
        // `String(condition.source_item_id ?? '')`: строковое состояние без полей — пустой ключ.
        .filter(|condition| options.item_key.is_none_or(|key| js::s(at(Some(condition), "source_item_id")) == key))
        .filter(|condition| options.exclude_item_key.is_none_or(|key| js::s(at(Some(condition), "source_item_id")) != key))
        .map(|condition| {
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String(SHILLELAGH_CONDITION.into()));
            if let Some(effect_id) = at(Some(condition), "effect_id").filter(|value| js::truthy(Some(value))) {
                payload.insert("effect_id".into(), effect_id.clone());
            }
            if let Some(source) = at(Some(condition), "source_item_id").filter(|value| js::truthy(Some(value))) {
                payload.insert("source_item_id".into(), source.clone());
            }
            payload.insert("trigger".into(), Value::String(reason.into()));
            event_from(&source_command, "ConditionRemoved", Some(Value::Object(payload)), Some(&targets))
        })
        .collect()
}

/// `shillelaghWeaponFor(item)`: дубинка или посох-оружие.
pub fn shillelagh_weapon_for(item: Option<&Value>) -> Option<&Value> {
    (at(item, "type").and_then(Value::as_str) == Some("weapon") && SHILLELAGH_WEAPON_KEYS.contains(&weapon_catalog_key(item).as_str())).then_some(item).flatten()
}

/// `magicalWeaponConditionFor(state, actorId)`.
pub fn magical_weapon_condition_for(state: &Value, actor_id: &str) -> bool {
    conditions_of(state, actor_id).iter().any(|condition| MAGICAL_WEAPON_CONDITIONS.contains(&condition_name(condition).as_str()))
}

/// `monsterWeaponAttacksMagical(actor)`.
pub fn monster_weapon_attacks_magical(actor: Option<&Value>) -> bool {
    array_of(at(actor, "traits")).iter().any(|entry| js::is_true(at_path(Some(entry), &["mechanics", "weapon_attacks_magical"])))
}

/// `[...a, ...b]` пассивных эффектов: какой-то из них делает атаки магическими.
fn passive_magical(lists: &[Option<&Value>]) -> bool {
    lists.iter().flat_map(|list| array_of(*list)).any(|effect| js::is_true(at(Some(effect), "attacks_are_magical")) || js::is_true(at(Some(effect), "weapon_attacks_magical")))
}

/// `weaponDamageSourceFor(state, actor, profile, selectedProfile, npcBinding)`:
/// источник урона оружием для защит цели (`{ kind, magical, properties }`).
pub fn weapon_damage_source_for(state: &Value, actor: Option<&Value>, profile: Option<&Value>, selected_profile: Option<&Value>, npc_binding: Option<&Value>) -> Option<Value> {
    if !js::truthy(at(profile, "kind")) {
        return None;
    }
    let item = at(selected_profile, "item");
    let catalog_id = coalesce(&[at(item, "catalog_id"), at(item, "catalogId"), at(npc_binding, "catalog_id")]);
    let catalog_entry = catalog_item(&js::s(catalog_id));
    let canonical = catalog_entry.is_some();
    let mut properties: Vec<String> = Vec::new();
    properties.extend(unique_strings(at(selected_profile, "properties")));
    properties.extend(unique_strings(at_path(catalog_entry, &["weapon", "properties"])));
    properties.extend(unique_strings(at_path(catalog_entry, &["combat", "properties"])));
    if !canonical {
        properties.extend(unique_strings(at(item, "properties")));
        properties.extend(unique_strings(at_path(item, &["combat", "properties"])));
        properties.extend(unique_strings(at_path(item, &["weapon", "properties"])));
    }
    let properties = unique_string_list(&properties);
    let passive = passive_magical(&[at(catalog_entry, "passive_effects"), if canonical { None } else { at(item, "passive_effects") }]);
    let actor_key = actor.map(game::actor_id).unwrap_or_default();
    let magical = js::is_true(at(selected_profile, "magical"))
        || js::is_true(at(npc_binding, "magical"))
        || passive
        || magical_weapon_condition_for(state, &actor_key)
        || monster_weapon_attacks_magical(actor);
    Some(json!({ "kind": "weapon", "magical": magical, "properties": properties }))
}

/// `weaponCriticalThreshold(state, actor)`: 20, у Чемпиона — 19 с 3-го и 18 с 15-го уровня.
pub fn weapon_critical_threshold(state: &Value, actor: Option<&Value>) -> i64 {
    let Some(actor_value) = actor else { return 20 };
    if game::is_enemy_actor(state, &game::actor_id(actor_value)) || crate::tables::character_class_key(actor_value).as_deref() != Some("fighter") {
        return 20;
    }
    let subclass = sk_combat_content::combat_actions::normalized_combat_subclass_for(actor).unwrap_or_default();
    let champion = sk_core::re!(r"champion|чемпион", "iu");
    if !text::test(&champion, &subclass) {
        return 20;
    }
    let level = js::safe_int(at(actor, "level"), 1);
    if level >= 15 {
        18
    } else if level >= 3 {
        19
    } else {
        20
    }
}

/// Итог «Сражения большим оружием».
#[derive(Debug, Clone)]
pub struct GreatWeaponReroll {
    pub roll: Value,
    pub rerolls: Vec<Value>,
}

/// `greatWeaponFightingReroll(roll, diceService, command)`: кости урона 1 и 2
/// перебрасываются один раз.
pub fn great_weapon_fighting_reroll(roll: &Value, dice: &mut dyn RulesDice, command: &Value) -> Result<GreatWeaponReroll, Halt> {
    let sides = sk_dice::parse_dice_expression(&js::string(roll.get("expression"))).map_err(crate::core::dice_fault)?.sides;
    let mut rerolls = Vec::new();
    let mut dice_values = Vec::new();
    let actor = command.get("actor_id").cloned().unwrap_or(Value::Null);
    let visibility = command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String("public".into()));
    let source = roll.get("dice").and_then(Value::as_array).cloned().ok_or_else(|| Halt::Fault(crate::pause::Fault::type_error("roll.dice.map is not a function")))?;
    for value in source {
        if js::number(Some(&value)) > 2.0 {
            dice_values.push(value);
            continue;
        }
        let again = dice.roll(&[Value::String(format!("1d{sides}")), Value::String("damage:great-weapon-fighting".into()), actor.clone(), visibility.clone()])?;
        let first = again.get("dice").and_then(Value::as_array).and_then(|items| items.first()).cloned().unwrap_or(Value::Null);
        let mut entry = crate::core::spread_value(Some(&again));
        entry.insert("replaces".into(), value);
        rerolls.push(Value::Object(entry));
        dice_values.push(first);
    }
    if rerolls.is_empty() {
        return Ok(GreatWeaponReroll { roll: roll.clone(), rerolls });
    }
    let total = dice_values.iter().fold(js::safe_int(roll.get("modifier"), 0) as f64, |sum, value| sum + js::number(Some(value)));
    let mut next = crate::core::spread_value(Some(roll));
    next.insert("dice".into(), Value::Array(dice_values));
    next.insert("total".into(), js::num(total));
    next.insert("great_weapon_fighting".into(), Value::Bool(true));
    Ok(GreatWeaponReroll { roll: Value::Object(next), rerolls })
}

/// `offHandWeaponFor(actor)`: оружие второй руки, если обе руки держат лёгкое оружие ближнего боя.
pub fn off_hand_weapon_for(actor: Option<&Value>) -> Option<&Value> {
    let inventory = inventory_of(actor);
    let off_hand = inventory.iter().find(|item| js::is_true(at(Some(item), "equipped")) && at(Some(item), "equipped_slot").and_then(Value::as_str) == Some("off_hand") && off_hand_weapon_allowed(Some(item)));
    let main_hand = inventory.iter().find(|item| {
        js::is_true(at(Some(item), "equipped"))
            && at(Some(item), "equipped_slot").and_then(Value::as_str) != Some("off_hand")
            && at(Some(item), "type").and_then(Value::as_str) == Some("weapon")
            && off_hand_weapon_allowed(Some(item))
    });
    match (off_hand, main_hand) {
        (Some(off_hand), Some(_)) => Some(off_hand),
        _ => None,
    }
}

/// Параметры `itemAttackProfile`.
#[derive(Debug, Clone, Copy, Default)]
pub struct AttackOptions<'a> {
    /// `attackMode` (`null`, `''` — первый режим).
    pub attack_mode: Option<&'a Value>,
    /// `attackAbility` (`null`, `''` — по режиму).
    pub attack_ability: Option<&'a Value>,
    /// `offHand`: удар второй рукой.
    pub off_hand: bool,
}

/// `value == null || value === ''` — не названо.
fn unnamed(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(other) => Some(string_of(other)),
    }
}

/// `['melee', 'ranged'].includes(value)` (строгое равенство).
fn melee_or_ranged(value: Option<&Value>) -> bool {
    matches!(value.and_then(Value::as_str), Some("melee" | "ranged"))
}

/// `itemAttackProfile(state, actor, itemId, { attackMode, attackAbility, offHand })`
/// (3568–3673): профиль удара вещью из инвентаря; `None` — вещи нет, она не
/// оружие или режим и характеристика недопустимы.
pub fn item_attack_profile(state: &Value, actor: Option<&Value>, item_id: Option<&Value>, options: AttackOptions<'_>) -> Option<Value> {
    let item = combat_item_for_command(actor, item_id)?;
    // Каталожный предмет всегда читает боевой профиль из реестра.
    let catalog_entry = catalog_item(&js::s(coalesce(&[item.get("catalog_id"), item.get("catalogId")])));
    let combat = match catalog_entry.and_then(|entry| entry.get("combat")).filter(|value| !value.is_null()) {
        Some(combat) => combat,
        None => item.get("combat").filter(|value| !value.is_null())?,
    };
    if !js::truthy(Some(combat)) || !melee_or_ranged(combat.get("kind")) {
        return None;
    }
    let combat_modes = combat.get("modes").and_then(Value::as_array).filter(|modes| !modes.is_empty());
    let modes: Vec<Value> = match combat_modes {
        Some(list) => list.iter().filter(|candidate| js::truthy(Some(candidate)) && melee_or_ranged(at(Some(candidate), "kind"))).cloned().collect(),
        None => {
            let mut mode = Map::new();
            mode.insert("id".into(), combat.get("kind").cloned().unwrap_or(Value::Null));
            for (key, value) in crate::core::spread_value(Some(combat)) {
                mode.insert(key, value);
            }
            vec![Value::Object(mode)]
        }
    };
    let requested_mode = unnamed(options.attack_mode);
    let mode = match &requested_mode {
        Some(requested) => modes.iter().find(|candidate| js::string(at(Some(candidate), "id")) == *requested)?,
        None => modes.first()?,
    };
    let m = |key: &str| at(Some(mode), key);
    let actor_key = actor.map(game::actor_id).unwrap_or_default();
    let shillelagh = if shillelagh_weapon_for(Some(item)).is_some() { shillelagh_condition_for(state, &actor_key, Some(item)) } else { None };
    let shillelagh_spell = if shillelagh.is_some() {
        sk_combat_content::combat_spells::combat_spell_for(actor, Some(&json!("shillelagh")), Some(&json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) })))
    } else {
        None
    };
    let shillelagh_ability = js::s(coalesce(&[at(shillelagh, "spellcasting_ability"), at(shillelagh_spell.as_ref(), "spellcastingAbility")]));
    let shillelagh_active = shillelagh.is_some() && ABILITIES.contains(&shillelagh_ability.as_str());
    let mut base: Vec<String> = Vec::new();
    base.extend(unique_strings(coalesce(&[m("properties"), combat.get("properties")])));
    base.extend(unique_strings(at_path(catalog_entry, &["weapon", "properties"])));
    if catalog_entry.is_none() {
        base.extend(unique_strings(item.get("properties")));
        base.extend(unique_strings(at_path(Some(item), &["combat", "properties"])));
        base.extend(unique_strings(at_path(Some(item), &["weapon", "properties"])));
    }
    let base_properties = unique_string_list(&base);
    let catalog_magical = base_properties.iter().any(|property| matches!(text::lower(property).as_str(), "magic" | "magical"));
    let passive = passive_magical(&[at(catalog_entry, "passive_effects"), if catalog_entry.is_some() { None } else { item.get("passive_effects") }]);
    let magical = shillelagh_active || catalog_magical || passive || (catalog_entry.is_none() && js::is_true(item.get("magical"))) || magical_weapon_condition_for(state, &actor_key);
    let raw_abilities: Vec<String> = match (m("abilities"), combat.get("abilities")) {
        (Some(Value::Array(list)), _) => list.iter().map(string_of).collect(),
        (_, Some(Value::Array(list))) => list.iter().map(string_of).collect(),
        _ => vec![js::string(coalesce(&[m("ability"), combat.get("ability")]).or(m("ability").or(combat.get("ability"))))],
    };
    let abilities: Vec<String> = raw_abilities.into_iter().filter(|ability| ability == "str" || ability == "dex").collect();
    let allowed: Vec<String> = if abilities.is_empty() { vec![(if m("kind").and_then(Value::as_str) == Some("ranged") { "dex" } else { "str" }).to_string()] } else { abilities };
    let requested_ability = unnamed(options.attack_ability);
    let shillelagh_abilities: Vec<String> = if shillelagh_active {
        let mut list = vec!["str".to_string()];
        if shillelagh_ability != "str" {
            list.push(shillelagh_ability.clone());
        }
        list
    } else {
        allowed.clone()
    };
    if let Some(requested) = &requested_ability {
        if !shillelagh_abilities.contains(requested) {
            return None;
        }
    }
    let mode_ability = m("ability").and_then(Value::as_str).filter(|ability| allowed.iter().any(|entry| entry == ability));
    let ability = match requested_ability {
        Some(requested) => requested,
        None if shillelagh_active => shillelagh_ability.clone(),
        None => mode_ability.map(str::to_string).unwrap_or_else(|| allowed.last().cloned().unwrap_or_default()),
    };
    let ability_bonus = ability_modifier(at_path(actor, &["abilities", &ability]));
    let style = weapon_fighting_style_bonus(actor, Some(item), mode, &base_properties);
    let attack_bonus = js::safe_int(coalesce(&[m("attackBonus"), combat.get("attackBonus")]), 0) + style.attack_bonus;
    let damage_bonus = js::safe_int(coalesce(&[m("damageBonus"), combat.get("damageBonus")]), 0) + style.damage_bonus;
    // Удар второй рукой не добавляет к урону положительный модификатор — разве
    // что со стилем «Сражение двумя оружиями».
    let two_weapon_style = sk_ruleset::character_progression::normalized_selected_feature_ids(actor).iter().any(|id| id == "fighting-style-two-weapon");
    let damage_ability_bonus = if options.off_hand && !two_weapon_style { ability_bonus.min(0) } else { ability_bonus };
    let damage_dice = if shillelagh_active { Some(Value::String("1d8".into())) } else { coalesce(&[m("damage"), combat.get("damage")]).cloned() };
    let bonus_total = damage_ability_bonus + damage_bonus;
    let damage = match dice_expression(damage_dice.as_ref(), Some(&Value::from(bonus_total)), 8) {
        Ok(expression) => expression,
        Err(_) => format!("1d8{}{bonus_total}", if bonus_total >= 0 { "+" } else { "" }),
    };
    let proficiency = js::safe_int(at(actor, "proficiency"), 0).max(0);
    let range_raw = coalesce(&[m("longRange"), m("normalRange"), combat.get("longRange"), combat.get("normalRange")]);
    let normal_raw = coalesce(&[m("normalRange"), combat.get("normalRange")]);
    let damage_type_raw = coalesce(&[m("damageType"), combat.get("damageType")]);
    let weapon_group = coalesce(&[at_path(catalog_entry, &["weapon", "group"]), combat.get("weaponGroup"), combat.get("weapon_group")]);
    let ammunition = js::is_true(m("ammunition"));
    let mut out = Map::new();
    out.insert("item".into(), item.clone());
    out.insert("modifier".into(), Value::from(ability_bonus + proficiency + attack_bonus));
    if !style.ids.is_empty() {
        out.insert("fighting_styles".into(), js::strings_value(style.ids.iter().cloned()));
    }
    out.insert("great_weapon_fighting".into(), Value::Bool(style.great_weapon_fighting));
    out.insert("damage_expression".into(), Value::String(damage));
    out.insert("damage_type".into(), Value::String(sliced(&damage_type_raw.map(string_of).unwrap_or_else(|| "piercing".into()), 40)));
    out.insert("range_feet".into(), Value::from(clamp_i(js::safe_int(range_raw, 5), 5, 600)));
    out.insert("normal_range_feet".into(), Value::from(clamp_i(js::safe_int(normal_raw, 5), 5, 600)));
    out.insert("kind".into(), m("kind").cloned().unwrap_or(Value::Null));
    out.insert("ability".into(), Value::String(ability));
    out.insert("mode".into(), Value::String(js::string(coalesce(&[m("id"), m("kind")]).or(m("kind")))));
    let mut properties = base_properties.clone();
    if magical {
        properties.push("magical".into());
    }
    out.insert("properties".into(), js::strings_value(unique_string_list(&properties)));
    out.insert("magical".into(), Value::Bool(magical));
    out.insert("weapon_group".into(), Value::String(text::lower(&js::s(weapon_group))));
    out.insert("two_handed".into(), Value::Bool(js::is_true(m("twoHanded"))));
    out.insert("thrown".into(), Value::Bool(js::is_true(m("thrown"))));
    out.insert("ammunition".into(), Value::Bool(ammunition));
    let ammunition_catalog = if ammunition { js::opt_str(ammunition_catalog_id_for_weapon(&js::s(at(catalog_entry, "catalog_id")))) } else { Value::Null };
    out.insert("ammunition_catalog_id".into(), ammunition_catalog);
    Some(Value::Object(out))
}

/// `attackKindFor(selectedProfile, profile, npcBinding)`: `melee`, `ranged` или `thrown`.
pub fn attack_kind_for(selected_profile: Option<&Value>, profile: Option<&Value>, npc_binding: Option<&Value>) -> &'static str {
    if js::truthy(selected_profile) {
        if js::is_true(at(selected_profile, "thrown")) {
            return "thrown";
        }
        return if at(selected_profile, "kind").and_then(Value::as_str) == Some("ranged") { "ranged" } else { "melee" };
    }
    let kind = if at(profile, "kind").and_then(Value::as_str) == Some("ranged") { "ranged" } else { "melee" };
    if kind != "ranged" || !js::truthy(npc_binding) {
        return kind;
    }
    let properties = at_path(catalog_item(&js::s(at(npc_binding, "catalog_id"))), &["weapon", "properties"]);
    if array_of(properties).iter().any(|property| string_of(property) == "thrown") {
        "thrown"
    } else {
        "ranged"
    }
}

/// `heroAmmunitionSupply(actor, profile)`: запас снарядов героя для этого оружия.
pub fn hero_ammunition_supply(actor: Option<&Value>, profile: Option<&Value>) -> Option<Value> {
    let catalog_id = js::s(at(profile, "ammunition_catalog_id"));
    if !js::truthy(at(profile, "ammunition")) || catalog_id.is_empty() {
        return None;
    }
    let item = inventory_of(actor)
        .iter()
        .find(|candidate| js::s(coalesce(&[at(Some(candidate), "catalog_id"), at(Some(candidate), "catalogId")])) == catalog_id && js::safe_int(at(Some(candidate), "quantity"), 1) > 0);
    let shots_left = ammunition_shots_left(item);
    let catalog_name = || at(catalog_item(&catalog_id), "name").filter(|value| !value.is_null()).map(string_of).unwrap_or_else(|| catalog_id.clone());
    let item_name = match item {
        Some(item) => match item.get("name").filter(|value| !value.is_null()) {
            Some(name) => string_of(name),
            None => catalog_name(),
        },
        None => catalog_name(),
    };
    Some(json!({
        "catalog_id": catalog_id,
        "item_id": item.map(|item| js::string(item.get("id"))).unwrap_or_default(),
        "item_name": item_name,
        "quantity": item.map_or(0, |item| js::safe_int(item.get("quantity"), 1).max(0)),
        "shots_left": shots_left,
    }))
}

/// `heroAmmunitionExpenditure(actor, profile)`: списание одного снаряда.
pub fn hero_ammunition_expenditure(actor: Option<&Value>, profile: Option<&Value>) -> Option<Value> {
    let supply = hero_ammunition_supply(actor, profile)?;
    let shots_left = js::number(supply.get("shots_left"));
    if !js::truthy(supply.get("item_id")) || shots_left <= 0.0 {
        return None;
    }
    let catalog_id = js::s(supply.get("catalog_id"));
    let bundle = ammunition_bundle_amount(&catalog_id) as f64;
    let shots_after = shots_left - 1.0;
    let quantity_after = if shots_after > 0.0 { (shots_after / bundle).ceil().max(1.0) } else { 0.0 };
    Some(json!({
        "item_id": supply["item_id"],
        "catalog_id": supply["catalog_id"],
        "item_name": supply["item_name"],
        "quantity_before": supply["quantity"],
        "quantity_after": js::num(quantity_after),
        "shots_before": supply["shots_left"],
        "shots_after": js::num(shots_after),
        "capacity_after": js::num(quantity_after * bundle),
    }))
}

/// Оружие героя для атаки без `item_id` (`equippedWeaponAttacks`).
#[derive(Debug, Clone)]
pub struct EquippedWeaponAttack {
    pub item_id: String,
    pub profile: Value,
}

/// `equippedWeaponAttacks(state, actor)` (3917): надетое оружие героя с профилями.
pub fn equipped_weapon_attacks(state: &Value, actor: Option<&Value>) -> Vec<EquippedWeaponAttack> {
    let id = actor.map(game::actor_id).unwrap_or_default();
    let players = array_of(state.get("players"));
    if !players.iter().any(|player| game::actor_id(player) == id) {
        return Vec::new();
    }
    let mut result = Vec::new();
    for item in inventory_of(actor) {
        if !js::truthy(at(Some(item), "equipped")) || at(Some(item), "type").and_then(Value::as_str) != Some("weapon") || !quantity_positive(item) {
            continue;
        }
        if let Some(profile) = item_attack_profile(state, actor, item.get("id"), AttackOptions::default()) {
            result.push(EquippedWeaponAttack { item_id: js::string(item.get("id")), profile });
        }
    }
    result
}

/// Что вернула `swingDetailsFor`.
#[derive(Debug, Clone)]
pub struct SwingDetails {
    pub prop: Value,
    pub profile: Value,
    pub anchor: sk_geometry::Point,
    pub anchor_cell: Value,
    pub actor: Value,
    pub from: sk_geometry::Point,
    pub reach_height: f64,
}

/// `swingDetailsFor(state, actorId, propId, { runningStart })` (4005–4033):
/// люстра на карте, до которой герой дотягивается.
pub fn swing_details_for(state: &Value, actor_id: &str, prop_id: Option<&Value>, running_start: bool) -> Result<SwingDetails, Halt> {
    let map = crate::tactical_geometry::scene_tactical_map(state);
    let wanted = js::string(prop_id);
    let prop = map.as_ref().and_then(|map| map.props.iter().find(|candidate| candidate.id == wanted));
    let profile = prop.and_then(|prop| sk_combat_content::scene_hazards::swing_prop_profile_for(Some(&Value::String(prop.asset_id.clone()))));
    let (Some(prop), Some(profile)) = (prop, profile) else {
        return Err(rule("На карте нет исправной люстры с подтверждённой опорой", "SWING_PROP_NOT_FOUND"));
    };
    if matches!(prop.state.as_str(), "broken" | "toppled") {
        return Err(rule("На карте нет исправной люстры с подтверждённой опорой", "SWING_PROP_NOT_FOUND"));
    }
    let anchor = match prop.footprint.first() {
        Some(cell) => sk_geometry::Point::new(cell.x as f64, cell.y as f64),
        None => sk_geometry::Point::new(prop.x.floor(), prop.y.floor()),
    };
    let cells = crate::tactical_geometry::tactical_cell_map(state);
    let anchor_cell = cells.get(&crate::tactical_geometry::key_of(anchor)).copied();
    let usable = anchor_cell.is_some_and(|cell| !js::is_false(cell.get("revealed")) && crate::tactical_geometry::is_walkable_cell(Some(cell)));
    let Some(anchor_cell) = anchor_cell.filter(|_| usable) else {
        return Err(rule("Точка опоры люстры не раскрыта или недоступна", "SWING_ANCHOR_UNAVAILABLE"));
    };
    let actor = game::find_actor(state, actor_id);
    let from = crate::tactical_geometry::actor_point(state, actor_id);
    let (Some(actor), Some(from)) = (actor, from) else {
        return Err(rule("Герой должен находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    let anchor_cells = json!([crate::tactical_geometry::point_json(anchor)]);
    // `reachDistance > profile.reach_feet`: `null` сравнивается как 0.
    let reach_distance = swing_reach_distance(actor, &anchor_cells, from).unwrap_or(0.0);
    if reach_distance > js::number(profile.get("reach_feet")) {
        return Err(rule("До люстры нужно подойти вплотную", "SWING_PROP_OUT_OF_REACH"));
    }
    let high_jump = (3 + ability_modifier(at_path(Some(actor), &["abilities", "str"]))) as f64 * if running_start { 1.0 } else { 0.5 };
    let reach_height = 1.5 * creature_height_feet(Some(actor)) + high_jump;
    if reach_height < js::number(profile.get("height_feet")) {
        return Err(rule(format!("До опоры не достать: нужен рост и прыжок до {} фт", js::string(profile.get("height_feet"))), "SWING_HEIGHT_UNREACHABLE"));
    }
    Ok(SwingDetails { prop: prop.to_json(), profile, anchor, anchor_cell: anchor_cell.clone(), actor: actor.clone(), from, reach_height })
}

/// `footprintDistanceFeet(actor, [anchor], from)`: второй аргумент — массив
/// клеток (не карточка существа), поэтому расстояние считается до самих клеток.
fn swing_reach_distance(actor: &Value, anchor_cells: &Value, from: sk_geometry::Point) -> Option<f64> {
    sk_geometry::actor_footprint::footprint_distance_feet(Some(actor), Some(anchor_cells), Some(&crate::tactical_geometry::point_json(from)), None)
}

/// `averageDamageOf(profile)`: средний урон по выражению или фиксированный.
pub fn average_damage_of(profile: Option<&Value>) -> f64 {
    let expression = js::s(at(profile, "damage_expression"));
    let pattern = sk_core::re!(r"^(\d+)d(\d+)([+-]\d+)?$", "u");
    let Ok(Some(captures)) = pattern.captures(&expression) else {
        return js::safe_int(at(profile, "damage_amount"), 0).max(0) as f64;
    };
    let count = js::parse_number(captures.get(1).map_or("", |m| m.as_str()));
    let sides = js::parse_number(captures.get(2).map_or("", |m| m.as_str()));
    let modifier = captures.get(3).map_or(0.0, |m| js::parse_number(m.as_str()));
    js::round(count * (sides + 1.0) / 2.0 + modifier)
}

/// `attackProfileFor(state, actorId, actionId)` (экспорт): серверный профиль существа.
pub fn attack_profile_for(state: &Value, actor_id: &str, action_id: Option<&Value>) -> Result<Option<Value>, Halt> {
    match game::find_actor(state, actor_id) {
        Some(actor) => trusted_attack_profile(state, Some(actor), action_id).map(Some),
        None => Ok(None),
    }
}

/// `weaponAttackProfileFor(state, actorId, itemId, options)` (экспорт).
pub fn weapon_attack_profile_for(state: &Value, actor_id: &str, item_id: Option<&Value>, options: AttackOptions<'_>) -> Option<Value> {
    let actor = game::find_actor(state, actor_id)?;
    item_attack_profile(state, Some(actor), item_id, options)
}

/// Удар по возможности: профиль и вещь (`opportunityAttackProfile`).
#[derive(Debug, Clone)]
pub struct OpportunityProfile {
    pub profile: Value,
    /// `item_id` надетого оружия ближнего боя или `null`.
    pub item_id: Value,
}

/// `opportunityAttackProfile(state, actor)` (4554): надетое оружие ближнего
/// боя или собственная атака существа вплотную.
pub fn opportunity_attack_profile(state: &Value, actor: Option<&Value>) -> Result<Option<OpportunityProfile>, Halt> {
    let equipped_melee = inventory_of(actor)
        .iter()
        .find(|item| js::truthy(at(Some(item), "equipped")) && at_path(Some(item), &["combat", "kind"]).and_then(Value::as_str) == Some("melee") && quantity_positive(item));
    if let Some(item) = equipped_melee {
        let profile = item_attack_profile(state, actor, item.get("id"), AttackOptions::default());
        return Ok(profile.map(|profile| OpportunityProfile { profile, item_id: item.get("id").cloned().unwrap_or(Value::Null) }));
    }
    let profile = trusted_attack_profile(state, actor, None)?;
    Ok((js::number(profile.get("range_feet")) <= 5.0).then_some(OpportunityProfile { profile, item_id: Value::Null }))
}

/// `criticalDamageExpression(expression)`: кости удваиваются (не больше 100).
pub fn critical_damage_expression(expression: &str) -> Result<String, Halt> {
    let parsed = sk_dice::parse_dice_expression(expression).map_err(crate::core::dice_fault)?;
    let count = (parsed.count * 2).min(100);
    Ok(format!("{count}d{}{}", parsed.sides, crate::core::signed(parsed.modifier)))
}

/// `weaponCoatingRiderFor(state, actorId, itemId)` (8984–9012): яд на оружии —
/// добавка урона той же формы, что у магических предметов.
pub fn weapon_coating_rider_for(state: &Value, actor_id: Option<&Value>, item_id: Option<&Value>) -> Option<Value> {
    let condition_id = format!("weapon-coated:{}", js::s(item_id));
    let actor_key = js::s(actor_id);
    let condition = conditions_of(state, &actor_key).iter().find(|candidate| condition_name(candidate) == condition_id)?;
    let rider = condition.get("rider_damage").filter(|value| js::truthy(Some(value)))?;
    let rider_type = condition.get("rider_damage_type").filter(|value| !value.is_null()).map(string_of).unwrap_or_else(|| "poison".into());
    let name = condition.get("rider_source_name").filter(|value| !value.is_null()).map(string_of).unwrap_or_else(|| "Яд".into());
    let purpose_subject = if game::is_enemy_actor(state, &actor_key) { "weapon-coated".to_string() } else { condition_id.clone() };
    Some(json!({
        "expression": string_of(rider),
        "damage_type": rider_type,
        "item_id": js::string(item_id),
        "item_name": name,
        "catalog_id": null,
        "effect_id": condition_id,
        "purpose_subject": purpose_subject,
        "critical_doubles": false,
        "condition_id": condition_id,
    }))
}
