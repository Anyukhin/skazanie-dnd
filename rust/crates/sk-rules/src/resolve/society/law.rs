//! Ветки `resolveCommandInternal`: Закон: амнистия и встреча со стражей. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 22139–22152, 22153–22331. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_society::law_and_order::{escape_succeeded, guard_encounter_for, pending_crime_ids_for, wanted_for, GUARD_CUSTODY_MINUTES, LAW_POLICY_ID, MAX_WANTED_LEVEL, WANTED_ESCAPE_FAILURE_POINTS, WANTED_LEVEL_THRESHOLDS};

use super::super::world_time::TimeAdvanceOptions;
use super::super::Resolve;
use super::{balance_cp, elapsed_minutes, hero_label, insert_present, insert_wallet, tail_utf16, with_visibility};
use crate::checks::saves::check_roll_from_verified;
use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, player_actor, slice_utf16, spread_value};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Flow};
use crate::preview_checks::preview_d20_check;

fn get(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `ClearWantedLevel` (22139–22152).
pub fn clear_wanted_level(r: &mut Resolve<'_>) -> Flow {
    let region_id = js::string(r.command.get("region_id"));
    let region = Value::String(region_id.clone());
    let wanted = wanted_for(&r.state, &region);
    let mut payload = Map::new();
    payload.insert("region_id".into(), region.clone());
    insert_present(&mut payload, "region_name", wanted.get("region_name"));
    payload.insert("reason".into(), json!("amnesty"));
    insert_present(&mut payload, "level_before", wanted.get("level"));
    payload.insert("crime_ids".into(), Value::Array(pending_crime_ids_for(&r.state, &region)));
    payload.insert("at_minutes".into(), elapsed_minutes(&r.state));
    payload.insert("policy_id".into(), json!(LAW_POLICY_ID));
    r.events.push(event_from(&with_visibility(&r.command, "gm_only"), "WantedCleared", Some(Value::Object(payload)), Some(&json!([]))));
    Ok(())
}

/// «Отряд … в «место»» — `encounter.place_name || 'поселении'`.
fn place_or_settlement(encounter: &Value) -> String {
    let place = js::s(encounter.get("place_name"));
    if js::truthy(encounter.get("place_name")) { place } else { "поселении".to_string() }
}

/// `{ id, kind: 'defiance', … }` преступления против стражи.
fn defiance_crime(r: &Resolve<'_>, encounter: &Value, points: i64, witnesses: Value, summary: String, minutes: &Value) -> Value {
    let mut crime = Map::new();
    crime.insert("id".into(), Value::String(format!("crime:defiance:{}", tail_utf16(&js::string(r.command.get("command_id")), 24))));
    crime.insert("kind".into(), json!("defiance"));
    crime.insert("points".into(), json!(points));
    insert_present(&mut crime, "region_id", encounter.get("region_id"));
    insert_present(&mut crime, "region_name", encounter.get("region_name"));
    insert_present(&mut crime, "node_id", encounter.get("node_id"));
    insert_present(&mut crime, "place_name", encounter.get("place_name"));
    crime.insert("at_minutes".into(), minutes.clone());
    crime.insert("witnesses".into(), witnesses);
    crime.insert("summary".into(), Value::String(summary));
    Value::Object(crime)
}

/// `ResolveGuardEncounter` (22153–22331).
pub fn resolve_guard_encounter(r: &mut Resolve<'_>) -> Flow {
    let encounter = guard_encounter_for(&r.state);
    if !js::truthy(Some(&encounter)) {
        return Err(Fault::type_error("Cannot read properties of null (reading 'region_id')").into());
    }
    let actor = player_actor(&r.state, r.command.get("actor_id")).cloned();
    let minutes = elapsed_minutes(&r.state);
    let resolution = js::s(r.command.get("resolution"));
    let region = get(&encounter, "region_id");
    let cleared_crime_ids = pending_crime_ids_for(&r.state, &region);
    let wanted_before = wanted_for(&r.state, &region);
    let mut base = Map::new();
    insert_present(&mut base, "encounter_id", encounter.get("id"));
    insert_present(&mut base, "resolution", r.command.get("resolution"));
    insert_present(&mut base, "region_id", encounter.get("region_id"));
    insert_present(&mut base, "region_name", encounter.get("region_name"));
    insert_present(&mut base, "place_name", encounter.get("place_name"));
    insert_present(&mut base, "officer_name", encounter.get("officer_name"));
    insert_present(&mut base, "officer_rank", encounter.get("officer_rank"));
    insert_present(&mut base, "level", encounter.get("level"));
    insert_present(&mut base, "hero_id", r.command.get("actor_id"));
    base.insert("at_minutes".into(), minutes.clone());
    base.insert("policy_id".into(), json!(LAW_POLICY_ID));
    let party = with_visibility(&r.command, "party");
    let actor_targets = json!([get(&r.command, "actor_id")]);
    if resolution == "fine" || resolution == "surrender" {
        let Some(actor) = actor else {
            return Err(Fault::type_error("Cannot read properties of null (reading 'currency')").into());
        };
        let before_cp = balance_cp(Some(&actor));
        let fine = js::number(encounter.get("fine_cp"));
        let taken = if resolution == "fine" { fine } else { (before_cp as f64).min(fine) };
        let after_cp = (before_cp as f64 - taken).max(0.0);
        let mut payload = base.clone();
        payload.insert("success".into(), Value::Bool(true));
        payload.insert("paid_cp".into(), if resolution == "fine" { get(&encounter, "fine_cp") } else { js::num(taken) });
        insert_wallet(&mut payload, Some(&actor), before_cp, after_cp as i64);
        if resolution == "surrender" {
            payload.insert("custody_minutes".into(), json!(GUARD_CUSTODY_MINUTES));
        }
        r.events.push(event_from(&command_with_rules(&party, &[rule_ids::ECONOMY_COINS]), "GuardEncounterResolved", Some(Value::Object(payload)), Some(&actor_targets)));
        let mut cleared = Map::new();
        insert_present(&mut cleared, "region_id", encounter.get("region_id"));
        insert_present(&mut cleared, "region_name", encounter.get("region_name"));
        cleared.insert("reason".into(), json!(resolution));
        insert_present(&mut cleared, "level_before", wanted_before.get("level"));
        cleared.insert("crime_ids".into(), Value::Array(cleared_crime_ids));
        cleared.insert("at_minutes".into(), minutes.clone());
        cleared.insert("policy_id".into(), json!(LAW_POLICY_ID));
        r.events.push(event_from(&party, "WantedCleared", Some(Value::Object(cleared)), Some(&json!([]))));
        if resolution == "surrender" {
            let source = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
            r.append_world_time_consequences(&source, Some(&json!(GUARD_CUSTODY_MINUTES)), Some(&json!("minute")), TimeAdvanceOptions::default())?;
        }
        return Ok(());
    }
    let escape_attempts = js::number(encounter.get("escape_attempts"));
    if resolution == "flee" {
        let members: Vec<String> = match r.state.get("partyMemberIds").and_then(Value::as_array).filter(|ids| !ids.is_empty()) {
            Some(ids) => ids.iter().map(|id| js::string(Some(id))).collect(),
            None => r.state.get("players").and_then(Value::as_array).map(|players| players.iter().map(sk_core::game::actor_id).collect()).unwrap_or_default(),
        };
        let mut runners: Vec<Value> = r.state.get("players").and_then(Value::as_array).map(|players| {
            players.iter().filter(|hero| members.contains(&sk_core::game::actor_id(hero)) && sk_core::game::is_living_actor(hero)).cloned().collect()
        }).unwrap_or_default();
        runners.sort_by(|left, right| sk_core::text::locale_compare(&sk_core::game::actor_id(left), &sk_core::game::actor_id(right)));
        let skill = js::string(r.command.get("skill"));
        let command_actor = js::string(r.command.get("actor_id"));
        let mut checks = Vec::new();
        for hero in &runners {
            let hero_id = sk_core::game::actor_id(hero);
            let mut preview_options = Map::new();
            preview_options.insert("actorId".into(), json!(hero_id));
            preview_options.insert("kind".into(), json!("check"));
            insert_present(&mut preview_options, "skill", r.command.get("skill"));
            insert_present(&mut preview_options, "difficulty", encounter.get("escape_dc"));
            let preview = preview_d20_check(&r.state, &Value::Object(preview_options))?;
            let mut options = Map::new();
            insert_present(&mut options, "modifier", preview.get("modifier"));
            insert_present(&mut options, "difficulty", encounter.get("escape_dc"));
            options.insert("purpose".into(), Value::String(format!("guard-escape:{skill}")));
            options.insert("actorId".into(), json!(hero_id));
            insert_present(&mut options, "advantage", preview.get("advantage"));
            options.insert("disadvantage".into(), Value::Bool(js::truthy(preview.get("disadvantage")) || escape_attempts > 0.0));
            insert_present(&mut options, "visibility", r.command.get("visibility"));
            let options = Value::Object(options);
            let verified = if hero_id == command_actor { check_roll_from_verified(r.command.get("verified_roll"), &options) } else { None };
            let roll = match verified {
                Some(roll) => roll,
                None => r.dice.roll_check(&options)?,
            };
            r.rolls.push(roll.clone());
            let mut check = Map::new();
            check.insert("actor_id".into(), json!(hero_id));
            check.insert("actor_name".into(), Value::String(hero_label(Some(hero), Some(&json!(hero_id)), 160)));
            check.insert("total".into(), json!(js::safe_int(roll.get("total"), 0)));
            insert_present(&mut check, "difficulty", encounter.get("escape_dc"));
            check.insert("success".into(), Value::Bool(js::is_true(roll.get("success"))));
            checks.push(Value::Object(check));
        }
        let checks = Value::Array(checks);
        let escaped = escape_succeeded(&checks);
        let successes = checks.as_array().map_or(0, |items| items.iter().filter(|check| js::truthy(check.get("success"))).count());
        let participants = checks.as_array().map_or(0, Vec::len);
        let mut payload = base.clone();
        payload.insert("success".into(), Value::Bool(escaped));
        insert_present(&mut payload, "skill", r.command.get("skill"));
        insert_present(&mut payload, "difficulty", encounter.get("escape_dc"));
        payload.insert("attempt".into(), js::num(escape_attempts + 1.0));
        payload.insert("checks".into(), checks);
        payload.insert("successes".into(), json!(successes));
        payload.insert("participants".into(), json!(participants));
        let source = command_with_rules(&party, &[rule_ids::ABILITY_CHECK, if escape_attempts > 0.0 { rule_ids::ADVANTAGE } else { "" }]);
        let runner_ids = Value::Array(runners.iter().map(|hero| Value::String(sk_core::game::actor_id(hero))).collect());
        r.events.push(event_from(&source, "GuardEncounterResolved", Some(Value::Object(payload)), Some(&runner_ids)));
        if !escaped {
            let summary = format!("Отряд пытался уйти от стражи в «{}» и не ушёл.", place_or_settlement(&encounter));
            let crime = defiance_crime(r, &encounter, WANTED_ESCAPE_FAILURE_POINTS, json!(1), summary, &minutes);
            let payload = json!({ "reason": "escape_failed", "crime": crime, "policy_id": LAW_POLICY_ID });
            r.events.push(event_from(&with_visibility(&r.command, "gm_only"), "WantedLevelRaised", Some(payload), Some(&json!([]))));
        }
        return Ok(());
    }
    let threshold = WANTED_LEVEL_THRESHOLDS[MAX_WANTED_LEVEL as usize] as f64;
    let escalation = (threshold - js::number(wanted_before.get("raw_points"))).max(1.0);
    let assembled = r.command.get("encounter").cloned().unwrap_or(Value::Null);
    let Some(enemies) = assembled.get("enemies").and_then(Value::as_array).cloned() else {
        return Err(Fault::type_error("Cannot read properties of undefined (reading 'enemies')").into());
    };
    let mut payload = base.clone();
    payload.insert("success".into(), Value::Bool(true));
    payload.insert("enemy_count".into(), json!(enemies.len()));
    r.events.push(event_from(&party, "GuardEncounterResolved", Some(Value::Object(payload)), Some(&actor_targets)));
    let summary = format!("Отряд поднял оружие на стражу в «{}».", place_or_settlement(&encounter));
    let crime = defiance_crime(r, &encounter, escalation as i64, json!(enemies.len()), summary, &minutes);
    let payload = json!({ "reason": "resisted_arrest", "crime": crime, "policy_id": LAW_POLICY_ID });
    r.events.push(event_from(&with_visibility(&r.command, "gm_only"), "WantedLevelRaised", Some(payload), Some(&json!([]))));
    let proposal = js::string(assembled.get("proposal_id"));
    let encounter_id = sk_core::text::replace_first(sk_core::re!(r"^encounter-proposal-", "u"), &proposal, "encounter-");
    let enemy_ids: Vec<Value> = enemies.iter().map(|enemy| Value::String(js::string(enemy.get("id")))).collect();
    let chapter = js::number(r.state.get("adventure").and_then(|adventure| adventure.get("chapter")));
    let chapter = if chapter.is_nan() || chapter == 0.0 { 1.0 } else { chapter };
    let location = match r.state.get("scene").and_then(|scene| scene.get("location")).filter(|value| !value.is_null()) {
        Some(location) => slice_utf16(&js::string(Some(location)), 180),
        None => String::new(),
    };
    let mut staged = spread_value(Some(&assembled));
    staged.insert("id".into(), json!(encounter_id));
    staged.insert("encounter_id".into(), json!(encounter_id));
    staged.insert("status".into(), json!("staged"));
    staged.insert("created_in_chapter".into(), js::num(chapter.max(1.0)));
    staged.insert("location".into(), json!(location));
    staged.insert("enemy_ids".into(), Value::Array(enemy_ids.clone()));
    let payload = json!({
        "encounter": Value::Object(staged),
        "encounter_id": encounter_id,
        "proposal_id": get(&assembled, "proposal_id"),
        "request_fingerprint": r.command.get("request_fingerprint").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null),
    });
    r.events.push(event_from(&r.command, "EncounterCreated", Some(payload), Some(&Value::Array(enemy_ids))));
    Ok(())
}
