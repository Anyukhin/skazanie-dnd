//! `world_deeds`: эталон JS (`fixtures/world-deeds.json`) — тесты модуля и
//! соседей, исполненные в процессе генератора, события корпуса паритета через
//! редьюсер и случайные кампании с цепочками «событие → летопись → молва →
//! репутация» и мусором старых сохранений.

mod common;

use common::{ok, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_world_time::world_deeds::*;

pub fn run(name: &str, args: &Args) -> Outcome {
    let a = |index: usize| args.get(index);
    let empty = json!({});
    // Параметр по умолчанию `= {}` в JS: `undefined` — пустой объект.
    let d = |index: usize| args.get(index).unwrap_or(&empty);
    match name {
        "normalizeWorldDeedsState" => ok(normalize_world_deeds_state(a(0))),
        "deedFromEvent" => ok(deed_from_event(d(0), d(1)).unwrap_or(Value::Null)),
        "applyWorldDeedEvent" => ok(apply_world_deed_event(a(0), args.value(1), d(2))),
        "worldDeedsFeed" => ok(Value::Array(world_deeds_feed(d(0), d(1)))),
        "worldNodeIdFor" => ok(world_node_id_for(args.value(0), a(1))),
        "worldHopDistances" => ok(Value::Array(world_hop_distances(args.value(0), a(1)).into_iter().map(|(node, hop)| json!([node, hop])).collect())),
        "rumorClaimId" => ok(Value::String(rumor_claim_id(a(0), a(1)))),
        "rumorWording" => ok(Value::String(rumor_wording(d(0), a(1)))),
        "rumorSpreadTargets" => ok(Value::Array(rumor_spread_targets(d(0), d(1)))),
        "planWorldRumorTick" => ok(plan_world_rumor_tick(d(0), d(1))),
        "rumorReputationDelta" => ok(js::num(rumor_reputation_delta(a(0), a(1)))),
        "planWorldRumorReputation" => ok(Value::Array(plan_world_rumor_reputation(d(0)))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn world_deeds_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/world-deeds.json"));
    let summary = common::check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 3_000, "{summary:?}");
}
