//! Сверка `ruleset_config`, `rules_core`, `rules_actors` с эталонами JS.

mod common;

use common::{check, error, ok, ok_or_null, Args, Outcome};
use serde_json::{json, Value};
use sk_ruleset::rules_actors as actors;
use sk_ruleset::rules_core as core;
use sk_ruleset::ruleset_config::{self as config, ProfileOptions, RulesetSelectionError};

fn selection_error(error: RulesetSelectionError) -> common::JsError {
    error_of("RulesetSelectionError", &error.code, &error.message)
}

fn error_of(name: &str, code: &str, message: &str) -> common::JsError {
    error(name, Some(code), message)
}

fn options(args: &Args, index: usize) -> ProfileOptions<'_> {
    ProfileOptions {
        fallback: args.option(index, "fallback").and_then(Value::as_str),
        require_creation: sk_core::js::truthy(args.option(index, "requireCreation")),
    }
}

#[test]
fn ruleset_config_matches_js() {
    let count = check(include_str!("../fixtures/ruleset-config.json"), |name, args| -> Outcome {
        match name {
            "const:DND_2014_RULESET_ID" => ok(json!(config::DND_2014_RULESET_ID)),
            "const:LEGACY_DEFAULT_RULESET_ID" => ok(json!(config::LEGACY_DEFAULT_RULESET_ID)),
            "const:NEW_WORLD_DEFAULT_RULESET_ID" => ok(json!(config::NEW_WORLD_DEFAULT_RULESET_ID)),
            "const:CLASS_RESOURCES_2024_POLICY_ID" => ok(json!(config::CLASS_RESOURCES_2024_POLICY_ID)),
            "const:BG3_OPENING_STRIKE_HOUSE_RULE_ID" => ok(json!(config::BG3_OPENING_STRIKE_HOUSE_RULE_ID)),
            "const:BG3_SPELL_HANDS_HOUSE_RULE_ID" => ok(json!(config::BG3_SPELL_HANDS_HOUSE_RULE_ID)),
            "const:DEFAULT_ON_HOUSE_RULE_IDS" => ok(json!(config::DEFAULT_ON_HOUSE_RULE_IDS)),
            "const:TOGGLEABLE_HOUSE_RULES" => ok(config::toggleable_house_rules_json()),
            "const:RULESET_PROFILES" => ok(config::ruleset_profiles_json()),
            "const:INSTALLED_RULESET_IDS" => ok(json!(config::INSTALLED_RULESET_IDS)),
            "publicRulesetProfiles" => ok(config::public_ruleset_profiles()),
            "rulesetProfile" => config::ruleset_profile(&args.s(0), options(args, 1)).map(|profile| Some(profile.to_json())).map_err(selection_error),
            "rulesetLock" => config::ruleset_lock(&args.s(0), options(args, 1)).map(Some).map_err(selection_error),
            "rulesetRuleId" => ok(json!(config::ruleset_rule_id(&args.s(0), &args.s(1)))),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 500);
}

#[test]
fn rules_core_matches_js() {
    check(include_str!("../fixtures/rules-core.json"), |name, args| -> Outcome {
        match name {
            "const:DEFAULT_RULESET_ID" => ok(json!(core::DEFAULT_RULESET_ID)),
            "usesDnd2014" => ok(json!(core::uses_dnd2014(args.get(0)))),
            "safeInteger" => {
                let fallback = args.get(1).and_then(Value::as_i64).unwrap_or(0);
                ok(json!(core::safe_integer(args.get(0), fallback)))
            }
            other => panic!("нет сверки для {other}"),
        }
    });
}

#[test]
fn rules_actors_match_js() {
    check(include_str!("../fixtures/rules-actors.json"), |name, args| -> Outcome {
        match name {
            "actorId" => ok(json!(actors::actor_id(args.get(0)))),
            "actorHp" => ok(json!(actors::actor_hp(args.get(0)))),
            "isLivingActor" => ok(json!(actors::is_living_actor(args.get(0)))),
            "listActors" => ok(Value::Array(actors::list_actors(args.get(0)).into_iter().cloned().collect())),
            "findActor" => ok_or_null(actors::find_actor(args.get(0), &args.s(1)).cloned()),
            "isEnemyActor" => ok(json!(actors::is_enemy_actor(args.get(0), &args.s(1)))),
            "actorPosition" => ok_or_null(actors::actor_position(args.get(0), &args.s(1)).map(|point| json!({ "x": point.x, "y": point.y }))),
            other => panic!("нет сверки для {other}"),
        }
    });
}
