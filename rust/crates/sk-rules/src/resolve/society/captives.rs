//! Ветки `resolveCommandInternal`: Пленные: допрос, освобождение, сдача страже, кормление, забвение, казнь. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21030–21080, 21081–21132, 21133–21184, 21185–21195, 21196–21203, 21204–21244. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_npc_world::npc_positioning::{npc_harm_event_drafts, npc_vital_for, NpcHarmOptions, NPC_WORLD_POLICY_ID};
use sk_world_life::captives::{captive_bounty_cp, captive_for, captive_interrogation_policy, captive_neglected_payload, captive_settlement_for, captive_spared_disposition, local_faction_ids, CAPTIVES_POLICY_ID, CAPTIVE_SPARED_RELATIONSHIP_DELTA};

use super::super::Resolve;
use super::{balance_cp, command_id_head, elapsed_minutes, insert_present, insert_wallet, with_field, with_visibility};
use crate::checks::saves::check_roll_from_verified;
use crate::checks::skills::skill_proficiency_for_actor;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with_rules, event_from, npc_world_events_from, player_actor, slice_utf16, spread_value};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Halt, Step};
use crate::society_helpers::npc_relationship_events_from;

/// `captiveFor(state, command.captive_id)`: пленный проверен валидацией; без
/// него JS падает на первом обращении к полю.
fn captive_of(r: &Resolve<'_>, field: &str) -> Result<Value, Halt> {
    captive_for(&r.state, r.command.get("captive_id")).ok_or_else(|| Fault::type_error(format!("Cannot read properties of null (reading '{field}')")).into())
}

fn get<'a>(value: &'a Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `InterrogateCaptive` (21030–21080).
pub fn interrogate_captive(r: &mut Resolve<'_>) -> Step {
    let captive = captive_of(r, "npc_id")?;
    let actor = sk_core::game::find_actor(&r.state, &js::s(r.command.get("actor_id"))).cloned();
    let standing = sk_society::reputation_policy::reputation_standing_for(&r.state, &get(&captive, "npc_id"));
    let mut policy_options = Map::new();
    insert_present(&mut policy_options, "skill", r.command.get("skill"));
    insert_present(&mut policy_options, "reputationShift", standing.get("social_dc_shift"));
    let policy = captive_interrogation_policy(&r.state, &captive, &Value::Object(policy_options));
    let skill = js::string(policy.get("skill"));
    let ability = js::string(policy.get("ability"));
    let proficiency = skill_proficiency_for_actor(actor.as_ref(), policy.get("skill"), Some(&r.state));
    let bonus = proficiency.get("bonus").filter(|value| !value.is_null()).map_or(0.0, |value| js::number(Some(value)));
    let modifier = ability_modifier(actor.as_ref().and_then(|actor| actor.get("abilities")).and_then(|abilities| abilities.get(&ability))) as f64 + bonus;
    let mut options = Map::new();
    options.insert("modifier".into(), js::num(modifier));
    insert_present(&mut options, "difficulty", policy.get("difficulty"));
    options.insert("purpose".into(), Value::String(format!("captive_interrogation:{skill}")));
    insert_present(&mut options, "actorId", r.command.get("actor_id"));
    insert_present(&mut options, "visibility", r.command.get("visibility"));
    let options = Value::Object(options);
    let roll = match check_roll_from_verified(r.command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => r.dice.roll_check(&options)?,
    };
    r.rolls.push(roll.clone());
    let interrogation_event_id = format!("captive-interrogated:{}", command_id_head(&r.command, 100));
    let success = js::truthy(roll.get("success"));
    let mut payload = Map::new();
    payload.insert("captive_id".into(), get(&captive, "id"));
    payload.insert("npc_id".into(), get(&captive, "npc_id"));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("skill".into(), get(&policy, "skill"));
    payload.insert("ability".into(), get(&policy, "ability"));
    payload.insert("temper".into(), get(&policy, "temper"));
    payload.insert("fear_shift".into(), get(&policy, "fear_shift"));
    payload.extend(spread_value(Some(&roll)));
    insert_present(&mut payload, "success", roll.get("success"));
    if success {
        insert_present(&mut payload, "fact_id", policy.get("fact_id"));
    }
    payload.insert("policy_id".into(), json!(CAPTIVES_POLICY_ID));
    let source = command_with_rules(&r.command, &[rule_ids::ABILITY_CHECK]);
    let targets = json!([get(&captive, "npc_id"), get(&r.command, "actor_id")]);
    let event = event_from(&source, "CaptiveInterrogated", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_field(event, "event_id", Value::String(interrogation_event_id.clone())));
    if success && js::truthy(policy.get("fact_id")) {
        let revealed = captive.get("revealed_fact_ids").and_then(Value::as_array).map_or(0, Vec::len);
        let mut knowledge = Map::new();
        knowledge.insert("knowledge_id".into(), Value::String(format!("{}:knowledge:{}", js::string(captive.get("id")), revealed + 1)));
        insert_present(&mut knowledge, "hero_id", r.command.get("actor_id"));
        knowledge.insert("fact_id".into(), get(&policy, "fact_id"));
        knowledge.insert("source_event_ids".into(), json!([interrogation_event_id]));
        knowledge.insert("source_kind".into(), json!("npc"));
        knowledge.insert("revealed_at_minutes".into(), elapsed_minutes(&r.state));
        let source = with_visibility(&r.command, "specific_player");
        let targets = json!([get(&r.command, "actor_id")]);
        r.events.push(event_from(&source, "KnowledgeRevealed", Some(Value::Object(knowledge)), Some(&targets)));
    }
    Ok(())
}

/// `ReleaseCaptive` (21081–21132).
pub fn release_captive(r: &mut Resolve<'_>) -> Step {
    let captive = captive_of(r, "id")?;
    let disposition = captive_spared_disposition(&captive);
    let minutes = elapsed_minutes(&r.state);
    let release_event_id = format!("captive-released:{}", command_id_head(&r.command, 100));
    let mut payload = Map::new();
    payload.insert("captive_id".into(), get(&captive, "id"));
    payload.insert("npc_id".into(), get(&captive, "npc_id"));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("disposition".into(), json!(disposition));
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), json!(CAPTIVES_POLICY_ID));
    let targets = json!([get(&captive, "npc_id"), get(&r.command, "actor_id")]);
    let event = event_from(&r.command, "CaptiveReleased", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_field(event, "event_id", Value::String(release_event_id.clone())));
    let relationship = npc_relationship_events_from(&r.command, &r.state, captive.get("npc_id"), r.command.get("actor_id"), Some(&json!(CAPTIVE_SPARED_RELATIONSHIP_DELTA)), Some(&json!("captive-spared")));
    r.events.extend(relationship);
    let stance = json!({
        "npc_id": get(&captive, "npc_id"),
        "npc_name": get(&captive, "name"),
        "stance": "guarded",
        "reason": "captive-released",
        "source_event_id": release_event_id,
        "propagation_depth": 0,
        "policy_id": NPC_WORLD_POLICY_ID,
    });
    let targets = json!([get(&captive, "npc_id")]);
    r.events.push(event_from(&with_visibility(&r.command, "party"), "NpcStanceChanged", Some(stance), Some(&targets)));
    let name = js::string(captive.get("name"));
    let summary = match disposition {
        "ally" => format!("{name} отпущен(а) живым и готов(а) однажды встать рядом с отрядом."),
        "informant" => format!("{name} отпущен(а) живым и может ещё принести отряду весть."),
        _ => format!("{name} отпущен(а) живым и просто ушёл(ушла) своей дорогой."),
    };
    let fact = json!({
        "id": format!("fact:captive-spared:{}", slice_utf16(&js::string(captive.get("id")), 60)),
        "subject_id": get(&captive, "npc_id"),
        "predicate": "spared_by_party",
        "object": disposition,
        "summary": summary,
        "visibility": "gm_only",
        "source_event_ids": [release_event_id],
        "status": "active",
        "recorded_at_minutes": minutes,
    });
    r.events.push(event_from(&with_visibility(&r.command, "gm_only"), "WorldFactRecorded", Some(json!({ "fact": fact })), Some(&json!([]))));
    Ok(())
}

/// `HandCaptiveToGuards` (21133–21184).
pub fn hand_captive_to_guards(r: &mut Resolve<'_>) -> Step {
    let captive = captive_of(r, "id")?;
    let Some(settlement) = captive_settlement_for(&r.state) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'id')").into());
    };
    let Some(actor) = player_actor(&r.state, r.command.get("actor_id")).cloned() else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'currency')").into());
    };
    let bounty_cp = captive_bounty_cp(&captive);
    let before_cp = balance_cp(Some(&actor));
    let after_cp = sk_economy::merchant_economy::MAX_CURRENCY_CP.min(before_cp + bounty_cp);
    let minutes = elapsed_minutes(&r.state);
    let handover_event_id = format!("captive-handed-over:{}", command_id_head(&r.command, 100));
    let mut payload = Map::new();
    payload.insert("captive_id".into(), get(&captive, "id"));
    payload.insert("npc_id".into(), get(&captive, "npc_id"));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("settlement_id".into(), get(&settlement, "id"));
    payload.insert("settlement_name".into(), get(&settlement, "name"));
    payload.insert("bounty_cp".into(), json!(after_cp - before_cp));
    insert_wallet(&mut payload, Some(&actor), before_cp, after_cp);
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), json!(CAPTIVES_POLICY_ID));
    let targets = json!([get(&captive, "npc_id"), get(&r.command, "actor_id")]);
    let event = event_from(&r.command, "CaptiveHandedOver", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_field(event, "event_id", Value::String(handover_event_id.clone())));
    let party = with_visibility(&r.command, "party");
    for faction_id in local_faction_ids(&r.state) {
        let payload = json!({
            "faction_id": faction_id,
            "delta": 3,
            "source_event_id": handover_event_id,
            "captive_id": get(&captive, "id"),
            "provenance": { "source": "server-captive-policy", "policy": CAPTIVES_POLICY_ID },
        });
        r.events.push(event_from(&party, "FactionReputationAdjusted", Some(payload), Some(&json!([]))));
    }
    let fact = json!({
        "id": format!("fact:captive-handed-over:{}", slice_utf16(&js::string(captive.get("id")), 60)),
        "subject_id": get(&captive, "npc_id"),
        "predicate": "handed_to_watch",
        "object": get(&settlement, "id"),
        "summary": format!("{} передан(а) страже поселения «{}».", js::string(captive.get("name")), js::string(settlement.get("name"))),
        "visibility": "party",
        "source_event_ids": [handover_event_id],
        "status": "active",
        "recorded_at_minutes": minutes,
    });
    r.events.push(event_from(&party, "WorldFactRecorded", Some(json!({ "fact": fact })), Some(&json!([]))));
    Ok(())
}

/// `FeedCaptive` (21185–21195).
pub fn feed_captive(r: &mut Resolve<'_>) -> Step {
    let captive = captive_of(r, "id")?;
    let mut payload = Map::new();
    payload.insert("captive_id".into(), get(&captive, "id"));
    payload.insert("npc_id".into(), get(&captive, "npc_id"));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("at_minutes".into(), elapsed_minutes(&r.state));
    payload.insert("policy_id".into(), json!(CAPTIVES_POLICY_ID));
    let targets = json!([get(&captive, "npc_id")]);
    r.events.push(event_from(&r.command, "CaptiveFed", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `NeglectCaptive` (21196–21203).
pub fn neglect_captive(r: &mut Resolve<'_>) -> Step {
    let captive = captive_of(r, "id")?;
    let payload = captive_neglected_payload(&captive, Some(&elapsed_minutes(&r.state)));
    let targets = json!([get(&captive, "npc_id")]);
    r.events.push(event_from(&with_visibility(&r.command, "party"), "CaptiveNeglected", Some(payload), Some(&targets)));
    Ok(())
}

/// `ExecuteCaptive` (21204–21244).
pub fn execute_captive(r: &mut Resolve<'_>) -> Step {
    let captive = captive_of(r, "npc_id")?;
    let npc_id = get(&captive, "npc_id");
    let vital = npc_vital_for(&r.state, &npc_id);
    let amount = js::safe_int(vital.get("hp"), 1).max(1);
    let options = NpcHarmOptions {
        npc_id: Some(npc_id.clone()),
        amount: Some(json!(amount)),
        damage_type: Some(json!("slashing")),
        source_actor_id: r.command.get("actor_id").cloned(),
        trigger: Some(json!("captive-execution")),
        command_id: r.command.get("command_id").cloned(),
        ..NpcHarmOptions::default()
    };
    let mut drafts = npc_harm_event_drafts(&r.state, &options);
    if drafts.is_empty() {
        let mut payload = Map::new();
        payload.insert("npc_id".into(), npc_id.clone());
        payload.insert("npc_name".into(), get(&captive, "name"));
        payload.insert("location_id".into(), Value::String(crate::scene_maps::scene_location_id(&r.state)));
        insert_present(&mut payload, "source_actor_id", r.command.get("actor_id"));
        payload.insert("trigger".into(), json!("captive-execution"));
        payload.insert("policy_id".into(), json!(NPC_WORLD_POLICY_ID));
        drafts.push(json!({ "event_type": "NpcDied", "payload": Value::Object(payload), "target_ids": [npc_id.clone()], "visibility": "party" }));
    }
    let source = command_with_rules(&r.command, &[rule_ids::DAMAGE]);
    r.events.extend(npc_world_events_from(&source, &Value::Array(drafts)));
    let mut payload = Map::new();
    payload.insert("captive_id".into(), get(&captive, "id"));
    payload.insert("npc_id".into(), npc_id.clone());
    payload.insert("captive_name".into(), get(&captive, "name"));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("at_minutes".into(), elapsed_minutes(&r.state));
    payload.insert("policy_id".into(), json!(CAPTIVES_POLICY_ID));
    let targets = json!([npc_id, get(&r.command, "actor_id")]);
    r.events.push(event_from(&with_visibility(&r.command, "party"), "CaptiveExecuted", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}
