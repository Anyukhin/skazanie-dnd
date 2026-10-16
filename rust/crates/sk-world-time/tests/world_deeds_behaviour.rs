//! `world_deeds`: проверки `test/world-deeds.test.mjs` и
//! `test/world-deeds-ui-contract.test.mjs`, касающиеся самого модуля (без
//! Rules Engine и проекции), и закрепление странностей JS.

use serde_json::{json, Value};
use sk_world_time::world_deeds::*;

const VILLAGE: &str = "Тихий Брод";
const MILL: &str = "Мельница";
const CAPITAL: &str = "Столица";
const EDGE: &str = "Край света";

fn npc(id: &str, name: &str, location: &str, faction: &str) -> Value {
    json!({
        "id": id, "name": name, "role": "житель", "location": location, "visibility": "party",
        "public_summary": format!("{name} живёт в месте «{location}»."),
        "tags": [format!("faction:{faction}")],
    })
}

fn campaign(npcs: Vec<Value>) -> Value {
    json!({
        "partyName": "Отряд героев",
        "scene": { "title": "Площадь", "location": VILLAGE, "location_id": "village", "cells": [] },
        "players": [{ "id": "hero", "character": "Ада", "hp": 10, "maxHp": 10, "inventory": [] }],
        "worldMap": {
            "locations": [
                { "id": "village", "name": VILLAGE }, { "id": "mill", "name": MILL },
                { "id": "capital", "name": CAPITAL }, { "id": "edge", "name": EDGE },
            ],
            "routes": [
                { "from": "village", "to": "mill" }, { "from": "mill", "to": "capital" }, { "from": "capital", "to": "edge" },
            ],
        },
        "social": { "npcs": npcs },
        "mechanics": { "world_time": { "elapsed_minutes": 0 } },
    })
}

fn witnessed() -> Value {
    campaign(vec![
        npc("guard", "Страж Бран", VILLAGE, "brod-watch"),
        npc("baker", "Пекарь Мила", VILLAGE, "brod-guild"),
        npc("miller", "Мельник Ждан", MILL, "mill-folk"),
        npc("clerk", "Писец Ольд", CAPITAL, "crown"),
        npc("hermit", "Отшельник", EDGE, "wilds-folk"),
    ])
}

/// Смерть стража: в JS редьюсер мира сначала гасит жертву, поэтому живые
/// свидетели здесь — все, кроме неё.
fn death_event() -> Value {
    json!({
        "event_id": "evt-death", "command_id": "cmd-death", "event_type": "NpcDied", "actor_id": "hero",
        "payload": { "npc_id": "guard", "npc_name": "Страж Бран", "source_actor_id": "hero" },
    })
}

fn apply(mut state: Value, event: &Value) -> Value {
    let ledger = apply_world_deed_event(state.get("world_deeds"), event, &state);
    state["world_deeds"] = ledger;
    state
}

fn dead(mut state: Value, npc_id: &str) -> Value {
    state["npc_world"] = json!({ "vitals": { npc_id: { "hp": 0, "max_hp": 4, "alive": false } } });
    state
}

fn spread_at(state: &Value, minute: i64) -> Vec<String> {
    let mut list: Vec<String> = rumor_spread_targets(state, &json!({ "worldMinute": minute }))
        .iter()
        .map(|target| format!("{}@{}", target["npc_id"].as_str().unwrap_or_default(), target["hop"]))
        .collect();
    list.sort();
    list
}

const GRAVE: i64 = 360;

#[test]
fn witness_gives_rumor_only_after_delay_and_spreads_by_graph() {
    let state = apply(dead(witnessed(), "guard"), &death_event());
    let deed = &state["world_deeds"]["deeds"][0];
    assert_eq!(deed["kind"], "murder");
    assert_eq!(deed["severity"], "grave");
    assert_eq!(deed["witness_ids"], json!(["baker"]));
    assert_eq!(deed["secret"], false);
    assert_eq!(deed["spread_at_minutes"], GRAVE);
    assert_eq!(deed["summary"], "Ада: убийство — Страж Бран (Тихий Брод)");
    assert!(spread_at(&state, GRAVE - 1).is_empty());
    assert_eq!(spread_at(&state, GRAVE), ["baker@0"]);
    assert_eq!(spread_at(&state, GRAVE + RUMOR_HOP_MINUTES), ["baker@0", "miller@1"]);
    assert_eq!(spread_at(&state, GRAVE + RUMOR_HOP_MINUTES * 2), ["baker@0", "clerk@2", "miller@1"]);
    assert_eq!(spread_at(&state, GRAVE + RUMOR_HOP_MINUTES * 20), ["baker@0", "clerk@2", "miller@1"]);

    let targets = rumor_spread_targets(&state, &json!({ "worldMinute": GRAVE + RUMOR_HOP_MINUTES * 2 }));
    let by_hop = |hop: i64| targets.iter().find(|target| target["hop"] == hop).map(|target| target["claim"].as_str().unwrap_or_default().to_string()).unwrap_or_default();
    assert!(by_hop(0).contains("Страж Бран") && by_hop(0).contains("Ада"));
    assert!(!by_hop(1).contains("Ада") && !by_hop(2).contains("Страж Бран"));
    assert!(by_hop(2).contains("резн"));
}

#[test]
fn secret_deed_never_spreads() {
    let state = apply(dead(campaign(vec![npc("guard", "Страж Бран", VILLAGE, "brod-watch")]), "guard"), &death_event());
    assert_eq!(state["world_deeds"]["deeds"][0]["secret"], true);
    assert!(rumor_spread_targets(&state, &json!({ "worldMinute": 100_000 })).is_empty());
}

#[test]
fn tick_writes_fact_and_rumors_and_reputation_is_paid_once() {
    let state = apply(dead(witnessed(), "guard"), &death_event());
    let minute = GRAVE + RUMOR_HOP_MINUTES;
    let plan = plan_world_rumor_tick(&state, &json!({ "worldMinute": minute }));
    let commands = plan["commands"].as_array().cloned().unwrap_or_default();
    let types: Vec<&str> = commands.iter().filter_map(|command| command["command_type"].as_str()).collect();
    assert_eq!(types[..2], ["UpsertWorldEntity", "RecordWorldFact"]);
    let fact = &commands[1]["fact"];
    assert_eq!(fact["visibility"], "gm_only");
    let object: Value = serde_json::from_str(fact["object"].as_str().unwrap_or("{}")).unwrap_or_default();
    assert_eq!(object["kind"], "murder");
    // Прямой свидетель видел сам: его слух сразу подтверждается.
    assert!(commands.iter().any(|command| command["command_type"] == "ResolveEpistemicClaim"));

    // Слухи дошли — репутация: полная поправка у свидетеля, половина у пересказа.
    let mut heard = state.clone();
    let claims: Vec<Value> = plan["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|target| json!({ "id": target["claim_id"], "kind": "rumor", "holder_entity_id": target["npc_id"] }))
        .collect();
    heard["worldMemory"] = json!({ "epistemic_claims": claims });
    let reputation = plan_world_rumor_reputation(&heard);
    let pairs: Vec<(String, Value)> = reputation.iter().map(|event| (event["payload"]["faction_id"].as_str().unwrap_or_default().to_string(), event["payload"]["delta"].clone())).collect();
    assert_eq!(pairs, vec![("brod-guild".into(), json!(-8)), ("mill-folk".into(), json!(-4))]);
    let mut paid = heard.clone();
    for event in &reputation {
        paid = apply(paid, event);
    }
    assert_eq!(paid["world_deeds"]["deeds"][0]["reputation_faction_ids"], json!(["brod-guild", "mill-folk"]));
    assert!(plan_world_rumor_reputation(&paid).is_empty());
}

#[test]
fn feed_is_sorted_with_labels_and_witness_counts() {
    let mut state = witnessed();
    state = apply(state, &json!({ "event_id": "evt-fire", "command_id": "cmd-fire", "event_type": "SceneObjectOperated", "actor_id": "hero", "payload": { "prop_id": "crate", "kind": "container", "intent": "ignite" } }));
    state["mechanics"]["world_time"]["elapsed_minutes"] = json!(90);
    state = apply(dead(state, "guard"), &death_event());
    let feed = world_deeds_feed(&state, &json!({}));
    let kinds: Vec<&Value> = feed.iter().map(|deed| &deed["kind"]).collect();
    assert_eq!(kinds, [&json!("murder"), &json!("arson")]);
    assert_eq!(feed[0]["label"], "Убийство");
    assert_eq!(feed[1]["label"], "Поджог");
    assert_eq!(feed[1]["subject"], "чужие пожитки");
    for deed in &feed {
        assert_eq!(deed["witness_count"].as_u64(), deed["witness_ids"].as_array().map(|list| list.len() as u64));
    }
    for (name, kind) in DEED_KINDS {
        let mut chars = kind.label.chars();
        assert!(chars.next().is_some_and(|ch| ('А'..='Я').contains(&ch) || ch == 'Ё'), "{name}");
        assert!(chars.all(|ch| ('а'..='я').contains(&ch) || ch == 'ё' || ch == ' '), "{name}");
    }
}

#[test]
fn reputation_delta_by_severity_and_hop() {
    let deed = |kind: &str, severity: &str| json!({ "kind": kind, "severity": severity });
    assert_eq!(rumor_reputation_delta(Some(&deed("murder", "grave")), Some(&json!(0))), -8.0);
    assert_eq!(rumor_reputation_delta(Some(&deed("murder", "grave")), Some(&json!(2))), -2.0);
    assert_eq!(rumor_reputation_delta(Some(&deed("rescue", "major")), Some(&json!(1))), 3.0);
    assert_eq!(rumor_reputation_delta(Some(&deed("rescue", "minor")), Some(&json!(2))), 1.0);
    assert_eq!(rumor_reputation_delta(None, None), -2.0);
}

/// Замечено в JS: ключи `Object.prototype` проходят таблицы как свои.
#[test]
fn js_prototype_quirks_are_kept() {
    // Вид `constructor` — законный вид летописи (`DEED_KINDS[kind]` истинно).
    let ledger = normalize_world_deeds_state(Some(&json!({ "deeds": [{ "id": "deed:x", "kind": "constructor" }] })));
    assert_eq!(ledger["deeds"][0]["kind"], "constructor");
    assert_eq!(ledger["deeds"][0]["severity"], "minor");
    // Ступень `toString` даёт поправку NaN (в JSON — null).
    assert!(rumor_reputation_delta(Some(&json!({ "severity": "toString" })), None).is_nan());
    // Обстановка вида `constructor` — в предмете поступка текст встроенной функции.
    let state = witnessed();
    let deed = deed_from_event(&state, &json!({ "event_id": "e", "event_type": "SceneObjectOperated", "actor_id": "hero", "payload": { "prop_id": "p", "kind": "constructor", "intent": "topple" } })).unwrap_or_default();
    assert_eq!(deed["subject"], "function Object() { [native code] }");
    // Обещание без `npc_id`: свидетелем становится строка `undefined`.
    let mut promised = witnessed();
    promised["social"]["promises"] = json!([{ "id": "promise-1", "hero_id": "hero" }]);
    let deed = deed_from_event(&promised, &json!({ "event_id": "e2", "event_type": "NpcPromiseResolved", "payload": { "promise_id": "promise-1", "status": "broken" } })).unwrap_or_default();
    assert!(deed["witness_ids"].as_array().is_some_and(|ids| ids.contains(&json!("undefined"))));
}

#[test]
fn hop_distances_follow_routes_both_ways() {
    let state = witnessed();
    let distances = world_hop_distances(&state, Some(&json!("capital")));
    let pairs: Vec<(String, i64)> = distances.into_iter().collect();
    assert_eq!(pairs, vec![("capital".into(), 0), ("edge".into(), 1), ("mill".into(), 1), ("village".into(), 2)]);
    assert_eq!(world_node_id_for(&state, Some(&json!("  столица "))), json!("capital"));
    assert_eq!(world_node_id_for(&state, Some(&json!("Нигде"))), json!(""));
}
