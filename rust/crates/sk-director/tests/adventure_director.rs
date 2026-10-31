//! Перенос проверок модуля из тестов JS: `test/adventure-director.test.mjs`,
//! `test/scene-entry-road.test.mjs`, `test/scene-program-corpus.test.mjs`,
//! модульные части `test/scene-transition-engine.test.mjs` и
//! `test/director-three-scenes.test.mjs` (через `resolveCommand` и HTTP —
//! не здесь). Инварианты AGENTS.md §5: карта держит программу сцены, двадцать
//! мест корпуса строятся без замечаний; отряд входит со стороны, откуда
//! пришёл, центр сцены — на площади.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_director::adventure_director::*;
use sk_map_core::map_quality::{audit_tactical_map, program_report, ProgramOptions, SETTLEMENT_MIN_SIZE};
use sk_scene_base::scene_requirements::scene_map_requirements_for;
use sk_tactical::tactical_map::{
    add_prop, add_spawn_point, cell_at, create_tactical_map, deserialize_tactical_map, edge_neighbor, legacy_cells_from_tactical_map, reachable_cells, serialize_tactical_map,
    set_cell, validate_tactical_map, CellPatch, TacticalMap, TacticalMapOptions,
};
use sk_themes::scene_themes::{all_scene_themes, is_live_theme, resolve_scene_theme};

/// Заявка на карту в том виде, в каком её всегда присылает картограф.
fn map_request(extra: Value) -> Value {
    js::spread(
        &json!({ "layout": "rooms", "scale": "room", "pattern": "small-room", "material": "wood", "width": 9, "height": 7, "openness": 0.82, "water": 0, "featureCount": 9 }),
        extra,
    )
}

/// Тематическая карта: прямоугольник целиком, не мельче 16×16, с дверями.
fn looks_themed(cells: &[Value]) -> bool {
    cells.len() >= 16 * 16 && cells.iter().any(|cell| cell["type"] == "door")
}

fn transition(input: Value, state: Value) -> Value {
    create_scene_transition_with(&input, &state, None).expect("переход")
}

fn scene_map(transition: &Value) -> TacticalMap {
    deserialize_tactical_map(&transition["scene"]["map"]).expect("карта сцены")
}

fn party(map: &TacticalMap) -> (i64, i64) {
    let point = map.spawn_points.iter().find(|point| point.role == "party").expect("вход отряда");
    (point.x, point.y)
}

fn zone_kind<'a>(map: &'a TacticalMap, x: i64, y: i64) -> Option<&'a str> {
    let zone = cell_at(map, x, y)?.zone;
    map.zones.iter().find(|entry| entry.id == zone).map(|entry| entry.kind.as_str())
}

// --- test/adventure-director.test.mjs ------------------------------------------------------

#[test]
fn legacy_scene_map_is_deterministic_and_connected() {
    let spec = json!({ "seed": "campaign:2", "theme": "подземные руины", "danger": "средняя" });
    let first = generate_scene_map(Some(&spec)).expect("карта");
    assert_eq!(first, generate_scene_map(Some(&spec)).expect("карта"));
    assert_eq!(first.len(), 13 * 9);
    assert_eq!(first.iter().find(|cell| cell["x"] == 1 && cell["y"] == 4).map(|cell| cell["type"].clone()), Some(json!("floor")));
    assert!(first.iter().any(|cell| cell["feature"] == "stairs"));
    assert!(first.iter().filter(|cell| cell["revealed"] == true).all(|cell| cell["x"].as_i64().unwrap_or(99) <= 2));
}

#[test]
fn transition_archives_scene_and_opens_new_chapter() {
    let state = json!({
        "sessionCode": "RUNE-1",
        "scene": { "title": "Склеп", "location": "Склеп Норвин", "objective": "Вернуть печать", "turn": 7, "cells": [] },
        "adventure": { "chapter": 1, "visitedLocations": ["Склеп Норвин"], "history": [] },
    });
    let result = transition(
        json!({
            "title": "Голоса на тракте", "location": "Северный тракт", "mood": "Холодный рассвет",
            "objective": "Найти исчезнувший обоз", "transition": "За дверью склепа тропа выводит героев к тракту.",
            "arrival": "В колеях лежит свежий иней.", "hook": "Печать совпадает со знаком на колесе.", "theme": "дорога",
            "danger": "низкая", "outcome": "Печать архивариуса возвращена.",
        }),
        state,
    );
    assert_eq!(result["adventure"]["chapter"], 2);
    assert_eq!(result["adventure"]["history"][0]["location"], "Склеп Норвин");
    assert_eq!(result["scene"]["location"], "Северный тракт");
    assert_eq!(result["scene"]["turn"], 8);
    let spawn = result["scene"]["map"]["spawnPoints"].as_array().and_then(|points| points.iter().find(|point| point["role"] == "party")).expect("вход отряда");
    assert_eq!(result["entrance"], json!({ "x": spawn["x"], "y": spawn["y"] }));
    assert!(result["scene"]["cells"].as_array().expect("клетки").iter().any(|cell| cell["x"] == spawn["x"] && cell["y"] == spawn["y"] && cell["type"] == "floor"));
    assert!(result.get("suggestions").is_none());
}

#[test]
fn transition_caps_model_generated_fields() {
    let huge = "я".repeat(1000);
    let result = transition(json!({ "title": huge, "location": huge, "objective": huge, "transition": huge, "arrival": huge }), json!({ "scene": {} }));
    let length = |value: &Value| value.as_str().map_or(0, |text| text.encode_utf16().count());
    assert_eq!(length(&result["scene"]["title"]), 80);
    assert_eq!(length(&result["scene"]["location"]), 120);
    assert_eq!(length(&result["scene"]["objective"]), 160);
    assert_eq!(length(&result["transition"]), 500);
    assert_eq!(length(&result["arrival"]), 500);
}

#[test]
fn public_transition_drops_private_memory_and_cell_secrets() {
    let state = json!({
        "sessionCode": "PRIVATE-RUNE",
        "scene": {
            "title": "Закрытый архив", "location": "Архив", "objective": "Найти выход", "turn": 4,
            "gm_only": { "map": "SCENE-GM-SECRET" },
            "cells": [{ "x": 1, "y": 1, "type": "floor", "revealed": false, "hidden_information": "CELL-HIDDEN-SECRET", "secret": "CELL-SECRET" }],
        },
        "adventure": {
            "chapter": 2, "currentHook": "Публичная нить печати", "visitedLocations": ["Архив"], "unresolvedThreads": ["Найти владельца печати"],
            "history": [{ "chapter": 1, "title": "Вход", "location": "Башня", "objective": "Войти", "outcome": "Герои вошли", "status": "unresolved",
                "gm_only": "HISTORY-GM-SECRET", "hidden_information": "HISTORY-HIDDEN-SECRET" }],
            "gm_only": { "villain": "ADVENTURE-GM-SECRET" }, "hidden_information": { "door": "ADVENTURE-HIDDEN-SECRET" },
            "npc_private": { "archivist": "NPC-PRIVATE-SECRET" }, "specific_player": { "hero": "PLAYER-PRIVATE-SECRET" },
            "custom_private_memory": "CUSTOM-PRIVATE-SECRET",
        },
    });
    let result = transition(json!({ "title": "Городские ворота", "location": "Город Норвин", "objective": "Найти рынок", "hook": "Публичная нить печати продолжается", "theme": "городские улицы" }), state);
    let mut keys: Vec<&str> = result["adventure"].as_object().expect("память").keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["chapter", "currentHook", "history", "lastTransition", "unresolvedThreads", "visitedLocationIds", "visitedLocations"]);
    assert_eq!(result["adventure"]["history"][0]["status"], "unresolved");
    let payload = js::stringify(&result);
    for secret in [
        "SCENE-GM-SECRET", "CELL-HIDDEN-SECRET", "CELL-SECRET", "HISTORY-GM-SECRET", "HISTORY-HIDDEN-SECRET", "ADVENTURE-GM-SECRET", "ADVENTURE-HIDDEN-SECRET",
        "NPC-PRIVATE-SECRET", "PLAYER-PRIVATE-SECRET", "CUSTOM-PRIVATE-SECRET",
    ] {
        assert!(!payload.contains(secret), "{secret} в публичном переходе");
    }
}

#[test]
fn known_village_draws_streets_and_houses() {
    let world = json!({
        "seed": "brod", "name": "Край", "width": 1000, "height": 640, "currentLocationId": "tihiy-brod",
        "regions": [{ "id": "r", "name": "Долина", "x": 500, "y": 320, "radius": 300, "biome": "лес" }],
        "locations": [
            { "id": "tihiy-brod", "name": "Тихий Брод", "kind": "village", "x": 500, "y": 360, "regionId": "r", "summary": "", "known": true, "visited": true },
            { "id": "estwood", "name": "Эствуд", "kind": "village", "x": 300, "y": 280, "regionId": "r", "summary": "", "known": true, "visited": false },
        ],
        "routes": [{ "id": "route-1", "from": "tihiy-brod", "to": "estwood", "kind": "road", "distance": 2, "danger": "низкая", "discovered": true }],
    });
    let state = json!({
        "sessionCode": "BROD", "worldMap": world,
        "scene": { "title": "Камень у брода", "location": "Тихий Брод", "location_id": "tihiy-brod", "objective": "x", "turn": 3, "cells": [] },
        "adventure": { "chapter": 1, "visitedLocations": ["Тихий Брод"], "history": [] },
    });
    let input = json!({ "title": "Эствуд", "location": "Эствуд", "theme": "новая местность",
        "map": map_request(json!({ "layout": "open", "pattern": "natural", "material": "earth", "width": 15, "height": 11 })) });
    let result = transition(input.clone(), state.clone());
    assert_eq!(result["scene"]["location_id"], "estwood");
    let cells = result["scene"]["cells"].as_array().expect("клетки");
    assert!(cells.iter().filter(|cell| cell["type"] == "door").count() >= 4, "у домов деревни нет дверей — нарисовано поле");
    let walls: usize = cells
        .iter()
        .map(|cell| usize::from(cell["type"] == "wall" && cell["material"] == "wood") + cell["walls"].as_str().map_or(0, str::len))
        .sum();
    assert!(walls >= 40, "в деревне нет стен домов: {walls}");
    let mut unknown_state = state;
    unknown_state.as_object_mut().expect("состояние").shift_remove("worldMap");
    let unknown_input = js::spread(&input, json!({ "title": "Безымянная низина", "location": "Безымянная низина" }));
    let unknown = transition(unknown_input, unknown_state);
    assert!(!unknown["scene"]["cells"].as_array().expect("клетки").iter().any(|cell| cell["type"] == "door"), "неизвестная низина стала поселением");
}

#[test]
fn mapper_layout_request_does_not_cancel_theme() {
    let cells = generate_scene_cells_with(
        &json!({ "theme": "уютная таверна", "location": "Таверна «Сломанное колесо»", "seed": "gate:tavern", "locationId": "tavern", "map": map_request(json!({})) }),
        None,
    )
    .expect("клетки");
    assert!(looks_themed(&cells), "таверна собрана прежним генератором: {} клеток", cells.len());
}

#[test]
fn unknown_place_gets_connected_themed_fallback() {
    let input = json!({ "theme": "новая местность", "location": "Безымянная низина", "seed": "gate:plain", "locationId": "plain",
        "map": map_request(json!({ "layout": "open", "pattern": "natural", "width": 15, "height": 11 })) });
    let cells = generate_scene_cells_with(&input, None).expect("клетки");
    let generated = generate_scene_geometry_with(&input, None).expect("геометрия");
    let present = (0..generated.map.height).flat_map(|y| (0..generated.map.width).map(move |x| (x, y))).filter(|(x, y)| cell_at(&generated.map, *x, *y).is_some()).count();
    assert_eq!(cells.len(), present, "legacy-клетки должны совпадать с фактическим охватом тактической карты");
    assert!(validate_tactical_map(&generated.map).ok);
    let (x, y) = party(&generated.map);
    assert!(!reachable_cells(&generated.map, x, y, true, None).is_empty(), "fallback обязан иметь доступную область");
    assert!(cells.iter().any(|cell| cell["edge_mask"].as_str().is_some_and(|mask| !mask.is_empty())), "fallback не обозначил границу игровой области");
    assert!(cells.iter().any(|cell| js::truthy(cell.get("feature"))), "fallback оставил карту пустой");
    assert_eq!(cells, generate_scene_cells_with(&input, None).expect("клетки"), "fallback недетерминирован");
}

#[test]
fn fallback_keeps_requested_route() {
    let cells = generate_scene_cells_with(
        &json!({ "theme": "неизвестная окраина", "location": "Безымянный рубеж", "sceneKind": "wilderness", "seed": "fallback:route", "locationId": "route",
            "map": map_request(json!({ "layout": "winding", "pattern": "bridge", "material": "earth", "width": 20, "height": 16 })) }),
        None,
    )
    .expect("клетки");
    let columns: HashSet<i64> = cells.iter().filter(|cell| cell["material"] == "earth").filter_map(|cell| cell["x"].as_i64()).collect();
    assert_eq!(columns.len(), 20, "дорога fallback обязана пройти от края до края");
}

#[test]
fn organic_cave_and_settlement_reach_live_scene() {
    let cave = generate_scene_cells_with(
        &json!({ "theme": "подземные пещеры", "location": "Пещера у водопада", "seed": "live:cave", "locationId": "cave",
            "map": map_request(json!({ "layout": "cavern", "pattern": "cave-cluster", "width": 20, "height": 18 })) }),
        None,
    )
    .expect("пещера");
    assert_eq!(cave.len(), 22 * 20, "пещера обязана прийти из полноразмерной тематической карты");
    assert!(cave.iter().any(|cell| cell["feature"] == "stalagmite"), "в пещере нет пещерного реквизита");

    let input = json!({ "theme": "городские улицы", "location": "Деревня Заречье", "seed": "live:settlement", "locationId": "settlement",
        "map": map_request(json!({ "layout": "streets", "pattern": "village", "width": 15, "height": 11 })) });
    let settlement = generate_scene_cells_with(&input, None).expect("поселение");
    let map = generate_scene_geometry_with(&input, None).expect("геометрия").map;
    let houses: Vec<&str> = map.zones.iter().map(|zone| zone.id.as_str()).filter(|id| id.starts_with("building-") || id.starts_with("house-")).collect();
    assert_eq!(settlement.len() as i64, map.width * map.height);
    assert!(validate_tactical_map(&map).ok);
    assert!(map.width >= 20 && map.height >= 20, "поселению нужен реальный bounds");
    assert!(houses.len() >= 4, "поселение должно содержать несколько отдельных домов");
    assert!(map.doors.len() >= houses.len(), "у каждого дома должен быть проход");
    for house in &houses {
        let floor = (0..map.height).flat_map(|y| (0..map.width).map(move |x| (x, y))).filter(|(x, y)| cell_at(&map, *x, *y).is_some_and(|cell| cell.zone == *house && cell.passable)).count();
        assert!(floor > 0, "дом {house} не содержит игрового пола");
    }
    assert!(settlement.iter().filter(|cell| cell["type"] == "door").count() >= houses.len(), "в legacy-карте не читаются двери домов");
}

#[test]
fn crypt_pattern_leads_to_crypt() {
    let cells = generate_scene_cells_with(
        &json!({ "theme": "каменные залы", "location": "Нижний ярус", "seed": "gate:crypt", "locationId": "crypt-by-pattern",
            "map": map_request(json!({ "layout": "cavern", "pattern": "crypt", "material": "stone", "width": 15, "height": 11 })) }),
        None,
    )
    .expect("клетки");
    assert!(looks_themed(&cells), "узор crypt не довёл до темы: {} клеток", cells.len());
}

#[test]
fn every_live_theme_reaches_the_map() {
    let named = |id: &str| match id {
        "building" => "Таверна «Три бочки»",
        "temple" => "Храм Утренней Звезды",
        "crypt" => "Склеп Норвин",
        "cave" => "Пещера у водопада",
        "forest" => "Тёмный лес",
        "road" => "Северный тракт",
        "settlement" => "Деревня Заречье",
        _ => "",
    };
    let mut themes = 0;
    for theme in all_scene_themes().filter(|theme| is_live_theme(Some(theme)) && !theme.id.starts_with("authored-")) {
        themes += 1;
        let cells = generate_scene_cells_with(
            &json!({ "theme": theme.label, "location": named(theme.id), "seed": format!("live:{}", theme.id), "locationId": theme.id, "map": map_request(json!({})) }),
            None,
        )
        .expect("клетки");
        assert!(cells.len() >= 16 * 16, "{}: сцена собрана прежним генератором", theme.id);
        assert!(cells.iter().any(|cell| js::truthy(cell.get("feature"))), "{}: на карте нет реквизита", theme.id);
    }
    assert!(themes >= 7, "живых тем: {themes}");
}

#[test]
fn generator_choice_is_deterministic() {
    let build = || {
        generate_scene_cells_with(&json!({ "theme": "уютная таверна", "location": "Таверна «Сломанное колесо»", "seed": "stable:tavern", "locationId": "tavern", "map": map_request(json!({})) }), None)
            .expect("клетки")
    };
    assert_eq!(build(), build());
}

// --- test/scene-entry-road.test.mjs ---------------------------------------------------------

fn entry_world() -> Value {
    json!({
        "seed": "entry-road", "currentLocationId": "brod",
        "locations": [
            { "id": "brod", "name": "Старый Брод", "kind": "village", "x": 500, "y": 120, "known": true, "visited": true },
            { "id": "olsh", "name": "Ольшанка", "kind": "village", "x": 500, "y": 420, "known": true },
            { "id": "east", "name": "Восточный хутор", "kind": "village", "x": 820, "y": 420, "known": true },
        ],
    })
}

fn state_at(location_id: &str, location: &str) -> Value {
    let mut world = entry_world();
    world["currentLocationId"] = json!(location_id);
    json!({
        "sessionCode": "ENTRY", "worldMap": world,
        "scene": { "title": location, "location": location, "location_id": location_id, "turn": 1 },
        "adventure": { "chapter": 1, "history": [], "visitedLocations": [location] },
    })
}

fn party_edge(map: &TacticalMap) -> &'static str {
    let (x, y) = party(map);
    if x <= 1 {
        "west"
    } else if x >= map.width - 2 {
        "east"
    } else if y <= 1 {
        "north"
    } else if y >= map.height - 2 {
        "south"
    } else {
        "inside"
    }
}

fn olshanka(arrival: &str) -> Value {
    json!({ "title": "Ольшанка", "location": "Ольшанка", "location_id": "olsh", "theme": "деревня", "objective": "Найти старосту", "arrival": arrival, "objective_status": "completed" })
}

#[test]
fn party_enters_village_from_the_road_side() {
    for (from, name, expected) in [("brod", "Старый Брод", "north"), ("east", "Восточный хутор", "east")] {
        let result = transition(olshanka("Дорога выводит отряд к деревне."), state_at(from, name));
        let map = scene_map(&result);
        assert_eq!(party_edge(&map), expected, "из «{name}» вход — {expected}");
        let (x, y) = party(&map);
        assert_eq!(cell_at(&map, x, y).map(|cell| cell.zone), Some("street"), "вход — на дороге, а не в поле");
    }
}

#[test]
fn outdoor_focus_gives_village_a_square_with_doors_facing_it() {
    let result = transition(olshanka("В центре деревни — общий навес, под ним собираются жители."), state_at("brod", "Старый Брод"));
    let map = scene_map(&result);
    assert!(map.zones.iter().any(|zone| zone.id == "square"), "у деревни есть площадь");
    let awning = map.props.iter().find(|prop| prop.asset_id == "market_awning").expect("навес");
    assert!(awning.footprint.iter().all(|cell| cell_at(&map, cell.x, cell.y).is_some_and(|cell| cell.zone == "square")), "навес стоит на площади");
    let facing = map
        .doors
        .iter()
        .filter(|door| door.id.starts_with("building-") && door.id.ends_with("-door") && door.id["building-".len()..door.id.len() - "-door".len()].chars().all(|ch| ch.is_ascii_digit()))
        .filter(|door| {
            let neighbor = edge_neighbor(door.x, door.y, door.dir);
            let outside = [(door.x, door.y), neighbor].into_iter().find(|(x, y)| !cell_at(&map, *x, *y).is_some_and(|cell| cell.zone.starts_with("building-")));
            outside.is_some_and(|(x, y)| [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| cell_at(&map, x + dx, y + dy).is_some_and(|cell| cell.zone == "square")))
        })
        .count();
    assert!(facing >= 2, "дверью к площади — хотя бы два дома, а не {facing}");
}

#[test]
fn return_from_other_side_keeps_map_and_enters_at_that_edge() {
    let input = olshanka("Дорога выводит отряд к деревне.");
    let first = transition(input.clone(), state_at("brod", "Старый Брод"));
    assert_eq!(party_edge(&scene_map(&first)), "north");
    let mut visited = state_at("olsh", "Ольшанка");
    for key in ["worldMap", "scene", "adventure"] {
        visited[key] = first[key].clone();
    }
    remember_current_scene_map(&mut visited);
    let mut away = visited.clone();
    away["worldMap"]["currentLocationId"] = json!("east");
    away["scene"] = json!({ "title": "Восточный хутор", "location": "Восточный хутор", "location_id": "east", "turn": 3 });
    let back = transition(js::spread(&input, json!({ "objective_status": "unresolved" })), away);
    assert_eq!(back["scene"]["map"], first["scene"]["map"], "карта та же, что в первый раз");
    let map = scene_map(&back);
    let (x, y) = (back["entrance"]["x"].as_i64().expect("x"), back["entrance"]["y"].as_i64().expect("y"));
    assert!(x >= map.width - 2, "вход у восточного края: {x},{y} на {}×{}", map.width, map.height);
    assert_eq!(cell_at(&map, x, y).map(|cell| cell.passable), Some(true));
}

#[test]
fn party_arrives_outside_the_lighthouse() {
    let world = json!({
        "seed": "lighthouse-entry", "currentLocationId": "port",
        "locations": [
            { "id": "port", "name": "Серый Причал", "kind": "village", "x": 400, "y": 300, "known": true, "visited": true },
            { "id": "lighthouse", "name": "Заброшенный маяк", "kind": "landmark", "x": 700, "y": 300, "known": true },
        ],
    });
    let state = json!({ "sessionCode": "LH-ENTRY", "worldMap": world, "scene": { "title": "Серый Причал", "location": "Серый Причал", "location_id": "port", "turn": 1 },
        "adventure": { "chapter": 1, "history": [], "visitedLocations": ["Серый Причал"] } });
    let result = transition(
        json!({ "title": "Огонь над гаванью", "location": "Заброшенный маяк", "location_id": "lighthouse", "theme": "маяк", "objective": "Осмотреть маяк",
            "arrival": "Отряд добирается до маяка на скале.", "objective_status": "unresolved" }),
        state,
    );
    let map = scene_map(&result);
    let (x, y) = party(&map);
    assert_ne!(zone_kind(&map, x, y), Some("interior"), "отряд стоит в помещении");
    let labels: Vec<&str> = map.zones.iter().map(|zone| zone.label.as_str()).filter(|label| !label.is_empty()).collect();
    assert!(labels.contains(&"Нижний ярус маяка"), "{labels:?}");
    assert!(!labels.contains(&"Парадный зал") && !labels.contains(&"Салон"), "у маяка не комнаты усадьбы");
}

#[test]
fn party_arrives_at_the_lighthouse_door_from_outside() {
    let result = transition(
        json!({ "title": "Огни заброшенного маяка", "location": "Маяк на скале", "theme": "маяк", "objective": "Узнать, кто зажигает огонь",
            "arrival": "Тропа выводит отряд к двери маяка.", "objective_status": "completed" }),
        state_at("brod", "Старый Брод"),
    );
    let map = scene_map(&result);
    let (x, y) = (result["entrance"]["x"].as_i64().expect("x"), result["entrance"]["y"].as_i64().expect("y"));
    assert_ne!(zone_kind(&map, x, y), Some("interior"), "отряд появляется снаружи");
    // Точка снаружи стоит у наружной двери: в шаге от неё — дверь в помещение.
    let near_door = map.doors.iter().any(|door| {
        let (nx, ny) = edge_neighbor(door.x, door.y, door.dir);
        (door.x - x).abs() + (door.y - y).abs() <= 2 || (nx - x).abs() + (ny - y).abs() <= 2
    });
    assert!(near_door, "вход {x},{y} не у двери");
}

// --- test/scene-program-corpus.test.mjs ------------------------------------------------------

static CORPUS: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../../../../test/fixtures/scene-programs/corpus.json")).expect("корпус программ"));

#[test]
fn corpus_has_twenty_places() {
    let scenes = CORPUS["scenes"].as_array().expect("сцены");
    assert_eq!(scenes.len(), 20);
    assert_eq!(scenes.iter().filter_map(|scene| scene["id"].as_str()).collect::<HashSet<_>>().len(), 20);
}

/// Инвариант AGENTS.md §5: обещанное текстом стоит на карте и досягаемо;
/// двадцать мест корпуса строятся без замечаний.
#[test]
fn corpus_places_keep_their_program() {
    let mut failures = Vec::new();
    for scene in CORPUS["scenes"].as_array().expect("сцены") {
        let id = scene["id"].as_str().unwrap_or("?");
        let texts = json!([scene["location"], scene["text"]]);
        let program = scene_map_requirements_for(&texts, scene.get("npcs"), None).expect("текст что-то обещает");
        let ids: Vec<&str> = program.items.iter().map(|item| item.id.as_str()).collect();
        for expected in scene["expect"]["items"].as_array().expect("ожидания") {
            assert!(ids.contains(&expected.as_str().unwrap_or("")), "{id}: разбор текста видит «{expected}»");
        }
        if let Some(focus) = scene["expect"]["focus"].as_str() {
            assert_eq!(program.focus.as_deref(), Some(focus), "{id}: центр сцены");
        }
        let program = program.to_value();
        let geometry = generate_scene_geometry_with(
            &json!({ "location": scene["location"], "theme": scene["theme"], "settlementType": scene.get("settlementType").cloned().unwrap_or(json!("")),
                "seed": format!("corpus:{id}"), "useLibrary": false, "requirements": program["items"], "program": program }),
            None,
        )
        .expect("геометрия");
        let map = &geometry.map;
        if geometry.missing.is_some() {
            failures.push(format!("{id}: обязательное не воплощено {:?}", geometry.missing));
        }
        let settlement =
            resolve_scene_theme(&json!({ "location": scene["location"], "theme": scene["theme"], "settlementType": scene.get("settlementType").cloned().unwrap_or(json!("")) })).kind
                == "settlement";
        let report = program_report(map, &program, &ProgramOptions { min_size: settlement.then_some(SETTLEMENT_MIN_SIZE), open_scene: settlement });
        if !report.problems.is_empty() || !report.warnings.is_empty() {
            failures.push(format!("{id}: проверка по программе {:?} / {:?}", report.problems, report.warnings));
        }
        let audit = audit_tactical_map(map);
        if !audit.problems.is_empty() {
            failures.push(format!("{id}: общая проверка карты {:?}", audit.problems));
        }
        if map.width < 16 || map.height < 16 || map.width > 60 || map.height > 60 {
            failures.push(format!("{id}: размер {}×{}", map.width, map.height));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

// --- модульные части test/scene-transition-engine.test.mjs -------------------------------

fn engine_scene_args() -> Value {
    json!({
        "title": "Глава 3 · Северный город", "location": "Северный город", "mood": "Шумный вечер у городских ворот",
        "objective": "Найти снабженца каравана", "transition": "Отряд покидает склеп и выходит на северный тракт.",
        "arrival": "К закату впереди поднимаются стены Северного города.", "hook": "Знак на воротах повторяет печать архивариуса.",
        "theme": "городские улицы", "danger": "низкая", "scene_kind": "settlement", "settlement_type": "city",
        "seed": "scene-engine:chapter-3:north-city", "outcome": "Склеп остался позади.", "objective_status": "unresolved", "carry_unresolved": true,
        "map": { "layout": "streets", "width": 7, "height": 7, "openness": 0.68, "water": 0, "featureCount": 4 },
    })
}

fn engine_state() -> Value {
    json!({
        "sessionCode": "SCENE-ENGINE",
        "scene": { "title": "Старый склеп", "location": "Склеп Норвин", "mood": "Холод", "objective": "Найти печать", "turn": 7,
            "cells": [{ "x": 8, "y": 8, "type": "floor", "revealed": true, "hidden_information": "OLD-CELL-HIDDEN-SECRET", "secret": "OLD-CELL-SECRET" }] },
        "adventure": { "chapter": 2, "history": [], "gm_only": { "villain": "ENGINE-GM-SECRET" }, "private_notes": "ENGINE-PRIVATE-NOTES-SECRET",
            "currentHook": "Печать архивариуса", "visitedLocations": ["Склеп Норвин"] },
    })
}

#[test]
fn engine_transition_is_deterministic_and_public() {
    let first = transition(engine_scene_args(), engine_state());
    assert_eq!(first, transition(engine_scene_args(), engine_state()));
    assert_eq!(first["adventure"]["chapter"], 3);
    assert_eq!(first["adventure"]["history"].as_array().and_then(|history| history.last()).map(|entry| entry["location"].clone()), Some(json!("Склеп Норвин")));
    assert!(first["adventure"]["unresolvedThreads"].as_array().expect("нити").contains(&json!("Печать архивариуса")));
    let payload = js::stringify(&first);
    for marker in ["OLD-CELL-HIDDEN-SECRET", "OLD-CELL-SECRET", "ENGINE-GM-SECRET", "ENGINE-PRIVATE-NOTES-SECRET"] {
        assert!(!payload.contains(marker), "{marker} в переходе");
    }
    assert!(first.get("suggestions").is_none());
}

/// Повторный вход берёт карту места: другой теме и заявке её не перестроить.
#[test]
fn return_uses_remembered_location_map() {
    let mut cells: Vec<Value> = (0..13 * 9)
        .map(|index| json!({ "x": index % 13, "y": index / 13, "type": "floor", "revealed": index % 13 <= 2, "material": "stone", "variant": 0, "pattern": "small-room", "edge_mask": "" }))
        .collect();
    cells[4 * 13 + 4]["feature"] = json!("chest");
    let world = json!({ "seed": "w", "currentLocationId": "crypt", "locations": [{ "id": "crypt", "name": "Склеп Норвин", "kind": "ruin", "x": 1, "y": 1 }] });
    let state = json!({
        "sessionCode": "RETURN", "worldMap": world,
        "scene": { "title": "Город", "location": "Северный город", "location_id": "city", "turn": 9 },
        "locationMaps": { "crypt": { "version": 1, "cells": cells } },
        "adventure": { "chapter": 3 },
    });
    let input = js::spread(
        &engine_scene_args(),
        json!({ "title": "Возвращение в склеп", "location": "Другая подпись", "location_id": "crypt", "theme": "совсем другая геометрия", "map": { "layout": "open", "width": 25, "height": 19 } }),
    );
    let result = transition(input, state);
    assert_eq!(result["scene"]["location_id"], "crypt");
    assert_eq!(result["scene"]["location"], "Склеп Норвин");
    let scene_cells = result["scene"]["cells"].as_array().expect("клетки");
    assert_eq!(scene_cells.len(), 13 * 9);
    assert_eq!(scene_cells.iter().find(|cell| cell["x"] == 4 && cell["y"] == 4).map(|cell| cell["feature"].clone()), Some(json!("chest")));
    assert!(result["scene"].get("map_requirements").is_none(), "знакомое место не получает программу новой карты");
}

/// Запомненная карта с предметом на входе: точка входа — прежняя точка
/// появления; расстановку героев вокруг предмета делает движок.
#[test]
fn remembered_map_keeps_party_spawn() {
    let mut map = create_tactical_map(&TacticalMapOptions { width: 7, height: 7, location_id: "prop-scene", seed: "prop-scene", theme: "crypt", ..Default::default() }).expect("карта");
    for y in 0..7 {
        for x in 0..7 {
            set_cell(&mut map, x, y, &CellPatch { passable: Some(true), revealed: Some(true), material: Some("stone"), ..Default::default() }).expect("клетка");
        }
    }
    add_spawn_point(&mut map, &json!({ "id": "party-entrance", "x": 3, "y": 3, "role": "party" })).expect("вход");
    add_prop(&mut map, &json!({ "id": "blocking-sarcophagus", "assetId": "sarcophagus", "x": 3.5, "y": 2.5, "footprint": [{ "x": 3, "y": 2 }, { "x": 4, "y": 2 }], "blocksMove": true })).expect("саркофаг");
    let serialized = serialize_tactical_map(&map).expect("сериализация");
    let state = json!({
        "sessionCode": "SCENE-ENGINE",
        "worldMap": { "version": 1, "seed": "scene-engine", "name": "Сцены", "width": 100, "height": 100, "currentLocationId": "old", "regions": [],
            "locations": [{ "id": "prop-scene", "name": "Проповый зал", "kind": "dungeon", "x": 1, "y": 1, "regionId": "" }], "routes": [] },
        "locationMaps": { "prop-scene": { "version": 1, "cells": legacy_cells_from_tactical_map(&map), "map": serialized } },
        "scene": { "title": "Старый склеп", "location": "Склеп Норвин", "turn": 7 },
    });
    let result = transition(
        json!({ "title": "Проповый зал", "location": "Проповый зал", "location_id": "prop-scene", "mood": "Тесный зал", "objective": "Пройти дальше", "theme": "склеп", "scene_kind": "dungeon" }),
        state,
    );
    assert_eq!(result["entrance"], json!({ "x": 3, "y": 3 }));
    assert_eq!(result["scene"]["map"], serialized, "запомненная карта не меняется");
}

// --- test/director-three-scenes.test.mjs (модульная часть) ---------------------------

/// Офлайновый Режиссёр меняет сцену переходом с целью `continued`/`completed`:
/// глава растёт ровно на одну, прежняя сцена уходит в историю.
#[test]
fn offline_director_scene_advance_grows_one_chapter() {
    let cells: Vec<Value> = (0..117).map(|index| json!({ "x": index % 13, "y": index / 13, "type": "floor", "revealed": true })).collect();
    let state = json!({
        "sessionCode": "THREE-SCENES", "campaign": "Три сцены",
        "scene": { "title": "Глава 1", "location": "Старая дорога", "objective": "Идти по следу", "turn": 4, "cells": cells },
        "adventure": { "chapter": 1, "currentHook": "Идти по следу", "visitedLocations": ["Старая дорога"], "history": [] },
    });
    let result = transition(json!({ "title": "Перекрёсток", "location": "Перекрёсток у мельницы", "objective": "Найти мельника" }), state.clone());
    assert_eq!(result["adventure"]["chapter"], 2);
    assert_eq!(result["adventure"]["history"].as_array().map(Vec::len), Some(1));
    assert_eq!(result["adventure"]["history"][0]["outcome"], "Цель «Идти по следу» завершена.");
    let continued = transition(json!({ "title": "Мельница", "location": "Мельница", "objective_status": "continued" }), state);
    assert_eq!(continued["adventure"]["chapter"], 1, "continued — шаг той же главы");
    assert_eq!(continued["adventure"]["history"][0]["status"], "continued");
}

/// Выход наружу не ведёт через запертую дверь (прежде проверялось поле
/// `locked`, которого у двери нет, и запертая дверь годилась в выход).
#[test]
fn outside_entrance_skips_locked_door() {
    let house = |door_state: &str| {
        let mut map = create_tactical_map(&TacticalMapOptions { width: 6, height: 3, ..Default::default() }).expect("карта");
        sk_tactical::tactical_map::add_zone(&mut map, &json!({ "id": "hall", "kind": "interior" })).expect("зал");
        sk_tactical::tactical_map::add_zone(&mut map, &json!({ "id": "yard", "kind": "exterior" })).expect("двор");
        for y in 0..3 {
            for x in 0..6 {
                sk_tactical::tactical_map::set_cell_json(&mut map, x, y, &json!({ "passable": true, "revealed": true, "zone": if x < 3 { "hall" } else { "yard" } })).expect("клетка");
            }
        }
        sk_tactical::tactical_map::set_door(&mut map, &json!({ "id": "front", "x": 2, "y": 1, "dir": "e", "state": door_state })).expect("дверь");
        map
    };
    assert_eq!(outside_entrance_for(&house("closed"), 1.0, 1.0), Some((4, 1)));
    assert_eq!(outside_entrance_for(&house("locked"), 1.0, 1.0), None);
}
