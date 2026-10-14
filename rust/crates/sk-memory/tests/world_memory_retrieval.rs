//! Сверка поиска по памяти мира с эталоном `server/world-memory.mjs`
//! (`fixtures/gen-world-memory-retrieval.mjs`) и проверки
//! `test/world-memory-graph-retrieval.test.mjs`: шаг по графу, скрытые рёбра,
//! служебные слова, пустой ответ по просьбе, порядок и форма записи.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_memory::world_memory::*;

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "retrieveWorldMemory" => Outcome::of(retrieve_world_memory(args.val(0), args.val(1), &args.obj(2))),
        "retrieveKnownWorldMemory" => Outcome::of(retrieve_known_world_memory(args.val(0), &args.obj(1))),
        "knownWorldLore" => Outcome::of(known_world_lore(args.val(0), args.opt(1), args.opt(2))),
        _ => Outcome::Unknown,
    }
}

#[test]
fn retrieval_matches_js() {
    let total = Fixture::load(include_str!("../fixtures/world-memory-retrieval.json")).check(dispatch);
    assert!(total > 3_000, "эталон подозрительно мал: {total}");
}

fn memory() -> Value {
    let entity = |id: &str, kind: &str, name: &str, visibility: &str, aliases: &[&str]| json!({ "id": id, "kind": kind, "name": name, "summary": "", "aliases": aliases, "visibility": visibility, "tags": [] });
    let fact = |id: &str, subject: &str, summary: &str, visibility: &str| {
        json!({ "id": id, "subject_id": subject, "predicate": "note", "object": summary.chars().take(40).collect::<String>(), "summary": summary, "visibility": visibility,
            "source_event_ids": [format!("event:{id}")], "status": "active", "recorded_at_minutes": 0 })
    };
    let relationship = |id: &str, from: &str, relation: &str, to: &str, visibility: &str| {
        json!({ "id": id, "from_entity_id": from, "relation": relation, "to_entity_id": to, "summary": format!("{from} {relation} {to}"), "visibility": visibility,
            "source_event_ids": [format!("event:{id}")], "status": "active", "recorded_at_minutes": 0 })
    };
    json!({
        "schema_version": 2,
        "entities": [
            entity("npc:grig", "npc", "Григ Одноглазый", "party", &["Григ"]),
            entity("faction:crows", "faction", "Братство Ворона", "party", &[]),
            entity("npc:lord", "npc", "лорд Воронов", "public", &[]),
            entity("npc:tom", "npc", "Том Рыбак", "public", &["Том"]),
            entity("location:caves", "location", "Пещеры Шёпота", "party", &[]),
            entity("location:inn", "location", "Таверна у моста", "public", &[]),
        ],
        "facts": [
            fact("fact:grig-eye", "npc:grig", "Потерял глаз в поножовщине на причале.", "party"),
            fact("fact:crows-wine", "faction:crows", "Возят контрабандное вино мимо таможни по ночам.", "party"),
            fact("fact:lord-tax", "npc:lord", "Поднял пошлину на улов вдвое.", "public"),
            fact("fact:caves-tracks", "location:caves", "У входа следы волочения и обрывок сети.", "party"),
            fact("fact:inn-price", "location:inn", "Комната на ночь стоит серебряную монету.", "public"),
            fact("fact:storm-rumor", "location:inn", "Жрец твердит, что буря была карой за жадность.", "public"),
        ],
        "relationships": [
            relationship("rel:grig-crows", "npc:grig", "member_of", "faction:crows", "party"),
            relationship("rel:grig-lord", "npc:grig", "secretly_serves", "npc:lord", "gm_only"),
        ],
        "quests": [{ "id": "quest:fishers", "title": "Пропавшие рыбаки", "summary": "Найти тех, кто не вернулся с промысла.", "status": "active", "visibility": "party",
            "entity_ids": ["npc:tom", "location:caves"], "objectives": [], "clock": { "current": 0, "max": 4, "label": "" }, "recorded_at_minutes": 0 }],
        "threads": [], "epistemic_claims": [], "summaries": [], "knowledge_ledger": [],
    })
}

fn player() -> Value {
    json!({ "playerId": "hero", "isPartyMember": true })
}

fn ids(records: &[Value]) -> Vec<String> {
    records.iter().filter_map(|record| record["id"].as_str().map(str::to_string)).collect()
}

#[test]
fn one_hop_finds_the_neighbour_of_a_named_entity() {
    let before = ids(&retrieve_world_memory(&memory(), &player(), &json!({ "query": "Чем промышляет Григ?", "limit": 5, "neighbours": false })));
    assert!(!before.contains(&"fact:crows-wine".to_string()));
    let after = ids(&retrieve_world_memory(&memory(), &player(), &json!({ "query": "Чем промышляет Григ?", "limit": 5 })));
    let position = |id: &str| after.iter().position(|entry| entry == id);
    assert!(position("fact:crows-wine").is_some(), "{after:?}");
    assert!(position("fact:grig-eye") < position("fact:crows-wine"));
}

#[test]
fn hidden_edge_gives_no_hop_to_the_player_but_does_to_the_gm() {
    let player = ids(&retrieve_world_memory(&memory(), &player(), &json!({ "query": "Чем промышляет Григ?", "limit": 10 })));
    assert!(!player.contains(&"fact:lord-tax".to_string()));
    assert!(!player.contains(&"rel:grig-lord".to_string()));
    let gm = ids(&retrieve_world_memory(&memory(), &json!({ "isAdmin": true }), &json!({ "query": "Чем промышляет Григ?", "limit": 10 })));
    assert!(gm.contains(&"fact:lord-tax".to_string()), "{gm:?}");
}

#[test]
fn matched_quest_passes_strength_to_its_entities() {
    let result = ids(&retrieve_world_memory(&memory(), &player(), &json!({ "query": "новости по делу о пропавших рыбаках", "limit": 5 })));
    assert_eq!(result[0], "quest:fishers");
    assert!(result.contains(&"fact:caves-tracks".to_string()), "{result:?}");
}

#[test]
fn stop_words_do_not_match_and_unmatched_contract_holds() {
    let stop = ids(&retrieve_world_memory(&memory(), &player(), &json!({ "query": "что это?", "limit": 5, "whenUnmatched": "none" })));
    assert_eq!(stop, ids(&retrieve_world_memory(&memory(), &player(), &json!({ "query": "", "limit": 5 }))));
    assert!(retrieve_world_memory(&memory(), &player(), &json!({ "query": "Что известно о драконах?", "limit": 5, "whenUnmatched": "none" })).is_empty());
    let fallback = retrieve_world_memory(&memory(), &player(), &json!({ "query": "боевой грифон", "limit": 3 }));
    assert_eq!(fallback.len(), 3);
    let mut sorted = ids(&fallback);
    sorted.sort();
    assert_eq!(ids(&fallback), sorted);
    assert!(fallback.iter().all(|record| record["score"] == json!(0)));
    assert!(retrieve_world_memory(&memory(), &player(), &json!({ "query": "боевой грифон", "limit": 3, "whenUnmatched": "none" })).is_empty());
    assert!(retrieve_known_world_memory(&memory(), &json!({ "viewer": player(), "query": "боевой грифон" })).is_empty());
    assert!(known_world_lore(&memory(), Some(&json!("боевой грифон")), Some(&player())).is_empty());
}

#[test]
fn order_is_deterministic_limit_holds_and_record_shape_is_stable() {
    let options = json!({ "query": "Григ Братство Ворона лорд", "limit": 2 });
    let first = retrieve_world_memory(&memory(), &json!({ "isAdmin": true }), &options);
    assert_eq!(first, retrieve_world_memory(&memory(), &json!({ "isAdmin": true }), &options));
    assert_eq!(first.len(), 2);
    for record in &first {
        for key in ["anchors", "hub", "search", "lexical", "exact"] {
            assert!(record.get(key).is_none(), "{key}");
        }
        assert!(record["score"].is_number());
    }
}
