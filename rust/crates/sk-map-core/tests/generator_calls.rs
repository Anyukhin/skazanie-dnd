//! Сверка вызовов изнутри настоящих генераторов карт (`fixtures/generator-calls.json`,
//! генератор `fixtures/gen-generator-calls.mjs`): цепочка вызовов одной карты
//! исполняется подряд, каждая карта после вызова сверяется хешем сериализации,
//! итог вызова — целиком.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, attempt, hash, parse, restore, round_trip, serialize, stringify};
use serde_json::Value;
use sk_map_core::thin_walls::{thin_walls, ThinWallsOptions};
use sk_tactical::tactical_map::TacticalMap;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/generator-calls.json")));

fn thin_walls_options(value: &Value) -> ThinWallsOptions {
    match value.get("keepBorder") {
        Some(flag) => ThinWallsOptions { keep_border: sk_core::js::truthy(Some(flag)) },
        None => ThinWallsOptions::default(),
    }
}

/// Исполнить записанный вызов над картой; итог — `{ ok }` или `{ error }`.
fn run_call(map: &mut TacticalMap, name: &str, input: &Value) -> Value {
    match name {
        "thinWalls" => attempt(thin_walls(map, &thin_walls_options(&input["options"])).map(|report| report.to_json())),
        other => panic!("в эталоне вызов {other}, а он ещё не перенесён"),
    }
}

#[test]
fn generator_calls_match_js() {
    let chains = array(&FIXTURE["chains"]);
    assert!(chains.len() > 100, "мало цепочек: {}", chains.len());
    let mut calls = 0;
    for (index, chain) in chains.iter().enumerate() {
        let label = format!("{} #{index}", chain["run"].as_str().unwrap_or(""));
        let mut map = restore(&chain["before"]);
        for (step, call) in array(&chain["calls"]).iter().enumerate() {
            let name = call["fn"].as_str().expect("имя функции");
            if step > 0 {
                map = round_trip(&map);
            }
            let result = run_call(&mut map, name, &call["input"]);
            let context = format!("{label} шаг {step} {name}");
            assert_same(&result, &call["result"], &context);
            let after = serialize(&map);
            assert_eq!(hash(&after), call["after"].as_str().unwrap_or(""), "карта после вызова: {context}\n{}", common::head(&stringify(&after)));
            calls += 1;
        }
    }
    assert!(calls >= chains.len());
}
