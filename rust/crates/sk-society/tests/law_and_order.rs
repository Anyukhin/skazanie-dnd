//! Сверка `law_and_order` с эталоном `server/law-and-order.mjs`
//! (`fixtures/gen-law-and-order.mjs`): константы, случайные состояния с
//! мусором, цепочки `applyLawEvent` и сценарии настоящего движка.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Map, Value};
use sk_society::law_and_order::*;

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "normalizeLawState" => Outcome::of(normalize_law_state(args.opt(0))),
        "wantedFor" => Outcome::of(wanted_for(args.val(0), args.val(1))),
        "pendingCrimeIdsFor" => Outcome::of(pending_crime_ids_for(args.val(0), args.val(1))),
        "wantedLevelHere" => Outcome::of(wanted_level_here(args.val(0))),
        "wantedHere" => Outcome::of(wanted_here(args.val(0))),
        "wantedFeed" => Outcome::of(wanted_feed(args.val(0))),
        "currentWorldNode" => Outcome::option(current_world_node(args.val(0)).cloned()),
        "currentRegionId" => Outcome::of(current_region_id(args.val(0))),
        "currentSettlement" => Outcome::option(current_settlement(args.val(0))),
        "crimeFromDeedLedger" => Outcome::option(crime_from_deed_ledger(args.val(0), args.val(1))),
        "guardEncounterIsHere" => Outcome::of(guard_encounter_is_here(args.val(0), args.opt(1))),
        "guardEncounterTriggerFor" => Outcome::option(guard_encounter_trigger_for(args.val(0), args.val(1))),
        "guardEncounterFor" => Outcome::of(guard_encounter_for(args.val(0))),
        "guardOptionsFor" => Outcome::of(guard_options_for(args.opt(0))),
        "publicGuardEncounterFor" => Outcome::option(public_guard_encounter_for(args.opt(0))),
        "wantedSignsFor" => Outcome::of(wanted_signs_for(args.val(0))),
        "wantedPriceBps" => Outcome::of(wanted_price_bps(args.val(0))),
        "wantedTradeAvailable" => Outcome::of(wanted_trade_available(args.val(0))),
        "lawForViewer" => Outcome::of(law_for_viewer(args.val(0), args.val(1))),
        "guardOfficerFor" => Outcome::of(guard_officer_for(args.val(0), args.val(1))),
        "applyLawEvent" => Outcome::of(apply_law_event(args.opt(0), args.val(1), args.val(2))),
        "guardFineCpFor" => Outcome::of(guard_fine_cp_for(args.val(0))),
        "guardEscapeDcFor" => Outcome::of(guard_escape_dc_for(args.val(0))),
        "guardDemandFor" => Outcome::of(guard_demand_for(args.val(0), args.val(1))),
        "wantedLevelForPoints" => Outcome::of(wanted_level_for_points(args.val(0))),
        "escapeSucceeded" => Outcome::of(escape_succeeded(args.val(0))),
        _ => Outcome::Unknown,
    }
}

fn pairs<V: Into<Value> + Copy>(entries: &[(i64, V)]) -> Value {
    Value::Object(entries.iter().map(|(key, value)| (key.to_string(), (*value).into())).collect::<Map<String, Value>>())
}

#[test]
fn law_and_order_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/law-and-order.json"));
    let total = fixture.check(dispatch);
    assert!(total > 1_000, "эталон подозрительно мал: {total}");
}

#[test]
fn law_constants_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/law-and-order.json"));
    let rust = json!({
        "LAW_SCHEMA_VERSION": LAW_SCHEMA_VERSION,
        "LAW_POLICY_ID": LAW_POLICY_ID,
        "WANTED_CRIME_POINTS": Value::Object(WANTED_CRIME_POINTS.iter().map(|(kind, points)| (kind.to_string(), json!(points))).collect()),
        "WANTED_LEVEL_THRESHOLDS": WANTED_LEVEL_THRESHOLDS,
        "MAX_WANTED_LEVEL": MAX_WANTED_LEVEL,
        "WANTED_LEVEL_LABELS": WANTED_LEVEL_LABELS,
        "WANTED_DECAY_MINUTES": WANTED_DECAY_MINUTES,
        "WANTED_FINE_CP": pairs(&WANTED_FINE_CP),
        "GUARD_PASSIVE_PERCEPTION": pairs(&GUARD_PASSIVE_PERCEPTION),
        "GUARD_CUSTODY_MINUTES": GUARD_CUSTODY_MINUTES,
        "WANTED_ESCAPE_FAILURE_POINTS": WANTED_ESCAPE_FAILURE_POINTS,
        "GUARD_ENCOUNTER_THEME": GUARD_ENCOUNTER_THEME,
        "GUARD_ENCOUNTER_DIFFICULTY": pairs(&GUARD_ENCOUNTER_DIFFICULTY),
        "SETTLEMENT_LOCATION_KINDS": SETTLEMENT_LOCATION_KINDS,
        "GUARD_RESOLUTIONS": GUARD_RESOLUTIONS,
        "GUARD_ESCAPE_SKILLS": GUARD_ESCAPE_SKILLS,
        "LAW_COMMAND_TYPES": LAW_COMMAND_TYPES,
        "WANTED_CLEAR_REASONS": WANTED_CLEAR_REASONS,
        "WANTED_TRADE_REFUSAL_LEVEL": WANTED_TRADE_REFUSAL_LEVEL,
        "WANTED_PRICE_BPS": pairs(&WANTED_PRICE_BPS),
        "WANTED_TRADE_REFUSAL_REASON": WANTED_TRADE_REFUSAL_REASON,
    });
    assert_eq!(serde_json::to_string(&rust).ok(), serde_json::to_string(&fixture.root["constants"]).ok());
}
