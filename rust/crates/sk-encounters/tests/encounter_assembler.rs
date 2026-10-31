//! Сверка `encounter_assembler` с эталоном JS (`fixtures/encounter-assembler.json`,
//! генератор `fixtures/gen-encounter-assembler.mjs`) и перенос проверок
//! сборщика из `test/encounter-assembler.test.mjs`, `encounter-deadly-tier`,
//! `actor-footprint`, `boss-mechanics` и `creature-models`.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{hash, js};
use sk_encounters::encounter_assembler::{self as ea, AssembleFailure, EncounterAssembler};
use sk_geometry::actor_footprint::footprint_cells_for;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/encounter-assembler.json")).expect("эталон JSON"));

const UNDEFINED: &str = "\u{0}undefined";

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).expect("массив в эталоне")
}

fn arg(value: &Value) -> Option<&Value> {
    (value.as_str() != Some(UNDEFINED)).then_some(value)
}

/// Сжатая сцена эталона → клетки входа (как `decodeScene` генератора).
fn decode_scene(scene: &Value) -> Vec<Value> {
    let int = |key: &str| scene[key].as_i64().expect("число сцены");
    let (ox, oy, w, h) = (int("ox"), int("oy"), int("w"), int("h"));
    let rows: Vec<Vec<char>> = array(&scene["rows"]).iter().map(|row| row.as_str().expect("ряд").chars().collect()).collect();
    let walls: Option<Vec<Vec<char>>> = scene.get("walls").map(|walls| array(walls).iter().map(|row| row.as_str().expect("ряд").chars().collect()).collect());
    let mut features = std::collections::HashMap::new();
    for entry in scene.get("features").map(array).unwrap_or(&[]) {
        features.insert((entry[0].as_i64().unwrap_or(0), entry[1].as_i64().unwrap_or(0)), entry[2].clone());
    }
    let occupied: HashSet<(i64, i64)> = scene.get("occupied").map(array).unwrap_or(&[]).iter().map(|entry| (entry[0].as_i64().unwrap_or(0), entry[1].as_i64().unwrap_or(0))).collect();
    let reveal = scene.get("reveal") == Some(&Value::Bool(true));
    let mut cells = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let char = rows[y as usize][x as usize];
            if char == ' ' {
                continue;
            }
            let (cx, cy) = (ox + x, oy + y);
            let kind = match char.to_ascii_lowercase() {
                'f' => "floor",
                'w' => "wall",
                'o' => "water",
                'd' => "door",
                other => panic!("неизвестный символ клетки {other}"),
            };
            let mut cell = Map::new();
            cell.insert("x".into(), Value::from(cx));
            cell.insert("y".into(), Value::from(cy));
            cell.insert("type".into(), Value::from(kind));
            cell.insert("revealed".into(), Value::Bool(reveal || char.is_ascii_lowercase()));
            if let Some(feature) = features.get(&(cx, cy)) {
                cell.insert("feature".into(), feature.clone());
            }
            if occupied.contains(&(cx, cy)) {
                cell.insert("occupied".into(), Value::Bool(true));
            }
            let wall = walls.as_ref().map_or('.', |walls| walls[y as usize][x as usize]);
            if wall != '.' {
                cell.insert("walls".into(), Value::from(if wall == 'b' { "es".to_string() } else { wall.to_string() }));
            }
            cells.push(Value::Object(cell));
        }
    }
    cells
}

static SCENES: LazyLock<Vec<Vec<Value>>> = LazyLock::new(|| array(&FIXTURE["scenes"]).iter().map(decode_scene).collect());

fn input_for(entry: &Value) -> Value {
    let scene = entry["scene"].as_u64().expect("индекс сцены") as usize;
    let mut input = Map::new();
    input.insert("scene".into(), json!({ "cells": SCENES[scene] }));
    for key in ["party", "difficulty", "theme", "seed"] {
        input.insert(key.into(), entry[key].clone());
    }
    if let Some(ruleset) = entry.get("ruleset_id") {
        input.insert("ruleset_id".into(), ruleset.clone());
    }
    Value::Object(input)
}

fn error_json(error: &AssembleFailure) -> Value {
    match error {
        AssembleFailure::Assembly(error) => json!({ "name": ea::EncounterAssemblyError::NAME, "code": error.code, "message": error.message }),
        AssembleFailure::Roster(error) => json!({ "name": "TypeError", "code": null, "message": error.to_string() }),
        AssembleFailure::Loadout(error) => json!({ "name": "EnemyLoadoutError", "code": error_code(error), "message": error.to_string() }),
        AssembleFailure::Content(message) => json!({ "name": "Error", "code": null, "message": message }),
    }
}

fn error_code(error: &sk_economy::enemy_loadouts::EnemyLoadoutFailure) -> Value {
    match error {
        sk_economy::enemy_loadouts::EnemyLoadoutFailure::Loadout(error) => Value::from(error.code.as_str()),
        _ => Value::Null,
    }
}

fn summary(proposal: &Value) -> Value {
    let enemies: Vec<Value> = array(&proposal["enemies"])
        .iter()
        .map(|enemy| json!([enemy["stat_block_id"], enemy["x"], enemy["y"], enemy["footprint"]["size"].as_i64().unwrap_or(1)]))
        .collect();
    json!({
        "hash": hash::sha256_hex(js::stringify(proposal)),
        "enemies": enemies,
        "xp": [proposal["xp_budget"], proposal["xp_spent"], proposal["threat"]["quantity_cap"]],
    })
}

fn outcome(input: Option<&Value>) -> Value {
    match ea::assemble_encounter(input) {
        Ok(proposal) => summary(&proposal),
        Err(error) => json!({ "error": error_json(&error) }),
    }
}

fn assemble(input: &Value) -> Value {
    ea::assemble_encounter(Some(input)).unwrap_or_else(|error| panic!("сборка не удалась: {error:?}"))
}

fn assert_code(input: &Value, code: &str) {
    match ea::assemble_encounter(Some(input)) {
        Err(error) => assert_eq!(error.code(), Some(code), "{error:?}"),
        Ok(_) => panic!("ожидался отказ {code}"),
    }
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["version"], ea::ENCOUNTER_PROPOSAL_VERSION);
    assert_eq!(js::stringify(&constants["limits"]), js::stringify(&ea::ENCOUNTER_ASSEMBLER_LIMITS.to_json()));
    assert_eq!(js::stringify(&constants["srd"]), js::stringify(&ea::SRD_5_2_1_SOURCE));
    assert_eq!(js::stringify(&constants["dndsu"]), js::stringify(&ea::DND_SU_BESTIARY_SOURCE));
    assert_eq!(js::stringify(&constants["allowlist"]), js::stringify(&ea::SRD_5_2_1_MONSTER_ALLOWLIST));
    assert_eq!(constants["themes"], json!(ea::ENCOUNTER_THEMES));
    assert_eq!(constants["difficulties"], json!(ea::ENCOUNTER_DIFFICULTIES));
    assert_eq!(js::stringify(&constants["labels"]), js::stringify(&ea::encounter_difficulty_labels_json()));
    assert_eq!(constants["warning"], ea::DEADLY_ENCOUNTER_WARNING);
}

#[test]
fn labels_and_barriers_match_js() {
    for case in array(&FIXTURE["labels"]) {
        let expected = &case["out"];
        let actual = ea::encounter_difficulty_label(arg(&case["input"]));
        match (expected, actual) {
            (Value::String(label), Some(Value::String(actual))) => assert_eq!(label, &actual, "{case}"),
            (Value::Object(map), None) if map.contains_key("$function") => {}
            (Value::Object(map), Some(actual)) if map.contains_key("$object") => assert_eq!(map["$object"], actual, "{case}"),
            (expected, actual) => panic!("ярлык {case}: JS {expected}, Rust {actual:?}"),
        }
    }
    for case in array(&FIXTURE["barriers"]) {
        assert_eq!(case["out"], ea::encounter_barrier_sides(arg(&case["input"])), "{case}");
    }
}

#[test]
fn corpus_cases_match_js() {
    let cases = array(&FIXTURE["cases"]);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let actual = outcome(Some(&input_for(case)));
        if actual != case["out"] {
            failures.push(format!(
                "#{index} {} {} {} {} {}\n  Rust: {}\n  JS:   {}",
                case.get("label").and_then(Value::as_str).unwrap_or(""),
                case["theme"],
                case["difficulty"],
                case["seed"],
                case.get("ruleset_id").map(Value::to_string).unwrap_or_default(),
                actual,
                case["out"]
            ));
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() >= 2_500, "случаев меньше, чем снято: {}", cases.len());
}

#[test]
fn raw_inputs_match_js() {
    let mut failures = Vec::new();
    for case in array(&FIXTURE["raw"]) {
        let mut input = case["input"].clone();
        if let Some(index) = input.pointer("/scene/cells/$scene").and_then(Value::as_u64) {
            input["scene"]["cells"] = Value::Array(SCENES[index as usize].clone());
        }
        let actual = outcome(arg(&input));
        if actual != case["out"] {
            failures.push(format!("{}\n  Rust: {actual}\n  JS:   {}", case["label"], case["out"]));
        }
    }
    assert!(failures.is_empty(), "расхождений {}:\n{}", failures.len(), failures.join("\n"));
}

/// Замечено в JS: при повторном визите двух героев в Редстоуновку отряд стоит
/// на двух открытых клетках у края карты, а открытая область прошлого визита
/// лежит в другом конце — клеток на дистанции появления нет ни на одном сиде.
/// Сборщик отвечает по своему контракту, и Rust повторяет отказ как есть.
#[test]
fn redstone_second_visit_fails_on_every_seed_as_in_js() {
    let second: Vec<&Value> = array(&FIXTURE["cases"]).iter().filter(|case| case["label"].as_str().is_some_and(|label| label.starts_with("engine:redstone-second"))).collect();
    assert_eq!(second.len(), 6, "шесть сидов повторного визита");
    for case in second {
        let input = input_for(case);
        assert_eq!(input["theme"], "raiders");
        assert_eq!(input["difficulty"], "easy");
        assert_eq!(input["party"].as_array().map(Vec::len), Some(2));
        match ea::assemble_encounter(Some(&input)) {
            Err(AssembleFailure::Assembly(error)) => {
                assert_eq!(error.code, "NO_SAFE_PLACEMENT_CELLS");
                assert_eq!(error.message, "Нет безопасных клеток для размещения противников");
            }
            other => panic!("ожидался NO_SAFE_PLACEMENT_CELLS: {other:?}"),
        }
    }
    let first = array(&FIXTURE["cases"]).iter().find(|case| case["label"] == "engine:redstone-first").expect("первый визит");
    assert!(ea::assemble_encounter(Some(&input_for(first))).is_ok(), "первый визит собирается");
}

// --- перенос проверок из test/*.test.mjs ---------------------------------------

fn field(width: i64, height: i64) -> Vec<Value> {
    let mut cells = Vec::new();
    for y in 0..height {
        for x in 0..width {
            cells.push(json!({ "x": x, "y": y, "type": "floor", "revealed": true }));
        }
    }
    cells
}

fn base_input(overrides: Value) -> Value {
    let mut input = json!({
        "scene": { "cells": field(7, 5) },
        "party": [
            { "id": "hero-1", "level": 1, "x": 0, "y": 0 },
            { "id": "hero-2", "level": 1, "x": 1, "y": 0 },
            { "id": "hero-3", "level": 1, "x": 2, "y": 0 },
            { "id": "hero-4", "level": 1, "x": 3, "y": 0 },
        ],
        "difficulty": "easy",
        "theme": "generic",
        "seed": "campaign:chapter-1:encounter-1",
    });
    js::assign(&mut input, overrides);
    input
}

fn hero(level: i64, x: i64, y: i64) -> Value {
    json!([{ "id": "hero", "level": level, "x": x, "y": y }])
}

fn names_without_ordinal(proposal: &Value) -> Vec<String> {
    array(&proposal["enemies"]).iter().map(|enemy| enemy["name"].as_str().unwrap_or("").trim_end_matches(|c: char| c.is_ascii_digit()).trim_end().to_string()).collect()
}

#[test]
fn exports_srd_catalog_with_fixed_provenance() {
    let allowlist = ea::SRD_5_2_1_MONSTER_ALLOWLIST.as_object().expect("объект");
    assert_eq!(allowlist.len(), 50);
    assert_eq!(ea::DND_SU_BESTIARY_SOURCE["url"], "https://dnd.su/bestiary/");
    assert_eq!(ea::SRD_5_2_1_SOURCE["version"], "5.2.1");
    assert_eq!(ea::SRD_5_2_1_SOURCE["encounter_budget_page"], 202);
    assert!(ea::SRD_5_2_1_SOURCE["url"].as_str().is_some_and(|url| url.ends_with("SRD_CC_v5.2.1.pdf")));
    for (id, page, initiative) in [("srd_5_2_1:goblin-minion", 290, Some(2)), ("srd_5_2_1:skeleton", 325, Some(3)), ("srd_5_2_1:zombie", 343, Some(-2)), ("srd_5_2_1:wolf", 364, None), ("srd_5_2_1:owlbear", 313, None)] {
        assert_eq!(allowlist[id]["source_page"], page, "{id}");
        if let Some(initiative) = initiative {
            assert_eq!(allowlist[id]["initiative_bonus"], initiative, "{id}");
        }
    }
    assert!(allowlist.values().all(|monster| monster["source_url"].as_str().is_some_and(|url| url.starts_with("https://dnd.su/bestiary/"))));
    assert!(allowlist.values().all(|monster| monster["action_profiles"].as_array().is_some_and(|profiles| !profiles.is_empty())));
    // `boss-mechanics`: ни одна запись бестиария босса пока не объявляет.
    assert!(allowlist.values().all(|monster| monster.get("spellcasting").is_none() && monster.get("legendary").is_none()));
}

#[test]
fn every_theme_assembles_a_deterministic_roster_from_the_allowlist() {
    let allowed: HashSet<String> = ea::SRD_5_2_1_MONSTER_ALLOWLIST.as_object().expect("объект").values().map(|monster| monster["name"].as_str().unwrap_or("").to_string()).collect();
    let mut rosters = HashSet::new();
    for theme in ea::ENCOUNTER_THEMES {
        for difficulty in ea::ENCOUNTER_DIFFICULTIES {
            let input = base_input(json!({ "theme": theme, "difficulty": difficulty }));
            let proposal = assemble(&input);
            assert!(!array(&proposal["enemies"]).is_empty(), "{theme}/{difficulty}: пустой ростер");
            assert!(names_without_ordinal(&proposal).iter().all(|name| allowed.contains(name)), "{theme}/{difficulty}: существо вне allowlist");
            assert_eq!(assemble(&input), proposal, "{theme}/{difficulty}: сборка недетерминирована");
            if difficulty == "medium" {
                let mut names = names_without_ordinal(&proposal);
                names.sort();
                rosters.insert(names.join(","));
            }
        }
    }
    assert!(rosters.len() >= 6, "слишком мало различных ростеров: {}", rosters.len());
}

#[test]
fn assembly_is_deterministic_input_order_independent_and_bounded_by_budget() {
    let input = base_input(json!({}));
    let first = assemble(&input);
    let mut reversed = input.clone();
    reversed["scene"]["cells"].as_array_mut().expect("клетки").reverse();
    reversed["party"].as_array_mut().expect("отряд").reverse();
    assert_eq!(EncounterAssembler.assemble(Some(&reversed)).expect("сборка"), first);
    assert_eq!(first["version"], ea::ENCOUNTER_PROPOSAL_VERSION);
    assert_eq!(first["xp_budget"], 200);
    assert_eq!(first["xp_spent"], 200);
    let quantity = array(&first["enemies"]).len();
    assert_eq!(first["threat"], json!({ "budget_xp": 200, "spent_xp": 200, "unspent_xp": 0, "utilization_bps": 10_000, "quantity": quantity, "quantity_cap": 8 }));
}

#[test]
fn mixed_level_party_sums_per_character_budget() {
    let proposal = assemble(&base_input(json!({
        "party": [{ "id": "level-1", "level": 1, "x": 0, "y": 0 }, { "id": "level-2", "level": 2, "x": 1, "y": 0 }],
        "difficulty": "medium",
        "theme": "goblinoids",
    })));
    assert_eq!(proposal["xp_budget"], 225);
    assert_eq!(proposal["xp_spent"], 225);
    assert_eq!(proposal["threat"]["quantity_cap"], 4);
    assert_eq!(array(&proposal["enemies"]).len(), 2);
    let goblinoids = ["srd_5_2_1:goblin-minion", "srd_5_2_1:goblin-warrior", "srd_5_2_1:hobgoblin", "srd_5_2_1:kobold", "srd_5_2_1:bugbear"];
    assert!(array(&proposal["enemies"]).iter().all(|enemy| goblinoids.contains(&enemy["stat_block_id"].as_str().unwrap_or(""))));
}

#[test]
fn placement_uses_only_revealed_walkable_free_cells() {
    let cells = json!([
        { "x": 0, "y": 0, "type": "floor", "revealed": true },
        { "x": 1, "y": 0, "type": "floor", "revealed": true },
        { "x": 2, "y": 0, "type": "floor", "revealed": true, "feature": "chest" },
        { "x": 3, "y": 0, "type": "floor", "revealed": true },
        { "x": 4, "y": 0, "type": "door", "revealed": true },
        { "x": 5, "y": 0, "type": "wall", "revealed": true },
        { "x": 6, "y": 0, "type": "water", "revealed": true },
        { "x": 7, "y": 0, "type": "door", "revealed": false },
        { "x": 9, "y": 0, "type": "floor", "revealed": true },
    ]);
    let proposal = assemble(&base_input(json!({ "scene": { "cells": cells }, "party": hero(1, 0, 0), "difficulty": "hard", "theme": "beasts" })));
    // Клетка двери — проём: враг в нём не появляется.
    assert_eq!(proposal["threat"]["quantity_cap"], 1);
    let positions: HashSet<(i64, i64)> = array(&proposal["enemies"]).iter().map(|enemy| (enemy["x"].as_i64().unwrap_or(-1), enemy["y"].as_i64().unwrap_or(-1))).collect();
    assert_eq!(positions, HashSet::from([(3, 0)]));
}

#[test]
fn enemy_appears_on_this_side_of_a_door_unless_cramped() {
    let mut cells: Vec<Value> = (0..5).map(|x| json!({ "x": x, "y": 0, "type": "floor", "revealed": true })).collect();
    cells.push(json!({ "x": 5, "y": 0, "type": "door", "revealed": true }));
    cells.extend((6..10).map(|x| json!({ "x": x, "y": 0, "type": "floor", "revealed": true })));
    let proposal = assemble(&base_input(json!({ "scene": { "cells": cells }, "party": hero(1, 0, 0), "theme": "beasts" })));
    assert!(array(&proposal["enemies"]).iter().all(|enemy| enemy["x"].as_i64().is_some_and(|x| x <= 4)), "все враги на улице");
    let mut cramped = vec![json!({ "x": 0, "y": 0, "type": "floor", "revealed": true }), json!({ "x": 1, "y": 0, "type": "door", "revealed": true })];
    cramped.extend((2..6).map(|x| json!({ "x": x, "y": 0, "type": "floor", "revealed": true })));
    let proposal = assemble(&base_input(json!({ "scene": { "cells": cramped }, "party": hero(1, 0, 0), "theme": "beasts" })));
    assert!(!array(&proposal["enemies"]).is_empty());
}

#[test]
fn window_holds_a_step_like_a_wall() {
    assert_eq!(ea::encounter_barrier_sides(Some(&json!({ "windows": "e" }))), "e");
    assert_eq!(ea::encounter_barrier_sides(Some(&json!({ "walls": "s", "windows": "e" }))), "es");
    assert_eq!(ea::encounter_barrier_sides(Some(&json!({}))), "");
    let mut cells: Vec<Value> = (0..4).map(|x| json!({ "x": x, "y": 0, "type": "floor", "revealed": true })).collect();
    cells.push(json!({ "x": 4, "y": 0, "type": "floor", "revealed": true, "walls": ea::encounter_barrier_sides(Some(&json!({ "windows": "e" }))) }));
    cells.extend((5..10).map(|x| json!({ "x": x, "y": 0, "type": "floor", "revealed": true })));
    let proposal = assemble(&base_input(json!({ "scene": { "cells": cells }, "party": hero(1, 0, 0), "theme": "beasts" })));
    assert!(array(&proposal["enemies"]).iter().all(|enemy| enemy["x"].as_i64().is_some_and(|x| x <= 4)), "враги по эту сторону окна");
}

#[test]
fn placement_rejects_adjacent_cells_and_disconnected_islands() {
    let cells = json!([
        { "x": 0, "y": 0, "type": "floor", "revealed": true },
        { "x": 1, "y": 0, "type": "floor", "revealed": true },
        { "x": 2, "y": 0, "type": "wall", "revealed": true },
        { "x": 3, "y": 0, "type": "floor", "revealed": true },
    ]);
    assert_code(&base_input(json!({ "scene": { "cells": cells }, "party": hero(1, 0, 0) })), "NO_SAFE_PLACEMENT_CELLS");
    assert_code(&base_input(json!({ "scene": { "cells": [{ "x": 0, "y": 0, "type": "floor", "revealed": true }] }, "party": hero(1, 0, 0) })), "NO_SAFE_PLACEMENT_CELLS");
}

#[test]
fn caps_take_priority_over_a_large_budget() {
    let party: Vec<Value> = (0..8).map(|index| json!({ "id": format!("hero-{index}"), "level": 20, "x": index, "y": 0 })).collect();
    let proposal = assemble(&base_input(json!({ "scene": { "cells": field(10, 3) }, "party": party, "difficulty": "hard", "theme": "undead" })));
    assert_eq!(proposal["xp_budget"], 176_000);
    assert_eq!(array(&proposal["enemies"]).len(), ea::ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures);
    assert_eq!(proposal["threat"]["quantity_cap"], ea::ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures);
    assert!(proposal["xp_spent"].as_i64() < proposal["xp_budget"].as_i64());
}

#[test]
fn enemy_output_carries_engine_fields_in_js_order() {
    let proposal = assemble(&base_input(json!({ "theme": "beasts", "party": hero(1, 0, 0), "seed": "wolf-1" })));
    let enemy = array(&proposal["enemies"]).iter().find(|enemy| enemy["stat_block_id"] == "srd_5_2_1:wolf").expect("волк");
    let keys: Vec<&str> = enemy.as_object().expect("объект").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "id", "name", "hp", "maxHp", "armor", "speed", "initiativeBonus", "attackBonus", "damageDice", "damageBonus", "abilities", "creature_type", "footprint", "image",
            "source_url", "traits", "action_profiles", "attack_profile", "x", "y", "alive", "stat_block_id", "loadout", "provenance",
        ]
    );
    // Волк не носит кинжала: у зверя инвентарь пустой, а не отсутствующий.
    assert_eq!(enemy["loadout"]["items"], json!([]));
    assert_eq!(enemy["loadout"]["template_id"], Value::Null);
    assert_eq!(enemy["loadout"]["purse_cp"], 0);
    assert_eq!(enemy["hp"], 11);
    assert_eq!(enemy["maxHp"], 11);
    assert_eq!(enemy["initiativeBonus"], 2);
    assert_eq!(enemy["damageDice"], 6);
    assert_eq!(enemy["image"], "/assets/enemies/wolf.png");
    assert_eq!(enemy["source_url"], "https://dnd.su/bestiary/2-wolf/");
    assert_eq!(enemy["traits"][0]["id"], "pack-tactics");
    assert_eq!(enemy["action_profiles"][0]["on_hit"]["condition"], "prone");
    let provenance: Vec<&str> = enemy["provenance"].as_object().expect("объект").keys().map(String::as_str).collect();
    assert_eq!(provenance, ["kind", "ruleset_id", "source_version", "source_sha256", "source_page", "challenge_rating", "xp", "dndsu_url"]);
    assert_eq!(enemy["provenance"]["ruleset_id"], "srd_5_2_1");
    assert_eq!(enemy["provenance"]["kind"], "server-owned-srd-primary-attack-projection");
    assert_eq!(enemy["provenance"]["source_sha256"], ea::SRD_5_2_1_SOURCE["sha256"]);
}

#[test]
fn rejects_unexpected_fields_at_every_boundary() {
    for key in ["monster_id", "xp_budget", "quantity", "price", "secret", "hp", "damageDice"] {
        let mut input = base_input(json!({}));
        input[key] = if key == "quantity" { json!(999) } else { json!("forged") };
        assert_code(&input, "UNEXPECTED_ENCOUNTER_FIELD");
    }
    assert_code(&base_input(json!({ "scene": { "cells": field(7, 5), "hidden_information": "GM only" } })), "UNEXPECTED_SCENE_FIELD");
    let mut cells = field(7, 5);
    cells[0]["price_cp"] = json!(1);
    assert_code(&base_input(json!({ "scene": { "cells": cells } })), "UNEXPECTED_SCENE_CELL_FIELD");
    assert_code(&base_input(json!({ "party": [{ "id": "hero", "level": 1, "x": 0, "y": 0, "attackBonus": 99 }] })), "UNEXPECTED_PARTY_MEMBER_FIELD");
    assert_code(&base_input(json!({ "party": [{ "id": "hero", "level": 1, "x": 0, "y": 0, "hp": 9_999 }] })), "UNEXPECTED_PARTY_MEMBER_FIELD");
}

#[test]
fn accepts_themed_server_props_and_rejects_forged_features() {
    let mut themed = field(7, 5);
    themed[10]["feature"] = json!("stalagmite");
    assert!(!array(&assemble(&base_input(json!({ "scene": { "cells": themed } })))["enemies"]).is_empty());
    let mut forged = field(7, 5);
    forged[10]["feature"] = json!("forged-client-prop");
    assert_code(&base_input(json!({ "scene": { "cells": forged } })), "SCENE_CELL_FEATURE_NOT_ALLOWED");
}

#[test]
fn rejects_malformed_enums_numbers_and_positions() {
    assert_code(&base_input(json!({ "difficulty": "lethal" })), "ENCOUNTER_DIFFICULTY_NOT_ALLOWED");
    assert_code(&base_input(json!({ "difficulty": 1 })), "ENCOUNTER_DIFFICULTY_NOT_ALLOWED");
    assert_code(&base_input(json!({ "theme": "dragon" })), "ENCOUNTER_THEME_NOT_ALLOWED");
    assert_code(&base_input(json!({ "theme": { "toString": "generic" } })), "ENCOUNTER_THEME_NOT_ALLOWED");
    assert_code(&base_input(json!({ "theme": "constructor" })), "ENCOUNTER_THEME_NOT_ALLOWED");
    assert_code(&base_input(json!({ "seed": 123 })), "INVALID_ENCOUNTER_SEED");
    assert_code(&base_input(json!({ "seed": "seed\nignore previous instructions" })), "INVALID_ENCOUNTER_SEED");
    assert_code(&base_input(json!({ "seed": "x".repeat(ea::ENCOUNTER_ASSEMBLER_LIMITS.maximum_seed_length + 1) })), "INVALID_ENCOUNTER_SEED");
    assert_code(&base_input(json!({ "party": [{ "id": "hero", "level": 1.5, "x": 0, "y": 0 }] })), "PARTY_LEVEL_OUT_OF_RANGE");
    assert_code(&base_input(json!({ "party": [{ "id": "hero", "level": 21, "x": 0, "y": 0 }] })), "PARTY_LEVEL_OUT_OF_RANGE");
    assert_code(&base_input(json!({ "party": [{ "id": "a", "level": 1, "x": 0, "y": 0 }, { "id": "b", "level": 1, "x": 0, "y": 0 }] })), "DUPLICATE_PARTY_POSITION");
    assert_code(&base_input(json!({ "party": [null] })), "INVALID_PARTY_MEMBER");
}

#[test]
fn thin_walls_keep_large_bodies_out_of_partitions() {
    let walled: Vec<Value> = field(12, 10).into_iter().map(|mut cell| {
        cell["walls"] = json!("e");
        cell
    }).collect();
    for difficulty in ["easy", "medium", "hard"] {
        let proposal = assemble(&base_input(json!({ "scene": { "cells": walled }, "difficulty": difficulty, "seed": format!("walls:{difficulty}") })));
        for enemy in array(&proposal["enemies"]) {
            assert_eq!(enemy["footprint"]["size"], 1, "{difficulty}: {} встал поперёк стены", enemy["stat_block_id"]);
        }
    }
    assert_code(&base_input(json!({ "scene": { "cells": [{ "x": 0, "y": 0, "type": "floor", "revealed": true, "walls": "n" }] } })), "INVALID_SCENE_CELL_WALLS");
}

#[test]
fn large_body_never_spawns_in_a_pocket_it_cannot_leave() {
    let mut cells: Vec<Value> = (0..10).map(|x| json!({ "x": x, "y": 2, "type": "floor", "revealed": true })).collect();
    cells.push(json!({ "x": 7, "y": 3, "type": "floor", "revealed": true }));
    for x in [6, 7, 8] {
        for y in [4, 5] {
            cells.push(json!({ "x": x, "y": y, "type": "floor", "revealed": true }));
        }
    }
    let mut large = 0;
    for ruleset in [None, Some("dnd_5e_2014")] {
        for difficulty in ["easy", "medium", "hard"] {
            for seed in 1..=6 {
                let mut input = base_input(json!({ "scene": { "cells": cells }, "party": hero(5, 0, 2), "theme": "beasts", "difficulty": difficulty, "seed": format!("pocket:{difficulty}:{seed}") }));
                if let Some(ruleset) = ruleset {
                    input["ruleset_id"] = json!(ruleset);
                }
                let proposal = match ea::assemble_encounter(Some(&input)) {
                    Ok(proposal) => proposal,
                    Err(error) => {
                        assert_eq!(error.code(), Some("NO_SAFE_PLACEMENT_CELLS"));
                        continue;
                    }
                };
                for enemy in array(&proposal["enemies"]) {
                    let size = enemy["footprint"]["size"].as_i64().unwrap_or(1);
                    if size > 1 {
                        large += 1;
                    }
                    assert!(size == 1 || enemy["y"].as_i64().is_some_and(|y| y < 3), "{difficulty}/{seed}: крупный в кармане");
                }
            }
        }
    }
    assert_eq!(large, 0, "крупному существу на этой карте места нет");
}

#[test]
fn large_body_still_spawns_on_open_ground() {
    let mut large = 0;
    for seed in 1..=8 {
        let proposal = assemble(&base_input(json!({ "scene": { "cells": field(14, 10) }, "theme": "beasts", "difficulty": "hard", "seed": format!("open:{seed}"), "ruleset_id": "dnd_5e_2014" })));
        large += array(&proposal["enemies"]).iter().filter(|enemy| enemy["footprint"]["size"].as_i64().unwrap_or(1) > 1).count();
    }
    assert!(large > 0, "проверка кармана не вычищает крупных зверей с открытой местности");
}

#[test]
fn cult_theme_is_only_people() {
    for difficulty in ["easy", "medium", "hard"] {
        let classic = assemble(&base_input(json!({ "theme": "cult", "difficulty": difficulty, "ruleset_id": "dnd_5e_2014", "seed": format!("cult-{difficulty}") })));
        let names = names_without_ordinal(&classic);
        assert!(!names.is_empty());
        assert!(names.iter().all(|name| ["Культист", "Фанатик культа", "Прислужник", "Разбойник", "Капитан разбойников"].contains(&name.as_str())), "{names:?}");
        let modern = assemble(&base_input(json!({ "theme": "cult", "difficulty": difficulty, "seed": format!("cult-{difficulty}") })));
        let pattern = sk_core::re!(r"Бандит|Разбойник|Шпион|Главар|Капитан|Громил|Вожак|Атаман", "u");
        assert!(array(&modern["enemies"]).iter().all(|enemy| sk_core::text::test(pattern, enemy["name"].as_str().unwrap_or(""))));
    }
}

// --- encounter-deadly-tier ---------------------------------------------------

fn deadly_assemble(size: i64, level: i64, difficulty: &str) -> Value {
    let party: Vec<Value> = (0..size).map(|index| json!({ "id": format!("hero-{}", index + 1), "level": level, "x": index, "y": 0 })).collect();
    assemble(&json!({ "scene": { "cells": field(14, 10) }, "party": party, "difficulty": difficulty, "theme": "beasts", "seed": format!("seed-{size}-{level}-{difficulty}") }))
}

#[test]
fn deadly_tier_is_fourth_and_labeled() {
    assert_eq!(ea::ENCOUNTER_DIFFICULTIES, ["easy", "medium", "hard", "deadly"]);
    for (difficulty, label) in [("easy", "лёгкий"), ("medium", "средний"), ("hard", "тяжёлый"), ("deadly", "смертельный"), ("чепуха", "средний")] {
        assert_eq!(ea::encounter_difficulty_label(Some(&json!(difficulty))), Some(json!(label)));
    }
    assert!(ea::DEADLY_ENCOUNTER_WARNING.contains("смертельно опасным"));
    assert!(ea::DEADLY_ENCOUNTER_WARNING.contains("отступить"));
    assert!(!ea::DEADLY_ENCOUNTER_WARNING.chars().any(|c| c.is_ascii_digit()));
}

#[test]
fn budget_grows_with_party_and_level_and_deadly_doubles_hard() {
    for level in [1, 4, 9, 15, 20] {
        for size in [2, 3, 4, 5] {
            let budgets: Vec<i64> = ea::ENCOUNTER_DIFFICULTIES.iter().map(|difficulty| deadly_assemble(size, level, difficulty)["xp_budget"].as_i64().unwrap_or(0)).collect();
            assert!(budgets[0] < budgets[1] && budgets[1] < budgets[2], "{size}×{level}");
            assert_eq!(budgets[3], budgets[2] * 2, "{size}×{level}: deadly вдвое выше hard");
        }
    }
    for difficulty in ea::ENCOUNTER_DIFFICULTIES {
        for level in [1, 8, 20] {
            let sizes: Vec<i64> = [2, 3, 4, 5].iter().map(|size| deadly_assemble(*size, level, difficulty)["xp_budget"].as_i64().unwrap_or(0)).collect();
            assert!(sizes.windows(2).all(|pair| pair[1] > pair[0]), "{difficulty}/{level}");
        }
        let levels: Vec<i64> = [1, 5, 11, 20].iter().map(|level| deadly_assemble(4, *level, difficulty)["xp_budget"].as_i64().unwrap_or(0)).collect();
        assert!(levels.windows(2).all(|pair| pair[1] > pair[0]), "{difficulty}");
    }
    let proposal = deadly_assemble(4, 5, "deadly");
    assert_eq!(proposal["difficulty"], "deadly");
    assert_eq!(proposal["difficulty_label"], "смертельный");
    assert!(!array(&proposal["enemies"]).is_empty());
    assert!(proposal["threat"]["budget_xp"].as_i64() > Some(0));
}

// --- actor-footprint, creature-models ----------------------------------------

#[test]
fn new_encounter_stamps_server_owned_footprints_without_overlap() {
    let proposal = assemble(&json!({ "scene": { "cells": field(12, 12) }, "party": hero(10, 0, 0), "difficulty": "hard", "theme": "raiders", "seed": "footprint-encounter" }));
    let enemies = array(&proposal["enemies"]);
    assert!(!enemies.is_empty());
    assert!(enemies.iter().all(|enemy| enemy["footprint"]["version"] == 1 && enemy["footprint"]["size"].as_i64().is_some_and(|size| (1..=4).contains(&size))));
    let occupied: HashSet<(i64, i64)> = enemies.iter().flat_map(|enemy| footprint_cells_for(Some(enemy), Some(enemy))).map(|cell| (cell.x, cell.y)).collect();
    let total: i64 = enemies.iter().map(|enemy| enemy["footprint"]["size"].as_i64().unwrap_or(1).pow(2)).sum();
    assert_eq!(occupied.len() as i64, total);
}

#[test]
fn giant_rat_of_2014_joins_vermin_crypt_and_cave() {
    let party: Vec<Value> = (1..=4).map(|index| json!({ "id": format!("hero-{index}"), "level": 1, "x": index - 1, "y": 0 })).collect();
    for theme in ["vermin", "crypt", "cave"] {
        let mut rat = None;
        for seed in 1..=12 {
            let proposal = assemble(&json!({ "scene": { "cells": field(14, 10) }, "party": party, "difficulty": "easy", "theme": theme, "seed": format!("rats:{theme}:{seed}"), "ruleset_id": "dnd_5e_2014" }));
            rat = array(&proposal["enemies"]).iter().find(|enemy| enemy["stat_block_id"] == "dnd_5e_2014:monster:giant-rat" || enemy["name"].as_str().is_some_and(|name| name.contains("Гигантская крыса"))).cloned();
            if rat.is_some() {
                break;
            }
        }
        let rat = rat.unwrap_or_else(|| panic!("{theme}: гигантская крыса не пришла ни в одну из 12 встреч"));
        assert_eq!(rat["size"], "small");
        assert_eq!(rat["image"], "/assets/enemies/giant-rat.png");
    }
}
