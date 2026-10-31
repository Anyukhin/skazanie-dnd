//! Сверка `character_creation_catalog` с эталоном JS.

mod common;

use common::{check, ok, Outcome};
use serde_json::Value;
use sk_ruleset::character_creation_catalog as m;
use sk_ruleset::ruleset_config::RulesetSelectionError;

fn selection(error: RulesetSelectionError) -> common::JsError {
    common::error("RulesetSelectionError", Some(&error.code), &error.message)
}

fn nullable(result: Result<Option<Value>, RulesetSelectionError>) -> Outcome {
    result.map(|value| Some(value.unwrap_or(Value::Null))).map_err(selection)
}

#[test]
fn catalog_matches_js() {
    let count = check(include_str!("../fixtures/character-creation-catalog.json"), |name, args| -> Outcome {
        match name {
            "characterCreationOriginCatalogInfo" => ok(m::character_creation_origin_catalog_info()),
            "characterCreationPolicyFor" => m::character_creation_policy_for(&args.s(0)).map(Some).map_err(selection),
            "speciesOptionFor" => nullable(m::species_option_for(&args.s(0), &args.s(1))),
            "defaultSpeciesChoices" => nullable(m::default_species_choices(&args.s(0), &args.s(1))),
            "speciesBenefitsFor" => nullable(m::species_benefits_for(&args.s(0), &args.s(1), args.get(2))),
            "originBonusProfileFor" => nullable(m::origin_bonus_profile_for(&args.s(0), &args.s(1))),
            "resolveSpeciesChoices" => m::resolve_species_choices(&args.s(0), args.get(1), &args.s(2)).map(Some).map_err(selection),
            "validateSpeciesOriginBonuses" => {
                m::validate_species_origin_bonuses(&args.s(0), args.get(1), args.get(2), &args.s(3)).map(Some).map_err(selection)
            }
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 3000);
}
