//! Методы контекста разбора — замыкания `resolveCommandInternal`
//! (`rules-engine.mjs`, 13083–13094, 13337–13722): вдохновение барда,
//! Сопротивление, спасброски, модификаторы спасброска области, легендарное
//! сопротивление, урон с защитами и реакциями, «Волшебная стрела», кости
//! количества. Задача Р5.
//!
//! В JS замыкания видят `events`, `rolls`, `diceService` (с записью
//! стенограммы), `command`, `context` и выборы реакций; здесь — поля
//! [`Resolve`]. Паузы боя (`ResistanceChoicePause`, `ResistanceAfterRollPause`,
//! `ElementalDamageReactionPause`, `ProtectiveReactionPause`) бросаются как
//! [`Interrupt::Pause`] со стенограммой костей на момент броска.
//!
//! Опции бросков: ключ со значением `undefined` в JS держит место в объекте,
//! поэтому здесь он помечается [`js::UNDEFINED`] (см. [`undef`]); кости и
//! стенограмма его не видят, а порядок ключей совпадает с JS.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::Resolve;
use crate::dice_record::RulesDice;
use crate::command::rules::rule_ids;
use crate::constants::MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION;
use crate::core::{command_with, command_with_rules, condition_ids_for, event_from, spread_value};
use crate::pause::{resistance_choice_mode, resistance_choices_object, resistance_condition_for, ElementalDamageArgs, Interrupt, Pause, ProtectiveReactionArgs, ResistanceChoiceArgs};

/// `value` или маркер `undefined` (ключ есть, значения нет).
pub fn undef(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or_else(|| Value::String(js::UNDEFINED.into()))
}

/// `options[key]` с маркером `undefined` как отсутствием.
pub fn opt<'a>(options: &'a Value, key: &str) -> Option<&'a Value> {
    options.get(key).filter(|value| value.as_str() != Some(js::UNDEFINED))
}

/// Копия опций без полей-маркеров `undefined`.
pub fn defined(options: &Value) -> Value {
    let mut copy = options.clone();
    js::strip_undefined(&mut copy);
    copy
}

/// Итог `resistanceSaveState`: `{ bonus, condition, saveKey, mode }`.
#[derive(Debug, Clone)]
pub struct ResistanceState {
    pub bonus: i64,
    pub condition: Option<Value>,
    pub save_key: Option<String>,
    pub mode: String,
}

/// Итог `areaSaveModifierFor`: `{ modifier, events }`.
#[derive(Debug, Clone, Default)]
pub struct SaveModifier {
    pub modifier: i64,
    pub events: Vec<Value>,
}

/// Итог `legendaryResistanceFor`: события и решение.
#[derive(Debug, Clone)]
pub struct LegendaryResistance {
    pub events: Vec<Value>,
    pub decision: sk_combat_base::legendary_actions::LegendaryResistanceDecision,
}

/// Аргументы `appendMagicMissileResolution`.
#[derive(Debug, Clone, Copy)]
pub struct MagicMissile<'a> {
    pub source_command: &'a Value,
    pub spell: &'a Value,
    pub target: &'a Value,
    pub slot_level: Option<&'a Value>,
    pub damage_type: &'a Value,
    pub source_item: Option<&'a Value>,
}

/// `Object.fromEntries(map)`.
fn from_entries(map: &sk_core::indexmap::IndexMap<String, Value>) -> Value {
    Value::Object(map.iter().map(|(key, value)| (key.clone(), value.clone())).collect())
}

impl Resolve<'_> {
    /// `command.visibility ?? 'public'` — четвёртый аргумент бросков.
    fn roll_visibility(&self) -> Value {
        self.visibility()
    }

    /// `diceService.roll(expression, purpose, actorId, visibility)`.
    pub fn roll_dice(&mut self, expression: Value, purpose: &str, actor_id: Value, visibility: Value) -> Result<Value, Interrupt> {
        Ok(self.dice.roll(&[expression, Value::String(purpose.into()), actor_id, visibility])?)
    }

    /// Выборы реакций для конструкторов пауз: Сопротивление, стихии, защиты.
    fn pause_choices(&self) -> (Value, Value, Value) {
        (resistance_choices_object(&self.resistance_choices), from_entries(&self.elemental_reaction_choices), from_entries(&self.protective_reaction_choices))
    }

    /// `spendBardicInspiration(sourceState, ownerId, trigger)` (13083):
    /// кость вдохновения к проваленному броску, один раз на владельца.
    pub fn spend_bardic_inspiration(&mut self, source_state: &Value, owner_id: Option<&Value>, trigger: &str) -> Result<i64, Interrupt> {
        let owner = js::s(owner_id);
        if self.inspiration_spent.contains(&owner) {
            return Ok(0);
        }
        let Some(inspiration) = crate::combat::class_features::bardic_inspiration_for(source_state, &owner) else { return Ok(0) };
        self.inspiration_spent.insert(owner.clone());
        let visibility = self.roll_visibility();
        let boost = self.roll_dice(Value::String(format!("1d{}", inspiration.sides)), "bardic-inspiration", Value::String(owner.clone()), visibility)?;
        self.rolls.push(boost.clone());
        let mut payload = spread_value(Some(&boost));
        payload.insert("bardic_inspiration".into(), Value::Bool(true));
        payload.insert("trigger".into(), Value::String(trigger.into()));
        self.events.push(event_from(&self.command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        let source = command_with_rules(&self.command, &[rule_ids::CONDITIONS]);
        self.events.push(event_from(&source, "ConditionRemoved", Some(json!({ "condition": "bardic-inspiration", "trigger": trigger })), Some(&json!([owner]))));
        Ok(js::safe_int(boost.get("total"), 0))
    }

    /// `damageTurnKey(sourceState)`: ключ хода для «раз в ход» (Сопротивление урону).
    pub fn damage_turn_key(&self, source_state: &Value) -> String {
        let combat = sk_core::game::combat(source_state);
        if !js::truthy(combat.get("active")) {
            return format!("command:{}", js::string(self.command.get("command_id")));
        }
        let index = js::safe_int(combat.get("active_index"), -1);
        let entry = combat.get("initiative").and_then(Value::as_array).and_then(|initiative| usize::try_from(index).ok().and_then(|index| initiative.get(index)));
        let active = crate::core::coalesce(&[entry.and_then(|entry| entry.get("actor_id")), self.command.get("actor_id")]);
        format!("combat:{}:{}", js::safe_int(combat.get("round"), 1), js::string(active))
    }

    /// `consumeResistanceBonus(sourceState, targetId, condition)`: 1к4
    /// Сопротивления и снятие состояния (или концентрации его источника).
    pub fn consume_resistance_bonus(&mut self, source_state: &Value, target_id: &str, condition: &Value) -> Result<i64, Interrupt> {
        let visibility = self.roll_visibility();
        let roll = self.roll_dice(Value::String("1d4".into()), "spell:resistance:save", Value::String(target_id.into()), visibility)?;
        self.rolls.push(roll.clone());
        let mut payload = spread_value(Some(&roll));
        payload.insert("modifier_source".into(), Value::String("resistance".into()));
        payload.insert("spell_id".into(), Value::String("resistance".into()));
        payload.insert("target_id".into(), Value::String(target_id.into()));
        let source = command_with_rules(&self.command, &[rule_ids::RESISTANCE, rule_ids::SAVING_THROW]);
        self.events.push(event_from(&source, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        self.resistance_used_targets.insert(target_id.to_string());
        let source_actor = js::s(condition.get("source_actor"));
        let effect_id = js::s(condition.get("effect_id"));
        let concentration = sk_core::game::mechanics(source_state).get("concentration").and_then(|all| all.get(&source_actor));
        if !source_actor.is_empty() && !effect_id.is_empty() && js::s(concentration.and_then(|entry| entry.get("effect_id"))) == effect_id {
            let source = command_with_rules(&command_with(&self.command, "actor_id", Value::String(source_actor.clone())), &[rule_ids::RESISTANCE, rule_ids::CONCENTRATION]);
            self.events.push(event_from(&source, "ConcentrationEnded", Some(json!({ "reason": "resistance-used", "effect_id": effect_id, "spell_id": "resistance" })), Some(&json!([source_actor]))));
        } else {
            let source = command_with_rules(&self.command, &[rule_ids::RESISTANCE, rule_ids::CONDITIONS]);
            let condition_id = match condition.get("id").filter(|value| !value.is_null()) {
                Some(id) => js::string(Some(id)),
                None => "resistance-d4".into(),
            };
            let effect = if effect_id.is_empty() { Value::Null } else { Value::String(effect_id) };
            self.events.push(event_from(
                &source,
                "ConditionRemoved",
                Some(json!({ "condition": condition_id, "effect_id": effect, "spell_id": "resistance", "trigger": "saving-throw" })),
                Some(&json!([target_id])),
            ));
        }
        Ok(js::safe_int(roll.get("total"), 0))
    }

    /// `resistanceSaveState(sourceState, targetId, options)`: бонус
    /// Сопротивления к этому спасброску; окно выбора — пауза.
    pub fn resistance_save_state(&mut self, source_state: &Value, target_id: Option<&Value>, options: &Value) -> Result<ResistanceState, Interrupt> {
        let target = js::s(target_id);
        self.resistance_save_sequence += 1;
        let sequence = self.resistance_save_sequence;
        let condition = if sk_core::game::uses_2014(source_state) { resistance_condition_for(source_state, &target).cloned() } else { None };
        let auto_failed = crate::conditions::auto_failed_save_condition_for(source_state, &target, opt(options, "ability"));
        let mut bonus = 0;
        let mut mode = "none".to_string();
        let mut save_key = None;
        if let Some(condition_value) = condition.as_ref() {
            if !js::is_false(opt(options, "resistanceEligible")) && auto_failed.is_none() && !self.resistance_used_targets.contains(&target) {
                let purpose = match opt(options, "purpose").filter(|value| !value.is_null()) {
                    Some(purpose) => js::string(Some(purpose)),
                    None => "saving-throw".into(),
                };
                let key = format!("{target}:{purpose}:{sequence}");
                save_key = Some(key.clone());
                let context_choice = self.context.get("resistanceChoice");
                let context_matches = context_choice.and_then(|choice| choice.get("save_key")).and_then(Value::as_str) == Some(key.as_str())
                    && js::s(context_choice.and_then(|choice| choice.get("target_id"))) == target;
                if let Some(choice) = self.resistance_choices.get(&key) {
                    mode = resistance_choice_mode(Some(choice));
                } else if context_matches {
                    mode = resistance_choice_mode(context_choice.and_then(|choice| choice.get("use")));
                    self.resistance_choices.insert(key.clone(), json!({ "mode": mode, "use": mode == "before-roll" }));
                } else if sk_core::game::is_enemy_actor(source_state, &target) {
                    mode = "before-roll".into();
                    self.resistance_choices.insert(key.clone(), json!({ "mode": mode, "use": true }));
                } else {
                    let (choices, elemental, protective) = self.pause_choices();
                    let target_value = Value::String(target.clone());
                    let key_value = Value::String(key);
                    let pause = Pause::resistance_choice(&ResistanceChoiceArgs {
                        command: &self.command,
                        target_id: &target_value,
                        condition: Some(condition_value),
                        save_key: &key_value,
                        dice_transcript: &self.dice.transcript,
                        choices: Some(&choices),
                        elemental_choices: Some(&elemental),
                        protective_choices: Some(&protective),
                        phase: None,
                    });
                    return Err(Interrupt::pause(pause));
                }
                if mode == "before-roll" {
                    bonus = self.consume_resistance_bonus(source_state, &target, condition_value)?;
                }
            }
        }
        Ok(ResistanceState { bonus, condition, save_key, mode })
    }

    /// `rollSavingThrow(sourceState, targetId, options)`: спасбросок с
    /// Сопротивлением, паузой «после броска» и вдохновением барда.
    pub fn roll_saving_throw(&mut self, source_state: &Value, target_id: Option<&Value>, options: &Value) -> Result<Value, Interrupt> {
        let resistance = self.resistance_save_state(source_state, target_id, options)?;
        let target = js::s(target_id);
        let mut roll_options = spread_value(Some(options));
        roll_options.insert("modifier".into(), Value::from(js::safe_int(opt(options, "modifier"), 0) + resistance.bonus));
        let save = crate::checks::saves::roll_saving_throw_d20(source_state, &mut self.dice, &target, &Value::Object(roll_options))?;
        if resistance.mode == "after" {
            let (choices, elemental, protective) = self.pause_choices();
            let target_value = Value::String(target.clone());
            let key_value = resistance.save_key.clone().map(Value::String).unwrap_or(Value::Null);
            let plain = defined(options);
            let pause = Pause::resistance_after_roll(
                &ResistanceChoiceArgs {
                    command: &self.command,
                    target_id: &target_value,
                    condition: resistance.condition.as_ref(),
                    save_key: &key_value,
                    dice_transcript: &self.dice.transcript,
                    choices: Some(&choices),
                    elemental_choices: Some(&elemental),
                    protective_choices: Some(&protective),
                    phase: None,
                },
                Some(&save),
                Some(&plain),
            );
            return Err(Interrupt::pause(pause));
        }
        let mut result = save.clone();
        if resistance.mode == "after-use" {
            if let Some(condition) = resistance.condition.as_ref() {
                let bonus = self.consume_resistance_bonus(source_state, &target, condition)?;
                let mut map = spread_value(Some(&save));
                map.insert("modifier".into(), Value::from(js::safe_int(save.get("modifier"), 0) + bonus));
                map.insert("total".into(), Value::from(js::safe_int(save.get("total"), 0) + bonus));
                map.insert("resistance_bonus".into(), Value::from(bonus));
                result = Value::Object(map);
            }
        }
        let difficulty = js::number(opt(options, "difficulty"));
        if difficulty.is_finite() && !js::is_true(result.get("auto_failed")) && (js::safe_int(result.get("total"), 0) as f64) < difficulty {
            let boost = self.spend_bardic_inspiration(source_state, Some(&Value::String(target.clone())), "saving-throw")?;
            if boost != 0 {
                let mut map = spread_value(Some(&result));
                map.insert("total".into(), Value::from(js::safe_int(result.get("total"), 0) + boost));
                map.insert("bardic_inspiration".into(), Value::from(boost));
                result = Value::Object(map);
            }
        }
        Ok(result)
    }

    /// `areaSaveModifierFor(sourceState, targetId)`: «Благословение», «Порча»
    /// и «Осколок разума» к спасброску области. События — отдельно.
    pub fn area_save_modifier_for(&mut self, source_state: &Value, target_id: Option<&Value>) -> Result<SaveModifier, Interrupt> {
        let target = js::s(target_id);
        let conditions = sk_core::game::conditions(source_state, &target).to_vec();
        let ids: sk_core::indexmap::IndexSet<String> = conditions.iter().map(sk_core::game::condition_id).collect();
        let mut result = SaveModifier::default();
        let visibility = self.roll_visibility();
        if crate::conditions::bless_bonus_enabled(source_state, &target) {
            let blessing = self.roll_dice(Value::String("1d4".into()), "spell:bless:saving-throw", Value::String(target.clone()), visibility.clone())?;
            self.rolls.push(blessing.clone());
            result.modifier += js::safe_int(blessing.get("total"), 0);
            let mut payload = spread_value(Some(&blessing));
            payload.insert("modifier_source".into(), Value::String("bless".into()));
            result.events.push(event_from(&self.command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        }
        if ids.contains("bane-d4") {
            let bane = self.roll_dice(Value::String("1d4".into()), "spell:bane:saving-throw", Value::String(target.clone()), visibility.clone())?;
            self.rolls.push(bane.clone());
            result.modifier -= js::safe_int(bane.get("total"), 0);
            let mut payload = spread_value(Some(&bane));
            payload.insert("modifier_source".into(), Value::String("bane".into()));
            result.events.push(event_from(&self.command, "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        }
        if let Some(next_save) = conditions.iter().find(|condition| sk_core::game::condition_id(condition) == "next-save-minus-d4") {
            let penalty = self.roll_dice(Value::String("1d4".into()), "spell:mind-sliver", Value::String(target.clone()), visibility)?;
            self.rolls.push(penalty.clone());
            result.modifier -= js::safe_int(penalty.get("total"), 0);
            result.events.push(event_from(&self.command, "DieRolled", Some(penalty), Some(&json!([]))));
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String("next-save-minus-d4".into()));
            if let Some(effect_id) = next_save.get("effect_id").filter(|value| !value.is_null()) {
                payload.insert("effect_id".into(), Value::String(js::string(Some(effect_id))));
            }
            payload.insert("spell_id".into(), Value::String("mind-sliver".into()));
            payload.insert("trigger".into(), Value::String("saving-throw".into()));
            let source = command_with_rules(&self.command, &[rule_ids::CONDITIONS]);
            result.events.push(event_from(&source, "ConditionRemoved", Some(Value::Object(payload)), Some(&json!([target]))));
        }
        Ok(result)
    }

    /// `legendaryResistanceFor(sourceState, targetId, { conditions, damage })`:
    /// проваленный спасбросок босса объявляется успешным.
    pub fn legendary_resistance_for(&mut self, source_state: &Value, target_id: Option<&Value>, conditions: &[Value], damage: f64) -> Option<LegendaryResistance> {
        let id = js::s(target_id);
        let target = sk_core::game::find_actor(source_state, &id)?;
        if !sk_core::game::is_enemy_actor(source_state, &id) {
            return None;
        }
        let in_command = self.legendary_spends_in_command.get(&id).copied().unwrap_or(0);
        let spent = sk_combat_base::legendary_actions::legendary_resistance_spent(condition_ids_for(source_state, &id).iter()) as i64 + in_command;
        let decision = sk_combat_base::legendary_actions::legendary_resistance_decision(Some(target), spent as f64, conditions, damage, sk_core::game::actor_hp(target) as f64)?;
        self.legendary_spends_in_command.insert(id.clone(), in_command + 1);
        let hidden = command_with(&self.command, "visibility", Value::String("gm_only".into()));
        let marker = event_from(
            &command_with_rules(&hidden, &[rule_ids::CONDITIONS]),
            "ConditionAdded",
            Some(json!({ "condition": sk_combat_base::legendary_actions::legendary_resistance_marker(decision.ordinal), "duration": "until-long-rest", "source_actor": id })),
            Some(&json!([id])),
        );
        let mut payload = Map::new();
        payload.insert("reason".into(), Value::String(decision.reason.into()));
        if let Some(condition) = decision.condition.as_ref().filter(|condition| !condition.is_empty()) {
            payload.insert("condition".into(), Value::String(condition.clone()));
        }
        let announced = event_from(&command_with_rules(&self.command, &[rule_ids::SAVING_THROW]), "LegendaryResistanceUsed", Some(Value::Object(payload)), Some(&json!([id])));
        Some(LegendaryResistance { events: vec![marker, announced], decision })
    }

    /// `resolveDamagePayload(sourceState, targetId, rawAmount, damageType,
    /// existingResistance = null, source = null)`: масло, защиты и 1к4
    /// заговора «Сопротивление» раз в ход.
    pub fn resolve_damage_payload(&mut self, source_state: &Value, target_id: &str, raw_amount: Value, damage_type: &Value, existing_resistance: Option<&Value>, source: Option<&Value>) -> Result<Value, Interrupt> {
        let mut raw_amount = raw_amount;
        if js::string(Some(damage_type)) == "fire" && !self.oiled_targets.contains(target_id) {
            let oiled = sk_core::game::conditions(source_state, target_id).iter().find(|candidate| js::safe_int(candidate.get("fire_damage_bonus"), 0) > 0).cloned();
            if let Some(oiled) = oiled {
                self.oiled_targets.insert(target_id.to_string());
                let source_command = command_with_rules(&self.command, &[rule_ids::CONDITIONS]);
                self.events.push(event_from(&source_command, "ConditionRemoved", Some(json!({ "condition": js::string(oiled.get("id")), "trigger": "fire-damage" })), Some(&json!([target_id]))));
                raw_amount = Value::from(js::safe_int(Some(&raw_amount), 0).max(0) + js::safe_int(oiled.get("fire_damage_bonus"), 0));
            }
        }
        if existing_resistance.is_some_and(|existing| js::number(existing.get("reduction")) > 0.0) {
            return Ok(crate::damage::damage_payload(source_state, target_id, Some(&raw_amount), Some(damage_type), existing_resistance, source)?);
        }
        let preliminary = crate::damage::damage_payload(source_state, target_id, Some(&raw_amount), Some(damage_type), None, source)?;
        if js::truthy(preliminary.get("immune")) || js::number(preliminary.get("applied_amount")) + js::number(preliminary.get("temporary_hp_absorbed")) <= 0.0 {
            return Ok(preliminary);
        }
        let turn_key = self.damage_turn_key(source_state);
        let wanted = format!("resistance-damage:{}", js::string(Some(damage_type)));
        let condition = sk_core::game::conditions(source_state, target_id).iter().find(|candidate| {
            let id = sk_core::game::condition_id(candidate);
            let key = format!("{target_id}:{id}:{turn_key}");
            id == wanted && js::s(candidate.get("last_used_turn")) != turn_key && !self.resistance_cantrip_uses.contains(&key)
        });
        let Some(condition) = condition else { return Ok(preliminary) };
        let condition_id = sk_core::game::condition_id(condition);
        let use_key = format!("{target_id}:{condition_id}:{turn_key}");
        let visibility = self.roll_visibility();
        let roll = self.roll_dice(Value::String("1d4".into()), &format!("spell:resistance:damage:{}", js::string(Some(damage_type))), Value::String(target_id.into()), visibility)?;
        self.resistance_cantrip_uses.insert(use_key);
        self.rolls.push(roll.clone());
        let mut payload = spread_value(Some(&roll));
        payload.insert("modifier_source".into(), Value::String("resistance".into()));
        payload.insert("damage_type".into(), damage_type.clone());
        self.events.push(event_from(&command_with_rules(&self.command, &[rule_ids::RESISTANCE]), "DieRolled", Some(Value::Object(payload)), Some(&json!([]))));
        let mut reduction = Map::new();
        reduction.insert("reduction".into(), roll.get("total").cloned().unwrap_or(Value::Null));
        reduction.insert("condition_id".into(), Value::String(condition_id));
        reduction.insert("turn_key".into(), Value::String(turn_key));
        if let Some(roll_id) = roll.get("roll_id") {
            reduction.insert("roll_id".into(), roll_id.clone());
        }
        Ok(crate::damage::damage_payload(source_state, target_id, Some(&raw_amount), Some(damage_type), Some(&Value::Object(reduction)), source)?)
    }

    /// `prepareElementalReactionDamage(sourceState, targetId, damagePayload,
    /// damageKey = null, reactionEvents = events)`: «Поглощение стихий» героя
    /// до урона области. `reaction_events: None` — события разбора.
    pub fn prepare_elemental_reaction_damage(&mut self, source_state: &Value, target_id: &str, payload: Value, damage_key: Option<&Value>, reaction_events: Option<&mut Vec<Value>>) -> Result<Value, Interrupt> {
        if sk_core::game::is_enemy_actor(source_state, target_id) {
            return Ok(payload);
        }
        let damage_type = payload.get("damage_type");
        let key = match damage_key.filter(|value| !value.is_null()) {
            Some(key) => js::string(Some(key)),
            None => {
                self.elemental_reaction_sequence += 1;
                format!("{}:elemental:{target_id}:{}:{}", js::string(self.command.get("command_id")), js::s(damage_type), self.elemental_reaction_sequence)
            }
        };
        let context_choice = self.context.get("elementalDamageChoice").cloned();
        let use_absorb;
        if let Some(choice) = self.elemental_reaction_choices.get(&key) {
            let choice_type = choice.get("damage_type");
            use_absorb = js::is_true(choice.get("use")) && (!js::truthy(choice_type) || js::string(choice_type) == js::string(damage_type));
        } else if context_choice.as_ref().and_then(|choice| choice.get("damage_key")).and_then(Value::as_str) == Some(key.as_str())
            && js::s(context_choice.as_ref().and_then(|choice| choice.get("target_id"))) == target_id
        {
            let choice = context_choice.unwrap_or(Value::Null);
            use_absorb = js::is_true(choice.get("use"));
            let mut record = Map::new();
            record.insert("damage_key".into(), Value::String(key.clone()));
            record.insert("target_id".into(), Value::String(target_id.into()));
            record.insert("use".into(), Value::Bool(use_absorb));
            if js::truthy(choice.get("resource")) {
                record.insert("resource".into(), choice["resource"].clone());
            }
            if js::present(choice.get("slot_level")) {
                record.insert("slot_level".into(), choice["slot_level"].clone());
            }
            if js::truthy(choice.get("damage_type")) || js::truthy(damage_type) {
                let kind = crate::core::coalesce(&[choice.get("damage_type")]).or(damage_type).cloned();
                if let Some(kind) = kind {
                    record.insert("damage_type".into(), kind);
                }
            }
            self.elemental_reaction_choices.insert(key.clone(), Value::Object(record));
        } else {
            let target = sk_core::game::find_actor(source_state, target_id);
            let options = if target.is_some() { crate::reactions::reaction_options_after_elemental_damage(source_state, target, Some(&payload)) } else { Vec::new() };
            let economy = sk_core::game::combat(source_state).get("action_economy").and_then(|all| all.get(target_id));
            if js::is_false(economy.and_then(|economy| economy.get("reaction"))) || options.is_empty() {
                return Ok(payload);
            }
            let (resistance, elemental, protective) = self.pause_choices();
            let target_value = Value::String(target_id.into());
            let key_value = Value::String(key);
            let options = Value::Array(options);
            let pause = Pause::elemental_damage_reaction(&ElementalDamageArgs {
                command: &self.command,
                target_id: &target_value,
                damage: Some(&payload),
                damage_key: &key_value,
                action_options: &options,
                dice_transcript: &self.dice.transcript,
                choices: Some(&elemental),
                resistance_choices: Some(&resistance),
                protective_choices: Some(&protective),
            });
            return Err(Interrupt::pause(pause));
        }
        if !use_absorb {
            return Ok(payload);
        }
        let slot_level = self.elemental_reaction_choices.get(&key).and_then(|choice| choice.get("slot_level")).cloned();
        let events = crate::reactions::absorb_elements_condition_events(&self.command, target_id, payload.get("damage_type"), slot_level.as_ref());
        match reaction_events {
            Some(sink) => sink.extend(events),
            None => self.events.extend(events),
        }
        Ok(crate::reactions::absorb_elements_damage_payload(&payload, source_state, target_id)?)
    }

    /// `resolveDamageWithReactions(sourceState, targetId, rawAmount, damageType,
    /// existingResistance = null, reactionEvents = events)`.
    pub fn resolve_damage_with_reactions(&mut self, source_state: &Value, target_id: &str, raw_amount: Value, damage_type: &Value, existing_resistance: Option<&Value>, reaction_events: Option<&mut Vec<Value>>) -> Result<Value, Interrupt> {
        let payload = self.resolve_damage_payload(source_state, target_id, raw_amount, damage_type, existing_resistance, None)?;
        self.prepare_elemental_reaction_damage(source_state, target_id, payload, None, reaction_events)
    }

    /// `appendMagicMissileResolution({ sourceCommand, spell, target, slotLevel,
    /// damageType, sourceItem })`: снаряды «Волшебной стрелы» с иммунитетом
    /// предмета и «Щитом» цели.
    pub fn append_magic_missile_resolution(&mut self, missile: MagicMissile<'_>) -> Result<(), Interrupt> {
        let MagicMissile { source_command, spell, target, slot_level, damage_type, source_item } = missile;
        let target_id = sk_core::game::actor_id(target);
        let level = crate::spells::slots::spell_level(spell);
        let resolved_slot = level.max(js::safe_int(slot_level, level));
        let projectiles = crate::spells::slots::spell_projectile_count(spell, Some(&Value::from(resolved_slot)));
        let protected_by_shield = condition_ids_for(&self.state, &target_id).contains("shielded");
        let spell_key = sk_core::text::lower(&js::string(spell.get("id")));
        let options = sk_items_life::item_lifecycle::MechanicEffectOptions { selected_item_id: None, selected_counts_as_equipped: false };
        let effects = sk_items_life::item_lifecycle::active_item_mechanic_effects(Some(target), &options).map_err(crate::damage::item_fault)?;
        let immunity_sources: Vec<Value> = effects
            .iter()
            .filter(|effect| effect.get("spell_immunities").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(spell_key.as_str()))))
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
        let expression = match spell.get("damage").filter(|value| js::truthy(Some(value))) {
            Some(damage) => js::string(Some(damage)),
            None => "1d4+1".into(),
        };
        let visibility = crate::core::coalesce(&[source_command.get("visibility")]).cloned().unwrap_or_else(|| Value::String("public".into()));
        let missile_roll = self.roll_dice(Value::String(expression), &format!("spell_damage:{}", js::string(spell.get("id"))), source_command.get("actor_id").cloned().unwrap_or(Value::Null), visibility)?;
        self.rolls.push(missile_roll.clone());
        let mut roll_payload = spread_value(Some(&missile_roll));
        roll_payload.insert("projectile_count".into(), js::num(projectiles));
        self.events.push(event_from(source_command, "DieRolled", Some(Value::Object(roll_payload)), Some(&json!([]))));
        let per_projectile = js::number(missile_roll.get("total"));
        let mut metadata = Map::new();
        if let Some(item) = source_item.filter(|item| js::truthy(Some(item))) {
            metadata.insert("source_type".into(), Value::String("magic-item".into()));
            if let Some(id) = item.get("id") {
                metadata.insert("source_item_id".into(), id.clone());
            }
            if let Some(name) = item.get("name") {
                metadata.insert("source_item_name".into(), name.clone());
            }
        }
        let targets = json!([target_id]);
        if !immunity_sources.is_empty() {
            let mut payload = Map::new();
            payload.insert("schema_version".into(), Value::from(MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION));
            if let Some(id) = spell.get("id") {
                payload.insert("spell_id".into(), id.clone());
            }
            payload.insert("damage_type".into(), damage_type.clone());
            payload.insert("projectile_count".into(), js::num(projectiles));
            payload.insert("damage_per_projectile".into(), missile_roll.get("total").cloned().unwrap_or(Value::Null));
            payload.insert("prevented_raw_amount".into(), js::num(per_projectile * projectiles));
            payload.insert("automatic_hit".into(), Value::Bool(true));
            payload.insert("item_immunity_sources".into(), Value::Array(immunity_sources));
            payload.extend(metadata);
            let mut event = event_from(&command_with_rules(source_command, &[rule_ids::RESISTANCE]), "SpellImmunityResolved", Some(Value::Object(payload)), Some(&targets));
            event["event_schema_version"] = Value::from(MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION);
            self.events.push(event);
            return Ok(());
        }
        let decision_key = format!("magic-missile:{}:{target_id}", js::string(source_command.get("command_id")));
        let state = self.state.clone();
        let shield_option = if !protected_by_shield && !sk_core::game::is_enemy_actor(&state, &target_id) { crate::reactions::shield_reaction_option(&state, Some(target)) } else { None };
        let mut shielded = protected_by_shield;
        let choice = self.protective_reaction_choices.get(&decision_key).cloned();
        if choice.as_ref().is_some_and(|choice| js::is_true(choice.get("use"))) {
            shielded = true;
            if !condition_ids_for(&state, &target_id).contains("shielded") {
                self.events.push(crate::reactions::shield_condition_event(source_command, &target_id));
            }
        } else if choice.is_none() {
            if let Some(option) = shield_option {
                let (resistance, elemental, protective) = self.pause_choices();
                let target_value = Value::String(target_id.clone());
                let options = Value::Array(vec![option]);
                let trigger = Value::String("magic-missile-shield-choice".into());
                let kind = Value::String("magic-missile".into());
                let key_value = Value::String(decision_key);
                let pause = Pause::protective_reaction(&ProtectiveReactionArgs {
                    command: source_command,
                    target_id: &target_value,
                    reactor_id: None,
                    source_actor_id: source_command.get("actor_id"),
                    trigger: &trigger,
                    kind: &kind,
                    decision_key: Some(&key_value),
                    action_options: &options,
                    trigger_roll: None,
                    damage: None,
                    dice_transcript: &self.dice.transcript,
                    choices: Some(&protective),
                    resistance_choices: Some(&resistance),
                    elemental_choices: Some(&elemental),
                });
                return Err(Interrupt::pause(pause));
            }
        }
        let missile_damage = js::num(per_projectile * projectiles);
        let mut payload = self.resolve_damage_payload(&state, &target_id, missile_damage, damage_type, None, None)?;
        if shielded {
            let mut map = spread_value(Some(&payload));
            map.insert("applied_amount".into(), Value::from(0));
            map.insert("temporary_hp_absorbed".into(), Value::from(0));
            map.insert("temporary_hp_after".into(), payload.get("temporary_hp_before").cloned().unwrap_or(Value::Null));
            map.insert("hp_after".into(), payload.get("hp_before").cloned().unwrap_or(Value::Null));
            payload = Value::Object(map);
        }
        let mut applied = spread_value(Some(&payload));
        applied.extend(metadata);
        if let Some(id) = spell.get("id") {
            applied.insert("spell_id".into(), id.clone());
        }
        applied.insert("projectile_count".into(), js::num(projectiles));
        applied.insert("damage_per_projectile".into(), missile_roll.get("total").cloned().unwrap_or(Value::Null));
        applied.insert("blocked_by_shield".into(), Value::Bool(shielded));
        applied.insert("automatic_hit".into(), Value::Bool(true));
        self.events.push(event_from(&command_with_rules(source_command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(applied)), Some(&targets)));
        if payload.get("hp_after").and_then(Value::as_f64) == Some(0.0) {
            self.events.push(event_from(&command_with_rules(source_command, &[rule_ids::ZERO_HP]), "HitPointsReducedToZero", Some(json!({ "condition": "unconscious" })), Some(&targets)));
        }
        Ok(())
    }

    /// `rollAmount(purpose, fallback = 0)`: `command.expression` броском или
    /// `command.amount`.
    pub fn roll_amount(&mut self, purpose: &str, fallback: f64) -> Result<i64, Interrupt> {
        if !js::truthy(self.command.get("expression")) {
            let raw = match self.command.get("amount").filter(|value| !value.is_null()) {
                Some(amount) => js::number(Some(amount)),
                None => fallback,
            };
            let value = if raw.is_nan() { 0.0 } else { raw };
            return Ok(value.floor().max(0.0) as i64);
        }
        let expression = self.command.get("expression").cloned().unwrap_or(Value::Null);
        let actor = self.command.get("actor_id").cloned().unwrap_or(Value::Null);
        let visibility = self.roll_visibility();
        let roll = self.roll_dice(expression, purpose, actor, visibility)?;
        self.rolls.push(roll.clone());
        self.events.push(event_from(&self.command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        Ok(js::safe_int(roll.get("total"), 0).max(0))
    }
}
