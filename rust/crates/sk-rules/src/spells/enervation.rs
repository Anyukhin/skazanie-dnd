//! «Обессиливание»: причина обрыва связи, закрытие после действия и после
//! триггеров; «Серебряная удача»; закрытие отработавших усилений. Задача Р5.
//!
//! JS: `server/rules-engine.mjs` — `enervationContinuationInvalidReason`,
//! `silveryFortuneFor`, `removeSilveryFortuneEvent` (10909–10940),
//! `hasEnervationContinuation`, `closeEnervationAfterOtherAction`,
//! `enervationTriggerReason`, `closeEnervationAfterTriggers`,
//! `closeFinishedSpellBuffs` (12614–12731), `refreshEnervationActionState` (23657).
//!
//! Закрытие связи — пост-обработка итога команды в `resolveCommandWithPauses`
//! (`resolve/api.rs`): ветки атаки, предметов и заклинаний своих копий правила
//! не заводят.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::core::{command_with, command_with_rules, condition_ids_for, event_from};
use crate::enervation_link::{enervation_link_for, EnervationLink};
use crate::pause::Halt;
use crate::replay::apply_game_event;
use crate::resolve::Resolved;
use crate::tactical_geometry::actor_point;

/// `Math.max(0, x)` с `NaN`, как в JS.
fn max0(value: f64) -> f64 {
    if value.is_nan() {
        value
    } else {
        value.max(0.0)
    }
}

/// Общая часть двух причин обрыва связи: заклинатель, цель, карта, дальность, укрытие.
fn link_geometry_reason(state: &Value, link: &EnervationLink) -> Option<&'static str> {
    let caster = sk_core::game::find_actor(state, &link.caster_id);
    let target = sk_core::game::find_actor(state, &link.target_id);
    if !caster.is_some_and(sk_core::game::is_living_actor) {
        return Some("caster-defeated");
    }
    let Some(target) = target else { return Some("target-missing") };
    if !sk_core::game::is_living_actor(target) {
        return Some("target-defeated");
    }
    let from = actor_point(state, &link.caster_id);
    let to = actor_point(state, &link.target_id);
    if from.is_none() || to.is_none() {
        return Some("map-position-missing");
    }
    let range_value = link.continuation.get("range");
    let range = if js::is_safe_integer_number(range_value) { js::number(range_value) } else { js::number(link.spell.get("range")) };
    let range = max0(range);
    let distance = crate::geometry::footprint::distance_between_actor_positions(state, &link.caster_id, from, &link.target_id, to);
    match distance {
        None => return Some("out-of-range"),
        Some(distance) if distance > range => return Some("out-of-range"),
        _ => {}
    }
    if !crate::geometry::forced::has_clear_actor_trajectory(state, &link.caster_id, &link.target_id, from, to, true) {
        return Some("full-cover");
    }
    None
}

/// `enervationContinuationInvalidReason(state, link)`: почему продолжение
/// «Обессиливания» больше не может действовать (или `None`).
pub fn enervation_continuation_invalid_reason(state: &Value, link: &EnervationLink) -> Option<&'static str> {
    link_geometry_reason(state, link)
}

/// `enervationTriggerReason(state, link)`: внешний триггер оборвал связь.
pub fn enervation_trigger_reason(state: &Value, link: &EnervationLink) -> Option<&'static str> {
    if let Some(reason) = link_geometry_reason(state, link) {
        return Some(reason);
    }
    let expires = link.condition.get("expires_at_seconds");
    let expires_at = js::number(expires);
    if expires_at.is_finite() && crate::world_clock::world_time_seconds(state) >= expires_at {
        return Some("duration-expired");
    }
    if !condition_ids_for(state, &link.target_id).contains("enervated") {
        return Some("target-condition-missing");
    }
    None
}

/// `silveryFortuneFor(state, id)`: адресуемый экземпляр «Серебряной удачи»,
/// иначе первый.
pub fn silvery_fortune_for(state: &Value, id: &str) -> Option<Value> {
    let instances: Vec<&Value> = sk_core::game::conditions(state, id).iter().filter(|condition| sk_core::game::condition_id(condition) == "silvery-fortune").collect();
    instances.iter().find(|condition| js::present(condition.get("effect_id"))).or_else(|| instances.first()).map(|condition| (*condition).clone())
}

/// `removeSilveryFortuneEvent(command, state, id, trigger = null)`.
pub fn remove_silvery_fortune_event(command: &Value, state: &Value, id: &str, trigger: Option<&str>) -> Value {
    let instance = silvery_fortune_for(state, id);
    let mut payload = Map::new();
    payload.insert("condition".into(), Value::String("silvery-fortune".into()));
    if let Some(effect_id) = instance.as_ref().and_then(|instance| instance.get("effect_id")).filter(|value| !value.is_null()) {
        payload.insert("effect_id".into(), effect_id.clone());
    }
    if let Some(trigger) = trigger.filter(|trigger| !trigger.is_empty()) {
        payload.insert("trigger".into(), Value::String(trigger.into()));
    }
    event_from(&command_with_rules(command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(Value::Object(payload)), Some(&json!([id])))
}

/// `hasEnervationContinuation(state)`: у кого-то лежит продолжаемое «Обессиливание».
pub fn has_enervation_continuation(state: &Value) -> bool {
    let Some(all) = state.get("mechanics").and_then(|mechanics| mechanics.get("conditions")).and_then(Value::as_object) else { return false };
    all.values().any(|conditions| {
        conditions.as_array().is_some_and(|items| {
            items.iter().any(|condition| condition.get("id").and_then(Value::as_str) == Some("enervated") && js::safe_int(condition.get("continuation_version"), 0) > 0)
        })
    })
}

/// Событие тратит обычное действие заклинателя (`consumedAction`).
fn consumes_action(event: &Value, actor_id: &str) -> bool {
    if js::s(event.get("actor_id")) != actor_id {
        return false;
    }
    let payload = event.get("payload");
    let field = |key: &str| payload.and_then(|payload| payload.get(key));
    match event.get("event_type").and_then(Value::as_str).unwrap_or("") {
        "CombatActionUsed" | "SpellCast" => field("action_type").and_then(Value::as_str) == Some("action"),
        "AttackResolved" | "AreaAttackResolved" => !js::is_true(field("reaction_attack")) && !js::is_false(field("economy").and_then(|economy| economy.get("action"))),
        "EquipmentChanged" => field("timing").and_then(Value::as_str) == Some("action"),
        "ItemUsed" | "ItemEquipped" | "ItemUnequipped" | "MagicItemActivationChanged" | "LootContainerTaken" => field("combat_action").and_then(Value::as_str) == Some("action"),
        "DoorBarricaded" | "DoorBarricadeCleared" | "DoorBarricadeForced" | "DoorForced" | "DoorLockpicked" => true,
        "SceneObjectOperated" => js::is_true(field("action_spent")),
        _ => false,
    }
}

/// `closeEnervationAfterOtherAction(result, rawState)`: заклинатель потратил
/// обычное действие на другой поступок — связь кончается (событие встаёт первым).
pub fn close_enervation_after_other_action(result: Resolved, state: crate::normalized::StateIn<'_>) -> Result<Resolved, Halt> {
    let raw_state = state.raw;
    let command = &result.command;
    if !js::truthy(Some(command)) || js::s(command.get("action_id")) == "enervation-repeat" {
        return Ok(result);
    }
    if !has_enervation_continuation(raw_state) {
        return Ok(result);
    }
    let Some(link) = enervation_link_for(state.normalized, command.get("actor_id")) else { return Ok(result) };
    let actor = js::string(command.get("actor_id"));
    let ended = result.events.iter().any(|event| {
        event.get("event_type").and_then(Value::as_str) == Some("ConcentrationEnded")
            && js::s(event.get("actor_id")) == actor
            && js::s(event.get("payload").and_then(|payload| payload.get("effect_id"))) == link.effect_id
    });
    if ended {
        return Ok(result);
    }
    let actor_id = js::s(command.get("actor_id"));
    if !result.events.iter().any(|event| consumes_action(event, &actor_id)) {
        return Ok(result);
    }
    let targets = json!([command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    let ended_event = event_from(
        &command_with_rules(command, &[rule_ids::CONCENTRATION]),
        "ConcentrationEnded",
        Some(json!({ "reason": "action-other", "effect_id": link.effect_id, "spell_id": "enervation" })),
        Some(&targets),
    );
    let mut events = Vec::with_capacity(result.events.len() + 1);
    events.push(ended_event);
    events.extend(result.events);
    Ok(Resolved { command: result.command, events, rolls: result.rolls })
}

/// `closeEnervationAfterTriggers(result, rawState)`: связь, которую оборвал
/// внешний триггер команды (уход цели, преграда, выбытие, время), закрывается
/// в той же команде.
pub fn close_enervation_after_triggers(result: Resolved, state: crate::normalized::StateIn<'_>) -> Result<Resolved, Halt> {
    let raw_state = state.raw;
    if !js::truthy(Some(&result.command)) {
        return Ok(result);
    }
    let creates_link = result.events.iter().any(|event| {
        let payload = event.get("payload");
        event.get("event_type").and_then(Value::as_str) == Some("ConditionAdded")
            && payload.and_then(|payload| payload.get("condition")).and_then(Value::as_str) == Some("enervated")
            && js::safe_int(payload.and_then(|payload| payload.get("continuation_version")), 0) > 0
    });
    if !has_enervation_continuation(raw_state) && !creates_link {
        return Ok(result);
    }
    let mut projected = crate::replay::replay_events_normalized(state.normalized, &result.events)?;
    let before: &Value = state.normalized.value();
    let mut ended: IndexSet<String> = result
        .events
        .iter()
        .filter(|event| event.get("event_type").and_then(Value::as_str) == Some("ConcentrationEnded"))
        .map(|event| js::s(event.get("payload").and_then(|payload| payload.get("effect_id"))))
        .filter(|id| !id.is_empty())
        .collect();
    let mut caster_ids: IndexSet<String> = IndexSet::new();
    for state in [before, &projected] {
        if let Some(Value::Object(concentration)) = sk_core::game::mechanics(state).get("concentration") {
            for key in js::keys(concentration) {
                caster_ids.insert(key.clone());
            }
        }
    }
    let mut appended = Vec::new();
    for caster_id in caster_ids {
        let caster = Value::String(caster_id);
        let Some(link) = enervation_link_for(&projected, Some(&caster)).or_else(|| enervation_link_for(before, Some(&caster))) else { continue };
        if ended.contains(&link.effect_id) {
            continue;
        }
        let Some(reason) = enervation_trigger_reason(&projected, &link) else { continue };
        let source = command_with_rules(&command_with(&result.command, "actor_id", Value::String(link.caster_id.clone())), &[rule_ids::CONCENTRATION]);
        let event = event_from(&source, "ConcentrationEnded", Some(json!({ "reason": reason, "effect_id": link.effect_id, "spell_id": "enervation" })), Some(&json!([link.caster_id])));
        ended.insert(link.effect_id.clone());
        projected = apply_game_event(&projected, &event)?;
        appended.push(event);
    }
    if appended.is_empty() {
        return Ok(result);
    }
    let mut events = result.events;
    events.extend(appended);
    Ok(Resolved { command: result.command, events, rolls: result.rolls })
}

/// `closeFinishedSpellBuffs(result, before)`: усиление «Меткого удара» и
/// временные усиления 2014, которые уже сняты со всех целей, завершают
/// концентрацию заклинателя. `before` — сырое состояние до команды.
pub fn close_finished_spell_buffs(result: Resolved, before: &Value) -> Result<Resolved, Halt> {
    let policy = sk_combat_content::combat_spells::DND_2014_TIMED_BUFF_EXPIRY_POLICY;
    let mut conditions: Vec<Value> = Vec::new();
    if let Some(Value::Object(all)) = before.get("mechanics").and_then(|mechanics| mechanics.get("conditions")) {
        for (_, entries) in js::entries(all) {
            match entries {
                Value::Array(items) => conditions.extend(items.iter().cloned()),
                other => conditions.push(other.clone()),
            }
        }
    }
    conditions.retain(|condition| condition.get("true_strike_version").and_then(Value::as_f64) == Some(1.0) ||condition.get("expiry_policy").and_then(Value::as_str) == Some(policy));
    if conditions.is_empty() {
        return Ok(result);
    }
    let mut after = before.clone();
    for event in &result.events {
        after = apply_game_event(&after, event)?;
    }
    let mut extra = Vec::new();
    for condition in &conditions {
        let caster_id = js::string(condition.get("source_actor"));
        let concentration = sk_core::game::mechanics(&after).get("concentration").and_then(|all| all.get(&caster_id));
        if js::s(concentration.and_then(|entry| entry.get("effect_id"))) != js::string(condition.get("effect_id")) {
            continue;
        }
        let still_held = sk_core::game::mechanics(&after).get("conditions").and_then(Value::as_object).is_some_and(|all| {
            all.values().any(|entries| entries.as_array().is_some_and(|items| items.iter().any(|entry| crate::validate::common::strict_equal(entry.get("effect_id"), condition.get("effect_id")))))
        });
        if still_held {
            continue;
        }
        let source = command_with_rules(&command_with(&result.command, "actor_id", Value::String(caster_id.clone())), &[rule_ids::CONCENTRATION]);
        let mut payload = Map::new();
        if let Some(effect_id) = condition.get("effect_id") {
            payload.insert("effect_id".into(), effect_id.clone());
        }
        if let Some(spell_id) = condition.get("spell_id") {
            payload.insert("spell_id".into(), spell_id.clone());
        }
        payload.insert("reason".into(), Value::String("effect-finished".into()));
        let event = event_from(&source, "ConcentrationEnded", Some(Value::Object(payload)), Some(&json!([caster_id])));
        after = apply_game_event(&after, &event)?;
        extra.push(event);
    }
    if extra.is_empty() {
        return Ok(result);
    }
    let mut events = result.events;
    events.extend(extra);
    Ok(Resolved { command: result.command, events, rolls: result.rolls })
}

/// `refreshEnervationActionState(state, actorIds)`: боевые действия героев с
/// продолжением «Обессиливания», без пересчёта листа. Пустой список — все герои.
pub fn refresh_enervation_action_state(state: &mut Value, actor_ids: &[String]) {
    let requested: IndexSet<&str> = actor_ids.iter().map(String::as_str).collect();
    let players: Vec<Value> = state.get("players").and_then(Value::as_array).cloned().unwrap_or_default();
    let refreshed: Vec<Value> = players
        .into_iter()
        .map(|actor| {
            let id = sk_core::game::actor_id(&actor);
            if !requested.is_empty() && !requested.contains(id.as_str()) {
                return actor;
            }
            // Действия с продолжением выводит `crate::derived` при чтении;
            // в героя — пустой слот на месте JS (урок 2).
            let mut map = crate::core::spread_value(Some(&actor));
            map.insert(crate::derived::COMBAT_ACTIONS.into(), Value::Null);
            Value::Object(map)
        })
        .collect();
    state["players"] = Value::Array(refreshed);
}
