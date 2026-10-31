//! Сверка `combat_lab_monsters` с эталоном JS (`fixtures/combat-lab-monsters.json`,
//! генератор `fixtures/gen-combat-lab-monsters.mjs`) и перенос проверок
//! `test/combat-lab-monsters.test.mjs`, касающихся самого модуля.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, hash, parse};
use serde_json::{json, Value};
use sk_combat_content::combat_lab_monsters as m;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/combat-lab-monsters.json")));
static RECORDS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let payload = parse(include_str!("../../../../data/compendia/dnd_5e_2014/monsters.json"));
    array(&payload["monsters"]).to_vec()
});

fn record(slug: &str) -> &'static Value {
    RECORDS.iter().find(|record| record["id"].as_str().is_some_and(|id| id.ends_with(&format!(":{slug}")))).expect("запись бестиария")
}

fn catalog_without_stat_block(record: &Value) -> (Value, String) {
    let mut entry = m::monster_catalog_entry(record);
    let stat_block = entry.as_object_mut().and_then(|map| map.shift_remove("statBlock")).unwrap_or(Value::Null);
    (entry, hash(Some(&stat_block)))
}

#[test]
fn images_match_js() {
    let images: Vec<Value> = m::DND_2014_MONSTER_IMAGES.iter().map(|(id, image)| json!([id, image])).collect();
    assert_eq!(Value::Array(images), FIXTURE["images"]);
}

#[test]
fn real_bestiary_matches_js() {
    let cases = array(&FIXTURE["real"]);
    assert_eq!(cases.len(), RECORDS.len());
    let positions = [json!({ "x": 5, "y": 2 }), json!({ "x": "3", "y": 1.5 }), Value::Null, json!({ "x": "a" })];
    for case in cases {
        let record = &RECORDS[case["record"].as_u64().expect("индекс") as usize];
        let context = record["id"].to_string();
        assert_same(&m::enemy_from_2014(record, Some(&json!({ "x": 5, "y": 2 })), 0.0), &case["enemy"], &format!("enemyFrom2014 {context}"));
        let variants: Vec<String> = positions
            .iter()
            .enumerate()
            .map(|(slot, position)| hash(Some(&m::enemy_from_2014(record, Some(position), if slot == 3 { f64::NAN } else { slot as f64 }))))
            .collect();
        assert_eq!(json!(variants), case["variants"], "варианты позиции и индекса {context}");
        let (entry, stat_block) = catalog_without_stat_block(record);
        assert_same(&entry, &case["catalog"]["entry"], &format!("monsterCatalogEntry {context}"));
        assert_eq!(stat_block, case["catalog"]["statBlock"].as_str().expect("хеш"), "statBlock {context}");
        assert_eq!(json!(m::monster_roles_for(record)), case["roles"], "monsterRolesFor {context}");
        assert_eq!(json!(m::monster_attack_modes_for(record)), case["modes"], "monsterAttackModesFor {context}");
        assert_eq!(json!(m::monster_limitations_for(record)), case["limitations"], "monsterLimitationsFor {context}");
    }
}

#[test]
fn synthetic_records_match_js() {
    let cases = array(&FIXTURE["synthetic"]);
    assert!(cases.len() > 400, "случаев: {}", cases.len());
    for (index, case) in cases.iter().enumerate() {
        let record = &case["record"];
        let context = format!("синтетическая #{index} {}", record["id"]);
        let enemy = m::enemy_from_2014(record, arg(&case["position"]), case["index"].as_f64().expect("индекс"));
        common::assert_js_order(&enemy, &context);
        assert_eq!(hash(Some(&enemy)), case["enemy"].as_str().expect("хеш"), "enemyFrom2014 {context}\n{}", common::stringify(&enemy));
        let (entry, stat_block) = catalog_without_stat_block(record);
        assert_same(&entry, &case["catalog"]["entry"], &format!("monsterCatalogEntry {context}"));
        assert_eq!(stat_block, case["catalog"]["statBlock"].as_str().expect("хеш"), "statBlock {context}");
        assert_eq!(json!(m::monster_roles_for(record)), case["roles"], "monsterRolesFor {context}");
        assert_eq!(json!(m::monster_attack_modes_for(record)), case["modes"], "monsterAttackModesFor {context}");
        assert_eq!(json!(m::monster_limitations_for(record)), case["limitations"], "monsterLimitationsFor {context}");
    }
}

#[test]
fn damage_parsing_matches_js() {
    for case in array(&FIXTURE["damage"]) {
        let parsed = m::parse_monster_damage(arg(&case["expression"])).map_or(Value::Null, |parsed| parsed.to_value());
        assert_same(&parsed, &case["parsed"], &format!("parseMonsterDamage {}", case["expression"]));
    }
}

#[test]
fn every_record_has_a_portrait() {
    for record in RECORDS.iter() {
        let id = record["id"].as_str().expect("id");
        let image = m::dnd_2014_monster_image(id).expect("портрет");
        assert!(sk_core::text::test(sk_core::re!(r"^/assets/enemies/[a-z0-9-]+(?:/[a-z0-9-]+)?\.png$", "u"), image), "{id}");
    }
    assert_eq!(m::DND_2014_MONSTER_IMAGES.len(), RECORDS.len());
}

#[test]
fn conditional_resistance_stays_conditional() {
    let enemy = m::enemy_from_2014(record("fire-elemental"), Some(&json!({ "x": 1, "y": 1 })), 0.0);
    assert_eq!(enemy["damage_resistances"], json!([{ "types": ["bludgeoning", "piercing", "slashing"], "condition": "nonmagical-attacks" }]));
    assert!(array(&enemy["limitations"]).iter().any(|text| text.as_str().is_some_and(|text| text.contains("Защиты с особыми условиями"))));
    let imp = m::enemy_from_2014(record("imp"), Some(&json!({ "x": 1, "y": 1 })), 0.0);
    assert_eq!(
        imp["damage_resistances"],
        json!(["cold", { "types": ["bludgeoning", "piercing", "slashing"], "condition": "nonmagical-attacks-except-silvered", "qualifier": "except-silvered" }])
    );
}

#[test]
fn mapper_keeps_stat_block_and_declares_limitations() {
    for (slug, text) in [("goblin", "скрытность бонусным действием"), ("bandit-captain", "Реакция «Парирование»")] {
        let enemy = m::enemy_from_2014(record(slug), Some(&json!({ "x": 5, "y": 2 })), 0.0);
        assert_eq!(enemy["mechanics_status"], "partial", "{slug}");
        assert!(array(&enemy["limitations"]).iter().any(|entry| entry.as_str().is_some_and(|entry| entry.contains(text))), "{slug}: {text}");
    }
    for source in RECORDS.iter() {
        let enemy = m::enemy_from_2014(source, Some(&json!({ "x": 5, "y": 2 })), 0.0);
        for key in ["skills", "saving_throws", "bonus_actions", "reactions"] {
            assert_eq!(enemy[key], source[key], "{} {key}", source["id"]);
        }
        assert_eq!(enemy["provenance"]["stat_block_id"], source["id"]);
    }
}

#[test]
fn roles_follow_mm14_profile() {
    assert_eq!(m::monster_roles_for(record("kobold")), ["artillery", "frontliner", "skirmisher", "minion"]);
    assert_eq!(m::monster_roles_for(record("acolyte")), ["caster", "support", "frontliner", "minion"]);
    assert_eq!(m::monster_roles_for(record("young-red-dragon")), ["controller", "frontliner", "multiattack", "flying", "skirmisher", "brute", "solo"]);
    assert_eq!(m::monster_attack_modes_for(record("giant-spider")), ["melee", "ranged"]);
    let dragon = m::enemy_from_2014(record("young-red-dragon"), Some(&json!({ "x": 5, "y": 2 })), 0.0);
    assert_eq!(dragon["attack_modes"], json!(["melee"]));
    assert_eq!(dragon["habitats"], json!(["mountain", "hill"]));
    assert_eq!(dragon["speed_ft"], json!({ "walk": 40, "fly": 80, "climb": 40 }));
}

#[test]
fn expanded_set_keeps_source_and_primary_attack() {
    for (slug, cr, xp, action) in [
        ("gnoll", "1/2", 100, "longbow"),
        ("harpy", "1", 200, "claws"),
        ("giant-boar", "2", 450, "tusk"),
        ("minotaur", "3", 700, "greataxe"),
        ("veteran", "3", 700, "longsword"),
        ("manticore", "3", 700, "bite"),
        ("hill-giant", "5", 1800, "greatclub"),
        ("fire-elemental", "5", 1800, "touch"),
        ("displacer-beast", "3", 700, "tentacle"),
        ("wyvern", "6", 2300, "bite"),
    ] {
        let enemy = m::enemy_from_2014(record(slug), Some(&json!({ "x": 5, "y": 2 })), 0.0);
        assert_eq!(enemy["challenge_rating"], cr, "{slug}");
        assert_eq!(enemy["xp"], xp, "{slug}");
        assert!(array(&enemy["action_profiles"]).iter().any(|profile| profile["id"] == action), "{slug}: {action}");
    }
    let wyvern = m::enemy_from_2014(record("wyvern"), Some(&json!({ "x": 5, "y": 2 })), 0.0);
    let stinger = array(&wyvern["action_profiles"]).iter().find(|profile| profile["id"] == "stinger").expect("жало");
    assert_eq!(stinger["on_hit"]["save_dc"], 15);
    assert_eq!(stinger["on_hit"]["damage_expression"], "7d6");
    let manticore = m::enemy_from_2014(record("manticore"), Some(&json!({ "x": 5, "y": 2 })), 0.0);
    assert_eq!(array(&manticore["action_profiles"]).iter().find(|profile| profile["id"] == "tail-spike").expect("шипы")["uses"], 24);
}

#[test]
fn catalog_entry_for_goblin() {
    let entry = m::monster_catalog_entry(record("goblin"));
    assert_eq!(entry["statBlock"], *record("goblin"));
    assert_eq!(entry["images"], json!(["/assets/enemies/goblin.png", "/assets/enemies/goblin-minion.png"]));
    assert_eq!(entry["roles"], json!(["artillery", "frontliner", "minion"]));
    assert_eq!(entry["attackModes"], json!(["melee", "ranged"]));
    assert_eq!(entry["limitations"], json!(["Ловкое бегство позволяет отойти бонусным действием; скрытность бонусным действием пока не выбирается автоматически."]));
    let goblin = m::enemy_from_2014(record("goblin"), Some(&json!({ "x": 5, "y": 2 })), 0.0);
    let bow = array(&goblin["action_profiles"]).iter().find(|profile| profile["id"] == "shortbow").expect("лук");
    assert_eq!((bow["kind"].clone(), bow["damage_expression"].clone(), bow["normal_range_feet"].clone(), bow["range_feet"].clone()), (json!("ranged"), json!("1d6+2"), json!(80), json!(320)));
}
