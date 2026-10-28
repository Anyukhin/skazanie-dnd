//! Ветки `resolveCommandInternal`: Хиты, ресурсы, состояния: уменьшение максимума хитов, судьба погибшего героя, трата и восстановление ресурса, опознание противника, наложение и снятие состояния. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 15189–15221, 15222–15237, 15244–15251, 15252–15259, 15263–15305, 15317–15335, 15363–15365. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Здесь же [`resolve_branch_without_tail`] — разбор без хвоста последствий
//! (хвост — задача Р5) для сверки веток с корпусом JS (`sk-corpus resolve`).

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;

use super::{Resolve, Resolved};
use crate::checks::skills::{enemy_lore_check_for, skill_proficiency_bonus};
use crate::checks::saves::active_aura_of_life_source;
use crate::command::rules::rule_ids;
use crate::context::{Context, Uuid};
use crate::core::{ability_modifier, actor_max_hp, command_with_rules, event_from, hero_died_event_from, monster_trait_for, player_actor, resource_pool};
use crate::dice_record::RulesDice;
use crate::pause::{resistance_choices_from_context, rule, Interrupt, Flow};
use crate::replay::CommandProjector;
use crate::targets::is_dead_hero;

/// `String(actor?.character ?? actor?.name ?? fallback)`.
fn hero_name(actor: Option<&Value>, fallback: &Value) -> String {
    match crate::conditions::nullish_chain(&[actor.and_then(|actor| actor.get("character")), actor.and_then(|actor| actor.get("name"))]).filter(|value| !value.is_null()) {
        Some(name) => js::s(Some(name)),
        None => js::string(Some(fallback)),
    }
}

/// `[command.actor_id]` как список целей события.
fn actor_targets(command: &Value) -> Value {
    json!([command.get("actor_id").cloned().unwrap_or(Value::Null)])
}

/// `ReduceHitPointMaximum` (15189–15221).
pub fn reduce_hit_point_maximum(r: &mut Resolve<'_>) -> Flow {
    let target_id = js::s(Some(&r.target_id));
    let target = sk_core::game::find_actor(&r.state, &target_id);
    let amount = js::safe_int(r.command.get("amount"), 0).max(0);
    let maximum_before = actor_max_hp(target);
    let hp_before = target.map(sk_core::game::actor_hp).unwrap_or(0);
    let targets = json!([r.target_id.clone()]);
    let aura = active_aura_of_life_source(&r.state, &js::string(Some(&r.target_id)));
    if let Some(aura) = aura.filter(|_| amount > 0) {
        let source = command_with_rules(&r.command, &[rule_ids::CONDITIONS]);
        r.events.push(event_from(
            &source,
            "HitPointMaximumReductionPrevented",
            Some(json!({ "attempted_amount": amount, "maximum_hp_before": maximum_before, "maximum_hp_after": maximum_before, "aura_of_life_source": aura.source_id })),
            Some(&targets),
        ));
        return Ok(());
    }
    let maximum_after = (maximum_before - amount).max(0);
    let hp_after = hp_before.min(maximum_after);
    r.events.push(event_from(
        &r.command,
        "HitPointMaximumReduced",
        Some(json!({
            "requested_amount": amount,
            "applied_amount": maximum_before - maximum_after,
            "maximum_hp_before": maximum_before,
            "maximum_hp_after": maximum_after,
            "hp_before": hp_before,
            "hp_after": hp_after,
        })),
        Some(&targets),
    ));
    if maximum_after == 0 && player_actor(&r.state, Some(&r.target_id)).is_some() && !is_dead_hero(&r.state, &js::string(Some(&r.target_id))) {
        let source = command_with_rules(&r.command, &[rule_ids::ZERO_HP]);
        let name = hero_name(target, &r.target_id);
        r.events.push(hero_died_event_from(&source, Some(json!({ "hero_name": name, "reason": "hit-point-maximum-reduced-to-zero" })), Some(&targets)));
    }
    Ok(())
}

/// `ResolveHeroDeath` (15222–15237).
pub fn resolve_hero_death(r: &mut Resolve<'_>) -> Flow {
    let actor_id = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let Some(hero) = player_actor(&r.state, Some(&actor_id)) else {
        return Err(crate::pause::Fault::type_error("Cannot read properties of null (reading 'character')").into());
    };
    let previous_name = hero_name(Some(hero), &actor_id);
    let targets = actor_targets(&r.command);
    let event = if r.command.get("resolution").and_then(Value::as_str) == Some("resurrect") {
        event_from(&r.command, "HeroResurrected", Some(json!({ "hp_after": 1, "previous_name": previous_name })), Some(&targets))
    } else {
        let mut payload = Map::new();
        payload.insert("hp_after".into(), Value::from(actor_max_hp(Some(hero))));
        payload.insert("previous_name".into(), Value::String(previous_name));
        if let Some(name) = r.command.get("replacement_name") {
            payload.insert("replacement_name".into(), name.clone());
        }
        event_from(&r.command, "HeroReplaced", Some(Value::Object(payload)), Some(&targets))
    };
    r.events.push(event);
    Ok(())
}

/// Ресурс команды: `String(command.resource)`, запас и количество.
fn command_resource(r: &Resolve<'_>) -> (String, crate::core::Pool, i64) {
    let resource = js::string(r.command.get("resource"));
    let pool = resource_pool(&r.state, &js::string(r.command.get("actor_id")), &resource, js::safe_int(r.command.get("max"), 0));
    (resource, pool, js::safe_int(r.command.get("amount"), 0))
}

/// `SpendResource` (15244–15251).
pub fn spend_resource(r: &mut Resolve<'_>) -> Flow {
    let (resource, pool, amount) = command_resource(r);
    if pool.current < amount {
        return Err(rule("Недостаточно ресурса", "INSUFFICIENT_RESOURCE"));
    }
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&r.command, "ResourceSpent", Some(json!({ "resource": resource, "amount": amount, "before": pool.current, "after": pool.current - amount, "max": pool.max })), Some(&targets)));
    Ok(())
}

/// `RestoreResource` (15252–15259).
pub fn restore_resource(r: &mut Resolve<'_>) -> Flow {
    let (resource, pool, amount) = command_resource(r);
    let after = pool.max.min(pool.current + amount);
    let targets = actor_targets(&r.command);
    r.events.push(event_from(&r.command, "ResourceRestored", Some(json!({ "resource": resource, "amount": after - pool.current, "before": pool.current, "after": after, "max": pool.max })), Some(&targets)));
    Ok(())
}

/// `IdentifyEnemy` (15263–15305).
pub fn identify_enemy(r: &mut Resolve<'_>) -> Flow {
    let actor = sk_core::game::find_actor(&r.state, &js::s(r.command.get("actor_id")));
    let target = sk_core::game::find_actor(&r.state, &js::s(r.command.get("target_id")));
    let lore = enemy_lore_check_for(target);
    let skill = js::s(lore.get("skill"));
    let ability = match sk_ruleset::character_progression::skill_ability(Some(&Value::String(skill.clone()))) {
        Some(value) if js::truthy(Some(&value)) => sk_core::text::lower(&js::string(Some(&value))),
        _ => "int".to_string(),
    };
    let modifier = ability_modifier(actor.and_then(|actor| actor.get("abilities")).and_then(|abilities| abilities.get(&ability))) + skill_proficiency_bonus(actor, &skill, Some(&r.state));
    let actor_targets = actor_targets(&r.command);
    if sk_core::game::combat_active(&r.state) {
        let source = command_with_rules(&r.command, &[rule_ids::TURNS]);
        r.events.push(event_from(&source, "CombatActionUsed", Some(json!({ "action_id": "identify-enemy", "name": "Опознать противника", "action_type": "action" })), Some(&actor_targets)));
    }
    let mut options = Map::new();
    options.insert("modifier".into(), Value::from(modifier));
    options.insert("difficulty".into(), lore.get("difficulty").cloned().unwrap_or(Value::Null));
    options.insert("purpose".into(), Value::String(format!("enemy_lore:{skill}")));
    if let Some(actor_id) = r.command.get("actor_id") {
        options.insert("actorId".into(), actor_id.clone());
    }
    options.insert("advantage".into(), Value::Bool(js::truthy(r.command.get("advantage"))));
    options.insert("disadvantage".into(), Value::Bool(js::truthy(r.command.get("disadvantage"))));
    if let Some(visibility) = r.command.get("visibility") {
        options.insert("visibility".into(), visibility.clone());
    }
    let roll = r.dice.roll_check(&Value::Object(options))?;
    r.rolls.push(roll.clone());
    let source = command_with_rules(&r.command, &[rule_ids::ABILITY_CHECK]);
    let enemy_id = r.command.get("target_id").cloned();
    let mut payload = Map::new();
    payload.insert("ability".into(), Value::String(ability));
    payload.insert("skill".into(), Value::String(skill.clone()));
    payload.extend(crate::core::spread_value(Some(&roll)));
    let mut lore_payload = Map::new();
    if let Some(enemy_id) = &enemy_id {
        lore_payload.insert("enemy_id".into(), enemy_id.clone());
    }
    lore_payload.insert("difficulty_category".into(), lore.get("difficulty_category").cloned().unwrap_or(Value::Null));
    payload.insert("enemy_lore".into(), Value::Object(lore_payload));
    r.events.push(event_from(&source, "AbilityCheckResolved", Some(Value::Object(payload)), Some(&actor_targets)));
    if js::truthy(roll.get("success")) {
        let mut revealed = Map::new();
        if let Some(enemy_id) = &enemy_id {
            revealed.insert("enemy_id".into(), enemy_id.clone());
        }
        revealed.insert("scope".into(), Value::String("party".into()));
        revealed.insert("facts".into(), json!({ "health": "exact", "armor_class": "exact" }));
        revealed.insert("skill".into(), Value::String(skill));
        revealed.insert("difficulty".into(), lore.get("difficulty").cloned().unwrap_or(Value::Null));
        if let Some(roll_id) = roll.get("roll_id") {
            revealed.insert("check_id".into(), roll_id.clone());
        }
        let targets = json!([enemy_id.unwrap_or(Value::Null)]);
        r.events.push(event_from(&source, "EnemyKnowledgeRevealed", Some(Value::Object(revealed)), Some(&targets)));
    }
    Ok(())
}

/// `AddCondition` (15317–15335).
pub fn add_condition(r: &mut Resolve<'_>) -> Flow {
    if r.command.get("monster_ability").and_then(Value::as_str) == Some("nimble-escape") {
        let actor_id = js::s(r.command.get("actor_id"));
        let actor = sk_core::game::find_actor(&r.state, &actor_id);
        let economy = sk_core::game::combat(&r.state).get("action_economy").and_then(|all| all.get(js::string(r.command.get("actor_id"))));
        if !r.context.truthy("isNpcScheduler")
            || monster_trait_for(actor, "nimble-escape").is_none()
            || js::string(Some(&r.target_id)) != js::string(r.command.get("actor_id"))
            || js::string(r.command.get("condition")) != "disengaged"
        {
            return Err(rule("Хитрый отход доступен только существу с этой чертой", "NIMBLE_ESCAPE_FORBIDDEN"));
        }
        if economy.and_then(|economy| economy.get("bonus_action")).is_some_and(|value| js::is_false(Some(value))) {
            return Err(rule("Бонусное действие на этом ходу уже потрачено", "BONUS_ACTION_SPENT"));
        }
        let source = command_with_rules(&r.command, &[rule_ids::TURNS]);
        let targets = actor_targets(&r.command);
        r.events.push(event_from(&source, "CombatActionUsed", Some(json!({ "action_id": "nimble-escape", "name": "Хитрый отход", "action_type": "bonus_action" })), Some(&targets)));
    }
    let duration = r.command.get("duration").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    let targets = json!([r.target_id.clone()]);
    r.events.push(event_from(&r.command, "ConditionAdded", Some(json!({ "condition": js::string(r.command.get("condition")), "duration": duration })), Some(&targets)));
    Ok(())
}

/// `RemoveCondition` (15363–15365).
pub fn remove_condition(r: &mut Resolve<'_>) -> Flow {
    let targets = json!([r.target_id.clone()]);
    r.events.push(event_from(&r.command, "ConditionRemoved", Some(json!({ "condition": js::string(r.command.get("condition")) })), Some(&targets)));
    Ok(())
}

/// Разбор команды **без хвоста последствий** (`resolveCommandInternal` до
/// 23134): подготовка как в [`super::resolve_command_internal`] над уже
/// проверенной командой, вероломство, ветка диспетчера. Только для сверки
/// веток с корпусом JS, пока хвост (Р5) и проверка (все 68 блоков) не перенесены.
pub fn resolve_branch_without_tail(command: Value, state: &Value, dice: &mut dyn RulesDice, context: &Context, uuid: Uuid<'_>) -> Result<Resolved, Interrupt> {
    let depth = context.resolve_depth().max(0);
    let context = context.with("__resolve_depth", Value::from(depth + 1));
    let recording = crate::dice_record::Recording::new(dice);
    let mut state = crate::normalize::normalize_campaign_state(state)?;
    super::push_npc_spell_proxies(&mut state, &command)?;
    let projector = CommandProjector::new(&state);
    let target_id = crate::core::target_for(&command);
    let resistance_choices = resistance_choices_from_context(context.get("resistanceChoices"));
    let elemental_reaction_choices = super::reaction_choices(context.get("elementalDamageChoices"), "damage_key");
    let protective_reaction_choices = super::reaction_choices(context.get("protectiveReactionChoices"), "key");
    let truce_before_command = sk_society::parley::truce_for(&state);
    let mut r = Resolve {
        state,
        command,
        context,
        depth,
        dice: recording,
        uuid,
        events: Vec::new(),
        rolls: Vec::new(),
        target_id,
        inspiration_spent: IndexSet::new(),
        resistance_cantrip_uses: IndexSet::new(),
        resistance_choices,
        resistance_used_targets: IndexSet::new(),
        resistance_save_sequence: 0,
        elemental_reaction_choices,
        elemental_reaction_sequence: 0,
        protective_reaction_choices,
        nested_consequences_resolved: false,
        truce_before_command,
        legendary_spends_in_command: IndexMap::new(),
        oiled_targets: IndexSet::new(),
        projector,
    };
    r.append_truce_broken();
    super::dispatch::dispatch(&mut r)?;
    Ok(Resolved { command: r.command, events: r.events, rolls: r.rolls })
}
