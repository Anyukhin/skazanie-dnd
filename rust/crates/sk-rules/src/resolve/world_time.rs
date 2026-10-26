//! Время мира в разборе команды: замыкания `appendTimeAdvance`,
//! `appendScenarioKnightPresence`, `appendWorldTimeConsequences`
//! (`rules-engine.mjs`, 13141–13335). Задача Р4б.
//!
//! В JS это замыкания `resolveCommandInternal` над `events`, `rolls`,
//! `diceService` и `projectEvents`; здесь — методы [`Resolve`]. Все
//! потребители минут считают от **дособытийного** состояния (`sourceState`),
//! как в JS: часы, рассвет предметов, обещания NPC, восстановление героев,
//! голод пленных, мир за кадром, почта, ночной гость сценария.

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::constants::PROTECTION_FROM_ENERGY_EXPIRY_POLICY;
use crate::core::{command_with, command_with_rules, event_from, npc_world_events_from};
use crate::dice_record::RulesDice;
use crate::normalize::summons::{expired_summons_between, summon_expiry_events};
use crate::pause::{Fault, Halt, Step};
use crate::world_clock::{duration_in_seconds, normalized_clock_seconds, world_time_seconds};

use super::Resolve;

/// `DND_2014_TIMED_BUFF_EXPIRY_POLICY` (`combat-spells.mjs`).
const DND_2014_TIMED_BUFF_EXPIRY_POLICY: &str = sk_combat_content::combat_spells::DND_2014_TIMED_BUFF_EXPIRY_POLICY;

/// Необязательные параметры `appendTimeAdvance`.
#[derive(Debug, Clone, Default)]
pub struct TimeAdvanceOptions {
    /// `sourceState` (по умолчанию — `projectEvents(events)`).
    pub source_state: Option<Value>,
    /// `elapsedSeconds` (по умолчанию — `durationInSeconds(amount, unit)`).
    pub elapsed_seconds: Option<f64>,
    /// `policyId`.
    pub policy_id: Option<String>,
}

/// Кости правил как `sk_dice::Dice` для модулей нижних волн: бросок идёт
/// через кости разбора (и попадает в стенограмму), остановка разбора
/// сохраняется и поднимается после вызова.
struct DiceBridge<'a> {
    inner: &'a mut dyn RulesDice,
    halt: Option<Halt>,
}

impl sk_dice::Dice for DiceBridge<'_> {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: sk_dice::Visibility) -> Result<sk_dice::Roll, sk_dice::DiceError> {
        let args = [
            Value::String(expression.into()),
            Value::String(purpose.into()),
            actor_id.map(|id| Value::String(id.into())).unwrap_or(Value::Null),
            serde_json::to_value(visibility).unwrap_or(Value::Null),
        ];
        match self.inner.roll(&args) {
            Ok(roll) => serde_json::from_value(roll).map_err(|error| sk_dice::DiceError::Transcript(error.to_string())),
            Err(halt) => {
                let message = halt.to_string();
                self.halt = Some(halt);
                Err(sk_dice::DiceError::Transcript(message))
            }
        }
    }

    fn roll_d20(&mut self, _request: &sk_dice::D20Request) -> Result<sk_dice::Roll, sk_dice::DiceError> {
        Err(sk_dice::DiceError::Transcript("rollD20 через мост костей не поддержан".into()))
    }

    fn roll_check(&mut self, _request: &sk_dice::D20Request, _difficulty: i64) -> Result<sk_dice::Roll, sk_dice::DiceError> {
        Err(sk_dice::DiceError::Transcript("rollCheck через мост костей не поддержан".into()))
    }
}

/// `{ ...command, visibility: draft.visibility }`.
fn with_visibility(command: &Value, draft: &Value) -> Value {
    command_with(command, "visibility", draft.get("visibility").cloned().unwrap_or(Value::Null))
}

/// `eventFrom({ ...command, visibility }, draft.event_type, draft.payload, draft.target_ids)`:
/// отсутствующие `payload` и `target_ids` берут значения по умолчанию JS.
fn draft_event(command: &Value, draft: &Value, targets_default_empty: bool) -> Value {
    let empty = Value::Array(Vec::new());
    let targets = match draft.get("target_ids") {
        None | Some(Value::Null) if targets_default_empty => Some(&empty),
        other => other,
    };
    event_from(&with_visibility(command, draft), &js::s(draft.get("event_type")), draft.get("payload").cloned(), targets)
}

impl Resolve<'_> {
    /// `appendTimeAdvance(sourceCommand, amount, unit, options)` (13141):
    /// `TimeAdvanced`, отпуск истёкших призывов, часы мира и рассвет
    /// предметов. Возвращает пересечённые минуты.
    pub fn append_time_advance(&mut self, source_command: &Value, amount: Option<&Value>, unit: Option<&Value>, options: TimeAdvanceOptions) -> Result<i64, Halt> {
        let source_state = match options.source_state {
            Some(state) => state,
            None => self.project_events()?,
        };
        let elapsed_seconds = options.elapsed_seconds.unwrap_or_else(|| duration_in_seconds(amount, unit));
        let before_seconds = world_time_seconds(&source_state);
        let elapsed_minutes = (normalized_clock_seconds(before_seconds + elapsed_seconds) / 60.0).floor() - (before_seconds / 60.0).floor();
        let mut payload = Map::new();
        if let Some(amount) = amount {
            payload.insert("amount".into(), amount.clone());
        }
        if let Some(unit) = unit {
            payload.insert("unit".into(), unit.clone());
        }
        payload.insert("elapsed_minutes".into(), js::num(elapsed_minutes));
        payload.insert("clock_version".into(), Value::from(2));
        payload.insert("elapsed_seconds".into(), js::num(elapsed_seconds));
        if let Some(policy) = options.policy_id.filter(|policy| !policy.is_empty()) {
            payload.insert("policy_id".into(), Value::String(policy));
        }
        let mut event = event_from(source_command, "TimeAdvanced", Some(Value::Object(payload)), Some(&json!([])));
        event["event_schema_version"] = Value::from(2);
        self.events.push(event);
        let expired = expired_summons_between(&source_state, before_seconds, before_seconds + elapsed_seconds);
        self.events.extend(summon_expiry_events(source_command, &source_state, &expired, true));
        if elapsed_minutes <= 0.0 {
            return Ok(elapsed_minutes as i64);
        }
        for draft in sk_world_time::weather::world_clock_event_drafts(&source_state, elapsed_minutes) {
            self.events.push(event_from(&with_visibility(source_command, &draft), &js::s(draft.get("event_type")), draft.get("payload").cloned(), Some(&json!([]))));
        }
        let mut bridge = DiceBridge { inner: &mut self.dice, halt: None };
        let recharge = sk_items::item_dawn_recharge::resolve_item_dawn_recharge(&source_state, Some(&js::num(elapsed_minutes)), &mut bridge);
        if let Some(halt) = bridge.halt.take() {
            return Err(halt);
        }
        let recharge = recharge.map_err(|error| Halt::Fault(Fault::new("Error", error.message.clone()).with_code(error.code.clone())))?;
        self.rolls.extend(recharge.rolls.iter().cloned());
        if let Some(payload) = recharge.payload {
            let owners: Vec<Value> = payload.get("items").and_then(Value::as_array).map(|items| items.iter().map(|item| item.get("owner_id").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
            let command = command_with(source_command, "visibility", Value::String("gm_only".into()));
            let mut event = event_from(&command, "ItemDawnRechargeResolved", Some(payload), Some(&Value::Array(owners)));
            event["event_schema_version"] = Value::from(sk_items::item_dawn_recharge::ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION);
            self.events.push(event);
        }
        Ok(elapsed_minutes as i64)
    }

    /// `appendScenarioKnightPresence(sourceCommand)` (13177): ночной гость
    /// сценария приходит и уходит с часами мира и с приходом отряда.
    pub fn append_scenario_knight_presence(&mut self, source_command: &Value) -> Step {
        let projected = self.project_events()?;
        let Some(plan) = sk_world_story::scenario_knight::scenario_knight_presence_plan(&projected) else { return Ok(()) };
        let system = command_with(source_command, "actor_id", Value::Null);
        let mut request = command_with(&system, "command_type", Value::String("UpsertNpcSocialProfile".into()));
        request["npc"] = plan.get("profile").cloned().unwrap_or(Value::Null);
        let profile_command = sk_social::npc_social::validate_npc_social_command(&request, &projected, &json!({ "isDirector": true })).map_err(|error| crate::pause::rule(error.message.clone(), &error.code))?;
        for social in sk_social::npc_social::npc_social_events(&profile_command, &projected) {
            let command = with_visibility(&system, &social);
            self.events.push(event_from(&command, &js::s(social.get("event_type")), social.get("payload").cloned(), social.get("target_ids")));
        }
        if js::truthy(plan.get("present")) {
            let placement = Value::Array(sk_npc_world::npc_positioning::plan_scene_npc_placement_events(&self.project_events()?));
            self.events.extend(npc_world_events_from(&system, &placement));
        }
        if js::truthy(plan.get("text")) {
            let command = command_with(&system, "visibility", Value::String("public".into()));
            let payload = json!({
                "schema_version": sk_world_story::scenario_knight::SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION,
                "npc_id": plan.get("npc_id").cloned().unwrap_or(Value::Null),
                "location_id": plan.get("location_id").cloned().unwrap_or(Value::Null),
                "present": plan.get("present").cloned().unwrap_or(Value::Null),
                "text": plan.get("text").cloned().unwrap_or(Value::Null),
            });
            let targets = Value::Array(vec![plan.get("npc_id").cloned().unwrap_or(Value::Null)]);
            self.events.push(event_from(&command, sk_world_story::scenario_knight::SCENARIO_KNIGHT_PRESENCE_EVENT, Some(payload), Some(&targets)));
        }
        Ok(())
    }

    /// `appendWorldTimeConsequences(sourceCommand, amount, unit, options)`
    /// (13179): ход времени и всё, что от него зависит.
    pub fn append_world_time_consequences(&mut self, source_command: &Value, amount: Option<&Value>, unit: Option<&Value>, options: TimeAdvanceOptions) -> Step {
        let source_state = self.project_events()?;
        let elapsed_minutes = self.append_time_advance(source_command, amount, unit, TimeAdvanceOptions { source_state: Some(source_state.clone()), ..options })?;
        let after_time = self.project_events()?;
        let mechanics = source_state.get("mechanics");
        let concentration = mechanics.and_then(|mechanics| mechanics.get("concentration"));
        let caster_ids: Vec<String> = match concentration {
            Some(Value::Object(map)) => js::keys(map).into_iter().cloned().collect(),
            _ => Vec::new(),
        };
        let after_seconds = world_time_seconds(&after_time);
        for caster_id in caster_ids {
            let Some(link) = crate::enervation_link::enervation_link_for(&source_state, Some(&Value::String(caster_id.clone()))) else { continue };
            let expires_at = js::number(link.condition.get("expires_at_seconds"));
            if !expires_at.is_finite() || after_seconds < expires_at {
                continue;
            }
            let current = after_time.get("mechanics").and_then(|mechanics| mechanics.get("concentration")).and_then(|all| all.get(&caster_id));
            if !js::truthy(current) || js::s(current.and_then(|current| current.get("effect_id"))) != link.effect_id {
                continue;
            }
            let acting = command_with(source_command, "actor_id", Value::String(caster_id.clone()));
            self.events.push(event_from(
                &command_with_rules(&acting, &[rule_ids::CONCENTRATION]),
                "ConcentrationEnded",
                Some(json!({ "reason": "duration-expired", "effect_id": link.effect_id, "spell_id": "enervation" })),
                Some(&json!([caster_id])),
            ));
        }
        let mut ended: sk_core::indexmap::IndexSet<String> = self
            .events
            .iter()
            .filter(|event| event.get("event_type").and_then(Value::as_str) == Some("ConcentrationEnded"))
            .map(|event| format!("{}:{}", js::s(event.get("actor_id")), js::s(event.get("payload").and_then(|payload| payload.get("effect_id")))))
            .collect();
        let condition_lists: Vec<Value> = match mechanics.and_then(|mechanics| mechanics.get("conditions")) {
            Some(Value::Object(map)) => js::entries(map).into_iter().map(|(_, value)| value.clone()).collect(),
            _ => Vec::new(),
        };
        for conditions in condition_lists {
            let list = match conditions {
                Value::Null => Vec::new(),
                Value::Array(items) => items,
                _ => return Err(Halt::Fault(Fault::type_error("conditions is not iterable"))),
            };
            for condition in list {
                let policy = condition.get("expiry_policy").and_then(Value::as_str);
                let pfe = policy == Some(PROTECTION_FROM_ENERGY_EXPIRY_POLICY);
                let skill = condition.get("skill_buff_version").and_then(Value::as_f64) == Some(1.0) && condition.get("spell_id").and_then(Value::as_str) == Some("skill-empowerment");
                let buff = policy == Some(DND_2014_TIMED_BUFF_EXPIRY_POLICY);
                if !pfe && !skill && !buff {
                    continue;
                }
                let expires_at = js::number(condition.get("expires_at_seconds"));
                if !expires_at.is_finite() || after_seconds < expires_at {
                    continue;
                }
                let owner = js::s(condition.get("source_actor"));
                let effect = js::s(condition.get("effect_id"));
                let concentrating = js::s(concentration.and_then(|all| all.get(&owner)).and_then(|entry| entry.get("effect_id")));
                if owner.is_empty() || effect.is_empty() || concentrating != effect {
                    continue;
                }
                let key = format!("{owner}:{effect}");
                if ended.contains(&key) {
                    continue;
                }
                let mut payload = Map::new();
                payload.insert("reason".into(), Value::String("duration-expired".into()));
                payload.insert("effect_id".into(), Value::String(effect.clone()));
                payload.insert("spell_id".into(), Value::String(js::s(condition.get("spell_id"))));
                if pfe {
                    payload.insert("expiry_policy".into(), Value::String(PROTECTION_FROM_ENERGY_EXPIRY_POLICY.into()));
                }
                if skill {
                    payload.insert("skill_buff_version".into(), Value::from(1));
                }
                if buff {
                    payload.insert("expiry_policy".into(), Value::String(DND_2014_TIMED_BUFF_EXPIRY_POLICY.into()));
                }
                let acting = command_with(source_command, "actor_id", Value::String(owner.clone()));
                self.events.push(event_from(&command_with_rules(&acting, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(Value::Object(payload)), Some(&json!([owner]))));
                ended.insert(key);
            }
        }
        if elapsed_minutes <= 0 {
            return Ok(());
        }
        let elapsed = Value::from(elapsed_minutes);
        for social in sk_social::npc_social::npc_promise_deadline_events(&source_state, &elapsed) {
            let command = with_visibility(source_command, &social);
            self.events.push(event_from(&command, &js::s(social.get("event_type")), social.get("payload").cloned(), social.get("target_ids")));
        }
        self.append_stable_recovery(source_command, &source_state, elapsed_minutes)?;
        self.append_knockout_recovery(source_command, &source_state, elapsed_minutes);
        let world_minute = js::num(sk_social::npc_social::campaign_elapsed_minutes(&after_time));
        let unattributed = command_with(source_command, "actor_id", Value::Null);
        for draft in sk_world_life::captives::plan_captive_neglect_drafts(&source_state, Some(&world_minute)) {
            self.events.push(draft_event(&unattributed, &draft, false));
        }
        if let Some(offscreen) = sk_world_story::offscreen_world::plan_offscreen_world_step(&source_state, Some(&elapsed)) {
            for draft in offscreen.get("drafts").and_then(Value::as_array).cloned().unwrap_or_default() {
                self.events.push(draft_event(source_command, &draft, true));
            }
        }
        for draft in sk_world_life::courier_letters::plan_courier_letter_ticks(&source_state, Some(&elapsed)) {
            self.events.push(draft_event(source_command, &draft, true));
        }
        self.append_scenario_knight_presence(source_command)
    }

    /// Стабилизированные герои с 0 хитов: 1к4 часов до 1 хита (13246–13279).
    fn append_stable_recovery(&mut self, source_command: &Value, source_state: &Value, elapsed_minutes: i64) -> Step {
        let trackers: Vec<(String, Value)> = match source_state.get("mechanics").and_then(|mechanics| mechanics.get("death")).and_then(|death| death.get("saving_throws")) {
            Some(Value::Object(map)) => js::entries(map).into_iter().map(|(id, tracker)| (id.clone(), tracker.clone())).collect(),
            _ => Vec::new(),
        };
        for (hero_id, raw_tracker) in trackers {
            let tracker = crate::targets::death_save_tracker(source_state, &hero_id);
            let hero = crate::core::player_actor(source_state, Some(&Value::String(hero_id.clone())));
            let Some(hero) = hero else { continue };
            if !tracker.stable || sk_core::game::actor_hp(hero) != 0 || crate::targets::is_dead_hero(source_state, &hero_id) {
                continue;
            }
            let max_hp = crate::core::actor_max_hp(Some(hero));
            let mut remaining = js::safe_int(raw_tracker.get("recovery_minutes_remaining"), 0).max(0);
            if remaining <= 0 {
                let visibility = source_command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String("public".into()));
                let roll = self.dice.roll(&[Value::String("1d4".into()), Value::String("stable-recovery-hours".into()), Value::String(hero_id.clone()), visibility])?;
                self.rolls.push(roll.clone());
                let total = js::number(roll.get("total"));
                remaining = (total * 60.0) as i64;
                let mut payload = crate::core::spread_value(Some(&roll));
                payload.insert("recovery_hours".into(), roll.get("total").cloned().unwrap_or(Value::Null));
                payload.insert("recovery_minutes".into(), js::num(total * 60.0));
                self.events.push(event_from(&command_with_rules(source_command, &[rule_ids::ZERO_HP]), "StableRecoveryScheduled", Some(Value::Object(payload)), Some(&json!([hero_id]))));
            }
            if elapsed_minutes >= remaining {
                let restored = max_hp.min(1);
                self.events.push(event_from(
                    &command_with_rules(source_command, &[rule_ids::HEALING, rule_ids::ZERO_HP]),
                    "HealingApplied",
                    Some(json!({ "requested_amount": 1, "applied_amount": restored, "hp_before": 0, "hp_after": restored, "reason": "stable-recovery-after-1d4-hours" })),
                    Some(&json!([hero_id])),
                ));
            } else {
                self.events.push(event_from(
                    &command_with_rules(source_command, &[rule_ids::ZERO_HP]),
                    "StableRecoveryProgressed",
                    Some(json!({ "elapsed_minutes": elapsed_minutes, "recovery_minutes_before": remaining, "recovery_minutes_remaining": remaining - elapsed_minutes })),
                    Some(&json!([hero_id])),
                ));
            }
        }
        Ok(())
    }

    /// Нокаут без сознания: короткий отдых по истечении часа (13280–13296).
    fn append_knockout_recovery(&mut self, source_command: &Value, source_state: &Value, elapsed_minutes: i64) {
        let rests: Vec<(String, Value)> = match source_state.get("mechanics").and_then(|mechanics| mechanics.get("resting")) {
            Some(Value::Object(map)) => js::entries(map).into_iter().map(|(id, rest)| (id.clone(), rest.clone())).collect(),
            _ => Vec::new(),
        };
        for (target, rest) in rests {
            if rest.get("reason").and_then(Value::as_str) != Some("knockout") {
                continue;
            }
            let remaining = js::safe_int(rest.get("recovery_minutes_remaining"), 60).max(1);
            if elapsed_minutes >= remaining {
                self.events.push(event_from(
                    &command_with_rules(source_command, &[rule_ids::RESOURCE, rule_ids::CONDITIONS]),
                    "RestCompleted",
                    Some(json!({ "kind": "short", "reason": "knockout", "automatic": true })),
                    Some(&json!([target])),
                ));
            } else {
                self.events.push(event_from(
                    &command_with_rules(source_command, &[rule_ids::RESOURCE]),
                    "KnockoutRecoveryProgressed",
                    Some(json!({ "elapsed_minutes": elapsed_minutes, "recovery_minutes_before": remaining, "recovery_minutes_remaining": remaining - elapsed_minutes })),
                    Some(&json!([target])),
                ));
            }
        }
    }
}

/// `appendWorldTimeConsequences` вне команды — для сверки с JS: состояние
/// нормализуется, проектор команды строится от него, события и броски
/// возвращаются как `{ events, rolls }` замыкания.
pub fn world_time_consequences(state: &Value, source_command: &Value, amount: Option<&Value>, unit: Option<&Value>, options: TimeAdvanceOptions, dice: &mut dyn RulesDice) -> Result<(Vec<Value>, Vec<Value>), Halt> {
    let state = crate::normalize::normalize_campaign_state(state)?;
    let mut uuid = crate::context::sequence_uuids("world-time");
    let projector = crate::replay::CommandProjector::new(&state);
    let truce_before_command = sk_society::parley::truce_for(&state);
    let mut r = Resolve {
        state,
        command: source_command.clone(),
        context: crate::context::Context::default(),
        depth: 0,
        dice: crate::dice_record::Recording::new(dice),
        uuid: &mut uuid,
        events: Vec::new(),
        rolls: Vec::new(),
        target_id: crate::core::target_for(source_command),
        inspiration_spent: Default::default(),
        resistance_cantrip_uses: Default::default(),
        resistance_choices: Default::default(),
        resistance_used_targets: Default::default(),
        resistance_save_sequence: 0,
        elemental_reaction_choices: Default::default(),
        elemental_reaction_sequence: 0,
        protective_reaction_choices: Default::default(),
        nested_consequences_resolved: false,
        truce_before_command,
        legendary_spends_in_command: Default::default(),
        oiled_targets: Default::default(),
        projector,
    };
    r.append_world_time_consequences(source_command, amount, unit, options)?;
    Ok((r.events, r.rolls))
}
