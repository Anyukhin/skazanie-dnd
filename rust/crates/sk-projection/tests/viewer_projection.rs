//! Смысловые проверки сторожей `test/viewer-projection.test.mjs`,
//! `test/viewer-projection-api.test.mjs` (часть без HTTP) и
//! `test/combat-forecast-disclosure.test.mjs`, касающиеся функций модуля.
//! Прогноз удара проверяется полным путём: проекция зрителя и
//! `sk_tactics::combat_forecast_view::with_combat_forecast`, как `viewerStateFor`
//! в `server/index.mjs`. Карты строятся тем же JS, что в тесте-стороже: их входы
//! берутся из перехваченных вызовов эталона (`fixtures/p1.json.gz`).

#![recursion_limit = "512"]

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_projection::viewer_projection::*;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::replay::apply_game_event;
use sk_tactics::combat_forecast_view::with_combat_forecast;

fn user() -> Value {
    json!({ "role": "player", "heroIds": ["hero"] })
}

fn admin() -> Value {
    json!({ "role": "admin" })
}

fn room(state: &Value, user: &Value, actor: &str) -> Value {
    campaign_state_for_viewer(Some(state), Some(user), Some(&json!(actor))).expect("проекция").expect("комната")
}

fn events(list: &Value, user: &Value, actor: &str, state: Option<&Value>) -> Value {
    mechanics_for_viewer(Some(list), Some(user), Some(&json!(actor)), state).expect("события").expect("массив")
}

fn text(value: &Value) -> String {
    js::stringify(value)
}

fn private_state() -> Value {
    json!({
        "sessionCode": "VISIBLE", "partyMemberIds": ["hero"],
        "players": [{ "id": "hero", "character": "Лира", "inventory": [] }],
        "scene": {
            "title": "Архив", "location": "Норвин", "mood": "Тихо", "objective": "Найти печать", "turn": 2,
            "gm_only": { "boss": "дракон" }, "hidden_information": { "trap": "руна" },
            "cells": [
                { "x": 0, "y": 0, "type": "floor", "revealed": false, "feature": "enemy", "secret": "засада" },
                { "x": 1, "y": 0, "type": "floor", "revealed": true, "feature": "torch" },
            ],
        },
        "locationMaps": { "norvin": { "version": 1, "cells": [{ "x": 0, "y": 0, "type": "floor", "revealed": false, "feature": "hidden-map-secret" }] } },
        "adventure": {
            "chapter": 2, "currentHook": "Публичный след печати", "visitedLocations": ["Норвин"], "unresolvedThreads": ["Открыть печать"],
            "history": [{ "chapter": 1, "title": "Склеп", "location": "Склеп", "objective": "Выйти", "outcome": "Герои вышли", "gm_only": "предательство" }],
            "gm_only": { "villain": "канцлер" }, "hidden_information": { "trueDoor": "север" }, "private_notes": "не показывать",
        },
        "worldMap": {
            "version": 1, "seed": "visible-map", "name": "Известные земли", "width": 1000, "height": 640, "currentLocationId": "norvin",
            "regions": [
                { "id": "north", "name": "Север", "biome": "forest", "x": 100, "y": 100, "radius": 80 },
                { "id": "hidden-region", "name": "Тайная область", "biome": "void", "x": 800, "y": 500, "radius": 80 },
            ],
            "locations": [
                { "id": "norvin", "name": "Норвин", "kind": "city", "x": 100, "y": 100, "regionId": "north", "summary": "Текущий город", "known": true, "visited": true,
                  "cityOverview": { "version": 1, "name": "План Норвина", "summary": "Известные районы.", "image": "/assets/maps/city/skazanie/norvin-v1.webp", "width": 1000, "height": 640,
                    "districts": [{ "id": "market", "name": "Рынок", "x": 100, "y": 100, "bounds": { "x": 20, "y": 20, "width": 200, "height": 200 }, "summary": "Рыночный район", "secret": "городской секрет" }],
                    "places": [{ "id": "fountain", "name": "Фонтан", "kind": "civic", "districtId": "market", "x": 100, "y": 100, "summary": "Старый фонтан", "destinationLocationId": "forged" }],
                    "routes": [{ "from": "market", "to": "fountain" }] } },
                { "id": "secret-vault", "name": "Тайное хранилище", "kind": "dungeon", "x": 220, "y": 140, "regionId": "north", "summary": "Скрытая база канцлера", "known": false, "visited": false,
                  "cityOverview": { "name": "Секретный план", "summary": "Не показывать", "image": "/assets/maps/city/skazanie/secret-v1.webp", "districts": [], "places": [] } },
            ],
            "routes": [{ "id": "secret-road", "from": "norvin", "to": "secret-vault", "kind": "trail", "distance": 2, "danger": "high", "discovered": false }],
        },
        "merchants": [
            { "id": "here", "name": "Марта", "title": "Торговец", "location": "  НОРВИН ", "available": true,
              "stock": [{ "stock_id": "torch", "catalog_id": "srd_5_2_1:torch", "name": "Факел", "type": "gear", "quantity": 2, "base_price_cp": 1, "secret_supplier": "культ" }],
              "pricing": { "mode": "catalog", "agent_adjustment_bps": -500, "bargain_dc": 1 }, "bargains": { "hero": { "success": true } }, "secret": "контрабанда" },
            { "id": "far", "name": "Дальний", "location": "Лес", "available": true, "stock": [], "pricing": {} },
        ],
        "enemies": [{ "id": "goblin-secret", "name": "Гоблин-воин", "hp": 7, "maxHp": 11, "armor": 15, "speed": 30,
            "stat_block_id": "srd:secret-goblin", "creature_type": "humanoid", "image": "/assets/enemies/goblin.png", "attack_bonus": 4, "x": 3, "y": 2, "alive": true }],
        "mechanics": { "combat": { "active": true, "round": 1, "active_index": 1, "initiative": [
            { "actor_id": "hero", "roll": 12, "modifier": 2, "total": 14 },
            { "actor_id": "goblin-secret", "roll": 18, "modifier": 4, "total": 22 },
        ] } },
        "battleLog": [{ "id": "battle-secret", "type": "attack", "actorId": "hero", "actorKind": "player", "targetId": "goblin-secret", "damage": 4, "hpBefore": 11, "hpAfter": 7,
            "roll": { "die": 12, "modifier": 5, "total": 17, "difficulty": 15, "hit": true } }],
        "messages": [{ "id": "combat-secret", "speaker": "system", "author": "Система боя",
            "text": "Лира атакует Гоблин-воин: 17 против КД 15 — попадание. Гоблин-воин получает 4 урона; ОЗ 11 → 7." }],
    })
}

#[test]
fn quest_proofs_stay_out_of_player_events() {
    let list = json!([
        { "event_type": "QuestClockAdvanced", "visibility": "party", "payload": { "schema_version": 2, "quest_id": "quest", "amount": 1, "proof_fact_ids": ["SECRET-FACT"], "proof_source_event_ids": ["SECRET-EVENT"] } },
        { "event_type": "QuestUpserted", "visibility": "party", "payload": { "schema_version": 2, "quest": { "id": "quest", "title": "Припасы", "progress_fact_ids": ["SECRET-FACT"], "progress_source_event_ids": ["SECRET-EVENT"] } } },
    ]);
    let state = json!({ "partyMemberIds": ["hero"], "players": [{ "id": "hero" }], "scene": { "cells": [] } });
    let public = events(&list, &user(), "hero", Some(&state));
    assert_eq!(public.as_array().map(Vec::len), Some(2));
    assert!(!text(&public).contains("SECRET-"));
    assert_eq!(public[0]["payload"]["amount"], 1);
    assert!(text(&events(&list, &admin(), "hero", Some(&state))).contains("SECRET-FACT"));
}

#[test]
fn superseded_class_pools_are_removed_only_for_player() {
    let state = json!({
        "sessionCode": "RESOURCE-PROJECTION", "partyMemberIds": ["barbarian"],
        "players": [{ "id": "barbarian", "character": "Краг", "role": "Варвар · ур. 1", "characterClass": "barbarian", "level": 1,
            "abilities": { "str": 16, "dex": 12, "con": 16, "int": 10, "wis": 10, "cha": 10 }, "inventory": [] }],
        "scene": { "title": "Сцена", "location": "Место", "cells": [] },
        "mechanics": { "resources": { "barbarian": { "rage": { "current": 2, "max": 2 }, "feature_barbarian-yarost": { "current": 1, "max": 1 }, "custom_resource": { "current": 4, "max": 4 } } } },
    });
    let projected = room(&state, &json!({ "role": "player", "heroIds": ["barbarian"] }), "barbarian");
    assert_eq!(projected["mechanics"]["resources"]["barbarian"], json!({ "rage": { "current": 2, "max": 2 }, "custom_resource": { "current": 4, "max": 4 } }));
    let admin_view = room(&state, &admin(), "barbarian");
    assert_eq!(admin_view["mechanics"]["resources"]["barbarian"], state["mechanics"]["resources"]["barbarian"]);
}

fn placed_npc_state() -> Value {
    json!({
        "sessionCode": "NPC-PRESENT", "activePlayerId": "hero",
        "players": [{ "id": "hero", "character": "Лира", "hp": 10, "maxHp": 10, "x": 0, "y": 0, "inventory": [] }],
        "scene": { "title": "Трактир", "location": "Трактир", "location_id": "inn", "cells": [
            { "x": 0, "y": 0, "type": "floor", "revealed": true }, { "x": 1, "y": 0, "type": "floor", "revealed": true },
        ] },
        "social": { "npcs": [
            { "id": "brom", "name": "Бром", "location": "Трактир", "available": true, "visibility": "party" },
            { "id": "hidden", "name": "Тайный наблюдатель", "location": "Трактир", "available": true, "visibility": "gm_only" },
        ] },
        "npc_world": { "placements": [
            { "npc_id": "brom", "location_id": "inn", "x": 1, "y": 0 },
            { "npc_id": "hidden", "location_id": "inn", "x": 2, "y": 0 },
        ] },
    })
}

#[test]
fn admin_and_player_get_same_npc_tokens() {
    let state = placed_npc_state();
    let admin_view = room(&state, &admin(), "hero");
    let player_view = room(&state, &user(), "hero");
    let ids: Vec<&Value> = admin_view["scene_npcs"].as_array().into_iter().flatten().map(|npc| &npc["id"]).collect();
    assert_eq!(ids, [&json!("brom")]);
    assert_eq!(admin_view["scene_npcs"], player_view["scene_npcs"]);
    assert_eq!(admin_view["npc_world"], state["npc_world"]);
    assert!(player_view.get("npc_world").is_none());
    let response = turn_result_for_viewer(Some(&json!({ "authoritative_state": state, "mechanics": [], "debug": { "trace": "admin-only" } })), Some(&admin()), Some(&json!("hero")))
        .expect("итог")
        .expect("объект");
    assert_eq!(response["authoritative_state"]["scene_npcs"][0]["id"], "brom");
    assert_eq!(response["debug"], json!({ "trace": "admin-only" }));
}

#[test]
fn admin_sees_closed_shop_without_trade_with_dead_npc() {
    let mut state = placed_npc_state();
    state["merchants"] = json!([{ "id": "brom", "name": "Бром", "location": "Трактир", "available": true, "stock": [], "pricing": {} }]);
    state["npc_world"]["vitals"] = json!({ "brom": { "hp": 0, "max_hp": 4, "alive": false } });
    let projected = room(&state, &admin(), "hero");
    assert_eq!(projected["merchants"].as_array().map(Vec::len), Some(1));
    assert_eq!(projected["merchants"][0]["available"], true);
    assert_eq!(projected["merchants"][0]["can_trade"], false);
    assert!(state["merchants"][0].get("can_trade").is_none());
}

#[test]
fn player_projection_hides_private_memory_fog_and_merchant_internals() {
    let projected = room(&private_state(), &user(), "hero");
    let encoded = text(&projected);
    for marker in ["дракон", "засада", "предательство", "канцлер", "trueDoor", "контрабанда", "secret_supplier", "bargains", "agent_adjustment_bps"] {
        assert!(!encoded.contains(marker), "утекло {marker}");
    }
    assert!(projected.get("locationMaps").is_none());
    assert!(projected["scene"]["cells"][0].get("feature").is_none());
    assert_eq!(projected["scene"]["cells"][1]["feature"], "torch");
    assert_eq!(projected["merchants"].as_array().map(|list| list.iter().map(|merchant| merchant["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("here")]));
    assert_eq!(projected["adventure"]["currentHook"], "Публичный след печати");
    assert_eq!(projected["adventure"]["history"][0]["outcome"], "Герои вышли");
    assert_eq!(projected["worldMap"]["locations"].as_array().map(Vec::len), Some(1));
    let city = &projected["worldMap"]["locations"][0]["cityOverview"];
    assert_eq!(city["name"], "План Норвина");
    assert!(city["districts"][0].get("secret").is_none());
    assert!(city["places"][0].get("destinationLocationId").is_none());
    assert!(city.get("routes").is_none());
    assert_eq!(projected["worldMap"]["routes"], json!([]));
    assert!(projected["worldMap"].get("seed").is_none());
    assert_eq!(projected["worldMap"]["regions"][0]["id"], "north");
    for marker in ["Тайное хранилище", "Скрытая база канцлера", "secret-vault", "secret-road", "hidden-region", "Тайная область", "visible-map"] {
        assert!(!encoded.contains(marker), "утекло {marker}");
    }
    assert_eq!(
        projected["enemies"][0],
        json!({ "id": "goblin-secret", "name": "Гоблин-воин", "x": 3, "y": 2, "image": "/assets/enemies/goblin.png", "creature_type": "humanoid", "alive": true, "healthStatus": "wounded", "healthKnown": "banded" })
    );
    assert_eq!(projected["mechanics"]["combat"]["initiative"][1], json!({ "actor_id": "goblin-secret" }));
    let log = &projected["battleLog"][0];
    assert!(log.get("hpBefore").is_none() && log.get("hpAfter").is_none() && log["roll"].get("difficulty").is_none());
    let message = projected["messages"][0]["text"].as_str().unwrap_or("");
    assert!(!message.contains("КД 15") && !message.contains("ОЗ 11") && !message.contains("→ 7"), "{message}");
}

#[test]
fn enemy_image_is_repository_owned() {
    let common = json!({ "id": "enemy", "name": "Враг", "hp": 5, "maxHp": 5, "x": 1, "y": 2 });
    let image = |path: &str| {
        let mut enemy = common.clone();
        enemy["image"] = json!(path);
        public_enemy_for(Some(&enemy), None, None).expect("враг").get("image").cloned()
    };
    assert_eq!(image("/assets/enemies/wolf.png"), Some(json!("/assets/enemies/wolf.png")));
    assert_eq!(image("/assets/enemies/dnd-2014/troll.png"), Some(json!("/assets/enemies/dnd-2014/troll.png")));
    assert_eq!(image("/assets/npcs/astohan/astohan-sargat-v1.png"), Some(json!("/assets/npcs/astohan/astohan-sargat-v1.png")));
    for bad in ["https://tracker.invalid/pixel.png", "/assets/enemies/../party-portraits.png", "/assets/enemies/dnd-2014/../wolf.png", "/assets/enemies/dnd-2014/troll.png?tracking=1"] {
        assert_eq!(image(bad), None, "{bad}");
    }
}

#[test]
fn footprint_is_public_only_when_valid_and_fully_revealed() {
    let footprint = json!({ "version": 1, "size": 2, "cells": [{ "x": 9, "y": 9 }] });
    assert_eq!(public_actor_footprint_for(Some(&json!({ "footprint": footprint })), true), Some(json!({ "version": 1, "size": 2 })));
    assert_eq!(public_actor_footprint_for(Some(&json!({ "footprint": footprint, "masked": true })), true), None);
    assert_eq!(public_actor_footprint_for(Some(&json!({ "footprint": { "version": 2, "size": 4 } })), true), None);
    assert_eq!(public_actor_footprint_for(Some(&json!({ "footprint": { "version": 1, "size": 9 } })), true), None);
    let cells: Vec<Value> = (0..3).flat_map(|y| (0..11).map(move |x| json!({ "x": x, "y": y, "type": "floor", "revealed": true }))).collect();
    let mut source = json!({
        "sessionCode": "FOOTPRINT-PROJECTION", "partyMemberIds": ["hero"],
        "players": [{ "id": "hero", "character": "Лира", "hp": 10, "maxHp": 10, "x": 0, "y": 0, "inventory": [], "footprint": footprint }],
        "actors": [{ "id": "summon", "name": "Зверь", "ownerId": "hero", "controllerId": "hero", "faction": "party", "hp": 4, "maxHp": 4, "x": 3, "y": 0, "alive": true, "footprint": footprint }],
        "enemies": [
            { "id": "ogre", "name": "Огр", "hp": 68, "maxHp": 68, "x": 5, "y": 0, "alive": true, "footprint": footprint },
            { "id": "masked", "name": "Неизвестное существо", "hp": 68, "maxHp": 68, "x": 8, "y": 0, "alive": true, "masked": true, "footprint": footprint },
        ],
        "scene": { "title": "Поле", "location": "Поле", "cells": cells },
    });
    let projected = room(&source, &user(), "hero");
    assert_eq!(projected["players"][0]["footprint"], json!({ "version": 1, "size": 2 }));
    assert_eq!(projected["actors"][0]["footprint"], json!({ "version": 1, "size": 2 }));
    assert_eq!(projected["enemies"][0]["footprint"], json!({ "version": 1, "size": 2 }));
    assert!(projected["enemies"][1].get("footprint").is_none());
    assert!(!text(&projected).contains("\"cells\":[{\"x\":9"));
    if let Some(cell) = source["scene"]["cells"].as_array_mut().and_then(|cells| cells.iter_mut().find(|cell| cell["x"] == 6 && cell["y"] == 1)) {
        cell["revealed"] = json!(false);
    }
    let partial = room(&source, &user(), "hero");
    assert!(partial["enemies"][0].get("footprint").is_none(), "скрытый угол врага не раскрывает площадь");
    assert_eq!(partial["players"][0]["footprint"], json!({ "version": 1, "size": 2 }));
}

#[test]
fn current_location_survives_world_map_limit() {
    let mut authored = private_state();
    authored["scene"]["location_id"] = json!("norvin");
    assert_eq!(room(&authored, &user(), "hero")["scene"]["location_id"], "norvin");
    let mut long = private_state();
    let mut locations: Vec<Value> = (0..64)
        .map(|index| json!({ "id": format!("chronicle-{index}"), "name": format!("Место {index}"), "kind": "landmark", "x": index, "y": index, "regionId": "north", "summary": "Место.", "known": true, "visited": true }))
        .collect();
    locations.extend(long["worldMap"]["locations"].as_array().cloned().unwrap_or_default());
    long["worldMap"]["locations"] = Value::Array(locations);
    let far = room(&long, &user(), "hero");
    let ids: Vec<&Value> = far["worldMap"]["locations"].as_array().into_iter().flatten().map(|location| &location["id"]).collect();
    assert!(ids.contains(&&json!("norvin")));
    assert!(ids.len() <= 50);
    assert!(!text(&far["worldMap"]).contains("secret-vault") && !text(&far["worldMap"]).contains("hidden-region"));
}

#[test]
fn world_map_slice_without_current_and_with_current_beyond_limit() {
    let locations: Vec<Value> = (0..60).map(|index| json!({ "id": if index == 54 { String::new() } else { format!("loc-{index}") }, "name": format!("Место {index}"), "x": index, "y": index, "known": true })).collect();
    let projected = public_world_map_for(Some(&json!({ "locations": locations }))).expect("карта");
    assert_eq!(projected["currentLocationId"], "");
    let ids: Vec<String> = projected["locations"].as_array().into_iter().flatten().map(|location| js::s(location.get("id"))).collect();
    assert_eq!(ids, (0..50).map(|index| format!("loc-{index}")).collect::<Vec<_>>());
    let locations: Vec<Value> = (0..60).map(|index| json!({ "id": format!("loc-{index}"), "name": format!("Место {index}"), "x": index, "y": index, "known": true })).collect();
    let projected = public_world_map_for(Some(&json!({ "currentLocationId": "loc-55", "locations": locations, "routes": [
        { "id": "route-near", "from": "loc-0", "to": "loc-1", "kind": "road", "distance": 2 },
        { "id": "route-dropped", "from": "loc-48", "to": "loc-49", "kind": "road", "distance": 2 },
    ] })))
    .expect("карта");
    assert_eq!(projected["currentLocationId"], "loc-55");
    let list = projected["locations"].as_array().cloned().unwrap_or_default();
    assert_eq!(list.len(), 50);
    assert_eq!(list[49]["id"], "loc-55");
    assert!(!list.iter().any(|location| location["id"] == "loc-49"));
    assert_eq!(projected["routes"].as_array().map(|routes| routes.iter().map(|route| route["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("route-near")]));
}

#[test]
fn inventory_capabilities_and_admin_keeps_trusted_state() {
    let mut raw = private_state();
    raw["players"][0]["inventory"] = json!([
        { "id": "legacy-kit", "catalog_id": "srd_5_2_1:healers-kit", "name": "Старый набор лекаря", "type": "gear", "quantity": 1 },
        { "id": "legacy-weapon", "name": "Старый клинок", "type": "weapon", "quantity": 1, "combat": { "kind": "melee", "ability": "str", "damage": "1d6", "damageType": "slashing", "normalRange": 5 } },
        { "id": "homebrew-attunement", "name": "Домашний талисман", "type": "other", "quantity": 1, "requires_attunement": true },
    ]);
    let projected = room(&raw, &user(), "hero");
    let item = |id: &str| projected["players"][0]["inventory"].as_array().and_then(|items| items.iter().find(|item| item["id"] == id)).cloned().expect("вещь");
    assert_eq!(item("legacy-kit")["capabilities"]["charges"], json!({ "current": 10, "max": 10 }));
    assert_eq!(item("legacy-weapon")["capabilities"]["equip_slot"], "main_hand");
    assert_eq!(item("homebrew-attunement")["capabilities"]["requires_attunement"], true);
    assert!(raw["players"][0]["inventory"].as_array().into_iter().flatten().all(|item| item.get("capabilities").is_none()));
    let mut state = private_state();
    state["players"][0]["inventory"] = json!([{ "id": "ring", "catalog_id": "srd_5_2_1:ring-of-protection", "name": "Кольцо защиты", "type": "other", "quantity": 1 }]);
    let admin_view = room(&state, &admin(), "hero");
    assert_eq!(admin_view["adventure"], state["adventure"]);
    assert_eq!(admin_view["players"][0]["inventory"][0]["capabilities"]["requires_attunement"], true);
}

#[test]
fn enemy_facts_open_only_with_knowledge() {
    let mut state = private_state();
    let hidden = room(&state, &user(), "hero")["enemies"][0].clone();
    for key in ["hp", "maxHp", "armor", "speed", "stat_block_id"] {
        assert!(hidden.get(key).is_none(), "{key}");
    }
    state["mechanics"]["enemy_knowledge"] = json!({ "version": 1, "party": { "goblin-secret": { "health": "exact", "armor_class": "exact", "speed": "exact", "stat_block": "exact", "source_event_ids": ["fact-revealed"] } } });
    let projected = room(&state, &user(), "hero");
    let revealed = &projected["enemies"][0];
    assert_eq!((revealed["hp"].clone(), revealed["maxHp"].clone(), revealed["armor"].clone(), revealed["speed"].clone()), (json!(7), json!(11), json!(15), json!(30)));
    assert_eq!(revealed["healthKnown"], "exact");
    assert_eq!(revealed["stat_block_id"], "srd:secret-goblin");
    assert!(projected["mechanics"].get("enemy_knowledge").is_none());
}

#[test]
fn combat_events_hide_enemy_numbers_inventory_and_saves() {
    let state = private_state();
    let projected = events(
        &json!([
            { "event_type": "DamageApplied", "actor_id": "hero", "target_ids": ["goblin-secret"], "visibility": "public", "payload": { "target_id": "goblin-secret", "applied_amount": 4, "hp_before": 11, "hp_after": 7, "temporary_hp_before": 0, "temporary_hp_after": 0 } },
            { "event_type": "AttackResolved", "actor_id": "hero", "target_ids": ["goblin-secret"], "visibility": "public", "payload": { "target_id": "goblin-secret", "kept": 12, "modifier": 5, "total": 17, "armor_class": 15, "hit": true } },
            { "event_type": "CombatStarted", "actor_id": "hero", "target_ids": ["hero", "goblin-secret"], "visibility": "public", "payload": { "initiative": state["mechanics"]["combat"]["initiative"], "round": 1, "active_index": 1 } },
        ]),
        &user(),
        "hero",
        Some(&state),
    );
    assert_eq!(projected[0]["payload"], json!({ "target_id": "goblin-secret", "applied_amount": 4 }));
    assert!(projected[1]["payload"].get("armor_class").is_none());
    assert_eq!(projected[2]["payload"]["initiative"][1], json!({ "actor_id": "goblin-secret" }));

    let hidden = json!({ "effect_id": "hidden-effect", "item_id": "hidden-instance", "item_name": "Секретный предмет", "catalog_id": "srd_5_2_1:hidden-magic-item" });
    let mut rider = json!({ "target_id": "hero", "applied_amount": 7, "item_damage_rider": true });
    js::assign(&mut rider, hidden.clone());
    let raw = json!([
        { "event_type": "DamageApplied", "actor_id": "hero", "target_ids": ["goblin-secret"], "visibility": "public", "payload": { "target_id": "goblin-secret", "resistant": true, "applied_amount": 3, "item_resistance_sources": [hidden] } },
        { "event_type": "AttackResolved", "actor_id": "hero", "target_ids": ["goblin-secret"], "visibility": "public", "payload": { "target_id": "goblin-secret", "hit": true, "critical_prevented": true, "critical_protection_sources": [hidden] } },
        { "event_type": "DamageApplied", "actor_id": "goblin-secret", "target_ids": ["hero"], "visibility": "public", "payload": rider },
    ]);
    let projected = events(&raw, &user(), "hero", Some(&state));
    assert_eq!(projected[0]["payload"]["resistant"], true);
    assert!(projected[0]["payload"].get("item_resistance_sources").is_none());
    assert!(projected[1]["payload"].get("critical_protection_sources").is_none());
    assert_eq!(projected[2]["payload"]["item_damage_rider"], true);
    for marker in ["hidden-instance", "hidden-effect", "hidden-magic-item", "Секретный предмет"] {
        assert!(!text(&projected).contains(marker), "{marker}");
    }
    assert!(text(&events(&raw, &admin(), "hero", Some(&state))).contains("hidden-magic-item"));

    let save = json!({ "roll_id": "roll-1", "expression": "1d20+4", "dice": [9], "kept": 9, "mode": "normal", "modifier": 4, "total": 13, "purpose": "spell_save:sacred-flame:dex", "actor_id": "goblin-secret", "spell_id": "sacred-flame", "ability": "dex", "difficulty": 13, "saved": true });
    let saves = events(
        &json!([
            { "event_type": "SpellSavingThrowResolved", "actor_id": "hero", "target_ids": ["goblin-secret"], "visibility": "public", "payload": save },
            { "event_type": "ConcentrationSavingThrowResolved", "actor_id": "hero", "target_ids": ["goblin-secret"], "visibility": "public", "payload": save },
        ]),
        &user(),
        "hero",
        Some(&state),
    );
    for event in saves.as_array().into_iter().flatten() {
        for key in ["modifier", "kept", "dice", "expression", "roll_id"] {
            assert!(event["payload"].get(key).is_none(), "{key}");
        }
        assert_eq!((event["payload"]["total"].clone(), event["payload"]["saved"].clone()), (json!(13), json!(true)));
    }
}

#[test]
fn closed_npc_profile_event_keeps_event_but_drops_payload() {
    let raw = json!([{ "event_type": "NpcSocialProfileUpserted", "actor_id": "gm", "target_ids": [], "visibility": "party",
        "payload": { "npc": { "id": "npc-traitor", "name": "Тайный связной", "role": "предатель", "visibility": "gm_only", "goals": ["предать отряд"], "social_dcs": { "persuasion": 22 } } } }]);
    let state = private_state();
    let projected = events(&raw, &user(), "hero", Some(&state));
    assert_eq!(projected.as_array().map(Vec::len), Some(1));
    assert_eq!(projected[0]["payload"], json!({}));
    assert_eq!(events(&raw, &admin(), "hero", Some(&state))[0]["payload"]["npc"]["goals"][0], "предать отряд");
}

#[test]
fn battle_log_hides_enemy_save_modifier() {
    let mut state = private_state();
    state["battleLog"] = json!([
        { "id": "log-1", "type": "spell-save", "actorId": "hero", "actorKind": "player", "targetId": "goblin-secret", "spellId": "sacred-flame", "ability": "dex", "result": "success", "roll": { "die": 9, "modifier": 4, "total": 13, "difficulty": 13, "hit": true } },
        { "id": "log-2", "type": "attack", "actorId": "hero", "actorKind": "player", "targetId": "goblin-secret", "roll": { "die": 12, "modifier": 5, "total": 17, "difficulty": 15, "hit": true } },
        { "id": "log-3", "type": "attack", "actorId": "goblin-secret", "actorKind": "enemy", "targetId": "hero", "roll": { "die": 17, "modifier": 4, "total": 21, "difficulty": 16, "hit": true }, "rollMode": "advantage", "rollDice": [8, 17], "advantageReasons": ["тактика стаи"] },
    ]);
    let log = room(&state, &user(), "hero")["battleLog"].clone();
    assert_eq!(log[0]["roll"], json!({ "total": 13, "hit": true }));
    assert_eq!((log[1]["roll"]["modifier"].clone(), log[1]["roll"]["die"].clone()), (json!(5), json!(12)));
    assert!(log[1]["roll"].get("difficulty").is_none());
    assert!(log[2].get("rollDice").is_none());
    assert_eq!(log[2]["rollMode"], "advantage");
}

#[test]
fn scene_merchant_reward_and_hit_dice_events_are_sanitized() {
    let state = private_state();
    let projected = events(
        &json!([
            { "event_type": "SceneAdvanced", "visibility": "public", "payload": { "scene": state["scene"], "adventure": state["adventure"] } },
            { "event_type": "MerchantCreated", "visibility": "public", "payload": { "merchant": state["merchants"][0] } },
            { "event_type": "GmSecret", "visibility": "gm_only", "payload": { "secret": "никогда" } },
        ]),
        &user(),
        "hero",
        None,
    );
    assert_eq!(projected.as_array().map(|list| list.iter().map(|event| event["event_type"].clone()).collect::<Vec<_>>()), Some(vec![json!("SceneAdvanced"), json!("MerchantCreated")]));
    assert!(projected[0]["payload"]["scene"]["cells"][0].get("feature").is_none());
    assert!(projected[1]["payload"]["merchant"].get("bargains").is_none());
    for marker in ["никогда", "канцлер", "контрабанда"] {
        assert!(!text(&projected).contains(marker));
    }
    let reward = json!([
        { "event_type": "EncounterOutcomeRecorded", "visibility": "party", "payload": { "encounter_id": "e", "outcome": "enemies_defeated", "plan": { "enemies": [{ "stat_block_id": "srd:secret-goblin", "xp": 9999 }] }, "prepared_reward": { "secret_seed": "never-project" } } },
        { "event_type": "EncounterCoinsRolled", "visibility": "party", "payload": { "encounter_id": "e", "total_cp": 12, "rolls": [{ "roll_id": "coin-roll", "expression": "1d6", "dice": [3], "total": 3, "amount_cp": 12, "enemy_id": "goblin-secret", "stat_block_id": "srd:secret-goblin", "xp": 100 }] } },
    ]);
    let projected = events(&reward, &user(), "hero", Some(&state));
    assert!(projected[0]["payload"].get("plan").is_none() && projected[0]["payload"].get("prepared_reward").is_none());
    assert_eq!(projected[1]["payload"]["rolls"], json!([{ "roll_id": "coin-roll", "expression": "1d6", "dice": [3], "total": 3, "amount_cp": 12 }]));
    let dice = json!([
        { "event_type": "HitPointDieSpent", "actor_id": "fighter", "target_ids": ["fighter"], "visibility": "public", "payload": { "applied_healing": 7, "pool_before": { "spent": 1 }, "pool_after": { "spent": 2 } } },
        { "event_type": "HitPointDiceRestored", "actor_id": "fighter", "target_ids": ["fighter"], "visibility": "public", "payload": { "restored": 2, "pool_before": { "spent": 2 }, "pool_after": { "spent": 0 } } },
    ]);
    let other = events(&dice, &user(), "hero", Some(&state));
    assert_eq!(other[0]["payload"]["applied_healing"], 7);
    let explanation = turn_explanation_for_viewer(Some(&json!({ "events": dice })), Some(&user()), Some(&json!("hero")), Some(&state)).expect("разбор").expect("объект");
    for marker in ["pool_before", "pool_after", "restored"] {
        assert!(!text(&other).contains(marker) && !text(&explanation).contains(marker));
    }
    let owner = events(&dice, &json!({ "role": "player", "heroIds": ["fighter"] }), "fighter", Some(&state));
    assert_eq!((owner[0]["payload"]["pool_after"]["spent"].clone(), owner[1]["payload"]["restored"].clone()), (json!(2), json!(2)));
}

#[test]
fn turn_result_covers_every_public_surface() {
    let state = private_state();
    let projected = turn_result_for_viewer(
        Some(&json!({
            "authoritative_state": state,
            "mechanics": [{ "event_type": "SceneAdvanced", "payload": { "scene": state["scene"], "adventure": state["adventure"] } }],
            "effects": { "scene": { "scene": state["scene"], "adventure": state["adventure"], "transition": "Переход", "arrival": "Прибытие", "suggestions": [], "entrance": { "x": 1, "y": 1 } } },
        })),
        Some(&user()),
        Some(&json!("hero")),
    )
    .expect("итог")
    .expect("объект");
    let encoded = text(&projected);
    for marker in ["дракон", "канцлер", "засада", "hidden_information", "gm_only"] {
        assert!(!encoded.contains(marker), "{marker}");
    }
    assert!(projected["authoritative_state"]["scene"]["cells"][0].get("feature").is_none());
    assert!(projected["mechanics"][0]["payload"]["scene"]["cells"][0].get("feature").is_none());
    assert!(projected["effects"]["scene"]["scene"]["cells"][0].get("feature").is_none());
    let mut state = private_state();
    state["mechanics"]["combat"] = json!({ "active": true, "combat_instance_id": "combat-instance:secret", "action_economy": {} });
    assert!(room(&state, &user(), "hero")["mechanics"]["combat"].get("combat_instance_id").is_none());
}

/// Входы перехваченных вызовов теста JS по имени функции и теста.
fn captured(name: &str, test: &str) -> Vec<Vec<Option<Value>>> {
    static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
        let mut text = String::new();
        flate2::read::GzDecoder::new(&include_bytes!("../fixtures/p1.json.gz")[..]).read_to_string(&mut text).expect("эталон");
        serde_json::from_str(&text).expect("JSON")
    });
    FIXTURE["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["fn"] == name && entry["test"] == test)
        .map(|entry| {
            let mut list: Vec<Option<Value>> = entry["args"].as_array().cloned().unwrap_or_default().into_iter().map(Some).collect();
            for index in entry.get("undef").and_then(Value::as_array).into_iter().flatten() {
                if let Some(slot) = index.as_u64().and_then(|index| list.get_mut(index as usize)) {
                    *slot = None;
                }
            }
            list
        })
        .collect()
}

#[test]
fn map_projection_hides_unrevealed_part() {
    let calls = captured("publicSceneFor", "карта в проекции игрока не выдаёт нераскрытую часть");
    let args = calls.first().expect("вход теста JS");
    let projected = public_scene_for(args[0].as_ref(), args.get(1).and_then(Option::as_ref)).expect("сцена");
    let map = &projected["map"];
    assert_eq!(map["props"][0]["interaction"], json!({ "kind": "lore", "verbs": ["inspect"], "pointOfInterest": true }));
    assert_eq!(map["props"][0]["interactive"], true);
    assert!(!text(&projected).contains("secret-cache-under-table") && !text(&projected).contains("server-loot-table:rope"));
    let visible = sk_tactical::tactical_map::deserialize_tactical_map(map).expect("карта читается");
    let cell = |x, y| sk_tactical::tactical_map::cell_at(&visible, x, y).expect("клетка");
    assert_eq!((cell(1, 0).material, cell(1, 0).variant, cell(1, 0).move_cost, cell(1, 0).elevation), ("wood", 3, 2, 10));
    assert_eq!((cell(1, 2).material, cell(1, 2).variant, cell(1, 2).move_cost, cell(1, 2).elevation), ("stone", 0, 1, 0));
    assert_eq!(visible.props.iter().map(|prop| prop.asset_id.as_str()).collect::<Vec<_>>(), ["table"]);
    let edges: Vec<String> = sk_tactical::tactical_map::edge_list(&visible).iter().map(|edge| format!("{},{},{}", edge.x, edge.y, edge.dir.as_str())).collect();
    assert!(edges.contains(&"0,0,e".to_string()) && !edges.contains(&"0,2,e".to_string()));
    assert!(visible.doors.is_empty());
}

#[test]
fn map_projection_hides_zones_props_spawns_and_keys() {
    let calls = captured("publicTacticalMapWithHashFor", "проекция карты скрывает зоны, частичный реквизит, точки появления и ключи дверей");
    let args = calls.first().expect("вход теста JS");
    let first = public_tactical_map_with_hash_for(args[0].as_ref()).expect("карта").expect("проекция");
    let second = public_tactical_map_with_hash_for(args[0].as_ref()).expect("карта").expect("проекция");
    assert_eq!(first, second);
    let visible = sk_tactical::tactical_map::deserialize_tactical_map(&first["map"]).expect("карта читается");
    assert_eq!(visible.zones.iter().map(|zone| zone.id.as_str()).collect::<Vec<_>>(), ["hall"]);
    assert_eq!(visible.spawn_points.iter().map(|point| point.id.as_str()).collect::<Vec<_>>(), ["visible-party"]);
    assert_eq!(sk_tactical::tactical_map::cell_at(&visible, 0, 1).map(|cell| cell.zone), Some(""));
    assert_eq!(visible.props.iter().map(|prop| prop.id.as_str()).collect::<Vec<_>>(), ["visible-table"]);
    assert_eq!(visible.doors.iter().map(|door| door.to_json()).collect::<Vec<_>>(), vec![json!({ "id": "visible-door", "x": 2, "y": 0, "dir": "e", "state": "locked", "lockDc": 18, "keyItemId": null })]);
    assert!(sk_tactical::tactical_map::serialize_tactical_map(&visible).is_ok());
}

#[test]
fn barricade_material_is_private() {
    let calls = captured("publicTacticalMapFor", "проекция игрока скрывает материал баррикады, сохраняя публичную геометрию");
    let map = public_tactical_map_for(calls.first().expect("вход")[0].as_ref()).expect("карта").expect("проекция");
    assert_eq!(map["doors"][0]["barricade"], json!({ "side_x": 0, "side_y": 0 }));
    assert!(!text(&map).contains("private-plank-instance"));
    let raw = json!([{ "event_type": "DoorBarricaded", "actor_id": "hero", "visibility": "public", "payload": { "door_id": "barricaded-door", "material_item_id": "private-plank-instance", "previous_state": "open", "side_x": 0, "side_y": 0 } }]);
    let projected = events(&raw, &user(), "hero", None);
    assert!(projected[0]["payload"].get("material_item_id").is_none());
    assert_eq!(events(&raw, &admin(), "hero", None)[0]["payload"]["material_item_id"], "private-plank-instance");
}

#[test]
fn cells_and_map_hide_the_same() {
    let calls = captured("publicSceneFor", "массив клеток и карта скрывают одно и то же");
    let args = calls.first().expect("вход теста JS");
    let projected = public_scene_for(args[0].as_ref(), None).expect("сцена");
    let open = &projected["cells"][0];
    let hidden = &projected["cells"][1];
    assert_eq!((open["material"].clone(), open["variant"].clone(), open["pattern"].clone(), open["edge_mask"].clone()), (json!("wood"), json!(4), json!("small-room"), json!("e")));
    for key in ["material", "variant", "pattern", "edge_mask"] {
        assert!(hidden.get(key).is_none(), "{key}");
    }
    let visible = sk_tactical::tactical_map::deserialize_tactical_map(&projected["map"]).expect("карта");
    assert_eq!(sk_tactical::tactical_map::cell_at(&visible, 1, 0).map(|cell| (cell.material, cell.variant)), Some(("stone", 0)));
    let plain = public_scene_for(Some(&json!({ "title": "Без карты", "cells": [{ "x": 0, "y": 0, "type": "floor", "revealed": true }] })), None).expect("сцена");
    assert!(plain.get("map").is_none());
}

/// Часть `test/viewer-projection-api.test.mjs` без HTTP: комната игрока не
/// выдаёт закрытое ведущего, а каталог не переписывает историю вещи.
#[test]
fn room_for_player_hides_private_world_memory() {
    let marker = "GM_PRIVATE_DRAGON_COUNCIL";
    let state = json!({
        "sessionCode": "VIEWER-API", "campaign": "Visibility", "partyMemberIds": ["hero"], "activePlayerId": "hero",
        "isNarrating": false, "pendingCheck": null, "suggestions": [], "messages": [], "enemies": [], "entities": [], "economyLog": [],
        "players": [{ "id": "hero", "character": "Лира", "hp": 18, "maxHp": 18, "armor": 14, "abilities": { "cha": 14 },
            "inventory": [{ "id": "keepsake", "catalog_id": "srd_5_2_1:torch", "name": "Факел деда", "description": "Подарок перед дорогой.", "type": "tool", "quantity": 1 }], "currency": { "gold": 20 }, "online": true }],
        "scene": { "title": "Склеп", "location": "Склеп", "mood": "Тихо", "objective": "Выйти", "turn": 1,
            "cells": [{ "x": 0, "y": 0, "type": "floor", "revealed": false, "feature": "enemy", "secret": marker }], "hidden_information": { "ambush": marker } },
        "adventure": { "chapter": 1, "currentHook": "Публичная печать", "history": [], "visitedLocations": ["Склеп"], "gm_only": { "villain": marker }, "hidden_information": { "route": marker } },
        "merchants": [{ "id": "old-shop", "name": "Скрытая лавка", "location": "Склеп", "available": true,
            "stock": [{ "stock_id": "torch", "catalog_id": "srd_5_2_1:torch", "name": "Факел", "type": "gear", "quantity": 1, "secret_supplier": marker }],
            "pricing": { "mode": "catalog", "agent_adjustment_bps": -500, "bargain_dc": 1 }, "bargains": { "hero": { "success": true } }, "secret": marker }],
    });
    let player = room(&state, &json!({ "role": "player", "heroIds": ["hero"] }), "hero");
    assert!(!text(&player).contains(marker));
    assert!(player["scene"]["cells"][0].get("feature").is_none());
    assert!(player["merchants"][0].get("bargains").is_none());
    assert!(player["merchants"][0]["pricing"].get("agent_adjustment_bps").is_none());
    let keepsake = &player["players"][0]["inventory"][0];
    assert_eq!(keepsake["description"], "Подарок перед дорогой.");
    assert!(keepsake["capabilities"]["catalog_description"].is_string());
    assert_eq!(room(&state, &admin(), "hero")["adventure"]["gm_only"]["villain"], marker);
}

// --- прогноз удара полным путём (`test/combat-forecast-disclosure.test.mjs`) -----------

fn forecast_fixture(armor: i64, knowledge: Value) -> Value {
    normalize_campaign_state(&json!({
        "partyMemberIds": ["hero", "ally"],
        "players": [
            { "id": "hero", "character": "Герой", "hp": 12, "maxHp": 12, "armor": 14, "proficiency": 2,
              "abilities": { "str": 16, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 8 }, "x": 0, "y": 0,
              "inventory": [{ "id": "sword", "name": "Длинный меч", "type": "weapon", "quantity": 1, "equipped": true,
                "combat": { "kind": "melee", "ability": "str", "damage": "1d8", "damageType": "slashing", "normalRange": 5 } }] },
            { "id": "ally", "character": "Союзник", "hp": 12, "maxHp": 12, "armor": 14, "proficiency": 2,
              "abilities": { "str": 10, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 8 }, "x": 0, "y": 1, "inventory": [] },
        ],
        "enemies": [{ "id": "goblin", "name": "Гоблин", "hp": 10, "maxHp": 10, "armor": armor, "alive": true, "x": 1, "y": 0 }],
        "scene": { "turn": 1, "cells": [
            { "x": 0, "y": 0, "type": "floor", "revealed": true }, { "x": 1, "y": 0, "type": "floor", "revealed": true }, { "x": 0, "y": 1, "type": "floor", "revealed": true },
        ] },
        "mechanics": { "enemy_knowledge": knowledge, "combat": { "active": true, "round": 1, "active_index": 0,
            "initiative": [{ "actor_id": "hero" }, { "actor_id": "goblin" }], "action_economy": { "hero": { "action": true } } } },
    }))
    .expect("нормализация")
}

fn paralyze(state: &Value) -> Value {
    apply_game_event(state, &json!({ "event_id": "condition:goblin:paralyzed", "event_type": "ConditionAdded", "actor_id": "ally", "target_ids": ["goblin"], "payload": { "condition": "paralyzed", "source_actor": "ally" } }))
        .expect("паралич")
}

/// `viewerStateFor` (`server/index.mjs`): проекция зрителя и прогноз удара.
fn viewer_state(state: &Value, user: &Value, actor: &str) -> Value {
    let projected = campaign_state_for_viewer(Some(state), Some(user), Some(&json!(actor))).expect("проекция");
    with_combat_forecast(projected.as_ref(), Some(state), Some(&json!(actor))).expect("прогноз").expect("комната")
}

fn hero_view(state: &Value, actor: &str) -> Value {
    viewer_state(state, &json!({ "role": "player", "id": actor }), actor)
}

fn sword(view: &Value) -> Value {
    view["combatForecast"]["targets"]["goblin"].as_array().into_iter().flatten().find(|entry| entry["item_id"] == "sword").cloned().expect("удар мечом")
}

#[test]
fn hidden_armor_does_not_change_forecast() {
    let low = forecast_fixture(13, json!({}));
    let high = forecast_fixture(18, json!({}));
    for actor in ["hero", "ally"] {
        assert_eq!(hero_view(&low, actor), hero_view(&high, actor), "зритель {actor}");
    }
    let shot = sword(&hero_view(&high, "hero"));
    assert_eq!((shot["armor_class"].clone(), shot["hit_chance"].clone(), shot["armor_known"].clone()), (Value::Null, Value::Null, json!(false)));
    assert_eq!(shot["critical_chance"], 5);
    assert_eq!((shot["in_range"].clone(), shot["distance_feet"].clone(), shot["attack_modifier"].clone(), shot["average_damage"].clone()), (json!(true), json!(5), json!(5), json!(8)));
}

#[test]
fn known_health_does_not_open_armor() {
    let state = forecast_fixture(18, json!({ "party": { "goblin": { "health": "exact" } } }));
    let view = hero_view(&state, "hero");
    assert_eq!(view["enemies"][0]["healthKnown"], "exact");
    assert!(view["enemies"][0].get("armor").is_none());
    let shot = sword(&view);
    assert_eq!((shot["armor_class"].clone(), shot["hit_chance"].clone()), (Value::Null, Value::Null));
}

#[test]
fn known_armor_opens_armor_and_hit_chance() {
    let known = json!({ "party": { "goblin": { "armor_class": "exact" } } });
    let low = forecast_fixture(13, known.clone());
    let high = forecast_fixture(18, known);
    for actor in ["hero", "ally"] {
        assert_eq!(hero_view(&high, actor)["enemies"][0]["armor"], 18);
        let shot = sword(&hero_view(&low, actor));
        assert_eq!((shot["armor_class"].clone(), shot["hit_chance"].clone(), shot["armor_known"].clone()), (json!(13), json!(65), json!(true)));
        let shot = sword(&hero_view(&high, actor));
        assert_eq!((shot["armor_class"].clone(), shot["hit_chance"].clone()), (json!(18), json!(40)));
    }
}

#[test]
fn guaranteed_crit_hides_crit_chance_with_hidden_armor() {
    let low = paralyze(&forecast_fixture(13, json!({})));
    let high = paralyze(&forecast_fixture(18, json!({})));
    assert_eq!(hero_view(&low, "hero"), hero_view(&high, "hero"));
    let shot = sword(&hero_view(&high, "hero"));
    assert_eq!((shot["critical_on_hit"].clone(), shot["hit_chance"].clone(), shot["critical_chance"].clone(), shot["advantage"].clone()), (json!(true), Value::Null, Value::Null, json!(true)));
    let known = paralyze(&forecast_fixture(18, json!({ "party": { "goblin": { "armor_class": "exact" } } })));
    let open = sword(&hero_view(&known, "hero"));
    assert_eq!(open["critical_chance"], open["hit_chance"]);
    assert!(open["hit_chance"].as_f64().unwrap_or(0.0) > 40.0);
}

#[test]
fn no_forecast_outside_combat_or_on_other_turn() {
    let state = forecast_fixture(13, json!({}));
    let mut idle = state.clone();
    idle["mechanics"]["combat"]["active"] = json!(false);
    assert!(hero_view(&idle, "hero").get("combatForecast").is_none());
    let mut goblin_turn = state;
    goblin_turn["mechanics"]["combat"]["active_index"] = json!(1);
    assert!(hero_view(&goblin_turn, "hero").get("combatForecast").is_none());
}

#[test]
fn game_master_sees_armor_and_hit_chance() {
    let state = forecast_fixture(18, json!({}));
    let view = viewer_state(&state, &json!({ "role": "admin", "id": "gm" }), "");
    let shot = sword(&view);
    assert_eq!((shot["armor_class"].clone(), shot["hit_chance"].clone(), shot["armor_known"].clone()), (json!(18), json!(40), json!(true)));
}

#[test]
fn projected_state_keys_match_js_list() {
    assert_eq!(PROJECTED_STATE_KEYS.len(), 63);
    assert!(PROJECTED_STATE_KEYS.iter().all(|key| !key.is_empty()));
    assert_eq!(REACTION_DAMAGE_PUBLIC_KEYS.len(), 12);
    assert_eq!(REACTION_DAMAGE_COMPONENT_PUBLIC_KEYS, ["damage_type", "raw_amount", "applied_amount", "temporary_hp_absorbed", "source"]);
}
