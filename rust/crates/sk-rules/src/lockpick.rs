//! Взлом: шум и следы отмычки (`lockpick*`). Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 2816–2852 (`lockpickCheckModifier`,
//! `lockpickNoticeEvents`). Доли и тексты шума — `sk_ruleset::lockpicking`.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_ruleset::lockpicking::{lockpick_noise_for, lockpick_trace_noticed_for, LOCKPICKING_POLICY_ID};

use crate::command::rules::rule_ids;
use crate::conditions::{at, at_path, nullish_chain};
use crate::core::{ability_modifier, command_with_rules, event_from, slice_utf16};

/// `lockpickCheckModifier(actor)`: Лов + больший из бонусов «Ловкости рук» и мастерства.
pub fn lockpick_check_modifier(actor: Option<&Value>) -> i64 {
    let proficiency = js::safe_int(at(actor, "proficiency"), 0).max(0);
    ability_modifier(at_path(actor, &["abilities", "dex"])) + crate::checks::skills::skill_proficiency_bonus(actor, "sleight_of_hand", None).max(proficiency)
}

/// Параметры `lockpickNoticeEvents`.
#[derive(Debug, Clone, Copy, Default)]
pub struct LockpickNotice<'a> {
    pub target_kind: Option<&'a Value>,
    pub target_id: Option<&'a Value>,
    pub target_label: Option<&'a Value>,
    pub check: Option<&'a Value>,
    /// `notice` (`null` — по умолчанию: вычислить по проверке).
    pub notice: Option<&'a Value>,
}

/// Порядок `Array.prototype.sort()` строк: по кодовым единицам UTF-16.
fn utf16_order(left: &String, right: &String) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `lockpickNoticeEvents(state, command, notice)`: свидетели услышали возню или
/// заметили сорванный замок.
pub fn lockpick_notice_events(state: &Value, command: &Value, args: LockpickNotice<'_>) -> Vec<Value> {
    let mut witness_ids: Vec<String> = sk_npc_world::npc_positioning::present_scene_npcs(state).iter().map(|npc| js::string(npc.get("id"))).collect();
    witness_ids.sort_by(utf16_order);
    if witness_ids.is_empty() {
        return Vec::new();
    }
    let witnesses = js::strings_value(witness_ids.clone());
    let notice = match args.notice.filter(|value| !value.is_null()) {
        Some(declared) => Some(declared.clone()),
        None if js::is_true(at(args.check, "success")) => lockpick_trace_noticed_for(Some(state), args.target_id, Some(&witnesses)),
        None => {
            let natural = js::safe_int(nullish_chain(&[at(args.check, "kept"), at(args.check, "die")]), 0);
            lockpick_noise_for(Some(&json!({ "success": false, "natural": natural })))
        }
    };
    let Some(notice) = notice.filter(|notice| js::truthy(Some(notice))) else { return Vec::new() };
    let mut payload = Map::new();
    if let Some(hero) = command.get("actor_id") {
        payload.insert("hero_id".into(), hero.clone());
    }
    if let Some(kind) = args.target_kind {
        payload.insert("target_kind".into(), kind.clone());
    }
    payload.insert("target_id".into(), Value::String(slice_utf16(&js::s(args.target_id), 160)));
    payload.insert("target_label".into(), Value::String(slice_utf16(&js::s(args.target_label), 160)));
    for key in ["reason", "severity"] {
        if let Some(value) = notice.get(key) {
            payload.insert(key.into(), value.clone());
        }
    }
    payload.insert("loud".into(), Value::Bool(js::is_true(notice.get("loud"))));
    payload.insert("witness_ids".into(), witnesses);
    payload.insert("policy_id".into(), Value::String(LOCKPICKING_POLICY_ID.into()));
    let source = command_with_rules(command, &[rule_ids::ABILITY_CHECK]);
    vec![event_from(&source, "LockpickNoticed", Some(Value::Object(payload)), Some(&json!([])))]
}
