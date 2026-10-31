//! Сверка `character_creation_class_options` с эталоном JS.

mod common;

use common::{check, ok, ok_or_null, Outcome};
use serde_json::{json, Value};
use sk_ruleset::character_creation_class_options as m;

#[test]
fn class_options_match_js() {
    let count = check(include_str!("../fixtures/character-creation-class-options.json"), |name, args| -> Outcome {
        match name {
            "const:CLASS_OPTIONS_PROVENANCE" => ok(m::CLASS_OPTIONS_PROVENANCE.clone()),
            "const:PHB_2014_CLASS_KEYS" => ok(json!(m::PHB_2014_CLASS_KEYS)),
            "const:PHB_2014_GAMING_SETS" => ok(json!(m::PHB_2014_GAMING_SETS)),
            "const:PHB_2014_OTHER_TOOLS" => ok(json!(m::PHB_2014_OTHER_TOOLS)),
            "const:PHB_2014_TOOL_OPTIONS" => ok(m::PHB_2014_TOOL_OPTIONS.clone()),
            "const:PHB_2014_TOOL_IDS" => ok(json!(*m::PHB_2014_TOOL_IDS)),
            "const:PHB_2014_TOOL_CATALOG" => ok(m::PHB_2014_TOOL_CATALOG.clone()),
            "const:PHB_2014_MUSICAL_INSTRUMENTS" => ok(json!(m::PHB_2014_MUSICAL_INSTRUMENTS)),
            "const:PHB_2014_ARTISAN_TOOLS" => ok(json!(m::PHB_2014_ARTISAN_TOOLS)),
            "const:PHB_2014_DRUID_CANTRIPS" => ok(json!(m::PHB_2014_DRUID_CANTRIPS)),
            "const:PHB_2014_SKILLS" => ok(json!(m::PHB_2014_SKILLS)),
            "const:PHB_2014_DRACONIC_ANCESTRIES" => ok(m::PHB_2014_DRACONIC_ANCESTRIES.clone()),
            "const:PHB_2014_FAVORED_ENEMY_TYPES" => ok(json!(m::PHB_2014_FAVORED_ENEMY_TYPES)),
            "const:PHB_2014_FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES" => ok(json!(m::PHB_2014_FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES)),
            "const:PHB_2014_NATURAL_EXPLORER_TERRAINS" => ok(json!(m::PHB_2014_NATURAL_EXPLORER_TERRAINS)),
            "const:PHB_2014_CLASS_OPTIONS" => ok(m::PHB_2014_CLASS_OPTIONS.clone()),
            "classOptionsCatalog" => ok(m::class_options_catalog()),
            "classCreationOptionsCatalog" => ok(m::class_creation_options_catalog()),
            "classOptionFor" => ok_or_null(m::class_option_for(args.get(0))),
            "validateClassChoices" => ok(m::validate_class_choices(args.get(0), args.get(1), args.get(2))),
            "classBenefitsFor" => ok(m::class_benefits_for(args.get(0), args.get(1), args.get(2))),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 1500);
}

/// Из `test/destructive-wave.test.mjs`: домен бури знает заклинания по кругам.
#[test]
fn tempest_domain_spells_by_level() {
    let tempest = m::class_benefits_for(Some(&json!("cleric")), Some(&json!({ "skills": ["history", "religion"], "subclass": "tempest" })), None);
    assert_eq!(tempest["ok"], json!(true));
    assert_eq!(tempest["domain_spell_ids"], json!(["fog_cloud", "thunderwave"]));
    assert_eq!(tempest["domain_spell_ids_by_level"]["9"], json!(["destructive_wave", "insect_plague"]));
    let keys: Vec<&String> = tempest["domain_spell_ids_by_level"].as_object().map(|levels| levels.keys().collect()).unwrap_or_default();
    assert_eq!(keys, ["1", "3", "5", "7", "9"]);
    assert_eq!(tempest["weapon_proficiencies"], json!(["simple", "martial"]));
    let option = m::class_option_for(Some(&json!("cleric"))).unwrap_or(Value::Null);
    let tempest_option = option["subclass_options"].as_array().and_then(|options| options.iter().find(|entry| entry["id"] == json!("tempest"))).cloned();
    assert_eq!(tempest_option.map(|entry| entry["domain_spells"]["always_prepared"].clone()), Some(json!(true)));
}
