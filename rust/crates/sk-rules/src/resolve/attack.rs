//! Ветки `resolveCommandInternal`: Атака оружием `MakeAttack`, смена оружия, областная атака предметом. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 13857–14999, 15000–15009, 15068–15150. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! `MakeAttack` правит саму команду (серверный профиль удара заменяет
//! присланные числа), поэтому паузы боя (Оборона, Острое словцо, защиты цели)
//! несут уже дополненную команду, как в JS. Броски идут в порядке JS: кость
//! «Благословения»/«Порчи», атака, вдохновение и Острое словцо, двойники,
//! урон оружия и надбавки, урон предметов и заклинаний, ответный урон.

use serde_json::{json, Map, Value};
use sk_core::{game, js, text};
use sk_geometry::Point;

use super::kernel::undef;
use super::Resolve;
use crate::checks::saves::{roll_d20_with_species_luck, roll_saving_throw_check, saved_damage_amount, saving_throw_succeeded, D20Method};
use crate::combat::class_features::{bardic_inspiration_die_sides, colossus_slayer_ready, is_monk_bonus_attack_context, monk_martial_arts_attack_profile, sneak_attack_dice_count, sneak_attack_supporting_ally};
use crate::combat::weapons::{
    attack_kind_for, combat_item, critical_damage_expression, great_weapon_fighting_reroll, hero_ammunition_expenditure, item_attack_profile, item_instance_key, recharge_minimum_of, shillelagh_removal_events, trusted_attack_profile,
    weapon_coating_rider_for, weapon_critical_threshold, weapon_damage_source_for, AttackOptions, ShillelaghRemoval,
};
use crate::command::rules::rule_ids;
use crate::conditions::{bless_bonus_enabled, condition_numeric_bonus, condition_weapon_damage_dice, freedom_blocks_spell_condition};
use crate::constants::AMMUNITION_SPENT_EVENT_SCHEMA_VERSION;
use crate::core::{ability_modifier, coalesce, command_with, command_with_rules, condition_ids_for, event_from, incapacitating_condition_for, monster_trait_for, npc_world_events_from, slice_utf16, spread_value};
use crate::dice_record::RulesDice;
use crate::pause::{rule, resistance_choices_object, Fault, Halt, Pause, ProtectiveReactionArgs, Step};
use crate::preview_attack::{attack_swing_shape, condition_id_values, swing_condition_modifiers, SwingOptions};
use crate::reactions::{
    absorb_elements_condition_events, absorb_elements_damage_payload, ally_attack_reaction_for, ally_attack_reaction_option, protective_attack_reaction_options, reaction_options_after_attack, shield_condition_event,
    silvery_barbs_reaction_for, uncanny_dodge_damage_payload, AllyReactionKind, AttackReactionOptions, ProtectiveAttackOptions,
};
use crate::replay::apply_game_event;
use crate::tactical_geometry::{actor_point, line_cells, point_json, points_json};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `Number(roll.<key>)`.
fn number(value: &Value, key: &str) -> f64 {
    js::number(value.get(key))
}

/// `{ ...base, key: value, … }`.
fn spread(base: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut map = spread_value(Some(base));
    for (key, value) in fields {
        map.insert(key.into(), value);
    }
    Value::Object(map)
}

/// Поле, если оно есть (`key: source.key` — `undefined` в JSON не попадает).
fn copy_field(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn targets(id: &Value) -> Value {
    Value::Array(vec![id.clone()])
}

fn fault(message: &str) -> Halt {
    Fault::type_error(message).into()
}

/// `{ ...state.mechanics.ruleset_id ? }`: опции `combatSpellFor` редакции состояния.
fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

/// `{ x: Number(p.x), y: Number(p.y) }` в JSON или `null`.
fn point_or_null(point: Option<Point>) -> Value {
    point.map_or(Value::Null, point_json)
}

/// `Object.fromEntries(map)`.
fn from_entries(map: &sk_core::indexmap::IndexMap<String, Value>) -> Value {
    Value::Object(map.iter().map(|(key, value)| (key.clone(), value.clone())).collect())
}

impl Resolve<'_> {
    /// Выбор защитной реакции по ключу: уже сделанный или присланный в
    /// `context.protectiveReactionChoice` (`{ ...choice, use: choice.use === true }`).
    fn protective_choice(&mut self, key: &str) -> Option<Value> {
        if let Some(choice) = self.protective_reaction_choices.get(key) {
            return Some(choice.clone());
        }
        let context_choice = self.context.get("protectiveReactionChoice")?;
        if context_choice.get("key").and_then(Value::as_str) != Some(key) {
            return None;
        }
        let choice = spread(context_choice, vec![("use", Value::Bool(js::is_true(context_choice.get("use"))))]);
        self.protective_reaction_choices.insert(key.to_string(), choice.clone());
        Some(choice)
    }

    /// Пауза защитной реакции с выборами этой команды.
    fn protective_pause(&self, target_id: &Value, reactor_id: Option<&Value>, trigger: &str, kind: &str, key: &str, options: Value, trigger_roll: Option<Value>, damage: Option<Value>) -> Halt {
        let choices = from_entries(&self.protective_reaction_choices);
        let resistance = resistance_choices_object(&self.resistance_choices);
        let elemental = from_entries(&self.elemental_reaction_choices);
        let trigger = Value::String(trigger.into());
        let kind = Value::String(kind.into());
        let key = Value::String(key.into());
        Halt::pause(Pause::protective_reaction(&ProtectiveReactionArgs {
            command: &self.command,
            target_id,
            reactor_id,
            source_actor_id: self.command.get("actor_id"),
            trigger: &trigger,
            kind: &kind,
            decision_key: Some(&key),
            action_options: &options,
            trigger_roll: trigger_roll.as_ref(),
            damage: damage.as_ref(),
            dice_transcript: &self.dice.transcript,
            choices: Some(&choices),
            resistance_choices: Some(&resistance),
            elemental_choices: Some(&elemental),
        }))
    }

    /// `diceService.roll(expression, purpose, command.actor_id, command.visibility ?? 'public')`
    /// со стенограммой, броском в `rolls` и событием `DieRolled`.
    fn attack_roll(&mut self, expression: Value, purpose: &str, actor: &Value) -> Result<Value, Halt> {
        let visibility = self.visibility();
        let roll = self.roll_dice(expression, purpose, actor.clone(), visibility)?;
        self.rolls.push(roll.clone());
        Ok(roll)
    }
}

/// `MakeAttack` (13857–14999).
pub fn make_attack(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let actor_id = js::s(r.command.get("actor_id"));
    let actor_value = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    let target_value = r.target_id.clone();
    let target_id = js::s(Some(&target_value));
    let actor = game::find_actor(&state, &actor_id).cloned();
    let target = game::find_actor(&state, &target_id).cloned();
    let actor_ref = actor.as_ref();
    let target_ref = target.as_ref();
    let authoritative = js::truthy(r.command.get("server_authoritative"))
        || r.context.truthy("serverAuthoritativeCombat")
        || r.context.truthy("isNpcScheduler")
        || game::is_enemy_actor(&state, &actor_id)
        || game::is_enemy_actor(&state, &target_id);
    let monk_bonus_attack = is_monk_bonus_attack_context(&r.context);
    // В диком облике друид бьёт оружием зверя: присланное оружие не используется.
    let wild_shaped = js::is_true(js::path(game::mechanics(&state), &["shapes", &actor_id, "form", "wild_shape"]));
    let selected_profile = if authoritative && js::truthy(r.command.get("item_id")) && !wild_shaped {
        item_attack_profile(
            &state,
            actor_ref,
            r.command.get("item_id"),
            AttackOptions { attack_mode: r.command.get("attack_mode"), attack_ability: r.command.get("attack_ability"), off_hand: r.context.offhand_attack },
        )
    } else {
        None
    };
    let profile: Option<Value> = if monk_bonus_attack {
        Some(monk_martial_arts_attack_profile(actor_ref)?)
    } else if let Some(selected) = &selected_profile {
        Some(selected.clone())
    } else if authoritative {
        Some(trusted_attack_profile(&state, actor_ref, r.command.get("action_id"))?)
    } else {
        None
    };
    if let (Some(profile), Some(command)) = (&profile, r.command.as_object_mut()) {
        for (field, source) in [("attack_modifier", "modifier"), ("damage_expression", "damage_expression"), ("damage_amount", "damage_amount"), ("damage_type", "damage_type"), ("range_feet", "range_feet")] {
            match profile.get(source) {
                Some(value) => {
                    command.insert(field.into(), value.clone());
                }
                None => {
                    command.shift_remove(field);
                }
            }
        }
        for field in ["armor_class", "advantage", "disadvantage"] {
            command.shift_remove(field);
        }
    }
    let command = r.command.clone();
    let profile_ref = profile.as_ref();
    let kind = at(profile_ref, "kind").and_then(Value::as_str).map(str::to_string);
    let kind = kind.as_deref();
    let bare_armor_class = crate::damage::effective_armor_class(&state, target_ref, &target_id)?;
    let actor_at = actor_point(&state, &actor_id);
    let target_at = if js::truthy(command.get("reaction_attack")) && js::truthy(command.get("reaction_target_position")) {
        let position = command.get("reaction_target_position");
        Some(Point::new(js::number(at(position, "x")), js::number(at(position, "y"))))
    } else {
        actor_point(&state, &target_id)
    };
    let has_tactical_map = !crate::tactical_geometry::tactical_cell_map(&state).is_empty();
    let combat_active = game::combat_active(&state);
    let blind_allowed = crate::geometry::footprint::blind_target_allowed(&command, &r.context, Some(&state));
    if authoritative && combat_active && has_tactical_map && !crate::geometry::footprint::actor_footprint_visible(&state, &target_id, target_at) && !blind_allowed {
        return Err(rule("Цель находится в нераскрытой части карты", "TARGET_NOT_VISIBLE"));
    }
    let cover = crate::tactical_geometry::cover_between(&state, &actor_id, &target_id, actor_at, target_at);
    let cover_bonus = js::number(cover.get("armorClassBonus"));
    let armor_class = bare_armor_class + cover_bonus;
    let mut distance_feet: Option<f64> = None;
    if authoritative && combat_active && has_tactical_map {
        if actor_at.is_none() || target_at.is_none() {
            return Err(rule("Участники боя должны находиться на карте", "MAP_POSITION_REQUIRED"));
        }
        distance_feet = crate::geometry::footprint::distance_between_actor_positions(&state, &actor_id, actor_at, &target_id, target_at);
        let Some(profile) = profile_ref else { return Err(fault("Cannot read properties of null (reading 'range_feet')")) };
        let range = js::number(profile.get("range_feet"));
        // `null < 5`: неизвестное расстояние — ноль.
        let distance = distance_feet.unwrap_or(0.0);
        if distance < 5.0 || distance > range {
            return Err(rule("Цель находится вне дальности атаки", "TARGET_OUT_OF_RANGE"));
        }
        if range > 5.0 {
            crate::geometry::forced::assert_clear_actor_trajectory(&state, &actor_id, &target_id, actor_at, target_at, blind_allowed)?;
        }
    }
    let mut modifier = match profile_ref {
        Some(profile) => js::number(profile.get("modifier")),
        None => js::safe_int(command.get("attack_modifier"), 0) as f64,
    };
    let long_range = profile_ref.is_some() && distance_feet.is_some_and(|distance| distance > js::number(at(profile_ref, "normal_range_feet")));
    let actor_conditions = condition_ids_for(&state, &actor_id);
    let target_conditions = condition_ids_for(&state, &target_id);
    let actor_condition_list = game::conditions(&state, &actor_id);
    let pending_weapon_hit_condition = actor_condition_list.iter().find(|condition| game::condition_id(condition).starts_with("next-weapon-hit:")).cloned();
    let pending_weapon_hit_spell_id = match &pending_weapon_hit_condition {
        Some(condition) => {
            let raw = js::string(coalesce(&[at(Some(condition), "spell_id"), at(Some(condition), "id")]));
            text::replace_first(sk_core::re!(r"^next-weapon-hit:", "u"), &raw, "")
        }
        None => String::new(),
    };
    let pending_weapon_hit_spell = if pending_weapon_hit_spell_id.is_empty() {
        None
    } else {
        sk_combat_content::combat_spells::combat_spell_for(actor_ref, Some(&Value::String(pending_weapon_hit_spell_id.clone())), Some(&ruleset_options(&state)))
    };
    let pending_weapon_hit = at(pending_weapon_hit_spell.as_ref(), "nextWeaponHit").filter(|value| !value.is_null()).cloned();
    let pwh = pending_weapon_hit.as_ref();
    let pending_weapon_hit_matches = js::truthy(pwh) && profile_ref.is_some() && (!js::truthy(at(pwh, "meleeOnly")) || kind == Some("melee")) && (!js::truthy(at(pwh, "rangedOnly")) || kind == Some("ranged"));
    let absorbing_element_condition = actor_condition_list.iter().find(|condition| game::condition_id(condition).starts_with("absorbing-element-rider:")).cloned();
    let absorbing_element_matches = absorbing_element_condition.as_ref().is_some_and(|condition| js::is_true(condition.get("absorb_elements_rider_armed"))) && kind == Some("melee");
    let bloodied_frenzy_trait = monster_trait_for(actor_ref, "bloodied-frenzy");
    let bloodied_frenzy = js::truthy(bloodied_frenzy_trait) && {
        let kinds_ok = match at(bloodied_frenzy_trait, "attack_kinds") {
            Some(Value::Array(kinds)) => kinds.iter().any(|item| js::string(Some(item)) == kind.unwrap_or("")),
            _ => true,
        };
        let hp = js::safe_int(at(actor_ref, "hp"), 0).max(0) as f64;
        let max_hp = at(actor_ref, "maxHp");
        let max_hp = if js::is_safe_integer(max_hp) { js::number(max_hp) } else { js::number(at(actor_ref, "hp")) };
        kinds_ok && hp * 2.0 <= crate::tactical_geometry::js_max(1.0, max_hp)
    };
    let charge_trait = monster_trait_for(actor_ref, "charge").cloned();
    let charge_active = r.context.truthy("isNpcScheduler")
        && js::truthy(charge_trait.as_ref())
        && (!js::truthy(at(charge_trait.as_ref(), "action_id")) || js::string(at(charge_trait.as_ref(), "action_id")) == js::s(at(profile_ref, "id")))
        && crate::geometry::movement::completed_straight_charge(&state, &actor_id, &target_id, at(charge_trait.as_ref(), "minimum_distance_feet"))
        && crate::tactical_geometry::creature_size_rank(target_ref) <= crate::geometry::movement::size_rank_by_name(Some(coalesce(&[at(charge_trait.as_ref(), "target_size_max")]).unwrap_or(&Value::String("large".into()))));
    if bless_bonus_enabled(&state, &actor_id) {
        let blessing = r.attack_roll(Value::from("1d4"), "spell:bless:attack", &actor_value)?;
        r.events.push(event_from(&command, "DieRolled", Some(blessing.clone()), Some(&json!([]))));
        modifier += number(&blessing, "total");
    }
    if actor_conditions.contains("bane-d4") {
        let bane = r.attack_roll(Value::from("1d4"), "spell:bane:attack", &actor_value)?;
        r.events.push(event_from(&command, "DieRolled", Some(bane.clone()), Some(&json!([]))));
        modifier -= number(&bane, "total");
    }
    // Зачарованное оружие бьёт точнее: надбавка — из таблицы состояний.
    modifier += condition_numeric_bonus(&state, &actor_id, "attackBonus") as f64;
    // Священное оружие паладина Преданности: +Харизма, не меньше +1.
    if actor_conditions.contains("sacred-weapon") {
        modifier += ability_modifier(at(at(actor_ref, "abilities"), "cha")).max(1) as f64;
    }
    let actor_is_enemy = game::is_enemy_actor(&state, &actor_id);
    let allied_support = game::list_actors(&state).into_iter().any(|candidate| {
        let id = game::actor_id(candidate);
        if id == actor_id || game::is_enemy_actor(&state, &id) != actor_is_enemy || !game::is_living_actor(candidate) {
            return false;
        }
        let Some(position) = actor_point(&state, &id) else { return false };
        let Some(target_position) = target_at else { return false };
        sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), target_ref, Some(&point_json(position)), Some(&point_json(target_position))) == Some(5.0)
    });
    let helped = actor_conditions.contains("helped");
    let hidden = actor_conditions.contains("hidden");
    let steady_aim = actor_conditions.contains("steady-aim");
    let pack_tactics = monster_trait_for(actor_ref, "pack-tactics").is_some_and(|value| js::truthy(Some(value))) && allied_support;
    let true_strike = crate::checks::saves::active_true_strike_for(&state, &actor_id, &target_id);
    let silvery_fortune = actor_conditions.contains("silvery-fortune");
    let guiding_bolt_advantage = target_conditions.contains("guiding-bolt-advantage");
    let condition_modifiers = swing_condition_modifiers(&state, &actor_id, &target_id, profile_ref, distance_feet);
    let swing = attack_swing_shape(
        &state,
        &actor_id,
        &target_id,
        profile_ref,
        SwingOptions {
            actor_at,
            target_at,
            distance_feet,
            condition_modifiers: Some(condition_modifiers.clone()),
            command_advantage: js::truthy(command.get("advantage")),
            command_disadvantage: js::truthy(command.get("disadvantage")),
            extra_advantage: bloodied_frenzy || (pending_weapon_hit_matches && js::truthy(at(pwh, "advantage"))),
        },
    );
    let advantage = swing.advantage;
    let disadvantage = swing.disadvantage;
    let sneak_attack_requested = js::is_true(command.get("sneak_attack"));
    let sneak_attack_turn_key = if sneak_attack_requested { crate::turn_economy::combat_turn_key(&state, &actor_id) } else { None };
    let sneak_attack_supporter = if sneak_attack_requested { sneak_attack_supporting_ally(&state, &actor_id, &target_id).cloned() } else { None };
    if sneak_attack_requested {
        if disadvantage {
            return Err(rule("Коварная атака невозможна при помехе, даже если преимущество её отменяет", "SNEAK_ATTACK_DISADVANTAGE"));
        }
        if !advantage && sneak_attack_supporter.is_none() {
            return Err(rule("Для Коварной атаки нужно преимущество или дееспособный союзник рядом с целью", "SNEAK_ATTACK_POSITION_REQUIRED"));
        }
        let economy = at(game::combat(&state).get("action_economy"), &actor_id).filter(|value| !value.is_null()).cloned().unwrap_or_else(crate::turn_economy::action_economy);
        if let Some(key) = &sneak_attack_turn_key {
            if js::s(economy.get("sneak_attack_turn_key")) == *key {
                return Err(rule("Коварная атака уже применена в этом ходу", "SNEAK_ATTACK_SPENT"));
            }
        }
    }
    // Святилище проверяется до броска атаки: провал спасброска — действие потеряно целиком.
    let sanctuary = game::conditions(&state, &target_id).iter().find(|condition| game::condition_id(condition) == "sanctuary").cloned();
    if let Some(sanctuary) = sanctuary.filter(|_| !js::truthy(command.get("reaction_attack"))) {
        let sanctuary_dc = js::safe_int(sanctuary.get("save_dc"), 10).max(1);
        let mut options = Map::new();
        options.insert("ability".into(), Value::from("wis"));
        options.insert("modifier".into(), Value::from(ability_modifier(at(at(actor_ref, "abilities"), "wis"))));
        options.insert("purpose".into(), Value::from("spell_save:sanctuary:wis"));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let ward = r.roll_saving_throw(&state, Some(&actor_value), &Value::Object(options))?;
        r.rolls.push(ward.clone());
        let warded = !saving_throw_succeeded(Some(&ward), sanctuary_dc as f64);
        let payload = spread(&ward, vec![("spell_id", json!("sanctuary")), ("ability", json!("wis")), ("difficulty", json!(sanctuary_dc)), ("saved", json!(!warded)), ("trigger", json!("sanctuary"))]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(payload), Some(&targets(&actor_value))));
        if warded {
            let mut used = Map::new();
            used.insert("action_id".into(), json!("sanctuary-blocked"));
            used.insert("name".into(), json!("Святилище"));
            used.insert("action_type".into(), json!("action"));
            used.insert("target_id".into(), target_value.clone());
            used.insert("spell_id".into(), json!("sanctuary"));
            if js::truthy(command.get("request_fingerprint")) {
                copy_field(&mut used, "request_fingerprint", command.get("request_fingerprint"));
            }
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "CombatActionUsed", Some(Value::Object(used)), Some(&targets(&actor_value))));
            return Ok(());
        }
    }
    let command_id = js::string(command.get("command_id"));
    let target_key = js::string(Some(&target_value));
    let reaction_attack = js::truthy(command.get("reaction_attack"));
    // Оборона союзника со щитом: до броска, помеха. Окно — защитнику.
    let protection_key = format!("protection:{command_id}:{target_key}");
    let protection_choice = r.protective_choice(&protection_key);
    if protection_choice.is_none() && !reaction_attack && !disadvantage {
        if let Some(protector) = ally_attack_reaction_for(&state, &actor_id, &target_id, AllyReactionKind::Protection) {
            let reactor = Value::String(game::actor_id(&protector.actor));
            return Err(r.protective_pause(&target_value, Some(&reactor), "attack-protection-choice", "protection", &protection_key, json!([ally_attack_reaction_option(&protector)]), None, None));
        }
    }
    let protected_by = protection_choice.as_ref().filter(|choice| js::is_true(choice.get("use"))).map(|choice| js::s(choice.get("reactor_id")));
    let protected = protected_by.as_ref().is_some_and(|reactor| !reactor.is_empty());
    let mut options = Map::new();
    options.insert("modifier".into(), js::num(modifier));
    options.insert("purpose".into(), json!("attack"));
    options.insert("actorId".into(), undef(command.get("actor_id")));
    options.insert("advantage".into(), Value::Bool(advantage));
    options.insert("disadvantage".into(), Value::Bool(disadvantage || protected));
    options.insert("visibility".into(), undef(command.get("visibility")));
    let mut attack = roll_d20_with_species_luck(&state, &mut r.dice, &actor_id, &Value::Object(options), D20Method::RollD20)?;
    if protected {
        attack = spread(&attack, vec![("protected_by", Value::String(protected_by.clone().unwrap_or_default()))]);
    }
    // Чемпион критует на 19–20: такой удар попадает, как и натуральная 20.
    let critical_threshold = weapon_critical_threshold(&state, actor_ref) as f64;
    let kept = number(&attack, "kept");
    // Вдохновение барда само прибавляется к проваленной атаке; единицу не спасает.
    if kept != 1.0 && kept < critical_threshold && number(&attack, "total") < armor_class {
        let boost = r.spend_bardic_inspiration(&state, Some(&actor_value), "attack")?;
        if boost != 0 {
            attack = spread(&attack, vec![("total", js::num(number(&attack, "total") + boost as f64)), ("bardic_inspiration", Value::from(boost))]);
        }
    }
    // Острое словцо барда Знаний: бросок виден, исход ещё нет.
    let cutting_key = format!("cutting-words:{command_id}:{target_key}");
    if !reaction_attack && kept != 1.0 && kept < critical_threshold && number(&attack, "total") >= armor_class {
        let cutting_choice = r.protective_choice(&cutting_key);
        let bard = if cutting_choice.is_some() { None } else { ally_attack_reaction_for(&state, &actor_id, &target_id, AllyReactionKind::CuttingWords) };
        if let Some(bard) = bard {
            if number(&attack, "total") - (bardic_inspiration_die_sides(Some(&bard.actor)) as f64) < armor_class {
                let reactor = Value::String(game::actor_id(&bard.actor));
                let mut trigger_roll = Map::new();
                copy_field(&mut trigger_roll, "roll_id", attack.get("roll_id"));
                copy_field(&mut trigger_roll, "kept", attack.get("kept"));
                copy_field(&mut trigger_roll, "modifier", attack.get("modifier"));
                copy_field(&mut trigger_roll, "total", attack.get("total"));
                trigger_roll.insert("armor_class".into(), js::num(armor_class));
                trigger_roll.insert("hit".into(), Value::Bool(true));
                trigger_roll.insert("critical".into(), Value::Bool(false));
                return Err(r.protective_pause(&target_value, Some(&reactor), "attack-cutting-words-choice", "cutting-words", &cutting_key, json!([ally_attack_reaction_option(&bard)]), Some(Value::Object(trigger_roll)), None));
            }
        }
        if let Some(choice) = cutting_choice.filter(|choice| js::is_true(choice.get("use"))) {
            let bard_id = js::s(choice.get("reactor_id"));
            let sides = bardic_inspiration_die_sides(game::find_actor(&state, &bard_id));
            let cut = r.attack_roll(Value::String(format!("1d{sides}")), "cutting_words", &Value::String(bard_id.clone()))?;
            r.events.push(event_from(&command, "DieRolled", Some(spread(&cut, vec![("cutting_words", json!(true)), ("reactor_id", Value::String(bard_id.clone()))])), Some(&json!([]))));
            attack = spread(&attack, vec![("total", js::num(number(&attack, "total") - number(&cut, "total"))), ("cutting_words", cut.get("total").cloned().unwrap_or(Value::Null)), ("cutting_words_by", Value::String(bard_id))]);
        }
    }
    let attack_total = number(&attack, "total");
    let hit = kept >= critical_threshold || (kept != 1.0 && attack_total >= armor_class);
    // Удар в упор по обездвиженной цели — крит независимо от кости.
    let critical_before_protection = kept >= critical_threshold || (hit && condition_modifiers.automatic_critical);
    // Адамантин перехватывает крит до удвоения костей.
    let critical_protection_sources: Vec<Value> = if critical_before_protection {
        let effects = sk_items_life::item_lifecycle::active_item_mechanic_effects(target_ref, &sk_items_life::item_lifecycle::MechanicEffectOptions::default()).map_err(crate::damage::item_fault)?;
        effects
            .iter()
            .filter(|effect| js::truthy(effect.get("prevents_critical_hits")))
            .map(|effect| {
                let mut source = Map::new();
                for key in ["effect_id", "item_id", "item_name", "catalog_id"] {
                    copy_field(&mut source, key, effect.get(key));
                }
                Value::Object(source)
            })
            .collect()
    } else {
        Vec::new()
    };
    let critical = critical_before_protection && critical_protection_sources.is_empty();
    r.rolls.push(attack.clone());
    // Отражения: удар может уйти в двойника.
    let mirror_images = [3, 2, 1].into_iter().find(|count| target_conditions.contains(&format!("mirror-image:{count}"))).unwrap_or(0);
    let mut intercepted_by_image = false;
    if mirror_images > 0 && !actor_conditions.contains("blinded") {
        let threshold = match mirror_images {
            3 => 6,
            2 => 8,
            _ => 11,
        };
        let mut pick_options = Map::new();
        pick_options.insert("modifier".into(), json!(0));
        pick_options.insert("purpose".into(), json!("spell:mirror-image:intercept"));
        copy_field(&mut pick_options, "actorId", command.get("actor_id"));
        copy_field(&mut pick_options, "visibility", command.get("visibility"));
        let pick = r.dice.roll_d20(&Value::Object(pick_options))?;
        r.rolls.push(pick.clone());
        r.events.push(event_from(&command, "DieRolled", Some(spread(&pick, vec![("spell_id", json!("mirror-image")), ("images", json!(mirror_images)), ("threshold", json!(threshold))])), Some(&json!([]))));
        if number(&pick, "kept") >= threshold as f64 {
            intercepted_by_image = true;
            let image_armor_class = 10 + ability_modifier(at(at(target_ref, "abilities"), "dex"));
            if attack_total >= image_armor_class as f64 {
                let source = command_with_rules(&command, &[rule_ids::CONDITIONS]);
                r.events.push(event_from(&source, "ConditionRemoved", Some(json!({ "condition": format!("mirror-image:{mirror_images}"), "spell_id": "mirror-image", "trigger": "image-destroyed" })), Some(&targets(&target_value))));
                if mirror_images > 1 {
                    r.events.push(event_from(
                        &source,
                        "ConditionAdded",
                        Some(json!({ "condition": format!("mirror-image:{}", mirror_images - 1), "duration": "rounds:10", "source_actor": target_value, "spell_id": "mirror-image" })),
                        Some(&targets(&target_value)),
                    ));
                }
            }
        }
    }
    let attack_command = command_with_rules(&command, &[rule_ids::ARMOR_CLASS, if advantage || disadvantage { rule_ids::ADVANTAGE } else { "" }, if critical { rule_ids::CRITICAL_HIT } else { "" }]);
    // «Молниевая стрела» 2014 бьёт своим уроном вместо урона оружия.
    let spell_ref = pending_weapon_hit_spell.as_ref();
    let spell_level = js::number(at(spell_ref, "level"));
    let replacing_weapon_hit = pending_weapon_hit_matches && pending_weapon_hit_condition.is_some() && js::is_true(at(pwh, "replacesWeaponDamage")) && js::truthy(at(pwh, "damage"));
    let replacing_extra_levels = if replacing_weapon_hit {
        let slot = crate::tactical_geometry::js_max(spell_level, safe_number(at(pending_weapon_hit_condition.as_ref(), "slot_level"), at(spell_ref, "level")));
        crate::tactical_geometry::js_max(0.0, slot - crate::tactical_geometry::js_max(1.0, spell_level))
    } else {
        0.0
    };
    let configured_damage_expression: Option<Value> = if replacing_weapon_hit {
        Some(Value::String(crate::spells::slots::scaled_dice_expression(&js::string(at(pwh, "damage")), Some(&js::num(replacing_extra_levels)), at(pwh, "upcastDicePerLevel"), None)))
    } else {
        coalesce(&[at(profile_ref, "damage_expression"), command.get("damage_expression")]).cloned()
    };
    let configured = configured_damage_expression.as_ref().filter(|value| js::truthy(Some(value)));
    let damage_type: Value = if replacing_weapon_hit {
        Value::String(js::string(Some(coalesce(&[at(pwh, "damageType")]).unwrap_or(&Value::from("force")))))
    } else if let Some(kind) = coalesce(&[at(profile_ref, "damage_type")]) {
        kind.clone()
    } else {
        let declared = command.get("damage_type").filter(|value| js::truthy(Some(value)));
        Value::String(declared.map_or("untyped".to_string(), |value| js::string(Some(value))))
    };
    let damage_type_text = js::string(Some(&damage_type));
    // Яд на клинке — та же добавка к попаданию, что зачарование предмета.
    let npc_binding = if selected_profile.is_none() && actor_is_enemy { sk_economy::npc_equipment::npc_weapon_binding_for(actor_ref, at(profile_ref, "id")) } else { None };
    let selected_item = at(selected_profile.as_ref(), "item").cloned();
    let weapon_coating_rider = if selected_profile.is_some() {
        weapon_coating_rider_for(&state, Some(&actor_value), at(selected_item.as_ref(), "id"))
    } else if let Some(binding) = &npc_binding {
        weapon_coating_rider_for(&state, Some(&actor_value), binding.get("item_instance_id"))
    } else {
        None
    };
    let mut item_damage_riders: Vec<Value> = Vec::new();
    if selected_profile.is_some() {
        item_damage_riders.extend(sk_items_life::item_lifecycle::weapon_damage_riders_for_item(actor_ref, at(selected_item.as_ref(), "id"), true).map_err(crate::damage::item_fault)?);
    }
    if let Some(rider) = &weapon_coating_rider {
        item_damage_riders.push(rider.clone());
    }
    let mut damage_outcome: Option<Value> = None;
    // Перехваченный двойником удар не считается попаданием по цели.
    let mut landed = hit && !intercepted_by_image;
    let protective_attack_key = format!("attack:{command_id}:{target_key}");
    let target_is_enemy = game::is_enemy_actor(&state, &target_id);
    let target_living = target_ref.is_some_and(game::is_living_actor);
    if landed && !target_is_enemy && target_living {
        let options = ProtectiveAttackOptions { hit: true, critical, attack_total, armor_class, damage_type: Some(damage_type.clone()), distance_feet };
        let protective_options: Vec<Value> = protective_attack_reaction_options(&state, target_ref, &options)?
            .into_iter()
            .filter(|option| !(option.get("id").and_then(Value::as_str) == Some("cast:shield") && kept >= critical_threshold))
            .collect();
        let protective_choice = r.protective_choice(&protective_attack_key);
        if protective_choice.is_none() && !protective_options.is_empty() {
            let trigger = if protective_options.len() == 1 && protective_options[0].get("id").and_then(Value::as_str) == Some("cast:shield") { "attack-shield-choice" } else { "attack-protective-choice" };
            let mut trigger_roll = Map::new();
            copy_field(&mut trigger_roll, "roll_id", attack.get("roll_id"));
            copy_field(&mut trigger_roll, "kept", attack.get("kept"));
            copy_field(&mut trigger_roll, "modifier", attack.get("modifier"));
            copy_field(&mut trigger_roll, "total", attack.get("total"));
            trigger_roll.insert("armor_class".into(), js::num(armor_class));
            trigger_roll.insert("hit".into(), Value::Bool(true));
            trigger_roll.insert("critical".into(), Value::Bool(critical));
            return Err(r.protective_pause(&target_value, None, trigger, "attack", &protective_attack_key, Value::Array(protective_options), Some(Value::Object(trigger_roll)), Some(json!({ "damage_type": damage_type }))));
        }
        let choice_used = |wanted: &str| protective_choice.as_ref().is_some_and(|choice| js::is_true(choice.get("use")) && choice.get("kind").and_then(Value::as_str) == Some(wanted));
        if choice_used("shield") {
            landed = false;
            if !condition_ids_for(&state, &target_id).contains("shielded") {
                r.events.push(shield_condition_event(&command, &target_id));
            }
        }
        if choice_used("absorb-elements") {
            let choice = protective_choice.as_ref();
            let chosen_type = at(choice, "damage_type").filter(|value| js::truthy(Some(value))).unwrap_or(&damage_type);
            r.events.extend(absorb_elements_condition_events(&command, &target_id, Some(chosen_type), at(choice, "slot_level")));
        }
    }
    let colossus_slayer = landed && selected_profile.is_some() && colossus_slayer_ready(&state, actor_ref, target_ref);
    let attack_resolved_event_id = format!("attack-resolved:{}", slice_utf16(&command_id, 96));
    let attack_kind = attack_kind_for(selected_profile.as_ref(), profile_ref, npc_binding.as_ref());
    let weapon_source = weapon_damage_source_for(&state, actor_ref, profile_ref, selected_profile.as_ref(), npc_binding.as_ref());
    let is_hero = state.get("players").and_then(Value::as_array).is_some_and(|players| players.iter().any(|hero| command.get("actor_id").and_then(Value::as_str) == Some(game::actor_id(hero).as_str())));
    let mut visual_input = Map::new();
    copy_field(&mut visual_input, "item", selected_item.as_ref());
    if is_hero {
        copy_field(&mut visual_input, "items", at(actor_ref, "inventory"));
    }
    visual_input.insert("attackKind".into(), Value::from(attack_kind));
    copy_field(&mut visual_input, "actionName", at(profile_ref, "name"));
    let attack_visual = sk_scene_base::actor_appearance::attack_visual_for(Some(&Value::Object(visual_input)));
    let selected_properties = at(selected_profile.as_ref(), "properties");
    let loading_weapon = matches!(selected_properties, Some(Value::Array(items)) if items.iter().any(|item| item.as_str() == Some("loading")))
        || matches!(selected_properties, Some(Value::String(text)) if text.contains("loading"));
    let loading_limit = loading_weapon && crate::combat::turn::loading_weapon_limit_applies(&state, actor_ref, selected_profile.as_ref());
    let loading_resource = if loading_limit { Some(crate::turn_economy::loading_resource_for_command(&command, &r.context, None)) } else { None };
    let attack_resource = crate::turn_economy::loading_resource_for_command(&command, &r.context, None);
    let attack_action = crate::combat::turn::attack_action_plan(&state, &command, &r.context);
    let mut payload = spread_value(Some(&attack));
    payload.insert("target_id".into(), target_value.clone());
    payload.insert("armor_class".into(), js::num(armor_class));
    payload.insert("hit".into(), Value::Bool(landed));
    if intercepted_by_image {
        payload.insert("mirror_image_intercepted".into(), Value::Bool(true));
        payload.insert("mirror_images_before".into(), json!(mirror_images));
    }
    let shield_choice = r.protective_reaction_choices.get(&protective_attack_key);
    if shield_choice.is_some_and(|choice| js::is_true(choice.get("use")) && choice.get("kind").and_then(Value::as_str) == Some("shield")) {
        payload.insert("shielded_by_reaction".into(), Value::Bool(true));
    }
    if colossus_slayer {
        payload.insert("colossus_slayer_turn_key".into(), Value::String(crate::turn_economy::combat_turn_key(&state, &actor_id).unwrap_or_default()));
    }
    payload.insert("critical".into(), Value::Bool(critical));
    if critical_before_protection && !critical {
        payload.insert("critical_prevented".into(), Value::Bool(true));
        payload.insert("natural_critical".into(), Value::Bool(kept == 20.0));
        payload.insert("critical_protection_sources".into(), Value::Array(critical_protection_sources.clone()));
    }
    if condition_modifiers.automatic_critical && critical && kept != 20.0 {
        payload.insert("automatic_critical".into(), Value::Bool(true));
    }
    if critical && kept < 20.0 && kept >= critical_threshold {
        payload.insert("improved_critical".into(), Value::Bool(true));
    }
    if !condition_modifiers.advantage.is_empty() {
        payload.insert("condition_advantage".into(), js::strings_value(condition_modifiers.advantage.clone()));
    }
    if !condition_modifiers.disadvantage.is_empty() {
        payload.insert("condition_disadvantage".into(), js::strings_value(condition_modifiers.disadvantage.clone()));
    }
    if !swing.advantage_sources.is_empty() {
        payload.insert("advantage_sources".into(), js::strings_value(swing.advantage_sources.clone()));
    }
    if !swing.disadvantage_sources.is_empty() {
        payload.insert("disadvantage_sources".into(), js::strings_value(swing.disadvantage_sources.clone()));
    }
    if cover_bonus > 0.0 {
        copy_field(&mut payload, "cover", cover.get("level"));
        copy_field(&mut payload, "cover_bonus", cover.get("armorClassBonus"));
        copy_field(&mut payload, "cover_blockers", cover.get("blockers"));
        if js::truthy(cover.get("scenery")) {
            copy_field(&mut payload, "cover_scenery", cover.get("scenery"));
        }
    }
    if swing.high_ground != "level" {
        payload.insert("high_ground".into(), Value::from(swing.high_ground));
    }
    payload.insert("range_feet".into(), coalesce(&[at(profile_ref, "range_feet")]).cloned().unwrap_or(Value::Null));
    payload.insert("distance_feet".into(), distance_feet.map_or(Value::Null, js::num));
    payload.insert("damage_expression".into(), coalesce(&[configured_damage_expression.as_ref()]).cloned().unwrap_or(Value::Null));
    payload.insert("damage_type".into(), damage_type.clone());
    payload.insert("item_id".into(), coalesce(&[at(selected_item.as_ref(), "id")]).cloned().unwrap_or(Value::Null));
    payload.insert("item_name".into(), coalesce(&[at(selected_item.as_ref(), "name")]).cloned().unwrap_or(Value::Null));
    payload.insert("attack_mode".into(), coalesce(&[at(selected_profile.as_ref(), "mode")]).cloned().unwrap_or(Value::Null));
    payload.insert("attack_ability".into(), coalesce(&[at(selected_profile.as_ref(), "ability")]).cloned().unwrap_or(Value::Null));
    payload.insert("weapon_properties".into(), coalesce(&[at(weapon_source.as_ref(), "properties"), at(profile_ref, "properties")]).cloned().unwrap_or_else(|| json!([])));
    payload.insert("magical".into(), Value::Bool(js::is_true(at(weapon_source.as_ref(), "magical"))));
    payload.insert("attack_kind".into(), Value::from(attack_kind));
    payload.insert("attack_visual".into(), attack_visual);
    if loading_weapon {
        payload.insert("loading_weapon".into(), Value::Bool(true));
        payload.insert("loading_limit_applies".into(), Value::Bool(loading_limit));
        if let Some(resource) = loading_resource {
            payload.insert("loading_action_type".into(), Value::from(resource));
        }
    }
    payload.insert("action_economy_version".into(), Value::from(crate::turn_economy::ACTION_ECONOMY_EVENT_VERSION));
    payload.insert("attack_action_resource".into(), Value::String(attack_action.resource.clone()));
    if attack_action.resource == "action" {
        payload.insert("attack_action_id".into(), attack_action.id.clone().map_or(Value::Null, Value::String));
        payload.insert("attack_action_boundary".into(), js::opt_str(attack_action.boundary));
        payload.insert("attack_action_kind".into(), Value::String(attack_action.kind.clone()));
        payload.insert("attack_action_limit".into(), Value::from(attack_action.limit));
        payload.insert("attack_action_spends_action".into(), Value::Bool(attack_action.spends_action));
        if let Some(extra) = attack_action.extra_kind.clone().filter(|extra| !extra.is_empty()) {
            payload.insert("attack_action_extra_kind".into(), Value::String(extra));
        }
    }
    if js::truthy(at(selected_profile.as_ref(), "two_handed")) {
        payload.insert("two_handed".into(), Value::Bool(true));
    }
    if js::truthy(at(selected_profile.as_ref(), "thrown")) {
        payload.insert("thrown".into(), Value::Bool(true));
    }
    if sneak_attack_requested {
        payload.insert("sneak_attack_requested".into(), Value::Bool(true));
        payload.insert("sneak_attack_eligible_by".into(), Value::from(if advantage { "advantage" } else { "ally" }));
        if let Some(supporter) = &sneak_attack_supporter {
            payload.insert("sneak_attack_supporter_id".into(), Value::String(game::actor_id(supporter)));
        }
    }
    if js::truthy(command.get("request_fingerprint")) {
        copy_field(&mut payload, "request_fingerprint", command.get("request_fingerprint"));
    }
    if attack_resource != "action" {
        payload.insert("economy".into(), json!({ "action": false, "attack": false }));
    }
    payload.insert("action_id".into(), coalesce(&[at(profile_ref, "id")]).cloned().unwrap_or(Value::Null));
    payload.insert("action_name".into(), coalesce(&[at(profile_ref, "name")]).cloned().unwrap_or(Value::Null));
    if recharge_minimum_of(profile_ref) > 0 {
        payload.insert("recharge_action".into(), Value::Bool(true));
    }
    payload.insert("pack_tactics".into(), Value::Bool(pack_tactics));
    payload.insert("bloodied_frenzy".into(), Value::Bool(bloodied_frenzy));
    payload.insert("charge".into(), Value::Bool(charge_active));
    // Траектория начинается с anchor тела, а не с первой клетки луча.
    let trajectory = match (actor_at, target_at) {
        (Some(from), Some(to)) => {
            let mut cells = vec![from];
            cells.extend(line_cells(from, to));
            points_json(&cells)
        }
        _ => json!([]),
    };
    payload.insert("trajectory".into(), trajectory);
    payload.insert("long_range".into(), Value::Bool(long_range));
    payload.insert("reaction_attack".into(), Value::Bool(js::is_true(command.get("reaction_attack"))));
    let mut attack_event = event_from(&attack_command, "AttackResolved", Some(Value::Object(payload)), Some(&targets(&target_value)));
    attack_event["event_id"] = Value::String(attack_resolved_event_id.clone());
    r.events.push(attack_event);
    if selected_profile.is_some() && !js::truthy(at(selected_item.as_ref(), "equipped")) {
        let mut changed = Map::new();
        copy_field(&mut changed, "item_id", at(selected_item.as_ref(), "id"));
        copy_field(&mut changed, "item_name", at(selected_item.as_ref(), "name"));
        changed.insert("equipped".into(), Value::Bool(true));
        changed.insert("timing".into(), json!("before_attack"));
        changed.insert("turns_spent".into(), json!(0));
        let event = event_from(&attack_command, "EquipmentChanged", Some(Value::Object(changed)), Some(&targets(&actor_value)));
        let index = r.events.len() - 1;
        r.events.insert(index, event);
    }
    let conditions_command = command_with_rules(&command, &[rule_ids::CONDITIONS]);
    let remove = |condition: &str| event_from(&conditions_command, "ConditionRemoved", Some(json!({ "condition": condition })), Some(&targets(&actor_value)));
    if actor_conditions.contains("disadvantage-next-attack") {
        r.events.push(remove("disadvantage-next-attack"));
    }
    if actor_conditions.contains("disadvantage-next-weapon-attack") {
        r.events.push(remove("disadvantage-next-weapon-attack"));
    }
    if true_strike {
        r.events.push(remove("true-strike"));
    }
    if silvery_fortune {
        r.events.push(crate::spells::enervation::remove_silvery_fortune_event(&command, &state, &actor_id, None));
    }
    // Малое благословение расходуется ровно там, где применилось.
    if actor_conditions.contains(sk_npc_world::blessings::BLESSING_CONDITION) {
        r.events.push(event_from(&conditions_command, "ConditionRemoved", Some(json!({ "condition": sk_npc_world::blessings::BLESSING_CONDITION, "trigger": "attack" })), Some(&targets(&actor_value))));
    }
    if guiding_bolt_advantage {
        r.events.push(event_from(&conditions_command, "ConditionRemoved", Some(json!({ "condition": "guiding-bolt-advantage" })), Some(&targets(&target_value))));
    }
    let actor_condition_values = condition_id_values(&state, &actor_id);
    if let Some(marker) = sk_combat_base::monster_actions::monster_action_spent_marker(profile_ref, &actor_condition_values) {
        r.events.push(event_from(&conditions_command, "ConditionAdded", Some(json!({ "condition": marker, "source_actor": actor_value })), Some(&targets(&actor_value))));
    }
    // Стрела уходит из колчана и на промахе тоже.
    if let Some(binding) = &npc_binding {
        if let Some(expenditure) = sk_economy::npc_equipment::npc_attack_expenditure_for(actor_ref, binding.get("action_id")) {
            let mut spent = Map::new();
            spent.insert("action_id".into(), binding.get("action_id").cloned().unwrap_or(Value::Null));
            spent.extend(spread_value(Some(&expenditure)));
            r.events.push(crate::combat::npc_items::npc_equipment_spent_event(&command, &Value::Object(spent)));
        }
    }
    let hero_expenditure = if selected_profile.is_some() && !actor_is_enemy { hero_ammunition_expenditure(actor_ref, selected_profile.as_ref()) } else { None };
    if let Some(expenditure) = hero_expenditure {
        let mut spent = Map::new();
        spent.insert("schema_version".into(), Value::from(AMMUNITION_SPENT_EVENT_SCHEMA_VERSION));
        spent.insert("owner_id".into(), Value::String(js::string(command.get("actor_id"))));
        spent.insert("weapon_item_id".into(), Value::String(js::s(at(selected_item.as_ref(), "id"))));
        spent.insert("weapon_name".into(), Value::String(js::s(at(selected_item.as_ref(), "name"))));
        spent.extend(spread_value(Some(&expenditure)));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::ATTACK]), "AmmunitionSpent", Some(Value::Object(spent)), Some(&targets(&actor_value))));
    }
    // Метательное оружие героя падает у цели — и на промахе тоже.
    if attack_kind == "thrown" && js::truthy(selected_item.as_ref()) && !actor_is_enemy {
        let position = point_or_null(actor_point(&state, &target_id));
        let info = sk_director::loot_containers::ThrownWeaponInfo { command_id: command.get("command_id"), owner_id: command.get("actor_id"), item: selected_item.as_ref(), position: Some(&position) };
        let drop = sk_director::loot_containers::thrown_weapon_drop_draft(&state, info).map_err(|error| {
            let fault = Fault::new(error.name, error.message);
            Halt::Fault(match error.code {
                Some(code) => fault.with_code(code),
                None => fault,
            })
        })?;
        if let Some(drop) = drop {
            let source = command_with(&command_with_rules(&command, &[rule_ids::ATTACK]), "visibility", drop.get("visibility").cloned().unwrap_or(Value::Null));
            let mut event = event_from(&source, &js::s(drop.get("event_type")), drop.get("payload").cloned(), drop.get("target_ids"));
            event["event_schema_version"] = drop.get("event_schema_version").cloned().unwrap_or(Value::Null);
            r.events.push(event);
        }
    }
    if helped {
        r.events.push(remove("helped"));
    }
    if hidden {
        r.events.push(remove("hidden"));
    }
    let on_hit = at(profile_ref, "on_hit").filter(|value| js::truthy(Some(value))).cloned();
    let mut secondary_damage: Option<(f64, String, Value)> = None;
    if landed && (configured.is_some() || js::present(command.get("damage_amount"))) {
        let damage_expression = match configured {
            Some(expression) if critical => Some(Value::String(critical_damage_expression(&js::s(Some(expression)))?)),
            other => other.cloned(),
        };
        let rolled_damage = match damage_expression.filter(|value| js::truthy(Some(value))) {
            Some(expression) => {
                let visibility = r.visibility();
                Some(r.roll_dice(expression, "damage", actor_value.clone(), visibility)?)
            }
            None => None,
        };
        let (damage_roll, rerolls) = match rolled_damage {
            Some(rolled) if js::is_true(at(profile_ref, "great_weapon_fighting")) => {
                let great = great_weapon_fighting_reroll(&rolled, &mut r.dice, &command)?;
                (Some(great.roll), great.rerolls)
            }
            other => (other, Vec::new()),
        };
        if let Some(roll) = &damage_roll {
            r.rolls.push(roll.clone());
            r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        }
        for reroll in rerolls {
            r.rolls.push(reroll.clone());
            r.events.push(event_from(&command, "DieRolled", Some(spread(&reroll, vec![("great_weapon_fighting", json!(true))])), Some(&json!([]))));
        }
        let sneak_attack_dice = if sneak_attack_requested { sneak_attack_dice_count(actor_ref) } else { 0 };
        let sneak_attack_roll = if sneak_attack_dice > 0 {
            let expression = if critical { format!("{}d6", sneak_attack_dice * 2) } else { format!("{sneak_attack_dice}d6") };
            let visibility = r.visibility();
            Some(r.roll_dice(Value::String(expression), "sneak_attack_damage", actor_value.clone(), visibility)?)
        } else {
            None
        };
        if let Some(roll) = &sneak_attack_roll {
            r.rolls.push(roll.clone());
            let source = command_with_rules(&command, &[rule_ids::DAMAGE, if critical { rule_ids::CRITICAL_HIT } else { "" }]);
            r.events.push(event_from(&source, "DieRolled", Some(spread(roll, vec![("sneak_attack", json!(true)), ("damage_type", damage_type.clone())])), Some(&json!([]))));
            let mut applied = Map::new();
            copy_field(&mut applied, "roll_id", roll.get("roll_id"));
            copy_field(&mut applied, "expression", roll.get("expression"));
            copy_field(&mut applied, "dice", roll.get("dice"));
            copy_field(&mut applied, "damage", roll.get("total"));
            applied.insert("damage_type".into(), damage_type.clone());
            applied.insert("critical".into(), Value::Bool(critical));
            applied.insert("turn_key".into(), sneak_attack_turn_key.clone().map_or(Value::Null, Value::String));
            applied.insert("eligible_by".into(), Value::from(if advantage { "advantage" } else { "ally" }));
            if let Some(supporter) = &sneak_attack_supporter {
                applied.insert("supporter_id".into(), Value::String(game::actor_id(supporter)));
            }
            r.events.push(event_from(&source, "SneakAttackApplied", Some(Value::Object(applied)), Some(&targets(&target_value))));
        }
        let marked = target_conditions.contains(&format!("hunters-mark:{actor_id}")) || target_conditions.contains("hunters-mark") || target_conditions.contains("favored-foe");
        let level = js::safe_int(at(actor_ref, "level"), 1);
        let mark_sides = if target_conditions.contains("favored-foe") {
            if level >= 10 {
                8
            } else if level >= 6 {
                6
            } else {
                4
            }
        } else {
            6
        };
        let mark_roll = if marked {
            let roll = r.attack_roll(Value::String(if critical { format!("2d{mark_sides}") } else { format!("1d{mark_sides}") }), "marked_target_damage", &actor_value)?;
            r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
            Some(roll)
        } else {
            None
        };
        let colossus_roll = if colossus_slayer {
            let roll = r.attack_roll(Value::from(if critical { "2d8" } else { "1d8" }), "colossus_slayer_damage", &actor_value)?;
            r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("colossus_slayer", json!(true)), ("damage_type", damage_type.clone())])), Some(&json!([]))));
            Some(roll)
        } else {
            None
        };
        let hexed = target_conditions.contains(&format!("hexed:{actor_id}"));
        let hex_roll = if hexed {
            let roll = r.attack_roll(Value::from(if critical { "2d6" } else { "1d6" }), "spell:hex:damage", &actor_value)?;
            r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("damage_type", json!("necrotic"))])), Some(&json!([]))));
            Some(roll)
        } else {
            None
        };
        let divine_favor_roll = if actor_conditions.contains("divine-favor") {
            let roll = r.attack_roll(Value::from(if critical { "2d4" } else { "1d4" }), "spell:divine-favor:damage", &actor_value)?;
            r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("damage_type", json!("radiant"))])), Some(&json!([]))));
            Some(roll)
        } else {
            None
        };
        let mut savage_attack_roll: Option<Value> = None;
        if critical && selected_profile.is_some() && kind == Some("melee") && js::is_true(js::path(actor_ref.unwrap_or(&Value::Null), &["speciesBenefits", "mechanics", "savage_attacks"])) {
            // Разбор выражения и бросок — в `try`: кривое выражение оружия ловит
            // проверка профиля, а здесь ошибка молча гасится.
            let expression = configured_damage_expression.as_ref().map_or_else(|| "undefined".to_string(), |value| js::string(Some(value)));
            if let Ok(parsed) = sk_dice::parse_dice_expression(&expression) {
                let visibility = r.visibility();
                if let Ok(roll) = r.roll_dice(Value::String(format!("1d{}", parsed.sides)), "species:savage-attacks", actor_value.clone(), visibility) {
                    r.rolls.push(roll.clone());
                    r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CRITICAL_HIT]), "DieRolled", Some(spread(&roll, vec![("species_trait", json!("savage-attacks")), ("damage_type", damage_type.clone())])), Some(&json!([]))));
                    savage_attack_roll = Some(roll);
                }
            }
        }
        let mut item_rider_rolls: Vec<(Value, Value)> = Vec::new();
        for rider in &item_damage_riders {
            let expression = if critical && js::truthy(rider.get("critical_doubles")) { Value::String(critical_damage_expression(&js::s(rider.get("expression")))?) } else { rider.get("expression").cloned().unwrap_or(Value::Null) };
            let subject = js::string(coalesce(&[rider.get("purpose_subject"), rider.get("effect_id")]));
            let roll = r.attack_roll(expression, &format!("item_damage:{subject}"), &actor_value)?;
            let mut rolled = spread_value(Some(&roll));
            for key in ["item_id", "item_name", "catalog_id", "effect_id", "damage_type"] {
                copy_field(&mut rolled, key, rider.get(key));
            }
            rolled.insert("item_damage_rider".into(), Value::Bool(true));
            r.events.push(event_from(&command, "DieRolled", Some(Value::Object(rolled)), Some(&json!([]))));
            item_rider_rolls.push((rider.clone(), roll));
        }
        let rage_bonus = if actor_conditions.contains("raging") && js::number(Some(coalesce(&[at(profile_ref, "range_feet")]).unwrap_or(&Value::from(5)))) <= 5.0 {
            if level >= 9 {
                3
            } else {
                2
            }
        } else {
            0
        };
        // Лишние кости от зачарований; на крите кость удваивается.
        let mut enchantment_damage = condition_numeric_bonus(&state, &actor_id, "weaponDamageBonus") as f64;
        let mut typed_condition_riders: Vec<(Value, String, String)> = Vec::new();
        for die in condition_weapon_damage_dice(&state, &actor_id, distance_feet) {
            let expression = if critical { critical_damage_expression(&die.expression)? } else { die.expression.clone() };
            let roll = r.attack_roll(Value::String(expression), &format!("condition_damage:{}", die.condition), &actor_value)?;
            r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("condition", Value::String(die.condition.clone())), ("sign", json!(die.sign))])), Some(&json!([]))));
            let record = actor_condition_list.iter().find(|condition| at(Some(condition), "id").and_then(Value::as_str) == Some(die.condition.as_str()));
            let option = js::s(at(record, "spell_option"));
            let chosen = game::uses_2014(&state) && die.sign > 0 && crate::combat::turn::TYPED_RIDER_DAMAGE_TYPES.contains(&option.as_str());
            if chosen {
                let spell_id = js::string(Some(coalesce(&[at(record, "spell_id")]).unwrap_or(&Value::String(die.condition.clone()))));
                typed_condition_riders.push((roll, option, spell_id));
            } else {
                enchantment_damage += number(&roll, "total") * die.sign as f64;
            }
        }
        // В 2014 кости Сглаза и Благоволения — свой тип урона, отдельным `DamageApplied`.
        let mut edition_spell_riders: Vec<(Value, String, String)> = Vec::new();
        if game::uses_2014(&state) {
            for (roll, kind_name, spell_id) in [(hex_roll.as_ref(), "necrotic", "hex"), (divine_favor_roll.as_ref(), "radiant", "divine-favor")] {
                if let Some(roll) = roll.filter(|roll| number(roll, "total") > 0.0) {
                    edition_spell_riders.push((roll.clone(), kind_name.to_string(), spell_id.to_string()));
                }
            }
            edition_spell_riders.extend(typed_condition_riders.iter().filter(|(roll, _, _)| number(roll, "total") > 0.0).cloned());
        }
        let total_of = |roll: Option<&Value>| roll.map_or(0.0, |roll| number(roll, "total"));
        let folded_spell_rider_damage = if edition_spell_riders.is_empty() { total_of(hex_roll.as_ref()) + total_of(divine_favor_roll.as_ref()) } else { 0.0 };
        // Божественная кара: 2к8 за 1-й круг, +1к8 за круг выше (до 5к8), +1к8 по нежити и исчадиям.
        let smite_roll = match r.context.divine_smite.clone() {
            Some(smite) => {
                let creature_type = js::s(coalesce(&[at(target_ref, "creature_type"), at(target_ref, "creatureType"), at(target_ref, "type")])).to_lowercase();
                let extra = if text::test(sk_core::re!(r"undead|fiend|нежить|исчади", "u"), &creature_type) { 1 } else { 0 };
                let slot_level = js::safe_int(smite.get("slot_level"), 1);
                let count = (1 + slot_level).min(5) + extra;
                let roll = r.attack_roll(Value::String(format!("{}d8", if critical { count * 2 } else { count })), "divine_smite_damage", &actor_value)?;
                r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("damage_type", json!("radiant")), ("divine_smite", json!(true)), ("slot_level", json!(slot_level))])), Some(&json!([]))));
                Some(roll)
            }
            None => None,
        };
        let mut typed_spell_riders = edition_spell_riders.clone();
        if let Some(roll) = smite_roll.as_ref().filter(|roll| number(roll, "total") > 0.0) {
            typed_spell_riders.push((roll.clone(), "radiant".into(), "divine-smite".into()));
        }
        let base_damage = match &damage_roll {
            Some(roll) => number(roll, "total"),
            None => js::safe_int(command.get("damage_amount"), 0).max(0) as f64,
        };
        let mut raw = base_damage
            + total_of(sneak_attack_roll.as_ref())
            + total_of(mark_roll.as_ref())
            + total_of(colossus_roll.as_ref())
            + folded_spell_rider_damage
            + total_of(savage_attack_roll.as_ref())
            + rage_bonus as f64
            + enchantment_damage;
        // Ослабление режет вдвое удар от нужной характеристики.
        let ability = js::string(Some(coalesce(&[at(profile_ref, "ability")]).unwrap_or(&Value::from("str"))));
        let enfeebling = actor_conditions.iter().find(|condition| {
            let halves = crate::tables::condition_effect(condition).and_then(|effect| effect.get("halvesWeaponDamageForAbility"));
            js::truthy(halves) && js::string(halves) == ability
        });
        if enfeebling.is_some() {
            raw = (raw / 2.0).floor();
        }
        // Штрафная кость Уменьшения не делает урон отрицательным.
        raw = crate::tactical_geometry::js_max(0.0, raw);
        let martial_advantage = monster_trait_for(actor_ref, "martial-advantage").filter(|value| js::truthy(Some(value)));
        let surprise_attack = monster_trait_for(actor_ref, "surprise-attack").filter(|value| js::truthy(Some(value)));
        let trait_from = |trait_value: &Value| match trait_value.get("damage_expression").filter(|value| js::truthy(Some(value))) {
            Some(value) => js::string(Some(value)),
            None => "2d6".to_string(),
        };
        let trait_damage_expression = if let (Some(martial), true) = (martial_advantage, allied_support) {
            Some(trait_from(martial))
        } else if let (Some(surprise), true) = (surprise_attack, hidden && js::safe_int(game::combat(&state).get("round"), 1) == 1) {
            Some(trait_from(surprise))
        } else {
            None
        };
        if let Some(expression) = trait_damage_expression {
            let expression = if critical { critical_damage_expression(&expression)? } else { expression };
            let roll = r.attack_roll(Value::String(expression), "monster_trait_damage", &actor_value)?;
            let trait_id = if martial_advantage.is_some() && allied_support { "martial-advantage" } else { "surprise-attack" };
            r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("trait_id", json!(trait_id))])), Some(&json!([]))));
            raw += number(&roll, "total");
        }
        let mut pending_condition: Option<Value> = None;
        if let Some(on_hit) = on_hit.as_ref().filter(|on_hit| sk_combat_base::monster_actions::monster_on_hit_target_allowed(on_hit, target_ref)) {
            let mut saved = false;
            if js::truthy(on_hit.get("save_ability")) {
                let save_ability = js::string(on_hit.get("save_ability"));
                let save_dc = js::safe_int(on_hit.get("save_dc"), 10).max(1);
                let mut options = Map::new();
                options.insert("ability".into(), Value::String(save_ability.clone()));
                options.insert("modifier".into(), Value::from(ability_modifier(at(at(target_ref, "abilities"), &save_ability))));
                options.insert("difficulty".into(), Value::from(save_dc));
                options.insert("purpose".into(), Value::String(format!("monster_action_save:{}:{save_ability}", js::string(at(profile_ref, "id")))));
                options.insert("avoid_or_end_condition".into(), if on_hit.get("condition").and_then(Value::as_str) == Some("poisoned") { json!("poisoned") } else { Value::Null });
                options.insert("visibility".into(), undef(command.get("visibility")));
                let save = roll_saving_throw_check(&state, &mut r.dice, &target_id, &Value::Object(options))?;
                r.rolls.push(save.clone());
                saved = js::truthy(save.get("success"));
                let payload = spread(&save, vec![("ability", Value::String(save_ability)), ("action_id", at(profile_ref, "id").cloned().unwrap_or(Value::Null))]);
                r.events.push(event_from(&conditions_command, "SavingThrowResolved", Some(strip_missing(payload, "action_id", at(profile_ref, "id"))), Some(&targets(&target_value))));
            }
            if js::truthy(on_hit.get("damage_expression")) {
                let base = js::string(on_hit.get("damage_expression"));
                let secondary_expression = if critical && game::uses_2014(&state) && !js::truthy(on_hit.get("save_ability")) { critical_damage_expression(&base)? } else { base };
                let secondary = r.attack_roll(Value::String(secondary_expression), "monster_action_damage", &actor_value)?;
                let secondary_type = match on_hit.get("damage_type").filter(|value| js::truthy(Some(value))) {
                    Some(value) => js::string(Some(value)),
                    None => damage_type_text.clone(),
                };
                let mut rolled = spread_value(Some(&secondary));
                copy_field(&mut rolled, "action_id", at(profile_ref, "id"));
                rolled.insert("damage_type".into(), Value::String(secondary_type.clone()));
                r.events.push(event_from(&command, "DieRolled", Some(Value::Object(rolled)), Some(&json!([]))));
                let total = number(&secondary, "total");
                let amount = if saved && js::truthy(on_hit.get("half_on_save")) {
                    (total / 2.0).floor()
                } else if saved {
                    0.0
                } else {
                    total
                };
                secondary_damage = Some((amount, secondary_type, at(profile_ref, "id").cloned().unwrap_or(Value::String(js::UNDEFINED.into()))));
            }
            let target_size_allowed = !js::truthy(on_hit.get("target_size_max")) || crate::tactical_geometry::creature_size_rank(target_ref) <= crate::geometry::movement::size_rank_by_name(on_hit.get("target_size_max"));
            if js::truthy(on_hit.get("condition")) && !saved && target_size_allowed {
                let mut condition = Map::new();
                condition.insert("id".into(), Value::String(js::string(on_hit.get("condition"))));
                condition.insert("duration".into(), coalesce(&[on_hit.get("duration")]).cloned().unwrap_or(Value::Null));
                if js::number(on_hit.get("duration_minutes")) > 0.0 {
                    let elapsed = js::number(Some(coalesce(&[js::path(game::mechanics(&state), &["world_time", "elapsed_minutes"])]).unwrap_or(&Value::from(0))));
                    condition.insert("expires_at_minutes".into(), js::num(js_add(elapsed, on_hit.get("duration_minutes")).ceil()));
                }
                if js::truthy(on_hit.get("repeat_save_timing")) {
                    copy_field(&mut condition, "repeat_save_timing", on_hit.get("repeat_save_timing"));
                    copy_field(&mut condition, "save_ability", on_hit.get("save_ability"));
                    copy_field(&mut condition, "save_dc", on_hit.get("save_dc"));
                }
                // СЛ освобождения из листа чудовища.
                let escape = js::safe_int(on_hit.get("escape_dc"), 0);
                if escape > 0 {
                    condition.insert("escape_dc".into(), Value::from(escape));
                }
                pending_condition = Some(Value::Object(condition));
            }
        }
        if charge_active {
            let charge = charge_trait.as_ref().cloned().unwrap_or(Value::Null);
            if js::truthy(charge.get("damage_expression")) {
                let base = js::string(charge.get("damage_expression"));
                let expression = if critical { critical_damage_expression(&base)? } else { base };
                let roll = r.attack_roll(Value::String(expression), "monster_trait_damage", &actor_value)?;
                r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("trait_id", json!("charge"))])), Some(&json!([]))));
                raw += number(&roll, "total");
            }
            let mut saved = false;
            if js::truthy(charge.get("save_ability")) {
                let save_ability = js::string(charge.get("save_ability"));
                let save_dc = js::safe_int(charge.get("save_dc"), 10).max(1);
                let mut options = Map::new();
                options.insert("ability".into(), Value::String(save_ability.clone()));
                options.insert("modifier".into(), Value::from(ability_modifier(at(at(target_ref, "abilities"), &save_ability))));
                options.insert("difficulty".into(), Value::from(save_dc));
                options.insert("purpose".into(), Value::String(format!("monster_trait_save:charge:{save_ability}")));
                options.insert("visibility".into(), undef(command.get("visibility")));
                let save = roll_saving_throw_check(&state, &mut r.dice, &target_id, &Value::Object(options))?;
                r.rolls.push(save.clone());
                saved = js::truthy(save.get("success"));
                r.events.push(event_from(&conditions_command, "SavingThrowResolved", Some(spread(&save, vec![("ability", Value::String(save_ability)), ("trait_id", json!("charge"))])), Some(&targets(&target_value))));
            }
            if js::truthy(charge.get("condition")) && !saved {
                pending_condition = Some(json!({ "id": js::string(charge.get("condition")), "duration": coalesce(&[charge.get("duration")]).cloned().unwrap_or(Value::Null) }));
            }
        }
        let can_knock_out = js::is_true(command.get("knock_out")) && kind == Some("melee");
        let mut knocked_out = false;
        let mut apply_knockout_choice = |resolved: Value| -> Value {
            if !can_knock_out || number(&resolved, "hp_before") <= 0.0 || resolved.get("hp_after").and_then(Value::as_f64) != Some(0.0) {
                return resolved;
            }
            knocked_out = true;
            let before = number(&resolved, "hp_before");
            spread(&resolved, vec![("hp_after", json!(1)), ("applied_amount", js::num((before - 1.0).max(0.0))), ("knocked_out", json!(true))])
        };
        let mut payload = r.resolve_damage_payload(&state, &target_id, js::num(raw), &damage_type, None, weapon_source.as_ref())?;
        let attack_protection_choice = r.protective_reaction_choices.get(&protective_attack_key).cloned();
        let protection_used = |wanted: &str| attack_protection_choice.as_ref().is_some_and(|choice| js::is_true(choice.get("use")) && choice.get("kind").and_then(Value::as_str) == Some(wanted));
        if protection_used("uncanny-dodge") {
            payload = uncanny_dodge_damage_payload(&payload);
        }
        if protection_used("absorb-elements") {
            payload = absorb_elements_damage_payload(&payload, &state, &target_id)?;
        }
        payload = apply_knockout_choice(payload);
        if let Some(roll) = &sneak_attack_roll {
            payload = spread(
                &payload,
                vec![
                    ("sneak_attack", json!(true)),
                    ("sneak_attack_damage", roll.get("total").cloned().unwrap_or(Value::Null)),
                    ("sneak_attack_expression", roll.get("expression").cloned().unwrap_or(Value::Null)),
                    ("sneak_attack_roll_id", roll.get("roll_id").cloned().unwrap_or(Value::Null)),
                    ("sneak_attack_critical", Value::Bool(critical)),
                ],
            );
        }
        if let Some(roll) = &savage_attack_roll {
            payload = spread(
                &payload,
                vec![
                    ("savage_attacks", json!(true)),
                    ("savage_attacks_damage", roll.get("total").cloned().unwrap_or(Value::Null)),
                    ("savage_attacks_expression", roll.get("expression").cloned().unwrap_or(Value::Null)),
                    ("savage_attacks_roll_id", roll.get("roll_id").cloned().unwrap_or(Value::Null)),
                ],
            );
        }
        if payload.get("hp_after").and_then(Value::as_f64) == Some(0.0) && monster_trait_for(target_ref, "undead-fortitude").is_some_and(|value| js::truthy(Some(value))) && damage_type_text != "radiant" && kept != 20.0 {
            let difficulty = 5.0 + number(&payload, "applied_amount");
            let mut options = Map::new();
            options.insert("ability".into(), json!("con"));
            options.insert("modifier".into(), Value::from(ability_modifier(at(at(target_ref, "abilities"), "con"))));
            options.insert("difficulty".into(), js::num(difficulty));
            options.insert("purpose".into(), json!("undead_fortitude"));
            options.insert("visibility".into(), undef(command.get("visibility")));
            let fortitude = roll_saving_throw_check(&state, &mut r.dice, &target_id, &Value::Object(options))?;
            r.rolls.push(fortitude.clone());
            r.events.push(event_from(&conditions_command, "SavingThrowResolved", Some(spread(&fortitude, vec![("ability", json!("con")), ("trait_id", json!("undead-fortitude"))])), Some(&targets(&target_value))));
            if js::truthy(fortitude.get("success")) {
                let before = number(&payload, "hp_before");
                payload = spread(&payload, vec![("hp_after", json!(1)), ("applied_amount", js::num((before - 1.0).max(0.0))), ("undead_fortitude", json!(true)), ("undead_fortitude_dc", js::num(difficulty))]);
            }
        }
        if js::truthy(at(weapon_source.as_ref(), "magical")) {
            payload = spread(&payload, vec![("magical", json!(true))]);
        }
        r.events.push(event_from(&damage_command(&attack_command, &payload), "DamageApplied", Some(payload.clone()), Some(&targets(&target_value))));
        let mut final_payload = payload.clone();
        let component = |payload: &Value, source: &str| {
            let mut entry = Map::new();
            for key in ["damage_type", "raw_amount", "applied_amount", "temporary_hp_absorbed"] {
                copy_field(&mut entry, key, payload.get(key));
            }
            entry.insert("source".into(), Value::from(source));
            entry
        };
        let mut damage_components: Vec<Map<String, Value>> = vec![component(&payload, "weapon")];
        let mut after_damage_state = r.project_events()?;
        for (rider, roll) in &item_rider_rolls {
            let resolved = r.resolve_damage_payload(&after_damage_state, &target_id, roll.get("total").cloned().unwrap_or(Value::Null), rider.get("damage_type").unwrap_or(&Value::String(js::UNDEFINED.into())), None, None)?;
            let rider_payload = apply_knockout_choice(resolved);
            let mut body = spread_value(Some(&rider_payload));
            for key in ["item_id", "item_name", "catalog_id", "effect_id"] {
                copy_field(&mut body, key, rider.get(key));
            }
            body.insert("item_damage_rider".into(), json!(true));
            body.insert("critical_doubled".into(), if critical { rider.get("critical_doubles").cloned().unwrap_or(Value::Null) } else { json!(false) });
            let rider_event = event_from(&damage_command(&attack_command, &rider_payload), "DamageApplied", Some(strip_undefined_value(Value::Object(body))), Some(&targets(&target_value)));
            r.events.push(rider_event.clone());
            after_damage_state = apply_game_event(&after_damage_state, &rider_event)?;
            final_payload = rider_payload.clone();
            let mut entry = component(&rider_payload, "magic-item");
            for key in ["item_id", "catalog_id", "effect_id"] {
                copy_field(&mut entry, key, rider.get(key));
            }
            damage_components.push(entry);
        }
        for (roll, kind_name, spell_id) in &typed_spell_riders {
            if number(&final_payload, "hp_after") <= 0.0 {
                break;
            }
            let resolved = r.resolve_damage_payload(&after_damage_state, &target_id, roll.get("total").cloned().unwrap_or(Value::Null), &Value::String(kind_name.clone()), None, None)?;
            let rider_payload = apply_knockout_choice(resolved);
            let body = spread(&rider_payload, vec![("spell_id", Value::String(spell_id.clone())), ("spell_damage_rider", json!(true))]);
            let rider_event = event_from(&damage_command(&attack_command, &rider_payload), "DamageApplied", Some(body), Some(&targets(&target_value)));
            r.events.push(rider_event.clone());
            after_damage_state = apply_game_event(&after_damage_state, &rider_event)?;
            final_payload = rider_payload.clone();
            let mut entry = component(&rider_payload, "spell");
            entry.insert("spell_id".into(), Value::String(spell_id.clone()));
            damage_components.push(entry);
        }
        // Доза яда расходуется первым же попаданием, которое нанесло урон.
        if let Some(rider) = &weapon_coating_rider {
            let source = command_with_rules(&attack_command, &[rule_ids::CONDITIONS]);
            let mut body = Map::new();
            copy_field(&mut body, "condition", rider.get("condition_id"));
            body.insert("trigger".into(), json!("weapon-hit"));
            r.events.push(event_from(&source, "ConditionRemoved", Some(Value::Object(body)), Some(&targets(&actor_value))));
        }
        if let Some((amount, secondary_type, action_id)) = secondary_damage.clone().filter(|(amount, _, _)| *amount > 0.0) {
            if number(&final_payload, "hp_after") > 0.0 {
                let resolved = r.resolve_damage_payload(&after_damage_state, &target_id, js::num(amount), &Value::String(secondary_type), None, None)?;
                let secondary_payload = apply_knockout_choice(resolved);
                let mut body = spread_value(Some(&secondary_payload));
                body.insert("action_id".into(), action_id.clone());
                body.insert("secondary_damage".into(), json!(true));
                let secondary_event = event_from(&damage_command(&attack_command, &secondary_payload), "DamageApplied", Some(strip_undefined_value(Value::Object(body))), Some(&targets(&target_value)));
                r.events.push(secondary_event.clone());
                after_damage_state = apply_game_event(&after_damage_state, &secondary_event)?;
                final_payload = secondary_payload.clone();
                let mut entry = component(&secondary_payload, "secondary");
                entry.insert("action_id".into(), action_id);
                damage_components.push(entry);
            }
        }
        let outcome = if damage_components.len() == 1 {
            payload.clone()
        } else {
            let types: sk_core::indexmap::IndexSet<String> = damage_components.iter().map(|component| js::stringify(component.get("damage_type").unwrap_or(&Value::String(js::UNDEFINED.into())))).collect();
            let sum = |key: &str| damage_components.iter().fold(0.0, |total, component| total + js::number(component.get(key)));
            let absorbed: i64 = damage_components.iter().map(|component| js::safe_int(component.get("temporary_hp_absorbed"), 0)).sum();
            let mut combined = spread_value(Some(&final_payload));
            combined.insert("damage_type".into(), if types.len() == 1 { payload.get("damage_type").cloned().unwrap_or(Value::Null) } else { json!("mixed") });
            combined.insert("damage_components".into(), Value::Array(damage_components.iter().cloned().map(|entry| strip_undefined_value(Value::Object(entry))).collect()));
            combined.insert("raw_amount".into(), js::num(sum("raw_amount")));
            combined.insert("applied_amount".into(), js::num(sum("applied_amount")));
            combined.insert("temporary_hp_before".into(), payload.get("temporary_hp_before").cloned().unwrap_or(Value::String(js::UNDEFINED.into())));
            combined.insert("temporary_hp_absorbed".into(), Value::from(absorbed));
            combined.insert("hp_before".into(), payload.get("hp_before").cloned().unwrap_or(Value::String(js::UNDEFINED.into())));
            combined.insert("hp_after".into(), final_payload.get("hp_after").cloned().unwrap_or(Value::String(js::UNDEFINED.into())));
            strip_undefined_value(Value::Object(combined))
        };
        if knocked_out {
            r.events.push(event_from(
                &command_with_rules(&attack_command, &[rule_ids::ZERO_HP, rule_ids::CONDITIONS, rule_ids::RESOURCE]),
                "CreatureKnockedOut",
                Some(json!({ "condition": "unconscious", "rest_kind": "short", "recovery_minutes": 60, "attack_kind": "melee" })),
                Some(&targets(&target_value)),
            ));
        }
        let agathys = game::conditions(&state, &target_id).iter().find(|condition| game::condition_id(condition).starts_with("armor-of-agathys:")).cloned();
        let is_melee_hit = kind == Some("melee");
        let mut retaliation_state = after_damage_state.clone();
        let damage_source = command_with_rules(&command, &[rule_ids::DAMAGE]);
        if let Some(agathys) = agathys.as_ref().filter(|_| is_melee_hit && number(&payload, "temporary_hp_before") > 0.0) {
            let id = js::string(agathys.get("id"));
            let retaliation = js::safe_int(Some(&Value::String(text::slice(&id, "armor-of-agathys:".chars().count() as i64, None))), 0).max(0);
            let before = retaliation_state.clone();
            let retaliation_payload = r.resolve_damage_payload(&before, &actor_id, Value::from(retaliation), &json!("cold"), None, None)?;
            let event = event_from(&damage_source, "DamageApplied", Some(spread(&retaliation_payload, vec![("spell_id", json!("armor-of-agathys")), ("retaliation", json!(true))])), Some(&targets(&actor_value)));
            r.events.push(event.clone());
            retaliation_state = apply_game_event(&retaliation_state, &event)?;
            let consequences = crate::death::zero_hit_point_damage_consequences(&before, &command, &actor_id, &retaliation_payload, false);
            for consequence in &consequences {
                retaliation_state = apply_game_event(&retaliation_state, consequence)?;
            }
            r.events.extend(consequences);
        }
        if let Some(agathys) = &agathys {
            if outcome.get("temporary_hp_after").and_then(Value::as_f64) == Some(0.0) {
                r.events.push(event_from(&conditions_command, "ConditionRemoved", Some(json!({ "condition": js::string(agathys.get("id")) })), Some(&targets(&target_value))));
            }
        }
        // Отражение урона от состояния: щит жжёт того, кто дотянулся.
        for condition in &target_conditions {
            let retaliation_target = game::find_actor(&retaliation_state, &actor_id);
            if !retaliation_target.is_some_and(game::is_living_actor) && !crate::targets::is_dying_hero(&retaliation_state, &actor_id) {
                break;
            }
            let Some(retaliation) = crate::tables::condition_effect(condition).and_then(|effect| effect.get("retaliates")).filter(|value| js::truthy(Some(value))) else { continue };
            if !js::is_false(retaliation.get("meleeOnly")) && !is_melee_hit {
                continue;
            }
            if let Some(within) = retaliation.get("withinFeet").filter(|value| !value.is_null()) {
                if !distance_feet.is_some_and(|distance| distance <= js::number(Some(within))) {
                    continue;
                }
            }
            let visibility = r.visibility();
            let roll = r.roll_dice(Value::String(js::string(retaliation.get("damage"))), &format!("condition_retaliation:{condition}"), target_value.clone(), visibility)?;
            r.rolls.push(roll.clone());
            r.events.push(event_from(&command, "DieRolled", Some(spread(&roll, vec![("condition", Value::String(condition.clone()))])), Some(&json!([]))));
            let before = retaliation_state.clone();
            let retaliation_type = js::string(Some(coalesce(&[retaliation.get("damageType")]).unwrap_or(&Value::from("fire"))));
            let retaliation_payload = r.resolve_damage_payload(&before, &actor_id, roll.get("total").cloned().unwrap_or(Value::Null), &Value::String(retaliation_type), None, None)?;
            let event = event_from(&damage_source, "DamageApplied", Some(spread(&retaliation_payload, vec![("condition", Value::String(condition.clone())), ("retaliation", json!(true))])), Some(&targets(&actor_value)));
            r.events.push(event.clone());
            retaliation_state = apply_game_event(&retaliation_state, &event)?;
            let consequences = crate::death::zero_hit_point_damage_consequences(&before, &command, &actor_id, &retaliation_payload, false);
            for consequence in &consequences {
                retaliation_state = apply_game_event(&retaliation_state, consequence)?;
            }
            r.events.extend(consequences);
        }
        if let Some(condition) = pending_condition.as_ref().filter(|_| number(&final_payload, "hp_after") > 0.0) {
            let mut body = spread_value(Some(condition));
            body.insert("condition".into(), condition.get("id").cloned().unwrap_or(Value::Null));
            body.insert("source_actor".into(), actor_value.clone());
            body.insert("action_id".into(), coalesce(&[at(profile_ref, "id")]).cloned().unwrap_or(Value::Null));
            r.events.push(event_from(&conditions_command, "ConditionAdded", Some(Value::Object(body)), Some(&targets(&target_value))));
        }
        if target_conditions.contains("uncanny-dodge") {
            r.events.push(event_from(&conditions_command, "ConditionRemoved", Some(json!({ "condition": "uncanny-dodge" })), Some(&targets(&target_value))));
        }
        if steady_aim {
            r.events.push(remove("steady-aim"));
        }
        let poison = at(on_hit.as_ref(), "poison_on_zero");
        let poison_stabilizes = js::is_true(at(poison, "stable"))
            && secondary_damage.as_ref().is_some_and(|(_, kind_name, _)| kind_name == "poison")
            && number(&payload, "hp_after") > 0.0
            && final_payload.get("hp_after").and_then(Value::as_f64) == Some(0.0)
            && game::player_actor(&state, &target_id).is_some();
        if poison_stabilizes {
            let zero = command_with_rules(&attack_command, &[rule_ids::ZERO_HP]);
            r.events.push(event_from(&zero, "HitPointsReducedToZero", Some(json!({ "condition": "unconscious" })), Some(&targets(&target_value))));
            r.events.extend(crate::death::falls_prone_events(&state, &attack_command, &target_id));
            r.events.push(event_from(&zero, "HeroStabilized", Some(json!({ "method": "monster-poison" })), Some(&targets(&target_value))));
            let minutes = js::safe_int(at(poison, "poisoned_minutes"), 60).max(1);
            let mut list = vec!["poisoned"];
            if js::truthy(at(poison, "paralyzed_while_poisoned")) {
                list.push("paralyzed");
            }
            let elapsed = js::number(Some(coalesce(&[js::path(game::mechanics(&state), &["world_time", "elapsed_minutes"])]).unwrap_or(&Value::from(0))));
            let source = command_with_rules(&attack_command, &[rule_ids::CONDITIONS]);
            for condition in list {
                r.events.push(event_from(
                    &source,
                    "ConditionAdded",
                    Some(json!({ "condition": condition, "duration": format!("rounds:{}", minutes * 10), "source_actor": actor_value, "expires_at_minutes": js::num((elapsed + minutes as f64).ceil()) })),
                    Some(&targets(&target_value)),
                ));
            }
        } else {
            r.events.extend(crate::death::zero_hit_point_damage_consequences(&state, &attack_command, &target_id, &outcome, critical));
        }
        damage_outcome = Some(outcome);
    }
    // Заготовленный удар тратится и промахом, если так велит карточка.
    if let (true, Some(condition), Some(spell), Some(next)) = (landed || js::is_true(at(pwh, "resolvesOnMiss")), pending_weapon_hit_condition.as_ref(), spell_ref, pwh) {
        if pending_weapon_hit_matches {
            next_weapon_hit(r, &state, &NextWeaponHit { actor: actor_ref, target: target_ref, actor_id: &actor_id, actor_value: &actor_value, target_id: &target_id, target_value: &target_value, condition, spell, next, landed, critical })?;
        }
    }
    if let Some(condition) = absorbing_element_condition.as_ref().filter(|_| landed && absorbing_element_matches) {
        let condition_id = js::string(condition.get("id"));
        let rider_type = match condition.get("rider_damage_type").filter(|value| !value.is_null()) {
            Some(value) => js::string(Some(value)),
            None => text::replace_first(sk_core::re!(r"^absorbing-element:", "u"), &condition_id, "elemental"),
        };
        let slot_level = js::safe_int(condition.get("slot_level"), 1).max(1);
        let extra_levels = (slot_level - 1).max(0);
        let base = crate::spells::slots::scaled_dice_expression(&js::string(Some(coalesce(&[condition.get("rider_damage")]).unwrap_or(&Value::from("1d6")))), Some(&Value::from(extra_levels)), Some(&Value::from(1)), None);
        let expression = if critical { critical_damage_expression(&base)? } else { base };
        r.events.push(event_from(&conditions_command, "ConditionRemoved", Some(json!({ "condition": condition_id, "spell_id": "absorb-elements", "trigger": "weapon-hit" })), Some(&targets(&actor_value))));
        let hit_effect_state = r.project_events()?;
        let bonus = r.attack_roll(Value::String(expression), "spell:absorb-elements:next-melee-hit", &actor_value)?;
        r.events.push(event_from(&command, "DieRolled", Some(spread(&bonus, vec![("spell_id", json!("absorb-elements")), ("damage_type", Value::String(rider_type.clone())), ("next_weapon_hit", json!(true)), ("absorb_elements", json!(true))])), Some(&json!([]))));
        let bonus_payload = r.resolve_damage_payload(&hit_effect_state, &target_id, bonus.get("total").cloned().unwrap_or(Value::Null), &Value::String(rider_type), None, None)?;
        let body = spread(&bonus_payload, vec![("spell_id", json!("absorb-elements")), ("next_weapon_hit", json!(true)), ("absorb_elements", json!(true))]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(body), Some(&targets(&target_value))));
        r.events.extend(crate::death::zero_hit_point_damage_consequences(&hit_effect_state, &command, &target_id, &bonus_payload, false));
    }
    if !hit && !intercepted_by_image && (configured.is_some() || js::present(command.get("damage_amount"))) {
        if let Some(target_position) = target_at {
            let collateral = sk_npc_world::npc_positioning::npc_miss_collateral_target(&state, Some(&point_json(target_position)), Some(&js::num(attack_total)), Some(&js::num(armor_class)));
            if let Some(collateral) = collateral {
                let collateral_roll = match configured {
                    Some(expression) => {
                        let roll = r.attack_roll(expression.clone(), "npc_miss_collateral_damage", &actor_value)?;
                        r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
                        Some(roll)
                    }
                    None => None,
                };
                let amount = match &collateral_roll {
                    Some(roll) => roll.get("total").cloned().unwrap_or(Value::Null),
                    None => Value::from(js::safe_int(command.get("damage_amount"), 0).max(0)),
                };
                let projected = r.project_events()?;
                let options = sk_npc_world::npc_positioning::NpcHarmOptions {
                    npc_id: collateral.npc.get("id").cloned(),
                    amount: Some(amount),
                    damage_type: Some(damage_type.clone()),
                    source_event_id: Some(Value::String(attack_resolved_event_id.clone())),
                    source_actor_id: command.get("actor_id").cloned(),
                    trigger: Some(json!("miss-collateral")),
                    command_id: Some(Value::String(format!("{command_id}:miss-collateral"))),
                    ..sk_npc_world::npc_positioning::NpcHarmOptions::default()
                };
                let drafts = sk_npc_world::npc_positioning::npc_harm_event_drafts(&projected, &options);
                r.events.extend(npc_world_events_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), &Value::Array(drafts)));
            }
        }
    }
    let damage_alive = damage_outcome.as_ref().is_none_or(|outcome| number(outcome, "hp_after") > 0.0);
    if !reaction_attack && !target_is_enemy && target_living && incapacitating_condition_for(&state, &target_id).is_none() && damage_alive {
        let Some(target_actor) = target_ref else { return Ok(()) };
        let mut reaction_actor_id = target_value.clone();
        let near = distance_feet.is_none_or(|distance| distance <= 5.0);
        let options = AttackReactionOptions { hit, critical, attack_total, armor_class, damage: damage_outcome.clone(), distance_feet, allow_parry: near, allow_riposte: near };
        let has_protective_choice = r.protective_reaction_choices.contains_key(&protective_attack_key);
        let mut action_options: Vec<Value> = reaction_options_after_attack(&state, target_actor, &options)?
            .into_iter()
            .filter(|option| !has_protective_choice || !matches!(option.get("id").and_then(Value::as_str), Some("cast:shield" | "uncanny-dodge" | "cast:absorb-elements")))
            .collect();
        let silvery = if hit { silvery_barbs_reaction_for(&state, &actor_id, Some(target_id.as_str())) } else { None };
        if let Some(silvery) = silvery {
            let silvery_actor = game::actor_id(&silvery.actor);
            if silvery_actor == target_id || action_options.is_empty() {
                reaction_actor_id = Value::String(silvery_actor);
                let mut option = Map::new();
                option.insert("id".into(), json!("cast:silvery-barbs"));
                copy_field(&mut option, "name", silvery.spell.get("name"));
                copy_field(&mut option, "description", silvery.spell.get("description"));
                option.insert("resource".into(), Value::String(silvery.slot.resource.clone()));
                option.insert("slot_level".into(), Value::from(silvery.slot.level));
                option.insert("cost".into(), json!(1));
                copy_field(&mut option, "spell_id", silvery.spell.get("id"));
                option.insert("requires_beneficiary".into(), json!(true));
                action_options.push(Value::Object(option));
            }
        }
        let reaction_economy = at(game::combat(&state).get("action_economy"), &js::string(Some(&reaction_actor_id)));
        if !js::is_false(at(reaction_economy, "reaction")) && !action_options.is_empty() {
            let mut trigger_roll = Map::new();
            copy_field(&mut trigger_roll, "kept", attack.get("kept"));
            copy_field(&mut trigger_roll, "modifier", attack.get("modifier"));
            copy_field(&mut trigger_roll, "total", attack.get("total"));
            trigger_roll.insert("armor_class".into(), js::num(armor_class));
            trigger_roll.insert("hit".into(), Value::Bool(hit));
            trigger_roll.insert("critical".into(), Value::Bool(critical));
            let ids: Vec<Value> = action_options.iter().map(|option| option.get("id").cloned().unwrap_or(Value::Null)).collect();
            let mut window = Map::new();
            window.insert("id".into(), Value::String(format!("reaction:{command_id}")));
            window.insert("trigger".into(), json!(if hit { "attack-hit" } else { "attack-missed" }));
            window.insert("actor_id".into(), reaction_actor_id.clone());
            window.insert("source_actor_id".into(), actor_value.clone());
            window.insert("target_id".into(), target_value.clone());
            window.insert("action_ids".into(), Value::Array(ids));
            window.insert("action_options".into(), Value::Array(action_options));
            window.insert("damage".into(), damage_outcome.clone().unwrap_or(Value::Null));
            window.insert("trigger_roll".into(), Value::Object(trigger_roll));
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::REACTION]), "ReactionWindowOpened", Some(Value::Object(window)), Some(&targets(&reaction_actor_id))));
        }
    }
    Ok(())
}

/// `safeInteger(value, fallback)` числом: запасное значение — как есть (`Number(fallback)`).
fn safe_number(value: Option<&Value>, fallback: Option<&Value>) -> f64 {
    if js::is_safe_integer(value) {
        js::number(value)
    } else {
        js::number(fallback)
    }
}

/// `Number(elapsed) + value`: строка в `value` склеивается, как в JS.
fn js_add(left: f64, value: Option<&Value>) -> f64 {
    match value {
        Some(Value::String(text)) => js::number(Some(&Value::String(format!("{}{text}", js::f64_string(left))))),
        other => left + js::number(other),
    }
}

/// Поле `key: source` убирается, если источник — `undefined`.
fn strip_missing(mut payload: Value, key: &str, source: Option<&Value>) -> Value {
    if source.is_none() {
        if let Some(map) = payload.as_object_mut() {
            map.shift_remove(key);
        }
    }
    payload
}

/// Значения-маркеры `undefined` не попадают в JSON.
fn strip_undefined_value(mut value: Value) -> Value {
    js::strip_undefined(&mut value);
    value
}

/// `commandWithRules(command, damage, resistance?, temporaryHp?)` урона по полям итога.
fn damage_command(command: &Value, payload: &Value) -> Value {
    let resisted = js::truthy(payload.get("immune")) || js::truthy(payload.get("resistant")) || js::truthy(payload.get("vulnerable"));
    let temporary = js::truthy(payload.get("temporary_hp_absorbed"));
    command_with_rules(command, &[rule_ids::DAMAGE, if resisted { rule_ids::RESISTANCE } else { "" }, if temporary { rule_ids::TEMPORARY_HP } else { "" }])
}

/// Участники заготовленного удара оружием (`next-weapon-hit:*`).
struct NextWeaponHit<'a> {
    actor: Option<&'a Value>,
    target: Option<&'a Value>,
    actor_id: &'a str,
    actor_value: &'a Value,
    target_id: &'a str,
    target_value: &'a Value,
    condition: &'a Value,
    spell: &'a Value,
    next: &'a Value,
    landed: bool,
    critical: bool,
}

/// Заготовленный удар (14768–14903): «Палящая кара», «Гневная кара»,
/// «Опутывающий удар», «Громовая кара», «Удар Зефира», «Молниевая стрела».
fn next_weapon_hit(r: &mut Resolve<'_>, state: &Value, hit: &NextWeaponHit<'_>) -> Step {
    let NextWeaponHit { actor, target, actor_id, actor_value, target_id, target_value, condition, spell, next, landed, critical } = *hit;
    let command = r.command.clone();
    let effect_id = coalesce(&[condition.get("effect_id"), js::path(game::mechanics(state), &["concentration", actor_id, "effect_id"])]).cloned().unwrap_or(Value::Null);
    let ability_key = js::string(Some(coalesce(&[spell.get("spellcastingAbility")]).unwrap_or(&Value::from("cha"))));
    let fallback_dc = 8 + js::safe_int(at(actor, "proficiency"), 0).max(0) + ability_modifier(at(at(actor, "abilities"), &ability_key));
    let save_dc = js::safe_int(condition.get("save_dc"), fallback_dc).max(1);
    let spell_level = js::number(spell.get("level"));
    let slot_level = crate::tactical_geometry::js_max(spell_level, safe_number(condition.get("slot_level"), spell.get("level")));
    let extra_levels = crate::tactical_geometry::js_max(0.0, slot_level - crate::tactical_geometry::js_max(1.0, spell_level));
    let extra_value = js::num(extra_levels);
    let spell_id = spell.get("id").cloned().unwrap_or(Value::Null);
    let spell_key = js::string(Some(&spell_id));
    let conditions_command = command_with_rules(&command, &[rule_ids::CONDITIONS]);
    let mut removed = Map::new();
    copy_field(&mut removed, "condition", condition.get("id"));
    copy_field(&mut removed, "spell_id", spell.get("id"));
    removed.insert("trigger".into(), json!("weapon-hit"));
    r.events.push(event_from(&conditions_command, "ConditionRemoved", Some(Value::Object(removed)), Some(&targets(actor_value))));

    let mut hit_effect_state = r.project_events()?;
    let bonus_damage_applies = if landed { !js::is_true(next.get("replacesWeaponDamage")) } else { js::is_true(next.get("missHalfDamage")) };
    let damage_type = js::string(Some(coalesce(&[next.get("damageType")]).unwrap_or(&Value::from("force"))));
    if js::truthy(next.get("damage")) && bonus_damage_applies && game::find_actor(&hit_effect_state, target_id).is_some_and(game::is_living_actor) {
        let base = crate::spells::slots::scaled_dice_expression(&js::string(next.get("damage")), Some(&extra_value), next.get("upcastDicePerLevel"), None);
        let expression = if critical && landed { critical_damage_expression(&base)? } else { base };
        let bonus = r.attack_roll(Value::String(expression), &format!("spell:next-weapon-hit:{spell_key}"), actor_value)?;
        let mut rolled = spread_value(Some(&bonus));
        rolled.insert("spell_id".into(), spell_id.clone());
        rolled.insert("damage_type".into(), coalesce(&[next.get("damageType")]).cloned().unwrap_or_else(|| json!("force")));
        r.events.push(event_from(&command, "DieRolled", Some(Value::Object(rolled)), Some(&json!([]))));
        let before = hit_effect_state.clone();
        let total = number(&bonus, "total");
        let amount = if landed { bonus.get("total").cloned().unwrap_or(Value::Null) } else { js::num((total / 2.0).floor()) };
        let bonus_payload = r.resolve_damage_payload(&before, target_id, amount, &Value::String(damage_type.clone()), None, None)?;
        let mut body = spread_value(Some(&bonus_payload));
        body.insert("spell_id".into(), spell_id.clone());
        body.insert("next_weapon_hit".into(), json!(true));
        if !landed {
            body.insert("missed".into(), json!(true));
        }
        let event = event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(body)), Some(&targets(target_value)));
        r.events.push(event.clone());
        hit_effect_state = apply_game_event(&hit_effect_state, &event)?;
        let consequences = crate::death::zero_hit_point_damage_consequences(&before, &command, target_id, &bonus_payload, false);
        for consequence in &consequences {
            hit_effect_state = apply_game_event(&hit_effect_state, consequence)?;
        }
        r.events.extend(consequences);
    }

    let mut saved = spell_key == "wrathful-smite" && condition_ids_for(&hit_effect_state, target_id).contains("heroism");
    if js::truthy(next.get("saveAbility")) && landed && !saved && game::find_actor(&hit_effect_state, target_id).is_some_and(game::is_living_actor) {
        let ability = js::string(next.get("saveAbility"));
        let mut options = Map::new();
        options.insert("ability".into(), Value::String(ability.clone()));
        options.insert("modifier".into(), Value::from(ability_modifier(at(at(target, "abilities"), &ability))));
        options.insert("purpose".into(), Value::String(format!("spell_next_weapon_hit_save:{spell_key}:{ability}")));
        options.insert("advantage".into(), Value::Bool(js::is_true(next.get("saveAdvantageForLarge")) && crate::areas::shape::is_large_or_larger(target)));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.roll_saving_throw(&hit_effect_state, Some(target_value), &Value::Object(options))?;
        saved = saving_throw_succeeded(Some(&save), save_dc as f64);
        r.rolls.push(save.clone());
        let body = spread(&save, vec![("spell_id", spell_id.clone()), ("ability", Value::String(ability)), ("difficulty", json!(save_dc)), ("saved", json!(saved)), ("trigger", json!("next-weapon-hit"))]);
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(body), Some(&targets(target_value))));
        // «Опутывающий удар» 2014: лозы, от которых цель увернулась, увядают.
        if saved && js::is_true(next.get("endConcentrationOnSave")) && js::truthy(Some(&effect_id)) && js::s(js::path(game::mechanics(state), &["concentration", actor_id, "effect_id"])) == js::string(Some(&effect_id)) {
            r.events.push(event_from(
                &command_with_rules(&command, &[rule_ids::CONCENTRATION]),
                "ConcentrationEnded",
                Some(json!({ "reason": "next-weapon-hit-saved", "effect_id": effect_id })),
                Some(&targets(actor_value)),
            ));
        }
    }

    if landed && !saved && game::find_actor(&hit_effect_state, target_id).is_some_and(game::is_living_actor) {
        let add_linked = |r: &mut Resolve<'_>, condition: Value, extra: Vec<(&str, Value)>| {
            if freedom_blocks_spell_condition(&hit_effect_state, target_id, &js::string(Some(&condition))) {
                return;
            }
            let mut body = Map::new();
            body.insert("condition".into(), condition);
            body.insert("duration".into(), json!("concentration"));
            body.insert("source_actor".into(), actor_value.clone());
            body.insert("effect_id".into(), effect_id.clone());
            body.insert("spell_id".into(), spell_id.clone());
            body.insert("save_dc".into(), json!(save_dc));
            for (key, value) in extra {
                body.insert(key.into(), value);
            }
            r.events.push(event_from(&conditions_command, "ConditionAdded", Some(Value::Object(body)), Some(&targets(target_value))));
        };
        match spell_key.as_str() {
            "searing-smite" => add_linked(r, json!("searing-smite-flames"), vec![("start_turn_save", json!("con")), ("recurring_damage", json!("1d6")), ("recurring_damage_type", json!("fire"))]),
            "wrathful-smite" => {
                add_linked(r, json!("wrathful-smite-frightened"), vec![("escape_check_ability", json!("wis"))]);
                add_linked(r, json!("frightened"), Vec::new());
            }
            "ensnaring-strike" => {
                let recurring = crate::spells::slots::scaled_dice_expression("1d6", Some(&extra_value), Some(&Value::from(1)), None);
                add_linked(r, json!("ensnaring-strike"), vec![("recurring_damage", Value::String(recurring)), ("recurring_damage_type", json!("piercing"))]);
                add_linked(r, json!("restrained"), vec![("escape_check_ability", json!("str"))]);
            }
            _ => {
                if let Some(list) = next.get("conditions").filter(|value| !value.is_null()) {
                    match list {
                        Value::Array(items) => {
                            for item in items {
                                add_linked(r, item.clone(), Vec::new());
                            }
                        }
                        Value::String(text) => {
                            for ch in text.chars() {
                                add_linked(r, Value::String(ch.to_string()), Vec::new());
                            }
                        }
                        _ => return Err(fault("pendingWeaponHit.conditions is not iterable")),
                    }
                }
            }
        }
        if js::number(next.get("pushFeet")) > 0.0 {
            let pushed_from = actor_point(&hit_effect_state, target_id);
            let path = crate::geometry::forced::forced_push_path(&hit_effect_state, target_id, actor_point(&hit_effect_state, actor_id), js::number(next.get("pushFeet")));
            if let Some(last) = path.last().copied() {
                let speed = target.map_or(0, |target| crate::speed::effective_speed_feet(state, target, target_id));
                let body = json!({
                    "from": point_or_null(pushed_from), "to": point_json(last), "path": points_json(&path), "distance": path.len() * 5,
                    "movement_cost": 0, "movement_spent": 0, "movement_remaining": speed,
                    "spend_movement": false, "forced_movement": true, "spell_id": spell_id, "phase": "combat",
                });
                r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "ActorMoved", Some(body), Some(&targets(target_value))));
                let moved_state = r.project_events()?;
                let from_value = point_or_null(pushed_from);
                let to_value = point_json(last);
                let consequences = r.area_entry_consequences(&moved_state, target_id, Some(&from_value), Some(&to_value), Some("forced-entry"))?;
                r.events.extend(consequences);
            }
        }
        if js::truthy(next.get("proneOnFailedSave")) {
            r.events.push(event_from(&conditions_command, "ConditionAdded", Some(json!({ "condition": "prone", "duration": null, "source_actor": actor_value, "spell_id": spell_id })), Some(&targets(target_value))));
        }
    }

    let burst = next.get("burst").filter(|value| js::truthy(Some(value)));
    if let Some(burst) = burst.filter(|burst| landed || js::is_true(burst.get("onMiss"))) {
        let target_position = actor_point(&hit_effect_state, target_id);
        let radius = js::safe_int(burst.get("radius"), 5).max(0) as f64;
        let burst_targets: Vec<Value> = match target_position {
            Some(target_position) => {
                let target_actor = game::find_actor(&hit_effect_state, target_id);
                game::list_actors(&hit_effect_state)
                    .into_iter()
                    .filter(|candidate| {
                        if !game::is_living_actor(candidate) {
                            return false;
                        }
                        let id = game::actor_id(candidate);
                        if js::is_true(burst.get("excludesTarget")) && id == target_id {
                            return false;
                        }
                        let Some(position) = actor_point(&hit_effect_state, &id) else { return false };
                        // `null <= radius`: неизвестное расстояние — ноль.
                        sk_geometry::actor_footprint::footprint_distance_feet(Some(candidate), target_actor, Some(&point_json(position)), Some(&point_json(target_position))).unwrap_or(0.0) <= radius
                    })
                    .cloned()
                    .collect()
            }
            None => Vec::new(),
        };
        let expression = crate::spells::slots::scaled_dice_expression(&js::string(burst.get("damage")), Some(&extra_value), burst.get("upcastDicePerLevel"), burst.get("maximumDice"));
        let burst_roll = r.attack_roll(Value::String(expression), &format!("spell:next-weapon-hit-burst:{spell_key}"), actor_value)?;
        let mut rolled = spread_value(Some(&burst_roll));
        rolled.insert("spell_id".into(), spell_id.clone());
        copy_field(&mut rolled, "damage_type", burst.get("damageType"));
        rolled.insert("burst".into(), json!(true));
        r.events.push(event_from(&command, "DieRolled", Some(Value::Object(rolled)), Some(&json!([]))));
        let mut burst_state = r.project_events()?;
        for burst_target in &burst_targets {
            let burst_target_id = game::actor_id(burst_target);
            let burst_target_value = Value::String(burst_target_id.clone());
            let ability = js::string(burst.get("saveAbility"));
            let mut options = Map::new();
            options.insert("ability".into(), Value::String(ability.clone()));
            options.insert("modifier".into(), Value::from(ability_modifier(at(burst_target.get("abilities"), &ability))));
            options.insert("purpose".into(), Value::String(format!("spell_next_weapon_hit_burst_save:{spell_key}:{ability}")));
            options.insert("visibility".into(), undef(command.get("visibility")));
            let save = r.roll_saving_throw(&burst_state, Some(&burst_target_value), &Value::Object(options))?;
            let burst_saved = saving_throw_succeeded(Some(&save), save_dc as f64);
            r.rolls.push(save.clone());
            let body = spread(&save, vec![("spell_id", spell_id.clone()), ("ability", Value::String(ability.clone())), ("difficulty", json!(save_dc)), ("saved", json!(burst_saved)), ("trigger", json!("next-weapon-hit-burst"))]);
            r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SpellSavingThrowResolved", Some(body), Some(&targets(&burst_target_value))));
            let amount = saved_damage_amount(&burst_state, &burst_target_id, Some(&Value::String(ability)), burst_saved, js::truthy(burst.get("halfOnSave")), burst_roll.get("total"));
            if amount <= 0 {
                continue;
            }
            let before = burst_state.clone();
            let burst_payload = r.resolve_damage_payload(&before, &burst_target_id, Value::from(amount), &Value::String(js::string(burst.get("damageType"))), None, None)?;
            let body = spread(&burst_payload, vec![("spell_id", spell_id.clone()), ("burst", json!(true)), ("saved", json!(burst_saved))]);
            let event = event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(body), Some(&targets(&burst_target_value)));
            r.events.push(event.clone());
            burst_state = apply_game_event(&burst_state, &event)?;
            let consequences = crate::death::zero_hit_point_damage_consequences(&before, &command, &burst_target_id, &burst_payload, false);
            for consequence in &consequences {
                burst_state = apply_game_event(&burst_state, consequence)?;
            }
            r.events.extend(consequences);
        }
    }

    if js::number(next.get("speedBonus")) > 0.0 {
        let mut body = Map::new();
        body.insert("action_id".into(), Value::String(format!("{spell_key}:speed-bonus")));
        copy_field(&mut body, "name", spell.get("name"));
        body.insert("action_type".into(), json!("free"));
        copy_field(&mut body, "movement_bonus", next.get("speedBonus"));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "CombatActionUsed", Some(Value::Object(body)), Some(&targets(actor_value))));
    }
    if js::truthy(next.get("endConcentrationOnHit")) && js::truthy(Some(&effect_id)) {
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONCENTRATION]), "ConcentrationEnded", Some(json!({ "reason": "next-weapon-hit-resolved", "effect_id": effect_id })), Some(&targets(actor_value))));
    }
    Ok(())
}

/// `ChangeWeapon` (15000–15009).
pub fn change_weapon(r: &mut Resolve<'_>) -> Step {
    let actor_id = js::s(r.command.get("actor_id"));
    let actor = game::find_actor(&r.state, &actor_id);
    let Some(item) = combat_item(actor, &js::string(r.command.get("item_id"))).cloned() else {
        return Err(fault("Cannot read properties of null (reading 'id')"));
    };
    let mut body = Map::new();
    copy_field(&mut body, "item_id", item.get("id"));
    copy_field(&mut body, "item_name", item.get("name"));
    body.insert("equipped".into(), json!(true));
    body.insert("timing".into(), json!("action"));
    body.insert("turns_spent".into(), json!(1));
    let actor_targets = targets(&r.command.get("actor_id").cloned().unwrap_or(Value::Null));
    r.events.push(event_from(&r.command, "EquipmentChanged", Some(Value::Object(body)), Some(&actor_targets)));
    let key = item_instance_key(Some(&item));
    let removal = shillelagh_removal_events(&r.state, &r.command, ShillelaghRemoval { item_key: None, exclude_item_key: Some(&key), reason: Some("weapon-swapped") });
    r.events.extend(removal);
    Ok(())
}

/// `MakeAreaAttack` (15068–15150).
pub fn make_area_attack(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let actor_id = js::s(command.get("actor_id"));
    let actor_value = command.get("actor_id").cloned().unwrap_or(Value::Null);
    let actor = game::find_actor(&state, &actor_id);
    let Some(item) = combat_item(actor, &js::string(command.get("item_id"))).cloned() else {
        return Err(fault("Cannot read properties of null (reading 'combat')"));
    };
    let combat = item.get("combat").cloned().unwrap_or(Value::Null);
    let from = actor_point(&state, &actor_id);
    let to_raw = command.get("to");
    let to = Point::new(js::number(at(to_raw, "x")), js::number(at(to_raw, "y")));
    let Some(from) = from else { return Err(rule("Метатель должен находиться на карте", "MAP_POSITION_REQUIRED")) };
    let distance_feet = sk_geometry::actor_footprint::footprint_distance_feet(actor, Some(&json!([point_json(to)])), Some(&point_json(from)), None);
    // `null > range`: неизвестное расстояние — не дальше дальности.
    if distance_feet.is_some_and(|distance| distance > js::safe_int(combat.get("normalRange"), 20) as f64) {
        return Err(rule("Клетка находится вне дальности броска", "TARGET_OUT_OF_RANGE"));
    }
    let trajectory = crate::geometry::forced::assert_clear_actor_to_point(&state, &actor_id, Some(from), to)?;
    let radius_feet = js::safe_int(combat.get("radius"), 5).clamp(5, 30);
    let affected: Vec<Value> = game::list_actors(&state)
        .into_iter()
        .filter(|candidate| {
            let id = game::actor_id(candidate);
            if id == actor_id || !game::is_living_actor(candidate) {
                return false;
            }
            let Some(position) = actor_point(&state, &id) else { return false };
            crate::tactical_geometry::actor_footprint_cells_at(&state, &id, Some(position)).into_iter().any(|cell| crate::areas::shape::position_in_area(Some(cell), Some(to), radius_feet as f64, "sphere", f64::NAN, None))
        })
        .cloned()
        .collect();
    let npc_affected: Vec<sk_npc_world::npc_positioning::NpcTarget> = sk_npc_world::npc_positioning::npc_targets_within_area(&state, Some(&point_json(to)), Some(&Value::from(radius_feet)))
        .into_iter()
        .filter(|target| game::find_actor(&state, &js::string(target.npc.get("id"))).is_none())
        .collect();
    let mut affected_ids: Vec<String> = affected.iter().map(game::actor_id).collect();
    affected_ids.extend(npc_affected.iter().map(|target| js::string(target.npc.get("id"))));
    let affected_value = js::strings_value(affected_ids.clone());
    let area_event_id = format!("area-attack:{}", slice_utf16(&js::string(command.get("command_id")), 100));
    let save_ability = match combat.get("saveAbility").filter(|value| js::truthy(Some(value))) {
        Some(value) => value.clone(),
        None => json!("dex"),
    };
    let save_key = js::string(Some(&save_ability));
    let save_dc = js::safe_int(combat.get("saveDc"), 12);
    let mut body = Map::new();
    body.insert("action_economy_version".into(), Value::from(crate::turn_economy::ACTION_ECONOMY_EVENT_VERSION));
    copy_field(&mut body, "item_id", item.get("id"));
    copy_field(&mut body, "item_name", item.get("name"));
    body.insert("from".into(), point_json(from));
    body.insert("to".into(), point_json(to));
    body.insert("trajectory".into(), points_json(&trajectory));
    body.insert("radius_feet".into(), Value::from(radius_feet));
    copy_field(&mut body, "damage_expression", combat.get("damage"));
    copy_field(&mut body, "damage_type", combat.get("damageType"));
    body.insert("save_ability".into(), save_ability.clone());
    body.insert("save_dc".into(), Value::from(save_dc));
    body.insert("affected_ids".into(), affected_value.clone());
    let mut area_event = event_from(&command, "AreaAttackResolved", Some(Value::Object(body)), Some(&affected_value));
    area_event["event_id"] = Value::String(area_event_id.clone());
    r.events.push(area_event);
    let damage_roll = if affected_ids.is_empty() {
        None
    } else {
        let visibility = r.visibility();
        let roll = r.roll_dice(combat.get("damage").cloned().unwrap_or(Value::String(js::UNDEFINED.into())), "area_damage", actor_value.clone(), visibility)?;
        r.rolls.push(roll.clone());
        r.events.push(event_from(&command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        Some(roll)
    };
    let damage_type = match combat.get("damageType").filter(|value| js::truthy(Some(value))) {
        Some(value) => js::string(Some(value)),
        None => "fire".to_string(),
    };
    let half_on_save = js::truthy(combat.get("halfOnSave"));
    let total = damage_roll.as_ref().and_then(|roll| roll.get("total")).cloned();
    for target in &affected {
        let target_id = game::actor_id(target);
        let target_value = Value::String(target_id.clone());
        let mut options = Map::new();
        options.insert("ability".into(), save_ability.clone());
        options.insert("modifier".into(), Value::from(ability_modifier(at(target.get("abilities"), &save_key))));
        options.insert("purpose".into(), Value::String(format!("saving_throw:{save_key}")));
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.roll_saving_throw(&state, Some(&target_value), &Value::Object(options))?;
        r.rolls.push(save.clone());
        let saved = saving_throw_succeeded(Some(&save), save_dc as f64);
        let mut resolved = spread_value(Some(&save));
        resolved.insert("ability".into(), save_ability.clone());
        resolved.insert("difficulty".into(), Value::from(save_dc));
        resolved.insert("success".into(), Value::Bool(saved));
        resolved.insert("saved".into(), Value::Bool(saved));
        resolved.insert("source".into(), json!("area-attack"));
        copy_field(&mut resolved, "item_id", item.get("id"));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(resolved)), Some(&targets(&target_value))));
        let raw = saved_damage_amount(&state, &target_id, Some(&save_ability), saved, half_on_save, total.as_ref());
        let payload = r.resolve_damage_payload(&state, &target_id, Value::from(raw), &Value::String(damage_type.clone()), None, None)?;
        let mut applied = spread_value(Some(&payload));
        applied.insert("save_total".into(), save.get("total").cloned().unwrap_or(Value::Null));
        applied.insert("save_dc".into(), Value::from(save_dc));
        applied.insert("saved".into(), Value::Bool(saved));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(applied)), Some(&targets(&target_value))));
    }
    let mut npc_damage_state = r.project_events()?;
    for target in &npc_affected {
        let npc_id = js::string(target.npc.get("id"));
        let npc_value = Value::String(npc_id.clone());
        let npc_context = crate::combat::monsters::npc_damage_context(&npc_damage_state, &npc_id).into_owned();
        let mut options = Map::new();
        options.insert("ability".into(), save_ability.clone());
        options.insert("modifier".into(), Value::from(ability_modifier(at(at(game::find_actor(&npc_context, &npc_id), "abilities"), &save_key))));
        options.insert("purpose".into(), Value::String(format!("npc_area_save:{save_key}")));
        options.insert("actorId".into(), npc_value.clone());
        options.insert("visibility".into(), undef(command.get("visibility")));
        let save = r.roll_saving_throw(&npc_context, Some(&npc_value), &Value::Object(options))?;
        let saved = saving_throw_succeeded(Some(&save), save_dc as f64);
        r.rolls.push(save.clone());
        let mut resolved = spread_value(Some(&save));
        resolved.insert("npc_id".into(), npc_value.clone());
        resolved.insert("ability".into(), save_ability.clone());
        resolved.insert("difficulty".into(), Value::from(save_dc));
        resolved.insert("saved".into(), Value::Bool(saved));
        resolved.insert("source_event_id".into(), Value::String(area_event_id.clone()));
        resolved.insert("policy_id".into(), Value::from(sk_npc_world::npc_positioning::NPC_WORLD_POLICY_ID));
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::SAVING_THROW]), "NpcSavingThrowResolved", Some(Value::Object(resolved)), Some(&targets(&npc_value))));
        let raw = saved_damage_amount(&npc_context, &npc_id, Some(&save_ability), saved, half_on_save, total.as_ref());
        let applied = r.resolve_damage_payload(&npc_context, &npc_id, Value::from(raw), &Value::String(damage_type.clone()), None, None)?;
        let options = sk_npc_world::npc_positioning::NpcHarmOptions {
            npc_id: Some(npc_value.clone()),
            amount: Some(applied.get("applied_amount").cloned().unwrap_or(Value::Null)),
            damage_type: Some(Value::String(damage_type.clone())),
            source_event_id: Some(Value::String(area_event_id.clone())),
            source_actor_id: command.get("actor_id").cloned(),
            trigger: Some(json!("area-attack")),
            command_id: Some(Value::String(format!("{}:{npc_id}", js::string(command.get("command_id"))))),
            ..sk_npc_world::npc_positioning::NpcHarmOptions::default()
        };
        let drafts = sk_npc_world::npc_positioning::npc_harm_event_drafts(&npc_damage_state, &options);
        let harm_events = npc_world_events_from(&command_with_rules(&command, &[rule_ids::DAMAGE]), &Value::Array(drafts));
        for event in &harm_events {
            npc_damage_state = apply_game_event(&npc_damage_state, event)?;
        }
        r.events.extend(harm_events);
    }
    let mut consumed = Map::new();
    copy_field(&mut consumed, "item_id", item.get("id"));
    copy_field(&mut consumed, "item_name", item.get("name"));
    consumed.insert("quantity".into(), json!(1));
    r.events.push(event_from(&command, "ItemConsumed", Some(Value::Object(consumed)), Some(&targets(&actor_value))));
    Ok(())
}
