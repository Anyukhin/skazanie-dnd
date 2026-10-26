//! Ветки `resolveCommandInternal`: заявка действия, проверка характеристики,
//! спасбросок, урон и лечение по команде, временные хиты, предпочтения бонуса
//! и реакций, решение ведущего, неизвестный тип (`default`). Задача Р5.
//!
//! JS: `server/rules-engine.mjs`, 13725–13727, 13728–13820, 13821–13878,
//! 15173–15179, 15180–15188, 15238–15243, 15336–15341, 15342–15362,
//! 23150–23152, 23153–23154. Диспетчер — `resolve/dispatch.rs` (Р0); ветка
//! дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::kernel::undef;
use super::Resolve;
use crate::checks::saves::{check_roll_from_verified, roll_d20_with_species_luck, D20Method};
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with_rules, condition_ids_for, event_from, spread_value};
use crate::pause::{rule, Step};
use crate::spells::enervation::remove_silvery_fortune_event;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `[command.actor_id]`.
fn actor_targets(command: &Value) -> Value {
    json!([command.get("actor_id").cloned().unwrap_or(Value::Null)])
}

/// `Number.isSafeInteger(Number(command.modifier))`.
fn supplied_modifier(command: &Value) -> Option<f64> {
    let value = command.get("modifier");
    js::is_safe_integer_number(value).then(|| js::number(value))
}

/// `DeclareAction` (13725–13727).
pub fn declare_action(r: &mut Resolve<'_>) -> Step {
    let action = r.command.get("action").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_default();
    let event = event_from(&r.command, "ActionDeclared", Some(json!({ "action": crate::core::slice_utf16(&action, 1000) })), Some(&json!([])));
    r.events.push(event);
    Ok(())
}

/// `MakeAbilityCheck` (13728–13820).
pub fn make_ability_check(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let actor_id_value = command.get("actor_id");
    let actor_id = js::s(actor_id_value);
    let actor = sk_core::game::find_actor(&state, &actor_id);
    let skill = crate::checks::skills::canonical_skill_id(command.get("skill"));
    let skill_value = Value::String(skill.clone());
    let ability_source = sk_ruleset::character_progression::skill_ability(Some(&skill_value))
        .filter(|value| js::truthy(Some(value)))
        .or_else(|| command.get("ability").filter(|value| js::truthy(Some(value))).cloned())
        .unwrap_or_else(|| Value::String("str".into()));
    let ability = js::string(Some(&ability_source)).to_lowercase();
    let ability_value = Value::String(ability.clone());
    let proficiency = if skill.is_empty() { None } else { Some(crate::checks::skills::skill_proficiency_for_actor(actor, Some(&skill_value), Some(&state))) };
    let tavern_bonus = sk_npc_world::tavern_life::tavern_social_bonus(&state, actor_id_value.unwrap_or(&Value::Null), Some(&skill_value));
    let mut modifier = match supplied_modifier(&command) {
        Some(value) => value,
        None => {
            let proficiency_bonus = match proficiency.as_ref().and_then(|entry| entry.get("bonus")).filter(|value| !value.is_null()) {
                Some(bonus) => js::number(Some(bonus)),
                None if js::truthy(command.get("proficient")) => js::safe_int(at(actor, "proficiency"), 0) as f64,
                None => 0.0,
            };
            ability_modifier(at(at(actor, "abilities"), &ability)) as f64 + proficiency_bonus + tavern_bonus as f64
        }
    };
    let conditions = condition_ids_for(&state, &actor_id);
    if conditions.contains("guidance-d4") {
        let visibility = r.visibility();
        let guidance = r.roll_dice(Value::String("1d4".into()), "spell:guidance", actor_id_value.cloned().unwrap_or(Value::Null), visibility)?;
        r.rolls.push(guidance.clone());
        r.events.push(event_from(&command, "DieRolled", Some(guidance.clone()), Some(&json!([]))));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": "guidance-d4" })), Some(&actor_targets(&command))));
        modifier += js::number(guidance.get("total"));
    }
    let silvery_fortune = conditions.contains("silvery-fortune");
    let check_penalty = crate::checks::saves::check_disadvantage_condition_for(&state, &actor_id, Some(&ability_value));
    let check_boost = crate::conditions::check_advantage_condition_for(&state, &actor_id, Some(&ability_value));
    let armor_stealth_penalty = skill == "stealth" && crate::core::armor_stealth_disadvantage(actor);
    let weather = crate::checks::saves::weather_check_swing_for(&state, Some(&skill_value), actor_id_value);
    let weather_reason = |swing: &str| weather.as_ref().filter(|entry| entry.get("swing").and_then(Value::as_str) == Some(swing)).and_then(|entry| entry.get("reason")).filter(|value| !value.is_null()).cloned();
    let weather_penalty = weather_reason("disadvantage");
    let weather_boost = weather_reason("advantage");
    let beast_watch = sk_npc_world::beast_taming::beast_watch_swing(&state, Some(&skill_value), actor_id_value).and_then(|swing| swing.get("reason").filter(|value| !value.is_null()).cloned());
    let difficulty = js::safe_int(command.get("difficulty"), 10);
    let mut options = Map::new();
    options.insert("modifier".into(), js::num(modifier));
    options.insert("difficulty".into(), Value::from(difficulty));
    options.insert("purpose".into(), Value::String(format!("ability_check:{ability}")));
    options.insert("actorId".into(), undef(actor_id_value));
    let truthy = |value: &Option<Value>| js::truthy(value.as_ref());
    let advantage = js::truthy(command.get("advantage")) || silvery_fortune || check_boost.is_some() || truthy(&weather_boost) || truthy(&beast_watch);
    let disadvantage = js::truthy(command.get("disadvantage")) || check_penalty.is_some() || armor_stealth_penalty || truthy(&weather_penalty);
    options.insert("advantage".into(), Value::Bool(advantage));
    options.insert("disadvantage".into(), Value::Bool(disadvantage));
    options.insert("visibility".into(), undef(command.get("visibility")));
    let options = Value::Object(options);
    let mut roll = match check_roll_from_verified(command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => roll_d20_with_species_luck(&state, &mut r.dice, &actor_id, &options, D20Method::RollCheck)?,
    };
    if js::is_false(roll.get("success")) {
        let boost = r.spend_bardic_inspiration(&state, actor_id_value, "ability-check")?;
        if boost != 0 {
            let total = js::safe_int(roll.get("total"), 0) + boost;
            let mut map = spread_value(Some(&roll));
            map.insert("total".into(), Value::from(total));
            map.insert("success".into(), Value::Bool(total >= js::safe_int(options.get("difficulty"), 10)));
            map.insert("bardic_inspiration".into(), Value::from(boost));
            roll = Value::Object(map);
        }
    }
    r.rolls.push(roll.clone());
    let advantage_rule = js::truthy(command.get("advantage"))
        || js::truthy(command.get("disadvantage"))
        || check_penalty.is_some()
        || check_boost.is_some()
        || truthy(&weather_penalty)
        || truthy(&weather_boost)
        || truthy(&beast_watch);
    let source = command_with_rules(&command, &[if advantage_rule { rule_ids::ADVANTAGE } else { "" }]);
    let mut payload = Map::new();
    payload.insert("ability".into(), ability_value);
    if !skill.is_empty() {
        payload.insert("skill".into(), skill_value);
    }
    for (key, value) in spread_value(Some(&roll)) {
        payload.insert(key, value);
    }
    if let Some(proficiency) = &proficiency {
        for (key, field) in [("proficient", "proficient"), ("expertise", "expertise"), ("proficiency_bonus", "bonus")] {
            if let Some(value) = proficiency.get(field) {
                payload.insert(key.into(), value.clone());
            }
        }
    }
    if let Some(penalty) = &check_penalty {
        payload.insert("check_disadvantage_condition".into(), Value::String(penalty.clone()));
    }
    if armor_stealth_penalty {
        payload.insert("armor_stealth_disadvantage".into(), Value::Bool(true));
    }
    if let Some(boost) = &check_boost {
        payload.insert("check_advantage_condition".into(), Value::String(boost.clone()));
    }
    if let Some(reason) = weather_penalty.filter(|value| js::truthy(Some(value))) {
        payload.insert("weather_disadvantage".into(), reason);
    }
    if let Some(reason) = weather_boost.filter(|value| js::truthy(Some(value))) {
        payload.insert("weather_advantage".into(), reason);
    }
    if let Some(reason) = beast_watch.filter(|value| js::truthy(Some(value))) {
        payload.insert("beast_watch_advantage".into(), reason);
    }
    let social = command.get("social_check").filter(|value| js::truthy(Some(value)));
    if let Some(social) = social {
        let mut summary = Map::new();
        for key in ["check_id", "npc_id", "skill", "request_fingerprint"] {
            if let Some(value) = social.get(key) {
                summary.insert(key.into(), value.clone());
            }
        }
        payload.insert("social_check".into(), Value::Object(summary));
    }
    r.events.push(event_from(&source, "AbilityCheckResolved", Some(Value::Object(payload)), Some(&actor_targets(&command))));
    if silvery_fortune {
        r.events.push(remove_silvery_fortune_event(&command, &state, &actor_id, None));
    }
    if let Some(bribe) = social.and_then(|social| social.get("bribe")).filter(|value| js::truthy(Some(value))) {
        let social = social.unwrap_or(&Value::Null);
        let amount = js::safe_int(bribe.get("amount_cp"), 0).max(0);
        let purse_before = sk_economy::merchant_economy::currency_to_copper(crate::core::player_actor(&state, actor_id_value).and_then(|hero| hero.get("currency")));
        let after = (purse_before - amount).max(0);
        let npc_id = js::string(social.get("npc_id"));
        let economy = command_with_rules(&command, &[rule_ids::ECONOMY_COINS]);
        let insulted = js::is_true(bribe.get("insulted"));
        let mut offered = Map::new();
        offered.insert("npc_id".into(), Value::String(npc_id.clone()));
        offered.insert("tier_id".into(), Value::String(js::string(bribe.get("tier_id"))));
        offered.insert("amount_cp".into(), Value::from(amount));
        offered.insert("insulted".into(), Value::Bool(insulted));
        offered.insert("balance_before_cp".into(), Value::from(purse_before));
        offered.insert("balance_after_cp".into(), Value::from(after));
        offered.insert("currency_after".into(), sk_economy::merchant_economy::copper_to_currency(Some(&Value::from(after))));
        offered.insert("policy_id".into(), Value::String(sk_society::underworld::UNDERWORLD_POLICY_ID.into()));
        r.events.push(event_from(&economy, "NpcBribeOffered", Some(Value::Object(offered)), Some(&actor_targets(&command))));
        if insulted {
            let refused = json!({ "npc_id": npc_id, "hero_id": js::string(actor_id_value), "amount_cp": amount });
            r.events.push(event_from(&economy, "NpcBribeRefused", Some(refused), Some(&json!([npc_id]))));
        }
    }
    Ok(())
}

/// `MakeSavingThrow` (13821–13878).
pub fn make_saving_throw(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let actor_id_value = command.get("actor_id");
    let actor_id = js::s(actor_id_value);
    let actor = sk_core::game::find_actor(&state, &actor_id);
    let ability = match command.get("ability").filter(|value| js::truthy(Some(value))) {
        Some(value) => js::string(Some(value)).to_lowercase(),
        None => "con".into(),
    };
    let ability_value = Value::String(ability.clone());
    let supplied = supplied_modifier(&command);
    let proficient = js::truthy(command.get("proficient"));
    let current = match supplied {
        Some(value) => value,
        None => (ability_modifier(at(at(actor, "abilities"), &ability)) + if proficient { js::safe_int(at(actor, "proficiency"), 0) } else { 0 }) as f64,
    };
    let base = crate::checks::skills::saving_throw_modifier_for_actor(actor, Some(&ability_value), Some(&js::num(current)), Some(&state), supplied.is_none() && !proficient);
    let aura = crate::checks::saves::saving_throw_modifier_with_aura(&state, &actor_id, Some(&Value::from(base)))?;
    let mut modifier = aura.modifier;
    let conditions = condition_ids_for(&state, &actor_id);
    let auto_failed = crate::conditions::auto_failed_save_condition_for(&state, &actor_id, Some(&ability_value));
    let visibility = r.visibility();
    let actor_arg = actor_id_value.cloned().unwrap_or(Value::Null);
    if crate::conditions::bless_bonus_enabled(&state, &actor_id) {
        let blessing = r.roll_dice(Value::String("1d4".into()), "spell:bless:saving-throw", actor_arg.clone(), visibility.clone())?;
        r.rolls.push(blessing.clone());
        r.events.push(event_from(&command, "DieRolled", Some(blessing.clone()), Some(&json!([]))));
        modifier += js::number(blessing.get("total"));
    }
    if conditions.contains("bane-d4") {
        let bane = r.roll_dice(Value::String("1d4".into()), "spell:bane:saving-throw", actor_arg.clone(), visibility.clone())?;
        r.rolls.push(bane.clone());
        r.events.push(event_from(&command, "DieRolled", Some(bane.clone()), Some(&json!([]))));
        modifier -= js::number(bane.get("total"));
    }
    if auto_failed.is_none() && conditions.contains("next-save-minus-d4") {
        let penalty = r.roll_dice(Value::String("1d4".into()), "spell:mind-sliver", actor_arg, visibility)?;
        r.rolls.push(penalty.clone());
        r.events.push(event_from(&command, "DieRolled", Some(penalty.clone()), Some(&json!([]))));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionRemoved", Some(json!({ "condition": "next-save-minus-d4" })), Some(&actor_targets(&command))));
        modifier -= js::number(penalty.get("total"));
    }
    let resistance_options = json!({ "purpose": format!("saving_throw:{ability}"), "resistanceEligible": auto_failed.is_none() });
    modifier += r.resistance_save_state(&state, actor_id_value, &resistance_options)?.bonus as f64;
    modifier += crate::conditions::condition_save_bonus_for(&state, &actor_id, Some(&ability_value)) as f64;
    let silvery_fortune = auto_failed.is_none() && conditions.contains("silvery-fortune");
    let save_penalty = crate::conditions::save_disadvantage_condition_for(&state, &actor_id, Some(&ability_value));
    let save_boost = crate::conditions::save_advantage_condition_for(&state, &actor_id, Some(&ability_value));
    let bloodied_frenzy = crate::checks::saves::bloodied_frenzy_save_advantage(&state, &actor_id);
    let mut options = Map::new();
    options.insert("modifier".into(), js::num(modifier));
    options.insert("difficulty".into(), Value::from(js::safe_int(command.get("difficulty"), 10)));
    options.insert("purpose".into(), Value::String(format!("saving_throw:{ability}")));
    options.insert("actorId".into(), undef(actor_id_value));
    options.insert("advantage".into(), Value::Bool(js::truthy(command.get("advantage")) || silvery_fortune || save_boost.is_some() || bloodied_frenzy));
    options.insert("disadvantage".into(), Value::Bool(js::truthy(command.get("disadvantage")) || save_penalty.is_some()));
    options.insert("visibility".into(), undef(command.get("visibility")));
    let options = Value::Object(options);
    let roll = match check_roll_from_verified(command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => roll_d20_with_species_luck(&state, &mut r.dice, &actor_id, &options, D20Method::RollCheck)?,
    };
    r.rolls.push(roll.clone());
    let advantage_rule = js::truthy(command.get("advantage")) || js::truthy(command.get("disadvantage")) || save_penalty.is_some() || save_boost.is_some() || bloodied_frenzy;
    let source = command_with_rules(&command, &[if advantage_rule { rule_ids::ADVANTAGE } else { "" }]);
    let mut payload = Map::new();
    payload.insert("ability".into(), ability_value);
    for (key, value) in spread_value(Some(&roll)) {
        payload.insert(key, value);
    }
    for (key, value) in crate::checks::saves::aura_of_protection_payload(aura.aura.as_ref()) {
        payload.insert(key, value);
    }
    for (key, value) in crate::checks::saves::item_saving_throw_payload(aura.item_saving_throw_bonus) {
        payload.insert(key, value);
    }
    if let Some(condition) = &auto_failed {
        payload.insert("success".into(), Value::Bool(false));
        payload.insert("auto_failed".into(), Value::Bool(true));
        payload.insert("auto_failed_condition".into(), Value::String(condition.clone()));
    }
    if let Some(condition) = save_penalty {
        payload.insert("save_disadvantage_condition".into(), Value::String(condition));
    }
    if let Some(condition) = save_boost {
        payload.insert("save_advantage_condition".into(), Value::String(condition));
    }
    if bloodied_frenzy {
        payload.insert("bloodied_frenzy".into(), Value::Bool(true));
    }
    r.events.push(event_from(&source, "SavingThrowResolved", Some(Value::Object(payload)), Some(&actor_targets(&command))));
    if silvery_fortune {
        r.events.push(remove_silvery_fortune_event(&command, &state, &actor_id, None));
    }
    Ok(())
}

/// `ApplyDamage` (15173–15179).
pub fn apply_damage(r: &mut Resolve<'_>) -> Step {
    let amount = r.roll_amount("damage", 0.0)?;
    let state = r.state.clone();
    let target_id = js::s(Some(&r.target_id));
    let damage_type = match r.command.get("damage_type").filter(|value| js::truthy(Some(value))) {
        Some(kind) => js::string(Some(kind)),
        None => "untyped".into(),
    };
    let payload = r.resolve_damage_payload(&state, &target_id, Value::from(amount), &Value::String(damage_type), None, None)?;
    let resisted = js::truthy(payload.get("immune")) || js::truthy(payload.get("resistant")) || js::truthy(payload.get("vulnerable"));
    let temporary = js::truthy(payload.get("temporary_hp_absorbed"));
    let source = command_with_rules(&r.command, &[if resisted { rule_ids::RESISTANCE } else { "" }, if temporary { rule_ids::TEMPORARY_HP } else { "" }]);
    let targets = json!([r.target_id.clone()]);
    r.events.push(event_from(&source, "DamageApplied", Some(payload.clone()), Some(&targets)));
    let critical = js::is_true(r.command.get("critical_hit"));
    let consequences = crate::death::zero_hit_point_damage_consequences(&state, &r.command, &target_id, &payload, critical);
    r.events.extend(consequences);
    Ok(())
}

/// `ApplyHealing` (15180–15188).
pub fn apply_healing(r: &mut Resolve<'_>) -> Step {
    let target_id = js::s(Some(&r.target_id));
    let rolled = r.roll_amount("healing", 0.0)?;
    let actor = sk_core::game::find_actor(&r.state, &target_id);
    let healing = crate::damage::resolved_healing_roll(&r.state, &target_id, r.command.get("expression"), Some(&Value::from(rolled)));
    let amount = js::safe_int(healing.get("amount"), 0);
    let before = actor.map(sk_core::game::actor_hp).unwrap_or(0);
    let after = crate::core::actor_max_hp(actor).min(before + amount);
    let mut payload = Map::new();
    payload.insert("requested_amount".into(), healing.get("amount").cloned().unwrap_or(Value::Null));
    payload.insert("applied_amount".into(), Value::from(after - before));
    payload.insert("hp_before".into(), Value::from(before));
    payload.insert("hp_after".into(), Value::from(after));
    for (key, value) in spread_value(Some(&healing)) {
        payload.insert(key, value);
    }
    let targets = json!([r.target_id.clone()]);
    let event = event_from(&r.command, "HealingApplied", Some(Value::Object(payload)), Some(&targets));
    r.events.push(event);
    Ok(())
}

/// `GrantTemporaryHitPoints` (15238–15243).
pub fn grant_temporary_hit_points(r: &mut Resolve<'_>) -> Step {
    let amount = r.roll_amount("temporary_hit_points", 0.0)?;
    let key = js::string(Some(&r.target_id));
    let before = js::safe_int(sk_core::game::mechanics(&r.state).get("temporary_hp").and_then(|all| all.get(&key)), 0).max(0);
    let targets = json!([r.target_id.clone()]);
    let event = event_from(&r.command, "TemporaryHitPointsGranted", Some(json!({ "offered": amount, "temporary_hp_before": before, "temporary_hp_after": before.max(amount) })), Some(&targets));
    r.events.push(event);
    Ok(())
}

/// `SetSpellBonusPreference` (15336–15341).
pub fn set_spell_bonus_preference(r: &mut Resolve<'_>) -> Step {
    let enabled = r.command.get("enabled");
    if r.command.get("spell_id").and_then(Value::as_str) != Some("bless") || !matches!(enabled, Some(Value::Bool(_))) || !condition_ids_for(&r.state, &js::s(r.command.get("actor_id"))).contains("bless-d4") {
        return Err(rule("Настройка доступна только получателю действующего Благословения", "SPELL_BONUS_PREFERENCE_INVALID"));
    }
    let payload = json!({ "spell_id": "bless", "condition": "bless-d4", "enabled": enabled.cloned().unwrap_or(Value::Null), "schema_version": 1 });
    let event = event_from(&command_with_rules(&r.command, &[rule_ids::CONDITIONS]), "SpellBonusPreferenceChanged", Some(payload), Some(&actor_targets(&r.command)));
    r.events.push(event);
    Ok(())
}

/// `SetReactionPreference` (15342–15362).
pub fn set_reaction_preference(r: &mut Resolve<'_>) -> Step {
    let reaction_id = js::s(r.command.get("reaction_id"));
    let actor = r.command.get("actor_id");
    let is_hero = r.state.get("players").and_then(Value::as_array).is_some_and(|players| players.iter().any(|player| actor.and_then(Value::as_str) == Some(sk_core::game::actor_id(player).as_str())));
    if !is_hero {
        return Err(rule("Режим реакции задаётся только герою отряда", "REACTION_PREFERENCE_INVALID"));
    }
    if !sk_combat_base::reaction_preferences::is_reaction_mode(r.command.get("mode")) {
        return Err(rule("Режим реакции — «спрашивать», «сразу» или «никогда»", "REACTION_PREFERENCE_INVALID"));
    }
    if !crate::reactions::hero_reaction_modes_for(&r.state, actor).iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(reaction_id.as_str())) {
        return Err(rule("У героя нет такой реакции", "REACTION_PREFERENCE_INVALID"));
    }
    let payload = json!({
        "reaction_id": reaction_id,
        "mode": r.command.get("mode").cloned().unwrap_or(Value::Null),
        "schema_version": sk_combat_base::reaction_preferences::REACTION_MODE_SCHEMA_VERSION,
    });
    let event = event_from(&command_with_rules(&r.command, &[rule_ids::REACTION]), "ReactionPreferenceChanged", Some(payload), Some(&actor_targets(&r.command)));
    r.events.push(event);
    Ok(())
}

/// `RecordRuling` (23150–23152).
pub fn record_ruling(r: &mut Resolve<'_>) -> Step {
    let ruling = crate::core::coalesce(&[r.command.get("ruling")]).cloned().unwrap_or_else(js::obj);
    let event = event_from(&r.command, "RulingRecorded", Some(json!({ "ruling": ruling })), Some(&json!([])));
    r.events.push(event);
    Ok(())
}

/// неизвестный тип (`default`) (23153–23154).
pub fn default_branch(_r: &mut Resolve<'_>) -> Step {
    Err(rule("Команда пока не реализована", "COMMAND_NOT_IMPLEMENTED"))
}
