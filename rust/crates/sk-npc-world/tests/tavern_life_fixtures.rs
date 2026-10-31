//! `tavern_life`: эталон JS (`fixtures/tavern-life.json`) — вечера за столом
//! через настоящий Rules Engine с перехватом вызовов модуля, корпус паритета
//! и срезы заведения с мусором старых сохранений.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_npc_world::tavern_life::*;

fn rounds(list: Vec<TavernRound>) -> Value {
    Value::Array(list.iter().map(TavernRound::to_json).collect())
}

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    match name {
        "isTavernScene" => ok(json!(is_tavern_scene(v(0)))),
        "tavernOpponents" => ok(Value::Array(tavern_opponents(v(0)).iter().map(TavernOpponent::to_json).collect())),
        "isTavernOpponent" => ok(json!(is_tavern_opponent(v(0), v(1)))),
        "tavernGamblerFor" => ok(tavern_gambler_for(v(0), v(1)).to_json()),
        "tavernOpponentDie" => ok(json!(tavern_opponent_die(a(0), a(1)))),
        "normalizeTavernState" => ok(normalize_tavern_state(a(0))),
        "tavernRoundFor" => ok_opt(tavern_round_for(v(0), v(1)).map(|round| round.to_json())),
        "tavernGamblerPurseFor" => Ok(tavern_gambler_purse_for(v(0), v(1)).map(Value::from)),
        "tavernPurseTransfer" => ok(tavern_purse_transfer(a(0), a(1)).to_json()),
        "tavernPurseTransferPayload" => ok(tavern_purse_transfer_payload(a(0))),
        "tavernOpenRounds" => ok(rounds(tavern_open_rounds(v(0)))),
        "tavernOpenRoundsAgainst" => ok(rounds(tavern_open_rounds_against(v(0), v(1)))),
        "tavernEarmarkedCpAgainst" => ok(json!(tavern_earmarked_cp_against(v(0), v(1)))),
        "tavernFreePurseFor" => ok(sk_core::js::num(tavern_free_purse_for(v(0), v(1)))),
        "tavernMaxStakeFor" => ok(json!(tavern_max_stake_for(v(0), v(1)))),
        "tavernDrinksFor" => ok(json!(tavern_drinks_for(v(0), v(1)))),
        "tavernScandalsFor" => ok(json!(tavern_scandals_for(v(0), v(1)))),
        "tavernEjected" => ok(json!(tavern_ejected(v(0), v(1)))),
        "tavernNextDrinkDc" => ok_opt(tavern_next_drink_dc(v(0), v(1)).map(Value::from)),
        "tavernSocialBonus" => ok(json!(tavern_social_bonus(v(0), v(1), a(2)))),
        "tavernTableMood" => ok_opt(tavern_table_mood(v(0), v(1))),
        "tavernForViewer" => ok_opt(tavern_for_viewer(v(0), v(1))),
        "publicTavernRoundFor" => ok_opt(public_tavern_round_for(a(0))),
        "applyTavernEvent" => ok(apply_tavern_event(a(0), v(1), &json!({}))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn tavern_life_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/tavern-life.json"));
    let summary = check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 5_000, "{summary:?}");
}
