//! Заклинание: призыв существ и дополнительные лучи заклинания с несколькими
//! лучами (каждый луч — вложенный разбор той же команды). Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 18646–18778 (призыв), 18783–18820 (лучи).

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_geometry::Point;

use super::common::{actor_id_of, at, field, is_true, level_of, nn, put, slot_level_of, template, Cast};
use super::super::Resolve;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, slice_utf16, spread_value, unique_strings};
use crate::dice_record::RulesDice;
use crate::pause::{pending_execution_for, Interrupt, Flow};
use crate::tactical_geometry::key_of;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `${count}d${sides}${modifier}` со знаком модификатора, как в JS.
fn dice_text(count: i64, sides: impl std::fmt::Display, modifier: i64) -> String {
    let suffix = if modifier > 0 { format!("+{modifier}") } else if modifier < 0 { modifier.to_string() } else { String::new() };
    format!("{count}d{sides}{suffix}")
}

/// Призыв (18646–18778).
pub(super) fn summon(r: &mut Resolve<'_>, cast: &mut Cast) -> Flow {
    let state = r.state.clone();
    let spell = cast.spell.clone();
    let command = cast.command.clone();
    let actor = cast.actor.clone();
    let spell_id = cast.spell_id();
    let uses_2014 = sk_core::game::uses_2014(&state);
    let to = Point::from_value(command.get("to"));
    let safe_command_id: String = sk_core::text::replace_all(sk_core::re!(r"[^A-Za-z0-9._-]", "u"), &template(command.get("command_id")), "-");
    let safe_command_id = slice_utf16(&safe_command_id, 60);
    let slot_level = slot_level_of(&spell, &command);
    let level = level_of(&spell);
    let stat_level = (if uses_2014 { slot_level } else { level }).max(1);
    let table = field(&spell, "summonByRoll").filter(|table| table.get("entries").and_then(Value::as_array).is_some_and(|entries| !entries.is_empty())).cloned();
    let table_roll = match table.as_ref() {
        Some(table) => {
            let die = js::string(Some(nn(table.get("die")).unwrap_or(&json!("1d6"))));
            let roll = r.spell_roll(Value::String(die), &format!("summon_count:{spell_id}"))?;
            r.rolls.push(roll.clone());
            let mut payload = spread_value(Some(&roll));
            put(&mut payload, "spell_id", field(&spell, "id"));
            payload.insert("summon_table".into(), Value::Bool(true));
            r.push_die(Value::Object(payload));
            Some(roll)
        }
        None => None,
    };
    let table_entry = match (table.as_ref(), table_roll.as_ref()) {
        (Some(table), Some(roll)) => {
            let entries = table.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
            let total = js::number(roll.get("total"));
            entries.iter().find(|entry| total >= js::safe_int(entry.get("min"), 1) as f64 && total <= js::safe_int(entry.get("max"), 6) as f64).or(entries.last()).cloned()
        }
        _ => None,
    };
    let actor_level = js::safe_int(at(actor.as_ref(), "level"), 1).max(1);
    let half = (stat_level as f64 / 2.0).ceil() as i64;
    let definition = nn(at(table_entry.as_ref(), "summon")).or_else(|| nn(field(&spell, "summon"))).cloned().unwrap_or_else(|| {
        let mut definition = Map::new();
        put(&mut definition, "name", field(&spell, "name"));
        definition.insert("hp".into(), Value::from(10 + stat_level * 5 + actor_level));
        definition.insert("armor".into(), Value::from(11 + half));
        definition.insert("speed".into(), json!(30));
        definition.insert("attackName".into(), json!("Магическая атака"));
        definition.insert("damage".into(), Value::String(format!("{}d8+{}", half.max(1), cast.spell_modifier.max(0))));
        definition.insert("damageType".into(), cast.damage_type.clone());
        definition.insert("range".into(), json!(5));
        Value::Object(definition)
    });
    let definition_field = |key: &str| at(Some(&definition), key);
    let extra_levels = (slot_level - level.max(1)).max(0);
    let mut multipliers: Vec<(String, Value)> = crate::pause::object_entries(nn(field(&spell, "summonCountMultiplierBySlotLevel"))).into_iter().filter(|(key, _)| slot_level >= js::safe_int(Some(&Value::String(key.clone())), MAX_SAFE_INTEGER)).collect();
    multipliers.sort_by(|(left, _), (right, _)| js::safe_int(Some(&Value::String(right.clone())), 0).cmp(&js::safe_int(Some(&Value::String(left.clone())), 0)));
    let count_multiplier = js::safe_int(multipliers.first().map(|(_, value)| value), 1).max(1);
    let base_count = js::safe_int(nn(at(table_entry.as_ref(), "count")).or_else(|| field(&spell, "summonCount")), 1);
    let summon_count = ((base_count + extra_levels * js::safe_int(field(&spell, "upcastSummonsPerLevel"), 0).max(0)) * count_multiplier).min(16).max(1);
    let started_seconds = crate::world_clock::world_time_seconds(&r.project_events()?);
    let damage_expression = {
        let expression = template(definition_field("damage"));
        let every = js::safe_int(definition_field("upcastDiceEveryLevels"), 0).max(0);
        let adds_modifier = is_true(definition_field("addSpellcastingModifier"));
        if !adds_modifier && every == 0 {
            expression
        } else {
            match sk_dice::parse_dice_expression(&expression) {
                Ok(parsed) => {
                    let count = i64::from(parsed.count) + if every > 0 { extra_levels.div_euclid(every) } else { 0 };
                    let modifier = parsed.modifier + if adds_modifier { cast.spell_modifier } else { 0 };
                    dice_text(count, parsed.sides, modifier)
                }
                Err(_) => expression,
            }
        }
    };
    // Клетки вокруг точки: сама точка, затем кольца; занятые и непроходимые пропускаются.
    let mut taken: crate::tactical_geometry::KeySet = crate::tactical_geometry::KeySet::new();
    for candidate in sk_core::game::list_actors(&state) {
        for cell in crate::tactical_geometry::actor_footprint_cells_at(&state, &actor_id_of(candidate), None) {
            taken.insert(key_of(cell));
        }
    }
    let map = crate::tactical_geometry::scene_tactical_map(&state);
    taken.extend(crate::tactical_geometry::prop_movement_positions(map.as_ref()));
    let cells = crate::tactical_geometry::tactical_cell_map(&state);
    let footprint_meta = sk_geometry::actor_footprint::footprint_metadata_for_size(definition_field("size")).to_value();
    let summon_footprint = json!({ "footprint": footprint_meta });
    let mut placed: Vec<Point> = Vec::new();
    let wanted = usize::try_from(summon_count).unwrap_or(1);
    let mut ring = 0_i64;
    while placed.len() < wanted && ring <= 4 {
        let mut dy = -ring;
        while dy <= ring && placed.len() < wanted {
            let mut dx = -ring;
            while dx <= ring && placed.len() < wanted {
                if dx.abs().max(dy.abs()) == ring {
                    let spot = Point::new(to.x + dx as f64, to.y + dy as f64);
                    let footprint = sk_geometry::actor_footprint::footprint_cells_for(Some(&summon_footprint), Some(&crate::tactical_geometry::point_json(spot)));
                    let blocked = footprint.is_empty()
                        || footprint.iter().any(|cell| {
                            let key = key_of(Point::from(*cell));
                            taken.contains(&key) || (!cells.is_empty() && !crate::tactical_geometry::is_walkable_cell(cells.get(&key).copied()))
                        });
                    let edges = !blocked && map.is_some() && crate::tactical_geometry::footprint_placement_edges_blocked(map.as_ref(), Some(&summon_footprint), Some(spot));
                    if !blocked && !edges {
                        for cell in &footprint {
                            taken.insert(key_of(Point::from(*cell)));
                        }
                        placed.push(spot);
                    }
                }
                dx += 1;
            }
            dy += 1;
        }
        ring += 1;
    }
    let hostile = is_true(definition_field("hostile"));
    let hostile_dexterity = ability_modifier(at(definition_field("abilities"), "dex"));
    let combat_active = js::truthy(sk_core::game::combat(&state).get("active"));
    let hostile_initiative = if hostile && combat_active && !placed.is_empty() {
        let options = json!({ "modifier": hostile_dexterity, "purpose": format!("summon_initiative:{spell_id}"), "actorId": command.get("actor_id").cloned().unwrap_or(Value::Null), "visibility": r.visibility() });
        let roll = r.dice.roll_d20(&options)?;
        r.rolls.push(roll.clone());
        let mut payload = spread_value(Some(&roll));
        put(&mut payload, "spell_id", field(&spell, "id"));
        payload.insert("summon_initiative".into(), Value::Bool(true));
        r.push_ruled(&[rule_ids::INITIATIVE], "DieRolled", Value::Object(payload), json!([]));
        Some(roll)
    } else {
        None
    };
    let owner_name = nn(at(actor.as_ref(), "character")).or_else(|| nn(at(actor.as_ref(), "name"))).map(|value| js::string(Some(value))).unwrap_or_else(|| template(command.get("actor_id")));
    let many = placed.len() > 1;
    for (index, spot) in placed.iter().enumerate() {
        let suffix = if many { format!("-{}", index + 1) } else { String::new() };
        let summon_id = slice_utf16(&format!("summon-{}-{safe_command_id}{suffix}", template(command.get("actor_id"))), 120);
        let numbered = format!("{}{}", template(definition_field("name")), if many { format!(" {}", index + 1) } else { String::new() });
        let name = if hostile { slice_utf16(&numbered, 120) } else { slice_utf16(&format!("{numbered} · {owner_name}"), 120) };
        let mut summon = Map::new();
        summon.insert("id".into(), Value::String(summon_id.clone()));
        summon.insert("name".into(), Value::String(name));
        summon.insert("kind".into(), json!("summon"));
        summon.insert("faction".into(), json!(if hostile { "hostile" } else { "party" }));
        summon.insert("ownerId".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
        if hostile {
            summon.insert("hostile_to_all".into(), Value::Bool(true));
            summon.insert("creature_type".into(), Value::String(js::string(Some(nn(definition_field("creatureType")).unwrap_or(&json!("fiend"))))));
        } else {
            summon.insert("controllerId".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
        }
        if let Some(abilities) = definition_field("abilities").filter(|value| matches!(value, Value::Object(_) | Value::Array(_))) {
            summon.insert("abilities".into(), abilities.clone());
        }
        put(&mut summon, "sourceSpellId", field(&spell, "id"));
        summon.insert("sourceEffectId".into(), Value::String(cast.effect_id.clone()));
        summon.insert("turnRule".into(), json!(if hostile { "own-initiative" } else { "after-owner" }));
        summon.insert("summon_lifecycle_version".into(), Value::from(crate::constants::SUMMON_LIFECYCLE_VERSION));
        if js::truthy(field(&spell, "durationRounds")) {
            let rounds = js::safe_int(field(&spell, "durationRounds"), 1).max(1);
            summon.insert("expires_at_seconds".into(), js::num(started_seconds + (rounds * 6) as f64));
        }
        put(&mut summon, "hp", definition_field("hp"));
        put(&mut summon, "maxHp", definition_field("hp"));
        put(&mut summon, "armor", definition_field("armor"));
        put(&mut summon, "speed", definition_field("speed"));
        summon.insert("x".into(), js::num(spot.x));
        summon.insert("y".into(), js::num(spot.y));
        summon.insert("alive".into(), Value::Bool(true));
        let mut profile = Map::new();
        put(&mut profile, "name", definition_field("attackName"));
        let attack_modifier = if nn(definition_field("attackBonus")).is_some() { js::safe_int(definition_field("attackBonus"), 0) } else { cast.spell_attack_modifier };
        profile.insert("attack_modifier".into(), Value::from(attack_modifier));
        profile.insert("damage_expression".into(), Value::String(damage_expression.clone()));
        put(&mut profile, "damage_type", definition_field("damageType"));
        put(&mut profile, "range_feet", definition_field("range"));
        summon.insert("attack_profile".into(), Value::Object(profile));
        summon.insert("footprint".into(), footprint_meta.clone());
        if is_true(definition_field("untargetable")) {
            summon.insert("untargetable".into(), Value::Bool(true));
        }
        let mut payload = Map::new();
        payload.insert("summon".into(), Value::Object(summon));
        payload.insert("turn_rule".into(), json!(if hostile { "own-initiative" } else { "after-owner" }));
        payload.insert("summon_index".into(), Value::from(index + 1));
        payload.insert("summon_count".into(), Value::from(placed.len()));
        if let Some(initiative) = hostile_initiative.as_ref() {
            put(&mut payload, "initiative_total", initiative.get("total"));
            payload.insert("initiative_modifier".into(), Value::from(hostile_dexterity));
        }
        payload.insert("summon_lifecycle_version".into(), Value::from(crate::constants::SUMMON_LIFECYCLE_VERSION));
        r.push_ruled(&[rule_ids::INITIATIVE], "SummonedCreatureCreated", Value::Object(payload), json!([summon_id]));
    }
    Ok(())
}

/// Коды отказа луча, при которых луч по отброшенной цели пропадает (18803).
const PUSHED_AWAY_CODES: [&str; 4] = ["TRAJECTORY_BLOCKED", "TARGET_OUT_OF_RANGE", "TARGET_NOT_VISIBLE", "TOTAL_COVER"];

/// Дополнительные лучи: каждый — вложенный разбор той же команды (18783–18820).
pub(super) fn additional_beams(r: &mut Resolve<'_>, cast: &Cast) -> Flow {
    let spell = &cast.spell;
    if field(spell, "kind").and_then(Value::as_str) != Some("attack") || !crate::spells::slots::has_multiple_beams(Some(spell)) || r.context.truthy("additionalBeam") {
        return Ok(());
    }
    let command = cast.command.clone();
    let beams = crate::spells::slots::beam_count_for(cast.actor.as_ref(), Some(spell), command.get("slot_level"));
    let requested = unique_strings(Some(command.get("target_ids").unwrap_or(&json!([]))));
    let fallback = js::string(Some(&r.target_id));
    let mut beam_state = r.project_events()?;
    let context = r.context.with("additionalBeam", Value::Bool(true));
    let mut index = 1_i64;
    while index < beams {
        let position = usize::try_from(index).unwrap_or(usize::MAX);
        let beam_target = requested.get(position).or_else(|| requested.first()).cloned().unwrap_or_else(|| fallback.clone());
        index += 1;
        if !super::common::living(sk_core::game::find_actor(&beam_state, &beam_target)) {
            continue;
        }
        let mut beam_command = spread_value(Some(&command));
        beam_command.insert("command_id".into(), Value::String(format!("{}:beam:{}", template(command.get("command_id")), position + 1)));
        match beam_state.get("state_version") {
            Some(version) => {
                beam_command.insert("expected_state_version".into(), version.clone());
            }
            None => {
                beam_command.shift_remove("expected_state_version");
            }
        }
        beam_command.insert("target_id".into(), Value::String(beam_target.clone()));
        beam_command.insert("target_ids".into(), json!([beam_target]));
        let result = crate::resolve::api::resolve_command_inner(&Value::Object(beam_command), &beam_state, &mut r.dice, &context, &mut *r.uuid);
        let resolved = match result {
            Ok(resolved) => resolved,
            Err(Interrupt::Rule(error))
                if PUSHED_AWAY_CODES.contains(&error.code.as_str()) && crate::tactical_geometry::actor_point(&r.state, &beam_target) != crate::tactical_geometry::actor_point(&beam_state, &beam_target) =>
            {
                continue;
            }
            Err(Interrupt::Pause(mut pause)) => {
                pause.command = command.clone();
                let transcript = Value::Array(r.dice.transcript.clone());
                let execution = pending_execution_for(&r.context);
                let payload = pause.window_payload_mut();
                payload.insert("pending_command".into(), command.clone());
                payload.insert("pending_dice_transcript".into(), transcript);
                payload.insert("pending_execution".into(), execution);
                return Err(Interrupt::Pause(pause));
            }
            Err(other) => return Err(other),
        };
        r.events.extend(resolved.events.iter().cloned());
        r.rolls.extend(resolved.rolls);
        beam_state = crate::replay::replay_events(&beam_state, &resolved.events)?;
    }
    Ok(())
}
