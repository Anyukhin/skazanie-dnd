//! Ветки общества `resolveCommandInternal` (`rules-engine.mjs`, 21008–21266,
//! 21383–22331): NPC мира, пленные, звери, парлей, контейнеры, таверна,
//! благословения, письма, закон. Задача Р7.
//!
//! Здесь же — общие помощники веток общества.

pub mod beasts;
pub mod blessings;
pub mod captives;
pub mod law;
pub mod letters;
pub mod loot;
pub mod npc;
pub mod parley;
pub mod tavern;

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::core::{command_with, slice_utf16};

/// Поле `key: value`, где `undefined` (нет значения) в JSON не попадает.
pub(crate) fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `String(value ?? fallback)`; `fallback: None` — `''`.
pub(crate) fn string_or(value: Option<&Value>, fallback: Option<&Value>) -> String {
    match value.filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => fallback.map_or_else(String::new, |fallback| js::string(Some(fallback))),
    }
}

/// `String(actor?.character ?? actor?.name ?? fallback).slice(0, limit)`.
pub(crate) fn hero_label(actor: Option<&Value>, fallback: Option<&Value>, limit: usize) -> String {
    let character = actor.and_then(|actor| actor.get("character")).filter(|value| !value.is_null());
    let name = actor.and_then(|actor| actor.get("name"));
    slice_utf16(&string_or(character.or(name), fallback), limit)
}

/// `state.social.npcs.find((candidate) => String(candidate.id) === id)`.
pub(crate) fn social_npc(state: &Value, id: Option<&Value>) -> Option<Value> {
    let wanted = id?.as_str()?;
    state.get("social")?.get("npcs")?.as_array()?.iter().find(|npc| js::string(npc.get("id")) == wanted).cloned()
}

/// `(state.social?.npcs ?? []).find((npc) => String(npc?.id ?? '') === id)`.
pub(crate) fn social_npc_loose(state: &Value, id: &str) -> Option<Value> {
    state.get("social")?.get("npcs")?.as_array()?.iter().find(|npc| js::s(npc.get("id")) == id).cloned()
}

/// `{ ...command, visibility }`.
pub(crate) fn with_visibility(command: &Value, visibility: &str) -> Value {
    command_with(command, "visibility", Value::String(visibility.into()))
}

/// `String(command.command_id).slice(0, n)`.
pub(crate) fn command_id_head(command: &Value, limit: usize) -> String {
    slice_utf16(&js::string(command.get("command_id")), limit)
}

/// `String(x).slice(-n)`.
pub(crate) fn tail_utf16(text: &str, count: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = units.len().saturating_sub(count);
    String::from_utf16_lossy(&units[start..])
}

/// `campaignElapsedMinutes(state)` числом JSON.
pub(crate) fn elapsed_minutes(state: &Value) -> Value {
    js::num(sk_social::npc_social::campaign_elapsed_minutes(state))
}

/// Кошелёк героя: `currencyToCopper(actor.currency)`.
pub(crate) fn balance_cp(actor: Option<&Value>) -> i64 {
    sk_economy::merchant_economy::currency_to_copper(actor.and_then(|actor| actor.get("currency")))
}

/// Поля кошелька события: `currency_before`, `currency_after`,
/// `balance_before_cp`, `balance_after_cp`.
pub(crate) fn insert_wallet(payload: &mut Map<String, Value>, actor: Option<&Value>, before_cp: i64, after_cp: i64) {
    payload.insert("currency_before".into(), sk_economy::merchant_economy::normalize_currency(actor.and_then(|actor| actor.get("currency"))));
    payload.insert("currency_after".into(), sk_economy::merchant_economy::copper_to_currency(Some(&json!(after_cp))));
    payload.insert("balance_before_cp".into(), json!(before_cp));
    payload.insert("balance_after_cp".into(), json!(after_cp));
}

/// `{ ...event, [key]: value }` — новое поле в конце, существующее — на месте.
pub(crate) fn with_field(mut event: Value, key: &str, value: Value) -> Value {
    if let Some(map) = event.as_object_mut() {
        map.insert(key.into(), value);
    }
    event
}
