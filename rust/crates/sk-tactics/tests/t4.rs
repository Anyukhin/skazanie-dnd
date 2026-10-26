//! Сверка сводки удара для куклы героя (#188) с эталоном JS
//! (`fixtures/gen-t4.mjs` → `fixtures/t4.json.gz`): `weaponAttackSummary`
//! движка и `withWeaponAttackSummaries` проекции зрителя — на учебных отрядах
//! всех классов с оружием, доспехами, мусором в инвентаре и бонусами
//! состояний. Плюс перенос `test/weapon-attack-view.test.mjs`.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_rules::preview_attack::weapon_attack_summary;
use sk_tactics::weapon_attack_view::with_weapon_attack_summaries;

struct Fixture {
    states: Vec<Value>,
    cases: Vec<Value>,
}

static FIXTURE: LazyLock<Fixture> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/t4.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    let mut root: Value = serde_json::from_str(&text).expect("эталон JSON");
    let take = |root: &mut Value, key: &str| match root.get_mut(key).map(Value::take) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key}"),
    };
    Fixture { states: take(&mut root, "states"), cases: take(&mut root, "cases") }
});

fn state(index: &Value) -> Option<&'static Value> {
    index.as_u64().map(|index| &FIXTURE.states[index as usize])
}

/// SHA-256 `JSON.stringify(value)`; `undefined` — строка `undefined`.
fn digest(value: Option<&Value>) -> String {
    hash::sha256_hex(value.map_or_else(|| "undefined".to_string(), js::stringify))
}

#[test]
fn summaries_match_js() {
    let mut answered = 0;
    let mut count = 0;
    for case in FIXTURE.cases.iter().filter(|case| case["kind"] == "summary") {
        count += 1;
        let trusted = state(&case["state"]).expect("состояние");
        let actual = weapon_attack_summary(trusted, case["actor"].as_str().expect("actor"), case["item"].as_str().expect("item")).unwrap_or(Value::Null);
        assert_eq!(js::stringify(&actual), js::stringify(&case["result"]), "сводка {} / {}", case["actor"], case["item"]);
        if !actual.is_null() {
            answered += 1;
        }
    }
    assert!(count >= 300 && answered >= 150, "случаев {count}, с ответом {answered}");
}

#[test]
fn views_match_js() {
    let mut count = 0;
    for case in FIXTURE.cases.iter().filter(|case| case["kind"] == "view") {
        count += 1;
        let trusted = state(&case["state"]);
        let projected = match case["projected"].get("$fromState") {
            Some(index) => {
                let source = state(index).expect("состояние проекции");
                Some(json!({ "sessionCode": "T4", "players": source["players"].clone() }))
            }
            None => Some(case["projected"].clone()),
        };
        let viewer = match &case["viewer"] {
            Value::Object(marker) if marker.contains_key("$js") => None,
            other => Some(other),
        };
        let output = with_weapon_attack_summaries(projected.as_ref(), trusted, viewer);
        assert_eq!(digest(output.as_ref()), case["hash"].as_str().expect("hash"), "проекция зрителя {}", case["viewer"]);
        if case["same"] == true {
            assert_eq!(output, projected, "без сводок проекция возвращается как есть");
        }
    }
    assert!(count >= 150, "случаев {count}");
}

/// Перенос `test/weapon-attack-view.test.mjs`: сводка — только на надетом
/// оружии своего героя, ведущему — на всех; без инвентаря — та же проекция.
#[test]
fn summary_goes_only_to_own_equipped_weapons() {
    let trusted = &FIXTURE.states[0];
    let players = trusted["players"].as_array().expect("игроки");
    let projected = json!({ "players": players });
    let own_id = players[0]["id"].clone();
    let own = with_weapon_attack_summaries(Some(&projected), Some(trusted), Some(&own_id)).expect("проекция");
    for (index, player) in own["players"].as_array().expect("игроки").iter().enumerate() {
        for item in player["inventory"].as_array().expect("инвентарь") {
            let has = item.get("attack_summary").is_some_and(|summary| summary.get("stale").is_none());
            if index > 0 {
                assert!(!has, "модификатор соседа по столу не раскрывается");
            } else if has {
                assert_eq!(item["equipped"], true, "сводка только у надетого");
            }
        }
    }
    let no_inventory = json!({ "players": [{ "id": own_id }] });
    assert_eq!(with_weapon_attack_summaries(Some(&no_inventory), Some(trusted), Some(&own_id)), Some(no_inventory));
    assert_eq!(with_weapon_attack_summaries(None, Some(trusted), None), None);
}
