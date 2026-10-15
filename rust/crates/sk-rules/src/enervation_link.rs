//! Связь «Обессиливания» — `enervationLinkFor` и
//! `enervationContinuationActionFor` (`rules-engine.mjs`, 10809–10879).
//! Задача Р0.
//!
//! Связь принадлежит паре «концентрация заклинателя — состояние цели»;
//! `effect_id` и цель никогда не берутся из команды. Причины обрыва связи,
//! закрытие после действия и после триггеров — `spells/enervation.rs` (Р5).

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::core::{safe_integer_or, spread_value, string_of};

/// Связь заклинателя с целью «Обессиливания».
#[derive(Debug, Clone, PartialEq)]
pub struct EnervationLink {
    pub caster_id: String,
    pub target_id: String,
    pub effect_id: String,
    /// `Math.max(spell.level, safeInteger(condition.slot_level, spell.level))`.
    pub slot_level: Value,
    pub condition: Value,
    pub spell: Value,
    /// Снимок продолжения с полями состояния цели.
    pub continuation: Value,
}

impl EnervationLink {
    /// Объект связи JS (`{ caster_id, target_id, effect_id, slot_level, condition, spell, continuation }`).
    pub fn to_value(&self) -> Value {
        json!({
            "caster_id": self.caster_id, "target_id": self.target_id, "effect_id": self.effect_id, "slot_level": self.slot_level,
            "condition": self.condition, "spell": self.spell, "continuation": self.continuation,
        })
    }
}

/// `Math.max(a, b)` над значениями JSON (`NaN`, если одно не число).
fn js_max(left: Option<&Value>, right: Option<&Value>) -> Value {
    js::num(js::max_of([js::number(left), js::number(right)]))
}

/// `enervationLinkFor(state, casterId)`.
pub fn enervation_link_for(state: &Value, caster_id: Option<&Value>) -> Option<EnervationLink> {
    let caster_id = js::s(caster_id);
    let mechanics = sk_core::game::mechanics(state);
    let concentration = mechanics.get("concentration").and_then(|all| all.get(&caster_id));
    let effect_id = js::s(concentration.and_then(|entry| entry.get("effect_id")));
    if caster_id.is_empty() || effect_id.is_empty() {
        return None;
    }
    let all_conditions = mechanics.get("conditions").and_then(Value::as_object);
    let mut candidates: Vec<(&String, &Value)> = all_conditions
        .map(|map| js::entries(map))
        .unwrap_or_default()
        .into_iter()
        .flat_map(|(target_id, conditions)| conditions.as_array().into_iter().flatten().map(move |condition| (target_id, condition)))
        .filter(|(_, condition)| {
            let field = |key: &str| condition.as_object().and_then(|map| map.get(key));
            let id = match field("id").filter(|value| !value.is_null()) {
                Some(id) => string_of(id),
                None => string_of(condition),
            };
            id == "enervated"
                && js::s(field("source_actor")) == caster_id
                && js::s(field("effect_id")) == effect_id
                && js::safe_int(field("continuation_version"), 0) == 1
                && (!js::present(field("spell_id")) || js::string(field("spell_id")) == "enervation")
        })
        .collect();
    candidates.sort_by(|left, right| sk_core::text::locale_compare(left.0, right.0));
    let (target_id, condition) = candidates.into_iter().next()?;
    let options = match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    };
    let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&json!("enervation")), Some(&options))?;
    let continuation = spell.get("continuation").filter(|value| js::truthy(Some(value)))?;
    if js::s(continuation.get("actionId")).is_empty() {
        return None;
    }
    let field = |key: &str| condition.get(key);
    let mut snapshot = spread_value(Some(continuation));
    if js::truthy(field("continuation_damage")) {
        snapshot.insert("damage".into(), Value::String(js::string(field("continuation_damage"))));
    }
    if js::truthy(field("continuation_damage_type")) {
        snapshot.insert("damageType".into(), Value::String(js::string(field("continuation_damage_type"))));
    }
    if js::present(field("continuation_range")) {
        insert_defined(&mut snapshot, "range", safe_integer_or(field("continuation_range"), continuation.get("range")));
    }
    if js::present(field("continuation_upcast_dice_per_level")) {
        snapshot.insert("upcastDicePerLevel".into(), Value::from(js::safe_int(field("continuation_upcast_dice_per_level"), 0)));
    }
    if js::present(field("continuation_duration_seconds")) {
        snapshot.insert("durationSeconds".into(), Value::from(js::safe_int(field("continuation_duration_seconds"), 60)));
    }
    let slot_level = js_max(spell.get("level"), safe_integer_or(field("slot_level"), spell.get("level")).as_ref());
    Some(EnervationLink {
        caster_id,
        target_id: target_id.clone(),
        effect_id,
        slot_level,
        condition: condition.clone(),
        spell: spell.clone(),
        continuation: Value::Object(snapshot),
    })
}

fn insert_defined(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.into(), value);
        }
        None => {
            map.insert(key.into(), Value::Null);
            map.shift_remove(key);
        }
    }
}

/// `enervationContinuationActionFor(state, casterId, actionId)`: серверная
/// запись действия продолжения, пока связь жива.
pub fn enervation_continuation_action_for(state: &Value, caster_id: Option<&Value>, action_id: Option<&Value>) -> Option<Value> {
    let link = enervation_link_for(state, caster_id)?;
    let continuation_action = js::string(link.continuation.get("actionId"));
    if js::present(action_id) && js::string(action_id) != continuation_action {
        return None;
    }
    let range = js::max_of([0.0, js::number(safe_integer_or(link.continuation.get("range"), link.spell.get("range")).as_ref())]);
    let mut action = Map::new();
    action.insert("id".into(), Value::String(continuation_action));
    action.insert("name".into(), Value::String("Продолжить «Обессиливание»".into()));
    action.insert("category".into(), Value::String("class".into()));
    action.insert("target".into(), Value::String("enemy".into()));
    action.insert("actionType".into(), Value::String("action".into()));
    action.insert("range".into(), js::num(range));
    action.insert(
        "description".into(),
        Value::String("Действием повторно нанести исходной цели 4к8 некротического урона и восстановить половину фактически нанесённого урона.".into()),
    );
    action.insert("iconId".into(), Value::String("enervation".into()));
    if let Some(url) = link.spell.get("sourceUrl") {
        action.insert("sourceUrl".into(), url.clone());
    }
    action.insert("mechanicsSupport".into(), Value::String("partial".into()));
    if let Some(note) = link.spell.get("supportNote") {
        action.insert("supportNote".into(), note.clone());
    }
    action.insert(
        "effect".into(),
        json!({ "kind": "enervation-continuation", "spell_id": "enervation", "effect_id": link.effect_id, "target_id": link.target_id }),
    );
    action.insert("continuation".into(), link.continuation.clone());
    Some(Value::Object(action))
}
