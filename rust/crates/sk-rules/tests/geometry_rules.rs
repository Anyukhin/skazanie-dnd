//! Перенесённые проверки JS про геометрию движка (задача Р1): то, что в
//! `test/*.test.mjs` проверяет сами функции геометрии, а не HTTP или клиент.
//!
//! - `test/line-of-fire.test.mjs` — концы линии огня по раскрытым клеткам;
//! - `test/prop-cover.test.mjs` — укрытие от предметов карты;
//! - `test/line-of-effect-transparency.test.mjs` — правило прозрачности, луч
//!   и стена на рёбрах, вода против стены во всех путях области и атаки,
//!   разведка шагом;
//! - `test/circular-spell-targeting.test.mjs` — круговая область 2014;
//! - `test/spell-cube-geometry.test.mjs` — куб от точки и от заклинателя;
//! - `test/actor-footprint.test.mjs` — путь, дистанция и область крупного
//!   существа, внутреннее ребро площади;
//! - `test/web-walker.test.mjs` — цена шага паука по паутине.
//!
//! В JS состояния проходят `normalizeCampaignState` (задача Р4); здесь они
//! собраны сразу в той форме, которую геометрия читает после нормализации:
//! клетки сцены — производная карты, позиции — поля участников.

use serde_json::{json, Value};
use sk_combat_content::combat_spells::canonical_combat_spell_for;
use sk_geometry::Point;
use sk_rules::areas::shape as area;
use sk_rules::geometry::terrain;
use sk_rules::tactical_geometry::{self as geo, PathOptions};
use sk_tactical::tactical_map::{self as tmap, CellPatch, EdgePatch, TacticalMap, TacticalMapOptions};

fn open_map(width: i64, height: i64) -> TacticalMap {
    tmap::create_tactical_map(&TacticalMapOptions {
        width,
        height,
        location_id: "rules-test",
        fill: Some(CellPatch { passable: Some(true), revealed: Some(true), material: Some("stone"), ..CellPatch::default() }),
        ..TacticalMapOptions::default()
    })
    .expect("карта")
}

fn wall_cell(map: &mut TacticalMap, x: i64, y: i64, surface: &str) {
    tmap::set_cell(map, x, y, &CellPatch { passable: Some(false), surface: Some(surface), ..CellPatch::default() }).expect("клетка");
}

/// Состояние со сценой из карты (клетки — её производная) и участниками.
fn field(map: &TacticalMap, players: Value, enemies: Value, ruleset: &str) -> Value {
    json!({
        "ruleset_id": ruleset,
        "players": players,
        "enemies": enemies,
        "actors": [],
        "scene": { "turn": 1, "map": tmap::serialize_tactical_map(map).expect("сериализация"), "cells": tmap::legacy_cells_from_tactical_map(map) },
        "mechanics": { "conditions": {}, "active_effects": [], "combat": { "active": true, "round": 1, "active_index": 0, "action_economy": {} } },
    })
}

/// Сцена только из старых клеток (без карты).
fn cells_field(width: i64, height: i64, players: Value, enemies: Value) -> Value {
    let cells: Vec<Value> = (0..width * height).map(|index| json!({ "x": index % width, "y": index / width, "type": "floor", "revealed": true })).collect();
    json!({
        "ruleset_id": "srd_5_2_1",
        "players": players,
        "enemies": enemies,
        "actors": [],
        "scene": { "turn": 1, "cells": cells },
        "mechanics": { "conditions": {}, "active_effects": [], "combat": { "active": true, "round": 1, "active_index": 0, "action_economy": {} } },
    })
}

fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}

fn ids(actors: &[Value]) -> Vec<String> {
    actors.iter().map(|actor| actor["id"].as_str().unwrap_or_default().to_string()).collect()
}

fn spell(id: &str, ruleset: &str) -> Value {
    canonical_combat_spell_for(Some(&json!(id)), Some(&json!({ "rulesetId": ruleset }))).expect("заклинание каталога")
}

fn key(point: Point) -> String {
    geo::position_key(point)
}

// --- test/line-of-fire.test.mjs ---------------------------------------------

fn fire_scene(hidden: &[(i64, i64)], pillar: Option<(i64, i64)>) -> Value {
    let cells: Vec<Value> = (0..50)
        .map(|index| {
            let (x, y) = (index % 10, index / 10);
            let mut cell = json!({ "x": x, "y": y, "type": "floor", "revealed": !hidden.contains(&(x, y)) });
            if pillar == Some((x, y)) {
                cell["feature"] = json!("pillar");
            }
            cell
        })
        .collect();
    json!({
        "players": [{ "id": "archer", "hp": 10, "maxHp": 10, "x": 1, "y": 2 }],
        "enemies": [{ "id": "ogre", "hp": 30, "maxHp": 30, "size": "large", "footprint": { "version": 1, "size": 2 }, "x": 6, "y": 2, "alive": true }],
        "scene": { "turn": 1, "cells": cells },
        "mechanics": { "combat": { "active": false, "action_economy": {} } },
    })
}

fn server_ends(state: &Value) -> (Vec<String>, Vec<String>, bool) {
    let pairs = geo::actor_trajectory_details(state, "archer", "ogre", geo::actor_point(state, "archer"), geo::actor_point(state, "ogre"), false);
    let mut starts: Vec<String> = pairs.iter().map(|pair| key(pair.start)).collect();
    let mut ends: Vec<String> = pairs.iter().map(|pair| key(pair.end)).collect();
    starts.sort();
    starts.dedup();
    ends.sort();
    ends.dedup();
    (starts, ends, pairs.iter().any(|pair| !pair.blocked))
}

#[test]
fn line_of_fire_uses_all_revealed_footprint_cells() {
    let (_, ends, open) = server_ends(&fire_scene(&[], None));
    assert_eq!(ends.len(), 4);
    assert!(open);
}

#[test]
fn shooter_in_fog_has_no_line_of_fire() {
    let (starts, _, open) = server_ends(&fire_scene(&[(1, 2)], None));
    assert!(!open, "сервер отказал бы TRAJECTORY_BLOCKED");
    assert!(starts.is_empty());
}

#[test]
fn half_hidden_large_target_is_aimed_at_revealed_half() {
    let (_, ends, _) = server_ends(&fire_scene(&[(7, 2), (7, 3)], None));
    assert_eq!(ends, vec!["6,2", "6,3"]);
}

#[test]
fn pillar_on_the_line_gives_cover_but_does_not_block() {
    let state = fire_scene(&[], Some((4, 2)));
    assert!(server_ends(&state).2);
}

// --- test/prop-cover.test.mjs -----------------------------------------------

fn arena(props: &[Value]) -> Value {
    let mut map = tmap::create_tactical_map(&TacticalMapOptions {
        width: 10,
        height: 5,
        fill: Some(CellPatch { passable: Some(true), revealed: Some(true), material: Some("grass"), ..CellPatch::default() }),
        ..TacticalMapOptions::default()
    })
    .expect("карта");
    for prop in props {
        tmap::add_prop(&mut map, prop).expect("предмет");
    }
    field(&map, json!([{ "id": "hero", "hp": 20, "maxHp": 20, "x": 0, "y": 2 }]), json!([{ "id": "enemy", "hp": 20, "maxHp": 20, "alive": true, "x": 8, "y": 2 }]), "srd_5_2_1")
}

fn cover_level(state: &Value) -> Value {
    geo::cover_between(state, "hero", "enemy", Some(p(0.0, 2.0)), Some(p(8.0, 2.0)))
}

#[test]
fn oak_on_the_line_gives_three_quarters_cover_by_all_its_cells() {
    let oak = json!({ "id": "oak", "assetId": "tree_oak", "x": 5, "y": 2, "footprint": [{ "x": 4, "y": 1 }, { "x": 5, "y": 1 }, { "x": 4, "y": 2 }, { "x": 5, "y": 2 }], "blocksMove": true, "cover": "three_quarters" });
    let cover = cover_level(&arena(&[oak]));
    assert_eq!(cover["level"], "three-quarters");
    assert_eq!(cover["armorClassBonus"], 5);
    assert_eq!(cover["scenery"], json!(["tree_oak"]));
}

#[test]
fn log_gives_half_cover_and_flowers_none() {
    let log = json!({ "id": "log", "assetId": "rotten_log", "x": 4.5, "y": 2.5, "footprint": [{ "x": 4, "y": 2 }], "blocksMove": true, "cover": "half" });
    assert_eq!(cover_level(&arena(&[log]))["level"], "half");
    let flowers = json!({ "id": "flowers", "assetId": "flowers", "x": 4.5, "y": 2.5, "footprint": [{ "x": 4, "y": 2 }], "cover": "none" });
    assert_eq!(cover_level(&arena(&[flowers]))["level"], "none");
    let aside = json!({ "id": "oak", "assetId": "tree_oak", "x": 5, "y": 0, "footprint": [{ "x": 4, "y": 0 }, { "x": 5, "y": 0 }], "blocksMove": true, "cover": "three_quarters" });
    assert_eq!(cover_level(&arena(&[aside]))["level"], "none");
}

// --- test/line-of-effect-transparency.test.mjs ------------------------------

fn loe_field(map: &TacticalMap, enemies: Value, mage: (i64, i64)) -> Value {
    field(map, json!([{ "id": "mage", "characterClass": "wizard", "level": 9, "hp": 40, "maxHp": 40, "x": mage.0, "y": mage.1 }]), enemies, "srd_5_2_1")
}

fn bolt(to: (i64, i64)) -> Value {
    json!({ "command_type": "CastSpell", "actor_id": "mage", "spell_id": "lightning-bolt", "to": { "x": to.0, "y": to.1 } })
}

fn enemy(id: &str, x: i64, y: i64) -> Value {
    json!({ "id": id, "name": id, "hp": 200, "maxHp": 200, "alive": true, "x": x, "y": y })
}

#[test]
fn transparency_rule_is_one_for_cells_and_edges() {
    assert!(geo::is_transparent_cell(Some(&json!({ "type": "floor" }))));
    assert!(geo::is_transparent_cell(Some(&json!({ "type": "door" }))));
    assert!(geo::is_transparent_cell(Some(&json!({ "type": "water" }))));
    assert!(!geo::is_transparent_cell(Some(&json!({ "type": "wall" }))));
    assert!(!geo::is_transparent_cell(None));
    let mut map = open_map(12, 5);
    tmap::set_door(&mut map, &json!({ "id": "door", "x": 2, "y": 2, "dir": "e", "state": "closed", "blocksMove": true, "blocksSight": false })).expect("дверь");
    let open = geo::map_cell_at(&map, 0.0, 0.0);
    assert!(geo::is_transparent_map_cell(open.as_ref()));
    wall_cell(&mut map, 0, 0, "water");
    assert!(geo::is_transparent_map_cell(geo::map_cell_at(&map, 0.0, 0.0).as_ref()), "вода прозрачна");
    wall_cell(&mut map, 0, 0, "none");
    assert!(!geo::is_transparent_map_cell(geo::map_cell_at(&map, 0.0, 0.0).as_ref()), "стена непрозрачна");
    assert!(!geo::is_transparent_map_cell(None));
    assert!(geo::sight_edge_blocked(Some(&map), p(2.0, 2.0), p(3.0, 2.0)), "закрытая дверь");
    assert!(!geo::sight_edge_blocked(Some(&map), p(2.0, 1.0), p(3.0, 2.0)), "диагональ мимо двери");
    assert!(geo::sight_edge_blocked(Some(&map), p(2.0, 2.0), p(3.0, 3.0)), "диагональ задевает кромку двери");
    assert!(!geo::sight_edge_blocked(None, p(2.0, 2.0), p(3.0, 2.0)), "без карты рёбер нет");
}

#[test]
fn lightning_bolt_stops_at_a_closed_door_and_passes_an_open_one() {
    let lightning = spell("lightning-bolt", "srd_5_2_1");
    let mut closed = open_map(12, 5);
    tmap::set_door(&mut closed, &json!({ "id": "door-5-1", "x": 5, "y": 1, "dir": "e", "state": "closed", "blocksMove": true, "blocksSight": false })).expect("дверь");
    let state = loe_field(&closed, json!([enemy("near", 4, 1), enemy("brute", 9, 1)]), (1, 1));
    assert_eq!(ids(&area::spell_targets_at(&state, &bolt((3, 1)), &lightning)), vec!["near"]);
    let mut open = open_map(12, 5);
    tmap::set_door(&mut open, &json!({ "id": "door-5-1", "x": 5, "y": 1, "dir": "e", "state": "open", "blocksMove": false, "blocksSight": false })).expect("дверь");
    let state = loe_field(&open, json!([enemy("near", 4, 1), enemy("brute", 9, 1)]), (1, 1));
    let mut hit = ids(&area::spell_targets_at(&state, &bolt((3, 1)), &lightning));
    hit.sort();
    assert_eq!(hit, vec!["brute", "near"]);
}

#[test]
fn lightning_bolt_does_not_pass_a_thin_wall() {
    let mut map = open_map(12, 5);
    tmap::set_edge(&mut map, 5, 1, 6, 1, &EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), ..EdgePatch::default() }).expect("ребро");
    let state = loe_field(&map, json!([enemy("brute", 9, 1)]), (1, 1));
    assert!(area::spell_targets_at(&state, &bolt((3, 1)), &spell("lightning-bolt", "srd_5_2_1")).is_empty());
}

#[test]
fn wall_of_fire_does_not_cross_a_thin_wall() {
    let wall = spell("wall-of-fire", "srd_5_2_1");
    let command = json!({ "actor_id": "mage", "spell_id": "wall-of-fire", "to": { "x": 5, "y": 2 } });
    let mut map = open_map(12, 5);
    tmap::set_edge(&mut map, 5, 1, 5, 2, &EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), ..EdgePatch::default() }).expect("ребро");
    let state = loe_field(&map, json!([]), (1, 2));
    let cells: Vec<String> = area::wall_cells(&state, &command, &wall).into_iter().map(key).collect();
    assert_eq!(cells, vec!["5,2", "5,3", "5,4"]);
    let free = loe_field(&open_map(12, 5), json!([]), (1, 2));
    let rows: Vec<f64> = area::wall_cells(&free, &command, &wall).into_iter().map(|cell| cell.y).collect();
    assert_eq!(rows, vec![0.0, 1.0, 2.0, 3.0, 4.0], "без перегородки стена — весь столбец");
}

#[test]
fn lightning_bolt_flies_over_water_and_stops_at_a_wall_cell() {
    let lightning = spell("lightning-bolt", "srd_5_2_1");
    let mut water = open_map(12, 5);
    wall_cell(&mut water, 5, 1, "water");
    let state = loe_field(&water, json!([enemy("brute", 9, 1)]), (1, 1));
    assert_eq!(state["scene"]["cells"].as_array().unwrap().iter().find(|cell| cell["x"] == 5 && cell["y"] == 1).unwrap()["type"], "water");
    assert_eq!(ids(&area::spell_targets_at(&state, &bolt((3, 1)), &lightning)), vec!["brute"]);
    let mut wall = open_map(12, 5);
    wall_cell(&mut wall, 5, 1, "none");
    let state = loe_field(&wall, json!([enemy("brute", 9, 1)]), (1, 1));
    assert!(area::spell_targets_at(&state, &bolt((3, 1)), &lightning).is_empty());
}

fn river_field(surface: &str) -> Value {
    let mut map = open_map(22, 22);
    for y in 0..22 {
        wall_cell(&mut map, 12, y, surface);
    }
    field(
        &map,
        json!([{ "id": "mage", "characterClass": "wizard", "level": 5, "hp": 30, "maxHp": 30, "x": 1, "y": 10 }]),
        json!([{ "id": "shore", "name": "На том берегу", "hp": 20, "maxHp": 20, "x": 13, "y": 10, "alive": true }]),
        "dnd_5e_2014",
    )
}

#[test]
fn area_and_attack_paths_agree_river_is_clear_wall_blocks() {
    let fireball = spell("fireball", "dnd_5e_2014");
    let command = json!({ "command_type": "CastSpell", "actor_id": "mage", "spell_id": "fireball", "to": { "x": 10, "y": 10 }, "slot_level": 3 });
    let mut variants = vec![("circle-grid-v2, обход углов", fireball.clone())];
    let mut straight = fireball.clone();
    straight["spreadsAroundCorners"] = json!(false);
    variants.push(("circle-grid-v2, прямая", straight.clone()));
    let mut legacy = fireball.clone();
    legacy.as_object_mut().unwrap().shift_remove("areaGeometryVersion");
    variants.push(("старая сетка, обход углов", legacy.clone()));
    legacy["spreadsAroundCorners"] = json!(false);
    variants.push(("старая сетка, прямая", legacy));
    let river = river_field("water");
    let wall = river_field("none");
    for (label, spell) in &variants {
        assert_eq!(ids(&area::spell_targets_at(&river, &command, spell)), vec!["shore"], "{label}: вода прозрачна");
        assert!(area::spell_targets_at(&wall, &command, spell).is_empty(), "{label}: стена заслоняет");
    }
    assert!(geo::has_clear_trajectory(&river, p(10.0, 10.0), p(13.0, 10.0)), "выстрел через реку");
    assert!(!geo::has_clear_trajectory(&wall, p(10.0, 10.0), p(13.0, 10.0)), "выстрел сквозь стену");
}

#[test]
fn scouting_step_sees_across_water_but_not_through_a_wall() {
    let build = |surface: &str| {
        let mut map = open_map(16, 3);
        for y in 0..3 {
            wall_cell(&mut map, 6, y, surface);
        }
        map
    };
    let seen = |map: &TacticalMap| -> Vec<String> { geo::cells_visible_from(map, p(4.0, 1.0), geo::MOVEMENT_SIGHT_CELLS, None).into_iter().map(|cell| cell.key()).collect() };
    let across_water = seen(&build("water"));
    assert!(across_water.contains(&"6,1".to_string()), "саму воду видно");
    assert!(across_water.contains(&"7,1".to_string()), "берег за водой виден");
    let behind_wall = seen(&build("none"));
    assert!(behind_wall.contains(&"6,1".to_string()), "стену видно");
    assert!(!behind_wall.contains(&"7,1".to_string()), "сквозь стену не смотрят");
}

// --- test/circular-spell-targeting.test.mjs ---------------------------------

fn circle_field(map: &TacticalMap, enemies: Value) -> Value {
    field(map, json!([{ "id": "mage", "characterClass": "wizard", "level": 5, "hp": 30, "maxHp": 30, "x": 1, "y": 10 }]), enemies, "dnd_5e_2014")
}

fn fireball_command() -> Value {
    json!({ "command_type": "CastSpell", "actor_id": "mage", "spell_id": "fireball", "to": { "x": 10, "y": 10 }, "slot_level": 3 })
}

fn corner_and_edge() -> Value {
    json!([
        { "id": "corner", "name": "В углу старого квадрата", "hp": 20, "maxHp": 20, "x": 6, "y": 6, "alive": true },
        { "id": "edge", "name": "Внутри дуги", "hp": 20, "maxHp": 20, "x": 8, "y": 6, "alive": true },
    ])
}

#[test]
fn pilot_2014_uses_a_circle_and_the_old_profile_keeps_the_square() {
    let profile = spell("fireball", "dnd_5e_2014");
    assert_eq!(profile["areaGeometryVersion"], "circle-grid-v2");
    assert!(canonical_combat_spell_for(Some(&json!("fireball")), None).unwrap().get("areaGeometryVersion").is_none());
    let state = circle_field(&open_map(22, 22), corner_and_edge());
    assert_eq!(ids(&area::spell_targets_at(&state, &fireball_command(), &profile)), vec!["edge"]);
    let mut square = profile.clone();
    square.as_object_mut().unwrap().shift_remove("areaGeometryVersion");
    assert_eq!(ids(&area::spell_targets_at(&state, &fireball_command(), &square)), vec!["corner", "edge"]);
}

#[test]
fn stored_area_without_version_stays_square() {
    let state = circle_field(&open_map(22, 22), corner_and_edge());
    let legacy = json!({ "id": "legacy-area", "spell_id": "test-area", "center": { "x": 10, "y": 10 }, "radius_feet": 20, "area_shape": "sphere", "spreadsAroundCorners": false });
    let mut current = legacy.clone();
    current["id"] = json!("circle-area");
    current["geometry_version"] = json!("circle-grid-v2");
    current["grid_origin"] = json!({ "x": 10, "y": 10 });
    assert!(area::position_in_effect(&state, Some(p(6.0, 6.0)), &legacy, None));
    assert!(!area::position_in_effect(&state, Some(p(6.0, 6.0)), &current, None));
    assert!(area::position_in_effect(&state, Some(p(8.0, 6.0)), &current, None));
}

#[test]
fn circular_area_checks_wall_door_and_corners_from_the_new_origin() {
    let profile = spell("fireball", "dnd_5e_2014");
    let mut map = open_map(22, 22);
    tmap::set_cell(&mut map, 12, 10, &CellPatch { passable: Some(false), ..CellPatch::default() }).expect("клетка");
    let beyond = json!([{ "id": "beyond", "name": "За углом", "hp": 20, "maxHp": 20, "x": 13, "y": 10, "alive": true }]);
    let state = circle_field(&map, beyond.clone());
    let mut straight = profile.clone();
    straight["spreadsAroundCorners"] = json!(false);
    assert!(area::spell_targets_at(&state, &fireball_command(), &straight).is_empty());
    assert_eq!(ids(&area::spell_targets_at(&state, &fireball_command(), &profile)), vec!["beyond"]);
    tmap::set_cell(&mut map, 12, 10, &CellPatch { passable: Some(true), ..CellPatch::default() }).expect("клетка");
    for y in 0..22 {
        tmap::set_door(&mut map, &json!({ "id": format!("barrier-{y}"), "x": 12, "y": y, "dir": "e", "state": "closed", "blocksMove": true, "blocksSight": true })).expect("дверь");
    }
    let sealed = circle_field(&map, beyond);
    assert!(area::spell_targets_at(&sealed, &fireball_command(), &profile).is_empty());
}

#[test]
fn large_target_checks_the_same_cell_for_circle_and_line_of_effect() {
    let profile = spell("fireball", "dnd_5e_2014");
    let state = circle_field(&open_map(22, 22), json!([{ "id": "large", "name": "Крупный", "hp": 20, "maxHp": 20, "x": 5, "y": 8, "alive": true, "footprint": { "version": 1, "size": 2 } }]));
    assert_eq!(ids(&area::spell_targets_at(&state, &fireball_command(), &profile)), vec!["large"]);
    let mut moved = state.clone();
    moved["enemies"][0]["x"] = json!(4);
    assert!(area::spell_targets_at(&moved, &fireball_command(), &profile).is_empty());
}

// --- test/spell-cube-geometry.test.mjs --------------------------------------

const CUBE_20: [(i64, i64); 16] = [(3, 3), (4, 3), (5, 3), (6, 3), (3, 4), (4, 4), (5, 4), (6, 4), (3, 5), (4, 5), (5, 5), (6, 5), (3, 6), (4, 6), (5, 6), (6, 6)];

fn cube_spell(overrides: Value) -> Value {
    let mut spell = json!({ "id": "entangle", "kind": "area-save", "target": "point", "radius": 10, "areaSideFeet": 20, "areaShape": "cube", "saveAbility": "str" });
    sk_core::js::assign(&mut spell, overrides);
    spell
}

fn cube_field(enemies: &[(String, i64, i64)], mage: (i64, i64)) -> Value {
    let enemies: Vec<Value> = enemies.iter().map(|(id, x, y)| json!({ "id": id, "name": id, "hp": 30, "maxHp": 30, "alive": true, "x": x, "y": y })).collect();
    cells_field(12, 12, json!([{ "id": "mage", "characterClass": "wizard", "level": 10, "hp": 40, "maxHp": 40, "x": mage.0, "y": mage.1 }]), Value::Array(enemies))
}

fn cube_enemies() -> Vec<(String, i64, i64)> {
    CUBE_20.iter().map(|(x, y)| (format!("cube-{x},{y}"), *x, *y)).collect()
}

#[test]
fn twenty_foot_point_cube_hits_exactly_sixteen_cells() {
    let mut enemies = cube_enemies();
    enemies.push(("outside-north-west".into(), 2, 2));
    enemies.push(("outside-south-east".into(), 7, 7));
    let state = cube_field(&enemies, (0, 0));
    let targets = ids(&area::spell_targets_at(&state, &json!({ "actor_id": "mage", "to": { "x": 4, "y": 4 } }), &cube_spell(json!({}))));
    let expected: Vec<String> = cube_enemies().into_iter().map(|(id, _, _)| id).collect();
    assert_eq!(targets, expected);
}

#[test]
fn legacy_point_cube_without_side_falls_back_to_radius_times_two() {
    let mut enemies = cube_enemies();
    enemies.push(("outside".into(), 2, 4));
    enemies.push(("outside-diagonal".into(), 7, 7));
    let state = cube_field(&enemies, (0, 0));
    let mut legacy = cube_spell(json!({}));
    legacy.as_object_mut().unwrap().shift_remove("areaSideFeet");
    let expected: Vec<String> = cube_enemies().into_iter().map(|(id, _, _)| id).collect();
    assert_eq!(ids(&area::spell_targets_at(&state, &json!({ "actor_id": "mage", "to": { "x": 4, "y": 4 } }), &legacy)), expected);
}

#[test]
fn explicit_side_does_not_double_a_small_point_cube() {
    let state = cube_field(&[("bonfire-cell".into(), 4, 4), ("bonfire-east".into(), 5, 4)], (0, 0));
    let spell = cube_spell(json!({ "id": "create-bonfire", "radius": 5, "areaSideFeet": 5 }));
    assert_eq!(ids(&area::spell_targets_at(&state, &json!({ "actor_id": "mage", "to": { "x": 4, "y": 4 } }), &spell)), vec!["bonfire-cell"]);
}

#[test]
fn self_cube_uses_the_whole_footprint_of_a_large_caster() {
    let mut state = cube_field(&[("self-edge".into(), 4, 1), ("self-diagonal".into(), 4, 0), ("self-outside".into(), 5, 4)], (1, 1));
    state["players"][0]["footprint"] = json!({ "version": 1, "size": 2 });
    let spell = cube_spell(json!({ "radius": 15, "areaSideFeet": 15, "areaOrigin": "self" }));
    let targets = ids(&area::spell_targets_at(&state, &json!({ "actor_id": "mage", "to": { "x": 4, "y": 1 } }), &spell));
    assert!(targets.contains(&"self-edge".to_string()));
    assert!(targets.contains(&"self-diagonal".to_string()));
    assert!(!targets.contains(&"self-outside".to_string()));
}

#[test]
fn lingering_point_cube_uses_the_same_bound_on_entry() {
    let state = cube_field(&[("runner".into(), 1, 4)], (0, 0));
    let effect = json!({ "id": "entangle:geometry", "spell_id": "entangle", "source_actor": "mage", "center": { "x": 4, "y": 4 }, "radius_feet": 10, "area_side_feet": 20, "area_shape": "cube", "condition": "restrained" });
    assert!(!area::position_in_effect(&state, Some(p(2.0, 4.0)), &effect, None), "клетка вне куба");
    assert!(area::position_in_effect(&state, Some(p(3.0, 4.0)), &effect, None), "край куба");
}

// --- test/actor-footprint.test.mjs ------------------------------------------

fn footprint_state(large_at: (i64, i64), hero_at: (i64, i64), edge: Option<(i64, i64, i64, i64)>) -> Value {
    let mut map = open_map(8, 6);
    if let Some((x, y, to_x, to_y)) = edge {
        tmap::set_edge(&mut map, x, y, to_x, to_y, &EdgePatch { kind: Some("wall"), ..EdgePatch::default() }).expect("ребро");
    }
    field(
        &map,
        json!([{ "id": "hero", "hp": 30, "maxHp": 30, "speed": 30, "level": 5, "x": hero_at.0, "y": hero_at.1 }]),
        json!([{ "id": "ogre", "name": "Огр", "hp": 59, "maxHp": 59, "speed": 30, "size": "large", "footprint": { "version": 1, "size": 2 }, "alive": true, "x": large_at.0, "y": large_at.1 }]),
        "srd_5_2_1",
    )
}

#[test]
fn large_creature_occupies_two_by_two_for_path_distance_and_area() {
    let state = footprint_state((2, 1), (0, 1), None);
    let path = geo::shortest_tactical_path(&state, "hero", p(1.0, 1.0), PathOptions::default()).expect("путь");
    assert_eq!(path, vec![p(1.0, 1.0)]);
    assert!(geo::shortest_tactical_path(&state, "hero", p(2.0, 1.0), PathOptions::default()).is_none());
    let close = footprint_state((1, 1), (3, 1), None);
    assert_eq!(sk_rules::targets::distance_between_actors(&close, "ogre", "hero"), Some(5.0), "дистанция от ближайших клеток, а не от anchor");
    let targets = area::spell_targets_at(&state, &json!({ "actor_id": "hero", "to": { "x": 1, "y": 1 } }), &json!({ "target": "point", "kind": "area-save", "radius": 5, "areaShape": "sphere" }));
    assert_eq!(ids(&targets), vec!["hero", "ogre"]);
}

#[test]
fn internal_edge_of_two_by_two_blocks_the_body() {
    let state = footprint_state((1, 1), (6, 4), Some((1, 1, 2, 1)));
    assert!(geo::shortest_tactical_path(&state, "ogre", p(2.0, 1.0), PathOptions::default()).is_none());
}

// --- test/web-walker.test.mjs -----------------------------------------------

fn spider_state(traits: Value, effects: Value, scene: Option<Value>) -> Value {
    let mut state = cells_field(4, 1, json!([{ "id": "hero", "hp": 20, "maxHp": 20, "speed": 30, "x": 0, "y": 0 }]), json!([{ "id": "spider", "hp": 11, "maxHp": 11, "speed": 10, "traits": traits, "x": 3, "y": 0, "alive": true }]));
    state["mechanics"]["active_effects"] = effects;
    if let Some(scene) = scene {
        state["scene"] = scene;
    }
    state
}

fn web_at() -> Value {
    json!({ "id": "web-area", "spell_id": "web", "difficult_terrain": true, "cells": [{ "x": 2, "y": 0 }] })
}

fn mud_at() -> Value {
    json!({ "id": "mud-area", "spell_id": "earth-tremor", "difficult_terrain": true, "cells": [{ "x": 2, "y": 0 }] })
}

fn spider_step(state: &Value) -> f64 {
    terrain::movement_step_cost_for(state, "spider", None).step_cost(p(2.0, 0.0))
}

#[test]
fn web_walker_ignores_only_the_pure_web_surcharge() {
    assert_eq!(spider_step(&spider_state(json!([]), json!([web_at()]), None)), 10.0);
    let traits = json!(["web-walker", { "id": "spider-climb" }]);
    assert_eq!(spider_step(&spider_state(traits.clone(), json!([web_at()]), None)), 5.0);
    assert_eq!(spider_step(&spider_state(json!([{ "id": "web-walker" }]), json!([web_at()]), None)), 5.0);
    assert_eq!(spider_step(&spider_state(traits.clone(), json!([mud_at()]), None)), 10.0);
    assert_eq!(spider_step(&spider_state(traits.clone(), json!([web_at(), mud_at()]), None)), 10.0);
    let cells: Vec<Value> = (0..4).map(|x| json!({ "x": x, "y": 0, "type": "floor", "revealed": true })).collect();
    let mut map = tmap::tactical_map_from_legacy_cells(&cells, &tmap::LegacyMapOptions::default()).expect("карта");
    tmap::set_cell(&mut map, 2, 0, &CellPatch { move_cost: Some(2.0), surface: Some("rubble"), ..CellPatch::default() }).expect("клетка");
    let scene = json!({ "cells": tmap::legacy_cells_from_tactical_map(&map), "map": tmap::serialize_tactical_map(&map).expect("сериализация") });
    assert_eq!(spider_step(&spider_state(traits, json!([web_at()]), Some(scene))), 10.0, "статическая труднопроходимость");
}

// --- свои проверки: ключи, линия, куча поиска ---------------------------------

#[test]
fn keys_follow_js_string_identity() {
    assert_eq!(geo::key(-0.0, 0.0), geo::key(0.0, -0.0));
    assert_eq!(geo::key(f64::NAN, 1.0), geo::key(-f64::NAN, 1.0));
    assert_ne!(geo::key(1.5, 2.0), geo::key(1.0, 2.0));
    assert_eq!(geo::position_key(p(-0.0, 3.0)), "0,3");
}

#[test]
fn line_cells_of_non_integer_span_is_empty_where_js_loops_forever() {
    assert!(geo::line_cells(p(0.0, 0.0), p(1.5, 0.0)).is_empty());
    assert!(geo::line_cells(p(0.0, 0.0), p(f64::NAN, 0.0)).is_empty());
    assert_eq!(geo::line_cells(p(0.5, 0.0), p(2.5, 1.0)), vec![p(1.5, 1.0), p(2.5, 1.0)], "целая разность — как в JS");
}

#[test]
fn weighted_path_prefers_cheap_cells_and_counts_them_like_move_actor() {
    let state = cells_field(5, 3, json!([{ "id": "hero", "hp": 10, "maxHp": 10, "speed": 30, "x": 0, "y": 1 }]), json!([]));
    let mut state = state;
    state["mechanics"]["active_effects"] = json!([{ "id": "mud", "spell_id": "earth-tremor", "difficult_terrain": true, "cells": [{ "x": 1, "y": 1 }, { "x": 2, "y": 1 }, { "x": 3, "y": 1 }] }]);
    let cost = terrain::movement_step_cost_for(&state, "hero", None);
    let step = |point: Point, map: Option<&TacticalMap>| cost.step_cost_on(point, map);
    let path = geo::shortest_tactical_path(&state, "hero", p(4.0, 1.0), PathOptions { step_cost: Some(&step), tactical_map: Some(cost.map()), ..PathOptions::default() }).expect("путь");
    assert!(path.iter().all(|cell| cell.y != 1.0 || cell.x == 4.0), "обход трясины: {path:?}");
    assert_eq!(terrain::movement_cost_of_path(&state, "hero", &path, None), path.len() as f64 * 5.0);
    let straight = geo::shortest_tactical_path(&state, "hero", p(4.0, 1.0), PathOptions::default()).expect("путь");
    assert_eq!(straight.len(), 4);
    assert_eq!(terrain::movement_cost_of_path(&state, "hero", &straight, None), 35.0);
}
