//! Хвост `resolveCommandInternal` (`rules-engine.mjs`, 23156–23461):
//! вложенные последствия событий («Невидимость», вызов на дуэль, концентрация
//! от урона, снятие и повторный спасбросок от урона), окно «Несгибаемого»,
//! поражение отряда, невосприимчивые состояния, бегство, сверка концентрации
//! (`concentrationReconciliationEvents`, 23470), должности NPC и последствия
//! поручений, контейнеры добычи, сюжетные линии и опыт за вехи сценария.
//! Задача Р5.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;

use super::kernel::undef;
use super::{Resolve, Resolved};
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with, command_with_rules, condition_ids_for, event_from, spread_value, unique_strings};
use crate::dice_record::{failed_saving_throw_event, RulesDice};
use crate::pause::{Fault, Halt};
use crate::replay::apply_game_event;
use crate::spells::enervation::{remove_silvery_fortune_event, silvery_fortune_for};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

fn fault(name: &str, code: Option<String>, message: String) -> Halt {
    let fault = Fault::new(name, message);
    Halt::Fault(match code {
        Some(code) => fault.with_code(code),
        None => fault,
    })
}

fn event_type(event: &Value) -> &str {
    event.get("event_type").and_then(Value::as_str).unwrap_or("")
}

/// `{ ...command, actor_id }` с правилами.
fn as_actor(command: &Value, actor_id: &str, rules: &[&str]) -> Value {
    command_with_rules(&command_with(command, "actor_id", Value::String(actor_id.into())), rules)
}

/// `{ condition, ...(effect_id ? { effect_id } : {}), trigger, spell_id }`.
fn removal_payload(condition: &Value, trigger: &str) -> Value {
    let mut payload = Map::new();
    payload.insert("condition".into(), condition.get("id").cloned().unwrap_or(Value::Null));
    if condition.get("id").is_none() {
        payload.shift_remove("condition");
    }
    if let Some(effect_id) = condition.get("effect_id").filter(|value| js::truthy(Some(value))) {
        payload.insert("effect_id".into(), effect_id.clone());
    }
    payload.insert("trigger".into(), Value::String(trigger.into()));
    if let Some(spell_id) = condition.get("spell_id") {
        payload.insert("spell_id".into(), spell_id.clone());
    }
    Value::Object(payload)
}

/// Порядок `Array.prototype.sort()` без сравнителя: по единицам UTF-16.
fn utf16_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `concentrationReconciliationEvents(state, command, events)` (23492):
/// концентрация и заготовка тех, кого коснулась команда, согласуются после
/// всех последствий.
pub fn concentration_reconciliation_events(state: &Value, command: &Value, events: &[Value]) -> Result<Vec<Value>, Halt> {
    let mut touched: IndexSet<String> = IndexSet::new();
    for event in events {
        if !matches!(event_type(event), "ConditionAdded" | "ConcentrationEnded" | "ConcentrationStarted" | "ReadiedActionExpired" | "ActionReadied") {
            continue;
        }
        for id in event.get("target_ids").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            touched.insert(js::string(Some(id)));
        }
    }
    if touched.is_empty() {
        return Ok(Vec::new());
    }
    let mut projected = state.clone();
    for event in events {
        projected = apply_game_event(&projected, event)?;
    }
    let mut ids: Vec<String> = touched.into_iter().collect();
    ids.sort_by(|left, right| utf16_order(left, right));
    let mut extra = Vec::new();
    let incapacitating = crate::tables::incapacitating_conditions();
    for id in ids {
        let targets = json!([id]);
        let concentration = at(sk_core::game::mechanics(&projected).get("concentration"), &id).cloned();
        if let Some(concentration) = concentration.filter(|value| js::truthy(Some(value))) {
            if condition_ids_for(&projected, &id).iter().any(|condition| incapacitating.contains(&condition.as_str())) {
                let mut payload = Map::new();
                payload.insert("reason".into(), Value::String("incapacitated".into()));
                if let Some(effect_id) = concentration.get("effect_id") {
                    payload.insert("effect_id".into(), effect_id.clone());
                }
                let event = event_from(&as_actor(command, &id, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(Value::Object(payload)), Some(&targets));
                projected = apply_game_event(&projected, &event)?;
                extra.push(event);
            }
        }
        let readied = at(at(sk_core::game::mechanics(&projected).get("combat"), "readied"), &id).cloned();
        let current_effect = |projected: &Value| js::s(at(at(sk_core::game::mechanics(projected).get("concentration"), &id), "effect_id"));
        if let Some(readied) = readied.filter(|readied| js::truthy(readied.get("effect_id"))) {
            if current_effect(&projected) != js::string(readied.get("effect_id")) {
                let mut payload = Map::new();
                payload.insert("reason".into(), Value::String("concentration-lost".into()));
                if let Some(trigger) = readied.get("trigger") {
                    payload.insert("trigger".into(), trigger.clone());
                }
                if let Some(spell_id) = readied.get("spell_id") {
                    payload.insert("spell_id".into(), spell_id.clone());
                }
                let event = event_from(&as_actor(command, &id, &[rule_ids::REACTION]), "ReadiedActionExpired", Some(Value::Object(payload)), Some(&targets));
                projected = apply_game_event(&projected, &event)?;
                extra.push(event);
            }
        }
        let before = at(at(sk_core::game::mechanics(state).get("combat"), "readied"), &id);
        if let Some(before) = before.filter(|readied| js::truthy(readied.get("effect_id"))) {
            let still = at(at(sk_core::game::mechanics(&projected).get("combat"), "readied"), &id).is_some_and(|value| js::truthy(Some(value)));
            if !still && current_effect(&projected) == js::string(before.get("effect_id")) {
                let payload = json!({ "reason": "readied-expired", "effect_id": before.get("effect_id").cloned().unwrap_or(Value::Null) });
                let event = event_from(&as_actor(command, &id, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&targets));
                projected = apply_game_event(&projected, &event)?;
                extra.push(event);
            }
        }
    }
    Ok(extra)
}

/// `world-consequence:<sha256(text) первые 32>`.
fn world_consequence_id(text: &str) -> String {
    format!("world-consequence:{}", &sk_core::hash::sha256_hex(text.as_bytes())[..32])
}

/// `{ ...command, visibility: draft.visibility }`.
fn with_draft_visibility(command: &Value, draft: &Value) -> Value {
    command_with(command, "visibility", draft.get("visibility").cloned().unwrap_or(Value::Null))
}

impl Resolve<'_> {
    /// Вложенные последствия событий команды (23156–23318).
    fn nested_consequences(&mut self) -> Result<(), Halt> {
        if self.nested_consequences_resolved {
            return Ok(());
        }
        let snapshot = self.events.clone();
        let mut triggered = self.state.clone();
        let command = self.command.clone();
        for resolved in &snapshot {
            triggered = apply_game_event(&triggered, resolved)?;
            let kind = event_type(resolved);
            if kind == "AttackResolved" || kind == "SpellCast" {
                let acting = js::s(resolved.get("actor_id"));
                let invisible: Vec<Value> = sk_core::game::conditions(&triggered, &acting)
                    .iter()
                    .filter(|condition| condition.get("id").and_then(Value::as_str) == Some("invisible") && condition.get("spell_id").and_then(Value::as_str) == Some("invisibility"))
                    .cloned()
                    .collect();
                for condition in invisible {
                    let mut payload = Map::new();
                    payload.insert("condition".into(), Value::String("invisible".into()));
                    if let Some(effect_id) = condition.get("effect_id").filter(|value| js::truthy(Some(value))) {
                        payload.insert("effect_id".into(), effect_id.clone());
                    }
                    payload.insert("spell_id".into(), Value::String("invisibility".into()));
                    payload.insert("trigger".into(), Value::String(if kind == "SpellCast" { "cast-spell" } else { "attack" }.into()));
                    let removed = event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(Value::Object(payload)), Some(&json!([acting])));
                    triggered = apply_game_event(&triggered, &removed)?;
                    self.events.push(removed);
                }
                let duels: Vec<(String, Value)> = match sk_core::game::mechanics(&triggered).get("conditions") {
                    Some(Value::Object(all)) => js::entries(all).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
                    _ => Vec::new(),
                };
                for (duel_target, conditions) in duels {
                    let duel = conditions.as_array().and_then(|items| {
                        items.iter().find(|condition| condition.get("id").and_then(Value::as_str) == Some("compelled-duel") && js::s(condition.get("source_actor")) == acting).cloned()
                    });
                    let Some(duel) = duel else { continue };
                    let acting_enemy = sk_core::game::is_enemy_actor(&triggered, &acting);
                    let hostile = resolved.get("target_ids").and_then(Value::as_array).is_some_and(|ids| {
                        ids.iter().any(|id| {
                            let id = js::string(Some(id));
                            id != duel_target && sk_core::game::is_enemy_actor(&triggered, &id) != acting_enemy
                        })
                    });
                    if !hostile {
                        continue;
                    }
                    let payload = json!({ "reason": "duel-violated", "effect_id": duel.get("effect_id").cloned().unwrap_or(Value::Null) });
                    let mut payload = payload;
                    if duel.get("effect_id").is_none() {
                        js::delete(&mut payload, "effect_id");
                    }
                    let ended = event_from(&as_actor(&command, &acting, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&json!([acting])));
                    triggered = apply_game_event(&triggered, &ended)?;
                    self.events.push(ended);
                }
            }
            if kind != "DamageApplied" {
                continue;
            }
            let payload = resolved.get("payload");
            let damage_taken = js::safe_int(at(payload, "applied_amount"), 0) + js::safe_int(at(payload, "temporary_hp_absorbed"), 0);
            if damage_taken <= 0 {
                continue;
            }
            let damaged = js::s(resolved.get("target_ids").and_then(|ids| ids.get(0)));
            if damaged.is_empty() {
                continue;
            }
            triggered = self.damage_concentration(triggered, resolved, &damaged, damage_taken)?;
            triggered = self.damage_conditions(triggered, resolved, &damaged)?;
        }
        Ok(())
    }

    /// Концентрация под уроном: обрыв на нуле хитов или спасбросок Телосложения.
    fn damage_concentration(&mut self, mut triggered: Value, resolved: &Value, damaged: &str, damage_taken: i64) -> Result<Value, Halt> {
        let Some(concentration) = at(sk_core::game::mechanics(&triggered).get("concentration"), damaged).filter(|value| js::truthy(Some(value))).cloned() else { return Ok(triggered) };
        let mut base = spread_value(Some(&self.command));
        base.insert("actor_id".into(), Value::String(damaged.into()));
        base.insert("visibility".into(), crate::core::coalesce(&[resolved.get("visibility"), self.command.get("visibility")]).cloned().unwrap_or(Value::Null));
        let mut rule_ids_list: Vec<Value> = Vec::new();
        for list in [resolved.get("source_rule_ids"), self.command.get("source_rule_ids")] {
            if let Some(Value::Array(items)) = list {
                rule_ids_list.extend(items.iter().cloned());
            }
        }
        base.insert("source_rule_ids".into(), Value::Array(crate::core::unique_values(rule_ids_list)));
        let concentration_command = command_with_rules(&Value::Object(base), &[rule_ids::CONCENTRATION, rule_ids::SAVING_THROW]);
        let targets = json!([damaged]);
        let hp_now = sk_core::game::find_actor(&triggered, damaged).map(sk_core::game::actor_hp).unwrap_or(0);
        let effect_id = concentration.get("effect_id").cloned();
        if js::safe_int(at(resolved.get("payload"), "hp_after"), hp_now) <= 0 {
            let mut payload = Map::new();
            payload.insert("reason".into(), Value::String("incapacitated".into()));
            if let Some(effect_id) = &effect_id {
                payload.insert("effect_id".into(), effect_id.clone());
            }
            payload.insert("damage".into(), Value::from(damage_taken));
            let ended = event_from(&concentration_command, "ConcentrationEnded", Some(Value::Object(payload)), Some(&targets));
            triggered = apply_game_event(&triggered, &ended)?;
            self.events.push(ended);
            return Ok(triggered);
        }
        let difficulty = 10.max(damage_taken.div_euclid(2));
        let actor = sk_core::game::find_actor(&triggered, damaged).cloned();
        let con = Value::String("con".into());
        let proficient = crate::checks::saves::is_saving_throw_proficient(actor.as_ref(), Some(&con));
        let mut modifier = ability_modifier(at(at(actor.as_ref(), "abilities"), "con"));
        let saving_conditions = condition_ids_for(&triggered, damaged);
        let visibility = crate::core::coalesce(&[concentration_command.get("visibility")]).cloned().unwrap_or_else(|| Value::String("public".into()));
        for (condition, purpose, sign) in [("bless-d4", "spell:bless:concentration-save", 1), ("bane-d4", "spell:bane:concentration-save", -1), ("next-save-minus-d4", "spell:mind-sliver:concentration-save", -1)] {
            if !saving_conditions.contains(condition) || (condition == "bless-d4" && !crate::conditions::bless_bonus_enabled(&triggered, damaged)) {
                continue;
            }
            let roll = self.dice.roll(&[Value::String("1d4".into()), Value::String(purpose.into()), Value::String(damaged.into()), visibility.clone()])?;
            self.rolls.push(roll.clone());
            self.events.push(event_from(&concentration_command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
            modifier += sign * js::safe_int(roll.get("total"), 0);
            if condition == "next-save-minus-d4" {
                let removed = event_from(&command_with_rules(&concentration_command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": condition })), Some(&targets));
                triggered = apply_game_event(&triggered, &removed)?;
                self.events.push(removed);
            }
        }
        let silvery = saving_conditions.contains("silvery-fortune");
        let mut options = Map::new();
        options.insert("ability".into(), con.clone());
        options.insert("modifier".into(), Value::from(modifier));
        options.insert("difficulty".into(), Value::from(difficulty));
        options.insert("purpose".into(), Value::String("concentration:saving-throw".into()));
        options.insert("advantage".into(), Value::Bool(silvery));
        options.insert("visibility".into(), undef(concentration_command.get("visibility")));
        let state = triggered.clone();
        let save = self.roll_saving_throw(&state, Some(&Value::String(damaged.into())), &Value::Object(options))?;
        let saved = crate::checks::saves::saving_throw_succeeded(Some(&save), difficulty as f64);
        self.rolls.push(save.clone());
        let required = event_from(&concentration_command, "ConcentrationCheckRequired", Some(json!({ "difficulty": difficulty, "damage": damage_taken })), Some(&targets));
        let mut resolved_payload = spread_value(Some(&save));
        resolved_payload.insert("ability".into(), con);
        resolved_payload.insert("difficulty".into(), Value::from(difficulty));
        resolved_payload.insert("saved".into(), Value::Bool(saved));
        resolved_payload.insert("proficient".into(), Value::Bool(proficient));
        let resolved_event = event_from(&concentration_command, "ConcentrationSavingThrowResolved", Some(Value::Object(resolved_payload)), Some(&targets));
        self.events.push(required);
        self.events.push(resolved_event);
        if silvery {
            let removed = remove_silvery_fortune_event(&concentration_command, &triggered, damaged, None);
            triggered = apply_game_event(&triggered, &removed)?;
            self.events.push(removed);
        }
        if !saved {
            let mut payload = Map::new();
            payload.insert("reason".into(), Value::String("failed-saving-throw".into()));
            if let Some(effect_id) = &effect_id {
                payload.insert("effect_id".into(), effect_id.clone());
            }
            payload.insert("difficulty".into(), Value::from(difficulty));
            if let Some(total) = save.get("total") {
                payload.insert("total".into(), total.clone());
            }
            payload.insert("damage".into(), Value::from(damage_taken));
            let ended = event_from(&concentration_command, "ConcentrationEnded", Some(Value::Object(payload)), Some(&targets));
            triggered = apply_game_event(&triggered, &ended)?;
            self.events.push(ended);
        }
        Ok(triggered)
    }

    /// Состояния цели урона: снятие любым уроном, уроном союзника источника,
    /// повторный спасбросок.
    fn damage_conditions(&mut self, mut triggered: Value, resolved: &Value, damaged: &str) -> Result<Value, Halt> {
        let command = self.command.clone();
        let conditions = sk_core::game::conditions(&triggered, damaged).to_vec();
        let targets = json!([damaged]);
        let payload = resolved.get("payload");
        for condition in conditions {
            let source_actor = js::s(condition.get("source_actor"));
            let attacker = js::s(crate::core::coalesce(&[resolved.get("actor_id"), command.get("actor_id")]));
            let allied = !source_actor.is_empty() && !attacker.is_empty() && sk_core::game::is_enemy_actor(&triggered, &source_actor) == sk_core::game::is_enemy_actor(&triggered, &attacker);
            let taken = js::safe_int(at(payload, "applied_amount"), 0) + js::safe_int(at(payload, "temporary_hp_absorbed"), 0);
            if js::is_true(condition.get("break_on_any_damage")) && taken > 0 {
                let removed = event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(removal_payload(&condition, "damage")), Some(&targets));
                triggered = apply_game_event(&triggered, &removed)?;
                self.events.push(removed);
                continue;
            }
            let duel_source = condition.get("id").and_then(Value::as_str) == Some("compelled-duel") && attacker == source_actor;
            if js::is_true(condition.get("break_on_damage_from_source_allies")) && allied && !duel_source {
                let removed = self.concentration_or_removal(&triggered, &condition, &source_actor, damaged, "ally-damaged-duel-target", "damage");
                triggered = apply_game_event(&triggered, &removed)?;
                self.events.push(removed);
                continue;
            }
            if !js::is_true(condition.get("repeat_save_on_damage")) || !sk_core::game::find_actor(&triggered, damaged).is_some_and(sk_core::game::is_living_actor) {
                continue;
            }
            let ability = match condition.get("save_ability").filter(|value| js::truthy(Some(value))) {
                Some(value) => js::string(Some(value)),
                None => "wis".into(),
            };
            let ability_value = Value::String(ability.clone());
            let mut modifier = ability_modifier(at(at(sk_core::game::find_actor(&triggered, damaged), "abilities"), &ability));
            let condition_ids = condition_ids_for(&triggered, damaged);
            let visibility = self.visibility();
            if crate::conditions::bless_bonus_enabled(&triggered, damaged) {
                let blessing = self.roll_dice(Value::String("1d4".into()), "spell:bless:damage-repeat-save", Value::String(damaged.into()), visibility.clone())?;
                self.rolls.push(blessing.clone());
                self.events.push(event_from(&command, "DieRolled", Some(blessing.clone()), Some(&json!([]))));
                modifier += js::safe_int(blessing.get("total"), 0);
            }
            if condition_ids.contains("bane-d4") {
                let bane = self.roll_dice(Value::String("1d4".into()), "spell:bane:damage-repeat-save", Value::String(damaged.into()), visibility)?;
                self.rolls.push(bane.clone());
                self.events.push(event_from(&command, "DieRolled", Some(bane.clone()), Some(&json!([]))));
                modifier -= js::safe_int(bane.get("total"), 0);
            }
            let auto_failed = crate::conditions::auto_failed_save_condition_for(&triggered, damaged, Some(&ability_value));
            let silvery = if auto_failed.is_none() { silvery_fortune_for(&triggered, damaged) } else { None };
            let mut options = Map::new();
            options.insert("ability".into(), ability_value.clone());
            options.insert("modifier".into(), Value::from(modifier));
            options.insert("purpose".into(), Value::String(format!("spell_damage_repeat_save:{}:{ability}", js::string(condition.get("spell_id")))));
            options.insert("advantage".into(), Value::Bool(js::is_true(condition.get("damage_save_advantage")) || silvery.is_some()));
            options.insert("resistanceEligible".into(), Value::Bool(auto_failed.is_none()));
            let avoid = if condition.get("id").and_then(Value::as_str) == Some("poisoned") { Value::String("poisoned".into()) } else { Value::Null };
            options.insert("avoid_or_end_condition".into(), avoid);
            options.insert("visibility".into(), undef(command.get("visibility")));
            let state = triggered.clone();
            let save = self.roll_saving_throw(&state, Some(&Value::String(damaged.into())), &Value::Object(options))?;
            let difficulty = js::safe_int(condition.get("save_dc"), 10).max(1);
            let saved = crate::checks::saves::saving_throw_succeeded(Some(&save), difficulty as f64);
            self.rolls.push(save.clone());
            let mut save_payload = spread_value(Some(&save));
            if let Some(spell_id) = condition.get("spell_id") {
                save_payload.insert("spell_id".into(), spell_id.clone());
            }
            save_payload.insert("ability".into(), ability_value);
            save_payload.insert("difficulty".into(), Value::from(difficulty));
            save_payload.insert("saved".into(), Value::Bool(saved));
            save_payload.insert("trigger".into(), Value::String("damage-repeat".into()));
            self.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(Value::Object(save_payload)), Some(&targets)));
            if silvery.is_some() {
                let removed = remove_silvery_fortune_event(&command, &triggered, damaged, Some("damage-repeat"));
                triggered = apply_game_event(&triggered, &removed)?;
                self.events.push(removed);
            }
            if saved {
                let removed = self.concentration_or_removal(&triggered, &condition, &source_actor, damaged, "damage-save", "damage-save");
                triggered = apply_game_event(&triggered, &removed)?;
                self.events.push(removed);
            }
        }
        Ok(triggered)
    }

    /// Концентрация источника кончается, если состояние — её эффект; иначе
    /// снимается само состояние.
    fn concentration_or_removal(&self, triggered: &Value, condition: &Value, source_actor: &str, damaged: &str, reason: &str, trigger: &str) -> Value {
        let source_concentration = at(sk_core::game::mechanics(triggered).get("concentration"), source_actor);
        let effect_id = condition.get("effect_id");
        if js::truthy(effect_id) && js::s(at(source_concentration, "effect_id")) == js::string(effect_id) {
            let payload = json!({ "reason": reason, "effect_id": effect_id.cloned().unwrap_or(Value::Null) });
            return event_from(&as_actor(&self.command, source_actor, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&json!([source_actor])));
        }
        event_from(&command_with_rules(&self.command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(removal_payload(condition, trigger)), Some(&json!([damaged])))
    }

    /// Окно «Несгибаемого» после проваленного спасброска (23319–23365).
    fn indomitable_window(&mut self) -> Result<Option<Value>, Halt> {
        if self.depth != 0 || self.context.is_true("indomitableResume") || !self.events.iter().any(failed_saving_throw_event) {
            return Ok(None);
        }
        let opportunity_state = self.project_events()?;
        let opportunities = crate::checks::indomitable::indomitable_opportunities_for(&opportunity_state, &self.events, self.context.get("indomitable_bypass_actor_ids"));
        let Some(opportunity) = opportunities.first() else { return Ok(None) };
        let uses_2014 = sk_core::game::uses_2014(&self.state);
        let failed = opportunity.event.get("payload");
        let level = js::safe_int(opportunity.actor.get("level"), 9);
        let bonus = if uses_2014 { 0 } else { level };
        let description = if bonus > 0 { format!("Перебросить спасбросок с бонусом +{bonus}. Новый результат обязателен.") } else { "Перебросить проваленный спасбросок. Новый результат обязателен.".to_string() };
        let option = json!({ "id": "indomitable", "name": "Несгибаемый", "resource": "indomitable", "cost": 1, "description": description });
        let death = opportunity.event.get("event_type").and_then(Value::as_str) == Some("DeathSavingThrowRolled");
        let kept = crate::core::coalesce(&[at(failed, "kept")]).or(at(failed, "natural_roll"));
        let ability = match at(failed, "ability").filter(|value| !value.is_null()) {
            Some(value) => js::string(Some(value)),
            None => if death { "death".into() } else { String::new() },
        };
        let trigger_roll = json!({
            "kept": js::safe_int(kept, 0),
            "modifier": js::safe_int(at(failed, "modifier"), 0),
            "total": js::safe_int(at(failed, "total"), 0),
            "difficulty": js::safe_int(at(failed, "difficulty"), if death { 10 } else { 0 }),
            "ability": ability,
            "save_event_type": opportunity.event.get("event_type").cloned().unwrap_or(Value::Null),
        });
        let source_actor = crate::core::coalesce(&[self.command.get("actor_id"), opportunity.event.get("actor_id")]).map(|value| js::string(Some(value))).unwrap_or_else(|| opportunity.target_id.clone());
        let queue: Vec<Value> = opportunities
            .iter()
            .skip(1)
            .map(|candidate| {
                let level = js::safe_int(candidate.actor.get("level"), 9).max(9);
                json!({
                    "target_id": candidate.target_id,
                    "fighter_level": level,
                    "indomitable_bonus": if uses_2014 { 0 } else { level },
                    "failed_event": candidate.event,
                })
            })
            .collect();
        let mut payload = Map::new();
        payload.insert("id".into(), Value::String(format!("indomitable:{}", js::string(self.command.get("command_id")))));
        payload.insert("trigger".into(), Value::String("failed-saving-throw".into()));
        payload.insert("actor_id".into(), Value::String(opportunity.target_id.clone()));
        payload.insert("source_actor_id".into(), Value::String(source_actor));
        payload.insert("target_id".into(), Value::String(opportunity.target_id.clone()));
        payload.insert("action_ids".into(), json!(["indomitable"]));
        payload.insert("action_options".into(), Value::Array(vec![option]));
        payload.insert("trigger_roll".into(), trigger_roll);
        payload.insert("pending_command".into(), self.command.clone());
        payload.insert("pending_dice_transcript".into(), Value::Array(self.dice.transcript.clone()));
        payload.insert("failed_roll_id".into(), Value::String(js::string(at(failed, "roll_id"))));
        payload.insert("fighter_level".into(), Value::from(level.max(9)));
        payload.insert("indomitable_bonus".into(), Value::from(bonus));
        payload.insert("pending_indomitable_queue".into(), Value::Array(queue));
        payload.insert("indomitable_decisions".into(), json!([]));
        let source = command_with_rules(&self.command, &[rule_ids::SAVING_THROW, rule_ids::INDOMITABLE]);
        Ok(Some(event_from(&source, "ReactionWindowOpened", Some(Value::Object(payload)), Some(&json!([opportunity.target_id])))))
    }

    /// Последняя смерть героя кончает кампанию поражением (23367–23386).
    fn party_defeat(&mut self) -> Result<(), Halt> {
        if self.depth != 0 || !self.events.iter().any(|event| event_type(event) == "HeroDied") || self.events.iter().any(|event| event_type(event) == "CampaignFailed") {
            return Ok(());
        }
        let projected = self.project_events()?;
        let status = |state: &Value| js::s(at(sk_core::game::mechanics(state).get("death"), "campaign_status"));
        let newly = status(&self.state) != "party_defeated" && status(&projected) == "party_defeated";
        if !newly || js::s(at(sk_core::game::mechanics(&projected).get("campaign_lifecycle"), "status")) != "active" {
            return Ok(());
        }
        let options = json!({ "actorId": "system", "reason": "party_final_death", "now": null });
        let failure = sk_director::campaign_lifecycle::lifecycle_event_for_action(Some(&json!("fail")), &projected, Some(&options)).map_err(|error| fault(&error.name, error.code.clone(), error.message.clone()))?;
        // `{ ...eventFrom(command, …), actor_id: 'system', visibility: 'party' }`:
        // поле `actor_id` у события есть всегда и остаётся на своём месте.
        let source = command_with(&self.command, "actor_id", Value::String("system".into()));
        let mut event = event_from(&source, &js::s(failure.get("event_type")), failure.get("payload").cloned(), Some(&json!([])));
        event["visibility"] = Value::String("party".into());
        self.events.push(event);
        Ok(())
    }
}

/// Хвост после ветки и итог `{ command, events: resolvedEvents, rolls }`.
pub fn finish(mut r: Resolve<'_>) -> Result<Resolved, Halt> {
    r.nested_consequences()?;
    if let Some(window) = r.indomitable_window()? {
        return Ok(Resolved { command: r.command, events: vec![window], rolls: Vec::new() });
    }
    r.party_defeat()?;
    let state = r.state.clone();
    let command = r.command.clone();
    let mut resolved = crate::damage::without_immune_conditions(&state, &command, &r.events);
    let flee = r.context.get("finalizeFleeActorId").filter(|value| js::truthy(Some(value))).cloned();
    if command.get("command_type").and_then(Value::as_str) == Some("MakeAttack") {
        if let Some(flee) = flee {
            if condition_ids_for(&state, &js::s(Some(&flee))).contains("fled") {
                let source = command_with_rules(&command, &[rule_ids::CONDITIONS]);
                resolved.push(event_from(&source, "ConditionAdded", Some(json!({ "condition": "fled", "reason": "opportunity-resolved" })), Some(&json!([js::string(Some(&flee))]))));
            }
        }
    }
    let top = r.depth == 0;
    if top {
        let extra = concentration_reconciliation_events(&state, &command, &resolved)?;
        resolved.extend(extra);
    }
    if top && resolved.iter().any(|event| matches!(event_type(event), "DamageApplied" | "ActorMoved")) {
        let after = r.projector.project(&resolved)?;
        let drafts = sk_npc_world::npc_positioning::plan_authored_npc_world_events(
            &state,
            &after,
            &Value::Array(resolved.clone()),
            command.get("command_id").unwrap_or(&Value::Null),
            command.get("actor_id").unwrap_or(&Value::Null),
        );
        resolved.extend(crate::core::npc_world_events_from(&command, &Value::Array(drafts)));
    }
    if top && resolved.iter().any(|event| matches!(event_type(event), "NpcDied" | "TimeAdvanced")) {
        let mut projected = r.projector.project(&resolved)?;
        let empty = json!({});
        let vacancies = sk_world_life::world_offices::plan_office_vacancy_drafts(&projected, &resolved, &empty);
        append_world_drafts(&command, &mut resolved, &mut projected, vacancies)?;
        let successions = sk_world_life::world_offices::plan_office_succession_drafts(&projected, &empty);
        append_world_drafts(&command, &mut resolved, &mut projected, successions)?;
        let mut options = Map::new();
        if let Some(id) = sk_story::campaign_loop_policy::main_quest_for(&state).and_then(|quest| quest.get("id")) {
            options.insert("primaryQuestId".into(), id.clone());
        }
        let consequences = sk_society::quest_consequences::plan_quest_consequence_drafts(&projected, &resolved, &Value::Object(options));
        append_world_drafts(&command, &mut resolved, &mut projected, consequences)?;
    }
    if top && sk_director::loot_containers::loot_commit_touches_containers(&state, &Value::Array(resolved.clone())) {
        let after = r.projector.project(&resolved)?;
        let drafts = sk_director::loot_containers::plan_loot_container_drafts(&state, &after, &Value::Array(resolved.clone())).map_err(|error| fault(error.name, error.code.clone(), error.message.clone()))?;
        for draft in drafts {
            let mut event = event_from(&with_draft_visibility(&command, &draft), &js::s(draft.get("event_type")), draft.get("payload").cloned(), draft.get("target_ids"));
            if let Some(version) = draft.get("event_schema_version") {
                event["event_schema_version"] = version.clone();
            }
            resolved.push(event);
        }
    }
    if top {
        for event in resolved.iter_mut() {
            let kind = event_type(event);
            let payload = event.get("payload");
            if matches!(kind, "QuestInvalidated" | "QuestAssignmentChanged") && at(payload, "schema_version").and_then(Value::as_f64) == Some(2.0) && !js::truthy(event.get("event_id")) {
                let text = format!("{}:{kind}:{}", js::string(command.get("command_id")), js::string(at(payload, "quest_id")));
                event["event_id"] = Value::String(world_consequence_id(&text));
            }
        }
        if let Some(story) = sk_society::campaign_stories::campaign_story_completion_draft(&state, &resolved).map_err(Halt::Rule)? {
            resolved.push(event_from(&with_draft_visibility(&command, &story), &js::s(story.get("event_type")), story.get("payload").cloned(), story.get("target_ids")));
        }
        if let Some(level_before) = sk_scenario::campaign_scenario::scenario_milestone_level(&state) {
            let after = r.projector.project(&resolved)?;
            if let Some(level_after) = sk_scenario::campaign_scenario::scenario_milestone_level(&after).filter(|level| *level > level_before) {
                let projected = r.projector.project(&resolved)?;
                let source = command_with(&command_with(&command, "actor_id", Value::Null), "visibility", Value::String("party".into()));
                for hero_id in unique_strings(projected.get("partyMemberIds")) {
                    let Some(hero) = crate::core::player_actor(&projected, Some(&Value::String(hero_id.clone()))) else { continue };
                    let threshold = sk_character::character_lifecycle::experience_for_level(Some(&Value::from(level_after))).map_err(|error| fault(error.name, error.code.clone(), error.message.clone()))?;
                    let needed = threshold - js::safe_int(hero.get("experience"), 0).max(0);
                    if needed <= 0 {
                        continue;
                    }
                    let payload = json!({ "total_xp": needed, "recipients": [hero_id], "reason": "scenario-line", "target_level": level_after });
                    resolved.push(event_from(&source, "ExperienceAwarded", Some(payload), Some(&json!([hero_id]))));
                }
            }
        }
    }
    Ok(Resolved { command, events: resolved, rolls: r.rolls })
}

/// `append(drafts)` хвоста: черновики последствий мира в события с
/// устойчивым `event_id`, состояние идёт следом.
fn append_world_drafts(command: &Value, resolved: &mut Vec<Value>, projected: &mut Value, drafts: Vec<Value>) -> Result<(), Halt> {
    for draft in drafts {
        let mut event = event_from(&with_draft_visibility(command, &draft), &js::s(draft.get("event_type")), draft.get("payload").cloned(), draft.get("target_ids"));
        let id = match draft.get("event_id").filter(|value| js::truthy(Some(value))) {
            Some(id) => id.clone(),
            None => {
                let payload = draft.get("payload");
                let key = at(payload, "quest_id").filter(|value| js::truthy(Some(value))).or_else(|| at(payload, "office_id"));
                let text = format!("{}:{}:{}", js::string(command.get("command_id")), js::string(draft.get("event_type")), js::string(key));
                Value::String(world_consequence_id(&text))
            }
        };
        event["event_id"] = id;
        *projected = apply_game_event(projected, &event)?;
        resolved.push(event);
    }
    Ok(())
}
