//! Ветки `resolveCommandInternal`: Вход в бой и выход: нападение на NPC, сборка встречи, начало и конец боя. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 19783–19820, 19821–19843, 19844–19973, 19974–20004. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{game, js, text};

use super::round_time::COMBAT_ROUND_TIME_POLICY;
use super::world_time::TimeAdvanceOptions;
use super::Resolve;
use crate::checks::saves::{passive_perception, surprised_participants};
use crate::combat::encounter::is_empty_hero_seat;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with_rules, event_from, npc_world_events_from, slice_utf16, spread_value, unique_string_list};
use crate::normalize::summons::{party_summons_for_expiry, summon_expiry_events, summon_ids_expired_at};
use crate::npc_item_events::{party_member_ids, sorted_initiative};
use crate::pause::{rule, Fault, Halt, Step};
use crate::targets::is_dead_hero;
use crate::turn_economy::ACTION_ECONOMY_EVENT_VERSION;
use crate::world_clock::world_time_seconds;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn array_of(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Поле, которое JS кладёт как есть (`undefined` в JSON не попадает).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `{ ...command, key: value }`, где `undefined` убирает поле.
fn with_optional(command: &Value, key: &str, value: Option<&Value>) -> Value {
    let mut map = spread_value(Some(command));
    match value {
        Some(value) => {
            map.insert(key.into(), value.clone());
        }
        None => {
            map.shift_remove(key);
        }
    }
    Value::Object(map)
}

/// `String(summon.ownerId ?? summon.owner_id)`.
fn owner_of(actor: &Value) -> String {
    js::string(crate::core::coalesce(&[actor.get("ownerId"), actor.get("owner_id")]))
}

/// `events.reduce(applyGameEvent, state)`.
fn apply_all(state: &Value, events: &[Value]) -> Result<Value, Halt> {
    let mut current = state.clone();
    for event in events {
        current = crate::replay::apply_game_event(&current, event)?;
    }
    Ok(current)
}

/// `AttackNpc` (19783–19820): встреча из профиля NPC и `StartCombat` от
/// имени героя — вложенными командами того же разбора.
pub fn attack_npc(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command_id = js::string(r.command.get("command_id"));
    let mut encounter_command = spread_value(Some(&r.command));
    encounter_command.insert("command_type".into(), json!("CreateEncounter"));
    encounter_command.insert("command_id".into(), Value::String(format!("{command_id}:encounter")));
    encounter_command.insert("actor_id".into(), Value::Null);
    encounter_command.insert("target_id".into(), Value::Null);
    encounter_command.insert("target_ids".into(), json!([]));
    encounter_command.insert("seed".into(), json!(""));
    let encounter_command = with_optional(&Value::Object(encounter_command), "expected_state_version", state.get("state_version"));
    let encounter_context = r.context.with("allowPlayerNpcEncounter", Value::Bool(true));
    let encounter = super::api::resolve_command(&encounter_command, &state, &mut r.dice, &encounter_context, &mut *r.uuid)?;
    r.events.extend(encounter.events.iter().cloned());
    r.rolls.extend(encounter.rolls);
    let encounter_state = apply_all(&state, &encounter.events)?;
    let mut start_command = spread_value(Some(&r.command));
    start_command.insert("command_type".into(), json!("StartCombat"));
    start_command.insert("command_id".into(), Value::String(format!("{command_id}:combat")));
    start_command.insert("target_id".into(), Value::Null);
    start_command.insert("target_ids".into(), json!([]));
    start_command.insert("server_authoritative".into(), json!(true));
    let start_command = with_optional(&Value::Object(start_command), "expected_state_version", encounter_state.get("state_version"));
    let start_context = r.context.with("serverAuthoritativeCombat", Value::Bool(true));
    let started = super::api::resolve_command(&start_command, &encounter_state, &mut r.dice, &start_context, &mut *r.uuid)?;
    r.events.extend(started.events);
    r.rolls.extend(started.rolls);
    Ok(())
}

/// `CreateEncounter` (19821–19843): собранная проверкой встреча — в журнал.
pub fn create_encounter(r: &mut Resolve<'_>) -> Step {
    let source = r.command.get("encounter").cloned().unwrap_or(Value::Null);
    let proposal_id = source.get("proposal_id");
    let encounter_id = text::replace_first(sk_core::re!(r"^encounter-proposal-", "u"), &js::string(proposal_id), "encounter-");
    let Some(enemies) = source.get("enemies").and_then(Value::as_array) else {
        return Err(Fault::type_error("Cannot read properties of undefined (reading 'map')").into());
    };
    let enemy_ids: Vec<Value> = enemies.iter().map(|enemy| Value::String(js::string(enemy.get("id")))).collect();
    let chapter = js::number(at(r.state.get("adventure"), "chapter"));
    let chapter = if chapter.is_nan() || chapter == 0.0 { 1.0 } else { chapter };
    let location = slice_utf16(&js::s(at(r.state.get("scene"), "location")), 180);
    let mut encounter = spread_value(Some(&source));
    encounter.insert("id".into(), json!(encounter_id));
    encounter.insert("encounter_id".into(), json!(encounter_id));
    encounter.insert("status".into(), json!("staged"));
    encounter.insert("created_in_chapter".into(), js::num(js::max_of([1.0, chapter])));
    encounter.insert("location".into(), json!(location));
    encounter.insert("enemy_ids".into(), Value::Array(enemy_ids.clone()));
    let stamped: Vec<Value> = enemies
        .iter()
        .map(|enemy| {
            if sk_geometry::actor_footprint::normalize_footprint_metadata(at(Some(enemy), "footprint")).is_some() {
                crate::geometry::footprint::normalize_actor_footprint_fields(enemy)
            } else {
                crate::geometry::footprint::stamp_actor_footprint(enemy, at(Some(enemy), "size"))
            }
        })
        .collect();
    encounter.insert("enemies".into(), Value::Array(stamped));
    let mut payload = Map::new();
    payload.insert("encounter".into(), Value::Object(encounter));
    payload.insert("authored_npc_identity_schema_version".into(), json!(1));
    payload.insert("encounter_id".into(), json!(encounter_id));
    insert_present(&mut payload, "proposal_id", proposal_id);
    payload.insert("request_fingerprint".into(), r.command.get("request_fingerprint").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    r.events.push(event_from(&r.command, "EncounterCreated", Some(Value::Object(payload)), Some(&Value::Array(enemy_ids))));
    Ok(())
}

/// Запись инициативы героя или противника с броском d20.
fn initiative_entry(r: &mut Resolve<'_>, state: &Value, id: &str) -> Result<Value, Halt> {
    let Some(actor) = game::find_actor(state, id).cloned() else {
        return Err(rule(format!("Участник {id} не найден"), "TARGET_NOT_FOUND"));
    };
    let dex = at(actor.get("abilities"), "dex");
    let modifier = if js::truthy(actor.get("creationBenefits")) {
        let bonus = at(actor.get("creationBenefits"), "initiative_bonus").filter(|value| !value.is_null()).cloned().unwrap_or(json!(0));
        ability_modifier(dex) as f64 + js::number(Some(&bonus))
    } else if js::is_safe_integer_number(actor.get("initiativeBonus")) {
        js::number(actor.get("initiativeBonus")).clamp(-30.0, 30.0)
    } else {
        ability_modifier(dex) as f64
    };
    let options = sk_items_life::item_lifecycle::MechanicEffectOptions { selected_item_id: None, selected_counts_as_equipped: false };
    let effects = sk_items_life::item_lifecycle::active_item_mechanic_effects(Some(&actor), &options).map_err(|error| Halt::from(Fault::type_error(error.message().to_string())))?;
    let item_sources: Vec<Value> = effects
        .iter()
        .filter(|effect| js::truthy(effect.get("initiative_advantage")))
        .map(|effect| {
            let mut source = Map::new();
            for key in ["effect_id", "item_id", "item_name", "catalog_id"] {
                insert_present(&mut source, key, effect.get(key));
            }
            Value::Object(source)
        })
        .collect();
    let feral_instinct = !game::is_enemy_actor(state, id) && crate::tables::character_class_key(&actor).as_deref() == Some("barbarian") && js::safe_int(actor.get("level"), 1) >= 7;
    let advantage = !item_sources.is_empty() || feral_instinct;
    // `Number(initiative_bonus)` бывает NaN: JS отдаёт его костям, и `rollD20`
    // отказывает до броска. В JSON NaN не записать — отказ тот же, здесь.
    if !modifier.is_finite() {
        return Err(Fault::new("DiceExpressionError", "Некорректный модификатор d20").into());
    }
    let request = json!({ "modifier": js::num(modifier), "purpose": "initiative", "actorId": id, "advantage": advantage, "visibility": "public" });
    let roll = {
        use crate::dice_record::RulesDice;
        r.dice.roll_d20(&request)?
    };
    r.rolls.push(roll.clone());
    let mut entry = Map::new();
    entry.insert("actor_id".into(), json!(id));
    insert_present(&mut entry, "total", roll.get("total"));
    entry.insert("modifier".into(), js::num(modifier));
    insert_present(&mut entry, "roll", roll.get("kept"));
    insert_present(&mut entry, "dice", roll.get("dice"));
    insert_present(&mut entry, "roll_id", roll.get("roll_id"));
    if advantage {
        entry.insert("mode".into(), json!("advantage"));
        let mut sources = item_sources;
        if feral_instinct {
            sources.push(json!({ "feature_id": "feral-instinct" }));
        }
        entry.insert("advantage_sources".into(), Value::Array(sources));
    }
    Ok(Value::Object(entry))
}

/// `StartCombat` (19844–19973).
pub fn start_combat(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let member_ids = party_member_ids(&state);
    let players = array_of(state.get("players"));
    let party_ids: Vec<String> = players
        .iter()
        .filter(|actor| {
            let id = game::actor_id(actor);
            member_ids.contains(&id)
                && !is_empty_hero_seat(Some(actor))
                && (game::is_living_actor(actor) || (game::actor_hp(actor) == 0 && actor.get("alive") != Some(&Value::Bool(false)) && !is_dead_hero(&state, &id)))
        })
        .map(game::actor_id)
        .collect();
    let expired: IndexSet<String> = summon_ids_expired_at(&state, world_time_seconds(&state)).into_iter().collect();
    let expiring: Vec<Value> = party_summons_for_expiry(&state).into_iter().filter(|summon| expired.contains(&game::actor_id(summon))).collect();
    r.events.extend(summon_expiry_events(&command, &state, &expiring, true));
    let summons: Vec<Value> = array_of(state.get("actors"))
        .iter()
        .filter(|actor| game::is_party_summon(actor) && !expired.contains(&game::actor_id(actor)) && game::is_living_actor(actor) && member_ids.contains(&owner_of(actor)))
        .cloned()
        .collect();
    let summon_ids: Vec<String> = summons.iter().map(game::actor_id).collect();
    let encounter_enemy_ids: IndexSet<String> = match at(game::mechanics(&state).get("encounter"), "enemy_ids") {
        Some(Value::Array(ids)) => ids.iter().map(|id| js::string(Some(id))).collect(),
        _ => IndexSet::new(),
    };
    let enemy_ids: Vec<String> = array_of(state.get("enemies"))
        .iter()
        .filter(|enemy| game::is_living_actor(enemy) && (encounter_enemy_ids.is_empty() || encounter_enemy_ids.contains(&game::actor_id(enemy))))
        .map(game::actor_id)
        .collect();
    let mut all: Vec<String> = party_ids.iter().chain(summon_ids.iter()).cloned().collect();
    if !enemy_ids.is_empty() {
        all.extend(enemy_ids.iter().cloned());
    }
    let participant_ids = unique_string_list(&all);
    if participant_ids.len() < 2 || enemy_ids.is_empty() {
        let message = if enemy_ids.is_empty() { "Бой не начат: рядом нет живых противников. Чтобы найти схватку, напишите «Ищем бой»." } else { "Для боя нужны живые герои и противники" };
        return Err(rule(message, "COMBAT_PARTICIPANTS_REQUIRED"));
    }
    let mut entries = Vec::new();
    for id in party_ids.iter().chain(enemy_ids.iter()) {
        entries.push(initiative_entry(r, &state, id)?);
    }
    let mut initiative = sorted_initiative(&entries);
    let mut sorted_summons = summons.clone();
    sorted_summons.sort_by(|left, right| text::locale_compare(&game::actor_id(left), &game::actor_id(right)));
    for summon in &sorted_summons {
        let owner_id = owner_of(summon);
        let Some(owner_index) = initiative.iter().position(|entry| js::string(entry.get("actor_id")) == owner_id) else { continue };
        let mut insert_at = owner_index + 1;
        while insert_at < initiative.len() {
            let queued = game::find_actor(&state, &js::s(initiative[insert_at].get("actor_id")));
            if !queued.is_some_and(game::is_party_summon) || queued.map(owner_of).as_deref() != Some(owner_id.as_str()) {
                break;
            }
            insert_at += 1;
        }
        let owner_entry = initiative[owner_index].clone();
        let mut entry = Map::new();
        entry.insert("actor_id".into(), Value::String(game::actor_id(summon)));
        insert_present(&mut entry, "total", owner_entry.get("total"));
        insert_present(&mut entry, "modifier", owner_entry.get("modifier"));
        insert_present(&mut entry, "roll", owner_entry.get("roll"));
        entry.insert("dice".into(), owner_entry.get("dice").filter(|value| !value.is_null()).cloned().unwrap_or(json!([])));
        insert_present(&mut entry, "roll_id", owner_entry.get("roll_id"));
        entry.insert("shared_with".into(), Value::String(owner_id));
        initiative.insert(insert_at, Value::Object(entry));
    }
    let finale = sk_attention::scenario_attention::scenario_finale_tactics(&state, &enemy_ids);
    let surprised: Vec<String> = match finale.as_ref().map(|tactics| tactics.surprise) {
        Some("none") => Vec::new(),
        Some("enemies") => enemy_ids.clone(),
        _ => {
            let party: Vec<String> = party_ids.iter().chain(summon_ids.iter()).cloned().collect();
            surprised_participants(&state, &party, &enemy_ids)
        }
    };
    let group_initiative = js::is_true(command.get("group_initiative")) || js::is_true(js::path(&state, &["campaign", "rules", "group_initiative"]));
    let command_id = js::string(command.get("command_id"));
    let started_event_id = format!("combat-started:{}", slice_utf16(&command_id, 100));
    let instance_id = format!("combat-instance:{}", sk_core::hash::sha256_hex(command_id.as_bytes()));
    let first_actor = initiative.first().map(|entry| js::s(entry.get("actor_id"))).unwrap_or_default();
    let opening = r.context.get("openingAction").filter(|value| js::truthy(Some(value))).filter(|opening| js::string(opening.get("actor_id")) == js::string(command.get("actor_id"))).map(|opening| {
        let resolved = js::is_true(opening.get("free_strike")) || first_actor == js::string(command.get("actor_id"));
        let mut action = spread_value(Some(opening));
        action.insert("status".into(), json!(if resolved { "resolved" } else { "deferred" }));
        action.insert("first_actor_id".into(), json!(first_actor));
        Value::Object(action)
    });
    let mut payload = Map::new();
    payload.insert("round".into(), json!(1));
    payload.insert("initiative".into(), Value::Array(initiative.clone()));
    payload.insert("active_index".into(), json!(if initiative.is_empty() { -1 } else { 0 }));
    payload.insert("party_ids".into(), json!(party_ids));
    payload.insert("enemy_ids".into(), json!(enemy_ids));
    payload.insert("combat_instance_id".into(), json!(instance_id));
    if group_initiative {
        payload.insert("group_initiative".into(), json!(true));
    }
    if !surprised.is_empty() {
        payload.insert("surprised".into(), json!(surprised));
    }
    if let Some(tactics) = &finale {
        payload.insert("scenario_finale".into(), json!({ "readiness": tactics.readiness, "reason": tactics.reason }));
    }
    if let Some(opening) = opening {
        payload.insert("opening_action".into(), opening);
    }
    let mut event = spread_value(Some(&event_from(&command, "CombatStarted", Some(Value::Object(payload)), Some(&json!(participant_ids)))));
    event.insert("event_id".into(), json!(started_event_id));
    r.events.push(Value::Object(event));
    let drafts = sk_npc_world::npc_positioning::npc_combat_stance_event_drafts(&state, &json!(started_event_id), &json!(participant_ids));
    r.events.extend(npc_world_events_from(&command, &Value::Array(drafts)));
    for surprised_id in &surprised {
        let mut payload = Map::new();
        payload.insert("condition".into(), json!("surprised"));
        payload.insert("duration".into(), json!("until-own-turn-end"));
        payload.insert("passive_perception".into(), js::num(passive_perception(game::find_actor(&state, surprised_id), Some(&state))));
        if let Some(tactics) = finale.as_ref().filter(|tactics| tactics.surprise == "enemies") {
            payload.insert("source".into(), json!("scenario-attention"));
            payload.insert("reason".into(), json!(tactics.reason));
        }
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(payload)), Some(&json!([surprised_id]))));
    }
    if let Some(first) = initiative.first() {
        let targets = json!([first.get("actor_id").cloned().unwrap_or(Value::Null)]);
        let payload = json!({ "round": 1, "active_index": 0, "action_economy_version": ACTION_ECONOMY_EVENT_VERSION });
        r.events.push(event_from(&command_with_rules(&command, &[rule_ids::TURNS]), "TurnStarted", Some(payload), Some(&targets)));
    }
    Ok(())
}

/// `EndCombat` (19974–20004).
pub fn end_combat(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let command = r.command.clone();
    let combat = game::combat(&state).clone();
    if !js::truthy(combat.get("active")) {
        return Err(rule("Бой не начат", "COMBAT_NOT_ACTIVE"));
    }
    if js::is_true(combat.get("round_time_pending")) {
        let source = command_with_rules(&command, &[rule_ids::TURNS]);
        let options = TimeAdvanceOptions { source_state: None, elapsed_seconds: Some(6.0), policy_id: Some(COMBAT_ROUND_TIME_POLICY.into()) };
        r.append_world_time_consequences(&source, Some(&json!(6)), Some(&json!("second")), options)?;
    }
    let after_end_round = r.project_events()?;
    let expired: IndexSet<String> = summon_ids_expired_at(&after_end_round, world_time_seconds(&after_end_round)).into_iter().collect();
    let expiring: Vec<Value> = party_summons_for_expiry(&after_end_round).into_iter().filter(|summon| expired.contains(&game::actor_id(summon))).collect();
    r.events.extend(summon_expiry_events(&command, &after_end_round, &expiring, true));
    let reason_raw = command.get("reason").filter(|value| js::truthy(Some(value))).map_or_else(|| "resolved".to_string(), |value| js::string(Some(value)));
    let reason = slice_utf16(&reason_raw, 120);
    let initiative_ids: Vec<Value> = array_of(combat.get("initiative")).iter().map(|entry| entry.get("actor_id").cloned().unwrap_or(Value::Null)).collect();
    let mut payload = Map::new();
    insert_present(&mut payload, "round", combat.get("round"));
    payload.insert("reason".into(), json!(reason));
    r.events.push(event_from(&command, "CombatEnded", Some(Value::Object(payload)), Some(&Value::Array(initiative_ids))));
    let encounter = game::mechanics(&state).get("encounter").cloned();
    let status = js::s(at(encounter.as_ref(), "status"));
    if matches!(status.as_str(), "staged" | "active") {
        let encounter = encounter.unwrap_or(Value::Null);
        let enemy_ids = encounter.get("enemy_ids").filter(|value| !value.is_null()).cloned().unwrap_or(json!([]));
        let mut payload = Map::new();
        insert_present(&mut payload, "encounter_id", crate::core::coalesce(&[encounter.get("id"), encounter.get("encounter_id")]));
        payload.insert("outcome".into(), json!(reason));
        payload.insert("reason".into(), json!(reason));
        payload.insert("enemy_ids".into(), enemy_ids.clone());
        r.events.push(event_from(&command, "EncounterEnded", Some(Value::Object(payload)), Some(&enemy_ids)));
    }
    let drafts = sk_world_life::captives::plan_capture_drafts(&state);
    r.events.extend(npc_world_events_from(&command, &Value::Array(drafts)));
    Ok(())
}
