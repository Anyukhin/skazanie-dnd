//! Общество в разборе команд: отношения NPC, стойка скупщика, карманная
//! кража, таверна при уходе из зала, уход NPC из сцены. Задача Р4б.
//!
//! JS: `server/rules-engine.mjs`, 667, 5455, 7911 (`npcRelationshipEventsFrom`),
//! 10746–10769 (`fenceStanceFor`, `pickpocketSpentCondition`,
//! `livingPartySize`), 11881–11920 (`tavernRoundCancelledEvent`,
//! `tavernRoundsClosedByDeparture`), 13013–13030 (`NPC_DEPARTURE_FIELDS`,
//! `npcDepartureEvents`), 23993 (`addInventoryItem` — ветка редьюсера держит
//! свою копию в `reduce/items.rs`).

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, is_living_actor};
use sk_core::indexmap::IndexMap;
use sk_core::js::{self, is_true, safe_int, truthy};

use crate::command::rules::rule_ids;
use crate::core::{command_with, command_with_rules, event_from, same_campaign_party, slice_utf16};
use crate::pause::{Fault, Halt};

pub use crate::constants::PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA;

/// `inventoryStackIndex(inventory, incoming)` (5455): стопка того же вида
/// среди ненадетых вещей; надетая входящая вещь в стопку не идёт.
pub fn inventory_stack_index(inventory: &[Value], incoming: &Value) -> Option<usize> {
    if !truthy(Some(incoming)) || is_true(incoming.get("equipped")) {
        return None;
    }
    let key = sk_economy::merchant_economy::inventory_stack_key(Some(incoming));
    inventory.iter().position(|item| !is_true(item.get("equipped")) && sk_economy::merchant_economy::inventory_stack_key(Some(item)) == key)
}

/// `addInventoryItem(inventory, incoming)` (23993): вещь в стопку того же
/// вида (не больше `MAX_STOCK_QUANTITY`) или новой строкой.
pub fn add_inventory_item(inventory: Option<&Value>, incoming: &Value) -> Value {
    let current: Vec<Value> = match inventory {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let Some(index) = inventory_stack_index(&current, incoming) else {
        let mut next = current;
        next.push(incoming.clone());
        return Value::Array(next);
    };
    let limit = sk_economy::merchant_economy::MAX_STOCK_QUANTITY;
    Value::Array(
        current
            .into_iter()
            .enumerate()
            .map(|(position, item)| {
                if position != index {
                    return item;
                }
                let quantity = (safe_int(item.get("quantity"), 1) + safe_int(incoming.get("quantity"), 1)).min(limit);
                let mut fields = crate::core::spread_value(Some(&item));
                fields.insert("quantity".into(), Value::from(quantity));
                Value::Object(fields)
            })
            .collect(),
    )
}

/// `npcRelationshipEventsFrom(command, state, { npcId, heroId, delta, reason })`
/// (7911): сдвиг отношения в границах социального движка и смена ступени.
pub fn npc_relationship_events_from(command: &Value, state: &Value, npc_id: Option<&Value>, hero_id: Option<&Value>, delta: Option<&Value>, reason: Option<&Value>) -> Vec<Value> {
    let npc = js::s(npc_id);
    let hero = js::s(hero_id);
    if npc.is_empty() || hero.is_empty() {
        return Vec::new();
    }
    let social = sk_social::npc_social::ensure_npc_social_state(state.get("social").unwrap_or(&Value::Null), state, &json!({}));
    let before = social.get("relationships").and_then(|all| all.get(&npc)).and_then(|row| row.get(&hero)).filter(|value| !value.is_null()).map(|value| js::number(Some(value))).unwrap_or(0.0);
    let bounded = safe_int(delta, 0).clamp(-25, 25);
    if bounded == 0 {
        return Vec::new();
    }
    let after = (before + bounded as f64).clamp(-100.0, 100.0);
    let tier_before = sk_social::npc_social::relationship_tier(&js::num(before));
    let tier_after = sk_social::npc_social::relationship_tier(&js::num(after));
    let payload = json!({
        "npc_id": npc,
        "hero_id": hero,
        "delta": js::num(after - before),
        "score_before": js::num(before),
        "score_after": js::num(after),
        "tier_before": tier_before,
        "tier_after": tier_after,
        "reason": slice_utf16(&js::s(reason), 80),
        "promise_id": "",
    });
    let private = command_with(command, "visibility", Value::String("specific_player".into()));
    let targets = json!([hero]);
    let mut events = vec![event_from(&private, "NpcRelationshipAdjusted", Some(payload.clone()), Some(&targets))];
    if tier_before != tier_after {
        events.push(event_from(&private, "NpcRelationshipTierChanged", Some(payload), Some(&targets)));
    }
    events
}

/// `fenceStanceFor(state, merchantId, item)` (10746): краденое, скупщик ли
/// торговец, скидка и отказ — одно чтение для проверки и для расчёта.
pub fn fence_stance_for(state: &Value, merchant_id: Option<&Value>, item: Option<&Value>) -> Value {
    let stolen = js::s(item.and_then(|item| item.get("origin"))) == "stolen";
    let id = js::s(merchant_id);
    let npc = state
        .get("social")
        .and_then(|social| social.get("npcs"))
        .and_then(Value::as_array)
        .and_then(|npcs| npcs.iter().find(|candidate| js::s(candidate.get("id")) == id))
        .cloned()
        .unwrap_or_else(|| json!({ "id": id }));
    let fence = sk_society::underworld::npc_is_fence(state, &npc);
    json!({
        "stolen": stolen,
        "fence": fence,
        "npc": npc,
        "discountBps": if stolen && fence { sk_society::underworld::STOLEN_DISCOUNT_BPS } else { 0 },
        "refuses": stolen && !fence,
    })
}

/// `pickpocketSpentCondition(npcId)`: маркер «карман уже обчищен».
pub fn pickpocket_spent_condition(npc_id: Option<&Value>) -> String {
    format!("pocket-picked:{}", js::s(npc_id))
}

/// `livingPartySize(state)`: живые герои отряда рядом.
pub fn living_party_size(state: &Value) -> usize {
    state.get("players").and_then(Value::as_array).map(|players| players.iter().filter(|player| is_living_actor(player) && same_campaign_party(state, &actor_id(player))).count()).unwrap_or(0)
}

/// `tavernRoundCancelledEvent(command, state, round, minutes, npcPurseBeforeCp)`
/// (11881): закрытый раунд — ставка уезжает сопернику. `purse_before` `None`
/// — касса из состояния (`null` в JS); `Some(None)` — `undefined`.
pub fn tavern_round_cancelled_event(command: &Value, state: &Value, round: &Value, minutes: &Value, purse_before: Option<Option<i64>>) -> Value {
    let purse_before = match purse_before {
        Some(before) => before,
        None => sk_npc_world::tavern_life::tavern_gambler_purse_for(state, round.get("npc_id").unwrap_or(&Value::Null)),
    };
    let before_value = purse_before.map(Value::from);
    let transfer = sk_npc_world::tavern_life::tavern_purse_transfer(before_value.as_ref(), round.get("stake_cp"));
    let mut acting = command_with(command, "actor_id", round.get("hero_id").cloned().unwrap_or(Value::Null));
    acting["visibility"] = Value::String("party".into());
    let field = |key: &str| round.get(key).cloned().unwrap_or(Value::Null);
    let mut payload = Map::new();
    payload.insert("round_id".into(), field("id"));
    payload.insert("hero_id".into(), field("hero_id"));
    payload.insert("npc_id".into(), field("npc_id"));
    payload.insert("npc_name".into(), field("npc_name"));
    payload.insert("stake_cp".into(), field("stake_cp"));
    payload.insert("npc_total".into(), field("npc_total"));
    payload.insert("forfeited_cp".into(), field("stake_cp"));
    payload.insert("reason".into(), Value::String("surrendered".into()));
    if let Value::Object(extra) = sk_npc_world::tavern_life::tavern_purse_transfer_payload(Some(&transfer.to_json())) {
        for (key, value) in extra {
            payload.insert(key, value);
        }
    }
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), Value::String(sk_npc_world::tavern_life::TAVERN_POLICY_ID.into()));
    let targets = Value::Array(vec![field("hero_id"), field("npc_id")]);
    event_from(&command_with_rules(&acting, &[rule_ids::ECONOMY_COINS]), "TavernDiceRoundCancelled", Some(Value::Object(payload)), Some(&targets))
}

/// `tavernRoundsClosedByDeparture(command, state, minutes)` (11906): столы,
/// закрытые уходом из зала; касса соседа идёт бегущим числом.
pub fn tavern_rounds_closed_by_departure(command: &Value, state: &Value, minutes: &Value) -> Vec<Value> {
    let mut running: IndexMap<String, Option<i64>> = IndexMap::new();
    sk_npc_world::tavern_life::tavern_open_rounds(state)
        .into_iter()
        .map(|round| {
            let before = match running.get(&round.npc_id) {
                Some(before) => *before,
                None => sk_npc_world::tavern_life::tavern_gambler_purse_for(state, &Value::String(round.npc_id.clone())),
            };
            let event = tavern_round_cancelled_event(command, state, &round.to_json(), minutes, Some(before));
            let after = event.get("payload").and_then(|payload| payload.get("npc_purse_after_cp"));
            let next = if js::is_safe_integer_number(after) && js::present(after) { Some(js::number(after) as i64) } else { before };
            running.insert(round.npc_id.clone(), next);
            event
        })
        .collect()
}

/// `NPC_DEPARTURE_FIELDS` (13013).
pub const NPC_DEPARTURE_FIELDS: [&str; 17] = [
    "id", "name", "role", "location", "location_id", "public_summary", "voice", "speech_profile", "goals", "beliefs", "known_fact_ids", "social_dcs", "visibility",
    "reveal_on_presence", "tags", "schedule", "inventory",
];

/// `npcDepartureEvents(command, state, npcId)` (13023): собеседник уходит из
/// сцены — профиль остаётся, но недоступен. Отказ социальной проверки JS не
/// переводит в отказ правила: это `NpcSocialValidationError` с его кодом.
pub fn npc_departure_events(command: &Value, state: &Value, npc_id: &str) -> Result<Vec<Value>, Halt> {
    let stored = state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).and_then(|npcs| npcs.iter().find(|npc| npc.get("id").and_then(Value::as_str) == Some(npc_id)));
    let Some(stored) = stored else { return Ok(Vec::new()) };
    if js::is_false(stored.get("available")) {
        return Ok(Vec::new());
    }
    let mut profile = Map::new();
    for field in NPC_DEPARTURE_FIELDS {
        if let Some(value) = stored.get(field) {
            profile.insert(field.into(), value.clone());
        }
    }
    profile.insert("available".into(), Value::Bool(false));
    let system = command_with(command, "actor_id", Value::Null);
    let mut request = command_with(&system, "command_type", Value::String("UpsertNpcSocialProfile".into()));
    request["npc"] = Value::Object(profile);
    let hidden = sk_social::npc_social::validate_npc_social_command(&request, state, &json!({ "isDirector": true }))
        .map_err(|error| Halt::Fault(Fault::new("NpcSocialValidationError", error.message.clone()).with_code(error.code.clone())))?;
    Ok(sk_social::npc_social::npc_social_events(&hidden, state)
        .into_iter()
        .map(|social| {
            let acting = command_with(&system, "visibility", social.get("visibility").cloned().unwrap_or(Value::Null));
            event_from(&acting, &js::s(social.get("event_type")), social.get("payload").cloned(), social.get("target_ids"))
        })
        .collect())
}
