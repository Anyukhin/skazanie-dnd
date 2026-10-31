//! `Math.sin` как в V8 — общий `sk_core::v8math::sin`. Генератор поселения
//! синусом гнёт улицу и русло реки, а `Math.round` и сравнение `> 0.75`
//! превращают последний бит в клетку; сверка — эталон `fixtures/math-sin.json`.

pub(crate) use sk_core::v8math::sin;

#[cfg(test)]
mod tests {
    use super::sin;

    fn bits(text: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(text, 16).expect("битовый образ"))
    }

    /// Сверка с `Math.sin` Node (`fixtures/gen-math-sin.mjs`).
    #[test]
    fn sin_matches_v8_bit_for_bit() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/math-sin.json")).expect("эталон");
        let cases = fixture["cases"].as_array().expect("случаи");
        assert!(cases.len() > 5_000);
        let mut failures = Vec::new();
        for case in cases {
            let x = bits(case[0].as_str().expect("x"));
            let expected = bits(case[1].as_str().expect("sin"));
            let actual = sin(x);
            if actual.to_bits() != expected.to_bits() {
                failures.push(format!("sin({x:e}) = {actual:e}, V8 {expected:e}"));
            }
        }
        assert!(failures.is_empty(), "{} расхождений из {}: {:?}", failures.len(), cases.len(), &failures[..failures.len().min(5)]);
    }
}
