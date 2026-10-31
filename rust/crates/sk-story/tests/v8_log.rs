//! Побитная сверка `sk_core::v8math::{log2, log10}` с `Math.log2` и
//! `Math.log10` Node (`fixtures/math-log.json`, генератор
//! `fixtures/gen-math-log.mjs`): ими подбор библиотечной карты считает очки.

use sk_core::v8math::{log10, log2};

fn bits(text: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(text, 16).expect("битовый образ"))
}

fn same(actual: f64, expected: f64) -> bool {
    actual.to_bits() == expected.to_bits() || (actual.is_nan() && expected.is_nan())
}

#[test]
fn logarithms_match_v8_bit_for_bit() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/math-log.json")).expect("эталон");
    let cases = fixture["cases"].as_array().expect("случаи");
    assert!(cases.len() > 5_000);
    let mut failures = Vec::new();
    for case in cases {
        let x = bits(case[0].as_str().expect("x"));
        let (expected2, expected10) = (bits(case[1].as_str().expect("log2")), bits(case[2].as_str().expect("log10")));
        if !same(log2(x), expected2) {
            failures.push(format!("log2({x:e}) = {:e}, V8 {expected2:e}", log2(x)));
        }
        if !same(log10(x), expected10) {
            failures.push(format!("log10({x:e}) = {:e}, V8 {expected10:e}", log10(x)));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}: {:?}", failures.len(), cases.len() * 2, &failures[..failures.len().min(6)]);
}
