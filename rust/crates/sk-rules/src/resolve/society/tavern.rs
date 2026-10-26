//! Ветки `resolveCommandInternal`: Таверна: кости на деньги и выпивка. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21668–21736, 21737–21970, 21971–21982, 21983–22039. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_economy::merchant_economy::MAX_CURRENCY_CP;
use sk_npc_world::tavern_life::{
    tavern_drinks_for, tavern_gambler_for, tavern_gambler_purse_for, tavern_next_drink_dc, tavern_purse_transfer, tavern_round_for, tavern_scandals_for, TAVERN_CHEAT_ABILITY, TAVERN_CHEAT_RELATIONSHIP_DELTA, TAVERN_CHEAT_SKILL, TAVERN_DICE_ROUND_MINUTES,
    TAVERN_DRINK_MINUTES, TAVERN_DRINK_PRICE_CP, TAVERN_DRUNK_CONDITION, TAVERN_DRUNK_DURATION, TAVERN_EXPOSED_RELATIONSHIP_DELTA, TAVERN_POLICY_ID, TAVERN_SCANDALS_BEFORE_EJECTION, TAVERN_SOBER_DRINKS, TAVERN_SOCIAL_BONUS, TAVERN_SOCIAL_SKILL,
    TAVERN_SPOT_SKILL,
};
use sk_npc_world::npc_positioning::NPC_WORLD_POLICY_ID;

use super::super::world_time::TimeAdvanceOptions;
use super::super::Resolve;
use super::{balance_cp, command_id_head, elapsed_minutes, hero_label, insert_present, insert_wallet, with_field, with_visibility};
use crate::checks::saves::{check_roll_from_verified, roll_saving_throw_check, saving_throw_succeeded};
use crate::command::rules::rule_ids;
use crate::conditions::save_disadvantage_condition_for;
use crate::core::{ability_modifier, command_with_rules, condition_ids_for, event_from, player_actor, slice_utf16, spread_value};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Halt, Step};
use crate::preview_checks::{preview_d20_check, preview_tavern_dice_roll, scene_place_text};
use crate::society_helpers::{npc_relationship_events_from, tavern_round_cancelled_event};

fn get(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn null_read(key: &str) -> Halt {
    Fault::type_error(format!("Cannot read properties of null (reading '{key}')")).into()
}

/// `Date.parse(String(roll.created_at ?? '')) || 0`.
fn rolled_at(roll: &Value) -> Value {
    let text = js::s(roll.get("created_at"));
    json!(sk_core::clock::parse_iso(&text).unwrap_or(0))
}

/// `ResistanceChoice` и прочие места: `appendWorldTimeConsequences(commandWithRules(command, RULE_IDS.resource), minutes, 'minute')`.
fn append_minutes(r: &mut Resolve<'_>, minutes: i64) -> Step {
    let source = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
    r.append_world_time_consequences(&source, Some(&json!(minutes)), Some(&json!("minute")), TimeAdvanceOptions::default())
}

/// `OpenTavernDiceRound` (21668–21736).
pub fn open_tavern_dice_round(r: &mut Resolve<'_>) -> Step {
    let gambler = tavern_gambler_for(&r.state, r.command.get("npc_id").unwrap_or(&Value::Null));
    let Some(actor) = player_actor(&r.state, r.command.get("actor_id")).cloned() else {
        return Err(null_read("currency"));
    };
    let minutes = elapsed_minutes(&r.state);
    let stake = js::number(r.command.get("stake_cp"));
    let before_cp = balance_cp(Some(&actor));
    let after_cp = (before_cp as f64 - stake).max(0.0) as i64;
    let roll = r.dice.roll_d20(&json!({ "purpose": "tavern-dice:opponent", "actorId": gambler.npc_id, "visibility": "gm_only" }))?;
    r.rolls.push(roll.clone());
    let shown = gambler.opponent_die(roll.get("kept"));
    let mut round = Map::new();
    round.insert("id".into(), Value::String(format!("tavern-round:{}", command_id_head(&r.command, 100))));
    insert_present(&mut round, "hero_id", r.command.get("actor_id"));
    round.insert("npc_id".into(), json!(gambler.npc_id));
    round.insert("npc_name".into(), json!(gambler.name));
    insert_present(&mut round, "stake_cp", r.command.get("stake_cp"));
    round.insert("npc_total".into(), json!(shown));
    round.insert("target".into(), json!(shown + 1));
    round.insert("opened_at_minutes".into(), minutes.clone());
    let mut payload = Map::new();
    payload.insert("round".into(), Value::Object(round));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("npc_id".into(), json!(gambler.npc_id));
    payload.insert("npc_name".into(), json!(gambler.name));
    insert_present(&mut payload, "stake_cp", r.command.get("stake_cp"));
    payload.insert("npc_total".into(), json!(shown));
    insert_wallet(&mut payload, Some(&actor), before_cp, after_cp);
    payload.insert("at_minutes".into(), minutes);
    payload.insert("policy_id".into(), json!(TAVERN_POLICY_ID));
    let source = command_with_rules(&with_visibility(&r.command, "party"), &[rule_ids::ECONOMY_COINS]);
    let targets = json!([get(&r.command, "actor_id"), gambler.npc_id]);
    r.events.push(event_from(&source, "TavernDiceRoundOpened", Some(Value::Object(payload)), Some(&targets)));
    let die = json!({
        "roll": {
            "id": get(&roll, "roll_id"),
            "kind": "tavern",
            "sides": 20,
            "value": shown,
            "playerId": gambler.npc_id,
            "playerName": gambler.name,
            "rolledAt": rolled_at(&roll),
        },
    });
    r.events.push(event_from(&with_visibility(&r.command, "public"), "PublicDieRolled", Some(die), Some(&json!([]))));
    Ok(())
}

/// Проверка подхода за столом (`cheat`, `watch`): предпросмотр, серверный
/// бросок, `AbilityCheckResolved`. Возвращает бросок.
fn approach_check(r: &mut Resolve<'_>, ability: Option<&str>, skill: &str, difficulty: i64) -> Result<Value, Halt> {
    let mut preview_options = Map::new();
    insert_present(&mut preview_options, "actorId", r.command.get("actor_id"));
    preview_options.insert("kind".into(), json!("check"));
    if let Some(ability) = ability {
        preview_options.insert("ability".into(), json!(ability));
    }
    preview_options.insert("skill".into(), json!(skill));
    preview_options.insert("difficulty".into(), json!(difficulty));
    let preview = preview_d20_check(&r.state, &Value::Object(preview_options))?;
    let mut options = Map::new();
    insert_present(&mut options, "modifier", preview.get("modifier"));
    options.insert("difficulty".into(), json!(difficulty));
    options.insert("purpose".into(), Value::String(format!("tavern-dice:{skill}")));
    insert_present(&mut options, "actorId", r.command.get("actor_id"));
    insert_present(&mut options, "advantage", preview.get("advantage"));
    insert_present(&mut options, "disadvantage", preview.get("disadvantage"));
    options.insert("visibility".into(), json!("party"));
    let check = r.dice.roll_check(&Value::Object(options))?;
    r.rolls.push(check.clone());
    let mut payload = Map::new();
    insert_present(&mut payload, "ability", preview.get("ability"));
    insert_present(&mut payload, "skill", preview.get("skill"));
    payload.extend(spread_value(Some(&check)));
    let source = command_with_rules(&with_visibility(&r.command, "party"), &[rule_ids::ABILITY_CHECK]);
    let targets = json!([get(&r.command, "actor_id")]);
    r.events.push(event_from(&source, "AbilityCheckResolved", Some(Value::Object(payload)), Some(&targets)));
    Ok(check)
}

/// `AnswerTavernDiceRound` (21737–21970).
pub fn answer_tavern_dice_round(r: &mut Resolve<'_>) -> Step {
    let actor_id = get(&r.command, "actor_id");
    let Some(round) = tavern_round_for(&r.state, &actor_id) else {
        return Err(null_read("npc_id"));
    };
    let npc_id = json!(round.npc_id);
    let gambler = tavern_gambler_for(&r.state, &npc_id);
    let actor = player_actor(&r.state, Some(&actor_id)).cloned();
    let Some(wallet_actor) = actor.clone() else {
        return Err(null_read("currency"));
    };
    let minutes = elapsed_minutes(&r.state);
    let before_cp = balance_cp(Some(&wallet_actor));
    let npc_purse_before = tavern_gambler_purse_for(&r.state, &npc_id);
    let settle_event_id = format!("tavern-round-settled:{}", command_id_head(&r.command, 100));
    let approach = js::s(r.command.get("approach"));
    let mut caught = false;
    if approach == "cheat" {
        let check = approach_check(r, Some(TAVERN_CHEAT_ABILITY), TAVERN_CHEAT_SKILL, gambler.insight_passive)?;
        caught = !js::truthy(check.get("success"));
    }
    let mut watch_result: Option<&str> = None;
    if approach == "watch" {
        let check = approach_check(r, None, TAVERN_SPOT_SKILL, gambler.tell_dc)?;
        watch_result = Some(if !js::truthy(check.get("success")) {
            "missed"
        } else if gambler.crooked {
            "exposed"
        } else {
            "clean"
        });
    }
    let exposed = watch_result == Some("exposed");
    let preview = preview_tavern_dice_roll(&r.state, Some(&actor_id), r.command.get("approach"));
    let mut options = Map::new();
    insert_present(&mut options, "modifier", preview.get("modifier"));
    options.insert("difficulty".into(), json!(round.target));
    options.insert("purpose".into(), json!("tavern-dice:hero"));
    insert_present(&mut options, "actorId", r.command.get("actor_id"));
    options.insert("advantage".into(), Value::Bool(false));
    insert_present(&mut options, "disadvantage", preview.get("disadvantage"));
    options.insert("visibility".into(), json!("public"));
    let options = Value::Object(options);
    let hero_roll = match check_roll_from_verified(r.command.get("verified_roll"), &options) {
        Some(roll) => roll,
        None => r.dice.roll_check(&options)?,
    };
    r.rolls.push(hero_roll.clone());
    let die = json!({
        "roll": {
            "id": get(&hero_roll, "roll_id"),
            "kind": "tavern",
            "sides": 20,
            "value": js::safe_int(hero_roll.get("kept"), 1),
            "playerId": js::string(Some(&actor_id)),
            "playerName": hero_label(actor.as_ref(), Some(&actor_id), 80),
            "rolledAt": rolled_at(&hero_roll),
        },
    });
    r.events.push(event_from(&with_visibility(&r.command, "public"), "PublicDieRolled", Some(die), Some(&json!([]))));
    let hero_total = js::safe_int(hero_roll.get("total"), 0);
    let outcome = if caught {
        "caught"
    } else if exposed {
        "exposed"
    } else if hero_total > round.npc_total {
        "win"
    } else if hero_total == round.npc_total {
        "push"
    } else {
        "loss"
    };
    let payout_cp = match outcome {
        "win" => round.stake_cp * 2,
        "push" | "exposed" => round.stake_cp,
        _ => 0,
    };
    let after_cp = MAX_CURRENCY_CP.min(before_cp + payout_cp).max(0);
    let net_cp = after_cp - before_cp - round.stake_cp;
    let purse = tavern_purse_transfer(npc_purse_before.map(Value::from).as_ref(), Some(&json!(-net_cp)));
    let mut payload = Map::new();
    payload.insert("round_id".into(), json!(round.id));
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("npc_id".into(), json!(round.npc_id));
    payload.insert("npc_name".into(), json!(round.npc_name));
    insert_present(&mut payload, "approach", r.command.get("approach"));
    payload.insert("stake_cp".into(), json!(round.stake_cp));
    payload.insert("npc_total".into(), json!(round.npc_total));
    payload.insert("hero_total".into(), json!(hero_total));
    payload.insert("outcome".into(), json!(outcome));
    payload.insert("cheated".into(), Value::Bool(approach == "cheat" && !caught));
    if let Some(watch) = watch_result {
        payload.insert("watch_result".into(), json!(watch));
    }
    payload.insert("delta_cp".into(), json!(after_cp - before_cp));
    payload.insert("net_cp".into(), json!(net_cp));
    insert_wallet(&mut payload, Some(&wallet_actor), before_cp, after_cp);
    if let Some(before) = npc_purse_before {
        payload.insert("npc_purse_before_cp".into(), json!(before));
    }
    payload.insert("npc_purse_after_cp".into(), json!(purse.after_cp));
    if purse.house_cut_cp > 0 {
        payload.insert("house_cut_cp".into(), json!(purse.house_cut_cp));
    }
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), json!(TAVERN_POLICY_ID));
    let party = with_visibility(&r.command, "party");
    let source = command_with_rules(&party, &[rule_ids::ECONOMY_COINS]);
    let pair = json!([actor_id.clone(), round.npc_id]);
    let event = event_from(&source, "TavernDiceRoundResolved", Some(Value::Object(payload)), Some(&pair));
    r.events.push(with_field(event, "event_id", Value::String(settle_event_id.clone())));
    if caught {
        let scandals = tavern_scandals_for(&r.state, &actor_id) + 1;
        let ejected = scandals >= TAVERN_SCANDALS_BEFORE_EJECTION;
        let mut payload = Map::new();
        insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
        payload.insert("npc_id".into(), json!(round.npc_id));
        payload.insert("npc_name".into(), json!(round.npc_name));
        payload.insert("stake_cp".into(), json!(round.stake_cp));
        payload.insert("forfeited_cp".into(), json!(round.stake_cp));
        payload.insert("scandal_count".into(), json!(scandals));
        payload.insert("place_name".into(), Value::String(slice_utf16(&scene_place_text(&r.state), 180)));
        payload.insert("at_minutes".into(), minutes.clone());
        payload.insert("policy_id".into(), json!(TAVERN_POLICY_ID));
        let event = event_from(&party, "TavernCheatCaught", Some(Value::Object(payload)), Some(&pair));
        r.events.push(with_field(event, "event_id", Value::String(format!("tavern-cheat-caught:{}", command_id_head(&r.command, 100)))));
        r.events.extend(npc_relationship_events_from(&r.command, &r.state, Some(&npc_id), Some(&actor_id), Some(&json!(TAVERN_CHEAT_RELATIONSHIP_DELTA)), Some(&json!("tavern-cheat-caught"))));
        if ejected {
            let mut payload = Map::new();
            insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
            payload.insert("npc_id".into(), json!(round.npc_id));
            payload.insert("reason".into(), json!("cheating"));
            payload.insert("scandal_count".into(), json!(scandals));
            payload.insert("at_minutes".into(), minutes.clone());
            payload.insert("policy_id".into(), json!(TAVERN_POLICY_ID));
            r.events.push(event_from(&party, "TavernPatronEjected", Some(Value::Object(payload)), Some(&json!([actor_id.clone()]))));
        }
    }
    if exposed {
        let mut payload = Map::new();
        insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
        payload.insert("npc_id".into(), json!(round.npc_id));
        payload.insert("npc_name".into(), json!(round.npc_name));
        payload.insert("stake_cp".into(), json!(round.stake_cp));
        payload.insert("at_minutes".into(), minutes.clone());
        payload.insert("policy_id".into(), json!(TAVERN_POLICY_ID));
        r.events.push(event_from(&party, "TavernCheatExposed", Some(Value::Object(payload)), Some(&pair)));
        r.events.extend(npc_relationship_events_from(&r.command, &r.state, Some(&npc_id), Some(&actor_id), Some(&json!(TAVERN_EXPOSED_RELATIONSHIP_DELTA)), Some(&json!("tavern-cheat-exposed"))));
        let stance = json!({
            "npc_id": round.npc_id,
            "npc_name": round.npc_name,
            "stance": "guarded",
            "reason": "tavern-cheat-exposed",
            "source_event_id": settle_event_id,
            "propagation_depth": 0,
            "policy_id": NPC_WORLD_POLICY_ID,
        });
        r.events.push(event_from(&party, "NpcStanceChanged", Some(stance), Some(&json!([round.npc_id]))));
    }
    append_minutes(r, TAVERN_DICE_ROUND_MINUTES)
}

/// `LeaveTavernDiceRound` (21971–21982).
pub fn leave_tavern_dice_round(r: &mut Resolve<'_>) -> Step {
    let Some(round) = tavern_round_for(&r.state, &get(&r.command, "actor_id")) else {
        return Err(null_read("npc_id"));
    };
    let minutes = elapsed_minutes(&r.state);
    let event = tavern_round_cancelled_event(&r.command, &r.state, &round.to_json(), &minutes, None);
    r.events.push(event);
    Ok(())
}

/// `OrderTavernDrink` (21983–22039).
pub fn order_tavern_drink(r: &mut Resolve<'_>) -> Step {
    let actor_id = get(&r.command, "actor_id");
    let Some(actor) = player_actor(&r.state, Some(&actor_id)).cloned() else {
        return Err(null_read("currency"));
    };
    let minutes = elapsed_minutes(&r.state);
    let before_cp = balance_cp(Some(&actor));
    let after_cp = (before_cp - TAVERN_DRINK_PRICE_CP).max(0);
    let drinks = tavern_drinks_for(&r.state, &actor_id) + 1;
    let difficulty = tavern_next_drink_dc(&r.state, &actor_id);
    let id = js::string(Some(&actor_id));
    let save = match difficulty {
        None => None,
        Some(difficulty) => {
            let disadvantage = save_disadvantage_condition_for(&r.state, &id, Some(&json!("con"))).is_some();
            let options = json!({
                "modifier": ability_modifier(actor.get("abilities").and_then(|abilities| abilities.get("con"))),
                "difficulty": difficulty,
                "purpose": "tavern-drink:con",
                "ability": "con",
                "disadvantage": disadvantage,
                "visibility": "party",
            });
            Some(roll_saving_throw_check(&r.state, &mut r.dice, &id, &options)?)
        }
    };
    if let Some(save) = &save {
        r.rolls.push(save.clone());
    }
    let withstood = match (&save, difficulty) {
        (Some(save), Some(difficulty)) => saving_throw_succeeded(Some(save), difficulty as f64),
        _ => true,
    };
    let mut payload = Map::new();
    payload.insert("hero_id".into(), actor_id.clone());
    payload.insert("drinks".into(), json!(drinks));
    payload.insert("price_cp".into(), json!(TAVERN_DRINK_PRICE_CP));
    insert_wallet(&mut payload, Some(&actor), before_cp, after_cp);
    payload.insert("social_bonus".into(), json!(if drinks <= TAVERN_SOBER_DRINKS { TAVERN_SOCIAL_BONUS } else { 0 }));
    payload.insert("social_skill".into(), json!(TAVERN_SOCIAL_SKILL));
    if let Some(difficulty) = difficulty {
        payload.insert("difficulty".into(), json!(difficulty));
    }
    payload.insert("at_minutes".into(), minutes);
    payload.insert("policy_id".into(), json!(TAVERN_POLICY_ID));
    let party = with_visibility(&r.command, "party");
    let targets = json!([actor_id.clone()]);
    r.events.push(event_from(&command_with_rules(&party, &[rule_ids::ECONOMY_COINS]), "TavernDrinkOrdered", Some(Value::Object(payload)), Some(&targets)));
    if let Some(save) = &save {
        let mut payload = Map::new();
        payload.insert("ability".into(), json!("con"));
        payload.insert("reason".into(), json!("tavern-drink"));
        payload.extend(spread_value(Some(save)));
        r.events.push(event_from(&command_with_rules(&party, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&targets)));
    }
    if !withstood && !condition_ids_for(&r.state, &id).contains(TAVERN_DRUNK_CONDITION) {
        let payload = json!({ "condition": TAVERN_DRUNK_CONDITION, "duration": TAVERN_DRUNK_DURATION, "source": "tavern-drink", "drinks": drinks });
        r.events.push(event_from(&command_with_rules(&r.command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&targets)));
    }
    append_minutes(r, TAVERN_DRINK_MINUTES)
}
