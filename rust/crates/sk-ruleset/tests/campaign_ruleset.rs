//! Сверка `campaign_ruleset` с эталоном JS.

mod common;

use common::{check, error, ok, ok_or_null, type_error, Outcome};
use serde_json::{json, Value};
use sk_ruleset::campaign_ruleset::{self as m, CampaignRulesetError, CampaignRulesetFailure, EventOptions};

fn campaign_error(error: CampaignRulesetError) -> common::JsError {
    common::error("CampaignRulesetError", Some(&error.code), &error.message)
}

fn failure(failure: CampaignRulesetFailure) -> common::JsError {
    match failure {
        CampaignRulesetFailure::Selection(selection) => error("RulesetSelectionError", Some(&selection.code), &selection.message),
        CampaignRulesetFailure::Campaign(campaign) => campaign_error(campaign),
    }
}

fn event_options(options: Option<&Value>) -> EventOptions {
    EventOptions {
        actor_id: options.and_then(|options| options.get("actorId")).cloned(),
        now: options.and_then(|options| options.get("now")).and_then(Value::as_str).map(str::to_string),
    }
}

#[test]
fn campaign_ruleset_matches_js() {
    let count = check(include_str!("../fixtures/campaign-ruleset.json"), |name, args| -> Outcome {
        match name {
            "campaignRulesetCanChange" => ok(m::campaign_ruleset_can_change(args.get(0), args.get(1))),
            "campaignRulesetSettings" => {
                let can_manage = sk_core::js::is_true(args.option(2, "canManage"));
                m::campaign_ruleset_settings(args.get(0), args.get(1), can_manage)
                    .map(Some)
                    .map_err(|error| common::error("RulesetSelectionError", Some(&error.code), &error.message))
            }
            "campaignHouseRuleSettings" => ok(m::campaign_house_rule_settings(args.get(0))),
            "campaignHouseRuleChangeEvent" => m::campaign_house_rule_change_event(&args.s(0), args.get(1), args.get(2), &event_options(args.get(3)))
                .map(|event| Some(event.unwrap_or(Value::Null)))
                .map_err(campaign_error),
            "defaultHouseRuleEvent" => {
                let now = args.option(3, "now").and_then(Value::as_str).map(str::to_string);
                m::default_house_rule_event(&args.s(0), args.get(1), args.get(2), now).map(|event| Some(event.unwrap_or(Value::Null))).map_err(campaign_error)
            }
            "campaignRulesetChangeEvent" => m::campaign_ruleset_change_event(&args.s(0), args.get(1), args.get(2), &event_options(args.get(3)))
                .map(|event| Some(event.unwrap_or(Value::Null)))
                .map_err(failure),
            "campaignHouseRuleMetadata" => m::campaign_house_rule_metadata(args.get(0)).map(Some).map_err(type_error),
            "campaignRulesetMetadata" => m::campaign_ruleset_metadata(args.get(0)).map(Some).map_err(type_error),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 1000);
    let _ = ok_or_null(None);
}

/// Перенос `test/campaign-ruleset.test.mjs` в части модуля (редьюсер и replay
/// — не здесь).
#[test]
fn ruleset_selection_is_an_event_before_gameplay() {
    let state = json!({ "sessionCode": "RULESET-CHOICE", "ruleset_id": "srd_5_2_1", "ruleset_version": "5.2.1", "enabled_rule_packs": ["srd_5_2_1"], "players": [] });
    let options = EventOptions { actor_id: Some(json!("owner")), now: Some("2026-08-30T12:00:00.000Z".into()) };
    let event = m::campaign_ruleset_change_event("dnd_5e_2014", Some(&state), Some(&json!([])), &options).ok().flatten().unwrap_or(Value::Null);
    assert_eq!(event["event_schema_version"], json!(1));
    assert_eq!(
        m::campaign_ruleset_metadata(Some(&event)),
        Ok(json!({
            "ruleset_id": "dnd_5e_2014",
            "ruleset_version": "2014.1.0",
            "enabled_rule_packs": ["dnd_5e_2014"],
            "enabled_house_rules": ["skazanie:2014-preview-legacy-catalogs-v1", "house:bg3-opening-strike", "house:bg3-spell-hands"],
        }))
    );
    assert_eq!(m::campaign_ruleset_can_change(Some(&json!([event])), None)["allowed"], json!(true));
    let gameplay = json!([event, { "event_type": "CharacterImported" }]);
    assert_eq!(m::campaign_ruleset_can_change(Some(&gameplay), None)["allowed"], json!(false));
    let switched = json!({ "ruleset_id": "dnd_5e_2014" });
    let locked = m::campaign_ruleset_change_event("srd_5_2_1", Some(&switched), Some(&gameplay), &EventOptions::default());
    assert_eq!(locked.map_err(|error| error.code().to_string()), Err("CAMPAIGN_RULESET_LOCKED".into()));
}

#[test]
fn house_rule_toggles_only_declared_rules_and_not_in_combat() {
    let base = json!({ "ruleset_id": "srd_5_2_1", "enabled_house_rules": [] });
    let code = |result: Result<Option<Value>, CampaignRulesetError>| result.map_err(|error| error.code);
    let options = EventOptions::default();
    assert_eq!(
        code(m::campaign_house_rule_change_event("skazanie:2014-preview-legacy-catalogs-v1", Some(&json!(false)), Some(&base), &options)),
        Err("HOUSE_RULE_NOT_TOGGLEABLE".into())
    );
    assert_eq!(code(m::campaign_house_rule_change_event("house:bg3-opening-strike", Some(&json!("yes")), Some(&base), &options)), Err("HOUSE_RULE_VALUE_INVALID".into()));
    let fighting = json!({ "mechanics": { "combat": { "active": true } } });
    assert_eq!(code(m::campaign_house_rule_change_event("house:bg3-opening-strike", Some(&json!(true)), Some(&fighting), &options)), Err("HOUSE_RULE_DURING_COMBAT".into()));
    let old = json!({ "enabled_house_rules": ["skazanie:class-resources-2024-v1"] });
    let event = m::default_house_rule_event("house:bg3-opening-strike", Some(&old), Some(&json!([])), None).ok().flatten().unwrap_or(Value::Null);
    assert_eq!(event["payload"]["reason"], json!("default-on"));
    assert_eq!(event["actor_id"], Value::Null);
    assert_eq!(m::default_house_rule_event("house:bg3-opening-strike", Some(&old), Some(&json!([event])), None), Ok(None));
}
