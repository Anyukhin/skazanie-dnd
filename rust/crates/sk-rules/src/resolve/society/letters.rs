//! Ветки `resolveCommandInternal`: Почта отряда. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 22097–22138. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_world_life::courier_letters::{courier_addressee_for, plan_courier_letter, COURIER_LETTERS_POLICY_ID, COURIER_LETTER_EVENT_TYPES, COURIER_LETTER_WRITING_MINUTES};

use super::super::world_time::TimeAdvanceOptions;
use super::super::Resolve;
use super::{balance_cp, elapsed_minutes, insert_present, insert_wallet, string_or, with_visibility};
use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, player_actor, slice_utf16};
use crate::pause::{Fault, Flow};

/// `SendLetter` (22097–22138).
pub fn send_letter(r: &mut Resolve<'_>) -> Flow {
    let Some(actor) = player_actor(&r.state, r.command.get("actor_id")).cloned() else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'currency')").into());
    };
    let minutes = elapsed_minutes(&r.state);
    let Some(addressee) = courier_addressee_for(&r.state, r.command.get("addressee_kind"), r.command.get("addressee_id"), None) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'fee_cp')").into());
    };
    let before_cp = balance_cp(Some(&actor));
    let after_cp = (before_cp as f64 - sk_core::js::number(addressee.get("fee_cp"))).max(0.0) as i64;
    // `String(actor?.character ?? actor?.name ?? '')`.
    let character = actor.get("character").filter(|value| !value.is_null());
    let hero_name = slice_utf16(&string_or(character.or(actor.get("name")), None), 120);
    let mut options = Map::new();
    insert_present(&mut options, "heroId", r.command.get("actor_id"));
    options.insert("heroName".into(), Value::String(hero_name));
    options.insert("addressee".into(), addressee);
    insert_present(&mut options, "body", r.command.get("body"));
    insert_present(&mut options, "commandId", r.command.get("command_id"));
    options.insert("atMinutes".into(), minutes.clone());
    insert_present(&mut options, "replyDraft", r.command.get("reply_draft"));
    insert_present(&mut options, "replyDraftTone", r.command.get("reply_draft_tone"));
    insert_present(&mut options, "replyProvider", r.command.get("reply_provider"));
    let Some(letter) = plan_courier_letter(&r.state, &Value::Object(options)) else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'addressee_kind')").into());
    };
    let field = |key: &str| letter.get(key).cloned().unwrap_or(Value::Null);
    let mut payload = Map::new();
    payload.insert("letter".into(), letter.clone());
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("addressee_kind".into(), field("addressee_kind"));
    payload.insert("addressee_id".into(), field("addressee_id"));
    payload.insert("addressee_name".into(), field("addressee_name"));
    payload.insert("fee_cp".into(), field("fee_cp"));
    payload.insert("leagues".into(), field("leagues"));
    insert_wallet(&mut payload, Some(&actor), before_cp, after_cp);
    payload.insert("at_minutes".into(), minutes);
    payload.insert("policy_id".into(), json!(COURIER_LETTERS_POLICY_ID));
    let source = command_with_rules(&with_visibility(&r.command, "party"), &[rule_ids::ECONOMY_COINS]);
    let targets = json!([r.command.get("actor_id").cloned().unwrap_or(Value::Null), field("addressee_id")]);
    r.events.push(event_from(&source, COURIER_LETTER_EVENT_TYPES.sent, Some(Value::Object(payload)), Some(&targets)));
    let source = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
    r.append_world_time_consequences(&source, Some(&json!(COURIER_LETTER_WRITING_MINUTES)), Some(&json!("minute")), TimeAdvanceOptions::default())
}
