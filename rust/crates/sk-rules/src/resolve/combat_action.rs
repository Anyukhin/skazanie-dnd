//! Ветки `resolveCommandInternal`: Боевые приёмы `UseCombatAction`:
//! возобновление пауз (15377–15717, помощники — `resolve/resume.rs`) и 45
//! приёмов. Задача Р10.
//!
//! JS: `server/rules-engine.mjs`, 15344–16662. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Приёмы — цепочка `else if` в порядке JS: первая подходящая ветка
//! исполняется, остальные не проверяются. Опции бросков, где JS кладёт поле
//! со значением `undefined` (`visibility: command.visibility`), помечены
//! [`undef`], чтобы порядок ключей стенограммы совпал с JS.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::kernel::undef;
use super::resume::{self, at, reduce_events, resolve_pending, ruleset_options, PendingDice, Resume};
use super::{api, Resolve};
use crate::checks::saves::{grapple_contest, roll_ability_check_with_conditions, saved_damage_amount, saving_throw_succeeded, D20Method};
use crate::checks::skills::{challenge_rating_value, skill_proficiency_bonus};
use crate::command::rules::{rule_ids, OBJECT_PROTOTYPE_KEYS};
use crate::constants::{ACTION_ECONOMY_EVENT_VERSION, EXTINGUISHABLE_FLAME_CONDITIONS, MONK_BONUS_UNARMED_ACTION_IDS, READIED_TRIGGERS};
use crate::context::Context;
use crate::core::{ability_modifier, armor_stealth_disadvantage, assert_mechanics_supported, coalesce, command_with, command_with_rules, condition_ids_for, dice_expression, event_from, player_actor, resource_pool, spread_value};
use crate::damage::{damage_payload, resolved_healing_roll};
use crate::death::zero_hit_point_damage_consequences;
use crate::pause::{rule, Fault, Halt, Step};
use crate::spells::components::{assert_spell_components_allowed, spell_component_cost_events};
use crate::tactical_geometry::{actor_point, point_json, points_json};

/// `actorHp(actor)`.
fn hp(actor: Option<&Value>) -> i64 {
    actor.map(sk_core::game::actor_hp).unwrap_or(0)
}

/// `actorMaxHp(actor)`.
fn max_hp(actor: Option<&Value>) -> i64 {
    crate::core::actor_max_hp(actor)
}

fn living(actor: Option<&Value>) -> bool {
    actor.is_some_and(sk_core::game::is_living_actor)
}

/// `abilityModifier(actor?.abilities?.[ability])`.
fn ability_of(actor: Option<&Value>, ability: &str) -> i64 {
    ability_modifier(at(at(actor, "abilities"), ability))
}

/// `payload.hp_after === 0`.
fn hp_after_zero(payload: &Value) -> bool {
    payload.get("hp_after").and_then(Value::as_f64) == Some(0.0)
}

/// `{ ...base, ...fields }`.
fn spread_with(base: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut map = spread_value(Some(base));
    for (key, value) in fields {
        map.insert(key.into(), value);
    }
    Value::Object(map)
}

/// `{ key: value, … }` без полей `undefined` (`None`).
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            map.insert(key.into(), value);
        }
    }
    Value::Object(map)
}

/// Опции броска; `undefined` — маркер [`undef`].
fn options(fields: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        map.insert(key.into(), value);
    }
    Value::Object(map)
}

/// `Math.max(a, b)` для чисел JS.
fn max_f(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

/// `safeInteger(value, fallback)` с произвольным запасным значением.
fn safe_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if crate::core::is_safe_integer_f64(number) {
        number
    } else {
        fallback
    }
}

/// Состояния участника (`state.mechanics.conditions[id] ?? []`).
fn conditions_of<'a>(state: &'a Value, id: &str) -> &'a [Value] {
    sk_core::game::conditions(state, id)
}

/// `String(condition?.id ?? condition)`.
fn condition_name(condition: &Value) -> String {
    match condition.get("id").filter(|value| !value.is_null()) {
        Some(id) => js::string(Some(id)),
        None => js::string(Some(condition)),
    }
}

/// `{ ...(condition.effect_id ? { effect_id } : {}) }`.
fn effect_id_fields(condition: &Value) -> Vec<(&'static str, Option<Value>)> {
    vec![("effect_id", condition.get("effect_id").filter(|value| js::truthy(Some(value))).cloned())]
}

/// Разбор одного приёма.
struct Act {
    state: Value,
    command: Value,
    actor_id: String,
    action: Value,
    /// `actionTargetId`.
    target: Value,
    /// `String(actionTargetId)` для поиска.
    target_key: String,
    resume: Resume,
}

impl Act {
    /// `actor = findActor(state, command.actor_id)` — та же ссылка, что в
    /// состоянии: стат-блок 2014 узнаётся по тождеству (`candidate === actor`).
    fn actor(&self) -> Option<&Value> {
        sk_core::game::find_actor(&self.state, &self.actor_id)
    }

    fn id(&self) -> &str {
        self.action.get("id").and_then(Value::as_str).unwrap_or("")
    }

    fn effect(&self) -> Option<&Value> {
        self.action.get("effect")
    }

    fn effect_field(&self, key: &str) -> Option<&Value> {
        at(self.effect(), key)
    }

    fn effect_kind(&self) -> Option<&str> {
        self.effect_field("kind").and_then(Value::as_str)
    }

    fn window(&self) -> Option<&Value> {
        self.resume.window.as_ref()
    }

    /// `reactionWindow` истинно.
    fn has_window(&self) -> bool {
        js::truthy(self.window())
    }

    fn window_field(&self, key: &str) -> Option<&Value> {
        at(self.window(), key)
    }

    fn rules(&self, rules: &[&str]) -> Value {
        command_with_rules(&self.command, rules)
    }

    fn as_actor(&self, actor_id: &str) -> Value {
        command_with(&self.command, "actor_id", Value::String(actor_id.into()))
    }

    fn actor_targets(&self) -> Value {
        json!([self.command.get("actor_id").cloned().unwrap_or(Value::Null)])
    }

    fn target_targets(&self) -> Value {
        json!([self.target])
    }

    fn visibility(&self) -> Value {
        coalesce(&[self.command.get("visibility")]).cloned().unwrap_or_else(|| Value::String("public".into()))
    }

    /// `command.visibility` с маркером `undefined`.
    fn raw_visibility(&self) -> Value {
        undef(self.command.get("visibility"))
    }

    fn actor_value(&self) -> Value {
        self.command.get("actor_id").cloned().unwrap_or(Value::Null)
    }

    fn uses_2014(&self) -> bool {
        sk_core::game::uses_2014(&self.state)
    }

    fn concentration(&self, id: &str) -> Option<&Value> {
        sk_core::game::mechanics(&self.state).get("concentration").and_then(|all| all.get(id)).filter(|value| js::truthy(Some(value)))
    }

    /// `actionEvent(extra)`.
    fn action_event(&self, extra: Vec<(&str, Value)>) -> Value {
        let mut payload = Map::new();
        for key in [("action_id", "id"), ("name", "name"), ("category", "category"), ("action_type", "actionType")] {
            if let Some(value) = self.action.get(key.1) {
                payload.insert(key.0.into(), value.clone());
            }
        }
        payload.insert("action_economy_version".into(), Value::from(ACTION_ECONOMY_EVENT_VERSION));
        if extra.iter().any(|(key, value)| *key == "restore_action" && js::truthy(Some(value))) {
            payload.insert("action_boundary_id".into(), Value::String(format!("attack-action:{}", js::s(self.command.get("command_id")))));
            payload.insert("action_boundary_kind".into(), Value::String(if self.id() == "action-surge" { "surge" } else { "extra" }.into()));
            let per_action = sk_combat_content::combat_actions::weapon_attacks_per_action_for(self.actor());
            payload.insert("action_boundary_limit".into(), js::num(max_f(1.0, per_action)));
            let economy = sk_core::game::combat(&self.state).get("action_economy").and_then(|all| all.get(&self.actor_id));
            payload.insert("action_boundary_queued".into(), Value::Bool(at(economy, "action") != Some(&Value::Bool(false))));
        }
        for (key, value) in extra {
            payload.insert(key.into(), value);
        }
        event_from(&self.command, "CombatActionUsed", Some(Value::Object(payload)), Some(&self.target_targets()))
    }

    /// `spendActionResource()`.
    fn spend(&self, r: &mut Resolve<'_>) -> Step {
        if let Some(spell) = self.action.get("spell").filter(|spell| js::truthy(Some(spell))) {
            let events = spell_component_cost_events(&self.state, &self.command, Some(spell), &Context::default())?;
            r.events.extend(events);
        }
        let Some(resource) = self.action.get("resource").filter(|value| js::truthy(Some(value))) else { return Ok(()) };
        let pool = resource_pool(&self.state, &self.actor_id, &js::string(Some(resource)), 0);
        let amount = js::safe_int(self.action.get("cost"), 1).max(1);
        let payload = json!({ "resource": resource, "amount": amount, "before": pool.current, "after": pool.current - amount, "max": pool.max });
        r.events.push(event_from(&self.rules(&[rule_ids::RESOURCE]), "ResourceSpent", Some(payload), Some(&self.actor_targets())));
        Ok(())
    }

    /// `ReactionWindowClosed` принятой реакции.
    fn accepted_close(&self, extra: Vec<(&str, Value)>) -> Value {
        let mut payload = Map::new();
        if let Some(id) = self.window_field("id") {
            payload.insert("id".into(), id.clone());
        }
        payload.insert("accepted".into(), Value::Bool(true));
        if let Some(id) = self.action.get("id") {
            payload.insert("action_id".into(), id.clone());
        }
        for (key, value) in extra {
            payload.insert(key.into(), value);
        }
        event_from(&self.rules(&[rule_ids::REACTION]), "ReactionWindowClosed", Some(Value::Object(payload)), Some(&self.actor_targets()))
    }

    /// `reaction_window_id: reactionWindow.id` (поле `undefined` опускается).
    fn window_id_field(&self) -> Vec<(&'static str, Value)> {
        self.window_field("id").map(|id| vec![("reaction_window_id", id.clone())]).unwrap_or_default()
    }

    /// `ReactionDamageReduced` с `reducedReactionDamage(reactionWindow.damage, restored)`.
    fn damage_reduced(&self, restored: f64, target: Value) -> Value {
        let mut payload = Map::new();
        if let Some(id) = self.action.get("id") {
            payload.insert("action_id".into(), id.clone());
        }
        if let Some(name) = self.action.get("name") {
            payload.insert("name".into(), name.clone());
        }
        let reduced = crate::reactions::reduced_reaction_damage(self.window_field("damage"), Some(&js::num(restored)));
        for (key, value) in spread_value(Some(&reduced)) {
            payload.insert(key, value);
        }
        event_from(&self.rules(&[rule_ids::REACTION, rule_ids::DAMAGE]), "ReactionDamageReduced", Some(Value::Object(payload)), Some(&json!([target])))
    }

    /// `Math.max(0, applied_amount + temporary_hp_absorbed)` урона окна.
    fn window_damage(&self) -> i64 {
        let damage = self.window_field("damage");
        (js::safe_int(at(damage, "applied_amount"), 0) + js::safe_int(at(damage, "temporary_hp_absorbed"), 0)).max(0)
    }

    fn source_actor_id(&self) -> String {
        js::string(self.window_field("source_actor_id"))
    }

    /// `rollAbilityCheckWithConditions(state, diceService, actorId, ability, options)`.
    fn check(&self, r: &mut Resolve<'_>, ability: &str, options: Value, method: D20Method) -> Result<Value, Halt> {
        roll_ability_check_with_conditions(&self.state, &mut r.dice, &self.actor_id, Some(&Value::String(ability.into())), &options, method)
    }

    /// `diceService.roll(expression, purpose, actorId, visibility ?? 'public')`.
    fn roll(&self, r: &mut Resolve<'_>, expression: Value, purpose: &str) -> Result<Value, Halt> {
        let visibility = self.visibility();
        r.roll_dice(expression, purpose, self.actor_value(), visibility)
    }

    fn die_rolled(&self, roll: &Value, extra: Vec<(&str, Value)>) -> Value {
        event_from(&self.command, "DieRolled", Some(spread_with(roll, extra)), Some(&json!([])))
    }

    /// `ConcentrationEnded` от имени источника или `ConditionRemoved` у цели:
    /// эффект, который держит концентрация, снимается вместе с ней.
    fn end_source_effect(&self, condition: &Value, reason: &str, removed: Vec<Value>) -> Vec<Value> {
        let source = js::s(condition.get("source_actor"));
        let effect = condition.get("effect_id").filter(|value| js::truthy(Some(value)));
        let concentrated = effect.is_some_and(|effect| js::s(self.concentration_raw(&source).and_then(|entry| entry.get("effect_id"))) == js::string(Some(effect)));
        if concentrated {
            let payload = json!({ "reason": reason, "effect_id": effect.cloned().unwrap_or(Value::Null) });
            return vec![event_from(&command_with_rules(&self.as_actor(&source), &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&json!([source])))];
        }
        removed
    }

    fn concentration_raw(&self, id: &str) -> Option<&Value> {
        sk_core::game::mechanics(&self.state).get("concentration").and_then(|all| all.get(id))
    }
}

/// `UseCombatAction` (15344–16662).
pub fn use_combat_action(r: &mut Resolve<'_>) -> Step {
    let resume = Resume::new(r);
    if r.command.get("action_id").and_then(Value::as_str) == Some("decline-reaction") {
        return decline(r, &resume);
    }
    let state = r.state.clone();
    let command = r.command.clone();
    let actor_id = js::s(command.get("actor_id"));
    let action = match coalesce(&[command.get("combat_action")]) {
        Some(action) => Some(action.clone()),
        None => sk_combat_content::combat_actions::combat_action_for(sk_core::game::find_actor(&state, &actor_id), command.get("action_id")),
    };
    assert_mechanics_supported(action.as_ref(), "действия")?;
    let action = action.unwrap_or(Value::Null);
    let target = if action.get("target").and_then(Value::as_str) == Some("self") { command.get("actor_id").cloned().unwrap_or(Value::Null) } else { r.target_id.clone() };
    let target_key = js::s(Some(&target));
    let act = Act { state, command, actor_id, action, target, target_key, resume };
    run(r, &act)
}

/// Отказ от реакции (15697–15716).
fn decline(r: &mut Resolve<'_>, resume: &Resume) -> Step {
    let window = match resume.window.as_ref() {
        None => return Err(Fault::type_error("Cannot read properties of undefined (reading 'trigger')").into()),
        Some(Value::Null) => return Err(Fault::type_error("Cannot read properties of null (reading 'trigger')").into()),
        Some(window) => window.clone(),
    };
    let trigger = window.get("trigger").and_then(Value::as_str);
    if trigger == Some("failed-saving-throw") {
        resume::resolve_indomitable_choice(r, resume, false)?;
    } else if trigger == Some("saving-throw-bonus-choice") {
        // Автопропуск окна по тайм-ауту означает «без бонуса», но отложенный
        // спасбросок продолжается.
        let after_roll = at(window.get("pending_resistance_choice"), "phase").and_then(Value::as_str) == Some("after-roll");
        resume::resume_resistance_choice(r, resume, if after_roll { "after-skip" } else { "decline" })?;
    } else if trigger == Some("spell-area-damage") && js::truthy(window.get("pending_elemental_damage")) {
        resume::resume_pending_elemental_damage(r, resume, false, None)?;
    } else if js::truthy(window.get("pending_protective_reaction")) {
        resume::resume_pending_protective_reaction(r, resume, false, None)?;
    } else {
        let mut payload = Map::new();
        if let Some(id) = window.get("id") {
            payload.insert("id".into(), id.clone());
        }
        payload.insert("accepted".into(), Value::Bool(false));
        for (key, value) in &resume.automatic_decline {
            payload.insert(key.clone(), value.clone());
        }
        let actor = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
        let event = event_from(&r.command_with_rules(&[rule_ids::REACTION]), "ReactionWindowClosed", Some(Value::Object(payload)), Some(&json!([actor])));
        r.events.push(event);
        resume::resume_pending_spell(r, resume)?;
    }
    Ok(())
}

/// Цепочка приёмов (15745–16660).
fn run(r: &mut Resolve<'_>, a: &Act) -> Step {
    let id = a.id().to_string();
    let kind = a.effect_kind().map(str::to_string);
    let kind = kind.as_deref();
    let has_window = a.has_window();
    let conditions = condition_ids_for(&a.state, &a.actor_id);
    if kind == Some("enervation-continuation") {
        return enervation_continuation(r, a);
    }
    if js::truthy(a.window_field("pending_protective_reaction")) && (matches!(id.as_str(), "cast:shield" | "uncanny-dodge" | "cast:absorb-elements") || kind == Some("ally_attack_reaction")) {
        a.spend(r)?;
        let mut extra = a.window_id_field();
        if let Some(id) = a.action.get("id") {
            extra.push(("protective_reaction", id.clone()));
        }
        r.events.push(a.action_event(extra));
        return resume::resume_pending_protective_reaction(r, &a.resume, true, Some(&a.action));
    }
    if matches!(id.as_str(), "use-resistance" | "roll-first-resistance" | "skip-resistance") && has_window {
        let after_roll = at(a.window_field("pending_resistance_choice"), "phase").and_then(Value::as_str) == Some("after-roll");
        let mode = match id.as_str() {
            "roll-first-resistance" => "after",
            "use-resistance" => {
                if after_roll {
                    "after-use"
                } else {
                    "before-roll"
                }
            }
            _ => {
                if after_roll {
                    "after-skip"
                } else {
                    "decline"
                }
            }
        };
        return resume::resume_resistance_choice(r, &a.resume, mode);
    }
    if id == "indomitable" && has_window {
        return resume::resolve_indomitable_choice(r, &a.resume, true);
    }
    if js::truthy(a.action.get("spell")) && has_window {
        return reaction_spell(r, a);
    }
    match id.as_str() {
        "uncanny-dodge" if has_window => {
            r.events.push(a.damage_reduced((a.window_damage() as f64 / 2.0).ceil(), a.actor_value()));
            r.events.push(a.action_event(a.window_id_field()));
            r.events.push(a.accepted_close(Vec::new()));
            return Ok(());
        }
        "parry" if has_window => {
            let expression = dice_expression(Some(&Value::String("1d8".into())), Some(&Value::from(ability_of(a.actor(), "dex").max(0))), 8)?;
            let parry = a.roll(r, Value::String(expression), "reaction:parry")?;
            r.rolls.push(parry.clone());
            r.events.push(event_from(&a.command, "DieRolled", Some(parry.clone()), Some(&json!([]))));
            a.spend(r)?;
            r.events.push(a.damage_reduced(js::number(parry.get("total")), a.actor_value()));
            r.events.push(a.action_event(a.window_id_field()));
            r.events.push(a.accepted_close(Vec::new()));
            return Ok(());
        }
        "riposte" if has_window => {
            a.spend(r)?;
            r.events.push(a.accepted_close(Vec::new()));
            let mut extra = a.window_id_field();
            extra.push(("economy_consumed_by_attack", Value::Bool(false)));
            r.events.push(a.action_event(extra));
            return release_attack(r, a, None, Vec::new(), |context| context.set("reactionResolution", Value::Bool(true)));
        }
        "opportunity-attack" if has_window => return opportunity_attack(r, a),
        "ready-action" => return ready_action(r, a),
        "readied-spell" if has_window => return readied_spell(r, a),
        "readied-attack" if has_window => return readied_attack(r, a),
        "stand-up" => return stand_up(r, a, &conditions),
        "break-free" if !conditions.contains("restrained") && conditions.contains("rime-encased") => {
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": "rime-encased" })), Some(&a.actor_targets())));
            r.events.push(a.action_event(vec![("success", Value::Bool(true)), ("automatic", Value::Bool(true)), ("spell_id", Value::String("rime-s-binding-ice".into()))]));
            return Ok(());
        }
        "break-free" => return break_free(r, a),
        "steady-nerves" if steady_nerves_save_applies(a) => return steady_nerves_save(r, a),
        "steady-nerves" => return steady_nerves_check(r, a),
        "extinguish-self" | "extinguish-ally" => return extinguish(r, a),
        "dash" | "expeditious-retreat-dash" => {
            if id == "expeditious-retreat-dash" && !conditions.contains("expeditious-retreat") {
                return Err(rule("«Стремительный рывок» доступен только пока активно «Поспешное отступление»", "EXPEDITIOUS_RETREAT_NOT_ACTIVE"));
            }
            let speed = crate::speed::effective_speed_feet(&a.state, a.actor().unwrap_or(&Value::Null), &a.actor_id);
            r.events.push(a.action_event(vec![("movement_bonus", Value::from(speed)), ("dash_count", Value::from(1)), ("movement_contract_version", Value::from(2))]));
            return Ok(());
        }
        "disengage" | "dodge" => {
            let condition = if id == "dodge" { "dodging" } else { "disengaged" };
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": condition, "duration": "until-next-turn" })), Some(&a.actor_targets())));
            r.events.push(a.action_event(Vec::new()));
            return Ok(());
        }
        "hide" => return hide(r, a, &conditions),
        "help" => {
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": "helped", "duration": "until-used", "source_actor": a.actor_value() })), Some(&a.target_targets())));
            r.events.push(a.action_event(Vec::new()));
            return Ok(());
        }
        "stabilize" => return stabilize(r, a),
        "first-aid" => return first_aid(r, a),
        _ => {}
    }
    if kind == Some("species_breath") {
        return species_breath(r, a);
    }
    match id.as_str() {
        "shove" => return shove(r, a),
        "second-wind" => {
            let expression = dice_expression(Some(&Value::String("1d10".into())), Some(&Value::from(js::safe_int(at(a.actor(), "level"), 1).max(1))), 10)?;
            return heal_self_roll(r, a, expression, "second_wind", &a.actor_id.clone());
        }
        "action-surge" => {
            a.spend(r)?;
            r.events.push(a.action_event(vec![("restore_action", Value::Bool(true)), ("surged_action", Value::Bool(true))]));
            return Ok(());
        }
        "trip-attack" | "menacing-attack" => return maneuver_attack(r, a),
        "hunters-mark" => return hunters_mark(r, a),
        "divine-spark" => {
            let expression = dice_expression(Some(&Value::String("1d8".into())), Some(&Value::from(ability_of(a.actor(), "wis"))), 8)?;
            let target = a.target_key.clone();
            return heal_self_roll(r, a, expression, "divine_spark", &target);
        }
        _ => {}
    }
    match kind {
        Some("dash") => effect_dash(r, a),
        Some("condition") => effect_condition(r, a),
        Some("check") => effect_check(r, a),
        Some("contest") => effect_contest(r, a),
        Some("heal") => effect_heal(r, a),
        Some("weapon_attack") => weapon_attack(r, a),
        Some("wild_shape") => wild_shape(r, a),
        Some("wild_shape_heal") => wild_shape_heal(r, a),
        Some("save") if js::is_true(a.effect_field("areaUndead")) => turn_undead(r, a),
        Some("save") => effect_save(r, a),
        Some("cleanse") => {
            // `for (const condition of conditions ?? [])`: строка обходится по символам.
            let list: Vec<Value> = match coalesce(&[a.effect_field("conditions")]) {
                None => Vec::new(),
                Some(Value::Array(items)) => items.clone(),
                Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
                Some(_) => return Err(Fault::type_error("action.effect.conditions is not iterable").into()),
            };
            for condition in list {
                if condition.as_str().is_some_and(|name| conditions.contains(name)) {
                    r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": condition })), Some(&a.actor_targets())));
                }
            }
            r.events.push(a.action_event(Vec::new()));
            Ok(())
        }
        Some("restore_action") => {
            a.spend(r)?;
            r.events.push(a.action_event(vec![("restore_action", Value::Bool(true)), ("surged_action", Value::Bool(true))]));
            Ok(())
        }
        Some("restore_resource") => {
            a.spend(r)?;
            let resource = a.effect_field("resource");
            let pool = resource_pool(&a.state, &a.actor_id, &js::string(resource), 0);
            let amount = js::safe_int(a.effect_field("amount"), 1).max(1);
            let payload = object(vec![
                ("resource", resource.cloned()),
                ("amount", Some(Value::from(amount))),
                ("before", Some(Value::from(pool.current))),
                ("after", Some(Value::from(pool.max.min(pool.current + amount)))),
                ("max", Some(Value::from(pool.max))),
            ]);
            r.events.push(event_from(&a.rules(&[rule_ids::RESOURCE]), "ResourceRestored", Some(payload), Some(&a.actor_targets())));
            r.events.push(a.action_event(Vec::new()));
            Ok(())
        }
        Some("percent_check") => {
            let check = a.roll(r, Value::String("1d100".into()), &format!("percent_check:{}", js::string(a.action.get("id"))))?;
            r.rolls.push(check.clone());
            r.events.push(event_from(&a.command, "DieRolled", Some(check.clone()), Some(&json!([]))));
            let level = js::safe_int(at(a.actor(), "level"), 1).max(1);
            let total = js::number(check.get("total"));
            r.events.push(a.action_event(vec![("success", Value::Bool(total <= level as f64)), ("roll", check.get("total").cloned().unwrap_or(Value::Null))]));
            Ok(())
        }
        Some("special") => Err(rule("Для действия требуется серверное решение правил", "RULING_REQUIRED")),
        _ => Err(rule("Для действия нет серверного обработчика", "COMBAT_ACTION_NOT_IMPLEMENTED")),
    }
}

/// Продолжение «Обессиливания» (15745–15827).
fn enervation_continuation(r: &mut Resolve<'_>, a: &Act) -> Step {
    let link = crate::enervation_link::enervation_link_for(&a.state, a.command.get("actor_id"));
    let Some(link) = link.filter(|link| link.target_id == js::string(a.effect_field("target_id"))) else {
        return Err(rule("Связь «Обессиливания» больше не существует", "ENERVATION_NOT_ACTIVE"));
    };
    let continuation = coalesce(&[a.command.get("enervation_continuation")]).cloned().unwrap_or_else(js::obj);
    r.events.push(a.action_event(vec![("spell_id", Value::String("enervation".into())), ("effect_id", Value::String(link.effect_id.clone())), ("continuation", Value::Bool(true))]));
    let invalid = match coalesce(&[continuation.get("invalid_reason")]) {
        Some(reason) => js::string(Some(reason)),
        None => crate::spells::enervation::enervation_continuation_invalid_reason(&a.state, &link).unwrap_or("").to_string(),
    };
    if !invalid.is_empty() {
        let payload = json!({ "reason": invalid, "effect_id": link.effect_id, "spell_id": "enervation" });
        r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&a.actor_targets())));
        return Ok(());
    }
    let continuation_state = reduce_events(&a.state, &r.events)?;
    let caster = sk_core::game::find_actor(&continuation_state, &a.actor_id).cloned();
    let spell_level = js::number(link.spell.get("level"));
    let slot_level = max_f(spell_level, safe_or(continuation.get("slot_level"), js::number(Some(&link.slot_level))));
    let damage = match coalesce(&[link.continuation.get("damage")]) {
        Some(damage) => js::string(Some(damage)),
        None => js::string(link.spell.get("damage")),
    };
    let upcast = safe_or(link.continuation.get("upcastDicePerLevel"), js::safe_int(link.spell.get("upcastDicePerLevel"), 0) as f64);
    let spell = spread_with(&link.spell, vec![("damage", Value::String(damage.clone())), ("upcastDicePerLevel", js::num(upcast))]);
    let expression = crate::spells::slots::scaled_spell_dice(Some(&spell), caster.as_ref(), Some(&js::num(slot_level))).filter(|value| !value.is_null()).unwrap_or(Value::String(damage));
    let damage_roll = a.roll(r, Value::String(js::string(Some(&expression))), "spell_continuation_damage:enervation")?;
    r.rolls.push(damage_roll.clone());
    r.events.push(a.die_rolled(&damage_roll, vec![("spell_id", Value::String("enervation".into())), ("effect_id", Value::String(link.effect_id.clone())), ("continuation", Value::Bool(true))]));
    let damage_state = reduce_events(&a.state, &r.events)?;
    let damage_type = js::string(coalesce(&[link.continuation.get("damageType")]).or_else(|| coalesce(&[link.spell.get("damageType")])).or(Some(&Value::String("necrotic".into()))));
    let payload = r.resolve_damage_payload(&damage_state, &link.target_id, damage_roll.get("total").cloned().unwrap_or(Value::Null), &Value::String(damage_type), None, None)?;
    let damage_event = event_from(
        &a.rules(&[rule_ids::DAMAGE]),
        "DamageApplied",
        Some(spread_with(&payload, vec![("spell_id", Value::String("enervation".into())), ("effect_id", Value::String(link.effect_id.clone())), ("continuation", Value::Bool(true))])),
        Some(&json!([link.target_id])),
    );
    r.events.push(damage_event.clone());
    if hp_after_zero(&payload) {
        r.events.extend(zero_hit_point_damage_consequences(&damage_state, &a.command, &link.target_id, &payload, false));
    }
    let after_damage = crate::replay::apply_game_event(&damage_state, &damage_event)?;
    let healed = sk_core::game::find_actor(&after_damage, &a.actor_id);
    let before = hp(healed);
    let life_steal = js::safe_int(payload.get("applied_amount"), 0).max(0) + js::safe_int(payload.get("temporary_hp_absorbed"), 0).max(0);
    let requested = (life_steal as f64 / 2.0).floor() as i64;
    let after = if condition_ids_for(&after_damage, &a.actor_id).contains("healing-blocked") { before } else { max_hp(healed).min(before + requested) };
    if after > before {
        let payload = json!({
            "spell_id": "enervation", "effect_id": link.effect_id, "continuation": true, "requested_amount": requested, "applied_amount": after - before,
            "damage_for_life_steal": life_steal, "hp_before": before, "hp_after": after, "life_steal": true,
        });
        r.events.push(event_from(&a.rules(&[rule_ids::HEALING]), "HealingApplied", Some(payload), Some(&a.actor_targets())));
    }
    if hp_after_zero(&payload) {
        let payload = json!({ "reason": "target-defeated", "effect_id": link.effect_id, "spell_id": "enervation" });
        r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&a.actor_targets())));
    }
    Ok(())
}

/// Заклинание-реакция в окне (15840–15977).
fn reaction_spell(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    let spell = a.action.get("spell").cloned().unwrap_or(Value::Null);
    let spell_id = spell.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let mut resume_spell = false;
    let mut resume_elemental = false;
    let spell_level = js::number(spell.get("level"));
    let reaction_slot_level = || max_f(spell_level, safe_or(spell.get("reactionSlotLevel"), spell_level));
    match spell_id.as_str() {
        "shield" => {
            let trigger = a.window_field("trigger_roll");
            let stopped = !js::is_true(at(trigger, "critical")) && at(trigger, "kept").and_then(Value::as_f64) != Some(20.0);
            let restored = if stopped { a.window_damage() } else { 0 };
            r.events.push(a.damage_reduced(restored as f64, a.actor_value()));
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": "shielded", "duration": "until-next-turn", "source_actor": a.actor_value() })), Some(&a.actor_targets())));
        }
        "absorb-elements" => {
            resume_elemental = js::truthy(a.window_field("pending_elemental_damage"));
            if !resume_elemental {
                let original = a.window_damage();
                let restored = if js::truthy(at(a.window_field("damage"), "resistant")) { 0.0 } else { (original as f64 / 2.0).ceil() };
                r.events.push(a.damage_reduced(restored, a.actor_value()));
                let absorbed = js::string(coalesce(&[at(a.window_field("damage"), "damage_type")]).or(Some(&Value::String("elemental".into()))));
                let slot = reaction_slot_level();
                let first = object(vec![
                    ("condition", Some(Value::String(format!("absorbing-element:{absorbed}")))),
                    ("duration", Some(Value::String("until-next-turn".into()))),
                    ("source_actor", a.command.get("actor_id").cloned()),
                    ("spell_id", spell.get("id").cloned()),
                ]);
                r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(first), Some(&a.actor_targets())));
                let rider = object(vec![
                    ("condition", Some(Value::String(format!("absorbing-element-rider:{absorbed}")))),
                    ("duration", Some(Value::String("until-next-own-turn-end".into()))),
                    ("source_actor", a.command.get("actor_id").cloned()),
                    ("spell_id", spell.get("id").cloned()),
                    ("slot_level", Some(js::num(slot))),
                    ("rider_damage", Some(Value::String("1d6".into()))),
                    ("rider_damage_type", Some(Value::String(absorbed))),
                    ("rider_source_name", spell.get("name").cloned()),
                ]);
                r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(rider), Some(&a.actor_targets())));
            }
        }
        "hellish-rebuke" => hellish_rebuke(r, a, &spell, reaction_slot_level())?,
        "silvery-barbs" => silvery_barbs(r, a, &spell)?,
        "counterspell" => resume_spell = !counterspell(r, a, &spell)?,
        _ => {}
    }
    let mut extra = a.window_id_field();
    if let Some(id) = spell.get("id") {
        extra.push(("spell_id", id.clone()));
    }
    r.events.push(a.action_event(extra));
    if resume_elemental {
        return resume::resume_pending_elemental_damage(r, &a.resume, true, Some(&a.action));
    }
    r.events.push(a.accepted_close(Vec::new()));
    if resume_spell {
        resume::resume_pending_spell(r, &a.resume)?;
    }
    Ok(())
}

/// «Адское возмездие» (15872–15893).
fn hellish_rebuke(r: &mut Resolve<'_>, a: &Act, spell: &Value, slot_level: f64) -> Step {
    let source_id = a.source_actor_id();
    let source = sk_core::game::find_actor(&a.state, &js::s(a.window_field("source_actor_id"))).cloned();
    let ability = spell.get("spellcastingAbility").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "cha".into());
    let dc = 8 + js::safe_int(at(a.actor(), "proficiency"), 0).max(0) + ability_of(a.actor(), &ability);
    let save_options = options(vec![
        ("ability", Value::String("dex".into())),
        ("modifier", Value::from(ability_of(source.as_ref(), "dex"))),
        ("purpose", Value::String("reaction:hellish-rebuke".into())),
        ("visibility", a.raw_visibility()),
    ]);
    let state = a.state.clone();
    let save = r.roll_saving_throw(&state, Some(&Value::String(source_id.clone())), &save_options)?;
    let damage = coalesce(&[spell.get("damage")]).cloned().unwrap_or_else(|| Value::String("2d10".into()));
    let card = spread_with(spell, vec![("damage", damage.clone())]);
    let expression = crate::spells::slots::scaled_spell_dice(Some(&card), a.actor(), Some(&js::num(slot_level))).filter(|value| !value.is_null()).unwrap_or(damage);
    let damage_roll = a.roll(r, expression, "reaction:hellish-rebuke:damage")?;
    r.rolls.push(save.clone());
    r.rolls.push(damage_roll.clone());
    let saved = saving_throw_succeeded(Some(&save), dc as f64);
    let spell_id = spell.get("id").cloned();
    let mut payload = spread_value(Some(&save));
    if let Some(id) = &spell_id {
        payload.insert("spell_id".into(), id.clone());
    }
    payload.insert("ability".into(), Value::String("dex".into()));
    payload.insert("difficulty".into(), Value::from(dc));
    payload.insert("saved".into(), Value::Bool(saved));
    r.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(Value::Object(payload)), Some(&json!([source_id]))));
    let mut rolled = vec![];
    if let Some(id) = &spell_id {
        rolled.push(("spell_id", id.clone()));
    }
    rolled.push(("slot_level", js::num(slot_level)));
    r.events.push(a.die_rolled(&damage_roll, rolled));
    let raw = saved_damage_amount(&state, &source_id, Some(&Value::String("dex".into())), saved, true, damage_roll.get("total"));
    let payload = r.resolve_damage_payload(&state, &source_id, Value::from(raw), &Value::String("fire".into()), None, None)?;
    let mut damage_payload = spread_value(Some(&payload));
    if let Some(id) = &spell_id {
        damage_payload.insert("spell_id".into(), id.clone());
    }
    r.events.push(event_from(&a.rules(&[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(damage_payload)), Some(&json!([source_id]))));
    r.events.extend(zero_hit_point_damage_consequences(&state, &a.command, &source_id, &payload, false));
    Ok(())
}

/// «Искусная острота» (15894–15932).
fn silvery_barbs(r: &mut Resolve<'_>, a: &Act, spell: &Value) -> Step {
    let original = coalesce(&[a.window_field("trigger_roll")]).cloned().unwrap_or_else(js::obj);
    let modifier = js::safe_int(original.get("modifier"), 0);
    let mut reroll_options = Map::new();
    reroll_options.insert("modifier".into(), Value::from(modifier));
    reroll_options.insert("purpose".into(), Value::String("reaction:silvery-barbs".into()));
    reroll_options.insert("actorId".into(), Value::String(a.source_actor_id()));
    if let Some(visibility) = a.command.get("visibility") {
        reroll_options.insert("visibility".into(), visibility.clone());
    }
    let reroll = crate::dice_record::RulesDice::roll_d20(&mut r.dice, &Value::Object(reroll_options))?;
    r.rolls.push(reroll.clone());
    let kept = js::safe_int(original.get("kept"), 20).min(js::safe_int(reroll.get("kept"), 20));
    let total = kept + modifier;
    let armor_class = js::safe_int(original.get("armor_class"), 10);
    let hit = kept == 20 || (kept != 1 && total >= armor_class);
    let payload = object(vec![
        ("spell_id", spell.get("id").cloned()),
        ("original_kept", Some(Value::from(js::safe_int(original.get("kept"), 0)))),
        ("rerolled_kept", reroll.get("kept").cloned()),
        ("kept", Some(Value::from(kept))),
        ("modifier", Some(Value::from(modifier))),
        ("total", Some(Value::from(total))),
        ("armor_class", Some(Value::from(armor_class))),
        ("hit", Some(Value::Bool(hit))),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::REACTION, rule_ids::ATTACK]), "AttackRerolled", Some(payload), Some(&json!([a.source_actor_id()]))));
    if !hit && js::truthy(a.window_field("damage")) {
        let damage = a.window_field("damage");
        let restored = js::safe_int(at(damage, "applied_amount"), 0) + js::safe_int(at(damage, "temporary_hp_absorbed"), 0);
        r.events.push(a.damage_reduced(restored as f64, Value::String(js::string(a.window_field("target_id")))));
    }
    let beneficiary = js::string(coalesce(&[a.command.get("beneficiary_id"), a.command.get("actor_id")]));
    if condition_ids_for(&a.state, &beneficiary).contains("silvery-fortune") {
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": "silvery-fortune", "reason": "replaced-by-silvery-barbs" })), Some(&json!([beneficiary]))));
    }
    let payload = object(vec![
        ("condition", Some(Value::String("silvery-fortune".into()))),
        ("duration", Some(Value::String("rounds:10".into()))),
        ("source_actor", a.command.get("actor_id").cloned()),
        ("effect_id", Some(Value::String(format!("silvery-barbs:{}", js::string(a.command.get("command_id")))))),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&json!([beneficiary]))));
    Ok(())
}

/// Контрзаклинание (15933–15968): `true` — сохранённое заклинание отменено.
fn counterspell(r: &mut Resolve<'_>, a: &Act, spell: &Value) -> Result<bool, Halt> {
    let pending = a.window_field("pending_spell_command").cloned();
    let pending_ref = pending.as_ref().filter(|value| !value.is_null());
    let source_id = a.source_actor_id();
    let source = sk_core::game::find_actor(&a.state, &js::s(a.window_field("source_actor_id"))).cloned();
    let options_value = ruleset_options(&a.state);
    let pending_spell_id = at(pending_ref, "spell_id");
    let pending_spell = if sk_combat_content::combat_spells::monster_spellcasting_for(source.as_ref()).is_some() {
        sk_combat_content::combat_spells::monster_combat_spell_for(source.as_ref(), pending_spell_id, Some(&options_value))
    } else {
        sk_combat_content::combat_spells::combat_spell_for(source.as_ref(), pending_spell_id, Some(&options_value))
    };
    let pending_spell_ref = pending_spell.as_ref();
    let level_fallback = coalesce(&[at(pending_spell_ref, "level")]).map(|value| js::number(Some(value))).unwrap_or(0.0);
    let cast_level = max_f(0.0, safe_or(at(pending_ref, "slot_level"), level_fallback));
    let counterspell_level = js::safe_int(spell.get("reactionSlotLevel"), 3).max(3);
    let mut success = counterspell_level as f64 >= cast_level;
    if !success {
        let ability = spell.get("spellcastingAbility").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "int".into());
        let check_options = options(vec![
            ("modifier", Value::from(ability_of(a.actor(), &ability))),
            ("purpose", Value::String("reaction:counterspell".into())),
            ("actorId", undef(a.command.get("actor_id"))),
            ("visibility", a.raw_visibility()),
        ]);
        let check = a.check(r, &ability, check_options, D20Method::RollD20)?;
        r.rolls.push(check.clone());
        success = js::number(check.get("total")) >= 10.0 + cast_level;
        let mut payload = spread_value(Some(&check));
        payload.insert("difficulty".into(), js::num(10.0 + cast_level));
        payload.insert("spell_level".into(), js::num(cast_level));
        payload.insert("counterspell_level".into(), Value::from(counterspell_level));
        payload.insert("success".into(), Value::Bool(success));
        r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK, rule_ids::REACTION]), "CounterspellCheckResolved", Some(Value::Object(payload)), Some(&json!([source_id]))));
    }
    if !success {
        return Ok(false);
    }
    let pending_as_source = {
        let mut map = spread_value(pending_ref);
        map.insert("actor_id".into(), Value::String(source_id.clone()));
        Value::Object(map)
    };
    r.events.extend(spell_component_cost_events(&a.state, &pending_as_source, pending_spell_ref, &Context::default())?);
    if let Some(use_record) = at(pending_ref, "monster_spell_use").filter(|value| js::truthy(Some(value))) {
        let condition = format!(
            "{}{}#{}",
            sk_combat_content::combat_spells::MONSTER_SPELL_USE_CONDITION_PREFIX,
            js::string(use_record.get("spell_id")),
            js::string(use_record.get("ordinal"))
        );
        let source_command = {
            let mut map = spread_value(pending_ref);
            map.insert("visibility".into(), Value::String("gm_only".into()));
            Value::Object(map)
        };
        let payload = json!({ "condition": condition, "duration": "until-long-rest", "source_actor": source_id });
        r.events.push(event_from(&source_command, "ConditionAdded", Some(payload), Some(&json!([source_id]))));
    }
    if let Some(resource) = at(pending_ref, "spell_slot_resource").filter(|value| js::truthy(Some(value))) {
        let pool = resource_pool(&a.state, &source_id, &js::string(Some(resource)), 0);
        let payload = json!({ "resource": resource, "amount": 1, "before": pool.current, "after": pool.current - 1, "max": pool.max });
        r.events.push(event_from(&a.rules(&[rule_ids::RESOURCE]), "ResourceSpent", Some(payload), Some(&json!([source_id]))));
    }
    let spell_id = coalesce(&[at(pending_spell_ref, "id")]).or_else(|| at(pending_ref, "spell_id")).cloned();
    let name = coalesce(&[at(pending_spell_ref, "name")]).or_else(|| at(pending_ref, "spell_id")).cloned();
    let payload = object(vec![
        ("spell_id", spell_id.clone()),
        ("name", name.clone()),
        ("kind", Some(coalesce(&[at(pending_spell_ref, "kind")]).cloned().unwrap_or_else(|| Value::String("utility".into())))),
        ("action_type", Some(coalesce(&[at(pending_spell_ref, "actionType")]).cloned().unwrap_or_else(|| Value::String("action".into())))),
        ("level", Some(coalesce(&[at(pending_spell_ref, "level")]).cloned().unwrap_or_else(|| js::num(cast_level)))),
        ("slot_level", Some(js::num(cast_level))),
        ("countered", Some(Value::Bool(true))),
        ("source_url", at(pending_spell_ref, "sourceUrl").cloned()),
    ]);
    let targets = coalesce(&[at(pending_ref, "target_ids")]).cloned().unwrap_or_else(|| json!([]));
    r.events.push(event_from(&command_with_rules(&a.as_actor(&source_id), &[rule_ids::REACTION]), "SpellCast", Some(payload), Some(&targets)));
    let payload = object(vec![
        ("spell_id", spell_id),
        ("spell_name", name),
        ("spell_level", Some(js::num(cast_level))),
        ("counterspell_level", Some(Value::from(counterspell_level))),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::REACTION]), "SpellCountered", Some(payload), Some(&json!([source_id]))));
    Ok(true)
}

/// Удар реакцией по источнику окна (`riposte`, `opportunity-attack`,
/// `readied-attack`): `MakeAttack` над состоянием после ответа.
fn release_attack(r: &mut Resolve<'_>, a: &Act, item_id: Option<Value>, extra: Vec<(&str, Value)>, adjust: impl FnOnce(&mut Context)) -> Step {
    let release_state = reduce_events(&a.state, &r.events)?;
    let source = a.source_actor_id();
    let mut map = spread_value(Some(&a.rules(&[rule_ids::ATTACK, rule_ids::REACTION])));
    map.insert("command_type".into(), Value::String("MakeAttack".into()));
    map.shift_remove("action_id");
    match release_state.get("state_version") {
        Some(version) => {
            map.insert("expected_state_version".into(), version.clone());
        }
        None => {
            map.shift_remove("expected_state_version");
        }
    }
    if let Some(item) = item_id {
        if item.as_str() == Some(js::UNDEFINED) {
            map.shift_remove("item_id");
        } else {
            map.insert("item_id".into(), item);
        }
    }
    map.insert("target_id".into(), Value::String(source.clone()));
    map.insert("target_ids".into(), json!([source]));
    for (key, value) in extra {
        if value.as_str() == Some(js::UNDEFINED) {
            map.shift_remove(key);
        } else {
            map.insert(key.into(), value);
        }
    }
    let command = Value::Object(map);
    let mut context = r.context.clone();
    adjust(&mut context);
    let result = resolve_pending(r, &command, &release_state, PendingDice::Direct, &context)?;
    r.events.extend(result.events);
    r.rolls.extend(result.rolls);
    Ok(())
}

/// Атака по возможности в окне (16006–16029).
fn opportunity_attack(r: &mut Resolve<'_>, a: &Act) -> Step {
    let Some(opportunity) = crate::combat::weapons::opportunity_attack_profile(&a.state, a.actor())? else {
        return Err(rule("Для атаки по возможности нужно готовое ближнее оружие", "OPPORTUNITY_WEAPON_UNAVAILABLE"));
    };
    let fleeing = condition_ids_for(&a.state, &js::string(a.window_field("source_actor_id"))).contains("fled").then(|| a.source_actor_id());
    let mut extra = Vec::new();
    if fleeing.is_some() {
        extra.push(("defer_flee", Value::Bool(true)));
    }
    r.events.push(a.accepted_close(extra));
    let mut used = a.window_id_field();
    used.push(("economy_consumed_by_attack", Value::Bool(false)));
    r.events.push(a.action_event(used));
    let item = js::truthy(Some(&opportunity.item_id)).then(|| opportunity.item_id.clone());
    let mut extra = vec![("reaction_attack", Value::Bool(true))];
    extra.push(("reaction_target_position", undef(a.window_field("source_previous_position"))));
    let release_state = reduce_events(&a.state, &r.events)?;
    let source = a.source_actor_id();
    let mut map = spread_value(Some(&a.rules(&[rule_ids::ATTACK, rule_ids::REACTION])));
    map.insert("command_type".into(), Value::String("MakeAttack".into()));
    map.shift_remove("action_id");
    match release_state.get("state_version") {
        Some(version) => {
            map.insert("expected_state_version".into(), version.clone());
        }
        None => {
            map.shift_remove("expected_state_version");
        }
    }
    map.insert("target_id".into(), Value::String(source.clone()));
    map.insert("target_ids".into(), json!([source]));
    if let Some(item) = item {
        map.insert("item_id".into(), item);
    }
    for (key, value) in extra {
        if value.as_str() == Some(js::UNDEFINED) {
            map.shift_remove(key);
        } else {
            map.insert(key.into(), value);
        }
    }
    let command = Value::Object(map);
    let mut context = r.context.clone();
    context.set("reactionResolution", Value::Bool(true));
    context.set("finalizeFleeActorId", fleeing.map(Value::String).unwrap_or(Value::Null));
    let result = resolve_pending(r, &command, &release_state, PendingDice::Direct, &context)?;
    r.events.extend(result.events);
    r.rolls.extend(result.rolls);
    Ok(())
}

/// `READIED_TRIGGERS[trigger]`: у ключей `Object.prototype` JS находит
/// сам прототип (`{}`) или функцию — тогда `ActionReadied` несёт функцию, и
/// первое же `structuredClone` события падает `DataCloneError` (`Err`).
fn readied_trigger_label(trigger: &str) -> Option<Result<Value, Halt>> {
    if let Some((_, label)) = READIED_TRIGGERS.iter().find(|(key, _)| *key == trigger) {
        return Some(Ok(Value::String((*label).into())));
    }
    if OBJECT_PROTOTYPE_KEYS.contains(&trigger) {
        if trigger == "__proto__" {
            return Some(Ok(js::obj()));
        }
        let name = if trigger == "constructor" { "Object".to_string() } else { trigger.to_string() };
        return Some(Err(Fault::new("DataCloneError", format!("function {name}() {{ [native code] }} could not be cloned.")).into()));
    }
    None
}

/// «Готовность» (16030–16095).
fn ready_action(r: &mut Resolve<'_>, a: &Act) -> Step {
    if !sk_core::game::combat_active(&a.state) {
        return Err(rule("Готовиться можно только в бою", "COMBAT_NOT_ACTIVE"));
    }
    let trigger = js::s(a.command.get("readied_trigger"));
    let Some(label) = readied_trigger_label(&trigger) else {
        let known: Vec<&str> = READIED_TRIGGERS.iter().map(|(key, _)| *key).collect();
        return Err(rule(format!("Сервер распознаёт только такие триггеры готовности: {}", known.join(", ")), "READIED_TRIGGER_UNKNOWN"));
    };
    let round = Value::from(js::safe_int(sk_core::game::combat(&a.state).get("round"), 1));
    let readied_spell_id = js::s(a.command.get("readied_spell_id"));
    if !readied_spell_id.is_empty() {
        // Заготовленное заклинание творится сейчас: ячейка тратится сразу, а
        // магия держится концентрацией до срабатывания триггера.
        let options_value = ruleset_options(&a.state);
        let Some(spell) = sk_combat_content::combat_spells::combat_spell_for(a.actor(), Some(&Value::String(readied_spell_id.clone())), Some(&options_value)) else {
            return Err(rule("Это заклинание недоступно герою", "SPELL_NOT_AVAILABLE"));
        };
        assert_mechanics_supported(Some(&spell), "заклинания")?;
        if spell.get("target").and_then(Value::as_str) == Some("point") {
            return Err(rule("Заготовка заклинаний с выбором точки пока недоступна. Наложите заклинание обычным действием.", "READIED_POINT_SPELL_UNSUPPORTED"));
        }
        assert_spell_components_allowed(&a.state, a.actor(), Some(&spell), &Context::default())?;
        if spell.get("actionType").and_then(Value::as_str) != Some("action") {
            return Err(rule("Заготовить можно только заклинание с временем накладывания «действие»", "READIED_SPELL_ACTION_ONLY"));
        }
        let has_slot_resource = js::truthy(spell.get("slotResource"));
        let slot = if has_slot_resource { crate::spells::slots::choose_spell_slot(&a.state, &a.actor_id, Some(&spell), a.command.get("slot_level"), None)? } else { None };
        if has_slot_resource && slot.is_none() {
            return Err(rule("Нет доступной ячейки подходящего уровня", "INSUFFICIENT_RESOURCE"));
        }
        let slot_level = slot.as_ref().map(|slot| Value::from(slot.level)).or_else(|| spell.get("level").cloned());
        let mut counter_command = spread_value(Some(&a.command));
        counter_command.insert("spell_id".into(), Value::String(readied_spell_id.clone()));
        match &slot_level {
            Some(level) => {
                counter_command.insert("slot_level".into(), level.clone());
            }
            None => {
                counter_command.shift_remove("slot_level");
            }
        }
        counter_command.insert("spell_slot_resource".into(), slot.as_ref().map(|slot| Value::String(slot.resource.clone())).unwrap_or(Value::Null));
        if let Some(window) = crate::reactions::counterspell_window_for(&a.state, &Value::Object(counter_command), &spell) {
            r.events.push(window);
            return Ok(());
        }
        let effect_id = format!("readied:{}:{}", js::string(spell.get("id")), js::string(a.command.get("command_id")));
        r.events.extend(spell_component_cost_events(&a.state, &a.command, Some(&spell), &Context::default())?);
        if let Some(slot) = &slot {
            let pool = resource_pool(&a.state, &a.actor_id, &slot.resource, 0);
            let payload = json!({ "resource": slot.resource, "amount": 1, "before": pool.current, "after": pool.current - 1, "max": pool.max });
            r.events.push(event_from(&a.rules(&[rule_ids::RESOURCE]), "ResourceSpent", Some(payload), Some(&a.actor_targets())));
        }
        if let Some(previous) = a.concentration(&a.actor_id) {
            let payload = object(vec![("reason", Some(Value::String("replaced".into()))), ("effect_id", previous.get("effect_id").cloned())]);
            r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&a.actor_targets())));
        }
        r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationStarted", Some(json!({ "effect_id": effect_id })), Some(&a.actor_targets())));
        let payload = object(vec![
            ("trigger", Some(Value::String(trigger.clone()))),
            ("trigger_label", Some(label?)),
            ("readied_action_id", Some(Value::String("readied-spell".into()))),
            ("spell_id", spell.get("id").cloned()),
            ("spell_name", spell.get("name").cloned()),
            ("slot_level", slot_level),
            ("effect_id", Some(Value::String(effect_id))),
            ("round", Some(round)),
        ]);
        r.events.push(event_from(&a.rules(&[rule_ids::TURNS, rule_ids::REACTION]), "ActionReadied", Some(payload), Some(&a.actor_targets())));
        let mut extra = vec![("readied_trigger", Value::String(trigger))];
        if let Some(id) = spell.get("id") {
            extra.push(("readied_spell_id", id.clone()));
        }
        r.events.push(a.action_event(extra));
        return Ok(());
    }
    // Заготовить можно только то, что сервер потом действительно исполнит.
    if crate::combat::weapons::opportunity_attack_profile(&a.state, a.actor())?.is_none() {
        return Err(rule("Нечем нанести заготовленный удар: нужно оружие", "WEAPON_REQUIRED"));
    }
    let payload = object(vec![
        ("trigger", Some(Value::String(trigger.clone()))),
        ("trigger_label", Some(label?)),
        ("readied_action_id", Some(Value::String("readied-attack".into()))),
        ("item_id", Some(coalesce(&[a.command.get("item_id")]).cloned().unwrap_or(Value::Null))),
        ("round", Some(round)),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::TURNS, rule_ids::REACTION]), "ActionReadied", Some(payload), Some(&a.actor_targets())));
    r.events.push(a.action_event(vec![("readied_trigger", Value::String(trigger))]));
    Ok(())
}

/// `state.mechanics.combat.readied?.[actorId]`.
fn readied_for<'a>(a: &'a Act) -> Option<&'a Value> {
    sk_core::game::combat(&a.state).get("readied").and_then(|all| all.get(&a.actor_id))
}

/// `ReadiedActionExpired` при выпуске заготовки.
fn readied_used(a: &Act, readied: &Value) -> Value {
    let payload = object(vec![("reason", Some(Value::String("used".into()))), ("trigger", readied.get("trigger").cloned())]);
    event_from(&a.rules(&[rule_ids::REACTION]), "ReadiedActionExpired", Some(payload), Some(&a.actor_targets()))
}

/// Выпуск заготовленного заклинания (16096–16117).
fn readied_spell(r: &mut Resolve<'_>, a: &Act) -> Step {
    let readied = readied_for(a).cloned();
    let Some(readied) = readied.filter(|readied| js::truthy(readied.get("spell_id"))) else {
        return Err(rule("Заклинание не заготовлено", "READIED_ACTION_MISSING"));
    };
    r.events.push(a.accepted_close(Vec::new()));
    r.events.push(readied_used(a, &readied));
    // Удержание кончилось вместе с выпуском: концентрация снимается до самого
    // заклинания, иначе оно тут же заменило бы её собой.
    if let Some(effect) = readied.get("effect_id").filter(|value| js::truthy(Some(value))) {
        r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(json!({ "reason": "readied-released", "effect_id": effect })), Some(&a.actor_targets())));
    }
    let mut extra = a.window_id_field();
    extra.push(("readied_spell_id", readied.get("spell_id").cloned().unwrap_or(Value::Null)));
    r.events.push(a.action_event(extra));
    let release_state = reduce_events(&a.state, &r.events)?;
    let source = a.source_actor_id();
    let mut map = spread_value(Some(&a.rules(&[rule_ids::REACTION])));
    map.insert("command_type".into(), Value::String("CastSpell".into()));
    map.insert("spell_id".into(), Value::String(js::string(readied.get("spell_id"))));
    map.insert("slot_level".into(), Value::from(js::safe_int(readied.get("slot_level"), 1)));
    match release_state.get("state_version") {
        Some(version) => {
            map.insert("expected_state_version".into(), version.clone());
        }
        None => {
            map.shift_remove("expected_state_version");
        }
    }
    let target_id = coalesce(&[a.command.get("target_id")]).cloned().unwrap_or_else(|| Value::String(source.clone()));
    map.insert("target_id".into(), target_id);
    let has_targets = match a.command.get("target_ids") {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        _ => false,
    };
    let target_ids = if has_targets { a.command.get("target_ids").cloned().unwrap_or(Value::Null) } else { json!([source]) };
    map.insert("target_ids".into(), target_ids);
    let command = Value::Object(map);
    let mut context = r.context.clone();
    context.set("isAdmin", Value::Bool(true));
    context.set("serverAuthoritativeCombat", Value::Bool(true));
    context.set("readiedRelease", Value::Bool(true));
    let result = resolve_pending(r, &command, &release_state, PendingDice::Direct, &context)?;
    r.events.extend(result.events);
    r.rolls.extend(result.rolls);
    Ok(())
}

/// Выпуск заготовленного удара (16118–16135).
fn readied_attack(r: &mut Resolve<'_>, a: &Act) -> Step {
    let Some(readied) = readied_for(a).filter(|readied| js::truthy(Some(readied))).cloned() else {
        return Err(rule("Ничего не заготовлено", "READIED_ACTION_MISSING"));
    };
    r.events.push(a.accepted_close(Vec::new()));
    r.events.push(readied_used(a, &readied));
    let mut used = a.window_id_field();
    used.push(("economy_consumed_by_attack", Value::Bool(false)));
    r.events.push(a.action_event(used));
    let item = coalesce(&[a.command.get("item_id")]).or_else(|| coalesce(&[readied.get("item_id")])).cloned().unwrap_or_else(|| Value::String(js::UNDEFINED.into()));
    release_attack(r, a, Some(item), vec![("reaction_attack", Value::Bool(true))], |context| context.set("reactionResolution", Value::Bool(true)))
}

/// Встать (16136–16144).
fn stand_up(r: &mut Resolve<'_>, a: &Act, conditions: &sk_core::indexmap::IndexSet<String>) -> Step {
    if !conditions.contains("prone") {
        return Err(rule("Встать можно только из состояния «сбит с ног»", "ACTOR_NOT_PRONE"));
    }
    let speed = crate::speed::effective_speed_feet(&a.state, a.actor().unwrap_or(&Value::Null), &a.actor_id);
    let cost = (speed as f64 / 2.0).ceil() as i64;
    let available = js::number(crate::geometry::movement::movement_for_actor(&a.state, &a.actor_id).get("movement_remaining"));
    if speed == 0 || available < cost as f64 {
        return Err(rule("Недостаточно оставшейся скорости, чтобы встать", "SPEED_EXCEEDED"));
    }
    r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": "prone" })), Some(&a.actor_targets())));
    r.events.push(a.action_event(vec![("movement_spent", Value::from(cost)), ("movement_contract_version", Value::from(2))]));
    Ok(())
}

/// Высвободиться (16150–16162).
fn break_free(r: &mut Resolve<'_>, a: &Act) -> Step {
    let restrained = conditions_of(&a.state, &a.actor_id).iter().find(|condition| condition_name(condition) == "restrained").cloned();
    let Some(restrained) = restrained else {
        return Err(rule("Высвобождаться можно только из удерживающего эффекта", "ACTOR_NOT_RESTRAINED"));
    };
    if js::is_true(restrained.get("no_escape")) {
        return Err(rule("От этого опутывания не освободиться проверкой: остаётся спасбросок в конце хода", "RESTRAINT_NOT_ESCAPABLE"));
    }
    let wanted = js::s(restrained.get("effect_id"));
    let effects = sk_core::game::mechanics(&a.state).get("active_effects").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut effect = None;
    for candidate in &effects {
        if candidate.is_null() {
            return Err(Fault::type_error("Cannot read properties of null (reading 'effect_id')").into());
        }
        if js::s(coalesce(&[candidate.get("effect_id"), candidate.get("id")])) == wanted {
            effect = Some(candidate.clone());
            break;
        }
    }
    let dc_source = coalesce(&[restrained.get("escape_dc"), restrained.get("save_dc")]).or_else(|| at(effect.as_ref(), "save_dc"));
    let difficulty = js::safe_int(dc_source, 10).max(1);
    let check_options = options(vec![
        ("modifier", Value::from(ability_of(a.actor(), "str"))),
        ("difficulty", Value::from(difficulty)),
        ("purpose", Value::String("break_free:strength".into())),
        ("actorId", undef(a.command.get("actor_id"))),
        ("visibility", a.raw_visibility()),
    ]);
    let check = a.check(r, "str", check_options, D20Method::RollCheck)?;
    r.rolls.push(check.clone());
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String("str".into()));
    for (key, value) in spread_value(Some(&check)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&a.actor_targets())));
    if js::truthy(check.get("success")) {
        let source = js::s(restrained.get("source_actor"));
        // Освободившийся из длящейся области рвёт только свои путы: область
        // остаётся и держит остальных.
        let held_by_area = effect.is_some();
        let effect_id = restrained.get("effect_id").filter(|value| js::truthy(Some(value)));
        let concentrated = effect_id.is_some_and(|effect| js::s(a.concentration_raw(&source).and_then(|entry| entry.get("effect_id"))) == js::string(Some(effect)));
        if !held_by_area && concentrated {
            let payload = json!({ "reason": "break-free", "effect_id": effect_id.cloned().unwrap_or(Value::Null) });
            r.events.push(event_from(&command_with_rules(&a.as_actor(&source), &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&json!([source]))));
        } else {
            let mut fields = vec![("condition", Some(Value::String("restrained".into())))];
            fields.extend(effect_id_fields(&restrained));
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(object(fields)), Some(&a.actor_targets())));
        }
    }
    r.events.push(a.action_event(vec![("success", check.get("success").cloned().unwrap_or(Value::String(js::UNDEFINED.into()))), ("difficulty", Value::from(difficulty))]).strip_marker());
    Ok(())
}

trait StripMarker {
    fn strip_marker(self) -> Self;
}

impl StripMarker for Value {
    /// Убрать из полезной нагрузки события поля-маркеры `undefined`
    /// (`success: check.success` без поля у броска).
    fn strip_marker(mut self) -> Self {
        if let Some(payload) = self.get_mut("payload") {
            js::strip_undefined(payload);
        }
        self
    }
}

/// «Совладать с собой» против заклинания с действием-спасброском (16163–16169).
fn steady_nerves_save_applies(a: &Act) -> bool {
    let conditions = conditions_of(&a.state, &a.actor_id);
    !conditions.iter().any(|condition| condition.get("id").and_then(Value::as_str) == Some("wrathful-smite-frightened")) && conditions.iter().any(|condition| js::truthy(condition.get("action_save_ability")))
}

/// «Неудержимая пляска Отто» 2014 и родня (16163–16186).
fn steady_nerves_save(r: &mut Resolve<'_>, a: &Act) -> Step {
    let conditions = conditions_of(&a.state, &a.actor_id).to_vec();
    let Some(hold) = conditions.iter().find(|condition| js::truthy(condition.get("action_save_ability"))).cloned() else {
        return Err(rule("Нет заклинания, против которого можно совладать с собой действием", "NO_ACTION_SAVE_EFFECT"));
    };
    let ability = js::string(hold.get("action_save_ability"));
    let difficulty = js::safe_int(hold.get("save_dc"), 10).max(1);
    let save_options = options(vec![
        ("ability", Value::String(ability.clone())),
        ("modifier", Value::from(ability_of(a.actor(), &ability))),
        ("purpose", Value::String(format!("spell_action_save:{}:{ability}", js::string(hold.get("spell_id"))))),
        ("visibility", a.raw_visibility()),
    ]);
    let state = a.state.clone();
    let save = r.roll_saving_throw(&state, a.command.get("actor_id"), &save_options)?;
    let saved = saving_throw_succeeded(Some(&save), difficulty as f64);
    r.rolls.push(save.clone());
    let mut payload = spread_value(Some(&save));
    if let Some(spell) = hold.get("spell_id") {
        payload.insert("spell_id".into(), spell.clone());
    }
    payload.insert("ability".into(), Value::String(ability));
    payload.insert("difficulty".into(), Value::from(difficulty));
    payload.insert("saved".into(), Value::Bool(saved));
    payload.insert("trigger".into(), Value::String("action-save".into()));
    r.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(Value::Object(payload)), Some(&a.actor_targets())));
    if saved {
        let source = js::s(hold.get("source_actor"));
        let effect = hold.get("effect_id").filter(|value| js::truthy(Some(value)));
        let concentrated = effect.is_some_and(|effect| js::s(a.concentration_raw(&source).and_then(|entry| entry.get("effect_id"))) == js::string(Some(effect)));
        if concentrated {
            let payload = json!({ "reason": "action-save", "effect_id": effect.cloned().unwrap_or(Value::Null) });
            r.events.push(event_from(&command_with_rules(&a.as_actor(&source), &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&json!([source]))));
        } else if let Some(effect) = effect {
            for condition in conditions.iter().filter(|candidate| crate::validate::common::strict_equal(candidate.get("effect_id"), Some(effect))) {
                let payload = object(vec![("condition", condition.get("id").cloned()), ("effect_id", Some(effect.clone()))]);
                r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(payload), Some(&a.actor_targets())));
            }
        }
    }
    let mut extra = vec![("success", Value::Bool(saved)), ("difficulty", Value::from(difficulty))];
    if let Some(spell) = hold.get("spell_id") {
        extra.push(("spell_id", spell.clone()));
    }
    r.events.push(a.action_event(extra));
    Ok(())
}

/// «Совладать с собой» под «Гневной карой» (16187–16206).
fn steady_nerves_check(r: &mut Resolve<'_>, a: &Act) -> Step {
    let fear = conditions_of(&a.state, &a.actor_id).iter().find(|condition| condition_name(condition) == "wrathful-smite-frightened").cloned();
    let Some(fear) = fear else {
        return Err(rule("Это действие доступно только испуганной «Гневной карой» цели", "WRATHFUL_SMITE_NOT_ACTIVE"));
    };
    let difficulty = js::safe_int(fear.get("save_dc"), 10).max(1);
    let check_options = options(vec![
        ("modifier", Value::from(ability_of(a.actor(), "wis"))),
        ("difficulty", Value::from(difficulty)),
        ("purpose", Value::String("wrathful_smite:wisdom_check".into())),
        ("actorId", undef(a.command.get("actor_id"))),
        ("visibility", a.raw_visibility()),
    ]);
    let check = a.check(r, "wis", check_options, D20Method::RollCheck)?;
    r.rolls.push(check.clone());
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String("wis".into()));
    payload.insert("spell_id".into(), Value::String("wrathful-smite".into()));
    for (key, value) in spread_value(Some(&check)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&a.actor_targets())));
    if js::truthy(check.get("success")) {
        let source = js::s(fear.get("source_actor"));
        let effect = fear.get("effect_id").filter(|value| js::truthy(Some(value)));
        let concentrated = effect.is_some_and(|effect| js::s(a.concentration_raw(&source).and_then(|entry| entry.get("effect_id"))) == js::string(Some(effect)));
        if concentrated {
            let payload = json!({ "reason": "steady-nerves", "effect_id": effect.cloned().unwrap_or(Value::Null) });
            r.events.push(event_from(&command_with_rules(&a.as_actor(&source), &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&json!([source]))));
        } else {
            let mut first = vec![("condition", fear.get("id").cloned())];
            first.extend(effect_id_fields(&fear));
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(object(first)), Some(&a.actor_targets())));
            let mut second = vec![("condition", Some(Value::String("frightened".into())))];
            second.extend(effect_id_fields(&fear));
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(object(second)), Some(&a.actor_targets())));
        }
    }
    r.events.push(a.action_event(vec![("success", check.get("success").cloned().unwrap_or(Value::String(js::UNDEFINED.into()))), ("difficulty", Value::from(difficulty))]).strip_marker());
    Ok(())
}

/// Потушить пламя (16207–16222).
fn extinguish(r: &mut Resolve<'_>, a: &Act) -> Step {
    let own = a.id() == "extinguish-self";
    let target_id = if own { a.actor_id.clone() } else { a.target_key.clone() };
    let target_value = if own { a.actor_value() } else { a.target.clone() };
    let flames = conditions_of(&a.state, &target_id).iter().find(|condition| EXTINGUISHABLE_FLAME_CONDITIONS.contains(&condition_name(condition).as_str())).cloned();
    let Some(flames) = flames else {
        return Err(rule("На цели нет горящего пламени", "FLAMES_NOT_ACTIVE"));
    };
    let mut removed = vec![("condition", flames.get("id").cloned())];
    removed.extend(effect_id_fields(&flames));
    let fallback = vec![event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(object(removed)), Some(&json!([target_value])))];
    let events = a.end_source_effect(&flames, "extinguished", fallback);
    r.events.extend(events);
    if own {
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": "prone", "duration": null, "reason": "extinguish-burning" })), Some(&a.actor_targets())));
    }
    r.events.push(a.action_event(vec![("extinguished", Value::Bool(true)), ("target_id", target_value), ("prone", Value::Bool(own))]));
    Ok(())
}

/// Спрятаться (16233–16242).
fn hide(r: &mut Resolve<'_>, a: &Act, conditions: &sk_core::indexmap::IndexSet<String>) -> Step {
    let modifier = ability_of(a.actor(), "dex") + skill_proficiency_bonus(a.actor(), "stealth", Some(&a.state)) + if conditions.contains("pass-without-trace") { 10 } else { 0 };
    let check_options = options(vec![
        ("modifier", Value::from(modifier)),
        ("difficulty", Value::from(12)),
        ("purpose", Value::String("combat_hide".into())),
        ("actorId", undef(a.command.get("actor_id"))),
        ("disadvantage", Value::Bool(armor_stealth_disadvantage(a.actor()))),
        ("visibility", a.raw_visibility()),
    ]);
    let check = a.check(r, "dex", check_options, D20Method::RollCheck)?;
    r.rolls.push(check.clone());
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String("dex".into()));
    payload.insert("skill".into(), Value::String("stealth".into()));
    for (key, value) in spread_value(Some(&check)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&a.actor_targets())));
    // Бросок остаётся на состоянии: внезапность сравнивает его с пассивной
    // Внимательностью противников в начале боя.
    if js::truthy(check.get("success")) {
        let payload = object(vec![("condition", Some(Value::String("hidden".into()))), ("duration", Some(Value::String("until-next-turn".into()))), ("check_total", check.get("total").cloned())]);
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.actor_targets())));
    }
    r.events.push(a.action_event(vec![("success", check.get("success").cloned().unwrap_or(Value::String(js::UNDEFINED.into())))]).strip_marker());
    Ok(())
}

/// Проверка Медицины с целью (`stabilize`, `first-aid`).
fn medicine_check(r: &mut Resolve<'_>, a: &Act, purpose: &str) -> Result<Value, Halt> {
    let modifier = ability_of(a.actor(), "wis") + skill_proficiency_bonus(a.actor(), "medicine", Some(&a.state));
    let check_options = options(vec![
        ("modifier", Value::from(modifier)),
        ("difficulty", Value::from(10)),
        ("purpose", Value::String(purpose.into())),
        ("actorId", undef(a.command.get("actor_id"))),
        ("visibility", a.raw_visibility()),
    ]);
    let check = a.check(r, "wis", check_options, D20Method::RollCheck)?;
    r.rolls.push(check.clone());
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String("wis".into()));
    payload.insert("skill".into(), Value::String("medicine".into()));
    for (key, value) in spread_value(Some(&check)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&a.target_targets())));
    Ok(check)
}

/// Стабилизировать (16246–16261).
fn stabilize(r: &mut Resolve<'_>, a: &Act) -> Step {
    if !crate::targets::is_unstable_dying_hero(&a.state, &a.target_key) {
        return Err(rule("Стабилизация нужна только союзнику с 0 ОЗ, который ещё делает спасброски от смерти", "STABILIZATION_NOT_REQUIRED"));
    }
    let check = medicine_check(r, a, "stabilize:medicine")?;
    if js::truthy(check.get("success")) {
        let hero = player_actor(&a.state, Some(&a.target));
        let name = coalesce(&[at(hero, "character"), at(hero, "name")]).cloned().unwrap_or_else(|| a.target.clone());
        let payload = object(vec![
            ("hero_name", Some(Value::String(js::string(Some(&name))))),
            ("method", Some(Value::String("medicine-check".into()))),
            ("difficulty", Some(Value::from(10))),
            ("check_total", check.get("total").cloned()),
        ]);
        r.events.push(event_from(&a.rules(&[rule_ids::ZERO_HP]), "HeroStabilized", Some(payload), Some(&a.target_targets())));
    }
    r.events.push(a.action_event(vec![("success", check.get("success").cloned().unwrap_or(Value::String(js::UNDEFINED.into()))), ("difficulty", Value::from(10))]).strip_marker());
    Ok(())
}

/// Первая помощь (16262–16279).
fn first_aid(r: &mut Resolve<'_>, a: &Act) -> Step {
    let rest = sk_core::game::mechanics(&a.state).get("resting").and_then(|all| all.get(&a.target_key));
    if at(rest, "reason").and_then(Value::as_str) != Some("knockout") || !condition_ids_for(&a.state, &a.target_key).contains("unconscious") {
        return Err(rule("Первая помощь нужна только нокаутированному существу", "FIRST_AID_NOT_REQUIRED"));
    }
    let check = medicine_check(r, a, "first-aid:medicine")?;
    if js::truthy(check.get("success")) {
        let payload = object(vec![("reason", Some(Value::String("first-aid".into()))), ("difficulty", Some(Value::from(10))), ("check_total", check.get("total").cloned())]);
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS, rule_ids::RESOURCE]), "KnockoutEnded", Some(payload), Some(&a.target_targets())));
    }
    r.events.push(a.action_event(vec![("success", check.get("success").cloned().unwrap_or(Value::String(js::UNDEFINED.into()))), ("difficulty", Value::from(10))]).strip_marker());
    Ok(())
}

/// Дыхание драконорождённого (16280–16340).
fn species_breath(r: &mut Resolve<'_>, a: &Act) -> Step {
    let Some(position) = sk_core::game::actor_position(&a.state, &a.target_key) else {
        return Err(rule("Цель дыхания должна находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    let distance = max_f(5.0, safe_or(a.effect_field("distanceFeet"), js::number(a.action.get("range"))));
    let shape = if a.effect_field("shape").and_then(Value::as_str) == Some("line") { "line" } else { "cone" };
    let pseudo = json!({ "target": "point", "kind": "area-save", "radius": js::num(distance), "areaShape": shape, "areaOrigin": "self", "maxTargets": 100, "level": 0 });
    let breath_command = command_with(&a.command, "to", json!({ "x": position.x, "y": position.y }));
    let affected = crate::areas::shape::spell_targets_at(&a.state, &breath_command, &pseudo);
    let ids: Vec<String> = affected.iter().map(sk_core::game::actor_id).collect();
    let level = js::safe_int(at(a.actor(), "level"), 1).max(1);
    let dice = if level >= 11 {
        "4d6"
    } else if level >= 6 {
        "3d6"
    } else {
        "2d6"
    };
    let damage_roll = a.roll(r, Value::String(dice.into()), "species:breath-weapon")?;
    r.rolls.push(damage_roll.clone());
    let damage_type = a.effect_field("damageType").cloned();
    let mut rolled = vec![("species_trait", Value::String("breath-weapon".into()))];
    if let Some(damage_type) = &damage_type {
        rolled.push(("damage_type", damage_type.clone()));
    }
    r.events.push(a.die_rolled(&damage_roll, rolled));
    let difficulty = 8 + js::safe_int(at(a.actor(), "proficiency"), 0).max(0) + ability_of(a.actor(), "con");
    a.spend(r)?;
    let ancestry = coalesce(&[at(at(at(at(a.actor(), "speciesBenefits"), "mechanics"), "dragon_ancestry"), "id")]).cloned().unwrap_or(Value::Null);
    let payload = object(vec![
        ("ancestry_id", Some(ancestry)),
        ("shape", Some(Value::String(shape.into()))),
        ("distance_feet", Some(js::num(distance))),
        ("damage_type", damage_type.clone()),
        ("damage_expression", Some(Value::String(dice.into()))),
        ("difficulty", Some(Value::from(difficulty))),
        ("target_ids", Some(js::strings_value(ids.clone()))),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW, rule_ids::DAMAGE]), "SpeciesBreathUsed", Some(payload), Some(&js::strings_value(ids.clone()))));
    let mut breath_state = a.state.clone();
    let ability = js::string(coalesce(&[a.effect_field("saveAbility")]).or(Some(&Value::String("dex".into()))));
    let damage_kind = Value::String(js::string(coalesce(&[a.effect_field("damageType")]).or(Some(&Value::String("fire".into())))));
    for target in &affected {
        let caught = sk_core::game::actor_id(target);
        let save_options = options(vec![
            ("ability", Value::String(ability.clone())),
            ("modifier", Value::from(ability_of(Some(target), &ability))),
            ("purpose", Value::String(format!("species_breath_save:{ability}"))),
            ("visibility", a.raw_visibility()),
        ]);
        let save = r.roll_saving_throw(&breath_state, Some(&Value::String(caught.clone())), &save_options)?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), difficulty as f64);
        let mut payload = spread_value(Some(&save));
        payload.insert("ability".into(), Value::String(ability.clone()));
        payload.insert("difficulty".into(), Value::from(difficulty));
        payload.insert("saved".into(), Value::Bool(saved));
        payload.insert("success".into(), Value::Bool(saved));
        payload.insert("source".into(), Value::String("species-breath".into()));
        r.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&json!([caught]))));
        let raw = saved_damage_amount(&breath_state, &caught, Some(&Value::String(ability.clone())), saved, true, damage_roll.get("total"));
        let before_state = breath_state.clone();
        let payload = damage_payload(&before_state, &caught, Some(&Value::from(raw)), Some(&damage_kind), None, None)?;
        let resistant = js::truthy(payload.get("resistant"));
        let damage_event = event_from(
            &a.rules(&[rule_ids::DAMAGE, if resistant { rule_ids::RESISTANCE } else { "" }]),
            "DamageApplied",
            Some(spread_with(&payload, vec![("species_trait", Value::String("breath-weapon".into())), ("saved", Value::Bool(saved))])),
            Some(&json!([caught])),
        );
        r.events.push(damage_event.clone());
        breath_state = crate::replay::apply_game_event(&breath_state, &damage_event)?;
        if hp_after_zero(&payload) {
            r.events.extend(zero_hit_point_damage_consequences(&before_state, &a.command, &caught, &payload, false));
        }
    }
    r.events.push(a.action_event(vec![("affected", js::strings_value(ids)), ("damage", damage_roll.get("total").cloned().unwrap_or(Value::Null)), ("difficulty", Value::from(difficulty))]));
    Ok(())
}

/// Толчок (16341–16377): сбить с ног или оттолкнуть на 5 футов.
fn shove(r: &mut Resolve<'_>, a: &Act) -> Step {
    let mode = match coalesce(&[a.command.get("shove_mode")]) {
        Some(mode) => js::string(Some(mode)),
        None => "prone".into(),
    };
    if mode != "prone" && mode != "push" {
        return Err(rule("Толчок либо сбивает с ног, либо отталкивает", "SHOVE_MODE_UNKNOWN"));
    }
    let target_actor = sk_core::game::find_actor(&a.state, &a.target_key);
    if crate::tactical_geometry::creature_size_rank(target_actor) > crate::tactical_geometry::creature_size_rank(a.actor()) + 1 {
        return Err(rule("Цель слишком велика: толкнуть можно существо не больше чем на один размер крупнее вас", "SHOVE_TARGET_TOO_LARGE"));
    }
    let state = a.state.clone();
    let contest = grapple_contest(&state, &mut r.dice, &a.command, &a.target_key, &mut r.rolls)?;
    let success = js::truthy(contest.get("success"));
    let success_value = contest.get("success").cloned();
    let push = mode == "push";
    let payload = if push { spread_with(&contest, vec![("shove_mode", Value::String("push".into()))]) } else { contest.clone() };
    r.events.push(event_from(&a.command, "ContestedCheckResolved", Some(payload), Some(&a.target_targets())));
    if success && !push {
        let duration = if a.uses_2014() { Value::Null } else { Value::String("until-next-turn".into()) };
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": "prone", "duration": duration })), Some(&a.target_targets())));
    }
    // Тот же путь, что у отталкивающих заклинаний; атак по возможности
    // вынужденное перемещение не вызывает. Расход действия — раньше движения.
    let path = if success && push { crate::geometry::forced::forced_push_path(&state, &a.target_key, actor_point(&state, &a.actor_id), 5.0) } else { Vec::new() };
    let success_field = success_value.unwrap_or(Value::String(js::UNDEFINED.into()));
    let extra = if push {
        vec![("success", success_field), ("shove_mode", Value::String("push".into())), ("pushed_feet", Value::from(path.len() as i64 * 5))]
    } else {
        vec![("success", success_field)]
    };
    r.events.push(a.action_event(extra).strip_marker());
    if let Some(last) = path.last().copied() {
        let pushed_from = actor_point(&state, &a.target_key).map(point_json).unwrap_or(Value::Null);
        let speed = crate::speed::effective_speed_feet(&state, sk_core::game::find_actor(&state, &a.target_key).unwrap_or(&Value::Null), &a.target_key);
        let payload = json!({
            "from": pushed_from, "to": point_json(last), "path": points_json(&path), "distance": path.len() as i64 * 5,
            "movement_cost": 0, "movement_spent": 0, "movement_remaining": speed,
            "spend_movement": false, "forced_movement": true, "action_id": "shove", "phase": "combat",
        });
        r.events.push(event_from(&a.rules(&[rule_ids::TURNS]), "ActorMoved", Some(payload), Some(&a.target_targets())));
        let entered = reduce_events(&state, &r.events)?;
        let consequences = r.area_entry_consequences(&entered, &a.target_key, Some(&pushed_from), Some(&point_json(last)), Some("forced-entry"))?;
        r.events.extend(consequences);
    }
    Ok(())
}

/// Лечение броском (`second-wind` по себе, `divine-spark` по цели).
fn heal_self_roll(r: &mut Resolve<'_>, a: &Act, expression: String, purpose: &str, target_id: &str) -> Step {
    let target = sk_core::game::find_actor(&a.state, target_id).cloned();
    let healing_roll = a.roll(r, Value::String(expression.clone()), purpose)?;
    r.rolls.push(healing_roll.clone());
    r.events.push(event_from(&a.command, "DieRolled", Some(healing_roll.clone()), Some(&json!([]))));
    let healing = resolved_healing_roll(&a.state, target_id, Some(&Value::String(expression)), healing_roll.get("total"));
    let before = hp(target.as_ref());
    let amount = js::number(healing.get("amount"));
    let after = js::min_of([max_hp(target.as_ref()) as f64, before as f64 + amount]);
    a.spend(r)?;
    let mut payload = Map::new();
    payload.insert("requested_amount".into(), healing.get("amount").cloned().unwrap_or(Value::Null));
    if healing.get("amount").is_none() {
        payload.shift_remove("requested_amount");
    }
    payload.insert("applied_amount".into(), js::num(after - before as f64));
    payload.insert("hp_before".into(), Value::from(before));
    payload.insert("hp_after".into(), js::num(after));
    for (key, value) in spread_value(Some(&healing)) {
        payload.insert(key, value);
    }
    let targets = if purpose == "second_wind" { a.actor_targets() } else { a.target_targets() };
    r.events.push(event_from(&a.rules(&[rule_ids::HEALING]), "HealingApplied", Some(Value::Object(payload)), Some(&targets)));
    r.events.push(a.action_event(Vec::new()));
    Ok(())
}

/// Приём с атакой и спасброском (`trip-attack`, `menacing-attack`, 16380–16408).
fn maneuver_attack(r: &mut Resolve<'_>, a: &Act) -> Step {
    let mut map = spread_value(Some(&a.rules(&[rule_ids::ATTACK])));
    map.insert("command_type".into(), Value::String("MakeAttack".into()));
    map.insert("target_id".into(), a.target.clone());
    map.insert("target_ids".into(), a.target_targets());
    let input = Value::Object(map);
    let state = a.state.clone();
    let context = r.context.clone();
    let mut result = api::resolve_command(&input, &state, &mut r.dice, &context, &mut *r.uuid)?;
    let attack_index = result.events.iter().position(|event| event.get("event_type").and_then(Value::as_str) == Some("AttackResolved"));
    let attack_event = attack_index.map(|index| result.events[index].clone());
    let hit = js::truthy(at(at(attack_event.as_ref(), "payload"), "hit"));
    if hit {
        a.spend(r)?;
        let critical = js::truthy(at(at(attack_event.as_ref(), "payload"), "critical"));
        let roll = a.roll(r, Value::String(if critical { "2d8" } else { "1d8" }.into()), &format!("maneuver_damage:{}", a.id()))?;
        r.rolls.push(roll.clone());
        result.events.push(event_from(&a.command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        if let Some(index) = damage_event_index(&result.events, &a.target) {
            let event_payload = result.events[index].get("payload").cloned().unwrap_or(Value::Null);
            let resistance = cantrip_resistance(&event_payload);
            let raw = js::safe_int(event_payload.get("raw_amount"), 0) + js::safe_int(roll.get("total"), 0);
            let payload = damage_payload(&state, &a.target_key, Some(&Value::from(raw)), event_payload.get("damage_type"), resistance.as_ref(), None)?;
            let mut fields = vec![("maneuver_id", a.action.get("id").cloned().unwrap_or(Value::Null)), ("superiority_damage", roll.get("total").cloned().unwrap_or(Value::Null))];
            if a.action.get("id").is_none() {
                fields.remove(0);
            }
            result.events[index]["payload"] = spread_with(&payload, fields);
        }
        let ability = if a.id() == "trip-attack" { "str" } else { "wis" };
        let target = sk_core::game::find_actor(&state, &a.target_key).cloned();
        let dc = 8 + js::safe_int(at(a.actor(), "proficiency"), 0).max(0) + ability_of(a.actor(), "str").max(ability_of(a.actor(), "dex"));
        let save_options = options(vec![
            ("ability", Value::String(ability.into())),
            ("modifier", Value::from(ability_of(target.as_ref(), ability))),
            ("purpose", Value::String(format!("maneuver_save:{}", a.id()))),
            ("visibility", a.raw_visibility()),
        ]);
        let save = r.roll_saving_throw(&state, Some(&a.target), &save_options)?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), dc as f64);
        let mut payload = Map::new();
        payload.insert("ability".into(), Value::String(ability.into()));
        payload.insert("difficulty".into(), Value::from(dc));
        payload.insert("saved".into(), Value::Bool(saved));
        for (key, value) in spread_value(Some(&save)) {
            payload.insert(key, value);
        }
        result.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&a.target_targets())));
        if !saved {
            let trip = a.id() == "trip-attack";
            let duration = if a.uses_2014() {
                if trip {
                    Value::Null
                } else {
                    Value::String("source-turns:2".into())
                }
            } else {
                Value::String("until-next-turn".into())
            };
            let condition = if trip { "prone" } else { "frightened" };
            result.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": condition, "duration": duration })), Some(&a.target_targets())));
        }
    }
    r.events.extend(result.events);
    r.events.push(a.action_event(vec![("hit", Value::Bool(hit)), ("economy_consumed_by_attack", Value::Bool(true))]));
    r.rolls.extend(result.rolls);
    Ok(())
}

/// `events.find((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(targetId))`.
fn damage_event_index(events: &[Value], target: &Value) -> Option<usize> {
    events.iter().position(|event| {
        event.get("event_type").and_then(Value::as_str) == Some("DamageApplied")
            && event.get("target_ids").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| crate::validate::common::strict_equal(Some(id), Some(target))))
    })
}

/// Сопротивление заговора, уже учтённое в уроне удара.
fn cantrip_resistance(payload: &Value) -> Option<Value> {
    if !js::truthy(payload.get("resistance_cantrip_reduction")) {
        return None;
    }
    Some(object(vec![
        ("reduction", payload.get("resistance_cantrip_reduction").cloned()),
        ("condition_id", payload.get("resistance_cantrip_condition").cloned()),
        ("turn_key", payload.get("resistance_cantrip_turn").cloned()),
        ("roll_id", payload.get("resistance_cantrip_roll_id").cloned()),
    ]))
}

/// Метка охотника (16409–16419).
fn hunters_mark(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    if let Some(previous) = a.concentration(&a.actor_id) {
        let payload = object(vec![("reason", Some(Value::String("replaced".into()))), ("effect_id", previous.get("effect_id").cloned())]);
        r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&a.actor_targets())));
    }
    let mark = format!("hunters-mark:{}", js::string(a.command.get("actor_id")));
    for candidate in sk_core::game::list_actors(&a.state) {
        let candidate_id = sk_core::game::actor_id(candidate);
        if condition_ids_for(&a.state, &candidate_id).contains(&mark) {
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": mark })), Some(&json!([candidate_id]))));
        }
    }
    let effect_id = format!("hunters-mark:{}", js::string(a.command.get("command_id")));
    r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationStarted", Some(json!({ "effect_id": effect_id })), Some(&a.actor_targets())));
    let payload = object(vec![
        ("condition", Some(Value::String(mark))),
        ("duration", Some(Value::String("concentration".into()))),
        ("source_actor", a.command.get("actor_id").cloned()),
        ("effect_id", Some(Value::String(effect_id))),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.target_targets())));
    r.events.push(a.action_event(Vec::new()));
    Ok(())
}

/// Рывок умения (16433–16436).
fn effect_dash(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    if let Some(condition) = a.effect_field("addCondition").filter(|value| js::truthy(Some(value))) {
        let payload = object(vec![("condition", Some(condition.clone())), ("duration", Some(Value::String("until-next-turn".into()))), ("source_actor", a.command.get("actor_id").cloned())]);
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.actor_targets())));
    }
    let speed = crate::speed::effective_speed_feet(&a.state, a.actor().unwrap_or(&Value::Null), &a.actor_id) as f64;
    let multiplier = match coalesce(&[a.effect_field("multiplier")]) {
        Some(value) => js::number(Some(value)),
        None => 1.0,
    };
    let bonus = (speed * multiplier).floor();
    r.events.push(a.action_event(vec![("movement_bonus", js::num(bonus)), ("dash_count", Value::from(js::safe_int(a.effect_field("multiplier"), 1).max(1))), ("movement_contract_version", Value::from(2))]));
    Ok(())
}

/// Состояние умения (16437–16447).
fn effect_condition(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    let effect_id = format!("{}:{}", js::string(a.action.get("id")), js::string(a.command.get("command_id")));
    if js::truthy(a.action.get("concentration")) {
        if let Some(previous) = a.concentration(&a.actor_id) {
            let payload = object(vec![("reason", Some(Value::String("replaced".into()))), ("effect_id", previous.get("effect_id").cloned())]);
            r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(payload), Some(&a.actor_targets())));
        }
        r.events.push(event_from(&a.rules(&[rule_ids::CONCENTRATION]), "ConcentrationStarted", Some(json!({ "effect_id": effect_id })), Some(&a.actor_targets())));
    }
    let payload = object(vec![
        ("condition", a.effect_field("condition").cloned()),
        ("duration", Some(coalesce(&[a.effect_field("duration")]).cloned().unwrap_or(Value::Null))),
        ("source_actor", a.command.get("actor_id").cloned()),
        ("effect_id", Some(Value::String(effect_id))),
    ]);
    r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.target_targets())));
    r.events.push(a.action_event(Vec::new()));
    Ok(())
}

/// Проверка умения (16448–16457).
fn effect_check(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    let ability = match coalesce(&[a.effect_field("ability")]) {
        Some(ability) => js::string(Some(ability)),
        None => "wis".into(),
    };
    let skill = a.effect_field("skill").cloned();
    let modifier = ability_of(a.actor(), &ability) + skill_proficiency_bonus(a.actor(), &js::s(skill.as_ref()), Some(&a.state));
    let check_options = options(vec![
        ("modifier", Value::from(modifier)),
        ("difficulty", Value::from(js::safe_int(a.effect_field("difficulty"), 12))),
        ("purpose", Value::String(format!("combat_check:{}", js::string(a.action.get("id"))))),
        ("actorId", undef(a.command.get("actor_id"))),
        ("visibility", a.raw_visibility()),
    ]);
    let check = a.check(r, &ability, check_options, D20Method::RollCheck)?;
    r.rolls.push(check.clone());
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String(ability));
    if let Some(skill) = &skill {
        payload.insert("skill".into(), skill.clone());
    }
    for (key, value) in spread_value(Some(&check)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&a.actor_targets())));
    if js::truthy(check.get("success")) && skill.as_ref().and_then(Value::as_str) == Some("stealth") {
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(json!({ "condition": "hidden", "duration": "until-next-turn" })), Some(&a.actor_targets())));
    }
    r.events.push(a.action_event(vec![("success", check.get("success").cloned().unwrap_or(Value::String(js::UNDEFINED.into())))]).strip_marker());
    Ok(())
}

/// Состязание умения (16458–16465).
fn effect_contest(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    let state = a.state.clone();
    let contest = grapple_contest(&state, &mut r.dice, &a.command, &a.target_key, &mut r.rolls)?;
    let success = contest.get("success").cloned();
    r.events.push(event_from(&a.rules(&[rule_ids::ABILITY_CHECK]), "ContestedCheckResolved", Some(contest.clone()), Some(&a.target_targets())));
    if js::truthy(success.as_ref()) {
        let condition = a.effect_field("condition");
        let grappled = condition.and_then(Value::as_str) == Some("grappled");
        let prone_2014 = a.uses_2014() && condition.and_then(Value::as_str) == Some("prone");
        let duration = if grappled || prone_2014 { Value::Null } else { Value::String("until-next-turn".into()) };
        let payload = object(vec![("condition", condition.cloned()), ("duration", Some(duration)), ("source_actor", a.command.get("actor_id").cloned())]);
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.target_targets())));
    }
    r.events.push(a.action_event(vec![("success", success.unwrap_or(Value::String(js::UNDEFINED.into())))]).strip_marker());
    Ok(())
}

/// Лечение умением (16466–16487).
fn effect_heal(r: &mut Resolve<'_>, a: &Act) -> Step {
    let target = sk_core::game::find_actor(&a.state, &a.target_key).cloned();
    let level = js::safe_int(at(a.actor(), "level"), 1).max(1);
    let proficiency = js::safe_int(at(a.actor(), "proficiency"), 0).max(0);
    let ability = a.effect_field("ability").filter(|value| js::truthy(Some(value)));
    let bonus = (if js::truthy(a.effect_field("addLevel")) { level } else { 0 })
        + (if js::truthy(a.effect_field("addProficiency")) { proficiency } else { 0 })
        + ability.map(|ability| ability_of(a.actor(), &js::string(Some(ability)))).unwrap_or(0);
    let mut amount = (js::safe_int(a.effect_field("amount"), 0) + if js::truthy(a.effect_field("fromPool")) { 0 } else { bonus }).max(0) as f64;
    let mut healing = json!({ "amount": js::num(amount) });
    if let Some(dice) = a.effect_field("dice").filter(|value| js::truthy(Some(value))) {
        let expression = dice_expression(Some(dice), Some(&Value::from(bonus)), 8)?;
        let healing_roll = a.roll(r, Value::String(expression.clone()), &format!("action_healing:{}", js::string(a.action.get("id"))))?;
        r.rolls.push(healing_roll.clone());
        r.events.push(event_from(&a.command, "DieRolled", Some(healing_roll.clone()), Some(&json!([]))));
        healing = resolved_healing_roll(&a.state, &a.target_key, Some(&Value::String(expression)), healing_roll.get("total"));
        amount = js::number(healing.get("amount"));
    }
    let before = hp(target.as_ref());
    let after = js::min_of([max_hp(target.as_ref()) as f64, before as f64 + amount]);
    a.spend(r)?;
    let mut payload = Map::new();
    payload.insert("requested_amount".into(), js::num(amount));
    payload.insert("applied_amount".into(), js::num(after - before as f64));
    payload.insert("hp_before".into(), Value::from(before));
    payload.insert("hp_after".into(), js::num(after));
    for (key, value) in spread_value(Some(&healing)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::HEALING]), "HealingApplied", Some(Value::Object(payload)), Some(&a.target_targets())));
    r.events.push(a.action_event(Vec::new()));
    Ok(())
}

/// Удар оружием с надбавкой (16488–16571).
fn weapon_attack(r: &mut Resolve<'_>, a: &Act) -> Step {
    // Кость превосходства, кара и Ошеломляющий удар тратятся, когда удар
    // попал; прочие удары с запасом платят заранее.
    let spend_on_hit = a.action.get("resource").and_then(Value::as_str) == Some("superiority_dice") || js::is_true(a.effect_field("divineSmite")) || a.id() == "stunning-strike";
    if !spend_on_hit {
        a.spend(r)?;
    }
    let mut resource_spent = !spend_on_hit;
    let level = js::safe_int(at(a.actor(), "level"), 1).max(1);
    let mut tiers: Vec<(String, Value)> = match coalesce(&[a.effect_field("attacksByLevel")]) {
        Some(value) => crate::pause::object_entries(Some(value)),
        None => Vec::new(),
    };
    {
        let mut indices: Vec<usize> = (0..tiers.len()).collect();
        let keys: Vec<f64> = tiers.iter().map(|(key, _)| js::number(Some(&Value::String(key.clone())))).collect();
        sk_core::v8sort::sort_by(&mut indices, |left, right| keys[*right] - keys[*left]);
        tiers = indices.into_iter().map(|index| tiers[index].clone()).collect();
    }
    let tier = tiers.into_iter().find(|(minimum, _)| level as f64 >= js::number(Some(&Value::String(minimum.clone()))));
    let attacks_source = match &tier {
        Some((_, value)) if js::present(Some(value)) => Some(value.clone()),
        _ => a.effect_field("attacks").cloned(),
    };
    let attacks = js::safe_int(attacks_source.as_ref(), 1).max(1);
    let monk_bonus = js::is_true(a.effect_field("unarmed")) && MONK_BONUS_UNARMED_ACTION_IDS.contains(&a.id());
    let mut nested = r.context.clone();
    nested.loading_action_type = a.action.get("actionType").cloned();
    if monk_bonus {
        nested.monk_bonus_attack = true;
    }
    if js::is_true(a.effect_field("divineSmite")) {
        nested.divine_smite = Some(json!({ "slot_level": js::safe_int(a.action.get("smite_slot_level"), 1).max(1) }));
    }
    if js::is_true(a.effect_field("offHand")) {
        nested.offhand_attack = true;
    }
    let parent_pays = a.action.get("actionType").and_then(Value::as_str) != Some("action");
    let mut working = a.state.clone();
    let mut landed = false;
    for index in 0..attacks {
        if !living(sk_core::game::find_actor(&working, &a.target_key)) {
            break;
        }
        let mut map = spread_value(Some(&a.rules(&[rule_ids::ATTACK])));
        map.insert("command_id".into(), Value::String(format!("{}:attack:{}", js::string(a.command.get("command_id")), index + 1)));
        match working.get("state_version") {
            Some(version) => {
                map.insert("expected_state_version".into(), version.clone());
            }
            None => {
                map.shift_remove("expected_state_version");
            }
        }
        map.insert("command_type".into(), Value::String("MakeAttack".into()));
        map.insert("target_id".into(), a.target.clone());
        map.insert("target_ids".into(), a.target_targets());
        match a.command.get("item_id").filter(|_| !js::truthy(a.effect_field("unarmed"))) {
            Some(item) => {
                map.insert("item_id".into(), item.clone());
            }
            None => {
                map.shift_remove("item_id");
            }
        }
        let input = Value::Object(map);
        let mut result = api::resolve_command(&input, &working, &mut r.dice, &nested, &mut *r.uuid)?;
        let attack_index = result.events.iter().position(|event| event.get("event_type").and_then(Value::as_str) == Some("AttackResolved"));
        let attack_event = attack_index.map(|index| result.events[index].clone());
        let hit = js::truthy(at(at(attack_event.as_ref(), "payload"), "hit"));
        landed = landed || hit;
        if hit && !resource_spent {
            let spent = r.events.len();
            a.spend(r)?;
            let moved: Vec<Value> = r.events.drain(spent..).collect();
            let at_index = attack_index.map(|index| index + 1).unwrap_or(0);
            for (offset, event) in moved.into_iter().enumerate() {
                result.events.insert(at_index + offset, event);
            }
            resource_spent = true;
        }
        if hit {
            let mut extra_expression = a.effect_field("extraDamage").cloned();
            if a.effect_field("extraDamageByLevel").and_then(Value::as_str) == Some("sneak") {
                extra_expression = Some(Value::String(format!("{}d6", (level as f64 / 2.0).ceil() as i64)));
            }
            if let Some(expression) = extra_expression.filter(|value| js::truthy(Some(value))) {
                let critical = js::truthy(at(at(attack_event.as_ref(), "payload"), "critical"));
                let text = js::string(Some(&expression));
                let rolled = if critical { Value::String(crate::combat::weapons::critical_damage_expression(&text)?) } else { expression.clone() };
                let extra_roll = a.roll(r, rolled, &format!("action_damage:{}", js::string(a.action.get("id"))))?;
                r.rolls.push(extra_roll.clone());
                result.events.push(event_from(&a.command, "DieRolled", Some(extra_roll.clone()), Some(&json!([]))));
                if let Some(damage_index) = damage_event_index(&result.events, &a.target) {
                    let event_payload = result.events[damage_index].get("payload").cloned().unwrap_or(Value::Null);
                    let resistance = cantrip_resistance(&event_payload);
                    let raw = js::safe_int(event_payload.get("raw_amount"), 0) + js::safe_int(extra_roll.get("total"), 0);
                    let damage_type = coalesce(&[a.effect_field("damageType")]).or_else(|| event_payload.get("damage_type")).cloned();
                    let payload = damage_payload(&working, &a.target_key, Some(&Value::from(raw)), damage_type.as_ref(), resistance.as_ref(), None)?;
                    let mut fields = Vec::new();
                    if let Some(id) = a.action.get("id") {
                        fields.push(("action_id", id.clone()));
                    }
                    fields.push(("extra_damage", extra_roll.get("total").cloned().unwrap_or(Value::Null)));
                    result.events[damage_index]["payload"] = spread_with(&payload, fields);
                }
            }
            let condition = a.effect_field("condition").filter(|value| js::truthy(Some(value))).cloned();
            if let (Some(save_ability), Some(condition)) = (a.effect_field("saveAbility").filter(|value| js::truthy(Some(value))).cloned(), condition.clone()) {
                let target = sk_core::game::find_actor(&working, &a.target_key).cloned();
                let save_name = js::string(Some(&save_ability));
                // СЛ ци монаха — по Мудрости; прочие приёмы — по Силе или Ловкости.
                let dc_bonus = match a.effect_field("saveDcAbility").filter(|value| js::truthy(Some(value))) {
                    Some(ability) => ability_of(a.actor(), &js::string(Some(ability))),
                    None => ability_of(a.actor(), "str").max(ability_of(a.actor(), "dex")),
                };
                let dc = 8 + js::safe_int(at(a.actor(), "proficiency"), 0).max(0) + dc_bonus;
                let poisoned = if condition.as_str() == Some("poisoned") { Value::String("poisoned".into()) } else { Value::Null };
                let save_options = options(vec![
                    ("ability", save_ability.clone()),
                    ("modifier", Value::from(ability_of(target.as_ref(), &save_name))),
                    ("purpose", Value::String(format!("action_save:{}", js::string(a.action.get("id"))))),
                    ("avoid_or_end_condition", poisoned),
                    ("visibility", a.raw_visibility()),
                ]);
                let save = r.roll_saving_throw(&working, Some(&a.target), &save_options)?;
                r.rolls.push(save.clone());
                let saved = saving_throw_succeeded(Some(&save), dc as f64);
                let mut payload = Map::new();
                payload.insert("ability".into(), save_ability.clone());
                payload.insert("difficulty".into(), Value::from(dc));
                payload.insert("saved".into(), Value::Bool(saved));
                for (key, value) in spread_value(Some(&save)) {
                    payload.insert(key, value);
                }
                result.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&a.target_targets())));
                if !saved {
                    let duration = if a.effect_field("conditionDuration").and_then(Value::as_str) == Some("none") { Value::Null } else { Value::String("until-next-turn".into()) };
                    let payload = object(vec![("condition", Some(condition)), ("duration", Some(duration)), ("source_actor", a.command.get("actor_id").cloned())]);
                    result.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.target_targets())));
                }
            } else if let Some(condition) = condition {
                let payload = object(vec![("condition", Some(condition)), ("duration", Some(Value::String("until-next-turn".into()))), ("source_actor", a.command.get("actor_id").cloned())]);
                result.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.target_targets())));
            }
        }
        r.events.extend(result.events.iter().cloned());
        r.rolls.extend(result.rolls);
        working = crate::replay::replay_events(&working, &result.events)?;
        if !monk_bonus {
            if let Some(economy) = sk_core::game::combat_mut(&mut working).get_mut("action_economy").and_then(|all| all.get_mut(&a.actor_id)).filter(|economy| js::truthy(Some(economy))) {
                if let Some(map) = economy.as_object_mut() {
                    map.insert("action".into(), Value::Bool(true));
                }
            }
        }
    }
    let mut extra = vec![("hit", Value::Bool(landed)), ("attacks", Value::from(attacks))];
    if !(parent_pays || monk_bonus) {
        extra.push(("economy_consumed_by_attack", Value::Bool(true)));
    }
    r.events.push(a.action_event(extra));
    Ok(())
}

/// Дикий облик (16572–16585).
fn wild_shape(r: &mut Resolve<'_>, a: &Act) -> Step {
    let revert = js::truthy(a.action.get("revert"));
    if revert {
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ShapeReverted", Some(json!({ "reason": "dismissed", "excess_damage": 0, "wild_shape": true })), Some(&a.actor_targets())));
    } else {
        a.spend(r)?;
        let form = a.action.get("wild_shape_form");
        let Some(form) = form.filter(|form| !form.is_null()) else {
            return Err(Fault::type_error(format!("Cannot read properties of {} (reading 'size')", if form.is_some() { "null" } else { "undefined" })).into());
        };
        let footprint = sk_geometry::actor_footprint::footprint_metadata_for_size(at(Some(form), "size")).to_value();
        let shaped = spread_with(form, vec![("wild_shape", Value::Bool(true)), ("footprint", footprint)]);
        r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ShapeChanged", Some(json!({ "spell_id": null, "wild_shape": true, "form": shaped })), Some(&a.actor_targets())));
    }
    let shape = if revert { Some(Value::String("reverted".into())) } else { at(a.action.get("wild_shape_form"), "id").cloned() };
    let extra = shape.map(|shape| vec![("wild_shape", shape)]).unwrap_or_default();
    r.events.push(a.action_event(extra));
    Ok(())
}

/// Целебный облик (16586–16596).
fn wild_shape_heal(r: &mut Resolve<'_>, a: &Act) -> Step {
    a.spend(r)?;
    let slot = js::safe_int(a.action.get("heal_slot_level"), 1).max(1);
    let healing_roll = a.roll(r, Value::String(format!("{slot}d8")), "wild_shape_heal")?;
    r.rolls.push(healing_roll.clone());
    r.events.push(event_from(&a.command, "DieRolled", Some(healing_roll.clone()), Some(&json!([]))));
    let before = hp(a.actor());
    let total = js::number(healing_roll.get("total"));
    let after = js::min_of([max_hp(a.actor()) as f64, before as f64 + total]);
    let payload = json!({ "requested_amount": healing_roll.get("total").cloned().unwrap_or(Value::Null), "applied_amount": js::num(after - before as f64), "hp_before": before, "hp_after": js::num(after) });
    r.events.push(event_from(&a.rules(&[rule_ids::HEALING]), "HealingApplied", Some(payload), Some(&a.actor_targets())));
    r.events.push(a.action_event(Vec::new()));
    Ok(())
}

/// Изгнание нежити (16597–16637).
fn turn_undead(r: &mut Resolve<'_>, a: &Act) -> Step {
    let dc = 8 + js::safe_int(at(a.actor(), "proficiency"), 0).max(0) + ability_of(a.actor(), "wis");
    let level = js::safe_int(at(a.actor(), "level"), 1).max(1);
    let destroy_up_to = if level >= 17 {
        4.0
    } else if level >= 14 {
        3.0
    } else if level >= 11 {
        2.0
    } else if level >= 8 {
        1.0
    } else if level >= 5 {
        0.5
    } else {
        -1.0
    };
    let radius = js::safe_int(a.effect_field("radius"), 30).max(5) as f64;
    a.spend(r)?;
    let mut working = a.state.clone();
    let mut turned: Vec<String> = Vec::new();
    let actor_enemy = sk_core::game::is_enemy_actor(&a.state, &a.actor_id);
    for candidate in sk_core::game::list_actors(&a.state) {
        let candidate_id = sk_core::game::actor_id(candidate);
        if !sk_core::game::is_living_actor(candidate) || sk_core::game::is_enemy_actor(&a.state, &candidate_id) == actor_enemy {
            continue;
        }
        if crate::spells::slots::creature_type_for(Some(candidate)) != "undead" {
            continue;
        }
        let distance = crate::targets::distance_between_actors(&a.state, &a.actor_id, &candidate_id);
        if distance.is_none_or(|distance| distance > radius) {
            continue;
        }
        let save_options = options(vec![
            ("ability", Value::String("wis".into())),
            ("modifier", Value::from(ability_of(Some(candidate), "wis"))),
            ("purpose", Value::String("action_save:turn-undead".into())),
            ("visibility", a.raw_visibility()),
        ]);
        let save = r.roll_saving_throw(&working, Some(&Value::String(candidate_id.clone())), &save_options)?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), dc as f64);
        let mut payload = Map::new();
        payload.insert("ability".into(), Value::String("wis".into()));
        payload.insert("difficulty".into(), Value::from(dc));
        payload.insert("saved".into(), Value::Bool(saved));
        for (key, value) in spread_value(Some(&save)) {
            payload.insert(key, value);
        }
        if let Some(id) = a.action.get("id") {
            payload.insert("action_id".into(), id.clone());
        }
        r.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&json!([candidate_id]))));
        if saved {
            continue;
        }
        if challenge_rating_value(Some(candidate)) <= destroy_up_to {
            let raw = sk_core::game::actor_hp(candidate).max(1) * 2;
            let payload = r.resolve_damage_payload(&working, &candidate_id, Value::from(raw), &Value::String("radiant".into()), None, None)?;
            let damage_event = event_from(
                &a.rules(&[rule_ids::DAMAGE]),
                "DamageApplied",
                Some(spread_with(&payload, vec![("action_id", Value::String("destroy-undead".into())), ("destroy_undead", Value::Bool(true))])),
                Some(&json!([candidate_id])),
            );
            r.events.push(damage_event.clone());
            let consequences = zero_hit_point_damage_consequences(&working, &a.command, &candidate_id, &payload, false);
            r.events.extend(consequences.iter().cloned());
            let mut applied = vec![damage_event];
            applied.extend(consequences);
            working = reduce_events(&working, &applied)?;
            turned.push(candidate_id);
            continue;
        }
        let duration = coalesce(&[a.effect_field("duration")]).cloned().unwrap_or_else(|| Value::String("rounds:10".into()));
        let payload = object(vec![
            ("condition", Some(Value::String("turned".into()))),
            ("duration", Some(duration)),
            ("source_actor", a.command.get("actor_id").cloned()),
            ("break_on_any_damage", Some(Value::Bool(true))),
        ]);
        let condition = event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&json!([candidate_id])));
        r.events.push(condition.clone());
        working = crate::replay::apply_game_event(&working, &condition)?;
        turned.push(candidate_id);
    }
    r.events.push(a.action_event(vec![("success", Value::Bool(!turned.is_empty())), ("affected_ids", js::strings_value(turned))]));
    Ok(())
}

/// Спасбросок против умения (16638–16649).
fn effect_save(r: &mut Resolve<'_>, a: &Act) -> Step {
    let target = sk_core::game::find_actor(&a.state, &a.target_key).cloned();
    let ability = match coalesce(&[a.effect_field("saveAbility")]) {
        Some(ability) => js::string(Some(ability)),
        None => "wis".into(),
    };
    let dc = 8 + js::safe_int(at(a.actor(), "proficiency"), 0).max(0) + ability_of(a.actor(), "wis").max(ability_of(a.actor(), "cha"));
    let poisoned = if a.effect_field("condition").and_then(Value::as_str) == Some("poisoned") { Value::String("poisoned".into()) } else { Value::Null };
    let save_options = options(vec![
        ("ability", Value::String(ability.clone())),
        ("modifier", Value::from(ability_of(target.as_ref(), &ability))),
        ("purpose", Value::String(format!("action_save:{}", js::string(a.action.get("id"))))),
        ("avoid_or_end_condition", poisoned),
        ("visibility", a.raw_visibility()),
    ]);
    let state = a.state.clone();
    let save = r.roll_saving_throw(&state, Some(&a.target), &save_options)?;
    r.rolls.push(save.clone());
    let saved = saving_throw_succeeded(Some(&save), dc as f64);
    a.spend(r)?;
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String(ability));
    payload.insert("difficulty".into(), Value::from(dc));
    payload.insert("saved".into(), Value::Bool(saved));
    for (key, value) in spread_value(Some(&save)) {
        payload.insert(key, value);
    }
    r.events.push(event_from(&a.rules(&[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&a.target_targets())));
    if !saved {
        if let Some(condition) = a.effect_field("condition").filter(|value| js::truthy(Some(value))) {
            let duration = coalesce(&[a.effect_field("duration")]).cloned().unwrap_or_else(|| Value::String("until-next-turn".into()));
            let payload = object(vec![("condition", Some(condition.clone())), ("duration", Some(duration)), ("source_actor", a.command.get("actor_id").cloned())]);
            r.events.push(event_from(&a.rules(&[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&a.target_targets())));
        }
    }
    r.events.push(a.action_event(vec![("success", Value::Bool(!saved))]));
    Ok(())
}
