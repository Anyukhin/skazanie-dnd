//! Сверка `combat_phrases` с эталоном JS (`fixtures/gen-combat-phrases.mjs`):
//! склонения, подписи часов, списки, зёрна и сотни сценариев одной книги фраз.

use std::sync::LazyLock;

use serde_json::Value;
use sk_narration_base::combat_phrases::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/combat-phrases.json")).expect("эталон"));

fn cases(key: &str) -> &'static [Value] {
    FIXTURE[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// Необязательное строковое поле: отсутствует — `None` (как `undefined` в JS).
fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[test]
fn names_decline_like_js() {
    let mut failures = Vec::new();
    for case in cases("names") {
        let name = text(&case["name"]);
        let accusative = accusative_name(name);
        let confident = confident_accusative(name);
        let lower = lower_first(name);
        if accusative != text(&case["accusative"]) || confident.as_deref() != case["confident"].as_str() || lower != text(&case["lower_first"]) {
            failures.push(format!("{name:?}: {accusative:?} / {confident:?} / {lower:?} против {}", case));
        }
    }
    assert!(cases("names").len() > 300);
    assert!(failures.is_empty(), "{} расхождений:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn hours_labels_match_js() {
    for case in cases("hours") {
        let value = match &case["input"] {
            Value::String(token) => sk_core::js::parse_number(token),
            other => other.as_f64().expect("число"),
        };
        assert_eq!(hours_label_ru(value), text(&case["label"]), "{}", case["input"]);
    }
}

#[test]
fn join_matches_js() {
    for case in cases("join") {
        assert_eq!(join_ru_value(Some(&case["items"])), text(&case["text"]), "{}", case["items"]);
    }
}

#[test]
fn seeds_match_js() {
    for case in cases("seeds") {
        assert_eq!(phrase_seed(Some(&case["event"])), text(&case["seed"]), "{}", case["event"]);
    }
}

fn run(book: &mut Phrasebook, call: &Value) -> String {
    let input = &call["input"];
    let event = call.get("event");
    let target = text(&input["target"]);
    let actor = text(&input["actor"]);
    match text(&call["fn"]) {
        "attack" => {
            let attack = AttackPhraseInput {
                actor,
                target,
                target_is_enemy: input["targetIsEnemy"].as_bool().unwrap_or(false),
                payload: input.get("payload"),
                reason: optional_text(input, "reason"),
                numbers: optional_text(input, "numbers"),
                damage: optional_text(input, "damage"),
                opportunity: input["opportunity"].as_bool().unwrap_or(false),
                lead: optional_text(input, "lead"),
            };
            attack_phrase(book, &attack, event)
        }
        "damage" => damage_phrase(target, input["amount"].as_f64().expect("урон"), input.get("hp").and_then(Value::as_str)),
        "downed" => downed_phrase(book, target, text(&input["side"]), event),
        "stabilized" => stabilized_phrase(book, target, event),
        "save" => save_phrase(book, target, input["saved"].as_bool(), input.get("source").and_then(Value::as_str).unwrap_or(""), event),
        "move" => move_phrase(book, actor, input["feet"].as_f64().expect("футы"), input.get("tactic").and_then(Value::as_str), input.get("mode"), event),
        "action" => action_phrase(book, actor, input.get("actionId"), text(&input["name"]), event),
        "turn_end" => turn_end_phrase(book, actor, event),
        "turn_start" => turn_start_phrase(book, actor, input["round"].as_f64().expect("раунд"), event),
        "intro" => {
            let names: Vec<&str> = input["names"].as_array().expect("имена").iter().map(text).collect();
            encounter_intro_phrase(book, &names, text(&input["setting"]), event)
        }
        "end" => encounter_end_phrase(book, text(&input["endText"]), event),
        "pick" => {
            let variants: Vec<&str> = input["variants"].as_array().expect("варианты").iter().map(text).collect();
            book.pick(text(&input["kind"]), &variants, event)
        }
        "spell_source" => spell_source_text(text(&input["label"])),
        "tactic_lead" => tactic_lead(input.get("tactic").and_then(Value::as_str)).to_string(),
        other => panic!("неизвестный вызов {other}"),
    }
}

#[test]
fn phrasebook_scenarios_match_js() {
    let scenarios = cases("scenarios");
    let mut total = 0;
    let mut failures = Vec::new();
    for (index, scenario) in scenarios.iter().enumerate() {
        let mut book = Phrasebook::new();
        for call in scenario["calls"].as_array().expect("вызовы") {
            total += 1;
            let out = run(&mut book, call);
            if out != text(&call["out"]) {
                failures.push(format!("сценарий {index}: {out:?} против {}", call));
            }
        }
    }
    assert!(scenarios.len() >= 500 && total > 2_000, "сценариев {}, вызовов {total}", scenarios.len());
    assert!(failures.is_empty(), "{} расхождений из {total}:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}
