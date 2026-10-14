//! Сверка `backgrounds` с эталоном JS.

mod common;

use common::{check, ok, Outcome};
use serde_json::{json, Value};
use sk_ruleset::backgrounds::{self as m, BackgroundError};
use sk_ruleset::ruleset_config::RulesetSelectionError;

fn background_error(error: BackgroundError) -> common::JsError {
    match error {
        BackgroundError::Ruleset(error) => selection(error),
        BackgroundError::Type(message) => common::thrown_type_error(message),
        BackgroundError::Runtime(message) => common::type_error(message),
    }
}

fn selection(error: RulesetSelectionError) -> common::JsError {
    common::error("RulesetSelectionError", Some(&error.code), &error.message)
}

fn nullable(result: Result<Option<Value>, BackgroundError>) -> Outcome {
    result.map(|value| Some(value.unwrap_or(Value::Null))).map_err(background_error)
}

#[test]
fn backgrounds_match_js() {
    let count = check(include_str!("../fixtures/backgrounds.json"), |name, args| -> Outcome {
        match name {
            "const:PHB_BACKGROUND_VARIANTS" => ok(m::PHB_BACKGROUND_VARIANTS.clone()),
            "phbToolOptions" => ok(m::phb_tool_options()),
            "backgroundCatalogInfo" => ok(m::background_catalog_info()),
            "backgroundCatalogFor" => m::background_catalog_for(&args.s(0)).map(Some).map_err(selection),
            "resolveBackgroundCustomization" => nullable(m::resolve_background_customization(args.get(0))),
            "backgroundById" => nullable(m::background_by_id(&args.s(0), &args.s(1), args.get(2))),
            "defaultBackgroundAbilityChoice" => nullable(m::default_background_ability_choice(&args.s(0), &args.s(1))),
            "defaultBackgroundChoices" => nullable(m::default_background_choices(&args.s(0), &args.s(1))),
            "backgroundBenefits" => nullable(m::background_benefits(&args.s(0), args.get(1), args.get(2), &args.s(3))),
            "resolveBackgroundAbilityChoice" => {
                m::resolve_background_ability_choice(&args.s(0), args.get(1), &args.s(2)).map(Some).map_err(background_error)
            }
            "resolveBackgroundChoices" => m::resolve_background_choices(&args.s(0), args.get(1), &args.s(2)).map(Some).map_err(background_error),
            "withBackgroundBenefits" => m::with_background_benefits(args.get(0), &args.s(1)).map(Some).map_err(background_error),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 3000);
}

/// Из `test/character-creation-2014.test.mjs`: каталог 2014 отделён по
/// редакции, у предыстории 2014 нет прибавок характеристик.
#[test]
fn classic_catalog_is_separate() {
    let classic = m::background_catalog_for("dnd_5e_2014").unwrap_or(Value::Null);
    assert_eq!(classic["options"].as_array().map(Vec::len), Some(13));
    assert_eq!(classic["ability_modes"], json!([]));
    let guild = classic["options"].as_array().and_then(|options| options.iter().find(|entry| entry["id"] == json!("guild-artisan"))).cloned();
    assert!(guild.is_some_and(|entry| entry["toolChoice"]["options"].as_array().is_some_and(|options| !options.is_empty())));
    let current = m::background_catalog_for("srd_5_2_1").unwrap_or(Value::Null);
    assert_ne!(current["policy_id"], classic["policy_id"]);
}
