//! Последствия длящихся областей: отметка срабатывания за ход, урон и
//! лечение области, вход в область, начало и конец хода в области. Задача Р5.
//!
//! JS: `server/rules-engine.mjs` — `lingeringAreaDamage`,
//! `lingeringAreaHealing`, `areaEntryConsequences`, `areaTurnConsequences`
//! (8235–8607), `areaTriggerTurnKey`, `areaEffectTriggeredThisTurn`,
//! `areaTriggerMarkEvent` (10433–10452), `wearsMetalArmor` (10461–10465).
//!
//! Все места вызова JS передают в последствия области замыкания разбора
//! (`resolveDamageWithReactions`, `rollSavingThrow`, `areaSaveModifierFor`),
//! поэтому здесь они — методы [`Resolve`]: кости, броски и события Сопротивления
//! и «Масла» идут в разбор, а события самой области возвращаются списком —
//! место вызова дописывает их следом, как `events.push(...areaTurnConsequences(…))`.

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::conditions::{area_effect_already_holds, area_effect_automatic_save, area_effect_spares_actor, auto_failed_save_condition_for, exhaustion_step_up_events, freedom_blocks_spell_condition, ExhaustionSource, EXHAUSTION_LADDER};
use crate::core::{ability_modifier, command_with, command_with_rules, condition_ids_for, event_from, spread_value};
use crate::pause::Interrupt;
use crate::replay::apply_game_event;
use crate::resolve::kernel::undef;
use crate::resolve::Resolve;
use crate::spells::enervation::{remove_silvery_fortune_event, silvery_fortune_for};
use crate::tactical_geometry::{actor_point, point_json, points_json, truthy_point};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `areaTriggerTurnKey(state)`: ключ текущего хода (вне боя — `None`).
pub fn area_trigger_turn_key(state: &Value) -> Option<String> {
    let combat = sk_core::game::mechanics(state).get("combat");
    if !js::truthy(at(combat, "active")) {
        return None;
    }
    Some(match at(combat, "turn_started_event_id").filter(|value| !value.is_null()) {
        Some(id) => js::string(Some(id)),
        None => format!("{}:{}", js::safe_int(at(combat, "round"), 1), js::safe_int(at(combat, "active_index"), 0)),
    })
}

/// `areaEffectTriggeredThisTurn(state, effect, actorId)`.
pub fn area_effect_triggered_this_turn(state: &Value, effect: Option<&Value>, actor_id: &str) -> bool {
    if !js::is_true(at(effect, "once_per_turn")) {
        return false;
    }
    let Some(key) = area_trigger_turn_key(state) else { return false };
    js::s(at(at(effect, "triggered_turns"), actor_id)) == key
}

/// `areaTriggerMarkEvent(state, command, effect, actorId, trigger)`: служебная
/// отметка срабатывания (`gm_only`).
pub fn area_trigger_mark_event(state: &Value, command: &Value, effect: Option<&Value>, actor_id: &str, trigger: &str) -> Option<Value> {
    let key = area_trigger_turn_key(state);
    let key = key.filter(|_| js::is_true(at(effect, "once_per_turn")))?;
    let source = command_with(&command_with_rules(command, &[rule_ids::CONDITIONS]), "visibility", Value::String("gm_only".into()));
    Some(event_from(&source, "SpellAreaTriggered", Some(json!({ "effect_id": effect_key(effect), "turn_key": key, "trigger": trigger })), Some(&json!([actor_id]))))
}

/// `String(effect.effect_id ?? effect.id ?? '')`.
fn effect_key(effect: Option<&Value>) -> String {
    js::s(crate::core::coalesce(&[at(effect, "effect_id"), at(effect, "id")]))
}

/// `wearsMetalArmor(actor)`: надет металлический доспех.
pub fn wears_metal_armor(actor: Option<&Value>) -> bool {
    let Some(Value::Array(items)) = at(actor, "inventory") else { return false };
    items.iter().any(|item| {
        let catalog = crate::core::coalesce(&[item.get("catalog_id"), item.get("catalogId")]);
        js::is_true(item.get("equipped")) && sk_core::text::test(sk_core::re!(r"(?:chain|scale-mail|breastplate|half-plate|ring-mail|splint|(?:^|[:-])plate(?:-armor)?$)", "u"), &js::s(catalog).to_lowercase())
    })
}

/// Действующие эффекты состояния (`state.mechanics.active_effects ?? []`).
fn active_effects(state: &Value) -> Vec<Value> {
    sk_core::game::mechanics(state).get("active_effects").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Существо ещё получает последствия: живо или герой при смерти.
fn still_affected(state: &Value, id: &str) -> bool {
    sk_core::game::find_actor(state, id).is_some_and(sk_core::game::is_living_actor) || crate::targets::is_dying_hero(state, id)
}

/// Спасбросок «автоматически» (иммунитет): форма броска без кости.
fn automatic_save(purpose: &str, actor_id: &str, visibility: Value) -> Value {
    json!({ "roll_id": null, "expression": "automatic", "dice": [], "kept": 0, "mode": "automatic", "modifier": 0, "total": 0, "purpose": purpose, "actor_id": actor_id, "visibility": visibility })
}

/// События — в список и в рабочее состояние.
fn push_all(events: &mut Vec<Value>, working: &mut Value, added: Vec<Value>) -> Result<(), Interrupt> {
    for event in added {
        *working = apply_game_event(working, &event)?;
        events.push(event);
    }
    Ok(())
}

impl Resolve<'_> {
    /// `lingeringAreaDamage(state, command, effect, targetId, { saved, trigger })`:
    /// урон длящейся области после уже брошенного спасброска.
    pub fn lingering_area_damage(&mut self, state: &Value, effect: &Value, target_id: &str, saved: bool, trigger: &str) -> Result<Vec<Value>, Interrupt> {
        let expression = effect.get("damage").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value)));
        let flat = js::safe_int(effect.get("damage_amount"), 0).max(0);
        if expression.is_none() && flat <= 0 {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        let roll = match &expression {
            Some(expression) => {
                let actor = js::string(crate::core::coalesce(&[effect.get("source_actor")]).or(self.command.get("actor_id")));
                let visibility = self.visibility();
                Some(self.roll_dice(Value::String(expression.clone()), &format!("spell_area_damage:{}", js::string(effect.get("spell_id"))), Value::String(actor), visibility)?)
            }
            None => None,
        };
        let damage_type_value = crate::core::coalesce(&[effect.get("damage_type")]).cloned().unwrap_or_else(|| Value::String("force".into()));
        if let Some(roll) = &roll {
            self.rolls.push(roll.clone());
            let mut payload = spread_value(Some(roll));
            if let Some(spell_id) = effect.get("spell_id") {
                payload.insert("spell_id".into(), spell_id.clone());
            }
            payload.insert("damage_type".into(), damage_type_value.clone());
            events.push(event_from(&self.command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        }
        let total = match &roll {
            Some(roll) => js::number(roll.get("total")),
            None => flat as f64,
        };
        let raw = if saved {
            if js::is_true(effect.get("half_on_save")) {
                (total / 2.0).floor()
            } else {
                0.0
            }
        } else {
            total
        };
        if raw.is_nan() || raw <= 0.0 {
            return Ok(events);
        }
        let damage_type = Value::String(js::string(Some(&damage_type_value)));
        let payload = self.resolve_damage_with_reactions(state, target_id, js::num(raw), &damage_type, None, Some(&mut events))?;
        let mut applied = spread_value(Some(&payload));
        if let Some(spell_id) = effect.get("spell_id") {
            applied.insert("spell_id".into(), spell_id.clone());
        }
        applied.insert("area_effect".into(), Value::Bool(true));
        applied.insert("trigger".into(), Value::String(trigger.into()));
        applied.insert("saved".into(), Value::Bool(saved));
        events.push(event_from(&command_with_rules(&self.command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(applied)), Some(&json!([target_id]))));
        events.extend(crate::death::zero_hit_point_damage_consequences(state, &self.command, target_id, &payload, false));
        Ok(events)
    }

    /// `lingeringAreaHealing(state, command, effect, targetId, { trigger })`:
    /// лечение длящейся области («Исцеляющий дух»); врага не лечит.
    pub fn lingering_area_healing(&mut self, state: &Value, effect: &Value, target_id: &str, trigger: &str) -> Result<Vec<Value>, Interrupt> {
        let Some(expression) = effect.get("healing").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))) else { return Ok(Vec::new()) };
        let Some(target) = sk_core::game::find_actor(state, target_id).filter(|target| sk_core::game::is_living_actor(target)) else { return Ok(Vec::new()) };
        let owner = js::s(effect.get("source_actor"));
        if !owner.is_empty() && sk_core::game::is_enemy_actor(state, target_id) != sk_core::game::is_enemy_actor(state, &owner) {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        let healer = js::string(crate::core::coalesce(&[effect.get("source_actor")]).or(self.command.get("actor_id")));
        let visibility = self.visibility();
        let roll = self.roll_dice(Value::String(expression.clone()), &format!("spell_area_healing:{}", js::string(effect.get("spell_id"))), Value::String(healer.clone()), visibility)?;
        self.rolls.push(roll.clone());
        let mut payload = spread_value(Some(&roll));
        if let Some(spell_id) = effect.get("spell_id") {
            payload.insert("spell_id".into(), spell_id.clone());
        }
        events.push(event_from(&self.command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        let healing = crate::damage::resolved_healing_roll(state, target_id, Some(&Value::String(expression)), roll.get("total"));
        let before = sk_core::game::actor_hp(target);
        let amount = js::safe_int(healing.get("amount"), 0);
        let after = if condition_ids_for(state, target_id).contains("healing-blocked") { before } else { crate::core::actor_max_hp(Some(target)).min(before + amount) };
        let mut applied = Map::new();
        if let Some(spell_id) = effect.get("spell_id") {
            applied.insert("spell_id".into(), spell_id.clone());
        }
        applied.insert("requested_amount".into(), healing.get("amount").cloned().unwrap_or(Value::Null));
        applied.insert("applied_amount".into(), Value::from(after - before));
        applied.insert("hp_before".into(), Value::from(before));
        applied.insert("hp_after".into(), Value::from(after));
        applied.insert("area_effect".into(), Value::Bool(true));
        applied.insert("trigger".into(), Value::String(trigger.into()));
        for (key, value) in spread_value(Some(&healing)) {
            applied.insert(key, value);
        }
        let source = command_with_rules(&command_with(&self.command, "actor_id", Value::String(healer)), &[rule_ids::HEALING]);
        events.push(event_from(&source, "HealingApplied", Some(Value::Object(applied)), Some(&json!([target_id]))));
        Ok(events)
    }

    /// Спасбросок области: модификаторы, бросок, событие, «Серебряная удача».
    /// Возвращает `saved`.
    #[allow(clippy::too_many_arguments)] // повторяет общий кусок двух функций JS
    fn area_save(&mut self, events: &mut Vec<Value>, working: &mut Value, effect: &Value, actor_id: &str, actor: Option<&Value>, ability: &str, purpose: String, trigger: &str, turn: bool) -> Result<bool, Interrupt> {
        let automatic = area_effect_automatic_save(working, actor_id, Some(effect));
        let automatic_saved = js::is_true(automatic.get("saved"));
        let ability_value = Value::String(ability.into());
        let auto_failed = if automatic_saved { None } else { auto_failed_save_condition_for(working, actor_id, Some(&ability_value)) };
        let silvery = if !automatic_saved && auto_failed.is_none() { silvery_fortune_for(working, actor_id) } else { None };
        let modifier = if automatic_saved || auto_failed.is_some() {
            0
        } else {
            let state = working.clone();
            let result = self.area_save_modifier_for(&state, Some(&Value::String(actor_id.into())))?;
            push_all(events, working, result.events)?;
            result.modifier
        };
        let save = if automatic_saved {
            automatic_save(&purpose, actor_id, self.visibility())
        } else {
            let base = ability_modifier(at(at(actor, "abilities"), ability));
            let mut options = Map::new();
            options.insert("ability".into(), ability_value.clone());
            options.insert("modifier".into(), Value::from(base + modifier));
            options.insert("purpose".into(), Value::String(purpose.clone()));
            if turn {
                options.insert("resistanceEligible".into(), Value::Bool(true));
                let avoid = if effect.get("condition").and_then(Value::as_str) == Some("poisoned") { Value::String("poisoned".into()) } else { Value::Null };
                options.insert("avoid_or_end_condition".into(), avoid);
            }
            options.insert("visibility".into(), undef(self.command.get("visibility")));
            let state = working.clone();
            self.roll_saving_throw(&state, Some(&Value::String(actor_id.into())), &Value::Object(options))?
        };
        let difficulty = js::safe_int(effect.get("save_dc"), 10).max(1) as f64;
        let saved = automatic_saved || crate::checks::saves::saving_throw_succeeded(Some(&save), difficulty);
        if !automatic_saved {
            self.rolls.push(save.clone());
        }
        let mut payload = spread_value(Some(&save));
        if let Some(spell_id) = effect.get("spell_id") {
            payload.insert("spell_id".into(), spell_id.clone());
        }
        payload.insert("ability".into(), ability_value);
        if let Some(dc) = effect.get("save_dc") {
            payload.insert("difficulty".into(), dc.clone());
        }
        payload.insert("saved".into(), Value::Bool(saved));
        payload.insert("trigger".into(), Value::String(trigger.into()));
        if let Some(reason) = automatic.get("reason").filter(|value| js::truthy(Some(value))) {
            payload.insert("automatic_success".into(), Value::Bool(true));
            payload.insert("immunity".into(), reason.clone());
        }
        let event = event_from(&command_with_rules(&self.command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(Value::Object(payload)), Some(&json!([actor_id])));
        push_all(events, working, vec![event])?;
        if silvery.is_some() {
            let removed = remove_silvery_fortune_event(&self.command, working, actor_id, Some(trigger));
            push_all(events, working, vec![removed])?;
        }
        Ok(saved)
    }

    /// Урон и лечение области — в список и в рабочее состояние.
    fn area_damage_and_healing(&mut self, events: &mut Vec<Value>, working: &mut Value, effect: &Value, actor_id: &str, saved: bool, trigger: &str) -> Result<(), Interrupt> {
        let state = working.clone();
        let damage = self.lingering_area_damage(&state, effect, actor_id, saved, trigger)?;
        push_all(events, working, damage)?;
        let state = working.clone();
        let healing = self.lingering_area_healing(&state, effect, actor_id, trigger)?;
        push_all(events, working, healing)
    }

    /// Состояние области при провале: истощение ступенью или `ConditionAdded`.
    fn area_condition_events(&self, working: &Value, effect: &Value, actor_id: &str, trigger: &str, with_spell: bool) -> Vec<Value> {
        let condition = js::string(effect.get("condition"));
        if condition == EXHAUSTION_LADDER {
            let trigger_value = Value::String(trigger.into());
            return exhaustion_step_up_events(
                working,
                &self.command,
                actor_id,
                ExhaustionSource { source_actor: effect.get("source_actor"), effect_id: effect.get("effect_id"), spell_id: effect.get("spell_id"), trigger: Some(&trigger_value) },
            );
        }
        let mut payload = Map::new();
        payload.insert("condition".into(), Value::String(condition));
        payload.insert("duration".into(), crate::core::coalesce(&[effect.get("condition_duration")]).cloned().unwrap_or_else(|| Value::String("until-next-turn".into())));
        if let Some(source) = effect.get("source_actor") {
            payload.insert("source_actor".into(), source.clone());
        }
        if let Some(effect_id) = effect.get("effect_id") {
            payload.insert("effect_id".into(), effect_id.clone());
        }
        if with_spell {
            if let Some(spell_id) = effect.get("spell_id") {
                payload.insert("spell_id".into(), spell_id.clone());
            }
            payload.insert("trigger".into(), Value::String(trigger.into()));
        }
        vec![event_from(&command_with_rules(&self.command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(payload)), Some(&json!([actor_id])))]
    }

    /// `areaEntryConsequences(state, command, movedId, from, to, { trigger = 'area-enter' })`:
    /// вход в длящуюся область шагом или принудительным перемещением.
    pub fn area_entry_consequences(&mut self, state: &Value, moved_id: &str, from: Option<&Value>, to: Option<&Value>, trigger: Option<&str>) -> Result<Vec<Value>, Interrupt> {
        let trigger = trigger.unwrap_or("area-enter");
        if !js::truthy(to) {
            return Ok(Vec::new());
        }
        let moved = sk_core::game::find_actor(state, moved_id).cloned();
        let to_point = truthy_point(to);
        let from_point = truthy_point(from);
        let candidates: Vec<Value> = active_effects(state)
            .into_iter()
            .filter(|candidate| {
                js::is_true(candidate.get("trigger_on_enter"))
                    && !area_effect_spares_actor(Some(candidate), moved_id)
                    && crate::areas::shape::position_in_effect(state, to_point, candidate, moved.as_ref())
                    && !crate::areas::shape::position_in_effect(state, from_point, candidate, moved.as_ref())
            })
            .collect();
        let mut events = Vec::new();
        let mut working = state.clone();
        for effect in candidates {
            if !still_affected(&working, moved_id) {
                break;
            }
            let effect_id = effect_key(Some(&effect));
            let live = active_effects(&working).into_iter().find(|candidate| effect_key(Some(candidate)) == effect_id);
            if !effect_id.is_empty() && live.is_none() {
                continue;
            }
            if area_effect_triggered_this_turn(&working, Some(live.as_ref().unwrap_or(&effect)), moved_id) || area_effect_already_holds(&working, Some(&effect), moved_id) {
                continue;
            }
            if let Some(mark) = area_trigger_mark_event(&working, &self.command, Some(&effect), moved_id, trigger) {
                push_all(&mut events, &mut working, vec![mark])?;
            }
            let moved_actor = sk_core::game::find_actor(&working, moved_id).cloned().or_else(|| moved.clone());
            let ability = effect.get("save_ability").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value)));
            let mut saved = js::is_true(area_effect_automatic_save(&working, moved_id, Some(&effect)).get("saved"));
            if let Some(ability) = &ability {
                let purpose = format!("spell_area_enter:{}:{ability}", js::string(effect.get("spell_id")));
                saved = self.area_save(&mut events, &mut working, &effect, moved_id, moved_actor.as_ref(), ability, purpose, trigger, false)?;
            }
            self.area_damage_and_healing(&mut events, &mut working, &effect, moved_id, saved, trigger)?;
            if !saved && js::truthy(effect.get("condition")) && !freedom_blocks_spell_condition(&working, moved_id, &js::string(effect.get("condition"))) {
                let added = self.area_condition_events(&working, &effect, moved_id, trigger, false);
                push_all(&mut events, &mut working, added)?;
            }
        }
        Ok(events)
    }

    /// `areaTurnConsequences(state, command, actorId, { trigger = 'turn-start' })`:
    /// начало или конец хода внутри длящейся области.
    pub fn area_turn_consequences(&mut self, state: &Value, actor_id: Option<&Value>, trigger: Option<&str>) -> Result<Vec<Value>, Interrupt> {
        let trigger = trigger.unwrap_or("turn-start");
        let id = js::s(actor_id);
        let Some(actor) = sk_core::game::find_actor(state, &id).cloned() else { return Ok(Vec::new()) };
        if !sk_core::game::is_living_actor(&actor) && !crate::targets::is_dying_hero(state, &id) {
            return Ok(Vec::new());
        }
        let Some(position) = actor_point(state, &id) else { return Ok(Vec::new()) };
        let turn_start = trigger == "turn-start";
        let field = if turn_start { "trigger_on_turn_start" } else { "trigger_on_turn_end" };
        let candidates: Vec<Value> = active_effects(state)
            .into_iter()
            .filter(|candidate| {
                (js::is_true(candidate.get(field)) || (turn_start && js::truthy(candidate.get("turn_start_profile"))))
                    && !area_effect_spares_actor(Some(candidate), &id)
                    && crate::areas::shape::area_effect_affects_actor(state, Some(position), candidate, Some(&actor))
            })
            .collect();
        let mut events = Vec::new();
        let mut working = state.clone();
        for area_effect in candidates {
            let effect = match area_effect.get("turn_start_profile").filter(|profile| turn_start && js::truthy(Some(profile))) {
                Some(profile) => {
                    let mut map = spread_value(Some(&area_effect));
                    map.insert("half_on_save".into(), Value::Bool(false));
                    // `condition_duration: undefined` — поле читают только через `??`.
                    map.shift_remove("condition_duration");
                    for (key, value) in spread_value(Some(profile)) {
                        map.insert(key, value);
                    }
                    Value::Object(map)
                }
                None => area_effect.clone(),
            };
            if !still_affected(&working, &id) {
                break;
            }
            let effect_id = effect_key(Some(&effect));
            let live = active_effects(&working).into_iter().find(|candidate| effect_key(Some(candidate)) == effect_id);
            if !effect_id.is_empty() && live.is_none() {
                continue;
            }
            if turn_start {
                if area_effect_triggered_this_turn(&working, Some(live.as_ref().unwrap_or(&effect)), &id) {
                    continue;
                }
                if let Some(mark) = area_trigger_mark_event(&working, &self.command, Some(&effect), &id, trigger) {
                    push_all(&mut events, &mut working, vec![mark])?;
                }
                if area_effect_already_holds(&working, Some(&effect), &id) {
                    let state = working.clone();
                    let damage = self.lingering_area_damage(&state, &effect, &id, false, trigger)?;
                    push_all(&mut events, &mut working, damage)?;
                    continue;
                }
            }
            let effect_actor = sk_core::game::find_actor(&working, &id).cloned().unwrap_or_else(|| actor.clone());
            let ability = effect.get("save_ability").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value)));
            let mut saved = js::is_true(area_effect_automatic_save(&working, &id, Some(&effect)).get("saved"));
            if let Some(ability) = &ability {
                let purpose = format!("spell_area_{trigger}:{}:{ability}", js::string(effect.get("spell_id")));
                saved = self.area_save(&mut events, &mut working, &effect, &id, Some(&effect_actor), ability, purpose, trigger, true)?;
            }
            self.area_damage_and_healing(&mut events, &mut working, &effect, &id, saved, trigger)?;
            if !saved {
                if js::is_true(effect.get("spend_action_on_fail")) {
                    let action_command = command_with(&command_with(&self.command, "actor_id", Value::String(id.clone())), "target_ids", json!([id]));
                    let mut payload = Map::new();
                    let spell_label = match effect.get("spell_id").filter(|value| !value.is_null()) {
                        Some(spell) => js::string(Some(spell)),
                        None => "area".into(),
                    };
                    payload.insert("action_id".into(), Value::String(format!("{spell_label}:failed-save-action")));
                    payload.insert("name".into(), crate::core::coalesce(&[effect.get("failed_action_name")]).cloned().unwrap_or_else(|| Value::String("Потеря действия".into())));
                    payload.insert("action_type".into(), Value::String("action".into()));
                    payload.insert("normal_action_only".into(), Value::Bool(true));
                    if let Some(spell_id) = effect.get("spell_id") {
                        payload.insert("spell_id".into(), spell_id.clone());
                    }
                    payload.insert("trigger".into(), Value::String(trigger.into()));
                    let event = event_from(&command_with_rules(&action_command, &[rule_ids::TURNS]), "CombatActionUsed", Some(Value::Object(payload)), Some(&json!([id])));
                    push_all(&mut events, &mut working, vec![event])?;
                } else if js::truthy(effect.get("condition")) && !freedom_blocks_spell_condition(&working, &id, &js::string(effect.get("condition"))) {
                    let added = self.area_condition_events(&working, &effect, &id, trigger, true);
                    push_all(&mut events, &mut working, added)?;
                }
                if js::safe_int(effect.get("push_feet"), 0) > 0 && sk_core::game::find_actor(&working, &id).is_some_and(sk_core::game::is_living_actor) {
                    let source = js::s(effect.get("source_actor"));
                    let origin = actor_point(&working, &source).or_else(|| truthy_point(effect.get("center")));
                    let pushed_from = actor_point(&working, &id);
                    let path = crate::geometry::forced::forced_push_path(&working, &id, origin, js::number(effect.get("push_feet")));
                    if let Some(last) = path.last().copied() {
                        let mover = sk_core::game::find_actor(&working, &id).cloned().unwrap_or(Value::Null);
                        let remaining = crate::speed::effective_speed_feet(&working, &mover, &id);
                        let mut payload = Map::new();
                        payload.insert("from".into(), pushed_from.map(point_json).unwrap_or(Value::Null));
                        payload.insert("to".into(), point_json(last));
                        payload.insert("path".into(), points_json(&path));
                        payload.insert("distance".into(), Value::from(path.len() as i64 * 5));
                        payload.insert("movement_cost".into(), Value::from(0));
                        payload.insert("movement_spent".into(), Value::from(0));
                        payload.insert("movement_remaining".into(), Value::from(remaining));
                        payload.insert("spend_movement".into(), Value::Bool(false));
                        payload.insert("forced_movement".into(), Value::Bool(true));
                        if let Some(spell_id) = effect.get("spell_id") {
                            payload.insert("spell_id".into(), spell_id.clone());
                        }
                        payload.insert("phase".into(), Value::String("combat".into()));
                        payload.insert("trigger".into(), Value::String(trigger.into()));
                        let pushed = event_from(&command_with_rules(&self.command, &[rule_ids::CONDITIONS]), "ActorMoved", Some(Value::Object(payload)), Some(&json!([id])));
                        push_all(&mut events, &mut working, vec![pushed])?;
                        let from_value = pushed_from.map(point_json);
                        let to_value = point_json(last);
                        let state = working.clone();
                        let entry = self.area_entry_consequences(&state, &id, from_value.as_ref(), Some(&to_value), Some("forced-entry"))?;
                        push_all(&mut events, &mut working, entry)?;
                    }
                }
            }
            if turn_start && js::is_true(effect.get("concentration_save_on_turn_start")) {
                self.area_concentration_save(&mut events, &mut working, &effect, &id, trigger)?;
            }
        }
        Ok(events)
    }

    /// Особый спасбросок концентрации в начале хода («Метель»).
    fn area_concentration_save(&mut self, events: &mut Vec<Value>, working: &mut Value, effect: &Value, id: &str, trigger: &str) -> Result<(), Interrupt> {
        let Some(concentration) = sk_core::game::mechanics(working).get("concentration").and_then(|all| all.get(id)).filter(|value| js::truthy(Some(value))).cloned() else { return Ok(()) };
        let Some(actor) = sk_core::game::find_actor(working, id).filter(|actor| sk_core::game::is_living_actor(actor)).cloned() else { return Ok(()) };
        let con = Value::String("con".into());
        let proficient = crate::checks::saves::is_saving_throw_proficient(Some(&actor), Some(&con));
        let modifier = ability_modifier(at(actor.get("abilities"), "con"));
        let war_caster = !sk_core::game::uses_2014(working) && crate::spells::slots::concentration_save_advantage_for(Some(&actor));
        let silvery = silvery_fortune_for(working, id).is_some();
        let command = command_with_rules(&self.command, &[rule_ids::CONCENTRATION, rule_ids::SAVING_THROW]);
        let difficulty = js::safe_int(effect.get("save_dc"), 10).max(1);
        let purpose = format!("concentration:{}:turn-start", js::string(effect.get("spell_id")));
        let state = working.clone();
        let modifier_result = self.area_save_modifier_for(&state, Some(&Value::String(id.into())))?;
        push_all(events, working, modifier_result.events)?;
        let mut options = Map::new();
        options.insert("ability".into(), con.clone());
        options.insert("modifier".into(), Value::from(modifier + modifier_result.modifier));
        options.insert("purpose".into(), Value::String(purpose));
        options.insert("advantage".into(), Value::Bool(war_caster || silvery));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let state = working.clone();
        let save = self.roll_saving_throw(&state, Some(&Value::String(id.into())), &Value::Object(options))?;
        let saved = crate::checks::saves::saving_throw_succeeded(Some(&save), difficulty as f64);
        self.rolls.push(save.clone());
        let targets = json!([id]);
        let mut required = Map::new();
        required.insert("difficulty".into(), Value::from(difficulty));
        required.insert("trigger".into(), Value::String(trigger.into()));
        if let Some(spell_id) = effect.get("spell_id") {
            required.insert("spell_id".into(), spell_id.clone());
        }
        let required = event_from(&command, "ConcentrationCheckRequired", Some(Value::Object(required)), Some(&targets));
        let mut resolved = spread_value(Some(&save));
        resolved.insert("ability".into(), con);
        resolved.insert("difficulty".into(), Value::from(difficulty));
        resolved.insert("saved".into(), Value::Bool(saved));
        resolved.insert("proficient".into(), Value::Bool(proficient));
        resolved.insert("trigger".into(), Value::String(trigger.into()));
        if let Some(spell_id) = effect.get("spell_id") {
            resolved.insert("spell_id".into(), spell_id.clone());
        }
        if war_caster {
            resolved.insert("war_caster".into(), Value::Bool(true));
        }
        let resolved = event_from(&command, "ConcentrationSavingThrowResolved", Some(Value::Object(resolved)), Some(&targets));
        push_all(events, working, vec![required, resolved])?;
        if silvery {
            let removed = remove_silvery_fortune_event(&self.command, working, id, Some(trigger));
            push_all(events, working, vec![removed])?;
        }
        if !saved {
            let mut payload = Map::new();
            payload.insert("reason".into(), Value::String("sleet-storm".into()));
            if let Some(effect_id) = concentration.get("effect_id") {
                payload.insert("effect_id".into(), effect_id.clone());
            }
            payload.insert("difficulty".into(), Value::from(difficulty));
            if let Some(total) = save.get("total") {
                payload.insert("total".into(), total.clone());
            }
            if let Some(spell_id) = effect.get("spell_id") {
                payload.insert("spell_id".into(), spell_id.clone());
            }
            let ended = event_from(&command, "ConcentrationEnded", Some(Value::Object(payload)), Some(&targets));
            push_all(events, working, vec![ended])?;
        }
        Ok(())
    }
}
