//! Ветки `resolveCommandInternal`: Благословение жреца. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 22046–22096. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_npc_world::blessings::{blessing_faction_ids_for, BLESSINGS_POLICY_ID, BLESSING_ATTACK_BONUS, BLESSING_CONDITION, BLESSING_DONATION_CP, BLESSING_DURATION, BLESSING_REPUTATION_DELTA, NPC_BLESSING_MINUTES};

use super::super::world_time::TimeAdvanceOptions;
use super::super::Resolve;
use super::{balance_cp, command_id_head, elapsed_minutes, insert_present, insert_wallet, social_npc_loose, string_or, with_field, with_visibility};
use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, player_actor, slice_utf16};
use crate::pause::{Fault, Step};
use crate::preview_checks::{blessing_granted_events, scene_place_text, BlessingGrant};

/// `ReceiveNpcBlessing` (22046–22096).
pub fn receive_npc_blessing(r: &mut Resolve<'_>) -> Step {
    let Some(actor) = player_actor(&r.state, r.command.get("actor_id")).cloned() else {
        return Err(Fault::type_error("Cannot read properties of null (reading 'currency')").into());
    };
    let minutes = elapsed_minutes(&r.state);
    let npc_id = js::string(r.command.get("npc_id"));
    let priest = social_npc_loose(&r.state, &npc_id);
    let priest_name = slice_utf16(&string_or(priest.as_ref().and_then(|priest| priest.get("name")), r.command.get("npc_id")), 160);
    let before_cp = balance_cp(Some(&actor));
    let after_cp = (before_cp - BLESSING_DONATION_CP).max(0);
    let blessing_event_id = format!("npc-blessing:{}", command_id_head(&r.command, 100));
    let place_name = slice_utf16(&scene_place_text(&r.state), 180);
    let mut payload = Map::new();
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("npc_id".into(), json!(npc_id));
    payload.insert("npc_name".into(), json!(priest_name));
    payload.insert("place_name".into(), json!(place_name));
    payload.insert("donation_cp".into(), json!(BLESSING_DONATION_CP));
    payload.insert("condition".into(), json!(BLESSING_CONDITION));
    payload.insert("duration".into(), json!(BLESSING_DURATION));
    payload.insert("attack_bonus".into(), json!(BLESSING_ATTACK_BONUS));
    insert_wallet(&mut payload, Some(&actor), before_cp, after_cp);
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), json!(BLESSINGS_POLICY_ID));
    let party = with_visibility(&r.command, "party");
    let targets = json!([r.command.get("actor_id").cloned().unwrap_or(Value::Null), npc_id]);
    let event = event_from(&command_with_rules(&party, &[rule_ids::ECONOMY_COINS]), "NpcBlessingGranted", Some(Value::Object(payload)), Some(&targets));
    r.events.push(with_field(event, "event_id", Value::String(blessing_event_id.clone())));
    for faction_id in blessing_faction_ids_for(&r.state, r.command.get("npc_id").unwrap_or(&Value::Null)) {
        let payload = json!({
            "faction_id": faction_id,
            "delta": BLESSING_REPUTATION_DELTA,
            "source_event_id": blessing_event_id,
            "provenance": { "source": "server-blessing-policy", "policy": BLESSINGS_POLICY_ID },
        });
        r.events.push(event_from(&party, "FactionReputationAdjusted", Some(payload), Some(&json!([]))));
    }
    let grant = BlessingGrant {
        hero_id: r.command.get("actor_id").cloned().unwrap_or(Value::Null),
        source: "priest".into(),
        place_name,
        npc_id,
        npc_name: priest_name,
        minutes,
        source_event_id: blessing_event_id,
    };
    let granted = blessing_granted_events(&r.command, &r.state, &grant);
    r.events.extend(granted);
    let source = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
    r.append_world_time_consequences(&source, Some(&json!(NPC_BLESSING_MINUTES)), Some(&json!("minute")), TimeAdvanceOptions::default())
}
