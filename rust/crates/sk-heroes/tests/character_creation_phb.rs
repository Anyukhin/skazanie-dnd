//! Сверка `character_creation_phb` с эталоном JS и перенос проверок модуля из
//! `test/character-creation-phb-complete.test.mjs` и
//! `test/magic-initiate-focus.test.mjs` (импорт через character-lifecycle,
//! Rules Engine и replay туда не входят — только сама сборка выборов PHB).

mod common;

use common::{check, ok, runtime, thrown, Args, Outcome};
use serde_json::{json, Value};
use sk_heroes::character_creation_phb as m;
use sk_ruleset::character_creation_catalog::{default_species_choices, species_benefits_for};
use sk_ruleset::character_creation_class_options::{class_option_for, PHB_2014_CLASS_KEYS, PHB_2014_SKILLS};

const FIXTURE: &str = include_str!("../fixtures/character-creation-phb.json");
const RULESET: &str = "dnd_5e_2014";

fn outcome(result: Result<Option<Value>, m::PhbCreationError>) -> Outcome {
    match result {
        Ok(value) => Ok(Some(value.unwrap_or(Value::Null))),
        Err(m::PhbCreationError::Invalid(message)) => Err(thrown("TypeError", None, &message)),
        Err(m::PhbCreationError::Runtime(message)) => Err(runtime(&message)),
    }
}

#[test]
fn character_creation_phb_matches_js() {
    let count = check(FIXTURE, |name, args: &Args| -> Outcome {
        match name {
            "const:PHB_FIGHTING_STYLES" => ok(m::phb_fighting_styles_json()),
            "phbSpellId" => ok(json!(m::phb_spell_id(args.get(0)))),
            "phbToolId" => ok(json!(m::phb_tool_id(args.get(0)))),
            "phbFirstLevelSpells" => outcome(m::phb_first_level_spells().map(|spells| Some(Value::Array(spells)))),
            "phbCreationCatalog" => outcome(m::phb_creation_catalog().map(Some)),
            "resolvePhbCreation" => outcome(m::resolve_phb_creation(args.get(0))),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 1400, "{count}");
}

/// `makeCharacter` из `test/character-creation-phb-complete.test.mjs`:
/// документ героя первого уровня с мудрецом-предысторией.
fn make_character(class_id: &str, species_id: &str, feat: Option<Value>, extra_choices: Value) -> Value {
    let klass = class_option_for(Some(&json!(class_id))).expect("класс PHB");
    let count = klass["skill_choice"]["count"].as_u64().unwrap_or_default() as usize;
    let skills: Vec<Value> = klass["skill_choice"]["options"].as_array().cloned().unwrap_or_default().into_iter().take(count).collect();
    let species_choices = default_species_choices(species_id, RULESET).expect("редакция").unwrap_or(Value::Null);
    let species = species_benefits_for(species_id, RULESET, Some(&species_choices)).expect("редакция").expect("вид");
    let mut granted: Vec<Value> = skills.clone();
    granted.extend(species["skill_proficiencies"].as_array().cloned().unwrap_or_default());
    granted.extend([json!("arcana"), json!("history")]);
    let mut known: Vec<Value> = Vec::new();
    for skill in &granted {
        if !known.contains(skill) {
            known.push(skill.clone());
        }
    }
    let replacement_skills: Vec<&str> = PHB_2014_SKILLS.iter().copied().filter(|skill| !known.contains(&json!(skill))).take(granted.len() - known.len()).collect();
    let mut choices = match class_id {
        "bard" => json!({ "instruments": ["lute", "drum", "flute"] }),
        "monk" => json!({ "tool_or_instrument": { "kind": "artisan_tool", "id": "smiths_tools" } }),
        "rogue" => json!({ "expertise": [skills[0], skills[1]] }),
        "ranger" => json!({ "favored_enemy": { "type": "undead", "language": null }, "natural_explorer": "forest" }),
        "sorcerer" => json!({ "draconic_ancestry": "red" }),
        _ => json!({}),
    };
    if let (Some(choices), Value::Object(extra)) = (choices.as_object_mut(), extra_choices) {
        choices.extend(extra);
    }
    let subclass = match class_id {
        "cleric" => Some("Домен жизни"),
        "sorcerer" => Some("Наследие драконьей крови"),
        "warlock" => Some("Исчадие"),
        _ => None,
    };
    let origin_bonuses = if species_id == "human-variant" {
        json!({ "str": 1, "dex": 1, "con": 0, "int": 0, "wis": 0, "cha": 0 })
    } else {
        json!({ "str": 1, "dex": 1, "con": 1, "int": 1, "wis": 1, "cha": 1 })
    };
    let mut phb = json!({ "schema_version": 1, "classChoices": choices });
    if let Some(feat) = feat {
        phb["feat"] = feat;
    }
    let mut source = json!({
        "character": "Проверка PHB", "characterClass": class_id, "level": 1, "experience": 0,
        "abilityGeneration": {
            "method": "standard_array", "baseScores": { "str": 15, "dex": 14, "con": 13, "int": 12, "wis": 10, "cha": 8 },
            "originBonuses": origin_bonuses, "originBonusProfileId": species_id, "speciesOptionId": species_id,
        },
        "baseSpeed": 30, "speciesChoices": species_choices, "classSkillProficiencies": skills,
        "selectedFeatureIds": if class_id == "fighter" { json!(["fighting-style-defense"]) } else { json!([]) },
        "backgroundId": "sage",
        "backgroundChoices": { "tools": [], "languages": ["giant", "gnomish"], "replacementSkills": replacement_skills, "replacementTools": [] },
        "phbCreation": phb,
    });
    if let Some(subclass) = subclass {
        source["subclass"] = json!(subclass);
    }
    source
}

fn resolve(source: &Value) -> Result<Value, String> {
    match m::resolve_phb_creation(Some(source)) {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err("нет phbCreation".into()),
        Err(error) => Err(error.message().to_string()),
    }
}

/// «полное создание всех двенадцати PHB-классов»: выборы каждого класса
/// собираются, домен жизни даёт свои заклинания, драконья кровь — КД без
/// доспеха, плут — мастерство.
#[test]
fn every_phb_class_resolves() {
    for class_id in PHB_2014_CLASS_KEYS {
        let result = resolve(&make_character(class_id, "human", None, json!({}))).unwrap_or_else(|error| panic!("{class_id}: {error}"));
        let benefits = &result["benefits"];
        assert_eq!(benefits["class"]["class_key"], json!(class_id));
        let has = |key: &str, id: &str| benefits[key].as_array().is_some_and(|list| list.contains(&json!(id)));
        match class_id {
            "cleric" => {
                assert!(has("domain_spells", "bless") && has("domain_spells", "cure-wounds"));
                assert_eq!(benefits["domain_spell_names"].as_array().map(Vec::len), Some(2));
            }
            "sorcerer" => assert_eq!(benefits["unarmored_armor_class"], json!({ "base": 13, "dexterity_modifier": true })),
            "rogue" => {
                assert!(!benefits["expertise"].as_array().cloned().unwrap_or_default().is_empty());
                assert!(has("languages", "thieves-cant"));
            }
            "druid" => assert!(has("languages", "druidic")),
            _ => {}
        }
    }
}

/// «вариантный человек получает выбранную черту, её ОЗ и ограничения».
#[test]
fn variant_human_takes_one_feat_with_prerequisites() {
    let tough = resolve(&make_character("fighter", "human-variant", Some(json!({ "id": "tough", "choices": {} })), json!({}))).expect("Крепкий");
    assert_eq!(tough["benefits"]["feat"]["id"], json!("tough"));
    assert_eq!(tough["benefits"]["extra_hit_points_per_level"], json!(2));
    assert_eq!(tough["value"]["feat"], json!({ "id": "tough", "choices": {} }));
    let missing = resolve(&make_character("fighter", "human-variant", None, json!({}))).expect_err("без черты");
    assert!(missing.contains("должен выбрать"), "{missing}");
    let war_caster = resolve(&make_character("fighter", "human-variant", Some(json!({ "id": "war-caster", "choices": {} })), json!({}))).expect_err("без магии");
    assert!(war_caster.contains("требования"), "{war_caster}");
    let not_variant = resolve(&make_character("fighter", "human", Some(json!({ "id": "tough" })), json!({}))).expect_err("не вариантный");
    assert_eq!(not_variant, "Черта при создании доступна только вариантному человеку");
}

/// «PHB-модель отвергает неполный выбор … классовых инструментов» и боевой
/// стиль вне шести стилей PHB.
#[test]
fn incomplete_class_choices_are_refused() {
    let bard = resolve(&make_character("bard", "human", None, json!({ "instruments": ["lute"] }))).expect_err("один инструмент");
    assert!(bard.contains("инструмент"), "{bard}");
    let mut fighter = make_character("fighter", "human", None, json!({}));
    fighter["selectedFeatureIds"] = json!(["fighter-perehvat"]);
    let style = resolve(&fighter).expect_err("чужой стиль");
    assert!(style.contains("шести"), "{style}");
    let mut second_level = make_character("wizard", "human", None, json!({}));
    second_level["level"] = json!(2);
    assert_eq!(resolve(&second_level).expect_err("уровень"), "Мастер PHB создаёт героя первого уровня; развитие выполняется после создания");
}

/// `test/magic-initiate-focus.test.mjs`: Посвящённый в магию сохраняет класс
/// списка заклинаний в выдаче заговоров и заклинания.
#[test]
fn magic_initiate_keeps_spell_list_class() {
    let feat = json!({ "id": "magic-initiate", "choices": { "class": "wizard", "cantrips": ["minor-illusion", "message"], "spell": "shield" } });
    let mut source = make_character("fighter", "human-variant", Some(feat), json!({}));
    source["backgroundChoices"]["replacementSkills"] = json!(["investigation"]);
    let result = resolve(&source).expect("Посвящённый в магию");
    let grants = result["benefits"]["spell_grants"].as_array().cloned().unwrap_or_default();
    let illusion = grants.iter().find(|grant| grant["id"] == "minor-illusion").expect("заговор");
    assert_eq!(illusion["class_key"], json!("wizard"));
    assert_eq!(illusion["uses"], json!("at-will"));
    let shield = grants.iter().find(|grant| grant["id"] == "shield").expect("заклинание 1 круга");
    assert_eq!(shield["uses"], json!(1));
}

#[test]
fn documents_without_phb_choices_are_not_phb() {
    assert_eq!(m::resolve_phb_creation(Some(&json!({ "characterClass": "fighter" }))), Ok(None));
    assert!(matches!(m::resolve_phb_creation(None), Err(m::PhbCreationError::Runtime(_))));
    assert_eq!(m::phb_spell_id(Some(&json!("tashas_hideous_laughter"))), "tasha-s-hideous-laughter");
    assert_eq!(m::phb_tool_id(Some(&json!("land_vehicles"))), "vehicles_land");
    assert_eq!(m::phb_fighting_style("fighting-style-archery"), Some("archery"));
    assert_eq!(m::phb_fighting_style("constructor"), None);
}
