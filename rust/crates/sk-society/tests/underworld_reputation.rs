//! Сверка `underworld` и `reputation_policy` с эталонами JS
//! (`fixtures/gen-underworld.mjs`, `fixtures/gen-reputation-policy.mjs`).

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Map, Value};
use sk_society::reputation_policy::*;
use sk_society::underworld::*;

fn underworld_dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "npcIsFence" => Outcome::of(npc_is_fence(args.val(0), args.val(1))),
        "npcIsIncorruptible" => Outcome::of(npc_is_incorruptible(args.val(0), args.val(1))),
        "fenceDenunciationFor" => Outcome::option(fence_denunciation_for(args.val(0), args.val(1), args.val(2))),
        "bribeTierAmounts" => Outcome::of(bribe_tier_amounts(args.val(0))),
        "bribeTierById" => Outcome::option(bribe_tier_by_id(args.val(0), args.val(1))),
        "bribeOutcomeFor" => Outcome::of(bribe_outcome_for(args.val(0))),
        _ => Outcome::Unknown,
    }
}

fn reputation_dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "reputationStandingFor" => Outcome::of(reputation_standing_for(args.val(0), args.val(1))),
        "reputationPriceBps" => Outcome::of(reputation_price_bps(args.val(0), args.val(1))),
        "factionIdsForNpc" => Outcome::of(faction_ids_for_npc(args.opt(0))),
        "reputationScoreFor" => Outcome::of(reputation_score_for(args.val(0), args.opt(1))),
        "reputationTier" => Outcome::of(reputation_tier(args.val(0))),
        _ => Outcome::Unknown,
    }
}

#[test]
fn underworld_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/underworld.json"));
    assert!(fixture.check(underworld_dispatch) > 1_000);
}

#[test]
fn underworld_constants_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/underworld.json"));
    let rust = json!({
        "UNDERWORLD_POLICY_ID": UNDERWORLD_POLICY_ID,
        "FENCE_TAG": FENCE_TAG,
        "INCORRUPTIBLE_TAG": INCORRUPTIBLE_TAG,
        "UNDERWORLD_PRIVATE_TAGS": UNDERWORLD_PRIVATE_TAGS,
        "FENCE_SHARE": FENCE_SHARE,
        "INCORRUPTIBLE_SHARE": INCORRUPTIBLE_SHARE,
        "STOLEN_DISCOUNT_BPS": STOLEN_DISCOUNT_BPS,
        "BRIBE_TIERS": BRIBE_TIERS.iter().map(BribeTier::to_json).collect::<Vec<_>>(),
        "MIN_BRIBE_CP": MIN_BRIBE_CP,
        "INCORRUPTIBLE_DC_PENALTY": INCORRUPTIBLE_DC_PENALTY,
        "DENUNCIATION_WANTED_LEVEL": DENUNCIATION_WANTED_LEVEL,
        "DENUNCIATION_SHARE": DENUNCIATION_SHARE,
    });
    assert_eq!(serde_json::to_string(&rust).ok(), serde_json::to_string(&fixture.root["constants"]).ok());
}

#[test]
fn reputation_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/reputation-policy.json"));
    assert!(fixture.check(reputation_dispatch) > 1_000);
}

#[test]
fn reputation_constants_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/reputation-policy.json"));
    let table = |entries: &[(&str, i64)]| Value::Object(entries.iter().map(|(tier, value)| (tier.to_string(), json!(value))).collect::<Map<String, Value>>());
    let rust = json!({ "REPUTATION_PRICE_BPS": table(&REPUTATION_PRICE_BPS), "REPUTATION_SOCIAL_DC_SHIFT": table(&REPUTATION_SOCIAL_DC_SHIFT) });
    assert_eq!(serde_json::to_string(&rust).ok(), serde_json::to_string(&fixture.root["constants"]).ok());
    for (tier, bps) in REPUTATION_PRICE_BPS {
        let parsed = [ReputationTier::Reviled, ReputationTier::Distrusted, ReputationTier::Unknown, ReputationTier::Respected, ReputationTier::Honoured]
            .into_iter()
            .find(|candidate| candidate.as_str() == tier)
            .expect("ступень");
        assert_eq!(parsed.price_bps(), bps);
    }
}
