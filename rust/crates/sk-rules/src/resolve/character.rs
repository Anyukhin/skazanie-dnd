//! Ветки `resolveCommandInternal`: Герой: выборы и заклинания, повышение уровня, импорт, броски характеристик и богатства. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 22881–22885, 22886–22890, 22891–22895, 22896–22908, 22909–22915. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Value};
use sk_core::js;

use super::Resolve;
use crate::core::event_from;
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Interrupt, Flow};

/// Ошибка `character-lifecycle` в разборе: JS её не переписывает.
fn lifecycle_fault(error: sk_character::character_lifecycle::CharacterLifecycleError) -> Interrupt {
    let fault = Fault::new(error.name, error.message);
    match error.code {
        Some(code) => fault.with_code(code).into(),
        None => fault.into(),
    }
}

/// `eventFrom(command, draft.event_type, draft.payload, draft.target_ids)`.
fn push_draft(r: &mut Resolve<'_>, draft: &Value) {
    let event = event_from(&r.command, &js::s(draft.get("event_type")), draft.get("payload").cloned(), draft.get("target_ids"));
    r.events.push(event);
}

/// `SetCharacterChoices`, `SetSpellSelections` (22880–22885).
pub fn character_build(r: &mut Resolve<'_>) -> Flow {
    let Some(draft) = sk_combat_content::character_build::character_build_event(&r.command) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'event_type')").into());
    };
    push_draft(r, &draft);
    Ok(())
}

/// `LevelUp` (22886–22890).
pub fn level_up(r: &mut Resolve<'_>) -> Flow {
    let draft = sk_character::character_lifecycle::level_up_event(Some(&r.command)).map_err(lifecycle_fault)?;
    push_draft(r, &draft);
    Ok(())
}

/// `ImportCharacter` (22891–22895).
pub fn import_character(r: &mut Resolve<'_>) -> Flow {
    let draft = sk_character::character_lifecycle::character_import_event(Some(&r.command)).map_err(lifecycle_fault)?;
    push_draft(r, &draft);
    Ok(())
}

/// Сумма трёх старших костей броска.
fn best_three(roll: &Value) -> Value {
    let mut dice: Vec<f64> = roll.get("dice").and_then(Value::as_array).map(|dice| dice.iter().map(|die| js::number(Some(die))).collect()).unwrap_or_default();
    dice.sort_by(|left, right| right.partial_cmp(left).unwrap_or(std::cmp::Ordering::Equal));
    js::num(dice.iter().take(3).sum())
}

/// `RollCharacterAbilities` (22896–22908).
pub fn roll_character_abilities(r: &mut Resolve<'_>) -> Flow {
    let actor_id = js::s(r.command.get("actor_id"));
    let Some(actor) = sk_core::game::find_actor(&r.state, &actor_id) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'characterCreationRolls')").into());
    };
    let previous = actor.get("characterCreationRolls").and_then(|rolls| rolls.get("abilities")).filter(|value| !value.is_null()).cloned();
    let index = js::number(r.command.get("roll_index")) + 1.0;
    let purpose = format!("character-ability-{}", js::f64_string(index));
    let roll = r.dice.roll(&[json!("4d6"), json!(purpose), r.command.get("actor_id").cloned().unwrap_or(Value::Null), json!("party")])?;
    let mut rolls: Vec<Value> = previous.as_ref().and_then(|previous| previous.get("rolls")).and_then(Value::as_array).cloned().unwrap_or_default();
    rolls.push(roll.clone());
    r.rolls.push(roll.clone());
    let id = previous.as_ref().and_then(|previous| previous.get("id")).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| roll.get("roll_id").cloned().unwrap_or(Value::Null));
    let scores: Vec<Value> = rolls.iter().map(best_three).collect();
    let payload = json!({ "schema_version": 2, "id": id, "rolls": rolls, "scores": scores });
    let targets = json!([r.command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    r.events.push(event_from(&r.command, "CharacterAbilitiesRolled", Some(payload), Some(&targets)));
    Ok(())
}

/// `RollCharacterWealth` (22909–22915).
pub fn roll_character_wealth(r: &mut Resolve<'_>) -> Flow {
    let class_id = js::s(r.command.get("character_class"));
    let Some(formula) = sk_chargen::character_creation_wealth::phb_starting_wealth(&class_id).filter(|_| r.command.get("character_class").is_some_and(Value::is_string)) else {
        return Err(Fault::type_error("Cannot read properties of undefined (reading 'expression')").into());
    };
    let roll = r.dice.roll(&[json!(formula.expression), json!("character-starting-wealth"), r.command.get("actor_id").cloned().unwrap_or(Value::Null), json!("party")])?;
    r.rolls.push(roll.clone());
    let total = js::number(roll.get("total")) * formula.multiplier as f64;
    let mut payload = serde_json::Map::new();
    payload.insert("schema_version".into(), json!(1));
    payload.insert("id".into(), roll.get("roll_id").cloned().unwrap_or(Value::Null));
    if let Some(class) = r.command.get("character_class") {
        payload.insert("class_id".into(), class.clone());
    }
    payload.insert("roll".into(), roll.clone());
    payload.insert("total_gp".into(), js::num(total));
    let targets = json!([r.command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    r.events.push(event_from(&r.command, "CharacterWealthRolled", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}
