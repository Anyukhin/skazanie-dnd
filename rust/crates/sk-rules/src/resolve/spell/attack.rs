//! Заклинание: снаряды («Волшебная стрела»), пул хитов («Усыпление»,
//! «Цветной брызг»), атака заклинанием и её последствия при попадании,
//! промахе и вторичном взрыве. Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 17242–17739.

use serde_json::{json, Map, Value};
use sk_core::js;

use super::common::{actor_id_of, at, field, fold, fold_but_last, hp, hp_after_zero, is_true, items, living, nn, payload_with, positive, put, template, Cast};
use super::super::kernel::{undef, MagicMissile};
use super::super::Resolve;
use crate::checks::saves::{roll_d20_with_species_luck, saving_throw_succeeded, AttackConditionOptions, D20Method};
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with_rules, condition_ids_for, event_from};
use crate::pause::{rule, Interrupt, Pause, ProtectiveReactionArgs, Flow};
use crate::replay::apply_game_event;
use crate::tactical_geometry::{point_json, points_json};

/// «Волшебная стрела» и прочие автоматические снаряды (17242–17249).
pub(super) fn magic_missile(r: &mut Resolve<'_>, cast: &mut Cast) -> Flow {
    let target = cast.affected.first().cloned().unwrap_or(Value::Null);
    let command = cast.command.clone();
    let spell = cast.spell.clone();
    let damage_type = cast.damage_type.clone();
    r.append_magic_missile_resolution(MagicMissile { source_command: &command, spell: &spell, target: &target, slot_level: command.get("slot_level"), damage_type: &damage_type, source_item: None })
}

/// Пул хитов: «Усыпление» и «Цветной брызг» (17250–17277).
pub(super) fn hit_point_pool(r: &mut Resolve<'_>, cast: &mut Cast) -> Flow {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let spell_id = cast.spell_id();
    let base = field(&spell, "hitPointPoolDice").filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| json!("5d8"));
    let upcast = field(&spell, "hitPointPoolUpcastDice").filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| json!("2d8"));
    let expression = crate::damage::spell_hp_pool_expression(Some(&base), Some(&upcast), field(&spell, "level"), command.get("slot_level"))?;
    let pool_roll = r.spell_roll(Value::String(expression), &format!("spell_pool:{spell_id}"))?;
    r.rolls.push(pool_roll.clone());
    r.push_die(payload_with(&pool_roll, json!({ "hit_point_pool": true })));
    let mut remaining = js::number(pool_roll.get("total"));
    let mut eligible: Vec<Value> = cast
        .affected
        .iter()
        .filter(|candidate| {
            let conditions = condition_ids_for(&state, &actor_id_of(candidate));
            if conditions.contains("unconscious") {
                return false;
            }
            if spell_id == "sleep" && crate::damage::immune_to_magical_sleep(&state, Some(candidate)) {
                return false;
            }
            if spell_id == "color-spray" && (conditions.contains("blinded") || conditions.contains("cannot-see")) {
                return false;
            }
            true
        })
        .cloned()
        .collect();
    eligible.sort_by(|left, right| sk_core::game::actor_hp(left).cmp(&sk_core::game::actor_hp(right)).then_with(|| sk_core::text::locale_compare(&actor_id_of(left), &actor_id_of(right))));
    let extended = cast.metamagic.contains("metamagic-extended");
    for target in eligible {
        let target_hp = sk_core::game::actor_hp(&target) as f64;
        if target_hp > remaining {
            continue;
        }
        remaining -= target_hp;
        let target_id = actor_id_of(&target);
        if spell_id == "sleep" {
            let timing = crate::conditions::spell_timed_condition_payload(&state, &command, &spell, extended);
            let rounds = nn(field(&spell, "durationRounds")).map(|value| template(Some(value))).unwrap_or_else(|| "10".into());
            for condition in ["magical-sleep", "unconscious"] {
                let mut payload = Map::new();
                payload.insert("condition".into(), json!(condition));
                payload.insert("duration".into(), Value::String(format!("rounds:{rounds}")));
                payload.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
                payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
                put(&mut payload, "spell_id", field(&spell, "id"));
                for (key, value) in timing.clone() {
                    payload.insert(key, value);
                }
                r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
            }
        } else {
            for condition in items(field(&spell, "conditions")) {
                let payload = json!({ "condition": condition, "duration": "source-turns:2", "source_actor": command.get("actor_id").cloned().unwrap_or(Value::Null), "effect_id": cast.effect_id });
                r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", payload, json!([target_id]));
            }
        }
    }
    Ok(())
}

/// Слагаемое урона атаки заклинанием.
struct Component {
    expression: Option<Value>,
    amount: Option<Value>,
    damage_type: Value,
    purpose: String,
}

/// Атака заклинанием (17278–17739).
pub(super) fn spell_attack(r: &mut Resolve<'_>, cast: &mut Cast) -> Flow {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor = cast.actor.clone();
    let actor_id = cast.actor_id.clone();
    let spell_id = cast.spell_id();
    let target = cast.affected.first().cloned();
    let target_id = target.as_ref().map(actor_id_of).unwrap_or_default();
    let requires_weapon = js::truthy(field(&spell, "requiresWeaponAttack"));
    let equipped_melee = if requires_weapon {
        items(at(actor.as_ref(), "inventory")).into_iter().find(|item| {
            js::truthy(item.get("equipped")) && at(item.get("combat"), "kind").and_then(Value::as_str) == Some("melee") && js::number(Some(nn(item.get("quantity")).unwrap_or(&json!(1)))) > 0.0
        })
    } else {
        None
    };
    let weapon_profile = match equipped_melee.as_ref() {
        Some(item) => crate::combat::weapons::item_attack_profile(&state, actor.as_ref(), item.get("id"), crate::combat::weapons::AttackOptions::default()),
        None if requires_weapon => Some(crate::combat::weapons::trusted_attack_profile(&state, actor.as_ref(), None)?),
        None => None,
    };
    let weapon_source = if requires_weapon {
        let selected = weapon_profile.as_ref().filter(|profile| js::truthy(profile.get("item")));
        crate::combat::weapons::weapon_damage_source_for(&state, actor.as_ref(), weapon_profile.as_ref(), selected, None)
    } else {
        None
    };
    if requires_weapon && weapon_profile.as_ref().is_none_or(|profile| profile.get("kind").and_then(Value::as_str) != Some("melee")) {
        return Err(rule("Для этого заговора требуется экипированное рукопашное оружие", "MELEE_WEAPON_REQUIRED"));
    }
    let actor_at = crate::tactical_geometry::actor_point(&state, &actor_id);
    let target_at = crate::tactical_geometry::actor_point(&state, &target_id);
    let cover = crate::tactical_geometry::cover_between(&state, &actor_id, &target_id, actor_at, target_at);
    let cover_bonus = js::number(cover.get("armorClassBonus"));
    let armor_class = crate::damage::effective_armor_class(&state, target.as_ref(), &target_id)? + cover_bonus;
    let attack_conditions = condition_ids_for(&state, &actor_id);
    let compelled_against_other = sk_core::game::conditions(&state, &actor_id).iter().any(|condition| {
        js::string(nn(at(Some(condition), "id")).or(Some(condition))) == "compelled-duel" && js::s(condition.get("source_actor")) != target_id
    });
    let attack_disadvantage = attack_conditions.contains("disadvantage-next-attack") || compelled_against_other;
    let true_strike = crate::checks::saves::active_true_strike_for(&state, &actor_id, &target_id);
    let silvery_fortune = attack_conditions.contains("silvery-fortune");
    let target_conditions = condition_ids_for(&state, &target_id);
    let guiding_bolt = target_conditions.contains("guiding-bolt-advantage");
    let faerie_fire = target_conditions.contains("faerie-fire");
    let mut attack_modifier = match weapon_profile.as_ref().and_then(|profile| nn(profile.get("modifier"))) {
        Some(modifier) => js::number(Some(modifier)),
        None => cast.spell_attack_modifier as f64,
    };
    if crate::conditions::bless_bonus_enabled(&state, &actor_id) {
        let blessing = r.spell_roll(json!("1d4"), "spell:bless:attack")?;
        r.rolls.push(blessing.clone());
        r.push_die(blessing.clone());
        attack_modifier += js::number(blessing.get("total"));
    }
    if attack_conditions.contains("bane-d4") {
        let bane = r.spell_roll(json!("1d4"), "spell:bane:attack")?;
        r.rolls.push(bane.clone());
        r.push_die(bane.clone());
        attack_modifier -= js::number(bane.get("total"));
    }
    let distance = crate::targets::distance_between_actors(&state, &actor_id, &target_id);
    let profile_kind = weapon_profile.as_ref().and_then(|profile| nn(profile.get("kind"))).map(|kind| js::string(Some(kind))).unwrap_or_else(|| cast.range_kind().to_string());
    let modifiers = crate::checks::saves::condition_attack_modifiers(
        &state,
        &actor_id,
        &target_id,
        AttackConditionOptions { distance_feet: distance, profile_kind: Some(profile_kind.as_str()), melee_reach_feet: None, weapon_attack: weapon_profile.is_some() },
    );
    let high_ground = crate::tactical_geometry::high_ground_between(&state, actor_at, target_at, distance);
    let condition_advantage = !modifiers.advantage.is_empty() || high_ground == "higher";
    let condition_disadvantage = !modifiers.disadvantage.is_empty() || high_ground == "lower";
    let metal_armor = is_true(field(&spell, "advantageVsMetalArmor")) && crate::areas::consequences::wears_metal_armor(sk_core::game::find_actor(&state, &target_id));
    let advantage = cast.metamagic.contains("metamagic-seeking") || true_strike || silvery_fortune || guiding_bolt || faerie_fire || condition_advantage || metal_armor;
    let mut options = Map::new();
    options.insert("modifier".into(), js::num(attack_modifier));
    options.insert("purpose".into(), Value::String(format!("spell_attack:{spell_id}")));
    options.insert("actorId".into(), undef(command.get("actor_id")));
    options.insert("advantage".into(), Value::Bool(advantage));
    options.insert("disadvantage".into(), Value::Bool(attack_disadvantage || condition_disadvantage));
    options.insert("visibility".into(), undef(command.get("visibility")));
    let attack = roll_d20_with_species_luck(&state, &mut r.dice, &actor_id, &Value::Object(options), D20Method::RollD20)?;
    let kept = js::number(attack.get("kept"));
    let total = js::number(attack.get("total"));
    let mut hit = kept == 20.0 || (kept != 1.0 && total >= armor_class);
    r.rolls.push(attack.clone());
    let critical = kept == 20.0 || (hit && modifiers.automatic_critical);
    let protective_key = format!("attack:{}:{target_id}", template(command.get("command_id")));
    let target_hero = target.as_ref().is_some_and(|target| js::truthy(Some(target)));
    if hit && target_hero && !sk_core::game::is_enemy_actor(&state, &target_id) && living(target.as_ref()) {
        let protective_options: Vec<Value> = crate::reactions::protective_attack_reaction_options(
            &state,
            target.as_ref(),
            &crate::reactions::ProtectiveAttackOptions { hit: true, critical, attack_total: total, armor_class, damage_type: Some(cast.damage_type.clone()), distance_feet: distance },
        )?
        .into_iter()
        .filter(|option| !(option.get("id").and_then(Value::as_str) == Some("cast:shield") && kept == 20.0))
        .collect();
        let mut choice = r.protective_reaction_choices.get(&protective_key).cloned();
        if choice.is_none() {
            if let Some(context_choice) = r.context.get("protectiveReactionChoice").filter(|choice| choice.get("key").and_then(Value::as_str) == Some(protective_key.as_str())).cloned() {
                let mut record = crate::core::spread_value(Some(&context_choice));
                record.insert("use".into(), Value::Bool(is_true(context_choice.get("use"))));
                let record = Value::Object(record);
                r.protective_reaction_choices.insert(protective_key.clone(), record.clone());
                choice = Some(record);
            }
        }
        if choice.is_none() && !protective_options.is_empty() {
            let shield_only = protective_options.len() == 1 && protective_options[0].get("id").and_then(Value::as_str) == Some("cast:shield");
            let trigger = json!(if shield_only { "attack-shield-choice" } else { "attack-protective-choice" });
            let mut trigger_roll = Map::new();
            put(&mut trigger_roll, "roll_id", attack.get("roll_id"));
            put(&mut trigger_roll, "kept", attack.get("kept"));
            put(&mut trigger_roll, "modifier", attack.get("modifier"));
            put(&mut trigger_roll, "total", attack.get("total"));
            trigger_roll.insert("armor_class".into(), js::num(armor_class));
            trigger_roll.insert("hit".into(), Value::Bool(true));
            trigger_roll.insert("critical".into(), Value::Bool(critical));
            let trigger_roll = Value::Object(trigger_roll);
            let damage = json!({ "damage_type": cast.damage_type });
            let choices = Value::Object(r.protective_reaction_choices.iter().map(|(key, value)| (key.clone(), value.clone())).collect());
            let resistance = crate::pause::resistance_choices_object(&r.resistance_choices);
            let elemental = Value::Object(r.elemental_reaction_choices.iter().map(|(key, value)| (key.clone(), value.clone())).collect());
            let target_value = Value::String(target_id.clone());
            let kind = json!("attack");
            let key_value = Value::String(protective_key.clone());
            let options_value = Value::Array(protective_options);
            let pause = Pause::protective_reaction(&ProtectiveReactionArgs {
                command: &command,
                target_id: &target_value,
                reactor_id: None,
                source_actor_id: command.get("actor_id"),
                trigger: &trigger,
                kind: &kind,
                decision_key: Some(&key_value),
                action_options: &options_value,
                trigger_roll: Some(&trigger_roll),
                damage: Some(&damage),
                dice_transcript: &r.dice.transcript,
                choices: Some(&choices),
                resistance_choices: Some(&resistance),
                elemental_choices: Some(&elemental),
            });
            return Err(Interrupt::pause(pause));
        }
        let used = choice.as_ref().is_some_and(|choice| is_true(choice.get("use")));
        let choice_kind = choice.as_ref().and_then(|choice| choice.get("kind")).and_then(Value::as_str);
        if used && choice_kind == Some("shield") {
            hit = false;
            if !condition_ids_for(&state, &target_id).contains("shielded") {
                r.events.push(crate::reactions::shield_condition_event(&command, &target_id));
            }
        }
        if used && choice_kind == Some("absorb-elements") {
            let choice = choice.clone().unwrap_or(Value::Null);
            let damage_type = choice.get("damage_type").filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| cast.damage_type.clone());
            let events = crate::reactions::absorb_elements_condition_events(&command, &target_id, Some(&damage_type), choice.get("slot_level"));
            r.events.extend(events);
        }
    }
    let spell_command = command_with_rules(&command, &[rule_ids::ATTACK, rule_ids::ARMOR_CLASS, if critical { rule_ids::CRITICAL_HIT } else { "" }]);
    let attack_choice = r.protective_reaction_choices.get(&protective_key).cloned();
    let shielded_by_choice = attack_choice.as_ref().is_some_and(|choice| is_true(choice.get("use")) && choice.get("kind").and_then(Value::as_str) == Some("shield"));
    let mut payload = crate::core::spread_value(Some(&attack));
    payload.insert("target_id".into(), Value::String(target_id.clone()));
    payload.insert("armor_class".into(), js::num(armor_class));
    payload.insert("hit".into(), Value::Bool(hit));
    payload.insert("critical".into(), Value::Bool(critical));
    payload.insert("economy".into(), json!({ "action": false, "attack": false }));
    if shielded_by_choice || (!hit && kept != 1.0 && target_conditions.contains("shielded") && total >= armor_class - 5.0) {
        payload.insert("shielded_by_reaction".into(), Value::Bool(true));
    }
    if modifiers.automatic_critical && critical && kept != 20.0 {
        payload.insert("automatic_critical".into(), Value::Bool(true));
    }
    if condition_advantage {
        payload.insert("condition_advantage".into(), js::strings_value(modifiers.advantage.clone()));
    }
    if condition_disadvantage {
        payload.insert("condition_disadvantage".into(), js::strings_value(modifiers.disadvantage.clone()));
    }
    if cover_bonus > 0.0 {
        payload.insert("cover".into(), cover.get("level").cloned().unwrap_or(Value::Null));
        payload.insert("cover_bonus".into(), cover.get("armorClassBonus").cloned().unwrap_or(Value::Null));
        payload.insert("cover_blockers".into(), cover.get("blockers").cloned().unwrap_or(Value::Null));
        if let Some(scenery) = cover.get("scenery").filter(|value| js::truthy(Some(value))) {
            payload.insert("cover_scenery".into(), scenery.clone());
        }
    }
    if high_ground != "level" {
        payload.insert("high_ground".into(), json!(high_ground));
    }
    put(&mut payload, "range_feet", cast.effective_range.as_ref());
    let profile_field = |key: &str| weapon_profile.as_ref().and_then(|profile| nn(profile.get(key))).cloned();
    match profile_field("damage_expression").or_else(|| cast.damage_expression.clone()) {
        Some(expression) => payload.insert("damage_expression".into(), expression),
        None => payload.insert("damage_expression".into(), Value::Null),
    };
    payload.insert("damage_type".into(), profile_field("damage_type").unwrap_or_else(|| cast.damage_type.clone()));
    payload.insert("magical".into(), Value::Bool(is_true(at(weapon_source.as_ref(), "magical"))));
    payload.insert("weapon_properties".into(), nn(at(weapon_source.as_ref(), "properties")).cloned().unwrap_or_else(|| json!([])));
    put(&mut payload, "spell_id", field(&spell, "id"));
    put(&mut payload, "spell_name", field(&spell, "name"));
    let trajectory = match (actor_at, target_at) {
        (Some(from), Some(to)) => {
            let mut cells = vec![from];
            cells.extend(crate::tactical_geometry::line_cells(from, to));
            points_json(&cells)
        }
        _ => json!([]),
    };
    payload.insert("trajectory".into(), trajectory);
    let mut visual = Map::new();
    if let Some(item) = weapon_profile.as_ref().and_then(|profile| profile.get("item")) {
        visual.insert("item".into(), item.clone());
    }
    let hero_actor = state.get("players").and_then(Value::as_array).is_some_and(|players| players.iter().any(|hero| actor_id_of(hero) == actor_id));
    if hero_actor {
        put(&mut visual, "items", at(actor.as_ref(), "inventory"));
    }
    visual.insert("attackKind".into(), Value::String(profile_kind.clone()));
    payload.insert("attack_visual".into(), sk_scene_base::actor_appearance::attack_visual_for(Some(&Value::Object(visual))));
    r.events.push(event_from(&spell_command, "AttackResolved", Some(Value::Object(payload)), Some(&json!([target_id]))));
    let actor_targets = json!([actor_id]);
    if attack_disadvantage {
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", json!({ "condition": "disadvantage-next-attack" }), actor_targets.clone());
    }
    if true_strike {
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", json!({ "condition": "true-strike" }), actor_targets.clone());
    }
    if silvery_fortune {
        r.events.push(crate::spells::enervation::remove_silvery_fortune_event(&command, &state, &actor_id, None));
    }
    if guiding_bolt {
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", json!({ "condition": "guiding-bolt-advantage" }), json!([target_id]));
    }
    if hit {
        on_hit(r, cast, &HitContext { state: &state, target: target.as_ref(), target_id: &target_id, weapon_profile: weapon_profile.as_ref(), weapon_source: weapon_source.as_ref(), critical, hit, attack: &attack, armor_class, protective_key: &protective_key })?;
    }
    if !hit && field(&spell, "damageOnMiss").and_then(Value::as_str) == Some("half") && js::truthy(cast.damage_expression.as_ref()) {
        let expression = Value::String(js::string(cast.damage_expression.as_ref()));
        let splash_roll = r.spell_roll(expression, &format!("spell_damage_on_miss:{spell_id}"))?;
        r.rolls.push(splash_roll.clone());
        let mut die = crate::core::spread_value(Some(&splash_roll));
        put(&mut die, "spell_id", field(&spell, "id"));
        die.insert("on_miss".into(), Value::Bool(true));
        r.push_die(Value::Object(die));
        let splash = (js::number(splash_roll.get("total")) / 2.0).floor();
        if splash > 0.0 {
            let payload = r.resolve_damage_payload(&state, &target_id, js::num(splash), &cast.damage_type.clone(), None, None)?;
            let mut extra = Map::new();
            put(&mut extra, "spell_id", field(&spell, "id"));
            extra.insert("on_miss".into(), Value::Bool(true));
            r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", payload_with(&payload, Value::Object(extra)), json!([target_id]));
            if hp_after_zero(&payload) {
                let before = fold_but_last(&state, &r.events)?;
                r.push_zero_hp(&before, &target_id, &payload, false);
            }
        }
    }
    if let Some(burst) = field(&spell, "secondaryBurst").filter(|value| js::truthy(Some(value))).cloned() {
        secondary_burst(r, cast, &state, &burst, &target_id)?;
    }
    Ok(())
}

/// Общие значения ветки попадания.
struct HitContext<'a> {
    state: &'a Value,
    target: Option<&'a Value>,
    target_id: &'a str,
    weapon_profile: Option<&'a Value>,
    weapon_source: Option<&'a Value>,
    critical: bool,
    hit: bool,
    attack: &'a Value,
    armor_class: f64,
    protective_key: &'a str,
}

/// Последствия попадания атаки заклинанием (17394–17691).
fn on_hit(r: &mut Resolve<'_>, cast: &Cast, hit: &HitContext<'_>) -> Flow {
    let state = hit.state;
    let spell = &cast.spell;
    let command = &cast.command;
    let actor = cast.actor.as_ref();
    let actor_id = cast.actor_id.as_str();
    let target_id = hit.target_id;
    let spell_id = cast.spell_id();
    let uses_2014 = sk_core::game::uses_2014(state);
    let critical = hit.critical;
    let cantrip_level = js::safe_int(at(actor, "level"), 1).max(1);
    let weapon_cantrip_dice = if cantrip_level >= 11 { 2 } else if cantrip_level >= 5 { 1 } else { 0 };
    let hexed = condition_ids_for(state, target_id).contains(&format!("hexed:{actor_id}"));
    let mut components = Vec::new();
    if let Some(profile) = hit.weapon_profile {
        components.push(Component {
            expression: profile.get("damage_expression").cloned(),
            amount: profile.get("damage_amount").cloned(),
            damage_type: profile.get("damage_type").cloned().unwrap_or(Value::Null),
            purpose: format!("weapon_cantrip:{spell_id}:weapon"),
        });
        if weapon_cantrip_dice > 0 {
            components.push(Component { expression: Some(Value::String(format!("{weapon_cantrip_dice}d8"))), amount: None, damage_type: cast.damage_type.clone(), purpose: format!("weapon_cantrip:{spell_id}:magic") });
        }
    } else {
        components.push(Component { expression: cast.damage_expression.clone(), amount: None, damage_type: cast.damage_type.clone(), purpose: format!("spell_damage:{spell_id}") });
    }
    if hexed {
        components.push(Component { expression: Some(json!("1d6")), amount: None, damage_type: json!("necrotic"), purpose: "spell:hex:damage".into() });
    }
    let mut transient = state.clone();
    let protection = r.protective_reaction_choices.get(hit.protective_key).cloned();
    let protection_used = protection.as_ref().is_some_and(|choice| is_true(choice.get("use")));
    let protection_kind = protection.as_ref().and_then(|choice| choice.get("kind")).and_then(Value::as_str).map(str::to_string);
    let mut outcomes: Vec<Value> = Vec::new();
    let mut knocked_out = false;
    let inflict_source = uses_2014
        && field(spell, "id").and_then(Value::as_str) == Some("inflict-wounds")
        && crate::tables::character_class_key(actor.unwrap_or(&Value::Null)).as_deref() == Some("cleric")
        && js::safe_int(at(actor, "level"), 1) >= 6
        && sk_core::text::test(sk_core::re!(r"смерт", "iu"), &sk_combat_content::combat_actions::normalized_combat_subclass_for(actor).unwrap_or_default());
    for (index, component) in components.iter().enumerate() {
        let has_expression = js::truthy(component.expression.as_ref());
        if !(has_expression || nn(component.amount.as_ref()).is_some()) {
            continue;
        }
        let expression = match component.expression.as_ref().filter(|value| js::truthy(Some(value))) {
            Some(expression) if critical => Some(Value::String(crate::combat::weapons::critical_damage_expression(&js::string(Some(expression)))?)),
            other => other.cloned(),
        };
        let damage_roll = match expression.filter(|value| js::truthy(Some(value))) {
            Some(expression) => Some(r.spell_roll(expression, &component.purpose)?),
            None => None,
        };
        if let Some(roll) = damage_roll.as_ref() {
            r.rolls.push(roll.clone());
            r.push_die(roll.clone());
        }
        let raw = damage_roll.as_ref().and_then(|roll| nn(roll.get("total"))).cloned().or_else(|| nn(component.amount.as_ref()).cloned()).unwrap_or(json!(0));
        let source = if hit.weapon_profile.is_some() && index == 0 {
            hit.weapon_source.cloned()
        } else if inflict_source {
            Some(json!({ "kind": "spell", "ignore_resistance": true }))
        } else {
            None
        };
        let mut payload = r.resolve_damage_payload(&transient, target_id, raw, &component.damage_type, None, source.as_ref())?;
        if hit.weapon_profile.is_some() && index == 0 && js::truthy(at(hit.weapon_source, "magical")) {
            payload = payload_with(&payload, json!({ "magical": true }));
        }
        if protection_used && protection_kind.as_deref() == Some("uncanny-dodge") {
            payload = crate::reactions::uncanny_dodge_damage_payload(&payload);
        } else if protection_used && protection_kind.as_deref() == Some("absorb-elements") {
            let choice_type = protection.as_ref().and_then(|choice| choice.get("damage_type")).filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| cast.damage_type.clone());
            if js::string(Some(&component.damage_type)) == js::string(Some(&choice_type)) {
                payload = crate::reactions::absorb_elements_damage_payload(&payload, &transient, target_id)?;
            }
        }
        let hp_before = js::number(payload.get("hp_before"));
        if is_true(command.get("knock_out")) && field(spell, "attackKind").and_then(Value::as_str) == Some("melee") && hp_before > 0.0 && hp_after_zero(&payload) {
            payload = payload_with(&payload, json!({ "hp_after": 1, "applied_amount": js::num((hp_before - 1.0).max(0.0)), "knocked_out": true }));
            knocked_out = true;
        }
        let mut applied = crate::core::spread_value(Some(&payload));
        put(&mut applied, "spell_id", field(spell, "id"));
        let damage_event = event_from(&command_with_rules(command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(applied)), Some(&json!([target_id])));
        r.events.push(damage_event.clone());
        outcomes.push(payload);
        transient = apply_game_event(&transient, &damage_event)?;
        if knocked_out {
            break;
        }
    }
    let damage_outcome = damage_outcome_of(&outcomes);
    if knocked_out {
        let payload = json!({ "condition": "unconscious", "rest_kind": "short", "recovery_minutes": 60, "attack_kind": "melee-spell", "spell_id": field(spell, "id").cloned().unwrap_or(Value::Null) });
        r.push_ruled(&[rule_ids::ZERO_HP, rule_ids::CONDITIONS, rule_ids::RESOURCE], "CreatureKnockedOut", strip_spell_id(payload, field(spell, "id")), json!([target_id]));
    }
    if let Some(outcome) = damage_outcome.as_ref().filter(|outcome| hp_after_zero(outcome)) {
        r.push_zero_hp(&transient, target_id, outcome, critical);
    }
    let outcome_alive = damage_outcome.as_ref().is_some_and(|outcome| js::number(outcome.get("hp_after")) > 0.0);
    let shroud = if uses_2014 && hit.weapon_profile.is_none() && outcome_alive {
        sk_core::game::conditions(state, actor_id).iter().find(|condition| sk_core::text::test(sk_core::re!(r"^spirit-shroud(?:-\d)?$", "u"), &js::s(at(Some(condition), "id")))).cloned()
    } else {
        None
    };
    if let Some(shroud) = shroud {
        let shroud_id = js::string(shroud.get("id"));
        let effect = crate::tables::condition_effect(&shroud_id);
        let distance = crate::targets::distance_between_actors(state, actor_id, target_id);
        if let Some(distance) = distance.filter(|distance| *distance <= js::safe_int(at(effect, "weaponDamageDiceWithinFeet"), 10) as f64) {
            let _ = distance;
            let expression = js::string(Some(nn(at(effect, "weaponDamageDice")).unwrap_or(&json!("1d8"))));
            let expression = if critical { crate::combat::weapons::critical_damage_expression(&expression)? } else { expression };
            let roll = r.spell_roll(Value::String(expression), "spell:spirit-shroud:spell-attack")?;
            r.rolls.push(roll.clone());
            r.push_die(payload_with(&roll, json!({ "spell_id": "spirit-shroud" })));
            let option = js::s(shroud.get("spell_option"));
            let shroud_type = if ["radiant", "necrotic", "cold"].contains(&option.as_str()) { option } else { "necrotic".into() };
            let shroud_payload = r.resolve_damage_payload(&transient, target_id, roll.get("total").cloned().unwrap_or(Value::Null), &Value::String(shroud_type), None, None)?;
            let shroud_event = event_from(
                &command_with_rules(command, &[rule_ids::DAMAGE]),
                "DamageApplied",
                Some(payload_with(&shroud_payload, json!({ "spell_id": "spirit-shroud", "spell_damage_rider": true }))),
                Some(&json!([target_id])),
            );
            r.events.push(shroud_event.clone());
            // JS применяет урон «Покрова» к переходному состоянию, но дальше его не читает.
            apply_game_event(&transient, &shroud_event)?;
            if hp_after_zero(&shroud_payload) {
                r.push_zero_hp(&transient, target_id, &shroud_payload, critical);
            }
        }
    }
    if is_true(field(spell, "healsHalfDamageToCaster")) && damage_outcome.as_ref().is_some_and(|outcome| js::number(outcome.get("applied_amount")) > 0.0) {
        let applied = js::number(damage_outcome.as_ref().and_then(|outcome| outcome.get("applied_amount")));
        let healed = (applied / 2.0).floor() as i64;
        let caster = sk_core::game::find_actor(state, actor_id);
        let before = hp(caster);
        let after = crate::core::actor_max_hp(caster).min(before + healed);
        if after > before {
            let mut payload = Map::new();
            put(&mut payload, "spell_id", field(spell, "id"));
            payload.insert("requested_amount".into(), Value::from(healed));
            payload.insert("applied_amount".into(), Value::from(after - before));
            payload.insert("hp_before".into(), Value::from(before));
            payload.insert("hp_after".into(), Value::from(after));
            payload.insert("life_steal".into(), Value::Bool(true));
            r.push_ruled(&[rule_ids::HEALING], "HealingApplied", Value::Object(payload), json!([actor_id]));
        }
    }
    let weapon_cantrip = field(spell, "weaponCantrip").and_then(Value::as_str);
    if weapon_cantrip == Some("booming-blade") {
        let move_dice = if cantrip_level >= 11 { 3 } else if cantrip_level >= 5 { 2 } else { 1 };
        let duration = if uses_2014 { "until-source-next-turn" } else { "until-next-turn" };
        let payload = json!({ "condition": format!("booming-blade-move:{move_dice}d8"), "duration": duration, "source_actor": command.get("actor_id").cloned().unwrap_or(Value::Null), "effect_id": cast.effect_id });
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", payload, json!([target_id]));
    }
    if weapon_cantrip == Some("green-flame-blade") {
        green_flame_blade(r, cast, state, target_id, cantrip_level)?;
    }
    let repelling = field(spell, "id").and_then(Value::as_str) == Some("eldritch-blast") && sk_ruleset::character_progression::normalized_selected_feature_ids(actor).iter().any(|id| id == "repelling-blast");
    if repelling {
        let push_state = fold(state, &r.events)?;
        let pushed = sk_core::game::find_actor(&push_state, target_id).cloned();
        let large = crate::geometry::movement::size_rank_by_name(Some(&json!("large")));
        if living(pushed.as_ref()) && crate::tactical_geometry::creature_size_rank(pushed.as_ref()) <= large {
            let pushed_from = crate::tactical_geometry::actor_point(&push_state, target_id);
            let path = crate::geometry::forced::forced_push_path(&push_state, target_id, crate::tactical_geometry::actor_point(&push_state, actor_id), 10.0);
            if !path.is_empty() {
                let remaining = crate::speed::effective_speed_feet(&push_state, pushed.as_ref().unwrap_or(&Value::Null), target_id);
                let mut extra = Map::new();
                extra.insert("pushed".into(), Value::Bool(true));
                put(&mut extra, "spell_id", field(spell, "id"));
                extra.insert("invocation".into(), json!("repelling-blast"));
                extra.insert("phase".into(), json!("combat"));
                r.forced_spell_move(target_id, pushed_from, &path, path.len() as i64 * 5, remaining, Value::Object(extra))?;
            }
        }
    }
    if positive(field(spell, "pullFeet")) {
        let pull_state = fold(state, &r.events)?;
        let pulled = sk_core::game::find_actor(&pull_state, target_id).cloned();
        if living(pulled.as_ref()) && crate::geometry::forced::forced_movement_size_allowed(spell, pulled.as_ref()) {
            let pulled_from = crate::tactical_geometry::actor_point(&pull_state, target_id);
            let path = crate::geometry::forced::forced_pull_path(&pull_state, target_id, crate::tactical_geometry::actor_point(&pull_state, actor_id), js::number(field(spell, "pullFeet")));
            if !path.is_empty() {
                let remaining = crate::speed::effective_speed_feet(&pull_state, pulled.as_ref().unwrap_or(&Value::Null), target_id);
                let mut extra = Map::new();
                extra.insert("pulled".into(), Value::Bool(true));
                put(&mut extra, "spell_id", field(spell, "id"));
                extra.insert("phase".into(), json!("combat"));
                r.forced_spell_move(target_id, pulled_from, &path, path.len() as i64 * 5, remaining, Value::Object(extra))?;
            }
        }
    }
    if let Some(ability_value) = field(spell, "onHitSaveAbility").filter(|value| js::truthy(Some(value))) {
        let ability = js::string(Some(ability_value));
        let saving_state = fold(state, &r.events)?;
        let saving_target = sk_core::game::find_actor(&saving_state, target_id).cloned();
        if living(saving_target.as_ref()) {
            let poisoned = super::common::list_includes(field(spell, "onHitConditions"), "poisoned");
            let mut options = Map::new();
            options.insert("ability".into(), Value::String(ability.clone()));
            options.insert("modifier".into(), Value::from(ability_modifier(at(at(saving_target.as_ref(), "abilities"), &ability))));
            options.insert("purpose".into(), Value::String(format!("spell_on_hit_save:{spell_id}:{ability}")));
            options.insert("avoid_or_end_condition".into(), if poisoned { json!("poisoned") } else { Value::Null });
            options.insert("visibility".into(), undef(command.get("visibility")));
            let save = r.spell_save(&saving_state, target_id, Value::Object(options))?;
            let saved = saving_throw_succeeded(Some(&save), cast.spell_save_dc as f64);
            r.rolls.push(save.clone());
            let mut payload = crate::core::spread_value(Some(&save));
            put(&mut payload, "spell_id", field(spell, "id"));
            payload.insert("ability".into(), Value::String(ability.clone()));
            payload.insert("difficulty".into(), Value::from(cast.spell_save_dc));
            payload.insert("saved".into(), Value::Bool(saved));
            payload.insert("trigger".into(), json!("on-hit"));
            r.push_ruled(&[rule_ids::SAVING_THROW], "SpellSavingThrowResolved", Value::Object(payload), json!([target_id]));
            if !saved {
                let duration = nn(field(spell, "onHitConditionDuration")).cloned().unwrap_or_else(|| json!("until-next-turn"));
                for condition in items(field(spell, "onHitConditions")) {
                    let payload = json!({ "condition": condition, "duration": duration, "source_actor": command.get("actor_id").cloned().unwrap_or(Value::Null), "effect_id": cast.effect_id });
                    r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", payload, json!([target_id]));
                }
            }
        }
    }
    for condition in items(field(spell, "conditions")) {
        if crate::conditions::freedom_blocks_spell_condition(state, target_id, &js::string(Some(&condition))) {
            continue;
        }
        let duration = if js::truthy(field(spell, "conditionDuration")) {
            template(field(spell, "conditionDuration"))
        } else if js::truthy(field(spell, "durationRounds")) {
            format!("rounds:{}", template(field(spell, "durationRounds")))
        } else {
            "until-next-turn".into()
        };
        let mut payload = Map::new();
        payload.insert("condition".into(), condition.clone());
        payload.insert("duration".into(), Value::String(duration));
        payload.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
        payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
        if is_true(field(spell, "repeatSaveAtTurnEnd")) {
            payload.insert("repeat_save_timing".into(), json!("turn-end"));
            let ability = nn(field(spell, "repeatSaveAbility")).or_else(|| nn(field(spell, "saveAbility"))).map(|value| js::string(Some(value))).unwrap_or_else(|| "wis".into());
            payload.insert("save_ability".into(), Value::String(ability));
            payload.insert("save_dc".into(), Value::from(cast.spell_save_dc));
            put(&mut payload, "spell_id", field(spell, "id"));
        }
        if js::truthy(field(spell, "delayedDamage")) {
            payload.insert("recurring_damage".into(), Value::String(crate::spells::slots::delayed_spell_damage_expression(spell, command.get("slot_level"))));
            let damage_type = nn(field(spell, "delayedDamageType")).or_else(|| nn(field(spell, "damageType"))).map(|value| js::string(Some(value))).unwrap_or_else(|| "untyped".into());
            payload.insert("recurring_damage_type".into(), Value::String(damage_type));
            payload.insert("recurring_once".into(), Value::Bool(true));
            put(&mut payload, "spell_id", field(spell, "id"));
        }
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
    }
    let creature_type = crate::spells::slots::creature_type_for(sk_core::game::find_actor(state, target_id));
    let typed = at(field(spell, "conditionsByCreatureType"), &creature_type).filter(|value| !value.is_null()).cloned();
    if let Some(typed) = typed {
        let duration = js::string(Some(nn(field(spell, "conditionsByCreatureTypeDuration")).or_else(|| nn(field(spell, "conditionDuration"))).unwrap_or(&json!("until-next-turn"))));
        for condition in items(Some(&typed)) {
            let mut payload = Map::new();
            payload.insert("condition".into(), Value::String(js::string(Some(&condition))));
            payload.insert("duration".into(), Value::String(duration.clone()));
            payload.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
            payload.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
            put(&mut payload, "spell_id", field(spell, "id"));
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), json!([target_id]));
        }
    }
    let absorbing = sk_core::game::conditions(state, actor_id).iter().find(|condition| js::string(nn(at(Some(condition), "id")).or(Some(condition))).starts_with("absorbing-element-rider:")).cloned();
    if field(spell, "attackKind").and_then(Value::as_str) == Some("melee") && absorbing.as_ref().is_some_and(|condition| is_true(at(Some(condition), "absorb_elements_rider_armed"))) {
        let condition = absorbing.unwrap_or(Value::Null);
        let condition_id = js::string(condition.get("id"));
        let rider_type = match nn(condition.get("rider_damage_type")) {
            Some(value) => js::string(Some(value)),
            None => sk_core::text::replace_first(sk_core::re!(r"^absorbing-element-rider:", "u"), &condition_id, "elemental"),
        };
        let slot_level = js::safe_int(condition.get("slot_level"), 1).max(1);
        let rider = js::string(Some(nn(condition.get("rider_damage")).unwrap_or(&json!("1d6"))));
        let base = crate::spells::slots::scaled_dice_expression(&rider, Some(&Value::from((slot_level - 1).max(0))), Some(&json!(1)), None);
        let expression = if critical { crate::combat::weapons::critical_damage_expression(&base)? } else { base };
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", json!({ "condition": condition_id, "spell_id": "absorb-elements", "trigger": "spell-melee-hit" }), json!([actor_id]));
        let hit_state = fold(state, &r.events)?;
        let bonus_roll = r.spell_roll(Value::String(expression), "spell:absorb-elements:next-melee-hit")?;
        r.rolls.push(bonus_roll.clone());
        r.push_die(payload_with(&bonus_roll, json!({ "spell_id": "absorb-elements", "damage_type": rider_type, "next_weapon_hit": true, "absorb_elements": true })));
        let bonus_payload = r.resolve_damage_payload(&hit_state, target_id, bonus_roll.get("total").cloned().unwrap_or(Value::Null), &Value::String(rider_type.clone()), None, None)?;
        r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", payload_with(&bonus_payload, json!({ "spell_id": "absorb-elements", "next_weapon_hit": true, "absorb_elements": true })), json!([target_id]));
        if hp_after_zero(&bonus_payload) {
            r.push_zero_hp(&hit_state, target_id, &bonus_payload, false);
        }
    }
    if !sk_core::game::is_enemy_actor(state, target_id) && crate::core::incapacitating_condition_for(state, target_id).is_none() && outcome_alive {
        attack_reaction_window(r, cast, hit, damage_outcome.as_ref())?;
    }
    Ok(())
}

/// `{ ..., spell_id }` без `spell_id`, если у карточки нет `id`.
fn strip_spell_id(payload: Value, spell_id: Option<&Value>) -> Value {
    if spell_id.is_some() {
        return payload;
    }
    let mut map = crate::core::spread_value(Some(&payload));
    map.shift_remove("spell_id");
    Value::Object(map)
}

/// Сводный исход урона попадания по слагаемым (17451–17463).
fn damage_outcome_of(outcomes: &[Value]) -> Option<Value> {
    let first = outcomes.first()?;
    let last = outcomes.last().unwrap_or(first);
    let sum = |key: &str| js::num(outcomes.iter().map(|entry| js::number(entry.get(key))).sum());
    let mut outcome = Map::new();
    outcome.insert("damage_type".into(), if outcomes.len() == 1 { first.get("damage_type").cloned().unwrap_or(Value::Null) } else { json!("mixed") });
    outcome.insert("raw_amount".into(), sum("raw_amount"));
    outcome.insert("applied_amount".into(), sum("applied_amount"));
    outcome.insert("temporary_hp_absorbed".into(), sum("temporary_hp_absorbed"));
    put(&mut outcome, "temporary_hp_before", first.get("temporary_hp_before"));
    put(&mut outcome, "temporary_hp_after", last.get("temporary_hp_after"));
    put(&mut outcome, "hp_before", first.get("hp_before"));
    put(&mut outcome, "hp_after", last.get("hp_after"));
    outcome.insert("resistant".into(), Value::Bool(outcomes.iter().all(|entry| js::truthy(entry.get("resistant")))));
    Some(Value::Object(outcome))
}

/// «Клинок зелёного пламени»: перескок огня на соседа цели (17513–17536).
fn green_flame_blade(r: &mut Resolve<'_>, cast: &Cast, state: &Value, target_id: &str, cantrip_level: i64) -> Flow {
    let Some(target_at) = crate::tactical_geometry::actor_point(state, target_id) else { return Ok(()) };
    let actor_id = cast.actor_id.as_str();
    let caster_enemy = sk_core::game::is_enemy_actor(state, actor_id);
    let target_actor = sk_core::game::find_actor(state, target_id);
    let target_anchor = point_json(target_at);
    let mut candidates: Vec<&Value> = sk_core::game::list_actors(state)
        .into_iter()
        .filter(|candidate| {
            let id = actor_id_of(candidate);
            id != target_id && id != actor_id && sk_core::game::is_living_actor(candidate)
        })
        .filter(|candidate| sk_core::game::is_enemy_actor(state, &actor_id_of(candidate)) != caster_enemy)
        .filter(|candidate| {
            let Some(at_point) = crate::tactical_geometry::actor_point(state, &actor_id_of(candidate)) else { return false };
            sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), target_actor, Some(&point_json(at_point)), Some(&target_anchor)) == Some(5.0)
        })
        .collect();
    candidates.sort_by(|left, right| sk_core::text::locale_compare(&actor_id_of(left), &actor_id_of(right)));
    let Some(second) = candidates.first().map(|candidate| actor_id_of(candidate)) else { return Ok(()) };
    let fire_dice = if cantrip_level >= 11 { 2 } else if cantrip_level >= 5 { 1 } else { 0 };
    let modifier = cast.spell_modifier;
    let fire_roll = if fire_dice > 0 {
        let expression = format!("{fire_dice}d8{}{modifier}", if modifier >= 0 { "+" } else { "" });
        let roll = r.spell_roll(Value::String(expression), "weapon_cantrip:green-flame-blade:bounce")?;
        r.rolls.push(roll.clone());
        r.push_die(roll.clone());
        Some(roll)
    } else {
        None
    };
    let raw = fire_roll.as_ref().and_then(|roll| nn(roll.get("total"))).cloned().unwrap_or_else(|| Value::from(modifier.max(0)));
    let payload = r.resolve_damage_payload(state, &second, raw, &json!("fire"), None, None)?;
    let mut extra = Map::new();
    put(&mut extra, "spell_id", cast.spell("id"));
    extra.insert("secondary".into(), Value::Bool(true));
    r.push_ruled(&[rule_ids::DAMAGE], "DamageApplied", payload_with(&payload, Value::Object(extra)), json!([second]));
    if hp_after_zero(&payload) {
        let before = fold_but_last(state, &r.events)?;
        r.push_zero_hp(&before, &second, &payload, false);
    }
    Ok(())
}

/// Окно реакции после попадания заклинанием по герою (17661–17690).
fn attack_reaction_window(r: &mut Resolve<'_>, cast: &Cast, hit: &HitContext<'_>, damage: Option<&Value>) -> Flow {
    let state = hit.state;
    let command = &cast.command;
    let actor_id = cast.actor_id.as_str();
    let target_id = hit.target_id;
    let distance = crate::targets::distance_between_actors(state, actor_id, target_id);
    let Some(target) = hit.target else { return Ok(()) };
    let decided = r.protective_reaction_choices.contains_key(hit.protective_key);
    let mut options: Vec<Value> = crate::reactions::reaction_options_after_attack(
        state,
        target,
        &crate::reactions::AttackReactionOptions {
            hit: hit.hit,
            critical: hit.critical,
            attack_total: js::number(hit.attack.get("total")),
            armor_class: hit.armor_class,
            damage: damage.cloned(),
            distance_feet: distance,
            allow_parry: distance.is_none_or(|distance| distance <= 5.0),
            allow_riposte: false,
        },
    )?
    .into_iter()
    .filter(|option| !decided || !["cast:shield", "uncanny-dodge", "cast:absorb-elements"].contains(&option.get("id").and_then(Value::as_str).unwrap_or("")))
    .collect();
    let mut reaction_actor = target_id.to_string();
    if let Some(silvery) = crate::reactions::silvery_barbs_reaction_for(state, actor_id, Some(target_id)) {
        let silvery_actor = actor_id_of(&silvery.actor);
        if silvery_actor == target_id || options.is_empty() {
            reaction_actor = silvery_actor;
            let mut option = Map::new();
            option.insert("id".into(), json!("cast:silvery-barbs"));
            put(&mut option, "name", silvery.spell.get("name"));
            put(&mut option, "description", silvery.spell.get("description"));
            option.insert("resource".into(), Value::String(silvery.slot.resource.clone()));
            option.insert("slot_level".into(), Value::from(silvery.slot.level));
            option.insert("cost".into(), json!(1));
            put(&mut option, "spell_id", silvery.spell.get("id"));
            option.insert("requires_beneficiary".into(), Value::Bool(true));
            options.push(Value::Object(option));
        }
    }
    let economy = at(sk_core::game::combat(state).get("action_economy"), &reaction_actor);
    if js::is_false(at(economy, "reaction")) || options.is_empty() {
        return Ok(());
    }
    let mut trigger_roll = Map::new();
    put(&mut trigger_roll, "kept", hit.attack.get("kept"));
    put(&mut trigger_roll, "modifier", hit.attack.get("modifier"));
    put(&mut trigger_roll, "total", hit.attack.get("total"));
    trigger_roll.insert("armor_class".into(), js::num(hit.armor_class));
    trigger_roll.insert("hit".into(), Value::Bool(hit.hit));
    trigger_roll.insert("critical".into(), Value::Bool(hit.critical));
    let ids: Vec<Value> = options.iter().map(|option| option.get("id").cloned().unwrap_or(Value::Null)).collect();
    let payload = json!({
        "id": format!("reaction:{}", template(command.get("command_id"))),
        "trigger": "spell-attack-hit",
        "actor_id": reaction_actor,
        "source_actor_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
        "target_id": target_id,
        "action_ids": ids,
        "action_options": options,
        "damage": damage.cloned().unwrap_or(Value::Null),
        "trigger_roll": Value::Object(trigger_roll),
    });
    r.push_ruled(&[rule_ids::REACTION], "ReactionWindowOpened", payload, json!([reaction_actor]));
    Ok(())
}

/// Вторичный взрыв вокруг цели атаки (17705–17739).
fn secondary_burst(r: &mut Resolve<'_>, cast: &Cast, state: &Value, burst: &Value, target_id: &str) -> Flow {
    let spell = &cast.spell;
    let command = &cast.command;
    let spell_id = cast.spell_id();
    let level = super::common::level_of(spell);
    let mut expression = js::string(Some(burst.get("damage").filter(|value| js::truthy(Some(value))).unwrap_or(&json!("1d6"))));
    if let Ok(parsed) = sk_dice::parse_dice_expression(&expression) {
        let slot_level = level.max(js::safe_int(command.get("slot_level"), level));
        let count = i64::from(parsed.count) + (slot_level - level).max(0) * js::safe_int(burst.get("upcastDicePerLevel"), 0).max(0);
        let modifier = parsed.modifier;
        let suffix = if modifier > 0 { format!("+{modifier}") } else if modifier < 0 { modifier.to_string() } else { String::new() };
        expression = format!("{count}d{}{suffix}", parsed.sides);
    }
    let burst_roll = r.spell_roll(Value::String(expression), &format!("spell_secondary_burst:{spell_id}"))?;
    r.rolls.push(burst_roll.clone());
    let mut die = crate::core::spread_value(Some(&burst_roll));
    die.insert("secondary_burst".into(), Value::Bool(true));
    put(&mut die, "spell_id", field(spell, "id"));
    r.push_die(Value::Object(die));
    let mut burst_state = fold(state, &r.events)?;
    let center = crate::tactical_geometry::actor_point(&burst_state, target_id).or_else(|| crate::tactical_geometry::actor_point(state, target_id));
    let radius = js::safe_int(burst.get("radius"), 5).max(0) as f64;
    let target_actor = sk_core::game::find_actor(&burst_state, target_id).cloned();
    let targets: Vec<Value> = sk_core::game::list_actors(&burst_state)
        .into_iter()
        .filter(|candidate| {
            let id = actor_id_of(candidate);
            let (Some(at_point), Some(center)) = (crate::tactical_geometry::actor_point(&burst_state, &id), center) else { return false };
            let distance = sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), target_actor.as_ref(), Some(&point_json(at_point)), Some(&point_json(center)));
            distance.unwrap_or(0.0) <= radius && (sk_core::game::is_living_actor(candidate) || id == target_id)
        })
        .cloned()
        .collect();
    let ability = js::string(Some(burst.get("saveAbility").filter(|value| js::truthy(Some(value))).unwrap_or(&json!("dex"))));
    let damage_type = Value::String(js::string(Some(burst.get("damageType").filter(|value| js::truthy(Some(value))).unwrap_or(&json!("force")))));
    for candidate in targets {
        let candidate_id = actor_id_of(&candidate);
        let mut options = Map::new();
        options.insert("ability".into(), Value::String(ability.clone()));
        options.insert("modifier".into(), Value::from(ability_modifier(at(candidate.get("abilities"), &ability))));
        options.insert("purpose".into(), Value::String(format!("spell_secondary_save:{spell_id}:{ability}")));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.spell_save(&burst_state, &candidate_id, Value::Object(options))?;
        let saved = saving_throw_succeeded(Some(&save), cast.spell_save_dc as f64);
        r.rolls.push(save.clone());
        let mut payload = crate::core::spread_value(Some(&save));
        put(&mut payload, "spell_id", field(spell, "id"));
        payload.insert("ability".into(), Value::String(ability.clone()));
        payload.insert("difficulty".into(), Value::from(cast.spell_save_dc));
        payload.insert("saved".into(), Value::Bool(saved));
        payload.insert("trigger".into(), json!("secondary-burst"));
        r.push_ruled(&[rule_ids::SAVING_THROW], "SpellSavingThrowResolved", Value::Object(payload), json!([candidate_id]));
        let raw = crate::checks::saves::saved_damage_amount(&burst_state, &candidate_id, Some(&Value::String(ability.clone())), saved, js::truthy(burst.get("halfOnSave")), burst_roll.get("total"));
        if raw <= 0 {
            continue;
        }
        let payload = r.resolve_damage_payload(&burst_state, &candidate_id, Value::from(raw), &damage_type, None, None)?;
        let mut extra = Map::new();
        put(&mut extra, "spell_id", field(spell, "id"));
        extra.insert("secondary_burst".into(), Value::Bool(true));
        extra.insert("saved".into(), Value::Bool(saved));
        let event = event_from(&command_with_rules(command, &[rule_ids::DAMAGE]), "DamageApplied", Some(payload_with(&payload, Value::Object(extra))), Some(&json!([candidate_id])));
        r.events.push(event.clone());
        burst_state = apply_game_event(&burst_state, &event)?;
        if hp_after_zero(&payload) {
            r.push_zero_hp(&burst_state, &candidate_id, &payload, false);
        }
    }
    Ok(())
}
