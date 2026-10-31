//! Смысловые проверки `combat_lab_setup` из `test/combat-lab-setup.test.mjs`,
//! `test/combat-lab-encounter.test.mjs` и `test/npc-component-loadouts.test.mjs`,
//! плюс событийное хранилище как источник героев стенда.

use std::sync::Arc;

use serde_json::{json, Value};
use sk_tactics::combat_lab_setup::{
    assess_combat_lab_encounter, build_combat_lab_state, combat_lab_catalog, combat_lab_heroes, generate_combat_lab_encounter, CampaignRooms, CombatLabSetupError,
    EncounterOptions, NoRooms, Sources,
};

fn source_campaign() -> Value {
    json!({
        "sessionCode": "SOURCE-2014",
        "ruleset_id": "dnd_5e_2014",
        "ruleset_version": "2014.1.0",
        "enabled_rule_packs": ["dnd_5e_2014"],
        "players": [{
            "id": "source-hero", "name": "Исходный герой", "character": "Исходный герой", "characterClass": "fighter",
            "level": 1, "hp": 7, "maxHp": 12, "armor": 16, "speed": 30,
            "abilities": { "str": 16, "dex": 12, "con": 14, "int": 10, "wis": 10, "cha": 8 },
            "inventory": [{ "id": "source-sword", "name": "Меч", "type": "weapon", "quantity": 1, "equipped": true }],
            "knownSpellIds": ["bless"], "preparedSpellIds": ["bless"], "x": 0, "y": 0,
        }],
    })
}

fn code(result: Result<Value, CombatLabSetupError>) -> Option<String> {
    result.err().and_then(|error| error.code)
}

#[test]
fn catalog_and_builder_use_2014_only() {
    let source = source_campaign();
    let load = |id: &str| -> Result<Option<Value>, CombatLabSetupError> {
        assert_eq!(id, "SOURCE-2014");
        Ok(Some(source.clone()))
    };
    let sources = Sources::new(&NoRooms, Some(&load));
    let catalog = combat_lab_catalog(&sources).expect("каталог");
    assert_eq!(catalog["limits"], json!({ "party": 6, "enemies": 12 }));
    assert_eq!(catalog["classes"][0]["id"], "fighter");
    let monsters = catalog["monsters"].as_array().expect("монстры");
    assert!(monsters.iter().any(|entry| entry["id"] == "dnd_5e_2014:monster:goblin" && entry["sourceUrl"].as_str().is_some_and(|url| url.contains("dnd.su"))));
    let maps = catalog["maps"].as_array().expect("карты");
    assert_eq!(maps.len(), 7);
    let tail: Vec<Value> = maps[4..].iter().map(|map| map["id"].clone()).collect();
    assert_eq!(tail, [json!("forest-clearing"), json!("cavern-bridge"), json!("watchtower-terrace")]);

    let config = json!({
        "mapId": "open-courtyard",
        "party": [
            { "source": "hero", "campaignId": "SOURCE-2014", "heroId": "source-hero", "x": 0, "y": 0 },
            { "source": "class", "classId": "fighter", "level": 3, "x": 1, "y": 0 },
        ],
        "enemies": [{ "monsterId": "dnd_5e_2014:monster:goblin", "x": 8, "y": 5 }],
    });
    let state = build_combat_lab_state(Some(&config), &sources).expect("сборка");
    assert_eq!(state["ruleset_id"], "dnd_5e_2014");
    assert_eq!(state["ruleset_version"], "2014.1.0");
    assert_eq!(state["enabled_rule_packs"], json!(["dnd_5e_2014"]));
    assert_eq!(state["players"][0]["name"], "Исходный герой");
    assert_eq!(state["players"][0]["source_hero_id"], "source-hero");
    assert_eq!(state["players"][0]["inventory"][0]["source_item_id"], "source-sword");
    assert_eq!(source, source_campaign(), "источник не меняется");
}

#[test]
fn builder_rejects_raw_state_forged_ids_limits_and_walls() {
    let sources = Sources::default();
    let fighter = json!({ "source": "class", "classId": "fighter", "level": 1, "x": 0, "y": 0 });
    let goblin = json!({ "monsterId": "dnd_5e_2014:monster:goblin", "x": 8, "y": 5 });
    let build = |config: Value| build_combat_lab_state(Some(&config), &sources);
    assert_eq!(code(build(json!({ "mapId": "open-courtyard", "state": {}, "party": [fighter], "enemies": [goblin] }))).as_deref(), Some("UNEXPECTED_COMBAT_LAB_FIELD"));
    let minion = json!({ "mapId": "open-courtyard", "party": [fighter], "enemies": [{ "monsterId": "srd_5_2_1:goblin-minion", "x": 8, "y": 5 }] });
    assert_eq!(code(build(minion)).as_deref(), Some("UNKNOWN_COMBAT_LAB_MONSTER"));
    let seven: Vec<Value> = (0..7).map(|x| json!({ "source": "class", "classId": "fighter", "level": 1, "x": x, "y": 0 })).collect();
    assert_eq!(code(build(json!({ "mapId": "open-courtyard", "party": seven, "enemies": [goblin] }))).as_deref(), Some("PARTY_LIMIT_EXCEEDED"));
    let wall = json!({ "mapId": "ruined-hall", "party": [{ "source": "class", "classId": "fighter", "level": 1, "x": 5, "y": 0 }], "enemies": [goblin] });
    assert_eq!(code(build(wall)).as_deref(), Some("PLACEMENT_BLOCKED"));
    let load = |_: &str| -> Result<Option<Value>, CombatLabSetupError> { Ok(Some(json!({ "ruleset_id": "srd_5_2_1", "players": [{ "id": "source-hero", "level": 1, "maxHp": 10, "hp": 10, "inventory": [] }] }))) };
    let foreign = Sources::new(&NoRooms, Some(&load));
    let config = json!({ "mapId": "open-courtyard", "party": [{ "source": "hero", "campaignId": "SOURCE-2024", "heroId": "source-hero", "x": 0, "y": 0 }], "enemies": [goblin] });
    assert_eq!(code(build_combat_lab_state(Some(&config), &foreign)).as_deref(), Some("SOURCE_RULESET_UNSUPPORTED"));
}

#[test]
fn training_profile_and_monster_spellcasting() {
    let sources = Sources::default();
    let config = json!({ "mapId": "open-courtyard", "party": [{ "source": "class", "classId": "wizard", "level": 12, "x": 0, "y": 0 }], "enemies": [{ "monsterId": "dnd_5e_2014:monster:goblin", "x": 8, "y": 5 }] });
    let wizard = build_combat_lab_state(Some(&config), &sources).expect("волшебник");
    let hero = &wizard["players"][0];
    assert_eq!((hero["level"].as_i64(), hero["proficiency"].as_i64()), (Some(12), Some(4)));
    let known = hero["knownSpellIds"].as_array().expect("заклинания");
    assert!(known.contains(&json!("fireball")) && known.contains(&json!("scorching-ray")));
    let id = hero["id"].as_str().expect("id");
    assert!(wizard["mechanics"]["resources"][id]["spell_slots_5"]["max"].as_i64().unwrap_or(0) > 0);

    let config = json!({
        "mapId": "open-courtyard",
        "party": [{ "source": "class", "classId": "fighter", "level": 1, "x": 0, "y": 0 }],
        "enemies": [{ "monsterId": "dnd_5e_2014:monster:mage", "x": 8, "y": 5 }, { "monsterId": "dnd_5e_2014:monster:cult-fanatic", "x": 7, "y": 5 }],
    });
    let casters = build_combat_lab_state(Some(&config), &sources).expect("заклинатели");
    let enemies = casters["enemies"].as_array().expect("враги");
    let by_suffix = |suffix: &str| enemies.iter().find(|enemy| enemy["stat_block_id"].as_str().is_some_and(|id| id.ends_with(suffix))).expect("враг");
    let mage = by_suffix(":mage");
    let fanatic = by_suffix(":cult-fanatic");
    assert!(mage["spellcasting"]["spells"].as_array().expect("список").iter().any(|spell| spell["id"] == "fireball"));
    assert!(fanatic["traits"].as_array().expect("черты").iter().any(|t| t["id"] == "multiattack" && t["sequence"].as_array().map(Vec::len) == Some(2)));
    let mage_id = mage["id"].as_str().expect("id");
    assert_eq!(casters["mechanics"]["resources"][mage_id]["spell_slots_1"]["max"], 4);
    assert_eq!(casters["mechanics"]["resources"][mage_id]["spell_slots_3"]["max"], 3);
    assert!(mage["loadout"]["items"].as_array().expect("инвентарь").iter().any(|item| item["catalog_id"] == "srd_5_2_1:component-pouch"));
}

#[test]
fn assessment_counts_actual_xp_and_generation_is_seeded() {
    let options = EncounterOptions::default();
    let party = json!([{ "source": "class", "classId": "fighter", "level": 3, "x": 0, "y": 0 }, { "source": "class", "classId": "wizard", "level": 2, "x": 1, "y": 0 }]);
    let request = json!({ "config": { "mapId": "open-courtyard", "party": party, "enemies": [] }, "difficulty": "medium", "seed": 17 });
    let empty = assess_combat_lab_encounter(Some(&request), &options).expect("пусто");
    assert_eq!((empty["rawXp"].as_i64(), empty["difficulty"].as_str(), empty["matched"].as_bool()), (Some(0), Some("trivial"), Some(false)));
    assert!(!empty["warnings"].as_array().expect("предупреждения").is_empty());
    let request = json!({ "config": { "mapId": "open-courtyard", "party": [{ "source": "class", "classId": "fighter", "level": 1 }], "enemies": [{ "monsterId": "dnd_5e_2014:monster:goblin" }] }, "difficulty": "hard", "seed": 17 });
    let goblin = assess_combat_lab_encounter(Some(&request), &options).expect("гоблин");
    assert_eq!((goblin["rawXp"].as_i64(), goblin["adjustedXp"].as_i64(), goblin["multiplier"].as_f64()), (Some(50), Some(75), Some(1.5)));
    assert_eq!(goblin["monsterBreakdown"], json!([{ "id": "dnd_5e_2014:monster:goblin", "name": "Гоблин", "cr": "1/4", "xp": 50, "count": 1 }]));

    let request = json!({ "config": { "mapId": "ruined-hall", "party": party }, "difficulty": "hard", "seed": "same-seed", "theme": "goblinoids" });
    let first = generate_combat_lab_encounter(Some(&request), &options).expect("генерация");
    assert_eq!(generate_combat_lab_encounter(Some(&request), &options).expect("повтор"), first);
    let count = first["config"]["enemies"].as_array().map_or(0, Vec::len);
    assert!((1..=4).contains(&count));
    assert_eq!(first["assessment"]["matched"], true);
    let state = build_combat_lab_state(Some(&first["config"]), &Sources::default()).expect("стенд собирает");
    assert_eq!(state["enemies"].as_array().map(Vec::len), Some(count));
    let bad = json!({ "mapId": "open-courtyard", "party": party, "difficulty": "trivial", "seed": 1 });
    assert_eq!(code(generate_combat_lab_encounter(Some(&bad), &options)).as_deref(), Some("INVALID_COMBAT_LAB_DIFFICULTY"));
}

#[test]
fn event_store_is_a_campaign_source() {
    let dir = std::env::temp_dir().join(format!("sk-t3-store-{}", sk_core::hash::uuid_v4()));
    std::fs::create_dir_all(&dir).expect("каталог");
    let store = sk_store::EventStore::open(dir.join("events.sqlite"), Arc::new(sk_store::VersionOnlyReducer), sk_store::StoreOptions::default()).expect("хранилище");
    store.initialize_campaign(sk_store::InitializeRequest::new("SOURCE-2014", source_campaign())).expect("кампания");
    let sources = Sources::new(&store, None);
    let heroes = combat_lab_heroes(&sources).expect("герои");
    assert_eq!(heroes, vec![json!({ "id": "source-hero", "campaignId": "SOURCE-2014", "name": "Исходный герой", "className": "Воин", "level": 1 })]);
    let config = json!({
        "mapId": "open-courtyard",
        "party": [{ "source": "hero", "campaignId": "source-2014", "heroId": "source-hero", "x": 0, "y": 0 }],
        "enemies": [{ "monsterId": "dnd_5e_2014:monster:goblin", "x": 8, "y": 5 }],
    });
    let state = build_combat_lab_state(Some(&config), &sources).expect("сборка из журнала");
    assert_eq!(state["players"][0]["source_campaign_id"], "SOURCE-2014");
    assert_eq!(store.room_state("MISSING").expect("нет кампании"), None);
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}
