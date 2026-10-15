//! Сверка `authored_location_maps` с эталоном JS
//! (`fixtures/authored-location-maps.json`, генератор
//! `fixtures/gen-authored-location-maps.mjs`) и проверки
//! `test/authored-location-maps.test.mjs`, `test/authored-map-movement.test.mjs`
//! и `test/small-tactical-maps.test.mjs`, где предмет — сам каталог.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, hash, parse, serialize, UNDEFINED};
use serde_json::{json, Map, Value};
use sk_map_core::authored_location_maps::{
    authored_location_map_catalog_snapshot, authored_location_map_count, authored_location_map_for, authored_location_map_id, authored_location_map_ids,
    authored_location_map_marker, authored_location_map_meta_for, has_authored_location_map, normalize_authored_location_map_catalog, CatalogError,
    AUTHORED_LOCATION_MAP_CATALOG_VERSION,
};
use sk_map_core::map_quality::audit_tactical_map;
use sk_tactical::tactical_map::{self as t, validate_tactical_map};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/authored-location-maps.json")));

fn value_arg(value: &Value) -> Option<&Value> {
    (value.as_str() != Some(UNDEFINED)).then_some(value)
}

fn outcome(result: Result<sk_core::indexmap::IndexMap<String, Value>, CatalogError>) -> Value {
    match result {
        Ok(maps) => json!({ "ok": maps.iter().map(|(id, map)| json!([id, hash(map)])).collect::<Vec<_>>() }),
        Err(error) => json!({ "error": { "name": error.name(), "code": error.code(), "message": error.message() } }),
    }
}

/// Вход разбора по шаблону эталона (`materialize` генератора).
fn materialize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(materialize).collect()),
        Value::Object(object) => {
            if let Some(name) = object.get("$map").and_then(Value::as_str) {
                let mut map = FIXTURE["bases"][name].clone();
                if object.get("$dupProp").is_some_and(|flag| flag == true) {
                    let first = map["props"][0].clone();
                    if let Some(props) = map["props"].as_array_mut() {
                        props.push(first);
                    }
                }
                if let (Some(target), Some(Value::Object(fields))) = (map.as_object_mut(), object.get("$set")) {
                    for (key, item) in fields {
                        target.insert(key.clone(), materialize(item));
                    }
                }
                return map;
            }
            Value::Object(object.iter().map(|(key, item)| (key.clone(), materialize(item))).collect::<Map<String, Value>>())
        }
        other => other.clone(),
    }
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["version"], AUTHORED_LOCATION_MAP_CATALOG_VERSION);
    assert_eq!(constants["count"], authored_location_map_count());
    assert_eq!(constants["ids"], json!(authored_location_map_ids()));
    // Регулярные выражения — те же, что в JS (источник без флагов).
    assert!(sk_core::text::test(authored_location_map_marker(), "authored-tactical:astohan-stormberg:v1"));
    assert!(!sk_core::text::test(authored_location_map_marker(), "authored-tactical:astohan-stormberg:v0"));
    assert!(!sk_core::text::test(authored_location_map_id(), "../fake"));
    assert_eq!(constants["marker"], r"^authored-(?:location|tactical):([a-z0-9]+(?:-[a-z0-9]+)*):v([1-9][0-9]*)$");
    assert_eq!(constants["id"], r"^[a-z0-9][a-z0-9_-]{0,119}$");
}

#[test]
fn embedded_catalog_matches_js() {
    let snapshot = authored_location_map_catalog_snapshot();
    for case in array(&FIXTURE["catalog"]) {
        let id = case["id"].as_str().expect("id");
        let key = Value::String(id.into());
        let meta = authored_location_map_meta_for(Some(&key)).map_or(Value::Null, |meta| meta.to_json());
        assert_same(&meta, &case["meta"], id);
        let map = authored_location_map_for(Some(&key)).expect("карта места");
        assert_eq!(hash(&serialize(&map)), case["map"].as_str().unwrap_or(""), "{id}");
        assert_eq!(hash(&snapshot[id]), case["snapshot"].as_str().unwrap_or(""), "{id}");
    }
}

#[test]
fn loose_ids_match_js() {
    for case in array(&FIXTURE["probes"]) {
        let value = value_arg(&case["value"]);
        let context = case["value"].to_string();
        assert_eq!(has_authored_location_map(value), case["has"] == true, "{context}");
        let meta = authored_location_map_meta_for(value).map_or(Value::Null, |meta| meta.to_json());
        assert_same(&meta, &case["meta"], &context);
        let map = authored_location_map_for(value).map_or(Value::Null, |map| Value::String(hash(&serialize(&map))));
        assert_same(&map, &case["map"], &context);
    }
}

#[test]
fn catalog_normalization_matches_js() {
    let cases = array(&FIXTURE["normalize"]);
    assert_eq!(cases.len(), 35);
    for case in cases {
        let input = materialize(&case["input"]);
        for (index, require_complete) in [false, true].into_iter().enumerate() {
            let actual = outcome(normalize_authored_location_map_catalog(&input, require_complete));
            assert_same(&actual, &case["outcomes"][index], &format!("{} полнота {require_complete}", case["input"]));
        }
    }
    let full = json!({ "schema_version": 1, "maps": authored_location_map_ids().iter().map(|id| authored_location_map_catalog_snapshot()[id].clone()).collect::<Vec<_>>() });
    assert_same(&outcome(normalize_authored_location_map_catalog(&full, true)), &json!({ "ok": FIXTURE["complete"] }), "полный каталог");
}

#[test]
fn catalog_holds_56_native_maps_and_each_validates() {
    let ids = authored_location_map_ids();
    assert_eq!(ids.len(), 56);
    assert_eq!(authored_location_map_count(), 56);
    for id in &ids {
        let map = authored_location_map_for(Some(&Value::String(id.clone()))).expect("карта");
        assert_eq!(&map.location_id, id);
        assert_eq!(map.seed, format!("authored-tactical:{id}:v1"));
        assert_eq!(map.tileset_id, format!("authored-tactical:{id}:v1"));
        assert_eq!(map.generator.id, "authored-tactical-scene");
        assert!(map.width <= 100 && map.height <= 100, "{id}: карта больше 100×100");
        assert!(validate_tactical_map(&map).ok, "{id}");
        assert!(map.spawn_points.iter().any(|point| point.role == "party"), "{id}");
        assert!(!map.props.is_empty(), "{id}");
    }
}

#[test]
fn copies_are_isolated() {
    let key = json!("astohan-stormberg");
    let mut first = authored_location_map_for(Some(&key)).expect("карта");
    let second = authored_location_map_for(Some(&key)).expect("карта");
    assert_eq!(serialize(&first), serialize(&second));
    first.props.clear();
    assert_ne!(first.props.len(), second.props.len());
    assert!(validate_tactical_map(&second).ok);
}

#[test]
fn ares_map_keeps_boundaries_table_and_doors() {
    let map = authored_location_map_for(Some(&json!("astohan-stormberg"))).expect("карта Штормберга");
    assert_eq!((map.width, map.height), (24, 18));
    assert!(!t::cell_passable(&map, 6, 4));
    let table = map.prop("war-table").expect("стол");
    assert_eq!(table.asset_id, "table_royal");
    let footprint: Vec<String> = table.footprint.iter().map(|point| format!("{},{}", point.x, point.y)).collect();
    assert_eq!(footprint, ["11,6", "12,6", "11,7", "12,7", "11,8", "12,8", "11,9", "12,9", "11,10", "12,10"]);
    assert!(table.footprint.iter().all(|point| t::cell_passable(&map, point.x, point.y)));
    for x in 0..map.width {
        assert!(!t::cell_passable(&map, x, 0) && !t::cell_passable(&map, x, map.height - 1));
    }
    for y in 0..map.height {
        assert!(!t::cell_passable(&map, 0, y) && !t::cell_passable(&map, map.width - 1, y));
    }
    let mut doors: Vec<&str> = map.doors.iter().map(|door| door.id.as_str()).collect();
    doors.sort_unstable();
    assert_eq!(doors, ["ares-east-archive", "ares-gallery-entrance-east", "ares-gallery-entrance-west", "ares-west-study"]);
    for door in &map.doors {
        let (nx, ny) = t::edge_neighbor(door.x, door.y, door.dir);
        assert!(t::cell_passable(&map, door.x, door.y) && t::cell_passable(&map, nx, ny), "{}", door.id);
        let edge = t::edge_between(&map, door.x, door.y, nx, ny).expect("ребро").expect("ребро двери");
        assert_eq!(edge.door_id.as_deref(), Some(door.id.as_str()));
    }
}

#[test]
fn every_authored_map_is_playable_by_audit() {
    // Сквозной прогон Асстохана (2026-10-05): валун на единственной клетке
    // прохода от точки появления. Аудит каталога держит проход, двери и вход.
    let hard = ["PARTY_SPAWN_BLOCKED", "UNREACHABLE_FLOOR", "DOORWAY_BLOCKED", "SPAWN_CRAMPED"];
    let mut broken = Vec::new();
    for id in authored_location_map_ids() {
        let map = authored_location_map_for(Some(&Value::String(id.clone()))).expect("карта");
        let problems: Vec<&str> = audit_tactical_map(&map).problems.iter().map(|problem| problem.code).filter(|code| hard.contains(code)).collect();
        if !problems.is_empty() {
            broken.push(format!("{id}: {problems:?}"));
        }
    }
    assert_eq!(broken, Vec::<String>::new());
}
