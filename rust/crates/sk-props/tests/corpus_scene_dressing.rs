//! Корпус генераторов сцен (`fixtures/corpus-scene-dressing.json.gz`,
//! `fixtures/gen-corpus.mjs`): каждый вызов `placeVignettes`,
//! `roughenGround`, `markLowFurniture`, `placeRuinsField` и
//! `vignettesNamedBy`, сделанный темами `scene-themes` JS (таверна после
//! драки, храм и заброшенный храм, деревня, лес, тракт, кладбище, пещера,
//! склеп, зима, пустыня), повторяется в Rust на той же карте и сверяется
//! хешем итога и ответом.

mod common;

use std::collections::HashMap;

use common::{array, map_hash, parse_gz, restore, run_dressing};
use serde_json::json;
use sk_props::scene_dressing::vignettes_named_by;
use sk_tactical::tactical_map::TacticalMap;

#[test]
fn generator_corpus_matches_js() {
    let fixture = parse_gz(include_bytes!("../fixtures/corpus-scene-dressing.json.gz"));
    let calls = array(&fixture["calls"]);
    let mut outputs: Vec<Option<TacticalMap>> = Vec::with_capacity(calls.len());
    let mut mismatches = Vec::new();
    let mut ops: HashMap<String, usize> = HashMap::new();
    for (index, call) in calls.iter().enumerate() {
        let op = call["fn"].as_str().expect("функция");
        *ops.entry(op.to_string()).or_insert(0) += 1;
        if op == "vignettesNamedBy" {
            let args = &call["args"];
            let result = json!(vignettes_named_by(args[0].as_str().unwrap_or_default(), args[1].as_str().unwrap_or_default()));
            if result != call["result"] {
                mismatches.push(format!("вызов {index} ({op}): {result} вместо {}", call["result"]));
            }
            outputs.push(None);
            continue;
        }
        let input = &call["input"];
        let mut map = match input.get("from").and_then(|from| from.as_u64()) {
            Some(from) => outputs[from as usize].clone().expect("карта прежнего вызова"),
            None => restore(&input["map"]),
        };
        let result = run_dressing(&mut map, op, &call["args"]);
        if result != call["result"] {
            mismatches.push(format!("вызов {index} ({op}): ответ {result} вместо {}", call["result"]));
        }
        if map_hash(&map) != call["hash"].as_str().unwrap_or_default() {
            mismatches.push(format!("вызов {index} ({op}, {}): карта расходится", call["args"]));
        }
        outputs.push(Some(map));
    }
    assert!(mismatches.is_empty(), "расхождений {} из {}:\n{}", mismatches.len(), calls.len(), mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
    for op in ["placeVignettes", "roughenGround", "markLowFurniture", "placeRuinsField", "vignettesNamedBy"] {
        assert!(ops.get(op).copied().unwrap_or(0) >= 10, "вызовов {op} мало: {ops:?}");
    }
}
