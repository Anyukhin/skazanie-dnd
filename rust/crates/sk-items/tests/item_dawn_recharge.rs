//! Сверка `item_dawn_recharge` с эталоном JS (`fixtures/item-dawn-recharge.json`,
//! генератор — `fixtures/gen-item-dawn-recharge.mjs`) и перенесённые проверки
//! модуля из `test/item-dawn-recharge.test.mjs` (путь через `AdvanceTime`,
//! проекцию и хранилище — за Rules Engine).

mod common;

use common::{check, error, ok, Outcome};
use serde_json::{json, Value};
use sk_core::{js, RuleError};
use sk_dice::{DiceService, SequenceRng};
use sk_items::item_dawn_recharge as m;

fn dice(values: Vec<i64>, prefix: &str) -> DiceService<SequenceRng> {
    DiceService::deterministic(SequenceRng::new(values), prefix)
}

fn outcome(result: Result<m::ItemDawnRecharge, RuleError>) -> Outcome {
    match result {
        Ok(recharge) => ok(recharge.to_json()),
        Err(failure) if failure.code == "ITEM_DAWN_RECHARGE_LIMIT_EXCEEDED" => Err(error("RangeError", Some(&failure.code), &failure.message)),
        // Кончилась тестовая последовательность: в JS — `RangeError` без кода.
        Err(failure) => Err(error("RangeError", None, &failure.message)),
    }
}

#[test]
fn dawn_recharge_matches_js() {
    let count = check(include_str!("../fixtures/item-dawn-recharge.json"), |name, args| -> Outcome {
        match name {
            "const:DAWN_PERIOD_MINUTES" => ok(json!(m::DAWN_PERIOD_MINUTES)),
            "const:MAX_DAWN_RECHARGE_ITEMS_PER_EVENT" => ok(json!(m::MAX_DAWN_RECHARGE_ITEMS_PER_EVENT)),
            "const:MAX_DAWN_RECHARGE_ROLLS_PER_ITEM" => ok(json!(m::MAX_DAWN_RECHARGE_ROLLS_PER_ITEM)),
            "const:ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION" => ok(json!(m::ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION)),
            "dawnCrossings" => ok(json!(m::dawn_crossings(js::safe_int(args.get(0), 0), js::safe_int(args.get(1), 0)))),
            "resolveItemDawnRecharge" => {
                let setup = args.get(2).cloned().unwrap_or(Value::Null);
                let values: Vec<i64> = setup["values"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect();
                let mut dice = dice(values, setup["prefix"].as_str().unwrap_or("dawn"));
                outcome(m::resolve_item_dawn_recharge(args.get(0).unwrap_or(&Value::Null), args.get(1), &mut dice))
            }
            "applyItemDawnRechargeToPlayers" => {
                ok(m::apply_item_dawn_recharge_to_players(args.get(0).unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null)))
            }
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 700, "{count}");
}

fn recharge() -> Value {
    json!({ "schema_version": 1, "trigger": "dawn", "formula": "1d6+1" })
}

fn rechargeable(id: &str, current: i64, maximum: i64) -> Value {
    json!({ "id": id, "name": id, "type": "other", "quantity": 1, "charges": { "current": current, "max": maximum }, "recharge": recharge() })
}

fn campaign(elapsed: i64, players: Value) -> Value {
    json!({ "players": players, "mechanics": { "world_time": { "elapsed_minutes": elapsed } } })
}

#[test]
fn dawn_arithmetic_does_not_count_the_start_twice() {
    assert_eq!(m::dawn_crossings(0, 0), 0);
    assert_eq!(m::dawn_crossings(0, 1_439), 0);
    assert_eq!(m::dawn_crossings(1_439, 1), 1);
    assert_eq!(m::dawn_crossings(1_440, 1), 0);
    assert_eq!(m::dawn_crossings(1_439, 2_881), 3);
    assert_eq!(m::dawn_crossings(0, 1_440 * 1_000_000), 1_000_000);
    let max_safe = 9_007_199_254_740_991_i64;
    let near = max_safe - 1_000;
    let expected = (max_safe as f64 / 1_440.0).floor() as i64 - (near as f64 / 1_440.0).floor() as i64;
    assert_eq!(m::dawn_crossings(near, 2_000), expected);
    let state = campaign(near, json!([{ "id": "hero", "inventory": [rechargeable("near-maximum", 0, 7)] }]));
    let capped = m::resolve_item_dawn_recharge(&state, Some(&json!(2_000)), &mut dice(vec![1], "dawn")).expect("перезарядка");
    let payload = capped.payload.expect("событие");
    assert_eq!(payload["elapsed_minutes_before"], json!(near));
    assert_eq!(payload["elapsed_minutes_after"], json!(max_safe));
}

#[test]
fn no_crossing_or_full_item_rolls_nothing() {
    let waiting = campaign(1_000, json!([{ "id": "hero", "inventory": [rechargeable("waiting", 2, 7)] }]));
    let none = m::resolve_item_dawn_recharge(&waiting, Some(&json!(439)), &mut dice(vec![], "dawn")).expect("без рассвета");
    assert_eq!(none, m::ItemDawnRecharge { payload: None, rolls: vec![] });
    let full = campaign(1_439, json!([{ "id": "hero", "inventory": [rechargeable("full", 7, 7)] }]));
    let none = m::resolve_item_dawn_recharge(&full, Some(&json!(1)), &mut dice(vec![], "dawn")).expect("полный");
    assert_eq!(none.payload, None);
    assert!(none.rolls.is_empty());
}

#[test]
fn aggregate_sorts_heroes_and_items_and_keeps_rolls_private() {
    let state = campaign(
        1_439,
        json!([
            { "id": "zeta", "inventory": [rechargeable("z-item", 0, 7), rechargeable("a-item", 1, 7)] },
            { "id": "alpha", "inventory": [rechargeable("middle-item", 2, 7)] },
        ]),
    );
    let result = m::resolve_item_dawn_recharge(&state, Some(&json!(1)), &mut dice(vec![1, 2, 3], "dawn")).expect("перезарядка");
    let payload = result.payload.expect("событие");
    assert_eq!(payload["dawns_crossed"], json!(1));
    let items = payload["items"].as_array().expect("предметы");
    let order: Vec<String> = items.iter().map(|item| format!("{}/{}", js::s(item.get("owner_id")), js::s(item.get("item_id")))).collect();
    assert_eq!(order, ["alpha/middle-item", "zeta/a-item", "zeta/z-item"]);
    let spans: Vec<(i64, i64)> = items.iter().map(|item| (item["before"].as_i64().unwrap_or(-1), item["after"].as_i64().unwrap_or(-1))).collect();
    assert_eq!(spans, [(2, 4), (1, 4), (0, 4)]);
    for item in items {
        assert_eq!(item["recharge"], recharge());
        assert!(item["recharge"].get("max_charges").is_none());
        assert_eq!(item["rolls"].as_array().map(Vec::len), Some(1));
        assert_eq!(item["rolls"][0]["visibility"], json!("gm_only"));
    }
    assert_eq!(result.rolls.len(), 3);
    let event = json!({ "event_schema_version": 1, "payload": payload });
    let players = m::apply_item_dawn_recharge_to_players(&state["players"], &event);
    assert_eq!(players[1]["inventory"][0]["charges"], json!({ "current": 4, "max": 7 }));
}

#[test]
fn several_dawns_roll_only_until_full_and_within_the_bound() {
    let state = campaign(1_439, json!([{ "id": "hero", "inventory": [rechargeable("wand-like", 0, 7)] }]));
    let result = m::resolve_item_dawn_recharge(&state, Some(&json!(1_440 * 100)), &mut dice(vec![1, 1, 1, 1], "dawn")).expect("перезарядка");
    let item = &result.payload.expect("событие")["items"][0];
    let rolls = item["rolls"].as_array().expect("броски");
    assert_eq!(rolls.len() as i64, m::MAX_DAWN_RECHARGE_ROLLS_PER_ITEM);
    let after: Vec<i64> = rolls.iter().filter_map(|roll| roll["charges_after"].as_i64()).collect();
    assert_eq!(after, [2, 4, 6, 7]);
    assert_eq!(item["after"], json!(7));
    assert_eq!(result.rolls.len() as i64, m::MAX_DAWN_RECHARGE_ROLLS_PER_ITEM);
}

#[test]
fn reducer_replays_payload_and_ignores_unknown_versions() {
    let players = json!([{ "id": "hero", "inventory": [{ "id": "versioned", "charges": { "current": 1, "max": 7 }, "recharge": { "schema_version": 999, "trigger": "midnight", "formula": "100d100" } }] }]);
    let payload = json!({
        "schema_version": 1, "trigger": "dawn", "elapsed_minutes_before": 1_439, "elapsed_minutes_after": 1_440, "dawns_crossed": 1,
        "items": [{ "owner_id": "hero", "item_id": "versioned", "recharge": recharge(), "before": 1, "after": 6, "max": 7, "rolls": [] }],
    });
    let applied = m::apply_item_dawn_recharge_to_players(&players, &json!({ "event_schema_version": 1, "payload": payload }));
    assert_eq!(applied[0]["inventory"][0]["charges"], json!({ "current": 6, "max": 7 }));
    for event in [
        json!({ "payload": payload }),
        json!({ "event_schema_version": 2, "payload": payload }),
        json!({ "event_schema_version": 1, "payload": js::spread(&payload, json!({ "schema_version": 2 })) }),
    ] {
        assert_eq!(m::apply_item_dawn_recharge_to_players(&players, &event)[0]["inventory"][0]["charges"], json!({ "current": 1, "max": 7 }));
    }
}

#[test]
fn known_catalog_id_ignores_forged_recharge_and_bad_homebrew_is_inert() {
    let state = campaign(
        1_439,
        json!([{ "id": "hero", "inventory": [
            js::spread(&rechargeable("forged-ring", 0, 7), json!({ "catalog_id": "srd_5_2_1:ring-of-protection" })),
            js::spread(&rechargeable("bad-homebrew", 0, 7), json!({ "recharge": { "schema_version": 1, "trigger": "dawn", "formula": "1d20+20" } })),
        ] }]),
    );
    let result = m::resolve_item_dawn_recharge(&state, Some(&json!(1)), &mut dice(vec![], "dawn")).expect("перезарядка");
    assert_eq!(result.payload, None);
    assert!(result.rolls.is_empty());
}

#[test]
fn oversized_aggregate_is_rejected_before_the_first_roll() {
    let inventory: Vec<Value> = (0..=m::MAX_DAWN_RECHARGE_ITEMS_PER_EVENT).map(|index| rechargeable(&format!("item-{index:03}"), 0, 7)).collect();
    let state = campaign(1_439, json!([{ "id": "hero", "inventory": inventory }]));
    let failure = m::resolve_item_dawn_recharge(&state, Some(&json!(1)), &mut dice(vec![], "dawn")).expect_err("лимит");
    assert_eq!(failure.code, "ITEM_DAWN_RECHARGE_LIMIT_EXCEEDED");
}
