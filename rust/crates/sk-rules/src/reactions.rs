//! Реакции: варианты после атаки и урона, союзные реакции, «Щит» и
//! «Поглощение стихий», контрзаклинание, «Искусная острота», режимы реакций
//! героя. Задача Р5.
//!
//! JS: `server/rules-engine.mjs` — `OPPORTUNITY_BLOCKING_CONDITIONS`,
//! `opportunityAttackers` (4530–4565; `opportunityAttackProfile` — Р3),
//! варианты реакций 9536–9792 (`bardicInspirationDieSides` — Р3),
//! `counterspellWindowFor` (9925–9944), `heroReactionModesFor` (12749–12771).
//! Исполнение режимов реакций (`resolveReactionPreferences`) — `resolve/api.rs`.

use std::cmp::Ordering;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::constants::{CUTTING_WORDS_ACTION_ID, PROTECTION_ACTION_IDS, REACTION_PREFERENCE_ACTION_IDS, REACTION_PREFERENCE_SPELL_IDS};
use crate::core::{command_with, command_with_rules, condition_ids_for, event_from, incapacitating_condition_for, resource_pool, spread_value};
use crate::pause::Halt;
use crate::spells::components::spell_component_availability_for;
use crate::spells::slots::{choose_spell_slot, SpellSlot};
use crate::tactical_geometry::{actor_point, point_json};

/// `REACTION_PREFERENCE_CHAIN_LIMIT`: сколько окон подряд режимы реакций
/// закрывают в одной команде.
pub const REACTION_PREFERENCE_CHAIN_LIMIT: usize = 8;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `{ rulesetId: state.ruleset_id }` для `combatSpellsFor`.
pub(crate) fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

/// `new Map(initiative.map((entry, index) => [String(entry.actor_id), index]))`.
fn initiative_order(state: &Value) -> IndexMap<String, usize> {
    let mut order = IndexMap::new();
    for (index, entry) in sk_core::game::combat(state).get("initiative").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
        order.insert(js::string(entry.get("actor_id")), index);
    }
    order
}

/// Порядок «по инициативе, затем по id» (`?? Number.MAX_SAFE_INTEGER`, `localeCompare`).
fn by_initiative(order: &IndexMap<String, usize>, left: &str, right: &str) -> Ordering {
    let rank = |id: &str| order.get(id).copied().unwrap_or(usize::MAX);
    rank(left).cmp(&rank(right)).then_with(|| sk_core::text::locale_compare(left, right))
}

/// Реакция у героя не потрачена (`action_economy[id]?.reaction !== false`).
fn reaction_available(state: &Value, id: &str) -> bool {
    !js::is_false(at(sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(id)), "reaction"))
}

/// `chooseSpellSlot(state, id, spell)` без запроса круга (отказа не бывает).
fn default_slot(state: &Value, id: &str, spell: &Value) -> Option<SpellSlot> {
    choose_spell_slot(state, id, Some(spell), None, None).ok().flatten()
}

/// `OPPORTUNITY_BLOCKING_CONDITIONS`: кто не может действовать, не ловит момент.
pub fn opportunity_blocking_conditions() -> &'static [&'static str] {
    crate::tables::incapacitating_conditions()
}

/// `opportunityAttackers(state, moverId, from, path)`: кто бьёт вдогонку
/// уходящего, по инициативе.
pub fn opportunity_attackers(state: &Value, mover_id: &str, from: Option<&Value>, path: &[Value]) -> Result<Vec<Value>, Halt> {
    if !sk_core::game::combat_active(state) || !js::truthy(from) || path.is_empty() {
        return Ok(Vec::new());
    }
    let mover_conditions = condition_ids_for(state, mover_id);
    if ["disengaged", "invisible", "zephyr-strike"].iter().any(|condition| mover_conditions.contains(*condition)) {
        return Ok(Vec::new());
    }
    let mover_is_enemy = sk_core::game::is_enemy_actor(state, mover_id);
    let order = initiative_order(state);
    let mover = sk_core::game::find_actor(state, mover_id);
    let mut attackers = Vec::new();
    for candidate in sk_core::game::list_actors(state) {
        let candidate_id = sk_core::game::actor_id(candidate);
        if candidate_id == mover_id || !sk_core::game::is_living_actor(candidate) || sk_core::game::is_enemy_actor(state, &candidate_id) == mover_is_enemy {
            continue;
        }
        if !reaction_available(state, &candidate_id) {
            continue;
        }
        let conditions = condition_ids_for(state, &candidate_id);
        if opportunity_blocking_conditions().iter().any(|condition| conditions.contains(*condition)) {
            continue;
        }
        let position = actor_point(state, &candidate_id).map(point_json);
        let opportunity = crate::combat::weapons::opportunity_attack_profile(state, Some(candidate))?;
        let (Some(opportunity), Some(position)) = (opportunity, position) else { continue };
        let reach = js::safe_int(opportunity.profile.get("range_feet"), 5).max(5) as f64;
        let distance = sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), mover, Some(&position), from).unwrap_or(f64::INFINITY);
        if distance > reach {
            continue;
        }
        if path.iter().any(|step| sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), mover, Some(&position), Some(step)).unwrap_or(0.0) > reach) {
            attackers.push(candidate.clone());
        }
    }
    attackers.sort_by(|left, right| by_initiative(&order, &sk_core::game::actor_id(left), &sk_core::game::actor_id(right)));
    Ok(attackers)
}

/// Параметры `reactionOptionsAfterAttack` (значения по умолчанию — как в JS).
#[derive(Debug, Clone)]
pub struct AttackReactionOptions {
    pub hit: bool,
    pub critical: bool,
    pub attack_total: f64,
    pub armor_class: f64,
    pub damage: Option<Value>,
    pub distance_feet: Option<f64>,
    pub allow_parry: bool,
    pub allow_riposte: bool,
}

impl Default for AttackReactionOptions {
    fn default() -> Self {
        Self { hit: false, critical: false, attack_total: 0.0, armor_class: 10.0, damage: None, distance_feet: None, allow_parry: false, allow_riposte: false }
    }
}

const ELEMENTAL_TYPES: [&str; 5] = ["acid", "cold", "fire", "lightning", "thunder"];

/// Вариант окна для реакции-заклинания.
fn spell_option(spell: &Value, slot: Option<&SpellSlot>) -> Value {
    let mut option = Map::new();
    option.insert("id".into(), Value::String(format!("cast:{}", js::string(spell.get("id")))));
    if let Some(name) = spell.get("name") {
        option.insert("name".into(), name.clone());
    }
    if let Some(description) = spell.get("description") {
        option.insert("description".into(), description.clone());
    }
    option.insert("resource".into(), slot.map(|slot| Value::String(slot.resource.clone())).unwrap_or(Value::Null));
    option.insert("slot_level".into(), slot.map(|slot| Value::from(slot.level)).or_else(|| spell.get("level").cloned()).unwrap_or(Value::Null));
    option.insert("cost".into(), Value::from(1));
    if let Some(id) = spell.get("id") {
        option.insert("spell_id".into(), id.clone());
    }
    Value::Object(option)
}

/// `safeInteger(damage?.applied_amount, 0) + safeInteger(damage?.temporary_hp_absorbed, 0)`.
fn damage_taken(damage: Option<&Value>) -> i64 {
    js::safe_int(at(damage, "applied_amount"), 0) + js::safe_int(at(damage, "temporary_hp_absorbed"), 0)
}

/// `reactionOptionsAfterAttack(state, target, options)`: реакции цели после
/// броска атаки (уклонение, парирование, ответный удар, «Щит»,
/// «Поглощение стихий», «Адское возмездие»).
pub fn reaction_options_after_attack(state: &Value, target: &Value, options: &AttackReactionOptions) -> Result<Vec<Value>, Halt> {
    let target_id = sk_core::game::actor_id(target);
    let damage = options.damage.as_ref();
    let hit_with_damage = options.hit && (js::number(at(damage, "applied_amount")) + js::safe_int(at(damage, "temporary_hp_absorbed"), 0) as f64) > 0.0;
    let allowed: Vec<&str> = if hit_with_damage {
        let mut ids = vec!["uncanny-dodge"];
        if options.allow_parry {
            ids.push("parry");
        }
        ids
    } else if !options.hit && options.allow_riposte {
        vec!["riposte"]
    } else {
        Vec::new()
    };
    let blinded = condition_ids_for(state, &target_id).contains("blinded");
    let mut result: Vec<Value> = sk_combat_content::combat_actions::combat_actions_for(Some(target))
        .into_iter()
        .filter(|candidate| candidate.get("actionType").and_then(Value::as_str) == Some("reaction") && allowed.contains(&js::s(candidate.get("id")).as_str()))
        .filter(|candidate| candidate.get("id").and_then(Value::as_str) != Some("uncanny-dodge") || !blinded)
        .filter(|candidate| {
            let resource = candidate.get("resource");
            !js::truthy(resource) || resource_pool(state, &target_id, &js::string(resource), 0).current >= js::safe_int(candidate.get("cost"), 1).max(1)
        })
        .map(|candidate| {
            let mut option = Map::new();
            for key in ["id", "name", "description"] {
                if let Some(value) = candidate.get(key) {
                    option.insert(key.into(), value.clone());
                }
            }
            option.insert("resource".into(), candidate.get("resource").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
            option.insert("cost".into(), candidate.get("cost").filter(|value| !value.is_null()).cloned().unwrap_or(Value::from(1)));
            Value::Object(option)
        })
        .collect();
    for spell in sk_combat_content::combat_spells::combat_spells_for(Some(target), Some(&ruleset_options(state))) {
        if spell.get("actionType").and_then(Value::as_str) != Some("reaction") || js::is_false(spell.get("prepared")) {
            continue;
        }
        if !spell_component_availability_for(state, Some(target), Some(&spell)).available {
            continue;
        }
        let slot = default_slot(state, &target_id, &spell);
        if js::number(spell.get("level")) > 0.0 && slot.is_none() {
            continue;
        }
        let taken = damage_taken(damage);
        let id = js::s(spell.get("id"));
        let damage_type = at(damage, "damage_type");
        let available = (id == "shield" && options.hit && !options.critical && options.attack_total < options.armor_class + 5.0)
            || (id == "absorb-elements"
                && options.hit
                && taken > 0
                && damage_type.and_then(Value::as_str).is_some_and(|kind| ELEMENTAL_TYPES.contains(&kind))
                && !js::truthy(crate::damage::damage_payload(state, &target_id, Some(&Value::from(1)), damage_type, None, None)?.get("immune")))
            || (id == "hellish-rebuke" && options.hit && taken > 0 && options.distance_feet.is_none_or(|distance| distance <= 60.0));
        if available {
            result.push(spell_option(&spell, slot.as_ref()));
        }
    }
    Ok(result)
}

/// `reactionOptionsAfterElementalDamage(state, target, damage)`: защитное
/// «Поглощение стихий» до урона области.
pub fn reaction_options_after_elemental_damage(state: &Value, target: Option<&Value>, damage: Option<&Value>) -> Vec<Value> {
    let Some(target) = target.filter(|target| sk_core::game::is_living_actor(target)) else { return Vec::new() };
    let target_id = sk_core::game::actor_id(target);
    if incapacitating_condition_for(state, &target_id).is_some() {
        return Vec::new();
    }
    let kind = sk_core::text::lower(&js::s(at(damage, "damage_type")));
    if damage_taken(damage) <= 0 || !ELEMENTAL_TYPES.contains(&kind.as_str()) {
        return Vec::new();
    }
    sk_combat_content::combat_spells::combat_spells_for(Some(target), Some(&ruleset_options(state)))
        .into_iter()
        .filter(|spell| spell.get("id").and_then(Value::as_str) == Some("absorb-elements") && spell.get("actionType").and_then(Value::as_str) == Some("reaction") && !js::is_false(spell.get("prepared")))
        .filter(|spell| spell_component_availability_for(state, Some(target), Some(spell)).available)
        .filter_map(|spell| {
            let slot = default_slot(state, &target_id, &spell);
            if js::number(spell.get("level")) > 0.0 && slot.is_none() {
                return None;
            }
            Some(spell_option(&spell, slot.as_ref()))
        })
        .collect()
}

/// Параметры `protectiveAttackReactionOptions`.
#[derive(Debug, Clone, Default)]
pub struct ProtectiveAttackOptions {
    pub hit: bool,
    pub critical: bool,
    pub attack_total: f64,
    pub armor_class: f64,
    /// `damageType` (`None` — `undefined`).
    pub damage_type: Option<Value>,
    pub distance_feet: Option<f64>,
}

/// `protectiveAttackReactionOptions(state, target, options)`: защиты героя
/// до исхода атаки («Щит», уклонение, «Поглощение стихий»).
pub fn protective_attack_reaction_options(state: &Value, target: Option<&Value>, options: &ProtectiveAttackOptions) -> Result<Vec<Value>, Halt> {
    let Some(target) = target else { return Ok(Vec::new()) };
    let target_id = sk_core::game::actor_id(target);
    if !options.hit
        || !sk_core::game::is_living_actor(target)
        || incapacitating_condition_for(state, &target_id).is_some()
        || sk_core::game::is_enemy_actor(state, &target_id)
        || !reaction_available(state, &target_id)
    {
        return Ok(Vec::new());
    }
    let mut damage = Map::new();
    damage.insert("applied_amount".into(), Value::from(1));
    if let Some(kind) = &options.damage_type {
        damage.insert("damage_type".into(), kind.clone());
    }
    let reaction = AttackReactionOptions {
        hit: true,
        critical: options.critical,
        attack_total: options.attack_total,
        armor_class: options.armor_class,
        damage: Some(Value::Object(damage)),
        distance_feet: options.distance_feet,
        allow_parry: false,
        allow_riposte: false,
    };
    Ok(reaction_options_after_attack(state, target, &reaction)?
        .into_iter()
        .filter(|option| matches!(option.get("id").and_then(Value::as_str), Some("cast:shield" | "uncanny-dodge" | "cast:absorb-elements")))
        .collect())
}

/// Союзная реакция на атаку врага по герою: защитник и его действие.
#[derive(Debug, Clone, PartialEq)]
pub struct AllyReactor {
    pub actor: Value,
    pub action: Value,
}

/// Вид союзной реакции.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllyReactionKind {
    /// «Острое словцо» барда Знаний.
    CuttingWords,
    /// Боевой стиль «Оборона».
    Protection,
}

/// `allyAttackReactionFor(state, attackerId, targetId, kind)`: первый по
/// инициативе союзник, который может ответить реакцией.
pub fn ally_attack_reaction_for(state: &Value, attacker_id: &str, target_id: &str, kind: AllyReactionKind) -> Option<AllyReactor> {
    if !sk_core::game::combat_active(state) || !sk_core::game::is_enemy_actor(state, attacker_id) || sk_core::game::is_enemy_actor(state, target_id) {
        return None;
    }
    let attacker_at = actor_point(state, attacker_id)?;
    let order = initiative_order(state);
    let mut reactors: Vec<AllyReactor> = state
        .get("players")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|candidate| {
            let id = sk_core::game::actor_id(candidate);
            if kind == AllyReactionKind::Protection && id == target_id {
                return None;
            }
            if !sk_core::game::is_living_actor(candidate) || incapacitating_condition_for(state, &id).is_some() || !reaction_available(state, &id) {
                return None;
            }
            if condition_ids_for(state, &id).contains("blinded") {
                return None;
            }
            let at_point = actor_point(state, &id)?;
            if !crate::geometry::forced::has_clear_actor_trajectory(state, &id, attacker_id, Some(at_point), Some(attacker_at), false) {
                return None;
            }
            let action = sk_combat_content::combat_actions::combat_actions_for(Some(candidate)).into_iter().find(|entry| {
                let entry_id = js::s(entry.get("id"));
                match kind {
                    AllyReactionKind::CuttingWords => entry_id == CUTTING_WORDS_ACTION_ID,
                    AllyReactionKind::Protection => PROTECTION_ACTION_IDS.contains(&entry_id.as_str()),
                }
            })?;
            match kind {
                AllyReactionKind::CuttingWords => {
                    if resource_pool(state, &id, "bardic_inspiration", 0).current < 1 {
                        return None;
                    }
                    let distance = crate::targets::distance_between_actors(state, &id, attacker_id)?;
                    if distance > 60.0 {
                        return None;
                    }
                }
                AllyReactionKind::Protection => {
                    if !sk_ruleset::character_progression::normalized_selected_feature_ids(Some(candidate)).iter().any(|feature| feature == "fighting-style-protection") || !crate::core::has_equipped_shield(Some(candidate)) {
                        return None;
                    }
                    let distance = crate::targets::distance_between_actors(state, &id, target_id)?;
                    if distance > 5.0 {
                        return None;
                    }
                }
            }
            Some(AllyReactor { actor: candidate.clone(), action })
        })
        .collect();
    reactors.sort_by(|left, right| by_initiative(&order, &sk_core::game::actor_id(&left.actor), &sk_core::game::actor_id(&right.actor)));
    reactors.into_iter().next()
}

/// `allyAttackReactionOption(reactor)`: вариант окна для союзной реакции.
pub fn ally_attack_reaction_option(reactor: &AllyReactor) -> Value {
    let action = &reactor.action;
    let mut option = Map::new();
    for key in ["id", "name", "description"] {
        if let Some(value) = action.get(key) {
            option.insert(key.into(), value.clone());
        }
    }
    option.insert("resource".into(), action.get("resource").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    option.insert("cost".into(), Value::from(1));
    option.insert("reactor_id".into(), Value::String(sk_core::game::actor_id(&reactor.actor)));
    Value::Object(option)
}

/// `shieldReactionOption(state, target)`: «Щит» цели, если он готов.
pub fn shield_reaction_option(state: &Value, target: Option<&Value>) -> Option<Value> {
    let target = target?;
    let target_id = sk_core::game::actor_id(target);
    if !sk_core::game::is_living_actor(target) || incapacitating_condition_for(state, &target_id).is_some() || !reaction_available(state, &target_id) {
        return None;
    }
    let spell = sk_combat_content::combat_spells::combat_spells_for(Some(target), Some(&ruleset_options(state)))
        .into_iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some("shield") && !js::is_false(candidate.get("prepared")))?;
    let slot = default_slot(state, &target_id, &spell)?;
    if !spell_component_availability_for(state, Some(target), Some(&spell)).available {
        return None;
    }
    let mut option = Map::new();
    option.insert("id".into(), Value::String("cast:shield".into()));
    if let Some(name) = spell.get("name") {
        option.insert("name".into(), name.clone());
    }
    if let Some(description) = spell.get("description") {
        option.insert("description".into(), description.clone());
    }
    option.insert("resource".into(), Value::String(slot.resource));
    option.insert("slot_level".into(), Value::from(slot.level));
    option.insert("cost".into(), Value::from(1));
    if let Some(id) = spell.get("id") {
        option.insert("spell_id".into(), id.clone());
    }
    Some(Value::Object(option))
}

/// `shieldConditionEvent(command, targetId)`.
pub fn shield_condition_event(command: &Value, target_id: &str) -> Value {
    let source = command_with_rules(&command_with(command, "actor_id", Value::String(target_id.into())), &[rule_ids::CONDITIONS]);
    event_from(
        &source,
        "ConditionAdded",
        Some(json!({ "condition": "shielded", "duration": "until-next-turn", "source_actor": target_id, "spell_id": "shield" })),
        Some(&json!([target_id])),
    )
}

/// `absorbElementsConditionEvents(command, targetId, damageType, slotLevel = 1)`.
/// `slot_level: None` — значение по умолчанию `1`.
/// `absorbedRiderDamageType(condition)`: вид урона добавки «Поглощения
/// стихий». Без `rider_damage_type` (мусор старого сохранения) вид — хвост id
/// `absorbing-element-rider:<вид>`, пустой — `elemental`.
pub fn absorbed_rider_damage_type(condition: &Value) -> String {
    if let Some(kind) = condition.get("rider_damage_type").filter(|value| !value.is_null()) {
        return js::string(Some(kind));
    }
    let id = match condition.get("id").filter(|value| !value.is_null()) {
        Some(id) => js::string(Some(id)),
        None if condition.is_null() => String::new(),
        None => js::string(Some(condition)),
    };
    let kind = id.strip_prefix("absorbing-element-rider:").unwrap_or(&id);
    if kind.is_empty() { "elemental".to_string() } else { kind.to_string() }
}

pub fn absorb_elements_condition_events(command: &Value, target_id: &str, damage_type: Option<&Value>, slot_level: Option<&Value>) -> Vec<Value> {
    let source = command_with_rules(&command_with(command, "actor_id", Value::String(target_id.into())), &[rule_ids::CONDITIONS]);
    let kind = js::string(damage_type);
    let slot = match slot_level {
        None => 1,
        Some(value) => js::safe_int(Some(value), 1),
    }
    .max(1);
    let name = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&json!("absorb-elements")), None)
        .and_then(|spell| spell.get("name").filter(|value| !value.is_null()).cloned())
        .unwrap_or_else(|| Value::String("Поглощение стихий".into()));
    let targets = json!([target_id]);
    let mut rider = Map::new();
    rider.insert("condition".into(), Value::String(format!("absorbing-element-rider:{kind}")));
    rider.insert("duration".into(), Value::String("until-next-own-turn-end".into()));
    rider.insert("source_actor".into(), Value::String(target_id.into()));
    rider.insert("spell_id".into(), Value::String("absorb-elements".into()));
    rider.insert("slot_level".into(), Value::from(slot));
    rider.insert("rider_damage".into(), Value::String("1d6".into()));
    rider.insert("rider_damage_type".into(), damage_type.cloned().unwrap_or(Value::Null));
    if damage_type.is_none() {
        rider.shift_remove("rider_damage_type");
    }
    rider.insert("rider_source_name".into(), name);
    vec![
        event_from(
            &source,
            "ConditionAdded",
            Some(json!({ "condition": format!("absorbing-element:{kind}"), "duration": "until-next-turn", "source_actor": target_id, "spell_id": "absorb-elements" })),
            Some(&targets),
        ),
        event_from(&source, "ConditionAdded", Some(Value::Object(rider)), Some(&targets)),
    ]
}

/// `absorbElementsDamagePayload(damage, state, targetId)`: урон после
/// «Поглощения стихий» (сопротивление стихии на этот удар).
pub fn absorb_elements_damage_payload(damage: &Value, state: &Value, target_id: &str) -> Result<Value, Halt> {
    if js::truthy(damage.get("resistant")) || js::truthy(damage.get("immune")) {
        let mut map = spread_value(Some(damage));
        map.insert("absorb_elements_prevented".into(), Value::from(0));
        return Ok(Value::Object(map));
    }
    let mut defended = state.clone();
    let kind = js::string(damage.get("damage_type"));
    let mut list: Vec<Value> = sk_core::game::conditions(state, target_id).to_vec();
    list.push(json!({ "id": format!("absorbing-element:{kind}") }));
    if let Some(all) = defended.get_mut("mechanics").and_then(|mechanics| mechanics.get_mut("conditions")).and_then(Value::as_object_mut) {
        all.insert(target_id.into(), Value::Array(list));
    }
    let cantrip = if js::number(damage.get("resistance_cantrip_reduction")) > 0.0 {
        let mut map = Map::new();
        map.insert("reduction".into(), damage.get("resistance_cantrip_reduction").cloned().unwrap_or(Value::Null));
        for (key, field) in [("condition_id", "resistance_cantrip_condition"), ("turn_key", "resistance_cantrip_turn"), ("roll_id", "resistance_cantrip_roll_id")] {
            if let Some(value) = damage.get(field) {
                map.insert(key.into(), value.clone());
            }
        }
        Some(Value::Object(map))
    } else {
        None
    };
    let adjusted = crate::damage::damage_payload(&defended, target_id, damage.get("raw_amount"), damage.get("damage_type"), cantrip.as_ref(), None)?;
    let mut result = spread_value(Some(damage));
    result.shift_remove("death_ward_triggered");
    result.shift_remove("relentless_endurance_triggered");
    for (key, value) in spread_value(Some(&adjusted)) {
        result.insert(key, value);
    }
    let prevented = js::number(damage.get("applied_amount")) + js::number(damage.get("temporary_hp_absorbed")) - js::number(adjusted.get("applied_amount")) - js::number(adjusted.get("temporary_hp_absorbed"));
    result.insert("absorb_elements_prevented".into(), js::num(js::max_of([0.0, prevented])));
    Ok(Value::Object(result))
}

/// Урон после реакции, которая сняла часть удара: хиты и временные хиты.
fn reduce_damage(damage: Option<&Value>, prevented: i64) -> (i64, i64, i64, i64, i64) {
    let temporary_before = js::safe_int(at(damage, "temporary_hp_before"), 0).max(0);
    let hp_before = js::safe_int(at(damage, "hp_before"), 0).max(0);
    let original = (js::safe_int(at(damage, "temporary_hp_absorbed"), 0) + js::safe_int(at(damage, "applied_amount"), 0)).max(0);
    let prevented = original.min(prevented);
    let reduced = original - prevented;
    let temporary_after = (temporary_before - reduced).max(0);
    let hp_after = (hp_before - (reduced - temporary_before).max(0)).max(0);
    (prevented, temporary_before, hp_before, temporary_after, hp_after)
}

/// `uncannyDodgeDamagePayload(damage)`: «Невероятное уклонение» вдвое.
pub fn uncanny_dodge_damage_payload(damage: &Value) -> Value {
    let original = (js::safe_int(damage.get("applied_amount"), 0) + js::safe_int(damage.get("temporary_hp_absorbed"), 0)).max(0);
    let half = (original as f64 / 2.0).ceil() as i64;
    let (prevented, temporary_before, hp_before, temporary_after, hp_after) = reduce_damage(Some(damage), original.min(half));
    let mut map = spread_value(Some(damage));
    map.insert("applied_amount".into(), Value::from((hp_before - hp_after).max(0)));
    map.insert("temporary_hp_absorbed".into(), Value::from((temporary_before - temporary_after).max(0)));
    map.insert("temporary_hp_after".into(), Value::from(temporary_after));
    map.insert("hp_after".into(), Value::from(hp_after));
    map.insert("uncanny_dodge_prevented".into(), Value::from(prevented));
    Value::Object(map)
}

/// `reducedReactionDamage(damage, preventedAmount)`.
pub fn reduced_reaction_damage(damage: Option<&Value>, prevented_amount: Option<&Value>) -> Value {
    let (prevented, _, _, temporary_after, hp_after) = reduce_damage(damage, js::safe_int(prevented_amount, 0).max(0));
    json!({
        "prevented_amount": prevented,
        "hp_before": js::safe_int(at(damage, "hp_after"), hp_after).max(0),
        "hp_after": hp_after,
        "temporary_hp_before": js::safe_int(at(damage, "temporary_hp_after"), temporary_after).max(0),
        "temporary_hp_after": temporary_after,
    })
}

/// Заклинатель реакции: существо, заклинание и ячейка.
#[derive(Debug, Clone, PartialEq)]
pub struct SpellReactor {
    pub actor: Value,
    pub spell: Value,
    pub slot: SpellSlot,
}

/// Герои отряда и призванные отрядом с живой реакцией.
fn party_reactors(state: &Value) -> Vec<&Value> {
    let players = state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let summons = state.get("actors").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    players
        .iter()
        .chain(summons.iter().filter(|candidate| sk_combat_content::combat_spells::is_party_summon(Some(candidate))))
        .filter(|candidate| sk_core::game::is_living_actor(candidate) && reaction_available(state, &sk_core::game::actor_id(candidate)))
        .collect()
}

/// Заклинатель `spell_id` в пределах дальности и видимости `source_id`.
fn spell_reactor(state: &Value, candidate: &Value, spell_id: &str, source_id: &str, range: impl Fn(&Value) -> f64) -> Option<SpellReactor> {
    let id = sk_core::game::actor_id(candidate);
    let spell = sk_combat_content::combat_spells::combat_spells_for(Some(candidate), Some(&ruleset_options(state)))
        .into_iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(spell_id) && !js::is_false(entry.get("prepared")));
    let slot = spell.as_ref().and_then(|spell| default_slot(state, &id, spell));
    let distance = crate::targets::distance_between_actors(state, &id, source_id);
    let from = actor_point(state, &id);
    let to = actor_point(state, source_id);
    let (spell, slot) = (spell?, slot?);
    if !spell_component_availability_for(state, Some(candidate), Some(&spell)).available {
        return None;
    }
    let distance = distance?;
    if distance > range(&spell) || from.is_none() || to.is_none() || !crate::geometry::forced::has_clear_actor_trajectory(state, &id, source_id, from, to, false) {
        return None;
    }
    Some(SpellReactor { actor: candidate.clone(), spell, slot })
}

/// `counterspellReactionFor(state, casterId)`: кто из отряда может сбить
/// заклинание врага.
pub fn counterspell_reaction_for(state: &Value, caster_id: &str) -> Option<SpellReactor> {
    if !sk_core::game::is_enemy_actor(state, caster_id) {
        return None;
    }
    let order = initiative_order(state);
    let mut reactors: Vec<SpellReactor> = party_reactors(state).into_iter().filter_map(|candidate| spell_reactor(state, candidate, "counterspell", caster_id, |spell| js::number(spell.get("range")))).collect();
    reactors.sort_by(|left, right| by_initiative(&order, &sk_core::game::actor_id(&left.actor), &sk_core::game::actor_id(&right.actor)));
    reactors.into_iter().next()
}

/// `silveryBarbsReactionFor(state, sourceActorId, preferredActorId = null)`.
pub fn silvery_barbs_reaction_for(state: &Value, source_actor_id: &str, preferred_actor_id: Option<&str>) -> Option<SpellReactor> {
    let order = initiative_order(state);
    let mut reactors: Vec<SpellReactor> = party_reactors(state).into_iter().filter_map(|candidate| spell_reactor(state, candidate, "silvery-barbs", source_actor_id, |_| 60.0)).collect();
    let preferred = |reactor: &SpellReactor| preferred_actor_id.is_some_and(|preferred| sk_core::game::actor_id(&reactor.actor) == preferred);
    reactors.sort_by(|left, right| {
        preferred(right).cmp(&preferred(left)).then_with(|| by_initiative(&order, &sk_core::game::actor_id(&left.actor), &sk_core::game::actor_id(&right.actor)))
    });
    reactors.into_iter().next()
}

/// `counterspellWindowFor(state, command, spell)`: окно контрзаклинания при
/// заклинании врага (или `None`).
pub fn counterspell_window_for(state: &Value, command: &Value, spell: &Value) -> Option<Value> {
    if js::truthy(command.get("counterspell_bypassed")) {
        return None;
    }
    let actor_id = js::s(command.get("actor_id"));
    if sk_core::game::uses_2014(state) {
        if let Some(components) = spell.get("components").filter(|value| js::truthy(Some(value))) {
            let subtle = condition_ids_for(state, &js::string(command.get("actor_id"))).contains("metamagic-subtle");
            let special = matches!(components.get("special"), Some(Value::Array(items)) if !items.is_empty()) || matches!(components.get("special"), Some(Value::String(text)) if !text.is_empty());
            let perceptible = js::truthy(components.get("material")) || special || (!subtle && (js::truthy(components.get("verbal")) || js::truthy(components.get("somatic"))));
            if !perceptible {
                return None;
            }
        }
    }
    let reaction = counterspell_reaction_for(state, &actor_id)?;
    let mut option = Map::new();
    option.insert("id".into(), Value::String("cast:counterspell".into()));
    if let Some(name) = reaction.spell.get("name") {
        option.insert("name".into(), name.clone());
    }
    if let Some(description) = reaction.spell.get("description") {
        option.insert("description".into(), description.clone());
    }
    option.insert("resource".into(), Value::String(reaction.slot.resource.clone()));
    option.insert("slot_level".into(), Value::from(reaction.slot.level));
    option.insert("cost".into(), Value::from(1));
    if let Some(id) = reaction.spell.get("id") {
        option.insert("spell_id".into(), id.clone());
    }
    let option = Value::Object(option);
    let reactor_id = sk_core::game::actor_id(&reaction.actor);
    let mut pending_spell = Map::new();
    for key in ["id", "name", "level"] {
        if let Some(value) = spell.get(key) {
            pending_spell.insert(key.into(), value.clone());
        }
    }
    // `command.slot_level ?? spell.level`: без значения слева — правое как есть.
    let slot_level = crate::core::coalesce(&[command.get("slot_level")]).or_else(|| spell.get("level"));
    if let Some(slot_level) = slot_level {
        pending_spell.insert("slot_level".into(), slot_level.clone());
    }
    if let Some(url) = spell.get("sourceUrl") {
        pending_spell.insert("source_url".into(), url.clone());
    }
    let mut payload = Map::new();
    payload.insert("id".into(), Value::String(format!("reaction:{}:counterspell", js::string(command.get("command_id")))));
    payload.insert("trigger".into(), Value::String("spell-cast".into()));
    payload.insert("actor_id".into(), Value::String(reactor_id.clone()));
    if let Some(source) = command.get("actor_id") {
        payload.insert("source_actor_id".into(), source.clone());
        payload.insert("target_id".into(), source.clone());
    }
    payload.insert("action_ids".into(), json!(["cast:counterspell"]));
    payload.insert("action_options".into(), Value::Array(vec![option]));
    payload.insert("pending_spell_command".into(), command.clone());
    payload.insert("pending_spell".into(), Value::Object(pending_spell));
    payload.insert("damage".into(), Value::Null);
    Some(event_from(&command_with_rules(command, &[rule_ids::REACTION]), "ReactionWindowOpened", Some(Value::Object(payload)), Some(&json!([reactor_id]))))
}

/// `heroReactionModesFor(state, heroId)`: реакции героя, которым можно задать
/// режим, с текущим режимом.
pub fn hero_reaction_modes_for(state: &Value, hero_id: Option<&Value>) -> Vec<Value> {
    let id = js::s(hero_id);
    let Some(hero) = state.get("players").and_then(Value::as_array).and_then(|players| players.iter().find(|player| sk_core::game::actor_id(player) == id)) else { return Vec::new() };
    let mut entries = vec![json!({ "id": "opportunity-attack", "name": "Атака по возможности", "kind": "action" })];
    let options = ruleset_options(state);
    for spell_id in REACTION_PREFERENCE_SPELL_IDS {
        let spell = sk_combat_content::combat_spells::combat_spell_for(Some(hero), Some(&json!(spell_id)), Some(&options));
        if let Some(spell) = spell.filter(|spell| spell.get("actionType").and_then(Value::as_str) == Some("reaction")) {
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(format!("cast:{}", js::string(spell.get("id")))));
            if let Some(name) = spell.get("name") {
                entry.insert("name".into(), name.clone());
            }
            entry.insert("kind".into(), Value::String("spell".into()));
            if let Some(spell_id) = spell.get("id") {
                entry.insert("spell_id".into(), spell_id.clone());
            }
            entries.push(Value::Object(entry));
        }
    }
    for action_id in REACTION_PREFERENCE_ACTION_IDS {
        let action = sk_combat_content::combat_actions::combat_action_for(Some(hero), Some(&json!(action_id)));
        if let Some(action) = action.filter(|action| action.get("actionType").and_then(Value::as_str) == Some("reaction")) {
            let mut entry = Map::new();
            if let Some(id) = action.get("id") {
                entry.insert("id".into(), id.clone());
            }
            if let Some(name) = action.get("name") {
                entry.insert("name".into(), name.clone());
            }
            entry.insert("kind".into(), Value::String("action".into()));
            entries.push(Value::Object(entry));
        }
    }
    let preferences = sk_core::game::mechanics(state).get("reaction_preferences");
    entries
        .into_iter()
        .filter(|entry| sk_combat_base::reaction_preferences::is_configurable_reaction(entry.get("id")))
        .map(|entry| {
            let mut map = spread_value(Some(&entry));
            let mode = sk_combat_base::reaction_preferences::reaction_mode_for(preferences, &id, &js::s(entry.get("id")));
            map.insert("mode".into(), Value::String(mode.into()));
            Value::Object(map)
        })
        .collect()
}
