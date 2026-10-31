//! Сверка `projection_integrity` с эталоном JS (`fixtures/gen-projection-integrity.mjs`):
//! строка канонической проекции байт в байт и её SHA-256.

use serde_json::Value;
use sk_narration_base::jsx;
use sk_narration_base::projection_integrity::{canonical_projection, canonical_projection_json, compare_projection, projection_hash};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/projection-integrity.json")).expect("эталон")
}

fn parse(text: &Value) -> Value {
    serde_json::from_str(text.as_str().expect("строка JSON")).expect("состояние")
}

#[test]
fn canonical_projection_and_hash_match_js() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("случаи");
    assert!(cases.len() >= 250);
    for case in cases {
        let state = parse(&case["state"]);
        assert_eq!(jsx::stringify(&canonical_projection(&state)), case["canonical"].as_str().expect("строка"), "{}", case["state"]);
        assert_eq!(canonical_projection_json(&state), case["canonical"].as_str().expect("строка"), "прямой писатель (Ск4): {}", case["state"]);
        assert_eq!(projection_hash(&state), case["hash"].as_str().expect("хеш"), "{}", case["state"]);
    }
}

/// Прямой писатель проекции (Ск4) на произвольных значениях: ключи-индексы,
/// не-ASCII и суррогатные пары в ключах, игроки-массивы и игроки-строки,
/// числа на границах — та же строка, что у `jsx::stringify(canonical_projection)`.
#[test]
fn direct_writer_matches_canonical_projection_on_edge_values() {
    let tricky = serde_json::json!({
        "scene": { "b": 1, "a": 2, "10": 3, "2": 4, "01": 5, "я": 6, "z": 7, "😀": 8, "\u{e000}": 9, "Z": [1.5, -0.0, 1e21, 1e-7, 9007199254740993u64, -9007199254740991i64] },
        "players": [{ "online": true, "id": "a", "c": { "2": 0, "1": 1 } }, ["x", { "k": 1, "j": 2 }], "строка", null, 5],
        "mechanics": { "positions": { "hero": { "x": 1, "y": 2 } }, "\"": "\n\u{1}" },
        "chat": ["не в проекции"],
        "state_version": 7,
    });
    for state in [tricky.clone(), serde_json::json!({ "players": { "0": 1 } }), serde_json::json!([]), Value::Null, serde_json::json!({ "agentInteraction": { "b": 1, "a": 0 } })] {
        assert_eq!(canonical_projection_json(&state), jsx::stringify(&canonical_projection(&state)), "{state}");
    }
    let mut online = tricky.clone();
    online["players"][0]["online"] = Value::Bool(false);
    assert!(compare_projection(&tricky, &online).matched, "online не влияет на сверку");
    let mut moved = tricky;
    moved["scene"]["a"] = serde_json::json!(3);
    assert!(!compare_projection(&online, &moved).matched);
}

#[test]
fn comparisons_match_js() {
    let fixture = fixture();
    for case in fixture["comparisons"].as_array().expect("сравнения") {
        let result = compare_projection(&parse(&case["left"]), &parse(&case["right"]));
        assert_eq!(serde_json::to_value(&result).expect("json"), case["result"], "{} / {}", case["left"], case["right"]);
    }
}
