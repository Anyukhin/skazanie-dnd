//! `Math.cos` V8 побитно: `sk_core::v8math::cos` против эталона Node
//! (`fixtures/math-cos.json`, генератор `fixtures/gen-math-cos.mjs`). Контур
//! опушки открытой местности считается косинусом, и последний бит решает
//! клетку кромки.

use sk_core::v8math::cos;

fn bits(text: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(text, 16).expect("битовый образ"))
}

#[test]
fn cos_matches_v8_bit_for_bit() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/math-cos.json")).expect("эталон");
    let cases = fixture["cases"].as_array().expect("случаи");
    assert!(cases.len() > 10_000);
    let mut failures = Vec::new();
    for case in cases {
        let x = bits(case[0].as_str().expect("x"));
        let expected = bits(case[1].as_str().expect("cos"));
        let actual = cos(x);
        if actual.to_bits() != expected.to_bits() && !(actual.is_nan() && expected.is_nan()) {
            failures.push(format!("cos({x:e}) = {actual:e}, V8 {expected:e}"));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}: {:?}", failures.len(), cases.len(), &failures[..failures.len().min(5)]);
}
