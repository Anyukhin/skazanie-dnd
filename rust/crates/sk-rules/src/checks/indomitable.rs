//! «Несгибаемый» воина: возможности переброса (`indomitableOpportunitiesFor`). Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 12344–12373. `failedSavingThrowEvent` (12344)
//! уже перенесён вместе с костями-стенограммой (`dice_record.rs`, Р0) и
//! здесь только вызывается.

use serde_json::{json, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;

use crate::core::{resource_pool, Pool};
use crate::dice_record::failed_saving_throw_event;

/// Возможность переброса: `{ event, actor, target_id, resource }`.
#[derive(Debug, Clone, PartialEq)]
pub struct IndomitableOpportunity {
    pub event: Value,
    pub actor: Value,
    pub target_id: String,
    pub resource: Pool,
}

impl IndomitableOpportunity {
    pub fn to_value(&self) -> Value {
        json!({ "event": self.event, "actor": self.actor, "target_id": self.target_id, "resource": self.resource.to_value() })
    }
}

/// `indomitableOpportunitiesFor(state, events, bypassActorIds = [])`: воины
/// 9-го уровня с зарядом, проваливший спасбросок, по одной возможности на героя.
pub fn indomitable_opportunities_for(state: &Value, events: &[Value], bypass_actor_ids: Option<&Value>) -> Vec<IndomitableOpportunity> {
    let bypassed: IndexSet<String> = match bypass_actor_ids {
        Some(Value::Array(ids)) => ids.iter().map(|id| js::string(Some(id))).collect(),
        _ => IndexSet::new(),
    };
    let players = state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let mut queued = IndexSet::new();
    let mut opportunities = Vec::new();
    for event in events {
        if !failed_saving_throw_event(event) {
            continue;
        }
        if js::is_true(event.get("payload").and_then(|payload| payload.get("auto_failed"))) {
            continue;
        }
        let target_id = js::s(event.get("target_ids").and_then(|ids| ids.get(0)));
        let Some(actor) = players.iter().find(|candidate| sk_core::game::actor_id(candidate) == target_id) else { continue };
        if queued.contains(&target_id)
            || bypassed.contains(&target_id)
            || crate::tables::character_class_key(actor).as_deref() != Some("fighter")
            || js::safe_int(actor.get("level"), 1) < 9
        {
            continue;
        }
        let resource = resource_pool(state, &target_id, "indomitable", 1);
        if resource.current < 1 {
            continue;
        }
        queued.insert(target_id.clone());
        opportunities.push(IndomitableOpportunity { event: event.clone(), actor: actor.clone(), target_id, resource });
    }
    opportunities
}
