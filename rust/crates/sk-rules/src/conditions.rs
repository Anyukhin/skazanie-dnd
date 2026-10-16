//! Состояния: преимущество и помеха проверок, модификаторы спасбросков, страх, истощение, состояния заклинаний. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 10487–10490 («Свобода перемещения»),
//! 10516–10556 (области: кого щадит, кого держит, автоспасбросок), 10775
//! (`blessBonusEnabled`), 10945 (`checkAdvantageConditionFor`), 11162–11235
//! (автопровал, надбавки, кости урона, преимущество и помеха спасбросков),
//! 11347–11448 (длительность заклинания 2014, истощение, прибавка к максимуму
//! хитов).
//!
//! Таблица состояний — `crate::tables::condition_effects` (Р0); обход
//! `Object.keys(CONDITION_EFFECTS)` идёт в порядке таблицы.

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, condition_ids_for, event_from};
use crate::tables::{condition_effect, condition_effects};

// --- общие помощники чтения (для соседей задачи Р2) ------------------------

/// `value?.[key]`: поле объекта; у не-объекта полей нет.
pub(crate) fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `value?.a?.b?.c`.
pub(crate) fn at_path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| current.as_object()?.get(*key))
}

/// `(value ?? []).includes(needle)`: у массива — строгое равенство элемента
/// строке, у строки — подстрока (как `String.prototype.includes`); прочее не
/// содержит ничего.
pub(crate) fn includes_str(value: Option<&Value>, needle: &str) -> bool {
    match value {
        Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some(needle)),
        Some(Value::String(text)) => text.contains(needle),
        _ => false,
    }
}

/// `a ?? b ?? … ?? z`: первое не-`null`/`undefined`; если таких нет —
/// последнее значение цепочки как есть (`null` или `undefined`).
pub(crate) fn nullish_chain<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    for value in values {
        if js::present(*value) {
            return *value;
        }
    }
    values.last().copied().flatten()
}

/// `String(x)` для необязательной характеристики: `undefined` и `null` — как в JS.
fn ability_text(ability: Option<&Value>) -> String {
    js::string(ability)
}

/// Имена состояний таблицы в порядке `Object.keys(CONDITION_EFFECTS)`.
fn table_keys() -> Vec<&'static String> {
    condition_effects().as_object().map(js::keys).unwrap_or_default()
}

/// `Object.keys(CONDITION_EFFECTS).find((condition) => conditions.has(condition) && test(effect))`.
fn first_table_condition(state: &Value, id: &str, test: impl Fn(&str, &Value) -> bool) -> Option<String> {
    let conditions = condition_ids_for(state, id);
    let table = condition_effects();
    table_keys().into_iter().find(|key| conditions.contains(key.as_str()) && table.get(key.as_str()).is_some_and(|effect| test(key, effect))).cloned()
}

// --- «Свобода перемещения» (10487–10490) ------------------------------------

/// `FREEDOM_BLOCKED_SPELL_CONDITIONS`.
pub const FREEDOM_BLOCKED_SPELL_CONDITIONS: [&str; 3] = ["paralyzed", "restrained", "rime-encased"];

/// `freedomBlocksSpellCondition(state, targetId, condition)`; `condition` —
/// уже `String(condition)`.
pub fn freedom_blocks_spell_condition(state: &Value, target_id: &str, condition: &str) -> bool {
    FREEDOM_BLOCKED_SPELL_CONDITIONS.contains(&condition) && condition_ids_for(state, target_id).contains("freedom-of-movement")
}

// --- области (10516–10556) ----------------------------------------------------

/// `areaEffectSparesActor(effect, actorId)`: заклинатель назначил существо незатронутым.
pub fn area_effect_spares_actor(effect: Option<&Value>, actor_id: &str) -> bool {
    match at(effect, "unaffected_actor_ids") {
        Some(Value::Array(ids)) => ids.iter().any(|id| js::string(Some(id)) == actor_id),
        _ => false,
    }
}

/// `areaEffectAlreadyHolds(state, effect, actorId)`: удерживаемый этой же
/// областью не проверяется снова.
pub fn area_effect_already_holds(state: &Value, effect: Option<&Value>, actor_id: &str) -> bool {
    if !js::is_true(at(effect, "skip_already_affected")) || !js::truthy(at(effect, "condition")) {
        return false;
    }
    let effect_id = js::s(nullish_chain(&[at(effect, "effect_id"), at(effect, "id")]));
    let condition = js::string(at(effect, "condition"));
    sk_core::game::conditions(state, actor_id)
        .iter()
        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(condition.as_str()) && js::s(entry.get("effect_id")) == effect_id)
}

/// `actorDoesNotNeedBreathing(actor)`.
pub fn actor_does_not_need_breathing(actor: Option<&Value>) -> bool {
    let mechanics = nullish_chain(&[at_path(actor, &["speciesBenefits", "mechanics"]), at(actor, "mechanics")]);
    let traits = nullish_chain(&[at(actor, "traits"), at(actor, "special_traits"), at(actor, "specialTraits")]);
    let flag = |value: Option<&Value>, key: &str| js::is_true(at(value, key));
    flag(actor, "cannot_breathe")
        || flag(actor, "cannotBreathe")
        || flag(actor, "does_not_need_to_breathe")
        || flag(actor, "doesNotNeedToBreathe")
        || flag(actor, "breathless")
        || flag(mechanics, "cannot_breathe")
        || flag(mechanics, "does_not_need_to_breathe")
        || flag(traits, "cannot_breathe")
        || flag(traits, "does_not_need_to_breathe")
}

/// `areaEffectAutomaticSave(state, actorId, effect)`: `{ saved, reason }`.
pub fn area_effect_automatic_save(state: &Value, actor_id: &str, effect: Option<&Value>) -> Value {
    let actor = sk_core::game::find_actor(state, actor_id);
    let condition = sk_core::text::lower(&js::s(at(effect, "condition")));
    let immunities = crate::damage::stat_block_condition_immunities(state, actor_id);
    if !condition.is_empty() && immunities.contains(&condition) {
        return json!({ "saved": true, "reason": condition });
    }
    let save_damage_type = sk_core::text::lower(&js::s(at(effect, "save_damage_type")));
    if !save_damage_type.is_empty() && crate::damage::defense_for(state, actor_id).immunities.contains(&save_damage_type) {
        return json!({ "saved": true, "reason": save_damage_type });
    }
    if js::is_true(at(effect, "requires_breathing")) && actor_does_not_need_breathing(actor) {
        return json!({ "saved": true, "reason": "no-breathing" });
    }
    json!({ "saved": false, "reason": null })
}

// --- благословение и преимущество проверок (10775, 10945) -------------------

/// `blessBonusEnabled(state, id)`: у получателя «Благословения» бонус не выключен.
pub fn bless_bonus_enabled(state: &Value, id: &str) -> bool {
    sk_core::game::conditions(state, id)
        .iter()
        .any(|condition| sk_core::game::condition_id(condition) == "bless-d4" && !js::is_false(condition.get("bonus_enabled")))
}

/// `checkAdvantageConditionFor(state, id, ability)`.
pub fn check_advantage_condition_for(state: &Value, id: &str, ability: Option<&Value>) -> Option<String> {
    if !js::truthy(ability) {
        return None;
    }
    let ability = ability_text(ability);
    first_table_condition(state, id, |_, effect| includes_str(effect.get("checkAdvantageAbilities"), &ability))
}

// --- спасброски и надбавки (11162–11235) ------------------------------------

/// `autoFailedSaveConditionFor(state, id, ability)`: состояние автопровала спасброска.
pub fn auto_failed_save_condition_for(state: &Value, id: &str, ability: Option<&Value>) -> Option<String> {
    if !js::truthy(ability) {
        return None;
    }
    let ability = ability_text(ability);
    first_table_condition(state, id, |_, effect| includes_str(effect.get("autoFailedSaves"), &ability))
}

/// `conditionNumericBonus(state, id, field)`.
pub fn condition_numeric_bonus(state: &Value, id: &str, field: &str) -> i64 {
    condition_ids_for(state, id).iter().map(|condition| js::safe_int(condition_effect(condition).and_then(|effect| effect.get(field)), 0)).sum()
}

/// Кость урона от состояния: `{ condition, expression, sign }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionDie {
    pub condition: String,
    pub expression: String,
    pub sign: i64,
}

impl ConditionDie {
    pub fn to_value(&self) -> Value {
        json!({ "condition": self.condition, "expression": self.expression, "sign": self.sign })
    }
}

/// `conditionWeaponDamageDice(state, id, distanceFeet)`.
pub fn condition_weapon_damage_dice(state: &Value, id: &str, distance_feet: Option<f64>) -> Vec<ConditionDie> {
    let mut dice = Vec::new();
    for condition in condition_ids_for(state, id) {
        let effect = condition_effect(&condition);
        let limit = js::safe_int(effect.and_then(|effect| effect.get("weaponDamageDiceWithinFeet")), 0);
        if limit > 0 && distance_feet.is_some_and(|distance| distance > limit as f64) {
            continue;
        }
        if let Some(expression) = effect.and_then(|effect| effect.get("weaponDamageDice")).filter(|value| js::truthy(Some(value))) {
            dice.push(ConditionDie { condition: condition.clone(), expression: js::string(Some(expression)), sign: 1 });
        }
        if let Some(expression) = effect.and_then(|effect| effect.get("weaponDamagePenaltyDice")).filter(|value| js::truthy(Some(value))) {
            dice.push(ConditionDie { condition: condition.clone(), expression: js::string(Some(expression)), sign: -1 });
        }
    }
    dice
}

/// `saveAdvantageConditionFor(state, id, ability)`.
pub fn save_advantage_condition_for(state: &Value, id: &str, ability: Option<&Value>) -> Option<String> {
    if !js::truthy(ability) {
        return None;
    }
    let ability = ability_text(ability);
    first_table_condition(state, id, |_, effect| includes_str(effect.get("saveAdvantageAbilities"), &ability))
}

/// `conditionSaveBonusFor(state, id, ability)`.
pub fn condition_save_bonus_for(state: &Value, id: &str, ability: Option<&Value>) -> i64 {
    if !js::truthy(ability) {
        return 0;
    }
    let ability = ability_text(ability);
    condition_ids_for(state, id)
        .iter()
        .map(|condition| js::safe_int(condition_effect(condition).and_then(|effect| effect.get("saveBonusAbilities")).and_then(|bonuses| at(Some(bonuses), &ability)), 0))
        .sum()
}

/// `saveDisadvantageConditionFor(state, id, ability)`.
pub fn save_disadvantage_condition_for(state: &Value, id: &str, ability: Option<&Value>) -> Option<String> {
    if !js::truthy(ability) {
        return None;
    }
    let ability = ability_text(ability);
    first_table_condition(state, id, |_, effect| includes_str(effect.get("saveDisadvantageAbilities"), &ability))
}

/// `savingThrowAgainstCondition(condition, purpose)`: `{ spell, against }`.
pub fn saving_throw_against_condition(condition: Option<&Value>, purpose: Option<&Value>) -> (Option<Value>, String) {
    let purpose = js::s(purpose);
    let spell = sk_core::re!(r"spell(?:_[a-z]+)*_save:([^:]+)", "u")
        .captures(&purpose)
        .ok()
        .flatten()
        .and_then(|captures| captures.get(1).map(|found| found.as_str().to_string()))
        .and_then(|spell_id| sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&Value::String(spell_id)), None));
    let against = match condition.filter(|value| !value.is_null()) {
        Some(condition) => js::s(Some(condition)),
        None => js::s(nullish_chain(&[
            spell.as_ref().and_then(|spell| spell.get("conditions")).and_then(|list| list.get(0)),
            spell.as_ref().and_then(|spell| spell.get("onHitConditions")).and_then(|list| list.get(0)),
        ])),
    };
    (spell, against)
}

/// `saveAdvantageAgainstConditionFor(state, id, { condition, purpose })`.
pub fn save_advantage_against_condition_for(state: &Value, id: &str, condition: Option<&Value>, purpose: Option<&Value>) -> Option<String> {
    let (_, against) = saving_throw_against_condition(condition, purpose);
    if against.is_empty() {
        return None;
    }
    let base = against.split(':').next().unwrap_or_default().to_string();
    first_table_condition(state, id, |_, effect| includes_str(effect.get("saveAdvantageAgainstConditions"), &base))
}

// --- длительность заклинания 2014, истощение, максимум хитов (11347–11448) ----

/// `safeInteger(value, fallback)` с дробным запасом (запас JS — любое число).
pub(crate) fn safe_int_or(value: Option<&Value>, fallback: f64) -> f64 {
    if js::is_safe_integer_number(value) {
        js::number(value)
    } else {
        fallback
    }
}

/// `spellTimedConditionPayload(state, command, spell, { extended })`: поля
/// длительности состояния от заклинания с таймером 2014.
pub fn spell_timed_condition_payload(state: &Value, command: &Value, spell: &Value, extended: bool) -> Map<String, Value> {
    let policy = sk_combat_content::combat_spells::DND_2014_TIMED_BUFF_EXPIRY_POLICY;
    if !sk_core::game::uses_2014(state) || spell.get("conditionExpiryPolicy").and_then(Value::as_str) != Some(policy) {
        return Map::new();
    }
    let level = js::number(spell.get("level"));
    // `safeInteger(x, spell.level)`: запас `undefined` — значение по умолчанию 0.
    let fallback = if spell.get("level").is_none() { 0.0 } else { level };
    let slot_level = crate::tactical_geometry::js_max(level, safe_int_or(command.get("slot_level"), fallback));
    let by_slot = at(spell.get("conditionDurationSecondsBySlotLevel"), &js::f64_string(slot_level));
    let base = js::safe_int(nullish_chain(&[by_slot, spell.get("conditionDurationSeconds")]), 0).max(0);
    if base == 0 {
        return Map::new();
    }
    let seconds = if extended { (base * 2).min(86_400) } else { base };
    let started = crate::world_clock::world_time_seconds(state);
    let mut payload = Map::new();
    let duration = if js::truthy(spell.get("concentration")) { "concentration".to_string() } else { format!("seconds:{seconds}") };
    payload.insert("duration".into(), Value::String(duration));
    payload.insert("expiry_policy".into(), Value::String(policy.into()));
    payload.insert("timing_version".into(), Value::from(2));
    payload.insert("started_at_seconds".into(), js::num(started));
    payload.insert("expires_at_seconds".into(), js::num(started + seconds as f64));
    payload
}

/// `exhaustionLevelOf(state, id)`: ступень истощения 0–6.
pub fn exhaustion_level_of(state: &Value, id: &str) -> i64 {
    let mut level = 0;
    for condition in condition_ids_for(state, id) {
        if let Some(rest) = condition.strip_prefix("exhaustion:") {
            level = level.max(js::safe_int(Some(&Value::String(rest.to_string())), 0));
        }
    }
    level.clamp(0, 6)
}

/// `EXHAUSTION_LADDER`: цель снятия «истощение» одним словом.
pub const EXHAUSTION_LADDER: &str = "exhaustion";

/// `exhaustionStepDownEvents(state, command, targetId, spellId)`.
pub fn exhaustion_step_down_events(state: &Value, command: &Value, target_id: &str, spell_id: Option<&Value>) -> Vec<Value> {
    let level = exhaustion_level_of(state, target_id);
    if level <= 0 {
        return Vec::new();
    }
    let source = command_with_rules(command, &[rule_ids::CONDITIONS]);
    let targets = json!([target_id]);
    let spell = spell_id.filter(|value| js::truthy(Some(value)));
    let mut removed = Map::new();
    removed.insert("condition".into(), Value::String(format!("exhaustion:{level}")));
    removed.insert("reason".into(), Value::String("restoration".into()));
    if let Some(spell) = spell {
        removed.insert("spell_id".into(), spell.clone());
    }
    let mut events = vec![event_from(&source, "ConditionRemoved", Some(Value::Object(removed)), Some(&targets))];
    if level > 1 {
        let mut added = Map::new();
        added.insert("condition".into(), Value::String(format!("exhaustion:{}", level - 1)));
        added.insert("exhaustion_level".into(), Value::from(level - 1));
        added.insert("duration".into(), Value::String("until-removed".into()));
        added.insert("reason".into(), Value::String("restoration".into()));
        if let Some(spell) = spell {
            added.insert("spell_id".into(), spell.clone());
        }
        events.push(event_from(&source, "ConditionAdded", Some(Value::Object(added)), Some(&targets)));
    }
    events
}

/// Источник подъёма истощения (`{ sourceActor, effectId, spellId, trigger }`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ExhaustionSource<'a> {
    pub source_actor: Option<&'a Value>,
    pub effect_id: Option<&'a Value>,
    pub spell_id: Option<&'a Value>,
    pub trigger: Option<&'a Value>,
}

/// `exhaustionStepUpEvents(state, command, targetId, source)`.
pub fn exhaustion_step_up_events(state: &Value, command: &Value, target_id: &str, source: ExhaustionSource<'_>) -> Vec<Value> {
    let level = exhaustion_level_of(state, target_id);
    if level >= 6 {
        return Vec::new();
    }
    let rules = command_with_rules(command, &[rule_ids::CONDITIONS]);
    let targets = json!([target_id]);
    let truthy = |value: Option<&Value>| value.filter(|value| js::truthy(Some(value))).cloned();
    let mut events = Vec::new();
    if level > 0 {
        let mut removed = Map::new();
        removed.insert("condition".into(), Value::String(format!("exhaustion:{level}")));
        if let Some(spell) = truthy(source.spell_id) {
            removed.insert("spell_id".into(), spell);
        }
        events.push(event_from(&rules, "ConditionRemoved", Some(Value::Object(removed)), Some(&targets)));
    }
    let mut added = Map::new();
    added.insert("condition".into(), Value::String(format!("exhaustion:{}", level + 1)));
    added.insert("exhaustion_level".into(), Value::from(level + 1));
    added.insert("duration".into(), Value::String("until-removed".into()));
    for (key, value) in [("source_actor", source.source_actor), ("effect_id", source.effect_id), ("spell_id", source.spell_id), ("trigger", source.trigger)] {
        if let Some(value) = truthy(value) {
            added.insert(key.into(), value);
        }
    }
    events.push(event_from(&rules, "ConditionAdded", Some(Value::Object(added)), Some(&targets)));
    events
}

/// `HIT_POINT_MAXIMUM_BONUS_CONDITION_PREFIX`.
pub const HIT_POINT_MAXIMUM_BONUS_CONDITION_PREFIX: &str = "aid-hit-point-maximum:";

/// `hitPointMaximumBonusOf(state, id)`: чужая прибавка к максимуму хитов.
pub fn hit_point_maximum_bonus_of(state: &Value, id: &str) -> i64 {
    condition_ids_for(state, id)
        .iter()
        .filter_map(|condition| condition.strip_prefix(HIT_POINT_MAXIMUM_BONUS_CONDITION_PREFIX))
        .map(|rest| js::safe_int(Some(&Value::String(rest.to_string())), 0).max(0))
        .sum()
}
