//! `autonomous_campaign`: проверки контракта Режиссёра из
//! `test/autonomous-campaign.test.mjs` и редьюсера `autonomy`.

use serde_json::{json, Value};
use sk_world_story::autonomous_campaign::*;

fn valid_intents() -> Vec<Value> {
    vec![
        json!({ "type": "continue_exploration" }),
        json!({ "type": "open_social_scene", "npc_id": "marta" }),
        json!({ "type": "advance_quest_clock", "quest_id": "ledger-quest" }),
        json!({ "type": "request_encounter", "theme": "beasts", "difficulty": "easy" }),
        json!({ "type": "resolve_scene", "resolution": "negotiation" }),
        json!({ "type": "end_scene", "destination": "North Gate" }),
        json!({ "type": "offer_next_hook", "hook": "Follow the tracks" }),
    ]
}

const MECHANICAL_FIELDS: [&str; 19] = [
    "hp", "max_hp", "dc", "difficulty_class", "roll", "dice", "price", "quantity", "xp", "xp_budget", "loot", "coordinates", "x", "y", "damage", "armor", "initiative", "reputation_delta",
    "amount",
];

/// `max_hp` → `maxHp`.
fn camel_case(field: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for ch in field.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

#[test]
fn director_contract_accepts_only_narrative_intentions() {
    let types: Vec<Value> = valid_intents().iter().map(|intent| normalize_director_intent(Some(intent)).map(|intent| intent["type"].clone()).unwrap_or_default()).collect();
    assert_eq!(types, DIRECTOR_INTENT_TYPES.iter().map(|kind| json!(kind)).collect::<Vec<_>>());
    let named = normalize_director_intent(Some(&json!({ "type": "request_encounter", "theme": "generic", "difficulty": "deadly", "npc_id": "astohan-sargat" })));
    assert_eq!(named.map(|intent| intent["npc_id"].clone()).ok(), Some(json!("astohan-sargat")));
    for forged in [
        json!({ "type": "deal_damage", "damage": 999 }),
        json!({ "type": "request_encounter", "theme": "beasts", "difficulty": "easy", "hp": 1 }),
        json!({ "type": "advance_quest_clock", "quest_id": "ledger-quest", "amount": 20 }),
        json!({ "type": "request_encounter", "theme": "dragon", "difficulty": "impossible" }),
    ] {
        assert!(normalize_director_intent(Some(&forged)).is_err(), "{forged}");
    }
}

#[test]
fn no_mechanical_field_passes_on_any_intention() {
    for base in valid_intents() {
        for field in MECHANICAL_FIELDS {
            for key in [field.to_string(), camel_case(field), field.to_uppercase()] {
                let mut intent = base.clone();
                intent[key.as_str()] = json!(7);
                let error = normalize_director_intent(Some(&intent)).err();
                assert_eq!(error.map(|error| error.code), Some("DIRECTOR_MECHANICS_FORBIDDEN".to_string()), "{} {key}", base["type"]);
            }
            let nested = json!({ "type": "offer_next_hook", "hook": "Follow the tracks", "reason": { camel_case(field): 7 } });
            let message = normalize_director_intent(Some(&nested)).err().map(|error| error.message).unwrap_or_default();
            assert_eq!(message, format!("Director не может задавать механическое поле $.reason.{}", camel_case(field)));
        }
    }
}

#[test]
fn reducer_tracks_reputation_hooks_and_consequences() {
    let mut autonomy = normalize_autonomy_state(None);
    assert_eq!(autonomy["schema_version"], 3);
    let event = |kind: &str, payload: Value| json!({ "event_type": kind, "payload": payload });
    autonomy = apply_autonomy_event(Some(&autonomy), &event("FactionReputationAdjusted", json!({ "faction_id": "crown", "delta": 150, "consequence_key": "k1" })));
    autonomy = apply_autonomy_event(Some(&autonomy), &event("FactionReputationAdjusted", json!({ "faction_id": "crown", "delta": -30, "consequence_key": "k1" })));
    assert_eq!(autonomy["reputations"]["crown"], 70);
    assert_eq!(autonomy["applied_consequences"], json!(["k1"]));
    // Дробная поправка превращает репутацию в нечисло, и нормализация обнуляет
    // её (замечено в JS).
    autonomy = apply_autonomy_event(Some(&autonomy), &event("FactionReputationAdjusted", json!({ "faction_id": "crown", "delta": 2.5 })));
    assert_eq!(autonomy["reputations"]["crown"], 0);
    let hook = json!({ "id": "hook-1", "text": "Тропа", "status": "available" });
    autonomy = apply_autonomy_event(Some(&autonomy), &event("NextHookOffered", json!({ "hook": hook })));
    autonomy = apply_autonomy_event(Some(&autonomy), &event("NextHookOffered", json!({ "hook": hook })));
    assert_eq!(autonomy["hooks"], json!([hook]));
    let state = json!({ "autonomy": autonomy, "scene": { "location": "Тихий Брод" } });
    assert!(ensure_available_hook(&state, None).is_none());
    let fresh = ensure_available_hook(&json!({ "scene": { "location": "Тихий Брод" }, "state_version": 3 }), None).unwrap_or_default();
    assert_eq!(fresh["text"], "Исследовать Тихий Брод");
    assert_eq!(fresh["source"], "fail-safe");
    assert!(fresh["id"].as_str().is_some_and(|id| id.starts_with("hook-") && id.len() == 25));
}

#[test]
fn reputation_delta_table() {
    assert_eq!(server_reputation_delta(&json!({})), json!(0));
    assert_eq!(server_reputation_delta(&json!({ "outcome": "helpful", "severity": "major" })), json!(5));
    assert_eq!(server_reputation_delta(&json!({ "outcome": "harmful" })), json!(-2));
    assert_eq!(server_reputation_delta(&json!({ "outcome": "evil" })), json!(0));
}
