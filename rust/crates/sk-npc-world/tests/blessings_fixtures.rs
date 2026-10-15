//! `blessings`: эталон JS (`fixtures/blessings.json`) — часовня через
//! настоящий Rules Engine с перехватом вызовов модуля, корпус паритета и
//! реестры с мусором старых сохранений и ключами прототипа как id героя.

mod common;

use common::{check, ok, ok_opt, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_npc_world::blessings::*;

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let v = |index: usize| args.value(index);
    match name {
        "normalizeBlessingState" => ok(normalize_blessing_state(a(0))),
        "blessingRecordFor" => ok_opt(blessing_record_for(v(0), v(1))),
        "heroIsBlessed" => ok(json!(hero_is_blessed(v(0), v(1)))),
        "blessingAvailabilityFor" => ok(blessing_availability_for(v(0), v(1), a(2)).to_json()),
        "isPriestProfile" => ok(json!(is_priest_profile(a(0)))),
        "blessingPriestsFor" => ok(Value::Array(blessing_priests_for(v(0)).iter().map(BlessingPriest::to_json).collect())),
        "isBlessingPriest" => ok(json!(is_blessing_priest(v(0), v(1)))),
        "blessingFactionIdsFor" => ok(json!(blessing_faction_ids_for(v(0), v(1)))),
        "blessingOmenFor" => ok(json!(blessing_omen_for(a(0)))),
        "blessingsForViewer" => ok(blessings_for_viewer(v(0), v(1))),
        "applyBlessingEvent" => ok(apply_blessing_event(a(0), v(1), &json!({}))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn blessings_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/blessings.json"));
    let summary = check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 3_000, "{summary:?}");
}
