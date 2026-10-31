//! Ветки `resolveCommandInternal`: Переговоры посреди боя: предложение и уговор. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21441–21588, 21589–21655. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_society::parley::{parley_attempts, parley_morale_for, parley_refusal_line, parley_taunt, parley_terms_for, parley_tribute_cp, standing_enemies, truce_for, PARLEY_ABILITY, PARLEY_POLICY_ID, PARLEY_TERMS};

use super::super::Resolve;
use super::{balance_cp, command_id_head, elapsed_minutes, hero_label, insert_present, tail_utf16, with_field, with_visibility};
use crate::checks::saves::check_roll_from_verified;
use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, npc_world_events_from, player_actor, spread_value};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Flow};
use crate::preview_checks::preview_d20_check;

fn get(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `ProposeParley` (21441–21588).
pub fn propose_parley(r: &mut Resolve<'_>) -> Flow {
    let round = sk_core::game::combat(&r.state).get("round").cloned();
    let morale = parley_morale_for(&r.state);
    let attempt = parley_attempts(&r.state) + 1;
    let actor = sk_core::game::find_actor(&r.state, &js::s(r.command.get("actor_id"))).cloned();
    let actor_targets = json!([get(&r.command, "actor_id")]);
    let turns = command_with_rules(&r.command, &[rule_ids::TURNS]);
    r.events.push(event_from(&turns, "CombatActionUsed", Some(json!({ "action_id": "propose-parley", "name": "Предложить переговоры", "action_type": "action" })), Some(&actor_targets)));
    let party = with_visibility(&r.command, "party");
    if js::truthy(morale.get("refuses")) {
        let mut proposed = Map::new();
        insert_present(&mut proposed, "hero_id", r.command.get("actor_id"));
        insert_present(&mut proposed, "skill", r.command.get("skill"));
        proposed.insert("ability".into(), json!(PARLEY_ABILITY));
        proposed.insert("attempt".into(), json!(attempt));
        insert_present(&mut proposed, "leader_id", morale.get("leader_id"));
        insert_present(&mut proposed, "leader_name", morale.get("leader_name"));
        insert_present(&mut proposed, "difficulty", morale.get("difficulty"));
        proposed.insert("refused".into(), Value::Bool(true));
        proposed.insert("policy_id".into(), json!(PARLEY_POLICY_ID));
        r.events.push(event_from(&party, "ParleyProposed", Some(Value::Object(proposed)), Some(&actor_targets)));
        let mut rejected = Map::new();
        insert_present(&mut rejected, "hero_id", r.command.get("actor_id"));
        insert_present(&mut rejected, "leader_id", morale.get("leader_id"));
        insert_present(&mut rejected, "leader_name", morale.get("leader_name"));
        insert_present(&mut rejected, "reason", morale.get("refusal_reason"));
        rejected.insert("attempt".into(), json!(attempt));
        rejected.insert("taunt".into(), json!(parley_refusal_line(&get(&morale, "refusal_reason"))));
        rejected.insert("policy_id".into(), json!(PARLEY_POLICY_ID));
        r.events.push(event_from(&party, "ParleyRejected", Some(Value::Object(rejected)), Some(&actor_targets)));
        return Ok(());
    }
    let mut preview_options = Map::new();
    insert_present(&mut preview_options, "actorId", r.command.get("actor_id"));
    preview_options.insert("kind".into(), json!("check"));
    preview_options.insert("ability".into(), json!(PARLEY_ABILITY));
    insert_present(&mut preview_options, "skill", r.command.get("skill"));
    insert_present(&mut preview_options, "difficulty", morale.get("difficulty"));
    let preview = preview_d20_check(&r.state, &Value::Object(preview_options))?;
    let skill = js::string(r.command.get("skill"));
    let mut options = Map::new();
    insert_present(&mut options, "modifier", preview.get("modifier"));
    insert_present(&mut options, "difficulty", morale.get("difficulty"));
    options.insert("purpose".into(), Value::String(format!("parley:{skill}")));
    insert_present(&mut options, "actorId", r.command.get("actor_id"));
    insert_present(&mut options, "advantage", preview.get("advantage"));
    options.insert("disadvantage".into(), Value::Bool(js::truthy(preview.get("disadvantage")) || attempt > 1));
    insert_present(&mut options, "visibility", r.command.get("visibility"));
    let options = Value::Object(options);
    let roll = match check_roll_from_verified(r.command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => r.dice.roll_check(&options)?,
    };
    r.rolls.push(roll.clone());
    let source = command_with_rules(&r.command, &[rule_ids::ABILITY_CHECK, if attempt > 1 { rule_ids::ADVANTAGE } else { "" }]);
    let mut proposed = Map::new();
    insert_present(&mut proposed, "hero_id", r.command.get("actor_id"));
    insert_present(&mut proposed, "skill", r.command.get("skill"));
    proposed.insert("ability".into(), json!(PARLEY_ABILITY));
    proposed.insert("attempt".into(), json!(attempt));
    insert_present(&mut proposed, "leader_id", morale.get("leader_id"));
    insert_present(&mut proposed, "leader_name", morale.get("leader_name"));
    proposed.extend(spread_value(Some(&roll)));
    proposed.insert("refused".into(), Value::Bool(false));
    proposed.insert("policy_id".into(), json!(PARLEY_POLICY_ID));
    r.events.push(event_from(&source, "ParleyProposed", Some(Value::Object(proposed)), Some(&actor_targets)));
    if !js::truthy(roll.get("success")) {
        let mut taunt_options = Map::new();
        insert_present(&mut taunt_options, "leaderId", morale.get("leader_id"));
        insert_present(&mut taunt_options, "round", round.as_ref());
        taunt_options.insert("attempt".into(), json!(attempt));
        let mut rejected = Map::new();
        insert_present(&mut rejected, "hero_id", r.command.get("actor_id"));
        insert_present(&mut rejected, "leader_id", morale.get("leader_id"));
        insert_present(&mut rejected, "leader_name", morale.get("leader_name"));
        rejected.insert("reason".into(), json!("roll_failed"));
        rejected.insert("attempt".into(), json!(attempt));
        rejected.insert("taunt".into(), json!(parley_taunt(&r.state, &Value::Object(taunt_options))));
        rejected.insert("policy_id".into(), json!(PARLEY_POLICY_ID));
        r.events.push(event_from(&party, "ParleyRejected", Some(Value::Object(rejected)), Some(&actor_targets)));
        return Ok(());
    }
    let leader_id = get(&morale, "leader_id");
    let leader = sk_core::game::find_actor(&r.state, &js::s(Some(&leader_id))).cloned();
    let persona = sk_world_life::captives::captive_persona(&r.state, &leader.unwrap_or_else(|| json!({ "id": leader_id.clone() })));
    let leader_name = if js::truthy(morale.get("leader_name")) { get(&morale, "leader_name") } else { get(&persona, "name") };
    let leader_key = leader_id.as_str().map(str::to_string);
    let known = r.state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).is_some_and(|npcs| {
        npcs.iter().any(|npc| Some(js::s(npc.get("id"))) == leader_key)
    });
    if !known {
        let mut npc = Map::new();
        npc.insert("id".into(), leader_id.clone());
        npc.insert("name".into(), leader_name.clone());
        insert_present(&mut npc, "role", persona.get("role"));
        npc.insert("location".into(), json!(""));
        npc.insert("public_summary".into(), json!("Ведёт переговоры за свою сторону под перемирием."));
        insert_present(&mut npc, "voice", persona.get("voice"));
        npc.insert("goals".into(), json!(["выторговать своим жизнь"]));
        npc.insert("beliefs".into(), json!([]));
        npc.insert("known_fact_ids".into(), json!([]));
        npc.insert("social_dcs".into(), json!({}));
        npc.insert("visibility".into(), json!("party"));
        npc.insert("available".into(), Value::Bool(false));
        npc.insert("tags".into(), json!(["parley-leader"]));
        npc.insert("schedule".into(), json!([]));
        npc.insert("inventory".into(), json!([]));
        let drafts = json!([{ "event_type": "NpcSocialProfileUpserted", "payload": { "npc": Value::Object(npc) }, "target_ids": [], "visibility": "party" }]);
        r.events.extend(npc_world_events_from(&r.command, &drafts));
    }
    let outcomes = get(&morale, "outcomes");
    let tribute = outcomes.as_array().is_some_and(|items| items.iter().any(|item| item.as_str() == Some("tribute")));
    let mut truce = Map::new();
    truce.insert("leader_id".into(), leader_id.clone());
    truce.insert("leader_name".into(), leader_name);
    insert_present(&mut truce, "hero_id", r.command.get("actor_id"));
    truce.insert("hero_name".into(), Value::String(hero_label(actor.as_ref(), r.command.get("actor_id"), 160)));
    insert_present(&mut truce, "skill", r.command.get("skill"));
    insert_present(&mut truce, "difficulty", morale.get("difficulty"));
    truce.insert("total".into(), json!(js::safe_int(roll.get("total"), 0)));
    insert_present(&mut truce, "round", round.as_ref());
    truce.insert("established_at_minutes".into(), elapsed_minutes(&r.state));
    truce.insert("outcomes".into(), outcomes);
    truce.insert("tribute_cp".into(), json!(if tribute { parley_tribute_cp(&r.state) } else { 0 }));
    let truce = Value::Object(truce);
    let terms = parley_terms_for(&truce);
    let targets = json!([leader_id, get(&r.command, "actor_id")]);
    r.events.push(event_from(&party, "TruceEstablished", Some(json!({ "truce": truce, "terms": terms, "policy_id": PARLEY_POLICY_ID })), Some(&targets)));
    Ok(())
}

/// `SettleParley` (21589–21655).
pub fn settle_parley(r: &mut Resolve<'_>) -> Flow {
    let Some(truce) = truce_for(&r.state) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'tribute_cp')").into());
    };
    let round = sk_core::game::combat(&r.state).get("round").cloned();
    let outcome = js::string(r.command.get("outcome"));
    let term = PARLEY_TERMS.iter().find(|term| term.id == outcome).copied().unwrap_or(PARLEY_TERMS[3]);
    let minutes = elapsed_minutes(&r.state);
    let leaving: Vec<String> = if outcome == "resume" { Vec::new() } else { standing_enemies(&r.state).into_iter().map(|enemy| js::string(enemy.get("id"))).collect() };
    let Some(actor) = player_actor(&r.state, r.command.get("actor_id")).cloned() else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'currency')").into());
    };
    let tribute_cp = if outcome == "tribute" { js::safe_int(truce.get("tribute_cp"), 0).max(0) } else { 0 };
    let before_cp = balance_cp(Some(&actor));
    let after_cp = sk_economy::merchant_economy::MAX_CURRENCY_CP.min(before_cp + tribute_cp);
    let settle_event_id = format!("parley-settled:{}", command_id_head(&r.command, 100));
    let party = with_visibility(&r.command, "party");
    let mut payload = Map::new();
    insert_present(&mut payload, "outcome", r.command.get("outcome"));
    payload.insert("term_id".into(), json!(term.id));
    payload.insert("term_label".into(), json!(term.label));
    payload.insert("term_summary".into(), json!(term.summary));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    insert_present(&mut payload, "leader_id", truce.get("leader_id"));
    insert_present(&mut payload, "leader_name", truce.get("leader_name"));
    payload.insert("enemy_ids".into(), json!(leaving));
    insert_present(&mut payload, "round", round.as_ref());
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("tribute_cp".into(), json!(after_cp - before_cp));
    if tribute_cp > 0 {
        super::insert_wallet(&mut payload, Some(&actor), before_cp, after_cp);
    }
    payload.insert("policy_id".into(), json!(PARLEY_POLICY_ID));
    let targets = json!([get(&truce, "leader_id"), get(&r.command, "actor_id")]);
    let event = event_from(&party, "ParleySettled", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_field(event, "event_id", Value::String(settle_event_id.clone())));
    let conditions = command_with_rules(&party, &[rule_ids::CONDITIONS]);
    let condition = if outcome == "surrender" { "surrendered" } else { "fled" };
    for enemy_id in &leaving {
        let payload = json!({ "condition": condition, "duration": null, "source": "parley", "parley_outcome": outcome });
        r.events.push(event_from(&conditions, "ConditionAdded", Some(payload), Some(&json!([enemy_id]))));
    }
    if outcome == "withdraw" || outcome == "tribute" {
        let leader_name = js::s(truce.get("leader_name"));
        let fact = json!({
            "id": format!("fact:parley-oath:{}", tail_utf16(&settle_event_id, 24)),
            "subject_id": get(&truce, "leader_id"),
            "predicate": "parley_oath",
            "object": outcome,
            "summary": format!("{} увёл своих по уговору с отрядом и поклялся не возвращаться.", if leader_name.is_empty() { "Противник".to_string() } else { leader_name }),
            "visibility": "party",
            "source_event_ids": [settle_event_id],
            "status": "active",
            "recorded_at_minutes": minutes,
        });
        r.events.push(event_from(&party, "WorldFactRecorded", Some(json!({ "fact": fact })), Some(&json!([]))));
    }
    Ok(())
}
