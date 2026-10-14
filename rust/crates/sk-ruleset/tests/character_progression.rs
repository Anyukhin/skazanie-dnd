//! Сверка `character_progression` с эталоном JS.

mod common;

use common::{check, ok, ok_or_null, Outcome};
use serde_json::{json, Value};
use sk_ruleset::character_progression as m;

fn list(args: &common::Args, index: usize) -> Vec<Value> {
    args.get(index).and_then(Value::as_array).cloned().unwrap_or_default()
}

#[test]
fn character_progression_matches_js() {
    let count = check(include_str!("../fixtures/character-progression.json"), |name, args| -> Outcome {
        let actor = args.get(0);
        match name {
            "const:CHARACTER_RULES_PROVENANCE" => ok(m::CHARACTER_RULES_PROVENANCE.clone()),
            "classBuildCatalogInfo" => ok(m::class_build_catalog_info()),
            "characterClassKey" => ok_or_null(m::character_class_key(actor).map(Value::String)),
            "classSkillRuleFor" => ok_or_null(m::class_skill_rule_for(actor)),
            "abilityScoreChoiceLevelsFor" => ok(json!(m::ability_score_choice_levels_for(actor))),
            "catalogSkillId" => ok(json!(m::catalog_skill_id(actor))),
            "skillAbility" => ok_or_null(m::skill_ability(actor)),
            "normalizedClassSkillProficiencies" => ok(json!(m::normalized_class_skill_proficiencies(actor))),
            "isSkillProficient*" => ok(json!(list(args, 1).iter().map(|skill| m::is_skill_proficient(actor, Some(skill))).collect::<Vec<_>>())),
            "featureChoiceGroupsFor" => ok(Value::Array(m::feature_choice_groups_for(actor))),
            "normalizedSelectedFeatureIds" => ok(json!(m::normalized_selected_feature_ids(actor))),
            "isOptionalFeatureSelected*" => {
                ok(json!(list(args, 1).iter().map(|feature| m::is_optional_feature_selected(actor, Some(feature))).collect::<Vec<_>>()))
            }
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 1000);
}

/// Из `test/warlock-invocations.test.mjs` и `test/beast-taming.test.mjs`: колдун с
/// «Влиянием обольщения» владеет Обманом и Убеждением, дефисное написание
/// навыка не теряет владения.
#[test]
fn spelling_and_invocations_keep_proficiency() {
    let warlock = json!({
        "characterClass": "warlock", "level": 2, "classSkillProficiencies": ["arcana", "history"],
        "selectedFeatureIds": ["beguiling-influence"],
    });
    assert!(m::is_skill_proficient(Some(&warlock), Some(&json!("persuasion"))));
    assert!(m::is_skill_proficient(Some(&warlock), Some(&json!("deception"))));
    assert!(!m::is_skill_proficient(Some(&warlock), Some(&json!("religion"))));
    let ranger = json!({ "characterClass": "ranger", "classSkillProficiencies": ["animal-handling", "stealth", "survival"] });
    assert_eq!(m::normalized_class_skill_proficiencies(Some(&ranger)), ["animal_handling", "stealth", "survival"]);
    assert!(m::is_skill_proficient(Some(&ranger), Some(&json!("animal_handling"))));
    assert_eq!(m::skill_ability(Some(&json!("animal-handling"))), Some(json!("wis")));
    assert_eq!(m::ability_score_choice_levels_for(Some(&json!({ "characterClass": "fighter" }))), [4, 6, 8, 12]);
    assert_eq!(m::ability_score_choice_levels_for(Some(&json!({ "characterClass": "rogue" }))), [4, 8, 10, 12]);
}
