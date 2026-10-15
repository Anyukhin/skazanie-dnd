//! Корпус генераторов сцен (`fixtures/corpus-prop-placement.json.gz`,
//! `fixtures/gen-corpus.mjs`): каждый вызов `placeProps`, `ensurePropAccess`,
//! `placeColonnade`, `placeRequiredProps`, сделанный настоящими генераторами
//! JS — здания, поселения, этажи, темы, программы сцен, — повторяется в Rust
//! на той же карте и сверяется хешем итога, ответом и отказом.

mod common;

use std::collections::HashMap;

use common::{array, assert_error, map_hash, parse_gz, restore, run_placement};
use sk_tactical::tactical_map::TacticalMap;

#[test]
fn generator_corpus_matches_js() {
    let fixture = parse_gz(include_bytes!("../fixtures/corpus-prop-placement.json.gz"));
    let calls = array(&fixture["calls"]);
    let mut outputs: Vec<TacticalMap> = Vec::with_capacity(calls.len());
    let mut mismatches = Vec::new();
    let mut ops: HashMap<String, usize> = HashMap::new();
    for (index, call) in calls.iter().enumerate() {
        let op = call["fn"].as_str().expect("функция");
        *ops.entry(op.to_string()).or_insert(0) += 1;
        let input = &call["input"];
        let mut map = match input.get("from").and_then(|from| from.as_u64()) {
            Some(from) => outputs[from as usize].clone(),
            None => restore(&input["map"]),
        };
        let context = format!("вызов {index} ({op})");
        match (run_placement(&mut map, op, &call["args"]), call.get("error")) {
            (Ok(result), None) => {
                if result != call["result"] {
                    mismatches.push(format!("{context}: ответ {result} вместо {}", call["result"]));
                }
            }
            (Err(error), Some(expected)) => assert_error(expected, &error, &context),
            (Ok(_), Some(expected)) => mismatches.push(format!("{context}: ожидался отказ {expected}")),
            (Err(error), None) => mismatches.push(format!("{context}: отказ {error:?}")),
        }
        if map_hash(&map) != call["hash"].as_str().unwrap_or_default() {
            mismatches.push(format!("{context}: карта расходится (предметов {} против {})", map.props.len(), call["props"]));
        }
        outputs.push(map);
    }
    assert!(mismatches.is_empty(), "расхождений {} из {}:\n{}", mismatches.len(), calls.len(), mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    for op in ["placeProps", "ensurePropAccess", "placeColonnade", "placeRequiredProps"] {
        assert!(ops.get(op).copied().unwrap_or(0) >= 40, "вызовов {op} мало: {ops:?}");
    }
}
