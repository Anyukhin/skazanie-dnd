//! Общие помощники модулей: ГПСЧ по сиду (`randomFor`), `Math.max` с
//! заразным NaN, `Math.hypot` по алгоритму V8 и чтение клетки по дробным
//! координатам, как `cellAt(map, Math.floor(x), Math.floor(y))`.

use sk_core::hash;
use sk_tactical::tactical_map::{cell_at, edge_between, TacticalCell, TacticalEdge, TacticalMap};

/// `randomFor(seed)`: первые четыре байта SHA-256 строки сида (little-endian,
/// ноль заменяется единицей), затем линейный конгруэнтный генератор
/// `state = (Math.imul(state, 1664525) + 1013904223) >>> 0`.
pub(crate) struct SeedRandom {
    state: u32,
}

impl SeedRandom {
    pub(crate) fn new(seed: &str) -> Self {
        let digest = hash::sha256(seed.as_bytes());
        let state = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
        Self { state: if state == 0 { 1 } else { state } }
    }

    /// Следующее число из `[0, 1)`.
    pub(crate) fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.state) / 4_294_967_296.0
    }
}

/// `Math.max(a, b)`: NaN заразен, `+0` больше `-0`.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a == 0.0 && a.is_sign_negative() { b } else { a };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.hypot(a, b)` как в V8 (`MathHypot`, `math.tq`): нормировка на
/// наибольший модуль и суммирование Кэхэна, затем `sqrt(sum) * max`.
pub(crate) fn js_hypot(a: f64, b: f64) -> f64 {
    let mut absolute = [0.0_f64; 2];
    let mut max = 0.0_f64;
    let mut one_is_nan = false;
    for (slot, value) in [a, b].into_iter().enumerate() {
        if value.is_nan() {
            one_is_nan = true;
        } else {
            absolute[slot] = value.abs();
            if absolute[slot] > max {
                max = absolute[slot];
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if one_is_nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for value in absolute {
        let normalized = value / max;
        let summand = normalized * normalized - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Целое из `Math.floor(value)`, если оно может быть клеткой: `cellIndex` JS
/// отвергает не целые (NaN, бесконечность), а за пределами безопасных целых
/// клеток нет вовсе.
pub(crate) fn floor_cell(value: f64) -> Option<i64> {
    let floored = value.floor();
    (floored.is_finite() && floored.abs() <= 9_007_199_254_740_991.0).then_some(floored as i64)
}

/// `cellAt(map, Math.floor(x), Math.floor(y))`.
pub(crate) fn cell_at_floor(map: &TacticalMap, x: f64, y: f64) -> Option<TacticalCell<'_>> {
    cell_at(map, floor_cell(x)?, floor_cell(y)?)
}

/// `edgeBetween` для заведомо соседних клеток.
pub(crate) fn edge_at(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> Option<&TacticalEdge> {
    edge_between(map, ax, ay, bx, by).ok().flatten()
}

/// `!Number(value)`: ноль и NaN ложны.
pub(crate) fn falsy_number(value: f64) -> bool {
    value == 0.0 || value.is_nan()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_follows_js() {
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_max(1.0, f64::NAN).is_nan());
        assert_eq!(js_max(2.0, 1.0), 2.0);
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_max(0.0, -0.0).is_sign_positive());
        assert!(js_max(-0.0, -0.0).is_sign_negative());
    }

    #[test]
    fn hypot_follows_v8() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, 0.0), 0.0);
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
        assert_eq!(js_hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn random_is_deterministic() {
        let mut first = SeedRandom::new("seed");
        let mut second = SeedRandom::new("seed");
        for _ in 0..10 {
            let value = first.next();
            assert_eq!(value, second.next());
            assert!((0.0..1.0).contains(&value));
        }
    }
}

#[cfg(test)]
mod fixture_tests {
    use super::js_hypot;
    use serde_json::Value;

    /// `Math.hypot` на дробных разностях — побитно как у V8 (раздел `hypot`).
    #[test]
    fn hypot_matches_v8_bit_for_bit() {
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/prop-placement.json")).expect("эталон");
        let value = |text: &Value| f64::from_bits(u64::from_str_radix(text.as_str().unwrap_or_default(), 16).expect("биты"));
        let rows = fixture["hypot"].as_array().expect("hypot");
        for row in rows {
            let (a, b) = (value(&row[0]), value(&row[1]));
            assert_eq!(js_hypot(a, b).to_bits(), value(&row[2]).to_bits(), "hypot({a}, {b})");
        }
        assert_eq!(rows.len(), 3000);
    }
}
