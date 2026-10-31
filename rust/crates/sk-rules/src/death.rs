//! Смерть и 0 хитов: спасброски от смерти, падение ничком, последствия нулевых хитов. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 9014–9189 (`deathSavingThrowAtTurnStart`,
//! `fallsProneEvents`, `zeroHitPointDamageConsequences`), 9218
//! (`assertRevivableHero`). Счётчик спасбросков и «погиб ли» — `targets.rs`
//! (Р1).

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::checks::saves::{aura_of_protection_payload, item_saving_throw_payload, roll_d20_with_species_luck, saving_throw_modifier_with_aura, D20Method};
use crate::command::rules::rule_ids;
use crate::conditions::{at, at_path, bless_bonus_enabled, nullish_chain};
use crate::core::{actor_max_hp, command_with, command_with_rules, condition_ids_for, event_from, hero_died_event_from, player_actor};
use crate::dice_record::RulesDice;
use crate::pause::{rule, Halt};
use crate::targets::{death_save_tracker, is_dead_hero, is_unstable_dying_hero};

/// События и броски шага.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventsAndRolls {
    pub events: Vec<Value>,
    pub rolls: Vec<Value>,
}

/// `String(actor?.character ?? actor?.name ?? fallback)`.
fn hero_name(actor: Option<&Value>, fallback: &str) -> String {
    match nullish_chain(&[at(actor, "character"), at(actor, "name")]).filter(|value| !value.is_null()) {
        Some(name) => js::s(Some(name)),
        None => fallback.to_string(),
    }
}

/// `command.visibility ?? 'public'`.
fn visibility_of(command: &Value) -> Value {
    command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String("public".into()))
}

/// `deathSavingThrowAtTurnStart(state, command, actorId, diceService)`: бросок
/// умирающего героя в начале его хода.
pub fn death_saving_throw_at_turn_start(state: &Value, command: &Value, actor_id: &str, dice: &mut dyn RulesDice) -> Result<EventsAndRolls, Halt> {
    if !is_unstable_dying_hero(state, actor_id) {
        return Ok(EventsAndRolls::default());
    }
    let actor = player_actor(state, Some(&Value::String(actor_id.into())));
    let tracker = death_save_tracker(state, actor_id);
    let condition_ids = condition_ids_for(state, actor_id);
    let mut modifier_rolls = Vec::new();
    let mut modifier_events = Vec::new();
    let aura = saving_throw_modifier_with_aura(state, actor_id, Some(&Value::from(0)))?;
    let mut modifier = aura.modifier;
    let visibility = visibility_of(command);
    let id_value = Value::String(actor_id.into());
    let bless = bless_bonus_enabled(state, actor_id);
    if bless {
        let blessing = dice.roll(&[Value::String("1d4".into()), Value::String("spell:bless:death-saving-throw".into()), id_value.clone(), visibility.clone()])?;
        let mut payload = crate::core::spread_value(Some(&blessing));
        payload.insert("modifier_source".into(), Value::String("bless".into()));
        modifier += js::number(blessing.get("total"));
        modifier_events.push(event_from(command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        modifier_rolls.push(blessing);
    }
    let bane = condition_ids.contains("bane-d4");
    if bane {
        let roll = dice.roll(&[Value::String("1d4".into()), Value::String("spell:bane:death-saving-throw".into()), id_value.clone(), visibility.clone()])?;
        let mut payload = crate::core::spread_value(Some(&roll));
        payload.insert("modifier_source".into(), Value::String("bane".into()));
        modifier -= js::number(roll.get("total"));
        modifier_events.push(event_from(command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        modifier_rolls.push(roll);
    }
    let advantage = condition_ids.contains("beacon-of-hope");
    let mut options = Map::new();
    options.insert("modifier".into(), js::num(modifier));
    options.insert("purpose".into(), Value::String("death_saving_throw".into()));
    options.insert("actorId".into(), id_value.clone());
    options.insert("advantage".into(), Value::Bool(advantage));
    options.insert("visibility".into(), visibility);
    let roll = roll_d20_with_species_luck(state, dice, actor_id, &Value::Object(options), D20Method::RollD20)?;
    let natural = js::safe_int(roll.get("kept"), 0);
    let mut sources = Vec::new();
    if aura.item_saving_throw_bonus > 0.0 {
        sources.push("item-passive-effect");
    }
    if aura.aura.is_some() {
        sources.push("aura-of-protection");
    }
    if bless_bonus_enabled(state, actor_id) {
        sources.push("bless");
    }
    if bane {
        sources.push("bane");
    }
    let acting = command_with(command, "actor_id", id_value.clone());
    let targets = json!([actor_id]);
    let mut payload = crate::core::spread_value(Some(&roll));
    payload.extend(aura_of_protection_payload(aura.aura.as_ref()));
    payload.extend(item_saving_throw_payload(aura.item_saving_throw_bonus));
    payload.insert("natural_roll".into(), Value::from(natural));
    payload.insert("advantage".into(), Value::Bool(advantage));
    payload.insert("modifier_sources".into(), json!(sources));
    let mut rolls = modifier_rolls;
    rolls.push(roll.clone());
    if natural == 20 {
        payload.insert("success".into(), Value::Bool(true));
        payload.insert("successes_before".into(), Value::from(tracker.successes));
        payload.insert("successes_after".into(), Value::from(0));
        payload.insert("failures_before".into(), Value::from(tracker.failures));
        payload.insert("failures_after".into(), Value::from(0));
        payload.insert("result".into(), Value::String("revived".into()));
        let mut events = modifier_events;
        events.push(event_from(&command_with_rules(&acting, &[rule_ids::ZERO_HP, rule_ids::SAVING_THROW]), "DeathSavingThrowRolled", Some(Value::Object(payload)), Some(&targets)));
        events.push(event_from(
            &command_with_rules(&acting, &[rule_ids::HEALING, rule_ids::ZERO_HP]),
            "HealingApplied",
            Some(json!({ "requested_amount": 1, "applied_amount": 1, "hp_before": 0, "hp_after": actor_max_hp(actor).min(1), "reason": "natural-20-death-save" })),
            Some(&targets),
        ));
        return Ok(EventsAndRolls { events, rolls });
    }
    let success = natural != 1 && js::number(roll.get("total")) >= 10.0;
    let increment = if success { 0 } else if natural == 1 { 2 } else { 1 };
    let successes_after = (tracker.successes + i64::from(success)).min(3);
    let failures_after = (tracker.failures + increment).min(3);
    let result = if successes_after >= 3 {
        "stabilized"
    } else if failures_after >= 3 {
        "died"
    } else if success {
        "success"
    } else {
        "failure"
    };
    payload.insert("success".into(), Value::Bool(success));
    payload.insert("successes_before".into(), Value::from(tracker.successes));
    payload.insert("successes_after".into(), Value::from(successes_after.min(2)));
    payload.insert("failures_before".into(), Value::from(tracker.failures));
    payload.insert("failures_after".into(), Value::from(failures_after.min(2)));
    payload.insert("failure_increment".into(), Value::from(increment));
    payload.insert("result".into(), Value::String(result.into()));
    let mut events = modifier_events;
    events.push(event_from(&command_with_rules(&acting, &[rule_ids::ZERO_HP, rule_ids::SAVING_THROW]), "DeathSavingThrowRolled", Some(Value::Object(payload)), Some(&targets)));
    let name = hero_name(actor, actor_id);
    if successes_after >= 3 {
        events.push(event_from(&command_with_rules(&acting, &[rule_ids::ZERO_HP]), "HeroStabilized", Some(json!({ "hero_name": name, "method": "three-death-save-successes" })), Some(&targets)));
    } else if failures_after >= 3 {
        events.push(hero_died_event_from(&command_with_rules(&acting, &[rule_ids::ZERO_HP]), Some(json!({ "hero_name": name, "reason": "three-death-save-failures" })), Some(&targets)));
    }
    Ok(EventsAndRolls { events, rolls })
}

/// `fallsProneEvents(state, command, targetId)`: без сознания — значит ничком.
pub fn falls_prone_events(state: &Value, command: &Value, target_id: &str) -> Vec<Value> {
    if sk_core::game::conditions(state, target_id).iter().any(|condition| condition.get("id").and_then(Value::as_str) == Some("prone")) {
        return Vec::new();
    }
    vec![event_from(
        &command_with_rules(command, &[rule_ids::CONDITIONS]),
        "ConditionAdded",
        Some(json!({ "condition": "prone", "duration": null, "trigger": "unconscious" })),
        Some(&json!([target_id])),
    )]
}

/// `x === y` для значения JSON и строки (строгое: у не-строки равных нет).
fn strict_str(value: Option<&Value>, text: &str) -> bool {
    value.and_then(Value::as_str) == Some(text)
}

/// `zeroHitPointDamageConsequences(state, command, targetId, payload, { critical })`:
/// облик, NPC без сознания, мгновенная смерть, падение и провалы спасбросков.
pub fn zero_hit_point_damage_consequences(state: &Value, command: &Value, target_id: &str, payload: &Value, critical: bool) -> Vec<Value> {
    if js::safe_int(payload.get("applied_amount"), 0) <= 0 || js::safe_int(payload.get("hp_after"), -1) != 0 {
        return Vec::new();
    }
    let target = sk_core::game::find_actor(state, target_id);
    let targets = json!([target_id]);
    let zero_hp = command_with_rules(command, &[rule_ids::ZERO_HP]);
    let shapes = sk_core::game::mechanics(state).get("shapes");
    if let Some(shape) = at(shapes, target_id).filter(|shape| js::truthy(Some(shape))) {
        let form_hp_before = js::safe_int(payload.get("hp_before"), 0).max(0);
        let excess = (js::safe_int(payload.get("applied_amount"), 0) - form_hp_before).max(0);
        let mut events = vec![event_from(&zero_hp, "ShapeReverted", Some(json!({ "reason": "form-destroyed", "excess_damage": excess })), Some(&targets))];
        let owner = js::s(shape.get("concentration_actor_id"));
        let effect_id = js::s(shape.get("effect_id"));
        let another_shape = shapes.and_then(Value::as_object).is_some_and(|all| {
            js::entries(all).into_iter().any(|(id, other)| id != target_id && strict_str(other.get("effect_id"), &effect_id) && strict_str(other.get("concentration_actor_id"), &owner))
        });
        let concentration = at_path(Some(sk_core::game::mechanics(state)), &["concentration", &owner]);
        if shape.get("shape_contract_version").and_then(Value::as_f64) == Some(2.0) && !owner.is_empty() && !effect_id.is_empty() && !another_shape && strict_str(at(concentration, "effect_id"), &effect_id) {
            let source = command_with_rules(&command_with(command, "actor_id", Value::String(owner.clone())), &[rule_ids::CONCENTRATION]);
            events.push(event_from(&source, "ConcentrationEnded", Some(json!({ "reason": "form-destroyed", "effect_id": effect_id })), Some(&json!([owner]))));
        }
        return events;
    }
    if player_actor(state, Some(&Value::String(target_id.into()))).is_none() {
        return vec![event_from(&zero_hp, "HitPointsReducedToZero", Some(json!({ "condition": "unconscious" })), Some(&targets))];
    }
    if is_dead_hero(state, target_id) {
        return Vec::new();
    }
    let hp_before = js::safe_int(payload.get("hp_before"), target.map(sk_core::game::actor_hp).unwrap_or(0)).max(0);
    let applied = js::safe_int(payload.get("applied_amount"), 0).max(0);
    let instant_death = if hp_before > 0 { applied - hp_before >= actor_max_hp(target) } else { applied >= actor_max_hp(target) };
    let name = hero_name(target, target_id);
    if instant_death {
        return vec![hero_died_event_from(&zero_hp, Some(json!({ "hero_name": name, "reason": "massive-damage", "damage": applied, "hp_before": hp_before })), Some(&targets))];
    }
    if hp_before > 0 {
        let mut events = vec![event_from(&zero_hp, "HitPointsReducedToZero", Some(json!({ "condition": "unconscious", "successes": 0, "failures": 0 })), Some(&targets))];
        events.extend(falls_prone_events(state, command, target_id));
        return events;
    }
    let tracker = death_save_tracker(state, target_id);
    let increment = if critical { 2 } else { 1 };
    let failures_after = (tracker.failures + increment).min(3);
    let mut events = vec![event_from(
        &zero_hp,
        "DeathSaveFailureRecorded",
        Some(json!({
            "successes_before": tracker.successes,
            "successes_after": tracker.successes,
            "failures_before": tracker.failures,
            "failures_after": failures_after.min(2),
            "failure_increment": increment,
            "stable_before": tracker.stable,
            "stable_after": false,
            "critical": critical,
            "reason": "damage-at-zero-hit-points",
        })),
        Some(&targets),
    )];
    if failures_after >= 3 {
        events.push(hero_died_event_from(&zero_hp, Some(json!({ "hero_name": name, "reason": "three-death-save-failures" })), Some(&targets)));
    }
    events
}

/// `assertRevivableHero(state, targetId, spell)`: «Возрождение» — погибшему
/// герою отряда, не позже окна заклинания.
pub fn assert_revivable_hero(state: &Value, target_id: &str, spell: &Value) -> Result<(), Halt> {
    let mechanics = sk_core::game::mechanics(state);
    let fate = at_path(Some(mechanics), &["death", "heroes", target_id]);
    if player_actor(state, Some(&Value::String(target_id.into()))).is_none() || !strict_str(at(fate, "status"), "dead") {
        return Err(rule("«Возрождение» возвращает только погибшего героя отряда", "REVIVIFY_TARGET_NOT_DEAD"));
    }
    let combat = mechanics.get("combat");
    let rounds = js::safe_int(spell.get("reviveWindowRounds"), 10).max(0);
    let minutes = js::safe_int(spell.get("reviveWindowMinutes"), 1).max(0);
    let elapsed = js::safe_int(at_path(Some(mechanics), &["world_time", "elapsed_minutes"]), 0).max(0) - js::safe_int(at(fate, "died_world_minutes"), 0).max(0);
    let died_round = at(fate, "died_round");
    let in_time = if js::truthy(at(combat, "active")) && js::is_safe_integer(died_round) {
        (js::safe_int(at(combat, "round"), 1).max(1) as f64 - js::number(died_round)) <= rounds as f64 && elapsed <= minutes
    } else {
        js::is_safe_integer(at(fate, "died_world_minutes")) && elapsed <= minutes
    };
    if !in_time {
        return Err(rule("Слишком поздно: «Возрождение» действует не позже минуты после смерти", "REVIVIFY_TOO_LATE"));
    }
    Ok(())
}
