//! `beast_taming`: эталон JS (`fixtures/beast-taming.json`) — прогалина через
//! настоящий Rules Engine с перехватом вызовов модуля (резолвер каталога —
//! таблицей), корпус паритета и звери и реестры с мусором старых сохранений.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_npc_world::beast_taming::*;

fn diet(value: Option<BeastDiet>) -> Outcome {
    match value {
        None => ok(Value::Null),
        // Функция прототипа — пустой объект с тем же поведением полей.
        Some(diet) => ok(diet.to_json().unwrap_or_else(|| json!({}))),
    }
}

fn label(value: Option<Value>) -> Outcome {
    ok(value.unwrap_or_else(|| json!({})))
}

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    match name {
        "beastDietFor" => diet(beast_diet_for(a(0))),
        "isTameableBeast" => ok(json!(is_tameable_beast(a(0)))),
        "beastChallengeRating" => ok(sk_core::js::num(beast_challenge_rating(a(0)))),
        "beastChallengeDcShift" => ok(json!(beast_challenge_dc_shift(a(0)))),
        "beastIsWounded" => ok(json!(beast_is_wounded(a(0)))),
        "beastMoraleBroken" => ok(json!(beast_morale_broken(v(0), a(1)))),
        "normalizeBeastState" => ok(normalize_beast_state(a(0))),
        "beastList" => ok(Value::Array(beast_list(v(0)))),
        "beastFor" => ok_opt(beast_for(v(0), a(1))),
        "beastCompanions" => ok(Value::Array(beast_companions(v(0)))),
        "beastIdFor" => ok(json!(beast_id_for(v(0), a(1)))),
        "beastDistanceFeet" => ok(beast_distance_feet(v(0), a(1), a(2)).map_or(Value::Null, sk_core::js::num)),
        "beastReachFor" => ok(beast_reach_for(v(0), a(1), a(2)).to_json()),
        "beastOutOfReach" => ok(json!(beast_out_of_reach(v(0), a(1), a(2)))),
        "beastReachByHero" => ok(Value::Object(beast_reach_by_hero(v(0), a(1)))),
        "beastApproachBlockedReason" => ok(json!(beast_approach_blocked_reason(v(0), a(1)))),
        "tameableBeasts" => ok(Value::Array(tameable_beasts(v(0)).iter().map(TameableBeast::to_json).collect())),
        "beastDraftFor" => ok_opt(beast_draft_for(v(0), a(1))),
        "beastTamingPolicy" => ok(beast_taming_policy(v(0), a(1), a(2)).to_json()),
        "beastBiteDamage" => ok(json!(beast_bite_damage(a(0)))),
        "beastFoodItemFor" => {
            let table = a(1).cloned();
            let resolve = move |id: &str| table.as_ref().and_then(|table| table.get(id)).filter(|entry| !entry.is_null()).cloned();
            ok_opt(beast_food_item_for(a(0), if a(1).is_some() { Some(&resolve) } else { None }))
        }
        "partyIsResting" => ok(json!(party_is_resting(v(0)))),
        "beastWatchCompanion" => ok_opt(beast_watch_companion(v(0))),
        "beastWatchSwing" => ok_opt(beast_watch_swing(v(0), a(1), a(2))),
        "beastScareLine" => ok(json!(beast_scare_line(a(0), a(1)))),
        "beastScareCooldownLeft" => ok(json!(beast_scare_cooldown_left(a(0), a(1)))),
        "planBeastFollowDrafts" => ok(Value::Array(plan_beast_follow_drafts(v(0)))),
        "beastDietLabel" => label(beast_diet_label_value(a(0))),
        "beastStageLabel" => label(beast_stage_label_value(a(0))),
        "beastForViewer" => ok_opt(beast_for_viewer(a(0))),
        "beastsForViewer" => ok(beasts_for_viewer(v(0), v(1))),
        "beastChronicleEntry" => ok_opt(beast_chronicle_entry(v(0))),
        "applyBeastEvent" => ok(apply_beast_event(a(0), v(1), v(2))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn beast_taming_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/beast-taming.json"));
    let summary = check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 4_000, "{summary:?}");
}
