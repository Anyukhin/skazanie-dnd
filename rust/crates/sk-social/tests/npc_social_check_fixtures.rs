//! Сверка `npc_social_check` с эталонами JS (`fixtures/gen-npc-social-check.mjs`):
//! вид проверки по реплике, ступень подкупа, политика проверки на сотнях
//! состояний и исход проверок, которые Rules Engine JS бросил
//! детерминированными костями.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_dice::{D20Request, Dice, DiceService, SequenceRng, Visibility};
use sk_social::npc_social_check::*;

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "affirmativeActionText" => Outcome::of(affirmative_action_text(args.val(0))),
        "classifyNpcSocialCheck" => Outcome::option(classify_npc_social_check(args.val(0))),
        "classifyBribeTier" => Outcome::of(classify_bribe_tier(args.val(0))),
        "buildNpcSocialCheckPolicy" => Outcome::option(build_npc_social_check_policy(args.val(0))),
        "npcSocialCheckOutcome" => Outcome::option(npc_social_check_outcome(args.val(0))),
        "assertNpcSocialCheckFingerprint" => match assert_npc_social_check_fingerprint(args.val(0), args.val(1)) {
            Ok(()) => Outcome::Value(None),
            Err(error) => Outcome::Throws { code: Some(error.code), message: error.message },
        },
        _ => Outcome::Unknown,
    }
}

#[test]
fn npc_social_check_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-social-check.json"));
    let checked = fixture.check(dispatch);
    assert!(checked > 1_000, "эталонных случаев {checked}");
}

#[test]
fn npc_social_check_constants_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-social-check.json"));
    let rust = json!({ "NPC_SOCIAL_CHECK_SKILLS": NPC_SOCIAL_CHECK_SKILLS, "BRIBEABLE_SOCIAL_SKILLS": BRIBEABLE_SOCIAL_SKILLS });
    assert_eq!(serde_json::to_string(&rust).ok(), serde_json::to_string(&fixture.root["constants"]).ok());
}

/// Проверка разговора на детерминированных костях: та же кость, которую JS
/// выдал Rules Engine, брошена `sk_dice` с модификатором и СЛ политики; событие
/// с броском Rust даёт тот же исход, что событие JS.
#[test]
fn deterministic_dice_reproduce_js_social_checks() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-social-check.json"));
    let rolls = fixture.root["rolls"].as_array().cloned().unwrap_or_default();
    assert!(rolls.len() >= 50, "бросков {}", rolls.len());
    let mut degrees = std::collections::BTreeSet::new();
    for record in rolls {
        let js_event = &record["event"];
        let js_payload = &js_event["payload"];
        let policy = &record["policy"];
        let die = record["die"].as_i64().expect("кость");
        let modifier = js_payload["modifier"].as_i64().expect("модификатор");
        let difficulty = policy["difficulty"].as_i64().expect("СЛ политики");
        assert_eq!(js_payload["difficulty"].as_i64(), Some(difficulty), "движок берёт СЛ из политики, а не из команды");

        let mut dice = DiceService::deterministic(SequenceRng::new([die]), "roll");
        let request = D20Request::new(format!("ability_check:{}", policy["ability"].as_str().unwrap_or("cha")), modifier)
            .actor(policy["hero_id"].as_str().unwrap_or(""))
            .visibility(Visibility::SpecificPlayer);
        let roll = dice.roll_check(&request, difficulty).expect("бросок");
        assert_eq!(roll.total, js_payload["total"].as_i64().expect("итог"));
        assert_eq!(roll.success, js_payload["success"].as_bool());

        let mut event = js_event.clone();
        event["payload"]["roll_id"] = Value::String(roll.roll_id.clone());
        event["payload"]["total"] = json!(roll.total);
        event["payload"]["success"] = json!(roll.success);
        let rust = npc_social_check_outcome(&event).expect("исход социальной проверки");
        let mut js = npc_social_check_outcome(js_event).expect("исход JS");
        js["roll_id"] = Value::String(roll.roll_id.clone());
        assert_eq!(rust, js);
        assert_eq!(rust["check_id"], policy["check_id"]);
        degrees.insert(rust["degree"].as_str().unwrap_or("").to_string());
        assert!(assert_npc_social_check_fingerprint(&event, policy).is_ok());
    }
    assert!(degrees.len() >= 3, "степени исхода: {degrees:?}");
}
