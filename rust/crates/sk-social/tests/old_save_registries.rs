//! Старые сохранения (`test/old-save-registries.test.mjs`): `null` в коллекциях
//! социального состояния, память о NPC без своего профиля при первой
//! нормализации, ступень отношения вместе со счётом и срок «нескоро».

use serde_json::{json, Value};
use sk_social::npc_social::*;

static NULL: Value = Value::Null;

fn npc(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "role": "житель", "location": "Площадь" })
}

fn conversation(id: &str, npc_id: &str) -> Value {
    json!({ "id": id, "npc_id": npc_id, "hero_id": "hero-1", "player_message": "Здравствуй", "npc_reply": "И тебе." })
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array().expect("список").iter().map(|entry| entry["id"].as_str().expect("id")).collect()
}

#[test]
fn null_entries_of_social_collections_read_as_empty() {
    let social = normalize_npc_social_state(
        &json!({
            "npcs": [null, npc("npc-1", "Марта")],
            "conversations": [null, conversation("talk-1", "npc-1")],
            "promises": [null, { "id": "promise-1", "npc_id": "npc-1", "hero_id": "hero-1", "text": "Принесу карту" }],
        }),
        &NULL,
    );
    assert_eq!(ids(&social["npcs"]), ["npc-1"]);
    assert_eq!(ids(&social["conversations"]), ["talk-1"]);
    assert_eq!(ids(&social["promises"]), ["promise-1"]);
    let ensured = ensure_npc_social_state(
        &json!({ "npcs": [null] }),
        &json!({
            "merchants": [null, { "id": "merchant-1", "name": "Борин" }],
            "worldMemory": { "entities": [null, { "id": "npc-2", "kind": "npc", "name": "Орин" }] },
        }),
        &NULL,
    );
    assert_eq!(ids(&ensured["npcs"]), ["merchant-1", "npc-2"]);
}

#[test]
fn first_normalization_keeps_memory_of_npcs_without_own_profile() {
    let state = json!({
        "merchants": [{ "id": "merchant-1", "name": "Борин", "location": "Рынок" }],
        "worldMemory": { "entities": [{ "id": "npc-2", "kind": "npc", "name": "Орин", "visibility": "party" }] },
    });
    let social = ensure_npc_social_state(
        &json!({
            "npcs": [],
            "conversations": [conversation("talk-1", "merchant-1"), conversation("talk-2", "npc-2")],
            "promises": [{ "id": "promise-1", "npc_id": "merchant-1", "hero_id": "hero-1", "text": "Принесу карту", "source_conversation_id": "talk-1" }],
            "relationships": { "merchant-1": { "hero-1": 25 }, "npc-2": { "hero-1": -30 } },
        }),
        &state,
        &NULL,
    );
    assert_eq!(ids(&social["conversations"]), ["talk-1", "talk-2"]);
    assert_eq!(ids(&social["promises"]), ["promise-1"]);
    assert_eq!(social["relationships"], json!({ "merchant-1": { "hero-1": 25 }, "npc-2": { "hero-1": -30 } }));
    assert_eq!(social["relationship_tiers"], json!({ "merchant-1": { "hero-1": "friendly" }, "npc-2": { "hero-1": "unfriendly" } }));
    assert_eq!(ensure_npc_social_state(&social, &state, &NULL), social);
}

#[test]
fn relationship_adjustment_moves_tier_and_skips_unknown_npc_or_empty_hero() {
    let input = normalize_npc_social_state(&json!({ "npcs": [npc("npc-1", "Марта")], "relationships": { "npc-1": { "hero-1": 15 } } }), &NULL);
    let adjust = |payload: Value| apply_npc_social_event(&input, &json!({ "event_type": "NpcRelationshipAdjusted", "payload": payload }), &json!({}), &NULL);
    let adjusted = adjust(json!({ "npc_id": "npc-1", "hero_id": "hero-1", "delta": 10 }));
    assert_eq!(adjusted["relationships"]["npc-1"]["hero-1"], 25);
    assert_eq!(adjusted["relationship_tiers"]["npc-1"]["hero-1"], "friendly");
    let first = adjust(json!({ "npc_id": "npc-1", "hero_id": "hero-2", "delta": -25 }));
    assert_eq!(first["relationship_tiers"]["npc-1"], json!({ "hero-1": "neutral", "hero-2": "unfriendly" }));
    for payload in [
        json!({ "npc_id": "npc-unknown", "hero_id": "hero-1", "delta": 5 }),
        json!({ "npc_id": "npc-1", "hero_id": "", "delta": 5 }),
        json!({ "npc_id": "", "hero_id": "hero-1", "delta": 5 }),
    ] {
        let result = adjust(payload.clone());
        assert_eq!(result["relationships"], json!({ "npc-1": { "hero-1": 15 } }), "{payload}");
        assert_eq!(result["relationship_tiers"], json!({ "npc-1": { "hero-1": "neutral" } }), "{payload}");
    }
    assert_eq!(adjust(json!({ "npc_id": "npc-1", "hero_id": "constructor", "delta": 5 }))["relationships"]["npc-1"]["constructor"], 5);
}

#[test]
fn not_soon_sets_no_deadline() {
    assert_eq!(promise_due_offset_minutes(&json!("нескоро")), None);
    assert_eq!(promise_due_offset_minutes(&json!("Нескоро, как получится")), None);
    assert_eq!(promise_due_offset_minutes(&json!("скоро")), Some(240));
    assert_eq!(promise_due_offset_minutes(&json!("очень скоро")), Some(240));
    assert_eq!(promise_due_offset_minutes(&json!("soon")), Some(240));
}
