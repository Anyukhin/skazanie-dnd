//! Сверка `parley` с эталоном `server/parley.mjs` (`fixtures/gen-parley.mjs`):
//! мораль, предводитель, откуп и перемирие на случайных сторонах противника,
//! распознавание сотен фраз, патч боя.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Map, Value};
use sk_society::parley::*;

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "standingEnemies" => Outcome::of(standing_enemies(args.val(0)).into_iter().cloned().collect::<Vec<_>>()),
        "parleyLeaderFor" => Outcome::option(parley_leader_for(args.val(0)).cloned()),
        "parleyMoraleFor" => Outcome::of(parley_morale_for(args.val(0))),
        "parleyTributeCp" => Outcome::of(parley_tribute_cp(args.val(0))),
        "truceFor" => Outcome::option(truce_for(args.val(0))),
        "truceHolds" => Outcome::of(truce_holds(args.val(0))),
        "parleyAttempts" => Outcome::of(parley_attempts(args.val(0))),
        "parleyTaunt" => Outcome::of(parley_taunt(args.val(0), args.val(1))),
        "normalizeTruce" => Outcome::option(normalize_truce(args.opt(0))),
        "parleyTermsFor" => Outcome::of(parley_terms_for(args.val(0))),
        "parleyCombatPatch" => Outcome::option(parley_combat_patch(args.val(0), args.val(1))),
        "parleyRefusalLine" => Outcome::of(match args.opt(0) {
            None => parley_refusal_line(&json!("")),
            Some(reason) => parley_refusal_line(reason),
        }),
        "mentionsParley" => Outcome::of(mentions_parley(args.val(0))),
        "parleyCounterReasonFor" => Outcome::option(parley_counter_reason_for(args.val(0))),
        "parleySkillFor" => Outcome::of(parley_skill_for(args.val(0))),
        _ => Outcome::Unknown,
    }
}

#[test]
fn parley_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/parley.json"));
    let total = fixture.check(dispatch);
    assert!(total > 1_000, "эталон подозрительно мал: {total}");
}

#[test]
fn parley_constants_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/parley.json"));
    let lines: Map<String, Value> = PARLEY_REFUSAL_LINES.iter().map(|(reason, line)| (reason.to_string(), json!(line))).collect();
    let terms: Map<String, Value> = PARLEY_TERMS.iter().map(|term| (term.id.to_string(), term.to_json())).collect();
    let thresholds: Map<String, Value> = PARLEY_OUTCOME_THRESHOLDS.iter().map(|(outcome, value)| (outcome.to_string(), json!(value))).collect();
    let rust = json!({
        "PARLEY_SCHEMA_VERSION": PARLEY_SCHEMA_VERSION,
        "PARLEY_POLICY_ID": PARLEY_POLICY_ID,
        "PARLEY_SKILLS": PARLEY_SKILLS,
        "PARLEY_ABILITY": PARLEY_ABILITY,
        "PARLEY_COMMAND_TYPES": PARLEY_COMMAND_TYPES,
        "TRUCE_BREAKING_COMMAND_TYPES": TRUCE_BREAKING_COMMAND_TYPES,
        "NEGOTIABLE_CREATURE_TYPES": NEGOTIABLE_CREATURE_TYPES,
        "ZEALOT_TRAIT_IDS": ZEALOT_TRAIT_IDS,
        "PARLEY_REFUSAL_LINES": lines,
        "PARLEY_REFUSAL_REASONS": PARLEY_REFUSAL_REASONS,
        "PARLEY_OUTCOMES": PARLEY_OUTCOMES,
        "PARLEY_TERMS": terms,
        "PARLEY_BASE_DC": PARLEY_BASE_DC,
        "PARLEY_HEALTH_WEIGHT": PARLEY_HEALTH_WEIGHT as i64,
        "PARLEY_LOSS_WEIGHT": PARLEY_LOSS_WEIGHT as i64,
        "PARLEY_OUTCOME_THRESHOLDS": thresholds,
        "PARLEY_COUNTER_REASONS": PARLEY_COUNTER_REASONS,
    });
    assert_eq!(serde_json::to_string(&rust).ok(), serde_json::to_string(&fixture.root["constants"]).ok());
}
