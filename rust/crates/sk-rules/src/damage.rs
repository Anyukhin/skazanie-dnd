//! Урон, КД и защиты: `effectiveArmorClass`, сопротивления, `damagePayload`, порог хитов, уклонение. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 3105 (`resolvedHealingRoll`), 8011–8110
//! (`effectiveArmorClass`, пул хитов заклинания, иммунитет ко сну, защиты
//! стат-блока, `defenseFor`), 8090–8205 (`damagePayload`,
//! `damagePayloadWithHpFloor`; `knightDistanceFeet` 8185 — в `targets.rs`, Р1),
//! 11061 (`conditionArmorClassBonus`), 23507 (`withoutImmuneConditions`).
//!
//! `damagePayload` — единственный счётчик урона движка: атаки, ловушки, зоны и
//! заклинания сходятся сюда.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_items_life::item_lifecycle::{self, ItemLifecycleError, MechanicEffectOptions};

use crate::command::rules::rule_ids;
use crate::conditions::{at, at_path, nullish_chain};
use crate::core::{command_with, command_with_rules, condition_ids_for, event_from, unique_strings};
use crate::pause::{rule, Fault, Halt};
use crate::tables::condition_effect;

/// Ошибка `item-lifecycle` как ошибка JS: `ItemLifecycleValidationError` или `TypeError`.
pub(crate) fn item_fault(error: ItemLifecycleError) -> Halt {
    match error {
        ItemLifecycleError::Validation { message, code } => Fault::new("ItemLifecycleValidationError", message).with_code(code).into(),
        ItemLifecycleError::Type(message) => Fault::type_error(message).into(),
    }
}

/// `activeItemEffectTotals(actor)[field]` числом.
pub(crate) fn item_effect_total(actor: Option<&Value>, field: &str) -> Result<f64, Halt> {
    let totals = item_lifecycle::active_item_effect_totals(actor).map_err(item_fault)?;
    Ok(js::number(totals.get(field)))
}

/// `resolvedHealingRoll(state, targetId, expression, rolledAmount)`: под
/// «Маяком надежды» лечение по формуле — максимум костей.
pub fn resolved_healing_roll(state: &Value, target_id: &str, expression: Option<&Value>, rolled_amount: Option<&Value>) -> Value {
    let rolled = js::safe_int(rolled_amount, 0).max(0);
    if !js::truthy(expression) || !condition_ids_for(state, target_id).contains("beacon-of-hope") {
        return json!({ "amount": rolled });
    }
    match sk_dice::parse_dice_expression(&js::string(expression)) {
        Ok(parsed) => json!({
            "amount": (i64::from(parsed.count) * i64::from(parsed.sides) + parsed.modifier).max(0),
            "rolled_amount": rolled,
            "maximized_by": "beacon-of-hope",
        }),
        Err(_) => json!({ "amount": rolled }),
    }
}

/// `effectiveArmorClass(state, actor, id)`: наибольшая из основ (лист, доспех,
/// «Доспехи мага», пороги состояний) плюс предметные и условные надбавки.
pub fn effective_armor_class(state: &Value, actor: Option<&Value>, id: &str) -> Result<f64, Halt> {
    let conditions = condition_ids_for(state, id);
    let item_bonus = item_effect_total(actor, "armor_class_bonus")?;
    let listed_armor = js::safe_int(nullish_chain(&[at(actor, "armor"), at(actor, "armorClass")]), 10).max(0) as f64;
    let sheet_armor = at_path(actor, &["characterSheet", "armor_class"]);
    let sheet_value = js::safe_int(at(sheet_armor, "value"), 0).max(0) as f64;
    let sheet_item_bonus = js::safe_int(at(sheet_armor, "item_effect_bonus"), 0).max(0) as f64;
    let item_stamped_in_sheet = item_bonus > 0.0 && sheet_item_bonus == item_bonus;
    let listed_base = listed_armor - if item_stamped_in_sheet && listed_armor == sheet_value { item_bonus } else { 0.0 };
    let sheet_base = sheet_value - if item_stamped_in_sheet { item_bonus } else { 0.0 };
    let mage_armor = if conditions.contains("mage-armor") {
        let shield = js::number(Some(&item_lifecycle::equipped_shield_bonus(actor).map_err(item_fault)?));
        13.0 + crate::core::ability_modifier(at_path(actor, &["abilities", "dex"])) as f64 + shield
    } else {
        0.0
    };
    let equipment = item_lifecycle::derived_equipment_armor_class(actor, false).map_err(item_fault)?;
    let equipment_armor = if equipment.is_null() { 0.0 } else { js::number(Some(&equipment)) };
    let mut floor = 0.0_f64;
    for condition in &conditions {
        floor = crate::tactical_geometry::js_max(floor, js::safe_int(condition_effect(condition).and_then(|effect| effect.get("armorClassFloor")), 0) as f64);
    }
    let best = js::max_of([listed_base, sheet_base, mage_armor, equipment_armor, floor]);
    Ok(best + item_bonus + condition_armor_class_bonus(state, id) as f64)
}

/// `spellHpPoolExpression(baseExpression, upcastExpression, spellLevel, slotLevel)`:
/// пул хитов заклинания с костями за круги выше базового.
pub fn spell_hp_pool_expression(base_expression: Option<&Value>, upcast_expression: Option<&Value>, spell_level: Option<&Value>, slot_level: Option<&Value>) -> Result<String, Halt> {
    let base_text = js::string(base_expression);
    let base = sk_dice::parse_dice_expression(&base_text).map_err(crate::core::dice_fault)?;
    let upcast = sk_dice::parse_dice_expression(&js::string(upcast_expression)).map_err(crate::core::dice_fault)?;
    // `safeInteger(slotLevel, spellLevel)`: запас — сам `spellLevel`, который
    // дальше участвует в вычитании числом JS; `undefined` — запас по умолчанию 0.
    let fallback = if spell_level.is_none() { 0.0 } else { js::number(spell_level) };
    let slot = crate::conditions::safe_int_or(slot_level, fallback);
    let levels = crate::tactical_geometry::js_max(0.0, slot - js::safe_int(spell_level, 1).max(1) as f64);
    if base.sides != upcast.sides {
        return Ok(base_text);
    }
    let count = crate::tactical_geometry::js_min(100.0, f64::from(base.count) + f64::from(upcast.count) * levels);
    let modifier = base.modifier as f64 + upcast.modifier as f64 * levels;
    let sign = if modifier > 0.0 {
        format!("+{}", js::f64_string(modifier))
    } else if modifier < 0.0 {
        js::f64_string(modifier)
    } else {
        String::new()
    };
    Ok(format!("{}d{}{}", js::f64_string(count), base.sides, sign))
}

/// `immuneToMagicalSleep(state, actor)`: нежить, иммунитет к очарованию.
pub fn immune_to_magical_sleep(state: &Value, actor: Option<&Value>) -> bool {
    let id = actor.map(sk_core::game::actor_id).unwrap_or_default();
    let creature_type = sk_core::text::lower(&js::s(nullish_chain(&[at(actor, "creature_type"), at(actor, "creatureType"), at(actor, "type")])));
    let immunities: Vec<String> = unique_strings(nullish_chain(&[at(actor, "condition_immunities"), at(actor, "conditionImmunities")])).iter().map(|value| sk_core::text::lower(value)).collect();
    let species: Vec<String> = unique_strings(at_path(actor, &["speciesBenefits", "mechanics", "condition_immunities"])).iter().map(|value| sk_core::text::lower(value)).collect();
    let conditions = condition_ids_for(state, &id);
    creature_type == "undead"
        || creature_type.contains("нежить")
        || immunities.iter().any(|value| ["charmed", "charm", "очарование", "очарованный"].contains(&value.as_str()))
        || species.iter().any(|value| value == "magical-sleep")
        || conditions.contains("charm-immune")
        || conditions.contains("immune:charmed")
}

/// `statBlockDamageList(value)`: список стат-блока в нижнем регистре.
pub fn stat_block_damage_list(value: Option<&Value>) -> Vec<String> {
    unique_strings(value).iter().map(|entry| sk_core::text::lower(entry)).collect()
}

/// `conditionalDamageDefenseApplies(value, damageType, source)`: защита стат-блока
/// с условием («кроме магического / серебряного / адамантинового оружия»).
pub fn conditional_damage_defense_applies(value: Option<&Value>, damage_type: Option<&Value>, source: Option<&Value>) -> bool {
    let Some(Value::Array(entries)) = value else { return false };
    if at(source, "kind").and_then(Value::as_str) != Some("weapon") {
        return false;
    }
    let damage = sk_core::text::lower(&js::s(damage_type));
    let magical = js::is_true(at(source, "magical"));
    let properties: IndexSet<String> = match at(source, "properties") {
        Some(Value::Array(items)) => items.iter().map(|entry| sk_core::text::lower(&js::string(Some(entry)))).collect(),
        _ => IndexSet::new(),
    };
    entries.iter().any(|entry| {
        let Value::Object(entry) = entry else { return false };
        let types: Vec<String> = match entry.get("types") {
            Some(Value::Array(items)) => items.iter().map(|item| sk_core::text::lower(&js::string(Some(item)))).collect(),
            _ => Vec::new(),
        };
        if !types.contains(&damage) {
            return false;
        }
        match sk_core::text::lower(&js::s(entry.get("condition"))).as_str() {
            "nonmagical-attacks" | "nonmagical-weapons" => !magical,
            "nonmagical-attacks-except-silvered" => !magical && !properties.contains("silvered"),
            "nonmagical-attacks-except-adamantine" => !magical && !properties.contains("adamantine"),
            _ => false,
        }
    })
}

/// `statBlockConditionImmunities(state, id)`: иммунитеты к состояниям из записи существа.
pub fn stat_block_condition_immunities(state: &Value, id: &str) -> IndexSet<String> {
    let actor = sk_core::game::find_actor(state, id);
    unique_strings(nullish_chain(&[at(actor, "condition_immunities"), at(actor, "conditionImmunities")])).iter().map(|value| sk_core::text::lower(value)).collect()
}

/// Защиты существа (`defenseFor`): наложенные по ходу игры плюс стат-блок.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Defense {
    pub resistances: Vec<String>,
    pub vulnerabilities: Vec<String>,
    pub immunities: Vec<String>,
}

impl Defense {
    pub fn to_value(&self) -> Value {
        json!({ "resistances": self.resistances, "vulnerabilities": self.vulnerabilities, "immunities": self.immunities })
    }
}

/// `defenseFor(state, id)`. Нормализованное состояние всегда несёт
/// `mechanics.defenses`; без него JS бросил бы `TypeError`, здесь — пусто.
pub fn defense_for(state: &Value, id: &str) -> Defense {
    let defense = sk_core::game::mechanics(state).get("defenses").and_then(|all| all.get(id)).filter(|value| !value.is_null());
    let actor = sk_core::game::find_actor(state, id);
    let species_resistances = stat_block_damage_list(at_path(actor, &["speciesBenefits", "mechanics", "damage_resistances"]));
    let suppressed: IndexSet<String> = condition_ids_for(state, id)
        .iter()
        .flat_map(|condition| match condition_effect(condition).and_then(|effect| effect.get("suppressesDamageImmunities")) {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>(),
            _ => Vec::new(),
        })
        .collect();
    let mut resistances = unique_strings(at(defense, "resistances"));
    resistances.extend(stat_block_damage_list(at(actor, "damage_resistances")));
    resistances.extend(species_resistances);
    let mut vulnerabilities = unique_strings(at(defense, "vulnerabilities"));
    vulnerabilities.extend(stat_block_damage_list(at(actor, "damage_vulnerabilities")));
    let mut immunities = unique_strings(at(defense, "immunities"));
    immunities.extend(stat_block_damage_list(at(actor, "damage_immunities")));
    immunities.retain(|kind| !suppressed.contains(kind));
    Defense { resistances, vulnerabilities, immunities }
}

/// Строка вида урона для строгих сравнений `list.includes(damageType)`: у
/// не-строки равных строк нет.
fn damage_text(damage_type: &Value) -> Option<&str> {
    damage_type.as_str()
}

/// `damagePayload(state, targetId, rawAmount, damageType = 'untyped', resistanceCantrip, source)`.
/// `damage_type: None` — значение по умолчанию `'untyped'`.
pub fn damage_payload(state: &Value, target_id: &str, raw_amount: Option<&Value>, damage_type: Option<&Value>, resistance_cantrip: Option<&Value>, source: Option<&Value>) -> Result<Value, Halt> {
    let untyped = Value::String("untyped".into());
    let damage_type = damage_type.unwrap_or(&untyped);
    let Some(actor) = sk_core::game::find_actor(state, target_id) else {
        return Err(rule("Цель урона не найдена", "TARGET_NOT_FOUND"));
    };
    let number = js::number(raw_amount);
    let raw = crate::tactical_geometry::js_max(0.0, (if number.is_nan() || number == 0.0 { 0.0 } else { number }).floor());
    let defenses = defense_for(state, target_id);
    let typed = damage_text(damage_type);
    let has = |list: &[String]| typed.is_some_and(|kind| list.iter().any(|entry| entry == kind));
    let conditional_resistant = conditional_damage_defense_applies(actor.get("damage_resistances"), Some(damage_type), source);
    let conditional_immune = conditional_damage_defense_applies(actor.get("damage_immunities"), Some(damage_type), source);
    let lowered = sk_core::text::lower(&js::string(Some(damage_type)));
    let options = MechanicEffectOptions { selected_item_id: None, selected_counts_as_equipped: false };
    let item_resistance_sources: Vec<Value> = item_lifecycle::active_item_mechanic_effects(Some(actor), &options)
        .map_err(item_fault)?
        .iter()
        .filter(|effect| crate::conditions::includes_str(effect.get("damage_resistances"), &lowered))
        .map(|effect| {
            let mut source = Map::new();
            for key in ["effect_id", "item_id", "item_name", "catalog_id"] {
                if let Some(value) = effect.get(key) {
                    source.insert(key.into(), value.clone());
                }
            }
            Value::Object(source)
        })
        .collect();
    let conditions = condition_ids_for(state, target_id);
    let condition_immunity = conditions.iter().any(|condition| {
        let effect = condition_effect(condition);
        js::is_true(effect.and_then(|effect| effect.get("immuneToAllDamage"))) || typed.is_some_and(|kind| crate::conditions::includes_str(effect.and_then(|effect| effect.get("immuneToDamageTypes")), kind))
    });
    let knight_ward = sk_world_story::scenario_knight::scenario_knight_ward(state, Some(&Value::String(target_id.to_string())));
    let ward_kind = knight_ward.as_ref().and_then(|ward| ward.get("kind")).and_then(Value::as_str);
    let immune = has(&defenses.immunities) || conditional_immune || condition_immunity || sk_combat_content::combat_spells::is_untargetable_summon(Some(actor)) || ward_kind == Some("immune");
    let physical = typed.is_some_and(|kind| ["bludgeoning", "piercing", "slashing"].contains(&kind));
    let raging_resistance = conditions.contains("raging") && physical;
    let uncanny_resistance = conditions.contains("uncanny-dodge");
    let absorbing_resistance = conditions.contains(format!("absorbing-element:{}", js::string(Some(damage_type))).as_str());
    let blade_ward_resistance = conditions.contains("blade-ward") && physical && (!sk_core::game::uses_2014(state) || at(source, "kind").and_then(Value::as_str) == Some("weapon"));
    let aura_of_life = if typed == Some("necrotic") { crate::checks::saves::active_aura_of_life_source(state, target_id) } else { None };
    let condition_resistance = conditions.iter().any(|condition| {
        let effect = condition_effect(condition);
        js::is_true(effect.and_then(|effect| effect.get("resistsAllDamage"))) || typed.is_some_and(|kind| crate::conditions::includes_str(effect.and_then(|effect| effect.get("resistsDamageTypes")), kind))
    });
    let knight_resistance = ward_kind == Some("resist") && !typed.is_some_and(|kind| crate::conditions::includes_str(knight_ward.as_ref().and_then(|ward| ward.get("except")), kind));
    let resistant = !js::is_true(at(source, "ignore_resistance"))
        && (has(&defenses.resistances)
            || conditional_resistant
            || !item_resistance_sources.is_empty()
            || raging_resistance
            || uncanny_resistance
            || absorbing_resistance
            || blade_ward_resistance
            || condition_resistance
            || aura_of_life.is_some()
            || knight_resistance);
    let vulnerable = has(&defenses.vulnerabilities);
    let mut after_defense = if immune { 0.0 } else { raw };
    let reduction = crate::tactical_geometry::js_min(after_defense, js::safe_int(at(resistance_cantrip, "reduction"), 0).max(0) as f64);
    after_defense -= reduction;
    if sk_core::game::uses_2014(state) {
        if !immune && resistant {
            after_defense = (after_defense / 2.0).floor();
        }
        if !immune && vulnerable {
            after_defense *= 2.0;
        }
    } else {
        if !immune && resistant && !vulnerable {
            after_defense = (after_defense / 2.0).floor();
        }
        if !immune && vulnerable && !resistant {
            after_defense *= 2.0;
        }
    }
    let temporary_before = js::safe_int(sk_core::game::mechanics(state).get("temporary_hp").and_then(|all| all.get(target_id)), 0).max(0) as f64;
    let absorbed = crate::tactical_geometry::js_min(temporary_before, after_defense);
    let applied = after_defense - absorbed;
    let hp_before = sk_core::game::actor_hp(actor) as f64;
    let death_ward_triggered = hp_before > 0.0 && applied >= hp_before && conditions.contains("death-ward");
    let relentless_triggered = !death_ward_triggered
        && hp_before > 0.0
        && applied >= hp_before
        && js::is_true(at_path(Some(actor), &["speciesBenefits", "mechanics", "relentless_endurance"]))
        && !conditions.contains("species-trait-used:relentless-endurance");
    let hp_after = if death_ward_triggered || relentless_triggered { 1.0 } else { crate::tactical_geometry::js_max(0.0, hp_before - applied) };
    let mut payload = Map::new();
    payload.insert("damage_type".into(), damage_type.clone());
    payload.insert("raw_amount".into(), js::num(raw));
    payload.insert("applied_amount".into(), js::num(applied));
    payload.insert("immune".into(), Value::Bool(immune));
    payload.insert("resistant".into(), Value::Bool(resistant));
    payload.insert("vulnerable".into(), Value::Bool(vulnerable));
    if !item_resistance_sources.is_empty() {
        payload.insert("item_resistance_sources".into(), Value::Array(item_resistance_sources));
    }
    if let Some(aura) = &aura_of_life {
        payload.insert("aura_of_life_source".into(), Value::String(aura.source_id.clone()));
    }
    if reduction > 0.0 {
        payload.insert("resistance_cantrip_reduction".into(), js::num(reduction));
        payload.insert("resistance_cantrip_condition".into(), Value::String(js::string(at(resistance_cantrip, "condition_id"))));
        payload.insert("resistance_cantrip_turn".into(), Value::String(js::string(at(resistance_cantrip, "turn_key"))));
        payload.insert("resistance_cantrip_roll_id".into(), at(resistance_cantrip, "roll_id").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    }
    payload.insert("temporary_hp_before".into(), js::num(temporary_before));
    payload.insert("temporary_hp_after".into(), js::num(temporary_before - absorbed));
    payload.insert("temporary_hp_absorbed".into(), js::num(absorbed));
    payload.insert("hp_before".into(), js::num(hp_before));
    payload.insert("hp_after".into(), js::num(hp_after));
    if death_ward_triggered {
        payload.insert("death_ward_triggered".into(), Value::Bool(true));
    }
    if relentless_triggered {
        payload.insert("relentless_endurance_triggered".into(), Value::Bool(true));
    }
    if let Some(ward) = &knight_ward {
        payload.insert("scenario_ward".into(), ward.get("kind").cloned().unwrap_or(Value::Null));
        if ward_kind == Some("immune") {
            if let Some(laugh) = ward.get("laugh") {
                payload.insert("scenario_ward_text".into(), laugh.clone());
            }
        }
    }
    Ok(Value::Object(payload))
}

/// `damagePayloadWithHpFloor(payload, minimumHp)`: урон «не ниже N хитов».
pub fn damage_payload_with_hp_floor(payload: &Value, minimum_hp: Option<&Value>) -> Value {
    let floor = js::safe_int(minimum_hp, 0).max(0);
    let before = js::safe_int(payload.get("hp_before"), 0).max(0);
    let after = js::safe_int(payload.get("hp_after"), 0).max(0);
    let limit = before.min(floor);
    if floor == 0 || after >= limit {
        return payload.clone();
    }
    let mut next = crate::core::spread_value(Some(payload));
    next.insert("hp_after".into(), Value::from(limit));
    next.insert("applied_amount".into(), Value::from(before - limit));
    next.insert("hp_floor".into(), Value::from(floor));
    Value::Object(next)
}

/// `conditionArmorClassBonus(state, id)`: сумма надбавок КД от состояний.
pub fn condition_armor_class_bonus(state: &Value, id: &str) -> i64 {
    crate::conditions::condition_numeric_bonus(state, id, "armorClassBonus")
}

/// `withoutImmuneConditions(state, command, events)`: состояние не ложится на
/// иммунного по стат-блоку — вместо него `ConditionImmunityResolved`.
pub fn without_immune_conditions(state: &Value, command: &Value, events: &[Value]) -> Vec<Value> {
    let mut result = Vec::new();
    for event in events {
        if event.get("event_type").and_then(Value::as_str) != Some("ConditionAdded") {
            result.push(event.clone());
            continue;
        }
        let payload = event.get("payload");
        let condition = js::s(at(payload, "condition"));
        let lowered = sk_core::text::lower(&condition);
        let targets = unique_strings(event.get("target_ids"));
        let immune: Vec<String> = targets.iter().filter(|id| stat_block_condition_immunities(state, id).contains(&lowered)).cloned().collect();
        if immune.is_empty() {
            result.push(event.clone());
            continue;
        }
        let affected: Vec<String> = targets.iter().filter(|id| !immune.contains(id)).cloned().collect();
        if !affected.is_empty() {
            let mut copy = crate::core::spread_value(Some(event));
            copy.insert("target_ids".into(), js::strings_value(affected));
            result.push(Value::Object(copy));
        }
        let visibility = nullish_chain(&[event.get("visibility"), command.get("visibility")]).cloned().unwrap_or(Value::Null);
        let source = command_with_rules(&command_with(command, "visibility", visibility), &[rule_ids::CONDITIONS]);
        let mut resolved = Map::new();
        resolved.insert("condition".into(), Value::String(condition));
        resolved.insert("reason".into(), Value::String("condition-immunity".into()));
        if let Some(actor) = at(payload, "source_actor").filter(|value| !value.is_null()) {
            resolved.insert("source_actor".into(), Value::String(js::string(Some(actor))));
        }
        if let Some(spell) = at(payload, "spell_id").filter(|value| !value.is_null()) {
            resolved.insert("spell_id".into(), Value::String(js::string(Some(spell))));
        }
        result.push(event_from(&source, "ConditionImmunityResolved", Some(Value::Object(resolved)), Some(&js::strings_value(immune))));
    }
    result
}
