//! Сверка `combat_spells` с эталоном JS (`fixtures/combat-spells.json`,
//! генератор `fixtures/gen-combat-spells.mjs`): карточки героев всех классов
//! на уровнях 1–12 в обеих редакциях, каталожные карточки, блоки заклинателей
//! бестиария и синтетические.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, hash, parse, stringify};
use serde_json::{json, Value};
use sk_combat_content::combat_spells as m;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/combat-spells.json")));

fn refusal_value(refusal: Option<(String, &'static str)>) -> Value {
    refusal.map_or(Value::Null, |(message, code)| json!([message, code]))
}

#[test]
fn constants_and_catalog_info_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["DND_2014_TIMED_BUFF_EXPIRY_POLICY"], m::DND_2014_TIMED_BUFF_EXPIRY_POLICY);
    assert_eq!(constants["MONSTER_SPELL_AT_WILL"], m::MONSTER_SPELL_AT_WILL);
    assert_eq!(constants["MONSTER_SPELL_USE_CONDITION_PREFIX"], m::MONSTER_SPELL_USE_CONDITION_PREFIX);
    for case in array(&FIXTURE["catalogInfo"]) {
        assert_same(&m::spell_catalog_info(arg(&case["options"])), &case["info"], "spellCatalogInfo");
    }
}

#[test]
fn hero_spell_cards_match_js() {
    let heroes = array(&FIXTURE["heroes"]);
    assert!(heroes.len() > 900, "героев: {}", heroes.len());
    let mut cards_checked = 0;
    for (index, case) in heroes.iter().enumerate() {
        let actor = arg(&case["actor"]);
        let options = arg(&case["options"]);
        let context = format!("герой #{index}: {}", stringify(&case["actor"]));
        let cards = m::combat_spells_for(actor, options);
        let expected = array(&case["cards"]);
        let actual_ids: Vec<&Value> = cards.iter().map(|card| &card["id"]).collect();
        let expected_ids: Vec<&Value> = expected.iter().map(|pair| &pair[0]).collect();
        assert_eq!(actual_ids, expected_ids, "набор карточек: {context}");
        for (card, pair) in cards.iter().zip(expected) {
            common::assert_js_order(card, &context);
            assert_eq!(hash(Some(card)), pair[1].as_str().expect("хеш"), "карточка {}: {context}\n{}", pair[0], stringify(card));
            cards_checked += 1;
        }
        let rules = m::spell_selection_rules_for(actor).map_or(Value::Null, |rules| rules.to_value());
        assert_same(&rules, &case["rules"], &format!("spellSelectionRulesFor, {context}"));
        assert_same(&m::normalized_spell_selections_for(actor), &case["selections"], &format!("normalizedSpellSelectionsFor, {context}"));
        assert_same(&m::hero_spellcasting_summary_for(actor).unwrap_or(Value::Null), &case["summary"], &format!("heroSpellcastingSummaryFor, {context}"));
        assert_same(&m::spell_slot_maximums_for(actor), &case["slots"], &format!("spellSlotMaximumsFor, {context}"));
        let attack: Vec<i64> = ["int", "wis", "cha", "str"].iter().map(|ability| m::hero_spell_attack_modifier(actor, ability)).collect();
        assert_eq!(json!(attack), case["attack"], "heroSpellAttackModifier, {context}");
        let probes = ["fire-bolt", "eldritch-blast", "cure-wounds", "hex", "light", "magic-missile", "nope"]
            .iter()
            .map(|id| Value::from(*id))
            .chain([Value::Null])
            .map(|id| hash(Some(&m::combat_spell_for(actor, Some(&id), options).unwrap_or(Value::Null))))
            .collect::<Vec<_>>();
        assert_eq!(json!(probes), case["probes"], "combatSpellFor, {context}");
        let fixed: Vec<Value> = slot_profiles().iter().map(|spell| m::fixed_spell_slot_level_for(actor, arg(spell)).unwrap_or(Value::Null)).collect();
        let expected_fixed: Vec<Value> = array(&case["fixed"]).iter().map(|value| arg(value).cloned().unwrap_or(Value::Null)).collect();
        assert_eq!(stringify(&json!(fixed)), stringify(&json!(expected_fixed)), "fixedSpellSlotLevelFor, {context}");
    }
    assert!(cards_checked > 40_000, "карточек: {cards_checked}");
}

fn slot_profiles() -> Vec<Value> {
    vec![
        json!({ "level": 3, "slotResource": "pact_slots" }),
        json!({ "level": 6, "slotResource": "mystic_arcanum_6" }),
        json!({ "level": 1, "slotResource": "species_spell_x", "innateCastLevel": 3 }),
        json!({ "level": 2, "slotResource": "species_spell_x", "innateCastLevel": 0 }),
        json!({ "level": 0, "slotResource": "pact_slots" }),
        json!({ "level": 2, "slotResource": "spell_slots_2" }),
        Value::Null,
        json!({ "level": "2", "slotResource": "species_spell_x" }),
        json!({ "slotResource": "pact_slots" }),
        json!({ "level": 4, "slotResource": "species_spell_x", "innateCastLevel": "6" }),
        json!({ "level": 2 }),
    ]
}

#[test]
fn canonical_cards_match_js() {
    let options = [
        None,
        Some(json!("dnd_5e_2014")),
        Some(json!({ "rulesetId": "dnd_5e_2014" })),
        Some(json!({ "ruleset_id": "dnd_5e_2014" })),
        Some(json!({ "rulesetId": null, "ruleset_id": "dnd_5e_2014" })),
        Some(json!({ "rulesetId": 5 })),
    ];
    let cases = array(&FIXTURE["canonical"]);
    assert_eq!(cases.len(), 440);
    for case in cases {
        let id = &case["id"];
        let hashes: Vec<String> = options.iter().map(|option| hash(Some(&m::canonical_combat_spell_for(Some(id), option.as_ref()).unwrap_or(Value::Null)))).collect();
        assert_eq!(json!(hashes), case["cards"], "canonicalCombatSpellFor {id}");
    }
    for case in array(&FIXTURE["canonicalFull"]) {
        let card = m::canonical_combat_spell_for(Some(&case["id"]), arg(&case["options"])).unwrap_or(Value::Null);
        assert_same(&card, &case["card"], &format!("canonicalCombatSpellFor {} {}", case["id"], case["options"]));
    }
}

#[test]
fn monster_spellcasting_matches_js() {
    for (index, case) in array(&FIXTURE["monsters"]).iter().enumerate() {
        let actor = arg(&case["actor"]);
        let context = format!("существо #{index}");
        let block = m::monster_spellcasting_for(actor).map_or(Value::Null, |block| block.to_value());
        assert_same(&block, &case["block"], &format!("monsterSpellcastingFor, {context}"));
        assert_eq!(json!(m::monster_spellcasting_issues(actor)), case["issues"], "monsterSpellcastingIssues, {context}");
        assert_same(&m::spell_slot_maximums_for(actor), &case["slots"], &format!("spellSlotMaximumsFor, {context}"));
        for spell in array(&case["spells"]) {
            let id = &spell["id"];
            let entry = m::monster_spell_entry_for(actor, Some(id)).map_or(Value::Null, |entry| entry.to_value());
            assert_same(&entry, &spell["entry"], &format!("monsterSpellEntryFor {id}, {context}"));
            assert_eq!(refusal_value(m::monster_spell_refusal_for(actor, Some(id))), spell["refusal"], "monsterSpellRefusalFor {id}, {context}");
            let cards: Vec<Value> = [None, Some(json!("dnd_5e_2014"))]
                .iter()
                .map(|options| m::monster_combat_spell_for(actor, Some(id), options.as_ref()).map_or(Value::Null, |card| Value::from(hash(Some(&card)))))
                .collect();
            assert_eq!(json!(cards), spell["cards"], "monsterCombatSpellFor {id}, {context}");
        }
    }
    let full = array(&FIXTURE["monsterFull"]);
    assert!(full.len() >= 8);
    for case in full {
        let card = m::monster_combat_spell_for(Some(&case["actor"]), Some(&case["id"]), Some(&json!("dnd_5e_2014"))).unwrap_or(Value::Null);
        assert_same(&card, &case["card"], &format!("monsterCombatSpellFor {} {}", case["slug"], case["id"]));
    }
}

#[test]
fn monster_spell_markers_and_summons_match_js() {
    for case in array(&FIXTURE["spent"]) {
        let ids: Vec<&str> = array(&case["ids"]).iter().filter_map(Value::as_str).collect();
        let count = m::monster_spell_uses_spent_in(ids, case["spell"].as_str().unwrap_or_default());
        assert_eq!(json!(count), case["count"], "monsterSpellUsesSpentIn {case}");
    }
    for case in array(&FIXTURE["summons"]) {
        let actor = arg(&case["actor"]);
        assert_eq!(json!(m::is_party_summon(actor)), case["party"], "isPartySummon {case}");
        assert_eq!(json!(m::is_hostile_summon(actor)), case["hostile"], "isHostileSummon {case}");
        assert_eq!(json!(m::is_untargetable_summon(actor)), case["untargetable"], "isUntargetableSummon {case}");
    }
}

/// `test/combat-lab-monsters.test.mjs`: «Flameskull сохраняет явно объявленное
/// освобождение от жестов и материалов» — в части модуля заклинаний.
#[test]
fn monster_block_waives_declared_components_in_2014() {
    let actor = json!({ "spellcasting": {
        "ability": "int", "save_dc": 13, "attack_bonus": 5,
        "spells": [{ "id": "fireball", "uses": 2, "components_required": ["verbal"], "components_not_required": ["somatic", "material"] }],
    } });
    let spell = m::monster_combat_spell_for(Some(&actor), Some(&json!("fireball")), Some(&json!({ "rulesetId": "dnd_5e_2014" }))).expect("карточка");
    assert_eq!(spell["components"], json!({ "verbal": true, "somatic": false, "material": null }));
    assert_eq!(spell["monsterSpell"]["perDay"], json!(2));
    assert_eq!(spell["monsterSpell"]["saveDc"], json!(13));
    // Без редакции 2014 компонентов у карточки нет вовсе.
    let legacy = m::monster_combat_spell_for(Some(&actor), Some(&json!("fireball")), None).expect("карточка");
    assert!(legacy.get("components").is_none());
}

/// `test/hero-spellcasting-summary.test.mjs` и `test/warlock-invocations.test.mjs`
/// в части модуля: СЛ и бонус атаки листа героя, дальность Мистического копья.
#[test]
fn hero_summary_and_eldritch_spear() {
    let wizard = json!({ "characterClass": "wizard", "level": 5, "proficiency": 3, "abilities": { "int": 18 } });
    assert_eq!(m::hero_spellcasting_summary_for(Some(&wizard)), Some(json!({ "ability": "int", "attack_bonus": 7, "save_dc": 15 })));
    assert_eq!(m::hero_spellcasting_summary_for(Some(&json!({ "characterClass": "fighter", "level": 5 }))), None);
    let warlock = json!({ "characterClass": "warlock", "level": 3, "abilities": { "cha": 16 }, "selectedFeatureIds": ["eldritch-spear"] });
    let blast = m::combat_spell_for(Some(&warlock), Some(&json!("eldritch-blast")), None).expect("заряд");
    assert_eq!(blast["range"], json!(300));
    assert_eq!(blast["slotResource"], Value::Null);
    let plain = json!({ "characterClass": "warlock", "level": 3, "abilities": { "cha": 16 } });
    assert_ne!(m::combat_spell_for(Some(&plain), Some(&json!("eldritch-blast")), None).expect("заряд")["range"], json!(300));
}

/// Договор колдуна: ячейки договора и «Таинственный арканум» 6-го круга.
#[test]
fn warlock_pact_slots_follow_level() {
    let warlock = |level: i64| json!({ "characterClass": "warlock", "level": level });
    assert_eq!(m::spell_slot_maximums_for(Some(&warlock(1))), json!({ "pact_slots": 1 }));
    assert_eq!(m::spell_slot_maximums_for(Some(&warlock(11))), json!({ "pact_slots": 3, "mystic_arcanum_6": 1 }));
    let fireball = json!({ "level": 3, "slotResource": "pact_slots" });
    assert_eq!(m::fixed_spell_slot_level_for(Some(&warlock(9)), Some(&fireball)), Some(json!(5)));
    assert_eq!(m::fixed_spell_slot_level_for(Some(&json!({ "characterClass": "wizard", "level": 9 })), Some(&fireball)), Some(json!(3)));
    assert_eq!(m::fixed_spell_slot_level_for(Some(&warlock(9)), Some(&json!({ "level": 1, "slotResource": "spell_slots_1" }))), None);
}
