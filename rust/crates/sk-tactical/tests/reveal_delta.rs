//! Сверка `reveal_delta` с эталоном JS (`fixtures/reveal-delta.json`,
//! генератор `fixtures/gen-reveal-delta.mjs`) и перенос проверок дельт из
//! `test/combat-bounds.test.mjs`.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, hash, parse, stringify};
use serde_json::{json, Value};
use sk_tactical::reveal_delta as d;
use sk_tactical::tactical_map::{self as t, CellPatch, TacticalMap, TacticalMapOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/reveal-delta.json")));

fn read(raw: &Value) -> TacticalMap {
    t::deserialize_tactical_map(raw).expect("карта эталона")
}

fn error(message: String) -> Value {
    json!({ "error": { "name": "Error", "code": null, "message": message } })
}

fn ok(value: Value) -> Value {
    json!({ "ok": value })
}

#[test]
fn pairs_match_js() {
    assert_eq!(FIXTURE["version"], d::REVEAL_DELTA_VERSION);
    for (number, pair) in array(&FIXTURE["pairs"]).iter().enumerate() {
        let before = read(&pair["before"]);
        let after = read(&pair["after"]);
        let context = format!("пара #{number}");
        let delta = match d::reveal_delta(&before, &after, pair["baseHash"].as_str().unwrap()) {
            Ok(delta) => delta,
            Err(message) => {
                assert_same(&error(message), &pair["delta"], &context);
                continue;
            }
        };
        assert_same(&ok(delta.clone()), &pair["delta"], &context);
        assert_eq!(json!(d::reveal_delta_empty(Some(&delta))), pair["empty"], "{context}: пустота");
        assert_eq!(sk_core::js::num(d::reveal_delta_size(Some(&delta))), pair["size"], "{context}: размер");
        let mut rebuilt = read(&pair["before"]);
        let applied = match d::apply_reveal_delta(&mut rebuilt, &delta) {
            Err(message) => error(message),
            Ok(()) => {
                let serialized = t::serialize_tactical_map(&rebuilt).unwrap();
                let mut grid = Vec::new();
                for y in 0..rebuilt.height {
                    for x in 0..rebuilt.width {
                        grid.push(t::cell_at(&rebuilt, x, y).map_or(Value::Null, |cell| cell.to_json()));
                    }
                }
                ok(json!({ "serialized": hash(&serialized), "equalsAfter": stringify(&serialized) == stringify(&pair["after"]), "cells": hash(&Value::Array(grid)) }))
            }
        };
        assert_same(&applied, &pair["applied"], &context);
    }
}

#[test]
fn corrupted_deltas_match_js() {
    let pairs = array(&FIXTURE["pairs"]);
    for (number, case) in array(&FIXTURE["corrupted"]).iter().enumerate() {
        let mut map = read(&pairs[case["base"].as_u64().unwrap() as usize]["before"]);
        let delta = arg(&case["delta"]).cloned().unwrap_or(Value::Null);
        let outcome = match d::apply_reveal_delta(&mut map, &delta) {
            Ok(()) => ok(Value::String(hash(&t::serialize_tactical_map(&map).unwrap()))),
            Err(message) => error(message),
        };
        assert_same(&outcome, &case["outcome"], &format!("дельта #{number}: {}", stringify(&delta)));
    }
}

#[test]
fn emptiness_and_size_match_js() {
    for case in array(&FIXTURE["emptiness"]) {
        assert_eq!(json!(d::reveal_delta_empty(arg(&case[0]))), case[1], "{}", stringify(&case[0]));
    }
    for case in array(&FIXTURE["sizes"]) {
        let size = d::reveal_delta_size(arg(&case[0]));
        let actual = if size.is_nan() { json!("NaN") } else { sk_core::js::num(size) };
        assert_eq!(actual, case[1], "{}", stringify(&case[0]));
    }
}

#[test]
fn reveal_updates_match_js() {
    let pairs = array(&FIXTURE["pairs"]);
    for case in array(&FIXTURE["updates"]) {
        let pair = &pairs[case["pair"].as_u64().unwrap() as usize];
        let junk = json!({ "width": "x" });
        let client_map = match case["clientMap"].as_str().unwrap() {
            "before" => Some(&pair["before"]),
            "null" => Some(&Value::Null),
            "junk" => Some(&junk),
            "first" => Some(&pairs[0]["before"]),
            _ => None,
        };
        let current = case["currentHash"].as_str().unwrap();
        let result = match d::reveal_update_for(&pair["after"], current, arg(&case["clientHash"]).and_then(Value::as_str), client_map) {
            Ok(update) => ok(Value::String(hash(&update.to_json(&pair["after"], current)))),
            Err(message) => {
                // Отказ разбора карты в JS — `TacticalMapError` со своим кодом.
                let expected = &case["result"]["error"];
                assert_eq!(expected["message"], message.as_str(), "{}", stringify(case));
                continue;
            }
        };
        assert_same(&result, &case["result"], &stringify(case));
    }
}

fn plain(width: i64, height: i64, revealed: bool) -> TacticalMap {
    let fill = CellPatch { passable: Some(true), revealed: Some(revealed), ..CellPatch::default() };
    t::create_tactical_map(&TacticalMapOptions { width, height, fill: Some(fill), ..TacticalMapOptions::default() }).unwrap()
}

fn copy(map: &TacticalMap) -> TacticalMap {
    t::deserialize_tactical_map(&t::serialize_tactical_map(map).unwrap()).unwrap()
}

#[test]
fn delta_stores_runs_not_coordinates() {
    let before = plain(100, 100, false);
    let mut after = copy(&before);
    let mut opened = 0;
    for y in 44..=56 {
        for x in 44..=56 {
            if f64::hypot((x - 50) as f64, (y - 50) as f64) > 6.0 {
                continue;
            }
            t::set_cell(&mut after, x, y, &CellPatch { revealed: Some(true), ..CellPatch::default() }).unwrap();
            opened += 1;
        }
    }
    let delta = d::reveal_delta(&before, &after, &t::tactical_map_hash(&before).unwrap()).unwrap();
    assert_eq!(d::reveal_delta_size(Some(&delta)), opened as f64);
    assert!((delta["revealed"].as_array().unwrap().len() as f64) < opened as f64 / 4.0, "упаковка не работает");
    assert!(stringify(&delta).len() as f64 / 1024.0 <= 4.0, "порог плана — 4 КБ");
}

#[test]
fn applying_delta_matches_direct_reveal_and_can_hide() {
    let before = plain(40, 40, false);
    let mut after = copy(&before);
    for x in 10..20 {
        t::set_cell(&mut after, x, 10, &CellPatch { revealed: Some(true), ..CellPatch::default() }).unwrap();
    }
    t::set_cell(&mut after, 5, 5, &CellPatch { revealed: Some(true), ..CellPatch::default() }).unwrap();
    let delta = d::reveal_delta(&before, &after, "base").unwrap();
    let mut rebuilt = copy(&before);
    d::apply_reveal_delta(&mut rebuilt, &delta).unwrap();
    for y in 0..40 {
        for x in 0..40 {
            assert_eq!(t::cell_at(&rebuilt, x, y).map(|cell| cell.revealed), t::cell_at(&after, x, y).map(|cell| cell.revealed), "клетка {x},{y}");
        }
    }
    let shown = plain(10, 10, true);
    let mut hidden = copy(&shown);
    t::set_cell(&mut hidden, 3, 3, &CellPatch { revealed: Some(false), ..CellPatch::default() }).unwrap();
    let delta = d::reveal_delta(&shown, &hidden, "base").unwrap();
    assert_eq!(delta["hidden"].as_array().unwrap().len(), 1);
    let mut rebuilt = copy(&shown);
    d::apply_reveal_delta(&mut rebuilt, &delta).unwrap();
    assert!(!t::cell_at(&rebuilt, 3, 3).unwrap().revealed);
    assert!(d::reveal_delta_empty(Some(&d::reveal_delta(&shown, &copy(&shown), "base").unwrap())));
}

#[test]
fn update_choice_and_size_mismatch() {
    let map = plain(20, 20, false);
    let serialized = t::serialize_tactical_map(&map).unwrap();
    let hash = t::tactical_map_hash(&map).unwrap();
    assert_eq!(d::reveal_update_for(&serialized, &hash, None, None).unwrap(), d::RevealUpdate::Full, "клиент без карты получает её целиком");
    let mut next = copy(&map);
    t::set_cell(&mut next, 5, 5, &CellPatch { revealed: Some(true), ..CellPatch::default() }).unwrap();
    let warm = d::reveal_update_for(&t::serialize_tactical_map(&next).unwrap(), &hash, Some(&hash), Some(&serialized)).unwrap();
    let d::RevealUpdate::Delta(delta) = warm else { panic!("ожидалась дельта") };
    assert_eq!(d::reveal_delta_size(Some(&delta)), 1.0);
    assert_eq!(d::reveal_update_for(&serialized, &hash, Some("другая"), Some(&serialized)).unwrap(), d::RevealUpdate::Full, "при чужом хеше дельту слать нельзя");
    let small = plain(10, 10, true);
    let big = plain(20, 20, true);
    assert!(d::reveal_delta(&small, &big, "base").unwrap_err().contains("одной карты"));
    let mut target = plain(10, 10, true);
    let wrong = json!({ "version": d::REVEAL_DELTA_VERSION, "width": 20, "revealed": [], "hidden": [] });
    assert!(d::apply_reveal_delta(&mut target, &wrong).unwrap_err().contains("другая ширина"));
}
