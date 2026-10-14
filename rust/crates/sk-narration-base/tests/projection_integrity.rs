//! Сверка `projection_integrity` с эталоном JS (`fixtures/gen-projection-integrity.mjs`):
//! строка канонической проекции байт в байт и её SHA-256.

use serde_json::Value;
use sk_narration_base::jsx;
use sk_narration_base::projection_integrity::{canonical_projection, compare_projection, projection_hash};

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
        assert_eq!(projection_hash(&state), case["hash"].as_str().expect("хеш"), "{}", case["state"]);
    }
}

#[test]
fn comparisons_match_js() {
    let fixture = fixture();
    for case in fixture["comparisons"].as_array().expect("сравнения") {
        let result = compare_projection(&parse(&case["left"]), &parse(&case["right"]));
        assert_eq!(serde_json::to_value(&result).expect("json"), case["result"], "{} / {}", case["left"], case["right"]);
    }
}
